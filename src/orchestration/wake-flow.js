/**
 * orchestration/wake-flow.js — Hermes 异步唤醒回推
 *
 * 解决的痛点（Hermes 上游 7a131f7f40 之后）：API Server 是无状态 HTTP 通道，
 * `terminal(background=true, notify_on_complete=true)` 与
 * `delegate_task(background=true)` 的完成通知没有 push 去处，只能被降级。
 * 打通方式（不改现有对话链路）：
 *
 *   [Hermes] 后台进程退出 → 网关 watcher 把完成通知自投递成一次唤醒轮
 *            （gateway/wake.py: _self_post_chat_completion，写回**同一个**
 *             X-Hermes-Session-Id 会话 transcript）
 *   [Bridge] 按 pollIntervalMs 轮询 GET /api/sessions/{id}/messages，
 *            切出「分体投递块」（adapters/hermes/wake-extractor.js），
 *            过 response.notice 管线（脱 Markdown + 拟人节流）后丢进发送队列
 *   [QQ]     正常出站链路（发送队列 / 重试 / 幂等 / 断路器）送达
 *
 * `delegate_task(background=true)` 是个例外：Hermes 不为委派完成起唤醒轮
 * （gateway/run_notifications.py: _self_post_api_server → persist_delegation_delivery
 * 只落一条写给 agent 的重注入信封，把下一轮交给客户端），所以那条内部 user 汇报行
 * 永远不能被原样推到 QQ。桥接在这里替它补上唤醒这一步（_maybeRelayDelegation）：
 * 以同一会话自投递一次唤醒轮（hermes_wake_turn=true），模型的转述回复会以
 * internal_notification 锚点块落回 transcript，再由上面的普通唤醒块路径投递。
 *
 * 唤醒轮只发一句**极简提示**（引用上文那条原生汇报），绝不把报告正文再复制一遍：
 * 复制会把同一个几千字报告在会话上下文里堆两份，白烧 token。
 *
 * 为什么是轮询而不是长连接：api_server 面没有任何持久事件流（Hermes 自己的
 * TUI / 桌面端 / dashboard 也是轮询 /api/sessions/{id}/messages 消费分体投递），
 * 而 relay / 插件平台那条路要把整条对话链路（流式、/stop、/redirect、多模态）
 * 换掉。轮询是这里唯一"既有持久性又不动现有机制"的消费方式。
 *
 * 编排层只消费标准字段（kind / text / target），Hermes 行语义解析全在 adapter 里
 * （架构约定：协议解析不下沉到编排层）。
 */

import { randomUUID } from 'node:crypto';

import { createModelRequest, createOutboundMessage } from '../contracts/messages.js';
import { TRIGGER_TYPES } from '../contracts/capabilities.js';
import { createTransformContext, RESPONSE_NOTICE } from '../middleware/index.js';
import { splitIntoSegments } from './sentence-splitter.js';
import { sendLaneKey } from './session-send-queue.js';
import { extractDetachedDeliveries, resolveSessionTarget, delegationRefOf } from '../adapters/hermes/wake-extractor.js';

/** 连续两跳内容不变就认为"块已稳定"，可以投递未闭合的唤醒块 */
const STABILITY_TICKS = 2;
/** 即使 message_count 没变，也每隔这么久重新读一次会话（防上游非追加式改写） */
const VERIFY_INTERVAL_MS = 60000;
/** 连续失败时日志降噪的间隔 */
const ERROR_LOG_INTERVAL_MS = 60000;

/**
 * 委派转述唤醒的默认提示词。
 *
 * 铁律：**提示词里绝不再内嵌原始汇报正文**。Hermes 原生已经把完整汇报以
 * display_kind=async_delegation_complete 的 user 行持久化进同一个会话，模型在唤醒轮里
 * 本来就能读到它；桥接再复制一份几千字的报告当新 user 消息 POST 进会话，只会让上下文
 * 连续出现两份一模一样的长报告（白白烧 token）。所以这里只留一句极简引用 + deleg id。
 *
 * config.wakeDelivery.delegationRelay.prompt 可覆盖；模板里的 {ref} 会替换成 deleg id，
 * 历史模板里的 {notice} 现在也只会替换成同一个短引用（绝不回退成正文）。
 */
