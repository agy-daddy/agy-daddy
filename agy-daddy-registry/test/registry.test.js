'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyAnchorsMatrix, verifyRegistryAndMatrix } = require('../scripts/verify-registry');

test('registry: Antigravity 2.32/2.33 x 14 锚点兼容矩阵与 anchors.json 字节一致性', () => {
  const res = verifyAnchorsMatrix();
  assert.equal(res.ok, true);
  assert.equal(res.anchorsCount, 14);
  assert.equal(res.matrix.length, 2);
  for (const row of res.matrix) {
    assert.equal(row.anchorsMatched, 14);
  }
});

test('registry: 10 插件完整性 SHA-512 与 Antigravity 2.32/2.33 x 14 锚点兼容矩阵', () => {
  const res = verifyRegistryAndMatrix();
  assert.equal(res.ok, true);
  assert.equal(res.pluginsVerified, 10);
  assert.equal(res.anchorsCount, 14);
  assert.equal(res.matrix.length, 2);
  for (const row of res.matrix) {
    assert.equal(row.anchorsMatched, 14);
  }
});
