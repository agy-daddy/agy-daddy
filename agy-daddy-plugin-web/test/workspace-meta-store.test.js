'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createWorkspaceMetaStore } = require('../src/workspace-meta-store');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function createInMemoryStorage(initial = null) {
  const files = new Map();
  if (initial !== null) {
    files.set('workspace-meta.json', JSON.stringify(initial));
  }
  return {
    files,
    readJson(name, fallback = null) {
      if (!files.has(name)) return { ok: true, exists: false, data: fallback };
      return { ok: true, exists: true, data: JSON.parse(files.get(name)) };
    },
    writeJson(name, data) {
      files.set(name, JSON.stringify(data));
      return { ok: true };
    }
  };
}

function createTestConversationDb(dbPath, rows = []) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT,
        preview TEXT,
        step_count INTEGER,
        last_modified_time TEXT,
        workspace_uris TEXT,
        status TEXT,
        source TEXT,
        project_id TEXT,
        agent_name TEXT,
        parent_conversation_id TEXT,
        nesting_depth INTEGER,
        not_fully_idle INTEGER,
        killed INTEGER,
        last_user_input_step_index INTEGER
      );
    `);
    const insert = db.prepare(`
      INSERT INTO conversation_summaries (
        conversation_id, title, preview, step_count, last_modified_time, workspace_uris,
        status, source, project_id, agent_name, parent_conversation_id, nesting_depth,
        not_fully_idle, killed, last_user_input_step_index
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of rows) {
      insert.run(
        r.conversation_id,
        r.title ?? null,
        r.preview ?? null,
        r.step_count ?? 0,
        r.last_modified_time ?? null,
        r.workspace_uris ?? null,
        r.status ?? null,
        r.source ?? null,
        r.project_id ?? null,
        r.agent_name ?? null,
        r.parent_conversation_id ?? null,
        r.nesting_depth ?? 0,
        r.not_fully_idle ?? 0,
        r.killed ?? 0,
        r.last_user_input_step_index ?? 0
      );
    }
  } finally {
    db.close();
  }
}

test('静态门禁：workspace-meta-store.js 零外部依赖且不含禁用主题色', () => {
  const srcPath = path.resolve(__dirname, '../src/workspace-meta-store.js');
  const content = fs.readFileSync(srcPath, 'utf8');
  const forbidden = [
    /#10b981/i, /#34d399/i, /#059669/i, /#38bdf8/i,
    /#7dd3fc/i, /#0369a1/i, /#0c4a6e/i, /#fb923c/i, /#c2410c/i
  ];
  for (const re of forbidden) {
    assert.equal(re.test(content), false, `Forbidden hex found: ${re}`);
  }
  const requires = [...content.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  for (const req of requires) {
    assert.ok(
      req.startsWith('node:') || req.startsWith('./') || req.startsWith('../'),
      `Unexpected external dependency: ${req}`
    );
  }
});

test('W1: conversation_summaries.db 只读补全、1.5s TTL 缓存与损坏/缺失库优雅降级', async () => {
  const prevTestMode = process.env.AGY_DADDY_TEST_MODE;
  process.env.AGY_DADDY_TEST_MODE = '1';
  const tmpDir = makeTempDir('agy-meta-db-');
  try {
    const dbPath = path.join(tmpDir, 'conversation_summaries.db');
    createTestConversationDb(dbPath, [
      {
        conversation_id: 'cid-hydrated',
        title: 'DB Title Hydrated',
        preview: 'DB preview summary text',
        step_count: 6,
        last_modified_time: '2026-11-24T01:00:00.000Z',
        status: 'CASCADE_RUN_STATUS_IDLE',
        not_fully_idle: 1,
        last_user_input_step_index: 2
      }
    ]);

    const storage = createInMemoryStorage();
    const store = createWorkspaceMetaStore({
      storage,
      conversationDbPath: dbPath,
      sharedReadStatePath: null,
      conversationDbTtlMs: 80
    });

    const enriched1 = store.enrichSessions([
      {
        cascadeId: 'cid-hydrated',
        title: '',
        hasTitle: false,
        titleSource: 'none',
        summary: '',
        stepCount: 6,
        status: 'CASCADE_RUN_STATUS_IDLE',
        lastModifiedTime: '2026-11-24T01:00:00.000Z'
      }
    ]);
    assert.equal(enriched1.length, 1);
    assert.equal(enriched1[0].title, 'DB Title Hydrated');
    assert.equal(enriched1[0].hasTitle, true);
    assert.equal(enriched1[0].summary, 'DB preview summary text');
    assert.equal(enriched1[0].isRunning, true); // dbRow.not_fully_idle = 1

    // Mutate DB directly: within TTL cache window, old title remains cached
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare('UPDATE conversation_summaries SET title = ?, not_fully_idle = 0 WHERE conversation_id = ?')
        .run('Updated DB Title', 'cid-hydrated');
    } finally {
      db.close();
    }

    const cachedRes = store.enrichSessions([
      {
        cascadeId: 'cid-hydrated',
        title: '',
        hasTitle: false,
        titleSource: 'none',
        stepCount: 6,
        status: 'CASCADE_RUN_STATUS_IDLE'
      }
    ]);
    assert.equal(cachedRes[0].title, 'DB Title Hydrated');

    // After TTL expires, fresh DB values are loaded
    await new Promise((r) => setTimeout(r, 100));
    const freshRes = store.enrichSessions([
      {
        cascadeId: 'cid-hydrated',
        title: '',
        hasTitle: false,
        titleSource: 'none',
        stepCount: 6,
        status: 'CASCADE_RUN_STATUS_IDLE'
      }
    ]);
    assert.equal(freshRes[0].title, 'Updated DB Title');
    assert.equal(freshRes[0].isRunning, false);

    // Missing or corrupt DB degrades gracefully without throwing
    const missingStore = createWorkspaceMetaStore({
      conversationDbPath: path.join(tmpDir, 'does-not-exist.db'),
      sharedReadStatePath: null
    });
    assert.equal(missingStore.enrichSessions([{ cascadeId: 'x', title: 'Ok', stepCount: 1 }]).length, 1);

    const corruptDbPath = path.join(tmpDir, 'corrupt.db');
    fs.writeFileSync(corruptDbPath, 'not a sqlite database', 'utf8');
    const corruptStore = createWorkspaceMetaStore({
      conversationDbPath: corruptDbPath,
      sharedReadStatePath: null
    });
    assert.equal(corruptStore.enrichSessions([{ cascadeId: 'y', title: 'Safe', stepCount: 1 }]).length, 1);
  } finally {
    if (prevTestMode === undefined) delete process.env.AGY_DADDY_TEST_MODE;
    else process.env.AGY_DADDY_TEST_MODE = prevTestMode;
    cleanupDir(tmpDir);
  }
});

