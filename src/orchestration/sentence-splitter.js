/**
 * orchestration/sentence-splitter.js — 智能切句分段器
 *
 * 基于 astrbot_plugin_splitter 核心逻辑移植与优化：
 * 1. 贪婪正则切分（默认匹配 [。？！?!\n…]+ 等连续标点与换行）
 * 2. 句首前置标点保护（杜绝句首 ……、？？？ 独自切成空段）
 * 3. 成对符号栈（中文引号 “”、‘’、「」、括号、书名号等未闭合时内部标点不切分；闭合前的标点吸入闭合符号并正常断句）
 * 4. 语法块穿透保护（Markdown 代码块、表格、<think> 标签）
 * 5. ASCII / URL 保护（杜绝 http://a?x=1 这类被劈开）
 * 6. 切点后置收尾符号（右括号、右引号等）与其后标点串的循环吸收
 * 7. 流式前瞻延时保护（避免连续标点/引号在流式边界被截断）
 * 8. 空括号对清理与首尾空行修剪
 * 9. 无实义碎片吸收、最大段数与单段长度控制（流式与非流式同一套）
 *
 * ── 已知边界（不是 bug，改之前先看这里）──────────────────────────────
 * a) 换行是硬分段：delim 含 \n 时会绕过成对符号栈，所以跨行的引号/括号仍会被切开。
 *    这是有意设计（模型自己敲了换行就是想分句），要改成受栈约束请改 shouldSplit 的规则 A。
 * b) minSegmentLength 的尾段吸收需要「短尾巴与前一段同时还在 buffer 里」。逐字符流式喂入时
 *    前一段早已发走、无法回收合并；真实 onText 是多字符 chunk，绝大多数情况能在 flush 里合上。
 *    要 100% 保证就必须延迟一段再发，那会牺牲流式首段的响应速度，故不做。
 */

/** 切点后需要一并吸收的收尾符号（完整闭合符号集合） */
export const TRAILING_CLOSERS = new Set([
  '）', ')', '"', "'", '”', '’', '」', '』', '】', '》', '〉', '＞', '›', '］', '｝', '〕', '〖', '〙',
]);

/**
 * 成对匹配字符映射表（开符号 -> 闭符号）
 *
 * 注意：不要把 '<' 放进来。裸 < 在正文里太常见（a < b、->、<br>），
 * 一个落单的 < 会把栈永久压住，导致整条消息之后再也切不开。<think> 有独立分支处理。
 */
export const PAIR_MAP = {
  '“': '”',
  '‘': '’',
  '《': '》',
  '（': '）',
  '(': ')',
  '[': ']',
  '{': '}',
  '【': '】',
  '「': '」',
  '『': '』',
};

/** 引号字符（同字符开闭） */
export const QUOTE_CHARS = new Set(['"', "'", '`']);

/** 可能连续输入的标点（用于流式前瞻延时） */
export const REPEATABLE_DELIMS = new Set(['。', '！', '？', '!', '?', '…', '.', ',', '，', '；', ';', ' ']);

/**
 * 开符号未闭合的最大容忍跨度（字符）。超过就认为它是噪声（错别字、颜文字、单边括号），
 * 从栈里丢掉，避免单个坏字符让后面整段都不分段。
 */
export const MAX_PAIR_SPAN = 160;

/** 只由标点 / 空白 / 分隔线组成、单独发出去毫无意义的碎片 */
const MEANINGLESS_SEGMENT = /^[\s。，、！？!?…～~,.;；:：*_\-=—－–]+$/;

/** 纯排版分隔线（markdown 的 ---、***、___）。这类碎片贴回上一段也难看，直接丢 */
const SEPARATOR_ONLY = /^[\s\-=_*—－–]+$/;

/**
 * 清除空括号对（如《》、『』等）
 *
 * 这里刻意不含半角 () 与 []：它们在正文里是有意义的内容（`init()`、`const a = []`），
 * 无条件清掉等于静默改写模型输出。
 * @param {string} text
 * @returns {string}
 */
export function removeEmptyBrackets(text) {
  if (!text || typeof text !== 'string') return text;
  let res = text;
  const pattern = /(?:《\s*》|『\s*』|［\s*］|（\s*）|【\s*】|「\s*」|“\s*”|‘\s*’)/g;
  for (let i = 0; i < 5; i++) {
    const next = res.replace(pattern, '');
    if (next === res) break;
    res = next;
  }
  return res;
}

