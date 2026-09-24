/**
 * tests/unit/hermes-wake.test.js — Hermes transcript 解析器
 *
 * 这一段是整条异步唤醒链路的"信任边界"：Hermes 的行语义只在这里被解释，
 * 一旦解析错了，要么漏推（任务跑完没人知道），要么重复推（复读）。
 * 因此逐条钉住：会话 id → QQ 目标的还原、唤醒块的切分、游标推进、
 * 过期过滤、兜底提示、以及"未闭合块必须留在游标之后"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DELEGATION_DISPLAY_KIND,
  GENERIC_FALLBACK_SUMMARY,
  INTERNAL_NOTIFICATION_DISPLAY_KIND,
  delegationRefOf,
  extractDetachedDeliveries,
  isDelegationRow,
  isDetachedAnchorRow,
  isSummarizableNotice,
  noticeRefOf,
  parseSessionTarget,
  renderFallbackNotice,
  resolveSessionTarget,
  summarizeNotice,
  toEpochMs,
} from '../../src/adapters/hermes/wake-extractor.js';

/** Hermes 的 timestamp 是秒（浮点）；行号越大越新，整体贴近「现在」以免被 maxAgeMs 过滤 */
const NOW_BASE = Date.now() - 300_000; // 5 分钟前起算
const sec = (ms) => ms / 1000;

function userRow(id, content, extra = {}) {
  return { id, role: 'user', content, timestamp: sec(NOW_BASE + id * 1000), ...extra };
}
function assistantRow(id, content) {
  return { id, role: 'assistant', content, timestamp: sec(NOW_BASE + id * 1000) };
}
function toolRow(id) {
  return { id, role: 'tool', content: '{}', tool_name: 'terminal', timestamp: sec(NOW_BASE + id * 1000) };
}

const notice = (proc = 'proc_abc123', out = 'done') =>
  `[IMPORTANT: Background process ${proc} completed normally (exit code 0).\nCommand: npm test\nOutput:\n${out}]`;

test('parseSessionTarget 还原 executionKey（含日期 tag 与 /new 序号）', () => {
  assert.deepEqual(parseSessionTarget('qq_group_1076958977_20260922_1'), {
    messageType: 'group',
    id: '1076958977',
  });
  assert.deepEqual(parseSessionTarget('qq_private_3054039169_20260921_2_#03'), {
    messageType: 'private',
    id: '3054039169',
  });
  // 单轮转（无周期后缀）与一日多轮转都要能剥掉
  assert.deepEqual(parseSessionTarget('qq_private_3812655733_20260916'), {
    messageType: 'private',
    id: '3812655733',
  });
});

test('parseSessionTarget 对非桥接会话一律返回 null（fail closed）', () => {
  for (const bad of [
    '20260914_234612_4a819334', // CLI / TUI 会话
    'qq_group_123', // 没有日期 tag：形状不对，不猜
    'qq_group_abc_20260922_1', // 群号必须是数字
    'qq_channel_123_20260922_1', // 未知类型
    '',
    null,
  ]) {
    assert.equal(parseSessionTarget(bad), null, `应当拒绝: ${String(bad)}`);
  }
});

test('resolveSessionTarget 沿 parent_session_id 回溯（压缩/轮换后的子会话）', () => {
  const byId = new Map([
    ['qq_group_777_20260922_1#2', { id: 'qq_group_777_20260922_1#2', parent_session_id: 'qq_group_777_20260922_1' }],
    ['qq_group_777_20260922_1', { id: 'qq_group_777_20260922_1', parent_session_id: null }],
    ['20260914_234612_4a819334', { id: '20260914_234612_4a819334', parent_session_id: null }],
  ]);
  assert.deepEqual(resolveSessionTarget('qq_group_777_20260922_1#2', { byId }), {
    messageType: 'group',
    id: '777',
  });
  assert.equal(resolveSessionTarget('20260914_234612_4a819334', { byId }), null);
  // 祖先不在列表里（列表被 limit 截断）→ 认不出来就不认领
  assert.equal(resolveSessionTarget('qq_group_777_20260922_1#2', { byId: new Map() }), null);
});

