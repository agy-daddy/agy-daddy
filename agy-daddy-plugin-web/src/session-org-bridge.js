'use strict';

const path = require('node:path');

/**
 * Resolves the shared workspace-org domain core from:
 * 1) In-process host injection (`host.workspaceOrg`)
 * 2) Worker / packaged host env (`AGY_DADDY_HOST_DIR`)
 * 3) Monorepo workspace fallback (`../../agy-daddy-host/src/core/workspace-org`)
 */
function resolveWorkspaceOrg(host) {
  if (host && host.workspaceOrg) {
    return host.workspaceOrg;
  }
  if (process.env.AGY_DADDY_HOST_DIR) {
    try {
      return require(path.join(process.env.AGY_DADDY_HOST_DIR, 'src', 'core', 'workspace-org'));
    } catch {
      // Fallback to monorepo path
    }
  }
  return require(path.resolve(__dirname, '..', '..', 'agy-daddy-host', 'src', 'core', 'workspace-org'));
}

const defaultWorkspaceOrg = resolveWorkspaceOrg(null);

function createSessionOrgBridge(options = {}) {
  const workspaceOrg = resolveWorkspaceOrg(options.host);
  const effectiveWorktreeDiscovery = options.worktreeDiscovery !== undefined
    ? options.worktreeDiscovery
    : (options.host?.workspaceOrg?.worktreeDiscovery || null);
  const core = workspaceOrg.createSessionOrgCore({
    pluginId: 'agy-daddy.web',
    ...options,
    worktreeDiscovery: effectiveWorktreeDiscovery
  });
  return {
    ...core,
    worktreeDiscovery: effectiveWorktreeDiscovery
  };
}

module.exports = {
  resolveWorkspaceOrg,
  createSessionOrgBridge,
  createEmptyPersistedOrg: defaultWorkspaceOrg.createEmptyPersistedOrg,
  sanitizePersistedOrg: defaultWorkspaceOrg.sanitizePersistedOrg,
  buildOrgBusSummary: defaultWorkspaceOrg.buildOrgBusSummary,
  aggregateWorktreeProjects: defaultWorkspaceOrg.aggregateWorktreeProjects,
  normalizeLocalPath: defaultWorkspaceOrg.normalizeLocalPath,
  canonicalizePath: defaultWorkspaceOrg.canonicalizePath,
  canonicalKey: defaultWorkspaceOrg.canonicalKey,
  getPathLookupKeys: defaultWorkspaceOrg.getPathLookupKeys,
  pathToFileUri: defaultWorkspaceOrg.pathToFileUri,
  deriveWorkspaceProjectId: defaultWorkspaceOrg.deriveWorkspaceProjectId,
  makeAppSyncedProjectId: defaultWorkspaceOrg.makeAppSyncedProjectId,
  makeImplicitProjectId: defaultWorkspaceOrg.makeImplicitProjectId,
  makeStableProjectId: defaultWorkspaceOrg.makeStableProjectId,
  makeWorktreeId: defaultWorkspaceOrg.makeWorktreeId,
  matchWorktreeByLongestPrefix: defaultWorkspaceOrg.matchWorktreeByLongestPrefix
};
