'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const { isTestMode } = require('./paths');

function discoverDevToolsPorts(options = {}) {
  const fsImpl = options.fs || fs;
  const env = options.env || process.env;
  const home = options.homeDir || os.homedir();
  const platform = options.platform || process.platform;
  const ports = [];
  const pushPort = (raw) => {
    const num = Number(String(raw || '').trim());
    if (Number.isInteger(num) && num > 0 && num <= 65535 && !ports.includes(num)) {
      ports.push(num);
    }
  };

  if (env.AGY_DADDY_CDP_PORT || env.AG_CDP_PORT) {
    pushPort(env.AGY_DADDY_CDP_PORT || env.AG_CDP_PORT);
  }

  const appDataRoots = [];
  const pushRoot = (dirPath) => {
    if (!dirPath) return;
    const norm = platform === 'win32' ? dirPath.toLowerCase() : dirPath;
    if (!appDataRoots.some((r) => (platform === 'win32' ? r.toLowerCase() : r) === norm)) {
      appDataRoots.push(dirPath);
    }
  };

  if (platform === 'win32') {
    pushRoot(env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'));
    pushRoot(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'));
  } else if (platform === 'darwin') {
    pushRoot(env.APPDATA || path.join(home, 'Library', 'Application Support'));
  } else {
    pushRoot(env.APPDATA || env.XDG_CONFIG_HOME || path.join(home, '.config'));
  }

  for (const rootDir of appDataRoots) {
    for (const dirName of ['Antigravity', 'antigravity-ide']) {
      try {
        const portFile = platform === 'win32'
          ? path.win32.join(rootDir, dirName, 'DevToolsActivePort')
          : path.join(rootDir, dirName, 'DevToolsActivePort');
        if (fsImpl.existsSync(portFile)) {
          const firstLine = fsImpl.readFileSync(portFile, 'utf8').split(/\r?\n/)[0];
          pushPort(firstLine);
        }
      } catch {}
    }
  }

  if (!isTestMode() && platform === 'darwin' && options.allowLsof !== false) {
    try {
      const out = execFileSync(
        'lsof',
        ['-nP', '-a', '-c', 'Antigravity', '-iTCP', '-sTCP:LISTEN'],
        { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const re = /(?:127\.0\.0\.1|localhost|\[::1\]|\*):(\d+)\s+\(LISTEN\)/g;
      let m;
      while ((m = re.exec(out)) !== null) {
        pushPort(m[1]);
      }
    } catch {}
  }

  return ports;
}

function fetchHttpJsonLoopback(port, urlPath, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method: 'GET',
      agent: false
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function resolveActiveCdpTarget(options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 1500;
  const ports = Array.isArray(options.ports) ? options.ports : discoverDevToolsPorts(options);
  const fetchJson = options.fetchJson || fetchHttpJsonLoopback;
  let validCdpPort = null;
  for (const port of ports) {
    try {
      const pages = await fetchJson(port, '/json/list', timeoutMs);
      if (!Array.isArray(pages)) continue;
      if (!validCdpPort) validCdpPort = port;
      const targets = pages.filter(
        (p) => p && p.type === 'page' && /^https:\/\/127\.0\.0\.1:\d+\//.test(String(p.url || ''))
      );
      if (targets.length > 0) {
        return { port, pages, targets };
      }
    } catch {}
  }
  return { port: validCdpPort, pages: [], targets: [] };
}

function parsePsElapsedSeconds(raw) {
  const clean = String(raw || '').trim();
  if (!clean) return null;
  const m = clean.match(/^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  const days = Number(m[1] || 0);
  const hours = Number(m[2] || 0);
  const mins = Number(m[3] || 0);
  const secs = Number(m[4] || 0);
  if (![days, hours, mins, secs].every(Number.isFinite)) return null;
  return days * 86400 + hours * 3600 + mins * 60 + secs;
}

function parseWinCreationElapsedSeconds(rawDate, nowMs = Date.now()) {
  if (!rawDate) return null;
  const s = String(rawDate).trim();
  if (!s) return null;
  let ts = NaN;
  const msMatch = s.match(/\/Date\((\d+)(?:[+-]\d+)?\)\//);
  if (msMatch) {
    ts = Number(msMatch[1]);
  } else {
    ts = Date.parse(s);
  }
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.floor((nowMs - ts) / 1000));
}

function inspectAntigravityHostProcess(options = {}) {
  const empty = { running: false, pid: null, hasDebugSwitch: false, elapsedSec: null, command: '' };
  const platform = options.platform || process.platform;
  if (isTestMode() && typeof options.psOutput !== 'string' && options.winProcessJson === undefined) {
    return empty;
  }

  if (platform === 'win32') {
    let rawJson = options.winProcessJson;
    if (rawJson === undefined) {
      try {
        rawJson = execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            "Get-CimInstance Win32_Process -Filter \"Name='Antigravity.exe'\" | Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress"
          ],
          {
            encoding: 'utf8',
            timeout: 2500,
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true
          }
        );
      } catch {
        return empty;
      }
    }
    let rows = [];
    if (typeof rawJson === 'string') {
      const trimmed = rawJson.trim();
      if (!trimmed) return empty;
      try {
        const parsed = JSON.parse(trimmed);
        rows = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
      } catch {
        return empty;
      }
    } else if (Array.isArray(rawJson)) {
      rows = rawJson;
    } else if (rawJson && typeof rawJson === 'object') {
      rows = [rawJson];
    }
    const nowMs = typeof options.now === 'function' ? options.now() : Date.now();
    for (const row of rows) {
      const pid = Number(row?.ProcessId ?? row?.pid);
      const cmd = String(row?.CommandLine ?? row?.command ?? '').trim();
      if (!Number.isInteger(pid) || pid <= 0 || !cmd) continue;
      if (/--type=|--import=|language_server|chrome_crashpad_handler|agy-daddy|ELECTRON_RUN_AS_NODE|--headless(?:\s|=|$)/i.test(cmd)) {
        continue;
      }
      return {
        running: true,
        pid,
        hasDebugSwitch: /--remote-debugging-port(?:=|\s|$)/i.test(cmd),
        elapsedSec: parseWinCreationElapsedSeconds(row?.CreationDate, nowMs),
        command: cmd
      };
    }
    return empty;
  }

  let psOut = '';
  if (typeof options.psOutput === 'string') {
    psOut = options.psOutput;
  } else if (platform === 'darwin') {
    try {
      psOut = execFileSync('ps', ['-ax', '-o', 'pid=,etime=,command='], {
        encoding: 'utf8',
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch {
      return empty;
    }
  } else if (platform === 'linux') {
    try {
      psOut = execFileSync('ps', ['-eo', 'pid=,etime=,args='], {
        encoding: 'utf8',
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch {
      return empty;
    }
  } else {
    return empty;
  }

  for (const line of psOut.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+([0-9:-]+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const etime = m[2];
    const cmd = m[3].trim();
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (platform === 'darwin') {
      if (!/\/Contents\/MacOS\/Antigravity(?:\s|$)/.test(cmd)) continue;
      if (/Antigravity Helper|language_server|chrome_crashpad_handler|--type=|--import=|--headless(?:\s|=|$)/i.test(cmd)) continue;
    } else {
      if (!/(?:^|\/)antigravity(?:\.AppImage)?(?:\s|$)/i.test(cmd)) continue;
      if (/Antigravity Helper|language_server|chrome_crashpad_handler|--type=|--import=|--headless(?:\s|=|$)|agy-daddy|ELECTRON_RUN_AS_NODE/i.test(cmd)) continue;
    }
    return {
      running: true,
      pid,
      hasDebugSwitch: /--remote-debugging-port(?:=|\s|$)/.test(cmd),
      elapsedSec: parsePsElapsedSeconds(etime),
      command: cmd
    };
  }

  return empty;
}

class CdpClient extends EventEmitter {
  constructor(wsUrl, options = {}) {
    super();
    this.wsUrl = wsUrl;
    this.WebSocketCtor = options.WebSocket || globalThis.WebSocket;
    this.timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 5000;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.executionContexts = new Map();
  }

  async connect() {
    if (this.ws) return;
    if (typeof this.WebSocketCtor !== 'function') {
      throw new Error('WebSocket implementation unavailable');
    }
    const ws = new this.WebSocketCtor(this.wsUrl);
    this.ws = ws;
    await new Promise((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(); };
      const onErr = (err) => { cleanup(); reject(err?.error || new Error('CDP WebSocket connection failed')); };
      const cleanup = () => {
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onErr);
      };
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onErr);
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) {
          entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          entry.resolve(msg.result || {});
        }
        return;
      }
      if (msg.method === 'Runtime.executionContextCreated' && msg.params?.context) {
        this.executionContexts.set(msg.params.context.id, msg.params.context);
        this.emit('executionContextCreated', msg.params.context);
      } else if (msg.method === 'Runtime.executionContextDestroyed' && msg.params?.executionContextId !== undefined) {
        this.executionContexts.delete(msg.params.executionContextId);
        this.emit('executionContextDestroyed', msg.params.executionContextId);
      } else if (msg.method === 'Runtime.executionContextsCleared') {
        this.executionContexts.clear();
        this.emit('executionContextsCleared');
      } else if (msg.method === 'Runtime.bindingCalled') {
        this.emit('bindingCalled', msg.params);
      } else if (msg.method === 'Page.frameNavigated') {
        this.emit('frameNavigated', msg.params);
      }
    });

    ws.addEventListener('close', () => {
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error('CDP connection closed'));
      }
      this.pending.clear();
      this.emit('close');
    });
  }

  send(method, params = {}) {
    if (!this.ws) return Promise.reject(new Error('CDP client not connected'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timeout`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async enable() {
    await this.send('Runtime.enable', {});
    try { await this.send('Page.enable', {}); } catch {}
  }

  async getMainFrameId() {
    const res = await this.send('Page.getFrameTree', {});
    return res?.frameTree?.frame?.id || null;
  }

  async createIsolatedWorld(frameId, worldName) {
    const res = await this.send('Page.createIsolatedWorld', {
      frameId,
      worldName,
      grantUniveralAccess: false
    });
    return res.executionContextId;
  }

  async evaluate(expression, options = {}) {
    const params = {
      expression,
      returnByValue: options.returnByValue !== false,
      awaitPromise: options.awaitPromise !== false
    };
    if (typeof options.contextId === 'number') {
      params.contextId = options.contextId;
    }
    const res = await this.send('Runtime.evaluate', params);
    if (res.exceptionDetails) {
      const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Runtime evaluation error';
      throw new Error(desc);
    }
    return res.result?.value;
  }

  async addBinding(name, executionContextId) {
    const params = { name };
    if (typeof executionContextId === 'number') {
      params.executionContextId = executionContextId;
    }
    return this.send('Runtime.addBinding', params);
  }

  close() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }
}

module.exports = {
  discoverDevToolsPorts,
  resolveActiveCdpTarget,
  parsePsElapsedSeconds,
  inspectAntigravityHostProcess,
  CdpClient
};
