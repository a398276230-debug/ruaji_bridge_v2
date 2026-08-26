#!/usr/bin/env node
/**
 * scripts/replay.js — 单条 fixture 走完整链路
 *
 * 用法：
 *   node scripts/replay.js tests/fixtures/group-at-bot.json
 *   node scripts/replay.js tests/fixtures/group-at-bot.json --reply "自定义模型回复"
 *
 * 不连 NapCat、不连模型、不写任何数据文件。打印裁决、Prompt、最终文本，
 * 用来肉眼比对 v2 与旧 Bridge 的行为差异。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/core/config.js';
import { createContainer } from '../src/app/container.js';
import { Logger } from '../src/core/logger.js';
import { MockModelAdapter } from '../src/adapters/model/mock-model.js';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');

function parseArgs(argv) {
  const files = [];
  let reply = null;
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--reply') reply = argv[++i];
    else if (argv[i] === '--verbose' || argv[i] === '-v') verbose = true;
    else files.push(argv[i]);
  }
  return { files, reply, verbose };
}

function section(title) {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);
}

async function replay(fixturePath, { reply, verbose }) {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const lines = [];
  const logger = new Logger({ level: verbose ? 'debug' : 'warn', sink: (l) => lines.push(l) });

  const cacheDir = path.join(ROOT, '.cache', 'replay');
  const config = loadConfig({
    rootDir: ROOT,
    file: 'bridge.config.example.json',
    cliOverrides: {
      mode: 'test',
      reply: { sendEnabled: false, sideEffectsEnabled: false },
      logging: { file: null },
      plugins: [], // 重放不连任何插件，走本地兜底路径
      storage: { cacheDir },
    },
  });

  const modelAdapter = new MockModelAdapter({ replies: [reply ?? '(mock 回复)'] });
  const container = createContainer(config, { logger, modelAdapter, fetchImpl: async () => { throw new Error('replay 不连网络'); } });

  section(`FIXTURE: ${fixture.name} — ${fixture.description ?? ''}`);
  console.log(`来源: ${fixture.source ?? '(未标注)'}`);

  // 1. 规范化
  const { message: inbound, dropped } = await container.normalizer.normalize(fixture.event, {
    correlationId: 'replay-0001',
  });

  section('1. 规范化 (InboundMessage)');
  if (!inbound) {
    console.log(`已丢弃，原因: ${dropped}`);
    return;
  }
  console.log(
    JSON.stringify(
      {
        messageId: inbound.messageId,
        sessionId: inbound.sessionId,
        executionKey: inbound.executionKey,
        messageType: inbound.messageType,
        text: inbound.text,
        content: inbound.content,
        sender: inbound.sender,
        flags: inbound.flags,
        media: inbound.media.map((m) => ({ kind: m.kind, localPath: m.localPath, name: m.name })),
      },
      null,
      2,
    ),
  );

  // 2. 裁决
  container.contextFlow.recordToWindow(inbound);
  const decision = await container.decisionFlow.decide(inbound);
  section('2. 裁决 (decision-flow)');
  console.log(JSON.stringify(decision, null, 2));
  console.log(`唤醒判定: isWake=${container.normalizer.isWake(inbound.flags)}`);

  if (decision.route === 'ignore') {
    console.log('\n→ 不回复，链路到此结束。');
    return;
  }

  // 3. 上下文
  const { blocks, stats } = await container.contextFlow.collect(inbound, { triggerType: decision.triggerType });
  section('3. 上下文聚合 (context-aggregator)');
  console.log(JSON.stringify(stats, null, 2));
  for (const block of blocks) {
    console.log(`\n--- [${block.source}] priority=${block.priority} slot=${block.metadata?.slot ?? 'extra'} chars=${block.text.length}`);
    console.log(block.text);
  }

  // 4. Prompt
  const { renderSystemText, renderUserContent } = await import('../src/orchestration/prompt-renderer.js');
  const affectionContext = container.contextFlow.getAffectionContext(inbound, decision.triggerType);
  section('4. systemText (隐式注入)');
  console.log(
    renderSystemText({
      inbound,
      contextBlocks: blocks,
      triggerType: decision.triggerType,
      affectionContext,
      identity: config.identity,
    }) || '(空)',
  );
  section('5. userContent (显式部分)');
  console.log(renderUserContent({ inbound, contextBlocks: blocks, identity: config.identity }));

  // 5. 生成 + Middleware
  await container.replyFlow.run({
    inbound,
    triggerType: decision.triggerType,
    contextBlocks: blocks,
    signal: new AbortController().signal,
  });
  await new Promise((r) => setTimeout(r, 300));

  section('6. 最终待发消息 (dry-run，未真正发送)');
  if (container.sender.dryRunLog.length === 0) console.log('(无)');
  for (const [i, entry] of container.sender.dryRunLog.entries()) {
    console.log(`\n--- 第 ${i + 1} 段 → ${entry.isGroup ? 'group' : 'private'}:${entry.targetId}`);
    console.log(entry.message);
  }

  section('7. 副作用');
  console.log(`被抑制的好感度写入: ${container.affectionStore.suppressedWrites.length} 次`);
  console.log(`实际发出的 NapCat 请求: 0（replay 强制 dry-run）`);

  if (verbose) {
    section('日志');
    for (const line of lines) console.log(JSON.stringify(line));
  }

  try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const { files, reply, verbose } = parseArgs(process.argv.slice(2));
if (files.length === 0) {
  console.error('用法: node scripts/replay.js <fixture.json> [--reply "文本"] [--verbose]');
  process.exit(1);
}

for (const file of files) {
  await replay(path.resolve(file), { reply, verbose });
}
