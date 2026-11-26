'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  normalizeLocalPath,
  canonicalizePath,
  canonicalKey,
  isForbiddenSystemRoot,
  makeWorktreeId,
  matchWorktreeByLongestPrefix,
  parseWorktreePorcelain,
  sortWorktreeSubgroups,
  isSafeSiblingWorktreeTarget,
  createWorktreeDiscoveryService,
  createSessionOrgCore,
  resolveAndValidateSessionTarget,
  createWorkspaceOrgRuntime
} = require('../src/core/workspace-org');

function cleanupDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function initGitRepo(repoDir, branch = 'main') {
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-b', branch], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'ignore' });
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'hello\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });
}

test('path-canonicalizer: file:// CJK decoding, deleted ancestor realpath, forbidden roots & nested longest-prefix matching', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-wo-canon-'));
  try {
    const cjkSub = path.join(base, '中文 目录', 'sub');
    fs.mkdirSync(cjkSub, { recursive: true });
    const uri = `file://${encodeURI(cjkSub)}/`;
    assert.equal(normalizeLocalPath(uri), path.resolve(cjkSub));

    // Deleted descendant under /tmp still expands symlinked ancestor (/tmp -> /private/tmp on macOS)
    const missingDescendant = path.join(base, 'deleted-dir', 'nested');
    const canonMissing = canonicalizePath(missingDescendant);
    const realBase = fs.realpathSync.native(base);
    assert.equal(canonMissing, path.join(realBase, 'deleted-dir', 'nested'));

    // Forbidden system roots
    assert.equal(isForbiddenSystemRoot('/'), true);
    assert.equal(isForbiddenSystemRoot('/etc'), true);
    assert.equal(isForbiddenSystemRoot('/System'), true);
    assert.equal(isForbiddenSystemRoot(path.join(os.homedir(), '.ssh')), true);
    assert.equal(isForbiddenSystemRoot('C:\\'), true);
    assert.equal(isForbiddenSystemRoot(cjkSub), false);

    // Longest-prefix matching with nested .worktrees/wt-inner inside repo
    const repo = path.join(realBase, 'repo');
    const innerWt = path.join(repo, '.worktrees', 'wt-inner');
    const candidates = [
      { worktreeId: makeWorktreeId(repo), path: repo, canonicalKey: canonicalKey(repo) },
      { worktreeId: makeWorktreeId(innerWt), path: innerWt, canonicalKey: canonicalKey(innerWt) }
    ];
    const hitInner = matchWorktreeByLongestPrefix(path.join(innerWt, 'src', 'index.js'), candidates);
    const hitMain = matchWorktreeByLongestPrefix(path.join(repo, 'src', 'index.js'), candidates);
    const hitSibling = matchWorktreeByLongestPrefix(path.join(realBase, 'repo-other', 'file.js'), candidates);
    assert.equal(hitInner?.worktreeId, makeWorktreeId(innerWt));
    assert.equal(hitMain?.worktreeId, makeWorktreeId(repo));
    assert.equal(hitSibling, null);
  } finally {
    cleanupDir(base);
  }
});

