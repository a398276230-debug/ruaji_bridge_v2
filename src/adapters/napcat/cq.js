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

/** 把媒体类 CQ 码转成可读文字标注，用于引用消息摘要 */
export function annotateCqCodes(rawMessage) {
  return String(rawMessage ?? '')
    .replace(/\[CQ:image[^\]]*\]/g, '[图片]')
    .replace(/\[CQ:file[^\]]*\]/g, '[文件]')
    .replace(/\[CQ:face[^\]]*\]/g, '[表情]')
    .replace(/\[CQ:at,qq=(\d+)[^\]]*\]/g, '@$1')
    .replace(/\[CQ:[^\]]*\]/g, '')
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
        case 'at': return seg.data?.text ? `@${seg.data.text}` : (seg.data?.qq ? `@${seg.data.qq}` : '');
        case 'reply': return '';
        default: return '';
      }
    })
    .join('')
    .trim();
}