test('isDetachedAnchorRow：display_kind 标记与信封前缀两种形状都认', () => {
  assert.equal(isDetachedAnchorRow({ role: 'user', content: notice(), display_kind: null }), true);
  assert.equal(
    isDetachedAnchorRow({ role: 'user', content: '随便什么', display_kind: INTERNAL_NOTIFICATION_DISPLAY_KIND }),
    true,
  );
  assert.equal(isDetachedAnchorRow({ role: 'user', content: '[CQ:at,qq=1] 你好' }), false);
  assert.equal(isDetachedAnchorRow({ role: 'assistant', content: notice() }), false);
});

test('唤醒块：信封行 + assistant 行 → 一条 wake 投递，游标推到最后一行', () => {
  const rows = [
    userRow(10, '<FavourContext>\n用户:1'),
    assistantRow(11, '好的'),
    userRow(12, notice()),
    assistantRow(13, '测试跑完了，全绿。'),
  ];
  const out = extractDetachedDeliveries(rows, {
    sessionId: 'qq_group_1_20260922_1', lastRowId: 0, emitOpenBlocks: true,
  });
  assert.equal(out.deliveries.length, 1);
  assert.equal(out.deliveries[0].kind, 'wake');
  assert.equal(out.deliveries[0].rowId, 12);
  assert.equal(out.deliveries[0].text, '测试跑完了，全绿。');
  assert.equal(out.deliveries[0].anchorKey, 'qq_group_1_20260922_1#12');
  assert.equal(out.nextRowId, 13);
  assert.equal(out.openBlock, null);
});

test('普通用户轮 + assistant 回复不会被误当成通知', () => {
  const rows = [userRow(1, '你好'), assistantRow(2, '在的'), toolRow(3)];
  const out = extractDetachedDeliveries(rows, { sessionId: 'qq_private_1_20260922_1' });
  assert.deepEqual(out.deliveries, []);
  assert.equal(out.nextRowId, 3);
});

test('未闭合的唤醒块：默认不投递，游标停在锚点之前（下一跳重读）', () => {
  const rows = [userRow(5, notice()), assistantRow(6, '正在处理…')];
  const held = extractDetachedDeliveries(rows, { sessionId: 's1' });
  assert.deepEqual(held.deliveries, []);
  assert.ok(held.nextRowId < 5, '游标必须停在锚点之前，否则块会被整块跳过');
  assert.equal(held.openBlock.anchorRowId, 5);
  assert.equal(held.openBlock.anchorKey, 's1#5');
  assert.equal(held.openBlock.partCount, 1);
  assert.equal(held.openBlock.at, toEpochMs(rows[0].timestamp), '块的时间取锚点行（信封行）的时间');

  const settled = extractDetachedDeliveries(rows, { sessionId: 's1', emitOpenBlocks: true });
  assert.equal(settled.deliveries.length, 1);
  assert.equal(settled.deliveries[0].text, '正在处理…');
  assert.equal(settled.nextRowId, 6);
});

test('未闭合且没有回复、超过 fallbackAfterMs → 兜底提示；未到点则继续等', () => {
  const rows = [userRow(7, notice('proc_zzz', 'boom'))];
  const at = toEpochMs(rows[0].timestamp);

  const waiting = extractDetachedDeliveries(rows, {
    sessionId: 's2', now: at + 1000, emitOpenBlocks: true, fallbackAfterMs: 600000,
    fallbackNotice: '没回复：{notice}',
  });
  assert.deepEqual(waiting.deliveries, []);
  assert.ok(waiting.openBlock, '还在等模型回复：不能结算，也不能把游标推过去');
  assert.equal(waiting.nextRowId, 0);

  const timedOut = extractDetachedDeliveries(rows, {
    sessionId: 's2', now: at + 700000, emitOpenBlocks: true, fallbackAfterMs: 600000,
    fallbackNotice: '没回复：{notice}',
  });
  assert.equal(timedOut.deliveries.length, 1);
  assert.equal(timedOut.deliveries[0].kind, 'fallback');
  assert.match(timedOut.deliveries[0].text, /^没回复：Background process proc_zzz/);
  assert.equal(timedOut.nextRowId, 7);
});

