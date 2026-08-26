#!/usr/bin/env node
/**
 * scripts/migrate-config.js — 从旧 config.json 生成 v2 配置骨架
 *
 * 用法：
 *   node scripts/migrate-config.js                 # 打印到 stdout
 *   node scripts/migrate-config.js --write         # 写入 bridge.config.json
 *
 * 安全约定：
 *   密钥**不写进生成的配置文件**。旧 config.json 把 Hermes apiKey 明文存在
 *   仓库里的文件中，v2 只输出 *Env 引用，并把需要设置的环境变量名打到 stdout。
 *   真实密钥值不打印，只提示"去哪儿拿"。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const LEGACY_CONFIG = path.resolve(ROOT, '..', 'config.json');
const TARGET = path.join(ROOT, 'bridge.config.json');

function readLegacy() {
  if (!fs.existsSync(LEGACY_CONFIG)) {
    console.error(`找不到旧配置: ${LEGACY_CONFIG}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(LEGACY_CONFIG, 'utf8'));
}

function migrate(legacy) {
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'bridge.config.example.json'), 'utf8'));

  const config = {
    ...example,
    mode: 'shadow',
    identity: {
      ownerId: String(legacy.ownerId ?? ''),
      robotId: String(legacy.robotId ?? ''),
      botName: '瑞姬',
      rateLimitUsers: (legacy.rateLimitUsers ?? []).map(String),
    },
    napcat: {
      ...example.napcat,
      wsUrl: legacy.napcat?.wsUrl ?? example.napcat.wsUrl,
      httpUrl: legacy.napcat?.httpUrl ?? example.napcat.httpUrl,
    },
    model: {
      ...example.model,
      // 旧 hermes.apiBaseUrl 是 .../v1/chat/completions，v2 只要 base
      baseUrl: (legacy.hermes?.apiBaseUrl ?? example.model.baseUrl).replace(/\/chat\/completions.*$/, ''),
      model: legacy.hermes?.model ?? example.model.model,
    },
    wake: { ...example.wake, mode: legacy.wakeMode ?? example.wake.mode },
    reply: { ...example.reply, sendEnabled: false, sideEffectsEnabled: false },
  };

  const secrets = [];
  if (legacy.napcat?.accessToken) {
    secrets.push({ env: config.napcat.accessTokenEnv, from: 'config.json → napcat.accessToken' });
  }
  if (legacy.hermes?.apiKey) {
    secrets.push({ env: config.model.apiKeyEnv, from: 'config.json → hermes.apiKey' });
  }

  const dropped = [];
  if (legacy.openclaw) dropped.push('openclaw.* —— v2 已移除 OpenClaw 兼容分支');
  if (legacy.live2dUrl) dropped.push('live2dUrl —— v2 已移除 Live2D 表情同步');
  if (legacy.selfReply) dropped.push('selfReply.* —— 主动接话改由 decision.group_reply 能力承担');

  return { config, secrets, dropped };
}

const legacy = readLegacy();
const { config, secrets, dropped } = migrate(legacy);
const shouldWrite = process.argv.includes('--write');

if (shouldWrite) {
  if (fs.existsSync(TARGET)) {
    console.error(`${TARGET} 已存在，拒绝覆盖。先备份或改名再试。`);
    process.exit(1);
  }
  fs.writeFileSync(TARGET, JSON.stringify(config, null, 2) + '\n', 'utf8');
  console.log(`已写入 ${TARGET}`);
} else {
  console.log(JSON.stringify(config, null, 2));
}

console.error('\n--- 需要手动设置的环境变量（值不在这里打印）---');
for (const secret of secrets) {
  console.error(`  ${secret.env}   ← 旧值来自 ${secret.from}`);
}
if (secrets.length === 0) console.error('  (旧配置里没有密钥)');

console.error('\n--- 未迁移的旧配置项 ---');
for (const item of dropped) console.error(`  ${item}`);
if (dropped.length === 0) console.error('  (无)');

console.error('\n提醒：生成的配置默认 mode=shadow，禁止发送与副作用。切换前请先跑影子对照。');
