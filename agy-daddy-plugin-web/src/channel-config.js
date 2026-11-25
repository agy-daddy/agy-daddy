'use strict';

const crypto = require('node:crypto');
const os = require('node:os');

/**
 * Multi-channel access model for the PC Web harness.
 *
 * The remote plugin already solved channel classification / permission tiers /
 * confirm tokens for its own server (`tunnel-security.js`). Plugins are
 * isolated packages with `dependencies: {}`, so the PC Web harness keeps a
 * self-contained copy of the same semantics instead of importing across
 * package boundaries at runtime.
 */

const CHANNEL_KEYS = Object.freeze(['loopback', 'lan', 'tailscale', 'bonjour', 'cloudflare']);
const DEFAULT_CHANNELS = Object.freeze({
  loopback: true,
  lan: false,
  tailscale: false,
  bonjour: false,
  cloudflare: false
});
const PRIMARY_CHANNEL_ORDER = Object.freeze(['cloudflare', 'tailscale', 'lan', 'bonjour', 'loopback']);
const NON_LOOPBACK_CHANNEL_KEYS = Object.freeze(['lan', 'tailscale', 'bonjour', 'cloudflare']);
// Channels that need a non-loopback socket: cloudflared / tailscale-serve reach
// the server through 127.0.0.1, so they never widen the bind address.
const EXTERNAL_BIND_CHANNEL_KEYS = Object.freeze(['lan', 'tailscale', 'bonjour']);

const PERMISSION_LEVELS = Object.freeze(['L0', 'L1', 'L2']);
const PERMISSION_RANK = Object.freeze({ L0: 0, L1: 1, L2: 2 });
const DEFAULT_CONFIRM_TTL_MS = 60 * 1000;

const BIND_HOST_MODES = Object.freeze(['auto', 'loopback', 'lan']);
const LOOPBACK_BIND_HOST = '127.0.0.1';
const WILDCARD_BIND_HOST = '0.0.0.0';
const LOOPBACK_ADDRESSES = Object.freeze(['127.0.0.1', '::1', 'localhost']);
const WILDCARD_ADDRESSES = Object.freeze(['0.0.0.0', '::', '*']);

function normalizeChannelConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const key of CHANNEL_KEYS) {
    out[key] = key === 'loopback' ? src[key] !== false : src[key] === true;
  }
  return out;
}

function listEnabledChannels(channels) {
  const cfg = normalizeChannelConfig(channels);
  return CHANNEL_KEYS.filter((key) => cfg[key] === true);
}

function hasExternalBindChannel(channels) {
  const cfg = normalizeChannelConfig(channels);
  return EXTERNAL_BIND_CHANNEL_KEYS.some((key) => cfg[key] === true);
}

function normalizeBindHostMode(raw) {
  const clean = String(raw || 'auto').trim().toLowerCase();
  if (clean === 'loopback' || clean === '127.0.0.1') return 'loopback';
  if (clean === 'lan' || clean === '0.0.0.0' || clean === 'all') return 'lan';
  return 'auto';
}

function normalizePermissionLevel(raw) {
  if (typeof raw === 'string') {
    const clean = raw.trim().toUpperCase();
    if (clean === 'L0' || clean === '0' || clean === 'READONLY' || clean === 'READ-ONLY') return 'L0';
    if (clean === 'L1' || clean === '1' || clean === 'CHAT' || clean === 'WRITE' || clean === 'WRITABLE') return 'L1';
    if (clean === 'L2' || clean === '2' || clean === 'WORKSPACE' || clean === 'FULL') return 'L2';
  } else if (typeof raw === 'boolean') {
    return raw ? 'L1' : 'L0';
  }
  return 'L0';
}

function isPermissionAtLeast(current, required) {
  const curRank = PERMISSION_RANK[normalizePermissionLevel(current)] ?? 0;
  const reqRank = PERMISSION_RANK[normalizePermissionLevel(required)] ?? 0;
  return curRank >= reqRank;
}

function isLoopbackHostname(hostname) {
  return LOOPBACK_ADDRESSES.includes(String(hostname || '').trim().toLowerCase());
}

