/**
 * tests/integration/wake-cold-start.test.js — 缺陷二：重启冷启动不得翻旧账重发
 *
 * 场景：会话在，但 WakeCursorStore 里没有它的游标记录（全新部署 / 游标被裁掉 /
 * wake_cursors.json 丢失或损坏）。旧实现会从 0 行开扫，把重启前已完成的历史
 * 转述整段喷发到 QQ。现在改为：以当前 transcript 最新行号为基线，并把历史块的
 * 稳定去重键回填进 handled，只监听启动后落地的**新**完成通知。
 *
 * 覆盖：
 *   1. 无游标 + 历史唤醒块 → 一条都不发，游标推到最新行，稳定键/anchorKey 已回填；
 *   2. 基线建立之后新落地的通知照常投递；
 *   3. 冷启动不叫醒委派转述；之后新委派照常叫醒；
 *   4. Hermes 压缩重新分配行号后，冷启动时登记的历史块不会复活。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { buildTestContainer } from '../helpers.js';
import { MockModelAdapter } from '../../src/adapters/model/mock-model.js';

const GROUP_SESSION = 'qq_group_777_20260922_1';
const PRIVATE_SESSION = 'qq_private_888_20260922_1';
const NOW_MS = Date.now();
const sec = (offsetMs) => (NOW_MS + offsetMs) / 1000;

const notice = (proc = 'proc_abc123') =>
  `[IMPORTANT: Background process ${proc} completed normally (exit code 0).\nCommand: npm test\nOutput:\ndone]`;

function sessionRow(id, { messageCount = 0, parent = null } = {}) {
  return { id, source: 'api_server', message_count: messageCount, parent_session_id: parent, archived: false };
}

/** 一个可随 phase 变化的会话路由表 */
function routesFor({ sessionId, phase }) {
  return {
    'GET http://127.0.0.1:8642/api/sessions': () => ({
      body: { object: 'list', data: [sessionRow(sessionId, { messageCount: phase.count })] },
    }),
    [`GET http://127.0.0.1:8642/api/sessions/${encodeURIComponent(sessionId)}/messages`]: () => ({
      body: { object: 'list', session_id: sessionId, data: phase.rows },
    }),
  };
}

const withSession = (sessionId, rows) => rows.map((r) => ({ ...r, session_id: sessionId }));

async function pollTwice(container, opts) {
  await container.wakeFlow.pollOnce(opts);
  await container.wakeFlow.pollOnce(opts);
}

const sentText = (container) => container.sender.dryRunLog.map((e) => e.message).join('\n');

test('冷启动：无游标时不喷发历史转述，而是建立基线并回填稳定键', async () => {
  const phase = {
    count: 4,
    rows: withSession(GROUP_SESSION, [
      { id: 1, role: 'user', content: '<FavourContext>', timestamp: sec(-60000) },
      { id: 2, role: 'assistant', content: '在的', timestamp: sec(-59000) },
      { id: 3, role: 'user', content: notice('proc_hist01'), timestamp: sec(-30000) },
      { id: 4, role: 'assistant', content: '**历史**任务跑完了。', timestamp: sec(-29000) },
    ]),
  };
  const container = buildTestContainer({
    configOverrides: { wakeDelivery: { enabled: true } },
    routes: routesFor({ sessionId: GROUP_SESSION, phase }),
  });

  try {
    assert.equal(container.wakeCursorStore.getCursor(GROUP_SESSION), null, '前置：本来就没有游标');
    await pollTwice(container);

    assert.equal(container.sender.dryRunLog.length, 0, '冷启动绝不能把历史转述喷发到 QQ');

    const cursor = container.wakeCursorStore.getCursor(GROUP_SESSION);
    assert.equal(cursor.lastRowId, 4, '基线应当是当前 transcript 的最新行号');
    assert.equal(cursor.messageCount, 4);

    // 稳定键与行号去重键都已回填 —— 将来改写重分号也拦得住
    assert.equal(container.wakeCursorStore.isHandled(`${GROUP_SESSION}#3`), true);
    assert.equal(container.wakeCursorStore.isHandled(`${GROUP_SESSION}#proc_hist01`), true);
    assert.equal(container.health.state.wakeDelivery.coldStartSnapshot, 1);

    // 落盘检查：重启后游标仍在
    const persisted = JSON.parse(fs.readFileSync(container.wakeCursorStore.file, 'utf8'));
    assert.equal(persisted.cursors[GROUP_SESSION].lastRowId, 4);
    assert.ok(
      Object.keys(persisted.handled).includes(`${GROUP_SESSION}#proc_hist01`),
      '稳定键必须持久化',
    );
  } finally {
    container.cleanup();
  }
});

