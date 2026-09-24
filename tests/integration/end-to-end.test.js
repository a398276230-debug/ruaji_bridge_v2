/**
 * tests/integration/end-to-end.test.js
 *
 * Golden fixture 走完整链路：NapCat 事件 → 规范化 → 裁决 → 上下文 → 模型
 * → Middleware → 发送队列。用 mock 模型与 dry-run sender，不碰真实网络。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { buildTestContainer, loadFixture, seedMemes, seedAffection, flush, FakeWebSocket } from '../helpers.js';
import { MockModelAdapter } from '../../src/adapters/model/mock-model.js';
import { EVENTS } from '../../src/contracts/events.js';
import { createContextBlock } from '../../src/contracts/context-block.js';

async function settle(ms = 2500) {
  await new Promise((r) => setTimeout(r, ms));
  await flush();
}

test('群聊 @ 消息走完整链路并进入发送队列', async (t) => {
  const container = buildTestContainer({ replies: ['OK'] });
  t.after(() => container.cleanup());

  const fixture = loadFixture('group-at-bot');
  await container.inboundFlow.handleEvent(fixture.event);
  await settle();

  assert.equal(container.sender.dryRunLog.length, 1, '应当产出一条待发消息');
  assert.equal(container.sender.dryRunLog[0].message, '[CQ:at,qq=10000001] OK');
  assert.equal(container.sender.dryRunLog[0].targetId, '707423412');
});

test('模型请求里 system 与 user 分离，用户消息体保持纯净', async (t) => {
  const model = new MockModelAdapter({ replies: ['好的。'] });
  const container = buildTestContainer({ modelAdapter: model });
  t.after(() => container.cleanup());

  // 注入一个语气画像上下文，验证它进 systemText 而不是 userContent
  container.contextAggregator.registerLocal({
    id: 'voice',
    priority: 80,
    collect: () => [createContextBlock({ source: 'voice', text: '[风格画像]', metadata: { slot: 'voice' } })],
  });

  // 先进一条同群的历史消息，使群滑窗包含历史记录
  const historyEvent = { ...loadFixture('group-normal').event, group_id: 707423412, message_id: 170511999 };
  await container.inboundFlow.handleEvent(historyEvent);
  await container.inboundFlow.handleEvent(loadFixture('group-at-bot').event);
  await settle();

  assert.equal(model.calls.length, 1);
  const [system, user] = model.calls[0].messages;
  assert.equal(system.role, 'system');
  assert.ok(!system.content.includes('[风格画像]'), 'system 保持纯净静态以维持缓存');
  assert.ok(!system.content.includes('[交互情境: 直接@呼唤]'), '交互情境移至 user');

  assert.equal(user.role, 'user');
  assert.ok(user.content.includes('[风格画像]'), '动态元数据进入 user 消息前缀');
  assert.ok(user.content.includes('[交互情境: 直接@呼唤]'));
  assert.ok(user.content.includes('[最近群聊消息]'));
  assert.ok(user.content.includes('[时间:'));
  assert.ok(user.content.includes('【ruaji(阵亡)】'));
});

test('四个生命周期事件按顺序发布，且共享同一个 correlationId', async (t) => {
  const container = buildTestContainer({ replies: ['OK'] });
  t.after(() => container.cleanup());

  const seen = [];
  for (const event of Object.values(EVENTS)) {
    container.eventBus.subscribe(event, 'recorder', async (envelope) => {
      seen.push({ event: envelope.event, correlationId: envelope.correlationId });
    });
  }

  await container.inboundFlow.handleEvent(loadFixture('group-at-bot').event);
  await settle();

  const names = seen.map((s) => s.event);
  assert.ok(names.includes(EVENTS.MESSAGE_RECEIVED));
  assert.ok(names.includes(EVENTS.LLM_REQUEST));
  assert.ok(names.includes(EVENTS.LLM_RESPONSE));
  assert.ok(names.includes(EVENTS.MESSAGE_SENT));

  const ids = new Set(seen.map((s) => s.correlationId));
  assert.equal(ids.size, 1, '整条链路共用一个 correlationId');

  assert.ok(
    names.indexOf(EVENTS.MESSAGE_RECEIVED) < names.indexOf(EVENTS.LLM_REQUEST),
    'message.received 必须先于 llm.request',
  );
});

test('被忽略的群聊消息仍然广播 message.received（记忆摄取不依赖回复路由）', async (t) => {
  const container = buildTestContainer();
  t.after(() => container.cleanup());

  let received = 0;
  container.eventBus.subscribe(EVENTS.MESSAGE_RECEIVED, 'memory', async () => { received++; });

  await container.inboundFlow.handleEvent(loadFixture('group-normal').event);
  await settle(400);

  assert.equal(received, 1, '不回复也要把消息推给记忆插件');
  assert.equal(container.sender.dryRunLog.length, 0, '但不能产出回复');
});

test('被忽略的消息照样进本地滑窗', async (t) => {
  const container = buildTestContainer();
  t.after(() => container.cleanup());

  await container.inboundFlow.handleEvent(loadFixture('group-normal').event);
  await settle(400);

  const window = container.sessionStore.getContextWindow('qq:group:793019665');
  assert.equal(window.length, 1, '裁决之前就要记滑窗，否则被忽略的内容永远进不了上下文');
});

test('重复 messageId 只处理一次', async (t) => {
  const model = new MockModelAdapter({ replies: ['OK'] });
  const container = buildTestContainer({ modelAdapter: model });
  t.after(() => container.cleanup());

  const fixture = loadFixture('group-at-bot');
  await container.inboundFlow.handleEvent(fixture.event);
  await container.inboundFlow.handleEvent(fixture.event);
  await settle();

  assert.equal(model.calls.length, 1);
});

test('800ms 防抖把连续消息合并成一次生成', async (t) => {
  const model = new MockModelAdapter({ replies: ['OK'] });
  const container = buildTestContainer({ modelAdapter: model });
  t.after(() => container.cleanup());

  const base = loadFixture('group-at-bot').event;
  await container.inboundFlow.handleEvent({ ...base, message_id: 1, raw_message: '[CQ:at,qq=398276230] 第一条' });
  await container.inboundFlow.handleEvent({ ...base, message_id: 2, raw_message: '[CQ:at,qq=398276230] 第二条' });
  await settle(1500);

  assert.equal(model.calls.length, 1, '两条消息应合并成一次生成');
  const userContent = model.calls[0].messages[1].content;
  assert.ok(userContent.includes('第一条'));
  assert.ok(userContent.includes('第二条'));
});

test('防抖只合并同一个人：两个人各自成轮，各自 @ 回自己（P1）', async (t) => {
  const model = new MockModelAdapter({ replies: ['OK'] });
  const container = buildTestContainer({ modelAdapter: model });
  t.after(() => container.cleanup());

  const base = loadFixture('group-at-bot').event;
  const speak = (messageId, userId, nickname, text) =>
    container.inboundFlow.handleEvent({
      ...base,
      message_id: messageId,
      user_id: userId,
      sender: { user_id: userId, nickname, card: '', role: 'member' },
      raw_message: `[CQ:at,qq=398276230] ${text}`,
    });

  await speak(11, 2260757842, 'qqqq819_01', '早晚吃撑圆球大肥鼠');
  await speak(12, 3382710099, '三²哒锅酱', '喂你松果巧克力恰巴塔');
  await settle(4000);

  assert.equal(model.calls.length, 2, '两个人必须各自生成一次，不能并成一条');

  // 只看触发文本（[最近群聊消息] 块之后的部分）：别人的话可以作为群聊背景出现，
  // 但绝不能挂进本轮触发文本、被冠上本轮回复对象的名字
  const triggerText = (call) => call.messages[1].content.split('\n\n').at(-1);
  const first = triggerText(model.calls[0]);
  const second = triggerText(model.calls[1]);

  assert.ok(first.includes('早晚吃撑圆球大肥鼠'), '第一轮回先到的那个人');
  assert.ok(first.includes('【qqqq819_01 (ID: 2260757842)】'), '第一轮触发文本只标先到那人的名');
  assert.ok(!first.includes('喂你松果巧克力恰巴塔'), '第一轮触发文本不得夹带别人的话');
  assert.ok(second.includes('喂你松果巧克力恰巴塔'), '第二轮回后到的那个人');
  assert.ok(second.includes('【三²哒锅酱 (ID: 3382710099)】'), '第二轮触发文本只标后到那人的名');
  assert.ok(!second.includes('早晚吃撑圆球大肥鼠'), '第二轮触发文本不得夹带别人的话');

  // 每一轮的身份头都是本人，不是"两个人的话挂在最后一人名下"（身份头已移至 user 消息前缀）
  assert.ok(model.calls[0].messages[1].content.includes('[用户: qqqq819_01(2260757842)'));
  assert.ok(model.calls[1].messages[1].content.includes('[用户: 三²哒锅酱(3382710099)'));

  // 首段自动 @ 也必须各回各的
  const mentions = container.sender.dryRunLog.map((d) => d.message);
  assert.ok(mentions.some((m) => m.startsWith('[CQ:at,qq=2260757842]')), 'qqqq819_01 必须被 @ 回');
  assert.ok(mentions.some((m) => m.startsWith('[CQ:at,qq=3382710099]')), '三²哒锅酱必须被 @ 回');
});

test('好感度标记与表情包标记都不出现在最终发出的文本里', async (t) => {
  const container = buildTestContainer({
    replies: ['好的，我看看。\n\n改完重启就行。\n\n[AFF:+2|耐心排查]'],
  });
  t.after(() => container.cleanup());

  await container.inboundFlow.handleEvent(loadFixture('group-reply-quote').event);
  await settle();

  const all = container.sender.dryRunLog.map((d) => d.message).join('\n');
  assert.ok(all.length > 0);
  assert.ok(!all.includes('[AFF:'), '好感度标记必须被剥离');
  assert.ok(!all.includes('&&meme:'));
});

test('表情包标记转成本地图片 CQ 码', async (t) => {
  const container = buildTestContainer();
  t.after(() => container.cleanup());

  const { records } = seedMemes(container.tmpDir, [{ id: 'm_test_1', tag: '摸鱼' }]);
  container.memeStore.load();

  container.modelAdapter.replies = [`还真是。\n\n&&meme:${records[0].id}&&`];

  await container.inboundFlow.handleEvent(loadFixture('group-at-bot').event);
  await settle();

  const all = container.sender.dryRunLog.map((d) => d.message).join('\n');
  assert.ok(all.includes('[CQ:image,file=file:///'), `实际输出: ${all}`);
  assert.ok(all.includes('m_test_1.png'));
  assert.ok(!all.includes('&&meme:'));
});

test('后置表情匹配命中：表情包作为独立一条消息跟在文本段之后', async (t) => {
  // 匹配器走 vision 回落端点（example 配置的 8317），fetch stub 给出合法决策
  const matcherRoute = {
    'POST http://127.0.0.1:8317/v1/chat/completions': () => ({
      body: {
        choices: [{ message: { content: '{"decision":"send","meme_id":"m_match_1"}' } }],
      },
    }),
  };
  const container = buildTestContainer({
    replies: ['哈哈确实，摸鱼才是正经事。'],
    routes: { '*': () => ({ body: { status: 'ok', retcode: 0 } }), ...matcherRoute },
  });
  t.after(() => container.cleanup());

  seedMemes(container.tmpDir, [{ id: 'm_match_1', tag: '摸鱼', keywords: ['摸鱼', '划水'] }]);
  container.memeStore.load();

  await container.inboundFlow.handleEvent(loadFixture('group-at-bot').event);
  await settle();

  const log = container.sender.dryRunLog;
  assert.equal(log.length, 2, `应有文本 + 表情两条消息，实际 ${log.length}: ${log.map((d) => d.message)}`);
  assert.ok(log[0].message.includes('摸鱼才是正经事'), '第一条是正文文本');
  assert.ok(log[0].message.includes('[CQ:at,qq='), '首段文本照常 @ 发送人');
  assert.ok(log[1].message.startsWith('[CQ:image,file=file:///'), '第二条是独立图片消息');
  assert.ok(log[1].message.includes('m_match_1.png'));
  assert.ok(!log[1].message.includes('[CQ:at,'), '表情消息不 @ 人');

  // LLM_RESPONSE 事件带上了匹配结果（面板 trace 可验证）
  const seen = [];
  container.eventBus.subscribe(EVENTS.LLM_RESPONSE, 'rec', async (env) => seen.push(env.payload));
  await container.inboundFlow.handleEvent({ ...loadFixture('group-at-bot').event, message_id: 999, raw_message: '[CQ:at,qq=398276230] 再说一句摸鱼' });
  await settle();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].memeAttached, true);
  assert.equal(seen[0].memeId, 'm_match_1');
});

test('后置表情匹配 decision=none：只发文本，没有第二条', async (t) => {
  const matcherRoute = {
    'POST http://127.0.0.1:8317/v1/chat/completions': () => ({
      body: { choices: [{ message: { content: '{"decision":"none"}' } }] },
    }),
  };
  const container = buildTestContainer({
    replies: ['嗯，了解了。'],
    routes: { '*': () => ({ body: { status: 'ok', retcode: 0 } }), ...matcherRoute },
  });
  t.after(() => container.cleanup());

  seedMemes(container.tmpDir, [{ id: 'm_match_1', tag: '摸鱼', keywords: ['摸鱼'] }]);
  container.memeStore.load();

  await container.inboundFlow.handleEvent(loadFixture('group-at-bot').event);
  await settle();

  assert.equal(container.sender.dryRunLog.length, 1, 'none 决策不应产生第二条消息');
  assert.ok(container.sender.dryRunLog[0].message.includes('了解了'));
});

test('流式回复按空行切成多段发送', async (t) => {
  const container = buildTestContainer({
    replies: ['第一段内容。\n\n第二段内容。\n\n第三段内容。'],
  });
  t.after(() => container.cleanup());

  await container.inboundFlow.handleEvent(loadFixture('group-at-bot').event);
  await settle();

  assert.equal(container.sender.dryRunLog.length, 3);
  assert.ok(container.sender.dryRunLog[0].message.includes('[CQ:at,qq=10000001]'), '只有首段带 @');
  assert.ok(!container.sender.dryRunLog[1].message.includes('[CQ:at,'), '后续段不带 @');
});

test('私聊回复不带 @', async (t) => {
  const container = buildTestContainer({ replies: ['冷萃里蜂蜜确实会影响。'] });
  t.after(() => container.cleanup());

  await container.inboundFlow.handleEvent(loadFixture('private-message').event);
  await settle();

  assert.equal(container.sender.dryRunLog.length, 1);
  assert.equal(container.sender.dryRunLog[0].isGroup, false);
  assert.ok(!container.sender.dryRunLog[0].message.includes('CQ:at'));
});

test('Markdown 被脱掉后才发出', async (t) => {
  const container = buildTestContainer({
    replies: ['### 结论\n\n改 **config.yaml** 里的 `key` 就行。'],
  });
  t.after(() => container.cleanup());

  await container.inboundFlow.handleEvent(loadFixture('group-at-bot').event);
  await settle();

  const all = container.sender.dryRunLog.map((d) => d.message).join('\n');
  assert.ok(all.includes('【结论】'));
  assert.ok(!all.includes('**'));
  assert.ok(!all.includes('`'));
});

test('模型失败时不产出回复，也不崩掉链路', async (t) => {
  const failing = {
    async generate() { throw new Error('模型挂了'); },
    async ping() { return { ok: false, detail: 'down' }; },
    getSessionId: (k) => k,
    async resetSession(k) { return k; },
  };
  const container = buildTestContainer({ modelAdapter: failing });
  t.after(() => container.cleanup());

  await assert.doesNotReject(() => container.inboundFlow.handleEvent(loadFixture('group-at-bot').event));
  await settle();

  assert.equal(container.sender.dryRunLog.length, 0);
  assert.ok(container.logger.find('生成失败').length >= 1);
});

test('/好感度 命令在本层执行，不发给模型', async (t) => {
  const model = new MockModelAdapter({ replies: ['不该被调用'] });
  const container = buildTestContainer({ modelAdapter: model });
  t.after(() => container.cleanup());

  seedAffection(container.tmpDir, {
    2260757842: { nickname: '御娘狼三千', affection: 55, relationship: '熟络群友', interactions: 12, firstSeen: '2026-08-01T00:00:00.000Z' },
  });
  container.affectionStore.load();

  const base = loadFixture('group-reply-quote').event;
  await container.inboundFlow.handleEvent({
    ...base,
    message_id: 9001,
    raw_message: '[CQ:at,qq=398276230] /好感度',
  });
  await settle(600);

  assert.equal(model.calls.length, 0, '命令不得进模型');
  const out = container.sender.dryRunLog.map((d) => d.message).join('\n');
  assert.ok(out.includes('【💖 好感度】'));
  assert.ok(out.includes('御娘狼三千'));
});

test('非主人的 /new 被静默拒绝', async (t) => {
  const model = new MockModelAdapter({ replies: ['x'] });
  const container = buildTestContainer({ modelAdapter: model });
  t.after(() => container.cleanup());

  const base = loadFixture('group-reply-quote').event;
  await container.inboundFlow.handleEvent({
    ...base,
    message_id: 9002,
    raw_message: '[CQ:at,qq=398276230] /new',
  });
  await settle(600);

  assert.equal(model.calls.length, 0);
  assert.equal(container.sender.dryRunLog.length, 0, '静默拒绝，不给任何回应');
  assert.ok(container.logger.find('拒绝未授权的聊天命令').length >= 1);
});

test('主人的 /new 会轮换模型会话', async (t) => {
  const model = new MockModelAdapter({ replies: ['x'] });
  const container = buildTestContainer({ modelAdapter: model });
  t.after(() => container.cleanup());

  const before = model.getSessionId('group_707423412');
  const base = loadFixture('group-at-bot').event;
  await container.inboundFlow.handleEvent({
    ...base,
    message_id: 9003,
    raw_message: '[CQ:at,qq=398276230] /new',
  });
  await settle(600);

  assert.notEqual(model.getSessionId('group_707423412'), before);
  const out = container.sender.dryRunLog.map((d) => d.message).join('\n');
  assert.ok(out.includes('新会话已开启'));
});

test('主人打断特权：新消息立即中断在途生成', async (t) => {
  let aborted = false;
  const slowModel = {
    sessions: new Map(),
    getSessionId: (k) => k,
    async resetSession(k) { return k; },
    async ping() { return { ok: true }; },
    async generate(req, opts) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        opts.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          aborted = true;
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        }, { once: true });
      });
      return { correlationId: req.correlationId, responseId: 'r', model: 'm', rawText: 'late', usage: {}, latencyMs: 0 };
    },
  };

  const container = buildTestContainer({ modelAdapter: slowModel });
  t.after(() => container.cleanup());

  const base = loadFixture('group-at-bot').event;
  await container.inboundFlow.handleEvent({ ...base, message_id: 9101 });
  await new Promise((r) => setTimeout(r, 1200)); // 等生成真正开始

  await container.inboundFlow.handleEvent({
    ...base,
    message_id: 9102,
    raw_message: '[CQ:at,qq=398276230] 等下，改个说法',
  });
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(aborted, true, 'ruaji 的消息必须能打断在途生成（附录 1）');
});

test('WebSocket 推来的事件被喂进 inbound flow', async (t) => {
  FakeWebSocket.reset();
  const container = buildTestContainer({ replies: ['OK'] });
  t.after(() => { container.cleanup(); FakeWebSocket.reset(); });

  container.websocket.on('event', (e) => container.inboundFlow.handleEvent(e));
  container.websocket.connect();

  const ws = FakeWebSocket.instances.at(-1);
  ws.open();
  ws.pushEvent(loadFixture('group-at-bot').event);
  await settle();

  assert.equal(container.sender.dryRunLog.length, 1);
  container.websocket.close();
});

test('WebSocket 断开后按指数退避重连，且不刷屏', async (t) => {
  FakeWebSocket.reset();
  // 退避必须走配置注入：构造时就把 this.backoff 初始化成 minBackoffMs 了，
  // 事后改实例字段只会让 backoff 停在旧的 1000ms 上，定时器根本等不到。
  const container = buildTestContainer({
    configOverrides: { napcat: { reconnect: { minBackoffMs: 20, maxBackoffMs: 80 } } },
  });
  t.after(() => { container.cleanup(); FakeWebSocket.reset(); });

  assert.equal(container.websocket.minBackoffMs, 20, '退避配置应当注入到客户端');
  container.websocket.connect();

  for (let i = 0; i < 3; i++) {
    FakeWebSocket.instances.at(-1).fail('ECONNREFUSED 127.0.0.1:3001');
    await new Promise((r) => setTimeout(r, 120));
  }

  assert.ok(FakeWebSocket.instances.length >= 2, '应当自动重连');
  assert.ok(container.websocket.backoff > 20, '退避应当递增');

  // 原因未变时不该每次都打 warn
  const warns = container.logger.lines.filter((l) => l.level === 'warn' && l.msg.includes('NapCat 连接中断'));
  assert.ok(warns.length <= 2, `原因未变时不应刷屏，实际 ${warns.length} 条 warn`);

  container.websocket.close();
});

test('影子模式下 affection.json 一个字节都没被改（验收标准 14）', async (t) => {
  const container = buildTestContainer({ replies: ['好的 [AFF:+3|测试]'] });
  t.after(() => container.cleanup());

  const file = seedAffection(container.tmpDir, {});
  container.affectionStore.load();
  const before = fs.readFileSync(file, 'utf8');
  const beforeMtime = fs.statSync(file).mtimeMs;

  await container.inboundFlow.handleEvent(loadFixture('group-reply-quote').event);
  await settle();
  container.affectionStore.flush();

  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.statSync(file).mtimeMs, beforeMtime);
  assert.ok(!fs.existsSync(path.join(container.tmpDir, 'affection.json.v2.tmp')));
});

test('收集表情：私聊商城表情（mface）自动入库并报数（LLBOT 回归）', async (t) => {
  const container = buildTestContainer({ replies: ['OK'] });
  t.after(() => container.cleanup());
  // 关掉异步 AI 打标：测试不碰真实视觉端点
  container.memeStore.data.settings.auto_ai_tagging = false;

  const privateCommand = (text, messageId) => ({
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: messageId,
    self_id: 398276230,
    user_id: 10000001,
    time: 1788277290,
    font: 14,
    raw_message: text,
    message: [{ type: 'text', data: { text } }],
    message_format: 'array',
    sender: { user_id: 10000001, nickname: 'ruaji(阵亡)', card: '' },
  });

  await container.inboundFlow.handleEvent(privateCommand('/收集表情', 900001));
  await container.inboundFlow.handleEvent(loadFixture('private-mface').event);
  await container.inboundFlow.handleEvent(privateCommand('/完成收集', 900002));
  await settle();

  const store = container.memeStore;
  assert.equal(store.size, 1, '商城表情应当入库而不是 0 张');
  assert.equal(store.data.memes[0].tag, '摸头');
  assert.ok(store.data.memes[0].keywords.includes('摸头'));
  assert.ok(fs.existsSync(store.data.memes[0].path), 'gif 文件要真实落盘');

  const doneReply = container.sender.dryRunLog.find((m) => m.message.includes('写入【1】张'));
  assert.ok(doneReply, `完成收集要汇报 1 张，实际: ${JSON.stringify(container.sender.dryRunLog.map((m) => m.message))}`);
});

test('收集表情：群聊非唤醒图片先 deferred、收集会话内自动补拉入库（群聊媒体收敛回归）', async (t) => {
  const container = buildTestContainer({ replies: ['OK'] });
  t.after(() => container.cleanup());
  container.memeStore.data.settings.auto_ai_tagging = false;

  const groupEvent = (text, messageId, extraSegments = []) => ({
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: messageId,
    self_id: 398276230,
    user_id: 10000003,
    group_id: 707423412,
    time: 1788277300,
    font: 14,
    raw_message: text,
    message: [{ type: 'text', data: { text } }, ...extraSegments],
    message_format: 'array',
    sender: { user_id: 10000003, nickname: '三锅', card: '', role: 'member' },
  });

  await container.inboundFlow.handleEvent(groupEvent('/收集表情', 910001));
  await container.inboundFlow.handleEvent(
    groupEvent('', 910002, [
      { type: 'image', data: { file: 'M1.png', url: 'https://x/m1.png', sub_type: 0 } },
    ]),
  );
  await container.inboundFlow.handleEvent(groupEvent('/完成收集', 910003));
  await settle();

  const store = container.memeStore;
  assert.equal(store.size, 1, '收集会话里的群聊图片必须补拉入库，不能被群聊媒体策略挡掉');
  assert.ok(fs.existsSync(store.data.memes[0].path), '图片要真实落盘');
  const doneReply = container.sender.dryRunLog.find((m) => m.message.includes('写入【1】张'));
  assert.ok(doneReply, `完成收集要汇报 1 张，实际: ${JSON.stringify(container.sender.dryRunLog.map((m) => m.message))}`);

  // 非收集状态下同款群聊图片不该落盘：不留任何本地副本
  const before = fs.existsSync(container.config.paths.receivedImagesDir)
    ? fs.readdirSync(container.config.paths.receivedImagesDir).length
    : 0;
  await container.inboundFlow.handleEvent(
    groupEvent('', 910004, [
      { type: 'image', data: { file: 'M2.png', url: 'https://x/m2.png', sub_type: 0 } },
    ]),
  );
  await settle(400);
  const after = fs.existsSync(container.config.paths.receivedImagesDir)
    ? fs.readdirSync(container.config.paths.receivedImagesDir).length
    : 0;
  assert.equal(after, before, '非收集状态下群聊路过图片不该新增本地文件');
});

test('上游把同一段回复流两遍（中途重试重放）→ 桥接只发一次，首段不复读', async (t) => {
  const first = '这是第一段比较长的内容。';
  const second = '这是第二段比较长的内容。';
  const full = first + second;
  const replayModel = {
    async generate(req, opts = {}) {
      // 第一次尝试正常流完；随后连接中断、上游从头重放同一段（content-filter
      // fallback / 网络重试都会长成这个形状）
      opts.onText?.(full);
      opts.onText?.(full);
      return {
        correlationId: req.correlationId,
        responseId: 'r-replay',
        model: 'replay-model',
        rawText: full,
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        latencyMs: 1,
      };
    },
    async ping() {
      return { ok: true, detail: 'ok' };
    },
  };
  const container = buildTestContainer({ modelAdapter: replayModel });
  t.after(() => container.cleanup());

  await container.inboundFlow.handleEvent(loadFixture('group-at-bot').event);
  await settle();

  const messages = container.sender.dryRunLog.map((e) => e.message);
  assert.equal(
    messages.length,
    2,
    `两段内容只应发两条，实际 ${messages.length}: ${JSON.stringify(messages)}`,
  );
  assert.equal(messages.filter((m) => m.includes('第一段比较长')).length, 1, '第一段只发一次');
  assert.equal(messages.filter((m) => m.includes('第二段比较长')).length, 1, '第二段只发一次');
});
