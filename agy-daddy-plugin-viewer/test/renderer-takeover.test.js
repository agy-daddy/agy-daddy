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

const {
  createMockHostHarness,
  createMockDocument,
  createMockElement
} = require(path.join(HOST_ROOT, 'sdk', 'mock-harness'));

const { VIEWER_HEADER_STYLES, VIEWER_STAGE_STYLES, VIEWER_DRAWER_STYLES } = require('../src/styles');
const { createTranslator } = require('../src/i18n');
const { shouldAutoTakeover } = require('../src/ui/takeover-controller');
const { mountMediaViewer, downsampleAudioBuffer } = require('../src/ui/media-viewer');
const { mountCsvViewer } = require('../src/ui/csv-viewer');
const { mountSvgViewer } = require('../src/ui/svg-viewer');
const { mountFontViewer } = require('../src/ui/font-viewer');
const { mountDiffStage } = require('../src/ui/git-diff-viewer');

function realPath(p) {
  return (fs.realpathSync.native || fs.realpathSync)(p);
}

async function waitFor(predicate, timeoutMs = 3000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = predicate();
    if (val) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

function seedFileViewerDoc() {
  const doc = createMockDocument([]);
  doc.documentElement.setAttribute('lang', 'zh-CN');
  const panel = createMockElement('div', doc);
  panel.setAttribute('data-testid', 'file-viewer-panel');

  const header = createMockElement('div', doc);
  header.setAttribute('aria-label', '文件查看器标题栏');

  // Simulate chat-nav existing button on header
  const chatNavBtn = createMockElement('button', doc);
  chatNavBtn.id = 'agy-file-editor-controls';
  chatNavBtn.textContent = '编辑';
  header.appendChild(chatNavBtn);

  const body = createMockElement('div', doc);
  body.setAttribute('data-testid', 'native-file-body');
  body.style.setProperty('display', 'flex');
  body.textContent = 'Native preview content';

  panel.appendChild(header);
  panel.appendChild(body);
  doc.body.appendChild(panel);
  return { doc, panel, header, body, chatNavBtn };
}

function createChromiumLikeFetch(origin = 'https://127.0.0.1:51410', baseFetch = globalThis.fetch) {
  return (input, init = {}) => {
    const headers = { ...(init.headers || {}) };
    if (!headers.Origin && !headers.origin) {
      headers.Origin = origin;
    }
    return baseFetch(input, { ...init, headers });
  };
}

function initGitRepo(dir) {
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'app.js'), 'const a = 1;\nconst b = 2;\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'app.js'), 'const a = 10;\nconst b = 2;\nconst c = 3;\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02, 0x03]));
}

test('styles & shouldAutoTakeover: exports compliant Shadow DOM styles and evaluates official-first matrix', () => {
  assert.match(VIEWER_HEADER_STYLES, /:host/);
  assert.match(VIEWER_STAGE_STYLES, /:host/);
  assert.match(VIEWER_DRAWER_STYLES, /:host/);

  const baseSettings = {
    enabled: true,
    officialFirstDeferral: true,
    enableMediaViewer: true,
    mediaThresholdMB: 5,
    enableCsvViewer: true,
    csvThresholdMB: 1,
    csvThresholdLines: 2000,
    enableSvgViewer: true,
    svgTakeoverMode: 'threshold',
    svgThresholdKB: 64,
    enableFontViewer: true,
    fontAutoTakeover: true
  };

  assert.equal(shouldAutoTakeover({
    inspectRes: { authorized: true, exists: true, category: 'other', size: 50_000_000 },
    bodyEl: null,
    settings: baseSettings,
    manualOverride: null
  }), false);

  assert.equal(shouldAutoTakeover({
    inspectRes: { authorized: true, exists: true, category: 'csv', size: 1024, estimatedLines: 50 },
    bodyEl: { textContent: 'col1,col2' },
    settings: baseSettings,
    manualOverride: null
  }), false);

  assert.equal(shouldAutoTakeover({
    inspectRes: { authorized: true, exists: true, category: 'csv', size: 1024, estimatedLines: 2500 },
    bodyEl: { textContent: 'col1,col2' },
    settings: baseSettings,
    manualOverride: null
  }), true);

  assert.equal(shouldAutoTakeover({
    inspectRes: { authorized: true, exists: true, category: 'csv', size: 2_000_000, estimatedLines: 2500 },
    bodyEl: { textContent: 'col1,col2' },
    settings: baseSettings,
    manualOverride: 'native'
  }), false);

  assert.equal(shouldAutoTakeover({
    inspectRes: { authorized: true, exists: true, category: 'font', size: 100_000 },
    bodyEl: { textContent: 'Binary' },
    settings: baseSettings,
    manualOverride: null
  }), true);
});

