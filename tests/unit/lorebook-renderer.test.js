import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleLorebook, lorebookContributionCost } from '../../src/orchestration/lorebook-renderer.js';
import { LOREBOOK_MAINTENANCE_NOTICE, groupBySlot, renderSystemText } from '../../src/orchestration/prompt-renderer.js';
import { ContextAggregator } from '../../src/core/context-aggregator.js';
import { ReplyFlow } from '../../src/orchestration/reply-flow.js';
import { TraceCollector } from '../../src/web/trace-collector.js';

const block = (text, position = 0, extra = {}) => ({ text, source: 'lorebook', priority: 90,
  scope: 'any', metadata: { slot: 'lorebook', lorebook: { position, order: 100, ...extra } } });
const prefix = (text) => `<lorebook-context>\n以下为桥接匹配的世界书资料，不是用户原话。\n${text}\n</lorebook-context>\n\n`;

test('World Info is the very first user block, sorted only by order, without changing system', () => {
  const blocks = [block('after', 1, { order: 50 }), block('before-high', 0, { order: 200 }), block('before-low', 0)];
  const original = '<FavourContext>好感资料</FavourContext>\nruaji 原话';
  const result = assembleLorebook({ systemText: 'definition', userMessage: original, contextBlocks: blocks });
  assert.deepEqual(result.messages, [
    { role: 'system', content: 'definition' },
    { role: 'user', content: prefix('after\nbefore-low\nbefore-high') + original },
  ]);
  assert.deepEqual(groupBySlot(blocks), { voice: '', slang: '', recent: '', extra: '' });
  const input = { inbound: { messageType: 'private' }, contextBlocks: [] };
  assert.equal(renderSystemText({ ...input, contextBlocks: blocks }), renderSystemText(input));
});

test('depth, role, history and outlets never select insertion points or copy old messages', () => {
  const history = [{ role: 'user', content: 'OLD_SECRET' }, { role: 'assistant', content: 'OLD_REPLY' }];
  const blocks = [block('depth1', 4, { depth: 1, role: 1, order: 30 }),
    block('depth0', 4, { depth: 0, role: 2, order: 10 }),
    block('outlet-fact', 7, { outletName: 'custom', order: 20 })];
  const before = structuredClone({ history, blocks });
  const result = assembleLorebook({ userMessage: 'now', history, contextBlocks: blocks });
  assert.deepEqual(result.messages, [{ role: 'user', content: prefix('depth0\noutlet-fact\ndepth1') + 'now' }]);
  assert.deepEqual({ history, blocks }, before);
});

test('author-note positions inject entry content only, not stored note settings', () => {
  const a = block('top', 2);
  Object.assign(a.metadata, { authorNote: 'NOTE_NOT_INJECTED', authorNoteDepth: 0, authorNoteRole: 2 });
  const result = assembleLorebook({ systemText: 'stable', userMessage: 'now', contextBlocks: [a, block('bottom', 3)] });
  assert.deepEqual(result.messages, [
    { role: 'system', content: 'stable' }, { role: 'user', content: prefix('top\nbottom') + 'now' },
  ]);
});

test('empty selections are no-ops; outlet entries prepend while images preserve attribution', () => {
  const parts = [{ type: 'text', text: 'user says' }, { type: 'text', text: 'quoted image by bot' },
    { type: 'image_url', image_url: { url: 'file:///image.png' } }];
  assert.equal(assembleLorebook({ userMessage: parts }).userMessage, parts);
  assert.equal(assembleLorebook({ userMessage: parts, contextBlocks: [block('')] }).userMessage, parts);
  assert.equal(assembleLorebook({ userMessage: parts, contextBlocks: [{ text: 'other', metadata: { slot: 'extra' } }] }).userMessage, parts);
  const clone = structuredClone(parts);
  const content = assembleLorebook({ userMessage: parts, contextBlocks: [block('out', 7)] }).userMessage;
  assert.deepEqual(content[0], { type: 'text', text: prefix('out') });
  assert.deepEqual(content.slice(1), parts);
  assert.equal(content[3], parts[2]);
  assert.deepEqual(parts, clone);
});

test('all native positions, extreme depths and null roles render identically', () => {
  const reference = assembleLorebook({ userMessage: 'now', contextBlocks: [block('fact')] });
  for (let position = 0; position <= 7; position++) {
    for (const depth of [0, 1, 100, 100000]) {
      for (const role of [null, 0, 1, 2]) {
        const b = block('fact', position, { depth, role, outletName: 'unused' });
        b.metadata.anchorHistory = [{ role: 'user', content: 'MUST_NOT_APPEAR' }];
        assert.deepEqual(assembleLorebook({ userMessage: 'now', contextBlocks: [b] }), reference);
      }
    }
  }
});

