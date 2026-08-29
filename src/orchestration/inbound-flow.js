/**
 * orchestration/inbound-flow.js — 入站主链路
 *
 * 顺序（每一步的位置都有理由）：
 *   0. 私聊白名单门禁   非白名单私聊在规范化**之前**丢弃（媒体不落盘、不发 NapCat 请求）
 *   1. 规范化           NapCat 原始事件 → InboundMessage
 *   2. 去重             相同 messageId 只处理一次
 *   3. 记入滑窗         **在裁决之前**——被忽略的消息也要进上下文
 *   4. publish message.received  与是否回复无关，广播型，不阻塞
 *   5. 命令拦截         命令不发给模型
 *   6. 裁决             direct / auto / ignore
 *   7. 并发仲裁         主人打断 / 群友排队（附录 1）；无 @ 的 auto 插话遇在途直接丢弃（P2）
 *   8. 防抖合并         800ms 内的多条消息并成一次生成；只合并同一个人（P1）
 *   9. 上下文聚合 → 生成 → 转换 → 发送
 *
 * 第 4 步的位置是关键：旧 Bridge 把 LivingMemory 广播放在所有 return 之前
 * （bridge.js:1162-1184，注释写明 "before any wake/ignore return"），
 * 保证记忆摄取不依赖回复路由。v2 沿用这一点，并把它变成正式的事件协议。
 */

import fs from 'node:fs';
import path from 'node:path';
import { EVENTS, createEvent, newCorrelationId } from '../contracts/events.js';
import { ROUTES } from '../contracts/capabilities.js';
import { MESSAGE_TYPES, createInboundMessage } from '../contracts/messages.js';
import { classifyError } from '../contracts/errors.js';

export class InboundFlow {
  /**
   * @param {object} deps
   */
  constructor(deps = {}) {
    this.normalizer = deps.normalizer;
    this.dedup = deps.dedupStore;
    this.sessions = deps.sessionStore;
    this.eventBus = deps.eventBus;
    this.decisionFlow = deps.decisionFlow;
    this.contextFlow = deps.contextFlow;
    this.replyFlow = deps.replyFlow;
    this.commandFlow = deps.commandFlow;
    this.affection = deps.affectionStore;
    this.memeStore = deps.memeStore ?? null;
    this.health = deps.health ?? null;
    this.shadow = deps.shadowRecorder ?? null;
    /** 可选：运维面板的追踪采集器，不注入就是 null，行为不变 */
    this.trace = deps.traceCollector ?? null;
    this.config = deps.config;
    this.log = deps.logger?.child({ component: 'inbound-flow' }) ?? console;
    this.rateLimitUsers = new Set((deps.config.identity.rateLimitUsers ?? []).map(String));
  }

  /**
   * NapCat 事件入口。永不抛异常——协议层的任何问题都不该拖垮 WebSocket 循环。
   * @param {object} rawEvent
   */
  async handleEvent(rawEvent) {
    const correlationId = newCorrelationId();
    try {
      await this._handle(rawEvent, correlationId);
    } catch (err) {
      const classified = classifyError(err, correlationId);
      this.log.error('入站链路异常', {
        correlationId,
        error: classified.message,
        stack: err?.stack?.split('\n').slice(0, 3).join(' | '),
      });
    }
  }

