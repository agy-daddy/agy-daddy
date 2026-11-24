'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const {
  parseGitHubRepoSlug,
  parseNpmPackageFromSpec,
  resolvePluginRemoteSources,
  sumGitHubReleaseDownloads,
  MarketplaceStatsService
} = require('../src/core/marketplace-stats');
const { AgyDaddyDaemon } = require('../src/core/daemon');

function makeTempDir(prefix = 'agy-market-stats-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function postJson(port, hostToken, routePath, body = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: routePath,
      method: 'POST',
      agent: false,
      headers: {
        'Content-Type': 'application/json',
        'X-AGY-Host-Token': hostToken,
        Connection: 'close'
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, data: JSON.parse(text) });
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

test('parseGitHubRepoSlug 与 parseNpmPackageFromSpec 严格区分远程来源与本地路径', () => {
  assert.equal(parseGitHubRepoSlug('https://github.com/agy-daddy/agy-daddy.git'), 'agy-daddy/agy-daddy');
  assert.equal(parseGitHubRepoSlug('git+https://github.com/octo/plugin-x.git#v1.0.0:sub'), 'octo/plugin-x');
  assert.equal(parseGitHubRepoSlug('github:community-dev/my-plugin#main'), 'community-dev/my-plugin');
  assert.equal(parseGitHubRepoSlug('git@github.com:org/repo.git'), 'org/repo');
  assert.equal(parseGitHubRepoSlug('https://gitlab.com/org/repo.git'), null);
  assert.equal(parseGitHubRepoSlug('local:/tmp/my-plugin'), null);
  assert.equal(parseGitHubRepoSlug('/Users/dev/plugin'), null);
  assert.equal(parseGitHubRepoSlug('npm:@agy-daddy/plugin-cli'), null);

  assert.equal(parseNpmPackageFromSpec('npm:@agy-daddy/plugin-cli@^1.0.0'), '@agy-daddy/plugin-cli');
  assert.equal(parseNpmPackageFromSpec('npm:my-plugin@1.2.3'), 'my-plugin');
  assert.equal(parseNpmPackageFromSpec('npm:plain-pkg'), 'plain-pkg');
  assert.equal(parseNpmPackageFromSpec('github:owner/repo'), null);
  assert.equal(parseNpmPackageFromSpec('local:/tmp/pkg'), null);
});

test('resolvePluginRemoteSources 仅识别 GitHub/npm 来源，彻底排除仅本地安装的插件', () => {
  // 官方注册表插件
  const official = resolvePluginRemoteSources({
    id: 'agy-daddy.cli',
    shortName: 'cli',
    repo: 'https://github.com/agy-daddy/agy-daddy.git',
    subpath: 'agy-daddy-plugin-cli',
    npmPackage: '@agy-daddy/plugin-cli',
    sourceKind: 'local',
    sourceSpec: 'local:/Users/dev/agy-daddy-plugin-cli'
  });
  assert.deepEqual(official, {
    githubRepo: 'agy-daddy/agy-daddy',
    npmPackage: '@agy-daddy/plugin-cli',
    subpath: 'agy-daddy-plugin-cli',
    shortName: 'cli',
    eligible: true
  });

  // 社区 github: 插件
  const ghCommunity = resolvePluginRemoteSources({
    id: 'community.theme',
    sourceKind: 'git',
    sourceSpec: 'github:alice/agy-theme#v1.2.0'
  });
  assert.deepEqual(ghCommunity, {
    githubRepo: 'alice/agy-theme',
    npmPackage: null,
    subpath: null,
    shortName: null,
    eligible: true
  });

  // 社区 npm: 插件
  const npmCommunity = resolvePluginRemoteSources({
    id: 'community.notes',
    sourceKind: 'npm',
    sourceSpec: 'npm:agy-notes@^2.0.0'
  });
  assert.deepEqual(npmCommunity, {
    githubRepo: null,
    npmPackage: 'agy-notes',
    subpath: null,
    shortName: null,
    eligible: true
  });

  // 本地目录安装插件：不得统计
  const localOnly = resolvePluginRemoteSources({
    id: 'third.demo',
    sourceKind: 'local',
    sourceSpec: 'local:/tmp/third-demo',
    recommendedSpec: 'local:/tmp/third-demo'
  });
  assert.deepEqual(localOnly, {
    githubRepo: null,
    npmPackage: null,
    subpath: null,
    shortName: null,
    eligible: false
  });
});

