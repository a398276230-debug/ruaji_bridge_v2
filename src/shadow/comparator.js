/**
 * shadow/comparator.js — 影子模式对照记录
 *
 * 阶段 6 的产物。v2 与旧 Bridge 并行接同一条 NapCat 消息流：
 *   旧 Bridge：正常处理并发送
 *   v2：       规范化、裁决、聚合、生成候选结果，但禁止发送和副作用写入
 *
 * 输出格式按附录 4：
 *   { correlationId, messageId, oldBridgeDecision, v2Decision, promptDiff, match }
 *
 * 旧 Bridge 的裁决从它自己的 bridge.log 里解析（那两行日志格式稳定）：
 *   "[群消息] 触发|忽略 | 真@=… 名字呼唤=… | …"
 *   "[GCP唤醒裁决] 群=… route=… reason=…"
 */

import fs from 'node:fs';
import path from 'node:path';

export class ShadowRecorder {
  /**
   * @param {object} opts
   * @param {string} opts.shadowDir
   * @param {object} opts.config
   * @param {import('../core/logger.js').Logger} [opts.logger]
   * @param {boolean} [opts.enabled]
   */
  constructor(opts = {}) {
    this.dir = opts.shadowDir;
    this.config = opts.config;
    this.log = opts.logger?.child({ component: 'shadow' }) ?? console;
    this.enabled = opts.enabled ?? opts.config?.mode === 'shadow';
    this.stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
    this.file = path.join(this.dir, `compare-${this.stamp}.jsonl`);
    /** 内存副本，供测试断言与 report.js 汇总 */
    this.entries = [];
    if (this.enabled) {
      try { fs.mkdirSync(this.dir, { recursive: true }); } catch { /* ignore */ }
    }
  }

  /** 记录一次裁决 */
  record({ inbound, decision }) {
    if (!this.enabled) return;
    const entry = {
      kind: 'decision',
      at: new Date().toISOString(),
      correlationId: inbound.correlationId,
      messageId: inbound.messageId,
      sessionId: inbound.sessionId,
      userId: inbound.userId,
      groupId: inbound.groupId,
      isAtBot: inbound.flags.isAtBot,
      isNameCall: inbound.flags.isNameCall,
      isOwner: inbound.flags.isOwner,
      v2Decision: decision.route,
      v2Reason: decision.reason,
      v2TriggerType: decision.triggerType ?? null,
      providerId: decision.providerId ?? null,
      // 旧 Bridge 的裁决在离线对账阶段由 report.js 从 bridge.log 回填
      oldBridgeDecision: null,
      match: null,
    };
    this._write(entry);
  }

  /** 记录一次完整生成（含 Prompt 与最终文本，供人工比对） */
  recordReply({ inbound, decision, result, contextBlocks }) {
    if (!this.enabled) return;
    const entry = {
      kind: 'reply',
      at: new Date().toISOString(),
      correlationId: inbound.correlationId,
      messageId: inbound.messageId,
      sessionId: inbound.sessionId,
      v2Decision: decision.route,
      v2TriggerType: decision.triggerType,
      contextSources: (contextBlocks ?? []).map((b) => ({
        source: b.source,
        slot: b.metadata?.slot ?? 'extra',
        chars: b.text.length,
        truncatedReason: b.truncatedReason,
      })),
      segments: result.segments,
      replyChars: result.response?.rawText?.length ?? 0,
      usage: result.response?.usage ?? null,
      latencyMs: result.response?.latencyMs ?? 0,
      suppressedSideEffects: result.suppressed ?? [],
    };
    this._write(entry);
  }

  _write(entry) {
    this.entries.push(entry);
    try {
      fs.appendFileSync(this.file, JSON.stringify(entry) + '\n');
    } catch (err) {
      this.log.warn('影子对照日志写入失败', { error: err.message });
    }
  }

  getSummary() {
    const decisions = this.entries.filter((e) => e.kind === 'decision');
    const byRoute = {};
    for (const d of decisions) byRoute[d.v2Decision] = (byRoute[d.v2Decision] ?? 0) + 1;
    return {
      file: this.file,
      total: decisions.length,
      byRoute,
      replies: this.entries.filter((e) => e.kind === 'reply').length,
      suppressedSideEffects: this.entries
        .filter((e) => e.kind === 'reply')
        .reduce((n, e) => n + (e.suppressedSideEffects?.length ?? 0), 0),
    };
  }
}

/** 从旧 bridge.log 解析裁决行，供离线对账 */
const GCP_LINE = /\[GCP唤醒裁决\]\s*群=(\d+)\s*route=(\w*)\s*reason=(\S*)/;
const GROUP_LINE = /\[群消息\]\s*(触发|忽略)\s*\|\s*真@=(\w+)\s*名字呼唤=(\w+)/;

export function parseLegacyDecisions(logText) {
  const out = [];
  for (const line of String(logText ?? '').split(/\r?\n/)) {
    const gcp = GCP_LINE.exec(line);
    if (gcp) {
      out.push({ kind: 'gcp', groupId: gcp[1], route: gcp[2] || 'none', reason: gcp[3] });
      continue;
    }
    const group = GROUP_LINE.exec(line);
    if (group) {
      out.push({
        kind: 'wake',
        triggered: group[1] === '触发',
        isAtBot: group[2] === 'true',
        isNameCall: group[3] === 'true',
      });
    }
  }
  return out;
}

/**
 * 把旧 Bridge 的两行日志折算成 v2 的 route 语义。
 * 注意：旧 Bridge 的 `bridge.js:1239` 会把非 @ 的 direct 裁决二次否决，
 * 所以这里刻意复刻那个缺陷 —— 对账要跟"旧的实际行为"比，而不是"旧的本意"。
 */
export function legacyRouteOf({ gcpRoute, isAtBot }) {
  if (gcpRoute === 'ignore' || gcpRoute === 'duplicate') return 'ignore';
  if (gcpRoute !== 'direct' && !isAtBot) return 'ignore';
  if (!isAtBot) return 'ignore'; // 复刻 bridge.js:1239 的后置否决
  return 'direct';
}