test('冷启动基线之后新落地的通知照常投递', async () => {
  const phase = {
    count: 4,
    rows: withSession(GROUP_SESSION, [
      { id: 1, role: 'user', content: '<FavourContext>', timestamp: sec(-60000) },
      { id: 2, role: 'assistant', content: '在的', timestamp: sec(-59000) },
      { id: 3, role: 'user', content: notice('proc_hist01'), timestamp: sec(-30000) },
      { id: 4, role: 'assistant', content: '历史任务跑完了。', timestamp: sec(-29000) },
    ]),
  };
  const container = buildTestContainer({
    configOverrides: { wakeDelivery: { enabled: true } },
    routes: routesFor({ sessionId: GROUP_SESSION, phase }),
  });

  try {
    await pollTwice(container);
    assert.equal(container.sender.dryRunLog.length, 0);

    // 启动之后：新任务完成，两条新行落进 transcript
    phase.rows = withSession(GROUP_SESSION, [
      ...phase.rows,
      { id: 5, role: 'user', content: notice('proc_new02'), timestamp: sec(1000) },
      { id: 6, role: 'assistant', content: '**新**任务也跑完了。', timestamp: sec(2000) },
    ]);
    phase.count = 6;

    await pollTwice(container);
    assert.equal(container.sender.dryRunLog.length, 1, '启动后的新通知必须照常投递');
    assert.match(sentText(container), /新任务也跑完了/);
    assert.equal(sentText(container).includes('历史任务'), false, '历史转述仍然不得补发');
  } finally {
    container.cleanup();
  }
});

test('冷启动不叫醒委派转述；之后新委派照常叫醒', async () => {
  const model = new MockModelAdapter({ replies: ['好的。'] });
  const phase = {
    count: 3,
    rows: withSession(PRIVATE_SESSION, [
      { id: 1, role: 'user', content: '<FavourContext>', timestamp: sec(-60000) },
      { id: 2, role: 'assistant', content: '在的', timestamp: sec(-59000) },
      {
        id: 3,
        role: 'user',
        content: '[ASYNC DELEGATION COMPLETE — deleg_hist01]\n--- RESULT ---\n历史报告',
        display_kind: 'async_delegation_complete',
        timestamp: sec(-30000),
      },
    ]),
  };
  const container = buildTestContainer({
    modelAdapter: model,
    configOverrides: { wakeDelivery: { enabled: true, delegationRelay: { graceMs: 0 } } },
    routes: routesFor({ sessionId: PRIVATE_SESSION, phase }),
  });

  try {
    await container.wakeFlow.pollOnce();
    await container.wakeFlow.pollOnce();
    assert.equal(model.calls.length, 0, '冷启动绝不能为历史委派完成行叫醒模型');
    assert.equal(container.sender.dryRunLog.length, 0);
    assert.equal(
      container.wakeCursorStore.isHandled(`${PRIVATE_SESSION}#deleg_hist01`),
      true,
      '历史委派的稳定键必须回填，否则将来改写会再叫醒一次',
    );

    // 启动之后新的委派完成行 → 照常叫醒一次
    phase.rows = withSession(PRIVATE_SESSION, [
      ...phase.rows,
      {
        id: 4,
        role: 'user',
        content: '[ASYNC DELEGATION COMPLETE — deleg_new02]\n--- RESULT ---\n新报告',
        display_kind: 'async_delegation_complete',
        timestamp: sec(1000),
      },
    ]);
    phase.count = 4;

    await container.wakeFlow.pollOnce();
    assert.equal(model.calls.length, 1, '新的委派完成行必须叫醒一次');
    assert.match(String(model.calls[0].messages[0].content), /deleg_new02/);
  } finally {
    container.cleanup();
  }
});

