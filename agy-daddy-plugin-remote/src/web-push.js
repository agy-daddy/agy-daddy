'use strict';

const crypto = require('node:crypto');

const VAPID_KEYS_FILE = 'vapid-keys.json';
const PUSH_SUBS_FILE = 'push-subs.json';
const DEFAULT_SUBJECT = 'mailto:noreply@agy-daddy.local';
const DEFAULT_TTL_SEC = 3600;
const MAX_VAPID_TTL_SEC = 24 * 3600;
const DEFAULT_RECORD_SIZE = 4096;

/**
 * Normalizes a base64 or base64url string into a Buffer.
 */
function decodeBase64Flexible(input) {
  if (Buffer.isBuffer(input)) return Buffer.from(input);
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('INVALID_BASE64_INPUT');
  }
  const normalized = input.trim().replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + '='.repeat(padLen), 'base64');
}

/**
 * Generates an EC P-256 (prime256v1) VAPID key pair.
 * publicKey: 65-byte uncompressed point encoded as base64url.
 * privateKey: PKCS8 PEM string.
 */
function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1'
  });

  const jwk = publicKey.export({ format: 'jwk' });
  const x = decodeBase64Flexible(jwk.x);
  const y = decodeBase64Flexible(jwk.y);
  if (x.length !== 32 || y.length !== 32) {
    throw new Error('UNEXPECTED_P256_KEY_LENGTH');
  }

  const uncompressedPoint = Buffer.concat([Buffer.from([0x04]), x, y]);
  const publicKeyB64Url = uncompressedPoint.toString('base64url');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  return {
    publicKey: publicKeyB64Url,
    privateKey: privateKeyPem
  };
}

/**
 * Creates RFC 8292 VAPID Authorization and Crypto-Key headers using ES256 JWT.
 */
function createVapidAuthHeader({ endpoint, subject, publicKey, privateKey, ttlSec } = {}) {
  if (typeof endpoint !== 'string' || !endpoint.trim()) {
    throw new Error('INVALID_PUSH_ENDPOINT');
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(endpoint);
  } catch {
    throw new Error('INVALID_PUSH_ENDPOINT');
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    throw new Error('INVALID_PUSH_ENDPOINT_PROTOCOL');
  }
  if (typeof publicKey !== 'string' || !publicKey.trim()) {
    throw new Error('INVALID_VAPID_PUBLIC_KEY');
  }
  if (!privateKey) {
    throw new Error('INVALID_VAPID_PRIVATE_KEY');
  }

  const rawTtl = Number.isFinite(Number(ttlSec)) ? Math.floor(Number(ttlSec)) : 12 * 3600;
  const effectiveTtl = Math.max(60, Math.min(MAX_VAPID_TTL_SEC, rawTtl));
  const nowSec = Math.floor(Date.now() / 1000);

  const headerPart = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' }), 'utf8').toString('base64url');
  const payloadPart = Buffer.from(
    JSON.stringify({
      aud: parsedUrl.origin,
      exp: nowSec + effectiveTtl,
      sub: typeof subject === 'string' && subject.trim() ? subject.trim() : DEFAULT_SUBJECT
    }),
    'utf8'
  ).toString('base64url');

  const signingInput = `${headerPart}.${payloadPart}`;
  const signer = crypto.createSign('SHA256');
  signer.update(signingInput, 'utf8');
  signer.end();
  const signature = signer.sign({
    key: privateKey,
    dsaEncoding: 'ieee-p1363'
  });

  const jwt = `${signingInput}.${signature.toString('base64url')}`;
  const cleanPub = publicKey.trim();

  return {
    authorization: `vapid t=${jwt}, k=${cleanPub}`,
    cryptoKey: `p256ecdsa=${cleanPub}`
  };
}

/**
 * Encrypts a push message payload according to RFC 8291 (aes128gcm content encoding).
 * Returns { body, salt, localPublicKey } where `body` contains the 86-byte aes128gcm
 * header followed by AES-128-GCM ciphertext (with 0x02 record delimiter) and 16-byte tag.
 */
