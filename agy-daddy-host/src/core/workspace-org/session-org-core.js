'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  DatabaseSync = null;
}

const {
  isTestMode,
  isPlainObject,
  normalizeLocalPath,
  normalizeUriToPath,
  pathToFileUri,
  canonicalizePath,
  canonicalKey,
  getPathLookupKeys,
  isSameOrInside,
  isForbiddenSystemRoot,
  isTempBridgeWorkspace,
  makeWorktreeId,
  deriveWorkspaceProjectId,
  makeAppSyncedProjectId,
  makeImplicitProjectId,
  makeStableProjectId,
  matchWorktreeByLongestPrefix
} = require('./path-canonicalizer');
const { sortWorktreeSubgroups } = require('./worktree-discovery');

const DEFAULT_SESSION_LIMIT = 50;
const MAX_SESSION_LIMIT = 500;
const DB_CACHE_TTL_MS = 2000;
const RUNNING_STATUS_RE = /RUNNING|GENERATING/i;
const LOCK_STALE_MS = 2000;
const LOCK_RETRY_WAIT_MS = 15;
const LOCK_TIMEOUT_MS = 500;
const WATCH_DEBOUNCE_MS = 120;

const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  try {
    Atomics.wait(SLEEP_BUF, 0, 0, Math.max(1, ms));
  } catch {
    const end = Date.now() + Math.max(1, ms);
    while (Date.now() < end) {
      // Fallback spin if Atomics.wait is unavailable
    }
  }
}

function dedupeStrings(arr) {
  return Array.from(new Set(
    (Array.isArray(arr) ? arr : [])
      .map((s) => String(s || '').trim())
      .filter(Boolean)
  ));
}

function sanitizeZoneOrder(raw) {
  return {
    pinned: dedupeStrings(raw?.pinned),
    normal: dedupeStrings(raw?.normal)
  };
}

function sanitizeRemoteMeta(raw) {
  if (!isPlainObject(raw)) return null;
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : '';
  if (!provider) return null;
  const out = { provider };
  for (const k of ['ownerRepo', 'repoUrl', 'branch', 'driveMode', 'account', 'remoteName', 'remoteFolderId']) {
    if (typeof raw[k] === 'string' && raw[k].trim()) {
      out[k] = raw[k].trim();
    }
  }
  return out;
}

function sanitizePinTimestamps(raw) {
  const out = { sessions: {}, projects: {}, groups: {} };
  if (!isPlainObject(raw)) return out;
  for (const bucket of ['sessions', 'projects', 'groups']) {
    if (!isPlainObject(raw[bucket])) continue;
    for (const [k, v] of Object.entries(raw[bucket])) {
      const ck = String(k || '').trim();
      if (ck && typeof v === 'string' && v.trim()) {
        out[bucket][ck] = v.trim();
      }
    }
  }
  return out;
}

function sanitizeCollapsedNodes(raw) {
  const out = { projects: {}, worktrees: {} };
  if (!isPlainObject(raw)) return out;
  for (const bucket of ['projects', 'worktrees']) {
    if (!isPlainObject(raw[bucket])) continue;
    for (const [k, v] of Object.entries(raw[bucket])) {
      const ck = String(k || '').trim();
      if (ck && v === true) {
        out[bucket][ck] = true;
      }
    }
  }
  return out;
}

function sanitizeWorktreeTombstones(raw) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  for (const [wtId, entry] of Object.entries(raw)) {
    const cleanId = String(wtId || '').trim();
    if (!cleanId || !isPlainObject(entry)) continue;
    const repoRootPath = normalizeLocalPath(entry.repoRootPath);
    const wtPath = normalizeLocalPath(entry.path);
    if (!repoRootPath || !wtPath) continue;
    out[cleanId] = {
      repoRootPath,
      path: wtPath,
      branch: typeof entry.branch === 'string' ? entry.branch.trim() : '',
      lastSeenAt: typeof entry.lastSeenAt === 'string' && entry.lastSeenAt.trim()
        ? entry.lastSeenAt.trim()
        : new Date().toISOString()
    };
  }
  return out;
}

function sanitizeSessionWorktreeBindings(raw) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  for (const [cid, entry] of Object.entries(raw)) {
    const cleanCid = String(cid || '').trim();
    if (!cleanCid || !isPlainObject(entry)) continue;
    const workspacePath = normalizeLocalPath(entry.workspacePath || entry.workspaceUri);
    const workspaceUri = typeof entry.workspaceUri === 'string' && entry.workspaceUri.trim()
      ? entry.workspaceUri.trim()
      : (workspacePath ? pathToFileUri(workspacePath) : '');
    if (!workspacePath && !workspaceUri) continue;
    out[cleanCid] = {
      projectId: typeof entry.projectId === 'string' && entry.projectId.trim() ? entry.projectId.trim() : null,
      worktreeId: typeof entry.worktreeId === 'string' && entry.worktreeId.trim()
        ? entry.worktreeId.trim()
        : (workspacePath ? makeWorktreeId(workspacePath) : null),
      workspacePath: workspacePath || '',
      workspaceUri: workspaceUri || ''
    };
  }
  return out;
}

function createEmptyPersistedOrg() {
  return {
    version: 2,
    revision: 0,
    updatedAt: null,
    updatedBy: null,
    defaultSessionPath: null,
    groups: [],
    projects: [],
    collapsedNodes: {
      projects: {},
      worktrees: {}
    },
    pins: {
      sessions: [],
      projects: [],
      groups: []
    },
    pinTimestamps: {
      sessions: {},
      projects: {},
      groups: {}
    },
    projectGroupMap: {},
    sessionGroupMap: {},
    sessionProjectOverrides: {},
    sessionWorktreeBindings: {},
    groupOrder: {
      pinned: [],
      normal: []
    },
    projectOrder: {},
    sessionOrder: {},
    worktreeTombstones: {},
    archivedSessions: {},
    deletedSessions: {},
    migrations: {
      workspaceMetaV1At: null
    }
  };
}

function sanitizePersistedOrg(raw) {
  const base = createEmptyPersistedOrg();
  if (!isPlainObject(raw)) return base;

  const rev = Number(raw.revision);
  base.revision = Number.isInteger(rev) && rev >= 0 ? rev : 0;
  base.updatedAt = typeof raw.updatedAt === 'string' && raw.updatedAt.trim() ? raw.updatedAt.trim() : null;
  base.updatedBy = typeof raw.updatedBy === 'string' && raw.updatedBy.trim() ? raw.updatedBy.trim() : null;
  base.defaultSessionPath = typeof raw.defaultSessionPath === 'string' && raw.defaultSessionPath.trim()
    ? (normalizeLocalPath(raw.defaultSessionPath) || null)
    : null;

  base.pins = {
    sessions: dedupeStrings(raw.pins?.sessions),
    projects: dedupeStrings(raw.pins?.projects),
    groups: dedupeStrings(raw.pins?.groups)
  };
  base.pinTimestamps = sanitizePinTimestamps(raw.pinTimestamps);
  base.collapsedNodes = sanitizeCollapsedNodes(raw.collapsedNodes);
  base.worktreeTombstones = sanitizeWorktreeTombstones(raw.worktreeTombstones);
  base.sessionWorktreeBindings = sanitizeSessionWorktreeBindings(raw.sessionWorktreeBindings);

  const nowIso = base.updatedAt || new Date().toISOString();
  if (Array.isArray(raw.groups)) {
    const seen = new Set();
    base.groups = raw.groups
      .filter((g) => isPlainObject(g) && String(g.id || '').trim())
      .map((g, idx) => {
        const id = String(g.id).trim();
        if (seen.has(id)) return null;
        seen.add(id);
        return {
          id,
          name: String(g.name || id).trim() || id,
          source: g.source === 'host' ? 'host' : 'user',
          collapsed: Boolean(g.collapsed),
          order: Number.isFinite(Number(g.order))
            ? Number(g.order)
            : (Number.isFinite(Number(g.sortOrder)) ? Number(g.sortOrder) : idx),
          projectIds: dedupeStrings(g.projectIds),
          workspaceUris: dedupeStrings(g.workspaceUris),
          sessionIds: dedupeStrings(g.sessionIds),
          createdAt: typeof g.createdAt === 'string' && g.createdAt.trim() ? g.createdAt.trim() : nowIso,
          updatedAt: typeof g.updatedAt === 'string' && g.updatedAt.trim() ? g.updatedAt.trim() : nowIso
        };
      })
      .filter(Boolean);
  }

  const groupIdSet = new Set(base.groups.map((g) => g.id));

  if (isPlainObject(raw.projectGroupMap)) {
    for (const [k, v] of Object.entries(raw.projectGroupMap)) {
      const ck = String(k || '').trim();
      const cv = String(v || '').trim();
      if (ck && cv) base.projectGroupMap[ck] = cv;
    }
  }

  if (Array.isArray(raw.projects)) {
    const seenIds = new Set();
    const seenPaths = new Set();
    for (const p of raw.projects) {
      if (!isPlainObject(p) || !String(p.id || '').trim()) continue;
      const id = String(p.id).trim();
      if (seenIds.has(id)) continue;
      const rootPath = normalizeLocalPath(p.rootPath || p.path || p.uri);
      if (!rootPath) continue;
      const pKey = canonicalKey(rootPath);
      if (seenPaths.has(pKey)) continue;
      seenIds.add(id);
      seenPaths.add(pKey);

      const rawGid = base.projectGroupMap[id] || (typeof p.groupId === 'string' ? p.groupId.trim() : '');
      const gid = rawGid && groupIdSet.has(rawGid) ? rawGid : null;
      if (gid) base.projectGroupMap[id] = gid;
      else delete base.projectGroupMap[id];

      const aliases = dedupeStrings([...(Array.isArray(p.aliases) ? p.aliases : [])]).filter((a) => a !== id);
      const remote = sanitizeRemoteMeta(p.remote);

      base.projects.push({
        id,
        aliases,
        name: String(p.name || path.basename(rootPath) || id).trim() || id,
        rootPath,
        uri: typeof p.uri === 'string' && p.uri.trim().startsWith('file://') ? p.uri.trim() : (pathToFileUri(rootPath) || ''),
        groupId: gid,
        source: typeof p.source === 'string' && p.source.trim() ? p.source.trim() : 'local',
        syncedFromApp: Boolean(p.syncedFromApp),
        ...(remote ? { remote } : {}),
        createdAt: typeof p.createdAt === 'string' && p.createdAt.trim() ? p.createdAt.trim() : nowIso,
        updatedAt: typeof p.updatedAt === 'string' && p.updatedAt.trim() ? p.updatedAt.trim() : nowIso
      });
    }
  }

  if (isPlainObject(raw.sessionGroupMap)) {
    for (const [k, v] of Object.entries(raw.sessionGroupMap)) {
      const ck = String(k || '').trim();
      const cv = String(v || '').trim();
      if (ck && cv) base.sessionGroupMap[ck] = cv;
    }
  }

  if (isPlainObject(raw.sessionProjectOverrides)) {
    for (const [k, v] of Object.entries(raw.sessionProjectOverrides)) {
      const ck = String(k || '').trim();
      if (!ck) continue;
      if (v === null) {
        base.sessionProjectOverrides[ck] = null;
      } else if (typeof v === 'string' && v.trim()) {
        base.sessionProjectOverrides[ck] = v.trim();
      }
    }
  }

  if (isPlainObject(raw.groupOrder)) {
    base.groupOrder = sanitizeZoneOrder(raw.groupOrder);
  }

  if (isPlainObject(raw.projectOrder)) {
    for (const [k, v] of Object.entries(raw.projectOrder)) {
      const ck = String(k || '').trim();
      if (ck && isPlainObject(v)) {
        base.projectOrder[ck] = sanitizeZoneOrder(v);
      }
    }
  }

  if (isPlainObject(raw.sessionOrder)) {
    for (const [k, v] of Object.entries(raw.sessionOrder)) {
      const ck = String(k || '').trim();
      if (!ck) continue;
      if (ck === '__pinned__' && Array.isArray(v)) {
        base.sessionOrder.__pinned__ = dedupeStrings(v);
      } else if (isPlainObject(v)) {
        base.sessionOrder[ck] = sanitizeZoneOrder(v);
      }
    }
  }

  if (isPlainObject(raw.archivedSessions)) {
    for (const [cid, entry] of Object.entries(raw.archivedSessions)) {
      const cleanCid = String(cid || '').trim();
      if (!cleanCid || !isPlainObject(entry)) continue;
      base.archivedSessions[cleanCid] = {
        archivedAt: typeof entry.archivedAt === 'string' && entry.archivedAt.trim() ? entry.archivedAt.trim() : nowIso,
        archivedAtStepCount: Number.isFinite(Number(entry.archivedAtStepCount)) ? Math.max(0, Math.floor(Number(entry.archivedAtStepCount))) : 0,
        archivedWasRunning: Boolean(entry.archivedWasRunning),
        projectId: typeof entry.projectId === 'string' && entry.projectId.trim() ? entry.projectId.trim() : null,
        projectName: typeof entry.projectName === 'string' && entry.projectName.trim() ? entry.projectName.trim() : null,
        titleSnapshot: typeof entry.titleSnapshot === 'string' ? entry.titleSnapshot : ''
      };
    }
  }

  if (isPlainObject(raw.deletedSessions)) {
    for (const [cid, entry] of Object.entries(raw.deletedSessions)) {
      const cleanCid = String(cid || '').trim();
      if (!cleanCid || !isPlainObject(entry)) continue;
      base.deletedSessions[cleanCid] = {
        deletedAt: typeof entry.deletedAt === 'string' && entry.deletedAt.trim() ? entry.deletedAt.trim() : nowIso,
        mode: entry.mode === 'host_deleted' ? 'host_deleted' : 'local_tombstone'
      };
    }
  }

  if (isPlainObject(raw.migrations)) {
    base.migrations = {
      workspaceMetaV1At: typeof raw.migrations.workspaceMetaV1At === 'string' && raw.migrations.workspaceMetaV1At.trim()
        ? raw.migrations.workspaceMetaV1At.trim()
        : null
    };
  }

  return base;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function isLockStale(lockPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const ts = Number(parsed?.ts || 0);
    const pid = Number(parsed?.pid || 0);
    if (Date.now() - ts > LOCK_STALE_MS) return true;
    if (pid > 0 && !isProcessAlive(pid)) return true;
    return false;
  } catch {
    try {
      const st = fs.statSync(lockPath);
      return (Date.now() - st.mtimeMs) > LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
}

function acquireFileLockSync(lockPath) {
  const dir = path.dirname(lockPath);
  fs.mkdirSync(dir, { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }), 0, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      if (isLockStale(lockPath)) {
        try {
          fs.unlinkSync(lockPath);
          continue;
        } catch {}
      }
      if (Date.now() >= deadline) {
        try { fs.unlinkSync(lockPath); } catch {}
        const fd = fs.openSync(lockPath, 'wx');
        try {
          fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }), 0, 'utf8');
        } finally {
          fs.closeSync(fd);
        }
        return true;
      }
      sleepSync(LOCK_RETRY_WAIT_MS);
    }
  }
}

