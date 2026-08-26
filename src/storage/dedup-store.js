/**
 * storage/dedup-store.js — 入站消息去重
 *
 * 相同 messageId 只处理一次。旧 Bridge 完全没有这一层：NapCat 重连后重推、
 * 或同时接多个 WS 客户端时，同一条消息会被处理两遍（GCP 裁决里那个
 * route='duplicate' 就是上游在帮忙兜底）。
 *
 * 与 IdempotencyStore 的分工：
 *   DedupStore       入站维度，"这条 QQ 消息我见过没"
 *   IdempotencyStore 副作用维度，"这个写入/发送我做过没"
 */

export class DedupStore {
  /**
   * @param {object} [opts]
   * @param {number} [opts.ttlMs=600000]
   * @param {number} [opts.maxEntries=10000]
   * @param {() => number} [opts.now]
   */
  constructor(opts = {}) {
    this.ttlMs = opts.ttlMs ?? 600000;
    this.maxEntries = opts.maxEntries ?? 10000;
    this.now = opts.now ?? Date.now;
    this.seen = new Map();
  }

  /**
   * @returns {boolean} true = 首次见到（应处理）；false = 重复（应丢弃）
   */
  markSeen(messageId) {
    if (!messageId) return true; // 拿不到 id 就不去重，宁可多处理也不漏
    const key = String(messageId);
    const expiresAt = this.seen.get(key);
    if (expiresAt != null && expiresAt > this.now()) return false;

    this.seen.set(key, this.now() + this.ttlMs);
    if (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      this.seen.delete(oldest);
    }
    return true;
  }

  has(messageId) {
    const expiresAt = this.seen.get(String(messageId));
    return expiresAt != null && expiresAt > this.now();
  }

  get size() {
    return this.seen.size;
  }

  clear() {
    this.seen.clear();
  }
}
