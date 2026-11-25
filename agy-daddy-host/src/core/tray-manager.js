'use strict';

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');
const { getStateDir, isTestMode } = require('./paths');

const DEFAULT_TRAY_MENU_IDS = Object.freeze({
  LAUNCH_ANTIGRAVITY: 'host:launch-antigravity',
  PLUGIN_SETTINGS: 'host:plugin-settings',
  RESTART_DAEMON: 'host:restart-daemon',
  QUIT: 'host:quit'
});

const FAULT_TRAY_MENU_IDS = Object.freeze({
  FAULT_STATUS: 'host:fault-status',
  RELAUNCH_ANTIGRAVITY: 'host:relaunch-antigravity',
  OPEN_DIAGNOSTICS: 'host:open-diagnostics',
  HEALTH_SUMMARY: 'host:health-summary'
});

const ALERT_TRAY_TITLE = '⚠️ 未接管';

function truncateTrayText(text, maxLen = 68) {
  const s = String(text || '').trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(1, maxLen - 3))}...`;
}

function hasExceededFaultSnapshot(health) {
  return Boolean(health && health.fault && health.fault.active === true && health.fault.exceeded5s === true);
}

function buildFaultStatusLabel(fault, health) {
  const ver = health?.antigravity?.version ? ` ${health.antigravity.version}` : '';
  const code = fault?.code || '';
  const reason = String(fault?.reason || '').trim();
  const blockedBy = health?.antigravity?.lastRelaunch?.blockedBy || '';
  const relaunchReason = health?.antigravity?.lastRelaunch?.reason || '';

  if (code === 'missing_cdp_switch') {
    if (blockedBy === 'INSIDE_ANTIGRAVITY_SESSION' || relaunchReason === 'INSIDE_ANTIGRAVITY_SESSION' || reason.includes('INSIDE_ANTIGRAVITY_SESSION')) {
      return `⚠️ Antigravity${ver} 未开启 CDP（自动补参被环境变量拦截）`;
    }
    if (relaunchReason === 'AUTO_RELAUNCH_DISABLED' || reason.includes('AUTO_RELAUNCH_DISABLED')) {
      return `⚠️ Antigravity${ver} 未开启 CDP（自动补参已禁用）`;
    }
    return `⚠️ Antigravity${ver} 未开启 CDP（缺少调试端口参数）`;
  }
  if (code === 'relaunch_blocked_or_timeout') {
    if (blockedBy === 'INSIDE_ANTIGRAVITY_SESSION' || reason.includes('INSIDE_ANTIGRAVITY_SESSION')) {
      return `⚠️ Antigravity${ver} 未开启 CDP（自动补参被环境变量拦截）`;
    }
    if (reason.includes('TIMEOUT')) {
      return `⚠️ Antigravity${ver} 自动补参重启超时（${truncateTrayText(reason, 36)}）`;
    }
    return `⚠️ Antigravity${ver} 自动补参重启受阻（${truncateTrayText(reason || '未知原因', 36)}）`;
  }
  if (code === 'cdp_zero_targets') {
    if (!health?.cdp?.reachable) {
      return `⚠️ Antigravity${ver} CDP 端口不可达（0 个可注入目标）`;
    }
    const total = health?.cdp?.targets?.total ?? 0;
    const filtered = health?.cdp?.targets?.filtered?.length ?? 0;
    return `⚠️ Antigravity${ver} CDP 无匹配页面（总计 ${total}，过滤 ${filtered}）`;
  }
  if (code === 'injection_error') {
    return `⚠️ Antigravity${ver} 宿内注入异常（${truncateTrayText(reason || '未知错误', 40)}）`;
  }
  if (code === 'core_anchor_missing') {
    return `⚠️ Antigravity${ver} 核心锚点失效（${truncateTrayText(reason || '未知锚点', 40)}）`;
  }
  return `⚠️ Antigravity${ver} 健康异常（${truncateTrayText(reason || code || '未知原因', 40)}）`;
}

function buildHealthSummaryItem(health) {
  if (!health || typeof health !== 'object') return null;
  const d = health.daemon || {};
  const ag = health.antigravity || {};
  const cdp = health.cdp || {};
  const inj = health.injection || {};
  const anchors = inj.anchors || { total: 14, healthyCount: 0, missingCount: 0, items: [] };
  const plugins = Array.isArray(health.plugins) ? health.plugins : [];
  const fault = health.fault || {};

  const enabledPlugins = plugins.filter((p) => p.enabled !== false);
  const mountedPlugins = enabledPlugins.filter((p) => p.rendererMounted);
  const erroredPlugins = plugins.filter((p) => p.lastError || p.nodeState === 'error');
  const missingNames = Array.isArray(anchors.items)
    ? anchors.items.filter((a) => a.status === 'missing').map((a) => a.name)
    : [];

  const statusTag = fault.active ? (fault.exceeded5s ? '异常(>5s)' : '检测中') : '正常';
  const summaryLabel = `健康摘要：${statusTag} · 锚点 ${anchors.healthyCount ?? 0}/${anchors.total ?? 14} · 插件 ${mountedPlugins.length}/${enabledPlugins.length}`;

  const daemonLine = `Daemon: PID ${d.pid ?? '—'} · Bridge :${d.bridgePort ?? '—'}${d.hasSessionEnvPollution ? ' · 会话污染' : ' · 环境已隔离'}`;
  const agLine = `Antigravity: ${ag.running ? `PID ${ag.pid ?? '—'}` : '未运行'} · ${ag.version || '未知版本'} · CDP ${ag.hasDebugSwitch ? '已开' : '未开'}`;
  const cdpMatched = cdp.targets?.matched?.length ?? 0;
  const cdpFiltered = cdp.targets?.filtered?.length ?? 0;
  const cdpLine = `CDP: 端口 ${cdp.port ?? '—'} · ${cdp.reachable ? '可达' : '不可达'} · 匹配 ${cdpMatched}/过滤 ${cdpFiltered}`;
  const injLine = `锚点探活(${inj.probeSource || 'static'}): ${anchors.healthyCount ?? 0}/${anchors.total ?? 14} 命中${missingNames.length ? ` · 缺失 ${truncateTrayText(missingNames.slice(0, 3).join(','), 32)}` : ''}`;
  const plugLine = `插件(${plugins.length}): 启用 ${enabledPlugins.length} · 挂载 ${mountedPlugins.length}${erroredPlugins.length ? ` · 异常 ${erroredPlugins.length}` : ''}`;

  return {
    id: FAULT_TRAY_MENU_IDS.HEALTH_SUMMARY,
    type: 'submenu',
    label: summaryLabel,
    enabled: true,
    isBuiltin: true,
    tooltip: '查看 Daemon / Antigravity / CDP / 14 锚点 / 插件 5 段健康快照摘要',
    submenu: [
      { id: 'host:health-daemon', type: 'normal', label: daemonLine, enabled: false },
      { id: 'host:health-antigravity', type: 'normal', label: agLine, enabled: false },
      { id: 'host:health-cdp', type: 'normal', label: cdpLine, enabled: false },
      { id: 'host:health-injection', type: 'normal', label: injLine, enabled: false },
      { id: 'host:health-plugins', type: 'normal', label: plugLine, enabled: false }
    ]
  };
}

function computeHealthTraySignature(health) {
  if (!health || typeof health !== 'object') return '';
  const d = health.daemon || {};
  const ag = health.antigravity || {};
  const cdp = health.cdp || {};
  const inj = health.injection || {};
  const fault = health.fault || {};
  const plugins = Array.isArray(health.plugins) ? health.plugins : [];
  const missingAnchors = Array.isArray(inj.anchors?.items)
    ? inj.anchors.items.filter((a) => a.status === 'missing').map((a) => a.name).join(',')
    : '';
  const pluginSig = plugins
    .map((p) => `${p.id}:${p.enabled ? 1 : 0}:${p.nodeState || ''}:${p.rendererMounted ? 1 : 0}:${p.lastError || ''}`)
    .join('|');
  return [
    fault.active ? 1 : 0,
    fault.exceeded5s ? 1 : 0,
    fault.code || '',
    fault.reason || '',
    fault.pid || '',
    d.pid || '',
    d.bridgePort || '',
    d.hasSessionEnvPollution ? 1 : 0,
    ag.running ? 1 : 0,
    ag.pid || '',
    ag.version || '',
    ag.hasDebugSwitch ? 1 : 0,
    ag.lastRelaunch?.status || '',
    ag.lastRelaunch?.reason || '',
    ag.lastRelaunch?.blockedBy || '',
    cdp.port || '',
    cdp.reachable ? 1 : 0,
    cdp.targets?.matched?.length ?? 0,
    cdp.targets?.filtered?.length ?? 0,
    inj.injectedCount ?? 0,
    inj.probeSource || '',
    inj.anchors?.healthyCount ?? 0,
    inj.anchors?.total ?? 14,
    missingAnchors,
    pluginSig
  ].join('::');
}

const DEFAULT_TRAY_ITEMS = Object.freeze([
  Object.freeze({
    id: DEFAULT_TRAY_MENU_IDS.LAUNCH_ANTIGRAVITY,
    label: 'antigravity增强版启动入口',
    type: 'normal',
    group: 'primary',
    order: 100,
    tooltip: '启动或切换至 Antigravity 增强版（自动注入 CDP 插件宿主）'
  }),
  Object.freeze({
    id: DEFAULT_TRAY_MENU_IDS.PLUGIN_SETTINGS,
    label: '插件设置入口',
    type: 'normal',
    group: 'primary',
    order: 200,
    tooltip: '打开 Agy-Daddy 插件管理与设置中心'
  }),
  Object.freeze({
    id: DEFAULT_TRAY_MENU_IDS.RESTART_DAEMON,
    label: '重启守护进程',
    type: 'normal',
    group: 'lifecycle',
    order: 900,
    tooltip: '平滑重启 Agy-Daddy 后台守护进程并重新连接插件'
  }),
  Object.freeze({
    id: DEFAULT_TRAY_MENU_IDS.QUIT,
    label: '退出',
    type: 'normal',
    group: 'lifecycle',
    order: 1000,
    tooltip: '清理后台常驻进程并完全退出 Agy-Daddy Launcher'
  })
]);

const VALID_ITEM_TYPES = new Set(['normal', 'checkbox', 'separator', 'submenu']);
const VALID_POSITION_SLOTS = new Set(['top', 'plugins', 'bottom']);
const MAX_ITEMS_PER_PLUGIN = 20;
const MAX_SUBMENU_DEPTH = 3;

function resolveDefaultTrayIconPath(options = {}) {
  const platform = options.platform || process.platform;
  const assetsDir = options.assetsDir || path.resolve(__dirname, '..', '..', 'assets', 'icons');
  const candidates = platform === 'win32'
    ? [path.join(assetsDir, 'tray-icon.ico'), path.join(assetsDir, 'agy-daddy-launcher.ico'), path.join(assetsDir, 'icon-32.png')]
    : (platform === 'darwin'
      ? [path.join(assetsDir, 'tray-template-36.png'), path.join(assetsDir, 'tray-template-18.png'), path.join(assetsDir, 'icon-32.png')]
      : [path.join(assetsDir, 'icon-32.png'), path.join(assetsDir, 'icon-64.png')]);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

class MemoryTrayBackend {
  constructor() {
    this.started = false;
    this.disposed = false;
    this.lastPayload = null;
    this.updateCount = 0;
    this.clickHandlers = new Set();
    this.errorHandlers = new Set();
  }

  async start(initialOptions = {}) {
    this.started = true;
    this.disposed = false;
    this.lastPayload = {
      type: 'update-menu',
      tooltip: initialOptions.tooltip || 'Agy-Daddy Launcher',
      title: initialOptions.title || '',
      iconPath: initialOptions.iconPath || null,
      isTemplate: initialOptions.isTemplate !== false,
      items: []
    };
    return { ok: true, backend: 'memory' };
  }

  async updateMenu(payload = {}) {
    if (!this.started) return { ok: false, reason: 'NOT_STARTED' };
    this.lastPayload = JSON.parse(JSON.stringify(payload));
    this.updateCount++;
    return { ok: true, updateCount: this.updateCount };
  }

  onClick(fn) {
    if (typeof fn !== 'function') return () => {};
    this.clickHandlers.add(fn);
    return () => this.clickHandlers.delete(fn);
  }

  onError(fn) {
    if (typeof fn !== 'function') return () => {};
    this.errorHandlers.add(fn);
    return () => this.errorHandlers.delete(fn);
  }

  simulateClick(itemId) {
    for (const fn of Array.from(this.clickHandlers)) {
      try { fn(itemId); } catch {}
    }
  }

  async stop() {
    this.started = false;
    this.disposed = true;
    this.clickHandlers.clear();
    this.errorHandlers.clear();
  }
}

const MAC_LSREGISTER_BIN = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

function resolveDefaultMacApplicationsDir() {
  if (isTestMode()) return null;
  try {
    fs.accessSync('/Applications', fs.constants.W_OK);
    return '/Applications';
  } catch {}
  return path.join(os.homedir(), 'Applications');
}

function registerMacAppBundle(bundlePath, action = '-f') {
  if (isTestMode()) return false;
  if (!fs.existsSync(MAC_LSREGISTER_BIN) || !fs.existsSync(bundlePath)) return false;
  try {
    const res = spawnSync(MAC_LSREGISTER_BIN, [action, bundlePath], {
      encoding: 'utf8',
      timeout: 15000
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

function cleanupLegacyStateTrayBundles(stateDir) {
  if (isTestMode() || !stateDir) return;
  const binDir = path.join(stateDir, 'bin');
  if (!fs.existsSync(binDir)) return;
  try {
    for (const entry of fs.readdirSync(binDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!/^Agy-Daddy Tray-.*\.app$/.test(entry.name)) continue;
      const legacyBundle = path.join(binDir, entry.name);
      registerMacAppBundle(legacyBundle, '-u');
      try { fs.rmSync(legacyBundle, { recursive: true, force: true }); } catch {}
    }
  } catch {}
}

function signMacTrayAppBundle(bundlePath, codesignBin) {
  const macOsDir = path.join(bundlePath, 'Contents', 'MacOS');
  const launchScriptPath = path.join(macOsDir, 'launch');
  if (fs.existsSync(launchScriptPath)) {
    try {
      spawnSync(codesignBin, ['--force', '--sign', '-', launchScriptPath], {
        encoding: 'utf8',
        timeout: 15000
      });
    } catch {}
  }
  const res = spawnSync(codesignBin, ['--force', '--sign', '-', '--identifier', 'dev.agy-daddy.launcher', bundlePath], {
    encoding: 'utf8',
    timeout: 15000
  });
  return res.status === 0;
}

function ensureMacTrayAppBundle(options = {}) {
  const swiftSrc = options.swiftSrc || path.join(__dirname, 'tray-backends', 'macos-tray.swift');
  if (!fs.existsSync(swiftSrc)) {
    throw new Error(`Missing macOS tray backend source: ${swiftSrc}`);
  }
  const srcHash = crypto.createHash('sha256').update(fs.readFileSync(swiftSrc)).digest('hex').slice(0, 12);
  const stateDir = options.stateDir || getStateDir(options);
  const macAppsDir = options.bundlePathOverride ? null : resolveDefaultMacApplicationsDir();
  const bundlePath = options.bundlePathOverride
    ? path.resolve(options.bundlePathOverride)
    : macAppsDir
      ? path.join(macAppsDir, 'Agy-Daddy Launcher.app')
      : path.join(stateDir, 'bin', 'Agy-Daddy Launcher.app');

  const contentsDir = path.join(bundlePath, 'Contents');
  const macOsDir = path.join(contentsDir, 'MacOS');
  const resourcesDir = path.join(contentsDir, 'Resources');
  const infoPath = path.join(contentsDir, 'Info.plist');
  const exePath = path.join(macOsDir, 'AgyDaddyTray');
  const hashMarkerPath = path.join(resourcesDir, 'swift-hash.txt');
  const legacyHashMarkerPath = path.join(contentsDir, '.swift-hash');
  const legacyNestedHelperPath = path.join(contentsDir, 'Helpers', 'Agy-Daddy Tray.app');

  const hadLegacyArtifact = fs.existsSync(legacyHashMarkerPath) || fs.existsSync(legacyNestedHelperPath);
  try { if (fs.existsSync(legacyHashMarkerPath)) fs.unlinkSync(legacyHashMarkerPath); } catch {}
  try {
    if (fs.existsSync(legacyNestedHelperPath)) {
      registerMacAppBundle(legacyNestedHelperPath, '-u');
      fs.rmSync(legacyNestedHelperPath, { recursive: true, force: true });
      const helpersDir = path.join(contentsDir, 'Helpers');
      if (fs.existsSync(helpersDir) && fs.readdirSync(helpersDir).length === 0) {
        fs.rmdirSync(helpersDir);
      }
    }
  } catch {}

  const existingHash = fs.existsSync(hashMarkerPath)
    ? String(fs.readFileSync(hashMarkerPath, 'utf8') || '').trim()
    : '';
  const needsCompile = !fs.existsSync(exePath) || existingHash !== srcHash || !fs.existsSync(infoPath);

  const codesignBin = fs.existsSync('/usr/bin/codesign') ? '/usr/bin/codesign' : 'codesign';
  let needsSign = needsCompile || hadLegacyArtifact;
  if (!needsSign && process.platform === 'darwin' && !isTestMode()) {
    try {
      const verify = spawnSync(codesignBin, ['--verify', '--strict', bundlePath], {
        encoding: 'utf8',
        timeout: 15000
      });
      if (verify.status !== 0) {
        needsSign = true;
      }
    } catch {
      needsSign = true;
    }
  }

  if (needsCompile) {
    fs.mkdirSync(macOsDir, { recursive: true });
    fs.mkdirSync(resourcesDir, { recursive: true });

    const lsUiElementXml = options.dockIcon === true
      ? ''
      : '\n  <key>LSUIElement</key><true/>';
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>AgyDaddyTray</string>
  <key>CFBundleIdentifier</key><string>dev.agy-daddy.launcher</string>
  <key>CFBundleName</key><string>Agy-Daddy Launcher</string>
  <key>CFBundleDisplayName</key><string>Agy-Daddy Launcher</string>
  <key>CFBundleIconFile</key><string>AgyDaddyLauncher</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleVersion</key><string>1.0.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>${lsUiElementXml}
</dict>
</plist>
`;
    fs.writeFileSync(infoPath, plist, 'utf8');

    const assetsDir = options.assetsDir || path.resolve(__dirname, '..', '..', 'assets', 'icons');
    for (const fileName of ['AgyDaddyLauncher.icns', 'tray-template-18.png', 'tray-template-36.png']) {
      const src = path.join(assetsDir, fileName);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(resourcesDir, fileName));
      }
    }

    const tmpBin = `${exePath}.tmp-${process.pid}`;
    const swiftcBin = fs.existsSync('/usr/bin/swiftc') ? '/usr/bin/swiftc' : 'swiftc';
    const compile = spawnSync(swiftcBin, ['-O', swiftSrc, '-o', tmpBin], {
      encoding: 'utf8',
      timeout: 60000
    });
    if (compile.status !== 0) {
      try { if (fs.existsSync(tmpBin)) fs.unlinkSync(tmpBin); } catch {}
      throw new Error(`Failed to compile macos-tray.swift: ${String(compile.stderr || compile.stdout || compile.error?.message || '').trim()}`);
    }
    fs.renameSync(tmpBin, exePath);
    fs.chmodSync(exePath, 0o755);
    fs.writeFileSync(hashMarkerPath, srcHash, 'utf8');
  }

  let signed = false;
  if (needsSign && process.platform === 'darwin') {
    try {
      signed = signMacTrayAppBundle(bundlePath, codesignBin);
    } catch {}
  }

  if (!isTestMode() && !options.skipRegister && process.platform === 'darwin') {
    registerMacAppBundle(bundlePath, '-f');
    cleanupLegacyStateTrayBundles(stateDir);
  }

  return { ok: true, bundlePath, exePath, srcHash, compiled: needsCompile, signed };
}

