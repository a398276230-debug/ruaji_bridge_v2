/**
 * app/lifecycle.js — 启动与关闭
 *
 * 三阶段启动（沿用旧 bridge.js:1825-1930 的分阶段思路）：
 *   阶段 1  preflight：依赖就绪检查，失败分级退避重试
 *   阶段 2  本地资源：插件注册、发送队列恢复、健康端点。失败即退出，不静默重试
 *   阶段 3  接入消息流
 *
 * 阶段 2 失败明确退出而非无限重试，是旧 Bridge 用血换来的教训：
 * 端口占用这类问题重试一万次也不会好，只会把真实原因埋在刷屏日志里。
 */

import net from 'node:net';
import { waitForDependencies } from './preflight.js';
import { ConfigError } from '../contracts/errors.js';

export class Lifecycle {
  /**
   * @param {object} container createContainer() 的产物
   * @param {{ skipPreflight?: boolean, maxPreflightAttempts?: number }} [opts]
   */
  constructor(container, opts = {}) {
    this.c = container;
    this.log = container.logger.child({ component: 'lifecycle' });
    this.opts = opts;
    this.lockServer = null;
    this.started = false;
    this._shutdownHandlers = [];
  }

  async start() {
    const { config } = this.c;

    const privateWhitelist = config.identity.privateWhitelist ?? [];
    this.log.info('RUAJI Bridge v2 启动中', {
      mode: config.mode,
      sendEnabled: config.reply.sendEnabled,
      sideEffectsEnabled: config.reply.sideEffectsEnabled,
      shadowForced: config._shadowForced === true,
      // 名单为空时除主人外所有私聊都会被丢弃，启动时就说清楚，别让人去猜
      privateWhitelist: privateWhitelist.length > 0
        ? `${privateWhitelist.length} 人放行 + 主人`
        : '仅主人（名单为空）',
    });

    // ===== 单实例锁 =====
    await this._acquireLock(config.health.lockPort);

    // ===== 阶段 1：preflight =====
    if (!this.opts.skipPreflight) {
      const { botId } = await waitForDependencies({
        config,
        logger: this.c.logger,
        napcatApi: this.c.napcatApi,
        modelRouter: this.c.modelRouter,
        maxAttempts: this.opts.maxPreflightAttempts ?? 0,
      });

      // 一致性校验：NapCat 实际登录号必须与配置一致，否则自身消息过滤与 @ 判定全失效
      if (botId && String(botId) !== String(config.identity.robotId)) {
        this.log.critical('配置不一致：NapCat 实际登录 QQ 与 identity.robotId 不符', {
          napcatBotId: botId,
          configuredRobotId: config.identity.robotId,
          impact: '自身消息过滤与群聊 @ 判定将失效',
        });
      }
    }

    // ===== 阶段 2：本地资源 =====
    try {
      this.c.pluginRegistry.loadFromConfig(config.plugins, config.pluginPolicy ?? {});
      this.c.sender.start();
      this.c.mem0Ingestor?.start();
      await this.c.health.listen(config.health.port);
      if (this.c.webServer) {
        await this.c.webServer.listen(config.web.port, config.web.host);
      }
    } catch (err) {
      this.log.critical('本地初始化失败（不可恢复，请人工处理）', {
        error: err.message,
        hint: `检查端口占用：health=${config.health.port} lock=${config.health.lockPort}`
          + (this.c.webServer ? ` web=${config.web.port}` : ''),
      });
      throw err;
    }

    // ===== 阶段 3：接入消息流 =====
    this.c.websocket.on('event', (event) => {
      this.c.health.update('websocket', { lastMessageAt: new Date().toISOString() });
      this.c.inboundFlow.handleEvent(event);
    });
    this.c.websocket.on('open', () => {
      this.c.health.update('websocket', { connected: true });
    });
    this.c.websocket.on('close', () => {
      this.c.health.update('websocket', {
        connected: false,
        reconnectCount: this.c.websocket.reconnectCount,
      });
    });
    // 必须订阅：'error' 没有监听者时 EventEmitter 会把它抛成 uncaught exception。
    // 顺手把原因喂给健康检查，运维接口才看得出是"连不上"还是"连上了不推消息"。
    this.c.websocket.on('error', (err) => {
      this.c.health.update('websocket', { lastError: err.message });
    });
    this.c.websocket.connect();

    this.started = true;
    this._installSignalHandlers();
    this.log.info('RUAJI Bridge v2 已就绪', {
      healthPort: config.health.port,
      webPanel: this.c.webServer ? `http://${config.web.host}:${config.web.port}/` : '(未启用)',
      plugins: this.c.pluginRegistry.list().filter((p) => p.enabled).map((p) => p.id),
    });
    return this;
  }

  /** 单实例锁：端口被占说明已有一个 v2 在跑，直接退出而不是抢 */
  _acquireLock(port) {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          reject(new ConfigError(`端口 ${port} 已被占用 — 可能已有一个 v2 实例在运行`));
        } else {
          reject(err);
        }
      });
      server.listen(port, '127.0.0.1', () => {
        this.lockServer = server;
        if (typeof server.unref === 'function') server.unref();
        resolve();
      });
    });
  }

  _installSignalHandlers() {
    const onSignal = (signal) => {
      this.log.info(`收到 ${signal}，正在关闭`, {});
      this.shutdown().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    };
    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));

    // 全局兜底：任何未捕获的问题都记下来，但不让进程静默死掉
    process.on('uncaughtException', (err) => {
      this.log.critical('未捕获异常', { error: err.message, stack: err.stack?.split('\n')[1] });
    });
    process.on('unhandledRejection', (reason) => {
      this.log.critical('未处理的 Promise rejection', { reason: String(reason) });
    });
  }

  async shutdown() {
    if (!this.started) return;
    this.started = false;

    // 顺序：先断消息流，再排空发送队列，最后落盘
    try { this.c.websocket.close(); } catch { /* ignore */ }
    this.c.sessionStore.clearAllTimers();
    try { this.c.sender.stop(); } catch { /* ignore */ }
    try { await this.c.mem0Ingestor?.stop(); } catch { /* ignore */ }
    try { this.c.affectionStore.flush(); } catch { /* ignore */ }
    try { this.c.portrayalStore.flush(); } catch { /* ignore */ }
    try { this.c.pluginRegistry.shutdown(); } catch { /* ignore */ }
    try { await this.c.webServer?.close(); } catch { /* ignore */ }
    try { await this.c.health.close(); } catch { /* ignore */ }
    if (this.lockServer) {
      await new Promise((resolve) => this.lockServer.close(resolve));
      this.lockServer = null;
    }

    for (const handler of this._shutdownHandlers) {
      try { await handler(); } catch { /* ignore */ }
    }
    this.log.info('已关闭', {});
  }

  onShutdown(handler) {
    this._shutdownHandlers.push(handler);
  }
}