function isWildcardHost(hostname) {
  return WILDCARD_ADDRESSES.includes(String(hostname || '').trim().toLowerCase());
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

function extractHeaderHostname(raw) {
  const first = String(raw || '').split(',')[0].trim();
  if (!first) return '';
  try {
    const parsed = new URL(`http://${first}`);
    return parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return first.split(':')[0].trim().toLowerCase();
  }
}

function isTrustedProxyRequest(req, cfg = {}) {
  const headers = req?.headers || {};
  const remoteIp = String(req?.socket?.remoteAddress || req?.remoteAddress || '')
    .replace(/^::ffff:/i, '')
    .trim()
    .toLowerCase();
  const fromLoopback = !remoteIp || isLoopbackHostname(remoteIp);
  if (!fromLoopback) return { trusted: false, hasProxyHeader: false, prefix: '' };

  const hasProxyHeader = Object.keys(headers).some((k) => k.toLowerCase().startsWith('x-agy-proxy-'));
  if (!hasProxyHeader) return { trusted: false, hasProxyHeader: false, prefix: '' };

  const proxySecret = String(cfg.proxySecret || '');
  const providedSecret = String(headers['x-agy-proxy-secret'] || '');
  const proxyChannel = String(headers['x-agy-proxy-channel'] || '').trim().toLowerCase();
  const trusted = Boolean(proxySecret) && safeTokenEqual(providedSecret, proxySecret) && proxyChannel === 'cloudflare';
  const prefix = trusted && headers['x-agy-proxy-prefix'] === '/pc' ? '/pc' : '';
  return { trusted, hasProxyHeader: true, prefix };
}

function classifyRequestChannel(req, cfg = {}) {
  const headers = req?.headers || {};
  const hostHeader = extractHeaderHostname(headers.host);
  const forwardedHost = extractHeaderHostname(headers['x-forwarded-host']);
  const remoteIp = String(req?.socket?.remoteAddress || req?.remoteAddress || '')
    .replace(/^::ffff:/i, '')
    .trim()
    .toLowerCase();

  const fromLoopback = !remoteIp || isLoopbackHostname(remoteIp);
  const fromTailscale = isTailscaleIp(remoteIp);

  // `cloudflared` runs locally and connects over loopback; never trust spoofed
  // `cf-*` or tunnel Host headers arriving from non-loopback sockets.
  // Requests carrying `x-agy-proxy-*` over loopback must validate proxySecret
  // and NEVER fall back to `'loopback'`.
  if (fromLoopback) {
    const proxyCheck = isTrustedProxyRequest(req, cfg);
    if (proxyCheck.hasProxyHeader) {
      return proxyCheck.trusted ? 'cloudflare' : 'external';
    }
    if (
      headers['cf-ray'] ||
      headers['cf-connecting-ip'] ||
      headers['cf-visitor'] ||
      hostHeader.endsWith('.trycloudflare.com')
    ) {
      return 'cloudflare';
    }
    if (cfg.tunnelHostname) {
      try {
        const tunnelHost = new URL(cfg.tunnelHostname).hostname.toLowerCase();
        if (tunnelHost && hostHeader === tunnelHost) return 'cloudflare';
      } catch {}
    }
  }

  // `*.ts.net` and `tailscale-user-login` headers are only trusted when the
  // connection originates from the Tailscale CGNAT/ULA subnet or local
  // `tailscale serve` on loopback.
  if (fromTailscale) {
    return 'tailscale';
  }
  if (
    fromLoopback &&
    (hostHeader.endsWith('.ts.net') ||
      forwardedHost.endsWith('.ts.net') ||
      Boolean(headers['tailscale-user-login']))
  ) {
    return 'tailscale';
  }

  if (
    hostHeader.endsWith('.local') &&
    (fromLoopback ||
      isLanIp(remoteIp) ||
      remoteIp.startsWith('fe80:') ||
      remoteIp.startsWith('169.254.'))
  ) {
    return 'bonjour';
  }

  if (isLanIp(remoteIp)) return 'lan';

  if (fromLoopback) return 'loopback';

  return 'external';
}

function isChannelAllowed(channel, enabledChannels) {
  if (!channel || channel === 'external') return false;
  return Boolean(normalizeChannelConfig(enabledChannels)[channel]);
}

function listLocalAddresses() {
  const out = [];
  let ifaces;
  try {
    ifaces = os.networkInterfaces();
  } catch {
    return out;
  }
  for (const [name, list] of Object.entries(ifaces)) {
    for (const info of list || []) {
      if (!info || !info.address) continue;
      out.push({
        name,
        address: info.address,
        family: info.family,
        internal: Boolean(info.internal),
        mac: info.mac || '',
        netmask: info.netmask || ''
      });
    }
  }
  return out;
}

function isLocalBindAddress(host) {
  const clean = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!clean) return false;
  if (isWildcardHost(clean)) return true;
  return listLocalAddresses().some((info) => String(info.address).toLowerCase() === clean);
}

/**
 * Resolve the listen address for a channel set. `mode` may force the choice,
 * `auto` widens only when a channel actually needs a non-loopback socket.
 */
function resolveBindHost({ channels, mode } = {}) {
  const normalizedMode = normalizeBindHostMode(mode);
  if (normalizedMode === 'loopback') return LOOPBACK_BIND_HOST;
  if (normalizedMode === 'lan') return WILDCARD_BIND_HOST;
  return hasExternalBindChannel(channels) ? WILDCARD_BIND_HOST : LOOPBACK_BIND_HOST;
}

