/**
 * storage/wake-cursor-store.js — 异步唤醒回推的游标与去重记录
 *
 * 三张表：
 *   cursors[sessionId] = { lastRowId, updatedAt }
 *     会话 transcript 已消费到哪一行。**必须持久化**：桥接重启后要靠它只补发
 *     没投递过的通知（重启即丢会静默漏掉"任务跑完但桥接正好在重启"的结果）。
 *   handled[anchorKey] = updatedAt
 *     已投递过的分体通知锚点去重。唤醒块"兜底提示先发、模型回复后到"的场景要靠它
 *     保证同一个锚点只推一条；游标回退了也不会复读。
 *   anchors[contractSessionId] = { messageId, turnId, matched, createdAt, updatedAt }
 *     异步完成通知要引用的"派发那条消息"的真实 QQ message_id（"引用锚点"）。
 *     键是契约会话 id（qq:group:777 / qq:private:888），与 wake-flow 投递时的
 *     target 同源；**必须持久化**：后台任务常常跑几分钟到几小时，桥接中途重启
 *     后通知仍要能引用到派发消息。记录与消费策略在
 *     orchestration/reply-anchor-tracker.js。
 *
 * 锚点单独一张表、**不放进 cursors**：游标是 per Hermes 会话（带日期/轮换后缀，
 * 如 qq_group_777_20260922_1），锚点是 per QQ 目标（qq:group:777），两者粒度不同，
 * 会话轮换后锚点仍要复用。
 *
 * 与 ModelSessionStore 同一套落盘纪律：tmp(带 pid) + rename 原子替换、损坏文件改名
 * 隔离而不是直接丢弃、按保留天数裁剪防止文件无限膨胀。
 */

import fs from 'node:fs';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;
/** handled 的硬上限，防止长跑后内存/文件无限增长（超出按最旧淘汰） */
const MAX_HANDLED = 4000;
/** anchors 的硬上限：只有活跃会话才有锚点，正常远小于这个数 */
const MAX_ANCHORS = 500;

