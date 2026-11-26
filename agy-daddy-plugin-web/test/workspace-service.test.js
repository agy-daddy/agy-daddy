'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const url = require('node:url');
const { execFileSync } = require('node:child_process');

const {
  createWorkspaceService,
  normalizeInputRoot,
  resolveRealPath,
  isForbiddenSystemRoot
} = require('../src/workspace-service');
const {
  createWorkspaceMetaStore,
  normalizeLocalPath
} = require('../src/workspace-meta-store');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('C1: listTree lists workspace files, ignores .git and node_modules, and sorts dirs before files', () => {
  const ws = makeTempDir('agy-ws-c1-');
  try {
    fs.mkdirSync(path.join(ws, '.git', 'objects'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.git', 'config'), '[core]\n', 'utf8');
    fs.mkdirSync(path.join(ws, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'node_modules', 'a.js'), 'module.exports = 1;\n', 'utf8');
    fs.mkdirSync(path.join(ws, 'src', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'src', 'index.js'), 'console.log(1);\n', 'utf8');
    fs.writeFileSync(path.join(ws, 'src', 'nested', 'deep.js'), 'export default 1;\n', 'utf8');
    fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'README.md'), '# Test\n', 'utf8');
    fs.writeFileSync(path.join(ws, 'alpha.txt'), 'a\n', 'utf8');

    const svc = createWorkspaceService({ allowedRoots: [ws] });
    const res = svc.listTree({ root: ws, depth: 2 });

    assert.equal(res.ok, true);
    const names = res.entries.map((e) => e.name);
    assert.equal(names.includes('.git'), false);
    assert.equal(names.includes('node_modules'), false);

    // Directories first alphabetically, then files alphabetically
    assert.deepEqual(names, ['docs', 'src', 'alpha.txt', 'README.md']);
    assert.equal(res.entries[0].type, 'directory');
    assert.equal(res.entries[1].type, 'directory');
    assert.equal(res.entries[2].type, 'file');
    assert.equal(res.entries[3].type, 'file');

    const srcNode = res.entries.find((e) => e.name === 'src');
    assert.ok(srcNode);
    assert.deepEqual(
      srcNode.children.map((c) => c.name),
      ['nested', 'index.js']
    );
    // depth=2 stops expanding src/nested children
    const nestedNode = srcNode.children.find((c) => c.name === 'nested');
    assert.equal(nestedNode.type, 'directory');
    assert.equal(nestedNode.children, undefined);

    // Subdirectory listing with depth=1
    const subRes = svc.listTree({ root: ws, path: 'src', depth: 1 });
    assert.equal(subRes.ok, true);
    assert.equal(subRes.path, 'src');
    assert.deepEqual(subRes.entries.map((e) => e.name), ['nested', 'index.js']);
    assert.equal(subRes.entries[0].children, undefined);
  } finally {
    cleanupDir(ws);
  }
});

test('C2: path traversal, absolute outside paths, and escaping symlinks are rejected with 403', () => {
  const ws = makeTempDir('agy-ws-c2-');
  const outsideDir = makeTempDir('agy-outside-c2-');
  try {
    const secretFile = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(secretFile, 'TOP_SECRET', 'utf8');

    const linkFile = path.join(ws, 'escape-file.txt');
    fs.symlinkSync(secretFile, linkFile);

    const linkDir = path.join(ws, 'escape-dir');
    fs.symlinkSync(outsideDir, linkDir);

    const danglingEscape = path.join(ws, 'dangling-escape.txt');
    fs.symlinkSync(path.join(outsideDir, 'nonexistent.txt'), danglingEscape);

    const svc = createWorkspaceService({ allowedRoots: [ws] });

    const cases = [
      () => svc.readFile({ root: ws, path: '../../etc/passwd' }),
      () => svc.readFile({ root: ws, path: '/etc/hosts' }),
      () => svc.readFile({ root: ws, path: 'escape-file.txt' }),
      () => svc.readFile({ root: ws, path: 'escape-dir/secret.txt' }),
      () => svc.listTree({ root: ws, path: 'escape-dir' }),
      () => svc.listTree({ root: outsideDir }),
      () => svc.writeFile({ root: ws, path: '../../outside.txt', content: 'x' }),
      () => svc.writeFile({ root: ws, path: '/tmp/outside-abs.txt', content: 'x' }),
      () => svc.writeFile({ root: ws, path: 'escape-file.txt', content: 'overwrite' }),
      () => svc.writeFile({ root: ws, path: 'escape-dir/new.txt', content: 'escape' }),
      () => svc.writeFile({ root: ws, path: 'dangling-escape.txt', content: 'escape' })
    ];

    for (const invoke of cases) {
      const res = invoke();
      assert.equal(res.ok, false);
      assert.equal(res.statusCode, 403);
      assert.equal(res.error, 'PATH_OUTSIDE_WORKSPACE');
    }

    // Outside files must remain untouched
    assert.equal(fs.readFileSync(secretFile, 'utf8'), 'TOP_SECRET');
    assert.equal(fs.existsSync(path.join(outsideDir, 'new.txt')), false);
    assert.equal(fs.existsSync(path.join(outsideDir, 'nonexistent.txt')), false);
  } finally {
    cleanupDir(ws);
    cleanupDir(outsideDir);
  }
});

