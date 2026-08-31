/**
 * storage/model-session-store.js — 模型会话映射持久化
 *
 * 解决问题：
 *   1. 桥接重启后，保留私聊/群聊当前所处的分支 Session ID（包含 /new 后的轮换 ID）。
 *   2. 跨过业务日期分界（默认每日 07:00，支持一天多次轮转）时，自动按新 tag 重置并持久化。
 *   3. 规范化 /new 重置后的命名：从无序时间戳改为按日递增序号（例如 _20260828_#02）。
 *
 * 全局唯一：整个进程只应有一个实例（由 container 建好后注入各 adapter）。
 * 多实例指向同一文件会整文件互相覆盖 —— 各自持有的内存快照落盘时会抹掉对方的条目。
 */

import fs from 'node:fs';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

export class ModelSessionStore {
  /**
   * @param {object} opts
   * @param {string} opts.cacheDir
   * @param {boolean} [opts.persistEnabled=true]
   * @param {number} [opts.retainDays=2] 只保留最新 tag 往前 N 天的条目，防止文件无限膨胀
   * @param {import('../core/logger.js').Logger} [opts.logger]
   */
  constructor(opts = {}) {
    this.cacheDir = opts.cacheDir;
    this.persistEnabled = opts.persistEnabled !== false;
    this.retainDays = Number.isInteger(opts.retainDays) && opts.retainDays >= 0 ? opts.retainDays : 2;
    this.log = opts.logger?.child({ component: 'model-session-store' }) ?? console;
    this.file = this.cacheDir ? path.join(this.cacheDir, 'model_sessions.json') : null;
    // tmp 带 pid：万一同时跑了两个进程，至少不会互相踩掉对方的半成品文件
    this.tmpFile = this.file ? `${this.file}.${process.pid}.tmp` : null;

    /** key -> { tag: string, sessionId: string, counter: number } */
    this.sessions = new Map();
    this.load();
  }

  /** 'YYYYMMDD' 或一天多轮转的 'YYYYMMDD_P' -> 当天 UTC ms；非法格式返回 NaN */
  static tagToMs(tag) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:_\d+)?$/.exec(String(tag ?? ''));
    if (!m) return NaN;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  /**
   * 裁掉过期条目。基准取「库内最新的 tag」而非墙上时钟：
   * 结果只跟数据本身有关，既能随新会话写入自然淘汰旧数据，也不会让测试随日期漂移而挂掉。
   * @returns {number} 被裁掉的条目数
   */
  prune() {
    if (this.sessions.size === 0) return 0;

    let newest = -Infinity;
    for (const v of this.sessions.values()) {
      const ms = ModelSessionStore.tagToMs(v.tag);
      if (!Number.isNaN(ms) && ms > newest) newest = ms;
    }
    if (newest === -Infinity) return 0;

    const floor = newest - this.retainDays * DAY_MS;
    let dropped = 0;
    for (const [k, v] of this.sessions) {
      const ms = ModelSessionStore.tagToMs(v.tag);
      // tag 解析不出来的是脏数据，一并清掉
      if (Number.isNaN(ms) || ms < floor) {
        this.sessions.delete(k);
        dropped += 1;
      }
    }
    return dropped;
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      // 隔离而非直接丢弃：下次 save 会覆盖掉现场，留一份好排查
      this.quarantine(err);
      return;
    }
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) {
        if (v && typeof v === 'object' && v.sessionId && v.tag) {
          this.sessions.set(k, {
            tag: String(v.tag),
            sessionId: String(v.sessionId),
            counter: Number.isInteger(v.counter) ? v.counter : 1,
          });
        }
      }
    }
    const dropped = this.prune();
    this.log.info('模型会话映射已加载', { count: this.sessions.size, dropped });
  }

  /** 把损坏的文件改名留档，参照 send-queue-store 的归档思路（.gitignore 已放行 *.corrupt_*） */
  quarantine(err) {
    const target = `${this.file}.corrupt_${Date.now()}`;
    try {
      fs.renameSync(this.file, target);
      this.log.warn('模型会话映射文件损坏，已隔离留档', { error: err.message, target });
    } catch (renameErr) {
      this.log.warn('模型会话映射加载失败，使用空白内存映射', {
        error: err.message,
        renameError: renameErr.message,
      });
    }
  }

  save() {
    if (!this.persistEnabled || !this.file || !this.tmpFile) return;
    try {
      this.prune();
      fs.mkdirSync(this.cacheDir, { recursive: true });
      const obj = {};
      for (const [k, v] of this.sessions.entries()) {
        obj[k] = v;
      }
      fs.writeFileSync(this.tmpFile, JSON.stringify(obj, null, 2), 'utf8');
      fs.renameSync(this.tmpFile, this.file);
    } catch (err) {
      this.log.warn('模型会话映射保存失败', { error: err.message });
      try { if (fs.existsSync(this.tmpFile)) fs.unlinkSync(this.tmpFile); } catch { /* ignore */ }
    }
  }

  get(key) {
    return this.sessions.get(key) ?? null;
  }

  set(key, entry) {
    this.sessions.set(key, entry);
    this.save();
  }
}
