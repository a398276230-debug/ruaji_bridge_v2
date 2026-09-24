/**
 * tests/integration/wake-delivery.test.js — 异步唤醒回推端到端
 *
 * 覆盖「Hermes 后台任务跑完 → 唤醒轮写回 transcript → 桥接轮询取回 → 进发送队列」
 * 这条链路本身，以及最容易被写错的几件事：
 *
 *   1. 一次唤醒只推一次（两跳稳定性判定 + anchorKey 去重 + 游标持久化）
 *   2. 桥接重启后不重复推送（游标与去重记录落盘）
 *   3. 关闭 wakeDelivery.enabled 时一次网络请求都不发
 *   4. 非桥接会话（CLI/TUI 的 api_server 会话）不被认领
 *   5. 过期太久的通知只推进游标、不推送
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { buildTestContainer, flush } from '../helpers.js';
import { MockModelAdapter } from '../../src/adapters/model/mock-model.js';
import { WakeCursorStore } from '../../src/storage/wake-cursor-store.js';

const GROUP_SESSION = 'qq_group_777_20260922_1';
const PRIVATE_SESSION = 'qq_private_888_20260922_1';
const NOW_MS = Date.now();

const sec = (offsetMs) => (NOW_MS + offsetMs) / 1000;

const notice = (proc = 'proc_abc123') =>
  `[IMPORTANT: Background process ${proc} completed normally (exit code 0).\nCommand: npm test\nOutput:\ndone]`;

function sessionRow(id, { messageCount = 0, parent = null } = {}) {
  return { id, source: 'api_server', message_count: messageCount, parent_session_id: parent, archived: false };
}

function messages({ sessionId, withReply = true }) {
  const rows = [
    { id: 1, role: 'user', content: '<FavourContext>\n用户:3054039169', timestamp: sec(-60000) },
    { id: 2, role: 'assistant', content: '在的', timestamp: sec(-59000) },
    { id: 3, role: 'user', content: notice(), display_kind: null, timestamp: sec(-30000) },
  ];
  if (withReply) {
    rows.push({ id: 4, role: 'assistant', content: '**测试**跑完了，全绿。', timestamp: sec(-29000) });
  }
  return rows.map((row) => ({ ...row, session_id: sessionId }));
}

function routesFor({ sessions, byId = {} }) {
  const routes = {
    'GET http://127.0.0.1:8642/api/sessions': () => ({ body: { object: 'list', data: sessions } }),
  };
  for (const [id, rows] of Object.entries(byId)) {
    // 客户端会 encodeURIComponent 会话 id（/new 轮换 id 带 #），桩表的键按同一形状构造
    routes[`GET http://127.0.0.1:8642/api/sessions/${encodeURIComponent(id)}/messages`] = () => ({
      body: { object: 'list', session_id: id, data: rows },
    });
  }
  return routes;
}

/** 唤醒通知可能被切句器拆成多段，断言时合起来看 */
const sentText = (container) => container.sender.dryRunLog.map((e) => e.message).join('\n');

async function pollTwice(container) {
  // 第一跳：唤醒块还没"稳定"，按契约不投递
  await container.wakeFlow.pollOnce();
  // 第二跳：内容不变 → 结算投递
  await container.wakeFlow.pollOnce();
  await flush();
}

/**
 * 模拟"桥接已经在跑"。冷启动保护（缺陷二）会给没有游标记录的会话建立基线、
 * 不投递任何历史块；所以这些测投递行为的用例要先把游标放到唤醒块出现之前，
 * 就像上一跳刚读完前几行一样。
 */
function seedRunningCursor(container, sessionId, lastRowId, messageCount) {
  container.wakeCursorStore.setCursor(sessionId, lastRowId, { messageCount });
}

