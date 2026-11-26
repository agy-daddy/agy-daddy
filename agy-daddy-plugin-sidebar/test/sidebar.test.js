'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const url = require('node:url');

const PLUGIN_DIR = path.resolve(__dirname, '..');
const MONOREPO_ROOT = path.resolve(PLUGIN_DIR, '..');
const HOST_ROOT = path.join(MONOREPO_ROOT, 'agy-daddy-host');
const CHAT_NAV_DIR = path.join(MONOREPO_ROOT, 'agy-daddy-plugin-chat-nav');

const { createMockHostHarness, createMockDocument, createMockElement } = require(path.join(HOST_ROOT, 'sdk', 'mock-harness'));

function realPath(p) {
  return (fs.realpathSync.native || fs.realpathSync)(p);
}

function seedSidebarDocument(sessions = []) {
  const doc = createMockDocument([]);
  const aside = createMockElement('aside', doc);
  aside.setAttribute('data-testid', 'sidebar-panel');
  aside.className = 'bg-sidebar';

  const nativeList = createMockElement('div', doc);
  nativeList.setAttribute('data-testid', 'native-list');
  for (const s of sessions) {
    const row = createMockElement('div', doc);
    row.setAttribute('data-testid', 'conversation-row-sidebar');
    row.setAttribute('data-cascade-id', s.cascadeId);
    row.textContent = s.title || s.summary || s.cascadeId;
    nativeList.appendChild(row);
  }
  aside.appendChild(nativeList);
  doc.body.appendChild(aside);
  return { doc, aside, nativeList };
}

async function waitFor(predicate, timeoutMs = 2500, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = predicate();
    if (val) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

function initGitRepoWithWorktree(baseDir) {
  const mainRepo = path.join(baseDir, 'repo-main');
  const linkedWt = path.join(baseDir, 'repo-main-feat-alpha');
  fs.mkdirSync(mainRepo, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: mainRepo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: mainRepo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: mainRepo, stdio: 'ignore' });
  fs.writeFileSync(path.join(mainRepo, 'README.md'), '# test\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: mainRepo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: mainRepo, stdio: 'ignore' });
  execFileSync('git', ['worktree', 'add', '-b', 'feat/alpha', linkedWt], { cwd: mainRepo, stdio: 'ignore' });
  return {
    mainRepo: realPath(mainRepo),
    linkedWt: realPath(linkedWt)
  };
}

test('manifest & package: strict world=isolated, minimal permissions, zero dependencies', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'agy-plugin.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8'));

  assert.equal(manifest.id, 'agy-daddy.sidebar');
  assert.equal(manifest.world, 'isolated');
  assert.deepEqual(manifest.requires?.anchors, ['sidebar.root']);
  for (const forbidden of ['page:main-world', 'host:control', 'net:listen', 'host:launch-args', 'native:install']) {
    assert.equal(manifest.permissions.includes(forbidden), false, `Forbidden permission present: ${forbidden}`);
  }
  assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
  assert.equal(pkg.files.some((f) => f.startsWith('test')), false);
});

