/**
 * plugins/manifest-loader.js — 插件 manifest 加载与安全校验
 *
 * 首期只允许加载本地可信配置中列出的服务，不支持远程下载代码。
 * 安全要求：插件仅允许配置白名单地址，默认阻止访问非本机私网地址。
 */

import { validateManifest } from '../contracts/schemas/index.js';
import { ConfigError } from '../contracts/errors.js';

/** 本机回环地址白名单 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * 私网/链路本地网段。默认阻止：插件配置错一个字就把内网地址打出去，
 * 这在旧 Bridge 里是完全没有防线的（地址硬编码在业务代码里）。
 */
const PRIVATE_RANGES = [
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^fc00:/i,
  /^fd[0-9a-f]{2}:/i,
  /^fe80:/i,
];

export function isLoopback(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname).toLowerCase());
}

export function isPrivateAddress(hostname) {
  const host = String(hostname).toLowerCase();
  return PRIVATE_RANGES.some((re) => re.test(host));
}

/**
 * @param {string} baseUrl
 * @param {{ allowPrivateNetwork?: boolean, allowedHosts?: string[] }} policy
 */
export function assertUrlAllowed(baseUrl, policy = {}) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ConfigError(`插件 baseUrl 非法: ${baseUrl}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`插件 baseUrl 协议不支持: ${url.protocol}`);
  }

  const host = url.hostname;
  const allowedHosts = policy.allowedHosts ?? [];
  if (allowedHosts.length && allowedHosts.includes(host)) return url;

  if (isLoopback(host)) return url;

  if (isPrivateAddress(host)) {
    if (policy.allowPrivateNetwork) return url;
    throw new ConfigError(
      `插件地址 ${host} 位于私网，默认被阻止。确需访问请把它加入 plugins.allowedHosts 或开启 allowPrivateNetwork。`,
    );
  }

  // 公网地址：首期不允许，插件必须跑在本机
  throw new ConfigError(
    `插件地址 ${host} 不在白名单内。首期只允许本机回环地址，或显式列入 allowedHosts。`,
  );
}

/**
 * 从配置数组加载 manifest 列表。
 * 非法 manifest 只记录并跳过，不让一个写错的插件配置挡住整个 Bridge 启动。
 *
 * @param {object[]} rawManifests
 * @param {{ logger?: object, policy?: object }} opts
 * @returns {{ manifests: object[], rejected: Array<{id:string, errors:string[]}> }}
 */
export function loadManifests(rawManifests = [], opts = {}) {
  const log = opts.logger ?? console;
  const policy = opts.policy ?? {};
  const manifests = [];
  const rejected = [];
  const seenIds = new Set();

  for (const raw of rawManifests) {
    const check = validateManifest(raw);
    if (!check.valid) {
      rejected.push({ id: raw?.id ?? '(无 id)', errors: check.errors });
      log.error?.('插件 manifest 非法，已跳过', { pluginId: raw?.id, errors: check.errors });
      continue;
    }

    if (seenIds.has(raw.id)) {
      rejected.push({ id: raw.id, errors: ['插件 id 重复'] });
      log.error?.('插件 id 重复，已跳过', { pluginId: raw.id });
      continue;
    }

    if (raw.transport === 'http') {
      try {
        assertUrlAllowed(raw.baseUrl, policy);
      } catch (e) {
        rejected.push({ id: raw.id, errors: [e.message] });
        log.error?.('插件地址不被允许，已跳过', { pluginId: raw.id, error: e.message });
        continue;
      }
    }

    seenIds.add(raw.id);
    manifests.push(normalizeManifest(raw));
  }

  return { manifests, rejected };
}

function normalizeManifest(raw) {
  return Object.freeze({
    id: raw.id,
    version: raw.version,
    enabled: raw.enabled !== false,
    transport: raw.transport,
    baseUrl: raw.baseUrl ?? null,
    subscriptions: Object.freeze(
      (raw.subscriptions ?? []).map((s) =>
        typeof s === 'string'
          ? { event: s, path: null, method: 'POST', body: null, when: null }
          : {
              event: s.event,
              path: s.path ?? null,
              method: (s.method ?? 'POST').toUpperCase(),
              /** wire format 映射模板，见 plugins/template.js */
              body: s.body ?? null,
              /** 投递条件，如 { messageType: 'group' } */
              when: s.when ?? null,
            },
      ),
    ),
    capabilities: Object.freeze(
      (raw.capabilities ?? []).map((c) => ({
        name: c.name,
        priority: Number.isFinite(c.priority) ? c.priority : 50,
        path: c.path ?? null,
        method: (c.method ?? 'POST').toUpperCase(),
        timeoutMs: c.timeoutMs ?? raw.timeouts?.requestMs ?? 2500,
        body: c.body ?? null,
        query: c.query ?? null,
        resultPath: c.resultPath ?? null,
        metadata: c.metadata ?? null,
        dedupeKey: c.dedupeKey ?? null,
        scope: c.scope ?? null,
      })),
    ),
    timeouts: Object.freeze({
      connectMs: raw.timeouts?.connectMs ?? 1000,
      requestMs: raw.timeouts?.requestMs ?? 2500,
    }),
    retry: Object.freeze({
      maxAttempts: raw.retry?.maxAttempts ?? 1,
      backoffMs: raw.retry?.backoffMs ?? 250,
    }),
    breaker: Object.freeze({
      threshold: raw.breaker?.threshold ?? 3,
      cooldownMs: raw.breaker?.cooldownMs ?? 60000,
    }),
  });
}
