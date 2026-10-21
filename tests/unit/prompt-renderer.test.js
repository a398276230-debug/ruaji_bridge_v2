import test from 'node:test';
import assert from 'node:assert/strict';

import {
  renderSystemText,
  renderDynamicContext,
  renderUserContent,
  renderUserMessage,
  renderLocalMediaHint,
  renderAttachedMediaToolHint,
  formatMsgTime,
  groupBySlot,
  partitionExtra,
  TRIGGER_NOTICES,
  KNOWLEDGE_NOTICE,
  QQ_TOOLS_NOTICE,
  LOREBOOK_MAINTENANCE_NOTICE,
  resolveLorebookMaintenanceHint,
  NON_ADMIN_GUARD_NOTICE,
  NON_ADMIN_TOOL_BUDGET_COMMAND,
  AFF_MARKER_RULE,
} from '../../src/orchestration/prompt-renderer.js';
import { SEE_MODE_NOTICE, isSeeCommand } from '../../src/core/see-command.js';
import { mergeBatch } from '../../src/orchestration/inbound-flow.js';
import { SessionStore } from '../../src/storage/session-store.js';
import { createContextBlock } from '../../src/contracts/context-block.js';
import { createInboundMessage } from '../../src/contracts/messages.js';
import { loadFixture } from '../helpers.js';

const IDENTITY = { ownerId: '10000001', robotId: '398276230', botName: '瑞姬' };

function makeInbound(overrides = {}) {
  return createInboundMessage({
    correlationId: 'c1',
    messageId: '1',
    timestamp: 1787435231,
    userId: '10000001',
    groupId: '707423412',
    messageType: 'group',
    content: '@瑞姬  我要和你对话十次，你回个OK即可',
    sender: { nickname: 'ruaji(阵亡)', card: '', displayName: 'ruaji(阵亡)' },
    ...overrides,
  });
}

test('formatMsgTime 用 OneBot event time 而非当前时间，按上海时区', () => {
  assert.equal(formatMsgTime(1787435231), '2026/8/23 05:47:11');
  assert.equal(formatMsgTime(1787435231000), '2026/8/23 05:47:11', '毫秒同样处理');
  assert.match(formatMsgTime(null), /^\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}:\d{2}$/);
  assert.match(formatMsgTime('not-a-number'), /^\d{4}\//);
});

test('groupBySlot 按 slot 分组，未知 slot 归到 extra', () => {
  const slots = groupBySlot([
    createContextBlock({ source: 'a', text: 'V', metadata: { slot: 'voice' } }),
    createContextBlock({ source: 'b', text: 'S', metadata: { slot: 'slang' } }),
    createContextBlock({ source: 'c', text: 'X' }),
  ]);
  assert.equal(slots.voice, 'V');
  assert.equal(slots.slang, 'S');
  assert.equal(slots.extra, 'X');
});

test('groupBySlot 的未知 slot 兜底不会被 Object.prototype 击穿', () => {
  // 回归：原实现是 (slots[slot] ?? slots.extra).push(...)。slot 来自远程 Provider
  // 的 JSON，'constructor'/'toString' 这类值会从 Object.prototype 取到函数，
  // ?? 兜不住，.push 当场抛 TypeError，整轮回复直接失败。
  for (const slot of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    const slots = groupBySlot([createContextBlock({ source: 'gcp', text: 'X', metadata: { slot } })]);
    assert.equal(slots.extra, 'X', `slot=${slot} 应归到 extra`);
  }
});

test('远程 Provider 送来原型链 slot 名时 renderDynamicContext 与 renderSystemText 不崩（meme 槽位已移除，归到 extra）', () => {
  const dynamicContext = renderDynamicContext({
    inbound: makeInbound(),
    contextBlocks: [
      createContextBlock({ source: 'gcp', text: '[远程上下文]', metadata: { slot: 'constructor' } }),
      createContextBlock({ source: 'legacy', text: '[旧表情规则]', metadata: { slot: 'meme' } }),
    ],
    triggerType: 'at',
    affectionContext: null,
    identity: IDENTITY,
  });
  assert.ok(dynamicContext.includes('[远程上下文]'));
  assert.ok(dynamicContext.includes('[旧表情规则]'), '历史遗留的 meme slot 应归到 extra 而不是被丢弃');
});

test('主人分支：主人身份头打头，组合各 slot，但不注入好感度', () => {
  const blocks = [
    createContextBlock({ source: 'voice', text: '[风格画像]', metadata: { slot: 'voice' } }),
    createContextBlock({ source: 'slang', text: '[黑话]', metadata: { slot: 'slang' } }),
    createContextBlock({ source: 'extra', text: '[附加块]' }),
  ];

  const inbound = makeInbound({
    timestamp: 1787435231,
    content: '@瑞姬  我要和你对话十次，你回个OK即可',
    userId: '10000001',
    groupId: '707423412',
    sender: { nickname: 'ruaji', card: '', displayName: 'ruaji' },
  });

  const systemText = renderSystemText({
    inbound,
    contextBlocks: blocks,
    triggerType: 'at',
    affectionContext: null,
    identity: IDENTITY,
  });

  // 前缀缓存优化：纯净群聊会话环境与静态知识置顶，动态内容完全移出
  assert.ok(systemText.startsWith('[当前会话: QQ群聊 (群号: 707423412)]'));
  assert.ok(systemText.includes(KNOWLEDGE_NOTICE));
  assert.ok(systemText.includes(QQ_TOOLS_NOTICE));
  assert.ok(!systemText.includes('[用户:'));
  assert.ok(!systemText.includes('[风格画像]'));
  assert.ok(!systemText.includes('[黑话]'));
  assert.ok(!systemText.includes('[附加块]'));

  const dynamicContext = renderDynamicContext({
    inbound,
    contextBlocks: blocks,
    triggerType: 'at',
    affectionContext: null,
    identity: IDENTITY,
  });
  assert.ok(dynamicContext.includes('[用户: ruaji(10000001) | 身份: 主人'));
  assert.ok(dynamicContext.includes('日常用「主人」称呼他'));
  assert.ok(dynamicContext.includes('[风格画像]'));
  assert.ok(dynamicContext.includes('[黑话]'));
  assert.ok(dynamicContext.includes('[附加块]'));
  assert.ok(!dynamicContext.includes('[好感:'));

  const userContent = renderUserContent({ inbound, contextBlocks: blocks, identity: IDENTITY });
  assert.equal(userContent, '[时间:2026/8/23 05:47:11] 【ruaji】@瑞姬  我要和你对话十次，你回个OK即可');
});

