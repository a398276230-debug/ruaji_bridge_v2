#!/usr/bin/env node
/**
 * scripts/shadow-learn-backfill.js — 从 GCP(group_chat_plus) 磁盘群聊历史回填影子模式语料
 *
 * 用法：
 *   node scripts/shadow-learn-backfill.js 3054039169
 *   node scripts/shadow-learn-backfill.js 111 222          # 多个目标
 *   node scripts/shadow-learn-backfill.js 111 --max 200    # 提高每人上限（默认 100）
 *
 * 说明：
 *  - 只扫群聊历史（影子模式仅群聊注入，groupId 是"同群优先"的依据），
 *    扫描路径与 portrayal-worker.extractDiskHistory 的群聊部分一致。
 *  - 复用 collectibleText 清洗：CQ 码/占位符/命令/提示注入文本不入库。
 *  - 确定性合并：GCP 历史 + 既有语料（含实时采集的）按 (text|groupId|time)
 *    去重、按时间排序、抑制连发复读、裁剪到上限后整体重写——重复执行
 *    结果完全一致，不会堆重复语料，也不会把既有新语料挤出上限。
 *  - 注意：若桥接进程正在运行，其内存副本会在下一次采集落盘时覆盖本文件
 *    （内存里没有回填数据）。回填后请重启桥接，或先停桥接再回填。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ShadowLearnStore, collectibleText } from '../src/storage/shadow-learn-store.js';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const GCP_GROUP_DIRS = [
  path.resolve(ROOT, 'astr/unified_astrbot_host/data/plugin_data/astrbot_plugin_group_chat_plus/chat_history/aiocqhttp/group'),
  path.resolve(ROOT, 'data/plugin_data/astrbot_plugin_group_chat_plus/chat_history/aiocqhttp/group'),
];

const argv = process.argv.slice(2);
const maxIdx = argv.indexOf('--max');
let maxPerUser = 100;
if (maxIdx !== -1) {
  const n = Number(argv[maxIdx + 1]);
  if (Number.isFinite(n) && n > 0) maxPerUser = Math.floor(n);
  argv.splice(maxIdx, 2);
}

const targets = argv
  .join(',')
  .split(/[,，\s]+/)
  .map((s) => s.trim())
  .filter(Boolean);

if (targets.length === 0) {
  console.error('用法: node scripts/shadow-learn-backfill.js <QQ号> [QQ号2 ...] [--max N]');
  process.exit(1);
}

const file = path.join(ROOT, 'data/plugin_data/shadow_learn/learning.json');
const store = new ShadowLearnStore({ file, persistEnabled: true });

// 1. GCP 磁盘历史按目标收集（清洗口径与实时采集一致）
const gcpMessages = new Map(); // uid -> [{ text, groupId, time }]
let scanned = 0;
for (const dir of GCP_GROUP_DIRS) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    let arr;
    try {
      arr = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      continue;
    }
    if (!Array.isArray(arr)) continue;
    scanned += arr.length;
    for (const item of arr) {
      const uid = String(item.sender?.user_id ?? item.user_id ?? '');
      if (!targets.includes(uid)) continue;
      const ts = Number(item.timestamp);
      if (!Number.isFinite(ts)) continue;
      const text = collectibleText(String(item.message_str || item.raw_message || item.text || ''));
      if (!text) continue;
      const nickname = item.sender?.nickname || item.nickname || uid;
      const list = gcpMessages.get(uid) ?? { nickname, items: [] };
      list.nickname = nickname || list.nickname; // 文件序即时间序，取最后出现的昵称
      list.items.push({ text, groupId: String(item.group_id ?? ''), time: new Date(ts * 1000).toISOString() });
      gcpMessages.set(uid, list);
    }
  }
}

// 2. 与既有语料合并：同键优先保留既有条目（实时采集的原样不动）
const report = [];
for (const uid of targets) {
  const existing = store.data.messages[uid]?.items ?? [];
  const nickname = store.data.messages[uid]?.nickname || gcpMessages.get(uid)?.nickname || uid;
  const merged = new Map();
  for (const it of existing) merged.set(`${it.text}|${it.groupId}|${it.time}`, it);
  let fromGcp = 0;
  for (const it of gcpMessages.get(uid)?.items ?? []) {
    const key = `${it.text}|${it.groupId}|${it.time}`;
    if (merged.has(key)) continue;
    merged.set(key, it);
    fromGcp += 1;
  }

  // 3. 按时间排序 + 抑制连发复读（与 recordMessage 语义一致：紧邻同文本只留一条）
  const items = [...merged.values()]
    .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))
    .filter((it, i, arr) => i === 0 || arr[i - 1].text !== it.text);

  // 4. 裁剪到上限（淘汰最旧）并整体重写
  while (items.length > maxPerUser) items.shift();
  store.data.messages[uid] = { nickname, items };
  const groups = {};
  for (const it of items) groups[it.groupId] = (groups[it.groupId] || 0) + 1;
  report.push({ uid, nickname, kept: items.length, fromGcp, groups });
}

store.flush();

console.log(`已扫描 GCP 群聊历史 ${scanned} 条：`);
for (const r of report) {
  console.log(`  ${r.uid} (${r.nickname}): 合并 GCP 新增 ${r.fromGcp} 条，共 ${r.kept} 条入库 ${JSON.stringify(r.groups)}`);
}
console.log(`已写入 ${file}`);
console.log('提醒：若桥接进程正在运行，请重启使其加载回填后的语料，否则内存副本会在下次采集时覆盖本文件。');
