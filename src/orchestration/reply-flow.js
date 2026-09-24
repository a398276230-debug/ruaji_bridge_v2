/**
 * orchestration/reply-flow.js — 生成、转换与投递
 *
 * 链路：
 *   构建 ModelRequest → publish llm.request → 流式调用模型
 *     → 逐段切句 → Middleware Pipeline → 入发送队列
 *   → 等全部分段入队 → 后置表情匹配（独立小模型挑一张表情包跟进）
 *   → publish llm.response（同步等待，收尾轮之前——Favour 暂存靠它）
 *   → 收尾轮跑一次完整文本的 Middleware（插件在这一轮消费暂存写库）
 *
 * 与旧 Bridge 的关键差异：
 *   旧 performClawRequest 里，流式分段和"全量分句"两条路径同时存在，
 *   靠 streamFirstSent_global 这个布尔量互斥（bridge.js:1025-1055）。
 *   一旦这个标志算错就是整段重复发送。v2 只有一条路径：流式切句。
 *   非流式模型由 splitIntoSegments 走同一个切句器，不再有第二条分支。
 *
 *   旧代码在 llm.response 之后同步等待所有插件；v2 的 publish 不阻塞。
 */

import { EVENTS, createEvent } from '../contracts/events.js';
import { createModelRequest, createOutboundMessage, MESSAGE_TYPES } from '../contracts/messages.js';
import { TRIGGER_TYPES } from '../contracts/capabilities.js';
import { classifyError } from '../contracts/errors.js';
import { SentenceSplitter, splitIntoSegments } from './sentence-splitter.js';
import { sendLaneKey } from './session-send-queue.js';
import { renderSystemText, renderUserMessage, renderUserContent } from './prompt-renderer.js';
import { RESPONSE_TRANSFORM, createTransformContext } from '../middleware/index.js';

/**
 * 判定「流重启重放」的最短段长。
 *
 * 上游中途重试 / 换供应商（Hermes 的 content-filter fallback、网络中断重试）会把
 * **已经吐过的前缀从头再流一遍**；桥接这边已经把它发出去了一部分，于是同一段话在
 * QQ 里出现两次（用户反馈的「莫名其妙吐出两句第一段话」）。
 *
 * 切句器对正常文本不会产出「与上一段相同」或「从首段开始重放」的序列，所以这两种
 * 形状基本只可能来自重放。为了不误伤「哈哈。」这类正常的短重复，只对长度达到阈值的
 * 段落做去重。阈值以下照常放行。
 */
export const REPLAY_GUARD_MIN_CHARS = 8;

export class ReplyFlow {
  /**
   * @param {object} opts
   * @param {import('../adapters/model/model-router.js').ModelRouter} opts.modelRouter
   * @param {import('../core/middleware-pipeline.js').MiddlewarePipeline} opts.pipeline
   * @param {import('../adapters/napcat/sender.js').Sender} opts.sender
   * @param {import('../core/event-bus.js').EventBus} opts.eventBus
   * @param {import('./context-flow.js').ContextFlow} opts.contextFlow
   * @param {import('../storage/session-store.js').SessionStore} opts.sessionStore
   * @param {import('../core/health-manager.js').HealthManager} [opts.health]
   * @param {object} opts.config
   * @param {import('../core/logger.js').Logger} opts.logger
   * @param {import('../orchestration/fast-ack.js').FastAckDispatcher} [opts.fastAck]
   * @param {import('../orchestration/meme-matcher.js').MemeMatcher} [opts.memeMatcher]
   * @param {import('../web/trace-collector.js').TraceCollector} [opts.traceCollector]
   */
  constructor(opts = {}) {
    this.models = opts.modelRouter;
    this.pipeline = opts.pipeline;
    this.sender = opts.sender;
    this.eventBus = opts.eventBus;
    this.contextFlow = opts.contextFlow;
    this.sessions = opts.sessionStore;
    this.health = opts.health ?? null;
    this.config = opts.config;
    this.fastAck = opts.fastAck ?? null;
    this.memeMatcher = opts.memeMatcher ?? null;
    this.trace = opts.traceCollector ?? null;
    /** 会话级输出互斥（可选注入；不注入就退回旧的直接 enqueue 行为） */
    this.outputQueue = opts.sessionSendQueue ?? null;
    this.log = opts.logger?.child({ component: 'reply-flow' }) ?? console;
  }

