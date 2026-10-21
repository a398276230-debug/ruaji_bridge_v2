/**
 * web/public/app.js — 控制台前端（原生 ESM，无构建）
 *
 * 全部渲染都基于后端返回的 JSON，前端不保存任何业务状态，也不做本地推断：
 * 面板显示的每个数字都必须能在某个 API 响应里逐字找到。这样"面板说 X 而
 * 实际是 Y"这类问题永远不会源于前端。
 *
 * 唯一的本地状态是 UI 状态（当前标签页、选中的 trace）。
 */

// ============================================================ 基础设施

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** 所有插入 DOM 的后端字符串都要过这里 —— 昵称和黑话里什么都可能有 */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/**
 * 频控名单条目 → 输入框文本。
 *
 * 与后端 core/rate-limit-policy.js 的 formatRateLimitEntry 保持对称：
 * 纯默认额度是 `QQ号`，带覆盖项是 `QQ号:条数` / `QQ号:条数:窗口毫秒`，
 * 严格拦截是 `QQ号:block`。对象写法只在配置文件里出现，面板展示时展开成文本。
 */
export function formatRateLimitEntry(entry) {
  if (entry == null) return '';
  if (typeof entry !== 'object') return String(entry).trim();
  const id = String(entry.userId ?? entry.id ?? '').trim();
  if (!id) return '';
  const max = Number(entry.maxReplies ?? entry.limit);
  const win = Number(entry.windowMs ?? entry.window);
  let out = id;
  if (Number.isFinite(max) && max > 0) out += `:${Math.floor(max)}`;
  if (Number.isFinite(win) && win > 0) out += `:${Math.floor(win)}`;
  if (entry.block === true) out += ':block';
  return out;
}

/**
 * 群聊白名单条目 → 输入框文本（与后端 formatGroupRateLimitEntry 对称）。
 * 纯群号 = 不限速；"群号:条数" / "群号:条数:窗口毫秒" / "群号:block" = 群级频控。
 */
export function formatGroupRateLimitEntry(entry) {
  if (entry == null) return '';
  if (typeof entry !== 'object') return String(entry).trim();
  const id = String(entry.groupId ?? entry.gid ?? entry.group ?? entry.id ?? '').trim();
  if (!id) return '';
  const max = Number(entry.maxReplies ?? entry.limit);
  const win = Number(entry.windowMs ?? entry.window);
  let out = id;
  if (Number.isFinite(max) && max > 0) out += `:${Math.floor(max)}`;
  if (Number.isFinite(win) && win > 0) out += `:${Math.floor(win)}`;
  if (entry.block === true) out += ':block';
  return out;
}

export async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

