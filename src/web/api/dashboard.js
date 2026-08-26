/**
 * web/api/dashboard.js — 系统大盘
 *
 * 三块内容：
 *   1. 组件健康卡片：NapCat WS / 模型服务 / 统一宿主 的实时连通性
 *   2. 运行指标：吞吐、平均 LLM 耗时、各 Middleware 执行延迟
 *   3. 熔断监控：各能力 Provider 的断路器状态与失败计数
 *
 * 探活刻意做成"每次请求都真探"而不是缓存：面板是人在看的，
 * 刷新间隔本来就有几秒，真实性比省这几个 HTTP 请求重要。
 * 但每个探活都有独立超时，任何一个挂掉不会拖住整个大盘。
 */

import { HEALTH } from '../../core/health-manager.js';

const PROBE_TIMEOUT_MS = 1500;

export function createDashboardApi(deps) {
  const { config, health, capabilityBus, eventBus, sender, sessionStore, traceCollector } = deps;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  return {
    'GET /api/dashboard': async () => ({
      body: {
        generatedAt: new Date().toISOString(),
        runtime: runtimeCard(config, health),
        components: await probeComponents(config, health, fetchImpl),
        metrics: traceCollector ? traceCollector.metrics() : null,
        capabilities: capabilitySnapshot(capabilityBus),
        circuits: circuitSnapshot(capabilityBus, sender),
        buses: {
          events: eventBus?.getStats?.() ?? {},
          capabilities: capabilityBus?.getStats?.() ?? {},
          publishedCount: eventBus?.publishedCount ?? 0,
        },
        queue: sender?.getStatus?.() ?? null,
        sessions: {
          active: sessionStore?.listActive?.() ?? [],
          windows: sessionStore ? sessionStore.contextWindows.size : 0,
        },
        plugins: await pluginSnapshot(health),
      },
    }),

    /** 单独拉指标，前端高频轮询用这个，比整块大盘便宜得多 */
    'GET /api/dashboard/metrics': async () => ({
      body: {
        at: Date.now(),
        process: health.process(),
        metrics: traceCollector ? traceCollector.metrics() : null,
        queue: sender?.getStatus?.() ?? null,
      },
    }),
  };
}

function runtimeCard(config, health) {
  const proc = health.process();
  return {
    mode: config.mode,
    shadowForced: config._shadowForced === true,
    sendEnabled: config.reply.sendEnabled,
    sideEffectsEnabled: config.reply.sideEffectsEnabled,
    botName: config.identity.botName,
    robotId: config.identity.robotId,
    ownerId: config.identity.ownerId,
    uptimeMs: proc.uptimeMs,
    pid: proc.pid,
    memory: proc.memory,
    messages: proc.messages,
    status: proc.status,
  };
}

/**
 * 三个外部组件的连通性。
 * NapCat WS 不用探——它是长连接，HealthManager 里的状态就是最新的实况；
 * 反倒是发个 HTTP 探针会得到"端口通但 WS 断了"的误判。
 */
async function probeComponents(config, health, fetchImpl) {
  const ws = health.state.websocket;

  const [model, host, napcatHttp] = await Promise.all([
    probeHttp(fetchImpl, joinUrl(config.model.baseUrl, '/models'), PROBE_TIMEOUT_MS),
    probeHttp(fetchImpl, joinUrl(config.unifiedHost?.baseUrl ?? '', '/health'), PROBE_TIMEOUT_MS),
    probeHttp(fetchImpl, joinUrl(config.napcat.httpUrl, '/get_status'), PROBE_TIMEOUT_MS),
  ]);

  return [
    {
      id: 'napcat-ws',
      label: 'NapCat WebSocket',
      target: config.napcat.wsUrl,
      status: ws.connected ? HEALTH.HEALTHY : HEALTH.CRITICAL,
      detail: {
        connected: ws.connected,
        lastMessageAt: ws.lastMessageAt,
        reconnectCount: ws.reconnectCount,
        lastError: ws.lastError,
      },
    },
    {
      id: 'napcat-http',
      label: 'NapCat HTTP',
      target: config.napcat.httpUrl,
      status: napcatHttp.ok ? HEALTH.HEALTHY : HEALTH.DEGRADED,
      detail: napcatHttp,
    },
    {
      id: 'model',
      label: `模型服务 (${config.model.model})`,
      target: config.model.baseUrl,
      status: model.ok ? HEALTH.HEALTHY : HEALTH.CRITICAL,
      detail: { ...model, consecutiveFailures: health.state.model.consecutiveFailures },
    },
    {
      id: 'unified-host',
      label: '统一宿主 (AstrBot 插件容器)',
      target: config.unifiedHost?.baseUrl ?? '(未配置)',
      status: !config.unifiedHost?.baseUrl
        ? HEALTH.DEGRADED
        : host.ok
          ? HEALTH.HEALTHY
          : HEALTH.DEGRADED,
      detail: host,
    },
  ];
}

async function probeHttp(fetchImpl, url, timeoutMs) {
  if (!url || typeof fetchImpl !== 'function') {
    return { ok: false, reason: 'not_configured' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetchImpl(url, { method: 'GET', signal: controller.signal });
    const elapsedMs = Date.now() - startedAt;
    let payload = null;
    try {
      payload = await res.json();
    } catch { /* 非 JSON 响应也算通，只是没细节 */ }
    return { ok: res.ok, status: res.status, elapsedMs, url, payload };
  } catch (err) {
    return {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      url,
      reason: err.name === 'AbortError' ? 'timeout' : (err.code ?? err.message),
    };
  } finally {
    clearTimeout(timer);
  }
}

function capabilitySnapshot(capabilityBus) {
  if (!capabilityBus) return [];
  const out = [];
  for (const capability of capabilityBus.providers.keys()) {
    out.push({ capability, providers: capabilityBus.listProviders(capability) });
  }
  return out;
}

function circuitSnapshot(capabilityBus, sender) {
  const circuits = capabilityBus?.getCircuitStatus?.() ?? [];
  const senderCircuit = sender?.breaker?.getStatus?.();
  if (senderCircuit) circuits.push({ ...senderCircuit, name: senderCircuit.name || 'sender' });
  // 状态名统一成大写，前端不必再做一次映射
  return circuits.map((c) => ({ ...c, state: String(c.state).toUpperCase() }));
}

async function pluginSnapshot(health) {
  try {
    return await health.plugins();
  } catch (err) {
    return { status: HEALTH.DEGRADED, plugins: [], error: err.message };
  }
}

function joinUrl(base, suffix) {
  if (!base) return '';
  return `${String(base).replace(/\/+$/, '')}${suffix}`;
}
