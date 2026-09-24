/**
 * adapters/hermes/wake-extractor.js — Hermes transcript → 待投递的「分体通知」
 *
 * 职责边界（架构约定）：Hermes 的行语义（role / display_kind / [IMPORTANT: 信封）
 * 只在这里解析；编排层只消费 { kind, rowId, text } 这样的标准字段。
 *
 * 背景：Hermes 的 API Server 是无状态 HTTP 通道（api_server.py:
 * supports_async_delivery=False），后台任务结束后不能主动 push，只能把结果写回
 * 会话 transcript。写回的形状有两类：
 *
 *   1. 唤醒轮（terminal background + notify_on_complete / watch_patterns）：
 *        user 行   = 内部通知信封（"[IMPORTANT: Background process proc_xxx …"），
 *                    Hermes 侧带 display_kind=internal_notification 标记；
 *        assistant = 模型被唤醒后写的那段话 —— 这才是要推给 QQ 的内容。
 *      唤醒轮是自投递 HTTP 请求（gateway/wake.py: _self_post_chat_completion），
 *      所以形状上就是一次普通轮次，只能靠"信封行 + 紧随其后的 assistant 行"识别。
 *
 *   2. 异步委派完成（delegate_task background=true）：
 *        单行 display_kind=async_delegation_complete。**这一行不是给用户看的**：它的正文是
 *        Hermes 写给 agent 的重注入信封（tools/process_registry_notifications.py:
 *        _format_async_delegation，"the full task source is below so you can act on it"），
 *        而 Hermes 在无状态 api_server 面上不会为它起唤醒轮
 *        （gateway/run_notifications.py: _self_post_api_server → persist_delegation_delivery：
 *        只落一条 durable DELIVERY 行，把下一轮交给客户端），所以它永远不该被原样推到 QQ。
 *        这里把它当作「等模型转述」的锚点：跟普通唤醒信封一样，只提取**紧随其后的
 *        assistant 行**；等不到就交给兜底提示。谁来叫醒模型由编排层决定（见 wake-flow）。
 *
 * 因此这里的输出契约是：
 *   deliveries: { kind: 'wake' | 'fallback', rowId, anchorKey, stableKey, dedupKey, text, at }[]
 *     —— 内容永远只会是 assistant 的回复，或系统级兜底提示；内部 user 汇报行绝不出现。
 *        兜底提示也只对 Hermes 自己的 `[IMPORTANT: …]` 进程信封摘正文，
 *        委派完成信封 / 桥接自投递的提示词一律换成通用文案（见 isSummarizableNotice）。
 *   delegations: { rowId, anchorKey, stableKey, text, at }[]
 *     —— 仍在等模型转述的委派完成锚点（编排层据此自投递一次唤醒轮）。
 *        text 是 Hermes 写给 agent 的内部信封，编排层只允许从中抠 deleg id 做短引用，
 *        绝不能再把它拼进给模型的提示词（否则同一份报告会在会话上下文里堆两份）。
 * 其中 anchorKey 用于跨轮次去重（会话 id + 锚点行号）。
 *
 * ⚠️ 单靠 anchorKey（会话 id + 行号）不够：Hermes 压缩/改写 transcript 时会
 * **重新分配消息 id**（实测：同一条委派完成行从 64891 变成 64961，整段 +70）。
 * 游标还停在旧 id 上，于是整段已被投递过的内容会被当成新行重扫，同一个唤醒块
 * 换个行号又落进 deliveries —— 这就是「异步通知整段被投递两遍」的根因。
 * 为此每个块额外带两个**与行号无关**的稳定键（见 noticeRefOf/shortHash）：
 *   stableKey = 会话 id + 稳定标识（deleg_xxx / proc_xxx，取不到才退回通知首行哈希）
 *   dedupKey  = stableKey + 投递正文哈希
 * 编排层据此跨改写去重：stableKey 拦「同一个任务的通知/转述再投一次」，
 * dedupKey 再带上正文，避免把同一个进程的多次 watch_match 误merge成一条。
 */

import { createHash } from 'node:crypto';

