/**
 * orchestration/command-flow.js — 管理与查询命令
 *
 * 命令在本层直接执行，不发给模型。迁移自 bridge.js:1499-1681。
 *
 * 权限（原样保留）：
 *   仅主人：/new（及其变体）、/model
 *   所有人：/好感度、/收集表情、/完成收集
 *
 * 明确不迁移：
 *   /model 的 python scripts/switch_model.py 子进程调用。它是旧 Bridge 直接
 *   exec 工作区脚本的遗留（bridge.js:1614-1659），属于"无明确调用来源的旧兼容
 *   分支 + 散落的固定路径"。v2 保留命令入口与权限判定，实际动作留给外部工具，
 *   命令返回一句明确的提示而不是静默失败。
 *
 * 命令文本一律取自 textOnly（剔除全部 CQ 码），并剥掉开头的名字呼唤——
 * 用 content 会因为 @ 被转成 " @瑞姬 " 而导致 "@瑞姬 /new" 命中不了。
 */

import { createOutboundMessage, MESSAGE_TYPES } from '../contracts/messages.js';
import { deriveCommandText, extractAtTargets } from '../adapters/napcat/inbound-normalizer.js';
import { formatBar, getRelationStage, INITIAL_AFFECTION } from '../storage/affection-store.js';
import { stripAffTags } from '../middleware/affection.js';
import { mergeUnique } from '../storage/portrayal-store.js';

const NEW_SESSION_ALIASES = new Set(['/new', '///new', '////new', '#new']);

/**
 * 解析命令末尾的数字参数（如 /画像 @某人 50、/冷暴力 @某人 30）。
 *
 * 必须先剥掉 @提及再匹配：message_format=array 的事件里 raw_message 可能为空，
 * inbound.text 走 segmentsToText 兜底，at 段会被渲染成 "@123456"（cq.js:141）。
 * 不剥的话 "/冷暴力 @2260757842" 会把 QQ 号尾巴当成时长解析出 57842 分钟。
 */