test('sumGitHubReleaseDownloads 区分独立仓库全量统计与 monorepo 按子目录匹配统计', () => {
  const standaloneReleases = [
    { assets: [{ name: 'plugin-v1.tar.gz', download_count: 120 }, { name: 'checksums.txt', download_count: 30 }] },
    { assets: [{ name: 'plugin-v2.tar.gz', download_count: 250 }] }
  ];
  assert.equal(sumGitHubReleaseDownloads(standaloneReleases), 400);

  const monoReleases = [
    {
      assets: [
        { name: 'agy-daddy-plugin-cli-1.0.0.tgz', download_count: 85 },
        { name: 'agy-daddy-plugin-cli-1.0.1.tgz', download_count: 15 },
        { name: 'agy-daddy-plugin-quota-1.0.0.tgz', download_count: 500 },
        { name: 'agy-daddy-plugin-chat-nav-1.0.0.tgz', download_count: 42 }
      ]
    }
  ];
  assert.equal(
    sumGitHubReleaseDownloads(monoReleases, {
      subpath: 'agy-daddy-plugin-cli',
      pluginId: 'agy-daddy.cli',
      shortName: 'cli',
      npmPackage: '@agy-daddy/plugin-cli'
    }),
    100
  );
  assert.equal(
    sumGitHubReleaseDownloads(monoReleases, {
      subpath: 'agy-daddy-plugin-quota',
      pluginId: 'agy-daddy.quota',
      shortName: 'quota',
      npmPackage: '@agy-daddy/plugin-quota'
    }),
    500
  );
  // 未匹配任何子包资产时归零，不串算其它插件下载数
  assert.equal(
    sumGitHubReleaseDownloads(monoReleases, {
      subpath: 'agy-daddy-plugin-remote',
      pluginId: 'agy-daddy.remote',
      shortName: 'remote',
      npmPackage: '@agy-daddy/plugin-remote'
    }),
    0
  );
});

