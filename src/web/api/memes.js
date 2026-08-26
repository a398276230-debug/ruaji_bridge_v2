/**
 * web/api/memes.js — 表情包图库与检索测试
 *
 * 只读。表情包的收集与 AI 打标仍归旧 meme_manager.js（见 storage/meme-store.js
 * 的注释），v2 不写这份数据，面板自然也不提供编辑入口。
 *
 * 图片是通过本接口流式回读的，不做静态目录挂载 ——
 * memes/ 在 v2 目录之外（../memes），直接挂静态目录等于把整个上级目录
 * 的可达性交给路径拼接的正确性。这里一律走 MemeStore.resolveSafePath()，
 * 与主链路发图用的是同一道越界校验。
 */

import fs from 'node:fs';
import path from 'node:path';

const IMAGE_MIME = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
});

export function createMemesApi(deps) {
  const { memeStore, config } = deps;

  return {
    'GET /api/memes': async ({ url }) => {
      const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
      const category = url.searchParams.get('category') ?? '';
      const limit = clamp(Number(url.searchParams.get('limit') ?? 300), 1, 2000);

      const items = memeStore.data.memes
        .filter((m) => {
          if (category && m.category !== category) return false;
          if (!q) return true;
          const hay = [m.id, m.name, m.tag, m.category, m.description, ...(m.keywords ?? [])]
            .join(' ')
            .toLowerCase();
          return hay.includes(q);
        })
        .map((m) => toCard(m, memeStore));

      const usable = items.filter((i) => i.usable).length;
      return {
        body: {
          dataFile: config.paths.memeDataFile,
          memeRoot: config.paths.memeRoot,
          categories: memeStore.data.categories ?? [],
          settings: memeStore.data.settings ?? {},
          total: items.length,
          usable,
          broken: items.length - usable,
          items: items.slice(0, limit),
        },
      };
    },

    /**
     * 标签检索模拟：完全复用主链路的 findByTag / search，
     * 保证面板上"测出来能发"和真实回复里"发得出来"是同一件事。
     */
    'GET /api/memes/search': async ({ url }) => {
      const query = String(url.searchParams.get('q') ?? url.searchParams.get('tag') ?? '').trim();
      const limit = clamp(Number(url.searchParams.get('limit') ?? 10), 1, 50);

      const candidates = query ? memeStore.search(query, limit) : [];
      const picked = query ? memeStore.findByTag(query) : null;
      return {
        body: {
          q: query,
          tag: query,
          results: candidates,
          candidates,
          picked: picked ? toCard(picked, memeStore) : null,
          pickedReference: picked ? `&&meme:${picked.id}&&` : null,
          note: picked
            ? '主链路会在候选中随机取一张，多点几次会看到不同结果'
            : '没有命中任何可用表情包，回复里写这个标签不会发出图片',
        },
      };
    },

    /** 按 ID 精确解析，等价于回复里写 &&meme:ID&& 时主链路做的事 */
    'GET /api/memes/resolve': async ({ url }) => {
      const id = String(url.searchParams.get('id') ?? '').trim();
      if (!id) return { status: 400, body: { error: '缺少 id 参数' } };
      const meme = memeStore.resolveById(id);
      return {
        body: {
          id,
          reference: `&&meme:${id}&&`,
          resolved: meme ? toCard(meme, memeStore) : null,
          reason: meme ? null : '未找到、状态非 accepted、路径越界或文件不存在',
        },
      };
    },

    /** 编辑表情包元数据 */
    'POST /api/memes/update': async ({ body }) => {
      const id = String(body?.id ?? '').trim();
      if (!id) return { status: 400, body: { error: '缺少 id 参数' } };
      const res = memeStore.updateMeme(id, body);
      if (!res.ok) return { status: 400, body: { error: res.error } };
      return { body: { ok: true, item: toCard(res.item, memeStore) } };
    },

    /** 删除表情包 */
    'POST /api/memes/delete': async ({ body }) => {
      const id = String(body?.id ?? '').trim();
      if (!id) return { status: 400, body: { error: '缺少 id 参数' } };
      const deleteFile = body?.deleteFile !== false;
      const res = memeStore.deleteMeme(id, deleteFile);
      if (!res.ok) return { status: 400, body: { error: res.error } };
      return { body: { ok: true } };
    },

    /** 重新触发 AI 视觉打标 */
    'POST /api/memes/retag': async ({ body }) => {
      const id = String(body?.id ?? '').trim();
      if (!id) return { status: 400, body: { error: '缺少 id 参数' } };
      const res = await memeStore.retagMeme(id);
      if (!res.ok) return { status: 400, body: { error: res.error || 'AI 打标识别失败，请检查视觉模型端点' } };
      return { body: { ok: true, item: toCard(res.item, memeStore) } };
    },

    /** 图片流。?id=<memeId>，路径安全由 MemeStore 保证 */
    'GET /api/memes/file': async ({ url, res }) => {
      const id = String(url.searchParams.get('id') ?? '').trim();
      const meme = id ? memeStore.byId.get(id) : null;
      const safePath = meme ? memeStore.resolveSafePath(meme.path) : null;

      if (!safePath) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '图片不存在或路径越界' }));
        return undefined;
      }

      const type = IMAGE_MIME[path.extname(safePath).toLowerCase()] ?? 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'private, max-age=300',
        'Content-Length': fs.statSync(safePath).size,
      });
      fs.createReadStream(safePath).pipe(res);
      return undefined;
    },
  };
}

function toCard(m, memeStore) {
  const safePath = memeStore.resolveSafePath(m.path);
  return {
    id: m.id,
    name: m.name ?? m.id,
    category: m.category ?? '',
    tag: m.tag ?? '',
    keywords: m.keywords ?? [],
    description: m.description ?? '',
    status: m.status ?? 'accepted',
    usable: Boolean(safePath) && (m.status ?? 'accepted') === 'accepted',
    reference: `&&meme:${m.id}&&`,
    imageUrl: `/api/memes/file?id=${encodeURIComponent(m.id)}`,
    pathOk: Boolean(safePath),
  };
}

function clamp(n, lo, hi) {
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;
}
