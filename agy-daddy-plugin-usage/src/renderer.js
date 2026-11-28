'use strict';

const { USD_TO_CNY_RATE } = require('./pricing-ledger');
const { HEATMAP_STYLES_CSS } = require('./heatmap-svg');
const LOCALE_ZH_CN = require('../locales/zh-CN.json');
const LOCALE_EN = require('../locales/en.json');

let disposers = [];

const VALID_PERIOD_KEYS = Object.freeze(['currentCycle', 'today', 'month', 'year', 'allTime']);

const EMPTY_PERIOD_BUCKET = Object.freeze({
  totalTokens: 0,
  geminiTokens: 0,
  otherTokens: 0,
  totalUsd: 0,
  callsCount: 0,
  cacheReadTokens: 0,
  byModel: {}
});

const AUTO_LOCALE_LABELS = Object.freeze({
  'zh-CN': '自动',
  zh: '自动',
  'zh-TW': '自動',
  en: 'Auto',
  ja: '自動',
  ko: '자동',
  es: 'Automático',
  pt: 'Automático',
  fr: 'Auto',
  ru: 'Авто',
  it: 'Auto'
});

function getLocaleDict(locale = 'zh-CN') {
  const raw = String(locale || 'zh-CN').trim().toLowerCase();
  if (!raw || raw.startsWith('zh')) return LOCALE_ZH_CN;
  return LOCALE_EN;
}

function t(locale, key, fallback = '') {
  const dict = getLocaleDict(locale);
  if (Object.prototype.hasOwnProperty.call(dict, key)) return dict[key];
  if (Object.prototype.hasOwnProperty.call(LOCALE_ZH_CN, key)) return LOCALE_ZH_CN[key];
  return fallback;
}

function getPeriodCompactLabel(periodKey, locale = 'zh-CN', forUnit = false) {
  const key = normalizePeriodKey(periodKey);
  if (key === 'today') return t(locale, 'period.today', '今日');
  if (key === 'currentCycle') return t(locale, 'period.currentCycleShort', '本周期');
  if (key === 'month') return t(locale, 'period.month', '本月');
  if (key === 'year') return t(locale, 'period.year', '今年');
  return t(locale, forUnit ? 'unit.prefix' : 'period.allTime', '累计');
}

function getPeriodFullLabel(periodKey, locale = 'zh-CN') {
  const key = normalizePeriodKey(periodKey);
  if (key === 'currentCycle') return t(locale, 'period.currentCycle', '本重置周期');
  return getPeriodCompactLabel(key, locale, false);
}

function normalizePeriodKey(val) {
  return VALID_PERIOD_KEYS.includes(val) ? val : 'allTime';
}

function resolvePeriodBucket(summary, activePeriod = 'allTime') {
  if (!summary) return EMPTY_PERIOD_BUCKET;
  const periodKey = normalizePeriodKey(activePeriod);
  if (summary.periods && typeof summary.periods === 'object') {
    if (summary.periods[periodKey]) return summary.periods[periodKey];
    return periodKey === 'allTime' ? summary : EMPTY_PERIOD_BUCKET;
  }
  return summary;
}

function getLocalizedAutoLabel(locale = 'zh-CN') {
  const raw = String(locale || 'zh-CN').trim();
  if (!raw) return '自动';
  if (AUTO_LOCALE_LABELS[raw]) return AUTO_LOCALE_LABELS[raw];
  const lower = raw.toLowerCase();
  if (lower.startsWith('zh-tw') || lower.startsWith('zh-hk') || lower.startsWith('zh-hant')) return AUTO_LOCALE_LABELS['zh-TW'];
  if (lower.startsWith('zh')) return AUTO_LOCALE_LABELS['zh-CN'];
  const short = lower.split(/[-_]/)[0];
  return AUTO_LOCALE_LABELS[short] || AUTO_LOCALE_LABELS.en;
}

function formatTierChipLabel(settings = {}, summary = null, locale = 'zh-CN') {
  const sel = String(settings?.ultraSubTier || 'auto').trim().toLowerCase();
  if (sel === '5x') return 'Ultra 5X';
  if (sel === '20x') return 'Ultra 20X';
  if (sel === 'pro') return 'Pro';

  const autoWord = getLocalizedAutoLabel(locale);
  const plan = summary?.plan || {};
  let detectedPkg = plan.detectedLabel || '';
  if (!detectedPkg) {
    const sub = String(plan.detectedSubTier || '').toLowerCase();
    if (sub === '20x') detectedPkg = '20X';
    else if (sub === '5x') detectedPkg = '5X';
    else if (plan.detectedTier === 'pro') detectedPkg = 'Pro';
    else if (plan.detectedTier === 'ultra') detectedPkg = 'Ultra';
    else if (plan.detectedTier === 'free') detectedPkg = 'Free';
  }
  return detectedPkg ? `${autoWord} · ${detectedPkg}` : autoWord;
}

