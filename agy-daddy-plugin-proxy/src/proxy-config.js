'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_GATEWAY_PORT = 18766;
const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1,127.0.0.0/8,10.0.0.0/8,192.168.0.0/16,172.16.0.0/12,<-loopback>';

function isTestMode() {
  return process.env.AGY_DADDY_TEST_MODE === '1' || process.env.NODE_ENV === 'test';
}

function normalizeProxyUrl(rawUrl) {
  const s = String(rawUrl || '').trim();
  if (!s) return '';
  return s.replace(/^([a-zA-Z0-9+.-]+:\/\/[^/?#]+)\/+$/, '$1');
}

function safeDecodeComponent(raw) {
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function redactProxyUrl(rawUrl) {
  const trimmed = normalizeProxyUrl(rawUrl);
  if (!trimmed) return '';
  try {
    const u = new URL(trimmed);
    if (u.password) u.password = '***';
    return normalizeProxyUrl(u.toString());
  } catch {
    return '';
  }
}

function parseAndValidateProxyUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { ok: false, error: '代理地址不能为空（示例：http://127.0.0.1:7897）' };
  }
  const trimmed = normalizeProxyUrl(rawUrl);
  try {
    const u = new URL(trimmed);
    const validProto = ['http:', 'https:', 'socks5:', 'socks5h:'].includes(u.protocol);
    if (!validProto || !u.hostname) {
      return { ok: false, error: '代理地址格式错误，需包含有效协议(http/https/socks5)与主机名' };
    }
    const afterProto = trimmed.slice(u.protocol.length + 2);
    const authority = afterProto.split(/[/?#]/)[0];
    const hostPort = authority.includes('@') ? authority.split('@').pop() : authority;
    const colonIdx = hostPort.startsWith('[') ? hostPort.indexOf(']:') : hostPort.lastIndexOf(':');
    let portNum;
    if (colonIdx !== -1) {
      const explicitPort = hostPort.startsWith('[') ? hostPort.slice(colonIdx + 2) : hostPort.slice(colonIdx + 1);
      if (!/^\d+$/.test(explicitPort)) {
        return { ok: false, error: '代理地址格式错误，需包含有效协议(http/https/socks5)与端口(1-65535)' };
      }
      portNum = Number(explicitPort);
    } else {
      portNum = u.protocol === 'https:' ? 443 : (u.protocol.startsWith('socks') ? 1080 : 80);
    }
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return { ok: false, error: '代理地址格式错误，需包含有效协议(http/https/socks5)与端口(1-65535)' };
    }
    const cleanHost = u.hostname.replace(/^\[|\]$/g, '');
    return {
      ok: true,
      value: trimmed,
      protocol: u.protocol,
      hostname: cleanHost,
      port: portNum,
      username: safeDecodeComponent(u.username || ''),
      password: safeDecodeComponent(u.password || ''),
      isSocks: u.protocol === 'socks5:' || u.protocol === 'socks5h:'
    };
  } catch {
    return { ok: false, error: '代理地址格式错误，请检查协议、主机与端口' };
  }
}

function ipToUint32(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let num = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    num = ((num << 8) | n) >>> 0;
  }
  return num;
}

function matchesNoProxy(hostname, noProxyList) {
  const host = String(hostname || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return false;
  const raw = String(noProxyList || '').trim();
  if (!raw) return false;

  const hostIp = ipToUint32(host);
  const tokens = raw.split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const token of tokens) {
    if (token === '*') return true;
    if (token === '<local>' || token === '<-loopback>') {
      if (!host.includes('.') || host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
      continue;
    }
    if (token.includes('/')) {
      const [netStr, prefixStr] = token.split('/');
      const netIp = ipToUint32(netStr);
      const prefix = Number(prefixStr);
      if (hostIp !== null && netIp !== null && Number.isInteger(prefix) && prefix >= 0 && prefix <= 32) {
        const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
        if ((hostIp & mask) === (netIp & mask)) return true;
      }
      continue;
    }
    let pattern = token;
    const colonIdx = pattern.lastIndexOf(':');
    if (colonIdx > 0 && /^\d+$/.test(pattern.slice(colonIdx + 1)) && !pattern.startsWith('[')) {
      pattern = pattern.slice(0, colonIdx);
    }
    pattern = pattern.replace(/^\[|\]$/g, '');
    if (pattern.startsWith('*.')) pattern = pattern.slice(1);
    if (pattern.startsWith('.')) {
      if (host === pattern.slice(1) || host.endsWith(pattern)) return true;
    } else if (host === pattern || host.endsWith('.' + pattern)) {
      return true;
    }
  }
  return false;
}

function normalizeBypassListForCompare(rawVal) {
  return String(rawVal || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .map((s) => (s === '<local>' ? '<-loopback>' : s))
    .filter(Boolean)
    .join(',');
}

function getProxyCandidatePaths(customPath = null, options = {}) {
  const candidates = [];
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const home = options.homeDir || os.homedir();
  if (env.ANTIGRAVITY_PROXY_CONFIG) {
    candidates.push(path.resolve(env.ANTIGRAVITY_PROXY_CONFIG));
  }
  if (customPath && typeof customPath === 'string') {
    candidates.push(path.resolve(customPath));
  }
  if (env.AG_METER_STATE_DIR) {
    const resolvedState = path.resolve(env.AG_METER_STATE_DIR);
    candidates.push(
      path.join(resolvedState, 'modules.json'),
      path.join(resolvedState, 'proxy.json')
    );
  }
  const localBase = env.LOCALAPPDATA || (platform === 'win32'
    ? path.join(home, 'AppData', 'Local')
    : platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : (env.XDG_CONFIG_HOME || path.join(home, '.config')));

  candidates.push(
    path.join(localBase, 'AgyDaddy', 'plugins-data', 'agy-daddy.proxy', 'config.json'),
    path.join(localBase, 'AntigravityContextMeter', 'modules.json'),
    path.join(localBase, 'AntigravityContextMeter', 'proxy.json'),
    path.join(localBase, 'AntigravityProxyNoTun', 'config.json')
  );

  return candidates;
}

function detectProxyConfig(options = {}) {
  const candidates = options.candidates || getProxyCandidatePaths(options.configPath, options);
  const fsImpl = options.fs || fs;

  for (const cfgPath of candidates) {
    try {
      if (!fsImpl.existsSync(cfgPath)) continue;
      const content = fsImpl.readFileSync(cfgPath, 'utf8');
      if (!content || !content.trim()) {
        if (path.basename(cfgPath) === 'modules.json') {
          return { detected: true, enabled: false, configPath: cfgPath, parseError: 'empty_file' };
        }
        continue;
      }
      const cfg = JSON.parse(content);
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
        if (path.basename(cfgPath) === 'modules.json') {
          return { detected: true, enabled: false, configPath: cfgPath, parseError: 'invalid_schema' };
        }
        continue;
      }
      const isUnified = path.basename(cfgPath) === 'modules.json';
      if (isUnified && (!cfg.modules || typeof cfg.modules !== 'object' || Array.isArray(cfg.modules))) {
        return { detected: true, enabled: false, configPath: cfgPath, parseError: 'invalid_modules_schema' };
      }
      const proxyNode = (cfg.modules && cfg.modules.proxy && typeof cfg.modules.proxy === 'object' && !Array.isArray(cfg.modules.proxy))
        ? cfg.modules.proxy
        : (isUnified ? null : cfg);

      if (!proxyNode) {
        return { detected: true, enabled: false, configPath: cfgPath, parseError: 'invalid_proxy_schema' };
      }

      if (proxyNode.enabled === false) {
        return { detected: true, enabled: false, configPath: cfgPath };
      }

      if (isUnified && proxyNode.enabled !== true) {
        return { detected: true, enabled: false, configPath: cfgPath };
      }

      const httpProxy = normalizeProxyUrl(proxyNode.httpProxy || proxyNode.proxyUrl || proxyNode.upstreamUrl || '');
      if (!httpProxy) {
        if (isUnified) return { detected: true, enabled: false, configPath: cfgPath, parseError: 'missing_proxy_url' };
        continue;
      }

      const rawNoProxy = proxyNode.noProxy !== undefined ? proxyNode.noProxy : proxyNode.bypassList;
      const noProxy = (rawNoProxy !== undefined && rawNoProxy !== null)
        ? String(rawNoProxy).trim()
        : DEFAULT_NO_PROXY;
      const allProxy = normalizeProxyUrl(proxyNode.allProxy || httpProxy) || httpProxy;

      return {
        detected: true,
        enabled: true,
        configPath: cfgPath,
        httpProxy,
        allProxy,
        noProxy
      };
    } catch (e) {
      if (path.basename(cfgPath) === 'modules.json') {
        return { detected: true, enabled: false, configPath: cfgPath, parseError: e?.message || 'parse_error' };
      }
      continue;
    }
  }

  return { detected: false, enabled: false, configPath: null };
}

function applyProxyEnvironment(targetEnv = process.env, options = {}) {
  const detected = options.proxyOverride || detectProxyConfig(options);
  if (!detected.enabled || !detected.httpProxy) {
    return targetEnv;
  }

  const { httpProxy, allProxy, noProxy } = detected;
  const override = Boolean(options && options.overrideExisting);

  for (const k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) {
    if (override || !targetEnv[k]) targetEnv[k] = httpProxy;
  }

  if (allProxy) {
    for (const k of ['ALL_PROXY', 'all_proxy']) {
      if (override || !targetEnv[k]) targetEnv[k] = allProxy;
    }
  }

  if (noProxy !== undefined && noProxy !== null) {
    for (const k of ['NO_PROXY', 'no_proxy']) {
      if (noProxy) {
        if (override || !targetEnv[k]) targetEnv[k] = noProxy;
      } else if (override) {
        delete targetEnv[k];
      }
    }
  }

  if (override) {
    targetEnv.NODE_USE_ENV_PROXY = '1';
  }

  return targetEnv;
}

function buildCliProxyEnv(baseEnv = process.env, options = {}) {
  const env = { ...baseEnv };
  delete env.ELECTRON_RUN_AS_NODE;

  applyProxyEnvironment(env, options);

  delete env.NO_COLOR;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';

  return env;
}

const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];

function detectLoginShellProxyConflict(options = {}) {
  let rawOut = null;
  let checked = false;

  if (typeof options.envOutput === 'string') {
    rawOut = options.envOutput;
    checked = true;
  } else if (!isTestMode() && (options.platform || process.platform) === 'darwin') {
    checked = true;
    try {
      rawOut = execFileSync('zsh', ['-ilc', 'env'], {
        env: { ...process.env, ANTIGRAVITY_RESOLVING_ENVIRONMENT: '1' },
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch (err) {
      return {
        checked: false,
        hasConflict: false,
        conflictingVars: [],
        error: err?.message || 'zsh_probe_failed'
      };
    }
  }

  if (!checked || rawOut === null) {
    return { checked: false, hasConflict: false, conflictingVars: [] };
  }

  const conflictingVars = [];
  for (const line of String(rawOut).split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (PROXY_ENV_KEYS.includes(key) && val) {
      conflictingVars.push({ key, value: redactProxyUrl(val) || val });
    }
  }

  return {
    checked: true,
    hasConflict: conflictingVars.length > 0,
    conflictingVars
  };
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function generateLaunchAgentPlist(options = {}) {
  const label = options.label || 'com.agy-daddy.proxy-gateway';
  const nodePath = options.nodePath || process.execPath;
  const gatewayScriptPath = options.gatewayScriptPath || path.resolve(__dirname, 'gateway-bin.js');
  const configPath = options.configPath || path.join(os.homedir(), 'Library', 'Application Support', 'AgyDaddy', 'plugins-data', 'agy-daddy.proxy', 'config.json');
  const logPath = options.logPath || path.join(os.homedir(), 'Library', 'Logs', 'agy-daddy-proxy.log');
  const port = Number(options.port || DEFAULT_GATEWAY_PORT);

  const args = [nodePath, gatewayScriptPath, '--config', configPath, '--port', String(port)];
  const envEntries = options.isElectron ? { ELECTRON_RUN_AS_NODE: '1' } : (options.env || {});
  const envLines = Object.entries(envEntries)
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
${args.map((a) => `    <string>${escapeXml(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>${envLines ? `\n  <key>EnvironmentVariables</key>\n  <dict>\n${envLines}\n  </dict>` : ''}
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;
}

module.exports = {
  DEFAULT_GATEWAY_PORT,
  DEFAULT_NO_PROXY,
  isTestMode,
  normalizeProxyUrl,
  redactProxyUrl,
  normalizeBypassListForCompare,
  parseAndValidateProxyUrl,
  matchesNoProxy,
  getProxyCandidatePaths,
  detectProxyConfig,
  applyProxyEnvironment,
  buildCliProxyEnv,
  detectLoginShellProxyConflict,
  generateLaunchAgentPlist
};