test('C3: readFile enforces bounded read truncation, 404 on missing, and writeFile enforces maxWriteBytes & atomic write', () => {
  const ws = makeTempDir('agy-ws-c3-');
  try {
    const bigFile = path.join(ws, 'big.txt');
    fs.writeFileSync(bigFile, 'A'.repeat(2048), 'utf8');

    const svc = createWorkspaceService({
      allowedRoots: [ws],
      maxReadBytes: 128,
      maxWriteBytes: 64
    });

    // Bounded read truncates cleanly
    const readBig = svc.readFile({ root: ws, path: 'big.txt' });
    assert.equal(readBig.ok, true);
    assert.equal(readBig.size, 2048);
    assert.equal(readBig.truncated, true);
    assert.equal(readBig.content.length, 128);

    // Explicit maxBytes override
    const readExact = svc.readFile({ root: ws, path: 'big.txt', maxBytes: 2048 });
    assert.equal(readExact.ok, true);
    assert.equal(readExact.truncated, false);
    assert.equal(readExact.content.length, 2048);

    // Missing file returns 404
    const missing = svc.readFile({ root: ws, path: 'does-not-exist.txt' });
    assert.equal(missing.ok, false);
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.error, 'FILE_NOT_FOUND');

    // Oversized write returns 413
    const tooBigWrite = svc.writeFile({ root: ws, path: 'out.txt', content: 'B'.repeat(65) });
    assert.equal(tooBigWrite.ok, false);
    assert.equal(tooBigWrite.statusCode, 413);
    assert.equal(tooBigWrite.error, 'PAYLOAD_TOO_LARGE');
    assert.equal(fs.existsSync(path.join(ws, 'out.txt')), false);

    // Valid write including new nested dir succeeds and leaves no temp files
    const writeOk = svc.writeFile({ root: ws, path: 'sub/hello.txt', content: 'hello world' });
    assert.equal(writeOk.ok, true);
    assert.equal(writeOk.path, 'sub/hello.txt');
    assert.equal(writeOk.bytes, 11);

    const readBack = svc.readFile({ root: ws, path: 'sub/hello.txt' });
    assert.equal(readBack.ok, true);
    assert.equal(readBack.content, 'hello world');
    assert.equal(readBack.truncated, false);

    const subEntries = fs.readdirSync(path.join(ws, 'sub'));
    assert.deepEqual(subEntries, ['hello.txt']);

    // Atomic overwrite of existing file
    const overwriteOk = svc.writeFile({ root: ws, path: 'sub/hello.txt', content: 'updated' });
    assert.equal(overwriteOk.ok, true);
    assert.equal(svc.readFile({ root: ws, path: 'sub/hello.txt' }).content, 'updated');
    assert.deepEqual(fs.readdirSync(path.join(ws, 'sub')), ['hello.txt']);

    // Reading a directory returns 400
    const dirRead = svc.readFile({ root: ws, path: 'sub' });
    assert.equal(dirRead.ok, false);
    assert.equal(dirRead.statusCode, 400);
  } finally {
    cleanupDir(ws);
  }
});

test('C4: getGitDiff returns structured diff for git repos and degrades gracefully for non-git dirs', async () => {
  const gitWs = makeTempDir('agy-ws-c4-git-');
  const plainWs = makeTempDir('agy-ws-c4-plain-');
  try {
    execFileSync('git', ['init'], { cwd: gitWs, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: gitWs, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: gitWs, stdio: 'ignore' });

    const tracked = path.join(gitWs, 'app.js');
    fs.writeFileSync(tracked, 'const a = 1;\n', 'utf8');
    execFileSync('git', ['add', 'app.js'], { cwd: gitWs, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: gitWs, stdio: 'ignore' });

    fs.writeFileSync(tracked, 'const a = 2;\nconst b = 3;\n', 'utf8');

    const svc = createWorkspaceService({ allowedRoots: [gitWs, plainWs] });

    const gitRes = await svc.getGitDiff({ root: gitWs });
    assert.equal(gitRes.ok, true);
    assert.equal(gitRes.isGitRepo, true);
    assert.ok(typeof gitRes.branch === 'string' && gitRes.branch.length > 0);
    assert.ok(gitRes.diffText.includes('-const a = 1;'));
    assert.ok(gitRes.diffText.includes('+const a = 2;'));
    assert.ok(Array.isArray(gitRes.files) && gitRes.files.length >= 1);
    assert.equal(gitRes.files[0].path, 'app.js');

    const plainRes = await svc.getGitDiff({ root: plainWs });
    assert.deepEqual(plainRes, {
      ok: true,
      isGitRepo: false,
      branch: '',
      files: [],
      diffText: ''
    });

    const escapeRes = await svc.getGitDiff({ root: gitWs, path: '../../etc/passwd' });
    assert.equal(escapeRes.ok, false);
    assert.equal(escapeRes.statusCode, 403);
    assert.equal(escapeRes.error, 'PATH_OUTSIDE_WORKSPACE');
  } finally {
    cleanupDir(gitWs);
    cleanupDir(plainWs);
  }
});

