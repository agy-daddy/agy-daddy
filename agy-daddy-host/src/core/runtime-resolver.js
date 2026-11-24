'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseSemver, compareSemver, satisfies } = require('../contracts/semver');

const MIN_NODE_RANGE = '>=22.4.0';

function listVersionManagerNodes(homeDir, fsImpl = fs, platform = process.platform, env = process.env) {
  const candidates = [];
  if (platform === 'win32') {
    const appData = env.APPDATA || path.win32.join(homeDir, 'AppData', 'Roaming');
    const localAppData = env.LOCALAPPDATA || path.win32.join(homeDir, 'AppData', 'Local');

    if (env.NVM_SYMLINK) {
      const symlinkExe = path.win32.join(env.NVM_SYMLINK, 'node.exe');
      if (fsImpl.existsSync(symlinkExe)) {
        candidates.push({ path: symlinkExe, source: 'nvm-windows', isElectron: false });
      }
    }
    const nvmHome = env.NVM_HOME || path.win32.join(appData, 'nvm');
    if (fsImpl.existsSync(nvmHome)) {
      try {
        const dirs = fsImpl.readdirSync(nvmHome, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => ({ dir: d.name, ver: parseSemver(d.name) }))
          .filter((x) => x.ver)
          .sort((a, b) => compareSemver(b.ver, a.ver));
        for (const item of dirs) {
          const bin = path.win32.join(nvmHome, item.dir, 'node.exe');
          if (fsImpl.existsSync(bin)) {
            candidates.push({ path: bin, source: 'nvm-windows', isElectron: false });
          }
        }
      } catch {}
    }

    for (const fnmBase of [appData, localAppData]) {
      const fnmDir = path.win32.join(fnmBase, 'fnm', 'node-versions');
      if (fsImpl.existsSync(fnmDir)) {
        try {
          const dirs = fsImpl.readdirSync(fnmDir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => ({ dir: d.name, ver: parseSemver(d.name) }))
            .filter((x) => x.ver)
            .sort((a, b) => compareSemver(b.ver, a.ver));
          for (const item of dirs) {
            const bin = path.win32.join(fnmDir, item.dir, 'installation', 'node.exe');
            if (fsImpl.existsSync(bin)) {
              candidates.push({ path: bin, source: 'fnm', isElectron: false });
            }
          }
        } catch {}
      }
    }

    for (const voltaExe of [
      path.win32.join(localAppData, 'Volta', 'bin', 'node.exe'),
      path.win32.join(homeDir, '.volta', 'bin', 'node.exe')
    ]) {
      if (fsImpl.existsSync(voltaExe)) {
        candidates.push({ path: voltaExe, source: 'volta', isElectron: false });
      }
    }

    for (const scoopApp of ['nodejs', 'nodejs-lts']) {
      const scoopExe = path.win32.join(homeDir, 'scoop', 'apps', scoopApp, 'current', 'node.exe');
      if (fsImpl.existsSync(scoopExe)) {
        candidates.push({ path: scoopExe, source: 'scoop', isElectron: false });
      }
    }
    return candidates;
  }

  const nvmDir = path.join(homeDir, '.nvm', 'versions', 'node');
  if (fsImpl.existsSync(nvmDir)) {
    try {
      const dirs = fsImpl.readdirSync(nvmDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => ({ dir: d.name, ver: parseSemver(d.name) }))
        .filter((x) => x.ver)
        .sort((a, b) => compareSemver(b.ver, a.ver));
      for (const item of dirs) {
        const bin = path.join(nvmDir, item.dir, 'bin', 'node');
        if (fsImpl.existsSync(bin)) {
          candidates.push({ path: bin, source: 'nvm', isElectron: false });
        }
      }
    } catch {}
  }

  const fnmDir = path.join(homeDir, '.fnm', 'node-versions');
  if (fsImpl.existsSync(fnmDir)) {
    try {
      const dirs = fsImpl.readdirSync(fnmDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => ({ dir: d.name, ver: parseSemver(d.name) }))
        .filter((x) => x.ver)
        .sort((a, b) => compareSemver(b.ver, a.ver));
      for (const item of dirs) {
        const bin = path.join(fnmDir, item.dir, 'installation', 'bin', 'node');
        if (fsImpl.existsSync(bin)) {
          candidates.push({ path: bin, source: 'fnm', isElectron: false });
        }
      }
    } catch {}
  }

  const voltaNode = path.join(homeDir, '.volta', 'bin', 'node');
  if (fsImpl.existsSync(voltaNode)) {
    candidates.push({ path: voltaNode, source: 'volta', isElectron: false });
  }
  return candidates;
}

function listPathNodes(env, fsImpl = fs, platform = process.platform) {
  const rawPath = String(env.PATH || env.Path || '');
  const sep = platform === 'win32' ? ';' : ':';
  const exeName = platform === 'win32' ? 'node.exe' : 'node';
  const pathMod = platform === 'win32' ? path.win32 : path.posix;
  const out = [];
  const seen = new Set();
  for (const dir of rawPath.split(sep)) {
    const clean = dir.trim();
    if (!clean) continue;
    const full = pathMod.join(clean, exeName);
    const dedupKey = platform === 'win32' ? full.toLowerCase() : full;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    try {
      if (fsImpl.existsSync(full)) {
        out.push({ path: full, source: 'path', isElectron: false });
      }
    } catch {}
  }
  return out;
}

