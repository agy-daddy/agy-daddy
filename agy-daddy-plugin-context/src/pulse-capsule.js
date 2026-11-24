'use strict';

const { formatTokensShort, getRingAccentToken } = require('./context-analyzer');

const SESSION_STACK_ICON_SVG = '<svg width="11.5" height="11.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.5 2.5 5.5 8 8.5l5.5-3L8 2.5Z"/><path d="M2.5 8.5 8 11.5l5.5-3"/><path d="M2.5 11.5 8 14.5l5.5-3"/></svg>';
const SPEED_BOLT_ICON_SVG = '<svg width="11.5" height="11.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.2 1.8 3.6 9h4.1l-.9 5.2L12.4 7H8.3l.9-5.2Z"/></svg>';
const ALERT_TRIANGLE_ICON_SVG = '<svg width="11.5" height="11.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.3 14 13H2L8 2.3Z"/><path d="M8 6.4v3.2"/><circle cx="8" cy="11.4" r="0.55" fill="currentColor" stroke="none"/></svg>';
const COMPACT_ICON_SVG = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v4.5M5.5 4.2 8 6.7l2.5-2.5"/><path d="M8 14V9.5M5.5 11.8 8 9.3l2.5 2.5"/><path d="M2.5 8h11"/></svg>';

const PULSE_CAPSULE_CSS = `
@keyframes agy-pulse-stream-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.48; }
}

#agy-pulse-context-wrap {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  padding: 5px 2px 0 2px;
  margin: 4px 0 0 0;
}

#agy-pulse-context-capsule {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  padding: 2px 9px;
  border-radius: 999px;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif;
  font-size: 11px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  line-height: 1.3;
  background: var(--ag-bg-subcard, var(--secondary, rgba(113, 113, 122, 0.10)));
  color: var(--ag-text-primary, var(--foreground, #18181b));
  border: 1px solid var(--ag-border-card, var(--border, rgba(113, 113, 122, 0.24)));
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 140ms cubic-bezier(0.22, 1, 0.36, 1), border-color 140ms cubic-bezier(0.22, 1, 0.36, 1);
}

#agy-pulse-context-capsule:hover {
  background: var(--ag-bg-control-hover, var(--sidebar-secondary, rgba(113, 113, 122, 0.16)));
  border-color: var(--ag-accent-border, rgba(113, 113, 122, 0.36));
}

#agy-pulse-context-capsule:focus-visible,
#agy-pulse-compact-btn:focus-visible {
  outline: 2px solid var(--ag-focus-ring, rgba(113, 113, 122, 0.45));
  outline-offset: 2px;
}

#agy-pulse-context-capsule[data-streaming="true"] {
  border-color: var(--ag-accent-border, rgba(113, 113, 122, 0.42));
}

#agy-pulse-context-capsule[data-streaming="true"] .agy-pulse-seg[data-kind="speed"] .agy-pulse-icon {
  animation: agy-pulse-stream-blink 1.1s ease-in-out infinite;
}

#agy-pulse-context-capsule[data-cache-risk="warn"] {
  border-color: rgba(245, 158, 11, 0.45);
}

#agy-pulse-context-capsule[data-cache-risk="critical"] {
  border-color: rgba(239, 68, 68, 0.48);
  color: var(--ag-ring-danger, #ef4444);
}

#agy-pulse-compact-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif;
  font-size: 11px;
  font-weight: 500;
  background: rgba(245, 158, 11, 0.12);
  color: var(--ag-ring-warn, #f59e0b);
  border: 1px solid rgba(245, 158, 11, 0.42);
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 140ms cubic-bezier(0.22, 1, 0.36, 1), border-color 140ms cubic-bezier(0.22, 1, 0.36, 1);
}

#agy-pulse-compact-btn:hover {
  background: rgba(245, 158, 11, 0.20);
  border-color: rgba(245, 158, 11, 0.65);
}

#agy-pulse-compact-btn[hidden] {
  display: none !important;
}

.agy-pulse-seg {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.agy-pulse-seg[data-tone="warn"] {
  color: var(--ag-ring-warn, #f59e0b);
}

.agy-pulse-seg[data-tone="danger"] {
  color: var(--ag-ring-danger, #ef4444);
}

.agy-pulse-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

#agy-pulse-context-wrap svg {
  flex-shrink: 0;
  display: block;
}
`.trim();

function clampPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function buildDualRatioSvg(occupancyPct = 0, cacheHitPct = 0, accentColor = 'var(--ag-custom-token-accent, var(--ag-token-accent-default, currentColor))') {
  const occ = clampPct(occupancyPct);
  const hit = clampPct(cacheHitPct);
  const rOuter = 6.2;
  const rInner = 3.4;
  const cOuter = Number((2 * Math.PI * rOuter).toFixed(2));
  const cInner = Number((2 * Math.PI * rInner).toFixed(2));
  const dOuter = Number(((occ / 100) * cOuter).toFixed(2));
  const dInner = Number(((hit / 100) * cInner).toFixed(2));
  return `<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" data-occ="${occ}" data-cache="${hit}">`
    + `<circle cx="8" cy="8" r="${rOuter}" fill="none" stroke="rgba(113,113,122,0.22)" stroke-width="2"/>`
    + `<circle cx="8" cy="8" r="${rOuter}" fill="none" stroke="${accentColor}" stroke-width="2" stroke-dasharray="${dOuter} ${cOuter}" transform="rotate(-90 8 8)"/>`
    + `<circle cx="8" cy="8" r="${rInner}" fill="none" stroke="rgba(113,113,122,0.18)" stroke-width="1.8"/>`
    + `<circle cx="8" cy="8" r="${rInner}" fill="none" stroke="var(--ag-custom-ring-used, var(--ag-text-secondary, #71717a))" stroke-width="1.8" stroke-dasharray="${dInner} ${cInner}" transform="rotate(-90 8 8)"/>`
    + `</svg>`;
}

function formatSpeedCompact(tps) {
  const n = Number(tps);
  if (!Number.isFinite(n) || n <= 0) return '';
  return n >= 100 ? `${Math.round(n)}/s` : `${Number(n.toFixed(1))}/s`;
}

function buildCapsuleSegments(snap, opts = {}) {
  const accent = getRingAccentToken(snap?.percent || 0, {
    isCacheDrop: Boolean(snap?.cacheDropDetected),
    isCliff328k: snap?.cacheCliffRisk === 'critical',
    isWarn240k: snap?.cacheCliffRisk === 'warn'
  });

  if (!snap || !snap.hasSession || snap.used === null) {
    return [
      {
        kind: 'window',
        iconSvg: buildDualRatioSvg(0, 0, accent),
        text: '--'
      }
    ];
  }

  const usedStr = formatTokensShort(snap.used);
  const budgetStr = formatTokensShort(snap.budget);
  const sessionTotal = snap.sessionUsage?.totalTokens ?? snap.used;

  const segments = [
    {
      kind: 'window',
      iconSvg: buildDualRatioSvg(snap.percent || 0, snap.cacheHitRate || 0, accent),
      text: `${usedStr}/${budgetStr}`
    },
    {
      kind: 'session',
      iconSvg: SESSION_STACK_ICON_SVG,
      text: formatTokensShort(sessionTotal)
    }
  ];

  if (opts.showSpeed !== false) {
    const live = opts.liveSpeed;
    if (live && live.active) {
      const liveText = live.tps ? `~${formatSpeedCompact(live.tps)}` : '…';
      segments.push({
        kind: 'speed',
        iconSvg: SPEED_BOLT_ICON_SVG,
        text: liveText,
        streaming: true
      });
    } else if (snap.speed?.tps) {
      segments.push({
        kind: 'speed',
        iconSvg: SPEED_BOLT_ICON_SVG,
        text: formatSpeedCompact(snap.speed.tps)
      });
    }
  }

  if (snap.cacheDropDetected || snap.cacheCliffRisk === 'critical') {
    segments.push({
      kind: 'alert',
      iconSvg: ALERT_TRIANGLE_ICON_SVG,
      text: '',
      tone: 'danger'
    });
  } else if (snap.cacheCliffRisk === 'warn') {
    segments.push({
      kind: 'alert',
      iconSvg: ALERT_TRIANGLE_ICON_SVG,
      text: '',
      tone: 'warn'
    });
  }

  return segments;
}

