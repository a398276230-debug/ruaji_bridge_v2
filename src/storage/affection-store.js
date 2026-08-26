/**
 * storage/affection-store.js — 好感度存储 Adapter
 *
 * 直接读旧 Bridge 的 affection.json，格式一字不改（阶段 12：优先兼容旧数据，
 * 避免强制搬迁）。存量的 users 结构、字段名、数值都原样沿用。
 *
 * 写入策略：
 *   - sideEffectsEnabled=false（影子模式强制）→ 只在内存里算，绝不落盘。
 *     这是验收标准 14 的实现点：影子模式无持久化副作用。
 *   - sideEffectsEnabled=true → 写回同一个 affection.json。切换后旧 Bridge
 *     已停机，不存在并发写；好感度因此可以无缝延续，不需要一次性迁移。
 *
 * 规则全部迁移自 affection.js：
 *   - 主人恒 100，非主人初始 20、上限 90
 *   - delta 钳制在 [-5, +5]
 *   - 超过 7 天未互动每天衰减 1 点，单次最多扣 10
 *   - 每日首条微增 0.01
 *   - recentDeltas 只留最近 5 条
 */

import fs from 'node:fs';
import path from 'node:path';

export const MIN_AFFECTION = -100;
export const MAX_AFFECTION = 100;
export const NON_OWNER_MAX_AFFECTION = 90;
export const INITIAL_AFFECTION = 20;
export const DELTA_CLAMP = 5;

/** 冷暴力配置（学习自 Favour_Ultra） */
export const COLD_VIOLENCE_THRESHOLD = 3; // 连续 3 次扣分触发冷暴力
export const RELATION_BREAKUP_THRESHOLD = -20; // 好感低于此值，排他性关系自动决裂
export const COLD_VIOLENCE_DURATION_MS = 60 * 60 * 1000; // 冷暴力持续 60 分钟

/** 10 阶关系阶梯（支持负好感到挚友与绑定者） */
export const RELATION_STAGES = Object.freeze([
  [-100, -81, '死敌', 'nemesis'],
  [-80, -51, '厌恶', 'hostile'],
  [-50, -21, '嫌弃', 'aversive'],
  [-20, -1, '警惕', 'wary'],
  [0, 20, '陌生人', 'stranger'],
  [21, 40, '点头之交', 'acquaintance'],
  [41, 60, '熟络群友', 'familiar'],
  [61, 80, '聊得来的朋友', 'friend'],
  [81, 90, '挚友', 'close_friend'],
  [91, 100, '灵魂之友', 'soulmate'],
]);

export const OWNER_RELATION = '另一个自己 (唯一绑定者)';

export function getRelationStage(affection) {
  for (const [lo, hi, title, key] of RELATION_STAGES) {
    if (affection >= lo && affection <= hi) return { title, key };
  }
  return { title: '陌生人', key: 'stranger' };
}

export class AffectionStore {
  /**
   * @param {object} opts
   * @param {string} opts.file            旧 affection.json 的绝对路径
   * @param {string} opts.ownerId
   * @param {string} opts.robotId
   * @param {boolean} opts.persistEnabled 对应 reply.sideEffectsEnabled
   * @param {import('../core/logger.js').Logger} [opts.logger]
   * @param {() => number} [opts.now]
   */
  constructor(opts = {}) {
    this.file = opts.file;
    this.tmpFile = `${opts.file}.v2.tmp`;
    this.ownerId = String(opts.ownerId ?? '');
    this.robotId = String(opts.robotId ?? '');
    this.persistEnabled = opts.persistEnabled === true;
    this.log = opts.logger?.child({ component: 'affection-store' }) ?? console;
    this.now = opts.now ?? Date.now;

    this.data = { users: {} };
    this._saveTimer = null;
    /** 影子模式下记录"本来会写什么"，供对照报告使用 */
    this.suppressedWrites = [];
    this.load();
  }

