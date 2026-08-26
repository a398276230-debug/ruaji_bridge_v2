/**
 * orchestration/mem0-ingestor.js —— 对话 ➔ Mem0 长期工作记忆异步沉淀
 *
 * 监听 EVENTS.LLM_RESPONSE：把一轮完整对话（用户发言 + 模型回复）投给 Mem0
 * 的抽取模型，由它做结构化事实提取后入库。发投递请求是 fire-and-forget，
 * 不进 publish 的等待链，所以不会拖慢回复。
 *
 * ## 判定字段一律从 envelope.payload 取
 *
 * `createEvent()`（contracts/events.js:45）只保留 correlationId / sessionId /
 * payload / timestamp，**其余顶层字段一律丢弃**。从 `event.isPrivate` 取会永远
 * 拿到 undefined，而 undefined 会让过滤链恒判"这是群聊"，把整个组件静默变成
 * 死代码 —— 没有报错、没有日志，只是一条记忆都不沉淀。踩过一次，记在这里。
 *
 * ## 过滤失败时保守跳过（fail-closed）
 *
 * 这个组件唯一的职责就是"只沉淀该沉淀的"。filter 配置读不动、解析不了，
 * 说明我们不知道该放行什么 —— 那就一条都不放行。放行才是把群聊原文送出去的
 * 那个方向，它不能当兜底。
 */

import fs from 'node:fs';
import { EVENTS } from '../contracts/events.js';
import { MESSAGE_TYPES } from '../contracts/messages.js';

/**
 * 本仓库 sessionId 的群聊形态。`buildSessionId()` 产出 `qq:group:<gid>`
 * （contracts/messages.js:23），冒号分隔——外部 filter 里那条
 * `^(qq_)?group_` 是 AstrBot 的下划线格式，对这里的 sessionId 永远不匹配，
 * 所以内置这条，再与配置里那条取并集。
 */
const GROUP_SESSION_RE = /^[a-z0-9_]+:group:/i;

/** filter 读不到时的保守默认：只放行主人私聊 */
const DEFAULT_FILTER = Object.freeze({
  ignore_all_groups: true,
  group_session_regex: '',
  only_ruaji_private: true,
});

/** 短于这个长度的回复没有可提取的事实，不值得占一次抽取模型的调用 */
const MIN_COMPLETION_CHARS = 5;

export class Mem0Ingestor {
  /**
   * @param {object} opts
   * @param {import('../core/event-bus.js').EventBus} opts.eventBus
   * @param {object} opts.config
   * @param {import('../core/logger.js').Logger} [opts.logger]
   * @param {typeof fetch} [opts.fetchImpl] 测试注入点，与容器里其他 HTTP 组件一致
   */
  constructor(opts = {}) {
    this.eventBus = opts.eventBus;
    this.config = opts.config;
    this.log = opts.logger?.child({ component: 'mem0-ingestor' }) ?? console;
    this.fetchImpl = opts.fetchImpl ?? ((...args) => globalThis.fetch(...args));

    const mem0 = this.config?.mem0 ?? {};
    this.baseUrl = String(mem0.baseUrl ?? '').replace(/\/+$/, '');
    /** 没配 baseUrl 等于没开这个功能，不要拿 `undefined/memories` 去打网络 */
    this.enabled = mem0.enabled !== false && this.baseUrl !== '';
    this.memoryUserId = mem0.userId || 'ruaji';
    this.filterFile = mem0.filterFile || '';
    this.timeoutMs = Number(mem0.timeoutMs) || 15000;
    this.ownerId = String(this.config?.identity?.ownerId ?? '');

    /** filter 文件按 mtime 缓存。热路径上不做同步 fs 读 + JSON.parse */
    this._filterCache = { mtimeMs: -1, size: -1, value: null };
    this._unsubscribe = null;
    this._abort = new AbortController();
    /** 在飞的投递，stop() 要等它们收尾（或被 abort 掉） */
    this._inflight = new Set();
  }

  start() {
    if (!this.eventBus) return false;
    if (this._unsubscribe) return true;
    if (!this.enabled) {
      this.log.info?.('Mem0 异步沉淀未启用（mem0.enabled=false 或 mem0.baseUrl 为空）');
      return false;
    }

    this._unsubscribe = this.eventBus.subscribe(EVENTS.LLM_RESPONSE, 'mem0_ingestor', (envelope) => {
      // 故意不 await：投递要在 publish 的等待链之外，否则 15s 超时会拖住事件总线
      const task = this._handleResponse(envelope)
        .catch((err) => {
          if (err?.name === 'AbortError') return;
          this.log.warn?.('Mem0 投递失败', {
            correlationId: envelope?.correlationId,
            error: err?.message,
          });
        })
        .finally(() => this._inflight.delete(task));
      this._inflight.add(task);
    });

    this.log.info?.('Mem0 异步沉淀组件已就绪', { baseUrl: this.baseUrl, userId: this.memoryUserId });
    return true;
  }

