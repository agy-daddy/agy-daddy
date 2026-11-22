'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { safeWriteJsonSync, safeReadJsonSync, PluginDataStore } = require('../src/core/storage');
const { migrateLegacyData, detectLegacySuite } = require('../src/core/migration');

function makeTempDir(prefix = 'agy-storage-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('PluginDataStore 原子读写、版本升级与失败快照回滚', async () => {
  const root = makeTempDir();
  try {
    const store = new PluginDataStore('example.demo', { stateDir: root });
    assert.equal(store.getDataVersion(), 1);
    const wr = store.writeJson('settings.json', { count: 10, items: ['a'] });
    assert.equal(wr.ok, true);

    // 路径越界保护
    assert.throws(() => store.resolveFile('../escape.json'), /Unsafe plugin data/);

    // 模拟迁移失败，验证完整回滚到旧版本数据
    const failRes = await store.upgradeDataVersion(2, async (_from, _to, s) => {
      s.writeJson('settings.json', { count: 999, broken: true });
      throw new Error('simulated migration crash');
    });
    assert.equal(failRes.ok, false);
    assert.equal(failRes.rolledBack, true);
    assert.equal(store.getDataVersion(), 1);
    assert.deepEqual(store.readJson('settings.json').data, { count: 10, items: ['a'] });

    // 正常升级成功
    const okRes = await store.upgradeDataVersion(2, async (_from, _to, s) => {
      const cur = s.readJson('settings.json').data;
      s.writeJson('settings.json', { ...cur, migratedToV2: true });
    });
    assert.equal(okRes.ok, true);
    assert.equal(okRes.migrated, true);
    assert.equal(store.getDataVersion(), 2);
    assert.equal(store.readJson('settings.json').data.migratedToV2, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('safeReadJsonSync 损坏文件隔离与备份恢复', () => {
  const root = makeTempDir();
  try {
    const file = path.join(root, 'data.json');
    const bak = path.join(root, 'data.bak.json');
    safeWriteJsonSync(bak, { ok: true, restored: 42 });
    fs.writeFileSync(file, '{ broken json', 'utf8');

    const res = safeReadJsonSync(file, null, { backupPath: bak });
    assert.equal(res.ok, true);
    assert.equal(res.recoveredFromBackup, true);
    assert.equal(res.data.restored, 42);
    assert.ok(fs.existsSync(res.quarantinePath));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('旧 AntigravityContextMeter 只读无损迁移与幂等性', () => {
  const root = makeTempDir('agy-mig-');
  try {
    const legacyDir = path.join(root, 'legacy');
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(legacyDir, { recursive: true });

    safeWriteJsonSync(path.join(legacyDir, 'token-pricing-ledger.json'), { records: [{ id: 'c1', tokens: 100 }] });
    safeWriteJsonSync(path.join(legacyDir, 'remote-config.json'), { port: 18765, token: 'secret-tok' });
    safeWriteJsonSync(path.join(legacyDir, 'zh-translation-cache.json'), { Hello: '你好' });
    safeWriteJsonSync(path.join(legacyDir, 'modules.json'), {
      modules: {
        proxy: { enabled: true, proxyUrl: 'http://127.0.0.1:7897' },
        chinese: { enabled: true, language: 'zh-CN' }
      }
    });
    safeWriteJsonSync(path.join(legacyDir, 'settings.json'), {
      uiPreferences: {
        terminalApp: 'ghostty',
        autoAccept: false,
        autoCompact: true
      }
    });

    // dryRun 不落盘
    const dry = migrateLegacyData({ legacyStateDir: legacyDir, stateDir, dryRun: true });
    assert.equal(dry.ok, true);
    assert.ok(dry.copied.length >= 6);
    assert.equal(fs.existsSync(path.join(stateDir, 'plugins-data')), false);

    // 真实只读迁移
    const real = migrateLegacyData({ legacyStateDir: legacyDir, stateDir });
    assert.equal(real.ok, true);
    assert.equal(real.skipped, false);
    assert.deepEqual(
      safeReadJsonSync(path.join(stateDir, 'plugins-data', 'agy-daddy.usage', 'token-pricing-ledger.json')).data,
      { records: [{ id: 'c1', tokens: 100 }] }
    );
    assert.equal(
      safeReadJsonSync(path.join(stateDir, 'plugins-data', 'agy-daddy.proxy', 'config.json')).data.proxyUrl,
      'http://127.0.0.1:7897'
    );
    assert.equal(
      safeReadJsonSync(path.join(stateDir, 'plugins-data', 'agy-daddy.cli', 'settings.json')).data.terminalApp,
      'ghostty'
    );
    // 确认原旧目录文件未被修改或删除
    assert.equal(fs.existsSync(path.join(legacyDir, 'token-pricing-ledger.json')), true);

    // 二次运行幂等跳过
    const second = migrateLegacyData({ legacyStateDir: legacyDir, stateDir });
    assert.equal(second.alreadyMigrated, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('旧套件共存只读探测（LaunchAgent、CLI 软链、live-host 进程）', () => {
  const root = makeTempDir('agy-legacy-detect-');
  try {
    const plist = path.join(root, 'com.demo.ag-live-helper.plist');
    const cliTarget = path.join(root, 'target-cli');
    const cliLink = path.join(root, 'ag-context-meter');
    fs.writeFileSync(plist, '<plist/>');
    fs.writeFileSync(cliTarget, '#!/bin/sh\n');
    fs.symlinkSync(cliTarget, cliLink);

    const det = detectLegacySuite({
      launchAgentPath: plist,
      cliSymlinkPath: cliLink,
      legacyStateDir: path.join(root, 'missing'),
      psOutput: '  30439 node /Volumes/external/Projects/antigravity-suite/live-host.js\n'
    });
    assert.equal(det.detected, true);
    assert.equal(det.launchAgent.exists, true);
    assert.equal(det.cliSymlink.exists, true);
    assert.deepEqual(det.runningLiveHostPids, [30439]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
