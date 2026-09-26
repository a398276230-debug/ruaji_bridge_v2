/**
 * P2：busy 期间并发仲裁行为
 *   - auto 路由且没有真 @ → 直接丢弃（不入缓冲、不调度生成、不打断在途）
 *   - auto 路由但被真 @   → 照旧排队（真 @ 优先于裁决者，不能静默丢）
 *   - direct 路由消息 → 照旧排队
 *   - 主人消息 → preempt 照旧打断在途生成
 *
 * decisionFlow.decide 用桩指定 route；arbitrateConcurrency 走真实 DecisionFlow，
 * busy 状态用 sessionStore.beginExecution 制造。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { InboundFlow } from '../../src/orchestration/inbound-flow.js';
import { InboundNormalizer } from '../../src/adapters/napcat/inbound-normalizer.js';
import { DedupStore } from '../../src/storage/dedup-store.js';
import { SessionStore } from '../../src/storage/session-store.js';
import { EventBus } from '../../src/core/event-bus.js';
import { ContextFlow } from '../../src/orchestration/context-flow.js';
import { ContextAggregator } from '../../src/core/context-aggregator.js';
import { DecisionFlow } from '../../src/orchestration/decision-flow.js';
import { CapabilityBus } from '../../src/core/capability-bus.js';
import { CommandFlow } from '../../src/orchestration/command-flow.js';
import { AffectionStore } from '../../src/storage/affection-store.js';
import { createTestLogger } from '../helpers.js';

const GROUP_ID = 1076958977;
const EXECUTION_KEY = `group_${GROUP_ID}`;

function createTestInboundFlow(route) {
  const logger = createTestLogger();
  const config = {
    identity: {
      ownerId: '10000001',
      robotId: '398276230',
      botName: '瑞姬',
      rateLimitUsers: [],
      privateWhitelist: ['10000001'],
    },
    wake: { mode: 'both', namePattern: '(^|[\\s，,。.!！?？~、；;:：])瑞姬' },
    // 防抖拉长：测试窗口内 timer 不会真的触发生成
    decision: {
      debounceMs: 60000,
      rateLimit: { maxReplies: 5, windowMs: 300000 },
      localWindowInject: 15,
      ownerRedirect: true,
      redirectAck: { enabled: true, message: '↪ 收到补充，已并入当前回复继续生成~', cooldownMs: 30000 },
    },
    reply: { sendEnabled: false, sideEffectsEnabled: true },
    context: { totalCharacterBudget: 12000, perSourceCharacterBudget: 4000, collectTimeoutMs: 100 },
  };

  const normalizer = new InboundNormalizer({ identity: config.identity, wake: config.wake, logger });
  const dedupStore = new DedupStore();
  const sessionStore = new SessionStore();
  const eventBus = new EventBus({ logger });
  const aggregator = new ContextAggregator({ totalBudget: 12000, perSourceBudget: 4000, logger });
  const contextFlow = new ContextFlow({ aggregator, sessionStore, config, logger });
  const capabilityBus = new CapabilityBus({ logger });
  const realDecisionFlow = new DecisionFlow({ capabilityBus, sessionStore, normalizer, config, logger });

  // decide 用桩固定 route；并发仲裁必须走真实 DecisionFlow（主人打断/排队/丢弃判定是被测对象）
  const decisionFlow = {
    decide: async () => ({ route, triggerType: 'at', reason: 'stub', providerId: null }),
    arbitrateConcurrency: (inbound, decision) => realDecisionFlow.arbitrateConcurrency(inbound, decision),
  };  const commandFlow = new CommandFlow({ sessionStore, config, logger });
  const affectionStore = new AffectionStore({ ownerId: config.identity.ownerId, persistEnabled: false, logger });

  /** 计数桩：丢弃必须与 route=ignore 同样落进 messages.ignored 桶 */
  const health = {
    counters: {},
    increment(group, key) {
      this.counters[`${group}.${key}`] = (this.counters[`${group}.${key}`] ?? 0) + 1;
    },
  };

  const inboundFlow = new InboundFlow({
    normalizer,
    dedupStore,
    sessionStore,
    eventBus,
    decisionFlow,
    contextFlow,
    replyFlow: null,
    commandFlow,
    affectionStore,
    memeStore: null,
    health,
    config,
    logger,
  });

  return { inboundFlow, sessionStore, config, health, realDecisionFlow };
}

function groupRawEvent({ messageId, userId, nickname, text }) {
  return {
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: messageId,
    group_id: GROUP_ID,
    user_id: userId,
    self_id: 398276230,
    raw_message: text,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: userId, nickname, card: '' },
  };
}

test('busy + auto 路由消息：不入缓冲直接丢弃，不打断在途生成', async () => {
  const { inboundFlow, sessionStore, health } = createTestInboundFlow('auto');
  const controller = new AbortController();
  sessionStore.beginExecution(EXECUTION_KEY, { controller, source: 'direct', correlationId: 'busy-auto' });

  await inboundFlow.handleEvent(
    groupRawEvent({ messageId: 90001, userId: 2260757842, nickname: '御娘狼三千', text: '好热闹啊' }),
  );

  const buf = sessionStore.getBuffer(EXECUTION_KEY);
  assert.equal(buf.pending.length, 0, 'auto 插话在 busy 时应直接丢弃，不入缓冲');
  assert.equal(buf.timer, null, '丢弃不应调度新的生成');
  assert.equal(controller.signal.aborted, false, '丢弃不能打断在途生成');
  assert.equal(health.counters['messages.ignored'], 1, '丢弃要记 ignored，否则这条只计 received 谁都不落账');
});