  async stop() {
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._abort.abort();
    await Promise.allSettled([...this._inflight]);
    this._inflight.clear();
  }

  /**
   * 读 Mem0 服务端配置里的 filter 段。按 mtime+size 缓存。
   * @returns {object|null} null 表示"读不到或解析不了"，调用方据此 fail-closed
   */
  _loadFilter() {
    if (!this.filterFile) return DEFAULT_FILTER;
    let stat;
    try {
      stat = fs.statSync(this.filterFile);
    } catch {
      // 文件不存在是正常状态（服务端还没落配置），用保守默认，不算失败
      return DEFAULT_FILTER;
    }
    if (stat.mtimeMs === this._filterCache.mtimeMs && stat.size === this._filterCache.size) {
      return this._filterCache.value;
    }
    let value = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filterFile, 'utf8'));
      value = { ...DEFAULT_FILTER, ...(parsed?.filter ?? {}) };
    } catch (err) {
      // 解析不了 ≠ 放行。缓存 null，让 _shouldSkip 一路跳过，且不必每条消息重试解析
      this.log.error?.('Mem0 filter 配置解析失败，本轮起停止沉淀直到文件修好', {
        file: this.filterFile,
        error: err?.message,
      });
    }
    this._filterCache = { mtimeMs: stat.mtimeMs, size: stat.size, value };
    return value;
  }

  /**
   * @param {object} envelope 事件信封
   * @returns {boolean} true = 跳过不沉淀
   */
  _shouldSkip(envelope) {
    const flt = this._loadFilter();
    if (!flt) return true; // fail-closed：见文件头

    const p = envelope?.payload ?? {};
    const sessionId = String(envelope?.sessionId ?? '');
    const userId = String(p.userId ?? '');
    // messageType 是权威信号；sessionId 只做旁证（见 GROUP_SESSION_RE 注释）
    const isPrivate = p.messageType
      ? p.messageType === MESSAGE_TYPES.PRIVATE
      : !GROUP_SESSION_RE.test(sessionId);

    if (flt.ignore_all_groups) {
      if (!isPrivate) return true;
      if (GROUP_SESSION_RE.test(sessionId)) return true;
      if (flt.group_session_regex) {
        try {
          if (new RegExp(flt.group_session_regex, 'i').test(sessionId)) return true;
        } catch {
          return true; // 正则本身写坏了，同样是"不知道该放行什么"
        }
      }
    }

    if (flt.only_ruaji_private && isPrivate && userId !== this.ownerId) return true;

    return false;
  }

  async _handleResponse(envelope) {
    if (!this.enabled) return;
    if (this._shouldSkip(envelope)) return;

    const p = envelope.payload ?? {};
    const assistantText = String(p.completionText ?? p.text ?? '');
    if (assistantText.length < MIN_COMPLETION_CHARS) return;

    const userText = String(p.userText ?? '');
    const speaker = p.userName ? `[${p.userName}]` : 'user';
    const conversation = `${speaker}: ${userText}\nassistant: ${assistantText}`;

    // 超时与 stop() 两个来源合成一个 signal。AbortSignal.any 要 Node 20.3+，
    // package.json 的 engines 写的是 >=18.13.0，所以按仓库既有写法手工合成
    // （见 plugins/http-plugin-client.js:47）。
    const controller = new AbortController();
    const onStop = () => controller.abort();
    if (this._abort.signal.aborted) controller.abort();
    else this._abort.signal.addEventListener('abort', onStop, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await this.fetchImpl(`${this.baseUrl}/memories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: conversation, user_id: this.memoryUserId, infer: true }),
        signal: controller.signal,
      });

      if (!res.ok) {
        this.log.warn?.('Mem0 拒绝了这次投递', {
          correlationId: envelope.correlationId,
          status: res.status,
        });
        return;
      }

      const data = await res.json().catch(() => null);
      const results = Array.isArray(data?.results) ? data.results : [];
      if (results.length === 0) return;
      // 提炼出的事实是私聊内容，只在 debug 级留正文
      this.log.info('Mem0 沉淀了新记忆', {
        correlationId: envelope.correlationId,
        count: results.length,
      });
      this.log.debug?.('Mem0 沉淀明细', { memories: results.map((r) => r?.memory) });
    } finally {
      clearTimeout(timer);
      this._abort.signal.removeEventListener('abort', onStop);
    }
  }
}
