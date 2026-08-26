/**
 * orchestration/fast-ack.js — 异步长任务快速响应通道（附录 3）
 *
 * 遇到生图（ComfyUI）、写代码这类长任务时，先立即回一句预置确认语
 * （"收到，已派给编程/画师，弄好叫你~"），再让主链路继续在后台跑模型。
 *
 * 关键约束：
 *   - 确认语走普通发送队列，享受同样的幂等与重试
 *   - 只在本轮的第一条确认语发出，不重复 ack
 *   - 主动接话不 ack（本来就是插话，再来一句确认很怪）
 *   - 影子模式下照常"生成"确认语，只是 sender 不会真的投递
 */

import { createOutboundMessage, MESSAGE_TYPES } from '../contracts/messages.js';
import { TRIGGER_TYPES } from '../contracts/capabilities.js';

export class FastAckDispatcher {
  /**
   * @param {object} opts
   * @param {object} opts.config
   * @param {import('../core/logger.js').Logger} opts.logger
   */
  constructor(opts = {}) {
    this.config = opts.config;
    this.log = opts.logger?.child({ component: 'fast-ack' }) ?? console;

    const cfg = opts.config.fastAck ?? {};
    this.enabled = cfg.enabled === true;
    this.message = cfg.message ?? '收到，稍等一下~';
    this.patterns = (cfg.patterns ?? []).map((p) => {
      try {
        return new RegExp(p, 'i');
      } catch (err) {
        this.log.warn('fastAck.patterns 中有非法正则，已忽略', { pattern: p, error: err.message });
        return null;
      }
    }).filter(Boolean);
  }

  /** 是否是需要预先确认的长任务 */
  matches(text) {
    if (!this.enabled || this.patterns.length === 0) return false;
    const value = String(text ?? '');
    return this.patterns.some((re) => re.test(value));
  }

  /**
   * @param {object} params
   * @param {object} params.inbound
   * @param {string} params.triggerType
   * @param {AbortSignal} [params.signal]
   * @param {(outbound: object) => void} params.enqueue
   * @returns {Promise<boolean>} 是否发出了确认语
   */
  async maybeAck({ inbound, triggerType, signal, enqueue }) {
    if (triggerType === TRIGGER_TYPES.AI_DECISION) return false;
    if (signal?.aborted) return false;
    if (!this.matches(inbound.text || inbound.content)) return false;

    enqueue(
      createOutboundMessage({
        correlationId: inbound.correlationId,
        sessionId: inbound.sessionId,
        target: {
          type: inbound.messageType,
          id: inbound.messageType === MESSAGE_TYPES.GROUP ? inbound.groupId : inbound.userId,
        },
        replyToUserId: inbound.userId,
        text: this.message,
        metadata: { isFirst: true, fastAck: true },
      }),
    );

    this.log.info('已发出长任务确认语', {
      correlationId: inbound.correlationId,
      sessionId: inbound.sessionId,
    });
    return true;
  }
}
