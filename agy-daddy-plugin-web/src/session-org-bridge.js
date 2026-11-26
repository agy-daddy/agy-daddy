'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const url = require('node:url');

const IS_CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';
const PERCENT_ENCODED_RE = /%[0-9A-Fa-f]{2}/;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;
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

function canonicalKey(p) {
  const s = String(p || '').replace(/\\/g, '/');
  const trimmed = s.length > 1 && !/^[A-Za-z]:\/$/.test(s) ? s.replace(/\/+$/, '') : s;
  return IS_CASE_INSENSITIVE_FS ? trimmed.toLowerCase() : trimmed;
}

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
      s = s.replace(/^file:\/\//i, '');
      if (/^localhost\//i.test(s)) {
        s = s.slice('localhost'.length);
      }
      if (PERCENT_ENCODED_RE.test(s)) {
        try {
          s = decodeURIComponent(s);
        } catch {
          // Keep raw if malformed
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
        // Keep raw if malformed
      }
    }
  }

  s = expandTilde(s);
  if (!s || s.includes('\0')) return '';

  if (WINDOWS_DRIVE_RE.test(s) && process.platform !== 'win32') {
    const slashed = s.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    return slashed.length > 3 ? slashed.replace(/\/+$/, '') : slashed;
  }

  return path.resolve(s);
}

function normalizeUriToPath(uriOrPath) {
  return normalizeLocalPath(uriOrPath);
}

