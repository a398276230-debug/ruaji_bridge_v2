/**
 * app/bootstrap.js — 从命令行参数到一个跑起来的 Bridge
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../core/config.js';
import { createContainer } from './container.js';
import { Lifecycle } from './lifecycle.js';

export const ROOT_DIR = path.resolve(fileURLToPath(import.meta.url), '../../..');

/** --mode=shadow --config=xxx.json --send --side-effects */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (const arg of argv) {
    if (arg.startsWith('--mode=')) out.mode = arg.slice(7);
    else if (arg.startsWith('--config=')) out.configFile = arg.slice(9);
    else if (arg === '--send') out.sendEnabled = true;
    else if (arg === '--side-effects') out.sideEffectsEnabled = true;
    else if (arg === '--no-preflight') out.skipPreflight = true;
  }
  return out;
}

/**
 * @param {object} [opts]
 * @param {string[]} [opts.argv]
 * @param {object} [opts.overrides] 测试注入：{ fetchImpl, WebSocketImpl, modelAdapter, logger }
 * @param {object} [opts.configOverrides]
 */
export function buildApp(opts = {}) {
  const args = parseArgs(opts.argv);

  const cliOverrides = {};
  if (args.mode) cliOverrides.mode = args.mode;
  if (args.sendEnabled) cliOverrides.reply = { ...cliOverrides.reply, sendEnabled: true };
  if (args.sideEffectsEnabled) {
    cliOverrides.reply = { ...cliOverrides.reply, sideEffectsEnabled: true };
  }

  const config = loadConfig({
    rootDir: opts.rootDir ?? ROOT_DIR,
    file: args.configFile ?? 'bridge.config.json',
    cliOverrides: { ...cliOverrides, ...(opts.configOverrides ?? {}) },
  });

  const container = createContainer(config, opts.overrides ?? {});
  const lifecycle = new Lifecycle(container, {
    skipPreflight: args.skipPreflight ?? opts.skipPreflight,
    maxPreflightAttempts: opts.maxPreflightAttempts,
  });

  return { config, container, lifecycle };
}

export async function main(opts = {}) {
  const { container, lifecycle } = buildApp(opts);
  try {
    await lifecycle.start();
  } catch (err) {
    container.logger.critical('启动失败，进程退出', { error: err.message });
    await lifecycle.shutdown().catch(() => {});
    throw err;
  }
  return { container, lifecycle };
}