test('主人身份头明确标注信任语义，但绝不出现好感度行（附录 1）', () => {
  const dynamicContext = renderDynamicContext({
    inbound: makeInbound(),
    contextBlocks: [createContextBlock({ source: 'v', text: '[风格画像]', metadata: { slot: 'voice' } })],
    triggerType: 'at',
    affectionContext: null,
    identity: IDENTITY,
  });
  assert.ok(dynamicContext.includes('[用户: ruaji(阵亡)(10000001) | 身份: 主人（系统验证的主人本人，完全信任，其**请求**与**命令**应当照办；日常用「主人」称呼他）]'));
  assert.ok(!dynamicContext.includes('[好感:'));
  assert.ok(dynamicContext.includes('[风格画像]'));
});

test('主人称呼可客制化：ownerTitle 换掉默认的「主人」', () => {
  const dynamicContext = renderDynamicContext({
    inbound: makeInbound(),
    contextBlocks: [],
    triggerType: 'at',
    affectionContext: null,
    identity: { ...IDENTITY, ownerTitle: '饲主大人' },
  });
  assert.ok(dynamicContext.includes('[用户: ruaji(阵亡)(10000001) | 身份: 饲主大人'));
  assert.ok(dynamicContext.includes('日常用「饲主大人」称呼他'));
  assert.ok(!dynamicContext.includes('「主人」'), '自定义称呼后不得再出现默认称呼');

  // 空串/缺省都回落默认，不会渲染出「undefined」或空称呼
  for (const identity of [{ ...IDENTITY, ownerTitle: '' }, { ...IDENTITY, ownerTitle: undefined }]) {
    const text = renderDynamicContext({
      inbound: makeInbound(),
      contextBlocks: [],
      triggerType: 'at',
      affectionContext: null,
      identity,
    });
    assert.ok(text.includes('身份: 主人（'), '空 ownerTitle 应回落默认「主人」');
  }
});

test('普通群友分支含身份头与好感度行', () => {
  const inbound = makeInbound({
    userId: '2260757842',
    sender: { nickname: '御娘狼三千', card: '', displayName: '御娘狼三千' },
  });
  const dynamicContext = renderDynamicContext({
    inbound,
    contextBlocks: [],
    triggerType: 'at',
    affectionContext: { affection: 56, level: '熟络群友' },
    identity: IDENTITY,
  });

  assert.ok(dynamicContext.includes('[用户: 御娘狼三千(2260757842) | 群707423412]'));
  assert.ok(dynamicContext.includes(`[好感: 56/90 (熟络群友) | ${AFF_MARKER_RULE}]`));
  // 评估量纲与标准并入 affLine 后，SOUL.md 的 <affection_eval> 整块可删：
  // 这里守住量纲措辞不被顺手砍掉。
  assert.ok(AFF_MARKER_RULE.includes('N取-5~+5'));
  assert.ok(AFF_MARKER_RULE.includes('走心交流+3~5'));
  assert.ok(AFF_MARKER_RULE.includes('纯水消息0'));
});

test('冷暴力与好感度上下限约束动态注入 Prompt（Favour_Ultra 特性）', () => {
  const inbound = makeInbound({
    userId: '2260757842',
    sender: { nickname: '御娘狼三千', card: '', displayName: '御娘狼三千' },
  });

  // 冷暴力状态
  const coldText = renderDynamicContext({
    inbound,
    contextBlocks: [],
    triggerType: 'at',
    affectionContext: {
      affection: 15,
      level: '陌生人',
      isColdViolent: true,
      coldRemainingMinutes: 45,
    },
    identity: IDENTITY,
  });
  assert.ok(coldText.includes('状态: ❄️冷暴力惩罚中(剩余45分)'));
  assert.ok(coldText.includes('态度需极度冷淡疏离、极简敷衍'));

  // 好感已达上限 90
  const maxText = renderDynamicContext({
    inbound,
    contextBlocks: [],
    triggerType: 'at',
    affectionContext: {
      affection: 90,
      level: '挚友',
      atMax: true,
    },
    identity: IDENTITY,
  });
  assert.ok(maxText.includes('当前好感已达上限90，禁止输出正向加分，仅允许[AFF:0|...]持平或负向扣分'));

  // 好感已达下限 -100
  const minText = renderDynamicContext({
    inbound,
    contextBlocks: [],
    triggerType: 'at',
    affectionContext: {
      affection: -100,
      level: '死敌',
      atMin: true,
    },
    identity: IDENTITY,
  });
  assert.ok(minText.includes('当前好感已达下限-100，无法继续扣分'));

  // 负好感警戒区与画像复合注入
  const negText = renderDynamicContext({
    inbound,
    contextBlocks: [],
    triggerType: 'at',
    affectionContext: {
      affection: -35,
      level: '嫌弃',
      relationship: '嫌弃',
      is_unique: false,
      portrayal: '画像: 暴躁/杠精 | 雷区: 忌反驳',
    },
    identity: IDENTITY,
  });
  assert.ok(negText.includes('状态: 负好感警戒区，态度需戒备、冷漠或带刺'));
  assert.ok(negText.includes('[画像: 暴躁/杠精 | 雷区: 忌反驳]'));
});

test('私聊身份头显示"私聊"', () => {
  const inbound = makeInbound({
    userId: '2260757842',
    groupId: null,
    messageType: 'private',
    sender: { nickname: '御娘狼三千', card: '', displayName: '御娘狼三千' },
  });
  const systemText = renderSystemText({
    inbound,
    contextBlocks: [],
  });
  assert.ok(systemText.startsWith('[当前会话: QQ私聊]'));
  assert.ok(!systemText.includes('[用户:'));

  const dynamicContext = renderDynamicContext({
    inbound,
    contextBlocks: [],
    triggerType: 'at',
    affectionContext: null,
    identity: IDENTITY,
  });
  assert.ok(dynamicContext.includes('[用户: 御娘狼三千(2260757842) | 私聊]'));
});