let toastTimer = null;
export function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('err', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

export function fmtMs(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m${Math.floor((ms % 60000) / 1000)}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

export function fmtBytes(n) {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)}${units[i]}`;
}

export function fmtTime(ts) {
  if (!ts) return '—';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(String(ts));
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

// ============================================================ 视图切换

const state = { view: 'overview', selectedTrace: null, autorefresh: true, timer: null };

function setNavOpen(open) {
  document.body.classList.toggle('nav-open', open);
  $('#nav-scrim').hidden = !open;
}

function closeLoreDialogs() {
  for (const id of ['lb-import-dialog', 'lb-export-dialog', 'lb-settings-dialog']) closeDialog(id);
}

function switchView(view) {
  // 离开世界书前先处理未保存的条目：被取消就留在原地，不切视图。
  if (view !== state.view) {
    if (state.view === 'lorebooks' && lore.settingsDirty && !confirm('世界书设置尚未保存，确定离开？')) return;
    if (state.view === 'lorebooks' && !discardLore()) return;
    if (state.view === 'lorebooks') {
      closeLoreEditor();
      closeLoreDialogs();
      setBooksDrawer(false);
    }
  }
  state.view = view;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  $('#main').classList.toggle('fullbleed', view === 'lorebooks');
  const tab = $$('.tab').find((t) => t.dataset.view === view);
  if (tab) {
    $('#page-title').textContent = tab.querySelector('.nav-label')?.textContent || tab.textContent.trim();
    document.title = `RUAJI Bridge v2 · ${$('#page-title').textContent}`;
  }
  setNavOpen(false);
  refresh();
}

// ============================================================ 系统大盘

async function renderOverview() {
  const d = await api('/api/dashboard');

  // 顶栏
  const modePill = $('#mode-pill');
  modePill.textContent = `${d.runtime.mode}${d.runtime.shadowForced ? ' (强制)' : ''}`;
  modePill.className = `pill ${d.runtime.mode === 'shadow' ? 'shadow' : d.runtime.mode === 'live' ? 'live' : ''}`;
  $('#uptime-pill').textContent = `运行 ${fmtMs(d.runtime.uptimeMs)} · PID ${d.runtime.pid}`;
  $('#brand-sub').textContent =
    `${d.runtime.botName} (${d.runtime.robotId}) · 发送 ${d.runtime.sendEnabled ? '开' : '关'}`
    + ` · 副作用 ${d.runtime.sideEffectsEnabled ? '开' : '关'}`;

  // 组件卡片
  $('#component-cards').innerHTML = d.components.map((c) => `
    <div class="card ${c.status}">
      <div class="card-head">
        <div>
          <div class="card-title">${esc(c.label)}</div>
          <div class="card-target">${esc(c.target)}</div>
        </div>
        <span class="dot ${c.status}"></span>
      </div>
      <div class="card-detail">${renderDetail(c.detail)}</div>
    </div>`).join('');

  // 指标磁贴
  const m = d.metrics ?? {};
  $('#metric-tiles').innerHTML = [
    tile('吞吐量', m.throughput?.messages ?? 0, '条/分钟'),
    tile('累计消息', m.messages ?? 0, '条'),
    tile('平均 LLM 耗时', m.llm?.avgLatencyMs ?? 0, 'ms'),
    tile('LLM 调用', m.llm?.calls ?? 0, '次'),
    tile('已发送', m.sent ?? 0, '条'),
    tile('发送队列', d.queue?.pending ?? 0, '待发'),
    tile('堆内存', `${d.runtime.memory?.heapPercent ?? 0}%`, fmtBytes(d.runtime.memory?.heapUsed)),
    tile('追踪缓冲', `${m.traces ?? 0}/${m.maxTraces ?? 0}`, '条'),
  ].join('');

  // Middleware 延迟
  const mw = Object.entries(m.middleware ?? {});
  $('#middleware-table tbody').innerHTML = mw.length
    ? mw.sort((a, b) => b[1].avgMs - a[1].avgMs).map(([name, s]) => `
        <tr><td class="mono">${esc(name)}</td><td class="num">${s.calls}</td>
        <td class="num">${s.avgMs}</td><td class="num">${s.maxMs}</td></tr>`).join('')
    : `<tr><td colspan="4" class="empty">还没有消息流经管线</td></tr>`;

  // 裁决分布
  $('#decision-table tbody').innerHTML = Object.entries(m.decisions ?? {})
    .map(([route, n]) => `<tr><td><span class="tag ${route}">${esc(route)}</span></td><td class="num">${n}</td></tr>`)
    .join('') || `<tr><td colspan="2" class="empty">暂无裁决记录</td></tr>`;

  // 熔断
  $('#circuit-table tbody').innerHTML = d.circuits.length
    ? d.circuits.map((c) => `
        <tr>
          <td class="mono">${esc(c.name)}</td>
          <td><span class="tag ${String(c.state).toLowerCase()}">${esc(c.state)}</span></td>
          <td class="num">${c.failures}/${c.threshold}</td>
          <td class="num">${c.totalOpens ?? 0}</td>
          <td class="mono">${c.nextRetryAt ? fmtTime(c.nextRetryAt) : '—'}</td>
          <td class="mono">${esc(c.lastError ?? '—')}</td>
        </tr>`).join('')
    : `<tr><td colspan="6" class="empty">所有断路器均未初始化（还没有能力被调用过）</td></tr>`;

  // 能力与插件
  $('#capability-list').innerHTML = d.capabilities.length
    ? d.capabilities.map((c) => `
        <div><span class="k">${esc(c.capability)}</span><span class="v">${
          c.providers.map((p) => `<span class="tag ${String(p.circuit.state).toLowerCase()}">${esc(p.id)} · P${p.priority}</span>`).join(' ')
        }</span></div>`).join('')
    : '<div class="empty">没有注册任何能力 Provider</div>';

  const plugins = d.plugins?.plugins ?? [];
  $('#plugin-list').innerHTML = plugins.length
    ? plugins.map((p) => `<div><span class="k">${esc(p.id)}</span>
        <span class="v"><span class="tag ${esc(p.status)}">${esc(p.status)}</span></span></div>`).join('')
    : '<div class="empty">没有加载任何插件</div>';
}

function tile(label, value, unit) {
  return `<div class="stat"><div class="stat-label">${esc(label)}</div>
    <div class="stat-value">${esc(value)}<span class="stat-unit">${esc(unit ?? '')}</span></div></div>`;
}

function renderDetail(detail) {
  if (!detail || typeof detail !== 'object') return '';
  return Object.entries(detail)
    .filter(([k, v]) => v != null && k !== 'payload' && typeof v !== 'object')
    .slice(0, 5)
    .map(([k, v]) => `<div><span>${esc(k)}</span><span>${esc(String(v))}</span></div>`)
    .join('');
}

// ============================================================ 全链路追踪

async function renderTraces() {
  const q = $('#trace-q').value.trim();
  const route = $('#trace-route').value;
  const params = new URLSearchParams({ limit: '200' });
  if (q) params.set('q', q);
  if (route) params.set('route', route);

  const d = await api(`/api/traces?${params}`);
  $('#trace-count').textContent = `缓冲 ${d.total}/${d.capacity} 条，命中 ${d.items.length} 条`;

  $('#trace-list').innerHTML = d.items.length
    ? d.items.map((t) => `
        <div class="trace-item ${t.correlationId === state.selectedTrace ? 'selected' : ''}" data-id="${esc(t.correlationId)}">
          <div class="trace-top">
            <span class="tag ${esc(t.route ?? t.status)}">${esc(t.route ?? t.status)}</span>
            <span class="trace-meta">${fmtMs(t.totalMs)}</span>
          </div>
          <div class="trace-text">${esc(t.displayName ?? '?')}: ${esc(t.text || '(空)')}</div>
          <div class="trace-meta">${fmtTime(t.createdAt)} · ${esc(t.correlationId.slice(0, 8))} · ${t.spanCount} span</div>
        </div>`).join('')
    : '<p class="empty">没有匹配的消息。给 Bridge 发一条消息，或用「离线沙箱」造一条。</p>';

  $$('#trace-list .trace-item').forEach((el) => {
    el.onclick = () => { state.selectedTrace = el.dataset.id; renderTraces(); };
  });

  if (state.selectedTrace) await renderTraceDetail(state.selectedTrace);
}

async function renderTraceDetail(id) {
  let d;
  try {
    d = await api(`/api/traces/${encodeURIComponent(id)}`);
  } catch (err) {
    $('#trace-detail').innerHTML = `<p class="empty">${esc(err.message)}</p>`;
    return;
  }
  const t = d.trace;
  const maxMs = Math.max(1, ...t.timeline.map((s) => s.elapsedMs));

  const ctxRows = (t.context?.blocks ?? []).map((b) => `
    <tr>
      <td class="mono">${esc(b.source)}</td><td>${esc(b.slot)}</td>
      <td class="num">${b.priority}</td><td class="num">${b.chars}</td>
      <td class="mono">${esc(b.truncatedReason ?? '—')}</td>
    </tr>`).join('');

  const ctxBlockTexts = (t.context?.blocks ?? []).map((b) => `
    <details><summary>${esc(b.source)} · ${esc(b.slot)} · P${b.priority} · ${b.chars} 字符${b.truncatedReason ? ` · <span style="color:var(--warn)">${esc(b.truncatedReason)}</span>` : ''}</summary>
      <pre class="code">${esc(b.text ?? b.preview ?? '(空块)')}</pre>
      ${(b.text ?? '').length < b.chars ? '<p class="hint">正文超长，仅保留前 4000 字符。</p>' : ''}
    </details>`).join('');

  const dropped = (t.context?.dropped ?? []).map((x) =>
    `<div><span class="k">${esc(x.source)}</span><span class="v">${esc(x.reason)}</span></div>`).join('');

  const p = t.prompt;

  $('#trace-detail').innerHTML = `
    <h3>${esc(t.displayName ?? '?')} · <span class="tag ${esc(t.decision?.route ?? t.status)}">${esc(t.decision?.route ?? t.status)}</span></h3>
    <div class="kv-list">
      <div><span class="k">correlationId</span><span class="v mono">${esc(t.correlationId)}</span></div>
      <div><span class="k">messageId</span><span class="v mono">${esc(t.messageId ?? '—')}</span></div>
      <div><span class="k">sessionId</span><span class="v mono">${esc(t.sessionId ?? '—')}</span></div>
      <div><span class="k">裁决理由</span><span class="v mono">${esc(t.decision?.reason ?? '—')}</span></div>
      <div><span class="k">触发类型</span><span class="v mono">${esc(t.decision?.triggerType ?? '—')}</span></div>
      <div><span class="k">全程耗时</span><span class="v mono">${fmtMs(t.totalMs)}</span></div>
    </div>

    <h3 style="margin-top:16px">生命周期时序</h3>
    <ul class="timeline">
      ${t.timeline.map((s) => `
        <li class="${esc(s.category)}">
          <span class="t-offset">+${s.offsetMs}ms</span>
          <span class="t-name">${esc(s.name)}
            <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, (s.elapsedMs / maxMs) * 100)}%"></div></div>
          </span>
          <span class="t-ms">${s.elapsedMs}ms${
            s.inclusiveMs !== s.elapsedMs ? ` <span style="color:var(--text-faint)">(含内层 ${s.inclusiveMs})</span>` : ''
          }</span>
        </li>`).join('')}
    </ul>

    <h3 style="margin-top:16px">Context 分配明细</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>来源</th><th>Slot</th><th class="num">优先级</th><th class="num">字符</th><th>截断原因</th></tr></thead>
      <tbody>${ctxRows || '<tr><td colspan="5" class="empty">本轮没有注入上下文块</td></tr>'}</tbody>
    </table></div>
    <p class="hint" style="margin-top:6px">预算 ${t.contextBudget.usedChars} / ${t.contextBudget.totalCharacterBudget} 字符（单来源上限 ${t.contextBudget.perSourceCharacterBudget}）</p>
    ${ctxBlockTexts ? `<details open><summary>各块注入正文 (${(t.context?.blocks ?? []).length})</summary>${ctxBlockTexts}</details>` : ''}
    ${dropped ? `<details><summary>被丢弃/截断的块 (${(t.context?.dropped ?? []).length})</summary><div class="kv-list">${dropped}</div></details>` : ''}

    <h3 style="margin-top:16px">最终注入 Prompt</h3>
    ${p ? `
      <div class="kv-list">
        <div><span class="k">模型</span><span class="v mono">${esc(p.model ?? '—')}</span></div>
        <div><span class="k">消息条数</span><span class="v mono">${esc(p.messageCount ?? '—')}</span></div>
        <div><span class="k">System 长度</span><span class="v mono">${p.systemTextChars} 字符</span></div>
        <div><span class="k">User 长度</span><span class="v mono">${p.userMessageChars} 字符</span></div>
      </div>
      <p class="hint" style="margin:6px 0">以下就是模型实际收到的文本。</p>
      <details open><summary>System Prompt（${p.systemTextChars} 字符${p.truncated ? '，超长已截断' : ''}）</summary>
        <pre class="code">${esc(p.systemText || '(空)')}</pre></details>
      <details><summary>User 消息（${p.userMessageChars} 字符${p.truncated ? '，超长已截断' : ''}）</summary>
        <pre class="code">${esc(p.userMessage || '(空)')}</pre></details>
    ` : '<p class="empty">本轮没有记录注入 prompt（LLM 未被调用，或记录发生在旧版本运行期间）。</p>'}

    <details><summary>原始 JSON</summary><pre class="code">${esc(JSON.stringify(t, null, 2))}</pre></details>`;
}

// ============================================================ 离线沙箱

async function initSandbox() {
  const d = await api('/api/sandbox/defaults');
  $('#sb-user').value = d.sample.userId;
  $('#sb-note').innerHTML =
    `当前模式 <b>${esc(d.mode)}</b>；沙箱<b>永不</b>接触 Sender，组装出的 Payload 仅供查看。<br>`
    + `Middleware 顺序：<span class="mono">${d.middlewareOrder.join(' → ')}</span>`;

  const syncType = () => {
    const isGroup = $('#sb-type').value === 'group';
    $('#sb-group-wrap').style.display = isGroup ? '' : 'none';
    $('#sb-at-wrap').style.display = isGroup ? '' : 'none';
  };
  $('#sb-type').onchange = syncType;
  syncType();
}

async function runSandbox(event) {
  event.preventDefault();
  const btn = $('#sb-run');
  btn.disabled = true;
  btn.textContent = '执行中…';
  $('#sandbox-result').innerHTML = '<p class="empty">正在跑管线…</p>';

  try {
    const d = await api('/api/sandbox/run', {
      method: 'POST',
      body: {
        messageType: $('#sb-type').value,
        groupId: $('#sb-group').value,
        userId: $('#sb-user').value,
        nickname: $('#sb-nick').value,
        text: $('#sb-text').value,
        isAtBot: $('#sb-at').checked,
        callModel: $('#sb-callmodel').checked,
        mockReply: $('#sb-mock').value,
        runFinalPass: $('#sb-final').checked,
      },
    });
    renderSandboxResult(d);
    toast(d.ok ? `执行完成，用时 ${fmtMs(d.elapsedMs)}` : '消息在规范化阶段被丢弃');
  } catch (err) {
    $('#sandbox-result').innerHTML = `<p class="empty">执行失败：${esc(err.message)}</p>`;
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '单步执行';
  }
}

function renderSandboxResult(d) {
  if (!d.ok) {
    $('#sandbox-result').innerHTML = `
      <h3>已在 <span class="tag error">${esc(d.droppedAt)}</span> 阶段丢弃</h3>
      <div class="kv-list"><div><span class="k">原因</span><span class="v mono">${esc(d.droppedReason)}</span></div></div>
      <p class="hint">${esc(d.note ?? '')}</p>
      <details><summary>构造出的 NapCat 原始事件</summary><pre class="code">${esc(JSON.stringify(d.rawEvent, null, 2))}</pre></details>`;
    return;
  }

  const steps = d.steps.map((s) =>
    `<div><span class="k">${esc(s.name)}</span><span class="v">${
      s.ok ? `<span class="tag ok">${s.elapsedMs}ms</span>` : `<span class="tag error">${esc(s.error)}</span>`
    }</span></div>`).join('');

  const ctxBlocks = d.context.blocks.map((b) => `
    <details><summary>${esc(b.source)} · ${esc(b.slot)} · P${b.priority} · ${b.chars} 字符${
      b.truncatedReason ? ` · <span style="color:var(--warn)">${esc(b.truncatedReason)}</span>` : ''
    }</summary><pre class="code">${esc(b.text)}</pre></details>`).join('');

  const segments = d.segments.map((s) => `
    <details ${s.index === 0 ? 'open' : ''}>
      <summary>第 ${s.index + 1} 段${s.skipped ? ' · <span style="color:var(--text-faint)">被丢弃（处理后为空）</span>' : ''}${
        s.attachments.length ? ` · ${s.attachments.length} 个附件` : ''
      }</summary>
      <p class="hint">Middleware 处理前：</p><pre class="code">${esc(s.before)}</pre>
      <p class="hint">Middleware 处理后：</p><pre class="code">${esc(s.after)}</pre>
      ${s.attachments.length ? `<p class="hint">附件（CQ 码）：</p><pre class="code">${esc(s.attachments.join('\n'))}</pre>` : ''}
      <p class="hint">最终 NapCat Payload：</p><pre class="code">${esc(JSON.stringify(s.napcatPayload, null, 2))}</pre>
      ${s.suppressedSideEffects.length
        ? `<p class="hint">被抑制的副作用：</p><pre class="code">${esc(JSON.stringify(s.suppressedSideEffects, null, 2))}</pre>` : ''}
    </details>`).join('');

  $('#sandbox-result').innerHTML = `
    <h3>执行结果 · ${fmtMs(d.elapsedMs)} · <span class="tag ${esc(d.decision.route)}">${esc(d.decision.route)}</span></h3>
    ${d.note ? `<p class="hint">${esc(d.note)}</p>` : ''}

    <h3 style="margin-top:14px">① Inbound 规范化</h3>
    <div class="kv-list">
      <div><span class="k">sessionId</span><span class="v mono">${esc(d.inbound.sessionId)}</span></div>
      <div><span class="k">executionKey</span><span class="v mono">${esc(d.inbound.executionKey)}</span></div>
      <div><span class="k">text</span><span class="v mono">${esc(d.inbound.text)}</span></div>
      <div><span class="k">content（送模型）</span><span class="v mono">${esc(d.inbound.content)}</span></div>
      <div><span class="k">flags</span><span class="v mono">${esc(
        Object.entries(d.inbound.flags).filter(([, v]) => v === true).map(([k]) => k).join(', ') || '(无)'
      )}</span></div>
    </div>

    <h3 style="margin-top:14px">② 裁决</h3>
    <div class="kv-list">
      <div><span class="k">route</span><span class="v"><span class="tag ${esc(d.decision.route)}">${esc(d.decision.route)}</span></span></div>
      <div><span class="k">reason</span><span class="v mono">${esc(d.decision.reason)}</span></div>
      <div><span class="k">triggerType</span><span class="v mono">${esc(d.decision.triggerType ?? '—')}</span></div>
      <div><span class="k">providerId</span><span class="v mono">${esc(d.decision.providerId ?? '(无 Provider，走兜底)')}</span></div>
    </div>

    <h3 style="margin-top:14px">③ 上下文（${d.context.blocks.length} 块 / ${d.context.stats?.charsRendered ?? 0} 字符）</h3>
    ${ctxBlocks || '<p class="hint">本轮没有注入任何上下文块</p>'}

    <h3 style="margin-top:14px">④ 注入的 System Prompt（${d.prompt.systemTextChars} 字符）</h3>
    <pre class="code">${esc(d.prompt.systemText || '(空)')}</pre>
    <details><summary>User 消息（${d.prompt.userMessageChars} 字符）</summary><pre class="code">${esc(d.prompt.userMessage)}</pre></details>

    <h3 style="margin-top:14px">⑤ 模型回复 · ${esc(d.reply?.source ?? '—')}</h3>
    <pre class="code">${esc(d.reply?.rawText ?? '(未生成)')}</pre>

    <h3 style="margin-top:14px">⑥ 切句 + Middleware（${d.segments.length} 段）</h3>
    ${segments || '<p class="hint">没有产出任何分段</p>'}

    ${d.finalPass ? `<h3 style="margin-top:14px">⑦ 收尾轮</h3><p class="hint">${esc(d.finalPass.note)}</p>
      <pre class="code">${esc(JSON.stringify(d.finalPass.suppressedSideEffects, null, 2))}</pre>` : ''}

    <details style="margin-top:14px"><summary>各阶段耗时</summary><div class="kv-list">${steps}</div></details>
    <details><summary>构造出的 NapCat 原始事件</summary><pre class="code">${esc(JSON.stringify(d.rawEvent, null, 2))}</pre></details>`;
}

// ============================================================ 影子对比

async function renderShadow() {
  const files = await api('/api/shadow/files');
  const select = $('#shadow-file');
  const previous = select.value;
  select.innerHTML = `<option value="memory">当前进程内存 (${files.inMemoryEntries} 条)</option>`
    + files.files.map((f) => `<option value="${esc(f.name)}">${esc(f.name)} · ${fmtBytes(f.sizeBytes)}</option>`).join('');
  if (previous) select.value = previous;

  $('#shadow-hint').textContent = files.enabled
    ? `影子模式开启，正在写入 ${files.currentFile ?? '—'}`
    : '影子模式未开启（mode 不是 shadow），只能查看历史文件';

  await loadShadowReport();
}

async function loadShadowReport() {
  const file = $('#shadow-file').value || 'memory';
  const d = await api(`/api/shadow/report?file=${encodeURIComponent(file)}`);

  $('#shadow-tiles').innerHTML = [
    tile('v2 裁决', d.v2.decisions, '条'),
    tile('生成回复', d.v2.replies, '次'),
    tile('平均耗时', d.v2.avgLatencyMs, 'ms'),
    tile('上下文截断', d.v2.contextTruncations, '次'),
    tile('抑制的副作用', d.sideEffects.suppressed, '次'),
    tile('旧日志行', d.legacy.lines, '条'),
  ].join('');

  $('#shadow-table tbody').innerHTML = d.diffs.length
    ? d.diffs.slice(0, 300).map((r) => `
        <tr>
          <td class="mono">${fmtTime(r.at)}</td>
          <td class="mono">${esc(String(r.correlationId ?? '').slice(0, 8))}</td>
          <td><span class="tag ${esc(r.v2Decision ?? 'received')}">${esc(r.v2Decision ?? '—')}</span></td>
          <td><span class="tag ${esc(r.oldBridgeDecision ?? 'received')}">${esc(r.oldBridgeDecision ?? '待对账')}</span></td>
          <td>${r.match == null ? '<span class="tag received">未回填</span>'
            : r.match ? '<span class="tag ok">一致</span>' : '<span class="tag error">不一致</span>'}</td>
          <td class="mono">${esc(r.v2Reason ?? '—')}</td>
          <td class="num">${r.segments ?? '—'}</td>
          <td class="num">${r.latencyMs != null ? fmtMs(r.latencyMs) : '—'}</td>
          <td class="mono">${esc((r.contextSources ?? []).map((s) => `${s.source}(${s.chars})`).join(' '))}</td>
        </tr>`).join('')
    : `<tr><td colspan="9" class="empty">这份对照文件里还没有记录</td></tr>`;

  $('#shadow-diffs').innerHTML = d.intentionalDiffs.map((x) =>
    `<div><span class="k">${esc(x.id)}</span><span class="v">${esc(x.description)}<br>
      <span class="hint">${esc(x.reason)}</span></span></div>`).join('');
}

// ============================================================ 好感度

async function renderAffection() {
  const q = $('#aff-q').value.trim();
  const d = await api(`/api/affection?${new URLSearchParams(q ? { q } : {})}`);

  $('#aff-hint').textContent = `${d.total} 人 · ${
    d.persistEnabled ? '改动会写回 affection.json' : `只读模式（已抑制 ${d.suppressedWrites} 次写入）`
  }`;

  $('#aff-table tbody').innerHTML = d.items.length
    ? d.items.map((u) => {
        const isCold = u.isColdViolent;
        const coldBadge = isCold ? ` <span class="tag error">❄️冷暴力中(${u.coldRemainingMinutes}m)</span>` : '';
        const uniqueBadge = u.is_unique ? ' <span class="tag info">★独占</span>' : '';
        return `
        <tr>
          <td class="mono">${esc(u.uid)}${u.isOwner ? ' <span class="tag info">主人</span>' : ''}${coldBadge}</td>
          <td>${esc(u.nickname)}</td>
          <td class="num">${u.affection}</td>
          <td class="mono" style="color:var(--accent)">${esc(u.bar)}</td>
          <td>${esc(u.relationship)}${uniqueBadge}</td>
          <td><button class="btn mini ghost btn-view-profile" data-uid="${esc(u.uid)}">🔍 查看画像</button></td>
          <td class="num">${u.interactions}</td>
          <td class="mono">${u.lastChange
            ? `${u.lastChange.delta > 0 ? '+' : ''}${u.lastChange.delta} ${esc(u.lastChange.reason)}<br>
               <span class="hint">${fmtTime(u.lastChange.ts)}</span>` : '—'}</td>
          <td>${u.isOwner ? '<span class="hint">恒 100</span>'
            : `<button class="btn mini" data-uid="${esc(u.uid)}" data-aff="${u.affection}">调整</button>
               <button class="btn mini ${isCold ? 'ok' : 'ghost'}" data-cold-uid="${esc(u.uid)}" data-is-cold="${isCold ? '1' : '0'}">${isCold ? '解除冷暴力' : '❄️冷暴力'}</button>`}</td>
        </tr>`;
      }).join('')
    : `<tr><td colspan="9" class="empty">没有匹配的用户</td></tr>`;

  $$('#aff-table button[data-uid]').forEach((btn) => {
    btn.onclick = () => adjustAffection(btn.dataset.uid, btn.dataset.aff);
  });

  $$('#aff-table button[data-cold-uid]').forEach((btn) => {
    btn.onclick = async () => {
      const uid = btn.dataset.coldUid;
      const isCold = btn.dataset.isCold === '1';
      const action = isCold ? 'lift' : 'trigger';
      try {
        await api('/api/affection/cold_violence', { method: 'POST', body: { uid, action, durationMinutes: 60 } });
        toast(isCold ? `已解除 ${uid} 的冷暴力` : `已对 ${uid} 施加 60 分钟冷暴力`);
        await renderAffection();
      } catch (err) {
        toast(err.message, true);
      }
    };
  });

  $$('#aff-table .btn-view-profile').forEach((btn) => {
    btn.onclick = () => {
      $('#portrayal-q').value = btn.dataset.uid;
      switchView('portrayal');
    };
  });
}

// ============================================================ 群友画像

let portrayalActiveTab = 'cards'; // 'cards' | 'tracked'

async function renderPortrayal() {
  const q = $('#portrayal-q')?.value?.trim() ?? '';
  const d = await api(`/api/portrayal?${new URLSearchParams(q ? { q } : {})}`);
  $('#portrayal-hint').textContent = `已生成画像 ${d.total} 人 · 已收纳发言群友 ${d.totalTracked} 人`;
  $('#portrayal-count-ready').textContent = d.total;
  $('#portrayal-count-tracked').textContent = d.totalTracked;

  const cardsContainer = $('#portrayal-cards');
  const tableWrap = $('#portrayal-tracked-wrap');
  const tabCardsBtn = $('#portrayal-tab-cards');
  const tabTrackedBtn = $('#portrayal-tab-tracked');

  if (tabCardsBtn && tabTrackedBtn) {
    tabCardsBtn.onclick = () => {
      portrayalActiveTab = 'cards';
      tabCardsBtn.className = 'btn btn-sm primary';
      tabTrackedBtn.className = 'btn btn-sm ghost';
      cardsContainer.style.display = 'grid';
      tableWrap.style.display = 'none';
    };
    tabTrackedBtn.onclick = () => {
      portrayalActiveTab = 'tracked';
      tabTrackedBtn.className = 'btn btn-sm primary';
      tabCardsBtn.className = 'btn btn-sm ghost';
      cardsContainer.style.display = 'none';
      tableWrap.style.display = 'block';
    };
  }

  // 1. 渲染画像卡片网格
  if (cardsContainer) {
    cardsContainer.innerHTML = d.items.length
      ? d.items.map((p) => {
          const avatarUrl = `https://q4.qlogo.cn/headimg_dl?dst_uin=${esc(p.uid)}&spec=100`;
          const tagBadges = (p.tags || []).map((t) => `<span class="tag info" style="font-size:11.5px; margin-right:4px; margin-bottom:4px;">${esc(t)}</span>`).join('');
          const msgStat = `📊 已收纳发言: <b style="color:var(--accent)">${p.totalMsgCount || 0}</b> 条`;
          const nextDelta = (p.totalMsgCount || 0) - (p.lastMsgCountAtAnalysis || 0);
          const nextHint = p.needsAutoAnalysis ? '<span class="tag ok">就绪可分析</span>' : `<span class="hint">增量 ${nextDelta}/50</span>`;

          return `
          <div class="card panel" style="display:flex; flex-direction:column; gap:10px; padding:16px; border-radius:8px; background:var(--bg-card); border:1px solid var(--border);">
            <div style="display:flex; align-items:center; gap:12px;">
              <img src="${avatarUrl}" alt="${esc(p.nickname)}" style="width:48px; height:48px; border-radius:50%; border:2px solid var(--accent); background:#1a1c23;" onerror="this.src='/logo.png'">
              <div style="flex:1; overflow:hidden;">
                <div style="font-weight:600; font-size:15px; color:#fff; white-space:nowrap; text-overflow:ellipsis; overflow:hidden;">${esc(p.nickname || p.uid)}</div>
                <div class="mono hint" style="font-size:12px;">QQ: ${esc(p.uid)}</div>
              </div>
            </div>
            <div style="font-size:12px; display:flex; justify-content:space-between; align-items:center; background:#12151d; padding:6px 10px; border-radius:6px; border:1px solid rgba(255,255,255,0.05);">
              <span>${msgStat}</span>
              <span>${nextHint}</span>
            </div>
            <div>
              <div style="display:flex; flex-wrap:wrap; margin-top:2px;">${tagBadges || '<span class="hint">暂无标签</span>'}</div>
            </div>
            <div style="font-size:13px; color:var(--text-main); line-height:1.5;">
              <b>📝 行为简述:</b> ${esc(p.summary || '暂无描述')}
            </div>
            ${p.taboos ? `<div style="font-size:12.5px; color:#f87171; line-height:1.4;"><b>⚡ 沟通雷区:</b> ${esc(p.taboos)}</div>` : ''}
            ${p.suggestion ? `<div style="font-size:12.5px; color:#38bdf8; line-height:1.4;"><b>💡 相处建议:</b> ${esc(p.suggestion)}</div>` : ''}
            <div style="margin-top:auto; padding-top:8px; border-top:1px solid rgba(255,255,255,0.06); display:flex; justify-content:space-between; align-items:center;">
              <button class="btn mini ghost btn-view-msgs" data-uid="${esc(p.uid)}" data-name="${esc(p.nickname || p.uid)}">📜 查阅发言</button>
              <div style="display:flex; gap:6px;">
                <button class="btn mini ghost btn-del btn-del-portrayal" data-uid="${esc(p.uid)}" data-name="${esc(p.nickname || p.uid)}" title="删除此画像与收纳记录">🗑️</button>
                <button class="btn mini primary btn-retag-portrayal" data-uid="${esc(p.uid)}" data-name="${esc(p.nickname || p.uid)}">🔄 重新分析</button>
              </div>
            </div>
          </div>`;
        }).join('')
      : '<p class="empty" style="grid-column:1/-1;">暂无群友画像记录，或未匹配到关键词</p>';
  }

  // 2. 渲染已收纳发言群友池表格
  const tableBody = $('#portrayal-tracked-table tbody');
  if (tableBody) {
    const trackedList = d.trackedUsers || [];
    tableBody.innerHTML = trackedList.length
      ? trackedList.map((u) => `
        <tr>
          <td class="mono">${esc(u.uid)}</td>
          <td>${esc(u.nickname)}</td>
          <td class="num font-bold" style="color:var(--accent);">${u.totalMsgCount}</td>
          <td class="num">${u.lastMsgCountAtAnalysis}</td>
          <td>${u.hasProfile ? '<span class="tag ok">已有画像</span>' : '<span class="tag warn">尚未画像</span>'} ${u.needsAutoAnalysis ? '<span class="tag info">已达分析门槛</span>' : ''}</td>
          <td class="mono hint">${u.lastSeen ? fmtTime(u.lastSeen) : '—'}</td>
          <td>
            <button class="btn mini ghost btn-view-msgs" data-uid="${esc(u.uid)}" data-name="${esc(u.nickname)}">📜 查阅发言</button>
            <button class="btn mini primary btn-retag-portrayal" data-uid="${esc(u.uid)}" data-name="${esc(u.nickname)}">✨ 立即分析</button>
            <button class="btn mini ghost btn-del btn-del-portrayal" data-uid="${esc(u.uid)}" data-name="${esc(u.nickname)}" title="清除此用户的发言收纳记录">🗑️ 清除</button>
          </td>
        </tr>`).join('')
      : '<tr><td colspan="7" class="empty">暂无已收纳发言的群友记录</td></tr>';
  }

  // 绑定一键清理无画像收纳按钮
  const clearUnprofiledBtn = $('#portrayal-clear-unprofiled-btn');
  if (clearUnprofiledBtn) {
    clearUnprofiledBtn.onclick = async () => {
      if (!confirm('确定要清理所有未生成画像的群友收纳缓存吗？（已有画像的群友不受影响）')) return;
      try {
        const res = await api('/api/portrayal/clear-unprofiled', { method: 'POST' });
        toast(`✅ 已清理 ${res.cleared} 位群友的无用收纳缓存`);
        renderPortrayal();
      } catch (err) {
        toast(`清理失败: ${err.message}`, true);
      }
    };
  }

  // 绑定删除单个群友画像/收纳记录
  $$('.btn-del-portrayal').forEach((btn) => {
    btn.onclick = async () => {
      const uid = btn.dataset.uid;
      const name = btn.dataset.name;
      if (!confirm(`确定要删除【${name} (QQ: ${uid})】的发言收纳与画像记录吗？`)) return;
      try {
        await api(`/api/portrayal/${uid}`, { method: 'DELETE' });
        toast(`已删除【${name}】的记录`);
        renderPortrayal();
      } catch (err) {
        toast(`删除失败: ${err.message}`, true);
      }
    };
  });

  // 绑定查阅历史发言事件
  $$('.btn-view-msgs').forEach((btn) => {
    btn.onclick = async () => {
      const uid = btn.dataset.uid;
      const name = btn.dataset.name;
      try {
        const res = await api(`/api/portrayal/messages/${uid}`);
        if (!res.messages || !res.messages.length) {
          alert(`【${name}】暂无在内存滑窗中保留的历史发言文本。`);
          return;
        }
        alert(`【${name} (ID: ${uid}) 最近收纳的发言记录】(共 ${res.messages.length} 条):\n\n` + res.messages.join('\n'));
      } catch (err) {
        toast(`查阅发言失败: ${err.message}`, true);
      }
    };
  });

  // 绑定重新分析事件
  $$('.btn-retag-portrayal').forEach((btn) => {
    btn.onclick = async () => {
      const uid = btn.dataset.uid;
      const nickname = btn.dataset.name;
      btn.disabled = true;
      btn.textContent = '⏳分析中...';
      try {
        const res = await api('/api/portrayal/trigger', { method: 'POST', body: { uid, nickname } });
        if (res.ok) {
          toast(`✅ 【${nickname}】画像分析完成！`);
          renderPortrayal();
        } else {
          toast(`分析失败: ${res.error || '未知错误'}`, true);
        }
      } catch (err) {
        toast(`分析异常: ${err.message}`, true);
      } finally {
        btn.disabled = false;
        btn.textContent = '🔄 重新分析';
      }
    };
  });
}

