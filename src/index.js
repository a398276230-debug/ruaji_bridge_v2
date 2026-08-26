#!/usr/bin/env node
/**
 * RUAJI Bridge v2 入口
 *
 * 默认 shadow 模式：不发送、不写副作用。要真正发消息必须显式
 *   node src/index.js --mode=live --send --side-effects
 * 并且旧 Bridge 已经停机——两个 Bridge 同时发送会出现双份回复。
 */

import { main } from './app/bootstrap.js';

main().catch((err) => {
  console.error(`[CRITICAL] ${err.message}`);
  process.exitCode = 1;
});
