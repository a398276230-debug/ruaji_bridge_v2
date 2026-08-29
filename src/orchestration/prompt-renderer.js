/**
 * orchestration/prompt-renderer.js — Prompt 渲染
 *
 * 负责 systemText 与 userContent 的格式化和组装。
 * 从 ContextBlock 的 metadata.slot 取值进行结构化合并。
 *
 * slot 约定：
 *   voice   ruaji 语气画像（只对主人分支作为开头）
 *   meme    表情包语义工具规则
 *   slang   按需召回的黑话词条
 *   recent  最近群聊消息（进 userContent 前缀，不进 systemText）
 *   其余     追加在 slang 之后
 */

import { TRIGGER_TYPES } from '../contracts/capabilities.js';
import { MESSAGE_TYPES } from '../contracts/messages.js';

/** 三段固定的交互情境提示（bridge.js:769-774），仅群聊注入 */
export const TRIGGER_NOTICES = Object.freeze({
  [TRIGGER_TYPES.AI_DECISION]:
    '\n[交互情境: 群聊主动插话] 注意，群友并没有直接 @你 或呼唤你。你是在围观群友聊天时根据当前氛围觉得有趣，主动自然地插嘴接几句/吐槽/跟聊。请保持随和慵懒的群友朋友姿态，不要表现出‘你在被命令或专门被提问’的样子，像日常闲聊一样自然搭腔。',
  [TRIGGER_TYPES.KEYWORD]:
    '\n[交互情境: 提及名字] 注意，群友对话中提到了你的名字/相关信息，请先结合上下文判断是在跟你说话还是在聊关于你的事，自然参与。',
  [TRIGGER_TYPES.AT]:
    '\n[交互情境: 直接@呼唤] 注意，现在群友在直接@你并向你发问/对话，请正面互动。',
});

/**
 * 消息时间格式化（bridge.js:252-275）。
 * OneBot time 可能是秒或毫秒；一律按 Asia/Shanghai 24 小时制渲染。
 */
