'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REG_ROOT = path.resolve(__dirname, '..');
const HOST_ROOT = process.env.AGY_DADDY_HOST_DIR
  ? path.resolve(process.env.AGY_DADDY_HOST_DIR)
  : path.resolve(REG_ROOT, '..', 'agy-daddy-host');

const { KNOWN_ANCHORS } = require(path.join(HOST_ROOT, 'src', 'contracts', 'constants'));
const { validateManifest } = require(path.join(HOST_ROOT, 'src', 'contracts', 'manifest-validator'));
const { resolveAnchorSelectors } = require(path.join(HOST_ROOT, 'src', 'core', 'anchors'));
const { createMockDocument, createMockElement } = require(path.join(HOST_ROOT, 'sdk', 'mock-harness'));

function buildFixtureDocument(fixtureJson) {
  const doc = createMockDocument([]);
  const box = createMockElement('div', doc);
  box.className = 'surface-composer';
  doc.body.appendChild(box);
  let settingsDialog = null;
  for (const spec of fixtureJson.nodes || []) {
    const el = createMockElement(spec.tag || 'div', doc);
    for (const [k, v] of Object.entries(spec.attrs || {})) {
      el.setAttribute(k, v);
    }
    if (spec.attrs && (spec.attrs['data-testid'] === 'settings-dialog' || spec.attrs.role === 'dialog')) {
      settingsDialog = el;
      doc.body.appendChild(el);
    } else if (
      settingsDialog &&
      (spec.attrs?.['data-testid'] === 'settings-nav' ||
        spec.attrs?.['data-testid'] === 'settings-content' ||
        spec.attrs?.['data-settings-child'] === 'true')
    ) {
      settingsDialog.appendChild(el);
    } else if (spec.attrs && (spec.attrs['data-lexical-editor'] || spec.attrs['data-testid'] === 'input-send-button' || spec.attrs['data-testid'] === 'send-button')) {
      box.appendChild(el);
    } else if (spec.attrs && (spec.attrs['data-testid'] === 'turn-cards-container' || spec.attrs['data-testid'] === 'agent-response')) {
      const vp = doc.querySelector('[data-testid="autoscroll-viewport"]') || doc.body;
      vp.appendChild(el);
    } else {
      doc.body.appendChild(el);
    }
  }
  return doc;
}

function verifyAnchorsMatrix() {
  const regAnchorsPath = path.join(REG_ROOT, 'anchors.json');
  const hostAnchorsPath = path.join(HOST_ROOT, 'data', 'anchors.json');
  const regRaw = fs.readFileSync(regAnchorsPath);
  const hostRaw = fs.readFileSync(hostAnchorsPath);
  assert.equal(Buffer.compare(regRaw, hostRaw), 0, 'agy-daddy-registry/anchors.json and agy-daddy-host/data/anchors.json must be byte-identical');

  const anchorsReg = JSON.parse(regRaw.toString('utf8'));
  assert.equal(KNOWN_ANCHORS.length, 15, `Expected 15 KNOWN_ANCHORS, got ${KNOWN_ANCHORS.length}`);
  for (const anchorName of KNOWN_ANCHORS) {
    assert.ok(anchorsReg.anchors && anchorsReg.anchors[anchorName], `Missing anchor definition in anchors.json: ${anchorName}`);
  }

  const fixtureFiles = fs.readdirSync(path.join(REG_ROOT, 'fixtures')).filter((f) => f.endsWith('.json')).sort();
  assert.ok(fixtureFiles.length >= 2);
  const matrix = [];

  for (const f of fixtureFiles) {
    const fx = JSON.parse(fs.readFileSync(path.join(REG_ROOT, 'fixtures', f), 'utf8'));
    const doc = buildFixtureDocument(fx);
    const matchedAnchors = {};
    for (const anchorName of KNOWN_ANCHORS) {
      const res = resolveAnchorSelectors(anchorName, fx.antigravityVersion, anchorsReg);
      let hit = null;
      for (const sel of res.selectors || []) {
        hit = doc.querySelector(sel);
        if (hit) break;
      }
      assert.ok(hit, `Fixture ${f} (${fx.antigravityVersion}) failed to match anchor: ${anchorName}`);
      matchedAnchors[anchorName] = true;
    }
    matrix.push({ fixture: f, version: fx.antigravityVersion, anchorsMatched: Object.keys(matchedAnchors).length });
  }

  return { ok: true, anchorsCount: KNOWN_ANCHORS.length, matrix };
}

function verifyRegistryAndMatrix(options = {}) {
  const workspaceRoot = options.workspaceRoot || path.resolve(REG_ROOT, '..');
  const reg = JSON.parse(fs.readFileSync(path.join(REG_ROOT, 'registry.json'), 'utf8'));

  assert.equal(Array.isArray(reg.plugins), true);
  assert.ok(reg.plugins.length >= 9);

  const hashResults = [];
  for (const entry of reg.plugins) {
    const pluginDir = path.join(workspaceRoot, entry.localRepo || '');
    assert.ok(fs.existsSync(pluginDir), `Missing sibling plugin repo: ${pluginDir}`);
    const manifestRaw = fs.readFileSync(path.join(pluginDir, 'agy-plugin.json'));
    const actualSha = 'sha512-' + crypto.createHash('sha512').update(manifestRaw).digest('base64');
    assert.equal(actualSha, entry.manifestSha512, `SHA-512 mismatch for ${entry.id}`);
    const manifest = JSON.parse(manifestRaw.toString('utf8'));
    const v = validateManifest(manifest);
    assert.equal(v.ok, true, `Invalid manifest in ${entry.id}: ${v.errors.join('; ')}`);
    hashResults.push({ id: entry.id, trustLevel: entry.trustLevel, shaVerified: true });
  }

  const anchorsRes = verifyAnchorsMatrix();
  return { ok: true, pluginsVerified: hashResults.length, anchorsCount: anchorsRes.anchorsCount, matrix: anchorsRes.matrix };
}

if (require.main === module) {
  const res = verifyRegistryAndMatrix();
  console.log(JSON.stringify(res, null, 2));
}

module.exports = { verifyAnchorsMatrix, verifyRegistryAndMatrix };