function writeJsonAtomicSync(targetPath, data) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${targetPath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 2), 0, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, targetPath);
}

function buildOrgBusSummary(org, updatedBy) {
  return {
    revision: org.revision,
    updatedAt: org.updatedAt,
    updatedBy: updatedBy || org.updatedBy || null,
    pins: org.pins,
    groups: org.groups,
    collapsedNodes: org.collapsedNodes || { projects: {}, worktrees: {} },
    projectGroupMap: org.projectGroupMap,
    groupOrder: org.groupOrder,
    projectOrder: org.projectOrder,
    sessionOrder: org.sessionOrder,
    archivedCount: Object.keys(org.archivedSessions || {}).length
  };
}

function remapProjectIdReferences(org, oldId, canonicalId) {
  if (!oldId || !canonicalId || oldId === canonicalId) return;
  if (org.pins.projects.includes(oldId)) {
    org.pins.projects = dedupeStrings(org.pins.projects.map((id) => (id === oldId ? canonicalId : id)));
    if (org.pinTimestamps.projects[oldId] && !org.pinTimestamps.projects[canonicalId]) {
      org.pinTimestamps.projects[canonicalId] = org.pinTimestamps.projects[oldId];
    }
    delete org.pinTimestamps.projects[oldId];
  }
  if (org.projectGroupMap[oldId]) {
    if (!org.projectGroupMap[canonicalId]) {
      org.projectGroupMap[canonicalId] = org.projectGroupMap[oldId];
    }
    delete org.projectGroupMap[oldId];
  }
  for (const g of org.groups) {
    if (g.projectIds.includes(oldId)) {
      g.projectIds = dedupeStrings(g.projectIds.map((id) => (id === oldId ? canonicalId : id)));
    }
  }
  for (const container of Object.values(org.projectOrder)) {
    if (!isPlainObject(container)) continue;
    for (const zone of ['pinned', 'normal']) {
      if (Array.isArray(container[zone]) && container[zone].includes(oldId)) {
        container[zone] = dedupeStrings(container[zone].map((id) => (id === oldId ? canonicalId : id)));
      }
    }
  }
  for (const [cid, pid] of Object.entries(org.sessionProjectOverrides)) {
    if (pid === oldId) org.sessionProjectOverrides[cid] = canonicalId;
  }
  if (org.sessionOrder[oldId] && !org.sessionOrder[canonicalId]) {
    org.sessionOrder[canonicalId] = org.sessionOrder[oldId];
    delete org.sessionOrder[oldId];
  }
  if (org.collapsedNodes?.projects?.[oldId]) {
    org.collapsedNodes.projects[canonicalId] = true;
    delete org.collapsedNodes.projects[oldId];
  }
}

function findPersistedProject(org, { id, rootPath, workspaceUri } = {}) {
  const normPath = normalizeLocalPath(rootPath || workspaceUri);
  if (normPath) {
    const keys = getPathLookupKeys(normPath);
    for (const proj of org.projects) {
      const projKeys = getPathLookupKeys(proj.rootPath);
      if (projKeys.some((k) => keys.includes(k))) {
        return proj;
      }
    }
  }
  const cleanId = typeof id === 'string' ? id.trim() : '';
  if (cleanId) {
    const direct = org.projects.find((p) => p.id === cleanId);
    if (direct) return direct;
    const byAlias = org.projects.find((p) => Array.isArray(p.aliases) && p.aliases.includes(cleanId));
    if (byAlias) return byAlias;
  }
  return null;
}

function computeKnownAliasesForPath(normPath, extraIds = []) {
  const aliases = [...extraIds];
  if (normPath) {
    const wsId = deriveWorkspaceProjectId(normPath);
    const appId = makeAppSyncedProjectId(normPath);
    const impId = makeImplicitProjectId(normPath);
    if (wsId) aliases.push(wsId);
    if (appId) aliases.push(appId);
    if (impId) aliases.push(impId);
  }
  return dedupeStrings(aliases);
}

function removeFromOrderArray(arr, id) {
  if (!Array.isArray(arr)) return arr;
  return arr.filter((x) => x !== id);
}

function parseWorkspaceUrisField(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((u) => typeof u === 'string' && u.trim());
  const str = String(raw).trim();
  if (!str) return [];
  if (str.startsWith('[')) {
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed)) return parsed.filter((u) => typeof u === 'string' && u.trim());
    } catch {}
  }
  return str.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
}

function pickPrimaryWorkspaceUri(uris) {
  const list = Array.isArray(uris) ? uris : [];
  const real = list.find((u) => u && !isTempBridgeWorkspace(u));
  return real || list[0] || null;
}

function isGenericDbProjectId(id) {
  const s = String(id || '').trim().toLowerCase();
  return !s || s === 'default' || s === 'unknown' || s === 'none' || s === 'null';
}

function extractWorkspaceDisplayName(uriOrPath) {
  const norm = normalizeUriToPath(uriOrPath);
  if (!norm) return '';
  const parts = norm.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || norm;
}

