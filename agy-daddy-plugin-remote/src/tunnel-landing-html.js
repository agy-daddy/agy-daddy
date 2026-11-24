'use strict';

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getChannelIconSvg(key) {
  switch (key) {
    case 'lan':
      return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1" fill="currentColor" stroke="none"/></svg>';
    case 'bonjour':
      return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="2.2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49"/><path d="M7.76 16.24a6 6 0 0 1 0-8.49"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M4.93 19.07a10 10 0 0 1 0-14.14"/></svg>';
    case 'tailscale':
      return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="7" r="2.2"/><circle cx="18" cy="7" r="2.2"/><circle cx="12" cy="17" r="2.2"/><path d="M8.1 7.8l7.8 0"/><path d="M7.1 8.9l3.8 6.2"/><path d="M16.9 8.9l-3.8 6.2"/></svg>';
    case 'cloudflare':
      return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>';
    default:
      return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="14" rx="2.5"/><path d="M8 21h8"/><path d="M12 18v3"/></svg>';
  }
}

const CHEVRON_RIGHT_SVG = '<svg class="row-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';

function renderChannelRowHtml(entry) {
  const key = escapeHtml(entry.key || 'loopback');
  const label = escapeHtml(entry.label || key);
  const subtitle = escapeHtml(entry.subtitle || '');
  const displayHost = escapeHtml(entry.displayHost || '');
  const enterUrl = escapeHtml(entry.enterUrl || '/');
  return `<a class="channel-row" data-channel-entry="${key}" href="${enterUrl}">
      <div class="channel-icon">${getChannelIconSvg(entry.key)}</div>
      <div class="channel-main">
        <div class="channel-title-line">
          <span class="channel-title">${label}</span>
          <span class="chip chip-rec" data-channel-rec="${key}" hidden>推荐</span>
          ${entry.isCurrent ? '<span class="chip">当前入口</span>' : ''}
        </div>
        ${subtitle ? `<div class="channel-sub">${subtitle}</div>` : ''}
        ${displayHost ? `<div class="channel-host">${displayHost}</div>` : ''}
      </div>
      <div class="channel-side">
        <span class="chip rtt-chip" data-channel-rtt="${key}">测速中...</span>
        ${CHEVRON_RIGHT_SVG}
      </div>
    </a>`;
}

function getChannelLandingCopy(channel, tunnelMode) {
  const ch = String(channel || 'cloudflare').trim().toLowerCase();
  const cfModeLabel = tunnelMode === 'named' ? 'Named 固定隧道' : 'Quick 临时隧道';
  switch (ch) {
    case 'lan':
      return {
        subtitleAuth: '已通过局域网 (Wi-Fi) 接入 · 自动探测更低延迟的可用通道',
        subtitleUnauth: '通过局域网通道访问需要配对令牌，验证后将展示可用通道',
        modeBadge: '局域网直连',
        footnote: '局域网访问导航 · 客户端隔离与令牌鉴权已开启'
      };
    case 'bonjour':
      return {
        subtitleAuth: '已通过 Bonjour (.local) 接入 · 自动探测更低延迟的可用通道',
        subtitleUnauth: '通过 Bonjour (.local) 访问需要配对令牌，验证后将展示可用通道',
        modeBadge: 'Bonjour 局域网',
        footnote: 'Bonjour 局域网导航 · 客户端隔离与令牌鉴权已开启'
      };
    case 'tailscale':
      return {
        subtitleAuth: '已通过 Tailscale 私网接入 · 自动探测更低延迟的可用通道',
        subtitleUnauth: '通过 Tailscale 私网访问需要配对令牌，验证后将展示可用通道',
        modeBadge: 'Tailscale 私网',
        footnote: 'Tailscale 私网导航 · 客户端隔离与令牌鉴权已开启'
      };
    case 'loopback':
      return {
        subtitleAuth: '已通过本机回环 (127.0.0.1) 接入 · 自动探测更低延迟的可用通道',
        subtitleUnauth: '通过本机回环访问需要配对令牌，验证后将展示可用通道',
        modeBadge: '本机回环',
        footnote: '本机调试入口导航 · 客户端隔离与令牌鉴权已开启'
      };
    default:
      return {
        subtitleAuth: '已通过 Cloudflare 隧道接入 · 自动探测更低延迟的可用通道',
        subtitleUnauth: '通过 Cloudflare Tunnel 访问需要配对令牌，验证后将展示可用通道',
        modeBadge: cfModeLabel,
        footnote: 'Cloudflare Tunnel 入口导航 · 客户端隔离与令牌鉴权已开启'
      };
  }
}

