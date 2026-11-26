'use strict';

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const url = require('node:url');
const { createSessionOrgBridge } = require('./session-org-bridge');

const META_FILE_NAME = 'workspace-meta.json';
const IS_CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';
const PERCENT_ENCODED_RE = /%[0-9A-Fa-f]{2}/;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;
const DEFAULT_CONVERSATION_DB_TTL_MS = 1500;
const DEFAULT_APP_SYNC_TTL_MS = 2000;
const CONVERSATION_SUMMARIES_SQL = [
  'SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris,',
  'status, source, project_id, agent_name, parent_conversation_id, nesting_depth,',
  'not_fully_idle, killed, last_user_input_step_index',
  'FROM conversation_summaries',
  'ORDER BY last_modified_time DESC LIMIT 2000'
].join(' ');
const CONVERSATION_PROJECTS_SQL = [
  'SELECT workspace_uris, project_id, COUNT(*) AS session_count, MAX(last_modified_time) AS max_last_modified_time',
  'FROM conversation_summaries',
  'WHERE workspace_uris IS NOT NULL AND TRIM(workspace_uris) != \'\'',
  'GROUP BY workspace_uris, project_id'
].join(' ');
const VSCDB_SIDEBAR_SQL = "SELECT value FROM ItemTable WHERE key = 'antigravityUnifiedStateSync.sidebarWorkspaces'";
const INTERNAL_SOURCE_RE = /SUBAGENT|INTERNAL|SWARM/i;
const RUNNING_STATUS_RE = /RUNNING|GENERATING/i;
const TEMP_BRIDGE_RE = /(?:^|\/)(?:private\/)?tmp\/magpie-agy-bridge-/i;
const MAC_VAR_FOLDERS_TMP_RE = /(?:^|\/)(?:private\/)?var\/folders\/[^/]+\/[^/]+\/T(?:\/|$)/i;

function isTestMode() {
  return (
    process.env.AGY_DADDY_TEST_MODE === '1'
    || process.env.NODE_ENV === 'test'
    || Boolean(process.env.NODE_TEST_CONTEXT)
  );
}

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function expandTilde(input) {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function safeRealpath(targetPath) {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return null;
  }
}