class NativeTrayBackend {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.stateDir = options.stateDir || getStateDir(options);
    this.assetsDir = options.assetsDir;
    this.tooltip = options.tooltip || 'Agy-Daddy Launcher';
    this.title = options.title || '';
    this.iconPath = options.iconPath !== undefined
      ? options.iconPath
      : resolveDefaultTrayIconPath({ platform: this.platform, assetsDir: options.assetsDir });
    this.isTemplate = options.isTemplate !== undefined ? Boolean(options.isTemplate) : (this.platform === 'darwin');
    this.child = null;
    this.rl = null;
    this.socketServer = null;
    this.socketClient = null;
    this.socketPath = null;
    this.helperPid = null;
    this.started = false;
    this.stopping = false;
    this.lastPayload = null;
    this.clickHandlers = new Set();
    this.errorHandlers = new Set();
    this.crashTimestamps = [];
    this.restartTimer = null;
  }

  onClick(fn) {
    if (typeof fn !== 'function') return () => {};
    this.clickHandlers.add(fn);
    return () => this.clickHandlers.delete(fn);
  }

  onError(fn) {
    if (typeof fn !== 'function') return () => {};
    this.errorHandlers.add(fn);
    return () => this.errorHandlers.delete(fn);
  }

  emitError(err) {
    for (const fn of Array.from(this.errorHandlers)) {
      try { fn(err); } catch {}
    }
  }

  resolveMacTrayBundlePath() {
    const swiftSrc = path.join(__dirname, 'tray-backends', 'macos-tray.swift');
    const expectedHash = fs.existsSync(swiftSrc)
      ? crypto.createHash('sha256').update(fs.readFileSync(swiftSrc)).digest('hex').slice(0, 12)
      : '';
    const envApp = String(process.env.AGY_DADDY_TRAY_APP || '').trim();
    if (envApp) {
      const exePath = path.join(envApp, 'Contents', 'MacOS', 'AgyDaddyTray');
      const markerPath = path.join(envApp, 'Contents', 'Resources', 'swift-hash.txt');
      const legacyMarkerPath = path.join(envApp, 'Contents', '.swift-hash');
      const markerHash = fs.existsSync(markerPath) ? String(fs.readFileSync(markerPath, 'utf8') || '').trim() : '';
      if (fs.existsSync(exePath) && !fs.existsSync(legacyMarkerPath) && (!expectedHash || markerHash === expectedHash)) {
        return envApp;
      }
    }
    return ensureMacTrayAppBundle({
      stateDir: this.stateDir,
      swiftSrc,
      assetsDir: this.assetsDir
    }).bundlePath;
  }

  resolveHelperInvocation() {
    const backendsDir = path.join(__dirname, 'tray-backends');
    if (this.platform === 'win32') {
      const psScript = path.join(backendsDir, 'win32-tray.ps1');
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', psScript, '-Tooltip', this.tooltip];
      if (this.iconPath) args.push('-IconPath', this.iconPath);
      return { cmd: 'powershell.exe', args };
    }

    const pyScript = path.join(backendsDir, 'linux-tray.py');
    const args = [pyScript, '--tooltip', this.tooltip];
    if (this.iconPath) args.push('--icon', this.iconPath);
    return { cmd: 'python3', args };
  }

  handleIncomingLine(line, onReady) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (msg.type === 'ready') {
      if (Number.isInteger(Number(msg.pid)) && Number(msg.pid) > 0) {
        this.helperPid = Number(msg.pid);
      }
      onReady(msg);
      return;
    }
    if (msg.type === 'click' && msg.itemId) {
      for (const fn of Array.from(this.clickHandlers)) {
        try { fn(String(msg.itemId)); } catch {}
      }
    }
  }

  cleanupMacSocket() {
    if (this.rl) {
      try { this.rl.close(); } catch {}
      this.rl = null;
    }
    if (this.socketClient) {
      try { this.socketClient.destroy(); } catch {}
      this.socketClient = null;
    }
    if (this.socketServer) {
      try { this.socketServer.close(); } catch {}
      this.socketServer = null;
    }
    if (this.socketPath) {
      try { if (fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath); } catch {}
      this.socketPath = null;
    }
  }

  async spawnMacAppChild() {
    this.cleanupMacSocket();
    const bundlePath = this.resolveMacTrayBundlePath();
    const rawTmp = os.tmpdir();
    const sockDir = rawTmp.length <= 65 ? rawTmp : '/tmp';
    const socketPath = path.join(sockDir, `agy-tray-${process.pid}-${crypto.randomBytes(4).toString('hex')}.sock`);
    try { if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath); } catch {}
    this.socketPath = socketPath;

    let readyResolved = false;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!readyResolved) {
          readyResolved = true;
          reject(new Error(`Timed out waiting for Agy-Daddy Tray app socket ready (${socketPath})`));
        }
      }, 8000);
      if (typeof timer.unref === 'function') timer.unref();

      const server = net.createServer((sock) => {
        if (this.socketClient && !this.socketClient.destroyed) {
          try { sock.destroy(); } catch {}
          return;
        }
        this.socketClient = sock;
        const rl = readline.createInterface({ input: sock, crlfDelay: Infinity });
        this.rl = rl;
        rl.on('error', () => {});

        rl.on('line', (line) => {
          this.handleIncomingLine(line, () => {
            if (!readyResolved) {
              readyResolved = true;
              clearTimeout(timer);
              resolve({ ready: true });
            }
          });
        });

        sock.on('error', (err) => {
          if (!readyResolved) {
            readyResolved = true;
            clearTimeout(timer);
            reject(err);
          } else if (!this.stopping) {
            this.emitError(err);
          }
        });

        sock.on('close', () => {
          if (!readyResolved) {
            readyResolved = true;
            clearTimeout(timer);
            reject(new Error('Tray app socket closed before ready'));
            return;
          }
          if (!this.stopping && this.started) {
            this.scheduleRestart(new Error('Tray app socket disconnected unexpectedly'));
          }
        });
      });

      this.socketServer = server;
      server.once('error', (err) => {
        if (!readyResolved) {
          readyResolved = true;
          clearTimeout(timer);
          reject(err);
        } else {
          this.emitError(err);
        }
      });

      server.listen(socketPath, () => {
        try { fs.chmodSync(socketPath, 0o600); } catch {}
        const openBin = fs.existsSync('/usr/bin/open') ? '/usr/bin/open' : 'open';
        const args = [
          '-n',
          '-g',
          bundlePath,
          '--args',
          '--socket', socketPath,
          '--parent-pid', String(process.pid),
          '--tooltip', this.tooltip
        ];
        if (this.iconPath) {
          args.push('--icon', this.iconPath);
        }
        const launcherProc = spawn(openBin, args, { stdio: 'ignore' });
        launcherProc.once('error', (err) => {
          if (!readyResolved) {
            readyResolved = true;
            clearTimeout(timer);
            reject(err);
          }
        });
        launcherProc.unref();
      });
    });

    if (this.lastPayload) {
      await this.updateMenu(this.lastPayload);
    }
  }

  async spawnChild() {
    if (this.platform === 'darwin') {
      await this.spawnMacAppChild();
      return;
    }

    const spec = this.resolveHelperInvocation();
    const child = spawn(spec.cmd, spec.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.child = child;

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.rl = rl;
    rl.on('error', () => {});

    let readyResolved = false;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!readyResolved) {
          readyResolved = true;
          resolve({ timedOut: true });
        }
      }, 4000);
      if (typeof timer.unref === 'function') timer.unref();

      rl.on('line', (line) => {
        this.handleIncomingLine(line, () => {
          if (!readyResolved) {
            readyResolved = true;
            clearTimeout(timer);
            resolve({ ready: true });
          }
        });
      });

      child.once('error', (err) => {
        if (!readyResolved) {
          readyResolved = true;
          clearTimeout(timer);
          reject(err);
        } else {
          this.emitError(err);
        }
      });

      child.once('exit', (code, signal) => {
        if (!readyResolved) {
          readyResolved = true;
          clearTimeout(timer);
          reject(new Error(`Tray helper exited before ready (code=${code}, signal=${signal})`));
          return;
        }
        if (!this.stopping && this.started) {
          this.scheduleRestart(new Error(`Tray helper exited unexpectedly (code=${code}, signal=${signal})`));
        }
      });
    });

    if (this.lastPayload) {
      await this.updateMenu(this.lastPayload);
    }
  }

  scheduleRestart(err) {
    this.emitError(err);
    const now = Date.now();
    this.crashTimestamps = this.crashTimestamps.filter((ts) => now - ts < 60000);
    this.crashTimestamps.push(now);
    if (this.crashTimestamps.length > 5) {
      this.emitError(new Error('Tray helper crash limit reached (5 crashes in 60s); stopping auto-restart'));
      return;
    }
    const backoffMs = Math.min(8000, 300 * Math.pow(2, this.crashTimestamps.length - 1));
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping && this.started) {
        void this.spawnChild().catch((e) => this.emitError(e));
      }
    }, backoffMs);
    if (typeof this.restartTimer.unref === 'function') this.restartTimer.unref();
  }

  async start(initialOptions = {}) {
    if (this.started && ((this.socketClient && !this.socketClient.destroyed) || (this.child && !this.child.killed))) {
      return { ok: true, backend: 'native', alreadyStarted: true };
    }
    if (initialOptions.tooltip) this.tooltip = initialOptions.tooltip;
    if (initialOptions.title !== undefined) this.title = String(initialOptions.title || '');
    if (initialOptions.iconPath !== undefined) this.iconPath = initialOptions.iconPath;
    if (initialOptions.isTemplate !== undefined) this.isTemplate = Boolean(initialOptions.isTemplate);

    this.stopping = false;
    this.started = true;
    await this.spawnChild();
    return { ok: true, backend: 'native', platform: this.platform };
  }

  async updateMenu(payload = {}) {
    this.lastPayload = payload;
    const msg = {
      type: 'update-menu',
      tooltip: payload.tooltip || this.tooltip,
      title: payload.title !== undefined ? String(payload.title || '') : this.title,
      iconPath: payload.iconPath !== undefined ? payload.iconPath : this.iconPath,
      isTemplate: payload.isTemplate !== undefined ? Boolean(payload.isTemplate) : this.isTemplate,
      items: Array.isArray(payload.items) ? payload.items : []
    };
    const line = `${JSON.stringify(msg)}\n`;

    if (this.platform === 'darwin') {
      if (!this.started || !this.socketClient || this.socketClient.destroyed || !this.socketClient.writable) {
        return { ok: false, reason: 'NOT_CONNECTED' };
      }
      try {
        this.socketClient.write(line, 'utf8');
        return { ok: true };
      } catch (err) {
        this.emitError(err);
        return { ok: false, error: err?.message || String(err) };
      }
    }

    if (!this.started || !this.child || !this.child.stdin || this.child.stdin.destroyed) {
      return { ok: false, reason: 'NOT_CONNECTED' };
    }
    try {
      this.child.stdin.write(line, 'utf8');
      return { ok: true };
    } catch (err) {
      this.emitError(err);
      return { ok: false, error: err?.message || String(err) };
    }
  }

  async stop() {
    this.stopping = true;
    this.started = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.platform === 'darwin') {
      const sock = this.socketClient;
      const pid = this.helperPid;
      this.helperPid = null;
      if (sock && !sock.destroyed && sock.writable) {
        try {
          sock.write('{"type":"quit"}\n');
          sock.end();
        } catch {}
      }
      if (pid) {
        await new Promise((resolve) => {
          const deadline = Date.now() + 600;
          const check = () => {
            try {
              process.kill(pid, 0);
            } catch {
              resolve();
              return;
            }
            if (Date.now() >= deadline) {
              try { process.kill(pid, 'SIGTERM'); } catch {}
              resolve();
              return;
            }
            setTimeout(check, 40);
          };
          check();
        });
      }
      this.cleanupMacSocket();
      this.clickHandlers.clear();
      this.errorHandlers.clear();
      return;
    }

    if (this.rl) {
      try { this.rl.close(); } catch {}
      this.rl = null;
    }
    const child = this.child;
    this.child = null;
    if (child && !child.killed) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
          resolve();
        }, 1200);
        if (typeof timer.unref === 'function') timer.unref();
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        try {
          if (child.stdin && !child.stdin.destroyed) {
            child.stdin.write('{"type":"quit"}\n');
            child.stdin.end();
          } else {
            child.kill('SIGTERM');
          }
        } catch {
          try { child.kill('SIGTERM'); } catch {}
        }
      });
    }
    this.clickHandlers.clear();
    this.errorHandlers.clear();
  }
}

