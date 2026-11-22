'use strict';

const fs = require('fs');
const path = require('path');

function auditUpstreamsAndBaselines(options = {}) {
  const hostRoot = options.hostRoot ? path.resolve(options.hostRoot) : path.resolve(__dirname, '..', '..');
  const workspaceRoot = options.workspaceRoot ? path.resolve(options.workspaceRoot) : path.resolve(hostRoot, '..');
  const upstreamsPath = path.join(hostRoot, 'data', 'upstreams.json');

  let upstreamsData = { schemaVersion: 1, upstreams: [] };
  if (fs.existsSync(upstreamsPath)) {
    try {
      upstreamsData = JSON.parse(fs.readFileSync(upstreamsPath, 'utf8'));
    } catch {}
  }

  const pluginBaselines = [];
  if (fs.existsSync(workspaceRoot)) {
    const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('agy-daddy-plugin-'))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const d of entries) {
      const bPath = path.join(workspaceRoot, d.name, 'baseline.json');
      const mPath = path.join(workspaceRoot, d.name, 'agy-plugin.json');
      let baseline = null;
      let pluginId = d.name;
      if (fs.existsSync(mPath)) {
        try { pluginId = JSON.parse(fs.readFileSync(mPath, 'utf8')).id || d.name; } catch {}
      }
      if (fs.existsSync(bPath)) {
        try { baseline = JSON.parse(fs.readFileSync(bPath, 'utf8')); } catch {}
      }
      pluginBaselines.push({
        repo: d.name,
        pluginId,
        hasBaseline: Boolean(baseline),
        absorbedSha: baseline?.absorbedSha || null,
        paths: Array.isArray(baseline?.paths) ? baseline.paths : []
      });
    }
  }

  return {
    ok: true,
    upstreamsCount: Array.isArray(upstreamsData.upstreams) ? upstreamsData.upstreams.length : 0,
    upstreams: upstreamsData.upstreams || [],
    pluginBaselines
  };
}

module.exports = {
  auditUpstreamsAndBaselines
};
