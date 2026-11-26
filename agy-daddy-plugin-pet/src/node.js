'use strict';

const path = require('node:path');
const { getBuiltinThemes, getBuiltinThemeById } = require('./shared/themes');
const { mapTpsToMotion, createSpeedSmoother } = require('./shared/pet-rig-evaluator');
const {
  isSessionWatched,
  resolveSessionOrgInfo,
  classifyStepAttention,
  TailStepTpsEstimator
} = require('./session-watch-aggregator');
const {
  importThemePack,
  listCustomThemes,
  deleteCustomTheme
} = require('./theme-pack-sandbox');

let activeHost = null;
let disposers = [];

function getCustomThemesDir(host) {
  if (host.storage?.dir) {
    return path.join(host.storage.dir, 'custom-themes');
  }
  const stateDir = process.env.AGY_DADDY_STATE_DIR || path.join(process.cwd(), '.agy-pet-data');
  return path.join(stateDir, 'plugin-data', host.pluginId, 'custom-themes');
}

function normalizeSettings(raw = {}) {
  return {
    enabled: raw.enabled !== false,
    desktopVisible: raw.desktopVisible !== false,
    webVisible: raw.webVisible !== false,
    themeId: String(raw.themeId || 'daddy-orb').trim() || 'daddy-orb',
    petScale: Math.min(2.0, Math.max(0.6, Number(raw.petScale || 1.0))),
    roamMode: ['none', 'bottom-edge', 'screen-edges', 'free-workarea'].includes(raw.roamMode)
      ? raw.roamMode
      : 'bottom-edge',
    followCurrentSession: raw.followCurrentSession !== false,
    excludeCurrentSession: raw.excludeCurrentSession === true,
    projectWhitelist: Array.isArray(raw.projectWhitelist) ? raw.projectWhitelist.map(String).filter(Boolean) : [],
    groupWhitelist: Array.isArray(raw.groupWhitelist) ? raw.groupWhitelist.map(String).filter(Boolean) : []
  };
}

