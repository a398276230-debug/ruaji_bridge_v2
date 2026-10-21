import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildTestContainer } from '../helpers.js';

test('Host API 路由注册与端点降级/转发验证', async () => {
  const container = buildTestContainer({
    mode: 'shadow',
    web: { port: 0 },
    unifiedHost: { url: 'http://127.0.0.1:8870' },
  });

  const server = await container.webServer.listen(0, '127.0.0.1');
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    // 1. 验证 plugins-pages
    const res1 = await fetch(`${base}/api/host/plugins-pages`);
    const data1 = await res1.json();
    assert.equal(res1.status, 200);
    assert.ok('ok' in data1);

    // 2. 验证 overview
    const res2 = await fetch(`${base}/api/host/overview`);
    const data2 = await res2.json();
    assert.equal(res2.status, 200);
    assert.ok('ok' in data2);

    // 3. 验证 providers
    const res3 = await fetch(`${base}/api/host/providers`);
    const data3 = await res3.json();
    assert.equal(res3.status, 200);
    assert.ok('ok' in data3);

    // 4. 验证 /proxy/plugin/ 安全过滤与路径解析
    const res4 = await fetch(`${base}/proxy/plugin/80/`);
    assert.equal(res4.status, 403);
    const data4 = await res4.json();
    assert.match(data4.error, /受保护系统端口/);
  } finally {
    await container.webServer.close();
    container.cleanup();
  }
});

test('插件门户 /plug/ 同源透传到统一宿主（页面 404 根治）', async () => {
  // 1. 假宿主：记录收到的请求，回放带 X-Frame-Options 的页面与 JSON API
  const seen = [];
  const fakeHost = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url });
    if (req.url.startsWith('/plug/favour_ultra/page')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Frame-Options': 'DENY',
      });
      res.end('<html><head><title>favour</title></head><body>FAVOUR_PAGE_MARKER</body></html>');
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, echoUrl: req.url, echoBody: body }));
    });
  });
  await new Promise((resolve) => fakeHost.listen(0, '127.0.0.1', resolve));
  const hostPort = fakeHost.address().port;

  const container = buildTestContainer({
    configOverrides: { unifiedHost: { baseUrl: `http://127.0.0.1:${hostPort}` } },
  });
  const server = await container.webServer.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // 2. 页面透传：200、内容在、不注入 <base>（同源回环是本代理的存在意义）、剥掉 X-Frame-Options
    const page = await fetch(`${base}/plug/favour_ultra/page`);
    assert.equal(page.status, 200, '门户页面必须经由面板端口可达');
    const html = await page.text();
    assert.match(html, /FAVOUR_PAGE_MARKER/);
    assert.ok(!html.includes('<base'), '宿主页面透传不能注入 <base>，否则页内 fetch 变跨域');
    assert.equal(page.headers.get('x-frame-options'), null, 'iframe 拦截头必须被清洗');

    // 3. API 透传：查询串保留、POST 体透传
    const api = await fetch(`${base}/plug/favour_ultra/api/datarecords?limit=5`);
    assert.equal(api.status, 200);
    const data = await api.json();
    assert.equal(data.echoUrl, '/plug/favour_ultra/api/datarecords?limit=5', '查询串必须原样到达宿主');

    const post = await fetch(`${base}/plug/favour_ultra/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ favour: 42 }),
    });
    const posted = await post.json();
    assert.equal(posted.echoBody, '{"favour":42}', 'POST 体必须原样到达宿主');

    assert.ok(seen.some((s) => s.url.includes('?limit=5')), '宿主确实收到了查询参数');
  } finally {
    await container.webServer.close();
    container.cleanup();
    await new Promise((resolve) => fakeHost.close(resolve));
  }
});

test('lorebook native text import/export and entry patches survive the Node proxy without integer rounding', async () => {
  const dataText = '{"future":{"id":9007199254740993},"entries":{"7":{"uid":7,"extension":{"id":-9007199254740993}}}}';
  const entryText = '{"uid":7,"extension":{"id":9007199254740993}}';
  const seen = [];
  const fakeHost = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url.startsWith('/api/v1/lorebooks/export')) {
        // Deliberately supply an actual unsafe number in the old object field.
        res.end('{"ok":true,"data":' + dataText + ',"dataText":' + JSON.stringify(dataText) + '}');
      } else if (req.url.startsWith('/api/v1/lorebooks/get')) {
        res.end('{"ok":true,"entries":[{"uid":7,"raw":' + entryText + ',"entryText":' + JSON.stringify(entryText) + '}]}');
      } else {
        res.end('{"ok":true,"book":{"id":1}}');
      }
    });
  });
  await new Promise((resolve) => fakeHost.listen(0, '127.0.0.1', resolve));
  const container = buildTestContainer({
    configOverrides: { unifiedHost: { baseUrl: `http://127.0.0.1:${fakeHost.address().port}` } },
  });
  const server = await container.webServer.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}/api/host/lorebooks`;
  try {
    for (const [action, payload] of [
      ['import', { name: 'Native', dataText }],
      ['entry', { bookId: 1, entryText }],
      ['import', { name: 'Legacy', data: { entries: {} } }],
    ]) {
      const response = await fetch(`${base}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).ok, true);
      assert.deepEqual(seen.at(-1).body, payload);
      assert.equal(seen.at(-1).url, `/api/v1/lorebooks/${action}`);
    }
    const exported = await (await fetch(`${base}/export?bookId=1`)).json();
    assert.equal(exported.dataText, dataText, 'download must use text, not the compatibility object');
    assert.ok(exported.data.entries, 'legacy object API remains available');
    assert.equal(seen.at(-1).url, '/api/v1/lorebooks/export?bookId=1');
    const loaded = await (await fetch(`${base}/get?bookId=1`)).json();
    assert.equal(loaded.entries[0].entryText, entryText, 'raw editor receives the original integer literal');
  } finally {
    await container.webServer.close();
    container.cleanup();
    await new Promise((resolve) => fakeHost.close(resolve));
  }
});

test('/plug/ 代理的安全边界：非 loopback 宿主拒绝、宿主不可达降级 502', async () => {
  // 非 loopback：配置层就拒绝，不会发起任何外联
  const offsite = buildTestContainer({
    configOverrides: { unifiedHost: { baseUrl: 'http://192.168.1.5:8870' } },
  });
  const offsiteServer = await offsite.webServer.listen(0, '127.0.0.1');
  try {
    const res = await fetch(`http://127.0.0.1:${offsiteServer.address().port}/plug/favour_ultra/page`);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /loopback/);
  } finally {
    await offsite.webServer.close();
    offsite.cleanup();
  }

  // loopback 但端口没人听：502 友好降级，而不是 500 或挂死
  const probe = http.createServer(() => {});
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const deadPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const down = buildTestContainer({
    configOverrides: { unifiedHost: { baseUrl: `http://127.0.0.1:${deadPort}` } },
  });
  const downServer = await down.webServer.listen(0, '127.0.0.1');
  try {
    const res = await fetch(`http://127.0.0.1:${downServer.address().port}/plug/favour_ultra/page`);
    assert.equal(res.status, 502);
    const body = await res.text();
    assert.match(body, /未连接或未就绪/);
  } finally {
    await down.webServer.close();
    down.cleanup();
  }
});
