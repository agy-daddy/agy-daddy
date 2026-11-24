'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const {
  listPublishablePackages,
  resolveEnvironmentConfig,
  parseReleaseTag,
  resolveTargets,
  validateReleaseConsistency,
  publishRelease,
  checkNpmHealth,
  buildRollbackPlan,
  executeRollback,
  parseCliArgs
} = require('../release');

test('parseReleaseTag resolves coordinated root tags and package-scoped tags', () => {
  const allRes = parseReleaseTag('v1.0.0', ROOT_DIR);
  assert.equal(allRes.kind, 'all');
  assert.equal(allRes.expectedVersion, '1.0.0');
  assert.equal(allRes.targets.length, 13);

  const rcRes = parseReleaseTag('v1.2.3-rc.1', ROOT_DIR);
  assert.equal(rcRes.kind, 'all');
  assert.equal(rcRes.expectedVersion, '1.2.3-rc.1');

  const hostRes = parseReleaseTag('host@1.0.0', ROOT_DIR);
  assert.equal(hostRes.kind, 'single');
  assert.equal(hostRes.targets.length, 1);
  assert.equal(hostRes.targets[0].name, '@agy-daddy/host');

  const pluginRes = parseReleaseTag('plugin-quota@1.0.0', ROOT_DIR);
  assert.equal(pluginRes.kind, 'single');
  assert.equal(pluginRes.targets[0].name, '@agy-daddy/plugin-quota');

  const regRes = parseReleaseTag('registry@1.0.0', ROOT_DIR);
  assert.equal(regRes.kind, 'single');
  assert.equal(regRes.targets[0].name, '@agy-daddy/registry');

  assert.throws(() => parseReleaseTag('invalid-tag', ROOT_DIR), /Invalid release tag/);
  assert.throws(() => parseReleaseTag('plugin-nonexistent@1.0.0', ROOT_DIR), /does not match/);
});

test('resolveEnvironmentConfig isolates dev / next / latest channels and allows overrides', () => {
  const devCfg = resolveEnvironmentConfig('development');
  assert.equal(devCfg.distTag, 'dev');
  assert.equal(devCfg.provenance, false);

  const stgCfg = resolveEnvironmentConfig('staging');
  assert.equal(stgCfg.distTag, 'next');
  assert.equal(stgCfg.provenance, false);
  assert.equal(stgCfg.authMode, 'oidc');

  const prodCfg = resolveEnvironmentConfig('production');
  assert.equal(prodCfg.distTag, 'latest');
  assert.equal(prodCfg.provenance, false);
  assert.equal(prodCfg.authMode, 'oidc');

  const customCfg = resolveEnvironmentConfig('staging', {
    npmRegistryUrl: 'http://127.0.0.1:4873/',
    distTag: 'canary'
  });
  assert.equal(customCfg.npmRegistryUrl, 'http://127.0.0.1:4873');
  assert.equal(customCfg.distTag, 'canary');

  assert.throws(() => resolveEnvironmentConfig('qa'), /Unsupported release environment/);
});

test('validateReleaseConsistency passes on current monorepo packages and catches version drift', () => {
  const packages = listPublishablePackages(ROOT_DIR);
  assert.equal(packages.length, 13);

  const okRes = validateReleaseConsistency({ rootDir: ROOT_DIR, packages, expectedVersion: '1.0.0' });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.checked.length, 13);

  const driftRes = validateReleaseConsistency({ rootDir: ROOT_DIR, packages, expectedVersion: '9.9.9' });
  assert.equal(driftRes.ok, false);
  assert.equal(driftRes.errors.length, 13);
});

test('publishRelease dry-run emits public access & dist-tag commands without mutating registry', () => {
  const { targets } = resolveTargets('host', ROOT_DIR);
  const envConfig = resolveEnvironmentConfig('production');
  const calls = [];
  const res = publishRelease({
    rootDir: ROOT_DIR,
    targets,
    envConfig,
    dryRun: true,
    execFn: (cmd, args) => {
      calls.push({ cmd, args });
      return { status: 0, stdout: '', stderr: '' };
    }
  });

  assert.equal(res.dryRun, true);
  assert.equal(res.results.length, 1);
  assert.equal(res.results[0].status, 'dry-run');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [
    'publish',
    '--access',
    'public',
    '--tag',
    'latest',
    '--registry',
    'https://registry.npmjs.org',
    '--dry-run'
  ]);
});

