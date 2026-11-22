'use strict';

let disposers = [];

function formatTokensCompact(v) {
  const num = Math.max(0, Number(v) || 0);
  if (num >= 1e6) return `${(num / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(num));
}

function formatUnitText(summary, showCost = true) {
  if (!summary) return '累计 --';
  const tok = formatTokensCompact(summary.totalTokens || 0);
  const cost = showCost && Number(summary.totalUsd || 0) > 0 ? ` · $${Number(summary.totalUsd).toFixed(2)}` : '';
  return `累计 ${tok}${cost}`;
}

function buildUsageIconSvg() {
  return '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">'
    + '<rect x="1.5" y="7" width="2.5" height="5" rx="0.8" fill="var(--ag-custom-token-accent, #a78bfa)" opacity="0.65"/>'
    + '<rect x="5.75" y="4.5" width="2.5" height="7.5" rx="0.8" fill="var(--ag-custom-token-accent, #a78bfa)" opacity="0.85"/>'
    + '<rect x="10" y="2" width="2.5" height="10" rx="0.8" fill="var(--ag-custom-token-accent, #a78bfa)"/>'
    + '</svg>';
}

function buildEl(docRef, tag, cls, text) {
  const el = docRef.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

async function mount(ctx) {
  let latestSummary = null;
  let latestHeatmapSvg = '';
  let showCost = true;
  let activePeriod = 'allTime';
  let unitNode = null;
  let panelNode = null;
  let popover = null;

  function renderPanel() {
    if (!panelNode) return;
    if (latestHeatmapSvg) {
      panelNode.setAttribute?.('data-heatmap-svg', latestHeatmapSvg);
    }
    const docRef = panelNode.ownerDocument || globalThis.document;
    if (!docRef?.createElement) {
      if (!latestSummary) {
        panelNode.textContent = '暂无累计用量记录。';
        return;
      }
      const periods = latestSummary.periods;
      const lines = [
        `累计 Tokens: ${formatTokensCompact(latestSummary.totalTokens)} (${latestSummary.callsCount} 次调用)`,
        `参考 API 费用: $${Number(latestSummary.totalUsd || 0).toFixed(4)}`
      ];
      if (periods) lines.push(`分期统计 · 今日 ${formatTokensCompact(periods.today?.totalTokens)}`);
      panelNode.textContent = lines.join('\n');
      return;
    }

    panelNode.textContent = '';

    const head = buildEl(docRef, 'div', 'ag-panel-head');
    const titleWrap = buildEl(docRef, 'div', 'ag-panel-title-wrap');
    titleWrap.appendChild(buildEl(docRef, 'span', 'ag-panel-title', '用量统计与计费'));
    const tierTxt = latestSummary?.plan?.ultraSubTier ? `Ultra ${latestSummary.plan.ultraSubTier}` : (latestSummary?.plan?.tier || 'auto');
    const tierChip = buildEl(docRef, 'span', 'ag-chip', tierTxt);
    titleWrap.appendChild(tierChip);
    head.appendChild(titleWrap);

    const actions = buildEl(docRef, 'div', 'ag-panel-actions');
    const closeBtn = buildEl(docRef, 'button', 'ag-icon-btn', '✕');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', () => { popover?.toggle(false); });
    actions.appendChild(closeBtn);
    head.appendChild(actions);
    panelNode.appendChild(head);

    if (!latestSummary) {
      const empty = buildEl(docRef, 'div', 'settings-card-box');
      empty.appendChild(buildEl(docRef, 'div', 'ag-muted', '暂无累计用量记录。'));
      panelNode.appendChild(empty);
      return;
    }

    const periods = latestSummary.periods || {};
    const tabRow = buildEl(docRef, 'div', 'ag-settings-tabs');
    for (const pDef of [
      { id: 'today', label: '今日' },
      { id: 'month', label: '本月' },
      { id: 'year', label: '今年' },
      { id: 'allTime', label: '累计' }
    ]) {
      const btn = buildEl(docRef, 'button', `switch-pill-btn${activePeriod === pDef.id ? ' active' : ''}`, pDef.label);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        activePeriod = pDef.id;
        renderPanel();
      });
      tabRow.appendChild(btn);
    }
    panelNode.appendChild(tabRow);

    const bucket = (periods && periods[activePeriod]) || latestSummary;

    const kpiCard = buildEl(docRef, 'div', 'settings-card-box');
    const kpiGrid = buildEl(docRef, 'div', 'ag-kpi-grid');
    for (const k of [
      { label: 'Tokens', value: formatTokensCompact(bucket.totalTokens) },
      { label: '参考 API 费用', value: `$${Number(bucket.totalUsd || 0).toFixed(2)}` },
      { label: '调用次数', value: `${bucket.callsCount || 0} 次` },
      { label: '缓存命中量', value: formatTokensCompact(bucket.cacheReadTokens || 0) }
    ]) {
      const cell = buildEl(docRef, 'div', 'ag-kpi-cell');
      cell.appendChild(buildEl(docRef, 'span', 'ag-kpi-label', k.label));
      cell.appendChild(buildEl(docRef, 'span', 'ag-kpi-value', k.value));
      kpiGrid.appendChild(cell);
    }
    kpiCard.appendChild(kpiGrid);
    panelNode.appendChild(kpiCard);

    if (periods.today || periods.month || periods.year || periods.roi) {
      const sumCard = buildEl(docRef, 'div', 'settings-card-box');
      sumCard.appendChild(buildEl(docRef, 'div', 'ag-card-title', '分期统计'));
      const pText = `今日 ${formatTokensCompact(periods.today?.totalTokens)} ($${Number(periods.today?.totalUsd || 0).toFixed(2)}) · 本月 ${formatTokensCompact(periods.month?.totalTokens)} ($${Number(periods.month?.totalUsd || 0).toFixed(2)}) · 今年 ${formatTokensCompact(periods.year?.totalTokens)} ($${Number(periods.year?.totalUsd || 0).toFixed(2)})`;
      sumCard.appendChild(buildEl(docRef, 'div', 'ag-muted', pText));
      if (periods.roi) {
        const roiTxt = `回本差额: 折合 $${periods.roi.estimatedApiUsd.toFixed(2)} - 实付 $${periods.roi.actualPaidUsd.toFixed(2)} = 净省 $${periods.roi.effectiveSavedUsd.toFixed(2)}`;
        sumCard.appendChild(buildEl(docRef, 'div', 'ag-chip', roiTxt));
      }
      panelNode.appendChild(sumCard);
    }

    if (latestHeatmapSvg) {
      const hmCard = buildEl(docRef, 'div', 'settings-card-box');
      hmCard.appendChild(buildEl(docRef, 'div', 'ag-card-title', '52 周用量热力图'));
      const hmBox = buildEl(docRef, 'div', 'ag-heatmap-box');
      hmBox.innerHTML = latestHeatmapSvg;
      hmCard.appendChild(hmBox);
      panelNode.appendChild(hmCard);
    }

    const byModelEntries = Object.entries(bucket.byModel || {}).sort((a, b) => (b[1]?.tokens || 0) - (a[1]?.tokens || 0));
    if (byModelEntries.length) {
      const modCard = buildEl(docRef, 'div', 'settings-card-box');
      modCard.appendChild(buildEl(docRef, 'div', 'ag-card-title', '分模型用量分布'));
      const totalTok = Number(bucket.totalTokens) || 1;
      for (const [mName, mStat] of byModelEntries.slice(0, 6)) {
        const pct = Math.max(0, Math.min(100, Math.round(((mStat?.tokens || 0) / totalTok) * 100)));
        const row = buildEl(docRef, 'div', 'ag-bar-row');
        const meta = buildEl(docRef, 'div', 'ag-bar-meta');
        meta.appendChild(buildEl(docRef, 'span', '', mName));
        meta.appendChild(buildEl(docRef, 'span', 'ag-muted', `${formatTokensCompact(mStat?.tokens || 0)} · $${Number(mStat?.costUSD || 0).toFixed(2)}`));
        row.appendChild(meta);
        const track = buildEl(docRef, 'div', 'ag-progress-track');
        const fill = buildEl(docRef, 'div', 'ag-progress-fill');
        fill.style?.setProperty?.('width', `${pct}%`);
        track.appendChild(fill);
        row.appendChild(track);
        modCard.appendChild(row);
      }
      panelNode.appendChild(modCard);
    }
  }

  function renderUnit() {
    if (!unitNode) return;
    const text = formatUnitText(latestSummary, showCost);
    const docRef = unitNode.ownerDocument || globalThis.document;
    if (docRef?.createElement) {
      unitNode.textContent = '';
      const iconSpan = buildEl(docRef, 'span');
      iconSpan.innerHTML = buildUsageIconSvg();
      const lblSpan = buildEl(docRef, 'span', '', text);
      unitNode.appendChild(iconSpan);
      unitNode.appendChild(lblSpan);
    } else {
      unitNode.textContent = text;
    }
  }

  async function refresh() {
    try {
      const [sum, hm] = await Promise.all([
        ctx.bridge.post('/summary', {}),
        ctx.bridge.post('/heatmap-svg', {}).catch(() => null)
      ]);
      latestSummary = sum;
      latestHeatmapSvg = hm?.svg || '';
      renderUnit();
      renderPanel();
    } catch {}
  }

  popover = ctx.topbar.registerPopover({
    id: 'usage-panel',
    anchorId: 'tokens',
    render(node) {
      node.id = 'agy-usage-panel';
      panelNode = node;
      renderPanel();
    }
  });

  const stopUnit = ctx.topbar.registerUnit({
    id: 'tokens',
    order: 20,
    label: '累计 --',
    render(node) {
      unitNode = node;
      renderUnit();
    },
    onClick() {
      popover?.toggle();
    }
  });

  const stopSection = ctx.settings.registerSection({
    id: 'usage-settings',
    title: { 'zh-CN': '累计用量与订阅计费', en: 'Usage & Subscription' },
    values: { showCostInTopbar: true, ultraSubTier: 'auto', currency: 'USD' },
    onChange(key, value) {
      if (key === 'showCostInTopbar') {
        showCost = Boolean(value);
        renderUnit();
      } else if (key === 'ultraSubTier' || key === 'currency') {
        void ctx.bridge.post('/set-plan', { [key]: value }).then(refresh).catch(() => {});
      }
    }
  });

  await refresh();
  const stopPoll = ctx.schedule.every(10000, () => {
    void refresh();
  });

  disposers.push(stopPoll, stopSection, stopUnit, () => popover?.dispose());
}

function dispose() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = {
  formatTokensCompact,
  formatUnitText,
  mount,
  dispose
};
