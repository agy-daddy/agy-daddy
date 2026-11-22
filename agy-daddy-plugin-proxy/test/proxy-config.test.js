'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULT_GATEWAY_PORT,
  DEFAULT_NO_PROXY,
  normalizeProxyUrl,
  redactProxyUrl,
  normalizeBypassListForCompare,
  parseAndValidateProxyUrl,
  matchesNoProxy,
  getProxyCandidatePaths,
  detectProxyConfig,
  applyProxyEnvironment,
  buildCliProxyEnv,
  detectLoginShellProxyConflict,
  generateLaunchAgentPlist
} = require('../src/proxy-config');

test('parseAndValidateProxyUrl 与 normalizeProxyUrl / redactProxyUrl', () => {
  assert.equal(normalizeProxyUrl(' http://127.0.0.1:7897/ '), 'http://127.0.0.1:7897');
  assert.equal(redactProxyUrl('socks5h://alice:s3cr3t@127.0.0.1:7890'), 'socks5h://alice:***@127.0.0.1:7890');

  const httpDefault = parseAndValidateProxyUrl('http://proxy.local');
  assert.equal(httpDefault.ok, true);
  assert.equal(httpDefault.port, 80);

  const httpsDefault = parseAndValidateProxyUrl('https://proxy.local');
  assert.equal(httpsDefault.ok, true);
  assert.equal(httpsDefault.port, 443);

  const socksDefault = parseAndValidateProxyUrl('socks5h://u%201:p%402@127.0.0.1');
  assert.equal(socksDefault.ok, true);
  assert.equal(socksDefault.port, 1080);
  assert.equal(socksDefault.isSocks, true);
  assert.equal(socksDefault.username, 'u 1');
  assert.equal(socksDefault.password, 'p@2');

  assert.equal(parseAndValidateProxyUrl('').ok, false);
  assert.equal(parseAndValidateProxyUrl('ftp://127.0.0.1:21').ok, false);
  assert.equal(parseAndValidateProxyUrl('http://127.0.0.1:99999').ok, false);
});

test('matchesNoProxy 支持 CIDR、通配符、域名后缀与 <local>/<-loopback>', () => {
  const list = DEFAULT_NO_PROXY + ',*.internal.corp, .corp.example:8080';
  assert.equal(matchesNoProxy('localhost', list), true);
  assert.equal(matchesNoProxy('127.0.0.1', list), true);
  assert.equal(matchesNoProxy('127.0.5.9', list), true);
  assert.equal(matchesNoProxy('10.23.45.6', list), true);
  assert.equal(matchesNoProxy('192.168.1.50', list), true);
  assert.equal(matchesNoProxy('172.16.0.1', list), true);
  assert.equal(matchesNoProxy('intranet', list), true);
  assert.equal(matchesNoProxy('api.internal.corp', list), true);
  assert.equal(matchesNoProxy('git.corp.example', list), true);
  assert.equal(matchesNoProxy('generativelanguage.googleapis.com', list), false);
  assert.equal(normalizeBypassListForCompare('localhost; <local>, 127.0.0.1'), 'localhost,<-loopback>,127.0.0.1');
});

test('detectProxyConfig 统一配置探测、enabled:false 与损坏 fail-closed', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-proxy-cfg-'));
  try {
    for (const c of getProxyCandidatePaths()) {
      assert.ok(path.isAbsolute(c));
    }

    const cfgPath = path.join(tmp, 'proxy.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      enabled: true,
      httpProxy: 'http://127.0.0.1:7890',
      allProxy: 'socks5://127.0.0.1:7890',
      noProxy: 'localhost,127.0.0.1'
    }));

    const det = detectProxyConfig({ candidates: [cfgPath] });
    assert.equal(det.enabled, true);
    assert.equal(det.httpProxy, 'http://127.0.0.1:7890');
    assert.equal(det.allProxy, 'socks5://127.0.0.1:7890');

    const env = { HTTP_PROXY: 'http://existing:8080' };
    applyProxyEnvironment(env, { candidates: [cfgPath] });
    assert.equal(env.HTTP_PROXY, 'http://existing:8080');
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890');

    const cliEnv = buildCliProxyEnv({ ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1' }, { candidates: [cfgPath] });
    assert.equal(cliEnv.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(cliEnv.HTTPS_PROXY, 'http://127.0.0.1:7890');
    assert.equal(cliEnv.TERM, 'xterm-256color');

    // modules.json 损坏必须 fail-closed
    const modPath = path.join(tmp, 'modules.json');
    fs.writeFileSync(modPath, '{corrupted json');
    const modDet = detectProxyConfig({ candidates: [modPath, cfgPath] });
    assert.equal(modDet.enabled, false);
    assert.ok(modDet.parseError);

    // disabled modules.json 阻止回落旧 proxy.json
    fs.writeFileSync(modPath, JSON.stringify({ modules: { proxy: { enabled: false, httpProxy: 'http://127.0.0.1:9999' } } }));
    const disDet = detectProxyConfig({ candidates: [modPath, cfgPath] });
    assert.equal(disDet.enabled, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('detectLoginShellProxyConflict 与 generateLaunchAgentPlist', () => {
  const conflictRes = detectLoginShellProxyConflict({
    envOutput: 'HOME=/Users/demo\nHTTP_PROXY=http://u:secret@127.0.0.1:7890\nhttps_proxy=socks5://127.0.0.1:7891\nPATH=/usr/bin'
  });
  assert.equal(conflictRes.checked, true);
  assert.equal(conflictRes.hasConflict, true);
  assert.equal(conflictRes.conflictingVars.length, 2);
  assert.equal(conflictRes.conflictingVars[0].value, 'http://u:***@127.0.0.1:7890');

  const cleanRes = detectLoginShellProxyConflict({ envOutput: 'HOME=/Users/demo\nPATH=/usr/bin' });
  assert.equal(cleanRes.hasConflict, false);

  const plist = generateLaunchAgentPlist({
    nodePath: '/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper',
    isElectron: true,
    port: DEFAULT_GATEWAY_PORT
  });
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<string>18766<\/string>/);
  assert.match(plist, /ELECTRON_RUN_AS_NODE/);
});
