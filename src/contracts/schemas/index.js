/**
 * contracts/schemas/index.js — 手写 schema 校验器
 *
 * 刻意不引 ajv：v2 首期只有 ws 一个运行时依赖，外部 payload 的校验规则本身
 * 也就这么几条，手写反而更清楚失败在哪一个字段上。
 *
 * 所有校验器统一返回 { valid, errors[] }，不抛异常。
 */

import { ALL_EVENTS, EVENT_VERSION } from '../events.js';
import { ALL_ROUTES } from '../capabilities.js';

function fail(errors) {
  return { valid: false, errors };
}
const OK = Object.freeze({ valid: true, errors: [] });

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 事件信封：验收标准 12（核心事件包含版本与 correlation_id） */
export function validateEventEnvelope(envelope) {
  const errors = [];
  if (!isPlainObject(envelope)) return fail(['envelope 不是对象']);
  if (!ALL_EVENTS.includes(envelope.event)) errors.push(`event 非法: ${envelope.event}`);
  if (envelope.eventVersion !== EVENT_VERSION) errors.push(`eventVersion 应为 ${EVENT_VERSION}`);
  if (typeof envelope.eventId !== 'string' || !envelope.eventId) errors.push('eventId 缺失');
  if (typeof envelope.correlationId !== 'string' || !envelope.correlationId) {
    errors.push('correlationId 缺失');
  }
  if (typeof envelope.sessionId !== 'string' || !envelope.sessionId) errors.push('sessionId 缺失');
  if (!Number.isFinite(envelope.timestamp)) errors.push('timestamp 非法');
  if (!isPlainObject(envelope.payload)) errors.push('payload 不是对象');
  return errors.length ? fail(errors) : OK;
}

/** 插件 manifest */
export function validateManifest(manifest) {
  const errors = [];
  if (!isPlainObject(manifest)) return fail(['manifest 不是对象']);
  if (!manifest.id || typeof manifest.id !== 'string') errors.push('id 缺失');
  if (!manifest.version || typeof manifest.version !== 'string') errors.push('version 缺失');
  if (typeof manifest.enabled !== 'boolean') errors.push('enabled 必须是 boolean');

  const transport = manifest.transport;
  if (transport !== 'http' && transport !== 'local') {
    errors.push(`transport 只支持 http / local，收到 ${transport}`);
  }
  if (transport === 'http') {
    if (!manifest.baseUrl || typeof manifest.baseUrl !== 'string') {
      errors.push('http 插件缺少 baseUrl');
    }
  }

  if (manifest.subscriptions != null && !Array.isArray(manifest.subscriptions)) {
    errors.push('subscriptions 必须是数组');
  }
  for (const sub of manifest.subscriptions || []) {
    const event = typeof sub === 'string' ? sub : sub?.event;
    if (!ALL_EVENTS.includes(event)) errors.push(`订阅了未知事件: ${event}`);
    if (transport === 'http' && typeof sub === 'object' && sub && !sub.path) {
      errors.push(`订阅 ${event} 缺少 path`);
    }
  }

  if (manifest.capabilities != null && !Array.isArray(manifest.capabilities)) {
    errors.push('capabilities 必须是数组');
  }
  for (const cap of manifest.capabilities || []) {
    if (!isPlainObject(cap)) {
      errors.push('capability 项不是对象');
      continue;
    }
    if (!cap.name || typeof cap.name !== 'string') errors.push('capability.name 缺失');
    if (cap.priority != null && !Number.isFinite(cap.priority)) {
      errors.push(`capability ${cap.name} 的 priority 非法`);
    }
    if (transport === 'http' && !cap.path) {
      errors.push(`capability ${cap.name} 缺少 path`);
    }
  }

  return errors.length ? fail(errors) : OK;
}

/** decision.group_reply 的 Provider 响应 */
export function validateDecisionResponse(body) {
  if (!isPlainObject(body)) return fail(['裁决响应不是对象']);
  // route 允许缺失（旧 GCP 返回过空 route），归一化阶段会兜底成 ignore。
  if (body.route != null && typeof body.route !== 'string') {
    return fail(['route 必须是字符串']);
  }
  return OK;
}

/** 归一化后的裁决结果，进入编排层之前的最后一道校验 */
export function validateRoute(route) {
  return ALL_ROUTES.includes(route) ? OK : fail([`route 非法: ${route}`]);
}

/** context.enrich 的 Provider 响应：接受字符串、数组或 { blocks | context } */
export function validateContextResponse(body) {
  if (body == null) return OK;
  if (typeof body === 'string') return OK;
  if (Array.isArray(body)) return OK;
  if (isPlainObject(body)) {
    if (body.blocks != null && !Array.isArray(body.blocks)) return fail(['blocks 必须是数组']);
    if (body.context != null && typeof body.context !== 'string') {
      return fail(['context 必须是字符串']);
    }
    return OK;
  }
  return fail([`上下文响应类型不支持: ${typeof body}`]);
}

/** ModelRequest */
export function validateModelRequest(req) {
  const errors = [];
  if (!isPlainObject(req)) return fail(['ModelRequest 不是对象']);
  if (!req.correlationId) errors.push('correlationId 缺失');
  if (!req.model) errors.push('model 缺失');
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    errors.push('messages 为空');
  } else {
    for (const [i, m] of req.messages.entries()) {
      if (!isPlainObject(m)) {
        errors.push(`messages[${i}] 不是对象`);
        continue;
      }
      if (!['system', 'user', 'assistant', 'tool'].includes(m.role)) {
        errors.push(`messages[${i}].role 非法: ${m.role}`);
      }
      if (m.content == null) errors.push(`messages[${i}].content 缺失`);
    }
  }
  return errors.length ? fail(errors) : OK;
}

/** ModelResponse */
export function validateModelResponse(res) {
  const errors = [];
  if (!isPlainObject(res)) return fail(['ModelResponse 不是对象']);
  if (!res.correlationId) errors.push('correlationId 缺失');
  if (typeof res.rawText !== 'string') errors.push('rawText 必须是字符串');
  if (!isPlainObject(res.usage)) errors.push('usage 缺失');
  return errors.length ? fail(errors) : OK;
}

/** NapCat 入站事件：只校验到能安全归一化为止，不做过度约束 */
export function validateNapcatEvent(event) {
  const errors = [];
  if (!isPlainObject(event)) return fail(['NapCat 事件不是对象']);
  if (typeof event.post_type !== 'string') errors.push('post_type 缺失');
  if (event.post_type === 'message') {
    if (event.user_id == null) errors.push('message 事件缺少 user_id');
    if (event.message_type !== 'group' && event.message_type !== 'private') {
      errors.push(`message_type 非法: ${event.message_type}`);
    }
    if (event.message_type === 'group' && event.group_id == null) {
      errors.push('群消息缺少 group_id');
    }
  }
  return errors.length ? fail(errors) : OK;
}

export function assertValid(result, what) {
  if (!result.valid) {
    throw new TypeError(`${what} 校验失败: ${result.errors.join('; ')}`);
  }
}