test('C5: listArtifacts and readArtifact read brain/<sessionId> safely and block traversal', () => {
  const brainDir = makeTempDir('agy-brain-c5-');
  const outsideDir = makeTempDir('agy-brain-outside-c5-');
  try {
    const sid = '11111111-2222-3333-4444-555555555555';
    const sessionDir = path.join(brainDir, sid);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'plan.md'), '# Plan\nStep 1\n', 'utf8');
    fs.writeFileSync(path.join(outsideDir, 'secret.md'), 'SECRET', 'utf8');
    fs.symlinkSync(path.join(outsideDir, 'secret.md'), path.join(sessionDir, 'evil.md'));

    const svc = createWorkspaceService({ allowedRoots: [], brainDir });

    const listed = svc.listArtifacts(sid);
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.items.map((i) => i.name), ['plan.md']);

    const readOk = svc.readArtifact(sid, 'plan.md');
    assert.equal(readOk.ok, true);
    assert.equal(readOk.name, 'plan.md');
    assert.equal(readOk.mime, 'text/markdown');
    assert.equal(readOk.content, '# Plan\nStep 1\n');

    const missingArt = svc.readArtifact(sid, 'missing.md');
    assert.equal(missingArt.ok, false);
    assert.equal(missingArt.statusCode, 404);

    // Traversal and bad sessionId checks
    for (const badSid of ['../secret', 'a/b', 'a\\b', '', '..']) {
      const r1 = svc.listArtifacts(badSid);
      assert.equal(r1.ok, false);
      assert.equal(r1.statusCode, 403);
      assert.equal(r1.error, 'PATH_OUTSIDE_WORKSPACE');

      const r2 = svc.readArtifact(badSid, 'plan.md');
      assert.equal(r2.ok, false);
      assert.equal(r2.statusCode, 403);
      assert.equal(r2.error, 'PATH_OUTSIDE_WORKSPACE');
    }

    // Traversal and symlink escape on fileName
    for (const badFile of ['../secret.md', '/etc/hosts', 'evil.md']) {
      const r = svc.readArtifact(sid, badFile);
      assert.equal(r.ok, false);
      assert.equal(r.statusCode, 403);
      assert.equal(r.error, 'PATH_OUTSIDE_WORKSPACE');
    }

    // Missing session directory still blocks traversal and returns empty list for valid ID
    const emptyList = svc.listArtifacts('99999999-9999-9999-9999-999999999999');
    assert.equal(emptyList.ok, true);
    assert.deepEqual(emptyList.items, []);
  } finally {
    cleanupDir(brainDir);
    cleanupDir(outsideDir);
  }
});

test('C6: dynamic getAllowedRoots(), file:// URI with CJK & spaces, case-insensitive matching, and 404 vs 403', () => {
  const base = makeTempDir('agy-ws-c6-');
  const outside = makeTempDir('agy-outside-c6-');
  try {
    const cjkSub = path.join(base, '中文 项目');
    fs.mkdirSync(cjkSub, { recursive: true });
    fs.writeFileSync(path.join(cjkSub, 'readme.txt'), 'hello cjk', 'utf8');

    const literalPct = path.join(base, 'literal%20dir');
    fs.mkdirSync(literalPct, { recursive: true });
    fs.writeFileSync(path.join(literalPct, 'keep.txt'), 'literal', 'utf8');

    // Dynamic roots start empty -> 403
    let dynamicRoots = [];
    const svc = createWorkspaceService({
      getAllowedRoots: () => dynamicRoots
    });
    assert.equal(svc.listTree({ root: cjkSub }).statusCode, 403);
    assert.equal(svc.listTree({ root: path.join(base, 'missing-inside') }).statusCode, 403);

    // Dynamically add root (as file:// URI)
    const baseFileUri = url.pathToFileURL(base).href;
    dynamicRoots = [baseFileUri];

    // Access via encoded file:// URI with CJK + spaces
    const cjkFileUri = url.pathToFileURL(cjkSub).href;
    const treeRes = svc.listTree({ root: cjkFileUri });
    assert.equal(treeRes.ok, true);
    assert.deepEqual(treeRes.entries.map((e) => e.name), ['readme.txt']);

    // Access via percent-encoded non-file path when raw doesn't exist on disk but decoded does
    const encodedRawPath = path.join(base, encodeURIComponent('中文 项目'));
    const readRes = svc.readFile({ root: encodedRawPath, path: 'readme.txt' });
    assert.equal(readRes.ok, true);
    assert.equal(readRes.content, 'hello cjk');

    // Literal %20 directory existing on disk is NOT erroneously decoded
    const literalRes = svc.readFile({ root: literalPct, path: 'keep.txt' });
    assert.equal(literalRes.ok, true);
    assert.equal(literalRes.content, 'literal');
    assert.equal(normalizeInputRoot(literalPct), path.resolve(literalPct));

    // Non-existent root inside an allowedRealRoot returns 404 ROOT_NOT_FOUND
    const missingInside = svc.listTree({ root: path.join(base, 'does-not-exist-subdir') });
    assert.equal(missingInside.ok, false);
    assert.equal(missingInside.statusCode, 404);
    assert.equal(missingInside.error, 'ROOT_NOT_FOUND');

    // Non-existent root OUTSIDE allowedRealRoots still returns 403 PATH_OUTSIDE_WORKSPACE (no existence leak)
    const missingOutside = svc.listTree({ root: path.join(outside, 'does-not-exist') });
    assert.equal(missingOutside.ok, false);
    assert.equal(missingOutside.statusCode, 403);
    assert.equal(missingOutside.error, 'PATH_OUTSIDE_WORKSPACE');

    // Symlink escape inside allowed root still returns 403
    const escapeLink = path.join(base, 'escape-root');
    fs.symlinkSync(outside, escapeLink);
    const escapeRes = svc.listTree({ root: escapeLink });
    assert.equal(escapeRes.ok, false);
    assert.equal(escapeRes.statusCode, 403);
    assert.equal(escapeRes.error, 'PATH_OUTSIDE_WORKSPACE');

    // Dangling symlink pointing outside allowed root returns 403
    const danglingRoot = path.join(base, 'dangling-root');
    fs.symlinkSync(path.join(outside, 'missing-target'), danglingRoot);
    const danglingRes = svc.listTree({ root: danglingRoot });
    assert.equal(danglingRes.ok, false);
    assert.equal(danglingRes.statusCode, 403);
    assert.equal(danglingRes.error, 'PATH_OUTSIDE_WORKSPACE');

    // Case-insensitive matching on darwin/win32
    if (process.platform === 'darwin' || process.platform === 'win32') {
      const toggledCase = cjkSub.replace(/agy-ws-c6-/i, 'AGY-WS-C6-');
      const caseRes = svc.readFile({ root: toggledCase, path: 'readme.txt' });
      assert.equal(caseRes.ok, true);
      assert.equal(caseRes.content, 'hello cjk');
    }

    // Sibling prefix must still be rejected
    const siblingDir = `${base}-sibling`;
    fs.mkdirSync(siblingDir, { recursive: true });
    try {
      const siblingRes = svc.listTree({ root: siblingDir });
      assert.equal(siblingRes.ok, false);
      assert.equal(siblingRes.statusCode, 403);
    } finally {
      cleanupDir(siblingDir);
    }

    // Removing root revokes access immediately
    dynamicRoots = [];
    assert.equal(svc.listTree({ root: cjkSub }).statusCode, 403);
  } finally {
    cleanupDir(base);
    cleanupDir(outside);
  }
});

