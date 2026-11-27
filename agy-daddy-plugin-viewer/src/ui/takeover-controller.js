'use strict';

const {
  DEFAULT_SETTINGS,
  EVENT_VIEWER_MODE_CHANGED,
  ERROR_CODES,
  classifyExtension
} = require('../constants');
const { VIEWER_STAGE_STYLES } = require('../styles');
const {
  getClientOrigin,
  getInlineDisplay,
  setInlineDisplay,
  createShadowHost,
  clearNode,
  renderStatusCard
} = require('./dom-helpers');
const { createHeaderCapsule, OMNI_CATEGORIES } = require('./header-capsule');

const STAGE_HOST_ID = 'agy-viewer-stage-host';
const SECURITY_ERROR_CODES = new Set([
  ERROR_CODES.PATH_OUT_OF_BOUNDS,
  ERROR_CODES.UNC_PATH_BLOCKED,
  ERROR_CODES.SYMLINK_ESCAPE,
  ERROR_CODES.SENSITIVE_PATH_BLOCKED
]);

function extractFilePathFromHeader(headerEl) {
  if (!headerEl) return { rawPath: '', hintText: '' };
  const direct = (
    headerEl.getAttribute?.('data-file-path')
    || headerEl.getAttribute?.('data-uri')
    || headerEl.getAttribute?.('data-path')
    || ''
  ).trim();
  if (direct) return { rawPath: direct, hintText: direct };

  const childWithPath = headerEl.querySelector?.('[data-file-path], [data-uri], [data-path]');
  if (childWithPath) {
    const childPath = (
      childWithPath.getAttribute?.('data-file-path')
      || childWithPath.getAttribute?.('data-uri')
      || childWithPath.getAttribute?.('data-path')
      || ''
    ).trim();
    if (childPath) return { rawPath: childPath, hintText: childPath };
  }

  const titleAttr = String(headerEl.getAttribute?.('title') || '').trim();
  const textHint = String(headerEl.textContent || '').trim();
  const cand = titleAttr || textHint;
  if (cand && (cand.includes('/') || cand.includes('\\') || cand.startsWith('file://'))) {
    return { rawPath: cand.split(/\s+/)[0], hintText: textHint };
  }
  return { rawPath: '', hintText: textHint };
}

function resolveFileViewerBody(headerEl) {
  const parent = headerEl?.parentElement;
  if (!parent) return headerEl?.nextElementSibling || null;
  const siblings = Array.from(parent.children || []);
  const headerIdx = siblings.indexOf(headerEl);
  const candidates = headerIdx >= 0 ? siblings.slice(headerIdx + 1) : siblings;
  for (const node of candidates) {
    if (!node || node === headerEl) continue;
    const id = node.id || '';
    if (
      id === 'agy-inline-file-editor-panel'
      || id === 'agy-viewer-header-host'
      || id === 'agy-viewer-stage-host'
      || id === 'agy-viewer-drawer-host'
    ) continue;
    return node;
  }
  return null;
}

function isChatNavInlineEditorOpen(headerEl) {
  const parent = headerEl?.parentElement;
  if (!parent) return false;
  return Boolean(parent.querySelector?.('#agy-inline-file-editor-panel'));
}

function hasNativeTruncatedHint(bodyEl) {
  if (!bodyEl) return false;
  const text = String(bodyEl.textContent || '');
  return /(?:truncated|too large|文件过大|已截断|无法预览)/i.test(text);
}

function hasUsableNativePreview(bodyEl, category) {
  if (!bodyEl) return false;
  if (category === 'font') return false;
  if (category === 'media') {
    const mediaNode = bodyEl.querySelector?.('video, audio');
    if (!mediaNode) return false;
    return !hasNativeTruncatedHint(bodyEl);
  }
  return !hasNativeTruncatedHint(bodyEl);
}

