import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULTS, loadConfig } from '../../src/core/config.js';
import { ConfigError } from '../../src/contracts/errors.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const expectedDefaults = {
  enabled: false,
  groupWhitelist: [],
  privateEnabled: false,
  privateWhitelist: [],
  maxMessagesPerTurn: 8,
  minIntervalMs: 1500,
};

test('toolProgress configuration validation', async (t) => {
  // All scratch files stay inside roming, never the OS temporary directory.
  const rootDir = fs.mkdtempSync(path.join(repoRoot, 'roming', 'tool-progress-config-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(rootDir, 'bridge.config.json'), JSON.stringify({
    mode: 'test',
    identity: { ownerId: '10000001', robotId: '10000002' },
  }));
  const load = (toolProgress) => loadConfig({
    rootDir,
    env: {},
    cliOverrides: toolProgress === undefined ? {} : { toolProgress },
  });
  const rejects = (value, field) => assert.throws(() => load(value), (error) => {
    assert.ok(error instanceof ConfigError);
    assert.ok(error.message.includes(`toolProgress${field ? `.${field}` : ''}`), error.message);
    return true;
  });

  await t.test('omitted configuration uses disabled defaults', () => {
    assert.deepEqual(DEFAULTS.toolProgress, expectedDefaults);
    assert.deepEqual(load().toolProgress, expectedDefaults);
  });

  await t.test('both shipped JSON configurations explicitly use the same defaults', () => {
    for (const file of ['bridge.config.json', 'bridge.config.example.json']) {
      const config = JSON.parse(fs.readFileSync(path.join(repoRoot, file), 'utf8'));
      assert.deepEqual(config.toolProgress, expectedDefaults, file);
    }
  });

  await t.test('partial settings merge defaults without changing reply eligibility settings', () => {
    const baseline = load();
    const configured = load({ enabled: true, groupWhitelist: ['123456', 234567] });
    assert.deepEqual(configured.toolProgress, {
      ...expectedDefaults, enabled: true, groupWhitelist: ['123456', 234567],
    });
    for (const key of ['identity', 'wake', 'decision', 'reply']) {
      assert.deepEqual(configured[key], baseline[key]);
    }
  });

  await t.test('rejects non-object blocks', () => {
    for (const value of [null, false, true, 0, 1, '', 'enabled', []]) rejects(value);
  });

  await t.test('boolean switches are strict even when disabled', () => {
    for (const field of ['enabled', 'privateEnabled']) {
      for (const value of [true, false]) assert.equal(load({ [field]: value }).toolProgress[field], value);
      for (const value of [null, 0, 1, 'true', 'false', '', [], {}]) rejects({ [field]: value }, field);
    }
  });

  await t.test('whitelists accept empty arrays and positive string/number QQ IDs', () => {
    for (const field of ['groupWhitelist', 'privateWhitelist']) {
      for (const value of [[], ['1', 2, '3054039169'], ['99999999999999999999']]) {
        assert.deepEqual(load({ [field]: value }).toolProgress[field], value);
      }
    }
  });

  await t.test('whitelists reject non-arrays and malformed IDs without coercion', () => {
    for (const field of ['groupWhitelist', 'privateWhitelist']) {
      for (const value of [null, true, '123', 123, {}]) rejects({ [field]: value }, field);
      for (const id of [true, false, null, undefined, {}, [], 0, -1, 1.5, NaN, Infinity,
        Number.MAX_SAFE_INTEGER + 1, '', '0', '000', '-1', '1.5', '1e3', '+1', ' 123 ', 'abc']) {
        rejects({ [field]: ['123', id] }, field);
      }
    }
  });

  await t.test('per-turn cap is a strict integer from 1 through 100', () => {
    for (const value of [1, 8, 100]) assert.equal(load({ maxMessagesPerTurn: value }).toolProgress.maxMessagesPerTurn, value);
    for (const value of [null, true, false, '8', 0, -1, 101, 1.5, NaN, Infinity, [], {}]) {
      rejects({ maxMessagesPerTurn: value }, 'maxMessagesPerTurn');
    }
  });

  await t.test('cooldown accepts only finite nonnegative numbers including zero and fractions', () => {
    for (const value of [0, 0.5, 1500, Number.MAX_VALUE]) {
      assert.equal(load({ minIntervalMs: value }).toolProgress.minIntervalMs, value);
    }
    for (const value of [null, true, false, '1500', '', -1, NaN, Infinity, -Infinity, [], {}]) {
      rejects({ minIntervalMs: value }, 'minIntervalMs');
    }
  });

  await t.test('invalid JSON-file settings are validated, not just CLI overrides', () => {
    const file = path.join(rootDir, 'bridge.config.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...config, toolProgress: { enabled: 'false' } }));
    rejects(undefined, 'enabled');
  });
});