test('C7: normalizeLocalPath and isForbiddenSystemRoot enforce path hygiene and block system roots', () => {
  // normalizeLocalPath handles file://, percent-encoded CJK, ~/, and trailing slashes
  assert.equal(normalizeLocalPath('file:///tmp/my%20proj/%E4%B8%AD%E6%96%87/'), path.resolve('/tmp/my proj/中文'));
  assert.equal(normalizeLocalPath('/tmp/plain%20path/%E6%B5%8B%E8%AF%95///'), path.resolve('/tmp/plain path/测试'));
  assert.equal(normalizeLocalPath('~/antigravity-test/'), path.join(os.homedir(), 'antigravity-test'));

  // Forbidden roots
  const forbidden = [
    '/',
    '/System',
    '/System/Library',
    '/etc',
    '/etc/',
    '/private/etc',
    '/usr',
    '/bin',
    '/sbin',
    '/var/root',
    '~/.ssh',
    '~/.ssh/keys',
    '~/.aws',
    '~/.gnupg',
    'C:\\Windows',
    'c:\\windows\\System32'
  ];
  for (const p of forbidden) {
    assert.equal(isForbiddenSystemRoot(p), true, `Expected ${p} to be forbidden`);
  }

  if (process.platform === 'darwin' || process.platform === 'win32') {
    assert.equal(isForbiddenSystemRoot('/system/library'), true);
    assert.equal(isForbiddenSystemRoot('/PRIVATE/ETC'), true);
  }

  // Normal directories are allowed
  const safeTmp = makeTempDir('agy-safe-root-');
  try {
    assert.equal(isForbiddenSystemRoot(safeTmp), false);
    assert.equal(isForbiddenSystemRoot(path.join(os.homedir(), 'antigravity-workspace')), false);
  } finally {
    cleanupDir(safeTmp);
  }
});

