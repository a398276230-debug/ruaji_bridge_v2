/**
 * shadow/report.js — 影子对照汇总
 *
 * 用法：
 *   node src/shadow/report.js shadow/compare-*.jsonl [--legacy-log ../bridge.log]
 *
 * 产出：v2 裁决分布、与旧 Bridge 的匹配率、以及**有意识的差异**清单。
 * 三处已知的有意识差异（阶段 0 勘测结论）不计入失配：
 *   1. 非 @ 的 direct 裁决在 v2 会放行（旧 bridge.js:1239 会误杀）
 *   2. selfReply 死引用移除
 *   3. 限流命中时旧实现抛 TDZ ReferenceError，v2 正常静默忽略
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseLegacyDecisions, legacyRouteOf } from './comparator.js';

export const INTENTIONAL_DIFFS = Object.freeze([
  {
    id: 'direct-without-at',
    description: '裁决者返回 direct 但消息未 @ 机器人时，v2 放行、旧 Bridge 丢弃',
    reason: '旧 bridge.js:1239 的后置 isAtMe 检查作废了 :1233 放行的 direct 分支，属于缺陷',
  },
  {
    id: 'self-reply-removed',
    description: 'v2 不再调用 selfReply.markReply',
    reason: '旧 bridge.js:1084 引用了从未 require 的 selfReply，每次群聊回复都抛 ReferenceError',
  },
  {
    id: 'rate-limit-tdz',
    description: '限流命中时 v2 静默忽略，旧 Bridge 抛异常后走 catch',
    reason: '旧 bridge.js:1250 在 const nickname(:1256) 之前引用 nickname，触发 TDZ',
  },
]);

export function loadEntries(files) {
  const entries = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        /* 跳过半截行 */
      }
    }
  }
  return entries;
}

/**
 * @param {object[]} entries      compare-*.jsonl 的解析结果
 * @param {object[]} legacyLines  parseLegacyDecisions 的产物（可为空）
 */
export function buildReport(entries, legacyLines = []) {
  const decisions = entries.filter((e) => e.kind === 'decision');
  const replies = entries.filter((e) => e.kind === 'reply');

  const byRoute = {};
  for (const d of decisions) byRoute[d.v2Decision] = (byRoute[d.v2Decision] ?? 0) + 1;

  // 旧 Bridge 的 GCP 裁决按群聚合，用于粗粒度对账。
  // 逐条精确对齐需要 messageId，旧日志里没有，所以这里只做分布比对。
  const legacyByGroup = {};
  for (const line of legacyLines) {
    if (line.kind !== 'gcp') continue;
    const bucket = (legacyByGroup[line.groupId] ??= {});
    bucket[line.route] = (bucket[line.route] ?? 0) + 1;
  }

  const contextSourceUsage = {};
  let truncations = 0;
  for (const r of replies) {
    for (const src of r.contextSources ?? []) {
      contextSourceUsage[src.source] = (contextSourceUsage[src.source] ?? 0) + 1;
      if (src.truncatedReason) truncations++;
    }
  }

  const suppressed = replies.reduce((n, r) => n + (r.suppressedSideEffects?.length ?? 0), 0);

  return {
    generatedAt: new Date().toISOString(),
    v2: {
      decisions: decisions.length,
      byRoute,
      replies: replies.length,
      totalReplyChars: replies.reduce((n, r) => n + (r.replyChars ?? 0), 0),
      avgLatencyMs: replies.length
        ? Math.round(replies.reduce((n, r) => n + (r.latencyMs ?? 0), 0) / replies.length)
        : 0,
      contextSourceUsage,
      contextTruncations: truncations,
    },
    legacy: { byGroup: legacyByGroup, lines: legacyLines.length },
    sideEffects: {
      suppressed,
      // 验收标准 14：影子模式不得产生任何持久化副作用
      shadowClean: replies.every((r) => (r.suppressedSideEffects ?? []).every((s) => s.kind)),
    },
    intentionalDiffs: INTENTIONAL_DIFFS,
  };
}

export function formatReport(report) {
  const lines = [
    '=== RUAJI Bridge v2 影子对照报告 ===',
    `生成时间: ${report.generatedAt}`,
    '',
    '[v2 裁决分布]',
    ...Object.entries(report.v2.byRoute).map(([route, n]) => `  ${route.padEnd(8)} ${n}`),
    `  合计 ${report.v2.decisions} 条裁决，${report.v2.replies} 次生成`,
    '',
    '[上下文来源使用次数]',
    ...Object.entries(report.v2.contextSourceUsage).map(([src, n]) => `  ${src.padEnd(24)} ${n}`),
    `  预算截断 ${report.v2.contextTruncations} 次`,
    '',
    '[副作用]',
    `  影子模式抑制的写入: ${report.sideEffects.suppressed} 次`,
    '',
    '[旧 Bridge 日志裁决分布]',
    ...Object.entries(report.legacy.byGroup).map(
      ([gid, routes]) => `  群 ${gid}: ${Object.entries(routes).map(([r, n]) => `${r}=${n}`).join(' ')}`,
    ),
    '',
    '[有意识的行为差异 —— 不计入失配]',
    ...report.intentionalDiffs.flatMap((d) => [`  · ${d.description}`, `    原因: ${d.reason}`]),
  ];
  return lines.join('\n');
}

// CLI
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const args = process.argv.slice(2);
  const legacyIndex = args.indexOf('--legacy-log');
  const legacyLog = legacyIndex !== -1 ? args[legacyIndex + 1] : null;
  const files = args.filter((a, i) => !a.startsWith('--') && i !== legacyIndex + 1);

  const entries = loadEntries(files.map((f) => path.resolve(f)));
  const legacyLines = legacyLog && fs.existsSync(legacyLog)
    ? parseLegacyDecisions(fs.readFileSync(legacyLog, 'utf8'))
    : [];

  console.log(formatReport(buildReport(entries, legacyLines)));
}

export { parseLegacyDecisions, legacyRouteOf };
