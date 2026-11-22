'use strict';

const fs = require('fs');
const path = require('path');

function escapePosixArg(arg) {
  return "'" + String(arg ?? '').replace(/'/g, "'\\''") + "'";
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
  for (const dir of String(rawPath).split(sep).filter(Boolean)) {
    const cand = pathMod.join(dir, binName);
    try {
      if (existsSync(cand)) return cand;
    } catch {}
  }
  return null;
}

const TERMINAL_CATALOG = Object.freeze([
  'terminal', 'iterm2', 'ghostty', 'warp', 'kitty', 'wezterm', 'cmux',
  'alacritty', 'rex', 'wt', 'powershell', 'cmd', 'wsl'
]);

function getWindowsHelperPath() {
  return path.resolve(__dirname, '..', 'scripts', 'cli-window-helper.cs');
}

function detectAvailableTerminals(options = {}) {
  const platform = options.platform || process.platform;
  const existsSync = options.existsSync || fs.existsSync;
  const found = [];

  if (platform === 'darwin') {
    const apps = [
      { id: 'terminal', name: 'Terminal.app', path: '/System/Applications/Utilities/Terminal.app' },
      { id: 'iterm2', name: 'iTerm2', path: '/Applications/iTerm.app' },
      { id: 'ghostty', name: 'Ghostty', path: '/Applications/Ghostty.app' },
      { id: 'warp', name: 'Warp', path: '/Applications/Warp.app' },
      { id: 'cmux', name: 'cmux', bin: 'cmux', path: '/Applications/cmux.app' },
      { id: 'wezterm', name: 'WezTerm', bin: 'wezterm', path: '/Applications/WezTerm.app' },
      { id: 'kitty', name: 'Kitty', bin: 'kitty', path: '/Applications/kitty.app' },
      { id: 'alacritty', name: 'Alacritty', bin: 'alacritty', path: '/Applications/Alacritty.app' }
    ];
    for (const a of apps) {
      const binFound = a.bin ? findInPath(a.bin, options) : null;
      if (existsSync(a.path) || binFound) {
        found.push({ id: a.id, name: a.name, path: binFound || a.path, available: true });
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

function buildLaunchPlan(options = {}) {
  const platform = options.platform || process.platform;
  const terminalApp = String(options.terminalApp || 'auto').toLowerCase();
  const cwd = options.cwd || process.cwd();
  const cliBin = options.cliBin || 'agy';
  const extraArgs = Array.isArray(options.commandArgs) ? options.commandArgs.map(String) : [];

  const cliArgs = [];
  if (options.cliSkipPermissions) cliArgs.push('--dangerously-skip-permissions');
  if (options.cliDefaultModel) cliArgs.push('--model', String(options.cliDefaultModel));
  cliArgs.push(...extraArgs);

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

  if (platform === 'win32') {
    const psCmdParts = [
      `Set-Location -LiteralPath '${escapePowerShellSingleQuoted(cwd)}'`,
      `& '${escapePowerShellSingleQuoted(cliBin)}' ${cliArgs.map((a) => `'${escapePowerShellSingleQuoted(a)}'`).join(' ')}`.trim()
    ];
    const commandLine = psCmdParts.join('; ');
    const targetTerm = terminalApp === 'auto' ? 'wt' : terminalApp;
    if (targetTerm === 'wsl') {
      const wslCwd = toWslPath(cwd);
      return {
        ok: true,
        platform,
        terminalId: 'wsl',
        executable: 'wsl.exe',
        args: ['--cd', wslCwd, '--', cliBin, ...cliArgs],
        env,
        cwd: wslCwd,
        muxHost: cleanMux,
        windowsHelperPath: getWindowsHelperPath()
      };
    }
    if (targetTerm === 'wt') {
      return {
        ok: true,
        platform,
        terminalId: 'wt',
        executable: 'wt.exe',
        args: ['-d', cwd, 'powershell.exe', '-NoExit', '-Command', commandLine],
        env,
        cwd,
        muxHost: cleanMux,
        windowsHelperPath: getWindowsHelperPath()
      };
    }
    return {
      ok: true,
      platform,
      terminalId: 'powershell',
      executable: 'powershell.exe',
      args: ['-NoExit', '-Command', commandLine],
      env,
      cwd,
      muxHost: cleanMux,
      windowsHelperPath: getWindowsHelperPath()
    };
  }

  const posixCmd = [escapePosixArg(cliBin), ...cliArgs.map(escapePosixArg)].join(' ');
  const fullShellCmd = `cd ${escapePosixArg(cwd)} && ${posixCmd}`;
  const wrappedCmd = cleanMux
    ? `ssh -t ${escapePosixArg(cleanMux)} ${escapePosixArg(fullShellCmd)}`
    : fullShellCmd;

  let chosenTerm = terminalApp;
  if (chosenTerm === 'auto') {
    chosenTerm = platform === 'darwin' ? 'terminal' : 'xterm';
  }

  if (chosenTerm === 'rex') {
    return {
      ok: true,
      platform,
      terminalId: 'rex',
      executable: 'rex',
      args: cleanMux ? ['run', '--host', cleanMux, '--', 'sh', '-lc', fullShellCmd] : ['run', '--', 'sh', '-lc', fullShellCmd],
      env,
      cwd,
      muxHost: cleanMux
    };
  }

  if (chosenTerm === 'wezterm') {
    return {
      ok: true,
      platform,
      terminalId: 'wezterm',
      executable: 'wezterm',
      args: cleanMux ? ['cli', 'spawn', '--domain-name', cleanMux, '--cwd', cwd, '--', cliBin, ...cliArgs] : ['start', '--cwd', cwd, '--', cliBin, ...cliArgs],
      env,
      cwd,
      muxHost: cleanMux
    };
  }

  if (chosenTerm === 'tmux') {
    return {
      ok: true,
      platform,
      terminalId: 'tmux',
      executable: 'tmux',
      args: ['new-window', '-c', cwd, wrappedCmd],
      env,
      cwd,
      muxHost: cleanMux
    };
  }

  if (platform === 'darwin') {
    if (chosenTerm === 'iterm2') {
      return {
        ok: true,
        platform,
        terminalId: 'iterm2',
        executable: 'osascript',
        args: ['-e', `tell application "iTerm" to create window with default profile command "${escapeAppleScriptString(wrappedCmd)}"`],
        env,
        cwd,
        muxHost: cleanMux
      };
    }
    if (chosenTerm === 'ghostty' || chosenTerm === 'warp') {
      const appName = chosenTerm === 'ghostty' ? 'Ghostty' : 'Warp';
      return {
        ok: true,
        platform,
        terminalId: chosenTerm,
        executable: 'open',
        args: ['-na', appName, '--args', '-e', 'zsh', '-lc', wrappedCmd],
        env,
        cwd,
        muxHost: cleanMux
      };
    }
    return {
      ok: true,
      platform,
      terminalId: 'terminal',
      executable: 'osascript',
      args: ['-e', `tell application "Terminal" to do script "${escapeAppleScriptString(wrappedCmd)}"`],
      env,
      cwd,
      muxHost: cleanMux
    };
  }

  return {
    ok: true,
    platform,
    terminalId: chosenTerm,
    executable: chosenTerm,
    args: ['-e', 'sh', '-lc', wrappedCmd],
    env,
    cwd,
    muxHost: cleanMux
  };
}

function extractWorkspaceFromBrainDir(brainDir, cascadeId) {
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
      if (String(raw).startsWith('file://')) {
        return decodeURIComponent(new URL(raw).pathname);
      }
      if (path.isAbsolute(raw)) return raw;
    } catch {}
  }
  return null;
}

module.exports = {
  TERMINAL_CATALOG,
  getWindowsHelperPath,
  extractWorkspaceFromBrainDir,
  escapePosixArg,
  escapeAppleScriptString,
  escapePowerShellSingleQuoted,
  toWslPath,
  sanitizeMuxHost,
  findInPath,
  detectAvailableTerminals,
  buildLaunchPlan
};