async function adjustAffection(uid, current) {
  const raw = prompt(`把 ${uid} 的好感度设为（当前 ${current}，范围 0-90）：`, current);
  if (raw == null) return;
  const value = Number(raw);
  if (!Number.isFinite(value)) return toast('请输入数字', true);
  const reason = prompt('变更理由（会写进 recentDeltas，便于日后追溯）：', '管理员手动调整') ?? '管理员手动调整';

  try {
    const d = await api('/api/affection/adjust', { method: 'POST', body: { uid, affection: value, reason } });
    toast(`${uid}: ${d.from} → ${d.to} · ${d.note}`);
    await renderAffection();
  } catch (err) {
    toast(err.message, true);
  }
}

// ============================================================ 表情包

let editingMemeId = null;

async function renderMemes() {
  const q = $('#meme-q').value.trim();
  const d = await api(`/api/memes?${new URLSearchParams(q ? { q } : {})}`);
  $('#meme-hint').textContent = `${d.total} 张（可用 ${d.usable}，失效 ${d.broken}）`;

  $('#meme-grid').innerHTML = d.items.length
    ? d.items.map((m) => {
        const showBadge = m.category && m.category !== m.tag;
        return `
        <div class="meme-card ${m.usable ? '' : 'broken'}" id="meme-card-${esc(m.id)}">
          ${m.pathOk ? `<img loading="lazy" src="${esc(m.imageUrl)}" alt="${esc(m.tag)}">`
            : '<div style="height:136px;display:grid;place-items:center;color:var(--crit);font-size:12px;background:#0b0d13;">文件缺失</div>'}
          <div class="meme-body">
            <div class="meme-header">
              <div class="meme-tag" title="${esc(m.tag || m.name)}">${esc(m.tag || m.name)}</div>
              ${showBadge ? `<span class="meme-cat-badge">${esc(m.category)}</span>` : ''}
            </div>
            <div class="meme-ref" data-ref="${esc(m.reference)}" title="点击复制代码">${esc(m.reference)}</div>
            ${m.keywords?.length ? `<div class="meme-kw" title="${esc(m.keywords.join(' / '))}">${esc(m.keywords.slice(0, 3).join(' / '))}${m.keywords.length > 3 ? '…' : ''}</div>` : ''}
            <div class="meme-desc" title="${esc(m.description || '暂无语境描述')}">${esc(m.description || '（暂无语境描述）')}</div>
            <div class="meme-actions">
              <button class="btn btn-sm ghost btn-meme-retag" data-id="${esc(m.id)}" title="调用视觉大模型重新识别画面打标">🔄 识别</button>
              <button class="btn btn-sm ghost btn-meme-edit" data-id="${esc(m.id)}" title="编辑分类、标签、关键词与描述">✏️ 编辑</button>
              <button class="btn btn-sm ghost btn-del btn-meme-del" data-id="${esc(m.id)}" title="彻底删除该表情包">🗑️</button>
            </div>
          </div>
        </div>`;
      }).join('')
    : '<p class="empty">图库为空，或过滤条件没有命中任何表情包</p>';

  // 绑定复制
  $$('#meme-grid .meme-ref').forEach((el) => {
    el.onclick = async () => {
      try {
        await navigator.clipboard.writeText(el.dataset.ref);
        toast(`已复制 ${el.dataset.ref}`);
      } catch { toast('复制失败，请手动选中', true); }
    };
  });

  // 绑定 AI 重新打标
  $$('#meme-grid .btn-meme-retag').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      const oldText = btn.textContent;
      btn.disabled = true;
      btn.textContent = '⏳打标中...';
      try {
        const res = await api('/api/memes/retag', { method: 'POST', body: { id } });
        if (res.ok) {
          toast(`✅ AI 打标完成：${res.item.tag}`);
          renderMemes();
        } else {
          toast(`打标失败: ${res.error || '未知错误'}`, true);
        }
      } catch (e) {
        toast(`打标异常: ${e.message}`, true);
      } finally {
        btn.disabled = false;
        btn.textContent = oldText;
      }
    };
  });

  // 绑定删除
  $$('#meme-grid .btn-meme-del').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      if (!confirm('确定要彻底删除该表情包吗？（将同时删除本地文件与索引）')) return;
      try {
        const res = await api('/api/memes/delete', { method: 'POST', body: { id } });
        if (res.ok) {
          toast('🗑️ 表情包已删除');
          renderMemes();
        } else {
          toast(`删除失败: ${res.error}`, true);
        }
      } catch (e) {
        toast(`删除异常: ${e.message}`, true);
      }
    };
  });

  // 绑定编辑
  $$('#meme-grid .btn-meme-edit').forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.id;
      const meme = d.items.find((x) => x.id === id);
      if (!meme) return;
      editingMemeId = id;
      $('#meme-edit-ref').value = meme.reference;
      $('#meme-edit-category').value = meme.category || '';
      $('#meme-edit-tag').value = meme.tag || '';
      $('#meme-edit-keywords').value = (meme.keywords || []).join(', ');
      $('#meme-edit-desc').value = meme.description || '';
      $('#meme-edit-preview').src = meme.imageUrl;
      $('#meme-edit-modal').style.display = 'flex';
    };
  });
}

// 模态框关闭与保存
$('#meme-edit-close').onclick = () => { $('#meme-edit-modal').style.display = 'none'; };
$('#meme-edit-cancel').onclick = () => { $('#meme-edit-modal').style.display = 'none'; };
$('#meme-edit-save').onclick = async () => {
  if (!editingMemeId) return;
  const category = $('#meme-edit-category').value.trim();
  const tag = $('#meme-edit-tag').value.trim();
  const keywords = $('#meme-edit-keywords').value.trim();
  const description = $('#meme-edit-desc').value.trim();

  try {
    const res = await api('/api/memes/update', {
      method: 'POST',
      body: {
        id: editingMemeId,
        category,
        tag,
        keywords,
        description,
      },
    });
    if (res.ok) {
      toast('💾 表情包修改已保存');
      $('#meme-edit-modal').style.display = 'none';
      renderMemes();
    } else {
      toast(`保存失败: ${res.error}`, true);
    }
  } catch (e) {
    toast(`保存异常: ${e.message}`, true);
  }
};

async function testMemeTag() {
  const tag = $('#meme-tag').value.trim();
  if (!tag) return toast('先输入一个 Tag', true);

  try {
    const d = await api(`/api/memes/search?tag=${encodeURIComponent(tag)}`);
    $('#meme-test-result').innerHTML = `
      <div class="panel" style="margin-bottom:14px">
        <h3>检索「${esc(tag)}」的结果</h3>
        ${d.picked ? `
          <div style="display:flex;gap:14px;align-items:flex-start">
            <img src="${esc(d.picked.imageUrl)}" style="width:128px;height:128px;object-fit:contain;background:#0b0d13;border-radius:8px">
            <div class="kv-list" style="flex:1">
              <div><span class="k">命中</span><span class="v mono">${esc(d.picked.id)}</span></div>
              <div><span class="k">引用写法</span><span class="v mono">${esc(d.pickedReference)}</span></div>
              <div><span class="k">Tag / 分类</span><span class="v">${esc(d.picked.tag)} / ${esc(d.picked.category)}</span></div>
              <div><span class="k">关键词</span><span class="v">${esc(d.picked.keywords.join(', '))}</span></div>
            </div>
          </div>` : '<p class="empty">没有命中任何可用表情包</p>'}
        <p class="hint" style="margin-top:8px">${esc(d.note)}</p>
        ${d.candidates.length ? `<details><summary>候选 ${d.candidates.length} 个（按打分）</summary>
          <div class="kv-list">${d.candidates.map((c) =>
            `<div><span class="k">${esc(c.id)}</span><span class="v">${esc(c.tag ?? '')} · 得分 ${c.score}</span></div>`).join('')}
          </div></details>` : ''}
      </div>`;
  } catch (err) {
    toast(err.message, true);
  }
}

