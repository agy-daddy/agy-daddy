'use strict';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function serializeJsonForScript(value) {
  return JSON.stringify(value ?? null)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function renderDiagnosticsPageHtml(options = {}) {
  const bridgePort = options.port || options.bridgePort || null;
  const actionToken = typeof options.token === 'string' ? options.token : '';
  const canRelaunch = options.canRelaunch !== false;
  const initialHealth = options.initialHealth || null;

  const bootstrapConfig = serializeJsonForScript({
    healthEndpoint: '/diagnostics/health',
    relaunchEndpoint: '/diagnostics/relaunch',
    actionToken,
    canRelaunch,
    bridgePort
  });
  const initialJson = serializeJsonForScript(initialHealth);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agy-Daddy 独立健康诊断面板</title>
<style>
  :root {
    --bg: #f6f7f9;
    --surface: #ffffff;
    --surface-muted: #f0f2f5;
    --border: #dfe3ea;
    --text: #161b22;
    --muted: #59636e;
    --ok-bg: #e8f5ee;
    --ok-fg: #146c3a;
    --warn-bg: #fff4e5;
    --warn-fg: #9a5400;
    --err-bg: #fdebec;
    --err-fg: #b42318;
    --info-bg: #eef4ff;
    --info-fg: #1d4ed8;
    --btn-bg: #1f2328;
    --btn-fg: #ffffff;
    --btn-sec-bg: #ffffff;
    --btn-sec-fg: #1f2328;
    --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1318;
      --surface: #161b22;
      --surface-muted: #1e242d;
      --border: #2c3440;
      --text: #e6edf3;
      --muted: #9aa4b2;
      --ok-bg: #12281c;
      --ok-fg: #6ee7a0;
      --warn-bg: #2b200d;
      --warn-fg: #fbbf24;
      --err-bg: #2d1417;
      --err-fg: #f87171;
      --info-bg: #152238;
      --info-fg: #93c5fd;
      --btn-bg: #e6edf3;
      --btn-fg: #0f1318;
      --btn-sec-bg: #1e242d;
      --btn-sec-fg: #e6edf3;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 20px;
    background: var(--bg);
    color: var(--text);
    font-family: var(--sans);
    font-size: 13px;
    line-height: 1.5;
  }
  .container { max-width: 1120px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
  .header {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px 18px;
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
  }
  .header h1 { margin: 0; font-size: 17px; font-weight: 600; }
  .subtitle { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  button {
    appearance: none;
    border: 1px solid var(--border);
    background: var(--btn-sec-bg);
    color: var(--btn-sec-fg);
    border-radius: 7px;
    padding: 7px 12px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
  }
  button.primary {
    background: var(--btn-bg);
    color: var(--btn-fg);
    border-color: transparent;
  }
  button:disabled { opacity: 0.55; cursor: not-allowed; }
  .toggle-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--muted);
    font-size: 12px;
    margin-left: 4px;
    user-select: none;
  }
  .banner {
    border-radius: 10px;
    padding: 12px 16px;
    border: 1px solid var(--border);
    background: var(--surface);
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
  }
  .banner.fault { background: var(--err-bg); color: var(--err-fg); border-color: transparent; }
  .banner.healthy { background: var(--ok-bg); color: var(--ok-fg); border-color: transparent; }
  .banner.info { background: var(--info-bg); color: var(--info-fg); border-color: transparent; }
  .banner.warn { background: var(--warn-bg); color: var(--warn-fg); border-color: transparent; }
  .banner-title { font-weight: 600; font-size: 13px; }
  .banner-meta { font-family: var(--mono); font-size: 11px; opacity: 0.9; }
  .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .card-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .card h2 { margin: 0; font-size: 14px; font-weight: 600; }
  .kv-list { display: grid; grid-template-columns: 140px 1fr; gap: 6px 12px; font-size: 12px; }
  .kv-key { color: var(--muted); }
  .kv-val { font-family: var(--mono); word-break: break-word; }
  .badge {
    display: inline-block;
    padding: 2px 7px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    font-family: var(--mono);
  }
  .badge.ok { background: var(--ok-bg); color: var(--ok-fg); }
  .badge.warn { background: var(--warn-bg); color: var(--warn-fg); }
  .badge.err { background: var(--err-bg); color: var(--err-fg); }
  .badge.info { background: var(--info-bg); color: var(--info-fg); }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td {
    text-align: left;
    padding: 7px 8px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  th { color: var(--muted); font-weight: 600; background: var(--surface-muted); }
  td.mono, th.mono { font-family: var(--mono); font-size: 11px; word-break: break-word; }
  .subhead { font-size: 12px; font-weight: 600; color: var(--muted); margin-top: 4px; }
  .empty { color: var(--muted); font-size: 12px; padding: 6px 0; }
  pre.stack {
    margin: 4px 0 0;
    padding: 8px;
    background: var(--surface-muted);
    border-radius: 6px;
    font-family: var(--mono);
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 180px;
    overflow: auto;
  }
  .hidden { display: none !important; }
</style>
</head>
<body>
  <div class="container">
    <header class="header">
      <div>
        <h1>Agy-Daddy 独立健康诊断面板</h1>
        <div class="subtitle">常驻 Daemon 宿外直连 · 仅监听 127.0.0.1${bridgePort ? `:${escapeHtml(bridgePort)}` : ''} · 不依赖 Antigravity UI</div>
      </div>
      <div class="actions">
        <button id="refresh-btn" type="button">手动刷新</button>
        <button id="relaunch-btn" type="button" class="primary"${canRelaunch ? '' : ' disabled'}>一键补参重启 Antigravity</button>
        <label class="toggle-label">
          <input id="auto-refresh-toggle" type="checkbox" checked>
          <span>自动刷新 (5s)</span>
        </label>
      </div>
    </header>

    <div id="fault-banner" class="banner info" role="status">
      <div class="banner-title" id="fault-title">正在读取 hostHealth 快照...</div>
      <div class="banner-meta" id="fault-meta"></div>
    </div>

    <div id="action-status" class="banner info hidden" role="status">
      <div class="banner-title" id="action-status-text"></div>
    </div>

    <div class="grid-2">
      <section class="card" id="section-daemon">
        <div class="card-header">
          <h2>1. Daemon &amp; Launcher</h2>
          <span class="badge info" id="daemon-badge">—</span>
        </div>
        <div class="kv-list" id="daemon-kv"></div>
      </section>

      <section class="card" id="section-antigravity">
        <div class="card-header">
          <h2>2. Antigravity 进程与版本升级</h2>
          <span class="badge info" id="ag-badge">—</span>
        </div>
        <div class="kv-list" id="ag-kv"></div>
        <div class="subhead">版本升级事件 (upgradeEvents)</div>
        <div id="upgrade-events-wrap"></div>
      </section>
    </div>

    <section class="card" id="section-cdp">
      <div class="card-header">
        <h2>3. CDP 端口与 /json/list 全量页面</h2>
        <span class="badge info" id="cdp-badge">—</span>
      </div>
      <div class="kv-list" id="cdp-kv"></div>
      <div class="subhead">已匹配目标 (matched)</div>
      <div id="cdp-matched-wrap"></div>
      <div class="subhead">被过滤页面 (filtered)</div>
      <div id="cdp-filtered-wrap"></div>
    </section>

    <section class="card" id="section-injection">
      <div class="card-header">
        <h2>4. 宿内注入与 14 锚点实时探活</h2>
        <span class="badge info" id="injection-badge">—</span>
      </div>
      <div class="kv-list" id="injection-kv"></div>
      <div id="anchors-wrap"></div>
    </section>

    <section class="card" id="section-plugins">
      <div class="card-header">
        <h2>5. 插件健康 (Node 激活态 + Renderer 挂载态)</h2>
        <span class="badge info" id="plugins-badge">—</span>
      </div>
      <div id="plugins-wrap"></div>
    </section>
  </div>

  <script id="agy-diag-config" type="application/json">${bootstrapConfig}</script>
  <script id="agy-initial-health" type="application/json">${initialJson}</script>
  <script>
  (() => {
    const cfgEl = document.getElementById('agy-diag-config');
    const initEl = document.getElementById('agy-initial-health');
    const cfg = cfgEl ? JSON.parse(cfgEl.textContent || '{}') : {};
    let currentHealth = initEl && initEl.textContent ? JSON.parse(initEl.textContent) : null;
    let lastUpdatedAt = null;
    let refreshTimer = null;
    let relaunchBusy = false;

    const faultBanner = document.getElementById('fault-banner');
    const faultTitle = document.getElementById('fault-title');
    const faultMeta = document.getElementById('fault-meta');
    const actionStatus = document.getElementById('action-status');
    const actionStatusText = document.getElementById('action-status-text');
    const refreshBtn = document.getElementById('refresh-btn');
    const relaunchBtn = document.getElementById('relaunch-btn');
    const autoToggle = document.getElementById('auto-refresh-toggle');

    function el(tag, attrs = {}, children = []) {
      const node = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'className') node.className = v;
        else if (k === 'text') node.textContent = v;
        else node.setAttribute(k, v);
      }
      for (const child of children) {
        if (typeof child === 'string') node.appendChild(document.createTextNode(child));
        else if (child) node.appendChild(child);
      }
      return node;
    }

    function clear(node) {
      while (node.firstChild) node.removeChild(node.firstChild);
    }

    function renderKv(container, rows) {
      clear(container);
      for (const [key, val] of rows) {
        container.appendChild(el('div', { className: 'kv-key', text: key }));
        const valNode = el('div', { className: 'kv-val' });
        if (val instanceof Node) valNode.appendChild(val);
        else valNode.textContent = val === null || val === undefined || val === '' ? '—' : String(val);
        container.appendChild(valNode);
      }
    }

    function makeTable(headers, rows, emptyText) {
      if (!rows.length) return el('div', { className: 'empty', text: emptyText });
      const thead = el('thead', {}, [el('tr', {}, headers.map((h) => el('th', { text: h })))]);
      const tbody = el('tbody', {}, rows.map((cols) => el('tr', {}, cols.map((c) => {
        if (c instanceof Node) return el('td', {}, [c]);
        if (c && typeof c === 'object' && c.node) return el('td', { className: c.className || '' }, [c.node]);
        if (c && typeof c === 'object') return el('td', { className: c.className || '', text: c.text ?? '—' });
        return el('td', { text: c === null || c === undefined || c === '' ? '—' : String(c) });
      }))));
      return el('table', {}, [thead, tbody]);
    }

    function formatMs(ms) {
      const n = Number(ms);
      if (!Number.isFinite(n) || n < 0) return '—';
      if (n < 1000) return n + ' ms';
      const sec = Math.floor(n / 1000);
      if (sec < 60) return sec + ' s';
      const min = Math.floor(sec / 60);
      return min + ' m ' + (sec % 60) + ' s';
    }

    function renderSnapshot(health) {
      if (!health || typeof health !== 'object') return;
      const d = health.daemon || {};
      const ag = health.antigravity || {};
      const cdp = health.cdp || {};
      const inj = health.injection || {};
      const plugins = Array.isArray(health.plugins) ? health.plugins : [];
      const fault = health.fault || {};

      // Fault Banner
      faultBanner.className = 'banner ' + (fault.active ? 'fault' : 'healthy');
      if (fault.active) {
        faultTitle.textContent = '检测到宿主异常：' + (fault.code || 'unknown') + (fault.exceeded5s ? '（已持续 >5s，托盘强显已触发）' : '（未超过 5s 阈值）');
        faultMeta.textContent = [
          fault.reason || '',
          fault.pid ? 'PID ' + fault.pid : '',
          '持续 ' + formatMs(fault.durationMs),
          lastUpdatedAt ? '更新于 ' + lastUpdatedAt : ''
        ].filter(Boolean).join(' · ');
      } else {
        faultTitle.textContent = '运行健康（无活跃故障）';
        faultMeta.textContent = [
          ag.running ? 'Antigravity ' + (ag.version || '') + ' (PID ' + (ag.pid || '—') + ')' : 'Antigravity 未运行',
          '锚点 ' + (inj.anchors?.healthyCount ?? 0) + '/' + (inj.anchors?.total ?? 14),
          lastUpdatedAt ? '更新于 ' + lastUpdatedAt : ''
        ].filter(Boolean).join(' · ');
      }

      // 1. Daemon
      const daemonBadge = document.getElementById('daemon-badge');
      daemonBadge.className = 'badge ' + (d.hasSessionEnvPollution ? 'err' : 'ok');
      daemonBadge.textContent = d.hasSessionEnvPollution ? '会话变量污染' : '环境已隔离';
      renderKv(document.getElementById('daemon-kv'), [
        ['Daemon PID', d.pid],
        ['Bridge 端口', d.bridgePort],
        ['启动时间', d.startedAt],
        ['运行时长', formatMs(d.uptimeMs)],
        ['继承会话变量', Array.isArray(d.inheritedSessionVars) && d.inheritedSessionVars.length ? d.inheritedSessionVars.join(', ') : '无'],
        ['当前污染状态', d.hasSessionEnvPollution ? '是 (检测到会话变量)' : '否']
      ]);

      // 2. Antigravity
      const agBadge = document.getElementById('ag-badge');
      agBadge.className = 'badge ' + (!ag.running ? 'warn' : (ag.hasDebugSwitch ? 'ok' : 'err'));
      agBadge.textContent = !ag.running ? '未运行' : (ag.hasDebugSwitch ? 'CDP 已开启' : '未开启 CDP');
      const relaunch = ag.lastRelaunch || {};
      const relaunchText = relaunch.status
        ? [relaunch.status, relaunch.reason, relaunch.blockedBy ? 'blockedBy=' + relaunch.blockedBy : '', relaunch.at].filter(Boolean).join(' · ')
        : '—';
      renderKv(document.getElementById('ag-kv'), [
        ['运行状态', ag.running ? '运行中' : '未运行'],
        ['进程 PID', ag.pid],
        ['当前版本', ag.version],
        ['上次成功注入版本', ag.lastInjectedVersion],
        ['CDP 调试开关', ag.hasDebugSwitch ? 'true' : 'false'],
        ['最近补参结果', relaunchText]
      ]);
      const upWrap = document.getElementById('upgrade-events-wrap');
      clear(upWrap);
      const upEvents = Array.isArray(ag.upgradeEvents) ? ag.upgradeEvents : [];
      upWrap.appendChild(makeTable(
        ['时间', '版本变更', 'PID', '结果', '原因'],
        upEvents.map((ev) => [
          { className: 'mono', text: ev.at || '—' },
          { className: 'mono', text: (ev.fromVersion || '?') + ' → ' + (ev.toVersion || '?') },
          { className: 'mono', text: ev.pid ?? '—' },
          el('span', { className: 'badge ' + (ev.outcome === 'succeeded' ? 'ok' : (ev.outcome === 'attempting' || ev.outcome === 'deferred' ? 'warn' : 'err')), text: ev.outcome || '—' }),
          { className: 'mono', text: ev.reason || '—' }
        ]),
        '暂无版本升级事件'
      ));

      // 3. CDP
      const matched = Array.isArray(cdp.targets?.matched) ? cdp.targets.matched : [];
      const filtered = Array.isArray(cdp.targets?.filtered) ? cdp.targets.filtered : [];
      const cdpBadge = document.getElementById('cdp-badge');
      cdpBadge.className = 'badge ' + (cdp.reachable && matched.length > 0 ? 'ok' : 'err');
      cdpBadge.textContent = (cdp.reachable ? '端口可达' : '不可达') + ' · 匹配 ' + matched.length + ' / 过滤 ' + filtered.length;
      renderKv(document.getElementById('cdp-kv'), [
        ['CDP 端口', cdp.port],
        ['已探测端口', Array.isArray(cdp.portsTried) && cdp.portsTried.length ? cdp.portsTried.join(', ') : '无'],
        ['可达性', cdp.reachable ? 'true' : 'false'],
        ['/json/list 总页数', cdp.targets?.total ?? (matched.length + filtered.length)]
      ]);
      const matchedWrap = document.getElementById('cdp-matched-wrap');
      clear(matchedWrap);
      matchedWrap.appendChild(makeTable(
        ['ID', 'Type', 'Title', 'URL'],
        matched.map((t) => [
          { className: 'mono', text: t.id || '—' },
          { className: 'mono', text: t.type || '—' },
          t.title || '—',
          { className: 'mono', text: t.url || '—' }
        ]),
        '无已匹配的 CDP 页面'
      ));
      const filteredWrap = document.getElementById('cdp-filtered-wrap');
      clear(filteredWrap);
      filteredWrap.appendChild(makeTable(
        ['ID', 'Type', 'Title', 'URL', '过滤原因'],
        filtered.map((t) => [
          { className: 'mono', text: t.id || '—' },
          { className: 'mono', text: t.type || '—' },
          t.title || '—',
          { className: 'mono', text: t.url || '—' },
          el('span', { className: 'badge warn', text: t.filterReason || '—' })
        ]),
        '无被过滤的 CDP 页面'
      ));

      // 4. Injection & 14 Anchors
      const anchors = inj.anchors || { total: 14, healthyCount: 0, missingCount: 14, items: [] };
      const injBadge = document.getElementById('injection-badge');
      injBadge.className = 'badge ' + (inj.lastInjectError ? 'err' : (anchors.missingCount > 0 ? 'warn' : 'ok'));
      injBadge.textContent = '锚点 ' + (anchors.healthyCount ?? 0) + '/' + (anchors.total ?? 14) + ' · ' + (inj.probeSource || 'static');
      renderKv(document.getElementById('injection-kv'), [
        ['已注入窗口数', inj.injectedCount],
        ['探活来源', inj.probeSource],
        ['目标 Antigravity 版本', inj.antigravityVersion],
        ['最近注入错误', inj.lastInjectError || '无']
      ]);
      const anchorsWrap = document.getElementById('anchors-wrap');
      clear(anchorsWrap);
      const anchorItems = Array.isArray(anchors.items) ? anchors.items : [];
      anchorsWrap.appendChild(makeTable(
        ['锚点名称', '状态', '命中 Selector', '波及插件'],
        anchorItems.map((a) => [
          { className: 'mono', text: a.name },
          el('span', { className: 'badge ' + (a.status === 'ok' ? 'ok' : 'err'), text: a.status === 'ok' ? 'OK' : 'MISSING' }),
          { className: 'mono', text: a.matchedSelector || 'MISSING' },
          { className: 'mono', text: Array.isArray(a.affectedPlugins) && a.affectedPlugins.length ? a.affectedPlugins.join(', ') : '—' }
        ]),
        '暂无锚点数据'
      ));

      // 5. Plugins
      const mountedCount = plugins.filter((p) => p.rendererMounted).length;
      const errCount = plugins.filter((p) => p.lastError || p.nodeState === 'error').length;
      const pluginsBadge = document.getElementById('plugins-badge');
      pluginsBadge.className = 'badge ' + (errCount > 0 ? 'err' : 'ok');
      pluginsBadge.textContent = plugins.length + ' 个插件 · 渲染挂载 ' + mountedCount + (errCount ? ' · 异常 ' + errCount : '');
      const pluginsWrap = document.getElementById('plugins-wrap');
      clear(pluginsWrap);
      pluginsWrap.appendChild(makeTable(
        ['插件', '启用', 'Node 激活态', 'Renderer 挂载态', '缺失锚点影响', '最近错误与堆栈'],
        plugins.map((p) => {
          const errNode = el('div');
          if (p.lastError) errNode.appendChild(el('div', { className: 'kv-val', text: p.lastError }));
          if (p.lastErrorStack) errNode.appendChild(el('pre', { className: 'stack', text: p.lastErrorStack }));
          if (!p.lastError && !p.lastErrorStack) errNode.textContent = '—';
          const nodeBadgeClass = p.nodeState === 'active' || p.nodeState === 'not_applicable'
            ? 'ok'
            : (p.nodeState === 'error' ? 'err' : 'warn');
          return [
            el('div', {}, [el('div', { text: p.name || p.id }), el('div', { className: 'subtitle mono', text: p.id })]),
            p.enabled ? '是' : '否',
            el('span', { className: 'badge ' + nodeBadgeClass, text: p.nodeState || '—' }),
            el('span', { className: 'badge ' + (p.rendererMounted ? 'ok' : (p.enabled ? 'warn' : 'info')), text: p.rendererMounted ? '已挂载' : '未挂载' }),
            { className: 'mono', text: Array.isArray(p.affectedByMissingAnchors) && p.affectedByMissingAnchors.length ? p.affectedByMissingAnchors.join(', ') : '—' },
            errNode
          ];
        }),
        '暂无已安装插件'
      ));
    }

    async function fetchHealth() {
      refreshBtn.disabled = true;
      try {
        const res = await fetch(cfg.healthEndpoint || '/diagnostics/health', { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        currentHealth = await res.json();
        lastUpdatedAt = new Date().toLocaleTimeString();
        renderSnapshot(currentHealth);
      } catch (err) {
        faultBanner.className = 'banner fault';
        faultTitle.textContent = '无法获取 /diagnostics/health';
        faultMeta.textContent = err && err.message ? err.message : String(err);
      } finally {
        refreshBtn.disabled = false;
      }
    }

    async function triggerRelaunch() {
      if (relaunchBusy || !cfg.canRelaunch) return;
      relaunchBusy = true;
      relaunchBtn.disabled = true;
      actionStatus.className = 'banner info';
      actionStatusText.textContent = '正在执行一键补参重启 Antigravity...';
      try {
        const res = await fetch(cfg.relaunchEndpoint || '/diagnostics/relaunch', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-AGY-Diagnostics-Token': cfg.actionToken || ''
          },
          body: '{}'
        });
        const data = await res.json().catch(() => ({ ok: false, error: 'HTTP ' + res.status }));
        if (res.ok && data && data.ok) {
          actionStatus.className = 'banner healthy';
          actionStatusText.textContent = '补参重启指令已执行 (' + (data.action || 'ok') + ')，正在刷新诊断快照...';
        } else {
          actionStatus.className = 'banner warn';
          actionStatusText.textContent = '补参重启未完成：' + (data?.relaunch?.reason || data?.reason || data?.error || ('HTTP ' + res.status));
        }
      } catch (err) {
        actionStatus.className = 'banner fault';
        actionStatusText.textContent = '请求补参重启失败：' + (err && err.message ? err.message : String(err));
      } finally {
        relaunchBusy = false;
        relaunchBtn.disabled = !cfg.canRelaunch;
        await fetchHealth();
      }
    }

    function syncAutoRefresh() {
      if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
      }
      if (autoToggle.checked) {
        refreshTimer = setInterval(() => { void fetchHealth(); }, 5000);
      }
    }

    refreshBtn.addEventListener('click', () => { void fetchHealth(); });
    relaunchBtn.addEventListener('click', () => { void triggerRelaunch(); });
    autoToggle.addEventListener('change', syncAutoRefresh);

    if (currentHealth) renderSnapshot(currentHealth);
    syncAutoRefresh();
    void fetchHealth();
  })();
  </script>
