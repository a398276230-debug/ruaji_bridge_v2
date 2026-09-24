/**
 * tests/integration/wake-anchor.test.js — 异步完成通知自动引用派发消息（端到端）
 *
 * 链路：桥接回复发出 → NapCat 返回真实 message_id → sender 发 message.sent →
 *      ReplyAnchorTracker 记锚点 → 后台任务跑完 → wake-flow 投递完成通知时带上
 *      [CQ:reply,id=…] 引用气泡 → 锚点消费。
 *
 * 与 tests/unit/reply-anchor.test.js 的分工：单测管选段策略，这里管"装配真的接上了"、
 * "真实发送路径把字段透出来了"、"重启后锚点还在"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTestContainer } from '../helpers.js';
import { createOutboundMessage } from '../../src/contracts/messages.js';

const GROUP_SESSION = 'qq_group_777_20260922_1';
const CONTRACT_GROUP = 'qq:group:777';
const NOW_MS = Date.now();
const sec = (offsetMs) => (NOW_MS + offsetMs) / 1000;

function sessionRow(id, { messageCount = 0, parent = null } = {}) {
  return { id, source: 'api_server', message_count: messageCount, parent_session_id: parent, archived: false };
}

const notice = (proc = 'proc_abc123') =>
  `[IMPORTANT: Background process ${proc} completed normally (exit code 0).\nCommand: npm test\nOutput:\ndone]`;

function messages({ sessionId }) {
  return [
    { id: 1, role: 'user', content: '<FavourContext>\n用户:3054039169', timestamp: sec(-60000) },
    { id: 2, role: 'assistant', content: '在的', timestamp: sec(-59000) },
    { id: 3, role: 'user', content: notice(), display_kind: null, timestamp: sec(-30000) },
    { id: 4, role: 'assistant', content: '**测试**跑完了，全绿。', timestamp: sec(-29000) },
  ].map((row) => ({ ...row, session_id: sessionId }));
}

/** 唤醒通知要两跳稳定才结算投递 */
async function pollTwice(container) {
  await container.wakeFlow.pollOnce();
  await container.wakeFlow.pollOnce();
}

