/**
 * app/preflight.js — 依赖就绪检查
 *
 * 迁移自旧 preflight.js，保留它治好"43614 行启动重试刷屏"的两个核心设计：
 *   1. 分项检查（NapCat / 模型分开报），失败时能直接定位
 *   2. 分级退避 + 原因去重日志：只在原因变化或到达告警间隔时才打日志
 *
 * 差异：影子模式下模型不可用不阻塞启动——影子跑的是规范化与裁决对照，
 * 模型挂了照样有对照价值。
 */

const BACKOFF_TABLE = [
  [3, 2000],
  [6, 5000],
  [12, 15000],
];

export function backoffMs(attempt) {
  for (const [maxAttempt, ms] of BACKOFF_TABLE) {
    if (attempt <= maxAttempt) return ms;
  }
  return 60000;
}

/**
 * @param {object} deps
 * @param {import('../adapters/napcat/napcat-api.js').NapcatApi} deps.napcatApi
 */
export async function checkNapcat({ napcatApi }) {
  let data;
  try {
    data = await napcatApi.getLoginInfo();
  } catch (err) {
    const why = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? '请求超时' : err.message;
    return {
      ok: false,
      detail: `无法连接 NapCat HTTP (${napcatApi.httpUrl}): ${why} — 未启动或端口未监听`,
    };
  }

  const uid = data?.data?.user_id;
  if (!uid) {
    return {
      ok: false,
      detail: `NapCat 已响应但未返回 user_id — QQ 尚未登录完成 (${JSON.stringify(data).slice(0, 200)})`,
    };
  }

  // get_status 不是所有实现都支持，失败不阻塞
  let online = null;
  try {
    const status = await napcatApi.getStatus();
    online = status?.data?.online ?? null;
  } catch { /* 非致命 */ }

  if (online === false) {
    return { ok: false, detail: `QQ ${uid} 已连接 NapCat 但显示离线 — 可能掉线待重登` };
  }
  return { ok: true, detail: `NapCat 就绪，QQ ${uid} 在线`, botId: String(uid) };
}

export async function checkModel({ modelRouter }) {
  const ping = await modelRouter.ping();
  return { ok: ping.ok, detail: ping.detail };
}

/**
 * 阻塞直到依赖就绪。
 * @param {object} deps
 * @param {object} deps.config
 * @param {import('../core/logger.js').Logger} deps.logger
 * @param {number} [deps.maxAttempts] 0 = 永不放弃
 * @returns {Promise<{ botId: string|null }>}
 */
export async function waitForDependencies({ config, logger, napcatApi, modelRouter, maxAttempts = 0, alertEvery = 10, sleep }) {
  const log = logger.child({ component: 'preflight' });
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const modelRequired = config.mode === 'live';

  let attempt = 0;
  let lastSignature = '';

  for (;;) {
    attempt++;

    const napcat = await checkNapcat({ napcatApi });
    const model = napcat.ok ? await checkModel({ modelRouter }) : { ok: false, detail: '（因 NapCat 未就绪而跳过）' };

    if (napcat.ok && (model.ok || !modelRequired)) {
      log.info(`preflight 通过（第 ${attempt} 次尝试）`, {
        napcat: napcat.detail,
        model: model.ok ? model.detail : `${model.detail}（影子模式下不阻塞）`,
      });
      return { botId: napcat.botId ?? null };
    }

    const failed = !napcat.ok ? 'NapCat' : '模型';
    const detail = !napcat.ok ? napcat.detail : model.detail;
    const signature = `${failed}:${detail}`;
    const waitMs = backoffMs(attempt);

    // 只在"原因变化"或"到达告警间隔"时打日志 —— 这是治好刷屏的关键
    if (signature !== lastSignature) {
      log.warn('preflight 未通过', { component: failed, detail, nextRetryMs: waitMs, attempt });
      lastSignature = signature;
    } else if (attempt % alertEvery === 0) {
      log.error('preflight 仍未通过，原因未变', { component: failed, detail, attempt });
    }

    if (maxAttempts && attempt >= maxAttempts) {
      throw new Error(`preflight 失败，已达最大尝试次数 ${maxAttempts}；最后原因 [${failed}] ${detail}`);
    }
    await wait(waitMs);
  }
}
