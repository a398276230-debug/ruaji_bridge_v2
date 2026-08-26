/**
 * app/container.js — 依赖装配
 *
 * 所有组件在这里构造并注入依赖。模块层不允许有可变全局状态——旧 Bridge 的
 * groupContextBuffer / userLocks / activeControllers / sendQueue 全是模块级
 * 全局变量，导致任何一段逻辑都可能改到任何一处状态，也没法单测。
 *
 * 构造顺序即依赖顺序，不做惰性解析：装配期就能发现循环依赖。
 */

import fs from 'node:fs';

import { createLogger } from '../core/logger.js';
import { EventBus } from '../core/event-bus.js';
import { CapabilityBus } from '../core/capability-bus.js';
import { PluginRegistry } from '../core/plugin-registry.js';
import { ContextAggregator } from '../core/context-aggregator.js';
import { IdempotencyStore } from '../core/idempotency-store.js';
import { HealthManager } from '../core/health-manager.js';

import { NapcatApi } from '../adapters/napcat/napcat-api.js';
import { NapcatWebSocketClient } from '../adapters/napcat/websocket-client.js';
import { MediaIngestor } from '../adapters/napcat/media-ingestor.js';
import { InboundNormalizer } from '../adapters/napcat/inbound-normalizer.js';
import { Sender } from '../adapters/napcat/sender.js';
import { createModelAdapter, ModelRouter } from '../adapters/model/model-router.js';
import { OpenAiCompatibleAdapter } from '../adapters/model/openai-compatible.js';

import { AffectionStore } from '../storage/affection-store.js';
import { PortrayalStore } from '../storage/portrayal-store.js';
import { MemeStore } from '../storage/meme-store.js';
import { SessionStore } from '../storage/session-store.js';
import { DedupStore } from '../storage/dedup-store.js';
import { SendQueueStore } from '../storage/send-queue-store.js';

import { buildMiddlewarePipeline } from '../middleware/index.js';
import { DecisionFlow } from '../orchestration/decision-flow.js';
import { ContextFlow } from '../orchestration/context-flow.js';
import { PortrayalWorker } from '../orchestration/portrayal-worker.js';
import { ReplyFlow } from '../orchestration/reply-flow.js';
import { CommandFlow } from '../orchestration/command-flow.js';
import { InboundFlow } from '../orchestration/inbound-flow.js';
import { FastAckDispatcher } from '../orchestration/fast-ack.js';
import { Mem0Ingestor } from '../orchestration/mem0-ingestor.js';
import { ShadowRecorder } from '../shadow/comparator.js';
import { TraceCollector } from '../web/trace-collector.js';
import { WebServer } from '../web/server.js';

/**
 * @param {object} config  loadConfig() 的产物
 * @param {object} [overrides] 测试注入点：{ fetchImpl, WebSocketImpl, modelAdapter, logger }
 */
