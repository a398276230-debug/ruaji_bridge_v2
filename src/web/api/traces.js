/**
 * web/api/traces.js — 全链路追踪浏览器
 *
 * 按 correlationId / messageId 检索最近 N 条消息，并把一条消息的生命周期
 * 还原成树状时序：
 *   [NapCat 接收] → [GCP 裁决 (12ms)] → [Context 收集 (45ms)]
 *   → [LLM 推理 (850ms)] → [Middleware 转换 (5ms)] → [发送]
 *
 * Middleware 的耗时要特别处理：管线是洋葱模型，第 i 个中间件的实测耗时
 * 天然包含了 i+1..n 的全部耗时。直接展示会得到"affection 用了 900ms"
 * 这种极具误导性的数字（其实 890ms 是它内层的 typing-delay 在等）。
 * 这里按相邻差值折算出各自的自身耗时（selfMs），并把外层耗时保留为 inclusiveMs。
 */

export function createTracesApi(deps) {
  const { traceCollector, config } = deps;

  return {
    'GET /api/traces': async ({ url }) => {
      if (!traceCollector) return { status: 503, body: { error: '追踪采集器未启用' } };
      const limit = Number(url.searchParams.get('limit') ?? 50);
      return {
        body: {
          total: traceCollector.traces.size,
          capacity: traceCollector.maxTraces,
          items: traceCollector.list({
            limit,
            q: url.searchParams.get('q') ?? '',
            route: url.searchParams.get('route') ?? undefined,
          }),
        },
      };
    },

    /** /api/traces/<correlationId 或 messageId> */
    'GET /api/traces/*': async ({ pathname }) => {
      if (!traceCollector) return { status: 503, body: { error: '追踪采集器未启用' } };
      const id = pathname.slice('/api/traces/'.length);
      if (!id) return { status: 400, body: { error: '缺少 correlationId' } };

      const trace =
        traceCollector.get(id) ??
        [...traceCollector.traces.values()].find((t) => String(t.messageId) === id);

      if (!trace) return { status: 404, body: { error: `未找到追踪记录 ${id}` } };
      return { body: { trace: expand(trace, config) } };
    },

    'POST /api/traces/clear': async () => {
      if (!traceCollector) return { status: 503, body: { error: '追踪采集器未启用' } };
      const before = traceCollector.traces.size;
      traceCollector.clear();
      return { body: { cleared: before } };
    },
  };
}

/** 展开成前端直接可渲染的时序树 */
function expand(trace, config) {
  const timeline = buildTimeline(trace);
  return {
    ...trace,
    timeline,
    totalMs: trace.updatedAt - trace.createdAt,
    contextBudget: {
      totalCharacterBudget: config.context.totalCharacterBudget,
      perSourceCharacterBudget: config.context.perSourceCharacterBudget,
      usedChars: trace.context?.stats?.charsRendered ?? 0,
    },
  };
}

function buildTimeline(trace) {
  const spans = [...trace.spans];

  /*
   * Middleware 是洋葱模型，观察者在每一层 process() 返回时上报 —— 也就是
   * **内层先报、外层后报**。所以一段连续的 middleware span 在数组里是
   *   [typing-delay, strip-markdown, meme, media-extract, affection]
   * 而真实执行顺序恰好相反。这里先翻回执行顺序（人看时序图期望的顺序），
   * 再用"外层实测 − 相邻内层实测"折算出各自的自身耗时。
   *
   * 不折算的后果很具体：typing-delay 常常要等 800~2500ms，它被包在最里层，
   * 于是外面每一层的实测耗时都带着这段等待。面板会显示"affection 耗时 2.4 秒"，
   * 而 affection 其实只跑了 2 毫秒。
   */
  const groups = groupConsecutive(spans, (s) => s.category === 'middleware');
  const ordered = [];
  for (const group of groups) {
    if (!group.isMatch) {
      ordered.push(...group.items);
      continue;
    }
    const execOrder = [...group.items].reverse();
    for (let i = 0; i < execOrder.length; i++) {
      const inclusive = execOrder[i].elapsedMs;
      const inner = execOrder[i + 1]?.elapsedMs ?? 0;
      execOrder[i] = { ...execOrder[i], inclusiveMs: inclusive, selfMs: Math.max(0, inclusive - inner) };
    }
    ordered.push(...execOrder);
  }

  return ordered.map((s, index) => ({
    index,
    name: s.name,
    category: s.category,
    at: s.at,
    offsetMs: Math.max(0, (s.startedAt ?? s.at - s.elapsedMs) - trace.createdAt),
    elapsedMs: s.selfMs ?? s.elapsedMs,
    inclusiveMs: s.inclusiveMs ?? s.elapsedMs,
    meta: s.meta,
  }));
}

/** 把数组按"是否满足谓词"切成连续段，用于识别一轮完整的 middleware 管线 */
function groupConsecutive(items, predicate) {
  const groups = [];
  let current = null;
  for (const item of items) {
    const isMatch = predicate(item);
    if (!current || current.isMatch !== isMatch) {
      current = { isMatch, items: [] };
      groups.push(current);
    }
    current.items.push(item);
  }
  return groups;
}
