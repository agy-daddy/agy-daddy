'use strict';

const { formatTokensShort, getRingAccentToken } = require('./context-analyzer');

function clampPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function buildDualRatioSvg(occupancyPct = 0, cacheHitPct = 0, accentColor = 'var(--ag-custom-token-accent, #a78bfa)') {
  const occ = clampPct(occupancyPct);
  const hit = clampPct(cacheHitPct);
  const rOuter = 6.2;
  const rInner = 3.4;
  const cOuter = Number((2 * Math.PI * rOuter).toFixed(2));
  const cInner = Number((2 * Math.PI * rInner).toFixed(2));
  const dOuter = Number(((occ / 100) * cOuter).toFixed(2));
  const dInner = Number(((hit / 100) * cInner).toFixed(2));
  return `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" data-occ="${occ}" data-cache="${hit}">`
    + `<circle cx="8" cy="8" r="${rOuter}" fill="none" stroke="rgba(167,139,250,0.22)" stroke-width="2"/>`
    + `<circle cx="8" cy="8" r="${rOuter}" fill="none" stroke="${accentColor}" stroke-width="2" stroke-dasharray="${dOuter} ${cOuter}" transform="rotate(-90 8 8)"/>`
    + `<circle cx="8" cy="8" r="${rInner}" fill="none" stroke="rgba(167,139,250,0.18)" stroke-width="1.8"/>`
    + `<circle cx="8" cy="8" r="${rInner}" fill="none" stroke="var(--ag-custom-ring-used, #a78bfa)" stroke-width="1.8" stroke-dasharray="${dInner} ${cInner}" transform="rotate(-90 8 8)"/>`
    + `</svg>`;
}

function createPulseCapsuleController(options = {}) {
  const doc = options.doc || globalThis.document;
  const anchors = options.anchors;
  const onClick = typeof options.onClick === 'function' ? options.onClick : () => {};
  const mountedCapsules = new Set();
  let lastSnapshot = null;
  let lastQuota = null;
  let enabled = options.enabled !== false;

  function buildCapsuleText(snap, quotaSnap = null) {
    if (!snap || !snap.hasSession || snap.used === null) {
      return 'Ctx --';
    }
    const usedStr = formatTokensShort(snap.used);
    const budgetStr = formatTokensShort(snap.budget);
    const pctStr = snap.percent !== null ? `${snap.percent}%` : '--';
    const spdStr = snap.speed?.tps ? ` · ${snap.speed.tps} tok/s` : '';
    const hitStr = typeof snap.cacheHitRate === 'number' ? ` · 缓存${snap.cacheHitRate}%` : '';
    const qCd = quotaSnap?.gemini?.countdownText || quotaSnap?.claude?.countdownText || '';
    const qStr = qCd ? ` · 5h:${qCd}` : '';
    const cliffMark = snap.cacheDropDetected
      ? ' [丢缓存0%]'
      : (snap.cacheCliffRisk === 'critical' ? ' [328K断崖]' : (snap.cacheCliffRisk === 'warn' ? ' [240K]' : ''));
    return `${usedStr}/${budgetStr} · ${pctStr}${spdStr}${hitStr}${qStr}${cliffMark}`;
  }

  function applyStyleAndContent(btn, snap, quotaSnap = null) {
    const color = getRingAccentToken(snap?.percent || 0, {
      isCacheDrop: Boolean(snap?.cacheDropDetected),
      isCliff328k: snap?.cacheCliffRisk === 'critical',
      isWarn240k: snap?.cacheCliffRisk === 'warn'
    });
    const svgMarkup = buildDualRatioSvg(snap?.percent || 0, snap?.cacheHitRate || 0, color);
    const labelText = buildCapsuleText(snap, quotaSnap);
    const targetDoc = btn?.ownerDocument || doc || globalThis.document;
    if (targetDoc?.createElement) {
      btn.textContent = '';
      const iconSpan = targetDoc.createElement('span');
      iconSpan.className = 'agy-pulse-icon';
      iconSpan.innerHTML = svgMarkup;
      const textSpan = targetDoc.createElement('span');
      textSpan.className = 'agy-pulse-text';
      textSpan.textContent = labelText;
      btn.appendChild(iconSpan);
      btn.appendChild(textSpan);
    } else {
      btn.textContent = labelText;
    }
    btn.setAttribute('data-cache-risk', snap?.cacheCliffRisk || 'none');
    btn.setAttribute('data-dual-svg', svgMarkup);
    if (btn.style && typeof btn.style.setProperty === 'function') {
      btn.style.setProperty('--agy-capsule-color', color);
    }
  }

  function ensureAttachedToComposer(containerEl) {
    const targetDoc = containerEl?.ownerDocument || doc || globalThis.document;
    if (!enabled || !containerEl || !targetDoc?.createElement) return null;
    let btn = containerEl.querySelector ? containerEl.querySelector('[data-agy-context-capsule="1"]') : null;
    if (!btn) {
      btn = targetDoc.createElement('button');
      btn.type = 'button';
      btn.id = 'agy-pulse-context-capsule';
      btn.className = 'agy-pulse-capsule';
      btn.setAttribute('data-agy-context-capsule', '1');
      btn.addEventListener('click', onClick);
      containerEl.appendChild(btn);
    }
    mountedCapsules.add(btn);
    applyStyleAndContent(btn, lastSnapshot, lastQuota);
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
    update(snapshot, quotaSnapshot = lastQuota) {
      lastSnapshot = snapshot || null;
      lastQuota = quotaSnapshot || null;
      if (!enabled) return;
      for (const btn of Array.from(mountedCapsules)) {
        applyStyleAndContent(btn, lastSnapshot, lastQuota);
      }
      if (mountedCapsules.size === 0 && anchors?.query) {
        const el = anchors.query('composer.root');
        if (el) ensureAttachedToComposer(el);
      }
    },
    setEnabled(nextEnabled) {
      enabled = Boolean(nextEnabled);
      if (!enabled) {
        for (const btn of Array.from(mountedCapsules)) {
          if (btn?.remove) btn.remove();
        }
        mountedCapsules.clear();
      } else if (anchors?.query) {
        const el = anchors.query('composer.root');
        if (el) ensureAttachedToComposer(el);
      }
    },
    getMountedCount() {
      return mountedCapsules.size;
    },
    dispose() {
      if (typeof stopObserve === 'function') stopObserve();
      for (const btn of Array.from(mountedCapsules)) {
        if (btn?.remove) btn.remove();
      }
      mountedCapsules.clear();
    }
  };
}

module.exports = {
  buildDualRatioSvg,
  createPulseCapsuleController
};