function generateTunnelLandingHtml(options = {}) {
  const version = escapeHtml(options.version || '2.0.0');
  const authenticated = options.authenticated === true;
  const writeEnabled = options.writeEnabled === true;
  const tunnelMode = options.tunnelMode === 'named' ? 'named' : 'quick';
  const currentChannel = String(options.currentChannel || 'cloudflare').trim().toLowerCase();
  const channelCopy = getChannelLandingCopy(currentChannel, tunnelMode);
  const currentHost = escapeHtml(options.currentHost || '');
  const entries = authenticated && Array.isArray(options.entries) ? options.entries : [];

  const preferredEntry = entries.find((e) => e.key === currentChannel) || entries.find((e) => e.key === 'cloudflare') || entries[0] || null;
  const defaultCtaHref = escapeHtml(preferredEntry?.enterUrl || '/?enter=1');
  const serializedEntries = JSON.stringify(entries).replace(/</g, '\\u003c');
  const rowsMarkup = entries.map(renderChannelRowHtml).join('\n');

  return `<!doctype html>
<html lang="zh-CN" data-appearance="auto" data-remote-version="${version}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <title>Agy-Daddy 远程访问 · 选择访问通道</title>
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
      --ag-ease: cubic-bezier(0.22, 1, 0.36, 1);
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
      min-height: 100dvh;
      padding: 24px 16px calc(28px + env(safe-area-inset-bottom, 0px));
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif;
      font-size: 13px;
      line-height: 1.45;
      font-variant-numeric: tabular-nums;
      -webkit-font-smoothing: antialiased;
      background: var(--ag-bg);
      color: var(--ag-fg);
      display: flex;
      justify-content: center;
    }
    .shell {
      width: 100%;
      max-width: 520px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      font-weight: 600;
      color: var(--ag-fg);
    }
    .brand-mark {
      width: 26px;
      height: 26px;
      border-radius: 8px;
      background: var(--ag-control);
      border: 1px solid var(--ag-border);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--ag-fg);
      flex-shrink: 0;
    }
    .topbar-actions {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .hero {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 4px 2px 0;
    }
    .hero-title {
      margin: 0;
      font-size: 22px;
      font-weight: 650;
      letter-spacing: -0.02em;
      color: var(--ag-fg);
    }
    .hero-sub {
      margin: 0;
      font-size: 13px;
      color: var(--ag-muted);
    }
    .hero-pills {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 2px;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 9px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 500;
      background: var(--ag-control);
      color: var(--ag-secondary);
      white-space: nowrap;
    }
    .chip-rec {
      background: var(--ag-primary-bg);
      color: var(--ag-primary-fg);
      font-weight: 600;
    }
    .chip[data-tone="warn"] {
      background: rgba(245, 158, 11, 0.14);
      color: var(--ag-warn);
    }
    .chip[data-tone="muted"] {
      color: var(--ag-muted);
    }
    .landing-card {
      background: var(--ag-card);
      border: 1px solid var(--ag-border);
      border-radius: 14px;
      overflow: hidden;
    }
    .channel-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 13px 15px;
      color: inherit;
      text-decoration: none;
      transition: background-color 140ms var(--ag-ease);
    }
    .channel-row + .channel-row {
      border-top: 1px solid var(--ag-border-sub);
    }
    .channel-row:hover {
      background: var(--ag-subcard);
    }
    .channel-row:focus-visible {
      outline: 2px solid var(--ag-ring);
      outline-offset: -2px;
    }
    .channel-icon {
      width: 36px;
      height: 36px;
      border-radius: 10px;
      background: var(--ag-subcard);
      border: 1px solid var(--ag-border);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--ag-fg);
      flex-shrink: 0;
    }
    .channel-main {
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .channel-title-line {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .channel-title {
      font-size: 13.5px;
      font-weight: 600;
      color: var(--ag-fg);
    }
    .channel-sub {
      font-size: 12px;
      color: var(--ag-muted);
    }
    .channel-host {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11px;
      color: var(--ag-secondary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .channel-side {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    .row-chevron {
      color: var(--ag-muted);
      flex-shrink: 0;
    }
    .auth-card {
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .auth-label {
      font-size: 13px;
      font-weight: 600;
      color: var(--ag-fg);
    }
    .auth-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .auth-input {
      flex: 1 1 200px;
      min-width: 0;
      height: 36px;
      padding: 0 12px;
      border-radius: 999px;
      border: 1px solid var(--ag-border);
      background: var(--ag-control);
      color: var(--ag-fg);
      font-family: inherit;
      font-size: 13px;
    }
    .auth-input:focus-visible {
      outline: 2px solid var(--ag-ring);
      outline-offset: 1px;
    }
    .auth-error {
      font-size: 12px;
      color: var(--ag-danger);
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      height: 30px;
      padding: 0 12px;
      border-radius: 999px;
      border: none;
      background: var(--ag-control);
      color: var(--ag-fg);
      font-family: inherit;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      text-decoration: none;
      white-space: nowrap;
      transition: background-color 140ms var(--ag-ease), opacity 140ms var(--ag-ease);
    }
    .btn:hover { background: var(--ag-control-hover); }
    .btn:focus-visible { outline: 2px solid var(--ag-ring); outline-offset: 2px; }
    .btn-primary {
      height: 38px;
      padding: 0 18px;
      font-size: 13px;
      font-weight: 600;
      background: var(--ag-primary-bg);
      color: var(--ag-primary-fg);
    }
    .btn-primary:hover {
      background: var(--ag-primary-bg);
      opacity: 0.9;
    }
    .cta-wrap {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .cta-btn {
      width: 100%;
    }
    .footnote {
      text-align: center;
      font-size: 11.5px;
      color: var(--ag-muted);
    }
    .mixed-hint-box {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
      padding: 10px 13px;
      border-radius: 12px;
      background: var(--ag-subcard);
      border: 1px solid var(--ag-border);
    }
    .mixed-hint-text {
      flex: 1 1 240px;
      font-size: 11.5px;
      line-height: 1.45;
      color: var(--ag-muted);
    }
  </style>
</head>
<body id="agy-tunnel-landing">
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <rect x="3.5" y="1.5" width="7" height="11" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/>
            <circle cx="7" cy="10.2" r="0.8" fill="currentColor"/>
          </svg>
        </span>
        <span>远程访问</span>
        <span class="chip">v${version}</span>
      </div>
      <div class="topbar-actions">
        <button type="button" class="btn" id="agy-landing-reprobe-btn" ${authenticated ? '' : 'hidden'}>重新测速</button>
        <button type="button" class="btn" id="agy-landing-theme-btn">外观: 自动</button>
      </div>
    </header>

    <section class="hero">
      <h1 class="hero-title" id="agy-landing-title">${authenticated ? '选择访问通道' : '验证访问令牌'}</h1>
      <p class="hero-sub" id="agy-landing-subtitle">${authenticated
        ? escapeHtml(channelCopy.subtitleAuth)
        : escapeHtml(channelCopy.subtitleUnauth)}</p>
      <div class="hero-pills">
        <span class="chip" id="agy-landing-write-pill"${writeEnabled ? ' data-tone="warn"' : ''}>${writeEnabled ? '可写模式' : '只读模式'}</span>
        <span class="chip" id="agy-landing-mode-pill">${escapeHtml(channelCopy.modeBadge)}</span>
        ${currentHost ? `<span class="chip">${currentHost}</span>` : ''}
      </div>
    </section>

    <section class="landing-card auth-card" id="agy-landing-auth-card" ${authenticated ? 'hidden' : ''}>
      <label class="auth-label" for="agy-landing-token-input">配对令牌 (Pairing Token)</label>
      <div class="auth-row">
        <input type="password" class="auth-input" id="agy-landing-token-input" autocomplete="off" placeholder="输入远程配对令牌" />
        <button type="button" class="btn btn-primary" id="agy-landing-unlock-btn">验证并查看通道</button>
      </div>
      <div class="auth-error" id="agy-landing-auth-error" hidden></div>
    </section>

    <section class="landing-card" id="agy-landing-channels" ${authenticated ? '' : 'hidden'}>
      ${rowsMarkup}
    </section>

    <div class="mixed-hint-box" id="agy-landing-mixed-hint" hidden>
      <span class="mixed-hint-text">HTTPS 隧道页受浏览器混合内容限制，无法在后台测速 HTTP 内网地址；可一键切换 HTTP 页测全通道延迟，或直接点击上方通道连接。</span>
      <a class="btn" id="agy-landing-http-probe-link" href="/entry" hidden>切换 HTTP 全通道测速</a>
    </div>

    <div class="cta-wrap" id="agy-landing-cta-wrap" ${authenticated ? '' : 'hidden'}>
      <a class="btn btn-primary cta-btn" id="agy-landing-primary-cta" href="${defaultCtaHref}">进入远程控制台</a>
      <div class="footnote" id="agy-landing-footnote">${escapeHtml(channelCopy.footnote)}</div>
    </div>
  </div>

  <script>
    (function() {
      try {
        var sp = new URLSearchParams(window.location.search || '');
        var urlToken = sp.get('t') || sp.get('token') || '';
        if (urlToken && window.history && typeof window.history.replaceState === 'function') {
          sp.delete('t');
          sp.delete('token');
          var rest = sp.toString();
          window.history.replaceState(null, '', rest ? (window.location.pathname + '?' + rest) : window.location.pathname);
        }
      } catch {}

      var INITIAL_CHANNEL = ${JSON.stringify(currentChannel)};
      function resolveChannelCopy(ch, tMode) {
        var key = String(ch || 'cloudflare').toLowerCase();
        if (key === 'lan') return { sub: '已通过局域网 (Wi-Fi) 接入 · 自动探测更低延迟的可用通道', badge: '局域网直连', foot: '局域网访问导航 · 客户端隔离与令牌鉴权已开启' };
        if (key === 'bonjour') return { sub: '已通过 Bonjour (.local) 接入 · 自动探测更低延迟的可用通道', badge: 'Bonjour 局域网', foot: 'Bonjour 局域网导航 · 客户端隔离与令牌鉴权已开启' };
        if (key === 'tailscale') return { sub: '已通过 Tailscale 私网接入 · 自动探测更低延迟的可用通道', badge: 'Tailscale 私网', foot: 'Tailscale 私网导航 · 客户端隔离与令牌鉴权已开启' };
        if (key === 'loopback') return { sub: '已通过本机回环 (127.0.0.1) 接入 · 自动探测更低延迟的可用通道', badge: '本机回环', foot: '本机调试入口导航 · 客户端隔离与令牌鉴权已开启' };
        return { sub: '已通过 Cloudflare 隧道接入 · 自动探测更低延迟的可用通道', badge: tMode === 'named' ? 'Named 固定隧道' : 'Quick 临时隧道', foot: 'Cloudflare Tunnel 入口导航 · 客户端隔离与令牌鉴权已开启' };
      }

      var APPEARANCE_KEY = 'agy_remote_appearance';
      var MODES = ['auto', 'light', 'dark'];
      var MODE_LABELS = { auto: '外观: 自动', light: '外观: 浅色', dark: '外观: 深色' };
      var root = document.documentElement;
      var themeBtn = document.getElementById('agy-landing-theme-btn');

      function applyAppearance(mode) {
        var next = MODES.indexOf(mode) >= 0 ? mode : 'auto';
        root.setAttribute('data-appearance', next);
        if (themeBtn) themeBtn.textContent = MODE_LABELS[next];
        try { localStorage.setItem(APPEARANCE_KEY, next); } catch {}
      }
      var savedAppearance = 'auto';
      try { savedAppearance = localStorage.getItem(APPEARANCE_KEY) || 'auto'; } catch {}
      applyAppearance(savedAppearance);
      if (themeBtn) {
        themeBtn.addEventListener('click', function() {
          var cur = root.getAttribute('data-appearance') || 'auto';
          var idx = (MODES.indexOf(cur) + 1) % MODES.length;
          applyAppearance(MODES[idx]);
        });
      }

      var currentEntries = ${serializedEntries};
      var channelsCard = document.getElementById('agy-landing-channels');
      var ctaWrap = document.getElementById('agy-landing-cta-wrap');
      var primaryCta = document.getElementById('agy-landing-primary-cta');
      var reprobeBtn = document.getElementById('agy-landing-reprobe-btn');
      var authCard = document.getElementById('agy-landing-auth-card');
      var tokenInput = document.getElementById('agy-landing-token-input');
      var unlockBtn = document.getElementById('agy-landing-unlock-btn');
      var authErr = document.getElementById('agy-landing-auth-error');
      var titleEl = document.getElementById('agy-landing-title');
      var subEl = document.getElementById('agy-landing-subtitle');
      var writePill = document.getElementById('agy-landing-write-pill');
      var modePill = document.getElementById('agy-landing-mode-pill');
      var mixedHintEl = document.getElementById('agy-landing-mixed-hint');
      var httpProbeLink = document.getElementById('agy-landing-http-probe-link');

      var ICONS = {
        lan: ${JSON.stringify(getChannelIconSvg('lan'))},
        bonjour: ${JSON.stringify(getChannelIconSvg('bonjour'))},
        tailscale: ${JSON.stringify(getChannelIconSvg('tailscale'))},
        cloudflare: ${JSON.stringify(getChannelIconSvg('cloudflare'))},
        loopback: ${JSON.stringify(getChannelIconSvg('loopback'))}
      };

      function renderEntriesDom(entries) {
        if (!channelsCard) return;
        channelsCard.textContent = '';
        entries.forEach(function(entry) {
          var a = document.createElement('a');
          a.className = 'channel-row';
          a.setAttribute('data-channel-entry', entry.key || '');
          a.setAttribute('href', entry.enterUrl || '/');

          var iconBox = document.createElement('div');
          iconBox.className = 'channel-icon';
          iconBox.innerHTML = ICONS[entry.key] || ICONS.loopback;
          a.appendChild(iconBox);

          var main = document.createElement('div');
          main.className = 'channel-main';

          var tLine = document.createElement('div');
          tLine.className = 'channel-title-line';
          var tSpan = document.createElement('span');
          tSpan.className = 'channel-title';
          tSpan.textContent = entry.label || entry.key;
          tLine.appendChild(tSpan);

          var recChip = document.createElement('span');
          recChip.className = 'chip chip-rec';
          recChip.setAttribute('data-channel-rec', entry.key || '');
          recChip.hidden = true;
          recChip.textContent = '推荐';
          tLine.appendChild(recChip);

          if (entry.isCurrent) {
            var curChip = document.createElement('span');
            curChip.className = 'chip';
            curChip.textContent = '当前入口';
            tLine.appendChild(curChip);
          }
          main.appendChild(tLine);

          if (entry.subtitle) {
            var sub = document.createElement('div');
            sub.className = 'channel-sub';
            sub.textContent = entry.subtitle;
            main.appendChild(sub);
          }
          if (entry.displayHost) {
            var host = document.createElement('div');
            host.className = 'channel-host';
            host.textContent = entry.displayHost;
            main.appendChild(host);
          }
          a.appendChild(main);

          var side = document.createElement('div');
          side.className = 'channel-side';
          var rtt = document.createElement('span');
          rtt.className = 'chip rtt-chip';
          rtt.setAttribute('data-channel-rtt', entry.key || '');
          rtt.textContent = '测速中...';
          side.appendChild(rtt);
          var chev = document.createElement('span');
          chev.innerHTML = ${JSON.stringify(CHEVRON_RIGHT_SVG)};
          side.appendChild(chev.firstChild);
          a.appendChild(side);

          channelsCard.appendChild(a);
        });
      }

      function isMixedHttpProbe(entry) {
        if (!entry || entry.key === 'cloudflare') return false;
        var targetUrl = String(entry.probeUrl || entry.enterUrl || '');
        return window.location && window.location.protocol === 'https:' && /^http:\/\//i.test(targetUrl);
      }

      function imageProbe(entryKey, imgUrl) {
        return new Promise(function(resolve) {
          if (!imgUrl) {
            resolve({ key: entryKey, ok: false, rtt: null });
            return;
          }
          var start = (window.performance && performance.now) ? performance.now() : Date.now();
          var done = false;
          var img = new Image();
          var timer = setTimeout(function() {
            if (done) return;
            done = true;
            img.onload = null;
            img.onerror = null;
            resolve({ key: entryKey, ok: false, rtt: null });
          }, 1800);
          img.onload = function() {
            if (done) return;
            done = true;
            clearTimeout(timer);
            var end = (window.performance && performance.now) ? performance.now() : Date.now();
            resolve({ key: entryKey, ok: true, rtt: Math.max(1, Math.round(end - start)) });
          };
          img.onerror = function() {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ key: entryKey, ok: false, rtt: null });
          };
          img.src = imgUrl + (imgUrl.indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now();
        });
      }

      function probeOne(entry) {
        if (isMixedHttpProbe(entry)) {
          return Promise.resolve({ key: entry.key, ok: false, rtt: null, blockedByHttps: true });
        }
        var probeTarget = entry.probeUrl || (entry.key === 'cloudflare' ? '/api/ping' : '');
        if (!probeTarget) {
          return Promise.resolve({ key: entry.key, ok: false, rtt: null });
        }
        if (typeof fetch !== 'function') {
          return imageProbe(entry.key, entry.fallbackProbeUrl || '');
        }
        return new Promise(function(resolve) {
          var start = (window.performance && performance.now) ? performance.now() : Date.now();
          var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
          var settled = false;
          var timer = setTimeout(function() {
            if (settled) return;
            settled = true;
            try { if (ctrl) ctrl.abort(); } catch {}
            resolve({ key: entry.key, ok: false, rtt: null });
          }, 2000);
          var fetchOpts = { cache: 'no-store' };
          if (ctrl) fetchOpts.signal = ctrl.signal;
          fetch(probeTarget, fetchOpts)
            .then(function(r) {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              if (!r.ok) {
                resolve({ key: entry.key, ok: false, rtt: null });
                return;
              }
              var end = (window.performance && performance.now) ? performance.now() : Date.now();
              resolve({ key: entry.key, ok: true, rtt: Math.max(1, Math.round(end - start)) });
            })
            .catch(function() {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              if (entry.fallbackProbeUrl) {
                imageProbe(entry.key, entry.fallbackProbeUrl).then(resolve);
                return;
              }
              resolve({ key: entry.key, ok: false, rtt: null });
            });
        });
      }

      function runProbes() {
        if (!Array.isArray(currentEntries) || currentEntries.length === 0) return;
        currentEntries.forEach(function(e) {
          var rttEl = document.querySelector('[data-channel-rtt="' + e.key + '"]');
          if (rttEl) {
            rttEl.textContent = isMixedHttpProbe(e) ? '点击直连' : '测速中...';
            rttEl.removeAttribute('data-tone');
          }
          var recEl = document.querySelector('[data-channel-rec="' + e.key + '"]');
          if (recEl) recEl.hidden = true;
        });

        Promise.all(currentEntries.map(probeOne)).then(function(results) {
          var byKey = {};
          var hasMixedBlocked = false;
          results.forEach(function(res) {
            byKey[res.key] = res;
            if (res.blockedByHttps) hasMixedBlocked = true;
            var rttEl = document.querySelector('[data-channel-rtt="' + res.key + '"]');
            if (!rttEl) return;
            if (res.blockedByHttps) {
              rttEl.textContent = '点击直连';
              rttEl.removeAttribute('data-tone');
            } else if (res.ok && res.rtt !== null) {
              rttEl.textContent = res.rtt + ' ms';
              rttEl.removeAttribute('data-tone');
            } else {
              rttEl.textContent = '未检测到直连';
              rttEl.setAttribute('data-tone', 'muted');
            }
          });

          if (mixedHintEl) mixedHintEl.hidden = !hasMixedBlocked;
          if (httpProbeLink) {
            if (hasMixedBlocked) {
              var hopOrder = ['lan', 'tailscale', 'bonjour', 'loopback'];
              var hopEntry = null;
              for (var hi = 0; hi < hopOrder.length && !hopEntry; hi++) {
                hopEntry = currentEntries.find(function(e) { return e.key === hopOrder[hi] && e.httpEntryUrl; }) || null;
              }
              if (hopEntry) {
                httpProbeLink.setAttribute('href', hopEntry.httpEntryUrl);
                httpProbeLink.hidden = false;
              } else {
                httpProbeLink.hidden = true;
              }
            } else {
              httpProbeLink.hidden = true;
            }
          }

          var reachable = currentEntries.filter(function(e) {
            return byKey[e.key] && byKey[e.key].ok && byKey[e.key].rtt !== null;
          });
          var localBest = reachable
            .filter(function(e) { return e.key !== 'cloudflare'; })
            .sort(function(a, b) { return byKey[a.key].rtt - byKey[b.key].rtt; })[0] || null;
          var cfRes = byKey.cloudflare;
          var cfEntry = currentEntries.find(function(e) { return e.key === 'cloudflare'; }) || currentEntries[0];
          var best = cfEntry;
          if (localBest && (!cfRes || !cfRes.ok || byKey[localBest.key].rtt < cfRes.rtt)) {
            best = localBest;
          }
          if (best) {
            var recEl = document.querySelector('[data-channel-rec="' + best.key + '"]');
            if (recEl) recEl.hidden = false;
            if (primaryCta) {
              primaryCta.setAttribute('href', best.enterUrl || '/?enter=1');
              primaryCta.textContent = '通过 ' + (best.label || best.key) + ' 进入控制台';
            }
          }
        });
      }

      if (reprobeBtn) {
        reprobeBtn.addEventListener('click', runProbes);
      }

      function unlockWithToken() {
        var val = tokenInput ? String(tokenInput.value || '').trim() : '';
        if (!val) {
          if (authErr) {
            authErr.textContent = '请输入远程配对令牌';
            authErr.hidden = false;
          }
          return;
        }
        if (authErr) authErr.hidden = true;
        fetch('/api/channels', {
          headers: { 'Authorization': 'Bearer ' + val }
        }).then(function(r) {
          if (!r.ok) throw new Error('UNAUTHORIZED');
          return r.json();
        }).then(function(data) {
          currentEntries = Array.isArray(data.entries) ? data.entries : [];
          renderEntriesDom(currentEntries);
          if (authCard) authCard.hidden = true;
          if (channelsCard) channelsCard.hidden = false;
          if (ctaWrap) ctaWrap.hidden = false;
          if (reprobeBtn) reprobeBtn.hidden = false;
          if (titleEl) titleEl.textContent = '选择访问通道';
          var unlockedCopy = resolveChannelCopy(data.channel || INITIAL_CHANNEL, data.tunnelMode);
          var footEl = document.getElementById('agy-landing-footnote');
          if (subEl) subEl.textContent = unlockedCopy.sub;
          if (writePill) {
            writePill.textContent = data.writeEnabled ? '可写模式' : '只读模式';
            if (data.writeEnabled) writePill.setAttribute('data-tone', 'warn');
            else writePill.removeAttribute('data-tone');
          }
          if (modePill) {
            modePill.textContent = unlockedCopy.badge;
          }
          if (footEl) {
            footEl.textContent = unlockedCopy.foot;
          }
          var cf = currentEntries.find(function(e) { return e.key === (data.channel || INITIAL_CHANNEL); }) || currentEntries.find(function(e) { return e.key === 'cloudflare'; }) || currentEntries[0];
          if (primaryCta && cf) {
            primaryCta.setAttribute('href', cf.enterUrl || '/?enter=1');
          }
          runProbes();
        }).catch(function() {
          if (authErr) {
            authErr.textContent = '配对令牌无效，请检查后重试';
            authErr.hidden = false;
          }
        });
      }

      if (unlockBtn) unlockBtn.addEventListener('click', unlockWithToken);
      if (tokenInput) {
        tokenInput.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') unlockWithToken();
        });
      }

      if (currentEntries.length > 0) {
        runProbes();
      }
    })();
  </script>
</body>
</html>`;
}

module.exports = {
  escapeHtml,
  generateTunnelLandingHtml
};
