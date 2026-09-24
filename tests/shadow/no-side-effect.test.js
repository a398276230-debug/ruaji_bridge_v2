/**
 * tests/shadow/no-side-effect.test.js
 *
 * 验收标准 14：影子模式无发送和持久化副作用。
 * 这一条不能只靠"我看代码里没写"，必须实测：跑完整链路后断言旧 Bridge 的
 * 数据文件 mtime 未变、没有任何 NapCat 请求打出去。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildTestContainer,
  loadFixture,
  seedAffection,
  seedMemes,
  flush,
  createFetchStub,
  TEST_ROOT,
} from '../helpers.js';
import { ShadowRecorder, parseLegacyDecisions, legacyRouteOf } from '../../src/shadow/comparator.js';
import { buildReport, formatReport, INTENTIONAL_DIFFS } from '../../src/shadow/report.js';
import { loadConfig } from '../../src/core/config.js';

async function settle(ms = 1200) {
  await new Promise((r) => setTimeout(r, ms));
  await flush();
}

test('shadow 模式强制关闭发送与副作用，即使配置写反了', () => {
  const config = loadConfig({
    rootDir: TEST_ROOT,
    file: 'bridge.config.example.json',
    env: { NAPCAT_ACCESS_TOKEN: 't', HERMES_API_KEY: 'k' },
    cliOverrides: {
      mode: 'shadow',
      reply: { sendEnabled: true, sideEffectsEnabled: true },
    },
  });

  assert.equal(config.reply.sendEnabled, false, '影子模式必须强制禁止发送');
  assert.equal(config.reply.sideEffectsEnabled, false);
  assert.equal(config._shadowForced, true, '强制降级应当留下痕迹');
});

test('影子模式跑完整链路：零发送请求，零数据文件改动', async (t) => {
  // 影子模式**允许**只读调用（例如 get_msg 拉引用原文），但绝不允许发送。
  const fetchImpl = createFetchStub({
    'POST http://127.0.0.1:3000/send_group_msg': () => { throw new Error('影子模式不得发送'); },
    'POST http://127.0.0.1:3000/send_private_msg': () => { throw new Error('影子模式不得发送'); },
    '*': () => ({ body: { status: 'ok', retcode: 0 } }),
  });
  const container = buildTestContainer({
    fetchImpl,
    replies: ['好的，我看看。\n\n改完重启就行。\n\n[AFF:+3|耐心排查]'],
    configOverrides: { mode: 'shadow', reply: { sendEnabled: false, sideEffectsEnabled: false } },
  });
  t.after(() => container.cleanup());

  const affectionFile = seedAffection(container.tmpDir, {
    2260757842: {
      nickname: '御娘狼三千',
      affection: 55,
      relationship: '熟络群友',
      interactions: 12,
      firstSeen: '2026-08-01T00:00:00.000Z',
      lastDay: '',
      lastDecay: Date.now(),
      recentDeltas: [],
    },
  });
  seedMemes(container.tmpDir, [{ id: 'm_1', tag: '摸鱼' }]);
  container.affectionStore.load();
  container.memeStore.load();

  const snapshot = (file) => ({ content: fs.readFileSync(file, 'utf8'), mtime: fs.statSync(file).mtimeMs });
  const before = {
    affection: snapshot(affectionFile),
    memes: snapshot(path.join(container.tmpDir, 'memes_data.json')),
  };

  await container.inboundFlow.handleEvent(loadFixture('group-reply-quote').event);
  await settle();
  container.affectionStore.flush();

  // 1. 一次发送请求都没有
  const sendCalls = fetchImpl.calls.filter((c) => c.url.includes('send_') && c.url.includes('_msg'));
  assert.deepEqual(sendCalls, [], '影子模式不得打任何 send_*_msg');

  // 2. 数据文件一字未改
  const after = {
    affection: snapshot(affectionFile),
    memes: snapshot(path.join(container.tmpDir, 'memes_data.json')),
  };
  assert.equal(after.affection.content, before.affection.content);
  assert.equal(after.affection.mtime, before.affection.mtime, 'affection.json mtime 必须未变');
  assert.equal(after.memes.content, before.memes.content);

  // 3. 但链路确实跑通了，产出了候选结果
  assert.ok(container.sender.dryRunLog.length > 0, '应当产出候选回复');
  assert.ok(
    container.logger.find('影子模式：好感度写入已抑制').length >= 1,
    '被抑制的副作用必须留下明确记录',
  );

  // 4. 没有留下任何 tmp 文件
  const strays = fs.readdirSync(container.tmpDir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(strays, []);
});

test('影子对照日志记录裁决与生成，格式符合附录 4', async (t) => {
  const container = buildTestContainer({
    replies: ['OK'],
    configOverrides: { mode: 'shadow' },
  });
  t.after(() => container.cleanup());

  const recorder = new ShadowRecorder({
    shadowDir: path.join(container.tmpDir, 'shadow'),
    config: container.config,
    logger: container.logger,
    enabled: true,
  });
  container.inboundFlow.shadow = recorder;

  await container.inboundFlow.handleEvent(loadFixture('group-at-bot').event);
  await settle();

  const decision = recorder.entries.find((e) => e.kind === 'decision');
  assert.ok(decision, '应当记录裁决');
  for (const field of ['correlationId', 'messageId', 'v2Decision', 'oldBridgeDecision', 'match']) {
    assert.ok(field in decision, `对照日志必须含 ${field}`);
  }
  assert.equal(decision.v2Decision, 'direct');
  assert.equal(decision.oldBridgeDecision, null, '旧 Bridge 的裁决由离线对账回填');

  const reply = recorder.entries.find((e) => e.kind === 'reply');
  assert.ok(reply, '应当记录生成');
  assert.ok(Array.isArray(reply.contextSources));

  // 落盘校验
  assert.ok(fs.existsSync(recorder.file));
  const lines = fs.readFileSync(recorder.file, 'utf8').trim().split('\n');
  assert.ok(lines.length >= 2);
  for (const line of lines) JSON.parse(line); // 必须是合法 JSONL
});

test('enabled=false 时对照器完全不写盘', (t) => {
  const container = buildTestContainer();
  t.after(() => container.cleanup());

  const dir = path.join(container.tmpDir, 'shadow-off');
  const recorder = new ShadowRecorder({ shadowDir: dir, config: container.config, logger: container.logger, enabled: false });
  recorder.record({
    inbound: {
      correlationId: 'c', messageId: 'm', sessionId: 's', userId: 'u', groupId: 'g',
      flags: { isAtBot: true, isNameCall: false, isOwner: false },
    },
    decision: { route: 'direct', reason: 'x' },
  });

  assert.equal(recorder.entries.length, 0);
  assert.ok(!fs.existsSync(dir));
});

test('能从旧 bridge.log 解析出裁决行', () => {
  const log = [
    '[2026/8/4 03:41:22] [INFO] [群消息] 忽略 | 真@=false 名字呼唤=false | 我平常都把瑞姬那个号当神秘垃圾桶',
    '[2026/8/23 05:47:11] [INFO] [群消息] 触发 | 真@=true 名字呼唤=false | 我要和你对话十次',
    '[2026/8/23 05:47:11] [INFO] [GCP唤醒裁决] 群=707423412 route=direct reason=at',
    '[2026/8/22 21:08:50] [INFO] [GCP唤醒裁决] 群=793019665 route=ignore reason=passive',
    '无关的日志行',
  ].join('\n');

  const parsed = parseLegacyDecisions(log);
  const wake = parsed.filter((p) => p.kind === 'wake');
  const gcp = parsed.filter((p) => p.kind === 'gcp');

  assert.equal(wake.length, 2);
  assert.equal(wake[0].triggered, false);
  assert.equal(wake[1].isAtBot, true);

  assert.equal(gcp.length, 2);
  assert.equal(gcp[0].groupId, '707423412');
  assert.equal(gcp[0].route, 'direct');
  assert.equal(gcp[1].route, 'ignore');
});

test('legacyRouteOf 刻意复刻旧 Bridge 的 direct 缺陷', () => {
  // 对账要跟"旧的实际行为"比，而不是"旧的本意"
  assert.equal(legacyRouteOf({ gcpRoute: 'direct', isAtBot: true }), 'direct');
  assert.equal(
    legacyRouteOf({ gcpRoute: 'direct', isAtBot: false }),
    'ignore',
    '旧 bridge.js:1239 会把非 @ 的 direct 二次否决',
  );
  assert.equal(legacyRouteOf({ gcpRoute: 'ignore', isAtBot: true }), 'ignore');
  assert.equal(legacyRouteOf({ gcpRoute: 'duplicate', isAtBot: true }), 'ignore');
});

test('对照报告汇总裁决分布与有意识差异', () => {
  const entries = [
    { kind: 'decision', v2Decision: 'direct', correlationId: 'c1' },
    { kind: 'decision', v2Decision: 'direct', correlationId: 'c2' },
    { kind: 'decision', v2Decision: 'ignore', correlationId: 'c3' },
    {
      kind: 'reply',
      replyChars: 12,
      latencyMs: 500,
      segments: 2,
      contextSources: [
        { source: 'group-chat-plus', chars: 100, truncatedReason: null },
        { source: 'local-window', chars: 4000, truncatedReason: 'per-source budget 4000' },
      ],
      suppressedSideEffects: [{ kind: 'affection', delta: 2 }],
    },
  ];
  const legacy = parseLegacyDecisions('[GCP唤醒裁决] 群=793019665 route=ignore reason=passive');

  const report = buildReport(entries, legacy);
  assert.equal(report.v2.decisions, 3);
  assert.deepEqual(report.v2.byRoute, { direct: 2, ignore: 1 });
  assert.equal(report.v2.replies, 1);
  assert.equal(report.v2.contextTruncations, 1);
  assert.equal(report.sideEffects.suppressed, 1);
  assert.equal(report.legacy.byGroup['793019665'].ignore, 1);
  assert.equal(report.intentionalDiffs.length, INTENTIONAL_DIFFS.length);

  const text = formatReport(report);
  assert.ok(text.includes('影子对照报告'));
  assert.ok(text.includes('有意识的行为差异'));
  assert.ok(text.includes('bridge.js:1239'));
});

test('三处有意识差异都写明了原因', () => {
  for (const diff of INTENTIONAL_DIFFS) {
    assert.ok(diff.id);
    assert.ok(diff.description);
    assert.ok(diff.reason, `${diff.id} 必须写明为什么允许这个差异`);
  }
  const ids = INTENTIONAL_DIFFS.map((d) => d.id);
  assert.ok(ids.includes('direct-without-at'));
  assert.ok(ids.includes('self-reply-removed'));
  assert.ok(ids.includes('rate-limit-tdz'));
});