export const DEFAULT_DELEGATION_RELAY_PROMPT =
  '（内部机制提示，不需要回应这句话本身）你之前派出的后台子任务{ref}已经跑完了，'
  + '它的完整汇报就在本会话上文（Hermes 原生写入的那一条），请自行阅读。'
  + '请用你自己的口吻，把结论简要转述给对方（1~3 句，不要照抄原文、不要贴代码或日志、'
  + '不要提“内部机制/系统提示”这类字眼）。';
/** {notice} 占位符的禁用式替换：只给一个指向上下文的短引用 */
export const RELAY_NOTICE_REFERENCE = '（见本会话上文 Hermes 写入的那条后台汇报）';

/**
 * 把委派完成锚点渲染成唤醒提示词。
 *
 * @param {string} notice 委派完成行正文（只用来抠 deleg id，不参与拼接正文）
 * @param {object} [relay] config.wakeDelivery.delegationRelay
 * @returns {string}
 */
export function renderDelegationRelayPrompt(notice, relay = {}) {
  const template = String(relay.prompt ?? '').trim() || DEFAULT_DELEGATION_RELAY_PROMPT;
  const ref = delegationRefOf(notice);
  const refText = ref ? `（${ref}）` : '';
  const text = template
    .replace(/\{ref\}/g, refText)
    // 关键：{notice} 只换成短引用，绝不能换成正文（历史自定义模板也不能）
    .replace(/\{notice\}/g, refText || RELAY_NOTICE_REFERENCE);
  return text.trim();
}

export class WakeFlow {
  /**
   * @param {object} opts
   * @param {object} opts.config
   * @param {import('../core/logger.js').Logger} opts.logger
   * @param {import('../adapters/napcat/sender.js').Sender} opts.sender
   * @param {import('../core/middleware-pipeline.js').MiddlewarePipeline} opts.pipeline
   * @param {import('../adapters/hermes/hermes-api.js').HermesSessionApi} opts.hermesApi
   * @param {import('../storage/wake-cursor-store.js').WakeCursorStore} opts.cursorStore
   * @param {import('./reply-anchor-tracker.js').ReplyAnchorTracker} [opts.anchorTracker]
   * @param {import('../core/health-manager.js').HealthManager} [opts.health]
   * @param {import('../adapters/model/model-router.js').ModelRouter} [opts.modelRouter]
   *        委派转述用的模型出口（唯一模型通道：编排层不直接 fetch）
   */
  constructor(opts = {}) {
    this.config = opts.config;
    this.log = opts.logger?.child({ component: 'wake-flow' }) ?? console;
    this.sender = opts.sender;
    this.pipeline = opts.pipeline;
    this.api = opts.hermesApi;
    this.cursors = opts.cursorStore;
    this.anchors = opts.anchorTracker ?? null;
    this.health = opts.health ?? null;
    this.model = opts.modelRouter ?? null;
    /** 会话级输出互斥（可选注入）：与 ReplyFlow 争同一个 QQ 目标时严格让位 */
    this.outputQueue = opts.sessionSendQueue ?? null;
    /** anchorKey -> { attempts, lastAt, inFlight }：委派转述唤醒的进程内去重/重试状态 */
    this.relayState = new Map();

    this.timer = null;
    this.running = false;
    /** sessionId -> { lastPollAt, count } 内存态（游标本身在 cursorStore 里持久化） */
    this.sessionState = new Map();
    /** sessionId -> { anchorRowId, partCount, hits } 未闭合唤醒块的稳定性计数 */
    this.pendingBlocks = new Map();
    /** sessionId 集合：这一跳因目标被别的 flow 独占而未投递，需要下一跳重试 */
    this.deferred = new Set();
    this.lastErrorLoggedAt = 0;
    this.polling = false;
  }

  get enabled() {
    return this.config.wakeDelivery?.enabled === true;
  }

  /** 冷启动 Snapshot 开关（默认开；显式 false 才退回旧的"从 0 行开扫"行为） */
  get _coldStartSnapshotEnabled() {
    return this.config.wakeDelivery?.coldStartSnapshot !== false;
  }

