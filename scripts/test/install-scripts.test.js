'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

function runAsync(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const HOST_DIR = path.join(ROOT_DIR, 'agy-daddy-host');
const INSTALL_SH = path.join(ROOT_DIR, 'scripts', 'install.sh');
const INSTALL_PS1 = path.join(ROOT_DIR, 'scripts', 'install.ps1');

test('install.sh and install.ps1 exist and pass syntax/contract checks', () => {
  assert.ok(fs.existsSync(INSTALL_SH));
  assert.ok(fs.existsSync(INSTALL_PS1));

  const shText = fs.readFileSync(INSTALL_SH, 'utf8');
  assert.match(shText, /--tag/);
  assert.match(shText, /--registry/);
  assert.match(shText, /--from-tarball/);
  assert.match(shText, /--uninstall/);
  assert.match(shText, /ELECTRON_RUN_AS_NODE/);

  const psText = fs.readFileSync(INSTALL_PS1, 'utf8');
  for (const token of ['-Tag', '-Registry', '-FromTarball', '-Uninstall', '-HostOnly', 'ELECTRON_RUN_AS_NODE']) {
    assert.ok(psText.includes(token), `install.ps1 missing ${token}`);
  }

  if (process.platform !== 'win32') {
    const stat = fs.statSync(INSTALL_SH);
    assert.ok((stat.mode & 0o111) !== 0, 'install.sh should be executable');
    const syntax = spawnSync('bash', ['-n', INSTALL_SH], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
  } else {
    const psExe = spawnSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `$null = [System.Management.Automation.Language.Parser]::ParseFile('${INSTALL_PS1.replace(/'/g, "''")}', [ref]$null, [ref]$errs); if ($errs.Count -gt 0) { $errs | ForEach-Object { Write-Error $_.Message }; exit 1 }`
    ], { encoding: 'utf8', windowsHide: true });
    assert.equal(psExe.status, 0, psExe.stderr);
  }
});

