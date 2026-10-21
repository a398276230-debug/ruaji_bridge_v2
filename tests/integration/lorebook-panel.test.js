import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../../src/web/public/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../../src/web/public/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../../src/web/public/style.css', import.meta.url), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setImmediate(resolve));

// Tiny DOM fixture, not a browser emulator. Parses the real HTML and the real
// generated rows so missing IDs / event bindings fail instead of being conjured
// by querySelector. Selector support is intentionally minimal: tag, #id, .class
// and bare [attribute] — tests use dataset.find() for attribute values.
class Element {
  constructor(tag, attrs = {}, owner) {
    this.tagName = tag; this.owner = owner; this.attrs = attrs; this.id = attrs.id || '';
    this.children = []; this.dataset = {}; this.style = {}; this.textContent = '';
    this.hidden = 'hidden' in attrs; this.checked = 'checked' in attrs;
    this.disabled = 'disabled' in attrs; this.indeterminate = false; this.open = 'open' in attrs;
    this._value = attrs.value || ''; this.files = [];
    this.classes = new Set((attrs.class || '').split(/\s+/).filter(Boolean));
    this.classList = {
      toggle: (name, on) => { if (on ?? !this.classes.has(name)) this.classes.add(name); else this.classes.delete(name); },
      add: (name) => this.classes.add(name), remove: (name) => this.classes.delete(name),
      contains: (name) => this.classes.has(name),
    };
    for (const [key, value] of Object.entries(attrs)) if (key.startsWith('data-')) {
      this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    }
  }
  set value(v) { this._value = String(v); }
  get value() { return this._value; }
  set innerHTML(value) { this._html = value; this.children = parse(value, this.owner); }
  get innerHTML() { return this._html || ''; }
  get options() { return this.children.filter((el) => el.tagName === 'option'); }
  appendChild(child) { this.children.push(child); child.parent = this; return child; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((el) => el !== this); }
  click() { if (this.disabled) return; if (this.tagName === 'a') this.owner.downloads.push({ name: this.download, url: this.href }); return this.onclick?.({ target: this }); }
  querySelectorAll(selector) {
    if (selector.includes(' ')) {
      const [parent, ...rest] = selector.split(' ');
      return this.querySelectorAll(parent).flatMap((el) => el.querySelectorAll(rest.join(' ')));
    }
    const all = this.children.flatMap((el) => [el, ...el.querySelectorAll('*')]);
    return all.filter((el) => selector === '*' || el.tagName === selector || selector.startsWith('#') && el.id === selector.slice(1)
      || selector.startsWith('.') && el.classes.has(selector.slice(1))
      || selector.startsWith('[') && Object.hasOwn(el.attrs, selector.slice(1, -1)));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'path', 'circle', 'rect', 'use', 'stop', 'line', 'polyline', 'polygon']);
function parse(source, owner) {
  // Real nesting, so a <button> inside a <tr> is reached exactly once through
  // querySelectorAll. Void elements never open a scope; select keeps its options.
  const root = new Element('root', {}, owner);
  const stack = [root];
  for (const match of source.matchAll(/<(\/?)([a-z][\w-]*)\b([^>]*?)(\/?)>/gi)) {
    const [, closing, tag, rawAttrs, selfClosing] = match;
    if (closing) {
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].tagName === tag) { stack.length = i; break; }
      }
      continue;
    }
    const attrs = {};
    for (const attr of rawAttrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[attr[1]] = attr[2] ?? '';
    const element = new Element(tag, attrs, owner);
    const parent = stack[stack.length - 1];
    parent.children.push(element);
    element.parent = parent;
    if (!VOID_TAGS.has(tag) && !selfClosing) stack.push(element);
  }
  const finish = (el) => {
    if (el.tagName === 'select') el.value = el.options[0]?.value ?? '';
    el.children.forEach(finish);
  };
  root.children.forEach(finish);
  return root.children;
}

