/**
 * core/config.js — 配置加载
 *
 * 优先级：环境变量 > bridge.config.json > 安全默认值
 *
 * 与旧 Bridge 的关键差异：密钥只从环境变量读取。旧 config.json 把 Hermes
 * apiKey 明文写在仓库里的文件中；v2 配置里只放 `*Env` 字段指向环境变量名，
 * 真实密钥永远不落配置文件、不进日志。
 */

import fs from 'node:fs';
import path from 'node:path';
import { ConfigError } from '../contracts/errors.js';

const DEFAULTS = {
  mode: 'live',
  identity: { ownerId: '', adminIds: [], adminCommands: [], robotId: '', botName: '瑞姬', ownerTitle: '主人', rateLimitUsers: [], privateWhitelist: [], groupWhitelist: [] },
  napcat: {
    wsUrl: 'ws://127.0.0.1:3001',
    httpUrl: 'http://127.0.0.1:3000',
    accessTokenEnv: 'NAPCAT_ACCESS_TOKEN',
    reconnect: { minBackoffMs: 1000, maxBackoffMs: 60000 },
    requestTimeoutMs: 8000,
    sendTimeoutMs: 30000,
    inputStatusEnabled: true,
  },
  model: {
    provider: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8642/v1',
    model: 'hermes-agent',
    apiKeyEnv: 'HERMES_API_KEY',
    sessionHeader: 'X-Hermes-Session-Id',
    sessionPrefix: 'qq_',
    sessionCutoffHour: 7,
    sessionRotationsPerDay: 1,
    timeoutMs: 1800000,
    stream: true,
    maxRetries: 0,
  },
  wake: { mode: 'both', namePattern: '(^|[\\s，,。.!！?？~、；;:：])瑞姬' },
  /**
   * 异步唤醒回推（Hermes 后台任务跑完 → 自动推回 QQ）。
   *
   * Hermes 的 API Server 是无状态 HTTP 通道（gateway/platforms/api_server.py:
   * supports_async_delivery=False），没有 push 能力。打通方式是「唤醒自投递 + 持久化
   * transcript 回读」：Hermes 侧开启 async_delivery 后，terminal(background=true,
   * notify_on_complete=true)/异步委派 的完成通知会由 Hermes 自投递唤醒轮写回同一个
   * 会话 transcript（见 gateway/wake.py 的 _self_post_chat_completion），本桥接按
   * wakeDelivery.pollIntervalMs 轮询 GET /api/sessions/{id}/messages 取回并推给 QQ。
   *
   * enabled 需要两侧同时满足：这里的开关 + Hermes 端
   * `platforms.api_server.extra.async_delivery: true`（或 API_SERVER_ASYNC_DELIVERY=1）。
   * 只读轮询，不额外开端口、不引入新的入站面。
   */
  wakeDelivery: {
    enabled: false,
    /** 轮询间隔。3s ≈ 「任务结束到 QQ 收到」的端到端延迟上界 */
    pollIntervalMs: 3000,
    /** Hermes 管理 API 单次请求超时 */
    requestTimeoutMs: 8000,
    /** GET /api/sessions 的会话数上限（本桥接只关心 qq_ 前缀的会话） */
    maxSessions: 200,
    /** 单次 GET /api/sessions/{id}/messages 的返回条数上限 */
    messagePageLimit: 500,
    /** 超过这个年龄的分体通知不再投递（防重启后补发几小时前的旧结果） */
    maxAgeMs: 1800000,
    /** 唤醒块迟迟没有 assistant 回复时的兜底提示阈值；<=0 关闭兜底 */
    fallbackAfterMs: 600000,
    fallbackNotice: '⚠️ 后台任务已结束，但瑞姬没能生成回复内容\n{notice}',
    /** 游标与已投递记录保留天数 */
    retainDays: 7,
    /**
     * 冷启动保护（缺陷二）：会话存在但**没有游标记录**时（全新部署 /
     * 游标被裁掉 / wake_cursors.json 丢失或损坏），以当前 transcript 的最新行号
     * 为起点基线，并把历史块的稳定去重键回填进 handled，只监听启动后落地的
     * 新完成通知。显式 false 才退回旧的"从 0 行开扫"行为。
     */
    coldStartSnapshot: true,
    /** 只处理 Hermes 会话表里 source 为该值的会话 */
    source: 'api_server',
    /**
     * 引用锚点：异步完成通知自动引用「当初那条派发消息」。
     * 派发回复发出后，sender 拿到 NapCat 返回的真实 message_id，由
     * orchestration/reply-anchor-tracker.js 按 strategy 选段并记入
     * WakeCursorStore.anchors[契约会话 id]；wake-flow 投递完成通知时取出填进
     * metadata.replyToMessageId（→ 前置 [CQ:reply,id=…]），引用一次后清空。
     *   strategy: auto  派发标记段优先，否则本轮首条发送成功的分段（默认，推荐）
     *             first 固定本轮首段
     *             last  固定本轮末段
     *   markers:  optional，正则字符串数组；不写用内置默认（中英派发说法），
     *             显式给 [] 则完全不认标记、一律走首/末段
     *   maxAgeMs: 超过这个年龄的锚点不再引用（0 = 不限制）。默认给到 6 小时：
     *             后台任务跑几十分钟到几小时很常见，而通知本身的时戳是新的
     *             （不受 wakeDelivery.maxAgeMs 约束），锚点太短就会白记；
     *             引用一次即消费，再配上这个上限就不会无限引用陈旧消息。
     */
    anchor: {
      enabled: true,
      strategy: 'auto',
      maxAgeMs: 21600000,
    },
    /**
     * 异步委派完成行（delegate_task background=true）的转述桥。
     *
     * Hermes 对委派完成**不会**起唤醒轮：它只在 transcript 里落一条
     * display_kind=async_delegation_complete 的内部重注入信封（写给 agent 的，不是
     * 给群友看的），下一轮交给客户端。所以桥接自己以同一会话自投递一次唤醒轮
     * （hermes_wake_turn=true），让模型用它自己的口吻转述；内部汇报行本身永不投递。
     * 关闭（enabled=false）后就只剩 fallbackNotice 兜底，委派结果不再自动回推。
     *   graceMs:         完成行落地后先等一小会儿（若 Hermes 侧自己写了 assistant 回复就不唤醒）
     *   maxAttempts:     唤醒失败的重试次数上限（超过就交给 fallbackNotice）
     *   retryCooldownMs: 两次唤醒尝试之间的最小间隔
     *   prompt:          唤醒提示词模板（可选）。模板里的 {ref} 替换为 deleg id；
     *                    **绝不要把 {notice} 当成正文占位符** —— 原生报告已在会话上下文里，
     *                    再内嵌一份会让同一份报告堆两份。未配置时用 wake-flow 的极简默认词。
     */
    delegationRelay: {
      enabled: true,
      graceMs: 5000,
      maxAttempts: 3,
      retryCooldownMs: 60000,
    },
  },
  decision: {
    capability: 'decision.group_reply',
    /**
     * 频控（限速名单）默认额度：名单内用户在 windowMs 内最多回 maxReplies 条，
     * 超出静默忽略。名单条目可在 identity.rateLimitUsers 里写
     * "QQ号:条数[:窗口毫秒]" / "QQ号:block" 覆盖这两项全局默认值。
     * applyToPrivate 默认 false：私聊本来就过白名单门禁，不把频控顺带压上去。
     * 以上字段全部热生效（core/rate-limit-policy.js 每次现读 config）。
     */
    rateLimit: { maxReplies: 5, windowMs: 300000, applyToPrivate: false },
    debounceMs: 800,
    localWindowSize: 15,
    localWindowInject: 6,
    /**
     * 主人在途生成时的新消息处理：true = 优先走 Hermes 原生 redirect
     * （不打断在途轮，把补充作为修正并入当前回复继续生成，跑不动时回退硬打断）；
     * false = 旧行为（附录 1 的立即硬打断）。
     */
    ownerRedirect: true,
    /** redirect 成功后给主人的回执；与 Hermes busy_ack 同款带冷却，防刷屏 */
    redirectAck: { enabled: true, message: '↪ 收到补充，已并入当前回复继续生成~', cooldownMs: 30000 },
    /**
     * 排队超时：在途生成期间排队的消息等满 timeoutMs 即从队列舍弃，并引用原消息
     * 回一条 notice 说明已超时。防止上游响应慢 + 工具调用把队列堵死时，
     * 后面的人无限等下去。置 enabled=false 或 timeoutMs<=0 关闭。
     */
    queueTimeout: {
      enabled: true,
      timeoutMs: 120000,
      notice: '⏳ 刚才那条排队太久啦，先舍弃了，有需要的话再叫我一次~',
    },
    /**
     * 群级频控提示文案。额度写在 identity.groupWhitelist 的条目里
     * （"群号:条数[:窗口毫秒]"），这里只管超额后回什么。
     * {minutes} 会被替换成剩余冷却分钟数（向上取整，至少 1）。热生效。
     */
    groupRateLimit: {
      notice: '瑞姬去休息啦，{minutes}分钟再来找她吧',
    },
  },
  /**
   * 上下文与 Prompt 组装。
   *
   * directMediaParts: 本轮落盘的图片是否直接以 image_url 多模态 parts 挂进模型
   * 请求。默认 true（保持旧行为）。置 false 时不再推 image_url，只在文本里给出
   * 本地绝对路径 + 归属说明牌 + 「需要时调 vision_analyze」提示，由模型按需主动
   * 读图。用于规避主模型输入端的内容安全拦截：图片直传进上下文会在 Google 等
   * provider 侧触发 Generative AI Prohibited Use 策略而让整轮回复失败，而工具
   * 返回的图片分析结果不受输入端策略约束。热生效（渲染时现读 config）。
   */
  context: {
    totalCharacterBudget: 12000,
    perSourceCharacterBudget: 4000,
    collectTimeoutMs: 5000,
    directMediaParts: true,
  },
  reply: {
    sendEnabled: true,
    sideEffectsEnabled: true,
    maxResponseChars: 100000,
    truncateToChars: 50000,
    maxSendAgeMs: 600000,
    maxSendRetries: 10,
    /** 模型完成事件的同步结算上限；超时只跳过本轮评分，不影响发送 */
    settlementTimeoutMs: 8000,
    /**
     * 会话级输出互斥（缺陷一）：同一个 QQ 目标上，主回复流的分段与异步唤醒
     * 通知、命令回执严格串行，后到的等前一轮完全发完再开始（不再交错投递）。
     *   timeoutMs: 等一轮投递完成的硬上限，到点强制放行（只保证不死锁）。
     *   enabled:   显式 false 退回旧行为（不排队、任其交错）。
     */
    outputMutex: { enabled: true, timeoutMs: 90000 },
  },
  favourUltraEnabled: false,
  legacyAffectionEnabled: true,
  fastAck: { enabled: true, message: '收到，已派给编程/画师，弄好叫你~', patterns: [] },
  storage: {
    legacyRoot: '..',
    affectionFile: '../affection.json',
    portrayalFile: 'data/plugin_data/portrayal/profiles.json',
    shadowLearnFile: 'data/plugin_data/shadow_learn/learning.json',
    memeDataFile: '../memes_data.json',
    memeRoot: '../memes',
    receivedImagesDir: '../received_images',
    receivedFilesDir: '../received_files',
    cacheDir: '.cache',
    shadowDir: 'shadow',
  },
  health: { port: 29996, lockPort: 29997 },
  /**
   * 运维面板。默认开启，只绑 127.0.0.1。
   * 端口保留 web.port 可配 —— 面板不参与主链路，随时可搬。
   */
  web: { enabled: true, host: '127.0.0.1', port: 29998, maxTraces: 200 },
  /** 统一 AstrBot 垫片宿主（F:\harness\unified_astrbot_host），面板据此探活 */
  unifiedHost: { baseUrl: 'http://127.0.0.1:8870' },
  /**
   * Mem0 本地长期工作记忆中心。
   * `filterFile` 指向 Mem0 服务端自己的配置文件，JS 侧只读它的 `filter` 段
   * （群聊/私聊过滤规则），读不到或解析不了就一条都不沉淀（fail-closed）。
   */
  mem0: {
    enabled: true,
    baseUrl: 'http://127.0.0.1:29990',
    userId: 'ruaji',
    filterFile: '',
    timeoutMs: 15000,
  },
  meme: {
    autoCollect: true,
    autoAiTagging: true,
    visionBaseUrl: 'http://127.0.0.1:8317/v1',
    visionModel: 'gpt-4o-mini',
    visionKeyEnv: 'CPA_API_KEY',
    visionKey: '',
    /**
     * 后置表情匹配：主模型回复完成后，桥接用独立小模型挑一张表情包跟进。
     * matcherBaseUrl / matcherModel / key 留空时回落上面的 vision* 同款小模型。
     * enabled / retries / candidates 热生效；端点 / 模型 / key / 超时改动需重启。
     */
    matcherEnabled: true,
    matcherBaseUrl: '',
    matcherModel: '',
    matcherKeyEnv: '',
    matcherKey: '',
    matcherTimeoutMs: 10000,
    matcherMaxRetries: 2,
    matcherCandidateCount: 10,
  },
  portrayal: {
    enabled: true,
    msgInterval: 50,
    initialThreshold: 20,
    cooldownHours: 24,
    blacklistUsers: [],
    // 以下三项留空即复用主对话模型；填了才会给画像任务单开一个 adapter
    model: '',
    baseUrl: '',
    apiKeyEnv: '',
  },
  /**
   * 影子模式（学习自 astrbot_plugin_self_learning 的影子设计）：模仿指定群友说话。
   * 注入内容与上游 build_prompt 同款：纯统计画像（句长/语气结尾/标点习惯）+
   * 代表性例句，零 LLM 分析。与上游的两点有意偏离：语料持续滚动采集（上游
   * 手动冻结快照）、targets 全局生效可多人（上游按群互斥单影子）。
   * targets 非空即开始采集（先填 ID 后开开关也立刻有语料），enabled 只控制注入。
   */
  shadowLearn: {
    enabled: false,
    targets: [],
    injectCount: 10,
  },
  logging: {
    level: 'info',
    file: 'ruaji-bridge-v2.log',
    maxSizeBytes: 10485760,
    keepRotated: 5,
    logMessageBodies: false,
  },
  pipelines: {
    'response.transform': ['favour-tags', 'affection', 'media-extract', 'meme', 'strip-markdown', 'typing-delay'],
    /**
     * 唤醒回推专用管线：只要「脱 Markdown + 拟人节流」。
     * 不能复用 response.transform —— 好感度/评分/表情包那几个中间件都挂在
     * 「用户这一轮说了什么」上，唤醒通知没有 inbound 轮次，跑了会写脏数据。
     */
    'response.notice': ['strip-markdown', 'typing-delay'],
  },
  plugins: [],
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, override) {
  if (!isPlainObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = isPlainObject(v) && isPlainObject(base?.[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

/**
 * 环境变量覆盖表。命名规则：RUAJI_V2_<路径大写下划线>
 * 只覆盖运行模式相关的开关；密钥不走这里（密钥走 *Env 间接引用）。
 */
const ENV_OVERRIDES = [
  ['RUAJI_V2_MODE', 'mode', String],
  ['RUAJI_V2_SEND_ENABLED', 'reply.sendEnabled', toBool],
  ['RUAJI_V2_SIDE_EFFECTS_ENABLED', 'reply.sideEffectsEnabled', toBool],
  ['RUAJI_V2_LOG_LEVEL', 'logging.level', String],
  ['RUAJI_V2_LOG_BODIES', 'logging.logMessageBodies', toBool],
  ['RUAJI_V2_NAPCAT_WS_URL', 'napcat.wsUrl', String],
  ['RUAJI_V2_NAPCAT_HTTP_URL', 'napcat.httpUrl', String],
  ['RUAJI_V2_MODEL_BASE_URL', 'model.baseUrl', String],
  ['RUAJI_V2_MODEL_NAME', 'model.model', String],
  ['RUAJI_V2_MODEL_SESSION_CUTOFF_HOUR', 'model.sessionCutoffHour', Number],
  ['RUAJI_V2_MODEL_SESSION_ROTATIONS_PER_DAY', 'model.sessionRotationsPerDay', Number],
  ['RUAJI_V2_HEALTH_PORT', 'health.port', Number],
  ['RUAJI_V2_WEB_ENABLED', 'web.enabled', toBool],
  ['RUAJI_V2_WEB_PORT', 'web.port', Number],
  ['RUAJI_V2_UNIFIED_HOST_URL', 'unifiedHost.baseUrl', String],
  ['RUAJI_V2_WAKE_DELIVERY_ENABLED', 'wakeDelivery.enabled', toBool],
  ['RUAJI_V2_WAKE_DELIVERY_POLL_MS', 'wakeDelivery.pollIntervalMs', Number],
  ['RUAJI_V2_WAKE_DELIVERY_MAX_AGE_MS', 'wakeDelivery.maxAgeMs', Number],
  ['RUAJI_V2_WAKE_DELEGATION_RELAY', 'wakeDelivery.delegationRelay.enabled', toBool],
  ['RUAJI_V2_MEM0_ENABLED', 'mem0.enabled', toBool],
  ['RUAJI_V2_MEM0_BASE_URL', 'mem0.baseUrl', String],
  ['RUAJI_V2_MEM0_FILTER_FILE', 'mem0.filterFile', String],
  ['RUAJI_V2_OWNER_ID', 'identity.ownerId', String],
  ['RUAJI_V2_ROBOT_ID', 'identity.robotId', String],
  ['RUAJI_V2_MEME_VISION_BASE_URL', 'meme.visionBaseUrl', String],
  ['RUAJI_V2_MEME_VISION_MODEL', 'meme.visionModel', String],
  ['RUAJI_V2_MEME_MATCHER_BASE_URL', 'meme.matcherBaseUrl', String],
  ['RUAJI_V2_MEME_MATCHER_MODEL', 'meme.matcherModel', String],
];

function toBool(v) {
  return v === '1' || String(v).toLowerCase() === 'true';
}

function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[keys.at(-1)] = value;
}

/**
 * @param {object} opts
 * @param {string} opts.rootDir   v2 项目根目录
 * @param {string} [opts.file]    配置文件名，默认 bridge.config.json
 * @param {object} [opts.env]     环境变量来源，默认 process.env
 * @param {object} [opts.cliOverrides]
 */
export function loadConfig({ rootDir, file = 'bridge.config.json', env = process.env, cliOverrides = {} } = {}) {
  if (!rootDir) throw new ConfigError('loadConfig 缺少 rootDir');

  const configPath = path.resolve(rootDir, file);
  let fileConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      throw new ConfigError(`配置文件解析失败 ${configPath}: ${e.message}`);
    }
  } else {
    // 首次运行还没有 bridge.config.json 时，退回 example，方便 shadow 直接跑起来
    const examplePath = path.resolve(rootDir, 'bridge.config.example.json');
    if (fs.existsSync(examplePath)) {
      fileConfig = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
    }
  }

  let config = deepMerge(DEFAULTS, fileConfig);

  for (const [envKey, dotted, cast] of ENV_OVERRIDES) {
    if (env[envKey] != null && env[envKey] !== '') setPath(config, dotted, cast(env[envKey]));
  }
  config = deepMerge(config, cliOverrides);

  // 密钥解析：优先环境变量，其次配置文件 fallback
  config.secrets = {
    napcatAccessToken: env[config.napcat.accessTokenEnv] || fileConfig?.napcat?.accessToken || '',
    modelApiKey: env[config.model.apiKeyEnv] || fileConfig?.model?.apiKey || '',
    memeVisionApiKey: (config.meme?.visionKeyEnv ? env[config.meme.visionKeyEnv] : '') || fileConfig?.meme?.visionKey || '',
    // matcher key 同理回落 vision key：端点共用时密钥也共用
    memeMatcherApiKey:
      (config.meme?.matcherKeyEnv ? env[config.meme.matcherKeyEnv] : '')
      || fileConfig?.meme?.matcherKey
      || (config.meme?.visionKeyEnv ? env[config.meme.visionKeyEnv] : '')
      || fileConfig?.meme?.visionKey
      || '',
    portrayalApiKey: (config.portrayal?.apiKeyEnv ? env[config.portrayal.apiKeyEnv] : '') || fileConfig?.portrayal?.apiKey || '',
  };

  config.paths = resolvePaths(config, rootDir);
  validate(config);
  return config;
}

function resolvePaths(config, rootDir) {
  const s = config.storage;
  return {
    rootDir,
    /** 面板保存配置时写回的目标文件。显式列出来，测试才能把它指到临时目录 */
    configFile: path.resolve(rootDir, 'bridge.config.json'),
    legacyRoot: path.resolve(rootDir, s.legacyRoot),
    affectionFile: path.resolve(rootDir, s.affectionFile),
    portrayalFile: path.resolve(rootDir, s.portrayalFile ?? 'data/plugin_data/portrayal/profiles.json'),
    shadowLearnFile: path.resolve(rootDir, s.shadowLearnFile ?? 'data/plugin_data/shadow_learn/learning.json'),
    memeDataFile: path.resolve(rootDir, s.memeDataFile),
    memeRoot: path.resolve(rootDir, s.memeRoot),
    receivedImagesDir: path.resolve(rootDir, s.receivedImagesDir),
    receivedFilesDir: path.resolve(rootDir, s.receivedFilesDir),
    cacheDir: path.resolve(rootDir, s.cacheDir),
    shadowDir: path.resolve(rootDir, s.shadowDir ?? 'shadow'),
  };
}

function validate(config) {
  const errors = [];

  if (!['shadow', 'live', 'test'].includes(config.mode)) {
    errors.push(`mode 非法: ${config.mode}（应为 shadow | live | test）`);
  }
  if (!config.napcat.wsUrl) errors.push('napcat.wsUrl 缺失');
  if (!config.napcat.httpUrl) errors.push('napcat.httpUrl 缺失');
  if (!config.model.baseUrl) errors.push('model.baseUrl 缺失');
  if (config.wakeDelivery) {
    const wd = config.wakeDelivery;
    if (wd.enabled && !(Number(wd.pollIntervalMs) >= 500)) {
      errors.push(`wakeDelivery.pollIntervalMs 非法: ${wd.pollIntervalMs}（应为 >= 500 的毫秒数）`);
    }
    if (wd.maxAgeMs != null && !(Number(wd.maxAgeMs) >= 0)) {
      errors.push(`wakeDelivery.maxAgeMs 非法: ${wd.maxAgeMs}（应为 >= 0 的毫秒数，0 = 不限制）`);
    }
    const anchor = wd.anchor;
    if (anchor) {
      if (anchor.strategy != null && !['auto', 'first', 'last'].includes(anchor.strategy)) {
        errors.push(`wakeDelivery.anchor.strategy 非法: ${anchor.strategy}（应为 auto | first | last）`);
      }
      if (anchor.maxAgeMs != null && !(Number(anchor.maxAgeMs) >= 0)) {
        errors.push(`wakeDelivery.anchor.maxAgeMs 非法: ${anchor.maxAgeMs}（应为 >= 0 的毫秒数，0 = 不限制）`);
      }
      if (anchor.markers != null && !Array.isArray(anchor.markers)) {
        errors.push('wakeDelivery.anchor.markers 非法（应为正则字符串数组）');
      }
    }
  }
  if (!config.model.model) errors.push('model.model 缺失');
  if (config.model.sessionCutoffHour != null) {
    const h = Number(config.model.sessionCutoffHour);
    if (!Number.isInteger(h) || h < 0 || h > 23) {
      errors.push(`model.sessionCutoffHour 非法: ${config.model.sessionCutoffHour}（应为 0-23 的整数）`);
    }
  }
  if (config.model.sessionRotationsPerDay != null) {
    const n = Number(config.model.sessionRotationsPerDay);
    if (!Number.isInteger(n) || n < 1 || n > 12 || 24 % n !== 0) {
      errors.push(`model.sessionRotationsPerDay 非法: ${config.model.sessionRotationsPerDay}（应为 1/2/3/4/6/8/12 之一）`);
    }
  }
  if (!config.identity.robotId) errors.push('identity.robotId 缺失（缺了就无法过滤自身消息与判定 @）');
  if (!config.identity.ownerId) errors.push('identity.ownerId 缺失（缺了主人特权与打断特权都会失效）');
  if (!['at', 'name', 'both'].includes(config.wake.mode)) {
    errors.push(`wake.mode 非法: ${config.wake.mode}`);
  }
  // 面板与健康端点、单实例锁必须错开，撞了就是启动期直接失败而不是运行期神秘 EADDRINUSE
  if (config.web?.enabled) {
    const ports = [config.health.port, config.health.lockPort, config.web.port].filter((p) => p > 0);
    if (new Set(ports).size !== ports.length) {
      errors.push(
        `端口冲突: health=${config.health.port} lock=${config.health.lockPort} web=${config.web.port}`,
      );
    }
  }
  try {
    new RegExp(config.wake.namePattern);
  } catch (e) {
    errors.push(`wake.namePattern 不是合法正则: ${e.message}`);
  }

  // 影子模式是硬约束：即使配置写错也强制关闭发送与副作用
  if (config.mode === 'shadow') {
    if (config.reply.sendEnabled || config.reply.sideEffectsEnabled) {
      config.reply.sendEnabled = false;
      config.reply.sideEffectsEnabled = false;
      config._shadowForced = true;
    }
  }

  if (config.mode === 'live' && !config.secrets.modelApiKey) {
    errors.push(`live 模式缺少模型密钥：请设置环境变量 ${config.model.apiKeyEnv}`);
  }

  if (errors.length) throw new ConfigError(`配置错误:\n  - ${errors.join('\n  - ')}`);
}

export { DEFAULTS };