  start() {
    if (!this.enabled || this.running) return this;
    this.running = true;
    const interval = Math.max(500, Number(this.config.wakeDelivery?.pollIntervalMs) || 3000);
    this.timer = setInterval(() => {
      this.pollOnce().catch((err) => {
        this.log.warn('唤醒回推轮询异常', { error: err.message });
      });
    }, interval);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.health?.update('wakeDelivery', { enabled: true, pollIntervalMs: interval });
    this.log.info('异步唤醒回推已启动', {
      pollIntervalMs: interval,
      source: this.config.wakeDelivery?.source ?? 'api_server',
      maxAgeMs: this.config.wakeDelivery?.maxAgeMs,
      delegationRelay: this.config.wakeDelivery?.delegationRelay?.enabled !== false,
      cursors: this.cursors?.stats?.() ?? null,
      hint: '同时需要 Hermes 端 platforms.api_server.extra.async_delivery=true',
    });
    // 立刻跑一轮：桥接重启后尽快补发未投递的通知
    this.pollOnce().catch(() => { /* 首轮失败由常规轮次接管 */ });
    return this;
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.health?.update('wakeDelivery', { enabled: false });
  }

  /**
   * 跑一轮：列会话 → 挑出桥接自己的会话 → 有变化就读 transcript → 投递。
   * 全程不抛异常（后台任务）。
   * @returns {Promise<{sessions: number, polled: number, delivered: number}>}
   */
  async pollOnce({ now = Date.now(), force = false } = {}) {
    if (!this.enabled || !this.api?.available) return { sessions: 0, polled: 0, delivered: 0 };
    if (this.polling) return { sessions: 0, polled: 0, delivered: 0 };
    this.polling = true;

    try {
      const list = await this.api.listSessions({
        source: this.config.wakeDelivery?.source ?? 'api_server',
        limit: this.config.wakeDelivery?.maxSessions ?? 200,
      });
      if (!list.ok) {
        this._noteError(`会话列表获取失败: ${list.error}`, now);
        return { sessions: 0, polled: 0, delivered: 0 };
      }
      this.health?.update('wakeDelivery', { lastPollAt: new Date(now).toISOString(), lastError: null });
      this.health?.increment('wakeDelivery', 'pollCount');

      const rows = Array.isArray(list.data?.data) ? list.data.data : [];
      const byId = new Map(rows.map((row) => [String(row?.id ?? ''), row]));
      this._pruneSessionState(byId);

      let polled = 0;
      let delivered = 0;
      for (const row of rows) {
        const sessionId = String(row?.id ?? '');
        if (!sessionId) continue;
        const target = resolveSessionTarget(sessionId, { byId });
        if (!target) continue; // 不是桥接的会话（例如别的客户端直连 api_server）

        const state = this.sessionState.get(sessionId);
        const cursor = this.cursors.getCursor(sessionId);
        const count = Number(row?.message_count) || 0;
        // 冷启动保护（缺陷二）：没有游标的会话 = 桥接从没消费过这个目标的
        // transcript（全新部署 / 游标被裁掉 / 文件丢失）。此时绝不能从 0 行开扫，
        // 否则重启前积累的历史转述会被当成新通知整段喷发。以当前最新行号为基线，
        // 并把历史块的稳定去重键一并回填（见 _snapshotSession）。
        if (!cursor && this._coldStartSnapshotEnabled) {
          await this._snapshotSession({ sessionId, target, count, now });
          this.sessionState.set(sessionId, { lastPollAt: now, count });
          polled += 1;
          continue;
        }
        // 还有未结算的唤醒块时必须每跳都读：message_count 没变不代表模型回复
        // 还没写进来（自投递唤醒轮的 user 行先落、assistant 行后落）。
        const pending = this.pendingBlocks.has(sessionId) || this.deferred.has(sessionId);
        const changed = !cursor || cursor.messageCount !== count;
        const stale = !state || now - state.lastPollAt >= VERIFY_INTERVAL_MS;
        if (!force && !pending && !changed && !stale) continue;

        const result = await this._pollSession({ sessionId, target, count, now });
        this.sessionState.set(sessionId, { lastPollAt: now, count });
        polled += 1;
        delivered += result.delivered;
      }

      return { sessions: rows.length, polled, delivered };
    } catch (err) {
      this._noteError(`唤醒回推轮询异常: ${err.message}`, now, { stack: err.stack?.split('\n')[1] });
      return { sessions: 0, polled: 0, delivered: 0 };
    } finally {
      this.polling = false;
    }
  }

