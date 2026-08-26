/**
 * storage/send-queue-store.js — 发送队列持久化
 *
 * 迁移自 bridge.js:538-578（archiveStaleMessages / loadQueue / saveQueue）。
 *
 * 保留的关键行为：
 *   - 过旧消息归档而不是删除，便于事后排查
 *   - 没有 createdAt 的旧格式一律视为过旧（保守，不补发）
 *   - 恢复后立刻删除备份文件，避免二次补发
 *
 * 差异：落在 v2 自己的 cacheDir，绝不碰旧 Bridge 的 send_queue.json。
 */

import fs from 'node:fs';
import path from 'node:path';

export class SendQueueStore {
  /**
   * @param {object} opts
   * @param {string} opts.cacheDir
   * @param {number} [opts.maxAgeMs=600000]
   * @param {import('../core/logger.js').Logger} [opts.logger]
   */
  constructor(opts = {}) {
    this.cacheDir = opts.cacheDir;
    this.maxAgeMs = opts.maxAgeMs ?? 600000;
    this.log = opts.logger?.child({ component: 'send-queue-store' }) ?? console;
    this.queueFile = path.join(this.cacheDir, 'send_queue.json');
    this.archiveDir = path.join(this.cacheDir, 'send_queue_archive');
  }

  _ensureDirs() {
    try { fs.mkdirSync(this.cacheDir, { recursive: true }); } catch { /* ignore */ }
    try { fs.mkdirSync(this.archiveDir, { recursive: true }); } catch { /* ignore */ }
  }

  /**
   * 恢复未发送的消息，顺带过滤过期项。
   * @returns {{ fresh: object[], stale: object[] }}
   */
  load(now = Date.now()) {
    if (!fs.existsSync(this.queueFile)) return { fresh: [], stale: [] };

    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(this.queueFile, 'utf8'));
    } catch (err) {
      this.log.warn('发送队列恢复失败，文件损坏', { error: err.message });
      return { fresh: [], stale: [] };
    }
    if (!Array.isArray(saved)) return { fresh: [], stale: [] };

    const fresh = [];
    const stale = [];
    for (const task of saved) {
      const createdAt = task?.metadata?.createdAt ?? task?.createdAt;
      // 无 createdAt 的旧格式：年龄未知，保守按过旧处理
      const age = createdAt ? now - createdAt : this.maxAgeMs + 1;
      (age <= this.maxAgeMs ? fresh : stale).push(task);
    }

    if (stale.length) this.archive(stale, 'load 过期过滤');

    try {
      fs.unlinkSync(this.queueFile);
    } catch { /* ignore */ }

    this.log.info('发送队列已恢复', { fresh: fresh.length, stale: stale.length });
    return { fresh, stale };
  }

  save(tasks) {
    if (!Array.isArray(tasks) || tasks.length === 0) {
      // 队列空了就把备份删掉，避免下次启动补发已发完的内容
      try { if (fs.existsSync(this.queueFile)) fs.unlinkSync(this.queueFile); } catch { /* ignore */ }
      return;
    }
    this._ensureDirs();
    try {
      const tmp = `${this.queueFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(tasks), 'utf8');
      fs.renameSync(tmp, this.queueFile);
    } catch (err) {
      this.log.warn('发送队列保存失败', { error: err.message });
    }
  }

  /** 归档而非删除 —— 旧 Bridge 靠这些 .bak.json 排查过复读事故 */
  archive(tasks, reason) {
    if (!tasks?.length) return null;
    this._ensureDirs();
    const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
    const file = path.join(this.archiveDir, `stale_${stamp}_${Math.floor(Math.random() * 1000)}.json`);
    try {
      fs.writeFileSync(file, JSON.stringify({ reason, archivedAt: new Date().toISOString(), tasks }, null, 2), 'utf8');
      this.log.warn('已归档过旧/失败消息', { count: tasks.length, reason, file });
      return file;
    } catch (err) {
      this.log.warn('归档失败', { error: err.message });
      return null;
    }
  }
}
