/**
 * orchestration/meme-matcher.js — 后置表情包匹配
 *
 * 主模型回复生成并投递完毕后，桥接自行调用一个可配置的小模型 API，
 * 判断本轮回复是否值得配一张表情包；命中则以独立 QQ 消息附在回复尾部。
 * agent 侧不再持有表情包能力（search_memes 工具与 meme-rules 注入已移除），
 * 主模型每轮省下一次 tool-call 往返。
 *
 * 关键约束：
 *   - 模型调用只走 ModelRouter（sessionKey 前缀 memematch_ 分流到独立 adapter，
 *     见 container 的注册），本模块不直接发 HTTP
 *   - 候选检索进程内直调 MemeStore.search()，零 HTTP
 *   - 全程异常只 log.warn，绝不影响已经发出的文本
 *   - 仅对无效输出重试（烂 JSON / 捏造 ID / 解析失败）；decision=none 是合法终态
 *   - 命中后通过 enqueue 回调入队，不绕过 reply-flow 直接持有 sender
 */

import { createModelRequest, createOutboundMessage, MESSAGE_TYPES } from '../contracts/messages.js';
import { buildImageCq } from '../adapters/napcat/cq.js';

/** 固定会话键：有界，不随会话数增长，不污染 ModelSessionStore */
const MATCHER_SESSION_KEY = 'memematch_util';

/** 匹配器输入截断长度（触发消息 ~200 字，机器人回复 ~500 字） */
const USER_TEXT_MAX_CHARS = 200;
const REPLY_MAX_CHARS = 500;

const SYSTEM_PROMPT = `你是 QQ 表情包配图助手。根据触发消息与机器人回复，判断是否应当附一张表情包，并从候选列表中挑选最合适的一张。

判断原则：
- 轻松、吐槽、玩梗氛围优先配图；严肃、悲伤、长篇技术讨论不配
- 不要每条回复都配，只在真正锦上添花时发送
- meme_id 必须来自候选列表，禁止捏造候选之外的 ID

输出协议（只输出严格 JSON，不要 markdown 代码块，不要任何解释文字）：
发送：{"decision":"send","meme_id":"候选ID"}
不发送：{"decision":"none"}`;

export class MemeMatcher {
  /**
   * @param {object} opts
   * @param {import('../adapters/model/model-router.js').ModelRouter} opts.models
   * @param {import('../storage/meme-store.js').MemeStore} opts.memeStore
   * @param {object} opts.config
   * @param {import('../core/logger.js').Logger} [opts.logger]
   */
  constructor(opts = {}) {
    this.models = opts.models;
    this.memeStore = opts.memeStore;
    this.config = opts.config;
    this.log = opts.logger?.child({ component: 'meme-matcher' }) ?? console;
  }

  /** 有效端点：matcher 专属端点留空时回落视觉打标端点（同款小模型） */
  get effectiveBaseUrl() {
    const cfg = this.config?.meme ?? {};
    return String(cfg.matcherBaseUrl || cfg.visionBaseUrl || '').trim();
  }

  get effectiveModel() {
    const cfg = this.config?.meme ?? {};
    return String(cfg.matcherModel || cfg.visionModel || 'gpt-4o-mini').trim();
  }

  get maxRetries() {
    const n = Number(this.config?.meme?.matcherMaxRetries);
    return Number.isInteger(n) && n >= 0 && n <= 5 ? n : 2;
  }

  get candidateCount() {
    const n = Number(this.config?.meme?.matcherCandidateCount);
    return Number.isInteger(n) && n >= 1 && n <= 20 ? n : 10;
  }

  /**
   * @param {object} params
   * @param {object} params.inbound
   * @param {string} params.replyText   机器人回复全文
   * @param {string} params.userText    触发消息原文
   * @param {AbortSignal} [params.signal]
   * @param {(outbound: object) => void} params.enqueue
   * @returns {Promise<{ attached: boolean, memeId: string|null, decision: string }|null>}
   *   null = 前置短路（未启用/无回复/无端点/无候选）；attached=false = 跑了但没配
   */
  async maybeAttach({ inbound, replyText, userText, signal, enqueue }) {
    const correlationId = inbound?.correlationId ?? 'unknown';
    const started = Date.now();
    const reply = String(replyText ?? '').trim();
    const cfg = this.config?.meme ?? {};

    if (cfg.matcherEnabled !== true) return null;
    if (!reply) return null;
    if (!this.memeStore) return null;
    if (!this.effectiveBaseUrl) return null;
    if (signal?.aborted) return null;

    try {
      const candidates = this._collectCandidates(reply, String(userText ?? '').trim());
      // 候选为空：不发起 API 调用，零成本跳过
      if (candidates.length === 0) return null;

      const result = await this._decide({ inbound, reply, userText, candidates, signal });

      this.log.info('表情后置匹配', {
        correlationId,
        decision: result.decision,
        memeId: result.memeId,
        attempts: result.attempts,
        latencyMs: Date.now() - started,
      });

      if (result.decision === 'send' && result.meme && enqueue) {
        enqueue(
          createOutboundMessage({
            correlationId: inbound.correlationId,
            sessionId: inbound.sessionId,
            target: {
              type: inbound.messageType,
              id: inbound.messageType === MESSAGE_TYPES.GROUP ? inbound.groupId : inbound.userId,
            },
            replyToUserId: inbound.userId,
            text: buildImageCq(result.meme.path),
            metadata: { isFirst: false, disableAutoMention: true },
          }),
        );
        return { attached: true, memeId: result.memeId, decision: result.decision };
      }
      return { attached: false, memeId: null, decision: result.decision };
    } catch (err) {
      // 任何异常都不能影响已经发出的文本
      this.log.warn('表情后置匹配失败，本轮不配图', {
        correlationId,
        latencyMs: Date.now() - started,
        error: err.message,
      });
      return { attached: false, memeId: null, decision: 'error' };
    }
  }

