'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
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

  const remoteDir = path.join(ROOT_DIR, 'agy-daddy-plugin-remote');
  const remoteWebDir = path.join(remoteDir, 'web');
  const remoteWebModules = path.join(remoteWebDir, 'node_modules');
  const remoteDistIndex = path.join(remoteDir, 'dist', 'web', 'index.html');
  if (fs.existsSync(remoteWebModules)) {
    console.log('=== [build] Building agy-daddy-plugin-remote/web ===');
    const webRes = spawnSync('npm', ['run', 'build'], {
      cwd: remoteWebDir,
      stdio: 'inherit',
      shell: process.platform === 'win32'
    });
    if (webRes.status !== 0) {
      throw new Error(`agy-daddy-plugin-remote/web build failed with exit code ${webRes.status}`);
    }
  } else if (!fs.existsSync(remoteDistIndex)) {
    throw new Error('Missing agy-daddy-plugin-remote/dist/web/index.html and web/node_modules');
  }

  const webPluginDir = path.join(ROOT_DIR, 'agy-daddy-plugin-web');
  const webUiDir = path.join(webPluginDir, 'web');
  const webUiModules = path.join(webUiDir, 'node_modules');
  const webDistIndex = path.join(webPluginDir, 'dist', 'web', 'index.html');
  if (fs.existsSync(webUiModules)) {
    console.log('=== [build] Building agy-daddy-plugin-web/web ===');
    const uiRes = spawnSync('npm', ['run', 'build'], {
      cwd: webUiDir,
      stdio: 'inherit',
      shell: process.platform === 'win32'
    });
    if (uiRes.status !== 0) {
      throw new Error(`agy-daddy-plugin-web/web build failed with exit code ${uiRes.status}`);
    }
  } else if (!fs.existsSync(webDistIndex)) {
    throw new Error('Missing agy-daddy-plugin-web/dist/web/index.html and web/node_modules');
  }
}

const FORBIDDEN_HOST_RENDERER_PATTERNS = [
  'FRIENDLY_SETTING_LABELS',
  'inferSchemaFromTab',
  'disposeLegacyGlobals',
  'registerSection',
  '#agy-pulse-context-capsule',
  '#agy-quick-capsule-bar',
  '#agy-prompt-opt-btn',
  '#agy-next-step-ghost',
  '#agy-chat-nav-float',
  '#agy-chat-search-slot',
  '#agy-chat-search-box',
  '#agy-community-chat-search',
  '#agy-file-editor-controls',
  '#agy-inline-file-editor-panel'
];