function panel(fullStartup = false) {
  const document = new Element('document', {}, null); document.owner = document;
  document.downloads = []; document.body = document;
  document.children = parse(html, document);
  document.createElement = (tag) => new Element(tag, {}, document);
  const $ = (selector) => {
    const el = document.querySelector(selector); assert.ok(el, `real DOM node missing: ${selector}`); return el;
  };
  const requests = [], errors = [], prompts = [], confirmations = [], urls = new Map(), revoked = [], intervals = [];
  const books = new Map([
    [1, { id: 1, name: 'Eldoria', enabled: true, raw: { vendorBook: { untouched: true } }, entries: {
      7: { uid: 7, key: ['dragon', '/a,b/i'], keysecondary: ['forest'], content: 'Ancient woods', comment: '<img src=x onerror=alert(1)>', group: 'place', order: 20, extension: { nested: [1, false, '原样'] } },
      8: { uid: 8, content: 'Constant text', constant: true, disable: true, group: 'person', order: 100 },
      9: { uid: 9, key: ['dragon'], content: 'Other dragon', group: 'place', order: 5 },
    } }],
    [2, { id: 2, name: 'Second', enabled: false, raw: {}, entries: {} }],
  ]);
  let settings = {}, nextId = 3, fail = null;
  const fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ url, method: options.method || 'GET', body });
    let response;
    if (url === '/api/dashboard') response = {
      runtime: { mode: 'test', uptimeMs: 10, pid: 1 }, metrics: {}, components: [], circuits: [], capabilities: [], plugins: {},
    };
    else if (url === '/api/sandbox/defaults') response = { sample: { userId: '123' }, mode: 'test', middlewareOrder: [] };
    else if (fail) { response = fail; fail = null; }
    else {
      assert.ok(url.startsWith('/api/host/lorebooks/'), `unexpected service: ${url}`);
      const [action, query] = url.slice('/api/host/lorebooks/'.length).split('?');
      const id = body?.bookId ?? Number(new URLSearchParams(query).get('bookId'));
      const book = books.get(id);
      switch (action) {
        case 'list': response = { books: [...books.values()].map(({ entries, ...b }) => ({ ...b, entry_count: Object.keys(entries).length })) }; break;
        case 'get': response = { book: { id, name: book.name, enabled: book.enabled, raw: book.raw }, entries: Object.entries(book.entries).map(([uid, raw]) => ({ uid: Number(uid), book_id: id, world: book.name, raw, entryText: context.stringifyLoreJson(raw, 2) })) }; break;
        case 'create': {
          const created = { id: nextId++, name: body.name, enabled: body.enabled, raw: {}, entries: {} }; books.set(created.id, created); response = { book: created }; break;
        }
        case 'update': Object.assign(book, body); response = { book }; break;
        case 'delete': books.delete(id); response = {}; break;
        case 'entry': {
          const entry = body.entryText === undefined ? body.entry : context.parseLoreJson(body.entryText);
          const uid = entry.uid ?? Math.max(-1, ...Object.keys(book.entries).map(Number)) + 1;
          const merge = (before, patch) => {
            const result = { ...before };
            for (const [key, value] of Object.entries(patch)) {
              result[key] = value && typeof value === 'object' && !Array.isArray(value)
                ? merge(before?.[key] || {}, value) : value;
            }
            return result;
          };
          book.entries[uid] = merge(book.entries[uid], { ...entry, uid }); response = { entry: book.entries[uid] }; break;
        }
        case 'entry-delete': delete book.entries[body.uid]; response = {}; break;
        case 'selection': for (const uid of body.uids) book.entries[uid].disable = !body.enabled; response = {}; break;
        case 'settings': if (body) settings = { ...settings, ...body }; response = { settings }; break;
        case 'import': {
          const data = body.dataText === undefined ? plain(body.data) : context.parseLoreJson(body.dataText); const entries = data.entries; delete data.entries;
          const created = { id: nextId++, name: body.name, enabled: true, raw: data, entries }; books.set(created.id, created); response = { book: created }; break;
        }
        case 'export': {
          const data = { ...book.raw, entries: book.entries };
          response = { data, dataText: context.stringifyLoreJson(data, 2) }; break;
        }
        default: assert.fail(`unmocked action: ${action}`);
      }
    }
    return { ok: true, status: 200, json: async () => JSON.parse(context.stringifyLoreJson({ ok: true, ...response })) };
  };
  const context = vm.createContext({
    document, window: { addEventListener() {} }, fetch, Blob, URL: {
      createObjectURL(blob) { const url = `blob:${urls.size}`; urls.set(url, blob); return url; },
      revokeObjectURL(url) { revoked.push(url); },
    }, URLSearchParams, console,
    prompt: () => prompts.shift() ?? null,
    confirm: () => confirmations.shift() ?? true,
    setTimeout: (fn, delay) => { if (delay === 1000) fn(); return 1; }, clearTimeout() {},
    setInterval(fn) { intervals.push(fn); return intervals.length; }, clearInterval() {},
  });
  // Most scenarios isolate the view, while the startup smoke runs the entire
  // module against mocked dashboard/sandbox too. Both execute the real bind().
  const script = fullStartup ? app.replace(/export /g, '')
    : app.slice(0, app.lastIndexOf('\nbind();')).replace(/export /g, '') + '\nbind();';
  vm.runInContext(script, context, { filename: 'app.js' });
  const originalToast = context.toast;
  context.toast = (message, error) => { if (error) errors.push(message); originalToast(message, error); };
  const event = async (selector, type = 'click', value) => {
    const el = $(selector); if (value !== undefined) el.value = value;
    if (type === 'click') await el.click(); else { assert.equal(typeof el['on' + type], 'function', `${selector} ${type} handler`); await el['on' + type]({ target: el }); }
    await tick();
  };
  const enter = async () => { const tab = document.querySelectorAll('.tab').find((el) => el.dataset.view === 'lorebooks'); await tab.click(); await tick(); };
  const row = (attr, uid) => document.querySelectorAll(`[${attr}]`).find((el) => el.dataset[attr.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())] === String(uid));
  const ids = () => document.querySelectorAll('[data-lb-open]').map((el) => el.dataset.lbOpen);
  return { $, document, context, event, enter, row, ids, books, requests, errors, prompts, confirmations, urls, revoked, intervals, fail: (response) => { fail = response; } };
}

