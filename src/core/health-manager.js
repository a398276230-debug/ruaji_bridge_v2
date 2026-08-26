/**
 * core/health-manager.js — 分层健康检查
 *
 * 三层，各自可独立查询：
 *   /health          进程层：存活、运行时长、内存、模式
 *   /health/deps     依赖层：NapCat WebSocket、NapCat HTTP、模型
 *   /health/plugins  插件层：可达性 + 熔断态
 *
 * 旧 Bridge 只有一个混在一起的 /health（http_server.js:142），
 * 插件不可用与模型不可用在同一个字段里，报警无法定位。
 */

import http from 'node:http';

export const HEALTH = Object.freeze({
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  CRITICAL: 'critical',
});

export class HealthManager {
  /**
   * @param {object} opts
   * @param {object} opts.config
   * @param {import('./logger.js').Logger} opts.logger
   * @param {import('./plugin-registry.js').PluginRegistry} [opts.pluginRegistry]
   */
  constructor(opts = {}) {
    this.config = opts.config;
    this.log = opts.logger?.child({ component: 'health' }) ?? console;
    this.pluginRegistry = opts.pluginRegistry ?? null;
    this.startedAt = Date.now();
    this.server = null;

    /** 由各组件在运行期更新 */
    this.state = {
      websocket: { connected: false, lastMessageAt: null, reconnectCount: 0, lastError: null },
      napcat: { lastSuccessAt: null, consecutiveFailures: 0 },
      model: { lastSuccessAt: null, consecutiveFailures: 0, totalRequests: 0, totalTimeouts: 0 },
      queue: { size: 0, maxSize: 0, processed: 0, failed: 0 },
      messages: { received: 0, replied: 0, ignored: 0, sent: 0, failed: 0 },
    };
  }

  /** 组件调用它更新状态，不直接改 this.state，便于日后加钩子 */
  update(section, patch) {
    Object.assign(this.state[section], patch);
  }

  increment(section, field, by = 1) {
    this.state[section][field] = (this.state[section][field] ?? 0) + by;
  }

  process() {
    const mem = globalThis.process.memoryUsage();
    const heapPercent = Math.round((mem.heapUsed / mem.heapTotal) * 100);
    return {
      status: heapPercent > 90 ? HEALTH.CRITICAL : heapPercent > 70 ? HEALTH.DEGRADED : HEALTH.HEALTHY,
      mode: this.config.mode,
      sendEnabled: this.config.reply.sendEnabled,
      sideEffectsEnabled: this.config.reply.sideEffectsEnabled,
      uptimeMs: Date.now() - this.startedAt,
      pid: globalThis.process.pid,
      memory: { heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, heapPercent },
      messages: { ...this.state.messages },
      queue: { ...this.state.queue },
    };
  }

  deps() {
    const ws = this.state.websocket;
    const model = this.state.model;
    let status = HEALTH.HEALTHY;
    if (!ws.connected) status = HEALTH.CRITICAL;
    else if (model.consecutiveFailures > 2 || this.state.napcat.consecutiveFailures > 2) {
      status = HEALTH.DEGRADED;
    }
    return {
      status,
      websocket: { ...ws },
      napcat: { ...this.state.napcat, httpUrl: this.config.napcat.httpUrl },
      model: { ...model, baseUrl: this.config.model.baseUrl, model: this.config.model.model },
    };
  }

  async plugins() {
    if (!this.pluginRegistry) return { status: HEALTH.HEALTHY, plugins: [] };
    const plugins = await this.pluginRegistry.health();
    const anyOpen = plugins.some((p) => p.circuits?.some((c) => c.state !== 'closed'));
    const anyUnreachable = plugins.some((p) => p.status === 'unreachable');
    return {
      // 插件全挂也只是 degraded——主回复链路不依赖任何单个插件
      status: anyOpen || anyUnreachable ? HEALTH.DEGRADED : HEALTH.HEALTHY,
      plugins,
      rejected: this.pluginRegistry.rejected,
    };
  }

  async overall() {
    const [proc, deps, plugins] = [this.process(), this.deps(), await this.plugins()];
    const ranks = { healthy: 0, degraded: 1, critical: 2 };
    const worst = [proc.status, deps.status, plugins.status].reduce(
      (a, b) => (ranks[b] > ranks[a] ? b : a),
      HEALTH.HEALTHY,
    );
    return { status: worst, process: proc, deps, plugins };
  }

  /**
   * 起一个只读 HTTP 端点。刻意不复用旧 Bridge 的 29998：
   * v2 与旧 Bridge 必须能同时运行（影子模式的前提）。
   */
  listen(port = this.config.health.port) {
    this.server = http.createServer(async (req, res) => {
      const send = (code, body) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(body, null, 2));
      };
      try {
        const pathname = new URL(req.url, 'http://localhost').pathname;
        if (req.method !== 'GET') return send(405, { error: 'method not allowed' });
        if (pathname === '/health') return send(200, this.process());
        if (pathname === '/health/deps') return send(200, this.deps());
        if (pathname === '/health/plugins') return send(200, await this.plugins());
        if (pathname === '/health/all') return send(200, await this.overall());
        return send(404, { error: 'not found' });
      } catch (e) {
        send(500, { error: e.message });
      }
    });

    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        this.log.info('健康检查端点已启动', { port });
        resolve(this.server);
      });
    });
  }

  async close() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }
}