function listElectronHelpers(homeDir, platform = process.platform, fsImpl = fs, env = process.env) {
  const paths = [];
  if (platform === 'darwin') {
    paths.push(
      '/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper',
      path.join(homeDir, 'Applications', 'Antigravity.app', 'Contents', 'Frameworks', 'Antigravity Helper.app', 'Contents', 'MacOS', 'Antigravity Helper')
    );
  } else if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.win32.join(homeDir, 'AppData', 'Local');
    const programFiles = env.ProgramFiles || 'C:\\Program Files';
    const raw = [
      path.win32.join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe'),
      path.win32.join(localAppData, 'Programs', 'antigravity', 'Antigravity.exe'),
      path.win32.join(programFiles, 'Antigravity', 'Antigravity.exe'),
      path.win32.join(programFiles, 'Google Antigravity', 'Antigravity.exe'),
      path.win32.join(programFiles, 'Google', 'Antigravity', 'Antigravity.exe')
    ];
    const seen = new Set();
    for (const p of raw) {
      const key = p.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      paths.push(p);
    }
  } else {
    paths.push(
      '/opt/antigravity/antigravity',
      '/opt/Antigravity/antigravity',
      '/usr/lib/antigravity/antigravity',
      '/usr/share/antigravity/antigravity',
      path.posix.join(homeDir, '.local', 'share', 'antigravity', 'antigravity'),
      '/usr/bin/antigravity',
      '/usr/local/bin/antigravity'
    );
  }
  return paths
    .filter((p) => {
      try { return fsImpl.existsSync(p); } catch { return false; }
    })
    .map((p) => ({ path: p, source: 'electron-helper', isElectron: true }));
}

function defaultProbeCandidate(candidate, baseEnv = process.env) {
  const probeEnv = { ...baseEnv };
  if (candidate.isElectron) {
    probeEnv.ELECTRON_RUN_AS_NODE = '1';
  } else {
    delete probeEnv.ELECTRON_RUN_AS_NODE;
  }
  const code = 'console.log(JSON.stringify({node:process.versions.node,electron:process.versions.electron||null,ws:typeof WebSocket,fetch:typeof fetch}))';
  try {
    const raw = execFileSync(candidate.path, ['-e', code], {
      env: probeEnv,
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }).trim();
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const parsed = JSON.parse(lines[lines.length - 1]);
    if (!satisfies(parsed.node, MIN_NODE_RANGE)) {
      return { ok: false, reason: `node ${parsed.node} < 22.4.0` };
    }
    if (parsed.ws !== 'function' || parsed.fetch !== 'function') {
      return { ok: false, reason: 'missing built-in WebSocket or fetch' };
    }
    return {
      ok: true,
      nodeVersion: parsed.node,
      electronVersion: parsed.electron
    };
  } catch (err) {
    const msg = String(err?.stderr || err?.message || 'probe failed').trim().split(/\r?\n/)[0];
    return { ok: false, reason: msg || 'probe failed' };
  }
}

function resolveRuntime(options = {}) {
  const fsImpl = options.fs || fs;
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const platform = options.platform || process.platform;
  const probe = options.probeFn || defaultProbeCandidate;

  const rawCandidates = [];
  if (env.AGY_DADDY_NODE) {
    rawCandidates.push({ path: env.AGY_DADDY_NODE, source: 'env:AGY_DADDY_NODE', isElectron: Boolean(env.AGY_DADDY_NODE_ELECTRON === '1') });
  }
  if (Array.isArray(options.candidates)) {
    rawCandidates.push(...options.candidates);
  } else {
    rawCandidates.push(...listVersionManagerNodes(homeDir, fsImpl, platform, env));
    rawCandidates.push(...listPathNodes(env, fsImpl, platform));
    rawCandidates.push(...listElectronHelpers(homeDir, platform, fsImpl, env));
  }

  const seen = new Set();
  const rejected = [];
  for (const cand of rawCandidates) {
    if (!cand || !cand.path) continue;
    const key = `${cand.path}|${Boolean(cand.isElectron)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (!options.candidates && !fsImpl.existsSync(cand.path)) {
      rejected.push({ ...cand, reason: 'not found' });
      continue;
    }

    const res = probe(cand, env);
    if (res && res.ok) {
      return {
        ok: true,
        runtime: cand.path,
        source: cand.source,
        isElectron: Boolean(cand.isElectron),
        envPatch: cand.isElectron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
        nodeVersion: res.nodeVersion,
        electronVersion: res.electronVersion || null,
        rejected
      };
    }
    rejected.push({ ...cand, reason: res?.reason || 'probe failed' });
  }

  return {
    ok: false,
    runtime: null,
    source: null,
    isElectron: false,
    envPatch: {},
    nodeVersion: null,
    electronVersion: null,
    rejected
  };
}

module.exports = {
  MIN_NODE_RANGE,
  listVersionManagerNodes,
  listPathNodes,
  listElectronHelpers,
  defaultProbeCandidate,
  resolveRuntime
};