// ============================================================ 世界书

// 展示用默认值。只在求值时使用，绝不把它们写回原生 JSON。
const LB_FIELDS = [
  // —— 常用字段 ——
  ['comment', '标题 / 注释', 'text', '', null, 'basic'],
  ['key', '主关键词（每行一项）', 'list', [], null, 'basic'],
  ['keysecondary', '次关键词（每行一项）', 'list', [], null, 'basic'],
  ['content', '正文', 'textarea', '', null, 'basic'],
  ['constant', '蓝灯常驻', 'bool', false, null, 'basic'],
  ['disable', '禁用条目', 'bool', false, null, 'basic'],
  ['group', '互斥分组', 'text', '', null, 'basic'],
  ['order', 'Order 排序', 'number', 100, null, 'basic'],
  // —— 高级 / 原生兼容字段 ——
  ['selective', '启用次关键词条件', 'bool', true, null, 'advanced'],
  ['selectiveLogic', '次关键词逻辑', 'select', 0, [[0, 'AND ANY'], [1, 'NOT ALL'], [2, 'NOT ANY'], [3, 'AND ALL']], 'advanced'],
  ['groupOverride', '分组优先覆盖', 'bool', false, null, 'advanced'],
  ['groupWeight', '分组权重', 'number', 100, null, 'advanced'],
  ['position', '原生位置', 'select', 0, [[0, '角色定义前'], [1, '角色定义后'], [2, '作者注释前'], [3, '作者注释后'], [4, '深度 @D'], [5, '示例前'], [6, '示例后'], [7, 'Outlet']], 'advanced'],
  ['depth', '深度 depth', 'number', 4, null, 'advanced'],
  ['role', '原生角色', 'select', 0, [[0, 'System'], [1, 'User'], [2, 'Assistant']], 'advanced'],
  ['outletName', 'Outlet 名称', 'text', '', null, 'advanced'],
  ['probability', '概率 %', 'number', 100, null, 'advanced'],
  ['useProbability', '使用概率', 'bool', true, null, 'advanced'],
  ['scanDepth', '扫描深度（空 = 全局）', 'nullableNumber', null, null, 'advanced'],
  ['caseSensitive', '区分大小写', 'tri', null, null, 'advanced'],
  ['matchWholeWords', '整词匹配', 'tri', null, null, 'advanced'],
  ['useGroupScoring', '分组评分', 'tri', null, null, 'advanced'],
  ['sticky', 'Sticky 持续轮数（空 = 默认）', 'nullableNumber', null, null, 'advanced'],
  ['cooldown', 'Cooldown 冷却轮数（空 = 默认）', 'nullableNumber', null, null, 'advanced'],
  ['delay', 'Delay 延迟轮数（空 = 默认）', 'nullableNumber', null, null, 'advanced'],
  ['delayUntilRecursion', '递归延迟步骤', 'number', 0, null, 'advanced'],
  ['excludeRecursion', '不由递归触发', 'bool', false, null, 'advanced'],
  ['preventRecursion', '阻止触发后续递归', 'bool', false, null, 'advanced'],
  ['ignoreBudget', '忽略引擎预算', 'bool', false, null, 'advanced'],
  ['vectorized', '原生向量标记', 'bool', false, null, 'advanced'],
  ['addMemo', '附加注释标记', 'bool', false, null, 'advanced'],
  ...['matchPersonaDescription', 'matchCharacterDescription', 'matchCharacterPersonality', 'matchCharacterDepthPrompt', 'matchScenario', 'matchCreatorNotes']
    .map((key) => [key, `扫描 ${key}`, 'bool', false, null, 'advanced']),
  ['automationId', 'Automation ID', 'text', '', null, 'advanced'],
  ['characterFilterNames', '角色名称过滤（每行一项）', 'list', [], null, 'advanced'],
  ['characterFilterTags', '角色标签过滤（每行一项）', 'list', [], null, 'advanced'],
  ['characterFilterExclude', '排除匹配角色', 'bool', false, null, 'advanced'],
  ['triggers', '触发类型（每行一项）', 'list', [], null, 'advanced'],
];
const LB_SETTINGS = [
  ['enabled', '世界书总开关', 'bool', true],
  ['scanDepth', '扫描深度', 'number', 2],
  ['recursive', '递归扫描', 'bool', true],
  ['maxRecursionSteps', '最大递归步骤', 'number', 8],
  ['budgetTokens', 'Token 预算', 'number', 2048],
  ['caseSensitive', '区分大小写', 'bool', false],
  ['matchWholeWords', '整词匹配', 'bool', false],
  ['useGroupScoring', '分组评分', 'bool', false],
];

const LB_TIPS = {
  constant: '蓝灯：不需要关键词命中，每轮都可能注入；仍受禁用、概率、分组、预算和时效约束。',
  selective: '只控制次关键词门禁，不是“是否启用”。关掉后仍需要主关键词命中。',
  position: '存储兼容：不决定插入位置，命中正文统一进入本轮 user 顶部资料块。',
  depth: '存储兼容：不按深度插入历史，只保留原生数值。',
  role: '存储兼容：不创建独立角色的消息，实际始终随 user 注入。',
  outletName: '存储兼容：不输出 outlet，正文仍进入同一资料块。',
  vectorized: '原样保存；当前没有向量 provider，不会因为这个标志单独激活。',
  ignoreBudget: '只绕过引擎正文挑选预算；最终完整前置块仍有第二道字节预算。',
};

const lore = {
  books: [],
  bookId: null,
  entries: [],
  selected: new Set(),
  editing: null,
  initial: '',
  changed: new Set(),
  invalid: new Set(),
  settingsDirty: false,
  busy: false,
  loading: false,
  stats: new Map(),
  load: 0,
  pendingImport: null,
  booksOpen: false,
};

const loreById = (id) => $('#' + id);

async function loreApi(action, body, query = '') {
  const result = await api(`/api/host/lorebooks/${action}${query}`, body === undefined ? undefined : { method: 'POST', body });
  if (result.ok === false) throw new Error(result.error || '世界书请求失败');
  return result;
}

// 所有事件异常都在这里收口：包括原生 JSON 解析、文件读取和网络错误。
async function loreAction(fn) {
  if (lore.busy) return;
  lore.busy = true;
  updateLoreControls();
  try { await fn(); }
  catch (e) {
    setLoreStatus(`操作失败：${e.message}`, 'err');
    toast(e.message, true);
  }
  finally {
    lore.busy = false;
    updateLoreControls();
  }
}

function setLoreStatus(text, kind = '') {
  const el = $('#lb-status');
  el.textContent = text;
  el.classList.remove('err', 'ok');
  if (kind) el.classList.add(kind);
}

function currentLoreBook() {
  return lore.books.find((b) => b.id === lore.bookId) || null;
}

function updateLoreControls() {
  const noBook = lore.bookId == null;
  const busy = lore.busy;
  for (const id of ['lb-create', 'lb-import', 'lb-settings-open', 'lb-book-new-save']) {
    loreById(id).disabled = busy;
  }
  for (const id of ['lb-enabled', 'lb-rename', 'lb-delete', 'lb-export', 'lb-new', 'lb-rename-save']) {
    loreById(id).disabled = busy || noBook;
  }
  for (const id of ['lb-batch-on', 'lb-batch-off', 'lb-batch-delete']) {
    loreById(id).disabled = busy || noBook || !lore.selected.size;
  }
  loreById('lb-save').disabled = busy || noBook;
  loreById('lb-entry-delete').disabled = busy || lore.editing == null;
  loreById('lb-import-confirm').disabled = busy || !lore.pendingImport;
  loreById('lb-export-download').disabled = busy || noBook;
  loreById('lb-export-copy').disabled = busy || noBook;
}

// 批量操作后必须显式清空勾选：否则已删条目仍留在 Set 里，批量栏会显示过期的“已选 N”。
function clearLoreSelection() {
  lore.selected.clear();
  loreById('lb-select-all').checked = false;
  loreById('lb-select-all').indeterminate = false;
}

function loreDirty() {
  return !$('#lb-editor').hidden && ($('#lb-raw').value !== lore.initial || lore.invalid.size > 0);
}

function discardLore() {
  return !loreDirty() || confirm('条目有未保存修改，确定放弃？');
}

function updateDirtyBadge() {
  $('#lb-dirty-badge').hidden = !loreDirty();
}

function closeLoreEditor() {
  $('#lb-editor').hidden = true;
  $('#lb-app').classList.remove('has-editor');
  lore.editing = null;
  lore.invalid.clear();
  $('#lb-json-error').textContent = '';
  updateDirtyBadge();
}

function setBooksDrawer(open) {
  lore.booksOpen = Boolean(open);
  $('#lb-books-panel').classList.toggle('is-open', lore.booksOpen);
  $('#lb-books-scrim').hidden = !lore.booksOpen;
}

function openDialog(id) {
  const dialog = loreById(id);
  if (typeof dialog?.showModal === 'function') {
    if (!dialog.open) dialog.showModal();
  } else if (dialog) {
    dialog.hidden = false;
  }
}

function closeDialog(id) {
  const dialog = loreById(id);
  if (typeof dialog?.close === 'function') {
    if (dialog.open) dialog.close();
  } else if (dialog) {
    dialog.hidden = true;
  }
}

// ------------------------------------------------------------ 字段渲染

function loreFieldMarkup([key, label, type, fallback, choices], prefix) {
  const id = `${prefix}${key}`;
  const span = type === 'textarea' ? ' span-2' : '';
  const tip = LB_TIPS[key] ? `<span class="field-help">${esc(LB_TIPS[key])}</span>` : '';
  if (type === 'bool') {
    return `<label class="field field-check${span}" for="${id}"><input id="${id}" type="checkbox"><span class="field-label">${esc(label)}</span>${LB_TIPS[key] ? `<span class="field-help">${esc(LB_TIPS[key])}</span>` : ''}</label>`;
  }
  let control;
  if (type === 'select' || type === 'tri') {
    const options = type === 'tri' ? [['', '继承全局'], ['true', '是'], ['false', '否']] : choices;
    control = `<select id="${id}">${options.map(([value, text]) => `<option value="${value}">${esc(text)}</option>`).join('')}</select>`;
  } else if (type === 'list' || type === 'textarea') {
    control = `<textarea id="${id}" rows="${type === 'list' ? 3 : 7}"></textarea>`;
  } else {
    const numeric = type.includes('Number') || type === 'number';
    const step = ['probability', 'groupWeight'].includes(key) ? 'any' : '1';
    control = `<input id="${id}" type="${numeric ? 'number' : 'text'}"${numeric ? ` step="${step}"` : ''}>`;
  }
  return `<label class="field${span}" for="${id}"><span class="field-label">${esc(label)} <code>${esc(key)}</code></span>${control}${tip}</label>`;
}

function fillLoreFields(fields, raw, prefix) {
  for (const [key, , type, fallback] of fields) {
    const el = loreById(prefix + key);
    const value = raw[key] ?? fallback;
    if (type === 'bool') el.checked = Boolean(value);
    else {
      const text = type === 'list' ? (Array.isArray(value) ? value.join('\n') : String(value)) : value ?? '';
      // 原生未来的枚举值原样显示，不静默改写成默认值。
      if (type === 'select' && ![...el.options].some((o) => o.value === String(text))) {
        const option = document.createElement('option');
        option.value = String(text);
        option.textContent = `原生值 ${text}`;
        el.appendChild(option);
      }
      el.value = String(text);
    }
  }
}

function readLoreField([key, , type], prefix) {
  const el = loreById(prefix + key);
  if (type === 'bool') return el.checked;
  if (type === 'tri') return el.value === '' ? null : el.value === 'true';
  if (type === 'list') return el.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (type === 'nullableNumber' && el.value.trim() === '') return null;
  if (type === 'number' || type === 'nullableNumber' || type === 'select') {
    const value = Number(el.value);
    if (!el.value.trim() || !Number.isFinite(value)) throw new Error(`${key} 必须是有限数字`);
    if (!['probability', 'groupWeight'].includes(key) && !Number.isSafeInteger(value)) throw new Error(`${key} 必须是整数`);
    return value;
  }
  return el.value;
}

// ------------------------------------------------------------ 原生 JSON 安全通道

// JSON numbers outside Number's safe integer range must never pass through
// JSON.parse/stringify as Numbers. Match strings first so numeric-looking text
// (including escaped quotes) stays text. The marker cannot collide with input.
function parseLoreJson(text) {
  // Validate before token replacement (e.g. invalid leading zeroes), and also
  // check decoded strings so escaped marker-like text cannot collide.
  const decoded = JSON.stringify(JSON.parse(text));
  let marker = '__lore_number__';
  while (text.includes(marker) || decoded.includes(marker)) marker += '_';
  const protectedText = text.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (token) => {
    if (token[0] === '"' || !/^-?\d+$/.test(token) || Number.isSafeInteger(Number(token))) return token;
    return JSON.stringify(marker + token);
  });
  return JSON.parse(protectedText, (key, value) => typeof value === 'string' && value.startsWith(marker)
    ? BigInt(value.slice(marker.length)) : value);
}

function stringifyLoreJson(value, space) {
  if (value === undefined) return undefined;
  // Pick a marker absent from every ordinary string before replacing BigInts.
  let marker = '__lore_number__';
  const strings = JSON.stringify(value, (key, item) => typeof item === 'bigint' ? null : item);
  while (strings.includes(marker)) marker += '_';
  const text = JSON.stringify(value, (key, item) => typeof item === 'bigint' ? marker + item : item, space);
  return text.replace(new RegExp('"' + marker + '(-?\\d+)"', 'g'), '$1');
}

function parseLoreRaw() {
  const raw = parseLoreJson($('#lb-raw').value);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('条目 JSON 必须是对象');
  if (lore.editing != null && Object.hasOwn(raw, 'uid') && raw.uid !== lore.editing) throw new Error('uid 不可更改；请新建条目');
  return raw;
}

function trackLoreChanges(raw) {
  const original = parseLoreJson(lore.initial || '{}');
  lore.changed.clear();
  for (const key of new Set([...Object.keys(original), ...Object.keys(raw)])) {
    if (stringifyLoreJson(original[key]) !== stringifyLoreJson(raw[key])) lore.changed.add(key);
  }
}

function syncLoreRaw() {
  try {
    const raw = parseLoreRaw();
    fillLoreFields(LB_FIELDS, raw, 'lb-field-');
    trackLoreChanges(raw);
    lore.invalid.clear();
    $('#lb-json-error').textContent = '';
    updateDirtyBadge();
    return true;
  } catch (e) {
    $('#lb-json-error').textContent = e.message;
    return false;
  }
}

