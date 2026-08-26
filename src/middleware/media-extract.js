/**
 * middleware/media-extract.js — 从模型回复中提取媒体
 *
 * 迁移自 bridge.js:422-456 extractMediaFromResponse。处理三种情况：
 *   MEDIA:C:/path/x.png            模型给的本地图片路径 → 转 CQ 图片段
 *   data:image/png;base64,…        内联 base64 → 落盘后发本地 file URI
 *   连续 10000+ 字符的裸 base64     无法判断格式，直接丢弃
 *
 * 最后一条是防御性的：裸 base64 进入切句循环会把桥接拖死（旧注释原话
 * "避免超大图片文本拖死桥接"）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildImageCq } from '../adapters/napcat/cq.js';

const MEDIA_PATH = /MEDIA:\s*((?:[A-Za-z]:)[^\s\r\n]+?\.(?:png|jpe?g|gif|webp|bmp))(?:\s*)/gi;
const DATA_URI = /data:image\/(png|jpe?g|gif|webp|bmp);base64,([A-Za-z0-9+/=_-]{128,})/gi;
const BARE_BASE64 = /[A-Za-z0-9+/]{10000,}={0,2}/g;

/**
 * @param {string} input
 * @param {object} opts
 * @param {string} opts.outputDir  base64 落盘目录
 * @param {boolean} [opts.writeEnabled=true] 影子模式下可关闭落盘
 * @returns {{ text: string, images: Array<{filePath: string|null, cq: string|null}>, warnings: string[] }}
 */
export function extractMediaFromResponse(input, { outputDir, writeEnabled = true } = {}) {
  let text = String(input ?? '');
  const images = [];
  const warnings = [];

  const addFile = (filePath) => {
    if (!filePath || images.some((item) => item.filePath === filePath)) return;
    images.push({ filePath, cq: buildImageCq(filePath) });
  };

  text = text.replace(MEDIA_PATH, (_all, filePath) => {
    addFile(filePath);
    return '';
  });

  text = text.replace(DATA_URI, (_all, ext, encoded) => {
    if (!writeEnabled) {
      warnings.push('影子模式：内联 base64 图片未落盘');
      return '';
    }
    try {
      const safeExt = ext.toLowerCase() === 'jpeg' ? 'jpg' : ext.toLowerCase();
      const filePath = path.join(outputDir, `reply_${Date.now()}_${images.length}.${safeExt}`);
      fs.mkdirSync(outputDir, { recursive: true });
      // URL-safe base64 也要能解
      const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
      fs.writeFileSync(filePath, Buffer.from(normalized, 'base64'));
      addFile(filePath);
    } catch (err) {
      warnings.push(`回复图片 base64 落盘失败: ${err.message}`);
    }
    return '';
  });

  text = text.replace(BARE_BASE64, (match) => {
    warnings.push(`检测到裸 base64 片段，已移除 ${match.length} 字符`);
    return '';
  });

  return { text, images, warnings };
}

export function createMediaExtractMiddleware({ outputDir, config, logger }) {
  const log = logger?.child({ component: 'mw:media-extract' }) ?? console;

  return {
    name: 'media-extract',

    async process(ctx, next) {
      const { text, images, warnings } = extractMediaFromResponse(ctx.text, {
        outputDir,
        // 落盘算副作用，但它只写 v2 自己的目录且是发送前提，跟随 sendEnabled 而非 sideEffects
        writeEnabled: config.reply.sendEnabled,
      });

      ctx.text = text;
      if (images.length) {
        ctx.attachments = ctx.attachments ?? [];
        ctx.attachments.push(...images.map((i) => i.cq));
      }
      for (const warning of warnings) {
        log.warn(warning, { correlationId: ctx.correlationId });
      }

      return next(ctx);
    },
  };
}