  async _handle(rawEvent, correlationId) {
    // 私聊白名单门禁（第一道）：必须早于 normalize。normalize 内部会把图片/文件
    // 落盘并回拉引用消息（inbound-normalizer 的 _ingestMedia / _resolveQuote），
    // 非白名单用户不该有能力让我们写硬盘、发 NapCat 请求。
    if (
      rawEvent?.post_type === 'message' &&
      rawEvent.message_type !== 'group' &&
      String(rawEvent.user_id ?? '') !== String(this.config.identity?.robotId ?? '') &&
      !this._isPrivateAllowed(rawEvent.user_id)
    ) {
      this.health?.increment('messages', 'ignored');
      this.log.info('私聊非白名单用户，已在规范化前拦截丢弃', {
        correlationId,
        userId: String(rawEvent.user_id ?? ''),
        nickname: rawEvent.sender?.nickname ?? null,
      });
      return;
    }

    const { message: inbound, dropped } = await this.normalizer.normalize(rawEvent, { correlationId });
    if (!inbound) {
      if (dropped && dropped !== 'not_a_message_event') {
        this.log.debug('消息已丢弃', { correlationId, reason: dropped });
      }
      return;
    }

    // 去重：NapCat 重连重推、多客户端并存时同一条消息会来两遍
    if (!this.dedup.markSeen(inbound.messageId)) {
      this.log.debug('重复消息，已丢弃', { correlationId, messageId: inbound.messageId });
      return;
    }

    // 私聊白名单门禁（第二道）：正常情况下第一道已经拦掉了，这里兜住归一化
    // 规则变化——normalizer 把一切非 group 的 message_type 都映射成 PRIVATE。
    // 拦在这里意味着：不进滑窗、不广播、不触发好感/表情包/大模型。
    if (inbound.messageType === MESSAGE_TYPES.PRIVATE && !this._isPrivateAllowed(inbound.userId)) {
      this.health?.increment('messages', 'ignored');
      this.log.info('私聊非白名单用户，已直接拦截丢弃', {
        correlationId,
        userId: inbound.userId,
        displayName: inbound.sender?.displayName,
      });
      return;
    }

    this.health?.increment('messages', 'received');

    // 滑窗要在裁决之前记，否则被忽略的群聊内容永远进不了上下文
    this.contextFlow.recordToWindow(inbound);

    // 广播：与是否回复无关
    this._publishReceived(inbound);

    // 好感度的"见过这个人"记录。主人恒 100，这里也会把他刷回 100。
    if (this.config.reply.sideEffectsEnabled) {
      try {
        this.affection.onUserMessage({ uid: inbound.userId, nickname: inbound.sender.displayName });
      } catch (err) {
        this.log.warn('好感度互动记录失败', { correlationId, error: err.message });
      }
    }

    // 表情包收集：处于收集会话中的用户发图自动入库
    let collectedCount = 0;
    if (this.memeStore?.isCollecting(inbound.userId) && Array.isArray(inbound.media)) {
      for (const m of inbound.media) {
        if (m.kind === 'image' && m.localPath && fs.existsSync(m.localPath)) {
          try {
            const buf = fs.readFileSync(m.localPath);
            const item = this.memeStore.collectMeme({
              uid: inbound.userId,
              nickname: inbound.sender?.displayName ?? inbound.userId,
              filename: path.basename(m.localPath),
              buffer: buf,
            });
            if (item) collectedCount++;
          } catch (e) {
            this.log.error('收集表情处理异常', { error: e.message });
          }
        }
      }
    }

    // 命令：不发给模型
    const command = await this.commandFlow.handle(inbound);
    if (command.handled) {
      this.shadow?.record({ inbound, decision: { route: 'command', reason: command.command } });
      this.trace?.recordDecision(inbound.correlationId, {
        route: 'command',
        reason: command.command,
      });
      return;
    }

    // 处于表情包收集模式时：只要收录了图片且没有额外的实质提问文字，秒存即止，静默拦截
    if (this.memeStore?.isCollecting(inbound.userId) && (collectedCount > 0 || inbound.flags.hasImage)) {
      const cleanUserText = String(inbound.rawMessage || inbound.text || '')
        .replace(/\[CQ:[^\]]*\]/gi, '')
        .replace(/\[(?:图片|图片消息|screenshot|image|photo)\]/gi, '')
        .replace(/\s+/g, '')
        .trim();

      if (!cleanUserText) {
        this.log.info('表情包收集入库完毕，静默拦截，跳过模型生成', {
          correlationId,
          userId: inbound.userId,
          collectedCount,
        });
        return;
      }
    }

    const decision = await this.decisionFlow.decide(inbound);
    this.shadow?.record({ inbound, decision });
    this.trace?.recordDecision(inbound.correlationId, decision);

    if (decision.route === ROUTES.IGNORE) {
      this.health?.increment('messages', 'ignored');
      return;
    }

    const arbitration = this.decisionFlow.arbitrateConcurrency(inbound, decision);
    if (arbitration.action === 'drop') {
      // 主动插话遇到在途生成：统一丢弃，不排队（P2，与 handleProactive 的 busy 行为一致）。
      // 消息已进本地滑窗（recordToWindow 在裁决前无条件执行），上下文不丢。
      // 与 route=ignore 同样记 ignored，否则这条只计 received、任何桶都不落账。
      this.health?.increment('messages', 'ignored');
      return;
    }
    if (arbitration.action === 'queue') {
      this._buffer(inbound, decision);
      return;
    }