/** 一段文本是否只有标点/空白，没有任何实义内容 */
export function isMeaninglessSegment(text) {
  if (!text) return true;
  return MEANINGLESS_SEGMENT.test(text);
}

/**
 * 寻找文本中的第一个合法切句位置。
 *
 * @param {string} text 待检测文本
 * @param {object} [opts]
 * @param {RegExp} [opts.splitRegex] 分段正则（非全局会自动补 g）
 * @param {string[]} [opts.noSplitAround] 不分段保护词
 * @param {boolean} [opts.isFinal=true] 是否为最终流结束（若为 false，边界标点不提前切）
 * @returns {{ cutIndex: number, matchLength: number } | null}
 */
export function findNextSplitBoundary(text, opts = {}) {
  if (!text) return null;
  let splitRegex = opts.splitRegex ?? /[。？！?!\n…]+/g;
  // 非全局正则的 lastIndex 会被忽略，下面所有锚定匹配都会失效 —— 补一个 g 出来
  if (!splitRegex.global) splitRegex = new RegExp(splitRegex.source, `${splitRegex.flags}g`);
  const noSplitAround = opts.noSplitAround ?? [];
  const isFinal = opts.isFinal ?? true;
  const n = text.length;

  /** @type {{ ch: string, pos: number }[]} 成对符号栈 */
  const stack = [];
  const top = () => (stack.length > 0 ? stack[stack.length - 1] : null);
  const closerOf = (entry) => PAIR_MAP[entry.ch] ?? entry.ch;
  /**
   * 丢弃不该继续压着栈的开符号：
   *  - 跨度超过 MAX_PAIR_SPAN，明显没有闭合意图
   *  - 流已结束（isFinal）却在后文里找不到配对的闭符号 —— 那它就是噪声
   *    （落单的 (、单个反引号、错别字），继续压栈会让整条消息之后再也切不开。
   * 「找不到配对」的判定只在 isFinal 时做：流式中途闭符号可能还没到，
   * 此时保持阻塞、等 flush 再裁决，流式与非流式的结果才会一致。
   */
  const dropStaleOpeners = (at) => {
    while (stack.length > 0) {
      const entry = top();
      if (at - entry.pos > MAX_PAIR_SPAN) {
        stack.pop();
        continue;
      }
      if (isFinal && text.indexOf(closerOf(entry), at) === -1) {
        stack.pop();
        continue;
      }
      break;
    }
  };

  let i = 0;
  splitRegex.lastIndex = 0;

  while (i < n) {
    // 1. Markdown 代码块保护 (``` ... ```)
    //    不要求行首：模型常写「看代码：```js」，要求行首会让保护失效、代码被逐行切碎
    if (text.startsWith('```', i)) {
      const closeIdx = text.indexOf('```', i + 3);
      if (closeIdx !== -1) {
        const blockEnd = closeIdx + 3;
        if (!isFinal && blockEnd >= n) return null;
        if (i > 0 && text.substring(0, i).trim().length > 0) {
          return { cutIndex: i, matchLength: 0 };
        }
        return { cutIndex: blockEnd, matchLength: 0 };
      }
      if (!isFinal) return null;
      break;
    }

    // 2. <think> 标签保护
    if (text.startsWith('<think>', i) && (i === 0 || text[i - 1] === '\n')) {
      const closeIdx = text.indexOf('</think>', i + 7);
      if (closeIdx !== -1) {
        const blockEnd = closeIdx + 8;
        if (!isFinal && blockEnd >= n) return null;
        if (i > 0 && text.substring(0, i).trim().length > 0) {
          return { cutIndex: i, matchLength: 0 };
        }
        return { cutIndex: blockEnd, matchLength: 0 };
      }
      if (!isFinal) return null;
      break;
    }

    // 3. Markdown 表格保护（行首为 | 的多行）
    if ((i === 0 || text[i - 1] === '\n') && text[i] === '|') {
      let tableEnd = i;
      let pos = i;
      while (pos < n) {
        let lineEnd = text.indexOf('\n', pos);
        if (lineEnd === -1) lineEnd = n;
        const line = text.substring(pos, lineEnd).trim();
        // 第二个分支是表头分隔行（|---|:--:|）。必须含 |，否则 markdown 水平线 --- 会被吞进表格
        if (line.startsWith('|') || (line.includes('|') && /^[-| :]+$/.test(line))) {
          tableEnd = lineEnd < n ? lineEnd + 1 : n;
          pos = tableEnd;
        } else {
          break;
        }
      }
      if (tableEnd > i + 1) {
        if (!isFinal && tableEnd >= n) return null;
        if (i > 0 && text.substring(0, i).trim().length > 0) {
          return { cutIndex: i, matchLength: 0 };
        }
        return { cutIndex: tableEnd, matchLength: 0 };
      }
    }

    // 4. 尝试从当前位置匹配切分正则
    splitRegex.lastIndex = i;
    const match = splitRegex.exec(text);
    if (match && match.index === i) {
      const delim = match[0];
      const delimLen = delim.length;

      // 4.0 句首前置标点保护：切分点之前没有任何有效文本时不能切
      const textBefore = text.substring(0, i).trim();
      if (textBefore.length === 0) {
        i += delimLen;
        continue;
      }

      dropStaleOpeners(i);

      let shouldSplit = false;

      // 当前标点后是否紧跟栈顶所需的引号闭合符号（仅针对引语引号，如 “...！”）
      let closingAfter = false;
      const topEntry = top();
      if (topEntry && (topEntry.ch === '“' || topEntry.ch === '‘' || topEntry.ch === '"' || topEntry.ch === "'")) {
        if (i + delimLen < n && text[i + delimLen] === closerOf(topEntry)) {
          closingAfter = true;
        }
      }

      // 规则 A: 栈为空时允许切分；或者包含换行符；或者标点后紧跟闭合符号
      // （换行绕过栈是有意设计，见文件头「已知边界 a」）
      if (stack.length === 0 || delim.includes('\n') || closingAfter) {
        shouldSplit = true;

        // 规则 B: 英文词内 / URL 保护。
        // 只有前后都是字母数字才算「词中间」；空白不算 —— 旧实现把空格放进了字符类，
        // 结果 "Hello world! Next sentence." 这种正常英文永远切不开。
        if (shouldSplit && !delim.includes('\n') && /^[ \t.?!,;:\-']+$/.test(delim)) {
          const prevChar = i > 0 ? text[i - 1] : '';
          const nextChar = i + delimLen < n ? text[i + delimLen] : '';

          if (/^[a-zA-Z0-9]$/.test(prevChar) && /^[a-zA-Z0-9]$/.test(nextChar)) {
            shouldSplit = false;
          }

          // 纯空白 delim（只有自定义正则会产生）：中英文交界处不切
          if (shouldSplit && /^[ \t]+$/.test(delim)) {
            const isCjk = (c) => /[一-鿿㐀-䶿豈-﫿]/.test(c);
            const isLat = (c) => /[a-zA-Z0-9]/.test(c);
            if (prevChar && nextChar) {
              if ((isCjk(prevChar) && isLat(nextChar)) || (isLat(prevChar) && isCjk(nextChar))) {
                shouldSplit = false;
              }
            }
          }
        }

        // 规则 C: 保护词判定（no_split_around）
        if (shouldSplit && noSplitAround.length > 0) {
          let scanPos = i + delimLen;
          while (scanPos < n && (text[scanPos] === ' ' || text[scanPos] === '\t')) {
            scanPos++;
          }
          for (const word of noSplitAround) {
            if (!word) continue;
            if (text.startsWith(word, scanPos)) {
              shouldSplit = false;
              break;
            }
          }
        }
      }

      if (shouldSplit) {
        // 完整截断位置：循环吸收「闭合符号 → 其后的标点串 → 又出现的闭合符号 …」
        // 少了这个循环，“若！8！”。 会在 ” 后断开，把 。 甩到下一段开头或单独成段
        let cut = i + delimLen;
        for (;;) {
          const before = cut;
          while (cut < n) {
            const t = top();
            const isOwnCloser = t !== null && text[cut] === closerOf(t);
            if (!TRAILING_CLOSERS.has(text[cut]) && !isOwnCloser) break;
            if (isOwnCloser) stack.pop();
            cut++;
          }
          splitRegex.lastIndex = cut;
          const tail = splitRegex.exec(text);
          if (tail && tail.index === cut) cut += tail[0].length;
          if (cut === before) break;
        }

        // 流式前瞻保护：切分点刚好触及 buffer 末尾且流未结束，等下一个 tick。
        // 闭合符号也要等 —— “若！8！” 后面很可能还跟着一个 。，
        // 现在就切会让那个句号变成下一段的开头（或单独成段）。
        if (!isFinal && cut >= n && (REPEATABLE_DELIMS.has(text[n - 1]) || TRAILING_CLOSERS.has(text[n - 1]))) {
          return null;
        }

        return { cutIndex: cut, matchLength: cut - i };
      }

      i += delimLen;
      continue;
    }

    // 5. 符号栈维护（括号、引号）
    const char = text[i];
    if (QUOTE_CHARS.has(char)) {
      // 英文缩写里的撇号（don't、it's）不是引号，别入栈 —— 否则整条消息之后都切不开
      const isContraction =
        char === "'" &&
        /^[a-zA-Z]$/.test(text[i - 1] ?? '') &&
        /^[a-zA-Z]$/.test(text[i + 1] ?? '');
      const t = top();
      if (t && t.ch === char) {
        stack.pop();
      } else if (!isContraction && stack.length === 0) {
        // 同字符开闭的引号无法靠形状判断方向，先压栈；
        // 找不到配对的那一个由 dropStaleOpeners 在 flush 时清理掉
        stack.push({ ch: char, pos: i });
      }
    } else if (PAIR_MAP[char]) {
      stack.push({ ch: char, pos: i });
    } else {
      const t = top();
      if (t && char === PAIR_MAP[t.ch]) stack.pop();
    }

    i++;
  }

  return null;
}

/**
 * 清除段落首尾的空行，保留段内正常换行
 * @param {string} text
 * @returns {string}
 */
export function trimSegmentEdgeBlankLines(text) {
  if (!text || typeof text !== 'string') return '';
  return text.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/(?:\r?\n[ \t]*)+$/, '');
}