/** Hermes 内部通知信封的固定前缀（tools/process_registry_notifications.py: format_process_notification） */
export const NOTICE_ENVELOPE_PREFIX = '[IMPORTANT:';
/** 异步委派完成行的 display_kind */
export const DELEGATION_DISPLAY_KIND = 'async_delegation_complete';
/** 委派完成信封首行的固定前缀（tools/process_registry_notifications.py: _format_batch_delegation/_format_async_delegation） */
export const DELEGATION_ENVELOPE_PREFIX = '[ASYNC DELEGATION';
/** 自投递内部轮次的 user 行标记（gateway/response_filters.py） */
export const INTERNAL_NOTIFICATION_DISPLAY_KIND = 'internal_notification';

const FALLBACK_NOTICE_MAX_CHARS = 300;

/** Hermes 的时间戳是秒（浮点），这里统一成毫秒；已经是毫秒的原样返回 */
export function toEpochMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1e12 ? n : n * 1000;
}

function contentOf(row) {
  const raw = row?.content;
  return typeof raw === 'string' ? raw : '';
}

/**
 * 从委派完成信封首行里抠出稳定的短标签（deleg_xxx）。
 *
 * 只给编排层的极简转述提示用一个引用锚，**绝不返回信封正文**：
 * 正文已经由 Hermes 原生写进会话上下文，任何地方都不该再复制一份（token 双份）。
 *
 * @param {string} noticeText
 * @returns {string} 取不到就返回空串
 */
export function delegationRefOf(noticeText) {
  const firstLine = String(noticeText ?? '').split('\n', 1)[0] ?? '';
  const match = /(deleg_[A-Za-z0-9]+)/.exec(firstLine);
  return match ? match[1] : '';
}

/**
 * 从任意内部通知正文里抠出稳定的任务标识（deleg_xxx / proc_xxx）。
 *
 * 取「先出现的那一个」：Hermes 的进程完成信封正文以 `Background process proc_xxx`
 * 开头（可能在后文附带 deleg 归属），委派完成信封则以 `[ASYNC DELEGATION … deleg_xxx]`
 * 开头；两种形状都取到各自真正的主标识。取消/取不到返回空串。
 *
 * 稳定性来源：这些 id 由 Hermes 生成、写在通知正文里，**不随 transcript 压缩
 * 重新分配的行号变化**，所以能跨改写去重（见文件头）。
 *
 * @param {string} noticeText
 * @returns {string}
 */
export function noticeRefOf(noticeText) {
  const match = /(deleg_[A-Za-z0-9]+|proc_[A-Za-z0-9]+)/.exec(String(noticeText ?? ''));
  return match ? match[1] : '';
}

/** 12 位短哈希：只用于去重键，不承载安全语义 */
export function shortHash(text) {
  return createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 12);
}

/**
 * 这条内部行的正文能不能安全地摘成一句人话给群友看？
 *
 * 只有 Hermes 自己的后台进程完成信封（`[IMPORTANT: …]`）可以 —— 它的首行是
 * "Background process proc_xxx completed normally"，本身就是给用户看的摘要。
 * 其余内部行（委派完成信封、桥接自投递的 internal_notification 提示词）正文是写给
 * agent 的上下文，摘出来就等于把内部机制泄漏给 QQ 端：兜底提示只能放通用文案。
 */
export function isSummarizableNotice(noticeText) {
  return String(noticeText ?? '').trimStart().startsWith(NOTICE_ENVELOPE_PREFIX);
}

/**
 * 会话 id → QQ 投递目标。
 *
 * 桥接的 Hermes 会话 id 形如：
 *   qq_group_1076958977_20260922_1        （业务日期 tag，rotationsPerDay=2 时带周期后缀）
 *   qq_private_3054039169_20260921_2_#03  （/new 轮换序号）
 * 去掉 sessionPrefix、轮换序号、日期 tag 后剩下的就是 executionKey
 * （contracts/messages.js: buildExecutionKey = `${messageType}_${id}`）。
 *
 * @param {string} sessionId
 * @param {string} [prefix]
 * @returns {{messageType: 'group'|'private', id: string}|null} 解析不出来返回 null
 */