function encryptWebPushPayload(plaintext, { p256dh, auth } = {}) {
  const plaintextBuf = Buffer.isBuffer(plaintext)
    ? plaintext
    : Buffer.from(typeof plaintext === 'string' ? plaintext : JSON.stringify(plaintext ?? ''), 'utf8');

  const uaPublic = decodeBase64Flexible(p256dh);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new Error('INVALID_SUBSCRIPTION_P256DH');
  }

  const authSecret = decodeBase64Flexible(auth);
  if (authSecret.length !== 16) {
    throw new Error('INVALID_SUBSCRIPTION_AUTH');
  }

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const localPublicKey = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(uaPublic);

  const salt = crypto.randomBytes(16);

  // RFC 8291 §3.3: IKM = HKDF-SHA256(salt=auth_secret, ikm=ecdh_secret, info="WebPush: info\0" || ua_public || as_public, 32)
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    uaPublic,
    localPublicKey
  ]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));

  // RFC 8291 §3.4 / RFC 8188 §2.2-2.3: CEK (16 bytes) and NONCE (12 bytes)
  const cekInfo = Buffer.from('Content-Encoding: aes128gcm\0', 'utf8');
  const nonceInfo = Buffer.from('Content-Encoding: nonce\0', 'utf8');
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, cekInfo, 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, nonceInfo, 12));

  // RFC 8188 §2: single final record ends with 0x02 delimiter.
  const padded = Buffer.concat([plaintextBuf, Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // 86-byte aes128gcm header: salt(16) || rs(4) || idlen(1=65) || keyid(65)
  const header = Buffer.allocUnsafe(86);
  salt.copy(header, 0);
  header.writeUInt32BE(DEFAULT_RECORD_SIZE, 16);
  header.writeUInt8(localPublicKey.length, 20);
  localPublicKey.copy(header, 21);

  const body = Buffer.concat([header, ciphertext, authTag]);
  return {
    body,
    salt,
    localPublicKey
  };
}

function createInMemoryStorage() {
  const map = new Map();
  return {
    readJson(name, fallbackValue = null) {
      if (!map.has(name)) {
        return { ok: true, exists: false, data: fallbackValue };
      }
      return { ok: true, exists: true, data: structuredClone(map.get(name)) };
    },
    writeJson(name, data) {
      map.set(name, structuredClone(data));
      return { ok: true };
    }
  };
}

function readStoredJson(storage, fileName, fallbackValue) {
  if (!storage || typeof storage.readJson !== 'function') {
    return fallbackValue;
  }
  const res = storage.readJson(fileName, fallbackValue);
  if (res && typeof res === 'object' && 'ok' in res) {
    return res.ok && res.data !== undefined && res.data !== null ? res.data : fallbackValue;
  }
  return res !== undefined && res !== null ? res : fallbackValue;
}

function writeStoredJson(storage, fileName, data) {
  if (!storage || typeof storage.writeJson !== 'function') return;
  storage.writeJson(fileName, data);
}

function validateSubscriptionInput(sub) {
  if (!sub || typeof sub !== 'object') {
    return { ok: false, statusCode: 400, error: 'INVALID_SUBSCRIPTION' };
  }
  const endpoint = typeof sub.endpoint === 'string' ? sub.endpoint.trim() : '';
  if (!endpoint) {
    return { ok: false, statusCode: 400, error: 'MISSING_ENDPOINT' };
  }
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    return { ok: false, statusCode: 400, error: 'INVALID_ENDPOINT_URL' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, statusCode: 400, error: 'INVALID_ENDPOINT_PROTOCOL' };
  }

  const keys = sub.keys && typeof sub.keys === 'object' ? sub.keys : null;
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') {
    return { ok: false, statusCode: 400, error: 'MISSING_SUBSCRIPTION_KEYS' };
  }

  try {
    const p256dhBuf = decodeBase64Flexible(keys.p256dh);
    const authBuf = decodeBase64Flexible(keys.auth);
    if (p256dhBuf.length !== 65 || p256dhBuf[0] !== 0x04) {
      return { ok: false, statusCode: 400, error: 'INVALID_P256DH_KEY' };
    }
    if (authBuf.length !== 16) {
      return { ok: false, statusCode: 400, error: 'INVALID_AUTH_SECRET' };
    }
  } catch {
    return { ok: false, statusCode: 400, error: 'INVALID_SUBSCRIPTION_KEYS' };
  }

  return {
    ok: true,
    endpoint,
    keys: {
      p256dh: keys.p256dh.trim(),
      auth: keys.auth.trim()
    }
  };
}

/**
 * Creates a persistent VAPID Web Push subscription and notification manager.
 */
