'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveRuntime } = require('./runtime-resolver');
const { getStateDir, isTestMode } = require('./paths');
const { inspectAntigravityHostProcess, resolveActiveCdpTarget } = require('./cdp');
const {
  ensureMacTrayAppBundle,
  resolveDefaultMacApplicationsDir,
  registerMacAppBundle
} = require('./tray-manager');

const LAUNCHER_APP_NAME = 'Agy-Daddy Launcher';
const LAUNCHER_MAC_BUNDLE_NAME = 'Agy-Daddy Launcher.app';
const LAUNCHER_BUNDLE_ID = 'dev.agy-daddy.launcher';
const LAUNCHER_ICON_NAME = 'AgyDaddyLauncher';
const LAUNCHER_ASSETS_DIR = path.resolve(__dirname, '..', '..', 'assets', 'icons');

function getLauncherIconPaths(assetsDir = LAUNCHER_ASSETS_DIR) {
  const dir = path.resolve(assetsDir);
  return {
    dir,
    icns: path.join(dir, `${LAUNCHER_ICON_NAME}.icns`),
    ico: path.join(dir, 'agy-daddy-launcher.ico'),
    trayIco: path.join(dir, 'tray-icon.ico'),
    png16: path.join(dir, 'icon-16.png'),
    png32: path.join(dir, 'icon-32.png'),
    png64: path.join(dir, 'icon-64.png'),
    png128: path.join(dir, 'icon-128.png'),
    png256: path.join(dir, 'icon-256.png'),
    png512: path.join(dir, 'icon-512.png'),
    png1024: path.join(dir, 'icon-1024.png'),
    trayTemplate1x: path.join(dir, 'tray-template-18.png'),
    trayTemplate2x: path.join(dir, 'tray-template-36.png'),
    svg: path.join(dir, 'agy-daddy-launcher.svg'),
    traySvg: path.join(dir, 'tray-icon-template.svg')
  };
}

