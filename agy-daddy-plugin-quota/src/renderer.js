'use strict';

const {
  formatQuotaDisplayPercent,
  resolveTopbarCountdowns,
  getQuotaAccentToken,
  DEFAULT_CAPSULE_COLOR_RULES,
  evaluateCapsuleColorRules
} = require('./quota-engine');

let disposers = [];

function normalizeQuotaSettings(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const validModes = ['off', '5h', 'weekly', 'both'];
  let topbarCountdownMode = validModes.includes(src.topbarCountdownMode) ? src.topbarCountdownMode : null;
  if (!topbarCountdownMode) {
    topbarCountdownMode = src.showCountdownInTopbar === false ? 'off' : 'both';
  }
  const capsuleColorRules = Array.isArray(src.capsuleColorRules)
    ? src.capsuleColorRules.map((v) => String(v))
    : [...DEFAULT_CAPSULE_COLOR_RULES];
  return {
    pollIntervalMs: Number(src.pollIntervalMs) >= 5000 ? Number(src.pollIntervalMs) : 60000,
    topbarCountdownMode,
    quotaDisplayMode: src.quotaDisplayMode === 'used' ? 'used' : 'remaining',
    capsuleColorRules
  };
}

function formatPoolStatText(bucket, displayMode = 'remaining') {
  if (!bucket) return '--';
  if (typeof bucket.remainingFraction === 'number' && Number.isFinite(bucket.remainingFraction)) {
    return formatQuotaDisplayPercent(bucket.remainingFraction, displayMode);
  }
  if (displayMode === 'used' && bucket.usedPercentText) return bucket.usedPercentText;
  return bucket.percentText || '--';
}

function formatQuotaBadgeText(snapshot, optionsOrShowCountdown = true) {
  if (!snapshot) return '额度 --';
  let countdownMode = 'both';
  let displayMode = 'remaining';
  if (typeof optionsOrShowCountdown === 'boolean') {
    countdownMode = optionsOrShowCountdown ? 'both' : 'off';
  } else if (optionsOrShowCountdown && typeof optionsOrShowCountdown === 'object') {
    const validModes = ['off', '5h', 'weekly', 'both'];
    if (validModes.includes(optionsOrShowCountdown.topbarCountdownMode)) {
      countdownMode = optionsOrShowCountdown.topbarCountdownMode;
    } else if (validModes.includes(optionsOrShowCountdown.countdownMode)) {
      countdownMode = optionsOrShowCountdown.countdownMode;
    } else if (optionsOrShowCountdown.showCountdownInTopbar === false) {
      countdownMode = 'off';
    }
    if (optionsOrShowCountdown.quotaDisplayMode === 'used' || optionsOrShowCountdown.displayMode === 'used') {
      displayMode = 'used';
    }
  }

  const g = snapshot.gemini ? `G:${formatPoolStatText(snapshot.gemini, displayMode)}` : 'G:--';
  const c = snapshot.claude ? `C:${formatPoolStatText(snapshot.claude, displayMode)}` : 'C:--';

  let cd = '';
  if (countdownMode !== 'off') {
    const { fiveHour, weekly } = resolveTopbarCountdowns(snapshot);
    const parts = [];
    if ((countdownMode === '5h' || countdownMode === 'both') && fiveHour?.countdownText) {
      parts.push(`5H:${fiveHour.countdownText}`);
    }
    if ((countdownMode === 'weekly' || countdownMode === 'both') && weekly?.countdownText) {
      parts.push(`W:${weekly.countdownText}`);
    }
    if (parts.length > 0) {
      cd = ` (${parts.join(' · ')})`;
    }
  }
  return `${g} · ${c}${cd}`;
}

function fractionTone(frac) {
  if (typeof frac !== 'number') return 'ok';
  if (frac <= 0.15) return 'danger';
  if (frac <= 0.35) return 'warn';
  return 'ok';
}