function findDeepestExistingAncestor(targetPath) {
  let current = targetPath;
  while (true) {
    try {
      fs.lstatSync(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

function canonicalKey(p) {
  const s = String(p || '').replace(/\\/g, '/');
  const trimmed = s.length > 1 && !/^[A-Za-z]:\/$/.test(s) ? s.replace(/\/+$/, '') : s;
  return IS_CASE_INSENSITIVE_FS ? trimmed.toLowerCase() : trimmed;
}

function getPathLookupKeys(normalizedPath) {
  if (!normalizedPath) return [];
  const keys = [canonicalKey(normalizedPath)];
  const real = safeRealpath(normalizedPath);
  if (real) {
    const realKey = canonicalKey(real);
    if (!keys.includes(realKey)) keys.push(realKey);
  }
  return keys;
}

/**
 * Normalizes a local path or file:// URI (with percent-encoded UTF-8/CJK, ~/, and trailing slashes).
 */
function normalizeLocalPath(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  if (!s || s.includes('\0')) return '';

  let fromFileUrl = false;
  if (/^file:\/\//i.test(s)) {
    fromFileUrl = true;
    try {
      s = url.fileURLToPath(s);
    } catch {
      // Fallback for non-standard file:// URIs
      s = s.replace(/^file:\/\//i, '');
      if (/^localhost\//i.test(s)) {
        s = s.slice('localhost'.length);
      }
      if (PERCENT_ENCODED_RE.test(s)) {
        try {
          s = decodeURIComponent(s);
        } catch {
          // Keep raw if malformed percent-encoding
        }
      }
    }
  }

  if (!fromFileUrl && PERCENT_ENCODED_RE.test(s)) {
    const expandedRaw = expandTilde(s);
    if (!fs.existsSync(expandedRaw)) {
      try {
        s = decodeURIComponent(s);
      } catch {
        // Keep raw if malformed percent-encoding
      }
    }
  }

  s = expandTilde(s);
  if (!s || s.includes('\0')) return '';

  // Preserve Windows drive paths cleanly even when tested on POSIX
  if (WINDOWS_DRIVE_RE.test(s) && process.platform !== 'win32') {
    const slashed = s.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    return slashed.length > 3 ? slashed.replace(/\/+$/, '') : slashed;
  }

  return path.resolve(s);
}

function isSameOrInside(targetPath, baseDir, caseInsensitive) {
  const norm = (val) => {
    let s = String(val || '').replace(/\\/g, '/');
    if (s.length > 1 && !/^[A-Za-z]:\/$/.test(s)) {
      s = s.replace(/\/+$/, '');
    }
    return caseInsensitive ? s.toLowerCase() : s;
  };
  const t = norm(targetPath);
  const b = norm(baseDir);
  if (!t || !b) return false;
  return t === b || t.startsWith(b.endsWith('/') ? b : `${b}/`);
}

function getForbiddenPrefixes() {
  const home = os.homedir();
  const candidates = [
    '/System',
    '/etc',
    '/private/etc',
    '/usr',
    '/bin',
    '/sbin',
    '/var/root',
    '/private/var/root',
    path.join(home, '.ssh'),
    path.join(home, '.aws'),
    path.join(home, '.gnupg')
  ];
  const out = [];
  const seen = new Set();
  for (const p of candidates) {
    const norm = path.resolve(p);
    if (!seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
    const real = safeRealpath(norm);
    if (real && !seen.has(real)) {
      seen.add(real);
      out.push(real);
    }
  }
  return out;
}

/**
 * Rejects system roots and sensitive home directories.
 */
function isForbiddenSystemRoot(realPath) {
  if (typeof realPath !== 'string' || !realPath.trim() || realPath.includes('\0')) {
    return true;
  }

  const trimmed = realPath.trim();
  if (trimmed === '/' || /^[A-Za-z]:[\\/]?$/.test(trimmed)) {
    return true;
  }
  // Block Windows C:\Windows (and subpaths) case-insensitively on all platforms
  const winSlashed = trimmed.replace(/\\/g, '/');
  if (/^c:\/windows(?:\/|$)/i.test(winSlashed)) {
    return true;
  }
  if (/^file:\/\/\/?c:\/windows(?:\/|$)/i.test(winSlashed)) {
    return true;
  }

  const normalized = normalizeLocalPath(trimmed);
  if (!normalized) return true;

  if (/^c:\/windows(?:\/|$)/i.test(normalized.replace(/\\/g, '/'))) {
    return true;
  }

  const resolvedReal = safeRealpath(normalized);
  const candidates = resolvedReal && resolvedReal !== normalized
    ? [normalized, resolvedReal]
    : [normalized];

  const prefixes = getForbiddenPrefixes();
  for (const candidate of candidates) {
    const slashed = candidate.replace(/\\/g, '/');
    if (slashed === '/' || /^[A-Za-z]:\/?$/.test(slashed)) return true;
    for (const prefix of prefixes) {
      if (isSameOrInside(candidate, prefix, IS_CASE_INSENSITIVE_FS)) {
        return true;
      }
    }
  }

  return false;
}

function isTempAppWorkspacePath(normPath) {
  if (typeof normPath !== 'string' || !normPath.trim()) return true;
  const slashed = normPath.replace(/\\/g, '/');
  return TEMP_BRIDGE_RE.test(slashed) || MAC_VAR_FOLDERS_TMP_RE.test(slashed);
}

function makeImplicitProjectId(normRootPath) {
  const digest = crypto
    .createHash('sha1')
    .update(canonicalKey(normRootPath))
    .digest('hex')
    .slice(0, 12);
  return `implicit:${digest}`;
}

function makeAppSyncedProjectId(normRootPath) {
  const digest = crypto
    .createHash('sha1')
    .update(canonicalKey(normRootPath))
    .digest('hex')
    .slice(0, 12);
  return `app:${digest}`;
}

function readMetaFromStorage(storage) {
  if (!storage || typeof storage.readJson !== 'function') {
    return null;
  }
  const raw = storage.readJson(META_FILE_NAME, null);
  if (isPlainObject(raw) && 'data' in raw && ('ok' in raw || 'exists' in raw)) {
    return isPlainObject(raw.data) ? raw.data : null;
  }
  return isPlainObject(raw) ? raw : null;
}

function writeMetaToStorage(storage, state) {
  if (!storage || typeof storage.writeJson !== 'function') {
    return;
  }
  storage.writeJson(META_FILE_NAME, state);
}

function cloneReadStateMap(map) {
  const out = {};
  if (!isPlainObject(map)) return out;
  for (const [cid, entry] of Object.entries(map)) {
    if (!cid || !isPlainObject(entry)) continue;
    out[cid] = {
      lastReadAt: entry.lastReadAt,
      lastReadStepCount: entry.lastReadStepCount
    };
  }
  return out;
}

function cloneCompletionMap(map) {
  const out = {};
  if (!isPlainObject(map)) return out;
  for (const [cid, entry] of Object.entries(map)) {
    if (!cid || !isPlainObject(entry)) continue;
    out[cid] = { ...entry };
  }
  return out;
}

function cloneUserCreatedMap(map) {
  const out = {};
  if (!isPlainObject(map)) return out;
  for (const [cid, entry] of Object.entries(map)) {
    if (!cid || !isPlainObject(entry)) continue;
    out[cid] = { ...entry };
  }
  return out;
}

function cloneState(state) {
  return {
    version: 1,
    defaultSessionPath: state.defaultSessionPath,
    readStateInitializedAt: state.readStateInitializedAt,
    pinnedSessions: Object.fromEntries(
      Object.entries(state.pinnedSessions).map(([k, v]) => [k, { ...v }])
    ),
    sessionProjectOverrides: { ...state.sessionProjectOverrides },
    sessionReadState: cloneReadStateMap(state.sessionReadState),
    sessionCompletionTimes: cloneCompletionMap(state.sessionCompletionTimes),
    userCreatedSessions: cloneUserCreatedMap(state.userCreatedSessions),
    projects: state.projects.map((p) => ({ ...p })),
    groups: state.groups.map((g) => ({ ...g }))
  };
}

function toTimestampMs(isoOrNull) {
  if (!isoOrNull) return 0;
  const ms = Date.parse(isoOrNull);
  return Number.isFinite(ms) ? ms : 0;
}

function normalizeReadEntry(entry) {
  if (!isPlainObject(entry)) return null;
  const parsedMs = typeof entry.lastReadAt === 'string' ? Date.parse(entry.lastReadAt) : NaN;
  const hasValidAt = Number.isFinite(parsedMs);
  const rawStep = entry.lastReadStepCount;
  const hasValidStep = rawStep !== undefined && rawStep !== null && Number.isFinite(Number(rawStep));
  if (!hasValidAt && !hasValidStep) return null;
  return {
    lastReadAt: hasValidAt ? new Date(parsedMs).toISOString() : new Date(0).toISOString(),
    lastReadStepCount: hasValidStep ? Math.max(0, Math.floor(Number(rawStep))) : 0
  };
}

function mergeReadEntries(existing, incoming) {
  if (!existing) return { ...incoming };
  if (!incoming) return { ...existing };
  const existingMs = toTimestampMs(existing.lastReadAt);
  const incomingMs = toTimestampMs(incoming.lastReadAt);
  const maxMs = Math.max(existingMs, incomingMs);
  const maxStep = Math.max(
    Number.isFinite(existing.lastReadStepCount) ? existing.lastReadStepCount : 0,
    Number.isFinite(incoming.lastReadStepCount) ? incoming.lastReadStepCount : 0
  );
  return {
    lastReadAt: new Date(maxMs).toISOString(),
    lastReadStepCount: maxStep
  };
}

function extractExternalReadMap(raw) {
  if (!isPlainObject(raw)) return {};
  if (isPlainObject(raw.sessions)) return raw.sessions;
  if (isPlainObject(raw.sessionReadState)) return raw.sessionReadState;
  if (isPlainObject(raw.readState)) return raw.readState;
  const out = {};
  for (const [key, val] of Object.entries(raw)) {
    if (key === 'version' || key === 'updatedAt' || key === 'readStateInitializedAt') continue;
    if (isPlainObject(val)) out[key] = val;
  }
  return out;
}

function resolveOptionalPath(optionValue, defaultFactory) {
  if (optionValue === null || optionValue === false) return null;
  if (typeof optionValue === 'string') {
    const trimmed = optionValue.trim();
    return trimmed ? normalizeLocalPath(trimmed) : null;
  }
  return !isTestMode() ? defaultFactory() : null;
}

function runReadOnlySqliteQuery(dbPath, sql) {
  if (!dbPath || !fs.existsSync(dbPath)) return [];
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare(sql).all();
      return Array.isArray(rows) ? rows : [];
    } finally {
      db.close();
    }
  } catch {
    // Fallback to sqlite3 CLI in read-only JSON mode
  }
  try {
    const rawJson = execFileSync('sqlite3', ['-readonly', '-json', dbPath, sql], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const parsed = JSON.parse(rawJson || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readConversationRowsFromDb(dbPath) {
  return runReadOnlySqliteQuery(dbPath, CONVERSATION_SUMMARIES_SQL);
}

function parseAllWorkspaceUrisFromDb(rawUris) {
  if (typeof rawUris !== 'string') return [];
  const trimmed = rawUris.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) {
        return arr
          .map((item) => (typeof item === 'string' ? item.trim() : ''))
          .filter(Boolean);
      }
    } catch {
      return [];
    }
    return [];
  }
  return trimmed
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseWorkspaceUriFromDb(rawUris) {
  const all = parseAllWorkspaceUrisFromDb(rawUris);
  if (all.length === 0) return null;
  const nonTemp = all.find((uri) => {
    const norm = normalizeLocalPath(uri);
    return norm && !isForbiddenSystemRoot(norm) && !isTempAppWorkspacePath(norm);
  });
  return nonTemp || all[0] || null;
}

function extractSidebarFileUrisFromValue(rawValue) {
  if (rawValue === null || rawValue === undefined) return [];
  const rawStr = Buffer.isBuffer(rawValue)
    ? rawValue.toString('utf8')
    : String(rawValue);
  const trimmed = rawStr.trim();
  if (!trimmed) return [];

  const candidates = [];
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
    if (decoded && decoded.includes('file://')) {
      candidates.push(decoded);
    }
  } catch {
    // Ignore base64 decode failure
  }
  if (candidates.length === 0 && trimmed.includes('file://')) {
    candidates.push(trimmed);
  }

  const out = [];
  for (const text of candidates) {
    const matches = text.match(/file:\/\/[^\x00-\x1f\x7f"<>\\]+/g);
    if (matches) {
      for (const m of matches) {
        const clean = m.trim();
        if (clean) out.push(clean);
      }
    }
  }
  return out;
}

function pickNonEmptyString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Creates a persisted store for workspace projects, groups, pinned sessions, and overrides.
 * The optional `now` function returns milliseconds for cache expiry checks.
 */
function createWorkspaceMetaStore({
  storage = null,
  sessionOrgBridge = null,
  defaultBaseDir,
  conversationDbPath,
  stateVscdbPath,
  sharedReadStatePath,
  conversationDbTtlMs = DEFAULT_CONVERSATION_DB_TTL_MS,
  appSyncTtlMs = DEFAULT_APP_SYNC_TTL_MS,
  now = () => Date.now()
} = {}) {
  const fallbackDefaultPath = normalizeLocalPath(defaultBaseDir)
    || path.join(os.homedir(), 'antigravity-workspace');
  const usesExternalOrgBridge = Boolean(sessionOrgBridge);
  const orgBridge = sessionOrgBridge || createSessionOrgBridge({ orgPath: null });
  const resolvedConversationDbPath = resolveOptionalPath(
    conversationDbPath,
    () => path.join(os.homedir(), '.gemini', 'antigravity', 'conversation_summaries.db')
  );
  const resolvedStateVscdbPath = resolveOptionalPath(
    stateVscdbPath,
    () => path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity', 'User', 'globalStorage', 'state.vscdb')
  );
  const resolvedSharedReadStatePath = resolveOptionalPath(
    sharedReadStatePath,
    () => path.join(os.homedir(), '.agy-daddy', 'session-read-state.json')
  );
  const dbCacheTtlMs = Number.isFinite(Number(conversationDbTtlMs)) && Number(conversationDbTtlMs) >= 0
    ? Number(conversationDbTtlMs)
    : DEFAULT_CONVERSATION_DB_TTL_MS;
  const appSyncCacheTtlMs = Number.isFinite(Number(appSyncTtlMs)) && Number(appSyncTtlMs) >= 0
    ? Number(appSyncTtlMs)
    : DEFAULT_APP_SYNC_TTL_MS;

  const dbCache = {
    cachedAt: null,
    byId: new Map()
  };
  const appSyncCache = {
    cachedAt: null,
    projects: []
  };
  const knownImplicitProjectsById = new Map();
  const lastSeenStepCounts = new Map();

  function normalizeInitialState(raw) {
    const src = isPlainObject(raw) ? raw : {};
    const defaultSessionPath = normalizeLocalPath(src.defaultSessionPath) || fallbackDefaultPath;
    const rawInitMs = typeof src.readStateInitializedAt === 'string' ? Date.parse(src.readStateInitializedAt) : NaN;
    const readStateInitializedAt = Number.isFinite(rawInitMs)
      ? new Date(rawInitMs).toISOString()
      : new Date().toISOString();

    const pinnedSessions = {};
    if (isPlainObject(src.pinnedSessions)) {
      for (const [cid, entry] of Object.entries(src.pinnedSessions)) {
        if (!cid || !isPlainObject(entry)) continue;
        pinnedSessions[cid] = {
          pinnedAt: typeof entry.pinnedAt === 'string' && entry.pinnedAt
            ? entry.pinnedAt
            : new Date().toISOString()
        };
      }
    }

    const sessionProjectOverrides = {};
    if (isPlainObject(src.sessionProjectOverrides)) {
      for (const [cid, pid] of Object.entries(src.sessionProjectOverrides)) {
        if (!cid) continue;
        if (pid === null) {
          sessionProjectOverrides[cid] = null;
        } else if (typeof pid === 'string' && pid.trim()) {
          sessionProjectOverrides[cid] = pid.trim();
        }
      }
    }

    const sessionReadState = {};
    if (isPlainObject(src.sessionReadState)) {
      for (const [cid, entry] of Object.entries(src.sessionReadState)) {
        if (!cid) continue;
        const normalized = normalizeReadEntry(entry);
        if (normalized) sessionReadState[cid] = normalized;
      }
    }

    const sessionCompletionTimes = {};
    if (isPlainObject(src.sessionCompletionTimes)) {
      for (const [cid, entry] of Object.entries(src.sessionCompletionTimes)) {
        if (!cid || !isPlainObject(entry)) continue;
        sessionCompletionTimes[cid] = {
          lastCompletedAt: typeof entry.lastCompletedAt === 'string' && Number.isFinite(Date.parse(entry.lastCompletedAt))
            ? new Date(Date.parse(entry.lastCompletedAt)).toISOString()
            : null,
          lastCompletedStepCount: Number.isFinite(Number(entry.lastCompletedStepCount))
            ? Math.max(0, Math.floor(Number(entry.lastCompletedStepCount)))
            : 0,
          lastStatus: typeof entry.lastStatus === 'string' ? entry.lastStatus : 'CASCADE_RUN_STATUS_IDLE',
          wasRunning: Boolean(entry.wasRunning)
        };
      }
    }

    const userCreatedSessions = {};
    if (isPlainObject(src.userCreatedSessions)) {
      for (const [cid, entry] of Object.entries(src.userCreatedSessions)) {
        if (!cid) continue;
        if (entry === true) {
          userCreatedSessions[cid] = { createdAt: new Date().toISOString() };
        } else if (isPlainObject(entry)) {
          userCreatedSessions[cid] = {
            createdAt: typeof entry.createdAt === 'string' && entry.createdAt
              ? entry.createdAt
              : new Date().toISOString()
          };
        }
      }
    }

    const groups = [];
    const groupIds = new Set();
    if (Array.isArray(src.groups)) {
      for (const g of src.groups) {
        if (!isPlainObject(g) || typeof g.id !== 'string' || !g.id.trim()) continue;
        const id = g.id.trim();
        if (groupIds.has(id)) continue;
        groupIds.add(id);
        groups.push({
          id,
          name: typeof g.name === 'string' && g.name.trim() ? g.name.trim() : 'Untitled Group',
          sortOrder: Number.isFinite(Number(g.sortOrder)) ? Number(g.sortOrder) : groups.length,
          collapsed: Boolean(g.collapsed),
          createdAt: typeof g.createdAt === 'string' ? g.createdAt : new Date().toISOString(),
          updatedAt: typeof g.updatedAt === 'string' ? g.updatedAt : new Date().toISOString()
        });
      }
    }

    const projects = [];
    const projectIds = new Set();
    if (Array.isArray(src.projects)) {
      for (const p of src.projects) {
        if (!isPlainObject(p) || typeof p.id !== 'string' || !p.id.trim()) continue;
        const id = p.id.trim();
        if (projectIds.has(id)) continue;
        const rootPath = normalizeLocalPath(p.rootPath);
        if (!rootPath || isForbiddenSystemRoot(rootPath)) continue;
        projectIds.add(id);
        const gid = typeof p.groupId === 'string' && groupIds.has(p.groupId.trim())
          ? p.groupId.trim()
          : null;
        projects.push({
          id,
          name: typeof p.name === 'string' && p.name.trim()
            ? p.name.trim()
            : path.basename(rootPath) || rootPath,
          rootPath,
          groupId: gid,
          createdAt: typeof p.createdAt === 'string' ? p.createdAt : new Date().toISOString(),
          updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : new Date().toISOString(),
          archived: Boolean(p.archived),
          ...(p.syncedFromApp ? { syncedFromApp: true } : {}),
          ...(typeof p.source === 'string' && p.source.trim() ? { source: p.source.trim() } : {})
        });
      }
    }

    return {
      version: 1,
      defaultSessionPath,
      readStateInitializedAt,
      pinnedSessions,
      sessionProjectOverrides,
      sessionReadState,
      sessionCompletionTimes,
      userCreatedSessions,
      projects,
      groups
    };
  }

  const rawLoadedState = readMetaFromStorage(storage);
  const state = normalizeInitialState(rawLoadedState);

  if (rawLoadedState) {
    orgBridge.migrateWorkspaceMetaV1(rawLoadedState);
  }
  if (!usesExternalOrgBridge) {
    const curOrg = orgBridge.loadPersistedOrg();
    if (!curOrg.defaultSessionPath && state.defaultSessionPath) {
      orgBridge.mutateOrgAtomically((org) => {
        org.defaultSessionPath = state.defaultSessionPath;
      }, { emitChange: false });
    }
  }

  function buildTelemetrySnapshot() {
    return {
      version: 1,
      readStateInitializedAt: state.readStateInitializedAt,
      sessionReadState: cloneReadStateMap(state.sessionReadState),
      sessionCompletionTimes: cloneCompletionMap(state.sessionCompletionTimes),
      userCreatedSessions: cloneUserCreatedMap(state.userCreatedSessions)
    };
  }

  function buildCombinedLegacyState(org) {
    const pinnedSessions = {};
    for (const cid of (org.pins?.sessions || [])) {
      pinnedSessions[cid] = {
        pinnedAt: org.pinTimestamps?.sessions?.[cid] || org.updatedAt || new Date().toISOString()
      };
    }
    const pinnedGroupsSet = new Set(org.pins?.groups || []);
    const pinnedProjectsSet = new Set(org.pins?.projects || []);
    return {
      version: 1,
      defaultSessionPath: org.defaultSessionPath || fallbackDefaultPath,
      readStateInitializedAt: state.readStateInitializedAt,
      pinnedSessions,
      sessionProjectOverrides: { ...(org.sessionProjectOverrides || {}) },
      sessionReadState: cloneReadStateMap(state.sessionReadState),
      sessionCompletionTimes: cloneCompletionMap(state.sessionCompletionTimes),
      userCreatedSessions: cloneUserCreatedMap(state.userCreatedSessions),
      projects: (org.projects || []).map((p) => ({
        ...p,
        groupId: org.projectGroupMap?.[p.id] ?? p.groupId ?? null,
        pinned: pinnedProjectsSet.has(p.id)
      })),
      groups: (org.groups || []).map((g) => ({
        id: g.id,
        name: g.name,
        source: g.source || 'user',
        sortOrder: Number.isFinite(Number(g.order)) ? Number(g.order) : 0,
        order: Number.isFinite(Number(g.order)) ? Number(g.order) : 0,
        collapsed: Boolean(g.collapsed),
        pinned: pinnedGroupsSet.has(g.id),
        createdAt: g.createdAt,
        updatedAt: g.updatedAt
      })),
      pins: org.pins,
      groupOrder: org.groupOrder,
      projectOrder: org.projectOrder,
      sessionOrder: org.sessionOrder,
      archivedSessions: org.archivedSessions,
      deletedSessions: org.deletedSessions
    };
  }

  function persist() {
    if (usesExternalOrgBridge) {
      writeMetaToStorage(storage, buildTelemetrySnapshot());
    } else {
      const org = orgBridge.loadPersistedOrg();
      writeMetaToStorage(storage, buildCombinedLegacyState(org));
    }
  }

  function applyMonotonicReadMap(externalRaw) {
    const externalMap = extractExternalReadMap(externalRaw);
    let changedCount = 0;
    for (const [cid, rawEntry] of Object.entries(externalMap)) {
      const cleanCid = typeof cid === 'string' ? cid.trim() : '';
      if (!cleanCid) continue;
      const incoming = normalizeReadEntry(rawEntry);
      if (!incoming) continue;
      const prev = state.sessionReadState[cleanCid] || null;
      const merged = mergeReadEntries(prev, incoming);
      if (
        !prev
        || merged.lastReadAt !== prev.lastReadAt
        || merged.lastReadStepCount !== prev.lastReadStepCount
      ) {
        state.sessionReadState[cleanCid] = merged;
        changedCount += 1;
      }
    }
    return changedCount;
  }

  function syncSharedReadStateFromDisk() {
    if (!resolvedSharedReadStatePath) return 0;
    try {
      if (!fs.existsSync(resolvedSharedReadStatePath)) return 0;
      const text = fs.readFileSync(resolvedSharedReadStatePath, 'utf8');
      if (!text.trim()) return 0;
      const parsed = JSON.parse(text);
      return applyMonotonicReadMap(parsed);
    } catch {
      return 0;
    }
  }

  function writeSharedReadStateToDisk() {
    if (!resolvedSharedReadStatePath) return;
    const dir = path.dirname(resolvedSharedReadStatePath);
    const tmpPath = `${resolvedSharedReadStatePath}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const payload = {
        version: 1,
        updatedAt: new Date().toISOString(),
        sessions: cloneReadStateMap(state.sessionReadState)
      };
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmpPath, resolvedSharedReadStatePath);
    } catch {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // Ignore cleanup failure
      }
    }
  }

  function loadConversationSummaryMap() {
    if (!resolvedConversationDbPath) return new Map();
    const nowMs = now();
    if (dbCache.cachedAt !== null && (nowMs - dbCache.cachedAt) < dbCacheTtlMs) {
      return dbCache.byId;
    }
    const rows = readConversationRowsFromDb(resolvedConversationDbPath);
    const byId = new Map();
    for (const row of rows) {
      if (!isPlainObject(row) || typeof row.conversation_id !== 'string' || !row.conversation_id.trim()) {
        continue;
      }
      byId.set(row.conversation_id.trim(), row);
    }
    dbCache.cachedAt = nowMs;
    dbCache.byId = byId;
    return byId;
  }

  function getDefaultSessionPath(org = null) {
    const activeOrg = org || orgBridge.loadPersistedOrg();
    return activeOrg.defaultSessionPath || state.defaultSessionPath || fallbackDefaultPath;
  }

  function loadAppSyncedProjects() {
    if (!resolvedStateVscdbPath && !resolvedConversationDbPath) {
      return [];
    }
    const nowMs = now();
    if (appSyncCache.cachedAt !== null && (nowMs - appSyncCache.cachedAt) < appSyncCacheTtlMs) {
      return appSyncCache.projects.map((p) => ({ ...p }));
    }

    const defaultKeys = getPathLookupKeys(getDefaultSessionPath());
    const byKey = new Map();
    const collected = [];

    const ensureEntry = (normPath) => {
      if (!normPath || isForbiddenSystemRoot(normPath) || isTempAppWorkspacePath(normPath)) {
        return null;
      }
      const keys = getPathLookupKeys(normPath);
      if (keys.some((k) => defaultKeys.includes(k))) {
        return null;
      }
      for (const k of keys) {
        const hit = byKey.get(k);
        if (hit) return hit;
      }
      const entry = {
        id: makeAppSyncedProjectId(normPath),
        name: path.basename(normPath) || normPath,
        rootPath: normPath,
        groupId: null,
        implicit: false,
        syncedFromApp: true,
        source: 'app',
        dbSessionCount: 0,
        lastModifiedTime: null
      };
      for (const k of keys) {
        byKey.set(k, entry);
      }
      collected.push(entry);
      return entry;
    };

    if (resolvedStateVscdbPath) {
      const vscdbRows = runReadOnlySqliteQuery(resolvedStateVscdbPath, VSCDB_SIDEBAR_SQL);
      for (const row of vscdbRows) {
        const uris = extractSidebarFileUrisFromValue(row?.value);
        for (const uri of uris) {
          const normPath = normalizeLocalPath(uri);
          ensureEntry(normPath);
        }
      }
    }

    if (resolvedConversationDbPath) {
      const convRows = runReadOnlySqliteQuery(resolvedConversationDbPath, CONVERSATION_PROJECTS_SQL);
      for (const row of convRows) {
        if (!isPlainObject(row)) continue;
        const uris = parseAllWorkspaceUrisFromDb(row.workspace_uris);
        const rowEntries = new Set();
        for (const uri of uris) {
          const normPath = normalizeLocalPath(uri);
          const entry = ensureEntry(normPath);
          if (entry) rowEntries.add(entry);
        }
        const rowCount = Number(row.session_count || 0);
        const rowLmt = typeof row.max_last_modified_time === 'string' && row.max_last_modified_time.trim()
          ? row.max_last_modified_time.trim()
          : null;
        for (const entry of rowEntries) {
          if (Number.isFinite(rowCount) && rowCount > 0) {
            entry.dbSessionCount += rowCount;
          }
          if (rowLmt && toTimestampMs(rowLmt) > toTimestampMs(entry.lastModifiedTime)) {
            entry.lastModifiedTime = rowLmt;
          }
        }
      }
    }

    appSyncCache.cachedAt = nowMs;
    appSyncCache.projects = collected;
    return collected.map((p) => ({ ...p }));
  }

  const initialSharedChanges = syncSharedReadStateFromDisk();
  if (storage && (!rawLoadedState || !rawLoadedState.readStateInitializedAt || initialSharedChanges > 0)) {
    persist();
  }

  function buildRegisteredLookup(org = null) {
    const activeOrg = org || orgBridge.loadPersistedOrg();
    const byId = new Map();
    const byPathKey = new Map();
    const pinnedSet = new Set(activeOrg.pins?.projects || []);
    for (const rawProj of (activeOrg.projects || [])) {
      const proj = {
        ...rawProj,
        groupId: activeOrg.projectGroupMap?.[rawProj.id] ?? rawProj.groupId ?? null,
        pinned: pinnedSet.has(rawProj.id)
      };
      byId.set(proj.id, proj);
      if (Array.isArray(proj.aliases)) {
        for (const alias of proj.aliases) {
          if (!byId.has(alias)) byId.set(alias, proj);
        }
      }
      for (const key of getPathLookupKeys(proj.rootPath)) {
        if (!byPathKey.has(key)) {
          byPathKey.set(key, proj);
        }
      }
    }
    return { byId, byPathKey, org: activeOrg };
  }

  function findRegisteredByRoot(normPath, lookup) {
    for (const key of getPathLookupKeys(normPath)) {
      const hit = lookup.byPathKey.get(key);
      if (hit) return hit;
    }
    return null;
  }

  function buildAppSyncedLookup(registeredLookup) {
    const list = [];
    const byId = new Map();
    const byPathKey = new Map();
    for (const appProj of loadAppSyncedProjects()) {
      if (registeredLookup && findRegisteredByRoot(appProj.rootPath, registeredLookup)) {
        continue;
      }
      if (registeredLookup && registeredLookup.byId.has(appProj.id)) {
        continue;
      }
      list.push(appProj);
      byId.set(appProj.id, appProj);
      for (const key of getPathLookupKeys(appProj.rootPath)) {
        if (!byPathKey.has(key)) {
          byPathKey.set(key, appProj);
        }
      }
    }
    return { list, byId, byPathKey };
  }

  function resolveSessionAssignment(session, lookup, implicitByKey = null, appSyncedLookup = null) {
    const activeOrg = lookup.org || orgBridge.loadPersistedOrg();
    const overrides = activeOrg.sessionProjectOverrides || {};
    const cascadeId = session?.cascadeId;
    if (cascadeId && Object.prototype.hasOwnProperty.call(overrides, cascadeId)) {
      const overrideId = overrides[cascadeId];
      if (overrideId === null) {
        return { projectId: null, projectName: null, implicitProject: null };
      }
      const overrideProj = lookup.byId.get(overrideId)
        || appSyncedLookup?.byId.get(overrideId)
        || knownImplicitProjectsById.get(overrideId)
        || null;
      if (overrideProj) {
        return { projectId: overrideProj.id, projectName: overrideProj.name, implicitProject: null };
      }
      return { projectId: null, projectName: null, implicitProject: null };
    }

    const rawWs = session?.workspaceUri;
    const normWs = normalizeLocalPath(rawWs);
    if (!normWs || isForbiddenSystemRoot(normWs)) {
      return { projectId: null, projectName: null, implicitProject: null };
    }

    const regMatch = findRegisteredByRoot(normWs, lookup);
    if (regMatch) {
      return { projectId: regMatch.id, projectName: regMatch.name, implicitProject: null };
    }

    if (appSyncedLookup) {
      const appMatch = findRegisteredByRoot(normWs, appSyncedLookup);
      if (appMatch) {
        return { projectId: appMatch.id, projectName: appMatch.name, implicitProject: null };
      }
    }

    const keys = getPathLookupKeys(normWs);
    const defaultKeys = getPathLookupKeys(getDefaultSessionPath(activeOrg));
    if (keys.some((k) => defaultKeys.includes(k))) {
      return { projectId: null, projectName: null, implicitProject: null };
    }
    if (implicitByKey) {
      for (const key of keys) {
        const existing = implicitByKey.get(key);
        if (existing) {
          knownImplicitProjectsById.set(existing.id, existing);
          return {
            projectId: existing.id,
            projectName: existing.name,
            implicitProject: existing
          };
        }
      }
    }

    const displayName = (typeof session?.repoName === 'string' && session.repoName.trim())
      || path.basename(normWs)
      || normWs;
    const implicitId = makeImplicitProjectId(normWs);
    const implicitObj = {
      id: implicitId,
      name: displayName,
      rootPath: normWs,
      groupId: null,
      implicit: true,
      sessionCount: 0
    };
    knownImplicitProjectsById.set(implicitId, implicitObj);
    if (implicitByKey) {
      for (const key of keys) {
        implicitByKey.set(key, implicitObj);
      }
    }
    return { projectId: implicitId, projectName: displayName, implicitProject: implicitObj };
  }

  function sortedGroups(org = null) {
    const activeOrg = org || orgBridge.loadPersistedOrg();
    const pinnedSet = new Set(activeOrg.pins?.groups || []);
    const pinnedOrder = Array.isArray(activeOrg.groupOrder?.pinned) ? activeOrg.groupOrder.pinned : [];
    const normalOrder = Array.isArray(activeOrg.groupOrder?.normal) ? activeOrg.groupOrder.normal : [];
    const pinnedIdx = new Map(pinnedOrder.map((id, idx) => [id, idx]));
    const normalIdx = new Map(normalOrder.map((id, idx) => [id, idx]));

    return (activeOrg.groups || [])
      .map((g) => ({
        ...g,
        sortOrder: Number.isFinite(Number(g.order)) ? Number(g.order) : 0,
        pinned: pinnedSet.has(g.id)
      }))
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        if (a.pinned) {
          const ia = pinnedIdx.has(a.id) ? pinnedIdx.get(a.id) : Number.MAX_SAFE_INTEGER;
          const ib = pinnedIdx.has(b.id) ? pinnedIdx.get(b.id) : Number.MAX_SAFE_INTEGER;
          if (ia !== ib) return ia - ib;
        } else {
          const ia = normalIdx.has(a.id) ? normalIdx.get(a.id) : Number.MAX_SAFE_INTEGER;
          const ib = normalIdx.has(b.id) ? normalIdx.get(b.id) : Number.MAX_SAFE_INTEGER;
          if (ia !== ib) return ia - ib;
        }
        const orderDiff = (a.sortOrder - b.sortOrder);
        if (orderDiff !== 0) return orderDiff;
        return toTimestampMs(a.createdAt) - toTimestampMs(b.createdAt);
      });
  }

  function getState() {
    const org = orgBridge.loadPersistedOrg();
    return buildCombinedLegacyState(org);
  }

  function listProjectsAndGroups(discoveredSessions = []) {
    const org = orgBridge.loadPersistedOrg();
    const lookup = buildRegisteredLookup(org);
    const appSyncedLookup = buildAppSyncedLookup(lookup);
    const countsByProjectId = new Map();
    const implicitByKey = new Map();
    const implicitList = [];
    const pinnedProjectsSet = new Set(org.pins?.projects || []);

    const rawSessions = Array.isArray(discoveredSessions) ? discoveredSessions : [];
    const sessions = rawSessions.length > 0
      ? enrichSessionsWithMeta(rawSessions, { includeInternal: false }).sessions
      : [];
    for (const session of sessions) {
      if (!session || typeof session !== 'object') continue;
      const beforeSize = implicitByKey.size;
      const resolved = resolveSessionAssignment(session, lookup, implicitByKey, appSyncedLookup);
      if (resolved.implicitProject && implicitByKey.size > beforeSize) {
        if (!implicitList.some((p) => p.id === resolved.implicitProject.id)) {
          implicitList.push(resolved.implicitProject);
        }
      }
      if (resolved.projectId) {
        countsByProjectId.set(
          resolved.projectId,
          (countsByProjectId.get(resolved.projectId) || 0) + 1
        );
      }
    }

    const registered = (org.projects || []).map((p) => ({
      ...p,
      groupId: org.projectGroupMap?.[p.id] ?? p.groupId ?? null,
      pinned: pinnedProjectsSet.has(p.id),
      implicit: false,
      sessionCount: countsByProjectId.get(p.id) || 0
    }));

    const appSynced = appSyncedLookup.list.map((p) => ({
      id: p.id,
      name: p.name,
      rootPath: p.rootPath,
      groupId: org.projectGroupMap?.[p.id] ?? null,
      pinned: pinnedProjectsSet.has(p.id),
      implicit: false,
      syncedFromApp: true,
      source: 'app',
      sessionCount: Math.max(countsByProjectId.get(p.id) || 0, p.dbSessionCount || 0),
      ...(p.lastModifiedTime ? { lastModifiedTime: p.lastModifiedTime } : {})
    }));

    const implicit = implicitList.map((p) => ({
      ...p,
      groupId: org.projectGroupMap?.[p.id] ?? p.groupId ?? null,
      pinned: pinnedProjectsSet.has(p.id),
      sessionCount: countsByProjectId.get(p.id) || 0
    }));

    return {
      ok: true,
      version: 2,
      revision: org.revision,
      projects: [...registered, ...appSynced, ...implicit],
      groups: sortedGroups(org),
      pins: org.pins,
      groupOrder: org.groupOrder,
      projectOrder: org.projectOrder,
      sessionOrder: org.sessionOrder,
      archivedCount: Object.keys(org.archivedSessions || {}).length,
      defaultSessionPath: getDefaultSessionPath(org)
    };
  }

  function createProject({ name, rootPath, groupId = null, createDir = false, source = 'local', remote = null } = {}) {
    const normalizedRoot = normalizeLocalPath(rootPath);
    if (!normalizedRoot) {
      return { ok: false, statusCode: 400, error: 'INVALID_PATH' };
    }
    if (isForbiddenSystemRoot(normalizedRoot)) {
      return { ok: false, statusCode: 403, error: 'FORBIDDEN_SYSTEM_ROOT' };
    }

    if (createDir) {
      const ancestor = findDeepestExistingAncestor(normalizedRoot);
      const realAncestor = safeRealpath(ancestor);
      if (!realAncestor || isForbiddenSystemRoot(realAncestor)) {
        return { ok: false, statusCode: 403, error: 'FORBIDDEN_SYSTEM_ROOT' };
      }
      try {
        fs.mkdirSync(normalizedRoot, { recursive: true });
      } catch (err) {
        return {
          ok: false,
          statusCode: 400,
          error: 'CREATE_DIR_FAILED',
          message: err && err.message ? err.message : 'CREATE_DIR_FAILED'
        };
      }
    }

    let realRoot;
    try {
      realRoot = fs.realpathSync(normalizedRoot);
    } catch {
      return { ok: false, statusCode: 404, error: 'ROOT_NOT_FOUND' };
    }

    if (isForbiddenSystemRoot(realRoot)) {
      return { ok: false, statusCode: 403, error: 'FORBIDDEN_SYSTEM_ROOT' };
    }

    let stat;
    try {
      stat = fs.statSync(realRoot);
    } catch {
      return { ok: false, statusCode: 404, error: 'ROOT_NOT_FOUND' };
    }
    if (!stat.isDirectory()) {
      return { ok: false, statusCode: 400, error: 'ROOT_NOT_DIRECTORY' };
    }

    const cleanName = typeof name === 'string' && name.trim()
      ? name.trim()
      : (path.basename(normalizedRoot) || normalizedRoot);
    const cleanSource = typeof source === 'string' && source.trim() ? source.trim() : 'local';

    const outcome = orgBridge.mutateOrgAtomically((org) => {
      let resolvedGroupId = null;
      if (groupId !== undefined && groupId !== null && groupId !== '') {
        const cleanGid = String(groupId).trim();
        if (!org.groups.some((g) => g.id === cleanGid)) {
          return { abort: true, result: { ok: false, statusCode: 404, error: 'GROUP_NOT_FOUND' } };
        }
        resolvedGroupId = cleanGid;
      }

      const lookup = buildRegisteredLookup(org);
      const duplicate = findRegisteredByRoot(normalizedRoot, lookup) || findRegisteredByRoot(realRoot, lookup);
      if (duplicate) {
        return {
          abort: true,
          result: {
            ok: false,
            statusCode: 409,
            error: 'PROJECT_ALREADY_EXISTS',
            project: { ...duplicate }
          }
        };
      }

      const projectId = `proj_${crypto.randomUUID()}`;
      const project = orgBridge.materializeProjectInOrg(org, {
        id: projectId,
        name: cleanName,
        rootPath: normalizedRoot,
        groupId: resolvedGroupId,
        source: cleanSource,
        remote,
        syncedFromApp: false
      });

      const containerKey = resolvedGroupId || '__ungrouped__';
      if (org.projectOrder[containerKey] && Array.isArray(org.projectOrder[containerKey].normal)) {
        org.projectOrder[containerKey].normal = [
          project.id,
          ...org.projectOrder[containerKey].normal.filter((x) => x !== project.id)
        ];
      }

      return {
        buildResult: () => ({ ok: true, project: { ...project, archived: false } })
      };
    });

    if (!outcome || outcome.ok === false) {
      return outcome;
    }

    persist();
    const listed = listProjectsAndGroups();
    return {
      ok: true,
      project: outcome.project,
      projects: listed.projects,
      groups: listed.groups,
      pins: listed.pins,
      revision: listed.revision,
      defaultSessionPath: listed.defaultSessionPath
    };
  }

  function resolveProjectCandidate(cleanId, opts = {}, org = null) {
    if (!cleanId) return null;
    const activeOrg = org || orgBridge.loadPersistedOrg();
    const lookup = buildRegisteredLookup(activeOrg);
    const registered = lookup.byId.get(cleanId);
    if (registered) return registered;

    const appSynced = loadAppSyncedProjects().find((p) => p.id === cleanId);
    if (appSynced) return appSynced;

    const cachedImplicit = knownImplicitProjectsById.get(cleanId);
    if (cachedImplicit) return cachedImplicit;

    const rawPath = opts?.workspaceUri || opts?.rootPath;
    if (typeof rawPath === 'string' && rawPath.trim()) {
      const normPath = normalizeLocalPath(rawPath);
      if (normPath && !isForbiddenSystemRoot(normPath)) {
        const regByRoot = findRegisteredByRoot(normPath, lookup);
        if (regByRoot && (regByRoot.id === cleanId || (regByRoot.aliases || []).includes(cleanId))) {
          return regByRoot;
        }

        if (
          cleanId.startsWith('app:')
          || cleanId.startsWith('implicit:')
          || cleanId.startsWith('ws:')
          || makeAppSyncedProjectId(normPath) === cleanId
          || makeImplicitProjectId(normPath) === cleanId
        ) {
          const isApp = cleanId.startsWith('app:');
          return {
            id: cleanId,
            name: path.basename(normPath) || normPath,
            rootPath: normPath,
            groupId: null,
            implicit: !isApp,
            ...(isApp ? { syncedFromApp: true, source: 'app' } : {})
          };
        }
      }
    }
    return null;
  }

  function updateProject(id, patch = {}) {
    const cleanId = typeof id === 'string' ? id.trim() : '';
    if (!isPlainObject(patch)) {
      return { ok: false, statusCode: 400, error: 'INVALID_PATCH' };
    }

    const outcome = orgBridge.mutateOrgAtomically((org) => {
      const lookup = buildRegisteredLookup(org);
      let existing = lookup.byId.get(cleanId) || null;
      let candidate = null;
      if (!existing) {
        candidate = resolveProjectCandidate(cleanId, patch, org);
        if (!candidate) {
          return { abort: true, result: { ok: false, statusCode: 404, error: 'PROJECT_NOT_FOUND' } };
        }
      }

      if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
        const cleanName = typeof patch.name === 'string' ? patch.name.trim() : '';
        if (!cleanName) {
          return { abort: true, result: { ok: false, statusCode: 400, error: 'INVALID_PROJECT_NAME' } };
        }
      }

      let nextGroupId;
      let hasGroupChange = false;
      if (Object.prototype.hasOwnProperty.call(patch, 'groupId')) {
        hasGroupChange = true;
        if (patch.groupId === null || patch.groupId === '') {
          nextGroupId = null;
        } else {
          const cleanGid = String(patch.groupId).trim();
          if (!org.groups.some((g) => g.id === cleanGid)) {
            return { abort: true, result: { ok: false, statusCode: 404, error: 'GROUP_NOT_FOUND' } };
          }
          nextGroupId = cleanGid;
        }
      }

      const targetProj = existing
        ? org.projects.find((p) => p.id === existing.id)
        : orgBridge.materializeProjectInOrg(org, candidate);

      if (!targetProj) {
        return { abort: true, result: { ok: false, statusCode: 404, error: 'PROJECT_NOT_FOUND' } };
      }

      if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
        targetProj.name = patch.name.trim();
      }
      if (hasGroupChange) {
        const prevGid = org.projectGroupMap[targetProj.id] || '__ungrouped__';
        targetProj.groupId = nextGroupId;
        if (nextGroupId) org.projectGroupMap[targetProj.id] = nextGroupId;
        else delete org.projectGroupMap[targetProj.id];
        for (const g of org.groups) {
          g.projectIds = g.projectIds.filter((pid) => pid !== targetProj.id);
          if (nextGroupId && g.id === nextGroupId) g.projectIds.push(targetProj.id);
        }
        const nextGidKey = nextGroupId || '__ungrouped__';
        if (prevGid !== nextGidKey) {
          const isPinned = org.pins.projects.includes(targetProj.id);
          if (org.projectOrder[prevGid]) {
            org.projectOrder[prevGid].pinned = org.projectOrder[prevGid].pinned.filter((x) => x !== targetProj.id);
            org.projectOrder[prevGid].normal = org.projectOrder[prevGid].normal.filter((x) => x !== targetProj.id);
          }
          if (org.projectOrder[nextGidKey]) {
            if (isPinned) org.projectOrder[nextGidKey].pinned.push(targetProj.id);
            else org.projectOrder[nextGidKey].normal.unshift(targetProj.id);
          }
        }
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'pinned')) {
        const shouldPin = Boolean(patch.pinned);
        if (shouldPin && !org.pins.projects.includes(targetProj.id)) {
          org.pins.projects.push(targetProj.id);
          org.pinTimestamps.projects[targetProj.id] = new Date().toISOString();
        } else if (!shouldPin) {
          org.pins.projects = org.pins.projects.filter((pid) => pid !== targetProj.id);
          delete org.pinTimestamps.projects[targetProj.id];
        }
      }
      targetProj.updatedAt = new Date().toISOString();
      knownImplicitProjectsById.delete(cleanId);

      const snapshot = {
        ...targetProj,
        implicit: false,
        pinned: org.pins.projects.includes(targetProj.id),
        archived: Object.prototype.hasOwnProperty.call(patch, 'archived') ? Boolean(patch.archived) : false
      };

      return {
        buildResult: () => ({ ok: true, project: snapshot })
      };
    });

    if (!outcome || outcome.ok === false) {
      return outcome;
    }

    persist();
    const listed = listProjectsAndGroups();
    return {
      ok: true,
      project: outcome.project,
      projects: listed.projects,
      groups: listed.groups,
      pins: listed.pins,
      revision: listed.revision,
      defaultSessionPath: listed.defaultSessionPath
    };
  }

  function deleteProject(id) {
    const cleanId = typeof id === 'string' ? id.trim() : '';
    const outcome = orgBridge.mutateOrgAtomically((org) => {
      const idx = org.projects.findIndex((p) => p.id === cleanId || (Array.isArray(p.aliases) && p.aliases.includes(cleanId)));
      if (idx < 0) {
        return { abort: true, result: { ok: false, statusCode: 404, error: 'PROJECT_NOT_FOUND' } };
      }
      const targetId = org.projects[idx].id;
      const aliases = org.projects[idx].aliases || [];
      const removeIds = new Set([cleanId, targetId, ...aliases]);
      org.projects.splice(idx, 1);
      org.pins.projects = org.pins.projects.filter((pid) => !removeIds.has(pid));
      for (const rid of removeIds) {
        delete org.pinTimestamps.projects[rid];
        delete org.projectGroupMap[rid];
        delete org.sessionOrder[rid];
      }
      for (const g of org.groups) {
        g.projectIds = g.projectIds.filter((pid) => !removeIds.has(pid));
      }
      for (const ord of Object.values(org.projectOrder)) {
        if (!ord) continue;
        ord.pinned = (ord.pinned || []).filter((pid) => !removeIds.has(pid));
        ord.normal = (ord.normal || []).filter((pid) => !removeIds.has(pid));
      }
      for (const [cid, pid] of Object.entries(org.sessionProjectOverrides)) {
        if (removeIds.has(pid)) {
          delete org.sessionProjectOverrides[cid];
        }
      }
      return {
        buildResult: () => ({ ok: true, id: targetId, deleted: true })
      };
    });

    if (outcome?.ok) persist();
    return outcome;
  }

  function createGroup({ name } = {}) {
    const cleanName = typeof name === 'string' ? name.trim() : '';
    if (!cleanName) {
      return { ok: false, statusCode: 400, error: 'INVALID_GROUP_NAME' };
    }

    const outcome = orgBridge.mutateOrgAtomically((org) => {
      const maxOrder = org.groups.reduce(
        (max, g) => (Number.isFinite(g.order) && g.order > max ? g.order : max),
        -1
      );
      const nowIso = new Date().toISOString();
      const group = {
        id: `grp_${crypto.randomUUID()}`,
        name: cleanName,
        source: 'user',
        order: maxOrder + 1,
        collapsed: false,
        projectIds: [],
        workspaceUris: [],
        sessionIds: [],
        createdAt: nowIso,
        updatedAt: nowIso
      };
      org.groups.push(group);
      if (org.groupOrder.normal.length > 0) {
        org.groupOrder.normal.push(group.id);
      }
      return {
        buildResult: () => ({ ok: true, group: { ...group, sortOrder: group.order, pinned: false } })
      };
    });

    if (!outcome || outcome.ok === false) return outcome;
    persist();
    const listed = listProjectsAndGroups();
    return {
      ok: true,
      group: outcome.group,
      projects: listed.projects,
      groups: listed.groups,
      pins: listed.pins,
      revision: listed.revision
    };
  }

  function updateGroup(id, patch = {}) {
    const cleanId = typeof id === 'string' ? id.trim() : '';
    if (!isPlainObject(patch)) {
      return { ok: false, statusCode: 400, error: 'INVALID_PATCH' };
    }

    const outcome = orgBridge.mutateOrgAtomically((org) => {
      const idx = org.groups.findIndex((g) => g.id === cleanId);
      if (idx < 0) {
        return { abort: true, result: { ok: false, statusCode: 404, error: 'GROUP_NOT_FOUND' } };
      }
      const next = { ...org.groups[idx] };
      if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
        const cleanName = typeof patch.name === 'string' ? patch.name.trim() : '';
        if (!cleanName) {
          return { abort: true, result: { ok: false, statusCode: 400, error: 'INVALID_GROUP_NAME' } };
        }
        next.name = cleanName;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'collapsed')) {
        next.collapsed = Boolean(patch.collapsed);
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'sortOrder') || Object.prototype.hasOwnProperty.call(patch, 'order')) {
        const rawOrd = Object.prototype.hasOwnProperty.call(patch, 'sortOrder') ? patch.sortOrder : patch.order;
        const n = Number(rawOrd);
        if (!Number.isFinite(n)) {
          return { abort: true, result: { ok: false, statusCode: 400, error: 'INVALID_SORT_ORDER' } };
        }
        next.order = n;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'pinned')) {
        const shouldPin = Boolean(patch.pinned);
        if (shouldPin && !org.pins.groups.includes(cleanId)) {
          org.pins.groups.push(cleanId);
          org.pinTimestamps.groups[cleanId] = new Date().toISOString();
        } else if (!shouldPin) {
          org.pins.groups = org.pins.groups.filter((gid) => gid !== cleanId);
          delete org.pinTimestamps.groups[cleanId];
        }
      }
      next.updatedAt = new Date().toISOString();
      org.groups[idx] = next;
      return {
        buildResult: () => ({
          ok: true,
          group: {
            ...next,
            sortOrder: next.order,
            pinned: org.pins.groups.includes(next.id)
          }
        })
      };
    });

    if (!outcome || outcome.ok === false) return outcome;
    persist();
    const listed = listProjectsAndGroups();
    return {
      ok: true,
      group: outcome.group,
      projects: listed.projects,
      groups: listed.groups,
      pins: listed.pins,
      revision: listed.revision
    };
  }

  function deleteGroup(id) {
    const cleanId = typeof id === 'string' ? id.trim() : '';
    const cur = orgBridge.loadPersistedOrg();
    if (!cur.groups.some((g) => g.id === cleanId)) {
      return { ok: false, statusCode: 404, error: 'GROUP_NOT_FOUND' };
    }
    const res = orgBridge.mutateGroup({ action: 'delete', id: cleanId });
    if (res?.ok) persist();
    return { ok: true, id: cleanId, deleted: true, revision: res?.revision };
  }

  function setSessionPin(cascadeId, pinned) {
    const cleanId = typeof cascadeId === 'string' ? cascadeId.trim() : '';
    if (!cleanId) {
      return { ok: false, statusCode: 400, error: 'INVALID_CASCADE_ID' };
    }
    const res = orgBridge.togglePin({ type: 'session', id: cleanId, pinned: Boolean(pinned) });
    if (!res?.ok) return res;
    persist();
    return {
      ok: true,
      cascadeId: cleanId,
      pinned: res.pinned,
      pinnedAt: res.pinnedAt,
      pins: res.pins,
      revision: res.revision
    };
  }

  function assignSessionProject(cascadeId, projectId, opts = {}) {
    const cleanCid = typeof cascadeId === 'string' ? cascadeId.trim() : '';
    if (!cleanCid) {
      return { ok: false, statusCode: 400, error: 'INVALID_CASCADE_ID' };
    }

    if (projectId === null || projectId === undefined || projectId === '') {
      const outcome = orgBridge.mutateOrgAtomically((org) => {
        org.sessionProjectOverrides[cleanCid] = null;
        return { buildResult: (saved) => ({ ok: true, cascadeId: cleanCid, projectId: null, revision: saved.revision }) };
      });
      if (outcome?.ok) persist();
      return outcome;
    }

    const cleanPid = String(projectId).trim();
    const outcome = orgBridge.mutateOrgAtomically((org) => {
      const lookup = buildRegisteredLookup(org);
      let resolvedPid = cleanPid;
      const existing = lookup.byId.get(cleanPid);
      if (existing) {
        resolvedPid = existing.id;
      } else {
        const candidate = resolveProjectCandidate(cleanPid, opts, org);
        if (!candidate) {
          return { abort: true, result: { ok: false, statusCode: 404, error: 'PROJECT_NOT_FOUND' } };
        }
        const materialized = orgBridge.materializeProjectInOrg(org, candidate);
        resolvedPid = materialized ? materialized.id : cleanPid;
      }
      org.sessionProjectOverrides[cleanCid] = resolvedPid;
      return {
        buildResult: (saved) => ({ ok: true, cascadeId: cleanCid, projectId: resolvedPid, revision: saved.revision })
      };
    });

    if (outcome?.ok) persist();
    return outcome;
  }

  function setDefaultSessionPath(dirPath) {
    const normalized = normalizeLocalPath(dirPath);
    if (!normalized) {
      return { ok: false, statusCode: 400, error: 'INVALID_PATH' };
    }
    if (isForbiddenSystemRoot(normalized)) {
      return { ok: false, statusCode: 403, error: 'FORBIDDEN_SYSTEM_ROOT' };
    }

    const real = safeRealpath(normalized);
    if (real) {
      if (isForbiddenSystemRoot(real)) {
        return { ok: false, statusCode: 403, error: 'FORBIDDEN_SYSTEM_ROOT' };
      }
      try {
        if (!fs.statSync(real).isDirectory()) {
          return { ok: false, statusCode: 400, error: 'ROOT_NOT_DIRECTORY' };
        }
      } catch {
        return { ok: false, statusCode: 400, error: 'INVALID_PATH' };
      }
    } else {
      const ancestor = findDeepestExistingAncestor(normalized);
      const realAncestor = safeRealpath(ancestor);
      if (realAncestor && isForbiddenSystemRoot(realAncestor)) {
        return { ok: false, statusCode: 403, error: 'FORBIDDEN_SYSTEM_ROOT' };
      }
    }

    const outcome = orgBridge.mutateOrgAtomically((org) => {
      org.defaultSessionPath = normalized;
      return { buildResult: (saved) => ({ ok: true, defaultSessionPath: saved.defaultSessionPath, revision: saved.revision }) };
    });
    if (outcome?.ok) {
      state.defaultSessionPath = normalized;
      persist();
    }
    return outcome;
  }

  function getProjectById(id, opts = {}) {
    const cleanId = typeof id === 'string' ? id.trim() : '';
    const found = resolveProjectCandidate(cleanId, opts);
    return found ? { ...found } : null;
  }

  function getProjectRootPaths() {
    const org = orgBridge.loadPersistedOrg();
    const out = [];
    const seen = new Set();
    for (const proj of (org.projects || [])) {
      const key = canonicalKey(proj.rootPath);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(proj.rootPath);
      }
    }
    for (const proj of loadAppSyncedProjects()) {
      const key = canonicalKey(proj.rootPath);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(proj.rootPath);
      }
    }
    return out;
  }

  function recordUserCreatedSession(cascadeId) {
    const cleanCid = typeof cascadeId === 'string' ? cascadeId.trim() : '';
    if (!cleanCid) {
      return { ok: false, statusCode: 400, error: 'INVALID_CASCADE_ID' };
    }
    const createdAt = state.userCreatedSessions[cleanCid]?.createdAt || new Date().toISOString();
    state.userCreatedSessions[cleanCid] = { createdAt };
    persist();
    return { ok: true, cascadeId: cleanCid, createdAt };
  }

  function recordSessionCompletion(cascadeId, { completedAt, stepCount } = {}) {
    const cleanCid = typeof cascadeId === 'string' ? cascadeId.trim() : '';
    if (!cleanCid) {
      return { ok: false, statusCode: 400, error: 'INVALID_CASCADE_ID' };
    }
    const parsedMs = typeof completedAt === 'string' ? Date.parse(completedAt) : NaN;
    const lastCompletedAt = Number.isFinite(parsedMs)
      ? new Date(parsedMs).toISOString()
      : new Date().toISOString();
    const prev = state.sessionCompletionTimes[cleanCid] || null;
    const resolvedStepCount = Number.isFinite(Number(stepCount)) && Number(stepCount) >= 0
      ? Math.floor(Number(stepCount))
      : (prev?.lastCompletedStepCount ?? lastSeenStepCounts.get(cleanCid) ?? 0);
    const entry = {
      lastCompletedAt,
      lastCompletedStepCount: resolvedStepCount,
      lastStatus: 'CASCADE_RUN_STATUS_IDLE',
      wasRunning: false
    };
    state.sessionCompletionTimes[cleanCid] = entry;
    persist();
    return { ok: true, cascadeId: cleanCid, ...entry };
  }

  function markSessionRead(cascadeId, { lastReadAt, lastReadStepCount } = {}) {
    const cleanCid = typeof cascadeId === 'string' ? cascadeId.trim() : '';
    if (!cleanCid) {
      return { ok: false, statusCode: 400, error: 'INVALID_CASCADE_ID' };
    }
    syncSharedReadStateFromDisk();

    const parsedMs = typeof lastReadAt === 'string' ? Date.parse(lastReadAt) : NaN;
    const resolvedReadAt = Number.isFinite(parsedMs)
      ? new Date(parsedMs).toISOString()
      : new Date().toISOString();

    const existing = state.sessionReadState[cleanCid] || null;
    const hasExplicitStep = lastReadStepCount !== undefined
      && lastReadStepCount !== null
      && Number.isFinite(Number(lastReadStepCount));
    const fallbackStep = lastSeenStepCounts.get(cleanCid)
      ?? state.sessionCompletionTimes[cleanCid]?.lastCompletedStepCount
      ?? existing?.lastReadStepCount
      ?? 0;
    const resolvedStep = hasExplicitStep
      ? Math.max(0, Math.floor(Number(lastReadStepCount)))
      : Math.max(0, Math.floor(Number(fallbackStep)));

    const merged = mergeReadEntries(existing, {
      lastReadAt: resolvedReadAt,
      lastReadStepCount: resolvedStep
    });
    state.sessionReadState[cleanCid] = merged;
    persist();
    writeSharedReadStateToDisk();

    return {
      ok: true,
      cascadeId: cleanCid,
      lastReadAt: merged.lastReadAt,
      lastReadStepCount: merged.lastReadStepCount,
      readState: { ...merged }
    };
  }

  function mergeExternalReadState(externalMap) {
    syncSharedReadStateFromDisk();
    const changedCount = applyMonotonicReadMap(externalMap);
    if (changedCount > 0) {
      persist();
      writeSharedReadStateToDisk();
    }
    return {
      ok: true,
      changedCount,
      sessions: cloneReadStateMap(state.sessionReadState)
    };
  }

  function getReadStateSnapshot() {
    const diskChanges = syncSharedReadStateFromDisk();
    if (diskChanges > 0) {
      persist();
    }
    return {
      ok: true,
      readStateInitializedAt: state.readStateInitializedAt,
      sessions: cloneReadStateMap(state.sessionReadState)
    };
  }

  function enrichSessionsWithMeta(sessions = [], { includeInternal = false, includeArchived = false } = {}) {
    if (!Array.isArray(sessions)) {
      return { sessions: [], hiddenInternalCount: 0 };
    }

    const diskReadChanges = syncSharedReadStateFromDisk();
    const dbById = loadConversationSummaryMap();
    const reconciled = orgBridge.reconcileSessionsLifecycle(sessions);
    const activeOrg = reconciled.org || orgBridge.loadPersistedOrg();
    const lookup = buildRegisteredLookup(activeOrg);
    const appSyncedLookup = buildAppSyncedLookup(lookup);
    const implicitByKey = new Map();
    const initMs = toTimestampMs(state.readStateInitializedAt);
    const pinnedSet = new Set(activeOrg.pins?.sessions || []);
    const archivedMap = activeOrg.archivedSessions || {};
    const deletedMap = activeOrg.deletedSessions || {};
    let completionChanged = false;
    let hiddenInternalCount = 0;

    const enrichedAll = [];
    for (const session of sessions) {
      if (!session || typeof session !== 'object') {
        enrichedAll.push(session);
        continue;
      }

      const cid = typeof session.cascadeId === 'string' ? session.cascadeId.trim() : '';
      if (cid && deletedMap[cid]) {
        continue;
      }
      const dbRow = cid ? dbById.get(cid) : null;

      const parentConversationId = pickNonEmptyString(
        session.parentConversationId,
        dbRow?.parent_conversation_id
      );
      const nestingDepth = Number.isFinite(Number(session.nestingDepth))
        ? Number(session.nestingDepth)
        : (Number.isFinite(Number(dbRow?.nesting_depth)) ? Number(dbRow.nesting_depth) : 0);
      const agentName = pickNonEmptyString(session.agentName, dbRow?.agent_name);

      const isSubagent = Boolean(
        session.isSubagent
        || parentConversationId
        || nestingDepth > 0
        || agentName
      );
      const isUserCreated = Boolean(cid && state.userCreatedSessions[cid]);

      const rpcTitle = typeof session.title === 'string' ? session.title.trim() : '';
      const rpcHasTitle = Boolean(session.hasTitle || rpcTitle);
      const dbTitle = dbRow && typeof dbRow.title === 'string' ? dbRow.title.trim() : '';
      const rawStepCount = session.stepCount !== undefined && session.stepCount !== null
        ? Number(session.stepCount)
        : Number(dbRow?.step_count || 0);
      const stepCount = Number.isFinite(rawStepCount) && rawStepCount >= 0 ? rawStepCount : 0;

      const dbLastUserInputIdx = dbRow && dbRow.last_user_input_step_index !== null && dbRow.last_user_input_step_index !== undefined
        ? Number(dbRow.last_user_input_step_index)
        : null;
      const lastUserInputStepIndex = Number.isFinite(dbLastUserInputIdx)
        ? dbLastUserInputIdx
        : (Number.isFinite(Number(session.lastUserInputStepIndex)) ? Number(session.lastUserInputStepIndex) : null);

      const titleSource = session.titleSource || (rpcHasTitle ? 'title' : 'none');
      const sourceStr = pickNonEmptyString(session.source, dbRow?.source) || '';

      const isInternalSession = Boolean(
        isSubagent
        || (
          dbRow
          && !rpcHasTitle
          && !dbTitle
          && stepCount > 0
          && dbLastUserInputIdx !== null
          && Number.isFinite(dbLastUserInputIdx)
          && dbLastUserInputIdx < 0
          && !isUserCreated
        )
        || (
          !dbRow
          && !rpcHasTitle
          && stepCount > 0
          && titleSource === 'none'
          && !isUserCreated
          && sourceStr
          && INTERNAL_SOURCE_RE.test(sourceStr)
        )
      );

      if (isInternalSession) {
        hiddenInternalCount += 1;
      }

      const hydratedTitle = rpcTitle || dbTitle || '';
      const hydratedHasTitle = Boolean(hydratedTitle);
      const hydratedTitleSource = session.titleSource && session.titleSource !== 'none'
        ? session.titleSource
        : (rpcTitle ? 'title' : (dbTitle ? 'db' : 'none'));

      const rpcSummary = typeof session.summary === 'string' ? session.summary : '';
      const dbPreview = dbRow && typeof dbRow.preview === 'string' ? dbRow.preview : '';
      const hydratedSummary = rpcSummary.trim() ? rpcSummary : (dbPreview || rpcSummary);

      const status = String(session.status || dbRow?.status || 'CASCADE_RUN_STATUS_IDLE');
      const notFullyIdle = Boolean(session.notFullyIdle || dbRow?.not_fully_idle);
      const isRunning = RUNNING_STATUS_RE.test(status) || notFullyIdle;
      const lastModifiedTime = session.lastModifiedTime || dbRow?.last_modified_time || session.createdTime || null;
      const workspaceUri = session.workspaceUri || parseWorkspaceUriFromDb(dbRow?.workspace_uris) || null;

      if (cid) {
        lastSeenStepCounts.set(cid, stepCount);
        const prevComp = state.sessionCompletionTimes[cid] || null;
        const prevWasRunning = Boolean(
          prevComp && (prevComp.wasRunning || RUNNING_STATUS_RE.test(String(prevComp.lastStatus || '')))
        );

        if (prevWasRunning && !isRunning) {
          const rpcCompletedMs = toTimestampMs(session.lastCompletedTime);
          const lastCompletedAt = rpcCompletedMs > 0
            ? new Date(rpcCompletedMs).toISOString()
            : new Date().toISOString();
          state.sessionCompletionTimes[cid] = {
            lastCompletedAt,
            lastCompletedStepCount: stepCount,
            lastStatus: status,
            wasRunning: false
          };
          completionChanged = true;
        } else if (isRunning) {
          if (!prevComp || !prevComp.wasRunning || prevComp.lastStatus !== status) {
            state.sessionCompletionTimes[cid] = {
              lastCompletedAt: prevComp?.lastCompletedAt || null,
              lastCompletedStepCount: prevComp?.lastCompletedStepCount ?? stepCount,
              lastStatus: status,
              wasRunning: true
            };
            completionChanged = true;
          }
        } else if (session.lastCompletedTime) {
          const rpcCompletedMs = toTimestampMs(session.lastCompletedTime);
          if (rpcCompletedMs > 0 && rpcCompletedMs > toTimestampMs(prevComp?.lastCompletedAt)) {
            state.sessionCompletionTimes[cid] = {
              lastCompletedAt: new Date(rpcCompletedMs).toISOString(),
              lastCompletedStepCount: Math.max(prevComp?.lastCompletedStepCount || 0, stepCount),
              lastStatus: status,
              wasRunning: false
            };
            completionChanged = true;
          }
        }
      }

      const compEntry = cid ? state.sessionCompletionTimes[cid] : null;
      const effectiveCompletedMs = Math.max(
        toTimestampMs(session.lastCompletedTime),
        toTimestampMs(compEntry?.lastCompletedAt),
        toTimestampMs(lastModifiedTime)
      );
      const readEntry = cid ? state.sessionReadState[cid] : null;
      let unread = false;
      if (!isRunning && stepCount > 0 && !isInternalSession) {
        if (readEntry) {
          const readMs = toTimestampMs(readEntry.lastReadAt);
          unread = (effectiveCompletedMs > readMs + 500) || (stepCount > (readEntry.lastReadStepCount || 0));
        } else {
          unread = effectiveCompletedMs > initMs + 500;
        }
      }

      const pinned = Boolean(cid && pinnedSet.has(cid));
      const pinnedAt = pinned
        ? (activeOrg.pinTimestamps?.sessions?.[cid] || activeOrg.updatedAt || null)
        : null;
      const archiveEntry = cid ? archivedMap[cid] : null;
      const archived = Boolean(archiveEntry);
      const sessionForAssignment = workspaceUri && !session.workspaceUri
        ? { ...session, workspaceUri }
        : session;
      const resolved = resolveSessionAssignment(sessionForAssignment, lookup, implicitByKey, appSyncedLookup);

      enrichedAll.push({
        ...session,
        title: hydratedTitle,
        hasTitle: hydratedHasTitle,
        titleSource: hydratedTitleSource,
        summary: hydratedSummary,
        status,
        stepCount,
        lastModifiedTime,
        ...(workspaceUri ? { workspaceUri } : {}),
        ...(parentConversationId ? { parentConversationId } : {}),
        ...(nestingDepth > 0 || session.nestingDepth !== undefined ? { nestingDepth } : {}),
        ...(agentName ? { agentName } : {}),
        ...(lastUserInputStepIndex !== null ? { lastUserInputStepIndex } : {}),
        isRunning,
        isSubagent,
        isUserCreated,
        isInternalSession,
        unread,
        lastCompletedAt: compEntry?.lastCompletedAt || session.lastCompletedTime || null,
        pinned,
        pinnedAt,
        archived,
        ...(archived ? { archivedAt: archiveEntry.archivedAt } : {}),
        projectId: resolved.projectId,
        projectName: resolved.projectName,
        groupId: (cid && activeOrg.sessionGroupMap?.[cid])
          || (resolved.projectId ? (activeOrg.projectGroupMap?.[resolved.projectId] ?? null) : null)
      });
    }

    if (diskReadChanges > 0 || completionChanged) {
      persist();
    }

    const visible = enrichedAll.filter((item) => {
      if (!item) return false;
      if (!includeInternal && item.isInternalSession) return false;
      if (!includeArchived && item.archived) return false;
      return true;
    });

    const pinnedGlobalOrder = Array.isArray(activeOrg.sessionOrder?.__pinned__) ? activeOrg.sessionOrder.__pinned__ : [];
    const pinnedGlobalIdx = new Map(pinnedGlobalOrder.map((id, idx) => [id, idx]));

    visible.sort((a, b) => {
      const aPinned = Boolean(a?.pinned);
      const bPinned = Boolean(b?.pinned);
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      if (aPinned && bPinned) {
        if (pinnedGlobalIdx.has(a.cascadeId) && pinnedGlobalIdx.has(b.cascadeId)) {
          return pinnedGlobalIdx.get(a.cascadeId) - pinnedGlobalIdx.get(b.cascadeId);
        }
        const pinDiff = toTimestampMs(b.pinnedAt) - toTimestampMs(a.pinnedAt);
        if (pinDiff !== 0) return pinDiff;
      }
      return toTimestampMs(b?.lastModifiedTime) - toTimestampMs(a?.lastModifiedTime);
    });

    return {
      sessions: visible,
      hiddenInternalCount,
      archivedCount: Object.keys(archivedMap).length
    };
  }

  function enrichSessions(sessions = [], opts = {}) {
    return enrichSessionsWithMeta(sessions, opts).sessions;
  }

  function cleanupSessionTelemetry(cascadeId) {
    const cleanCid = typeof cascadeId === 'string' ? cascadeId.trim() : '';
    if (!cleanCid) return;
    delete state.sessionReadState[cleanCid];
    delete state.sessionCompletionTimes[cleanCid];
    delete state.userCreatedSessions[cleanCid];
    persist();
  }

  return {
    getState,
    loadAppSyncedProjects,
    listProjectsAndGroups,
    createProject,
    updateProject,
    deleteProject,
    createGroup,
    updateGroup,
    deleteGroup,
    setSessionPin,
    assignSessionProject,
    setDefaultSessionPath,
    getProjectById,
    getProjectRootPaths,
    enrichSessions,
    enrichSessionsWithMeta,
    markSessionRead,
    mergeExternalReadState,
    getReadStateSnapshot,
    recordSessionCompletion,
    recordUserCreatedSession,
    cleanupSessionTelemetry,
    getOrg: (opts) => orgBridge.getOrg(opts),
    togglePin: (body) => {
      const res = orgBridge.togglePin(body);
      if (res?.ok) persist();
      return res;
    },
    mutateGroup: (body) => {
      const res = orgBridge.mutateGroup(body);
      if (res?.ok) persist();
      return res;
    },
    reorderOrg: (body) => {
      const res = orgBridge.reorderOrg(body);
      if (res?.ok) persist();
      return res;
    },
    archiveSession: (cascadeId, opts) => {
      const res = orgBridge.archiveSession(cascadeId, opts);
      if (res?.ok) persist();
      return res;
    },
    deleteSessionOrgRecord: (cascadeId, opts) => {
      const res = orgBridge.deleteSessionOrgRecord(cascadeId, opts);
      if (res?.ok) cleanupSessionTelemetry(cascadeId);
      return res;
    },
    unarchiveOnSendMessage: (cascadeId) => orgBridge.reconcileSessionsLifecycle([], { forceUnarchiveIds: [cascadeId] })
  };
}

module.exports = {
  createWorkspaceMetaStore,
  normalizeLocalPath,
  isForbiddenSystemRoot
};