test('W2: 子代理/内部会话过滤、includeInternal、0步用户创建保护与项目 sessionCount 口径', () => {
  const prevTestMode = process.env.AGY_DADDY_TEST_MODE;
  process.env.AGY_DADDY_TEST_MODE = '1';
  const tmpDir = makeTempDir('agy-meta-filter-');
  try {
    const projDir = path.join(tmpDir, 'proj-main');
    const hiddenOnlyDir = path.join(tmpDir, 'hidden-only-ws');
    fs.mkdirSync(projDir, { recursive: true });
    fs.mkdirSync(hiddenOnlyDir, { recursive: true });

    const dbPath = path.join(tmpDir, 'conversation_summaries.db');
    createTestConversationDb(dbPath, [
      {
        conversation_id: 'cid-db-subagent',
        title: 'Helper Run',
        step_count: 4,
        parent_conversation_id: 'cid-user-normal',
        nesting_depth: 1,
        agent_name: 'verifier'
      },
      {
        conversation_id: 'cid-db-internal-no-input',
        title: '',
        step_count: 3,
        last_user_input_step_index: -1
      },
      {
        conversation_id: 'cid-user-created-new',
        title: '',
        step_count: 0,
        last_user_input_step_index: -1
      }
    ]);

    const storage = createInMemoryStorage();
    const store = createWorkspaceMetaStore({
      storage,
      defaultBaseDir: path.join(tmpDir, 'default-ws'),
      conversationDbPath: dbPath,
      sharedReadStatePath: null
    });
    const projRes = store.createProject({ name: 'Main', rootPath: projDir });
    assert.equal(projRes.ok, true);

    assert.equal(store.recordUserCreatedSession('cid-user-created-new').ok, true);

    const sessions = [
      {
        cascadeId: 'cid-user-normal',
        title: 'Normal Session',
        hasTitle: true,
        titleSource: 'title',
        stepCount: 4,
        lastModifiedTime: '2026-11-24T02:00:00.000Z',
        workspaceUri: `file://${projDir}`
      },
      {
        cascadeId: 'cid-user-created-new',
        title: '',
        hasTitle: false,
        titleSource: 'none',
        stepCount: 0,
        lastModifiedTime: '2026-11-24T02:05:00.000Z',
        workspaceUri: `file://${projDir}`
      },
      {
        cascadeId: 'cid-db-subagent',
        title: 'Helper Run',
        hasTitle: true,
        titleSource: 'title',
        stepCount: 4,
        lastModifiedTime: '2026-11-24T02:04:00.000Z',
        workspaceUri: `file://${projDir}`
      },
      {
        cascadeId: 'cid-db-internal-no-input',
        title: '',
        hasTitle: false,
        titleSource: 'none',
        stepCount: 3,
        lastModifiedTime: '2026-11-24T02:03:00.000Z',
        workspaceUri: `file://${hiddenOnlyDir}`
      },
      {
        cascadeId: 'cid-rpc-swarm',
        title: '',
        hasTitle: false,
        titleSource: 'none',
        stepCount: 2,
        source: 'CORTEX_TRAJECTORY_SOURCE_SWARM',
        lastModifiedTime: '2026-11-24T02:02:00.000Z',
        workspaceUri: `file://${projDir}`
      }
    ];

    const defaultEnriched = store.enrichSessions(sessions);
    assert.deepEqual(
      defaultEnriched.map((s) => s.cascadeId),
      ['cid-user-created-new', 'cid-user-normal']
    );

    const withMeta = store.enrichSessionsWithMeta(sessions, { includeInternal: false });
    assert.equal(withMeta.hiddenInternalCount, 3);
    assert.equal(withMeta.sessions.length, 2);

    const allWithMeta = store.enrichSessionsWithMeta(sessions, { includeInternal: true });
    assert.equal(allWithMeta.hiddenInternalCount, 3);
    assert.equal(allWithMeta.sessions.length, 5);
    const subagentEntry = allWithMeta.sessions.find((s) => s.cascadeId === 'cid-db-subagent');
    assert.equal(subagentEntry.isSubagent, true);
    assert.equal(subagentEntry.isInternalSession, true);

    // listProjectsAndGroups counts only visible non-internal sessions and ignores hidden-only implicit projects
    const listed = store.listProjectsAndGroups(sessions);
    const mainProj = listed.projects.find((p) => p.id === projRes.project.id);
    assert.equal(mainProj.sessionCount, 2);
    assert.equal(listed.projects.some((p) => p.rootPath === hiddenOnlyDir), false);
  } finally {
    if (prevTestMode === undefined) delete process.env.AGY_DADDY_TEST_MODE;
    else process.env.AGY_DADDY_TEST_MODE = prevTestMode;
    cleanupDir(tmpDir);
  }
});

