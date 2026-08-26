/**
 * contracts/context-block.js — 上下文块
 *
 * 插件不能直接拼最终 Prompt（旧 Bridge 里 GCP 上下文、本地滑窗、语气画像、
 * 黑话、好感度行各自用字符串拼接，优先级与预算完全失控）。
 * v2 统一返回结构化块，由 Context Aggregator 排序、去重、截断、渲染。
 */

export const CONTEXT_SCOPES = Object.freeze({
  ANY: 'any',
  GROUP: 'group',
  PRIVATE: 'private',
});

/**
 * @param {object} input
 * @param {string} input.source      插件/提供者 id
 * @param {string} input.capability  产出该块的能力名
 * @param {number} [input.priority]  越大越靠前，默认 50
 * @param {string} input.text        上下文正文
 * @param {object} [input.metadata]
 * @param {number} [input.budgetHint] 该块期望占用的字符预算
 * @param {boolean} [input.sensitive] 敏感块：日志中不落正文
 * @param {string} [input.scope]     CONTEXT_SCOPES
 * @param {string} [input.dedupeKey] 同 key 只保留优先级最高的一个
 */
export function createContextBlock(input = {}) {
  const text = typeof input.text === 'string' ? input.text : '';
  return Object.freeze({
    source: String(input.source || 'unknown'),
    capability: String(input.capability || 'context.enrich'),
    priority: Number.isFinite(input.priority) ? Number(input.priority) : 50,
    text,
    metadata: Object.freeze({ ...(input.metadata || {}) }),
    budgetHint: Number.isFinite(input.budgetHint) ? Number(input.budgetHint) : null,
    sensitive: input.sensitive === true,
    scope: input.scope || CONTEXT_SCOPES.ANY,
    dedupeKey: input.dedupeKey || null,
    /** 由聚合器填写：被截断时记录原因，便于排查"上下文怎么少了" */
    truncatedReason: input.truncatedReason || null,
  });
}

export function isContextBlock(value) {
  return (
    value &&
    typeof value === 'object' &&
    typeof value.source === 'string' &&
    typeof value.text === 'string' &&
    typeof value.priority === 'number'
  );
}

/** 把插件返回的松散结构归一为 ContextBlock 数组，非法项直接丢弃 */
export function coerceContextBlocks(raw, defaults = {}) {
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : Array.isArray(raw.blocks) ? raw.blocks : [raw];
  const out = [];
  for (const item of list) {
    if (item == null) continue;
    if (typeof item === 'string') {
      if (!item.trim()) continue;
      out.push(createContextBlock({ ...defaults, text: item }));
      continue;
    }
    if (typeof item !== 'object') continue;
    const text = typeof item.text === 'string' ? item.text : typeof item.content === 'string' ? item.content : typeof item.context === 'string' ? item.context : '';
    const metadata = { ...(defaults.metadata || {}), ...(item.metadata || {}), ...(item.detail?.slot ? { slot: item.detail.slot } : {}) };
    if (!text.trim()) continue;
    const dedupeKey =
      item.dedupeKey ??
      item.detail?.dedupeKey ??
      (item.source === 'group_chat_plus' || item.detail?.slot === 'recent'
        ? 'recent-group-context'
        : item.source && item.source !== defaults.source
          ? undefined
          : defaults.dedupeKey);
    const scope = item.scope ?? defaults.scope ?? CONTEXT_SCOPES.ANY;
    out.push(createContextBlock({ ...defaults, ...item, text, metadata, dedupeKey, scope }));
  }
  return out;
}
