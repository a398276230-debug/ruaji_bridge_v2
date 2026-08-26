/**
 * orchestration/reply-flow.js — 生成、转换与投递
 *
 * 链路：
 *   构建 ModelRequest → publish llm.request → 流式调用模型
 *     → 逐段切句 → Middleware Pipeline → 入发送队列
 *   → 收尾轮跑一次完整文本的 Middleware（好感度写入在这一轮）
 *   → publish llm.response
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
import { renderSystemText, renderUserMessage, renderUserContent } from './prompt-renderer.js';
import { RESPONSE_TRANSFORM, createTransformContext } from '../middleware/index.js';

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
   * @param {import('./fast-ack.js').FastAckDispatcher} [opts.fastAck]
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
    this.log = opts.logger?.child({ component: 'reply-flow' }) ?? console;
  }

  /**
   * @param {object} params
   * @param {object} params.inbound
   * @param {string} params.triggerType
   * @param {object[]} params.contextBlocks
   * @param {AbortSignal} params.signal
   * @returns {Promise<{ status: string, segments: number, response: object|null }>}
   */
  async run({ inbound, triggerType, contextBlocks, signal }) {
    const affectionContext = this.contextFlow.getAffectionContext(inbound, triggerType);

    const systemText = renderSystemText({
      inbound,
      contextBlocks,
      triggerType,
      affectionContext,
      identity: this.config.identity,
    });
    const userMessage = renderUserMessage({ inbound, contextBlocks, identity: this.config.identity });

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

    const isProactive = triggerType === TRIGGER_TYPES.AI_DECISION;
    const splitter = new SentenceSplitter();
    /** queued 是同步计数（排队时 +1），segments 是异步计数（真正入发送队列时 +1）。
     *  非流式兜底必须看 queued，看 segments 会因为管线还没跑完而误判成 0。 */
    const state = { isFirst: true, queued: 0, segments: 0, suppressed: [], chain: null };
    const startedAt = Date.now();

    // 快速响应通道（附录 3）：长任务先给个确认语，别让人干等
    if (this.fastAck) {
      const acked = await this.fastAck.maybeAck({
        inbound,
        triggerType,
        signal,
        enqueue: (m) => this.sender.enqueue(m),
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
            this._queueSegment({ inbound, segment, state, isProactive, signal, response: null });
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
      this._queueSegment({ inbound, segment, state, isProactive, signal, response });
    }

    // 非流式模型：onText 从未被调用，整段原文还没切过。
    // 用同一个切句器走同一条路径，不另开分支——旧 Bridge 的重复发送就出在这里。
    if (state.queued === 0 && response.rawText.trim()) {
      for (const segment of splitIntoSegments(response.rawText)) {
        this._queueSegment({ inbound, segment, state, isProactive, signal, response });
      }
    }

    // 收尾轮：对完整原文跑一次管线，好感度写入只在这一轮发生
    await this._finalPass({ inbound, response, triggerType, state, signal });

    this.health?.update('model', {
      lastSuccessAt: new Date().toISOString(),
      consecutiveFailures: 0,
    });

    this.eventBus.publish(
      // createEvent 只保留 correlationId / sessionId / payload / timestamp
      // （contracts/events.js:52-61），别的顶层字段都会被静默丢掉。
      // 订阅者要用的东西一律放进 payload。
      createEvent(EVENTS.LLM_RESPONSE, {
        correlationId: inbound.correlationId,
        sessionId: inbound.sessionId,
        payload: {
          messageId: inbound.messageId,
          groupId: inbound.groupId,
          userId: inbound.userId,
          userName: inbound.sender.displayName,
          messageType: inbound.messageType,
          isPrivate: inbound.messageType === MESSAGE_TYPES.PRIVATE,
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
        },
      }),
    );

    this.log.info('回复生成完成', {
      correlationId: inbound.correlationId,
      segments: state.segments,
      chars: response.rawText.length,
      latencyMs: response.latencyMs,
    });

    return { status: 'ok', segments: state.segments, response, suppressed: state.suppressed };
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

    this.sender.enqueue(
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
