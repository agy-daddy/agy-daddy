'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseSemver,
  compareSemver,
  satisfies
} = require('../src/contracts/semver');
const {
  validateManifest,
  validateSettingsSchema,
  validateSettingsValues,
  evaluateTrustPolicy
} = require('../src/contracts/manifest-validator');

function makeBaseManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'community.demo',
    publisher: 'community',
    version: '1.2.0',
    displayName: { 'zh-CN': '示例插件', en: 'Demo' },
    engines: { agyDaddy: '^1.0.0', antigravity: '>=2.32.0' },
    main: './src/node.js',
    renderer: './src/renderer.js',
    world: 'isolated',
    permissions: ['dom:write', 'bridge:route'],
    ...overrides
  };
}

test('semver 解析、比较与区间匹配', () => {
  assert.equal(compareSemver('1.2.0', '1.2.1'), -1);
  assert.equal(compareSemver('2.0.0', '2.0.0-alpha.1'), 1);
  assert.equal(satisfies('1.5.2', '^1.0.0'), true);
  assert.equal(satisfies('2.0.0', '^1.0.0'), false);
  assert.equal(satisfies('0.2.5', '^0.2.0'), true);
  assert.equal(satisfies('0.3.0', '^0.2.0'), false);
  assert.equal(satisfies('2.33.0', '>=2.32.0 <3.0.0'), true);
  assert.equal(satisfies('1.0.0', '2.x || 1.x'), true);
  assert.equal(parseSemver('not-a-ver'), null);
});

test('manifest 校验：合法、非法 ID、主世界缺权限、未知贡献点', () => {
  assert.equal(validateManifest(makeBaseManifest()).ok, true);

  const badId = validateManifest(makeBaseManifest({ id: 'invalid_no_dot' }));
  assert.equal(badId.ok, false);

  const mismatchPub = validateManifest(makeBaseManifest({ publisher: 'other' }));
  assert.equal(mismatchPub.ok, false);

  const mainNoPerm = validateManifest(makeBaseManifest({ world: 'main', permissions: ['dom:write'] }));
  assert.equal(mainNoPerm.ok, false);
  assert.match(mainNoPerm.errors.join(' '), /page:main-world/);

  const badContrib = validateManifest(makeBaseManifest({ contributes: { 'unknown.slot': [] } }));
  assert.equal(badContrib.ok, false);

  const serviceWithRealm = validateManifest(makeBaseManifest({
    provides: {
      services: { demo: { version: '1.0.0', realm: 'page-isolated' } },
      events: ['demo:ping@1'],
      surfaces: ['demo.panel']
    }
  }));
  assert.equal(serviceWithRealm.ok, true);
});

test('声明式设置 schema 与值校验', () => {
  const schema = {
    version: 1,
    fields: [
      { key: 'enabled', type: 'boolean', default: true },
      { key: 'port', type: 'number', min: 1024, max: 65535, default: 18766 },
      { key: 'mode', type: 'enum', options: ['auto', 'direct'], default: 'auto' }
    ]
  };
  assert.equal(validateSettingsSchema(schema).ok, true);

  const okRes = validateSettingsValues(schema, { port: 20000 });
  assert.equal(okRes.ok, true);
  assert.deepEqual(okRes.values, { enabled: true, port: 20000, mode: 'auto' });

  const badRes = validateSettingsValues(schema, { port: 80, mode: 'invalid' });
  assert.equal(badRes.ok, false);
  assert.equal(badRes.errors.length, 2);
});

test('信任分级策略 T0 / T1 / T2 与权限隔离判定', () => {
  const manifest = makeBaseManifest({
    publisher: 'agy-daddy',
    id: 'agy-daddy.power',
    world: 'main',
    permissions: ['dom:write', 'page:main-world', 'rpc:write', 'process:spawn', 'net:outbound:api.example.com']
  });

  const t0 = evaluateTrustPolicy(manifest, 'T0');
  assert.equal(t0.allowed, true);
  assert.equal(t0.nodeIsolation, 'in-process');
  assert.equal(t0.world, 'main');
  assert.equal(t0.autoUpdateAllowed, true);

  // T1 默认禁止高危受限权限
  const t1Denied = evaluateTrustPolicy(manifest, 'T1', []);
  assert.equal(t1Denied.allowed, false);
  assert.equal(t1Denied.nodeIsolation, 'worker');
  assert.ok(t1Denied.denied.includes('page:main-world'));
  assert.ok(t1Denied.denied.includes('rpc:write'));
  assert.equal(t1Denied.world, 'isolated');

  // T1 审查批准后允许
  const t1Approved = evaluateTrustPolicy(manifest, 'T1', ['page:main-world', 'rpc:write', 'process:spawn']);
  assert.equal(t1Approved.allowed, true);
  assert.equal(t1Approved.world, 'main');

  // T2 禁止静默更新并标注未审核
  const t2 = evaluateTrustPolicy(manifest, 'T2', []);
  assert.equal(t2.allowed, false);
  assert.equal(t2.badge, '未审核');
  assert.equal(t2.autoUpdateAllowed, false);
  assert.ok(t2.denied.includes('net:outbound:api.example.com'));
});
