'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { HOST_API_VERSION, isHighRiskPermission } = require('../contracts/constants');
const { parseSemver, compareSemver, satisfies } = require('../contracts/semver');
const { getStateDir, getPluginsDir, isTestMode } = require('./paths');
const { safeReadJsonSync, safeWriteJsonSync, withFileLockSync } = require('./storage');
const { loadAnchorsRegistry } = require('./anchors');
const {
  loadRegistry,
  readInstalledIndex,
  readManifestFromDir,
  parsePluginSource,
  encodeNpmPackagePath
} = require('./installer');
const { parseGitHubRepoSlug } = require('./marketplace-stats');

const HOST_ROOT = path.resolve(__dirname, '..', '..');
const UPDATE_STATE_FILENAME = 'update-state.json';
const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org';
const DEFAULT_GITHUB_REPO = 'agy-daddy/agy-daddy';
const CHECK_TIMEOUT_MS = 8000;
const DOWNLOAD_TIMEOUT_MS = 60000;
const MAX_CHECK_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const MAX_HTTP_CACHE_ENTRIES = 64;
const CHECK_CONCURRENCY = 4;
const MANUAL_CHECK_DEBOUNCE_MS = 10000;
const DEFAULT_RETRY_DELAYS_MS = [1000, 3000];

const VALID_UPDATE_CHANNELS = new Set(['stable', 'next']);
const VALID_AUTO_UPDATE_MODES = new Set(['notify', 'auto-safe', 'manual']);
const VALID_CHECK_INTERVALS = new Set(['1h', '6h', '12h', '24h']);
const VALID_SOURCE_PREFERENCES = new Set(['auto', 'npm', 'github']);

function makeUpdateError(code, message, extra = {}) {
  const err = new Error(message || code);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function redactUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const u = new URL(rawUrl);
    if (u.username || u.password) {
      u.username = u.username ? '***' : '';
      u.password = '';
    }
    for (const key of ['token', 't', 'access_token', 'auth', 'key']) {
      if (u.searchParams.has(key)) {
        u.searchParams.set(key, '<REDACTED>');
      }
    }
    return u.toString();
  } catch {
    return String(rawUrl).replace(/\b(https?:\/\/)[^\s/@]+@/gi, '$1***@');
  }
}

function isLoopbackOrLocalUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  if (rawUrl.startsWith('file://') || rawUrl.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rawUrl)) {
    return true;
  }
  try {
    const u = new URL(rawUrl);
    const h = u.hostname.toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
  } catch {
    return false;
  }
}

function normalizeNpmRegistryUrl(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    const u = new URL(trimmed);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
    }
  } catch {}
  return '';
}

function resolveEffectiveNpmRegistry(options = {}, hostSettings = {}) {
  const fromOpts = normalizeNpmRegistryUrl(options.npmRegistryUrl);
  if (fromOpts) return fromOpts;
  const fromSettings = normalizeNpmRegistryUrl(hostSettings?.npmRegistryUrl);
  if (fromSettings) return fromSettings;
  const fromEnv = normalizeNpmRegistryUrl(process.env.AGY_DADDY_NPM_REGISTRY);
  if (fromEnv) return fromEnv;
  return DEFAULT_NPM_REGISTRY;
}

function extractSemverFromTag(tagName, expectedScope = null) {
  if (typeof tagName !== 'string') return null;
  const raw = tagName.trim();
  if (!raw) return null;
  const atIdx = raw.lastIndexOf('@');
  if (atIdx > 0 && !raw.startsWith('@')) {
    const scopePart = raw.slice(0, atIdx);
    const verPart = raw.slice(atIdx + 1);
    if (expectedScope && scopePart !== expectedScope) {
      return null;
    }
    const parsed = parseSemver(verPart);
    return parsed ? verPart.replace(/^v/, '') : null;
  }
  const clean = raw.startsWith('v') ? raw.slice(1) : raw;
  const parsed = parseSemver(clean);
  return parsed ? clean : null;
}

function compareSemverSafe(a, b) {
  const pa = parseSemver(String(a || ''));
  const pb = parseSemver(String(b || ''));
  if (!pa || !pb) return null;
  return compareSemver(pa, pb);
}

function isMajorBump(fromVer, toVer) {
  const pa = parseSemver(String(fromVer || ''));
  const pb = parseSemver(String(toVer || ''));
  if (!pa || !pb) return false;
  return pb.major > pa.major;
}

function getUpdateStatePath(options = {}) {
  return path.join(getStateDir(options), UPDATE_STATE_FILENAME);
}

function emptyUpdateState() {
  return {
    schemaVersion: 1,
    lastCheckedAt: null,
    lastCheckAttemptAt: 0,
    lastScheduledCheckAt: null,
    channel: 'stable',
    httpCache: {},
    rateLimits: {},
    targets: {}
  };
}

function readUpdateState(options = {}) {
  const filePath = getUpdateStatePath(options);
  const res = safeReadJsonSync(filePath, emptyUpdateState(), { quarantineCorrupt: true });
  const data = res.data && typeof res.data === 'object' ? res.data : emptyUpdateState();
  if (!data.httpCache || typeof data.httpCache !== 'object') data.httpCache = {};
  if (!data.rateLimits || typeof data.rateLimits !== 'object') data.rateLimits = {};
  if (!data.targets || typeof data.targets !== 'object') data.targets = {};
  return data;
}

function pruneHttpCache(cacheObj) {
  const entries = Object.entries(cacheObj || {});
  if (entries.length <= MAX_HTTP_CACHE_ENTRIES) return cacheObj || {};
  entries.sort((a, b) => Number(b[1]?.cachedAt || 0) - Number(a[1]?.cachedAt || 0));
  return Object.fromEntries(entries.slice(0, MAX_HTTP_CACHE_ENTRIES));
}

function writeUpdateState(state, options = {}) {
  const filePath = getUpdateStatePath(options);
  const normalized = {
    ...emptyUpdateState(),
    ...(state && typeof state === 'object' ? state : {}),
    schemaVersion: 1,
    httpCache: pruneHttpCache(state?.httpCache || {}),
    rateLimits: state?.rateLimits && typeof state.rateLimits === 'object' ? state.rateLimits : {},
    targets: state?.targets && typeof state.targets === 'object' ? state.targets : {}
  };
  return withFileLockSync(filePath, () => safeWriteJsonSync(filePath, normalized));
}

function defaultGitRunner(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 12000,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  }).trim();
}

function detectHostInstallMode(options = {}) {
  const hostRoot = path.resolve(options.hostRoot || HOST_ROOT);
  const stateDir = getStateDir(options);
  const gitRun = options.gitRunner || defaultGitRunner;

  let hostVersion = '0.0.0';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(hostRoot, 'package.json'), 'utf8'));
    if (pkg?.version) hostVersion = String(pkg.version);
  } catch {}

  const installMeta = safeReadJsonSync(
    path.join(hostRoot, '.install-meta.json'),
    null,
    { quarantineCorrupt: false }
  ).data;

  let installMode = options.installMode || null;
  if (!installMode) {
    if (fs.existsSync(path.join(hostRoot, '.git'))) {
      installMode = 'git';
    } else if (
      installMeta?.installMode === 'wrapper' ||
      (!hostRoot.includes(`${path.sep}node_modules${path.sep}`) && !installMeta?.installMode)
    ) {
      installMode = 'wrapper';
    } else {
      installMode = 'npm-global';
    }
  }

  let writable = true;
  if (typeof options.writable === 'boolean') {
    writable = options.writable;
  } else {
    try {
      fs.accessSync(hostRoot, fs.constants.W_OK);
      if (installMode === 'wrapper') {
        fs.accessSync(path.dirname(hostRoot), fs.constants.W_OK);
      }
    } catch {
      writable = false;
    }
  }

  let dirtyWorktree = false;
  let currentCommit = null;
  if (installMode === 'git') {
    try {
      const st = gitRun(['status', '--porcelain'], hostRoot);
      dirtyWorktree = String(st || '').trim().length > 0;
    } catch {}
    try {
      currentCommit = gitRun(['rev-parse', 'HEAD'], hostRoot) || null;
    } catch {}
  }

  const anchors = loadAnchorsRegistry({ stateDir, anchorsPath: options.anchorsPath });
  const anchorsMeta = safeReadJsonSync(
    path.join(stateDir, 'anchors.meta.json'),
    null,
    { quarantineCorrupt: false }
  ).data;
  let regVersion = anchorsMeta?.version || anchors?.version || null;
  if (!regVersion) {
    try {
      const regPkgPath = path.resolve(hostRoot, '..', 'agy-daddy-registry', 'package.json');
      if (fs.existsSync(regPkgPath)) {
        regVersion = JSON.parse(fs.readFileSync(regPkgPath, 'utf8')).version || null;
      }
    } catch {}
  }
  const anchorsVersion = String(regVersion || hostVersion || '1.0.0');

  return {
    hostRoot,
    hostVersion,
    hostApiVersion: HOST_API_VERSION,
    anchorsVersion,
    anchorsSourcePath: anchors?.sourcePath || null,
    installMode,
    writable,
    dirtyWorktree,
    currentCommit,
    wrapperVersion: installMeta?.wrapperVersion || null,
    hasHostRollback: fs.existsSync(`${hostRoot}.prev`),
    hasRegistryRollback: fs.existsSync(path.join(stateDir, 'anchors.prev.json'))
  };
}

