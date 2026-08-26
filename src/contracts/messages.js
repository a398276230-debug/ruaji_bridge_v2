/**
 * contracts/messages.js — Bridge 内部领域对象
 *
 * Bridge 主流程绝不直接传递 NapCat 原始事件对象。所有 NapCat 字段兼容逻辑
 * 集中在 adapters/napcat/inbound-normalizer.js，之后一律走这里定义的规范对象。
 */

import { randomUUID } from 'node:crypto';

export const MESSAGE_TYPES = Object.freeze({ GROUP: 'group', PRIVATE: 'private' });

export const SEGMENT_TYPES = Object.freeze({
  TEXT: 'text',
  AT: 'at',
  IMAGE: 'image',
  FILE: 'file',
  REPLY: 'reply',
  FACE: 'face',
  UNKNOWN: 'unknown',
});

/** 会话 ID：qq:group:123 / qq:private:456。全链路唯一的会话维度键。 */
export function buildSessionId(platform, messageType, id) {
  return `${platform}:${messageType}:${id}`;
}

/**
 * 执行维度键：与 sessionId 同粒度，用于生成互斥锁与打断。
 * 旧 Bridge 用 `group_<gid>` / `private_<uid>`（bridge.js:1718-1719），
 * 模型会话头也复用它，这里保留同一形态，以便 Hermes 会话不断档。
 */
export function buildExecutionKey(messageType, id) {
  return `${messageType}_${id}`;
}

/**
 * @typedef {object} InboundMessage
 */
export function createInboundMessage(input = {}) {
  const messageType = input.messageType === MESSAGE_TYPES.GROUP ? MESSAGE_TYPES.GROUP : MESSAGE_TYPES.PRIVATE;
  const platform = input.platform || 'qq';
  const targetId = messageType === MESSAGE_TYPES.GROUP ? input.groupId : input.userId;

  return {
    eventId: input.eventId || randomUUID(),
    correlationId: input.correlationId || randomUUID(),
    messageId: String(input.messageId ?? ''),
    timestamp: Number.isFinite(input.timestamp) ? input.timestamp : Math.floor(Date.now() / 1000),

    platform,
    selfId: String(input.selfId ?? ''),
    userId: String(input.userId ?? ''),
    groupId: input.groupId == null ? null : String(input.groupId),
    sessionId: input.sessionId || buildSessionId(platform, messageType, targetId),
    executionKey: input.executionKey || buildExecutionKey(messageType, targetId),
    messageType,

    /** 原始 raw_message（含 CQ 码），用于精确判定与审计 */
    rawMessage: String(input.rawMessage ?? ''),
    /** 剔除所有 CQ 码后的纯文本，用于唤醒判定与命令识别 */
    text: String(input.text ?? ''),
    /** 面向模型的正文（@ 转成 " @瑞姬 "、引用与文件摘要已前置） */
    content: String(input.content ?? input.text ?? ''),
    segments: Array.isArray(input.segments) ? input.segments : [],

    sender: {
      nickname: String(input.sender?.nickname ?? ''),
      card: String(input.sender?.card ?? ''),
      /** card || nickname || uid —— 旧 Bridge bridge.js:1256 的显示名规则 */
      displayName: String(input.sender?.displayName ?? ''),
    },

    flags: {
      isSelf: input.flags?.isSelf === true,
      isOwner: input.flags?.isOwner === true,
      isAtBot: input.flags?.isAtBot === true,
      isNameCall: input.flags?.isNameCall === true,
      isCommand: input.flags?.isCommand === true,
      hasImage: input.flags?.hasImage === true,
      hasFile: input.flags?.hasFile === true,
      hasQuote: input.flags?.hasQuote === true,
    },

    /** 本地落盘媒体：{ kind, localPath, url, mime, name, sizeBytes } */
    media: Array.isArray(input.media) ? input.media : [],

    extensions: {
      napcat: input.extensions?.napcat ?? {},
      ...(input.extensions || {}),
    },
  };
}

/** ModelRequest：编排层交给 Model Adapter 的唯一入参 */
export function createModelRequest(input = {}) {
  return {
    correlationId: input.correlationId,
    sessionId: input.sessionId,
    /** Hermes 会话隔离键，adapter 内部翻译成 X-Hermes-Session-Id */
    sessionKey: input.sessionKey || null,
    model: input.model,
    messages: Array.isArray(input.messages) ? input.messages : [],
    contextBlocks: Array.isArray(input.contextBlocks) ? input.contextBlocks : [],
    tools: Array.isArray(input.tools) ? input.tools : [],
    generation: input.generation || {},
    stream: input.stream !== false,
  };
}

/** ModelResponse：Adapter 归一后的模型输出 */
export function createModelResponse(input = {}) {
  return {
    correlationId: input.correlationId,
    /** 模型响应的稳定标识，好感度写入按它幂等去重 */
    responseId: input.responseId || randomUUID(),
    model: input.model,
    role: 'assistant',
    rawText: String(input.rawText ?? ''),
    toolCalls: Array.isArray(input.toolCalls) ? input.toolCalls : [],
    usage: {
      inputTokens: input.usage?.inputTokens ?? 0,
      outputTokens: input.usage?.outputTokens ?? 0,
    },
    latencyMs: Number.isFinite(input.latencyMs) ? input.latencyMs : 0,
  };
}

/** OutboundMessage：Middleware Pipeline 的产物，交给 outbound-builder 转 NapCat payload */
export function createOutboundMessage(input = {}) {
  return {
    correlationId: input.correlationId,
    sessionId: input.sessionId,
    /** 幂等发送事务 ID：同一 txId 只会真正投递一次 */
    txId: input.txId || randomUUID(),
    target: {
      type: input.target?.type === MESSAGE_TYPES.GROUP ? MESSAGE_TYPES.GROUP : MESSAGE_TYPES.PRIVATE,
      id: String(input.target?.id ?? ''),
    },
    /** 触发本次回复的用户，群聊首段 @ 用 */
    replyToUserId: input.replyToUserId == null ? null : String(input.replyToUserId),
    text: String(input.text ?? ''),
    segments: Array.isArray(input.segments) ? input.segments : [],
    metadata: {
      isFirst: input.metadata?.isFirst === true,
      /** 主动接话不 @ 任何人（旧 disableAutoMention，bridge.js:670） */
      disableAutoMention: input.metadata?.disableAutoMention === true,
      createdAt: input.metadata?.createdAt ?? Date.now(),
      retry: input.metadata?.retry ?? 0,
      ...(input.metadata || {}),
    },
  };
}