function buildQuotaDotSvg(fraction, explicitColor = '') {
  const fill = explicitColor || getQuotaAccentToken(fraction);
  return `<svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><circle cx="4" cy="4" r="3.2" fill="${fill}"/></svg>`;
}

function buildEl(docRef, tag, cls, text) {
  const el = docRef.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

async function mount(ctx) {
  dispose();

  let settings = normalizeQuotaSettings(typeof ctx.settings?.get === 'function' ? ctx.settings.get() : {});
  let latestSnapshot = null;
  let unitNode = null;
  let panelNode = null;
  let popover = null;
  let stopPoll = null;

  function formatSummaryChipText(remainingFrac, fallbackRemainText, fallbackUsedText) {
    const isUsed = settings.quotaDisplayMode === 'used';
    if (typeof remainingFrac === 'number' && Number.isFinite(remainingFrac)) {
      return isUsed
        ? `已用最多 ${formatQuotaDisplayPercent(remainingFrac, 'used')}`
        : `剩余最少 ${formatQuotaDisplayPercent(remainingFrac, 'remaining')}`;
    }
    return isUsed ? (fallbackUsedText || '--') : (fallbackRemainText || '--');
  }

  function renderPanel() {
    if (!panelNode) return;
    const isUsedMode = settings.quotaDisplayMode === 'used';
    const modeLabel = isUsedMode ? '已用' : '剩余';
    const docRef = panelNode.ownerDocument || globalThis.document;
    if (!docRef?.createElement) {
      if (!latestSnapshot || !latestSnapshot.pools?.length) {
        panelNode.textContent = '暂无配额数据。';
        return;
      }
      const lines = [];
      if (latestSnapshot.ultraSubTier) lines.push(`订阅倍率: Ultra ${latestSnapshot.ultraSubTier} (${latestSnapshot.quotaMultiplier}x)`);
      const ovText = formatSummaryChipText(latestSnapshot.tightestFraction, latestSnapshot.tightestPercentText, latestSnapshot.highestUsedPercentText);
      if (ovText && ovText !== '--') lines.push(`短板总览: ${ovText}`);
      for (const p of latestSnapshot.pools) {
        const fiveTxt = p.fiveHourBucket ? `5h ${modeLabel}:${formatPoolStatText(p.fiveHourBucket, settings.quotaDisplayMode)}` : '';
        const wkTxt = p.weeklyBucket ? `每周 ${modeLabel}:${formatPoolStatText(p.weeklyBucket, settings.quotaDisplayMode)}` : '';
        const poolSummary = formatSummaryChipText(p.tightestFraction, p.tightestPercentText, p.highestUsedPercentText);
        lines.push(`${p.title} [${poolSummary}]: ${[fiveTxt, wkTxt].filter(Boolean).join(' | ')}`);
      }
      panelNode.textContent = lines.join('\n');
      return;
    }

    panelNode.textContent = '';

    // 宿主已统一包壳（标题 + ⚙ + ✕），内容区仅渲染状态操作栏与配额池卡片
    const toolbar = buildEl(docRef, 'div', 'ag-bar-meta');
    const chipsWrap = buildEl(docRef, 'div', 'ag-channels-row');
    const overviewChipText = formatSummaryChipText(
      latestSnapshot?.tightestFraction,
      latestSnapshot?.tightestPercentText,
      latestSnapshot?.highestUsedPercentText
    );
    if (latestSnapshot && overviewChipText && overviewChipText !== '--') {
      const chip = buildEl(docRef, 'span', 'ag-chip', `短板总览: ${overviewChipText}`);
      const tone = fractionTone(latestSnapshot.tightestFraction);
      if (tone !== 'ok') chip.setAttribute('data-tone', tone);
      chipsWrap.appendChild(chip);
    }
    if (latestSnapshot?.ultraSubTier) {
      const tierChip = buildEl(docRef, 'span', 'ag-chip', `Ultra ${latestSnapshot.ultraSubTier} (${latestSnapshot.quotaMultiplier}x)`);
      tierChip.setAttribute('data-tone', 'muted');
      chipsWrap.appendChild(tierChip);
    }
    toolbar.appendChild(chipsWrap);

    const refreshBtn = buildEl(docRef, 'button', 'ag-btn ag-btn-primary');
    refreshBtn.type = 'button';
    const refreshIcon = buildEl(docRef, 'span', 'ag-svg-icon');
    refreshIcon.setAttribute('aria-hidden', 'true');
    refreshIcon.innerHTML = '<svg width="12.5" height="12.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';
    refreshBtn.appendChild(refreshIcon);
    refreshBtn.appendChild(buildEl(docRef, 'span', '', '刷新'));
    refreshBtn.addEventListener('click', () => { void refresh(true); });
    toolbar.appendChild(refreshBtn);
    panelNode.appendChild(toolbar);

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
      const poolChipText = formatSummaryChipText(p.tightestFraction, p.tightestPercentText, p.highestUsedPercentText);
      const poolChip = buildEl(docRef, 'span', 'ag-chip', poolChipText);
      const poolTone = fractionTone(p.tightestFraction);
      if (poolTone !== 'ok') poolChip.setAttribute('data-tone', poolTone);
      cardHead.appendChild(poolChip);
      card.appendChild(cardHead);

      const rows = [];
      if (p.fiveHourBucket) rows.push({ prefix: `5h ${modeLabel}:`, bucket: p.fiveHourBucket });
      if (p.weeklyBucket) rows.push({ prefix: `每周 ${modeLabel}:`, bucket: p.weeklyBucket });
      if (!rows.length && Array.isArray(p.buckets)) {
        for (const b of p.buckets) rows.push({ prefix: `${b.windowShort || b.windowKey} ${modeLabel}:`, bucket: b });
      }

      for (const r of rows) {
        const b = r.bucket;
        const remFrac = typeof b.remainingFraction === 'number' && Number.isFinite(b.remainingFraction)
          ? Math.max(0, Math.min(1, b.remainingFraction))
          : 0;
        const displayFrac = isUsedMode ? (1 - remFrac) : remFrac;
        const pctNum = Math.max(0, Math.min(100, Math.round(displayFrac * 100)));
        const statText = formatPoolStatText(b, settings.quotaDisplayMode);
        const barRow = buildEl(docRef, 'div', 'ag-bar-row');
        const meta = buildEl(docRef, 'div', 'ag-bar-meta');
        meta.appendChild(buildEl(docRef, 'span', '', `${r.prefix} ${statText}`));
        meta.appendChild(buildEl(docRef, 'span', 'ag-muted', b.countdownText ? `重置 ${b.countdownText}` : (b.resetTimeText || '')));
        barRow.appendChild(meta);

        const track = buildEl(docRef, 'div', 'ag-progress-track');
        const fill = buildEl(docRef, 'div', 'ag-progress-fill');
        const bTone = fractionTone(b.remainingFraction);
        if (bTone !== 'ok') fill.setAttribute('data-tone', bTone);
        fill.style?.setProperty?.('width', `${pctNum}%`);
        track.appendChild(fill);
        barRow.appendChild(track);
        card.appendChild(barRow);
      }

      panelNode.appendChild(card);
    }
  }

  async function renderUnit() {
    const text = formatQuotaBadgeText(latestSnapshot, {
      topbarCountdownMode: settings.topbarCountdownMode,
      quotaDisplayMode: settings.quotaDisplayMode
    });
    const minFrac = [latestSnapshot?.gemini?.remainingFraction, latestSnapshot?.claude?.remainingFraction]
      .filter((v) => typeof v === 'number')
      .sort((a, b) => a - b)[0];
    const ruleMatch = evaluateCapsuleColorRules(latestSnapshot, settings.capsuleColorRules);
    const accentColor = ruleMatch.matched ? ruleMatch.color : '';
    const unitTone = ruleMatch.matched ? ruleMatch.tone : '';
    const iconSvg = buildQuotaDotSvg(minFrac, accentColor);
    const baseTitle = settings.quotaDisplayMode === 'used' ? '额度监控 · 已使用' : '额度监控 · 剩余';
    const title = ruleMatch.matched
      ? `${baseTitle} · 命中规则: ${ruleMatch.rule.summary}`
      : baseTitle;

    if (typeof ctx.topbar?.updateUnit === 'function') {
      try {
        await ctx.topbar.updateUnit('quota', {
          label: text,
          iconSvg,
          tone: unitTone,
          accentColor,
          title
        });
        return;
      } catch {}
    }

    if (!unitNode) return;
    const tone = unitTone || 'ok';
    const docRef = unitNode.ownerDocument || globalThis.document;
    if (docRef?.createElement) {
      unitNode.textContent = '';
      const dot = buildEl(docRef, 'span', 'ag-unit-dot');
      dot.setAttribute('data-level', tone);
      if (accentColor) dot.style?.setProperty?.('background', accentColor);
      const lbl = buildEl(docRef, 'span', 'ag-unit-label', text);
      unitNode.appendChild(dot);
      unitNode.appendChild(lbl);
    } else {
      unitNode.textContent = text;
    }
    if (unitTone) {
      unitNode.setAttribute?.('data-tone', unitTone);
      unitNode.setAttribute?.('data-risk', unitTone);
    } else {
      unitNode.removeAttribute?.('data-tone');
      unitNode.removeAttribute?.('data-risk');
    }
    if (accentColor) {
      unitNode.setAttribute?.('data-custom-color', accentColor);
      unitNode.style?.setProperty?.('--ag-unit-custom-color', accentColor);
    } else {
      unitNode.removeAttribute?.('data-custom-color');
      unitNode.style?.removeProperty?.('--ag-unit-custom-color');
    }
  }

  async function refresh(force = false) {
    try {
      const snap = await ctx.bridge.post(force ? '/refresh' : '/snapshot', {});
      if (snap) {
        latestSnapshot = snap;
        await renderUnit();
        renderPanel();
        try { await ctx.state.set('state:quota.snapshot@1', snap); } catch {}
      }
      return snap;
    } catch {
      return null;
    }
  }

  function startPollLoop() {
    if (typeof stopPoll === 'function') {
      try { stopPoll(); } catch {}
      stopPoll = null;
    }
    stopPoll = ctx.schedule.every(settings.pollIntervalMs, () => {
      void refresh(false);
    });
  }

  popover = ctx.topbar.registerPopover({
    id: 'quota-panel',
    anchorId: 'quota',
    title: '额度监控',
    render(bodyNode) {
      bodyNode.id = 'agy-quota-panel';
      panelNode = bodyNode;
      renderPanel();
    },
    onToggle(open) {
      if (open) {
        renderPanel();
        void refresh(false);
      }
    }
  });

  const stopUnit = ctx.topbar.registerUnit({
    id: 'quota',
    order: 30,
    label: '额度 --',
    iconSvg: buildQuotaDotSvg(null),
    render(node) {
      unitNode = node;
    },
    onClick() {
      popover?.toggle();
    }
  });

  const stopSettingsSub = typeof ctx.settings?.onChange === 'function'
    ? ctx.settings.onChange((nextValues) => {
        const prevPoll = settings.pollIntervalMs;
        settings = normalizeQuotaSettings(nextValues);
        void renderUnit();
        renderPanel();
        if (settings.pollIntervalMs !== prevPoll) {
          startPollLoop();
        }
      })
    : () => {};

  await refresh(false);
  startPollLoop();

  disposers.push(
    () => { if (typeof stopPoll === 'function') stopPoll(); stopPoll = null; },
    stopSettingsSub,
    stopUnit,
    () => popover?.dispose()
  );
}

function dispose() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = {
  normalizeQuotaSettings,
  formatQuotaBadgeText,
  mount,
  dispose
};