test('后台任务完成 → 桥接取回唤醒回复并推给群聊（只推一次）', async () => {
  const container = buildTestContainer({
    configOverrides: { wakeDelivery: { enabled: true, maxAgeMs: 1800000 } },
    routes: routesFor({
      sessions: [sessionRow(GROUP_SESSION, { messageCount: 4 })],
      byId: { [GROUP_SESSION]: messages({ sessionId: GROUP_SESSION }) },
    }),
  });
  seedRunningCursor(container, GROUP_SESSION, 2, 2);

  try {
    assert.equal(container.wakeFlow.enabled, true);
    await pollTwice(container);

    const entries = container.sender.dryRunLog;
    assert.equal(entries.length, 1, `应当只投递一条，实际 ${entries.length}`);
    assert.equal(entries[0].isGroup, true);
    assert.equal(entries[0].targetId, '777');
    // response.notice 管线必须已经把 Markdown 脱掉
    assert.equal(sentText(container), '测试跑完了，全绿。');

    // 游标推到最后一行，并持久化
    const cursor = container.wakeCursorStore.getCursor(GROUP_SESSION);
    assert.equal(cursor.lastRowId, 4);
    assert.equal(cursor.messageCount, 4);
    const persisted = JSON.parse(fs.readFileSync(container.wakeCursorStore.file, 'utf8'));
    assert.equal(persisted.cursors[GROUP_SESSION].lastRowId, 4);
    assert.ok(Object.keys(persisted.handled).some((k) => k === `${GROUP_SESSION}#3`));

    // 再跑两跳：内容没变，message_count 也没变 → 一次请求都不该再读 transcript
    const before = container.fetchStub.callsTo(`/api/sessions/${GROUP_SESSION}/messages`).length;
    await container.wakeFlow.pollOnce({ now: NOW_MS + 5000 });
    await container.wakeFlow.pollOnce({ now: NOW_MS + 10000 });
    const after = container.fetchStub.callsTo(`/api/sessions/${GROUP_SESSION}/messages`).length;
    assert.equal(after, before, 'message_count 未变就不该重复读 transcript');
    assert.equal(container.sender.dryRunLog.length, 1, '不得复读');
  } finally {
    container.cleanup();
  }
});

test('桥接重启（进程内重建游标存储）后不重复推送', async () => {
  const cacheDir = buildTestContainer({}).tmpDir;
  const routes = routesFor({
    sessions: [sessionRow(GROUP_SESSION, { messageCount: 4 })],
    byId: { [GROUP_SESSION]: messages({ sessionId: GROUP_SESSION }) },
  });

  const first = buildTestContainer({
    configOverrides: { wakeDelivery: { enabled: true }, storage: { cacheDir } },
    routes,
  });
  seedRunningCursor(first, GROUP_SESSION, 2, 2);
  try {
    await pollTwice(first);
    assert.equal(first.sender.dryRunLog.length, 1);
  } finally {
    first.cleanup();
  }

  // 模拟重启：同一 cacheDir 重新构造 storage，游标与去重记录必须还在
  const store = new WakeCursorStore({ cacheDir });
  assert.equal(store.getCursor(GROUP_SESSION).lastRowId, 4);
  assert.equal(store.isHandled(`${GROUP_SESSION}#3`), true);

  const second = buildTestContainer({
    configOverrides: { wakeDelivery: { enabled: true }, storage: { cacheDir } },
    routes,
  });
  try {
    await pollTwice(second);
    assert.equal(second.sender.dryRunLog.length, 0, '重启后不得把已投递的通知再推一遍');
  } finally {
    second.cleanup();
  }
});

test('未启用 wakeDelivery 时完全不发请求', async () => {
  const container = buildTestContainer({
    configOverrides: { wakeDelivery: { enabled: false } },
    routes: routesFor({
      sessions: [sessionRow(GROUP_SESSION, { messageCount: 4 })],
      byId: { [GROUP_SESSION]: messages({ sessionId: GROUP_SESSION }) },
    }),
  });
  try {
    const out = await container.wakeFlow.pollOnce();
    assert.deepEqual(out, { sessions: 0, polled: 0, delivered: 0 });
    assert.equal(container.fetchStub.callsTo('/api/sessions').length, 0);
  } finally {
    container.cleanup();
  }
});

test('非桥接会话（没有 qq_ 前缀 / 形状不对）不被认领', async () => {
  const container = buildTestContainer({
    configOverrides: { wakeDelivery: { enabled: true } },
    routes: routesFor({
      sessions: [
        sessionRow('20260914_234612_4a819334', { messageCount: 4 }),
        sessionRow('qq_group_777', { messageCount: 4 }),
      ],
      byId: {
        '20260914_234612_4a819334': messages({ sessionId: '20260914_234612_4a819334' }),
        'qq_group_777': messages({ sessionId: 'qq_group_777' }),
      },
    }),
  });
  try {
    await pollTwice(container);
    assert.equal(container.sender.dryRunLog.length, 0);
    assert.equal(container.fetchStub.callsTo('/messages').length, 0, '不认识就不该读它的 transcript');
  } finally {
    container.cleanup();
  }
});

