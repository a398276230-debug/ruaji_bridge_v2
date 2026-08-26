/**
 * middleware/typing-delay.js — 拟人化打字延迟
 *
 * 算法迁移自 bridge.js:633-642：延迟由**上一条**已发消息的长度决定，
 * 约 15 字/秒 + 0.8s 基础，钳制在 [800ms, 2500ms]。第一条即时发出。
 *
 * 与旧实现的差异：
 *   - 旧逻辑写在 processSendQueue 里，是全局的（lastGlobalSendTime / lastSentLen），
 *     一个会话的长回复会拖慢所有其他会话。这里按 sessionId 隔离。
 *   - 支持取消：主人打断时正在等待的延迟立即结束，不会白等 2.5 秒。
 *   - 测试模式（mode=test 或 typingDelay.enabled=false）直接跳过。
 *   - 不承担实际发送职责——它只等待，enqueue 由 reply-flow 负责。
 */

export const MIN_DELAY_MS = 800;
export const MAX_DELAY_MS = 2500;
export const CHARS_PER_SECOND = 15;
export const DEFAULT_LOG_BASE = 2.6;

/**
 * 线性延时计算（原有算法）
 * @param {number} previousLength 上一条消息的可见字符数
 * @returns {number} 本条发送前应等待的毫秒数
 */
export function computeLinearDelayMs(previousLength) {
  if (!previousLength || previousLength <= 0) return 0;
  const raw = MIN_DELAY_MS + Math.floor((previousLength / CHARS_PER_SECOND) * 1000);
  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, raw));
}

/**
 * 对数拟人延时算法
 * Delay = clamp(log_base(len + 1) * 750 + min + jitter, min, max)
 * @param {number} previousLength 上一条消息的可见字符数
 * @param {number} base 对数基底，默认 2.6
 * @param {number} minMs 最小延时，默认 800ms
 * @param {number} maxMs 最大延时，默认 2500ms
 * @param {number} [jitter] 额外抖动毫秒数，默认 0
 * @returns {number}
 */
export function computeLogDelayMs(previousLength, base = DEFAULT_LOG_BASE, minMs = MIN_DELAY_MS, maxMs = MAX_DELAY_MS, jitter = 0) {
  if (!previousLength || previousLength <= 0) return 0;
  const t = Math.max(1, previousLength);
  const logSec = Math.log(t + 1) / Math.log(base);
  const raw = minMs + Math.floor(logSec * 450) + jitter;
  return Math.min(maxMs, Math.max(minMs, raw));
}

/**
 * 通用延时计算
 * @param {number} previousLength 上一条消息的可见字符数
 * @param {string} [method='linear'] 延时算法：'linear' 或 'log'
 * @param {object} [opts]
 * @returns {number}
 */
export function computeDelayMs(previousLength, method = 'linear', opts = {}) {
  if (method === 'log') {
    return computeLogDelayMs(previousLength, opts.logBase, opts.minDelayMs, opts.maxDelayMs, opts.jitter);
  }
  return computeLinearDelayMs(previousLength);
}

/** 可取消的 sleep */
export function cancellableSleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}

export function createTypingDelayMiddleware({ config, logger, sleep = cancellableSleep } = {}) {
  const log = logger?.child({ component: 'mw:typing-delay' }) ?? console;
  // 这段延迟的唯一目的是给**真实发送**做拟人化节流防风控。既然影子模式
  // （sendEnabled=false）一条都不发，就没有任何东西需要节流；照常等下去只会让
  // 影子回放慢上几个数量级（每段 0.8~2.5s），却换不来任何对照价值。
  const enabled =
    config.mode !== 'test' &&
    config.reply?.sendEnabled !== false &&
    config.typingDelay?.enabled !== false;

  /** sessionId -> { lastSentAt, lastLength } —— 按会话隔离，互不拖累 */
  const perSession = new Map();

  const middleware = {
    name: 'typing-delay',

    async process(ctx, next) {
      if (!enabled) return next(ctx);
      // 收尾轮只跑副作用、不产出可见文本，不该触发任何延迟，
      // 更不该把 lastLength 刷成 0 把下一条的节奏算错。
      if (ctx.isFinalPass) return next(ctx);

      const sessionId = ctx.sessionId ?? 'default';
      const state = perSession.get(sessionId) ?? { lastSentAt: 0, lastLength: 0 };

      // 按最终可见文本计算，所以必须排在 strip-markdown / meme 之后
      const visibleLength = String(ctx.text ?? '').length;

      if (state.lastSentAt > 0) {
        // bridge.js:638 的 `lastSentLen || 10` 兜底：上一段可见文本为空（例如整段
        // 只有一条分割线，被 strip-markdown 清成空串后跳过发送）时，旧实现按 10 字
        // 计节奏而不是直接不等。这个兜底是防风控的，丢了会让空段后面那条秒发。
        const delayMethod = config?.typingDelay?.method ?? 'linear';
        const target = computeDelayMs(state.lastLength || 10, delayMethod, {
          logBase: config?.typingDelay?.logBase,
          minDelayMs: config?.typingDelay?.minDelayMs,
          maxDelayMs: config?.typingDelay?.maxDelayMs,
        });
        const waited = Date.now() - state.lastSentAt;
        const remaining = target - waited;
        if (remaining > 0) {
          // 延迟不包含插件超时：这里只等自己算出来的那一段
          await sleep(remaining, ctx.signal);
        }
      }

      if (ctx.signal?.aborted) {
        log.debug?.('延迟期间被打断，本段不再发送', { correlationId: ctx.correlationId });
        ctx.cancelled = true;
        return ctx;
      }

      perSession.set(sessionId, { lastSentAt: Date.now(), lastLength: visibleLength });
      return next(ctx);
    },

    /** 会话结束时清理，避免长期运行后 Map 无限增长 */
    forget(sessionId) {
      perSession.delete(sessionId);
    },

    _state: perSession,
  };

  return middleware;
}
