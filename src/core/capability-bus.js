/**
 * core/capability-bus.js — 需要结果的能力调用
 *
 * 与 EventBus 的分工：
 *   EventBus      广播，不要结果，永不阻塞主流程
 *   CapabilityBus 要结果，有超时/重试/熔断/schema 校验，主流程会 await
 *
 * 两种调用模式：
 *   request(name, input)  单结果。按 priority 降序选 Provider，失败/熔断则
 *                         fallback 到下一个；全部失败抛 CapabilityUnavailableError
 *   collect(name, input)  多结果。并行调用全部 Provider，失败项丢弃
 *
 * Bridge 主流程只认能力名。Provider 是谁、在哪个端口、走 HTTP 还是进程内，
 * 全部由 PluginRegistry 在注册期决定。
 */

import {
  CapabilityUnavailableError,
  CircuitOpenError,
  classifyError,
  countsAsFailure,
} from '../contracts/errors.js';
import { CircuitBreakerRegistry } from './circuit-breaker.js';

export class CapabilityBus {
  /**
   * @param {object} opts
   * @param {import('./logger.js').Logger} opts.logger
   * @param {object} [opts.breakerDefaults] { threshold, cooldownMs }
   */
  constructor(opts = {}) {
    this.log = opts.logger?.child({ component: 'capability-bus' }) ?? console;
    this.breakers = opts.breakers ?? new CircuitBreakerRegistry(opts.breakerDefaults ?? {
      threshold: 3,
      cooldownMs: 60000,
    });
    /** capability -> Provider[]（按 priority 降序） */
    this.providers = new Map();
    this.stats = new Map();
    /**
     * 可选观察者：每次能力调用结束后收到一条 span。默认 null，不挂就是零开销。
     * 运维面板的 TraceCollector 挂在这里还原单条消息的时序；调用本身不感知它，
     * 观察者抛异常也只被吞掉，绝不影响能力调用结果。
     * @type {((span: {capability:string, providerId:string, elapsedMs:number, ok:boolean, correlationId?:string, error?:string}) => void)|null}
     */
    this.observer = opts.observer ?? null;
  }

  /**
   * @param {object} provider
   * @param {string} provider.id           插件 id
   * @param {string} provider.capability
   * @param {number} [provider.priority=50]
   * @param {(input: object, ctx: object) => Promise<any>} provider.invoke
   * @param {(body: any) => {valid:boolean,errors:string[]}} [provider.validate]
   * @param {number} [provider.timeoutMs]
   * @param {{maxAttempts?:number, backoffMs?:number}} [provider.retry]
   * @param {(sessionId: string) => boolean} [provider.sessionFilter] 按 session 路由
   */
  register(provider) {
    if (!provider?.capability) throw new TypeError('provider 缺少 capability');
    if (typeof provider.invoke !== 'function') throw new TypeError('provider.invoke 必须是函数');

    const list = this.providers.get(provider.capability) ?? [];
    const entry = { priority: 50, timeoutMs: 2500, retry: { maxAttempts: 1, backoffMs: 250 }, ...provider };
    list.push(entry);
    list.sort((a, b) => b.priority - a.priority);
    this.providers.set(provider.capability, list);

    this.log.info('能力提供者已注册', {
      capability: provider.capability,
      providerId: provider.id,
      priority: entry.priority,
    });
    return () => {
      const current = this.providers.get(provider.capability) ?? [];
      this.providers.set(
        provider.capability,
        current.filter((p) => p !== entry),
      );
    };
  }

  has(capability) {
    return (this.providers.get(capability) ?? []).length > 0;
  }

  listProviders(capability) {
    return (this.providers.get(capability) ?? []).map((p) => ({
      id: p.id,
      priority: p.priority,
      circuit: this.breakers.get(`${p.id}:${capability}`).getStatus(),
    }));
  }

  /**
   * 单结果调用，带 fallback。
   * @param {string} capability
   * @param {object} input
   * @param {{ sessionId?: string, correlationId?: string, signal?: AbortSignal }} [ctx]
   */
  async request(capability, input, ctx = {}) {
    const candidates = this._eligible(capability, ctx);
    if (candidates.length === 0) {
      throw new CapabilityUnavailableError(capability, '没有已注册且可用的 Provider', {
        correlationId: ctx.correlationId,
      });
    }

    const failures = [];
    for (const provider of candidates) {
      try {
        const result = await this._callWithRetry(provider, capability, input, ctx);
        return { providerId: provider.id, result };
      } catch (err) {
        const classified = classifyError(err, ctx.correlationId);
        failures.push(`${provider.id}: ${classified.message}`);
        if (!(err instanceof CircuitOpenError)) {
          this.log.warn('能力调用失败，尝试下一个 Provider', {
            capability,
            providerId: provider.id,
            correlationId: ctx.correlationId,
            error: classified.message,
          });
        }
      }
    }

    throw new CapabilityUnavailableError(capability, `全部 Provider 失败 [${failures.join(' | ')}]`, {
      correlationId: ctx.correlationId,
    });
  }

