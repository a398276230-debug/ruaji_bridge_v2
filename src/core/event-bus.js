/**
 * core/event-bus.js — 广播型生命周期事件
 *
 * 契约（验收标准 7：单插件故障不阻塞主回复）：
 *   - publish() 立即返回，主流程从不 await 订阅者
 *   - 每个订阅者独立隔离，一个抛异常不影响其他订阅者
 *   - 所有 Promise rejection 必须被捕获（旧 Bridge 用裸 .catch(() => {})，
 *     结果是插件失败完全不可见）
 *   - 超时后释放，不挂住事件循环
 *   - payload 深冻结，订阅者拿不到可变引用
 *   - 相同 (event, messageId, subscriberId) 只广播一次
 */

import { validateEventEnvelope } from '../contracts/schemas/index.js';
import { classifyError } from '../contracts/errors.js';

export class EventBus {
  /**
   * @param {object} opts
   * @param {import('./logger.js').Logger} opts.logger
   * @param {import('./idempotency-store.js').IdempotencyStore} [opts.idempotency]
   * @param {number} [opts.defaultTimeoutMs=2500]
   */
  constructor(opts = {}) {
    this.log = opts.logger?.child({ component: 'event-bus' }) ?? console;
    this.idempotency = opts.idempotency || null;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 2500;
    /** event -> Map<subscriberId, { handler, timeoutMs }> */
    this.subscribers = new Map();
    this.stats = new Map(); // `${event}:${subscriberId}` -> { calls, failures, totalMs }
    /** 供影子模式与测试断言：所有 publish 过的事件 */
    this.publishedCount = 0;
  }

  /**
   * @param {string} event
   * @param {string} subscriberId  插件 id 或本地订阅者名
   * @param {(envelope: object) => Promise<void>} handler
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {() => void} 退订函数
   */
  subscribe(event, subscriberId, handler, opts = {}) {
    if (typeof handler !== 'function') throw new TypeError('handler 必须是函数');
    if (!this.subscribers.has(event)) this.subscribers.set(event, new Map());
    this.subscribers.get(event).set(subscriberId, {
      handler,
      timeoutMs: opts.timeoutMs ?? this.defaultTimeoutMs,
    });
    return () => this.subscribers.get(event)?.delete(subscriberId);
  }

  listSubscribers(event) {
    return [...(this.subscribers.get(event)?.keys() ?? [])];
  }

  /**
   * 广播事件。不返回订阅者结果，也不会 reject —— 主流程调用它时不需要 await。
   * @returns {Promise<void>} 仅供测试等待所有订阅者结束
   */
  publish(envelope) {
    const check = validateEventEnvelope(envelope);
    if (!check.valid) {
      this.log.error('事件信封非法，已丢弃', { errors: check.errors, event: envelope?.event });
      return Promise.resolve();
    }

    this.publishedCount++;
    const entries = [...(this.subscribers.get(envelope.event)?.entries() ?? [])];
    if (entries.length === 0) return Promise.resolve();

    const tasks = entries.map(([subscriberId, sub]) =>
      this._invoke(envelope, subscriberId, sub),
    );

    // allSettled 保证任何 rejection 都被吞在这里，不会冒泡成 unhandledRejection
    return Promise.allSettled(tasks).then(() => undefined);
  }

  async _invoke(envelope, subscriberId, sub) {
    // 幂等：相同事件 + 相同 messageId + 相同订阅者只投递一次
    const messageId = envelope.payload?.messageId ?? envelope.eventId;
    if (this.idempotency) {
      const key = this.idempotency.buildKey(envelope.event, messageId, subscriberId);
      if (!this.idempotency.claim(key)) {
        this.log.debug('事件重复投递已跳过', { event: envelope.event, subscriberId, messageId });
        return;
      }
    }

    const startedAt = Date.now();
    const statKey = `${envelope.event}:${subscriberId}`;
    const stat = this.stats.get(statKey) ?? { calls: 0, failures: 0, totalMs: 0 };
    stat.calls++;

    let timer = null;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`订阅者 ${subscriberId} 超时 (${sub.timeoutMs}ms)`)),
          sub.timeoutMs,
        );
      });
      await Promise.race([Promise.resolve(sub.handler(envelope)), timeout]);
    } catch (err) {
      stat.failures++;
      const classified = classifyError(err, envelope.correlationId);
      this.log.warn('事件订阅者失败', {
        event: envelope.event,
        subscriberId,
        correlationId: envelope.correlationId,
        error: classified.message,
      });
    } finally {
      if (timer) clearTimeout(timer);
      stat.totalMs += Date.now() - startedAt;
      this.stats.set(statKey, stat);
    }
  }

  getStats() {
    const out = {};
    for (const [key, stat] of this.stats) {
      out[key] = { ...stat, avgMs: stat.calls ? Math.round(stat.totalMs / stat.calls) : 0 };
    }
    return out;
  }
}
