'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createTarGzBuffer, extractTarGzToDir } = require('../src/core/tar');
const {
  parsePluginSource,
  installPlugin,
  linkPlugin,
  enablePlugin,
  disablePlugin,
  rollbackPlugin,
  uninstallPlugin,
  listInstalledPlugins
} = require('../src/core/installer');
const { runDoctor, exportDiagnosticBundle } = require('../src/core/doctor');

const HOST_ROOT = path.resolve(__dirname, '..');

test('ustar tar.gz 解包与路径穿越拦截', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-tar-'));
  try {
    const tgz = createTarGzBuffer({ 'agy-plugin.json': '{"ok":true}', 'src/index.js': 'module.exports={}' });
    const outDir = path.join(tmp, 'out');
    const res = extractTarGzToDir(tgz, outDir, { strip: 1 });
    assert.equal(res.extracted, 2);
    assert.equal(fs.existsSync(path.join(outDir, 'src', 'index.js')), true);

    const evilTgz = createTarGzBuffer({ '../../evil.txt': 'pwned' }, 'pkg');
    assert.throws(() => extractTarGzToDir(evilTgz, outDir, { strip: 1 }), /Unsafe path traversal/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('安装器：local 软链、git 锁定 SHA 升级与回滚、npm sha512 校验安装', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-inst-'));
  const stateDir = path.join(tmp, 'state');
  const pluginsDir = path.join(tmp, 'plugins');
  const gitOriginDir = path.join(tmp, 'git-demo-plugin');

  const manifestObj = {
    schemaVersion: 1,
    id: 'third.gitdemo',
    publisher: 'third',
    version: '1.0.0',
    displayName: 'Git Demo',
    engines: { agyDaddy: '^1.0.0' },
    main: './index.js',
    permissions: ['bridge:route']
  };

  let npmServer = null;
  try {
    // 1. local 软链安装与启停卸载
    const localTemplate = path.join(HOST_ROOT, 'templates', 'plugin-template');
    const linked = await linkPlugin(localTemplate, {
      stateDir,
      pluginsDir,
      grantedPermissions: ['dom:write', 'bridge:route']
    });
    assert.equal(linked.plugin.sourceKind, 'local');
    assert.equal(fs.lstatSync(linked.plugin.installPath).isSymbolicLink(), true);
    disablePlugin('example.hello', { stateDir });
    assert.equal(listInstalledPlugins({ stateDir })[0].enabled, false);
    enablePlugin('example.hello', { stateDir });
    assert.equal(listInstalledPlugins({ stateDir })[0].enabled, true);
    uninstallPlugin('example.hello', { stateDir, pluginsDir });
    assert.equal(listInstalledPlugins({ stateDir }).length, 0);

    // 2. 本地临时 Git 仓库安装、升级与回滚
    fs.mkdirSync(gitOriginDir, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: gitOriginDir });
    execFileSync('git', ['config', 'user.email', 'test@agy-daddy.local'], { cwd: gitOriginDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: gitOriginDir });
    fs.writeFileSync(path.join(gitOriginDir, 'agy-plugin.json'), JSON.stringify(manifestObj, null, 2));
    fs.writeFileSync(path.join(gitOriginDir, 'index.js'), 'module.exports={activate(){}};');
    execFileSync('git', ['add', '.'], { cwd: gitOriginDir });
    execFileSync('git', ['commit', '-m', 'v1.0.0'], { cwd: gitOriginDir });
    const shaV1 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gitOriginDir, encoding: 'utf8' }).trim();

    const r1 = await installPlugin(`git:file://${gitOriginDir}#main`, {
      stateDir,
      pluginsDir,
      trustLevel: 'T2',
      grantedPermissions: ['bridge:route']
    });
    assert.equal(r1.plugin.version, '1.0.0');
    assert.equal(r1.plugin.commitSha, shaV1);

    // 提交 v1.1.0 并升级
    fs.writeFileSync(path.join(gitOriginDir, 'agy-plugin.json'), JSON.stringify({ ...manifestObj, version: '1.1.0' }, null, 2));
    execFileSync('git', ['add', '.'], { cwd: gitOriginDir });
    execFileSync('git', ['commit', '-m', 'v1.1.0'], { cwd: gitOriginDir });
    const r2 = await installPlugin(`git:file://${gitOriginDir}#main`, {
      stateDir,
      pluginsDir,
      trustLevel: 'T2',
      grantedPermissions: ['bridge:route']
    });
    assert.equal(r2.plugin.version, '1.1.0');

    // 回滚到 v1.0.0
    const rb = rollbackPlugin('third.gitdemo', { stateDir, pluginsDir });
    assert.equal(rb.plugin.version, '1.0.0');
    assert.equal(rb.plugin.commitSha, shaV1);

    // 3. 本地 Mock npm registry tarball 安装与 sha512 完整性校验
    const npmManifest = { ...manifestObj, id: 'third.npmdemo', version: '2.0.0' };
    const tgz = createTarGzBuffer({
      'package.json': JSON.stringify({ name: '@third/npm-demo', version: '2.0.0' }),
      'agy-plugin.json': JSON.stringify(npmManifest),
      'index.js': 'module.exports={activate(){}};'
    });
    const sha512 = 'sha512-' + crypto.createHash('sha512').update(tgz).digest('base64');

    npmServer = http.createServer((req, res) => {
      if (req.url === '/@third%2Fnpm-demo' || req.url === '/%40third%2Fnpm-demo' || req.url === '/@third/npm-demo') {
        const port = npmServer.address().port;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          name: '@third/npm-demo',
          versions: {
            '2.0.0': {
              dist: {
                tarball: `http://127.0.0.1:${port}/tarball.tgz`,
                integrity: sha512
              }
            }
          }
        }));
      } else if (req.url === '/tarball.tgz') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(tgz);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((resolve) => npmServer.listen(0, '127.0.0.1', resolve));
    const npmPort = npmServer.address().port;

    const npmInstalled = await installPlugin('npm:@third/npm-demo@^2.0.0', {
      stateDir,
      pluginsDir,
      npmRegistryUrl: `http://127.0.0.1:${npmPort}`,
      trustLevel: 'T2',
      grantedPermissions: ['bridge:route']
    });
    assert.equal(npmInstalled.plugin.id, 'third.npmdemo');
    assert.equal(npmInstalled.plugin.version, '2.0.0');
    assert.equal(npmInstalled.plugin.npmIntegrity, sha512);
  } finally {
    if (npmServer) await new Promise((resolve) => npmServer.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('安装器：Monorepo subpath 安装、升级、回滚与路径穿越拦截', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-subpath-'));
  const stateDir = path.join(tmp, 'state');
  const pluginsDir = path.join(tmp, 'plugins');
  const monoOriginDir = path.join(tmp, 'mono-origin');
  const pluginRelDir = 'agy-daddy-plugin-subdemo';

  const manifestObj = {
    schemaVersion: 1,
    id: 'third.subdemo',
    publisher: 'third',
    version: '1.0.0',
    displayName: 'Subpath Demo',
    engines: { agyDaddy: '^1.0.0' },
    main: './index.js',
    permissions: ['bridge:route']
  };

  try {
    const ghParsed = parsePluginSource('github:agy-daddy/agy-daddy#main:agy-daddy-plugin-proxy');
    assert.equal(ghParsed.kind, 'git');
    assert.equal(ghParsed.url, 'https://github.com/agy-daddy/agy-daddy.git');
    assert.equal(ghParsed.ref, 'main');
    assert.equal(ghParsed.subpath, 'agy-daddy-plugin-proxy');
    assert.equal(ghParsed.trustLevel, 'T0');

    const regParsed = parsePluginSource('proxy');
    assert.equal(regParsed.kind, 'git');
    assert.equal(regParsed.url, 'https://github.com/agy-daddy/agy-daddy.git');
    assert.equal(regParsed.subpath, 'agy-daddy-plugin-proxy');

    fs.mkdirSync(path.join(monoOriginDir, pluginRelDir), { recursive: true });
    fs.mkdirSync(path.join(monoOriginDir, 'other-plugin'), { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: monoOriginDir });
    execFileSync('git', ['config', 'user.email', 'test@agy-daddy.local'], { cwd: monoOriginDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: monoOriginDir });
    fs.writeFileSync(path.join(monoOriginDir, 'README.md'), '# Monorepo Root\n');
    fs.writeFileSync(path.join(monoOriginDir, 'other-plugin', 'junk.txt'), 'should not copy\n');
    fs.writeFileSync(path.join(monoOriginDir, pluginRelDir, 'agy-plugin.json'), JSON.stringify(manifestObj, null, 2));
    fs.writeFileSync(path.join(monoOriginDir, pluginRelDir, 'index.js'), 'module.exports={activate(){}};');
    execFileSync('git', ['add', '.'], { cwd: monoOriginDir });
    execFileSync('git', ['commit', '-m', 'v1.0.0'], { cwd: monoOriginDir });
    const shaV1 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: monoOriginDir, encoding: 'utf8' }).trim();

    const spec = `git:file://${monoOriginDir}#main:${pluginRelDir}`;
    const r1 = await installPlugin(spec, {
      stateDir,
      pluginsDir,
      trustLevel: 'T2',
      grantedPermissions: ['bridge:route']
    });
    assert.equal(r1.plugin.version, '1.0.0');
    assert.equal(r1.plugin.commitSha, shaV1);
    assert.equal(r1.plugin.subpath, pluginRelDir);
    assert.equal(fs.existsSync(path.join(r1.plugin.installPath, 'agy-plugin.json')), true);
    assert.equal(fs.existsSync(path.join(r1.plugin.installPath, 'index.js')), true);
    assert.equal(fs.existsSync(path.join(r1.plugin.installPath, 'README.md')), false);
    assert.equal(fs.existsSync(path.join(r1.plugin.installPath, 'other-plugin')), false);

    fs.writeFileSync(
      path.join(monoOriginDir, pluginRelDir, 'agy-plugin.json'),
      JSON.stringify({ ...manifestObj, version: '1.1.0' }, null, 2)
    );
    execFileSync('git', ['add', '.'], { cwd: monoOriginDir });
    execFileSync('git', ['commit', '-m', 'v1.1.0'], { cwd: monoOriginDir });

    const r2 = await installPlugin(spec, {
      stateDir,
      pluginsDir,
      trustLevel: 'T2',
      grantedPermissions: ['bridge:route']
    });
    assert.equal(r2.plugin.version, '1.1.0');
    assert.equal(r2.plugin.subpath, pluginRelDir);

    const rb = rollbackPlugin('third.subdemo', { stateDir, pluginsDir });
    assert.equal(rb.plugin.version, '1.0.0');
    assert.equal(rb.plugin.commitSha, shaV1);

    await assert.rejects(
      () => installPlugin(`git:file://${monoOriginDir}#main:../escape`, { stateDir, pluginsDir }),
      /Invalid plugin subpath/
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('已彻底移除 legacy-suite 注册表项，且 doctor 返回 15 锚点并导出完整脱敏诊断包', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-doctor-clean-'));
  try {
    assert.equal(fs.existsSync(path.join(HOST_ROOT, 'plugins', 'legacy-suite')), false);
    assert.throws(() => parsePluginSource('legacy-suite'), /Unknown plugin source/);

    // doctor 与脱敏导出校验
    const bundlePath = path.join(tmp, 'diag-bundle.json');
    const secretVal = 'super_secret_token_9876543210abcdef';
    const docReport = await runDoctor({ stateDir: tmp, pluginsDir: path.join(tmp, 'plugins'), skipCdp: true });
    assert.equal(docReport.ok, true);
    assert.equal(docReport.anchors.count, 15);
    assert.equal(docReport.legacySuite, undefined);
    assert.equal(docReport.migration, undefined);

    const exp = await exportDiagnosticBundle(bundlePath, {
      stateDir: tmp,
      pluginsDir: path.join(tmp, 'plugins'),
      skipCdp: true,
      extraSecrets: [secretVal]
    });
    assert.equal(exp.ok, true);
    assert.equal(exp.path, bundlePath);
    assert.ok(exp.report && exp.report.anchors.count === 15);
    const writtenText = fs.readFileSync(bundlePath, 'utf8');
    const userHome = os.homedir();
    assert.equal(writtenText.includes(userHome), false, 'Diagnostic bundle leaked homedir');
    assert.equal(writtenText.includes(secretVal), false, 'Diagnostic bundle leaked secret');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('注册表 ref 克隆优先命中指定 tag，远端尚无 tag 时自动回退默认分支', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-reg-ref-'));
  const originDir = path.join(tmp, 'origin');
  const stateDir = path.join(tmp, 'state');
  const pluginsDir = path.join(tmp, 'plugins');
  const regPath = path.join(tmp, 'registry.json');
  fs.mkdirSync(originDir, { recursive: true });

  const manifestObj = {
    schemaVersion: 1,
    id: 'third.refdemo',
    publisher: 'third',
    version: '0.1.0',
    displayName: 'Ref Demo',
    engines: { agyDaddy: '^1.0.0' },
    main: './index.js',
    permissions: ['dom:read']
  };

  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: originDir });
    execFileSync('git', ['config', 'user.email', 'test@agy-daddy.local'], { cwd: originDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: originDir });
    fs.writeFileSync(path.join(originDir, 'agy-plugin.json'), JSON.stringify(manifestObj, null, 2));
    fs.writeFileSync(path.join(originDir, 'index.js'), 'module.exports={activate(){}};');
    execFileSync('git', ['add', '.'], { cwd: originDir });
    execFileSync('git', ['commit', '-m', 'v0.1.0'], { cwd: originDir });

    fs.writeFileSync(regPath, JSON.stringify({
      schemaVersion: 1,
      organization: 'agy-daddy',
      plugins: [
        {
          id: 'third.refdemo',
          shortName: 'refdemo',
          trustLevel: 'T1',
          external: true,
          repo: `file://${originDir}`,
          ref: 'v0.1.0'
        }
      ]
    }, null, 2));

    const parsed = parsePluginSource('refdemo', { registryPath: regPath });
    assert.equal(parsed.ref, 'v0.1.0');

    // 1. 远端尚无 v0.1.0 tag 时应自动回退默认分支克隆
    const resFallback = await installPlugin('refdemo', {
      stateDir,
      pluginsDir,
      registryPath: regPath
    });
    assert.equal(resFallback.ok, true);
    assert.equal(resFallback.plugin.version, '0.1.0');

    // 2. 创建 v0.1.0 tag 后再提交 v0.2.0 到 main，克隆应锁定 v0.1.0 tag
    execFileSync('git', ['tag', 'v0.1.0'], { cwd: originDir });
    fs.writeFileSync(
      path.join(originDir, 'agy-plugin.json'),
      JSON.stringify({ ...manifestObj, version: '0.2.0' }, null, 2)
    );
    execFileSync('git', ['add', '.'], { cwd: originDir });
    execFileSync('git', ['commit', '-m', 'v0.2.0'], { cwd: originDir });

    const resTagged = await installPlugin('refdemo', {
      stateDir,
      pluginsDir,
      registryPath: regPath
    });
    assert.equal(resTagged.ok, true);
    assert.equal(resTagged.plugin.version, '0.1.0');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