  /**
   * 候选收集：回复检索 8 个 ∪ 触发消息检索 4 个，按 id 去重后
   * 截断到 matcherCandidateCount。进程内直调，零 HTTP。
   */
  _collectCandidates(reply, userText) {
    const seen = new Set();
    const out = [];
    const push = (items) => {
      for (const item of items ?? []) {
        if (!item?.id || seen.has(item.id)) continue;
        seen.add(item.id);
        out.push(item);
      }
    };

    push(this.memeStore.search(reply.slice(0, REPLY_MAX_CHARS), 8));
    if (userText) {
      push(this.memeStore.search(userText.slice(0, USER_TEXT_MAX_CHARS), 4));
    }

    return out.slice(0, this.candidateCount);
  }

  /**
   * 单次 LLM 决策（含无效输出重试）。
   * 重试只针对无效输出（烂 JSON / meme_id 不在候选 / resolveById 失败），
   * 带反馈追加 messages；decision=none 是合法终态，不重试。
   */
  async _decide({ inbound, reply, userText, candidates, signal }) {
    const maxRetries = this.maxRetries;
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: this._renderUserPrompt(reply, userText, candidates) },
    ];
    const candidateIds = new Set(candidates.map((c) => c.id));

    let attempts = 0;
    let lastInvalid = null;
    while (attempts <= maxRetries) {
      if (signal?.aborted) return { decision: 'aborted', memeId: null, meme: null, attempts };

      attempts++;
      const response = await this.models.generate(
        createModelRequest({
          correlationId: `meme_match_${inbound.correlationId}`,
          sessionId: MATCHER_SESSION_KEY,
          sessionKey: MATCHER_SESSION_KEY,
          model: this.effectiveModel,
          messages,
          // 预算给足 5000：思考型模型的推理 token 与正文共享 max_tokens，
          // 100 会让正文截断在 {"decision":" 处（3 次确定性截断的实测教训）
          generation: { max_tokens: 5000, temperature: 0.3 },
          stream: false,
        }),
        { signal },
      );

      const raw = String(response.rawText ?? '').trim();
      const parsed = this._extractJson(raw);

      if (!parsed || typeof parsed !== 'object' || typeof parsed.decision !== 'string') {
        lastInvalid = `输出不是合法 JSON: ${raw.slice(0, 120)}`;
      } else if (parsed.decision === 'none') {
        return { decision: 'none', memeId: null, meme: null, attempts };
      } else if (parsed.decision === 'send') {
        const id = String(parsed.meme_id ?? '').trim();
        if (!id || !candidateIds.has(id)) {
          lastInvalid = `meme_id ${JSON.stringify(id)} 不在候选列表中`;
        } else {
          const meme = this.memeStore.resolveById(id);
          if (meme) return { decision: 'send', memeId: id, meme, attempts };
          lastInvalid = `meme_id ${id} 解析失败（文件缺失或不可用）`;
        }
      } else {
        lastInvalid = `未知 decision: ${String(parsed.decision).slice(0, 40)}`;
      }

      // 无效输出：追加 assistant 原文 + user 纠错反馈后重试
      if (attempts <= maxRetries) {
        messages.push({ role: 'assistant', content: raw });
        messages.push({
          role: 'user',
          content: `上一次输出无效：${lastInvalid}。请重新严格按输出协议只输出一个 JSON。`,
        });
      }
    }

    this.log.warn('表情后置匹配重试耗尽，放弃配图', {
      correlationId: inbound.correlationId,
      attempts,
      reason: lastInvalid,
    });
    return { decision: 'invalid', memeId: null, meme: null, attempts };
  }

  _renderUserPrompt(reply, userText, candidates) {
    const lines = [];
    lines.push('[触发消息]');
    lines.push(userText.slice(0, USER_TEXT_MAX_CHARS) || '（无）');
    lines.push('');
    lines.push('[机器人回复]');
    lines.push(reply.slice(0, REPLY_MAX_CHARS));
    lines.push('');
    lines.push('[候选表情包]');
    for (const c of candidates) {
      const parts = [`id: ${c.id}`, `标签: ${c.tag ?? ''}`, `分类: ${c.category ?? ''}`];
      if (Array.isArray(c.keywords) && c.keywords.length) parts.push(`关键词: ${c.keywords.join('、')}`);
      if (c.description) parts.push(`描述: ${c.description}`);
      lines.push(`- ${parts.join(' | ')}`);
    }
    return lines.join('\n');
  }

  /** JSON 容错提取：沿用 meme-store 的 \{[\s\S]*\} 截取模式 */
  _extractJson(text) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}
