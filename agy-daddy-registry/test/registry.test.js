'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyAnchorsMatrix, verifyRegistryAndMatrix } = require('../scripts/verify-registry');

const MONOREPO_ROOT = path.resolve(__dirname, '..', '..');

test('registry: Antigravity 2.32/2.33 x 15 锚点兼容矩阵与 anchors.json 字节一致性', () => {
  const res = verifyAnchorsMatrix();
  assert.equal(res.ok, true);
  assert.equal(res.anchorsCount, 15);
  assert.equal(res.matrix.length, 2);
  for (const row of res.matrix) {
    assert.equal(row.anchorsMatched, 15);
  }
});

test('registry: 14 插件完整性 SHA-512（含 agy-daddy.theme、hubo1989.design、agy-daddy.pet 与 agy-daddy.sidebar）与 Antigravity 2.32/2.33 x 15 锚点兼容矩阵', () => {
  const res = verifyRegistryAndMatrix();
  assert.equal(res.ok, true);
  assert.equal(res.pluginsVerified, 14);
  const themeEntry = res.plugins.find((p) => p.id === 'agy-daddy.theme');
  assert.ok(themeEntry, 'agy-daddy.theme must be present in registry');
  const designEntry = res.plugins.find((p) => p.id === 'hubo1989.design');
  assert.ok(designEntry, 'hubo1989.design must be present in registry');
  assert.equal(designEntry.external, true);
  assert.equal(designEntry.trustLevel, 'T1');
  const petEntry = res.plugins.find((p) => p.id === 'agy-daddy.pet');
  assert.ok(petEntry, 'agy-daddy.pet must be present in registry');
  const sidebarEntry = res.plugins.find((p) => p.id === 'agy-daddy.sidebar');
  assert.ok(sidebarEntry, 'agy-daddy.sidebar must be present in registry');
  assert.equal(res.anchorsCount, 15);
  assert.equal(res.matrix.length, 2);
  for (const row of res.matrix) {
    assert.equal(row.anchorsMatched, 15);
  }
});

test('registry: external: true 支持无本地同级目录时的元数据/SHA-512 格式校验，并在本地存在时自动升级物理文件比对', () => {
  const baseReg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'registry.json'), 'utf8'));
  const internalOnly = baseReg.plugins.filter((p) => p.external !== true);
  const validSha = 'sha512-' + crypto.createHash('sha512').update('sample-manifest').digest('base64');

  // 1. 本地无同级外部仓目录：走元数据与 SHA-512 格式校验分支
  const resMetadata = verifyRegistryAndMatrix({
    workspaceRoot: MONOREPO_ROOT,
    checkParentSibling: false,
    registry: {
      ...baseReg,
      plugins: [
        ...internalOnly,
        {
          id: 'community.demo-external',
          shortName: 'demo-external',
          layer: 4,
          trustLevel: 'T1',
          external: true,
          version: '0.1.0',
          repo: 'https://github.com/example/nonexistent-external-plugin.git',
          ref: 'v0.1.0',
          manifestSha512: validSha
        }
      ]
    }
  });
  assert.equal(resMetadata.ok, true);
  const metaResult = resMetadata.plugins.find((p) => p.id === 'community.demo-external');
  assert.equal(metaResult.mode, 'metadata');
  assert.equal(metaResult.formatVerified, true);
  assert.equal(metaResult.shaVerified, false);

  // 2. 格式校验拦截：非法 SHA-512 / 非 HTTPS / 缺失 ref 均报错
  assert.throws(() => verifyRegistryAndMatrix({
    workspaceRoot: MONOREPO_ROOT,
    checkParentSibling: false,
    registry: {
      ...baseReg,
      plugins: [
        ...internalOnly,
        {
          id: 'community.bad-sha',
          trustLevel: 'T1',
          external: true,
          repo: 'https://github.com/example/bad-sha.git',
          ref: 'v0.1.0',
          manifestSha512: 'sha512-invalid'
        }
      ]
    }
  }), /invalid manifestSha512 format/i);

  assert.throws(() => verifyRegistryAndMatrix({
    workspaceRoot: MONOREPO_ROOT,
    checkParentSibling: false,
    registry: {
      ...baseReg,
      plugins: [
        ...internalOnly,
        {
          id: 'community.bad-repo',
          trustLevel: 'T1',
          external: true,
          repo: 'http://example.com/insecure.git',
          ref: 'v0.1.0',
          manifestSha512: validSha
        }
      ]
    }
  }), /https:\/\//i);

  // 3. 本地存在同级外部仓目录时：自动升级为物理 agy-plugin.json SHA-512 与清单校验
  const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-reg-ext-'));
  try {
    const tmpWorkspace = path.join(tmpParent, 'agy-daddy');
    const tmpExtDir = path.join(tmpParent, 'ext-sample-plugin');
    fs.mkdirSync(tmpWorkspace, { recursive: true });
    fs.mkdirSync(tmpExtDir, { recursive: true });
    for (const entry of internalOnly) {
      fs.symlinkSync(path.join(MONOREPO_ROOT, entry.localRepo), path.join(tmpWorkspace, entry.localRepo), 'dir');
    }

    const extManifestRaw = JSON.stringify({
      schemaVersion: 1,
      id: 'community.ext-sample',
      publisher: 'community',
      version: '0.1.0',
      displayName: 'External Sample',
      engines: { agyDaddy: '^1.0.0' },
      main: './index.js',
      world: 'isolated',
      permissions: ['dom:read']
    }, null, 2);
    fs.writeFileSync(path.join(tmpExtDir, 'agy-plugin.json'), extManifestRaw, 'utf8');
    const extSha = 'sha512-' + crypto.createHash('sha512').update(Buffer.from(extManifestRaw, 'utf8')).digest('base64');

    const resPhysical = verifyRegistryAndMatrix({
      workspaceRoot: tmpWorkspace,
      registry: {
        ...baseReg,
        plugins: [
          ...internalOnly,
          {
            id: 'community.ext-sample',
            shortName: 'ext-sample',
            layer: 4,
            trustLevel: 'T1',
            external: true,
            version: '0.1.0',
            repo: 'https://github.com/example/ext-sample-plugin.git',
            ref: 'v0.1.0',
            manifestSha512: extSha
          }
        ]
      }
    });
    assert.equal(resPhysical.ok, true);
    const physResult = resPhysical.plugins.find((p) => p.id === 'community.ext-sample');
    assert.equal(physResult.mode, 'physical');
    assert.equal(physResult.shaVerified, true);

    // 若物理清单哈希不一致则必须拒绝
    assert.throws(() => verifyRegistryAndMatrix({
      workspaceRoot: tmpWorkspace,
      registry: {
        ...baseReg,
        plugins: [
          ...internalOnly,
          {
            id: 'community.ext-sample',
            trustLevel: 'T1',
            external: true,
            version: '0.1.0',
            repo: 'https://github.com/example/ext-sample-plugin.git',
            ref: 'v0.1.0',
            manifestSha512: validSha
          }
        ]
      }
    }), /SHA-512 mismatch/i);
  } finally {
    fs.rmSync(tmpParent, { recursive: true, force: true });
  }
});