test('三段 triggerNotice 逐字保留，且只在群聊注入', () => {
  const inbound = makeInbound();
  for (const trigger of ['at', 'keyword', 'ai_decision']) {
    const dynamicContext = renderDynamicContext({
      inbound,
      contextBlocks: [],
      triggerType: trigger,
      affectionContext: null,
      identity: IDENTITY,
    });
    assert.ok(
      dynamicContext.includes(TRIGGER_NOTICES[trigger]),
      `${trigger} 的情境提示应当逐字保留`,
    );
  }

  const privateContext = renderDynamicContext({
    inbound: makeInbound({ messageType: 'private', groupId: null }),
    contextBlocks: [],
    triggerType: 'at',
    affectionContext: null,
    identity: IDENTITY,
  });
  assert.ok(!privateContext.includes('[交互情境'), '私聊不注入情境提示');

  const privateSystemText = renderSystemText({
    inbound: makeInbound({ messageType: 'private', groupId: null }),
    contextBlocks: [],
  });
  assert.ok(privateSystemText.startsWith('[当前会话: QQ私聊]'), '私聊以当前会话置顶');
  assert.ok(privateSystemText.includes(KNOWLEDGE_NOTICE), '私聊包含知识认知');
});

test('partitionExtra：从 extra 中提取 <FavorabilityPlugin> 静态规则，并自动闭合被截断的 <RAG-Faiss-Memory>', () => {
  const extraText = [
    '<FavorabilityPlugin><Rules>一律纯文本</Rules></FavorabilityPlugin>',
    '<FavourContext>好感1000</FavourContext>',
    '<RAG-Faiss-Memory>\n记忆 #1: 环世界优化\n记忆 #2: 老滚5', // 缺少闭合标签
  ].join('\n\n');

  const { favorStatic, dynamicExtra } = partitionExtra(extraText);
  assert.ok(favorStatic.includes('<FavorabilityPlugin>'));
  assert.ok(!dynamicExtra.includes('<FavorabilityPlugin>'));
  assert.ok(dynamicExtra.includes('<FavourContext>好感1000</FavourContext>'));
  assert.ok(dynamicExtra.includes('</RAG-Faiss-Memory>'), '未闭合的记忆标签应被自动补齐');
  assert.ok(dynamicExtra.includes('...[记忆截断]'));
});

test('非管理群友工具预算限制与防套词维持人设提示（direct 与 auto 触发均注入，主人/管理员与私聊不注入）', () => {
  const memberUid = '2260757842';
  const adminUid = '20000002';
  const identityWithAdmin = { ...IDENTITY, adminIds: [adminUid] };

  // 1. 群聊普通群友 direct (@) 触发 -> 注入工具预算限制与防套词提示
  const memberDirectContext = renderDynamicContext({
    inbound: makeInbound({ userId: memberUid }),
    contextBlocks: [],
    triggerType: 'at',
    affectionContext: null,
    identity: identityWithAdmin,
  });
  assert.ok(memberDirectContext.includes(NON_ADMIN_TOOL_BUDGET_COMMAND), '群聊普通群友 direct 应注入工具预算限制');
  assert.ok(memberDirectContext.includes(NON_ADMIN_GUARD_NOTICE), '群聊普通群友 direct 应注入防套词提示');
  assert.ok(memberDirectContext.endsWith(NON_ADMIN_GUARD_NOTICE), '防套词提示应位于尾部');

  // 2. 群聊普通群友 auto (ai_decision) 触发 -> 注入
  const memberAutoContext = renderDynamicContext({
    inbound: makeInbound({ userId: memberUid }),
    contextBlocks: [],
    triggerType: 'ai_decision',
    affectionContext: null,
    identity: identityWithAdmin,
  });
  assert.ok(memberAutoContext.includes(NON_ADMIN_TOOL_BUDGET_COMMAND), '群聊普通群友 auto 插话应注入工具预算限制');
  assert.ok(memberAutoContext.includes(NON_ADMIN_GUARD_NOTICE), '群聊普通群友 auto 插话应注入防套词提示');
  assert.ok(memberAutoContext.endsWith(NON_ADMIN_GUARD_NOTICE), '防套词提示应位于尾部');

  // 3. 主人 direct 与 auto 触发 -> 不注入
  const ownerDirectContext = renderDynamicContext({
    inbound: makeInbound({ userId: IDENTITY.ownerId }),
    contextBlocks: [],
    triggerType: 'at',
    affectionContext: null,
    identity: identityWithAdmin,
  });
  assert.ok(!ownerDirectContext.includes(NON_ADMIN_TOOL_BUDGET_COMMAND), '主人 direct 不应注入工具预算限制');
  assert.ok(!ownerDirectContext.includes(NON_ADMIN_GUARD_NOTICE), '主人 direct 不应注入防套词提示');

  const ownerAutoContext = renderDynamicContext({
    inbound: makeInbound({ userId: IDENTITY.ownerId }),
    contextBlocks: [],
    triggerType: 'ai_decision',
    affectionContext: null,
    identity: identityWithAdmin,
  });
  assert.ok(!ownerAutoContext.includes(NON_ADMIN_TOOL_BUDGET_COMMAND), '主人 auto 不应注入工具预算限制');
  assert.ok(!ownerAutoContext.includes(NON_ADMIN_GUARD_NOTICE), '主人 auto 不应注入防套词提示');

  // 4. 管理员 direct 与 auto 触发 -> 不注入
  const adminDirectContext = renderDynamicContext({
    inbound: makeInbound({ userId: adminUid }),
    contextBlocks: [],
    triggerType: 'at',
    affectionContext: null,
    identity: identityWithAdmin,
  });
  assert.ok(!adminDirectContext.includes(NON_ADMIN_TOOL_BUDGET_COMMAND), '管理员 direct 不应注入工具预算限制');
  assert.ok(!adminDirectContext.includes(NON_ADMIN_GUARD_NOTICE), '管理员 direct 不应注入防套词提示');

  const adminAutoContext = renderDynamicContext({
    inbound: makeInbound({ userId: adminUid }),
    contextBlocks: [],
    triggerType: 'ai_decision',
    affectionContext: null,
    identity: identityWithAdmin,
  });
  assert.ok(!adminAutoContext.includes(NON_ADMIN_TOOL_BUDGET_COMMAND), '管理员 auto 不应注入工具预算限制');
  assert.ok(!adminAutoContext.includes(NON_ADMIN_GUARD_NOTICE), '管理员 auto 不应注入防套词提示');

  // 5. 私聊普通用户 -> 不注入群聊防套词与工具预算提示
  const privateMemberContext = renderDynamicContext({
    inbound: makeInbound({ userId: memberUid, messageType: 'private', groupId: null }),
    contextBlocks: [],
    triggerType: 'at',
    affectionContext: null,
    identity: identityWithAdmin,
  });
  assert.ok(!privateMemberContext.includes(NON_ADMIN_TOOL_BUDGET_COMMAND), '私聊不应注入工具预算限制');
  assert.ok(!privateMemberContext.includes(NON_ADMIN_GUARD_NOTICE), '私聊不应注入防套词提示');
});