function buildCapsuleTooltip(snap, opts = {}) {
  if (!snap || !snap.hasSession || snap.used === null) {
    return '当前无活跃对话，点击打开实时监测面板';
  }
  const su = snap.sessionUsage || {};
  const sessionTotal = su.totalTokens ?? snap.used;
  const pctStr = snap.percent !== null && snap.percent !== undefined ? `${snap.percent}%` : '--';
  const live = opts.liveSpeed;
  const speedLine = live?.active
    ? (live.tps ? `实时估算速度: ~${live.tps} tok/s (生成中)` : '实时速度: 首字等待中…')
    : `生成速度: ${snap.speed?.tps ?? '--'} tok/s · 纯流式 ${snap.speed?.streamingTps ?? '--'} tok/s · TTFT ${snap.speed?.ttft ?? '--'}s`;
  const lines = [
    `上下文窗口: ${formatTokensShort(snap.used)} / ${formatTokensShort(snap.budget)} (${pctStr}) · 缓存命中 ${snap.cacheHitRate ?? 0}%`,
    `当前对话累计: ${formatTokensShort(sessionTotal)} (${su.callsCount || 0} 次调用 · 输出 ${formatTokensShort(su.outputTokens ?? snap.outputTokens ?? 0)})`,
    speedLine
  ];
  if (Array.isArray(snap.alerts) && snap.alerts.length) {
    lines.push(`风险提示: ${snap.alerts.map((a) => a.message).join('；')}`);
  }
  lines.push('点击展开详情面板与指标说明');
  return lines.join('\n');
}

function buildCapsuleText(snap, opts = {}) {
  const segs = buildCapsuleSegments(snap, opts);
  const parts = segs.map((s) => s.text).filter(Boolean);
  return parts.length ? parts.join(' · ') : '--';
}

