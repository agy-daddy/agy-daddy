'use strict';

function generatePwaHtml(options = {}) {
  const version = options.version || '2.0.0';
  return `<!doctype html>
<html lang="zh-CN" data-appearance="auto" data-remote-version="${version}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <title>Agy-Daddy Remote Console v${version}</title>
  <style>
    :root {
      --ag-accent: #a78bfa;
      --ag-accent-bg: rgba(167, 139, 250, 0.14);
      --ag-accent-border: rgba(167, 139, 250, 0.34);
      --ag-bg: #0f172a;
      --ag-card: #1e293b;
      --ag-fg: #e2e8f0;
    }
    [data-appearance="light"] {
      --ag-bg: #f8fafc;
      --ag-card: #ffffff;
      --ag-fg: #0f172a;
    }
    @media (prefers-color-scheme: light) {
      [data-appearance="auto"] {
        --ag-bg: #f8fafc;
        --ag-card: #ffffff;
        --ag-fg: #0f172a;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 12px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--ag-bg);
      color: var(--ag-fg);
    }
    .layout { display: grid; grid-template-columns: 1fr; gap: 12px; }
    @media (min-width: 900px) {
      .layout { grid-template-columns: 260px 1fr; }
    }
    .card {
      background: var(--ag-card);
      border: 1px solid var(--ag-accent-border);
      border-radius: 12px;
      padding: 12px;
      margin-bottom: 10px;
    }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      background: var(--ag-accent-bg);
      color: var(--ag-accent);
      border: 1px solid var(--ag-accent-border);
      font-size: 12px;
    }
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
    .btn {
      padding: 6px 10px;
      border-radius: 8px;
      border: 1px solid var(--ag-accent-border);
      background: var(--ag-accent-bg);
      color: var(--ag-accent);
      cursor: pointer;
    }
  </style>
</head>
<body>
  <header class="toolbar card" id="agy-remote-topbar">
    <span class="badge">Agy-Daddy Remote v${version}</span>
    <span id="agy-remote-context-drawer" data-panel="showContextPanel">Context: --</span>
    <span id="agy-remote-usage-drawer" data-panel="showUsagePanel">Usage: --</span>
    <span id="agy-remote-quota-pill" data-panel="showQuotaPill">Quota: --</span>
    <span id="agy-remote-channel-meta" data-panel="showChannelMeta">Channel: Loopback</span>
    <button type="button" class="btn" id="agy-speed-probe-btn">⚡ 测速</button>
    <button type="button" class="btn" id="agy-theme-cycle-btn">外观: auto</button>
  </header>
  <main class="layout">
    <aside class="card" id="agy-remote-sidebar" data-panel="showSidebar">
      <strong>会话抽屉</strong>
      <div id="agy-remote-sessions">默认回环只读快照</div>
    </aside>
    <section class="card" id="agy-remote-chat">
      <div id="agy-remote-approvals" data-panel="showApprovals"></div>
      <div id="agy-remote-thinking" data-panel="showThinking"></div>
      <div id="agy-remote-panels-ext"></div>
      <div id="agy-remote-quick-chips" data-panel="showQuickChips"></div>
      <div id="agy-remote-composer-tools" data-panel="showComposerTools">
        <input type="file" id="agy-image-upload" accept="image/*" />
        <input type="text" id="agy-remote-input" placeholder="只读模式已开启..." />
        <button type="button" class="btn" id="agy-remote-send-btn">发送</button>
      </div>
    </section>
  </main>
  <script>
    (function(){
      var cidKey = 'agy_remote_client_id';
      var didKey = 'agy_remote_device_hint';
      var cid = (window.sessionStorage && sessionStorage.getItem(cidKey)) || ('cli_' + Math.random().toString(36).slice(2, 10));
      var did = (window.localStorage && localStorage.getItem(didKey)) || ('dev_' + Math.random().toString(36).slice(2, 10));
      try { sessionStorage.setItem(cidKey, cid); localStorage.setItem(didKey, did); } catch {}
      window.__AGY_REMOTE_CLIENT__ = { clientId: cid, deviceHint: did, probeUrl: '/api/ping-gif' };
      document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
          var sb = document.getElementById('agy-remote-sidebar');
          if (sb) sb.style.display = 'none';
        }
      });
    })();
  </script>
</body>
</html>`;
}

module.exports = {
  generatePwaHtml
};