test('QQ工具能力标注注入所有分支', () => {
  // 不点名具体工具名（清单由 MCP tools/list 负责），只覆盖核心场景措辞。
  assert.ok(QQ_TOOLS_NOTICE.includes('调工具查证'), 'QQ_TOOLS_NOTICE 应包含查证指引');

  const cases = [
    { userId: '10000001', triggerType: 'at' }, // 主人
    { userId: '2260757842', triggerType: 'at' }, // 普通群友
    { userId: '2260757842', triggerType: 'ai_decision' }, // 主动接话
  ];
  for (const c of cases) {
    const systemText = renderSystemText({
      inbound: makeInbound({ userId: c.userId }),
      contextBlocks: [],
      triggerType: c.triggerType,
      affectionContext: null,
      identity: IDENTITY,
    });
    assert.ok(systemText.includes(QQ_TOOLS_NOTICE), `${c.triggerType}/${c.userId} 分支都注入 QQ 工具能力标注`);
  }
});

test('主动接话：不注入任何身份头也不注入好感度', () => {
  const inbound = makeInbound({
    userId: '2260757842',
    sender: { nickname: '御娘狼三千', card: '', displayName: '御娘狼三千' },
  });
  const systemText = renderSystemText({
    inbound,
    contextBlocks: [createContextBlock({ source: 'v', text: '[风格画像]', metadata: { slot: 'voice' } })],
    triggerType: 'ai_decision',
    affectionContext: null,
    identity: IDENTITY,
  });
  assert.ok(!systemText.includes('[用户:'));
  assert.ok(!systemText.includes('[好感:'));
});

test('userContent：主人显示【昵称】，非主人显示【昵称 (ID: uid)】', () => {
  const owner = renderUserContent({ inbound: makeInbound(), contextBlocks: [], identity: IDENTITY });
  assert.ok(owner.includes('【ruaji(阵亡)】'));
  assert.ok(!owner.includes('(ID:'));

  const other = renderUserContent({
    inbound: makeInbound({
      userId: '2260757842',
      sender: { nickname: '御娘狼三千', card: '', displayName: '御娘狼三千' },
    }),
    contextBlocks: [],
    identity: IDENTITY,
  });
  assert.ok(other.includes('【御娘狼三千 (ID: 2260757842)】'));
});

test('群聊上下文以 [最近群聊消息] 前缀注入 userContent', () => {
  const out = renderUserContent({
    inbound: makeInbound(),
    contextBlocks: [
      createContextBlock({ source: 'gcp', text: '[05:40:00] linyuan: 在吗', metadata: { slot: 'recent' } }),
    ],
    identity: IDENTITY,
  });
  assert.ok(out.startsWith('[最近群聊消息]\n[05:40:00] linyuan: 在吗\n\n[时间:'));
});

test('带图片时 userMessage 变成多模态 parts，优先用 URL', () => {
  const inbound = makeInbound({
    media: [{ kind: 'image', url: 'https://x/y.png', localPath: 'F:/a.png' }],
  });
  const parts = renderUserMessage({ inbound, contextBlocks: [], identity: IDENTITY });
  assert.ok(Array.isArray(parts));
  assert.equal(parts[0].type, 'text');
  // 图1 前紧邻一行归属说明牌（做法一：归属文本必须紧贴图片）
  assert.equal(parts[1].type, 'text');
  assert.ok(parts[1].text.startsWith('[图1:'));
  assert.equal(parts[2].image_url.url, 'https://x/y.png');
});

test('没有 URL 时退回本地 file URI', () => {
  const inbound = makeInbound({ media: [{ kind: 'image', localPath: 'F:\\received_images\\a.png' }] });
  const parts = renderUserMessage({ inbound, contextBlocks: [], identity: IDENTITY });
  assert.equal(parts[1].type, 'text');
  assert.equal(parts[2].image_url.url, 'file:///F:/received_images/a.png');
});

// ===== 做法一：图片归属说明牌 =====

test('引用机器人自己的图：说明牌明示是你自己此前发送的', () => {
  const inbound = makeInbound({
    media: [{ kind: 'image', origin: 'quote', originAuthor: '瑞姬', originIsBot: true, localPath: 'F:/a.png' }],
  });
  const parts = renderUserMessage({ inbound, contextBlocks: [], identity: IDENTITY });
  const label = parts[1].text;
  assert.ok(label.includes('原作者: 瑞姬'), '要标出原作者');
  assert.ok(label.includes('即你自己'), '要明示是你自己发的');
  assert.ok(label.includes('并非本条消息发送者发来的'), '要排除"发送者发的"误读');
  assert.equal(parts[2].type, 'image_url');
});

test('引用他人的图：说明牌标出原作者，且声明不是发送者附带的', () => {
  const inbound = makeInbound({
    userId: '2260757842',
    sender: { nickname: '御娘狼三千', card: '', displayName: '御娘狼三千' },
    media: [{ kind: 'image', origin: 'quote', originAuthor: '羽莺1947III', originIsBot: false, localPath: 'F:/a.png' }],
  });
  const parts = renderUserMessage({ inbound, contextBlocks: [], identity: IDENTITY });
  const label = parts[1].text;
  assert.ok(label.includes('原作者: 羽莺1947III'));
  assert.ok(label.includes('被引用转发的'));
  assert.ok(label.includes('并非本条消息发送者附带的'));
});

