/**
 * orchestration/decision-flow.js — 是否回复、以什么身份回复
 *
 * 归一为三种裁决：direct / auto / ignore。
 *
 * 与旧 Bridge 的对照（bridge.js:1148-1253）：
 *
 *   旧: GCP 裁决放行 route==='direct' 之后，紧接着 :1239 又来一句
 *       `if (mType === 'group' && !isAtMe) return;`
 *       → 非 @ 的 direct 裁决**永远到不了模型**。这是勘测中确认的缺陷。
 *   新: direct 就是 direct。裁决者说回就回，不再被后置的 isAtMe 二次否决。
 *       这是一处有意识的行为差异，影子对照报告里会标注原因。
 *
 *   旧: 限流分支在 `const nickname` 之前引用 nickname（:1250 vs :1256）
 *       → 一旦真的命中限流就抛 TDZ ReferenceError，被外层 catch 吞成"协议层异常"。
 *   新: 限流判定不依赖任何未初始化变量。
 *
 * 保留的行为：
 *   - GCP 不可用时降级为"真 @ 兜底"
 *   - route 为 duplicate/none/空 一律当 ignore
 *   - 限流名单 5 次 / 5 分钟窗口，静默忽略
 *   - 主人打断特权、群友排队（附录 1）
 */

import { CAPABILITIES, ROUTES, TRIGGER_TYPES, normalizeRoute } from '../contracts/capabilities.js';
import { MESSAGE_TYPES } from '../contracts/messages.js';
import { PreemptedError } from '../contracts/errors.js';

export const IGNORE_REASONS = Object.freeze({
  NOT_WOKEN: 'not_woken',
  PROVIDER_IGNORE: 'provider_ignore',
  RATE_LIMITED: 'rate_limited',
  QUEUED: 'queued_behind_active_generation',
});

export class DecisionFlow {
  /**
   * @param {object} opts
   * @param {import('../core/capability-bus.js').CapabilityBus} opts.capabilityBus
   * @param {import('../storage/session-store.js').SessionStore} opts.sessionStore
   * @param {import('../adapters/napcat/inbound-normalizer.js').InboundNormalizer} opts.normalizer
   * @param {object} opts.config
   * @param {import('../core/logger.js').Logger} opts.logger
   */
  constructor(opts = {}) {
    this.capabilityBus = opts.capabilityBus;
    this.sessions = opts.sessionStore;
    this.normalizer = opts.normalizer;
    this.config = opts.config;
    this.log = opts.logger?.child({ component: 'decision-flow' }) ?? console;
    this.rateLimitUsers = new Set((opts.config.identity.rateLimitUsers ?? []).map(String));
  }

  /**
   * @param {object} inbound InboundMessage
   * @param {{ signal?: AbortSignal }} [ctx]
   * @returns {Promise<{ route: string, triggerType: string, reason: string, providerId: string|null }>}
   */
  async decide(inbound, ctx = {}) {
    // 私聊恒 direct
    if (inbound.messageType === MESSAGE_TYPES.PRIVATE) {
      return this._result(ROUTES.DIRECT, TRIGGER_TYPES.AT, 'private_message', null, inbound);
    }

    const isWoken = this.normalizer.isWake(inbound.flags);
    const decision = await this._askProvider(inbound, ctx);
    const rawRes = decision?.result;
    const providerRoute = decision ? normalizeRoute(typeof rawRes === 'string' ? rawRes : rawRes?.route ?? rawRes?.verdict) : null;

    this.log.info('群聊唤醒裁决', {
      correlationId: inbound.correlationId,
      groupId: inbound.groupId,
      providerId: decision?.providerId ?? null,
      route: providerRoute ?? '(provider 不可用)',
      reason: decision?.result?.reason ?? '',
      isAtBot: inbound.flags.isAtBot,
      isNameCall: inbound.flags.isNameCall,
    });

    let route;
    let triggerType;
    let reason;

    if (providerRoute === null) {
      // Provider 不可用：降级为最小真 @ 兜底（旧行为）
      route = isWoken ? ROUTES.DIRECT : ROUTES.IGNORE;
      reason = isWoken ? 'provider_unavailable_at_fallback' : IGNORE_REASONS.NOT_WOKEN;
    } else if (providerRoute === ROUTES.IGNORE) {
      // 被明确要求忽略。但真 @ 优先于裁决者——被点名还不理人是不可接受的。
      route = inbound.flags.isAtBot ? ROUTES.DIRECT : ROUTES.IGNORE;
      reason = inbound.flags.isAtBot ? 'at_overrides_provider_ignore' : IGNORE_REASONS.PROVIDER_IGNORE;
    } else if (providerRoute === ROUTES.AUTO) {
      route = ROUTES.AUTO;
      reason = 'provider_auto';
    } else {
      // direct：不再被后置的 isAtMe 二次否决（修正旧 bridge.js:1239）
      route = ROUTES.DIRECT;
      reason = 'provider_direct';
    }

    if (route === ROUTES.AUTO) {
      triggerType = TRIGGER_TYPES.AI_DECISION;
    } else if (inbound.flags.isAtBot) {
      triggerType = TRIGGER_TYPES.AT;
    } else if (inbound.flags.isNameCall) {
      triggerType = TRIGGER_TYPES.KEYWORD;
    } else {
      triggerType = TRIGGER_TYPES.AT;
    }

    // 限流：只对名单内用户生效，防止 AI 与 AI 互相回复把 token 轰上天
    if (route !== ROUTES.IGNORE && this._isRateLimited(inbound)) {
      return this._result(ROUTES.IGNORE, triggerType, IGNORE_REASONS.RATE_LIMITED, decision?.providerId ?? null, inbound);
    }

    return this._result(route, triggerType, reason, decision?.providerId ?? null, inbound);
  }

