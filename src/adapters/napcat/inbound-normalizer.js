/**
 * adapters/napcat/inbound-normalizer.js — NapCat 原始事件 → InboundMessage
 *
 * 这是 v2 里唯一知道 NapCat 字段长什么样的地方。之后的所有代码只见 InboundMessage。
 *
 * 覆盖的旧 Bridge 行为（bridge.js:1135-1497）：
 *   - post_type 过滤、自身消息过滤
 *   - 真 @ 判定、名字呼唤判定、wakeMode
 *   - textOnly / cmdText 派生
 *   - 图片下载并挂本地绝对路径（附录 2）
 *   - 文件下载 + 文本内容摘要
 *   - 引用消息（[CQ:reply,id=…]）拉取原消息、原消息里的图片与文件
 *   - 面向模型的 content 组装：引用前置、文件摘要前置、@机器人转成 " @瑞姬 "
 */

import {
  createInboundMessage,
  MESSAGE_TYPES,
  buildSessionId,
  buildExecutionKey,
} from '../../contracts/messages.js';
import { validateNapcatEvent } from '../../contracts/schemas/index.js';
import {
  parseCqMessage,
  parseCqParams,
  stripCqCodes,
  cqToReadableText,
  annotateCqCodes,
  segmentsToText,
  renderAtMention,
  AT_CQ_SOURCE,
} from './cq.js';

/**
 * 用 QQ 号拼 at 码正则。号码本该是纯数字，但配置没有格式校验，转义一下不亏。
 *
 * 已知局限：假设 qq= 紧跟在 CQ:at, 后面。OneBot 并不保证参数顺序，
 * 若协议端发出 `[CQ:at,name=瑞姬,qq=<bot>]`，这里会漏判 —— 正文渲染有
 * cq.js:renderAtMention 兜底（照样渲染成 @瑞姬），但 isAtBot 会是 false、唤醒会漏。
 * 现网 NapCat 始终是 qq 在前，改成参数解析会牵动唤醒判定，留待单独验证。
 */