function getGithubHeaders(options = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'agy-daddy-updater'
  };
  const token = options.githubToken || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  if (token && typeof token === 'string' && token.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

function parseRetryAfterMs(headers, nowMs) {
  if (!headers || typeof headers.get !== 'function') return null;
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) {
      return Math.max(1000, Math.round(secs * 1000));
    }
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs) && dateMs > nowMs) {
      return dateMs - nowMs;
    }
  }
  const reset = headers.get('x-ratelimit-reset');
  if (reset) {
    const epochSec = Number(reset);
    if (Number.isFinite(epochSec) && epochSec > 0) {
      const diff = epochSec * 1000 - nowMs;
      if (diff > 0) return diff;
    }
  }
  return null;
}

function isTransientNetworkError(err) {
  if (!err) return false;
  if (err.code === 'UPDATE_NETWORK_TIMEOUT') return true;
  if (err.name === 'AbortError') return true;
  if (['ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNREFUSED'].includes(err.code)) return true;
  const msg = String(err.message || '');
  return /fetch failed|network|timeout|ECONNRESET|EAI_AGAIN|ETIMEDOUT/i.test(msg);
}

function sleepMs(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getHostname(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return 'unknown';
  }
}

function assertNetworkAllowed(rawUrl, options = {}) {
  if (typeof options.fetch === 'function') return;
  if (options.allowNetworkInTest === true) return;
  if (isTestMode() && !isLoopbackOrLocalUrl(rawUrl)) {
    throw makeUpdateError(
      'UPDATE_NETWORK_ERROR',
      `Test mode blocked external network request to ${redactUrl(rawUrl)}`,
      { url: redactUrl(rawUrl), blockedInTest: true }
    );
  }
}

