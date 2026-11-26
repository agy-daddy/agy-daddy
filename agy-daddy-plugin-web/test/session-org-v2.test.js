'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createSessionOrgBridge } = require('../src/session-org-bridge');
const { createWorkspaceMetaStore } = require('../src/workspace-meta-store');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createMemoryStorage(initial = null) {
  let stored = initial ? JSON.parse(JSON.stringify(initial)) : null;
  return {
    readJson(_name, fallback = null) {
      if (!stored) return { ok: true, exists: false, data: fallback };
      return { ok: true, exists: true, data: JSON.parse(JSON.stringify(stored)) };
    },
    writeJson(_name, data) {
      stored = JSON.parse(JSON.stringify(data));
      return { ok: true };
    },
    getRaw() {
      return stored;
    }
  };
}

test('S3-1: workspace-meta.json v1 zero-loss migration to session-org.json v2 with .v1.bak.json and alias remap', () => {
  const tmpDir = makeTempDir('agy-org-mig-');
  try {
    const orgPath = path.join(tmpDir, 'session-org.json');
    const projADir = path.join(tmpDir, 'proj-alpha');
    const projBDir = path.join(tmpDir, 'proj-beta');
    fs.mkdirSync(projADir, { recursive: true });
    fs.mkdirSync(projBDir, { recursive: true });

    // Seed existing v1 session-org.json with ws:* pin and group mapping
    const wsHash = require('node:crypto').createHash('sha1').update(projADir).digest('hex').slice(0, 12);
    const wsId = `ws:proj-alpha:${wsHash}`;
    fs.writeFileSync(orgPath, JSON.stringify({
      version: 1,
      groups: [{ id: 'grp_shared', name: 'Shared Group', source: 'user', order: 0, projectIds: [wsId], workspaceUris: [], sessionIds: [] }],
      pins: { sessions: ['cid-remote-pin'], projects: [wsId], groups: ['grp_shared'] },
      projectGroupMap: { [wsId]: 'grp_shared' },
      sessionGroupMap: {},
      updatedAt: '2026-11-24T00:00:00.000Z'
    }, null, 2));

    const storage = createMemoryStorage({
      version: 1,
      defaultSessionPath: path.join(tmpDir, 'default-ws'),
      readStateInitializedAt: '2026-11-24T00:00:00.000Z',
      pinnedSessions: { 'cid-web-pin': { pinnedAt: '2026-11-24T01:00:00.000Z' } },
      sessionProjectOverrides: { 'cid-1': 'proj_legacy_a', 'cid-2': null },
      groups: [{ id: 'grp_web', name: 'Web Group', sortOrder: 1, collapsed: true }],
      projects: [
        { id: 'proj_legacy_a', name: 'Alpha Custom', rootPath: projADir, groupId: null },
        { id: 'proj_legacy_b', name: 'Beta Custom', rootPath: projBDir, groupId: 'grp_web' }
      ],
      sessionReadState: { 'cid-1': { lastReadAt: '2026-11-24T02:00:00.000Z', lastReadStepCount: 5 } }
    });

    const bridge = createSessionOrgBridge({ orgPath });
    const metaStore = createWorkspaceMetaStore({ storage, sessionOrgBridge: bridge });

    // Backup .v1.bak.json created once
    const bakPath = path.join(tmpDir, 'session-org.v1.bak.json');
    assert.equal(fs.existsSync(bakPath), true);
    assert.equal(JSON.parse(fs.readFileSync(bakPath, 'utf8')).version, 1);

    const org = bridge.getOrg();
    assert.equal(org.version, 2);
    assert.ok(org.groups.some((g) => g.id === 'grp_shared' && g.pinned === true));
    assert.ok(org.groups.some((g) => g.id === 'grp_web' && g.collapsed === true));

    // ws:* pin & group mapping remapped to proj_legacy_a
    const projA = org.projects.find((p) => p.id === 'proj_legacy_a');
    assert.ok(projA);
    assert.equal(projA.name, 'Alpha Custom');
    assert.ok(projA.aliases.includes(wsId));
    assert.equal(org.pins.projects.includes('proj_legacy_a'), true);
    assert.equal(org.pins.projects.includes(wsId), false);
    assert.equal(org.projectGroupMap.proj_legacy_a, 'grp_shared');

    // Union of pinned sessions
    assert.ok(org.pins.sessions.includes('cid-remote-pin'));
    assert.ok(org.pins.sessions.includes('cid-web-pin'));
    assert.equal(org.pinTimestamps.sessions['cid-web-pin'], '2026-11-24T01:00:00.000Z');
    assert.equal(org.sessionProjectOverrides['cid-1'], 'proj_legacy_a');
    assert.equal(org.sessionProjectOverrides['cid-2'], null);

    // Telemetry persisted to workspace-meta.json without duplicating org arrays
    metaStore.markSessionRead('cid-3', { lastReadStepCount: 2 });
    const rawMeta = storage.getRaw();
    assert.equal(rawMeta.projects, undefined);
    assert.equal(rawMeta.groups, undefined);
    assert.ok(rawMeta.sessionReadState['cid-3']);

    // Idempotent re-migration
    const second = bridge.migrateWorkspaceMetaV1({
      projects: [{ id: 'proj_new_ignored', name: 'Should Not Duplicate', rootPath: projBDir }]
    });
    assert.equal(second.migrated, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('S3-1: concurrent multi-process lockfile RMW preserves all writes and recovers stale lock', async () => {
  const tmpDir = makeTempDir('agy-org-lock-');
  try {
    const orgPath = path.join(tmpDir, 'session-org.json');
    const lockPath = `${orgPath}.lock`;

    // Stale lock (>2s old) is broken cleanly
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, ts: Date.now() - 10_000 }));
    const bridge = createSessionOrgBridge({ orgPath });
    const g1 = bridge.mutateGroup({ action: 'upsert', id: 'grp_init', name: 'Init' });
    assert.equal(g1.ok, true);
    assert.equal(fs.existsSync(lockPath), false);

    // Spawn 2 parallel child processes mutating the same session-org.json simultaneously
    const bridgePath = path.resolve(__dirname, '..', 'src', 'session-org-bridge.js');
    const workerCode = `
      const { createSessionOrgBridge } = require(${JSON.stringify(bridgePath)});
      const b = createSessionOrgBridge({ orgPath: ${JSON.stringify(orgPath)} });
      const prefix = process.argv[1];
      for (let i = 0; i < 8; i++) {
        b.togglePin({ type: 'session', id: prefix + '-' + i, pinned: true });
      }
    `;
    const cp = require('node:child_process');
    const p1 = cp.spawn(process.execPath, ['-e', workerCode, 'w1'], { stdio: 'ignore' });
    const p2 = cp.spawn(process.execPath, ['-e', workerCode, 'w2'], { stdio: 'ignore' });
    await Promise.all([
      new Promise((resolve, reject) => p1.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`p1 exit ${code}`))))),
      new Promise((resolve, reject) => p2.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`p2 exit ${code}`)))))
    ]);
    const finalOrg = bridge.loadPersistedOrg();
    for (let i = 0; i < 8; i++) {
      assert.ok(finalOrg.pins.sessions.includes(`w1-${i}`), `missing w1-${i}`);
      assert.ok(finalOrg.pins.sessions.includes(`w2-${i}`), `missing w2-${i}`);
    }
    assert.equal(finalOrg.revision >= 17, true);
    bridge.dispose();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('S3-1: auto-unarchive detector, archive unpins atomically, and fs.watch external sync', async () => {
  const tmpDir = makeTempDir('agy-org-arch-');
  try {
    const orgPath = path.join(tmpDir, 'session-org.json');
    const externalEvents = [];
    const bridgeA = createSessionOrgBridge({
      orgPath,
      watchDisk: true,
      onExternalOrgChanged: (org, summary) => externalEvents.push({ revision: org.revision, summary })
    });
    const bridgeB = createSessionOrgBridge({ orgPath, pluginId: 'agy-daddy.remote' });
    const metaStore = createWorkspaceMetaStore({
      storage: createMemoryStorage(),
      sessionOrgBridge: bridgeA,
      conversationDbPath: null,
      sharedReadStatePath: null
    });

    // Pin then archive -> atomic unpin
    assert.equal(bridgeA.togglePin({ type: 'session', id: 'cid-idle', pinned: true }).ok, true);
    const archIdle = bridgeA.archiveSession('cid-idle', { archived: true, stepCount: 10, isRunning: false, titleSnapshot: 'Idle' });
    assert.equal(archIdle.ok, true);
    assert.equal(archIdle.unpinned, true);
    assert.equal(bridgeA.getOrg().pins.sessions.includes('cid-idle'), false);

    // Pinning an archived session fails with 409 SESSION_ARCHIVED
    const pinArchived = bridgeA.togglePin({ type: 'session', id: 'cid-idle', pinned: true });
    assert.equal(pinArchived.ok, false);
    assert.equal(pinArchived.statusCode, 409);
    assert.equal(pinArchived.error, 'SESSION_ARCHIVED');

    // Archive a currently RUNNING session -> transitioning to IDLE clears archivedWasRunning WITHOUT unarchiving
    bridgeA.archiveSession('cid-running', { archived: true, stepCount: 5, isRunning: true });
    let enriched = metaStore.enrichSessions([
      { cascadeId: 'cid-idle', status: 'CASCADE_RUN_STATUS_IDLE', stepCount: 10 },
      { cascadeId: 'cid-running', status: 'CASCADE_RUN_STATUS_IDLE', stepCount: 6 }
    ]);
    assert.equal(enriched.length, 0);
    assert.equal(bridgeA.loadPersistedOrg().archivedSessions['cid-running'].archivedWasRunning, false);

    // Transitioning cid-idle to RUNNING auto-unarchives WITHOUT re-pinning!
    enriched = metaStore.enrichSessions([
      { cascadeId: 'cid-idle', status: 'CASCADE_RUN_STATUS_RUNNING', stepCount: 11 },
      { cascadeId: 'cid-running', status: 'CASCADE_RUN_STATUS_IDLE', stepCount: 6 }
    ]);
    assert.deepEqual(enriched.map((s) => s.cascadeId), ['cid-idle']);
    assert.equal(enriched[0].pinned, false);
    assert.equal(enriched[0].archived, false);

    // needsAttention auto-unarchives cid-running
    enriched = metaStore.enrichSessions([
      { cascadeId: 'cid-running', status: 'CASCADE_RUN_STATUS_IDLE', needsAttention: true, stepCount: 6 }
    ]);
    assert.deepEqual(enriched.map((s) => s.cascadeId), ['cid-running']);

    // fs.watch detects external write from bridgeB
    bridgeB.togglePin({ type: 'group', id: 'grp_ext', pinned: true });
    const deadline = Date.now() + 2000;
    while (externalEvents.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.ok(externalEvents.length >= 1);
    assert.ok(bridgeA.getOrg().pins.groups.includes('grp_ext'));

    bridgeA.dispose();
    bridgeB.dispose();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
