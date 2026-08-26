/**
 * contracts/events.js — 统一事件协议
 *
 * v2 首期定义四个核心生命周期事件。所有事件共用同一信封，含 eventVersion 与
 * correlationId，使一次 QQ 消息的完整链路（接收 → 请求模型 → 模型返回 → 发送完成）
 * 可以在日志中串起来。
 *
 * 事件是广播型的：订阅者不能修改 payload，也不能阻塞主回复链路。
 */

import { randomUUID } from 'node:crypto';

export const EVENT_VERSION = '1';

export const EVENTS = Object.freeze({
  MESSAGE_RECEIVED: 'message.received',
  LLM_REQUEST: 'llm.request',
  LLM_RESPONSE: 'llm.response',
  MESSAGE_SENT: 'message.sent',
});

export const ALL_EVENTS = Object.freeze(Object.values(EVENTS));

/** 深冻结，保证订阅者拿到的 payload 不可变、也不与主流程共享可变引用 */
export function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    const child = value[key];
    if (child && typeof child === 'object') deepFreeze(child);
  }
  return value;
}

/**
 * 构造事件信封。
 * @param {string} event        EVENTS 中的事件名
 * @param {object} opts
 * @param {string} opts.correlationId 全链路追踪 ID（同一条 QQ 消息全程一致）
 * @param {string} opts.sessionId     qq:group:123 / qq:private:456
 * @param {object} opts.payload
 * @param {number} [opts.timestamp]   秒级时间戳，默认当前时间
 */
export function createEvent(event, { correlationId, sessionId, payload = {}, timestamp } = {}) {
  if (!ALL_EVENTS.includes(event)) {
    throw new TypeError(`未知事件: ${event}`);
  }
  if (!correlationId) throw new TypeError(`事件 ${event} 缺少 correlationId`);
  if (!sessionId) throw new TypeError(`事件 ${event} 缺少 sessionId`);

  return deepFreeze({
    event,
    eventVersion: EVENT_VERSION,
    eventId: randomUUID(),
    correlationId,
    timestamp: timestamp ?? Math.floor(Date.now() / 1000),
    sessionId,
    payload,
  });
}

export function newCorrelationId() {
  return randomUUID();
}
