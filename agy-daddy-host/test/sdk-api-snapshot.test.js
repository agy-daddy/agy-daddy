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
  assert.equal(sdk.KNOWN_ANCHORS.length, 15);
  for (const a of ['settings.dialog', 'settings.nav', 'settings.content', 'settings.openTrigger']) {
    assert.ok(sdk.KNOWN_ANCHORS.includes(a), `Missing KNOWN_ANCHORS entry: ${a}`);
  }

  const dts = fs.readFileSync(path.join(HOST_ROOT, 'sdk', 'index.d.ts'), 'utf8');
  for (const sym of [
    'interface AgyPluginManifest',
    'interface AgyHostApi',
    'interface AgyRendererContext',
    'interface SettingsAction',
    'function createPluginScaffold',
    'settings.dialog',
    'hostDom:',
    'surfaces:',
    'styles:',
    'commands:'
  ]) {
    assert.ok(dts.includes(sym), `index.d.ts missing declaration: ${sym}`);
  }
  assert.equal(dts.includes('registerSection'), false, 'index.d.ts must not expose removed registerSection');
  assert.equal(dts.includes('migrations?:'), false, 'index.d.ts must not expose removed migrations');
});

test('createPluginScaffold 脚手架默认 isolated 且使用 ctx.settings / ctx.styles.inject', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-scaffold-'));
  try {
    const outDir = path.join(tmp, 'third-hello');
    const created = sdk.createPluginScaffold(outDir, { id: 'third.sample' });
    assert.equal(created.ok, true);

    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'agy-plugin.json'), 'utf8'));
    assert.equal(manifest.world, 'isolated');
    assert.equal((manifest.permissions || []).includes('page:main-world'), false);
    assert.equal(sdk.validateManifest(manifest).ok, true);

    const schema = JSON.parse(fs.readFileSync(path.join(outDir, 'settings.schema.json'), 'utf8'));
    assert.equal(sdk.validateSettingsSchema(schema).ok, true);
    assert.ok(Array.isArray(schema.actions) && schema.actions.length >= 1);

    const rendererSrc = fs.readFileSync(path.join(outDir, 'src', 'renderer.js'), 'utf8');
    assert.match(rendererSrc, /ctx\.styles\.inject/);
    assert.match(rendererSrc, /ctx\.settings\.get/);
    assert.match(rendererSrc, /ctx\.commands\.execute/);

    const nodeSrc = fs.readFileSync(path.join(outDir, 'src', 'node.js'), 'utf8');
    assert.match(nodeSrc, /host\.settings\.get/);
    assert.match(nodeSrc, /host\.commands\.register/);

    const r = spawnSync('npm', ['test'], {
      cwd: outDir,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      env: { ...process.env, AGY_DADDY_HOST_DIR: HOST_ROOT, AGY_DADDY_TEST_MODE: '1' }
    });
    assert.equal(r.status, 0, `Scaffolded plugin test failed:\n${r.stdout}\n${r.stderr}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