test('自带图与引用图混排：说明牌交错排列、编号连续', () => {
  const inbound = makeInbound({
    media: [
      { kind: 'image', origin: 'message', originAuthor: '羽莺1947III', url: 'https://x/own.png' },
      { kind: 'image', origin: 'quote', originAuthor: '瑞姬', originIsBot: true, url: 'https://x/quoted.png' },
    ],
  });
  const parts = renderUserMessage({ inbound, contextBlocks: [], identity: IDENTITY });
  assert.deepEqual(
    parts.map((p) => p.type),
    ['text', 'text', 'image_url', 'text', 'image_url'],
    '布局必须是：正文 → 图1说明 → 图1 → 图2说明 → 图2',
  );
  assert.ok(parts[1].text.startsWith('[图1:'));
  assert.ok(parts[1].text.includes('羽莺1947III 本条消息附带的图片'));
  assert.ok(parts[3].text.startsWith('[图2:'));
  assert.ok(parts[3].text.includes('即你自己'));
});

test('没有归属信息的图退回通用说明牌，不丢图也不空编号', () => {
  const inbound = makeInbound({
    media: [
      { kind: 'image', url: 'https://x/1.png' },
      // 既无 URL 也无本地路径：图挂不进 parts，说明牌跟着跳过，编号不断档
      { kind: 'image' },
      { kind: 'image', url: 'https://x/2.png' },
    ],
  });
  const parts = renderUserMessage({ inbound, contextBlocks: [], identity: IDENTITY });
  assert.deepEqual(
    parts.map((p) => p.type),
    ['text', 'text', 'image_url', 'text', 'image_url'],
  );
  assert.equal(parts[1].text, '[图1: 本条消息附带的图片]');
  assert.equal(parts[3].text, '[图2: 本条消息附带的图片]');
});

test('纯文本消息（无图）不受说明牌影响', () => {
  const out = renderUserMessage({ inbound: makeInbound(), contextBlocks: [], identity: IDENTITY });
  assert.equal(typeof out, 'string');
});

test('本地媒体清单把绝对路径告诉模型（附录 2）', () => {
  const hint = renderLocalMediaHint({
    media: [
      { kind: 'image', localPath: 'F:/received_images/a.png' },
      { kind: 'file', localPath: 'F:/received_files/Player.log' },
    ],
  });
  assert.ok(hint.includes('F:/received_images/a.png'));
  assert.ok(hint.includes('F:/received_files/Player.log'));
  assert.equal(renderLocalMediaHint({ media: [] }), '');
});

// ===== P1：防抖合并批次的逐条渲染 =====

const STUB_DECISION = { route: 'direct', triggerType: 'at', reason: 'stub', providerId: null };

function makeBatchItem(overrides = {}) {
  return {
    inbound: createInboundMessage({
      correlationId: 'c1',
      messageId: 'm1',
      timestamp: 1787435231,
      userId: '10000001',
      groupId: '707423412',
      messageType: 'group',
      content: 'hello',
      sender: { nickname: 'ruaji', card: '', displayName: 'ruaji' },
      ...overrides,
    }),
    decision: STUB_DECISION,
  };
}

test('P1 修复：batch 逐条渲染，一行一条各标各的名', () => {
  const { inbound } = mergeBatch([
    makeBatchItem({
      messageId: 'm1',
      timestamp: 1787435200,
      userId: '2260757842',
      content: '瑞姬看看这个',
      sender: { nickname: 'qqqq819_01', card: '', displayName: 'qqqq819_01' },
    }),
    makeBatchItem({
      messageId: 'm2',
      timestamp: 1787435231,
      userId: '3382710099',
      content: '对，就是这个',
      sender: { nickname: '三²哒锅酱', card: '', displayName: '三²哒锅酱' },
    }),
  ]);

  const out = renderUserContent({ inbound, contextBlocks: [], identity: IDENTITY });
  const lines = out.split('\n');

  assert.equal(lines.length, 2, '两条消息应渲染成两行');
  assert.ok(lines[0].includes('【qqqq819_01 (ID: 2260757842)】'), '第一行必须标 qqqq819_01 自己的名');
  assert.ok(lines[0].includes('瑞姬看看这个'), '第一行必须是 qqqq819_01 的话');
  assert.ok(lines[1].includes('【三²哒锅酱 (ID: 3382710099)】'), '第二行必须标三²哒锅酱自己的名');
  assert.ok(lines[1].includes('对，就是这个'), '第二行必须是三²哒锅酱的话');
});

test('batch 末条为主人：主人行短格式【昵称】，群友行带 ID', () => {
  const { inbound } = mergeBatch([
    makeBatchItem({
      messageId: 'm1',
      timestamp: 1787435200,
      userId: '2260757842',
      content: '群友的话',
      sender: { nickname: '御娘狼三千', card: '', displayName: '御娘狼三千' },
    }),
    makeBatchItem({
      messageId: 'm2',
      timestamp: 1787435231,
      userId: '10000001',
      content: '主人补一句',
      sender: { nickname: 'ruaji', card: '', displayName: 'ruaji' },
    }),
  ]);

  const out = renderUserContent({ inbound, contextBlocks: [], identity: IDENTITY });
  const lines = out.split('\n');

  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('【御娘狼三千 (ID: 2260757842)】'), '群友行带 ID');
  assert.ok(lines[1].includes('【ruaji】'), '主人行短格式');
  assert.ok(!lines[1].includes('(ID:'), '主人行不能带 ID');
  assert.ok(lines[1].includes('主人补一句'));
});

test('无 batch（单条）旧格式逐字节不变（回归）', () => {
  const owner = renderUserContent({ inbound: makeInbound(), contextBlocks: [], identity: IDENTITY });
  assert.equal(owner, '[时间:2026/8/23 05:47:11] 【ruaji(阵亡)】@瑞姬  我要和你对话十次，你回个OK即可');

  const other = renderUserContent({
    inbound: makeInbound({
      userId: '2260757842',
      content: '你好',
      sender: { nickname: '御娘狼三千', card: '', displayName: '御娘狼三千' },
    }),
    contextBlocks: [],
    identity: IDENTITY,
  });
  assert.equal(other, '[时间:2026/8/23 05:47:11] 【御娘狼三千 (ID: 2260757842)】你好');

  // 防御：长度为 1 的 batch 数组不改变单条渲染（mergeBatch 不产生这种形态）
  const singleBatch = makeInbound({
    extensions: {
      batch: [{ messageId: 'm1', timestamp: 1787435231, userId: '10000001', displayName: 'ruaji(阵亡)', content: 'x' }],
    },
  });
  assert.equal(
    renderUserContent({ inbound: singleBatch, contextBlocks: [], identity: IDENTITY }),
    '[时间:2026/8/23 05:47:11] 【ruaji(阵亡)】@瑞姬  我要和你对话十次，你回个OK即可',
  );
});