function runGates() {
  console.log('=== [gates] Running monorepo static & registry gates ===');

  const pluginDirs = listPluginDirs();
  const bundledTemplateDir = path.join(HOST_DIR, 'templates', 'plugin-template');
  const allPluginLikeDirs = fs.existsSync(bundledTemplateDir)
    ? [...pluginDirs, bundledTemplateDir]
    : [...pluginDirs];
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

  // 2. Removed legacy artifacts must not exist
  for (const removedRel of [
    path.join('agy-daddy-host', 'plugins', 'legacy-suite'),
    path.join('agy-daddy-host', 'src', 'core', 'migration.js')
  ]) {
    if (fs.existsSync(path.join(ROOT_DIR, removedRel))) {
      throw new Error(`Legacy artifact must remain deleted: ${removedRel}`);
    }
  }
  console.log('✔ Legacy artifacts absence verified (no legacy-suite / no migration.js)');

  // 3. Validate every plugin manifest, isolated world enforcement, zero page:main-world / migrations & settings.schema.json
  const { validateManifest, validateSettingsSchema } = require(path.join(HOST_DIR, 'src', 'contracts', 'manifest-validator'));
  let schemasValidated = 0;
  for (const dir of allPluginLikeDirs) {
    const relDir = path.relative(ROOT_DIR, dir);
    const manPath = path.join(dir, 'agy-plugin.json');
    if (!fs.existsSync(manPath)) {
      throw new Error(`Missing agy-plugin.json in ${relDir}`);
    }
    const manifest = JSON.parse(fs.readFileSync(manPath, 'utf8'));
    const validation = validateManifest(manifest);
    if (!validation.ok) {
      throw new Error(`Manifest validation failed for ${relDir}: ${validation.errors.join('; ')}`);
    }
    if (manifest.world !== 'isolated') {
      throw new Error(`All plugins must declare world="isolated": ${relDir} has world=${String(manifest.world)}`);
    }
    if ((manifest.permissions || []).includes('page:main-world')) {
      throw new Error(`Forbidden permission "page:main-world" found in ${relDir}`);
    }
    if (manifest.contributes && Object.prototype.hasOwnProperty.call(manifest.contributes, 'migrations')) {
      throw new Error(`Forbidden legacy contribution "migrations" found in ${relDir}`);
    }

    const schemaRel = manifest.contributes?.settings?.schema;
    const defaultSchemaPath = path.join(dir, 'settings.schema.json');
    const schemaPath = schemaRel ? path.resolve(dir, schemaRel) : (fs.existsSync(defaultSchemaPath) ? defaultSchemaPath : null);
    if (schemaPath) {
      if (!fs.existsSync(schemaPath)) {
        throw new Error(`Declared settings schema missing in ${relDir}: ${schemaRel}`);
      }
      const schemaObj = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
      const schemaCheck = validateSettingsSchema(schemaObj);
      if (!schemaCheck.ok) {
        throw new Error(`Settings schema validation failed for ${relDir}: ${schemaCheck.errors.join('; ')}`);
      }
      schemasValidated++;
    }
  }
  console.log(`✔ Manifest, isolated-world & settings.schema.json (${schemasValidated}) validated for ${allPluginLikeDirs.length} plugins/templates`);

  // 4. Purple theme & zero-registerSection static gate on all plugin src/ files (+ plugin-remote/web/src)
  let scannedFiles = 0;
  for (const dir of allPluginLikeDirs) {
    const srcFiles = walkFiles(path.join(dir, 'src'));
    for (const file of srcFiles) {
      scannedFiles++;
      const content = fs.readFileSync(file, 'utf8');
      if (content.includes('registerSection')) {
        throw new Error(`Removed API "registerSection" referenced in ${path.relative(ROOT_DIR, file)}`);
      }
      for (const re of FORBIDDEN_THEME_REGEXES) {
        if (re.test(content)) {
          throw new Error(`Purple theme gate violation (${re}) in ${path.relative(ROOT_DIR, file)}`);
        }
      }
    }
  }
  const remoteWebSrcFiles = walkFiles(path.join(ROOT_DIR, 'agy-daddy-plugin-remote', 'web', 'src'));
  const webUiSrcFiles = walkFiles(path.join(ROOT_DIR, 'agy-daddy-plugin-web', 'web', 'src'));
  for (const file of [...remoteWebSrcFiles, ...webUiSrcFiles]) {
    scannedFiles++;
    const content = fs.readFileSync(file, 'utf8');
    for (const re of FORBIDDEN_THEME_REGEXES) {
      if (re.test(content)) {
        throw new Error(`Purple theme gate violation (${re}) in ${path.relative(ROOT_DIR, file)}`);
      }
    }
  }
  console.log(`✔ Purple theme & zero-registerSection gate passed across ${scannedFiles} plugin source files`);

  // 5. Thin host renderer decoupling & purple theme gate
  const hostRendererFiles = walkFiles(path.join(HOST_DIR, 'src', 'renderer'));
  for (const file of hostRendererFiles) {
    const content = fs.readFileSync(file, 'utf8');
    for (const forbidden of FORBIDDEN_HOST_RENDERER_PATTERNS) {
      if (content.includes(forbidden)) {
        throw new Error(`Host decoupling gate violation ("${forbidden}") in ${path.relative(ROOT_DIR, file)}`);
      }
    }
    for (const re of FORBIDDEN_THEME_REGEXES) {
      if (re.test(content)) {
        throw new Error(`Host purple theme gate violation (${re}) in ${path.relative(ROOT_DIR, file)}`);
      }
    }
  }
  console.log(`✔ Thin host renderer decoupling & theme gate passed across ${hostRendererFiles.length} host renderer files`);

  // 6. Anchors.json byte-identical parity check
  const hostAnchors = fs.readFileSync(path.join(HOST_DIR, 'data', 'anchors.json'));
  const regAnchors = fs.readFileSync(path.join(REGISTRY_DIR, 'anchors.json'));
  if (Buffer.compare(hostAnchors, regAnchors) !== 0) {
    throw new Error('Drift detected: agy-daddy-host/data/anchors.json and agy-daddy-registry/anchors.json are not byte-identical');
  }
  console.log('✔ anchors.json parity verified (host/data == registry)');

  // 7. Verify registry SHA-512 hashes & Antigravity fixture compatibility matrix
  const { verifyRegistryAndMatrix } = require(path.join(REGISTRY_DIR, 'scripts', 'verify-registry'));
  const regResult = verifyRegistryAndMatrix({ workspaceRoot: ROOT_DIR });
  if (!regResult.ok) {
    throw new Error('verifyRegistryAndMatrix() returned non-ok');
  }
  console.log(`✔ Registry SHA-512 (${regResult.pluginsVerified} plugins) & fixture matrix (${regResult.matrix.length} versions × ${regResult.anchorsCount} anchors) verified`);

  // 8. Release packaging compliance gate (public publishConfig, non-empty files whitelist without test/, host prepublishOnly)
  const publishableDirs = [HOST_DIR, ...pluginDirs, REGISTRY_DIR];
  for (const dir of publishableDirs) {
    const rel = path.relative(ROOT_DIR, dir);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (pkg.publishConfig?.access !== 'public') {
      throw new Error(`Missing publishConfig.access="public" in ${rel}/package.json`);
    }
    if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
      throw new Error(`Missing non-empty "files" whitelist in ${rel}/package.json`);
    }
    for (const entry of pkg.files) {
      const norm = String(entry).replace(/^\.\//, '');
      if (norm === 'test' || norm === 'test/' || norm.startsWith('test/') || norm.startsWith('web/src')) {
        throw new Error(`Forbidden dev/test entry "${entry}" in ${rel}/package.json "files"`);
      }
    }
    if (dir === HOST_DIR && !pkg.scripts?.prepublishOnly) {
      throw new Error('agy-daddy-host/package.json must define scripts.prepublishOnly');
    }
  }
  console.log(`✔ Release packaging compliance verified across ${publishableDirs.length} publishable packages`);
}