test('压缩/轮换后的子会话靠 parent_session_id 仍能投递到原目标', async () => {
  const childId = `${GROUP_SESSION}_#02`;
  const container = buildTestContainer({
    configOverrides: { wakeDelivery: { enabled: true } },
    routes: routesFor({
      sessions: [
        sessionRow(GROUP_SESSION, { messageCount: 9 }),
        sessionRow(childId, { messageCount: 4, parent: GROUP_SESSION }),
      ],
      byId: {
        [GROUP_SESSION]: [],
        [childId]: messages({ sessionId: childId }),
      },
    }),
  });
  seedRunningCursor(container, childId, 2, 2);
  try {
    await pollTwice(container);
    assert.equal(container.sender.dryRunLog.length, 1);
    assert.equal(container.sender.dryRunLog[0].targetId, '777');
  } finally {
    container.cleanup();
  }
});

test('过期通知只推进游标、不推送（防止重启后补发几小时前的旧结果）', async () => {
  const container = buildTestContainer({
    configOverrides: { wakeDelivery: { enabled: true, maxAgeMs: 60000 } },
    routes: routesFor({
      sessions: [sessionRow(GROUP_SESSION, { messageCount: 4 })],
      byId: { [GROUP_SESSION]: messages({ sessionId: GROUP_SESSION }) },
    }),
  });
  seedRunningCursor(container, GROUP_SESSION, 0, 0);
  try {
    // 把"当前时间"推到 1 小时之后：块早于 maxAgeMs，属于过期
    await container.wakeFlow.pollOnce({ now: NOW_MS + 3600_000 });
    await container.wakeFlow.pollOnce({ now: NOW_MS + 3600_000 });
    assert.equal(container.sender.dryRunLog.length, 0);
    assert.equal(container.wakeCursorStore.getCursor(GROUP_SESSION).lastRowId, 4, '游标仍要推到底');
  } finally {
    container.cleanup();
  }
});

test('唤醒轮没有产出回复 → 到点后推兜底提示', async () => {
  const container = buildTestContainer({
    configOverrides: {
      wakeDelivery: {
        enabled: true,
        fallbackAfterMs: 60000,
        fallbackNotice: '⚠️ 后台任务已结束，但瑞姬没能生成回复内容\n{notice}',
      },
    },
    routes: routesFor({
      sessions: [sessionRow(GROUP_SESSION, { messageCount: 3 })],
      byId: { [GROUP_SESSION]: messages({ sessionId: GROUP_SESSION, withReply: false }) },
    }),
  });
  seedRunningCursor(container, GROUP_SESSION, 2, 2);
  try {
    const later = NOW_MS + 120000;
    await container.wakeFlow.pollOnce({ now: later });
    await container.wakeFlow.pollOnce({ now: later });
    assert.ok(container.sender.dryRunLog.length >= 1, '应当投递兜底提示');
    assert.match(sentText(container), /^⚠️ 后台任务已结束，但瑞姬没能生成回复内容/);
    assert.match(sentText(container), /Background process proc_abc123/);
  } finally {
    container.cleanup();
  }
});