test('batch 里的空正文（纯媒体消息）不占行', () => {
  const { inbound } = mergeBatch([
    makeBatchItem({
      messageId: 'm1',
      timestamp: 1787435200,
      userId: '2260757842',
      content: '',
      sender: { nickname: '御娘狼三千', card: '', displayName: '御娘狼三千' },
    }),
    makeBatchItem({
      messageId: 'm2',
      timestamp: 1787435231,
      userId: '3382710099',
      content: '看这张图',
      sender: { nickname: '三²哒锅酱', card: '', displayName: '三²哒锅酱' },
    }),
  ]);

  const out = renderUserContent({ inbound, contextBlocks: [], identity: IDENTITY });
  assert.equal(out.split('\n').length, 1, '空正文不该渲染出一个只有名字的空行');
  assert.ok(out.includes('【三²哒锅酱 (ID: 3382710099)】看这张图'));
  assert.ok(!out.includes('御娘狼三千'));
});

test('整批都没有正文时退回末条身份的单行格式，不产出空串', () => {
  const { inbound } = mergeBatch([
    makeBatchItem({ messageId: 'm1', content: '' }),
    makeBatchItem({
      messageId: 'm2',
      content: '',
      userId: '2260757842',
      sender: { nickname: '御娘狼三千', card: '', displayName: '御娘狼三千' },
    }),
  ]);

  const out = renderUserContent({ inbound, contextBlocks: [], identity: IDENTITY });
  assert.equal(out, '[时间:2026/8/23 05:47:11] 【御娘狼三千 (ID: 2260757842)】');
});

test('[最近群聊消息] 整批排除：触发文本每句话只出现一次（与滑窗排除联动）', () => {
  const sessions = new SessionStore({ windowSize: 15 });
  const sessionId = 'qq:group:707423412';
  // recordToWindow 的等价写入：批次里的每条都已入窗，另有一条无关旧消息
  sessions.recordContext(sessionId, { messageId: 'm0', nickname: 'linyuan', text: '更早的一句', userId: '111' });
  sessions.recordContext(sessionId, { messageId: 'm1', nickname: 'qqqq819_01', text: '瑞姬看看这个', userId: '2260757842' });
  sessions.recordContext(sessionId, { messageId: 'm2', nickname: '三²哒锅酱', text: '对，就是这个', userId: '3382710099' });

  const { inbound } = mergeBatch([
    makeBatchItem({
      messageId: 'm1',
      timestamp: 1787435200,
      userId: '2260757842',
      content: '瑞姬看看这个',
      sender: { nickname: 'qqqq819_01', card: '', displayName: 'qqqq819_01' },
    }),
    makeBatchItem({
      messageId: 'm2',
      timestamp: 1787435231,
      userId: '3382710099',
      content: '对，就是这个',
      sender: { nickname: '三²哒锅酱', card: '', displayName: '三²哒锅酱' },
    }),
  ]);

  const recent = sessions.renderContext(
    sessionId,
    15,
    inbound.extensions.batch.map((b) => b.messageId),
  );
  const out = renderUserContent({
    inbound,
    contextBlocks: [createContextBlock({ source: 'local-window', text: recent, metadata: { slot: 'recent' } })],
    identity: IDENTITY,
  });

  assert.ok(out.startsWith('[最近群聊消息]'));
  assert.ok(out.includes('更早的一句'), '无关旧消息应保留在滑窗里');
  assert.ok(!recent.includes('瑞姬看看这个'), '先到的批次消息不该留在滑窗里');
  assert.ok(!recent.includes('对，就是这个'), '末条消息不该留在滑窗里');
  assert.equal(out.split('瑞姬看看这个').length - 1, 1, '触发文本中的话不应以滑窗形式重复出现');
  assert.equal(out.split('对，就是这个').length - 1, 1);
});

// ===== 群聊未下载媒体（deferred）：不挂多模态，改为主动拉取提示 =====

test('deferred 图片不挂多模态 parts，改为工具拉取提示', () => {
  const inbound = makeInbound({
    media: [{ kind: 'image', deferred: true, localPath: null, url: 'https://x/y.png', fileId: 'A.png' }],
  });
  const out = renderUserMessage({ inbound, contextBlocks: [], identity: IDENTITY });

  assert.equal(typeof out, 'string', '没有可挂的图就返回纯文本，不能有 image_url part');
  assert.ok(out.includes('[未下载的媒体]'));
  assert.ok(out.includes('get_image_detail(file=A.png)'));
});

test('deferred 图与已落盘图混排：只挂已落盘那张，提示里带 deferred 的 fileId', () => {
  const inbound = makeInbound({
    media: [
      { kind: 'image', localPath: 'F:/received_images/a.png', origin: 'message', originAuthor: '甲' },
      { kind: 'image', deferred: true, localPath: null, url: 'https://x/y.png', fileId: 'B.png' },
    ],
  });
  const parts = renderUserMessage({ inbound, contextBlocks: [], identity: IDENTITY });

  assert.ok(Array.isArray(parts));
  assert.equal(parts.filter((p) => p.type === 'image_url').length, 1, 'deferred 图不得进 parts');
  assert.ok(parts[0].text.includes('[未下载的媒体]'));
  assert.ok(parts[0].text.includes('get_image_detail(file=B.png)'));
  assert.ok(parts[1].text.startsWith('[图1:'), '编号只数真正挂上去的图，说明牌仍从图1开始');
});

