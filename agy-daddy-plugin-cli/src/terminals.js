'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');

const CLI_PERMISSION_MODES = Object.freeze([
  'default',
  'plan',
  'accept-edits',
  'auto',
  'skip-permissions'
]);

const TERMINAL_LABELS = Object.freeze({
  auto: '自动探测',
  terminal: 'Terminal.app',
  iterm2: 'iTerm2',
  ghostty: 'Ghostty',
  warp: 'Warp',
  kitty: 'Kitty',
  wezterm: 'WezTerm',
  cmux: 'cmux',
  alacritty: 'Alacritty',
  rex: 'Rex',
  tmux: 'tmux',
  wt: 'Windows Terminal',
  powershell: 'PowerShell',
  cmd: 'Command Prompt',
  wsl: 'WSL'
});

function resolvePermissionArgs(options = {}) {
  const mode = typeof options.cliPermissionMode === 'string' ? options.cliPermissionMode.trim() : '';
  if (CLI_PERMISSION_MODES.includes(mode)) {
    if (mode === 'skip-permissions') return ['--dangerously-skip-permissions'];
    if (mode === 'auto' || mode === 'accept-edits' || mode === 'plan') return ['--mode', mode];
    return [];
  }
  if (options.cliSkipPermissions) {
    return ['--dangerously-skip-permissions'];
  }
  return [];
}

function parseQuickCommands(rawList) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  rawList.forEach((rawItem, idx) => {
    let name = '';
    let command = '';
    let pinToTopbar = true;
    let id = `quick-${idx}`;
    if (rawItem && typeof rawItem === 'object' && !Array.isArray(rawItem)) {
      command = String(rawItem.command || '').trim();
      name = String(rawItem.name || '').trim();
      pinToTopbar = rawItem.pinToTopbar !== false;
      if (rawItem.id) id = String(rawItem.id);
    } else {
      const rawStr = String(rawItem ?? '').trim();
      if (!rawStr) return;
      if (rawStr.startsWith('{')) {
        try {
          const parsed = JSON.parse(rawStr);
          if (parsed && typeof parsed === 'object') {
            command = String(parsed.command || '').trim();
            name = String(parsed.name || '').trim();
            pinToTopbar = parsed.pinToTopbar !== false;
            if (parsed.id) id = String(parsed.id);
          }
        } catch {}
      }
      if (!command) command = rawStr;
    }
    if (!command) return;
    if (!name) name = command.split(/\s+/)[0] || `命令 ${idx + 1}`;
    out.push({ id, name, command, pinToTopbar });
  });
  return out;
}