function sanitizeUserLabel(user) {
  return String(user || os.userInfo().username || 'user').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function getLaunchAgentLabel(username) {
  return `com.${sanitizeUserLabel(username)}.agy-daddyd`;
}

function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function generateMacLaunchAgentPlist(options = {}) {
  const home = options.homeDir || os.homedir();
  const label = options.label || getLaunchAgentLabel(options.username);
  const cliPath = options.cliPath || path.resolve(__dirname, '..', 'cli.js');
  const logDir = options.logDir || path.join(home, 'Library', 'Logs', 'agy-daddy');
  const outLog = path.join(logDir, 'daemon.out.log');
  const errLog = path.join(logDir, 'daemon.err.log');
  const portFile = options.portFile || path.join(home, 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort');
  const lockFile = options.lockFile || path.join(home, 'Library', 'Application Support', 'Antigravity', 'SingletonLock');
  const runtimeInfo = options.runtimeInfo || resolveRuntime();
  const programArgs = runtimeInfo?.runtime
    ? [runtimeInfo.runtime, cliPath, 'live']
    : ['/usr/bin/env', 'node', cliPath, 'live'];

  const envEntries = {
    PATH: options.pathEnv || `${path.join(home, '.local', 'bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    AGY_DADDY_LAUNCHD: '1',
    ...(runtimeInfo?.isElectron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    ...(options.env || {})
  };

  const argsXml = programArgs.map((a) => `    <string>${escapeXml(a)}</string>`).join('\n');
  const envXml = Object.entries(envEntries)
    .map(([k, v]) => `    <key>${escapeXml(k)}</key>\n    <string>${escapeXml(v)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>WatchPaths</key>
  <array>
    <string>${escapeXml(portFile)}</string>
    <string>${escapeXml(lockFile)}</string>
  </array>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(outLog)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(errLog)}</string>
</dict>
</plist>
`;
}

function generateWindowsLauncherBat(options = {}) {
  const antigravityExe = options.antigravityExe || '%LOCALAPPDATA%\\Programs\\Antigravity\\Antigravity.exe';
  const binPath = options.binPath || path.resolve(__dirname, '..', 'cli.js');
  const proxyUrl = options.proxyUrl || '';
  const mode = options.mode === 'live' ? 'live' : 'launcher';
  const launchFlags = mode === 'launcher' && options.launchApp ? ' --launch-app' : '';
  const lines = [
    '@echo off',
    `title ${LAUNCHER_APP_NAME}`,
    `rem ${LAUNCHER_APP_NAME} (${LAUNCHER_BUNDLE_ID})`,
    'set ELECTRON_RUN_AS_NODE=1',
    proxyUrl ? `set HTTP_PROXY=${proxyUrl}\r\nset HTTPS_PROXY=${proxyUrl}` : 'rem no proxy override',
    mode === 'live'
      ? `start "" "${antigravityExe}" --remote-debugging-port=0`
      : `rem Antigravity enhanced launch command: "${antigravityExe}" --remote-debugging-port=0`,
    `start "" /B "${antigravityExe}" "${binPath}" ${mode}${launchFlags}`
  ];
  return lines.join('\r\n') + '\r\n';
}

function generateLinuxDesktopEntry(options = {}) {
  const binCli = options.binCli || path.resolve(__dirname, '..', '..', 'bin', 'agy-daddy');
  const iconPath = options.iconPath || getLauncherIconPaths(options.assetsDir).png256;
  const execArgs = options.launchApp ? 'launcher --launch-app' : 'launcher';
  return `[Desktop Entry]
Version=1.0
Type=Application
Name=${LAUNCHER_APP_NAME}
GenericName=Antigravity Enhanced Launcher
Comment=System tray launcher and CDP plugin host for Antigravity
Exec="${binCli}" ${execArgs}
Icon=${iconPath}
Terminal=false
Categories=Development;Utility;
StartupWMClass=agy-daddy-launcher
`;
}

function generateLinuxSystemdUnit(options = {}) {
  const binPath = options.binPath || path.resolve(__dirname, '..', 'bin', 'agy-daddy');
  const runtime = options.runtimePath || '/usr/bin/env node';
  return `[Unit]
Description=Agy-Daddy CDP Plugin Host Daemon
After=graphical-session.target

[Service]
Type=simple
ExecStart=${runtime} ${binPath} daemon start
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
}

function assertSafeTargetDir(targetDir, label) {
  if (isTestMode() && !targetDir) {
    throw new Error(`TEST_MODE_REQUIRES_EXPLICIT_DIR: ${label} requires explicit targetDir under AGY_DADDY_TEST_MODE=1`);
  }
}

function installAutoStart(options = {}) {
  const platform = options.platform || process.platform;
  const label = options.label || getLaunchAgentLabel(options.username);
  if (platform === 'win32') {
    const batContent = generateWindowsLauncherBat(options);
    if (options.dryRun) return { ok: true, dryRun: true, platform, content: batContent };
    assertSafeTargetDir(options.targetDir, 'installAutoStart');
    const dir = path.resolve(options.targetDir);
    fs.mkdirSync(dir, { recursive: true });
    const outPath = path.join(dir, 'agy-daddyd-start.bat');
    fs.writeFileSync(outPath, batContent, 'utf8');
    return { ok: true, platform, filePath: outPath };
  }
  if (platform === 'linux') {
    const unitContent = generateLinuxSystemdUnit(options);
    if (options.dryRun) return { ok: true, dryRun: true, platform, content: unitContent };
    assertSafeTargetDir(options.targetDir, 'installAutoStart');
    const dir = path.resolve(options.targetDir);
    fs.mkdirSync(dir, { recursive: true });
    const outPath = path.join(dir, 'agy-daddyd.service');
    fs.writeFileSync(outPath, unitContent, 'utf8');
    return { ok: true, platform, filePath: outPath };
  }

  const home = options.homeDir || os.homedir();
  const logDir = options.logDir || (isTestMode() && options.targetDir
    ? path.join(options.targetDir, 'logs')
    : path.join(home, 'Library', 'Logs', 'agy-daddy'));
  const plistContent = generateMacLaunchAgentPlist({ ...options, label, logDir, homeDir: home });
  if (options.dryRun) {
    return { ok: true, dryRun: true, platform: 'darwin', label, plist: plistContent };
  }
  assertSafeTargetDir(options.targetDir, 'installAutoStart');
  const launchDir = path.resolve(options.targetDir || path.join(home, 'Library', 'LaunchAgents'));
  fs.mkdirSync(launchDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const plistPath = path.join(launchDir, `${label}.plist`);
  fs.writeFileSync(plistPath, plistContent, 'utf8');

  let loaded = false;
  let launchctlError = null;
  if (!isTestMode() && !options.skipLaunchctl && process.platform === 'darwin') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid !== null) {
      try {
        spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {}
      const boot = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (boot.status === 0) {
        loaded = true;
      } else {
        launchctlError = String(boot.stderr || boot.stdout || `launchctl exit ${boot.status}`).trim();
      }
    }
  }
  return { ok: true, platform: 'darwin', label, filePath: plistPath, logDir, loaded, launchctlError };
}

function removeAutoStart(options = {}) {
  const label = options.label || getLaunchAgentLabel(options.username);
  if (options.dryRun) return { ok: true, dryRun: true, label };
  assertSafeTargetDir(options.targetDir, 'removeAutoStart');
  const home = options.homeDir || os.homedir();
  const launchDir = path.resolve(options.targetDir || path.join(home, 'Library', 'LaunchAgents'));
  const plistPath = path.join(launchDir, `${label}.plist`);

  let unloaded = false;
  if (!isTestMode() && !options.skipLaunchctl && process.platform === 'darwin') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid !== null) {
      const boot = spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      unloaded = boot.status === 0;
    }
  }

  const existed = fs.existsSync(plistPath);
  if (existed) fs.unlinkSync(plistPath);
  return { ok: true, removed: existed, unloaded, filePath: plistPath };
}

function installMacLauncherApp(options = {}) {
  assertSafeTargetDir(options.targetDir, 'installMacLauncherApp');
  const defaultAppsDir = resolveDefaultMacApplicationsDir() || path.join(os.homedir(), 'Applications');
  const targetDir = path.resolve(options.targetDir || defaultAppsDir);
  const appName = options.appName || LAUNCHER_MAC_BUNDLE_NAME;
  const appDir = path.join(targetDir, appName);
  const contentsDir = path.join(appDir, 'Contents');
  const macOsDir = path.join(contentsDir, 'MacOS');
  const resourcesDir = path.join(contentsDir, 'Resources');
  const infoPath = path.join(contentsDir, 'Info.plist');
  const binPath = path.join(macOsDir, 'launch');
  const helperAppPath = appDir;
  const helperPath = path.join(macOsDir, 'AgyDaddyTray');
  const iconPaths = getLauncherIconPaths(options.assetsDir);
  const iconDestPath = path.join(resourcesDir, `${LAUNCHER_ICON_NAME}.icns`);

  const binCli = path.resolve(__dirname, '..', '..', 'bin', 'agy-daddy');
  const launchFlag = options.launchApp ? ' --launch-app' : '';
  const script = `#!/usr/bin/env zsh
set -euo pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:\${PATH:-}"
APP_BUNDLE="$(cd "$(dirname "$0")/../.." && pwd)"
export AGY_DADDY_TRAY_APP="$APP_BUNDLE"
LOG_DIR="$HOME/Library/Logs/agy-daddy"
mkdir -p "$LOG_DIR"
exec "${binCli}" launcher${launchFlag} >>"$LOG_DIR/launcher.log" 2>&1
`;
  const lsUiElementXml = options.dockIcon === true
    ? ''
    : '\n  <key>LSUIElement</key><true/>';
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>AgyDaddyTray</string>
  <key>CFBundleIdentifier</key><string>${escapeXml(LAUNCHER_BUNDLE_ID)}</string>
  <key>CFBundleName</key><string>${escapeXml(LAUNCHER_APP_NAME)}</string>
  <key>CFBundleDisplayName</key><string>${escapeXml(LAUNCHER_APP_NAME)}</string>
  <key>CFBundleIconFile</key><string>${escapeXml(LAUNCHER_ICON_NAME)}</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleVersion</key><string>1.0.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>${lsUiElementXml}
</dict>
</plist>
`;

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      platform: 'darwin',
      appName,
      displayName: LAUNCHER_APP_NAME,
      bundleId: LAUNCHER_BUNDLE_ID,
      appDir,
      infoPath,
      binPath,
      resourcesDir,
      helperAppPath,
      helperPath,
      iconPath: iconDestPath
    };
  }
  fs.mkdirSync(macOsDir, { recursive: true });
  fs.mkdirSync(resourcesDir, { recursive: true });

  const legacyHashMarker = path.join(contentsDir, '.swift-hash');
  try { if (fs.existsSync(legacyHashMarker)) fs.unlinkSync(legacyHashMarker); } catch {}
  const legacyHelpersDir = path.join(contentsDir, 'Helpers');
  const legacyHelperApp = path.join(legacyHelpersDir, 'Agy-Daddy Tray.app');
  if (fs.existsSync(legacyHelperApp)) {
    registerMacAppBundle(legacyHelperApp, '-u');
    try { fs.rmSync(legacyHelperApp, { recursive: true, force: true }); } catch {}
  }
  try {
    if (fs.existsSync(legacyHelpersDir) && fs.readdirSync(legacyHelpersDir).length === 0) {
      fs.rmdirSync(legacyHelpersDir);
    }
  } catch {}

  fs.writeFileSync(infoPath, plist, 'utf8');
  fs.writeFileSync(binPath, script, 'utf8');
  fs.chmodSync(binPath, 0o755);

  const copiedIcons = [];
  for (const [src, destName] of [
    [iconPaths.icns, `${LAUNCHER_ICON_NAME}.icns`],
    [iconPaths.trayTemplate1x, 'tray-template-18.png'],
    [iconPaths.trayTemplate2x, 'tray-template-36.png']
  ]) {
    if (fs.existsSync(src)) {
      const dest = path.join(resourcesDir, destName);
      fs.copyFileSync(src, dest);
      copiedIcons.push(dest);
    }
  }

  let helperCompiled = false;
  if (!isTestMode() && process.platform === 'darwin') {
    const built = ensureMacTrayAppBundle({
      bundlePathOverride: appDir,
      assetsDir: options.assetsDir,
      dockIcon: options.dockIcon,
      stateDir: options.stateDir
    });
    helperCompiled = Boolean(built?.ok && fs.existsSync(built.exePath));

    if (!options.targetDir && targetDir === '/Applications') {
      const legacyHomeApp = path.join(os.homedir(), 'Applications', appName);
      if (legacyHomeApp !== appDir && fs.existsSync(legacyHomeApp)) {
        registerMacAppBundle(legacyHomeApp, '-u');
        try { fs.rmSync(legacyHomeApp, { recursive: true, force: true }); } catch {}
      }
    }
  }

  return {
    ok: true,
    platform: 'darwin',
    appName,
    displayName: LAUNCHER_APP_NAME,
    bundleId: LAUNCHER_BUNDLE_ID,
    appDir,
    infoPath,
    binPath,
    resourcesDir,
    helperAppPath,
    helperPath,
    helperCompiled,
    iconPath: iconDestPath,
    copiedIcons
  };
}

function installLauncherApp(options = {}) {
  const platform = options.platform || process.platform;
  if (platform === 'darwin') {
    return installMacLauncherApp(options);
  }
  assertSafeTargetDir(options.targetDir, 'installLauncherApp');
  const iconPaths = getLauncherIconPaths(options.assetsDir);
  if (platform === 'win32') {
    const targetDir = path.resolve(options.targetDir || path.join(os.homedir(), 'Desktop'));
    const batPath = path.join(targetDir, `${LAUNCHER_APP_NAME}.bat`);
    const icoDestPath = path.join(targetDir, 'agy-daddy-launcher.ico');
    const batContent = generateWindowsLauncherBat({ ...options, mode: options.mode || 'launcher' });
    if (options.dryRun) {
      return {
        ok: true,
        dryRun: true,
        platform: 'win32',
        appName: `${LAUNCHER_APP_NAME}.bat`,
        displayName: LAUNCHER_APP_NAME,
        bundleId: LAUNCHER_BUNDLE_ID,
        filePath: batPath,
        iconPath: icoDestPath
      };
    }
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(batPath, batContent, 'utf8');
    if (fs.existsSync(iconPaths.ico)) {
      fs.copyFileSync(iconPaths.ico, icoDestPath);
    }
    return {
      ok: true,
      platform: 'win32',
      appName: `${LAUNCHER_APP_NAME}.bat`,
      displayName: LAUNCHER_APP_NAME,
      bundleId: LAUNCHER_BUNDLE_ID,
      filePath: batPath,
      iconPath: icoDestPath
    };
  }

  const targetDir = path.resolve(options.targetDir || path.join(os.homedir(), '.local', 'share', 'applications'));
  const desktopPath = path.join(targetDir, 'agy-daddy-launcher.desktop');
  const pngDestPath = path.join(targetDir, 'agy-daddy-launcher.png');
  const desktopContent = generateLinuxDesktopEntry({ ...options, iconPath: pngDestPath });
  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      platform: 'linux',
      appName: 'agy-daddy-launcher.desktop',
      displayName: LAUNCHER_APP_NAME,
      bundleId: LAUNCHER_BUNDLE_ID,
      filePath: desktopPath,
      iconPath: pngDestPath
    };
  }
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(desktopPath, desktopContent, 'utf8');
  fs.chmodSync(desktopPath, 0o755);
  if (fs.existsSync(iconPaths.png256)) {
    fs.copyFileSync(iconPaths.png256, pngDestPath);
  }
  return {
    ok: true,
    platform: 'linux',
    appName: 'agy-daddy-launcher.desktop',
    displayName: LAUNCHER_APP_NAME,
    bundleId: LAUNCHER_BUNDLE_ID,
    filePath: desktopPath,
    iconPath: pngDestPath
  };
}

function detectInsideAntigravitySession(env = process.env) {
  if (!env || typeof env !== 'object') return false;
  if (env.ANTIGRAVITY_AGENT || env.ANTIGRAVITY_SESSION || env.AGY_SESSION_ID) return true;
  if (String(env.TERM_PROGRAM || '').toLowerCase().includes('antigravity')) return true;
  if (String(env.VSCODE_IPC_HOOK_CLI || '').toLowerCase().includes('antigravity')) return true;
  return false;
}

function planAntigravityRestart(options = {}) {
  const inside = detectInsideAntigravitySession(options.env || process.env);
  if (inside && !options.allowSelfTerminate) {
    return {
      ok: false,
      blocked: true,
      reason: 'INSIDE_ANTIGRAVITY_SESSION',
      message: '当前正运行在 Antigravity 内部会话中，已阻止强杀宿主；请在外部终端运行 `agy-daddy restart`。'
    };
  }
  const appPath = options.appPath || '/Applications/Antigravity.app';
  const proxyEnv = options.proxyEnv || {};
  const openArgs = [];
  for (const [k, v] of Object.entries(proxyEnv)) {
    openArgs.push('--env', `${k}=${v}`);
  }
  openArgs.push('-a', appPath, '--args', '--remote-debugging-port=0', ...(options.extraArgs || []));
  return {
    ok: true,
    blocked: false,
    executable: 'open',
    args: openArgs
  };
}

function findMacAntigravityApp(options = {}) {
  if (options.appPath) return options.appPath;
  const fsImpl = options.fs || options.fsImpl || fs;
  const home = options.homeDir || os.homedir();
  const candidates = [
    '/Applications/Antigravity.app',
    path.join(home, 'Applications', 'Antigravity.app')
  ];
  for (const cand of candidates) {
    try {
      if (fsImpl.existsSync(cand)) return cand;
    } catch {}
  }
  return '/Applications/Antigravity.app';
}

function defaultIsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function relaunchAntigravityWithCdp(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'darwin') {
    return {
      ok: false,
      relaunched: false,
      reason: 'UNSUPPORTED_PLATFORM',
      message: '自动补参重启目前仅支持 macOS'
    };
  }

  const env = options.env || process.env;
  const fsImpl = options.fsImpl || options.fs || fs;
  const resolvedAppPath = findMacAntigravityApp({ appPath: options.appPath, fsImpl, homeDir: options.homeDir });
  const rawExtraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : [];
  const filteredExtraArgs = rawExtraArgs.filter((arg) => !String(arg || '').startsWith('--remote-debugging-port'));

  const plan = planAntigravityRestart({
    appPath: resolvedAppPath,
    proxyEnv: options.proxyEnv || {},
    extraArgs: filteredExtraArgs,
    allowSelfTerminate: Boolean(options.allowSelfTerminate),
    env
  });
  if (!plan.ok) {
    return { ...plan, relaunched: false };
  }

  const inspectHost = options.inspectHostProcess || (() => inspectAntigravityHostProcess({ platform, env }));
  const resolveCdp = options.resolveCdpTarget || ((opts) => resolveActiveCdpTarget(opts));
  const isPidAliveFn = options.isPidAliveFn || defaultIsPidAlive;
  const runOsascript = options.runOsascript || (() => spawnSync(
    'osascript',
    ['-e', 'tell application "Antigravity" to quit'],
    { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] }
  ));
  const killProcess = options.killProcess || ((pid, sig) => process.kill(pid, sig));
  const launchApp = options.launchApp || ((executable, args) => spawnSync(executable, args, {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe']
  }));
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now || (() => Date.now());

  const hostProc = inspectHost() || { running: false, pid: null, hasDebugSwitch: false };
  if (options.onlyIfBare && hostProc.running && hostProc.hasDebugSwitch) {
    return {
      ok: true,
      relaunched: false,
      reason: 'ALREADY_HAS_DEBUG_SWITCH',
      pid: hostProc.pid || null
    };
  }

  const cooldownMs = Number.isFinite(Number(options.cooldownMs)) ? Number(options.cooldownMs) : 20000;
  const lockPath = options.lockPath || path.join(options.stateDir || getStateDir(options), 'relaunch.lock');
  if (options.enforceCooldown) {
    try {
      if (fsImpl.existsSync(lockPath)) {
        const rawTs = Number(String(fsImpl.readFileSync(lockPath, 'utf8') || '').trim());
        if (Number.isFinite(rawTs) && now() - rawTs < cooldownMs) {
          return {
            ok: false,
            skipped: true,
            relaunched: false,
            reason: 'COOLDOWN_ACTIVE'
          };
        }
      }
    } catch {}
  }

  try {
    fsImpl.mkdirSync(path.dirname(lockPath), { recursive: true });
    fsImpl.writeFileSync(lockPath, String(now()), 'utf8');
  } catch {}

  const pollIntervalMs = Math.max(10, Number(options.pollIntervalMs) || 500);
  const quitTimeoutMs = Math.max(0, options.quitTimeoutMs !== undefined ? Number(options.quitTimeoutMs) : 8000);
  const waitCdpTimeoutMs = options.waitCdpTimeoutMs !== undefined ? Number(options.waitCdpTimeoutMs) : 20000;

  if (hostProc.running && hostProc.pid) {
    try { runOsascript(); } catch {}
    const quitStart = now();
    const termThreshold = Math.floor(quitTimeoutMs / 2);
    let sentTerm = false;

    while (isPidAliveFn(hostProc.pid)) {
      const elapsed = now() - quitStart;
      if (elapsed >= quitTimeoutMs) break;
      if (!sentTerm && elapsed >= termThreshold) {
        sentTerm = true;
        try { killProcess(hostProc.pid, 'SIGTERM'); } catch {}
      }
      await sleep(Math.min(pollIntervalMs, Math.max(1, quitTimeoutMs - elapsed)));
    }

    if (isPidAliveFn(hostProc.pid)) {
      return {
        ok: false,
        relaunched: false,
        reason: 'QUIT_TIMEOUT',
        pid: hostProc.pid,
        message: '等待原 Antigravity 进程退出超时，请手动按 ⌘Q 退出后再试'
      };
    }
  }

  const launchRes = launchApp(plan.executable, plan.args);
  if (launchRes && typeof launchRes.status === 'number' && launchRes.status !== 0) {
    return {
      ok: false,
      relaunched: false,
      reason: 'LAUNCH_FAILED',
      error: String(launchRes.stderr || launchRes.stdout || launchRes.error?.message || `exit ${launchRes.status}`).trim()
    };
  }
  if (launchRes && launchRes.error) {
    return {
      ok: false,
      relaunched: false,
      reason: 'LAUNCH_FAILED',
      error: launchRes.error.message || String(launchRes.error)
    };
  }

  if (waitCdpTimeoutMs <= 0) {
    return { ok: true, relaunched: true, port: null, targets: [], targetsCount: 0 };
  }

  const waitStart = now();
  let lastPort = null;
  while (true) {
    try {
      const cdpRes = await resolveCdp({ timeoutMs: 1200 });
      if (cdpRes?.port) lastPort = cdpRes.port;
      if (Array.isArray(cdpRes?.targets) && cdpRes.targets.length > 0) {
        return {
          ok: true,
          relaunched: true,
          port: cdpRes.port || lastPort,
          targets: cdpRes.targets,
          targetsCount: cdpRes.targets.length
        };
      }
    } catch {}
    const elapsed = now() - waitStart;
    if (elapsed >= waitCdpTimeoutMs) break;
    await sleep(Math.min(pollIntervalMs, Math.max(1, waitCdpTimeoutMs - elapsed)));
  }

  return {
    ok: false,
    relaunched: true,
    reason: 'CDP_WAIT_TIMEOUT',
    port: lastPort,
    targets: [],
    targetsCount: 0,
    message: '已重启 Antigravity，但等待 CDP 窗口就绪超时'
  };
}

function checkAndPullGitUpdate(repoDir, options = {}) {
  const dir = path.resolve(repoDir);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    return { ok: false, error: 'NOT_A_GIT_REPO', repoDir: dir };
  }
  const st = spawnSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
  if (st.status !== 0) {
    return { ok: false, error: 'GIT_STATUS_FAILED', stderr: st.stderr };
  }
  if (String(st.stdout || '').trim().length > 0) {
    return { ok: false, error: 'DIRTY_WORKTREE', message: '工作区存在未提交改动，已阻止拉取以免覆盖本地修改', repoDir: dir };
  }
  if (options.dryRun) {
    return { ok: true, dryRun: true, clean: true, repoDir: dir };
  }
  const pull = spawnSync('git', ['-C', dir, 'pull', '--ff-only'], { encoding: 'utf8' });
  if (pull.status !== 0) {
    return { ok: false, error: 'GIT_PULL_FAILED', stderr: pull.stderr || pull.stdout };
  }
  return { ok: true, updated: true, output: String(pull.stdout || '').trim(), repoDir: dir };
}

module.exports = {
  LAUNCHER_APP_NAME,
  LAUNCHER_MAC_BUNDLE_NAME,
  LAUNCHER_BUNDLE_ID,
  LAUNCHER_ICON_NAME,
  LAUNCHER_ASSETS_DIR,
  getLauncherIconPaths,
  getLaunchAgentLabel,
  generateMacLaunchAgentPlist,
  generateWindowsLauncherBat,
  generateLinuxSystemdUnit,
  generateLinuxDesktopEntry,
  installAutoStart,
  removeAutoStart,
  installMacLauncherApp,
  installLauncherApp,
  detectInsideAntigravitySession,
  planAntigravityRestart,
  findMacAntigravityApp,
  relaunchAntigravityWithCdp,
  checkAndPullGitUpdate
};
