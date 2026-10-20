/** 只展示经过清洗的调用侧摘要；绝不读取或发送工具返回的 result/output。 */
const SENSITIVE = /api[\s_-]*key|token|secret|password|authorization|bearer|sk-/i;
const SUMMARY_KEYS = ['query', 'path', 'url', 'urls', 'name', 'goal', 'command', 'prompt', 'text'];

function cleanDetail(value, { firstLine = false } = {}) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const raw = String(value);
  // 在裁首行、去 CQ 码及截断之前检查，避免藏在后半段的凭据漏出。
  const normalized = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, '');
  if (SENSITIVE.test(raw) || SENSITIVE.test(normalized)) return '***';
  return (firstLine ? raw.split(/[\r\n\u2028\u2029]/, 1)[0] : raw)
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, '')
    .replace(/\[CQ:[^\]]*(?:\]|$)/gi, '')
    .replace(/\s+/g, ' ').trim();
}

function limitMessage(text) {
  const chars = Array.from(text);
  return chars.length > 120 ? `${chars.slice(0, 119).join('')}…` : text;
}

function describeTool(event, showDetail) {
  const fallback = `⏳ 正在调用 ${event.name}…`;
  if (showDetail === false) return limitMessage(fallback);
  const args = event.args && typeof event.args === 'object' && !Array.isArray(event.args) ? event.args : {};
  let value;
  let verb;
  switch (event.name) {
    case 'web_search': value = args.query; verb = '正在搜索'; break;
    case 'read_file': value = args.path; verb = '正在读'; break;
    case 'write_file':
    case 'patch': value = args.path; verb = '正在改'; break;
    case 'terminal': value = args.command; verb = '正在执行命令：'; break;
    case 'delegate_task':
      value = args.goal ?? args.tasks?.[0]?.goal;
      verb = args.action && args.action !== 'spawn' ? '正在管理子任务：' : '正在派发子任务：';
      value ??= args.action;
      break;
    default: {
      // 仅摘要明确的调用参数，不序列化整个对象（可能含 result/output 或凭据）。
      const key = SUMMARY_KEYS.find((key) => args[key] !== undefined);
      if (key) value = Array.isArray(args[key]) ? args[key][0] : args[key];
      break;
    }
  }
  // Hermes chat-completions 的 label 是 build_tool_preview(function_args) 的调用侧摘要。
  value ??= event.label !== event.name ? event.label : undefined;
  const detail = cleanDetail(value, { firstLine: event.name === 'terminal' });
  if (!detail) return limitMessage(fallback);
  if (!verb) return limitMessage(`⏳ 正在调用 ${event.name}：${detail}`);
  const object = event.name === 'web_search' ? `「${detail}」` : detail;
  return limitMessage(`⏳ ${verb}${verb.endsWith('：') ? '' : ' '}${object}（${event.name}）`);
}
export function isToolProgressEnabled(config, inbound) {
  const policy = config?.toolProgress;
  if (policy?.enabled !== true) return false;
  const includes = (list, id) => Array.isArray(list) && list.some((entry) => String(entry).trim() === String(id));
  if (inbound.messageType === 'group') return includes(policy.groupWhitelist, inbound.groupId);
  if (inbound.messageType !== 'private') return false;
  return policy.privateEnabled === true || includes(policy.privateWhitelist, inbound.userId);
}

/** 每轮独立状态，重放去重 + 冷却 + 总量上限；不延迟补发过时进度。 */
export function createToolProgressReporter({ config, inbound, signal, enqueue, now = Date.now }) {
  const seen = new Set();
  let count = 0;
  let lastAt = -Infinity;
  return (event) => {
    if (signal?.aborted || !isToolProgressEnabled(config, inbound)) return;
    if (event?.status !== 'running' || typeof event.name !== 'string' || event.name.startsWith('_')) return;
    // 严格限制为安全工具标识符，避免换行、CQ 码及恶意工具名注入。
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/.test(event.name)) return;
    const key = event.id || event.name;
    if (seen.has(key)) return;
    seen.add(key);
    const policy = config.toolProgress;
    const at = now();
    if (count >= (policy.maxMessagesPerTurn ?? 8) || at - lastAt < (policy.minIntervalMs ?? 1500)) return;
    count++;
    lastAt = at;
    enqueue(describeTool(event, policy.showDetail));
  };
}