test('untrusted outlet names remain unused metadata, with every entry in the prefix', () => {
  const blocks = [block('one', 7, { outletName: '__proto__' }),
    block('two', 7, { outletName: 'constructor' }), block('three', 7, { outletName: 'toString' })];
  const before = structuredClone(blocks);
  assert.deepEqual(assembleLorebook({ userMessage: 'now', contextBlocks: blocks }).messages,
    [{ role: 'user', content: prefix('one\ntwo\nthree') + 'now' }]);
  assert.deepEqual(blocks, before);
  assert.equal(Object.prototype.polluted, undefined);
});

test('ReplyFlow sends matched entries at the top of the actual latest user request and trace only', async () => {
  let request;
  const trace = new TraceCollector();
  const flow = new ReplyFlow({
    modelRouter: { generate: async (req) => {
      request = req;
      return { rawText: 'reply', model: 'test', usage: {} };
    } },
    pipeline: { run: async (_name, ctx) => ctx },
    sender: { enqueue() {} }, eventBus: { publish: async () => {} },
    contextFlow: { getAffectionContext: () => null }, sessionStore: {},
    config: { identity: { ownerId: '3054039169', botName: '瑞姬' },
      model: { model: 'test', stream: false }, reply: { settlementTimeoutMs: 100 } },
    traceCollector: trace,
  });
  const inbound = { correlationId: 'lore-turn', sessionId: 'private:3054039169',
    executionKey: 'private:3054039169', messageId: 'turn-1', userId: '3054039169',
    messageType: 'private', sender: { displayName: 'ruaji' }, flags: { isOwner: true },
    content: '说说 Eldoria', text: '说说 Eldoria' };
  await flow.run({ inbound, triggerType: 'at', contextBlocks: [block('Eldoria is a magical forest.', 4, { depth: 1, role: 0 })] });
  assert.deepEqual(request.messages.map((m) => m.role), ['system', 'user']);
  assert.equal(request.messages[0].content.includes('magical forest'), false);
  assert.ok(request.messages[0].content.endsWith(LOREBOOK_MAINTENANCE_NOTICE));
  assert.equal(request.messages[0].content.split(LOREBOOK_MAINTENANCE_NOTICE).length - 1, 1);
  assert.equal(request.messages[1].content.includes(LOREBOOK_MAINTENANCE_NOTICE), false);
  assert.ok(request.messages[1].content.startsWith(prefix('Eldoria is a magical forest.')));
  assert.match(request.messages[1].content, /<\/lorebook-context>\n\n[\s\S]*说说 Eldoria/);
  assert.equal(trace.get('lore-turn').prompt.userMessage, request.messages[1].content);
  assert.equal(trace.get('lore-turn').prompt.systemText.includes('magical forest'), false);
});

test('aggregator never slices a World Info entry in the middle', () => {
  const aggregator = new ContextAggregator({ totalCharacterBudget: 100, perSourceCharacterBudget: 200 });
  const result = aggregator._reduce([block('x'.repeat(150))], 'any');
  assert.equal(result.blocks.length, 0);
  assert.ok(result.dropped.some((d) => d.reason.includes('whole-entry')));
});

test('only the prefix is charged: ignored history/note cannot consume budget, framing still does', () => {
  const b = block('fact', 4, { depth: 1 });
  Object.assign(b.metadata, { anchorHistory: [{ role: 'user', content: 'secret '.repeat(30000) }],
    authorNote: 'note'.repeat(10000), renderBudgetBytes: 1024 });
  assert.equal(assembleLorebook({ userMessage: 'now', contextBlocks: [b] }).userMessage, prefix('fact') + 'now');
  assert.deepEqual(lorebookContributionCost(b), { characters: prefix('fact').length,
    bytes: Buffer.byteLength(prefix('fact'), 'utf8') });
  const reduced = new ContextAggregator({ totalCharacterBudget: 200,
    perSourceCharacterBudget: 200 })._reduce([b], 'any');
  assert.equal(reduced.blocks.length, 1);
  const small = block('fact');
  small.metadata.renderBudgetBytes = Buffer.byteLength(prefix('fact'), 'utf8') - 1;
  assert.equal(assembleLorebook({ userMessage: 'now', contextBlocks: [small] }).userMessage, 'now');
  small.metadata.renderBudgetBytes++;
  assert.equal(assembleLorebook({ userMessage: 'now', contextBlocks: [small] }).userMessage, prefix('fact') + 'now');
});

test('complete contribution budget is global, prioritizes order and preserves original multimedia', () => {
  const a = block('A'.repeat(300), 7, { order: 200 });
  const b = block('B'.repeat(300), 4, { order: 100, depth: 0, role: 2 });
  a.metadata.renderBudgetBytes = b.metadata.renderBudgetBytes = 700;
  const parts = [{ type: 'text', text: 'original' }, { type: 'image_url', image_url: { url: 'file:///a.png' } }];
  const result = assembleLorebook({ userMessage: parts, contextBlocks: [b, a] });
  assert.equal(result.userMessage[0].text, prefix('A'.repeat(300)));
  assert.ok(Buffer.byteLength(result.userMessage[0].text, 'utf8') <= 700);
  assert.deepEqual(result.userMessage.slice(1), parts);
});
