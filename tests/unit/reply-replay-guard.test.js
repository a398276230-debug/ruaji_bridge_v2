/**
 * tests/unit/reply-replay-guard.test.js — 流重启重放拦截
 *
 * 真实事故：上游中途重试会把已经流过的前缀**从头再流一遍**，桥接这边第一段
 * 已经发出去了，于是 QQ 里出现「两句第一段话」。reply-flow 的 _acceptSegment
 * 负责把这种「从头重放」的段丢掉，同时不误伤正常内容。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ReplyFlow, REPLAY_GUARD_MIN_CHARS } from '../../src/orchestration/reply-flow.js';

const accept = (state, segment) => ReplyFlow.prototype._acceptSegment.call({}, state, segment);

const newState = () => ({ emitted: [], replayIndex: -1, suppressedReplays: 0 });

const A = '这是第一段比较长的内容。';
const B = '这是第二段比较长的内容。';
const C = '这是第三段比较长的内容。';

test('正常依次到达的不同段落全部放行', () => {
  const state = newState();
  assert.equal(accept(state, A), true);
  assert.equal(accept(state, B), true);
  assert.equal(accept(state, C), true);
  assert.deepEqual(state.emitted, [A, B, C]);
  assert.equal(state.suppressedReplays, 0);
});

test('单段回复被整段重放：第二遍丢掉', () => {
  const state = newState();
  assert.equal(accept(state, A), true);
  assert.equal(accept(state, A), false, '与首段相同的长段落判为重放');
  assert.deepEqual(state.emitted, [A]);
  assert.equal(state.suppressedReplays, 1);
});

test('多段回复从头重放：整段前缀被吞掉，后续新内容照常放行', () => {
  const state = newState();
  assert.equal(accept(state, A), true);
  assert.equal(accept(state, B), true);
  // 上游重放
  assert.equal(accept(state, A), false);
  assert.equal(accept(state, B), false);
  // 重放偏离后出现的新内容不能被误吞
  assert.equal(accept(state, C), true);
  assert.deepEqual(state.emitted, [A, B, C]);
});

test('重放只盖住前半段时，偏离处立刻恢复放行', () => {
  const state = newState();
  assert.equal(accept(state, A), true);
  assert.equal(accept(state, B), true);
  assert.equal(accept(state, A), false, '首段重放被吞');
  assert.equal(accept(state, C), true, '重放没到 B 就变成新内容 → 必须放行');
  assert.deepEqual(state.emitted, [A, B, C]);
});

test('短重复（阈值以下）不拦，避免误伤「哈哈。」这类自然重复', () => {
  const state = newState();
  const short = '好。';
  assert.ok(short.length < REPLAY_GUARD_MIN_CHARS);
  assert.equal(accept(state, short), true);
  assert.equal(accept(state, short), true, '短段不做重放判定');
  assert.deepEqual(state.emitted, [short, short]);
});

test('只在「与首段相同」时判定重放：重复的非首段照常放行', () => {
  const state = newState();
  assert.equal(accept(state, A), true);
  assert.equal(accept(state, B), true);
  assert.equal(accept(state, B), true, '副歌式重复的非首段是合法内容，不该被吞');
  assert.deepEqual(state.emitted, [A, B, B]);
});

test('空段保持原行为，交给下游处理', () => {
  const state = newState();
  assert.equal(accept(state, '   '), true);
  assert.deepEqual(state.emitted, []);
});