async function fetchWithRetryCore(url, fetchOpts = {}, ctx = {}) {
  const fetchImpl = ctx.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw makeUpdateError('UPDATE_NETWORK_ERROR', 'fetch is unavailable', { url: redactUrl(url) });
  }
  assertNetworkAllowed(url, ctx);

  const nowFn = typeof ctx.now === 'function' ? ctx.now : Date.now;
  const hostname = getHostname(url);
  const rateLimits = ctx.rateLimits || {};
  const activeLimit = rateLimits[hostname];
  if (activeLimit && Number(activeLimit.resetAt) > nowFn()) {
    const waitSec = Math.ceil((Number(activeLimit.resetAt) - nowFn()) / 1000);
    throw makeUpdateError(
      'UPDATE_RATE_LIMITED',
      `Rate limit active for ${hostname}, retry after ${waitSec}s`,
      { url: redactUrl(url), resetAt: Number(activeLimit.resetAt), host: hostname }
    );
  }

  const timeoutMs = Number(ctx.timeoutMs) > 0 ? Number(ctx.timeoutMs) : CHECK_TIMEOUT_MS;
  const maxBytes = Number(ctx.maxBytes) > 0 ? Number(ctx.maxBytes) : MAX_CHECK_RESPONSE_BYTES;
  const retryDelays = Array.isArray(ctx.retryDelaysMs) ? ctx.retryDelaysMs : DEFAULT_RETRY_DELAYS_MS;
  const maxAttempts = 1 + retryDelays.length;

  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(makeUpdateError('UPDATE_NETWORK_TIMEOUT', `Request timed out after ${timeoutMs}ms`)), timeoutMs);
    try {
      const resp = await fetchImpl(url, {
        ...fetchOpts,
        signal: controller.signal
      });
      clearTimeout(timer);

      if (resp.status === 304) {
        return { notModified: true, status: 304, headers: resp.headers };
      }

      if (resp.status === 429 || (resp.status === 403 && hostname.includes('github'))) {
        const remaining = resp.headers?.get?.('x-ratelimit-remaining');
        let bodyText = '';
        try { bodyText = await resp.text(); } catch {}
        const isRateLimit = resp.status === 429 || remaining === '0' || /rate limit/i.test(bodyText);
        if (isRateLimit) {
          const waitMs = parseRetryAfterMs(resp.headers, nowFn()) || 60000;
          const resetAt = nowFn() + waitMs;
          rateLimits[hostname] = { resetAt, lastErrorCode: 'UPDATE_RATE_LIMITED' };
          throw makeUpdateError(
            'UPDATE_RATE_LIMITED',
            `Remote rate limit exceeded (${resp.status}) at ${redactUrl(url)}`,
            { statusCode: resp.status, resetAt, host: hostname, url: redactUrl(url) }
          );
        }
        throw makeUpdateError(
          'UPDATE_NETWORK_ERROR',
          `HTTP ${resp.status} from ${redactUrl(url)}`,
          { statusCode: resp.status, url: redactUrl(url), noRetry: true }
        );
      }

      if (resp.status === 401 || resp.status === 403 || resp.status === 404) {
        throw makeUpdateError(
          'UPDATE_NETWORK_ERROR',
          `HTTP ${resp.status} from ${redactUrl(url)}`,
          { statusCode: resp.status, url: redactUrl(url), noRetry: true }
        );
      }

      if ([502, 503, 504].includes(resp.status)) {
        throw makeUpdateError(
          'UPDATE_NETWORK_ERROR',
          `Transient HTTP ${resp.status} from ${redactUrl(url)}`,
          { statusCode: resp.status, url: redactUrl(url), transient: true }
        );
      }

      if (!resp.ok) {
        throw makeUpdateError(
          'UPDATE_NETWORK_ERROR',
          `HTTP ${resp.status} from ${redactUrl(url)}`,
          { statusCode: resp.status, url: redactUrl(url), noRetry: resp.status >= 400 && resp.status < 500 }
        );
      }

      const contentLen = Number(resp.headers?.get?.('content-length'));
      if (Number.isFinite(contentLen) && contentLen > maxBytes) {
        throw makeUpdateError(
          'UPDATE_NETWORK_ERROR',
          `Response exceeded max allowed size (${contentLen} > ${maxBytes})`,
          { url: redactUrl(url), noRetry: true }
        );
      }

      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > maxBytes) {
        throw makeUpdateError(
          'UPDATE_NETWORK_ERROR',
          `Response body exceeded max allowed size (${buf.length} > ${maxBytes})`,
          { url: redactUrl(url), noRetry: true }
        );
      }

      return { notModified: false, status: resp.status, headers: resp.headers, buffer: buf };
    } catch (err) {
      clearTimeout(timer);
      if (err?.name === 'AbortError' || err?.code === 'UPDATE_NETWORK_TIMEOUT') {
        lastErr = makeUpdateError(
          'UPDATE_NETWORK_TIMEOUT',
          `Request timed out (${timeoutMs}ms): ${redactUrl(url)}`,
          { url: redactUrl(url) }
        );
      } else {
        lastErr = err;
      }

      if (
        lastErr.code === 'UPDATE_RATE_LIMITED' ||
        lastErr.noRetry === true ||
        (!lastErr.transient && !isTransientNetworkError(lastErr))
      ) {
        throw lastErr;
      }

      if (attempt < retryDelays.length) {
        const baseDelay = Number(retryDelays[attempt]) || 0;
        const jitter = baseDelay > 0 ? Math.floor(Math.random() * 250) : 0;
        await sleepMs(baseDelay + jitter);
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

async function fetchJsonWithRetry(url, opts = {}, ctx = {}) {
  const cacheEntry = ctx.httpCache?.[url];
  const headers = { ...(opts.headers || {}) };
  if (cacheEntry?.etag) headers['If-None-Match'] = cacheEntry.etag;
  if (cacheEntry?.lastModified) headers['If-Modified-Since'] = cacheEntry.lastModified;

  const res = await fetchWithRetryCore(url, { ...opts, headers }, {
    ...ctx,
    timeoutMs: ctx.timeoutMs || CHECK_TIMEOUT_MS,
    maxBytes: ctx.maxBytes || MAX_CHECK_RESPONSE_BYTES
  });
  if (res.notModified) {
    return {
      notModified: true,
      data: cacheEntry?.summary || null,
      etag: cacheEntry?.etag || null,
      lastModified: cacheEntry?.lastModified || null
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(res.buffer.toString('utf8'));
  } catch (err) {
    throw makeUpdateError('UPDATE_NETWORK_ERROR', `Invalid JSON from ${redactUrl(url)}: ${err.message}`, {
      url: redactUrl(url)
    });
  }
  return {
    notModified: false,
    data: parsed,
    etag: res.headers?.get?.('etag') || null,
    lastModified: res.headers?.get?.('last-modified') || null
  };
}

async function fetchBufferWithRetry(url, opts = {}, ctx = {}) {
  const res = await fetchWithRetryCore(url, opts, {
    ...ctx,
    timeoutMs: ctx.timeoutMs || DOWNLOAD_TIMEOUT_MS,
    maxBytes: ctx.maxBytes || MAX_DOWNLOAD_BYTES
  });
  return res.buffer;
}

function compactNpmMetaForCache(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const distTags = meta['dist-tags'] && typeof meta['dist-tags'] === 'object' ? { ...meta['dist-tags'] } : {};
  const versions = meta.versions && typeof meta.versions === 'object' ? meta.versions : {};
  const keepVersions = new Set(Object.values(distTags).filter((v) => typeof v === 'string'));
  const semverKeys = Object.keys(versions)
    .filter((v) => parseSemver(v))
    .sort((a, b) => compareSemver(b, a))
    .slice(0, 12);
  for (const v of semverKeys) keepVersions.add(v);

  const compactVersions = {};
  for (const ver of keepVersions) {
    const vObj = versions[ver];
    if (!vObj || typeof vObj !== 'object') continue;
    compactVersions[ver] = {
      version: ver,
      dist: vObj.dist ? { tarball: vObj.dist.tarball || null, integrity: vObj.dist.integrity || null } : null,
      engines: vObj.engines || null,
      agyDaddy: vObj.agyDaddy || null
    };
  }
  return {
    name: meta.name || null,
    'dist-tags': distTags,
    versions: compactVersions
  };
}

function selectNpmCandidateVersion(meta, channel = 'stable', versionRange = '*') {
  const distTags = meta?.['dist-tags'] && typeof meta['dist-tags'] === 'object' ? meta['dist-tags'] : {};
  const versions = meta?.versions && typeof meta.versions === 'object' ? meta.versions : {};
  const latestVer = distTags.latest && versions[distTags.latest] ? distTags.latest : null;
  let channelVer = latestVer;
  if (channel === 'next' && distTags.next && versions[distTags.next]) {
    if (!latestVer || compareSemverSafe(distTags.next, latestVer) >= 0) {
      channelVer = distTags.next;
    }
  }
  if (!channelVer) {
    const valid = Object.keys(versions).filter((v) => parseSemver(v)).sort((a, b) => compareSemver(b, a));
    channelVer = valid[0] || null;
  }

  const cleanRange = String(versionRange || '*').trim() || '*';
  let candidateVer = channelVer;
  let majorUpdateAvailable = null;
  const isExactSemverSpec = Boolean(parseSemver(cleanRange));

  if (cleanRange !== '*' && cleanRange !== 'latest' && cleanRange !== 'next' && !isExactSemverSpec) {
    if (distTags[cleanRange] && versions[distTags[cleanRange]]) {
      candidateVer = distTags[cleanRange];
    } else {
      const valid = Object.keys(versions)
        .filter((v) => parseSemver(v) && satisfies(v, cleanRange))
        .sort((a, b) => compareSemver(b, a));
      const rangeBest = valid[0] || null;
      if (rangeBest) {
        candidateVer = rangeBest;
        if (channelVer && compareSemverSafe(channelVer, rangeBest) > 0 && isMajorBump(rangeBest, channelVer)) {
          majorUpdateAvailable = channelVer;
        }
      } else if (channelVer) {
        candidateVer = channelVer;
      }
    }
  }

  const verObj = candidateVer ? versions[candidateVer] : null;
  return {
    candidateVer,
    channelVer,
    majorUpdateAvailable,
    verObj,
    tarballUrl: verObj?.dist?.tarball || null,
    integrity: verObj?.dist?.integrity || null
  };
}

async function fetchNpmPackageMeta(packageName, npmRegistryUrl, ctx) {
  const metaUrl = `${npmRegistryUrl.replace(/\/+$/, '')}/${encodeNpmPackagePath(packageName)}`;
  const nowFn = typeof ctx.now === 'function' ? ctx.now : Date.now;
  const res = await fetchJsonWithRetry(metaUrl, {
    headers: { Accept: 'application/json' }
  }, ctx);
  if (!res.notModified && res.data) {
    ctx.httpCache[metaUrl] = {
      etag: res.etag,
      lastModified: res.lastModified,
      cachedAt: nowFn(),
      summary: compactNpmMetaForCache(res.data)
    };
    return { metaUrl, meta: ctx.httpCache[metaUrl].summary };
  }
  return { metaUrl, meta: res.data || ctx.httpCache[metaUrl]?.summary || null };
}

function findMatchingReleaseForPackage(releases, expectedScope, repoSlug) {
  if (!Array.isArray(releases)) return null;
  for (const rel of releases) {
    if (!rel || typeof rel !== 'object') continue;
    const tagName = String(rel.tag_name || '').trim();
    if (!tagName) continue;
    const scoped = expectedScope ? extractSemverFromTag(tagName, expectedScope) : null;
    const root = extractSemverFromTag(tagName, null);
    const ver = scoped || root;
    if (ver) {
      return { release: rel, version: ver, isRootTag: Boolean(!scoped && root) };
    }
  }
  return null;
}

async function fetchGitHubRepoCheck(repoSlug, channel, options, ctx) {
  const headers = getGithubHeaders(options);
  const nowFn = typeof ctx.now === 'function' ? ctx.now : Date.now;
  const relUrl = `https://api.github.com/repos/${repoSlug}/releases?per_page=10`;
  let releases = [];
  try {
    const relRes = await fetchJsonWithRetry(relUrl, { headers }, ctx);
    if (!relRes.notModified && Array.isArray(relRes.data)) {
      const compact = relRes.data.slice(0, 10).map((r) => ({
        tag_name: r.tag_name,
        draft: Boolean(r.draft),
        prerelease: Boolean(r.prerelease),
        html_url: r.html_url || null,
        tarball_url: r.tarball_url || null,
        assets: Array.isArray(r.assets)
          ? r.assets.map((a) => ({ name: a.name, browser_download_url: a.browser_download_url }))
          : []
      }));
      ctx.httpCache[relUrl] = {
        etag: relRes.etag,
        lastModified: relRes.lastModified,
        cachedAt: nowFn(),
        summary: compact
      };
      releases = compact;
    } else if (Array.isArray(relRes.data)) {
      releases = relRes.data;
    }
  } catch (err) {
    if (err.statusCode !== 404) throw err;
  }

  const eligibleReleases = releases.filter((r) => r && !r.draft && (channel === 'next' || !r.prerelease));
  if (eligibleReleases.length > 0) {
    return { kind: 'releases', releases: eligibleReleases, tags: [] };
  }

  const tagsUrl = `https://api.github.com/repos/${repoSlug}/tags?per_page=20`;
  let tags = [];
  try {
    const tagRes = await fetchJsonWithRetry(tagsUrl, { headers }, ctx);
    if (!tagRes.notModified && Array.isArray(tagRes.data)) {
      const compactTags = tagRes.data.slice(0, 20).map((t) => ({
        name: t.name,
        commitSha: t.commit?.sha || null
      }));
      ctx.httpCache[tagsUrl] = {
        etag: tagRes.etag,
        lastModified: tagRes.lastModified,
        cachedAt: nowFn(),
        summary: compactTags
      };
      tags = compactTags;
    } else if (Array.isArray(tagRes.data)) {
      tags = tagRes.data;
    }
  } catch (err) {
    if (err.statusCode !== 404) throw err;
  }

  return { kind: tags.length > 0 ? 'tags' : 'none', releases: [], tags };
}

async function fetchReleaseManifestIfPresent(release, options, ctx) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const manifestAsset = assets.find((a) => a && a.name === 'release-manifest.json' && a.browser_download_url);
  if (!manifestAsset) return null;
  const nowFn = typeof ctx.now === 'function' ? ctx.now : Date.now;
  const res = await fetchJsonWithRetry(manifestAsset.browser_download_url, {
    headers: getGithubHeaders(options)
  }, ctx);
  if (!res.notModified && res.data) {
    ctx.httpCache[manifestAsset.browser_download_url] = {
      etag: res.etag,
      lastModified: res.lastModified,
      cachedAt: nowFn(),
      summary: res.data
    };
  }
  return res.data || null;
}

function matchPackageInReleaseManifest(releaseManifest, pkgName, dirName) {
  const pkgs = Array.isArray(releaseManifest?.packages) ? releaseManifest.packages : [];
  return pkgs.find((p) => (pkgName && p.name === pkgName) || (dirName && p.dirName === dirName)) || null;
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIdx = 0;
  async function runOne() {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      results[idx] = await worker(items[idx], idx);
    }
  }
  const runners = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, () => runOne());
  await Promise.all(runners);
  return results;
}