/**
 * 单段硬长度上限：超长段在最近的标点/空白处折断，折不了就硬切。
 * maxLen <= 0 时原样返回（默认关闭）。
 * @param {string} text
 * @param {number} maxLen
 * @returns {string[]}
 */
export function wrapLongSegment(text, maxLen) {
  if (!maxLen || maxLen <= 0 || text.length <= maxLen) return [text];
  const out = [];
  let rest = text;
  while (rest.length > maxLen) {
    const window = rest.slice(0, maxLen);
    // 优先在窗口后 40% 里找标点或空白折断，避免把词劈成两半
    const searchFrom = Math.floor(maxLen * 0.6);
    let cut = -1;
    for (let k = window.length - 1; k >= searchFrom; k--) {
      if (/[\s。，、；：,.;:!?！？…]/.test(window[k])) {
        cut = k + 1;
        break;
      }
    }
    if (cut <= 0) cut = maxLen;
    const piece = rest.slice(0, cut).trim();
    if (piece) out.push(piece);
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

/**
 * 无实义碎片与短尾吸收：把纯标点段、分隔线段、以及过短的尾段并进前一段。
 * 需要整份列表才能做，所以放在分段全部完成之后。
 * @param {string[]} segments
 * @param {number} [minSegmentLength=4]
 * @returns {string[]}
 */
export function absorbFragments(segments, minSegmentLength = 4) {
  const out = [];
  for (const seg of segments) {
    if (!seg) continue;
    // 纯标点 / 分隔线：贴回上一段尾部（没有上一段就只能自己留着）
    if (out.length > 0 && isMeaninglessSegment(seg)) {
      if (SEPARATOR_ONLY.test(seg)) continue; // 排版分隔线直接丢
      out[out.length - 1] = `${out[out.length - 1]}${seg}`;
      continue;
    }
    out.push(seg);
  }
  if (out.length >= 2 && minSegmentLength > 0) {
    const last = out[out.length - 1];
    if (last.length < minSegmentLength) {
      out[out.length - 2] = `${out[out.length - 2]}\n${out.pop()}`;
    }
  }
  return out;
}

export class SentenceSplitter {
  /**
   * @param {object} [opts]
   * @param {RegExp} [opts.splitRegex] 分段正则
   * @param {number} [opts.maxSegments=7] 最大分段数（用满后剩余内容全部并入最后一段）
   * @param {number} [opts.minSegmentLength=4] 尾部碎片吸收阈值
   * @param {number} [opts.maxSegmentLength=0] 单段硬长度上限，0 = 不限制
   * @param {string[]} [opts.noSplitAround] 保护词列表
   * @param {boolean} [opts.trimBlankLines=true] 是否清理段落首尾空行
   */
  constructor(opts = {}) {
    this.opts = {
      splitRegex: opts.splitRegex ?? /[。？！?!\n…]+/g,
      maxSegments: opts.maxSegments ?? 7,
      minSegmentLength: opts.minSegmentLength ?? 4,
      maxSegmentLength: opts.maxSegmentLength ?? 0,
      noSplitAround: opts.noSplitAround ?? [],
      trimBlankLines: opts.trimBlankLines ?? true,
      ...opts,
    };
    this.buffer = '';
    this.emittedSegments = 0;
  }

  /**
   * 喂入一段流式文本。
   * @param {string} chunk
   * @returns {string[]} 本次可以立即发出的完整段落列表
   */
  push(chunk) {
    if (chunk === undefined || chunk === null) return [];
    this.buffer += String(chunk);
    return this._drain(false);
  }

  /**
   * 流结束，吐出残留内容并执行后处理。
   * @returns {string[]}
   */
  flush() {
    return this._drain(true);
  }

  /**
   * 段数是否已经用满。用满之后不再切分，剩余内容整体作为最后一段 ——
   * 这一步必须在类里做，放在 splitIntoSegments 里会让流式路径完全不受限制。
   */
  _segmentBudgetExhausted() {
    const max = this.opts.maxSegments ?? 0;
    return max > 0 && this.emittedSegments >= max - 1;
  }

  /** 收尾清理 + 长度折断，返回 0..n 段 */
  _finishChunk(raw) {
    let chunk = raw;
    if (this.opts.trimBlankLines) chunk = trimSegmentEdgeBlankLines(chunk);
    chunk = removeEmptyBrackets(chunk.trim());
    if (!chunk) return [];
    return wrapLongSegment(chunk, this.opts.maxSegmentLength);
  }

  _drain(isFinal) {
    const out = [];

    while (this.buffer.length > 0) {
      // 段数用满：不再切分，剩下的全部攒成最后一段
      if (this._segmentBudgetExhausted()) {
        if (!isFinal) break;
        const pieces = this._finishChunk(this.buffer);
        this.buffer = '';
        out.push(...pieces);
        this.emittedSegments += pieces.length;
        break;
      }

      const boundary = findNextSplitBoundary(this.buffer, { ...this.opts, isFinal });
      if (!boundary) {
        if (isFinal) {
          const pieces = this._finishChunk(this.buffer);
          this.buffer = '';
          out.push(...pieces);
          this.emittedSegments += pieces.length;
        }
        break;
      }

      let cut = boundary.cutIndex;

      // flush 阶段：切完之后剩下的尾巴太短且不含更多切点，就不切了，
      // 避免吐出「好。」这种一个字的碎片消息（见文件头「已知边界 b」）
      if (isFinal) {
        const tail = this.buffer.slice(cut).trim();
        const minLen = this.opts.minSegmentLength ?? 0;
        if (tail && tail.length < minLen && !findNextSplitBoundary(tail, { ...this.opts, isFinal: true })) {
          cut = this.buffer.length;
        }
      }

      const pieces = this._finishChunk(this.buffer.substring(0, cut));
      this.buffer = this.buffer.substring(cut);

      if (pieces.length === 0) continue;

      // 纯标点碎片（切点吸收没兜住的兜底）：贴回上一段，绝不单独发出去
      if (pieces.length === 1 && isMeaninglessSegment(pieces[0])) {
        if (SEPARATOR_ONLY.test(pieces[0]) && (out.length > 0 || this.emittedSegments > 0)) continue;
        if (out.length > 0) {
          out[out.length - 1] = `${out[out.length - 1]}${pieces[0]}`;
          continue;
        }
        if (this.emittedSegments > 0) continue; // 上一段已发走，只能丢弃
      }

      out.push(...pieces);
      this.emittedSegments += pieces.length;
    }

    if (isFinal) {
      const absorbed = absorbFragments(out, this.opts.minSegmentLength);
      out.length = 0;
      out.push(...absorbed);
    }

    return out;
  }

  get pending() {
    return this.buffer;
  }

  reset() {
    this.buffer = '';
    this.emittedSegments = 0;
  }
}

/**
 * 非流式场景：一次性把完整文本切成段
 * @param {string} fullText
 * @param {object} [opts]
 * @returns {string[]}
 */
export function splitIntoSegments(fullText, opts = {}) {
  if (!fullText || typeof fullText !== 'string') return [];
  const splitter = new SentenceSplitter(opts);
  const out = splitter.push(fullText);
  out.push(...splitter.flush());
  // 段数上限由 SentenceSplitter 内部保证，这里只做「需要整份列表」的碎片吸收
  return absorbFragments(out, splitter.opts.minSegmentLength);
}