export function formatMsgTime(eventTime) {
  let d;
  if (eventTime != null && eventTime !== '') {
    const n = Number(eventTime);
    d = Number.isFinite(n) && n > 0 ? new Date(n < 1e12 ? n * 1000 : n) : new Date();
  } else {
    d = new Date();
  }
  if (Number.isNaN(d.getTime())) d = new Date();

  return d.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** systemText / userContent 认得的 slot；其余一律归到 extra */
const SLOT_NAMES = ['voice', 'meme', 'slang', 'recent', 'extra'];

/** 把 ContextBlock 数组按 slot 分组 */
export function groupBySlot(blocks) {
  const slots = { voice: [], meme: [], slang: [], recent: [], extra: [] };
  for (const block of blocks ?? []) {
    const raw = block.metadata?.slot ?? 'extra';
    // slot 可能来自远程 Provider 的 JSON（coerceContextBlocks 会取 item.detail.slot）。
    // 不能直接拿它索引 slots：'constructor'/'toString' 这类键会命中 Object.prototype
    // 返回函数而非 undefined，?? 兜不住，.push 当场抛 TypeError 让整轮回复失败。
    const slot = SLOT_NAMES.includes(raw) ? raw : 'extra';
    slots[slot].push(block.text.trim());
  }
  return {
    voice: slots.voice.join('\n'),
    meme: slots.meme.join('\n'),
    slang: slots.slang.join('\n'),
    recent: slots.recent.join('\n'),
    extra: slots.extra.join('\n'),
  };
}

/**
 * 渲染 systemText（隐式注入，独立的 system 角色，不污染用户消息正文）。
 *
 * @param {object} input
 * @param {object} input.inbound      InboundMessage
 * @param {object[]} input.contextBlocks
 * @param {string} input.triggerType
 * @param {object|null} input.affectionContext  { affection, level } —— 主人与主动接话传 null
 * @param {object} input.identity     { ownerId }
 * @returns {string}
 */
export function renderSystemText({ inbound, contextBlocks, triggerType, affectionContext, identity }) {
  const slots = groupBySlot(contextBlocks);
  const isGroup = inbound.messageType === MESSAGE_TYPES.GROUP;
  const isOwner = String(inbound.userId) === String(identity.ownerId);
  const isProactive = triggerType === TRIGGER_TYPES.AI_DECISION;

  const triggerNotice = isGroup ? (TRIGGER_NOTICES[triggerType] ?? TRIGGER_NOTICES[TRIGGER_TYPES.AT]) : '';
  const memePart = slots.meme ? `\n${slots.meme}` : '';
  const slangPart = slots.slang ? `\n${slots.slang}` : '';
  const extraPart = slots.extra ? `\n${slots.extra}` : '';

  const sessionEnv = isGroup
    ? `\n[当前会话: QQ群聊 (群号: ${inbound.groupId})]`
    : '\n[当前会话: QQ私聊]';

  const knowledgeNotice =
    '\n[知识与工具认知: 你的底层数据库存在时效延后，且并非全知全能。遇到不确定、具有时效性或涉及具体事实/机制的提问时，必须主动使用搜索工具与群聊记忆检索，以获取最新且准确的真实信息，切勿凭空编造。]';

  // 分支 1/2：主人，以及主动接话。
  // 主动接话本身不构成与任何群友的互动，不注入也不评估好感度。
  if (isOwner || isProactive) {
    return `${slots.voice}${memePart}${slangPart}${extraPart}${triggerNotice}${sessionEnv}${knowledgeNotice}`;
  }

  // 分支 3：普通群友/私聊对象
  const senderName = inbound.sender?.displayName || inbound.sender?.nickname || inbound.sender?.name || '群友';
  const header = `[用户: ${senderName}(${inbound.userId}) | ${
    isGroup ? `群${inbound.groupId}` : '私聊'
  }]`;

  let affLine = '';
  if (affectionContext) {
    const relStr = affectionContext.relationship ? ` | 关系: ${affectionContext.relationship}${affectionContext.is_unique ? '★(独占)' : ''}` : '';
    const portrayalStr = affectionContext.portrayal ? `\n[${affectionContext.portrayal}]` : '';

    if (affectionContext.isColdViolent) {
      affLine = `\n[好感: ${affectionContext.affection}/90 (${affectionContext.level})${relStr} | 状态: ❄️冷暴力惩罚中(剩余${affectionContext.coldRemainingMinutes}分)，态度需极度冷淡疏离、极简敷衍，严禁热心迎合 | 另起一行末尾附 [AFF:±N|理由]]${portrayalStr}`;
    } else if (affectionContext.atMin) {
      affLine = `\n[好感: ${affectionContext.affection}/90 (${affectionContext.level})${relStr} | 当前好感已达下限-100，无法继续扣分 | 另起一行末尾附 [AFF:±N|理由]]${portrayalStr}`;
    } else if (affectionContext.affection < 0) {
      affLine = `\n[好感: ${affectionContext.affection}/90 (${affectionContext.level})${relStr} | 状态: 负好感警戒区，态度需戒备、冷漠或带刺，拒绝亲密互动 | 另起一行末尾附 [AFF:±N|理由]]${portrayalStr}`;
    } else if (affectionContext.atMax) {
      affLine = `\n[好感: ${affectionContext.affection}/90 (${affectionContext.level})${relStr} | 当前好感已达上限90，禁止输出正向加分，仅允许[AFF:0|...]持平或负向扣分 | 另起一行末尾附 [AFF:±N|理由]]${portrayalStr}`;
    } else {
      affLine = `\n[好感: ${affectionContext.affection}/90 (${affectionContext.level})${relStr} | 另起一行末尾附 [AFF:±N|理由]]${portrayalStr}`;
    }
  }

  return `${header}${affLine}${memePart}${slangPart}${extraPart}${triggerNotice}${sessionEnv}${knowledgeNotice}`;
}

/**
 * 渲染 userContent（显式部分）。用户消息体保持纯净：
 * 只有 [时间:…] 【昵称】原话，元数据一律走 systemText。
 *
 * @param {object} input
 * @param {object} input.inbound
 * @param {object[]} input.contextBlocks
 * @param {object} input.identity
 * @returns {string}
 */
export function renderUserContent({ inbound, contextBlocks, identity }) {
  const slots = groupBySlot(contextBlocks);
  const batch = inbound.extensions?.batch;

  let stamped = null;
  if (Array.isArray(batch) && batch.length > 1) {
    // 防抖合并批次：一行一条、各标各的名（P1）。逐条按该条 userId 判定主人短格式，
    // 与单条路径的格式规则一致。空正文（纯媒体消息）不占行——与 mergeBatch 拼
    // content 时的 filter(Boolean) 同口径，也顺手滤掉手搓 batch 里的非对象项。
    const lines = batch
      .filter((item) => item && String(item.content ?? '').trim())
      .map((item) => {
        const itemOwner = String(item.userId) === String(identity.ownerId);
        const who = itemOwner
          ? `【${item.displayName || 'ruaji'}】`
          : `【${item.displayName} (ID: ${item.userId})】`;
        return `[时间:${formatMsgTime(item.timestamp)}] ${who}${item.content}`;
      });
    if (lines.length > 0) stamped = lines.join('\n');
  }

  if (stamped === null) {
    // 单条，或整批都没有正文（纯媒体批次）：退回末条身份的单行格式
    const isOwner = String(inbound.userId) === String(identity.ownerId);
    const timeStr = formatMsgTime(inbound.timestamp);
    const who = isOwner
      ? `【${inbound.sender.displayName || 'ruaji'}】`
      : `【${inbound.sender.displayName} (ID: ${inbound.userId})】`;

    stamped = `[时间:${timeStr}] ${who}${inbound.content}`;
  }

  if (inbound.messageType === MESSAGE_TYPES.GROUP && slots.recent) {
    stamped = `[最近群聊消息]\n${slots.recent}\n\n${stamped}`;
  }
  return stamped;
}

/**
 * 多模态用户消息：有本地图片时转成 OpenAI content parts。
 *
 * 旧 Bridge 优先用 URL 省 token（bridge.js:898-908）。v2 保留这个偏好，
 * 但同时把本地绝对路径挂在 metadata 里（附录 2），让模型侧工具能直接读文件。
 */
export function renderUserMessage({ inbound, contextBlocks, identity }) {
  const text = renderUserContent({ inbound, contextBlocks, identity });
  const images = (inbound.media ?? []).filter((m) => m.kind === 'image');
  if (images.length === 0) return text;

  const parts = [{ type: 'text', text }];
  for (const image of images) {
    if (image.url) {
      parts.push({ type: 'image_url', image_url: { url: image.url } });
    } else if (image.localPath) {
      parts.push({ type: 'image_url', image_url: { url: `file:///${image.localPath.replace(/\\/g, '/')}` } });
    }
  }
  return parts;
}

/**
 * 本地文件清单：把落盘路径以纯文本形式补进 systemText 尾部，
 * 让模型知道"这些文件在本地，可以直接按路径读"（附录 2）。
 */
export function renderLocalMediaHint(inbound) {
  const items = (inbound.media ?? []).filter((m) => m.localPath);
  if (!items.length) return '';
  const lines = items.map((m) => `- ${m.kind === 'image' ? '图片' : '文件'}: ${m.localPath}`);
  return `[本轮消息附带的本地文件，可直接按绝对路径读取]\n${lines.join('\n')}`;
}
