'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');

const ENV_MATRIX = Object.freeze({
  development: Object.freeze({
    env: 'development',
    distTag: 'dev',
    provenance: false,
    requireAuth: false
  }),
  staging: Object.freeze({
    env: 'staging',
    distTag: 'next',
    provenance: false,
    requireAuth: true
  }),
  production: Object.freeze({
    env: 'production',
    distTag: 'latest',
    provenance: true,
    requireAuth: true
  })
});

function listPublishablePackages(rootDir = ROOT_DIR) {
  const dirs = [];
  const hostDir = path.join(rootDir, 'agy-daddy-host');
  if (fs.existsSync(hostDir)) dirs.push(hostDir);

  const pluginDirs = fs.readdirSync(rootDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('agy-daddy-plugin-'))
    .map((d) => d.name)
    .sort()
    .map((name) => path.join(rootDir, name));
  dirs.push(...pluginDirs);

  const regDir = path.join(rootDir, 'agy-daddy-registry');
  if (fs.existsSync(regDir)) dirs.push(regDir);

  return dirs.map((dir) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return {
      dir,
      dirName: path.basename(dir),
      name: pkg.name,
      version: pkg.version,
      pkg
    };
  });
}

function resolveEnvironmentConfig(envName = process.env.RELEASE_ENV || 'staging', overrides = {}) {
  const key = String(envName || '').trim().toLowerCase();
  const base = ENV_MATRIX[key];
  if (!base) {
    throw new Error(`Unsupported release environment "${envName}". Expected one of: ${Object.keys(ENV_MATRIX).join(', ')}`);
  }
  const npmRegistryUrl = String(
    overrides.npmRegistryUrl || process.env.NPM_REGISTRY_URL || 'https://registry.npmjs.org'
  ).replace(/\/+$/, '');
  const distTag = String(
    overrides.distTag || process.env.NPM_DIST_TAG || base.distTag
  ).trim();
  const provenance = typeof overrides.provenance === 'boolean'
    ? overrides.provenance
    : base.provenance;
  return {
    env: base.env,
    distTag,
    provenance,
    requireAuth: base.requireAuth,
    npmRegistryUrl
  };
}