test('mount & view toggle: Shadow DOM isolated mount, Enhanced <-> Native non-destructive toggle & clean dispose', async () => {
  const { doc, aside } = seedSidebarDocument([
    { cascadeId: '11111111-1111-1111-1111-111111111111', title: 'First Chat' }
  ]);
  const harness = createMockHostHarness({
    document: doc,
    onRpc: (method) => {
      if (method === 'GetAllCascadeTrajectories') {
        return {
          trajectorySummaries: {
            '11111111-1111-1111-1111-111111111111': {
              summary: 'First Chat',
              status: 'CASCADE_RUN_STATUS_IDLE',
              lastModifiedTime: '2026-11-26T10:00:00Z'
            }
          }
        };
      }
      return { ok: true };
    }
  });
  const prevOrgPath = process.env.AGY_DADDY_SESSION_ORG_PATH;
  process.env.AGY_DADDY_SESSION_ORG_PATH = path.join(harness.tempRoot, 'session-org.json');

  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });
    await harness.loadAndRunPlugin(PLUGIN_DIR);

    const enhancedRoot = await waitFor(() => aside.querySelector('#agy-sidebar-enhanced-root'));
    assert.ok(enhancedRoot, 'Shadow host root must be mounted on sidebar.root');
    assert.ok(enhancedRoot.shadowRoot, 'Shadow root must be attached');
    await waitFor(() => aside.getAttribute('data-agy-sidebar-mode') === 'enhanced');
    assert.equal(aside.getAttribute('data-agy-sidebar-mode'), 'enhanced');
    assert.equal(enhancedRoot.hidden, false);

    // Native rows remain untouched in Light DOM
    const nativeRows = doc.querySelectorAll('[data-testid="conversation-row-sidebar"]');
    assert.equal(nativeRows.length, 1);

    // Topbar unit registered inside host shadow DOM
    const hostShadow = doc.getElementById('agy-daddy-host')?.shadowRoot;
    const toggleUnitEl = await waitFor(() => hostShadow?.querySelector('[data-unit-id="sidebar-toggle"]'));
    assert.ok(toggleUnitEl, 'Topbar unit sidebar-toggle must be registered');

    // Toggle to Native view via command
    const toggleRes = await harness.executeCommand('sidebar.toggle-view');
    assert.equal(toggleRes.viewMode, 'native');
    await waitFor(() => aside.getAttribute('data-agy-sidebar-mode') === null);
    assert.equal(enhancedRoot.hidden, true);
    assert.equal(harness.getPluginSettings('agy-daddy.sidebar').viewMode, 'native');

    // Toggle back to Enhanced via UI button inside shadowRoot
    const enhBtn = enhancedRoot.shadowRoot.querySelector('button[data-mode="enhanced"]');
    assert.ok(enhBtn);
    enhBtn.click();
    await waitFor(() => aside.getAttribute('data-agy-sidebar-mode') === 'enhanced');
    assert.equal(enhancedRoot.hidden, false);

    await harness.unloadPlugin('agy-daddy.sidebar');
    harness.assertCleanDispose('agy-daddy.sidebar');
  } finally {
    if (prevOrgPath === undefined) delete process.env.AGY_DADDY_SESSION_ORG_PATH;
    else process.env.AGY_DADDY_SESSION_ORG_PATH = prevOrgPath;
    await harness.cleanup();
  }
});