  /**
   * 单轮回复入口。
   *
   * 先拿「会话级输出租约」再跑生成：本轮回复的**所有**分段（含 fastAck 确认语与
   * 后置表情包）必须连续投递，绝不能被 WakeFlow 的后台完成通知插进中间（缺陷一）。
   * 目标被别的 flow 占着时就在这里排队等它整轮发完；租约直到本轮消息全部投递
   * 结算才释放（见 session-send-queue.js）。
   *
   * @param {object} params
   * @param {object} params.inbound
   * @param {string} params.triggerType
   * @param {object[]} params.contextBlocks
   * @param {AbortSignal} params.signal
   * @returns {Promise<{ status: string, segments: number, response: object|null }>}
   */
  async run(params) {
    let lease = null;
    if (this.outputQueue) {
      const { inbound, signal } = params;
      const laneKey = sendLaneKey({
        type: inbound.messageType,
        id: inbound.messageType === MESSAGE_TYPES.GROUP ? inbound.groupId : inbound.userId,
      });
      try {
        lease = await this.outputQueue.acquire(laneKey, { owner: 'reply', signal });
      } catch (err) {
        // 等待期间被 /stop 打断：本轮不发送任何东西
        if (err?.name === 'AbortError') return { status: 'preempted', segments: 0, response: null };
        throw err;
      }
    }
    try {
      return await this._runTurn({ ...params, lease });
    } finally {
      if (lease) {
        try {
          await lease.release();
        } catch (err) {
          // 释放失败不能反过来吞掉本轮结果：Sender 自身的队列与幂等仍然兜底
          this.log.warn('输出租约释放异常（已忽略）', { error: err?.message ?? String(err) });
        }
      }
    }
  }