export function parseSessionTarget(sessionId, prefix = 'qq_') {
  const raw = String(sessionId ?? '').trim();
  if (!raw.startsWith(prefix)) return null;

  let key = raw.slice(prefix.length);
  key = key.replace(/_#\d+$/, ''); // /new 轮换序号
  const withoutTag = key.replace(/_\d{8}(?:_\d+)?$/, ''); // 业务日期 tag（可带周期后缀）
  // 日期 tag 是桥接自己生成的一部分（sessionPrefix + executionKey + _tag）：
  // 没有 tag 的 id 不是桥接会话，宁可漏也不乱认领。
  if (withoutTag === key) return null;
  key = withoutTag;

  const match = /^(group|private)_(\d+)$/.exec(key);
  if (!match) return null;
  return { messageType: match[1] === 'group' ? 'group' : 'private', id: match[2] };
}

/**
 * 沿 parent_session_id 链回溯解析目标：压缩/轮换后子会话的 id 可能不再带桥接前缀，
 * 但它的祖先一定带。会话表里查不到祖先就返回 null（fail closed，不乱认领）。
 *
 * @param {string} sessionId
 * @param {object} opts
 * @param {Map<string, {parent_session_id?: string}>} opts.byId 本次列会话的结果
 * @param {string} [opts.prefix]
 * @param {number} [opts.maxDepth]
 */
export function resolveSessionTarget(sessionId, { byId, prefix = 'qq_', maxDepth = 8 } = {}) {
  let current = String(sessionId ?? '').trim();
  for (let depth = 0; depth <= maxDepth && current; depth++) {
    const target = parseSessionTarget(current, prefix);
    if (target) return target;
    current = String(byId?.get(current)?.parent_session_id ?? '').trim();
  }
  return null;
}

/**
 * 这一行是不是「分体投递」的锚点行？
 *   - 带 internal_notification 标记（Hermes 主动标记的内部轮次）；或
 *   - user 行且正文以内部通知信封开头（自投递唤醒轮没有 display_kind 标记时的兜底）。
 *     信封前缀由 Hermes 自己的 format_process_notification 生成，普通 QQ 消息不会长这样。
 */
export function isDetachedAnchorRow(row) {
  if (row?.display_kind === INTERNAL_NOTIFICATION_DISPLAY_KIND) return true;
  return row?.role === 'user' && contentOf(row).trimStart().startsWith(NOTICE_ENVELOPE_PREFIX);
}

/**
 * 这一行是不是「异步委派完成」行？
 * 它的正文是写给 agent 的重注入信封，不是给群友看的消息，只能作为转述锚点。
 *
 * 认两种形状：
 *   1. display_kind=async_delegation_complete（当前 Hermes 的标记）；
 *   2. user 行正文以 `[ASYNC DELEGATION` 开头（Hermes 换过/丢过标记时的兜底）。
 * 少了这层兜底，BATCH COMPLETE 这类报告行会掉进普通 notice 分支：
 * 一旦被反复结算，内部汇报就有机会被当成投递内容吐给 QQ。
 */
export function isDelegationRow(row) {
  if (row?.role !== 'user') return false;
  if (row.display_kind === DELEGATION_DISPLAY_KIND) return true;
  return contentOf(row).trimStart().startsWith(DELEGATION_ENVELOPE_PREFIX);
}

/** 信封正文 → 可读的一行摘要（兜底提示用） */
export function summarizeNotice(noticeText) {
  let text = String(noticeText ?? '').trim();
  if (text.startsWith(NOTICE_ENVELOPE_PREFIX)) text = text.slice(NOTICE_ENVELOPE_PREFIX.length);
  text = text.trim().replace(/\]$/, '');
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.length > FALLBACK_NOTICE_MAX_CHARS ? `${line.slice(0, FALLBACK_NOTICE_MAX_CHARS)}…` : line;
}

/** 不可摘要的内部行在兜底提示里显示的通用占位（绝不带内部正文） */
export const GENERIC_FALLBACK_SUMMARY = '后台任务已结束，但没能生成可转述的回复';

/**
 * 渲染兜底提示。
 *
 * @param {string} noticeText 锚点行正文（内部行）
 * @param {string} template    形如 "⚠️ …\n{notice}"
 * @param {object} [opts]
 * @param {boolean} [opts.summarize=true] false = 不摘取内部正文，改用通用占位
 *        （委派完成信封 / 桥接自投递提示词这类行必须传 false）
 */
export function renderFallbackNotice(noticeText, template, { summarize = true } = {}) {
  const summary = (summarize ? summarizeNotice(noticeText) : '') || GENERIC_FALLBACK_SUMMARY;
  return String(template ?? '{notice}').replace('{notice}', summary).trim();
}