  /**
   * 冷启动基线（缺陷二）。
   *
   * 触发条件：会话存在、但 WakeCursorStore 里没有它的游标记录。可能原因：
   *   - 全新部署（wakeDelivery 刚开）；
   *   - 游标被 retainDays 裁掉 / wake_cursors.json 丢失或损坏被隔离；
   *   - 新旧代码升级之间游标没来得及写。
   *
   * 这时若仍从 0 行开扫，transcript 里重启前已完成的历史转述会被当成新通知
   * 整段喷发到 QQ（用户反馈的"重启冷启动翻旧账重发"）。做法：
   *   1. 读一次 transcript，用同一个 extractor 把**所有**历史块（含未闭合的）
   *      解出来，把它们与行号无关的稳定键（stableKey / dedupKey）与 anchorKey
   *      全部回填进 handled；
   *   2. 游标一次性推到当前最新行号。
   * 于是：本跳不投递任何东西；将来 Hermes 压缩/改写重新分配行号，历史块也会被
   * 稳定键拦住，不会复活。启动后新落地的通知行号 > 基线，照常投递。
   *
   * @returns {Promise<boolean>} 是否成功建立基线
   */
  async _snapshotSession({ sessionId, target, count, now }) {
    // 取**最新**一页：基线必须是真正的末行。若用 order=oldest + limit，长 transcript 会
    // 只返回最早的一页，基线偏低，最新一页里的历史块既没被登记、游标又停在前面，
    // 下一跳仍可能把它们当新通知。extractor 内部会按 id 升序处理，与返回顺序无关。
    const page = await this.api.fetchMessages(sessionId, {
      order: 'latest',
      limit: this.config.wakeDelivery?.messagePageLimit ?? 500,
    });
    if (!page.ok) {
      this._noteError(`冷启动基线读取失败 ${sessionId}: ${page.error}`, now);
      return false;
    }
    const messages = Array.isArray(page.data?.data) ? page.data.data : [];
    // maxAgeMs=0：历史块一律视为"已处理"，不按年龄筛。
    // emitOpenBlocks=true：未闭合的块（还没等到模型回复）也要登记稳定键，
    // 否则它的 stableKey 会漏掉，改写重分号后仍可能被当新块重推。
    // fallbackAfterMs=0：基线阶段不生成兑底提示。
    const extracted = extractDetachedDeliveries(messages, {
      sessionId,
      lastRowId: 0,
      now,
      maxAgeMs: 0,
      emitOpenBlocks: true,
      fallbackAfterMs: 0,
    });
    const handledKeys = [];
    for (const delivery of extracted.deliveries) {
      handledKeys.push(delivery.anchorKey, delivery.stableKey, delivery.dedupKey);
    }
    for (const delegation of extracted.delegations) {
      handledKeys.push(delegation.anchorKey, delegation.stableKey);
    }
    const baseline = messages.reduce((max, row) => Math.max(max, Number(row?.id) || 0), 0);
    this.cursors.snapshotSession(sessionId, { lastRowId: baseline, messageCount: count, handledKeys });
    this.health?.increment('wakeDelivery', 'coldStartSnapshot');
    this.log.info('冷启动基线已建立：历史转述不再补发', {
      sessionId,
      target: `${target.messageType}:${target.id}`,
      rows: messages.length,
      baselineRowId: baseline,
      blockedDeliveries: extracted.deliveries.length,
      pendingDelegations: extracted.delegations.length,
      handledKeys: handledKeys.filter(Boolean).length,
    });
    return true;
  }

