'use strict';

const path = require('path');
const { safeReadJsonSync, safeWriteJsonSync, withFileLockSync } = require('./storage');

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 6000;
const CACHE_FILENAME = 'marketplace-stats-cache.json';

function isValidSlugPart(str) {
  return typeof str === 'string' && /^[a-zA-Z0-9._-]+$/.test(str) && str !== '.' && str !== '..';
}

function parseGitHubRepoSlug(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  if (s.startsWith('local:') || s.startsWith('npm:') || s.startsWith('/') || s.startsWith('./') || s.startsWith('../')) {
    return null;
  }

  let candidatePath = '';
  if (s.startsWith('github:')) {
    candidatePath = s.slice('github:'.length).trim();
  } else if (s.startsWith('git@github.com:')) {
    candidatePath = s.slice('git@github.com:'.length).trim();
  } else {
    if (s.startsWith('git+')) s = s.slice('git+'.length).trim();
    else if (s.startsWith('git:')) s = s.slice('git:'.length).trim();
    if (!/^https?:\/\//i.test(s)) return null;
    try {
      const u = new URL(s);
      if (u.hostname.toLowerCase() !== 'github.com') return null;
      candidatePath = u.pathname.replace(/^\/+/, '');
    } catch {
      return null;
    }
  }

  const hashIdx = candidatePath.indexOf('#');
  if (hashIdx >= 0) candidatePath = candidatePath.slice(0, hashIdx);
  const queryIdx = candidatePath.indexOf('?');
  if (queryIdx >= 0) candidatePath = candidatePath.slice(0, queryIdx);
  candidatePath = candidatePath.replace(/\/+$/, '').replace(/\.git$/i, '');

  const parts = candidatePath.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1];
  if (!isValidSlugPart(owner) || !isValidSlugPart(repo)) return null;
  return `${owner}/${repo}`;
}

function parseNpmPackageFromSpec(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s.startsWith('npm:')) return null;
  const body = s.slice('npm:'.length).trim();
  if (!body) return null;
  const atIdx = body.startsWith('@') ? body.indexOf('@', 1) : body.indexOf('@');
  const pkg = (atIdx > 0 ? body.slice(0, atIdx) : body).trim();
  return pkg || null;
}