function buildUpdateSummary(targets = {}) {
  let availableCount = 0;
  let pluginAvailableCount = 0;
  let hostAvailable = false;
  let registryAvailable = false;
  let blockedCount = 0;

  for (const t of Object.values(targets)) {
    if (!t || typeof t !== 'object') continue;
    if (t.status === 'blocked') blockedCount++;
    const hasActionableUpdate = t.status === 'available';
    if (hasActionableUpdate) {
      availableCount++;
      if (t.kind === 'host') hostAvailable = true;
      else if (t.kind === 'registry') registryAvailable = true;
      else if (t.kind === 'plugin') pluginAvailableCount++;
    }
  }

  return {
    availableCount,
    pluginAvailableCount,
    hostAvailable,
    registryAvailable,
    blockedCount
  };
}

function normalizeHostUpdateSettingsView(raw = {}) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    updateChannel: VALID_UPDATE_CHANNELS.has(s.updateChannel) ? s.updateChannel : 'stable',
    autoUpdateMode: VALID_AUTO_UPDATE_MODES.has(s.autoUpdateMode) ? s.autoUpdateMode : 'notify',
    updateCheckInterval: VALID_CHECK_INTERVALS.has(s.updateCheckInterval) ? s.updateCheckInterval : '6h',
    updateSourcePreference: VALID_SOURCE_PREFERENCES.has(s.updateSourcePreference) ? s.updateSourcePreference : 'auto',
    npmRegistryUrl: normalizeNpmRegistryUrl(s.npmRegistryUrl)
  };
}

function getCachedUpdateStatus(options = {}) {
  const stateDir = getStateDir(options);
  const pluginsDir = getPluginsDir(options);
  const state = readUpdateState(options);
  const hostInfo = detectHostInstallMode(options);
  const installedList = Object.values(readInstalledIndex(options).plugins || {});
  const hostSettings = normalizeHostUpdateSettingsView(options.hostSettings || {});

  const targets = {};
  const cachedHost = state.targets?.host;
  if (cachedHost && typeof cachedHost === 'object') {
    const cmp = compareSemverSafe(cachedHost.latestVersion, hostInfo.hostVersion);
    const upToDate = cmp !== null ? cmp <= 0 : false;
    targets.host = {
      ...cachedHost,
      targetId: 'host',
      kind: 'host',
      installMode: hostInfo.installMode,
      writable: hostInfo.writable,
      dirtyWorktree: hostInfo.dirtyWorktree,
      currentVersion: hostInfo.hostVersion,
      hasRollback: hostInfo.hasHostRollback,
      status: upToDate && !cachedHost.commitsBehind
        ? 'up_to_date'
        : (cachedHost.status === 'blocked' ? 'blocked' : (cmp > 0 || cachedHost.commitsBehind ? 'available' : cachedHost.status)),
      ...(upToDate && !cachedHost.commitsBehind ? { blockReason: null, autoSafeEligible: false } : {})
    };
  } else {
    targets.host = {
      targetId: 'host',
      kind: 'host',
      installMode: hostInfo.installMode,
      writable: hostInfo.writable,
      dirtyWorktree: hostInfo.dirtyWorktree,
      sourceKind: hostInfo.installMode === 'git' ? 'git' : 'npm',
      currentVersion: hostInfo.hostVersion,
      latestVersion: hostInfo.hostVersion,
      status: 'up_to_date',
      blockReason: null,
      autoSafeEligible: false,
      requiresHostRestart: false,
      requiresDaemonRestart: false,
      wrapperUpdateRecommended: false,
      wrapperMinVersion: null,
      releaseNotesUrl: null,
      hasRollback: hostInfo.hasHostRollback,
      lastFailedVersion: null
    };
  }

  const cachedReg = state.targets?.registry;
  if (cachedReg && typeof cachedReg === 'object') {
    const cmp = compareSemverSafe(cachedReg.latestVersion, hostInfo.anchorsVersion);
    const upToDate = cmp !== null ? cmp <= 0 : false;
    targets.registry = {
      ...cachedReg,
      targetId: 'registry',
      kind: 'registry',
      currentVersion: hostInfo.anchorsVersion,
      hasRollback: hostInfo.hasRegistryRollback,
      status: upToDate ? 'up_to_date' : cachedReg.status,
      ...(upToDate ? { blockReason: null, autoSafeEligible: false } : {})
    };
  } else {
    targets.registry = {
      targetId: 'registry',
      kind: 'registry',
      sourceKind: 'npm',
      currentVersion: hostInfo.anchorsVersion,
      latestVersion: hostInfo.anchorsVersion,
      status: 'up_to_date',
      autoSafeEligible: false,
      hasRollback: hostInfo.hasRegistryRollback,
      lastFailedVersion: null
    };
  }

  for (const rec of installedList) {
    if (!rec || !rec.id) continue;
    const rollbackDir = path.join(pluginsDir, '.rollback', `${rec.id}.prev`);
    const hasRollback = fs.existsSync(rollbackDir);
    const cachedPlugin = state.targets?.[rec.id];
    const localVer = rec.version || '0.0.0';
    if (cachedPlugin && typeof cachedPlugin === 'object') {
      let status = cachedPlugin.status || 'up_to_date';
      let blockReason = cachedPlugin.blockReason || null;
      let autoSafeEligible = Boolean(cachedPlugin.autoSafeEligible);
      const cmp = cachedPlugin.latestVersion ? compareSemverSafe(cachedPlugin.latestVersion, localVer) : null;
      const commitChanged = Boolean(cachedPlugin.latestCommit && rec.commitSha && cachedPlugin.latestCommit !== rec.commitSha);
      if (rec.sourceKind === 'local' && !String(rec.sourceSpec || '').startsWith('bundled:')) {
        status = 'local_exempt';
        autoSafeEligible = false;
      } else if (rec.pinned) {
        status = cmp > 0 || commitChanged ? 'blocked' : 'up_to_date';
        blockReason = cmp > 0 || commitChanged ? 'PLUGIN_PINNED' : null;
        autoSafeEligible = false;
      } else if (cmp !== null && cmp <= 0 && !commitChanged) {
        status = 'up_to_date';
        blockReason = null;
        autoSafeEligible = false;
      }
      targets[rec.id] = {
        ...cachedPlugin,
        targetId: rec.id,
        kind: 'plugin',
        trustLevel: rec.trustLevel || cachedPlugin.trustLevel || 'T2',
        pinned: Boolean(rec.pinned),
        sourceKind: rec.sourceKind || cachedPlugin.sourceKind || 'local',
        sourceSpec: rec.sourceSpec || cachedPlugin.sourceSpec || '',
        currentVersion: localVer,
        currentCommit: rec.commitSha || null,
        hasRollback,
        status,
        blockReason,
        autoSafeEligible: rec.trustLevel === 'T0' && !rec.pinned && autoSafeEligible
      };
    } else {
      targets[rec.id] = {
        targetId: rec.id,
        kind: 'plugin',
        trustLevel: rec.trustLevel || 'T2',
        pinned: Boolean(rec.pinned),
        sourceKind: rec.sourceKind || 'local',
        sourceSpec: rec.sourceSpec || '',
        currentVersion: localVer,
        latestVersion: localVer,
        majorUpdateAvailable: null,
        currentCommit: rec.commitSha || null,
        latestCommit: null,
        status: rec.sourceKind === 'local' && !String(rec.sourceSpec || '').startsWith('bundled:') ? 'local_exempt' : 'up_to_date',
        blockReason: null,
        addedPermissions: [],
        addedHighRiskPermissions: [],
        requiredHostApi: null,
        autoSafeEligible: false,
        hasRollback,
        lastFailedVersion: null,
        releaseNotesUrl: null
      };
    }
  }

  const summary = buildUpdateSummary(targets);
  return {
    ok: true,
    hostVersion: hostInfo.hostVersion,
    hostApiVersion: hostInfo.hostApiVersion,
    anchorsVersion: hostInfo.anchorsVersion,
    installMode: hostInfo.installMode,
    writable: hostInfo.writable,
    dirtyWorktree: hostInfo.dirtyWorktree,
    settings: hostSettings,
    lastCheckedAt: state.lastCheckedAt || null,
    channel: state.channel || hostSettings.updateChannel,
    rateLimits: state.rateLimits || {},
    summary,
    targets
  };
}