function formatKb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function runAnalyze() {
  console.log('=== [analyze] Bundle & tarball size analysis ===');
  const JS_GZIP_WARN_BYTES = 250 * 1024;
  const warnings = [];

  const hostBundlePath = path.join(HOST_DIR, 'dist', 'host-renderer.js');
  if (fs.existsSync(hostBundlePath)) {
    const buf = fs.readFileSync(hostBundlePath);
    const gz = zlib.gzipSync(buf).byteLength;
    console.log(`\n[Host Renderer] dist/host-renderer.js: raw=${formatKb(buf.byteLength)}, gzip=${formatKb(gz)}`);
  } else {
    warnings.push('Missing agy-daddy-host/dist/host-renderer.js (run npm run build first)');
  }

  for (const webPluginName of ['agy-daddy-plugin-remote', 'agy-daddy-plugin-web']) {
    const distWebDir = path.join(ROOT_DIR, webPluginName, 'dist', 'web');
    if (!fs.existsSync(distWebDir)) {
      warnings.push(`Missing ${webPluginName}/dist/web`);
      continue;
    }
    const files = walkFiles(distWebDir).map((f) => {
      const buf = fs.readFileSync(f);
      const gz = zlib.gzipSync(buf).byteLength;
      return {
        rel: path.relative(distWebDir, f).split(path.sep).join('/'),
        raw: buf.byteLength,
        gz
      };
    }).sort((a, b) => b.raw - a.raw);

    const totalRaw = files.reduce((s, x) => s + x.raw, 0);
    const totalGz = files.reduce((s, x) => s + x.gz, 0);
    console.log(`\n[Web UI] ${webPluginName}/dist/web (${files.length} files, total raw=${formatKb(totalRaw)}, gzip=${formatKb(totalGz)})`);
    for (const f of files) {
      const flag = f.rel.endsWith('.js') && f.gz > JS_GZIP_WARN_BYTES ? ' [WARN > 250KB gzip]' : '';
      if (flag) warnings.push(`${webPluginName}/${f.rel} gzip (${formatKb(f.gz)}) exceeds 250 KB budget`);
      console.log(`  - ${f.rel.padEnd(44)} raw=${formatKb(f.raw).padStart(9)}  gzip=${formatKb(f.gz).padStart(8)}${flag}`);
    }
  }

  console.log('\n[npm Tarball Dry-Run Summary]');
  const publishableDirs = [HOST_DIR, ...listPluginDirs(), REGISTRY_DIR];
  for (const dir of publishableDirs) {
    const res = spawnSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: dir,
      encoding: 'utf8',
      shell: process.platform === 'win32'
    });
    if (res.status !== 0) {
      throw new Error(`npm pack --dry-run failed in ${path.basename(dir)}: ${res.stderr || res.stdout}`);
    }
    const parsed = JSON.parse(res.stdout);
    const info = Array.isArray(parsed)
      ? parsed[0]
      : (parsed && typeof parsed.name === 'string' ? parsed : Object.values(parsed || {})[0]);
    if (!info) {
      throw new Error(`Unexpected npm pack --dry-run --json output in ${path.basename(dir)}`);
    }
    const leaked = (info.files || [])
      .map((f) => f.path)
      .filter((p) => p.startsWith('test/') || p.startsWith('web/src/'));
    if (leaked.length > 0) {
      throw new Error(`Tarball for ${info.name} leaked forbidden dev/test files: ${leaked.slice(0, 5).join(', ')}`);
    }
    const fileCount = info.entryCount ?? (Array.isArray(info.files) ? info.files.length : 0);
    console.log(
      `  - ${String(info.name).padEnd(28)} v${String(info.version).padEnd(7)} files=${String(fileCount).padStart(3)}  size=${formatKb(info.size).padStart(9)}  unpacked=${formatKb(info.unpackedSize).padStart(9)}`
    );
  }

  if (warnings.length > 0) {
    console.warn('\n[analyze] Warnings:');
    for (const w of warnings) console.warn(`  ! ${w}`);
  }
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

  const scriptsTestDir = path.join(ROOT_DIR, 'scripts', 'test');
  if (fs.existsSync(scriptsTestDir)) {
    const scriptTests = fs.readdirSync(scriptsTestDir).filter((f) => f.endsWith('.test.js')).sort();
    if (scriptTests.length > 0) {
      console.log('\n--- Testing scripts/test ---');
      const res = spawnSync(
        process.execPath,
        ['--test', ...scriptTests.map((f) => path.join(scriptsTestDir, f))],
        {
          cwd: ROOT_DIR,
          stdio: 'inherit',
          env: { ...process.env, AGY_DADDY_TEST_MODE: '1' }
        }
      );
      const ok = res.status === 0;
      results.push({ label: 'scripts/test', ok, status: res.status });
      if (!ok) {
        console.error(`✖ scripts/test failed with exit code ${res.status}`);
      }
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
    } else if (cmd === 'analyze') {
      runAnalyze();
    } else if (cmd === 'verify') {
      runBuild();
      runGates();
      runTests();
    } else {
      console.error('Usage: node scripts/monorepo.js <build|gates|test|analyze|verify>');
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`[monorepo] ERROR: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