function applyLoreField(field) {
  const el = loreById('lb-field-' + field[0]);
  try {
    const raw = parseLoreRaw();
    raw[field[0]] = readLoreField(field, 'lb-field-');
    $('#lb-raw').value = stringifyLoreJson(raw, 2);
    trackLoreChanges(raw);
    lore.invalid.delete(field[0]);
    $('#lb-json-error').textContent = lore.invalid.size ? '请修正无效字段，或重新编辑 JSON。' : '';
    el.closest?.('.field')?.classList.remove('invalid');
  } catch (e) {
    lore.invalid.add(field[0]);
    $('#lb-json-error').textContent = e.message;
    el.closest?.('.field')?.classList.add('invalid');
  }
  updateDirtyBadge();
}

// ------------------------------------------------------------ 列表与编辑

function openLoreEditor(entry) {
  if (lore.busy || !discardLore()) return;
  const book = currentLoreBook();
  lore.editing = entry?.uid ?? null;
  lore.invalid.clear();
  $('#lb-raw').value = entry?.entryText ?? JSON.stringify(entry?.raw ?? {}, null, 2);
  lore.initial = $('#lb-raw').value;
  $('#lb-editor-title').textContent = entry ? `条目 #${entry.uid}` : '新建条目';
  $('#lb-editor-sub').textContent = entry
    ? `${book?.name ?? ''} · uid ${entry.uid}${entry.raw?.comment ? ` · ${entry.raw.comment}` : ''}`
    : `${book?.name ?? ''} · 保存后分配 uid`;
  $('#lb-editor').hidden = false;
  $('#lb-app').classList.add('has-editor');
  $('#lb-json-error').textContent = '';
  syncLoreRaw();
  updateDirtyBadge();
  updateLoreControls();
  $('#lb-editor-body')?.scrollTo?.({ top: 0 });
  setBooksDrawer(false);
}

function filteredLoreEntries() {
  const q = $('#lb-q').value.trim().toLowerCase();
  const group = $('#lb-group').value.trim().toLowerCase();
  const active = $('#lb-active').value;
  return lore.entries.filter(({ raw }) => {
    const keys = [...(Array.isArray(raw.key) ? raw.key : []), ...(Array.isArray(raw.keysecondary) ? raw.keysecondary : [])];
    const text = [raw.comment, raw.content, ...keys].join(' ').toLowerCase();
    return text.includes(q)
      && String(raw.group ?? '').toLowerCase().includes(group)
      && (active === 'all' || (active === 'off') === Boolean(raw.disable));
  }).sort((a, b) => {
    const ao = Number.isFinite(Number(a.raw.order)) ? Number(a.raw.order) : 100;
    const bo = Number.isFinite(Number(b.raw.order)) ? Number(b.raw.order) : 100;
    const dir = $('#lb-sort').value === 'asc' ? 1 : -1;
    return (dir * (ao - bo)) || a.uid - b.uid;
  });
}

