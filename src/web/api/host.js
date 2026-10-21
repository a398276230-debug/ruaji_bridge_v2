/**
 * web/api/host.js — 统一宿主总览与插件聚合 API
 */

export function createHostApi(deps) {
  const hostUrl = deps.config?.unifiedHost?.baseUrl ?? 'http://127.0.0.1:8870';

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

  async function forwardFavour(endpoint, method, body) {
    const suffix = `/plug/favour_ultra/api/${endpoint}`;
    return method === 'GET' ? forwardGet(suffix) : forwardPost(suffix, body);
  }

  return {
    'GET /api/host/overview': async () => forwardGet('/api/v1/overview'),
    'GET /api/host/providers': async () => forwardGet('/api/v1/providers'),
    'POST /api/host/providers/update': async ({ body }) => forwardPost('/api/v1/providers/update', body),
    'GET /api/host/plugins-pages': async () => forwardGet('/api/v1/plugins/pages'),
    // World Info 只有宿主 SQLite 一份事实源。Native payloads travel in
    // dataText / entryText strings: do not parse those fields here. Object
    // data/raw fields remain backward-compatible but JS may round large ints.
    ...Object.fromEntries(['list', 'get', 'export', 'settings'].map((action) => [
      `GET /api/host/lorebooks/${action}`, async ({ url } = {}) => {
        const params = new URLSearchParams(url?.searchParams);
        return forwardGet(`/api/v1/lorebooks/${action}${params.size ? `?${params}` : ''}`);
      },
    ])),
    ...Object.fromEntries(['create', 'update', 'delete', 'entry', 'entry-delete', 'selection', 'import', 'settings'].map((action) => [
      `POST /api/host/lorebooks/${action}`, async ({ body }) => forwardPost(`/api/v1/lorebooks/${action}`, body),
    ])),
    'GET /api/host/favour/config': async () => forwardFavour('config', 'GET'),
    'POST /api/host/favour/config': async ({ body }) => forwardFavour('config', 'POST', body),
    'GET /api/host/favour/datarecords': async () => forwardFavour('datarecords', 'GET'),
    'POST /api/host/favour/datarecords': async ({ body }) => forwardFavour('datarecords', 'POST', body),
    'GET /api/host/favour/backups': async () => forwardFavour('backups', 'GET'),
    'POST /api/host/favour/backups': async ({ body }) => forwardFavour('backups', 'POST', body),
    'GET /api/host/favour/sessions': async () => forwardFavour('sessions', 'GET'),
    'POST /api/host/favour/sessions': async ({ body }) => forwardFavour('sessions', 'POST', body),
    'GET /api/host/favour/session_sync': async () => forwardFavour('session_sync', 'GET'),
    'POST /api/host/favour/session_sync': async ({ body }) => forwardFavour('session_sync', 'POST', body),
  };
}
