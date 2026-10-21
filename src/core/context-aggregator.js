/**
 * core/context-aggregator.js — 上下文聚合
 *
 * 旧 Bridge 的上下文有三条互不知情的路径：
 *   1. GCP :8877 的 get_and_consume_context（bridge.js:35-48）
 *   2. 本地 groupContextBuffer 滑窗（bridge.js:1190-1196）
 *   3. selfLearning 语气画像 + 黑话 + 好感度行，直接字符串拼进 systemText
 * 谁先谁后、总长多少、超了截谁，全靠拼接顺序隐式决定。
 *
 * v2 把它们统一成 ContextBlock，按固定 8 步聚合：
 *   丢弃失败/空 → 作用域过滤 → 按 dedupeKey 去重 → priority 排序
 *   → 每来源预算 → 全局预算 → 保留截断原因 → 渲染
 */

import { CONTEXT_SCOPES, coerceContextBlocks } from '../contracts/context-block.js';
import { lorebookContributionCost } from '../orchestration/lorebook-renderer.js';

export class ContextAggregator {
  /**
   * @param {object} opts
   * @param {import('./capability-bus.js').CapabilityBus} opts.capabilityBus
   * @param {import('./logger.js').Logger} opts.logger
   * @param {number} [opts.totalCharacterBudget=12000]
   * @param {number} [opts.perSourceCharacterBudget=4000]
   * @param {number} [opts.collectTimeoutMs=5000]
   */
  constructor(opts = {}) {
    this.capabilityBus = opts.capabilityBus;
    this.log = opts.logger?.child({ component: 'context-aggregator' }) ?? console;
    this.totalBudget = opts.totalCharacterBudget ?? 12000;
    this.perSourceBudget = opts.perSourceCharacterBudget ?? 4000;
    this.collectTimeoutMs = opts.collectTimeoutMs ?? 5000;
    /** 进程内 Provider：不走 HTTP，但一样返回 ContextBlock */
    this.localProviders = [];
  }

  /**
   * @param {object} provider
   * @param {string} provider.id
   * @param {number} [provider.priority]
   * @param {(input:object)=>Promise<any>|any} provider.collect
   */
  registerLocal(provider) {
    this.localProviders.push({ priority: 50, ...provider });
    this.localProviders.sort((a, b) => b.priority - a.priority);
    this.log.info('本地上下文提供者已注册', { providerId: provider.id });
  }

  /**
   * 并发收集 + 聚合。
   * @param {object} input   传给各 Provider 的输入（inbound 摘要）
   * @param {object} ctx     { correlationId, sessionId, signal, scope }
   * @returns {Promise<{ blocks: object[], text: string, stats: object }>}
   */
  async aggregate(input, ctx = {}) {
    const scope = ctx.scope ?? CONTEXT_SCOPES.ANY;
    const startedAt = Date.now();

    const [remote, local] = await Promise.all([
      this._collectRemote(input, ctx),
      this._collectLocal(input, ctx),
    ]);

    const raw = [...remote, ...local];
    const pipeline = this._reduce(raw, scope);

    const stats = {
      providersCalled: raw.length ? new Set(raw.map((b) => b.source)).size : 0,
      blocksRaw: raw.length,
      blocksKept: pipeline.blocks.length,
      blocksDropped: pipeline.dropped.length,
      charsRendered: pipeline.text.length,
      elapsedMs: Date.now() - startedAt,
    };

    if (pipeline.dropped.length) {
      this.log.debug('上下文块被丢弃或截断', {
        correlationId: ctx.correlationId,
        dropped: pipeline.dropped,
      });
    }

    const interception = raw.find((b) => b?.metadata?.intercepted || b?.detail?.intercepted || b?.intercepted);
    return {
      blocks: pipeline.blocks,
      text: pipeline.text,
      stats,
      dropped: pipeline.dropped,
      intercepted: Boolean(interception),
      reply: interception?.metadata?.reply ?? interception?.detail?.reply ?? interception?.reply ?? null,
    };
  }

  async _collectRemote(input, ctx) {
    if (!this.capabilityBus) return [];
    const results = await this.capabilityBus.collect('context.enrich', input, {
      ...ctx,
      timeoutMs: this.collectTimeoutMs,
    });
    const out = [];
    for (const { providerId, priority, result } of results) {
      if (result?.intercepted) {
        out.push({
          source: providerId,
          capability: 'context.enrich',
          priority: priority + 1000,
          text: result.reply || '请求已被宿主拦截',
          metadata: { intercepted: true, reply: result.reply || null },
          scope: CONTEXT_SCOPES.ANY,
        });
      }
      out.push(
        ...coerceContextBlocks(result, {
          source: providerId,
          capability: 'context.enrich',
          // Provider 在 manifest 里声明的 priority 必须传下来，
          // 否则远程块一律退回默认 50，排序会被本地兜底块压过去
          priority,
        }),
      );
    }
    return out;
  }

  async _collectLocal(input, ctx) {
    if (this.localProviders.length === 0) return [];
    const settled = await Promise.allSettled(
      this.localProviders.map(async (p) => ({
        providerId: p.id,
        priority: p.priority,
        result: await p.collect(input, ctx),
      })),
    );

    const out = [];
    for (const [i, entry] of settled.entries()) {
      if (entry.status !== 'fulfilled') {
        this.log.warn('本地上下文提供者失败，已丢弃', {
          providerId: this.localProviders[i].id,
          correlationId: ctx.correlationId,
          error: entry.reason?.message,
        });
        continue;
      }
      out.push(
        ...coerceContextBlocks(entry.value.result, {
          source: entry.value.providerId,
          capability: 'context.enrich',
          priority: entry.value.priority,
        }),
      );
    }
    return out;
  }