function createPulseCapsuleController(options = {}) {
  const doc = options.doc || globalThis.document;
  const anchors = options.anchors;
  const onClick = typeof options.onClick === 'function' ? options.onClick : () => {};
  const onCompactClick = typeof options.onCompactClick === 'function' ? options.onCompactClick : () => {};
  const mountedEntries = new Set(); // { wrap, btn, compactBtn }
  let lastSnapshot = null;
  let lastState = { showSpeed: options.showSpeed !== false, liveSpeed: null, showQuickCompact: false };
  let enabled = options.enabled !== false;

  function applyStyleAndContent(entry, snap, stateOpts = lastState) {
    const { btn, compactBtn } = entry;
    const color = getRingAccentToken(snap?.percent || 0, {
      isCacheDrop: Boolean(snap?.cacheDropDetected),
      isCliff328k: snap?.cacheCliffRisk === 'critical',
      isWarn240k: snap?.cacheCliffRisk === 'warn'
    });
    const segments = buildCapsuleSegments(snap, stateOpts);
    const svgMarkup = segments[0]?.iconSvg || buildDualRatioSvg(snap?.percent || 0, snap?.cacheHitRate || 0, color);
    const targetDoc = btn?.ownerDocument || doc || globalThis.document;

    if (targetDoc?.createElement) {
      btn.textContent = '';
      for (const seg of segments) {
        const segEl = targetDoc.createElement('span');
        segEl.className = 'agy-pulse-seg';
        segEl.setAttribute('data-kind', seg.kind);
        if (seg.tone) segEl.setAttribute('data-tone', seg.tone);
        if (seg.streaming) segEl.setAttribute('data-streaming', 'true');

        if (seg.iconSvg) {
          const iconSpan = targetDoc.createElement('span');
          iconSpan.className = 'agy-pulse-icon';
          iconSpan.innerHTML = seg.iconSvg;
          segEl.appendChild(iconSpan);
        }
        if (seg.text) {
          const valSpan = targetDoc.createElement('span');
          valSpan.className = 'agy-pulse-val';
          valSpan.textContent = seg.text;
          segEl.appendChild(valSpan);
        }
        btn.appendChild(segEl);
      }
    } else {
      btn.textContent = buildCapsuleText(snap, stateOpts);
    }

    btn.setAttribute('data-cache-risk', snap?.cacheCliffRisk || 'none');
    btn.setAttribute('data-streaming', stateOpts?.liveSpeed?.active ? 'true' : 'false');
    btn.setAttribute('data-dual-svg', svgMarkup);
    btn.setAttribute('title', buildCapsuleTooltip(snap, stateOpts));
    if (btn.style && typeof btn.style.setProperty === 'function') {
      btn.style.setProperty('--agy-capsule-color', color);
    }

    if (compactBtn) {
      const showCompact = Boolean(stateOpts?.showQuickCompact);
      compactBtn.hidden = !showCompact;
      if (showCompact) {
        compactBtn.removeAttribute?.('hidden');
        if (compactBtn.style?.removeProperty) compactBtn.style.removeProperty('display');
      } else {
        compactBtn.setAttribute?.('hidden', 'true');
        if (compactBtn.style?.setProperty) compactBtn.style.setProperty('display', 'none');
      }
    }
  }

  function resolveComposerContainer(el) {
    if (!el) return null;
    const isFooter = String(el.className || '').split(/\s+/).includes('agy-composer-footer');
    if (isFooter && typeof el.closest === 'function') {
      return el.closest('.surface-composer, [data-testid="agent-input-box"]') || el.parentElement || el;
    }
    return el;
  }

  function ensureAttachedToComposer(rawContainerEl) {
    const containerEl = resolveComposerContainer(rawContainerEl);
    const targetDoc = containerEl?.ownerDocument || doc || globalThis.document;
    if (!enabled || !containerEl || !targetDoc?.createElement) return null;

    const hasParent = Boolean(containerEl.parentElement);
    const mountParent = containerEl.parentElement || containerEl;
    const directWrap = Array.from(mountParent.children || [])
      .find((ch) => ch?.getAttribute?.('data-agy-context-wrap') === '1') || null;
    const innerWrap = !directWrap && containerEl.querySelector
      ? containerEl.querySelector('[data-agy-context-wrap="1"]')
      : null;
    let wrap = directWrap || innerWrap;
    let btn = wrap?.querySelector ? wrap.querySelector('[data-agy-context-capsule="1"]') : null;
    let compactBtn = wrap?.querySelector ? wrap.querySelector('[data-agy-compact-quick="1"]') : null;

    if (!wrap) {
      wrap = targetDoc.createElement('div');
      wrap.id = 'agy-pulse-context-wrap';
      wrap.setAttribute('data-agy-context-wrap', '1');
      wrap.setAttribute('data-position', 'below-composer');

      btn = targetDoc.createElement('button');
      btn.type = 'button';
      btn.id = 'agy-pulse-context-capsule';
      btn.className = 'agy-pulse-capsule';
      btn.setAttribute('data-agy-context-capsule', '1');
      btn.addEventListener('click', () => onClick(btn));
      wrap.appendChild(btn);

      compactBtn = targetDoc.createElement('button');
      compactBtn.type = 'button';
      compactBtn.id = 'agy-pulse-compact-btn';
      compactBtn.setAttribute('data-agy-compact-quick', '1');
      compactBtn.setAttribute('title', '发送 /compact 压缩当前对话上下文');
      compactBtn.hidden = true;
      compactBtn.setAttribute('hidden', 'true');
      const iconSpan = targetDoc.createElement('span');
      iconSpan.className = 'agy-pulse-icon';
      iconSpan.innerHTML = COMPACT_ICON_SVG;
      const lblSpan = targetDoc.createElement('span');
      lblSpan.textContent = '压缩';
      compactBtn.appendChild(iconSpan);
      compactBtn.appendChild(lblSpan);
      compactBtn.addEventListener('click', () => onCompactClick());
      wrap.appendChild(compactBtn);
    } else {
      wrap.setAttribute?.('data-position', 'below-composer');
    }

    const parentChildren = Array.from(mountParent.children || []);
    const cIdx = hasParent ? parentChildren.indexOf(containerEl) : -1;
    const wIdx = parentChildren.indexOf(wrap);
    const needMove = wrap.parentElement !== mountParent
      || (hasParent && cIdx >= 0 && wIdx !== cIdx + 1);
    if (needMove) {
      const nextRef = hasParent && cIdx >= 0
        ? (parentChildren[cIdx + 1] && parentChildren[cIdx + 1] !== wrap ? parentChildren[cIdx + 1] : null)
        : null;
      if (nextRef && typeof mountParent.insertBefore === 'function') {
        mountParent.insertBefore(wrap, nextRef);
      } else {
        mountParent.appendChild(wrap);
      }
    }

    let entry = Array.from(mountedEntries).find((e) => e.wrap === wrap);
    if (!entry) {
      entry = { wrap, btn, compactBtn };
      mountedEntries.add(entry);
    }
    applyStyleAndContent(entry, lastSnapshot, lastState);
    return btn;
  }

  const stopObserve = anchors?.observe
    ? anchors.observe('composer.root', (el) => {
        if (el && enabled) ensureAttachedToComposer(el);
      })
    : () => {};

  if (enabled && anchors?.query) {
    const cur = anchors.query('composer.root');
    if (cur) ensureAttachedToComposer(cur);
  }

  return {
    update(snapshot, stateOpts = {}) {
      lastSnapshot = snapshot || null;
      if (stateOpts && typeof stateOpts === 'object') {
        lastState = {
          showSpeed: stateOpts.showSpeed !== undefined ? stateOpts.showSpeed !== false : lastState.showSpeed,
          liveSpeed: stateOpts.liveSpeed !== undefined ? stateOpts.liveSpeed : lastState.liveSpeed,
          showQuickCompact: stateOpts.showQuickCompact !== undefined ? Boolean(stateOpts.showQuickCompact) : lastState.showQuickCompact
        };
      }
      if (!enabled) return;
      for (const entry of Array.from(mountedEntries)) {
        if (!entry.wrap?.parentElement || entry.wrap.isConnected === false) {
          mountedEntries.delete(entry);
          continue;
        }
        applyStyleAndContent(entry, lastSnapshot, lastState);
      }
      if (mountedEntries.size === 0 && anchors?.query) {
        const el = anchors.query('composer.root');
        if (el) ensureAttachedToComposer(el);
      }
    },
    setEnabled(nextEnabled) {
      enabled = Boolean(nextEnabled);
      if (!enabled) {
        for (const entry of Array.from(mountedEntries)) {
          if (entry.wrap?.remove) entry.wrap.remove();
        }
        mountedEntries.clear();
      } else if (anchors?.query) {
        const el = anchors.query('composer.root');
        if (el) ensureAttachedToComposer(el);
      }
    },
    getMountedCount() {
      return mountedEntries.size;
    },
    dispose() {
      if (typeof stopObserve === 'function') stopObserve();
      for (const entry of Array.from(mountedEntries)) {
        if (entry.wrap?.remove) entry.wrap.remove();
      }
      mountedEntries.clear();
    }
  };
}

module.exports = {
  SESSION_STACK_ICON_SVG,
  SPEED_BOLT_ICON_SVG,
  ALERT_TRIANGLE_ICON_SVG,
  COMPACT_ICON_SVG,
  PULSE_CAPSULE_CSS,
  buildDualRatioSvg,
  formatSpeedCompact,
  buildCapsuleSegments,
  buildCapsuleTooltip,
  buildCapsuleText,
  createPulseCapsuleController
};