function resolveRequestedTargetIds(rawTargets, installedPlugins) {
  if (!rawTargets || rawTargets === 'all') {
    return ['host', 'registry', ...installedPlugins.map((p) => p.id)];
  }
  const arr = Array.isArray(rawTargets) ? rawTargets : [rawTargets];
  const ids = new Set();
  for (const item of arr) {
    const t = String(item || '').trim();
    if (!t) continue;
    if (t === 'all') {
      ids.add('host');
      ids.add('registry');
      for (const p of installedPlugins) ids.add(p.id);
    } else if (t === 'plugins') {
      for (const p of installedPlugins) ids.add(p.id);
    } else {
      ids.add(t);
    }
  }
  return Array.from(ids);
}

async function checkHostTarget({ hostInfo, channel, sourcePref, npmRegistryUrl, prevTarget, options, ctx }) {
  const baseTarget = {
    targetId: 'host',
    kind: 'host',
    installMode: hostInfo.installMode,
    writable: hostInfo.writable,
    dirtyWorktree: hostInfo.dirtyWorktree,
    sourceKind: sourcePref === 'github' ? 'github' : (hostInfo.installMode === 'git' && sourcePref === 'auto' ? 'git' : 'npm'),
    currentVersion: hostInfo.hostVersion,
    latestVersion: hostInfo.hostVersion,
    status: 'up_to_date',
    blockReason: null,
    autoSafeEligible: false,
    requiresHostRestart: false,
    requiresDaemonRestart: false,
    wrapperUpdateRecommended: false,
    wrapperMinVersion: null,
    wrappersChecksumsUrl: null,
    releaseNotesUrl: null,
    tarballUrl: null,
    integrity: null,
    hasRollback: hostInfo.hasHostRollback,
    lastFailedVersion: prevTarget?.lastFailedVersion || null,
    commitsBehind: 0
  };

  if (hostInfo.installMode === 'git' && sourcePref !== 'npm' && sourcePref !== 'github') {
    const gitRun = options.gitRunner || defaultGitRunner;
    const hostRoot = hostInfo.hostRoot;
    let commitsBehind = 0;
    let latestVer = hostInfo.hostVersion;
    try {
      const remoteUrl = gitRun(['remote', 'get-url', 'origin'], hostRoot);
      const canNetworkGit = Boolean(options.gitRunner) || options.allowNetworkInTest === true || !isTestMode() || isLoopbackOrLocalUrl(remoteUrl);
      if (canNetworkGit) {
        gitRun(['fetch', '--tags', '--quiet'], hostRoot);
      }
      try {
        const behindRaw = gitRun(['rev-list', '--count', 'HEAD..@{u}'], hostRoot);
        commitsBehind = Math.max(0, Number(behindRaw) || 0);
      } catch {}
    } catch {}

    const hasUpdate = commitsBehind > 0;
    if (hasUpdate && hostInfo.dirtyWorktree) {
      return {
        ...baseTarget,
        sourceKind: 'git',
        latestVersion: latestVer,
        commitsBehind,
        status: 'blocked',
        blockReason: 'DIRTY_WORKTREE',
        autoSafeEligible: false
      };
    }
    return {
      ...baseTarget,
      sourceKind: 'git',
      latestVersion: latestVer,
      commitsBehind,
      status: hasUpdate ? 'available' : 'up_to_date',
      requiresDaemonRestart: hasUpdate,
      autoSafeEligible: false
    };
  }

  const useGitHub = sourcePref === 'github';
  if (!useGitHub) {
    const { metaUrl, meta } = await fetchNpmPackageMeta('@agy-daddy/host', npmRegistryUrl, ctx);
    const sel = selectNpmCandidateVersion(meta, channel, '*');
    const latestVer = sel.candidateVer || hostInfo.hostVersion;
    const cmp = compareSemverSafe(latestVer, hostInfo.hostVersion);
    const hasUpdate = cmp !== null && cmp > 0;
    let status = hasUpdate ? 'available' : 'up_to_date';
    let blockReason = null;

    if (hasUpdate && hostInfo.installMode === 'git' && hostInfo.dirtyWorktree) {
      status = 'blocked';
      blockReason = 'DIRTY_WORKTREE';
    } else if (hasUpdate && !hostInfo.writable) {
      status = 'blocked';
      blockReason = 'UPDATE_FS_PERMISSION_DENIED';
    }

    const major = hasUpdate && isMajorBump(hostInfo.hostVersion, latestVer);
    const autoSafeEligible = Boolean(
      status === 'available' &&
      hostInfo.installMode === 'wrapper' &&
      hostInfo.writable &&
      !major &&
      latestVer !== baseTarget.lastFailedVersion
    );

    return {
      ...baseTarget,
      sourceKind: 'npm',
      sourceUrl: metaUrl,
      latestVersion: latestVer,
      tarballUrl: sel.tarballUrl,
      integrity: sel.integrity,
      releaseNotesUrl: hasUpdate ? `https://github.com/${DEFAULT_GITHUB_REPO}/releases/tag/v${latestVer}` : null,
      status,
      blockReason,
      requiresDaemonRestart: hasUpdate,
      autoSafeEligible
    };
  }

  // GitHub source check for host
  const gh = await fetchGitHubRepoCheck(DEFAULT_GITHUB_REPO, channel, options, ctx);
  const matched = findMatchingReleaseForPackage(gh.releases, 'host', DEFAULT_GITHUB_REPO);
  let latestVer = hostInfo.hostVersion;
  let releaseNotesUrl = null;
  let tarballUrl = null;
  let integrity = null;
  let wrapperMinVersion = null;
  let wrapperUpdateRecommended = false;
  let wrappersChecksumsUrl = null;

  if (matched) {
    latestVer = matched.version;
    releaseNotesUrl = matched.release.html_url || null;
    tarballUrl = matched.release.tarball_url || null;
    const checksumAsset = (matched.release.assets || []).find((a) => a.name === 'agy-daddy-wrappers-sha256sums.txt');
    if (checksumAsset) wrappersChecksumsUrl = checksumAsset.browser_download_url;
    const relManifest = await fetchReleaseManifestIfPresent(matched.release, options, ctx).catch(() => null);
    if (relManifest) {
      const entry = matchPackageInReleaseManifest(relManifest, '@agy-daddy/host', 'agy-daddy-host');
      if (entry?.version) latestVer = entry.version;
      if (entry?.sha512) integrity = entry.sha512;
      if (entry?.tarballUrl) tarballUrl = entry.tarballUrl;
      if (relManifest.wrapperMinVersion) {
        wrapperMinVersion = String(relManifest.wrapperMinVersion);
        if (hostInfo.wrapperVersion && compareSemverSafe(wrapperMinVersion, hostInfo.wrapperVersion) > 0) {
          wrapperUpdateRecommended = true;
        }
      }
    }
  } else if (gh.tags.length > 0) {
    const tagVers = gh.tags
      .map((t) => extractSemverFromTag(t.name, 'host') || extractSemverFromTag(t.name, null))
      .filter(Boolean)
      .sort((a, b) => compareSemver(b, a));
    if (tagVers[0]) latestVer = tagVers[0];
  }

  const cmp = compareSemverSafe(latestVer, hostInfo.hostVersion);
  const hasUpdate = cmp !== null && cmp > 0;
  let status = hasUpdate ? 'available' : 'up_to_date';
  let blockReason = null;
  if (hasUpdate && !hostInfo.writable) {
    status = 'blocked';
    blockReason = 'UPDATE_FS_PERMISSION_DENIED';
  }
  const major = hasUpdate && isMajorBump(hostInfo.hostVersion, latestVer);
  const autoSafeEligible = Boolean(
    status === 'available' &&
    hostInfo.installMode === 'wrapper' &&
    hostInfo.writable &&
    !major &&
    latestVer !== baseTarget.lastFailedVersion
  );

  return {
    ...baseTarget,
    sourceKind: 'github',
    sourceUrl: `https://github.com/${DEFAULT_GITHUB_REPO}`,
    latestVersion: latestVer,
    tarballUrl,
    integrity,
    releaseNotesUrl,
    wrapperMinVersion,
    wrapperUpdateRecommended,
    wrappersChecksumsUrl,
    status,
    blockReason,
    requiresDaemonRestart: hasUpdate,
    autoSafeEligible
  };
}

