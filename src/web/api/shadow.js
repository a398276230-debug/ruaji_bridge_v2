/**
 * web/api/shadow.js — 影子对比报告器
 *
 * 直读 shadow/compare-*.jsonl，把新旧管线在同一条消息上的决策差异列出来。
 * 复用 shadow/report.js 的 loadEntries/buildReport，不另写一套解析
 * ——对照口径必须与命令行报告完全一致，否则面板和报告会给出两个"真相"。
 *
 * 除了落盘的历史文件，还额外暴露当前进程 ShadowRecorder 的内存副本：
 * 影子模式刚起来的头几秒文件还没 flush，运维最需要看的恰恰是那几条。
 */

import fs from 'node:fs';
import path from 'node:path';

import { loadEntries, buildReport, INTENTIONAL_DIFFS } from '../../shadow/report.js';
import { parseLegacyDecisions } from '../../shadow/comparator.js';

const MAX_LEGACY_LOG_BYTES = 4 * 1024 * 1024;

export function createShadowApi(deps) {
  const { config, shadowRecorder, logger } = deps;
  const log = logger?.child({ component: 'web-shadow' }) ?? console;
  const shadowDir = config.paths.shadowDir;

  return {
    'GET /api/shadow/files': async () => ({
      body: {
        dir: shadowDir,
        enabled: shadowRecorder?.enabled === true,
        currentFile: shadowRecorder?.file ?? null,
        inMemoryEntries: shadowRecorder?.entries.length ?? 0,
        files: listCompareFiles(shadowDir),
      },
    }),

    'GET /api/shadow/entries': async ({ url }) => {
      const limit = clamp(Number(url.searchParams.get('limit') ?? 100), 1, 1000);
      const kind = url.searchParams.get('kind') ?? '';
      const file = url.searchParams.get('file') ?? '';

      let entries;
      let source;
      if (file === 'memory' || (!file && shadowRecorder?.entries.length)) {
        entries = [...(shadowRecorder?.entries ?? [])];
        source = 'memory';
      } else {
        const resolved = resolveInsideDir(shadowDir, file || latestCompareFile(shadowDir));
        if (!resolved) return { status: 404, body: { error: '没有可读的影子对照文件' } };
        entries = loadEntries([resolved]);
        source = path.basename(resolved);
      }

      const filtered = kind ? entries.filter((e) => e.kind === kind) : entries;
      return {
        body: {
          source,
          total: filtered.length,
          items: filtered.slice(-limit).reverse(),
        },
      };
    },

    /**
     * 汇总报告。带 ?legacyLog=../bridge.log 时顺带回填旧 Bridge 的裁决分布。
     * 旧日志按只读方式打开，且只读尾部 4MB —— 那份文件现在有 9MB 且还在增长。
     */
    'GET /api/shadow/report': async ({ url }) => {
      const file = url.searchParams.get('file') ?? '';
      let entries;
      if (file === 'memory') {
        entries = [...(shadowRecorder?.entries ?? [])];
      } else if (file) {
        const resolved = resolveInsideDir(shadowDir, file);
        entries = resolved ? loadEntries([resolved]) : [];
      } else {
        entries = loadEntries(listCompareFiles(shadowDir).map((f) => f.path));
        if (!entries.length) entries = [...(shadowRecorder?.entries ?? [])];
      }

      let legacyLines = [];
      const legacyLog = url.searchParams.get('legacyLog');
      if (legacyLog) {
        try {
          legacyLines = parseLegacyDecisions(readTail(legacyLog, MAX_LEGACY_LOG_BYTES));
        } catch (err) {
          log.warn('旧 Bridge 日志读取失败，跳过回填', { error: err.message });
        }
      }

      return {
        body: {
          ...buildReport(entries, legacyLines),
          diffs: buildDiffRows(entries),
        },
      };
    },

    'GET /api/shadow/intentional-diffs': async () => ({ body: { items: INTENTIONAL_DIFFS } }),
  };
}

/**
 * 把 decision 与 reply 两类记录按 correlationId 缝合成一行"对照视图"。
 * 旧 Bridge 的裁决字段（oldBridgeDecision）在采集时留空，由离线对账回填；
 * 没回填时 match 为 null，前端显示"待对账"而不是假装一致。
 */
function buildDiffRows(entries) {
  const byCorrelation = new Map();
  for (const e of entries) {
    const row = byCorrelation.get(e.correlationId) ?? {
      correlationId: e.correlationId,
      messageId: e.messageId,
      sessionId: e.sessionId,
      at: e.at,
      v2Decision: null,
      v2Reason: null,
      oldBridgeDecision: null,
      match: null,
      contextSources: [],
      segments: null,
      replyChars: null,
      latencyMs: null,
      suppressedSideEffects: [],
    };
    if (e.kind === 'decision') {
      row.v2Decision = e.v2Decision;
      row.v2Reason = e.v2Reason;
      row.oldBridgeDecision = e.oldBridgeDecision ?? null;
      row.match = e.match ?? null;
      row.isAtBot = e.isAtBot;
      row.isNameCall = e.isNameCall;
      row.isOwner = e.isOwner;
      row.providerId = e.providerId ?? null;
    } else if (e.kind === 'reply') {
      row.contextSources = e.contextSources ?? [];
      row.segments = e.segments ?? null;
      row.replyChars = e.replyChars ?? null;
      row.latencyMs = e.latencyMs ?? null;
      row.suppressedSideEffects = e.suppressedSideEffects ?? [];
    }
    byCorrelation.set(e.correlationId, row);
  }
  return [...byCorrelation.values()].reverse();
}

function listCompareFiles(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /^compare-.*\.jsonl$/.test(f))
      .map((f) => {
        const full = path.join(dir, f);
        const st = fs.statSync(full);
        return { name: f, path: full, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() };
      })
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  } catch {
    return [];
  }
}

function latestCompareFile(dir) {
  return listCompareFiles(dir)[0]?.name ?? '';
}

/** 只允许读 shadowDir 之内的文件，防止 ?file=../../etc/passwd */
function resolveInsideDir(dir, name) {
  if (!name) return null;
  const resolved = path.resolve(dir, name);
  const relative = path.relative(dir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return fs.existsSync(resolved) ? resolved : null;
}

/** 只读文件尾部 N 字节：bridge.log 是 9MB 且在增长，全量读会把面板卡死 */
function readTail(file, maxBytes) {
  const st = fs.statSync(file);
  const start = Math.max(0, st.size - maxBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const length = st.size - start;
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function clamp(n, lo, hi) {
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;
}
