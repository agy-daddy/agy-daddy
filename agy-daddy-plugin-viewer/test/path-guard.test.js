'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { ERROR_CODES } = require('../src/constants');
const {
  resolveRealPath,
  validatePathAccess
} = require('../src/path-guard');
const { createWorkspaceRootsResolver } = require('../src/workspace-roots');

async function withTempSandbox(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-viewer-pg-'));
  try {
    return await fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('path-guard: allows regular files inside allowedRealRoots including file:// and CJK/spaces', async () => {
  await withTempSandbox((tmp) => {
    const ws = path.join(tmp, 'workspace');
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(path.join(ws, '中文 目录'), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    const fileA = path.join(ws, '中文 目录', 'hello world.csv');
    fs.writeFileSync(fileA, 'a,b\n1,2\n', 'utf8');
    const realWs = resolveRealPath(ws);

    const res1 = validatePathAccess(fileA, { allowedRealRoots: [realWs] });
    assert.equal(res1.ok, true);
    assert.equal(res1.realPath, resolveRealPath(fileA));

    const res2 = validatePathAccess(pathToFileURL(fileA).href, { allowedRealRoots: [realWs] });
    assert.equal(res2.ok, true);
    assert.equal(res2.realPath, resolveRealPath(fileA));

    const resDir = validatePathAccess(ws, { allowedRealRoots: [realWs], requireRegularFile: true });
    assert.equal(resDir.ok, false);
    assert.equal(resDir.errorCode, ERROR_CODES.NOT_A_REGULAR_FILE);
  });
});

test('path-guard: blocks UNC paths, remote file:// hosts, null bytes, and invalid paths before fs syscalls', () => {
  const roots = [os.tmpdir()];
  for (const bad of [
    '\\\\evil-server\\share\\video.mp4',
    '\\\\?\\UNC\\evil-server\\share\\video.mp4',
    '//evil-server/share/video.mp4',
    'file://evil-server/share/video.mp4',
    '%5c%5cevil-server%5cshare%5cvideo.mp4'
  ]) {
    const res = validatePathAccess(bad, { allowedRealRoots: roots });
    assert.equal(res.ok, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.errorCode, ERROR_CODES.UNC_PATH_BLOCKED, `Expected UNC block for ${bad}`);
  }

  for (const invalid of ['', '   ', 'a\0b', '/tmp/a%00b.csv', 'relative/path.csv', null, 123]) {
    const res = validatePathAccess(invalid, { allowedRealRoots: roots });
    assert.equal(res.ok, false);
    assert.equal(res.statusCode, 400);
    assert.equal(res.errorCode, ERROR_CODES.INVALID_PATH);
  }
});

test('path-guard: blocks directory traversal, sensitive system/credential paths, and symlink escapes', async () => {
  await withTempSandbox((tmp) => {
    const ws = path.join(tmp, 'workspace');
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(path.join(ws, '.ssh'), { recursive: true });
    fs.mkdirSync(path.join(ws, '.aws'), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });

    const secretFile = path.join(outside, 'secret.txt');
    fs.writeFileSync(secretFile, 'secret', 'utf8');
    fs.writeFileSync(path.join(ws, '.ssh', 'id_rsa'), 'key', 'utf8');
    fs.writeFileSync(path.join(ws, '.aws', 'credentials'), 'cred', 'utf8');

    const linkOut = path.join(ws, 'escape-link.txt');
    const linkDangling = path.join(ws, 'dangling-link.txt');
    fs.symlinkSync(secretFile, linkOut);
    fs.symlinkSync(path.join(outside, 'nonexistent.txt'), linkDangling);

    const realWs = resolveRealPath(ws);

    // Traversal outside root
    const trav = validatePathAccess(path.join(ws, '..', 'outside', 'secret.txt'), { allowedRealRoots: [realWs] });
    assert.equal(trav.ok, false);
    assert.equal(trav.errorCode, ERROR_CODES.PATH_OUT_OF_BOUNDS);

    // Sensitive paths
    const systemSensitivePath = process.platform === 'win32'
      ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
      : '/etc/passwd';
    for (const p of [systemSensitivePath, path.join(ws, '.ssh', 'id_rsa'), path.join(ws, '.aws', 'credentials')]) {
      const s = validatePathAccess(p, { allowedRealRoots: [realWs, '/'] });
      assert.equal(s.ok, false);
      assert.equal(s.errorCode, ERROR_CODES.SENSITIVE_PATH_BLOCKED);
    }

    // Symlink escape & dangling symlink
    const esc = validatePathAccess(linkOut, { allowedRealRoots: [realWs] });
    assert.equal(esc.ok, false);
    assert.equal(esc.errorCode, ERROR_CODES.SYMLINK_ESCAPE);

    const dang = validatePathAccess(linkDangling, { allowedRealRoots: [realWs] });
    assert.equal(dang.ok, false);
    assert.equal(dang.errorCode, ERROR_CODES.SYMLINK_ESCAPE);

    // Deleted file (mustExist: false) inside vs outside root
    const deletedInside = validatePathAccess(path.join(ws, 'deleted-file.js'), {
      allowedRealRoots: [realWs],
      mustExist: false,
      requireRegularFile: false
    });
    assert.equal(deletedInside.ok, true);
    assert.equal(deletedInside.exists, false);

    const deletedOutside = validatePathAccess(path.join(outside, 'deleted-file.js'), {
      allowedRealRoots: [realWs],
      mustExist: false,
      requireRegularFile: false
    });
    assert.equal(deletedOutside.ok, false);
    assert.equal(deletedOutside.errorCode, ERROR_CODES.PATH_OUT_OF_BOUNDS);
  });
});

test('workspace-roots: resolves explicit allowedRoots or caches GetAllCascadeTrajectories for 10s', async () => {
  await withTempSandbox(async (tmp) => {
    const ws1 = path.join(tmp, 'ws1');
    const ws2 = path.join(tmp, 'ws2');
    fs.mkdirSync(ws1);
    fs.mkdirSync(ws2);

    let rpcCalls = 0;
    const mockHost = {
      rpc: {
        async call(method) {
          assert.equal(method, 'GetAllCascadeTrajectories');
          rpcCalls++;
          return {
            trajectorySummaries: {
              c1: {
                status: 'RUNNING',
                lastModifiedTime: '2026-11-27T01:00:00Z',
                workspaces: [{ workspaceFolderAbsoluteUri: pathToFileURL(ws1).href }]
              }
            }
          };
        }
      }
    };

    const resolver = createWorkspaceRootsResolver({ rpcCacheTtlMs: 10_000 });
    const r1 = await resolver.resolveAllowedRoots({ settings: { allowedRoots: [] }, host: mockHost });
    const r2 = await resolver.resolveAllowedRoots({ settings: { allowedRoots: [] }, host: mockHost });
    assert.deepEqual(r1, [resolveRealPath(ws1)]);
    assert.deepEqual(r2, [resolveRealPath(ws1)]);
    assert.equal(rpcCalls, 1);

    const explicit = await resolver.resolveAllowedRoots({ settings: { allowedRoots: [ws2] }, host: mockHost });
    assert.deepEqual(explicit, [resolveRealPath(ws2)]);
  });
});
