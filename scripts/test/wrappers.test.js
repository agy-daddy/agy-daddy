'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const BUILD = path.join(ROOT, 'scripts', 'build-wrappers.js');
const WINDOWS = process.platform === 'win32';
const APP = 'Agy-Daddy Launcher.app/Contents';
const ASSETS = {
  macos: 'agy-daddy-launcher-macos.zip',
  windows: 'agy-daddy-launcher-windows.zip',
  linux: 'agy-daddy-launcher-linux.tar.gz'
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    ...options
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function buildAndExtract(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy wrappers '));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const out = path.join(tmp, 'artifacts');
  run(process.execPath, [BUILD, '--out-dir', out, '--tag', 'next']);

  const extracted = {};
  for (const [platform, name] of Object.entries(ASSETS)) {
    const dir = path.join(tmp, platform);
    fs.mkdirSync(dir);
    const source = path.join(out, name);
    if (!WINDOWS && name.endsWith('.zip')) {
      run('unzip', ['-q', source, '-d', dir]);
    } else {
      run(WINDOWS ? 'tar.exe' : 'tar', ['-xf', source, '-C', dir]);
    }
    extracted[platform] = dir;
  }
  return { tmp, out, ...extracted };
}

function assertFiles(dir, names) {
  for (const name of names) assert.ok(fs.statSync(path.join(dir, name)).isFile(), name);
}

function assertShellFiles(dir, names) {
  assertFiles(dir, names);
  if (WINDOWS) return;
  for (const name of names) {
    const file = path.join(dir, name);
    assert.equal(fs.statSync(file).mode & 0o111, 0o111, name);
    run('/bin/bash', ['-n', file]);
  }
}

function verifyPowerShell(dir, names) {
  const shell = WINDOWS ? 'powershell.exe' : 'pwsh';
  if (!WINDOWS && spawnSync(shell, ['--version'], { encoding: 'utf8' }).error?.code === 'ENOENT') return;
  for (const name of names) {
    const file = path.join(dir, name).replace(/'/g, "''");
    run(shell, [
      '-NoProfile', '-Command',
      `$tokens = $null; $errorsFound = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$tokens, [ref]$errorsFound); if ($errorsFound) { throw ($errorsFound -join [Environment]::NewLine) }`
    ]);
  }
}

test('builds all wrapper archives with valid checksums, contents and entry points', (t) => {
  const { out, macos, windows, linux } = buildAndExtract(t);
  const sums = 'agy-daddy-wrappers-sha256sums.txt';
  const filenames = Object.values(ASSETS);
  assert.deepEqual(fs.readdirSync(out).sort(), [...filenames, sums].sort());
  const checksums = filenames.map((name) => {
    const hash = createHash('sha256').update(fs.readFileSync(path.join(out, name))).digest('hex');
    return `${hash}  ${name}\n`;
  });
  assert.equal(fs.readFileSync(path.join(out, sums), 'utf8'), checksums.join(''));

  assertFiles(macos, [`${APP}/Info.plist`, `${APP}/Resources/AgyDaddyLauncher.icns`, 'README.txt']);
  assertShellFiles(macos, [`${APP}/MacOS/agy-daddy-launcher`, `${APP}/Resources/launch.sh`,
    `${APP}/Resources/install.sh`, 'Install & Launch.command']);
  const plist = path.join(macos, APP, 'Info.plist');
  assert.match(fs.readFileSync(plist, 'utf8'), /<key>CFBundleExecutable<\/key><string>agy-daddy-launcher<\/string>/);
  if (process.platform === 'darwin') run('plutil', ['-lint', plist]);
  assert.match(fs.readFileSync(path.join(macos, 'README.txt'), 'utf8'), /xattr -cr/);

  const psScripts = ['install-and-launch.ps1', 'install.ps1', 'Create-Desktop-Shortcut.ps1'];
  assertFiles(windows, [...psScripts, 'Agy-Daddy-Launcher.cmd', 'Agy-Daddy-Launcher.vbs',
    'agy-daddy-launcher.ico', 'README.txt']);
  verifyPowerShell(windows, psScripts);
  assert.match(fs.readFileSync(path.join(windows, 'README.txt'), 'utf8'), /SmartScreen/);

  assertFiles(linux, ['agy-daddy-launcher.desktop', 'icon-256.png', 'README.txt']);
  assertShellFiles(linux, ['agy-daddy-launcher.sh', 'install-desktop-entry.sh', 'install.sh']);
});

test('POSIX wrappers install on first launch and reuse the installed CLI', { skip: WINDOWS }, (t) => {
  const { tmp, macos, linux } = buildAndExtract(t);
  const wrappers = [
    {
      entry: path.join(macos, 'Install & Launch.command'),
      installer: path.join(macos, APP, 'Resources', 'install.sh')
    },
    {
      entry: path.join(linux, 'agy-daddy-launcher.sh'),
      installer: path.join(linux, 'install.sh')
    }
  ];
  const binOnPath = path.join(tmp, 'fixture path');
  fs.mkdirSync(binOnPath);
  fs.writeFileSync(path.join(binOnPath, 'agy-daddy'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });

  for (const { entry, installer } of wrappers) {
    const env = {
      ...process.env,
      PATH: `${binOnPath}:/usr/bin:/bin`,
      AGY_DADDY_TAG: '',
      AGY_DADDY_BIN_DIR: path.join(path.dirname(entry), 'test bin'),
      WRAPPER_TEST_TRACE: path.join(path.dirname(entry), 'test-trace')
    };
    fs.writeFileSync(installer, [
      'set -eu',
      'echo "install $*" >> "$WRAPPER_TEST_TRACE"',
      'mkdir -p "$AGY_DADDY_BIN_DIR"',
      'cat > "$AGY_DADDY_BIN_DIR/agy-daddy" <<\'CLI\'',
      '#!/bin/bash',
      'echo "cli $*" >> "$WRAPPER_TEST_TRACE"',
      'CLI',
      'chmod +x "$AGY_DADDY_BIN_DIR/agy-daddy"'
    ].join('\n') + '\n');

    run(entry, [], { env });
    run(entry, [], { env });
    assert.equal(fs.readFileSync(env.WRAPPER_TEST_TRACE, 'utf8'),
      'install --tag next --no-launcher --no-path\ncli launcher\ncli --help\ncli launcher\n');
  }
});

test('Linux desktop installer registers the extracted launcher and icon', { skip: WINDOWS }, (t) => {
  const { tmp, linux } = buildAndExtract(t);
  const env = { ...process.env, XDG_DATA_HOME: path.join(tmp, 'custom data') };
  run(path.join(linux, 'install-desktop-entry.sh'), [], { env });
  const entry = path.join(env.XDG_DATA_HOME, 'applications', 'agy-daddy-launcher.desktop');
  assert.ok(fs.readFileSync(entry, 'utf8').split('\n').includes(`Exec="${linux}/agy-daddy-launcher.sh"`));
  const icon = path.join(env.XDG_DATA_HOME, 'icons', 'hicolor', '256x256', 'apps', 'agy-daddy-launcher.png');
  assert.deepEqual(fs.readFileSync(icon), fs.readFileSync(path.join(linux, 'icon-256.png')));
});

test('Windows wrapper installs on first launch and reuses the installed CLI', { skip: !WINDOWS }, (t) => {
  const { tmp, windows } = buildAndExtract(t);
  const env = {
    ...process.env,
    LOCALAPPDATA: path.join(tmp, 'local data'),
    AGY_DADDY_TAG: '',
    AGY_DADDY_BIN_DIR: path.join(tmp, 'test bin'),
    WRAPPER_TEST_TRACE: path.join(tmp, 'test-trace')
  };
  const fixturePath = path.join(tmp, 'fixture path');
  fs.mkdirSync(fixturePath);
  fs.writeFileSync(path.join(fixturePath, 'agy-daddy.cmd'), '@exit /b 1\r\n');
  env.PATH = `${fixturePath};${process.env.PATH}`;

  fs.writeFileSync(path.join(windows, 'install.ps1'), [
    'param($Tag, [switch]$NoLauncher, [switch]$NoPath)',
    'Add-Content -LiteralPath $env:WRAPPER_TEST_TRACE "install $Tag $NoLauncher $NoPath"',
    'New-Item -ItemType Directory -Path $env:AGY_DADDY_BIN_DIR -Force | Out-Null',
    '@\'',
    '@echo off',
    'echo cli %*>>"%WRAPPER_TEST_TRACE%"',
    'exit /b 0',
    "'@ | Set-Content -LiteralPath (Join-Path $env:AGY_DADDY_BIN_DIR 'agy-daddy.cmd') -Encoding ASCII"
  ].join('\r\n') + '\r\n');
  const options = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(windows, 'install-and-launch.ps1')];
  run('powershell.exe', options, { env });
  run('powershell.exe', [...options, '-Quiet'], { env });
  assertFiles(env.LOCALAPPDATA, ['AgyDaddy/logs/wrapper.log']);
  assert.equal(fs.readFileSync(env.WRAPPER_TEST_TRACE, 'utf8').replace(/\r\n/g, '\n'),
    'install next True True\ncli launcher\ncli --help\ncli launcher\n');
});