test('busy + auto 路由但被真 @：照旧排队，不得静默丢弃', async () => {
  // 真 @ 优先于裁决者（与 decide 里的 at_overrides_provider_ignore 同一个不变量）：
  // 裁决器哪天把 @ 消息标成 auto，也不能让被点名的人在 busy 期间被静默无视。
  const { inboundFlow, sessionStore } = createTestInboundFlow('auto');
  const controller = new AbortController();
  sessionStore.beginExecution(EXECUTION_KEY, { controller, source: 'direct', correlationId: 'busy-auto-at' });

  await inboundFlow.handleEvent(
    groupRawEvent({
      messageId: 90004,
      userId: 2260757842,
      nickname: '御娘狼三千',
      text: '[CQ:at,qq=398276230] 在吗',
    }),
  );

  const buf = sessionStore.getBuffer(EXECUTION_KEY);
  assert.equal(buf.pending.length, 1, '被真 @ 的 auto 消息必须排队等下一轮');
  assert.equal(buf.pending[0].inbound.flags.isAtBot, true);
  assert.equal(controller.signal.aborted, false, '排队不能打断在途生成');
});

test('busy + direct 消息：照旧排队，不打断在途生成', async () => {
  const { inboundFlow, sessionStore } = createTestInboundFlow('direct');
  const controller = new AbortController();
  sessionStore.beginExecution(EXECUTION_KEY, { controller, source: 'direct', correlationId: 'busy-direct' });

  await inboundFlow.handleEvent(
    groupRawEvent({ messageId: 90002, userId: 2260757842, nickname: '御娘狼三千', text: '瑞姬帮我看看这个' }),
  );

  const buf = sessionStore.getBuffer(EXECUTION_KEY);
  assert.equal(buf.pending.length, 1, 'direct 消息在 busy 时应照旧排队');
  // 排队消息不自带 timer：等在途轮结束，由 _runGeneration 的 finally 重新调度
  assert.equal(buf.timer, null, '排队消息不自行调度生成');
  assert.equal(controller.signal.aborted, false, '群友排队不能打断在途生成');
});

test('busy + 主人消息：preempt 照旧打断在途生成', async () => {
  const { inboundFlow, sessionStore } = createTestInboundFlow('direct');
  const controller = new AbortController();
  sessionStore.beginExecution(EXECUTION_KEY, { controller, source: 'direct', correlationId: 'busy-owner' });

  await inboundFlow.handleEvent(
    groupRawEvent({ messageId: 90003, userId: 10000001, nickname: 'ruaji', text: '等等，先回我' }),
  );

  assert.equal(controller.signal.aborted, true, '主人消息必须打断在途生成');
  const buf = sessionStore.getBuffer(EXECUTION_KEY);
  assert.equal(buf.pending.length, 1, '打断后主人消息入缓冲等下一轮');
});

test('busy + 主人消息 + redirect 成功：不打断、不排队、回执一次', async () => {
  const { inboundFlow, sessionStore, realDecisionFlow } = createTestInboundFlow('direct');
  // 给真实 DecisionFlow 注入 redirect 桩（容器里是 modelRouter，同构）
  realDecisionFlow.modelRouter = { redirect: async () => ({ ok: true }) };

  const controller = new AbortController();
  sessionStore.beginExecution(EXECUTION_KEY, {
    controller,
    source: 'direct',
    correlationId: 'busy-redirect',
    sessionKey: EXECUTION_KEY,
  });

  const acks = [];
  inboundFlow.commandFlow._reply = (inbound, text, command, extraMetadata, opts) => {
    acks.push({ text, opts });
    return { handled: true, command };
  };

  await inboundFlow.handleEvent(
    groupRawEvent({ messageId: 90010, userId: 10000001, nickname: 'ruaji', text: '补充：改成先回我这条' }),
  );

  assert.equal(controller.signal.aborted, false, 'redirect 成功绝不能打断在途生成');
  const buf = sessionStore.getBuffer(EXECUTION_KEY);
  assert.equal(buf.pending.length, 0, 'redirect 已并入在途轮，消息不能再排队等下一轮');
  assert.equal(buf.timer, null, '不应调度新生成');
  assert.equal(acks.length, 1, '回执只发一条');
  assert.ok(acks[0].text.includes('并入'), '回执内容来自 redirectAck.message');
  assert.equal(
    acks[0].opts?.immediate,
    true,
    '回执必须即时直发：生成在途时走车道会被积压到整轮回复之后，等于失效',
  );

  // 冷却期内第二条补充：redirect 照常生效，但不再刷回执
  await inboundFlow.handleEvent(
    groupRawEvent({ messageId: 90011, userId: 10000001, nickname: 'ruaji', text: '再补充一点' }),
  );
  assert.equal(controller.signal.aborted, false);
  assert.equal(sessionStore.getBuffer(EXECUTION_KEY).pending.length, 0);
  assert.equal(acks.length, 1, '冷却期内不重复发回执');
});