function parseSubpathFromSpec(raw) {
  if (typeof raw !== 'string') return null;
  const hashIdx = raw.indexOf('#');
  if (hashIdx < 0) return null;
  const frag = raw.slice(hashIdx + 1);
  const colonIdx = frag.indexOf(':');
  if (colonIdx < 0) return null;
  const sub = frag.slice(colonIdx + 1).trim().replace(/^\.\//, '').replace(/\/+$/, '');
  return sub || null;
}

function resolvePluginRemoteSources(entry = {}) {
  if (!entry || typeof entry !== 'object') {
    return { githubRepo: null, npmPackage: null, subpath: null, shortName: null, eligible: false };
  }
  const sourceKind = typeof entry.sourceKind === 'string' ? entry.sourceKind.trim().toLowerCase() : '';
  const sourceSpec = typeof entry.sourceSpec === 'string' ? entry.sourceSpec.trim() : '';
  const recommendedSpec = typeof entry.recommendedSpec === 'string' ? entry.recommendedSpec.trim() : '';
  const repoRaw = typeof entry.repo === 'string' ? entry.repo.trim() : '';

  const githubRepo =
    parseGitHubRepoSlug(repoRaw) ||
    parseGitHubRepoSlug(sourceSpec) ||
    parseGitHubRepoSlug(recommendedSpec) ||
    null;

  const rawNpm = typeof entry.npmPackage === 'string' && entry.npmPackage.trim()
    ? entry.npmPackage.trim()
    : null;
  const npmPackage =
    rawNpm ||
    parseNpmPackageFromSpec(sourceSpec) ||
    parseNpmPackageFromSpec(recommendedSpec) ||
    null;

  const subpath =
    (typeof entry.subpath === 'string' && entry.subpath.trim()
      ? entry.subpath.trim().replace(/^\.\//, '').replace(/\/+$/, '')
      : null) ||
    parseSubpathFromSpec(sourceSpec) ||
    parseSubpathFromSpec(recommendedSpec) ||
    null;

  const shortName = typeof entry.shortName === 'string' && entry.shortName.trim()
    ? entry.shortName.trim()
    : null;

  const eligible = Boolean(githubRepo || npmPackage) && !(sourceKind === 'local' && !githubRepo && !npmPackage);

  return {
    githubRepo,
    npmPackage,
    subpath,
    shortName,
    eligible
  };
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sumGitHubReleaseDownloads(releases, opts = {}) {
  if (!Array.isArray(releases)) return null;

  const assets = [];
  for (const rel of releases) {
    if (rel && Array.isArray(rel.assets)) {
      for (const a of rel.assets) {
        if (a && typeof a === 'object') assets.push(a);
      }
    }
  }

  const subpath = typeof opts.subpath === 'string' ? opts.subpath.trim() : '';
  if (!subpath) {
    let total = 0;
    for (const a of assets) {
      const cnt = Number(a.download_count);
      if (Number.isFinite(cnt) && cnt > 0) total += Math.floor(cnt);
    }
    return total;
  }

  const tokens = new Set();
  const baseName = path.posix.basename(subpath.replace(/\\/g, '/')).trim().toLowerCase();
  if (baseName) tokens.add(baseName);
  if (typeof opts.shortName === 'string' && opts.shortName.trim()) {
    tokens.add(opts.shortName.trim().toLowerCase());
  }
  if (typeof opts.pluginId === 'string' && opts.pluginId.trim()) {
    const pid = opts.pluginId.trim().toLowerCase();
    tokens.add(pid);
    const dotIdx = pid.indexOf('.');
    if (dotIdx > 0 && dotIdx + 1 < pid.length) {
      tokens.add(pid.slice(dotIdx + 1));
    }
  }
  if (typeof opts.npmPackage === 'string' && opts.npmPackage.trim()) {
    const pkg = opts.npmPackage.trim().toLowerCase();
    const slashIdx = pkg.lastIndexOf('/');
    const unscoped = slashIdx >= 0 ? pkg.slice(slashIdx + 1) : pkg;
    if (unscoped) tokens.add(unscoped);
  }

  const matchers = Array.from(tokens)
    .filter(Boolean)
    .map((tok) => new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(tok)}(?:$|[-_.])`, 'i'));

  if (matchers.length === 0) return 0;

  let total = 0;
  for (const a of assets) {
    const name = typeof a.name === 'string' ? a.name.toLowerCase() : '';
    if (!name) continue;
    if (matchers.some((re) => re.test(name))) {
      const cnt = Number(a.download_count);
      if (Number.isFinite(cnt) && cnt > 0) total += Math.floor(cnt);
    }
  }
  return total;
}

function emptyCacheDoc() {
  return { schemaVersion: 1, repos: {}, npm: {} };
}

function compactReleasesForCache(releases) {
  if (!Array.isArray(releases)) return null;
  return releases.map((rel) => ({
    assets: Array.isArray(rel?.assets)
      ? rel.assets.map((a) => ({
          name: typeof a?.name === 'string' ? a.name : '',
          download_count: Number.isFinite(Number(a?.download_count)) ? Math.floor(Number(a.download_count)) : 0
        }))
      : []
  }));
}

class MarketplaceStatsService {
  constructor(options = {}) {
    this.options = options;
    this.stateDir = options.stateDir || null;
    this.cachePath = this.stateDir ? path.join(this.stateDir, CACHE_FILENAME) : null;
    this.customFetch = typeof options.fetch === 'function' ? options.fetch : null;
    this.fetchFn = this.customFetch || globalThis.fetch;
    this.ttlMs = Number.isFinite(Number(options.ttlMs)) && Number(options.ttlMs) > 0
      ? Number(options.ttlMs)
      : DEFAULT_TTL_MS;
    this.timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : DEFAULT_TIMEOUT_MS;
    this.githubToken = options.githubToken || null;
    this.allowNetworkInTest = Boolean(options.allowNetworkInTest);
    this._cache = null;
    this._inflight = null;
  }

  _loadCache() {
    if (this._cache) return this._cache;
    if (!this.cachePath) {
      this._cache = emptyCacheDoc();
      return this._cache;
    }
    const res = safeReadJsonSync(this.cachePath, emptyCacheDoc(), { quarantineCorrupt: false });
    const data = res?.data && typeof res.data === 'object' ? res.data : emptyCacheDoc();
    this._cache = {
      schemaVersion: 1,
      repos: data.repos && typeof data.repos === 'object' && !Array.isArray(data.repos) ? data.repos : {},
      npm: data.npm && typeof data.npm === 'object' && !Array.isArray(data.npm) ? data.npm : {}
    };
    return this._cache;
  }

  _saveCache() {
    if (!this.cachePath || !this._cache) return;
    withFileLockSync(this.cachePath, () => {
      safeWriteJsonSync(this.cachePath, this._cache);
    });
  }

  _isFresh(entry, now) {
    return Boolean(entry && Number.isFinite(Number(entry.fetchedAt)) && (now - Number(entry.fetchedAt)) < this.ttlMs);
  }

  _buildPluginStat(entry, cache) {
    const pluginId = entry?.id ? String(entry.id) : '';
    const src = resolvePluginRemoteSources(entry);
    if (!src.eligible) {
      return {
        eligible: false,
        githubRepo: null,
        npmPackage: null,
        githubStars: null,
        downloads: null,
        githubDownloads: null,
        npmDownloads: null,
        fetchedAt: null
      };
    }

    const repoRec = src.githubRepo ? cache.repos[src.githubRepo] : null;
    const npmRec = src.npmPackage ? cache.npm[src.npmPackage] : null;

    const githubStars = repoRec && repoRec.stars !== null && repoRec.stars !== undefined && Number.isFinite(Number(repoRec.stars))
      ? Math.max(0, Math.floor(Number(repoRec.stars)))
      : null;

    const githubDownloads = repoRec && Array.isArray(repoRec.releases)
      ? sumGitHubReleaseDownloads(repoRec.releases, {
          subpath: src.subpath,
          pluginId,
          shortName: src.shortName,
          npmPackage: src.npmPackage
        })
      : null;

    const npmDownloads = npmRec && npmRec.downloads !== null && npmRec.downloads !== undefined && Number.isFinite(Number(npmRec.downloads))
      ? Math.max(0, Math.floor(Number(npmRec.downloads)))
      : null;

    const downloads = (githubDownloads !== null || npmDownloads !== null)
      ? (githubDownloads ?? 0) + (npmDownloads ?? 0)
      : null;

    const fetchedAtCandidates = [repoRec?.fetchedAt, npmRec?.fetchedAt].filter((t) => Number.isFinite(Number(t)));
    const fetchedAt = fetchedAtCandidates.length > 0 ? Math.max(...fetchedAtCandidates.map(Number)) : null;

    return {
      eligible: true,
      githubRepo: src.githubRepo,
      npmPackage: src.npmPackage,
      githubStars,
      downloads,
      githubDownloads,
      npmDownloads,
      fetchedAt
    };
  }

  getCachedStatsForPlugins(entries = []) {
    const cache = this._loadCache();
    const out = {};
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || !entry.id) continue;
      out[entry.id] = this._buildPluginStat(entry, cache);
    }
    return out;
  }

  async _fetchJson(url, headers = {}) {
    if (typeof this.fetchFn !== 'function') {
      throw new Error('fetch is unavailable');
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => { try { controller.abort(); } catch {} }, this.timeoutMs) : null;
    try {
      const resp = await this.fetchFn(url, {
        headers,
        ...(controller ? { signal: controller.signal } : {})
      });
      const status = Number(resp?.status || 0);
      if (!resp?.ok) {
        const err = new Error(`HTTP ${status} for ${url}`);
        err.status = status;
        throw err;
      }
      return await resp.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async _fetchGitHubRepo(slug, prevRec = null) {
    const token = this.githubToken || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'agy-daddy-host'
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    let stars = prevRec && Number.isFinite(Number(prevRec.stars)) ? Number(prevRec.stars) : null;
    let releases = prevRec && Array.isArray(prevRec.releases) ? prevRec.releases : null;
    let okAny = false;

    try {
      const repoJson = await this._fetchJson(`https://api.github.com/repos/${slug}`, headers);
      if (repoJson && Number.isFinite(Number(repoJson.stargazers_count))) {
        stars = Math.max(0, Math.floor(Number(repoJson.stargazers_count)));
      }
      okAny = true;
    } catch {}

    try {
      const relJson = await this._fetchJson(`https://api.github.com/repos/${slug}/releases?per_page=100`, headers);
      if (Array.isArray(relJson)) {
        releases = compactReleasesForCache(relJson);
      }
      okAny = true;
    } catch {}

    if (!okAny) {
      return prevRec;
    }
    return {
      stars,
      releases,
      fetchedAt: Date.now()
    };
  }

  async _fetchNpmPackage(pkg, prevRec = null) {
    const headers = {
      Accept: 'application/json',
      'User-Agent': 'agy-daddy-host'
    };
    const url = `https://api.npmjs.org/downloads/point/last-year/${encodeURIComponent(pkg)}`;
    try {
      const data = await this._fetchJson(url, headers);
      const downloads = data && Number.isFinite(Number(data.downloads))
        ? Math.max(0, Math.floor(Number(data.downloads)))
        : null;
      return {
        downloads,
        fetchedAt: Date.now()
      };
    } catch (err) {
      if (err?.status === 404) {
        return {
          downloads: null,
          fetchedAt: Date.now()
        };
      }
      return prevRec;
    }
  }

  async fetchStatsForPlugins(entries = [], opts = {}) {
    const list = Array.isArray(entries) ? entries.filter((e) => e && e.id) : [];
    const forceRefresh = Boolean(opts?.forceRefresh);

    const isTestEnv = process.env.AGY_DADDY_TEST_MODE === '1' || process.env.NODE_ENV === 'test';
    if (isTestEnv && !this.customFetch && !this.allowNetworkInTest) {
      return this.getCachedStatsForPlugins(list);
    }

    if (!forceRefresh && this._inflight) {
      await this._inflight;
      return this.getCachedStatsForPlugins(list);
    }

    const run = async () => {
      const cache = this._loadCache();
      const now = Date.now();
      const repoSlugs = new Set();
      const npmPackages = new Set();

      for (const entry of list) {
        const src = resolvePluginRemoteSources(entry);
        if (!src.eligible) continue;
        if (src.githubRepo && (forceRefresh || !this._isFresh(cache.repos[src.githubRepo], now))) {
          repoSlugs.add(src.githubRepo);
        }
        if (src.npmPackage && (forceRefresh || !this._isFresh(cache.npm[src.npmPackage], now))) {
          npmPackages.add(src.npmPackage);
        }
      }

      if (repoSlugs.size === 0 && npmPackages.size === 0) {
        return;
      }

      const tasks = [];
      let changed = false;

      for (const slug of repoSlugs) {
        tasks.push((async () => {
          const nextRec = await this._fetchGitHubRepo(slug, cache.repos[slug] || null);
          if (nextRec) {
            cache.repos[slug] = nextRec;
            changed = true;
          }
        })());
      }

      for (const pkg of npmPackages) {
        tasks.push((async () => {
          const nextRec = await this._fetchNpmPackage(pkg, cache.npm[pkg] || null);
          if (nextRec) {
            cache.npm[pkg] = nextRec;
            changed = true;
          }
        })());
      }

      await Promise.all(tasks);
      if (changed) {
        this._saveCache();
      }
    };

    const p = run();
    if (!forceRefresh) {
      this._inflight = p;
    }
    try {
      await p;
    } finally {
      if (this._inflight === p) {
        this._inflight = null;
      }
    }
    return this.getCachedStatsForPlugins(list);
  }
}

module.exports = {
  DEFAULT_TTL_MS,
  parseGitHubRepoSlug,
  parseNpmPackageFromSpec,
  resolvePluginRemoteSources,
  sumGitHubReleaseDownloads,
  MarketplaceStatsService
};
