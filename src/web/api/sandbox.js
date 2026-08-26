/**
 * web/api/sandbox.js — 离线管线沙箱
 *
 * 在页面上捏一条虚拟 QQ 消息，走**真实**的编排组件跑一遍，把每一步摊开：
 *   Inbound 规范化 → GCP 裁决 → 上下文聚合 → System Prompt 全文
 *   → LLM 回复 → Middleware 处理前后的最终 Payload
 *
 * 三条硬约束：
 *
 * 1. 用真组件，不做平行实现。
 *    沙箱调用的是容器里那个 InboundNormalizer / DecisionFlow / ContextFlow /
 *    PromptRenderer / MiddlewarePipeline 实例本身。任何"为了好演示"另写一份
 *    简化逻辑的做法，都会让沙箱在最需要它的��候（线上行为和预期不一致时）
 *    给出错误答案。
 *
 * 2. 永不投递。
 *    绝不碰 Sender。中间件产出的 OutboundMessage 只组装、不入队。
 *    这一条比配置里的 sendEnabled 更硬 —— 就算有人把 Bridge 切到 live，
 *    在面板上点"单步执行"也不该往群里发东西。
 *
 * 3. 副作用默认关。
 *    好感度中间件在 isFinalPass 轮会写库。沙箱默认不跑收尾轮
 *    （runFinalPass=false），要跑得显式勾选，且结果里会标出它写了什么。
 */

import { newCorrelationId } from '../../contracts/events.js';
import {
  MESSAGE_TYPES,
  createModelRequest,
  createOutboundMessage,
} from '../../contracts/messages.js';
import { RESPONSE_TRANSFORM, createTransformContext } from '../../middleware/index.js';
import {
  renderSystemText,
  renderUserMessage,
  renderUserContent,
} from '../../orchestration/prompt-renderer.js';
import { splitIntoSegments } from '../../orchestration/sentence-splitter.js';
import { buildNapcatPayload } from '../../adapters/napcat/outbound-builder.js';
import { classifyError } from '../../contracts/errors.js';