    this._buffer(inbound, decision);
    this._scheduleGeneration(inbound.executionKey);
  }

  _publishReceived(inbound) {
    this.eventBus.publish(
      createEvent(EVENTS.MESSAGE_RECEIVED, {
        correlationId: inbound.correlationId,
        sessionId: inbound.sessionId,
        timestamp: inbound.timestamp,
        payload: {
          messageId: inbound.messageId,
          selfId: inbound.selfId,
          userId: inbound.userId,
          groupId: inbound.groupId,
          messageType: inbound.messageType,
          rawMessage: inbound.rawMessage,
          text: inbound.text,
          content: inbound.content,
          nickname: inbound.sender.nickname,
          card: inbound.sender.card,
          displayName: inbound.sender.displayName,
          timestamp: inbound.timestamp,
          isAtBot: inbound.flags.isAtBot,
          isNameCall: inbound.flags.isNameCall,
          isOwner: inbound.flags.isOwner,
          hasImage: inbound.flags.hasImage,
          hasFile: inbound.flags.hasFile,
        },
      }),
    );
  }

  /**
   * 防抖缓冲：800ms 内的多条消息合并成一次生成。
   * 迁移自 bridge.js:1741-1798，但去掉了那里嵌套两层 setTimeout + 重复
   * 排队逻辑的结构（同一段逻辑在 :1744 与 :1775 各写了一遍）。
   */
  _buffer(inbound, decision) {
    const buf = this.sessions.getBuffer(inbound.executionKey);
    buf.pending.push({ inbound, decision });
  }

  _scheduleGeneration(executionKey) {
    const buf = this.sessions.getBuffer(executionKey);
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = setTimeout(() => {
      buf.timer = null;
      this._runGeneration(executionKey).catch((err) => {
        this.log.error('生成任务异常', { executionKey, error: err.message });
      });
    }, this.config.decision.debounceMs);
    if (typeof buf.timer.unref === 'function') buf.timer.unref();
  }

  async _runGeneration(executionKey) {
    const pending = this.sessions.drainBuffer(executionKey);
    if (pending.length === 0) return;

    // 只合并同一个人的消息，其余人原序退回队列等下一轮（P1）
    const { batch, rest } = splitBySpeaker(pending);
    if (rest.length > 0) {
      this.sessions.requeue(executionKey, rest);
      this.log.info('排队批次按发言人切分，其余人留待下一轮', {
        executionKey,
        replyingTo: batch[0].inbound.userId,
        merged: batch.length,
        requeued: rest.length,
      });
    }

    // 合并：内容按换行拼接，身份字段取最后一条，裁决取批次里最强的一条
    const merged = mergeBatch(batch);
    const { inbound, decision } = merged;

    const controller = new AbortController();
    this.sessions.beginExecution(executionKey, {
      controller,
      source: decision.route,
      correlationId: inbound.correlationId,
    });

    try {
      const { blocks } = await this.contextFlow.collect(inbound, {
        triggerType: decision.triggerType,
        signal: controller.signal,
      });

      const result = await this.replyFlow.run({
        inbound,
        triggerType: decision.triggerType,
        contextBlocks: blocks,
        signal: controller.signal,
      });

      if (result.status === 'ok') {
        this.health?.increment('messages', 'replied');
        if (this.rateLimitUsers.has(String(inbound.userId))) {
          this.sessions.recordReply(inbound.userId);
        }
        this.shadow?.recordReply({ inbound, decision, result, contextBlocks: blocks });
      }

      // 强一致性时序：等本轮发完再放开下一轮，防止回答错位
      await this.replyFlow.waitForDelivery(inbound);
    } catch (err) {
      const classified = classifyError(err, inbound.correlationId);
      if (classified.preempted) {
        this.log.info('本轮生成被主人打断', { correlationId: inbound.correlationId });
      } else {
        this.log.error('生成失败', { correlationId: inbound.correlationId, error: classified.message });
        this.trace?.recordError(inbound.correlationId, classified.message);
      }
    } finally {
      this.sessions.endExecution(executionKey, controller);
      // 排队期间积压的消息：本轮结束后再跑一次
      const buf = this.sessions.getBuffer(executionKey);
      if (buf.pending.length > 0 && !buf.timer) this._scheduleGeneration(executionKey);
    }
  }

  /**
   * 外部触发的主动接话（旧 /api/dispatch_auto_reply → onAutoReply）。
   * v2 把它建模成一次合成的 InboundMessage 走同一条链路，
   * 从而复用全套隐式注入、流式切句、好感度剥离与审计。
   */
  async handleProactive({ groupId, userId, nickname, message, messageId }) {
    const executionKey = `group_${groupId}`;
    if (this.sessions.isBusy(executionKey)) {
      this.log.info('该群已有在途生成，丢弃本次主动接话', { groupId });
      return { accepted: false, reason: 'busy' };
    }

    const correlationId = newCorrelationId();
    const inbound = createInboundMessage({
      correlationId,
      messageId: String(messageId ?? `auto_${Date.now()}`),
      timestamp: Math.floor(Date.now() / 1000),
      platform: 'qq',
      selfId: String(this.config.identity.robotId),
      userId: String(userId ?? '0'),
      groupId: String(groupId),
      sessionId: `qq:group:${groupId}`,
      executionKey,
      messageType: MESSAGE_TYPES.GROUP,
      rawMessage: String(message ?? ''),
      text: String(message ?? ''),
      content: String(message ?? ''),
      segments: [],
      sender: { nickname: nickname ?? '群友', card: '', displayName: nickname ?? '群友' },
      flags: {
        isOwner: String(userId) === String(this.config.identity.ownerId),
      },
      media: [],
      extensions: { napcat: {}, proactive: true },
    });

    this._buffer(inbound, { route: ROUTES.AUTO, triggerType: 'ai_decision', reason: 'external_dispatch' });
    this._scheduleGeneration(executionKey);
    return { accepted: true };
  }

  _isPrivateAllowed(userId) {
    const uid = String(userId ?? '').trim();
    const ownerId = String(this.config.identity?.ownerId ?? '').trim();
    if (ownerId && uid === ownerId) return true;

    const whitelist = this.config.identity?.privateWhitelist;
    if (!Array.isArray(whitelist) || whitelist.length === 0) {
      return false;
    }
    return whitelist.map((id) => String(id).trim()).includes(uid);
  }
}

