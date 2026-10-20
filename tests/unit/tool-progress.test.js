import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolProgressReporter, isToolProgressEnabled } from '../../src/orchestration/tool-progress.js';
import { OpenAiCompatibleAdapter } from '../../src/adapters/model/openai-compatible.js';
import { createModelRequest } from '../../src/contracts/messages.js';
import { sseStream } from '../helpers.js';
import { ReplyAnchorTracker } from '../../src/orchestration/reply-anchor-tracker.js';

test('工具进度消息不能占用异步完成通知的引用锚点', () => {
  const tracker = new ReplyAnchorTracker({
    config: { wakeDelivery: { enabled: true, anchor: { enabled: true } } },
    cursorStore: { setAnchor() { assert.fail('工具进度不能记录引用锚点'); } },
  });
  assert.equal(tracker.handleSent({ sessionId: 's', payload: { status: 'success', replyId: '100', origin: 'tool-progress', text: '⏳ 正在调用 terminal…' } }), null);
});

const config = { toolProgress: { enabled: true, groupWhitelist: ['777'], privateEnabled: false, privateWhitelist: ['123'], minIntervalMs: 100, maxMessagesPerTurn: 2 } };
test('工具进度白名单独立、默认拒绝、群和私聊互不放行', () => {
  assert.equal(isToolProgressEnabled({}, { messageType: 'group', groupId: '777' }), false);
  assert.equal(isToolProgressEnabled(config, { messageType: 'group', groupId: '777' }), true);
  assert.equal(isToolProgressEnabled(config, { messageType: 'group', groupId: '123' }), false);
  assert.equal(isToolProgressEnabled(config, { messageType: 'private', userId: '123' }), true);
  assert.equal(isToolProgressEnabled(config, { messageType: 'private', userId: '777' }), false);
  assert.equal(isToolProgressEnabled({ toolProgress: { enabled: true, privateEnabled: true } }, { messageType: 'private', userId: '999' }), true);
});
test('工具进度去重、限频、限总量、取消及恶意工具名隔离', () => {
  let time = 0;
  const sent = [];
  const controller = new AbortController();
  const report = createToolProgressReporter({ config, inbound: { messageType: 'group', groupId: '777' }, signal: controller.signal, enqueue: (t) => sent.push(t), now: () => time });
  const event = (id, name = 'terminal') => ({ id, name, status: 'running', args: null });
  report(event('a'));
  report(event('b'));
  time = 100;
  report(event('a'));
  report(event('c', '[CQ:at,qq=all]'));
  report(event('d', '_internal'));
  report({ ...event('e'), status: 'completed' });
  report(event('f', 'web_search'));
  time = 200;
  report(event('g'));
  controller.abort();
  report(event('h'));
  assert.deepEqual(sent, ['⏳ 正在调用 terminal…', '⏳ 正在调用 web_search…']);
});

