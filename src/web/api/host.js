/**
 * web/api/host.js — 统一宿主总览与插件聚合 API
 */

export function createHostApi(deps) {
  const hostUrl = deps.config?.unifiedHost?.url ?? 'http://127.0.0.1:8870';

  async function forwardGet(path) {
    try {
      const res = await fetch(`${hostUrl}${path}`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) {
        return { status: res.status, body: { ok: false, error: `宿主返回 HTTP ${res.status}` } };
      }
      const data = await res.json();
      return { status: 200, body: data };
    } catch (err) {
      return { status: 200, body: { ok: false, error: `统一宿主未启动或不可达: ${err.message}` } };
    }
  }

  async function forwardPost(path, body) {
    try {
      const res = await fetch(`${hostUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(3000),
      });
      const data = await res.json().catch(() => ({}));
      return { status: res.status, body: data };
    } catch (err) {
      return { status: 500, body: { ok: false, error: `统一宿主调用异常: ${err.message}` } };
    }
  }

  return {
    'GET /api/host/overview': async () => forwardGet('/api/v1/overview'),
    'GET /api/host/providers': async () => forwardGet('/api/v1/providers'),
    'POST /api/host/providers/update': async ({ body }) => forwardPost('/api/v1/providers/update', body),
    'GET /api/host/plugins-pages': async () => forwardGet('/api/v1/plugins/pages'),
  };
}