test('冷启动登记的历史块在 Hermes 压缩重分号后不会复活', async () => {  const SID = 'qq_private_3054039169_20260924_2_#02';
  const DELEG = '[ASYNC DELEGATION BATCH COMPLETE — deleg_34353c83]\n--- RESULT ---\n2000 字报告';
  const RELAY = '（内部机制提示，不需要回应这句话本身）子任务（deleg_34353c83）跑完了，请自行阅读上文并简要转述。';
  const REPLY = '搜图结论：没查到确凿出处。';

  const phase = {
    count: 3,
    rows: withSession(SID, [
      { id: 100, role: 'user', content: DELEG, display_kind: 'async_delegation_complete', timestamp: sec(-40000) },
      { id: 101, role: 'user', content: RELAY, display_kind: 'internal_notification', timestamp: sec(-39000) },
      { id: 102, role: 'assistant', content: REPLY, timestamp: sec(-38000) },
    ]),
  };
  const container = buildTestContainer({
    configOverrides: { wakeDelivery: { enabled: true } },
    routes: routesFor({ sessionId: SID, phase }),
  });

  try {
    // 冷启动：整段历史被登记为已处理，但一条都不发
    await pollTwice(container);
    assert.equal(container.sender.dryRunLog.length, 0, '冷启动不得投递历史转述');
    assert.equal(container.wakeCursorStore.isHandled(`${SID}#deleg_34353c83`), true);

    // Hermes 压缩：行号整体 +70，提示词行被合并进委派行（锚点变成 171）
    phase.rows = withSession(SID, [
      { id: 170, role: 'user', content: DELEG, display_kind: 'async_delegation_complete', timestamp: sec(-40000) },
      { id: 171, role: 'assistant', content: REPLY, timestamp: sec(-38000) },
    ]);
    phase.count = 2;

    await pollTwice(container);
    assert.equal(
      container.sender.dryRunLog.length,
      0,
      `改写重分号后冷启动登记的历史块不得复活，实际 ${container.sender.dryRunLog.length} 条`,
    );
  } finally {
    container.cleanup();
  }
});

test('coldStartSnapshot=false 时退回旧行为：无游标也会补发历史块（逃生开关）', async () => {
  const phase = {
    count: 4,
    rows: withSession(GROUP_SESSION, [
      { id: 1, role: 'user', content: '<FavourContext>', timestamp: sec(-60000) },
      { id: 2, role: 'assistant', content: '在的', timestamp: sec(-59000) },
      { id: 3, role: 'user', content: notice('proc_hist01'), timestamp: sec(-30000) },
      { id: 4, role: 'assistant', content: '**历史**任务跑完了。', timestamp: sec(-29000) },
    ]),
  };
  const container = buildTestContainer({
    configOverrides: { wakeDelivery: { enabled: true, coldStartSnapshot: false } },
    routes: routesFor({ sessionId: GROUP_SESSION, phase }),
  });
  try {
    await pollTwice(container);
    assert.equal(container.sender.dryRunLog.length, 1, '关掉冷启动保护后应当照旧补发');
    assert.match(sentText(container), /历史任务跑完了/);
  } finally {
    container.cleanup();
  }
});

test('冷启动基线用最新一页（order=latest），长 transcript 不会被截断成旧行', async () => {
  const filler = [];
  for (let id = 1; id <= 97; id++) {
    filler.push({
      id,
      role: id % 2 === 0 ? 'assistant' : 'user',
      content: id % 2 === 0 ? `闲聊${id}` : `<FavourContext>${id}`,
      timestamp: sec(-100000 + id * 100),
    });
  }
  const rows = withSession(GROUP_SESSION, [
    ...filler,
    { id: 98, role: 'user', content: notice('proc_page99'), timestamp: sec(-30000) },
    { id: 99, role: 'assistant', content: '分页任务跑完了。', timestamp: sec(-29000) },
    { id: 100, role: 'assistant', content: '收尾一句。', timestamp: sec(-28000) },
  ]);
  const requestedOrders = [];
  const container = buildTestContainer({
    configOverrides: { wakeDelivery: { enabled: true, messagePageLimit: 3 } },
    routes: {
      'GET http://127.0.0.1:8642/api/sessions': () => ({
        body: { object: 'list', data: [sessionRow(GROUP_SESSION, { messageCount: 100 })] },
      }),
      [`GET http://127.0.0.1:8642/api/sessions/${encodeURIComponent(GROUP_SESSION)}/messages`]: ({ url }) => {
        const order = url.searchParams.get('order');
        requestedOrders.push(order);
        const limit = Number(url.searchParams.get('limit')) || 500;
        const data = order === 'latest' ? rows.slice(-limit) : rows.slice(0, limit);
        return { body: { object: 'list', session_id: GROUP_SESSION, data } };
      },
    },
  });
  try {
    await container.wakeFlow.pollOnce();
    assert.equal(requestedOrders[0], 'latest', '冷启动基线必须请求最新一页');
    const cursor = container.wakeCursorStore.getCursor(GROUP_SESSION);
    assert.equal(cursor.lastRowId, 100, '基线必须是真正的末行，而不是最早一页的最大行');
    assert.equal(
      container.wakeCursorStore.isHandled(`${GROUP_SESSION}#proc_page99`),
      true,
      '最新一页里的唤醒块稳定键必须已登记',
    );
    assert.equal(container.sender.dryRunLog.length, 0, '冷启动仍然一条都不发');
  } finally {
    container.cleanup();
  }
});
