'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const HOST_DIR = path.join(ROOT_DIR, 'agy-daddy-host');
const REGISTRY_DIR = path.join(ROOT_DIR, 'agy-daddy-registry');

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

function listPluginDirs() {
  return fs.readdirSync(ROOT_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('agy-daddy-plugin-'))
    .map((d) => d.name)
    .sort()
    .map((name) => path.join(ROOT_DIR, name));
}

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      results.push(...walkFiles(full));
    } else if (ent.isFile()) {
      results.push(full);
    }
  }
  return results.sort();
}

function runBuild() {
  console.log('=== [build] Building host renderer ===');
  const scriptPath = path.join(HOST_DIR, 'scripts', 'build-renderer.js');
  const res = spawnSync(process.execPath, [scriptPath], {
    cwd: HOST_DIR,
    stdio: 'inherit'
  });
  if (res.status !== 0) {
    throw new Error(`Renderer build failed with exit code ${res.status}`);
  }
}

function runGates() {
  console.log('=== [gates] Running monorepo static & registry gates ===');

  const pluginDirs = listPluginDirs();
  const packageDirs = [ROOT_DIR, HOST_DIR, REGISTRY_DIR, ...pluginDirs];

  // 1. Zero runtime dependencies across all packages
  for (const dir of packageDirs) {
    const pkgPath = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      throw new Error(`Missing package.json: ${pkgPath}`);
    }
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const depKeys = Object.keys(pkg.dependencies || {});
    if (depKeys.length > 0) {
      throw new Error(`Zero runtime dependencies required in ${path.relative(ROOT_DIR, pkgPath) || 'package.json'}, found: ${depKeys.join(', ')}`);
    }
  }
  console.log(`✔ Zero runtime dependencies verified across ${packageDirs.length} packages`);

  // 2. Validate every plugin manifest against host validator
  const { validateManifest } = require(path.join(HOST_DIR, 'src', 'contracts', 'manifest-validator'));
  for (const dir of pluginDirs) {
    const manPath = path.join(dir, 'agy-plugin.json');
    if (!fs.existsSync(manPath)) {
      throw new Error(`Missing agy-plugin.json in ${path.basename(dir)}`);
    }
    const manifest = JSON.parse(fs.readFileSync(manPath, 'utf8'));
    const validation = validateManifest(manifest);
    if (!validation.ok) {
      throw new Error(`Manifest validation failed for ${path.basename(dir)}: ${validation.errors.join('; ')}`);
    }
  }
  console.log(`✔ Manifest schema validated for ${pluginDirs.length} plugins`);

  // 3. Purple theme static gate on all plugin src/ files
  let scannedFiles = 0;
  for (const dir of pluginDirs) {
    const srcFiles = walkFiles(path.join(dir, 'src'));
    for (const file of srcFiles) {
      scannedFiles++;
      const content = fs.readFileSync(file, 'utf8');
      for (const re of FORBIDDEN_THEME_REGEXES) {
        if (re.test(content)) {
          throw new Error(`Purple theme gate violation (${re}) in ${path.relative(ROOT_DIR, file)}`);
        }
      }
    }
  }
  console.log(`✔ Purple theme static gate passed across ${scannedFiles} plugin source files`);

  // 4. Anchors.json byte-identical parity check
  const hostAnchors = fs.readFileSync(path.join(HOST_DIR, 'data', 'anchors.json'));
  const regAnchors = fs.readFileSync(path.join(REGISTRY_DIR, 'anchors.json'));
  if (Buffer.compare(hostAnchors, regAnchors) !== 0) {
    throw new Error('Drift detected: agy-daddy-host/data/anchors.json and agy-daddy-registry/anchors.json are not byte-identical');
  }
  console.log('✔ anchors.json parity verified (host/data == registry)');

  // 5. Verify registry SHA-512 hashes & Antigravity fixture compatibility matrix
  const { verifyRegistryAndMatrix } = require(path.join(REGISTRY_DIR, 'scripts', 'verify-registry'));
  const regResult = verifyRegistryAndMatrix({ workspaceRoot: ROOT_DIR });
  if (!regResult.ok) {
    throw new Error('verifyRegistryAndMatrix() returned non-ok');
  }
  console.log(`✔ Registry SHA-512 (${regResult.pluginsVerified} plugins) & fixture matrix (${regResult.matrix.length} versions) verified`);
}

function runTests() {
  console.log('=== [test] Running all package test suites ===');
  const testDirs = [HOST_DIR, REGISTRY_DIR, ...listPluginDirs()];
  const results = [];

  for (const dir of testDirs) {
    const label = path.basename(dir);
    console.log(`\n--- Testing ${label} ---`);
    const res = spawnSync('npm', ['test'], {
      cwd: dir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, AGY_DADDY_TEST_MODE: '1' }
    });
    const ok = res.status === 0;
    results.push({ label, ok, status: res.status });
    if (!ok) {
      console.error(`✖ ${label} failed with exit code ${res.status}`);
    }
  }

  console.log('\n=== [test] Summary ===');
  for (const r of results) {
    console.log(`${r.ok ? '✔' : '✖'} ${r.label} (exit=${r.status})`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`Total: ${results.length}, Passed: ${results.length - failed.length}, Failed: ${failed.length}`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

function main() {
  const cmd = (process.argv[2] || '').trim();
  try {
    if (cmd === 'build') {
      runBuild();
    } else if (cmd === 'gates') {
      runGates();
    } else if (cmd === 'test') {
      runTests();
    } else if (cmd === 'verify') {
      runBuild();
      runGates();
      runTests();
    } else {
      console.error('Usage: node scripts/monorepo.js <build|gates|test|verify>');
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`[monorepo] ERROR: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