async function checkRegistryTarget({ hostInfo, channel, sourcePref, npmRegistryUrl, prevTarget, options, ctx }) {
  const baseTarget = {
    targetId: 'registry',
    kind: 'registry',
    sourceKind: sourcePref === 'github' ? 'github' : 'npm',
    currentVersion: hostInfo.anchorsVersion,
    latestVersion: hostInfo.anchorsVersion,
    status: 'up_to_date',
    blockReason: null,
    autoSafeEligible: false,
    hasRollback: hostInfo.hasRegistryRollback,
    lastFailedVersion: prevTarget?.lastFailedVersion || null
  };

  if (sourcePref !== 'github') {
    const { metaUrl, meta } = await fetchNpmPackageMeta('@agy-daddy/registry', npmRegistryUrl, ctx);
    const sel = selectNpmCandidateVersion(meta, channel, '*');
    const latestVer = sel.candidateVer || hostInfo.anchorsVersion;
    const cmp = compareSemverSafe(latestVer, hostInfo.anchorsVersion);
    const hasUpdate = cmp !== null && cmp > 0;
    const major = hasUpdate && isMajorBump(hostInfo.anchorsVersion, latestVer);
    return {
      ...baseTarget,
      sourceKind: 'npm',
      sourceUrl: metaUrl,
      latestVersion: latestVer,
      tarballUrl: sel.tarballUrl,
      integrity: sel.integrity,
      status: hasUpdate ? 'available' : 'up_to_date',
      autoSafeEligible: Boolean(hasUpdate && !major && latestVer !== baseTarget.lastFailedVersion)
    };
  }

  const gh = await fetchGitHubRepoCheck(DEFAULT_GITHUB_REPO, channel, options, ctx);
  const matched = findMatchingReleaseForPackage(gh.releases, 'registry', DEFAULT_GITHUB_REPO);
  let latestVer = hostInfo.anchorsVersion;
  let tarballUrl = null;
  let integrity = null;
  if (matched) {
    latestVer = matched.version;
    tarballUrl = matched.release.tarball_url || null;
    const relManifest = await fetchReleaseManifestIfPresent(matched.release, options, ctx).catch(() => null);
    if (relManifest) {
      const entry = matchPackageInReleaseManifest(relManifest, '@agy-daddy/registry', 'agy-daddy-registry');
      if (entry?.version) latestVer = entry.version;
      if (entry?.sha512) integrity = entry.sha512;
      if (entry?.tarballUrl) tarballUrl = entry.tarballUrl;
    }
  }
  const cmp = compareSemverSafe(latestVer, hostInfo.anchorsVersion);
  const hasUpdate = cmp !== null && cmp > 0;
  const major = hasUpdate && isMajorBump(hostInfo.anchorsVersion, latestVer);
  return {
    ...baseTarget,
    sourceKind: 'github',
    sourceUrl: `https://github.com/${DEFAULT_GITHUB_REPO}`,
    latestVersion: latestVer,
    tarballUrl,
    integrity,
    status: hasUpdate ? 'available' : 'up_to_date',
    autoSafeEligible: Boolean(hasUpdate && !major && latestVer !== baseTarget.lastFailedVersion)
  };
}

