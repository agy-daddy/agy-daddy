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
  assert.equal(KNOWN_ANCHORS.length, 14, `Expected 14 KNOWN_ANCHORS, got ${KNOWN_ANCHORS.length}`);
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

const SHA512_FORMAT_RE = /^sha512-[A-Za-z0-9+/=]{86,88}$/;

function findExternalSiblingDir(workspaceRoot, entry, checkParentSibling = true) {
  const candidates = [];
  if (entry.localRepo) {
    candidates.push(path.join(workspaceRoot, entry.localRepo));
  }
  if (entry.repo) {
    const repoName = path.basename(String(entry.repo).replace(/\/+$/, '').replace(/\.git$/i, ''));
    if (repoName && repoName !== '.' && repoName !== '..') {
      candidates.push(path.join(workspaceRoot, repoName));
      if (checkParentSibling) {
        candidates.push(path.resolve(workspaceRoot, '..', repoName));
      }
    }
  }
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'agy-plugin.json'))) {
      return dir;
    }
  }
  return null;
}

function verifyRegistryAndMatrix(options = {}) {
  const workspaceRoot = options.workspaceRoot || path.resolve(REG_ROOT, '..');
  const regPath = options.registryPath ? path.resolve(options.registryPath) : path.join(REG_ROOT, 'registry.json');
  const reg = options.registry || JSON.parse(fs.readFileSync(regPath, 'utf8'));
  const checkParentSibling = options.checkParentSibling !== false;

  assert.equal(Array.isArray(reg.plugins), true);
  assert.ok(reg.plugins.length >= 9);

  const hashResults = [];
  for (const entry of reg.plugins) {
    if (entry.external === true) {
      assert.ok(typeof entry.id === 'string' && entry.id.trim().length > 0, 'External registry entry missing id');
      assert.match(String(entry.repo || ''), /^https:\/\/\S+/, `External registry entry ${entry.id} must use an https:// repo URL`);
      assert.ok(typeof entry.ref === 'string' && entry.ref.trim().length > 0, `External registry entry ${entry.id} missing ref`);
      assert.match(
        String(entry.manifestSha512 || ''),
        SHA512_FORMAT_RE,
        `External registry entry ${entry.id} has invalid manifestSha512 format`
      );

      const externalDir = findExternalSiblingDir(workspaceRoot, entry, checkParentSibling);
      if (externalDir) {
        const manifestRaw = fs.readFileSync(path.join(externalDir, 'agy-plugin.json'));
        const actualSha = 'sha512-' + crypto.createHash('sha512').update(manifestRaw).digest('base64');
        assert.equal(actualSha, entry.manifestSha512, `SHA-512 mismatch for ${entry.id}`);
        const manifest = JSON.parse(manifestRaw.toString('utf8'));
        const v = validateManifest(manifest);
        assert.equal(v.ok, true, `Invalid manifest in ${entry.id}: ${v.errors.join('; ')}`);
        hashResults.push({ id: entry.id, trustLevel: entry.trustLevel, external: true, shaVerified: true, mode: 'physical' });
      } else {
        hashResults.push({ id: entry.id, trustLevel: entry.trustLevel, external: true, shaVerified: false, formatVerified: true, mode: 'metadata' });
      }
      continue;
    }

    const pluginDir = path.join(workspaceRoot, entry.localRepo || '');
    assert.ok(fs.existsSync(pluginDir), `Missing sibling plugin repo: ${pluginDir}`);
    const manifestRaw = fs.readFileSync(path.join(pluginDir, 'agy-plugin.json'));
    const actualSha = 'sha512-' + crypto.createHash('sha512').update(manifestRaw).digest('base64');
    assert.equal(actualSha, entry.manifestSha512, `SHA-512 mismatch for ${entry.id}`);
    const manifest = JSON.parse(manifestRaw.toString('utf8'));
    const v = validateManifest(manifest);
    assert.equal(v.ok, true, `Invalid manifest in ${entry.id}: ${v.errors.join('; ')}`);
    hashResults.push({ id: entry.id, trustLevel: entry.trustLevel, external: false, shaVerified: true, mode: 'physical' });
  }

  const anchorsRes = verifyAnchorsMatrix();
  return {
    ok: true,
    pluginsVerified: hashResults.length,
    plugins: hashResults,
    anchorsCount: anchorsRes.anchorsCount,
    matrix: anchorsRes.matrix
  };
}

if (require.main === module) {
  const res = verifyRegistryAndMatrix();
  console.log(JSON.stringify(res, null, 2));
}

module.exports = { verifyAnchorsMatrix, verifyRegistryAndMatrix };
