/**
 * core/idempotency-store.js — 幂等键存储
 *
 * 统一幂等键：eventName + messageId + providerId
 *
 * 用途：
 *   - 事件广播去重（相同消息不重复推给同一插件）
 *   - 好感度写入按模型响应 ID 去重
 *   - NapCat 发送按发送事务 ID 去重（旧 Bridge 的复读事故根因之一：
 *     NTEvent 超时被当成失败重发，bridge.js:709 是补丁，这里是结构性防护）
 *
 * 内存 + TTL 环形淘汰，不引外部存储。进程重启后已发送记录由 send-queue-store
 * 的持久化承担，两者互补。
 */

export class IdempotencyStore {
  /**
   * @param {object} [opts]
   * @param {number} [opts.ttlMs=3600000]  单条记录存活时间
   * @param {number} [opts.maxEntries=20000]
   * @param {() => number} [opts.now]
   */
  constructor(opts = {}) {
    this.ttlMs = opts.ttlMs ?? 3600000;
    this.maxEntries = opts.maxEntries ?? 20000;
    this.now = opts.now ?? Date.now;
    /** key -> expiresAt。Map 保序，淘汰时从头删即为最旧。 */
    this.entries = new Map();
  }

  buildKey(eventName, messageId, providerId) {
    return `${eventName}|${messageId}|${providerId}`;
  }

  /**
   * 占用一个幂等键。
   * @returns {boolean} true = 首次占用（应执行）；false = 已占用（应跳过）
   */
  claim(key) {
    this._evictExpired();
    const existing = this.entries.get(key);
    if (existing != null && existing > this.now()) return false;

    this.entries.set(key, this.now() + this.ttlMs);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
    return true;
  }

  /** 只查询不占用 */
  has(key) {
    const expiresAt = this.entries.get(key);
    return expiresAt != null && expiresAt > this.now();
  }

  /** 主动释放（例如发送最终失败，允许后续重排队） */
  release(key) {
    this.entries.delete(key);
  }

  _evictExpired() {
    const now = this.now();
    // 只在 Map 头部做有界清理，避免每次调用全量遍历
    let checked = 0;
    for (const [key, expiresAt] of this.entries) {
      if (checked++ > 64) break;
      if (expiresAt <= now) this.entries.delete(key);
      else break; // 插入顺序 ≈ 过期顺序（TTL 固定），遇到未过期即可停
    }
  }

  get size() {
    return this.entries.size;
  }

  clear() {
    this.entries.clear();
  }
}
