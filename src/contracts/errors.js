/**
 * contracts/errors.js — 统一错误分类
 *
 * 旧 Bridge 把所有异常压成 `err.message` 字符串后用 includes('aborted') 之类
 * 猜测类型（bridge.js:1103）。v2 用显式错误类，让熔断、重试与降级可以按类别决策。
 */

export class BridgeError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = new.target.name;
    this.correlationId = options.correlationId || null;
    this.cause = options.cause || null;
    /** 是否可重试：熔断器与发送队列据此决定是否累计失败 */
    this.retryable = options.retryable !== false;
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      correlationId: this.correlationId,
      retryable: this.retryable,
    };
  }
}

/** 配置缺失或非法，属于不可恢复错误，启动期直接退出 */
export class ConfigError extends BridgeError {
  constructor(message, options = {}) {
    super(message, { ...options, retryable: false });
  }
}

/** 插件在超时窗口内未返回 */
export class PluginTimeoutError extends BridgeError {
  constructor(pluginId, capability, timeoutMs, options = {}) {
    super(`插件 ${pluginId} 的 ${capability} 调用超时 (${timeoutMs}ms)`, options);
    this.pluginId = pluginId;
    this.capability = capability;
    this.timeoutMs = timeoutMs;
  }
}

/** 网络层失败：连接拒绝、DNS、非 2xx 等 */
export class PluginTransportError extends BridgeError {
  constructor(pluginId, detail, options = {}) {
    super(`插件 ${pluginId} 传输失败: ${detail}`, options);
    this.pluginId = pluginId;
  }
}

/** 插件返回了结构不合法的响应 */
export class PluginContractError extends BridgeError {
  constructor(pluginId, detail, options = {}) {
    super(`插件 ${pluginId} 响应不符合契约: ${detail}`, { ...options, retryable: false });
    this.pluginId = pluginId;
  }
}

/** 没有任何可用 Provider（未注册 / 全部熔断 / 全部禁用） */
export class CapabilityUnavailableError extends BridgeError {
  constructor(capability, reason, options = {}) {
    super(`能力 ${capability} 不可用: ${reason}`, { ...options, retryable: false });
    this.capability = capability;
    this.reason = reason;
  }
}

/** 熔断器处于打开状态，主动拦截。注意：这不是真实失败，不得累计失败计数 */
export class CircuitOpenError extends BridgeError {
  constructor(name, nextRetryAt, options = {}) {
    super(`${name} 断路器打开，${new Date(nextRetryAt).toISOString()} 后重试`, options);
    this.circuitName = name;
    this.nextRetryAt = nextRetryAt;
    /** 主动拦截，调用方不应把它当作 provider 失败 */
    this.suppressed = true;
  }
}

/** 模型调用失败 */
export class ModelError extends BridgeError {
  constructor(message, options = {}) {
    super(message, options);
    this.status = options.status || null;
    this.kind = options.kind || 'unknown'; // auth | timeout | transport | protocol | unknown
  }
}

/** NapCat 发送失败 */
export class SendError extends BridgeError {
  constructor(message, options = {}) {
    super(message, options);
    this.status = options.status || null;
  }
}

/** 主人发来新消息导致在途生成被抢占 */
export class PreemptedError extends BridgeError {
  constructor(reason = 'preempted by owner message', options = {}) {
    super(reason, { ...options, retryable: false });
    this.preempted = true;
  }
}

/**
 * 把任意 throwable 归一为 BridgeError，供日志与熔断统一处理。
 * AbortError 与 PreemptedError 都视为"非失败"，不应污染熔断计数。
 */
export function classifyError(err, correlationId = null) {
  if (err instanceof BridgeError) return err;
  if (err && err.name === 'AbortError') {
    return new PreemptedError(err.message || 'aborted', { correlationId, cause: err });
  }
  if (err && err.name === 'TimeoutError') {
    return new BridgeError(err.message || 'timeout', { correlationId, cause: err });
  }
  return new BridgeError(err && err.message ? err.message : String(err), {
    correlationId,
    cause: err,
  });
}

/** 该错误是否应计入熔断失败 */
export function countsAsFailure(err) {
  if (!err) return false;
  if (err.suppressed) return false;
  if (err.preempted) return false;
  return true;
}
