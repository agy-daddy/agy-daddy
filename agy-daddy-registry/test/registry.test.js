'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyRegistryAndMatrix } = require('../scripts/verify-registry');

test('registry: 10 插件完整性 SHA-512 与 Antigravity 2.32/2.33 x 10 锚点兼容矩阵', () => {
  const res = verifyRegistryAndMatrix();
  assert.equal(res.ok, true);
  assert.equal(res.pluginsVerified, 10);
  assert.equal(res.matrix.length, 2);
  for (const row of res.matrix) {
    assert.equal(row.anchorsMatched, 10);
  }
});