function parseReleaseTag(tag, rootDir = ROOT_DIR) {
  const raw = String(tag || '').trim();
  const allPackages = listPublishablePackages(rootDir);

  const rootMatch = raw.match(/^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/);
  if (rootMatch) {
    return {
      kind: 'all',
      tag: raw,
      expectedVersion: rootMatch[1],
      targets: allPackages
    };
  }

  const scopedMatch = raw.match(/^([a-z0-9-]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/);
  if (scopedMatch) {
    const scopeKey = scopedMatch[1];
    const expectedVersion = scopedMatch[2];
    const dirName = scopeKey === 'host'
      ? 'agy-daddy-host'
      : scopeKey === 'registry'
        ? 'agy-daddy-registry'
        : scopeKey.startsWith('agy-daddy-')
          ? scopeKey
          : `agy-daddy-${scopeKey}`;
    const matched = allPackages.filter((p) => p.dirName === dirName);
    if (matched.length === 0) {
      throw new Error(`Release tag "${raw}" does not match any publishable package (${dirName})`);
    }
    return {
      kind: 'single',
      tag: raw,
      expectedVersion,
      targets: matched
    };
  }

  throw new Error(`Invalid release tag "${raw}". Expected "vX.Y.Z" or "<host|registry|plugin-name>@X.Y.Z"`);
}

function resolveTargets(targetSpec = 'all', rootDir = ROOT_DIR) {
  const raw = String(targetSpec || 'all').trim();
  const allPackages = listPublishablePackages(rootDir);

  if (!raw || raw === 'all') {
    return { kind: 'all', tag: null, expectedVersion: null, targets: allPackages };
  }
  if (raw.includes('@') && !raw.startsWith('@')) {
    return parseReleaseTag(raw, rootDir);
  }
  if (/^v\d+\.\d+\.\d+/.test(raw)) {
    return parseReleaseTag(raw, rootDir);
  }

  const requested = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const targets = [];
  for (const item of requested) {
    const match = allPackages.find(
      (p) =>
        p.dirName === item ||
        p.name === item ||
        p.dirName === `agy-daddy-${item}` ||
        p.dirName === `agy-daddy-plugin-${item}`
    );
    if (!match) {
      throw new Error(`Unknown release target "${item}"`);
    }
    if (!targets.some((t) => t.dirName === match.dirName)) {
      targets.push(match);
    }
  }
  return {
    kind: targets.length === allPackages.length ? 'all' : 'subset',
    tag: null,
    expectedVersion: null,
    targets
  };
}

function validateReleaseConsistency({ rootDir = ROOT_DIR, packages, expectedVersion = null }) {
  const errors = [];
  const checked = [];
  const regPath = path.join(rootDir, 'agy-daddy-registry', 'registry.json');
  const reg = fs.existsSync(regPath) ? JSON.parse(fs.readFileSync(regPath, 'utf8')) : null;
  const regByRepo = new Map();
  if (reg && Array.isArray(reg.plugins)) {
    for (const entry of reg.plugins) {
      if (entry.localRepo) regByRepo.set(entry.localRepo, entry);
      if (entry.npmPackage) regByRepo.set(entry.npmPackage, entry);
    }
  }

  for (const item of packages) {
    const pkg = item.pkg || JSON.parse(fs.readFileSync(path.join(item.dir, 'package.json'), 'utf8'));
    if (pkg.publishConfig?.access !== 'public') {
      errors.push(`${item.dirName}: publishConfig.access must be "public"`);
    }
    if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
      errors.push(`${item.dirName}: missing non-empty "files" whitelist`);
    }
    if (expectedVersion && pkg.version !== expectedVersion) {
      errors.push(`${item.dirName}: package.json version (${pkg.version}) != expected (${expectedVersion})`);
    }

    const manifestPath = path.join(item.dir, 'agy-plugin.json');
    if (fs.existsSync(manifestPath)) {
      const manifestRaw = fs.readFileSync(manifestPath);
      const manifest = JSON.parse(manifestRaw.toString('utf8'));
      if (manifest.version !== pkg.version) {
        errors.push(`${item.dirName}: agy-plugin.json version (${manifest.version}) != package.json version (${pkg.version})`);
      }
      const regEntry = regByRepo.get(item.dirName) || regByRepo.get(pkg.name);
      if (regEntry) {
        if (regEntry.version !== pkg.version) {
          errors.push(`${item.dirName}: registry.json version (${regEntry.version}) != package.json version (${pkg.version})`);
        }
        const actualSha = `sha512-${crypto.createHash('sha512').update(manifestRaw).digest('base64')}`;
        if (regEntry.manifestSha512 !== actualSha) {
          errors.push(`${item.dirName}: registry.json manifestSha512 mismatch`);
        }
      }
    }

    checked.push({ name: pkg.name, version: pkg.version, dirName: item.dirName });
  }

  return { ok: errors.length === 0, checked, errors };
}

function runCommand(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, {
    cwd: options.cwd || ROOT_DIR,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: options.env || process.env
  });
  return {
    status: res.status ?? 1,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || '')
  };
}

function getGitMetadata(rootDir = ROOT_DIR) {
  const sha = runCommand('git', ['rev-parse', 'HEAD'], { cwd: rootDir });
  const branch = runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: rootDir });
  return {
    commit: sha.status === 0 ? sha.stdout.trim() : 'unknown',
    branch: branch.status === 0 ? branch.stdout.trim() : 'unknown'
  };
}

