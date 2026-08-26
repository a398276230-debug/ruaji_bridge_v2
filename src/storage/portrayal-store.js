/**
 * storage/portrayal-store.js — 群友性格画像存储与自动化触发管理
 *
 * 学习自 astrbot_plugin_portrayal 的定性认知设计。
 * 存储路径收敛于 data/plugin_data/portrayal/profiles.json。
 */

import fs from 'node:fs';
import path from 'node:path';

export const AUTO_ANALYSIS_MSG_INTERVAL = 50; // 增量发言满 50 条
export const AUTO_ANALYSIS_INITIAL_THRESHOLD = 20; // 新用户首次分析门槛 20 条
export const AUTO_ANALYSIS_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 冷却时间 24 小时
export const RECENT_MESSAGES_CAP = 50; // 每人最多收纳多少条发言明细

/** 清洗群友发言：滤掉 CQ 码以及 [图片]、[语音]、[动画表情] 等无意义占位符 */
export function cleanUserMessageText(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .replace(/\[CQ:[^\]]*\]/gi, '')
    .replace(/\[(?:图片|图片消息|动画表情|表情|语音|视频|文件|screenshot|image|photo)\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 取正数配置值，非法/缺省时回落 */
function positiveOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 把 incoming 里尚未出现的项按序追加进 target，就地修改并返回 target。
 * 用 Set 去重，替掉散落各处的 `if (!arr.includes(x)) arr.push(x)`（O(n²)）。
 */
export function mergeUnique(target, incoming) {
  const seen = new Set(target);
  for (const item of incoming || []) {
    if (!seen.has(item)) {
      seen.add(item);
      target.push(item);
    }
  }
  return target;
}

/**
 * 实际收纳条数：totalMsgCount 是累计计数器，recentMessages 是被裁剪过的明细，
 * 历史数据里两者可能不一致，取大的那个更接近真实。
 */
function actualCount(stat) {
  return Math.max(stat?.totalMsgCount || 0, (stat?.recentMessages || []).length);
}

export class PortrayalStore {
  /**
   * @param {object} opts
   * @param {string} opts.file
   * @param {string[]} [opts.blacklistUsers]
   * @param {number} [opts.msgInterval] 增量分析门槛，缺省取 AUTO_ANALYSIS_MSG_INTERVAL
   * @param {number} [opts.initialThreshold] 首次分析门槛，缺省取 AUTO_ANALYSIS_INITIAL_THRESHOLD
   * @param {number} [opts.cooldownMs] 两次分析最小间隔，缺省取 AUTO_ANALYSIS_COOLDOWN_MS
   * @param {boolean} [opts.persistEnabled=true]
   * @param {import('../core/logger.js').Logger} [opts.logger]
   * @param {() => number} [opts.now]
   */
  constructor(opts = {}) {
    this.file = opts.file;
    this.tmpFile = `${opts.file}.v2.tmp`;
    this.blacklist = new Set((opts.blacklistUsers || []).map(String));
    // 门槛可由配置覆盖；非正数一律回落到默认值，避免 0 导致每条发言都触发分析
    this.msgInterval = positiveOr(opts.msgInterval, AUTO_ANALYSIS_MSG_INTERVAL);
    this.initialThreshold = positiveOr(opts.initialThreshold, AUTO_ANALYSIS_INITIAL_THRESHOLD);
    this.cooldownMs = positiveOr(opts.cooldownMs, AUTO_ANALYSIS_COOLDOWN_MS);
    // 收纳上限至少要够一次增量分析用，否则调大 msgInterval 反而喂不满模型
    this.maxRecentMessages = Math.max(RECENT_MESSAGES_CAP, this.msgInterval);
    this.persistEnabled = opts.persistEnabled === true;
    this.log = opts.logger?.child({ component: 'portrayal-store' }) ?? console;
    this.now = opts.now ?? Date.now;

    this.data = { profiles: {}, stats: {}, blacklist: [] };
    this._saveTimer = null;
    this.suppressedWrites = [];
    this.load();
  }

  /** 判断某用户是否在画像黑名单中 */
  isBlacklisted(uid) {
    if (!uid) return false;
    const key = String(uid);
    return this.blacklist.has(key) || (Array.isArray(this.data.blacklist) && this.data.blacklist.includes(key));
  }

  /** 添加用户到黑名单，并清理其已收纳发言与画像 */
  addBlacklist(uid) {
    const key = String(uid);
    this.blacklist.add(key);
    if (!Array.isArray(this.data.blacklist)) this.data.blacklist = [];
    if (!this.data.blacklist.includes(key)) this.data.blacklist.push(key);
    this.deleteTrackedUser(key);
    this.persist('addBlacklist', key);
    this.log.info('已将用户加入画像黑名单并清除记录', { uid: key });
    return true;
  }

  /** 从黑名单中移除用户 */
  removeBlacklist(uid) {
    const key = String(uid);
    this.blacklist.delete(key);
    if (Array.isArray(this.data.blacklist)) {
      this.data.blacklist = this.data.blacklist.filter((id) => id !== key);
    }
    this.persist('removeBlacklist', key);
    this.log.info('已从画像黑名单中移除用户', { uid: key });
    return true;
  }

  load() {
    try {
      if (this.file && fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (raw && (raw.profiles || raw.stats || raw.blacklist)) {
          this.data = {
            profiles: raw.profiles || {},
            stats: raw.stats || {},
            blacklist: Array.isArray(raw.blacklist) ? raw.blacklist : [],
          };
          if (Array.isArray(raw.blacklist)) {
            for (const b of raw.blacklist) this.blacklist.add(String(b));
          }
          this.log.info('群友画像数据已加载', {
            file: path.basename(this.file),
            profiles: Object.keys(this.data.profiles).length,
            blacklist: this.blacklist.size,
          });
          return;
        }
      }
    } catch (err) {
      this.log.error('群友画像数据读取失败，以空数据运行', { error: err.message });
    }
    this.data = { profiles: {}, stats: {}, blacklist: [] };
  }

  /** 获取指定用户画像 */
  getProfile(uid) {
    const key = String(uid);
    const p = this.data.profiles[key];
    if (!p) return null;
    const stat = this.data.stats[key] || {};
    return {
      ...p,
      totalMsgCount: actualCount(stat),
      lastMsgCountAtAnalysis: stat.lastMsgCountAtAnalysis || 0,
      lastSeen: stat.lastSeen || null,
      needsAutoAnalysis: this.needsAutoAnalysis(key),
    };
  }

  /** 获取所有画像列表（包含统计数据） */
  listProfiles() {
    return Object.entries(this.data.profiles).map(([uid, p]) => {
      const stat = this.data.stats[uid] || {};
      return {
        uid,
        ...p,
        totalMsgCount: actualCount(stat),
        lastMsgCountAtAnalysis: stat.lastMsgCountAtAnalysis || 0,
        lastSeen: stat.lastSeen || null,
        needsAutoAnalysis: this.needsAutoAnalysis(uid),
      };
    });
  }

  /** 获取所有被收纳消息追踪的群友列表 */
  listTrackedUsers() {
    return Object.entries(this.data.stats).map(([uid, stat]) => {
      return {
        uid,
        nickname: stat.nickname || uid,
        totalMsgCount: actualCount(stat),
        lastMsgCountAtAnalysis: stat.lastMsgCountAtAnalysis || 0,
        lastAnalyzedAt: stat.lastAnalyzedAt || 0,
        lastSeen: stat.lastSeen || null,
        hasProfile: Boolean(this.data.profiles[uid]),
        needsAutoAnalysis: this.needsAutoAnalysis(uid),
      };
    }).sort((a, b) => b.totalMsgCount - a.totalMsgCount);
  }

  /** 记录用户一次发言，更新统计并保留最近发言明细（黑名单用户直接跳过） */
  recordUserMessage(uid, nickname, messageText = '') {
    const key = String(uid);
    if (this.isBlacklisted(key)) return null;

    let stat = this.data.stats[key];
    const now = this.now();
    if (!stat) {
      stat = this.data.stats[key] = {
        nickname: nickname || key,
        totalMsgCount: 1,
        lastMsgCountAtAnalysis: 0,
        lastAnalyzedAt: 0,
        lastSeen: new Date(now).toISOString(),
        recentMessages: [],
      };
    } else {
      stat.nickname = nickname || stat.nickname;
      stat.totalMsgCount = (stat.totalMsgCount || 0) + 1;
      stat.lastSeen = new Date(now).toISOString();
      if (!Array.isArray(stat.recentMessages)) stat.recentMessages = [];
    }

    if (messageText && typeof messageText === 'string') {
      const clean = cleanUserMessageText(messageText);
      if (clean && clean.length > 1 && !clean.startsWith('/')) {
        stat.recentMessages.push({
          text: clean,
          time: new Date(now).toISOString(),
        });
        while (stat.recentMessages.length > this.maxRecentMessages) {
          stat.recentMessages.shift();
        }
      }
    }

    this.persist('recordUserMessage', key);
    return stat;
  }

  /** 将召回的历史发言填充进用户的持久化记录中（自动清洗占位符） */
  seedHistory(uid, nickname, messages) {
    const key = String(uid);
    let stat = this.data.stats[key];
    const now = this.now();
    if (!stat) {
      stat = this.data.stats[key] = {
        nickname: nickname || key,
        totalMsgCount: 0,
        lastMsgCountAtAnalysis: 0,
        lastAnalyzedAt: 0,
        lastSeen: new Date(now).toISOString(),
        recentMessages: [],
      };
    }
    if (!Array.isArray(stat.recentMessages)) stat.recentMessages = [];

    // 清洗并去重既有消息中的残存 [图片] 占位符
    stat.recentMessages = stat.recentMessages.filter((m) => {
      const cleaned = cleanUserMessageText(m.text);
      if (cleaned && cleaned.length > 0) {
        m.text = cleaned;
        return true;
      }
      return false;
    });

    for (const msg of messages || []) {
      const rawText = typeof msg === 'string' ? msg.replace(/^[^:]+:\s*/, '').trim() : String(msg).trim();
      const clean = cleanUserMessageText(rawText);
      if (clean && clean.length > 0 && !clean.startsWith('/') && !stat.recentMessages.some((m) => m.text === clean)) {
        stat.recentMessages.push({ text: clean, time: new Date(now).toISOString() });
      }
    }
    stat.totalMsgCount = Math.max(stat.totalMsgCount, stat.recentMessages.length);
    this.persist('seedHistory', key);
    return stat;
  }

  /** 获取指定用户已持久化保存的最近发言列表 */
  getUserRecentMessages(uid) {
    const key = String(uid);
    const stat = this.data.stats[key];
    if (!stat || !Array.isArray(stat.recentMessages)) return [];
    return stat.recentMessages.map((m) => `${stat.nickname || key}: ${m.text}`);
  }

  /**
   * 判断指定用户是否满足自动化画像分析条件
   * @param {string} uid
   * @returns {boolean}
   */
  needsAutoAnalysis(uid) {
    const key = String(uid);
    if (this.isBlacklisted(key)) return false;

    const stat = this.data.stats[key];
    if (!stat) return false;

    const now = this.now();
    const timeSinceLast = now - (stat.lastAnalyzedAt || 0);
    if (timeSinceLast < this.cooldownMs) return false;

    const profile = this.data.profiles[key];
    const total = stat.totalMsgCount || 0;
    const lastAt = stat.lastMsgCountAtAnalysis || 0;

    // 首次分析：达到初始门槛；后续分析：达到增量门槛
    if (!profile) {
      return total >= this.initialThreshold;
    }
    return total - lastAt >= this.msgInterval;
  }

  /** 保存或更新用户画像 */
  setProfile(uid, profileData) {
    const key = String(uid);
    const now = this.now();
    const existing = this.data.profiles[key] || {};
    const stat = this.data.stats[key] || { totalMsgCount: 0 };

    this.data.profiles[key] = {
      ...existing,
      ...profileData,
      userId: key,
      nickname: profileData.nickname || existing.nickname || stat.nickname || key,
      tags: Array.isArray(profileData.tags) ? profileData.tags : (existing.tags || []),
      summary: profileData.summary || existing.summary || '',
      taboos: profileData.taboos || existing.taboos || '',
      suggestion: profileData.suggestion || existing.suggestion || '',
      clonePrompt: profileData.clonePrompt !== undefined ? profileData.clonePrompt : (existing.clonePrompt || ''),
      updatedAt: new Date(now).toISOString(),
    };

    // 更新统计中的分析游标
    if (this.data.stats[key]) {
      this.data.stats[key].lastMsgCountAtAnalysis = this.data.stats[key].totalMsgCount || 0;
      this.data.stats[key].lastAnalyzedAt = now;
    }

    this.persist('setProfile', key);
    this.log.info('用户画像已更新', { uid: key, tags: this.data.profiles[key].tags });
    return this.data.profiles[key];
  }

  /** 删除某个用户的画像数据 */
  deleteProfile(uid) {
    const key = String(uid);
    if (!this.data.profiles[key]) return false;
    delete this.data.profiles[key];
    this.persist('deleteProfile', key);
    this.log.info('已删除用户画像', { uid: key });
    return true;
  }

  /** 删除某个用户的发言收纳记录（包括计数与最近发言） */
  deleteTrackedUser(uid) {
    const key = String(uid);
    let deleted = false;
    if (this.data.stats[key]) {
      delete this.data.stats[key];
      deleted = true;
    }
    if (this.data.profiles[key]) {
      delete this.data.profiles[key];
      deleted = true;
    }
    if (deleted) {
      this.persist('deleteTrackedUser', key);
      this.log.info('已清除用户发言收纳与画像记录', { uid: key });
    }
    return deleted;
  }

  /** 一键清理所有未生成画像的收纳记录 */
  clearAllTrackedWithoutProfiles() {
    let count = 0;
    for (const key of Object.keys(this.data.stats)) {
      if (!this.data.profiles[key]) {
        delete this.data.stats[key];
        count++;
      }
    }
    if (count > 0) {
      this.persist('clearAllTrackedWithoutProfiles', 'batch');
      this.log.info('已批量清理未生成画像的群友收纳缓存', { count });
    }
    return count;
  }

  /** 获取用于 System Prompt 注入的精炼单行字符串 */
  getCompactContext(uid) {
    const profile = this.getProfile(uid);
    if (!profile) return '';

    const parts = [];
    if (profile.tags && profile.tags.length > 0) {
      parts.push(`画像: ${profile.tags.slice(0, 4).join('/')}`);
    }
    if (profile.summary) {
      parts.push(`简述: ${profile.summary}`);
    }
    if (profile.taboos) {
      parts.push(`雷区: ${profile.taboos}`);
    }
    if (profile.suggestion) {
      parts.push(`建议: ${profile.suggestion}`);
    }
    return parts.length > 0 ? parts.join(' | ') : '';
  }

  persist(operation, uid) {
    if (!this.persistEnabled) {
      this.suppressedWrites.push({ operation, uid, at: this.now() });
      return;
    }
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        if (this.file) {
          const dir = path.dirname(this.file);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(this.tmpFile, JSON.stringify(this.data, null, 2), 'utf8');
          fs.renameSync(this.tmpFile, this.file);
        }
      } catch (err) {
        this.log.error('用户画像落盘失败', { error: err.message });
      }
    }, 800);
    if (typeof this._saveTimer.unref === 'function') this._saveTimer.unref();
  }

  flush() {
    if (!this.persistEnabled || !this.file) return;
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    try {
      const dir = path.dirname(this.file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.tmpFile, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(this.tmpFile, this.file);
    } catch (err) {
      this.log.error('用户画像最终落盘失败', { error: err.message });
    }
  }
}