function escapePosixArg(arg) {
  return "'" + String(arg ?? '').replace(/'/g, "'\\''") + "'";
}

function formatCliArgToken(raw) {
  const clean = String(raw ?? '').replace(/\0/g, '').trim();
  if (!clean) return '';
  return /^[a-zA-Z0-9._:@/=+-]+$/.test(clean) ? clean : escapePosixArg(clean);
}

function buildDefaultCliCommand(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const cliBin = String(opts.cliBin || 'agy').replace(/\0/g, '').trim() || 'agy';
  const tokens = [formatCliArgToken(cliBin)];
  for (const arg of resolvePermissionArgs(opts)) {
    const tok = formatCliArgToken(arg);
    if (tok) tokens.push(tok);
  }
  const model = String(opts.cliDefaultModel ?? '').replace(/\0/g, '').trim();
  if (model) {
    tokens.push('--model', formatCliArgToken(model));
  }
  return tokens.filter(Boolean).join(' ');
}

function escapeAppleScriptString(str) {
  return String(str ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

function escapePowerShellSingleQuoted(str) {
  return String(str ?? '').replace(/'/g, "''");
}

function toWslPath(winPath) {
  const s = String(winPath || '').trim();
  const match = s.match(/^([a-zA-Z]):[\\/](.*)$/);
  if (match) {
    return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`;
  }
  if (/^[a-zA-Z]:$/.test(s)) {
    return `/mnt/${s[0].toLowerCase()}`;
  }
  return s.replace(/\\/g, '/');
}

function sanitizeMuxHost(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (['local', 'localhost', '127.0.0.1', '__local__'].includes(lower) || lower.startsWith('unix://')) {
    return '';
  }
  if (/^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,127}$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

function findInPath(binName, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const existsSync = options.existsSync || fs.existsSync;
  const pathMod = platform === 'win32' ? path.win32 : path.posix;
  const sep = platform === 'win32' ? ';' : ':';
  const rawPath = env.PATH || env.Path || '';
  const dirs = String(rawPath).split(sep).filter(Boolean);
  if (options.includeDefaultDirs !== false && platform === 'darwin' && !options.env) {
    const home = options.homeDir || os.homedir();
    for (const fallbackDir of ['/opt/homebrew/bin', '/usr/local/bin', path.posix.join(home, '.local', 'bin')]) {
      if (!dirs.includes(fallbackDir)) dirs.push(fallbackDir);
    }
  }
  for (const dir of dirs) {
    const cand = pathMod.join(dir, binName);
    try {
      if (existsSync(cand)) return cand;
    } catch {}
  }
  return null;
}

function getDarwinTerminalSpecs(options = {}) {
  const home = options.homeDir || os.homedir();
  return [
    { id: 'terminal', name: 'Terminal.app', paths: ['/System/Applications/Utilities/Terminal.app', '/Applications/Utilities/Terminal.app'] },
    { id: 'iterm2', name: 'iTerm2', paths: ['/Applications/iTerm.app', path.posix.join(home, 'Applications', 'iTerm.app')] },
    { id: 'ghostty', name: 'Ghostty', bin: 'ghostty', paths: ['/Applications/Ghostty.app', path.posix.join(home, 'Applications', 'Ghostty.app')] },
    { id: 'warp', name: 'Warp', paths: ['/Applications/Warp.app', path.posix.join(home, 'Applications', 'Warp.app')] },
    { id: 'cmux', name: 'cmux', bin: 'cmux', paths: ['/Applications/cmux.app', path.posix.join(home, 'Applications', 'cmux.app')] },
    { id: 'wezterm', name: 'WezTerm', bin: 'wezterm', paths: ['/Applications/WezTerm.app', path.posix.join(home, 'Applications', 'WezTerm.app')] },
    { id: 'kitty', name: 'Kitty', bin: 'kitty', paths: ['/Applications/kitty.app', path.posix.join(home, 'Applications', 'kitty.app')] },
    { id: 'alacritty', name: 'Alacritty', bin: 'alacritty', paths: ['/Applications/Alacritty.app', path.posix.join(home, 'Applications', 'Alacritty.app')] }
  ];
}

const TERMINAL_CATALOG = Object.freeze([
  'terminal', 'iterm2', 'ghostty', 'warp', 'kitty', 'wezterm', 'cmux',
  'alacritty', 'rex', 'wt', 'powershell', 'cmd', 'wsl'
]);

function detectRexAppPath(options = {}) {
  const existsSync = options.existsSync || fs.existsSync;
  const home = options.homeDir || os.homedir();
  const candidates = [
    '/Applications/Rex.app',
    '/Applications/Rex Beta.app',
    path.posix.join(home, 'Applications', 'Rex.app'),
    path.posix.join(home, 'Applications', 'Rex Beta.app')
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {}
  }
  return null;
}

function getWindowsHelperPath() {
  return path.resolve(__dirname, '..', 'scripts', 'cli-window-helper.cs');
}

function detectAvailableTerminals(options = {}) {
  const platform = options.platform || process.platform;
  const existsSync = options.existsSync || fs.existsSync;
  const found = [];

  if (platform === 'darwin') {
    const apps = getDarwinTerminalSpecs(options);
    for (const a of apps) {
      const binFound = a.bin ? findInPath(a.bin, options) : null;
      const appFound = (a.paths || []).find((p) => {
        try { return existsSync(p); } catch { return false; }
      }) || null;
      if (appFound || binFound) {
        found.push({ id: a.id, name: a.name, path: appFound || binFound, available: true });
      }
    }
    for (const mux of ['rex', 'tmux']) {
      const p = findInPath(mux, options);
      if (p) found.push({ id: mux, name: mux, path: p, available: true, isMux: true });
    }
    return found;
  }

  if (platform === 'win32') {
    const wt = findInPath('wt.exe', options);
    const pwsh = findInPath('pwsh.exe', options) || findInPath('powershell.exe', options);
    const cmd = findInPath('cmd.exe', options) || 'cmd.exe';
    if (wt) found.push({ id: 'wt', name: 'Windows Terminal', path: wt, available: true });
    if (pwsh) found.push({ id: 'powershell', name: 'PowerShell', path: pwsh, available: true });
    found.push({ id: 'cmd', name: 'Command Prompt', path: cmd, available: true });
    return found;
  }

  for (const bin of ['wezterm', 'kitty', 'alacritty', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm', 'tmux', 'rex']) {
    const p = findInPath(bin, options);
    if (p) found.push({ id: bin, name: bin, path: p, available: true });
  }
  return found;
}

function detectTerminalPath(terminalApp = 'auto', options = {}) {
  const platform = options.platform || process.platform;
  const existsSync = options.existsSync || fs.existsSync;
  const env = options.env || process.env;
  const target = String(terminalApp || 'auto').trim().toLowerCase() || 'auto';
  const label = TERMINAL_LABELS[target] || target;

  if (target === 'auto') {
    const avail = detectAvailableTerminals(options);
    const first = avail[0] || null;
    if (first && first.path) {
      return {
        ok: true,
        found: true,
        terminalApp: 'auto',
        resolvedTerminalId: first.id,
        name: first.name || TERMINAL_LABELS[first.id] || first.id,
        path: first.path,
        message: `自动探测到 ${first.name || first.id}`
      };
    }
    return {
      ok: true,
      found: false,
      terminalApp: 'auto',
      resolvedTerminalId: 'auto',
      name: label,
      path: '',
      error: '未检测到可用终端程序路径，请手动输入路径或点击「浏览选择」'
    };
  }

  let detectedPath = null;
  if (platform === 'darwin') {
    if (target === 'rex' || target === 'tmux') {
      detectedPath = findInPath(target, options);
    } else {
      const spec = getDarwinTerminalSpecs(options).find((a) => a.id === target);
      if (spec) {
        const appFound = (spec.paths || []).find((p) => {
          try { return existsSync(p); } catch { return false; }
        }) || null;
        const binFound = spec.bin ? findInPath(spec.bin, options) : null;
        detectedPath = appFound || binFound;
      } else {
        detectedPath = findInPath(target, options);
      }
    }
  } else if (platform === 'win32') {
    if (target === 'wt') {
      detectedPath = findInPath('wt.exe', options);
      if (!detectedPath && env.LOCALAPPDATA) {
        const cand = path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'wt.exe');
        try { if (existsSync(cand)) detectedPath = cand; } catch {}
      }
    } else if (target === 'powershell') {
      detectedPath = findInPath('pwsh.exe', options) || findInPath('powershell.exe', options);
    } else if (target === 'cmd') {
      detectedPath = findInPath('cmd.exe', options);
    } else if (target === 'wsl') {
      detectedPath = findInPath('wsl.exe', options);
    } else {
      detectedPath = findInPath(`${target}.exe`, options) || findInPath(target, options);
    }
  } else {
    detectedPath = findInPath(target, options);
  }

  if (detectedPath) {
    return {
      ok: true,
      found: true,
      terminalApp: target,
      resolvedTerminalId: target,
      name: label,
      path: detectedPath,
      message: `已检测到 ${label}`
    };
  }

  return {
    ok: true,
    found: false,
    terminalApp: target,
    resolvedTerminalId: target,
    name: label,
    path: '',
    error: `未检测到 ${label} 的程序路径，请手动输入路径或点击「浏览选择」`
  };
}

function verifyTerminalPath(customPath, options = {}) {
  const existsSync = options.existsSync || fs.existsSync;
  const trimmed = String(customPath || '').trim();
  if (!trimmed) {
    return {
      ok: true,
      found: false,
      path: '',
      error: '程序路径为空，请输入路径或点击「浏览选择」'
    };
  }
  let exists = false;
  try {
    exists = Boolean(existsSync(trimmed));
  } catch {
    exists = false;
  }
  if (!exists) {
    return {
      ok: true,
      found: false,
      path: trimmed,
      error: `路径不存在或不可访问：${trimmed}，请重新输入或点击「浏览选择」`
    };
  }
  return {
    ok: true,
    found: true,
    path: trimmed,
    message: '路径有效'
  };
}

function listSshMuxHosts(options = {}) {
  const readFileSync = options.readFileSync || fs.readFileSync;
  const existsSync = options.existsSync || fs.existsSync;
  const configPath = options.sshConfigPath || path.join(options.homeDir || os.homedir(), '.ssh', 'config');
  try {
    if (!existsSync(configPath)) return [];
  } catch {
    return [];
  }
  let content = '';
  try {
    content = String(readFileSync(configPath, 'utf8') || '');
  } catch {
    return [];
  }
  const blocks = [];
  let current = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const match = line.match(/^([A-Za-z]+)\s+(.+)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const rest = match[2].trim();
    if (key === 'host') {
      const patterns = rest.split(/\s+/).filter(Boolean);
      current = { patterns, user: '', hostname: '' };
      blocks.push(current);
    } else if (current && key === 'user') {
      current.user = rest;
    } else if (current && key === 'hostname') {
      current.hostname = rest;
    }
  }

  const out = [];
  const seen = new Set();
  for (const b of blocks) {
    for (const pat of b.patterns) {
      if (!pat || /[*?!]/.test(pat)) continue;
      const lower = pat.toLowerCase();
      if (lower === 'localhost' || lower === '127.0.0.1' || seen.has(pat)) continue;
      if (sanitizeMuxHost(pat) === null) continue;
      seen.add(pat);
      const descParts = [];
      if (b.user && b.hostname) descParts.push(`${b.user}@${b.hostname}`);
      else if (b.hostname) descParts.push(b.hostname);
      else if (b.user) descParts.push(b.user);
      out.push({
        value: pat,
        label: pat,
        description: descParts.join(' ')
      });
    }
  }
  return out;
}

function buildLaunchPlan(options = {}) {
  const platform = options.platform || process.platform;
  const terminalApp = String(options.terminalApp || 'auto').toLowerCase();
  const customTerminalPath = typeof options.customTerminalPath === 'string' ? options.customTerminalPath.trim() : '';
  const cwd = normalizeWorkspacePath(options.cwd, { platform })
    || normalizeWorkspacePath(process.cwd(), { platform })
    || process.cwd();
  const workspaceSource = typeof options.workspaceSource === 'string' ? options.workspaceSource : '';
  const cliBin = options.cliBin || 'agy';
  const rawCommand = typeof options.rawCommand === 'string' ? options.rawCommand.trim() : '';
  const isCustomCommand = rawCommand.length > 0;
  const extraArgs = Array.isArray(options.commandArgs) ? options.commandArgs.map(String) : [];

  const cliArgs = [];
  if (!isCustomCommand) {
    cliArgs.push(...resolvePermissionArgs(options));
    if (options.cliDefaultModel) cliArgs.push('--model', String(options.cliDefaultModel));
    cliArgs.push(...extraArgs);
  }

  let cleanMux = '';
  if (options.muxHost) {
    const sanitized = sanitizeMuxHost(options.muxHost);
    if (sanitized === null) {
      throw new Error(`Unsafe muxHost rejected: ${String(options.muxHost)}`);
    }
    cleanMux = sanitized;
  }

  const env = { ...(options.env || {}) };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NO_COLOR;
  env.TERM = env.TERM || 'xterm-256color';
  env.COLORTERM = env.COLORTERM || 'truecolor';

  const attachMeta = (plan) => (workspaceSource ? { ...plan, workspaceSource } : plan);

  if (platform === 'win32') {
    const cmdStatement = isCustomCommand
      ? rawCommand
      : `& '${escapePowerShellSingleQuoted(cliBin)}' ${cliArgs.map((a) => `'${escapePowerShellSingleQuoted(a)}'`).join(' ')}`.trim();
    const psCmdParts = [
      `Set-Location -LiteralPath '${escapePowerShellSingleQuoted(cwd)}'`,
      cmdStatement
    ];
    const commandLine = psCmdParts.join('; ');
    const targetTerm = terminalApp === 'auto' ? 'wt' : terminalApp;
    if (targetTerm === 'wsl') {
      const wslCwd = toWslPath(cwd);
      return attachMeta({
        ok: true,
        platform,
        terminalId: 'wsl',
        executable: customTerminalPath || 'wsl.exe',
        args: isCustomCommand
          ? ['--cd', wslCwd, '--', 'sh', '-lc', rawCommand]
          : ['--cd', wslCwd, '--', cliBin, ...cliArgs],
        env,
        cwd: wslCwd,
        muxHost: cleanMux,
        isCustomCommand,
        ...(isCustomCommand ? { rawCommand } : {}),
        windowsHelperPath: getWindowsHelperPath()
      });
    }
    if (targetTerm === 'wt') {
      return attachMeta({
        ok: true,
        platform,
        terminalId: 'wt',
        executable: customTerminalPath || 'wt.exe',
        args: ['-d', cwd, 'powershell.exe', '-NoExit', '-Command', commandLine],
        env,
        cwd,
        muxHost: cleanMux,
        isCustomCommand,
        ...(isCustomCommand ? { rawCommand } : {}),
        windowsHelperPath: getWindowsHelperPath()
      });
    }
    return attachMeta({
      ok: true,
      platform,
      terminalId: targetTerm === 'cmd' ? 'cmd' : 'powershell',
      executable: customTerminalPath || (targetTerm === 'cmd' ? 'cmd.exe' : 'powershell.exe'),
      args: targetTerm === 'cmd' ? ['/K', `cd /d "${cwd}" && ${isCustomCommand ? rawCommand : [cliBin, ...cliArgs].join(' ')}`] : ['-NoExit', '-Command', commandLine],
      env,
      cwd,
      muxHost: cleanMux,
      isCustomCommand,
      ...(isCustomCommand ? { rawCommand } : {}),
      windowsHelperPath: getWindowsHelperPath()
    });
  }

  const posixCmd = isCustomCommand
    ? rawCommand
    : [escapePosixArg(cliBin), ...cliArgs.map(escapePosixArg)].join(' ');
  const fullShellCmd = `cd ${escapePosixArg(cwd)} && ${posixCmd}`;
  const wrappedCmd = cleanMux
    ? `ssh -t ${escapePosixArg(cleanMux)} ${escapePosixArg(fullShellCmd)}`
    : fullShellCmd;

  let chosenTerm = terminalApp;
  if (chosenTerm === 'auto') {
    chosenTerm = platform === 'darwin' ? 'terminal' : 'xterm';
  }

  const isAppBundle = customTerminalPath.toLowerCase().endsWith('.app');

  if (chosenTerm === 'rex') {
    const rexArgs = cleanMux
      ? ['-S', cleanMux, 'run', '--interactive', '--keep-open', '-c', cwd, '--', 'sh', '-lc', fullShellCmd]
      : ['run', '--interactive', '--keep-open', '-c', cwd, '--', 'sh', '-lc', fullShellCmd];
    const activateApp = platform === 'darwin' ? detectRexAppPath(options) : null;
    return attachMeta({
      ok: true,
      platform,
      terminalId: 'rex',
      executable: (!isAppBundle && customTerminalPath) ? customTerminalPath : 'rex',
      args: rexArgs,
      env,
      cwd,
      muxHost: cleanMux,
      isCustomCommand,
      ...(activateApp ? { activateApp } : {}),
      ...(isCustomCommand ? { rawCommand } : {})
    });
  }

  if (chosenTerm === 'wezterm') {
    const wezArgs = isCustomCommand
      ? (cleanMux ? ['cli', 'spawn', '--domain-name', cleanMux, '--cwd', cwd, '--', 'sh', '-lc', rawCommand] : ['start', '--cwd', cwd, '--', 'sh', '-lc', rawCommand])
      : (cleanMux ? ['cli', 'spawn', '--domain-name', cleanMux, '--cwd', cwd, '--', cliBin, ...cliArgs] : ['start', '--cwd', cwd, '--', cliBin, ...cliArgs]);
    return attachMeta({
      ok: true,
      platform,
      terminalId: 'wezterm',
      executable: (!isAppBundle && customTerminalPath) ? customTerminalPath : 'wezterm',
      args: wezArgs,
      env,
      cwd,
      muxHost: cleanMux,
      isCustomCommand,
      ...(isCustomCommand ? { rawCommand } : {})
    });
  }

  if (chosenTerm === 'tmux') {
    return attachMeta({
      ok: true,
      platform,
      terminalId: 'tmux',
      executable: (!isAppBundle && customTerminalPath) ? customTerminalPath : 'tmux',
      args: ['new-window', '-c', cwd, wrappedCmd],
      env,
      cwd,
      muxHost: cleanMux,
      isCustomCommand,
      ...(isCustomCommand ? { rawCommand } : {})
    });
  }

  if (platform === 'darwin') {
    if (chosenTerm === 'iterm2') {
      if (customTerminalPath && !isAppBundle) {
        return attachMeta({
          ok: true,
          platform,
          terminalId: 'iterm2',
          executable: customTerminalPath,
          args: ['-e', 'zsh', '-lc', wrappedCmd],
          env,
          cwd,
          muxHost: cleanMux,
          isCustomCommand,
          ...(isCustomCommand ? { rawCommand } : {})
        });
      }
      const appRef = isAppBundle ? customTerminalPath : 'iTerm';
      return attachMeta({
        ok: true,
        platform,
        terminalId: 'iterm2',
        executable: 'osascript',
        args: [
          '-e', `tell application "${escapeAppleScriptString(appRef)}" to activate`,
          '-e', `tell application "${escapeAppleScriptString(appRef)}" to create window with default profile command "${escapeAppleScriptString(wrappedCmd)}"`
        ],
        env,
        cwd,
        muxHost: cleanMux,
        isCustomCommand,
        ...(isCustomCommand ? { rawCommand } : {})
      });
    }
    if (['ghostty', 'warp', 'kitty', 'alacritty', 'cmux'].includes(chosenTerm)) {
      if (customTerminalPath && !isAppBundle) {
        return attachMeta({
          ok: true,
          platform,
          terminalId: chosenTerm,
          executable: customTerminalPath,
          args: ['-e', 'zsh', '-lc', wrappedCmd],
          env,
          cwd,
          muxHost: cleanMux,
          isCustomCommand,
          ...(isCustomCommand ? { rawCommand } : {})
        });
      }
      const defaultAppMap = {
        ghostty: 'Ghostty',
        warp: 'Warp',
        kitty: 'kitty',
        alacritty: 'Alacritty',
        cmux: 'cmux'
      };
      const appTarget = isAppBundle ? customTerminalPath : (defaultAppMap[chosenTerm] || chosenTerm);
      return attachMeta({
        ok: true,
        platform,
        terminalId: chosenTerm,
        executable: 'open',
        args: ['-na', appTarget, '--args', '-e', 'zsh', '-lc', wrappedCmd],
        env,
        cwd,
        muxHost: cleanMux,
        isCustomCommand,
        ...(isCustomCommand ? { rawCommand } : {})
      });
    }
    if (customTerminalPath && !isAppBundle) {
      return attachMeta({
        ok: true,
        platform,
        terminalId: chosenTerm,
        executable: customTerminalPath,
        args: ['-e', 'zsh', '-lc', wrappedCmd],
        env,
        cwd,
        muxHost: cleanMux,
        isCustomCommand,
        ...(isCustomCommand ? { rawCommand } : {})
      });
    }
    const termAppRef = isAppBundle ? customTerminalPath : 'Terminal';
    return attachMeta({
      ok: true,
      platform,
      terminalId: 'terminal',
      executable: 'osascript',
      args: [
        '-e', `tell application "${escapeAppleScriptString(termAppRef)}" to activate`,
        '-e', `tell application "${escapeAppleScriptString(termAppRef)}" to do script "${escapeAppleScriptString(wrappedCmd)}"`
      ],
      env,
      cwd,
      muxHost: cleanMux,
      isCustomCommand,
      ...(isCustomCommand ? { rawCommand } : {})
    });
  }

  return attachMeta({
    ok: true,
    platform,
    terminalId: chosenTerm,
    executable: customTerminalPath || chosenTerm,
    args: ['-e', 'sh', '-lc', wrappedCmd],
    env,
    cwd,
    muxHost: cleanMux,
    isCustomCommand,
    ...(isCustomCommand ? { rawCommand } : {})
  });
}

function normalizeWorkspacePath(raw, options = {}) {
  if (typeof raw !== 'string') return null;
  let str = raw.trim();
  if (!str || str.includes('\0')) return null;

  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || os.homedir();

  if (/^file:\/\//i.test(str)) {
    try {
      const parsedUrl = new URL(str);
      const isWinFileUri = /^\/[A-Za-z]:(?:\/|$)/.test(parsedUrl.pathname);
      if (isWinFileUri) {
        let winRaw = decodeURIComponent(parsedUrl.pathname.slice(1)).replace(/\//g, '\\');
        if (/^[A-Za-z]:$/.test(winRaw)) winRaw += '\\';
        const normWin = path.win32.normalize(winRaw);
        return /^[A-Za-z]:\\$/.test(normWin) ? normWin : normWin.replace(/[\\/]+$/, '');
      }
      if (platform !== 'win32') {
        try {
          const nativePath = fileURLToPath(str);
          const normPosix = path.posix.normalize(nativePath);
          return normPosix === '/' ? '/' : normPosix.replace(/\/+$/, '');
        } catch {}
      }
      str = decodeURIComponent(parsedUrl.pathname || '');
    } catch {
      return null;
    }
  }

  if (!str) return null;

  if (str === '~' || str.startsWith('~/') || str.startsWith('~\\')) {
    const rest = str.slice(1).replace(/^[\\/]+/, '');
    const isWinHome = platform === 'win32' || /^[A-Za-z]:[\\/]/.test(homeDir);
    const joinMod = isWinHome ? path.win32 : path.posix;
    str = rest ? joinMod.join(homeDir, rest) : homeDir;
  }

  if (/^[A-Za-z]:(?:[\\/]|$)/.test(str) || /^\\\\[^\\]/.test(str)) {
    const rawWin = /^[A-Za-z]:$/.test(str) ? `${str}\\` : str;
    const normWin = path.win32.normalize(rawWin);
    return /^[A-Za-z]:\\$/.test(normWin) ? normWin : normWin.replace(/[\\/]+$/, '');
  }

  if (str.startsWith('/')) {
    const normPosix = path.posix.normalize(str);
    return normPosix === '/' ? '/' : normPosix.replace(/\/+$/, '');
  }

  if (platform === 'win32') {
    const resolvedWin = path.win32.resolve(str);
    return /^[A-Za-z]:\\$/.test(resolvedWin) ? resolvedWin : resolvedWin.replace(/[\\/]+$/, '');
  }
  const resolvedPosix = path.resolve(str);
  return resolvedPosix === '/' ? '/' : resolvedPosix.replace(/\/+$/, '');
}

function extractWorkspacesFromTrajectory(entry, options = {}) {
  if (!entry || typeof entry !== 'object') return [];
  const rawList = [];
  const collectWorkspaceArray = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const w of arr) {
      if (!w || typeof w !== 'object') continue;
      if (w.workspaceFolderAbsoluteUri) rawList.push(w.workspaceFolderAbsoluteUri);
      if (w.gitRootAbsoluteUri) rawList.push(w.gitRootAbsoluteUri);
      if (w.workspacePath) rawList.push(w.workspacePath);
      if (w.workspaceUri) rawList.push(w.workspaceUri);
    }
  };

  collectWorkspaceArray(entry.workspaces);
  collectWorkspaceArray(entry.trajectoryMetadata?.workspaces);
  if (Array.isArray(entry.trajectoryMetadata?.workspaceUris)) {
    rawList.push(...entry.trajectoryMetadata.workspaceUris);
  }
  collectWorkspaceArray(entry.trajectory?.metadata?.workspaces);
  if (Array.isArray(entry.trajectory?.metadata?.workspaceUris)) {
    rawList.push(...entry.trajectory.metadata.workspaceUris);
  }
  for (const k of ['workspacePath', 'workspaceUri', 'cwd', 'rootPath']) {
    if (entry[k]) rawList.push(entry[k]);
  }

  const out = [];
  const seen = new Set();
  for (const raw of rawList) {
    const norm = normalizeWorkspacePath(String(raw || ''), options);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

const GENERIC_HINT_TOKENS = new Set([
  'antigravity', 'settings', '设置', 'agy-daddy', 'cli', 'terminal', 'new chat', 'untitled'
]);

function extractWorkspaceNameTokens(workspaceHints = {}) {
  const hints = workspaceHints && typeof workspaceHints === 'object' ? workspaceHints : {};
  const rawTokens = [];
  const pushToken = (val) => {
    const s = String(val || '').trim();
    if (!s || s.length > 120) return;
    if (!rawTokens.includes(s)) rawTokens.push(s);
  };
  if (Array.isArray(hints.workspaceNameHints)) {
    for (const t of hints.workspaceNameHints) pushToken(t);
  }
  if (Array.isArray(hints.titlebarTexts)) {
    for (const t of hints.titlebarTexts) pushToken(t);
  }
  if (typeof hints.pageTitle === 'string' && hints.pageTitle.trim()) {
    for (const part of hints.pageTitle.split(/\s+[—–\-|·]\s+|\s+-\s+/)) {
      pushToken(part);
    }
  }
  return rawTokens.filter((t) => !GENERIC_HINT_TOKENS.has(t.toLowerCase()));
}

function pathBasenameCrossPlatform(p) {
  const str = String(p || '');
  const idx = Math.max(str.lastIndexOf('/'), str.lastIndexOf('\\'));
  return idx >= 0 ? str.slice(idx + 1) : str;
}

function pathDirnameCrossPlatform(p) {
  const str = String(p || '');
  if (/^[A-Za-z]:\\/.test(str) || str.includes('\\')) return path.win32.dirname(str);
  return path.posix.dirname(str);
}

function resolveLocalDirectoryCandidate(candidatePath, options = {}) {
  const existsSync = options.existsSync || fs.existsSync;
  const statSync = options.statSync || fs.statSync;
  try {
    if (!existsSync(candidatePath)) return null;
    if (typeof statSync === 'function') {
      const st = statSync(candidatePath);
      if (st && typeof st.isFile === 'function' && st.isFile()) {
        return pathDirnameCrossPlatform(candidatePath);
      }
      if (st && typeof st.isDirectory === 'function' && !st.isDirectory()) {
        return null;
      }
    }
    return candidatePath;
  } catch {
    return null;
  }
}

function pickBestCandidatePath(candidates, nameHints = [], options = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const localOnly = options.localOnly !== false;
  let pool = candidates;
  if (localOnly) {
    const existing = [];
    for (const c of candidates) {
      const resolved = resolveLocalDirectoryCandidate(c, options);
      if (resolved && !existing.includes(resolved)) existing.push(resolved);
    }
    if (existing.length > 0) pool = existing;
  }
  if (pool.length > 1 && Array.isArray(nameHints) && nameHints.length > 0) {
    const lowerHints = new Set(nameHints.map((h) => String(h || '').trim().toLowerCase()).filter(Boolean));
    for (const cand of pool) {
      const base = pathBasenameCrossPlatform(cand).toLowerCase();
      if (base && lowerHints.has(base)) {
        return cand;
      }
    }
  }
  return pool[0] || null;
}

function getTrajectoryTimestamps(summary = {}) {
  const viewTs = Date.parse(summary?.annotations?.lastUserViewTime || 0) || 0;
  const modTs = Date.parse(summary?.lastModifiedTime || summary?.updatedAt || summary?.createdTime || 0) || 0;
  return { viewTs, modTs };
}

function resolveWorkspaceFromTrajectories(summaries, options = {}) {
  const hints = options.workspaceHints && typeof options.workspaceHints === 'object' ? options.workspaceHints : {};
  const localOnly = options.localOnly !== false;
  const nameHints = extractWorkspaceNameTokens(hints);

  // 1. DOM 显式绝对路径
  if (Array.isArray(hints.domPaths) && hints.domPaths.length > 0) {
    const domCandidates = [];
    for (const raw of hints.domPaths) {
      const norm = normalizeWorkspacePath(String(raw || ''), options);
      if (!norm) continue;
      if (localOnly) {
        const verified = resolveLocalDirectoryCandidate(norm, options);
        if (verified && !domCandidates.includes(verified)) domCandidates.push(verified);
      } else if (!domCandidates.includes(norm)) {
        domCandidates.push(norm);
      }
    }
    if (domCandidates.length > 0) {
      return { cwd: domCandidates[0], source: 'dom-path', matchedCascadeId: null };
    }
  }

  if (!summaries || typeof summaries !== 'object') return null;

  const cascadeId = typeof options.cascadeId === 'string' ? options.cascadeId.trim() : '';
  if (cascadeId && summaries[cascadeId]) {
    const cands = extractWorkspacesFromTrajectory(summaries[cascadeId], options);
    const chosen = pickBestCandidatePath(cands, nameHints, options);
    if (chosen) {
      return { cwd: chosen, source: 'rpc-cascade', matchedCascadeId: cascadeId };
    }
  }

  const entries = Object.entries(summaries)
    .map(([id, summary]) => ({
      id,
      summary: summary || {},
      workspaces: extractWorkspacesFromTrajectory(summary, options),
      ...getTrajectoryTimestamps(summary)
    }))
    .filter((item) => item.workspaces.length > 0);

  if (entries.length === 0) return null;

  const sortByRecency = (a, b) => (b.viewTs - a.viewTs) || (b.modTs - a.modTs);

  // 3. 点击时 DOM 标题匹配会话
  const titleCandidates = [];
  if (typeof hints.activeConversationTitle === 'string' && hints.activeConversationTitle.trim()) {
    titleCandidates.push(hints.activeConversationTitle.trim());
  }
  if (Array.isArray(hints.titlebarTexts)) {
    for (const t of hints.titlebarTexts) {
      const s = String(t || '').trim();
      if (s && s.length >= 2 && !GENERIC_HINT_TOKENS.has(s.toLowerCase()) && !titleCandidates.includes(s)) {
        titleCandidates.push(s);
      }
    }
  }
  if (typeof hints.pageTitle === 'string' && hints.pageTitle.trim()) {
    for (const part of hints.pageTitle.split(/\s+[—–\-|·]\s+|\s+-\s+/)) {
      const s = part.trim();
      if (s && s.length >= 2 && !GENERIC_HINT_TOKENS.has(s.toLowerCase()) && !titleCandidates.includes(s)) {
        titleCandidates.push(s);
      }
    }
  }

  if (titleCandidates.length > 0) {
    const scoredByTitle = [];
    for (const item of entries) {
      const titles = [item.summary?.annotations?.title, item.summary?.summary]
        .map((t) => String(t || '').trim())
        .filter(Boolean);
      if (titles.length === 0) continue;
      let bestScore = 0;
      for (const domT of titleCandidates) {
        const domLower = domT.toLowerCase();
        for (const rpcT of titles) {
          const rpcLower = rpcT.toLowerCase();
          if (domLower === rpcLower) {
            bestScore = Math.max(bestScore, 2);
          } else if (domLower.length >= 4 && rpcLower.length >= 4 && (domLower.includes(rpcLower) || rpcLower.includes(domLower))) {
            bestScore = Math.max(bestScore, 1);
          }
        }
      }
      if (bestScore > 0) {
        scoredByTitle.push({ item, score: bestScore });
      }
    }
    if (scoredByTitle.length > 0) {
      scoredByTitle.sort((a, b) => (b.score - a.score) || sortByRecency(a.item, b.item));
      const best = scoredByTitle[0].item;
      const chosen = pickBestCandidatePath(best.workspaces, nameHints, options);
      if (chosen) {
        return { cwd: chosen, source: 'rpc-dom-title', matchedCascadeId: best.id };
      }
    }
  }

  // 4. 点击时 DOM 工作区/项目名匹配 basename
  if (nameHints.length > 0) {
    const lowerHints = new Set(nameHints.map((h) => h.toLowerCase()));
    const byWsName = entries.filter((item) =>
      item.workspaces.some((ws) => lowerHints.has(pathBasenameCrossPlatform(ws).toLowerCase()))
    );
    if (byWsName.length > 0) {
      byWsName.sort(sortByRecency);
      const best = byWsName[0];
      const chosen = pickBestCandidatePath(best.workspaces, nameHints, options);
      if (chosen) {
        return { cwd: chosen, source: 'rpc-dom-workspace-name', matchedCascadeId: best.id };
      }
    }
  }

  // 5. contextCascadeId 匹配
  const contextCascadeId = typeof options.contextCascadeId === 'string' ? options.contextCascadeId.trim() : '';
  if (contextCascadeId && summaries[contextCascadeId]) {
    const cands = extractWorkspacesFromTrajectory(summaries[contextCascadeId], options);
    const chosen = pickBestCandidatePath(cands, nameHints, options);
    if (chosen) {
      return { cwd: chosen, source: 'rpc-context-cascade', matchedCascadeId: contextCascadeId };
    }
  }

  // 6. 最近查看 / 活跃会话回退
  entries.sort(sortByRecency);
  const latest = entries[0];
  const chosen = pickBestCandidatePath(latest.workspaces, nameHints, options);
  if (chosen) {
    return { cwd: chosen, source: 'rpc-latest', matchedCascadeId: latest.id };
  }
  return null;
}

function extractWorkspaceFromBrainDir(brainDir, cascadeId, options = {}) {
  if (!brainDir || !cascadeId) return null;
  const sessDir = path.join(path.resolve(brainDir), String(cascadeId).trim());
  if (!fs.existsSync(sessDir)) return null;
  for (const name of ['metadata.json', 'session.json', 'workspace.json']) {
    const p = path.join(sessDir, name);
    if (!fs.existsSync(p)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      const raw = parsed?.workspacePath || parsed?.cwd || parsed?.workspaceUri || '';
      if (!raw) continue;
      const norm = normalizeWorkspacePath(String(raw), options);
      if (norm) return norm;
    } catch {}
  }
  return null;
}

module.exports = {
  TERMINAL_CATALOG,
  TERMINAL_LABELS,
  CLI_PERMISSION_MODES,
  resolvePermissionArgs,
  parseQuickCommands,
  getWindowsHelperPath,
  normalizeWorkspacePath,
  extractWorkspacesFromTrajectory,
  resolveWorkspaceFromTrajectories,
  extractWorkspaceFromBrainDir,
  escapePosixArg,
  formatCliArgToken,
  buildDefaultCliCommand,
  escapeAppleScriptString,
  escapePowerShellSingleQuoted,
  toWslPath,
  sanitizeMuxHost,
  findInPath,
  detectRexAppPath,
  detectAvailableTerminals,
  detectTerminalPath,
  verifyTerminalPath,
  listSshMuxHosts,
  buildLaunchPlan
};