async function activate(host) {
  activeHost = host;
  const customThemesDir = getCustomThemesDir(host);
  const smoother = createSpeedSmoother(0.35);
  const tpsEstimator = new TailStepTpsEstimator(3000);
  const ackedBubbleIds = new Set();
  const lastAckedStepBySession = new Map();
  const stepCacheBySession = new Map();
  const lastErrorBySession = new Map();

  let overlayHandle = null;
  let overlaySupported = { supported: false, backend: 'none' };
  let liveContextState = null;
  let contextSnapshotState = null;
  let sessionOrgState = null;
  let readStateSnapshot = {};
  let activeSessionState = {
    desktopSessionId: null,
    desktopBusy: false,
    webSessionId: null,
    activeSurface: 'desktop',
    updatedAt: 0
  };
  let trajectorySummaries = {};
  let lastActiveAt = Date.now();
  let lastBroadcastJson = '';
  let pollTimer = null;
  let tailTimer = null;

  const savedPersisted = host.storage?.readJson?.('pet-ui.json', {})?.data || {};
  let webAnchor = savedPersisted.webAnchor && typeof savedPersisted.webAnchor === 'object'
    ? {
        xRatio: Math.min(0.95, Math.max(0.02, Number(savedPersisted.webAnchor.xRatio ?? 0.88))),
        yRatio: Math.min(0.95, Math.max(0.05, Number(savedPersisted.webAnchor.yRatio ?? 0.82)))
      }
    : { xRatio: 0.88, yRatio: 0.82 };
  let desktopBounds = savedPersisted.desktopBounds && typeof savedPersisted.desktopBounds === 'object'
    ? savedPersisted.desktopBounds
    : { width: 220, height: 200, anchor: 'bottom-right' };

  function persistUiPrefs() {
    try {
      host.storage?.writeJson?.('pet-ui.json', { webAnchor, desktopBounds });
    } catch {}
  }

  function listAllThemes() {
    const builtins = getBuiltinThemes();
    const customs = listCustomThemes(customThemesDir);
    return [...builtins, ...customs];
  }

  function resolveTheme(themeId) {
    const customs = listCustomThemes(customThemesDir);
    const customMatch = customs.find((t) => t.id === themeId);
    if (customMatch) return customMatch;
    return getBuiltinThemeById(themeId);
  }

  function getCurrentFocusSessionId() {
    if (activeSessionState.activeSurface === 'pc-web' && activeSessionState.webSessionId) {
      return activeSessionState.webSessionId;
    }
    return activeSessionState.desktopSessionId || contextSnapshotState?.cascadeId || null;
  }

  function buildPetState() {
    const settings = normalizeSettings(host.settings?.get?.() || {});
    const focusSessionId = getCurrentFocusSessionId();
    const pendingApprovals = [];
    const unreadReplies = [];
    const watchedSessions = [];

    for (const [cid, summary] of Object.entries(trajectorySummaries)) {
      const wsUri = summary?.workspaces?.[0]?.workspaceFolderAbsoluteUri || summary?.workspaceUri || '';
      const sessionObj = {
        cascadeId: cid,
        sessionTitle: summary?.annotations?.title || summary?.summary || cid.slice(0, 8),
        workspaceUri: wsUri,
        isSubagent: Boolean(summary?.isSubagent)
      };
      if (!isSessionWatched(sessionObj, settings, sessionOrgState, focusSessionId)) {
        continue;
      }
      const orgInfo = resolveSessionOrgInfo(sessionObj, sessionOrgState);
      const statusStr = String(summary?.status || '');
      const isRunning = /RUNNING/i.test(statusStr);
      const cached = stepCacheBySession.get(cid);
      const readRec = readStateSnapshot?.[cid];
      const readStepCount = Number(readRec?.readStepCount || 0);

      watchedSessions.push({
        cascadeId: cid,
        sessionTitle: sessionObj.sessionTitle,
        isRunning,
        isFocus: cid === focusSessionId,
        stepCount: Number(summary?.stepCount || 0),
        orgInfo
      });

      if (cached && Array.isArray(cached.steps)) {
        const startIdx = Math.max(0, cached.steps.length - 4);
        for (let i = cached.steps.length - 1; i >= startIdx; i--) {
          const item = classifyStepAttention(cached.steps[i], i, {
            cascadeId: cid,
            sessionTitle: sessionObj.sessionTitle,
            ...orgInfo
          });
          if (!item) continue;
          if (item.kind === 'approval') {
            if (!ackedBubbleIds.has(item.id)) {
              pendingApprovals.push(item);
            }
          } else if (item.kind === 'reply') {
            const totalSteps = Number(summary?.stepCount || cached.steps.length);
            const lastAckStep = lastAckedStepBySession.get(cid) || 0;
            if (!isRunning && totalSteps > readStepCount && i > lastAckStep && !ackedBubbleIds.has(item.id)) {
              unreadReplies.push(item);
            }
            break;
          } else if (item.kind === 'error') {
            if (!ackedBubbleIds.has(item.id)) {
              lastErrorBySession.set(cid, item);
            }
            break;
          }
        }
      }
    }

    // Determine primary TPS & busy source
    const liveValid = liveContextState && (Date.now() - Number(liveContextState.updatedAt || 0) < 15000);
    let activeTps = null;
    let activeBusy = false;
    let primarySessionId = focusSessionId;
    let primarySessionTitle = '';

    const focusWatched = watchedSessions.find((s) => s.isFocus);
    const runningWatched = watchedSessions.filter((s) => s.isRunning);

    if (
      settings.followCurrentSession &&
      !settings.excludeCurrentSession &&
      liveValid &&
      liveContextState.busy &&
      (!focusWatched || focusWatched.isRunning || liveContextState.tps !== null)
    ) {
      activeBusy = true;
      activeTps = liveContextState.tps ?? null;
      primarySessionId = liveContextState.cascadeId || focusSessionId;
    } else if (runningWatched.length > 0) {
      let best = runningWatched[0];
      let bestTps = tpsEstimator.sessions.get(best.cascadeId)?.lastTps ?? null;
      for (const s of runningWatched) {
        const candTps = (liveValid && liveContextState.cascadeId === s.cascadeId && liveContextState.tps !== null)
          ? liveContextState.tps
          : (stepCacheBySession.get(s.cascadeId)?.liveTps ?? null);
        if (candTps !== null && (bestTps === null || candTps > bestTps)) {
          best = s;
          bestTps = candTps;
        }
      }
      activeBusy = true;
      activeTps = bestTps;
      primarySessionId = best.cascadeId;
      primarySessionTitle = best.sessionTitle;
    }

    if (!primarySessionTitle && primarySessionId) {
      primarySessionTitle = trajectorySummaries[primarySessionId]?.annotations?.title
        || trajectorySummaries[primarySessionId]?.summary
        || '';
    }

    if (activeBusy || pendingApprovals.length > 0 || unreadReplies.length > 0) {
      lastActiveAt = Date.now();
    }
    const idleMs = Math.max(0, Date.now() - lastActiveAt);
    const hasApproval = pendingApprovals.length > 0;
    const activeError = Array.from(lastErrorBySession.values())[0] || null;
    const motionRaw = mapTpsToMotion({
      tps: activeTps,
      busy: activeBusy,
      idleMs,
      hasApproval,
      hasError: !hasApproval && Boolean(activeError)
    });
    const speedFactor = smoother.push(motionRaw.rawSpeedFactor);

    const activeBubble = pendingApprovals[0] || unreadReplies[0] || activeError || null;
    const theme = resolveTheme(settings.themeId);
    const projects = Array.isArray(sessionOrgState?.projects)
      ? sessionOrgState.projects.map((p) => ({ id: p.id, name: p.name }))
      : [];
    const groups = Array.isArray(sessionOrgState?.groups)
      ? sessionOrgState.groups.map((g) => ({ id: g.id, name: g.name }))
      : [];

    return {
      state: {
        enabled: settings.enabled,
        desktopVisible: settings.desktopVisible,
        webVisible: settings.webVisible,
        themeId: theme.id,
        petScale: settings.petScale,
        roamMode: settings.roamMode,
        webAnchor,
        motion: {
          animState: motionRaw.animState,
          tps: activeTps,
          speedFactor,
          roamSpeedPxPerSec: motionRaw.roamSpeedPxPerSec,
          primarySessionId,
          primarySessionTitle,
          watchedRunningCount: runningWatched.length
        },
        attention: {
          pendingApprovals,
          unreadReplies,
          activeBubble
        },
        orgCatalog: { projects, groups },
        updatedAt: Date.now()
      },
      theme
    };
  }

  async function syncOutputs(force = false) {
    const { state: petState, theme } = buildPetState();
    const signature = JSON.stringify({
      ...petState,
      updatedAt: 0
    });
    if (force || signature !== lastBroadcastJson) {
      lastBroadcastJson = signature;
      host.state?.set?.('state:pet.state@1', petState);
    }

    const wantDesktop = Boolean(petState.enabled && petState.desktopVisible && overlaySupported.supported);
    if (!wantDesktop) {
      if (overlayHandle) {
        try { await overlayHandle.dispose(); } catch {}
        overlayHandle = null;
      }
      return petState;
    }

    if (!overlayHandle && typeof host.overlay?.createWindow === 'function') {
      try {
        overlayHandle = await host.overlay.createWindow({
          id: 'pet-companion',
          bounds: desktopBounds,
          visible: true
        });
        overlayHandle.onInteraction((ev) => {
          void handleInteractionEvent({
            action: ev.type,
            bubbleId: ev.bubbleId,
            itemId: ev.itemId,
            bounds: ev.bounds
          });
        });
        await overlayHandle.setScene(theme.scene);
      } catch {
        overlayHandle = null;
        return petState;
      }
    }

    if (overlayHandle) {
      const bubble = petState.attention.activeBubble;
      await overlayHandle.updateState({
        animState: petState.motion.animState,
        speedFactor: petState.motion.speedFactor,
        tps: petState.motion.tps,
        scale: petState.petScale,
        roam: {
          enabled: petState.roamMode !== 'none',
          mode: petState.roamMode,
          baseSpeedPxPerSec: petState.motion.roamSpeedPxPerSec
        },
        bubble: bubble
          ? {
              id: bubble.id,
              kind: bubble.kind,
              title: bubble.sessionTitle ? `[${bubble.sessionTitle}]` : '会话动态',
              subtitle: bubble.summary,
              accentHex: theme.accentHex,
              dismissible: true
            }
          : null,
        contextMenu: [
          { id: 'open-settings', type: 'normal', label: '打开桌宠设置' },
          { id: 'hide-desktop', type: 'normal', label: '隐藏桌面置顶宠' }
        ]
      }).catch(() => {});
    }
    return petState;
  }

  async function handleInteractionEvent(payload = {}) {
    const action = String(payload.action || '');
    if (action === 'position-changed' && payload.bounds) {
      desktopBounds = { ...desktopBounds, ...payload.bounds };
      persistUiPrefs();
      return { ok: true };
    }
    if (action === 'update-web-anchor' && payload.webAnchor) {
      webAnchor = {
        xRatio: Math.min(0.95, Math.max(0.02, Number(payload.webAnchor.xRatio ?? webAnchor.xRatio))),
        yRatio: Math.min(0.95, Math.max(0.05, Number(payload.webAnchor.yRatio ?? webAnchor.yRatio)))
      };
      persistUiPrefs();
      return await syncOutputs(true);
    }
    if (action === 'ack-bubble' || action === 'bubble-dismiss' || action === 'bubble-click') {
      const bid = String(payload.bubbleId || '');
      if (bid) {
        ackedBubbleIds.add(bid);
        const parts = bid.split(':');
        if (parts.length >= 3) {
          const cid = parts[0];
          const stepIdx = Number(parts[1]);
          if (Number.isFinite(stepIdx)) {
            lastAckedStepBySession.set(cid, Math.max(lastAckedStepBySession.get(cid) || 0, stepIdx));
          }
          lastErrorBySession.delete(cid);
        }
      }
      if (action === 'bubble-click' && payload.cascadeId) {
        host.events?.emit?.('pet:focus-session@1', { cascadeId: String(payload.cascadeId), bubbleId: bid });
      } else if (action === 'bubble-click' && bid.includes(':')) {
        host.events?.emit?.('pet:focus-session@1', { cascadeId: bid.split(':')[0], bubbleId: bid });
      }
      await syncOutputs(true);
      return { ok: true };
    }
    if (action === 'pet-double-click' || (action === 'menu-click' && payload.itemId === 'open-settings')) {
      host.events?.emit?.('pet:open-settings@1', { pluginId: host.pluginId });
      return { ok: true };
    }
    if (action === 'menu-click' && payload.itemId === 'hide-desktop') {
      await host.settings?.update?.({ desktopVisible: false });
      return { ok: true };
    }
    return { ok: true };
  }

  async function pollTrajectories() {
    const settings = normalizeSettings(host.settings?.get?.() || {});
    if (!settings.enabled || (!settings.desktopVisible && !settings.webVisible)) return;
    try {
      const resp = await host.rpc.call('GetAllCascadeTrajectories', {
        metadata: { ideName: 'antigravity', extensionName: 'antigravity' }
      });
      if (resp && typeof resp.trajectorySummaries === 'object') {
        trajectorySummaries = resp.trajectorySummaries;
      }
      await syncOutputs(false);
    } catch {}
  }

  async function pollTailSteps() {
    const settings = normalizeSettings(host.settings?.get?.() || {});
    if (!settings.enabled || (!settings.desktopVisible && !settings.webVisible)) return;
    const focusId = getCurrentFocusSessionId();
    for (const [cid, summary] of Object.entries(trajectorySummaries)) {
      const isRunning = /RUNNING/i.test(String(summary?.status || ''));
      const totalSteps = Number(summary?.stepCount || 0);
      const cached = stepCacheBySession.get(cid);
      const needsRefresh = isRunning || !cached || cached.stepCount !== totalSteps;
      if (!needsRefresh) continue;
      if (!isSessionWatched({ cascadeId: cid, workspaceUri: summary?.workspaces?.[0]?.workspaceFolderAbsoluteUri }, settings, sessionOrgState, focusId)) {
        continue;
      }
      try {
        const startOffset = Math.max(0, totalSteps - 2);
        const res = await host.rpc.call('GetCascadeTrajectorySteps', {
          cascadeId: cid,
          stepOffset: startOffset
        });
        const steps = Array.isArray(res?.steps) ? res.steps : [];
        const tailText = steps.map((s) => s?.plannerResponse?.response || s?.plannerResponse?.thinking || '').join('\n');
        const liveTps = tpsEstimator.sample(cid, isRunning, tailText);
        const fullArr = cached?.steps ? [...cached.steps] : [];
        for (let i = 0; i < steps.length; i++) {
          fullArr[startOffset + i] = steps[i];
        }
        stepCacheBySession.set(cid, { stepCount: totalSteps, steps: fullArr, liveTps });
      } catch {}
    }
    await syncOutputs(false);
  }

  try {
    if (typeof host.overlay?.isSupported === 'function') {
      overlaySupported = await host.overlay.isSupported();
    }
  } catch {}

  const serviceMethods = {
    getSnapshot() {
      const { state: petState, theme } = buildPetState();
      return {
        ok: true,
        available: true,
        overlaySupported,
        state: petState,
        scene: theme.scene,
        themes: listAllThemes().map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          accentHex: t.accentHex,
          builtin: Boolean(t.builtin)
        }))
      };
    },
    getThemeRig(themeId) {
      return resolveTheme(themeId);
    },
    listThemes() {
      return listAllThemes();
    },
    setActiveWebSession(cascadeId) {
      activeSessionState = {
        ...activeSessionState,
        webSessionId: cascadeId ? String(cascadeId) : null,
        activeSurface: cascadeId ? 'pc-web' : 'desktop',
        updatedAt: Date.now()
      };
      host.state?.set?.('state:session.active@1', activeSessionState);
      void syncOutputs(false);
      return activeSessionState;
    },
    async handleInteraction(payload) {
      return await handleInteractionEvent(payload || {});
    },
    async importThemePack(payload = {}) {
      const imported = importThemePack({
        customThemesDir,
        archiveBase64: payload.archiveBase64,
        jsonText: payload.jsonText,
        svgText: payload.svgText,
        fileName: payload.fileName
      });
      await host.settings?.update?.({ themeId: imported.id });
      await syncOutputs(true);
      return { ok: true, theme: imported };
    },
    async deleteCustomTheme(themeId) {
      const res = deleteCustomTheme(customThemesDir, themeId);
      if (res.ok && host.settings?.get?.()?.themeId === res.id) {
        await host.settings.update({ themeId: 'daddy-orb' });
      }
      await syncOutputs(true);
      return res;
    }
  };

  disposers.push(
    host.services.provide('pet', serviceMethods, { realm: 'node', version: '1.0.0' }),
    await host.bridge.registerRoute('/state', async () => serviceMethods.getSnapshot()),
    await host.bridge.registerRoute('/interact', async (body) => serviceMethods.handleInteraction(body || {})),
    await host.bridge.registerRoute('/import-theme', async (body) => serviceMethods.importThemePack(body || {})),
    await host.bridge.registerRoute('/active-session', async (body) => {
      activeSessionState = {
        ...activeSessionState,
        desktopSessionId: body?.cascadeId ? String(body.cascadeId) : null,
        desktopBusy: Boolean(body?.busy),
        activeSurface: 'desktop',
        updatedAt: Date.now()
      };
      host.state?.set?.('state:session.active@1', activeSessionState);
      void syncOutputs(false);
      return { ok: true };
    }),
    host.state.subscribe('state:context.live@1', (val) => {
      liveContextState = val || null;
      void syncOutputs(false);
    }),
    host.state.subscribe('state:context.snapshot@1', (val) => {
      contextSnapshotState = val || null;
      void syncOutputs(false);
    }),
    host.state.subscribe('state:session.org@1', (val) => {
      sessionOrgState = val || null;
      void syncOutputs(true);
    }),
    host.state.subscribe('state:session.readState@1', (val) => {
      readStateSnapshot = val && typeof val === 'object' ? val : {};
      void syncOutputs(false);
    }),
    host.settings.onChange(async (nextValues, changedKeys) => {
      if (Array.isArray(changedKeys) && changedKeys.includes('themeId')) {
        const theme = resolveTheme(nextValues.themeId);
        if (overlayHandle) {
          await overlayHandle.setScene(theme.scene).catch(() => {});
        }
        host.events?.emit?.('pet:theme-changed@1', { themeId: theme.id });
      }
      await syncOutputs(true);
    }),
    await host.commands.register('pet.toggleDesktop', async () => {
      const cur = normalizeSettings(host.settings?.get?.() || {});
      return await host.settings.update({ desktopVisible: !cur.desktopVisible });
    }),
    await host.commands.register('pet.toggleWeb', async () => {
      const cur = normalizeSettings(host.settings?.get?.() || {});
      return await host.settings.update({ webVisible: !cur.webVisible });
    }),
    await host.commands.register('pet.listThemes', async () => listAllThemes().map((t) => ({
      value: t.id,
      label: t.name
    }))),
    await host.commands.register('pet.listProjectOptions', async () => {
      const projects = Array.isArray(sessionOrgState?.projects) ? sessionOrgState.projects : [];
      return projects.map((p) => ({ id: p.id, label: p.name || p.id }));
    }),
    await host.commands.register('pet.listGroupOptions', async () => {
      const groups = Array.isArray(sessionOrgState?.groups) ? sessionOrgState.groups : [];
      return groups.map((g) => ({ id: g.id, label: g.name || g.id }));
    })
  );

  try {
    const trayHandle = await host.tray?.registerMenuItem?.({
      id: 'pet-toggle',
      label: '桌面伴侣宠物',
      type: 'checkbox',
      checked: normalizeSettings(host.settings?.get?.() || {}).desktopVisible,
      position: 'plugins',
      onClick: async (tCtx) => {
        const cur = normalizeSettings(host.settings?.get?.() || {});
        const next = !cur.desktopVisible;
        await host.settings.update({ desktopVisible: next });
        await tCtx.update({ checked: next });
      }
    });
    if (trayHandle) disposers.push(() => trayHandle.dispose());
  } catch {}

  pollTimer = setInterval(() => { void pollTrajectories(); }, 2000);
  if (typeof pollTimer.unref === 'function') pollTimer.unref();
  tailTimer = setInterval(() => { void pollTailSteps(); }, 500);
  if (typeof tailTimer.unref === 'function') tailTimer.unref();
  disposers.push(
    () => { if (pollTimer) clearInterval(pollTimer); pollTimer = null; },
    () => { if (tailTimer) clearInterval(tailTimer); tailTimer = null; }
  );

  await syncOutputs(true);
}

async function deactivate() {
  for (const fn of disposers.splice(0).reverse()) {
    try {
      if (typeof fn === 'function') await fn();
    } catch {}
  }
  const host = activeHost;
  activeHost = null;
  try {
    await host?.overlay?.disposeAll?.();
    host?.state?.set?.('state:pet.state@1', null);
    host?.state?.set?.('state:session.active@1', null);
  } catch {}
}

module.exports = {
  activate,
  deactivate,
  normalizeSettings
};