  /** 读一个会话的 transcript 并投递其中的分体通知 */
  async _pollSession({ sessionId, target, count, now }) {
    // 取**最新**一页：游标只关心 id > lastRowId 的行，而通知总在 transcript 末尾。
    // 用 order=oldest + limit 读长 transcript 时只会拿到最早的一页，末尾的新通知永远
    // 看不见（会话轮换周期内超过 limit 行就漏推）。extractor 内部按 id 升序处理，
    // 与返回顺序无关。
    const page = await this.api.fetchMessages(sessionId, {
      order: 'latest',
      limit: this.config.wakeDelivery?.messagePageLimit ?? 500,
    });
    if (!page.ok) {
      this._noteError(`会话消息读取失败 ${sessionId}: ${page.error}`, now);
      return { delivered: 0 };
    }
    const messages = Array.isArray(page.data?.data) ? page.data.data : [];
    const cursor = this.cursors.getCursor(sessionId);
    const lastRowId = Number(cursor?.lastRowId) || 0;

    const base = {
      sessionId,
      lastRowId,
      now,
      maxAgeMs: Number(this.config.wakeDelivery?.maxAgeMs) ?? 0,
      fallbackAfterMs: Number(this.config.wakeDelivery?.fallbackAfterMs) ?? 0,
      fallbackNotice: this.config.wakeDelivery?.fallbackNotice,
    };

    const first = extractDetachedDeliveries(messages, { ...base, emitOpenBlocks: false });
    let deliveries = first.deliveries;
    let delegations = first.delegations;
    let nextRowId = first.nextRowId;

    if (first.openBlock) {
      const stable = this._notePendingBlock(sessionId, first.openBlock);
      if (stable) {
        // 块连续两跳没变 → 判定轮次已结束，连未闭合的块一起投递
        const settled = extractDetachedDeliveries(messages, { ...base, emitOpenBlocks: true });
        deliveries = settled.deliveries;
        delegations = settled.delegations;
        nextRowId = settled.nextRowId;
        this.pendingBlocks.delete(sessionId);
      }
    } else {
      this.pendingBlocks.delete(sessionId);
    }

    // 委派完成行：Hermes 不为它起唤醒轮（只落内部汇报行），桥接替它叫醒模型转述。
    // 只负责“叫醒”，不直接投递任何东西——内部汇报行永不进 QQ。
    for (const delegation of delegations) {
      this._maybeRelayDelegation(delegation, target, { sessionId, now });
    }

    let delivered = 0;
    /** 第一个没能投递的位置（失败或让位）：游标停在它之前，下一跳重试 */
    let blocker = null;
    let deferred = false;
    for (const delivery of deliveries) {
      if (this.cursors.isHandled(delivery.anchorKey)) continue;
      // 跨 transcript 改写去重：Hermes 压缩会重新分配行号，anchorKey 会变，
      // 但 stableKey（deleg_/proc_ id）与 dedupKey（stableKey + 正文哈希）不会。
      // 注意只比 dedupKey，不比 stableKey：同一个 proc 的多次 watch_match 正文不同，
      // 必须都推，拿 stableKey 一刀切会把它们误吞。
      if (delivery.dedupKey && this.cursors.isHandled(delivery.dedupKey)) {
        this.log.debug('唤醒通知已投递过（稳定键命中），跳过', {
          sessionId,
          rowId: delivery.rowId,
          dedupKey: delivery.dedupKey,
        });
        continue;
      }
      try {
        const result = await this._deliver(delivery, target, { sessionId });
        if (result.deferred) {
          // 目标正被主回复流独占：不插队（缺陷一），游标停在这条之前，下一跳再试
          deferred = true;
          blocker = blocker == null ? delivery.rowId : Math.min(blocker, delivery.rowId);
          break;
        }
        if (result.queued > 0) delivered += 1;
      } catch (err) {
        // 单个分体通知失败不拖垮整轮：游标停在它之前，下一跳重试（已投递的靠 anchorKey 去重）
        blocker = blocker == null ? delivery.rowId : Math.min(blocker, delivery.rowId);
        this._noteError(`唤醒通知投递失败 ${sessionId}#${delivery.rowId}: ${err.message}`, now);
      }
    }

    // 让位的会话必须下一跳继续重试（否则 message_count 不变就再也不读了）；
    // 顺手把"已稳定"状态留住，下一跳直接重新结算，不必再等两跳稳定性。
    if (deferred) {
      this.deferred.add(sessionId);
      if (first.openBlock) {
        this.pendingBlocks.set(sessionId, {
          anchorRowId: first.openBlock.anchorRowId,
          partCount: first.openBlock.partCount,
          hits: STABILITY_TICKS,
        });
      }
    } else {
      this.deferred.delete(sessionId);
    }

    const cursorTarget = blocker == null ? nextRowId : Math.min(nextRowId, blocker - 1);
    this.cursors.setCursor(sessionId, cursorTarget, { messageCount: count });
    if (delivered > 0) {
      // delivered = 本轮结算的"分体通知块"数（一个块可能被切句器拆成多条 QQ 消息）
      this.health?.increment('wakeDelivery', 'delivered', delivered);
      this.log.info('异步唤醒通知已投递', {
        sessionId,
        target: `${target.messageType}:${target.id}`,
        delivered,
        cursor: cursorTarget,
      });
    }
    return { delivered };
  }

