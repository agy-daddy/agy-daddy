'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { RPC_READ_ALLOWLIST, RPC_WRITE_ALLOWLIST } = require('../contracts/constants');
const { resolveActiveCdpTarget, CdpClient } = require('./cdp');

function loopbackRequest(url, body, token) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.request(url, {
      rejectUnauthorized: false,
      agent: false,
      method: body ? 'POST' : 'GET',
      headers: body
        ? {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'x-codeium-csrf-token': token
          }
        : {}
    }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        if (response.statusCode === 200) {
          resolve(text);
        } else {
          reject(new Error(`HTTP ${response.statusCode}: ${text.slice(0, 200)}`));
        }
      });
    });
    req.setTimeout(20000, () => req.destroy(new Error('Local API timeout')));
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

function discoverFromHubDaemonFiles(options = {}) {
  const fsImpl = options.fs || fs;
  const home = options.homeDir || os.homedir();
  const daemonDirs = Array.isArray(options.daemonDirs)
    ? options.daemonDirs
    : ['antigravity', 'antigravity-ide'].map((dir) => path.join(home, '.gemini', dir, 'daemon'));

  const candidates = [];
  for (const dirPath of daemonDirs) {
    let entries;
    try {
      entries = fsImpl.readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!/^hub_\d+\.json$/.test(name)) continue;
      const fullPath = path.join(dirPath, name);
      try {
        const stat = fsImpl.statSync(fullPath);
        const parsed = JSON.parse(fsImpl.readFileSync(fullPath, 'utf8'));
        const csrfToken = typeof parsed?.csrfToken === 'string' ? parsed.csrfToken.trim() : '';
        const httpsPort = typeof parsed?.httpsPort === 'number' && parsed.httpsPort > 0 ? parsed.httpsPort : null;
        const httpPort = typeof parsed?.httpPort === 'number' && parsed.httpPort > 0 ? parsed.httpPort : null;
        const port = httpsPort || httpPort;
        if (!csrfToken || !port) continue;
        const protocol = httpsPort ? 'https' : 'http';
        candidates.push({
          mtimeMs: stat.mtimeMs,
          origin: `${protocol}://127.0.0.1:${port}`,
          csrfToken,
          source: 'hub-daemon'
        });
      } catch {}
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0] || null;
}

async function resolveHostCredentials(options = {}) {
  // 1. 尝试从活跃 CDP 页面提取 window.__APP_CONFIG__ 凭据
  if (!options.skipCdp) {
    try {
      const { targets } = await resolveActiveCdpTarget({ timeoutMs: options.timeoutMs || 1800, ...options });
      const page = targets[0];
      if (page) {
        const origin = new URL(page.url).origin;
        if (page.webSocketDebuggerUrl) {
          const client = new CdpClient(page.webSocketDebuggerUrl, options);
          try {
            await client.connect();
            const token = await client.evaluate('window.__APP_CONFIG__?.csrfToken || ""');
            if (token && typeof token === 'string') {
              return { origin, csrfToken: token, page, source: 'cdp-app-config' };
            }
          } finally {
            client.close();
          }
        }
        // 2. 页面 HTML 回退
        try {
          const reqFn = options.request || loopbackRequest;
          const html = await reqFn(origin + '/');
          const match = String(html).match(/window\.__APP_CONFIG__\s*=\s*(.*?);/);
          if (match) {
            const parsed = JSON.parse(match[1]);
            if (parsed?.csrfToken) {
              return { origin, csrfToken: parsed.csrfToken, page, source: 'http-html-bootstrap' };
            }
          }
        } catch {}
      }
    } catch {}
  }

  // 3. 回退到 daemon/hub_<port>.json
  const hub = discoverFromHubDaemonFiles(options);
  if (hub) {
    return { origin: hub.origin, csrfToken: hub.csrfToken, page: null, source: hub.source };
  }

  throw new Error('Unable to resolve LanguageServer RPC credentials');
}

function createRpcTransport(options = {}) {
  const reqFn = options.request || loopbackRequest;
  let cached = null;

  async function ensureCreds(forceRefresh = false) {
    if (!cached || forceRefresh) {
      cached = await resolveHostCredentials(options);
    }
    return cached;
  }

  return {
    async getOrigin() {
      const creds = await ensureCreds(false);
      return creds.origin;
    },
    async call(method, body = {}) {
      let creds = await ensureCreds(false);
      try {
        const text = await reqFn(
          `${creds.origin}/exa.language_server_pb.LanguageServerService/${method}`,
          body,
          creds.csrfToken
        );
        return JSON.parse(text);
      } catch (err) {
        if (/HTTP 401|HTTP 403|ECONNREFUSED|timeout/i.test(String(err?.message || ''))) {
          creds = await ensureCreds(true);
          const text = await reqFn(
            `${creds.origin}/exa.language_server_pb.LanguageServerService/${method}`,
            body,
            creds.csrfToken
          );
          return JSON.parse(text);
        }
        throw err;
      }
    },
    resetCache() {
      cached = null;
    }
  };
}

function createScopedRpcClient(pluginId, permissions = [], transport) {
  const perms = new Set(Array.isArray(permissions) ? permissions : []);
  const canRead = perms.has('rpc:read');
  const canWrite = perms.has('rpc:write');

  return {
    getOrigin() {
      if (!canRead && !canWrite) {
        throw new Error(`RPC_PERMISSION_DENIED: ${pluginId} lacks rpc:read/rpc:write`);
      }
      return transport.getOrigin();
    },
    async call(method, body = {}) {
      const m = String(method || '').trim();
      if (RPC_READ_ALLOWLIST.includes(m)) {
        if (!canRead && !canWrite) {
          throw new Error(`RPC_PERMISSION_DENIED: ${pluginId} cannot call read method ${m}`);
        }
        return transport.call(m, body);
      }
      if (RPC_WRITE_ALLOWLIST.includes(m)) {
        if (!canWrite) {
          throw new Error(`RPC_PERMISSION_DENIED: ${pluginId} requires rpc:write to call ${m}`);
        }
        return transport.call(m, body);
      }
      throw new Error(`RPC_METHOD_BLOCKED: ${m} is not in the LanguageServer allowlist`);
    }
  };
}

module.exports = {
  loopbackRequest,
  discoverFromHubDaemonFiles,
  resolveHostCredentials,
  createRpcTransport,
  createScopedRpcClient
};