test('C8: workspace-meta-store CRUD, persistence, implicit discovery, and session enrichment/sorting', async () => {
  const tmpBase = makeTempDir('agy-meta-c8-');
  try {
    const projADir = path.join(tmpBase, 'proj-alpha');
    const projBDir = path.join(tmpBase, 'proj-beta');
    const implicitDir = path.join(tmpBase, 'implicit-gamma');
    const defaultDir = path.join(tmpBase, 'default-ws');
    fs.mkdirSync(projADir, { recursive: true });
    fs.mkdirSync(implicitDir, { recursive: true });
    fs.mkdirSync(defaultDir, { recursive: true });

    // In-memory storage mock matching PluginDataStore { ok, exists, data } shape
    const persistedFiles = new Map();
    const storage = {
      readJson(name, fallback = null) {
        if (!persistedFiles.has(name)) return { ok: true, exists: false, data: fallback };
        return { ok: true, exists: true, data: JSON.parse(persistedFiles.get(name)) };
      },
      writeJson(name, data) {
        persistedFiles.set(name, JSON.stringify(data));
        return { ok: true };
      }
    };

    const store = createWorkspaceMetaStore({ storage, defaultBaseDir: defaultDir });
    assert.equal(store.getState().defaultSessionPath, defaultDir);

    // Rejects forbidden system roots on project creation & setDefaultSessionPath
    const badProj = store.createProject({ name: 'Bad', rootPath: '/etc' });
    assert.equal(badProj.ok, false);
    assert.equal(badProj.statusCode, 403);
    assert.equal(badProj.error, 'FORBIDDEN_SYSTEM_ROOT');

    const badDefault = store.setDefaultSessionPath('~/.ssh');
    assert.equal(badDefault.ok, false);
    assert.equal(badDefault.statusCode, 403);

    // Create group
    const grpRes = store.createGroup({ name: 'Core Work' });
    assert.equal(grpRes.ok, true);
    const groupId = grpRes.group.id;

    // Update group
    const grpUpd = store.updateGroup(groupId, { collapsed: true, sortOrder: 2, name: 'Core' });
    assert.equal(grpUpd.ok, true);
    assert.equal(grpUpd.group.collapsed, true);
    assert.equal(grpUpd.group.name, 'Core');

    // Create projects (existing + createDir: true)
    const pARes = store.createProject({ name: 'Alpha', rootPath: projADir, groupId });
    assert.equal(pARes.ok, true);
    assert.equal(pARes.project.groupId, groupId);

    const pBRes = store.createProject({ name: 'Beta', rootPath: projBDir, createDir: true });
    assert.equal(pBRes.ok, true);
    assert.equal(fs.existsSync(projBDir), true);

    // Duplicate project rejected with 409
    const dupRes = store.createProject({ name: 'Alpha Dup', rootPath: `file://${projADir}/` });
    assert.equal(dupRes.ok, false);
    assert.equal(dupRes.statusCode, 409);

    assert.deepEqual(store.getProjectRootPaths(), [projADir, projBDir]);
    assert.equal(store.getProjectById(pARes.project.id).name, 'Alpha');
    assert.equal(store.getProjectById('missing-id'), null);

    // Session pin + override + enrichment
    const sessions = [
      {
        cascadeId: 's-old-pinned',
        title: 'Old Pinned',
        lastModifiedTime: '2026-01-01T10:00:00Z',
        workspaceUri: `file://${projADir}/`
      },
      {
        cascadeId: 's-new-pinned',
        title: 'New Pinned',
        lastModifiedTime: '2026-01-02T10:00:00Z',
        workspaceUri: `file://${implicitDir}`
      },
      {
        cascadeId: 's-unpinned-new',
        title: 'Unpinned New',
        lastModifiedTime: '2026-01-05T10:00:00Z',
        workspaceUri: `file://${implicitDir}/`
      },
      {
        cascadeId: 's-detached',
        title: 'Detached',
        lastModifiedTime: '2026-01-04T10:00:00Z',
        workspaceUri: `file://${projADir}`
      },
      {
        cascadeId: 's-overridden',
        title: 'Overridden',
        lastModifiedTime: '2026-01-03T10:00:00Z',
        workspaceUri: `file://${projADir}`
      }
    ];

    assert.equal(store.setSessionPin('s-old-pinned', true).ok, true);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(store.setSessionPin('s-new-pinned', true).ok, true);

    // Override s-detached to null (standalone) and s-overridden to Beta
    assert.equal(store.assignSessionProject('s-detached', null).projectId, null);
    assert.equal(store.assignSessionProject('s-overridden', pBRes.project.id).projectId, pBRes.project.id);

    // Merge registered + implicit projects deduplicated with accurate sessionCount
    const listed = store.listProjectsAndGroups(sessions);
    assert.equal(listed.ok, true);
    const alphaListed = listed.projects.find((p) => p.id === pARes.project.id);
    const betaListed = listed.projects.find((p) => p.id === pBRes.project.id);
    const implicitListed = listed.projects.filter((p) => p.implicit === true);
    assert.equal(alphaListed.sessionCount, 1); // s-old-pinned only (detached=null, overridden=Beta)
    assert.equal(betaListed.sessionCount, 1); // s-overridden
    assert.equal(implicitListed.length, 1); // deduplicated across s-new-pinned and s-unpinned-new
    assert.equal(implicitListed[0].rootPath, implicitDir);
    assert.equal(implicitListed[0].sessionCount, 2);

    // Standalone session with workspaceUri === defaultSessionPath must NOT spawn an implicit project
    const defaultSession = {
      cascadeId: 's-default-standalone',
      title: 'Default Standalone',
      lastModifiedTime: '2026-01-06T10:00:00Z',
      workspaceUri: `file://${defaultDir}/`
    };
    const listedWithDefault = store.listProjectsAndGroups([...sessions, defaultSession]);
    assert.equal(listedWithDefault.projects.filter((p) => p.implicit === true).length, 1);
    const enrichedWithDefault = store.enrichSessions([...sessions, defaultSession]);
    const defaultEnriched = enrichedWithDefault.find((s) => s.cascadeId === 's-default-standalone');
    assert.equal(defaultEnriched.projectId, null);
    assert.equal(defaultEnriched.projectName, null);

    // Enrich & sort: pinned first by pinnedAt desc, then unpinned by lastModifiedTime desc
    const enriched = store.enrichSessions(sessions);
    assert.deepEqual(
      enriched.map((s) => s.cascadeId),
      ['s-new-pinned', 's-old-pinned', 's-unpinned-new', 's-detached', 's-overridden']
    );
    assert.equal(enriched[0].pinned, true);
    assert.equal(enriched[0].projectId, implicitListed[0].id);
    assert.equal(enriched[1].projectId, pARes.project.id);
    assert.equal(enriched[1].projectName, 'Alpha');
    assert.equal(enriched[3].pinned, false);
    assert.equal(enriched[3].projectId, null);
    assert.equal(enriched[4].projectId, pBRes.project.id);
    assert.equal(enriched[4].projectName, 'Beta');

    // Persistence reload preserves state
    const reloaded = createWorkspaceMetaStore({ storage });
    assert.equal(reloaded.getState().projects.length, 2);
    assert.equal(reloaded.getState().groups.length, 1);
    assert.ok(reloaded.getState().pinnedSessions['s-new-pinned']);

    // deleteGroup sets groupId: null on member projects
    assert.equal(reloaded.deleteGroup(groupId).deleted, true);
    assert.equal(reloaded.getProjectById(pARes.project.id).groupId, null);

    // deleteProject unregisters only (dir stays on disk) and clears sessionProjectOverrides referencing it
    assert.equal(reloaded.deleteProject(pBRes.project.id).deleted, true);
    assert.equal(fs.existsSync(projBDir), true);
    assert.equal(reloaded.getState().sessionProjectOverrides['s-overridden'], undefined);
    assert.equal(reloaded.getState().sessionProjectOverrides['s-detached'], null);

    // In-memory fallback when storage omitted
    const memStore = createWorkspaceMetaStore();
    assert.equal(memStore.getState().defaultSessionPath, path.join(os.homedir(), 'antigravity-workspace'));
    assert.equal(memStore.createGroup({ name: 'Mem' }).ok, true);
  } finally {
    cleanupDir(tmpBase);
  }
});

