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
      --ag-bg: #101010;
      --ag-card: #191919;
      --ag-subcard: rgba(255, 255, 255, 0.04);
      --ag-fg: #e4e4e7;
      --ag-secondary: #a1a1aa;
      --ag-muted: #8e8e98;
      --ag-border: rgba(255, 255, 255, 0.09);
      --ag-border-sub: rgba(255, 255, 255, 0.065);
      --ag-control: rgba(255, 255, 255, 0.08);
      --ag-control-hover: rgba(255, 255, 255, 0.14);
      --ag-primary-bg: #e4e4e7;
      --ag-primary-fg: #101010;
      --ag-ring: rgba(228, 228, 231, 0.45);
      --ag-warn: #f59e0b;
      --ag-danger: #ef4444;
    }
    [data-appearance="light"] {
      --ag-bg: #ffffff;
      --ag-card: #ffffff;
      --ag-subcard: rgba(10, 10, 12, 0.038);
      --ag-fg: #0a0a0c;
      --ag-secondary: #3f3f46;
      --ag-muted: #71717a;
      --ag-border: rgba(10, 10, 12, 0.08);
      --ag-border-sub: rgba(10, 10, 12, 0.06);
      --ag-control: rgba(10, 10, 12, 0.055);
      --ag-control-hover: rgba(10, 10, 12, 0.095);
      --ag-primary-bg: #18181b;
      --ag-primary-fg: #ffffff;
      --ag-ring: rgba(24, 24, 27, 0.30);
    }
    @media (prefers-color-scheme: light) {
      [data-appearance="auto"] {
        --ag-bg: #ffffff;
        --ag-card: #ffffff;
        --ag-subcard: rgba(10, 10, 12, 0.038);
        --ag-fg: #0a0a0c;
        --ag-secondary: #3f3f46;
        --ag-muted: #71717a;
        --ag-border: rgba(10, 10, 12, 0.08);
        --ag-border-sub: rgba(10, 10, 12, 0.06);
        --ag-control: rgba(10, 10, 12, 0.055);
        --ag-control-hover: rgba(10, 10, 12, 0.095);
        --ag-primary-bg: #18181b;
        --ag-primary-fg: #ffffff;
        --ag-ring: rgba(24, 24, 27, 0.30);
      }
    }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    body {
      margin: 0;
      padding: 14px 14px calc(32px + env(safe-area-inset-bottom, 0px));
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif;
      font-size: 13px;
      line-height: 1.45;
      font-variant-numeric: tabular-nums;
      -webkit-font-smoothing: antialiased;
      background: var(--ag-bg);
      color: var(--ag-fg);
    }
    .layout { display: grid; grid-template-columns: 1fr; gap: 12px; }
    @media (min-width: 900px) {
      .layout { grid-template-columns: 260px 1fr; }
    }
    .card {
      background: var(--ag-card);
      border: 1px solid var(--ag-border);
      border-radius: 12px;
      padding: 14px 16px;
      margin-bottom: 10px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 9px;
      border-radius: 999px;
      background: var(--ag-control);
      color: var(--ag-fg);
      border: none;
      font-size: 11.5px;
      font-weight: 500;
    }
    .ctx-pill {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-height: 34px;
      padding: 0 11px;
      border-radius: 999px;
      border: 1px solid var(--ag-border);
      background: var(--ag-subcard);
      color: var(--ag-fg);
      font-family: inherit;
      font-size: 11.5px;
      font-weight: 500;
      font-variant-numeric: tabular-nums;
      cursor: pointer;
      white-space: nowrap;
      transition: background-color 140ms cubic-bezier(0.22, 1, 0.36, 1), border-color 140ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    .ctx-pill:hover { background: var(--ag-control-hover); }
    .ctx-pill[data-risk="warn"] { border-color: rgba(245, 158, 11, 0.45); }
    .ctx-pill[data-risk="critical"] { border-color: rgba(239, 68, 68, 0.48); color: var(--ag-danger); }
    .ctx-seg { display: inline-flex; align-items: center; gap: 3px; }
    .ctx-seg[data-tone="warn"] { color: var(--ag-warn); }
    .ctx-seg[data-tone="danger"] { color: var(--ag-danger); }
    .ctx-seg svg { display: block; flex-shrink: 0; }
    #agy-remote-context-detail {
      container-type: inline-size;
    }
    .ctx-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding-bottom: 10px;
    }
    .ctx-sec {
      padding: 10px 0;
      border-top: 1px solid var(--ag-border-sub);
      display: flex;
      flex-direction: column;
      gap: 7px;
    }
    .ctx-sec-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
    }
    .ctx-sec-title {
      font-size: 11.5px;
      font-weight: 600;
      color: var(--ag-secondary);
    }
    .ctx-sec-meta {
      font-size: 11px;
      color: var(--ag-muted);
    }
    .ctx-hero-row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
    }
    .ctx-hero-val {
      font-size: 18px;
      font-weight: 600;
      letter-spacing: -0.02em;
      color: var(--ag-fg);
    }
    .ctx-hero-budget {
      font-size: 12.5px;
      font-weight: 500;
      color: var(--ag-muted);
    }
    .ctx-hero-pct {
      font-size: 12.5px;
      font-weight: 600;
      color: var(--ag-secondary);
    }
    .ctx-hero-pct[data-tone="warn"] { color: var(--ag-warn); }
    .ctx-hero-pct[data-tone="danger"] { color: var(--ag-danger); }
    .progress-track {
      position: relative;
      width: 100%;
      height: 6px;
      border-radius: 999px;
      background: var(--ag-control);
      overflow: visible;
    }
    .progress-fill {
      height: 100%;
      width: 0%;
      border-radius: 999px;
      background: var(--ag-fg);
      transition: width 220ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    .progress-fill[data-tone="warn"] { background: var(--ag-warn); }
    .progress-fill[data-tone="danger"] { background: var(--ag-danger); }
    .ctx-tick {
      position: absolute;
      top: -2px;
      bottom: -2px;
      width: 1.5px;
      border-radius: 1px;
      background: var(--ag-muted);
      opacity: 0.45;
      pointer-events: none;
    }
    .ctx-metrics {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px 12px;
    }
    @container (min-width: 380px) {
      .ctx-metrics {
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 6px 10px;
      }
    }
    .ctx-metric {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .ctx-metric-label { font-size: 10.5px; color: var(--ag-muted); }
    .ctx-metric-value { font-size: 13.5px; font-weight: 600; color: var(--ag-fg); }
    .ctx-subline {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 4px 10px;
      font-size: 11px;
      color: var(--ag-muted);
    }
    .ctx-help {
      padding-top: 8px;
      border-top: 1px solid var(--ag-border-sub);
      font-size: 11px;
      color: var(--ag-muted);
    }
    .ctx-help summary {
      cursor: pointer;
      list-style: none;
      color: var(--ag-muted);
      user-select: none;
    }
    .ctx-help summary::-webkit-details-marker { display: none; }
    .ctx-help ul {
      margin: 6px 0 0;
      padding-left: 14px;
      display: flex;
      flex-direction: column;
      gap: 3px;
      line-height: 1.45;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      padding: 2px 7px;
      border-radius: 999px;
      font-size: 11px;
      background: var(--ag-control);
      color: var(--ag-secondary);
    }
    .chip[data-tone="warn"] { background: rgba(245, 158, 11, 0.14); color: var(--ag-warn); }
    .chip[data-tone="danger"] { background: rgba(239, 68, 68, 0.12); color: var(--ag-danger); }
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      height: 32px;
      padding: 0 13px;
      border-radius: 999px;
      border: none;
      background: var(--ag-control);
      color: var(--ag-fg);
      font-family: inherit;
      font-size: 12.5px;
      font-weight: 500;
      cursor: pointer;
      transition: background-color 140ms cubic-bezier(0.22, 1, 0.36, 1), opacity 140ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    .btn:hover { background: var(--ag-control-hover); }
    .btn:focus-visible, .ctx-pill:focus-visible { outline: 2px solid var(--ag-ring); outline-offset: 2px; }
    .btn-primary { background: var(--ag-primary-bg); color: var(--ag-primary-fg); }
    .btn-primary:hover { background: var(--ag-primary-bg); opacity: 0.88; }
    input[type="text"] {
      height: 34px;
      padding: 0 11px;
      border-radius: 8px;
      border: 1px solid var(--ag-border);
      background: var(--ag-control);
      color: var(--ag-fg);
      font-family: inherit;
      font-size: 13px;
    }
    input[type="text"]:focus-visible { outline: 2px solid var(--ag-ring); outline-offset: 1px; }
  </style>
</head>
<body>
  <header class="toolbar card" id="agy-remote-topbar">
    <span class="badge">Agy-Daddy Remote v${version}</span>
    <button type="button" class="ctx-pill" id="agy-remote-context-drawer" data-panel="showContextPanel" aria-expanded="false" title="点击展开当前对话上下文、累计 Token 与生成速度详情">--</button>
    <span id="agy-remote-usage-drawer" data-panel="showUsagePanel">Usage: --</span>
    <span id="agy-remote-quota-pill" data-panel="showQuotaPill">Quota: --</span>
    <span id="agy-remote-channel-meta" data-panel="showChannelMeta">Channel: Loopback</span>
    <a class="btn" id="agy-switch-channel-btn" href="/entry" hidden>切换通道</a>
    <button type="button" class="btn" id="agy-speed-probe-btn">测速</button>
    <button type="button" class="btn" id="agy-theme-cycle-btn">外观: auto</button>
  </header>
  <section class="card" id="agy-remote-context-detail" data-panel="showContextPanel" hidden>
    <div class="ctx-head">
      <strong id="agy-ctx-detail-model">当前对话实时状态</strong>
      <span class="chip" id="agy-ctx-detail-status" hidden></span>
    </div>
    <div class="ctx-sec">
      <div class="ctx-sec-head">
        <span class="ctx-sec-title">上下文窗口</span>
        <span class="ctx-sec-meta" id="agy-ctx-threshold-text">预警 240K · 断崖 328K</span>
      </div>
      <div class="ctx-hero-row">
        <span class="ctx-hero-val"><span id="agy-ctx-window-used">--</span> <span class="ctx-hero-budget" id="agy-ctx-window-budget">/ --</span></span>
        <span class="ctx-hero-pct" id="agy-ctx-window-pct">--%</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill" id="agy-ctx-window-fill"></div>
        <span class="ctx-tick" id="agy-ctx-tick-warn" hidden></span>
        <span class="ctx-tick" id="agy-ctx-tick-cliff" hidden></span>
      </div>
      <div class="ctx-subline">
        <span id="agy-ctx-remain-text">剩余 --%</span>
        <span id="agy-ctx-cache-text">缓存命中 --%</span>
      </div>
      <div id="agy-ctx-alerts"></div>
    </div>
    <div class="ctx-sec">
      <div class="ctx-sec-head">
        <span class="ctx-sec-title">本对话累计</span>
        <span class="ctx-sec-meta" id="agy-ctx-session-calls">0 次调用</span>
      </div>
      <div class="ctx-metrics">
        <div class="ctx-metric"><span class="ctx-metric-label">总计</span><span class="ctx-metric-value" id="agy-ctx-sess-total">--</span></div>
        <div class="ctx-metric"><span class="ctx-metric-label">输出</span><span class="ctx-metric-value" id="agy-ctx-sess-output">--</span></div>
        <div class="ctx-metric"><span class="ctx-metric-label">缓存读</span><span class="ctx-metric-value" id="agy-ctx-sess-cached">--</span></div>
        <div class="ctx-metric"><span class="ctx-metric-label">新输入</span><span class="ctx-metric-value" id="agy-ctx-sess-input">--</span></div>
      </div>
    </div>
    <div class="ctx-sec">
      <div class="ctx-sec-head">
        <span class="ctx-sec-title">生成速度</span>
        <span class="chip" id="agy-ctx-speed-mode">待采样</span>
      </div>
      <div class="ctx-metrics">
        <div class="ctx-metric"><span class="ctx-metric-label">总速率</span><span class="ctx-metric-value" id="agy-ctx-speed-tps">--</span></div>
        <div class="ctx-metric"><span class="ctx-metric-label">纯吐字</span><span class="ctx-metric-value" id="agy-ctx-speed-stream">--</span></div>
        <div class="ctx-metric"><span class="ctx-metric-label">首字</span><span class="ctx-metric-value" id="agy-ctx-speed-ttft">--</span></div>
        <div class="ctx-metric"><span class="ctx-metric-label">均速</span><span class="ctx-metric-value" id="agy-ctx-speed-avg">--</span></div>
      </div>
    </div>
    <details class="ctx-help">
      <summary>指标说明</summary>
      <ul>
        <li>上下文窗口：单次请求的记忆容量（外环=占用、内环=缓存命中），刻度线对应预警/断崖阈值。</li>
        <li>本对话累计：仅汇总当前对话全轮次模型消耗，与跨会话历史总账相互独立。</li>
        <li>生成速度：总速率含首字等待 (TTFT)，纯吐字仅计流式输出阶段。</li>
      </ul>
    </details>
  </section>
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
        <button type="button" class="btn btn-primary" id="agy-remote-send-btn">发送</button>
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

      function fmtTok(v) {
        if (v === null || v === undefined || !isFinite(Number(v))) return '--';
        var n = Math.max(0, Number(v));
        if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 2).replace(/\.?0+$/, '') + 'M';
        if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '') + 'k';
        return String(Math.round(n));
      }
      function fmtSpd(v) {
        var n = Number(v);
        if (!isFinite(n) || n <= 0) return '';
        return (n >= 100 ? Math.round(n) : Number(n.toFixed(1))) + '/s';
      }
      function ringSvg(occ, hit, risk, drop) {
        var p = Math.max(0, Math.min(100, Math.round(Number(occ) || 0)));
        var h = Math.max(0, Math.min(100, Math.round(Number(hit) || 0)));
        var rO = 6.2, rI = 3.4;
        var cO = Number((2 * Math.PI * rO).toFixed(2)), cI = Number((2 * Math.PI * rI).toFixed(2));
        var dO = Number(((p / 100) * cO).toFixed(2)), dI = Number(((h / 100) * cI).toFixed(2));
        var stroke = (drop || risk === 'critical' || p >= 80) ? 'var(--ag-danger)' : ((risk === 'warn' || p >= 50) ? 'var(--ag-warn)' : 'currentColor');
        return '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">'
          + '<circle cx="8" cy="8" r="' + rO + '" fill="none" stroke="rgba(113,113,122,0.22)" stroke-width="2"/>'
          + '<circle cx="8" cy="8" r="' + rO + '" fill="none" stroke="' + stroke + '" stroke-width="2" stroke-dasharray="' + dO + ' ' + cO + '" transform="rotate(-90 8 8)"/>'
          + '<circle cx="8" cy="8" r="' + rI + '" fill="none" stroke="rgba(113,113,122,0.18)" stroke-width="1.8"/>'
          + '<circle cx="8" cy="8" r="' + rI + '" fill="none" stroke="var(--ag-secondary)" stroke-width="1.8" stroke-dasharray="' + dI + ' ' + cI + '" transform="rotate(-90 8 8)"/>'
          + '</svg>';
      }
      var STACK_SVG = '<svg width="11.5" height="11.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.5 2.5 5.5 8 8.5l5.5-3L8 2.5Z"/><path d="M2.5 8.5 8 11.5l5.5-3"/><path d="M2.5 11.5 8 14.5l5.5-3"/></svg>';
      var BOLT_SVG = '<svg width="11.5" height="11.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.2 1.8 3.6 9h4.1l-.9 5.2L12.4 7H8.3l.9-5.2Z"/></svg>';
      var WARN_SVG = '<svg width="11.5" height="11.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.3 14 13H2L8 2.3Z"/><path d="M8 6.4v3.2"/><circle cx="8" cy="11.4" r="0.55" fill="currentColor" stroke="none"/></svg>';

      var STATUS_MAP = {
        estimated: { text: '估算', tone: '' },
        exceeded: { text: '窗口超限', tone: 'danger' },
        network: { text: '网络异常', tone: 'danger' },
        quota_exhausted: { text: '额度耗尽', tone: 'danger' },
        rate_limited: { text: '请求限流', tone: 'warn' },
        auth_error: { text: '认证异常', tone: 'danger' },
        service_unavailable: { text: '服务过载', tone: 'warn' },
        canceled: { text: '已取消', tone: '' },
        failed: { text: '请求失败', tone: 'danger' }
      };

      function makeSeg(svgMarkup, text, tone) {
        var sp = document.createElement('span');
        sp.className = 'ctx-seg';
        if (tone) sp.setAttribute('data-tone', tone);
        if (svgMarkup) {
          var ic = document.createElement('span');
          ic.innerHTML = svgMarkup;
          sp.appendChild(ic);
        }
        if (text) {
          var tx = document.createElement('span');
          tx.textContent = text;
          sp.appendChild(tx);
        }
        return sp;
      }

      function renderContextMobile(ctxPanel) {
        var pill = document.getElementById('agy-remote-context-drawer');
        if (!pill) return;
        var d = ctxPanel && ctxPanel.available ? ctxPanel.data : null;
        if (!d || !d.hasSession || d.used === null) {
          pill.textContent = '';
          pill.appendChild(makeSeg(ringSvg(0, 0, 'none', false), '--'));
          pill.setAttribute('data-risk', 'none');
          return;
        }
        var su = d.sessionUsage || {};
        var sessTotal = su.totalTokens !== undefined ? su.totalTokens : d.used;
        var spd = fmtSpd((d.speed && d.speed.tps) || d.tokPerSec);
        var risk = d.cacheCliffRisk || 'none';
        var drop = Boolean(d.cacheDropDetected);
        var riskTone = (drop || risk === 'critical') ? 'danger' : (risk === 'warn' ? 'warn' : '');
        pill.textContent = '';
        pill.appendChild(makeSeg(ringSvg(d.percent || 0, d.cacheHitRate || 0, risk, drop), fmtTok(d.used) + '/' + fmtTok(d.budget)));
        pill.appendChild(makeSeg(STACK_SVG, fmtTok(sessTotal)));
        if (spd) pill.appendChild(makeSeg(BOLT_SVG, spd));
        if (riskTone) pill.appendChild(makeSeg(WARN_SVG, '', riskTone));
        pill.setAttribute('data-risk', drop ? 'critical' : risk);

        var setText = function(id, val) {
          var el = document.getElementById(id);
          if (el) el.textContent = val;
        };
        setText('agy-ctx-detail-model', d.model || 'Unknown');
        var stEl = document.getElementById('agy-ctx-detail-status');
        if (stEl) {
          var badge = STATUS_MAP[d.status || ''] || null;
          if (badge) {
            stEl.hidden = false;
            stEl.textContent = badge.text;
            if (badge.tone) stEl.setAttribute('data-tone', badge.tone);
            else stEl.removeAttribute('data-tone');
          } else {
            stEl.hidden = true;
          }
        }
        setText('agy-ctx-window-used', fmtTok(d.used));
        setText('agy-ctx-window-budget', '/ ' + fmtTok(d.budget));
        var pctEl = document.getElementById('agy-ctx-window-pct');
        if (pctEl) {
          pctEl.textContent = (d.percent ?? '--') + '%';
          if (riskTone) pctEl.setAttribute('data-tone', riskTone);
          else pctEl.removeAttribute('data-tone');
        }
        setText('agy-ctx-remain-text', '剩余 ' + (d.remainPercent ?? '--') + '%');
        setText('agy-ctx-cache-text', '缓存命中 ' + (d.cacheHitRate ?? 0) + '% (' + fmtTok(d.cachedTokens) + '/' + fmtTok(d.inputTokens) + ')');
        var warnTok = Number(d.warnThresholdTokens) || 240000;
        var cliffTok = Number(d.cliffThresholdTokens) || 328000;
        setText('agy-ctx-threshold-text', '预警 ' + Math.round(warnTok / 1000) + 'K · 断崖 ' + Math.round(cliffTok / 1000) + 'K');

        var fillEl = document.getElementById('agy-ctx-window-fill');
        if (fillEl) {
          fillEl.style.width = Math.max(0, Math.min(100, Number(d.percent || 0))) + '%';
          if (riskTone) fillEl.setAttribute('data-tone', riskTone);
          else fillEl.removeAttribute('data-tone');
        }
        var budgetNum = Number(d.budget || 0);
        var tWarn = document.getElementById('agy-ctx-tick-warn');
        var tCliff = document.getElementById('agy-ctx-tick-cliff');
        if (tWarn) {
          var wp = budgetNum > 0 ? (warnTok / budgetNum) * 100 : 0;
          tWarn.hidden = !(wp >= 5 && wp <= 95);
          if (!tWarn.hidden) tWarn.style.left = wp.toFixed(1) + '%';
        }
        if (tCliff) {
          var cp = budgetNum > 0 ? (cliffTok / budgetNum) * 100 : 0;
          tCliff.hidden = !(cp >= 5 && cp <= 95);
          if (!tCliff.hidden) tCliff.style.left = cp.toFixed(1) + '%';
        }

        var alertBox = document.getElementById('agy-ctx-alerts');
        if (alertBox) {
          alertBox.textContent = '';
          (d.alerts || []).forEach(function(a) {
            var ch = document.createElement('span');
            ch.className = 'chip';
            ch.textContent = a.message || '';
            if (a.level === 'danger' || a.level === 'warn') ch.setAttribute('data-tone', a.level);
            alertBox.appendChild(ch);
          });
        }
        setText('agy-ctx-session-calls', (su.callsCount || 0) + ' 次调用');
        setText('agy-ctx-sess-total', fmtTok(sessTotal));
        setText('agy-ctx-sess-output', fmtTok(su.outputTokens !== undefined ? su.outputTokens : d.outputTokens));
        setText('agy-ctx-sess-cached', fmtTok(su.cachedTokens !== undefined ? su.cachedTokens : d.cachedTokens));
        setText('agy-ctx-sess-input', fmtTok(su.inputTokens !== undefined ? su.inputTokens : d.inputTokens));

        var curTps = (d.speed && d.speed.tps) || d.tokPerSec;
        setText('agy-ctx-speed-mode', curTps ? '实测' : '待采样');
        setText('agy-ctx-speed-tps', curTps ? (curTps + '/s') : '--');
        setText('agy-ctx-speed-stream', d.speed && d.speed.streamingTps ? (d.speed.streamingTps + '/s') : '--');
        setText('agy-ctx-speed-ttft', (d.speed && d.speed.ttft != null) ? (d.speed.ttft + 's') : '--');
        setText('agy-ctx-speed-avg', su.avgTps ? (su.avgTps + '/s') : '--');
      }

      var ctxPill = document.getElementById('agy-remote-context-drawer');
      var ctxDetail = document.getElementById('agy-remote-context-detail');
      if (ctxPill && ctxDetail) {
        ctxPill.addEventListener('click', function() {
          var nextOpen = Boolean(ctxDetail.hidden);
          ctxDetail.hidden = !nextOpen;
          ctxPill.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
        });
      }

      var token = '';
      var enteredFromLanding = false;
      try {
        var params = new URLSearchParams(window.location.search || '');
        token = params.get('t') || params.get('token') || '';
        enteredFromLanding = params.get('enter') === '1' || params.get('direct') === '1';
      } catch {}
      var switchBtn = document.getElementById('agy-switch-channel-btn');
      if (switchBtn && enteredFromLanding) {
        switchBtn.hidden = false;
        switchBtn.setAttribute('href', token ? ('/entry?t=' + encodeURIComponent(token)) : '/entry');
      }

      var speedProbeBtn = document.getElementById('agy-speed-probe-btn');
      if (speedProbeBtn) {
        speedProbeBtn.addEventListener('click', function() {
          if (typeof fetch !== 'function') return;
          var start = (window.performance && performance.now) ? performance.now() : Date.now();
          speedProbeBtn.textContent = '测速中...';
          fetch('/api/ping', { cache: 'no-store' })
            .then(function(r) {
              var end = (window.performance && performance.now) ? performance.now() : Date.now();
              speedProbeBtn.textContent = r.ok ? ('测速 ' + Math.max(1, Math.round(end - start)) + ' ms') : '测速失败';
            })
            .catch(function() {
              speedProbeBtn.textContent = '测速失败';
            });
        });
      }

      function pollSnapshot() {
        if (!token || typeof fetch !== 'function') return;
        fetch('/api/snapshot', {
          headers: {
            'Authorization': 'Bearer ' + token,
            'X-AG-Client-Id': cid,
            'X-AG-Device-Hint': did
          }
        }).then(function(r) { return r.ok ? r.json() : null; }).then(function(snap) {
          if (!snap || !snap.panels) return;
          renderContextMobile(snap.panels.context);
          var usageEl = document.getElementById('agy-remote-usage-drawer');
          if (usageEl && snap.panels.usage && snap.panels.usage.available && snap.panels.usage.data) {
            var ud = snap.panels.usage.data;
            usageEl.textContent = '累计 ' + fmtTok(ud.totalTokens || 0) + ' · ' + (ud.currencySymbol || '$') + Number(ud.totalDisplayCost != null ? ud.totalDisplayCost : (ud.totalUsd || 0)).toFixed(2);
          }
          var quotaEl = document.getElementById('agy-remote-quota-pill');
          if (quotaEl && snap.panels.quota && snap.panels.quota.available && snap.panels.quota.data) {
            var qd = snap.panels.quota.data;
            quotaEl.textContent = 'G:' + (qd.gemini && qd.gemini.percentText || '--') + ' · C:' + (qd.claude && qd.claude.percentText || '--');
          }
          var chEl = document.getElementById('agy-remote-channel-meta');
          if (chEl && snap.channel) chEl.textContent = 'Channel: ' + snap.channel;
        }).catch(function(){});
      }
      if (token) {
        pollSnapshot();
        setInterval(pollSnapshot, 3000);
      }

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