test('W3: 未读检测（完成跳变 / recordSessionCompletion / markSessionRead / 多端单调同步）', () => {
  const prevTestMode = process.env.AGY_DADDY_TEST_MODE;
  process.env.AGY_DADDY_TEST_MODE = '1';
  const tmpDir = makeTempDir('agy-meta-unread-');
  try {
    const sharedPath = path.join(tmpDir, 'session-read-state.json');
    const initAt = '2026-11-24T03:00:00.000Z';
    const storage = createInMemoryStorage({
      version: 1,
      readStateInitializedAt: initAt
    });

    const store = createWorkspaceMetaStore({
      storage,
      conversationDbPath: null,
      sharedReadStatePath: sharedPath
    });

    // 1. Old session prior to readStateInitializedAt is NOT unread; 0-step & running & internal are NOT unread
    const initialBatch = store.enrichSessions([
      {
        cascadeId: 'cid-old',
        title: 'Old Session',
        hasTitle: true,
        stepCount: 5,
        status: 'CASCADE_RUN_STATUS_IDLE',
        lastModifiedTime: '2026-11-24T02:00:00.000Z'
      },
      {
        cascadeId: 'cid-zero',
        title: 'Zero Step',
        hasTitle: true,
        stepCount: 0,
        status: 'CASCADE_RUN_STATUS_IDLE',
        lastModifiedTime: '2026-11-24T03:05:00.000Z'
      },
      {
        cascadeId: 'cid-live',
        title: 'Live Session',
        hasTitle: true,
        stepCount: 2,
        status: 'CASCADE_RUN_STATUS_RUNNING',
        lastModifiedTime: '2026-11-24T03:05:00.000Z'
      }
    ]);
    assert.equal(initialBatch.find((s) => s.cascadeId === 'cid-old').unread, false);
    assert.equal(initialBatch.find((s) => s.cascadeId === 'cid-zero').unread, false);
    assert.equal(initialBatch.find((s) => s.cascadeId === 'cid-live').unread, false);

    // 2. Running -> Idle transition records lastCompletedAt and marks unread = true
    const afterTransition = store.enrichSessions([
      {
        cascadeId: 'cid-live',
        title: 'Live Session',
        hasTitle: true,
        stepCount: 4,
        status: 'CASCADE_RUN_STATUS_IDLE',
        lastCompletedTime: '2026-11-24T03:06:00.000Z',
        lastModifiedTime: '2026-11-24T03:06:00.000Z'
      }
    ]);
    assert.equal(afterTransition[0].unread, true);
    assert.equal(afterTransition[0].lastCompletedAt, '2026-11-24T03:06:00.000Z');

    // 3. markSessionRead clears unread and writes sharedReadStatePath atomically
    const markRes = store.markSessionRead('cid-live', {
      lastReadAt: '2026-11-24T03:06:00.000Z',
      lastReadStepCount: 4
    });
    assert.equal(markRes.ok, true);
    assert.equal(fs.existsSync(sharedPath), true);
    const tmpLeftovers = fs.readdirSync(tmpDir).filter((f) => f.includes('.tmp-'));
    assert.equal(tmpLeftovers.length, 0);

    const afterRead = store.enrichSessions([
      {
        cascadeId: 'cid-live',
        title: 'Live Session',
        hasTitle: true,
        stepCount: 4,
        status: 'CASCADE_RUN_STATUS_IDLE',
        lastCompletedTime: '2026-11-24T03:06:00.000Z',
        lastModifiedTime: '2026-11-24T03:06:00.000Z'
      }
    ]);
    assert.equal(afterRead[0].unread, false);

    // 4. Higher stepCount or recordSessionCompletion flips unread back to true
    const afterNewStep = store.enrichSessions([
      {
        cascadeId: 'cid-live',
        title: 'Live Session',
        hasTitle: true,
        stepCount: 5,
        status: 'CASCADE_RUN_STATUS_IDLE',
        lastModifiedTime: '2026-11-24T03:06:00.000Z'
      }
    ]);
    assert.equal(afterNewStep[0].unread, true);

    store.markSessionRead('cid-live', {
      lastReadAt: '2026-11-24T03:07:00.000Z',
      lastReadStepCount: 5
    });
    assert.equal(
      store.recordSessionCompletion('cid-live', {
        completedAt: '2026-11-24T03:08:00.000Z',
        stepCount: 5
      }).ok,
      true
    );
    const afterCompletionCall = store.enrichSessions([
      {
        cascadeId: 'cid-live',
        title: 'Live Session',
        hasTitle: true,
        stepCount: 5,
        status: 'CASCADE_RUN_STATUS_IDLE',
        lastModifiedTime: '2026-11-24T03:07:00.000Z'
      }
    ]);
    assert.equal(afterCompletionCall[0].unread, true);

    // 5. Multi-client monotonic merge (older external update never regresses; newer wins)
    const mergeRes = store.mergeExternalReadState({
      'cid-live': {
        lastReadAt: '2026-11-24T03:01:00.000Z', // older than 03:07:00
        lastReadStepCount: 8 // larger than 5 -> monotonic max!
      },
      'cid-other': {
        lastReadAt: '2026-11-24T03:09:00.000Z',
        lastReadStepCount: 3
      }
    });
    assert.equal(mergeRes.ok, true);
    assert.equal(mergeRes.sessions['cid-live'].lastReadAt, '2026-11-24T03:07:00.000Z');
    assert.equal(mergeRes.sessions['cid-live'].lastReadStepCount, 8);
    assert.equal(mergeRes.sessions['cid-other'].lastReadStepCount, 3);

    // External client writing directly to sharedReadStatePath is picked up by getReadStateSnapshot / enrichSessions
    fs.writeFileSync(sharedPath, JSON.stringify({
      version: 1,
      sessions: {
        'cid-live': {
          lastReadAt: '2026-11-24T03:10:00.000Z',
          lastReadStepCount: 6 // smaller than 8 -> must stay 8!
        }
      }
    }), 'utf8');

    const snapshot = store.getReadStateSnapshot();
    assert.equal(snapshot.sessions['cid-live'].lastReadAt, '2026-11-24T03:10:00.000Z');
    assert.equal(snapshot.sessions['cid-live'].lastReadStepCount, 8);

    const afterExternalRead = store.enrichSessions([
      {
        cascadeId: 'cid-live',
        title: 'Live Session',
        hasTitle: true,
        stepCount: 8,
        status: 'CASCADE_RUN_STATUS_IDLE',
        lastModifiedTime: '2026-11-24T03:08:00.000Z'
      }
    ]);
    assert.equal(afterExternalRead[0].unread, false);
  } finally {
    if (prevTestMode === undefined) delete process.env.AGY_DADDY_TEST_MODE;
    else process.env.AGY_DADDY_TEST_MODE = prevTestMode;
    cleanupDir(tmpDir);
  }
});

