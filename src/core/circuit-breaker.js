/**
 * core/circuit-breaker.js — 熔断器
 *
 * 沿用旧 agent_interface.js:44-106 已验证的语义，并修掉那里的两个坑：
 *   1. 旧实现在半开时 `this.isOpen = false` 直接改状态，成功与失败都不再区分
 *      "半开探测"与"正常调用"；这里显式建模 HALF_OPEN，只放行一次探测。
 *   2. 旧 canAttempt() 被主动拦截时，调用方还会 recordFailure()，导致冷却窗口
 *      被无限顺延（bridge.js:724-727 专门绕过这点）。这里由 CircuitOpenError
 *      的 suppressed 标志表达，调用方统一用 countsAsFailure() 判断。
 */

import { CircuitOpenError } from '../contracts/errors.js';

export const CIRCUIT_STATE = Object.freeze({
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half_open',
});

export class CircuitBreaker {
  /**
   * @param {string} name
   * @param {object} [opts]
   * @param {number} [opts.threshold=5]   连续失败多少次后打开
   * @param {number} [opts.cooldownMs=60000]
   * @param {() => number} [opts.now]     便于测试注入时钟
   */
  constructor(name, opts = {}) {
    this.name = name;
    this.threshold = opts.threshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 60000;
    this.now = opts.now ?? Date.now;

    this.state = CIRCUIT_STATE.CLOSED;
    this.failures = 0;
    this.nextRetryAt = null;
    this.lastError = null;
    this.openedAt = null;
    this.totalOpens = 0;
  }

  /** 是否放行本次调用。半开时只放行一次探测。 */
  canAttempt() {
    if (this.state === CIRCUIT_STATE.CLOSED) return true;
    if (this.state === CIRCUIT_STATE.HALF_OPEN) return false; // 已有探测在途
    if (this.nextRetryAt != null && this.now() >= this.nextRetryAt) {
      this.state = CIRCUIT_STATE.HALF_OPEN;
      return true;
    }
    return false;
  }

  /** 放行则返回；被拦截则抛 CircuitOpenError（suppressed=true，不计失败） */
  assertCanAttempt() {
    if (!this.canAttempt()) {
      throw new CircuitOpenError(this.name, this.nextRetryAt ?? this.now() + this.cooldownMs);
    }
  }

  recordSuccess() {
    this.failures = 0;
    this.state = CIRCUIT_STATE.CLOSED;
    this.nextRetryAt = null;
    this.lastError = null;
    this.openedAt = null;
  }

  recordFailure(err) {
    this.lastError = err ? String(err.message || err) : null;

    if (this.state === CIRCUIT_STATE.HALF_OPEN) {
      // 探测失败：立即回到打开态并重新计时
      this.state = CIRCUIT_STATE.OPEN;
      this.nextRetryAt = this.now() + this.cooldownMs;
      return;
    }

    this.failures++;
    if (this.failures >= this.threshold && this.state === CIRCUIT_STATE.CLOSED) {
      this.state = CIRCUIT_STATE.OPEN;
      this.openedAt = this.now();
      this.nextRetryAt = this.now() + this.cooldownMs;
      this.totalOpens++;
    }
  }

  get isOpen() {
    return this.state !== CIRCUIT_STATE.CLOSED;
  }

  getStatus() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      threshold: this.threshold,
      nextRetryAt: this.nextRetryAt,
      openedAt: this.openedAt,
      totalOpens: this.totalOpens,
      lastError: this.lastError,
    };
  }
}

/** 按 key 惰性创建熔断器 */
export class CircuitBreakerRegistry {
  constructor(defaults = {}) {
    this.defaults = defaults;
    this.breakers = new Map();
  }

  get(key, opts = {}) {
    let breaker = this.breakers.get(key);
    if (!breaker) {
      // 显式过滤 undefined：调用方常传 { threshold: manifest.breaker?.threshold }，
      // 直接展开会用 undefined 覆盖掉 defaults，让阈值悄悄退回构造函数默认值。
      const merged = { ...this.defaults };
      for (const [name, value] of Object.entries(opts)) {
        if (value !== undefined) merged[name] = value;
      }
      breaker = new CircuitBreaker(key, merged);
      this.breakers.set(key, breaker);
    }
    return breaker;
  }

  getStatusAll() {
    return [...this.breakers.values()].map((b) => b.getStatus());
  }
}
