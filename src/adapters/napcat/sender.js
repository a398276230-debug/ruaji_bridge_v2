/**
 * adapters/napcat/sender.js — 发送队列与投递
 *
 * 迁移自 bridge.js:583-745 processSendQueue，保留全部已验证行为：
 *   - 单飞（同时只有一个在途投递），FIFO
 *   - 过旧消息（>10 分钟）归档不补发，防止重启后"几小时前的复读"
 *   - 重试上限 10 次 + 分档退避 2s/5s/10s，超限归档（防毒丸堵死队列）
 *   - "Timeout: NTEvent" 视为送达，不重试、不计失败、不触发熔断
 *   - 断路器打开时的主动拦截不累计失败（否则永远打不开）
 *   - 每 10 秒落盘一次队列
 *
 * 新增：
 *   - 发送事务 ID 幂等（验收标准 11）：同一 txId 只会真正投递一次
 *   - sendEnabled=false 时走 dry-run，记录但不打到 NapCat（影子模式的前提）
 *   - 每条消息发完发布 message.sent 事件（成功与失败都发）
 */

import { CircuitBreaker } from '../../core/circuit-breaker.js';
import { EVENTS, createEvent } from '../../contracts/events.js';
import { classifyError, countsAsFailure, CircuitOpenError } from '../../contracts/errors.js';
import { buildNapcatPayload } from './outbound-builder.js';

/** 重试退避分档，迁移自 bridge.js:621-626 */
export function retryDelayMs(retry) {
  if (retry > 10) return 30000;
  if (retry > 6) return 10000;
  if (retry > 3) return 5000;
  return 2000;
}

export class Sender {
  /**
   * @param {object} opts
   * @param {import('./napcat-api.js').NapcatApi} opts.napcatApi
   * @param {import('../../storage/send-queue-store.js').SendQueueStore} opts.store
   * @param {import('../../core/event-bus.js').EventBus} opts.eventBus
   * @param {import('../../core/idempotency-store.js').IdempotencyStore} opts.idempotency
   * @param {import('../../core/health-manager.js').HealthManager} [opts.health]
   * @param {import('../../core/logger.js').Logger} [opts.logger]
   * @param {object} opts.config
   */
  constructor(opts = {}) {
    this.api = opts.napcatApi;
    this.store = opts.store;
    this.eventBus = opts.eventBus;
    this.idempotency = opts.idempotency;
    this.health = opts.health ?? null;
    this.log = opts.logger?.child({ component: 'sender' }) ?? console;
    this.config = opts.config;

    this.queue = [];
    this.isSending = false;
    this.stopped = false;
    this.breaker = new CircuitBreaker('napcat-send', { threshold: 3, cooldownMs: 60000 });

    /** 拟人化延迟需要的上一条状态（由 typing-delay middleware 复核，这里只做保底节流） */
    this.lastSentAt = 0;
    this.minGapMs = opts.minGapMs ?? 400;

    this._persistTimer = null;
    /** dry-run 记录，影子模式与测试用 */
    this.dryRunLog = [];
  }

  start() {
    const { fresh } = this.store.load();
    this.queue.push(...fresh);
    this._persistTimer = setInterval(() => this.store.save(this.queue), 10000);
    if (typeof this._persistTimer.unref === 'function') this._persistTimer.unref();
    if (this.queue.length) this.pump();
  }

  stop() {
    this.stopped = true;
    if (this._persistTimer) clearInterval(this._persistTimer);
    this.store.save(this.queue);
  }

  /** 入队一条 OutboundMessage */
  enqueue(outbound) {
    this.queue.push(outbound);
    this.health?.update('queue', {
      size: this.queue.length,
      maxSize: Math.max(this.health.state.queue.maxSize, this.queue.length),
    });
    this.pump();
  }

  get pending() {
    return this.queue.length;
  }

  /** 某个会话 + 某个用户是否还有未发完的消息（强一致性时序保障用） */
  hasPendingFor(sessionId, replyToUserId) {
    return this.queue.some(
      (t) => t.sessionId === sessionId && (replyToUserId == null || t.replyToUserId === String(replyToUserId)),
    );
  }

  /** 启动一次泵送。不 await —— 队列是后台推进的。 */
  pump() {
    if (this.isSending || this.stopped || this.queue.length === 0) return;
    this.isSending = true;
    this._drain().finally(() => {
      this.isSending = false;
      if (this.queue.length && !this.stopped) setImmediate(() => this.pump());
    });
  }