const request = () => createModelRequest({ correlationId: 'progress-test', sessionId: 's', model: 'test', messages: [{ role: 'user', content: 'test' }] });
const frame = (data, type = '') => `${type ? `event: ${type}\r\n` : ''}data: ${JSON.stringify(data)}\r\n\r\n`;
const adapterFor = (chunks) => new OpenAiCompatibleAdapter({ baseUrl: 'http://stub/v1', fetchImpl: async () => ({ ok: true, body: sseStream(chunks) }) });
test('Hermes 具名 SSE 跨网络分片、CRLF、去重，完成/思考不串入正文', async () => {
  const wire = frame({ tool: 'terminal', toolCallId: 'a', status: 'running', label: 'secret' }, 'hermes.tool.progress')
    + frame({ tool: 'terminal', toolCallId: 'a', status: 'running' }, 'hermes.tool.progress')
    + frame({ tool: 'terminal', toolCallId: 'a', status: 'completed' }, 'hermes.tool.progress')
    + frame({ choices: [{ delta: { content: 'secret' } }] }, 'hermes.reasoning')
    + frame({ choices: [{ delta: { content: '你好' } }] });
  const events = [], texts = [];
  const response = await adapterFor([...wire]).generate(request(), { onToolProgress: (e) => events.push(e), onText: (t) => texts.push(t) });
  assert.deepEqual(events, [{ id: 'a', name: 'terminal', status: 'running', label: 'secret' }]);
  assert.deepEqual(texts, ['你好']);
  assert.equal(response.rawText, '你好');
});
test('标准 tool_calls 合并函数名/参数分片，每个调用只播报一次', async () => {
  const delta = (tool_calls, finish_reason = null) => frame({ choices: [{ delta: { tool_calls }, finish_reason }] });
  const events = [];
  const response = await adapterFor([
    delta([{ index: 0, id: 'a', function: { name: 'web_' } }]),
    delta([{ index: 0, function: { name: 'search', arguments: '{' } }]),
    delta([{ index: 0, function: { arguments: '"query":"天气"}' } }, { index: 1, id: 'b', function: { name: 'terminal' } }]),
    delta([], 'tool_calls'),
  ]).generate(request(), { onToolProgress: (e) => events.push(e) });
  assert.deepEqual(events.map((e) => e.name), ['web_search', 'terminal']);
  assert.equal(response.toolCalls.length, 2);
  assert.equal(response.toolCalls[0].function.arguments, '{"query":"天气"}');
  assert.deepEqual(events[0].args, { query: '天气' });
  assert.equal(events.length, 2);
});
test('仅发过工具进度后断流也不重试，防止重跑工具/重复提示', async () => {
  let fetches = 0;
  const encoder = new TextEncoder();
  const adapter = new OpenAiCompatibleAdapter({ baseUrl: 'http://stub/v1', maxRetries: 2,
    logger: { child: () => ({ warn() {} }) },
    fetchImpl: async () => {
      fetches++;
      let first = true;
      return { ok: true, body: { getReader: () => ({ async read() {
        if (!first) throw new Error('broken');
        first = false;
        return { done: false, value: encoder.encode(frame({ tool: 'terminal', toolCallId: 'a', status: 'running' }, 'hermes.tool.progress')) };
      } }) } };
    },
  });
  const events = [];
  await assert.rejects(adapter.generate(request(), { onToolProgress: (e) => events.push(e) }), /broken/);
  assert.equal(fetches, 1);
  assert.equal(events.length, 1);
});
test('非流式响应损坏的参数安全回退', async () => {
  const adapter = new OpenAiCompatibleAdapter({ baseUrl: 'http://stub/v1', fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '', tool_calls: [{ id: 'a', function: { name: 'terminal', arguments: 'secret' } }] } }] }) }) });
  const events = [];
  await adapter.generate({ ...request(), stream: false }, { onToolProgress: (e) => events.push(e) });
  assert.deepEqual(events, [{ id: 'a', name: 'terminal', status: 'running' }]);
});
test('进度回调异常不影响正文生成', async () => {
  const response = await adapterFor([frame({ tool: 'terminal', toolCallId: 'a', status: 'running' }, 'hermes.tool.progress'), frame({ choices: [{ delta: { content: '完成' } }] })]).generate(request(), { onToolProgress() { throw new Error('fail'); } });
  assert.equal(response.rawText, '完成');
});