test('groups, non-empty delete confirm, collapse persistence, 600ms hover expand & cross-worktree drop block', async () => {
  const tempRepos = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sb-wt-'));
  const prevOrgPath = process.env.AGY_DADDY_SESSION_ORG_PATH;
  let harness = null;

  try {
    const { mainRepo, linkedWt } = initGitRepoWithWorktree(tempRepos);
    const singleRepo = path.join(tempRepos, 'plain-proj');
    fs.mkdirSync(singleRepo, { recursive: true });
    const singleRepoReal = realPath(singleRepo);

    const sessionsObj = {
      'ses-main-1': {
        summary: 'Main Task 1',
        status: 'CASCADE_RUN_STATUS_IDLE',
        lastModifiedTime: '2026-11-26T12:00:00Z',
        workspaces: [{ workspaceFolderAbsoluteUri: url.pathToFileURL(mainRepo).href }]
      },
      'ses-main-2': {
        summary: 'Main Task 2',
        status: 'CASCADE_RUN_STATUS_IDLE',
        lastModifiedTime: '2026-11-26T11:00:00Z',
        workspaces: [{ workspaceFolderAbsoluteUri: url.pathToFileURL(mainRepo).href }]
      },
      'ses-wt-1': {
        summary: 'Feat Alpha Task',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        lastModifiedTime: '2026-11-26T13:00:00Z',
        workspaces: [{ workspaceFolderAbsoluteUri: url.pathToFileURL(linkedWt).href }]
      },
      'ses-single-1': {
        summary: 'Single Repo Task',
        status: 'CASCADE_RUN_STATUS_IDLE',
        lastModifiedTime: '2026-11-26T09:00:00Z',
        workspaces: [{ workspaceFolderAbsoluteUri: url.pathToFileURL(singleRepoReal).href }]
      }
    };

    const { doc, aside } = seedSidebarDocument([
      { cascadeId: 'ses-main-1', title: 'Main Task 1' },
      { cascadeId: 'ses-wt-1', title: 'Feat Alpha Task' }
    ]);

    let startCascadeCalls = [];
    harness = createMockHostHarness({
      document: doc,
      onRpc: (method, body) => {
        if (method === 'GetAllCascadeTrajectories') {
          return { trajectorySummaries: sessionsObj };
        }
        if (method === 'StartCascade') {
          startCascadeCalls.push(body);
          return { cascadeId: `ses-created-${startCascadeCalls.length}` };
        }
        return { ok: true };
      }
    });
    process.env.AGY_DADDY_SESSION_ORG_PATH = path.join(harness.tempRoot, 'session-org.json');
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });

    await harness.loadAndRunPlugin(PLUGIN_DIR);
    const enhancedRoot = await waitFor(() => aside.querySelector('#agy-sidebar-enhanced-root'));
    const sr = enhancedRoot.shadowRoot;

    // Wait for bootstrap to render projects
    const multiProjWrap = await waitFor(() => sr.querySelector('[data-multi-worktree="true"]'));
    assert.ok(multiProjWrap, 'Multi-worktree repo must render aggregated project node');
    const singleProjWrap = sr.querySelector('[data-multi-worktree="false"]');
    assert.ok(singleProjWrap, 'Single directory project must render flat without worktree subgroup');
    assert.equal(singleProjWrap.querySelectorAll('[data-node-type="worktree"]').length, 0);

    const wtRows = multiProjWrap.querySelectorAll('[data-node-type="worktree"]');
    assert.equal(wtRows.length, 2, 'Multi-worktree repo must render 2 worktree subgroups');

    // Click '+' on linked worktree -> StartCascade receives exact workspaceUris
    const linkedWtRow = Array.from(wtRows).find((r) => String(r.textContent).includes('feat/alpha'));
    assert.ok(linkedWtRow);
    const newWtSessionBtn = linkedWtRow.querySelector('button[data-action="new-worktree-session"]');
    assert.ok(newWtSessionBtn);
    newWtSessionBtn.click();
    await waitFor(() => startCascadeCalls.length === 1);
    assert.deepEqual(startCascadeCalls[0].workspaceUris, [url.pathToFileURL(linkedWt).href]);

    // Create group G1 & G2, move multiProj into G1, collapse G1
    const g1Res = await harness.bridge.invokeHostRoute('/host/commands/run', {
      commandId: 'sidebar.create-group',
      args: ['Core Group']
    }).catch(() => null);
    // Use bridge directly via sidebar-node service or plugin token
    const token = harness.bridge.getPluginToken('agy-daddy.sidebar');
    const callBridge = async (subPath, payload) => {
      const resp = await fetch(`http://127.0.0.1:${harness.bridge.port}/plugins/agy-daddy.sidebar${subPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AGY-Plugin-Token': token },
        body: JSON.stringify(payload)
      });
      return resp.json();
    };

    assert.ok(g1Res);
    const boot1 = await callBridge('/bootstrap', { refreshWorktrees: true });
    const g1 = boot1.groups.find((g) => g.name === 'Core Group');
    assert.ok(g1);
    const g2Create = await callBridge('/org/group', { action: 'upsert', name: 'Empty Group' });
    assert.equal(g2Create.ok, true);
    const g2 = g2Create.group;

    const multiProjId = boot1.projects.find((p) => p.isMultiWorktree).id;
    const assignRes = await callBridge('/org/group', { action: 'assign', projectId: multiProjId, groupId: g1.id });
    assert.equal(assignRes.ok, true);

    // Persist collapsed state for G1 across plugin reload
    const colRes = await callBridge('/org/collapse', { nodeType: 'group', id: g1.id, collapsed: true });
    assert.equal(colRes.ok, true);

    await harness.unloadPlugin('agy-daddy.sidebar');
    await harness.loadAndRunPlugin(PLUGIN_DIR);

    const enhancedRoot2 = await waitFor(() => aside.querySelector('#agy-sidebar-enhanced-root'));
    const sr2 = enhancedRoot2.shadowRoot;
    const g1Row = await waitFor(() => sr2.querySelector(`[data-node-type="group"][data-group-id="${g1.id}"]`));
    assert.ok(g1Row);
    // Group G1 is collapsed so its project child is hidden until expanded
    const g1Wrap = sr2.querySelector(`.agy-sb-group-wrap[data-group-id="${g1.id}"]`);
    assert.equal(g1Wrap.querySelectorAll('[data-node-type="project"]').length, 0);

    // 600ms hover on collapsed group during project drag auto-expands G1
    const singleProjEl = sr2.querySelector(`[data-node-type="project"][data-project-id="${boot1.projects.find((p) => !p.isMultiWorktree).id}"]`);
    assert.ok(singleProjEl);
    singleProjEl.dispatchEvent({ type: 'dragstart' });
    g1Row.dispatchEvent({ type: 'dragover', preventDefault() {} });
    await new Promise((r) => setTimeout(r, 700));
    assert.ok(
      sr2.querySelector(`.agy-sb-group-wrap[data-group-id="${g1.id}"] [data-node-type="project"]`),
      'Collapsed group must auto-expand after 600ms drag hover'
    );
    singleProjEl.dispatchEvent({ type: 'dragend' });

    // Re-open group G1 menu and click Delete -> must trigger non-empty confirmation dialog
    const token2 = harness.bridge.getPluginToken('agy-daddy.sidebar');
    const callBridge2 = async (subPath, payload) => {
      const resp = await fetch(`http://127.0.0.1:${harness.bridge.port}/plugins/agy-daddy.sidebar${subPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AGY-Plugin-Token': token2 },
        body: JSON.stringify(payload)
      });
      return resp.json();
    };

    const g1MenuBtn = sr2.querySelector(`[data-node-type="group"][data-group-id="${g1.id}"] button[data-action="group-menu"]`);
    g1MenuBtn.click();
    const g1WrapAfterMenu = sr2.querySelector(`.agy-sb-group-wrap[data-group-id="${g1.id}"]`);
    const delBtn = Array.from(g1WrapAfterMenu.querySelectorAll('button.agy-sb-menu-item')).find((b) => b.textContent === '删除');
    assert.ok(delBtn);
    delBtn.click();

    const confirmDlg = await waitFor(() => sr2.querySelector('[data-dialog="delete-group"]'));
    assert.ok(confirmDlg, 'Deleting non-empty group must show confirmation dialog');
    assert.match(confirmDlg.textContent, /1 个项目将自动移回/);
    confirmDlg.querySelector('button[data-action="confirm-delete-group"]').click();

    await waitFor(() => !sr2.querySelector(`[data-node-type="group"][data-group-id="${g1.id}"]`));
    const bootAfterDel = await callBridge2('/bootstrap', {});
    const movedBackProj = bootAfterDel.projects.find((p) => p.id === multiProjId);
    assert.equal(movedBackProj.groupId, null, 'Project must fall back to ungrouped after non-empty group delete');

    // Empty group deletes directly without confirmation dialog
    const g2MenuBtn = sr2.querySelector(`[data-node-type="group"][data-group-id="${g2.id}"] button[data-action="group-menu"]`);
    g2MenuBtn.click();
    const g2Wrap = sr2.querySelector(`.agy-sb-group-wrap[data-group-id="${g2.id}"]`);
    const g2DelBtn = Array.from(g2Wrap.querySelectorAll('button.agy-sb-menu-item')).find((b) => b.textContent === '删除');
    g2DelBtn.click();
    await waitFor(() => !sr2.querySelector(`[data-node-type="group"][data-group-id="${g2.id}"]`));
    assert.equal(sr2.querySelector('[data-dialog="delete-group"]'), null);

    // Cross-worktree session drag-drop must be blocked with 409
    const bootMulti = await callBridge2('/bootstrap', {});
    const multiP = bootMulti.projects.find((p) => p.isMultiWorktree);
    const mainWtDto = multiP.worktrees.find((w) => w.isMain);
    const featWtDto = multiP.worktrees.find((w) => !w.isMain);

    const crossReorder = await callBridge2('/org/reorder', {
      targetType: 'session',
      containerId: featWtDto.worktreeId,
      zone: 'normal',
      orderedIds: ['ses-main-1', 'ses-wt-1']
    });
    assert.equal(crossReorder.ok, false);
    assert.equal(crossReorder.error, 'CROSS_CONTAINER_SESSION_MOVE_FORBIDDEN');

    // Client-side DOM drag-and-drop across worktrees triggers error toast
    const sesMainRow = sr2.querySelector('[data-node-type="session"][data-session-id="ses-main-1"]');
    const sesWtRow = sr2.querySelector('[data-node-type="session"][data-session-id="ses-wt-1"]');
    assert.ok(sesMainRow && sesWtRow);
    sesMainRow.dispatchEvent({ type: 'dragstart' });
    sesWtRow.dispatchEvent({ type: 'drop', preventDefault() {} });
    const toastEl = await waitFor(() => sr2.querySelector('[data-banner="toast"]'));
    assert.ok(toastEl, 'Cross-worktree session drop must show error toast');

    // Cross-workspace honest guidance bar when native window points to mainRepo and user clicks linked worktree session
    const bootWithWindow = await callBridge2('/bootstrap', { hostWindowWorkspace: mainRepo });
    assert.equal(bootWithWindow.hostWindowWorkspace, mainRepo);
    const prevWtSessionRow = sr2.querySelector('[data-node-type="session"][data-session-id="ses-wt-1"]');
    sr2.querySelector('button[data-action="refresh-worktrees"]').click();
    const freshWtSessionRow = await waitFor(() => {
      const cur = sr2.querySelector('[data-node-type="session"][data-session-id="ses-wt-1"]');
      return cur && cur !== prevWtSessionRow ? cur : null;
    });
    freshWtSessionRow.click();
    const guidanceEl = await waitFor(() => sr2.querySelector('[data-banner="cross-workspace"]'));
    assert.ok(guidanceEl, 'Cross-workspace guidance bar must appear honestly');
    assert.match(guidanceEl.textContent, new RegExp(linkedWt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    // /workspace/open-window simulated cleanly in test mode, blocks forbidden root
    const openOk = await callBridge2('/workspace/open-window', { path: linkedWt });
    assert.equal(openOk.ok, true);
    assert.equal(openOk.opened, true);
    const openForbidden = await callBridge2('/workspace/open-window', { path: '/etc' });
    assert.equal(openForbidden.ok, false);
    assert.equal(openForbidden.error, 'FORBIDDEN_SYSTEM_ROOT');
  } finally {
    if (prevOrgPath === undefined) delete process.env.AGY_DADDY_SESSION_ORG_PATH;
    else process.env.AGY_DADDY_SESSION_ORG_PATH = prevOrgPath;
    if (harness) await harness.cleanup();
    fs.rmSync(tempRepos, { recursive: true, force: true });
  }
});