/**
 * 从排队缓冲里切出本轮要合并的一组：**只合并同一个人的消息**。
 *
 * 不同人的话绝不合并（P1）。合并后只剩一个身份，而"@ 回谁"（replyToUserId）与
 * "扣谁的好感"（affection 中间件读 inbound.userId）都只认这一个身份——两个群友的话
 * 挂在一个人名下，回复也只 @ 得到其中一个，另一个等于被无视。
 *
 * 锚定谁：队列里有主人就先答主人，否则按 FIFO 取第一条的作者。前者是为了不让
 * 打断特权（附录 1）被队列里先到的群友挤掉——主人刚 abort 掉在途生成，结果这一轮
 * 回的是别人，特权就白给了。
 *
 * 锚定用户的消息一次答完，其余人原序留在队列里，由 _runGeneration 的 finally
 * 重新调度下一轮。每轮至少清掉一个人，不会饿死。
 *
 * @param {{ inbound: object, decision: object }[]} pending
 * @returns {{ batch: object[], rest: object[] }}
 */
export function splitBySpeaker(pending) {
  const anchorItem = pending.find((p) => p.inbound.flags?.isOwner) ?? pending[0];
  const anchorUserId = String(anchorItem.inbound.userId);

  const batch = [];
  const rest = [];
  for (const item of pending) {
    if (String(item.inbound.userId) === anchorUserId) batch.push(item);
    else rest.push(item);
  }
  return { batch, rest };
}

/**
 * 合并一批防抖消息：内容换行拼接，身份字段取最新一条，裁决取最强一条。
 * 调用方保证批次内是同一个人（splitBySpeaker）。extensions.batch 仍逐条保留
 * messageId/时间/身份/正文——渲染层据此一行一条，时间戳不会被末条统一顶掉，
 * 万一将来又有人把跨用户合并接回来，逐条标名也能兜住（P1）。
 */
export function mergeBatch(batch) {
  const last = batch.at(-1);
  if (batch.length === 1) return last;

  const merged = {
    ...last.inbound,
    content: batch.map((b) => b.inbound.content).filter(Boolean).join('\n'),
    text: batch.map((b) => b.inbound.text).filter(Boolean).join('\n'),
    media: batch.flatMap((b) => b.inbound.media ?? []),
    extensions: {
      ...last.inbound.extensions,
      batch: batch.map((b) => ({
        messageId: b.inbound.messageId,
        timestamp: b.inbound.timestamp,
        userId: b.inbound.userId,
        displayName: b.inbound.sender?.displayName ?? '',
        content: b.inbound.content,
      })),
    },
  };

  // 裁决取批次里最强的一条（direct > auto），不是无脑取最后一条：@ 消息与 auto
  // 插话落在同一个防抖窗口时，末条通吃会把被 @ 的人当成"主动插话"来回复——
  // 不 @ 回、不评好感、systemText 走主人同款分支。同强度取较新的那条。
  const strongest = batch.filter((b) => b.decision?.route === ROUTES.DIRECT).at(-1) ?? last;
  return { inbound: merged, decision: strongest.decision };
}
