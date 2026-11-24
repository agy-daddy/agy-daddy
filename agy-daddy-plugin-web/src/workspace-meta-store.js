'use strict';

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const url = require('node:url');

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
 */
function createWorkspaceMetaStore({
  storage = null,
  defaultBaseDir,
  conversationDbPath,
  stateVscdbPath,
  sharedReadStatePath,
  conversationDbTtlMs = DEFAULT_CONVERSATION_DB_TTL_MS,
  appSyncTtlMs = DEFAULT_APP_SYNC_TTL_MS
} = {}) {
  const fallbackDefaultPath = normalizeLocalPath(defaultBaseDir)
    || path.join(os.homedir(), 'antigravity-workspace');
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
    cachedAt: 0,
    byId: new Map()
  };
  const appSyncCache = {
    cachedAt: 0,
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

  function persist() {
    writeMetaToStorage(storage, cloneState(state));
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
    const now = Date.now();
    if (dbCache.cachedAt > 0 && (now - dbCache.cachedAt) < dbCacheTtlMs) {
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
    dbCache.cachedAt = now;
    dbCache.byId = byId;
    return byId;
  }

  function loadAppSyncedProjects() {
    if (!resolvedStateVscdbPath && !resolvedConversationDbPath) {
      return [];
    }
    const now = Date.now();
    if (appSyncCache.cachedAt > 0 && (now - appSyncCache.cachedAt) < appSyncCacheTtlMs) {
      return appSyncCache.projects.map((p) => ({ ...p }));
    }

    const defaultKeys = getPathLookupKeys(state.defaultSessionPath);
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

    appSyncCache.cachedAt = now;
    appSyncCache.projects = collected;
    return collected.map((p) => ({ ...p }));
  }

  const initialSharedChanges = syncSharedReadStateFromDisk();
  if (storage && (!rawLoadedState || !rawLoadedState.readStateInitializedAt || initialSharedChanges > 0)) {
    persist();
  }

  function buildRegisteredLookup() {
    const byId = new Map();
    const byPathKey = new Map();
    for (const proj of state.projects) {
      byId.set(proj.id, proj);
      for (const key of getPathLookupKeys(proj.rootPath)) {
        if (!byPathKey.has(key)) {
          byPathKey.set(key, proj);
        }
      }
    }
    return { byId, byPathKey };
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
    const cascadeId = session?.cascadeId;
    if (cascadeId && Object.prototype.hasOwnProperty.call(state.sessionProjectOverrides, cascadeId)) {
      const overrideId = state.sessionProjectOverrides[cascadeId];
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
    const defaultKeys = getPathLookupKeys(state.defaultSessionPath);
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

  function sortedGroups() {
    return state.groups
      .map((g) => ({ ...g }))
      .sort((a, b) => (a.sortOrder - b.sortOrder) || (toTimestampMs(a.createdAt) - toTimestampMs(b.createdAt)));
  }

  function getState() {
    return cloneState(state);
  }

  function listProjectsAndGroups(discoveredSessions = []) {
    const lookup = buildRegisteredLookup();
    const appSyncedLookup = buildAppSyncedLookup(lookup);
    const countsByProjectId = new Map();
    const implicitByKey = new Map();
    const implicitList = [];

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

    const registered = state.projects.map((p) => ({
      ...p,
      implicit: false,
      sessionCount: countsByProjectId.get(p.id) || 0
    }));

    const appSynced = appSyncedLookup.list.map((p) => ({
      id: p.id,
      name: p.name,
      rootPath: p.rootPath,
      groupId: null,
      implicit: false,
      syncedFromApp: true,
      source: 'app',
      sessionCount: Math.max(countsByProjectId.get(p.id) || 0, p.dbSessionCount || 0),
      ...(p.lastModifiedTime ? { lastModifiedTime: p.lastModifiedTime } : {})
    }));

    const implicit = implicitList.map((p) => ({
      ...p,
      sessionCount: countsByProjectId.get(p.id) || 0
    }));

    return {
      ok: true,
      projects: [...registered, ...appSynced, ...implicit],
      groups: sortedGroups(),
      defaultSessionPath: state.defaultSessionPath
    };
  }

  function createProject({ name, rootPath, groupId = null, createDir = false } = {}) {
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

    let resolvedGroupId = null;
    if (groupId !== undefined && groupId !== null && groupId !== '') {
      const cleanGid = String(groupId).trim();
      if (!state.groups.some((g) => g.id === cleanGid)) {
        return { ok: false, statusCode: 404, error: 'GROUP_NOT_FOUND' };
      }
      resolvedGroupId = cleanGid;
    }

    const lookup = buildRegisteredLookup();
    const duplicate = findRegisteredByRoot(normalizedRoot, lookup) || findRegisteredByRoot(realRoot, lookup);
    if (duplicate) {
      return {
        ok: false,
        statusCode: 409,
        error: 'PROJECT_ALREADY_EXISTS',
        project: { ...duplicate }
      };
    }

    const cleanName = typeof name === 'string' && name.trim()
      ? name.trim()
      : (path.basename(normalizedRoot) || normalizedRoot);
    const now = new Date().toISOString();
    const project = {
      id: `proj_${crypto.randomUUID()}`,
      name: cleanName,
      rootPath: normalizedRoot,
      groupId: resolvedGroupId,
      createdAt: now,
      updatedAt: now,
      archived: false
    };
    state.projects.push(project);
    persist();

    const listed = listProjectsAndGroups();
    return {
      ok: true,
      project: { ...project },
      projects: listed.projects,
      groups: listed.groups,
      defaultSessionPath: state.defaultSessionPath
    };
  }

  function resolveProjectCandidate(cleanId, opts = {}) {
    if (!cleanId) return null;
    const registered = state.projects.find((p) => p.id === cleanId);
    if (registered) return registered;

    const appSynced = loadAppSyncedProjects().find((p) => p.id === cleanId);
    if (appSynced) return appSynced;

    const cachedImplicit = knownImplicitProjectsById.get(cleanId);
    if (cachedImplicit) return cachedImplicit;

    const rawPath = opts?.workspaceUri || opts?.rootPath;
    if (typeof rawPath === 'string' && rawPath.trim()) {
      const normPath = normalizeLocalPath(rawPath);
      if (normPath && !isForbiddenSystemRoot(normPath)) {
        const lookup = buildRegisteredLookup();
        const regByRoot = findRegisteredByRoot(normPath, lookup);
        if (regByRoot && regByRoot.id === cleanId) return regByRoot;

        if (
          cleanId.startsWith('app:')
          || cleanId.startsWith('implicit:')
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

  function promoteCandidateProject(candidate, initialPatch = {}) {
    if (!candidate) return null;
    const existingIdx = state.projects.findIndex((p) => p.id === candidate.id);
    if (existingIdx >= 0) return { index: existingIdx, project: state.projects[existingIdx] };

    const lookup = buildRegisteredLookup();
    const existingByRoot = findRegisteredByRoot(candidate.rootPath, lookup);
    if (existingByRoot) {
      const idx = state.projects.findIndex((p) => p.id === existingByRoot.id);
      return { index: idx, project: existingByRoot };
    }

    const now = new Date().toISOString();
    const promoted = {
      id: candidate.id,
      name: initialPatch.name || candidate.name || path.basename(candidate.rootPath) || candidate.rootPath,
      rootPath: candidate.rootPath,
      groupId: Object.prototype.hasOwnProperty.call(initialPatch, 'groupId')
        ? initialPatch.groupId
        : (candidate.groupId || null),
      createdAt: candidate.createdAt || now,
      updatedAt: now,
      archived: Object.prototype.hasOwnProperty.call(initialPatch, 'archived')
        ? Boolean(initialPatch.archived)
        : Boolean(candidate.archived),
      ...(candidate.syncedFromApp ? { syncedFromApp: true, source: candidate.source || 'app' } : {})
    };
    state.projects.push(promoted);
    knownImplicitProjectsById.delete(candidate.id);
    return { index: state.projects.length - 1, project: promoted };
  }

  function updateProject(id, patch = {}) {
    const cleanId = typeof id === 'string' ? id.trim() : '';
    if (!isPlainObject(patch)) {
      return { ok: false, statusCode: 400, error: 'INVALID_PATCH' };
    }

    let idx = state.projects.findIndex((p) => p.id === cleanId);
    let target = idx >= 0 ? state.projects[idx] : null;
    let candidate = null;
    if (!target) {
      candidate = resolveProjectCandidate(cleanId, patch);
      if (!candidate) {
        return { ok: false, statusCode: 404, error: 'PROJECT_NOT_FOUND' };
      }
      target = candidate;
    }

    const next = { ...target };

    if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
      const cleanName = typeof patch.name === 'string' ? patch.name.trim() : '';
      if (!cleanName) {
        return { ok: false, statusCode: 400, error: 'INVALID_PROJECT_NAME' };
      }
      next.name = cleanName;
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'groupId')) {
      if (patch.groupId === null || patch.groupId === '') {
        next.groupId = null;
      } else {
        const cleanGid = String(patch.groupId).trim();
        if (!state.groups.some((g) => g.id === cleanGid)) {
          return { ok: false, statusCode: 404, error: 'GROUP_NOT_FOUND' };
        }
        next.groupId = cleanGid;
      }
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'archived')) {
      next.archived = Boolean(patch.archived);
    }

    if (idx < 0) {
      const promoted = promoteCandidateProject(candidate, next);
      idx = promoted.index;
      next.id = promoted.project.id;
      next.createdAt = promoted.project.createdAt;
      if (promoted.project.syncedFromApp) {
        next.syncedFromApp = true;
        next.source = promoted.project.source || 'app';
      }
    }

    next.implicit = false;
    next.updatedAt = new Date().toISOString();
    delete next.dbSessionCount;
    delete next.lastModifiedTime;
    state.projects[idx] = next;
    persist();

    const listed = listProjectsAndGroups();
    return {
      ok: true,
      project: { ...next },
      projects: listed.projects,
      groups: listed.groups,
      defaultSessionPath: state.defaultSessionPath
    };
  }

  function deleteProject(id) {
    const cleanId = typeof id === 'string' ? id.trim() : '';
    const idx = state.projects.findIndex((p) => p.id === cleanId);
    if (idx < 0) {
      return { ok: false, statusCode: 404, error: 'PROJECT_NOT_FOUND' };
    }

    state.projects.splice(idx, 1);
    for (const [cid, pid] of Object.entries(state.sessionProjectOverrides)) {
      if (pid === cleanId) {
        delete state.sessionProjectOverrides[cid];
      }
    }
    persist();

    return { ok: true, id: cleanId, deleted: true };
  }

  function createGroup({ name } = {}) {
    const cleanName = typeof name === 'string' ? name.trim() : '';
    if (!cleanName) {
      return { ok: false, statusCode: 400, error: 'INVALID_GROUP_NAME' };
    }

    const maxOrder = state.groups.reduce(
      (max, g) => (Number.isFinite(g.sortOrder) && g.sortOrder > max ? g.sortOrder : max),
      -1
    );
    const now = new Date().toISOString();
    const group = {
      id: `grp_${crypto.randomUUID()}`,
      name: cleanName,
      sortOrder: maxOrder + 1,
      collapsed: false,
      createdAt: now,
      updatedAt: now
    };
    state.groups.push(group);
    persist();

    const listed = listProjectsAndGroups();
    return {
      ok: true,
      group: { ...group },
      projects: listed.projects,
      groups: listed.groups
    };
  }

  function updateGroup(id, patch = {}) {
    const cleanId = typeof id === 'string' ? id.trim() : '';
    const idx = state.groups.findIndex((g) => g.id === cleanId);
    if (idx < 0) {
      return { ok: false, statusCode: 404, error: 'GROUP_NOT_FOUND' };
    }
    if (!isPlainObject(patch)) {
      return { ok: false, statusCode: 400, error: 'INVALID_PATCH' };
    }

    const next = { ...state.groups[idx] };
    if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
      const cleanName = typeof patch.name === 'string' ? patch.name.trim() : '';
      if (!cleanName) {
        return { ok: false, statusCode: 400, error: 'INVALID_GROUP_NAME' };
      }
      next.name = cleanName;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'collapsed')) {
      next.collapsed = Boolean(patch.collapsed);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'sortOrder')) {
      const n = Number(patch.sortOrder);
      if (!Number.isFinite(n)) {
        return { ok: false, statusCode: 400, error: 'INVALID_SORT_ORDER' };
      }
      next.sortOrder = n;
    }

    next.updatedAt = new Date().toISOString();
    state.groups[idx] = next;
    persist();

    const listed = listProjectsAndGroups();
    return {
      ok: true,
      group: { ...next },
      projects: listed.projects,
      groups: listed.groups
    };
  }

  function deleteGroup(id) {
    const cleanId = typeof id === 'string' ? id.trim() : '';
    const idx = state.groups.findIndex((g) => g.id === cleanId);
    if (idx < 0) {
      return { ok: false, statusCode: 404, error: 'GROUP_NOT_FOUND' };
    }

    state.groups.splice(idx, 1);
    const now = new Date().toISOString();
    for (let i = 0; i < state.projects.length; i++) {
      if (state.projects[i].groupId === cleanId) {
        state.projects[i] = {
          ...state.projects[i],
          groupId: null,
          updatedAt: now
        };
      }
    }
    persist();

    return { ok: true, id: cleanId, deleted: true };
  }

  function setSessionPin(cascadeId, pinned) {
    const cleanId = typeof cascadeId === 'string' ? cascadeId.trim() : '';
    if (!cleanId) {
      return { ok: false, statusCode: 400, error: 'INVALID_CASCADE_ID' };
    }

    if (pinned) {
      const pinnedAt = new Date().toISOString();
      state.pinnedSessions[cleanId] = { pinnedAt };
      persist();
      return { ok: true, cascadeId: cleanId, pinned: true, pinnedAt };
    }

    delete state.pinnedSessions[cleanId];
    persist();
    return { ok: true, cascadeId: cleanId, pinned: false, pinnedAt: null };
  }

  function assignSessionProject(cascadeId, projectId, opts = {}) {
    const cleanCid = typeof cascadeId === 'string' ? cascadeId.trim() : '';
    if (!cleanCid) {
      return { ok: false, statusCode: 400, error: 'INVALID_CASCADE_ID' };
    }

    if (projectId === null || projectId === undefined || projectId === '') {
      state.sessionProjectOverrides[cleanCid] = null;
      persist();
      return { ok: true, cascadeId: cleanCid, projectId: null };
    }

    const cleanPid = String(projectId).trim();
    let resolvedPid = cleanPid;
    if (!state.projects.some((p) => p.id === cleanPid)) {
      const candidate = resolveProjectCandidate(cleanPid, opts);
      if (!candidate) {
        return { ok: false, statusCode: 404, error: 'PROJECT_NOT_FOUND' };
      }
      const promoted = promoteCandidateProject(candidate);
      resolvedPid = promoted?.project?.id || cleanPid;
    }

    state.sessionProjectOverrides[cleanCid] = resolvedPid;
    persist();
    return { ok: true, cascadeId: cleanCid, projectId: resolvedPid };
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

    state.defaultSessionPath = normalized;
    persist();
    return { ok: true, defaultSessionPath: normalized };
  }

  function getProjectById(id, opts = {}) {
    const cleanId = typeof id === 'string' ? id.trim() : '';
    const found = resolveProjectCandidate(cleanId, opts);
    return found ? { ...found } : null;
  }

  function getProjectRootPaths() {
    const out = [];
    const seen = new Set();
    for (const proj of state.projects) {
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

  function enrichSessionsWithMeta(sessions = [], { includeInternal = false } = {}) {
    if (!Array.isArray(sessions)) {
      return { sessions: [], hiddenInternalCount: 0 };
    }

    const diskReadChanges = syncSharedReadStateFromDisk();
    const dbById = loadConversationSummaryMap();
    const lookup = buildRegisteredLookup();
    const appSyncedLookup = buildAppSyncedLookup(lookup);
    const implicitByKey = new Map();
    const initMs = toTimestampMs(state.readStateInitializedAt);
    let completionChanged = false;
    let hiddenInternalCount = 0;

    const enrichedAll = [];
    for (const session of sessions) {
      if (!session || typeof session !== 'object') {
        enrichedAll.push(session);
        continue;
      }

      const cid = typeof session.cascadeId === 'string' ? session.cascadeId.trim() : '';
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

      const pinEntry = cid ? state.pinnedSessions[cid] : null;
      const pinned = Boolean(pinEntry);
      const pinnedAt = pinEntry?.pinnedAt || null;
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
        projectId: resolved.projectId,
        projectName: resolved.projectName
      });
    }

    if (diskReadChanges > 0 || completionChanged) {
      persist();
    }

    const visible = includeInternal
      ? enrichedAll
      : enrichedAll.filter((item) => !item || !item.isInternalSession);

    visible.sort((a, b) => {
      const aPinned = Boolean(a?.pinned);
      const bPinned = Boolean(b?.pinned);
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      if (aPinned && bPinned) {
        const pinDiff = toTimestampMs(b.pinnedAt) - toTimestampMs(a.pinnedAt);
        if (pinDiff !== 0) return pinDiff;
      }
      return toTimestampMs(b?.lastModifiedTime) - toTimestampMs(a?.lastModifiedTime);
    });

    return {
      sessions: visible,
      hiddenInternalCount
    };
  }

  function enrichSessions(sessions = [], opts = {}) {
    return enrichSessionsWithMeta(sessions, opts).sessions;
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
    recordUserCreatedSession
  };
}

module.exports = {
  createWorkspaceMetaStore,
  normalizeLocalPath,
  isForbiddenSystemRoot
};
