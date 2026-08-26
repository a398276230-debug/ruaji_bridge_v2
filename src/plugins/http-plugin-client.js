/**
 * plugins/http-plugin-client.js — HTTP transport
 *
 * 所有外部插件调用的唯一出口。业务代码里不再出现 fetch('http://127.0.0.1:8877/...')。
 *
 * 与旧 Bridge 的差异：
 *   - 旧代码每个插件调用点各写一遍 fetch + AbortSignal.timeout + .catch(() => {})，
 *     失败静默、无法统计、超时值散落在六个文件里
 *   - 这里统一超时、统一错误分类、统一脱敏日志，超时值来自 manifest
 */

import { PluginTimeoutError, PluginTransportError } from '../contracts/errors.js';

export class HttpPluginClient {
  /**
   * @param {object} opts
   * @param {object} opts.manifest    normalizeManifest() 的产物
   * @param {import('../core/logger.js').Logger} opts.logger
   * @param {typeof fetch} [opts.fetchImpl] 便于测试注入
   */
  constructor(opts = {}) {
    this.manifest = opts.manifest;
    this.log = opts.logger?.child({ component: 'http-plugin', pluginId: opts.manifest?.id }) ?? console;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  /**
   * @param {object} spec
   * @param {string} spec.path
   * @param {string} [spec.method='POST']
   * @param {object} [spec.body]
   * @param {object} [spec.query]
   * @param {number} [spec.timeoutMs]
   * @param {AbortSignal} [spec.signal]
   * @returns {Promise<any>} 已解析的 JSON（无响应体时返回 null）
   */
  async call(spec) {
    const { manifest } = this;
    const method = (spec.method ?? 'POST').toUpperCase();
    const timeoutMs = spec.timeoutMs ?? manifest.timeouts.requestMs;

    const url = new URL(spec.path, manifest.baseUrl);
    for (const [k, v] of Object.entries(spec.query ?? {})) {
      if (v != null) url.searchParams.set(k, String(v));
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort(spec.signal?.reason);
    if (spec.signal) {
      if (spec.signal.aborted) controller.abort(spec.signal.reason);
      else spec.signal.addEventListener('abort', onAbort, { once: true });
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const startedAt = Date.now();
    try {
      const init = { method, signal: controller.signal, headers: {} };
      if (method !== 'GET' && method !== 'HEAD' && spec.body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(spec.body);
      }

      const res = await this.fetchImpl(url, init);
      const text = await res.text();

      if (!res.ok) {
        throw new PluginTransportError(manifest.id, `HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      this.log.debug('插件调用成功', {
        path: spec.path,
        status: res.status,
        elapsedMs: Date.now() - startedAt,
      });

      if (!text.trim()) return null;
      try {
        return JSON.parse(text);
      } catch {
        // 有插件（例如纯文本上下文服务）直接返回裸字符串
        return text;
      }
    } catch (err) {
      if (timedOut) {
        throw new PluginTimeoutError(manifest.id, spec.path, timeoutMs, { cause: err });
      }
      if (err instanceof PluginTransportError) throw err;
      if (err?.name === 'AbortError') throw err; // 上游主动取消，交给调用方分类
      throw new PluginTransportError(manifest.id, err?.message ?? String(err), { cause: err });
    } finally {
      clearTimeout(timer);
      if (spec.signal) spec.signal.removeEventListener('abort', onAbort);
    }
  }

  /** 健康探针：优先 /health，失败则退回 baseUrl 根路径 */
  async ping(timeoutMs = 1500) {
    for (const path of ['/health', '/']) {
      try {
        await this.call({ path, method: 'GET', timeoutMs });
        return { ok: true, probe: path };
      } catch (err) {
        if (err instanceof PluginTimeoutError) return { ok: false, detail: err.message };
      }
    }
    return { ok: false, detail: '无可用健康探针' };
  }
}