export function parseTrailingInt(text, { min, max, fallback }) {
  const stripped = String(text ?? '')
    .replace(/\[CQ:[^\]]*\]/g, ' ')
    .replace(/@\d+/g, ' ');
  const matched = stripped.match(/(?:^|\s)(\d{1,5})\s*$/);
  if (!matched) return fallback;
  const parsed = parseInt(matched[1], 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export class CommandFlow {
  /**
   * @param {object} opts
   * @param {import('../adapters/model/model-router.js').ModelRouter} opts.modelRouter
   * @param {import('../storage/affection-store.js').AffectionStore} opts.affectionStore
   * @param {import('../storage/portrayal-store.js').PortrayalStore} [opts.portrayalStore]
   * @param {import('./portrayal-worker.js').PortrayalWorker} [opts.portrayalWorker]
   * @param {import('../storage/session-store.js').SessionStore} [opts.sessionStore]
   * @param {import('../adapters/napcat/sender.js').Sender} opts.sender
   * @param {object} opts.config
   * @param {import('../core/logger.js').Logger} opts.logger
   */
  constructor(opts = {}) {
    this.models = opts.modelRouter;
    this.affection = opts.affectionStore;
    this.portrayal = opts.portrayalStore ?? null;
    this.portrayalWorker = opts.portrayalWorker ?? null;
    this.sessions = opts.sessionStore ?? null;
    this.memes = opts.memeStore;
    this.sender = opts.sender;
    this.config = opts.config;
    this.log = opts.logger?.child({ component: 'command-flow' }) ?? console;
  }

  /**
   * @param {object} inbound
   * @returns {Promise<{ handled: boolean, command: string|null }>}
   */
  async handle(inbound) {
    const cmd = deriveCommandText(inbound.text, this.config.identity.botName);
    if (!cmd.startsWith('/') && !cmd.startsWith('#')) return { handled: false, command: null };

    const isOwner = inbound.flags.isOwner;

    if (NEW_SESSION_ALIASES.has(cmd)) {
      if (!isOwner) return this._deny(inbound, '/new');
      return this._resetSession(inbound);
    }

    if (cmd === '/好感' || cmd.startsWith('/好感度') || cmd.startsWith('/affection')) {
      return this._affectionStats(inbound);
    }

    if (cmd.startsWith('/查看画像') || cmd.startsWith('/画像详情')) {
      return this._viewPortrayal(inbound);
    }

    if (cmd.startsWith('/正画像')) {
      return this._generatePortrayal(inbound, 'positive', '/正画像');
    }
    if (cmd.startsWith('/负画像')) {
      return this._generatePortrayal(inbound, 'negative', '/负画像');
    }
    if (cmd.startsWith('/克隆人格') || cmd.startsWith('/克隆')) {
      return this._generatePortrayal(inbound, 'clone', '/克隆人格');
    }
    if (cmd.startsWith('/找对象') || cmd.startsWith('/match')) {
      return this._generatePortrayal(inbound, 'match', '/找对象');
    }
    if (cmd.startsWith('/画像') || cmd.startsWith('/portrayal')) {
      return this._generatePortrayal(inbound, 'portrait', '/画像');
    }

    if (cmd.startsWith('/取消冷暴力') || cmd.startsWith('/解除冷暴力') || cmd.startsWith('/unfreeze')) {
      if (!isOwner) return this._deny(inbound, '/取消冷暴力');
      return this._liftColdViolenceCommand(inbound);
    }

    if (cmd.startsWith('/冷暴力') || cmd.startsWith('/freeze')) {
      if (!isOwner) return this._deny(inbound, '/冷暴力');
      return this._triggerColdViolenceCommand(inbound, cmd);
    }

    if (cmd === '/model' || cmd.startsWith('/model ') || cmd.startsWith('///model ')) {
      if (!isOwner) return this._deny(inbound, '/model');
      return this._modelCommand(inbound, cmd);
    }

    // 表情包批量收集模式
    if (cmd === '/收集' || cmd.startsWith('/收集表情') || cmd.startsWith('/collect')) {
      const parts = cmd.replace(/^\/(?:收集表情|收集|collect)\s*/, '').trim().split(/\s+/);
      const category = parts[0] || '常用';
      const tag = parts[1] || category;
      const replyText = this.memes ? this.memes.startCollect(inbound.userId, category, tag) : '表情包管理器未就绪';
      return this._reply(inbound, replyText, '/收集表情');
    }
    if (['/完成收集', '/退出收集', '/stop_collect', '/done'].includes(cmd)) {
      const replyText = this.memes ? this.memes.stopCollect(inbound.userId) : '表情包管理器未就绪';
      return this._reply(inbound, replyText, '/完成收集');
    }

    return { handled: false, command: null };
  }

  async _resetSession(inbound) {
    try {
      const newId = await this.models.resetSession(inbound.executionKey);
      this.log.info('会话已重置', {
        correlationId: inbound.correlationId,
        executionKey: inbound.executionKey,
        newSessionId: newId,
      });
    } catch (err) {
      this.log.error('会话重置失败', { correlationId: inbound.correlationId, error: err.message });
    }
    return this._reply(inbound, '新会话已开启，之前的上下文已清空。', '/new');
  }

  async _viewPortrayal(inbound) {
    const atTargets = extractAtTargets(inbound.rawMessage, inbound.segments).filter(
      (id) => id !== String(this.config.identity.robotId),
    );
    const targetId = atTargets[0] || inbound.userId;
    if (this.portrayal && this.portrayal.isBlacklisted(targetId)) {
      return this._reply(inbound, `该账号【${targetId}】为受保护账号/机器人，不参与画像分析。`, '/查看画像');
    }
    if (!this.portrayal) {
      return this._reply(inbound, '用户画像模块尚未就绪。', '/查看画像');
    }
    const profile = this.portrayal.getProfile(targetId);
    if (!profile) {
      return this._reply(inbound, `暂无该用户【${targetId}】的画像记录，可使用 /画像 @某人 生成。`, '/查看画像');
    }
    const name = profile.nickname || targetId;
    const lines = [
      `【✨ 用户性格画像】${name} (ID: ${targetId})`,
      `━━━━━━━━━━━━━━━━━━`,
      `🏷️ 核心标签: ${profile.tags?.length ? profile.tags.join(' / ') : '暂无'}`,
      `📝 行为简述: ${profile.summary || '暂无'}`,
      `⚡ 沟通雷区: ${profile.taboos || '暂无'}`,
      `💡 相处建议: ${profile.suggestion || '暂无'}`,
      `🕒 更新时间: ${profile.updatedAt ? new Date(profile.updatedAt).toLocaleString('zh-CN') : '未知'}`,
    ];
    return this._reply(inbound, lines.join('\n'), '/查看画像');
  }

  async _generatePortrayal(inbound, templateKey, commandName) {
    const atTargets = extractAtTargets(inbound.rawMessage, inbound.segments).filter(
      (id) => id !== String(this.config.identity.robotId),
    );
    const targetId = atTargets[0] || inbound.userId;
    const targetName = atTargets.length && this.affection.getUser(targetId)?.nickname
      ? this.affection.getUser(targetId).nickname
      : (atTargets.length ? targetId : inbound.sender.displayName);

    if (this.portrayal && this.portrayal.isBlacklisted(targetId)) {
      return this._reply(inbound, `该账号【${targetName}】为受保护账号/机器人，不参与画像分析。`, commandName);
    }

    if (!this.portrayalWorker) {
      return this._reply(inbound, '画像分析器未就绪。', commandName);
    }

    // 提取轮数参数（如 /画像 @群友 50，默认 50 条）
    const limit = parseTrailingInt(inbound.text, { min: 10, max: 200, fallback: 50 });

    // 多源聚合：持久化发言历史 + 内存滑窗 + 磁盘群聊文件，确保凑满 limit 条
    let userTexts = [];

    // 1. 优先取 PortrayalStore 持久化的最近发言
    if (this.portrayal) {
      userTexts = this.portrayal.getUserRecentMessages(targetId);
    }

    // 2. 内存滑窗补全
    if (this.sessions && typeof this.sessions.getUserMessages === 'function') {
      mergeUnique(userTexts, this.sessions.getUserMessages(inbound.sessionId, targetId, limit));
    }

    // 3. 若不足 limit，自动从统一宿主磁盘群聊历史中召回
    if (userTexts.length < limit && typeof this.portrayalWorker.extractDiskHistory === 'function') {
      mergeUnique(userTexts, this.portrayalWorker.extractDiskHistory(targetId, limit));
    }

    // 4. 若依然为空，以当前消息兜底
    if (!userTexts.length && inbound.text) {
      userTexts.push(`${targetName}: ${inbound.text}`);
    }

    // 截取最新的 limit 条
    userTexts = userTexts.slice(-limit);

    try {
      const result = await this.portrayalWorker.analyzeCommand({
        templateKey,
        userId: targetId,
        nickname: targetName,
        messages: userTexts,
        limit,
      });

      const cleanResult = stripAffTags(result);

      return this._reply(
        inbound,
        `【🔮 ${commandName.slice(1)}分析报告 - ${targetName}】\n${cleanResult}`,
        commandName,
      );
    } catch (err) {
      this.log.error('画像分析失败', { error: err.message, userId: targetId });
      return this._reply(inbound, `画像分析失败了…… ${err.message}`, commandName);
    }
  }

  _modelCommand(inbound, cmd) {
    const arg = cmd.replace(/^\/{1,3}model\s*/, '').trim();
    if (!arg || arg === 'list' || arg === '列表' || arg === 'current' || arg === '当前') {
      return this._reply(
        inbound,
        '模型切换已移出桥接层。v2 只负责调用 model.baseUrl 指定的模型，' +
          '要换模型请改 bridge.config.json 的 model 段或用外部工具。',
        '/model',
      );
    }
    return this._reply(
      inbound,
      `v2 不再直接执行模型切换脚本。请求的目标: ${arg}。改配置后重启 v2 生效。`,
      '/model',
    );
  }

  _liftColdViolenceCommand(inbound) {
    const atTargets = extractAtTargets(inbound.rawMessage, inbound.segments).filter(
      (id) => id !== String(this.config.identity.robotId),
    );
    const targetId = atTargets[0] || inbound.userId;
    if (this.affection.isOwner(targetId)) {
      return this._reply(inbound, '主人不受冷暴力影响。', '/取消冷暴力');
    }
    const ok = this.affection.liftColdViolence(targetId);
    const user = this.affection.getUser(targetId);
    const name = user?.nickname || targetId;
    return this._reply(
      inbound,
      ok ? `已解除【${name}】的冷暴力状态。` : `未找到【${name}】的好感度记录。`,
      '/取消冷暴力',
    );
  }

  _triggerColdViolenceCommand(inbound, cmd) {
    const atTargets = extractAtTargets(inbound.rawMessage, inbound.segments).filter(
      (id) => id !== String(this.config.identity.robotId),
    );
    if (!atTargets.length) {
      return this._reply(inbound, '请 @ 需要施加冷暴力的群友，例如：/冷暴力 @某人 60', '/冷暴力');
    }
    const targetId = atTargets[0];
    if (this.affection.isOwner(targetId)) {
      return this._reply(inbound, '主人不可被施加冷暴力。', '/冷暴力');
    }

    // 显式提取时长参数，钳制在 1 分钟 ~ 24 小时
    const mins = parseTrailingInt(cmd.replace(/(分钟|分|min|m)\s*$/i, ''), {
      min: 1,
      max: 1440,
      fallback: 60,
    });
    const durationMs = mins * 60 * 1000;

    const ok = this.affection.triggerColdViolence(targetId, durationMs);
    const user = this.affection.getUser(targetId);
    const name = user?.nickname || targetId;
    const rem = this.affection.getColdRemainingMinutes(targetId);
    return this._reply(
      inbound,
      ok ? `已将【${name}】置入冷暴力状态（持续 ${rem} 分钟）。` : `操作失败。`,
      '/冷暴力',
    );
  }

  _affectionStats(inbound) {
    const atTargets = extractAtTargets(inbound.rawMessage, inbound.segments).filter(
      (id) => id !== String(this.config.identity.robotId),
    );

    let text;
    try {
      if (inbound.messageType === MESSAGE_TYPES.PRIVATE) {
        text = this._formatAll();
      } else if (atTargets.length) {
        const targetId = atTargets[0];
        const user = this.affection.getUser(targetId);
        text = this._formatOne(targetId, user?.nickname ?? targetId);
      } else {
        text = this._formatOne(inbound.userId, inbound.sender.displayName);
      }
    } catch (err) {
      this.log.error('好感度统计失败', { correlationId: inbound.correlationId, error: err.message });
      text = `好感度统计出错了…… ${err.message}`;
    }
    return this._reply(inbound, text, '/好感度');
  }

  /** 迁移自 affection.js:182-197 */
  _formatAll() {
    const entries = this.affection.listUsers();
    if (!entries.length) return '【好感度统计】\n还没有任何记录……';

    const lines = ['【💖 Favour Ultra 好感度统计】', `共记录 ${entries.length} 位对象`, '——————————'];
    entries.slice(0, 20).forEach(([uid, user], i) => {
      const isOwner = this.affection.isOwner(uid);
      const isCold = this.affection.isColdViolent(uid);
      const coldRem = isCold ? ` [❄️冷暴力中(${this.affection.getColdRemainingMinutes(uid)}m)]` : '';
      const shown = Math.round(user.affection);
      const relation = user.relationship || getRelationStage(user.affection).title;
      lines.push(
        `${i + 1}. ${user.nickname || uid}${isOwner ? ' ★(绑定者)' : ''}${coldRem} ｜ ${shown}/100\n` +
          `    ${formatBar(user.affection)} 关系：${relation} (互动${user.interactions}次)`,
      );
    });
    return lines.join('\n');
  }

  /** 迁移自 affection.js:199-210 */
  _formatOne(uid, nickname) {
    const user = this.affection.getUser(uid) ?? {
      affection: INITIAL_AFFECTION,
      interactions: 0,
      firstSeen: new Date().toISOString(),
    };
    const shown = Math.round(user.affection);
    const isOwner = this.affection.isOwner(uid);
    const isCold = this.affection.isColdViolent(uid);
    const relation = user.relationship || getRelationStage(user.affection).title;
    const lines = [
      `【💖 好感度】${nickname || uid} ｜ ${shown}/100 ${isOwner ? '★(唯一绑定者)' : ''}`,
      formatBar(user.affection),
      `关系阶段：${relation}`,
      `互动 ${user.interactions} 次 · 首次相遇 ${new Date(user.firstSeen).toLocaleDateString()}`,
    ];
    if (isCold) {
      lines.push(`❄️ 处于冷暴力惩罚状态：剩余 ${this.affection.getColdRemainingMinutes(uid)} 分钟`);
    }
    return lines.join('\n');
  }

  _deny(inbound, command) {
    this.log.warn('拒绝非主人的管理命令', {
      correlationId: inbound.correlationId,
      userId: inbound.userId,
      command,
    });
    // 旧 Bridge 是静默 return（bridge.js:1506），保持一致：不给任何回应
    return { handled: true, command };
  }

  _reply(inbound, text, command) {
    this.sender.enqueue(
      createOutboundMessage({
        correlationId: inbound.correlationId,
        sessionId: inbound.sessionId,
        target: {
          type: inbound.messageType,
          id: inbound.messageType === MESSAGE_TYPES.GROUP ? inbound.groupId : inbound.userId,
        },
        replyToUserId: inbound.userId,
        text,
        metadata: { isFirst: true, command },
      }),
    );
    this.log.info('命令已执行', { correlationId: inbound.correlationId, command });
    return { handled: true, command };
  }
}