function normalizeUsageSettings(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    activePeriod: normalizePeriodKey(src.activePeriod),
    includeIdeUsage: src.includeIdeUsage !== false,
    includeCliUsage: src.includeCliUsage !== false,
    ultraSubTier: src.ultraSubTier || 'auto',
    subscriptionRegion: src.subscriptionRegion || 'US',
    subscriptionCurrency: src.subscriptionCurrency || 'AUTO',
    subscriptionPriceMode: src.subscriptionPriceMode === 'custom' ? 'custom' : 'preset',
    actualPricePaid: Number.isFinite(Number(src.actualPricePaid)) ? Math.max(0, Number(src.actualPricePaid)) : 0,
    billingCycle: ['monthly', 'yearly', 'free'].includes(src.billingCycle) ? src.billingCycle : 'monthly',
    currency: src.currency === 'CNY' ? 'CNY' : 'USD'
  };
}

function formatTokensCompact(v) {
  const num = Math.max(0, Number(v) || 0);
  if (num >= 1e6) return `${(num / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(num));
}

function formatCurrencyAmount(usdVal, currency = 'USD', exchangeRate = null, decimals = 2) {
  const isCny = currency === 'CNY';
  const rate = Number(exchangeRate) > 0 ? Number(exchangeRate) : (isCny ? USD_TO_CNY_RATE : 1);
  const symbol = isCny ? '¥' : '$';
  return `${symbol}${((Number(usdVal) || 0) * rate).toFixed(decimals)}`;
}

function formatUnitText(summary, activePeriod = 'allTime', locale = 'zh-CN') {
  const periodKey = normalizePeriodKey(activePeriod);
  const periodLabel = getPeriodCompactLabel(periodKey, locale, true);
  const otherLabel = t(locale, 'unit.other', '其他');
  if (!summary) return `${periodLabel} G:-- · ${otherLabel}:--`;
  const bucket = resolvePeriodBucket(summary, periodKey);
  const totalTok = Math.max(0, Number(bucket?.totalTokens) || 0);
  const geminiTok = Math.max(0, Number(bucket?.geminiTokens ?? 0) || 0);
  const otherTok = Math.max(
    0,
    bucket?.otherTokens !== undefined && bucket?.otherTokens !== null
      ? Number(bucket.otherTokens) || 0
      : Math.max(0, totalTok - geminiTok)
  );
  return `${periodLabel} G:${formatTokensCompact(geminiTok)} · ${otherLabel}:${formatTokensCompact(otherTok)}`;
}

function formatSourceScopeLabel(settings = {}) {
  const ide = settings.includeIdeUsage !== false;
  const cli = settings.includeCliUsage !== false;
  if (ide && cli) return 'IDE + CLI';
  if (ide) return '仅 IDE';
  if (cli) return '仅 CLI';
  return '未选来源';
}

function buildUsageIconSvg() {
  return '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">'
    + '<rect x="1.5" y="7" width="2.5" height="5" rx="0.8" fill="var(--ag-custom-token-accent, currentColor)" opacity="0.55"/>'
    + '<rect x="5.75" y="4.5" width="2.5" height="7.5" rx="0.8" fill="var(--ag-custom-token-accent, currentColor)" opacity="0.78"/>'
    + '<rect x="10" y="2" width="2.5" height="10" rx="0.8" fill="var(--ag-custom-token-accent, currentColor)"/>'
    + '</svg>';
}

function buildEl(docRef, tag, cls, text) {
  const el = docRef.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

async function mount(ctx) {
  dispose();

  let settings = normalizeUsageSettings(typeof ctx.settings?.get === 'function' ? ctx.settings.get() : {});
  let activeLocale = 'zh-CN';
  let latestSummary = null;
  let latestHeatmapSvg = '';
  let activePeriod = settings.activePeriod || 'allTime';
  let unitNode = null;
  let panelNode = null;
  let popover = null;

  const stopHeatmapStyles = typeof ctx.styles?.inject === 'function'
    ? ctx.styles.inject(HEATMAP_STYLES_CSS, { scope: 'shadow', id: 'usage-heatmap-styles' })
    : () => {};

  function resolveActiveCurrency() {
    return settings.currency || latestSummary?.currency || latestSummary?.plan?.currency || 'USD';
  }

  function resolveExchangeRate(currency) {
    if (latestSummary?.currency === currency && Number(latestSummary?.exchangeRate) > 0) {
      return Number(latestSummary.exchangeRate);
    }
    return currency === 'CNY' ? USD_TO_CNY_RATE : 1;
  }

  function resolveTierLabel() {
    return formatTierChipLabel(settings, latestSummary, activeLocale);
  }

  function selectPeriod(nextPeriod) {
    const normalized = normalizePeriodKey(nextPeriod);
    activePeriod = normalized;
    settings = { ...settings, activePeriod: normalized };
    renderPanel();
    void renderUnit();
    if (typeof ctx.settings?.update === 'function') {
      try {
        void Promise.resolve(ctx.settings.update({ activePeriod: normalized })).catch(() => {});
      } catch {}
    }
  }

  function formatRoiLine(periods, currency, rate) {
    const periodRoi = periods?.roiByPeriod?.[activePeriod] || periods?.roi;
    if (!periodRoi) return '';
    const sym = periodRoi.subscriptionCurrencySymbol || '$';
    const nativeAmt = Number(periodRoi.monthlyNative ?? periodRoi.actualPaidNative ?? 0);
    const nativeText = periodRoi.billingCycle === 'free'
      ? `${sym}0 (免费)`
      : (periodRoi.billingCycle === 'yearly'
        ? `${sym}${Number(periodRoi.actualPaidNative || 0).toFixed(2)}/年`
        : `${sym}${nativeAmt.toFixed(2)}/月`);
    const estStr = formatCurrencyAmount(periodRoi.estimatedApiUsd || 0, currency, rate, 2);
    const paidStr = formatCurrencyAmount(periodRoi.actualPaidUsd || 0, currency, rate, 2);
    const savedUsd = Number(periodRoi.effectiveSavedUsd || 0);
    const diffLabel = savedUsd >= 0 ? '净省' : '差额';
    const diffVal = formatCurrencyAmount(Math.abs(savedUsd), currency, rate, 2);
    const convertedNote = periodRoi.subscriptionCurrency !== currency
      ? ` · 实付${nativeText}≈${paidStr}`
      : ` · 实付${nativeText}`;
    return `回本(${getPeriodCompactLabel(activePeriod, activeLocale, false)}): API ${estStr} - 成本 ${paidStr} = ${diffLabel} ${diffVal}${convertedNote}`;
  }

  function renderCycleMetaBar(docRef, cw) {
    const metaBar = buildEl(docRef, 'div', 'ag-bar-meta');
    const chip = buildEl(docRef, 'span', 'ag-chip');
    if (cw && !cw.isFallback) {
      chip.setAttribute('data-tone', 'muted');
      chip.setAttribute('data-usage-cycle-meta', 'range');
      const winLabel = cw.windowKey === '5h'
        ? t(activeLocale, 'cycle.fiveHourLabel', '5H 窗口')
        : t(activeLocale, 'cycle.weeklyLabel', '周配额周期');
      if (cw.rangeText) {
        chip.textContent = `${winLabel} · ${cw.rangeText}`;
      } else if (cw.resetTimeText) {
        chip.textContent = `${winLabel} · ${t(activeLocale, 'cycle.resetPrefix', '重置')} ${cw.resetTimeText}`;
      } else {
        chip.textContent = winLabel;
      }
    } else {
      chip.setAttribute('data-tone', 'warn');
      chip.setAttribute('data-usage-cycle-meta', 'fallback');
      const notice = t(activeLocale, 'cycle.fallbackNotice', '暂未获取实时配额重置时间，按本周（周一 00:00 起）统计');
      chip.textContent = cw?.rangeText ? `${notice} · ${cw.rangeText}` : notice;
    }
    metaBar.appendChild(chip);
    return metaBar;
  }

  function renderPanel() {
    if (!panelNode) return;
    if (latestHeatmapSvg) {
      panelNode.setAttribute?.('data-heatmap-svg', latestHeatmapSvg);
    }
    const currency = resolveActiveCurrency();
    const rate = resolveExchangeRate(currency);
    const docRef = panelNode.ownerDocument || globalThis.document;
    if (!docRef?.createElement) {
      if (!latestSummary) {
        panelNode.textContent = '暂无累计用量记录。';
        return;
      }
      const periods = latestSummary.periods;
      const lines = [
        `套餐: ${resolveTierLabel()}`,
        `范围: ${formatSourceScopeLabel(settings)} · ${getPeriodFullLabel(activePeriod, activeLocale)}`,
        `累计 Tokens: ${formatTokensCompact(latestSummary.totalTokens)} (${latestSummary.callsCount} 次调用)`,
        `参考 API 费用: ${formatCurrencyAmount(latestSummary.totalUsd || 0, currency, rate, 4)}`
      ];
      if (activePeriod === 'currentCycle') {
        const cw = latestSummary.cycleWindow || periods?.cycleWindow || null;
        if (cw && !cw.isFallback) {
          const winLabel = cw.windowKey === '5h'
            ? t(activeLocale, 'cycle.fiveHourLabel', '5H 窗口')
            : t(activeLocale, 'cycle.weeklyLabel', '周配额周期');
          lines.push(cw.rangeText ? `${winLabel}: ${cw.rangeText}` : winLabel);
        } else {
          const notice = t(activeLocale, 'cycle.fallbackNotice', '暂未获取实时配额重置时间，按本周（周一 00:00 起）统计');
          lines.push(cw?.rangeText ? `${notice} · ${cw.rangeText}` : notice);
        }
      }
      if (latestSummary.backfillStatus?.earliestDate) {
        lines.push(`统计范围: ${latestSummary.backfillStatus.earliestDate} 起`);
      }
      if (periods) {
        lines.push(
          `分期统计 · ${t(activeLocale, 'period.today', '今日')} ${formatTokensCompact(periods.today?.totalTokens)}`
          + ` · ${t(activeLocale, 'period.currentCycleShort', '本周期')} ${formatTokensCompact(periods.currentCycle?.totalTokens)}`
        );
      }
      panelNode.textContent = lines.join('\n');
      return;
    }

    panelNode.textContent = '';

    // 宿主已统一包壳（标题 + ⚙ + ✕），内容区仅渲染档位/币种/区域/来源操作栏与业务卡片
    const toolbar = buildEl(docRef, 'div', 'ag-bar-meta');
    const chipsWrap = buildEl(docRef, 'div', 'ag-channels-row');
    chipsWrap.appendChild(buildEl(docRef, 'span', 'ag-chip', resolveTierLabel()));
    const currChip = buildEl(docRef, 'span', 'ag-chip', currency);
    currChip.setAttribute('data-tone', 'muted');
    chipsWrap.appendChild(currChip);

    const costInfo = latestSummary?.plan?.costInfo;
    if (costInfo?.regionName) {
      const regChip = buildEl(docRef, 'span', 'ag-chip', `${costInfo.regionFlag || ''} ${costInfo.regionName}`.trim());
      regChip.setAttribute('data-tone', 'muted');
      chipsWrap.appendChild(regChip);
    }

    const scopeChip = buildEl(docRef, 'span', 'ag-chip', formatSourceScopeLabel(settings));
    scopeChip.setAttribute('data-tone', (!settings.includeIdeUsage && !settings.includeCliUsage) ? 'warn' : 'muted');
    chipsWrap.appendChild(scopeChip);

    if (latestSummary?.backfillStatus?.earliestDate) {
      const rangeChip = buildEl(docRef, 'span', 'ag-chip', `${latestSummary.backfillStatus.earliestDate} 起`);
      rangeChip.setAttribute('data-tone', 'muted');
      chipsWrap.appendChild(rangeChip);
    }
    toolbar.appendChild(chipsWrap);

    const refreshBtn = buildEl(docRef, 'button', 'ag-btn ag-btn-primary');
    refreshBtn.type = 'button';
    const refreshIcon = buildEl(docRef, 'span', 'ag-svg-icon');
    refreshIcon.setAttribute('aria-hidden', 'true');
    refreshIcon.innerHTML = '<svg width="12.5" height="12.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';
    refreshBtn.appendChild(refreshIcon);
    refreshBtn.appendChild(buildEl(docRef, 'span', '', '刷新'));
    refreshBtn.addEventListener('click', () => { void refresh(); });
    toolbar.appendChild(refreshBtn);
    panelNode.appendChild(toolbar);

    if (!latestSummary) {
      const empty = buildEl(docRef, 'div', 'settings-card-box');
      empty.appendChild(buildEl(docRef, 'div', 'ag-muted', '暂无累计用量记录。'));
      panelNode.appendChild(empty);
      return;
    }

    const periods = latestSummary.periods || {};
    const tabRow = buildEl(docRef, 'div', 'ag-segmented ag-usage-tabs');
    for (const pId of ['today', 'currentCycle', 'month', 'year', 'allTime']) {
      const btn = buildEl(
        docRef,
        'button',
        `switch-pill-btn${activePeriod === pId ? ' active' : ''}`,
        getPeriodCompactLabel(pId, activeLocale, false)
      );
      btn.type = 'button';
      btn.setAttribute('data-usage-period', pId);
      btn.addEventListener('click', () => {
        selectPeriod(pId);
      });
      tabRow.appendChild(btn);
    }
    panelNode.appendChild(tabRow);

    if (activePeriod === 'currentCycle') {
      const cw = latestSummary.cycleWindow || periods.cycleWindow || null;
      panelNode.appendChild(renderCycleMetaBar(docRef, cw));
    }

    const bucket = resolvePeriodBucket(latestSummary, activePeriod);

    const kpiGrid = buildEl(docRef, 'div', 'ag-kpi-grid');
    for (const k of [
      { label: 'Tokens', value: formatTokensCompact(bucket.totalTokens) },
      { label: '参考 API 费用', value: formatCurrencyAmount(bucket.totalUsd || 0, currency, rate, 2) },
      { label: '调用次数', value: `${bucket.callsCount || 0} 次` },
      { label: '缓存命中量', value: formatTokensCompact(bucket.cacheReadTokens || 0) }
    ]) {
      const cell = buildEl(docRef, 'div', 'ag-kpi-cell');
      cell.appendChild(buildEl(docRef, 'span', 'ag-kpi-label', k.label));
      cell.appendChild(buildEl(docRef, 'span', 'ag-kpi-value', k.value));
      kpiGrid.appendChild(cell);
    }
    panelNode.appendChild(kpiGrid);

    if (periods.today || periods.currentCycle || periods.month || periods.year || periods.roi) {
      const sumCard = buildEl(docRef, 'div', 'settings-card-box');
      sumCard.appendChild(buildEl(docRef, 'div', 'ag-card-title', '分期统计'));
      const pGrid = buildEl(docRef, 'div', 'ag-panel-mini-grid');
      pGrid.style?.setProperty?.('grid-template-columns', 'repeat(4, minmax(0, 1fr))');
      for (const item of [
        { label: t(activeLocale, 'period.today', '今日'), data: periods.today },
        { label: t(activeLocale, 'period.currentCycleShort', '本周期'), data: periods.currentCycle },
        { label: t(activeLocale, 'period.month', '本月'), data: periods.month },
        { label: t(activeLocale, 'period.year', '今年'), data: periods.year }
      ]) {
        const cell = buildEl(docRef, 'div', 'ag-panel-mini-cell');
        cell.appendChild(buildEl(docRef, 'span', 'ag-panel-mini-label', item.label));
        cell.appendChild(buildEl(docRef, 'span', 'ag-panel-mini-value', formatTokensCompact(item.data?.totalTokens)));
        cell.appendChild(buildEl(docRef, 'span', 'ag-muted', formatCurrencyAmount(item.data?.totalUsd || 0, currency, rate, 2)));
        pGrid.appendChild(cell);
      }
      sumCard.appendChild(pGrid);
      const roiTxt = formatRoiLine(periods, currency, rate);
      if (roiTxt) {
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
      const formatModelDisplayName = (name) => (name === 'unknown' ? '未标注模型' : name);
      const formatModelCostText = (mStat) => (
        mStat?.isPriced === false && !(Number(mStat?.costUSD) > 0)
          ? '未定价'
          : formatCurrencyAmount(mStat?.costUSD || 0, currency, rate, 2)
      );
      const topRows = byModelEntries.slice(0, 6);
      if (byModelEntries.length > 6) {
        const rest = byModelEntries.slice(6);
        const restTokens = rest.reduce((acc, [, s]) => acc + (Number(s?.tokens) || 0), 0);
        const restCostUSD = rest.reduce((acc, [, s]) => acc + (Number(s?.costUSD) || 0), 0);
        const restCalls = rest.reduce((acc, [, s]) => acc + (Number(s?.calls) || 0), 0);
        const restPriced = rest.some(([, s]) => s?.isPriced || Number(s?.costUSD) > 0);
        topRows.push([
          `其他模型 (${rest.length})`,
          { calls: restCalls, tokens: restTokens, costUSD: restCostUSD, isPriced: restPriced }
        ]);
      }
      for (const [mName, mStat] of topRows) {
        const pct = Math.max(0, Math.min(100, Math.round(((mStat?.tokens || 0) / totalTok) * 100)));
        const row = buildEl(docRef, 'div', 'ag-bar-row');
        const meta = buildEl(docRef, 'div', 'ag-bar-meta');
        meta.appendChild(buildEl(docRef, 'span', '', formatModelDisplayName(mName)));
        meta.appendChild(buildEl(docRef, 'span', 'ag-muted', `${formatTokensCompact(mStat?.tokens || 0)} · ${formatModelCostText(mStat)}`));
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

  async function renderUnit() {
    const text = formatUnitText(latestSummary, activePeriod, activeLocale);
    const iconSvg = buildUsageIconSvg();
    const title = `用量统计 (${getPeriodFullLabel(activePeriod, activeLocale)} · ${formatSourceScopeLabel(settings)})`;
    if (typeof ctx.topbar?.updateUnit === 'function') {
      try {
        await ctx.topbar.updateUnit('tokens', { label: text, iconSvg, title });
        return;
      } catch {}
    }
    if (!unitNode) return;
    const docRef = unitNode.ownerDocument || globalThis.document;
    if (docRef?.createElement) {
      unitNode.textContent = '';
      const iconSpan = buildEl(docRef, 'span', 'ag-unit-icon');
      iconSpan.innerHTML = iconSvg;
      const lblSpan = buildEl(docRef, 'span', 'ag-unit-label', text);
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
      await renderUnit();
      renderPanel();
    } catch {}
  }

  const updateLocaleFromState = (val) => {
    const next = String(val?.bcp47 || val?.locale || val?.lang || '').trim();
    if (next && next !== activeLocale) {
      activeLocale = next;
      void renderUnit();
      renderPanel();
    }
  };

  const stopHostLocaleSub = typeof ctx.state?.subscribe === 'function'
    ? ctx.state.subscribe('state:host.locale@1', updateLocaleFromState)
    : () => {};
  const stopZhLangSub = typeof ctx.state?.subscribe === 'function'
    ? ctx.state.subscribe('state:zh-cn.lang@1', updateLocaleFromState)
    : () => {};

  popover = ctx.topbar.registerPopover({
    id: 'usage-panel',
    anchorId: 'tokens',
    title: t(activeLocale, 'popover.title', '用量统计与计费'),
    render(bodyNode) {
      bodyNode.id = 'agy-usage-panel';
      panelNode = bodyNode;
      renderPanel();
    },
    onToggle(open) {
      if (open) {
        renderPanel();
        void refresh();
      }
    }
  });

  const stopUnit = ctx.topbar.registerUnit({
    id: 'tokens',
    order: 20,
    label: formatUnitText(null, activePeriod, activeLocale),
    iconSvg: buildUsageIconSvg(),
    render(node) {
      unitNode = node;
    },
    onClick() {
      popover?.toggle();
    }
  });

  const refreshKeys = new Set([
    'includeIdeUsage',
    'includeCliUsage',
    'ultraSubTier',
    'subscriptionRegion',
    'subscriptionCurrency',
    'subscriptionPriceMode',
    'actualPricePaid',
    'billingCycle',
    'currency'
  ]);

  const stopSettingsSub = typeof ctx.settings?.onChange === 'function'
    ? ctx.settings.onChange((nextValues, changedKeys) => {
        settings = normalizeUsageSettings(nextValues);
        activePeriod = settings.activePeriod;
        const keys = Array.isArray(changedKeys) ? changedKeys : [];
        void renderUnit();
        renderPanel();
        if (keys.length === 0 || keys.some((k) => refreshKeys.has(k))) {
          void refresh();
        }
      })
    : () => {};

  await refresh();
  const stopPoll = ctx.schedule.every(10000, () => {
    void refresh();
  });

  disposers.push(
    stopPoll,
    stopSettingsSub,
    stopHostLocaleSub,
    stopZhLangSub,
    stopUnit,
    () => popover?.dispose(),
    stopHeatmapStyles
  );
}

function dispose() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = {
  VALID_PERIOD_KEYS,
  normalizePeriodKey,
  getLocalizedAutoLabel,
  formatTierChipLabel,
  formatTokensCompact,
  formatCurrencyAmount,
  formatUnitText,
  mount,
  dispose
};
