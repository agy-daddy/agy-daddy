'use strict';

const {
  formatTokensShort,
  formatThresholdLabel,
  resolveThresholdTokens,
  getRingAccentToken
} = require('./context-analyzer');
const {
  PULSE_CAPSULE_CSS,
  buildDualRatioSvg,
  formatSpeedCompact,
  buildCapsuleSegments,
  buildCapsuleTooltip,
  createPulseCapsuleController
} = require('./pulse-capsule');
const { CONTEXT_PANEL_CSS } = require('./panel-styles');
const { createStreamSpeedTracker } = require('./stream-speed-tracker');

let disposers = [];

const GROUP_LABELS = Object.freeze({
  system: '系统',
  user: '用户',
  assistant: '回复',
  tool: '工具',
  thinking: '思考'
});

const STATUS_BADGE_MAP = Object.freeze({
  estimated: { text: '估算', tone: 'muted' },
  exceeded: { text: '窗口超限', tone: 'danger' },
  network: { text: '网络异常', tone: 'danger' },
  quota_exhausted: { text: '额度耗尽', tone: 'danger' },
  rate_limited: { text: '请求限流', tone: 'warn' },
  auth_error: { text: '认证异常', tone: 'danger' },
  service_unavailable: { text: '服务过载', tone: 'warn' },
  canceled: { text: '已取消', tone: 'muted' },
  failed: { text: '请求失败', tone: 'danger' }
});

function formatStatusBadge(snap, liveSpeed = null) {
  if (liveSpeed?.active) {
    return { text: '流式生成中', tone: '' };
  }
  const status = String(snap?.status || '').trim();
  if (!status || status === 'reported' || status === 'idle' || status === 'pending') {
    return null;
  }
  return STATUS_BADGE_MAP[status] || null;
}

function normalizeContextSettings(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  let displayLocation = 'composer';
  if (src.displayLocation === 'topbar' || src.displayLocation === 'composer') {
    displayLocation = src.displayLocation;
  } else if (src.showPulseCapsule === false) {
    displayLocation = 'topbar';
  }
  const showSpeed = src.showSpeed !== undefined
    ? src.showSpeed !== false
    : src.showSpeedInTopbar !== false;
  const VALID_COMPACT_POLICIES = new Set(['remind', 'idle_prompt', 'cliff_auto', 'idle_and_cliff']);
  const compactPolicy = VALID_COMPACT_POLICIES.has(src.compactPolicy)
    ? src.compactPolicy
    : 'remind';
  const warnThreshold = String(src.warnThreshold ?? (src.warnThresholdTokens ? String(src.warnThresholdTokens) : '240K')).trim() || '240K';
  const cliffThreshold = String(src.cliffThreshold ?? (src.cliffThresholdTokens ? String(src.cliffThresholdTokens) : '328K')).trim() || '328K';
  return {
    displayLocation,
    showSpeed,
    pollIntervalMs: Number(src.pollIntervalMs) >= 1000 ? Number(src.pollIntervalMs) : 3000,
    warnThreshold,
    cliffThreshold,
    compactPolicy,
    autoCompactOnCacheDrop: src.autoCompactOnCacheDrop === true,
    autoCompactCooldownMs: Number(src.autoCompactCooldownMs) > 0 ? Number(src.autoCompactCooldownMs) : 300000
  };
}

function formatTopbarRingLabel(snapshot, showSpeed = true, liveSpeed = null) {
  if (!snapshot || !snapshot.hasSession || snapshot.used === null) {
    return '--';
  }
  const ratio = `${formatTokensShort(snapshot.used)}/${formatTokensShort(snapshot.budget)}`;
  const sessionTotal = snapshot.sessionUsage?.totalTokens ?? snapshot.used;
  const parts = [ratio, formatTokensShort(sessionTotal)];
  if (showSpeed) {
    if (liveSpeed?.active) {
      parts.push(liveSpeed.tps ? `~${formatSpeedCompact(liveSpeed.tps)}` : '…');
    } else if (snapshot.speed?.tps) {
      parts.push(formatSpeedCompact(snapshot.speed.tps));
    }
  }
  return parts.join(' · ');
}

function buildTopbarRingSvg(percent = 0, color = 'var(--ag-custom-token-accent, var(--ag-token-accent-default, currentColor))') {
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  const r = 5.2;
  const c = Number((2 * Math.PI * r).toFixed(2));
  const dash = Number(((pct / 100) * c).toFixed(2));
  return `<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">`
    + `<circle cx="7" cy="7" r="${r}" fill="none" stroke="rgba(113,113,122,0.24)" stroke-width="2"/>`
    + `<circle cx="7" cy="7" r="${r}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-dasharray="${dash} ${c}" transform="rotate(-90 7 7)"/>`
    + `</svg>`;
}

function resolveGroupTokens(groupVal) {
  if (typeof groupVal === 'number') return groupVal;
  if (!groupVal || typeof groupVal !== 'object') return 0;
  return Number(groupVal.tokens ?? groupVal.high ?? groupVal.low ?? 0) || 0;
}

function buildSortedGroups(groupsObj) {
  if (!groupsObj || typeof groupsObj !== 'object') return [];
  const defs = [
    { key: 'system', label: GROUP_LABELS.system, val: resolveGroupTokens(groupsObj.system), present: groupsObj.system !== undefined },
    { key: 'user', label: GROUP_LABELS.user, val: resolveGroupTokens(groupsObj.user), present: groupsObj.user !== undefined },
    { key: 'assistant', label: GROUP_LABELS.assistant, val: resolveGroupTokens(groupsObj.assistant), present: groupsObj.assistant !== undefined },
    { key: 'tool', label: GROUP_LABELS.tool, val: resolveGroupTokens(groupsObj.tool ?? groupsObj.tools), present: groupsObj.tool !== undefined || groupsObj.tools !== undefined },
    { key: 'thinking', label: GROUP_LABELS.thinking, val: resolveGroupTokens(groupsObj.thinking ?? groupsObj.summaries), present: groupsObj.thinking !== undefined || groupsObj.summaries !== undefined }
  ].filter((d) => d.present);

  const hasNonZero = defs.some((d) => d.val > 0);
  return defs
    .filter((d) => !hasNonZero || d.val > 0)
    .sort((a, b) => b.val - a.val);
}