test('complete module startup succeeds and timer never refreshes lorebook forms', async () => {
  const p = panel(true); await tick();
  assert.equal(p.$('#sb-user').value, '123');
  assert.equal(p.requests.filter((r) => r.url === '/api/dashboard').length, 1);
  assert.equal(p.intervals.length, 1);
  await p.enter();
  await p.row('data-lb-open', 7).click();
  await p.event('#lb-field-content', 'change', 'Unsaved draft');
  const count = p.requests.length;
  p.intervals[0](); await tick();
  assert.equal(p.requests.length, count);
  assert.equal(p.$('#lb-field-content').value, 'Unsaved draft');
  assert.equal(p.$('#lb-dirty-badge').hidden, false, '未保存改动必须有可见提示');
  assert.deepEqual(p.errors, []);
});

test('navigation smoke: sidebar tab, real bindings, empty second book; stickers untouched', async () => {
  const p = panel(); await p.enter();
  assert.equal(p.$('#view-lorebooks').classList.contains('active'), true);
  assert.equal(p.$('#main').classList.contains('fullbleed'), true);
  assert.match(p.$('#lb-books').innerHTML, /Eldoria/);
  assert.match(p.$('#lb-books').innerHTML, /3 条 · 2 启用/);
  assert.equal(p.$('#lb-enabled').checked, true);
  assert.equal(p.$('#lb-field-order').value, '', 'entry not opened yet');
  await p.row('data-lb-book', 2).click();
  assert.equal(p.$('#lb-enabled').checked, false);
  assert.match(p.$('#lb-entries').innerHTML, /还是空的/);
  assert.ok(p.$('#view-memes')); assert.ok(p.$('#meme-grid')); assert.ok(p.$('#meme-edit-modal'));
  assert.ok(!html.includes('id="view-slang"'));
  assert.ok(!app.includes('/api/host/memes'));
  assert.match(html, /只前置到本轮当前 user 消息/);
  assert.match(html, /不决定插入位置/);
  assert.ok(vm.runInContext("NO_AUTOREFRESH.has('lorebooks')", p.context));
  assert.deepEqual(p.errors, []);
});

