/**
 * orchestration/session-send-queue.js — 会话级输出排队互斥（SessionSendQueue）
 *
 * 解决什么：主回复流（ReplyFlow）与后台异步唤醒流（WakeFlow）会同时向**同一个
 * QQ 目标**投递切句分段。Sender 只是 FIFO 单飞，它保证"同一时刻只发一条"，
 * 但保证不了"同一轮的多条连续"：ReplyFlow 边流边发，segment1 已经出队后，
 * WakeFlow 的完成通知插进队列，ReplyFlow 的 segment2 又排在它后面 —— 群里的
 * 气泡就是这样被打乱成 [回复首段][后台通知][回复尾段] 的。
 *
 * 本模块提供**按目标串行**的发送租约（lease）：
 *   - 同一个 target（`group:777` / `private:888`）任意时刻最多只有一个租约；
 *   - 持有者（ReplyFlow / WakeFlow / 命令回执）用 `lease.enqueue(outbound)` 入队，
 *     租约直到**这一轮自己入队的消息全部投递结算**（message.sent 事件，覆盖
 *     success / dry_run / failed 终态）才释放；
 *   - 其它 flow 要么 `acquire()` 排队等它发完（严格串行），要么 `tryAcquire()`
 *     失败后把这一跳推迟到下一跳（WakeFlow 用，避免阻塞整个会话轮询循环）。
 *
 * 为什么按 target 而不是全局：不同群/私聊之间不该互相拖慢，锁粒度就是会话粒度。
 *
 * 为什么释放要等投递而不是等入队：入队只说明消息进了 Sender 的 FIFO，另一条 flow
 * 此时插进来仍会排在同一轮分段之间（这正是缺陷本身）。等到 message.sent 才释放，
 * 才真正做到"另一个 flow 必须等前一个 flow 完全发送完毕"。
 *
 * **唯一的例外是即时回执**（`enqueueImmediate`）：redirect ack 这类"告诉用户
 * 补充已生效"的提示，价值全在"生成还在跑的时候立刻可见"。它被压到整轮回复
 * 末尾就等于失效，所以刻意绕过租约直发 Sender —— 允许插进在途分段之间是有意
 * 为之，不属于上面要修的"分段被无关 flow 打乱"的缺陷。命令的内容型回执
 * （/好感度、/收集表情…）不走这条路，照旧积压等整轮发完。
 *
 * 降级：拿不到 eventBus 时无法确认终态，租约释放退化为"发送队列空闲即视为发完"
 * （Sender 暴露 pending / isSending；测试桩没有这两个属性时直接放行）。
 *
 * 超时：投递可能卡在重试/断路器冷却里，`timeoutMs` 到点强制放行并记一条 warn，
 * 只保证"不会永久互锁"，不保证这种情况下仍然零交错（需求允许"或超时"）。
 */

import { EVENTS } from '../contracts/events.js';

/**
 * 会话输出车道的键：同一 type + id 即同一目标。
 * 入参兼容 OutboundMessage.target（{type,id}）与 wake-extractor 的目标（{messageType,id}）。
 * @param {{type?: string, messageType?: string, id?: string|number}} target
 * @returns {string}
 */
export function sendLaneKey(target = {}) {
  const kind = target?.type ?? target?.messageType ?? 'unknown';
  const id = target?.id ?? '';
  return `${kind}:${id}`;
}

