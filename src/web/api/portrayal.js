/**
 * web/api/portrayal.js — 用户性格画像 API
 */

import { mergeUnique } from '../../storage/portrayal-store.js';
import { DEFAULT_ANALYSIS_LIMIT } from '../../orchestration/portrayal-worker.js';

/** 取正数，非法时回落 */
function positiveOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(200, Math.floor(n)) : fallback;
}

export function createPortrayalApi(deps) {
  const { portrayalStore, portrayalWorker, sessionStore, logger } = deps;
  const log = logger?.child({ component: 'web-portrayal' }) ?? console;

  return {
    'GET /api/portrayal': async ({ url }) => {
      if (!portrayalStore) {
        return { status: 503, body: { error: '画像存储未就绪' } };
      }
      const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
      const allProfiles = portrayalStore.listProfiles();
      const allTracked = portrayalStore.listTrackedUsers();

      const items = allProfiles.filter((p) => {
        if (!q) return true;
        return (
          p.uid.includes(q) ||
          String(p.nickname || '').toLowerCase().includes(q) ||
          String(p.summary || '').toLowerCase().includes(q) ||
          (p.tags || []).some((t) => t.toLowerCase().includes(q))
        );
      });

      const tracked = allTracked.filter((u) => {
        if (!q) return true;
        return u.uid.includes(q) || String(u.nickname || '').toLowerCase().includes(q);
      });

      return {
        body: {
          total: items.length,
          totalTracked: allTracked.length,
          items,
          trackedUsers: tracked,
        },
      };
    },

    /** 获取某用户被收纳的历史发言预览 */
    'GET /api/portrayal/messages/*': async ({ pathname, url }) => {
      const uid = pathname.slice('/api/portrayal/messages/'.length).trim();
      if (!uid) return { status: 400, body: { error: '缺少 uid' } };
      const limit = Math.min(200, Math.max(5, Number(url.searchParams.get('limit') ?? 50)));

      let messages = [];

      // 1. 优先从 PortrayalStore 持久化的发言历史中取
      if (portrayalStore) {
        messages = portrayalStore.getUserRecentMessages(uid);
      }

      // 2. 其次扫描内存滑窗
      if (messages.length < limit && sessionStore) {
        for (const [sessionId] of sessionStore.contextWindows) {
          mergeUnique(messages, sessionStore.getUserMessages(sessionId, uid, limit));
        }
      }

      // 3. 若依然较少（例如冷启动），自动从统一宿主磁盘群聊历史中召回
      if (messages.length < limit && portrayalWorker && typeof portrayalWorker.extractDiskHistory === 'function') {
        const diskHistory = portrayalWorker.extractDiskHistory(uid, limit);
        if (diskHistory.length) {
          mergeUnique(messages, diskHistory);
          if (portrayalStore) {
            portrayalStore.seedHistory(uid, uid, diskHistory);
          }
        }
      }

      return {
        body: {
          uid,
          total: messages.length,
          messages: messages.slice(-limit),
        },
      };
    },

    'GET /api/portrayal/*': async ({ pathname }) => {
      if (!portrayalStore) {
        return { status: 503, body: { error: '画像存储未就绪' } };
      }
      const uid = pathname.slice('/api/portrayal/'.length);
      const profile = portrayalStore.getProfile(uid);
      if (!profile) {
        return { status: 404, body: { error: `未找到 ${uid} 的画像记录` } };
      }
      return { body: { item: profile } };
    },

    /** 手动触发某用户的结构化画像分析 */
    'POST /api/portrayal/trigger': async ({ body }) => {
      const uid = String(body?.uid ?? '').trim();
      const nickname = String(body?.nickname ?? uid).trim();
      if (!uid) return { status: 400, body: { error: '缺少 uid' } };

      if (!portrayalWorker) {
        return { status: 503, body: { error: '画像分析器未就绪' } };
      }

      const limit = positiveOr(body?.limit, DEFAULT_ANALYSIS_LIMIT);
      let messages = [];
      if (portrayalStore) {
        messages = portrayalStore.getUserRecentMessages(uid);
      }
      if (messages.length < limit && sessionStore) {
        for (const [sessionId] of sessionStore.contextWindows) {
          mergeUnique(messages, sessionStore.getUserMessages(sessionId, uid, limit));
        }
      }
      if (messages.length < limit && typeof portrayalWorker.extractDiskHistory === 'function') {
        mergeUnique(messages, portrayalWorker.extractDiskHistory(uid, limit));
      }

      try {
        const profile = await portrayalWorker.analyzeProfileJson({
          userId: uid,
          nickname,
          messages,
          limit,
        });

        return {
          body: {
            ok: true,
            profile,
          },
        };
      } catch (err) {
        log.error('手动触发画像分析失败', { uid, error: err.message });
        return { status: 500, body: { error: err.message } };
      }
    },

    /** 手动微调保存画像 */
    'POST /api/portrayal/edit': async ({ body }) => {
      const uid = String(body?.uid ?? '').trim();
      if (!uid) return { status: 400, body: { error: '缺少 uid' } };
      if (!portrayalStore) {
        return { status: 503, body: { error: '画像存储未就绪' } };
      }

      const updated = portrayalStore.setProfile(uid, {
        nickname: body.nickname,
        tags: Array.isArray(body.tags) ? body.tags : undefined,
        summary: body.summary,
        taboos: body.taboos,
        suggestion: body.suggestion,
      });

      return { body: { ok: true, profile: updated } };
    },

    /** 获取与管理画像黑名单 */
    'GET /api/portrayal/blacklist': async () => {
      if (!portrayalStore) return { status: 503, body: { error: '画像存储未就绪' } };
      return { body: { blacklist: [...portrayalStore.blacklist] } };
    },

    'POST /api/portrayal/blacklist': async ({ body }) => {
      const uid = String(body?.uid ?? '').trim();
      const action = String(body?.action ?? 'add').toLowerCase();
      if (!uid) return { status: 400, body: { error: '缺少 uid' } };
      if (!portrayalStore) return { status: 503, body: { error: '画像存储未就绪' } };

      if (action === 'add') {
        portrayalStore.addBlacklist(uid);
      } else if (action === 'remove') {
        portrayalStore.removeBlacklist(uid);
      } else {
        return { status: 400, body: { error: 'action 必须是 add 或 remove' } };
      }

      return { body: { ok: true, uid, blacklist: [...portrayalStore.blacklist] } };
    },

    /** 删除指定群友的画像与收纳记录 */
    'DELETE /api/portrayal/*': async ({ pathname }) => {
      const uid = pathname.slice('/api/portrayal/'.length).trim();
      if (!uid) return { status: 400, body: { error: '缺少 uid' } };
      if (!portrayalStore) {
        return { status: 503, body: { error: '画像存储未就绪' } };
      }

      const ok = portrayalStore.deleteTrackedUser(uid);
      return { body: { ok, uid } };
    },

    /** 一键清理未生成画像的群友收纳缓存 */
    'POST /api/portrayal/clear-unprofiled': async () => {
      if (!portrayalStore) {
        return { status: 503, body: { error: '画像存储未就绪' } };
      }
      const count = portrayalStore.clearAllTrackedWithoutProfiles();
      return { body: { ok: true, cleared: count } };
    },
  };
}
