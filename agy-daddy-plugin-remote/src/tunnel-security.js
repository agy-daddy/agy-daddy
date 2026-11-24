'use strict';

const crypto = require('node:crypto');

const DEFAULT_REMOTE_PORT = 18765;
const PERMISSION_LEVELS = Object.freeze(['L0', 'L1', 'L2']);
const PERMISSION_RANK = Object.freeze({ L0: 0, L1: 1, L2: 2 });
const DEFAULT_CONFIRM_TTL_MS = 60 * 1000;

function normalizePermissionLevel(raw, allowRemoteWriteFallback = false) {
  if (typeof raw === 'string') {
    const clean = raw.trim().toUpperCase();
    if (clean === 'L0' || clean === '0' || clean === 'READONLY' || clean === 'READ-ONLY') return 'L0';
    if (clean === 'L1' || clean === '1' || clean === 'CHAT' || clean === 'WRITE' || clean === 'WRITABLE') return 'L1';
    if (clean === 'L2' || clean === '2' || clean === 'WORKSPACE') return 'L2';
  } else if (typeof raw === 'boolean') {
    return raw ? 'L1' : 'L0';
  }
  return allowRemoteWriteFallback === true ? 'L1' : 'L0';
}

function isPermissionAtLeast(current, required) {
  const curRank = PERMISSION_RANK[normalizePermissionLevel(current)] ?? 0;
  const reqRank = PERMISSION_RANK[normalizePermissionLevel(required)] ?? 0;
  return curRank >= reqRank;
}

const DEFAULT_CHANNELS = Object.freeze({
  loopback: true,
  lan: false,
  tailscale: false,
  bonjour: false,
  cloudflare: false
});

const DEFAULT_REMOTE_DISPLAY_CONFIG = Object.freeze({
  showContextPanel: true,
  showUsagePanel: true,
  showQuotaPill: true,
  showChannelMeta: true,
  showSidebar: true,
  showThinking: true,
  showQuickChips: true,
  showComposerTools: true,
  showApprovals: true
});

function sanitizeRemoteDisplayConfig(raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const out = {};
  for (const [k, defVal] of Object.entries(DEFAULT_REMOTE_DISPLAY_CONFIG)) {
    out[k] = typeof src[k] === 'boolean' ? src[k] : defVal;
  }
  return out;
}

function normalizeChannelConfig(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  return {
    loopback: src.loopback !== false,
    lan: src.lan === true,
    tailscale: src.tailscale === true,
    bonjour: src.bonjour === true,
    cloudflare: src.cloudflare === true
  };
}

