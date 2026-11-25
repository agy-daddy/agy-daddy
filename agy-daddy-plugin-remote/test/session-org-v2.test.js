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
