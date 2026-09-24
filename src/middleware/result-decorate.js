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
import { MESSAGE_TYPES } from '../contracts/messages.js';

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
      // Favour 结算合同：收尾轮 ctx.text 恒为空（副作用轮不产出可见文本），
      // 但宿主的 OnDecoratingResultEvent 必须在收尾轮跑一次——插件靠它弹出
      // llm.response 暂存的评分并写库。空文本守卫只能拦非收尾轮，
      // 否则暂存永远无人消费，好感度数据永远不落库。
      const hasPayload = Boolean(context.text) || context.isFinalPass === true;
      if (!hasPayload || !capabilityBus || !capabilityBus.has(CAPABILITIES.RESULT_DECORATE)) {
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
          // 触发类型透传：宿主侧 Favour 据此豁免主动插话轮的结算写库
          triggerType: context.triggerType,
          inbound: context.inbound
            ? {
                messageId: context.inbound.messageId,
                userId: context.inbound.userId,
                groupId: context.inbound.groupId,
                sessionId: context.inbound.sessionId,
                messageType: context.inbound.messageType,
                // 宿主 handle_decorate 只看嵌套 inbound；私聊标志显式给出，
                // 不靠宿主从 messageType 反推（两边给出一致答案）。
                isPrivate: context.inbound.messageType === MESSAGE_TYPES.PRIVATE,
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
