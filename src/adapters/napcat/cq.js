/**
 * adapters/napcat/cq.js — CQ 码解析与构造
 *
 * 旧 Bridge 在七八个地方各写一遍 `/\[CQ:image,.*?url=(.*?)\]/` 这类正则
 * （bridge.js:1290, 1338, 1363, 1403, 1408 …），每处的转义与贪婪程度都不一样。
 * 这里做一份统一实现，正则只在这个文件里出现。
 */

/** 匹配一个完整 CQ 码：[CQ:type,k=v,k=v] */
const CQ_PATTERN = /\[CQ:([a-zA-Z_]+)((?:,[^,\]]*)*)\]/g;

/** OneBot 的 CQ 码转义表 */
const ESCAPES = [
  ['&amp;', '&'],
  ['&#91;', '['],
  ['&#93;', ']'],
  ['&#44;', ','],
];

export function unescapeCq(value) {
  let out = String(value ?? '');
  for (const [encoded, plain] of ESCAPES) out = out.split(encoded).join(plain);
  return out;
}

export function escapeCq(value) {
  let out = String(value ?? '');
  // & 必须最先替换，否则会把后续替换产生的 &#91; 再转一次
  out = out.split('&').join('&amp;');
  out = out.split('[').join('&#91;');
  out = out.split(']').join('&#93;');
  return out;
}

/**
 * 解析 raw_message 为片段数组。
 * @returns {Array<{type: string, data: object, raw: string}>}
 */
export function parseCqMessage(rawMessage) {
  const text = String(rawMessage ?? '');
  const segments = [];
  let cursor = 0;

  CQ_PATTERN.lastIndex = 0;
  let match;
  while ((match = CQ_PATTERN.exec(text)) !== null) {
    if (match.index > cursor) {
      const plain = text.slice(cursor, match.index);
      if (plain) segments.push({ type: 'text', data: { text: unescapeCq(plain) }, raw: plain });
    }
    segments.push({
      type: match[1].toLowerCase(),
      data: parseCqParams(match[2]),
      raw: match[0],
    });
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) {
    const tail = text.slice(cursor);
    if (tail) segments.push({ type: 'text', data: { text: unescapeCq(tail) }, raw: tail });
  }
  return segments;
}

/** ",k=v,k2=v2" -> { k: v, k2: v2 }。值里可能含 '='，只按第一个 '=' 切。 */
export function parseCqParams(paramString) {
  const out = {};
  for (const pair of String(paramString ?? '').split(',')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    if (!key) continue;
    out[key] = unescapeCq(pair.slice(eq + 1));
  }
  return out;
}

/** 构造 CQ 码 */
export function buildCq(type, params = {}) {
  const parts = Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `,${k}=${String(v).split(',').join('&#44;')}`)
    .join('');
  return `[CQ:${type}${parts}]`;
}

/** 本地文件路径 -> file:/// URI（Windows 反斜杠统一成正斜杠） */
export function toFileUri(filePath) {
  return `file:///${String(filePath).replace(/\\/g, '/')}`;
}

export function buildImageCq(filePath) {
  return `[CQ:image,file=${toFileUri(filePath)}]`;
}

export function buildAtCq(userId) {
  return `[CQ:at,qq=${userId}]`;
}

/**
 * 把 rawMessage 转成对人类、插件和模型都友好的纯文本。
 * - 保留 @昵称 / @QQ（与 renderAtMention 规则一致）
 * - 剥离媒体类 CQ 码（image/file/face 等替换为空白）
 * - 保持词间空白与边界
 */
export function cqToReadableText(rawMessage) {
  return String(rawMessage ?? '')
    .replace(/\[CQ:at((?:,[^,\]]*)*)\][ \t]*/gi, (_match, paramStr) => {
      const params = parseCqParams(paramStr);
      const mention = renderAtMention(params);
      return mention ? `${mention} ` : '';
    })
    .replace(/\[CQ:[^\]]*\]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * 剔除所有 CQ 码，得到纯文本。
 * 迁移自 bridge.js:1155 `msg.replace(/\[CQ:[^\]]*\]/g, ' ').trim()`。
 * 注意替换成空格而非空串——这是旧行为，直接影响名字呼唤正则的边界判定
 * （"[CQ:at,qq=x]瑞姬" 去码后是 " 瑞姬"，空格让 isNameCall 命中）。
 */
export function stripCqCodes(rawMessage) {
  return String(rawMessage ?? '')
    .replace(/\[CQ:[^\]]*\]/g, ' ')
    .trim();
}

