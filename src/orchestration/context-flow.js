/**
 * orchestration/context-flow.js — 上下文收集
 *
 * 把三条旧路径合并成一次聚合：
 *   GCP 远程上下文（HTTP Provider，manifest 注册）
 *   本地滑窗兜底（local provider，优先级低于 GCP）
 *   语气画像 / 黑话 / 表情包规则（local provider，进 systemText 的不同 slot）
 *
 * 关键差异：旧 Bridge 是 "GCP 可用就用 GCP，否则用本地"（bridge.js:1695 的
 * 三元表达式）。v2 交给 ContextAggregator 按 priority + 去重 + 预算统一决策，
 * 两者都拿到就按行去重合并，GCP 挂了本地照样有内容。
 */

import { CONTEXT_SCOPES, createContextBlock } from '../contracts/context-block.js';
import { mergeContextLines } from '../core/context-aggregator.js';
import { MESSAGE_TYPES } from '../contracts/messages.js';
import { renderLocalMediaHint } from './prompt-renderer.js';

export class ContextFlow {
  /**
   * @param {object} opts
   * @param {import('../core/context-aggregator.js').ContextAggregator} opts.aggregator
   * @param {import('../storage/session-store.js').SessionStore} opts.sessionStore
   * @param {import('../storage/affection-store.js').AffectionStore} opts.affectionStore
   * @param {import('../storage/portrayal-store.js').PortrayalStore} [opts.portrayalStore]
   * @param {import('./portrayal-worker.js').PortrayalWorker} [opts.portrayalWorker]
   * @param {import('../storage/meme-store.js').MemeStore} [opts.memeStore]
   * @param {object} opts.config
   * @param {import('../core/logger.js').Logger} opts.logger
   */
  constructor(opts = {}) {
    this.aggregator = opts.aggregator;
    this.sessions = opts.sessionStore;
    this.affection = opts.affectionStore;
    this.portrayal = opts.portrayalStore ?? null;
    this.portrayalWorker = opts.portrayalWorker ?? null;
    this.memeStore = opts.memeStore ?? null;
    this.config = opts.config;
    this.log = opts.logger?.child({ component: 'context-flow' }) ?? console;
    /** 可选：运维面板的追踪采集器，不注入就是 null，行为不变 */
    this.trace = opts.traceCollector ?? null;
    this._registerLocalProviders();
  }

  _registerLocalProviders() {
    // 表情包语义工具规则：指导模型调用 search_memes 工具与输出 &&meme:ID&&
    this.aggregator.registerLocal({
      id: 'meme-rules',
      priority: 75,
      collect: () => {
        const text = this.memeStore?.getSemanticToolPrompt?.();
        if (!text) return [];
        return [
          createContextBlock({
            source: 'meme-rules',
            priority: 75,
            text,
            metadata: { slot: 'meme' },
          }),
        ];
      },
    });

    // 本地群聊滑窗：GCP 不可用时的兜底，优先级低于远程（远程 90）
    this.aggregator.registerLocal({
      id: 'local-window',
      priority: 60,
      collect: (input) => {
        if (input.messageType !== MESSAGE_TYPES.GROUP) return [];
        const excludeId = input.inbound?.messageId ?? input.messageId;
        const text = this.sessions.renderContext(input.sessionId, this.config.decision.localWindowInject, excludeId);
        if (!text) return [];
        return [
          createContextBlock({
            source: 'local-window',
            priority: 60,
            text,
            scope: CONTEXT_SCOPES.GROUP,
            // 与远程上下文同 key：两者都在时按优先级留一个，另一个进 dropped
            dedupeKey: 'recent-group-context',
            metadata: { slot: 'recent' },
          }),
        ];
      },
    });

    // 本地媒体清单：让模型知道本轮附带的文件在本地什么路径（附录 2）
    this.aggregator.registerLocal({
      id: 'local-media',
      priority: 70,
      collect: (input) => {
        const hint = renderLocalMediaHint(input.inbound ?? {});
        if (!hint) return [];
        return [
          createContextBlock({
            source: 'local-media',
            priority: 70,
            text: hint,
            metadata: { slot: 'extra' },
          }),
        ];
      },
    });
  }

