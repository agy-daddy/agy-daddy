'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
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

const HOST_ROOT = path.resolve(__dirname, '..');
const BIN_JS = path.join(HOST_ROOT, 'bin', 'agy-daddy.js');
const CLI_JS = path.join(HOST_ROOT, 'src', 'cli.js');

const {
  listVersionManagerNodes,
  listPathNodes,
  listElectronHelpers
} = require('../src/core/runtime-resolver');
const {
  discoverDevToolsPorts,
  inspectAntigravityHostProcess
} = require('../src/core/cdp');
const {
  findAntigravityApp,
  generateLinuxSystemdUnit,
  installAutoStart,
  removeAutoStart,
  planAntigravityRestart,
  relaunchAntigravityWithCdp
} = require('../src/core/lifecycle');
const {
  parsePluginSource,
  installPlugin,
  installOfficialPlugins
} = require('../src/core/installer');

function makeMockFs(existingPaths = [], dirEntries = {}, { caseSensitive = false } = {}) {
  const norm = (p) => {
    const s = String(p).replace(/\\/g, '/');
    return caseSensitive ? s : s.toLowerCase();
  };
  const normSet = new Set(existingPaths.map(norm));
  return {
    existsSync(target) {
      return normSet.has(norm(target));
    },
    readdirSync(target) {
      return dirEntries[norm(target)] || [];
    },
    readFileSync(target) {
      const key = `file:${norm(target)}`;
      if (dirEntries[key] !== undefined) return dirEntries[key];
      throw new Error(`ENOENT: ${target}`);
    }
  };
}