function packRelease({ rootDir = ROOT_DIR, targets, envConfig, releaseTag = null, outDir = null, skipVerify = false }) {
  if (!skipVerify) {
    const verifyRes = spawnSync('npm', ['run', 'verify'], {
      cwd: rootDir,
      stdio: 'inherit',
      shell: process.platform === 'win32'
    });
    if (verifyRes.status !== 0) {
      throw new Error(`npm run verify failed with exit code ${verifyRes.status}`);
    }
  }

  const label = String(releaseTag || new Date().toISOString().replace(/[:.]/g, '-'))
    .replace(/[^a-zA-Z0-9._@-]/g, '_');
  const artifactDir = path.resolve(outDir || path.join(rootDir, '.release-artifacts', label));
  fs.mkdirSync(artifactDir, { recursive: true });

  const gitMeta = getGitMetadata(rootDir);
  const packedPackages = [];

  for (const item of targets) {
    const res = runCommand('npm', ['pack', '--pack-destination', artifactDir, '--json'], { cwd: item.dir });
    if (res.status !== 0) {
      throw new Error(`npm pack failed for ${item.name}: ${res.stderr || res.stdout}`);
    }
    const parsed = JSON.parse(res.stdout);
    const info = Array.isArray(parsed)
      ? parsed[0]
      : (parsed && typeof parsed.filename === 'string' ? parsed : Object.values(parsed || {})[0]);
    if (!info || !info.filename) {
      throw new Error(`Unexpected npm pack --json output for ${item.name}`);
    }
    const tarballPath = path.join(artifactDir, info.filename);
    const buf = fs.readFileSync(tarballPath);
    const sha512 = `sha512-${crypto.createHash('sha512').update(buf).digest('base64')}`;
    packedPackages.push({
      name: item.name,
      version: item.version,
      dir: item.dirName,
      tarball: info.filename,
      bytes: buf.byteLength,
      unpackedSize: info.unpackedSize,
      entryCount: info.entryCount ?? (Array.isArray(info.files) ? info.files.length : 0),
      sha512
    });
  }

  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    gitCommit: gitMeta.commit,
    gitBranch: gitMeta.branch,
    env: envConfig.env,
    distTag: envConfig.distTag,
    npmRegistryUrl: envConfig.npmRegistryUrl,
    releaseTag,
    packages: packedPackages
  };

  const manifestPath = path.join(artifactDir, 'release-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { artifactDir, manifestPath, manifest };
}

function isVersionPublished(pkgName, version, registryUrl, execFn = runCommand) {
  const res = execFn('npm', ['view', `${pkgName}@${version}`, 'version', '--registry', registryUrl]);
  return res.status === 0 && res.stdout.trim() === version;
}

