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
  identity: { ownerId: '', robotId: '', botName: '瑞姬', ownerTitle: '主人', rateLimitUsers: [], privateWhitelist: [] },
  napcat: {
    wsUrl: 'ws://127.0.0.1:3001',
    httpUrl: 'http://127.0.0.1:3000',
    accessTokenEnv: 'NAPCAT_ACCESS_TOKEN',
    reconnect: { minBackoffMs: 1000, maxBackoffMs: 60000 },
    requestTimeoutMs: 8000,
    sendTimeoutMs: 30000,
  },
  model: {
    provider: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8642/v1',
    model: 'hermes-agent',
    apiKeyEnv: 'HERMES_API_KEY',
    sessionHeader: 'X-Hermes-Session-Id',
    sessionPrefix: 'qq_',
    sessionCutoffHour: 7,
    timeoutMs: 1800000,
    stream: true,
    maxRetries: 0,
  },
  wake: { mode: 'both', namePattern: '(^|[\\s，,。.!！?？~、；;:：])瑞姬' },
  decision: {
    capability: 'decision.group_reply',
    rateLimit: { maxReplies: 5, windowMs: 300000 },
    debounceMs: 800,
    localWindowSize: 15,
    localWindowInject: 6,
  },
  context: { totalCharacterBudget: 12000, perSourceCharacterBudget: 4000, collectTimeoutMs: 2500 },
  reply: {
    sendEnabled: true,
    sideEffectsEnabled: true,
    maxResponseChars: 100000,
    truncateToChars: 50000,
    maxSendAgeMs: 600000,
    maxSendRetries: 10,
  },
  fastAck: { enabled: true, message: '收到，已派给编程/画师，弄好叫你~', patterns: [] },
  storage: {
    legacyRoot: '..',
    affectionFile: '../affection.json',
    portrayalFile: 'data/plugin_data/portrayal/profiles.json',
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
  logging: {
    level: 'info',
    file: 'ruaji-bridge-v2.log',
    maxSizeBytes: 10485760,
    keepRotated: 5,
    logMessageBodies: false,
  },
  pipelines: {
    'response.transform': ['affection', 'media-extract', 'meme', 'strip-markdown', 'typing-delay'],
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
  ['RUAJI_V2_HEALTH_PORT', 'health.port', Number],
  ['RUAJI_V2_WEB_ENABLED', 'web.enabled', toBool],
  ['RUAJI_V2_WEB_PORT', 'web.port', Number],
  ['RUAJI_V2_UNIFIED_HOST_URL', 'unifiedHost.baseUrl', String],
  ['RUAJI_V2_MEM0_ENABLED', 'mem0.enabled', toBool],
  ['RUAJI_V2_MEM0_BASE_URL', 'mem0.baseUrl', String],
  ['RUAJI_V2_MEM0_FILTER_FILE', 'mem0.filterFile', String],
  ['RUAJI_V2_OWNER_ID', 'identity.ownerId', String],
  ['RUAJI_V2_ROBOT_ID', 'identity.robotId', String],
  ['RUAJI_V2_MEME_VISION_BASE_URL', 'meme.visionBaseUrl', String],
  ['RUAJI_V2_MEME_VISION_MODEL', 'meme.visionModel', String],
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
  if (!config.model.model) errors.push('model.model 缺失');
  if (config.model.sessionCutoffHour != null) {
    const h = Number(config.model.sessionCutoffHour);
    if (!Number.isInteger(h) || h < 0 || h > 23) {
      errors.push(`model.sessionCutoffHour 非法: ${config.model.sessionCutoffHour}（应为 0-23 的整数）`);
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