  /** 纯函数：给定原始块，产出最终块与渲染文本。便于单测。 */
  _reduce(rawBlocks, scope) {
    const dropped = [];

    // 1. 丢弃空结果
    let blocks = rawBlocks.filter((b) => {
      if (!b || typeof b.text !== 'string' || !b.text.trim()) {
        if (b) dropped.push({ source: b.source, reason: 'empty' });
        return false;
      }
      return true;
    });

    // 2. 按作用域过滤
    blocks = blocks.filter((b) => {
      const ok = b.scope === CONTEXT_SCOPES.ANY || scope === CONTEXT_SCOPES.ANY || b.scope === scope;
      if (!ok) dropped.push({ source: b.source, reason: `scope-mismatch(${b.scope}≠${scope})` });
      return ok;
    });

    // 3. 显式 dedupeKey 去重：同 key 只保留优先级最高的一个。
    //    没带 dedupeKey 的块一律不去重——统一宿主的一个插件会产出多个
    //    不同槽位的块（Favour Ultra：规则块 + 动态数据块），按 source
    //    兜底去重会吞掉第二块，注入只剩一半。跨提供者互斥（GCP 上下文
    //    vs 本地滑窗）由双方显式声明同一个 dedupeKey 达成。
    const byKey = new Map();
    const keptInOrder = [];
    for (const b of blocks) {
      const key = b.dedupeKey;
      if (!key) {
        keptInOrder.push(b);
        continue;
      }
      const prevIndex = byKey.get(key);
      if (prevIndex === undefined) {
        byKey.set(key, keptInOrder.length);
        keptInOrder.push(b);
        continue;
      }
      const prev = keptInOrder[prevIndex];
      if (b.priority > prev.priority) {
        keptInOrder[prevIndex] = b;
        dropped.push({ source: prev.source, reason: 'deduped' });
      } else {
        dropped.push({ source: b.source, reason: 'deduped' });
      }
    }
    blocks = keptInOrder;

    // 4. 按 priority 降序；同优先级按 source 稳定排序
    blocks.sort((a, b) => b.priority - a.priority || a.source.localeCompare(b.source));

    // 5. 每来源预算。World Info 的正文及完整顶部包装也计入开销。
    const loreCosts = new Map();
    blocks = blocks.map((b) => {
      const limit = Math.min(b.budgetHint ?? this.perSourceBudget, this.perSourceBudget);
      if (b.metadata?.slot === 'lorebook') {
        const cost = lorebookContributionCost(b);
        loreCosts.set(b, cost.characters);
        if (cost.characters <= limit && cost.bytes <= (b.metadata.renderBudgetBytes ?? 2048)) return b;
        dropped.push({ source: b.source, reason: 'lorebook-per-source-whole-entry-dropped' });
        return null;
      }
      if (b.text.length <= limit) return b;
      dropped.push({ source: b.source, reason: `per-source-truncated(${b.text.length}→${limit})` });
      return {
        ...b,
        text: b.text.slice(0, limit),
        truncatedReason: `per-source budget ${limit}`,
      };
    });

    blocks = blocks.filter(Boolean);

    // 6. 全局预算：从低优先级开始丢，保证高优先级块完整
    const kept = [];
    let used = 0;
    for (const b of blocks) {
      const cost = (loreCosts.get(b) ?? b.text.length) + 1; // +1 是块之间的换行
      if (used + cost <= this.totalBudget) {
        kept.push(b);
        used += cost;
        continue;
      }
      if (b.metadata?.slot === 'lorebook') {
        dropped.push({ source: b.source, reason: 'lorebook-total-budget-whole-entry-dropped' });
        continue;
      }
      const remaining = this.totalBudget - used;
      if (remaining > 64) {
        kept.push({
          ...b,
          text: b.text.slice(0, remaining - 1),
          truncatedReason: `total budget ${this.totalBudget}`,
        });
        used = this.totalBudget;
        dropped.push({ source: b.source, reason: `total-budget-truncated(${remaining})` });
      } else {
        dropped.push({ source: b.source, reason: 'total-budget-dropped' });
      }
    }

    // 7 & 8. 渲染
    return { blocks: kept, dropped, text: this.render(kept) };
  }

  /**
   * 渲染为最终 Prompt 片段。插件不能自行拼这一步，避免格式和优先级失控。
   */
  render(blocks) {
    return blocks
      .map((b) => b.text.trim())
      .filter(Boolean)
      .join('\n');
  }
}

/**
 * 合并多段上下文文本并按行去重（迁移自 bridge.js:50-62 mergeContextLines）。
 * GCP 上下文与本地滑窗常有重叠行，去重后再进预算能省下可观预算。
 */
export function mergeContextLines(...contexts) {
  const seen = new Set();
  const lines = [];
  for (const context of contexts) {
    for (const line of String(context || '').split(/\r?\n/)) {
      const normalized = line.trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      lines.push(normalized);
    }
  }
  return lines.join('\n');
}