test('coexistence: chat-nav ⌘1~⌘9 shortcuts & Meta badges coexist with sidebar enhanced view', async () => {
  const { doc, aside } = seedSidebarDocument([
    { cascadeId: 'ses-a', title: 'Chat Alpha' },
    { cascadeId: 'ses-b', title: 'Chat Beta' }
  ]);
  const harness = createMockHostHarness({
    document: doc,
    onRpc: (method) => {
      if (method === 'GetAllCascadeTrajectories') {
        return {
          trajectorySummaries: {
            'ses-a': { summary: 'Chat Alpha', status: 'CASCADE_RUN_STATUS_IDLE', lastModifiedTime: '2026-11-26T12:00:00Z' },
            'ses-b': { summary: 'Chat Beta', status: 'CASCADE_RUN_STATUS_IDLE', lastModifiedTime: '2026-11-26T11:00:00Z' }
          }
        };
      }
      return { ok: true };
    }
  });
  const prevOrgPath = process.env.AGY_DADDY_SESSION_ORG_PATH;
  process.env.AGY_DADDY_SESSION_ORG_PATH = path.join(harness.tempRoot, 'session-org.json');

  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });
    await harness.loadAndRunPlugin(CHAT_NAV_DIR);
    await harness.loadAndRunPlugin(PLUGIN_DIR);

    const enhancedRoot = await waitFor(() => aside.querySelector('#agy-sidebar-enhanced-root'));
    const sr = enhancedRoot.shadowRoot;
    await waitFor(() => sr.querySelectorAll('[data-node-type="session"]').length >= 2);

    // Hold Meta -> sidebar shows 1..N shortcut badges inside Shadow DOM
    doc.dispatchEvent({ type: 'keydown', key: 'Meta', metaKey: true, shiftKey: false, ctrlKey: false, altKey: false });
    const badges = await waitFor(() => {
      const list = sr.querySelectorAll('.agy-sidebar-shortcut-badge');
      return list.length >= 2 ? list : null;
    });
    assert.equal(badges[0].textContent, '1');
    assert.equal(badges[1].textContent, '2');

    // Press Cmd+2 -> chat-nav switches native 2nd conversation row cleanly without sidebar blocking it
    doc.dispatchEvent({
      type: 'keydown',
      key: '2',
      code: 'Digit2',
      metaKey: true,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      preventDefault() {},
      stopPropagation() {},
      stopImmediatePropagation() {}
    });
    const rows = doc.querySelectorAll('[data-testid="conversation-row-sidebar"]');
    assert.equal(rows[1].getAttribute('aria-selected'), 'true');

    // Release Meta -> badges hide
    doc.dispatchEvent({ type: 'keyup', key: 'Meta', metaKey: false });
    await waitFor(() => sr.querySelectorAll('.agy-sidebar-shortcut-badge').length === 0);
  } finally {
    if (prevOrgPath === undefined) delete process.env.AGY_DADDY_SESSION_ORG_PATH;
    else process.env.AGY_DADDY_SESSION_ORG_PATH = prevOrgPath;
    await harness.cleanup();
  }
});

