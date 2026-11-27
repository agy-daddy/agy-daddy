'use strict';

const { validateDirectoryRoot, isInsideAnyRoot } = require('./path-guard');

const DEFAULT_RPC_CACHE_TTL_MS = 10_000;

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function extractTrajectoryRootsFromResponse(resp) {
  const rawSummaries = resp?.trajectorySummaries || resp?.trajectories || {};
  const entries = Array.isArray(rawSummaries)
    ? rawSummaries
    : (isPlainObject(rawSummaries) ? Object.values(rawSummaries) : []);

  const ordered = [...entries].sort((a, b) => {
    const runningA = String(a?.status || '').includes('RUNNING') ? 1 : 0;
    const runningB = String(b?.status || '').includes('RUNNING') ? 1 : 0;
    if (runningB !== runningA) return runningB - runningA;
    const tA = Date.parse(a?.lastModifiedTime || '') || 0;
    const tB = Date.parse(b?.lastModifiedTime || '') || 0;
    return tB - tA;
  });

  const rawCandidates = [];
  const collectWorkspaces = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (!isPlainObject(item)) continue;
      if (item.workspaceFolderAbsoluteUri) rawCandidates.push(item.workspaceFolderAbsoluteUri);
      if (item.gitRootAbsoluteUri) rawCandidates.push(item.gitRootAbsoluteUri);
      if (item.workspacePath) rawCandidates.push(item.workspacePath);
      if (item.workspaceUri) rawCandidates.push(item.workspaceUri);
    }
  };

  for (const entry of ordered) {
    if (!isPlainObject(entry)) continue;
    collectWorkspaces(entry.workspaces);
    collectWorkspaces(entry.trajectoryMetadata?.workspaces);
    if (Array.isArray(entry.trajectoryMetadata?.workspaceUris)) {
      rawCandidates.push(...entry.trajectoryMetadata.workspaceUris);
    }
    collectWorkspaces(entry.trajectory?.metadata?.workspaces);
    if (Array.isArray(entry.trajectory?.metadata?.workspaceUris)) {
      rawCandidates.push(...entry.trajectory.metadata.workspaceUris);
    }
    for (const key of ['workspacePath', 'workspaceUri', 'cwd', 'rootPath']) {
      if (entry[key]) rawCandidates.push(entry[key]);
    }
  }

  return rawCandidates;
}

function deduplicateValidRoots(rawCandidates, options = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of rawCandidates) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const checked = validateDirectoryRoot(raw, options);
    if (!checked.ok) continue;
    const key = process.platform === 'win32' ? checked.realPath.toLowerCase() : checked.realPath;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(checked.realPath);
  }
  return out;
}

/**
 * Resolves authorized workspace root directories:
 * - When settings.allowedRoots is non-empty: strictly use validated entries from settings.allowedRoots.
 * - When settings.allowedRoots is empty: query host.rpc.call('GetAllCascadeTrajectories', {}) with 10s TTL cache.
 */
function createWorkspaceRootsResolver(options = {}) {
  const rpcTtlMs = Number(options.rpcCacheTtlMs) > 0 ? Number(options.rpcCacheTtlMs) : DEFAULT_RPC_CACHE_TTL_MS;
  let cachedRpcRoots = null;
  let cachedAt = 0;

  async function resolveAllowedRoots({ settings = {}, host = null, forceRefresh = false } = {}) {
    const explicitRoots = Array.isArray(settings.allowedRoots)
      ? settings.allowedRoots.filter((r) => typeof r === 'string' && r.trim().length > 0)
      : [];

    if (explicitRoots.length > 0) {
      return deduplicateValidRoots(explicitRoots);
    }

    const now = Date.now();
    if (!forceRefresh && cachedRpcRoots && (now - cachedAt) < rpcTtlMs) {
      return [...cachedRpcRoots];
    }

    let rawCandidates = [];
    if (host?.rpc && typeof host.rpc.call === 'function') {
      try {
        const resp = await host.rpc.call('GetAllCascadeTrajectories', {});
        rawCandidates = extractTrajectoryRootsFromResponse(resp);
      } catch {
        rawCandidates = [];
      }
    }

    const resolved = deduplicateValidRoots(rawCandidates);
    cachedRpcRoots = resolved;
    cachedAt = now;
    return [...resolved];
  }

  function invalidateCache() {
    cachedRpcRoots = null;
    cachedAt = 0;
  }

  return {
    resolveAllowedRoots,
    invalidateCache,
    isInsideAnyRoot
  };
}

module.exports = {
  DEFAULT_RPC_CACHE_TTL_MS,
  extractTrajectoryRootsFromResponse,
  deduplicateValidRoots,
  createWorkspaceRootsResolver
};
