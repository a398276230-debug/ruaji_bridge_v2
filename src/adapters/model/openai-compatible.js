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
import { randomUUID } from 'node:crypto';

export class OpenAiCompatibleAdapter {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl        形如 http://127.0.0.1:8642/v1
   * @param {string} opts.model
   * @param {string} [opts.apiKey]
   * @param {string} [opts.sessionHeader] 会话隔离头名，Hermes 用 X-Hermes-Session-Id
   * @param {string} [opts.sessionPrefix]
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.maxRetries=0]
   * @param {import('../../core/logger.js').Logger} [opts.logger]
   * @param {typeof fetch} [opts.fetchImpl]
   */
  constructor(opts = {}) {
    this.baseUrl = String(opts.baseUrl ?? '').replace(/\/$/, '');
    this.model = opts.model;
    this.apiKey = opts.apiKey ?? '';
    this.sessionHeader = opts.sessionHeader ?? null;
    this.sessionPrefix = opts.sessionPrefix ?? '';
    this.timeoutMs = opts.timeoutMs ?? 1800000;
    this.maxRetries = opts.maxRetries ?? 0;
    this.log = opts.logger?.child({ component: 'model-adapter' }) ?? console;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    /** sessionKey -> 当前会话 id。/new 命令通过 resetSession 轮换。 */
    this.sessions = new Map();
  }

  get chatUrl() {
    return `${this.baseUrl}/chat/completions`;
  }

  /** 会话名只允许安全字符，防止注入（迁移自 hermes_adapter.js:54-56） */
  static sanitizeSessionKey(key) {
    return String(key ?? '').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 60);
  }

  getSessionId(sessionKey) {
    const key = OpenAiCompatibleAdapter.sanitizeSessionKey(sessionKey);
    if (!this.sessions.has(key)) this.sessions.set(key, `${this.sessionPrefix}${key}`);
    return this.sessions.get(key);
  }

  /**
   * 重置会话：删除服务端旧会话并轮换 id。
   * Hermes 的"新会话"语义 = 调用方轮换会话头，模型侧不解析 /new 文本。
   */
  async resetSession(sessionKey) {
    const key = OpenAiCompatibleAdapter.sanitizeSessionKey(sessionKey);
    const oldId = this.sessions.get(key);
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
    const newId = `${this.sessionPrefix}${key}_${Date.now()}`;
    this.sessions.set(key, newId);
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