/**
 * 从一页 transcript 里切出待投递的分体通知。
 *
 * 游标语义（关键，勿改坏）：
 *   - 只处理 id > lastRowId 的行；
 *   - 未闭合的唤醒块（还没等到闭合的 user 行）默认**不投递**，并把 nextRowId 停在
 *     锚点行之前 —— 下一跳会重新读到它，等 assistant 回复落地后一起投递；
 *   - 调用方在确认该块已"稳定"（连续两跳内容不变）后传 emitOpenBlocks=true，
 *     此时闭合与否都投递，游标一次性推到最后一行；
 *   - 超过 maxAgeMs 的旧通知只推进游标、不投递（防止重启后补发几小时前的结果）。
 *
 * @param {object[]} messages  GET /api/sessions/{id}/messages 的 data
 * @param {object} opts
 * @param {string} [opts.sessionId]
 * @param {number} [opts.lastRowId=0]
 * @param {number} [opts.now=Date.now()]
 * @param {number} [opts.maxAgeMs=1800000]   <=0 表示不限制
 * @param {boolean} [opts.emitOpenBlocks=false]
 * @param {number} [opts.fallbackAfterMs=600000]
 * @param {string} [opts.fallbackNotice]
 * @returns {{
 *   deliveries: Array<{kind: string, rowId: number, anchorKey: string, stableKey: string, dedupKey: string, text: string, at: number}>,
 *   delegations: Array<{rowId: number, anchorKey: string, stableKey: string, text: string, at: number}>,
 *   nextRowId: number,
 *   openBlock: null | {anchorRowId: number, anchorKey: string, kind: string, partCount: number, at: number}
 * }}
 */