function validateSafeIcon(rawIcon, pluginDir) {
  if (rawIcon === undefined || rawIcon === null || rawIcon === '') return null;
  if (typeof rawIcon !== 'string') {
    throw new Error('Tray menu item icon must be a string');
  }
  const trimmed = rawIcon.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('data:image/')) return trimmed;
  // Short glyph / emoji symbol
  if (!trimmed.includes('/') && !trimmed.includes('\\') && !trimmed.includes('..') && trimmed.length <= 6) {
    return trimmed;
  }
  if (path.isAbsolute(trimmed)) {
    return trimmed;
  }
  if (trimmed.includes('..')) {
    throw new Error(`TRAY_ICON_PATH_TRAVERSAL: unsafe relative icon path "${trimmed}"`);
  }
  if (pluginDir) {
    const rootAbs = path.resolve(pluginDir);
    const resolved = path.resolve(rootAbs, trimmed);
    const prefix = rootAbs.endsWith(path.sep) ? rootAbs : `${rootAbs}${path.sep}`;
    if (resolved !== rootAbs && !resolved.startsWith(prefix)) {
      throw new Error(`TRAY_ICON_PATH_TRAVERSAL: icon escapes plugin directory "${trimmed}"`);
    }
    return resolved;
  }
  return trimmed;
}

