'use strict';

const { HOST_TOGGLE_CSS, SHADOW_CSS } = require('./styles');
const zhCN = require('../locales/zh-CN.json');
const enUS = require('../locales/en.json');

const DEFAULT_ANCHOR_TIMEOUT_MS = 3000;
const HOVER_EXPAND_MS = 600;
const HEALTH_STATE_KEY = 'state:sidebar.health@1';
const TOPBAR_UNIT_ID = 'sidebar-toggle';

let activeInstance = null;

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function formatText(template, vars = {}) {
  let out = String(template || '');
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v ?? ''));
  }
  return out;
}

function pickLocaleBundle(doc) {
  const lang = String(
    doc?.documentElement?.getAttribute?.('lang')
    || globalThis.navigator?.language
    || 'zh-CN'
  ).toLowerCase();
  return lang.startsWith('en') ? enUS : zhCN;
}

function sortByOrderIds(items, orderIds = [], getId = (x) => x.id) {
  const idxMap = new Map((Array.isArray(orderIds) ? orderIds : []).map((id, i) => [id, i]));
  return [...items].sort((a, b) => {
    const ia = idxMap.has(getId(a)) ? idxMap.get(getId(a)) : Number.MAX_SAFE_INTEGER;
    const ib = idxMap.has(getId(b)) ? idxMap.get(getId(b)) : Number.MAX_SAFE_INTEGER;
    if (ia !== ib) return ia - ib;
    return 0;
  });
}

function getWorktreeGroupRank(wt) {
  if (wt.isMain && !wt.bare) return 0;
  if (wt.status === 'missing' || wt.prunable) return 3;
  if (wt.bare) return 4;
  return 2;
}

function sortWorktreesForView(worktrees = [], sessions = []) {
  const activeWtIds = new Set();
  for (const s of sessions) {
    if (s?.worktreeId && (s.isRunning || s.needsAttention)) {
      activeWtIds.add(s.worktreeId);
    }
  }
  return [...worktrees].sort((a, b) => {
    const ra = (!a.isMain && a.status !== 'missing' && !a.bare && activeWtIds.has(a.worktreeId)) ? 1 : getWorktreeGroupRank(a);
    const rb = (!b.isMain && b.status !== 'missing' && !b.bare && activeWtIds.has(b.worktreeId)) ? 1 : getWorktreeGroupRank(b);
    if (ra !== rb) return ra - rb;
    return String(a.displayLabel || a.path || '').localeCompare(String(b.displayLabel || b.path || ''));
  });
}

function reorderArray(arr, fromId, targetId, position = 'before') {
  const list = Array.isArray(arr) ? arr.filter((x) => x !== fromId) : [];
  if (!targetId) {
    list.push(fromId);
    return list;
  }
  const idx = list.indexOf(targetId);
  if (idx < 0) {
    list.push(fromId);
    return list;
  }
  const insertAt = position === 'after' ? idx + 1 : idx;
  list.splice(insertAt, 0, fromId);
  return list;
}