function buildAtRegex(qq, flags = 'i') {
  const escaped = String(qq ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(String.raw`\[CQ:at,qq=` + escaped + String.raw`[^\]]*\]`, flags);
}

/** 归一化后被丢弃的原因，供日志与影子对照使用 */
export const DROP_REASONS = Object.freeze({
  NOT_MESSAGE: 'not_a_message_event',
  INVALID: 'invalid_event',
  SELF: 'self_message',
  EMPTY: 'empty_content',
});

export class InboundNormalizer {
  /**
   * @param {object} opts
   * @param {object} opts.identity  { ownerId, robotId, botName }
   * @param {object} opts.wake      { mode, namePattern }
   * @param {import('./media-ingestor.js').MediaIngestor} [opts.mediaIngestor]
   * @param {import('./napcat-api.js').NapcatApi} [opts.napcatApi]
   * @param {import('../../core/logger.js').Logger} [opts.logger]
   */
  constructor(opts = {}) {
    this.identity = opts.identity;
    this.wakeMode = opts.wake?.mode ?? 'both';
    this.namePattern = new RegExp(opts.wake?.namePattern ?? '(^|[\\s，,。.!！?？~、；;:：])瑞姬');
    this.media = opts.mediaIngestor ?? null;
    this.api = opts.napcatApi ?? null;
    this.log = opts.logger?.child({ component: 'normalizer' }) ?? console;
  }

  /**
   * @param {object} rawEvent  NapCat WebSocket 推送的原始 JSON
   * @param {{ correlationId?: string, signal?: AbortSignal }} [ctx]
   * @returns {Promise<{ message: object|null, dropped: string|null }>}
   */
  async normalize(rawEvent, ctx = {}) {
    if (rawEvent?.post_type !== 'message') {
      return { message: null, dropped: DROP_REASONS.NOT_MESSAGE };
    }

    const check = validateNapcatEvent(rawEvent);
    if (!check.valid) {
      this.log.warn('NapCat 事件不合法，已丢弃', { errors: check.errors });
      return { message: null, dropped: DROP_REASONS.INVALID };
    }

    const userId = String(rawEvent.user_id);
    if (userId === String(this.identity.robotId)) {
      return { message: null, dropped: DROP_REASONS.SELF };
    }

    const messageType = rawEvent.message_type === 'group' ? MESSAGE_TYPES.GROUP : MESSAGE_TYPES.PRIVATE;
    const groupId = rawEvent.group_id == null ? null : String(rawEvent.group_id);
    const rawMessage = String(rawEvent.raw_message ?? '');
    const targetId = messageType === MESSAGE_TYPES.GROUP ? groupId : userId;

    // NapCat 的 message_id 有时缺失，旧 Bridge 用 message_seq/time 兜底（bridge.js:1167）
    const messageId = String(
      rawEvent.message_id ?? rawEvent.message_seq ?? rawEvent.time ?? `${userId}_${Date.now()}`,
    );

    const sender = normalizeSender(rawEvent.sender, userId);
    const segments = this._parseSegments(rawEvent, rawMessage);
    const text = stripCqCodes(rawMessage) || segmentsToText(rawEvent.message);

    // 群消息原文含聊天内容，只在 debug 级留，且不整条 dump 进日志文件
    this.log.debug?.('群消息片段', {
      segmentTypes: segments.map((s) => s.type),
      rawLength: rawMessage.length,
    });

    const isAtBot =
      buildAtRegex(this.identity.robotId).test(rawMessage) ||
      segments.some(
        (s) => s.type === 'at' && String(s.data?.qq) === String(this.identity.robotId),
      );
    const isNameCall = this.namePattern.test(text);

    // 媒体落盘（附录 2）：图片与文件都拿到本地绝对路径
    const media = await this._ingestMedia(segments, { groupId, signal: ctx.signal });

    // 引用消息：拉原消息，连带其中的图片与文件
    const quote = await this._resolveQuote(segments, rawMessage, { groupId, signal: ctx.signal });
    if (quote?.media?.length) media.push(...quote.media);

    const content = this._buildContent({ rawMessage, quote, media, isAtBot });

    const message = createInboundMessage({
      correlationId: ctx.correlationId,
      messageId,
      timestamp: normalizeTimestamp(rawEvent.time),
      platform: 'qq',
      selfId: String(rawEvent.self_id ?? this.identity.robotId),
      userId,
      groupId,
      sessionId: buildSessionId('qq', messageType, targetId),
      executionKey: buildExecutionKey(messageType, targetId),
      messageType,
      rawMessage,
      text,
      content,
      segments,
      sender,
      flags: {
        isSelf: false,
        isOwner: userId === String(this.identity.ownerId),
        isAtBot,
        isNameCall,
        isCommand: false, // 由 command-flow 判定后回填
        hasImage: media.some((m) => m.kind === 'image'),
        hasFile: media.some((m) => m.kind === 'file'),
        hasQuote: Boolean(quote),
      },
      media,
      extensions: {
        napcat: {
          postType: rawEvent.post_type,
          subType: rawEvent.sub_type ?? null,
          messageSeq: rawEvent.message_seq ?? null,
          font: rawEvent.font ?? null,
        },
        quote: quote ? { summary: quote.summary, sourceMessageId: quote.messageId } : null,
      },
    });

    if (!message.content) return { message: null, dropped: DROP_REASONS.EMPTY };
    return { message, dropped: null };
  }

  /**
   * 唤醒判定的纯文本部分。裁决是否真的回复由 decision-flow 负责，
   * 这里只回答"消息里有没有在叫机器人"。
   */
  isWake({ isAtBot, isNameCall }) {
    if (this.wakeMode === 'at') return isAtBot;
    if (this.wakeMode === 'name') return isNameCall;
    return isAtBot || isNameCall;
  }

  /**
   * 优先用 NapCat 的 message 数组（message_format=array），
   * 没有再退回解析 raw_message 字符串。
   * 旧 Bridge 只在引用消息分支处理过数组格式，主分支纯靠 raw_message（bridge.js:1331-1348）。
   */
  _parseSegments(rawEvent, rawMessage) {
    if (Array.isArray(rawEvent.message) && rawEvent.message.length) {
      return rawEvent.message.map((seg) => ({
        type: String(seg?.type ?? 'unknown').toLowerCase(),
        data: seg?.data ?? {},
        raw: null,
      }));
    }
    return parseCqMessage(rawMessage);
  }

  async _ingestMedia(segments, { groupId, signal }) {
    if (!this.media) return [];
    const out = [];
    for (const seg of segments) {
      try {
        if (seg.type === 'image') {
          const item = await this.media.ingestImage(seg.data, { signal });
          if (item) out.push(item);
        } else if (seg.type === 'mface') {
          // QQ 商城表情（LLBOT/NapCat 的 mface 段）。data.url 是 raw*.gif 直链，
          // 走同一条图片管线；summary（如 "[摸头]"）是现成的标签线索，
          // 剥掉方括号挂到 label 上，表情包收集入库时当初始标签。
          const item = await this.media.ingestImage(seg.data, { signal });
          if (item) {
            item.label = String(seg.data?.summary ?? '').replace(/^\[+|\]+$/g, '').trim() || null;
            out.push(item);
          }
        } else if (seg.type === 'file' || seg.type === 'offline_file') {
          out.push(await this.media.ingestFile(seg.data, { groupId, signal }));
        }
      } catch (err) {
        this.log.warn('媒体处理失败，已跳过该片段', { type: seg.type, error: err.message });
      }
    }
    return out;
  }

  /**
   * 解析 [CQ:reply,id=…]，拉取被引用的原消息。
   * 旧实现见 bridge.js:1359-1473。
   */
  async _resolveQuote(segments, rawMessage, { groupId, signal }) {
    const replySeg = segments.find((s) => s.type === 'reply');
    const replyId = replySeg?.data?.id ?? extractReplyIdFromRaw(rawMessage);
    if (!replyId) return null;

    const inlineText = replySeg?.data?.text
      ? String(replySeg.data.text).replace(/\[CQ:image[^\]]*\]/g, '[图片]')
      : '';

    if (!this.api) {
      return inlineText ? { messageId: replyId, summary: `[引用消息: ${inlineText}]`, media: [] } : null;
    }

    let original;
    try {
      original = await this.api.getMsg(replyId);
    } catch (err) {
      this.log.warn('引用消息拉取失败', { replyId, error: err.message });
      return inlineText ? { messageId: replyId, summary: `[引用消息: ${inlineText}]`, media: [] } : null;
    }
    if (!original) {
      return inlineText ? { messageId: replyId, summary: `[引用消息: ${inlineText}]`, media: [] } : null;
    }

    const quotedNick =
      original.sender?.card || original.sender?.nickname || original.sender?.user_id || '未知';

    const quotedSegments = Array.isArray(original.message)
      ? original.message.map((s) => ({ type: String(s?.type ?? '').toLowerCase(), data: s?.data ?? {} }))
      : parseCqMessage(String(original.message ?? original.raw_message ?? inlineText ?? ''));

    const quotedText = Array.isArray(original.message)
      ? segmentsToText(original.message)
      : annotateCqCodes(String(original.message ?? original.raw_message ?? inlineText ?? ''));

    const media = await this._ingestMedia(quotedSegments, { groupId, signal });
    const fileSummaries = media
      .filter((m) => m.kind === 'file' && m.summary)
      .map((m) => m.summary)
      .join('\n');

    let summary = '';
    if (quotedText) {
      summary = `[引用 ${quotedNick} 的消息: ${quotedText}]`;
      if (fileSummaries) summary += `\n${fileSummaries}`;
    } else if (fileSummaries) {
      summary = `[引用 ${quotedNick} 发送的文件]:\n${fileSummaries}`;
    } else if (inlineText) {
      summary = `[引用消息: ${inlineText}]`;
    }

    return summary ? { messageId: replyId, summary, media } : null;
  }

  /**
   * 组装面向模型的正文。顺序与旧 Bridge 一致：
   * 引用摘要 → 文件摘要 → 正文（@机器人转文字、其余 @ 剔除）
   */
  _buildContent({ rawMessage, quote, media, isAtBot = false }) {
    let clean = rawMessage
      .replace(/\[CQ:image,[^\]]*\]/g, '')
      .replace(/\[CQ:file,[^\]]*\]/g, '')
      .replace(/\[CQ:reply,[^\]]*\]/g, '')
      .trim();

    if (quote?.summary) clean = `${quote.summary} ${clean}`.trim();

    const fileSummaries = media
      .filter((m) => m.kind === 'file' && m.summary && !quote?.media?.includes(m))
      .map((m) => m.summary)
      .join('\n');
    if (fileSummaries) clean = `${fileSummaries}\n${clean}`.trim();

    // 保留对机器人的 @，转成文本让模型看得见。
    // 前后的空白一并吸收再补回单个空格，否则 "[@机器人] [@某人]" 会渲染出双空格。
    const botName = this.identity.botName ?? '瑞姬';
    const botAt = buildAtRegex(this.identity.robotId, 'gi');
    clean = clean.replace(new RegExp(`[ \\t]*(?:${botAt.source})[ \\t]*`, 'gi'), ` @${botName} `);
    // 其余 @ 码转成 @昵称 / @QQ / @全体成员（渲染与净化统一在 cq.js:renderAtMention）。
    // 尾随的 [ \t]* 是 OneBot 客户端在 @ 后自动补的空格，吸掉避免正文出现双空格。
    clean = clean
      .replace(new RegExp(`${AT_CQ_SOURCE}[ \\t]*`, 'gi'), (_match, paramStr) => {
        const mention = renderAtMention(parseCqParams(paramStr));
        return mention ? `${mention} ` : '';
      })
      .trim();
    // 其余 CQ 码（face 等）转成可读标注，不让裸 CQ 进 Prompt
    clean = annotateCqCodes(clean);

    if (!clean) {
      if (media.some((m) => m.kind === 'file')) return '[文件消息]';
      if (media.some((m) => m.kind === 'image')) return '[图片消息]';
      if (isAtBot) return `@${botName}`;
    }
    return clean;
  }
}