export function createSandboxApi(deps) {
  const {
    config,
    normalizer,
    decisionFlow,
    contextFlow,
    modelRouter,
    pipeline,
    traceCollector,
    logger,
  } = deps;
  const log = logger?.child({ component: 'web-sandbox' }) ?? console;

  return {
    /** 表单元数据：让前端不必把 identity/wake 这些再抄一遍 */
    'GET /api/sandbox/defaults': async () => ({
      body: {
        identity: {
          ownerId: config.identity.ownerId,
          robotId: config.identity.robotId,
          botName: config.identity.botName,
        },
        wake: config.wake,
        mode: config.mode,
        sendEnabled: config.reply.sendEnabled,
        sideEffectsEnabled: config.reply.sideEffectsEnabled,
        middlewareOrder: pipeline.getOrder(RESPONSE_TRANSFORM),
        modelName: config.model.model,
        sample: {
          messageType: 'group',
          groupId: '707423412',
          userId: config.identity.ownerId,
          nickname: 'ruaji(阵亡)',
          text: '瑞姬，帮我看看这段配置',
          isAtBot: true,
        },
      },
    }),

    /**
     * 单步执行。
     * body: {
     *   messageType: 'group'|'private', groupId, userId, nickname, card,
     *   text, isAtBot,
     *   callModel?: boolean,        默认 false —— 离线环境不打真实模型
     *   mockReply?: string,         callModel=false 时用它当模型输出
     *   runFinalPass?: boolean      默认 false，跑了才会触发好感度写入
     * }
     */
    'POST /api/sandbox/run': async ({ body }) => {
      const started = Date.now();
      const correlationId = newCorrelationId();
      const steps = [];
      const stage = async (name, fn) => {
        const t0 = Date.now();
        try {
          const value = await fn();
          steps.push({ name, ok: true, elapsedMs: Date.now() - t0 });
          return value;
        } catch (err) {
          const classified = classifyError(err, correlationId);
          steps.push({ name, ok: false, elapsedMs: Date.now() - t0, error: classified.message });
          throw err;
        }
      };

      try {
        // ── 1. 构造 NapCat 原始事件并走真实规范化 ──────────────────
        const rawEvent = buildNapcatEvent(body, config);
        const { message: inbound, dropped } = await stage('inbound.normalize', () =>
          normalizer.normalize(rawEvent, { correlationId }),
        );

        if (!inbound) {
          return {
            body: {
              correlationId,
              ok: false,
              droppedAt: 'inbound.normalize',
              droppedReason: dropped,
              rawEvent,
              steps,
              note: dropped === 'self_message'
                ? '发送人 QQ 与 identity.robotId 相同，主链路会把它当成机器人自己的消息丢掉'
                : '规范化阶段就被丢弃，后续步骤不会执行',
            },
          };
        }

        // ── 2. 裁决 ───────────────────────────────────────────────
        const decision = await stage('decision.decide', () => decisionFlow.decide(inbound));

        // ── 3. 上下文聚合 ─────────────────────────────────────────
        const { blocks, stats } = await stage('context.collect', () =>
          contextFlow.collect(inbound, { triggerType: decision.triggerType }),
        );
        const affectionContext = contextFlow.getAffectionContext(inbound, decision.triggerType);

        // ── 4. Prompt 渲染 ────────────────────────────────────────
        const systemText = renderSystemText({
          inbound,
          contextBlocks: blocks,
          triggerType: decision.triggerType,
          affectionContext,
          identity: config.identity,
        });
        const userMessage = renderUserMessage({
          inbound,
          contextBlocks: blocks,
          identity: config.identity,
        });
        const messages = [];
        if (systemText && systemText.trim()) {
          messages.push({ role: 'system', content: systemText.trim() });
        }
        messages.push({ role: 'user', content: userMessage });

        const modelRequest = createModelRequest({
          correlationId,
          sessionId: inbound.sessionId,
          sessionKey: inbound.executionKey,
          model: config.model.model,
          messages,
          contextBlocks: blocks,
          stream: false,
        });

        // 裁决为 ignore 时主链路不会生成，沙箱如实停在这里
        if (decision.route === 'ignore') {
          return {
            body: buildResult({
              correlationId,
              started,
              steps,
              rawEvent,
              inbound,
              decision,
              blocks,
              stats,
              affectionContext,
              systemText,
              userMessage,
              modelRequest,
              reply: null,
              segments: [],
              stoppedAt: 'decision',
              note: `裁决为 ignore（${decision.reason}），主链路到此为止，不会调用模型`,
            }),
          };
        }

        // ── 5. 模型 ───────────────────────────────────────────────
        const callModel = body?.callModel === true;
        let reply = null;
        if (callModel) {
          const response = await stage('model.generate', () => modelRouter.generate(modelRequest, {}));
          reply = {
            source: 'model',
            rawText: response.rawText,
            model: response.model,
            latencyMs: response.latencyMs,
            usage: response.usage ?? null,
          };
        } else {
          reply = {
            source: 'mock',
            rawText: String(body?.mockReply ?? '好的，我看看。\n\n配置没问题，直接跑就行。'),
            model: '(未调用模型)',
            latencyMs: 0,
            usage: null,
          };
        }

        // ── 6. 切句 + Middleware ─────────────────────────────────
        const rawSegments = splitIntoSegments(reply.rawText);
        const segments = [];
        let isFirst = true;

        for (const [index, segmentText] of rawSegments.entries()) {
          const ctx = createTransformContext({
            correlationId,
            sessionId: inbound.sessionId,
            inbound,
            text: segmentText,
            rawText: reply.rawText,
            responseId: null,
            triggerType: decision.triggerType,
            isFinalPass: false,
          });

          const out = await stage(`middleware.segment[${index}]`, () =>
            pipeline.run(RESPONSE_TRANSFORM, ctx),
          );

          const finalText = [out.text, ...(out.attachments ?? [])]
            .filter((s) => s && String(s).trim())
            .join('\n');

          // 组装最终 Payload，但**绝不入队**
          const outbound = createOutboundMessage({
            correlationId,
            sessionId: inbound.sessionId,
            target: {
              type: inbound.messageType,
              id: inbound.messageType === MESSAGE_TYPES.GROUP ? inbound.groupId : inbound.userId,
            },
            replyToUserId: inbound.userId,
            text: finalText,
            metadata: { isFirst, disableAutoMention: decision.triggerType === 'ai_decision' },
          });

          segments.push({
            index,
            before: segmentText,
            after: out.text,
            attachments: out.attachments ?? [],
            finalText,
            skipped: !finalText.trim(),
            cancelled: out.cancelled === true,
            suppressedSideEffects: out.suppressedSideEffects ?? [],
            napcatPayload: safeBuildPayload(outbound, log),
          });

          if (finalText.trim()) isFirst = false;
        }

        // ── 7. 可选收尾轮（副作用在这里发生） ─────────────────────
        let finalPass = null;
        if (body?.runFinalPass === true) {
          const ctx = createTransformContext({
            correlationId,
            sessionId: inbound.sessionId,
            inbound,
            text: '',
            rawText: reply.rawText,
            responseId: null,
            triggerType: decision.triggerType,
            isFinalPass: true,
          });
          const out = await stage('middleware.finalPass', () => pipeline.run(RESPONSE_TRANSFORM, ctx));
          finalPass = {
            suppressedSideEffects: out.suppressedSideEffects ?? [],
            note: config.reply.sideEffectsEnabled
              ? '副作用已真实执行（好感度已写入）'
              : '副作用被影子模式抑制，只记录未落盘',
          };
        }

        return {
          body: buildResult({
            correlationId,
            started,
            steps,
            rawEvent,
            inbound,
            decision,
            blocks,
            stats,
            affectionContext,
            systemText,
            userMessage,
            modelRequest,
            reply,
            segments,
            finalPass,
            stoppedAt: null,
            note: callModel
              ? null
              : '未调用真实模型：mockReply 直接当作模型输出注入切句与 Middleware',
          }),
        };
      } catch (err) {
        const classified = classifyError(err, correlationId);
        log.warn('沙箱执行失败', { correlationId, error: classified.message });
        traceCollector?.recordError(correlationId, classified.message);
        return {
          status: 500,
          body: { correlationId, ok: false, error: classified.message, kind: classified.kind, steps },
        };
      }
    },
  };
}