function pathToFileUri(fsPath) {
  const clean = normalizeLocalPath(fsPath);
  if (!clean) return null;
  try {
    return url.pathToFileURL(clean).href;
  } catch {
    return `file://${encodeURI(clean).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
  }
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

function deriveWorkspaceProjectId(normPath) {
  if (!normPath) return null;
  const hash = crypto.createHash('sha1').update(normPath).digest('hex').slice(0, 12);
  const parts = normPath.split(/[\\/]/).filter(Boolean);
  const baseName = parts.length > 0 ? parts[parts.length - 1] : 'workspace';
  const base = baseName.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 32) || 'workspace';
  return `ws:${base}:${hash}`;
}

function makeAppSyncedProjectId(normPath) {
  const digest = crypto.createHash('sha1').update(canonicalKey(normPath)).digest('hex').slice(0, 12);
  return `app:${digest}`;
}

function makeImplicitProjectId(normPath) {
  const digest = crypto.createHash('sha1').update(canonicalKey(normPath)).digest('hex').slice(0, 12);
  return `implicit:${digest}`;
}

function makeStableProjectId(normPath) {
  const digest = crypto.createHash('sha1').update(canonicalKey(normPath)).digest('hex').slice(0, 12);
  return `proj_${digest}`;
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

const PRESET_ICON_RE = /^preset:[a-z0-9-]{1,24}$/;
const UNSAFE_ICON_RE = /[\u0000-\u001F\u007F<>]/;

function sanitizeEntityIcon(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'INVALID_ICON' };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  if (UNSAFE_ICON_RE.test(trimmed) || trimmed.length > 24) {
    return { ok: false, error: 'INVALID_ICON' };
  }
  if (trimmed.startsWith('preset:')) {
    if (!PRESET_ICON_RE.test(trimmed)) {
      return { ok: false, error: 'INVALID_ICON' };
    }
    return { ok: true, value: trimmed };
  }
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segs = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(trimmed));
    if (segs.length === 0 || segs.length > 4) {
      return { ok: false, error: 'INVALID_ICON' };
    }
  } else if (Array.from(trimmed).length > 8) {
    return { ok: false, error: 'INVALID_ICON' };
  }
  return { ok: true, value: trimmed };
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
    groupOrder: {
      pinned: [],
      normal: []
    },
    projectOrder: {},
    sessionOrder: {},
    archivedSessions: {},
    deletedSessions: {},
    migrations: {
      workspaceMetaV1At: null
    }
  };
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

  const nowIso = base.updatedAt || new Date().toISOString();
  if (Array.isArray(raw.groups)) {
    const seen = new Set();
    base.groups = raw.groups
      .filter((g) => isPlainObject(g) && String(g.id || '').trim())
      .map((g, idx) => {
        const id = String(g.id).trim();
        if (seen.has(id)) return null;
        seen.add(id);
        const iconCheck = sanitizeEntityIcon(g.icon);
        const icon = iconCheck.ok ? iconCheck.value : null;
        return {
          id,
          name: String(g.name || id).trim() || id,
          ...(icon ? { icon } : {}),
          source: g.source === 'host' ? 'host' : 'user',
          collapsed: Boolean(g.collapsed),
          order: Number.isFinite(Number(g.order)) ? Number(g.order) : (Number.isFinite(Number(g.sortOrder)) ? Number(g.sortOrder) : idx),
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
      const iconCheck = sanitizeEntityIcon(p.icon);
      const icon = iconCheck.ok ? iconCheck.value : null;

      base.projects.push({
        id,
        aliases,
        name: String(p.name || path.basename(rootPath) || id).trim() || id,
        ...(icon ? { icon } : {}),
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
    const text = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(text);
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
        } catch {
          // Another process beat us to unlinking
        }
      }
      if (Date.now() >= deadline) {
        // Last-chance stale break if timed out, then retry once
        try {
          fs.unlinkSync(lockPath);
        } catch {}
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
    projectGroupMap: org.projectGroupMap,
    groupOrder: org.groupOrder,
    projectOrder: org.projectOrder,
    sessionOrder: org.sessionOrder,
    archivedCount: Object.keys(org.archivedSessions || {}).length
  };
}

/**
 * Replace references from any alias ID to canonical project ID across org maps/orders.
 */
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

/**
 * Shared session organization store bridge compatible with agy-daddy-plugin-remote (~/.agy-daddy/session-org.json).
 */
function createSessionOrgBridge(options = {}) {
  const explicitOrgPath = options.orgPath !== undefined
    ? options.orgPath
    : (process.env.AGY_DADDY_SESSION_ORG_PATH || '');
  const orgPath = explicitOrgPath
    ? path.resolve(explicitOrgPath)
    : (explicitOrgPath === null || isTestMode() ? null : path.join(os.homedir(), '.agy-daddy', 'session-org.json'));

  const pluginId = typeof options.pluginId === 'string' && options.pluginId.trim()
    ? options.pluginId.trim()
    : 'agy-daddy.web';
  const onOrgChanged = typeof options.onOrgChanged === 'function' ? options.onOrgChanged : null;
  const onExternalOrgChanged = typeof options.onExternalOrgChanged === 'function' ? options.onExternalOrgChanged : null;

  let memoryOrg = createEmptyPersistedOrg();
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

    const iconCheck = sanitizeEntityIcon(candidate.icon);
    const entryIcon = iconCheck.ok ? iconCheck.value : null;

    const entry = {
      id: stableId,
      aliases,
      name: String(candidate.name || path.basename(normPath) || stableId).trim() || stableId,
      ...(entryIcon ? { icon: entryIcon } : {}),
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
        } catch {
          // Best-effort backup
        }
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
    const enrichedGroups = org.groups.map((g) => ({
      ...g,
      pinned: pinnedGroupsSet.has(g.id)
    }));
    const enrichedProjects = org.projects.map((p) => ({
      ...p,
      groupId: org.projectGroupMap[p.id] ?? p.groupId ?? null,
      pinned: pinnedProjectsSet.has(p.id)
    }));
    const out = {
      ok: true,
      version: 2,
      revision: org.revision,
      updatedAt: org.updatedAt,
      defaultSessionPath: org.defaultSessionPath || path.join(os.homedir(), 'antigravity-workspace'),
      groups: enrichedGroups,
      projects: enrichedProjects,
      pins: org.pins,
      pinTimestamps: org.pinTimestamps,
      projectGroupMap: org.projectGroupMap,
      sessionGroupMap: org.sessionGroupMap,
      sessionProjectOverrides: org.sessionProjectOverrides,
      groupOrder: org.groupOrder,
      projectOrder: org.projectOrder,
      sessionOrder: org.sessionOrder,
      archivedCount: Object.keys(org.archivedSessions || {}).length
    };
    if (includeArchived) {
      out.archivedSessions = org.archivedSessions;
    }
    return out;
  }

  function getOrg(opts = {}) {
    const org = loadPersistedOrg();
    return buildOrgSnapshot(org, opts);
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

      // Keep zone order arrays consistent when already initialized
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
        if (org.projectOrder[id]) {
          const prevOrd = org.projectOrder[id];
          if (org.projectOrder.__ungrouped__) {
            org.projectOrder.__ungrouped__.pinned = dedupeStrings([...org.projectOrder.__ungrouped__.pinned, ...(prevOrd.pinned || [])]);
            org.projectOrder.__ungrouped__.normal = dedupeStrings([...org.projectOrder.__ungrouped__.normal, ...(prevOrd.normal || [])]);
          }
          delete org.projectOrder[id];
        }
        return {
          buildResult: (saved) => ({
            ok: true,
            action: 'delete',
            id,
            groups: saved.groups,
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
          const normPath = normalizeLocalPath(workspaceUri);
          for (const g of org.groups) {
            g.workspaceUris = g.workspaceUris.filter((u) => normalizeLocalPath(u) !== normPath);
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

      const name = String(body.name || '').trim();
      const id = String(body.id || '').trim() || `grp_${crypto.randomBytes(4).toString('hex')}`;
      const existingIdx = org.groups.findIndex((g) => g.id === id);
      if (!name && existingIdx < 0) {
        return { abort: true, result: { ok: false, statusCode: 400, error: 'MISSING_GROUP_NAME' } };
      }
      const prev = existingIdx >= 0 ? org.groups[existingIdx] : null;
      let nextIcon = prev?.icon || null;
      if (Object.prototype.hasOwnProperty.call(body, 'icon')) {
        const iconCheck = sanitizeEntityIcon(body.icon);
        if (!iconCheck.ok) {
          return { abort: true, result: { ok: false, statusCode: 400, error: iconCheck.error } };
        }
        nextIcon = iconCheck.value;
      }
      const nowIso = new Date().toISOString();
      const nextGroup = {
        id,
        name: name || prev?.name || id,
        ...(nextIcon ? { icon: nextIcon } : {}),
        source: prev?.source || (body.source === 'host' ? 'host' : 'user'),
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
        // Keep group.order aligned for legacy consumers
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
          const found = findPersistedProject(org, { id: containerId });
          return found ? found.id : containerId;
        })();
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
    const res = mutateOrgAtomically((org) => {
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
    return res;
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
    togglePin,
    mutateGroup,
    reorderOrg,
    archiveSession,
    deleteSessionOrgRecord,
    reconcileSessionsLifecycle
  };
}

module.exports = {
  createSessionOrgBridge,
  createEmptyPersistedOrg,
  sanitizePersistedOrg,
  buildOrgBusSummary,
  normalizeLocalPath,
  canonicalKey,
  getPathLookupKeys,
  pathToFileUri,
  deriveWorkspaceProjectId,
  makeAppSyncedProjectId,
  makeImplicitProjectId,
  makeStableProjectId,
  sanitizeEntityIcon
};