function publishRelease({
  rootDir = ROOT_DIR,
  targets,
  expectedVersion = null,
  envConfig,
  dryRun = true,
  provenance = envConfig.provenance,
  skipVerify = false,
  execFn = runCommand
}) {
  const consistency = validateReleaseConsistency({ rootDir, packages: targets, expectedVersion });
  if (!consistency.ok) {
    throw new Error(`Release consistency check failed:\n- ${consistency.errors.join('\n- ')}`);
  }

  if (!dryRun && !skipVerify) {
    const verifyRes = spawnSync('npm', ['run', 'verify'], {
      cwd: rootDir,
      stdio: 'inherit',
      shell: process.platform === 'win32'
    });
    if (verifyRes.status !== 0) {
      throw new Error(`Pre-publish verify failed with exit code ${verifyRes.status}`);
    }
  }

  const results = [];
  for (const item of targets) {
    if (!dryRun && isVersionPublished(item.name, item.version, envConfig.npmRegistryUrl, execFn)) {
      results.push({
        name: item.name,
        version: item.version,
        status: 'skipped',
        reason: 'already-published'
      });
      continue;
    }

    const args = ['publish', '--access', 'public', '--tag', envConfig.distTag, '--registry', envConfig.npmRegistryUrl];
    if (provenance) args.push('--provenance');
    if (dryRun) args.push('--dry-run');

    const res = execFn('npm', args, { cwd: item.dir });
    if (res.status !== 0) {
      throw new Error(`npm publish failed for ${item.name}@${item.version}: ${res.stderr || res.stdout}`);
    }
    results.push({
      name: item.name,
      version: item.version,
      status: dryRun ? 'dry-run' : 'published',
      command: `npm ${args.join(' ')}`
    });
  }
  return { dryRun, envConfig, results };
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkNpmHealth({
  packages,
  envConfig,
  fetchImpl = globalThis.fetch,
  retries = 3,
  retryDelayMs = 2000
}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is unavailable for npm healthcheck');
  }

  const checks = [];
  const failures = [];
  for (const item of packages) {
    const metaUrl = `${envConfig.npmRegistryUrl}/${encodeURIComponent(item.name)}`;
    let lastError = null;
    let passed = false;

    for (let attempt = 1; attempt <= Math.max(1, retries); attempt++) {
      try {
        const resp = await fetchImpl(metaUrl, { headers: { Accept: 'application/json' } });
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status} fetching ${metaUrl}`);
        }
        const meta = await resp.json();
        const verObj = meta?.versions?.[item.version];
        if (!verObj) {
          throw new Error(`Version ${item.version} missing in registry metadata`);
        }
        const activeTagVer = meta?.['dist-tags']?.[envConfig.distTag];
        if (activeTagVer !== item.version) {
          throw new Error(`dist-tags.${envConfig.distTag} is "${activeTagVer || 'unset'}", expected "${item.version}"`);
        }
        if (!verObj?.dist?.integrity) {
          throw new Error(`Missing dist.integrity for ${item.name}@${item.version}`);
        }
        passed = true;
        checks.push({
          name: item.name,
          version: item.version,
          distTag: envConfig.distTag,
          integrity: verObj.dist.integrity,
          attempts: attempt
        });
        break;
      } catch (err) {
        lastError = err.message;
        if (attempt < retries && retryDelayMs > 0) {
          await sleepMs(retryDelayMs);
        }
      }
    }

    if (!passed) {
      failures.push({ name: item.name, version: item.version, error: lastError });
    }
  }

  const rollbackHints = failures.map(
    (f) => `node scripts/release.js rollback --env ${envConfig.env} --target ${f.name} --to-version <prev-version> --deprecate-version ${f.version} --execute`
  );

  return {
    ok: failures.length === 0,
    checked: checks.length,
    checks,
    failures,
    rollbackHints
  };
}

function checkLocalHealth({ rootDir = ROOT_DIR }) {
  const checks = [];

  const hostBundlePath = path.join(rootDir, 'agy-daddy-host', 'dist', 'host-renderer.js');
  if (!fs.existsSync(hostBundlePath)) {
    throw new Error(`Missing host bundle: ${hostBundlePath}`);
  }
  new vm.Script(fs.readFileSync(hostBundlePath, 'utf8'), { filename: 'host-renderer.js' });
  checks.push({ check: 'host-renderer', ok: true, bytes: fs.statSync(hostBundlePath).size });

  for (const uiPkg of ['agy-daddy-plugin-remote', 'agy-daddy-plugin-web']) {
    const htmlPath = path.join(rootDir, uiPkg, 'dist', 'web', 'index.html');
    if (!fs.existsSync(htmlPath)) {
      throw new Error(`Missing web UI bundle: ${htmlPath}`);
    }
    checks.push({ check: `${uiPkg}/dist/web`, ok: true });
  }

  const { verifyRegistryAndMatrix } = require(path.join(rootDir, 'agy-daddy-registry', 'scripts', 'verify-registry'));
  const regRes = verifyRegistryAndMatrix({ workspaceRoot: rootDir });
  checks.push({ check: 'registry-matrix', ok: regRes.ok, pluginsVerified: regRes.pluginsVerified });

  const doctorCli = path.join(rootDir, 'agy-daddy-host', 'src', 'cli.js');
  const doctorRes = spawnSync(process.execPath, [doctorCli, 'doctor', '--json'], {
    cwd: rootDir,
    encoding: 'utf8',
    env: { ...process.env, AGY_DADDY_TEST_MODE: '1' }
  });
  if (doctorRes.status !== 0) {
    throw new Error(`agy-daddy doctor --json failed (exit=${doctorRes.status}): ${doctorRes.stderr || doctorRes.stdout}`);
  }
  const doctorJson = JSON.parse(doctorRes.stdout);
  checks.push({ check: 'host-doctor', ok: Boolean(doctorJson), nodeVersion: doctorJson.nodeVersion || process.version });

  return { ok: true, mode: 'local', checks };
}

function buildRollbackPlan({ packages, toVersion, deprecateVersion = null, envConfig }) {
  const cleanTo = String(toVersion || '').trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(cleanTo)) {
    throw new Error(`Invalid rollback target version "--to-version ${toVersion}". Expected semver e.g. 1.0.0`);
  }
  const cleanDeprecate = deprecateVersion ? String(deprecateVersion).trim() : null;
  if (cleanDeprecate && cleanDeprecate === cleanTo) {
    throw new Error('--deprecate-version cannot equal --to-version');
  }

  const steps = [];
  for (const item of packages) {
    steps.push({
      package: item.name,
      action: 'dist-tag',
      args: ['dist-tag', 'add', `${item.name}@${cleanTo}`, envConfig.distTag, '--registry', envConfig.npmRegistryUrl]
    });
    if (cleanDeprecate) {
      steps.push({
        package: item.name,
        action: 'deprecate',
        args: [
          'deprecate',
          `${item.name}@${cleanDeprecate}`,
          `Rolled back ${envConfig.distTag} to ${cleanTo} after release verification failure`,
          '--registry',
          envConfig.npmRegistryUrl
        ]
      });
    }
  }
  return {
    env: envConfig.env,
    distTag: envConfig.distTag,
    toVersion: cleanTo,
    deprecateVersion: cleanDeprecate,
    steps
  };
}

function executeRollback(plan, { dryRun = true, execFn = runCommand } = {}) {
  const executed = [];
  for (const step of plan.steps) {
    const cmdStr = `npm ${step.args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`;
    if (dryRun) {
      executed.push({ ...step, status: 'dry-run', command: cmdStr });
      continue;
    }
    const res = execFn('npm', step.args, { cwd: ROOT_DIR });
    if (res.status !== 0) {
      throw new Error(`Rollback command failed (${cmdStr}): ${res.stderr || res.stdout}`);
    }
    executed.push({ ...step, status: 'executed', command: cmdStr });
  }
  return { dryRun, executed };
}

function parseCliArgs(argv) {
  const [cmd = 'plan', ...rest] = argv;
  const opts = {
    env: process.env.RELEASE_ENV || 'staging',
    target: 'all',
    mode: 'local',
    dryRun: true,
    execute: false,
    skipVerify: false,
    provenance: undefined,
    toVersion: null,
    deprecateVersion: null,
    outDir: null,
    retries: 3,
    retryDelayMs: 2000
  };

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const next = () => {
      if (i + 1 >= rest.length) throw new Error(`Missing value for ${arg}`);
      return rest[++i];
    };
    if (arg === '--env') opts.env = next();
    else if (arg === '--target') opts.target = next();
    else if (arg === '--mode') opts.mode = next();
    else if (arg === '--to-version') opts.toVersion = next();
    else if (arg === '--deprecate-version') opts.deprecateVersion = next();
    else if (arg === '--out-dir') opts.outDir = next();
    else if (arg === '--retries') opts.retries = Number(next());
    else if (arg === '--retry-delay-ms') opts.retryDelayMs = Number(next());
    else if (arg === '--dry-run') { opts.dryRun = true; opts.execute = false; }
    else if (arg === '--execute') { opts.dryRun = false; opts.execute = true; }
    else if (arg === '--skip-verify') opts.skipVerify = true;
    else if (arg === '--provenance') opts.provenance = true;
    else if (arg === '--no-provenance') opts.provenance = false;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return { cmd, opts };
}

function printHelp() {
  console.log(`Usage: node scripts/release.js <plan|pack|publish|healthcheck|rollback> [options]

Options:
  --env <development|staging|production>   Target release channel (default: staging)
  --target <all|tag|pkg[,pkg...]>          Target packages or tag e.g. v1.0.0 / plugin-quota@1.0.0
  --dry-run                                Preview commands without mutating npm (default)
  --execute                                Execute actual npm publish / rollback mutations
  --skip-verify                            Skip npm run verify during pack/publish
  --provenance / --no-provenance           Override npm provenance flag
  --mode <local|npm>                       Healthcheck mode (default: local)
  --retries <n>                            Healthcheck retry count for npm propagation
  --retry-delay-ms <ms>                    Delay between healthcheck retries
  --to-version <semver>                    Rollback target version
  --deprecate-version <semver>             Optional bad version to mark deprecated on rollback
  --out-dir <path>                         Output directory for pack tarballs & manifest`);
}

async function main(argv = process.argv.slice(2)) {
  const { cmd, opts } = parseCliArgs(argv);
  if (opts.help) {
    printHelp();
    return;
  }

  const envConfig = resolveEnvironmentConfig(opts.env);
  const resolved = resolveTargets(opts.target, ROOT_DIR);

  if (cmd === 'plan') {
    const consistency = validateReleaseConsistency({
      rootDir: ROOT_DIR,
      packages: resolved.targets,
      expectedVersion: resolved.expectedVersion
    });
    console.log(JSON.stringify({
      ok: consistency.ok,
      env: envConfig,
      targetKind: resolved.kind,
      releaseTag: resolved.tag,
      expectedVersion: resolved.expectedVersion,
      packages: consistency.checked,
      errors: consistency.errors
    }, null, 2));
    if (!consistency.ok) process.exitCode = 1;
    return;
  }

  if (cmd === 'pack') {
    const res = packRelease({
      rootDir: ROOT_DIR,
      targets: resolved.targets,
      envConfig,
      releaseTag: resolved.tag || opts.env,
      outDir: opts.outDir,
      skipVerify: opts.skipVerify
    });
    console.log(JSON.stringify({
      ok: true,
      artifactDir: res.artifactDir,
      manifestPath: res.manifestPath,
      packageCount: res.manifest.packages.length
    }, null, 2));
    return;
  }

  if (cmd === 'publish') {
    const res = publishRelease({
      rootDir: ROOT_DIR,
      targets: resolved.targets,
      expectedVersion: resolved.expectedVersion,
      envConfig,
      dryRun: opts.dryRun,
      provenance: opts.provenance === undefined ? envConfig.provenance : opts.provenance,
      skipVerify: opts.skipVerify
    });
    console.log(JSON.stringify({ ok: true, ...res }, null, 2));
    return;
  }

  if (cmd === 'healthcheck') {
    if (opts.mode === 'local') {
      const res = checkLocalHealth({ rootDir: ROOT_DIR });
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    if (opts.mode === 'npm') {
      const res = await checkNpmHealth({
        packages: resolved.targets,
        envConfig,
        retries: opts.retries,
        retryDelayMs: opts.retryDelayMs
      });
      console.log(JSON.stringify(res, null, 2));
      if (!res.ok) process.exitCode = 1;
      return;
    }
    throw new Error(`Unsupported healthcheck mode "${opts.mode}". Expected local or npm`);
  }

  if (cmd === 'rollback') {
    const plan = buildRollbackPlan({
      packages: resolved.targets,
      toVersion: opts.toVersion,
      deprecateVersion: opts.deprecateVersion,
      envConfig
    });
    const res = executeRollback(plan, { dryRun: opts.dryRun });
    console.log(JSON.stringify({ ok: true, ...plan, ...res }, null, 2));
    return;
  }

  throw new Error(`Unknown command "${cmd}"`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[release] ERROR: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  ENV_MATRIX,
  listPublishablePackages,
  resolveEnvironmentConfig,
  parseReleaseTag,
  resolveTargets,
  validateReleaseConsistency,
  packRelease,
  publishRelease,
  checkNpmHealth,
  checkLocalHealth,
  buildRollbackPlan,
  executeRollback,
  parseCliArgs
};
