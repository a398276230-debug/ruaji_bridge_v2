/**
 * adapters/model/openai-compatible.js — 唯一的模型出口
 *
 * 验收标准 9：模型调用只通过 Model Adapter。编排层不允许出现
 * fetch('/v1/chat/completions')。
 *
 * 迁移自 hermes_adapter.js（SSE 解析、X-Hermes-Session-Id 会话隔离）与
 * bridge.js:932-967（OpenClaw 分支的 SSE 解析）。两条几乎一样的解析代码合成一份。
 *
 * Hermes 特有的会话头在这里被封装成 adapter option，编排层只知道 sessionKey。
 */

import { createModelResponse } from '../../contracts/messages.js';
import { validateModelRequest } from '../../contracts/schemas/index.js';
import { ModelError } from '../../contracts/errors.js';
import { ModelSessionStore } from '../../storage/model-session-store.js';
import { randomUUID } from 'node:crypto';

export class OpenAiCompatibleAdapter {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl        形如 http://127.0.0.1:8642/v1
   * @param {string} opts.model
   * @param {string} [opts.apiKey]
   * @param {string} [opts.sessionHeader] 会话隔离头名，Hermes 用 X-Hermes-Session-Id
   * @param {string} [opts.sessionPrefix]
   * @param {number} [opts.sessionCutoffHour]  每日轮转分界整点（北京时间，默认 7）
   * @param {number} [opts.sessionRotationsPerDay]  每日轮转次数，须整除 24（默认 1）
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.maxRetries=0]
   * @param {import('../../core/logger.js').Logger} [opts.logger]
   * @param {typeof fetch} [opts.fetchImpl]
   * @param {object} [opts.sessionStore] 共享的 ModelSessionStore（进程内唯一），优先于 cacheDir
   * @param {string} [opts.cacheDir] 兜底：自建 store，仅限单 adapter 场景
   */
  constructor(opts = {}) {
    this.baseUrl = String(opts.baseUrl ?? '').replace(/\/$/, '');
    this.model = opts.model;
    this.apiKey = opts.apiKey ?? '';
    this.sessionHeader = opts.sessionHeader ?? null;
    this.sessionPrefix = opts.sessionPrefix ?? '';
    // 0 点是合法分界，不能用 `|| 7` 兜底（会把 0 和 "0" 一起吃掉）
    const cutoff = Number(opts.sessionCutoffHour);
    this.sessionCutoffHour = Number.isInteger(cutoff) && cutoff >= 0 && cutoff <= 23 ? cutoff : 7;
    // 每日轮转次数 N：必须整除 24 才能得到均匀的轮转点（合法值 1/2/3/4/6/8/12）
    const rotations = Number(opts.sessionRotationsPerDay);
    this.sessionRotationsPerDay = Number.isInteger(rotations) && rotations >= 1 && rotations <= 12 && 24 % rotations === 0
      ? rotations
      : 1;
    this.timeoutMs = opts.timeoutMs ?? 1800000;
    this.maxRetries = opts.maxRetries ?? 0;
    this.log = opts.logger?.child({ component: 'model-adapter' }) ?? console;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    // 会话映射存储：正常由 container 建好全局唯一实例后注入（多个 adapter 必须共用同一个，
    // 否则各自的内存快照落盘时会整文件覆盖，抹掉对方的 /new 分支）。
    // cacheDir 只是独立跑单个 adapter 时的兜底；无二者则退化为内存 Map（mock/沙箱零侵入）。
    this.sessionStore = opts.sessionStore
      ?? (opts.cacheDir ? new ModelSessionStore({ cacheDir: opts.cacheDir, logger: opts.logger }) : new Map());
  }

  get chatUrl() {
    return `${this.baseUrl}/chat/completions`;
  }

  /** 会话名只允许安全字符，防止注入（迁移自 hermes_adapter.js:54-56） */
  static sanitizeSessionKey(key) {
    return String(key ?? '').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 60);
  }

  /**
   * 计算以北京时间 (UTC+8) 每日 cutoffHour 点为首个分界的业务日期标记。
   * N=1（默认）输出 YYYYMMDD；N>1 追加周期后缀 _P（P 从 1 起，每 24/N 小时一个周期），
   * 分界瞬间归属新周期。默认 7 点、每日 1 轮，可由 model.sessionCutoffHour /
   * model.sessionRotationsPerDay 配置。严格基于 UTC 偏移计算，不受运行环境时区干扰。
   */
  static getBusinessDateTag(now = new Date(), cutoffHour = 7, rotationsPerDay = 1) {
    const d = now instanceof Date ? now : new Date(now);
    const bjAdjusted = new Date(d.getTime() + (8 - cutoffHour) * 3600000);
    const y = bjAdjusted.getUTCFullYear();
    const m = String(bjAdjusted.getUTCMonth() + 1).padStart(2, '0');
    const day = String(bjAdjusted.getUTCDate()).padStart(2, '0');
    const base = `${y}${m}${day}`;
    if (rotationsPerDay > 1) {
      // 位移后 getUTCHours() 恰为「距 cutoff 的小时数」(0-23)，直接按周期长度切段
      const period = Math.floor(bjAdjusted.getUTCHours() / (24 / rotationsPerDay)) + 1;
      return `${base}_${period}`;
    }
    return base;
  }

  getSessionId(sessionKey, now = new Date()) {
    const key = OpenAiCompatibleAdapter.sanitizeSessionKey(sessionKey);
    const currentTag = OpenAiCompatibleAdapter.getBusinessDateTag(now, this.sessionCutoffHour, this.sessionRotationsPerDay);
    const entry = this.sessionStore.get(key);
    if (!entry || entry.tag !== currentTag) {
      const newId = `${this.sessionPrefix}${key}_${currentTag}`;
      this.sessionStore.set(key, { tag: currentTag, sessionId: newId, counter: 1 });
      return newId;
    }
    return entry.sessionId;
  }

  /**
   * 重置会话：删除服务端旧会话并轮换 id。
   * Hermes 的"新会话"语义 = 调用方轮换会话头，模型侧不解析 /new 文本。
   */
  async resetSession(sessionKey, now = new Date()) {
    const key = OpenAiCompatibleAdapter.sanitizeSessionKey(sessionKey);
    const currentTag = OpenAiCompatibleAdapter.getBusinessDateTag(now, this.sessionCutoffHour, this.sessionRotationsPerDay);
    const oldEntry = this.sessionStore.get(key);
    const oldId = oldEntry?.sessionId;
    if (oldId) {
      try {
        await this.fetchImpl(`${this.baseUrl.replace(/\/v1$/, '')}/api/sessions/${encodeURIComponent(oldId)}`, {
          method: 'DELETE',
          headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
          signal: AbortSignal.timeout(8000),
        });
      } catch (err) {
        this.log.debug('删除服务端会话失败（忽略）', { error: err.message });
      }
    }
    const prevCounter = (oldEntry?.tag === currentTag && Number.isInteger(oldEntry.counter)) ? oldEntry.counter : 1;
    const nextCounter = prevCounter + 1;
    const counterStr = String(nextCounter).padStart(2, '0');
    const newId = `${this.sessionPrefix}${key}_${currentTag}_#${counterStr}`;
    this.sessionStore.set(key, { tag: currentTag, sessionId: newId, counter: nextCounter });
    return newId;
  }

  /**
   * 生成回复。
   * @param {object} modelRequest  createModelRequest() 的产物
   * @param {object} [opts]
   * @param {(chunk: string) => void} [opts.onText] 流式回调，每收到一段文本触发
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<object>} ModelResponse
   */
  async generate(modelRequest, opts = {}) {
    const check = validateModelRequest(modelRequest);
    if (!check.valid) {
      throw new ModelError(`ModelRequest 非法: ${check.errors.join('; ')}`, {
        kind: 'protocol',
        correlationId: modelRequest?.correlationId,
        retryable: false,
      });
    }

    let lastError = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this._generateOnce(modelRequest, opts);
      } catch (err) {
        lastError = err;
        // 取消、鉴权、协议错误都不重试
        if (err?.name === 'AbortError') throw err;
        if (err instanceof ModelError && !err.retryable) throw err;
        if (attempt < this.maxRetries) {
          this.log.warn('模型调用失败，重试', {
            attempt: attempt + 1,
            correlationId: modelRequest.correlationId,
            error: err.message,
          });
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
    }
    throw lastError;
  }

  async _generateOnce(modelRequest, opts) {
    const startedAt = Date.now();
    const stream = modelRequest.stream !== false;

    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (this.sessionHeader && modelRequest.sessionKey) {
      headers[this.sessionHeader] = this.getSessionId(modelRequest.sessionKey);
    }

    const body = {
      model: modelRequest.model ?? this.model,
      messages: modelRequest.messages,
      stream,
      ...modelRequest.generation,
    };
    if (modelRequest.tools?.length) body.tools = modelRequest.tools;

    const controller = new AbortController();
    const timeoutError = new ModelError('模型请求超时', {
      kind: 'timeout',
      correlationId: modelRequest.correlationId,
    });
    const timer = setTimeout(() => controller.abort(timeoutError), this.timeoutMs);

    const external = opts.signal;
    const onAbort = () => controller.abort(external.reason ?? new Error('interrupted'));
    if (external) {
      if (external.aborted) controller.abort(external.reason);
      else external.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const res = await this.fetchImpl(this.chatUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new ModelError(`模型 API ${res.status}: ${errText.slice(0, 300)}`, {
          kind: res.status === 401 || res.status === 403 ? 'auth' : 'transport',
          status: res.status,
          correlationId: modelRequest.correlationId,
          retryable: res.status >= 500,
        });
      }

      const parsed = stream
        ? await this._readStream(res, opts.onText)
        : await this._readJson(res);

      return createModelResponse({
        correlationId: modelRequest.correlationId,
        responseId: parsed.responseId ?? randomUUID(),
        model: body.model,
        rawText: parsed.text,
        toolCalls: parsed.toolCalls,
        usage: parsed.usage,
        latencyMs: Date.now() - startedAt,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        if (reason instanceof ModelError) throw reason;
        const aborted = new Error(reason?.message ?? '模型请求被取消');
        aborted.name = 'AbortError';
        throw aborted;
      }
      if (err instanceof ModelError) throw err;
      throw new ModelError(err?.message ?? String(err), {
        kind: 'transport',
        correlationId: modelRequest.correlationId,
        cause: err,
      });
    } finally {
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', onAbort);
    }
  }

  /** 解析 SSE 流。合并自 hermes_adapter.js:150-199 与 bridge.js:945-966。 */
  async _readStream(res, onText) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let responseId = null;
    const usage = { inputTokens: 0, outputTokens: 0 };
    const toolCalls = [];

    const handleLine = (line) => {
      const cleaned = line.trim();
      if (!cleaned) return;
      // 跳过 event 行（Hermes 会推 hermes.tool.progress 等）
      if (cleaned.startsWith('event:')) return;
      if (!cleaned.startsWith('data:')) return;

      const jsonStr = cleaned.slice(5).trim();
      if (!jsonStr || jsonStr === '[DONE]') return;

      let json;
      try {
        json = JSON.parse(jsonStr);
      } catch {
        return; // 半截 JSON，忽略
      }

      if (json.id && !responseId) responseId = json.id;
      if (json.usage) {
        usage.inputTokens = json.usage.prompt_tokens ?? usage.inputTokens;
        usage.outputTokens = json.usage.completion_tokens ?? usage.outputTokens;
      }

      const delta = json.choices?.[0]?.delta;
      if (delta?.content) {
        text += delta.content;
        if (onText) onText(delta.content);
      }
      if (Array.isArray(delta?.tool_calls)) toolCalls.push(...delta.tool_calls);
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    }
    if (buffer.trim()) handleLine(buffer);

    return { text, responseId, usage, toolCalls };
  }

  async _readJson(res) {
    const json = await res.json();
    const choice = json.choices?.[0];
    return {
      text: choice?.message?.content ?? '',
      responseId: json.id ?? null,
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
      },
      toolCalls: choice?.message?.tool_calls ?? [],
    };
  }

  /** 轻量探针：/models，避免真的消耗一次推理（迁移自 preflight.js:104） */
  async ping(timeoutMs = 8000) {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/models`, {
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, detail: `鉴权失败 (HTTP ${res.status})：模型 apiKey 与服务端不一致` };
      }
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
      const data = await res.json().catch(() => ({}));
      const names = (data.data ?? []).map((m) => m.id);
      return { ok: true, detail: names.length ? `模型: ${names.slice(0, 3).join(', ')}` : '就绪' };
    } catch (err) {
      const why = err.name === 'TimeoutError' || err.name === 'AbortError' ? '请求超时' : err.message;
      return { ok: false, detail: `无法连接 ${this.baseUrl}: ${why}` };
    }
  }
}