function cloneWithDescriptors(obj) {
  if (!obj || typeof obj !== 'object') return {};
  return Object.defineProperties({}, Object.getOwnPropertyDescriptors(obj));
}

function mergeDescriptors(target, patch) {
  const next = cloneWithDescriptors(target);
  if (patch && typeof patch === 'object') {
    Object.defineProperties(next, Object.getOwnPropertyDescriptors(patch));
  }
  return next;
}

function validatePosition(pos) {
  if (pos === undefined || pos === null) return 'plugins';
  if (typeof pos === 'string') {
    if (VALID_POSITION_SLOTS.has(pos)) return pos;
    throw new Error(`Invalid tray menu position: ${pos}`);
  }
  if (typeof pos === 'object' && !Array.isArray(pos)) {
    if (typeof pos.before === 'string' && pos.before.trim()) return { before: pos.before.trim() };
    if (typeof pos.after === 'string' && pos.after.trim()) return { after: pos.after.trim() };
  }
  throw new Error('Tray menu position must be "top", "plugins", "bottom", { before }, or { after }');
}

function getSafeDescriptorValue(obj, key, fallback) {
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  if (!desc) return fallback;
  if ('value' in desc) return desc.value;
  if (typeof desc.get === 'function') {
    return desc.get.call(obj);
  }
  return fallback;
}

