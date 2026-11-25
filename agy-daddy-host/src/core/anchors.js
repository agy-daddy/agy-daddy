'use strict';

const fs = require('fs');
const path = require('path');
const { satisfies } = require('../contracts/semver');

const DEFAULT_ANCHORS_PATH = path.resolve(__dirname, '..', '..', 'data', 'anchors.json');

function loadAnchorsRegistry(options = {}) {
  const customPath = options.anchorsPath;
  const candidates = [];
  if (customPath) candidates.push(path.resolve(customPath));
  if (options.stateDir) candidates.push(path.join(path.resolve(options.stateDir), 'anchors.json'));
  candidates.push(DEFAULT_ANCHORS_PATH);

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (parsed && typeof parsed === 'object' && parsed.anchors) {
          return { ...parsed, sourcePath: p };
        }
      }
    } catch {}
  }
  return { schemaVersion: 1, anchors: {}, sourcePath: null };
}

function resolveAnchorSelectors(anchorName, antigravityVersion = '2.33.0', anchorsData = null) {
  const registry = anchorsData || loadAnchorsRegistry();
  const def = registry.anchors?.[anchorName];
  if (!def) {
    return { found: false, anchor: anchorName, selectors: [], closestHint: null };
  }
  const versions = Array.isArray(def.versions) ? def.versions : [];
  for (const entry of versions) {
    if (!entry.range || satisfies(antigravityVersion, entry.range)) {
      return {
        found: true,
        anchor: anchorName,
        selectors: Array.isArray(entry.selectors) ? [...entry.selectors] : [],
        closestHint: entry.closestHint || null,
        description: def.description || ''
      };
    }
  }
  const fallback = versions[0];
  return {
    found: Boolean(fallback),
    anchor: anchorName,
    selectors: Array.isArray(fallback?.selectors) ? [...fallback.selectors] : [],
    closestHint: fallback?.closestHint || null,
    description: def.description || ''
  };
}

function checkAnchorHealth(anchorsData, antigravityVersion, queryFn) {
  const registry = anchorsData || loadAnchorsRegistry();
  const matched = {};
  const missing = [];
  for (const anchorName of Object.keys(registry.anchors || {})) {
    const resolved = resolveAnchorSelectors(anchorName, antigravityVersion, registry);
    let hitSelector = null;
    for (const sel of resolved.selectors) {
      try {
        if (queryFn(sel, anchorName)) {
          hitSelector = sel;
          break;
        }
      } catch {}
    }
    if (hitSelector) {
      matched[anchorName] = hitSelector;
    } else {
      missing.push(anchorName);
    }
  }
  return {
    healthy: missing.length === 0,
    matched,
    missing
  };
}

function loadHealthAnchorsRegistry(options = {}) {
  const defaults = loadAnchorsRegistry();
  const active = loadAnchorsRegistry(options);
  return {
    ...active,
    anchors: Object.fromEntries(Object.entries(defaults.anchors).map(([name, definition]) => [
      name, active.anchors[name] || definition
    ]))
  };
}

function checkPluginAnchors(manifest, anchorHealth) {
  const required = Array.isArray(manifest?.requires?.anchors) ? manifest.requires.anchors : [];
  if (!required.length) {
    return { ok: true, missing: [] };
  }
  const matched = anchorHealth?.matched || {};
  const missing = required.filter((name) => !matched[name]);
  return {
    ok: missing.length === 0,
    missing
  };
}

function buildResolvedAnchorsMap(anchorsData = null, antigravityVersion = '2.33.0') {
  const registry = anchorsData || loadAnchorsRegistry();
  const resolvedAnchors = {};
  for (const name of Object.keys(registry.anchors || {})) {
    const resolved = resolveAnchorSelectors(name, antigravityVersion, registry);
    resolvedAnchors[name] = {
      description: resolved.description || '',
      versions: [
        {
          range: antigravityVersion,
          selectors: Array.isArray(resolved.selectors) ? resolved.selectors : [],
          closestHint: resolved.closestHint || null
        }
      ]
    };
  }
  return {
    schemaVersion: registry.schemaVersion || 1,
    antigravityVersion,
    anchors: resolvedAnchors
  };
}

module.exports = {
  DEFAULT_ANCHORS_PATH,
  loadAnchorsRegistry,
  loadHealthAnchorsRegistry,
  resolveAnchorSelectors,
  checkAnchorHealth,
  checkPluginAnchors,
  buildResolvedAnchorsMap
};