async function checkPluginTarget({ rec, regEntry, channel, sourcePref, npmRegistryUrl, prevTarget, pluginsDir, options, ctx }) {
  const localVer = rec.version || '0.0.0';
  const trustLevel = rec.trustLevel || regEntry?.trustLevel || 'T2';
  const rollbackDir = path.join(pluginsDir, '.rollback', `${rec.id}.prev`);
  const hasRollback = fs.existsSync(rollbackDir);
  const sourceSpec = String(rec.sourceSpec || '');
  const isBundled = sourceSpec.startsWith('bundled:');
  const isLocal = rec.sourceKind === 'local' && !isBundled;
  const granted = Array.isArray(rec.grantedPermissions) ? rec.grantedPermissions : [];

  let manifest = null;
  if (rec.installPath && fs.existsSync(rec.installPath)) {
    try { manifest = readManifestFromDir(rec.installPath); } catch {}
  }
  const usesLaunchArgs = Boolean(
    manifest?.permissions?.includes('host:launch-args') || granted.includes('host:launch-args')
  );

  const baseTarget = {
    targetId: rec.id,
    kind: 'plugin',
    trustLevel,
    pinned: Boolean(rec.pinned),
    sourceKind: rec.sourceKind || 'local',
    sourceSpec,
    currentVersion: localVer,
    latestVersion: localVer,
    majorUpdateAvailable: null,
    currentCommit: rec.commitSha || null,
    latestCommit: null,
    status: 'up_to_date',
    blockReason: null,
    addedPermissions: [],
    addedHighRiskPermissions: [],
    requiredHostApi: manifest?.engines?.agyDaddy || null,
    autoSafeEligible: false,
    requiresHostRestart: usesLaunchArgs,
    hasRollback,
    lastFailedVersion: prevTarget?.lastFailedVersion || null,
    releaseNotesUrl: null,
    tarballUrl: null,
    integrity: null
  };

  if (isBundled) {
    return baseTarget;
  }

  if (isLocal) {
    let referenceLatestVersion = null;
    if (regEntry?.npmPackage) {
      try {
        const { meta } = await fetchNpmPackageMeta(regEntry.npmPackage, npmRegistryUrl, ctx);
        const sel = selectNpmCandidateVersion(meta, channel, '*');
        referenceLatestVersion = sel.candidateVer || null;
      } catch {}
    }
    return {
      ...baseTarget,
      latestVersion: referenceLatestVersion || localVer,
      referenceLatestVersion,
      status: 'local_exempt',
      blockReason: 'LOCAL_SOURCE_EXEMPT',
      autoSafeEligible: false
    };
  }

  let effectiveSourceKind = rec.sourceKind;
  let npmPackage = null;
  let versionRange = '*';
  let githubRepo = null;
  let gitUrl = null;
  let gitRef = null;
  let subpath = rec.subpath || regEntry?.subpath || null;

  try {
    const parsed = parsePluginSource(sourceSpec || regEntry?.npmPackage || regEntry?.repo || rec.id, options);
    if (parsed.kind === 'npm') {
      npmPackage = parsed.packageName;
      versionRange = parsed.versionRange || '*';
    } else if (parsed.kind === 'git') {
      gitUrl = parsed.url;
      gitRef = parsed.ref || null;
      subpath = parsed.subpath || subpath;
      githubRepo = parseGitHubRepoSlug(parsed.url) || parseGitHubRepoSlug(sourceSpec);
    }
  } catch {
    if (regEntry?.npmPackage) npmPackage = regEntry.npmPackage;
    if (regEntry?.repo) {
      gitUrl = regEntry.repo;
      githubRepo = parseGitHubRepoSlug(regEntry.repo);
    }
  }

  if (!npmPackage && regEntry?.npmPackage) npmPackage = regEntry.npmPackage;
  if (!githubRepo && regEntry?.repo) githubRepo = parseGitHubRepoSlug(regEntry.repo);

  if (trustLevel === 'T0' && sourcePref === 'npm' && npmPackage) {
    effectiveSourceKind = 'npm';
  } else if (trustLevel === 'T0' && sourcePref === 'github' && (githubRepo || gitUrl)) {
    effectiveSourceKind = 'git';
  }

  if (effectiveSourceKind === 'npm' && npmPackage) {
    const { metaUrl, meta } = await fetchNpmPackageMeta(npmPackage, npmRegistryUrl, ctx);
    const sel = selectNpmCandidateVersion(meta, channel, versionRange);
    const latestVer = sel.candidateVer || localVer;
    const cmp = compareSemverSafe(latestVer, localVer);
    const hasUpdate = (cmp !== null && cmp > 0) || Boolean(sel.majorUpdateAvailable);

    const candAgy = sel.verObj?.agyDaddy || {};
    const candPerms = Array.isArray(candAgy.permissions) ? candAgy.permissions : null;
    const requiredHostApi = candAgy.engines?.agyDaddy || candAgy.requires?.hostApi || null;
    const addedPermissions = candPerms ? candPerms.filter((p) => !granted.includes(p)) : [];
    const addedHighRiskPermissions = addedPermissions.filter(isHighRiskPermission);
    const hostApiOk = !requiredHostApi || satisfies(HOST_API_VERSION, requiredHostApi);

    let status = hasUpdate ? 'available' : 'up_to_date';
    let blockReason = null;
    if (hasUpdate && rec.pinned) {
      status = 'blocked';
      blockReason = 'PLUGIN_PINNED';
    } else if (hasUpdate && !hostApiOk) {
      status = 'blocked';
      blockReason = 'HOST_API_INCOMPATIBLE';
    } else if (hasUpdate && addedPermissions.length > 0) {
      status = 'blocked';
      blockReason = 'PERMISSION_CONFIRMATION_REQUIRED';
    }

    const major = Boolean(sel.majorUpdateAvailable) || (hasUpdate && isMajorBump(localVer, latestVer));
    const autoSafeEligible = Boolean(
      status === 'available' &&
      trustLevel === 'T0' &&
      !rec.pinned &&
      !major &&
      addedPermissions.length === 0 &&
      !usesLaunchArgs &&
      latestVer !== baseTarget.lastFailedVersion
    );

    return {
      ...baseTarget,
      sourceKind: 'npm',
      sourceUrl: metaUrl,
      npmPackage,
      latestVersion: latestVer,
      majorUpdateAvailable: sel.majorUpdateAvailable,
      tarballUrl: sel.tarballUrl,
      integrity: sel.integrity,
      requiredHostApi,
      addedPermissions,
      addedHighRiskPermissions,
      releaseNotesUrl: hasUpdate && githubRepo ? `https://github.com/${githubRepo}/releases/tag/v${latestVer}` : null,
      status,
      blockReason,
      autoSafeEligible
    };
  }

  // Git / GitHub plugin check
  const pinnedByRefTag = Boolean(gitRef && extractSemverFromTag(gitRef, null));
  const effectivePinned = Boolean(rec.pinned || pinnedByRefTag);

  if (githubRepo) {
    const gh = await fetchGitHubRepoCheck(githubRepo, channel, options, ctx);
    const expectedScope = regEntry?.shortName ? `plugin-${regEntry.shortName}` : null;
    const matched = findMatchingReleaseForPackage(gh.releases, expectedScope, githubRepo);

    let latestVer = localVer;
    let latestCommit = null;
    let releaseNotesUrl = null;
    let manifestSha512 = null;
    let candidateTag = null;

    if (matched) {
      latestVer = matched.version;
      candidateTag = matched.release.tag_name;
      releaseNotesUrl = matched.release.html_url || null;
      const relManifest = await fetchReleaseManifestIfPresent(matched.release, options, ctx).catch(() => null);
      if (relManifest && (regEntry?.npmPackage || subpath)) {
        const entry = matchPackageInReleaseManifest(relManifest, regEntry?.npmPackage, subpath);
        if (entry?.version) latestVer = entry.version;
        if (entry?.sha512) manifestSha512 = entry.sha512;
      }
    } else if (gh.tags.length > 0) {
      const tagEntries = gh.tags
        .map((t) => ({
          name: t.name,
          ver: (expectedScope && extractSemverFromTag(t.name, expectedScope)) || extractSemverFromTag(t.name, null),
          sha: t.commitSha
        }))
        .filter((x) => Boolean(x.ver))
        .sort((a, b) => compareSemver(b.ver, a.ver));
      if (tagEntries[0]) {
        latestVer = tagEntries[0].ver;
        candidateTag = tagEntries[0].name;
        latestCommit = tagEntries[0].sha;
      }
    }

    // Fallback to branch HEAD commit if no releases/SemVer tags
    const cmpPre = compareSemverSafe(latestVer, localVer);
    if (!matched && (cmpPre === null || cmpPre === 0)) {
      const branchRef = gitRef || 'HEAD';
      const commitUrl = `https://api.github.com/repos/${githubRepo}/commits/${encodeURIComponent(branchRef)}`;
      try {
        const cRes = await fetchJsonWithRetry(commitUrl, { headers: getGithubHeaders(options) }, ctx);
        if (cRes.data?.sha) {
          latestCommit = String(cRes.data.sha);
        }
      } catch (err) {
        if (err.statusCode !== 404) throw err;
      }
    }

    const cmp = compareSemverSafe(latestVer, localVer);
    const semverHigher = cmp !== null && cmp > 0;
    const commitChanged = Boolean(latestCommit && rec.commitSha && latestCommit !== rec.commitSha);
    const hasUpdate = semverHigher || commitChanged;

    let status = hasUpdate ? 'available' : 'up_to_date';
    let blockReason = null;
    if (hasUpdate && effectivePinned) {
      status = 'blocked';
      blockReason = 'PLUGIN_PINNED';
    }
    const major = semverHigher && isMajorBump(localVer, latestVer);
    const autoSafeEligible = Boolean(
      status === 'available' &&
      trustLevel === 'T0' &&
      !effectivePinned &&
      !major &&
      !usesLaunchArgs &&
      latestVer !== baseTarget.lastFailedVersion
    );

    return {
      ...baseTarget,
      sourceKind: 'git',
      sourceUrl: `https://github.com/${githubRepo}`,
      pinned: effectivePinned,
      latestVersion: latestVer,
      latestCommit,
      candidateRef: candidateTag || gitRef || null,
      manifestSha512,
      releaseNotesUrl,
      status,
      blockReason,
      autoSafeEligible
    };
  }

  // Generic git URL via git ls-remote
  if (gitUrl) {
    const gitRun = options.gitRunner || defaultGitRunner;
    const canNetworkGit = Boolean(options.gitRunner) || options.allowNetworkInTest === true || !isTestMode() || isLoopbackOrLocalUrl(gitUrl);
    if (canNetworkGit) {
      const lsOut = gitRun(['ls-remote', gitUrl, gitRef || 'HEAD', 'refs/tags/*'], undefined);
      const lines = String(lsOut || '').split(/\r?\n/).filter(Boolean);
      const tagVersions = [];
      let headSha = null;
      for (const line of lines) {
        const [sha, refName] = line.trim().split(/\s+/);
        if (!sha || !refName) continue;
        if (refName.startsWith('refs/tags/')) {
          const rawTag = refName.slice('refs/tags/'.length).replace(/\^\{\}$/, '');
          const ver = extractSemverFromTag(rawTag, null);
          if (ver) tagVersions.push({ ver, tag: rawTag, sha });
        } else if (!headSha) {
          headSha = sha;
        }
      }
      tagVersions.sort((a, b) => compareSemver(b.ver, a.ver));
      const bestTag = tagVersions[0] || null;
      const latestVer = bestTag ? bestTag.ver : localVer;
      const latestCommit = bestTag ? bestTag.sha : headSha;
      const semverHigher = compareSemverSafe(latestVer, localVer) > 0;
      const commitChanged = Boolean(latestCommit && rec.commitSha && latestCommit !== rec.commitSha);
      const hasUpdate = semverHigher || commitChanged;
      let status = hasUpdate ? 'available' : 'up_to_date';
      let blockReason = null;
      if (hasUpdate && effectivePinned) {
        status = 'blocked';
        blockReason = 'PLUGIN_PINNED';
      }
      return {
        ...baseTarget,
        sourceKind: 'git',
        sourceUrl: redactUrl(gitUrl),
        pinned: effectivePinned,
        latestVersion: latestVer,
        latestCommit,
        candidateRef: bestTag?.tag || gitRef || null,
        status,
        blockReason,
        autoSafeEligible: false
      };
    }
  }

  return baseTarget;
}