/** 把表单字段拼成一条 NapCat WebSocket 会推过来的原始事件 */
function buildNapcatEvent(body, config) {
  const isGroup = (body?.messageType ?? 'group') === 'group';
  const userId = String(body?.userId ?? config.identity.ownerId ?? '10001');
  const nickname = String(body?.nickname ?? '沙箱用户');
  const text = String(body?.text ?? '');
  const atTag = `[CQ:at,qq=${config.identity.robotId}]`;
  const rawMessage = isGroup && body?.isAtBot === true ? `${atTag} ${text}` : text;

  return {
    post_type: 'message',
    message_type: isGroup ? 'group' : 'private',
    sub_type: isGroup ? 'normal' : 'friend',
    message_id: Number(body?.messageId) || Date.now() % 2147483647,
    self_id: Number(config.identity.robotId),
    user_id: Number(userId) || userId,
    group_id: isGroup ? Number(body?.groupId ?? 0) || 707423412 : undefined,
    time: Math.floor(Date.now() / 1000),
    raw_message: rawMessage,
    sender: {
      user_id: Number(userId) || userId,
      nickname,
      card: String(body?.card ?? ''),
      role: String(userId) === String(config.identity.ownerId) ? 'owner' : 'member',
    },
  };
}

/** buildNapcatPayload 对空文本返回 null，这里如实透出而不是伪造一个空 payload */
function safeBuildPayload(outbound, log) {
  try {
    return buildNapcatPayload(outbound);
  } catch (err) {
    log.debug('沙箱组装 NapCat Payload 失败', { error: err.message });
    return { error: err.message };
  }
}

function buildResult(p) {
  return {
    correlationId: p.correlationId,
    ok: true,
    elapsedMs: Date.now() - p.started,
    stoppedAt: p.stoppedAt,
    note: p.note,
    steps: p.steps,

    rawEvent: p.rawEvent,

    inbound: {
      messageId: p.inbound.messageId,
      sessionId: p.inbound.sessionId,
      executionKey: p.inbound.executionKey,
      messageType: p.inbound.messageType,
      userId: p.inbound.userId,
      groupId: p.inbound.groupId,
      sender: p.inbound.sender,
      rawMessage: p.inbound.rawMessage,
      text: p.inbound.text,
      content: p.inbound.content,
      flags: p.inbound.flags,
      media: p.inbound.media,
      segmentCount: (p.inbound.segments ?? []).length,
    },

    decision: p.decision,

    context: {
      stats: p.stats,
      affection: p.affectionContext,
      blocks: (p.blocks ?? []).map((b) => ({
        source: b.source,
        priority: b.priority,
        scope: b.scope,
        slot: b.metadata?.slot ?? 'extra',
        chars: (b.text ?? '').length,
        truncatedReason: b.truncatedReason ?? null,
        text: b.text,
      })),
    },

    prompt: {
      systemText: p.systemText,
      systemTextChars: (p.systemText ?? '').length,
      userMessage: p.userMessage,
      userMessageChars: (p.userMessage ?? '').length,
      messages: p.modelRequest.messages,
    },

    reply: p.reply,
    segments: p.segments,
    finalPass: p.finalPass ?? null,

    delivery: {
      enqueued: false,
      reason: '沙箱从不接触 Sender —— 组装出的 Payload 仅用于展示',
    },
  };
}

export { renderUserContent };