function createTestVscdb(dbPath, fileUris = []) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value BLOB);');
    // Construct protobuf-like buffer containing length-delimited file:// URIs separated by control bytes
    const chunks = [];
    for (const uri of fileUris) {
      chunks.push(Buffer.from([0x0a, 0x01, 0x0a, Math.min(127, Buffer.byteLength(uri, 'utf8'))]));
      chunks.push(Buffer.from(uri, 'utf8'));
      chunks.push(Buffer.from([0x12, 0x02, 0x08, 0x01]));
    }
    const b64 = Buffer.concat(chunks).toString('base64');
    db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(
      'antigravityUnifiedStateSync.sidebarWorkspaces',
      b64
    );
  } finally {
    db.close();
  }
}

test('W4: App 项目全量同步 (state.vscdb + conversation_summaries.db)、CJK 路径解码、临时目录过滤、TTL 缓存与隐式/App 项目升级', async () => {
  const prevTestMode = process.env.AGY_DADDY_TEST_MODE;
  process.env.AGY_DADDY_TEST_MODE = '1';
  const tmpDir = makeTempDir('agy-meta-appsync-');
  try {
    const vscdbPath = path.join(tmpDir, 'state.vscdb');
    const convDbPath = path.join(tmpDir, 'conversation_summaries.db');

    createTestVscdb(vscdbPath, [
      'file:///Volumes/mock/alpha-repo',
      'file:///Volumes/mock/%E4%B8%AD%E6%96%87%E9%A1%B9%E7%9B%AE',
      'file:///etc/secret',
      'file:///tmp/magpie-agy-bridge-abc123',
      'file:///var/folders/3n/8vkwhj/T/magpie-agy-bridge-xyz'
    ]);

    createTestConversationDb(convDbPath, [
      {
        conversation_id: 'c1',
        title: 'Conv 1',
        step_count: 4,
        last_modified_time: '2026-11-24T01:00:00.000Z',
        workspace_uris: JSON.stringify([
          'file:///Volumes/mock/alpha-repo',
          'file:///private/var/folders/3n/8vkwhj/T/magpie-agy-bridge-999'
        ]),
        project_id: 'uuid-alpha'
      },
      {
        conversation_id: 'c2',
        title: 'Conv 2',
        step_count: 2,
        last_modified_time: '2026-11-24T02:30:00.000Z',
        workspace_uris: JSON.stringify(['file:///Volumes/mock/beta-db-only']),
        project_id: 'uuid-beta'
      },
      {
        conversation_id: 'c3-temp-only',
        title: 'Temp Only',
        step_count: 1,
        last_modified_time: '2026-11-24T03:00:00.000Z',
        workspace_uris: JSON.stringify(['file:///private/var/folders/3n/8vkwhj/T/route-score-123']),
        project_id: ''
      }
    ]);

    const storage = createInMemoryStorage();
    const store = createWorkspaceMetaStore({
      storage,
      defaultBaseDir: '/Volumes/mock/default-ws',
      stateVscdbPath: vscdbPath,
      conversationDbPath: convDbPath,
      sharedReadStatePath: null,
      appSyncTtlMs: 80
    });

    // Test-mode isolation check when paths are omitted
    const isolatedStore = createWorkspaceMetaStore({
      storage: createInMemoryStorage(),
      sharedReadStatePath: null
    });
    assert.deepEqual(isolatedStore.loadAppSyncedProjects(), []);

    const synced = store.loadAppSyncedProjects();
    const syncedRoots = synced.map((p) => p.rootPath);
    assert.ok(syncedRoots.includes('/Volumes/mock/alpha-repo'));
    assert.ok(syncedRoots.includes('/Volumes/mock/中文项目'));
    assert.ok(syncedRoots.includes('/Volumes/mock/beta-db-only'));
    assert.equal(syncedRoots.some((r) => r.includes('magpie-agy-bridge') || r.includes('route-score') || r.startsWith('/etc')), false);

    // Allowed roots includes App-synced roots
    const rootPaths = store.getProjectRootPaths();
    assert.ok(rootPaths.includes('/Volumes/mock/alpha-repo'));
    assert.ok(rootPaths.includes('/Volumes/mock/中文项目'));
    assert.ok(rootPaths.includes('/Volumes/mock/beta-db-only'));

    // Group creation + listProjectsAndGroups merging registered + App-synced + session-discovered implicit
    const grp = store.createGroup({ name: 'Synced Group' }).group;
    const listed = store.listProjectsAndGroups([
      {
        cascadeId: 'rpc-s1',
        title: 'RPC Alpha',
        stepCount: 3,
        lastModifiedTime: '2026-11-24T04:00:00.000Z',
        workspaceUri: 'file:///Volumes/mock/alpha-repo'
      },
      {
        cascadeId: 'rpc-s2',
        title: 'RPC Implicit',
        stepCount: 2,
        lastModifiedTime: '2026-11-24T04:10:00.000Z',
        workspaceUri: 'file:///Volumes/mock/gamma-implicit'
      }
    ]);

    const alphaProj = listed.projects.find((p) => p.rootPath === '/Volumes/mock/alpha-repo');
    const cjkProj = listed.projects.find((p) => p.rootPath === '/Volumes/mock/中文项目');
    const gammaProj = listed.projects.find((p) => p.rootPath === '/Volumes/mock/gamma-implicit');
    assert.ok(alphaProj && alphaProj.id.startsWith('app:'));
    assert.equal(alphaProj.syncedFromApp, true);
    assert.equal(alphaProj.source, 'app');
    assert.equal(alphaProj.implicit, false);
    assert.ok(cjkProj && cjkProj.name === '中文项目');
    assert.ok(gammaProj && gammaProj.id.startsWith('implicit:'));
    assert.equal(gammaProj.implicit, true);

    // getProjectById resolves app:..., implicit:..., and workspaceUri fallback
    assert.equal(store.getProjectById(alphaProj.id).rootPath, '/Volumes/mock/alpha-repo');
    assert.equal(store.getProjectById(gammaProj.id).rootPath, '/Volumes/mock/gamma-implicit');
    assert.equal(
      store.getProjectById('implicit:custom123', { workspaceUri: 'file:///Volumes/mock/delta-new' }).rootPath,
      '/Volumes/mock/delta-new'
    );
    assert.equal(store.getProjectById('proj_missing'), null);

    // assignSessionProject works on app:... and implicit:... without 404
    const assignApp = store.assignSessionProject('new-s-app', alphaProj.id);
    assert.equal(assignApp.ok, true);
    assert.equal(assignApp.projectId, alphaProj.id);

    const assignImp = store.assignSessionProject('new-s-imp', gammaProj.id);
    assert.equal(assignImp.ok, true);
    assert.equal(assignImp.projectId, gammaProj.id);

    // updateProject promotes an App-synced project into state.projects preserving id/rootPath
    const updRes = store.updateProject(cjkProj.id, { groupId: grp.id, name: '中文工作区' });
    assert.equal(updRes.ok, true);
    assert.equal(updRes.project.id, cjkProj.id);
    assert.equal(updRes.project.rootPath, '/Volumes/mock/中文项目');
    assert.equal(updRes.project.groupId, grp.id);
    assert.equal(updRes.project.name, '中文工作区');

    const reloaded = createWorkspaceMetaStore({ storage, sharedReadStatePath: null });
    const reloadedCjk = reloaded.getProjectById(cjkProj.id);
    assert.ok(reloadedCjk);
    assert.equal(reloadedCjk.groupId, grp.id);
    assert.equal(reloadedCjk.name, '中文工作区');

    // TTL cache check: update vscdb and verify cache serves old until TTL expires
    createTestVscdb(vscdbPath, ['file:///Volumes/mock/fresh-after-ttl']);
    assert.equal(store.loadAppSyncedProjects().some((p) => p.rootPath === '/Volumes/mock/fresh-after-ttl'), false);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(store.loadAppSyncedProjects().some((p) => p.rootPath === '/Volumes/mock/fresh-after-ttl'), true);
  } finally {
    if (prevTestMode === undefined) delete process.env.AGY_DADDY_TEST_MODE;
    else process.env.AGY_DADDY_TEST_MODE = prevTestMode;
    cleanupDir(tmpDir);
  }
});
