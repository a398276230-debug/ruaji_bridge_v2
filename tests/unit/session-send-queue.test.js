/**
 * tests/unit/session-send-queue.test.js — 会话级输出排队互斥（缺陷一）
 *
 * 锁住的行为：
 *   1. 同一个 target 任意时刻只有一个租约（tryAcquire 失败 / acquire 排队）；
 *   2. 租约直到本轮消息**投递结算**才释放，后到的 flow 拿不到车道 —— 两轮分段
 *      在最终送达顺序上严格连续，不会交错；
 *   3. 不同 target 互不阻塞；
 *   4. 投递迟迟不结算时到点强制放行（不死锁）；
 *   5. 命令回执这类直发消息在车道被占时积压，等整轮发完再补发；
 *   6. 即时回执（enqueueImmediate）则绕过车道立刻入队，允许插进在途分段。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { EventBus } from '../../src/core/event-bus.js';
import { EVENTS, createEvent } from '../../src/contracts/events.js';
import { createOutboundMessage } from '../../src/contracts/messages.js';
import { SessionSendQueue, sendLaneKey } from '../../src/orchestration/session-send-queue.js';

const KEY = sendLaneKey({ type: 'group', id: '777' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));

function msg(text) {
  return createOutboundMessage({
    correlationId: `corr-${text}`,
    sessionId: 'qq:group:777',
    target: { type: 'group', id: '777' },
    text,
  });
}

function makeHarness({ timeoutMs = 2000 } = {}) {
  const eventBus = new EventBus({ defaultTimeoutMs: 500 });
  const sender = {
    queue: [],
    isSending: false,
    get pending() {
      return this.queue.length;
    },
    enqueue(m) {
      this.queue.push(m);
    },
  };
  const queue = new SessionSendQueue({ sender, eventBus, timeoutMs, pollIntervalMs: 5 });
  /** 手动"送达"队首（模拟 NapCat 返回 message_id 后 sender 发 message.sent） */
  const delivered = [];
  const deliverNext = async () => {
    const m = sender.queue.shift();
    if (!m) return null;
    delivered.push(m);
    await eventBus.publish(
      createEvent(EVENTS.MESSAGE_SENT, {
        correlationId: m.correlationId,
        sessionId: m.sessionId,
        payload: { txId: m.txId, status: 'success' },
      }),
    );
    await tick();
    return m;
  };
  return { queue, sender, eventBus, delivered, deliverNext };
}

test('sendLaneKey 兼容 OutboundMessage.target 与 wake 目标两种形状', () => {
  assert.equal(sendLaneKey({ type: 'group', id: '777' }), 'group:777');
  assert.equal(sendLaneKey({ messageType: 'private', id: 888 }), 'private:888');
});

test('同一目标：后到的 flow 必须等前一个 flow 全部投递完才拿得到车道', async () => {
  const h = makeHarness();
  const leaseA = await h.queue.acquire(KEY, { owner: 'reply' });
  leaseA.enqueue(msg('A1'));
  leaseA.enqueue(msg('A2'));

  assert.equal(h.queue.isBusy(KEY), true, 'A 持有期间车道必须被占');
  assert.equal(h.queue.tryAcquire(KEY, { owner: 'wake' }), null, 'WakeFlow 必须抢不到');

  let bLease = null;
  const bPromise = h.queue.acquire(KEY, { owner: 'wake' }).then((l) => {
    bLease = l;
    return l;
  });

  await h.deliverNext(); // A1 送达，但 A2 还在队列里
  await sleep(20);
  assert.equal(bLease, null, 'A 还没发完，B 不能拿到车道');

  const releaseA = leaseA.release();
  await h.deliverNext(); // A2 送达 → release 观察到 pending 归零 → 让位
  const leaseB = await bPromise;
  await releaseA;

  assert.equal(leaseB.held, true);
  // B 入队的消息必须排在 A 的后面，而不是插进 A1/A2 之间
  leaseB.enqueue(msg('B1'));
  leaseB.enqueue(msg('B2'));
  while (h.sender.queue.length) await h.deliverNext();
  await leaseB.release();

  assert.deepEqual(
    h.delivered.map((m) => m.text),
    ['A1', 'A2', 'B1', 'B2'],
    '两轮分段必须严格连续，禁止交错',
  );
});

test('不同目标互不阻塞', async () => {
  const h = makeHarness();
  const leaseGroup = await h.queue.acquire(KEY, { owner: 'reply' });
  const leasePrivate = await h.queue.acquire(sendLaneKey({ type: 'private', id: '888' }), {
    owner: 'wake',
  });
  assert.equal(leaseGroup.held, true);
  assert.equal(leasePrivate.held, true, '另一个目标应当立刻可用');
});