test('异步委派完成行绝不直接投递（内部 user 汇报行只作为转述锚点）', () => {
  const rows = [
    userRow(20, '🔀 后台委派完成：查到了 3 个结果', { display_kind: DELEGATION_DISPLAY_KIND }),
  ];
  const out = extractDetachedDeliveries(rows, { sessionId: 's3' });
  assert.deepEqual(out.deliveries, [], '内部 user 汇报行永不出现在 deliveries');
  assert.equal(out.delegations.length, 1, '要作为待转述锚点交出去，编排层才知道该叫醒模型');
  assert.equal(out.delegations[0].rowId, 20);
  assert.equal(out.delegations[0].anchorKey, 's3#20');
  assert.equal(out.delegations[0].text, '🔀 后台委派完成：查到了 3 个结果');
  assert.equal(out.openBlock.kind, 'delegation');
  assert.ok(out.nextRowId < 20, '游标停在锚点之前，等转述落地再整块结算');
});

test('委派完成行 + 唤醒轮锚点 + assistant 转述 → 只投递转述', () => {
  const rows = [
    userRow(21, '原始汇报：2000 字技术报告', { display_kind: DELEGATION_DISPLAY_KIND }),
    userRow(22, '[IMPORTANT: ignored]', { display_kind: INTERNAL_NOTIFICATION_DISPLAY_KIND }),
    assistantRow(23, '子任务跑完啦，结论是……'),
  ];
  const out = extractDetachedDeliveries(rows, { sessionId: 's3', emitOpenBlocks: true });
  assert.equal(out.deliveries.length, 1);
  assert.equal(out.deliveries[0].kind, 'wake');
  assert.equal(out.deliveries[0].rowId, 22, '投递锚点是唤醒轮的 user 行');
  assert.equal(out.deliveries[0].text, '子任务跑完啦，结论是……');
  assert.equal(
    out.deliveries.some((d) => d.text.includes('2000 字技术报告')),
    false,
    '原始汇报绝不能漏进 deliveries',
  );
  assert.deepEqual(out.delegations, [], '转述已经落地，不需要再唤醒');
});

test('委派完成行后直接跟 assistant 回复（上游若自己转述）→ 当作转述投递', () => {
  const rows = [
    userRow(24, '原始汇报', { display_kind: DELEGATION_DISPLAY_KIND }),
    assistantRow(25, '转述一下：……'),
  ];
  const out = extractDetachedDeliveries(rows, { sessionId: 's3', emitOpenBlocks: true });
  assert.equal(out.deliveries.length, 1);
  assert.equal(out.deliveries[0].kind, 'wake');
  assert.equal(out.deliveries[0].rowId, 24, '锚点是委派完成行本身');
  assert.equal(out.deliveries[0].text, '转述一下：……');
  assert.deepEqual(out.delegations, []);
});

test('委派完成行等不到转述 → 兜底提示（绝不退化成原样推送）', () => {
  const rows = [
    userRow(26, '[ASYNC DELEGATION COMPLETE — deleg_1]\n--- RESULT ---\n2000 字报告', {
      display_kind: DELEGATION_DISPLAY_KIND,
    }),
  ];
  const at = toEpochMs(rows[0].timestamp);
  const out = extractDetachedDeliveries(rows, {
    sessionId: 's3',
    now: at + 700000,
    emitOpenBlocks: true,
    fallbackAfterMs: 600000,
    fallbackNotice: '⚠️ 后台任务已结束，但瑞姬没能生成回复内容\n{notice}',
  });
  assert.equal(out.deliveries.length, 1);
  assert.equal(out.deliveries[0].kind, 'fallback');
  assert.match(out.deliveries[0].text, /^⚠️ 后台任务已结束/);
  assert.equal(out.deliveries[0].text.includes('2000 字报告'), false, '兜底提示不得捎带原始汇报');
  assert.equal(out.nextRowId, 26);
});

