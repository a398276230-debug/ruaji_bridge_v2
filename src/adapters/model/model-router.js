/**
 * adapters/model/model-router.js — 模型路由
 *
 * 首期只有一条路由规则：按 provider 名选 adapter。存在的意义是给编排层一个
 * 稳定入口——将来要按会话/任务类型分流到不同模型时，改这里而不是改 reply-flow。
 */

import { OpenAiCompatibleAdapter } from './openai-compatible.js';
import { MockModelAdapter } from './mock-model.js';
import { ConfigError } from '../../contracts/errors.js';

export function createModelAdapter(config, { logger, fetchImpl, sessionStore } = {}) {
  const provider = config.model.provider;

  if (provider === 'mock') {
    return new MockModelAdapter(config.model.mock ?? {});
  }
  if (provider === 'openai-compatible') {
    return new OpenAiCompatibleAdapter({
      baseUrl: config.model.baseUrl,
      model: config.model.model,
      apiKey: config.secrets?.modelApiKey ?? '',
      sessionHeader: config.model.sessionHeader,
      sessionPrefix: config.model.sessionPrefix,
      sessionCutoffHour: config.model.sessionCutoffHour,
      sessionStore,
      timeoutMs: config.model.timeoutMs,
      maxRetries: config.model.maxRetries,
      logger,
      fetchImpl,
    });
  }
  throw new ConfigError(`不支持的模型 provider: ${provider}`);
}

export class ModelRouter {
  /**
   * @param {object} opts
   * @param {object} opts.defaultAdapter
   * @param {import('../../core/logger.js').Logger} [opts.logger]
   */
  constructor(opts = {}) {
    this.defaultAdapter = opts.defaultAdapter;
    this.log = opts.logger?.child({ component: 'model-router' }) ?? console;
    /** 预留：(modelRequest) => adapter | null */
    this.rules = [];
  }

  addRule(rule) {
    this.rules.push(rule);
    return this;
  }

  select(modelRequest) {
    for (const rule of this.rules) {
      const adapter = rule(modelRequest);
      if (adapter) return adapter;
    }
    return this.defaultAdapter;
  }

  generate(modelRequest, opts) {
    return this.select(modelRequest).generate(modelRequest, opts);
  }

  getSessionId(sessionKey, now) {
    return this.defaultAdapter.getSessionId?.(sessionKey, now) ?? null;
  }

  resetSession(sessionKey, now) {
    return this.defaultAdapter.resetSession(sessionKey, now);
  }

  ping() {
    return this.defaultAdapter.ping();
  }
}
