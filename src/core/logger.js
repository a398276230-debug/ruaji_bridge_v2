/**
 * core/logger.js — 结构化日志 + 强制脱敏
 *
 * 相对旧 Bridge 的三点修正：
 *   1. 旧 log() 在轮转时递归调用自己（bridge.js 早期版本），这里轮转完全不走 log()
 *   2. 旧实现把消息正文直接写进 INFO 行；v2 默认不落正文（安全要求：
 *      "消息正文不写入普通信息日志"），需要时用 logMessageBodies=true 显式开启
 *   3. 密钥脱敏是无条件的：任何键名命中敏感词一律 ***，不依赖调用方自觉
 */

import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, critical: 50 };

const SENSITIVE_KEY = /(api[-_]?key|access[-_]?token|authorization|secret|password|passwd|cookie|bearer)/i;
const SENSITIVE_VALUE_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /sk-[A-Za-z0-9._-]{8,}/g,
];

/** 递归脱敏。命中敏感键名整体替换；其余字符串再过一遍值级正则。 */
export function redact(value, depth = 0) {
  if (depth > 6) return '[deep]';
  if (value == null) return value;
  if (typeof value === 'string') {
    let out = value;
    for (const re of SENSITIVE_VALUE_PATTERNS) out = out.replace(re, '***');
    return out;
  }
  if (typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message, depth + 1) };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? '***' : redact(v, depth + 1);
  }
  return out;
}

export class Logger {
  /**
   * @param {object} opts
   * @param {string} opts.file            日志文件绝对路径；为空则只输出到 console
   * @param {string} [opts.level]         debug | info | warn | error | critical
   * @param {number} [opts.maxSizeBytes]
   * @param {number} [opts.keepRotated]
   * @param {boolean} [opts.logMessageBodies] 是否允许把消息正文写盘
   * @param {object} [opts.bindings]      每行都带上的固定字段，如 { component: 'sender' }
   */
  constructor(opts = {}) {
    this.file = opts.file || null;
    this.level = LEVELS[opts.level] ?? LEVELS.info;
    this.maxSizeBytes = opts.maxSizeBytes ?? 10 * 1024 * 1024;
    this.keepRotated = opts.keepRotated ?? 5;
    this.logMessageBodies = opts.logMessageBodies === true;
    this.bindings = opts.bindings || {};
    this._rotating = false;
    this._sink = opts.sink || null; // 测试用：拦截输出
  }

  /** 派生子 logger，附带组件名等固定字段 */
  child(bindings) {
    const next = new Logger({
      file: this.file,
      level: Object.keys(LEVELS).find((k) => LEVELS[k] === this.level),
      maxSizeBytes: this.maxSizeBytes,
      keepRotated: this.keepRotated,
      logMessageBodies: this.logMessageBodies,
      bindings: { ...this.bindings, ...bindings },
      sink: this._sink,
    });
    next._rotating = false;
    return next;
  }

  /**
   * 消息正文包装：默认只落长度，不落内容。
   * 用法：log.info('收到消息', { body: log.body(text) })
   */
  body(text) {
    const str = String(text ?? '');
    if (this.logMessageBodies) return str;
    return `[len=${str.length}]`;
  }

  debug(msg, fields) { this._write('debug', msg, fields); }
  info(msg, fields) { this._write('info', msg, fields); }
  warn(msg, fields) { this._write('warn', msg, fields); }
  error(msg, fields) { this._write('error', msg, fields); }
  critical(msg, fields) { this._write('critical', msg, fields); }

  _write(level, msg, fields) {
    if (LEVELS[level] < this.level) return;

    const line = {
      ts: new Date().toISOString(),
      level,
      msg: String(msg),
      ...this.bindings,
      ...(fields ? redact(fields) : {}),
    };
    const serialized = JSON.stringify(line);

    if (this._sink) {
      this._sink(line);
      return;
    }

    const consoleFn = level === 'error' || level === 'critical' ? console.error : console.log;
    consoleFn(serialized);

    if (!this.file) return;
    try {
      this._rotateIfNeeded();
      fs.appendFileSync(this.file, serialized + '\n');
    } catch {
      /* 日志失败绝不能影响主流程 */
    }
  }

  _rotateIfNeeded() {
    if (this._rotating || !this.file) return;
    let stat;
    try {
      stat = fs.statSync(this.file);
    } catch {
      return; // 文件还不存在
    }
    if (stat.size <= this.maxSizeBytes) return;

    this._rotating = true;
    try {
      // 从最旧开始向后顺移，避免覆盖（沿用旧 performRotate 的思路）
      for (let i = this.keepRotated - 1; i >= 1; i--) {
        const src = `${this.file}.${i}`;
        const dst = `${this.file}.${i + 1}`;
        if (fs.existsSync(src)) {
          try { fs.renameSync(src, dst); } catch { /* 被占用则跳过 */ }
        }
      }
      fs.renameSync(this.file, `${this.file}.1`);
      // 关键：不递归调用 _write，直接写新文件首行
      fs.appendFileSync(
        this.file,
        JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: '日志已轮转' }) + '\n',
      );
    } catch (e) {
      console.error(`[日志轮转失败] ${e.message}`);
    } finally {
      this._rotating = false;
    }
  }
}

export function createLogger(config, rootDir) {
  const cfg = config?.logging || {};
  const file = cfg.file ? path.resolve(rootDir, cfg.file) : null;
  if (file) {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* ignore */ }
  }
  return new Logger({
    file,
    level: cfg.level,
    maxSizeBytes: cfg.maxSizeBytes,
    keepRotated: cfg.keepRotated,
    logMessageBodies: cfg.logMessageBodies,
  });
}
