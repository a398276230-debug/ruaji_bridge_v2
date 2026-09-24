/**
 * tests/integration/wake-context-token.test.js — 「报告在上下文里只出现一次」回归测试
 *
 * 真实事故（2026-09-23 实测：原生报告正文 98582 字，旧提示词重复内嵌 78558 字）：
 * Hermes 原生已把整份子代理汇报以 display_kind=async_delegation_complete 的 user 行
 * 持久化进会话，桥接的唤醒轮又把整份报告当 {notice} 拼进提示词、再 POST 成新 user 消息。
 * Hermes 侧 `agent/agent_runtime_helpers.py: _merge_consecutive_users` 会把相邻的两条
 * user 行合并成 `prev + '\n\n' + next` 一条，于是**模型真正看到的上下文里同一份报告
 * 出现了两遍**，token 直接翻倍。
 *
 * 这里的断言不看单个函数，而是复现 Hermes 的合成规则，直接检查「模型看到的 user 正文」：
 * 报告必须且只能出现一次（来自原生行），唤醒提示词只允许是极简引用。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTestContainer, flush } from '../helpers.js';
import { MockModelAdapter } from '../../src/adapters/model/mock-model.js';

const PRIVATE_SESSION = 'qq_private_888_20260922_1';
const NOW_MS = Date.now();
const sec = (offsetMs) => (NOW_MS + offsetMs) / 1000;

/** 原生委派完成行（Hermes 写给 agent 的重注入信封，含整份报告） */
const RAW_REPORT = `INTERNAL REPORT: ${'细节'.repeat(1500)}`;
const NATIVE_ROW = {
  id: 3,
  role: 'user',
  content: `[ASYNC DELEGATION BATCH COMPLETE — deleg_57043573]\nA background fan-out unit you dispatched earlier.\n--- RESULT ---\n${RAW_REPORT}`,
  display_kind: 'async_delegation_complete',
  timestamp: sec(-30000),
};

function sessionRow(id, messageCount) {
  return { id, source: 'api_server', message_count: messageCount, parent_session_id: null, archived: false };
}

/** 复现 Hermes 的 user;user 合并：模型实际读到的一条 user 正文 */
const hermesMergeUsers = (prev, next) => (prev && next ? `${prev}\n\n${next}` : prev || next);

test('委派唤醒：模型上下文里原生报告只出现一次（token 不再翻倍）', async () => {
  const model = new MockModelAdapter({ replies: ['好的。'] });
  const rows = [
    { id: 1, role: 'user', content: '<FavourContext>', timestamp: sec(-60000) },
    { id: 2, role: 'assistant', content: '在的', timestamp: sec(-59000) },
    NATIVE_ROW,
  ];
  const container = buildTestContainer({
    modelAdapter: model,
    configOverrides: { wakeDelivery: { enabled: true, delegationRelay: { graceMs: 0 } } },
    routes: {
      'GET http://127.0.0.1:8642/api/sessions': () => ({
        body: { object: 'list', data: [sessionRow(PRIVATE_SESSION, 3)] },
      }),
      [`GET http://127.0.0.1:8642/api/sessions/${encodeURIComponent(PRIVATE_SESSION)}/messages`]: () => ({
        body: { object: 'list', session_id: PRIVATE_SESSION, data: rows },
      }),
    },
  });
  // 模拟"桥接已经在跑"：冷启动保护不给无游标会话投递历史块
  container.wakeCursorStore.setCursor(PRIVATE_SESSION, 2, { messageCount: 2 });

  try {
    await container.wakeFlow.pollOnce();
    await flush();
    assert.equal(model.calls.length, 1, '应当叫醒模型转述一次');

    const relayPrompt = model.calls[0].messages[0].content;
    // 模型真正看到的：原生报告行 + 唤醒提示词，被 Hermes 合并成同一条 user 消息
    const modelVisible = hermesMergeUsers(NATIVE_ROW.content, relayPrompt);
    const occurrences = modelVisible.split(RAW_REPORT).length - 1;

    assert.equal(occurrences, 1, `报告正文只能出现一次（实际 ${occurrences} 次）：原生行已提供，提示词不得复制`);
    assert.ok(
      relayPrompt.length < 300,
      `唤醒提示词必须是极简引用（当前 ${relayPrompt.length} 字；旧实现会把报告正文再灌一遍）`,
    );
    assert.match(relayPrompt, /deleg_57043573/, '极简提示带上 deleg id 做引用');
    assert.ok(
      modelVisible.length < NATIVE_ROW.content.length + 300,
      '上下文增量必须只是那句提示词，而不是又一份报告',
    );
  } finally {
    container.cleanup();
  }
});

// 判据自检：同样的计数方式必须能识别出「旧实现」的双份正文，否则上面的 === 1 就是空断言。
test('判据有效：旧式内嵌提示词会被计入两份', () => {
  const legacyPrompt = `（内部机制提示，不需要回应这句话本身）你之前派出的后台子任务已经跑完了，原始汇报如下：\n${NATIVE_ROW.content}`;
  const modelVisible = hermesMergeUsers(NATIVE_ROW.content, legacyPrompt);
  assert.equal(modelVisible.split(RAW_REPORT).length - 1, 2, '旧实现下报告确实在上下文里出现两次');
  assert.ok(
    modelVisible.length > NATIVE_ROW.content.length * 1.5,
    '旧实现下上下文长度接近翻倍（这正是要修掉的 token 膨胀）',
  );
});