export function extractDetachedDeliveries(messages, opts = {}) {
  const {
    sessionId = '',
    lastRowId = 0,
    now = Date.now(),
    maxAgeMs = 1800000,
    emitOpenBlocks = false,
    fallbackAfterMs = 600000,
    fallbackNotice = '{notice}',
  } = opts;

  const rows = (Array.isArray(messages) ? messages : [])
    .filter((row) => Number.isFinite(Number(row?.id)))
    .slice()
    .sort((a, b) => Number(a.id) - Number(b.id));

  const deliveries = [];
  /** 仍在等模型转述的委派完成锚点（内部 user 汇报行绝不直接投递） */
  const delegations = [];
  const fresh = (at) => maxAgeMs <= 0 || !at || now - at <= maxAgeMs;
  const anchorKeyOf = (rowId) => `${sessionId}#${rowId}`;
  /**
   * 与行号无关的稳定块标识：优先用通知里的 deleg_/proc_ id；
   * 退而求其次用「通知首个非空行」的哈希（同一个块在改写前后内容一致）。
   */
  const stableKeyOf = (notice) => {
    const ref = noticeRefOf(notice);
    if (ref) return `${sessionId}#${ref}`;
    const firstLine = String(notice ?? '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
    return `${sessionId}#h${shortHash(firstLine)}`;
  };
  /** stableKey + 投递正文哈希：正文归一化空白，跨 \r\n 改写也稳定 */
  const dedupKeyOf = (notice, text) =>
    `${stableKeyOf(notice)}#${shortHash(String(text ?? '').replace(/\s+/g, ' ').trim())}`;
  const delegationOf = (anchorRowId, text, at) => ({
    rowId: anchorRowId,
    anchorKey: anchorKeyOf(anchorRowId),
    // 转述唤醒用稳定键：改写后行号变了也不会再叫醒一次
    stableKey: stableKeyOf(text),
    text,
    at,
  });

  let consumed = Number(lastRowId) || 0;
  let open = null;
  let lastRow = null;

  const flush = (block, { fallbackAllowed }) => {
    const text = block.parts.join('\n').trim();
    if (text) {
      if (fresh(block.at)) {
        deliveries.push({
          kind: 'wake',
          rowId: block.anchorRowId,
          anchorKey: anchorKeyOf(block.anchorRowId),
          stableKey: stableKeyOf(block.notice),
          dedupKey: dedupKeyOf(block.notice, text),
          text,
          at: block.at,
        });
      }
      return;
    }
    // 唤醒轮没有产出可见回复（模型静默 / 轮次失败）：到点给一条兜底提示。
    // 兜底提示绝不能把内部行的正文原样吐给 QQ（见 isSummarizableNotice）：
    // 委派完成信封、桥接自投递的提示词都只允许换成通用占位。
    if (fallbackAllowed && fallbackAfterMs > 0 && block.at && now - block.at >= fallbackAfterMs) {
      if (fresh(block.at) || maxAgeMs <= 0) {
        const fallbackText = renderFallbackNotice(block.notice, fallbackNotice, {
          summarize: isSummarizableNotice(block.notice),
        });
        deliveries.push({
          kind: 'fallback',
          rowId: block.anchorRowId,
          anchorKey: anchorKeyOf(block.anchorRowId),
          stableKey: stableKeyOf(block.notice),
          // 兜底提示正文可能对多个进程是同一句通用文案，但 stableKey（proc id）不同，
          // 所以不会互相顶掉；同一个进程的兜底重复出现才会被去重。
          dedupKey: dedupKeyOf(block.notice, fallbackText),
          text: fallbackText,
          at: block.at,
        });
      }
    }
  };

  for (const row of rows) {
    const id = Number(row.id);
    lastRow = row;
    if (id <= (Number(lastRowId) || 0)) continue;
    const at = toEpochMs(row.timestamp);

    if (row.role === 'user') {
      if (open) {
        // 被下一轮用户消息闭合 → 轮次确定已结束。注意这里**不**推进 consumed：
        // 闭合行本身可能又是一条唤醒锚点（两个后台任务前后脚结束），
        // 推进了就会把新块整块跳过。
        // 例外：委派块被**另一条委派完成行**闭合、且没等到任何 assistant 行时，
        // 它的转述还没人管，补登记成待转述锚点（否则前一条会被静默丢掉）。
        const unrelayed = open.kind === 'delegation' && open.parts.length === 0 && isDelegationRow(row);
        flush(open, { fallbackAllowed: false });
        if (unrelayed) delegations.push(delegationOf(open.anchorRowId, open.notice, open.at));
        open = null;
      }
      if (isDelegationRow(row)) {
        const text = contentOf(row).trim();
        if (text && fresh(at)) {
          // 只作为锚点：等模型转述（内部汇报行永不进 deliveries）。
          // 不推进 consumed：转述落地前游标停在锚点之前，下一跳重读。
          open = { anchorRowId: id, notice: text, parts: [], at, kind: 'delegation' };
        } else {
          consumed = id; // 过期 / 空正文：直接吞掉
        }
        continue;
      }
      if (isDetachedAnchorRow(row)) {
        open = { anchorRowId: id, notice: contentOf(row), parts: [], at, kind: 'notice' };
        continue;
      }
      open = null;
      consumed = id;
      continue;
    }

    if (row.role === 'assistant' && open) {
      const text = contentOf(row).trim();
      if (text) open.parts.push(text);
      continue; // 块内行不推进游标：整块要么一起投递，要么整块留在游标之后
    }

    // 其它行（tool / system）：块外的行可以安全推进游标
    if (!open) consumed = id;
  }

  let openBlock = null;
  if (open) {
    const hasText = open.parts.some((part) => part.trim().length > 0);
    const stale = maxAgeMs > 0 && open.at > 0 && now - open.at > maxAgeMs;
    const fallbackDue =
      fallbackAfterMs > 0 && open.at > 0 && now - open.at >= fallbackAfterMs;

    if (stale) {
      // 太旧了：既不投递也不等待，直接推到底（防重启后拿几小时前的块反复纠缠）
      consumed = lastRow ? Number(lastRow.id) : open.anchorRowId;
    } else if (emitOpenBlocks && (hasText || fallbackDue)) {
      // 块已稳定，或已经等到兜底时间：结算并一次性推到底
      flush(open, { fallbackAllowed: true });
      // 兜底提示投递后如果模型回复迟到，由 anchorKey 去重规则兜住（见 wake-flow）。
      consumed = lastRow ? Number(lastRow.id) : open.anchorRowId;
    } else {
      // 还没稳定 / 还没到兜底时间：留在游标之后，下一跳重读
      openBlock = {
        anchorRowId: open.anchorRowId,
        anchorKey: anchorKeyOf(open.anchorRowId),
        kind: open.kind,
        partCount: open.parts.length,
        at: open.at,
      };
      // 委派完成行还在等模型转述：Hermes 自己不会为它起唤醒轮（见文件头），
      // 把锚点原样交出去，由编排层决定怎么叫醒模型。
      if (open.kind === 'delegation' && !hasText) {
        delegations.push(delegationOf(open.anchorRowId, open.notice, open.at));
      }
    }
  }

  return { deliveries, delegations, nextRowId: consumed, openBlock };
}
