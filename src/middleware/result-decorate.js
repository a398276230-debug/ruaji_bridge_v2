/**
 * middleware/result-decorate.js — 结果修饰中间件（OnDecoratingResultEvent 能力）
 *
 * 在回复流水线中（affection 剥离好感度之后，meme/strip-markdown 之前）调用宿主的 result.decorate 能力，
 * 允许 AstrBot 插件（如 GCP）在模型输出后进行输出内容过滤、错字模拟等修饰。
 *
 * 关键设计：
 * - 阻塞主回复链路，但有超时/熔断/异常兜底，失败时平滑降级使用原文本，绝不打断回复。
 * - 只有当 capabilityBus 注册了 RESULT_DECORATE 时才调用。
 * - 正确解包 CapabilityBus 返回的信封对象（F-1 修复）。
 * - 支持显式拦截阻断（blocked: true）与打断安全（F-2, F-3 修复）。
 */

import { CAPABILITIES } from '../contracts/capabilities.js';

/**
 * @param {object} deps
 * @param {import('../core/capability-bus.js').CapabilityBus} deps.capabilityBus
 * @param {import('../core/logger.js').Logger} [deps.logger]
 */
export function createResultDecorateMiddleware(deps) {
  const { capabilityBus, logger } = deps;
  const log = logger?.child({ component: 'middleware:result-decorate' }) ?? console;

  return {
    name: 'result-decorate',
    requiresBefore: ['media-extract', 'meme', 'strip-markdown'],

    /**
     * @param {object} context
     * @param {Function} next
     */
    async process(context, next) {
      if (!context.text || !capabilityBus || !capabilityBus.has(CAPABILITIES.RESULT_DECORATE)) {
        return next(context);
      }

      try {
        const input = {
          text: context.text,
          rawText: context.rawText ?? context.text,
          sessionId: context.sessionId,
          correlationId: context.correlationId,
          responseId: context.responseId,
          isFinalPass: context.isFinalPass,
          inbound: context.inbound
            ? {
                messageId: context.inbound.messageId,
                userId: context.inbound.userId,
                groupId: context.inbound.groupId,
                sessionId: context.inbound.sessionId,
                messageType: context.inbound.messageType,
                text: context.inbound.text,
              }
            : null,
        };

        const envelope = await capabilityBus.requestOrNull(CAPABILITIES.RESULT_DECORATE, input, {
          sessionId: context.sessionId,
          correlationId: context.correlationId,
          signal: context.signal,
        });

        const body = envelope?.result;

        // 1. 显式拦截判定
        if (body && typeof body === 'object' && body.blocked === true) {
          context.cancelled = true;
          context.text = '';
          log.info('result.decorate 拦截了本段回复', {
            correlationId: context.correlationId,
            reason: body.reason || 'content_filter',
          });
          return context;
        }

        // 2. 文本更新（支持对象 { text } 与裸字符串返回）
        const decorated = typeof body === 'string' ? body : body?.text;
        if (typeof decorated === 'string' && decorated.length > 0) {
          context.text = decorated;
        }
      } catch (err) {
        if (context.signal?.aborted || err?.name === 'AbortError') {
          return context;
        }
        log.warn('result.decorate 调用失败或超时，降级保留原回复内容', {
          correlationId: context.correlationId,
          error: err?.message ?? String(err),
        });
      }

      return next(context);
    },
  };
}
