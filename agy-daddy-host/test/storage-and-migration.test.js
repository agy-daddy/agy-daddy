'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { safeWriteJsonSync, safeReadJsonSync, PluginDataStore } = require('../src/core/storage');
const paths = require('../src/core/paths');
const hostIndex = require('../src/index');
const { DEFAULT_HOST_SETTINGS, normalizeHostSettings } = require('../src/core/daemon');

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

test('彻底移除历史迁移包袱且 host-settings.json 归一化与持久化正常', () => {
  const hostRoot = path.resolve(__dirname, '..');
  assert.equal(fs.existsSync(path.join(hostRoot, 'src', 'core', 'migration.js')), false);
  assert.equal(fs.existsSync(path.join(hostRoot, 'plugins', 'legacy-suite')), false);
  assert.equal(paths.getLegacyStateDir, undefined);
  assert.equal(hostIndex.migration, undefined);

  const root = makeTempDir('agy-host-settings-');
  try {
    const settingsPath = paths.getHostSettingsPath({ stateDir: root });
    assert.equal(settingsPath, path.join(root, 'host-settings.json'));

    const merged = normalizeHostSettings(
      {
        themeMode: 'dark',
        heatPreset: 'violet',
        customColors: { accent: '#a78bfa' },
        topbarPins: { 'agy-daddy.proxy:proxy': false },
        topbarOrder: ['agy-daddy.context:ctx', 'agy-daddy.quota:quota'],
        maxVisibleUnits: 4
      },
      DEFAULT_HOST_SETTINGS
    );
    assert.deepEqual(merged, {
      themeMode: 'dark',
      heatPreset: 'violet',
      customColors: { accent: '#a78bfa' },
      topbarPins: { 'agy-daddy.proxy:proxy': false },
      topbarOrder: ['agy-daddy.context:ctx', 'agy-daddy.quota:quota'],
      maxVisibleUnits: 4,
      showTopbarEntry: true,
      injectNativeSettings: true,
      autoSyncNativeOnInstall: true,
      hideTrayIcon: false,
      updateChannel: 'stable',
      autoUpdateMode: 'notify',
      updateCheckInterval: '6h',
      updateSourcePreference: 'auto',
      npmRegistryUrl: ''
    });

    const toggledOff = normalizeHostSettings(
      {
        showTopbarEntry: false,
        injectNativeSettings: false,
        autoSyncNativeOnInstall: false,
        hideTrayIcon: true
      },
      merged
    );
    assert.equal(toggledOff.showTopbarEntry, false);
    assert.equal(toggledOff.injectNativeSettings, false);
    assert.equal(toggledOff.autoSyncNativeOnInstall, false);
    assert.equal(toggledOff.hideTrayIcon, true);

    const wr = safeWriteJsonSync(settingsPath, merged);
    assert.equal(wr.ok, true);
    const rd = safeReadJsonSync(settingsPath);
    assert.equal(rd.ok, true);
    assert.deepEqual(rd.data, merged);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