async function checkUpdates(options = {}) {
  const nowFn = typeof options.now === 'function' ? options.now : Date.now;
  const stateDir = getStateDir(options);
  const pluginsDir = getPluginsDir(options);
  const hostSettings = normalizeHostUpdateSettingsView(options.hostSettings || {});
  const channel = VALID_UPDATE_CHANNELS.has(options.channel) ? options.channel : hostSettings.updateChannel;
  const sourcePref = VALID_SOURCE_PREFERENCES.has(options.sourcePreference)
    ? options.sourcePreference
    : hostSettings.updateSourcePreference;
  const npmRegistryUrl = resolveEffectiveNpmRegistry(options, hostSettings);
  const prevState = readUpdateState(options);

  const debounceMs = Number.isFinite(Number(options.debounceMs))
    ? Math.max(0, Number(options.debounceMs))
    : MANUAL_CHECK_DEBOUNCE_MS;
  if (
    !options.forceRefresh &&
    !options.ignoreDebounce &&
    prevState.lastCheckAttemptAt > 0 &&
    prevState.channel === channel &&
    (nowFn() - Number(prevState.lastCheckAttemptAt)) < debounceMs
  ) {
    const cached = getCachedUpdateStatus(options);
    return {
      ...cached,
      checkedNow: false,
      debounced: true,
      errors: []
    };
  }

  const hostInfo = detectHostInstallMode(options);
  const installedList = Object.values(readInstalledIndex(options).plugins || {});
  const reg = loadRegistry(options);
  const regById = new Map((Array.isArray(reg?.plugins) ? reg.plugins : []).map((p) => [p.id, p]));
  const targetIds = resolveRequestedTargetIds(options.targets, installedList);

  const ctx = {
    fetch: options.fetch,
    allowNetworkInTest: options.allowNetworkInTest,
    now: nowFn,
    timeoutMs: options.checkTimeoutMs || CHECK_TIMEOUT_MS,
    retryDelaysMs: options.retryDelaysMs,
    httpCache: { ...(prevState.httpCache || {}) },
    rateLimits: { ...(prevState.rateLimits || {}) }
  };

  const nextTargets = { ...(prevState.targets || {}) };
  const errors = [];

  await runWithConcurrency(targetIds, CHECK_CONCURRENCY, async (tid) => {
    try {
      if (tid === 'host') {
        nextTargets.host = await checkHostTarget({
          hostInfo,
          channel,
          sourcePref,
          npmRegistryUrl,
          prevTarget: prevState.targets?.host,
          options,
          ctx
        });
      } else if (tid === 'registry') {
        nextTargets.registry = await checkRegistryTarget({
          hostInfo,
          channel,
          sourcePref,
          npmRegistryUrl,
          prevTarget: prevState.targets?.registry,
          options,
          ctx
        });
      } else {
        const rec = installedList.find((p) => p.id === tid);
        if (!rec) return;
        nextTargets[tid] = await checkPluginTarget({
          rec,
          regEntry: regById.get(tid),
          channel,
          sourcePref,
          npmRegistryUrl,
          prevTarget: prevState.targets?.[tid],
          pluginsDir,
          options,
          ctx
        });
      }
    } catch (err) {
      const code = err?.code || 'UPDATE_NETWORK_ERROR';
      const msg = err?.message || String(err);
      errors.push({
        targetId: tid,
        errorCode: code,
        errorMessage: msg
      });
    }
  });

  const nowIso = new Date(nowFn()).toISOString();
  const nextState = {
    ...prevState,
    schemaVersion: 1,
    lastCheckedAt: errors.length < targetIds.length || targetIds.length === 0 ? nowIso : prevState.lastCheckedAt,
    lastCheckAttemptAt: nowFn(),
    ...(options.trigger === 'scheduled' ? { lastScheduledCheckAt: nowIso } : {}),
    channel,
    httpCache: ctx.httpCache,
    rateLimits: ctx.rateLimits,
    targets: nextTargets
  };
  writeUpdateState(nextState, { ...options, stateDir });

  const view = getCachedUpdateStatus({ ...options, stateDir, hostSettings: { ...hostSettings, updateChannel: channel } });
  return {
    ...view,
    ok: errors.length === 0 || errors.length < targetIds.length,
    checkedNow: true,
    debounced: false,
    errors
  };
}

module.exports = {
  HOST_ROOT,
  UPDATE_STATE_FILENAME,
  DEFAULT_NPM_REGISTRY,
  DEFAULT_GITHUB_REPO,
  CHECK_TIMEOUT_MS,
  DOWNLOAD_TIMEOUT_MS,
  MANUAL_CHECK_DEBOUNCE_MS,
  VALID_UPDATE_CHANNELS,
  VALID_AUTO_UPDATE_MODES,
  VALID_CHECK_INTERVALS,
  VALID_SOURCE_PREFERENCES,
  makeUpdateError,
  redactUrl,
  isLoopbackOrLocalUrl,
  normalizeNpmRegistryUrl,
  resolveEffectiveNpmRegistry,
  extractSemverFromTag,
  compareSemverSafe,
  isMajorBump,
  getUpdateStatePath,
  readUpdateState,
  writeUpdateState,
  detectHostInstallMode,
  fetchJsonWithRetry,
  fetchBufferWithRetry,
  selectNpmCandidateVersion,
  buildUpdateSummary,
  normalizeHostUpdateSettingsView,
  getCachedUpdateStatus,
  checkUpdates
};