</body>
</html>
`;
}

function createDiagnosticsPageHandler(options = {}) {
  const getHealth = typeof options.getHealth === 'function' ? options.getHealth : null;
  return async (ctx = {}) => {
    let initialHealth = null;
    if (getHealth) {
      try {
        initialHealth = await getHealth();
      } catch {}
    }
    return renderDiagnosticsPageHtml({
      port: ctx.port || options.port || null,
      token: ctx.token || options.token || '',
      canRelaunch: ctx.canRelaunch ?? (typeof options.onRelaunch === 'function'),
      initialHealth
    });
  };
}

function registerStandaloneDiagnostics(daemon, options = {}) {
  const bridge = daemon?.bridge;
  if (!bridge || typeof bridge.registerDiagnosticsPage !== 'function') {
    return () => {};
  }
  const getHealth = options.getHealth || (typeof daemon.getDiagnosticHealth === 'function'
    ? () => daemon.getDiagnosticHealth()
    : null);
  const onRelaunch = typeof options.onRelaunch === 'function' ? options.onRelaunch : null;

  const unregisterPage = bridge.registerDiagnosticsPage(
    createDiagnosticsPageHandler({ getHealth, onRelaunch })
  );
  const unregisterRelaunch = onRelaunch && typeof bridge.registerDiagnosticsRelaunch === 'function'
    ? bridge.registerDiagnosticsRelaunch(onRelaunch)
    : () => {};

  return () => {
    try { unregisterPage(); } catch {}
    try { unregisterRelaunch(); } catch {}
  };
}

module.exports = {
  renderDiagnosticsPageHtml,
  createDiagnosticsPageHandler,
  registerStandaloneDiagnostics
};
