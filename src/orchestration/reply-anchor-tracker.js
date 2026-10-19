/**
 * orchestration/reply-anchor-tracker.js — 异步完成通知的引用锚点
 *
 * 要解决的问题：Hermes 后台任务派发出去后，桥接先回一句「收到，已派给 Pi，弄好叫你~」。
 * 几十分钟后任务跑完，唤醒通知被推回群里——如果这条通知带上引用气泡指向当初那句
 * 派发承诺，用户一眼就知道「这条结果是刚才那件事的」，不用在刷过去的聊天记录里找。
 *
 * 锚点从哪来：发送队列每发出一段回复，NapCat 会回真实的 QQ message_id
 * （sender.js 的 `_publishSent` → EVENTS.MESSAGE_SENT.payload.replyId）。本模块订阅
 * 该事件，从一轮回复的若干分段里挑出「最该被引用的那一段」记到
 * WakeCursorStore.anchors[契约会话 id]，wake-flow 投递完成通知时取出来填进
 * `metadata.replyToMessageId`（OutboundBuilder 会转成前置 [CQ:reply,id=…]）。
 *
 * 选哪一段（strategy）：
 *   auto（默认）—— 优先命中「派发标记」的那一段（如「已经派给 Pi」「后台跑起来了」
 *     「弄好叫你」），这一句本身就在向用户承诺"稍后有结果"，引用它语义最连贯；
 *     没有标记段时退回**本轮第一条发送成功的分段**。选首段而不是末段，是因为
 *     桥接的 splitIntoSegments 会把一条完整回复拆成多段发，首段带 @ 与主语
 *     （"@某人 我已经派给 Pi 了"），引用它视觉上最完整、最不容易歧义；末段多半
 *     是补一句语气词，引用它会让通知和派发承诺脱节。
 *   first —— 固定本轮首条发送成功的分段（不认派发标记）。
 *   last  —— 固定本轮末条发送成功的分段（同轮内逐段覆盖，收敛到最后的落点）。
 *
 * 跨轮次的覆盖规则（auto）：
 *   - 命中派发标记的分段总是覆盖（新的派发就是新的锚点）。
 *   - 普通分段**不覆盖别的轮次留下的派发锚点**：用户派完任务又闲聊两句时，
 *     闲聊回复不该把派发承诺顶掉，否则通知会引用一句无关的"今天天气不错"。
 *     只有当前没有锚点、或旧锚点本身也只是普通分段时才刷新。
 *   - 通知自己（metadata.origin='hermes-wake'）永不记录，避免引用链套娃。
 *
 * 生命周期：wake-flow 投递完成通知时消费（清空）锚点，后续无关通知不会再引用同一条
 * 陈旧消息；锚点另有 maxAgeMs 上限，超过就不再用（顺手清掉）。
 */

import { EVENTS } from '../contracts/events.js';

export const ANCHOR_STRATEGIES = Object.freeze(['auto', 'first', 'last']);

/** 上下文里表示"已经把活派出去/挂到后台"的说法。命中即认为该段最适合被引用。 */
export const DEFAULT_ANCHOR_MARKERS = Object.freeze([
  // 中文：派给 / 交给 / 转给 / 提交给 …
  '(已|已经)?(派给|派发给|委派给|安排给|交给|转给|提交给|分给|发给)',
  '(已|已经)?(派|委派|安排|交|转|提交)[^。！？!?\\n]{0,16}(跑|做|写|画|弄|处理|生成|执行|部署|测试|查|研究)',
  // 中文：后台/异步已经在跑
  '(后台|异步|后台任务|后台进程)[^。！？!?\\n]{0,12}(跑|执行|处理|进行|开始)',
  // 中文：弄好/跑完 叫你
  '(弄好|跑完|做完|写好|画好|处理完|生成完|出结果)[^。！？!?\\n]{0,10}(叫你|告诉你|跟你说|喊你|通知你)',
  // 英文（模型偶尔切英文）
  '(dispatched|delegated|submitted|queued|kicked off|started)\\s+(it\\s+)?(in\\s+the\\s+)?(background|async)',
  "(i'?ll|will)\\s+(let\\s+you\\s+know|notify|ping|tell\\s+you)\\s+(when|once)",
]);

/** 这些来源的出站消息不做锚点（它们是通知本身，不是用户的派发轮次） */
const IGNORED_ORIGINS = new Set(['hermes-wake', 'tool-progress']);

export class ReplyAnchorTracker {
  /**
   * @param {object} opts
   * @param {object} opts.config
   * @param {import('../core/logger.js').Logger} [opts.logger]
   * @param {import('../storage/wake-cursor-store.js').WakeCursorStore} opts.cursorStore
   * @param {() => number} [opts.now]
   */
  constructor(opts = {}) {
    this.config = opts.config ?? {};
    this.log = opts.logger?.child({ component: 'reply-anchor' }) ?? console;
    this.cursors = opts.cursorStore ?? null;
    this.now = opts.now ?? Date.now;

    const cfg = this.config.wakeDelivery?.anchor ?? {};
    // 同时受两个开关约束：锚点只服务于唤醒回推，回推没开就不必收事件、更不必每次回复
    // 都往 wake_cursors.json 里写一笔。两个开关都得重启生效。
    this.enabled =
      cfg.enabled !== false && this.config.wakeDelivery?.enabled === true && Boolean(this.cursors);
    this.strategy = ANCHOR_STRATEGIES.includes(cfg.strategy) ? cfg.strategy : 'auto';
    const maxAge = Number(cfg.maxAgeMs);
    // 未配置时给 6 小时：后台任务动辄跑几十分钟到几小时，锚点太短会白记
    this.maxAgeMs = Number.isFinite(maxAge) && maxAge >= 0 ? maxAge : 21600000;
    this.markers = compileMarkers(cfg.markers, this.log);

    this.unsubscribe = null;
    /** 供面板/测试观察 */
    this.stats = { recorded: 0, skipped: 0, consumed: 0, expired: 0 };
  }

