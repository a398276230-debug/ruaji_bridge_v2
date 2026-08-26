/**
 * contracts/capabilities.js — 能力名与调用语义
 *
 * Bridge 主流程只依赖能力名，永远不依赖插件名。
 * 验收标准 5：主流程不写死具体插件名称。
 */

export const CAPABILITIES = Object.freeze({
  /** request：群聊是否回复的裁决。单 Provider + 优先级 + 本地兜底 */
  DECISION_GROUP_REPLY: 'decision.group_reply',
  /** collect：并行聚合所有上下文提供者 */
  CONTEXT_ENRICH: 'context.enrich',
  /** collect：长期记忆检索 */
  CONTEXT_LONG_TERM_MEMORY: 'context.long_term_memory',
  /** request：辅助模型视觉打标 */
  VISION_TAG_MEME: 'vision.tag_meme',
  /** request：结果修饰能力（OnDecoratingResultEvent 垫片对接） */
  RESULT_DECORATE: 'result.decorate',
});

export const ALL_CAPABILITIES = Object.freeze(Object.values(CAPABILITIES));

/** 调用模式 */
export const INVOCATION = Object.freeze({
  /** 需要单一结果，按优先级选 Provider，失败则 fallback 到下一个 */
  REQUEST: 'request',
  /** 需要全部结果，并行聚合，失败项丢弃 */
  COLLECT: 'collect',
});

/** decision.group_reply 的归一化裁决结果 */
export const ROUTES = Object.freeze({
  /** 直接回复：被 @、被点名，或裁决者明确要求回复 */
  DIRECT: 'direct',
  /** 主动接话：裁决者认为氛围合适，机器人主动插话 */
  AUTO: 'auto',
  /** 不回复 */
  IGNORE: 'ignore',
});

export const ALL_ROUTES = Object.freeze(Object.values(ROUTES));

/**
 * 把裁决 Provider 的原始返回归一为 v2 route。
 *
 * 旧 GCP（:8877）实测返回过 `direct` / `ignore` / `duplicate` / `none` / 空。
 * `duplicate` 与 `none` 在旧 Bridge 里的效果都是"不进模型"，v2 统一映射到 ignore。
 */
export function normalizeRoute(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === ROUTES.DIRECT) return ROUTES.DIRECT;
  if (value === ROUTES.AUTO || value === 'auto_reply' || value === 'proactive') return ROUTES.AUTO;
  if (value === ROUTES.IGNORE || value === 'duplicate' || value === 'none' || value === '') {
    return ROUTES.IGNORE;
  }
  return ROUTES.IGNORE;
}

/** 触发情境：决定 systemText 中注入哪一段 triggerNotice */
export const TRIGGER_TYPES = Object.freeze({
  AT: 'at',
  KEYWORD: 'keyword',
  AI_DECISION: 'ai_decision',
});