function createWebPushManager({
  storage = null,
  fetchImpl = null,
  isTestMode = undefined,
  subject = DEFAULT_SUBJECT,
  isEnabled = undefined,
  isBadgeEnabled = undefined
} = {}) {
  const store = storage || createInMemoryStorage();
  const customFetch = typeof fetchImpl === 'function' ? fetchImpl : null;
  let enabledState = typeof isEnabled === 'boolean' ? isEnabled : true;
  let badgeEnabledState = typeof isBadgeEnabled === 'boolean' ? isBadgeEnabled : true;
  const resolveEnabled = () => (
    typeof isEnabled === 'function' ? isEnabled() !== false : enabledState
  );
  const resolveBadgeEnabled = () => (
    typeof isBadgeEnabled === 'function' ? isBadgeEnabled() !== false : badgeEnabledState
  );
  const resolveTestMode = () => (
    typeof isTestMode === 'boolean'
      ? isTestMode
      : process.env.AGY_DADDY_TEST_MODE === '1'
  );

  function ensureVapidKeys() {
    const existing = readStoredJson(store, VAPID_KEYS_FILE, null);
    if (
      existing &&
      typeof existing === 'object' &&
      typeof existing.publicKey === 'string' &&
      existing.publicKey.length > 0 &&
      typeof existing.privateKey === 'string' &&
      existing.privateKey.includes('BEGIN PRIVATE KEY')
    ) {
      return existing;
    }
    const generated = generateVapidKeys();
    const record = {
      publicKey: generated.publicKey,
      privateKey: generated.privateKey,
      createdAt: new Date().toISOString()
    };
    writeStoredJson(store, VAPID_KEYS_FILE, record);
    return record;
  }

  function loadSubs() {
    const raw = readStoredJson(store, PUSH_SUBS_FILE, []);
    return Array.isArray(raw) ? raw.filter((s) => s && typeof s.endpoint === 'string') : [];
  }

  function saveSubs(subs) {
    writeStoredJson(store, PUSH_SUBS_FILE, subs);
  }

  function getPublicKey() {
    return ensureVapidKeys().publicKey;
  }

  function listSubscriptions() {
    return loadSubs().map((s) => ({
      endpoint: s.endpoint,
      keys: { ...s.keys },
      meta: s.meta ? { ...s.meta } : {},
      createdAt: s.createdAt,
      updatedAt: s.updatedAt
    }));
  }

  function subscribe(sub, meta = {}) {
    const checked = validateSubscriptionInput(sub);
    if (!checked.ok) return checked;

    const subs = loadSubs();
    const now = new Date().toISOString();
    const cleanMeta = meta && typeof meta === 'object' ? { ...meta } : {};
    const idx = subs.findIndex((item) => item.endpoint === checked.endpoint);

    let entry;
    if (idx >= 0) {
      entry = {
        ...subs[idx],
        keys: checked.keys,
        meta: { ...(subs[idx].meta || {}), ...cleanMeta },
        updatedAt: now
      };
      subs[idx] = entry;
    } else {
      entry = {
        endpoint: checked.endpoint,
        keys: checked.keys,
        meta: cleanMeta,
        createdAt: now,
        updatedAt: now
      };
      subs.push(entry);
    }

    saveSubs(subs);
    return {
      ok: true,
      subscription: { ...entry, keys: { ...entry.keys }, meta: { ...entry.meta } },
      count: subs.length
    };
  }

  function unsubscribe(endpoint) {
    if (typeof endpoint !== 'string' || !endpoint.trim()) {
      return { ok: false, statusCode: 400, error: 'INVALID_ENDPOINT' };
    }
    const cleanEndpoint = endpoint.trim();
    const subs = loadSubs();
    const next = subs.filter((item) => item.endpoint !== cleanEndpoint);
    const removed = next.length !== subs.length;
    if (removed) {
      saveSubs(next);
    }
    return {
      ok: true,
      removed,
      count: next.length
    };
  }

  async function sendNotification(payload, opts = {}) {
    const testMode = resolveTestMode();
    if (!resolveEnabled()) {
      return {
        ok: true,
        skipped: true,
        disabled: true,
        reason: 'PUSH_DISABLED',
        sent: 0,
        failed: 0,
        pruned: 0,
        dryRun: testMode && !customFetch,
        results: []
      };
    }

    const keys = ensureVapidKeys();
    const subs = loadSubs();
    const filterEndpoint = typeof opts.endpoint === 'string' && opts.endpoint.trim()
      ? opts.endpoint.trim()
      : '';
    const targets = filterEndpoint
      ? subs.filter((s) => s.endpoint === filterEndpoint)
      : subs;

    if (targets.length === 0) {
      return {
        ok: true,
        sent: 0,
        failed: 0,
        pruned: 0,
        dryRun: testMode && !customFetch,
        results: []
      };
    }

    const ttlSec = Number.isFinite(Number(opts.ttlSec))
      ? Math.max(0, Math.floor(Number(opts.ttlSec)))
      : DEFAULT_TTL_SEC;
    const urgency = typeof opts.urgency === 'string' && opts.urgency ? opts.urgency : 'high';
    const serialized = typeof payload === 'string' || Buffer.isBuffer(payload)
      ? payload
      : JSON.stringify(payload ?? {});

    // In testMode without a custom fetchImpl, encrypt to verify keys & skip network.
    if (testMode && !customFetch) {
      const results = targets.map((sub) => {
        encryptWebPushPayload(serialized, sub.keys);
        return { endpoint: sub.endpoint, ok: true, status: 201, dryRun: true };
      });
      return {
        ok: true,
        sent: targets.length,
        failed: 0,
        pruned: 0,
        dryRun: true,
        results
      };
    }

    const doFetch = customFetch || globalThis.fetch;
    if (typeof doFetch !== 'function') {
      return { ok: false, statusCode: 500, error: 'FETCH_UNAVAILABLE' };
    }

    const expiredEndpoints = new Set();
    const results = [];
    let sent = 0;
    let failed = 0;

    for (const sub of targets) {
      try {
        const encrypted = encryptWebPushPayload(serialized, sub.keys);
        const vapidHeaders = createVapidAuthHeader({
          endpoint: sub.endpoint,
          subject: opts.subject || subject,
          publicKey: keys.publicKey,
          privateKey: keys.privateKey,
          ttlSec
        });

        const res = await doFetch(sub.endpoint, {
          method: 'POST',
          headers: {
            Authorization: vapidHeaders.authorization,
            'Crypto-Key': vapidHeaders.cryptoKey,
            'Content-Type': 'application/octet-stream',
            'Content-Encoding': 'aes128gcm',
            TTL: String(ttlSec),
            Urgency: urgency
          },
          body: encrypted.body
        });

        const status = Number(res && res.status) || 0;
        if (status >= 200 && status < 300) {
          sent += 1;
          results.push({ endpoint: sub.endpoint, ok: true, status });
        } else {
          failed += 1;
          if (status === 404 || status === 410) {
            expiredEndpoints.add(sub.endpoint);
          }
          results.push({ endpoint: sub.endpoint, ok: false, status, pruned: status === 404 || status === 410 });
        }
      } catch (err) {
        failed += 1;
        results.push({
          endpoint: sub.endpoint,
          ok: false,
          status: 0,
          error: err && err.message ? err.message : 'PUSH_DELIVERY_FAILED'
        });
      }
    }

    if (expiredEndpoints.size > 0) {
      const remaining = subs.filter((s) => !expiredEndpoints.has(s.endpoint));
      saveSubs(remaining);
    }

    return {
      ok: true,
      sent,
      failed,
      pruned: expiredEndpoints.size,
      dryRun: false,
      results
    };
  }

  async function sendTestNotification(opts = {}) {
    const badgeEnabled = typeof opts.badgeEnabled === 'boolean'
      ? opts.badgeEnabled
      : resolveBadgeEnabled();
    const rawCount = Number(opts.badgeCount);
    const badgeCount = badgeEnabled
      ? (Number.isFinite(rawCount) && rawCount > 0 ? Math.floor(rawCount) : 1)
      : 0;
    return sendNotification({
      type: 'test',
      title: 'Agy-Daddy',
      body: 'Web Push notification test succeeded',
      badgeEnabled,
      badgeCount,
      unreadCount: badgeCount,
      timestamp: new Date().toISOString()
    }, opts);
  }

  return {
    getPublicKey,
    isEnabled: resolveEnabled,
    setEnabled(next) {
      enabledState = Boolean(next);
    },
    isBadgeEnabled: resolveBadgeEnabled,
    setBadgeEnabled(next) {
      badgeEnabledState = Boolean(next);
    },
    listSubscriptions,
    subscribe,
    unsubscribe,
    sendNotification,
    sendTestNotification
  };
}

module.exports = {
  generateVapidKeys,
  createVapidAuthHeader,
  encryptWebPushPayload,
  createWebPushManager
};
