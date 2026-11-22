'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HOST_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = path.resolve(HOST_ROOT, '..');
const { installPlugin, uninstallPlugin } = require('../src/core/installer');
const { getPluginDataDir } = require('../src/core/paths');
const { validateManifest } = require('../src/contracts/manifest-validator');
const { syncPluginNativeArtifacts } = require('../src/core/native-sync');

function callMcpStdioServer(command, args, env, requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const responses = [];
    let outBuf = '';
    let errBuf = '';

    child.stdout.on('data', (chunk) => {
      outBuf += chunk.toString('utf8');
      const lines = outBuf.split('\n');
      outBuf = lines.pop() || '';
      for (const line of lines) {
        const clean = line.trim();
        if (!clean) continue;
        try { responses.push(JSON.parse(clean)); } catch {}
      }
      if (responses.length >= requests.filter((r) => r.id !== undefined).length) {
        child.stdin.end();
      }
    });
    child.stderr.on('data', (c) => { errBuf += c.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && responses.length === 0) {
        reject(new Error(`MCP exited with ${code}: ${errBuf}`));
      } else {
        resolve(responses);
      }
    });

    for (const req of requests) {
      child.stdin.write(JSON.stringify(req) + '\n');
    }
  });
}

test('Phase 5: 原生产物同步权限门禁、3 个真实 stdio MCP Server 工具调用、技能/规则安装与卸载清理', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-phase5-native-'));
  const stateDir = path.join(root, 'state');
  const nativeDir = path.join(root, 'gemini-native-plugins');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(nativeDir, { recursive: true });

  try {
    // 1. native:install 未授权时拒绝同步原生扩展
    const deniedSync = syncPluginNativeArtifacts(
      path.join(WORKSPACE_ROOT, 'agy-daddy-plugin-quota'),
      JSON.parse(fs.readFileSync(path.join(WORKSPACE_ROOT, 'agy-daddy-plugin-quota', 'agy-plugin.json'), 'utf8')),
      { stateDir, nativePluginsDir: nativeDir, grantedPermissions: ['dom:write'] }
    );
    assert.equal(deniedSync.synced, false);
    assert.equal(deniedSync.reason, 'MISSING_NATIVE_INSTALL_PERMISSION');
    assert.equal(fs.readdirSync(nativeDir).length, 0);

    // 2. 安装 quota / usage / context / composer（T0 自动授予 native:install），同步全部原生产物
    const opts = { trustLevel: 'T0', stateDir, nativePluginsDir: nativeDir };
    const instQuota = await installPlugin(`local:${path.join(WORKSPACE_ROOT, 'agy-daddy-plugin-quota')}`, opts);
    const instUsage = await installPlugin(`local:${path.join(WORKSPACE_ROOT, 'agy-daddy-plugin-usage')}`, opts);
    const instContext = await installPlugin(`local:${path.join(WORKSPACE_ROOT, 'agy-daddy-plugin-context')}`, opts);
    const instComposer = await installPlugin(`local:${path.join(WORKSPACE_ROOT, 'agy-daddy-plugin-composer')}`, opts);

    assert.equal(instQuota.nativeSync.synced, true);
    assert.equal(instUsage.nativeSync.synced, true);
    assert.equal(instContext.nativeSync.synced, true);
    assert.equal(instComposer.nativeSync.synced, true);

    assert.ok(fs.existsSync(path.join(instComposer.nativeSync.targetDir, 'rules', 'fast-io-AGENTS.md')));
    assert.ok(fs.existsSync(path.join(instContext.nativeSync.targetDir, 'skills', 'context-governance', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(nativeDir, 'agy-daddy-quota', 'plugin.json')));

    // 3. 预置真实数据结构并通过同步后的 mcp.json 拉起真实 stdio MCP 子进程验证 JSON-RPC 工具返回
    const qDataDir = getPluginDataDir('agy-daddy.quota', { stateDir });
    fs.mkdirSync(qDataDir, { recursive: true });
    fs.writeFileSync(path.join(qDataDir, 'latest-snapshot.json'), JSON.stringify({
      ultraSubTier: '5x',
      quotaMultiplier: 5,
      gemini: { percentText: '82%' },
      claude: { percentText: '40%' },
      tightestPercentText: '最紧 40%'
    }));

    const uDataDir = getPluginDataDir('agy-daddy.usage', { stateDir });
    fs.mkdirSync(uDataDir, { recursive: true });
    fs.writeFileSync(path.join(uDataDir, 'token-pricing-ledger.json'), JSON.stringify({
      version: '1.0.0',
      calls: {
        c1: { callId: 'c1', model: 'gemini-4-hydrogen', inputTokens: 1000000, outputTokens: 0, date: '2026-11-21' }
      }
    }));

    const cDataDir = getPluginDataDir('agy-daddy.context', { stateDir });
    fs.mkdirSync(cDataDir, { recursive: true });
    fs.writeFileSync(path.join(cDataDir, 'latest-snapshot.json'), JSON.stringify({
      used: 245000,
      budget: 1048576,
      percent: 23.4,
      cacheCliffRisk: 'warn'
    }));

    // 测试 quota_status stdio MCP
    const qMcpCfg = JSON.parse(fs.readFileSync(path.join(instQuota.nativeSync.targetDir, 'mcp.json'), 'utf8')).mcpServers['agy-daddy-quota'];
    const qRpcRes = await callMcpStdioServer(qMcpCfg.command, qMcpCfg.args, qMcpCfg.env, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'quota_status', arguments: {} } }
    ]);
    assert.equal(qRpcRes.find((r) => r.id === 2).result.tools[0].name, 'quota_status');
    assert.equal(qRpcRes.find((r) => r.id === 3).result.structuredContent.tightestPercentText, '最紧 40%');

    // 测试 usage_summary stdio MCP
    const uMcpCfg = JSON.parse(fs.readFileSync(path.join(instUsage.nativeSync.targetDir, 'mcp.json'), 'utf8')).mcpServers['agy-daddy-usage'];
    const uRpcRes = await callMcpStdioServer(uMcpCfg.command, uMcpCfg.args, uMcpCfg.env, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'usage_summary', arguments: {} } }
    ]);
    assert.equal(uRpcRes.find((r) => r.id === 2).result.structuredContent.totalUsd, 1.5);

    // 测试 context_status stdio MCP
    const cMcpCfg = JSON.parse(fs.readFileSync(path.join(instContext.nativeSync.targetDir, 'mcp.json'), 'utf8')).mcpServers['agy-daddy-context'];
    const cRpcRes = await callMcpStdioServer(cMcpCfg.command, cMcpCfg.args, cMcpCfg.env, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'context_status', arguments: {} } }
    ]);
    assert.equal(cRpcRes.find((r) => r.id === 2).result.structuredContent.used, 245000);
    assert.equal(cRpcRes.find((r) => r.id === 2).result.structuredContent.cacheCliffRisk, 'warn');

    // 4. 卸载插件后全部原生扩展目录自动清除，不留垃圾文件
    for (const id of ['agy-daddy.quota', 'agy-daddy.usage', 'agy-daddy.context', 'agy-daddy.composer']) {
      const rmRes = uninstallPlugin(id, opts);
      assert.equal(rmRes.ok, true);
      assert.equal(rmRes.nativeCleanup.removed, true);
    }
    assert.equal(fs.readdirSync(nativeDir).length, 0);

    // 5. MCP Apps 可行性评估文档存在
    const assessDoc = fs.readFileSync(path.join(HOST_ROOT, 'docs', 'MCP_APPS_ASSESSMENT.md'), 'utf8');
    assert.match(assessDoc, /usage_summary/);
    assert.match(assessDoc, /quota_status/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