function buildMinimalTarGz(filesMap) {
  const blocks = [];
  for (const [relPath, rawContent] of Object.entries(filesMap)) {
    const data = Buffer.isBuffer(rawContent) ? rawContent : Buffer.from(String(rawContent), 'utf8');
    const name = `package/${relPath}`;
    const header = Buffer.alloc(512, 0);
    header.write(name, 0, Math.min(100, Buffer.byteLength(name)), 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii');
    header.fill(0x20, 148, 156);
    header.write('0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    blocks.push(header);
    if (data.length > 0) {
      const padLen = Math.ceil(data.length / 512) * 512;
      const padded = Buffer.alloc(padLen, 0);
      data.copy(padded);
      blocks.push(padded);
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(blocks));
}

test('package.json bin points to cross-platform bin/agy-daddy.js and executes doctor/help', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(HOST_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.bin['agy-daddy'], './bin/agy-daddy.js');
  assert.ok(fs.existsSync(BIN_JS));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-xplat-bin-'));
  try {
    const env = { ...process.env, AGY_DADDY_TEST_MODE: '1', AGY_DADDY_STATE_DIR: root };
    const docRes = spawnSync(process.execPath, [BIN_JS, 'doctor', '--json'], { env, encoding: 'utf8' });
    assert.equal(docRes.status, 0, docRes.stderr);
    const parsed = JSON.parse(docRes.stdout);
    assert.equal(parsed.ok, true);

    const helpRes = spawnSync(process.execPath, [BIN_JS, '--help'], { env, encoding: 'utf8' });
    assert.equal(helpRes.status, 0, helpRes.stderr);
    assert.match(helpRes.stdout, /plugin install --official/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime-resolver probes Node version managers, PATH, and Antigravity Electron across 3 OSes', () => {
  const winFs = makeMockFs([
    'C:/nvm4w/nodejs/node.exe',
    'C:/Users/Alice/AppData/Roaming/nvm/v22.12.0/node.exe',
    'C:/Users/Alice/AppData/Local/Volta/bin/node.exe',
    'C:/Users/Alice/scoop/apps/nodejs/current/node.exe',
    'C:/Users/Alice/AppData/Local/Programs/Antigravity/Antigravity.exe',
    'C:/Program Files/Google Antigravity/Antigravity.exe'
  ], {
    'c:/users/alice/appdata/roaming/nvm': [{ name: 'v22.12.0', isDirectory: () => true }]
  });
  const winEnv = {
    NVM_SYMLINK: 'C:\\nvm4w\\nodejs',
    NVM_HOME: 'C:\\Users\\Alice\\AppData\\Roaming\\nvm',
    APPDATA: 'C:\\Users\\Alice\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local',
    ProgramFiles: 'C:\\Program Files',
    PATH: 'C:\\nvm4w\\nodejs;C:\\Windows\\System32'
  };

  const winVm = listVersionManagerNodes('C:\\Users\\Alice', winFs, 'win32', winEnv);
  assert.ok(winVm.some((c) => c.source === 'nvm-windows'));
  assert.ok(winVm.some((c) => c.source === 'volta'));
  assert.ok(winVm.some((c) => c.source === 'scoop'));

  const winPath = listPathNodes(winEnv, winFs, 'win32');
  assert.equal(winPath.length, 1);
  assert.match(winPath[0].path, /node\.exe$/i);

  const winElec = listElectronHelpers('C:\\Users\\Alice', 'win32', winFs, winEnv);
  assert.equal(winElec.length, 2);
  assert.ok(winElec.every((e) => e.isElectron === true));

  const linuxFs = makeMockFs([
    '/opt/antigravity/antigravity',
    '/home/alice/.local/share/antigravity/antigravity',
    '/usr/local/bin/node'
  ], {}, { caseSensitive: true });
  const linuxElec = listElectronHelpers('/home/alice', 'linux', linuxFs, {});
  assert.equal(linuxElec.length, 2);
  const linuxPath = listPathNodes({ PATH: '/usr/local/bin:/usr/bin' }, linuxFs, 'linux');
  assert.deepEqual(linuxPath.map((x) => x.path), ['/usr/local/bin/node']);
});

test('cdp discovers ports and inspects Antigravity host process across darwin, linux, and win32', () => {
  const winFs = makeMockFs(
    ['C:/Users/Alice/AppData/Roaming/Antigravity/DevToolsActivePort'],
    { 'file:c:/users/alice/appdata/roaming/antigravity/devtoolsactiveport': '54321\n/devtools/browser/abc\n' }
  );
  const winPorts = discoverDevToolsPorts({
    platform: 'win32',
    homeDir: 'C:\\Users\\Alice',
    env: { APPDATA: 'C:\\Users\\Alice\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local' },
    fs: winFs
  });
  assert.deepEqual(winPorts, [54321]);

  const linuxProc = inspectAntigravityHostProcess({
    platform: 'linux',
    psOutput: [
      '  1001 00:10 /opt/antigravity/antigravity --type=renderer --foo',
      '  1002 01:05 /opt/antigravity/antigravity --remote-debugging-port=0'
    ].join('\n')
  });
  assert.equal(linuxProc.running, true);
  assert.equal(linuxProc.pid, 1002);
  assert.equal(linuxProc.hasDebugSwitch, true);
  assert.equal(linuxProc.elapsedSec, 65);

  const nowMs = 1700000100000;
  const winSingle = inspectAntigravityHostProcess({
    platform: 'win32',
    now: () => nowMs,
    winProcessJson: JSON.stringify([
      {
        ProcessId: 4001,
        CreationDate: `/Date(${nowMs - 40000})/`,
        CommandLine: '"C:\\Program Files\\Antigravity\\Antigravity.exe" --type=gpu-process'
      },
      {
        ProcessId: 4002,
        CreationDate: `/Date(${nowMs - 15000})/`,
        CommandLine: '"C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe" --remote-debugging-port=0'
      }
    ])
  });
  assert.equal(winSingle.running, true);
  assert.equal(winSingle.pid, 4002);
  assert.equal(winSingle.hasDebugSwitch, true);
  assert.equal(winSingle.elapsedSec, 15);
});

test('lifecycle findAntigravityApp, systemd unit, autostart roundtrip, and relaunch across 3 OSes', async () => {
  const winExe = findAntigravityApp({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local' },
    fs: makeMockFs(['C:/Users/Alice/AppData/Local/Programs/Antigravity/Antigravity.exe'])
  });
  assert.match(winExe, /Antigravity\.exe$/);

  const sysd = generateLinuxSystemdUnit({ runtimePath: '/usr/bin/node', isElectron: true });
  assert.match(sysd, /bin[\\/]agy-daddy\.js" "live"/);
  assert.match(sysd, /Environment=ELECTRON_RUN_AS_NODE=1/);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-xplat-life-'));
  try {
    for (const plat of ['darwin', 'win32', 'linux']) {
      const dir = path.join(tmp, plat);
      const inst = installAutoStart({ platform: plat, targetDir: dir, username: 'tester', logDir: path.join(dir, 'logs') });
      assert.equal(inst.ok, true);
      assert.ok(fs.existsSync(inst.filePath));
      const rem = removeAutoStart({ platform: plat, targetDir: dir, username: 'tester' });
      assert.equal(rem.ok, true);
      assert.equal(rem.removed, true);
      assert.equal(fs.existsSync(inst.filePath), false);
    }

    const winPlan = planAntigravityRestart({
      platform: 'win32',
      env: {},
      appPath: 'C:\\Antigravity\\Antigravity.exe',
      extraArgs: ['--remote-debugging-port=0', '--proxy-server=http://127.0.0.1:18766']
    });
    assert.equal(winPlan.ok, true);
    assert.equal(winPlan.executable, 'C:\\Antigravity\\Antigravity.exe');
    assert.deepEqual(winPlan.args, ['--remote-debugging-port=0', '--proxy-server=http://127.0.0.1:18766']);

    let alive = true;
    let quitCalled = 0;
    let launched = null;
    const winRelaunch = await relaunchAntigravityWithCdp({
      platform: 'win32',
      env: {},
      appPath: 'C:\\Antigravity\\Antigravity.exe',
      stateDir: path.join(tmp, 'win-relaunch'),
      pollIntervalMs: 5,
      quitTimeoutMs: 200,
      waitCdpTimeoutMs: 200,
      inspectHostProcess: () => ({ running: true, pid: 8888, hasDebugSwitch: false }),
      gracefulQuit: () => { quitCalled++; alive = false; },
      isPidAliveFn: () => alive,
      launchApp: (exe, args) => { launched = { exe, args }; return { status: 0 }; },
      resolveCdpTarget: async () => ({ port: 51234, targets: [{ id: 'p1', url: 'https://127.0.0.1:51410/' }] })
    });
    assert.equal(winRelaunch.ok, true);
    assert.equal(winRelaunch.relaunched, true);
    assert.equal(quitCalled, 1);
    assert.equal(launched.exe, 'C:\\Antigravity\\Antigravity.exe');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('installer supports Windows local paths, npm dist-tags, and plugin install --official', async () => {
  const winParsed = parsePluginSource('C:\\plugins\\my-plugin');
  assert.equal(winParsed.kind, 'local');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-xplat-inst-'));
  const tgz = buildMinimalTarGz({
    'package.json': JSON.stringify({ name: '@agy-daddy/plugin-alpha', version: '1.2.3' }),
    'agy-plugin.json': JSON.stringify({
      schemaVersion: 1,
      id: 'agy-daddy.alpha',
      publisher: 'agy-daddy',
      version: '1.2.3',
      displayName: 'Alpha',
      engines: { agyDaddy: '^1.0.0' },
      world: 'isolated',
      renderer: './src/renderer.js'
    }),
    'src/renderer.js': 'exports.mount = () => {}; exports.dispose = () => {};\n'
  });
  const sha = `sha512-${crypto.createHash('sha512').update(tgz).digest('base64')}`;

  const server = http.createServer((req, res) => {
    const reqPath = decodeURIComponent(req.url.split('?')[0]);
    if (reqPath === '/@agy-daddy/plugin-alpha') {
      const addr = server.address();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        name: '@agy-daddy/plugin-alpha',
        'dist-tags': { latest: '1.2.0', next: '1.2.3' },
        versions: {
          '1.2.0': { dist: { tarball: `http://127.0.0.1:${addr.port}/alpha-1.2.0.tgz`, integrity: sha } },
          '1.2.3': { dist: { tarball: `http://127.0.0.1:${addr.port}/alpha-1.2.3.tgz`, integrity: sha } }
        }
      }));
      return;
    }
    if (reqPath === '/alpha-1.2.3.tgz' || reqPath === '/alpha-1.2.0.tgz') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(tgz);
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const stateDir = path.join(tmp, 'state');
    const pluginsDir = path.join(tmp, 'plugins');

    const nextRes = await installPlugin('npm:@agy-daddy/plugin-alpha@next', {
      stateDir,
      pluginsDir,
      npmRegistryUrl: baseUrl
    });
    assert.equal(nextRes.ok, true);
    assert.equal(nextRes.plugin.sourceSpec, 'npm:@agy-daddy/plugin-alpha@next');

    const batchRes = await installOfficialPlugins({
      stateDir,
      pluginsDir,
      npmRegistryUrl: baseUrl,
      tag: 'next',
      registry: {
        schemaVersion: 1,
        plugins: [
          { id: 'agy-daddy.alpha', trustLevel: 'T0', npmPackage: '@agy-daddy/plugin-alpha' }
        ]
      }
    });
    assert.equal(batchRes.ok, true);
    assert.equal(batchRes.installedCount, 1);
    assert.equal(batchRes.failedCount, 0);

    // Also smoke-check CLI invocation for `plugin install --official` with custom registry
    const cliRes = await runAsync(
      process.execPath,
      [CLI_JS, 'plugin', 'install', '--official', '--tag', 'next', '--registry', baseUrl],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          AGY_DADDY_TEST_MODE: '1',
          AGY_DADDY_STATE_DIR: path.join(tmp, 'cli-state'),
          AGY_DADDY_PLUGINS_DIR: path.join(tmp, 'cli-plugins'),
          AGY_DADDY_NPM_REGISTRY: baseUrl
        }
      }
    );
    // Uses default registry (10 plugins against mock server returning 404 -> ok:false, exit 1)
    assert.equal(cliRes.status, 1);
    const parsedCli = JSON.parse(cliRes.stdout);
    assert.equal(parsedCli.ok, false);
    assert.equal(parsedCli.total, 10);
    assert.equal(parsedCli.failedCount, 10);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