test('异步委派完成行不直推：桥接自投递唤醒轮，只推模型转述', async () => {
  const RAW_REPORT = 'INTERNAL REPORT: 2000 字技术报告正文';
  const model = new MockModelAdapter({ replies: ['好的。'] });
  const phases = {
    // 第一跳：Hermes 只落了委派完成行（写给 agent 的重注入信封）
    before: [
      { id: 1, role: 'user', content: '<FavourContext>', timestamp: sec(-60000) },
      { id: 2, role: 'assistant', content: '在的', timestamp: sec(-59000) },
      {
        id: 3,
        role: 'user',
        content: `[ASYNC DELEGATION COMPLETE — deleg_1]\n--- RESULT ---\n${RAW_REPORT}`,
        display_kind: 'async_delegation_complete',
        timestamp: sec(-30000),
      },
    ],
    // 桥接叫醒模型之后：唤醒轮的 user 行 + 模型的转述回复
    after: [
      { id: 1, role: 'user', content: '<FavourContext>', timestamp: sec(-60000) },
      { id: 2, role: 'assistant', content: '在的', timestamp: sec(-59000) },
      {
        id: 3,
        role: 'user',
        content: `[ASYNC DELEGATION COMPLETE — deleg_1]\n--- RESULT ---\n${RAW_REPORT}`,
        display_kind: 'async_delegation_complete',
        timestamp: sec(-30000),
      },
      { id: 4, role: 'user', content: '[IMPORTANT: ignored]', display_kind: 'internal_notification', timestamp: sec(-20000) },
      { id: 5, role: 'assistant', content: '**转述**：部署完成，一切正常。', timestamp: sec(-19000) },
    ],
  };

  const container = buildTestContainer({
    modelAdapter: model,
    configOverrides: { wakeDelivery: { enabled: true, delegationRelay: { graceMs: 0 } } },
    routes: {
      'GET http://127.0.0.1:8642/api/sessions': () => ({
        body: { object: 'list', data: [sessionRow(PRIVATE_SESSION, { messageCount: model.calls.length ? 5 : 3 })] },
      }),
      [`GET http://127.0.0.1:8642/api/sessions/${encodeURIComponent(PRIVATE_SESSION)}/messages`]: () => ({
        body: { object: 'list', session_id: PRIVATE_SESSION, data: model.calls.length ? phases.after : phases.before },
      }),
    },
  });
  seedRunningCursor(container, PRIVATE_SESSION, 2, 2);

  try {
    await container.wakeFlow.pollOnce(); // 第一跳：识别委派锚点 → 自投递唤醒轮
    await flush();
    assert.equal(model.calls.length, 1, '应当只叫醒一次');
    assert.equal(model.calls[0].generation.hermes_wake_turn, true, '唤醒轮必须带 hermes_wake_turn');
    assert.equal(model.calls[0].sessionKey, 'private_888', '必须投回同一个会话');
    assert.equal(model.calls[0].sessionOverrideId, PRIVATE_SESSION, '必须钉在读到完成行的那个会话 id 上');
    const relayPrompt = model.calls[0].messages[0].content;
    assert.equal(
      relayPrompt.includes('INTERNAL REPORT'),
      false,
      '报告正文不能二次灌进上下文：Hermes 原生那一条已经在了',
    );
    assert.equal(relayPrompt.includes('{notice}'), false, '提示词模板占位符必须被替换');
    assert.equal(relayPrompt.includes('{ref}'), false, '提示词模板占位符必须被替换');
    assert.match(relayPrompt, /deleg_1/, '极简提示里只带 deleg id 做引用');
    assert.ok(relayPrompt.length < 300, `唤醒提示词必须是极简提示，当前 ${relayPrompt.length} 字`);

    await container.wakeFlow.pollOnce(); // 第二跳：转述块还没稳定
    await container.wakeFlow.pollOnce(); // 第三跳：稳定 → 投递
    await flush();

    assert.equal(model.calls.length, 1, '转述落地后不得再重复叫醒');
    assert.equal(container.sender.dryRunLog.length, 1);
    assert.equal(container.sender.dryRunLog[0].targetId, '888');
    assert.equal(sentText(container), '转述：部署完成，一切正常。');
    assert.equal(sentText(container).includes('2000 字技术报告'), false, '内部汇报行绝不能推给 QQ');
  } finally {
    container.cleanup();
  }
});

test('两条委派完成行各只叫醒一次（不因反复闭合而重复唤醒）', async () => {
  const model = new MockModelAdapter({ replies: ['好的。'] });
  const rows = [
    { id: 1, role: 'user', content: '<FavourContext>', timestamp: sec(-60000) },
    { id: 2, role: 'assistant', content: '在的', timestamp: sec(-59000) },
    { id: 3, role: 'user', content: '[ASYNC DELEGATION COMPLETE — A]', display_kind: 'async_delegation_complete', timestamp: sec(-30000) },
    { id: 4, role: 'user', content: '[ASYNC DELEGATION COMPLETE — B]', display_kind: 'async_delegation_complete', timestamp: sec(-29000) },
  ];
  const container = buildTestContainer({
    modelAdapter: model,
    configOverrides: { wakeDelivery: { enabled: true, delegationRelay: { graceMs: 0 } } },
    routes: routesFor({
      sessions: [sessionRow(PRIVATE_SESSION, { messageCount: 4 })],
      byId: { [PRIVATE_SESSION]: rows },
    }),
  });
  seedRunningCursor(container, PRIVATE_SESSION, 2, 2);
  try {
    await container.wakeFlow.pollOnce();
    await flush();
    await container.wakeFlow.pollOnce();
    await container.wakeFlow.pollOnce();
    await flush();

    assert.equal(model.calls.length, 2, '两个锚点应各叫醒一次');
    assert.deepEqual(
      model.calls.map((c) => c.sessionOverrideId),
      [PRIVATE_SESSION, PRIVATE_SESSION],
    );
    assert.equal(container.sender.dryRunLog.length, 0, '没有转述回复就不应该推任何东西');
  } finally {
    container.cleanup();
  }
});

