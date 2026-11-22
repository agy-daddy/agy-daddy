'use strict';

const { getQuotaAccentToken } = require('./quota-engine');

let disposers = [];

function formatQuotaBadgeText(snapshot, showCountdown = true) {
  if (!snapshot) return '配额 --';
  const g = snapshot.gemini ? `G:${snapshot.gemini.percentText}` : 'G:--';
  const c = snapshot.claude ? `C:${snapshot.claude.percentText}` : 'C:--';
  const cd = showCountdown && snapshot.gemini?.countdownText ? ` (${snapshot.gemini.countdownText})` : '';
  return `${g} · ${c}${cd}`;
}

function fractionTone(frac) {
  if (typeof frac !== 'number') return 'ok';
  if (frac <= 0.15) return 'danger';
  if (frac <= 0.35) return 'warn';
  return 'ok';
}

function buildEl(docRef, tag, cls, text) {
  const el = docRef.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

async function mount(ctx) {
  let latestSnapshot = null;
  let showCountdown = true;
  let pollIntervalMs = 60000;
  let unitNode = null;
  let panelNode = null;
  let popover = null;

  function renderPanel() {
    if (!panelNode) return;
    const docRef = panelNode.ownerDocument || globalThis.document;
    if (!docRef?.createElement) {
      if (!latestSnapshot || !latestSnapshot.pools?.length) {
        panelNode.textContent = '暂无配额数据。';
        return;
      }
      const lines = [];
      if (latestSnapshot.ultraSubTier) lines.push(`订阅倍率: Ultra ${latestSnapshot.ultraSubTier} (${latestSnapshot.quotaMultiplier}x)`);
      if (latestSnapshot.tightestPercentText) lines.push(`短板总览: ${latestSnapshot.tightestPercentText}`);
      for (const p of latestSnapshot.pools) {
        const fiveTxt = p.fiveHourBucket ? `5h:${p.fiveHourBucket.percentText}` : '';
        const wkTxt = p.weeklyBucket ? `每周:${p.weeklyBucket.percentText}` : '';
        lines.push(`${p.title} [${p.tightestPercentText || '--'}]: ${[fiveTxt, wkTxt].filter(Boolean).join(' | ')}`);
      }
      panelNode.textContent = lines.join('\n');
      return;
    }

    panelNode.textContent = '';
    const head = buildEl(docRef, 'div', 'ag-panel-head');
    const titleWrap = buildEl(docRef, 'div', 'ag-panel-title-wrap');
    titleWrap.appendChild(buildEl(docRef, 'span', 'ag-panel-title', '模型配额实时监控'));
    if (latestSnapshot?.tightestPercentText) {
      const chip = buildEl(docRef, 'span', 'ag-chip', `短板总览: ${latestSnapshot.tightestPercentText}`);
      chip.setAttribute('data-tone', fractionTone(latestSnapshot.tightestFraction));
      titleWrap.appendChild(chip);
    }
    if (latestSnapshot?.ultraSubTier) {
      const tierChip = buildEl(docRef, 'span', 'ag-chip', `Ultra ${latestSnapshot.ultraSubTier} (${latestSnapshot.quotaMultiplier}x)`);
      tierChip.setAttribute('data-tone', 'muted');
      titleWrap.appendChild(tierChip);
    }
    head.appendChild(titleWrap);

    const actions = buildEl(docRef, 'div', 'ag-panel-actions');
    const refreshBtn = buildEl(docRef, 'button', 'ag-btn ag-btn-primary', '↻ 刷新');
    refreshBtn.type = 'button';
    refreshBtn.addEventListener('click', () => { void refresh(true); });
    const closeBtn = buildEl(docRef, 'button', 'ag-icon-btn', '✕');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', () => { popover?.toggle(false); });
    actions.appendChild(refreshBtn);
    actions.appendChild(closeBtn);
    head.appendChild(actions);
    panelNode.appendChild(head);

    if (!latestSnapshot || !latestSnapshot.pools?.length) {
      const empty = buildEl(docRef, 'div', 'settings-card-box');
      empty.appendChild(buildEl(docRef, 'div', 'ag-muted', '暂无配额数据。'));
      panelNode.appendChild(empty);
      return;
    }

    for (const p of latestSnapshot.pools) {
      const card = buildEl(docRef, 'div', 'settings-card-box');
      const cardHead = buildEl(docRef, 'div', 'ag-card-title');
      cardHead.appendChild(buildEl(docRef, 'span', '', p.title));
      const poolChip = buildEl(docRef, 'span', 'ag-chip', p.tightestPercentText || '--');
      poolChip.setAttribute('data-tone', fractionTone(p.tightestFraction));
      cardHead.appendChild(poolChip);
      card.appendChild(cardHead);

      const rows = [];
      if (p.fiveHourBucket) rows.push({ prefix: '5h:', bucket: p.fiveHourBucket });
      if (p.weeklyBucket) rows.push({ prefix: '每周:', bucket: p.weeklyBucket });
      if (!rows.length && Array.isArray(p.buckets)) {
        for (const b of p.buckets) rows.push({ prefix: `${b.windowShort || b.windowKey}:`, bucket: b });
      }

      for (const r of rows) {
        const b = r.bucket;
        const pctNum = Math.max(0, Math.min(100, Math.round((Number(b.remainingFraction) || 0) * 100)));
        const barRow = buildEl(docRef, 'div', 'ag-bar-row');
        const meta = buildEl(docRef, 'div', 'ag-bar-meta');
        meta.appendChild(buildEl(docRef, 'span', '', `${r.prefix} ${b.percentText || `${pctNum}%`}`));
        meta.appendChild(buildEl(docRef, 'span', 'ag-muted', b.countdownText ? `重置 ${b.countdownText}` : (b.resetTimeText || '')));
        barRow.appendChild(meta);

        const track = buildEl(docRef, 'div', 'ag-progress-track');
        const fill = buildEl(docRef, 'div', 'ag-progress-fill');
        fill.setAttribute('data-tone', fractionTone(b.remainingFraction));
        fill.style?.setProperty?.('width', `${pctNum}%`);
        track.appendChild(fill);
        barRow.appendChild(track);
        card.appendChild(barRow);
      }

      panelNode.appendChild(card);
    }
  }

  function renderUnit() {
    if (!unitNode) return;
    const text = formatQuotaBadgeText(latestSnapshot, showCountdown);
    const minFrac = [latestSnapshot?.gemini?.remainingFraction, latestSnapshot?.claude?.remainingFraction]
      .filter((v) => typeof v === 'number')
      .sort((a, b) => a - b)[0];
    const tone = fractionTone(minFrac);
    const docRef = unitNode.ownerDocument || globalThis.document;
    if (docRef?.createElement) {
      unitNode.textContent = '';
      const dot = buildEl(docRef, 'span', 'ag-unit-dot');
      dot.setAttribute('data-level', tone);
      const lbl = buildEl(docRef, 'span', '', text);
      unitNode.appendChild(dot);
      unitNode.appendChild(lbl);
    } else {
      unitNode.textContent = text;
    }
    unitNode.setAttribute?.('data-risk', tone);
  }

  async function refresh(force = false) {
    try {
      const snap = await ctx.bridge.post(force ? '/refresh' : '/snapshot', {});
      if (snap) {
        latestSnapshot = snap;
        renderUnit();
        renderPanel();
        ctx.state.set('state:quota.snapshot@1', snap);
      }
      return snap;
    } catch {
      return null;
    }
  }

  popover = ctx.topbar.registerPopover({
    id: 'quota-panel',
    anchorId: 'quota',
    render(node) {
      node.id = 'agy-quota-panel';
      panelNode = node;
      renderPanel();
    }
  });

  const stopUnit = ctx.topbar.registerUnit({
    id: 'quota',
    order: 30,
    label: '配额 --',
    render(node) {
      unitNode = node;
      renderUnit();
    },
    onClick() {
      popover?.toggle();
    }
  });

  const stopSection = ctx.settings.registerSection({
    id: 'quota-settings',
    title: { 'zh-CN': '模型配额监控', en: 'Model Quota Monitor' },
    values: { pollIntervalMs, showCountdownInTopbar: true },
    onChange(key, value) {
      if (key === 'showCountdownInTopbar') {
        showCountdown = Boolean(value);
        renderUnit();
      }
    }
  });

  await refresh(false);
  const stopPoll = ctx.schedule.every(pollIntervalMs, () => {
    void refresh(false);
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
  formatQuotaBadgeText,
  mount,
  dispose
};