test('deferred 文件提示带 file_id / busid 与群文件工具用法', () => {
  const inbound = makeInbound({
    media: [{
      kind: 'file', deferred: true, localPath: null,
      fileId: 'FID-1', busid: 102, name: 'Player.log', sizeBytes: 20480,
    }],
  });
  const out = renderUserMessage({ inbound, contextBlocks: [], identity: IDENTITY });

  assert.ok(out.includes('download_group_file(group_id=707423412, file_id=FID-1, busid=102)'));
  assert.ok(out.includes('download_chat_file(file=FID-1)'));
  assert.ok(out.includes('Player.log'));
});

test('没有 deferred 项时 Prompt 一字不变（不改动私聊/唤醒消息）', () => {
  const inbound = makeInbound({ media: [{ kind: 'image', localPath: 'F:/a.png' }] });
  const out = renderUserMessage({ inbound, contextBlocks: [], identity: IDENTITY });
  assert.ok(!JSON.stringify(out).includes('未下载的媒体'));
});

// ===== directMediaParts=false：图片不直挂多模态，改为路径 + 工具提示 =====

test('directMediaParts=false 时不推 image_url，改为本地路径 + vision_analyze 提示', () => {
  const inbound = makeInbound({
    media: [{ kind: 'image', localPath: 'F:/received_images/a.png', url: 'https://x/y.png' }],
  });
  const out = renderUserMessage({ inbound, contextBlocks: [], identity: IDENTITY, directMediaParts: false });

  assert.equal(typeof out, 'string', '关闭直挂后必须是纯文本，不能有 image_url part');
  assert.ok(!JSON.stringify(out).includes('image_url'), '任何位置都不得残留 image_url');
  assert.ok(out.includes('F:/received_images/a.png'), '要给本地绝对路径');
  assert.ok(out.includes('vision_analyze'), '要提示模型按需调用图片分析工具');
  assert.ok(out.includes('[图1:'), '归属说明牌要保留');
  assert.ok(!out.includes('https://x/y.png'), '有本地副本时优先给本地路径而非直链');
});

test('directMediaParts=false 时引用机器人自己的图仍保留归属说明', () => {
  const inbound = makeInbound({
    media: [{ kind: 'image', origin: 'quote', originAuthor: '瑞姬', originIsBot: true, localPath: 'F:/received_images/q.png' }],
  });
  const out = renderUserMessage({ inbound, contextBlocks: [], identity: IDENTITY, directMediaParts: false });

  assert.ok(out.includes('原作者: 瑞姬'));
  assert.ok(out.includes('即你自己'));
  assert.ok(out.includes('并非本条消息发送者发来的'));
  assert.equal(typeof out, 'string');
});

test('directMediaParts=false 且无本地副本时退回下载直链提示', () => {
  const inbound = makeInbound({ media: [{ kind: 'image', url: 'https://x/only.png' }] });
  const out = renderUserMessage({ inbound, contextBlocks: [], identity: IDENTITY, directMediaParts: false });

  assert.ok(out.includes('https://x/only.png'));
  assert.ok(out.includes('vision_analyze'));
});

test('directMediaParts=false 与 deferred 混排：都进纯文本，仍不产生 parts', () => {
  const inbound = makeInbound({
    media: [
      { kind: 'image', localPath: 'F:/received_images/a.png', origin: 'message', originAuthor: '甲' },
      { kind: 'image', deferred: true, localPath: null, url: 'https://x/y.png', fileId: 'B.png' },
    ],
  });
  const out = renderUserMessage({ inbound, contextBlocks: [], identity: IDENTITY, directMediaParts: false });

  assert.equal(typeof out, 'string');
  assert.ok(out.includes('F:/received_images/a.png'), '已落盘图给路径');
  assert.ok(out.includes('vision_analyze'));
  assert.ok(out.includes('[未下载的媒体]'), 'deferred 图仍走工具回捞提示');
  assert.ok(out.includes('get_image_detail(file=B.png)'));
});

test('directMediaParts=false 且无图时 Prompt 一字不变', () => {
  const out = renderUserMessage({ inbound: makeInbound(), contextBlocks: [], identity: IDENTITY, directMediaParts: false });
  assert.equal(typeof out, 'string');
  assert.ok(!out.includes('vision_analyze'));
  assert.ok(!out.includes('收到图片'));
});

test('renderAttachedMediaToolHint 对空/无位置信息的图返回空串', () => {
  assert.equal(renderAttachedMediaToolHint([]), '');
  assert.equal(renderAttachedMediaToolHint(undefined), '');
  assert.equal(renderAttachedMediaToolHint([{ kind: 'image' }]), '');
});

// ===== /see：显式把图片隔离出主上下文，强制走本地识图工具 =====

/** 一条带本地副本图片、正文可覆写的群消息 */
function seeInbound(overrides = {}) {
  return makeInbound({
    media: [{ kind: 'image', localPath: 'F:/received_images/see.png', url: 'https://x/see.png', origin: 'message', originAuthor: '甲' }],
    ...overrides,
  });
}

test('isSeeCommand：正文 /see / 名字呼唤 / 引用正文 / 合并批次命中，/seems 不误判', () => {
  assert.equal(isSeeCommand(seeInbound({ text: '/see', content: '/see' }), { botName: '瑞姬' }), true);
  assert.equal(isSeeCommand(seeInbound({ text: '/see 这张图', content: '/see 这张图' }), { botName: '瑞姬' }), true);
  assert.equal(isSeeCommand(seeInbound({ text: '瑞姬 /see 这张图', content: '瑞姬 /see 这张图' }), { botName: '瑞姬' }), true, '带名字呼唤前缀同样命中');
  assert.equal(isSeeCommand(seeInbound({ text: '', content: '', extensions: { quote: { summary: '[引用 甲 的消息: /see 帮我看看]' } } }), { botName: '瑞姬' }), true, '引用正文带 /see 也算命中');
  assert.equal(isSeeCommand(seeInbound({ text: '', content: '', extensions: { batch: [{ content: '/see 这张图' }] } }), { botName: '瑞姬' }), true, '防抖合并批次任意一条命中即命中');
  assert.equal(isSeeCommand(seeInbound({ text: '/seems fine', content: '/seems fine' }), { botName: '瑞姬' }), false, '/seems 不是指令');
  assert.equal(isSeeCommand(seeInbound({ text: '看看 /see 这个词', content: '看看 /see 这个词' }), { botName: '瑞姬' }), false, '非行首的 /see 不当作指令');
  assert.equal(isSeeCommand(null), false);
});