test('friendly controls and raw JSON synchronize without adding defaults or dropping unknown fields', async () => {
  const p = panel(); await p.enter();
  assert.ok(!p.$('#lb-entries').innerHTML.includes('<img src=x'));
  await p.row('data-lb-open', 7).click();
  assert.equal(p.$('#lb-editor').hidden, false);
  assert.equal(p.$('#lb-app').classList.contains('has-editor'), true);
  assert.equal(p.$('#lb-field-probability').value, '100');
  assert.equal(p.$('#lb-field-key').value, 'dragon\n/a,b/i');
  await p.event('#lb-field-content', 'change', 'Edited content');
  await p.event('#lb-field-keysecondary', 'change', 'new keyword\n/a,b/i');
  let raw = JSON.parse(p.$('#lb-raw').value);
  assert.deepEqual(raw.keysecondary, ['new keyword', '/a,b/i']);
  assert.deepEqual(raw.extension, { nested: [1, false, '原样'] });
  assert.equal('probability' in raw, false, 'fallback must not be persisted');
  raw.role = 12; raw.sticky = 3; raw.extension.extra = 'future';
  await p.event('#lb-raw', 'input', JSON.stringify(raw));
  assert.equal(p.$('#lb-field-role').value, '12', 'future enum remains visible');
  assert.equal(p.$('#lb-field-sticky').value, '3');
  await p.event('#lb-save');
  const posted = p.requests.find((r) => r.url.endsWith('/entry')).body.entry;
  assert.deepEqual(posted, { uid: 7, content: raw.content, keysecondary: raw.keysecondary, extension: raw.extension, role: 12, sticky: 3 }, 'only edited native fields are patched');
  assert.deepEqual(p.books.get(1).entries[7], raw);
  assert.equal(p.$('#lb-editor').hidden, true);
  assert.deepEqual(p.errors, []);
});

test('text/group/active filters, numeric ordering, checkbox batch and blue/green toggles', async () => {
  const p = panel(); await p.enter();
  assert.deepEqual(p.ids(), ['8', '7', '9']);
  await p.event('#lb-sort', 'change', 'asc'); assert.deepEqual(p.ids(), ['9', '7', '8']);
  await p.event('#lb-q', 'input', 'dragon'); await p.event('#lb-group', 'input', 'place');
  assert.deepEqual(p.ids(), ['9', '7']);
  p.$('#lb-select-all').checked = true; await p.event('#lb-select-all', 'change');
  assert.match(p.$('#lb-count').textContent, /已选 2/);
  await p.event('#lb-batch-off');
  assert.deepEqual(p.requests.find((r) => r.url.endsWith('/selection')).body, { bookId: 1, uids: [9, 7], enabled: false });
  await p.event('#lb-active', 'change', 'on'); assert.deepEqual(p.ids(), []);
  await p.event('#lb-active', 'change', 'off'); assert.deepEqual(p.ids(), ['9', '7']);
  const mode = p.row('data-lb-mode', 7); assert.ok(mode.classList.contains('lb-keyword'));
  await mode.click();
  assert.equal(p.books.get(1).entries[7].constant, true);
  assert.ok(p.row('data-lb-mode', 7).classList.contains('lb-constant'));

  const active = p.row('data-lb-active', 7); await active.click();
  assert.equal(p.books.get(1).entries[7].disable, false);
  assert.deepEqual(p.ids(), ['9'], 'enabling an entry removes it from the 已禁用 filter');
  await p.event('#lb-active', 'change', 'all');
  assert.deepEqual(p.ids(), ['9', '7']);
  assert.equal(p.row('data-lb-active', 7).classList.contains('off'), false);
  assert.deepEqual(p.errors, []);
});

