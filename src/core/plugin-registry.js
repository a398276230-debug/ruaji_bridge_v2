/**
 * core/plugin-registry.js — 插件注册中心
 *
 * 把 manifest 翻译成两件事：
 *   1. EventBus 订阅（广播，不要结果，失败不阻塞主链）
 *   2. CapabilityBus Provider（要结果，有超时/重试/熔断）
 *
 * 注册完成后，主流程只认能力名与事件名，PluginRegistry 是唯一知道
 * "谁在哪个端口、走什么 wire format" 的地方。
 */

import { HttpPluginClient } from '../plugins/http-plugin-client.js';
import { loadManifests } from '../plugins/manifest-loader.js';
import { resolveTemplate, extractResult, matchesCondition } from '../plugins/template.js';
import { validateDecisionResponse, validateContextResponse } from '../contracts/schemas/index.js';

/** 能力名 → 响应校验器。未列出的能力不做 schema 校验。 */
const RESPONSE_VALIDATORS = {
  'decision.group_reply': validateDecisionResponse,
  'context.enrich': validateContextResponse,
  'context.long_term_memory': validateContextResponse,
};

export class PluginRegistry {
  /**
   * @param {object} opts
   * @param {import('./event-bus.js').EventBus} opts.eventBus
   * @param {import('./capability-bus.js').CapabilityBus} opts.capabilityBus
   * @param {import('./logger.js').Logger} opts.logger
   * @param {typeof fetch} [opts.fetchImpl]
   */
  constructor(opts = {}) {
    this.eventBus = opts.eventBus;
    this.capabilityBus = opts.capabilityBus;
    this.log = opts.logger?.child({ component: 'plugin-registry' }) ?? console;
    this.fetchImpl = opts.fetchImpl;
    /** id -> { manifest, client, unsubscribes[] } */
    this.plugins = new Map();
    this.rejected = [];
  }

  /**
   * @param {object[]} rawManifests
   * @param {{ allowPrivateNetwork?: boolean, allowedHosts?: string[] }} [policy]
   */
  loadFromConfig(rawManifests, policy = {}) {
    const { manifests, rejected } = loadManifests(rawManifests, { logger: this.log, policy });
    this.rejected = rejected;
    for (const manifest of manifests) this.registerManifest(manifest);
    this.log.info('插件加载完成', {
      loaded: manifests.filter((m) => m.enabled).map((m) => m.id),
      disabled: manifests.filter((m) => !m.enabled).map((m) => m.id),
      rejected: rejected.map((r) => r.id),
    });
    return { loaded: manifests, rejected };
  }

  registerManifest(manifest) {
    if (!manifest.enabled) {
      this.plugins.set(manifest.id, { manifest, client: null, unsubscribes: [] });
      return;
    }

    const client =
      manifest.transport === 'http'
        ? new HttpPluginClient({ manifest, logger: this.log, fetchImpl: this.fetchImpl })
        : null;

    const unsubscribes = [];
    for (const sub of manifest.subscriptions) {
      unsubscribes.push(this._wireSubscription(manifest, client, sub));
    }
    for (const cap of manifest.capabilities) {
      unsubscribes.push(this._wireCapability(manifest, client, cap));
    }

    this.plugins.set(manifest.id, { manifest, client, unsubscribes });
  }

  _wireSubscription(manifest, client, sub) {
    return this.eventBus.subscribe(
      sub.event,
      manifest.id,
      async (envelope) => {
        if (!matchesCondition(sub.when, envelope.payload)) return;
        if (manifest.transport !== 'http') return;

        const body = sub.body
          ? resolveTemplate(sub.body, envelope.payload)
          : { event: envelope.event, correlationId: envelope.correlationId, ...envelope.payload };

        await client.call({
          path: sub.path,
          method: sub.method ?? 'POST',
          body,
          timeoutMs: manifest.timeouts.requestMs,
        });
      },
      { timeoutMs: manifest.timeouts.requestMs },
    );
  }

