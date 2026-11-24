'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function detectCloudflaredBinary(options = {}) {
  if (options.binPath && fs.existsSync(options.binPath)) {
    return { found: true, path: options.binPath };
  }
  const envPath = String((options.env || process.env).PATH || '');
  const sep = process.platform === 'win32' ? ';' : ':';
  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  for (const dir of envPath.split(sep).filter(Boolean)) {
    const cand = path.join(dir, exe);
    if ((options.existsSync || fs.existsSync)(cand)) {
      return { found: true, path: cand };
    }
  }
  const fixed = process.platform === 'darwin'
    ? ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared']
    : (process.platform === 'win32'
      ? ['C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', 'C:\\Program Files\\cloudflared\\cloudflared.exe']
      : ['/usr/bin/cloudflared', '/usr/local/bin/cloudflared']);
  for (const cand of fixed) {
    if ((options.existsSync || fs.existsSync)(cand)) {
      return { found: true, path: cand };
    }
  }
  return { found: false, path: null };
}

function getCloudflaredInstallHints() {
  return {
    darwin: 'brew install cloudflared',
    win32: 'winget install --id Cloudflare.cloudflared',
    linux: 'curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o ~/.local/bin/cloudflared && chmod +x ~/.local/bin/cloudflared',
    docsUrl: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'
  };
}

function parseQuickTunnelUrl(chunk) {
  const m = String(chunk || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return m ? m[0] : '';
}

class CloudflaredManager {
  constructor(options = {}) {
    this.spawnFn = options.spawn || spawn;
    this.detectFn = options.detect || detectCloudflaredBinary;
    this.onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : null;
    this.child = null;
    this.state = {
      active: false,
      mode: null,
      publicUrl: '',
      pid: null,
      error: null
    };
  }

  _notify() {
    if (!this.onStateChange) return;
    try { this.onStateChange(this.getState()); } catch {}
  }

  getState() {
    return {
      ...this.state,
      binary: this.detectFn(),
      installHints: getCloudflaredInstallHints()
    };
  }

  async startQuickTunnel(localPort, options = {}) {
    await this.stop();
    if (options.dryRun) {
      this.state = {
        active: true,
        mode: 'quick',
        publicUrl: options.mockUrl || `https://agy-dryrun-${localPort}.trycloudflare.com`,
        pid: null,
        error: null
      };
      return { ok: true, dryRun: true, ...this.state };
    }

    const bin = this.detectFn();
    if (!bin.found) {
      this.state = { active: false, mode: 'quick', publicUrl: '', pid: null, error: 'CLOUDFLARED_NOT_INSTALLED' };
      return { ok: false, error: 'CLOUDFLARED_NOT_INSTALLED', installHints: getCloudflaredInstallHints() };
    }

    const child = this.spawnFn(bin.path, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${localPort}`], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.child = child;
    this.state = { active: true, mode: 'quick', publicUrl: '', pid: child.pid || null, error: null };

    child.stderr?.on('data', (d) => {
      const url = parseQuickTunnelUrl(d);
      if (url && url !== this.state.publicUrl) {
        this.state.publicUrl = url;
        this._notify();
      }
    });
    child.stdout?.on('data', (d) => {
      const url = parseQuickTunnelUrl(d);
      if (url && url !== this.state.publicUrl) {
        this.state.publicUrl = url;
        this._notify();
      }
    });
    child.once('exit', () => {
      this.state.active = false;
      this.state.pid = null;
      this.child = null;
      this._notify();
    });
    return { ok: true, ...this.state };
  }

  async startNamedTunnel(token, hostname, options = {}) {
    await this.stop();
    if (options.dryRun) {
      this.state = {
        active: true,
        mode: 'named',
        publicUrl: hostname || '',
        pid: null,
        error: null
      };
      return { ok: true, dryRun: true, ...this.state };
    }
    const bin = this.detectFn();
    if (!bin.found) {
      this.state = { active: false, mode: 'named', publicUrl: '', pid: null, error: 'CLOUDFLARED_NOT_INSTALLED' };
      return { ok: false, error: 'CLOUDFLARED_NOT_INSTALLED', installHints: getCloudflaredInstallHints() };
    }
    const child = this.spawnFn(bin.path, ['tunnel', '--no-autoupdate', 'run', '--token', token], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.child = child;
    this.state = { active: true, mode: 'named', publicUrl: hostname || '', pid: child.pid || null, error: null };
    child.once('exit', () => {
      this.state.active = false;
      this.state.pid = null;
      this.child = null;
      this._notify();
    });
    return { ok: true, ...this.state };
  }

  async stop() {
    if (!this.child) {
      this.state.active = false;
      this.state.pid = null;
      return true;
    }
    const ch = this.child;
    this.child = null;
    try { ch.kill('SIGTERM'); } catch {}
    this.state.active = false;
    this.state.pid = null;
    return true;
  }
}

module.exports = {
  detectCloudflaredBinary,
  getCloudflaredInstallHints,
  parseQuickTunnelUrl,
  CloudflaredManager
};