function shouldAutoTakeover({ inspectRes, bodyEl, settings, manualOverride }) {
  if (!settings?.enabled) return false;
  if (!inspectRes?.authorized || !inspectRes?.exists) return false;
  if (manualOverride === 'native') return false;

  const category = inspectRes.category || 'other';
  if (!OMNI_CATEGORIES.has(category)) return false;

  if (category === 'media' && settings.enableMediaViewer === false) return false;
  if (category === 'csv' && settings.enableCsvViewer === false) return false;
  if (category === 'svg' && settings.enableSvgViewer === false) return false;
  if (category === 'font' && settings.enableFontViewer === false) return false;

  if (settings.officialFirstDeferral === false) {
    return true;
  }

  const size = Number(inspectRes.size || 0);
  if (category === 'media') {
    const thresholdBytes = Math.max(0, Number(settings.mediaThresholdMB ?? 5)) * 1024 * 1024;
    if (size >= thresholdBytes) return true;
    return !hasUsableNativePreview(bodyEl, 'media');
  }
  if (category === 'csv') {
    const thresholdBytes = Math.max(0, Number(settings.csvThresholdMB ?? 1)) * 1024 * 1024;
    const thresholdLines = Math.max(1, Number(settings.csvThresholdLines ?? 2000));
    if (size >= thresholdBytes) return true;
    if (Number(inspectRes.estimatedLines || 0) >= thresholdLines) return true;
    return hasNativeTruncatedHint(bodyEl);
  }
  if (category === 'svg') {
    const mode = settings.svgTakeoverMode || 'threshold';
    if (mode === 'always') return true;
    if (mode === 'manual') return false;
    const thresholdBytes = Math.max(0, Number(settings.svgThresholdKB ?? 64)) * 1024;
    return size >= thresholdBytes;
  }
  if (category === 'font') {
    return settings.fontAutoTakeover !== false;
  }
  return false;
}