test('worktree-discovery: porcelain states, deterministic sorting, cold .git/worktrees fallback, and sibling guard', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-wo-wt-'));
  try {
    const bareRepo = path.join(tmp, 'repo.git');
    const mainWt = path.join(tmp, 'repo');
    const featWt = path.join(tmp, 'repo-feat-auth');
    const lockedWt = path.join(tmp, 'repo-locked');
    const missingWt = path.join(tmp, 'repo-gone');

    const porcelain = [
      `worktree ${bareRepo}`,
      'bare',
      '',
      `worktree ${mainWt}`,
      'HEAD 1111111222222333333444444',
      'branch refs/heads/main',
      '',
      `worktree ${featWt}`,
      'HEAD aaaaaaa222222333333444444',
      'detached',
      '',
      `worktree ${lockedWt}`,
      'HEAD bbbbbbb222222333333444444',
      'branch refs/heads/hotfix',
      'locked reason',
      '',
      `worktree ${missingWt}`,
      'HEAD ccccccc222222333333444444',
      'branch refs/heads/old',
      'prunable gitdir file points to non-existent location',
      ''
    ].join('\n');

    fs.mkdirSync(bareRepo, { recursive: true });
    fs.mkdirSync(mainWt, { recursive: true });
    fs.mkdirSync(featWt, { recursive: true });
    fs.mkdirSync(lockedWt, { recursive: true });

    const parsed = parseWorktreePorcelain(porcelain, mainWt);
    assert.equal(parsed.length, 5);
    assert.equal(parsed[0].status, 'bare');
    assert.equal(parsed[1].isCurrent, true);
    assert.equal(parsed[1].status, 'ready');
    assert.equal(parsed[2].status, 'detached');
    assert.equal(parsed[3].status, 'locked');
    assert.equal(parsed[4].status, 'missing');

    const sorted = sortWorktreeSubgroups(parsed);
    assert.equal(sorted[0].path, canonicalizePath(mainWt));
    assert.equal(sorted[sorted.length - 1].bare || sorted[sorted.length - 1].status === 'missing', true);

    // Real git repo: discovery + cold cache fallback + safe sibling target validation
    const realRepo = path.join(tmp, 'app-repo');
    const siblingBranchDir = path.join(tmp, 'app-repo-feat-login');
    const bogusSibling = path.join(tmp, 'app-repo-other');
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-outside-'));
    try {
      initGitRepo(realRepo, 'main');
      assert.equal(isSafeSiblingWorktreeTarget(realRepo, siblingBranchDir, { branch: 'feat/login' }), true);
      assert.equal(isSafeSiblingWorktreeTarget(realRepo, bogusSibling, { branch: 'feat/login' }), false);
      assert.equal(isSafeSiblingWorktreeTarget(realRepo, outsideDir, { branch: 'feat/login' }), false);

      execFileSync('git', ['worktree', 'add', '-b', 'feat/login', siblingBranchDir], { cwd: realRepo, stdio: 'ignore' });
      const svc = createWorktreeDiscoveryService();

      // Before warm probe, cold fallback reads .git/worktrees/<name>/gitdir synchronously
      const coldRoots = svc.getAuthorizedWorktreeRoots([realRepo]);
      assert.equal(coldRoots.includes(canonicalizePath(realRepo)), true);
      assert.equal(coldRoots.includes(canonicalizePath(siblingBranchDir)), true);

      const listed = await svc.listWorktrees({ root: realRepo, refresh: true });
      assert.equal(listed.ok, true);
      assert.equal(listed.isGitRepo, true);
      assert.equal(listed.worktrees.length, 2);
      assert.equal(listed.isMultiWorktree, true);
    } finally {
      cleanupDir(outsideDir);
    }
  } finally {
    cleanupDir(tmp);
  }
});