  /**
   * 丢掉已经不在会话列表里的内存态（会话被归档/删除/日期轮换后不再占用内存）。
   * 持久游标不动：万一它又出现，历史去重还在。
   */
  _pruneSessionState(byId) {
    for (const sessionId of this.sessionState.keys()) {
      if (!byId.has(sessionId)) this.sessionState.delete(sessionId);
    }
    for (const sessionId of this.pendingBlocks.keys()) {
      if (!byId.has(sessionId)) this.pendingBlocks.delete(sessionId);
    }
    for (const sessionId of this.deferred) {
      if (!byId.has(sessionId)) this.deferred.delete(sessionId);
    }
    // 委派转述状态按 anchorKey 记，而不是会话：清掉已不在会话列表里的目标即可。
    // sessionId 直接存在状态里 —— 会话 id 本身可能含 '#'（/new 轮换形如 …_#02），
    // 用 split('#')[0] 反推会把会话名截断，导致状态被每跳误删、反复叫醒模型。
    for (const [key, state] of this.relayState) {
      const sid = state?.sessionId ?? key.split('#')[0];
      if (!byId.has(sid)) this.relayState.delete(key);
    }
  }

  /**
   * 异步委派完成行 → 自投递一次唤醒轮，让模型用自己的口吻转述。
   *
   * Hermes 对 `delegate_task(background=true)` 的完成不起唤醒轮
   * （gateway/run_notifications.py: _self_post_api_server → persist_delegation_delivery
   * 只落一条写给 agent 的重注入信封），所以桥接替它发：以同一会话 + `hermes_wake_turn`
   * 自投递一次 /v1/chat/completions（与 Hermes 自己对 terminal 完成做的自投递同构）。
   * 模型的转述回复带 internal_notification 锚点落回 transcript，由普通唤醒块路径投递。
   *
   * 这里只做“叫醒”，不产出任何投递：失败重试由进程内状态兜，超过 maxAttempts 后
   * 交给 extractor 的 fallbackNotice；下一跳若看到模型回复（块已被闭合）就不再唤醒。
   */
  _maybeRelayDelegation(delegation, target, { sessionId, now }) {
    const relay = this.config.wakeDelivery?.delegationRelay ?? {};
    if (relay.enabled === false || !this.model?.generate) return;

    const key = delegation.stableKey ?? delegation.anchorKey;
    if (this.cursors?.isHandled?.(key)) return;

    const state = this.relayState.get(key);
    if (state?.done || state?.inFlight) return;
    const maxAttempts = Number(relay.maxAttempts) || 3;
    if (state && state.attempts >= maxAttempts) return;
    const cooldownMs = Number(relay.retryCooldownMs) || 0;
    if (state && cooldownMs > 0 && now - state.lastAt < cooldownMs) return;
    // 完成行刚落地时先等一下：万一 Hermes 侧自己写了 assistant 回复（未来版本 / 别的部署），
    // 就不必再唤醒一次；等到 graceMs 仍无回复才是真的需要桥接补上。
    const graceMs = Number(relay.graceMs) || 0;
    if (graceMs > 0 && delegation.at > 0 && now - delegation.at < graceMs) return;

    const attempts = (state?.attempts ?? 0) + 1;
    this.relayState.set(key, { attempts, lastAt: now, inFlight: true, sessionId });

    const modelRequest = createModelRequest({
      correlationId: `wake-relay-${delegation.rowId}-${randomUUID().slice(0, 8)}`,
      sessionId: `qq:${target.messageType}:${target.id}`,
      sessionKey: `${target.messageType}_${target.id}`,
      // 必须钉在读到委派完成行的那一个会话上：会话可能已轮换（日期 tag / /new），
      // 用 sessionKey 派生会落到新会话，旧会话的锚点块就永远等不到转述。
      sessionOverrideId: sessionId,
      model: this.config.model?.model,
      messages: [{ role: 'user', content: renderDelegationRelayPrompt(delegation.text, relay) }],
      stream: false,
      generation: { hermes_wake_turn: true },
    });

    this.model.generate(modelRequest).then(() => {
      // done：唤醒已成功，不再重复叫（提取器可能连续几跳都把同一个锚点报上来，
      // 例如两条委派完成行前后脚落地时前一条会被反复闭合）
      this.relayState.set(key, { attempts, lastAt: Date.now(), inFlight: false, done: true, sessionId });
      this.health?.increment('wakeDelivery', 'delegationRelay');
      this.log.info('已为异步委派完成行叫醒模型转述', {
        sessionId,
        target: `${target.messageType}:${target.id}`,
        rowId: delegation.rowId,
        attempts,
      });
    }).catch((err) => {
      this.relayState.set(key, { attempts, lastAt: Date.now(), inFlight: false, sessionId });
      this._noteError(`委派转述唤醒失败 ${sessionId}#${delegation.rowId}: ${err.message}`, now);
    });
  }