  isOwner(uid) {
    return String(uid) === this.ownerId;
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (raw && raw.users) {
          this.data = raw;
          this.log.info('好感度数据已加载', {
            file: path.basename(this.file),
            users: Object.keys(raw.users).length,
          });
          return;
        }
      }
    } catch (err) {
      // 不改名、不动旧文件：读失败就空跑，让旧 Bridge 自己去处理它的 .corrupt 备份
      this.log.error('好感度数据读取失败，本次以空数据运行', { error: err.message });
    }
    this.data = { users: {} };
  }

  /** 记录一次互动。返回该用户的最新记录。 */
  onUserMessage({ uid, nickname }) {
    const key = String(uid);
    if (key === this.robotId) return null;

    const now = this.now();
    let user = this.data.users[key];

    if (!user) {
      user = this.data.users[key] = {
        nickname: nickname || key,
        affection: this.isOwner(key) ? MAX_AFFECTION : INITIAL_AFFECTION,
        relationship: this.isOwner(key) ? OWNER_RELATION : '陌生人',
        emotional_state: 'calm',
        interactions: 0,
        consecutiveDecreases: 0,
        coldViolenceUntil: null,
        firstSeen: new Date(now).toISOString(),
        lastSeen: new Date(now).toISOString(),
        lastDay: '',
        lastDecay: now,
        recentDeltas: [],
      };
    } else {
      user.nickname = nickname || user.nickname;
      user.lastSeen = new Date(now).toISOString();
      if (user.consecutiveDecreases === undefined) user.consecutiveDecreases = 0;
      if (user.coldViolenceUntil === undefined) user.coldViolenceUntil = null;
    }

    // 衰减：超过 7 天未互动，每天 1 点，单次最多 10
    if (user.lastDecay && !this.isOwner(key)) {
      const daysAway = Math.floor((now - user.lastDecay) / 86400000);
      if (daysAway > 7) {
        user.affection = Math.max(0, user.affection - Math.min(daysAway - 7, 10));
      }
    }
    user.lastDecay = now;
    user.interactions++;

    if (this.isOwner(key)) {
      user.affection = MAX_AFFECTION;
      user.relationship = OWNER_RELATION;
    } else {
      const today = new Date(now).toISOString().split('T')[0];
      if (user.lastDay !== today) {
        user.affection = Math.min(NON_OWNER_MAX_AFFECTION, user.affection + 0.01);
        user.lastDay = today;
      }
      user.relationship = getRelationStage(user.affection).title;
    }

    this.persist('onUserMessage', key);
    return user;
  }

  /**
   * 应用一次好感度增量。
   * 主人恒满 100、不评估 —— 直接返回 null，调用方据此跳过日志与注入。
   */
  applyDelta(uid, delta, reason) {
    const key = String(uid);
    if (this.isOwner(key)) return null;

    let user = this.data.users[key];
    if (!user) user = this.onUserMessage({ uid: key, nickname: key });
    if (!user) return null;

    const clamped = Math.max(-DELTA_CLAMP, Math.min(DELTA_CLAMP, parseFloat(delta) || 0));
    user.affection = Math.max(MIN_AFFECTION, Math.min(NON_OWNER_MAX_AFFECTION, user.affection + clamped));

    // 好感度跌破 -20 时，排他性关系自然决裂
    if (user.affection < RELATION_BREAKUP_THRESHOLD && user.is_unique) {
      this.log.warn('好感度跌破警戒线，排他性关系已自动决裂解除', { uid: key, relation: user.relationship });
      user.is_unique = false;
    }
    // 自定义的独占关系名不被阶段名覆盖；其余一律跟随阶段走
    if (!user.is_unique) {
      user.relationship = getRelationStage(user.affection).title;
    }

    // 连续扣分与冷暴力逻辑（学习自 Favour_Ultra）
    if (clamped < 0) {
      user.consecutiveDecreases = (user.consecutiveDecreases || 0) + 1;
      if (user.consecutiveDecreases >= COLD_VIOLENCE_THRESHOLD) {
        user.coldViolenceUntil = this.now() + COLD_VIOLENCE_DURATION_MS;
        user.emotional_state = 'cold_violence';
        user.consecutiveDecreases = 0; // 惩罚已触发，重置连续计数，避免到期后 1 次扣分直接重触发
        this.log.warn('用户触发冷暴力状态', {
          uid: key,
          coldViolenceUntil: new Date(user.coldViolenceUntil).toISOString(),
        });
      }
    } else if (clamped > 0) {
      user.consecutiveDecreases = 0;
      // 若已有正面互动且冷暴力已过，恢复平稳状态
      if (!this.isColdViolent(key) && user.emotional_state === 'cold_violence') {
        user.emotional_state = 'calm';
      }
    }

    if (reason) {
      if (!user.recentDeltas) user.recentDeltas = [];
      user.recentDeltas.unshift({ delta: clamped, reason, ts: new Date(this.now()).toISOString() });
      if (user.recentDeltas.length > 5) user.recentDeltas.pop();
    }

    this.persist('applyDelta', key);
    return { ...user, appliedDelta: clamped };
  }

  /** 获取持有指定排他关系的用户 uid */
  getUniqueRelationHolder(relName) {
    if (!relName) return null;
    for (const [uid, u] of Object.entries(this.data.users)) {
      if (u.is_unique && u.relationship === relName) return uid;
    }
    return null;
  }

  /**
   * 设置关系（支持排他独占校验）
   * @param {string} uid
   * @param {string} relName
   * @param {boolean} [isUnique=false]
   * @returns {{ ok: boolean, error?: string, holder?: string }}
   */
  setRelation(uid, relName, isUnique = false) {
    const key = String(uid);
    if (this.isOwner(key)) return { ok: false, error: '主人关系不可更改' };
    let user = this.data.users[key];
    if (!user) {
      this.onUserMessage({ uid: key, nickname: key });
      user = this.data.users[key];
    }
    if (!user) return { ok: false, error: '用户初始化失败' };

    if (isUnique && relName) {
      const holder = this.getUniqueRelationHolder(relName);
      if (holder && holder !== key) {
        return { ok: false, error: `排他性关系【${relName}】已被用户 ${holder} 绑定`, holder };
      }
    }

    user.relationship = relName || getRelationStage(user.affection).title;
    user.is_unique = Boolean(isUnique);
    this.persist('setRelation', key);
    this.log.info('已更新用户关系', { uid: key, relationship: user.relationship, is_unique: user.is_unique });
    return { ok: true };
  }

  /** 清除自定义关系，回退为阶段默认名 */
  clearRelation(uid) {
    const key = String(uid);
    if (this.isOwner(key)) return false;
    const user = this.data.users[key];
    if (!user) return false;
    user.relationship = getRelationStage(user.affection).title;
    user.is_unique = false;
    this.persist('clearRelation', key);
    this.log.info('已清除用户自定义关系', { uid: key });
    return true;
  }

  /** 判断用户当前是否处于冷暴力生效期 */
  isColdViolent(uid) {
    const key = String(uid);
    if (this.isOwner(key)) return false;
    const user = this.data.users[key];
    if (!user || !user.coldViolenceUntil) return false;
    return this.now() < user.coldViolenceUntil;
  }

  /** 获取冷暴力剩余分钟数 */
  getColdRemainingMinutes(uid) {
    const key = String(uid);
    if (this.isOwner(key)) return 0;
    const user = this.data.users[key];
    if (!user || !user.coldViolenceUntil) return 0;
    const remainingMs = user.coldViolenceUntil - this.now();
    return remainingMs > 0 ? Math.ceil(remainingMs / 60000) : 0;
  }

  /** 手动解除冷暴力状态 */
  liftColdViolence(uid) {
    const key = String(uid);
    const user = this.data.users[key];
    if (!user) return false;
    const wasCold = Boolean(user.coldViolenceUntil) || user.consecutiveDecreases > 0 || user.emotional_state === 'cold_violence';
    if (!wasCold) return false;
    user.coldViolenceUntil = null;
    user.consecutiveDecreases = 0;
    if (user.emotional_state === 'cold_violence') user.emotional_state = 'calm';
    this.persist('liftColdViolence', key);
    this.log.info('已解除用户冷暴力状态', { uid: key });
    return true;
  }

  /** 手动触发冷暴力状态 */
  triggerColdViolence(uid, durationMs = COLD_VIOLENCE_DURATION_MS) {
    const key = String(uid);
    if (this.isOwner(key)) return false;
    let user = this.data.users[key];
    if (!user) {
      this.onUserMessage({ uid: key, nickname: key });
      user = this.data.users[key];
    }
    if (!user) return false;
    user.coldViolenceUntil = this.now() + durationMs;
    user.emotional_state = 'cold_violence';
    user.consecutiveDecreases = 0;
    this.persist('triggerColdViolence', key);
    this.log.info('已手动设置用户冷暴力状态', {
      uid: key,
      coldViolenceUntil: new Date(user.coldViolenceUntil).toISOString(),
    });
    return true;
  }

  /**
   * 管理员手动设定绝对值（运维面板专用，不走模型打分路径）。
   *
   * 与 applyDelta 的区别刻意做得很明确：
   *   applyDelta 是模型的评分结果，钳制在 ±5，是"一次互动的影响"
   *   adminSet   是人的判断，直接落到目标值，是"把这个人的关系重设成这样"
   * 混用一个方法会让审计日志里再也分不清哪次变动是模型做的、哪次是人做的。
   *
   * 主人恒 100 的规则在这里同样不可绕过 —— 那是人设约束，不是数据约束。
   *
   * @param {string} uid
   * @param {number} value    目标值，钳制到 [0, 非主人上限]
   * @param {string} [reason]
   * @returns {{user: object, from: number, to: number, persisted: boolean}|null}
   */
  adminSet(uid, value, reason = '管理员手动调整') {
    const key = String(uid);
    if (key === this.robotId) return null;
    if (this.isOwner(key)) return null;

    let user = this.data.users[key];
    if (!user) user = this.onUserMessage({ uid: key, nickname: key });
    if (!user) return null;

    const from = user.affection;
    const parsed = parseFloat(value);
    if (!Number.isFinite(parsed)) return null;

    user.affection = Math.max(MIN_AFFECTION, Math.min(NON_OWNER_MAX_AFFECTION, parsed));
    if (user.affection < RELATION_BREAKUP_THRESHOLD && user.is_unique) {
      user.is_unique = false;
    }
    user.relationship = getRelationStage(user.affection).title;

    if (!user.recentDeltas) user.recentDeltas = [];
    user.recentDeltas.unshift({
      delta: Math.round((user.affection - from) * 100) / 100,
      reason,
      ts: new Date(this.now()).toISOString(),
      source: 'admin',
    });
    if (user.recentDeltas.length > 5) user.recentDeltas.pop();

    this.persist('adminSet', key);
    return { user, from, to: user.affection, persisted: this.persistEnabled };
  }

  /** 供 Prompt 注入使用的精简上下文 */
  getContext(uid) {
    const key = String(uid);
    const user = this.data.users[key];
    if (!user) {
      return {
        affection: INITIAL_AFFECTION,
        level: '陌生人',
        relationship: '陌生人',
        is_unique: false,
        interactions: 0,
        isColdViolent: false,
        coldRemainingMinutes: 0,
        consecutiveDecreases: 0,
        atMax: false,
        atMin: false,
      };
    }
    const isCold = this.isColdViolent(key);
    const roundedAff = Math.round(user.affection);
    const isOwner = this.isOwner(key);
    return {
      affection: roundedAff,
      level: getRelationStage(user.affection).title,
      relationship: user.relationship || getRelationStage(user.affection).title,
      is_unique: Boolean(user.is_unique),
      interactions: user.interactions,
      isColdViolent: isCold,
      coldRemainingMinutes: this.getColdRemainingMinutes(key),
      consecutiveDecreases: user.consecutiveDecreases || 0,
      atMax: !isOwner && roundedAff >= NON_OWNER_MAX_AFFECTION,
      atMin: !isOwner && roundedAff <= MIN_AFFECTION,
    };
  }

  getUser(uid) {
    return this.data.users[String(uid)] ?? null;
  }

  listUsers() {
    return Object.entries(this.data.users)
      .filter(([k]) => k !== this.robotId)
      .sort((a, b) => b[1].affection - a[1].affection);
  }

  /**
   * 落盘。影子模式下只记录不写。
   * 用 tmp + rename 保证原子性；tmp 文件名带 .v2 前缀，避免与旧 Bridge 的
   * affection.json.tmp 撞车。
   */
  persist(operation, uid) {
    if (!this.persistEnabled) {
      this.suppressedWrites.push({ operation, uid, at: this.now() });
      return;
    }
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        fs.writeFileSync(this.tmpFile, JSON.stringify(this.data, null, 2), 'utf8');
        fs.renameSync(this.tmpFile, this.file);
      } catch (err) {
        this.log.error('好感度落盘失败', { error: err.message });
      }
    }, 800);
    if (typeof this._saveTimer.unref === 'function') this._saveTimer.unref();
  }

  /** 进程退出前强制同步落盘一次 */
  flush() {
    if (!this.persistEnabled) return;
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    try {
      fs.writeFileSync(this.tmpFile, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(this.tmpFile, this.file);
    } catch (err) {
      this.log.error('好感度最终落盘失败', { error: err.message });
    }
  }
}

/** 进度条（affection.js:177-180） */
export function formatBar(affection) {
  const filled = Math.max(0, Math.min(10, Math.round(affection / 10)));
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}
