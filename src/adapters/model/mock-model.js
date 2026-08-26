/**
 * adapters/model/mock-model.js — 离线模型
 *
 * 用途：
 *   - 阶段 2 的 NapCat 最小闭环（还没接真模型时跑通全链路）
 *   - 集成测试与 Golden 测试
 *   - 影子模式下想验证编排但不想真的花 token 时
 *
 * 支持脚本化回复：按顺序返回预置文本，或用函数按请求动态生成。
 */

import { createModelResponse } from '../../contracts/messages.js';
import { randomUUID } from 'node:crypto';

export class MockModelAdapter {
  /**
   * @param {object} opts
   * @param {string[]|((req: object) => string)} [opts.replies]
   * @param {number} [opts.chunkSize=8]  流式回调每段字符数
   * @param {number} [opts.latencyMs=0]
   */
  constructor(opts = {}) {
    this.replies = opts.replies ?? ['(mock reply)'];
    this.chunkSize = opts.chunkSize ?? 8;
    this.latencyMs = opts.latencyMs ?? 0;
    this.calls = [];
    this._index = 0;
    this.sessions = new Map();
  }

  getSessionId(sessionKey) {
    if (!this.sessions.has(sessionKey)) this.sessions.set(sessionKey, `mock_${sessionKey}`);
    return this.sessions.get(sessionKey);
  }

  async resetSession(sessionKey) {
    const id = `mock_${sessionKey}_${Date.now()}`;
    this.sessions.set(sessionKey, id);
    return id;
  }

  async generate(modelRequest, opts = {}) {
    this.calls.push(modelRequest);
    const startedAt = Date.now();

    const text =
      typeof this.replies === 'function'
        ? this.replies(modelRequest)
        : this.replies[Math.min(this._index++, this.replies.length - 1)];

    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));

    if (opts.onText) {
      for (let i = 0; i < text.length; i += this.chunkSize) {
        if (opts.signal?.aborted) {
          const err = new Error(opts.signal.reason?.message ?? 'aborted');
          err.name = 'AbortError';
          throw err;
        }
        opts.onText(text.slice(i, i + this.chunkSize));
      }
    }

    return createModelResponse({
      correlationId: modelRequest.correlationId,
      responseId: randomUUID(),
      model: modelRequest.model ?? 'mock',
      rawText: text,
      usage: { inputTokens: 0, outputTokens: text.length },
      latencyMs: Date.now() - startedAt,
    });
  }

  async ping() {
    return { ok: true, detail: 'mock 模型始终就绪' };
  }
}