function loreRowMarkup({ uid, raw }) {
  const keys = Array.isArray(raw.key) ? raw.key.filter((k) => typeof k === 'string' && k.trim()) : [];
  const chips = keys.slice(0, 3).map((k) => `<span class="key-chip" title="${esc(k)}">${esc(k)}</span>`).join('')
    + (keys.length > 3 ? `<span class="key-more">+${keys.length - 3}</span>` : '');
  const constant = Boolean(raw.constant);
  const disabled = Boolean(raw.disable);
  const order = Number.isFinite(Number(raw.order)) ? Number(raw.order) : 100;
  const lampClass = `${constant ? 'blue lb-constant' : 'green lb-keyword'}${disabled ? ' lb-disabled' : ''}`;
  const lampTitle = constant ? '蓝灯 · 常驻：无需关键词命中（点击改为绿灯）' : '绿灯 · 关键词：命中主关键词后注入（点击改为蓝灯）';
  return `<tr class="lb-row${disabled ? ' is-disabled' : ''}" data-lb-row="${uid}">
    <td class="c-check"><input type="checkbox" data-lb-select="${uid}" aria-label="选择条目 ${uid}"${lore.selected.has(uid) ? ' checked' : ''}></td>
    <td class="c-lamp"><button type="button" class="lamp ${lampClass}" data-lb-mode="${uid}" title="${lampTitle}" aria-label="${constant ? '常驻，点击改为关键词' : '关键词，点击改为常驻'}"></button></td>
    <td class="c-name"><button type="button" class="lb-name" data-lb-open="${uid}">
      <span class="lb-name-text">${esc(raw.comment || `条目 #${uid}`)}</span>
      <span class="lb-name-sub">#${uid}${keys.length ? ` · ${keys.length} 关键词` : ''}${raw.content ? ` · ${String(raw.content).length} 字符` : ''}</span>
    </button></td>
    <td class="c-keys">${chips || '<span class="key-more">—</span>'}</td>
    <td class="c-group">${esc(raw.group || '—')}</td>
    <td class="c-order"><span class="order-step">
      <button type="button" data-lb-move="-1" data-lb-uid="${uid}" title="上移（提高 order）" aria-label="上移条目 ${uid}">▴</button>
      <span class="order-val">${order}</span>
      <button type="button" data-lb-move="1" data-lb-uid="${uid}" title="下移（降低 order）" aria-label="下移条目 ${uid}">▾</button>
    </span></td>
    <td class="c-state"><button type="button" class="state-btn${disabled ? ' off' : ''}" data-lb-active="${uid}" role="switch" aria-checked="${!disabled}" title="${disabled ? '点击启用' : '点击禁用'}">${disabled ? '停用' : '启用'}</button></td>
  </tr>`;
}

function bindLoreRowEvents() {
  $$('[data-lb-select]').forEach((el) => {
    el.onchange = () => {
      const uid = Number(el.dataset.lbSelect);
      if (el.checked) lore.selected.add(uid); else lore.selected.delete(uid);
      renderLoreEntries();
    };
  });
  $$('[data-lb-open]').forEach((el) => {
    el.onclick = () => openLoreEditor(lore.entries.find((e) => e.uid === Number(el.dataset.lbOpen)));
  });
  $$('[data-lb-mode]').forEach((el) => {
    el.onclick = () => toggleLoreFlag(Number(el.dataset.lbMode), 'constant');
  });
  $$('[data-lb-active]').forEach((el) => {
    el.onclick = () => toggleLoreFlag(Number(el.dataset.lbActive), 'disable');
  });
  $$('[data-lb-move]').forEach((el) => {
    el.onclick = () => moveLoreEntry(Number(el.dataset.lbUid), Number(el.dataset.lbMove));
  });
}

function renderLoreEntries() {
  const items = filteredLoreEntries();
  $('#lb-count').textContent = lore.loading
    ? '正在载入…'
    : `${items.length} / ${lore.entries.length} 条 · 已选 ${lore.selected.size}`;
  $('#lb-select-all').checked = items.length > 0 && items.every((e) => lore.selected.has(e.uid));
  $('#lb-select-all').indeterminate = items.some((e) => lore.selected.has(e.uid)) && !$('#lb-select-all').checked;

  let body;
  if (lore.loading) {
    body = Array.from({ length: 5 }, () => '<tr class="lb-row lb-skeleton"><td colspan="7"><span class="skel-line"></span></td></tr>').join('');
  } else if (!lore.bookId) {
    body = `<tr class="lb-empty-row"><td colspan="7"><p class="lb-empty">${lore.books.length ? '从左侧选择一本世界书。' : '还没有世界书。点击左上角 ＋ 新建，或从 JSON 导入一本。'}</p></td></tr>`;
  } else if (!items.length) {
    const filtered = lore.entries.length > 0;
    body = `<tr class="lb-empty-row"><td colspan="7"><p class="lb-empty">${filtered ? '没有匹配的条目。清空搜索或筛选条件试试。' : '这本书还是空的。点击「＋ 新条目」开始，或导入原生 JSON。'}</p></td></tr>`;
  } else {
    body = items.map(loreRowMarkup).join('');
  }

  $('#lb-entries').innerHTML = body;
  if (!lore.loading) bindLoreRowEvents();
  updateLoreControls();
}

function loreStats(entries) {
  return {
    entries: entries.length,
    active: entries.filter((e) => !e.raw?.disable).length,
    constant: entries.filter((e) => e.raw?.constant).length,
  };
}

// 列表接口只给条目总数；启用数按书惰性读取一次并缓存，避免每次渲染都 N+1。
async function prefetchBookStats(books) {
  for (const book of books) {
    if (Number(book.entry_count) === 0 && !lore.stats.has(book.id)) {
      lore.stats.set(book.id, { entries: 0, active: 0, constant: 0 });
    }
  }
  const missing = books.filter((b) => b.id !== lore.bookId && !lore.stats.has(b.id) && Number(b.entry_count) > 0);
  for (let i = 0; i < missing.length; i += 3) {
    await Promise.all(missing.slice(i, i + 3).map(async (book) => {
      try {
        const result = await loreApi('get', undefined, `?bookId=${encodeURIComponent(book.id)}`);
        const entries = result.entries ?? [];
        lore.stats.set(book.id, loreStats(Array.isArray(entries) ? entries : []));
      } catch {
        // 统计失败不影响主流程；列表仍显示条目总数。
      }
    }));
  }
}

function renderLoreBookList() {
  $('#lb-books-count').textContent = lore.books.length
    ? `${lore.books.length} 本 · ${lore.books.reduce((n, b) => n + (Number(b.entry_count) || 0), 0)} 条条目`
    : '还没有世界书';
  $('#lb-books').innerHTML = lore.books.map((b) => {
    const stat = lore.stats.get(b.id);
    const entries = stat ? stat.entries : (Number(b.entry_count) || 0);
    const state = b.enabled === false ? '整本停用' : '已启用';
    const active = stat ? `${stat.active} 启用` : (entries ? '…' : '0 启用');
    return `<button class="lb-book${b.id === lore.bookId ? ' is-active' : ''}" data-lb-book="${esc(b.id)}"${b.id === lore.bookId ? ' aria-current="true"' : ''} title="${esc(b.name)} · ${state}${stat ? ` · ${stat.constant} 常驻` : ''}">
      <span class="lb-book-name">${esc(b.name)}</span>
      <span class="lb-book-state ${b.enabled === false ? '' : 'on'}" title="${state}"></span>
      <span class="lb-book-stats">${entries} 条 · ${active}</span>
    </button>`;
  }).join('') || '<p class="lb-book-empty">还没有世界书。<br>新建一本，或导入原生 JSON。</p>';
  $$('[data-lb-book]').forEach((el) => {
    el.onclick = () => selectLoreBook(Number(el.dataset.lbBook));
  });
}

function renderLoreHeader() {
  const book = currentLoreBook();
  const enabled = lore.entries.filter((e) => !e.raw?.disable).length;
  const constant = lore.entries.filter((e) => e.raw?.constant).length;
  $('#lb-book-title').textContent = book?.name ?? '未选择世界书';
  $('#lb-book-meta').textContent = book
    ? `${lore.entries.length} 条条目 · ${enabled} 启用 · ${constant} 常驻`
    : '选择或新建一本世界书';
  $('#lb-enabled').checked = book ? book.enabled !== false : false;
  $('#lb-enabled').disabled = !book || lore.busy;
  updateLoreControls();
}

async function loadLoreBook(bookId) {
  const generation = ++lore.load;
  lore.bookId = bookId;
  lore.entries = [];
  lore.selected.clear();
  lore.loading = bookId != null;
  closeLoreEditor();
  renderLoreHeader();
  renderLoreEntries();
  if (bookId == null) {
    setLoreStatus(lore.books.length ? '选择左侧世界书开始编辑。' : '尚无世界书，请新建或导入 JSON。');
    return;
  }
  try {
    const result = await loreApi('get', undefined, `?bookId=${encodeURIComponent(bookId)}`);
    if (generation !== lore.load) return;
    const entries = result.entries ?? result.book?.entries ?? [];
    lore.entries = Array.isArray(entries) ? entries : Object.entries(entries).map(([uid, raw]) => ({ uid: Number(uid), raw }));
    lore.stats.set(bookId, loreStats(lore.entries));
    const listed = lore.books.find((b) => b.id === bookId);
    if (listed) listed.entry_count = lore.entries.length;
    lore.loading = false;
    renderLoreHeader();
    renderLoreEntries();
    renderLoreBookList();
    setLoreStatus(`已载入「${result.book.name}」`, 'ok');
  } catch (e) {
    if (generation === lore.load) {
      lore.bookId = null;
      lore.loading = false;
      renderLoreHeader();
      renderLoreEntries();
      setLoreStatus(`载入失败：${e.message}`, 'err');
    }
    throw e;
  }
}

async function reloadLoreBooks(preferred = lore.bookId) {
  const result = await loreApi('list');
  lore.books = result.books || [];
  const chosen = lore.books.find((b) => String(b.id) === String(preferred)) || lore.books[0];
  await loadLoreBook(chosen?.id ?? null);
  await prefetchBookStats(lore.books);
  renderLoreBookList();
}

async function selectLoreBook(bookId) {
  setBooksDrawer(false);
  if (lore.busy || bookId === lore.bookId) return;
  if (!discardLore()) return;
  await loreAction(async () => {
    await loadLoreBook(bookId);
    renderLoreBookList();
  });
}

async function toggleLoreFlag(uid, field) {
  const entry = lore.entries.find((e) => e.uid === uid);
  if (!entry) return;
  await loreAction(async () => {
    if (!discardLore()) return;
    await loreApi('entry', { bookId: lore.bookId, entry: { uid, [field]: !entry.raw[field] } });
    closeLoreEditor();
    await loadLoreBook(lore.bookId);
  });
}

async function moveLoreEntry(uid, direction) {
  const items = filteredLoreEntries();
  const index = items.findIndex((e) => e.uid === uid);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= items.length) return;
  const neighbor = items[target];
  const base = Number.isFinite(Number(neighbor.raw.order)) ? Number(neighbor.raw.order) : 100;
  const desc = $('#lb-sort').value !== 'asc';
  const order = desc === (direction < 0) ? base + 1 : base - 1;
  await loreAction(async () => {
    await loreApi('entry', { bookId: lore.bookId, entry: { uid, order } });
    await loadLoreBook(lore.bookId);
  });
}

// ------------------------------------------------------------ 书级操作

function showNewBookForm(show) {
  $('#lb-book-new').hidden = !show;
  if (show) {
    $('#lb-book-new-name').value = '';
    $('#lb-book-new-name').focus?.();
  }
}

function showRenameForm(show) {
  const book = currentLoreBook();
  $('#lb-rename-row').hidden = !show;
  if (show && book) {
    $('#lb-rename-input').value = book.name;
    $('#lb-rename-input').focus?.();
    $('#lb-rename-input').select?.();
  }
}

async function createLoreBook() {
  const name = $('#lb-book-new-name').value.trim();
  if (!name) { $('#lb-book-new-name').focus?.(); return; }
  await loreAction(async () => {
    const result = await loreApi('create', { name, enabled: true });
    showNewBookForm(false);
    await reloadLoreBooks(result.book.id);
    toast(`已创建「${name}」`);
  });
}

// ------------------------------------------------------------ 导入 / 导出 / 设置

function closeSettings() {
  if (lore.settingsDirty && !confirm('世界书设置尚未保存，确定关闭？')) return;
  lore.settingsDirty = false;
  closeDialog('lb-settings-dialog');
}

function resetImport() {
  lore.pendingImport = null;
  $('#lb-import-name').value = '';
  $('#lb-import-preview').innerHTML = '<p class="hint">尚未选择文件。</p>';
  $('#lb-file').value = '';
  updateLoreControls();
}

function sanitizeFileName(name) {
  return String(name || 'lorebook').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '') || 'lorebook';
}

function exportFileName() {
  const typed = $('#lb-export-name').value.trim() || `${currentLoreBook()?.name ?? 'lorebook'}.json`;
  const base = sanitizeFileName(typed.replace(/\.json$/i, ''));
  return `${base}.json`;
}

// ------------------------------------------------------------ 绑定

function bindLorebooks() {
  $('#lb-entry-fields').innerHTML = LB_FIELDS.filter((f) => f[5] === 'basic').map((f) => loreFieldMarkup(f, 'lb-field-')).join('');
  $('#lb-entry-advanced').innerHTML = LB_FIELDS.filter((f) => f[5] === 'advanced').map((f) => loreFieldMarkup(f, 'lb-field-')).join('');
  $('#lb-settings-fields').innerHTML = LB_SETTINGS.map((f) => loreFieldMarkup(f, 'lb-setting-')).join('');

  for (const field of LB_FIELDS) {
    loreById('lb-field-' + field[0]).onchange = () => applyLoreField(field);
  }
  for (const [key] of LB_SETTINGS) {
    loreById('lb-setting-' + key).onchange = () => { lore.settingsDirty = true; };
  }

  $('#lb-raw').oninput = () => { syncLoreRaw(); updateDirtyBadge(); };
  for (const id of ['lb-q', 'lb-group']) loreById(id).oninput = renderLoreEntries;
  for (const id of ['lb-active', 'lb-sort']) loreById(id).onchange = renderLoreEntries;

  $('#lb-select-all').onchange = () => {
    const checked = $('#lb-select-all').checked;
    for (const entry of filteredLoreEntries()) {
      if (checked) lore.selected.add(entry.uid); else lore.selected.delete(entry.uid);
    }
    renderLoreEntries();
  };

  $('#lb-new').onclick = () => { if (lore.bookId != null) openLoreEditor(null); };
  $('#lb-cancel').onclick = () => { if (!lore.busy && discardLore()) closeLoreEditor(); };
  $('#lb-close').onclick = () => { if (!lore.busy && discardLore()) closeLoreEditor(); };

  $('#lb-book-new-save').onclick = createLoreBook;
  $('#lb-book-new-cancel').onclick = () => showNewBookForm(false);
  $('#lb-book-new-name').onkeydown = (e) => { if (e.key === 'Enter') createLoreBook(); };
  $('#lb-create').onclick = () => { if (!lore.busy) showNewBookForm($('#lb-book-new').hidden); };

  $('#lb-rename').onclick = () => { if (!lore.busy && lore.bookId != null) showRenameForm(true); };
  $('#lb-rename-cancel').onclick = () => showRenameForm(false);
  $('#lb-rename-save').onclick = () => loreAction(async () => {
    const name = $('#lb-rename-input').value.trim();
    if (!name) throw new Error('世界书名称不能为空');
    await loreApi('update', { bookId: lore.bookId, name });
    showRenameForm(false);
    await reloadLoreBooks(lore.bookId);
    toast('已重命名');
  });

  $('#lb-enabled').onchange = () => loreAction(async () => {
    const enabled = $('#lb-enabled').checked;
    try {
      await loreApi('update', { bookId: lore.bookId, enabled });
      const book = currentLoreBook();
      if (book) book.enabled = enabled;
      renderLoreBookList();
      renderLoreHeader();
      setLoreStatus(enabled ? `已启用「${book?.name ?? ''}」` : `已停用「${book?.name ?? ''}」`, 'ok');
    } catch (e) {
      $('#lb-enabled').checked = !enabled;
      throw e;
    }
  });

  $('#lb-delete').onclick = () => loreAction(async () => {
    const book = currentLoreBook();
    if (!book || !discardLore()) return;
    if (!confirm(`永久删除世界书「${book.name}」及其全部条目？`)) return;
    await loreApi('delete', { bookId: book.id });
    await reloadLoreBooks(null);
    toast(`已删除「${book.name}」`);
  });

  $('#lb-save').onclick = () => loreAction(async () => {
    const raw = parseLoreRaw();
    if (lore.invalid.size) throw new Error(`无效字段：${[...lore.invalid].join(', ')}`);
    trackLoreChanges(raw);
    // API 递归合并补丁：只发送显式编辑过的字段，绝不把展示默认值写进原生 JSON。
    if (lore.editing != null && !lore.changed.size) { closeLoreEditor(); return; }
    const original = parseLoreJson(lore.initial);
    function checkRemoved(before, after) {
      for (const key of Object.keys(before)) {
        if (!Object.hasOwn(after, key)) throw new Error('接口合并 JSON，不能删除已有字段；请改为空值或保留原字段。');
        if (before[key] && after[key] && typeof before[key] === 'object' && typeof after[key] === 'object'
          && !Array.isArray(before[key]) && !Array.isArray(after[key])) checkRemoved(before[key], after[key]);
      }
    }
    checkRemoved(original, raw);
    const entry = lore.editing == null ? raw : Object.fromEntries([...lore.changed].map((key) => [key, raw[key]]));
    if (lore.editing != null) entry.uid = lore.editing;
    const entryText = stringifyLoreJson(entry);
    // 旧客户端/宿主仍接受对象补丁；含非安全整数时必须走文本通道。
    let hasLargeInteger = false;
    JSON.stringify(entry, (key, value) => {
      if (typeof value === 'bigint') { hasLargeInteger = true; return null; }
      return value;
    });
    await loreApi('entry', { bookId: lore.bookId, ...(hasLargeInteger ? { entryText } : { entry }) });
    closeLoreEditor();
    await loadLoreBook(lore.bookId);
    toast('条目已保存');
  });

  $('#lb-entry-delete').onclick = () => loreAction(async () => {
    if (lore.editing == null) return;
    if (!confirm(`永久删除条目 #${lore.editing}？`)) return;
    const uid = lore.editing;
    await loreApi('entry-delete', { bookId: lore.bookId, uid });
    closeLoreEditor();
    await loadLoreBook(lore.bookId);
    toast(`已删除条目 #${uid}`);
  });

  for (const [id, enabled] of [['lb-batch-on', true], ['lb-batch-off', false]]) {
    loreById(id).onclick = () => loreAction(async () => {
      if (!lore.selected.size || !discardLore()) return;
      await loreApi('selection', { bookId: lore.bookId, uids: [...lore.selected], enabled });
      await loadLoreBook(lore.bookId);
      toast(enabled ? '已批量启用' : '已批量禁用');
    });
  }

  $('#lb-batch-delete').onclick = () => {
    // 按钮在未勾选时是 disabled；这里再拦一次，保证程序化触发也不会静默无反应。
    if (!lore.selected.size) {
      setLoreStatus('请先勾选要删除的条目', 'err');
      toast('请先勾选要删除的条目', true);
      return undefined;
    }
    return loreAction(async () => {
      if (!discardLore()) return;
      const uids = [...lore.selected];
      const bookName = currentLoreBook()?.name ?? '当前世界书';
      if (!confirm(`永久删除「${bookName}」中已勾选的 ${uids.length} 条条目？\n\n此操作不可撤销，删除后无法恢复。`)) return;
      const failed = [];
      // 串行删除：宿主只有一份 SQLite，逐条等回执既不打爆它，也能精确统计失败数。
      for (const uid of uids) {
        try { await loreApi('entry-delete', { bookId: lore.bookId, uid }); }
        catch (e) { failed.push({ uid, message: e.message }); }
      }
      const deleted = uids.length - failed.length;
      clearLoreSelection();
      // 只以宿主返回的列表为准：部分失败时已删条目不会被重新画回来。
      await loadLoreBook(lore.bookId);
      if (!failed.length) {
        setLoreStatus(`已删除 ${deleted} 条条目`, 'ok');
        toast(`已删除 ${deleted} 条条目`);
        return;
      }
      const detail = failed.slice(0, 3).map((f) => `#${f.uid} ${f.message}`).join('；')
        + (failed.length > 3 ? ` 等 ${failed.length} 条` : '');
      setLoreStatus(`已删除 ${deleted} 条，${failed.length} 条删除失败（${detail}）`, 'err');
      toast(`已删除 ${deleted} 条，${failed.length} 条失败：${detail}`, true);
    });
  };

  // 导入
  $('#lb-import').onclick = () => { if (!lore.busy) { resetImport(); openDialog('lb-import-dialog'); } };
  $('#lb-import-close').onclick = () => closeDialog('lb-import-dialog');
  $('#lb-import-cancel').onclick = () => { closeDialog('lb-import-dialog'); resetImport(); };
  $('#lb-file').onchange = () => loreAction(async () => {
    const file = $('#lb-file').files?.[0];
    if (!file) return;
    const dataText = await file.text();
    const fail = (message) => {
      $('#lb-import-preview').innerHTML = `<p class="err">${esc(message)}</p>`;
      throw new Error(message);
    };
    let data;
    try { data = JSON.parse(dataText); }
    catch (e) { fail(`文件不是合法 JSON：${e.message}`); }
    if (!data || typeof data !== 'object' || Array.isArray(data)
      || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) {
      fail('请选择原生 SillyTavern 世界书 JSON（顶层 entries 对象）');
    }
    const count = Object.keys(data.entries).length;
    lore.pendingImport = { dataText, fileName: file.name };
    $('#lb-import-name').value = file.name.replace(/\.json$/i, '');
    const samples = Object.values(data.entries).slice(0, 4)
      .map((e) => e?.comment || (Array.isArray(e?.key) ? e.key[0] : ''))
      .filter(Boolean).map((s) => esc(s));
    $('#lb-import-preview').innerHTML = `<p class="ok">已读取 <strong>${count}</strong> 条条目，导入后新建一本世界书。</p>
      <dl><dt>文件</dt><dd>${esc(file.name)}</dd><dt>条目</dt><dd>${count}</dd>${samples.length ? `<dt>示例</dt><dd>${samples.join(' · ')}</dd>` : ''}</dl>`;
    updateLoreControls();
  });
  $('#lb-import-confirm').onclick = () => loreAction(async () => {
    const pending = lore.pendingImport;
    if (!pending) return;
    const name = $('#lb-import-name').value.trim() || pending.fileName.replace(/\.json$/i, '') || '未命名世界书';
    const result = await loreApi('import', { name, dataText: pending.dataText });
    closeDialog('lb-import-dialog');
    resetImport();
    await reloadLoreBooks(result.book.id);
    toast(`已导入「${name}」`);
  });

  // 导出
  $('#lb-export').onclick = () => {
    if (lore.busy || lore.bookId == null) return;
    $('#lb-export-name').value = `${sanitizeFileName(currentLoreBook()?.name)}.json`;
    $('#lb-export-meta').textContent = `${lore.entries.length} 条条目 · 书级扩展字段一并导出`;
    openDialog('lb-export-dialog');
  };
  $('#lb-export-close').onclick = () => closeDialog('lb-export-dialog');
  $('#lb-export-cancel').onclick = () => closeDialog('lb-export-dialog');
  $('#lb-export-download').onclick = () => loreAction(async () => {
    const result = await loreApi('export', undefined, `?bookId=${encodeURIComponent(lore.bookId)}`);
    const dataText = result.dataText ?? JSON.stringify(result.data, null, 2);
    const blob = new Blob([dataText], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = exportFileName();
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    closeDialog('lb-export-dialog');
    toast('已导出 JSON');
  });
  $('#lb-export-copy').onclick = () => loreAction(async () => {
    const result = await loreApi('export', undefined, `?bookId=${encodeURIComponent(lore.bookId)}`);
    const dataText = result.dataText ?? JSON.stringify(result.data, null, 2);
    if (typeof navigator === 'undefined' || !navigator.clipboard) throw new Error('当前浏览器不支持剪贴板 API');
    await navigator.clipboard.writeText(dataText);
    toast('JSON 已复制到剪贴板');
  });

  // 全局设置
  $('#lb-settings-open').onclick = () => { if (!lore.busy) openDialog('lb-settings-dialog'); };
  $('#lb-settings-close').onclick = closeSettings;
  $('#lb-settings-cancel').onclick = closeSettings;
  $('#lb-settings-save').onclick = () => loreAction(async () => {
    const patch = Object.fromEntries(LB_SETTINGS.map((field) => [field[0], readLoreField(field, 'lb-setting-')]));
    if (Object.values(patch).some((v) => typeof v === 'number' && v < 0)) throw new Error('扫描、递归和预算不能为负数');
    const result = await loreApi('settings', patch);
    fillLoreFields(LB_SETTINGS, result.settings || patch, 'lb-setting-');
    lore.settingsDirty = false;
    closeDialog('lb-settings-dialog');
    toast('世界书设置已保存');
  });

  // 抽屉
  $('#lb-books-toggle').onclick = () => setBooksDrawer(!lore.booksOpen);
  $('#lb-books-scrim').onclick = () => setBooksDrawer(false);
  window.addEventListener('beforeunload', (e) => {
    if (loreDirty() || lore.settingsDirty) { e.preventDefault(); e.returnValue = ''; }
  });

  updateLoreControls();
}

async function renderLorebooks() {
  if (!discardLore()) return;
  await loreAction(async () => {
    lore.loading = true;
    setLoreStatus('正在载入世界书…');
    renderLoreEntries();
    try {
      await reloadLoreBooks();
      const result = await loreApi('settings');
      fillLoreFields(LB_SETTINGS, result.settings || {}, 'lb-setting-');
      lore.settingsDirty = false;
      if (lore.books.length) setLoreStatus(`已载入「${currentLoreBook()?.name ?? ''}」`, 'ok');
    } finally {
      lore.loading = false;
      renderLoreEntries();
    }
  });
}


// ============================================================ 刷新调度

// ============================================================ 客制化设置

let loadedConfigData = null;

