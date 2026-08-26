/**
 * middleware/meme.js — 表情包标记解析
 *
 * 协议（沿用旧 Bridge，模型侧的 prompt 已按这个约定训练过）：
 *   &&meme:ID&&        精确 ID，独占最后一行
 *   [表情:标签]        标签模糊匹配（兼容 [meme:xxx] 与全角冒号）
 *
 * 迁移自 meme_manager.js:439-467，并补两个洞：
 *   1. 路径穿越：旧实现直接把 memes_data.json 里的 path 拼进 CQ 码。
 *      这里所有路径都经过 MemeStore.resolveSafePath()，必须落在 memes/ 内。
 *   2. 未闭合标记：流式截断会留下 "&&meme:m_178726666" 这种残缺前缀，
 *      旧实现已有丢弃逻辑，这里保留并明确只在结尾处丢。
 *
 * 顺序约束：必须排在 strip-markdown 之前。表情 ID 含下划线，
 * 先跑 stripMarkdown 会被 _text_ 斜体规则吃掉。
 */

import { buildImageCq } from '../adapters/napcat/cq.js';

const DANGLING_MARKER = /&&meme:[^&>\s]*$/i;
const FULL_MARKER = /&&meme:([^&>\s]+)&&/gi;
const TAG_MARKER = /\[(?:表情|meme)\s*[:：]\s*([a-zA-Z0-9_一-龥]+)\]/gi;

/**
 * @param {string} text
 * @param {import('../storage/meme-store.js').MemeStore} store
 * @returns {{ text: string, memeCqs: string[], misses: string[] }}
 */
export function processMemeMarkers(text, store) {
  if (!text) return { text, memeCqs: [], misses: [] };

  let str = String(text);
  const memeCqs = [];
  const misses = [];

  // 残缺标记绝不能作为纯文本泄漏到 QQ
  str = str.replace(DANGLING_MARKER, (dangling) => {
    misses.push(`dangling:${dangling}`);
    return '';
  });

  str = str.replace(FULL_MARKER, (_all, id) => {
    const meme = store.resolveById(id);
    if (meme) memeCqs.push(buildImageCq(meme.path));
    else misses.push(`id:${id}`);
    return '';
  });

  str = str.replace(TAG_MARKER, (_all, tag) => {
    const meme = store.findByTag(tag);
    if (meme) memeCqs.push(buildImageCq(meme.path));
    else misses.push(`tag:${tag}`);
    return '';
  });

  return { text: str.trim(), memeCqs, misses };
}

export function createMemeMiddleware({ store, logger }) {
  const log = logger?.child({ component: 'mw:meme' }) ?? console;

  return {
    name: 'meme',
    /** 声明顺序约束，由 MiddlewarePipeline.configure 在启动期校验 */
    requiresBefore: ['strip-markdown'],

    async process(ctx, next) {
      const { text, memeCqs, misses } = processMemeMarkers(ctx.text, store);
      ctx.text = text;

      if (memeCqs.length) {
        ctx.attachments = ctx.attachments ?? [];
        ctx.attachments.push(...memeCqs);
        log.debug?.('表情包已解析', { count: memeCqs.length, correlationId: ctx.correlationId });
      }
      if (misses.length) {
        // 文件缺失/ID 不存在都安全降级：文字照发，只是没有配图
        log.warn('表情包标记未命中，已安全降级', {
          misses,
          correlationId: ctx.correlationId,
        });
      }

      return next(ctx);
    },
  };
}
