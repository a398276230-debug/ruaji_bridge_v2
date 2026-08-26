/**
 * web/trace-collector.js — 全链路追踪采集器
 *
 * 面板的 Trace Explorer 需要"一条消息从进到出，每一步花了多少毫秒"。
 * Bridge v2 原本没有这个东西：CapabilityBus 只有按 Provider 聚合的总计数，
 * MiddlewarePipeline 只把耗时打进 debug 日志，两者都还原不出单条消息的时序。
 *
 * 采集方式刻意选了"观察者"而不是"改编排层"：
 *   - EventBus 订阅 message.received / llm.request / llm.response / message.sent
 *     —— 这四个信封本来就带 correlationId，是现成的骨架
 *   - CapabilityBus 与 MiddlewarePipeline 各暴露一个默认为 null 的 observer 钩子，
 *     由本类挂上去补齐 GCP 裁决、上下文聚合与各 Middleware 的细粒度 span
 *
 * 这样 orchestration/ 一行不用改，主链路行为零变化；采集器摘掉之后
 * Bridge 的表现与现在完全一致。
 *
 * 存储是纯内存环形缓冲，默认 200 条（与任务书"最近 200 条"一致），
 * 进程重启即清空 —— 追踪数据是运维视图，不是业务数据，不落盘。
 */

import { EVENTS } from '../contracts/events.js';

export const TRACE_STATUS = Object.freeze({
  RECEIVED: 'received',
  IGNORED: 'ignored',
  GENERATING: 'generating',
  REPLIED: 'replied',
  ERROR: 'error',
});

/** span 分类，前端按它上色 */
export const SPAN_CATEGORY = Object.freeze({
  INBOUND: 'inbound',
  DECISION: 'decision',
  CONTEXT: 'context',
  LLM: 'llm',
  MIDDLEWARE: 'middleware',
  SEND: 'send',
});