test('C9: readArtifactRaw serves binary png/pdf/svg/webp/gif buffers and enforces traversal 403, dir 400, missing 404, and >maxBytes 413', () => {
  const brainDir = makeTempDir('agy-brain-c9-');
  const outsideDir = makeTempDir('agy-brain-outside-c9-');
  try {
    const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const sessionDir = path.join(brainDir, sid);
    fs.mkdirSync(path.join(sessionDir, 'nested'), { recursive: true });

    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    const pdfBytes = Buffer.from('%PDF-1.4\n%binary\n', 'utf8');
    const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8');
    const webpBytes = Buffer.from('RIFF\x00\x00\x00\x00WEBP', 'latin1');
    const gifBytes = Buffer.from('GIF89a', 'ascii');

    fs.writeFileSync(path.join(sessionDir, 'diagram.png'), pngBytes);
    fs.writeFileSync(path.join(sessionDir, 'report.pdf'), pdfBytes);
    fs.writeFileSync(path.join(sessionDir, 'nested', 'icon.svg'), svgBytes);
    fs.writeFileSync(path.join(sessionDir, 'photo.webp'), webpBytes);
    fs.writeFileSync(path.join(sessionDir, 'anim.gif'), gifBytes);
    fs.writeFileSync(path.join(sessionDir, 'big.pdf'), Buffer.alloc(1024, 0x25));

    fs.writeFileSync(path.join(outsideDir, 'secret.png'), pngBytes);
    fs.symlinkSync(path.join(outsideDir, 'secret.png'), path.join(sessionDir, 'escape.png'));

    const svc = createWorkspaceService({ allowedRoots: [], brainDir });

    const listed = svc.listArtifacts(sid);
    assert.equal(listed.ok, true);
    const byName = Object.fromEntries(listed.items.map((item) => [item.name, item]));
    assert.equal(byName['report.pdf'].mime, 'application/pdf');
    assert.equal(byName['photo.webp'].mime, 'image/webp');
    assert.equal(byName['anim.gif'].mime, 'image/gif');

    const rawPng = svc.readArtifactRaw(sid, 'diagram.png');
    assert.equal(rawPng.ok, true);
    assert.equal(rawPng.name, 'diagram.png');
    assert.equal(rawPng.path, 'diagram.png');
    assert.equal(rawPng.mime, 'image/png');
    assert.equal(rawPng.size, pngBytes.byteLength);
    assert.equal(Buffer.compare(rawPng.buffer, pngBytes), 0);

    const rawPdf = svc.readArtifactRaw(sid, 'report.pdf');
    assert.equal(rawPdf.ok, true);
    assert.equal(rawPdf.mime, 'application/pdf');
    assert.equal(Buffer.compare(rawPdf.buffer, pdfBytes), 0);

    const rawSvg = svc.readArtifactRaw(sid, 'nested/icon.svg');
    assert.equal(rawSvg.ok, true);
    assert.equal(rawSvg.name, 'icon.svg');
    assert.equal(rawSvg.path, 'nested/icon.svg');
    assert.equal(rawSvg.mime, 'image/svg+xml');
    assert.equal(Buffer.compare(rawSvg.buffer, svgBytes), 0);

    // >maxBytes returns 413 PAYLOAD_TOO_LARGE
    const tooLarge = svc.readArtifactRaw(sid, 'big.pdf', { maxBytes: 512 });
    assert.equal(tooLarge.ok, false);
    assert.equal(tooLarge.statusCode, 413);
    assert.equal(tooLarge.error, 'PAYLOAD_TOO_LARGE');

    // Directory returns 400 IS_A_DIRECTORY
    const dirRes = svc.readArtifactRaw(sid, 'nested');
    assert.equal(dirRes.ok, false);
    assert.equal(dirRes.statusCode, 400);
    assert.equal(dirRes.error, 'IS_A_DIRECTORY');

    // Missing file returns 404 FILE_NOT_FOUND
    const missingRes = svc.readArtifactRaw(sid, 'missing.png');
    assert.equal(missingRes.ok, false);
    assert.equal(missingRes.statusCode, 404);
    assert.equal(missingRes.error, 'FILE_NOT_FOUND');

    // Traversal and escaping symlink checks return 403 PATH_OUTSIDE_WORKSPACE
    for (const badFile of ['../secret.png', '/etc/passwd', 'escape.png', '']) {
      const r = svc.readArtifactRaw(sid, badFile);
      assert.equal(r.ok, false);
      assert.equal(r.statusCode, 403);
      assert.equal(r.error, 'PATH_OUTSIDE_WORKSPACE');
    }

    for (const badSid of ['../outside', 'a/b', '']) {
      const r = svc.readArtifactRaw(badSid, 'diagram.png');
      assert.equal(r.ok, false);
      assert.equal(r.statusCode, 403);
      assert.equal(r.error, 'PATH_OUTSIDE_WORKSPACE');
    }
  } finally {
    cleanupDir(brainDir);
    cleanupDir(outsideDir);
  }
});

