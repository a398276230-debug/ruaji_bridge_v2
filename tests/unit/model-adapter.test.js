/**
 * tests/unit/model-adapter.test.js — 模型出口的「不复读」契约
 *
 * 真实事故：上游流式响应中途断掉后，adapter 的重试会**从头再流一遍**；
 * 桥接这边已经把第一次尝试的前缀发给了 QQ，重试就把第一段话又发了一次
 * （用户反馈的「莫名其妙吐出两句第一段话」）。
 *
 * 契约：一旦本次尝试已经把可见文本交给消费者（onText），绝不允许再重试。
 * 没吐过字的重试照旧（网络层抖动仍然要能自愈）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { OpenAiCompatibleAdapter } from '../../src/adapters/model/openai-compatible.js';
import { createModelRequest } from '../../src/contracts/messages.js';

const encoder = new TextEncoder();

const sse = (obj) => encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);

/** 一个假的 SSE Response：按顺序吐 chunks，吐完后 read() 抛错（模拟连接中断） */
function brokenStreamResponse(chunks) {
  let index = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          if (index < chunks.length) return { done: false, value: chunks[index++] };
          throw new Error('socket reset mid-stream');
        },
      }),
    },
  };
}

function modelRequest() {
  return createModelRequest({
    correlationId: 'c-model-1',
    sessionId: 'qq:private:1',
    sessionKey: 'private_1',
    model: 'test-model',
    messages: [{ role: 'user', content: '你好' }],
    stream: true,
  });
}

test('流式已吐出可见文本后连接中断 → 不再重试（防止首段复读）', async () => {
  let fetchCount = 0;
  const adapter = new OpenAiCompatibleAdapter({
    baseUrl: 'http://stub.invalid/v1',
    model: 'test-model',
    apiKey: 'k',
    maxRetries: 3,
    logger: { child: () => ({ warn() {}, info() {}, debug() {}, error() {} }) },
    fetchImpl: async () => {
      fetchCount += 1;
      return brokenStreamResponse([sse({ id: 'r1', choices: [{ delta: { content: '第一段话。' } }] })]);
    },
  });

  const seen = [];
  await assert.rejects(
    adapter.generate(modelRequest(), { onText: (chunk) => seen.push(chunk) }),
    /socket reset mid-stream|模型/,
  );

  assert.equal(fetchCount, 1, '吐过文本后绝不能再打第二次请求');
  assert.deepEqual(seen, ['第一段话。'], 'onText 只应收到第一次尝试的内容');
});

test('一次字都没吐出来时仍然照常重试（网络抖动要能自愈）', async () => {
  let fetchCount = 0;
  const adapter = new OpenAiCompatibleAdapter({
    baseUrl: 'http://stub.invalid/v1',
    model: 'test-model',
    apiKey: 'k',
    maxRetries: 1,
    logger: { child: () => ({ warn() {}, info() {}, debug() {}, error() {} }) },
    fetchImpl: async () => {
      fetchCount += 1;
      return brokenStreamResponse([]); // 没有任何 delta 就断
    },
  });

  await assert.rejects(adapter.generate(modelRequest(), { onText: () => {} }));
  assert.equal(fetchCount, 2, '没吐过文本时 maxRetries=1 应当再试一次');
});
