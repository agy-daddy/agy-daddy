'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const {
  SERVICE_NODE_NAME,
  STATE_GATEWAY_KEY,
  EVENT_DIFF_OPENED,
  DEFAULT_SETTINGS,
  ERROR_CODES,
  classifyExtension,
  safeErrorPayload
} = require('./constants');
const { validatePathAccess } = require('./path-guard');
const { createWorkspaceRootsResolver } = require('./workspace-roots');
const { inspectCsvHeaderSample, createCsvEngine } = require('./csv-engine');
const { createGatewayServer } = require('./gateway-server');
const { createGitDiffService } = require('./git-diff-service');
const { computeFileFingerprint, createMarkersStore } = require('./markers-store');

function isTestMode() {
  return (
    process.env.AGY_DADDY_TEST_MODE === '1'
    || process.env.NODE_ENV === 'test'
    || Boolean(process.env.NODE_TEST_CONTEXT)
  );
}

function normalizePickedDirPath(raw) {
  return String(raw || '').trim().replace(/[\r\n]+$/, '');
}

function runExecFileAsync(bin, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { shell: false, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: err.message, stdout: String(stdout || ''), stderr: String(stderr || '') });
      } else {
        resolve({ ok: true, stdout: String(stdout || ''), stderr: String(stderr || '') });
      }
    });
  });
}

async function openAllowedRootDirectoryDialog(opts = {}) {
  const defaultDir = normalizePickedDirPath(opts.defaultDir || '') || os.homedir();
  const promptText = String(opts.title || '选择允许访问的工作区根目录').trim();

  if (typeof opts.dirPickerFn === 'function') {
    const res = await opts.dirPickerFn({ defaultDir, title: promptText });
    if (res && res.ok === false) {
      return { ok: false, cancelled: false, path: '', error: String(res.error || '无法打开文件夹选择对话框') };
    }
    if (!res || res.cancelled || !res.path) {
      return { ok: true, cancelled: true, path: '' };
    }
    return { ok: true, cancelled: false, path: normalizePickedDirPath(res.path) };
  }

  if (isTestMode() || process.env.AGY_DADDY_TEST_DIR_DIALOG_RESULT !== undefined) {
    const testResult = String(process.env.AGY_DADDY_TEST_DIR_DIALOG_RESULT || '').trim();
    if (!testResult || testResult === '__CANCEL__') {
      return { ok: true, cancelled: true, path: '' };
    }
    return { ok: true, cancelled: false, path: normalizePickedDirPath(testResult) };
  }

  const platform = opts.platform || process.platform;
  if (platform === 'darwin') {
    const hasDir = defaultDir && fs.existsSync(defaultDir);
    const script = hasDir
      ? [
          'on run argv',
          '  set pTitle to item 1 of argv',
          '  set pDir to item 2 of argv',
          '  tell current application to activate',
          '  return POSIX path of (choose folder with prompt pTitle default location ((POSIX file pDir) as alias))',
          'end run'
        ].join('\n')
      : [
          'on run argv',
          '  set pTitle to item 1 of argv',
          '  tell current application to activate',
          '  return POSIX path of (choose folder with prompt pTitle)',
          'end run'
        ].join('\n');
    const args = ['-e', script, '--', promptText];
    if (hasDir) args.push(defaultDir);
    const res = await runExecFileAsync('osascript', args, { timeout: 120_000 });
    if (!res.ok) {
      if (/-128\b|user canceled|用户已取消/i.test(`${res.stderr} ${res.error}`)) {
        return { ok: true, cancelled: true, path: '' };
      }
      return { ok: false, cancelled: false, path: '', error: (res.stderr || res.error || '无法打开文件夹选择对话框').trim() };
    }
    const picked = normalizePickedDirPath(res.stdout);
    return picked ? { ok: true, cancelled: false, path: picked } : { ok: true, cancelled: true, path: '' };
  }

  if (platform === 'win32') {
    const psScript = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$d.Description = $env:AGY_DLG_TITLE',
      'if ($env:AGY_DLG_DIR -and (Test-Path $env:AGY_DLG_DIR)) { $d.SelectedPath = $env:AGY_DLG_DIR }',
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }'
    ].join('; ');
    const res = await runExecFileAsync('powershell.exe', ['-NoProfile', '-Command', psScript], {
      timeout: 120_000,
      env: { ...process.env, AGY_DLG_TITLE: promptText, AGY_DLG_DIR: defaultDir }
    });
    if (!res.ok && !res.stdout.trim()) {
      return { ok: false, cancelled: false, path: '', error: (res.stderr || res.error || '无法打开文件夹选择对话框').trim() };
    }
    const picked = normalizePickedDirPath(res.stdout);
    return picked ? { ok: true, cancelled: false, path: picked } : { ok: true, cancelled: true, path: '' };
  }

  const zen = await runExecFileAsync('zenity', ['--file-selection', '--directory', `--title=${promptText}`, `--filename=${defaultDir}/`], { timeout: 120_000 });
  if (zen.ok && zen.stdout.trim()) {
    return { ok: true, cancelled: false, path: normalizePickedDirPath(zen.stdout) };
  }
  return { ok: true, cancelled: true, path: '' };
}