test('C10: Git stage/unstage/all, commit, push, and worktree add/list/remove/prune with strict sandbox & flag-injection guards', async () => {
  const allowedBase = makeTempDir('agy-git-c10-');
  const outsideDir = makeTempDir('agy-git-outside-c10-');
  try {
    const repoDir = path.join(allowedBase, 'repo');
    const bareRemoteDir = path.join(allowedBase, 'remote.git');
    const nonGitDir = path.join(allowedBase, 'plain');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(bareRemoteDir, { recursive: true });
    fs.mkdirSync(nonGitDir, { recursive: true });

    execFileSync('git', ['init', '--bare', bareRemoteDir]);
    execFileSync('git', ['init', '-b', 'main', repoDir]);
    execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Test User']);
    execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', repoDir, 'remote', 'add', 'origin', bareRemoteDir]);

    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'line1\n', 'utf8');
    fs.writeFileSync(path.join(repoDir, 'b.txt'), 'init\n', 'utf8');

    const svc = createWorkspaceService({ allowedRoots: [allowedBase] });

    // Non-git dir rejects mutating git operations with 400 NOT_A_GIT_REPO
    const nonGitStage = await svc.gitStage({ root: nonGitDir, paths: ['x.txt'] });
    assert.equal(nonGitStage.ok, false);
    assert.equal(nonGitStage.statusCode, 400);
    assert.equal(nonGitStage.error, 'NOT_A_GIT_REPO');

    // Unborn HEAD: stage single file and unstage before first commit
    const stageA = await svc.gitStage({ root: repoDir, paths: ['a.txt'] });
    assert.equal(stageA.ok, true);
    assert.equal(stageA.staged, true);

    let diff = await svc.getGitDiff({ root: repoDir });
    const fileMap1 = Object.fromEntries(diff.files.map((f) => [f.path, f]));
    assert.equal(fileMap1['a.txt'].staged, true);
    assert.equal(fileMap1['b.txt'].staged, false);
    assert.equal(fileMap1['b.txt'].unstaged, true);

    const unstageUnborn = await svc.gitStage({ root: repoDir, paths: ['a.txt'], unstage: true });
    assert.equal(unstageUnborn.ok, true);
    assert.equal(unstageUnborn.staged, false);

    // Stage all & initial commit
    const stageAllRes = await svc.gitStage({ root: repoDir, all: true });
    assert.equal(stageAllRes.ok, true);
    assert.equal(stageAllRes.all, true);

    const badMsg = await svc.gitCommit({ root: repoDir, message: '   ' });
    assert.equal(badMsg.ok, false);
    assert.equal(badMsg.statusCode, 400);
    assert.equal(badMsg.error, 'INVALID_COMMIT_MESSAGE');

    const commitRes = await svc.gitCommit({ root: repoDir, message: 'feat: initial commit' });
    assert.equal(commitRes.ok, true);
    assert.equal(commitRes.branch, 'main');
    assert.match(commitRes.commitSha, /^[0-9a-f]{40}$/);

    // Push to local bare remote
    const badPushRemote = await svc.gitPush({ root: repoDir, remote: '--mirror' });
    assert.equal(badPushRemote.ok, false);
    assert.equal(badPushRemote.statusCode, 400);
    assert.equal(badPushRemote.error, 'INVALID_GIT_REMOTE');

    const badPushBranch = await svc.gitPush({ root: repoDir, branch: 'main..bad' });
    assert.equal(badPushBranch.ok, false);
    assert.equal(badPushBranch.statusCode, 400);
    assert.equal(badPushBranch.error, 'INVALID_GIT_BRANCH');

    const pushRes = await svc.gitPush({ root: repoDir, branch: 'main', setUpstream: true });
    assert.equal(pushRes.ok, true);
    assert.equal(pushRes.remote, 'origin');
    assert.equal(pushRes.branch, 'main');

    const remoteSha = execFileSync('git', ['--git-dir', bareRemoteDir, 'rev-parse', 'refs/heads/main'], {
      encoding: 'utf8'
    }).trim();
    assert.equal(remoteSha, commitRes.commitSha);

    // Modify after HEAD exists: verify stage + unstage against HEAD + traversal/flag guards
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'line1\nline2\n', 'utf8');
    await svc.gitStage({ root: repoDir, paths: ['a.txt'] });
    diff = await svc.getGitDiff({ root: repoDir });
    assert.equal(diff.files[0].staged, true);

    await svc.gitStage({ root: repoDir, all: true, unstage: true });
    diff = await svc.getGitDiff({ root: repoDir });
    assert.equal(diff.files[0].staged, false);
    assert.equal(diff.files[0].unstaged, true);

    // Traversal & flag injection checks
    const travStage = await svc.gitStage({ root: repoDir, paths: ['../../outside.txt'] });
    assert.equal(travStage.ok, false);
    assert.equal(travStage.statusCode, 403);
    assert.equal(travStage.error, 'PATH_OUTSIDE_WORKSPACE');

    const flagStage = await svc.gitStage({ root: repoDir, paths: ['--force'] });
    assert.equal(flagStage.ok, false);
    assert.equal(flagStage.statusCode, 400);
    assert.equal(flagStage.error, 'INVALID_PATH');

    const flagDiff = await svc.getGitDiff({ root: repoDir, path: '--output=/tmp/x' });
    assert.equal(flagDiff.ok, false);
    assert.equal(flagDiff.statusCode, 400);

    // Worktrees: list, create inside allowedBase, block outside allowedBase & main worktree removal, remove & prune
    const wtTarget = path.join(allowedBase, 'wt-feature');
    const wtAdd = await svc.gitWorktree({
      root: repoDir,
      action: 'create',
      path: '../wt-feature',
      branch: 'feat/wt-test',
      createBranch: true
    });
    assert.equal(wtAdd.ok, true);
    assert.equal(wtAdd.worktrees.length, 2);
    assert.equal(wtAdd.worktrees.some((w) => w.branch === 'feat/wt-test' && w.allowed === true), true);
    assert.equal(wtAdd.worktrees.some((w) => w.branch === 'main' && w.isCurrent === true), true);

    // Block creating worktree outside allowedRoots
    const wtOutside = await svc.gitWorktree({
      root: repoDir,
      action: 'add',
      path: path.join(outsideDir, 'escaped-wt'),
      branch: 'feat/escape',
      createBranch: true
    });
    assert.equal(wtOutside.ok, false);
    assert.equal(wtOutside.statusCode, 403);
    assert.equal(wtOutside.error, 'PATH_OUTSIDE_WORKSPACE');

    // Block removing main worktree
    const rmMain = await svc.gitWorktree({
      root: repoDir,
      action: 'remove',
      path: repoDir
    });
    assert.equal(rmMain.ok, false);
    assert.equal(rmMain.statusCode, 400);
    assert.equal(rmMain.error, 'CANNOT_REMOVE_MAIN_WORKTREE');

    // Remove secondary worktree & prune
    const rmWt = await svc.gitWorktree({
      root: repoDir,
      action: 'remove',
      path: wtTarget
    });
    assert.equal(rmWt.ok, true);
    assert.equal(rmWt.worktrees.length, 1);

    const pruned = await svc.gitWorktree({ root: repoDir, action: 'prune' });
    assert.equal(pruned.ok, true);
    assert.equal(pruned.action, 'prune');
  } finally {
    cleanupDir(allowedBase);
    cleanupDir(outsideDir);
  }
});

