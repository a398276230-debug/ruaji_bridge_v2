/**
 * web/api/config.js — 客制化配置管理与模型连通性测试 API
 *
 * 职责：
 * 1. GET /api/config：读取当前桥接的完整配置、脱敏后的密钥状态及相关元数据
 * 2. PUT /api/config：校验并持久化客制化配置至 bridge.config.json，同步热更新运行时状态
 * 3. POST /api/config/test-model：测试主对话模型或表情包视觉模型的连通性与延迟
 */

import fs from 'node:fs';
import path from 'node:path';

/** 取正数，非法（0/负数/NaN）时回落到 fallback */
function positiveOr(value, fallback) {
  if (value == null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function maskSecret(str) {
  if (!str || typeof str !== 'string') return '';
  const trimmed = str.trim();
  if (trimmed.length <= 6) return '••••••';
  return `${trimmed.slice(0, 3)}••••••${trimmed.slice(-3)}`;
}

function isMasked(str) {
  return typeof str === 'string' && (str.includes('••••') || str.includes('***'));
}

export function createConfigApi(deps) {
  const { config, memeStore, portrayalStore, sessionStore, modelAdapter, logger, fetchImpl = fetch } = deps;
  const log = logger?.child({ component: 'web-config' }) ?? console;

  /** 配置落盘位置。走 paths.configFile，测试会把它指到临时目录以免覆盖实盘配置 */
  const configFilePath = () =>
    config.paths?.configFile || path.resolve(config.paths?.rootDir || '.', 'bridge.config.json');

  return {
    'GET /api/config': async () => {
      // 读取实际磁盘上的配置文件，获取原始字段结构
      const configPath = configFilePath();
      let rawConfig = {};
      if (fs.existsSync(configPath)) {
        try {
          rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch {
          rawConfig = {};
        }
      }

      // 组装脱敏后的前端配置对象
      const safeConfig = {
        mode: config.mode ?? 'live',
        identity: {
          ownerId: config.identity?.ownerId ?? '',
          robotId: config.identity?.robotId ?? '',
          botName: config.identity?.botName ?? '瑞姬',
          rateLimitUsers: Array.isArray(config.identity?.rateLimitUsers)
            ? [...config.identity.rateLimitUsers]
            : [],
          privateWhitelist: Array.isArray(config.identity?.privateWhitelist)
            ? [...config.identity.privateWhitelist]
            : [],
        },
        napcat: {
          wsUrl: config.napcat?.wsUrl ?? 'ws://127.0.0.1:3001',
          httpUrl: config.napcat?.httpUrl ?? 'http://127.0.0.1:3000',
          accessTokenEnv: config.napcat?.accessTokenEnv ?? 'NAPCAT_ACCESS_TOKEN',
          accessTokenMasked: maskSecret(config.secrets?.napcatAccessToken || rawConfig.napcat?.accessToken),
          hasAccessToken: Boolean(config.secrets?.napcatAccessToken || rawConfig.napcat?.accessToken),
          requestTimeoutMs: config.napcat?.requestTimeoutMs ?? 8000,
          sendTimeoutMs: config.napcat?.sendTimeoutMs ?? 30000,
        },
        model: {
          provider: config.model?.provider ?? 'openai-compatible',
          baseUrl: config.model?.baseUrl ?? 'http://127.0.0.1:8642/v1',
          model: config.model?.model ?? 'hermes-agent',
          apiKeyEnv: config.model?.apiKeyEnv ?? 'HERMES_API_KEY',
          apiKeyMasked: maskSecret(config.secrets?.modelApiKey || rawConfig.model?.apiKey),
          hasApiKey: Boolean(config.secrets?.modelApiKey || rawConfig.model?.apiKey),
          sessionHeader: config.model?.sessionHeader ?? 'X-Hermes-Session-Id',
          sessionPrefix: config.model?.sessionPrefix ?? 'qq_',
          sessionCutoffHour: config.model?.sessionCutoffHour ?? 7,
          timeoutMs: config.model?.timeoutMs ?? 1800000,
          stream: config.model?.stream !== false,
          maxRetries: config.model?.maxRetries ?? 0,
        },
        wake: {
          mode: config.wake?.mode ?? 'both',
          namePattern: config.wake?.namePattern ?? '(^|[\\s，,。.!！?？~、；;:：])瑞姬',
        },
        decision: {
          capability: config.decision?.capability ?? 'decision.group_reply',
          rateLimit: {
            maxReplies: config.decision?.rateLimit?.maxReplies ?? 5,
            windowMs: config.decision?.rateLimit?.windowMs ?? 300000,
          },
          debounceMs: config.decision?.debounceMs ?? 800,
          localWindowSize: config.decision?.localWindowSize ?? 15,
          localWindowInject: config.decision?.localWindowInject ?? 6,
        },
        context: {
          totalCharacterBudget: config.context?.totalCharacterBudget ?? 12000,
          perSourceCharacterBudget: config.context?.perSourceCharacterBudget ?? 4000,
          collectTimeoutMs: config.context?.collectTimeoutMs ?? 2500,
        },
        reply: {
          sendEnabled: Boolean(config.reply?.sendEnabled),
          sideEffectsEnabled: Boolean(config.reply?.sideEffectsEnabled),
          maxResponseChars: config.reply?.maxResponseChars ?? 100000,
          truncateToChars: config.reply?.truncateToChars ?? 50000,
          maxSendAgeMs: config.reply?.maxSendAgeMs ?? 600000,
          maxSendRetries: config.reply?.maxSendRetries ?? 10,
        },
        fastAck: {
          enabled: Boolean(config.fastAck?.enabled),
          message: config.fastAck?.message ?? '收到，已派给编程/画师，弄好叫你~',
          patterns: Array.isArray(config.fastAck?.patterns) ? [...config.fastAck.patterns] : [],
        },
        meme: {
          autoCollect: memeStore?.data?.settings?.auto_collect ?? config.meme?.autoCollect ?? true,
          autoAiTagging: memeStore?.data?.settings?.auto_ai_tagging ?? config.meme?.autoAiTagging ?? true,
          visionBaseUrl: config.meme?.visionBaseUrl ?? 'http://127.0.0.1:8317/v1',
          visionModel: config.meme?.visionModel ?? 'gpt-4o-mini',
          visionKeyEnv: config.meme?.visionKeyEnv ?? 'CPA_API_KEY',
          visionKeyMasked: maskSecret(config.secrets?.memeVisionApiKey || rawConfig.meme?.visionKey),
          hasVisionKey: Boolean(config.secrets?.memeVisionApiKey || rawConfig.meme?.visionKey),
        },
        // config.portrayal 由 core/config.js 的默认值兜底，这里不再重复硬编码
        portrayal: {
          enabled: config.portrayal.enabled !== false,
          msgInterval: config.portrayal.msgInterval,
          initialThreshold: config.portrayal.initialThreshold,
          cooldownHours: config.portrayal.cooldownHours,
          blacklistUsers: config.portrayal.blacklistUsers,
          baseUrl: config.portrayal.baseUrl,
          model: config.portrayal.model,
          apiKeyEnv: config.portrayal.apiKeyEnv,
          apiKeyMasked: maskSecret(config.secrets?.portrayalApiKey),
          hasApiKey: Boolean(config.secrets?.portrayalApiKey),
        },
        unifiedHost: {
          baseUrl: config.unifiedHost?.baseUrl ?? 'http://127.0.0.1:8870',
        },
        web: {
          port: config.web?.port ?? 29998,
          maxTraces: config.web?.maxTraces ?? 200,
        },
        logging: {
          level: config.logging?.level ?? 'info',
          logMessageBodies: Boolean(config.logging?.logMessageBodies),
        },
      };

      // 附带选项与元数据
      const metadata = {
        presets: {
          wakeModes: [
            { value: 'both', label: '真 @ 与名字呼唤双触发 (推荐)' },
            { value: 'at', label: '仅响应真 @' },
            { value: 'name', label: '仅响应名字呼唤' },
          ],
          modes: [
            { value: 'live', label: 'Live (真实运行并可发送回复)' },
            { value: 'shadow', label: 'Shadow (影子对照，完全只读无副作用)' },
          ],
          logLevels: [
            { value: 'debug', label: 'DEBUG (最详尽调试)' },
            { value: 'info', label: 'INFO (标准运行信息)' },
            { value: 'warn', label: 'WARN (仅警告与错误)' },
            { value: 'error', label: 'ERROR (仅严重错误)' },
          ],
          dialogModels: [
            'hermes-agent',
            'gpt-5.6-sol',
            'gpt-5.6-luna',
            'gemini-3.7-flash',
            'deepseek-chat',
            'glm-5.2',
            'qwen-max',
          ],
          visionModels: [
            'gpt-4o-mini',
            'gemini-2.5-flash',
            'gemini-3-flash-preview',
            'qwen-vl-max',
            'deepseek-v4-flash-stfree',
          ],
        },
      };

      return {
        body: {
          config: safeConfig,
          metadata,
          configFile: configPath,
        },
      };
    },

    'PUT /api/config': async ({ body }) => {
      if (!body || typeof body !== 'object') {
        return { status: 400, body: { error: '请求体必须是合法 JSON 对象' } };
      }

      const configPath = configFilePath();
      let diskConfig = {};
      if (fs.existsSync(configPath)) {
        try {
          diskConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (e) {
          log.warn('读取现有配置文件失败，将采用全新结构写入', { error: e.message });
          diskConfig = {};
        }
      }

      const updates = body;
      const errors = [];

      // 1. 基础校验
      if (updates.identity) {
        if (!updates.identity.robotId) errors.push('机器人 QQ 号 (robotId) 不能为空');
        if (!updates.identity.ownerId) errors.push('主人 QQ 号 (ownerId) 不能为空');
        if (!updates.identity.botName) errors.push('机器人称谓 (botName) 不能为空');
      }

      if (updates.wake) {
        if (updates.wake.mode && !['at', 'name', 'both'].includes(updates.wake.mode)) {
          errors.push('唤醒模式必须为 both / at / name 之一');
        }
        if (updates.wake.namePattern) {
          try {
            new RegExp(updates.wake.namePattern);
          } catch (e) {
            errors.push(`唤醒词正则不合法: ${e.message}`);
          }
        }
      }

      if (updates.model) {
        if (!updates.model.baseUrl) errors.push('模型 API Base URL 不能为空');
        if (!updates.model.model) errors.push('模型名称 不能为空');
        if (updates.model.sessionCutoffHour != null) {
          const h = Number(updates.model.sessionCutoffHour);
          if (!Number.isInteger(h) || h < 0 || h > 23) {
            errors.push(`每日会话轮转时间 非法: ${updates.model.sessionCutoffHour}（应为 0-23 的整数）`);
          }
        }
      }

      if (updates.napcat) {
        if (!updates.napcat.wsUrl) errors.push('NapCat WebSocket URL 不能为空');
        if (!updates.napcat.httpUrl) errors.push('NapCat HTTP URL 不能为空');
      }

      if (errors.length > 0) {
        return { status: 400, body: { error: errors.join('; ') } };
      }

      // 2. 合并更新到 diskConfig，保留原有的未改动字段与插件配置
      if (updates.mode) diskConfig.mode = updates.mode;

      if (updates.identity) {
        diskConfig.identity = {
          ...(diskConfig.identity || {}),
          ownerId: String(updates.identity.ownerId).trim(),
          robotId: String(updates.identity.robotId).trim(),
          botName: String(updates.identity.botName).trim(),
          rateLimitUsers: Array.isArray(updates.identity.rateLimitUsers)
            ? updates.identity.rateLimitUsers.map((u) => String(u).trim()).filter(Boolean)
            : (diskConfig.identity?.rateLimitUsers || []),
          privateWhitelist: Array.isArray(updates.identity.privateWhitelist)
            ? updates.identity.privateWhitelist.map((u) => String(u).trim()).filter(Boolean)
            : (diskConfig.identity?.privateWhitelist || []),
        };
      }

      if (updates.wake) {
        diskConfig.wake = {
          ...(diskConfig.wake || {}),
          mode: updates.wake.mode || diskConfig.wake?.mode || 'both',
          namePattern: updates.wake.namePattern || diskConfig.wake?.namePattern || '(^|[\\s，,。.!！?？~、；;:：])瑞姬',
        };
      }

      if (updates.napcat) {
        const nap = { ...(diskConfig.napcat || {}) };
        if (updates.napcat.wsUrl) nap.wsUrl = updates.napcat.wsUrl.trim();
        if (updates.napcat.httpUrl) nap.httpUrl = updates.napcat.httpUrl.trim();
        if (updates.napcat.accessTokenEnv) nap.accessTokenEnv = updates.napcat.accessTokenEnv.trim();
        if (updates.napcat.accessToken !== undefined) {
          if (!isMasked(updates.napcat.accessToken)) {
            nap.accessToken = updates.napcat.accessToken.trim();
          }
        }
        if (updates.napcat.requestTimeoutMs != null) nap.requestTimeoutMs = Number(updates.napcat.requestTimeoutMs);
        if (updates.napcat.sendTimeoutMs != null) nap.sendTimeoutMs = Number(updates.napcat.sendTimeoutMs);
        diskConfig.napcat = nap;
      }

      if (updates.model) {
        const m = { ...(diskConfig.model || {}) };
        if (updates.model.provider) m.provider = updates.model.provider.trim();
        if (updates.model.baseUrl) m.baseUrl = updates.model.baseUrl.trim();
        if (updates.model.model) m.model = updates.model.model.trim();
        if (updates.model.apiKeyEnv) m.apiKeyEnv = updates.model.apiKeyEnv.trim();
        if (updates.model.apiKey !== undefined) {
          if (!isMasked(updates.model.apiKey)) {
            m.apiKey = updates.model.apiKey.trim();
          }
        }
        if (updates.model.sessionHeader) m.sessionHeader = updates.model.sessionHeader.trim();
        if (updates.model.sessionPrefix) m.sessionPrefix = updates.model.sessionPrefix.trim();
        if (updates.model.sessionCutoffHour != null) m.sessionCutoffHour = Number(updates.model.sessionCutoffHour);
        if (updates.model.timeoutMs != null) m.timeoutMs = Number(updates.model.timeoutMs);
        if (updates.model.stream != null) m.stream = Boolean(updates.model.stream);
        diskConfig.model = m;
      }

      if (updates.meme) {
        const mem = { ...(diskConfig.meme || {}) };
        if (updates.meme.autoCollect != null) mem.autoCollect = Boolean(updates.meme.autoCollect);
        if (updates.meme.autoAiTagging != null) mem.autoAiTagging = Boolean(updates.meme.autoAiTagging);
        if (updates.meme.visionBaseUrl) mem.visionBaseUrl = updates.meme.visionBaseUrl.trim();
        if (updates.meme.visionModel) mem.visionModel = updates.meme.visionModel.trim();
        if (updates.meme.visionKeyEnv) mem.visionKeyEnv = updates.meme.visionKeyEnv.trim();
        if (updates.meme.visionKey !== undefined) {
          if (!isMasked(updates.meme.visionKey)) {
            mem.visionKey = updates.meme.visionKey.trim();
          }
        }
        diskConfig.meme = mem;
      }

      if (updates.decision) {
        diskConfig.decision = {
          ...(diskConfig.decision || {}),
          debounceMs: updates.decision.debounceMs != null ? Number(updates.decision.debounceMs) : (diskConfig.decision?.debounceMs ?? 800),
          localWindowSize: updates.decision.localWindowSize != null ? Number(updates.decision.localWindowSize) : (diskConfig.decision?.localWindowSize ?? 15),
          localWindowInject: updates.decision.localWindowInject != null ? Number(updates.decision.localWindowInject) : (diskConfig.decision?.localWindowInject ?? 6),
          rateLimit: {
            ...(diskConfig.decision?.rateLimit || {}),
            maxReplies: updates.decision.rateLimit?.maxReplies != null ? Number(updates.decision.rateLimit.maxReplies) : (diskConfig.decision?.rateLimit?.maxReplies ?? 5),
            windowMs: updates.decision.rateLimit?.windowMs != null ? Number(updates.decision.rateLimit.windowMs) : (diskConfig.decision?.rateLimit?.windowMs ?? 300000),
          },
        };
      }

      if (updates.context) {
        diskConfig.context = {
          ...(diskConfig.context || {}),
          totalCharacterBudget: updates.context.totalCharacterBudget != null ? Number(updates.context.totalCharacterBudget) : (diskConfig.context?.totalCharacterBudget ?? 12000),
          perSourceCharacterBudget: updates.context.perSourceCharacterBudget != null ? Number(updates.context.perSourceCharacterBudget) : (diskConfig.context?.perSourceCharacterBudget ?? 4000),
          collectTimeoutMs: updates.context.collectTimeoutMs != null ? Number(updates.context.collectTimeoutMs) : (diskConfig.context?.collectTimeoutMs ?? 2500),
        };
      }

      if (updates.reply) {
        diskConfig.reply = {
          ...(diskConfig.reply || {}),
          sendEnabled: updates.reply.sendEnabled != null ? Boolean(updates.reply.sendEnabled) : Boolean(diskConfig.reply?.sendEnabled),
          sideEffectsEnabled: updates.reply.sideEffectsEnabled != null ? Boolean(updates.reply.sideEffectsEnabled) : Boolean(diskConfig.reply?.sideEffectsEnabled),
          maxResponseChars: updates.reply.maxResponseChars != null ? Number(updates.reply.maxResponseChars) : (diskConfig.reply?.maxResponseChars ?? 100000),
          truncateToChars: updates.reply.truncateToChars != null ? Number(updates.reply.truncateToChars) : (diskConfig.reply?.truncateToChars ?? 50000),
          maxSendAgeMs: updates.reply.maxSendAgeMs != null ? Number(updates.reply.maxSendAgeMs) : (diskConfig.reply?.maxSendAgeMs ?? 600000),
        };
      }

      if (updates.fastAck) {
        diskConfig.fastAck = {
          ...(diskConfig.fastAck || {}),
          enabled: updates.fastAck.enabled != null ? Boolean(updates.fastAck.enabled) : Boolean(diskConfig.fastAck?.enabled),
          message: updates.fastAck.message ? String(updates.fastAck.message) : (diskConfig.fastAck?.message ?? '收到，已派给编程/画师，弄好叫你~'),
          patterns: Array.isArray(updates.fastAck.patterns)
            ? updates.fastAck.patterns.map((p) => String(p).trim()).filter(Boolean)
            : (diskConfig.fastAck?.patterns || []),
        };
      }

      if (updates.portrayal) {
        const prev = diskConfig.portrayal || {};
        diskConfig.portrayal = {
          ...prev,
          enabled: updates.portrayal.enabled != null ? Boolean(updates.portrayal.enabled) : (prev.enabled !== false),
          msgInterval: positiveOr(updates.portrayal.msgInterval, prev.msgInterval ?? 50),
          initialThreshold: positiveOr(updates.portrayal.initialThreshold, prev.initialThreshold ?? 20),
          cooldownHours: positiveOr(updates.portrayal.cooldownHours, prev.cooldownHours ?? 24),
          blacklistUsers: Array.isArray(updates.portrayal.blacklistUsers)
            ? updates.portrayal.blacklistUsers.map((s) => String(s).trim()).filter(Boolean)
            : (prev.blacklistUsers || []),
          // 留空即复用主对话模型，不要塞示例值进去
          baseUrl: updates.portrayal.baseUrl ?? prev.baseUrl ?? '',
          model: updates.portrayal.model ?? prev.model ?? '',
          apiKeyEnv: updates.portrayal.apiKeyEnv ?? prev.apiKeyEnv ?? '',
        };
        if (updates.portrayal.apiKey && !isMasked(updates.portrayal.apiKey)) {
          diskConfig.portrayal.apiKey = updates.portrayal.apiKey.trim();
        }
      }

      if (updates.logging) {
        diskConfig.logging = {
          ...(diskConfig.logging || {}),
          level: updates.logging.level || diskConfig.logging?.level || 'info',
          logMessageBodies: updates.logging.logMessageBodies != null ? Boolean(updates.logging.logMessageBodies) : Boolean(diskConfig.logging?.logMessageBodies),
        };
      }

      // 3. 原子落盘
      try {
        const tmpPath = `${configPath}.tmp_${Date.now()}`;
        fs.writeFileSync(tmpPath, JSON.stringify(diskConfig, null, 2), 'utf8');
        fs.renameSync(tmpPath, configPath);
        log.info('桥接配置文件已成功更新保存', { path: configPath });
      } catch (err) {
        log.error('配置文件写入失败', { error: err.message });
        return { status: 500, body: { error: `写入配置文件失败: ${err.message}` } };
      }

      // 4. 热更新运行时内存状态
      if (diskConfig.identity) Object.assign(config.identity, diskConfig.identity);
      if (diskConfig.wake) Object.assign(config.wake, diskConfig.wake);
      if (diskConfig.decision) {
        Object.assign(config.decision, diskConfig.decision);
        if (sessionStore && diskConfig.decision.localWindowSize) {
          sessionStore.windowSize = diskConfig.decision.localWindowSize;
        }
      }
      if (diskConfig.model?.sessionCutoffHour != null) {
        config.model.sessionCutoffHour = diskConfig.model.sessionCutoffHour;
        // 分界值在适配器构造时就取好了，必须同步推给活着的实例，否则要重启才生效
        if (modelAdapter) modelAdapter.sessionCutoffHour = diskConfig.model.sessionCutoffHour;
      }
      if (diskConfig.context) Object.assign(config.context, diskConfig.context);
      if (diskConfig.reply) Object.assign(config.reply, diskConfig.reply);
      if (diskConfig.fastAck) Object.assign(config.fastAck, diskConfig.fastAck);
      if (diskConfig.logging) Object.assign(config.logging, diskConfig.logging);
      if (diskConfig.portrayal) {
        config.portrayal = { ...(config.portrayal || {}), ...diskConfig.portrayal };
        // 门槛在 store 构造时就取好了，必须同步推给活着的实例，否则要重启才生效
        if (portrayalStore) {
          portrayalStore.msgInterval = config.portrayal.msgInterval;
          portrayalStore.initialThreshold = config.portrayal.initialThreshold;
          portrayalStore.cooldownMs = config.portrayal.cooldownHours * 60 * 60 * 1000;
          portrayalStore.maxRecentMessages = Math.max(50, config.portrayal.msgInterval);
          portrayalStore.blacklist = new Set((config.portrayal.blacklistUsers || []).map(String));
        }
      }
      if (diskConfig.meme) {
        config.meme = { ...(config.meme || {}), ...diskConfig.meme };
        if (memeStore) {
          memeStore.data.settings = {
            ...(memeStore.data.settings || {}),
            auto_collect: diskConfig.meme.autoCollect,
            auto_ai_tagging: diskConfig.meme.autoAiTagging,
          };
          memeStore.persist();
        }
      }

      return {
        body: {
          ok: true,
          message: '配置已成功保存并同步到运行态！',
          hotApplied: true,
          needRestartNotice: '部分核心连接（如 NapCat WS 端口或主模型 Provider）在重启后完全生效。',
        },
      };
    },

    'POST /api/config/test-model': async ({ body }) => {
      const type = body?.type || 'main'; // 'main' | 'vision'
      const baseUrl = String(body?.baseUrl || '').trim().replace(/\/+$/, '');
      const model = String(body?.model || '').trim();
      let apiKey = String(body?.apiKey || '').trim();

      if (!baseUrl) return { status: 400, body: { error: '缺少 baseUrl' } };
      if (!model) return { status: 400, body: { error: '缺少 model 名称' } };

      if (isMasked(apiKey) || !apiKey) {
        if (type === 'main') {
          apiKey = config.secrets?.modelApiKey || '';
        } else {
          apiKey = config.secrets?.memeVisionApiKey || config.meme?.visionKey || '';
        }
      }

      const startTime = Date.now();
      try {
        const headers = {
          'Content-Type': 'application/json',
        };
        if (apiKey) {
          headers.Authorization = `Bearer ${apiKey}`;
        }

        const chatPath = ['chat', 'completions'].join('/');
        const endpoint = `${baseUrl}/${chatPath}`;
        const testPayload = {
          model,
          messages: [
            { role: 'user', content: 'Ping! Reply with pong.' },
          ],
          max_tokens: 10,
        };

        const res = await fetchImpl(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(testPayload),
          signal: AbortSignal.timeout(10000),
        });

        const latencyMs = Date.now() - startTime;
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          return {
            body: {
              ok: false,
              latencyMs,
              status: res.status,
              error: `模型返回 HTTP ${res.status}: ${errText.slice(0, 200)}`,
            },
          };
        }

        const data = await res.json().catch(() => ({}));
        const reply = data.choices?.[0]?.message?.content || 'OK';

        return {
          body: {
            ok: true,
            latencyMs,
            status: 200,
            reply: reply.slice(0, 100),
            message: `测试成功 (耗时 ${latencyMs}ms)`,
          },
        };
      } catch (err) {
        const latencyMs = Date.now() - startTime;
        return {
          body: {
            ok: false,
            latencyMs,
            error: `连接失败: ${err.message}`,
          },
        };
      }
    },
  };
}