  /** 单轮回复的实际执行。`lease` 只在本轮内用于 _dispatch。 */
  async _runTurn({ inbound, triggerType, contextBlocks, signal, lease }) {
    const affectionContext = this.contextFlow.getAffectionContext(inbound, triggerType);

    const systemText = renderSystemText({
      inbound,
      contextBlocks,
      triggerType,
      affectionContext,
      identity: this.config.identity,
    });
    const userMessage = renderUserMessage({
      inbound,
      contextBlocks,
      identity: this.config.identity,
      triggerType,
      affectionContext,
      // 面板/config 现读：false 时图片不直挂多模态 parts，改给路径 + vision_analyze 提示
      directMediaParts: this.config.context?.directMediaParts !== false,
    });

    const messages = [];
    if (systemText && systemText.trim()) messages.push({ role: 'system', content: systemText.trim() });
    messages.push({ role: 'user', content: userMessage });

    const modelRequest = createModelRequest({
      correlationId: inbound.correlationId,
      sessionId: inbound.sessionId,
      sessionKey: inbound.executionKey,
      model: this.config.model.model,
      messages,
      contextBlocks,
      stream: this.config.model.stream,
    });

    this.eventBus.publish(
      createEvent(EVENTS.LLM_REQUEST, {
        correlationId: inbound.correlationId,
        sessionId: inbound.sessionId,
        payload: {
          messageId: inbound.messageId,
          model: modelRequest.model,
          triggerType,
          systemTextLength: systemText.length,
          contextBlockCount: contextBlocks.length,
          contextSources: contextBlocks.map((b) => b.source),
        },
      }),
    );

    // 全链路追踪补录：面板要能看到"最终注入了啥"，事件总线里只放计数，
    // 正文在这里直接交给采集器（与 recordDecision/recordContext 同一模式）
    this.trace?.recordPrompt(inbound.correlationId, {
      model: modelRequest.model,
      systemText: systemText.trim(),
      userMessage,
      messageCount: messages.length,
    });

    const isProactive = triggerType === TRIGGER_TYPES.AI_DECISION;
    const splitter = new SentenceSplitter();
    /** queued 是同步计数（排队时 +1），segments 是异步计数（真正入发送队列时 +1）。
     *  非流式兜底必须看 queued，看 segments 会因为管线还没跑完而误判成 0。 */
    const state = {
      /** 本轮输出租约（null = 未注入 SessionSendQueue，走旧的直接 enqueue） */
      lease,
      isFirst: true,
      queued: 0,
      segments: 0,
      suppressed: [],
      chain: null,
      /** 本轮已入队的可见分段（按顺序），用于识别流重启后的前缀重放 */
      emitted: [],
      /** >=0 表示正在重放 emitted 的前缀，指向下一个应匹配的下标；-1 = 不在重放 */
      replayIndex: -1,
      /** 被鉴为「重放」而丢弃的段数（仅用于日志/观测） */
      suppressedReplays: 0,
    };
    const startedAt = Date.now();

    // 快速响应通道（附录 3）：长任务先给个确认语，别让人干等
    if (this.fastAck) {
      const acked = await this.fastAck.maybeAck({
        inbound,
        triggerType,
        signal,
        enqueue: (m) => this._dispatch(state, m),
      });
      // 确认语已经占掉了首段的 @，正文不必再 @ 一次
      if (acked) state.isFirst = false;
    }

    this.health?.increment('model', 'totalRequests');

    let response;
    try {
      response = await this.models.generate(modelRequest, {
        signal,
        onText: (chunk) => {
          for (const segment of splitter.push(chunk)) {
            // onText 是同步回调，这里不能 await；把每段的处理排进队列
            this._enqueueSegment({ inbound, segment, state, isProactive, signal, response: null });
          }
        },
      });
    } catch (err) {
      const classified = classifyError(err, inbound.correlationId);
      if (classified.preempted || signal?.aborted) {
        this.log.info('生成被打断，不推送旧回复', {
          correlationId: inbound.correlationId,
          executionKey: inbound.executionKey,
        });
        return { status: 'preempted', segments: state.segments, response: null };
      }
      this.health?.increment('model', 'consecutiveFailures');
      if (classified.kind === 'timeout') this.health?.increment('model', 'totalTimeouts');
      throw classified;
    }

    // 流尾残留
    for (const segment of splitter.flush()) {
      this._enqueueSegment({ inbound, segment, state, isProactive, signal, response });
    }

    // 非流式模型：onText 从未被调用，整段原文还没切过。
    // 用同一个切句器走同一条路径，不另开分支——旧 Bridge 的重复发送就出在这里。
    if (state.queued === 0 && response.rawText.trim()) {
      for (const segment of splitIntoSegments(response.rawText)) {
        this._enqueueSegment({ inbound, segment, state, isProactive, signal, response });
      }
    }

    // 等所有分段处理完：文本段全部进入发送队列。这是表情包 FIFO 跟在
    // 最后送达的前提，也保证结算事件里的 segments 计数是终值。
    await state.chain;

    // 后置表情匹配：所有文本段已入队；必须在 run() 返回前完成 enqueue，
    // waitForDelivery 才能覆盖它。直接 enqueue 只受 sender 基线节流
    // （有意为之：贴纸紧跟文本是自然节奏，不走 typing-delay）。
    // 任何异常都被 maybeAttach 内部吞掉，不影响文本。
    const memeMatch = response.rawText.trim() && !signal?.aborted
      ? await this.memeMatcher?.maybeAttach({
          inbound,
          replyText: response.rawText,
          userText: inbound.content || inbound.text,
          signal,
          enqueue: (m) => this._dispatch(state, m),
        })
      : null;

    // 评分结算时序（Favour Ultra 合同）：模型完成事件（含完整原文）必须派发在
    // 收尾轮之前并同步等待——上游数据流是「响应钩子解析暂存 → 文本修饰钩子
    // 清洗写库」，发布晚了暂存永远无人消费，评分永远不落库。一次回复只派发
    // 一次；有界超时，失败降级：跳过本轮结算并记录，不影响发送。
    await this._settleResponse({ inbound, response, state, memeMatch, signal, startedAt, triggerType });

    // 收尾轮：对完整原文跑一次管线；result.decorate 让插件弹出暂存并写库
    await this._finalPass({ inbound, response, triggerType, state, signal });

    this.health?.update('model', {
      lastSuccessAt: new Date().toISOString(),
      consecutiveFailures: 0,
    });

    this.log.info('回复生成完成', {
      correlationId: inbound.correlationId,
      segments: state.segments,
      chars: response.rawText.length,
      latencyMs: response.latencyMs,
    });

    return { status: 'ok', segments: state.segments, response, suppressed: state.suppressed };
  }

