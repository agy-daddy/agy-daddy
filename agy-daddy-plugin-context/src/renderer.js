'use strict';

const { formatTokensShort, getRingAccentToken } = require('./context-analyzer');
const { createPulseCapsuleController } = require('./pulse-capsule');

let disposers = [];

function formatTopbarRingLabel(snapshot, showSpeed = true) {
  if (!snapshot || !snapshot.hasSession || snapshot.used === null) {
    return 'Ctx --';
  }
  const pct = snapshot.percent !== null ? `${snapshot.percent}%` : '--';
  const ratio = `${formatTokensShort(snapshot.used)}/${formatTokensShort(snapshot.budget)}`;
  const speed = showSpeed && snapshot.speed?.tps ? ` · ${snapshot.speed.tps}/s` : '';
  return `Ctx ${pct} (${ratio}${speed})`;
}

function buildTopbarRingSvg(percent = 0, color = 'var(--ag-custom-token-accent, #a78bfa)') {
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  const r = 5.2;
  const c = Number((2 * Math.PI * r).toFixed(2));
  const dash = Number(((pct / 100) * c).toFixed(2));
  return `<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">`
    + `<circle cx="7" cy="7" r="${r}" fill="none" stroke="rgba(167,139,250,0.24)" stroke-width="2"/>`
    + `<circle cx="7" cy="7" r="${r}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-dasharray="${dash} ${c}" transform="rotate(-90 7 7)"/>`
    + `</svg>`;
}

function resolveGroupTokens(groupVal) {
  if (typeof groupVal === 'number') return groupVal;
  if (!groupVal || typeof groupVal !== 'object') return 0;
  return Number(groupVal.tokens ?? groupVal.high ?? groupVal.low ?? 0) || 0;
}

function renderPanelHtml(snapshot, onRescan) {
  if (!snapshot || !snapshot.hasSession) {
    return '暂无活跃 Antigravity 会话，点击重新扫描以采样。';
  }
  const lines = [
    `模型: ${snapshot.model || 'Unknown'} (${snapshot.status})`,
    `占用: ${formatTokensShort(snapshot.used)} / ${formatTokensShort(snapshot.budget)} (${snapshot.percent ?? '--'}%)`,
    `输入/缓存/命中率: ${formatTokensShort(snapshot.inputTokens)} / ${formatTokensShort(snapshot.cachedTokens)} / ${snapshot.cacheHitRate ?? 0}%`,
    `输出/速率: ${formatTokensShort(snapshot.outputTokens)} · ${snapshot.speed?.tps ?? '--'} tok/s`,
    `附件: ${snapshot.attachments?.totals?.count || 0} 项 (高估 ${formatTokensShort(snapshot.attachments?.totals?.high || 0)})`
  ];
  if (snapshot.groups && typeof snapshot.groups === 'object') {
    const g = snapshot.groups;
    const partText = ['system', 'user', 'assistant', 'tool', 'thinking']
      .filter((k) => g[k] !== undefined || (k === 'tool' && g.tools !== undefined))
      .map((k) => `${k}:${formatTokensShort(resolveGroupTokens(g[k] ?? (k === 'tool' ? g.tools : 0)))}`)
      .join(' | ');
    if (partText) lines.push(`结构拆解(5组): ${partText}`);
  }
  if (snapshot.referenceCost && snapshot.referenceCost.totalUsd !== undefined) {
    lines.push(`参考费用: $${Number(snapshot.referenceCost.totalUsd).toFixed(4)}`);
  }
  if (Array.isArray(snapshot.alerts) && snapshot.alerts.length) {
    lines.push(`提示: ${snapshot.alerts.map((a) => a.message).join('；')}`);
  }
  if (typeof onRescan === 'function' && snapshot.__triggerRescan) {
    onRescan();
  }
  return lines.join('\n');
}

const SEG_COLORS = [
  'var(--ag-custom-heat-lvl-4, #a78bfa)',
  'var(--ag-custom-heat-lvl-3, #9053f8)',
  'var(--ag-custom-heat-lvl-2, #652ab7)',
  'var(--ag-ring-warn, #f59e0b)',
  'var(--ag-text-muted, #71717a)'
];

