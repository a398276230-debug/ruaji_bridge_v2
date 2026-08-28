/**
 * storage/meme-store.js — 表情包索引与收集管理
 *
 * 读写旧 Bridge 的 memes_data.json 与 memes/ 资源目录。
 * v2 现已完整接管：
 *   1. 按 ID / 标签模糊检索与安全解析
 *   2. /收集表情 批量收集会话与图片入库
 *   3. 异步 AI 智能打标与元数据持久化
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

export const DEFAULT_MEME_TOOL_PROMPT = `[表情包使用]
在日常聊天与对话交流中，必须积极使用表情包。语境适合时可调用 search_memes 工具检索表情包。
若选择发送表情，在回复末尾独占一行输出 &&meme:候选ID&&；正文不要复述 ID 或描述，不合适时无需输出。
只有在候选列表完全为空或纯代码排查时才可以不添加表情。不要捏造候选列表之外的 ID，也不要重复调用工具。`;

export class MemeStore {
  /**
   * @param {object} opts
   * @param {string} opts.dataFile   memes_data.json 绝对路径
   * @param {string} opts.memeRoot   memes/ 目录绝对路径
   * @param {import('../core/logger.js').Logger} [opts.logger]
   * @param {number} [opts.reloadIntervalMs=60000] 索引热更新间隔
   */
  constructor(opts = {}) {
    this.dataFile = opts.dataFile;
    this.memeRoot = path.resolve(opts.memeRoot ?? '');
    this.log = opts.logger?.child({ component: 'meme-store' }) ?? console;
    this.reloadIntervalMs = opts.reloadIntervalMs ?? 60000;
    this.config = opts.config || null;

    this.data = { categories: [], memes: [], settings: { auto_collect: true, auto_ai_tagging: true } };
    this.byId = new Map();
    this._loadedAt = 0;
    this.activeCollectSessions = {}; // uid -> session
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.dataFile)) {
        const raw = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
        if (raw && Array.isArray(raw.memes)) {
          this.data = {
            categories: raw.categories ?? [],
            memes: raw.memes ?? [],
            settings: { auto_collect: true, auto_ai_tagging: true, ...(raw.settings ?? {}) },
          };
          this.byId = new Map(raw.memes.map((m) => [m.id, m]));
          this._loadedAt = Date.now();
          this.log.info('表情包索引已加载', { count: raw.memes.length });
          return;
        }
      }
    } catch (err) {
      this.log.error('表情包索引读取失败', { error: err.message });
    }
    this.data = { categories: [], memes: [], settings: { auto_collect: true, auto_ai_tagging: true } };
    this.byId = new Map();
    this._loadedAt = Date.now();
  }

  persist() {
    try {
      const dir = path.dirname(this.dataFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const content = JSON.stringify(this.data, null, 2);
      const tmp = `${this.dataFile}.tmp_${Date.now()}`;
      try {
        fs.writeFileSync(tmp, content, 'utf8');
        fs.renameSync(tmp, this.dataFile);
      } catch {
        fs.writeFileSync(this.dataFile, content, 'utf8');
        try { fs.unlinkSync(tmp); } catch {}
      }
      this._loadedAt = Date.now();
    } catch (err) {
      this.log.error('表情包持久化失败', { error: err.message });
    }
  }

  _maybeReload() {
    if (Date.now() - this._loadedAt > this.reloadIntervalMs) this.load();
  }

  addCategory(catName) {
    const c = String(catName || '').trim();
    if (c && !this.data.categories.includes(c)) {
      this.data.categories.push(c);
      const catDir = path.join(this.memeRoot, c);
      if (!fs.existsSync(catDir)) fs.mkdirSync(catDir, { recursive: true });
      this.persist();
    }
  }

  startCollect(uid, category = '常用', tag = '') {
    const cat = String(category || '').trim() || '常用';
    const tg = String(tag || '').trim() || cat;
    this.addCategory(cat);

    this.activeCollectSessions[String(uid)] = {
      category: cat,
      tag: tg,
      count: 0,
      startTime: Date.now(),
      saved: 0,
      failed: 0,
      paths: [],
    };
    return `已开启表情包批量收集模式！\n当前自定义分类：【${cat}】\n默认初始标签：【${tg}】\n\n现在请开始狂发表情包吧~ 每发一张我会自动收录入库并自动 AI 打标！\n发完后发送「/完成收集」即可归档。`;
  }

  stopCollect(uid) {
    const sKey = String(uid);
    const sess = this.activeCollectSessions[sKey];
    if (!sess) return '当前未处于表情包收集模式哦。发送「/收集表情 <分类>」即可开启~';
    
    // 收集结束时，触发对本次收集但尚未完成打标的表情包进行 AI 打标
    if (this.data.settings?.auto_ai_tagging && Array.isArray(sess.items)) {
      for (const item of sess.items) {
        if (item && item.tagStatus === 'pending') {
          this.retagMeme(item.id).catch(() => {});
        }
      }
    }

    delete this.activeCollectSessions[sKey];
    this.persist();
    return `表情包收集结束！\n本次成功写入【${sess.saved}】张${sess.failed ? `，失败【${sess.failed}】张` : ''}（分类：${sess.category}）。AI 正在后台自动识别画面打标，可在 WebUI 中随时查看与管理~`;
  }

  isCollecting(uid) {
    return Boolean(this.activeCollectSessions[String(uid)]);
  }

  getCollectSession(uid) {
    return this.activeCollectSessions[String(uid)] || null;
  }

  saveDirectMeme({ buffer, ext = 'jpg', category = '常用', tag = '', keywords = [], name = '' }) {
    const cat = String(category || '').trim() || '常用';
    this.addCategory(cat);
    const catDir = path.join(this.memeRoot, cat);
    if (!fs.existsSync(catDir)) fs.mkdirSync(catDir, { recursive: true });

    const safeName = name ? `${Date.now()}_${path.basename(name)}` : `meme_${Date.now()}.${ext}`;
    const filePath = path.join(catDir, safeName);
    fs.writeFileSync(filePath, buffer);

    const item = {
      id: `m_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      name: name || safeName,
      category: cat,
      tag: tag || cat,
      keywords: Array.isArray(keywords) && keywords.length ? keywords : [tag || cat],
      path: filePath,
      status: 'accepted',
      tagStatus: this.data.settings?.auto_ai_tagging ? 'processing' : 'pending',
      memeConfidence: null,
      categoryConfidence: null,
      description: '',
      createdAt: new Date().toISOString(),
    };
    this.data.memes.unshift(item);
    this.byId.set(item.id, item);
    this.persist();

    // 异步触发视觉打标
    if (this.data.settings?.auto_ai_tagging) {
      this.autoTagMemeWithAI(item, buffer, ext);
    }
    return item;
  }

  collectMeme({ uid, nickname, filename, buffer }) {
    if (!buffer) return null;
    const sess = this.getCollectSession(uid);
    if (sess) {
      const ext = path.extname(filename || '.jpg').replace('.', '') || 'jpg';
      try {
        const item = this.saveDirectMeme({
          buffer,
          ext,
          category: sess.category,
          tag: sess.tag,
          keywords: [sess.tag, sess.category],
          name: filename || `collect_${sess.saved + 1}.${ext}`,
        });
        sess.count++;
        sess.saved++;
        sess.paths.push(item.path);
        if (!sess.items) sess.items = [];
        sess.items.push(item);
        this.log.info('收集表情入库', { uid, count: sess.saved, path: item.path });
        return item;
      } catch (e) {
        sess.failed++;
        this.log.error('收集表情写入失败', { uid, error: e.message });
        return null;
      }
    }
    return null;
  }

  async autoTagMemeWithAI(item, buffer, ext) {
    try {
      const baseUrl = (this.config?.meme?.visionBaseUrl || 'http://127.0.0.1:8317/v1').replace(/\/+$/, '');
      const cpaUrl = `${baseUrl}/` + ['chat', 'completions'].join('/');
      const visionModel = this.config?.meme?.visionModel || 'gpt-4o-mini';
      const apiKey = this.config?.secrets?.memeVisionApiKey || this.config?.meme?.visionKey || '';

      const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
      const base64 = buffer.toString('base64');
      const categoriesList = (this.data.categories ?? []).filter((c) => c !== 'inbox').join('、');

      const prompt = `请观察这张聊天表情包图片，分析画面内容、文字梗和情绪语气，直接输出紧凑且完整闭合的 JSON（不要带 Markdown 代码块，不要解释）：\n现有可选分类包括：[${categoriesList}]\n\n必须输出完整合法 JSON 格式：\n{\n  "tag": "简要情绪/动作标签(如: 猫猫呆滞/收到/吃瓜/无语/摸鱼)",\n  "suggested_category": "最合适的分类名称",\n  "keywords": ["关键词1", "关键词2", "关键词3"],\n  "description": "适合在什么聊天语境中发送（人类自然语言一两句话说明）"\n}`;

      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
      }

      const res = await fetch(cpaUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: visionModel,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
              ],
            },
          ],
          max_tokens: 4096,
          temperature: 0.8,
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!res.ok) {
        item.tagStatus = 'failed';
        this.persist();
        return false;
      }

      const json = await res.json();
      const msg = json.choices?.[0]?.message;
      const rawContent = (msg?.content || msg?.reasoning_content || '').trim();

      let tag = '';
      let keywords = [];
      let description = '';
      let category = item.category || '常用';

      // 1. 尝试完整 JSON 解析
      const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.tag) tag = String(parsed.tag).trim();
          if (Array.isArray(parsed.keywords)) {
            keywords = parsed.keywords.map((k) => String(k).trim()).filter(Boolean);
          }
          if (parsed.description && !String(parsed.description).startsWith('{')) {
            description = String(parsed.description).trim();
          }
          if (parsed.suggested_category && this.data.categories.includes(parsed.suggested_category)) {
            category = parsed.suggested_category;
          }
        } catch {}
      }

      // 2. 字段级正则提取容错（如果 JSON 尾部被微弱截断）
      if (!tag) {
        const tagM = rawContent.match(/"tag"\s*:\s*"([^"]+)"/);
        if (tagM) tag = tagM[1].trim();
      }
      if (!description) {
        const descM = rawContent.match(/"description"\s*:\s*"([^"]+)"/);
        if (descM && !descM[1].startsWith('{')) description = descM[1].trim();
      }
      if (!keywords.length) {
        const kwM = rawContent.match(/"keywords"\s*:\s*\[([^\]]+)\]/);
        if (kwM) {
          keywords = kwM[1]
            .split(',')
            .map((s) => s.replace(/["'\s]/g, '').trim())
            .filter(Boolean);
        }
      }

      // 3. 智能兜底：若模型输出了纯文字分析，自动清洗提取
      if (!tag && rawContent) {
        const cleanText = rawContent.replace(/[{}[\]"']/g, '').replace(/\*\*/g, '').trim();
        const words = cleanText.match(/[\u4e00-\u9fa5]{2,6}/g) || [];
        tag = words.slice(0, 2).join('/') || '表情包';
        keywords = Array.from(new Set(words.slice(0, 6)));
        if (!description) description = cleanText.slice(0, 200);
      }

      // 4. 清理可能残留在 description 里的原始 JSON 标记
      if (description.startsWith('{') || description.includes('"tag":')) {
        description = description
          .replace(/[{}"[\]]/g, '')
          .replace(/(?:tag|suggested_category|keywords|description)\s*:/g, '')
          .replace(/\s+/g, ' ')
          .trim();
      }

      if (tag || description) {
        const target = this.byId.get(item.id) || item;
        if (tag) target.tag = tag;
        if (keywords.length) target.keywords = keywords;
        if (description) target.description = description;
        if (category) target.category = category;
        target.tagStatus = 'tagged';
        const idx = this.data.memes.findIndex((m) => m.id === target.id);
        if (idx !== -1) this.data.memes[idx] = target;
        this.byId.set(target.id, target);
        this.persist();
        this.log.info('表情包AI打标完成', { id: target.id, tag: target.tag });
        return true;
      }

      item.tagStatus = 'failed';
      this.persist();
      return false;
    } catch (err) {
      item.tagStatus = 'failed';
      this.persist();
      return false;
    }
  }

  /**
   * 手动编辑表情包元数据
   */
  updateMeme(id, patchData = {}) {
    const item = this.byId.get(id);
    if (!item) return { ok: false, error: '表情包不存在' };

    if (patchData.tag !== undefined) item.tag = String(patchData.tag).trim();
    if (patchData.description !== undefined) item.description = String(patchData.description).trim();
    if (Array.isArray(patchData.keywords)) {
      item.keywords = patchData.keywords.map((k) => String(k).trim()).filter(Boolean);
    } else if (typeof patchData.keywords === 'string') {
      item.keywords = patchData.keywords.split(/[,，、/|]+/).map((k) => k.trim()).filter(Boolean);
    }

    if (patchData.category && patchData.category !== item.category) {
      const newCat = String(patchData.category).trim();
      this.addCategory(newCat);
      const safePath = this.resolveSafePath(item.path);
      if (safePath && fs.existsSync(safePath)) {
        const newDir = path.join(this.memeRoot, newCat);
        if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true });
        const newPath = path.join(newDir, path.basename(safePath));
        try {
          fs.renameSync(safePath, newPath);
          item.path = newPath;
        } catch (e) {
          this.log.warn('移动表情包文件失败', { error: e.message });
        }
      }
      item.category = newCat;
    }

    this.persist();
    return { ok: true, item };
  }

  /**
   * 删除表情包
   */
  deleteMeme(id, deleteFile = true) {
    const item = this.byId.get(id);
    if (!item) return { ok: false, error: '表情包不存在' };

    if (deleteFile && item.path) {
      const safePath = this.resolveSafePath(item.path);
      if (safePath && fs.existsSync(safePath)) {
        try {
          fs.unlinkSync(safePath);
        } catch (e) {
          this.log.warn('删除表情包文件失败', { path: safePath, error: e.message });
        }
      }
    }

    this.byId.delete(id);
    this.data.memes = this.data.memes.filter((m) => m.id !== id);
    this.persist();
    return { ok: true };
  }

  /**
   * 重跑单张表情包 AI 打标
   */
  async retagMeme(id) {
    const item = this.byId.get(id);
    if (!item) return { ok: false, error: '表情包不存在' };
    const safePath = this.resolveSafePath(item.path);
    if (!safePath || !fs.existsSync(safePath)) {
      return { ok: false, error: '本地图片文件不存在' };
    }
    const ext = path.extname(safePath).slice(1) || 'jpg';
    const buffer = fs.readFileSync(safePath);
    item.tagStatus = 'processing';
    const ok = await this.autoTagMemeWithAI(item, buffer, ext);
    return { ok, item };
  }

  /**
   * 路径必须在 memeRoot 之内，且文件真实存在。
   * @returns {string|null} 通过校验的绝对路径
   */
  resolveSafePath(rawPath) {
    if (!rawPath) return null;
    const resolved = path.resolve(rawPath);
    const relative = path.relative(this.memeRoot, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      this.log.warn('表情包路径越界，已拒绝', { rawPath, memeRoot: this.memeRoot });
      return null;
    }
    if (!fs.existsSync(resolved)) return null;
    return resolved;
  }

  isUsable(meme) {
    return (meme?.status ?? 'accepted') === 'accepted';
  }

  /** 按 ID 精确解析（&&meme:ID&& 协议） */
  resolveById(id) {
    this._maybeReload();
    const meme = this.byId.get(id);
    if (!meme || !this.isUsable(meme)) return null;
    const safePath = this.resolveSafePath(meme.path);
    return safePath ? { ...meme, path: safePath } : null;
  }

  /**
   * 按标签/关键词模糊查找（[表情:xxx] 协议）。
   */
  findByTag(tagOrKeyword) {
    this._maybeReload();
    const needle = String(tagOrKeyword ?? '').trim().toLowerCase();
    if (!needle) return null;

    const matched = this.data.memes.filter((m) => {
      if (!this.isUsable(m)) return false;
      if (m.category && m.category.toLowerCase() === needle) return true;
      if (m.tag && m.tag.toLowerCase() === needle) return true;
      return (m.keywords ?? []).some(
        (kw) => kw.toLowerCase().includes(needle) || needle.includes(kw.toLowerCase()),
      );
    });

    const valid = matched
      .map((m) => {
        const safePath = this.resolveSafePath(m.path);
        return safePath ? { ...m, path: safePath } : null;
      })
      .filter(Boolean);

    if (!valid.length) return null;
    const limit = Math.max(1, Number(this.data.settings?.max_send_per_reply) || 1);
    return valid[Math.floor(Math.random() * Math.min(valid.length, limit))];
  }

  /** 供上下文注入与工具调用的候选检索（多字段加权与语义模糊匹配） */
  search(query, limit = 5) {
    this._maybeReload();
    const q = String(query ?? '').trim().toLowerCase();
    // 拆分检索词：支持空格、标点、逗号、斜杠分词
    const words = q.split(/[\s,，、。！!？?\/|~_-]+/).filter(Boolean);

    return this.data.memes
      .filter((m) => this.isUsable(m) && this.resolveSafePath(m.path))
      .map((m) => {
        const name = String(m.name ?? '').toLowerCase();
        const cat = String(m.category ?? '').toLowerCase();
        const tag = String(m.tag ?? '').toLowerCase();
        const desc = String(m.description ?? '').toLowerCase();
        const kws = (m.keywords ?? []).map((k) => String(k).toLowerCase());
        const hay = [name, cat, tag, desc, ...kws].join(' ');

        let score = 0;
        // 1. 完全包含整串检索词
        if (q && hay.includes(q)) score += 10;
        if (q && tag.includes(q)) score += 6;
        if (q && desc.includes(q)) score += 5;

        // 2. 分词多字段重合度打分
        for (const w of words) {
          if (!w) continue;
          if (tag === w) score += 8;
          else if (tag.includes(w)) score += 4;

          if (kws.some((k) => k === w)) score += 6;
          else if (kws.some((k) => k.includes(w) || w.includes(k))) score += 3;

          if (desc.includes(w)) score += 3;
          if (cat.includes(w)) score += 2;
          if (name.includes(w)) score += 1;
        }

        return {
          id: m.id,
          score,
          tag: m.tag,
          category: m.category,
          description: m.description ?? '',
          keywords: m.keywords ?? [],
        };
      })
      .filter((x) => x.score > 0 || !q)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  get size() {
    return this.data.memes.length;
  }

  /** 获取语义表情包工具 Prompt 规则（逐字复刻旧 Bridge meme_manager.js:406） */
  getSemanticToolPrompt() {
    return DEFAULT_MEME_TOOL_PROMPT;
  }
}
