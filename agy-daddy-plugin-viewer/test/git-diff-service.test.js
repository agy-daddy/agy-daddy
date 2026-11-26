'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { ERROR_CODES } = require('../src/constants');
const { resolveRealPath } = require('../src/path-guard');
const {
  buildSanitizedGitEnv,
  execSafeGit,
  toSafeGitRelPath,
  createGitDiffService
} = require('../src/git-diff-service');

function gitInitAndConfig(dir) {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'ignore' });
}

test('git-diff-service: rejects non-readonly git subcommands and sanitizes env/leading-dash filenames', async () => {
  await assert.rejects(
    () => execSafeGit(os.tmpdir(), 'commit', ['-m', 'bad']),
    (err) => err.code === ERROR_CODES.GIT_WRITE_FORBIDDEN
  );

  const env = buildSanitizedGitEnv({
    PATH: process.env.PATH,
    GIT_DIR: '/evil/.git',
    GIT_SSH_COMMAND: 'evil-cmd'
  });
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(env.GIT_SSH_COMMAND, undefined);
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');

  assert.equal(toSafeGitRelPath('/repo', '/repo/-evil.txt'), './-evil.txt');
  assert.equal(toSafeGitRelPath('/repo', '/outside/a.txt'), null);
});

test('git-diff-service: returns NOT_A_GIT_REPO and blocks outer git repo escape outside allowedRealRoots', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-viewer-git-bounds-'));
  try {
    const nonGit = path.join(tmp, 'plain');
    fs.mkdirSync(nonGit);
    const plainFile = path.join(nonGit, 'a.txt');
    fs.writeFileSync(plainFile, 'hello', 'utf8');

    const svcPlain = createGitDiffService({
      resolveAllowedRoots: async () => [resolveRealPath(nonGit)]
    });
    const nonGitRes = await svcPlain.getFileDiff({ filePath: plainFile });
    assert.equal(nonGitRes.ok, true);
    assert.equal(nonGitRes.state, 'NOT_A_GIT_REPO');
    assert.equal(nonGitRes.isGitRepo, false);

    // Nested directory authorized, but .git lives in parent directory outside allowedRealRoots
    const outerRepo = path.join(tmp, 'outer-repo');
    const nestedWs = path.join(outerRepo, 'subws');
    fs.mkdirSync(nestedWs, { recursive: true });
    gitInitAndConfig(outerRepo);
    const nestedFile = path.join(nestedWs, 'index.js');
    fs.writeFileSync(nestedFile, 'console.log(1);\n', 'utf8');

    const svcNested = createGitDiffService({
      resolveAllowedRoots: async () => [resolveRealPath(nestedWs)]
    });
    const escapeRes = await svcNested.getFileDiff({ filePath: nestedFile });
    assert.equal(escapeRes.ok, false);
    assert.equal(escapeRes.statusCode, 403);
    assert.equal(escapeRes.errorCode, ERROR_CODES.PATH_OUT_OF_BOUNDS);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('git-diff-service: handles modifications with wordSpans, special filenames, binary, truncation, and context expand', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-viewer-git-'));
  try {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    gitInitAndConfig(repo);

    const codeFile = path.join(repo, 'app.js');
    const specialFile = path.join(repo, '中文 空格 (demo).txt');
    const dashFile = path.join(repo, '-leading-dash.txt');
    const deletedFile = path.join(repo, 'old.txt');
    const binFile = path.join(repo, 'logo.png');

    const initialLines = [];
    for (let i = 1; i <= 20; i++) initialLines.push(`const line${i} = ${i};`);
    fs.writeFileSync(codeFile, initialLines.join('\n') + '\n', 'utf8');
    fs.writeFileSync(specialFile, 'alpha beta\n', 'utf8');
    fs.writeFileSync(dashFile, 'before\n', 'utf8');
    fs.writeFileSync(deletedFile, 'bye\n', 'utf8');
    fs.writeFileSync(binFile, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0x01, 0x02]));

    execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' });

    const realRepo = resolveRealPath(repo);
    const svc = createGitDiffService({
      resolveAllowedRoots: async () => [realRepo]
    });

    // Clean repo -> NO_CHANGES
    const cleanRes = await svc.getWorkspaceChanges({ rootHint: repo });
    assert.equal(cleanRes.ok, true);
    assert.equal(cleanRes.state, 'NO_CHANGES');
    assert.equal(cleanRes.totalChangedFiles, 0);

    // Apply edits
    const updatedLines = [...initialLines];
    updatedLines[14] = 'const line15 = 999;';
    fs.writeFileSync(codeFile, updatedLines.join('\n') + '\n', 'utf8');
    fs.writeFileSync(specialFile, 'alpha gamma\n', 'utf8');
    fs.writeFileSync(dashFile, 'after\n', 'utf8');
    fs.unlinkSync(deletedFile);
    fs.writeFileSync(binFile, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0x09, 0x08, 0x07]));
    const untrackedFile = path.join(repo, 'new_file.txt');
    fs.writeFileSync(untrackedFile, 'hello\nworld\n', 'utf8');

    const wsRes = await svc.getWorkspaceChanges({ rootHint: repo });
    assert.equal(wsRes.ok, true);
    assert.equal(wsRes.state, 'OK');
    assert.equal(wsRes.totalChangedFiles, 6);

    // Inline diff + wordSpans
    const diffRes = await svc.getFileDiff({ filePath: codeFile, wordHighlight: true });
    assert.equal(diffRes.ok, true);
    assert.equal(diffRes.state, 'OK');
    assert.equal(diffRes.stats.additions, 1);
    assert.equal(diffRes.stats.deletions, 1);
    const delLine = diffRes.hunks[0].lines.find((l) => l.type === 'del');
    const addLine = diffRes.hunks[0].lines.find((l) => l.type === 'add');
    assert.ok(Array.isArray(delLine.wordSpans) && delLine.wordSpans.length > 0);
    assert.ok(Array.isArray(addLine.wordSpans) && addLine.wordSpans.length > 0);

    // Context expansion before hunk
    assert.equal(diffRes.hunks[0].canExpandBefore, true);
    const ctxRes = await svc.getContextLines({
      filePath: codeFile,
      startLine: 1,
      endLine: 5
    });
    assert.equal(ctxRes.ok, true);
    assert.equal(ctxRes.lines.length, 5);
    assert.equal(ctxRes.lines[0].content, 'const line1 = 1;');

    // Special filename & leading dash filename
    const spRes = await svc.getFileDiff({ filePath: specialFile });
    assert.equal(spRes.ok, true);
    assert.equal(spRes.state, 'OK');
    assert.equal(spRes.relPath, '中文 空格 (demo).txt');

    const dashRes = await svc.getFileDiff({ filePath: dashFile });
    assert.equal(dashRes.ok, true);
    assert.equal(dashRes.state, 'OK');

    // Deleted file
    const delRes = await svc.getFileDiff({ filePath: deletedFile });
    assert.equal(delRes.ok, true);
    assert.equal(delRes.state, 'OK');
    assert.equal(delRes.status, 'D');

    // Binary file
    const binRes = await svc.getFileDiff({ filePath: binFile });
    assert.equal(binRes.ok, true);
    assert.equal(binRes.state, 'BINARY_FILE');
    assert.equal(binRes.binary, true);

    // Untracked file
    const unRes = await svc.getFileDiff({ filePath: untrackedFile });
    assert.equal(unRes.ok, true);
    assert.equal(unRes.state, 'OK');
    assert.equal(unRes.status, '?');
    assert.equal(unRes.stats.additions, 2);

    // Truncation circuit breaker (diffMaxLines = 2)
    const bigUntracked = path.join(repo, 'many_lines.txt');
    fs.writeFileSync(bigUntracked, '1\n2\n3\n4\n5\n', 'utf8');
    const truncRes = await svc.getFileDiff({
      filePath: bigUntracked,
      settings: { diffMaxLines: 2 }
    });
    assert.equal(truncRes.ok, true);
    assert.equal(truncRes.state, 'DIFF_TRUNCATED');
    assert.equal(truncRes.truncated, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