function abortError() {
  const err = new Error('发送租约等待被中止');
  err.name = 'AbortError';
  return err;
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * 一次目标独占。由 SessionSendQueue 授予，调用方 enqueue 完调用 release()。
 * 释放后不可再入队（enqueue 抛错），避免"忘了释放还继续发"把串行语义悄悄破坏。
 */
export class SendLease {
  constructor({ queue, key, owner, timeoutMs }) {
    this.queue = queue;
    this.key = key;
    this.owner = owner;
    this.timeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Number(timeoutMs)
      : queue.timeoutMs;
    this.granted = false;
    this.released = false;
    /** 本租约入队的消息条数（观测用） */
    this.enqueued = 0;
    /** 还没等到终态的条数（有 eventBus 时按 txId 精确计） */
    this.pending = 0;
    this.txIds = new Set();
  }

  /** @internal */
  _grant() {
    this.granted = true;
  }

  /** 是否仍然持有（可入队） */
  get held() {
    return this.granted && !this.released;
  }

  /** 入队一条本轮的出站消息。持有期间同步转发给 Sender，保持入队顺序。 */
  enqueue(outbound) {
    if (!this.held) {
      throw new Error(`发送租约已释放，拒绝入队 (lane=${this.key}, owner=${this.owner})`);
    }
    this.enqueued += 1;
    // 观测标注：面板/日志能看出某条出站消息属于哪条 flow。不覆盖调用方显式写的值。
    if (outbound?.metadata && outbound.metadata.sendOwner == null) {
      outbound.metadata.sendOwner = this.owner;
      outbound.metadata.sendLane = this.key;
    }
    const txId = outbound?.txId == null ? '' : String(outbound.txId);
    if (txId && this.queue.tracked) {
      this.pending += 1;
      this.txIds.add(txId);
      this.queue._track(txId, this);
    }
    this.queue.sender.enqueue(outbound);
  }

  /**
   * 等本轮消息投递结算，然后交出车道。**必须调用**（一般放 finally）。
   * @param {{timeoutMs?: number}} [opts]
   */
  async release(opts = {}) {
    if (this.released) return this;
    await this._waitDrained(opts.timeoutMs);
    this.released = true;
    this.granted = false;
    // 超时兜底：没等到终态的 txId 从全局索引摘掉，避免残留条目把后续消息误判成自己的
    for (const txId of this.txIds) this.queue.txIndex.delete(txId);
    this.txIds.clear();
    this.pending = 0;
    this.queue._release(this);
    return this;
  }

  /** @internal 收到一条 message.sent */
  _settle(txId) {
    if (!this.txIds.delete(String(txId))) return;
    this.pending -= 1;
  }

  /**
   * 轮询等投递终态。
   * 事件（message.sent）是主路径；Sender 完全空闲（队列空且不在途）也被视为发完，
   * 这样没有 eventBus 的降级部署/测试桩也不会把租约吊死。
   */
  async _waitDrained(timeoutMs) {
    if (this.pending <= 0) return;
    const ms = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : this.timeoutMs;
    if (!(ms > 0)) return;
    const deadline = Date.now() + ms;
    const pollMs = Math.max(10, Number(this.queue.pollIntervalMs) || 50);
    while (this.pending > 0) {
      if (this._senderIdle()) break;
      if (Date.now() >= deadline) {
        this.queue.stats.timeouts += 1;
        this.queue.log?.warn?.('发送租约等待投递完成超时，强制放行', {
          lane: this.key,
          owner: this.owner,
          pending: this.pending,
          timeoutMs: ms,
        });
        break;
      }
      await sleep(pollMs);
    }
  }

  _senderIdle() {
    const sender = this.queue.sender;
    if (!sender) return true;
    const pending = typeof sender.pending === 'number' ? sender.pending : 0;
    return pending === 0 && sender.isSending !== true;
  }
}

export class SessionSendQueue {
  /**
   * @param {object} opts
   * @param {import('../adapters/napcat/sender.js').Sender} opts.sender
   * @param {import('../core/event-bus.js').EventBus} [opts.eventBus]
   * @param {import('../core/logger.js').Logger} [opts.logger]
   * @param {number} [opts.timeoutMs=90000] 租约等待投递完成的硬上限
   * @param {number} [opts.pollIntervalMs=50]
   */
  constructor(opts = {}) {
    this.sender = opts.sender;
    this.log = opts.logger?.child?.({ component: 'session-send-queue' }) ?? opts.logger ?? console;
    const configured = Number(opts.timeoutMs);
    this.timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : 90000;
    this.pollIntervalMs = Number.isFinite(Number(opts.pollIntervalMs)) && Number(opts.pollIntervalMs) > 0
      ? Number(opts.pollIntervalMs)
      : 50;

    /** laneKey -> { busy, waiters: [], backlog: [] } */
    this.lanes = new Map();
    /** txId -> SendLease（终态结算用） */
    this.txIndex = new Map();
    this.unsubscribe = null;
    this.stats = { leases: 0, backlogged: 0, timeouts: 0, bypasses: 0 };

    if (opts.eventBus?.subscribe) {
      this.unsubscribe = opts.eventBus.subscribe(EVENTS.MESSAGE_SENT, 'session-send-queue', (envelope) => {
        try {
          this._onSent(envelope);
        } catch (err) {
          this.log?.warn?.('发送租约结算失败', { error: err?.message ?? String(err) });
        }
      });
    }
  }

  /** 是否有终态事件通道（false = 释放退化为"Sender 空闲即发完"） */
  get tracked() {
    return Boolean(this.unsubscribe);
  }

  detach() {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
  }

  /** 该目标当前是否被别的 flow 独占 */
  isBusy(key) {
    return Boolean(this.lanes.get(String(key))?.busy);
  }

  /**
   * 非阻塞获取：车道空闲就拿到租约，否则返回 null（调用方自己决定推迟还是排队）。
   * @returns {SendLease|null}
   */
  tryAcquire(key, { owner = 'unknown', timeoutMs } = {}) {
    const k = String(key);
    const lane = this._lane(k);
    if (lane.busy) return null;
    const lease = new SendLease({ queue: this, key: k, owner, timeoutMs });
    lane.busy = true;
    lease._grant();
    this.stats.leases += 1;
    return lease;
  }

  /**
   * 阻塞式获取：按到达顺序 FIFO 排队，等前一个租约释放后拿到。
   * 支持 AbortSignal：等待期间被打断则从队列摘除并 reject（AbortError）。
   * @returns {Promise<SendLease>}
   */
  acquire(key, { owner = 'unknown', timeoutMs, signal } = {}) {
    const k = String(key);
    const lane = this._lane(k);
    const lease = new SendLease({ queue: this, key: k, owner, timeoutMs });
    if (!lane.busy) {
      lane.busy = true;
      lease._grant();
      this.stats.leases += 1;
      return Promise.resolve(lease);
    }
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const waiter = { lease, resolve, reject, signal, onAbort: null };
      if (signal) {
        waiter.onAbort = () => {
          const idx = lane.waiters.indexOf(waiter);
          if (idx >= 0) lane.waiters.splice(idx, 1);
          reject(abortError());
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      lane.waiters.push(waiter);
    });
  }

  /**
   * 即时直发（redirect ack 这类"必须马上看见"的回执）：**无视车道占位**
   * 直接把消息交给 Sender。允许插进在途回复的分段之间 —— 这正是即时回执的
   * 语义（补充已生效要立刻告诉用户），它不是"别的 flow 来抢车道"。
   *
   * 不入队车道、不计数、不参与租约结算：既不延长在途轮，也不会留下 backlog。
   * @returns {boolean} 恒为 true（消息已交 Sender）
   */
  enqueueImmediate(targetKey, outbound, { owner = 'immediate' } = {}) {
    const k = String(targetKey);
    if (outbound?.metadata) {
      if (outbound.metadata.sendOwner == null) outbound.metadata.sendOwner = owner;
      if (outbound.metadata.sendLane == null) outbound.metadata.sendLane = k;
    }
    this.stats.bypasses += 1;
    this.sender.enqueue(outbound);
    return true;
  }

  /**
   * 一次性直发（命令回执这类单条消息）：车道空闲就立刻发；被占就先积压，
   * 等当前租约释放后紧接着发出去 —— 既不阻塞调用方（_reply 是同步的），
   * 也不插进别人的分段序列里。
   *
   * 需要"被占时也立刻发"的即时回执请用 `enqueueImmediate`。
   * @returns {boolean} true = 立即入队；false = 已积压，等当前轮发完
   */
  enqueue(targetKey, outbound, { owner = 'direct' } = {}) {
    const k = String(targetKey);
    const lane = this._lane(k);
    if (lane.busy) {
      lane.backlog.push({ outbound, owner });
      this.stats.backlogged += 1;
      return false;
    }
    const lease = this.tryAcquire(k, { owner });
    if (!lease) {
      // 理论上不会走到（上面刚判过车道空闲），保险起见当作积压。
      lane.backlog.push({ outbound, owner });
      this.stats.backlogged += 1;
      return false;
    }
    lease.enqueue(outbound);
    lease.release().catch(() => { /* release 自身不抛；防 unhandledRejection */ });
    return true;
  }

  /** 供面板/健康检查观察 */
  getStatus() {
    let lanes = 0;
    let busy = 0;
    let backlog = 0;
    for (const lane of this.lanes.values()) {
      lanes += 1;
      if (lane.busy) busy += 1;
      backlog += lane.backlog.length;
    }
    return { lanes, busy, backlog, trackedTx: this.txIndex.size, ...this.stats };
  }

  // ===== 内部 =====

  /** @internal */
  _lane(key) {
    const k = String(key);
    let lane = this.lanes.get(k);
    if (!lane) {
      lane = { busy: false, waiters: [], backlog: [] };
      this.lanes.set(k, lane);
    }
    return lane;
  }

  /** @internal */
  _track(txId, lease) {
    this.txIndex.set(String(txId), lease);
  }

  /** @internal */
  _onSent(envelope) {
    const txId = envelope?.payload?.txId;
    if (txId == null) return;
    const key = String(txId);
    const lease = this.txIndex.get(key);
    if (!lease) return;
    this.txIndex.delete(key);
    lease._settle(key);
  }

  /** @internal 交出车道：优先给排队者，否则空闲并补发积压 */
  _release(lease) {
    const lane = this.lanes.get(lease.key);
    if (!lane) return;
    while (lane.waiters.length > 0) {
      const waiter = lane.waiters.shift();
      if (waiter.onAbort && waiter.signal) waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal?.aborted) {
        waiter.reject(abortError());
        continue;
      }
      waiter.lease._grant();
      this.stats.leases += 1;
      waiter.resolve(waiter.lease);
      return; // 车道仍被新租约占用
    }
    lane.busy = false;
    if (lane.backlog.length > 0) {
      this._flushBacklog(lease.key);
      return;
    }
    this.lanes.delete(lease.key);
  }

  /** @internal 把等待期间积压的直发消息按原顺序发出去 */
  _flushBacklog(key) {
    const lane = this.lanes.get(key);
    if (!lane || lane.busy || lane.waiters.length > 0 || lane.backlog.length === 0) return;
    const items = lane.backlog.splice(0, lane.backlog.length);
    const lease = this.tryAcquire(key, { owner: 'backlog' });
    if (!lease) {
      // 极端竞态：车道又被抢走。放回队首，等下一次释放再补发。
      lane.backlog.unshift(...items);
      return;
    }
    for (const item of items) {
      try {
        lease.enqueue(item.outbound);
      } catch (err) {
        this.log?.warn?.('积压出站消息补发失败', { lane: key, error: err?.message ?? String(err) });
      }
    }
    lease.release().catch(() => { /* 同上：防 unhandledRejection */ });
  }
}
