/**
 * middleware/affection.js — 好感度标记处理
 *
 * 流程：提取 → 校验 → 幂等写入 → 剥离标记
 *
 * 迁移自 bridge.js:815-824（流式剥离）与 :1004-1023（末尾解析与写入）。
 *
 * 主人特权（附录 1）：
 *   ruaji 的好感度恒定满值 100，不做评估，systemText 不注入好感行，
 *   回复里也不该带 [AFF]。这里对 owner 只做剥离，不做任何写入。
 *
 * 幂等（验收标准 11 的副作用部分）：
 *   同一个模型响应 ID 只写一次好感度。流式回复会被切成多段，每段都经过
 *   这个中间件；没有幂等键的话同一次评估会被重复应用。
 */

/** 末尾锚定的完整标记，兼容 HTML 实体编码（bridge.js:1004） */
const AFF_TAIL = /(?:\[|&#91;)AFF:([+-]?\d+(?:\.\d+)?)\|([^&\]]*)(?:\]|&#93;)\s*$/i;
const AFF_TAIL_STRIP = /\s*(?:\[|&#91;)AFF:[+-]?\d+(?:\.\d+)?\|[^&\]]*(?:\]|&#93;)\s*$/i;

/** 任意位置的标记，流式分段时要全部剥掉（bridge.js:815-824 三种变体） */
const AFF_ANYWHERE = [
  /\s*\[AFF:[+-]?\d+(?:\.\d+)?\|[^\]]*\]\s*/gi,
  /\s*&#91;AFF:[+-]?\d+(?:\.\d+)?\|[^&]*&#93;\s*/gi,
  /\s*(?:&#91;|\[)AFF:[+-]?\d+(?:\.\d+)?\|[^&\]]*(?:&#93;|\])\s*/gi,
];

/** 群聊兜底增量：没给标记也算一次有效互动（bridge.js:1011） */
export const FALLBACK_DELTA = 0.01;
export const FALLBACK_REASON = '群聊互动(兜底)';

export function stripAffTags(text) {
  if (!text) return text;
  let out = String(text);
  for (const re of AFF_ANYWHERE) out = out.replace(re, '');
  return out.trim();
}

/**
 * 从完整回复末尾提取好感度评估。
 * @returns {{ delta: number, reason: string, stripped: string }|null}
 */
export function extractAffection(fullText) {
  const text = String(fullText ?? '');
  const match = AFF_TAIL.exec(text);
  if (!match) return null;
  return {
    delta: parseFloat(match[1]),
    reason: match[2] ? match[2].trim() : '',
    stripped: text.replace(AFF_TAIL_STRIP, '').trim(),
  };
}

export function createAffectionMiddleware({ store, identity, idempotency, logger, config }) {
  const log = logger?.child({ component: 'mw:affection' }) ?? console;

  return {
    name: 'affection',

    async process(ctx, next) {
      const isOwner = String(ctx.inbound?.userId) === String(identity.ownerId);
      const isProactive = ctx.triggerType === 'ai_decision';

      // 剥离标记：无论是否写入，标记都不能出现在最终可见文本里
      const beforeStrip = ctx.text;
      ctx.text = stripAffTags(ctx.text);

      // 只在"完整回复"这一轮做写入。流式分段只剥不写。
      if (!ctx.isFinalPass) return next(ctx);

      // 主人：恒 100，不评估、不写入
      if (isOwner) {
        if (beforeStrip !== ctx.text) {
          log.debug?.('主人回复中出现 [AFF] 标记，已剥离但不写入', {
            correlationId: ctx.correlationId,
          });
        }
        return next(ctx);
      }

      // 主动接话不构成与任何群友的互动，不评估好感度（bridge.js:780-782）
      if (isProactive) return next(ctx);

      const extracted = extractAffection(ctx.rawText ?? beforeStrip);
      let delta = null;
      let reason = '';
      let source = '';

      if (extracted) {
        delta = extracted.delta;
        reason = extracted.reason;
        source = 'LLM评估';
      } else if (ctx.inbound?.messageType === 'group') {
        delta = FALLBACK_DELTA;
        reason = FALLBACK_REASON;
        source = '兜底评估';
      }

      if (delta === null) return next(ctx);

      // 幂等：同一个模型响应只写一次
      const key = idempotency.buildKey('affection.apply', ctx.responseId, String(ctx.inbound.userId));
      if (!idempotency.claim(key)) {
        log.debug?.('好感度写入重复，已跳过', {
          responseId: ctx.responseId,
          correlationId: ctx.correlationId,
        });
        return next(ctx);
      }

      if (!config.reply.sideEffectsEnabled) {
        log.info('影子模式：好感度写入已抑制', {
          correlationId: ctx.correlationId,
          userId: ctx.inbound.userId,
          delta,
          reason,
        });
        ctx.suppressedSideEffects = ctx.suppressedSideEffects ?? [];
        ctx.suppressedSideEffects.push({ kind: 'affection', userId: ctx.inbound.userId, delta, reason });
        return next(ctx);
      }

      try {
        const updated = store.applyDelta(ctx.inbound.userId, delta, reason);
        if (updated) {
          log.info('好感度已更新', {
            source,
            userId: ctx.inbound.userId,
            delta: updated.appliedDelta,
            affection: Math.round(updated.affection),
            correlationId: ctx.correlationId,
          });
        }
      } catch (err) {
        // 好感度写失败不能拖垮回复
        log.warn('好感度写入异常', { error: err.message, correlationId: ctx.correlationId });
      }

      return next(ctx);
    },
  };
}
