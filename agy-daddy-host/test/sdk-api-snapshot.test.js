'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOST_ROOT = path.resolve(__dirname, '..');
const sdk = require('../sdk');

test('Plugin API v1 SDK 导出快照与 index.d.ts 契约锁定', () => {
  const expectedKeys = [
    'HOST_API_VERSION',
    'TRUST_LEVELS',
    'REALMS',
    'EVENT_KINDS',
    'STATIC_PERMISSIONS',
    'HIGH_RISK_PERMISSIONS',
    'KNOWN_ANCHORS',
    'parseSemver',
    'compareSemver',
    'satisfies',
    'validateManifest',
    'validateSettingsSchema',
    'validateSettingsValues',
    'evaluateTrustPolicy',
    'createMockHostHarness',
    'createMockDocument',
    'createMockElement',
    'createPluginScaffold'
  ];
  for (const key of expectedKeys) {
    assert.ok(sdk[key] !== undefined, `Missing SDK export: ${key}`);
  }
  assert.equal(sdk.HOST_API_VERSION, '1.0.0');

  const dts = fs.readFileSync(path.join(HOST_ROOT, 'sdk', 'index.d.ts'), 'utf8');
  for (const sym of ['interface AgyPluginManifest', 'interface AgyHostApi', 'interface AgyRendererContext', 'function createPluginScaffold']) {
    assert.ok(dts.includes(sym), `index.d.ts missing declaration: ${sym}`);
  }
});

test('createPluginScaffold 脚手架生成可立即通过 npm test 的独立插件', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-scaffold-'));
  try {
    const outDir = path.join(tmp, 'third-hello');
    const created = sdk.createPluginScaffold(outDir, { id: 'third.sample', world: 'isolated' });
    assert.equal(created.ok, true);

    const r = spawnSync('npm', ['test'], {
      cwd: outDir,
      encoding: 'utf8',
      env: { ...process.env, AGY_DADDY_HOST_DIR: HOST_ROOT, AGY_DADDY_TEST_MODE: '1' }
    });
    assert.equal(r.status, 0, `Scaffolded plugin test failed:\n${r.stdout}\n${r.stderr}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