function formatAttachmentMeta(attachments) {
  const count = Number(attachments?.totals?.count || 0);
  const high = Number(attachments?.totals?.high || 0);
  if (count <= 0) return '无附件';
  return high > 0 ? `附件 ${count} 项 · 约 ${formatTokensShort(high)}` : `附件 ${count} 项`;
}

function renderPanelHtml(snapshot, onRescan, liveSpeed = null) {
  if (!snapshot || !snapshot.hasSession) {
    return '暂无活跃 Antigravity 会话，点击刷新以采样。';
  }
  const su = snapshot.sessionUsage || {};
  const sessionTotal = su.totalTokens ?? snapshot.used ?? 0;
  const speedText = liveSpeed?.active
    ? (liveSpeed.tps ? `~${formatSpeedCompact(liveSpeed.tps)} (流式估算)` : '生成中…')
    : (snapshot.speed?.tps ? `${snapshot.speed.tps} tok/s` : '--');
  const badge = formatStatusBadge(snapshot, liveSpeed);
  const statusStr = badge ? ` (${badge.text})` : '';
  const lines = [
    `模型: ${snapshot.model || 'Unknown'}${statusStr}`,
    `上下文窗口: ${formatTokensShort(snapshot.used)} / ${formatTokensShort(snapshot.budget)} (${snapshot.percent ?? '--'}%) · 剩余 ${snapshot.remainPercent ?? '--'}%`,
    `单轮缓存: 命中 ${snapshot.cacheHitRate ?? 0}% (${formatTokensShort(snapshot.cachedTokens)} / ${formatTokensShort(snapshot.inputTokens)})`,
    `本对话累计: ${formatTokensShort(sessionTotal)} · 输出 ${formatTokensShort(su.outputTokens ?? snapshot.outputTokens)} · 缓存读 ${formatTokensShort(su.cachedTokens ?? snapshot.cachedTokens)} · ${su.callsCount || 0} 次`,
    `生成速度: ${speedText} · 纯吐字 ${snapshot.speed?.streamingTps ?? '--'} tok/s · TTFT ${liveSpeed?.active ? (liveSpeed.ttft ?? '--') : (snapshot.speed?.ttft ?? '--')}s`,
    formatAttachmentMeta(snapshot.attachments)
  ];
  const groups = buildSortedGroups(snapshot.groups);
  if (groups.length) {
    lines.push(`上下文构成: ${groups.map((d) => `${d.label} ${formatTokensShort(d.val)}`).join(' · ')}`);
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
  'var(--ag-text-primary, #18181b)',
  'var(--ag-text-secondary, #52525b)',
  'var(--ag-text-muted, #71717a)',
  'rgba(113, 113, 122, 0.5)',
  'rgba(113, 113, 122, 0.26)'
];

const REFRESH_ICON_SVG = '<svg width="11.5" height="11.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';

function extractAnchorRect(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return null;
  const r = el.getBoundingClientRect();
  if (!r) return null;
  const top = Number(r.top);
  const left = Number(r.left);
  const right = Number(r.right);
  const bottom = Number(r.bottom);
  const width = Number(r.width);
  const height = Number(r.height);
  if (![top, left, right, bottom, width, height].every(Number.isFinite)) return null;
  if (width <= 0 && height <= 0) return null;
  return { top, left, right, bottom, width, height };
}

async function mount(ctx) {
  dispose();

  let settings = normalizeContextSettings(typeof ctx.settings?.get === 'function' ? ctx.settings.get() : {});
  let latestSnapshot = null;
  let latestLiveSpeed = null;
  let helpExpanded = false;
  let showQuickCompact = false;
  let lastAutoCompactAt = 0;
  let isSendingCompact = false;
  let pendingAutoCompact = null;
  let unitNode = null;
  let stopUnit = null;
  let panelNode = null;
  let popoverHandle = null;
  let stopPoll = null;
  let stopLiveTick = null;
  const trackedTimers = new Set();

  const docRefGlobal = globalThis.document;
  const speedTracker = createStreamSpeedTracker();
  let lastObservedCascadeId = null;
  let lastObservedIsNewEmptyChat = false;
  let refreshSeq = 0;
  let lastPublishedLiveKey = '';
  let lastPublishedLiveAt = 0;
  let lastPublishedPhase = '';
  let lastPublishedHasTps = false;

  function publishLiveState(cascadeId, busy, live, force = false) {
    const phase = live?.phase || (busy ? 'waiting' : 'idle');
    const tps = live?.tps ?? null;
    const ttft = live?.ttft ?? null;
    const estimatedOutputTokens = live?.estimatedOutputTokens ?? 0;
    const key = `${cascadeId || ''}:${busy ? 1 : 0}:${phase}:${tps ?? ''}`;
    const now = Date.now();
    const hasTps = tps !== null;
    const majorTransition = phase !== lastPublishedPhase || (!lastPublishedHasTps && hasTps);
    if (!force && key === lastPublishedLiveKey) return;
    if (!force && !majorTransition && busy && now - lastPublishedLiveAt < 280) return;
    lastPublishedLiveKey = key;
    lastPublishedLiveAt = now;
    lastPublishedPhase = phase;
    lastPublishedHasTps = hasTps;
    try {
      const payload = {
        cascadeId: cascadeId || null,
        busy: Boolean(busy),
        phase,
        tps,
        ttft,
        estimatedOutputTokens,
        updatedAt: now
      };
      Promise.resolve(ctx.state?.set?.('state:context.live@1', payload)).catch(() => {});
      Promise.resolve(ctx.bridge?.post?.('/live-state', payload)).catch(() => {});
    } catch {}
  }

  function readDomSessionContext() {
    const cascadeId = ctx.hostDom?.getSessionId?.() || null;
    const busy = Boolean(ctx.hostDom?.isAssistantBusy?.());
    const turnEls = typeof docRefGlobal?.querySelectorAll === 'function'
      ? docRefGlobal.querySelectorAll('[data-testid="user-message"], [data-testid="agent-response"]')
      : [];
    const turnCount = turnEls ? turnEls.length : 0;
    const isNewEmptyChat = !cascadeId && !busy && turnCount === 0;
    return { cascadeId, busy, turnCount, isNewEmptyChat };
  }

  function buildRendererEmptySnapshot(cascadeId = null) {
    return {
      ok: true,
      hasSession: false,
      cascadeId: cascadeId || null,
      status: 'idle',
      used: null,
      budget: null,
      percent: null,
      remainPercent: null,
      model: null,
      speed: null,
      sessionUsage: {
        totalTokens: 0,
        inputTokens: 0,
        cachedTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        responseTokens: 0,
        callsCount: 0,
        avgTps: null,
        avgStreamingTps: null
      },
      groups: null,
      attachments: { items: [], totals: { count: 0, chars: 0, bytes: 0, low: 0, high: 0 } },
      alerts: [],
      referenceCost: null,
      displayLocation: settings.displayLocation,
      showSpeed: settings.showSpeed,
      compactPolicy: settings.compactPolicy,
      warnThreshold: settings.warnThreshold,
      cliffThreshold: settings.cliffThreshold,
      updatedAt: Date.now()
    };
  }

  const stopPulseStyles = typeof ctx.styles?.inject === 'function'
    ? ctx.styles.inject(PULSE_CAPSULE_CSS, { scope: 'document', id: 'context-pulse-styles' })
    : () => {};

  const stopPanelStyles = typeof ctx.styles?.inject === 'function'
    ? ctx.styles.inject(CONTEXT_PANEL_CSS, { scope: 'shadow', id: 'context-panel-styles' })
    : () => {};

  function buildEl(docRef, tag, cls, text) {
    const el = docRef.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function renderMetricRow(docRef, items) {
    const grid = buildEl(docRef, 'div', 'ag-ctx-metrics');
    for (const k of items) {
      const cell = buildEl(docRef, 'div', 'ag-ctx-metric');
      cell.appendChild(buildEl(docRef, 'span', 'ag-ctx-metric-label', k.label));
      cell.appendChild(buildEl(docRef, 'span', 'ag-ctx-metric-val', k.value));
      grid.appendChild(cell);
    }
    return grid;
  }

  function restoreDraftSafely(editor, prevDraft) {
    const curEd = ctx.anchors.query('composer.editor') || editor;
    if (!curEd) return;
    const curText = String(curEd.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (typeof docRefGlobal?.execCommand === 'function') {
      if (curText) return;
      isSendingCompact = true;
      try {
        curEd.focus?.();
        const sel = typeof globalThis.getSelection === 'function' ? globalThis.getSelection() : null;
        if (sel && typeof docRefGlobal.createRange === 'function') {
          const range = docRefGlobal.createRange();
          range.selectNodeContents(curEd);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        let capturedBeforeInput = null;
        const onBeforeInput = (ev) => {
          if (ev && (!ev.inputType || ev.inputType === 'insertText')) {
            capturedBeforeInput = ev;
          }
        };
        const canListenDoc = typeof docRefGlobal.addEventListener === 'function' && typeof docRefGlobal.removeEventListener === 'function';
        const canListenEd = typeof curEd.addEventListener === 'function' && typeof curEd.removeEventListener === 'function';
        if (canListenDoc) docRefGlobal.addEventListener('beforeinput', onBeforeInput, true);
        if (canListenEd) curEd.addEventListener('beforeinput', onBeforeInput, true);
        let inserted = false;
        try {
          inserted = Boolean(docRefGlobal.execCommand('insertText', false, prevDraft));
        } finally {
          if (canListenDoc) docRefGlobal.removeEventListener('beforeinput', onBeforeInput, true);
          if (canListenEd) curEd.removeEventListener('beforeinput', onBeforeInput, true);
        }
        const prevented = Boolean(capturedBeforeInput && capturedBeforeInput.defaultPrevented);
        const afterText = String(curEd.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
        if (!inserted && !prevented && !afterText) {
          curEd.textContent = prevDraft;
        }
      } catch {
        curEd.textContent = prevDraft;
      } finally {
        isSendingCompact = false;
      }
      return;
    }
    if (!curText || curText === '/compact') {
      curEd.textContent = prevDraft;
    }
  }

  function sendCompactSafely({ preserveDraft = true, reason = 'manual', thresholdTokens = null } = {}) {
    if (isSendingCompact) return { ok: false, reason: 'in_flight' };
    const editor = ctx.anchors.query('composer.editor');
    const prevDraft = preserveDraft && editor ? String(editor.textContent || '') : '';
    const hasDraft = Boolean(prevDraft.trim());
    const prevAutoCompactAt = lastAutoCompactAt;
    if (reason !== 'manual') {
      lastAutoCompactAt = Date.now();
    }
    let sent = false;
    isSendingCompact = true;
    try {
      sent = Boolean(ctx.hostDom?.sendText?.('/compact'));
    } finally {
      isSendingCompact = false;
    }
    if (!sent) {
      if (reason !== 'manual') {
        lastAutoCompactAt = prevAutoCompactAt;
      }
      return { ok: false, reason: 'send_failed' };
    }

    if (hasDraft && editor) {
      const restoreDelayMs = typeof docRefGlobal?.execCommand === 'function' ? 320 : 80;
      const tid = setTimeout(() => {
        trackedTimers.delete(tid);
        restoreDraftSafely(editor, prevDraft);
      }, restoreDelayMs);
      trackedTimers.add(tid);
    }

    if (reason !== 'manual') {
      ctx.events?.emit?.('context:auto-compact-triggered@1', {
        reason,
        used: latestSnapshot?.used ?? null,
        budget: latestSnapshot?.budget ?? null,
        thresholdTokens,
        preservedDraft: hasDraft
      });
    }
    return { ok: true, preservedDraft: hasDraft };
  }

  function evaluateCompactState(snap, opts = {}) {
    if (isSendingCompact) {
      return { showQuickCompact, triggered: false, reason: 'in_flight' };
    }
    if (!snap || !snap.hasSession || typeof snap.used !== 'number') {
      showQuickCompact = false;
      pendingAutoCompact = null;
      return { showQuickCompact: false, triggered: false, reason: 'no_session' };
    }

    const warnInfo = formatThresholdLabel(settings.warnThreshold, snap.budget, 240000);
    const cliffInfo = formatThresholdLabel(settings.cliffThreshold, snap.budget, 328000);
    const warnHit = snap.used >= warnInfo.tokens;
    const cliffHit = snap.used >= cliffInfo.tokens;
    const cacheDrop = Boolean(snap.cacheDropDetected);
    const busy = Boolean(ctx.hostDom?.isAssistantBusy?.());
    const editor = ctx.anchors.query('composer.editor');
    const hasDraft = Boolean(String(editor?.textContent || '').trim());

    const enableIdlePrompt = settings.compactPolicy === 'idle_prompt' || settings.compactPolicy === 'idle_and_cliff';
    const enableCliffAuto = settings.compactPolicy === 'cliff_auto' || settings.compactPolicy === 'idle_and_cliff';

    const nextQuickCompact = Boolean(
      enableIdlePrompt &&
      (warnHit || cacheDrop) &&
      !busy &&
      !hasDraft
    );
    showQuickCompact = nextQuickCompact;

    if (opts?.allowAutoTrigger === false) {
      return {
        showQuickCompact: nextQuickCompact,
        triggered: false,
        reason: 'input_only',
        warnTokens: warnInfo.tokens,
        cliffTokens: cliffInfo.tokens
      };
    }

    let autoReason = null;
    let triggerThreshold = null;
    if (settings.autoCompactOnCacheDrop && cacheDrop) {
      autoReason = 'cache_drop';
    } else if (enableCliffAuto && cliffHit) {
      autoReason = 'cliff';
      triggerThreshold = cliffInfo.tokens;
    }

    if (!autoReason) {
      pendingAutoCompact = null;
      return {
        showQuickCompact: nextQuickCompact,
        triggered: false,
        reason: 'not_triggered',
        warnTokens: warnInfo.tokens,
        cliffTokens: cliffInfo.tokens
      };
    }

    if (busy) {
      pendingAutoCompact = { reason: autoReason, thresholdTokens: triggerThreshold };
      return {
        showQuickCompact: nextQuickCompact,
        triggered: false,
        pending: true,
        reason: 'assistant_busy',
        warnTokens: warnInfo.tokens,
        cliffTokens: cliffInfo.tokens
      };
    }

    const now = Date.now();
    if (!opts?.bypassCooldown && lastAutoCompactAt > 0 && now - lastAutoCompactAt < settings.autoCompactCooldownMs) {
      return {
        showQuickCompact: nextQuickCompact,
        triggered: false,
        reason: 'cooldown',
        warnTokens: warnInfo.tokens,
        cliffTokens: cliffInfo.tokens
      };
    }

    pendingAutoCompact = null;
    const sendRes = sendCompactSafely({
      preserveDraft: true,
      reason: autoReason,
      thresholdTokens: triggerThreshold
    });
    return {
      showQuickCompact: nextQuickCompact,
      triggered: Boolean(sendRes.ok),
      reason: sendRes.ok ? autoReason : 'send_failed',
      preservedDraft: Boolean(sendRes.preservedDraft),
      warnTokens: warnInfo.tokens,
      cliffTokens: cliffInfo.tokens
    };
  }

  function updatePanelDom(snap, liveSpeed = latestLiveSpeed) {
    if (!panelNode) return;
    const docRef = panelNode.ownerDocument || globalThis.document;
    if (!docRef?.createElement) {
      panelNode.textContent = renderPanelHtml(snap, null, liveSpeed);
      return;
    }

    panelNode.textContent = '';

    // 1. Header: 模型名 + 仅在异常/流式时出现的状态标签 + 安静幽灵刷新按钮
    const header = buildEl(docRef, 'div', 'ag-ctx-header');
    const modelWrap = buildEl(docRef, 'div', 'ag-ctx-model-wrap');
    modelWrap.appendChild(buildEl(docRef, 'span', 'ag-ctx-model', snap?.hasSession ? (snap.model || 'Unknown') : '等待会话采样'));
    if (snap?.hasSession) {
      const badge = formatStatusBadge(snap, liveSpeed);
      if (badge) {
        const chip = buildEl(docRef, 'span', 'ag-chip', badge.text);
        if (badge.tone) chip.setAttribute('data-tone', badge.tone);
        modelWrap.appendChild(chip);
      }
    }
    header.appendChild(modelWrap);

    const rescanBtn = buildEl(docRef, 'button', 'ag-ctx-refresh');
    rescanBtn.type = 'button';
    rescanBtn.setAttribute('aria-label', '重新扫描');
    rescanBtn.setAttribute('title', '重新扫描当前会话');
    const rescanIcon = buildEl(docRef, 'span', 'ag-svg-icon');
    rescanIcon.setAttribute('aria-hidden', 'true');
    rescanIcon.innerHTML = REFRESH_ICON_SVG;
    rescanBtn.appendChild(rescanIcon);
    rescanBtn.appendChild(buildEl(docRef, 'span', '', '刷新'));
    rescanBtn.addEventListener('click', () => { void refresh(true); });
    header.appendChild(rescanBtn);
    panelNode.appendChild(header);

    if (!snap || !snap.hasSession) {
      panelNode.appendChild(buildEl(docRef, 'div', 'ag-ctx-empty', '暂无活跃 Antigravity 会话，点击刷新以采样。'));
      return;
    }

    // 2. 上下文窗口
    const pct = Math.max(0, Math.min(100, Number(snap.percent || 0)));
    const warnInfo = formatThresholdLabel(settings.warnThreshold, snap.budget, 240000);
    const cliffInfo = formatThresholdLabel(settings.cliffThreshold, snap.budget, 328000);
    const riskTone = (snap.cacheCliffRisk === 'critical' || snap.cacheDropDetected)
      ? 'danger'
      : (snap.cacheCliffRisk === 'warn' ? 'warn' : '');
    const winSec = buildEl(docRef, 'section', 'ag-ctx-section');
    const winHead = buildEl(docRef, 'div', 'ag-ctx-sec-head');
    winHead.appendChild(buildEl(docRef, 'span', 'ag-ctx-sec-title', '上下文窗口'));
    winHead.appendChild(buildEl(docRef, 'span', 'ag-ctx-sec-meta', `预警 ${warnInfo.shortLabel} · 断崖 ${cliffInfo.shortLabel}`));
    winSec.appendChild(winHead);

    const heroRow = buildEl(docRef, 'div', 'ag-ctx-hero-row');
    const heroVal = buildEl(docRef, 'div', 'ag-ctx-hero-val');
    heroVal.appendChild(buildEl(docRef, 'span', '', formatTokensShort(snap.used)));
    heroVal.appendChild(buildEl(docRef, 'span', 'ag-ctx-hero-budget', `/ ${formatTokensShort(snap.budget)}`));
    heroRow.appendChild(heroVal);

    const pctEl = buildEl(docRef, 'span', 'ag-ctx-hero-pct', `${snap.percent ?? '--'}%`);
    if (riskTone) pctEl.setAttribute('data-tone', riskTone);
    heroRow.appendChild(pctEl);
    winSec.appendChild(heroRow);

    const track = buildEl(docRef, 'div', 'ag-ctx-track');
    const fill = buildEl(docRef, 'div', 'ag-ctx-fill');
    if (riskTone) fill.setAttribute('data-tone', riskTone);
    fill.style?.setProperty?.('width', `${pct}%`);
    track.appendChild(fill);

    const budgetNum = Number(snap.budget || 0);
    if (budgetNum > 0) {
      const warnPct = (warnInfo.tokens / budgetNum) * 100;
      if (warnPct >= 5 && warnPct <= 95) {
        const tWarn = buildEl(docRef, 'span', 'ag-ctx-tick');
        tWarn.setAttribute('data-kind', 'warn');
        tWarn.setAttribute('title', `预警阈值 ${warnInfo.shortLabel} (${formatTokensShort(warnInfo.tokens)})`);
        tWarn.style?.setProperty?.('left', `${warnPct.toFixed(1)}%`);
        track.appendChild(tWarn);
      }
      const cliffPct = (cliffInfo.tokens / budgetNum) * 100;
      if (cliffPct >= 5 && cliffPct <= 95) {
        const tCliff = buildEl(docRef, 'span', 'ag-ctx-tick');
        tCliff.setAttribute('data-kind', 'cliff');
        tCliff.setAttribute('title', `断崖阈值 ${cliffInfo.shortLabel} (${formatTokensShort(cliffInfo.tokens)})`);
        tCliff.style?.setProperty?.('left', `${cliffPct.toFixed(1)}%`);
        track.appendChild(tCliff);
      }
    }
    winSec.appendChild(track);

    const winSub = buildEl(docRef, 'div', 'ag-ctx-subline');
    winSub.appendChild(buildEl(docRef, 'span', '', snap.remainPercent != null ? `剩余 ${snap.remainPercent}%` : '剩余 --'));
    winSub.appendChild(buildEl(docRef, 'span', '', `缓存命中 ${snap.cacheHitRate ?? 0}% (${formatTokensShort(snap.cachedTokens)}/${formatTokensShort(snap.inputTokens)})`));
    winSec.appendChild(winSub);

    const needCompactHint = Boolean(snap.cacheDropDetected || snap.cacheCliffRisk === 'warn' || snap.cacheCliffRisk === 'critical');
    if ((Array.isArray(snap.alerts) && snap.alerts.length) || needCompactHint) {
      const alertRow = buildEl(docRef, 'div', 'ag-ctx-alerts');
      for (const a of (snap.alerts || [])) {
        const chip = buildEl(docRef, 'span', 'ag-chip', a.message);
        chip.setAttribute('data-tone', a.level === 'danger' ? 'danger' : (a.level === 'warn' ? 'warn' : 'muted'));
        alertRow.appendChild(chip);
      }
      if (needCompactHint) {
        const compactBtn = buildEl(docRef, 'button', 'ag-ctx-refresh', '立即压缩');
        compactBtn.type = 'button';
        compactBtn.setAttribute('data-panel-compact', '1');
        compactBtn.setAttribute('title', '发送 /compact 压缩当前对话上下文');
        compactBtn.addEventListener('click', () => {
          sendCompactSafely({ preserveDraft: false, reason: 'manual' });
        });
        alertRow.appendChild(compactBtn);
      }
      winSec.appendChild(alertRow);
    }
    panelNode.appendChild(winSec);

    // 3. 本对话累计 Token
    const su = snap.sessionUsage || {};
    const sessSec = buildEl(docRef, 'section', 'ag-ctx-section');
    const sessHead = buildEl(docRef, 'div', 'ag-ctx-sec-head');
    sessHead.appendChild(buildEl(docRef, 'span', 'ag-ctx-sec-title', '本对话累计'));
    sessHead.appendChild(buildEl(docRef, 'span', 'ag-ctx-sec-meta', `${su.callsCount || 0} 次调用`));
    sessSec.appendChild(sessHead);

    sessSec.appendChild(renderMetricRow(docRef, [
      { label: '总计', value: formatTokensShort(su.totalTokens ?? snap.used) },
      { label: '输出', value: formatTokensShort(su.outputTokens ?? snap.outputTokens) },
      { label: '缓存读', value: formatTokensShort(su.cachedTokens ?? snap.cachedTokens) },
      { label: '新输入', value: formatTokensShort(su.inputTokens ?? snap.inputTokens) }
    ]));

    const sessSub = buildEl(docRef, 'div', 'ag-ctx-subline');
    sessSub.appendChild(buildEl(docRef, 'span', '', `思考 ${formatTokensShort(su.thinkingTokens || 0)} · 回答 ${formatTokensShort(su.responseTokens ?? su.outputTokens ?? 0)}`));
    sessSub.appendChild(buildEl(docRef, 'span', '', '独立于顶栏用量'));
    sessSec.appendChild(sessSub);
    panelNode.appendChild(sessSec);

    // 4. 生成速度
    const speedSec = buildEl(docRef, 'section', 'ag-ctx-section');
    const speedHead = buildEl(docRef, 'div', 'ag-ctx-sec-head');
    speedHead.appendChild(buildEl(docRef, 'span', 'ag-ctx-sec-title', '生成速度'));
    const speedModeLabel = liveSpeed?.active ? '流式估算' : (snap.speed?.tps ? '实测' : '待采样');
    const speedChip = buildEl(docRef, 'span', 'ag-chip', speedModeLabel);
    if (!liveSpeed?.active && !snap.speed?.tps) speedChip.setAttribute('data-tone', 'muted');
    speedHead.appendChild(speedChip);
    speedSec.appendChild(speedHead);

    const activeTpsVal = liveSpeed?.active
      ? (liveSpeed.tps ? `~${formatSpeedCompact(liveSpeed.tps)}` : '生成中…')
      : (snap.speed?.tps ? `${snap.speed.tps}/s` : '--');
    const pureStreamVal = snap.speed?.streamingTps ? `${snap.speed.streamingTps}/s` : '--';
    const ttftRaw = liveSpeed?.active ? liveSpeed.ttft : snap.speed?.ttft;
    const ttftVal = ttftRaw !== null && ttftRaw !== undefined ? `${ttftRaw}s` : '--';
    const avgVal = su.avgTps ? `${su.avgTps}/s` : '--';

    speedSec.appendChild(renderMetricRow(docRef, [
      { label: '总速率', value: activeTpsVal },
      { label: '纯吐字', value: pureStreamVal },
      { label: '首字', value: ttftVal },
      { label: '均速', value: avgVal }
    ]));

    const stepOut = liveSpeed?.active
      ? formatTokensShort(liveSpeed.estimatedOutputTokens)
      : formatTokensShort(snap.speed?.outputTokens ?? snap.outputTokens);
    const stepDur = liveSpeed?.active ? (liveSpeed.elapsedSec ?? 0) : (snap.speed?.duration ?? '--');
    const speedSub = buildEl(docRef, 'div', 'ag-ctx-subline');
    speedSub.appendChild(buildEl(docRef, 'span', '', `本步 ${stepOut} · ${stepDur}s`));
    if (su.avgStreamingTps) {
      speedSub.appendChild(buildEl(docRef, 'span', '', `纯吐字均速 ${su.avgStreamingTps}/s`));
    }
    speedSec.appendChild(speedSub);
    panelNode.appendChild(speedSec);

    // 5. 上下文构成（按占比降序、中文标签）
    const groups = buildSortedGroups(snap.groups);
    if (groups.length) {
      const gSec = buildEl(docRef, 'section', 'ag-ctx-section');
      const gHead = buildEl(docRef, 'div', 'ag-ctx-sec-head');
      gHead.appendChild(buildEl(docRef, 'span', 'ag-ctx-sec-title', '上下文构成'));
      gHead.appendChild(buildEl(docRef, 'span', 'ag-ctx-sec-meta', formatAttachmentMeta(snap.attachments)));
      gSec.appendChild(gHead);

      const total = groups.reduce((acc, d) => acc + d.val, 0) || 1;
      const segTrack = buildEl(docRef, 'div', 'ag-seg-track');
      const segLegend = buildEl(docRef, 'div', 'ag-seg-legend');
      groups.forEach((d, idx) => {
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
        item.appendChild(buildEl(docRef, 'span', '', `${d.label} ${formatTokensShort(d.val)}`));
        segLegend.appendChild(item);
      });
      gSec.appendChild(segTrack);
      gSec.appendChild(segLegend);
      panelNode.appendChild(gSec);
    }

    // 6. 渐进披露指标说明（默认折叠，不干扰扫读）
    const helpDetails = buildEl(docRef, 'details', 'ag-ctx-help');
    helpDetails.open = helpExpanded;
    helpDetails.addEventListener('toggle', () => {
      helpExpanded = Boolean(helpDetails.open);
    });
    helpDetails.appendChild(buildEl(docRef, 'summary', '', '指标说明'));
    const helpList = buildEl(docRef, 'ul', 'ag-ctx-help-list');
    for (const tip of [
      '上下文窗口：单次请求的记忆容量（外环=占用、内环=缓存命中），刻度线为预警/断崖阈值，建议超 240K 时执行 /compact。',
      '本对话累计：仅汇总当前对话全轮次模型消耗，与顶栏「用量」的跨会话历史总账相互独立。',
      '生成速度：总速率含首字等待 (TTFT)，纯吐字仅计流式输出阶段；生成中带 ~ 为实时估算，完成后切回实测值。'
    ]) {
      helpList.appendChild(buildEl(docRef, 'li', '', tip));
    }
    helpDetails.appendChild(helpList);
    panelNode.appendChild(helpDetails);
  }

  async function updateUnitDom(snap, liveSpeed = latestLiveSpeed) {
    if (settings.displayLocation !== 'topbar' || !stopUnit) return;

    const color = getRingAccentToken(snap?.percent || 0, {
      isCacheDrop: Boolean(snap?.cacheDropDetected),
      isCliff328k: snap?.cacheCliffRisk === 'critical',
      isWarn240k: snap?.cacheCliffRisk === 'warn'
    });
    const labelText = formatTopbarRingLabel(snap, settings.showSpeed, liveSpeed);
    const svgHtml = buildTopbarRingSvg(snap?.percent || 0, color);
    const segments = buildCapsuleSegments(snap, {
      showSpeed: settings.showSpeed,
      liveSpeed
    });
    const tooltip = buildCapsuleTooltip(snap, { liveSpeed });
    const tone = (snap?.cacheCliffRisk === 'critical' || snap?.cacheDropDetected)
      ? 'danger'
      : (snap?.cacheCliffRisk === 'warn' ? 'warn' : '');

    if (typeof ctx.topbar?.updateUnit === 'function') {
      try {
        await ctx.topbar.updateUnit('ring', {
          label: labelText,
          iconSvg: svgHtml,
          segments,
          title: tooltip,
          tone
        });
        return;
      } catch {}
    }

    if (!unitNode) return;
    const docRef = unitNode.ownerDocument || globalThis.document;
    if (docRef?.createElement) {
      unitNode.textContent = '';
      for (const seg of segments) {
        const segEl = docRef.createElement('span');
        segEl.className = 'ag-unit-seg';
        if (seg.tone) segEl.setAttribute('data-tone', seg.tone);
        if (seg.iconSvg) {
          const iconSpan = docRef.createElement('span');
          iconSpan.className = 'ag-unit-icon';
          iconSpan.innerHTML = seg.iconSvg;
          segEl.appendChild(iconSpan);
        }
        if (seg.text) {
          const textSpan = docRef.createElement('span');
          textSpan.className = 'ag-unit-label';
          textSpan.textContent = seg.text;
          segEl.appendChild(textSpan);
        }
        unitNode.appendChild(segEl);
      }
    } else {
      unitNode.textContent = labelText;
    }
    unitNode.setAttribute?.('title', tooltip);
    if (tone) {
      unitNode.setAttribute?.('data-tone', tone);
      unitNode.setAttribute?.('data-risk', tone);
    } else {
      unitNode.removeAttribute?.('data-tone');
      unitNode.removeAttribute?.('data-risk');
    }
  }

  popoverHandle = ctx.topbar.registerPopover({
    id: 'context-panel',
    anchorId: 'ring',
    title: '当前对话实时状态',
    render(bodyNode) {
      bodyNode.id = 'agy-context-panel';
      panelNode = bodyNode;
      updatePanelDom(latestSnapshot, latestLiveSpeed);
    },
    onToggle(open) {
      if (open) {
        updatePanelDom(latestSnapshot, latestLiveSpeed);
        void refresh(false);
      }
    }
  });

  const pulseController = createPulseCapsuleController({
    doc: globalThis.document,
    anchors: ctx.anchors,
    enabled: settings.displayLocation === 'composer',
    showSpeed: settings.showSpeed,
    onClick(btnEl) {
      const anchorRect = extractAnchorRect(btnEl);
      popoverHandle?.toggle(undefined, { anchorRect, placement: 'top' });
    },
    onCompactClick() {
      sendCompactSafely({ preserveDraft: false, reason: 'manual' });
    }
  });

  function syncDisplayLocation() {
    if (settings.displayLocation === 'topbar') {
      pulseController.setEnabled(false);
      ctx.topbar?.setAvailable?.(true);
      if (!stopUnit) {
        stopUnit = ctx.topbar.registerUnit({
          id: 'ring',
          order: 10,
          label: '--',
          iconSvg: buildTopbarRingSvg(0),
          segments: buildCapsuleSegments(latestSnapshot, { showSpeed: settings.showSpeed, liveSpeed: latestLiveSpeed }),
          title: buildCapsuleTooltip(latestSnapshot, { liveSpeed: latestLiveSpeed }),
          render(node) {
            unitNode = node;
          },
          onClick() {
            popoverHandle?.toggle(undefined, { placement: 'bottom' });
          }
        });
      }
      void updateUnitDom(latestSnapshot, latestLiveSpeed);
    } else {
      if (typeof stopUnit === 'function') {
        try { stopUnit(); } catch {}
        stopUnit = null;
      }
      unitNode = null;
      ctx.topbar?.setAvailable?.(false);
      pulseController.setEnabled(true);
      pulseController.update(latestSnapshot, {
        showSpeed: settings.showSpeed,
        liveSpeed: latestLiveSpeed,
        showQuickCompact
      });
    }
  }

  function syncActiveDisplays() {
    if (settings.displayLocation === 'topbar') {
      void updateUnitDom(latestSnapshot, latestLiveSpeed);
    } else {
      pulseController.update(latestSnapshot, {
        showSpeed: settings.showSpeed,
        liveSpeed: latestLiveSpeed,
        showQuickCompact
      });
    }
    updatePanelDom(latestSnapshot, latestLiveSpeed);
  }

  function getLiveAssistantText() {
    const list = ctx.anchors.query('chat.messageList');
    if (list && typeof list.querySelectorAll === 'function') {
      const responses = list.querySelectorAll('[data-testid="agent-response"]');
      if (responses && responses.length > 0) {
        return String(responses[responses.length - 1]?.textContent || '');
      }
      return String(list.textContent || '');
    }
    if (docRefGlobal && typeof docRefGlobal.querySelectorAll === 'function') {
      const responses = docRefGlobal.querySelectorAll('[data-testid="agent-response"]');
      if (responses && responses.length > 0) {
        return String(responses[responses.length - 1]?.textContent || '');
      }
    }
    return String(list?.textContent || '');
  }

  function resetToEmptySessionState(cascadeId = null) {
    speedTracker.reset();
    latestLiveSpeed = null;
    pendingAutoCompact = null;
    showQuickCompact = false;
    latestSnapshot = buildRendererEmptySnapshot(cascadeId);
    evaluateCompactState(latestSnapshot, { allowAutoTrigger: false });
    syncActiveDisplays();
    try {
      void ctx.state?.set?.('state:context.snapshot@1', latestSnapshot);
    } catch {}
  }

  function syncSessionTransition() {
    const domCtx = readDomSessionContext();
    const cascadeChanged = domCtx.cascadeId !== lastObservedCascadeId;
    const enteredNewEmpty = domCtx.isNewEmptyChat && !lastObservedIsNewEmptyChat;
    const leftNewEmpty = !domCtx.isNewEmptyChat && lastObservedIsNewEmptyChat;
    if (!cascadeChanged && !enteredNewEmpty && !leftNewEmpty) {
      return domCtx;
    }
    lastObservedCascadeId = domCtx.cascadeId;
    lastObservedIsNewEmptyChat = domCtx.isNewEmptyChat;

    if (cascadeChanged || enteredNewEmpty) {
      refreshSeq += 1;
      resetToEmptySessionState(domCtx.cascadeId);
      void refresh(false);
    } else if (leftNewEmpty) {
      void refresh(true);
    }
    return domCtx;
  }

  function sampleLiveStreaming() {
    const domCtx = syncSessionTransition();
    const busy = Boolean(ctx.hostDom?.isAssistantBusy?.());
    const text = busy ? getLiveAssistantText() : '';
    const { live, completed } = speedTracker.sample({ busy, text });
    const prevKey = latestLiveSpeed
      ? `${latestLiveSpeed.phase}:${latestLiveSpeed.tps}:${latestLiveSpeed.estimatedOutputTokens}`
      : 'idle';
    const nextKey = live
      ? `${live.phase}:${live.tps}:${live.estimatedOutputTokens}`
      : 'idle';
    latestLiveSpeed = live;
    publishLiveState(domCtx?.cascadeId || null, busy, live, completed || !busy);

    const prevQuick = showQuickCompact;
    evaluateCompactState(latestSnapshot);
    if (prevKey !== nextKey || prevQuick !== showQuickCompact || busy) {
      syncActiveDisplays();
    }
    if (completed) {
      void refresh(true);
    }
  }

  async function refresh(force = false) {
    const seq = ++refreshSeq;
    try {
      const endpoint = force ? '/rescan' : '/snapshot';
      const domCtx = readDomSessionContext();
      lastObservedCascadeId = domCtx.cascadeId;
      lastObservedIsNewEmptyChat = domCtx.isNewEmptyChat;
      const snap = await ctx.bridge.post(endpoint, {
        cascadeId: domCtx.cascadeId,
        isNewChat: domCtx.isNewEmptyChat,
        force
      });
      const afterCtx = readDomSessionContext();
      if (
        seq !== refreshSeq
        || afterCtx.cascadeId !== domCtx.cascadeId
        || (afterCtx.isNewEmptyChat && !domCtx.isNewEmptyChat)
      ) {
        return null;
      }
      if (snap && typeof snap === 'object') {
        latestSnapshot = snap;
        evaluateCompactState(snap);
        syncActiveDisplays();
        try { await ctx.state.set('state:context.snapshot@1', snap); } catch {}
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

  function startLiveSpeedLoop() {
    if (typeof stopLiveTick === 'function') {
      try { stopLiveTick(); } catch {}
      stopLiveTick = null;
    }
    stopLiveTick = ctx.schedule.every(400, () => {
      sampleLiveStreaming();
    });
  }

  const onDocInput = () => {
    if (isSendingCompact) return;
    const prevQuick = showQuickCompact;
    evaluateCompactState(latestSnapshot, { allowAutoTrigger: false });
    if (prevQuick !== showQuickCompact && settings.displayLocation === 'composer') {
      pulseController.update(latestSnapshot, { showQuickCompact });
    }
  };
  docRefGlobal?.addEventListener?.('input', onDocInput, true);

  const stopSettingsSub = typeof ctx.settings?.onChange === 'function'
    ? ctx.settings.onChange((nextValues, changedKeys) => {
        const prevPoll = settings.pollIntervalMs;
        const prevLocation = settings.displayLocation;
        settings = normalizeContextSettings(nextValues);
        const keys = Array.isArray(changedKeys) ? changedKeys : [];
        if (settings.displayLocation !== prevLocation || keys.includes('displayLocation') || keys.includes('showPulseCapsule')) {
          popoverHandle?.toggle(false);
          syncDisplayLocation();
        }
        if (latestSnapshot && latestSnapshot.hasSession) {
          const warnTokens = resolveThresholdTokens(settings.warnThreshold, latestSnapshot.budget, 240000);
          const cliffTokens = resolveThresholdTokens(settings.cliffThreshold, latestSnapshot.budget, 328000);
          const used = Number(latestSnapshot.used || 0);
          latestSnapshot = {
            ...latestSnapshot,
            warnThreshold: settings.warnThreshold,
            cliffThreshold: settings.cliffThreshold,
            warnThresholdTokens: warnTokens,
            cliffThresholdTokens: cliffTokens,
            cacheCliffRisk: used >= cliffTokens ? 'critical' : (used >= warnTokens ? 'warn' : 'none')
          };
          if (keys.length === 0 || keys.includes('warnThreshold') || keys.includes('cliffThreshold') || keys.includes('warnThresholdTokens') || keys.includes('cliffThresholdTokens')) {
            void refresh(false);
          }
          evaluateCompactState(latestSnapshot);
        }
        syncActiveDisplays();
        if (settings.pollIntervalMs !== prevPoll) {
          startPollLoop();
        }
      })
    : () => {};

  const stopUiSvc = ctx.services.provide('context-ui', {
    getSnapshot: () => latestSnapshot,
    rescan: () => refresh(true),
    evaluateCompactState: (snapOverride, opts) => {
      if (snapOverride) latestSnapshot = snapOverride;
      const res = evaluateCompactState(latestSnapshot, opts);
      syncActiveDisplays();
      return res;
    },
    triggerCompact: (opts) => sendCompactSafely(opts),
    togglePanel(force, opts) {
      let resolvedOpts = opts;
      if (!resolvedOpts && settings.displayLocation === 'composer') {
        const btn = docRefGlobal?.querySelector?.('[data-agy-context-capsule="1"]');
        resolvedOpts = { anchorRect: extractAnchorRect(btn), placement: 'top' };
      }
      return popoverHandle?.toggle(force, resolvedOpts);
    },
    sampleLiveStreaming: () => sampleLiveStreaming()
  });

  const initDomCtx = readDomSessionContext();
  lastObservedCascadeId = initDomCtx.cascadeId;
  lastObservedIsNewEmptyChat = initDomCtx.isNewEmptyChat;
  if (initDomCtx.isNewEmptyChat) {
    resetToEmptySessionState(null);
  }
  syncDisplayLocation();
  await refresh(false);
  startPollLoop();
  startLiveSpeedLoop();

  disposers.push(
    () => { if (typeof stopPoll === 'function') stopPoll(); stopPoll = null; },
    () => { if (typeof stopLiveTick === 'function') stopLiveTick(); stopLiveTick = null; },
    () => docRefGlobal?.removeEventListener?.('input', onDocInput, true),
    () => {
      for (const tid of Array.from(trackedTimers)) clearTimeout(tid);
      trackedTimers.clear();
    },
    stopSettingsSub,
    stopUiSvc,
    () => { if (typeof stopUnit === 'function') stopUnit(); stopUnit = null; unitNode = null; },
    () => popoverHandle?.dispose(),
    () => pulseController.dispose(),
    () => { try { Promise.resolve(ctx.state?.set?.('state:context.live@1', null)).catch(() => {}); } catch {} },
    stopPanelStyles,
    stopPulseStyles
  );
}

function dispose() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = {
  normalizeContextSettings,
  formatStatusBadge,
  formatTopbarRingLabel,
  renderPanelHtml,
  mount,
  dispose
};