function isTailscaleIp(ip) {
  const clean = String(ip || '').replace(/^::ffff:/, '').toLowerCase();
  if (clean.startsWith('fd7a:115c:a1e0:')) return true;
  const parts = clean.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function isLanIp(ip) {
  const clean = String(ip || '').replace(/^::ffff:/, '');
  const parts = clean.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  return false;
}

function classifyRequestChannel(req, cfg = {}) {
  const headers = req?.headers || {};
  const hostHeader = String(headers.host || '').split(':')[0].trim().toLowerCase();
  const forwardedHost = String(headers['x-forwarded-host'] || '').split(',')[0].split(':')[0].trim().toLowerCase();
  const remoteIp = String(req?.socket?.remoteAddress || req?.remoteAddress || '').replace(/^::ffff:/, '').trim().toLowerCase();

  // 1. Cloudflare 隧道流量识别
  if (headers['cf-ray'] || headers['cf-connecting-ip'] || headers['cf-visitor'] || hostHeader.endsWith('.trycloudflare.com')) {
    return 'cloudflare';
  }
  if (cfg.tunnelHostname) {
    try {
      const th = new URL(cfg.tunnelHostname).hostname.toLowerCase();
      if (th && hostHeader === th) return 'cloudflare';
    } catch {}
  }

  // 2. Tailscale 私网流量识别（含 tailscale serve 反向代理头）
  if (
    hostHeader.endsWith('.ts.net') ||
    forwardedHost.endsWith('.ts.net') ||
    Boolean(headers['tailscale-user-login']) ||
    isTailscaleIp(remoteIp)
  ) {
    return 'tailscale';
  }

  // 3. Bonjour (.local) 域名识别
  if (hostHeader.endsWith('.local')) {
    return 'bonjour';
  }

  // 4. 局域网 RFC1918
  if (isLanIp(remoteIp)) {
    return 'lan';
  }

  // 5. 本机回环
  if (!remoteIp || remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === 'localhost') {
    return 'loopback';
  }

  return 'external';
}

function isChannelAllowed(channel, enabledChannels = DEFAULT_CHANNELS) {
  if (!channel || channel === 'external') return false;
  return Boolean(enabledChannels?.[channel]);
}

function extractCloudflareTunnelToken(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const jwtOrB64 = text.match(/\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){0,2}\b/);
  if (jwtOrB64) return jwtOrB64[0];
  const flagMatch = text.match(/(?:--token\s+|TUNNEL_TOKEN=)["']?([A-Za-z0-9._-]{20,})["']?/);
  if (flagMatch) return flagMatch[1];
  const parts = text.split(/\s+/);
  const last = parts[parts.length - 1] || '';
  return /^[A-Za-z0-9._-]{16,}$/.test(last) ? last : text;
}

function decodeBase64JsonObject(b64) {
  try {
    let norm = String(b64 || '').trim().replace(/-/g, '+').replace(/_/g, '/');
    if (!norm || norm.length < 4) return null;
    const mod = norm.length % 4;
    if (mod) norm += '='.repeat(4 - mod);
    const decoded = Buffer.from(norm, 'base64').toString('utf8');
    const obj = JSON.parse(decoded);
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : null;
  } catch {
    return null;
  }
}

function validateCloudflareTunnelToken(raw) {
  const token = extractCloudflareTunnelToken(raw);
  if (!token) {
    return { ok: false, kind: 'invalid', token: '', error: '请填写 Cloudflare Tunnel Token' };
  }

  const segments = token.split('.');
  if (segments.length === 1) {
    const obj = decodeBase64JsonObject(token);
    if (
      obj &&
      typeof obj.a === 'string' && obj.a.length > 0 &&
      typeof obj.t === 'string' && obj.t.length > 0 &&
      typeof obj.s === 'string' && obj.s.length > 0
    ) {
      return { ok: true, kind: 'connector', token, accountTag: obj.a, tunnelId: obj.t, error: '' };
    }
    return { ok: false, kind: 'invalid', token: '', error: '无效的 Cloudflare Tunnel Token（Connector JSON 缺少 a/t/s 字段）' };
  }

  if (segments.length === 3 && segments[2].length > 0) {
    const header = decodeBase64JsonObject(segments[0]);
    const payload = decodeBase64JsonObject(segments[1]);
    if (header && payload) {
      return { ok: true, kind: 'jwt', token, payload, error: '' };
    }
  }

  return { ok: false, kind: 'invalid', token: '', error: '无效的 Cloudflare Tunnel Token（不是合法的 Connector Base64 或 3 段 JWT）' };
}

function validateTunnelHostname(raw) {
  const text = String(raw || '').trim();
  if (!text) return { ok: true, origin: '', error: '' };
  try {
    const u = new URL(text);
    const host = String(u.hostname || '').toLowerCase();
    if (u.protocol !== 'https:' || !host || !host.includes('.')) {
      return { ok: false, origin: '', error: '请填写有效的 Cloudflare HTTPS 固定域名（例如 https://ag.example.com）' };
    }
    if (host === 'cloudflareaccess.com' || host.endsWith('.cloudflareaccess.com')) {
      return { ok: false, origin: '', error: '*.cloudflareaccess.com 是 Cloudflare Access 登录门户而非隧道公网域名；请填写自有域名或使用 Quick 临时隧道' };
    }
    if (host === 'dash.cloudflare.com' || host === 'one.dash.cloudflare.com') {
      return { ok: false, origin: '', error: '请勿填写 Cloudflare 控制台地址；请填写隧道 Public Hostname 绑定的自有域名' };
    }
    if (host === 'trycloudflare.com' || host.endsWith('.trycloudflare.com')) {
      return { ok: false, origin: '', error: '*.trycloudflare.com 为临时随机域名，无需手填；请使用 Quick 临时隧道' };
    }
    return { ok: true, origin: u.origin, error: '' };
  } catch {
    return { ok: false, origin: '', error: '请填写有效的 Cloudflare HTTPS 固定域名（例如 https://ag.example.com）' };
  }
}

function generatePairingToken() {
  return crypto.randomBytes(24).toString('hex');
}

function safeTokenEqual(provided, expected) {
  const a = String(provided || '');
  const b = String(expected || '');
  if (!a || !b) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function createConfirmToken(secret, { action = '', ttlMs = DEFAULT_CONFIRM_TTL_MS, now = Date.now() } = {}) {
  const key = String(secret || '');
  if (!key) {
    throw new Error('CONFIRM_SECRET_REQUIRED');
  }
  const parsedTtl = Number.isFinite(Number(ttlMs)) ? Math.floor(Number(ttlMs)) : DEFAULT_CONFIRM_TTL_MS;
  const boundedTtl = Math.max(1000, Math.min(5 * 60 * 1000, parsedTtl));
  const exp = Math.floor(Number(now)) + boundedTtl;
  const nonce = crypto.randomBytes(8).toString('hex');
  const act = typeof action === 'string' ? action : '';
  const payloadB64 = Buffer.from(JSON.stringify({ exp, nonce, act }), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', key).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

function verifyConfirmToken(token, secret, { action = '', now = Date.now() } = {}) {
  if (typeof token !== 'string' || typeof secret !== 'string' || !token || !secret) {
    return false;
  }
  const parts = token.trim().split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return false;
  }
  const [payloadB64, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  if (!safeTokenEqual(sig, expectedSig)) {
    return false;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  if (!payload || typeof payload !== 'object' || !Number.isFinite(Number(payload.exp))) {
    return false;
  }
  if (Number(now) > Number(payload.exp)) {
    return false;
  }
  if (action && payload.act && String(payload.act) !== String(action)) {
    return false;
  }
  return true;
}

function parseTailscaleServeHttpsUrl(rawJsonOrObj, targetPort) {
  const portNum = Number(targetPort);
  if (!Number.isInteger(portNum) || portNum <= 0) return '';
  let data = rawJsonOrObj;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return ''; }
  }
  if (!data || typeof data !== 'object' || !data.Web || typeof data.Web !== 'object') return '';
  const targetRe = new RegExp(`^https?:\\/\\/(?:127\\.0\\.0\\.1|localhost):${portNum}(?:\\/.*)?$`, 'i');

  for (const [hostPort, spec] of Object.entries(data.Web)) {
    const handlers = spec?.Handlers;
    if (!handlers || typeof handlers !== 'object') continue;
    for (const [mountPath, handler] of Object.entries(handlers)) {
      const proxyTarget = String(handler?.Proxy || '').trim();
      if (!targetRe.test(proxyTarget)) continue;
      const cleanHost = String(hostPort || '').replace(/:443$/, '');
      if (!cleanHost) continue;
      const cleanMount = mountPath && mountPath !== '/' ? mountPath.replace(/\/+$/, '') : '';
      return `https://${cleanHost}${cleanMount}`;
    }
  }
  return '';
}

module.exports = {
  DEFAULT_REMOTE_PORT,
  PERMISSION_LEVELS,
  PERMISSION_RANK,
  DEFAULT_CONFIRM_TTL_MS,
  DEFAULT_CHANNELS,
  DEFAULT_REMOTE_DISPLAY_CONFIG,
  normalizePermissionLevel,
  isPermissionAtLeast,
  sanitizeRemoteDisplayConfig,
  normalizeChannelConfig,
  isTailscaleIp,
  isLanIp,
  classifyRequestChannel,
  isChannelAllowed,
  extractCloudflareTunnelToken,
  decodeBase64JsonObject,
  validateCloudflareTunnelToken,
  validateTunnelHostname,
  generatePairingToken,
  safeTokenEqual,
  createConfirmToken,
  verifyConfirmToken,
  parseTailscaleServeHttpsUrl
};
