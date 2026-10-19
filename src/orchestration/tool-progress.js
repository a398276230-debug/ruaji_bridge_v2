/** 工具进度只公开工具名：绝不把上游 preview/label/args/result 发到 QQ。 */
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
    enqueue(`⏳ 正在调用 ${event.name}…`);
  };
}