test('order steppers patch native order and move the row in the rendered sequence', async () => {
  const p = panel(); await p.enter();
  const move = (uid, dir) => p.document.querySelectorAll('[data-lb-move]')
    .find((el) => el.dataset.lbUid === String(uid) && el.dataset.lbMove === String(dir));
  assert.deepEqual(p.ids(), ['8', '7', '9']);

  await move(8, 1).click();
  let patch = p.requests.filter((r) => r.url.endsWith('/entry')).at(-1).body;
  assert.equal(patch.entry.uid, 8);
  assert.equal(patch.entry.order, 19, 'desc sort: moving down drops order below the neighbour');
  assert.deepEqual(p.ids(), ['7', '8', '9']);

  await p.event('#lb-sort', 'change', 'asc');
  assert.deepEqual(p.ids(), ['9', '8', '7']);
  await move(7, -1).click();
  patch = p.requests.filter((r) => r.url.endsWith('/entry')).at(-1).body;
  assert.equal(patch.entry.uid, 7);
  assert.equal(patch.entry.order, 18, 'asc sort: moving up drops order below the neighbour');
  assert.deepEqual(p.ids(), ['9', '7', '8']);
  assert.deepEqual(p.errors, []);
});

test('book create/rename/enable/delete and entry create/delete use native endpoint payloads', async () => {
  const p = panel(); await p.enter();
  await p.event('#lb-create');
  assert.equal(p.$('#lb-book-new').hidden, false);
  p.$('#lb-book-new-name').value = 'New book';
  await p.event('#lb-book-new-save');
  assert.equal(p.$('#lb-book-title').textContent, 'New book');
  assert.equal(p.books.get(3).name, 'New book');

  await p.event('#lb-rename');
  p.$('#lb-rename-input').value = 'Renamed';
  await p.event('#lb-rename-save');
  assert.equal(p.books.get(3).name, 'Renamed');
  assert.equal(p.$('#lb-book-title').textContent, 'Renamed');

  p.$('#lb-enabled').checked = false; await p.event('#lb-enabled', 'change'); assert.equal(p.books.get(3).enabled, false);

  await p.event('#lb-new'); await p.event('#lb-field-content', 'change', 'New native entry'); await p.event('#lb-save');
  assert.deepEqual(p.books.get(3).entries[0], { uid: 0, content: 'New native entry' });
  await p.row('data-lb-open', 0).click(); await p.event('#lb-entry-delete');
  assert.deepEqual(p.books.get(3).entries, {});
  await p.event('#lb-delete');
  assert.equal(p.books.has(3), false);
  assert.equal(p.$('#lb-book-title').textContent, 'Eldoria');
  assert.deepEqual(p.errors, []);
});

test('native JSON file import → friendly edit → downloadable export preserves book/entry extensions', async () => {
  const p = panel(); await p.enter();
  const native = { name: 'Native', vendor: { flags: [1, 'x'] }, extensions: { future: true }, entries: {
    41: { uid: 41, key: ['/x,y/i'], content: 'Imported', customFlag: { timing: [3, 9] }, position: 4, depth: 6, role: 2, cooldown: 8 },
  } };
  await p.event('#lb-import');
  assert.equal(p.$('#lb-import-dialog').hidden, false);
  p.$('#lb-file').files = [{ name: 'Native.json', text: async () => JSON.stringify(native) }];
  await p.event('#lb-file', 'change');
  assert.match(p.$('#lb-import-preview').innerHTML, /1/);
  assert.equal(p.$('#lb-import-name').value, 'Native');
  await p.event('#lb-import-confirm');
  assert.deepEqual(p.requests.find((r) => r.url.endsWith('/import')).body, { name: 'Native', dataText: JSON.stringify(native) });
  assert.equal(p.$('#lb-import-dialog').hidden, true);

  await p.row('data-lb-open', 41).click();
  await p.event('#lb-field-comment', 'change', 'Edited title'); await p.event('#lb-save');
  await p.event('#lb-export');
  assert.equal(p.$('#lb-export-name').value, 'Native.json');
  await p.event('#lb-export-download');
  assert.equal(p.document.downloads[0].name, 'Native.json');
  const blob = p.urls.get(p.document.downloads[0].url);
  assert.equal(blob.type, 'application/json');
  const expected = plain(native); expected.entries[41].comment = 'Edited title';
  assert.deepEqual(JSON.parse(await blob.text()), expected);
  assert.deepEqual(p.revoked, [p.document.downloads[0].url]);
  assert.deepEqual(p.errors, []);
});