  async _drain() {
    while (this.queue.length && !this.stopped) {
      const task = this.queue[0];

      // 过旧消息不补发
      const age = Date.now() - (task.metadata?.createdAt ?? Date.now());
      if (age > this.config.reply.maxSendAgeMs) {
        this.queue.shift();
        this.store.archive([task], '发送循环过期过滤');
        this.health?.increment('queue', 'failed');
        continue;
      }

      task.metadata.retry = (task.metadata.retry ?? 0) + 1;

      if (task.metadata.retry > this.config.reply.maxSendRetries) {
        this.log.warn('消息重试超限，归档并跳过', {
          txId: task.txId,
          retry: task.metadata.retry,
          correlationId: task.correlationId,
        });
        this.queue.shift();
        this.store.archive([task], `重试超限 (${task.metadata.retry} 次)`);
        this.health?.increment('queue', 'failed');
        this.health?.increment('messages', 'failed');
        await this._publishSent(task, { status: 'failed', error: '重试超限' });
        continue;
      }

      if (task.metadata.retry > 1) {
        await sleep(retryDelayMs(task.metadata.retry));
      }

      // 保底节流：拟人化延迟由 middleware 负责，这里只防止贴脸连发
      const gap = this.minGapMs - (Date.now() - this.lastSentAt);
      if (gap > 0) await sleep(gap);

      const outcome = await this._deliver(task);
      if (outcome.done) {
        this.queue.shift();
        this.health?.update('queue', { size: this.queue.length });
      }
      // outcome.done=false 时保留在队首，下一轮重试
    }
    this.store.save(this.queue);
  }

  async _deliver(task) {
    const payload = buildNapcatPayload(task);
    if (!payload) {
      // 脱 Markdown 后变成空白（例如纯分割线）——直接丢弃，不打给 NapCat
      this.log.debug('消息内容为空，跳过发送', { txId: task.txId });
      return { done: true };
    }

    // 幂等：同一发送事务只真正投递一次
    const idemKey = this.idempotency.buildKey('message.send', task.txId, 'napcat');
    if (!this.idempotency.claim(idemKey)) {
      this.log.warn('发送事务重复，已跳过', { txId: task.txId, correlationId: task.correlationId });
      return { done: true };
    }

    const startedAt = Date.now();

    if (!this.config.reply.sendEnabled) {
      // 影子/测试模式：走完整链路但不真正投递
      this.dryRunLog.push({
        txId: task.txId,
        correlationId: task.correlationId,
        sessionId: task.sessionId,
        isGroup: payload.isGroup,
        targetId: payload.targetId,
        message: payload.message,
        at: new Date().toISOString(),
      });
      this.log.info('dry-run：已生成但未发送', {
        txId: task.txId,
        correlationId: task.correlationId,
        target: `${payload.isGroup ? 'group' : 'private'}:${payload.targetId}`,
        body: this.log.body?.(payload.message) ?? `[len=${payload.message.length}]`,
      });
      await this._publishSent(task, { status: 'dry_run', latencyMs: 0 });
      return { done: true };
    }

    try {
      this.breaker.assertCanAttempt();

      const res = await this.api.sendMessage(payload);
      const latencyMs = Date.now() - startedAt;
      this.lastSentAt = Date.now();
      this.breaker.recordSuccess();
      this.health?.update('napcat', {
        lastSuccessAt: new Date().toISOString(),
        consecutiveFailures: 0,
      });
      this.health?.increment('queue', 'processed');
      this.health?.increment('messages', 'sent');

      if (res.status === 'nt_event_timeout') {
        // NTEvent 超时 ≠ 未送达：内核已发出，只是回调确认超时。
        // 按失败重试会导致群里复读，这是旧 Bridge 踩过的坑。
        this.log.warn('NapCat 回调超时 (NTEvent)，按已送达处理', {
          txId: task.txId,
          retry: task.metadata.retry,
        });
      }

      await this._publishSent(task, { status: 'success', replyId: res.messageId, latencyMs });
      return { done: true };
    } catch (err) {
      const classified = classifyError(err, task.correlationId);

      if (err instanceof CircuitOpenError) {
        // 主动拦截：既不算失败也不消费重试次数
        task.metadata.retry -= 1;
        this.log.warn('NapCat 断路器打开，发送暂缓', { txId: task.txId });
        this.idempotency.release(idemKey);
        await sleep(2000);
        return { done: false };
      }

      if (countsAsFailure(classified)) {
        this.breaker.recordFailure(classified);
        this.health?.increment('napcat', 'consecutiveFailures');
      }
      this.log.warn('推送失败，稍后重试', {
        txId: task.txId,
        retry: task.metadata.retry,
        correlationId: task.correlationId,
        error: classified.message,
      });
      // 允许重试：释放幂等占用，否则重试会被自己挡掉
      this.idempotency.release(idemKey);
      await sleep(2000);
      return { done: false };
    }
  }

  async _publishSent(task, result) {
    if (!this.eventBus) return;
    const isGroup = task.target?.type === 'group';
    const groupId = isGroup ? task.target?.id : null;
    const userId = isGroup ? (task.replyToUserId ?? null) : task.target?.id;
    this.eventBus.publish(
      createEvent(EVENTS.MESSAGE_SENT, {
        correlationId: task.correlationId,
        sessionId: task.sessionId,
        payload: {
          messageId: task.txId,
          txId: task.txId,
          target: task.target,
          text: task.text ?? '',
          groupId,
          userId,
          messageType: task.target?.type ?? (isGroup ? 'group' : 'private'),
          status: result.status,
          replyId: result.replyId ?? null,
          error: result.error ?? null,
          latencyMs: result.latencyMs ?? 0,
        },
      }),
    );
  }

  getStatus() {
    return {
      pending: this.queue.length,
      isSending: this.isSending,
      circuit: this.breaker.getStatus(),
      dryRunCount: this.dryRunLog.length,
    };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
