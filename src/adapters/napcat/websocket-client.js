/**
 * adapters/napcat/websocket-client.js — NapCat WebSocket 生命周期
 *
 * 与旧 Bridge 的差异：
 *   旧实现 `setTimeout(connect, 3000)` 恒定 3 秒重连（bridge.js:1812）。
 *   NapCat 长时间不可用时，日志里刷出成千上万行 ECONNREFUSED
 *   （events.jsonl 里现存大量 websocket_error/websocket_disconnected 对）。
 *   这里改为指数退避 1s→60s，并且"原因未变"时降级日志级别，只在原因变化
 *   或到达告警间隔时才打 ERROR —— 与 preflight 治好 43614 行刷屏的思路一致。
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export class NapcatWebSocketClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.wsUrl
   * @param {string} [opts.accessToken]
   * @param {number} [opts.minBackoffMs=1000]
   * @param {number} [opts.maxBackoffMs=60000]
   * @param {import('../../core/logger.js').Logger} [opts.logger]
   * @param {Function} [opts.WebSocketImpl] 便于测试注入
   */
  constructor(opts = {}) {
    super();
    this.wsUrl = opts.wsUrl;
    this.accessToken = opts.accessToken ?? '';
    this.minBackoffMs = opts.minBackoffMs ?? 1000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 60000;
    this.log = opts.logger?.child({ component: 'napcat-ws' }) ?? console;
    this.WebSocketImpl = opts.WebSocketImpl ?? WebSocket;
    this.alertEvery = opts.alertEvery ?? 10;

    this.ws = null;
    this.connected = false;
    this.stopping = false;
    this.backoff = this.minBackoffMs;
    this.reconnectCount = 0;
    this.attemptsSinceConnect = 0;
    this.lastFailureSignature = '';
    /** error 回调记下的原因，等 close 回调汇总成一行日志 */
    this._pendingErrorMessage = '';
    this._reconnectTimer = null;
  }

  connect() {
    if (this.stopping) return;
    this._clearReconnectTimer();

    const headers = this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {};
    let ws;
    try {
      ws = new this.WebSocketImpl(this.wsUrl, { headers });
    } catch (err) {
      this._scheduleReconnect(`构造失败: ${err.message}`);
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.backoff = this.minBackoffMs;
      this.attemptsSinceConnect = 0;
      this.lastFailureSignature = '';
      this.log.info('NapCat WebSocket 已连接', { wsUrl: this.wsUrl });
      this.emit('open');
    });

    ws.on('message', (data) => {
      let event;
      try {
        event = JSON.parse(data);
      } catch (err) {
        this.log.warn('NapCat 推送非 JSON，已丢弃', { error: err.message });
        return;
      }
      this.emit('event', event);
    });

    ws.on('close', (code, reason) => {
      const wasConnected = this.connected;
      this.connected = false;
      this.emit('close', { code, reason: String(reason ?? '') });
      if (wasConnected) this.reconnectCount++;
      // 一次断连只产出一行日志。error 先到、close 紧随其后，如果两个回调各记一次，
      // 签名会在「WebSocket 错误: X」和「连接关闭 code=1006」之间来回跳，
      // 去重永远命中不了 —— 那正是旧 Bridge 刷屏的形态（events.jsonl 里成对出现的
      // websocket_error / websocket_disconnected）。所以这里取更具体的那个原因。
      const cause = this._pendingErrorMessage
        ? `WebSocket 错误: ${this._pendingErrorMessage}`
        : `连接关闭 code=${code}`;
      this._pendingErrorMessage = '';
      this._scheduleReconnect(cause);
    });

    ws.on('error', (err) => {
      // 只记下原因交给 close 汇总，不在这里单独打日志（见上）。
      // 注意 'error' 在 EventEmitter 上有特殊语义：没有监听者时 emit 会**同步抛出**，
      // 把一次普通的 ECONNREFUSED 升级成进程级 uncaught exception，
      // 所以确有监听者才转发。
      this._pendingErrorMessage = err.message;
      if (this.listenerCount('error') > 0) this.emit('error', err);
    });
  }

  _scheduleReconnect(reason) {
    if (this.stopping) return;
    if (this._reconnectTimer) return;

    this.attemptsSinceConnect++;
    this._logFailure(reason);

    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.maxBackoffMs);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, wait);
    // 重连定时器不应该把进程钉在事件循环里（测试中尤其明显）
    if (typeof this._reconnectTimer.unref === 'function') this._reconnectTimer.unref();
  }

  /** 原因未变时压成 debug，只在原因变化或每 N 次时升级为 warn */
  _logFailure(signature) {
    if (signature !== this.lastFailureSignature) {
      this.log.warn('NapCat 连接中断，准备重连', {
        reason: signature,
        nextRetryMs: this.backoff,
        attempts: this.attemptsSinceConnect,
      });
      this.lastFailureSignature = signature;
    } else if (this.attemptsSinceConnect % this.alertEvery === 0) {
      this.log.error('NapCat 仍不可用，原因未变', {
        reason: signature,
        attempts: this.attemptsSinceConnect,
      });
    } else {
      this.log.debug('NapCat 重连中', { reason: signature, attempts: this.attemptsSinceConnect });
    }
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  /** 强制重连（供健康检查/运维接口调用） */
  reconnect() {
    this._clearReconnectTimer();
    this.backoff = this.minBackoffMs;
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
    } else {
      this.connect();
    }
  }

  close() {
    this.stopping = true;
    this._clearReconnectTimer();
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.connected = false;
  }
}