test('session-org-core: group validation/fallback, collapsedNodes, cross-container lock & resolveAndValidateSessionTarget', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-wo-org-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-wo-out-'));
  try {
    const repo = path.join(tmp, 'proj-repo');
    const wtFeat = path.join(tmp, 'proj-repo-feat-x');
    const bareRepo = path.join(tmp, 'bare-repo.git');
    initGitRepo(repo, 'main');
    execFileSync('git', ['worktree', 'add', '-b', 'feat/x', wtFeat], { cwd: repo, stdio: 'ignore' });
    fs.mkdirSync(bareRepo, { recursive: true });
    execFileSync('git', ['init', '--bare'], { cwd: bareRepo, stdio: 'ignore' });

    const runtime = createWorkspaceOrgRuntime();
    const orgPath = path.join(tmp, 'session-org.json');
    const core = createSessionOrgCore({
      orgPath,
      dbPath: null,
      worktreeDiscovery: runtime.worktreeDiscovery
    });

    // 1. Group name length bounds & atomic non-empty group delete fallback
    assert.equal(core.mutateGroup({ action: 'create', name: '   ' }).error, 'INVALID_GROUP_NAME');
    assert.equal(core.mutateGroup({ action: 'create', name: 'x'.repeat(65) }).error, 'INVALID_GROUP_NAME');
    const grpRes = core.mutateGroup({ action: 'create', name: 'Backend' });
    assert.equal(grpRes.ok, true);

    let savedProjId = '';
    core.mutateOrgAtomically((org) => {
      const p = core.materializeProjectInOrg(org, {
        id: 'proj-main',
        name: 'Proj Repo',
        rootPath: repo,
        groupId: grpRes.group.id
      });
      savedProjId = p.id;
      org.projectGroupMap[p.id] = grpRes.group.id;
      return { buildResult: (saved) => saved };
    });
    const delGrp = core.mutateGroup({ action: 'delete', id: grpRes.group.id });
    assert.equal(delGrp.ok, true);
    assert.equal(delGrp.movedProjectCount, 1);
    assert.deepEqual(delGrp.movedProjectIds, [savedProjId]);

    // 2. Collapse state persistence for project & worktree
    const wtId = makeWorktreeId(wtFeat);
    assert.equal(core.setNodeCollapsed({ nodeType: 'project', nodeId: savedProjId, collapsed: true }).ok, true);
    assert.equal(core.setNodeCollapsed({ nodeType: 'worktree', nodeId: wtId, collapsed: true }).ok, true);
    assert.equal(core.setNodeCollapsed({ nodeType: 'bad', nodeId: 'x', collapsed: true }).statusCode, 400);
    const snap = core.getOrg();
    assert.equal(snap.collapsedNodes.projects[savedProjId], true);
    assert.equal(snap.collapsedNodes.worktrees[wtId], true);

    // 3. Reorder cross-container move rejection & topology dynamic preservation
    core.bindSessionWorkspace('cid-1', { worktreeId: wtId, workspacePath: wtFeat });
    const crossMove = core.reorderOrg({
      targetType: 'session',
      zone: 'normal',
      containerId: makeWorktreeId(repo),
      orderedIds: ['cid-1'],
      sessionContainers: { 'cid-1': wtId }
    });
    assert.equal(crossMove.ok, false);
    assert.equal(crossMove.statusCode, 409);
    assert.equal(crossMove.error, 'CROSS_CONTAINER_SESSION_MOVE_FORBIDDEN');

    core.mutateOrgAtomically((org) => {
      org.sessionOrder[savedProjId] = { pinned: ['cid-1'], normal: ['cid-2'] };
      return { buildResult: (saved) => saved };
    });
    const mainWtId = makeWorktreeId(repo);
    const topoUpgrade = core.syncWorktreeTopology({
      repoProjectId: savedProjId,
      mainWorktreeId: mainWtId,
      isMultiWorktree: true,
      missingWorktrees: [
        { worktreeId: 'wt-gone', repoRootPath: repo, path: path.join(tmp, 'proj-repo-gone'), branch: 'old' }
      ]
    });
    assert.equal(topoUpgrade.ok, true);
    assert.equal(core.loadPersistedOrg().sessionOrder[mainWtId].pinned.includes('cid-1'), true);
    assert.equal(Boolean(core.loadPersistedOrg().worktreeTombstones['wt-gone']), true);

    const topoDowngrade = core.syncWorktreeTopology({
      repoProjectId: savedProjId,
      mainWorktreeId: mainWtId,
      isMultiWorktree: false
    });
    assert.equal(topoDowngrade.ok, true);
    assert.equal(core.loadPersistedOrg().sessionOrder[savedProjId].normal.includes('cid-2'), true);

    // 4. resolveAndValidateSessionTarget checks
    await runtime.worktreeDiscovery.warmRoots([repo, bareRepo], { refresh: true });
    const validTarget = await resolveAndValidateSessionTarget(
      { projectId: savedProjId, worktreePath: wtFeat },
      { getAllowedRoots: () => [repo], worktreeDiscovery: runtime.worktreeDiscovery }
    );
    assert.equal(validTarget.ok, true);
    assert.equal(validTarget.worktreeId, wtId);

    const missingRes = await resolveAndValidateSessionTarget(
      { worktreePath: path.join(tmp, 'does-not-exist') },
      { getAllowedRoots: () => [repo], worktreeDiscovery: runtime.worktreeDiscovery }
    );
    assert.equal(missingRes.ok, false);
    assert.equal(missingRes.statusCode, 404);
    assert.equal(missingRes.error, 'WORKTREE_PATH_MISSING');

    const bareRes = await resolveAndValidateSessionTarget(
      { worktreePath: bareRepo },
      { getAllowedRoots: () => [bareRepo], worktreeDiscovery: runtime.worktreeDiscovery }
    );
    assert.equal(bareRes.ok, false);
    assert.equal(bareRes.statusCode, 400);
    assert.equal(bareRes.error, 'WORKTREE_IS_BARE');

    const outRes = await resolveAndValidateSessionTarget(
      { worktreePath: outsideDir },
      { getAllowedRoots: () => [repo], worktreeDiscovery: runtime.worktreeDiscovery }
    );
    assert.equal(outRes.ok, false);
    assert.equal(outRes.statusCode, 403);
    assert.equal(outRes.error, 'PATH_OUTSIDE_WORKSPACE');

    const sysRes = await resolveAndValidateSessionTarget(
      { worktreePath: '/' },
      { getAllowedRoots: () => [repo], worktreeDiscovery: runtime.worktreeDiscovery }
    );
    assert.equal(sysRes.ok, false);
    assert.equal(sysRes.statusCode, 403);
    assert.equal(sysRes.error, 'FORBIDDEN_SYSTEM_ROOT');
  } finally {
    cleanupDir(tmp);
    cleanupDir(outsideDir);
  }
});