  /**
   * @param {object} inbound
   * @param {{ triggerType: string, signal?: AbortSignal }} ctx
   * @returns {Promise<{ blocks: object[], stats: object }>}
   */
  async collect(inbound, ctx = {}) {
    const input = {
      correlationId: inbound.correlationId,
      sessionId: inbound.sessionId,
      messageId: inbound.messageId,
      groupId: inbound.groupId,
      userId: inbound.userId,
      selfId: inbound.selfId,
      displayName: inbound.sender.displayName,
      text: inbound.text,
      // 与 decision-flow 同理：宿主 build_event 的 Plain 链来自 content 优先，
      // GCP 钩子看到"@昵称 正文"而不是被洗掉 CQ 的裸文本。
      content: inbound.content,
      rawMessage: inbound.rawMessage,
      messageType: inbound.messageType,
      atBot: inbound.flags.isAtBot,
      isAtBot: inbound.flags.isAtBot,
      isOwner: inbound.flags.isOwner,
      triggerType: ctx.triggerType,
      /** 仅本地 provider 可见的完整对象，HTTP provider 走模板取不到它 */
      inbound,
    };

    const scope =
      inbound.messageType === MESSAGE_TYPES.GROUP ? CONTEXT_SCOPES.GROUP : CONTEXT_SCOPES.PRIVATE;

    const { blocks, stats, dropped } = await this.aggregator.aggregate(input, {
      correlationId: inbound.correlationId,
      sessionId: inbound.sessionId,
      signal: ctx.signal,
      scope,
    });

    this.log.debug('上下文聚合完成', { correlationId: inbound.correlationId, ...stats });
    this.trace?.recordContext(inbound.correlationId, { blocks, stats, dropped });
    return { blocks, stats };
  }

  /**
   * 好感度与画像复合上下文。主人与主动接话都返回 null——
   * 主人恒 100 不评估（附录 1），主动接话不构成与群友的互动。
   */
  getAffectionContext(inbound, triggerType) {
    if (inbound.flags.isOwner) return null;
    if (triggerType === 'ai_decision') return null;
    try {
      const aff = this.affection.getContext(inbound.userId);
      const port = this.portrayal ? this.portrayal.getCompactContext(inbound.userId) : '';
      return {
        ...aff,
        portrayal: port,
      };
    } catch (err) {
      this.log.warn('好感度上下文读取失败，本轮不注入', { error: err.message });
      return null;
    }
  }

  /** 把消息记入本地滑窗。裁决之前就要记，否则被忽略的消息不会进上下文。 */
  recordToWindow(inbound) {
    if (inbound.messageType !== MESSAGE_TYPES.GROUP) return;
    // 用 content（"@昵称 揉揉"）而不是 text（"揉揉"）：滑窗是喂给模型的
    // 群聊背景，@ 信息不能在记录这一步就丢掉。
    const windowText = inbound.content || inbound.text;
    if (!windowText) return;
    this.sessions.recordContext(inbound.sessionId, {
      messageId: inbound.messageId,
      nickname: inbound.sender.displayName,
      text: windowText,
      userId: inbound.userId,
    });

    // 群友/用户发言计数与自动化画像分析调度（portrayal.enabled=false 时整段关掉）
    if (
      this.config.portrayal?.enabled !== false &&
      this.portrayal &&
      inbound.userId &&
      inbound.userId !== String(this.config.identity.robotId)
    ) {
      try {
        this.portrayal.recordUserMessage(inbound.userId, inbound.sender.displayName, inbound.text);
        if (this.portrayalWorker) {
          const recent = this.portrayal.getUserRecentMessages(inbound.userId);
          this.portrayalWorker.scheduleAutoAnalysis({
            userId: inbound.userId,
            nickname: inbound.sender.displayName,
            recentMessages: recent,
          });
        }
      } catch (err) {
        this.log.warn('自动化画像调度异常', { error: err.message });
      }
    }
  }
}

export { mergeContextLines };