function createTakeoverController({
  ctx,
  doc,
  t,
  getSettings,
  viewers
}) {
  const originalDisplayMap = new WeakMap();
  const manualOverrides = new Map(); // filePath -> 'native' | 'omni' | 'diff'

  let disposed = false;
  let activeHeaderEl = null;
  let activeFilePath = '';
  let activeRawPath = '';
  let activeInspect = null;
  let activeMode = 'native'; // 'native' | 'omni' | 'diff'
  let stageHostEl = null;
  let stageRootEl = null;
  let activeHiddenBodyEl = null;
  let activeAbortCtrl = null;
  let activeTicketId = null;
  let activeCleanupFns = [];
  let headerObserver = null;
  let parentObserver = null;
  let syncSeq = 0;

  const headerCapsule = createHeaderCapsule({
    doc,
    t,
    onAction: (action) => {
      void handleUserModeAction(action);
    }
  });

  function trackCleanup(fn) {
    if (typeof fn === 'function') activeCleanupFns.push(fn);
  }

  function restoreNativeBodyDisplay() {
    if (activeHiddenBodyEl) {
      const orig = originalDisplayMap.has(activeHiddenBodyEl)
        ? originalDisplayMap.get(activeHiddenBodyEl)
        : '';
      setInlineDisplay(activeHiddenBodyEl, orig);
      originalDisplayMap.delete(activeHiddenBodyEl);
      activeHiddenBodyEl = null;
    }
  }

  function cleanupActiveStage() {
    if (activeAbortCtrl) {
      try { activeAbortCtrl.abort(); } catch {}
      activeAbortCtrl = null;
    }

    for (const fn of activeCleanupFns) {
      try { fn(); } catch {}
    }
    activeCleanupFns = [];

    if (stageRootEl) {
      const mediaNodes = stageRootEl.querySelectorAll?.('video, audio') || [];
      for (const m of mediaNodes) {
        try {
          m.pause?.();
          m.removeAttribute?.('src');
          m.load?.();
        } catch {}
      }
    }

    if (activeTicketId) {
      const tid = activeTicketId;
      activeTicketId = null;
      ctx?.bridge?.post?.('/gateway/revoke', { ticketId: tid }).catch(() => {});
    }

    if (stageHostEl) {
      stageHostEl.remove?.();
      stageHostEl = null;
    }
    stageRootEl = null;
    restoreNativeBodyDisplay();
  }

  function mountStageShadow(headerEl) {
    cleanupActiveStage();
    const parentEl = headerEl?.parentElement || doc.body;
    const bodyEl = resolveFileViewerBody(headerEl);
    if (bodyEl) {
      if (!originalDisplayMap.has(bodyEl)) {
        originalDisplayMap.set(bodyEl, getInlineDisplay(bodyEl));
      }
      setInlineDisplay(bodyEl, 'none');
      activeHiddenBodyEl = bodyEl;
    }

    const { hostEl, rootEl } = createShadowHost(doc, STAGE_HOST_ID, VIEWER_STAGE_STYLES);
    stageHostEl = hostEl;
    stageRootEl = rootEl;

    if (bodyEl && bodyEl.parentElement === parentEl && typeof parentEl.insertBefore === 'function') {
      parentEl.insertBefore(hostEl, bodyEl);
    } else {
      parentEl.appendChild(hostEl);
    }
    return rootEl;
  }

  function renderStageError(headerEl, { title, desc, errorCode, retryAction }) {
    const rootEl = mountStageShadow(headerEl);
    clearNode(rootEl);
    const isSecurity = SECURITY_ERROR_CODES.has(errorCode);
    const actions = [];
    if (retryAction && !isSecurity) {
      actions.push({ label: t('common.retry'), onClick: () => void handleUserModeAction(retryAction) });
    }
    if (isSecurity) {
      actions.push({
        label: t('common.openSettings'),
        onClick: () => ctx?.settings?.open?.({ tab: 'plugins' })
      });
    }
    actions.push({
      label: t('common.backToNative'),
      onClick: () => void handleUserModeAction('native')
    });
    rootEl.appendChild(renderStatusCard(doc, {
      title: title || t('error.loadFailed', { message: '' }),
      desc,
      danger: isSecurity,
      actions
    }));
  }

  async function enterMode(headerEl, mode, { userInitiated = false } = {}) {
    const settings = getSettings();
    const { rawPath, hintText } = extractFilePathFromHeader(headerEl);

    if (mode === 'native') {
      activeMode = 'native';
      cleanupActiveStage();
      updateCapsule(headerEl);
      if (userInitiated) {
        ctx?.events?.emit?.(EVENT_VIEWER_MODE_CHANGED, { mode: 'native', filePath: activeFilePath }).catch?.(() => {});
      }
      return;
    }

    if (!settings.enabled) {
      activeMode = 'native';
      cleanupActiveStage();
      updateCapsule(headerEl);
      return;
    }

    if (!rawPath) {
      if (userInitiated) {
        activeMode = mode;
        renderStageError(headerEl, {
          title: t('error.unresolvablePath'),
          errorCode: ERROR_CODES.PATH_OUT_OF_BOUNDS
        });
        updateCapsule(headerEl);
      }
      return;
    }

    let inspectRes = activeInspect;
    if (!inspectRes || (activeRawPath !== rawPath && activeFilePath !== rawPath)) {
      try {
        inspectRes = await ctx.bridge.post('/file/inspect', { rawPath, hintText });
      } catch (err) {
        if (userInitiated) {
          activeMode = mode;
          renderStageError(headerEl, {
            title: t('error.loadFailed', { message: err?.message || 'BRIDGE_ERROR' }),
            retryAction: mode
          });
          updateCapsule(headerEl);
        }
        return;
      }
    }

    if (disposed) return;

    if (!inspectRes?.authorized) {
      if (userInitiated) {
        activeMode = mode;
        renderStageError(headerEl, {
          title: t('error.pathOutOfBounds'),
          desc: t('error.unresolvablePath'),
          errorCode: inspectRes?.errorCode || ERROR_CODES.PATH_OUT_OF_BOUNDS
        });
        updateCapsule(headerEl);
      }
      return;
    }

    activeInspect = inspectRes;
    activeRawPath = rawPath;
    activeFilePath = inspectRes.filePath || rawPath;

    if (mode === 'diff') {
      activeMode = 'diff';
      const rootEl = mountStageShadow(headerEl);
      const abortCtrl = new AbortController();
      activeAbortCtrl = abortCtrl;
      updateCapsule(headerEl);
      await viewers.mountDiffStage({
        ctx,
        doc,
        t,
        rootEl,
        filePath: activeFilePath,
        settings,
        signal: abortCtrl.signal,
        trackCleanup,
        onBackToNative: () => void handleUserModeAction('native'),
        onOpenInOmni: (cat) => {
          if (OMNI_CATEGORIES.has(cat)) {
            void handleUserModeAction('omni');
          }
        }
      });
      if (userInitiated) {
        ctx?.events?.emit?.(EVENT_VIEWER_MODE_CHANGED, { mode: 'diff', filePath: activeFilePath }).catch?.(() => {});
      }
      return;
    }

    if (mode === 'omni') {
      const category = inspectRes.category || classifyExtension(inspectRes.ext).category;
      if (!OMNI_CATEGORIES.has(category)) {
        if (userInitiated) {
          renderStageError(headerEl, { title: t('error.loadFailed', { message: 'UNSUPPORTED_FORMAT' }) });
        }
        return;
      }

      let ticketRes;
      try {
        ticketRes = await ctx.bridge.post('/gateway/ticket', {
          filePath: activeFilePath,
          purpose: category,
          clientOrigin: getClientOrigin()
        });
      } catch (err) {
        activeMode = 'omni';
        renderStageError(headerEl, {
          title: t('error.loadFailed', { message: err?.message || 'GATEWAY_ERROR' }),
          retryAction: 'omni'
        });
        updateCapsule(headerEl);
        return;
      }

      if (disposed) return;
      if (!ticketRes?.ok) {
        activeMode = 'omni';
        renderStageError(headerEl, {
          title: ticketRes?.message || t('error.loadFailed', { message: ticketRes?.errorCode || 'TICKET_FAILED' }),
          errorCode: ticketRes?.errorCode,
          retryAction: 'omni'
        });
        updateCapsule(headerEl);
        return;
      }

      activeMode = 'omni';
      const rootEl = mountStageShadow(headerEl);
      const abortCtrl = new AbortController();
      activeAbortCtrl = abortCtrl;
      activeTicketId = ticketRes.ticketId;
      updateCapsule(headerEl);

      const commonArgs = {
        ctx,
        doc,
        t,
        rootEl,
        ticket: ticketRes,
        filePath: activeFilePath,
        settings,
        signal: abortCtrl.signal,
        trackCleanup,
        onBackToNative: () => void handleUserModeAction('native'),
        onRetry: () => void handleUserModeAction('omni')
      };

      if (category === 'media') await viewers.mountMediaViewer(commonArgs);
      else if (category === 'csv') await viewers.mountCsvViewer(commonArgs);
      else if (category === 'svg') await viewers.mountSvgViewer(commonArgs);
      else if (category === 'font') await viewers.mountFontViewer(commonArgs);

      if (userInitiated) {
        ctx?.events?.emit?.(EVENT_VIEWER_MODE_CHANGED, { mode: 'omni', filePath: activeFilePath, category }).catch?.(() => {});
      }
    }
  }

  async function handleUserModeAction(action) {
    if (disposed || !activeHeaderEl) return;
    const key = activeFilePath || extractFilePathFromHeader(activeHeaderEl).rawPath;
    if (key) {
      manualOverrides.set(key, action);
    }
    await enterMode(activeHeaderEl, action, { userInitiated: true });
  }

  function updateCapsule(headerEl) {
    const settings = getSettings();
    headerCapsule.update(headerEl, {
      enabled: Boolean(settings.enabled),
      showHeaderSwitchButton: settings.showHeaderSwitchButton !== false,
      enableGitDiff: settings.enableGitDiff !== false,
      category: activeInspect?.category || 'other',
      gitChanged: Boolean(activeInspect?.gitChanged),
      gitStats: activeInspect?.gitStats || null,
      mode: activeMode,
      settings
    });
  }

  async function syncWithHeader(headerEl) {
    if (disposed) return;
    const seq = ++syncSeq;
    activeHeaderEl = headerEl || null;
    if (!headerEl) {
      activeFilePath = '';
      activeRawPath = '';
      activeInspect = null;
      activeMode = 'native';
      headerCapsule.dispose();
      cleanupActiveStage();
      return;
    }

    const settings = getSettings();
    if (!settings.enabled) {
      activeMode = 'native';
      headerCapsule.dispose();
      cleanupActiveStage();
      return;
    }

    if (isChatNavInlineEditorOpen(headerEl)) {
      if (activeMode !== 'native') {
        activeMode = 'native';
        cleanupActiveStage();
      }
      updateCapsule(headerEl);
      return;
    }

    const { rawPath, hintText } = extractFilePathFromHeader(headerEl);
    if (!rawPath) {
      activeFilePath = '';
      activeRawPath = '';
      activeInspect = null;
      activeMode = 'native';
      headerCapsule.dispose();
      cleanupActiveStage();
      return;
    }

    const fileChanged = rawPath !== activeRawPath && rawPath !== activeFilePath;
    if (fileChanged) {
      activeMode = 'native';
      cleanupActiveStage();
    }

    let inspectRes;
    try {
      inspectRes = await ctx.bridge.post('/file/inspect', { rawPath, hintText });
    } catch {
      inspectRes = null;
    }
    if (disposed || seq !== syncSeq) return;

    if (!inspectRes?.authorized || !inspectRes?.exists) {
      activeRawPath = rawPath;
      activeFilePath = rawPath;
      activeInspect = inspectRes;
      // Silent deferral when unauthorized/unresolvable
      if (activeMode !== 'native') {
        activeMode = 'native';
        cleanupActiveStage();
      }
      headerCapsule.dispose();
      return;
    }

    activeInspect = inspectRes;
    activeRawPath = rawPath;
    activeFilePath = inspectRes.filePath || rawPath;

    const bodyEl = resolveFileViewerBody(headerEl);
    const override = manualOverrides.get(activeFilePath) || manualOverrides.get(rawPath) || null;

    if (override === 'native') {
      // Anti-rebound lock: host DOM re-renders must NOT re-hijack native preview
      if (activeMode !== 'native') {
        activeMode = 'native';
        cleanupActiveStage();
      }
      updateCapsule(headerEl);
      return;
    }

    if (override === 'omni' || override === 'diff') {
      if (activeMode !== override || !stageHostEl || !stageHostEl.parentElement) {
        await enterMode(headerEl, override, { userInitiated: false });
      } else {
        updateCapsule(headerEl);
      }
      return;
    }

    if (shouldAutoTakeover({ inspectRes, bodyEl, settings, manualOverride: override })) {
      if (activeMode !== 'omni' || !stageHostEl || !stageHostEl.parentElement) {
        await enterMode(headerEl, 'omni', { userInitiated: false });
      } else {
        updateCapsule(headerEl);
      }
      return;
    }

    if (activeMode !== 'native') {
      activeMode = 'native';
      cleanupActiveStage();
    }
    updateCapsule(headerEl);
  }

  function attachHeaderObservers(headerEl) {
    if (headerObserver) {
      try { headerObserver.disconnect(); } catch {}
      headerObserver = null;
    }
    if (parentObserver) {
      try { parentObserver.disconnect(); } catch {}
      parentObserver = null;
    }
    if (!headerEl || typeof MutationObserver !== 'function') return;

    const isViewerOwnMutation = (mutations) => {
      if (!Array.isArray(mutations) || mutations.length === 0) return false;
      return mutations.every((m) => {
        const targetId = m?.target?.id || '';
        if (targetId.startsWith('agy-viewer-')) return true;
        const added = Array.from(m?.addedNodes || []);
        const removed = Array.from(m?.removedNodes || []);
        const all = [...added, ...removed];
        return all.length > 0 && all.every((n) => String(n?.id || '').startsWith('agy-viewer-'));
      });
    };

    headerObserver = new MutationObserver((mutations) => {
      if (isViewerOwnMutation(mutations)) return;
      void syncWithHeader(headerEl);
    });
    try {
      headerObserver.observe(headerEl, {
        attributes: true,
        attributeFilter: ['data-file-path', 'data-uri', 'data-path', 'title'],
        childList: true,
        subtree: true
      });
    } catch {}

    if (headerEl.parentElement) {
      parentObserver = new MutationObserver((mutations) => {
        if (isViewerOwnMutation(mutations)) return;
        void syncWithHeader(headerEl);
      });
      try {
        parentObserver.observe(headerEl.parentElement, { childList: true });
      } catch {}
    }
  }

  const stopAnchorObs = ctx.anchors.observe('fileViewer.header', (headerEl) => {
    if (disposed) return;
    attachHeaderObservers(headerEl);
    void syncWithHeader(headerEl);
  });

  async function toggleCurrentMode() {
    if (!activeHeaderEl) return { ok: false, reason: 'NO_ACTIVE_FILE_VIEWER' };
    if (activeMode === 'native') {
      await handleUserModeAction('omni');
    } else {
      await handleUserModeAction('native');
    }
    return { ok: true, mode: activeMode };
  }

  async function onSettingsChanged() {
    if (disposed) return;
    const settings = getSettings();
    if (!settings.enabled) {
      activeMode = 'native';
      headerCapsule.dispose();
      cleanupActiveStage();
      return;
    }
    await syncWithHeader(activeHeaderEl || ctx.anchors.query('fileViewer.header'));
  }

  function getState() {
    return {
      activeFilePath,
      activeMode,
      category: activeInspect?.category || null,
      hasHeader: Boolean(activeHeaderEl),
      hasStage: Boolean(stageHostEl),
      override: activeFilePath ? (manualOverrides.get(activeFilePath) || null) : null
    };
  }

  function dispose() {
    disposed = true;
    try { stopAnchorObs?.(); } catch {}
    if (headerObserver) {
      try { headerObserver.disconnect(); } catch {}
      headerObserver = null;
    }
    if (parentObserver) {
      try { parentObserver.disconnect(); } catch {}
      parentObserver = null;
    }
    headerCapsule.dispose();
    cleanupActiveStage();
    manualOverrides.clear();
    activeHeaderEl = null;
    activeInspect = null;
    activeFilePath = '';
    activeRawPath = '';
    activeMode = 'native';
  }

  return {
    syncWithHeader,
    refresh: () => syncWithHeader(activeHeaderEl || ctx.anchors.query('fileViewer.header')),
    toggleCurrentMode,
    openDiffForCurrent: () => handleUserModeAction('diff'),
    switchToNative: () => handleUserModeAction('native'),
    switchToOmni: () => handleUserModeAction('omni'),
    onSettingsChanged,
    getState,
    dispose
  };
}

module.exports = {
  STAGE_HOST_ID,
  extractFilePathFromHeader,
  resolveFileViewerBody,
  shouldAutoTakeover,
  createTakeoverController
};
