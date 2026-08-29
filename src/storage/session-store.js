/**
 * storage/session-store.js — 会话状态（v2 独立存储，绝不碰旧 Bridge 数据）
 *
 * 承载三件旧 Bridge 用全局变量维护的东西：
 *   groupContextBuffer   群聊滑窗（bridge.js:23）
 *   consecutiveReplies   限流窗口（bridge.js:27）
 *   activeControllers    在途生成与打断（bridge.js:408, 1731-1739）
 *
 * 全部按 sessionId / executionKey 隔离，不再是模块级可变全局。
 */

export class SessionStore {
  /**
   * @param {object} opts
   * @param {number} [opts.windowSize=15]        滑窗保留条数
   * @param {number} [opts.rateLimitWindowMs=300000]
   * @param {() => number} [opts.now]
   */
  constructor(opts = {}) {
    this.windowSize = opts.windowSize ?? 15;
    this.rateLimitWindowMs = opts.rateLimitWindowMs ?? 300000;
    this.now = opts.now ?? Date.now;

    /** sessionId -> [{ nickname, text, time, userId }] */
    this.contextWindows = new Map();
    /** userId -> number[] 回复时间戳 */
    this.replyTimestamps = new Map();
    /** executionKey -> { controller, startedAt, source, correlationId } */
    this.activeExecutions = new Map();
    /** executionKey -> { pending: [], timer } */
    this.pendingBuffers = new Map();
  }

  // ===== 群聊滑窗 =====

  recordContext(sessionId, entry) {
    if (!sessionId || !entry?.text) return;
    let window = this.contextWindows.get(sessionId);
    if (!window) {
      window = [];
      this.contextWindows.set(sessionId, window);
    }
    window.push({
      messageId: entry.messageId ?? null,
      nickname: entry.nickname,
      text: entry.text,
      userId: entry.userId ?? null,
      time: entry.time ?? formatClock(this.now()),
    });
    while (window.length > this.windowSize) window.shift();
  }

  /**
   * 取最近 N 条历史消息（排除当前正在处理的消息）。
   * 第三参支持单个 messageId（旧用法）或整批 messageId 数组——
   * 防抖合并批次里每条都已入窗，只排最后一条会让先到的消息出现两遍（P1 联动）。
   */
  renderContext(sessionId, count, excludeMessageId = null) {
    let window = this.contextWindows.get(sessionId) ?? [];
    if (excludeMessageId) {
      const exclude = new Set(
        (Array.isArray(excludeMessageId) ? excludeMessageId : [excludeMessageId]).map(String),
      );
      window = window.filter((m) => !exclude.has(String(m.messageId)));
    }
    return window
      .slice(-count)
      .map((m) => `[${m.time}] ${m.nickname}: ${m.text}`)
      .join('\n');
  }

  getContextWindow(sessionId) {
    return [...(this.contextWindows.get(sessionId) ?? [])];
  }

  /** 获取指定用户在某会话中的最近发言列表 */
  getUserMessages(sessionId, userId, count = 50) {
    const window = this.contextWindows.get(sessionId) ?? [];
    const targetUid = String(userId);
    return window
      .filter((m) => String(m.userId) === targetUid)
      .slice(-count)
      .map((m) => `${m.nickname}: ${m.text}`);
  }

  // ===== 限流 =====

  /** 记录一次实际回复（仅对限流名单内的用户调用） */
  recordReply(userId) {
    const key = String(userId);
    const list = this.replyTimestamps.get(key) ?? [];
    list.push(this.now());
    this.replyTimestamps.set(key, this._prune(list));
  }

  countRecentReplies(userId) {
    const key = String(userId);
    const list = this._prune(this.replyTimestamps.get(key) ?? []);
    this.replyTimestamps.set(key, list);
    return list.length;
  }

  _prune(list) {
    const cutoff = this.now() - this.rateLimitWindowMs;
    return list.filter((t) => t > cutoff);
  }

  // ===== 在途生成与打断 =====

  getActive(executionKey) {
    return this.activeExecutions.get(executionKey) ?? null;
  }

  isBusy(executionKey) {
    const active = this.activeExecutions.get(executionKey);
    return Boolean(active && !active.controller.signal.aborted);
  }

  beginExecution(executionKey, { controller, source, correlationId }) {
    this.activeExecutions.set(executionKey, {
      controller,
      source: source ?? 'direct',
      correlationId: correlationId ?? null,
      startedAt: this.now(),
    });
  }

  /** 只有当前登记的 controller 才允许清理，避免误删后来者 */
  endExecution(executionKey, controller) {
    const active = this.activeExecutions.get(executionKey);
    if (active && active.controller === controller) this.activeExecutions.delete(executionKey);
  }

  /**
   * 打断在途生成。
   * @returns {boolean} 是否真的打断了
   */
  preempt(executionKey, reason) {
    const active = this.activeExecutions.get(executionKey);
    if (!active || active.controller.signal.aborted) return false;
    active.controller.abort(reason);
    return true;
  }

  listActive() {
    return [...this.activeExecutions.entries()].map(([key, v]) => ({
      executionKey: key,
      source: v.source,
      correlationId: v.correlationId,
      startedAt: v.startedAt,
      elapsedMs: this.now() - v.startedAt,
    }));
  }

  // ===== 防抖缓冲 =====

  getBuffer(executionKey) {
    let buf = this.pendingBuffers.get(executionKey);
    if (!buf) {
      buf = { pending: [], timer: null };
      this.pendingBuffers.set(executionKey, buf);
    }
    return buf;
  }

  drainBuffer(executionKey) {
    const buf = this.getBuffer(executionKey);
    const items = buf.pending;
    buf.pending = [];
    return items;
  }

  /**
   * 把 drain 出来但本轮不处理的消息按原序放回队首。
   * 放回队首而不是队尾：drain 之后可能已经有新消息 push 进来，
   * 挂到队尾会让先到的消息排在后到的后面。
   */
  requeue(executionKey, items) {
    if (!items?.length) return;
    const buf = this.getBuffer(executionKey);
    buf.pending.unshift(...items);
  }

  clearAllTimers() {
    for (const buf of this.pendingBuffers.values()) {
      if (buf.timer) {
        clearTimeout(buf.timer);
        buf.timer = null;
      }
    }
  }
}

function formatClock(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}