test('one-click install script installs from mock npm registry, verifies sha512, supports offline tarball, and uninstalls cleanly', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-install-e2e-'));
  const packDir = path.join(tmp, 'pack');
  fs.mkdirSync(packDir, { recursive: true });

  const packRes = spawnSync('npm', ['pack', '--pack-destination', packDir, '--json'], {
    cwd: HOST_DIR,
    encoding: 'utf8',
    shell: process.platform === 'win32'
  });
  assert.equal(packRes.status, 0, packRes.stderr || packRes.stdout);
  const packInfo = JSON.parse(packRes.stdout);
  const entry = Array.isArray(packInfo)
    ? packInfo[0]
    : (packInfo && typeof packInfo.filename === 'string' ? packInfo : Object.values(packInfo || {})[0]);
  assert.ok(entry && entry.filename, `Unexpected npm pack --json output: ${packRes.stdout}`);
  const tgzPath = path.join(packDir, entry.filename);
  const tgzBuf = fs.readFileSync(tgzPath);
  const realSha = `sha512-${crypto.createHash('sha512').update(tgzBuf).digest('base64')}`;

  let serveTamperedIntegrity = false;
  const server = http.createServer((req, res) => {
    const reqPath = decodeURIComponent(req.url.split('?')[0]);
    const addr = server.address();
    if (reqPath === '/@agy-daddy/host') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        name: '@agy-daddy/host',
        'dist-tags': { latest: entry.version },
        versions: {
          [entry.version]: {
            dist: {
              tarball: `http://127.0.0.1:${addr.port}/host.tgz`,
              integrity: serveTamperedIntegrity ? 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==' : realSha
            }
          }
        }
      }));
      return;
    }
    if (reqPath === '/host.tgz') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(tgzBuf);
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const registryUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const installDir = path.join(tmp, 'host');
    const binDir = path.join(tmp, 'bin');
    const stateDir = path.join(tmp, 'state');
    const baseEnv = {
      ...process.env,
      AGY_DADDY_TEST_MODE: '1',
      AGY_DADDY_STATE_DIR: stateDir,
      AGY_DADDY_NODE: process.execPath,
      AGY_DADDY_NODE_ELECTRON: '0'
    };

    if (process.platform !== 'win32') {
      // 1. Online install from mock registry
      const okInst = await runAsync(
        'bash',
        [
          INSTALL_SH,
          '--host-only',
          '--no-launcher',
          '--no-path',
          '--registry', registryUrl,
          '--install-dir', installDir,
          '--bin-dir', binDir
        ],
        { env: baseEnv }
      );
      assert.equal(okInst.status, 0, okInst.stderr || okInst.stdout);
      const shim = path.join(binDir, 'agy-daddy');
      assert.ok(fs.existsSync(shim));

      const doctorRes = await runAsync(shim, ['doctor', '--json'], { env: baseEnv });
      assert.equal(doctorRes.status, 0, doctorRes.stderr);
      const docJson = JSON.parse(doctorRes.stdout);
      assert.equal(docJson.ok, true);

      // 2. Tampered integrity must fail
      serveTamperedIntegrity = true;
      const badInst = await runAsync(
        'bash',
        [
          INSTALL_SH,
          '--host-only',
          '--no-launcher',
          '--no-path',
          '--registry', registryUrl,
          '--install-dir', path.join(tmp, 'host-bad'),
          '--bin-dir', path.join(tmp, 'bin-bad')
        ],
        { env: baseEnv }
      );
      assert.notEqual(badInst.status, 0);
      serveTamperedIntegrity = false;

      // 3. Offline --from-tarball install
      const offlineDir = path.join(tmp, 'host-offline');
      const offlineBin = path.join(tmp, 'bin-offline');
      const offlineInst = await runAsync(
        'bash',
        [
          INSTALL_SH,
          '--host-only',
          '--no-launcher',
          '--no-path',
          '--from-tarball', tgzPath,
          '--install-dir', offlineDir,
          '--bin-dir', offlineBin
        ],
        { env: baseEnv }
      );
      assert.equal(offlineInst.status, 0, offlineInst.stderr || offlineInst.stdout);
      assert.ok(fs.existsSync(path.join(offlineBin, 'agy-daddy')));

      // 4. Uninstall
      const uninst = await runAsync(
        'bash',
        [INSTALL_SH, '--uninstall', '--install-dir', installDir, '--bin-dir', binDir],
        { env: baseEnv }
      );
      assert.equal(uninst.status, 0, uninst.stderr || uninst.stdout);
      assert.equal(fs.existsSync(shim), false);
      assert.equal(fs.existsSync(installDir), false);
    } else {
      // Windows PowerShell end-to-end verification
      const okInst = await runAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-File', INSTALL_PS1,
          '-HostOnly', '-NoLauncher', '-NoPath',
          '-Registry', registryUrl,
          '-InstallDir', installDir,
          '-BinDir', binDir
        ],
        { env: baseEnv, windowsHide: true }
      );
      assert.equal(okInst.status, 0, okInst.stderr || okInst.stdout);
      const shim = path.join(binDir, 'agy-daddy.cmd');
      assert.ok(fs.existsSync(shim));

      const doctorRes = await runAsync(shim, ['doctor', '--json'], { env: baseEnv, shell: true, windowsHide: true });
      assert.equal(doctorRes.status, 0, doctorRes.stderr);
      const docJson = JSON.parse(doctorRes.stdout);
      assert.equal(docJson.ok, true);

      serveTamperedIntegrity = true;
      const badInst = await runAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-File', INSTALL_PS1,
          '-HostOnly', '-NoLauncher', '-NoPath',
          '-Registry', registryUrl,
          '-InstallDir', path.join(tmp, 'host-bad'),
          '-BinDir', path.join(tmp, 'bin-bad')
        ],
        { env: baseEnv, windowsHide: true }
      );
      assert.notEqual(badInst.status, 0);
      serveTamperedIntegrity = false;

      const offlineDir = path.join(tmp, 'host-offline');
      const offlineBin = path.join(tmp, 'bin-offline');
      const offlineInst = await runAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-File', INSTALL_PS1,
          '-HostOnly', '-NoLauncher', '-NoPath',
          '-FromTarball', tgzPath,
          '-InstallDir', offlineDir,
          '-BinDir', offlineBin
        ],
        { env: baseEnv, windowsHide: true }
      );
      assert.equal(offlineInst.status, 0, offlineInst.stderr || offlineInst.stdout);
      assert.ok(fs.existsSync(path.join(offlineBin, 'agy-daddy.cmd')));

      const uninst = await runAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-File', INSTALL_PS1,
          '-Uninstall',
          '-InstallDir', installDir,
          '-BinDir', binDir
        ],
        { env: baseEnv, windowsHide: true }
      );
      assert.equal(uninst.status, 0, uninst.stderr || uninst.stdout);
      assert.equal(fs.existsSync(shim), false);
      assert.equal(fs.existsSync(installDir), false);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