  /**
   * 记录未闭合块的出现次数。
   * @returns {boolean} true = 连续两跳内容一致（可以投递）
   */
  _notePendingBlock(sessionId, openBlock) {
    const prev = this.pendingBlocks.get(sessionId);
    if (
      prev &&
      prev.anchorRowId === openBlock.anchorRowId &&
      prev.partCount === openBlock.partCount &&
      prev.hits + 1 >= STABILITY_TICKS
    ) {
      return true;
    }
    const hits = prev && prev.anchorRowId === openBlock.anchorRowId && prev.partCount === openBlock.partCount
      ? prev.hits + 1
      : 1;
    this.pendingBlocks.set(sessionId, {
      anchorRowId: openBlock.anchorRowId,
      partCount: openBlock.partCount,
      hits,
    });
    return false;
  }

  /**
   * 一条分体通知 → QQ。
   *
   * 会话级输出租约（缺陷一）：目标被 ReplyFlow 独占时直接返回 `{deferred:true}`
   * 让位，不阻塞等待——阻塞会把整个轮询循环（其它会话）一起卡住。调用方据此把
   * 游标停在这一条之前，并把会话标为需要下一跳重试。租约直到本轮分段全部投递
   * 结算才释放。
   *
   * @returns {Promise<{queued: number, deferred: boolean}>}
   */
  async _deliver(delivery, target, { sessionId }) {
    const contractSessionId = `qq:${target.messageType}:${target.id}`;
    const laneKey = sendLaneKey({ type: target.messageType, id: target.id });
    const lease = this.outputQueue ? this.outputQueue.tryAcquire(laneKey, { owner: 'wake' }) : null;
    if (this.outputQueue && !lease) return { queued: 0, deferred: true };
    try {
      return await this._deliverWithLease(delivery, target, { sessionId, contractSessionId, lease });
    } finally {
      if (lease) {
        try {
          await lease.release();
        } catch (err) {
          this.log.warn('唤醒通知输出租约释放异常（已忽略）', {
            sessionId,
            rowId: delivery.rowId,
            error: err?.message ?? String(err),
          });
        }
      }
    }
  }