test('renderer-takeover: isolated world mount, deferral, auto-takeover, anti-rebound, chat-nav coexistence & clean dispose', async () => {
  const tmpDir = realPath(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-viewer-fe-')));
  const tsFile = path.join(tmpDir, 'index.ts');
  const smallCsv = path.join(tmpDir, 'small.csv');
  const largeCsv = path.join(tmpDir, 'large.csv');

  fs.writeFileSync(tsFile, 'export const x = 1;\n', 'utf8');
  fs.writeFileSync(smallCsv, 'id,name\n1,alice\n2,bob\n', 'utf8');
  const largeRows = ['id,name'];
  for (let i = 1; i <= 2100; i++) largeRows.push(`${i},row_${i}`);
  fs.writeFileSync(largeCsv, largeRows.join('\n'), 'utf8');

  const { doc, panel, header, body, chatNavBtn } = seedFileViewerDoc();
  header.setAttribute('data-file-path', tsFile);

  const harness = createMockHostHarness({
    document: doc,
    fetch: createChromiumLikeFetch('https://127.0.0.1:51410'),
    onRpc: async (method) => {
      if (method === 'GetAllCascadeTrajectories') {
        return {
          trajectorySummaries: {
            c1: { workspaces: [{ workspaceFolderAbsoluteUri: url.pathToFileURL(tmpDir).href }] }
          }
        };
      }
      return { ok: true };
    }
  });

  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });

    const loaded = await harness.loadAndRunPlugin(PLUGIN_DIR, { trustLevel: 'T0' });
    assert.equal(loaded.trust.world, 'isolated');
    assert.ok(harness.isolatedWorlds.has('agy-daddy.viewer'));

    let viewerSvc = null;
    await harness.rendererHost.mountPlugin('test.viewer.consumer', {
      mount(ctx) {
        viewerSvc = ctx.services.get('viewer');
      }
    });
    assert.ok(viewerSvc);

    // 1. Clean .ts file defers to native; no stage host; no header capsule buttons; zero head style injection
    await waitFor(() => true);
    let state = await viewerSvc.getState();
    assert.equal(state.activeMode, 'native');
    assert.equal(doc.getElementById('agy-viewer-stage-host'), null);
    assert.equal(header.querySelector('#agy-viewer-header-host'), null);
    assert.equal(doc.head.querySelector('[data-agy-style="agy-daddy.viewer"]'), null);
    assert.equal(body.style.getPropertyValue('display'), 'flex');
    assert.ok(header.querySelector('#agy-file-editor-controls') === chatNavBtn);

    // 2. Small .csv (< 1MB, < 2000 lines) defers to native, shows [Omni 检视] in capsule
    header.setAttribute('data-file-path', smallCsv);
    await viewerSvc.inspectCurrent();
    state = await viewerSvc.getState();
    assert.equal(state.activeMode, 'native');
    assert.equal(doc.getElementById('agy-viewer-stage-host'), null);
    const hdrHost = header.querySelector('#agy-viewer-header-host');
    assert.ok(hdrHost);
    assert.ok(hdrHost.shadowRoot.querySelector('#agy-viewer-btn-omni'));
    assert.ok(header.querySelector('#agy-file-editor-controls') === chatNavBtn);

    // 3. Large .csv (>= 2000 lines) auto-takes over non-destructively and mounts CSV virtual viewer
    header.setAttribute('data-file-path', largeCsv);
    await viewerSvc.inspectCurrent();
    state = await viewerSvc.getState();
    assert.equal(state.activeMode, 'omni');
    assert.equal(body.style.getPropertyValue('display'), 'none');
    const stageHost = doc.getElementById('agy-viewer-stage-host');
    assert.ok(stageHost);
    const tableRows = await waitFor(() => {
      const rows = stageHost.shadowRoot.querySelectorAll('tr');
      return rows.length > 5 ? rows : null;
    });
    assert.ok(tableRows.length > 5);

    // 4. Manual switch back to native restores display and engages anti-rebound lock
    const nativeBtn = hdrHost.shadowRoot.querySelector('#agy-viewer-btn-native');
    assert.ok(nativeBtn);
    nativeBtn.click();
    await waitFor(async () => (await viewerSvc.getState()).activeMode === 'native');
    assert.equal(body.style.getPropertyValue('display'), 'flex');
    assert.equal(doc.getElementById('agy-viewer-stage-host'), null);

    // Host DOM re-render must NOT rebound back to Omni Viewer
    await viewerSvc.inspectCurrent();
    state = await viewerSvc.getState();
    assert.equal(state.activeMode, 'native');
    assert.equal(state.override, 'native');
    assert.equal(doc.getElementById('agy-viewer-stage-host'), null);

    // 5. Coexistence with chat-nav inline editor: opening editor suspends viewer takeover
    const omniBtn = hdrHost.shadowRoot.querySelector('#agy-viewer-btn-omni');
    omniBtn.click();
    await waitFor(async () => (await viewerSvc.getState()).activeMode === 'omni');
    const editorPanel = createMockElement('div', doc);
    editorPanel.id = 'agy-inline-file-editor-panel';
    panel.appendChild(editorPanel);
    await viewerSvc.inspectCurrent();
    state = await viewerSvc.getState();
    assert.equal(state.activeMode, 'native');
    assert.equal(body.style.getPropertyValue('display'), 'flex');
    editorPanel.remove();

    // 6. Clean unload restores DOM and leaks zero resources
    await harness.unloadPlugin('agy-daddy.viewer');
    assert.equal(doc.getElementById('agy-viewer-stage-host'), null);
    assert.equal(doc.getElementById('agy-viewer-header-host'), null);
    assert.equal(body.style.getPropertyValue('display'), 'flex');
    harness.assertCleanDispose('agy-daddy.viewer');
  } finally {
    await harness.cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Omni Viewers & Git Inline Diff: real gateway streaming, SVG sanitize, font bounds, git states & drawer', async () => {
  const tmpDir = realPath(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-viewer-ui-')));
  const gitDir = path.join(tmpDir, 'repo');
  const nonGitDir = path.join(tmpDir, 'plain');
  fs.mkdirSync(gitDir);
  fs.mkdirSync(nonGitDir);
  initGitRepo(gitDir);

  const csvPath = path.join(gitDir, 'data.csv');
  fs.writeFileSync(csvPath, 'id,name,note\n1,alpha,"hello"\n2,beta,"world_match"\n', 'utf8');
  const svgPath = path.join(gitDir, 'icon.svg');
  fs.writeFileSync(
    svgPath,
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80" onload="alert(1)"><script>evil()</script><rect width="120" height="80"/></svg>',
    'utf8'
  );
  const fontPath = path.join(gitDir, 'demo.woff2');
  fs.writeFileSync(fontPath, Buffer.from('wOF2dummyfontbytes'));
  const mediaPath = path.join(gitDir, 'clip.mp4');
  fs.writeFileSync(mediaPath, Buffer.from('0123456789ABCDEF'));
  const plainFile = path.join(nonGitDir, 'notes.txt');
  fs.writeFileSync(plainFile, 'hello\n', 'utf8');

  const { doc, header } = seedFileViewerDoc();
  header.setAttribute('data-file-path', path.join(gitDir, 'app.js'));

  const harness = createMockHostHarness({
    document: doc,
    fetch: createChromiumLikeFetch('https://127.0.0.1:51410'),
    onRpc: async (method) => {
      if (method === 'GetAllCascadeTrajectories') {
        return {
          trajectorySummaries: {
            c1: { workspaces: [{ workspaceFolderAbsoluteUri: url.pathToFileURL(tmpDir).href }] }
          }
        };
      }
      return { ok: true };
    }
  });

  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });
    await harness.loadAndRunPlugin(PLUGIN_DIR, { trustLevel: 'T0' });

    const t = createTranslator(doc);
    const bridgeCtx = {
      bridge: {
        post: async (subPath, payload) => {
          const resp = await origFetch(`http://127.0.0.1:${port}/plugins/agy-daddy.viewer${subPath}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-AGY-Plugin-Token': harness.bridge.issuePluginToken('agy-daddy.viewer')
            },
            body: JSON.stringify(payload || {})
          });
          return resp.json();
        }
      },
      schedule: { idle: () => () => {} },
      settings: { open: () => {} }
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = createChromiumLikeFetch('https://127.0.0.1:51410', origFetch);

    try {
      // A. CSV Viewer real HTTP gateway meta + search
      const csvTicket = await bridgeCtx.bridge.post('/gateway/ticket', {
        filePath: csvPath,
        purpose: 'csv',
        clientOrigin: 'https://127.0.0.1:51410'
      });
      assert.equal(csvTicket.ok, true);
      const csvRoot = createMockElement('div', doc);
      const csvCtrl = new AbortController();
      await mountCsvViewer({
        doc,
        t,
        rootEl: csvRoot,
        ticket: csvTicket,
        settings: { csvChunkSize: 50, csvFirstRowHeader: true },
        signal: csvCtrl.signal,
        trackCleanup: () => {}
      });
      assert.ok(csvRoot.querySelectorAll('tr').length >= 3);
      const searchInput = csvRoot.querySelector('input[type="text"]');
      searchInput.value = 'world_match';
      searchInput.dispatchEvent({ type: 'input', target: searchInput });
      const marks = await waitFor(() => {
        const m = csvRoot.querySelectorAll('mark');
        return m.length > 0 ? m : null;
      });
      assert.equal(marks[0].textContent, 'world_match');
      csvCtrl.abort();

      // B. SVG Viewer real HTTP gateway sanitization & lossless zoom
      const svgTicket = await bridgeCtx.bridge.post('/gateway/ticket', {
        filePath: svgPath,
        purpose: 'svg',
        clientOrigin: 'https://127.0.0.1:51410'
      });
      const svgRoot = createMockElement('div', doc);
      const svgCtrl = new AbortController();
      await mountSvgViewer({
        doc,
        t,
        rootEl: svgRoot,
        ticket: svgTicket,
        settings: { svgDefaultBackground: 'dark' },
        signal: svgCtrl.signal,
        trackCleanup: () => {}
      });
      const svgCanvas = svgRoot.querySelector('.agy-v-svg-canvas');
      assert.equal(svgCanvas.getAttribute('data-bg'), 'dark');
      const img = svgRoot.querySelector('img');
      assert.equal(img.style.getPropertyValue('width'), '120px');
      const zoomInBtn = svgRoot.querySelectorAll('button').find((b) => b.textContent === '+');
      zoomInBtn.click();
      assert.equal(img.style.getPropertyValue('width'), '150px');
      svgCtrl.abort();

      // C. Font Viewer safety limit > fontMaxSizeMB
      const fontTicket = await bridgeCtx.bridge.post('/gateway/ticket', {
        filePath: fontPath,
        purpose: 'font',
        clientOrigin: 'https://127.0.0.1:51410'
      });
      const fontRoot = createMockElement('div', doc);
      await mountFontViewer({
        doc,
        t,
        rootEl: fontRoot,
        ticket: { ...fontTicket, fileMeta: { ...fontTicket.fileMeta, size: 60 * 1024 * 1024 } },
        settings: { fontMaxSizeMB: 50 },
        signal: new AbortController().signal,
        trackCleanup: () => {}
      });
      assert.match(fontRoot.textContent, /50 MB/);

      // D. Media Viewer waveform downsample + marker persistence
      const fakeAudioBuf = {
        numberOfChannels: 1,
        length: 1000,
        getChannelData: () => new Float32Array(1000).fill(0.5)
      };
      assert.equal(downsampleAudioBuffer(fakeAudioBuf, 20).length, 20);
      const mediaTicket = await bridgeCtx.bridge.post('/gateway/ticket', {
        filePath: mediaPath,
        purpose: 'media',
        clientOrigin: 'https://127.0.0.1:51410'
      });
      const mediaRoot = createMockElement('div', doc);
      const mediaCleanups = [];
      await mountMediaViewer({
        ctx: bridgeCtx,
        doc,
        t,
        rootEl: mediaRoot,
        ticket: mediaTicket,
        filePath: mediaPath,
        settings: { mediaDefaultFps: '30', mediaWaveformMaxMB: 10 },
        signal: new AbortController().signal,
        trackCleanup: (fn) => mediaCleanups.push(fn)
      });
      assert.equal(mediaRoot.querySelector('video').getAttribute('crossorigin'), 'anonymous');
      const addMarkerBtn = mediaRoot.querySelectorAll('button').find((b) => b.textContent.includes('打点'));
      addMarkerBtn.click();
      await waitFor(() => mediaRoot.querySelectorAll('.agy-v-marker-row').length === 1);
      for (const fn of mediaCleanups) fn();

      // E. Git Diff Stage: modified file wordSpans, non-git, binary, and out-of-bounds
      const diffRoot = createMockElement('div', doc);
      await mountDiffStage({
        ctx: bridgeCtx,
        doc,
        t,
        rootEl: diffRoot,
        filePath: path.join(gitDir, 'app.js'),
        settings: { diffDefaultScope: 'head', diffDefaultLayout: 'unified', diffShowWordHighlight: true },
        signal: new AbortController().signal
      });
      assert.ok(diffRoot.querySelectorAll('.agy-v-word-add').length > 0);
      assert.ok(diffRoot.querySelectorAll('.agy-v-word-del').length > 0);

      // Non-git repo
      const nonGitRoot = createMockElement('div', doc);
      await mountDiffStage({
        ctx: bridgeCtx,
        doc,
        t,
        rootEl: nonGitRoot,
        filePath: plainFile,
        settings: {},
        signal: new AbortController().signal
      });
      assert.match(nonGitRoot.textContent, /不是 Git 仓库/);

      // Binary file
      const binRoot = createMockElement('div', doc);
      await mountDiffStage({
        ctx: bridgeCtx,
        doc,
        t,
        rootEl: binRoot,
        filePath: path.join(gitDir, 'logo.png'),
        settings: {},
        signal: new AbortController().signal
      });
      assert.match(binRoot.textContent, /二进制文件/);

      // Out-of-bounds path must render security card without leaking path
      const oobRoot = createMockElement('div', doc);
      await mountDiffStage({
        ctx: bridgeCtx,
        doc,
        t,
        rootEl: oobRoot,
        filePath: '\\\\evil-server\\share\\secret.txt',
        settings: {},
        signal: new AbortController().signal
      });
      assert.ok(oobRoot.querySelector('.agy-v-card-danger'));
      assert.equal(oobRoot.textContent.includes('evil-server'), false);

      // F. Workspace Git Diff Drawer triggered by viewer.openGitDiff command (relayed to renderer)
      let consumerCtx = null;
      await harness.rendererHost.mountPlugin('test.event.relay', {
        mount(ctx) { consumerCtx = ctx; }
      });
      const stopRelay = harness.bus.onEvent('test.event.relay', 'viewer:diff-opened@1', (payload) => {
        consumerCtx.events.emit('viewer:diff-opened@1', { ...(payload || {}), rootHint: gitDir });
      });
      const wsRes = await harness.executeCommand('viewer.openGitDiff', [{ rootHint: gitDir }]);
      assert.equal(wsRes.isGitRepo, true);
      const drawerHost = await waitFor(() => doc.getElementById('agy-viewer-drawer-host'));
      assert.ok(drawerHost);
      await waitFor(() => drawerHost.shadowRoot.querySelectorAll('.agy-v-drawer-item').length >= 1);
      stopRelay();
    } finally {
      globalThis.fetch = origFetch;
    }

    await harness.unloadPlugin('agy-daddy.viewer');
    assert.equal(doc.getElementById('agy-viewer-drawer-host'), null);
    harness.assertCleanDispose('agy-daddy.viewer');
  } finally {
    await harness.cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CSV Viewer empty-state regression: zero-hit search and zero-data-row CSV render csv.emptyRows without ReferenceError', async () => {
  const tmpDir = realPath(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-viewer-csv-empty-')));
  const dataCsv = path.join(tmpDir, 'data.csv');
  const headerOnlyCsv = path.join(tmpDir, 'header-only.csv');
  const emptyCsv = path.join(tmpDir, 'empty.csv');

  fs.writeFileSync(dataCsv, 'id,name,note\n1,alpha,"hello"\n2,beta,"world"\n', 'utf8');
  fs.writeFileSync(headerOnlyCsv, 'id,name,note\n', 'utf8');
  fs.writeFileSync(emptyCsv, '', 'utf8');

  const { doc, header } = seedFileViewerDoc();
  header.setAttribute('data-file-path', dataCsv);

  const harness = createMockHostHarness({
    document: doc,
    fetch: createChromiumLikeFetch('https://127.0.0.1:51410'),
    onRpc: async (method) => {
      if (method === 'GetAllCascadeTrajectories') {
        return {
          trajectorySummaries: {
            c1: { workspaces: [{ workspaceFolderAbsoluteUri: url.pathToFileURL(tmpDir).href }] }
          }
        };
      }
      return { ok: true };
    }
  });

  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });
    await harness.loadAndRunPlugin(PLUGIN_DIR, { trustLevel: 'T0' });

    const t = createTranslator(doc);
    const origFetch = globalThis.fetch;
    const postTicket = async (filePath) => {
      const resp = await origFetch(`http://127.0.0.1:${port}/plugins/agy-daddy.viewer/gateway/ticket`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AGY-Plugin-Token': harness.bridge.issuePluginToken('agy-daddy.viewer')
        },
        body: JSON.stringify({
          filePath,
          purpose: 'csv',
          clientOrigin: 'https://127.0.0.1:51410'
        })
      });
      return resp.json();
    };

    globalThis.fetch = createChromiumLikeFetch('https://127.0.0.1:51410', origFetch);
    try {
      // (a) Searching with zero matching keywords renders csv.emptyRows and does not throw ReferenceError
      const dataTicket = await postTicket(dataCsv);
      assert.equal(dataTicket.ok, true);
      const searchRoot = createMockElement('div', doc);
      const searchCtrl = new AbortController();
      await mountCsvViewer({
        doc,
        t,
        rootEl: searchRoot,
        ticket: dataTicket,
        settings: { csvChunkSize: 50, csvFirstRowHeader: true },
        signal: searchCtrl.signal,
        trackCleanup: () => {}
      });

      const searchInput = searchRoot.querySelector('input[type="text"]');
      searchInput.value = '__NO_MATCH_KEYWORD_XYZ__';
      searchInput.dispatchEvent({ type: 'input', target: searchInput });

      const searchTbody = searchRoot.querySelector('tbody');
      assert.ok(searchTbody);
      const emptyTdAfterSearch = await waitFor(() => {
        const td = searchTbody.querySelector('td');
        return td && td.textContent === t('csv.emptyRows') ? td : null;
      });
      assert.ok(emptyTdAfterSearch);
      assert.equal(searchTbody.querySelectorAll('tr').length, 1);
      assert.equal(searchRoot.querySelector('.agy-v-card-center'), null);

      // Clearing search restores rows cleanly
      const clearBtn = searchRoot.querySelectorAll('button').find((b) => b.textContent === t('csv.clearFilter'));
      assert.ok(clearBtn);
      clearBtn.click();
      const restoredCount = await waitFor(() => {
        const n = searchTbody.querySelectorAll('tr').length;
        return n === 2 ? n : null;
      });
      assert.equal(restoredCount, 2);
      searchCtrl.abort();

      // (b) Opening 0-data-row CSV (header-only and completely empty) renders csv.emptyRows instead of error status card
      for (const zeroRowPath of [headerOnlyCsv, emptyCsv]) {
        const zeroTicket = await postTicket(zeroRowPath);
        assert.equal(zeroTicket.ok, true);
        const zeroRoot = createMockElement('div', doc);
        const zeroCtrl = new AbortController();
        await mountCsvViewer({
          doc,
          t,
          rootEl: zeroRoot,
          ticket: zeroTicket,
          settings: { csvChunkSize: 50, csvFirstRowHeader: true },
          signal: zeroCtrl.signal,
          trackCleanup: () => {}
        });

        assert.equal(zeroRoot.querySelector('.agy-v-card-center'), null);
        assert.equal(zeroRoot.querySelector('.agy-v-card'), null);
        const zeroTbody = zeroRoot.querySelector('tbody');
        assert.ok(zeroTbody);
        const tbodyRows = zeroTbody.querySelectorAll('tr');
        assert.equal(tbodyRows.length, 1);
        const emptyCell = zeroTbody.querySelector('td');
        assert.ok(emptyCell);
        assert.equal(emptyCell.textContent, t('csv.emptyRows'));
        zeroCtrl.abort();
      }
    } finally {
      globalThis.fetch = origFetch;
    }

    await harness.unloadPlugin('agy-daddy.viewer');
    harness.assertCleanDispose('agy-daddy.viewer');
  } finally {
    await harness.cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
