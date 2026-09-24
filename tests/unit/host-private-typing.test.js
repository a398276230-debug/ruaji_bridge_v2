/**
 * tests/unit/host-private-typing.test.js —— 发往宿主载荷的私聊标志回归。
 *
 * 宿主的 `InboundMessage.from_payload` 曾只认显式 `isPrivate`；桥接的
 * `message.received` 事件与 `/api/v1/context/enrich` body 都不带它，
 * 于是私聊被判成群聊：
 *   - LivingMemory 的 user 消息写进 `aiocqhttp:GroupMessage:<QQ>` 会话，
 *     而 `llm.response`（带 isPrivate）把 assistant 写进 FriendMessage 会话，
 *     私聊对话劈成两半，反思永远凑不齐一轮；
 *   - 主人私聊豁免（要求 FRIEND_MESSAGE）失效，与 Mem0 重叠。
 *
 * 宿主侧已能从 `messageType` 推导作兜底（见
 * astr/unified_astrbot_host/tests/test_inbound_private_typing.py），
 * 但桥接仍必须显式给出权威标志。这里锁定两条主载荷 + decorate + message.sent。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ContextFlow } from '../../src/orchestration/context-flow.js';
import { InboundFlow } from '../../src/orchestration/inbound-flow.js';
import { createResultDecorateMiddleware } from '../../src/middleware/result-decorate.js';
import { CAPABILITIES } from '../../src/contracts/capabilities.js';
import { createInboundMessage } from '../../src/contracts/messages.js';
import { createTestLogger } from '../helpers.js';

function makeInbound(overrides = {}) {
  return createInboundMessage({
    correlationId: 'c-private',
    messageId: 'm-private',
    userId: '3054039169',
    groupId: '',
    messageType: 'private',
    text: '在吗',
    content: '在吗',
    sender: { nickname: 'ruaji', card: '', displayName: 'ruaji' },
    ...overrides,
    flags: { isAtBot: true, isNameCall: false, isOwner: true, ...(overrides.flags ?? {}) },
  });
}

test('context.enrich body 带 isPrivate（私聊），宿主据此召回/落库同一会话', async () => {
  let captured = null;
  const aggregator = {
    registerLocal() {},
    aggregate: async (input) => {
      captured = input;
      return { blocks: [], stats: {}, dropped: [] };
    },
  };
  const flow = new ContextFlow({ aggregator, config: {}, logger: createTestLogger() });

  await flow.collect(makeInbound(), { triggerType: 'at' });
  assert.ok(captured, 'aggregator.aggregate 应被调用');
  assert.equal(captured.isPrivate, true, '私聊 enrich body 必须带 isPrivate=true');
  assert.equal(captured.messageType, 'private');

  captured = null;
  await flow.collect(makeInbound({ messageType: 'group', groupId: '793019665', userId: '2260757842' }), {
    triggerType: 'at',
  });
  assert.equal(captured.isPrivate, false, '群聊 enrich body 的 isPrivate 必须是 false');
});

test('message.received 事件载荷带 isPrivate，宿主 build_event 才能造出 FriendMessage', () => {
  const published = [];
  const flow = new InboundFlow({
    eventBus: { publish: (envelope) => published.push(envelope) },
    config: {},
    logger: createTestLogger(),
  });

  flow._publishReceived(makeInbound());
  const envelope = published.at(-1);
  assert.equal(envelope.event, 'message.received');
  assert.equal(envelope.payload.isPrivate, true);
  assert.equal(envelope.payload.messageType, 'private');
  // 私聊没有群号：宿主靠 isPrivate 才会用 QQ 号当 session_id
  assert.equal(envelope.payload.groupId, '');

  flow._publishReceived(makeInbound({ messageType: 'group', groupId: '793019665', userId: '2260757842' }));
  assert.equal(published.at(-1).payload.isPrivate, false);
});

test('result.decorate body 的嵌套 inbound 带 isPrivate', async () => {
  let captured = null;
  const capabilityBus = {
    has: (name) => name === CAPABILITIES.RESULT_DECORATE,
    requestOrNull: async (name, input) => {
      captured = input;
      return { providerId: 'unified-host', result: { text: input.text } };
    },
  };
  const mw = createResultDecorateMiddleware({ capabilityBus, logger: createTestLogger() });

  const inbound = makeInbound();
  const context = {
    text: '好呀',
    rawText: '好呀',
    correlationId: inbound.correlationId,
    sessionId: inbound.sessionId,
    isFinalPass: false,
    triggerType: 'at',
    inbound,
  };
  await mw.process(context, (c) => c);

  assert.ok(captured?.inbound, 'decorate body 应带嵌套 inbound');
  assert.equal(captured.inbound.isPrivate, true);
  assert.equal(captured.inbound.messageType, 'private');
});