test('settings fallback values round-trip false and zero with all native names', async () => {
  const p = panel(); await p.enter();
  await p.event('#lb-settings-open');
  assert.equal(p.$('#lb-settings-dialog').hidden, false);
  assert.equal(p.$('#lb-setting-scanDepth').value, '2');
  assert.equal(p.$('#lb-setting-recursive').checked, true);
  assert.equal(p.$('#lb-setting-budgetTokens').value, '2048');
  p.$('#lb-setting-enabled').checked = false; p.$('#lb-setting-recursive').checked = false;
  await p.event('#lb-setting-scanDepth', 'change', '0');
  await p.event('#lb-setting-budgetTokens', 'change', '0'); await p.event('#lb-settings-save');
  assert.deepEqual(p.requests.find((r) => r.url.endsWith('/settings') && r.method === 'POST').body, {
    enabled: false, scanDepth: 0, recursive: false, maxRecursionSteps: 8, budgetTokens: 0,
    caseSensitive: false, matchWholeWords: false, useGroupScoring: false,
  });
  assert.equal(p.$('#lb-setting-budgetTokens').value, '0');
  assert.equal(p.$('#lb-settings-dialog').hidden, true);
  assert.deepEqual(p.errors, []);
});

test('invalid raw JSON and uid edits cannot save; dirty switch cancellation and API errors are surfaced', async () => {
  const p = panel(); await p.enter();
  await p.row('data-lb-open', 7).click();
  const before = p.requests.filter((r) => r.method === 'POST').length;
  await p.event('#lb-raw', 'input', '{broken'); await p.event('#lb-save');
  assert.ok(p.$('#lb-json-error').textContent); assert.equal(p.errors.length, 1);
  await p.event('#lb-raw', 'input', '{"uid":8}'); await p.event('#lb-save'); assert.match(p.errors.at(-1), /uid/);
  assert.equal(p.requests.filter((r) => r.method === 'POST').length, before);
  p.confirmations.push(false); await p.row('data-lb-book', 2).click(); assert.equal(p.$('#lb-book-title').textContent, 'Eldoria');
  assert.equal(p.$('#lb-editor').hidden, false);
  await p.event('#lb-cancel');
  p.fail({ ok: false, error: 'host unavailable' }); await p.event('#refresh-btn');
  assert.match(p.$('#lb-status').textContent, /host unavailable/);
  assert.equal(p.$('#lb-create').disabled, false, 'failed actions release busy guard');
});

test('dirty editor also blocks tab navigation until discarded', async () => {
  const p = panel(); await p.enter();
  await p.row('data-lb-open', 7).click();
  await p.event('#lb-field-content', 'change', 'Draft');
  const overview = p.document.querySelectorAll('.tab').find((el) => el.dataset.view === 'overview');
  p.confirmations.push(false); await overview.click(); await tick();
  assert.equal(p.$('#view-lorebooks').classList.contains('active'), true, 'cancel keeps the user on the dirty page');
  p.confirmations.push(true); await overview.click(); await tick();
  assert.equal(p.$('#view-overview').classList.contains('active'), true);
  assert.equal(p.$('#lb-editor').hidden, true, 'confirmed discard closes the editor');
});