test('两条委派完成行紧挨着：前一条也登记为待转述，不静默丢掉', () => {
  const rows = [
    userRow(27, '汇报 A', { display_kind: DELEGATION_DISPLAY_KIND }),
    userRow(28, '汇报 B', { display_kind: DELEGATION_DISPLAY_KIND }),
  ];
  const out = extractDetachedDeliveries(rows, { sessionId: 's3' });
  assert.deepEqual(out.deliveries, []);
  assert.deepEqual(out.delegations.map((d) => d.rowId), [27, 28]);
});

test('isDelegationRow 只认 user 行 + 委派 display_kind', () => {
  assert.equal(isDelegationRow({ role: 'user', display_kind: DELEGATION_DISPLAY_KIND }), true);
  assert.equal(isDelegationRow({ role: 'assistant', display_kind: DELEGATION_DISPLAY_KIND }), false);
  assert.equal(isDelegationRow({ role: 'user', display_kind: null }), false);
});

test('isDelegationRow 在 display_kind 缺失时靠 [ASYNC DELEGATION 信封前缀兜底', () => {
  // 上游换了/丢了 display_kind 时，BATCH COMPLETE 这种行不能被漏判成普通 notice，
  // 否则内部汇报会在结算时被当成投递内容。
  assert.equal(
    isDelegationRow({ role: 'user', content: '[ASYNC DELEGATION BATCH COMPLETE — deleg_x]\n报告', display_kind: null }),
    true,
  );
  assert.equal(isDelegationRow({ role: 'user', content: '  [ASYNC DELEGATION COMPLETE — deleg_x]' }), true);
  assert.equal(isDelegationRow({ role: 'assistant', content: '[ASYNC DELEGATION COMPLETE — deleg_x]' }), false);
  assert.equal(isDelegationRow({ role: 'user', content: '[CQ:at,qq=1] 你好' }), false);
});

test('display_kind 缺失的 BATCH COMPLETE 行也只当转述锚点，绝不进 deliveries', () => {
  const rows = [userRow(60, '[ASYNC DELEGATION BATCH COMPLETE — deleg_9]\n--- RESULT ---\n2000 字报告')];
  const out = extractDetachedDeliveries(rows, { sessionId: 's7' });
  assert.deepEqual(out.deliveries, [], '内部汇报行绝不能进 deliveries');
  assert.deepEqual(out.delegations.map((d) => d.rowId), [60]);
  assert.equal(out.openBlock.kind, 'delegation');
});

test('delegationRefOf 只抠 deleg id，绝不返回报告正文', () => {
  assert.equal(delegationRefOf('[ASYNC DELEGATION BATCH COMPLETE — deleg_57043573]\n正文一大堆'), 'deleg_57043573');
  assert.equal(delegationRefOf('[ASYNC DELEGATION COMPLETE — deleg_abc123]\n--- RESULT ---'), 'deleg_abc123');
  assert.equal(delegationRefOf('没有 id 的报告'), '');
  assert.equal(delegationRefOf(null), '');
});

test('isSummarizableNotice：只有 [IMPORTANT: 进程信封可以摘正文', () => {
  assert.equal(isSummarizableNotice(notice()), true);
  assert.equal(isSummarizableNotice('[ASYNC DELEGATION BATCH COMPLETE — deleg_x]\n报告'), false);
  assert.equal(isSummarizableNotice('（内部机制提示，不需要回应这句话本身）…'), false);
  assert.equal(isSummarizableNotice(''), false);
});

