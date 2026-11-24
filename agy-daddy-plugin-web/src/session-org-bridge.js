'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function isTestMode() {
  return process.env.AGY_DADDY_TEST_MODE === '1' || process.env.NODE_ENV === 'test';
}

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function normalizeUriToPath(uriOrPath) {
  const s = String(uriOrPath || '').trim();
  if (!s) return '';
  if (s.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(s).pathname).replace(/\/+$/, '') || '/';
    } catch {
      return s.slice(7).replace(/\/+$/, '') || '/';
    }
  }
  return s.replace(/\/+$/, '') || '/';
}

function dedupeStrings(arr) {
  return Array.from(new Set(
    (Array.isArray(arr) ? arr : [])
      .map((s) => String(s || '').trim())
      .filter(Boolean)
  ));
}

function createEmptyPersistedOrg() {
  return {
    version: 1,
    groups: [],
    pins: {
      sessions: [],
      projects: [],
      groups: []
    },
    projectGroupMap: {},
    sessionGroupMap: {},
    updatedAt: null
  };
}

function sanitizePersistedOrg(raw) {
  const base = createEmptyPersistedOrg();
  if (!isPlainObject(raw)) return base;

  base.pins = {
    sessions: dedupeStrings(raw.pins?.sessions),
    projects: dedupeStrings(raw.pins?.projects),
    groups: dedupeStrings(raw.pins?.groups)
  };

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
          order: Number.isFinite(Number(g.order)) ? Number(g.order) : idx,
          projectIds: dedupeStrings(g.projectIds),
          workspaceUris: dedupeStrings(g.workspaceUris),
          sessionIds: dedupeStrings(g.sessionIds)
        };
      })
      .filter(Boolean);
  }

  if (isPlainObject(raw.projectGroupMap)) {
    for (const [k, v] of Object.entries(raw.projectGroupMap)) {
      const ck = String(k || '').trim();
      const cv = String(v || '').trim();
      if (ck && cv) base.projectGroupMap[ck] = cv;
    }
  }

  if (isPlainObject(raw.sessionGroupMap)) {
    for (const [k, v] of Object.entries(raw.sessionGroupMap)) {
      const ck = String(k || '').trim();
      const cv = String(v || '').trim();
      if (ck && cv) base.sessionGroupMap[ck] = cv;
    }
  }

  base.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;
  return base;
}

/**
 * Shared session organization store bridge compatible with agy-daddy-plugin-remote (~/.agy-daddy/session-org.json).
 */