async function mount(ctx) {
  dispose();

  const doc = globalThis.document;
  const win = globalThis.window || null;
  const locale = pickLocaleBundle(doc);
  const t = (key, vars) => formatText(locale[key] || zhCN[key] || key, vars);
  const anchorTimeoutMs = Number.isFinite(Number(ctx?._anchorTimeoutMs))
    ? Math.max(10, Number(ctx._anchorTimeoutMs))
    : DEFAULT_ANCHOR_TIMEOUT_MS;

  let disposed = false;
  let sidebarRootEl = null;
  let hostContainerEl = null;
  let shadowRoot = null;
  let shellEl = null;

  let settings = {
    viewMode: ctx?.settings?.get?.()?.viewMode === 'native' ? 'native' : 'enhanced',
    autoExpandActiveWorktree: ctx?.settings?.get?.()?.autoExpandActiveWorktree !== false,
    showWorktreePathHint: ctx?.settings?.get?.()?.showWorktreePathHint !== false
  };

  let healthStatus = 'probing'; // 'probing' | 'ok' | 'degraded'
  let healthReason = null;
  let orgState = {
    version: 2,
    revision: 0,
    groups: [],
    projects: [],
    sessions: [],
    collapsedNodes: { projects: {}, worktrees: {} },
    pins: { sessions: [], projects: [], groups: [] },
    groupOrder: { pinned: [], normal: [] },
    projectOrder: {},
    sessionOrder: {},
    worktreeTombstones: {},
    pcWebUrl: null,
    hostWindowWorkspace: null
  };

  let searchQuery = '';
  let showArchived = false;
  let openMenuKey = null;
  let inlineDialog = null; // { kind, ... }
  let guidanceBanner = null; // { cascadeId, worktreePath, windowPath, pcWebUrl }
  let toastBanner = null; // { tone, text }
  let showShortcutBadges = false;
  let activeSessionId = ctx?.hostDom?.getSessionId?.() || null;

  let isDragging = false;
  let dragState = null; // { targetType, id, containerId, zone, groupId }
  let pendingOrgSnapshot = null;
  let hoverExpandTimer = null;
  let hoverExpandTarget = null;
  let anchorTimer = null;

  // Map<nodeKey, { collapsed: boolean, baseRevision: number }>
  const optimisticCollapse = new Map();
  // Temporary expansion during search or 600ms drag hover (never written to disk)
  const transientExpandedIds = new Set();

  const disposers = [];

  function setHealth(status, reason = null) {
    healthStatus = status;
    healthReason = reason;
    const payload = {
      status,
      reason,
      fallback: status === 'degraded' ? 'native' : null,
      viewMode: settings.viewMode,
      updatedAt: new Date().toISOString()
    };
    try {
      void Promise.resolve(ctx?.state?.set?.(HEALTH_STATE_KEY, payload)).catch(() => {});
    } catch {}
    if (reason !== 'BRIDGE_UNAVAILABLE') {
      try {
        void Promise.resolve(ctx?.bridge?.post?.('/health', payload)).catch(() => {});
      } catch {}
    }
    syncTopbarUnit();
  }

  function syncTopbarUnit() {
    if (!ctx?.topbar?.updateUnit) return;
    const degraded = healthStatus === 'degraded';
    const isEnhanced = settings.viewMode === 'enhanced' && !degraded;
    const label = degraded
      ? t('topbar.degraded')
      : (isEnhanced ? t('topbar.enhanced') : t('topbar.native'));
    try {
      void Promise.resolve(ctx.topbar.updateUnit(TOPBAR_UNIT_ID, {
        label,
        tone: degraded ? 'warn' : (isEnhanced ? 'accent' : null),
        badge: degraded ? t('mode.native') : (isEnhanced ? t('mode.enhanced') : t('mode.native')),
        title: t('topbar.title')
      })).catch(() => {});
    } catch {}
  }

  function applyVisibilityMode() {
    const degraded = healthStatus === 'degraded';
    const showEnhanced = Boolean(sidebarRootEl && settings.viewMode === 'enhanced' && !degraded);
    if (sidebarRootEl) {
      if (showEnhanced) {
        sidebarRootEl.setAttribute?.('data-agy-sidebar-mode', 'enhanced');
      } else {
        sidebarRootEl.removeAttribute?.('data-agy-sidebar-mode');
      }
    }
    if (hostContainerEl) {
      hostContainerEl.hidden = !showEnhanced;
      if (hostContainerEl.style?.setProperty) {
        hostContainerEl.style.setProperty('display', showEnhanced ? 'flex' : 'none');
      }
    }
    syncTopbarUnit();
  }

  async function setViewMode(nextMode) {
    const cleanMode = nextMode === 'native' ? 'native' : 'enhanced';
    settings.viewMode = cleanMode;
    applyVisibilityMode();
    try {
      await ctx?.settings?.update?.({ viewMode: cleanMode });
    } catch {}
    try {
      await ctx?.events?.emit?.('sidebar:view-mode-changed@1', { viewMode: cleanMode });
    } catch {}
    render();
    return cleanMode;
  }

  function toggleViewMode() {
    return setViewMode(settings.viewMode === 'enhanced' ? 'native' : 'enhanced');
  }

  function getPersistedCollapsed(nodeType, id) {
    const optKey = `${nodeType}:${id}`;
    if (optimisticCollapse.has(optKey)) {
      const entry = optimisticCollapse.get(optKey);
      if (orgState.revision <= entry.baseRevision) {
        return entry.collapsed;
      }
      optimisticCollapse.delete(optKey);
    }
    if (nodeType === 'group') {
      const g = orgState.groups.find((x) => x.id === id);
      return Boolean(g?.collapsed);
    }
    if (nodeType === 'project') {
      return Boolean(orgState.collapsedNodes?.projects?.[id]);
    }
    if (nodeType === 'worktree') {
      return Boolean(orgState.collapsedNodes?.worktrees?.[id]);
    }
    return false;
  }

  function isNodeExpanded(nodeType, id) {
    const key = `${nodeType}:${id}`;
    if (transientExpandedIds.has(key)) return true;
    return !getPersistedCollapsed(nodeType, id);
  }

  function applyBootstrapPayload(data) {
    if (!data || data.ok === false) return;
    if (isDragging) {
      pendingOrgSnapshot = data;
      return;
    }
    const nextRev = Number(data.revision || 0);
    for (const [k, entry] of Array.from(optimisticCollapse.entries())) {
      if (nextRev > entry.baseRevision) {
        optimisticCollapse.delete(k);
      }
    }
    orgState = {
      ...orgState,
      ...data,
      groups: Array.isArray(data.groups) ? data.groups : [],
      projects: Array.isArray(data.projects) ? data.projects : [],
      sessions: Array.isArray(data.sessions) ? data.sessions : [],
      collapsedNodes: data.collapsedNodes || { projects: {}, worktrees: {} },
      pins: data.pins || { sessions: [], projects: [], groups: [] },
      groupOrder: data.groupOrder || { pinned: [], normal: [] },
      projectOrder: data.projectOrder || {},
      sessionOrder: data.sessionOrder || {},
      worktreeTombstones: data.worktreeTombstones || {}
    };
    if (healthStatus === 'degraded' && healthReason === 'BRIDGE_UNAVAILABLE' && sidebarRootEl) {
      setHealth('ok', null);
      applyVisibilityMode();
    }
    render();
  }

  async function refreshBootstrap(opts = {}) {
    if (disposed) return null;
    try {
      const res = await ctx.bridge.post('/bootstrap', {
        includeArchived: showArchived,
        refreshWorktrees: Boolean(opts.refreshWorktrees),
        ...(opts.hostWindowWorkspace ? { hostWindowWorkspace: opts.hostWindowWorkspace } : {})
      });
      if (!res || res.ok === false) {
        setHealth('degraded', 'BRIDGE_UNAVAILABLE');
        applyVisibilityMode();
        return res;
      }
      if (sidebarRootEl && healthStatus !== 'ok') {
        setHealth('ok', null);
        applyVisibilityMode();
      }
      applyBootstrapPayload(res);
      return res;
    } catch {
      setHealth('degraded', 'BRIDGE_UNAVAILABLE');
      applyVisibilityMode();
      return null;
    }
  }

  async function toggleCollapse(nodeType, id) {
    const curCollapsed = getPersistedCollapsed(nodeType, id);
    const nextCollapsed = !curCollapsed;
    const key = `${nodeType}:${id}`;
    if (nextCollapsed) {
      transientExpandedIds.delete(key);
    }
    optimisticCollapse.set(key, {
      collapsed: nextCollapsed,
      baseRevision: orgState.revision
    });
    render();
    try {
      const res = await ctx.bridge.post('/org/collapse', {
        nodeType,
        id,
        collapsed: nextCollapsed
      });
      if (res?.ok) {
        await refreshBootstrap();
      } else {
        optimisticCollapse.delete(key);
        render();
      }
    } catch {
      optimisticCollapse.delete(key);
      render();
    }
  }

  async function createGroup(name) {
    const clean = String(name || '').trim();
    if (!clean || clean.length > 64) return { ok: false, error: 'INVALID_GROUP_NAME' };
    const res = await ctx.bridge.post('/org/group', { action: 'upsert', name: clean });
    if (res?.ok) {
      inlineDialog = null;
      await refreshBootstrap();
    } else {
      toastBanner = { tone: 'error', text: res?.error || 'CREATE_GROUP_FAILED' };
      render();
    }
    return res;
  }

  async function renameGroup(groupId, name) {
    const clean = String(name || '').trim();
    if (!clean || clean.length > 64) return { ok: false, error: 'INVALID_GROUP_NAME' };
    const res = await ctx.bridge.post('/org/group', { action: 'upsert', id: groupId, name: clean });
    if (res?.ok) {
      inlineDialog = null;
      await refreshBootstrap();
    } else {
      toastBanner = { tone: 'error', text: res?.error || 'RENAME_GROUP_FAILED' };
      render();
    }
    return res;
  }

  async function requestDeleteGroup(group, memberProjects = []) {
    openMenuKey = null;
    if (memberProjects.length === 0) {
      const res = await ctx.bridge.post('/org/group', { action: 'delete', id: group.id });
      if (res?.ok) await refreshBootstrap();
      return res;
    }
    inlineDialog = {
      kind: 'delete-group',
      groupId: group.id,
      groupName: group.name,
      projectCount: memberProjects.length
    };
    render();
    return { pendingConfirmation: true };
  }

  async function confirmDeleteGroup(groupId) {
    const res = await ctx.bridge.post('/org/group', { action: 'delete', id: groupId });
    inlineDialog = null;
    if (res?.ok) {
      await refreshBootstrap();
    } else {
      toastBanner = { tone: 'error', text: res?.error || 'DELETE_GROUP_FAILED' };
      render();
    }
    return res;
  }

  async function moveProjectToGroup(project, toGroupId) {
    openMenuKey = null;
    const targetGid = toGroupId && toGroupId !== '__ungrouped__' ? toGroupId : null;
    const res = await ctx.bridge.post('/org/group', {
      action: 'assign',
      projectId: project.id,
      groupId: targetGid,
      rootPath: project.rootPath || undefined,
      workspaceUri: project.uri || undefined
    });
    if (res?.ok) {
      await refreshBootstrap();
    }
    return res;
  }

  async function createSessionInTarget({ projectId = null, worktreePath = '', workspaceUri = '', title = '' } = {}) {
    const res = await ctx.bridge.post('/session/create', {
      ...(projectId ? { projectId } : {}),
      ...(worktreePath ? { worktreePath } : {}),
      ...(workspaceUri ? { workspaceUri } : {}),
      ...(title ? { title } : {})
    });
    if (!res || res.ok === false) {
      toastBanner = {
        tone: 'error',
        text: res?.error === 'WORKTREE_PATH_MISSING' ? t('error.worktreeMissing') : (res?.error || 'CREATE_SESSION_FAILED')
      };
      render();
      return res;
    }
    activeSessionId = res.cascadeId;
    await refreshBootstrap();
    return res;
  }

  async function activateSessionRow(session) {
    activeSessionId = session.cascadeId;
    const rows = ctx?.hostDom?.getSidebarRows?.() || [];
    const matchedRow = rows.find((row) => {
      const cidAttr = row.getAttribute?.('data-cascade-id') || row.getAttribute?.('data-session-id') || '';
      if (cidAttr && cidAttr === session.cascadeId) return true;
      const href = row.getAttribute?.('href') || '';
      if (href && href.includes(session.cascadeId)) return true;
      const txt = String(row.textContent || '').trim();
      const sTitle = String(session.title || session.summary || '').trim();
      return Boolean(sTitle && txt === sTitle);
    }) || null;

    const sessionWs = session.worktreePath || session.workspaceUri || '';
    const windowWs = orgState.hostWindowWorkspace || '';
    const isCrossWorkspace = Boolean(
      sessionWs && windowWs && sessionWs.toLowerCase() !== windowWs.toLowerCase()
    );

    if (matchedRow && !isCrossWorkspace) {
      guidanceBanner = null;
      matchedRow.click?.();
      render();
      return { ok: true, mode: 'native-click' };
    }

    if (sessionWs && (isCrossWorkspace || !matchedRow)) {
      guidanceBanner = {
        cascadeId: session.cascadeId,
        worktreePath: session.worktreePath || sessionWs,
        windowPath: windowWs || '-',
        pcWebUrl: orgState.pcWebUrl || null
      };
    } else {
      guidanceBanner = null;
    }
    render();
    return { ok: true, mode: 'guidance', crossWorkspace: Boolean(guidanceBanner) };
  }

  function clearHoverExpand() {
    if (hoverExpandTimer) {
      clearTimeout(hoverExpandTimer);
      hoverExpandTimer = null;
    }
    hoverExpandTarget = null;
  }

  function scheduleHoverExpand(nodeType, id) {
    const key = `${nodeType}:${id}`;
    if (isNodeExpanded(nodeType, id)) {
      clearHoverExpand();
      return;
    }
    if (hoverExpandTarget === key) return;
    clearHoverExpand();
    hoverExpandTarget = key;
    hoverExpandTimer = setTimeout(() => {
      hoverExpandTimer = null;
      hoverExpandTarget = null;
      if (disposed || !isDragging) return;
      transientExpandedIds.add(key);
      render();
    }, HOVER_EXPAND_MS);
  }

  function startDrag(descriptor) {
    isDragging = true;
    dragState = { ...descriptor };
    render();
  }

  function endDrag() {
    isDragging = false;
    dragState = null;
    clearHoverExpand();
    if (pendingOrgSnapshot) {
      const snap = pendingOrgSnapshot;
      pendingOrgSnapshot = null;
      applyBootstrapPayload(snap);
    } else {
      render();
    }
  }

  async function handleDropTarget(dropTarget) {
    const src = dragState;
    isDragging = false;
    dragState = null;
    clearHoverExpand();

    if (!src || !dropTarget) {
      endDrag();
      return { ok: false, error: 'NO_DRAG_STATE' };
    }

    // 1. Session drop validation: forbid cross-project / cross-worktree moves and cross-zone moves
    if (src.targetType === 'session') {
      if (src.containerId !== dropTarget.containerId) {
        toastBanner = { tone: 'error', text: t('error.crossContainer') };
        render();
        return { ok: false, statusCode: 409, error: 'CROSS_CONTAINER_SESSION_MOVE_FORBIDDEN' };
      }
      if (src.zone !== dropTarget.zone) {
        toastBanner = { tone: 'warn', text: t('error.zoneMismatch') };
        render();
        return { ok: false, statusCode: 409, error: 'ZONE_PIN_MISMATCH' };
      }
      const curOrder = getSessionIdsInContainer(src.containerId, src.zone);
      const nextOrder = reorderArray(curOrder, src.id, dropTarget.targetId, dropTarget.position || 'before');
      const res = await ctx.bridge.post('/org/reorder', {
        targetType: 'session',
        containerId: src.containerId,
        zone: src.zone,
        orderedIds: nextOrder,
        expectedRevision: orgState.revision
      });
      if (!res?.ok) {
        toastBanner = { tone: 'error', text: res?.error || 'REORDER_FAILED' };
        render();
      } else {
        await refreshBootstrap();
      }
      return res;
    }

    // 2. Group drop validation: strict zone-only reordering
    if (src.targetType === 'group') {
      if (dropTarget.targetType !== 'group') {
        render();
        return { ok: false, error: 'INVALID_DROP_TARGET' };
      }
      if (src.zone !== dropTarget.zone) {
        toastBanner = { tone: 'warn', text: t('error.zoneMismatch') };
        render();
        return { ok: false, statusCode: 409, error: 'ZONE_PIN_MISMATCH' };
      }
      const curOrder = getGroupIdsInZone(src.zone);
      const nextOrder = reorderArray(curOrder, src.id, dropTarget.targetId, dropTarget.position || 'before');
      const res = await ctx.bridge.post('/org/reorder', {
        targetType: 'group',
        containerId: '__groups__',
        zone: src.zone,
        orderedIds: nextOrder,
        expectedRevision: orgState.revision
      });
      if (res?.ok) await refreshBootstrap();
      else {
        toastBanner = { tone: 'error', text: res?.error || 'REORDER_FAILED' };
        render();
      }
      return res;
    }

    // 3. Project drop: same-zone reorder OR cross-group move (preserving pinned zone)
    if (src.targetType === 'project') {
      const toGroupId = dropTarget.toGroupId !== undefined ? dropTarget.toGroupId : dropTarget.containerId;
      if (dropTarget.zone && dropTarget.zone !== src.zone && dropTarget.targetType === 'project') {
        toastBanner = { tone: 'warn', text: t('error.zoneMismatch') };
        render();
        return { ok: false, statusCode: 409, error: 'ZONE_PIN_MISMATCH' };
      }
      const destContainer = toGroupId || '__ungrouped__';
      const curIds = getProjectIdsInContainer(destContainer, src.zone);
      const nextOrder = reorderArray(curIds, src.id, dropTarget.targetId, dropTarget.position || 'before');
      const moved = (src.groupId || '__ungrouped__') !== destContainer;
      const res = await ctx.bridge.post('/org/reorder', {
        targetType: 'project',
        containerId: destContainer,
        zone: src.zone,
        orderedIds: nextOrder,
        expectedRevision: orgState.revision,
        ...(moved
          ? {
              movedProject: {
                projectId: src.id,
                fromGroupId: src.groupId || null,
                toGroupId: destContainer === '__ungrouped__' ? null : destContainer
              }
            }
          : {})
      });
      if (res?.ok) await refreshBootstrap();
      else {
        toastBanner = { tone: 'error', text: res?.error || 'REORDER_FAILED' };
        render();
      }
      return res;
    }

    render();
    return { ok: false, error: 'UNSUPPORTED_DRAG_TYPE' };
  }

  function getGroupIdsInZone(zone) {
    const pinnedSet = new Set(orgState.pins?.groups || []);
    const matched = orgState.groups.filter((g) => pinnedSet.has(g.id) === (zone === 'pinned'));
    const ord = orgState.groupOrder?.[zone] || [];
    return sortByOrderIds(matched, ord, (g) => g.id).map((g) => g.id);
  }

  function getProjectIdsInContainer(containerId, zone) {
    const pinnedSet = new Set(orgState.pins?.projects || []);
    const gid = containerId === '__ungrouped__' ? null : containerId;
    const matched = orgState.projects.filter(
      (p) => (p.groupId || null) === gid && (pinnedSet.has(p.id) === (zone === 'pinned'))
    );
    const ord = orgState.projectOrder?.[containerId]?.[zone] || [];
    return sortByOrderIds(matched, ord, (p) => p.id).map((p) => p.id);
  }

  function getSessionIdsInContainer(containerId, zone) {
    const pinnedSet = new Set(orgState.pins?.sessions || []);
    if (containerId === '__pinned__') {
      const pinned = orgState.sessions.filter((s) => pinnedSet.has(s.cascadeId) && !s.archived);
      return sortByOrderIds(pinned, orgState.sessionOrder?.__pinned__ || [], (s) => s.cascadeId).map((s) => s.cascadeId);
    }
    const matched = orgState.sessions.filter((s) => {
      if (s.archived) return false;
      const inPinZone = pinnedSet.has(s.cascadeId) === (zone === 'pinned');
      if (!inPinZone) return false;
      if (containerId === '__standalone__') return !s.projectId;
      if (containerId.startsWith('wt_')) return s.worktreeId === containerId;
      return s.projectId === containerId;
    });
    const ord = orgState.sessionOrder?.[containerId]?.[zone] || [];
    return sortByOrderIds(matched, ord, (s) => s.cascadeId).map((s) => s.cascadeId);
  }

  function buildEl(tag, className, textContent) {
    const el = doc.createElement(tag);
    if (className) el.className = className;
    if (textContent !== undefined && textContent !== null) el.textContent = String(textContent);
    return el;
  }

  function renderSessionRow(session, containerId, indentClass, shortcutCounter) {
    const row = buildEl(doc ? 'div' : 'div', `agy-sb-row ${indentClass}`);
    row.setAttribute('data-node-type', 'session');
    row.setAttribute('data-session-id', session.cascadeId);
    row.setAttribute('data-container-id', containerId);
    row.setAttribute('data-active', session.cascadeId === activeSessionId ? 'true' : 'false');
    row.setAttribute('draggable', 'true');

    const zone = session.pinned ? 'pinned' : 'normal';
    const handle = buildEl('button', 'agy-sb-handle', '⋮⋮');
    handle.type = 'button';
    handle.setAttribute('aria-label', 'Reorder session');
    handle.addEventListener('click', (e) => { e?.stopPropagation?.(); });

    row.addEventListener('dragstart', () => {
      startDrag({ targetType: 'session', id: session.cascadeId, containerId, zone });
    });
    row.addEventListener('dragend', () => endDrag());
    row.addEventListener('dragover', (e) => {
      e?.preventDefault?.();
      if (dragState?.targetType === 'session') {
        row.setAttribute('data-drop-position', 'before');
      }
    });
    row.addEventListener('drop', (e) => {
      e?.preventDefault?.();
      row.removeAttribute('data-drop-position');
      void handleDropTarget({ targetType: 'session', targetId: session.cascadeId, containerId, zone, position: 'before' });
    });

    if (showShortcutBadges && shortcutCounter.count < 9) {
      shortcutCounter.count += 1;
      const badge = buildEl('span', 'agy-sidebar-shortcut-badge', String(shortcutCounter.count));
      badge.setAttribute('data-agy-sidebar-shortcut', String(shortcutCounter.count));
      row.appendChild(badge);
    }

    row.appendChild(handle);
    if (session.isRunning) {
      row.appendChild(buildEl('span', 'agy-sb-dot'));
    }

    const title = buildEl('span', 'agy-sb-label', session.title || session.summary || session.cascadeId);
    row.appendChild(title);

    const moreBtn = buildEl('button', 'agy-sb-icon-btn', '···');
    moreBtn.type = 'button';
    moreBtn.setAttribute('data-action', 'session-menu');
    moreBtn.addEventListener('click', (e) => {
      e?.stopPropagation?.();
      const mk = `session:${containerId}:${session.cascadeId}`;
      openMenuKey = openMenuKey === mk ? null : mk;
      render();
    });
    row.appendChild(moreBtn);

    row.addEventListener('click', () => {
      void activateSessionRow(session);
    });

    const wrap = buildEl('div', 'agy-sb-session-wrap');
    wrap.appendChild(row);

    if (openMenuKey === `session:${containerId}:${session.cascadeId}`) {
      const menu = buildEl('div', 'agy-sb-menu');
      const pinBtn = buildEl('button', 'agy-sb-menu-item', session.pinned ? t('action.unpin') : t('action.pin'));
      pinBtn.type = 'button';
      pinBtn.addEventListener('click', async () => {
        openMenuKey = null;
        await ctx.bridge.post('/org/pin', { type: 'session', id: session.cascadeId, pinned: !session.pinned });
        await refreshBootstrap();
      });
      const archBtn = buildEl('button', 'agy-sb-menu-item', session.archived ? t('action.unarchive') : t('action.archive'));
      archBtn.type = 'button';
      archBtn.addEventListener('click', async () => {
        openMenuKey = null;
        await ctx.bridge.post('/session/archive', {
          cascadeId: session.cascadeId,
          archived: !session.archived,
          stepCount: session.stepCount || 0,
          isRunning: Boolean(session.isRunning),
          projectId: session.projectId || null,
          titleSnapshot: session.title || session.summary || ''
        });
        await refreshBootstrap();
      });
      const delBtn = buildEl('button', 'agy-sb-menu-item', t('action.deleteSession'));
      delBtn.type = 'button';
      delBtn.addEventListener('click', async () => {
        openMenuKey = null;
        await ctx.bridge.post('/session/delete', { cascadeId: session.cascadeId });
        await refreshBootstrap();
      });
      menu.appendChild(pinBtn);
      menu.appendChild(archBtn);
      menu.appendChild(delBtn);
      wrap.appendChild(menu);
    }

    return wrap;
  }

  function renderSessionList(sessions, containerId, indentClass, shortcutCounter) {
    const pinnedSessions = sortByOrderIds(
      sessions.filter((s) => s.pinned),
      orgState.sessionOrder?.[containerId]?.pinned || [],
      (s) => s.cascadeId
    );
    const normalSessions = sortByOrderIds(
      sessions.filter((s) => !s.pinned),
      orgState.sessionOrder?.[containerId]?.normal || [],
      (s) => s.cascadeId
    );
    const frag = buildEl('div', 'agy-sb-session-list');
    for (const s of [...pinnedSessions, ...normalSessions]) {
      frag.appendChild(renderSessionRow(s, containerId, indentClass, shortcutCounter));
    }
    return frag;
  }

  function renderWorktreeSubgroup(proj, wt, wtSessions, shortcutCounter) {
    const wtWrap = buildEl('div', 'agy-sb-worktree-wrap');
    wtWrap.setAttribute('data-worktree-id', wt.worktreeId);
    const isExpanded = searchQuery
      ? true
      : isNodeExpanded('worktree', wt.worktreeId);
    const isMissing = wt.status === 'missing' || wt.prunable;
    const isBare = Boolean(wt.bare);

    const row = buildEl('div', 'agy-sb-row agy-sb-indent-2');
    row.setAttribute('data-node-type', 'worktree');
    row.setAttribute('data-worktree-id', wt.worktreeId);
    row.setAttribute('data-worktree-status', wt.status || 'ready');

    row.appendChild(buildEl('span', 'agy-sb-caret', isExpanded ? '▾' : '▸'));
    row.appendChild(buildEl('span', 'agy-sb-label', wt.displayLabel || wt.branch || wt.path));

    if (wt.isMain && !wt.bare) {
      row.appendChild(buildEl('span', 'agy-sb-badge', t('wt.mainBadge')));
    }
    if (wt.locked) {
      const lockBadge = buildEl('span', 'agy-sb-badge', t('wt.lockedBadge'));
      lockBadge.setAttribute('data-tone', 'warn');
      row.appendChild(lockBadge);
    }
    if (isMissing) {
      const missBadge = buildEl('span', 'agy-sb-badge', t('wt.missingBadge'));
      missBadge.setAttribute('data-tone', 'danger');
      row.appendChild(missBadge);
    } else if (isBare) {
      row.appendChild(buildEl('span', 'agy-sb-badge', t('wt.bareBadge')));
    }
    if (settings.showWorktreePathHint && wt.displaySubpath) {
      row.appendChild(buildEl('span', 'agy-sb-subpath', wt.displaySubpath));
    }
    row.appendChild(buildEl('span', 'agy-sb-count', String(wtSessions.length)));

    if (!isBare) {
      const addBtn = buildEl('button', 'agy-sb-icon-btn', '+');
      addBtn.type = 'button';
      addBtn.disabled = isMissing;
      addBtn.setAttribute('data-action', 'new-worktree-session');
      addBtn.setAttribute('title', isMissing ? t('error.worktreeMissing') : t('action.newSession'));
      addBtn.addEventListener('click', (e) => {
        e?.stopPropagation?.();
        if (!isMissing) {
          void createSessionInTarget({ projectId: proj.id, worktreePath: wt.path });
        }
      });
      row.appendChild(addBtn);
    }

    const menuBtn = buildEl('button', 'agy-sb-icon-btn', '···');
    menuBtn.type = 'button';
    menuBtn.setAttribute('data-action', 'worktree-menu');
    menuBtn.addEventListener('click', (e) => {
      e?.stopPropagation?.();
      const mk = `wt:${wt.worktreeId}`;
      openMenuKey = openMenuKey === mk ? null : mk;
      render();
    });
    row.appendChild(menuBtn);

    row.addEventListener('click', () => {
      void toggleCollapse('worktree', wt.worktreeId);
    });
    wtWrap.appendChild(row);

    if (openMenuKey === `wt:${wt.worktreeId}`) {
      const menu = buildEl('div', 'agy-sb-menu');
      if (!isBare && !isMissing) {
        const newSes = buildEl('button', 'agy-sb-menu-item', t('action.newSession'));
        newSes.type = 'button';
        newSes.addEventListener('click', () => {
          openMenuKey = null;
          void createSessionInTarget({ projectId: proj.id, worktreePath: wt.path });
        });
        menu.appendChild(newSes);
      }
      if (!wt.isMain && !isBare) {
        const hasRunning = wtSessions.some((s) => s.isRunning);
        const rmBtn = buildEl('button', 'agy-sb-menu-item', t('action.removeWorktree'));
        rmBtn.type = 'button';
        rmBtn.disabled = Boolean(wt.locked || hasRunning);
        rmBtn.addEventListener('click', () => {
          openMenuKey = null;
          inlineDialog = {
            kind: 'remove-worktree',
            repoRoot: proj.repoRootPath || proj.rootPath,
            path: wt.path,
            label: wt.displayLabel || wt.path
          };
          render();
        });
        menu.appendChild(rmBtn);
      }
      if (isMissing) {
        const pruneBtn = buildEl('button', 'agy-sb-menu-item', t('action.pruneWorktrees'));
        pruneBtn.type = 'button';
        pruneBtn.addEventListener('click', async () => {
          openMenuKey = null;
          await ctx.bridge.post('/worktree/mutate', {
            root: proj.repoRootPath || proj.rootPath,
            action: 'prune'
          });
          await refreshBootstrap({ refreshWorktrees: true });
        });
        menu.appendChild(pruneBtn);
      }
      wtWrap.appendChild(menu);
    }

    if (isExpanded) {
      wtWrap.appendChild(renderSessionList(wtSessions, wt.worktreeId, 'agy-sb-indent-3', shortcutCounter));
    }
    return wtWrap;
  }

  function renderProjectNode(proj, projSessions, shortcutCounter) {
    const pWrap = buildEl('div', 'agy-sb-project-wrap');
    pWrap.setAttribute('data-project-id', proj.id);
    pWrap.setAttribute('data-multi-worktree', proj.isMultiWorktree ? 'true' : 'false');

    const isExpanded = searchQuery
      ? true
      : isNodeExpanded('project', proj.id);

    const row = buildEl('div', 'agy-sb-row agy-sb-indent-1');
    row.setAttribute('data-node-type', 'project');
    row.setAttribute('data-project-id', proj.id);
    row.setAttribute('draggable', 'true');

    const handle = buildEl('button', 'agy-sb-handle', '⋮⋮');
    handle.type = 'button';
    handle.addEventListener('click', (e) => { e?.stopPropagation?.(); });
    row.addEventListener('dragstart', () => {
      startDrag({
        targetType: 'project',
        id: proj.id,
        groupId: proj.groupId || null,
        containerId: proj.groupId || '__ungrouped__',
        zone: proj.pinned ? 'pinned' : 'normal'
      });
    });
    row.addEventListener('dragend', () => endDrag());
    row.addEventListener('dragover', (e) => {
      e?.preventDefault?.();
      if (dragState?.targetType === 'project') {
        row.setAttribute('data-drop-position', 'before');
      } else if (dragState?.targetType === 'session') {
        scheduleHoverExpand('project', proj.id);
      }
    });
    row.addEventListener('drop', (e) => {
      e?.preventDefault?.();
      row.removeAttribute('data-drop-position');
      if (dragState?.targetType === 'project') {
        void handleDropTarget({
          targetType: 'project',
          targetId: proj.id,
          toGroupId: proj.groupId || null,
          containerId: proj.groupId || '__ungrouped__',
          zone: proj.pinned ? 'pinned' : 'normal',
          position: 'before'
        });
      }
    });

    row.appendChild(handle);
    row.appendChild(buildEl('span', 'agy-sb-caret', isExpanded ? '▾' : '▸'));
    row.appendChild(buildEl('span', 'agy-sb-label', proj.name || proj.rootPath || proj.id));

    if (proj.isMultiWorktree && Array.isArray(proj.worktrees)) {
      row.appendChild(buildEl('span', 'agy-sb-badge', `${proj.worktrees.length} wt`));
    }
    row.appendChild(buildEl('span', 'agy-sb-count', String(projSessions.length)));

    const addBtn = buildEl('button', 'agy-sb-icon-btn', '+');
    addBtn.type = 'button';
    addBtn.setAttribute('data-action', 'new-project-session');
    addBtn.addEventListener('click', (e) => {
      e?.stopPropagation?.();
      const firstReadyWt = Array.isArray(proj.worktrees)
        ? proj.worktrees.find((w) => w.isMain && !w.bare && w.status !== 'missing')
          || proj.worktrees.find((w) => !w.bare && w.status !== 'missing')
        : null;
      void createSessionInTarget({
        projectId: proj.id,
        worktreePath: firstReadyWt?.path || proj.rootPath || '',
        workspaceUri: firstReadyWt?.uri || proj.uri || ''
      });
    });
    row.appendChild(addBtn);

    const menuBtn = buildEl('button', 'agy-sb-icon-btn', '···');
    menuBtn.type = 'button';
    menuBtn.setAttribute('data-action', 'project-menu');
    menuBtn.addEventListener('click', (e) => {
      e?.stopPropagation?.();
      const mk = `proj:${proj.id}`;
      openMenuKey = openMenuKey === mk ? null : mk;
      render();
    });
    row.appendChild(menuBtn);

    row.addEventListener('click', () => {
      void toggleCollapse('project', proj.id);
    });
    pWrap.appendChild(row);

    if (openMenuKey === `proj:${proj.id}`) {
      const menu = buildEl('div', 'agy-sb-menu');
      const pinBtn = buildEl('button', 'agy-sb-menu-item', proj.pinned ? t('action.unpin') : t('action.pin'));
      pinBtn.type = 'button';
      pinBtn.addEventListener('click', async () => {
        openMenuKey = null;
        await ctx.bridge.post('/org/pin', {
          type: 'project',
          id: proj.id,
          pinned: !proj.pinned,
          rootPath: proj.rootPath,
          projectName: proj.name
        });
        await refreshBootstrap();
      });
      menu.appendChild(pinBtn);

      if (proj.rootPath) {
        const newWtBtn = buildEl('button', 'agy-sb-menu-item', t('action.newWorktree'));
        newWtBtn.type = 'button';
        newWtBtn.addEventListener('click', () => {
          openMenuKey = null;
          inlineDialog = {
            kind: 'new-worktree',
            repoRoot: proj.repoRootPath || proj.rootPath,
            projectName: proj.name
          };
          render();
        });
        menu.appendChild(newWtBtn);
      }

      const moveHeader = buildEl('div', 'agy-sb-section-title', t('action.moveToGroup'));
      menu.appendChild(moveHeader);
      const ungroupedOpt = buildEl('button', 'agy-sb-menu-item', `${!proj.groupId ? '✓ ' : ''}${t('section.ungrouped')}`);
      ungroupedOpt.type = 'button';
      ungroupedOpt.addEventListener('click', () => void moveProjectToGroup(proj, null));
      menu.appendChild(ungroupedOpt);
      for (const g of orgState.groups) {
        const opt = buildEl('button', 'agy-sb-menu-item', `${proj.groupId === g.id ? '✓ ' : ''}${g.name}`);
        opt.type = 'button';
        opt.addEventListener('click', () => void moveProjectToGroup(proj, g.id));
        menu.appendChild(opt);
      }

      pWrap.appendChild(menu);
    }

    if (isExpanded) {
      if (proj.isMultiWorktree && Array.isArray(proj.worktrees) && proj.worktrees.length > 0) {
        const orderedWts = sortWorktreesForView(proj.worktrees, projSessions);
        for (const wt of orderedWts) {
          const wtSessions = projSessions.filter((s) => s.worktreeId === wt.worktreeId);
          pWrap.appendChild(renderWorktreeSubgroup(proj, wt, wtSessions, shortcutCounter));
        }
      } else {
        // Single-repo or plain directory: strictly 2-level flat structure (zero redundant worktree subgroup)
        pWrap.appendChild(renderSessionList(projSessions, proj.id, 'agy-sb-indent-2', shortcutCounter));
      }
    }
    return pWrap;
  }

  function renderGroupNode(group, allProjects, sessionsByProj, shortcutCounter) {
    const gWrap = buildEl('div', 'agy-sb-group-wrap');
    gWrap.setAttribute('data-group-id', group.id);
    const isExpanded = searchQuery ? true : isNodeExpanded('group', group.id);

    const groupProjects = allProjects.filter((p) => p.groupId === group.id);
    const pinnedProjects = sortByOrderIds(
      groupProjects.filter((p) => p.pinned),
      orgState.projectOrder?.[group.id]?.pinned || [],
      (p) => p.id
    );
    const normalProjects = sortByOrderIds(
      groupProjects.filter((p) => !p.pinned),
      orgState.projectOrder?.[group.id]?.normal || [],
      (p) => p.id
    );

    const row = buildEl('div', 'agy-sb-row');
    row.setAttribute('data-node-type', 'group');
    row.setAttribute('data-group-id', group.id);
    row.setAttribute('draggable', 'true');

    const handle = buildEl('button', 'agy-sb-handle', '⋮⋮');
    handle.type = 'button';
    handle.addEventListener('click', (e) => { e?.stopPropagation?.(); });
    row.addEventListener('dragstart', () => {
      startDrag({ targetType: 'group', id: group.id, zone: group.pinned ? 'pinned' : 'normal' });
    });
    row.addEventListener('dragend', () => endDrag());
    row.addEventListener('dragover', (e) => {
      e?.preventDefault?.();
      if (dragState?.targetType === 'project') {
        row.setAttribute('data-drop-position', 'inside');
        scheduleHoverExpand('group', group.id);
      } else if (dragState?.targetType === 'group') {
        row.setAttribute('data-drop-position', 'before');
      }
    });
    row.addEventListener('dragleave', () => {
      row.removeAttribute('data-drop-position');
    });
    row.addEventListener('drop', (e) => {
      e?.preventDefault?.();
      row.removeAttribute('data-drop-position');
      if (dragState?.targetType === 'project') {
        void handleDropTarget({
          targetType: 'project',
          toGroupId: group.id,
          containerId: group.id,
          position: 'before'
        });
      } else if (dragState?.targetType === 'group') {
        void handleDropTarget({
          targetType: 'group',
          targetId: group.id,
          zone: group.pinned ? 'pinned' : 'normal',
          position: 'before'
        });
      }
    });

    row.appendChild(handle);
    row.appendChild(buildEl('span', 'agy-sb-caret', isExpanded ? '▾' : '▸'));
    row.appendChild(buildEl('span', 'agy-sb-label', group.name));
    row.appendChild(buildEl('span', 'agy-sb-count', String(groupProjects.length)));

    const menuBtn = buildEl('button', 'agy-sb-icon-btn', '···');
    menuBtn.type = 'button';
    menuBtn.setAttribute('data-action', 'group-menu');
    menuBtn.addEventListener('click', (e) => {
      e?.stopPropagation?.();
      const mk = `group:${group.id}`;
      openMenuKey = openMenuKey === mk ? null : mk;
      render();
    });
    row.appendChild(menuBtn);

    row.addEventListener('click', () => {
      void toggleCollapse('group', group.id);
    });
    gWrap.appendChild(row);

    if (openMenuKey === `group:${group.id}`) {
      const menu = buildEl('div', 'agy-sb-menu');
      const pinBtn = buildEl('button', 'agy-sb-menu-item', group.pinned ? t('action.unpin') : t('action.pin'));
      pinBtn.type = 'button';
      pinBtn.addEventListener('click', async () => {
        openMenuKey = null;
        await ctx.bridge.post('/org/pin', { type: 'group', id: group.id, pinned: !group.pinned });
        await refreshBootstrap();
      });
      const renBtn = buildEl('button', 'agy-sb-menu-item', t('action.rename'));
      renBtn.type = 'button';
      renBtn.addEventListener('click', () => {
        openMenuKey = null;
        inlineDialog = { kind: 'rename-group', groupId: group.id, currentName: group.name };
        render();
      });
      const delBtn = buildEl('button', 'agy-sb-menu-item', t('action.delete'));
      delBtn.type = 'button';
      delBtn.addEventListener('click', () => {
        void requestDeleteGroup(group, groupProjects);
      });
      menu.appendChild(pinBtn);
      menu.appendChild(renBtn);
      menu.appendChild(delBtn);
      gWrap.appendChild(menu);
    }

    if (isExpanded) {
      if (pinnedProjects.length === 0 && normalProjects.length === 0) {
        const emptySlot = buildEl('div', 'agy-sb-drop-slot', t('drop.emptyGroupHint'));
        emptySlot.setAttribute('data-slot', 'empty-group');
        emptySlot.setAttribute('data-group-id', group.id);
        emptySlot.addEventListener('dragover', (e) => e?.preventDefault?.());
        emptySlot.addEventListener('drop', (e) => {
          e?.preventDefault?.();
          if (dragState?.targetType === 'project') {
            void handleDropTarget({ targetType: 'project', toGroupId: group.id, containerId: group.id });
          }
        });
        gWrap.appendChild(emptySlot);
      } else {
        for (const p of [...pinnedProjects, ...normalProjects]) {
          gWrap.appendChild(renderProjectNode(p, sessionsByProj.get(p.id) || [], shortcutCounter));
        }
      }
    }

    return gWrap;
  }

  function renderInlineDialog() {
    if (!inlineDialog) return null;
    const box = buildEl('div', 'agy-sb-banner');
    box.setAttribute('data-dialog', inlineDialog.kind);

    if (inlineDialog.kind === 'delete-group') {
      box.setAttribute('data-tone', 'warn');
      box.appendChild(buildEl('div', '', t('confirm.deleteNonEmptyGroup', {
        name: inlineDialog.groupName,
        count: inlineDialog.projectCount
      })));
      const actions = buildEl('div', 'agy-sb-banner-actions');
      const okBtn = buildEl('button', 'agy-sb-btn agy-sb-btn-danger', t('action.confirm'));
      okBtn.type = 'button';
      okBtn.setAttribute('data-action', 'confirm-delete-group');
      okBtn.addEventListener('click', () => void confirmDeleteGroup(inlineDialog.groupId));
      const cancelBtn = buildEl('button', 'agy-sb-btn', t('action.cancel'));
      cancelBtn.type = 'button';
      cancelBtn.addEventListener('click', () => { inlineDialog = null; render(); });
      actions.appendChild(okBtn);
      actions.appendChild(cancelBtn);
      box.appendChild(actions);
      return box;
    }

    if (inlineDialog.kind === 'new-group' || inlineDialog.kind === 'rename-group') {
      const input = buildEl('input', 'agy-sb-search');
      input.type = 'text';
      input.value = inlineDialog.currentName || '';
      input.placeholder = inlineDialog.kind === 'new-group' ? t('action.newGroup') : t('action.rename');
      const commit = () => {
        if (inlineDialog.kind === 'new-group') void createGroup(input.value);
        else void renameGroup(inlineDialog.groupId, input.value);
      };
      input.addEventListener('keydown', (e) => {
        if (e?.key === 'Enter') commit();
        if (e?.key === 'Escape') { inlineDialog = null; render(); }
      });
      box.appendChild(input);
      const actions = buildEl('div', 'agy-sb-banner-actions');
      const okBtn = buildEl('button', 'agy-sb-btn', t('action.confirm'));
      okBtn.type = 'button';
      okBtn.addEventListener('click', commit);
      const cancelBtn = buildEl('button', 'agy-sb-btn', t('action.cancel'));
      cancelBtn.type = 'button';
      cancelBtn.addEventListener('click', () => { inlineDialog = null; render(); });
      actions.appendChild(okBtn);
      actions.appendChild(cancelBtn);
      box.appendChild(actions);
      return box;
    }

    if (inlineDialog.kind === 'new-worktree') {
      const branchInput = buildEl('input', 'agy-sb-search');
      branchInput.placeholder = 'Branch (e.g. feat/sidebar-wt)';
      const pathInput = buildEl('input', 'agy-sb-search');
      pathInput.placeholder = 'Path (e.g. ../repo-feat-sidebar-wt)';
      box.appendChild(branchInput);
      box.appendChild(pathInput);
      const actions = buildEl('div', 'agy-sb-banner-actions');
      const okBtn = buildEl('button', 'agy-sb-btn', t('action.confirm'));
      okBtn.type = 'button';
      okBtn.addEventListener('click', async () => {
        const res = await ctx.bridge.post('/worktree/mutate', {
          root: inlineDialog.repoRoot,
          action: 'add',
          branch: branchInput.value.trim(),
          path: pathInput.value.trim(),
          createBranch: true
        });
        if (res?.ok) {
          inlineDialog = null;
          await refreshBootstrap({ refreshWorktrees: true });
        } else {
          toastBanner = { tone: 'error', text: res?.error || 'WORKTREE_ADD_FAILED' };
          render();
        }
      });
      const cancelBtn = buildEl('button', 'agy-sb-btn', t('action.cancel'));
      cancelBtn.type = 'button';
      cancelBtn.addEventListener('click', () => { inlineDialog = null; render(); });
      actions.appendChild(okBtn);
      actions.appendChild(cancelBtn);
      box.appendChild(actions);
      return box;
    }

    if (inlineDialog.kind === 'remove-worktree') {
      box.setAttribute('data-tone', 'warn');
      box.appendChild(buildEl('div', '', t('confirm.removeWorktree', { label: inlineDialog.label })));
      const actions = buildEl('div', 'agy-sb-banner-actions');
      const okBtn = buildEl('button', 'agy-sb-btn agy-sb-btn-danger', t('action.confirm'));
      okBtn.type = 'button';
      okBtn.addEventListener('click', async () => {
        const res = await ctx.bridge.post('/worktree/mutate', {
          root: inlineDialog.repoRoot,
          action: 'remove',
          path: inlineDialog.path
        });
        inlineDialog = null;
        if (res?.ok) await refreshBootstrap({ refreshWorktrees: true });
        else {
          toastBanner = { tone: 'error', text: res?.error || 'WORKTREE_REMOVE_FAILED' };
          render();
        }
      });
      const cancelBtn = buildEl('button', 'agy-sb-btn', t('action.cancel'));
      cancelBtn.type = 'button';
      cancelBtn.addEventListener('click', () => { inlineDialog = null; render(); });
      actions.appendChild(okBtn);
      actions.appendChild(cancelBtn);
      box.appendChild(actions);
      return box;
    }

    return null;
  }

  function render() {
    if (disposed || !shellEl) return;
    shellEl.textContent = '';
    shellEl.setAttribute('data-dragging-active', isDragging ? 'true' : 'false');

    // 1. Header
    const header = buildEl('div', 'agy-sb-header');
    const topRow = buildEl('div', 'agy-sb-top-row');

    const pill = buildEl('div', 'agy-sb-mode-pill');
    const enhBtn = buildEl('button', 'agy-sb-mode-btn', t('mode.enhanced'));
    enhBtn.type = 'button';
    enhBtn.setAttribute('data-mode', 'enhanced');
    enhBtn.setAttribute('data-active', settings.viewMode === 'enhanced' ? 'true' : 'false');
    enhBtn.addEventListener('click', () => void setViewMode('enhanced'));

    const natBtn = buildEl('button', 'agy-sb-mode-btn', t('mode.native'));
    natBtn.type = 'button';
    natBtn.setAttribute('data-mode', 'native');
    natBtn.setAttribute('data-active', settings.viewMode === 'native' ? 'true' : 'false');
    natBtn.addEventListener('click', () => void setViewMode('native'));

    pill.appendChild(enhBtn);
    pill.appendChild(natBtn);
    topRow.appendChild(pill);

    const toolbar = buildEl('div', 'agy-sb-toolbar');
    const newGrpBtn = buildEl('button', 'agy-sb-btn', t('action.newGroup'));
    newGrpBtn.type = 'button';
    newGrpBtn.setAttribute('data-action', 'new-group');
    newGrpBtn.addEventListener('click', () => {
      inlineDialog = { kind: 'new-group', currentName: '' };
      render();
    });

    const refBtn = buildEl('button', 'agy-sb-btn', '↻');
    refBtn.type = 'button';
    refBtn.setAttribute('title', t('action.refreshWorktrees'));
    refBtn.setAttribute('data-action', 'refresh-worktrees');
    refBtn.addEventListener('click', () => void refreshBootstrap({ refreshWorktrees: true }));

    toolbar.appendChild(newGrpBtn);
    toolbar.appendChild(refBtn);
    topRow.appendChild(toolbar);
    header.appendChild(topRow);

    const searchInput = buildEl('input', 'agy-sb-search');
    searchInput.type = 'search';
    searchInput.value = searchQuery;
    searchInput.placeholder = t('search.placeholder');
    searchInput.addEventListener('input', (e) => {
      searchQuery = String(e?.target?.value ?? searchInput.value ?? '');
      render();
    });
    header.appendChild(searchInput);
    shellEl.appendChild(header);

    // 2. Banners (toast, inline confirm, cross-workspace guidance)
    if (toastBanner) {
      const tb = buildEl('div', 'agy-sb-banner');
      tb.setAttribute('data-tone', toastBanner.tone || 'warn');
      tb.setAttribute('data-banner', 'toast');
      tb.appendChild(buildEl('div', '', toastBanner.text));
      const closeBtn = buildEl('button', 'agy-sb-btn', '✕');
      closeBtn.type = 'button';
      closeBtn.addEventListener('click', () => { toastBanner = null; render(); });
      tb.appendChild(closeBtn);
      shellEl.appendChild(tb);
    }

    const dlgEl = renderInlineDialog();
    if (dlgEl) shellEl.appendChild(dlgEl);

    if (guidanceBanner) {
      const gb = buildEl('div', 'agy-sb-banner');
      gb.setAttribute('data-tone', 'warn');
      gb.setAttribute('data-banner', 'cross-workspace');
      gb.appendChild(buildEl('div', '', t('guidance.crossWorkspace', {
        worktreePath: guidanceBanner.worktreePath,
        windowPath: guidanceBanner.windowPath
      })));
      const actions = buildEl('div', 'agy-sb-banner-actions');
      const openWinBtn = buildEl('button', 'agy-sb-btn', t('action.openNewWindow'));
      openWinBtn.type = 'button';
      openWinBtn.setAttribute('data-action', 'open-new-window');
      openWinBtn.addEventListener('click', async () => {
        await ctx.bridge.post('/workspace/open-window', { path: guidanceBanner.worktreePath });
      });
      actions.appendChild(openWinBtn);

      if (guidanceBanner.pcWebUrl) {
        const openWebBtn = buildEl('button', 'agy-sb-btn', t('action.openInPcWeb'));
        openWebBtn.type = 'button';
        openWebBtn.setAttribute('data-action', 'open-pc-web');
        openWebBtn.addEventListener('click', () => {
          const base = String(guidanceBanner.pcWebUrl).replace(/\/+$/, '');
          const targetUrl = `${base}/?session=${encodeURIComponent(guidanceBanner.cascadeId)}`;
          if (typeof globalThis.open === 'function') {
            globalThis.open(targetUrl, '_blank', 'noopener,noreferrer');
          }
        });
        actions.appendChild(openWebBtn);
      }
      gb.appendChild(actions);
      shellEl.appendChild(gb);
    }

    // 3. Body Tree
    const body = buildEl('div', 'agy-sb-body');
    const q = searchQuery.trim().toLowerCase();
    const filteredSessions = q
      ? orgState.sessions.filter((s) => {
          const hay = `${s.title || ''} ${s.summary || ''} ${s.projectName || ''} ${s.worktreeBranch || ''} ${s.worktreePath || ''}`.toLowerCase();
          return hay.includes(q);
        })
      : orgState.sessions;

    const sessionsByProj = new Map();
    const standaloneSessions = [];
    const pinnedGlobalSessions = [];
    const archivedSessions = [];

    for (const s of filteredSessions) {
      if (s.archived) {
        archivedSessions.push(s);
        continue;
      }
      if (s.pinned) pinnedGlobalSessions.push(s);
      if (s.projectId) {
        if (!sessionsByProj.has(s.projectId)) sessionsByProj.set(s.projectId, []);
        sessionsByProj.get(s.projectId).push(s);
      } else {
        standaloneSessions.push(s);
      }
    }

    const filteredProjects = q
      ? orgState.projects.filter((p) => {
          const projMatch = `${p.name || ''} ${p.rootPath || ''}`.toLowerCase().includes(q);
          const wtMatch = Array.isArray(p.worktrees) && p.worktrees.some((w) => `${w.branch || ''} ${w.path || ''}`.toLowerCase().includes(q));
          const hasMatchedSessions = (sessionsByProj.get(p.id) || []).length > 0;
          return projMatch || wtMatch || hasMatchedSessions;
        })
      : orgState.projects;

    const shortcutCounter = { count: 0 };

    // 3a. Pinned shortcut section
    if (pinnedGlobalSessions.length > 0) {
      body.appendChild(buildEl('div', 'agy-sb-section-title', t('section.pinned')));
      const orderedPinned = sortByOrderIds(
        pinnedGlobalSessions,
        orgState.sessionOrder?.__pinned__ || [],
        (s) => s.cascadeId
      );
      for (const ps of orderedPinned) {
        body.appendChild(renderSessionRow(ps, '__pinned__', '', shortcutCounter));
      }
    }

    // 3b. Groups (pinned then normal)
    const pinnedGroups = sortByOrderIds(
      orgState.groups.filter((g) => g.pinned),
      orgState.groupOrder?.pinned || [],
      (g) => g.id
    );
    const normalGroups = sortByOrderIds(
      orgState.groups.filter((g) => !g.pinned),
      orgState.groupOrder?.normal || [],
      (g) => g.id
    );
    for (const g of [...pinnedGroups, ...normalGroups]) {
      body.appendChild(renderGroupNode(g, filteredProjects, sessionsByProj, shortcutCounter));
    }

    // 3c. Ungrouped projects + ungrouped drop slot (>=44px)
    const ungrouped = filteredProjects.filter((p) => !p.groupId);
    const ungroupedPinned = sortByOrderIds(
      ungrouped.filter((p) => p.pinned),
      orgState.projectOrder?.__ungrouped__?.pinned || [],
      (p) => p.id
    );
    const ungroupedNormal = sortByOrderIds(
      ungrouped.filter((p) => !p.pinned),
      orgState.projectOrder?.__ungrouped__?.normal || [],
      (p) => p.id
    );
    if (ungrouped.length > 0 || (isDragging && dragState?.targetType === 'project')) {
      body.appendChild(buildEl('div', 'agy-sb-section-title', t('section.ungrouped')));
      if (isDragging && dragState?.targetType === 'project' && dragState.groupId) {
        const ungroupedSlot = buildEl('div', 'agy-sb-drop-slot', t('drop.ungroupedHint'));
        ungroupedSlot.setAttribute('data-slot', 'ungrouped');
        ungroupedSlot.addEventListener('dragover', (e) => e?.preventDefault?.());
        ungroupedSlot.addEventListener('drop', (e) => {
          e?.preventDefault?.();
          void handleDropTarget({ targetType: 'project', toGroupId: null, containerId: '__ungrouped__' });
        });
        body.appendChild(ungroupedSlot);
      }
      for (const p of [...ungroupedPinned, ...ungroupedNormal]) {
        body.appendChild(renderProjectNode(p, sessionsByProj.get(p.id) || [], shortcutCounter));
      }
    }

    // 3d. Standalone sessions
    if (standaloneSessions.length > 0) {
      body.appendChild(buildEl('div', 'agy-sb-section-title', t('section.standalone')));
      body.appendChild(renderSessionList(standaloneSessions, '__standalone__', '', shortcutCounter));
    }

    // 3e. Archived toggle / list
    if (orgState.archivedCount > 0 || showArchived) {
      const archTitle = buildEl('div', 'agy-sb-section-title');
      const archBtn = buildEl('button', 'agy-sb-btn', `${t('section.archived')} (${orgState.archivedCount || archivedSessions.length})`);
      archBtn.type = 'button';
      archBtn.addEventListener('click', () => {
        showArchived = !showArchived;
        void refreshBootstrap();
      });
      archTitle.appendChild(archBtn);
      body.appendChild(archTitle);
      if (showArchived) {
        for (const as of archivedSessions) {
          body.appendChild(renderSessionRow(as, '__archived__', 'agy-sb-indent-1', shortcutCounter));
        }
      }
    }

    shellEl.appendChild(body);
  }

  function ensureMountedOnRoot(rootEl) {
    if (disposed || !rootEl || !doc?.createElement) return;
    if (anchorTimer) {
      clearTimeout(anchorTimer);
      anchorTimer = null;
    }
    sidebarRootEl = rootEl;

    if (!hostContainerEl) {
      const existing = rootEl.querySelector?.('#agy-sidebar-enhanced-root');
      hostContainerEl = existing || doc.createElement('div');
      hostContainerEl.id = 'agy-sidebar-enhanced-root';
      hostContainerEl.setAttribute('data-agy-plugin', ctx.pluginId || 'agy-daddy.sidebar');
      shadowRoot = hostContainerEl.shadowRoot || hostContainerEl.attachShadow({ mode: 'open' });
      shadowRoot.textContent = '';

      const styleEl = doc.createElement('style');
      styleEl.textContent = SHADOW_CSS;
      shadowRoot.appendChild(styleEl);

      shellEl = doc.createElement('div');
      shellEl.className = 'agy-sb-shell';
      shadowRoot.appendChild(shellEl);
    }

    if (hostContainerEl.parentElement !== rootEl) {
      rootEl.appendChild(hostContainerEl);
    }

    setHealth('ok', null);
    syncTopInset();
    applyVisibilityMode();
    render();
    void refreshBootstrap();
  }

  function syncTopInset() {
    if (!hostContainerEl?.style?.setProperty) return;
    const defaultInset = 40;
    try {
      const rootRect = sidebarRootEl?.getBoundingClientRect?.();
      const titlebarEl = doc?.querySelector?.('[class*="@container/titlebar"]');
      const titlebarRect = titlebarEl?.getBoundingClientRect?.();
      if (titlebarRect && titlebarRect.height > 0 && rootRect && rootRect.height > 0) {
        const overlap = Math.max(0, Math.ceil(titlebarRect.bottom - rootRect.top));
        hostContainerEl.style.setProperty('--agy-sb-top-inset', `${overlap}px`);
        return;
      }
      if (rootRect && rootRect.height > 0) {
        const inset = rootRect.top < 36 ? defaultInset : 0;
        hostContainerEl.style.setProperty('--agy-sb-top-inset', `${inset}px`);
        return;
      }
    } catch {}
    hostContainerEl.style.setProperty('--agy-sb-top-inset', `${defaultInset}px`);
  }

  function findSidebarRootFallback() {
    const direct = ctx?.anchors?.query?.('sidebar.root');
    if (direct) return direct;
    const rows = ctx?.anchors?.queryAll?.('sidebar.conversationRows') || [];
    if (rows.length > 0 && typeof rows[0]?.closest === 'function') {
      return rows[0].closest('aside, [data-testid="sidebar-panel"], [data-testid="left-sidebar"], .bg-sidebar');
    }
    return null;
  }

  function handleAnchorLoss() {
    sidebarRootEl = null;
    applyVisibilityMode();
    setHealth('degraded', 'ANCHOR_MISSING');
  }

  // Inject non-destructive Light DOM mode toggle stylesheet
  if (ctx?.styles?.inject) {
    disposers.push(ctx.styles.inject(HOST_TOGGLE_CSS, { scope: 'document', id: 'sidebar-mode-toggle' }));
  }

  // Register topbar unit so user always has a toggle back from Native mode
  if (ctx?.topbar?.registerUnit) {
    disposers.push(ctx.topbar.registerUnit({
      id: TOPBAR_UNIT_ID,
      order: 18,
      label: settings.viewMode === 'enhanced' ? t('topbar.enhanced') : t('topbar.native'),
      badge: settings.viewMode === 'enhanced' ? t('mode.enhanced') : t('mode.native'),
      title: t('topbar.title'),
      onClick: () => { void toggleViewMode(); }
    }));
  }

  // Observe sidebar.root and conversationRows fallback
  if (ctx?.anchors?.observe) {
    disposers.push(ctx.anchors.observe('sidebar.root', (el) => {
      if (disposed) return;
      if (el) {
        ensureMountedOnRoot(el);
      } else {
        const fb = findSidebarRootFallback();
        if (fb) ensureMountedOnRoot(fb);
        else if (sidebarRootEl) handleAnchorLoss();
      }
    }));

    disposers.push(ctx.anchors.observe('sidebar.conversationRows', () => {
      if (disposed || sidebarRootEl) return;
      const fb = findSidebarRootFallback();
      if (fb) ensureMountedOnRoot(fb);
    }));
  }

  const initialRoot = findSidebarRootFallback();
  if (initialRoot) {
    ensureMountedOnRoot(initialRoot);
  } else {
    anchorTimer = setTimeout(() => {
      anchorTimer = null;
      if (disposed || sidebarRootEl) return;
      const retryRoot = findSidebarRootFallback();
      if (retryRoot) {
        ensureMountedOnRoot(retryRoot);
      } else {
        handleAnchorLoss();
      }
    }, anchorTimeoutMs);
  }

  // Settings & bus subscriptions
  if (ctx?.settings?.onChange) {
    disposers.push(ctx.settings.onChange((nextVals) => {
      if (isPlainObject(nextVals)) {
        if (nextVals.viewMode === 'enhanced' || nextVals.viewMode === 'native') {
          settings.viewMode = nextVals.viewMode;
        }
        if (typeof nextVals.autoExpandActiveWorktree === 'boolean') {
          settings.autoExpandActiveWorktree = nextVals.autoExpandActiveWorktree;
        }
        if (typeof nextVals.showWorktreePathHint === 'boolean') {
          settings.showWorktreePathHint = nextVals.showWorktreePathHint;
        }
        applyVisibilityMode();
        render();
      }
    }));
  }

  if (ctx?.events?.on) {
    disposers.push(ctx.events.on('sidebar:view-mode-changed@1', (payload) => {
      if (payload?.viewMode === 'enhanced' || payload?.viewMode === 'native') {
        settings.viewMode = payload.viewMode;
        applyVisibilityMode();
        render();
      }
    }));
    disposers.push(ctx.events.on('sidebar:org-updated@1', () => {
      void refreshBootstrap();
    }));
    disposers.push(ctx.events.on('sidebar:worktree-updated@1', () => {
      void refreshBootstrap();
    }));
    disposers.push(ctx.events.on('sidebar:open-create-group@1', () => {
      inlineDialog = { kind: 'new-group', currentName: '' };
      render();
    }));
  }

  // Coexist with agy-daddy-plugin-chat-nav Meta / ⌘1~⌘9 badges without intercepting keydown
  const onKeyDown = (e) => {
    if (!e || disposed) return;
    if ((e.key === 'Meta' || (e.metaKey && !e.key)) && !e.shiftKey && !e.ctrlKey && !e.altKey) {
      if (!showShortcutBadges && settings.viewMode === 'enhanced' && healthStatus !== 'degraded') {
        showShortcutBadges = true;
        render();
      }
    }
  };
  const onKeyUp = (e) => {
    if (!e || disposed) return;
    if ((e.key === 'Meta' || !e.metaKey) && showShortcutBadges) {
      showShortcutBadges = false;
      render();
    }
  };
  const onBlur = () => {
    if (showShortcutBadges) {
      showShortcutBadges = false;
      render();
    }
  };

  if (doc?.addEventListener) {
    doc.addEventListener('keydown', onKeyDown, true);
    doc.addEventListener('keyup', onKeyUp, true);
    disposers.push(() => {
      doc.removeEventListener?.('keydown', onKeyDown, true);
      doc.removeEventListener?.('keyup', onKeyUp, true);
    });
  }
  if (win?.addEventListener) {
    const onResize = () => syncTopInset();
    win.addEventListener('blur', onBlur);
    win.addEventListener('resize', onResize);
    disposers.push(() => {
      win.removeEventListener?.('blur', onBlur);
      win.removeEventListener?.('resize', onResize);
    });
  }

  // Provide isolated-realm service API for diagnostics & deterministic tests
  if (ctx?.services?.provide) {
    disposers.push(ctx.services.provide('sidebar', {
      getSnapshot: () => ({
        viewMode: settings.viewMode,
        healthStatus,
        healthReason,
        mounted: Boolean(hostContainerEl && sidebarRootEl),
        revision: orgState.revision,
        groups: orgState.groups,
        projects: orgState.projects,
        sessions: orgState.sessions,
        guidanceBanner,
        inlineDialog
      }),
      setViewMode,
      toggleViewMode,
      refresh: (opts) => refreshBootstrap(opts),
      startDrag: (desc) => startDrag(desc),
      dropOnTarget: (target) => handleDropTarget(target),
      clickSession: (cascadeId) => {
        const s = orgState.sessions.find((x) => x.cascadeId === cascadeId);
        return s ? activateSessionRow(s) : { ok: false, error: 'SESSION_NOT_FOUND' };
      }
    }));
  }

  activeInstance = {
    dispose() {
      if (disposed) return;
      disposed = true;
      if (anchorTimer) {
        clearTimeout(anchorTimer);
        anchorTimer = null;
      }
      clearHoverExpand();
      for (const fn of disposers.splice(0).reverse()) {
        try { if (typeof fn === 'function') fn(); } catch {}
      }
      if (sidebarRootEl) {
        try { sidebarRootEl.removeAttribute?.('data-agy-sidebar-mode'); } catch {}
      }
      if (hostContainerEl) {
        try { hostContainerEl.remove?.(); } catch {}
      }
      sidebarRootEl = null;
      hostContainerEl = null;
      shadowRoot = null;
      shellEl = null;
    }
  };
}

function dispose() {
  if (activeInstance) {
    activeInstance.dispose();
    activeInstance = null;
  }
}

module.exports = {
  mount,
  dispose,
  sortWorktreesForView,
  reorderArray
};
