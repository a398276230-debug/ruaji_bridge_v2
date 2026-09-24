/**
 * tests/integration/output-serialization.test.js — 缺陷一：主回复流与后台唤醒流
 * 对同一个 QQ 目标严格串行，气泡不再交错。
 *
 * 复现方式：让模型分三段慢速流出（第三段由测试闸门卡住），在回复流持有输出租约
 * 期间触发唤醒回推。断言：
 *   - 唤醒流这一跳必须让位（delivered=0，队列里没有通知正文）；
 *   - 回复三段在最终送达顺序里连续；
 *   - 回复整轮发完后租约释放，唤醒通知才在下一跳投递，且排在回复之后。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTestContainer, flush } from '../helpers.js';
import { createInboundMessage } from '../../src/contracts/messages.js';
import { TRIGGER_TYPES } from '../../src/contracts/capabilities.js';

const GROUP_SESSION = 'qq_group_777_20260922_1';
const LANE = 'group:777';
const NOW_MS = Date.now();
const sec = (offsetMs) => (NOW_MS + offsetMs) / 1000;

const notice = (proc = 'proc_abc123') =>
  `[IMPORTANT: Background process ${proc} completed normally (exit code 0).\nCommand: npm test\nOutput:\ndone]`;

function sessionRow(id, { messageCount = 0 } = {}) {
  return { id, source: 'api_server', message_count: messageCount, parent_session_id: null, archived: false };
}

function wakeMessages() {
  return [
    { id: 1, role: 'user', content: '<FavourContext>', timestamp: sec(-60000) },
    { id: 2, role: 'assistant', content: '在的', timestamp: sec(-59000) },
    { id: 3, role: 'user', content: notice(), timestamp: sec(-30000) },
    { id: 4, role: 'assistant', content: '**测试**跑完了，全绿。', timestamp: sec(-29000) },
  ].map((row) => ({ ...row, session_id: GROUP_SESSION }));
}

/**
 * 分三段流出、第三段被闸门卡住的模型：让"回复流持有输出租约"这件事在测试里可控。
 */
function makeGatedAdapter() {
  let open = null;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  const adapter = {
    calls: [],
    async generate(modelRequest, opts = {}) {
      adapter.calls.push(modelRequest);
      opts.onText?.('第一段文字内容。');
      await new Promise((r) => setTimeout(r, 10));
      opts.onText?.('第二段文字内容。');
      await gate;
      opts.onText?.('第三段文字内容。');
      return {
        responseId: 'resp-serialization',
        model: 'test',
        rawText: '第一段文字内容。第二段文字内容。第三段文字内容。',
        usage: { inputTokens: 0, outputTokens: 30 },
        latencyMs: 10,
      };
    },
    async resetSession() {
      return 'mock';
    },
    getSessionId() {
      return 'mock';
    },
    async ping() {
      return { ok: true };
    },
  };
  return { adapter, release: () => open?.() };
}

async function waitFor(fn, { timeoutMs = 3000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return fn();
}

test('缺陷一：唤醒通知不得插进回复分段之间（同目标严格串行）', async () => {
  const { adapter, release } = makeGatedAdapter();
  const container = buildTestContainer({
    modelAdapter: adapter,
    configOverrides: {
      wakeDelivery: { enabled: true },
      meme: { matcherEnabled: false },
    },
    routes: {
      'GET http://127.0.0.1:8642/api/sessions': () => ({
        body: { object: 'list', data: [sessionRow(GROUP_SESSION, { messageCount: 4 })] },
      }),
      [`GET http://127.0.0.1:8642/api/sessions/${encodeURIComponent(GROUP_SESSION)}/messages`]: () => ({
        body: { object: 'list', session_id: GROUP_SESSION, data: wakeMessages() },
      }),
    },
  });
  // 模拟"桥接已经在跑"：游标停在唤醒块之前（行 1-2 已消费），本跳才发现新通知
  container.wakeCursorStore.setCursor(GROUP_SESSION, 2, { messageCount: 2 });

  try {
    // 第一跳只做稳定性判定，不投递
    await container.wakeFlow.pollOnce();

    const inbound = createInboundMessage({
      correlationId: 'corr-serialization',
      messageId: 'msg-1',
      timestamp: Math.floor(NOW_MS / 1000),
      platform: 'qq',
      selfId: '398276230',
      userId: '10000001',
      groupId: '777',
      messageType: 'group',
      rawMessage: '@瑞姬 你好',
      text: '你好',
      content: ' @瑞姬 你好',
      sender: { nickname: '主人', displayName: '主人' },
      flags: { isAtBot: true, isOwner: true },
    });

    const replyPromise = container.replyFlow.run({
      inbound,
      triggerType: TRIGGER_TYPES.AT,
      contextBlocks: [],
      signal: null,
    });

    // 回复第一段已真正发出 → 回复流持有输出租约
    await waitFor(() => container.sender.dryRunLog.length >= 1);
    assert.equal(container.sessionSendQueue.isBusy(LANE), true, '回复流应当持有输出租约');

    // 唤醒流这一跳必须让位
    const deferredResult = await container.wakeFlow.pollOnce();
    await flush();
    assert.equal(deferredResult.delivered, 0, '回复流持锁期间唤醒通知必须让位');
    assert.ok(
      !container.sender.dryRunLog.some((e) => e.message.includes('测试跑完了')),
      '让位期间绝不能把通知插进回复分段',
    );

    // 放开模型第三段 → 回复发完 → 租约释放
    release();
    await replyPromise;
    await flush();
    assert.equal(container.sessionSendQueue.isBusy(LANE), false, '回复整轮发完后必须释放车道');

    // 下一跳才投递唤醒通知
    const deliveredResult = await container.wakeFlow.pollOnce();
    await flush();
    assert.equal(deliveredResult.delivered, 1, '让位后下一跳应当投递完成通知');

    const texts = container.sender.dryRunLog.map((e) => e.message);
    const replyIdxs = ['第一段文字内容', '第二段文字内容', '第三段文字内容'].map((s) =>
      texts.findIndex((t) => t.includes(s)),
    );
    const wakeIdx = texts.findIndex((t) => t.includes('测试跑完了'));
    assert.ok(replyIdxs.every((i) => i >= 0), `回复三段都应发出：${JSON.stringify(texts)}`);
    assert.ok(wakeIdx >= 0, `唤醒通知应当发出：${JSON.stringify(texts)}`);
    assert.deepEqual(
      replyIdxs,
      [replyIdxs[0], replyIdxs[0] + 1, replyIdxs[0] + 2],
      `回复分段必须连续，实际顺序：${JSON.stringify(texts)}`,
    );
    assert.ok(
      wakeIdx > Math.max(...replyIdxs),
      `唤醒通知必须排在回复之后，实际顺序：${JSON.stringify(texts)}`,
    );
  } finally {
    release(); // 兜底：测试失败时别让模型吊在闸门上
    container.cleanup();
  }
});