test('/see 命中时即使 directMediaParts=true 也绝不挂 image_url，末尾注入强指令', () => {
  const inbound = seeInbound({ text: '/see 这张图', content: '/see 这张图' });
  const out = renderUserMessage({ inbound, contextBlocks: [], identity: IDENTITY, directMediaParts: true });

  assert.equal(typeof out, 'string', '/see 后必须是纯文本，不能有 image_url part');
  assert.ok(!JSON.stringify(out).includes('image_url'), '任何位置都不得残留 image_url');
  assert.ok(out.includes('F:/received_images/see.png'), '必须给出本地绝对路径');
  assert.ok(out.includes('vision_analyze'), '必须指向本地识图工具');
  assert.ok(out.includes('[图1:'), '归属说明牌保留');
  assert.ok(out.endsWith(SEE_MODE_NOTICE), '强指令必须排在 Prompt 末尾');
});

test('/see 无图也会注入强指令（用户显式发起，不得静默失效）', () => {
  const inbound = makeInbound({ text: '/see', content: '/see', media: [] });
  const out = renderUserMessage({ inbound, contextBlocks: [], identity: IDENTITY, directMediaParts: true });
  assert.equal(typeof out, 'string');
  assert.ok(out.endsWith(SEE_MODE_NOTICE));
});

test('/see 与 deferred 混排：已落盘图给路径，未落盘图仍走回捞提示', () => {
  const inbound = makeInbound({
    text: '/see 两张图',
    content: '/see 两张图',
    media: [
      { kind: 'image', localPath: 'F:/received_images/a.png', origin: 'message', originAuthor: '甲' },
      { kind: 'image', deferred: true, localPath: null, url: 'https://x/b.png', fileId: 'B.png' },
    ],
  });
  const out = renderUserMessage({ inbound, contextBlocks: [], identity: IDENTITY, directMediaParts: true });

  assert.equal(typeof out, 'string');
  assert.ok(out.includes('F:/received_images/a.png'), '已落盘图给路径');
  assert.ok(out.includes('[未下载的媒体]'), 'deferred 图仍走工具回捞提示');
  assert.ok(out.includes('get_image_detail(file=B.png)'));
  assert.ok(out.endsWith(SEE_MODE_NOTICE));
});

test('directMediaParts=true 且未命中 /see 时照旧走多模态 parts（回归）', () => {
  const inbound = seeInbound({ text: '这张图好看吗', content: '这张图好看吗' });
  const out = renderUserMessage({ inbound, contextBlocks: [], identity: IDENTITY, directMediaParts: true });
  assert.ok(Array.isArray(out), '默认行为不变：有图就是多模态 parts');
  assert.ok(JSON.stringify(out).includes('image_url'));
  assert.ok(!JSON.stringify(out).includes(SEE_MODE_NOTICE));
});

test('世界书主动维护常驻提示：置于所有分支 systemText 尾部、不混入 userMessage、且绝不重复出现两次', () => {
  assert.ok(LOREBOOK_MAINTENANCE_NOTICE.includes('search_lorebook_entries'));
  assert.ok(LOREBOOK_MAINTENANCE_NOTICE.includes('lorebook_add_entry'));
  assert.ok(LOREBOOK_MAINTENANCE_NOTICE.includes('lorebook_update_entry'));
  assert.ok(LOREBOOK_MAINTENANCE_NOTICE.includes('lorebook_delete_entry'));

  const branches = [
    { label: '主人群聊@', inbound: makeInbound({ userId: IDENTITY.ownerId }), triggerType: 'at' },
    { label: '普通群友@', inbound: makeInbound({ userId: '2260757842' }), triggerType: 'at' },
    { label: '群聊名字呼唤', inbound: makeInbound({ userId: '2260757842' }), triggerType: 'keyword' },
    { label: '群聊主动插话', inbound: makeInbound({ userId: '2260757842' }), triggerType: 'ai_decision' },
    { label: '私聊', inbound: makeInbound({ userId: '2260757842', messageType: 'private', groupId: null }), triggerType: 'at' },
  ];

  for (const b of branches) {
    const blocks = [
      createContextBlock({
        source: 'favour_ultra',
        text: `<FavorabilityPlugin><Rules>rules</Rules></FavorabilityPlugin>\n\n${LOREBOOK_MAINTENANCE_NOTICE}`,
        metadata: { slot: 'extra' },
      }),
      createContextBlock({
        source: 'lorebook',
        text: LOREBOOK_MAINTENANCE_NOTICE,
        dedupeKey: 'lorebook-maintenance-hint',
        metadata: { slot: 'lorebook_maintenance' },
      }),
    ];
    const systemText = renderSystemText({
      inbound: b.inbound,
      contextBlocks: blocks,
      triggerType: b.triggerType,
      affectionContext: null,
      identity: IDENTITY,
    });
    const userMessage = renderUserMessage({
      inbound: b.inbound,
      contextBlocks: blocks,
      triggerType: b.triggerType,
      affectionContext: null,
      identity: IDENTITY,
    });

    assert.ok(systemText.endsWith(LOREBOOK_MAINTENANCE_NOTICE), `${b.label} 分支应将维护提示置于 systemText 尾部`);
    assert.equal(
      systemText.split(LOREBOOK_MAINTENANCE_NOTICE).length - 1,
      1,
      `${b.label} 分支的 systemText 中维护提示必须恰好出现 1 次`,
    );
    assert.equal(
      String(userMessage).includes('[世界书维护:'),
      false,
      `${b.label} 分支的 userMessage 不得混入维护提示`,
    );
  }

  // 开关关闭时不再注入
  const disabledSystem = renderSystemText({
    inbound: makeInbound(),
    contextBlocks: [],
    lorebook: { maintenanceHint: false },
  });
  assert.equal(disabledSystem.includes('[世界书维护:'), false, 'maintenanceHint=false 时应关闭维护提示');
  assert.equal(resolveLorebookMaintenanceHint({ maintenanceHint: false }), '');
  assert.equal(resolveLorebookMaintenanceHint({ maintenanceHint: '自定义维护指令' }), '自定义维护指令');
});