function describe(event, policy = {}) {
  const sent = [];
  const report = createToolProgressReporter({
    config: { toolProgress: { ...config.toolProgress, ...policy } },
    inbound: { messageType: 'group', groupId: '777' }, enqueue: (t) => sent.push(t),
  });
  report({ id: 'detail', status: 'running', ...event });
  return sent[0];
}
test('按真实工具参数生成中文动作 + 对象 + 工具名', () => {
  for (const [name, args, expected] of [
    ['web_search', { query: '今日天气' }, '正在搜索 「今日天气」'],
    ['read_file', { path: 'src/core/config.js' }, '正在读 src/core/config.js'],
    ['terminal', { command: 'npm test\necho second' }, '正在执行命令：npm test'],
    ['write_file', { path: 'a.js', content: 'DO NOT SEND' }, '正在改 a.js'],
    ['patch', { path: 'b.js', replace: 'DO NOT SEND' }, '正在改 b.js'],
    ['delegate_task', { tasks: [{ goal: '检查测试' }] }, '正在派发子任务：检查测试'],
    ['delegate_task', { action: 'list' }, '正在管理子任务：list'],
    ['mcp.server.search', { query: '文档', result: 'DO NOT SEND' }, '正在调用 mcp.server.search：文档'],
  ]) {
    const text = describe({ name, args, result: 'DO NOT SEND', output: 'DO NOT SEND' });
    assert.ok(text.startsWith('⏳ '));
    assert.ok(text.includes(expected), text);
    assert.ok(text.includes(name), text);
    assert.ok(!text.includes('DO NOT SEND'));
    assert.ok(!text.includes('second'));
  }
  assert.equal(describe({ name: 'read_file', label: 'config.js L1-10' }), '⏳ 正在读 config.js L1-10（read_file）');
});
test('详情清洗换行/CQ/控制字符、整段敏感值及总长截断', () => {
  assert.equal(describe({ name: 'web_search', args: { query: 'a\n\tb[CQ:at,qq=all]\u0000c' } }), '⏳ 正在搜索 「a bc」（web_search）');
  assert.ok(!describe({ name: 'read_file', label: '[C\u0000Q:at,qq=all]a.js' }).includes('CQ:'));
  for (const value of ['api_key=abc', 'TOKEN abc', 'secret abc', 'password abc', 'authorization abc', 'Bearer abc', 'sk-abc', 'to\u0000ken=abc', 'safe\npassword=abc', 'a'.repeat(200) + 'secret']) {
    const text = describe({ name: 'terminal', args: { command: value } });
    assert.equal(text, '⏳ 正在执行命令：***（terminal）');
  }
  const long = describe({ name: 'read_file', args: { path: '长'.repeat(300) } });
  assert.equal(Array.from(long).length, 120);
  assert.ok(long.endsWith('…'));
});
test('showDetail=false 完全回退；无参数/损坏参数/仅结果安全回退', () => {
  assert.equal(describe({ name: 'web_search', args: { query: '天气' }, label: '天气' }, { showDetail: false }), '⏳ 正在调用 web_search…');
  for (const args of [undefined, null, [], 'broken', { path: {} }, { path: '' }, { path: '[CQ:at,qq=all]' }]) {
    assert.equal(describe({ name: 'read_file', args, result: 'NEVER', output: 'NEVER' }), '⏳ 正在调用 read_file…');
  }
});
test('详细模式下白名单与中断仍然拒绝投递', () => {
  for (const inbound of [{ messageType: 'group', groupId: '123' }, { messageType: 'private', userId: '777' }, { messageType: 'other' }]) {
    createToolProgressReporter({ config, inbound, enqueue: () => assert.fail('门禁失效') })({ name: 'terminal', status: 'running', args: { command: 'npm test' } });
  }
  const controller = new AbortController();
  controller.abort();
  createToolProgressReporter({ config, inbound: { messageType: 'group', groupId: '777' }, signal: controller.signal, enqueue: () => assert.fail('中断失效') })({ name: 'terminal', status: 'running', args: { command: 'npm test' } });
});
test('Hermes 调用 label 经过 reporter 清洗且完成/result/output/preview 不透传', async () => {
  const sent = [];
  const report = createToolProgressReporter({ config, inbound: { messageType: 'group', groupId: '777' }, enqueue: (t) => sent.push(t) });
  await adapterFor([
    frame({ tool: 'web_search', toolCallId: 'a', status: 'running', label: '天气\n[CQ:at,qq=all]', result: 'NEVER', output: 'NEVER', preview: 'NEVER' }, 'hermes.tool.progress'),
    frame({ tool: 'web_search', toolCallId: 'b', status: 'completed', label: 'NEVER' }, 'hermes.tool.progress'),
  ]).generate(request(), { onToolProgress: report });
  assert.deepEqual(sent, ['⏳ 正在搜索 「天气」（web_search）']);
});
test('非流式 JSON 提取调用参数，不提取返回结果', async () => {
  const adapter = new OpenAiCompatibleAdapter({ baseUrl: 'http://stub/v1', fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { tool_calls: [{ id: 'a', result: 'NEVER', function: { name: 'read_file', arguments: '{"path":"src/a.js"}' } }] } }] }) }) });
  const sent = [];
  const report = createToolProgressReporter({ config, inbound: { messageType: 'group', groupId: '777' }, enqueue: (t) => sent.push(t) });
  await adapter.generate({ ...request(), stream: false }, { onToolProgress: report });
  assert.deepEqual(sent, ['⏳ 正在读 src/a.js（read_file）']);
});