test('兜底提示：桥接自投递提示词（internal_notification）不得被摘进 QQ 文案', () => {
  const relayPrompt = '（内部机制提示，不需要回应这句话本身）你之前派出的后台子任务已经跑完了，原始汇报如下。'
    + '请用你自己的口吻，把结论简要转述给对方：\n[ASYNC DELEGATION BATCH COMPLETE — deleg_1]\n2000 字报告';
  const rows = [userRow(61, relayPrompt, { display_kind: INTERNAL_NOTIFICATION_DISPLAY_KIND })];
  const at = toEpochMs(rows[0].timestamp);
  const out = extractDetachedDeliveries(rows, {
    sessionId: 's8',
    now: at + 700000,
    emitOpenBlocks: true,
    fallbackAfterMs: 600000,
    fallbackNotice: '⚠️ 后台任务已结束，但瑞姬没能生成回复内容\n{notice}',
  });
  assert.equal(out.deliveries.length, 1);
  assert.equal(out.deliveries[0].kind, 'fallback');
  assert.match(out.deliveries[0].text, /^⚠️ 后台任务已结束/);
  assert.equal(out.deliveries[0].text.includes('内部机制提示'), false, '内部提示词不得漏进 QQ');
  assert.equal(out.deliveries[0].text.includes('BATCH COMPLETE'), false, '内部信封不得漏进 QQ');
  assert.equal(out.deliveries[0].text.includes(GENERIC_FALLBACK_SUMMARY), true, '应当换成通用文案');
});

test('过旧的通知只推进游标、不投递（防重启后补发几小时前的旧结果）', () => {
  const rows = [userRow(30, notice()), assistantRow(31, '早就跑完了')];
  const at = toEpochMs(rows[1].timestamp);
  const out = extractDetachedDeliveries(rows, {
    sessionId: 's4', now: at + 3600_000, maxAgeMs: 1800_000, emitOpenBlocks: true,
  });
  assert.deepEqual(out.deliveries, []);
  assert.equal(out.nextRowId, 31);
});

test('两个唤醒块前后脚紧挨着：闭合行本身是新锚点时不能被游标吃掉', () => {
  const rows = [userRow(40, notice('proc_1')), assistantRow(41, '第一个好了'), userRow(42, notice('proc_2')), assistantRow(43, '第二个也好了')];
  const out = extractDetachedDeliveries(rows, { sessionId: 's5', emitOpenBlocks: true });
  assert.equal(out.deliveries.length, 2);
  assert.deepEqual(out.deliveries.map((d) => d.text), ['第一个好了', '第二个也好了']);
  assert.equal(out.nextRowId, 43);

  // 不结算时：第一个块（已被下一轮用户消息闭合）必须投递，第二个块留在游标之后
  const partial = extractDetachedDeliveries(rows, { sessionId: 's5', emitOpenBlocks: false });
  assert.deepEqual(partial.deliveries.map((d) => d.text), ['第一个好了']);
  assert.equal(partial.openBlock.anchorRowId, 42);
  assert.ok(partial.nextRowId < 42, '游标不能越过未消费的锚点');
});

test('只处理 id > lastRowId 的行（幂等：同一页重读不会重复投递）', () => {
  const rows = [userRow(50, notice()), assistantRow(51, '完成')];
  const out = extractDetachedDeliveries(rows, { sessionId: 's6', lastRowId: 51 });
  assert.deepEqual(out.deliveries, []);
  assert.equal(out.nextRowId, 51);
});

test('summarizeNotice / renderFallbackNotice 把信封洗成人能读的一行', () => {
  const text = notice('proc_abc', 'boom');
  assert.match(summarizeNotice(text), /^Background process proc_abc completed normally/);
  assert.equal(summarizeNotice(text).includes('[IMPORTANT:'), false);
  assert.equal(renderFallbackNotice(text, '⚠️ {notice}'), `⚠️ ${summarizeNotice(text)}`);
  // summarize=false：内部行（委派信封 / 自投递提示词）一律换成通用文案
  assert.equal(
    renderFallbackNotice('[ASYNC DELEGATION COMPLETE — deleg_1]\n2000 字报告', '⚠️ {notice}', { summarize: false }),
    `⚠️ ${GENERIC_FALLBACK_SUMMARY}`,
  );
});

test('toEpochMs 兼容秒与毫秒两种时间戳', () => {
  assert.equal(toEpochMs(1790000000.5), 1790000000500);
  assert.equal(toEpochMs(1790000000500), 1790000000500);
  assert.equal(toEpochMs(null), 0);
});