let activeRuntime = null;

async function activate(host) {
  await deactivate();

  let disposers = [];
  function readSettings() {
    return {
      ...DEFAULT_SETTINGS,
      ...(host?.settings?.get?.() || {})
    };
  }

  let currentSettings = readSettings();
  const rootsResolver = createWorkspaceRootsResolver();
  const csvEngine = createCsvEngine();
  const markersStore = createMarkersStore(host?.storage);

  const publishGatewayState = (statusObj) => {
    try {
      host?.state?.set?.(STATE_GATEWAY_KEY, statusObj);
    } catch {}
  };

  const gatewayServer = createGatewayServer({
    resolveAllowedRoots: ({ settings, host: h }) => rootsResolver.resolveAllowedRoots({ settings: settings || currentSettings, host: h || host }),
    csvEngine,
    onStateChange: publishGatewayState
  });

  const gitDiffService = createGitDiffService({
    resolveAllowedRoots: ({ settings, host: h }) => rootsResolver.resolveAllowedRoots({ settings: settings || currentSettings, host: h || host })
  });

  async function syncGatewayLifecycle(nextSettings, prevSettings = null) {
    if (!nextSettings.enabled) {
      return await gatewayServer.stop();
    }
    const modeChanged = prevSettings && (
      prevSettings.gatewayPortMode !== nextSettings.gatewayPortMode
      || prevSettings.gatewayPort !== nextSettings.gatewayPort
    );
    if (modeChanged && gatewayServer.getPublicStatus().running) {
      await gatewayServer.stop();
    }
    return await gatewayServer.start({
      portMode: nextSettings.gatewayPortMode,
      gatewayPort: nextSettings.gatewayPort,
      getSettings: () => currentSettings,
      host
    });
  }

  await syncGatewayLifecycle(currentSettings, null);

  async function inspectFile(body = {}) {
    const rawPath = body?.rawPath || body?.filePath || '';
    const allowedRealRoots = await rootsResolver.resolveAllowedRoots({ settings: currentSettings, host });

    // Build fallback candidate when rawPath is relative (e.g. from hintText) against first root
    let checkRes = validatePathAccess(rawPath, {
      allowedRealRoots,
      mustExist: false,
      requireRegularFile: false
    });

    if (!checkRes.ok && checkRes.errorCode === ERROR_CODES.INVALID_PATH && typeof rawPath === 'string' && !path.isAbsolute(rawPath) && allowedRealRoots.length > 0) {
      for (const root of allowedRealRoots) {
        const candidate = validatePathAccess(rawPath, {
          allowedRealRoots,
          baseRoot: root,
          mustExist: false,
          requireRegularFile: false
        });
        if (candidate.ok && candidate.exists) {
          checkRes = candidate;
          break;
        }
      }
    }

    if (!checkRes.ok) {
      return {
        ok: true,
        authorized: false,
        exists: false,
        errorCode: checkRes.errorCode,
        category: 'other',
        filePath: null,
        name: null,
        ext: '',
        size: 0,
        mtimeMs: 0
      };
    }

    const realPath = checkRes.realPath;
    const name = path.basename(realPath);
    const ext = path.extname(realPath).toLowerCase();
    const { category } = classifyExtension(ext);
    const exists = Boolean(checkRes.exists && checkRes.stat?.isFile());
    const size = exists ? Number(checkRes.stat.size) : 0;
    const mtimeMs = exists ? Number(checkRes.stat.mtimeMs) : 0;

    const out = {
      ok: true,
      authorized: true,
      exists,
      category,
      filePath: realPath,
      name,
      ext,
      size,
      mtimeMs
    };

    if (exists && category === 'csv') {
      try {
        const sample = inspectCsvHeaderSample(realPath, size);
        out.estimatedLines = sample.estimatedLines;
      } catch {}
    }

    if (currentSettings.enableGitDiff) {
      try {
        const diffProbe = await gitDiffService.getFileDiff({
          filePath: realPath,
          scope: currentSettings.diffDefaultScope,
          contextLines: 0,
          wordHighlight: false,
          settings: currentSettings,
          host
        });
        if (diffProbe?.ok && diffProbe.isGitRepo) {
          out.gitChanged = diffProbe.state !== 'NO_CHANGES';
          if (out.gitChanged) {
            out.gitStats = {
              additions: diffProbe.stats?.additions || 0,
              deletions: diffProbe.stats?.deletions || 0,
              status: diffProbe.status || 'M'
            };
          }
        }
      } catch {}
    }

    return out;
  }

  async function issueGatewayTicket(body = {}) {
    currentSettings = readSettings();
    if (!currentSettings.enabled) {
      return safeErrorPayload(ERROR_CODES.GATEWAY_DISABLED);
    }
    return await gatewayServer.issueTicket({
      filePath: body?.filePath,
      purpose: body?.purpose,
      clientOrigin: body?.clientOrigin || '',
      host,
      settings: currentSettings
    });
  }

  async function getMarkersForFile(body = {}) {
    const allowedRealRoots = await rootsResolver.resolveAllowedRoots({ settings: currentSettings, host });
    const check = validatePathAccess(body?.filePath, {
      allowedRealRoots,
      mustExist: true,
      requireRegularFile: true
    });
    if (!check.ok) {
      return { ok: false, errorCode: check.errorCode, message: check.message };
    }
    const fp = computeFileFingerprint(check.realPath, check.stat.size, check.stat.mtimeMs);
    return markersStore.getMarkers(fp);
  }

  async function saveMarkersForFile(body = {}) {
    const allowedRealRoots = await rootsResolver.resolveAllowedRoots({ settings: currentSettings, host });
    const check = validatePathAccess(body?.filePath, {
      allowedRealRoots,
      mustExist: true,
      requireRegularFile: true
    });
    if (!check.ok) {
      return { ok: false, errorCode: check.errorCode, message: check.message };
    }
    const fp = computeFileFingerprint(check.realPath, check.stat.size, check.stat.mtimeMs);
    return markersStore.saveMarkers(fp, body?.markers);
  }

  const serviceMethods = {
    inspectFile,
    issueTicket: issueGatewayTicket,
    revokeTicket: (body = {}) => gatewayServer.revokeTicket(body || {}),
    getGatewayStatus: () => gatewayServer.getPublicStatus(),
    getFileDiff: (body = {}) => gitDiffService.getFileDiff({ ...(body || {}), settings: currentSettings, host }),
    getWorkspaceDiff: (body = {}) => gitDiffService.getWorkspaceChanges({ ...(body || {}), settings: currentSettings, host }),
    getDiffContext: (body = {}) => gitDiffService.getContextLines({ ...(body || {}), settings: currentSettings, host }),
    getMarkers: getMarkersForFile,
    saveMarkers: saveMarkersForFile,
    async browseAllowedRoot(opts = {}) {
      const valueRoots = Array.isArray(opts?.values?.allowedRoots) ? opts.values.allowedRoots : [];
      const existing = valueRoots.length > 0
        ? valueRoots
        : (Array.isArray(currentSettings.allowedRoots) ? currentSettings.allowedRoots : []);
      const lastRoot = existing.length > 0 ? String(existing[existing.length - 1] || '').trim() : '';
      let defaultDir = typeof opts.defaultDir === 'string' && opts.defaultDir.trim() ? opts.defaultDir.trim() : '';
      if (!defaultDir && lastRoot) {
        defaultDir = fs.existsSync(lastRoot) ? lastRoot : path.dirname(lastRoot);
      }
      const picked = await openAllowedRootDirectoryDialog({
        defaultDir: defaultDir || os.homedir(),
        title: opts.title || '选择允许访问的工作区根目录',
        dirPickerFn: opts.dirPickerFn
      });
      if (picked.ok && !picked.cancelled && picked.path && opts.applyToSettings !== false && host?.settings?.update) {
        const nextRoots = existing.includes(picked.path) ? existing : [...existing, picked.path];
        try {
          await host.settings.update({ allowedRoots: nextRoots });
        } catch {}
      }
      return picked;
    }
  };

  if (host?.services?.provide) {
    disposers.push(await host.services.provide(SERVICE_NODE_NAME, serviceMethods, { realm: 'node', version: '1.0.0' }));
  }

  if (host?.bridge?.registerRoute) {
    disposers.push(await host.bridge.registerRoute('/file/inspect', (body) => serviceMethods.inspectFile(body || {})));
    disposers.push(await host.bridge.registerRoute('/gateway/ticket', (body) => serviceMethods.issueTicket(body || {})));
    disposers.push(await host.bridge.registerRoute('/gateway/revoke', (body) => serviceMethods.revokeTicket(body || {})));
    disposers.push(await host.bridge.registerRoute('/gateway/status', () => serviceMethods.getGatewayStatus()));
    disposers.push(await host.bridge.registerRoute('/diff/file', (body) => serviceMethods.getFileDiff(body || {})));
    disposers.push(await host.bridge.registerRoute('/diff/workspace', (body) => serviceMethods.getWorkspaceDiff(body || {})));
    disposers.push(await host.bridge.registerRoute('/diff/context', (body) => serviceMethods.getDiffContext(body || {})));
    disposers.push(await host.bridge.registerRoute('/markers/get', (body) => serviceMethods.getMarkers(body || {})));
    disposers.push(await host.bridge.registerRoute('/markers/save', (body) => serviceMethods.saveMarkers(body || {})));
  }

  if (host?.commands?.register) {
    disposers.push(await host.commands.register('viewer.toggleOmniViewer', () => {
      host?.events?.emit?.('viewer:viewer-mode-changed@1', { requestedAction: 'toggle' });
      return { ok: true, action: 'toggleOmniViewer' };
    }));
    disposers.push(await host.commands.register('viewer.openGitDiff', async (opts = {}) => {
      const diffSummary = await serviceMethods.getWorkspaceDiff(opts || {});
      host?.events?.emit?.(EVENT_DIFF_OPENED, {
        isGitRepo: Boolean(diffSummary?.isGitRepo),
        totalChangedFiles: diffSummary?.totalChangedFiles || 0
      });
      return diffSummary;
    }));
    disposers.push(await host.commands.register('viewer.gatewayStatus', () => serviceMethods.getGatewayStatus()));
    disposers.push(await host.commands.register('viewer.browseAllowedRoot', (opts = {}) => serviceMethods.browseAllowedRoot(opts || {})));
  }

  if (host?.settings?.onChange) {
    disposers.push(host.settings.onChange((nextValues) => {
      const prev = currentSettings;
      currentSettings = { ...DEFAULT_SETTINGS, ...(nextValues || {}) };
      rootsResolver.invalidateCache();
      void syncGatewayLifecycle(currentSettings, prev).catch(() => {});
    }));
  }

  publishGatewayState(gatewayServer.getPublicStatus());

  activeRuntime = {
    async stop() {
      for (const fn of disposers) {
        try {
          if (typeof fn === 'function') await fn();
        } catch {}
      }
      disposers = [];
      rootsResolver.invalidateCache();
      await gatewayServer.stop();
    }
  };

  return serviceMethods;
}

async function deactivate() {
  if (activeRuntime) {
    const rt = activeRuntime;
    activeRuntime = null;
    await rt.stop();
  }
}

module.exports = {
  activate,
  deactivate,
  openAllowedRootDirectoryDialog
};