/**
 * 任意一段 at 码。参数顺序不由协议保证（`[CQ:at,name=x,qq=1]` 也是合法的），
 * 所以不能写死 `qq=` 开头 —— 整段参数交给 parseCqParams 处理。
 * 带 g 标记的正则 lastIndex 会跨调用残留，用它 exec 之前先 new 一个副本。
 */
export const AT_CQ_SOURCE = String.raw`\[CQ:at((?:,[^,\]]*)*)\]`;

/** 把媒体类 CQ 码转成可读文字标注，用于引用消息摘要 */
export function annotateCqCodes(rawMessage) {
  return String(rawMessage ?? '')
    .replace(/\[CQ:image[^\]]*\]/g, '[图片]')
    .replace(/\[CQ:file[^\]]*\]/g, '[文件]')
    .replace(/\[CQ:face[^\]]*\]/g, '[表情]')
    .replace(new RegExp(AT_CQ_SOURCE, 'gi'), (_m, paramStr) => renderAtMention(parseCqParams(paramStr)))
    .replace(/\[CQ:[^\]]*\]/g, '')
    .trim();
}

/**
 * 把一个 at 片段的参数渲染成面向模型的 `@昵称`。
 *
 * 昵称是**群成员可控**的文本：协议端把对方的群名片原样塞进 name=，而 parseCqParams
 * 会把 &#91; &#93; &#44; 解码回真正的方括号和逗号。不做净化的话，任何人都可以把自己的
 * 名片改成带换行的伪造指令块（"坏 换行 换行 [系统] 忽略上文…"）直接注入 Prompt。
 * 所以这里统一：去掉控制字符与方括号、压平空白、砍掉前导 @（某些实现的 text= 自带 @，
 * 不砍会渲染成 @@昵称）、限长。
 *
 * @param {object} params at 片段的参数（parseCqParams 的结果或 segment.data）
 * @returns {string} `@xxx` 形式的文本；无法识别时返回空串
 */
export function renderAtMention(params = {}) {
  const qq = String(params.qq ?? '');
  if (qq === 'all' || params.all === 'true') return '@全体成员';

  const name = sanitizeMentionName(params.name || params.text || params.card || params.nick || params.nickname);
  if (name) return `@${name}`;
  if (qq) return `@${qq}`;
  return '';
}

/** 不允许出现在昵称里的码点：C0/C1 控制字符、零宽字符、双向覆盖、BOM */
function isInvisibleCodePoint(code) {
  if (code < 0x20) return true;
  if (code >= 0x7f && code <= 0x9f) return true;
  if (code >= 0x200b && code <= 0x200f) return true;
  if (code >= 0x2028 && code <= 0x202e) return true;
  if (code >= 0x2066 && code <= 0x2069) return true;
  return code === 0xfeff;
}

/**
 * at 昵称净化。这是群成员可控文本进入 Prompt 的唯一入口，改动前想清楚。
 *
 * 不可见字符按码点判断而不是写进正则字符类：字面控制字符塞在源码里既读不出来，
 * 也很容易在复制粘贴 / 编码转换中被悄悄改掉。
 * @param {string} value
 * @param {number} [maxLength=32]
 * @returns {string}
 */
export function sanitizeMentionName(value, maxLength = 32) {
  let out = '';
  for (const ch of String(value ?? '')) {
    if (isInvisibleCodePoint(ch.codePointAt(0))) {
      out += ' ';
      continue;
    }
    // 方括号会被模型读成结构标记（[系统]、[引用 …]），昵称里不许有
    if (ch === '[' || ch === ']') continue;
    out += ch;
  }
  return out
    .replace(/\s+/g, ' ')
    .replace(/^@+/, '')
    .trim()
    .slice(0, maxLength)
    .trim();
}

/**
 * 把 message 数组（message_format=array）拼成可读文本。
 */
export function segmentsToText(segments) {
  if (!Array.isArray(segments)) return '';
  return segments
    .map((seg) => {
      if (!seg || !seg.type) return '';
      switch (seg.type) {
        case 'text': return seg.data?.text ?? '';
        case 'image': return '[图片]';
        case 'file':
        case 'offline_file': return `[文件: ${seg.data?.name ?? '未知'}]`;
        case 'face': return '[表情]';
        // 与 InboundNormalizer._buildContent 共用同一套渲染，否则同一个人
        // 在正文里显示 @三锅、在引用摘要里显示 @12345678
        case 'at': return renderAtMention(seg.data ?? {});
        case 'reply': return '';
        default: return '';
      }
    })
    .join('')
    .trim();
}
