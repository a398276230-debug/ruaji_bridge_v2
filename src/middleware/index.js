/**
 * middleware/index.js — Middleware 注册与管线装配
 *
 * 顺序完全由配置驱动（bridge.config.json 的 pipelines['response.transform']）。
 * 这里只负责把实例注册进 MiddlewarePipeline，并把配置里的顺序交给它校验。
 */

import { MiddlewarePipeline } from '../core/middleware-pipeline.js';
import { createAffectionMiddleware } from './affection.js';
import { createMemeMiddleware } from './meme.js';
import { createStripMarkdownMiddleware } from './strip-markdown.js';
import { createTypingDelayMiddleware } from './typing-delay.js';
import { createMediaExtractMiddleware } from './media-extract.js';
import { createResultDecorateMiddleware } from './result-decorate.js';

export const RESPONSE_TRANSFORM = 'response.transform';

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {import('../core/logger.js').Logger} deps.logger
 * @param {import('../storage/affection-store.js').AffectionStore} deps.affectionStore
 * @param {import('../storage/meme-store.js').MemeStore} deps.memeStore
 * @param {import('../core/idempotency-store.js').IdempotencyStore} deps.idempotency
 * @param {import('../core/capability-bus.js').CapabilityBus} [deps.capabilityBus]
 * @returns {MiddlewarePipeline}
 */
export function buildMiddlewarePipeline(deps) {
  const { config, logger, affectionStore, memeStore, idempotency, capabilityBus } = deps;

  const pipeline = new MiddlewarePipeline({ logger });

  pipeline
    .register('result-decorate', createResultDecorateMiddleware({ capabilityBus, logger }))
    .register(
      'affection',
      createAffectionMiddleware({
        store: affectionStore,
        identity: config.identity,
        idempotency,
        logger,
        config,
      }),
    )
    .register('meme', createMemeMiddleware({ store: memeStore, logger }))
    .register(
      'media-extract',
      createMediaExtractMiddleware({
        outputDir: config.paths.receivedImagesDir,
        config,
        logger,
      }),
    )
    .register('strip-markdown', createStripMarkdownMiddleware({ logger }))
    .register('typing-delay', createTypingDelayMiddleware({ config, logger }));

  const order = config.pipelines?.[RESPONSE_TRANSFORM] ?? [
    'affection',
    'result-decorate',
    'media-extract',
    'meme',
    'strip-markdown',
    'typing-delay',
  ];
  pipeline.configure(RESPONSE_TRANSFORM, order);

  return pipeline;
}

/**
 * 构造一次管线执行的上下文。
 * @param {object} input
 */
export function createTransformContext(input) {
  return {
    correlationId: input.correlationId,
    sessionId: input.sessionId,
    inbound: input.inbound,
    /** 本段待处理的文本 */
    text: String(input.text ?? ''),
    /** 完整模型原文，好感度末尾锚定解析要用 */
    rawText: input.rawText ?? null,
    responseId: input.responseId ?? null,
    triggerType: input.triggerType ?? 'at',
    /** true = 这是完整回复的收尾轮，副作用只在这一轮执行 */
    isFinalPass: input.isFinalPass === true,
    signal: input.signal ?? null,
    /** 中间件产出的 CQ 码附件（表情包、图片） */
    attachments: [],
    /** 影子模式下被抑制的副作用记录 */
    suppressedSideEffects: [],
    cancelled: false,
  };
}
