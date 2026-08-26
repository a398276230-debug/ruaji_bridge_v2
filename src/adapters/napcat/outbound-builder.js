/**
 * adapters/napcat/outbound-builder.js — OutboundMessage → NapCat payload
 *
 * 两件事：
 *   1. 首段 @ 发送者（群聊，且未禁用自动 @）
 *   2. CQ 码转义：真图片/真 @ 放行，其余字面 CQ 码实体化，防止模型输出的
 *      "[CQ:xxx]" 被 NapCat 当成指令执行
 *
 * 迁移自 bridge.js:650-679。
 */

import { MESSAGE_TYPES } from '../../contracts/messages.js';
import { buildAtCq } from './cq.js';

/**
 * 转义字面 CQ 码。
 * 放行条件（与旧实现一致）：
 *   - image 且 file=file:///<盘符>:  → 真的本地图片
 *   - at 且 qq=数字                  → 真的 @
 * 其余一律实体化成 &#91;CQ:…&#93;
 */
export function escapeLiteralCqCodes(text) {
  return String(text ?? '').replace(/\[CQ:(\w+)([^\]]*)\]/g, (match, type, attrs) => {
    if (type === 'image' && /file=file:\/\/\/[A-Za-z]:/.test(attrs)) return match;
    if (type === 'at' && /qq=\d+/.test(attrs)) return match;
    return match.replace('[CQ:', '&#91;CQ:').replace(']', '&#93;');
  });
}

/** 主动接话不得 @ 任何人（旧 disableAutoMention 分支，bridge.js:670-675） */
export function stripMentions(text) {
  return String(text ?? '')
    .replace(/\[CQ:at,qq=\d+\]/gi, '')
    .replace(/@所有人/g, '')
    .trim();
}

/**
 * @param {object} outbound  OutboundMessage
 * @returns {{ isGroup: boolean, targetId: string, message: string }|null}
 *          message 为空时返回 null —— 空消息不该打到 NapCat
 */
export function buildNapcatPayload(outbound) {
  let text = String(outbound.text ?? '');

  if (outbound.metadata.disableAutoMention) {
    text = stripMentions(text);
  }
  text = escapeLiteralCqCodes(text);
  if (!text.trim()) return null;

  const isGroup = outbound.target.type === MESSAGE_TYPES.GROUP;
  const shouldMention =
    isGroup && outbound.metadata.isFirst && !outbound.metadata.disableAutoMention && outbound.replyToUserId;

  const message = shouldMention ? `${buildAtCq(outbound.replyToUserId)} ${text}` : text;

  return { isGroup, targetId: outbound.target.id, message };
}