function readConversationSummariesDb(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) return [];
  const sql = `
    SELECT conversation_id, title, preview, step_count, last_modified_time,
           workspace_uris, status, source, project_id, agent_name,
           parent_conversation_id, nesting_depth, group_id
    FROM conversation_summaries
    ORDER BY last_modified_time DESC
    LIMIT 2000
  `;
  if (DatabaseSync) {
    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db.prepare(sql).all();
      return Array.isArray(rows) ? rows : [];
    } catch {
      // Fallback to sqlite3 CLI
    } finally {
      try { db?.close(); } catch {}
    }
  }
  try {
    const out = execFileSync('sqlite3', ['-readonly', '-json', dbPath, sql], {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 8 * 1024 * 1024
    });
    const parsed = JSON.parse(out || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Aggregates flat project entries belonging to the same Git repository into one parent
 * project node with deterministic Worktree subgroups, while keeping single-workspace
 * repositories and plain folders completely flat (`isMultiWorktree: false`).
 */
function aggregateWorktreeProjects({
  projects = [],
  sessions = [],
  persistedOrg = null,
  worktreeDiscovery = null
} = {}) {
  const org = persistedOrg || createEmptyPersistedOrg();
  const collapsedProjects = org.collapsedNodes?.projects || {};
  const collapsedWorktrees = org.collapsedNodes?.worktrees || {};
  const tombstones = org.worktreeTombstones || {};

  // Pre-collect session raw paths to match worktrees and tombstones
  const allKnownWorktrees = [];
  const repoCacheByKey = new Map();

  for (const proj of projects) {
    const rawRoot = proj?.rootPath || proj?.path || '';
    if (!rawRoot || !worktreeDiscovery) continue;
    const snap = worktreeDiscovery.getCachedSnapshot(rawRoot);
    if (snap && snap.isGitRepo && Array.isArray(snap.worktrees) && snap.worktrees.length > 0) {
      const repoKey = canonicalKey(snap.repoRoot);
      if (!repoCacheByKey.has(repoKey)) {
        repoCacheByKey.set(repoKey, snap);
        for (const wt of snap.worktrees) {
          allKnownWorktrees.push({ ...wt, repoRootPath: snap.repoRoot, repoKey });
        }
      }
    }
  }

  // Include tombstones whose path is not currently in live worktrees
  const liveWtKeys = new Set(allKnownWorktrees.map((w) => w.canonicalKey));
  for (const [wtId, tb] of Object.entries(tombstones)) {
    const tbCanon = canonicalizePath(tb.path) || normalizeLocalPath(tb.path);
    const tbKey = canonicalKey(tbCanon);
    if (!tbKey || liveWtKeys.has(tbKey)) continue;
    const repoCanon = canonicalizePath(tb.repoRootPath) || normalizeLocalPath(tb.repoRootPath);
    const repoKey = canonicalKey(repoCanon);
    allKnownWorktrees.push({
      worktreeId: wtId,
      path: tbCanon,
      canonicalKey: tbKey,
      uri: pathToFileUri(tbCanon) || '',
      displaySubpath: `../${path.basename(tbCanon)}`,
      head: '',
      headShort: '',
      branch: tb.branch || '',
      displayLabel: tb.branch || path.basename(tbCanon),
      isMain: false,
      bare: false,
      detached: false,
      locked: false,
      prunable: true,
      exists: false,
      status: 'missing',
      collapsed: Boolean(collapsedWorktrees[wtId]),
      allowed: false,
      isCurrent: false,
      repoRootPath: repoCanon,
      repoKey,
      isTombstone: true
    });
  }

  // Group projects by repoKey if multi-worktree, else keep standalone
  const groupsByRepoKey = new Map();
  const ungroupedByProj = [];
  const mergedIdToPrimaryId = new Map();

  for (const proj of projects) {
    const rawRoot = proj?.rootPath || proj?.path || '';
    const canonRoot = canonicalizePath(rawRoot) || normalizeLocalPath(rawRoot);
    const matchedWt = matchWorktreeByLongestPrefix(canonRoot, allKnownWorktrees);
    if (matchedWt && repoCacheByKey.has(matchedWt.repoKey)) {
      const snap = repoCacheByKey.get(matchedWt.repoKey);
      const repoKey = matchedWt.repoKey;
      const tbForRepo = allKnownWorktrees.filter((w) => w.repoKey === repoKey && w.isTombstone);
      // Only check if tombstones have sessions later; build candidate bucket first
      if (!groupsByRepoKey.has(repoKey)) {
        groupsByRepoKey.set(repoKey, {
          repoKey,
          repoRootPath: snap.repoRoot,
          snap,
          tombstones: tbForRepo,
          memberProjects: []
        });
      }
      groupsByRepoKey.get(repoKey).memberProjects.push(proj);
    } else {
      ungroupedByProj.push(proj);
    }
  }

  // Map sessions to worktrees first (using longest-prefix) to count sessions & check tombstones
  const sessionWtMatch = new Map();
  const wtRuntimeStats = new Map(); // worktreeId -> { sessionCount, runningCount, needsAttentionCount }
  for (const s of (Array.isArray(sessions) ? sessions : [])) {
    if (!s || typeof s !== 'object') continue;
    const cid = String(s.cascadeId || s.id || '').trim();
    const binding = cid ? org.sessionWorktreeBindings?.[cid] : null;
    const rawWs = s.workspacePath || s.workspaceUri || binding?.workspacePath || binding?.workspaceUri || '';
    const matchedWt = rawWs ? matchWorktreeByLongestPrefix(rawWs, allKnownWorktrees) : null;
    if (!matchedWt) continue;
    if (cid) sessionWtMatch.set(cid, matchedWt);
    const archived = Boolean(s.archived || (cid && org.archivedSessions?.[cid]));
    if (archived) continue;
    let stat = wtRuntimeStats.get(matchedWt.worktreeId);
    if (!stat) {
      stat = { sessionCount: 0, runningCount: 0, needsAttentionCount: 0 };
      wtRuntimeStats.set(matchedWt.worktreeId, stat);
    }
    stat.sessionCount += 1;
    const stStr = String(s.status || '');
    if (s.isRunning || RUNNING_STATUS_RE.test(stStr) || s.notFullyIdle) {
      stat.runningCount += 1;
    }
    if (s.needsAttention || /PENDING|WAITING|ERROR/i.test(stStr)) {
      stat.needsAttentionCount += 1;
    }
  }

  const aggregatedProjects = [];

  for (const bucket of groupsByRepoKey.values()) {
    const mainKey = canonicalKey(bucket.repoRootPath);
    const primary = bucket.memberProjects.find((p) => {
      const pk = canonicalKey(canonicalizePath(p.rootPath || p.path || '') || '');
      return pk === mainKey;
    }) || bucket.memberProjects[0];

    const mergedIds = bucket.memberProjects.map((p) => p.id).filter(Boolean);
    for (const mid of mergedIds) {
      mergedIdToPrimaryId.set(mid, primary.id);
    }

    // Inherit groupId / pinned if primary lacked them while a merged worktree project had them
    let groupId = primary.groupId || null;
    let pinned = Boolean(primary.pinned);
    let totalSessions = 0;
    let latestMod = primary.lastModifiedTime || null;
    for (const mp of bucket.memberProjects) {
      if (!groupId && mp.groupId) groupId = mp.groupId;
      if (!pinned && mp.pinned) pinned = true;
      totalSessions += Number(mp.sessionCount || 0);
      if (mp.lastModifiedTime && (!latestMod || Date.parse(mp.lastModifiedTime) > Date.parse(latestMod))) {
        latestMod = mp.lastModifiedTime;
      }
    }

    // Keep tombstones only if they still have visible sessions
    const activeTombstones = bucket.tombstones.filter((tb) => {
      const st = wtRuntimeStats.get(tb.worktreeId);
      return st && st.sessionCount > 0;
    });

    const combinedRawWts = [...bucket.snap.worktrees, ...activeTombstones];
    const nonBareOrExtra = combinedRawWts.filter((wt) => !wt.bare || combinedRawWts.length > 1);
    const isMultiWorktree = nonBareOrExtra.length >= 2 || (bucket.snap.worktrees.length === 1 && bucket.snap.worktrees[0].bare === true);

    const enrichedWts = sortWorktreeSubgroups(combinedRawWts, wtRuntimeStats).map((wt) => {
      const st = wtRuntimeStats.get(wt.worktreeId) || { sessionCount: 0, runningCount: 0, needsAttentionCount: 0 };
      return {
        ...wt,
        collapsed: Boolean(collapsedWorktrees[wt.worktreeId]),
        sessionCount: st.sessionCount,
        runningCount: st.runningCount,
        needsAttentionCount: st.needsAttentionCount
      };
    });

    aggregatedProjects.push({
      ...primary,
      groupId,
      pinned,
      sessionCount: totalSessions,
      ...(latestMod ? { lastModifiedTime: latestMod } : {}),
      collapsed: Boolean(collapsedProjects[primary.id]),
      repoRootPath: bucket.repoRootPath,
      isMultiWorktree,
      worktrees: isMultiWorktree ? enrichedWts : [],
      ...(mergedIds.length > 1 ? { mergedProjectIds: mergedIds } : {})
    });
  }

  for (const proj of ungroupedByProj) {
    aggregatedProjects.push({
      ...proj,
      collapsed: Boolean(collapsedProjects[proj.id]),
      repoRootPath: proj.rootPath || proj.path || null,
      isMultiWorktree: false,
      worktrees: []
    });
  }

  return {
    projects: aggregatedProjects,
    allKnownWorktrees,
    sessionWtMatch,
    mergedIdToPrimaryId
  };
}

/**
 * Shared session organization core backed by `~/.agy-daddy/session-org.json` (Schema v2).
 */
function createSessionOrgCore(options = {}) {
  const explicitOrgPath = options.orgPath !== undefined
    ? options.orgPath
    : (process.env.AGY_DADDY_SESSION_ORG_PATH || '');
  const orgPath = explicitOrgPath
    ? path.resolve(explicitOrgPath)
    : (explicitOrgPath === null || isTestMode() ? null : path.join(os.homedir(), '.agy-daddy', 'session-org.json'));

  const explicitDbPath = options.dbPath !== undefined
    ? options.dbPath
    : (process.env.AGY_DADDY_CONVERSATION_DB_PATH || undefined);
  const dbPath = explicitDbPath !== undefined
    ? (explicitDbPath ? path.resolve(explicitDbPath) : null)
    : (isTestMode() ? null : path.join(os.homedir(), '.gemini', 'antigravity', 'conversation_summaries.db'));

  const getAllowedRoots = typeof options.getAllowedRoots === 'function' ? options.getAllowedRoots : () => [];
  const worktreeDiscovery = options.worktreeDiscovery || null;
  const resolveSessionContainer = typeof options.resolveSessionContainer === 'function' ? options.resolveSessionContainer : null;
  const pluginId = typeof options.pluginId === 'string' && options.pluginId.trim()
    ? options.pluginId.trim()
    : 'agy-daddy.host';
  const onOrgChanged = typeof options.onOrgChanged === 'function' ? options.onOrgChanged : null;
  const onExternalOrgChanged = typeof options.onExternalOrgChanged === 'function' ? options.onExternalOrgChanged : null;

  let memoryOrg = createEmptyPersistedOrg();
  let dbCache = { loadedAt: 0, rows: [] };
  let localLoadedRevision = 0;
  let fsWatcher = null;
  let watchDebounceTimer = null;
  const containerRevisions = new Map();

  function readDiskOrgRaw() {
    if (!orgPath || !fs.existsSync(orgPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(orgPath, 'utf8'));
    } catch {
      return null;
    }
  }

  function loadPersistedOrg() {
    if (!orgPath) {
      return sanitizePersistedOrg(memoryOrg);
    }
    const raw = readDiskOrgRaw();
    const org = raw ? sanitizePersistedOrg(raw) : createEmptyPersistedOrg();
    if (org.revision > localLoadedRevision) {
      localLoadedRevision = org.revision;
    }
    return org;
  }

  function mutateOrgAtomically(mutatorFn, opts = {}) {
    const updatedBy = opts.updatedBy || pluginId;
    const lockPath = orgPath ? `${orgPath}.lock` : null;
    if (lockPath) {
      acquireFileLockSync(lockPath);
    }
    try {
      const latest = loadPersistedOrg();
      const outcome = mutatorFn(latest);
      if (outcome && outcome.abort) {
        return outcome.result;
      }
      latest.revision = (Number.isInteger(latest.revision) ? latest.revision : 0) + 1;
      latest.updatedAt = new Date().toISOString();
      latest.updatedBy = updatedBy;
      const clean = sanitizePersistedOrg(latest);
      if (orgPath) {
        writeJsonAtomicSync(orgPath, clean);
      } else {
        memoryOrg = clean;
      }
      localLoadedRevision = clean.revision;
      if (opts.emitChange !== false && onOrgChanged) {
        try {
          onOrgChanged(clean, buildOrgBusSummary(clean, updatedBy));
        } catch {
          // Listener failure must not break storage mutation
        }
      }
      if (outcome && Object.prototype.hasOwnProperty.call(outcome, 'buildResult')) {
        return outcome.buildResult(clean);
      }
      return { ok: true, org: clean, revision: clean.revision };
    } finally {
      if (lockPath) {
        try { fs.unlinkSync(lockPath); } catch {}
      }
    }
  }

  function syncFromExternalSignal(payload = {}) {
    if (!orgPath) {
      const incomingRev = Number(payload?.revision || 0);
      if (incomingRev > localLoadedRevision) {
        localLoadedRevision = incomingRev;
        if (onExternalOrgChanged) {
          try {
            onExternalOrgChanged(loadPersistedOrg(), payload);
          } catch {}
        }
        return true;
      }
      return false;
    }
    const prevRev = localLoadedRevision;
    const disk = loadPersistedOrg();
    if (disk.revision > prevRev || Number(payload?.revision || 0) > prevRev) {
      localLoadedRevision = Math.max(prevRev, disk.revision);
      if (onExternalOrgChanged) {
        try {
          onExternalOrgChanged(disk, buildOrgBusSummary(disk, disk.updatedBy));
        } catch {}
      }
      return true;
    }
    return false;
  }

  function startWatching() {
    if (!orgPath || fsWatcher) return;
    if (isTestMode() && options.watchDisk !== true) return;
    try {
      const dir = path.dirname(orgPath);
      const base = path.basename(orgPath);
      fs.mkdirSync(dir, { recursive: true });
      fsWatcher = fs.watch(dir, { persistent: false }, (_eventType, filename) => {
        if (filename && String(filename) !== base) return;
        if (watchDebounceTimer) clearTimeout(watchDebounceTimer);
        watchDebounceTimer = setTimeout(() => {
          watchDebounceTimer = null;
          const prevRev = localLoadedRevision;
          const disk = loadPersistedOrg();
          if (disk.revision > prevRev && onExternalOrgChanged) {
            try {
              onExternalOrgChanged(disk, buildOrgBusSummary(disk, disk.updatedBy));
            } catch {}
          }
        }, WATCH_DEBOUNCE_MS);
        watchDebounceTimer.unref?.();
      });
      fsWatcher.unref?.();
    } catch {
      fsWatcher = null;
    }
  }

  function dispose() {
    if (watchDebounceTimer) {
      clearTimeout(watchDebounceTimer);
      watchDebounceTimer = null;
    }
    if (fsWatcher) {
      try { fsWatcher.close(); } catch {}
      fsWatcher = null;
    }
  }

  if (options.watchDisk === true || (!isTestMode() && orgPath)) {
    startWatching();
  }

  function materializeProjectInOrg(org, candidate = {}) {
    const normPath = normalizeLocalPath(candidate.rootPath || candidate.path || candidate.workspaceUri);
    const existing = findPersistedProject(org, {
      id: candidate.id,
      rootPath: normPath,
      workspaceUri: candidate.workspaceUri
    });

    if (existing) {
      const extraAliases = [];
      if (candidate.id && candidate.id !== existing.id) extraAliases.push(candidate.id);
      if (Array.isArray(candidate.aliases)) extraAliases.push(...candidate.aliases);
      const mergedAliases = computeKnownAliasesForPath(existing.rootPath, [...(existing.aliases || []), ...extraAliases])
        .filter((a) => a !== existing.id);
      existing.aliases = mergedAliases;
      for (const alias of mergedAliases) {
        remapProjectIdReferences(org, alias, existing.id);
      }
      return existing;
    }

    if (!normPath) return null;

    const rawId = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const stableId = rawId || makeStableProjectId(normPath);
    const aliases = computeKnownAliasesForPath(normPath, Array.isArray(candidate.aliases) ? candidate.aliases : [])
      .filter((a) => a !== stableId);

    const nowIso = new Date().toISOString();
    const gid = typeof candidate.groupId === 'string' && org.groups.some((g) => g.id === candidate.groupId.trim())
      ? candidate.groupId.trim()
      : null;

    const entry = {
      id: stableId,
      aliases,
      name: String(candidate.name || path.basename(normPath) || stableId).trim() || stableId,
      rootPath: normPath,
      uri: pathToFileUri(normPath) || '',
      groupId: gid,
      source: typeof candidate.source === 'string' && candidate.source.trim()
        ? candidate.source.trim()
        : (candidate.syncedFromApp ? 'app' : 'local'),
      syncedFromApp: Boolean(candidate.syncedFromApp),
      ...(sanitizeRemoteMeta(candidate.remote) ? { remote: sanitizeRemoteMeta(candidate.remote) } : {}),
      createdAt: typeof candidate.createdAt === 'string' && candidate.createdAt.trim() ? candidate.createdAt.trim() : nowIso,
      updatedAt: nowIso
    };
    org.projects.push(entry);

    for (const alias of aliases) {
      remapProjectIdReferences(org, alias, entry.id);
    }
    if (org.projectGroupMap[entry.id] && !entry.groupId) {
      const mappedGid = org.projectGroupMap[entry.id];
      if (org.groups.some((g) => g.id === mappedGid)) entry.groupId = mappedGid;
      else delete org.projectGroupMap[entry.id];
    } else if (entry.groupId) {
      org.projectGroupMap[entry.id] = entry.groupId;
    }
    if (entry.groupId) {
      const grp = org.groups.find((g) => g.id === entry.groupId);
      if (grp && !grp.projectIds.includes(entry.id)) {
        grp.projectIds.push(entry.id);
      }
    }
    return entry;
  }

  function migrateWorkspaceMetaV1(legacyMeta) {
    if (!isPlainObject(legacyMeta)) {
      return { ok: true, migrated: false };
    }
    const hasLegacyContent = (
      (Array.isArray(legacyMeta.projects) && legacyMeta.projects.length > 0)
      || (Array.isArray(legacyMeta.groups) && legacyMeta.groups.length > 0)
      || (isPlainObject(legacyMeta.pinnedSessions) && Object.keys(legacyMeta.pinnedSessions).length > 0)
      || (isPlainObject(legacyMeta.sessionProjectOverrides) && Object.keys(legacyMeta.sessionProjectOverrides).length > 0)
      || (typeof legacyMeta.defaultSessionPath === 'string' && legacyMeta.defaultSessionPath.trim().length > 0)
    );
    if (!hasLegacyContent) {
      return { ok: true, migrated: false };
    }

    const current = loadPersistedOrg();
    if (current.migrations?.workspaceMetaV1At) {
      return { ok: true, migrated: false, alreadyMigratedAt: current.migrations.workspaceMetaV1At };
    }

    if (orgPath && fs.existsSync(orgPath)) {
      const rawDisk = readDiskOrgRaw();
      const bakPath = orgPath.replace(/\.json$/i, '.v1.bak.json');
      if (rawDisk && (rawDisk.version === 1 || rawDisk.version === undefined) && !fs.existsSync(bakPath)) {
        try {
          writeJsonAtomicSync(bakPath, rawDisk);
        } catch {}
      }
    }

    return mutateOrgAtomically((org) => {
      if (org.migrations?.workspaceMetaV1At) {
        return { abort: true, result: { ok: true, migrated: false, alreadyMigratedAt: org.migrations.workspaceMetaV1At } };
      }

      const nowIso = new Date().toISOString();
      if (!org.defaultSessionPath && typeof legacyMeta.defaultSessionPath === 'string' && legacyMeta.defaultSessionPath.trim()) {
        const normDef = normalizeLocalPath(legacyMeta.defaultSessionPath);
        if (normDef) org.defaultSessionPath = normDef;
      }

      if (Array.isArray(legacyMeta.groups)) {
        const orderedLegacyGroups = [...legacyMeta.groups].sort(
          (a, b) => (Number(a?.sortOrder ?? a?.order ?? 0) - Number(b?.sortOrder ?? b?.order ?? 0))
        );
        for (const lg of orderedLegacyGroups) {
          if (!isPlainObject(lg) || !String(lg.id || '').trim()) continue;
          const gid = String(lg.id).trim();
          const existingIdx = org.groups.findIndex((g) => g.id === gid);
          if (existingIdx >= 0) {
            org.groups[existingIdx] = {
              ...org.groups[existingIdx],
              collapsed: Boolean(lg.collapsed ?? org.groups[existingIdx].collapsed),
              name: String(lg.name || org.groups[existingIdx].name).trim() || org.groups[existingIdx].name
            };
          } else {
            org.groups.push({
              id: gid,
              name: String(lg.name || gid).trim() || gid,
              source: 'user',
              collapsed: Boolean(lg.collapsed),
              order: Number.isFinite(Number(lg.sortOrder ?? lg.order)) ? Number(lg.sortOrder ?? lg.order) : org.groups.length,
              projectIds: [],
              workspaceUris: [],
              sessionIds: [],
              createdAt: lg.createdAt || nowIso,
              updatedAt: lg.updatedAt || nowIso
            });
          }
          if (org.pins.groups.includes(gid)) {
            if (!org.groupOrder.pinned.includes(gid)) org.groupOrder.pinned.push(gid);
          } else if (!org.groupOrder.normal.includes(gid)) {
            org.groupOrder.normal.push(gid);
          }
        }
      }

      const legacyProjectIdMap = new Map();
      if (Array.isArray(legacyMeta.projects)) {
        for (const lp of legacyMeta.projects) {
          if (!isPlainObject(lp) || !String(lp.id || '').trim()) continue;
          const normRoot = normalizeLocalPath(lp.rootPath);
          if (!normRoot) continue;
          const existing = findPersistedProject(org, { id: lp.id, rootPath: normRoot });
          if (existing) {
            legacyProjectIdMap.set(lp.id, existing.id);
            existing.name = String(lp.name || existing.name).trim() || existing.name;
            if (lp.groupId && org.groups.some((g) => g.id === lp.groupId)) {
              existing.groupId = lp.groupId;
              org.projectGroupMap[existing.id] = lp.groupId;
            }
            const extraAliases = computeKnownAliasesForPath(normRoot, [lp.id, ...(existing.aliases || [])])
              .filter((a) => a !== existing.id);
            existing.aliases = extraAliases;
            for (const alias of extraAliases) {
              remapProjectIdReferences(org, alias, existing.id);
            }
          } else {
            const materialized = materializeProjectInOrg(org, {
              id: lp.id,
              name: lp.name,
              rootPath: normRoot,
              groupId: lp.groupId || null,
              source: lp.source || (lp.syncedFromApp ? 'app' : 'local'),
              syncedFromApp: Boolean(lp.syncedFromApp),
              createdAt: lp.createdAt,
              updatedAt: lp.updatedAt
            });
            if (materialized) {
              legacyProjectIdMap.set(lp.id, materialized.id);
            }
          }
        }
      }

      if (isPlainObject(legacyMeta.pinnedSessions)) {
        for (const [cid, entry] of Object.entries(legacyMeta.pinnedSessions)) {
          const cleanCid = String(cid || '').trim();
          if (!cleanCid || !isPlainObject(entry)) continue;
          if (!org.pins.sessions.includes(cleanCid)) {
            org.pins.sessions.push(cleanCid);
          }
          if (typeof entry.pinnedAt === 'string' && entry.pinnedAt.trim()) {
            org.pinTimestamps.sessions[cleanCid] = entry.pinnedAt.trim();
          }
        }
      }

      if (isPlainObject(legacyMeta.sessionProjectOverrides)) {
        for (const [cid, pid] of Object.entries(legacyMeta.sessionProjectOverrides)) {
          const cleanCid = String(cid || '').trim();
          if (!cleanCid) continue;
          if (Object.prototype.hasOwnProperty.call(org.sessionProjectOverrides, cleanCid)) continue;
          if (pid === null) {
            org.sessionProjectOverrides[cleanCid] = null;
          } else if (typeof pid === 'string' && pid.trim()) {
            const cleanPid = pid.trim();
            org.sessionProjectOverrides[cleanCid] = legacyProjectIdMap.get(cleanPid) || cleanPid;
          }
        }
      }

      org.migrations = {
        ...org.migrations,
        workspaceMetaV1At: nowIso
      };

      return {
        buildResult: (saved) => ({ ok: true, migrated: true, revision: saved.revision, org: saved })
      };
    });
  }

  function buildOrgSnapshot(org, { includeArchived = false } = {}) {
    const pinnedGroupsSet = new Set(org.pins.groups);
    const pinnedProjectsSet = new Set(org.pins.projects);
    const collapsedProjects = org.collapsedNodes?.projects || {};
    const enrichedGroups = org.groups.map((g) => ({
      ...g,
      pinned: pinnedGroupsSet.has(g.id)
    }));
    const rawProjects = org.projects.map((p) => ({
      ...p,
      groupId: org.projectGroupMap[p.id] ?? p.groupId ?? null,
      pinned: pinnedProjectsSet.has(p.id),
      collapsed: Boolean(collapsedProjects[p.id])
    }));
    const agg = worktreeDiscovery
      ? aggregateWorktreeProjects({ projects: rawProjects, persistedOrg: org, worktreeDiscovery })
      : {
          projects: rawProjects.map((p) => ({
            ...p,
            repoRootPath: p.rootPath || null,
            isMultiWorktree: false,
            worktrees: []
          }))
        };
    const out = {
      ok: true,
      version: 2,
      revision: org.revision,
      updatedAt: org.updatedAt,
      defaultSessionPath: org.defaultSessionPath || path.join(os.homedir(), 'antigravity-workspace'),
      groups: enrichedGroups,
      projects: agg.projects,
      collapsedNodes: org.collapsedNodes || { projects: {}, worktrees: {} },
      pins: org.pins,
      pinTimestamps: org.pinTimestamps,
      projectGroupMap: org.projectGroupMap,
      sessionGroupMap: org.sessionGroupMap,
      sessionProjectOverrides: org.sessionProjectOverrides,
      groupOrder: org.groupOrder,
      projectOrder: org.projectOrder,
      sessionOrder: org.sessionOrder,
      worktreeTombstones: org.worktreeTombstones || {},
      archivedCount: Object.keys(org.archivedSessions || {}).length
    };
    if (includeArchived) {
      out.archivedSessions = org.archivedSessions;
    }
    return out;
  }

  function togglePin({ type, id, pinned, workspaceUri, rootPath, projectName } = {}) {
    const cleanType = String(type || '').trim().toLowerCase();
    const cleanId = String(id || '').trim();
    const bucketMap = {
      session: 'sessions',
      sessions: 'sessions',
      project: 'projects',
      projects: 'projects',
      group: 'groups',
      groups: 'groups'
    };
    const bucketKey = bucketMap[cleanType];
    if (!bucketKey || !cleanId) {
      return { ok: false, statusCode: 400, error: 'INVALID_PIN_PARAMS' };
    }

    return mutateOrgAtomically((org) => {
      if (bucketKey === 'sessions') {
        if (org.deletedSessions[cleanId]) {
          return { abort: true, result: { ok: false, statusCode: 404, error: 'SESSION_NOT_FOUND' } };
        }
        const willPin = typeof pinned === 'boolean' ? pinned : !org.pins.sessions.includes(cleanId);
        if (willPin && org.archivedSessions[cleanId]) {
          return { abort: true, result: { ok: false, statusCode: 409, error: 'SESSION_ARCHIVED' } };
        }
      }

      let resolvedId = cleanId;
      if (bucketKey === 'projects') {
        let proj = findPersistedProject(org, { id: cleanId, rootPath, workspaceUri });
        if (!proj && (rootPath || workspaceUri)) {
          proj = materializeProjectInOrg(org, {
            id: cleanId,
            rootPath,
            workspaceUri,
            name: projectName,
            syncedFromApp: cleanId.startsWith('app:'),
            source: cleanId.startsWith('app:') ? 'app' : (cleanId.startsWith('implicit:') ? 'implicit' : 'local')
          });
        }
        if (proj) {
          resolvedId = proj.id;
        }
      }

      const list = org.pins[bucketKey] || [];
      const exists = list.includes(resolvedId);
      const nextPinned = typeof pinned === 'boolean' ? pinned : !exists;
      const nowIso = new Date().toISOString();

      if (nextPinned && !exists) {
        list.push(resolvedId);
        org.pinTimestamps[bucketKey][resolvedId] = nowIso;
      } else if (!nextPinned && exists) {
        org.pins[bucketKey] = list.filter((x) => x !== resolvedId);
        delete org.pinTimestamps[bucketKey][resolvedId];
      } else {
        org.pins[bucketKey] = list;
        if (nextPinned && !org.pinTimestamps[bucketKey][resolvedId]) {
          org.pinTimestamps[bucketKey][resolvedId] = nowIso;
        }
      }

      if (bucketKey === 'groups') {
        org.groupOrder.pinned = removeFromOrderArray(org.groupOrder.pinned, resolvedId);
        org.groupOrder.normal = removeFromOrderArray(org.groupOrder.normal, resolvedId);
        if (nextPinned && org.groupOrder.pinned.length > 0) org.groupOrder.pinned.push(resolvedId);
        if (!nextPinned && org.groupOrder.normal.length > 0) org.groupOrder.normal.unshift(resolvedId);
      } else if (bucketKey === 'projects') {
        const gid = org.projectGroupMap[resolvedId] || '__ungrouped__';
        const ord = org.projectOrder[gid];
        if (ord) {
          ord.pinned = removeFromOrderArray(ord.pinned, resolvedId);
          ord.normal = removeFromOrderArray(ord.normal, resolvedId);
          if (nextPinned && ord.pinned.length > 0) ord.pinned.push(resolvedId);
          if (!nextPinned && ord.normal.length > 0) ord.normal.unshift(resolvedId);
        }
      } else if (bucketKey === 'sessions') {
        if (Array.isArray(org.sessionOrder.__pinned__)) {
          org.sessionOrder.__pinned__ = removeFromOrderArray(org.sessionOrder.__pinned__, resolvedId);
          if (nextPinned) org.sessionOrder.__pinned__.unshift(resolvedId);
        }
        for (const [ck, ord] of Object.entries(org.sessionOrder)) {
          if (ck === '__pinned__' || !isPlainObject(ord)) continue;
          const had = (ord.pinned || []).includes(resolvedId) || (ord.normal || []).includes(resolvedId);
          if (!had) continue;
          ord.pinned = removeFromOrderArray(ord.pinned, resolvedId);
          ord.normal = removeFromOrderArray(ord.normal, resolvedId);
          if (nextPinned) ord.pinned.push(resolvedId);
          else ord.normal.unshift(resolvedId);
        }
      }

      return {
        buildResult: (saved) => ({
          ok: true,
          type: bucketKey.slice(0, -1),
          id: resolvedId,
          pinned: nextPinned,
          pinnedAt: saved.pinTimestamps[bucketKey][resolvedId] || null,
          pins: saved.pins,
          pinTimestamps: saved.pinTimestamps,
          revision: saved.revision
        })
      };
    });
  }

  function mutateGroup(body = {}) {
    if (!isPlainObject(body)) {
      return { ok: false, statusCode: 400, error: 'INVALID_GROUP_BODY' };
    }
    const action = String(body.action || 'upsert').trim().toLowerCase();

    return mutateOrgAtomically((org) => {
      if (action === 'delete') {
        const id = String(body.id || '').trim();
        if (!id) return { abort: true, result: { ok: false, statusCode: 400, error: 'MISSING_GROUP_ID' } };

        const targetGroup = org.groups.find((g) => g.id === id) || null;
        const prevOrd = org.projectOrder[id] || { pinned: [], normal: [] };
        const orderedIds = [...(prevOrd.pinned || []), ...(prevOrd.normal || [])];
        const memberSet = new Set(orderedIds);
        for (const [pid, gid] of Object.entries(org.projectGroupMap)) {
          if (gid === id) memberSet.add(pid);
        }
        for (const p of org.projects) {
          if (p.groupId === id) memberSet.add(p.id);
        }
        for (const pid of (targetGroup?.projectIds || [])) {
          memberSet.add(pid);
        }

        const movedProjectIds = dedupeStrings([
          ...orderedIds.filter((pid) => memberSet.has(pid)),
          ...Array.from(memberSet)
        ]);
        const pinnedProjectsSet = new Set(org.pins.projects);
        const movedPinned = movedProjectIds.filter((pid) => pinnedProjectsSet.has(pid));
        const movedNormal = movedProjectIds.filter((pid) => !pinnedProjectsSet.has(pid));

        if (!org.projectOrder.__ungrouped__) {
          org.projectOrder.__ungrouped__ = { pinned: [], normal: [] };
        }
        org.projectOrder.__ungrouped__.pinned = dedupeStrings([...org.projectOrder.__ungrouped__.pinned, ...movedPinned]);
        org.projectOrder.__ungrouped__.normal = dedupeStrings([...org.projectOrder.__ungrouped__.normal, ...movedNormal]);
        delete org.projectOrder[id];

        org.groups = org.groups.filter((g) => g.id !== id);
        org.pins.groups = org.pins.groups.filter((gid) => gid !== id);
        delete org.pinTimestamps.groups[id];
        org.groupOrder.pinned = removeFromOrderArray(org.groupOrder.pinned, id);
        org.groupOrder.normal = removeFromOrderArray(org.groupOrder.normal, id);

        for (const [k, v] of Object.entries(org.projectGroupMap)) {
          if (v === id) delete org.projectGroupMap[k];
        }
        for (const p of org.projects) {
          if (p.groupId === id) p.groupId = null;
        }
        for (const [k, v] of Object.entries(org.sessionGroupMap)) {
          if (v === id) delete org.sessionGroupMap[k];
        }

        return {
          buildResult: (saved) => ({
            ok: true,
            action: 'delete',
            id,
            movedProjectCount: movedProjectIds.length,
            movedProjectIds,
            groups: saved.groups,
            projectOrder: saved.projectOrder,
            pins: saved.pins,
            revision: saved.revision
          })
        };
      }

      if (action === 'assign') {
        const groupId = body.groupId ? String(body.groupId).trim() : null;
        let projectId = body.projectId ? String(body.projectId).trim() : '';
        const sessionId = body.sessionId ? String(body.sessionId).trim() : '';
        const workspaceUri = body.workspaceUri ? String(body.workspaceUri).trim() : '';
        const rootPath = body.rootPath ? String(body.rootPath).trim() : '';
        if (!projectId && !sessionId && !workspaceUri && !rootPath) {
          return { abort: true, result: { ok: false, statusCode: 400, error: 'MISSING_ASSIGN_TARGET' } };
        }
        if (groupId && !org.groups.some((g) => g.id === groupId)) {
          return { abort: true, result: { ok: false, statusCode: 404, error: 'GROUP_NOT_FOUND' } };
        }
        if (projectId || rootPath || workspaceUri) {
          let proj = findPersistedProject(org, { id: projectId, rootPath, workspaceUri });
          if (!proj && (rootPath || workspaceUri)) {
            proj = materializeProjectInOrg(org, { id: projectId, rootPath, workspaceUri });
          }
          if (proj) projectId = proj.id;
        }
        if (projectId) {
          const prevGid = org.projectGroupMap[projectId] || '__ungrouped__';
          if (groupId) org.projectGroupMap[projectId] = groupId;
          else delete org.projectGroupMap[projectId];
          for (const p of org.projects) {
            if (p.id === projectId) {
              p.groupId = groupId;
              p.updatedAt = new Date().toISOString();
            }
          }
          for (const g of org.groups) {
            g.projectIds = g.projectIds.filter((p) => p !== projectId);
            if (groupId && g.id === groupId) g.projectIds.push(projectId);
          }
          const nextGid = groupId || '__ungrouped__';
          if (prevGid !== nextGid) {
            const isPinned = org.pins.projects.includes(projectId);
            if (org.projectOrder[prevGid]) {
              org.projectOrder[prevGid].pinned = removeFromOrderArray(org.projectOrder[prevGid].pinned, projectId);
              org.projectOrder[prevGid].normal = removeFromOrderArray(org.projectOrder[prevGid].normal, projectId);
            }
            if (org.projectOrder[nextGid]) {
              if (isPinned) org.projectOrder[nextGid].pinned.push(projectId);
              else org.projectOrder[nextGid].normal.unshift(projectId);
            }
          }
        }
        if (sessionId) {
          if (groupId) org.sessionGroupMap[sessionId] = groupId;
          else delete org.sessionGroupMap[sessionId];
          for (const g of org.groups) {
            g.sessionIds = g.sessionIds.filter((s) => s !== sessionId);
            if (groupId && g.id === groupId) g.sessionIds.push(sessionId);
          }
        }
        if (workspaceUri) {
          const normPath = normalizeUriToPath(workspaceUri);
          for (const g of org.groups) {
            g.workspaceUris = g.workspaceUris.filter((u) => normalizeUriToPath(u) !== normPath);
            if (groupId && g.id === groupId) g.workspaceUris.push(workspaceUri);
          }
        }
        return {
          buildResult: (saved) => ({
            ok: true,
            action: 'assign',
            groupId,
            projectId: projectId || undefined,
            groups: saved.groups,
            pins: saved.pins,
            revision: saved.revision
          })
        };
      }

      const hasName = Object.prototype.hasOwnProperty.call(body, 'name');
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const id = String(body.id || '').trim() || `grp_${crypto.randomBytes(4).toString('hex')}`;
      const existingIdx = org.groups.findIndex((g) => g.id === id);
      if ((existingIdx < 0 || hasName) && (name.length < 1 || name.length > 64)) {
        return { abort: true, result: { ok: false, statusCode: 400, error: 'INVALID_GROUP_NAME' } };
      }
      const prev = existingIdx >= 0 ? org.groups[existingIdx] : null;
      const nowIso = new Date().toISOString();
      const nextGroup = {
        id,
        name: name || prev?.name || id,
        source: prev?.source || 'user',
        collapsed: typeof body.collapsed === 'boolean' ? body.collapsed : Boolean(prev?.collapsed),
        order: Number.isFinite(Number(body.order)) ? Number(body.order) : (prev ? prev.order : org.groups.length),
        projectIds: Array.isArray(body.projectIds) ? dedupeStrings(body.projectIds) : (prev?.projectIds || []),
        workspaceUris: Array.isArray(body.workspaceUris) ? dedupeStrings(body.workspaceUris) : (prev?.workspaceUris || []),
        sessionIds: Array.isArray(body.sessionIds) ? dedupeStrings(body.sessionIds) : (prev?.sessionIds || []),
        createdAt: prev?.createdAt || nowIso,
        updatedAt: nowIso
      };
      if (existingIdx >= 0) {
        org.groups[existingIdx] = nextGroup;
      } else {
        org.groups.push(nextGroup);
        if (org.groupOrder.normal.length > 0 && !org.groupOrder.normal.includes(id)) {
          org.groupOrder.normal.push(id);
        }
      }
      for (const pid of nextGroup.projectIds) {
        org.projectGroupMap[pid] = id;
        const pObj = org.projects.find((p) => p.id === pid);
        if (pObj) pObj.groupId = id;
      }
      for (const sid of nextGroup.sessionIds) org.sessionGroupMap[sid] = id;
      return {
        buildResult: (saved) => ({
          ok: true,
          action: 'upsert',
          group: nextGroup,
          groups: saved.groups,
          pins: saved.pins,
          revision: saved.revision
        })
      };
    });
  }

  function setNodeCollapsed(body = {}) {
    if (!isPlainObject(body)) {
      return { ok: false, statusCode: 400, error: 'INVALID_COLLAPSE_BODY' };
    }
    const nodeType = String(body.nodeType || '').trim().toLowerCase();
    const cleanId = String(body.id ?? body.nodeId ?? '').trim();
    if (!['group', 'project', 'worktree'].includes(nodeType)) {
      return { ok: false, statusCode: 400, error: 'INVALID_NODE_TYPE' };
    }
    if (!cleanId) {
      return { ok: false, statusCode: 400, error: 'MISSING_NODE_ID' };
    }
    if (typeof body.collapsed !== 'boolean') {
      return { ok: false, statusCode: 400, error: 'INVALID_COLLAPSED_FLAG' };
    }
    const collapsed = body.collapsed;

    return mutateOrgAtomically((org) => {
      if (nodeType === 'group') {
        const idx = org.groups.findIndex((g) => g.id === cleanId);
        if (idx < 0) {
          return { abort: true, result: { ok: false, statusCode: 404, error: 'GROUP_NOT_FOUND' } };
        }
        org.groups[idx] = {
          ...org.groups[idx],
          collapsed,
          updatedAt: new Date().toISOString()
        };
      } else {
        const bucket = nodeType === 'project' ? 'projects' : 'worktrees';
        if (!org.collapsedNodes) org.collapsedNodes = { projects: {}, worktrees: {} };
        let resolvedId = cleanId;
        if (nodeType === 'project') {
          const found = findPersistedProject(org, { id: cleanId });
          if (found) resolvedId = found.id;
        }
        if (collapsed) {
          org.collapsedNodes[bucket][resolvedId] = true;
        } else {
          delete org.collapsedNodes[bucket][resolvedId];
        }
      }

      return {
        buildResult: (saved) => ({
          ok: true,
          nodeType,
          id: cleanId,
          collapsed,
          collapsedNodes: saved.collapsedNodes,
          groups: saved.groups,
          revision: saved.revision
        })
      };
    });
  }

  function bindSessionWorkspace(cascadeId, { projectId = null, worktreeId = null, workspacePath = '', workspaceUri = '' } = {}) {
    const cleanCid = String(cascadeId || '').trim();
    if (!cleanCid) {
      return { ok: false, statusCode: 400, error: 'INVALID_CASCADE_ID' };
    }
    const normPath = normalizeLocalPath(workspacePath || workspaceUri);
    const cleanUri = typeof workspaceUri === 'string' && workspaceUri.trim()
      ? workspaceUri.trim()
      : (normPath ? pathToFileUri(normPath) : '');
    const resolvedWtId = (typeof worktreeId === 'string' && worktreeId.trim())
      ? worktreeId.trim()
      : (normPath ? makeWorktreeId(normPath) : null);

    return mutateOrgAtomically((org) => {
      if (!org.sessionWorktreeBindings) org.sessionWorktreeBindings = {};
      if (normPath || cleanUri) {
        org.sessionWorktreeBindings[cleanCid] = {
          projectId: projectId ? String(projectId).trim() : null,
          worktreeId: resolvedWtId,
          workspacePath: normPath || '',
          workspaceUri: cleanUri || ''
        };
      }
      if (projectId) {
        org.sessionProjectOverrides[cleanCid] = String(projectId).trim();
      }
      return {
        buildResult: (saved) => ({
          ok: true,
          cascadeId: cleanCid,
          binding: saved.sessionWorktreeBindings[cleanCid] || null,
          revision: saved.revision
        })
      };
    });
  }

  function syncWorktreeTopology({ repoProjectId, mainWorktreeId, isMultiWorktree, missingWorktrees = [] } = {}) {
    const cleanProjId = String(repoProjectId || '').trim();
    const cleanMainWtId = String(mainWorktreeId || '').trim();
    const current = loadPersistedOrg();

    let needsMutation = false;
    if (isMultiWorktree && cleanProjId && cleanMainWtId) {
      if (!current.sessionOrder[cleanMainWtId] && current.sessionOrder[cleanProjId]) {
        needsMutation = true;
      }
    } else if (!isMultiWorktree && cleanProjId && cleanMainWtId) {
      if (current.sessionOrder[cleanMainWtId] && !current.sessionOrder[cleanProjId]) {
        needsMutation = true;
      }
    }
    for (const tb of missingWorktrees) {
      if (tb?.worktreeId && tb?.repoRootPath && tb?.path && !current.worktreeTombstones[tb.worktreeId]) {
        needsMutation = true;
      }
    }
    if (!needsMutation) return { ok: true, changed: false };

    return mutateOrgAtomically((org) => {
      if (isMultiWorktree && cleanProjId && cleanMainWtId && !org.sessionOrder[cleanMainWtId] && org.sessionOrder[cleanProjId]) {
        org.sessionOrder[cleanMainWtId] = sanitizeZoneOrder(org.sessionOrder[cleanProjId]);
      } else if (!isMultiWorktree && cleanProjId && cleanMainWtId && org.sessionOrder[cleanMainWtId]) {
        const wtOrd = org.sessionOrder[cleanMainWtId];
        const projOrd = org.sessionOrder[cleanProjId] || { pinned: [], normal: [] };
        org.sessionOrder[cleanProjId] = {
          pinned: dedupeStrings([...wtOrd.pinned, ...projOrd.pinned]),
          normal: dedupeStrings([...wtOrd.normal, ...projOrd.normal])
        };
      }
      for (const tb of missingWorktrees) {
        if (tb?.worktreeId && tb?.repoRootPath && tb?.path && !org.worktreeTombstones[tb.worktreeId]) {
          org.worktreeTombstones[tb.worktreeId] = {
            repoRootPath: tb.repoRootPath,
            path: tb.path,
            branch: tb.branch || '',
            lastSeenAt: new Date().toISOString()
          };
        }
      }
      return { buildResult: (saved) => ({ ok: true, changed: true, revision: saved.revision }) };
    }, { emitChange: false });
  }

  function reorderOrg(body = {}) {
    if (!isPlainObject(body)) {
      return { ok: false, statusCode: 400, error: 'INVALID_REORDER_BODY' };
    }
    const targetType = String(body.targetType || '').trim();
    const zone = String(body.zone || '').trim();
    const containerId = body.containerId !== undefined && body.containerId !== null
      ? String(body.containerId).trim()
      : (targetType === 'project' ? '__ungrouped__' : (targetType === 'session' ? '__standalone__' : '__groups__'));
    const rawOrderedIds = Array.isArray(body.orderedIds) ? dedupeStrings(body.orderedIds) : null;
    const expectedRevision = Number.isInteger(Number(body.expectedRevision)) ? Number(body.expectedRevision) : null;
    const movedProject = isPlainObject(body.movedProject) ? body.movedProject : null;
    const sessionContainers = isPlainObject(body.sessionContainers) ? body.sessionContainers : null;

    if (!['group', 'project', 'session'].includes(targetType)) {
      return { ok: false, statusCode: 400, error: 'INVALID_TARGET_TYPE' };
    }
    if (!['pinned', 'normal'].includes(zone)) {
      return { ok: false, statusCode: 400, error: 'INVALID_ZONE' };
    }
    if (!rawOrderedIds) {
      return { ok: false, statusCode: 400, error: 'INVALID_ORDERED_IDS' };
    }

    const containerKey = `${targetType}:${containerId}:${zone}`;

    return mutateOrgAtomically((org) => {
      if (expectedRevision !== null && expectedRevision < org.revision) {
        const lastContRev = containerRevisions.get(containerKey) || 0;
        if (lastContRev > expectedRevision) {
          return {
            abort: true,
            result: {
              ok: false,
              statusCode: 409,
              error: 'REVISION_CONFLICT',
              revision: org.revision,
              org: buildOrgSnapshot(org)
            }
          };
        }
      }

      if (targetType === 'group') {
        const pinnedSet = new Set(org.pins.groups);
        for (const id of rawOrderedIds) {
          if (pinnedSet.has(id) !== (zone === 'pinned')) {
            return {
              abort: true,
              result: {
                ok: false,
                statusCode: 409,
                error: 'ZONE_PIN_MISMATCH',
                id,
                zone,
                revision: org.revision,
                org: buildOrgSnapshot(org)
              }
            };
          }
        }
        org.groupOrder[zone] = rawOrderedIds;
        const fullSeq = [...org.groupOrder.pinned, ...org.groupOrder.normal];
        for (const g of org.groups) {
          const pos = fullSeq.indexOf(g.id);
          if (pos >= 0) g.order = pos;
        }
        return {
          buildResult: (saved) => {
            containerRevisions.set(containerKey, saved.revision);
            return { ok: true, revision: saved.revision, org: buildOrgSnapshot(saved) };
          }
        };
      }

      if (targetType === 'project') {
        let movedCanonicalId = '';
        let toGroupId = containerId === '__ungrouped__' ? null : containerId;
        if (movedProject) {
          const rawToGid = movedProject.toGroupId === undefined ? toGroupId : movedProject.toGroupId;
          toGroupId = rawToGid && String(rawToGid).trim() && String(rawToGid).trim() !== '__ungrouped__'
            ? String(rawToGid).trim()
            : null;
          if (toGroupId && !org.groups.some((g) => g.id === toGroupId)) {
            return { abort: true, result: { ok: false, statusCode: 404, error: 'GROUP_NOT_FOUND' } };
          }
          const rawPid = String(movedProject.projectId || '').trim();
          const wsUri = movedProject.workspaceUri ? String(movedProject.workspaceUri).trim() : '';
          let proj = findPersistedProject(org, { id: rawPid, workspaceUri: wsUri });
          if (!proj && wsUri) {
            proj = materializeProjectInOrg(org, {
              id: rawPid,
              workspaceUri: wsUri,
              syncedFromApp: rawPid.startsWith('app:'),
              source: rawPid.startsWith('app:') ? 'app' : (rawPid.startsWith('implicit:') ? 'implicit' : 'local')
            });
          }
          movedCanonicalId = proj ? proj.id : rawPid;
          if (!movedCanonicalId) {
            return { abort: true, result: { ok: false, statusCode: 400, error: 'MISSING_MOVED_PROJECT' } };
          }
          const fromGroupId = movedProject.fromGroupId ? String(movedProject.fromGroupId).trim() : (org.projectGroupMap[movedCanonicalId] || null);
          const fromKey = fromGroupId || '__ungrouped__';
          if (org.projectOrder[fromKey]) {
            org.projectOrder[fromKey].pinned = removeFromOrderArray(org.projectOrder[fromKey].pinned, movedCanonicalId);
            org.projectOrder[fromKey].normal = removeFromOrderArray(org.projectOrder[fromKey].normal, movedCanonicalId);
          }
          if (toGroupId) org.projectGroupMap[movedCanonicalId] = toGroupId;
          else delete org.projectGroupMap[movedCanonicalId];
          for (const p of org.projects) {
            if (p.id === movedCanonicalId) {
              p.groupId = toGroupId;
              p.updatedAt = new Date().toISOString();
            }
          }
          for (const g of org.groups) {
            g.projectIds = g.projectIds.filter((p) => p !== movedCanonicalId);
            if (toGroupId && g.id === toGroupId) g.projectIds.push(movedCanonicalId);
          }
        }

        const targetContainer = toGroupId || '__ungrouped__';
        if (targetContainer !== '__ungrouped__' && !org.groups.some((g) => g.id === targetContainer)) {
          return { abort: true, result: { ok: false, statusCode: 404, error: 'GROUP_NOT_FOUND' } };
        }

        const normalizedIds = rawOrderedIds.map((id) => {
          const found = findPersistedProject(org, { id });
          return found ? found.id : id;
        });
        if (movedCanonicalId && !normalizedIds.includes(movedCanonicalId)) {
          normalizedIds.push(movedCanonicalId);
        }

        const pinnedSet = new Set(org.pins.projects);
        for (const id of normalizedIds) {
          if (pinnedSet.has(id) !== (zone === 'pinned')) {
            return {
              abort: true,
              result: {
                ok: false,
                statusCode: 409,
                error: 'ZONE_PIN_MISMATCH',
                id,
                zone,
                revision: org.revision,
                org: buildOrgSnapshot(org)
              }
            };
          }
        }

        if (!org.projectOrder[targetContainer]) {
          org.projectOrder[targetContainer] = { pinned: [], normal: [] };
        }
        org.projectOrder[targetContainer][zone] = dedupeStrings(normalizedIds);

        return {
          buildResult: (saved) => {
            containerRevisions.set(containerKey, saved.revision);
            return { ok: true, revision: saved.revision, org: buildOrgSnapshot(saved) };
          }
        };
      }

      // targetType === 'session'
      const pinnedSet = new Set(org.pins.sessions);
      if (containerId === '__pinned__' && zone !== 'pinned') {
        return {
          abort: true,
          result: {
            ok: false,
            statusCode: 409,
            error: 'ZONE_PIN_MISMATCH',
            zone,
            revision: org.revision,
            org: buildOrgSnapshot(org)
          }
        };
      }
      for (const id of rawOrderedIds) {
        if (pinnedSet.has(id) !== (zone === 'pinned')) {
          return {
            abort: true,
            result: {
              ok: false,
              statusCode: 409,
              error: 'ZONE_PIN_MISMATCH',
              id,
              zone,
              revision: org.revision,
              org: buildOrgSnapshot(org)
            }
          };
        }
      }

      if (containerId === '__pinned__') {
        org.sessionOrder.__pinned__ = rawOrderedIds;
      } else {
        const resolvedCid = (() => {
          if (containerId === '__standalone__') return '__standalone__';
          if (containerId.startsWith('wt_')) return containerId;
          const found = findPersistedProject(org, { id: containerId });
          return found ? found.id : containerId;
        })();

        // Prevent cross-worktree / cross-project session drag-reorder
        for (const sid of rawOrderedIds) {
          let ownerContainer = null;
          if (sessionContainers && typeof sessionContainers[sid] === 'string' && sessionContainers[sid].trim()) {
            ownerContainer = sessionContainers[sid].trim();
          } else if (org.sessionWorktreeBindings?.[sid]?.worktreeId && resolvedCid.startsWith('wt_')) {
            ownerContainer = org.sessionWorktreeBindings[sid].worktreeId;
          } else if (resolveSessionContainer) {
            ownerContainer = resolveSessionContainer(sid, resolvedCid, org);
          }
          if (ownerContainer && ownerContainer !== resolvedCid) {
            return {
              abort: true,
              result: {
                ok: false,
                statusCode: 409,
                error: 'CROSS_CONTAINER_SESSION_MOVE_FORBIDDEN',
                sessionId: sid,
                ownerContainer,
                targetContainer: resolvedCid,
                revision: org.revision,
                org: buildOrgSnapshot(org)
              }
            };
          }
        }

        if (!isPlainObject(org.sessionOrder[resolvedCid])) {
          org.sessionOrder[resolvedCid] = { pinned: [], normal: [] };
        }
        org.sessionOrder[resolvedCid][zone] = rawOrderedIds;
      }

      return {
        buildResult: (saved) => {
          containerRevisions.set(containerKey, saved.revision);
          return { ok: true, revision: saved.revision, org: buildOrgSnapshot(saved) };
        }
      };
    });
  }

  function archiveSession(cascadeId, { archived, stepCount = 0, isRunning = false, projectId = null, projectName = null, titleSnapshot = '' } = {}) {
    const cleanId = String(cascadeId || '').trim();
    if (!cleanId) {
      return { ok: false, statusCode: 400, error: 'INVALID_CASCADE_ID' };
    }
    if (typeof archived !== 'boolean') {
      return { ok: false, statusCode: 400, error: 'INVALID_ARCHIVE_FLAG' };
    }

    return mutateOrgAtomically((org) => {
      if (org.deletedSessions[cleanId]) {
        return { abort: true, result: { ok: false, statusCode: 404, error: 'SESSION_NOT_FOUND' } };
      }

      let unpinned = false;
      if (archived) {
        const wasPinned = org.pins.sessions.includes(cleanId);
        if (wasPinned) {
          unpinned = true;
          org.pins.sessions = org.pins.sessions.filter((id) => id !== cleanId);
          delete org.pinTimestamps.sessions[cleanId];
          if (Array.isArray(org.sessionOrder.__pinned__)) {
            org.sessionOrder.__pinned__ = removeFromOrderArray(org.sessionOrder.__pinned__, cleanId);
          }
          for (const [ck, ord] of Object.entries(org.sessionOrder)) {
            if (ck === '__pinned__' || !isPlainObject(ord)) continue;
            ord.pinned = removeFromOrderArray(ord.pinned, cleanId);
          }
        }
        const prevArch = org.archivedSessions[cleanId];
        org.archivedSessions[cleanId] = {
          archivedAt: prevArch?.archivedAt || new Date().toISOString(),
          archivedAtStepCount: Number.isFinite(Number(stepCount)) ? Math.max(0, Math.floor(Number(stepCount))) : (prevArch?.archivedAtStepCount ?? 0),
          archivedWasRunning: Boolean(isRunning),
          projectId: projectId || prevArch?.projectId || null,
          projectName: projectName || prevArch?.projectName || null,
          titleSnapshot: typeof titleSnapshot === 'string' && titleSnapshot ? titleSnapshot : (prevArch?.titleSnapshot || '')
        };
      } else {
        delete org.archivedSessions[cleanId];
      }

      return {
        buildResult: (saved) => ({
          ok: true,
          cascadeId: cleanId,
          archived,
          unpinned,
          revision: saved.revision,
          archivedCount: Object.keys(saved.archivedSessions || {}).length
        })
      };
    });
  }

  function deleteSessionOrgRecord(cascadeId, { mode = 'host_deleted' } = {}) {
    const cleanId = String(cascadeId || '').trim();
    if (!cleanId) {
      return { ok: false, statusCode: 400, error: 'INVALID_CASCADE_ID' };
    }
    return mutateOrgAtomically((org) => {
      org.pins.sessions = org.pins.sessions.filter((id) => id !== cleanId);
      delete org.pinTimestamps.sessions[cleanId];
      delete org.archivedSessions[cleanId];
      delete org.sessionGroupMap[cleanId];
      delete org.sessionProjectOverrides[cleanId];
      delete org.sessionWorktreeBindings[cleanId];
      if (Array.isArray(org.sessionOrder.__pinned__)) {
        org.sessionOrder.__pinned__ = removeFromOrderArray(org.sessionOrder.__pinned__, cleanId);
      }
      for (const [ck, ord] of Object.entries(org.sessionOrder)) {
        if (ck === '__pinned__' || !isPlainObject(ord)) continue;
        ord.pinned = removeFromOrderArray(ord.pinned, cleanId);
        ord.normal = removeFromOrderArray(ord.normal, cleanId);
      }
      if (mode === 'local_tombstone') {
        org.deletedSessions[cleanId] = {
          deletedAt: new Date().toISOString(),
          mode: 'local_tombstone'
        };
      }
      return {
        buildResult: (saved) => ({
          ok: true,
          cascadeId: cleanId,
          deletionMode: mode,
          hostCleaned: mode === 'host_deleted',
          revision: saved.revision,
          archivedCount: Object.keys(saved.archivedSessions || {}).length
        })
      };
    });
  }

  function reconcileSessionsLifecycle(sessions = [], { forceUnarchiveIds = [] } = {}) {
    const current = loadPersistedOrg();
    const archivedEntries = current.archivedSessions || {};
    const archivedIds = Object.keys(archivedEntries);
    if (archivedIds.length === 0) {
      return { changed: false, unarchivedIds: [], org: current };
    }

    const sessionById = new Map();
    for (const s of (Array.isArray(sessions) ? sessions : [])) {
      const cid = String(s?.cascadeId || s?.id || '').trim();
      if (cid) sessionById.set(cid, s);
    }

    const forceSet = new Set((Array.isArray(forceUnarchiveIds) ? forceUnarchiveIds : []).map((x) => String(x || '').trim()).filter(Boolean));
    const toUnarchive = [];
    const toClearWasRunning = [];

    for (const cid of archivedIds) {
      if (forceSet.has(cid)) {
        toUnarchive.push(cid);
        continue;
      }
      const s = sessionById.get(cid);
      if (!s) continue;
      const arch = archivedEntries[cid];
      const status = String(s.status || '');
      const isRunningNow = Boolean(s.isRunning || RUNNING_STATUS_RE.test(status) || s.notFullyIdle);
      const needsAttentionNow = Boolean(s.needsAttention || /PENDING|WAITING|ERROR/i.test(status));

      if (needsAttentionNow) {
        toUnarchive.push(cid);
      } else if (arch.archivedWasRunning && !isRunningNow) {
        toClearWasRunning.push(cid);
      } else if (!arch.archivedWasRunning && isRunningNow) {
        toUnarchive.push(cid);
      }
    }

    if (toUnarchive.length === 0 && toClearWasRunning.length === 0) {
      return { changed: false, unarchivedIds: [], org: current };
    }

    const unarchivedSet = new Set(toUnarchive);
    const clearSet = new Set(toClearWasRunning);
    return mutateOrgAtomically((org) => {
      let modified = false;
      for (const cid of unarchivedSet) {
        if (org.archivedSessions[cid]) {
          delete org.archivedSessions[cid];
          modified = true;
        }
      }
      for (const cid of clearSet) {
        if (org.archivedSessions[cid] && org.archivedSessions[cid].archivedWasRunning) {
          org.archivedSessions[cid].archivedWasRunning = false;
          modified = true;
        }
      }
      if (!modified) {
        return { abort: true, result: { changed: false, unarchivedIds: [], org } };
      }
      return {
        buildResult: (saved) => ({
          changed: true,
          unarchivedIds: Array.from(unarchivedSet),
          org: saved
        })
      };
    });
  }

  function loadDbRows(forceRefresh = false) {
    if (!dbPath) return [];
    const now = Date.now();
    if (!forceRefresh && now - dbCache.loadedAt < DB_CACHE_TTL_MS) {
      return dbCache.rows;
    }
    const rows = readConversationSummariesDb(dbPath);
    dbCache = { loadedAt: now, rows };
    return rows;
  }

  function enrichSessionsAndOrg({
    rpcSessions = [],
    allowedRoots = null,
    includeSubagents = false,
    includeArchived = false,
    limit = DEFAULT_SESSION_LIMIT
  } = {}) {
    const reconciled = reconcileSessionsLifecycle(rpcSessions);
    const persisted = reconciled.org || loadPersistedOrg();
    const dbRows = loadDbRows();
    const roots = Array.isArray(allowedRoots) ? allowedRoots : getAllowedRoots();

    const dbById = new Map();
    for (const row of dbRows) {
      const cid = String(row?.conversation_id || '').trim();
      if (cid) dbById.set(cid, row);
    }

    const pinnedSessions = new Set(persisted.pins.sessions);
    const pinnedProjects = new Set(persisted.pins.projects);
    const pinnedGroups = new Set(persisted.pins.groups);
    const archivedMap = persisted.archivedSessions || {};
    const deletedMap = persisted.deletedSessions || {};
    const overridesMap = persisted.sessionProjectOverrides || {};
    const bindingsMap = persisted.sessionWorktreeBindings || {};

    const groupBySession = new Map(Object.entries(persisted.sessionGroupMap));
    const groupByProject = new Map(Object.entries(persisted.projectGroupMap));
    const groupByWorkspace = new Map();
    for (const g of persisted.groups) {
      for (const sid of g.sessionIds) {
        if (!groupBySession.has(sid)) groupBySession.set(sid, g.id);
      }
      for (const pid of g.projectIds) {
        if (!groupByProject.has(pid)) groupByProject.set(pid, g.id);
      }
      for (const ws of g.workspaceUris) {
        const normPath = normalizeUriToPath(ws);
        if (normPath && !groupByWorkspace.has(normPath)) groupByWorkspace.set(normPath, g.id);
      }
    }

    const projectsById = new Map();
    const projectByPathKey = new Map();
    const projectIdByAlias = new Map();

    for (const pp of (persisted.projects || [])) {
      const normPath = normalizeUriToPath(pp.rootPath || pp.uri);
      const gid = groupByProject.get(pp.id) || pp.groupId || null;
      const entry = {
        id: pp.id,
        aliases: Array.isArray(pp.aliases) ? [...pp.aliases] : [],
        name: pp.name,
        uri: pp.uri || (normPath ? pathToFileUri(normPath) : null),
        path: normPath || null,
        rootPath: normPath || null,
        groupId: gid,
        pinned: pinnedProjects.has(pp.id),
        source: pp.source || 'local',
        syncedFromApp: Boolean(pp.syncedFromApp),
        ...(pp.remote ? { remote: pp.remote } : {}),
        branchName: null,
        sessionCount: 0,
        lastModifiedTime: null
      };
      projectsById.set(pp.id, entry);
      if (normPath) {
        for (const k of getPathLookupKeys(normPath)) {
          if (!projectByPathKey.has(k)) projectByPathKey.set(k, entry);
        }
      }
      for (const alias of entry.aliases) {
        if (!projectIdByAlias.has(alias)) projectIdByAlias.set(alias, pp.id);
      }
    }

    function registerProject({ id, uri, fsPath, name, branchName = null, lastModifiedTime = null, groupId = null, allowTemp = false }) {
      if (!allowTemp && (((fsPath || uri) && isTempBridgeWorkspace(fsPath || uri)) || (name && isTempBridgeWorkspace(name)))) {
        return null;
      }
      const normPath = normalizeUriToPath(fsPath || uri);
      const normUri = uri && String(uri).startsWith('file://') ? String(uri).trim() : (normPath ? pathToFileUri(normPath) : null);

      if (normPath) {
        for (const k of getPathLookupKeys(normPath)) {
          const pathHit = projectByPathKey.get(k);
          if (pathHit) {
            if (!pathHit.uri && normUri) pathHit.uri = normUri;
            if (!pathHit.branchName && branchName) pathHit.branchName = branchName;
            if (!pathHit.groupId && groupId) pathHit.groupId = groupId;
            if (lastModifiedTime && (!pathHit.lastModifiedTime || Date.parse(lastModifiedTime) > Date.parse(pathHit.lastModifiedTime))) {
              pathHit.lastModifiedTime = lastModifiedTime;
            }
            return pathHit;
          }
        }
      }

      let resolvedId = !isGenericDbProjectId(id) ? String(id).trim() : '';
      if (resolvedId && projectIdByAlias.has(resolvedId)) {
        resolvedId = projectIdByAlias.get(resolvedId);
      }
      if (resolvedId && projectsById.has(resolvedId)) {
        const hit = projectsById.get(resolvedId);
        if (!hit.uri && normUri) hit.uri = normUri;
        if (!hit.branchName && branchName) hit.branchName = branchName;
        if (!hit.groupId && groupId) hit.groupId = groupId;
        if (lastModifiedTime && (!hit.lastModifiedTime || Date.parse(lastModifiedTime) > Date.parse(hit.lastModifiedTime))) {
          hit.lastModifiedTime = lastModifiedTime;
        }
        return hit;
      }

      if (!resolvedId && normPath) {
        resolvedId = deriveWorkspaceProjectId(normPath);
      }
      if (!resolvedId) return null;

      const resolvedGroupId = groupByProject.get(resolvedId)
        || (normPath ? groupByWorkspace.get(normPath) : null)
        || groupId
        || null;

      const entry = {
        id: resolvedId,
        name: String(name || extractWorkspaceDisplayName(normPath || normUri) || resolvedId),
        uri: normUri,
        path: normPath || null,
        rootPath: normPath || null,
        groupId: resolvedGroupId,
        pinned: pinnedProjects.has(resolvedId),
        branchName: branchName || null,
        sessionCount: 0,
        lastModifiedTime: lastModifiedTime || null
      };
      projectsById.set(resolvedId, entry);
      if (normPath) {
        for (const k of getPathLookupKeys(normPath)) {
          if (!projectByPathKey.has(k)) projectByPathKey.set(k, entry);
        }
      }
      return entry;
    }

    const hostGroupIds = new Set();
    for (const row of dbRows) {
      const dbGroup = String(row?.group_id || '').trim();
      if (dbGroup) hostGroupIds.add(dbGroup);
      const uris = parseWorkspaceUrisField(row?.workspace_uris);
      const primaryUri = pickPrimaryWorkspaceUri(uris);
      const dbProjectId = String(row?.project_id || '').trim();
      if (primaryUri && !isTempBridgeWorkspace(primaryUri)) {
        registerProject({
          id: dbProjectId,
          uri: primaryUri,
          lastModifiedTime: row?.last_modified_time || null,
          groupId: dbGroup || null
        });
      } else if (!isGenericDbProjectId(dbProjectId)) {
        registerProject({
          id: dbProjectId,
          uri: primaryUri,
          lastModifiedTime: row?.last_modified_time || null,
          groupId: dbGroup || null
        });
      }
    }

    for (const root of (Array.isArray(roots) ? roots : [])) {
      const normPath = normalizeUriToPath(root);
      if (normPath) {
        registerProject({ fsPath: normPath, uri: pathToFileUri(normPath) });
      }
    }

    // Build initial longest-prefix matcher for registered projects + worktrees
    const enrichedAll = [];
    for (const s of (Array.isArray(rpcSessions) ? rpcSessions : [])) {
      if (!isPlainObject(s)) continue;
      const cid = String(s.cascadeId || s.id || '').trim();
      if (!cid || deletedMap[cid]) continue;

      const dbRow = dbById.get(cid) || null;
      const dbUris = dbRow ? parseWorkspaceUrisField(dbRow.workspace_uris) : [];
      const rpcUris = Array.isArray(s.workspaces)
        ? s.workspaces.map((ws) => (isPlainObject(ws) ? (ws.workspaceFolderAbsoluteUri || ws.workspaceUri || '') : '')).filter(Boolean)
        : [];
      const binding = bindingsMap[cid] || null;
      const allWsUris = [s.workspaceUri, ...rpcUris, ...dbUris, binding?.workspaceUri].filter(Boolean);
      const isInternalTempOnlySession = allWsUris.length > 0 && allWsUris.every((u) => isTempBridgeWorkspace(u));
      if (isInternalTempOnlySession && !pinnedSessions.has(cid)) continue;

      const rawWsUri = s.workspaceUri && !isTempBridgeWorkspace(s.workspaceUri) ? s.workspaceUri : null;
      const primaryWsUri = rawWsUri || pickPrimaryWorkspaceUri(rpcUris) || pickPrimaryWorkspaceUri(dbUris) || binding?.workspaceUri || null;
      const normWsPath = normalizeUriToPath(primaryWsUri);
      const dbProjectId = String(dbRow?.project_id || '').trim();
      const dbGroupId = String(dbRow?.group_id || '').trim();
      if (dbGroupId) hostGroupIds.add(dbGroupId);

      let proj = null;
      if (Object.prototype.hasOwnProperty.call(overridesMap, cid)) {
        const overridePid = overridesMap[cid];
        if (overridePid) {
          const mappedPid = projectIdByAlias.get(overridePid) || overridePid;
          proj = projectsById.get(mappedPid) || null;
        }
      } else if ((primaryWsUri && !isTempBridgeWorkspace(primaryWsUri)) || !isGenericDbProjectId(dbProjectId)) {
        proj = registerProject({
          id: dbProjectId,
          uri: primaryWsUri,
          name: s.repoName || extractWorkspaceDisplayName(primaryWsUri),
          branchName: s.branchName || null,
          lastModifiedTime: s.lastModifiedTime || s.createdTime || dbRow?.last_modified_time || null,
          groupId: dbGroupId || null
        });
      }

      const projectId = proj?.id || (Object.prototype.hasOwnProperty.call(overridesMap, cid) ? overridesMap[cid] : (!isGenericDbProjectId(dbProjectId) ? dbProjectId : null));
      const projectName = proj?.name || (projectId === null ? null : (s.repoName || extractWorkspaceDisplayName(primaryWsUri) || null));
      const parentConversationId = String(dbRow?.parent_conversation_id || s.parentConversationId || '').trim() || null;
      const nestingDepth = Number.isFinite(Number(dbRow?.nesting_depth))
        ? Number(dbRow.nesting_depth)
        : (Number.isFinite(Number(s.nestingDepth)) ? Number(s.nestingDepth) : 0);
      const agentName = String(dbRow?.agent_name || s.agentName || '').trim() || null;
      const isSubagent = Boolean(s.isSubagent || parentConversationId || nestingDepth > 0);
      const archEntry = archivedMap[cid] || null;
      const archived = Boolean(archEntry);

      const groupId = groupBySession.get(cid)
        || (projectId ? groupByProject.get(projectId) : null)
        || (normWsPath ? groupByWorkspace.get(normWsPath) : null)
        || (dbGroupId || null)
        || (proj?.groupId || null);

      const pinned = pinnedSessions.has(cid);
      const pinnedAt = pinned ? (persisted.pinTimestamps?.sessions?.[cid] || null) : null;
      const enriched = {
        ...s,
        cascadeId: cid,
        workspaceUri: primaryWsUri,
        groupId: groupId || null,
        projectId: projectId || null,
        projectName,
        pinned,
        pinnedAt,
        archived,
        ...(archived ? { archivedAt: archEntry.archivedAt } : {}),
        parentConversationId,
        nestingDepth,
        agentName,
        isSubagent
      };
      enrichedAll.push(enriched);

      if (proj && !archived && (!isSubagent || includeSubagents)) {
        proj.sessionCount += 1;
      }
    }

    // Aggregate multi-worktree projects and attach worktree metadata to sessions
    const agg = aggregateWorktreeProjects({
      projects: Array.from(projectsById.values()),
      sessions: enrichedAll,
      persistedOrg: persisted,
      worktreeDiscovery
    });

    const knownWts = agg.allKnownWorktrees || [];
    for (const es of enrichedAll) {
      if (es.projectId && agg.mergedIdToPrimaryId?.has(es.projectId)) {
        es.projectId = agg.mergedIdToPrimaryId.get(es.projectId);
        const primaryProj = agg.projects.find((p) => p.id === es.projectId);
        if (primaryProj) {
          es.projectName = primaryProj.name;
          if (!es.groupId && primaryProj.groupId) es.groupId = primaryProj.groupId;
        }
      }
      const binding = bindingsMap[es.cascadeId] || null;
      const rawWs = es.workspacePath || es.workspaceUri || binding?.workspacePath || binding?.workspaceUri || '';
      const matchedWt = rawWs ? matchWorktreeByLongestPrefix(rawWs, knownWts) : null;
      if (matchedWt) {
        es.worktreeId = matchedWt.worktreeId;
        es.worktreePath = matchedWt.path;
        es.worktreeBranch = matchedWt.branch || matchedWt.displayLabel;
        es.worktreeStatus = matchedWt.status;
      } else if (binding?.worktreeId) {
        es.worktreeId = binding.worktreeId;
        es.worktreePath = binding.workspacePath || null;
      }
    }

    const visibleSessions = enrichedAll.filter((s) => {
      if (!includeSubagents && s.isSubagent) return false;
      if (!includeArchived && s.archived) return false;
      return true;
    });

    const pinnedGlobalOrder = Array.isArray(persisted.sessionOrder?.__pinned__) ? persisted.sessionOrder.__pinned__ : [];
    const pinnedGlobalIdx = new Map(pinnedGlobalOrder.map((id, idx) => [id, idx]));

    visibleSessions.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.pinned && b.pinned) {
        if (pinnedGlobalIdx.has(a.cascadeId) && pinnedGlobalIdx.has(b.cascadeId)) {
          return pinnedGlobalIdx.get(a.cascadeId) - pinnedGlobalIdx.get(b.cascadeId);
        }
      }
      const tb = Date.parse(b.lastModifiedTime || b.createdTime || '') || 0;
      const ta = Date.parse(a.lastModifiedTime || a.createdTime || '') || 0;
      return tb - ta;
    });

    const parsedLimit = Number(limit);
    const effectiveLimit = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(Math.floor(parsedLimit), MAX_SESSION_LIMIT)
      : DEFAULT_SESSION_LIMIT;
    const boundedSessions = visibleSessions.slice(0, effectiveLimit);

    const groupsById = new Map();
    for (const g of persisted.groups) {
      groupsById.set(g.id, {
        id: g.id,
        name: g.name,
        source: g.source || 'user',
        collapsed: Boolean(g.collapsed),
        pinned: pinnedGroups.has(g.id),
        order: g.order,
        projectIds: [...g.projectIds],
        workspaceUris: [...g.workspaceUris],
        sessionIds: [...g.sessionIds]
      });
    }
    let hostOrder = persisted.groups.length;
    for (const hgid of hostGroupIds) {
      if (!groupsById.has(hgid)) {
        groupsById.set(hgid, {
          id: hgid,
          name: hgid,
          source: 'host',
          collapsed: false,
          pinned: pinnedGroups.has(hgid),
          order: hostOrder++,
          projectIds: [],
          workspaceUris: [],
          sessionIds: []
        });
      }
    }

    for (const proj of agg.projects) {
      if (proj.groupId && groupsById.has(proj.groupId)) {
        const g = groupsById.get(proj.groupId);
        if (!g.projectIds.includes(proj.id)) g.projectIds.push(proj.id);
        if (proj.uri && !g.workspaceUris.includes(proj.uri)) g.workspaceUris.push(proj.uri);
      }
    }
    for (const s of visibleSessions) {
      if (s.groupId && groupsById.has(s.groupId)) {
        const g = groupsById.get(s.groupId);
        if (!g.sessionIds.includes(s.cascadeId)) g.sessionIds.push(s.cascadeId);
      }
    }

    const projectOrderMap = persisted.projectOrder || {};
    const projects = agg.projects.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const ga = a.groupId || '__ungrouped__';
      const gb = b.groupId || '__ungrouped__';
      if (ga === gb && projectOrderMap[ga]) {
        const zoneArr = a.pinned ? projectOrderMap[ga].pinned : projectOrderMap[ga].normal;
        if (Array.isArray(zoneArr) && zoneArr.length > 0) {
          const ia = zoneArr.indexOf(a.id);
          const ib = zoneArr.indexOf(b.id);
          if (ia >= 0 && ib >= 0) return ia - ib;
          if (ia >= 0) return 1;
          if (ib >= 0) return -1;
        }
      }
      const tb = Date.parse(b.lastModifiedTime || '') || 0;
      const ta = Date.parse(a.lastModifiedTime || '') || 0;
      if (tb !== ta) return tb - ta;
      return a.name.localeCompare(b.name);
    });

    const grpPinnedIdx = new Map((persisted.groupOrder?.pinned || []).map((id, idx) => [id, idx]));
    const grpNormalIdx = new Map((persisted.groupOrder?.normal || []).map((id, idx) => [id, idx]));

    const groups = Array.from(groupsById.values()).sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.pinned) {
        const ia = grpPinnedIdx.has(a.id) ? grpPinnedIdx.get(a.id) : Number.MAX_SAFE_INTEGER;
        const ib = grpPinnedIdx.has(b.id) ? grpPinnedIdx.get(b.id) : Number.MAX_SAFE_INTEGER;
        if (ia !== ib) return ia - ib;
      } else {
        const ia = grpNormalIdx.has(a.id) ? grpNormalIdx.get(a.id) : Number.MAX_SAFE_INTEGER;
        const ib = grpNormalIdx.has(b.id) ? grpNormalIdx.get(b.id) : Number.MAX_SAFE_INTEGER;
        if (ia !== ib) return ia - ib;
      }
      if (a.order !== b.order) return a.order - b.order;
      return a.name.localeCompare(b.name);
    });

    return {
      version: 2,
      revision: persisted.revision,
      sessions: boundedSessions,
      totalVisibleSessions: visibleSessions.length,
      groups,
      projects,
      collapsedNodes: persisted.collapsedNodes || { projects: {}, worktrees: {} },
      pins: {
        sessions: [...persisted.pins.sessions],
        projects: [...persisted.pins.projects],
        groups: [...persisted.pins.groups]
      },
      pinTimestamps: persisted.pinTimestamps,
      projectGroupMap: persisted.projectGroupMap,
      sessionGroupMap: persisted.sessionGroupMap,
      sessionProjectOverrides: persisted.sessionProjectOverrides,
      groupOrder: persisted.groupOrder,
      projectOrder: persisted.projectOrder,
      sessionOrder: persisted.sessionOrder,
      worktreeTombstones: persisted.worktreeTombstones || {},
      archivedCount: Object.keys(archivedMap).length,
      ...(includeArchived ? { archivedSessions: archivedMap } : {}),
      defaultSessionPath: persisted.defaultSessionPath || path.join(os.homedir(), 'antigravity-workspace')
    };
  }

  function getOrg(opts = {}) {
    if (typeof options.dbPath !== 'undefined' || options.useEnrichInGetOrg) {
      const res = enrichSessionsAndOrg({ ...opts, limit: MAX_SESSION_LIMIT });
      return {
        ok: true,
        version: 2,
        revision: res.revision,
        groups: res.groups,
        projects: res.projects,
        collapsedNodes: res.collapsedNodes,
        pins: res.pins,
        pinTimestamps: res.pinTimestamps,
        projectGroupMap: res.projectGroupMap,
        sessionGroupMap: res.sessionGroupMap,
        sessionProjectOverrides: res.sessionProjectOverrides,
        groupOrder: res.groupOrder,
        projectOrder: res.projectOrder,
        sessionOrder: res.sessionOrder,
        worktreeTombstones: res.worktreeTombstones,
        archivedCount: res.archivedCount,
        ...(opts?.includeArchived ? { archivedSessions: res.archivedSessions || {} } : {}),
        defaultSessionPath: res.defaultSessionPath
      };
    }
    const org = loadPersistedOrg();
    return buildOrgSnapshot(org, opts);
  }

  return {
    orgPath,
    loadPersistedOrg,
    mutateOrgAtomically,
    migrateWorkspaceMetaV1,
    materializeProjectInOrg,
    syncFromExternalSignal,
    startWatching,
    dispose,
    getOrg,
    buildOrgSnapshot,
    enrichSessionsAndOrg,
    togglePin,
    mutateGroup,
    setNodeCollapsed,
    bindSessionWorkspace,
    syncWorktreeTopology,
    reorderOrg,
    archiveSession,
    deleteSessionOrgRecord,
    reconcileSessionsLifecycle
  };
}

module.exports = {
  DEFAULT_SESSION_LIMIT,
  MAX_SESSION_LIMIT,
  createEmptyPersistedOrg,
  sanitizePersistedOrg,
  buildOrgBusSummary,
  aggregateWorktreeProjects,
  createSessionOrgCore
};