function bindHostError(code, message) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}

/**
 * Explicit guard for the listen address. A non-loopback bind is refused unless
 * at least one channel that needs it is enabled, and only local interface
 * addresses are accepted. This replaces the old blanket "loopback only" lock.
 */
function assertBindableHost(host, channels, mode) {
  const clean = String(host || '').trim().toLowerCase();
  if (!clean) {
    throw bindHostError('ERR_BIND_HOST_REQUIRED', 'listen host is required');
  }
  if (clean === 'localhost') {
    // Resolve deterministically: depending on the OS, "localhost" may bind ::1.
    return LOOPBACK_BIND_HOST;
  }

  const cfg = normalizeChannelConfig(channels);
  if (isLoopbackHostname(clean)) return clean;

  const wildcard = isWildcardHost(clean);
  if (!wildcard && !isLocalBindAddress(clean)) {
    throw bindHostError(
      'ERR_BIND_HOST_NOT_LOCAL',
      `host "${clean}" is not assigned to a local network interface`
    );
  }

  const externalChannels = NON_LOOPBACK_CHANNEL_KEYS.filter((key) => cfg[key] === true);
  if (externalChannels.length === 0) {
    throw bindHostError(
      'ERR_CHANNEL_NOT_ENABLED',
      `host "${clean}" requires at least one non-loopback channel (lan/tailscale/bonjour/cloudflare) to be enabled`
    );
  }

  const forcedLoopback = normalizeBindHostMode(mode) === 'loopback';
  if (forcedLoopback) {
    throw bindHostError(
      'ERR_BIND_HOST_CONFLICT',
      `bindHost "loopback" conflicts with enabled channels: ${externalChannels.join(', ')}`
    );
  }

  return clean;
}

function isVirtualInterfaceName(name) {
  return /^(?:utun|tun|tap|docker|veth|vmnet|bridge|lo|awdl|llw)/i.test(String(name || ''));
}

function isPhysicalInterfaceName(name) {
  return /^(?:en\d+|wlan\d+|eth\d+|wi-fi)$/i.test(String(name || ''));
}

/**
 * Build one entry URL per enabled channel. Loopback always uses the connect
 * host (0.0.0.0 is not reachable from a browser).
 */
function buildChannelUrls(options = {}) {
  const port = Number(options.port);
  const token = String(options.token || '');
  const channels = normalizeChannelConfig(options.channels);
  const urls = {};
  if (!Number.isInteger(port) || port <= 0) return urls;

  const connectHost = options.connectHost || LOOPBACK_BIND_HOST;
  const includeToken = options.includeToken !== false && Boolean(token);
  const entry = (base) => (includeToken ? `${base}/?token=${encodeURIComponent(token)}` : base);
  const loopbackBase = `http://${connectHost.includes(':') ? `[${connectHost}]` : connectHost}:${port}`;

  if (channels.loopback) urls.loopback = entry(loopbackBase);

  const needLan = channels.lan === true;
  const needTailscale = channels.tailscale === true;
  if (needLan || needTailscale) {
    const ifaces = os.networkInterfaces();
    let lanPreferred = '';
    let lanSecondary = '';
    let lanFallback = '';
    let tailscaleV6 = '';
    for (const [name, list] of Object.entries(ifaces)) {
      const physical = isPhysicalInterfaceName(name);
      const virtual = isVirtualInterfaceName(name);
      for (const info of list || []) {
        if (!info || info.internal || !info.address) continue;
        if (info.family === 'IPv4') {
          if (needTailscale && !urls.tailscale && isTailscaleIp(info.address)) {
            urls.tailscale = entry(`http://${info.address}:${port}`);
          } else if (needLan && isLanIp(info.address)) {
            const candidate = entry(`http://${info.address}:${port}`);
            if (physical && !lanPreferred) lanPreferred = candidate;
            else if (!virtual && !lanSecondary) lanSecondary = candidate;
            else if (!lanFallback) lanFallback = candidate;
          } else if (needLan && !lanFallback && !virtual && !isTailscaleIp(info.address)) {
            lanFallback = entry(`http://${info.address}:${port}`);
          }
        } else if (info.family === 'IPv6' && needTailscale && !tailscaleV6 && isTailscaleIp(info.address)) {
          tailscaleV6 = entry(`http://[${info.address}]:${port}`);
        }
      }
    }
    if (needLan && (lanPreferred || lanSecondary || lanFallback)) {
      urls.lan = lanPreferred || lanSecondary || lanFallback;
    }
    if (needTailscale && !urls.tailscale && tailscaleV6) {
      urls.tailscale = tailscaleV6;
    }
  }

  if (channels.bonjour) {
    const hostName = String(options.hostName || os.hostname()).replace(/\.local$/i, '');
    urls.bonjour = entry(`http://${hostName}.local:${port}`);
  }

  if (channels.cloudflare) {
    const raw = String(options.tunnelHostname || '').trim();
    if (raw) {
      try {
        const origin = new URL(raw).origin;
        const mount = options.cloudflareMountPath === '/pc' ? '/pc' : '';
        const base = `${origin}${mount}`;
        urls.cloudflare = includeToken
          ? `${base}/?token=${encodeURIComponent(token)}`
          : `${base}${mount ? '/' : ''}`;
      } catch {}
    }
  }

  return urls;
}