test('acquire 等待期间被中止：从队列摘除，不占用车道', async () => {
  const h = makeHarness();
  const leaseA = await h.queue.acquire(KEY, { owner: 'reply' });
  const controller = new AbortController();
  const pending = h.queue.acquire(KEY, { owner: 'wake', signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (err) => err.name === 'AbortError');

  leaseA.enqueue(msg('A1'));
  await h.deliverNext();
  await leaseA.release();
  assert.equal(h.queue.isBusy(KEY), false, '中止的等待者不得把车道卡住');
});

test('投递迟迟不结算 → 到点强制放行（不死锁）', async () => {
  const h = makeHarness({ timeoutMs: 60 });
  const lease = await h.queue.acquire(KEY, { owner: 'reply' });
  lease.enqueue(msg('A1')); // 故意不投递

  const startedAt = Date.now();
  await lease.release();
  assert.ok(Date.now() - startedAt >= 50, '必须真的等了一小会儿');
  assert.equal(h.queue.getStatus().timeouts, 1, '超时次数要记下来');
  assert.equal(h.queue.isBusy(KEY), false, '超时后必须放行');
});

test('直发积压：车道被占时不插队，等整轮发完再补发', async () => {
  const h = makeHarness();
  const leaseA = await h.queue.acquire(KEY, { owner: 'reply' });
  leaseA.enqueue(msg('A1'));
  leaseA.enqueue(msg('A2'));

  const immediate = h.queue.enqueue(KEY, msg('CMD'), { owner: 'command' });
  assert.equal(immediate, false, '车道被占应当积压而不是直接入队');
  assert.equal(h.queue.getStatus().backlog, 1);

  await h.deliverNext(); // A1
  const releaseA = leaseA.release();
  await h.deliverNext(); // A2 → 让位 → 补发积压
  await releaseA;
  while (h.sender.queue.length) await h.deliverNext();

  assert.deepEqual(
    h.delivered.map((m) => m.text),
    ['A1', 'A2', 'CMD'],
    '命令回执必须排在整轮回复之后',
  );
});

test('车道空闲时直发立即入队', async () => {
  const h = makeHarness();
  assert.equal(h.queue.enqueue(KEY, msg('CMD'), { owner: 'command' }), true);
  assert.equal(h.sender.queue.length, 1);
  await h.deliverNext();
});

test('即时直发：车道被占也立刻入队，不积压等整轮发完', async () => {
  const h = makeHarness();
  const leaseA = await h.queue.acquire(KEY, { owner: 'reply' });
  leaseA.enqueue(msg('A1'));
  leaseA.enqueue(msg('A2'));

  const ack = msg('ACK');
  assert.equal(h.queue.enqueueImmediate(KEY, ack, { owner: 'redirect-ack' }), true);
  assert.deepEqual(
    h.sender.queue.map((m) => m.text),
    ['A1', 'A2', 'ACK'],
    '即时回执必须立刻进 Sender（已在队列里的分段之前不能抢），而不是留在 backlog 里等整轮发完',
  );
  assert.equal(h.queue.getStatus().backlog, 0, '即时回执不许进 backlog');
  assert.equal(h.queue.getStatus().bypasses, 1, '绕过次数要可观测');
  assert.equal(ack.metadata.sendOwner, 'redirect-ack', '标注发送方便于排障');
  assert.equal(ack.metadata.sendLane, KEY);
  assert.equal(h.queue.isBusy(KEY), true, '即时直发不得干扰在途租约');

  await h.deliverNext(); // A1
  await h.deliverNext(); // A2
  await h.deliverNext(); // ACK
  await leaseA.release();
  assert.deepEqual(h.delivered.map((m) => m.text), ['A1', 'A2', 'ACK']);
  assert.equal(h.queue.isBusy(KEY), false, '即时回执不延长在途轮');
});

test('未提供 eventBus 时释放退化为"发送队列空闲即视为发完"', async () => {
  const sender = {
    queue: [],
    isSending: false,
    get pending() {
      return this.queue.length;
    },
    enqueue(m) {
      this.queue.push(m);
    },
  };
  const queue = new SessionSendQueue({ sender, timeoutMs: 500, pollIntervalMs: 5 });
  assert.equal(queue.tracked, false);
  const lease = await queue.acquire(KEY, { owner: 'reply' });
  lease.enqueue(msg('A1'));
  const release = lease.release();
  // 简单"送达"：清空队列
  sender.queue.length = 0;
  await release; // 不应当挂到超时
  assert.equal(queue.isBusy(KEY), false);
});
