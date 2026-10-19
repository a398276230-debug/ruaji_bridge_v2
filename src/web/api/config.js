/**
 * web/api/config.js — 客制化配置管理与模型连通性测试 API
 *
 * 职责：
 * 1. GET /api/config：读取当前桥接的完整配置、脱敏后的密钥状态及相关元数据
 * 2. PUT /api/config：校验并持久化客制化配置至 bridge.config.json，同步热更新运行时状态
 * 3. POST /api/config/test-model：测试主对话模型、表情包视觉模型或后置匹配模型的连通性与延迟
 */

import fs from 'node:fs';
import { DEFAULTS } from '../../core/config.js';
import path from 'node:path';
import { commandCatalog, normalizeAdminCommands } from '../../core/command-registry.js';
import { normalizeRateLimitList, toConfigRateLimitEntry, normalizeGroupRateLimitList, toConfigGroupRateLimitEntry } from '../../core/rate-limit-policy.js';

/** 取正数，非法（0/负数/NaN）时回落到 fallback */
function positiveOr(value, fallback) {
  if (value == null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 整数钳制到 [min, max]，非法（NaN/非整数）时回落到 fallback */
function clampInt(value, min, max, fallback) {
  if (value == null) return fallback;
  const n = Number(value);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
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
          adminIds: Array.isArray(config.identity?.adminIds) ? [...config.identity.adminIds] : [],
          adminCommands: normalizeAdminCommands(config.identity?.adminCommands),
          robotId: config.identity?.robotId ?? '',
          botName: config.identity?.botName ?? '瑞姬',
          ownerTitle: config.identity?.ownerTitle ?? '主人',
          rateLimitUsers: Array.isArray(config.identity?.rateLimitUsers)
            ? [...config.identity.rateLimitUsers]
            : [],
          privateWhitelist: Array.isArray(config.identity?.privateWhitelist)
            ? [...config.identity.privateWhitelist]
            : [],
          groupWhitelist: Array.isArray(config.identity?.groupWhitelist)
            ? [...config.identity.groupWhitelist]
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
          inputStatusEnabled: config.napcat?.inputStatusEnabled !== false,
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
          sessionRotationsPerDay: config.model?.sessionRotationsPerDay ?? 1,
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
            applyToPrivate: config.decision?.rateLimit?.applyToPrivate === true,
          },
          debounceMs: config.decision?.debounceMs ?? 800,
          localWindowSize: config.decision?.localWindowSize ?? 15,
          localWindowInject: config.decision?.localWindowInject ?? 6,
          queueTimeout: {
            enabled: config.decision?.queueTimeout?.enabled !== false,
            timeoutMs: config.decision?.queueTimeout?.timeoutMs ?? 120000,
            notice: config.decision?.queueTimeout?.notice
              ?? '⏳ 刚才那条排队太久啦，先舍弃了，有需要的话再叫我一次~',
          },
          groupRateLimit: {
            notice: config.decision?.groupRateLimit?.notice
              ?? '瑞姬去休息啦，{minutes}分钟再来找她吧',
          },
        },
        context: {
          totalCharacterBudget: config.context?.totalCharacterBudget ?? 12000,
          perSourceCharacterBudget: config.context?.perSourceCharacterBudget ?? 4000,
          collectTimeoutMs: config.context?.collectTimeoutMs ?? 5000,
          // 默认 true（旧行为）：图片直接挂 image_url 多模态 parts
          directMediaParts: config.context?.directMediaParts !== false,
        },
        reply: {
          sendEnabled: Boolean(config.reply?.sendEnabled),
          sideEffectsEnabled: Boolean(config.reply?.sideEffectsEnabled),
          maxResponseChars: config.reply?.maxResponseChars ?? 100000,
          truncateToChars: config.reply?.truncateToChars ?? 50000,
          maxSendAgeMs: config.reply?.maxSendAgeMs ?? 600000,
          maxSendRetries: config.reply?.maxSendRetries ?? 10,
        },
        toolProgress: {
          ...DEFAULTS.toolProgress,
          ...config.toolProgress,
          groupWhitelist: [...(config.toolProgress?.groupWhitelist ?? [])],
          privateWhitelist: [...(config.toolProgress?.privateWhitelist ?? [])],
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
          // 后置表情匹配（matcher* 留空时回落 vision*）
          matcherEnabled: config.meme?.matcherEnabled === true,
          matcherBaseUrl: config.meme?.matcherBaseUrl ?? '',
          matcherModel: config.meme?.matcherModel ?? '',
          matcherKeyEnv: config.meme?.matcherKeyEnv ?? '',
          matcherKeyMasked: maskSecret(config.secrets?.memeMatcherApiKey || rawConfig.meme?.matcherKey),
          hasMatcherKey: Boolean(config.secrets?.memeMatcherApiKey || rawConfig.meme?.matcherKey),
          matcherTimeoutMs: config.meme?.matcherTimeoutMs ?? 10000,
          matcherMaxRetries: config.meme?.matcherMaxRetries ?? 2,
          matcherCandidateCount: config.meme?.matcherCandidateCount ?? 10,
          matcherEffectiveBaseUrl: config.meme?.matcherBaseUrl || config.meme?.visionBaseUrl || '',
          matcherEffectiveModel: config.meme?.matcherModel || config.meme?.visionModel || 'gpt-4o-mini',
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
        // config.shadowLearn 由 core/config.js 的默认值兜底
        shadowLearn: {
          enabled: Boolean(config.shadowLearn?.enabled),
          targets: Array.isArray(config.shadowLearn?.targets) ? [...config.shadowLearn.targets] : [],
          injectCount: config.shadowLearn?.injectCount ?? 10,
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
          commands: commandCatalog(),
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
      const tp = updates.toolProgress;
      if (tp !== undefined) {
        if (!tp || typeof tp !== 'object' || Array.isArray(tp)) {
          errors.push('toolProgress 必须为配置对象');
        } else {
          for (const key of ['enabled', 'privateEnabled']) {
            if (Object.hasOwn(tp, key) && typeof tp[key] !== 'boolean') {
              errors.push(`toolProgress.${key} 必须为布尔值`);
            }
          }
          for (const key of ['groupWhitelist', 'privateWhitelist']) {
            if (Object.hasOwn(tp, key) && (!Array.isArray(tp[key]) || !tp[key].every((id) => (
              typeof id === 'string' ? /^\d+$/.test(id.trim()) && /[1-9]/.test(id.trim())
                : typeof id === 'number' && Number.isSafeInteger(id) && id > 0
            )))) {
              errors.push(`toolProgress.${key} 必须为正整数 QQ ID 字符串或数字数组`);
            }
          }
          if (Object.hasOwn(tp, 'maxMessagesPerTurn') && (!Number.isInteger(tp.maxMessagesPerTurn) || tp.maxMessagesPerTurn < 1 || tp.maxMessagesPerTurn > 100)) {
            errors.push('toolProgress.maxMessagesPerTurn 必须为 1-100 的整数');
          }
          if (Object.hasOwn(tp, 'minIntervalMs') && (typeof tp.minIntervalMs !== 'number' || !Number.isFinite(tp.minIntervalMs) || tp.minIntervalMs < 0)) {
            errors.push('toolProgress.minIntervalMs 必须为非负有限毫秒数');
          }
        }
      }
      if (updates.identity) {
        if (updates.identity.adminIds !== undefined && (!Array.isArray(updates.identity.adminIds) ||
          updates.identity.adminIds.some((id) => !/^\d+$/.test(String(id).trim())))) {
          errors.push('管理员 QQ 号必须为数字数组');
        }
        if (updates.identity.adminCommands !== undefined && (!Array.isArray(updates.identity.adminCommands) ||
          updates.identity.adminCommands.some((id) => !commandCatalog().some((c) => c.id === id && c.adminGrantable)))) {
          errors.push('管理员授权包含未知命令或主人专属命令');
        }
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
        if (updates.model.sessionRotationsPerDay != null) {
          const n = Number(updates.model.sessionRotationsPerDay);
          if (!Number.isInteger(n) || n < 1 || n > 12 || 24 % n !== 0) {
            errors.push(`每日会话轮转次数 非法: ${updates.model.sessionRotationsPerDay}（应为 1/2/3/4/6/8/12 之一）`);
          }
        }
      }

      if (updates.napcat) {
        if (!updates.napcat.wsUrl) errors.push('NapCat WebSocket URL 不能为空');
        if (!updates.napcat.httpUrl) errors.push('NapCat HTTP URL 不能为空');
      }

      if (updates.meme) {
        if (updates.meme.matcherTimeoutMs != null && !positiveOr(updates.meme.matcherTimeoutMs, 0)) {
          errors.push(`后置匹配超时 非法: ${updates.meme.matcherTimeoutMs}（应为正整数毫秒）`);
        }
        if (updates.meme.matcherMaxRetries != null && clampInt(updates.meme.matcherMaxRetries, 0, 5, null) == null) {
          errors.push(`后置匹配重试次数 非法: ${updates.meme.matcherMaxRetries}（应为 0-5 的整数）`);
        }
        if (updates.meme.matcherCandidateCount != null && clampInt(updates.meme.matcherCandidateCount, 1, 20, null) == null) {
          errors.push(`后置匹配候选数 非法: ${updates.meme.matcherCandidateCount}（应为 1-20 的整数）`);
        }
      }

      if (updates.decision) {
        const qt = updates.decision.queueTimeout;
        if (qt?.timeoutMs != null && (Number(qt.timeoutMs) < 1000 || Number(qt.timeoutMs) > 86400000)) {
          errors.push(`排队超时时长 非法: ${qt.timeoutMs}（应为 1 秒 ~ 24 小时对应的毫秒数）`);
        }
        const rl = updates.decision.rateLimit;
        if (rl?.maxReplies != null && (!Number.isInteger(Number(rl.maxReplies)) || Number(rl.maxReplies) < 1 || Number(rl.maxReplies) > 1000)) {
          errors.push(`频控上限 非法: ${rl.maxReplies}（应为 1-1000 的整数）`);
        }
        if (rl?.windowMs != null && (!Number.isInteger(Number(rl.windowMs)) || Number(rl.windowMs) < 1000 || Number(rl.windowMs) > 86400000)) {
          errors.push(`频控窗口 非法: ${rl.windowMs}（应为 1000 ~ 86400000 毫秒）`);
        }
      }

      // 频控名单：每一条都要能解析出合法 userId；单独额度/窗口也逐个校验。
      // 以前这里只做 String+trim，非法条目会被静默写进配置，运行期永远匹配不上。
      if (Array.isArray(updates.identity?.rateLimitUsers)) {
        for (const entry of updates.identity.rateLimitUsers) {
          const [rule] = normalizeRateLimitList([entry]);
          if (!rule) {
            errors.push(`频控名单条目非法: ${JSON.stringify(entry)}（应为 QQ 号，或 "QQ号[:条数[:窗口毫秒]][:block]"）`);
            continue;
          }
          if (!/^\d{4,15}$/.test(rule.userId)) {
            errors.push(`频控名单 QQ 号非法: ${rule.userId}（应为 4-15 位数字）`);
          }
          if (rule.maxReplies != null && (rule.maxReplies < 1 || rule.maxReplies > 1000)) {
            errors.push(`频控名单单独额度非法: ${rule.userId}:${rule.maxReplies}（应为 1-1000）`);
          }
          if (rule.windowMs != null && (rule.windowMs < 1000 || rule.windowMs > 86400000)) {
            errors.push(`频控名单单独窗口非法: ${rule.userId}:${rule.windowMs}（应为 1000 ~ 86400000 毫秒）`);
          }
        }
      }

      // 群聊白名单同样支持群级频控（"群号:条数[:窗口毫秒]"），逐条校验，
      // 避免非法条目被静默写进配置后既不放行群也起不到限速作用。
      if (Array.isArray(updates.identity?.groupWhitelist)) {
        for (const entry of updates.identity.groupWhitelist) {
          const [rule] = normalizeGroupRateLimitList([entry]);
          if (!rule) {
            errors.push(`群聊白名单条目非法: ${JSON.stringify(entry)}（应为群号，或 "群号[:条数[:窗口毫秒]][:block]"）`);
            continue;
          }
          if (!/^\d{4,15}$/.test(rule.groupId)) {
            errors.push(`群聊白名单群号非法: ${rule.groupId}（应为 4-15 位数字）`);
          }
          if (rule.maxReplies != null && (rule.maxReplies < 1 || rule.maxReplies > 1000)) {
            errors.push(`群级频控额度非法: ${rule.groupId}:${rule.maxReplies}（应为 1-1000）`);
          }
          if (rule.windowMs != null && (rule.windowMs < 1000 || rule.windowMs > 86400000)) {
            errors.push(`群级频控窗口非法: ${rule.groupId}:${rule.windowMs}（应为 1000 ~ 86400000 毫秒）`);
          }
        }
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
          adminCommands: normalizeAdminCommands(updates.identity.adminCommands ?? diskConfig.identity?.adminCommands),
          adminIds: Array.isArray(updates.identity.adminIds)
            ? updates.identity.adminIds.map((u) => String(u).trim()).filter(Boolean)
            : (diskConfig.identity?.adminIds || []),
          robotId: String(updates.identity.robotId).trim(),
          botName: String(updates.identity.botName).trim(),
          // 称呼可留空：留空即回落默认「主人」，不是清掉
          ownerTitle:
            updates.identity.ownerTitle !== undefined
              ? (String(updates.identity.ownerTitle).trim().slice(0, 30) || '主人')
              : (diskConfig.identity?.ownerTitle || '主人'),
          // 名单条目支持纯 QQ 号 / "id:条数" / "id:条数:窗口毫秒" / "id:block" 文本写法，
          // 也支持配置文件里的对象写法。统一解析后：带覆盖项或严格拦截的存对象，
          // 仅用全局默认额度的仍存字符串（旧配置文件、旧前端完全向后兼容）。
          rateLimitUsers: Array.isArray(updates.identity.rateLimitUsers)
            ? normalizeRateLimitList(updates.identity.rateLimitUsers).map(toConfigRateLimitEntry)
            : (diskConfig.identity?.rateLimitUsers || []),
          privateWhitelist: Array.isArray(updates.identity.privateWhitelist)
            ? updates.identity.privateWhitelist.map((u) => String(u).trim()).filter(Boolean)
            : (diskConfig.identity?.privateWhitelist || []),
          groupWhitelist: Array.isArray(updates.identity.groupWhitelist)
            ? normalizeGroupRateLimitList(updates.identity.groupWhitelist).map(toConfigGroupRateLimitEntry)
            : (diskConfig.identity?.groupWhitelist || []),
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
        if (updates.napcat.inputStatusEnabled != null) nap.inputStatusEnabled = Boolean(updates.napcat.inputStatusEnabled);
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
        if (updates.model.sessionRotationsPerDay != null) m.sessionRotationsPerDay = Number(updates.model.sessionRotationsPerDay);
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
        // 后置表情匹配字段：enabled/retries/candidates/timeout 热生效；
        // 端点/模型/key 改动落盘后需重启（adapter 在构造期取值）
        if (updates.meme.matcherEnabled != null) mem.matcherEnabled = Boolean(updates.meme.matcherEnabled);
        if (updates.meme.matcherBaseUrl !== undefined) mem.matcherBaseUrl = String(updates.meme.matcherBaseUrl).trim();
        if (updates.meme.matcherModel !== undefined) mem.matcherModel = String(updates.meme.matcherModel).trim();
        if (updates.meme.matcherKeyEnv) mem.matcherKeyEnv = updates.meme.matcherKeyEnv.trim();
        if (updates.meme.matcherKey !== undefined) {
          if (!isMasked(updates.meme.matcherKey)) {
            mem.matcherKey = updates.meme.matcherKey.trim();
          }
        }
        if (updates.meme.matcherTimeoutMs != null) mem.matcherTimeoutMs = positiveOr(updates.meme.matcherTimeoutMs, 10000);
        if (updates.meme.matcherMaxRetries != null) mem.matcherMaxRetries = clampInt(updates.meme.matcherMaxRetries, 0, 5, 2);
        if (updates.meme.matcherCandidateCount != null) mem.matcherCandidateCount = clampInt(updates.meme.matcherCandidateCount, 1, 20, 10);
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
            // 默认 false：私聊本来就要过白名单门禁，不把频控顺带压到私聊上
            applyToPrivate: updates.decision.rateLimit?.applyToPrivate != null
              ? Boolean(updates.decision.rateLimit.applyToPrivate)
              : (diskConfig.decision?.rateLimit?.applyToPrivate === true),
          },
        };
        // 排队超时：巡检器每次 tick 现读 config.decision.queueTimeout，落盘 + Object.assign 即热生效
        if (updates.decision.queueTimeout) {
          const prev = diskConfig.decision.queueTimeout || {};
          const qt = updates.decision.queueTimeout;
          diskConfig.decision.queueTimeout = {
            enabled: qt.enabled != null ? Boolean(qt.enabled) : (prev.enabled !== false),
            timeoutMs: clampInt(qt.timeoutMs, 1000, 86400000, prev.timeoutMs ?? 120000),
            notice: qt.notice ? String(qt.notice).trim().slice(0, 200) : (prev.notice ?? '⏳ 刚才那条排队太久啦，先舍弃了，有需要的话再叫我一次~'),
          };
        }
        // 群级频控提示文案：inbound-flow 每次命中现读，落盘 + Object.assign 即热生效
        if (updates.decision.groupRateLimit) {
          const prev = diskConfig.decision.groupRateLimit || {};
          const gt = updates.decision.groupRateLimit;
          diskConfig.decision.groupRateLimit = {
            notice: gt.notice ? String(gt.notice).trim().slice(0, 200) : (prev.notice ?? '瑞姬去休息啦，{minutes}分钟再来找她吧'),
          };
        }
      }

      if (updates.context) {
        diskConfig.context = {
          ...(diskConfig.context || {}),
          totalCharacterBudget: updates.context.totalCharacterBudget != null ? Number(updates.context.totalCharacterBudget) : (diskConfig.context?.totalCharacterBudget ?? 12000),
          perSourceCharacterBudget: updates.context.perSourceCharacterBudget != null ? Number(updates.context.perSourceCharacterBudget) : (diskConfig.context?.perSourceCharacterBudget ?? 4000),
          collectTimeoutMs: updates.context.collectTimeoutMs != null ? Number(updates.context.collectTimeoutMs) : (diskConfig.context?.collectTimeoutMs ?? 5000),
          // 渲染层现读 config.context.directMediaParts，落盘 + 下面 Object.assign 即热生效
          directMediaParts: updates.context.directMediaParts != null
            ? Boolean(updates.context.directMediaParts)
            : (diskConfig.context?.directMediaParts !== false),
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

      if (tp !== undefined) {
        const next = { ...DEFAULTS.toolProgress, ...config.toolProgress, ...diskConfig.toolProgress };
        for (const key of Object.keys(DEFAULTS.toolProgress)) {
          if (Object.hasOwn(tp, key)) {
            next[key] = Array.isArray(tp[key]) ? tp[key].map((id) => String(id).trim()) : tp[key];
          }
        }
        diskConfig.toolProgress = next;
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

      if (updates.shadowLearn) {
        const prev = diskConfig.shadowLearn || {};
        diskConfig.shadowLearn = {
          ...prev,
          enabled: updates.shadowLearn.enabled != null ? Boolean(updates.shadowLearn.enabled) : Boolean(prev.enabled),
          targets: Array.isArray(updates.shadowLearn.targets)
            ? [...new Set(updates.shadowLearn.targets.map((s) => String(s).trim()).filter(Boolean))]
            : (prev.targets || []),
          injectCount: Math.min(10, Math.max(1, positiveOr(updates.shadowLearn.injectCount, prev.injectCount ?? 10))),
        };
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
      if (diskConfig.napcat?.inputStatusEnabled != null) {
        config.napcat.inputStatusEnabled = diskConfig.napcat.inputStatusEnabled;
      }
      if (diskConfig.decision) {
        Object.assign(config.decision, diskConfig.decision);
        if (sessionStore && diskConfig.decision.localWindowSize) {
          sessionStore.windowSize = diskConfig.decision.localWindowSize;
        }
        // 频控窗口在 SessionStore 构造时取过一次，必须推给活着的实例，
        // 否则面板改窗口是"保存成功但不生效"。阈值/名单/严格拦截都由
        // core/rate-limit-policy.js 现读 config，不需要额外同步。
        if (sessionStore && diskConfig.decision.rateLimit?.windowMs) {
          sessionStore.rateLimitWindowMs = Number(diskConfig.decision.rateLimit.windowMs);
        }
      }
      if (diskConfig.model?.sessionCutoffHour != null) {
        config.model.sessionCutoffHour = diskConfig.model.sessionCutoffHour;
        // 分界值在适配器构造时就取好了，必须同步推给活着的实例，否则要重启才生效
        if (modelAdapter) modelAdapter.sessionCutoffHour = diskConfig.model.sessionCutoffHour;
      }
      if (diskConfig.model?.sessionRotationsPerDay != null) {
        config.model.sessionRotationsPerDay = diskConfig.model.sessionRotationsPerDay;
        // 轮转次数同理：构造时取好，必须热推给活着的实例
        if (modelAdapter) modelAdapter.sessionRotationsPerDay = diskConfig.model.sessionRotationsPerDay;
      }
      if (diskConfig.context) Object.assign(config.context, diskConfig.context);
      if (diskConfig.reply) Object.assign(config.reply, diskConfig.reply);
      if (diskConfig.fastAck) Object.assign(config.fastAck, diskConfig.fastAck);
      if (tp !== undefined) {
        config.toolProgress = { ...config.toolProgress, ...diskConfig.toolProgress };
      }
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
      // 影子模式的消费方（context-flow 采集挂钩与注入 provider）都从 config 现场读，
      // 这里整体替换即可热生效，无需推送活实例。
      if (diskConfig.shadowLearn) {
        config.shadowLearn = { ...(config.shadowLearn || {}), ...diskConfig.shadowLearn };
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
      const type = body?.type || 'main'; // 'main' | 'vision' | 'matcher'
      let baseUrl = String(body?.baseUrl || '').trim().replace(/\/+$/, '');
      let model = String(body?.model || '').trim();
      let apiKey = String(body?.apiKey || '').trim();

      // matcher：body 字段留空时回落 vision 字段（与运行时回落逻辑一致）
      if (type === 'matcher') {
        if (!baseUrl) baseUrl = String(config.meme?.visionBaseUrl || '').trim().replace(/\/+$/, '');
        if (!model) model = String(config.meme?.visionModel || '').trim();
      }

      if (!baseUrl) return { status: 400, body: { error: '缺少 baseUrl' } };
      if (!model) return { status: 400, body: { error: '缺少 model 名称' } };

      if (isMasked(apiKey) || !apiKey) {
        if (type === 'main') {
          apiKey = config.secrets?.modelApiKey || '';
        } else if (type === 'matcher') {
          apiKey = config.secrets?.memeMatcherApiKey || config.meme?.matcherKey || config.meme?.visionKey || '';
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
          signal: AbortSignal.timeout(45000),
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