export class TraceCollector {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxTraces=200]
   * @param {() => number} [opts.now]
   */
  constructor(opts = {}) {
    this.maxTraces = opts.maxTraces ?? 200;
    this.now = opts.now ?? Date.now;
    /** correlationId -> trace（Map 保序，天然就是插入顺序的环形缓冲） */
    this.traces = new Map();
    /** 累计指标，与环形缓冲无关，不随淘汰归零 */
    this.counters = {
      messages: 0,
      decisions: { direct: 0, auto: 0, ignore: 0, command: 0 },
      llmCalls: 0,
      llmTotalMs: 0,
      llmFailures: 0,
      sent: 0,
    };
    /** middleware 名 -> { calls, totalMs, maxMs } */
    this.middlewareStats = new Map();
    /** 秒级时间戳数组，算吞吐量用 */
    this._messageTicks = [];
  }

  // ===== 装配 =====

  /**
   * 把采集器挂到各总线上。全部是可选钩子，不挂也不影响运行。
   * @param {object} deps
   * @param {import('../core/event-bus.js').EventBus} [deps.eventBus]
   * @param {import('../core/capability-bus.js').CapabilityBus} [deps.capabilityBus]
   * @param {import('../core/middleware-pipeline.js').MiddlewarePipeline} [deps.pipeline]
   */
  attach(deps = {}) {
    const { eventBus, capabilityBus, pipeline } = deps;

    if (eventBus) {
      eventBus.subscribe(EVENTS.MESSAGE_RECEIVED, '__trace__', (e) => this._onReceived(e));
      eventBus.subscribe(EVENTS.LLM_REQUEST, '__trace__', (e) => this._onLlmRequest(e));
      eventBus.subscribe(EVENTS.LLM_RESPONSE, '__trace__', (e) => this._onLlmResponse(e));
      eventBus.subscribe(EVENTS.MESSAGE_SENT, '__trace__', (e) => this._onSent(e));
    }

    if (capabilityBus) {
      capabilityBus.observer = (span) => this._onCapabilitySpan(span);
    }

    if (pipeline) {
      pipeline.observer = (span) => this._onMiddlewareSpan(span);
    }

    return this;
  }

  // ===== 事件订阅（EventBus 侧） =====

  _onReceived(envelope) {
    const p = envelope.payload ?? {};
    const trace = this._ensure(envelope.correlationId, {
      messageId: p.messageId ?? null,
      sessionId: envelope.sessionId,
      userId: p.userId ?? null,
      groupId: p.groupId ?? null,
      displayName: p.displayName ?? p.nickname ?? null,
      messageType: p.messageType ?? null,
      text: truncate(p.text ?? '', 500),
      flags: {
        isAtBot: p.isAtBot === true,
        isNameCall: p.isNameCall === true,
        isOwner: p.isOwner === true,
        hasImage: p.hasImage === true,
        hasFile: p.hasFile === true,
      },
    });
    trace.receivedAt = envelope.timestamp * 1000;
    this._push(trace, {
      name: 'NapCat 接收',
      category: SPAN_CATEGORY.INBOUND,
      elapsedMs: 0,
      meta: { messageId: p.messageId },
    });
    this.counters.messages++;
    this._messageTicks.push(this.now());
    this._pruneTicks();
  }

  _onLlmRequest(envelope) {
    const p = envelope.payload ?? {};
    const trace = this._ensure(envelope.correlationId, {});
    trace.status = TRACE_STATUS.GENERATING;
    trace.llm = {
      ...(trace.llm ?? {}),
      model: p.model ?? null,
      systemTextLength: p.systemTextLength ?? 0,
      contextBlockCount: p.contextBlockCount ?? 0,
      contextSources: p.contextSources ?? [],
      requestedAt: this.now(),
    };
    this.counters.llmCalls++;
  }

  _onLlmResponse(envelope) {
    const p = envelope.payload ?? {};
    const trace = this._ensure(envelope.correlationId, {});
    trace.llm = {
      ...(trace.llm ?? {}),
      responseId: p.responseId ?? null,
      textLength: p.textLength ?? 0,
      segments: p.segments ?? 0,
      usage: p.usage ?? null,
      latencyMs: p.latencyMs ?? 0,
      totalMs: p.totalMs ?? 0,
    };
    trace.status = TRACE_STATUS.REPLIED;
    this._push(trace, {
      name: 'LLM 推理',
      category: SPAN_CATEGORY.LLM,
      elapsedMs: p.latencyMs ?? 0,
      meta: { model: p.model, chars: p.textLength, segments: p.segments },
    });
    this.counters.llmTotalMs += p.latencyMs ?? 0;
  }

  _onSent(envelope) {
    const p = envelope.payload ?? {};
    const trace = this._ensure(envelope.correlationId, {});
    if (!trace.sent) trace.sent = [];
    trace.sent.push({
      at: this.now(),
      txId: p.txId ?? null,
      target: p.target ?? null,
      status: p.status ?? null,
      replyId: p.replyId ?? null,
      error: p.error ?? null,
      latencyMs: p.latencyMs ?? 0,
    });
    this._push(trace, {
      name: p.status === 'sent' ? '发送' : `发送 (${p.status ?? 'unknown'})`,
      category: SPAN_CATEGORY.SEND,
      elapsedMs: p.latencyMs ?? 0,
      meta: { target: p.target, status: p.status, error: p.error ?? null },
    });
    this.counters.sent++;
  }

  // ===== 观察者钩子（CapabilityBus / MiddlewarePipeline 侧） =====

  _onCapabilitySpan({ capability, providerId, elapsedMs, ok, correlationId, error }) {
    if (!correlationId) return;
    const trace = this._ensure(correlationId, {});
    const isDecision = capability === 'decision.group_reply';
    this._push(trace, {
      name: isDecision ? `裁决 (${providerId})` : `上下文 (${providerId})`,
      category: isDecision ? SPAN_CATEGORY.DECISION : SPAN_CATEGORY.CONTEXT,
      elapsedMs,
      meta: { capability, providerId, ok, error: error ?? null },
    });
  }

  _onMiddlewareSpan({ middleware, elapsedMs, correlationId, isFinalPass }) {
    const stat = this.middlewareStats.get(middleware) ?? { calls: 0, totalMs: 0, maxMs: 0 };
    stat.calls++;
    stat.totalMs += elapsedMs;
    if (elapsedMs > stat.maxMs) stat.maxMs = elapsedMs;
    this.middlewareStats.set(middleware, stat);

    if (!correlationId) return;
    const trace = this._ensure(correlationId, {});
    this._push(trace, {
      name: `Middleware ${middleware}`,
      category: SPAN_CATEGORY.MIDDLEWARE,
      elapsedMs,
      meta: { middleware, isFinalPass: isFinalPass === true },
    });
  }

  // ===== 编排层可选补录（由 InboundFlow/ContextFlow 之外的 Web 沙箱调用） =====

  /**
   * 记录一次裁决结果。InboundFlow 不调它 —— 由 ShadowRecorder 之外的
   * 面板沙箱与 recordDecision() 显式补录，主链路的裁决则从 CapabilityBus
   * span 与 message.received 之间推出来。
   */
  recordDecision(correlationId, decision) {
    const trace = this._ensure(correlationId, {});
    trace.decision = {
      route: decision.route,
      reason: decision.reason,
      triggerType: decision.triggerType ?? null,
      providerId: decision.providerId ?? null,
    };
    const route = decision.route;
    if (this.counters.decisions[route] != null) this.counters.decisions[route]++;
    if (route === 'ignore') trace.status = TRACE_STATUS.IGNORED;
    return trace;
  }

  /** 记录上下文分配明细（各块占用字符数与截断原因） */
  recordContext(correlationId, { blocks, stats, dropped }) {
    const trace = this._ensure(correlationId, {});
    trace.context = {
      stats: stats ?? null,
      dropped: dropped ?? [],
      blocks: (blocks ?? []).map((b) => ({
        source: b.source,
        slot: b.metadata?.slot ?? 'extra',
        priority: b.priority,
        chars: (b.text ?? '').length,
        truncatedReason: b.truncatedReason ?? null,
        preview: truncate(b.text ?? '', 240),
      })),
    };
    this._push(trace, {
      name: 'Context 聚合',
      category: SPAN_CATEGORY.CONTEXT,
      elapsedMs: stats?.elapsedMs ?? 0,
      meta: { kept: stats?.blocksKept, dropped: stats?.blocksDropped, chars: stats?.charsRendered },
    });
    return trace;
  }

  recordError(correlationId, message) {
    const trace = this._ensure(correlationId, {});
    trace.status = TRACE_STATUS.ERROR;
    trace.error = message;
    return trace;
  }

  // ===== 查询 =====

  get(correlationId) {
    return this.traces.get(correlationId) ?? null;
  }

  /**
   * @param {{ limit?: number, q?: string, route?: string }} [opts]
   * @returns {object[]} 按时间倒序
   */
  list(opts = {}) {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, this.maxTraces));
    const q = String(opts.q ?? '').trim().toLowerCase();
    const route = opts.route;

    const all = [...this.traces.values()].reverse();
    const filtered = all.filter((t) => {
      if (route && t.decision?.route !== route) return false;
      if (!q) return true;
      return (
        t.correlationId.toLowerCase().includes(q) ||
        String(t.messageId ?? '').toLowerCase().includes(q) ||
        String(t.text ?? '').toLowerCase().includes(q) ||
        String(t.displayName ?? '').toLowerCase().includes(q) ||
        String(t.userId ?? '').includes(q) ||
        String(t.groupId ?? '').includes(q)
      );
    });
    return filtered.slice(0, limit).map((t) => summarize(t));
  }

  /** 面板大盘用的运行指标 */
  metrics() {
    this._pruneTicks();
    const windowMs = 60000;
    const perMinute = this._messageTicks.length;

    const middleware = {};
    for (const [name, s] of this.middlewareStats) {
      middleware[name] = {
        calls: s.calls,
        avgMs: s.calls ? Math.round((s.totalMs / s.calls) * 100) / 100 : 0,
        maxMs: s.maxMs,
      };
    }

    return {
      traces: this.traces.size,
      maxTraces: this.maxTraces,
      throughput: { windowMs, messages: perMinute },
      messages: this.counters.messages,
      decisions: { ...this.counters.decisions },
      llm: {
        calls: this.counters.llmCalls,
        avgLatencyMs: this.counters.llmCalls
          ? Math.round(this.counters.llmTotalMs / this.counters.llmCalls)
          : 0,
        failures: this.counters.llmFailures,
      },
      sent: this.counters.sent,
      middleware,
    };
  }

  clear() {
    this.traces.clear();
  }

  // ===== 内部 =====

  _ensure(correlationId, seed) {
    let trace = this.traces.get(correlationId);
    if (trace) {
      // 补齐首次未知的字段（span 可能先于 message.received 到达）
      for (const [k, v] of Object.entries(seed)) {
        if (v != null && (trace[k] == null || trace[k] === '')) trace[k] = v;
      }
      trace.updatedAt = this.now();
      return trace;
    }

    trace = {
      correlationId,
      createdAt: this.now(),
      updatedAt: this.now(),
      status: TRACE_STATUS.RECEIVED,
      spans: [],
      decision: null,
      context: null,
      llm: null,
      sent: null,
      error: null,
      messageId: null,
      sessionId: null,
      userId: null,
      groupId: null,
      displayName: null,
      messageType: null,
      text: '',
      flags: {},
      ...seed,
    };
    this.traces.set(correlationId, trace);
    this._evict();
    return trace;
  }

  _push(trace, span) {
    const at = this.now();
    const elapsedMs = Math.max(0, Math.round(span.elapsedMs ?? 0));
    // span 是在"做完"的时刻才上报的，所以真正的起点要往前推它自己的耗时。
    // 不这么做的话，一个 850ms 的 LLM span 会被画成"在结束的瞬间才开始"，
    // 整条时序全部挤在右端。
    const startedAt = at - elapsedMs;

    trace.spans.push({
      name: span.name,
      category: span.category,
      at,
      startedAt,
      elapsedMs,
      meta: span.meta ?? {},
    });
    // 第一条 span 可能早于 trace 被创建的时刻（沙箱里没有 message.received 打底），
    // 时间轴原点要跟着往前挪，否则会出现负偏移
    if (startedAt < trace.createdAt) trace.createdAt = startedAt;
    trace.updatedAt = at;
    // 单条 trace 的 span 也要有上限，防止一条长会话把内存吃穿
    if (trace.spans.length > 200) trace.spans.splice(0, trace.spans.length - 200);
  }

  _evict() {
    while (this.traces.size > this.maxTraces) {
      const oldest = this.traces.keys().next().value;
      this.traces.delete(oldest);
    }
  }

  _pruneTicks() {
    const cutoff = this.now() - 60000;
    while (this._messageTicks.length && this._messageTicks[0] < cutoff) {
      this._messageTicks.shift();
    }
  }
}

function truncate(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** 列表视图：不带 spans 与上下文正文，避免一次拉回几 MB */
function summarize(t) {
  return {
    correlationId: t.correlationId,
    messageId: t.messageId,
    sessionId: t.sessionId,
    userId: t.userId,
    groupId: t.groupId,
    displayName: t.displayName,
    messageType: t.messageType,
    text: truncate(t.text, 120),
    status: t.status,
    route: t.decision?.route ?? null,
    reason: t.decision?.reason ?? null,
    spanCount: t.spans.length,
    llmLatencyMs: t.llm?.latencyMs ?? null,
    segments: t.llm?.segments ?? null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    totalMs: t.updatedAt - t.createdAt,
  };
}
