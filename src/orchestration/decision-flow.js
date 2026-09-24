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
 *   - 限流名单默认 5 次 / 5 分钟滑动窗口，静默忽略
 *   - 主人打断特权、群友排队（附录 1）
 *
 * 频控（2026-09 修复）不在本文件里各自维护名单：名单解析与额度合并全部交给
 * core/rate-limit-policy.js，且**每次裁决现读活配置**。构造期把名单快照成 Set
 * 会让面板保存的改动静默失效——这正是"明明在 rateLimitUsers 里却不限速"的根因之一。
 */

import { CAPABILITIES, ROUTES, TRIGGER_TYPES, normalizeRoute } from '../contracts/capabilities.js';
import { canIntervene, getIdentityRole } from '../core/permission-policy.js';
import { MESSAGE_TYPES } from '../contracts/messages.js';
import { PreemptedError } from '../contracts/errors.js';
import { evaluateRateLimit, resolveRateLimitPolicy } from '../core/rate-limit-policy.js';

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
    /** @see arbitrateConcurrency 的 redirect 分支 */
    this.modelRouter = opts.modelRouter ?? null;
    this.fetch = opts.fetchImpl ?? fetch;
    this.affection = opts.affectionStore ?? null;
  }

  /**
   * @param {object} inbound InboundMessage
   * @param {{ signal?: AbortSignal }} [ctx]
   * @returns {Promise<{ route: string, triggerType: string, reason: string, providerId: string|null }>}
   */
  async decide(inbound, ctx = {}) {
    // 频控闸门先算出来（现读活配置）。它必须在私聊早退之前——否则私聊永远绕过限速；
    // 也要在群聊 route 求出之后二次应用（provider 调用是只读的，照旧让它把这条消息
    // 写进 GCP 滑窗，只是不再回）。
    const limit = this.checkRateLimit(inbound);

    // 私聊恒 direct（除非主人显式把频控也用在私聊上）
    if (inbound.messageType === MESSAGE_TYPES.PRIVATE) {
      if (limit.limited) {
        this._logRateLimitHit(inbound, limit);
        return this._result(ROUTES.IGNORE, TRIGGER_TYPES.AT, IGNORE_REASONS.RATE_LIMITED, null, inbound);
      }
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
    if (route !== ROUTES.IGNORE && limit.limited) {
      this._logRateLimitHit(inbound, limit);
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
      // content = 模型正文（CQ 码已转成 "@昵称"）。GCP 的滑窗缓存写入口
      // （adapters/group_chat_plus_adapter._cache_ignored_message）读的就是它——
      // 只发 text 的话，被忽略的群消息进滑窗时 @小九 就已经丢了。
      content: inbound.content,
      rawMessage: inbound.rawMessage,
      messageType: inbound.messageType,
      // 与 context.enrich 同理：宿主靠它判定会话类型（记忆/图谱的隔离身份）。
      isPrivate: inbound.messageType === MESSAGE_TYPES.PRIVATE,
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

  /**
   * 这个用户当前走哪套额度。不在名单 / 私聊未启用频控 → null。
   * 每次现读 config，面板保存后即时生效（不需要重启，也不需要推送活实例）。
   *
   * @param {object} inbound
   * @returns {{ userId: string, maxReplies: number, windowMs: number, block: boolean }|null}
   */
  rateLimitPolicyFor(inbound) {
    return resolveRateLimitPolicy(inbound?.userId, inbound?.messageType, this.config);
  }

  /**
   * 判定该条消息是否应被频控静默忽略。
   *
   * 判定口径统一在 core/rate-limit-policy.js（阈值、窗口、严格拦截），
   * 本方法只负责把活配置与 SessionStore 接起来。入站层与生成层都调它，
   * 保证"入队时"与"真正生成时"用的是同一把尺子。
   *
   * @param {object} inbound
   * @returns {{ policy: object|null, limited: boolean, blocked: boolean, count: number }}
   */
  checkRateLimit(inbound) {
    return evaluateRateLimit(
      this.rateLimitPolicyFor(inbound),
      (userId, windowMs) => this.sessions.countRecentReplies(userId, windowMs),
    );
  }

  /**
   * @deprecated 保留旧调用点与旧测试的兼容包装，新代码请用 checkRateLimit()。
   * @param {object} inbound
   * @returns {boolean}
   */
  _isRateLimited(inbound) {
    return this.checkRateLimit(inbound).limited;
  }

  _logRateLimitHit(inbound, limit) {
    const { policy, count, blocked } = limit;
    this.log.warn(blocked ? '严格拦截命中，静默忽略' : '限流命中，静默忽略', {
      correlationId: inbound.correlationId,
      userId: policy.userId,
      displayName: inbound.sender?.displayName,
      messageType: inbound.messageType,
      count,
      limit: policy.maxReplies,
      windowMs: policy.windowMs,
      block: blocked,
    });
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
   *   - 非 auto 的主人新消息拥有最高优先级。默认先尝试 Hermes 原生 redirect——
   *     不打断在途轮，把新消息作为"补充修正"并入当前生成（模型请求被取消
   *     重试，已生成前缀保留），成功返回 { action: 'awaiting' }；跑不动
   *     （无在途轮/正在收尾/网络失败/未启用）则回退旧的立即硬打断。
   *     redirect 语义与 Hermes 原生 gateway 的 busy_input_mode=interrupt +
   *     active-turn redirect 完全一致（"↪ Redirected current run"）。
   *   - auto / 外部主动消息不享有介入权，即使发送者是主人或管理员。
   *     没有真 @：直接丢弃；有真 @：排队，不 redirect、不打断。
   *   - 其余群友的新消息只入缓冲队列排队，不打断
   *
   * 丢弃判定放在这里而不是 InboundFlow：仲裁的三条分支必须在同一处决定，
   * 否则外面二次否决会先打出一条"进入排队缓冲"再打一条"放弃本次"，运维看日志
   * 会误判成积压。
   *
   * @param {object} inbound
   * @param {{ route?: string }|null} [decision] 本条消息的裁决结果；外部主动消息另由 proactive 标记识别。
   * @returns {Promise<{ action: 'start'|'preempt'|'queue'|'drop'|'awaiting', redirected?: boolean }>}
   */
  async arbitrateConcurrency(inbound, decision = null) {
    const key = inbound.executionKey;
    await this.sessions.waitForStop(key);
    if (!this.sessions.isBusy(key)) return { action: 'start' };

    const role = getIdentityRole(inbound.userId, this.config.identity);
    const isAuto = decision?.route === ROUTES.AUTO || inbound.extensions?.proactive === true;
    if (!isAuto && canIntervene(role)) {
      const interventionActive = this.sessions.getActive(key);
      if (role === 'admin') {
        const active = this.sessions.getActive(key);
        const gate = await this._checkIntervention(inbound, decision);
        if (!gate.allowed || getIdentityRole(inbound.userId, this.config.identity) !== 'admin') {
          this.log.info('管理员介入未通过门禁', { userId: inbound.userId, reason: gate.reason });
          return { action: 'drop' };
        }
        // Awaiting the host must not grant permission to interrupt a different run.
        if (!this.sessions.isBusy(key)) return { action: 'start' };
        if (this.sessions.getActive(key) !== active) return { action: 'queue' };
      }
      const redirectText = this._redirectTextOf(inbound);
      if (this.config.decision.ownerRedirect !== false && this.modelRouter && redirectText) {
        const active = this.sessions.getActive(key);
        const result = await this.modelRouter.redirect(
          active?.sessionKey ?? key,
          redirectText,
        );
        if (result.ok) {
          this.log.info('管理者补充已并入在途生成（redirect），不打断当前轮', {
            correlationId: inbound.correlationId,
            executionKey: key,
          });
          return { action: 'awaiting', redirected: true };
        }
        this.log.info('redirect 未被接受，回退硬打断', {
          correlationId: inbound.correlationId,
          executionKey: key,
          code: result.code ?? null,
          detail: result.detail ?? null,
        });
      }
      if (role === 'admin' && getIdentityRole(inbound.userId, this.config.identity) !== 'admin') return { action: 'drop' };
      if (!this.sessions.isBusy(key)) return { action: 'start' };
      if (this.sessions.getActive(key) !== interventionActive) return { action: 'queue' };
      const releaseStop = this.sessions.holdForStop(key);
      const preempted = this.sessions.preempt(
        key,
        new PreemptedError('interrupted by newer owner/admin message', {
          correlationId: inbound.correlationId,
        }),
      );
      let stopResult;
      try {
        if (preempted && typeof this.modelRouter?.stop === 'function') {
          stopResult = await this.modelRouter.stop(interventionActive?.sessionKey ?? key, { timeoutMs: 2500 });
        }
      } catch (err) {
        stopResult = { ok: false, code: 'stop_failed', detail: err.message };
      } finally {
        releaseStop();
      }
      this.log.info('管理者介入生效，已中断在途生成', {
        correlationId: inbound.correlationId,
        executionKey: key,
        preempted,
        serverStopAcknowledged: stopResult?.ok === true,
        serverStopCode: stopResult?.code ?? null,
      });
      return { action: 'preempt' };
    }

    // 真 @ 例外与上面的 at_overrides_provider_ignore 是同一个不变量：被点名还不理人
    // 不可接受，即使裁决者把这条标成了 auto，也要排队等下一轮，不能静默丢。
    if (isAuto && !inbound.flags.isAtBot) {
      this.log.info('主动插话遇到在途生成，放弃本次', {
        correlationId: inbound.correlationId,
        executionKey: key,
        userId: inbound.userId,
      });
      return { action: 'drop' };
    }

    this.log.info('该会话已有在途生成，本条消息进入排队缓冲', {
      correlationId: inbound.correlationId,
      executionKey: key,
      userId: inbound.userId,
    });
    return { action: 'queue' };
  }

  async _checkIntervention(inbound, decision) {
    if (!this.config.favourUltraEnabled && this.affection?.isColdViolent(inbound.userId)) {
      return { allowed: false, reason: 'cold_violence' };
    }
    const baseUrl = this.config.unifiedHost?.baseUrl;
    if (!baseUrl) return { allowed: !this.config.favourUltraEnabled, reason: 'host_unavailable' };
    try {
      const res = await this.fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/reply/preflight`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: inbound.userId, groupId: inbound.groupId, messageId: inbound.messageId,
          text: inbound.text, content: inbound.content, selfId: inbound.selfId,
          displayName: inbound.sender?.displayName, isPrivate: inbound.messageType === MESSAGE_TYPES.PRIVATE,
          atBot: inbound.flags.isAtBot, triggerType: decision?.triggerType || 'at',
          requireFavour: this.config.favourUltraEnabled === true,
        }),
        signal: AbortSignal.timeout(2500),
      });
      const gate = await res.json();
      return { allowed: res.ok && gate?.ok === true && gate?.allowed === true, reason: gate?.reason || 'preflight' };
    } catch (err) {
      this.log.warn('管理员介入门禁检查失败', { error: err.message });
      return { allowed: false, reason: 'preflight_failed' };
    }
  }

  /**
   * redirect 用的人话文本：带 OneBot at 段的原文对模型没有意义，
   * 取 text（已去掉 CQ 码）；若存在引用消息则拼接引用摘要；没有就退 content。
   * 图片按桥接标准契约 inbound.media（segments 兜底）转成 `[图片: url]`，
   * 纯图片无文字时也能产出合法文本，不会因空文本返回 null 而丢失介入。
   * 前缀主人/管理员身份——在途轮可能是回别人的，裸文本会被模型误认为是
   * 该轮发起者说的；标明介入者身份（昵称+id）让模型正确归因。
   */
  _redirectTextOf(inbound) {
    const quoteSummary = inbound.extensions?.quote?.summary;
    let text = String(inbound.text ?? '').trim();
    if (!text) {
      const content = String(inbound.content ?? '').trim();
      if (content && content !== '[图片消息]' && content !== '[文件消息]') text = content;
    }

    const parts = [quoteSummary, text, ...imageTokensOf(inbound)].filter(Boolean);
    if (parts.length === 0) return null;
    const body = parts.join(' ');

    const role = getIdentityRole(inbound.userId, this.config.identity);
    if (!canIntervene(role)) return body;
    const name = inbound.sender?.displayName || inbound.sender?.nickname || inbound.userId;
    const ownerTitle = role === 'admin' ? '管理员' : (this.config.identity?.ownerTitle || '主人');
    return `【${ownerTitle}介入】${name}(ID:${inbound.userId})在你回复期间补充：${body}`;
  }
}

/**
 * 本条消息的图片标记。数据源是桥接标准契约：media（媒体落盘记录）优先，
 * segments（NapCat 分段）兜底；origin === 'quote' 的图片属于被引用者，不算本条补充。
 */
function imageTokensOf(inbound) {
  const own = (inbound.media ?? []).filter((m) => isImageMedia(m) && m.origin !== 'quote');
  const items = own.length > 0
    ? own
    : (inbound.segments ?? [])
        .filter((s) => s?.type === 'image' || s?.type === 'mface' || s?.type === 'marketface')
        .map((s) => ({ url: s.data?.url, localPath: s.data?.file }));

  const tokens = items.map((m) => {
    const target = m.url || m.localPath;
    return target ? `[图片: ${asImageUrl(target)}]` : '[图片]';
  });
  return [...new Set(tokens)];
}

function isImageMedia(m) {
  return m?.kind === 'image' || m?.type === 'image';
}

/** 无协议的本地落盘路径转成 file:/// URL，模型侧工具才能直接读。 */
function asImageUrl(target) {
  const s = String(target);
  return /^(https?:|data:|file:)/.test(s) ? s : `file:///${s.replace(/\\/g, '/')}`;
}