  /** 挂到事件总线上；重复调用无副作用 */
  attach(eventBus) {
    if (!this.enabled || !eventBus || this.unsubscribe) return this;
    this.unsubscribe = eventBus.subscribe(EVENTS.MESSAGE_SENT, 'reply-anchor', (envelope) => {
      // 记录失败绝不能影响发送链路：这里整体兜底（事件总线本来也会吞，但兜底的
      // 异常进不了订阅者日志的语义细节，自己打一条更清楚）
      try {
        this.handleSent(envelope);
      } catch (err) {
        this.log.warn('引用锚点记录失败', {
          sessionId: envelope?.sessionId ?? null,
          error: err?.message ?? String(err),
        });
      }
    });
    this.log.info('异步通知引用锚点已启用', {
      strategy: this.strategy,
      maxAgeMs: this.maxAgeMs,
      markers: this.markers.length,
    });
    return this;
  }

  detach() {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
  }

  /**
   * 处理一条 message.sent。只认真实送达（status='success' 且带 NapCat 返回的
   * replyId）；dry-run 没有真实 message_id，无法引用。
   * @param {object} envelope  EVENTS.MESSAGE_SENT 信封
   * @returns {object|null} 本次写入的锚点（未写入返回 null）
   */
  handleSent(envelope) {
    if (!this.enabled) return null;
    const payload = envelope?.payload ?? {};
    if (payload.status !== 'success') return null;
    const messageId = payload.replyId == null ? '' : String(payload.replyId);
    if (!messageId) return null;
    if (IGNORED_ORIGINS.has(payload.origin)) return null;

    const sessionId = envelope?.sessionId;
    if (!sessionId) return null;

    const turnId = payload.turnId == null ? (envelope.correlationId ?? null) : String(payload.turnId);
    const isMarker = this.isDispatchMarker(payload.text);
    const current = this.cursors.getAnchor(sessionId);
    const sameTurn = Boolean(current && current.turnId != null && String(current.turnId) === String(turnId));

    const target = this._decide({ sameTurn, current, isMarker });
    if (!target) {
      this.stats.skipped += 1;
      return null;
    }

    this.cursors.setAnchor(sessionId, {
      messageId,
      turnId,
      matched: target,
    });
    this.stats.recorded += 1;
    this.log.debug('已记录引用锚点', {
      sessionId,
      messageId,
      turnId,
      matched: target,
      isMarker,
    });
    return this.cursors.getAnchor(sessionId);
  }

  /**
   * 本轮这一段该不该成为锚点、以什么身份（'dispatch' | 'first' | 'last'）。
   * @returns {string|null}
   */
  _decide({ sameTurn, current, isMarker }) {
    if (this.strategy === 'last') return isMarker ? 'dispatch' : 'last';
    if (this.strategy === 'first') {
      // 本轮已经有锚点（首段已记）就不再动；跨轮直接刷新
      return sameTurn ? null : 'first';
    }
    // auto
    if (isMarker) {
      // 同轮内已锁定派发段就不必重复写；否则升级/覆盖
      if (sameTurn && current.matched === 'dispatch') return null;
      return 'dispatch';
    }
    // 普通分段：本轮已有锚点就保留（首段优先）；跨轮不得顶掉派发锚点
    if (sameTurn) return null;
    if (current?.matched === 'dispatch') return null;
    return 'first';
  }

  /** 该文本是否命中派发标记 */
  isDispatchMarker(text) {
    const value = String(text ?? '');
    if (!value) return false;
    return this.markers.some((re) => re.test(value));
  }

  /**
   * 给 wake-flow 用：取当前有效的引用锚点（过期的顺手清掉）。
   * @param {string} sessionId 契约会话 id（qq:group:777）
   * @returns {{messageId: string, turnId: string|null, matched: string}|null}
   */
  peek(sessionId, now = this.now()) {
    if (!this.enabled) return null;
    const anchor = this.cursors.getAnchor(sessionId);
    if (!anchor) return null;
    if (this.maxAgeMs > 0 && anchor.updatedAt && now - anchor.updatedAt > this.maxAgeMs) {
      this.cursors.clearAnchor(sessionId);
      this.stats.expired += 1;
      this.log.debug('引用锚点过期，不再使用', {
        sessionId,
        messageId: anchor.messageId,
        ageMs: now - anchor.updatedAt,
      });
      return null;
    }
    return anchor;
  }

  /** 通知已经引用过这个锚点 → 清空，避免后续无关通知继续引用同一条陈旧消息 */
  consume(sessionId) {
    if (!this.enabled) return false;
    const anchor = this.cursors.getAnchor(sessionId);
    if (!anchor) return false;
    this.cursors.clearAnchor(sessionId);
    this.stats.consumed += 1;
    return true;
  }
}

/** 配置里的 markers 是正则字符串数组；缺省（未配置）用内置默认，显式给空数组=不认标记 */
function compileMarkers(list, log) {
  const source = Array.isArray(list) ? list : DEFAULT_ANCHOR_MARKERS;
  const out = [];
  for (const pattern of source) {
    try {
      out.push(new RegExp(pattern, 'i'));
    } catch (err) {
      log?.warn?.('wakeDelivery.anchor.markers 中有非法正则，已忽略', {
        pattern,
        error: err.message,
      });
    }
  }
  return out;
}
