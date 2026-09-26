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
 *
 * 有意偏离旧 Bridge 的一点（2026-09 群聊媒体收敛）：**群聊只在被 @ 机器人、叫了
 * 机器人名字或引用了机器人自己的消息时才落盘媒体**。旧实现是"收到就下载"，群里
 * 任何人发的图/文件都会被无差别拉到本地；现在路过消息只登记 deferred 描述符
 * （localPath=null + fileId），模型需要时用 download_group_file /
 * download_chat_file / get_image_detail 主动拉取。私聊行为不变（照旧全收）。
 */

import {
  createInboundMessage,
  MESSAGE_TYPES,
  buildSessionId,
  buildExecutionKey,
} from '../../contracts/messages.js';
import { validateNapcatEvent } from '../../contracts/schemas/index.js';
import { getIdentityRole } from '../../core/permission-policy.js';
import { isSeeCommand } from '../../core/see-command.js';
import {
  parseCqMessage,
  parseCqParams,
  stripCqCodes,
  cqToReadableText,
  annotateCqCodes,
  segmentsToText,
  renderAtMention,
  sanitizeMentionName,
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
   *   没有时视为"不落盘"：群聊唤醒消息的媒体会被静默跳过（生产环境总是注入了）
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
    const text = stripCqCodes(rawMessage) || segmentsToText(rawEvent.message) || annotateCqCodes(rawMessage);

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

    // 本条消息 @ 了哪些"不是瑞姬"的对象（@某个 bot / @某人 / @全体成员）。
    // 命令定向门禁（command-flow.isCommandTargetedAtBot）靠它区分"发给别人的 /stop"
    // 和"发给瑞姬的 /stop"。算在这一层是因为 @ 码/segment 解析只属于 adapters/napcat，
    // 编排层只读契约字段（架构职责分层）。
    const isAtOthers = extractAtTargets(rawMessage, segments).some(
      (id) => String(id) !== String(this.identity.robotId),
    );

    // 引用消息：先只解析来源（必要时发一次 get_msg），拿到"引用的是不是机器人
    // 自己"之后才能决定本条消息的媒体要不要落盘（见 _shouldIngestMedia）。
    const quoteSource = await this._resolveQuoteSource(segments, rawMessage, { signal: ctx.signal });

    // /see 显式指令：本条正文或引用正文带 /see 时，即便群里没被 @ 也预先把图落盘——
    // 渲染层（prompt-renderer）要用本地绝对路径引导模型调识图工具读图，没有本地
    // 副本的话隔离指令就落空了。命中判定统一在 core/see-command.js。
    const seeCommand = isSeeCommand(
      {
        text,
        content: text,
        extensions: { quote: quoteSource?.quotedText ? { summary: quoteSource.quotedText } : null },
      },
      { botName: this.identity.botName },
    );

    // 媒体落盘策略（附录 2 + 2026-09 群聊收敛）：私聊照旧全收；群聊只在被唤醒
    // （@ 机器人 / 叫机器人名字）、引用了机器人自己的消息或显式 /see 时落盘。群里
    // 普通路过的图片/文件只登记"未下载"描述符，需要时由模型用 download_group_file /
    // download_chat_file / get_image_detail 主动拉取。
    const ingest = this._shouldIngestMedia({
      messageType,
      isAtBot,
      isNameCall,
      quoteIsBot: quoteSource?.isBot === true,
      seeCommand,
    });

    const media = ingest
      ? await this._ingestMedia(segments, { groupId, signal: ctx.signal })
      : this._deferredMediaOf(segments);

    // 归属标注：本条消息自带的媒体，作者就是发送者。渲染层据此在每张图
    // 紧前面插一行说明牌（prompt-renderer.renderUserMessage），模型才能
    // 区分"发送者的图"和"引用消息里转发的图"。
    for (const item of media) {
      item.origin = 'message';
      item.originAuthor = sender.displayName;
    }

    const quote = quoteSource
      ? await this._finishQuote(quoteSource, { groupId, signal: ctx.signal, ingest })
      : null;
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
        isAdmin: getIdentityRole(userId, this.identity) === 'admin',
        role: getIdentityRole(userId, this.identity),
        isAtBot,
        isNameCall,
        isAtOthers,
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
        } else if (seg.type === 'mface' || seg.type === 'marketface') {
          // QQ 商城表情（LLBOT/NapCat 的 mface / marketface 段）。data.url 是
          // raw*.gif 直链，走同一条图片管线；summary（如 "[摸头]"）是现成的
          // 标签线索，剥掉方括号挂到 label 上，表情包收集入库时当初始标签。
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
   * 群聊媒体落盘策略。
   *
   * 落盘不是零成本的：写硬盘、向 NapCat 换取直链、必要时从腾讯 CDN 拉整个文件。
   * 群聊里绝大多数消息都只是"路过"，与机器人无关，不该为它们付这笔钱；
   * 只有这条消息真的会被机器人看到时才值得预先备好本地副本：
   *   - 私聊：全部落盘（与改动前一致）；
   *   - 群聊里 @ 了机器人 / 叫了机器人名字：落盘；
   *   - 群聊引用了机器人自己的消息：落盘（被引用的原消息里也可能带图/文件）；
   *   - 群聊显式 /see：落盘（用户要求隔离出上下文让模型读本地文件打标）。
   * 其余群聊消息只产出 deferred 描述符（见 _deferredMediaOf）。
   *
   * 这里刻意**不看 wake.mode**：@ 在 decision-flow 里是硬优先级（at_overrides_
   * provider_ignore），名字提及也会拿到 KEYWORD 交互情境提示，裁决者照样可能
   * 判 direct——两者都可能真的被回复。按 wake.mode 卡落盘会出现"瑞姬已经准备
   * 回这条了，却看不到消息里的图"。
   */
  _shouldIngestMedia({ messageType, isAtBot, isNameCall, quoteIsBot, seeCommand }) {
    if (messageType !== MESSAGE_TYPES.GROUP) return true;
    return isAtBot === true || isNameCall === true || quoteIsBot === true || seeCommand === true;
  }

  /**
   * 不落盘时的媒体描述符。
   *
   * 结构仍是标准 media item（kind / url / localPath / origin），只是 localPath
   * 为 null、deferred 为 true，并补上 fileId / busid 让模型能用 QQ 工具回捞。
   * 不下载、不发请求、不写硬盘——纯本地字段整理。
   */
  _deferredMediaOf(segments) {
    const out = [];
    for (const seg of segments ?? []) {
      const data = seg?.data ?? {};
      if (seg.type === 'image' || seg.type === 'mface' || seg.type === 'marketface') {
        const item = {
          kind: 'image',
          localPath: null,
          url: data.url ? String(data.url) : null,
          fileId: mediaFileIdOf(data),
          mime: null,
          name: null,
          sizeBytes: positiveNumberOrNull(data.file_size ?? data.size),
          deferred: true,
        };
        if (seg.type === 'mface' || seg.type === 'marketface') {
          // 与落盘路径同款：summary（如 "[摸头]"）剥掉方括号当初始标签
          item.label = String(data.summary ?? '').replace(/^\[+|\]+$/g, '').trim() || null;
        }
        out.push(item);
      } else if (seg.type === 'file' || seg.type === 'offline_file') {
        const name = mediaNameOf(data);
        const sizeBytes = positiveNumberOrNull(data.file_size ?? data.size);
        out.push({
          kind: 'file',
          localPath: null,
          url: data.url ? String(data.url) : null,
          fileId: mediaFileIdOf(data),
          busid: positiveNumberOrNull(data.busid) ?? 102,
          name,
          sizeBytes,
          deferred: true,
          summary: `[收到文件: ${name}${sizeBytes ? ` (${(sizeBytes / 1024).toFixed(1)}KB)` : ''}，未下载]`,
        });
      }
    }
    return out;
  }

  /**
   * 解析 [CQ:reply,id=…] 的第一阶段：只回答"引用了哪条消息、原作者是谁"，
   * 不落盘任何媒体。落盘策略依赖 quoteIsBot，所以必须与媒体处理拆开两段走。
   * 旧实现见 bridge.js:1359-1473；返回 null 表示这条消息没有引用。
   *
   * @returns {Promise<{replyId: string, inlineText: string, quotedNick: string|null,
   *   isBot: boolean, quotedSegments: object[], quotedText: string}|null>}
   */
  async _resolveQuoteSource(segments, rawMessage, { signal } = {}) {
    const replySeg = segments.find((s) => s.type === 'reply');
    const replyId = replySeg?.data?.id ?? extractReplyIdFromRaw(rawMessage);
    if (!replyId) return null;

    const inlineText = replySeg?.data?.text
      ? String(replySeg.data.text).replace(/\[CQ:image[^\]]*\]/g, '[图片]')
      : '';
    const unresolved = {
      replyId,
      inlineText,
      quotedNick: null,
      isBot: false,
      quotedSegments: [],
      quotedText: '',
    };

    if (!this.api) return unresolved;

    let original;
    try {
      original = await this.api.getMsg(replyId);
    } catch (err) {
      this.log.warn('引用消息拉取失败', { replyId, error: err.message });
      return unresolved;
    }
    if (!original) return unresolved;

    // 引用作者名是群成员可控文本（群名片），进 Prompt 前过 at 昵称同款净化
    const quotedNick =
      sanitizeMentionName(original.sender?.card || original.sender?.nickname || original.sender?.user_id) || '未知';
    // 引用的是不是机器人自己发的：是的话归属标注要能说出"这是你自己之前发的图"，
    // 否则模型会把自己发出的表情包误读成对方发来的嘲讽（2026-09-10 杂鱼图案例）
    const isBot = String(original.sender?.user_id ?? '') === String(this.identity.robotId);

    const quotedSegments = Array.isArray(original.message)
      ? original.message.map((s) => ({ type: String(s?.type ?? '').toLowerCase(), data: s?.data ?? {} }))
      : parseCqMessage(String(original.message ?? original.raw_message ?? inlineText ?? ''));

    const quotedText = Array.isArray(original.message)
      ? segmentsToText(original.message)
      : annotateCqCodes(String(original.message ?? original.raw_message ?? inlineText ?? ''));

    return { replyId, inlineText, quotedNick, isBot, quotedSegments, quotedText };
  }

  /**
   * 引用的第二阶段：接上媒体（落盘或只登记描述符）并合成摘要。
   */
  async _finishQuote(source, { groupId, signal, ingest }) {
    const { replyId, inlineText, quotedNick, isBot, quotedSegments, quotedText } = source;
    const media = ingest
      ? await this._ingestMedia(quotedSegments, { groupId, signal })
      : this._deferredMediaOf(quotedSegments);

    for (const item of media) {
      item.origin = 'quote';
      item.originAuthor = isBot ? (this.identity.botName || quotedNick || '你') : (quotedNick ?? '未知');
      item.originIsBot = isBot;
    }
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
    } else {
      // 防御：原文取不到文本，但媒体已经落盘（如商城表情 mface/marketface、
      // 图片没有可读标签）时，仍要合成一句引用摘要。否则 summary 为空 → 返回
      // null → 外层把已经下载好的 quote.media 整块丢掉（引用图“凭空消失”）。
      const imgLabels = media
        .filter((m) => m.kind === 'image')
        .map((m) => (m.label ? `[动画表情: ${m.label}]` : '[图片]'))
        .join(' ');
      if (imgLabels) summary = `[引用 ${quotedNick} 的消息: ${imgLabels || '[图片]'}]`;
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
      .replace(/\[CQ:(?:mface|marketface)[^\]]*\]/gi, '')
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

/** 图片/文件片段的回捞标识：file_id 优先，其次 file（NapCat 图片常用 file 当标识） */
function mediaFileIdOf(data) {
  const id = data?.file_id ?? data?.fileId ?? data?.file;
  return id == null || id === '' ? null : String(id);
}

/** 文件名：name / file_name 优先，file 是路径或纯文件名时取末段 */
function mediaNameOf(data) {
  const explicit = data?.name || data?.file_name;
  if (explicit) return String(explicit);
  const raw = String(data?.file ?? '');
  if (raw && !/^https?:/i.test(raw)) return raw.split(/[\\/]/).pop() || raw;
  return `file_${Date.now()}`;
}

function positiveNumberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
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