class TrayManager {
  constructor(options = {}) {
    this.options = options;
    this.appName = options.appName || 'Agy-Daddy Launcher';
    this.stateDir = options.stateDir || getStateDir(options);
    this.bus = options.bus || null;
    this.recordFailure = typeof options.recordFailure === 'function' ? options.recordFailure : null;
    this.executeCommand = typeof options.executeCommand === 'function' ? options.executeCommand : null;

    this.onLaunchAntigravity = typeof options.onLaunchAntigravity === 'function' ? options.onLaunchAntigravity : null;
    this.onRelaunchAntigravity = typeof options.onRelaunchAntigravity === 'function' ? options.onRelaunchAntigravity : null;
    this.onOpenDiagnostics = typeof options.onOpenDiagnostics === 'function' ? options.onOpenDiagnostics : null;
    this.onOpenPluginSettings = typeof options.onOpenPluginSettings === 'function' ? options.onOpenPluginSettings : null;
    this.onRestartDaemon = typeof options.onRestartDaemon === 'function' ? options.onRestartDaemon : null;
    this.onQuit = typeof options.onQuit === 'function' ? options.onQuit : null;

    this.callbackTimeoutMs = Number(options.callbackTimeoutMs) > 0 ? Number(options.callbackTimeoutMs) : 10000;
    this.maxFailuresPerItem = Number(options.maxFailuresPerItem) > 0 ? Number(options.maxFailuresPerItem) : 3;
    this.maxItemsPerPlugin = Number(options.maxItemsPerPlugin) > 0 ? Number(options.maxItemsPerPlugin) : MAX_ITEMS_PER_PLUGIN;

    this.backend = options.backend || (
      isTestMode() || options.headless
        ? new MemoryTrayBackend()
        : new NativeTrayBackend({
            stateDir: this.stateDir,
            tooltip: this.appName,
            iconPath: options.iconPath,
            assetsDir: options.assetsDir
          })
    );

    this.pluginItems = new Map(); // fullId -> record
    this.itemErrors = new Map();  // fullId -> errorRecord
    this.clickTargets = new Map(); // fullId -> { pluginId, record, def }
    this.seqCounter = 0;
    this.started = false;
    this.managed = false;
    this.visible = true;
    this.desiredVisible = true;
    this.faultOverride = false;
    this._forceStartRequested = false;
    this.hostHealth = null;
    this._lastHealthSignature = '';
    this._visibilityChain = Promise.resolve();
    this.refreshTimer = null;
    this.unsubBackendClick = null;
    this.unsubBackendError = null;
    this.lastSnapshot = [];
  }

  setActionHandlers(handlers = {}) {
    if (typeof handlers.onLaunchAntigravity === 'function') this.onLaunchAntigravity = handlers.onLaunchAntigravity;
    if (typeof handlers.onRelaunchAntigravity === 'function') this.onRelaunchAntigravity = handlers.onRelaunchAntigravity;
    if (typeof handlers.onOpenDiagnostics === 'function') this.onOpenDiagnostics = handlers.onOpenDiagnostics;
    if (typeof handlers.onOpenPluginSettings === 'function') this.onOpenPluginSettings = handlers.onOpenPluginSettings;
    if (typeof handlers.onRestartDaemon === 'function') this.onRestartDaemon = handlers.onRestartDaemon;
    if (typeof handlers.onQuit === 'function') this.onQuit = handlers.onQuit;
    if (typeof handlers.executeCommand === 'function') this.executeCommand = handlers.executeCommand;
  }

  hasExceededFault(health = this.hostHealth) {
    return hasExceededFaultSnapshot(health);
  }

  getTrayPresentation() {
    if (this.hasExceededFault()) {
      const statusLabel = buildFaultStatusLabel(this.hostHealth.fault, this.hostHealth);
      return {
        title: ALERT_TRAY_TITLE,
        tooltip: statusLabel
      };
    }
    return {
      title: '',
      tooltip: this.appName
    };
  }

  async _startInternal() {
    if (this.started) {
      return { ok: true, alreadyStarted: true };
    }
    this.unsubBackendClick = this.backend.onClick((itemId) => {
      void this.handleMenuClick(itemId);
    });
    if (typeof this.backend.onError === 'function') {
      this.unsubBackendError = this.backend.onError((err) => {
        if (this.bus) {
          try {
            this.bus.emitEvent('agy-daddy.host', 'tray:backend-error@1', {
              message: err?.message || String(err),
              at: Date.now()
            });
          } catch {}
        }
      });
    }
    const presentation = this.getTrayPresentation();
    const res = await this.backend.start({
      tooltip: presentation.tooltip,
      title: presentation.title,
      iconPath: this.options.iconPath !== undefined
        ? this.options.iconPath
        : resolveDefaultTrayIconPath({ assetsDir: this.options.assetsDir })
    });
    this.started = true;
    await this.refreshMenu(true);
    return res;
  }

  async start() {
    this.managed = true;
    this.desiredVisible = true;
    this.visible = true;
    return await this._startInternal();
  }

  async _applyVisibilityState() {
    const effectiveVisible = Boolean(this.desiredVisible || this.faultOverride);
    this.visible = effectiveVisible;
    if (!effectiveVisible) {
      if (this.started) {
        await this.stop();
      }
      return { ok: true, visible: false, started: false, faultOverride: false };
    }
    if (!this.started && (this.managed || this._forceStartRequested)) {
      await this._startInternal();
    } else if (this.started) {
      await this.refreshMenu(true);
    }
    return { ok: true, visible: true, started: Boolean(this.started), faultOverride: this.faultOverride };
  }

  async setVisible(visible, opts = {}) {
    const run = async () => {
      this.desiredVisible = Boolean(visible);
      if (opts.forceStart) this._forceStartRequested = true;
      try {
        return await this._applyVisibilityState();
      } finally {
        this._forceStartRequested = false;
      }
    };
    const next = this._visibilityChain.then(run, run);
    this._visibilityChain = next.catch(() => {});
    return next;
  }

  async applyHostHealth(snapshot) {
    const nextHealth = snapshot && typeof snapshot === 'object' ? snapshot : null;
    const nextExceeded = hasExceededFaultSnapshot(nextHealth);
    const nextSig = nextHealth ? computeHealthTraySignature(nextHealth) : '';
    const changed = nextSig !== this._lastHealthSignature || nextExceeded !== this.faultOverride;
    this.hostHealth = nextHealth;
    this._lastHealthSignature = nextSig;
    if (!changed) {
      return { ok: true, changed: false, visible: this.visible, faultOverride: this.faultOverride };
    }
    const run = async () => {
      this.faultOverride = nextExceeded;
      if (this.managed) {
        const res = await this._applyVisibilityState();
        return { ...res, changed: true };
      }
      const items = this.buildMenuModel();
      this.lastSnapshot = items;
      if (this.started) {
        await this.refreshMenu(true);
      }
      return { ok: true, changed: true, visible: this.visible, faultOverride: this.faultOverride };
    };
    const next = this._visibilityChain.then(run, run);
    this._visibilityChain = next.catch(() => {});
    return next;
  }