test('C11: resolveRealPath prefers fs.realpathSync.native (Windows 8.3 short-path parity) and falls back to fs.realpathSync', async () => {
  const realContainer = makeTempDir('agy-ws-c11-longname-');
  const aliasContainer = makeTempDir('agy-ws-c11-alias-');
  const origRealpathSync = fs.realpathSync;
  const origNative = fs.realpathSync.native;

  try {
    // 1. Direct unit checks: .native preferred; falls back cleanly when .native throws
    const fakeShort = (p) => `SHORT:${p}`;
    fakeShort.native = (p) => `LONG_NATIVE:${p}`;
    fs.realpathSync = fakeShort;
    assert.equal(resolveRealPath('/sample/path'), 'LONG_NATIVE:/sample/path');

    const fakeFallback = (p) => `FALLBACK_JS:${p}`;
    fakeFallback.native = () => {
      const err = new Error('GetFinalPathNameByHandleW failed on RAM disk');
      err.code = 'ENOSYS';
      throw err;
    };
    fs.realpathSync = fakeFallback;
    assert.equal(resolveRealPath('/sample/path'), 'FALLBACK_JS:/sample/path');

    fs.realpathSync = origRealpathSync;
    fs.realpathSync.native = origNative;

    // 2. End-to-end worktree allowed check when JS realpathSync leaves short-name alias unexpanded
    // while realpathSync.native & git worktree list --porcelain expand to canonical long path
    if (process.platform !== 'win32') {
      const shortAliasRoot = path.join(aliasContainer, 'RUNNER~1');
      const actualWsBase = path.join(realContainer, 'runneradmin-workspace');
      fs.mkdirSync(actualWsBase, { recursive: true });
      fs.symlinkSync(actualWsBase, shortAliasRoot, 'dir');

      const repoViaShort = path.join(shortAliasRoot, 'repo');
      fs.mkdirSync(repoViaShort, { recursive: true });
      execFileSync('git', ['init', '-b', 'main'], { cwd: repoViaShort, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoViaShort, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoViaShort, stdio: 'ignore' });
      fs.writeFileSync(path.join(repoViaShort, 'init.txt'), 'ok\n', 'utf8');
      execFileSync('git', ['add', 'init.txt'], { cwd: repoViaShort, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: repoViaShort, stdio: 'ignore' });

      // Simulate Windows Node JS realpathSync NOT expanding RUNNER~1 while .native DOES expand it
      const winSimulatedRealpath = (p) => {
        const s = String(p);
        if (s.includes('RUNNER~1')) return path.resolve(s);
        return origRealpathSync(p);
      };
      winSimulatedRealpath.native = (p) => origNative(p);
      fs.realpathSync = winSimulatedRealpath;

      const svc = createWorkspaceService({ allowedRoots: [shortAliasRoot] });
      const wtAdd = await svc.gitWorktree({
        root: repoViaShort,
        action: 'create',
        path: '../wt-83-check',
        branch: 'feat/win-83',
        createBranch: true
      });
      assert.equal(wtAdd.ok, true);
      const createdWt = wtAdd.worktrees.find((w) => w.branch === 'feat/win-83');
      assert.ok(createdWt);
      assert.equal(createdWt.allowed, true);

      const wtRemove = await svc.gitWorktree({
        root: repoViaShort,
        action: 'remove',
        path: path.join(shortAliasRoot, 'wt-83-check')
      });
      assert.equal(wtRemove.ok, true);
      assert.equal(wtRemove.worktrees.length, 1);
    }
  } finally {
    fs.realpathSync = origRealpathSync;
    fs.realpathSync.native = origNative;
    cleanupDir(aliasContainer);
    cleanupDir(realContainer);
  }
});