test('parseCliArgs and publishRelease support --interactive, --otp, and explicit --provenance', () => {
  const parsed = parseCliArgs(['publish', '--env', 'production', '--execute', '--interactive', '--otp', '123456', '--provenance']);
  assert.equal(parsed.cmd, 'publish');
  assert.equal(parsed.opts.dryRun, false);
  assert.equal(parsed.opts.interactive, true);
  assert.equal(parsed.opts.otp, '123456');
  assert.equal(parsed.opts.provenance, true);

  const { targets } = resolveTargets('host', ROOT_DIR);
  const envConfig = resolveEnvironmentConfig('production');
  const calls = [];
  const res = publishRelease({
    rootDir: ROOT_DIR,
    targets,
    envConfig,
    dryRun: true,
    provenance: parsed.opts.provenance,
    interactive: parsed.opts.interactive,
    otp: parsed.opts.otp,
    execFn: (cmd, args) => {
      calls.push({ cmd, args });
      return { status: 0, stdout: '', stderr: '' };
    }
  });
  assert.equal(res.results[0].status, 'dry-run');
  assert.deepEqual(calls[0].args, [
    'publish',
    '--access',
    'public',
    '--tag',
    'latest',
    '--registry',
    'https://registry.npmjs.org',
    '--provenance',
    '--otp',
    '123456',
    '--dry-run'
  ]);
});

test('buildRollbackPlan and executeRollback generate dist-tag and deprecate commands', () => {
  const { targets } = resolveTargets('plugin-proxy', ROOT_DIR);
  const envConfig = resolveEnvironmentConfig('production');
  const plan = buildRollbackPlan({
    packages: targets,
    toVersion: '1.0.0',
    deprecateVersion: '1.0.1',
    envConfig
  });

  assert.equal(plan.steps.length, 2);
  assert.deepEqual(plan.steps[0].args.slice(0, 4), ['dist-tag', 'add', '@agy-daddy/plugin-proxy@1.0.0', 'latest']);
  assert.equal(plan.steps[1].action, 'deprecate');

  const dryRes = executeRollback(plan, {
    dryRun: true,
    execFn: () => {
      throw new Error('should not execute during dry-run');
    }
  });
  assert.equal(dryRes.executed[0].status, 'dry-run');

  const execCalls = [];
  const execRes = executeRollback(plan, {
    dryRun: false,
    execFn: (cmd, args) => {
      execCalls.push([cmd, ...args]);
      return { status: 0, stdout: '', stderr: '' };
    }
  });
  assert.equal(execRes.executed[0].status, 'executed');
  assert.equal(execCalls.length, 2);
});

test('checkNpmHealth verifies dist-tag and integrity against local mock registry server', async () => {
  let activeTagVersion = '1.0.0';
  const server = http.createServer((req, res) => {
    if (req.url === '/%40agy-daddy%2Fhost' || req.url === '/@agy-daddy%2Fhost') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        name: '@agy-daddy/host',
        'dist-tags': { latest: activeTagVersion },
        versions: {
          '1.0.0': { dist: { integrity: 'sha512-mockintegrity==' } }
        }
      }));
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const { targets } = resolveTargets('host', ROOT_DIR);
    const envConfig = resolveEnvironmentConfig('production', { npmRegistryUrl: baseUrl });

    const okHealth = await checkNpmHealth({
      packages: targets,
      envConfig,
      retries: 1,
      retryDelayMs: 0
    });
    assert.equal(okHealth.ok, true);
    assert.equal(okHealth.checked, 1);

    activeTagVersion = '0.9.9';
    const failHealth = await checkNpmHealth({
      packages: targets,
      envConfig,
      retries: 1,
      retryDelayMs: 0
    });
    assert.equal(failHealth.ok, false);
    assert.equal(failHealth.failures.length, 1);
    assert.match(failHealth.rollbackHints[0], /scripts\/release\.js rollback/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
