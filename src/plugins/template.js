/**
 * plugins/template.js — manifest 中的字段映射模板
 *
 * 存在的理由：每个上游插件的 wire format 都不一样（GCP 要 gid/uid/text_only，
 * LivingMemory 要 OneBot 风格的 post_type/self_id，自学习服务要 uid/message/is_at）。
 * 旧 Bridge 把这些差异直接写死在业务代码里，于是主流程被迫知道每个插件的字段名。
 *
 * v2 把映射搬进 manifest：主流程只产出规范化的 capability input / event payload，
 * 由这里按模板翻译成各插件的 wire format。代码里不出现任何插件专属字段名。
 *
 * 模板语法：
 *   "{{userId}}"          整串就是一个占位符 → 原样取值，保留类型（数字仍是数字）
 *   "qq_{{userId}}"       混在字符串里 → 转成字符串后插值
 *   "{{sender.nickname}}" 支持点号路径
 *   缺失字段解析为 null（整串占位）或空串（混合插值）
 */

const FULL_PLACEHOLDER = /^\{\{\s*([\w.]+)\s*\}\}$/;
const INLINE_PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

function getPath(source, dotted) {
  let cur = source;
  for (const key of dotted.split('.')) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * 递归解析模板。
 * @param {any} template  字符串 / 对象 / 数组 / 字面量
 * @param {object} source 取值来源
 */
export function resolveTemplate(template, source) {
  if (template == null) return template;

  if (typeof template === 'string') {
    const full = FULL_PLACEHOLDER.exec(template);
    if (full) {
      const value = getPath(source, full[1]);
      return value === undefined ? null : value;
    }
    return template.replace(INLINE_PLACEHOLDER, (_all, path) => {
      const value = getPath(source, path);
      return value == null ? '' : String(value);
    });
  }

  if (Array.isArray(template)) return template.map((item) => resolveTemplate(item, source));

  if (typeof template === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(template)) out[key] = resolveTemplate(value, source);
    return out;
  }

  return template;
}

/**
 * 从插件响应中按点号路径取值。
 * resultPath 为空时返回整个响应体。
 */
export function extractResult(body, resultPath) {
  if (!resultPath) return body;
  return getPath(body, resultPath);
}

/**
 * 简单的布尔条件过滤：订阅可以声明 `when: { isOwner: false }`，
 * 只在 payload 满足全部键值时才投递。
 */
export function matchesCondition(condition, source) {
  if (!condition) return true;
  for (const [path, expected] of Object.entries(condition)) {
    const actual = getPath(source, path);
    if (Array.isArray(expected)) {
      if (!expected.includes(actual)) return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}