function createSessionOrgBridge(options = {}) {
  const explicitOrgPath = options.orgPath || process.env.AGY_DADDY_SESSION_ORG_PATH || '';
  const orgPath = explicitOrgPath
    ? path.resolve(explicitOrgPath)
    : (isTestMode() ? null : path.join(os.homedir(), '.agy-daddy', 'session-org.json'));

  let memoryOrg = createEmptyPersistedOrg();

  function loadPersistedOrg() {
    if (!orgPath) {
      return sanitizePersistedOrg(memoryOrg);
    }
    try {
      if (!fs.existsSync(orgPath)) return createEmptyPersistedOrg();
      const raw = JSON.parse(fs.readFileSync(orgPath, 'utf8'));
      return sanitizePersistedOrg(raw);
    } catch {
      return createEmptyPersistedOrg();
    }
  }

  function savePersistedOrg(nextOrg) {
    const clean = sanitizePersistedOrg({
      ...nextOrg,
      updatedAt: new Date().toISOString()
    });
    if (!orgPath) {
      memoryOrg = clean;
      return clean;
    }
    const dir = path.dirname(orgPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${orgPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(clean, null, 2), 'utf8');
    fs.renameSync(tmp, orgPath);
    return clean;
  }

  function getOrg() {
    const org = loadPersistedOrg();
    return {
      ok: true,
      groups: org.groups,
      projects: [],
      pins: org.pins
    };
  }

  function togglePin({ type, id, pinned } = {}) {
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
    const org = loadPersistedOrg();
    const list = org.pins[bucketKey] || [];
    const exists = list.includes(cleanId);
    const nextPinned = typeof pinned === 'boolean' ? pinned : !exists;
    if (nextPinned && !exists) {
      list.push(cleanId);
    } else if (!nextPinned && exists) {
      org.pins[bucketKey] = list.filter((x) => x !== cleanId);
    } else {
      org.pins[bucketKey] = list;
    }
    const saved = savePersistedOrg(org);
    return {
      ok: true,
      type: bucketKey.slice(0, -1),
      id: cleanId,
      pinned: nextPinned,
      pins: saved.pins
    };
  }

  function mutateGroup(body = {}) {
    if (!isPlainObject(body)) {
      return { ok: false, statusCode: 400, error: 'INVALID_GROUP_BODY' };
    }
    const action = String(body.action || 'upsert').trim().toLowerCase();
    const org = loadPersistedOrg();

    if (action === 'delete') {
      const id = String(body.id || '').trim();
      if (!id) return { ok: false, statusCode: 400, error: 'MISSING_GROUP_ID' };
      org.groups = org.groups.filter((g) => g.id !== id);
      org.pins.groups = org.pins.groups.filter((gid) => gid !== id);
      for (const [k, v] of Object.entries(org.projectGroupMap)) {
        if (v === id) delete org.projectGroupMap[k];
      }
      for (const [k, v] of Object.entries(org.sessionGroupMap)) {
        if (v === id) delete org.sessionGroupMap[k];
      }
      const saved = savePersistedOrg(org);
      return { ok: true, action: 'delete', id, groups: saved.groups, pins: saved.pins };
    }

    if (action === 'assign') {
      const groupId = body.groupId ? String(body.groupId).trim() : null;
      const projectId = body.projectId ? String(body.projectId).trim() : '';
      const sessionId = body.sessionId ? String(body.sessionId).trim() : '';
      const workspaceUri = body.workspaceUri ? String(body.workspaceUri).trim() : '';
      if (!projectId && !sessionId && !workspaceUri) {
        return { ok: false, statusCode: 400, error: 'MISSING_ASSIGN_TARGET' };
      }
      if (projectId) {
        if (groupId) org.projectGroupMap[projectId] = groupId;
        else delete org.projectGroupMap[projectId];
        for (const g of org.groups) {
          g.projectIds = g.projectIds.filter((p) => p !== projectId);
          if (groupId && g.id === groupId) g.projectIds.push(projectId);
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
      const saved = savePersistedOrg(org);
      return { ok: true, action: 'assign', groupId, groups: saved.groups, pins: saved.pins };
    }

    const name = String(body.name || '').trim();
    const id = String(body.id || '').trim() || `grp_${crypto.randomBytes(4).toString('hex')}`;
    if (!name && !org.groups.some((g) => g.id === id)) {
      return { ok: false, statusCode: 400, error: 'MISSING_GROUP_NAME' };
    }
    const existingIdx = org.groups.findIndex((g) => g.id === id);
    const prev = existingIdx >= 0 ? org.groups[existingIdx] : null;
    const nextGroup = {
      id,
      name: name || prev?.name || id,
      source: prev?.source || 'user',
      order: Number.isFinite(Number(body.order)) ? Number(body.order) : (prev ? prev.order : org.groups.length),
      projectIds: Array.isArray(body.projectIds) ? dedupeStrings(body.projectIds) : (prev?.projectIds || []),
      workspaceUris: Array.isArray(body.workspaceUris) ? dedupeStrings(body.workspaceUris) : (prev?.workspaceUris || []),
      sessionIds: Array.isArray(body.sessionIds) ? dedupeStrings(body.sessionIds) : (prev?.sessionIds || [])
    };
    if (existingIdx >= 0) {
      org.groups[existingIdx] = nextGroup;
    } else {
      org.groups.push(nextGroup);
    }
    for (const pid of nextGroup.projectIds) org.projectGroupMap[pid] = id;
    for (const sid of nextGroup.sessionIds) org.sessionGroupMap[sid] = id;
    const saved = savePersistedOrg(org);
    return { ok: true, action: 'upsert', group: nextGroup, groups: saved.groups, pins: saved.pins };
  }

  return {
    orgPath,
    getOrg,
    togglePin,
    mutateGroup
  };
}

module.exports = { createSessionOrgBridge };