/**
 * 命令文本：从 textOnly 剥掉开头的名字呼唤。
 * 迁移自 bridge.js:1495-1497 —— 用 clean 会因为 @ 被转成 " @瑞姬 " 而漏掉命令。
 */
export function deriveCommandText(text, botName = '瑞姬') {
  const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(text ?? '')
    .replace(new RegExp(`^(?:${escaped}|@${escaped})[\\s，,。.!！?？~、；;:：]*`), '')
    .trim();
}

function normalizeSender(sender, fallbackId) {
  const nickname = String(sender?.nickname ?? '');
  const card = String(sender?.card ?? '');
  return {
    nickname,
    card,
    // card || nickname || uid —— 旧 bridge.js:1256 的显示名规则
    displayName: card || nickname || String(fallbackId),
  };
}

/** OneBot time 可能是秒也可能是毫秒；统一成秒 */
function normalizeTimestamp(time) {
  const n = Number(time);
  if (!Number.isFinite(n) || n <= 0) return Math.floor(Date.now() / 1000);
  return n >= 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

function extractReplyIdFromRaw(rawMessage) {
  const m = /\[CQ:reply,id=(-?\d+)/.exec(String(rawMessage ?? ''));
  return m ? m[1] : null;
}

/** 从 raw_message 与 segments 中提取被 @ 的用户（/好感度 @某人 命令要用） */
export function extractAtTargets(rawMessage, segments = []) {
  const out = new Set();
  // 用 cq.js 的统一 at 正则：参数顺序不由协议保证，写死 qq= 开头会漏掉 [CQ:at,name=x,qq=1]
  const re = new RegExp(AT_CQ_SOURCE, 'gi');
  let m;
  const rawStr = String(rawMessage ?? '');
  while ((m = re.exec(rawStr)) !== null) {
    const qq = parseCqParams(m[1]).qq;
    if (qq && /^\d+$/.test(qq)) out.add(qq);
  }
  if (Array.isArray(segments)) {
    for (const seg of segments) {
      if (seg?.type === 'at' && seg.data?.qq) {
        out.add(String(seg.data.qq));
      }
    }
  }
  return Array.from(out);
}

export { parseCqParams };
