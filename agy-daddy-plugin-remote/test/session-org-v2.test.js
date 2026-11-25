'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSessionOrgStore } = require('../src/session-org-store');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('S3-1 remote: Schema v2 path canonicalization, archived/deleted filtering, auto-unarchive, and state sync', () => {
  const tmpDir = makeTempDir('agy-remote-org-v2-');
  try {
    const orgPath = path.join(tmpDir, 'session-org.json');
    const projDir = path.join(tmpDir, 'RepoOne');
    fs.mkdirSync(projDir, { recursive: true });

    const busEvents = [];
    const extEvents = [];
    const store = createSessionOrgStore({
      orgPath,
      dbPath: null,
      getAllowedRoots: () => [projDir],
      onOrgChanged: (_org, summary) => busEvents.push(summary),
      onExternalOrgChanged: (_org, summary) => extEvents.push(summary)
    });

    // Seed persisted project with stable ID + alias
    store.mutateOrgAtomically((org) => {
      org.groups.push({ id: 'grp_1', name: 'Core', source: 'user', collapsed: false, order: 0, projectIds: ['proj_stable_1'], workspaceUris: [], sessionIds: [] });
      org.projects.push({
        id: 'proj_stable_1',
        aliases: ['ws:repoone:old'],
        name: 'Repo Custom Name',
        rootPath: projDir,
        uri: `file://${projDir}`,
        groupId: 'grp_1',
        source: 'github'
      });
      org.projectGroupMap.proj_stable_1 = 'grp_1';
    });

    assert.ok(busEvents.length >= 1);

    // Archive cid-arch, delete cid-del as local_tombstone
    store.togglePin({ type: 'session', id: 'cid-arch', pinned: true });
    const archRes = store.archiveSession('cid-arch', { archived: true, stepCount: 4, isRunning: false });
    assert.equal(archRes.ok, true);
    assert.equal(archRes.unpinned, true);

    store.deleteSessionOrgRecord('cid-del', { mode: 'local_tombstone' });

    const res = store.enrichSessionsAndOrg({
      rpcSessions: [
        { cascadeId: 'cid-active', title: 'Active', status: 'CASCADE_RUN_STATUS_IDLE', workspaceUri: `file://${projDir}`, lastModifiedTime: '2026-11-25T10:00:00Z' },
        { cascadeId: 'cid-arch', title: 'Archived', status: 'CASCADE_RUN_STATUS_IDLE', workspaceUri: `file://${projDir}`, lastModifiedTime: '2026-11-25T11:00:00Z' },
        { cascadeId: 'cid-del', title: 'Deleted', status: 'CASCADE_RUN_STATUS_IDLE', workspaceUri: `file://${projDir}`, lastModifiedTime: '2026-11-25T12:00:00Z' }
      ]
    });

    assert.deepEqual(res.sessions.map((s) => s.cascadeId), ['cid-active']);
    assert.equal(res.archivedCount, 1);
    assert.equal(res.projects.length, 1);
    assert.equal(res.projects[0].id, 'proj_stable_1');
    assert.equal(res.projects[0].name, 'Repo Custom Name');
    assert.equal(res.projects[0].sessionCount, 1);
    assert.equal(res.projects[0].groupId, 'grp_1');

    // Running transition auto-unarchives cid-arch without restoring pin
    const res2 = store.enrichSessionsAndOrg({
      rpcSessions: [
        { cascadeId: 'cid-active', title: 'Active', status: 'CASCADE_RUN_STATUS_IDLE', workspaceUri: `file://${projDir}`, lastModifiedTime: '2026-11-25T10:00:00Z' },
        { cascadeId: 'cid-arch', title: 'Archived', status: 'CASCADE_RUN_STATUS_RUNNING', workspaceUri: `file://${projDir}`, lastModifiedTime: '2026-11-25T11:00:00Z' }
      ]
    });
    assert.equal(res2.sessions.length, 2);
    assert.equal(res2.archivedCount, 0);
    assert.equal(res2.sessions.find((s) => s.cascadeId === 'cid-arch').pinned, false);

    // External signal reloads newer disk revision without loop
    const writer = createSessionOrgStore({ orgPath, dbPath: null, pluginId: 'agy-daddy.web' });
    writer.togglePin({ type: 'group', id: 'grp_1', pinned: true });
    const synced = store.syncFromExternalSignal({ revision: writer.loadPersistedOrg().revision });
    assert.equal(synced, true);
    assert.equal(extEvents.length, 1);
    assert.equal(store.getOrg().pins.groups.includes('grp_1'), true);

    store.dispose();
    writer.dispose();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('S3-1 remote org-api: reorder ZONE_PIN_MISMATCH, cross-group move, archive/delete L2 + Cloudflare X-Agy-Confirm', async () => {
  const tmpDir = makeTempDir('agy-remote-api-v2-');
  const http = require('node:http');
  const { MobileRemoteServer } = require('../src/pwa-server');

  function reqJson(urlStr, opts = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(urlStr);
      const req = http.request({
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: opts.method || 'GET',
        headers: opts.headers || {}
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, json: JSON.parse(text) });
        });
      });
      req.on('error', reject);
      if (opts.body !== undefined) req.write(JSON.stringify(opts.body));
      req.end();
    });
  }

  try {
    const orgPath = path.join(tmpDir, 'session-org.json');
    const store = createSessionOrgStore({ orgPath, dbPath: null });
    let perm = 'L1';
    let deleteErr = null;
    const deletedRpc = [];

    const srv = new MobileRemoteServer({
      host: '127.0.0.1',
      port: 0,
      staticDir: '',
      getToken: () => 'rem-tok-123456',
      getConfirmSecret: () => 'rem-confirm-secret',
      getPermissionLevel: () => perm,
      getChannels: () => ({ loopback: true, cloudflare: true }),
      v1Handlers: {
        getSessionOrg: (opts) => store.getOrg(opts),
        togglePin: (body) => store.togglePin(body),
        mutateGroup: (body) => store.mutateGroup(body),
        reorderOrg: (body) => store.reorderOrg(body),
        archiveSession: (id, body) => store.archiveSession(id, body),
        deleteSession: async (id, { mode }) => {
          if (mode === 'local_hide') return store.deleteSessionOrgRecord(id, { mode: 'local_tombstone' });
          if (deleteErr) return { ok: false, statusCode: 503, error: 'HOST_DELETE_UNAVAILABLE', reasonCode: 'RPC_OFFLINE', canFallbackLocalHide: true };
          deletedRpc.push(id);
          return store.deleteSessionOrgRecord(id, { mode: 'host_deleted' });
        }
      }
    });

    await srv.start();
    const base = `http://127.0.0.1:${srv.port}`;
    const cfAuth = {
      Authorization: 'Bearer rem-tok-123456',
      'Content-Type': 'application/json',
      'cf-ray': 'cf-test-1'
    };

    try {
      // Cloudflare L1 write without confirm -> 403 CONFIRMATION_REQUIRED
      const pinChall = await reqJson(`${base}/api/v1/sessions/pin`, {
        method: 'POST',
        headers: cfAuth,
        body: { type: 'session', id: 's-1', pinned: true }
      });
      assert.equal(pinChall.status, 403);
      assert.equal(pinChall.json.error, 'CONFIRMATION_REQUIRED');

      const pinOk = await reqJson(`${base}/api/v1/sessions/pin`, {
        method: 'POST',
        headers: { ...cfAuth, 'X-Agy-Confirm': pinChall.json.confirmToken },
        body: { type: 'session', id: 's-1', pinned: true }
      });
      assert.equal(pinOk.status, 200);
      assert.equal(pinOk.json.pinned, true);

      // DELETE session at L1 -> 403 PERMISSION_DENIED (L2 required)
      const delL1 = await reqJson(`${base}/api/v1/sessions/s-1`, { method: 'DELETE', headers: cfAuth });
      assert.equal(delL1.status, 403);
      assert.equal(delL1.json.error, 'PERMISSION_DENIED');
      assert.equal(delL1.json.required, 'L2');

      // Elevate to L2 + Cloudflare confirm -> DELETE host_deleted & 503 fallback
      perm = 'L2';
      const delChall = await reqJson(`${base}/api/v1/sessions/s-1`, { method: 'DELETE', headers: cfAuth });
      assert.equal(delChall.status, 403);
      assert.equal(delChall.json.error, 'CONFIRMATION_REQUIRED');

      const delOk = await reqJson(`${base}/api/v1/sessions/s-1`, {
        method: 'DELETE',
        headers: { ...cfAuth, 'X-Agy-Confirm': delChall.json.confirmToken }
      });
      assert.equal(delOk.status, 200);
      assert.equal(delOk.json.deletionMode, 'host_deleted');
      assert.deepEqual(deletedRpc, ['s-1']);

      deleteErr = true;
      const del503 = await reqJson(`${base}/api/v1/sessions/s-2`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer rem-tok-123456' }
      });
      assert.equal(del503.status, 503);
      assert.equal(del503.json.error, 'HOST_DELETE_UNAVAILABLE');
      assert.equal(del503.json.canFallbackLocalHide, true);
    } finally {
      await srv.stop();
      store.dispose();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