test('noticeRefOf：进程信封取 proc_，委派信封取 deleg_，取先出现的那个', () => {
  assert.equal(noticeRefOf(notice('proc_eb3c30df6b94')), 'proc_eb3c30df6b94');
  assert.equal(noticeRefOf('[ASYNC DELEGATION BATCH COMPLETE — deleg_34353c83]\n报告'), 'deleg_34353c83');
  // 进程信封正文里若附带 deleg 归属，主标识仍是开头的 proc
  assert.equal(noticeRefOf(`[IMPORTANT: Background process proc_1 completed.\nFrom deleg_2\nOutput:\nok]`), 'proc_1');
  assert.equal(noticeRefOf('普通内部提示，没有 id'), '');
  assert.equal(noticeRefOf(null), '');
});

test('stableKey/dedupKey 跨 transcript 改写（行号重分配）不变：同一委派转述绝不二次投递', () => {
  const SID = 'qq_private_3054039169_20260924_2_#02';
  const DELEG = '[ASYNC DELEGATION BATCH COMPLETE — deleg_34353c83]\n--- RESULT ---\n2000 字报告';
  const RELAY_PROMPT = '（内部机制提示，不需要回应这句话本身）你之前派出的后台子任务（deleg_34353c83）已经跑完了，请自行阅读上文并简要转述。';
  const REPLY = '刚才去全网把 SauceNAO、Google Lens 和 Yandex 全都扫了一遍，没查到确凿出处呢。';

  // 改写前：委派行 + 桥接自投递的唤醒提示词行 + 模型转述（投递锚点是提示词行）
  const before = extractDetachedDeliveries([
    userRow(64891, DELEG, { display_kind: DELEGATION_DISPLAY_KIND }),
    userRow(64892, RELAY_PROMPT, { display_kind: INTERNAL_NOTIFICATION_DISPLAY_KIND }),
    assistantRow(64893, REPLY),
  ], { sessionId: SID, emitOpenBlocks: true });
  assert.equal(before.deliveries.length, 1);
  assert.equal(before.deliveries[0].rowId, 64892);
  assert.equal(before.deliveries[0].anchorKey, `${SID}#64892`);

  // 改写后：Hermes 把整段重新分配 id（+69），自投递提示词行被合并进委派行
  const after = extractDetachedDeliveries([
    userRow(64961, DELEG, { display_kind: DELEGATION_DISPLAY_KIND }),
    assistantRow(64962, REPLY),
  ], { sessionId: SID, emitOpenBlocks: true });
  assert.equal(after.deliveries.length, 1);
  assert.equal(after.deliveries[0].rowId, 64961);
  assert.notEqual(after.deliveries[0].anchorKey, before.deliveries[0].anchorKey, '行号去重键确实变了（这就是历史重复投递的根因）');

  // 稳定键不变 → 编排层能拦住第二次投递；正文空白归一化也保证 \r\n 改写不影响
  assert.equal(after.deliveries[0].stableKey, before.deliveries[0].stableKey);
  assert.equal(after.deliveries[0].stableKey, `${SID}#deleg_34353c83`);
  assert.equal(after.deliveries[0].dedupKey, before.deliveries[0].dedupKey);
});

test('同一个进程的多次 watch_match：stableKey 相同但 dedupKey 不同，不能互相吞掉', () => {
  const SID = 'qq_group_1_20260922_1';
  const watch = (pattern, reply) => [
    userRow(1, `[IMPORTANT: Background process proc_same matched watch pattern "${pattern}".\nCommand: cmd\nMatched output:\n${pattern}]`),
    assistantRow(2, reply),
  ];
  const first = extractDetachedDeliveries(watch('ERROR', '抓到错误了'), { sessionId: SID, emitOpenBlocks: true });
  const second = extractDetachedDeliveries(watch('READY', '服务起来了'), { sessionId: SID, emitOpenBlocks: true });
  assert.equal(first.deliveries[0].stableKey, second.deliveries[0].stableKey, '同一个进程 → 稳定键相同');
  assert.notEqual(first.deliveries[0].dedupKey, second.deliveries[0].dedupKey, '正文不同 → 去重键必须不同');
});