test('MarketplaceStatsService 请求去重、GitHub+npm 合并、磁盘 TTL 缓存、forceRefresh 与错误回退', async () => {
  const stateDir = makeTempDir();
  const requestedUrls = [];
  let starCount = 1234;
  let npmCliDownloads = 500;
  let failNext = false;

  const mockFetch = async (url) => {
    const u = String(url);
    requestedUrls.push(u);
    if (failNext) {
      throw new Error('network down');
    }
    if (u === 'https://api.github.com/repos/agy-daddy/agy-daddy') {
      return { ok: true, status: 200, json: async () => ({ stargazers_count: starCount }) };
    }
    if (u === 'https://api.github.com/repos/agy-daddy/agy-daddy/releases?per_page=100') {
      return {
        ok: true,
        status: 200,
        json: async () => ([
          {
            assets: [
              { name: 'agy-daddy-plugin-cli-1.0.0.tgz', download_count: 120 },
              { name: 'agy-daddy-plugin-quota-1.0.0.tgz', download_count: 80 }
            ]
          }
        ])
      };
    }
    if (u.includes('api.npmjs.org/downloads/point/last-year/%40agy-daddy%2Fplugin-cli')) {
      return { ok: true, status: 200, json: async () => ({ downloads: npmCliDownloads }) };
    }
    if (u.includes('api.npmjs.org/downloads/point/last-year/%40agy-daddy%2Fplugin-quota')) {
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const entries = [
    {
      id: 'agy-daddy.cli',
      shortName: 'cli',
      repo: 'https://github.com/agy-daddy/agy-daddy.git',
      subpath: 'agy-daddy-plugin-cli',
      npmPackage: '@agy-daddy/plugin-cli'
    },
    {
      id: 'agy-daddy.quota',
      shortName: 'quota',
      repo: 'https://github.com/agy-daddy/agy-daddy.git',
      subpath: 'agy-daddy-plugin-quota',
      npmPackage: '@agy-daddy/plugin-quota'
    },
    {
      id: 'local.only',
      sourceKind: 'local',
      sourceSpec: 'local:/tmp/local-only',
      recommendedSpec: 'local:/tmp/local-only'
    }
  ];

  try {
    const svc = new MarketplaceStatsService({ stateDir, fetch: mockFetch, ttlMs: 60_000 });
    const stats1 = await svc.fetchStatsForPlugins(entries);

    // 共享同一 GitHub 仓库的两个插件只应请求 1 次 repo + 1 次 releases
    assert.equal(requestedUrls.filter((u) => u.endsWith('/repos/agy-daddy/agy-daddy')).length, 1);
    assert.equal(requestedUrls.filter((u) => u.includes('/releases')).length, 1);
    assert.equal(requestedUrls.some((u) => u.includes('local')), false);

    assert.equal(stats1['agy-daddy.cli'].eligible, true);
    assert.equal(stats1['agy-daddy.cli'].githubStars, 1234);
    assert.equal(stats1['agy-daddy.cli'].githubDownloads, 120);
    assert.equal(stats1['agy-daddy.cli'].npmDownloads, 500);
    assert.equal(stats1['agy-daddy.cli'].downloads, 620);

    // npm 404 时仅计入 GitHub Release 下载数
    assert.equal(stats1['agy-daddy.quota'].eligible, true);
    assert.equal(stats1['agy-daddy.quota'].githubStars, 1234);
    assert.equal(stats1['agy-daddy.quota'].githubDownloads, 80);
    assert.equal(stats1['agy-daddy.quota'].npmDownloads, null);
    assert.equal(stats1['agy-daddy.quota'].downloads, 80);

    // 本地安装不统计
    assert.equal(stats1['local.only'].eligible, false);
    assert.equal(stats1['local.only'].githubStars, null);
    assert.equal(stats1['local.only'].downloads, null);

    // 验证落盘缓存命中且新实例 TTL 内不发起外部请求
    const cacheFile = path.join(stateDir, 'marketplace-stats-cache.json');
    assert.equal(fs.existsSync(cacheFile), true);
    const reqCountBeforeCacheHit = requestedUrls.length;
    const svc2 = new MarketplaceStatsService({ stateDir, fetch: mockFetch, ttlMs: 60_000 });
    const cachedSync = svc2.getCachedStatsForPlugins(entries);
    assert.equal(cachedSync['agy-daddy.cli'].downloads, 620);
    const stats2 = await svc2.fetchStatsForPlugins(entries);
    assert.equal(requestedUrls.length, reqCountBeforeCacheHit);
    assert.equal(stats2['agy-daddy.cli'].downloads, 620);

    // forceRefresh 穿透 TTL 拉取最新值
    starCount = 2048;
    npmCliDownloads = 900;
    const stats3 = await svc2.fetchStatsForPlugins(entries, { forceRefresh: true });
    assert.ok(requestedUrls.length > reqCountBeforeCacheHit);
    assert.equal(stats3['agy-daddy.cli'].githubStars, 2048);
    assert.equal(stats3['agy-daddy.cli'].downloads, 1020);

    // 网络失败时保留旧缓存不覆盖为 null
    failNext = true;
    const stats4 = await svc2.fetchStatsForPlugins(entries, { forceRefresh: true });
    assert.equal(stats4['agy-daddy.cli'].githubStars, 2048);
    assert.equal(stats4['agy-daddy.cli'].downloads, 1020);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('AgyDaddyDaemon /host/marketplace/stats 路由聚合注册表目录并返回实时统计与本地插件排除', async () => {
  const root = makeTempDir('agy-daemon-stats-');
  const stateDir = path.join(root, 'state');
  const pluginsDir = path.join(root, 'plugins');
  const wsDir = path.join(root, 'workspace');
  const localDir = path.join(wsDir, 'agy-daddy-plugin-local-custom');
  fs.mkdirSync(path.join(localDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(localDir, 'package.json'), JSON.stringify({ name: '@custom/local-only', version: '1.0.0' }));
  fs.writeFileSync(path.join(localDir, 'agy-plugin.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'third.local-custom',
    publisher: 'third',
    version: '1.0.0',
    displayName: 'Local Custom',
    engines: { agyDaddy: '^1.0.0' },
    main: './src/node.js',
    world: 'isolated',
    permissions: []
  }));
  fs.writeFileSync(path.join(localDir, 'src', 'node.js'), 'module.exports = { activate() {}, deactivate() {} };');

  const daemon = new AgyDaddyDaemon({
    stateDir,
    pluginsDir,
    workspaceRoot: wsDir,
    origin: '*',
    statsFetch: async (url) => {
      const u = String(url);
      if (u === 'https://api.github.com/repos/agy-daddy/agy-daddy') {
        return { ok: true, status: 200, json: async () => ({ stargazers_count: 888 }) };
      }
      if (u === 'https://api.github.com/repos/agy-daddy/agy-daddy/releases?per_page=100') {
        return {
          ok: true,
          status: 200,
          json: async () => ([{ assets: [{ name: 'agy-daddy-plugin-cli-1.0.0.tgz', download_count: 45 }] }])
        };
      }
      if (u.includes('api.npmjs.org/downloads/point/last-year/%40agy-daddy%2Fplugin-cli')) {
        return { ok: true, status: 200, json: async () => ({ downloads: 300 }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }
  });

  try {
    const started = await daemon.start();
    const listRes = await postJson(started.port, daemon.bridge.hostToken, '/host/plugins', {});
    assert.equal(listRes.status, 200);
    assert.ok(listRes.data.catalog.some((c) => c.id === 'agy-daddy.cli' && c.repo && c.npmPackage));
    assert.ok(listRes.data.catalog.some((c) => c.id === 'third.local-custom'));

    const statsRes = await postJson(started.port, daemon.bridge.hostToken, '/host/marketplace/stats', { forceRefresh: true });
    assert.equal(statsRes.status, 200);
    assert.equal(statsRes.data.ok, true);
    assert.equal(statsRes.data.stats['agy-daddy.cli'].githubStars, 888);
    assert.equal(statsRes.data.stats['agy-daddy.cli'].downloads, 345);
    assert.equal(statsRes.data.stats['third.local-custom'].eligible, false);
    assert.equal(statsRes.data.stats['third.local-custom'].githubStars, null);
    assert.equal(statsRes.data.stats['third.local-custom'].downloads, null);

    // 再次请求 /host/plugins 应同步携带缓存统计结果
    const listRes2 = await postJson(started.port, daemon.bridge.hostToken, '/host/plugins', {});
    assert.equal(listRes2.data.marketStats['agy-daddy.cli'].githubStars, 888);
    assert.equal(listRes2.data.marketStats['agy-daddy.cli'].downloads, 345);
  } finally {
    await daemon.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
