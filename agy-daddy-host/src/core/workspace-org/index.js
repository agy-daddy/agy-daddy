'use strict';

const fs = require('node:fs');
const pathCanonicalizer = require('./path-canonicalizer');
const worktreeDiscoveryMod = require('./worktree-discovery');
const sessionOrgCoreMod = require('./session-org-core');

/**
 * Validates and resolves a target workspace/worktree for session creation (`StartCascade`),
 * rejecting missing worktree paths, bare repos, forbidden system roots, and outside paths
 * without ever silently falling back to another directory.
 */
async function resolveAndValidateSessionTarget(body = {}, {
  getAllowedRoots = null,
  worktreeDiscovery = null,
  resolveProjectById = null,
  defaultSessionPath = ''
} = {}) {
  const b = pathCanonicalizer.isPlainObject(body) ? body : {};
  const cleanProjectId = typeof b.projectId === 'string' && b.projectId.trim() ? b.projectId.trim() : null;
  const rawWorktreePath = typeof b.worktreePath === 'string' && b.worktreePath.trim() ? b.worktreePath.trim() : '';
  const rawWorkspaceUri = typeof b.workspaceUri === 'string' && b.workspaceUri.trim() ? b.workspaceUri.trim() : '';
  const standalone = b.standalone === true;

  let resolvedProject = null;
  if (cleanProjectId && typeof resolveProjectById === 'function') {
    resolvedProject = resolveProjectById(cleanProjectId, { workspaceUri: rawWorkspaceUri || rawWorktreePath });
    if (!resolvedProject && !rawWorkspaceUri && !rawWorktreePath) {
      return { ok: false, statusCode: 404, error: 'PROJECT_NOT_FOUND' };
    }
  }

  let targetRaw = rawWorktreePath || rawWorkspaceUri || resolvedProject?.rootPath || '';
  const explicitTargetProvided = Boolean(rawWorktreePath || rawWorkspaceUri);

  if (!targetRaw && !standalone && defaultSessionPath) {
    if (!pathCanonicalizer.isForbiddenSystemRoot(defaultSessionPath)) {
      if (b.standalone !== false) {
        try {
          fs.mkdirSync(defaultSessionPath, { recursive: true });
        } catch {}
      }
      try {
        if (fs.existsSync(defaultSessionPath)) {
          targetRaw = defaultSessionPath;
        }
      } catch {}
    }
  }

  if (!targetRaw) {
    return {
      ok: true,
      projectId: resolvedProject?.id || cleanProjectId || null,
      projectName: resolvedProject?.name || null,
      resolvedProject,
      workspacePath: '',
      workspaceUri: '',
      worktreeId: null
    };
  }

  const normTarget = pathCanonicalizer.normalizeLocalPath(targetRaw);
  if (!normTarget) {
    return { ok: false, statusCode: 400, error: 'INVALID_WORKSPACE_PATH' };
  }
  if (pathCanonicalizer.isForbiddenSystemRoot(normTarget)) {
    return { ok: false, statusCode: 403, error: 'FORBIDDEN_SYSTEM_ROOT' };
  }

  const canonTarget = pathCanonicalizer.canonicalizePath(normTarget) || normTarget;
  if (pathCanonicalizer.isForbiddenSystemRoot(canonTarget)) {
    return { ok: false, statusCode: 403, error: 'FORBIDDEN_SYSTEM_ROOT' };
  }

  // Check worktree metadata & allowed roots if explicit worktreePath or allowedRoots provided
  const rawAllowed = typeof getAllowedRoots === 'function' ? getAllowedRoots() : null;
  const hasAllowedRoots = Array.isArray(rawAllowed) && rawAllowed.length > 0;
  if (worktreeDiscovery && (rawWorktreePath || rawWorkspaceUri)) {
    await worktreeDiscovery.warmRoots([canonTarget], { refresh: false, softTimeoutMs: 150 });
  }

  const knownWts = worktreeDiscovery ? worktreeDiscovery.getAllKnownWorktrees() : [];
  const matchedWt = pathCanonicalizer.matchWorktreeByLongestPrefix(canonTarget, knownWts);

  if (matchedWt) {
    if (matchedWt.bare || matchedWt.status === 'bare') {
      return { ok: false, statusCode: 400, error: 'WORKTREE_IS_BARE' };
    }
    if (matchedWt.prunable || matchedWt.status === 'missing' || !fs.existsSync(canonTarget)) {
      return { ok: false, statusCode: 404, error: 'WORKTREE_PATH_MISSING' };
    }
  } else if (rawWorktreePath) {
    if (!fs.existsSync(canonTarget)) {
      return { ok: false, statusCode: 404, error: 'WORKTREE_PATH_MISSING' };
    }
    try {
      if (!fs.statSync(canonTarget).isDirectory()) {
        return { ok: false, statusCode: 400, error: 'ROOT_NOT_DIRECTORY' };
      }
    } catch {
      return { ok: false, statusCode: 404, error: 'WORKTREE_PATH_MISSING' };
    }
  }

  if (explicitTargetProvided && hasAllowedRoots) {
    const allowedCanonRoots = rawAllowed
      .map((r) => pathCanonicalizer.canonicalizePath(r) || pathCanonicalizer.normalizeLocalPath(r))
      .filter(Boolean);
    const expandedAllowed = worktreeDiscovery
      ? worktreeDiscovery.getAuthorizedWorktreeRoots(allowedCanonRoots)
      : allowedCanonRoots;
    const isAuthorized = expandedAllowed.some((allowed) => pathCanonicalizer.isSameOrInside(canonTarget, allowed));
    const matchesProjectRoot = resolvedProject?.rootPath && pathCanonicalizer.isSameOrInside(
      canonTarget,
      pathCanonicalizer.canonicalizePath(resolvedProject.rootPath) || resolvedProject.rootPath
    );
    if (!isAuthorized && !matchesProjectRoot) {
      return { ok: false, statusCode: 403, error: 'PATH_OUTSIDE_WORKSPACE' };
    }
  }

  const effectivePath = (rawWorktreePath || matchedWt) ? canonTarget : normTarget;
  const workspaceUri = rawWorkspaceUri && !rawWorktreePath && !matchedWt
    ? rawWorkspaceUri
    : (pathCanonicalizer.pathToFileUri(effectivePath) || '');
  const worktreeId = pathCanonicalizer.makeWorktreeId(effectivePath);

  return {
    ok: true,
    projectId: resolvedProject?.id || cleanProjectId || null,
    projectName: resolvedProject?.name || null,
    resolvedProject,
    workspacePath: effectivePath,
    workspaceUri,
    worktreeId
  };
}

/**
 * Creates a process-level shared workspace-org runtime injected into T0/worker plugins.
 */
function createWorkspaceOrgRuntime(options = {}) {
  const worktreeDiscovery = worktreeDiscoveryMod.createWorktreeDiscoveryService(options.worktreeOptions);
  return {
    ...pathCanonicalizer,
    ...worktreeDiscoveryMod,
    ...sessionOrgCoreMod,
    worktreeDiscovery,
    resolveAndValidateSessionTarget
  };
}

module.exports = {
  ...pathCanonicalizer,
  ...worktreeDiscoveryMod,
  ...sessionOrgCoreMod,
  resolveAndValidateSessionTarget,
  createWorkspaceOrgRuntime
};