test('no-op saves do not inject uid/defaults; fractional weights and invalid numeric edits are safe', async () => {
  const p = panel(); await p.enter();
  delete p.books.get(1).entries[7].uid;
  await p.event('#refresh-btn');
  const open = async () => { await p.row('data-lb-open', 7).click(); };
  await open();
  await p.event('#lb-save');
  assert.equal(p.requests.some((r) => r.url.endsWith('/entry')), false);
  assert.equal('uid' in p.books.get(1).entries[7], false);
  await open();
  await p.event('#lb-field-probability', 'change', '37.5');
  await p.event('#lb-field-groupWeight', 'change', '0.25');
  await p.event('#lb-save');
  assert.deepEqual(p.requests.find((r) => r.url.endsWith('/entry')).body.entry, { uid: 7, probability: 37.5, groupWeight: 0.25 });
  await open();
  await p.event('#lb-field-order', 'change', '1.5');
  await p.event('#lb-save');
  assert.match(p.errors.at(-1), /无效字段/);
  assert.equal(p.requests.filter((r) => r.url.endsWith('/entry')).length, 1);
  p.confirmations.push(false); await p.event('#lb-cancel');
  assert.equal(p.$('#lb-editor').hidden, false, 'invalid pending edits also require discard confirmation');
  await p.event('#lb-field-order', 'change', '30'); await p.event('#lb-save');
  assert.equal(p.books.get(1).entries[7].order, 30);
});

test('raw deletions unsupported by merge API and null uid changes fail explicitly', async () => {
  const p = panel(); await p.enter();
  await p.row('data-lb-open', 7).click();
  const raw = JSON.parse(p.$('#lb-raw').value);
  raw.uid = null; await p.event('#lb-raw', 'input', JSON.stringify(raw)); await p.event('#lb-save');
  assert.match(p.errors.at(-1), /uid/);
  raw.uid = 7; delete raw.extension.nested;
  await p.event('#lb-raw', 'input', JSON.stringify(raw)); await p.event('#lb-save');
  assert.match(p.errors.at(-1), /不能删除/);
  assert.equal(p.requests.some((r) => r.url.endsWith('/entry')), false);
  assert.deepEqual(p.books.get(1).entries[7].extension, { nested: [1, false, '原样'] });
});

test('raw removal is blocked by partial merge contract; invalid friendly fields block save', async () => {
  const p = panel(); await p.enter();
  await p.row('data-lb-open', 7).click();
  const original = JSON.parse(p.$('#lb-raw').value);
  const missing = plain(original); delete missing.extension.nested;
  await p.event('#lb-raw', 'input', JSON.stringify(missing)); await p.event('#lb-save');
  assert.match(p.errors.at(-1), /不能删除/);
  assert.equal(p.requests.some((r) => r.url.endsWith('/entry')), false);
  await p.event('#lb-raw', 'input', JSON.stringify(original));
  await p.event('#lb-field-order', 'change', '1.5'); await p.event('#lb-save');
  assert.match(p.errors.at(-1), /无效字段/);
  await p.event('#lb-field-order', 'change', '0');
  await p.event('#lb-field-probability', 'change', '37.5');
  await p.event('#lb-save');
  assert.equal(p.books.get(1).entries[7].probability, 37.5);
  assert.equal(p.books.get(1).entries[7].order, 0);
  assert.deepEqual(p.books.get(1).entries[7].extension, original.extension);
});

test('malformed imports and failed enable switches report errors without destructive requests', async () => {
  const p = panel(); await p.enter();
  await p.event('#lb-import');
  p.$('#lb-file').files = [{ name: 'wrong.json', text: async () => '{"entries":[]}' }];
  await p.event('#lb-file', 'change'); assert.match(p.errors.at(-1), /entries/);
  assert.equal(p.requests.some((r) => r.url.endsWith('/import')), false);
  assert.equal(p.$('#lb-import-confirm').disabled, true);
  await p.event('#lb-import-cancel');
  p.fail({ ok: false, error: 'write rejected' }); p.$('#lb-enabled').checked = false;
  await p.event('#lb-enabled', 'change'); assert.equal(p.$('#lb-enabled').checked, true);
  assert.match(p.errors.at(-1), /write rejected/);
});

