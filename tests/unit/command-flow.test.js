import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandFlow, parseTrailingInt } from '../../src/orchestration/command-flow.js';
import { createTestLogger } from '../helpers.js';

/** 两个调用点各自的钳制区间，跟 command-flow 里保持一致 */
const coldMinutes = (text) =>
  parseTrailingInt(text.replace(/(分钟|分|min|m)\s*$/i, ''), { min: 1, max: 1440, fallback: 60 });
const portrayalLimit = (text) => parseTrailingInt(text, { min: 10, max: 200, fallback: 50 });

test('parseTrailingInt 不把 @ 提及里的 QQ 号当成参数', () => {
  // message_format=array 的事件 raw_message 可能为空，inbound.text 走 segmentsToText
  // 兜底，at 段被渲染成 "@123456"（cq.js）。不剥掉就会解析出 57842 分钟。
  assert.equal(coldMinutes('/冷暴力 @2260757842'), 60, '只 @ 人时用默认 60 分钟');
  assert.equal(coldMinutes('/冷暴力 [CQ:at,qq=2260757842]'), 60, 'CQ 码形态同理');
  assert.equal(coldMinutes('/冷暴力'), 60);

  assert.equal(portrayalLimit('/画像 @2260757842'), 50, '只 @ 人时用默认 50 条');
  assert.equal(portrayalLimit('/画像'), 50);
});

test('parseTrailingInt 正常解析显式参数并钳制区间', () => {
  assert.equal(coldMinutes('/冷暴力 @2260757842 30'), 30);
  assert.equal(coldMinutes('/冷暴力 @2260757842 30分钟'), 30);
  assert.equal(coldMinutes('/冷暴力 @2260757842 30分'), 30);
  assert.equal(coldMinutes('/冷暴力 30m'), 30);
  assert.equal(coldMinutes('/冷暴力 @x 99999'), 1440, '超上限钳到 24 小时');
  assert.equal(coldMinutes('/冷暴力 @x 0'), 60, '0 视为非法，回落默认');

  assert.equal(portrayalLimit('/画像 @2260757842 80'), 80);
  assert.equal(portrayalLimit('/画像 5'), 10, '低于下限钳到 10');
  assert.equal(portrayalLimit('/画像 @x 999'), 200, '超上限钳到 200');
});

test('parseTrailingInt 对空值与非数字尾巴回落默认', () => {
  for (const bad of ['', null, undefined, '/画像 abc', '/画像 12abc', '/画像 3.5x']) {
    assert.equal(portrayalLimit(String(bad ?? '')), 50, `${bad} 应回落默认`);
  }
});

test('_reply 默认走会话车道积压，opts.immediate 走即时直发', () => {
  const calls = [];
  const queueStub = {
    enqueue: (key, outbound, opts) => {
      calls.push({ method: 'enqueue', key, outbound, opts });
      return false;
    },
    enqueueImmediate: (key, outbound, opts) => {
      calls.push({ method: 'enqueueImmediate', key, outbound, opts });
      return true;
    },
  };
  const flow = new CommandFlow({
    config: { identity: { botName: '瑞姬' } },
    sessionSendQueue: queueStub,
    logger: createTestLogger(),
  });
  const inbound = {
    correlationId: 'c1',
    sessionId: 'qq:group:777',
    messageType: 'group',
    groupId: '777',
    userId: '10001',
  };

  flow._reply(inbound, '普通内容回执', '/好感度');
  flow._reply(inbound, '↪ 收到补充，已并入当前回复继续生成~', '/redirect-ack', {}, { immediate: true });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'enqueue', '内容型命令回执照旧积压，不许插队');
  assert.equal(calls[1].method, 'enqueueImmediate', '即时回执必须绕过车道');
  assert.equal(calls[1].key, 'group:777');
  assert.equal(calls[1].outbound.text, '↪ 收到补充，已并入当前回复继续生成~');
  assert.equal(calls[1].opts.owner, 'command');
});
