'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getBuiltinThemes, getBuiltinThemeById } = require('../src/shared/themes');

const FORBIDDEN_THEME_REGEXES = [
  /#10b981/i,
  /#34d399/i,
  /#059669/i,
  /#38bdf8/i,
  /#7dd3fc/i,
  /#0369a1/i,
  /#0c4a6e/i,
  /#fb923c/i,
  /#c2410c/i
];

test('内置 12 款 MIT 原创致敬主题满足数量、结构与 Purple Theme Gate 门禁', () => {
  const themes = getBuiltinThemes();
  assert.equal(themes.length, 12);

  const ids = new Set();
  for (const theme of themes) {
    assert.ok(theme.id && !ids.has(theme.id), `Duplicate or empty theme id: ${theme.id}`);
    ids.add(theme.id);
    assert.ok(theme.name?.['zh-CN'] && theme.name?.en, `Missing bilingual name on ${theme.id}`);
    assert.ok(theme.scene?.viewBox?.width > 0 && theme.scene?.viewBox?.height > 0);
    assert.ok(theme.scene?.hitBox?.width > 0 && theme.scene?.hitBox?.height > 0);
    assert.ok(Array.isArray(theme.scene?.layers) && theme.scene.layers.length >= 3, `${theme.id} needs >= 3 layers`);
  }

  assert.equal(getBuiltinThemeById('non-existent').id, 'daddy-orb');

  // 扫描全部 src 目录确保零禁用色值
  const srcRoot = path.resolve(__dirname, '..', 'src');
  const walk = (dir) => {
    const out = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) out.push(...walk(full));
      else if (ent.isFile()) out.push(full);
    }
    return out;
  };
  for (const file of walk(srcRoot)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const re of FORBIDDEN_THEME_REGEXES) {
      assert.equal(re.test(text), false, `${path.relative(srcRoot, file)} violated theme gate: ${re}`);
    }
  }
});