export class WakeCursorStore {
  /**
   * @param {object} opts
   * @param {string} opts.cacheDir
   * @param {boolean} [opts.persistEnabled=true]
   * @param {number} [opts.retainDays=7]
   * @param {() => number} [opts.now]
   * @param {import('../core/logger.js').Logger} [opts.logger]
   */
  constructor(opts = {}) {
    this.cacheDir = opts.cacheDir;
    this.persistEnabled = opts.persistEnabled !== false;
    this.retainDays = Number.isInteger(opts.retainDays) && opts.retainDays >= 0 ? opts.retainDays : 7;
    this.now = opts.now ?? Date.now;
    this.log = opts.logger?.child({ component: 'wake-cursor-store' }) ?? console;
    this.file = this.cacheDir ? path.join(this.cacheDir, 'wake_cursors.json') : null;
    this.tmpFile = this.file ? `${this.file}.${process.pid}.tmp` : null;

    /** sessionId -> { lastRowId: number, updatedAt: number } */
    this.cursors = new Map();
    /** anchorKey -> updatedAt（毫秒） */
    this.handled = new Map();
    /** contractSessionId -> { messageId, turnId, matched, createdAt, updatedAt } */
    this.anchors = new Map();
    this.load();
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      this.quarantine(err);
      return;
    }
    if (raw && typeof raw === 'object') {
      for (const [key, value] of Object.entries(raw.cursors ?? {})) {
        const lastRowId = Number(value?.lastRowId);
        if (key && Number.isFinite(lastRowId)) {
          this.cursors.set(key, {
            lastRowId,
            messageCount: Number.isFinite(Number(value?.messageCount)) ? Number(value.messageCount) : 0,
            updatedAt: Number(value?.updatedAt) || 0,
          });
        }
      }
      for (const [key, value] of Object.entries(raw.handled ?? {})) {
        const at = Number(value);
        if (key && Number.isFinite(at)) this.handled.set(key, at);
      }
      for (const [key, value] of Object.entries(raw.anchors ?? {})) {
        const messageId = value?.messageId == null ? '' : String(value.messageId);
        if (!key || !messageId) continue;
        const updatedAt = Number(value?.updatedAt) || 0;
        this.anchors.set(key, {
          messageId,
          turnId: value?.turnId == null ? null : String(value.turnId),
          matched: value?.matched === 'dispatch' ? 'dispatch' : (value?.matched ?? 'first'),
          createdAt: Number(value?.createdAt) || updatedAt || 0,
          updatedAt,
        });
      }
    }
    const dropped = this.prune();
    this.log.info('唤醒回推游标已加载', {
      cursors: this.cursors.size,
      handled: this.handled.size,
      anchors: this.anchors.size,
      dropped,
    });
  }

  /** 损坏文件改名留档（与 ModelSessionStore 同款思路） */
  quarantine(err) {
    const target = `${this.file}.corrupt_${Date.now()}`;
    try {
      fs.renameSync(this.file, target);
      this.log.warn('唤醒回推游标文件损坏，已隔离留档', { error: err.message, target });
    } catch (renameErr) {
      this.log.warn('唤醒回推游标加载失败，使用空白记录', {
        error: err.message,
        renameError: renameErr.message,
      });
    }
  }

  /**
   * 裁剪过期记录。基准用「记录里的最新时间」而不是墙上时钟：结果只跟数据有关，
   * 不会因为时钟跳变把有效游标误删。
   * @returns {number} 被裁掉的条数
   */
  prune() {
    const floorOf = () => {
      let newest = 0;
      for (const v of this.cursors.values()) if (v.updatedAt > newest) newest = v.updatedAt;
      for (const v of this.handled.values()) if (v > newest) newest = v;
      for (const v of this.anchors.values()) if (v.updatedAt > newest) newest = v.updatedAt;
      return newest > 0 ? newest - this.retainDays * DAY_MS : 0;
    };

    const floor = floorOf();
    let dropped = 0;
    if (floor > 0) {
      for (const [key, value] of this.cursors) {
        if (!value.updatedAt || value.updatedAt < floor) {
          this.cursors.delete(key);
          dropped += 1;
        }
      }
      for (const [key, at] of this.handled) {
        if (!at || at < floor) {
          this.handled.delete(key);
          dropped += 1;
        }
      }
      for (const [key, value] of this.anchors) {
        if (!value.updatedAt || value.updatedAt < floor) {
          this.anchors.delete(key);
          dropped += 1;
        }
      }
    }
    // Map 保序（插入顺序），超出上限从最旧开始删
    while (this.handled.size > MAX_HANDLED) {
      const oldest = this.handled.keys().next().value;
      this.handled.delete(oldest);
      dropped += 1;
    }
    while (this.anchors.size > MAX_ANCHORS) {
      const oldest = this.anchors.keys().next().value;
      this.anchors.delete(oldest);
      dropped += 1;
    }
    return dropped;
  }

  save() {
    if (!this.persistEnabled || !this.file || !this.tmpFile) return;
    try {
      this.prune();
      fs.mkdirSync(this.cacheDir, { recursive: true });
      const payload = {
        version: 1,
        cursors: Object.fromEntries(this.cursors),
        handled: Object.fromEntries(this.handled),
        anchors: Object.fromEntries(this.anchors),
      };
      fs.writeFileSync(this.tmpFile, JSON.stringify(payload), 'utf8');
      fs.renameSync(this.tmpFile, this.file);
    } catch (err) {
      this.log.warn('唤醒回推游标保存失败', { error: err.message });
      try {
        if (fs.existsSync(this.tmpFile)) fs.unlinkSync(this.tmpFile);
      } catch {
        /* ignore */
      }
    }
  }

  /** @returns {{lastRowId: number, messageCount: number, updatedAt: number}|null} */
  getCursor(sessionId) {
    return this.cursors.get(String(sessionId)) ?? null;
  }

  /**
   * 推进游标（只前进，不回退），并顺带记下本次看到的 message_count，
   * 下一跳拿它跟会话列表比对，就能跳过没变化的会话（少读 transcript）。
   * @param {string} sessionId
   * @param {number} lastRowId
   * @param {{messageCount?: number}} [opts]
   */
  setCursor(sessionId, lastRowId, opts = {}) {
    const key = String(sessionId);
    const next = Number(lastRowId);
    if (!key || !Number.isFinite(next)) return;
    const current = this.cursors.get(key);
    const count = Number(opts.messageCount);
    const nextCount = Number.isFinite(count) ? count : current?.messageCount ?? 0;
    const nextRow = Math.max(next, current?.lastRowId ?? 0);
    if (current && current.lastRowId === nextRow && current.messageCount === nextCount) return;
    this.cursors.set(key, { lastRowId: nextRow, messageCount: nextCount, updatedAt: this.now() });
    this.save();
  }

  /**
   * 冷启动基线（缺陷二）：给一个"没有游标记录"的会话建立起点。
   *
   * 语义与 setCursor 不同：这是**初始化**而不是推进——把游标直接放到当前最新
   * 行号，并把历史块的稳定去重键（stableKey / dedupKey / anchorKey）一次性回填
   * 进 handled。于是重启后既不会把历史转述喷发出去，将来 transcript 改写重分号
   * 也拦得住（靠稳定键）。
   *
   * 整体只落盘一次（不是逐条 markHandled 各写一次文件），后一次 prune 顺带裁。
   *
   * @param {string} sessionId
   * @param {{lastRowId: number, messageCount?: number, handledKeys?: string[]}} opts
   * @returns {{marked: number, lastRowId: number}}
   */
  snapshotSession(sessionId, { lastRowId, messageCount, handledKeys = [] } = {}) {
    const key = String(sessionId);
    if (!key) return { marked: 0, lastRowId: 0 };
    const now = this.now();
    let marked = 0;
    for (const raw of handledKeys) {
      const k = raw == null ? '' : String(raw);
      if (!k) continue;
      // 重新 set 让它在 Map 尾部（保持"插入顺序 ≈ 淘汰顺序"）
      this.handled.delete(k);
      this.handled.set(k, now);
      marked += 1;
    }
    const next = Number(lastRowId);
    const current = this.cursors.get(key);
    const count = Number(messageCount);
    if (Number.isFinite(next)) {
      this.cursors.set(key, {
        lastRowId: Math.max(next, current?.lastRowId ?? 0),
        messageCount: Number.isFinite(count) ? count : current?.messageCount ?? 0,
        updatedAt: now,
      });
    }
    this.prune();
    this.save();
    return { marked, lastRowId: this.cursors.get(key)?.lastRowId ?? 0 };
  }

  isHandled(anchorKey) {
    return this.handled.has(String(anchorKey));
  }

  markHandled(anchorKey) {
    const key = String(anchorKey);
    if (!key) return;
    // 重新 set 让它在 Map 尾部（保持"插入顺序 ≈ 淘汰顺序"）
    this.handled.delete(key);
    this.handled.set(key, this.now());
    this.save();
  }

  // ===== 引用锚点 =====

  /** @returns {{messageId: string, turnId: string|null, matched: string, createdAt: number, updatedAt: number}|null} */
  getAnchor(sessionId) {
    return this.anchors.get(String(sessionId)) ?? null;
  }

  /**
   * 写入/覆盖某契约会话的引用锚点。
   * 重新 set 让它在 Map 尾部（保持"插入顺序 ≈ 淘汰顺序"）。
   * @param {string} sessionId  qq:group:777 / qq:private:888
   * @param {{messageId: string, turnId?: string|null, matched?: string}} anchor
   */
  setAnchor(sessionId, anchor = {}) {
    const key = String(sessionId);
    const messageId = anchor.messageId == null ? '' : String(anchor.messageId);
    if (!key || !messageId) return;
    const now = this.now();
    const previous = this.anchors.get(key);
    this.anchors.delete(key);
    this.anchors.set(key, {
      messageId,
      turnId: anchor.turnId == null ? null : String(anchor.turnId),
      matched: anchor.matched ?? 'first',
      // 同一轮内升级（first → dispatch）不该把"首次记录时间"往后推
      createdAt: previous && previous.turnId === anchor.turnId ? previous.createdAt : now,
      updatedAt: now,
    });
    this.save();
  }

  /** 消费/清除某契约会话的引用锚点 */
  clearAnchor(sessionId) {
    if (this.anchors.delete(String(sessionId))) this.save();
  }

  /** 供面板/测试观察 */
  stats() {
    return {
      cursors: this.cursors.size,
      handled: this.handled.size,
      anchors: this.anchors.size,
      file: this.file,
    };
  }
}