async function renderSettings() {
  const d = await api('/api/config');
  loadedConfigData = d.config;

  $('#cfg-file-hint').textContent = `配置文件: ${esc(d.configFile)}`;

  // 1. 身份与唤醒
  $('#cfg-owner-id').value = d.config.identity?.ownerId ?? '';
  $('#cfg-admin-ids').value = (d.config.identity?.adminIds || []).join(', ');
  const commandOptions = $('#cfg-admin-commands');
  commandOptions.replaceChildren();
  for (const command of d.commands || []) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = command.id;
    input.disabled = !command.adminGrantable;
    input.checked = command.adminGrantable && (d.config.identity?.adminCommands || []).includes(command.id);
    label.append(input, document.createTextNode(` ${command.id}${command.adminGrantable ? '' : '（仅主人）'}`));
    commandOptions.append(label);
  }
  $('#cfg-robot-id').value = d.config.identity?.robotId ?? '';
  $('#cfg-bot-name').value = d.config.identity?.botName ?? '';
  $('#cfg-owner-title').value = d.config.identity?.ownerTitle ?? '主人';
  $('#cfg-wake-mode').value = d.config.wake?.mode ?? 'both';
  $('#cfg-wake-pattern').value = d.config.wake?.namePattern ?? '';
  $('#cfg-ratelimit-users').value = (d.config.identity?.rateLimitUsers || []).map(formatRateLimitEntry).filter(Boolean).join(', ');
  $('#cfg-private-whitelist').value = (d.config.identity?.privateWhitelist || []).join(', ');
  $('#cfg-group-whitelist').value = (d.config.identity?.groupWhitelist || []).map(formatGroupRateLimitEntry).filter(Boolean).join(', ');

  // 工具进度播报（总开关同时约束群聊与私聊）
  $('#cfg-tool-progress-enabled').checked = d.config.toolProgress?.enabled === true;
  $('#cfg-tool-progress-show-detail').checked = d.config.toolProgress?.showDetail !== false;
  $('#cfg-tool-progress-private-enabled').checked = d.config.toolProgress?.privateEnabled === true;
  $('#cfg-tool-progress-group-whitelist').value = (d.config.toolProgress?.groupWhitelist || []).join(', ');
  $('#cfg-tool-progress-private-whitelist').value = (d.config.toolProgress?.privateWhitelist || []).join(', ');
  $('#cfg-tool-progress-max-messages').value = d.config.toolProgress?.maxMessagesPerTurn ?? 8;
  $('#cfg-tool-progress-min-interval').value = d.config.toolProgress?.minIntervalMs ?? 1500;

  // 2. 表情包与视觉打标
  $('#cfg-meme-collect').checked = Boolean(d.config.meme?.autoCollect);
  $('#cfg-meme-autotag').checked = Boolean(d.config.meme?.autoAiTagging);
  $('#cfg-meme-vision-url').value = d.config.meme?.visionBaseUrl ?? '';
  $('#cfg-meme-vision-model').value = d.config.meme?.visionModel ?? '';
  $('#cfg-meme-vision-key').value = d.config.meme?.visionKeyMasked ?? '';
  $('#cfg-meme-vision-env').value = d.config.meme?.visionKeyEnv ?? '';
  $('#cfg-meme-vision-key-desc').textContent = d.config.meme?.hasVisionKey
    ? '已配置独立密钥（留空或掩码保持不变）'
    : `未配置独立 Key（优先读取环境变量 ${esc(d.config.meme?.visionKeyEnv || 'CPA_API_KEY')}）`;

  // 2.5 后置表情匹配
  $('#cfg-meme-matcher-enabled').checked = d.config.meme?.matcherEnabled !== false;
  $('#cfg-meme-matcher-url').value = d.config.meme?.matcherBaseUrl ?? '';
  $('#cfg-meme-matcher-model').value = d.config.meme?.matcherModel ?? '';
  $('#cfg-meme-matcher-key').value = d.config.meme?.matcherKeyMasked ?? '';
  $('#cfg-meme-matcher-env').value = d.config.meme?.matcherKeyEnv ?? '';
  $('#cfg-meme-matcher-key-desc').textContent = d.config.meme?.hasMatcherKey
    ? '已配置独立密钥（留空或掩码保持不变）'
    : '未配置独立 Key（回落复用识图密钥）';
  $('#cfg-meme-matcher-url').placeholder = d.config.meme?.matcherEffectiveBaseUrl
    ? `当前生效: ${d.config.meme.matcherEffectiveBaseUrl}`
    : '留空 = 复用上方识图 API';
  $('#cfg-meme-matcher-model').placeholder = d.config.meme?.matcherEffectiveModel
    ? `当前生效: ${d.config.meme.matcherEffectiveModel}`
    : '留空 = 复用上方识图模型';
  $('#cfg-meme-matcher-timeout').value = d.config.meme?.matcherTimeoutMs ?? 10000;
  $('#cfg-meme-matcher-retries').value = d.config.meme?.matcherMaxRetries ?? 2;
  $('#cfg-meme-matcher-candidates').value = d.config.meme?.matcherCandidateCount ?? 10;

  // 4. 群友性格画像
  $('#cfg-portrayal-enabled').checked = d.config.portrayal?.enabled !== false;
  $('#cfg-portrayal-interval').value = d.config.portrayal?.msgInterval ?? 50;
  $('#cfg-portrayal-initial').value = d.config.portrayal?.initialThreshold ?? 20;
  $('#cfg-portrayal-cooldown').value = d.config.portrayal?.cooldownHours ?? 24;
  $('#cfg-portrayal-model').value = d.config.portrayal?.model ?? 'gpt-4o-mini';
  $('#cfg-portrayal-url').value = d.config.portrayal?.baseUrl ?? '';
  $('#cfg-portrayal-env').value = d.config.portrayal?.apiKeyEnv ?? 'HERMES_API_KEY';
  $('#cfg-portrayal-blacklist').value = (d.config.portrayal?.blacklistUsers || []).join(', ');

  // 影子模式（群友说话模仿）
  $('#cfg-shadow-enabled').checked = Boolean(d.config.shadowLearn?.enabled);
  $('#cfg-shadow-inject').value = d.config.shadowLearn?.injectCount ?? 10;
  $('#cfg-shadow-targets').value = (d.config.shadowLearn?.targets || []).join(', ');

  // 4. 主对话模型
  $('#cfg-model-base-url').value = d.config.model?.baseUrl ?? '';
  $('#cfg-model-name').value = d.config.model?.model ?? '';
  $('#cfg-model-key').value = d.config.model?.apiKeyMasked ?? '';
  $('#cfg-model-env').value = d.config.model?.apiKeyEnv ?? '';
  $('#cfg-model-timeout').value = d.config.model?.timeoutMs ?? 1800000;
  $('#cfg-model-cutoff-hour').value = d.config.model?.sessionCutoffHour ?? 7;
  $('#cfg-model-rotations').value = String(d.config.model?.sessionRotationsPerDay ?? 1);
  $('#cfg-model-stream').checked = d.config.model?.stream !== false;
  $('#cfg-model-key-desc').textContent = d.config.model?.hasApiKey
    ? '已配置独立密钥（留空或掩码保持不变）'
    : `未配置独立 Key（优先读取环境变量 ${esc(d.config.model?.apiKeyEnv || 'HERMES_API_KEY')}）`;

  // 4. Fast Ack
  $('#cfg-fastack-enabled').checked = Boolean(d.config.fastAck?.enabled);
  $('#cfg-fastack-msg').value = d.config.fastAck?.message ?? '';
  $('#cfg-fastack-patterns').value = (d.config.fastAck?.patterns || []).join('\n');

  // 5. 接话决策与上下文
  $('#cfg-decision-debounce').value = d.config.decision?.debounceMs ?? 800;
  $('#cfg-decision-window').value = d.config.decision?.rateLimit?.windowMs ?? 300000;
  $('#cfg-decision-max-replies').value = d.config.decision?.rateLimit?.maxReplies ?? 5;
  $('#cfg-decision-ratelimit-private').checked = d.config.decision?.rateLimit?.applyToPrivate === true;
  $('#cfg-decision-window-size').value = d.config.decision?.localWindowSize ?? 15;
  $('#cfg-decision-queue-timeout-enabled').checked = d.config.decision?.queueTimeout?.enabled !== false;
  $('#cfg-decision-queue-timeout-sec').value = Math.round((d.config.decision?.queueTimeout?.timeoutMs ?? 120000) / 1000);
  $('#cfg-decision-queue-timeout-notice').value = d.config.decision?.queueTimeout?.notice
    ?? '⏳ 刚才那条排队太久啦，先舍弃了，有需要的话再叫我一次~';
  $('#cfg-group-rate-limit-notice').value = d.config.decision?.groupRateLimit?.notice
    ?? '瑞姬去休息啦，{minutes}分钟再来找她吧';
  $('#cfg-context-total-budget').value = d.config.context?.totalCharacterBudget ?? 12000;
  $('#cfg-context-source-budget').value = d.config.context?.perSourceCharacterBudget ?? 4000;
  // 默认勾选（＝直挂多模态，旧行为）；只有显式保存成 false 才取消勾选
  $('#cfg-context-direct-parts').checked = d.config.context?.directMediaParts !== false;

  // 6. NapCat 与运行模式
  $('#cfg-mode').value = d.config.mode ?? 'live';
  $('#cfg-log-level').value = d.config.logging?.level ?? 'info';
  $('#cfg-reply-send').checked = Boolean(d.config.reply?.sendEnabled);
  $('#cfg-reply-side-effects').checked = Boolean(d.config.reply?.sideEffectsEnabled);
  $('#cfg-log-bodies').checked = Boolean(d.config.logging?.logMessageBodies);
  $('#cfg-napcat-ws').value = d.config.napcat?.wsUrl ?? '';
  $('#cfg-napcat-http').value = d.config.napcat?.httpUrl ?? '';
  $('#cfg-napcat-token').value = d.config.napcat?.accessTokenMasked ?? '';
  $('#cfg-input-status').checked = d.config.napcat?.inputStatusEnabled !== false;
  $('#cfg-unified-host').value = d.config.unifiedHost?.baseUrl ?? '';
}

async function saveSettings() {
  const saveBtn = $('#cfg-save');
  saveBtn.disabled = true;
  saveBtn.textContent = '💾 正在保存…';

  try {
    const rawRateUsers = $('#cfg-ratelimit-users').value;
    const rateLimitUsers = rawRateUsers
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    const adminIds = $('#cfg-admin-ids').value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    const adminCommands = Array.from(document.querySelectorAll('#cfg-admin-commands input:checked:not(:disabled)'), (input) => input.value);

    const rawPrivateWhitelist = $('#cfg-private-whitelist').value;
    const privateWhitelist = rawPrivateWhitelist
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    const rawGroupWhitelist = $('#cfg-group-whitelist').value;
    const groupWhitelist = rawGroupWhitelist
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    const rawFastAckPatterns = $('#cfg-fastack-patterns').value;
    const fastAckPatterns = rawFastAckPatterns
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    const rawPortrayalBlacklist = $('#cfg-portrayal-blacklist').value;
    const portrayalBlacklist = rawPortrayalBlacklist
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    const rawShadowTargets = $('#cfg-shadow-targets').value;
    const shadowTargets = rawShadowTargets
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    const parseToolProgressWhitelist = (selector) => $(selector).value
      .split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    const maxMessagesInput = $('#cfg-tool-progress-max-messages').value.trim();
    const minIntervalInput = $('#cfg-tool-progress-min-interval').value.trim();
    const maxMessagesPerTurn = maxMessagesInput === '' ? 8 : Number(maxMessagesInput);
    const minIntervalMs = minIntervalInput === '' ? 1500 : Number(minIntervalInput);
    if (!Number.isInteger(maxMessagesPerTurn) || maxMessagesPerTurn < 1 || maxMessagesPerTurn > 100) {
      throw new Error('工具进度单轮播报上限应为 1-100 的整数');
    }
    if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) {
      throw new Error('工具进度最小播报间隔应为非负有限毫秒数');
    }

    const payload = {
      toolProgress: {
        enabled: $('#cfg-tool-progress-enabled').checked,
        showDetail: $('#cfg-tool-progress-show-detail').checked,
        privateEnabled: $('#cfg-tool-progress-private-enabled').checked,
        groupWhitelist: parseToolProgressWhitelist('#cfg-tool-progress-group-whitelist'),
        privateWhitelist: parseToolProgressWhitelist('#cfg-tool-progress-private-whitelist'),
        maxMessagesPerTurn,
        minIntervalMs,
      },
      mode: $('#cfg-mode').value,
      identity: {
        ownerId: $('#cfg-owner-id').value.trim(),
        adminIds,
        adminCommands,
        robotId: $('#cfg-robot-id').value.trim(),
        botName: $('#cfg-bot-name').value.trim(),
        ownerTitle: $('#cfg-owner-title').value.trim(),
        rateLimitUsers,
        privateWhitelist,
        groupWhitelist,
      },
      wake: {
        mode: $('#cfg-wake-mode').value,
        namePattern: $('#cfg-wake-pattern').value.trim(),
      },
      napcat: {
        wsUrl: $('#cfg-napcat-ws').value.trim(),
        httpUrl: $('#cfg-napcat-http').value.trim(),
        accessToken: $('#cfg-napcat-token').value.trim(),
        inputStatusEnabled: $('#cfg-input-status').checked,
      },
      model: {
        baseUrl: $('#cfg-model-base-url').value.trim(),
        model: $('#cfg-model-name').value.trim(),
        apiKey: $('#cfg-model-key').value.trim(),
        apiKeyEnv: $('#cfg-model-env').value.trim(),
        timeoutMs: Number($('#cfg-model-timeout').value) || 1800000,
        sessionCutoffHour: $('#cfg-model-cutoff-hour').value.trim() === ''
          ? 7
          : Number($('#cfg-model-cutoff-hour').value),
        sessionRotationsPerDay: Number($('#cfg-model-rotations').value) || 1,
        stream: $('#cfg-model-stream').checked,
      },
      meme: {
        autoCollect: $('#cfg-meme-collect').checked,
        autoAiTagging: $('#cfg-meme-autotag').checked,
        visionBaseUrl: $('#cfg-meme-vision-url').value.trim(),
        visionModel: $('#cfg-meme-vision-model').value.trim(),
        visionKey: $('#cfg-meme-vision-key').value.trim(),
        visionKeyEnv: $('#cfg-meme-vision-env').value.trim(),
        matcherEnabled: $('#cfg-meme-matcher-enabled').checked,
        matcherBaseUrl: $('#cfg-meme-matcher-url').value.trim(),
        matcherModel: $('#cfg-meme-matcher-model').value.trim(),
        matcherKey: $('#cfg-meme-matcher-key').value.trim(),
        matcherKeyEnv: $('#cfg-meme-matcher-env').value.trim(),
        matcherTimeoutMs: Number($('#cfg-meme-matcher-timeout').value) || 10000,
        matcherMaxRetries: Number($('#cfg-meme-matcher-retries').value),
        matcherCandidateCount: Number($('#cfg-meme-matcher-candidates').value) || 10,
      },
      portrayal: {
        enabled: $('#cfg-portrayal-enabled').checked,
        msgInterval: Number($('#cfg-portrayal-interval').value) || 50,
        initialThreshold: Number($('#cfg-portrayal-initial').value) || 20,
        cooldownHours: Number($('#cfg-portrayal-cooldown').value) || 24,
        blacklistUsers: portrayalBlacklist,
        model: $('#cfg-portrayal-model').value.trim(),
        baseUrl: $('#cfg-portrayal-url').value.trim(),
        apiKeyEnv: $('#cfg-portrayal-env').value.trim(),
      },
      shadowLearn: {
        enabled: $('#cfg-shadow-enabled').checked,
        targets: shadowTargets,
        injectCount: Number($('#cfg-shadow-inject').value) || 10,
      },
      decision: {
        debounceMs: Number($('#cfg-decision-debounce').value) || 800,
        localWindowSize: Number($('#cfg-decision-window-size').value) || 15,
        rateLimit: {
          maxReplies: Number($('#cfg-decision-max-replies').value) || 5,
          windowMs: Number($('#cfg-decision-window').value) || 300000,
          applyToPrivate: $('#cfg-decision-ratelimit-private')?.checked === true,
        },
        queueTimeout: {
          enabled: $('#cfg-decision-queue-timeout-enabled').checked,
          timeoutMs: Math.round(Number($('#cfg-decision-queue-timeout-sec').value) || 120) * 1000,
          notice: $('#cfg-decision-queue-timeout-notice').value.trim(),
        },
        groupRateLimit: {
          notice: $('#cfg-group-rate-limit-notice').value.trim(),
        },
      },
      context: {
        totalCharacterBudget: Number($('#cfg-context-total-budget').value) || 12000,
        perSourceCharacterBudget: Number($('#cfg-context-source-budget').value) || 4000,
        directMediaParts: $('#cfg-context-direct-parts').checked,
      },
      reply: {
        sendEnabled: $('#cfg-reply-send').checked,
        sideEffectsEnabled: $('#cfg-reply-side-effects').checked,
      },
      fastAck: {
        enabled: $('#cfg-fastack-enabled').checked,
        message: $('#cfg-fastack-msg').value.trim(),
        patterns: fastAckPatterns,
      },
      logging: {
        level: $('#cfg-log-level').value,
        logMessageBodies: $('#cfg-log-bodies').checked,
      },
    };

    const res = await api('/api/config', {
      method: 'PUT',
      body: payload,
    });

    toast(res.message || '配置已成功保存！');
    await renderSettings();
  } catch (err) {
    toast(`保存配置失败：${err.message}`, true);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = '💾 保存并应用配置';
  }
}