test('关掉 delegationRelay 时不叫醒模型，只推系统级兜底提示', async () => {
  const model = new MockModelAdapter({ replies: ['好的。'] });
  const rows = [
    { id: 1, role: 'user', content: '<FavourContext>', timestamp: sec(-120000) },
    {
      id: 2,
      role: 'user',
      content: '🔀 后台委派完成\nINTERNAL REPORT: 2000 字技术报告正文',
      display_kind: 'async_delegation_complete',
      timestamp: sec(-120000),
    },
  ];
  const container = buildTestContainer({
    modelAdapter: model,
    configOverrides: {
      wakeDelivery: {
        enabled: true,
        fallbackAfterMs: 60000,
        fallbackNotice: '⚠️ 后台任务已结束，但瑞姬没能生成回复内容\n{notice}',
        delegationRelay: { enabled: false },
      },
    },
    routes: routesFor({
      sessions: [sessionRow(PRIVATE_SESSION, { messageCount: 2 })],
      byId: { [PRIVATE_SESSION]: rows },
    }),
  });
  seedRunningCursor(container, PRIVATE_SESSION, 1, 1);
  try {
    await pollTwice(container);
    assert.equal(model.calls.length, 0, '关掉转述桥就不该叫醒模型');
    assert.ok(container.sender.dryRunLog.length >= 1, '应当投递系统级兜底提示');
    assert.match(sentText(container), /^⚠️ 后台任务已结束/);
    assert.equal(sentText(container).includes('INTERNAL REPORT'), false, '兜底提示不得携带原始汇报');
  } finally {
    container.cleanup();
  }
});

test('Hermes 管理 API 不可达时不抛异常，只记错误', async () => {
  const container = buildTestContainer({
    configOverrides: { wakeDelivery: { enabled: true } },
    routes: {}, // 没配路由 → fetch stub 抛 ECONNREFUSED
  });
  try {
    const out = await container.wakeFlow.pollOnce();
    assert.deepEqual(out, { sessions: 0, polled: 0, delivered: 0 });
    assert.ok(container.health.state.wakeDelivery.lastError);
    assert.equal(container.sender.dryRunLog.length, 0);
  } finally {
    container.cleanup();
  }
});

test('Hermes 压缩重分配行号后，已投递的委派转述不会被二次投递（真实事故回归）', async () => {
  const SID = 'qq_private_3054039169_20260924_2_#02';
  const DELEG = '[ASYNC DELEGATION BATCH COMPLETE — deleg_34353c83]\n--- RESULT ---\n2000 字报告';
  const RELAY = '（内部机制提示，不需要回应这句话本身）子任务（deleg_34353c83）跑完了，请自行阅读上文并简要转述。';
  const REPLY = '搜图结论：没查到确凿出处。';
  const withSession = (rows) => rows.map((r) => ({ ...r, session_id: SID }));

  // 改写前：委派行 + 自投递唤醒提示词行 + 转述回复（投递锚点是提示词行 64892）
  const before = withSession([
    { id: 64891, role: 'user', content: DELEG, display_kind: 'async_delegation_complete', timestamp: sec(-40000) },
    { id: 64892, role: 'user', content: RELAY, display_kind: 'internal_notification', timestamp: sec(-39000) },
    { id: 64893, role: 'assistant', content: REPLY, timestamp: sec(-38000) },
  ]);
  // 改写后：整段行号 +69，提示词行被合并进委派行（锚点变成 64961）
  const after = withSession([
    { id: 64961, role: 'user', content: DELEG, display_kind: 'async_delegation_complete', timestamp: sec(-40000) },
    { id: 64962, role: 'assistant', content: REPLY, timestamp: sec(-38000) },
  ]);

  let phase = { rows: before, count: 3 };
  const container = buildTestContainer({
    configOverrides: { wakeDelivery: { enabled: true } },
    routes: {
      'GET http://127.0.0.1:8642/api/sessions': () => ({
        body: { object: 'list', data: [sessionRow(SID, { messageCount: phase.count })] },
      }),
      [`GET http://127.0.0.1:8642/api/sessions/${encodeURIComponent(SID)}/messages`]: () => ({
        body: { object: 'list', session_id: SID, data: phase.rows },
      }),
    },
  });
  seedRunningCursor(container, SID, 0, 0);

  try {
    await pollTwice(container);
    assert.equal(container.sender.dryRunLog.length, 1, '改写前应当正常投递一次');
    assert.equal(sentText(container), REPLY);

    // Hermes 压缩：同一会话行号整体重分配，message_count 变化触发重扫
    phase = { rows: after, count: 2 };
    await pollTwice(container);
    assert.equal(
      container.sender.dryRunLog.length,
      1,
      `改写后不得把同一份委派转述再推一遍，实际 ${container.sender.dryRunLog.length} 条`,
    );
    // 稳定键已落盘：行号去重键（anchorKey）与稳定去重键都在
    assert.equal(container.wakeCursorStore.isHandled(`${SID}#deleg_34353c83`), true);
  } finally {
    container.cleanup();
  }
});