async function mount(ctx) {
  let settings = {
    showPulseCapsule: true,
    showSpeedInTopbar: true,
    pollIntervalMs: 3000,
    warnThresholdTokens: 240000,
    cliffThresholdTokens: 328000
  };
  let latestSnapshot = null;
  let latestQuota = null;
  let unitNode = null;
  let panelNode = null;
  let popoverHandle = null;

  try {
    const savedRes = await ctx.bridge.post('/settings', { action: 'get' });
    if (savedRes?.ok && savedRes.values) {
      settings = { ...settings, ...savedRes.values };
    }
  } catch {}

  function buildEl(docRef, tag, cls, text) {
    const el = docRef.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function updatePanelDom(snap) {
    if (!panelNode) return;
    const docRef = panelNode.ownerDocument || globalThis.document;
    if (!docRef?.createElement) {
      panelNode.textContent = renderPanelHtml(snap);
      return;
    }

    panelNode.textContent = '';

    const head = buildEl(docRef, 'div', 'ag-panel-head');
    const titleWrap = buildEl(docRef, 'div', 'ag-panel-title-wrap');
    titleWrap.appendChild(buildEl(docRef, 'span', 'ag-panel-title', snap?.hasSession ? (snap.model || 'Unknown') : '上下文实时监测'));
    if (snap?.hasSession) {
      const chip = buildEl(docRef, 'span', 'ag-chip', snap.status || 'active');
      if (snap.cacheCliffRisk === 'critical' || snap.cacheDropDetected) chip.setAttribute('data-tone', 'danger');
      else if (snap.cacheCliffRisk === 'warn') chip.setAttribute('data-tone', 'warn');
      titleWrap.appendChild(chip);
    }
    head.appendChild(titleWrap);

    const actions = buildEl(docRef, 'div', 'ag-panel-actions');
    const rescanBtn = buildEl(docRef, 'button', 'ag-btn ag-btn-primary', '↻ 重新扫描');
    rescanBtn.type = 'button';
    rescanBtn.addEventListener('click', () => { void refresh(true); });
    const closeBtn = buildEl(docRef, 'button', 'ag-icon-btn', '✕');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', () => { popoverHandle?.toggle(false); });
    actions.appendChild(rescanBtn);
    actions.appendChild(closeBtn);
    head.appendChild(actions);
    panelNode.appendChild(head);

    if (!snap || !snap.hasSession) {
      const empty = buildEl(docRef, 'div', 'settings-card-box');
      empty.appendChild(buildEl(docRef, 'div', 'ag-muted', '暂无活跃 Antigravity 会话，点击重新扫描以采样。'));
      panelNode.appendChild(empty);
      return;
    }

    // 1. 主占用进度卡
    const pct = Math.max(0, Math.min(100, Number(snap.percent || 0)));
    const barCard = buildEl(docRef, 'div', 'settings-card-box');
    const barMeta = buildEl(docRef, 'div', 'ag-bar-meta');
    barMeta.appendChild(buildEl(docRef, 'span', '', `占用: ${formatTokensShort(snap.used)} / ${formatTokensShort(snap.budget)}`));
    barMeta.appendChild(buildEl(docRef, 'span', 'ag-chip', `${snap.percent ?? '--'}%`));
    barCard.appendChild(barMeta);

    const track = buildEl(docRef, 'div', 'ag-progress-track');
    const fill = buildEl(docRef, 'div', 'ag-progress-fill');
    if (snap.cacheCliffRisk === 'critical' || snap.cacheDropDetected) fill.setAttribute('data-tone', 'danger');
    else if (snap.cacheCliffRisk === 'warn') fill.setAttribute('data-tone', 'warn');
    fill.style?.setProperty?.('width', `${pct}%`);
    track.appendChild(fill);
    barCard.appendChild(track);

    const hintRow = buildEl(docRef, 'div', 'ag-bar-meta');
    hintRow.appendChild(buildEl(docRef, 'span', 'ag-muted', `预警 ${Math.round(settings.warnThresholdTokens / 1000)}K · 断崖 ${Math.round(settings.cliffThresholdTokens / 1000)}K`));
    if (snap.remainPercent !== null && snap.remainPercent !== undefined) {
      hintRow.appendChild(buildEl(docRef, 'span', 'ag-muted', `剩余 ${snap.remainPercent}%`));
    }
    barCard.appendChild(hintRow);
    panelNode.appendChild(barCard);

    // 2. 四格 KPI 卡
    const kpiGrid = buildEl(docRef, 'div', 'ag-kpi-grid');
    const kpis = [
      { label: '输入 Tokens', value: formatTokensShort(snap.inputTokens) },
      { label: '缓存读取', value: formatTokensShort(snap.cachedTokens) },
      { label: '缓存命中率', value: `${snap.cacheHitRate ?? 0}%` },
      { label: '生成速率', value: snap.speed?.tps ? `${snap.speed.tps} tok/s` : '--' }
    ];
    for (const k of kpis) {
      const cell = buildEl(docRef, 'div', 'ag-kpi-cell');
      cell.appendChild(buildEl(docRef, 'span', 'ag-kpi-label', k.label));
      cell.appendChild(buildEl(docRef, 'span', 'ag-kpi-value', k.value));
      kpiGrid.appendChild(cell);
    }
    const kpiCard = buildEl(docRef, 'div', 'settings-card-box');
    kpiCard.appendChild(kpiGrid);
    panelNode.appendChild(kpiCard);

    // 3. 5 组结构拆解条
    if (snap.groups && typeof snap.groups === 'object') {
      const g = snap.groups;
      const defs = [
        { key: 'system', label: 'system', val: resolveGroupTokens(g.system) },
        { key: 'user', label: 'user', val: resolveGroupTokens(g.user) },
        { key: 'assistant', label: 'assistant', val: resolveGroupTokens(g.assistant) },
        { key: 'tool', label: 'tool', val: resolveGroupTokens(g.tool ?? g.tools) },
        { key: 'thinking', label: 'thinking', val: resolveGroupTokens(g.thinking ?? g.summaries) }
      ].filter((d) => g[d.key] !== undefined || (d.key === 'tool' && g.tools !== undefined) || (d.key === 'thinking' && g.summaries !== undefined));

      if (defs.length) {
        const gCard = buildEl(docRef, 'div', 'settings-card-box');
        const gTitle = buildEl(docRef, 'div', 'ag-card-title', '结构拆解(5组)');
        gCard.appendChild(gTitle);
        const total = defs.reduce((acc, d) => acc + d.val, 0) || 1;
        const segTrack = buildEl(docRef, 'div', 'ag-seg-track');
        const segLegend = buildEl(docRef, 'div', 'ag-seg-legend');
        defs.forEach((d, idx) => {
          const share = Math.max(0, (d.val / total) * 100);
          const color = SEG_COLORS[idx % SEG_COLORS.length];
          if (share > 0) {
            const seg = buildEl(docRef, 'div');
            seg.style?.setProperty?.('width', `${share.toFixed(1)}%`);
            seg.style?.setProperty?.('background', color);
            segTrack.appendChild(seg);
          }
          const item = buildEl(docRef, 'span', 'ag-seg-item');
          const dot = buildEl(docRef, 'span', 'ag-seg-dot');
          dot.style?.setProperty?.('background', color);
          item.appendChild(dot);
          item.appendChild(buildEl(docRef, 'span', '', `${d.label}: ${formatTokensShort(d.val)}`));
          segLegend.appendChild(item);
        });
        gCard.appendChild(segTrack);
        gCard.appendChild(segLegend);
        panelNode.appendChild(gCard);
      }
    }

    // 4. 附件、费用与告警
    const footCard = buildEl(docRef, 'div', 'settings-card-box');
    const attRow = buildEl(docRef, 'div', 'ag-bar-meta');
    attRow.appendChild(buildEl(docRef, 'span', 'ag-muted', `附件: ${snap.attachments?.totals?.count || 0} 项 (高估 ${formatTokensShort(snap.attachments?.totals?.high || 0)})`));
    if (snap.referenceCost && snap.referenceCost.totalUsd !== undefined) {
      attRow.appendChild(buildEl(docRef, 'span', 'ag-chip', `参考 $${Number(snap.referenceCost.totalUsd).toFixed(4)}`));
    }
    footCard.appendChild(attRow);
    if (Array.isArray(snap.alerts) && snap.alerts.length) {
      const alertRow = buildEl(docRef, 'div', 'ag-channels-row');
      for (const a of snap.alerts) {
        const chip = buildEl(docRef, 'span', 'ag-chip', a.message);
        chip.setAttribute('data-tone', a.level === 'danger' ? 'danger' : (a.level === 'warn' ? 'warn' : 'muted'));
        alertRow.appendChild(chip);
      }
      footCard.appendChild(alertRow);
    }
    panelNode.appendChild(footCard);
  }

  function updateUnitDom(snap) {
    if (!unitNode) return;
    const color = getRingAccentToken(snap?.percent || 0, {
      isCacheDrop: Boolean(snap?.cacheDropDetected),
      isCliff328k: snap?.cacheCliffRisk === 'critical',
      isWarn240k: snap?.cacheCliffRisk === 'warn'
    });
    const labelText = formatTopbarRingLabel(snap, settings.showSpeedInTopbar);
    const svgHtml = buildTopbarRingSvg(snap?.percent || 0, color);
    const docRef = unitNode.ownerDocument || globalThis.document;
    if (docRef?.createElement) {
      unitNode.textContent = '';
      const iconSpan = docRef.createElement('span');
      iconSpan.innerHTML = svgHtml;
      const textSpan = docRef.createElement('span');
      textSpan.textContent = labelText;
      unitNode.appendChild(iconSpan);
      unitNode.appendChild(textSpan);
    } else {
      unitNode.textContent = labelText;
    }
    const risk = (snap?.cacheCliffRisk === 'critical' || snap?.cacheDropDetected)
      ? 'danger'
      : (snap?.cacheCliffRisk === 'warn' ? 'warn' : 'none');
    unitNode.setAttribute?.('data-risk', risk);
  }

  popoverHandle = ctx.topbar.registerPopover({
    id: 'context-panel',
    anchorId: 'ring',
    render(node) {
      node.id = 'agy-context-panel';
      panelNode = node;
      updatePanelDom(latestSnapshot);
    }
  });

  const stopUnit = ctx.topbar.registerUnit({
    id: 'ring',
    order: 10,
    label: 'Ctx --',
    render(node) {
      unitNode = node;
      updateUnitDom(latestSnapshot);
    },
    onClick() {
      popoverHandle?.toggle();
    }
  });

  const pulseController = createPulseCapsuleController({
    doc: globalThis.document,
    anchors: ctx.anchors,
    enabled: settings.showPulseCapsule,
    onClick() {
      popoverHandle?.toggle();
    }
  });

  const stopQuotaSub = ctx.state.subscribe('state:quota.snapshot@1', (qSnap) => {
    latestQuota = qSnap || null;
    pulseController.update(latestSnapshot, latestQuota);
  });

  async function refresh(force = false) {
    try {
      const endpoint = force ? '/rescan' : '/snapshot';
      const cascadeId = ctx.hostDom?.getSessionId?.() || null;
      const snap = await ctx.bridge.post(endpoint, { cascadeId, force });
      if (snap && typeof snap === 'object') {
        latestSnapshot = snap;
        updateUnitDom(snap);
        updatePanelDom(snap);
        pulseController.update(snap, latestQuota);
        ctx.state.set('state:context.snapshot@1', snap);
      }
      return snap;
    } catch {
      return null;
    }
  }

  const stopSection = ctx.settings.registerSection({
    id: 'context-settings',
    title: { 'zh-CN': '上下文监测与能量胶囊', en: 'Context Monitor' },
    values: settings,
    onChange(key, value) {
      settings = { ...settings, [key]: value };
      if (key === 'showPulseCapsule') {
        pulseController.setEnabled(Boolean(value));
      }
      updateUnitDom(latestSnapshot);
      void ctx.bridge.post('/settings', { action: 'save', values: { [key]: value } }).catch(() => {});
    }
  });

  const stopUiSvc = ctx.services.provide('context-ui', {
    getSnapshot: () => latestSnapshot,
    rescan: () => refresh(true),
    togglePanel: (force) => popoverHandle?.toggle(force)
  });

  await refresh(false);
  const stopPoll = ctx.schedule.every(settings.pollIntervalMs, () => {
    void refresh(false);
  });

  disposers.push(
    stopPoll,
    stopQuotaSub,
    stopUiSvc,
    stopSection,
    stopUnit,
    () => popoverHandle?.dispose(),
    () => pulseController.dispose()
  );
}

function dispose() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = {
  formatTopbarRingLabel,
  renderPanelHtml,
  mount,
  dispose
};