async function testModelConnection(type) {
  const btns = {
    vision: { btn: $('#cfg-test-vision-btn'), res: $('#cfg-test-vision-res') },
    matcher: { btn: $('#cfg-test-matcher-btn'), res: $('#cfg-test-matcher-res') },
    main: { btn: $('#cfg-test-model-btn'), res: $('#cfg-test-model-res') },
  };
  const pick = btns[type] ?? btns.main;
  const btn = pick.btn;
  const resEl = pick.res;

  btn.disabled = true;
  resEl.className = 'test-status loading';
  resEl.textContent = '⏳ 测试中…';

  try {
    let baseUrl;
    let model;
    let apiKey;
    if (type === 'vision' || type === 'matcher') {
      // matcher 字段留空时回落 vision 字段（与运行时回落逻辑一致）
      const prefix = type === 'matcher' ? '#cfg-meme-matcher-' : '#cfg-meme-vision-';
      baseUrl = $(`${prefix}url`).value.trim() || $('#cfg-meme-vision-url').value.trim();
      model = $(`${prefix}model`).value.trim() || $('#cfg-meme-vision-model').value.trim();
      apiKey = $(`${prefix}key`).value.trim() || $('#cfg-meme-vision-key').value.trim();
    } else {
      baseUrl = $('#cfg-model-base-url').value.trim();
      model = $('#cfg-model-name').value.trim();
      apiKey = $('#cfg-model-key').value.trim();
    }

    const data = await api('/api/config/test-model', {
      method: 'POST',
      body: { type, baseUrl, model, apiKey },
    });

    if (data.ok) {
      resEl.className = 'test-status ok';
      resEl.textContent = `✅ 连通正常 (${data.latencyMs}ms): ${esc(data.reply || 'OK')}`;
    } else {
      resEl.className = 'test-status err';
      resEl.textContent = `❌ ${esc(data.error || '连接失败')}`;
    }
  } catch (err) {
    resEl.className = 'test-status err';
    resEl.textContent = `❌ 失败: ${esc(err.message)}`;
  } finally {
    btn.disabled = false;
  }
}

// ============================================================ 统一宿主与模型池

async function renderHost() {
  const [overview, providersData] = await Promise.all([
    api('/api/host/overview').catch((e) => ({ ok: false, error: e.message })),
    api('/api/host/providers').catch((e) => ({ ok: false, error: e.message })),
  ]);

  if (!overview.ok) {
    $('#host-overview-cards').innerHTML = `<div class="card err"><h3>统一宿主连接失败</h3><p class="err">${esc(overview.error)}</p></div>`;
    return;
  }

  // 1. 总览卡片
  $('#host-overview-cards').innerHTML = `
    <div class="card ok">
      <h3>宿主状态</h3>
      <p class="big">${esc(overview.host?.status ?? 'healthy')}</p>
      <p class="meta">端口 :${overview.host?.port} · 影子模式: ${overview.host?.shadowMode ? '是' : '否'}</p>
    </div>
    <div class="card">
      <h3>已挂载插件</h3>
      <p class="big">${overview.plugins?.mounted ?? 0} 个</p>
      <p class="meta">${Object.keys(overview.plugins?.details ?? {}).join(', ')}</p>
    </div>
    <div class="card">
      <h3>人格 (Persona)</h3>
      <p class="big">${esc(overview.persona?.default ?? 'ruaji')}</p>
      <p class="meta">直连: ${esc(overview.persona?.soulPath ? overview.persona.soulPath.split(/[/\\\\]/).slice(-2).join('/') : 'SOUL.md')}</p>
    </div>
  `;

  // 2. 全局默认模型卡片回显与保存交互
  const provList = providersData.providers ?? [];
  const defaultModel = overview.host?.defaultModel ?? '';
  const defaultModelInput = $('#host-default-model-input');
  // 本页参与 5s 自动刷新（scheduleAutoRefresh 只豁免 sandbox/settings/plugins-portal），
  // 无条件回写会把用户正在敲的模型名冲掉，所以聚焦时跳过。
  if (defaultModelInput && document.activeElement !== defaultModelInput) {
    defaultModelInput.value = defaultModel;
  }
  // 候选模型来自宿主已注册的聊天 Provider，不在前端硬编码第二份清单
  const modelDatalist = $('#preset-host-default-models');
  if (modelDatalist && providersData.availableModels?.length) {
    modelDatalist.innerHTML = providersData.availableModels
      .map((m) => `<option value="${esc(m)}"></option>`).join('');
  }
  const saveDefaultModelBtn = $('#host-save-default-model-btn');
  if (saveDefaultModelBtn) {
    saveDefaultModelBtn.onclick = async () => {
      const newModel = (defaultModelInput?.value || '').trim();
      if (!newModel) {
        toast('默认模型名称不能为空', true);
        return;
      }
      saveDefaultModelBtn.disabled = true;
      toast(`正在将全局默认模型切换为 ${newModel}…`);
      try {
        const resp = await api('/api/host/providers/update', {
          method: 'POST',
          body: { id: 'llm', model: newModel },
        });
        toast(`全局默认模型已成功更新并落盘: ${resp.model || newModel}`);
        await renderHost();
      } catch (err) {
        toast(`更新失败: ${err.message}`, true);
      } finally {
        saveDefaultModelBtn.disabled = false;
      }
    };
  }

  // 3. 供应商池列表
  const provTbody = $('#providers-table tbody');
  provTbody.innerHTML = provList.map((p) => `
    <tr>
      <td><code>${esc(p.id)}</code></td>
      <td><span class="pill ok">${esc(p.type)}</span></td>
      <td><code>${esc(p.baseUrl)}</code></td>
      <td><code>${esc(p.model || '-')}</code></td>
      <td><code>${esc(p.apiKeyMasked)}</code></td>
      <td>
        <button class="btn btn-sm ghost" data-provider-id="${esc(p.id)}" data-base-url="${esc(p.baseUrl)}" data-model="${esc(p.model || '')}">
          编辑接口
        </button>
      </td>
    </tr>
  `).join('') || (providersData.ok
    ? '<tr><td colspan="6" class="empty">无接口通道配置</td></tr>'
    // 本页每 5s 自动刷新一次，失败提示必须是内联的——用 toast 会一直弹
    : `<tr><td colspan="6" class="empty err">接口供应商池读取失败：${esc(providersData.error ?? '未知错误')}</td></tr>`);

  $$('#providers-table button').forEach((btn) => {
    btn.onclick = async () => {
      const pid = btn.dataset.providerId;
      const currentUrl = btn.dataset.baseUrl;
      const currentModel = btn.dataset.model;
      const newUrl = prompt(`修改通道 [${pid}] 的 Base URL:`, currentUrl);
      if (newUrl === null) return;
      let newModel = null;
      if (pid === 'llm' || currentModel) {
        newModel = prompt(`修改通道 [${pid}] 的模型名称 (留空保持不变):`, currentModel);
        if (newModel === null) return;
      }
      const newKey = prompt(`输入新 API Key (留空表示不修改):`, '');
      if (newKey === null) return;

      if (pid === 'embedding' && newModel && newModel.trim() && newModel.trim() !== currentModel) {
        // 换向量模型必然改变向量空间，旧 FAISS 索引不会跟着变，检索会静默地错
        if (!confirm(`即将把 embedding 模型从 [${currentModel || '未设置'}] 换成 [${newModel.trim()}]。

现有 FAISS 索引是旧模型建立的，不重建索引的话检索结果不可信。确认继续？`)) return;
      }

      toast(`正在更新接口通道 ${pid}…`);
      const body = { id: pid, baseUrl: newUrl.trim() };
      if (newModel && newModel.trim()) body.model = newModel.trim();
      if (newKey.trim()) body.apiKey = newKey.trim();
      try {
        const resp = await api('/api/host/providers/update', { method: 'POST', body });
        toast(resp.warning || `通道 ${pid} 接口配置已成功保存！`, Boolean(resp.warning));
        await renderHost();
      } catch (err) {
        toast(`保存失败: ${err.message}`, true);
      }
    };
  });

  // 4. 存储分布
  const storageTbody = $('#host-storage-table tbody');
  const storage = overview.storage ?? {};
  storageTbody.innerHTML = Object.entries(storage).map(([pkg, info]) => `
    <tr>
      <td><code>data/plugin_data/${esc(pkg)}</code></td>
      <td class="num"><strong>${esc(info.sizeReadable)}</strong> (${info.sizeBytes.toLocaleString()} bytes)</td>
    </tr>
  `).join('') || '<tr><td colspan="2" class="empty">无数据目录</td></tr>';
}

// ============================================================ 插件聚合门户

let currentPluginPortalUrl = '';

async function renderPluginsPortal() {
  const res = await api('/api/host/plugins-pages').catch((e) => ({ ok: false, error: e.message, pages: [] }));
  const pages = res.pages ?? [];
  const bar = $('#plugin-tabs-bar');

  if (!pages.length) {
    bar.innerHTML = `<span style="color:var(--text-dim);">暂无已注册 Web 页面的插件</span>`;
    return;
  }

function resolvePortalUrl(p) {
    return p.url || (p.port ? `http://127.0.0.1:${p.port}/` : '');
  }

  bar.innerHTML = `
    <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
      <div>
        ${pages.map((p, idx) => {
          const finalUrl = resolvePortalUrl(p);
          return `
            <button class="btn btn-sm ${currentPluginPortalUrl === finalUrl || (!currentPluginPortalUrl && idx === 0) ? 'primary' : 'ghost'}" data-url="${esc(finalUrl)}" style="margin-right: 8px;">
              ${esc(p.title)}
            </button>
          `;
        }).join('')}
      </div>
      <div style="display: flex; gap: 8px;">
        <button class="btn btn-sm ghost" id="btn-refresh-plugin-iframe" title="重新载入内嵌页面">🔄 刷新</button>
        <a class="btn btn-sm ghost" id="btn-open-plugin-external" href="#" target="_blank" rel="noopener noreferrer" title="在独立浏览器标签页中打开">↗ 独立新窗口打开</a>
      </div>
    </div>
  `;

  if (!currentPluginPortalUrl && pages[0]) {
    currentPluginPortalUrl = resolvePortalUrl(pages[0]);
  }

  const iframe = $('#plugin-portal-iframe');
  const placeholder = $('#plugin-portal-placeholder');
  const openExternalBtn = $('#btn-open-plugin-external');
  const refreshIframeBtn = $('#btn-refresh-plugin-iframe');

  function updateActivePortal(targetUrl) {
    currentPluginPortalUrl = targetUrl;
    iframe.src = targetUrl;
    iframe.style.display = 'block';
    placeholder.style.display = 'none';
    if (openExternalBtn) openExternalBtn.href = targetUrl;
  }

  if (currentPluginPortalUrl) {
    updateActivePortal(currentPluginPortalUrl);
  }

  if (refreshIframeBtn) {
    refreshIframeBtn.onclick = () => {
      if (iframe.src) iframe.src = iframe.src;
    };
  }

  $$('#plugin-tabs-bar button[data-url]').forEach((btn) => {
    btn.onclick = () => {
      const targetUrl = btn.dataset.url;
      if (currentPluginPortalUrl !== targetUrl) {
        updateActivePortal(targetUrl);
      }
      $$('#plugin-tabs-bar button[data-url]').forEach((b) => b.className = 'btn btn-sm ghost');
      btn.className = 'btn btn-sm primary';
    };
  });
}

const RENDERERS = {
  overview: renderOverview,
  host: renderHost,
  'plugins-portal': renderPluginsPortal,
  traces: renderTraces,
  sandbox: async () => {},
  shadow: renderShadow,
  affection: renderAffection,
  portrayal: renderPortrayal,
  memes: renderMemes,
  lorebooks: renderLorebooks,
  settings: renderSettings,
};

let refreshing = false;
export async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    await RENDERERS[state.view]();
  } catch (err) {
    toast(`刷新失败：${err.message}`, true);
  } finally {
    refreshing = false;
  }
}

// 表单 / CRUD 页面不参与自动刷新，避免 5 秒一次重渲染打断用户正在敲的输入
const NO_AUTOREFRESH = new Set(['sandbox', 'settings', 'plugins-portal', 'lorebooks']);

function scheduleAutoRefresh() {
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    if (state.autorefresh && !NO_AUTOREFRESH.has(state.view)) {
      refresh();
    }
  }, 5000);
}

// ============================================================ 启动

function bind() {
  $$('.tab').forEach((t) => { t.onclick = () => switchView(t.dataset.view); });
  $('#nav-toggle').onclick = () => setNavOpen(!document.body.classList.contains('nav-open'));
  $('#nav-scrim').onclick = () => setNavOpen(false);
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    setNavOpen(false);
    if (lore.booksOpen) setBooksDrawer(false);
  });
  $('#refresh-btn').onclick = refresh;
  $('#autorefresh').onchange = (e) => { state.autorefresh = e.target.checked; };

  $('#trace-search').onclick = renderTraces;
  $('#trace-q').onkeydown = (e) => { if (e.key === 'Enter') renderTraces(); };
  $('#trace-route').onchange = renderTraces;
  $('#trace-clear').onclick = async () => {
    await api('/api/traces/clear', { method: 'POST' });
    state.selectedTrace = null;
    $('#trace-detail').innerHTML = '<p class="empty">缓冲已清空。</p>';
    toast('追踪缓冲已清空');
    renderTraces();
  };

  $('#sandbox-form').onsubmit = runSandbox;

  $('#shadow-load').onclick = loadShadowReport;
  $('#shadow-file').onchange = loadShadowReport;

  $('#aff-search').onclick = renderAffection;
  $('#aff-q').onkeydown = (e) => { if (e.key === 'Enter') renderAffection(); };

  $('#portrayal-search').onclick = renderPortrayal;
  $('#portrayal-q').onkeydown = (e) => { if (e.key === 'Enter') renderPortrayal(); };
  $('#portrayal-refresh-all').onclick = () => {
    toast('正在刷新群友画像…');
    renderPortrayal();
  };

  $('#meme-filter').onclick = renderMemes;
  $('#meme-q').onkeydown = (e) => { if (e.key === 'Enter') renderMemes(); };
  $('#meme-test').onclick = testMemeTag;
  $('#meme-tag').onkeydown = (e) => { if (e.key === 'Enter') testMemeTag(); };

  bindLorebooks();

  $('#cfg-reload').onclick = () => {
    toast('正在重新载入配置…');
    renderSettings();
  };
  $('#cfg-save').onclick = saveSettings;
  $('#cfg-test-vision-btn').onclick = () => testModelConnection('vision');
  $('#cfg-test-matcher-btn').onclick = () => testModelConnection('matcher');
  $('#cfg-test-model-btn').onclick = () => testModelConnection('main');
}

bind();
initSandbox().catch((err) => toast(`沙箱初始化失败：${err.message}`, true));
refresh();
scheduleAutoRefresh();
