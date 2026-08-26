/**
 * web/server.js — 运维面板的轻量 HTTP 服务
 *
 * 设计约束（与 README §1 "最小依赖" 一致）：
 *   - 只用 node:http，不引任何框架，不做前端构建
 *   - 只绑 127.0.0.1。面板能改好感度、能触发沙箱推理，绝不允许暴露到外网
 *   - 与 HealthManager (:29996) 分开监听：健康端点是给探针的纯只读接口，
 *     面板是给人的，两者的可用性要求和变更频率完全不同，不该互相牵连
 *
 * 路由分发是一张显式表而不是链式 if：新增 API 只加一行，
 * 也让 tests/unit/web-server.test.js 能直接断言路由表的完整性。
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDashboardApi } from './api/dashboard.js';
import { createTracesApi } from './api/traces.js';
import { createShadowApi } from './api/shadow.js';
import { createAffectionApi } from './api/affection.js';
import { createMemesApi } from './api/memes.js';
import { createSandboxApi } from './api/sandbox.js';
import { createConfigApi } from './api/config.js';
import { createHostApi } from './api/host.js';
import { createPortrayalApi } from './api/portrayal.js';
import { createPluginsConfigApi } from './api/plugins-config.js';
import { handlePluginProxy } from './proxy.js';

const PUBLIC_DIR = path.resolve(fileURLToPath(import.meta.url), '../public');

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
});

/** 请求体上限：面板不上传文件，1MB 足够，超了直接拒绝而不是撑爆内存 */
const MAX_BODY_BYTES = 1024 * 1024;

/** 旧 Bridge 的 http_server.js 与保留端口，撞上会让影子对照跑不起来 */
export const LEGACY_BRIDGE_PORTS = Object.freeze([29998, 29999]);

export class WebServer {
  /**
   * @param {object} deps  容器（createContainer 的产物）
   * @param {object} [opts]
   * @param {string} [opts.publicDir] 测试可覆盖
   */
  constructor(deps, opts = {}) {
    this.c = deps;
    this.config = deps.config;
    this.log = deps.logger?.child({ component: 'web' }) ?? console;
    this.publicDir = opts.publicDir ?? PUBLIC_DIR;
    this.server = null;
    this.startedAt = Date.now();

    this.routes = buildRoutes(deps);
  }

  /** 供测试与文档使用：当前注册的全部 API 路由 */
  listRoutes() {
    return [...this.routes.keys()].sort();
  }

  listen(port = this.config.web?.port ?? 29998, host = this.config.web?.host ?? '127.0.0.1') {
    // 任务书把面板定在 29998，而 README §1 把 29998/29999 留给了旧 Bridge。
    // 两者只有在"旧 Bridge 也在跑"时才真冲突，所以这里不拒绝启动，只把
    // 代价说清楚 —— 影子对照要并行时，改 web.port 即可，面板不参与主链路。
    if (LEGACY_BRIDGE_PORTS.includes(Number(port))) {
      this.log.warn('面板占用了旧 Bridge 的保留端口', {
        port,
        impact: '旧 Bridge 的 http_server.js 同时在跑时会 EADDRINUSE，影子对照无法并行',
        fix: '设置 web.port（或环境变量 RUAJI_V2_WEB_PORT）改到 29995 等空闲端口',
      });
    }

    this.server = http.createServer((req, res) => {
      this._handle(req, res).catch((err) => {
        this.log.error('面板请求处理异常', { url: req.url, error: err.message });
        if (!res.headersSent) sendJson(res, 500, { error: err.message });
        else res.end();
      });
    });

    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        const actual = this.server.address();
        this.log.info('运维面板已启动', {
          url: `http://${host}:${actual.port}/`,
          routes: this.routes.size,
        });
        resolve(this.server);
      });
    });
  }

  async close() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }

  async _handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    // CORS 一律不开：面板只在 loopback 上跑，开了反而给 DNS rebinding 留门
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (pathname.startsWith('/proxy/plugin/')) {
      return handlePluginProxy(req, res, pathname);
    }

    if (pathname.startsWith('/api/')) {
      const key = `${req.method} ${pathname}`;
      const handler = this.routes.get(key) ?? this._matchPrefix(req.method, pathname);
      if (!handler) return sendJson(res, 404, { error: `未知接口 ${key}` });

      let body = null;
      if (req.method === 'POST' || req.method === 'PUT') {
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }

      const result = await handler({ req, res, url, body, pathname });
      // handler 返回 undefined 表示它自己已经把响应写完了（如图片流）
      if (result === undefined) return undefined;
      return sendJson(res, result.status ?? 200, result.body ?? result);
    }

    return this._serveStatic(pathname, res);
  }

  /** 带路径参数的路由（如 /api/traces/:id）用前缀匹配 */
  _matchPrefix(method, pathname) {
    for (const [key, handler] of this.routes) {
      if (!key.endsWith('*')) continue;
      const [m, prefix] = key.slice(0, -1).split(' ');
      if (m === method && pathname.startsWith(prefix)) return handler;
    }
    return null;
  }

  _serveStatic(pathname, res) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const resolved = path.resolve(this.publicDir, rel);

    // 目录穿越防护：解析后的路径必须还在 public/ 里
    const relative = path.relative(this.publicDir, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return sendJson(res, 404, { error: 'not found' });
    }

    const type = MIME[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    fs.createReadStream(resolved).pipe(res);
    return undefined;
  }
}

/** 把各 API 模块的路由合并成一张表 */
function buildRoutes(deps) {
  const routes = new Map();
  const modules = [
    createDashboardApi(deps),
    createTracesApi(deps),
    createShadowApi(deps),
    createAffectionApi(deps),
    createMemesApi(deps),
    createSandboxApi(deps),
    createConfigApi(deps),
    createHostApi(deps),
    createPortrayalApi(deps),
    createPluginsConfigApi(deps),
  ];
  for (const mod of modules) {
    for (const [key, handler] of Object.entries(mod)) {
      if (routes.has(key)) throw new Error(`面板路由冲突: ${key}`);
      routes.set(key, handler);
    }
  }
  return routes;
}

export function sendJson(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`请求体超过 ${MAX_BODY_BYTES} 字节上限`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error(`请求体不是合法 JSON: ${e.message}`));
      }
    });
    req.on('error', reject);
  });
}