  _wireCapability(manifest, client, cap) {
    const validate = RESPONSE_VALIDATORS[cap.name];

    return this.capabilityBus.register({
      id: manifest.id,
      capability: cap.name,
      priority: cap.priority,
      timeoutMs: cap.timeoutMs,
      retry: manifest.retry,
      breakerThreshold: manifest.breaker.threshold,
      breakerCooldownMs: manifest.breaker.cooldownMs,
      validate,
      invoke: async (input, ctx) => {
        if (manifest.transport !== 'http') {
          throw new TypeError(`插件 ${manifest.id} 的 transport ${manifest.transport} 不支持能力调用`);
        }
        const body = cap.body ? resolveTemplate(cap.body, input) : cap.method === 'GET' ? undefined : input;
        const query = cap.query ? resolveTemplate(cap.query, input) : undefined;

        const raw = await client.call({
          path: cap.path,
          method: cap.method,
          body,
          query,
          timeoutMs: ctx?.timeoutMs ?? cap.timeoutMs,
          signal: ctx?.signal,
        });
        const extracted = extractResult(raw, cap.resultPath);
        if (cap.metadata || cap.dedupeKey || cap.scope) {
          if (typeof extracted === 'string') {
            return {
              text: extracted,
              metadata: cap.metadata ?? {},
              dedupeKey: cap.dedupeKey ?? null,
              scope: cap.scope ?? 'any',
            };
          }
          if (extracted && typeof extracted === 'object') {
            return {
              ...extracted,
              metadata: { ...(cap.metadata ?? {}), ...(extracted.metadata ?? {}) },
              dedupeKey: extracted.dedupeKey ?? cap.dedupeKey ?? null,
              scope: extracted.scope ?? cap.scope ?? 'any',
            };
          }
        }
        return extracted;
      },
    });
  }

  /** 注册进程内 Provider（本地滑窗、语气画像等），与 HTTP 插件共用同一条能力总线 */
  registerLocalProvider({ id, capability, priority = 50, invoke, timeoutMs = 500 }) {
    const unsubscribe = this.capabilityBus.register({
      id,
      capability,
      priority,
      timeoutMs,
      retry: { maxAttempts: 1, backoffMs: 0 },
      validate: RESPONSE_VALIDATORS[capability],
      invoke,
    });
    const existing = this.plugins.get(id);
    if (existing) existing.unsubscribes.push(unsubscribe);
    else {
      this.plugins.set(id, {
        manifest: { id, version: 'local', enabled: true, transport: 'local' },
        client: null,
        unsubscribes: [unsubscribe],
      });
    }
    return unsubscribe;
  }

  list() {
    return [...this.plugins.values()].map(({ manifest }) => ({
      id: manifest.id,
      version: manifest.version,
      enabled: manifest.enabled,
      transport: manifest.transport,
      subscriptions: (manifest.subscriptions ?? []).map((s) => s.event),
      capabilities: (manifest.capabilities ?? []).map((c) => c.name),
    }));
  }

  /** 分层健康检查的插件层：并发探活 + 熔断态 */
  async health() {
    const entries = [...this.plugins.values()];
    const probes = await Promise.all(
      entries.map(async ({ manifest, client }) => {
        if (!manifest.enabled) return { id: manifest.id, status: 'disabled' };
        if (!client) return { id: manifest.id, status: 'local' };
        const ping = await client.ping(manifest.timeouts.connectMs);
        return { id: manifest.id, status: ping.ok ? 'reachable' : 'unreachable', detail: ping.detail };
      }),
    );

    const circuits = this.capabilityBus.getCircuitStatus();
    return probes.map((p) => ({
      ...p,
      circuits: circuits.filter((c) => c.name.startsWith(`${p.id}:`)),
    }));
  }

  shutdown() {
    for (const { unsubscribes } of this.plugins.values()) {
      for (const off of unsubscribes) {
        try { off(); } catch { /* ignore */ }
      }
    }
    this.plugins.clear();
  }
}