test('native file text and raw editor preserve unsafe integer extensions, including sibling edits', async () => {
  const p = panel(); await p.enter();
  const dataText = '{"vendor":{"id":9007199254740993},"entries":{"41":{"uid":41,"content":"Native","extension":{"id":9007199254740993,"negative":-9007199254740993,"text":"9007199254740993"}}}}';
  await p.event('#lb-import');
  p.$('#lb-file').files = [{ name: 'Large.json', text: async () => dataText }];
  await p.event('#lb-file', 'change');
  await p.event('#lb-import-confirm');
  assert.deepEqual(p.requests.find((r) => r.url.endsWith('/import')).body, { name: 'Large', dataText });
  await p.row('data-lb-open', 41).click();
  assert.match(p.$('#lb-raw').value, /"id": 9007199254740993/);
  await p.event('#lb-field-comment', 'change', 'Friendly edit');
  assert.match(p.$('#lb-raw').value, /"id": 9007199254740993/);
  await p.event('#lb-save');
  assert.deepEqual(p.requests.find((r) => r.url.endsWith('/entry')).body.entry, { uid: 41, comment: 'Friendly edit' }, 'untouched extension is not patched');
  await p.row('data-lb-open', 41).click();
  await p.event('#lb-raw', 'input', p.$('#lb-raw').value.replace('"extension": {', '"extension": {"sibling": true,'));
  await p.event('#lb-save');
  const patch = p.requests.filter((r) => r.url.endsWith('/entry')).at(-1).body;
  assert.equal(patch.entry, undefined);
  assert.match(patch.entryText, /"id":9007199254740993/);
  assert.match(patch.entryText, /"negative":-9007199254740993/);
  await p.event('#lb-export');
  await p.event('#lb-export-download');
  const output = await p.urls.get(p.document.downloads[0].url).text();
  assert.equal((output.match(/"id": 9007199254740993/g) || []).length, 2, 'root and nested extension numbers retain their values');
  assert.match(output, /"negative": -9007199254740993/);
  assert.match(output, /"text": "9007199254740993"/);
  assert.match(output, /"sibling": true/);
  assert.deepEqual(p.errors, []);
});

test('raw integer parsing rejects malformed numbers and never treats marker-like strings as numbers', async () => {
  const p = panel(); await p.enter(); await p.event('#lb-new');
  const text = String.raw`{"extension":{"id":9007199254740993,"quoted":"\u005f_lore_number__9007199254740993","escaped":"a\\\"9007199254740993"}}`;
  await p.event('#lb-raw', 'input', text); await p.event('#lb-save');
  assert.equal(p.errors.length, 0);
  const wire = p.requests.find((r) => r.url.endsWith('/entry')).body.entryText;
  assert.match(wire, /"id":9007199254740993/);
  assert.equal(JSON.parse(wire).extension.quoted, '__lore_number__9007199254740993');
  await p.event('#lb-new');
  await p.event('#lb-raw', 'input', '{"bad":09007199254740993}'); await p.event('#lb-save');
  assert.equal(p.requests.filter((r) => r.url.endsWith('/entry')).length, 1);
  assert.ok(p.errors.length);
});

test('redesigned console ships the three-pane shell, tooltips and no framework/build dependency', async () => {
  assert.match(html, /class="lb-app"/);
  assert.match(html, /id="lb-books"/);
  assert.match(html, /id="lb-books-panel"/);
  assert.match(html, /id="lb-rename-input"/);
  assert.match(html, /data-tip="蓝灯 \/ constant/);
  assert.match(html, /存储兼容[\s\S]*不影响注入位置|不影响注入位置/);
  assert.match(html, /id="lb-import-dialog"/);
  assert.match(html, /id="lb-export-dialog"/);
  assert.match(css, /--lamp-blue/);
  assert.match(css, /--lamp-green/);
  assert.ok(!/<script[^>]+src="https?:/.test(html), 'no CDN scripts');
  assert.ok(!html.includes('@import'), 'no remote CSS imports');
  assert.ok(!app.includes("from 'react'") && !app.includes('vue'), 'no framework');
});
