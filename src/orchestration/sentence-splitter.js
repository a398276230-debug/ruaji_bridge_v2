/**
 * orchestration/sentence-splitter.js — 流式切句
 *
 * 逐字迁移自 bridge.js:826-891。这里的规则很反直觉，但它是被现网验证过的：
 *
 *   **只有空行（连续两个 \n）才切句。**
 *   单个换行不切，标点不切。
 *
 * 早期版本按标点切句，结果是模型输出 "1.5 秒" 或 "http://a.com/b?x=1" 时
 * 被从中间劈开发到群里。现在把断句权完全交给模型——它想分段就打空行。
 *
 * 切点之后紧跟的收尾符号（）) " ' " '）要一起吸收，避免右括号单独成段。
 */

/** 切点后需要一并吸收的收尾符号（完整闭合符号集合） */
export const TRAILING_CLOSERS = [
  '）', ')', '"', "'", '”', '’', '」', '』', '】', '》', '〉', '＞', '›', '］', '｝', '〕', '〖', '〙',
];

/**
 * 清除空括号对（如《》、[]、『』等）
 * @param {string} text
 * @returns {string}
 */
export function removeEmptyBrackets(text) {
  if (!text || typeof text !== 'string') return text;
  let res = text;
  const pattern = /(?:《\s*》|\[\s*\]|『\s*』|［\s*］|（\s*）|\(\s*\)|【\s*】|「\s*」)/g;
  for (let i = 0; i < 5; i++) {
    const next = res.replace(pattern, '');
    if (next === res) break;
    res = next;
  }
  return res;
}

/**
 * 找切句位置。
 * @returns {number} 第二个连续换行的下标；没有则 -1
 */
export function findStreamBoundary(text) {
  let newlineStreak = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      newlineStreak++;
      if (newlineStreak >= 2) return i;
      continue;
    }
    newlineStreak = 0;
  }
  return -1;
}

export class SentenceSplitter {
  constructor() {
    this.buffer = '';
  }

  /**
   * 喂入一段流式文本。
   * @returns {string[]} 本次可以立即发出的完整段落
   */
  push(chunk) {
    this.buffer += chunk;
    return this._drain(false);
  }

  /**
   * 流结束，吐出残留内容。
   * @returns {string[]}
   */
  flush() {
    return this._drain(true);
  }

  _drain(isFinal) {
    const out = [];
    for (;;) {
      const splitPos = findStreamBoundary(this.buffer);
      if (splitPos === -1 && !isFinal) break;

      let rawChunk;
      if (splitPos === -1) {
        rawChunk = removeEmptyBrackets(this.buffer.trim());
        this.buffer = '';
      } else {
        let cut = splitPos + 1;
        while (cut < this.buffer.length && TRAILING_CLOSERS.includes(this.buffer[cut])) cut++;
        rawChunk = removeEmptyBrackets(this.buffer.substring(0, cut).trim());
        this.buffer = this.buffer.substring(cut);
      }

      if (rawChunk) out.push(rawChunk);
      if (splitPos === -1) break;
    }
    return out;
  }

  get pending() {
    return this.buffer;
  }

  reset() {
    this.buffer = '';
  }
}

/** 非流式场景：一次性把完整文本切成段 */
export function splitIntoSegments(fullText) {
  const splitter = new SentenceSplitter();
  const out = splitter.push(String(fullText ?? ''));
  out.push(...splitter.flush());
  return out;
}
