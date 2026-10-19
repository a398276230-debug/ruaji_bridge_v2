import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplyFlow } from '../../src/orchestration/reply-flow.js';
import { createInboundMessage } from '../../src/contracts/messages.js';

for (const type of ['group', 'private']) {
  test(`${type} 工具进度在生成结束前经本轮租约发送，正文首段/计数不受影响`, async () => {
    let finish;
    const gate = new Promise((resolve) => { finish = resolve; });
    let progressSent;
    const visible = new Promise((resolve) => { progressSent = resolve; });
    const sent = [];
    let released = false;
    const lease = { held: true, enqueue(m) { assert.equal(released, false); sent.push(m); progressSent(); }, async release() { released = true; } };
    const flow = new ReplyFlow({
      modelRouter: { async generate(req, opts) {
        opts.onToolProgress({ id: 'a', name: 'terminal', status: 'running', label: 'secret' });
        await gate;
        opts.onText('已经完成。');
        return { rawText: '已经完成。', model: 'test', usage: {}, latencyMs: 1 };
      } },
      pipeline: { async run(name, ctx) { return ctx; } },
      sender: { enqueue() { assert.fail('不能绕过租约'); } },
      sessionSendQueue: { async acquire() { return lease; } },
      eventBus: { publish() {} },
      contextFlow: { getAffectionContext() { return null; } },
      config: { identity: {}, model: { model: 'test' }, toolProgress: { enabled: true, groupWhitelist: ['777'], privateWhitelist: ['123'] } },
      logger: { child: () => ({ info() {}, warn() {} }) },
    });
    const inbound = createInboundMessage({ correlationId: 'p', sessionId: 's', userId: '123', groupId: type === 'group' ? '777' : null, messageType: type, content: 'hello', sender: { displayName: 'test' } });
    const run = flow.run({ inbound, contextBlocks: [], triggerType: 'at' });
    try {
      await visible;
      assert.equal(sent.length, 1);
      assert.equal(released, false);
      assert.equal(sent[0].text, '⏳ 正在调用 terminal…');
      assert.deepEqual(sent[0].target, { type, id: type === 'group' ? '777' : '123' });
      assert.equal(sent[0].metadata.origin, 'tool-progress');
      assert.equal(sent[0].metadata.isFirst, false);
      finish();
      const result = await run;
      assert.equal(result.segments, 1);
      assert.equal(sent[1].metadata.isFirst, true);
      assert.equal(released, true);
    } finally { finish(); await run; }
  });
}