function buildChannelEndpoints(options = {}) {
  const cleanUrls = buildChannelUrls({ ...options, includeToken: false });
  const endpoints = {};
  for (const key of PRIMARY_CHANNEL_ORDER) {
    const raw = cleanUrls[key];
    if (!raw) continue;
    try {
      const u = new URL(raw);
      const basePath = key === 'cloudflare' && options.cloudflareMountPath === '/pc' ? '/pc' : '';
      endpoints[key] = {
        key,
        origin: u.origin,
        basePath,
        displayHost: basePath ? `${u.host}${basePath}` : u.host,
        probeUrl: `${u.origin}${basePath}/api/v1/ping`
      };
    } catch {}
  }
  return endpoints;
}

function resolvePrimaryChannel(urls = {}, channels) {
  for (const key of PRIMARY_CHANNEL_ORDER) {
    if (urls[key]) return { primaryChannel: key, primaryUrl: urls[key] };
  }
  const enabled = listEnabledChannels(channels);
  if (enabled.length > 0) {
    return { primaryChannel: enabled[0], primaryUrl: urls.loopback || '' };
  }
  return { primaryChannel: 'offline', primaryUrl: '' };
}

function safeTokenEqual(provided, expected) {
  const a = typeof provided === 'string' ? provided : '';
  const b = typeof expected === 'string' ? expected : '';
  if (!a || !b) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function createConfirmToken(secret, { action = '', ttlMs = DEFAULT_CONFIRM_TTL_MS, now = Date.now() } = {}) {
  const key = String(secret || '');
  if (!key) throw new Error('CONFIRM_SECRET_REQUIRED');
  const parsedTtl = Number.isFinite(Number(ttlMs)) ? Math.floor(Number(ttlMs)) : DEFAULT_CONFIRM_TTL_MS;
  const boundedTtl = Math.max(1000, Math.min(5 * 60 * 1000, parsedTtl));
  const exp = Math.floor(Number(now)) + boundedTtl;
  const nonce = crypto.randomBytes(8).toString('hex');
  const payloadB64 = Buffer.from(JSON.stringify({ exp, nonce, act: String(action || '') }), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', key).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

function verifyConfirmToken(token, secret, { action = '', now = Date.now() } = {}) {
  if (typeof token !== 'string' || typeof secret !== 'string' || !token || !secret) return false;
  const parts = token.trim().split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const [payloadB64, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  if (!safeTokenEqual(sig, expectedSig)) return false;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  if (!payload || typeof payload !== 'object' || !Number.isFinite(Number(payload.exp))) return false;
  if (Number(now) > Number(payload.exp)) return false;
  if (action && String(payload.act || '') !== String(action)) return false;
  return true;
}

function normalizeTunnelHostname(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  try {
    return new URL(text).origin;
  } catch {
    return '';
  }
}

module.exports = {
  CHANNEL_KEYS,
  DEFAULT_CHANNELS,
  PRIMARY_CHANNEL_ORDER,
  NON_LOOPBACK_CHANNEL_KEYS,
  EXTERNAL_BIND_CHANNEL_KEYS,
  PERMISSION_LEVELS,
  PERMISSION_RANK,
  DEFAULT_CONFIRM_TTL_MS,
  BIND_HOST_MODES,
  LOOPBACK_BIND_HOST,
  WILDCARD_BIND_HOST,
  normalizeChannelConfig,
  listEnabledChannels,
  hasExternalBindChannel,
  normalizeBindHostMode,
  normalizePermissionLevel,
  isPermissionAtLeast,
  isLoopbackHostname,
  isWildcardHost,
  isTailscaleIp,
  isLanIp,
  classifyRequestChannel,
  isChannelAllowed,
  isTrustedProxyRequest,
  listLocalAddresses,
  isLocalBindAddress,
  resolveBindHost,
  assertBindableHost,
  buildChannelUrls,
  buildChannelEndpoints,
  resolvePrimaryChannel,
  safeTokenEqual,
  createConfirmToken,
  verifyConfirmToken,
  normalizeTunnelHostname
};