export function createContainer(config, overrides = {}) {
  const logger = overrides.logger ?? createLogger(config, config.paths.rootDir);
  const fetchImpl = overrides.fetchImpl;

  try { fs.mkdirSync(config.paths.cacheDir, { recursive: true }); } catch { /* ignore */ }

  // ===== 核心总线 =====
  const idempotency = new IdempotencyStore();
  const eventBus = new EventBus({ logger, idempotency });
  const capabilityBus = new CapabilityBus({ logger });
  const pluginRegistry = new PluginRegistry({ eventBus, capabilityBus, logger, fetchImpl });
  const health = new HealthManager({ config, logger, pluginRegistry });

  // 运维面板的追踪采集器。构造总是发生（一个环形缓冲，成本可忽略），
  // 但只有 web.enabled 时才挂到总线上 —— 关掉面板就该是彻底零开销。
  const traceCollector = new TraceCollector({ maxTraces: config.web?.maxTraces ?? 200 });

  // ===== 存储 =====
  const affectionStore = new AffectionStore({
    file: config.paths.affectionFile,
    ownerId: config.identity.ownerId,
    robotId: config.identity.robotId,
    persistEnabled: config.reply.sideEffectsEnabled,
    logger,
  });
  const portrayalStore = new PortrayalStore({
    file: config.paths.portrayalFile,
    blacklistUsers: config.portrayal.blacklistUsers,
    msgInterval: config.portrayal.msgInterval,
    initialThreshold: config.portrayal.initialThreshold,
    cooldownMs: config.portrayal.cooldownHours * 60 * 60 * 1000,
    persistEnabled: config.reply.sideEffectsEnabled,
    logger,
  });
  const memeStore = new MemeStore({
    dataFile: config.paths.memeDataFile,
    memeRoot: config.paths.memeRoot,
    logger,
    config,
  });
  const sessionStore = new SessionStore({
    windowSize: config.decision.localWindowSize,
    rateLimitWindowMs: config.decision.rateLimit.windowMs,
  });
  const dedupStore = new DedupStore();
  const sendQueueStore = new SendQueueStore({
    cacheDir: config.paths.cacheDir,
    maxAgeMs: config.reply.maxSendAgeMs,
    logger,
  });

  // ===== NapCat 适配 =====
  const napcatApi = new NapcatApi({
    httpUrl: config.napcat.httpUrl,
    accessToken: config.secrets.napcatAccessToken,
    requestTimeoutMs: config.napcat.requestTimeoutMs,
    sendTimeoutMs: config.napcat.sendTimeoutMs,
    logger,
    fetchImpl,
  });
  const mediaIngestor = new MediaIngestor({
    napcatApi,
    imagesDir: config.paths.receivedImagesDir,
    filesDir: config.paths.receivedFilesDir,
    logger,
    fetchImpl,
  });
  const normalizer = new InboundNormalizer({
    identity: config.identity,
    wake: config.wake,
    mediaIngestor,
    napcatApi,
    logger,
  });
  const websocket = new NapcatWebSocketClient({
    wsUrl: config.napcat.wsUrl,
    accessToken: config.secrets.napcatAccessToken,
    minBackoffMs: config.napcat.reconnect.minBackoffMs,
    maxBackoffMs: config.napcat.reconnect.maxBackoffMs,
    logger,
    WebSocketImpl: overrides.WebSocketImpl,
  });
  const sender = new Sender({
    napcatApi,
    store: sendQueueStore,
    eventBus,
    idempotency,
    health,
    config,
    logger,
  });

  // ===== 模型 =====
  const modelAdapter = overrides.modelAdapter ?? createModelAdapter(config, { logger, fetchImpl });
  const modelRouter = new ModelRouter({ defaultAdapter: modelAdapter, logger });

  // 画像分析可单独指一个更轻量的 endpoint；不填 baseUrl 就继续走主对话模型。
  // 走 ModelRouter 预留的 addRule，按 sessionKey 前缀分流（见 portrayal-worker 的请求构造）。
  if (config.portrayal.baseUrl) {
    const portrayalAdapter = overrides.portrayalAdapter ?? new OpenAiCompatibleAdapter({
      baseUrl: config.portrayal.baseUrl,
      model: config.portrayal.model || config.model.model,
      apiKey: config.secrets.portrayalApiKey ?? '',
      sessionHeader: config.model.sessionHeader,
      sessionPrefix: config.model.sessionPrefix,
      timeoutMs: config.model.timeoutMs,
      maxRetries: config.model.maxRetries,
      logger,
      fetchImpl,
    });
    modelRouter.addRule((req) => (String(req.sessionKey ?? '').startsWith('portrayal_') ? portrayalAdapter : null));
    logger.info('画像分析已启用独立模型通道', {
      baseUrl: config.portrayal.baseUrl,
      model: config.portrayal.model || config.model.model,
    });
  }

  const portrayalWorker = new PortrayalWorker({
    portrayalStore,
    affectionStore,
    modelRouter,
    config,
    rootDir: config.paths.rootDir,
    logger,
  });

  // ===== 编排 =====
  const contextAggregator = new ContextAggregator({
    capabilityBus,
    logger,
    totalCharacterBudget: config.context.totalCharacterBudget,
    perSourceCharacterBudget: config.context.perSourceCharacterBudget,
    collectTimeoutMs: config.context.collectTimeoutMs,
  });
  const contextFlow = new ContextFlow({
    aggregator: contextAggregator,
    sessionStore,
    affectionStore,
    portrayalStore,
    portrayalWorker,
    config,
    logger,
    traceCollector,
  });
  const pipeline = buildMiddlewarePipeline({
    config,
    logger,
    affectionStore,
    memeStore,
    idempotency,
    capabilityBus,
  });
  const fastAck = new FastAckDispatcher({ config, logger });
  const replyFlow = new ReplyFlow({
    modelRouter,
    pipeline,
    sender,
    eventBus,
    contextFlow,
    sessionStore,
    health,
    config,
    logger,
    fastAck,
  });
  const decisionFlow = new DecisionFlow({
    capabilityBus,
    sessionStore,
    normalizer,
    config,
    logger,
  });
  const commandFlow = new CommandFlow({
    modelRouter,
    affectionStore,
    portrayalStore,
    portrayalWorker,
    sessionStore,
    memeStore,
    sender,
    config,
    logger,
  });
  const shadowRecorder = new ShadowRecorder({
    shadowDir: config.paths.shadowDir,
    config,
    logger,
  });
  // 只构造，不 start()。容器的职责是接线；订阅事件总线属于生命周期动作，
  // 放在 lifecycle.start() 里，才有对应的 stop() 能把它关掉。
  const mem0Ingestor = new Mem0Ingestor({
    eventBus,
    config,
    logger,
    fetchImpl,
  });
  const inboundFlow = new InboundFlow({
    normalizer,
    dedupStore,
    sessionStore,
    eventBus,
    decisionFlow,
    contextFlow,
    replyFlow,
    commandFlow,
    affectionStore,
    memeStore,
    health,
    shadowRecorder,
    traceCollector,
    config,
    logger,
  });

  const container = {
    config,
    logger,
    fetchImpl,
    // core
    eventBus,
    capabilityBus,
    pluginRegistry,
    contextAggregator,
    idempotency,
    health,
    traceCollector,
    // storage
    affectionStore,
    portrayalStore,
    memeStore,
    sessionStore,
    dedupStore,
    sendQueueStore,
    // adapters
    napcatApi,
    mediaIngestor,
    normalizer,
    websocket,
    sender,
    modelAdapter,
    modelRouter,
    // orchestration
    pipeline,
    contextFlow,
    decisionFlow,
    replyFlow,
    commandFlow,
    portrayalWorker,
    inboundFlow,
    fastAck,
    mem0Ingestor,
    shadowRecorder,
  };

  // 面板依赖整个容器，所以必须最后装配。挂观察者也放在这里：
  // 关掉 web 时两条总线的 observer 保持 null，热路径上连一次判空都省了。
  if (config.web?.enabled !== false) {
    traceCollector.attach({ eventBus, capabilityBus, pipeline });
    container.webServer = new WebServer(container);
  } else {
    container.webServer = null;
  }

  return container;
}