  async stop() {
    this.started = false;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.unsubBackendClick) {
      try { this.unsubBackendClick(); } catch {}
      this.unsubBackendClick = null;
    }
    if (this.unsubBackendError) {
      try { this.unsubBackendError(); } catch {}
      this.unsubBackendError = null;
    }
    await this.backend.stop();
  }

  async dispose() {
    this.managed = false;
    this.desiredVisible = true;
    this.faultOverride = false;
    this.hostHealth = null;
    this._lastHealthSignature = '';
    await this.stop();
    this.pluginItems.clear();
    this.itemErrors.clear();
    this.clickTargets.clear();
    this.lastSnapshot = [];
  }

  recordItemError(pluginId, fullId, phase, err) {
    const prev = this.itemErrors.get(fullId) || {
      pluginId,
      fullId,
      consecutiveFailures: 0,
      totalFailures: 0,
      circuitOpen: false
    };
    const nextFailures = prev.consecutiveFailures + 1;
    const circuitOpen = phase === 'render' ? true : nextFailures >= this.maxFailuresPerItem;
    const entry = {
      pluginId,
      fullId,
      phase,
      message: err?.message || String(err),
      consecutiveFailures: nextFailures,
      totalFailures: prev.totalFailures + 1,
      circuitOpen,
      lastErrorAt: Date.now()
    };
    this.itemErrors.set(fullId, entry);

    const rec = this.pluginItems.get(fullId);
    if (rec && circuitOpen) {
      rec.faulted = true;
    }
    if (this.recordFailure && pluginId) {
      try { this.recordFailure(pluginId, err); } catch {}
    }
    if (this.bus) {
      try {
        this.bus.emitEvent('agy-daddy.host', 'tray:item-error@1', { ...entry });
      } catch {}
    }
    return entry;
  }

  validateAndNormalizeDef(pluginId, rawDef, pluginDir, isSubmenu = false) {
    if (!rawDef || typeof rawDef !== 'object' || Array.isArray(rawDef)) {
      throw new Error('Tray menu item definition must be an object');
    }
    const localId = getSafeDescriptorValue(rawDef, 'id', '');
    if (typeof localId !== 'string' || !localId.trim()) {
      throw new Error('Tray menu item id must be a non-empty string');
    }
    const cleanLocalId = localId.trim();
    const typeDesc = Object.getOwnPropertyDescriptor(rawDef, 'type');
    const rawType = typeDesc && 'value' in typeDesc ? (typeDesc.value ?? 'normal') : 'normal';
    if (typeof rawType !== 'string' || !VALID_ITEM_TYPES.has(rawType)) {
      throw new Error(`Invalid tray menu item type: ${String(rawType)}`);
    }
    const iconDesc = Object.getOwnPropertyDescriptor(rawDef, 'icon');
    const rawIcon = iconDesc && 'value' in iconDesc ? iconDesc.value : undefined;
    const safeIcon = validateSafeIcon(rawIcon, pluginDir);

    const posDesc = Object.getOwnPropertyDescriptor(rawDef, 'position');
    const rawPos = posDesc && 'value' in posDesc ? posDesc.value : undefined;
    const position = isSubmenu ? 'plugins' : validatePosition(rawPos);

    const fullId = cleanLocalId.startsWith(`${pluginId}:`) ? cleanLocalId : `${pluginId}:${cleanLocalId}`;
    const stored = cloneWithDescriptors(rawDef);
    stored.id = cleanLocalId;
    if (safeIcon !== null) stored.icon = safeIcon;

    return {
      localId: cleanLocalId,
      fullId,
      type: rawType,
      position,
      stored
    };
  }

  registerPluginMenuItem(pluginId, def, opts = {}) {
    const cleanPluginId = String(pluginId || '').trim();
    if (!cleanPluginId) throw new Error('pluginId is required');
    const pluginDir = opts.pluginDir || null;

    let countForPlugin = 0;
    for (const rec of this.pluginItems.values()) {
      if (rec.pluginId === cleanPluginId) countForPlugin++;
    }

    const parsed = this.validateAndNormalizeDef(cleanPluginId, def, pluginDir, false);
    if (!this.pluginItems.has(parsed.fullId) && countForPlugin >= this.maxItemsPerPlugin) {
      throw new Error(`TRAY_ITEM_LIMIT_EXCEEDED: ${cleanPluginId} exceeded max ${this.maxItemsPerPlugin} tray items`);
    }

    const existing = this.pluginItems.get(parsed.fullId);
    const record = {
      pluginId: cleanPluginId,
      pluginDir,
      localId: parsed.localId,
      fullId: parsed.fullId,
      position: parsed.position,
      seq: existing ? existing.seq : ++this.seqCounter,
      faulted: false,
      def: parsed.stored,
      executeCommand: opts.executeCommand || this.executeCommand
    };
    this.pluginItems.set(parsed.fullId, record);
    this.itemErrors.delete(parsed.fullId);
    this.scheduleRefresh();

    const manager = this;
    return {
      id: record.localId,
      fullId: record.fullId,
      update(patch) {
        return manager.updatePluginMenuItem(cleanPluginId, record.localId, patch);
      },
      dispose() {
        return manager.unregisterPluginMenuItem(cleanPluginId, record.localId);
      }
    };
  }

  resolvePluginFullId(pluginId, itemId) {
    const raw = String(itemId || '').trim();
    if (!raw) return '';
    return raw.startsWith(`${pluginId}:`) ? raw : `${pluginId}:${raw}`;
  }

  updatePluginMenuItem(pluginId, itemId, patch) {
    const fullId = this.resolvePluginFullId(pluginId, itemId);
    const rec = this.pluginItems.get(fullId);
    if (!rec || rec.pluginId !== pluginId) return false;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('Tray menu item patch must be an object');
    }

    const merged = mergeDescriptors(rec.def, patch);
    merged.id = rec.localId;
    const iconDesc = Object.getOwnPropertyDescriptor(patch, 'icon');
    if (iconDesc && 'value' in iconDesc) {
      const safeIcon = validateSafeIcon(iconDesc.value, rec.pluginDir);
      if (safeIcon === null) delete merged.icon;
      else merged.icon = safeIcon;
    }
    const posDesc = Object.getOwnPropertyDescriptor(patch, 'position');
    if (posDesc && 'value' in posDesc) {
      rec.position = validatePosition(posDesc.value);
    }
    rec.def = merged;
    if (patch.faulted === false) {
      rec.faulted = false;
      this.itemErrors.delete(fullId);
    }
    this.scheduleRefresh();
    return true;
  }

  unregisterPluginMenuItem(pluginId, itemId) {
    const fullId = this.resolvePluginFullId(pluginId, itemId);
    const rec = this.pluginItems.get(fullId);
    if (!rec || rec.pluginId !== pluginId) return false;
    this.pluginItems.delete(fullId);
    this.itemErrors.delete(fullId);
    this.scheduleRefresh();
    return true;
  }

  unregisterPluginItems(pluginId) {
    let removed = 0;
    for (const [fullId, rec] of Array.from(this.pluginItems.entries())) {
      if (rec.pluginId === pluginId) {
        this.pluginItems.delete(fullId);
        this.itemErrors.delete(fullId);
        removed++;
      }
    }
    if (removed > 0) this.scheduleRefresh();
    return removed;
  }

  registerManifestContributions(pluginId, manifest, opts = {}) {
    const items = manifest?.contributes?.['tray.menu'];
    if (!Array.isArray(items) || items.length === 0) return [];
    const handles = [];
    for (const item of items) {
      try {
        handles.push(this.registerPluginMenuItem(pluginId, item, opts));
      } catch (err) {
        this.recordItemError(pluginId, `${pluginId}:${item?.id || 'manifest'}`, 'register', err);
      }
    }
    return handles;
  }

  listPluginMenuItems(pluginId) {
    const out = [];
    for (const rec of this.pluginItems.values()) {
      if (pluginId && rec.pluginId !== pluginId) continue;
      const err = this.itemErrors.get(rec.fullId) || null;
      let label = rec.localId;
      let type = 'normal';
      let enabled = !rec.faulted;
      let order = 500;
      try {
        label = String(getSafeDescriptorValue(rec.def, 'label', rec.localId));
        type = String(getSafeDescriptorValue(rec.def, 'type', 'normal'));
        enabled = !rec.faulted && getSafeDescriptorValue(rec.def, 'enabled', true) !== false;
        const rawOrder = getSafeDescriptorValue(rec.def, 'order', getSafeDescriptorValue(rec.def, 'weight', 500));
        order = Number.isFinite(Number(rawOrder)) ? Number(rawOrder) : 500;
      } catch {}
      out.push({
        id: rec.localId,
        fullId: rec.fullId,
        pluginId: rec.pluginId,
        type,
        label,
        enabled,
        order,
        position: rec.position,
        faulted: Boolean(rec.faulted),
        error: err
      });
    }
    return out;
  }

  createScopedApi(pluginId, opts = {}) {
    const manager = this;
    return {
      registerMenuItem(def) {
        return manager.registerPluginMenuItem(pluginId, def, opts);
      },
      updateMenuItem(itemId, patch) {
        return manager.updatePluginMenuItem(pluginId, itemId, patch);
      },
      unregisterMenuItem(itemId) {
        return manager.unregisterPluginMenuItem(pluginId, itemId);
      },
      listMenuItems() {
        return manager.listPluginMenuItems(pluginId);
      }
    };
  }

  evaluateMenuItem(rec, defObj, depth = 0, nextClickTargets = null) {
    const parentId = rec.fullId;
    const rawId = getSafeDescriptorValue(defObj, 'id', rec.localId);
    const cleanSubId = String(rawId || rec.localId).trim();
    const itemFullId = depth === 0
      ? rec.fullId
      : (cleanSubId.startsWith(`${rec.pluginId}:`) ? cleanSubId : `${rec.pluginId}:${cleanSubId}`);

    const rawType = String(getSafeDescriptorValue(defObj, 'type', 'normal') || 'normal');
    const type = VALID_ITEM_TYPES.has(rawType) ? rawType : 'normal';
    const visible = getSafeDescriptorValue(defObj, 'visible', true);
    if (visible === false) return null;

    if (type === 'separator') {
      const orderVal = Number(getSafeDescriptorValue(defObj, 'order', getSafeDescriptorValue(defObj, 'weight', 500)));
      return {
        id: itemFullId,
        type: 'separator',
        pluginId: rec.pluginId,
        order: Number.isFinite(orderVal) ? orderVal : 500,
        seq: rec.seq
      };
    }

    const rawLabel = getSafeDescriptorValue(defObj, 'label', cleanSubId);
    if (typeof rawLabel !== 'string' || !rawLabel.trim()) {
      throw new Error(`Invalid tray item label for ${itemFullId}`);
    }
    const rawIcon = getSafeDescriptorValue(defObj, 'icon', null);
    const safeIcon = rawIcon ? validateSafeIcon(rawIcon, rec.pluginDir) : null;
    const tooltip = getSafeDescriptorValue(defObj, 'tooltip', undefined);
    const enabled = !rec.faulted && getSafeDescriptorValue(defObj, 'enabled', true) !== false;
    const checked = Boolean(getSafeDescriptorValue(defObj, 'checked', false));
    const rawOrder = getSafeDescriptorValue(defObj, 'order', getSafeDescriptorValue(defObj, 'weight', 500));
    const order = Number.isFinite(Number(rawOrder)) ? Number(rawOrder) : 500;

    let submenu = undefined;
    if (type === 'submenu') {
      if (depth >= MAX_SUBMENU_DEPTH) {
        throw new Error(`Submenu depth exceeded max (${MAX_SUBMENU_DEPTH}) for ${itemFullId}`);
      }
      const rawChildren = getSafeDescriptorValue(defObj, 'submenu', []);
      if (!Array.isArray(rawChildren)) {
        throw new Error(`submenu must be an array for ${itemFullId}`);
      }
      submenu = [];
      for (const childDef of rawChildren) {
        const evaluatedChild = this.evaluateMenuItem(rec, childDef, depth + 1, nextClickTargets);
        if (evaluatedChild) submenu.push(evaluatedChild);
      }
      submenu.sort((a, b) => (a.order - b.order) || ((a.seq || 0) - (b.seq || 0)));
    }

    if (nextClickTargets && type !== 'submenu') {
      nextClickTargets.set(itemFullId, {
        pluginId: rec.pluginId,
        rootFullId: parentId,
        record: rec,
        def: defObj
      });
    }

    return {
      id: itemFullId,
      pluginId: rec.pluginId,
      type,
      label: rawLabel.trim(),
      ...(safeIcon ? { icon: safeIcon } : {}),
      ...(typeof tooltip === 'string' && tooltip.trim() ? { tooltip: tooltip.trim() } : {}),
      enabled,
      ...(type === 'checkbox' ? { checked } : {}),
      ...(submenu ? { submenu } : {}),
      order,
      seq: rec.seq
    };
  }

  buildMenuModel() {
    const defaultTopBuiltIns = DEFAULT_TRAY_ITEMS
      .filter((d) => d.group === 'primary')
      .map((d, idx) => ({ ...d, seq: idx + 1, isBuiltin: true }));
    const defaultBottomBuiltIns = DEFAULT_TRAY_ITEMS
      .filter((d) => d.group === 'lifecycle')
      .map((d, idx) => ({ ...d, seq: idx + 100, isBuiltin: true }));

    try {
      const faultGroup = [];
      if (this.hasExceededFault()) {
        const fault = this.hostHealth.fault;
        const faultLabel = buildFaultStatusLabel(fault, this.hostHealth);
        faultGroup.push(
          {
            id: FAULT_TRAY_MENU_IDS.FAULT_STATUS,
            type: 'normal',
            label: faultLabel,
            enabled: false,
            isBuiltin: true,
            order: 1,
            seq: 1,
            tooltip: fault?.reason ? `${faultLabel} — ${fault.reason}` : faultLabel
          },
          {
            id: FAULT_TRAY_MENU_IDS.RELAUNCH_ANTIGRAVITY,
            type: 'normal',
            label: '一键补参重启 Antigravity',
            enabled: true,
            isBuiltin: true,
            order: 2,
            seq: 2,
            tooltip: '使用 --remote-debugging-port=0 重启 Antigravity 并重新注入插件宿主'
          },
          {
            id: FAULT_TRAY_MENU_IDS.OPEN_DIAGNOSTICS,
            type: 'normal',
            label: '打开独立诊断面板（浏览器）',
            enabled: true,
            isBuiltin: true,
            order: 3,
            seq: 3,
            tooltip: '在系统默认浏览器中打开常驻 Daemon 独立诊断页（不依赖 Antigravity UI）'
          }
        );
      }

      const nextClickTargets = new Map();
      const buckets = {
        top: [],
        primary: [...defaultTopBuiltIns],
        plugins: [],
        bottom: [],
        lifecycle: [...defaultBottomBuiltIns]
      };
      if (this.hostHealth) {
        if (!this.hasExceededFault()) {
          buckets.primary.push({
            id: FAULT_TRAY_MENU_IDS.OPEN_DIAGNOSTICS,
            type: 'normal',
            label: '打开独立诊断面板（浏览器）',
            group: 'primary',
            order: 250,
            seq: 50,
            isBuiltin: true,
            tooltip: '在系统默认浏览器中打开常驻 Daemon 独立诊断页（不依赖 Antigravity UI）'
          });
        }
        const summaryItem = buildHealthSummaryItem(this.hostHealth);
        if (summaryItem) {
          buckets.primary.push({ ...summaryItem, group: 'primary', order: 260, seq: 60 });
        }
      }
      const anchored = [];

      for (const rec of this.pluginItems.values()) {
        if (rec.faulted) continue;
        try {
          const item = this.evaluateMenuItem(rec, rec.def, 0, nextClickTargets);
          if (!item) continue;
          if (typeof rec.position === 'string') {
            if (rec.position === 'top') buckets.top.push(item);
            else if (rec.position === 'bottom') buckets.bottom.push(item);
            else buckets.plugins.push(item);
          } else if (rec.position && typeof rec.position === 'object') {
            anchored.push({ item, position: rec.position });
          } else {
            buckets.plugins.push(item);
          }
        } catch (err) {
          this.recordItemError(rec.pluginId, rec.fullId, 'render', err);
        }
      }

      const byOrder = (a, b) => (a.order - b.order) || ((a.seq || 0) - (b.seq || 0));
      for (const key of Object.keys(buckets)) {
        buckets[key].sort(byOrder);
      }

      const assembleSection = (arr) => arr.slice();
      const orderedGroups = [
        assembleSection(faultGroup),
        assembleSection(buckets.top),
        assembleSection(buckets.primary),
        assembleSection(buckets.plugins),
        assembleSection(buckets.bottom),
        assembleSection(buckets.lifecycle)
      ];

      // Build flat list with separators between non-empty sections
      let combined = [];
      let sepCounter = 0;
      for (const group of orderedGroups) {
        if (group.length === 0) continue;
        if (combined.length > 0 && combined[combined.length - 1].type !== 'separator' && group[0].type !== 'separator') {
          combined.push({ id: `host:sep-${++sepCounter}`, type: 'separator' });
        }
        combined.push(...group);
      }

      // Apply { before } / { after } anchored insertions
      for (const { item, position } of anchored) {
        const targetId = position.before || position.after;
        const idx = combined.findIndex((entry) => entry.id === targetId || entry.id.endsWith(`:${targetId}`));
        if (idx === -1) {
          // Target missing: fall back gracefully before bottom/lifecycle separator
          const lifeIdx = combined.findIndex((entry) => entry.id === DEFAULT_TRAY_MENU_IDS.RESTART_DAEMON);
          if (lifeIdx > 0) {
            combined.splice(lifeIdx, 0, item);
          } else {
            combined.push(item);
          }
        } else {
          combined.splice(position.before ? idx : idx + 1, 0, item);
        }
      }

      // Normalize separators: no leading, trailing, or consecutive separators
      const normalized = [];
      for (const item of combined) {
        if (item.type === 'separator') {
          if (normalized.length === 0) continue;
          if (normalized[normalized.length - 1].type === 'separator') continue;
        }
        normalized.push(item);
      }
      while (normalized.length > 0 && normalized[normalized.length - 1].type === 'separator') {
        normalized.pop();
      }

      this.clickTargets = nextClickTargets;
      return normalized;
    } catch {
      // Ultimate safe fallback: always keep the 4 built-in menu items working
      this.clickTargets = new Map();
      return [
        ...defaultTopBuiltIns,
        { id: 'host:sep-fallback', type: 'separator' },
        ...defaultBottomBuiltIns
      ];
    }
  }

  scheduleRefresh() {
    if (!this.started) return;
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshMenu(true);
    }, 16);
    if (typeof this.refreshTimer.unref === 'function') this.refreshTimer.unref();
  }

  async refreshMenu(immediate = false) {
    if (!immediate) {
      this.scheduleRefresh();
      return { ok: true, scheduled: true };
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    const items = this.buildMenuModel();
    this.lastSnapshot = items;
    if (!this.started) {
      return { ok: true, items, skippedBackend: true };
    }
    const presentation = this.getTrayPresentation();
    await this.backend.updateMenu({
      tooltip: presentation.tooltip,
      title: presentation.title,
      items
    });
    return { ok: true, items };
  }

  getMenuSnapshot() {
    if (!this.started && this.lastSnapshot.length === 0) {
      return this.buildMenuModel();
    }
    return this.lastSnapshot;
  }

  getPluginErrors(pluginId = null) {
    const out = [];
    for (const err of this.itemErrors.values()) {
      if (!pluginId || err.pluginId === pluginId) {
        out.push({ ...err });
      }
    }
    return out;
  }

  async handleMenuClick(itemId) {
    const id = String(itemId || '').trim();
    if (!id) return { ok: false, error: 'EMPTY_ITEM_ID' };

    // Built-in host actions
    if (id === FAULT_TRAY_MENU_IDS.RELAUNCH_ANTIGRAVITY) {
      try {
        const handler = this.onRelaunchAntigravity || this.onLaunchAntigravity;
        const result = handler ? await handler() : { ok: false, reason: 'NO_HANDLER' };
        return { ok: true, id, result };
      } catch (err) {
        return { ok: false, id, error: err?.message || String(err) };
      }
    }
    if (id === FAULT_TRAY_MENU_IDS.OPEN_DIAGNOSTICS) {
      try {
        const result = this.onOpenDiagnostics ? await this.onOpenDiagnostics() : { ok: false, reason: 'NO_HANDLER' };
        return { ok: true, id, result };
      } catch (err) {
        return { ok: false, id, error: err?.message || String(err) };
      }
    }
    if (id === DEFAULT_TRAY_MENU_IDS.LAUNCH_ANTIGRAVITY) {
      try {
        const result = this.onLaunchAntigravity ? await this.onLaunchAntigravity() : { ok: false, reason: 'NO_HANDLER' };
        return { ok: true, id, result };
      } catch (err) {
        return { ok: false, id, error: err?.message || String(err) };
      }
    }
    if (id === DEFAULT_TRAY_MENU_IDS.PLUGIN_SETTINGS) {
      try {
        const result = this.onOpenPluginSettings ? await this.onOpenPluginSettings() : { ok: false, reason: 'NO_HANDLER' };
        return { ok: true, id, result };
      } catch (err) {
        return { ok: false, id, error: err?.message || String(err) };
      }
    }
    if (id === DEFAULT_TRAY_MENU_IDS.RESTART_DAEMON) {
      try {
        const result = this.onRestartDaemon ? await this.onRestartDaemon() : { ok: false, reason: 'NO_HANDLER' };
        return { ok: true, id, result };
      } catch (err) {
        return { ok: false, id, error: err?.message || String(err) };
      }
    }
    if (id === DEFAULT_TRAY_MENU_IDS.QUIT) {
      try {
        const result = this.onQuit ? await this.onQuit() : { ok: false, reason: 'NO_HANDLER' };
        return { ok: true, id, result };
      } catch (err) {
        return { ok: false, id, error: err?.message || String(err) };
      }
    }

    // Plugin custom menu item (root or nested submenu item)
    if (this.lastSnapshot.length === 0 && this.clickTargets.size === 0) {
      this.buildMenuModel();
    }
    const target = this.clickTargets.get(id);
    if (!target) {
      const directRec = this.pluginItems.get(id);
      if (directRec?.faulted) {
        return { ok: false, id, pluginId: directRec.pluginId, error: `TRAY_ITEM_CIRCUIT_OPEN: ${id}` };
      }
      return { ok: false, id, error: `TRAY_ITEM_NOT_FOUND: ${id}` };
    }
    const { pluginId, rootFullId, record, def } = target;
    if (record.faulted) {
      return { ok: false, id, error: `TRAY_ITEM_CIRCUIT_OPEN: ${id}` };
    }

    const ctx = {
      id: getSafeDescriptorValue(def, 'id', record.localId),
      fullId: id,
      pluginId,
      checked: Boolean(getSafeDescriptorValue(def, 'checked', false)),
      update: (patch) => this.updatePluginMenuItem(pluginId, record.localId, patch)
    };

    const runAction = async () => {
      const onClick = getSafeDescriptorValue(def, 'onClick', null);
      if (typeof onClick === 'function') {
        return await onClick(ctx);
      }
      const commandId = getSafeDescriptorValue(def, 'command', null);
      if (typeof commandId === 'string' && commandId.trim()) {
        const execFn = record.executeCommand || this.executeCommand;
        if (typeof execFn !== 'function') {
          throw new Error(`No command executor configured for ${commandId}`);
        }
        const args = getSafeDescriptorValue(def, 'args', []);
        return await execFn(commandId.trim(), Array.isArray(args) ? args : [], { pluginId });
      }
      return null;
    };

    try {
      let timer = null;
      const result = await Promise.race([
        Promise.resolve().then(runAction),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`TRAY_CALLBACK_TIMEOUT: ${id} exceeded ${this.callbackTimeoutMs}ms`));
          }, this.callbackTimeoutMs);
          if (typeof timer.unref === 'function') timer.unref();
        })
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });

      this.itemErrors.delete(rootFullId);
      if (this.bus) {
        try {
          this.bus.emitEvent('agy-daddy.host', 'tray:item-clicked@1', { pluginId, itemId: id });
        } catch {}
      }
      return { ok: true, id, pluginId, result: result === undefined ? null : result };
    } catch (err) {
      const errRec = this.recordItemError(pluginId, rootFullId, 'click', err);
      if (errRec.circuitOpen) {
        await this.refreshMenu(true);
      }
      return {
        ok: false,
        id,
        pluginId,
        error: err?.message || String(err),
        circuitOpen: errRec.circuitOpen
      };
    }
  }
}

module.exports = {
  DEFAULT_TRAY_MENU_IDS,
  FAULT_TRAY_MENU_IDS,
  DEFAULT_TRAY_ITEMS,
  ALERT_TRAY_TITLE,
  MAX_ITEMS_PER_PLUGIN,
  MAX_SUBMENU_DEPTH,
  hasExceededFaultSnapshot,
  buildFaultStatusLabel,
  resolveDefaultTrayIconPath,
  resolveDefaultMacApplicationsDir,
  registerMacAppBundle,
  ensureMacTrayAppBundle,
  MemoryTrayBackend,
  NativeTrayBackend,
  TrayManager
};