async function waitFor(fn, { timeoutMs = 3000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return fn();
}

/**
 * 真实发送路径的测试容器：sendEnabled=true，NapCat 桩每次回一个递增的真实
 * message_id，`sent` 收集实际打给 NapCat 的 message 字段（含 [CQ:reply,id=…]）。
 */
function buildRealSend({ wakeDelivery = { enabled: true }, storage } = {}) {
  const sent = [];
  let seq = 10000;
  const routes = {
    'GET http://127.0.0.1:8642/api/sessions': () => ({
      body: { object: 'list', data: [sessionRow(GROUP_SESSION, { messageCount: 4 })] },
    }),
    [`GET http://127.0.0.1:8642/api/sessions/${encodeURIComponent(GROUP_SESSION)}/messages`]: () => ({
      body: { object: 'list', session_id: GROUP_SESSION, data: messages({ sessionId: GROUP_SESSION }) },
    }),
    'POST http://127.0.0.1:3000/send_group_msg': ({ body }) => {
      sent.push(body.message);
      seq += 1;
      return { body: { status: 'ok', retcode: 0, data: { message_id: seq } } };
    },
  };
  const container = buildTestContainer({
    configOverrides: {
      wakeDelivery,
      reply: { sendEnabled: true },
      ...(storage ? { storage } : {}),
    },
    routes,
  });
  // 模拟"桥接已经在跑"：冷启动保护不会给无游标会话投递历史块，
  // 这里把游标放到唤醒块之前（行 1-2 已消费）
  container.wakeCursorStore.setCursor(GROUP_SESSION, 2, { messageCount: 2 });
  return { container, sent };
}

/** 造一条桥接发出的回复（模拟 reply-flow enqueue 出来的分段） */
function dispatchReply({ correlationId, text, isFirst = true, replyToUserId = '3054039169' }) {
  return createOutboundMessage({
    correlationId,
    sessionId: CONTRACT_GROUP,
    target: { type: 'group', id: '777' },
    replyToUserId,
    text,
    metadata: { isFirst },
  });
}

test('派发回复的真实 message_id 被记录；完成通知引用派发段，引用后清空锚点', async () => {
  const { container, sent } = buildRealSend();
  try {
    // 同一轮回复的两段：首段普通内容，第二段才是派发承诺 → 锚点应升级到第二段
    container.sender.enqueue(dispatchReply({ correlationId: 'turn-1', text: '让我先看看情况~' }));
    await waitFor(() => container.sender.pending === 0);
    assert.equal(container.wakeCursorStore.getAnchor(CONTRACT_GROUP).messageId, '10001');
    assert.equal(container.wakeCursorStore.getAnchor(CONTRACT_GROUP).matched, 'first');

    container.sender.enqueue(
      dispatchReply({ correlationId: 'turn-1', text: '已经派给 Pi 了，弄好叫你~', isFirst: false }),
    );
    await waitFor(() => container.sender.pending === 0);
    assert.equal(container.wakeCursorStore.getAnchor(CONTRACT_GROUP).messageId, '10002');
    assert.equal(container.wakeCursorStore.getAnchor(CONTRACT_GROUP).matched, 'dispatch');

    // 后台任务跑完 → 完成通知必须引用派发段 10002
    await pollTwice(container);
    await waitFor(() => sent.some((m) => m.includes('测试跑完了')));

    const noticeMsg = sent.find((m) => m.includes('测试跑完了'));
    assert.ok(noticeMsg, `应当发出完成通知，实际发出: ${JSON.stringify(sent)}`);
    assert.ok(
      noticeMsg.startsWith('[CQ:reply,id=10002]'),
      `完成通知应引用派发消息 10002，实际: ${noticeMsg}`,
    );

    // 引用一次即消费，后续无关通知不会再引用同一条
    assert.equal(container.wakeCursorStore.getAnchor(CONTRACT_GROUP), null);
    assert.equal(container.replyAnchorTracker.stats.consumed, 1);
  } finally {
    container.cleanup();
  }
});

test('锚点落盘：桥接重启后完成通知仍能引用重启前发出的派发消息', async () => {
  // 借一个容器的 tmpDir 当共享 cacheDir（与 wake-delivery 重启用例同一手法）
  const cacheDir = buildTestContainer({}).tmpDir;

  const first = buildRealSend({ storage: { cacheDir } });
  try {
    first.container.sender.enqueue(
      dispatchReply({ correlationId: 'turn-1', text: '已经派给 Pi 了，弄好叫你~' }),
    );
    await waitFor(() => first.container.sender.pending === 0);
    assert.equal(first.container.wakeCursorStore.getAnchor(CONTRACT_GROUP).messageId, '10001');
  } finally {
    first.container.cleanup();
  }

  // 模拟重启：同一 cacheDir 重建容器
  const second = buildRealSend({ storage: { cacheDir } });
  try {
    assert.equal(
      second.container.wakeCursorStore.getAnchor(CONTRACT_GROUP).messageId,
      '10001',
      '重启后锚点必须还在',
    );
    await pollTwice(second.container);
    const noticeMsg = second.sent.find((m) => m.includes('测试跑完了'));
    assert.ok(noticeMsg, '应当发出完成通知');
    assert.ok(
      noticeMsg.startsWith('[CQ:reply,id=10001]'),
      `重启后的通知应引用重启前的派发消息，实际: ${noticeMsg}`,
    );
    assert.equal(second.container.wakeCursorStore.getAnchor(CONTRACT_GROUP), null, '消费后也要清空');
  } finally {
    second.container.cleanup();
  }
});

test('没有锚点时完成通知不带引用（fail-open，不阻塞投递）', async () => {
  const { container, sent } = buildRealSend();
  try {
    await pollTwice(container);
    await waitFor(() => sent.some((m) => m.includes('测试跑完了')));
    const noticeMsg = sent.find((m) => m.includes('测试跑完了'));
    assert.ok(noticeMsg, '应当发出完成通知');
    assert.ok(!noticeMsg.includes('[CQ:reply'), `无锚点不得加引用段，实际: ${noticeMsg}`);
  } finally {
    container.cleanup();
  }
});

test('wakeDelivery.anchor.enabled=false：派发回复不记锚点，通知也不引用', async () => {
  const { container, sent } = buildRealSend({ wakeDelivery: { enabled: true, anchor: { enabled: false } } });
  try {
    container.sender.enqueue(
      dispatchReply({ correlationId: 'turn-1', text: '已经派给 Pi 了，弄好叫你~' }),
    );
    await waitFor(() => container.sender.pending === 0);
    assert.equal(container.wakeCursorStore.getAnchor(CONTRACT_GROUP), null, '关闭后不得记录锚点');

    await pollTwice(container);
    await waitFor(() => sent.some((m) => m.includes('测试跑完了')));
    const noticeMsg = sent.find((m) => m.includes('测试跑完了'));
    assert.ok(!noticeMsg.includes('[CQ:reply'), `关闭锚点后不得加引用段，实际: ${noticeMsg}`);
  } finally {
    container.cleanup();
  }
});