  /** @returns {Promise<{queued: number, deferred: boolean}>} */
  async _deliverWithLease(delivery, target, { sessionId, contractSessionId, lease }) {
    const correlationId = `wake-${delivery.rowId}-${randomUUID().slice(0, 8)}`;
    const inbound = this._syntheticInbound({ target, delivery, contractSessionId });
    const correlation = { correlationId, sessionId: contractSessionId };

    // 引用锚点：异步任务当初那条「已派给…」的派发消息，让完成通知自动带上引用气泡。
    // 取一次就够：下面只有本轮第一条可见分段挂引用，避免一小段通知反复引用同一条。
    // peek 会顺手丢弃过期锚点；真正消费（清空）放在确认送达队列之后。
    const anchor = this.anchors?.peek?.(contractSessionId) ?? null;

    let queued = 0;
    for (const segment of splitIntoSegments(delivery.text)) {
      const ctx = createTransformContext({
        ...correlation,
        inbound,
        text: segment,
        rawText: delivery.text,
        responseId: null,
        triggerType: TRIGGER_TYPES.AT,
        isFinalPass: false,
        signal: null,
      });
      const out = await this.pipeline.run(RESPONSE_NOTICE, ctx);
      if (out?.cancelled) break;
      const body = String(out?.text ?? '').trim();
      if (!body) continue;

      // 只有第一条真正入队的通知分段引用派发消息：引用气泡是「这段结果回应的是那件事」
      // 的视觉锚，挂在后续分段上会变成一串重复引用。
      const replyToMessageId = queued === 0 && anchor ? anchor.messageId : null;

      const outbound = createOutboundMessage({
        ...correlation,
        target: { type: target.messageType, id: target.id },
        text: body,
        metadata: {
          isFirst: false,
          disableAutoMention: true,
          origin: 'hermes-wake',
          noticeKind: delivery.kind,
          noticeRowId: delivery.rowId,
          noticeSessionId: sessionId,
          ...(replyToMessageId
            ? { replyToMessageId, anchorTurnId: anchor.turnId ?? null, anchorMatched: anchor.matched ?? null }
            : {}),
        },
      });
      // 输出租约存在时必须经租约入队（同目标串行）；未注入时退回直接 enqueue
      if (lease?.held) lease.enqueue(outbound);
      else this.sender.enqueue(outbound);
      queued += 1;
    }

    // 通知已带上引用（且已入发送队列）→ 消费锚点。与游标注销同一时点：队列本身的
    // 重试/幂等/断路器负责把它送到，锚点没必要跟着一起等——继续留着只会让下一条
    // 无关通知又引用同一条陈旧消息。
    if (queued > 0 && anchor && this.anchors?.consume?.(contractSessionId)) {
      this.log.info('完成通知已引用派发消息', {
        sessionId,
        target: `${target.messageType}:${target.id}`,
        anchorMessageId: anchor.messageId,
        matched: anchor.matched ?? null,
      });
    }

    this.cursors.markHandled(delivery.anchorKey);
    // 稳定键一并记上：
    //  - dedupKey 拦住改写后同正文的二次投递（本次事故的直接原因）
    //  - stableKey 拦住改写后同一个委派锚点再次叫醒模型
    if (delivery.dedupKey) this.cursors.markHandled(delivery.dedupKey);
    if (delivery.stableKey) this.cursors.markHandled(delivery.stableKey);
    if (queued === 0) {
      this.log.debug('唤醒通知处理后无可见文本，跳过投递', {
        sessionId,
        rowId: delivery.rowId,
        kind: delivery.kind,
      });
    }
    return { queued, deferred: false };
  }

  /**
   * 构造一个"最小 inbound"，只是为了让中间件管线拿得到会话身份。
   * 唤醒通知不是用户提问，没有触发者：userId 留空、flags 全 false，
   * 这样任何读 inbound 的中间件都不会误以为"某个用户说了话"。
   */
  _syntheticInbound({ target, delivery, contractSessionId }) {
    const isGroup = target.messageType === 'group';
    return {
      correlationId: null,
      sessionId: contractSessionId,
      executionKey: `${target.messageType}_${target.id}`,
      platform: 'qq',
      messageType: target.messageType,
      userId: '',
      groupId: isGroup ? target.id : null,
      messageId: null,
      text: '',
      content: '',
      segments: [],
      sender: { nickname: '', displayName: '' },
      flags: {
        isSelf: false,
        isOwner: false,
        isAdmin: false,
        isAtBot: false,
        isNameCall: false,
        isCommand: false,
      },
      media: [],
      extensions: { napcat: {}, hermesWake: { kind: delivery.kind, rowId: delivery.rowId } },
    };
  }

  _noteError(message, now, extra = {}) {
    this.health?.update('wakeDelivery', { lastError: message, lastErrorAt: new Date(now).toISOString() });
    this.health?.increment('wakeDelivery', 'failed');
    // 轮询失败会每跳都发生：一分钟内只打一条，避免刷屏
    if (!this.lastErrorLoggedAt || now - this.lastErrorLoggedAt >= ERROR_LOG_INTERVAL_MS) {
      this.lastErrorLoggedAt = now;
      this.log.warn('唤醒回推异常', { error: message, ...extra });
    }
  }
}
