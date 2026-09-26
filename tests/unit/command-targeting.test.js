/**
 * 群聊命令定向门禁。
 *
 * 事故背景：主人在群里 @其他 bot 发 /stop，桥接的命令解析没看 @ 目标，把它当成
 * 发给瑞姬的急停执行了（掐掉了瑞姬自己在途的生成）。
 *
 * 现在的口径（core 判定 isCommandTargetedAtBot）：
 *   - 私聊：永远算命令
 *   - 群聊：@ 了别人（@别的 bot / @某人 / @全体成员）又没 @ 瑞姬 → 不是命令
 *   - 群聊：@ 了瑞姬（哪怕同时还 @ 了别人）→ 是命令
 *   - 群聊：不 @ 人也不叫名字 → 照旧是命令（保留原行为）
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandFlow, isCommandTargetedAtBot } from '../../src/orchestration/command-flow.js';
import { InboundNormalizer } from '../../src/adapters/napcat/inbound-normalizer.js';
import { SessionStore } from '../../src/storage/session-store.js';
import { createInboundMessage } from '../../src/contracts/messages.js';
import { createTestLogger } from '../helpers.js';

const IDENTITY = { ownerId: '10000001', robotId: '398276230', botName: '瑞姬', ownerTitle: '主人' };
const CONFIG = { identity: IDENTITY, decision: { debounceMs: 800 } };
const OTHER_BOT = '2260757842';

function makeInbound(overrides = {}) {
  const { rawMessage = '/stop', flags = {}, ...rest } = overrides;
  return createInboundMessage({
    correlationId: 'c-target',
    messageId: `m-${Math.random().toString(36).slice(2, 8)}`,
    userId: '10000001',
    groupId: '793019665',
    messageType: 'group',
    text: '/stop',
    content: '/stop',
    rawMessage,
    sender: { nickname: 'ruaji', card: '', displayName: 'ruaji(阵亡)' },
    ...rest,
    flags: { isOwner: true, ...flags },
  });
}

function makeFlow() {
  const sessions = new SessionStore();
  const replies = [];
  const stops = [];
  const flow = new CommandFlow({
    modelRouter: { stop: async (key, opts) => { stops.push({ key, opts }); return { ok: true }; } },
    sessionStore: sessions,
    sender: { enqueue: (m) => replies.push(m) },
    config: CONFIG,
    logger: createTestLogger(),
  });
  return { flow, sessions, replies, stops };
}

// ---------------------------------------------------------------------------
// 判定函数本身
// ---------------------------------------------------------------------------

test('定向判定：私聊恒算命令，群聊看 @ 目标', () => {
  const priv = makeInbound({ messageType: 'private', groupId: null, flags: { isAtOthers: true } });
  assert.equal(isCommandTargetedAtBot(priv), true, '私聊没有第三方，@ 了谁都不影响');

  assert.equal(isCommandTargetedAtBot(makeInbound({ flags: { isAtOthers: true } })), false, '@ 别人没 @ 瑞姬 → 不是命令');
  assert.equal(
    isCommandTargetedAtBot(makeInbound({ flags: { isAtOthers: true, isAtBot: true } })),
    true,
    '同时 @ 了瑞姬 → 以 @ 瑞姬 为准',
  );
  assert.equal(isCommandTargetedAtBot(makeInbound({ flags: { isAtOthers: false } })), true, '没 @ 别人 → 照旧放行');
  assert.equal(isCommandTargetedAtBot(makeInbound({ flags: {} })), true, '老字段缺省 → 照旧放行（向后兼容）');
});

// ---------------------------------------------------------------------------
// 规范化层：isAtOthers 由 adapters/napcat 从 CQ 码 / segment 算出
// ---------------------------------------------------------------------------

test('normalizer：@ 别人 / @ 瑞姬 / @全体成员的 isAtOthers 判定', async () => {
  const normalizer = new InboundNormalizer({
    identity: IDENTITY,
    wake: { mode: 'both', namePattern: '(^|[\\s，,。.!！?？~、；;:：])瑞姬' },
    logger: createTestLogger(),
  });
  const event = (rawMessage) => ({
    post_type: 'message',
    message_type: 'group',
    message_id: Math.floor(Math.random() * 1e6),
    group_id: 793019665,
    user_id: 10000001,
    self_id: 398276230,
    raw_message: rawMessage,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: 10000001, nickname: 'ruaji', card: '' },
  });

  const atOther = await normalizer.normalize(event(`[CQ:at,qq=${OTHER_BOT}] /stop`));
  assert.equal(atOther.message.flags.isAtOthers, true);
  assert.equal(atOther.message.flags.isAtBot, false);
  assert.equal(atOther.message.text, '/stop', 'CQ 码剥离后正文就是 /stop（这正是误触发的原因）');

  const atBot = await normalizer.normalize(event(`[CQ:at,qq=398276230] /stop [CQ:at,qq=${OTHER_BOT}]`));
  assert.equal(atBot.message.flags.isAtBot, true);
  assert.equal(atBot.message.flags.isAtOthers, true);

  const plain = await normalizer.normalize(event('/stop'));
  assert.equal(plain.message.flags.isAtOthers, false);

  const atAll = await normalizer.normalize(event('[CQ:at,qq=all] /stop'));
  assert.equal(atAll.message.flags.isAtOthers, true, '@全体成员不是点名瑞姬');
  assert.equal(atAll.message.flags.isAtBot, false);
});

// ---------------------------------------------------------------------------
// 命令执行层：@ 别人的 /stop 不能掐在途生成
// ---------------------------------------------------------------------------

test('群聊 @其他 bot /stop：不当作命令，绝不动在途生成', async () => {
  const { flow, sessions, replies, stops } = makeFlow();
  const controller = new AbortController();
  sessions.beginExecution('group_793019665', { controller, source: 'direct', correlationId: 'busy-x' });

  const result = await flow.handle(
    makeInbound({
      rawMessage: `[CQ:at,qq=${OTHER_BOT}] /stop`,
      flags: { isAtOthers: true, isAtBot: false },
    }),
  );

  assert.deepEqual(result, { handled: false, command: null }, '不是给瑞姬的命令');
  assert.equal(controller.signal.aborted, false, '在途生成不能被别人家的 /stop 掐掉');
  assert.equal(stops.length, 0, '不能通知 Hermes 侧 stop');
  assert.equal(replies.length, 0, '不能回执');
});

test('群聊 @瑞姬 /stop：照常执行急停', async () => {
  const { flow, sessions, stops } = makeFlow();
  const controller = new AbortController();
  sessions.beginExecution('group_793019665', { controller, source: 'direct', correlationId: 'busy-y' });

  const result = await flow.handle(
    makeInbound({
      rawMessage: `[CQ:at,qq=398276230] /stop`,
      flags: { isAtBot: true, isAtOthers: false },
    }),
  );

  assert.equal(result.handled, true);
  assert.equal(controller.signal.aborted, true);
  assert.equal(stops.length, 1);
});

test('私聊 /stop：不受群聊门禁影响', async () => {
  const { flow, sessions, stops } = makeFlow();
  const controller = new AbortController();
  sessions.beginExecution('private_10000001', { controller, source: 'direct', correlationId: 'busy-p' });

  const result = await flow.handle(
    makeInbound({
      messageType: 'private',
      groupId: null,
      executionKey: 'private_10000001',
      sessionId: 'qq:private:10000001',
      flags: { isAtOthers: true },
    }),
  );

  assert.equal(result.handled, true);
  assert.equal(controller.signal.aborted, true);
  assert.equal(stops.length, 1);
});

test('群聊 @别人 /收集表情：不开启收集会话，也不回执', async () => {
  const collected = [];
  const memes = {
    startCollect: (uid, category, tag) => { collected.push({ uid, category, tag }); return '已开启收集'; },
  };
  const flow = new CommandFlow({
    memeStore: memes,
    sender: { enqueue: () => {} },
    config: CONFIG,
    logger: createTestLogger(),
  });

  const blocked = await flow.handle(
    makeInbound({
      text: '/收集表情 涩图',
      content: '/收集表情 涩图',
      rawMessage: `[CQ:at,qq=${OTHER_BOT}] /收集表情 涩图`,
      flags: { isAtOthers: true, isOwner: false },
    }),
  );
  assert.equal(blocked.handled, false);
  assert.equal(collected.length, 0);

  // 同一句 @ 着瑞姬就正常执行
  const allowed = await flow.handle(
    makeInbound({
      text: '/收集表情 涩图',
      content: '/收集表情 涩图',
      rawMessage: `[CQ:at,qq=398276230] /收集表情 涩图`,
      flags: { isAtBot: true, isOwner: false },
    }),
  );
  assert.equal(allowed.handled, true);
  assert.deepEqual(collected, [{ uid: '10000001', category: '涩图', tag: '涩图' }]);
});

test('群聊 @别人 的普通消息与非命令斜杠文本都不受影响', async () => {
  const { flow, sessions } = makeFlow();
  const other = { flags: { isAtOthers: true, isAtBot: false } };

  // 不带斜杠：本来就不是命令
  assert.deepEqual(
    await flow.handle(makeInbound({ text: '你好', content: '你好', rawMessage: `[CQ:at,qq=${OTHER_BOT}] 你好`, ...other })),
    { handled: false, command: null },
  );
  // 未知斜杠命令（member/owner）也不该被吞成"已处理"
  assert.deepEqual(
    await flow.handle(makeInbound({ text: '/future', content: '/future', rawMessage: `[CQ:at,qq=${OTHER_BOT}] /future`, ...other })),
    { handled: false, command: null },
  );
  assert.equal(sessions.getBuffer('group_793019665').pending.length, 0);
});
