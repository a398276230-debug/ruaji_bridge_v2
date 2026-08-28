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
 *
 * 相对初版的加固：
 *   - 每消费一条立即落盘（store.save 原子写）。原来只靠 10 秒定时器，
 *     发送成功后 10 秒内崩溃会让重启补发已发出的消息——复读根因之二
 *   - 毒丸防护：处理单条消息时的任何意外异常都归档该消息并继续，
 *     绝不让队列陷入"抛错 → 重泵 → 再抛错"的热循环
 *   - 断路器打开时睡到冷却结束（分片睡眠保持可停止），不再固定 2s 空转刷屏
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
    this.breaker = new CircuitBreaker('napcat-send', {
      threshold: opts.breakerThreshold ?? 3,
      cooldownMs: opts.breakerCooldownMs ?? 60000,
    });

    /** 拟人化延迟需要的上一条状态（由 typing-delay middleware 复核，这里只做保底节流） */
    this.lastSentAt = 0;
    this.minGapMs = opts.minGapMs ?? 400;

    this._persistTimer = null;
    /** dry-run 记录，影子模式与测试用。环形截断，防止长跑内存无限增长 */
    this.dryRunLog = [];
    this.maxDryRunEntries = opts.maxDryRunEntries ?? 1000;
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
    // 双侧 String：队列从磁盘恢复时 replyToUserId 可能被 JSON 还原成数字
    return this.queue.some(
      (t) =>
        t.sessionId === sessionId &&
        (replyToUserId == null || String(t.replyToUserId) === String(replyToUserId)),
    );
  }

  /** 启动一次泵送。不 await —— 队列是后台推进的。 */
  pump() {
    if (this.isSending || this.stopped || this.queue.length === 0) return;
    this.isSending = true;
    this._drain()
      .catch((err) => {
        // _drain 已按条兜底，这里只防残余异常升级成 unhandledRejection
        this.log.error('发送队列异常退出', { error: err?.message ?? String(err) });
      })
      .finally(() => {
        this.isSending = false;
        if (this.queue.length && !this.stopped) setImmediate(() => this.pump());
      });
  }

  async _drain() {
    while (this.queue.length && !this.stopped) {
      const task = this.queue[0];
      try {
        const consumed = await this._processTask(task);
        if (consumed) {
          this.queue.shift();
          this.health?.update('queue', { size: this.queue.length });
          // 消费即落盘（原子写）：不等 10 秒定时器，否则窗口内崩溃会补发已发消息
          this.store.save(this.queue);
        }
      } catch (err) {
        // 毒丸防护：意外异常归档队首并继续。不这样做会变成
        // "抛错 → finally 重泵 → 同一条再抛" 的热循环，整个队列卡死。
        this.queue.shift();
        const reason = (err?.message ?? String(err)).slice(0, 200);
        this.log.error('处理消息时发生意外异常，已归档该消息', {
          txId: task?.txId ?? null,
          correlationId: task?.correlationId ?? null,
          error: reason,
        });
        this.store.archive([task], `意外异常: ${reason}`);
        this.health?.increment('queue', 'failed');
        this.health?.increment('messages', 'failed');
        await this._publishSent(task, { status: 'failed', error: '处理异常' });
        this.store.save(this.queue);
      }
    }
    this.store.save(this.queue);
  }

  /**
   * 处理队首消息。
   * @returns {Promise<boolean>} true = 已消费（应出队），false = 保留队首待重试
   */
  async _processTask(task) {
    if (!task.metadata) task.metadata = {};

    // 过旧消息不补发。缺 createdAt 的按过旧处理——与 send-queue-store.load
    // 的保守策略一致（宁可少发，不可复读）
    const createdAt = task.metadata.createdAt;
    const age = createdAt ? Date.now() - createdAt : Infinity;
    if (age > this.config.reply.maxSendAgeMs) {
      this.log.warn('消息过旧，归档不补发', {
        txId: task.txId,
        correlationId: task.correlationId,
        ageMs: Number.isFinite(age) ? age : null,
      });
      this.store.archive([task], '发送循环过期过滤');
      this.health?.increment('queue', 'failed');
      this.health?.increment('messages', 'failed');
      await this._publishSent(task, { status: 'failed', error: '消息过旧未发送' });
      return true;
    }

    task.metadata.retry = (task.metadata.retry ?? 0) + 1;

    if (task.metadata.retry > this.config.reply.maxSendRetries) {
      this.log.warn('消息重试超限，归档并跳过', {
        txId: task.txId,
        retry: task.metadata.retry,
        correlationId: task.correlationId,
      });
      this.store.archive([task], `重试超限 (${task.metadata.retry} 次)`);
      this.health?.increment('queue', 'failed');
      this.health?.increment('messages', 'failed');
      await this._publishSent(task, { status: 'failed', error: '重试超限' });
      return true;
    }

    if (task.metadata.retry > 1) {
      await sleep(retryDelayMs(task.metadata.retry));
    }

    // 保底节流：拟人化延迟由 middleware 负责，这里只防止贴脸连发
    const gap = this.minGapMs - (Date.now() - this.lastSentAt);
    if (gap > 0) await sleep(gap);

    return (await this._deliver(task)).done;
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
      if (this.dryRunLog.length >= this.maxDryRunEntries) this.dryRunLog.shift();
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
        this.log.warn('NapCat 断路器打开，发送暂缓', {
          txId: task.txId,
          nextRetryAt: new Date(err.nextRetryAt).toISOString(),
        });
        this.idempotency.release(idemKey);
        // 睡到冷却结束（分片睡眠保持可停止），而不是固定 2s 空转——
        // 60s 冷却里固定睡 2s 会空转 30 轮并刷 30 条重复警告。
        // 注意：这里不碰 breaker.canAttempt()，那个调用会把状态翻成
        // HALF_OPEN 并消费掉唯一一次探测资格，必须留给真正的 _deliver。
        const waitUntil = err.nextRetryAt ?? Date.now() + 2000;
        while (!this.stopped && Date.now() < waitUntil) {
          await sleep(Math.min(500, Math.max(waitUntil - Date.now(), 50)));
        }
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
    // 事件问题绝不能反过来影响队列判定：_deliver 成功路径也调它，
    // 一旦抛错会把"已送达"误判成失败并重发。这里整体兜底。
    try {
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
    } catch (err) {
      this.log.error('message.sent 事件发布失败', {
        txId: task?.txId ?? null,
        error: err?.message ?? String(err),
      });
    }
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