  async _askProvider(inbound, ctx) {
    if (!this.capabilityBus.has(CAPABILITIES.DECISION_GROUP_REPLY)) return null;

    // 规范化输入：Provider 的 wire format 由 manifest 模板翻译，这里不认任何插件字段
    const input = {
      correlationId: inbound.correlationId,
      sessionId: inbound.sessionId,
      messageId: inbound.messageId,
      groupId: inbound.groupId,
      userId: inbound.userId,
      selfId: inbound.selfId,
      displayName: inbound.sender.displayName,
      text: inbound.text,
      rawMessage: inbound.rawMessage,
      messageType: inbound.messageType,
      wakeMode: this.config.wake.mode,
      atBot: inbound.flags.isAtBot,
      isAtBot: inbound.flags.isAtBot,
      isNameCall: inbound.flags.isNameCall,
      isOwner: inbound.flags.isOwner,
    };

    return this.capabilityBus.requestOrNull(CAPABILITIES.DECISION_GROUP_REPLY, input, {
      correlationId: inbound.correlationId,
      sessionId: inbound.sessionId,
      signal: ctx.signal,
    });
  }

  _isRateLimited(inbound) {
    const userId = String(inbound.userId);
    if (!this.rateLimitUsers.has(userId)) return false;

    const count = this.sessions.countRecentReplies(userId);
    const limit = this.config.decision.rateLimit.maxReplies;
    if (count < limit) return false;

    this.log.warn('限流命中，静默忽略', {
      correlationId: inbound.correlationId,
      userId,
      displayName: inbound.sender.displayName,
      count,
      limit,
    });
    return true;
  }

  _result(route, triggerType, reason, providerId, inbound) {
    if (route === ROUTES.IGNORE) {
      this.log.debug('裁决：不回复', { correlationId: inbound.correlationId, reason });
    }
    return { route, triggerType, reason, providerId };
  }

  /**
   * 并发控制与打断特权（附录 1）。
   *
   * 群互斥锁按 executionKey（= 会话维度）。在途生成期间：
   *   - 普通群友的新消息只入缓冲队列排队，不打断
   *   - ruaji 的新消息拥有最高优先级：立即 abort 在途生成并插话
   *
   * @returns {{ action: 'start'|'preempt'|'queue' }}
   */
  arbitrateConcurrency(inbound) {
    const key = inbound.executionKey;
    if (!this.sessions.isBusy(key)) return { action: 'start' };

    if (inbound.flags.isOwner) {
      const preempted = this.sessions.preempt(
        key,
        new PreemptedError('interrupted by newer owner message', {
          correlationId: inbound.correlationId,
        }),
      );
      this.log.info('主人打断特权生效，已中断在途生成', {
        correlationId: inbound.correlationId,
        executionKey: key,
        preempted,
      });
      return { action: 'preempt' };
    }

    this.log.info('该会话已有在途生成，本条消息进入排队缓冲', {
      correlationId: inbound.correlationId,
      executionKey: key,
      userId: inbound.userId,
    });
    return { action: 'queue' };
  }
}
