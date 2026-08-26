/**
 * web/api/affection.js — 好感度看板与手动微调
 *
 * 读走 AffectionStore 的内存镜像（它启动时已经把旧 Bridge 的 affection.json
 * 原样读进来了），不重新开文件 —— 面板与主链路必须看到同一份数据，
 * 否则运维在面板上改完，主链路的内存副本还是旧值。
 *
 * 写入遵守存储层既有的影子约束：sideEffectsEnabled=false 时 persist() 只记录
 * 不落盘。面板会把这件事直接告诉用户（persisted: false），
 * 而不是让人以为改动生效了。
 */

import { getRelationStage, formatBar, RELATION_STAGES } from '../../storage/affection-store.js';

export function createAffectionApi(deps) {
  const { affectionStore, config, logger } = deps;
  const log = logger?.child({ component: 'web-affection' }) ?? console;

  return {
    'GET /api/affection': async ({ url }) => {
      const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
      const limit = clamp(Number(url.searchParams.get('limit') ?? 200), 1, 2000);

      const rows = affectionStore
        .listUsers()
        .map(([uid, user]) => toRow(uid, user, affectionStore))
        .filter((r) => {
          if (!q) return true;
          return (
            r.uid.includes(q) ||
            String(r.nickname).toLowerCase().includes(q) ||
            String(r.relationship).toLowerCase().includes(q)
          );
        });

      return {
        body: {
          file: config.paths.affectionFile,
          persistEnabled: config.reply.sideEffectsEnabled,
          shadowMode: config.mode === 'shadow',
          suppressedWrites: affectionStore.suppressedWrites.length,
          ownerId: config.identity.ownerId,
          stages: RELATION_STAGES.map(([lo, hi, title, key]) => ({ lo, hi, title, key })),
          total: rows.length,
          items: rows.slice(0, limit),
        },
      };
    },

    'GET /api/affection/*': async ({ pathname }) => {
      const uid = pathname.slice('/api/affection/'.length);
      const user = affectionStore.getUser(uid);
      if (!user) return { status: 404, body: { error: `没有 ${uid} 的好感度记录` } };
      return { body: { item: toRow(uid, user, affectionStore) } };
    },

    /**
     * 冷暴力状态管理。
     * body: { uid, action: 'lift' | 'trigger', durationMinutes?: number }
     */
    'POST /api/affection/cold_violence': async ({ body }) => {
      const uid = String(body?.uid ?? '').trim();
      if (!uid) return { status: 400, body: { error: '缺少 uid' } };
      if (affectionStore.isOwner(uid)) {
        return { status: 409, body: { error: '主人不可被施加冷暴力' } };
      }

      const action = String(body?.action ?? 'lift').toLowerCase();
      let ok = false;
      if (action === 'lift') {
        ok = affectionStore.liftColdViolence(uid);
        if (!ok) return { status: 404, body: { error: `未找到 ${uid} 的好感度记录或无需解除` } };
      } else if (action === 'trigger') {
        let mins = 60;
        if (body?.durationMinutes !== undefined) {
          const parsed = Number(body.durationMinutes);
          if (!Number.isFinite(parsed) || parsed <= 0) {
            return { status: 400, body: { error: 'durationMinutes 必须为大于 0 的正数' } };
          }
          mins = Math.max(1, Math.min(1440, parsed));
        }
        const durationMs = mins * 60 * 1000;
        ok = affectionStore.triggerColdViolence(uid, durationMs);
        if (!ok) return { status: 400, body: { error: `对 ${uid} 施加冷暴力失败` } };
      } else {
        return { status: 400, body: { error: 'action 必须是 lift 或 trigger' } };
      }

      const user = affectionStore.getUser(uid);
      return {
        body: {
          ok: true,
          item: user ? toRow(uid, user, affectionStore) : null,
        },
      };
    },

    /**
     * 管理员手动修改。
     * body: { uid, affection?, delta?, reason? }
     * affection 与 delta 二选一；两个都给时以 affection（绝对值）为准。
     */
    'POST /api/affection/adjust': async ({ body }) => {
      const uid = String(body?.uid ?? '').trim();
      if (!uid) return { status: 400, body: { error: '缺少 uid' } };
      if (affectionStore.isOwner(uid)) {
        return {
          status: 409,
          body: {
            error: '主人（ruaji）好感度恒为 100，不接受任何调整',
            hint: '这是人设约束，见 README §4.4',
          },
        };
      }

      const reason = String(body?.reason ?? '管理员手动调整').slice(0, 200);
      let result;

      if (body?.affection != null) {
        result = affectionStore.adminSet(uid, Number(body.affection), reason);
      } else if (body?.delta != null) {
        const applied = affectionStore.applyDelta(uid, Number(body.delta), reason);
        result = applied
          ? { user: applied, from: null, to: applied.affection, persisted: affectionStore.persistEnabled }
          : null;
      } else {
        return { status: 400, body: { error: '需要 affection（绝对值）或 delta（增量）之一' } };
      }

      if (!result) return { status: 400, body: { error: '调整失败：uid 非法或数值不合法' } };

      log.info('面板手动调整好感度', {
        uid,
        from: result.from,
        to: result.to,
        reason,
        persisted: result.persisted,
      });

      return {
        body: {
          item: toRow(uid, affectionStore.getUser(uid), affectionStore),
          from: result.from,
          to: result.to,
          persisted: result.persisted,
          note: result.persisted
            ? '已写回 affection.json'
            : '当前为影子/只读模式，改动只存在于内存，进程重启即丢失',
        },
      };
    },
  };
}

function toRow(uid, user, store) {
  const stage = getRelationStage(user.affection);
  const recent = user.recentDeltas ?? [];
  const isCold = store.isColdViolent(uid);
  return {
    uid: String(uid),
    nickname: user.nickname ?? String(uid),
    affection: Math.round(user.affection * 100) / 100,
    bar: formatBar(user.affection),
    level: stage.title,
    levelKey: stage.key,
    relationship: user.relationship ?? stage.title,
    emotionalState: user.emotional_state ?? null,
    interactions: user.interactions ?? 0,
    consecutiveDecreases: user.consecutiveDecreases ?? 0,
    isColdViolent: isCold,
    coldRemainingMinutes: store.getColdRemainingMinutes(uid),
    coldViolenceUntil: user.coldViolenceUntil ?? null,
    firstSeen: user.firstSeen ?? null,
    lastSeen: user.lastSeen ?? null,
    isOwner: store.isOwner(uid),
    lastChange: recent[0]
      ? { delta: recent[0].delta, reason: recent[0].reason, ts: recent[0].ts, source: recent[0].source ?? 'model' }
      : null,
    recentDeltas: recent,
  };
}

function clamp(n, lo, hi) {
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;
}