test('silent fallback: missing sidebar.root degrades silently after timeout and updates HostHealth & topbar', async () => {
  const doc = createMockDocument([]); // No sidebar.root and no conversationRows
  const harness = createMockHostHarness({ document: doc });
  const prevOrgPath = process.env.AGY_DADDY_SESSION_ORG_PATH;
  process.env.AGY_DADDY_SESSION_ORG_PATH = path.join(harness.tempRoot, 'session-org.json');

  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });
    await harness.loadAndRunPlugin(PLUGIN_DIR);

    const healthState = await waitFor(() => {
      const st = harness.bus.getState('state:sidebar.health@1');
      return st?.value?.status === 'degraded' ? st.value : null;
    }, 4500, 50);

    assert.equal(healthState.status, 'degraded');
    assert.equal(healthState.reason, 'ANCHOR_MISSING');
    assert.equal(healthState.fallback, 'native');
    assert.equal(doc.querySelector('#agy-sidebar-enhanced-root'), null);

    const hostShadow = doc.getElementById('agy-daddy-host')?.shadowRoot;
    const topbarUnit = await waitFor(() => hostShadow?.querySelector('[data-unit-id="sidebar-toggle"]'));
    assert.ok(topbarUnit, 'Topbar unit must exist in degraded mode');
    assert.equal(topbarUnit.getAttribute('data-tone'), 'warn');

    await harness.unloadPlugin('agy-daddy.sidebar');
    harness.assertCleanDispose('agy-daddy.sidebar');
  } finally {
    if (prevOrgPath === undefined) delete process.env.AGY_DADDY_SESSION_ORG_PATH;
    else process.env.AGY_DADDY_SESSION_ORG_PATH = prevOrgPath;
    await harness.cleanup();
  }
});