  /**
   * 派发模型完成事件（llm.response）并同步等待订阅者（统一宿主 → Favour
   * 的 OnLLMResponseEvent 暂存钩子）结束。必须在收尾轮之前完成，这样
   * 收尾轮里的 result.decorate 才能消费到暂存并真正写库。
   *
   * 降级语义：超时或异常只跳过本轮结算并记录日志，绝不影响已经入队的
   * 文本发送。publish 本身是 allSettled 的，不会 reject；这里再套一层
   * 有界竞速，防止单个订阅者吊住整轮回复。
   */
  async _settleResponse({ inbound, response, state, memeMatch, signal, startedAt, triggerType }) {
    if (signal?.aborted) return;

    // createEvent 只保留 correlationId / sessionId / payload / timestamp
    // （contracts/events.js:52-61），别的顶层字段都会被静默丢掉。
    // 订阅者要用的东西一律放进 payload。
    const envelope = createEvent(EVENTS.LLM_RESPONSE, {
      correlationId: inbound.correlationId,
      sessionId: inbound.sessionId,
      payload: {
        messageId: inbound.messageId,
        groupId: inbound.groupId,
        userId: inbound.userId,
        userName: inbound.sender.displayName,
        messageType: inbound.messageType,
        isPrivate: inbound.messageType === MESSAGE_TYPES.PRIVATE,
        /** 触发类型随事件透传：宿主侧 Favour 据此豁免主动插话轮的标签解析 */
        triggerType,
        /** 用户这一轮说了什么。`text` 已经被占用为模型回复，别再复用它 */
        userText: inbound.content,
        responseId: response.responseId,
        model: response.model,
        completionText: response.rawText,
        completion_text: response.rawText,
        text: response.rawText,
        textLength: response.rawText.length,
        segments: state.segments,
        usage: response.usage,
        latencyMs: response.latencyMs,
        totalMs: Date.now() - startedAt,
        /** 后置表情匹配结果（面板 trace 可验证） */
        memeAttached: Boolean(memeMatch?.attached),
        memeId: memeMatch?.memeId ?? null,
      },
    });

    const timeoutMs = this.config.reply?.settlementTimeoutMs ?? 8000;
    let settled = false;
    try {
      await Promise.race([
        Promise.resolve(this.eventBus.publish(envelope)).then(() => {
          settled = true;
        }),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, timeoutMs);
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
    } catch (err) {
      this.log.warn('模型完成事件派发异常，本轮评分结算跳过（不影响发送）', {
        correlationId: inbound.correlationId,
        error: err.message,
      });
      return;
    }
    if (!settled) {
      this.log.warn('模型完成事件派发超时，本轮评分结算跳过（不影响发送）', {
        correlationId: inbound.correlationId,
        timeoutMs,
      });
    }
  }

  /**
   * 分段入队前的「流重启重放」拦截。
   *
   * 记录本轮已经入队的可见段落序列；当新段落是在**从头重放这条序列**（与首段
   * 相同，且后续段落也对得上）时，直接丢弃。重放一旦偏离旧序列就立刻恢复正常放行：
   * 只吞重复的前缀，不会因为一次误判而丢掉后面的正文。
   *
   * 为何只认「与首段相同」而不认任意重复段：模型正常写一个副歌式重复句是合法的，
   * 而把首段原样再写一遍几乎只可能是上游重放；这条限制把误伤降到最低。
   * 长度阈值以下照常放行（「哈哈。」这类短重复不拦）。
   *
   * @returns {boolean} true = 应当入队；false = 判为重放，丢弃
   */
  _acceptSegment(state, segment) {
    const text = String(segment ?? '').trim();
    if (!text) return true; // 空段保持原行为，交给下游处理
    const long = text.length >= REPLAY_GUARD_MIN_CHARS;

    if (state.replayIndex >= 0) {
      if (state.replayIndex < state.emitted.length && text === state.emitted[state.replayIndex]) {
        state.replayIndex += 1;
        state.suppressedReplays += 1;
        return false;
      }
      // 重放已偏离旧序列：从这一段起是新内容
      state.replayIndex = -1;
    }

    if (long && state.emitted.length >= 1 && text === state.emitted[0]) {
      // 与首段完全相同的长段落：只可能是上游从头重放（正常回复极少把首段原样再写一遍）
      state.replayIndex = 1;
      state.suppressedReplays += 1;
      return false;
    }

    state.emitted.push(text);
    return true;
  }

  /** 走一遍重放拦截，通过才排队 */
  _enqueueSegment(params) {
    const { state, segment } = params;
    if (!this._acceptSegment(state, segment)) {
      this.log.debug('分段疑为流重启重放，已丢弃以防复读', {
        correlationId: params.inbound?.correlationId,
        chars: String(segment ?? '').length,
        replayIndex: state.replayIndex,
        suppressedReplays: state.suppressedReplays,
      });
      return;
    }
    this._queueSegment(params);
  }

  /**
   * 把一段文本排入本轮的串行处理链，保证段与段之间顺序稳定。
   * 链保存在 state 上而非 this 上——否则不同会话会互相串行，
   * 一个群的长回复会把另一个群的回复卡住。
   */
  _queueSegment(params) {
    const { state } = params;
    state.queued++;
    state.chain = Promise.resolve(state.chain)
      .then(() => this._processSegment(params))
      .catch((err) => {
        this.log.warn('分段处理失败，已跳过该段', {
          correlationId: params.inbound.correlationId,
          error: err.message,
        });
      });
    return state.chain;
  }

  async _processSegment({ inbound, segment, state, isProactive, signal, response }) {
    if (signal?.aborted) return;

    const ctx = createTransformContext({
      correlationId: inbound.correlationId,
      sessionId: inbound.sessionId,
      inbound,
      text: segment,
      rawText: response?.rawText ?? null,
      responseId: response?.responseId ?? null,
      triggerType: isProactive ? TRIGGER_TYPES.AI_DECISION : TRIGGER_TYPES.AT,
      isFinalPass: false,
      signal,
    });

    const out = await this.pipeline.run(RESPONSE_TRANSFORM, ctx);
    if (out.cancelled || signal?.aborted) return;

    const body = [out.text, ...(out.attachments ?? [])].filter((s) => s && String(s).trim()).join('\n');
    if (!body.trim()) return;

    this._dispatch(
      state,
      createOutboundMessage({
        correlationId: inbound.correlationId,
        sessionId: inbound.sessionId,
        target: {
          type: inbound.messageType,
          id: inbound.messageType === MESSAGE_TYPES.GROUP ? inbound.groupId : inbound.userId,
        },
        replyToUserId: inbound.userId,
        text: body,
        metadata: { isFirst: state.isFirst, disableAutoMention: isProactive },
      }),
    );

    state.isFirst = false;
    state.segments++;
    if (out.suppressedSideEffects?.length) state.suppressed.push(...out.suppressedSideEffects);
  }

  /**
   * 收尾轮：只跑副作用，不产出可见文本。
   * 好感度标记是末尾锚定的，必须拿完整原文才能正确解析。
   */
  async _finalPass({ inbound, response, triggerType, state, signal }) {
    await state.chain; // 等所有分段处理完，保证副作用发生在文本之后

    const ctx = createTransformContext({
      correlationId: inbound.correlationId,
      sessionId: inbound.sessionId,
      inbound,
      text: '',
      rawText: response.rawText,
      responseId: response.responseId,
      triggerType,
      isFinalPass: true,
      signal,
    });

    try {
      const out = await this.pipeline.run(RESPONSE_TRANSFORM, ctx);
      if (out.suppressedSideEffects?.length) state.suppressed.push(...out.suppressedSideEffects);
    } catch (err) {
      // 副作用失败不能影响已经发出去的回复
      this.log.warn('收尾轮处理失败', {
        correlationId: inbound.correlationId,
        error: err.message,
      });
    }
  }

  /**
   * 本轮出站消息的唯一出口：持有租约就租约入队（同一目标严格串行），
   * 未注入 SessionSendQueue 时退回直接 enqueue（行为与旧版一致）。
   */
  _dispatch(state, outbound) {
    const lease = state?.lease ?? null;
    if (lease?.held) {
      lease.enqueue(outbound);
      return;
    }
    this.sender.enqueue(outbound);
  }

  /**
   * 强一致性时序保障（旧 bridge.js:1088-1092）：
   * 等本轮生成的所有消息彻底发完，防止下一轮抢跑导致回答错位。
   */
  async waitForDelivery(inbound, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (this.sender.hasPendingFor(inbound.sessionId, inbound.userId)) {
      if (Date.now() > deadline) {
        this.log.warn('等待发送完成超时，继续处理后续消息', {
          correlationId: inbound.correlationId,
        });
        return false;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return true;
  }
}

export { renderSystemText, renderUserContent };