  /**
   * 单结果调用的降级版：失败不抛，返回 null。
   * 编排层的裁决/上下文都用这个，保证插件全挂时主链路仍然走得下去。
   */
  async requestOrNull(capability, input, ctx = {}) {
    try {
      return await this.request(capability, input, ctx);
    } catch (err) {
      const classified = classifyError(err, ctx.correlationId);
      this.log.warn('能力不可用，主链路降级继续', {
        capability,
        correlationId: ctx.correlationId,
        error: classified.message,
      });
      return null;
    }
  }

  /**
   * 并行聚合调用。任何 Provider 失败都只丢弃它自己的结果。
   * @returns {Promise<Array<{providerId: string, priority: number, result: any}>>}
   */
  async collect(capability, input, ctx = {}) {
    const candidates = this._eligible(capability, ctx);
    if (candidates.length === 0) return [];

    const settled = await Promise.allSettled(
      candidates.map(async (provider) => ({
        providerId: provider.id,
        // 上下文聚合要按 priority 排序，这个字段必须一路传下去
        priority: provider.priority,
        result: await this._callWithRetry(provider, capability, input, ctx),
      })),
    );

    const out = [];
    for (const [i, entry] of settled.entries()) {
      if (entry.status === 'fulfilled') {
        out.push(entry.value);
        continue;
      }
      const provider = candidates[i];
      const classified = classifyError(entry.reason, ctx.correlationId);
      if (!(entry.reason instanceof CircuitOpenError)) {
        this.log.warn('聚合调用中单个 Provider 失败，已丢弃其结果', {
          capability,
          providerId: provider.id,
          correlationId: ctx.correlationId,
          error: classified.message,
        });
      }
    }
    return out;
  }

  _eligible(capability, ctx) {
    const list = this.providers.get(capability) ?? [];
    return list.filter((p) => {
      if (p.enabled === false) return false;
      if (p.sessionFilter && ctx.sessionId && !p.sessionFilter(ctx.sessionId)) return false;
      return true;
    });
  }

  async _callWithRetry(provider, capability, input, ctx) {
    const breaker = this.breakers.get(`${provider.id}:${capability}`, {
      threshold: provider.breakerThreshold,
      cooldownMs: provider.breakerCooldownMs,
    });
    breaker.assertCanAttempt(); // 熔断打开时抛 CircuitOpenError（suppressed）

    const maxAttempts = Math.max(1, provider.retry?.maxAttempts ?? 1);
    const backoffMs = provider.retry?.backoffMs ?? 250;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const startedAt = Date.now();
      try {
        const result = await this._callOnce(provider, capability, input, ctx);
        breaker.recordSuccess();
        this._recordStat(provider.id, capability, Date.now() - startedAt, true);
        this._observe({
          capability,
          providerId: provider.id,
          elapsedMs: Date.now() - startedAt,
          ok: true,
          correlationId: ctx.correlationId,
        });
        return result;
      } catch (err) {
        lastError = err;
        this._recordStat(provider.id, capability, Date.now() - startedAt, false);
        this._observe({
          capability,
          providerId: provider.id,
          elapsedMs: Date.now() - startedAt,
          ok: false,
          correlationId: ctx.correlationId,
          error: err?.message,
        });
        // 主动取消（主人打断）不重试也不计熔断
        if (!countsAsFailure(classifyError(err))) throw err;
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, backoffMs * attempt));
        }
      }
    }

    breaker.recordFailure(lastError);
    throw lastError;
  }

  async _callOnce(provider, capability, input, ctx) {
    const timeoutMs = provider.timeoutMs ?? 2500;
    const controller = new AbortController();
    const onAbort = () => controller.abort(ctx.signal?.reason);
    if (ctx.signal) {
      if (ctx.signal.aborted) controller.abort(ctx.signal.reason);
      else ctx.signal.addEventListener('abort', onAbort, { once: true });
    }

    let timer = null;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          const e = new Error(`${provider.id} 的 ${capability} 超时 (${timeoutMs}ms)`);
          e.name = 'TimeoutError';
          reject(e);
        }, timeoutMs);
      });

      const body = await Promise.race([
        Promise.resolve(provider.invoke(input, { ...ctx, signal: controller.signal, timeoutMs })),
        timeout,
      ]);

      if (provider.validate) {
        const check = provider.validate(body);
        if (!check.valid) {
          throw new TypeError(`${provider.id} 响应不符合契约: ${check.errors.join('; ')}`);
        }
      }
      return body;
    } finally {
      if (timer) clearTimeout(timer);
      if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
    }
  }

  _recordStat(providerId, capability, ms, ok) {
    const key = `${providerId}:${capability}`;
    const stat = this.stats.get(key) ?? { calls: 0, failures: 0, totalMs: 0 };
    stat.calls++;
    if (!ok) stat.failures++;
    stat.totalMs += ms;
    this.stats.set(key, stat);
  }

  /** 观察者永远不能影响调用结果，所以它的异常在这里就地吞掉 */
  _observe(span) {
    if (!this.observer) return;
    try {
      this.observer(span);
    } catch { /* ignore */ }
  }

  getStats() {
    const out = {};
    for (const [key, stat] of this.stats) {
      out[key] = { ...stat, avgMs: stat.calls ? Math.round(stat.totalMs / stat.calls) : 0 };
    }
    return out;
  }

  getCircuitStatus() {
    return this.breakers.getStatusAll();
  }
}
