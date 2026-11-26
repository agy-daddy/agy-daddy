'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgyDaddyDaemon } = require('../src/core/daemon');
const {
  scanCustomizations,
  setCustomizationEnabled,
  installCustomization,
  uninstallCustomization,
  migrateCustomizationToWorkspace,
  applyMcpPolicy,
  rollbackMcpConfig,
  listMcpConfigBackups,
  detectActiveWorkspaceRoot
} = require('../src/core/customizations');

function createFixtureDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-customizations-'));
  const stateDir = path.join(root, 'state');
  const pluginsDir = path.join(root, 'daddy-plugins');
  const geminiConfigDir = path.join(root, 'gemini-config');
  const workspaceDir = path.join(root, 'workspace-proj');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.mkdirSync(geminiConfigDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  return { root, stateDir, pluginsDir, geminiConfigDir, workspaceDir };
}

test('scanCustomizations 扫描全局与当前工作区自定义项（含 RPC 工作区探测、符号链接、密钥脱敏与 20k 规则预算）', async () => {
  const { root, stateDir, geminiConfigDir, workspaceDir } = createFixtureDirs();
  try {
    // 1. 全局目录预置：config.json / plugins / skills (含软链与坏软链) / rules / hooks / mcp_config.json
    const globalConfigPath = path.join(geminiConfigDir, 'config.json');
    fs.writeFileSync(globalConfigPath, JSON.stringify({
      sidecars: { keepMe: true },
      plugins: { 'demo-plugin': { enabled: false } },
      skills: { 'linked-skill': { enabled: true } }
    }, null, 2), { mode: 0o600 });

    const agyFastDir = path.join(geminiConfigDir, 'plugins', 'agy-fast');
    fs.mkdirSync(path.join(agyFastDir, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(agyFastDir, 'plugin.json'), JSON.stringify({
      name: 'agy-fast',
      version: '0.3.1',
      description: 'Fast batch MCP'
    }));
    fs.writeFileSync(path.join(agyFastDir, 'rules', 'AGENTS.md'), '# Fast Rules\n');
    fs.writeFileSync(path.join(agyFastDir, 'mcp_config.json'), JSON.stringify({
      mcpServers: {
        fast: {
          command: 'node',
          args: ['${PLUGIN_ROOT}/dist/mcp-server.mjs'],
          tools: {
            batch_search: { eager: true },
            apply_edits: { eager: true }
          }
        }
      }
    }));

    const demoPluginDir = path.join(geminiConfigDir, 'plugins', 'demo-plugin');
    fs.mkdirSync(demoPluginDir, { recursive: true });
    fs.writeFileSync(path.join(demoPluginDir, 'plugin.json'), JSON.stringify({ name: 'demo-plugin' }));

    const realSkillSrc = path.join(root, 'external-skill');
    fs.mkdirSync(path.join(realSkillSrc, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(realSkillSrc, 'SKILL.md'), [
      '---',
      'name: linked-skill',
      'description: >-',
      '  External linked skill',
      '  for workflow testing.',
      '---',
      '# Linked Skill'
    ].join('\n'));
    fs.mkdirSync(path.join(geminiConfigDir, 'skills'), { recursive: true });
    fs.symlinkSync(
      realSkillSrc,
      path.join(geminiConfigDir, 'skills', 'linked-skill'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    fs.symlinkSync(
      path.join(root, 'missing-target-skill'),
      path.join(geminiConfigDir, 'skills', 'broken-skill'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    fs.mkdirSync(path.join(geminiConfigDir, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(geminiConfigDir, 'rules', 'global-rule.md'), '---\ntrigger: always_on\n---\nAlways check tests.\n');
    fs.writeFileSync(path.join(geminiConfigDir, 'hooks.json'), JSON.stringify({
      'rtk-rewrite': {
        enabled: true,
        PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: 'rtk hook' }] }]
      }
    }));
    fs.writeFileSync(path.join(geminiConfigDir, 'mcp_config.json'), JSON.stringify({
      mcpServers: {
        'secret-srv': {
          command: 'npx',
          args: ['-y', 'demo-mcp'],
          env: { API_TOKEN: 'super-secret-value' },
          headers: { Authorization: 'Bearer secret-token' }
        }
      }
    }));

    // 2. 工作区 .agents/ 预置
    const wsAgents = path.join(workspaceDir, '.agents');
    fs.mkdirSync(path.join(wsAgents, 'skills', 'ws-skill'), { recursive: true });
    fs.writeFileSync(path.join(wsAgents, 'skills', 'ws-skill', 'SKILL.md'), '---\nname: ws-skill\ndescription: Workspace skill\n---\n');
    fs.mkdirSync(path.join(wsAgents, 'skills', 'excluded-skill'), { recursive: true });
    fs.writeFileSync(path.join(wsAgents, 'skills', 'excluded-skill', 'SKILL.md'), '---\nname: excluded-skill\ndescription: Disabled\n---\n');
    fs.writeFileSync(path.join(wsAgents, 'skills.json'), JSON.stringify({ exclude: ['excluded-skill'] }));
    fs.mkdirSync(path.join(wsAgents, 'plugins', 'ws-plugin'), { recursive: true });
    fs.writeFileSync(path.join(wsAgents, 'plugins', 'ws-plugin', 'plugin.json'), JSON.stringify({ name: 'ws-plugin', version: '1.0.0' }));
    fs.mkdirSync(path.join(wsAgents, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(wsAgents, 'rules', 'proj.md'), '---\ntrigger: model_decision\ndescription: Project rule\n---\nRule body\n');
    fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# Repo Agents\nFollow conventions.\n');
    fs.writeFileSync(path.join(wsAgents, 'hooks.json'), JSON.stringify({
      'ws-hook': { enabled: false, PostToolUse: [] }
    }));
    fs.writeFileSync(path.join(wsAgents, 'mcp_config.json'), JSON.stringify({
      mcpServers: {
        'ws-db': { url: 'https://mcp.example.com/mcp', disabled: false }
      }
    }));

    // 3. 通过模拟 RPC GetAllCascadeTrajectories 自动识别活跃工作区
    const mockRpc = {
      async call(method) {
        assert.equal(method, 'GetAllCascadeTrajectories');
        return {
          trajectorySummaries: {
            old: {
              status: 'CASCADE_RUN_STATUS_IDLE',
              lastModifiedTime: '2026-11-25T00:00:00Z',
              workspaces: [{ workspaceFolderAbsoluteUri: `file://${root}` }]
            },
            active: {
              status: 'CASCADE_RUN_STATUS_RUNNING',
              lastModifiedTime: '2026-11-26T00:00:00Z',
              workspaces: [{ workspaceFolderAbsoluteUri: `file://${workspaceDir}` }]
            }
          }
        };
      }
    };

    const detected = await detectActiveWorkspaceRoot({ rpcTransport: mockRpc });
    assert.equal(detected.root, path.resolve(workspaceDir));
    assert.equal(detected.source, 'rpc-trajectory');

    const scan = await scanCustomizations({ stateDir, geminiConfigDir, rpcTransport: mockRpc });
    assert.equal(scan.ok, true);
    assert.equal(scan.workspace.root, path.resolve(workspaceDir));
    assert.equal(scan.workspace.source, 'rpc-trajectory');
    assert.equal(scan.workspace.agentsExists, true);

    const agyFastPlugin = scan.items.plugins.find((p) => p.scope === 'global' && p.name === 'agy-fast');
    assert.ok(agyFastPlugin);
    assert.equal(agyFastPlugin.enabled, true);
    assert.deepEqual(agyFastPlugin.assets.rules, ['AGENTS.md']);
    assert.deepEqual(agyFastPlugin.assets.mcpServers, ['fast']);

    const demoPlugin = scan.items.plugins.find((p) => p.scope === 'global' && p.name === 'demo-plugin');
    assert.equal(demoPlugin.enabled, false);

    const linkedSkill = scan.items.skills.find((s) => s.scope === 'global' && s.name === 'linked-skill');
    assert.equal(linkedSkill.isSymlink, true);
    assert.equal(linkedSkill.brokenSymlink, false);
    assert.equal(linkedSkill.description, 'External linked skill for workflow testing.');

    const brokenSkill = scan.items.skills.find((s) => s.scope === 'global' && s.name === 'broken-skill');
    assert.equal(brokenSkill.brokenSymlink, true);

    const excludedSkill = scan.items.skills.find((s) => s.scope === 'workspace' && s.name === 'excluded-skill');
    assert.equal(excludedSkill.enabled, false);

    const secretSrv = scan.items.mcpServers.find((m) => m.serverName === 'secret-srv');
    assert.ok(secretSrv);
    assert.deepEqual(secretSrv.envKeys, ['API_TOKEN']);
    assert.deepEqual(secretSrv.headerKeys, ['Authorization']);
    assert.equal(JSON.stringify(secretSrv).includes('super-secret-value'), false);
    assert.equal(JSON.stringify(secretSrv).includes('secret-token'), false);

    const fastMcp = scan.items.mcpServers.find((m) => m.pluginName === 'agy-fast' && m.serverName === 'fast');
    assert.equal(fastMcp.toolLoading, 'eager');
    assert.deepEqual(fastMcp.eagerTools, ['batch_search', 'apply_edits']);

    assert.equal(scan.summary.rulesBudget.limitTokens, 20000);
    assert.ok(scan.summary.rulesBudget.globalEstimatedTokens > 0);
    assert.ok(scan.summary.rulesBudget.workspaceEstimatedTokens > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('生命周期管理：启用/禁用（保留兄弟键与清单同步）、安装/卸载（复制与软链安全清理）与一键落位工作区', async () => {
  const { root, stateDir, geminiConfigDir, workspaceDir } = createFixtureDirs();
  try {
    const opts = { stateDir, geminiConfigDir, workspaceRoot: workspaceDir };

    // 准备外部源目录
    const srcSkill = path.join(root, 'src-skill');
    fs.mkdirSync(srcSkill, { recursive: true });
    fs.writeFileSync(path.join(srcSkill, 'SKILL.md'), '---\nname: my-skill\ndescription: Demo\n---\nHello\n');

    const srcPlugin = path.join(root, 'src-plugin');
    fs.mkdirSync(path.join(srcPlugin, 'skills', 'sub-s'), { recursive: true });
    fs.writeFileSync(path.join(srcPlugin, 'plugin.json'), JSON.stringify({ name: 'my-plugin', version: '1.2.0' }));
    fs.writeFileSync(path.join(srcPlugin, 'skills', 'sub-s', 'SKILL.md'), '---\nname: sub-s\ndescription: Sub\n---\n');

    // 1. 安装 Skill (symlink 到全局) 与 Plugin (copy 到全局)
    const instSkill = installCustomization({
      type: 'skill',
      name: 'my-skill',
      sourcePath: srcSkill,
      scope: 'global',
      mode: 'symlink'
    }, opts);
    assert.equal(instSkill.ok, true);
    assert.equal(fs.lstatSync(instSkill.targetPath).isSymbolicLink(), true);

    const instPlugin = installCustomization({
      type: 'plugin',
      name: 'my-plugin',
      sourcePath: srcPlugin,
      scope: 'global',
      mode: 'copy'
    }, opts);
    assert.equal(instPlugin.ok, true);
    assert.equal(fs.existsSync(path.join(instPlugin.targetPath, 'plugin.json')), true);

    // 重复安装无 overwrite 应拒绝
    const dupRes = installCustomization({
      type: 'skill',
      name: 'my-skill',
      sourcePath: srcSkill,
      scope: 'global'
    }, opts);
    assert.equal(dupRes.ok, false);
    assert.equal(dupRes.code, 'ALREADY_EXISTS');

    // 路径穿越拦截
    assert.throws(
      () => installCustomization({ type: 'skill', name: '../evil', sourcePath: srcSkill, scope: 'global' }, opts),
      (err) => err.code === 'INVALID_NAME'
    );

    // 2. 启用 / 禁用写入全局 config.json 且保留原有字段
    fs.writeFileSync(
      path.join(geminiConfigDir, 'config.json'),
      JSON.stringify({ userSettings: { theme: 'dark' } }, null, 2),
      { mode: 0o600 }
    );
    const toggleOff = setCustomizationEnabled({ type: 'plugin', name: 'my-plugin', scope: 'global', enabled: false }, opts);
    assert.equal(toggleOff.ok, true);
    const savedGlobalCfg = JSON.parse(fs.readFileSync(path.join(geminiConfigDir, 'config.json'), 'utf8'));
    assert.deepEqual(savedGlobalCfg.userSettings, { theme: 'dark' });
    assert.equal(savedGlobalCfg.plugins['my-plugin'].enabled, false);

    // 3. 一键落位到当前工作区（包含把全局软链 skill 解引用复制进 .agents/skills/）
    const migSkill = migrateCustomizationToWorkspace({
      type: 'skill',
      name: 'my-skill',
      workspaceRoot: workspaceDir,
      disableGlobal: true
    }, opts);
    assert.equal(migSkill.ok, true);
    assert.equal(migSkill.targetPath, path.join(workspaceDir, '.agents', 'skills', 'my-skill'));
    assert.equal(fs.lstatSync(migSkill.targetPath).isSymbolicLink(), false);
    assert.equal(fs.existsSync(path.join(migSkill.targetPath, 'SKILL.md')), true);

    const migPlugin = migrateCustomizationToWorkspace({
      type: 'plugin',
      name: 'my-plugin',
      workspaceRoot: workspaceDir
    }, opts);
    assert.equal(migPlugin.ok, true);
    assert.equal(fs.existsSync(path.join(workspaceDir, '.agents', 'plugins', 'my-plugin', 'plugin.json')), true);

    // 全局 my-skill 已被 disableGlobal 禁用
    const cfgAfterMig = JSON.parse(fs.readFileSync(path.join(geminiConfigDir, 'config.json'), 'utf8'));
    assert.equal(cfgAfterMig.skills['my-skill'].enabled, false);

    // 工作区开关同步 .agents/config.json 与 .agents/skills.json
    fs.writeFileSync(path.join(workspaceDir, '.agents', 'skills.json'), JSON.stringify({ entries: [{ path: 'skills' }] }));
    setCustomizationEnabled({ type: 'skill', name: 'my-skill', scope: 'workspace', enabled: false }, opts);
    const wsSkillsManifest = JSON.parse(fs.readFileSync(path.join(workspaceDir, '.agents', 'skills.json'), 'utf8'));
    assert.deepEqual(wsSkillsManifest.exclude, ['my-skill']);

    setCustomizationEnabled({ type: 'skill', name: 'my-skill', scope: 'workspace', enabled: true }, opts);
    const wsSkillsManifestReEnabled = JSON.parse(fs.readFileSync(path.join(workspaceDir, '.agents', 'skills.json'), 'utf8'));
    assert.equal(wsSkillsManifestReEnabled.exclude, undefined);

    // 4. 卸载软链不删除外部源目录，且清理 config.json
    const rmSkill = uninstallCustomization({ type: 'skill', name: 'my-skill', scope: 'global' }, opts);
    assert.equal(rmSkill.ok, true);
    assert.equal(rmSkill.wasSymlink, true);
    assert.equal(fs.existsSync(srcSkill), true);
    assert.equal(fs.existsSync(path.join(srcSkill, 'SKILL.md')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MCP 策略处理器：Force Eager / Smart Lazy 突破 20,000 Token 拦截、代理 Schema 生成、实时 stdio 探测与回滚', async () => {
  const { root, stateDir, geminiConfigDir } = createFixtureDirs();
  try {
    const opts = { stateDir, geminiConfigDir };
    const agyFastDir = path.join(geminiConfigDir, 'plugins', 'agy-fast');
    fs.mkdirSync(agyFastDir, { recursive: true });

    // 创建真实可被 stdio probe 的 mock MCP server 脚本
    const mockMcpScript = path.join(agyFastDir, 'mock-mcp.js');
    const bigDesc = 'X'.repeat(88000); // > 20,000 tokens combined (~22k tokens)
    fs.writeFileSync(mockMcpScript, `
      let buf = '';
      process.stdin.on('data', (c) => {
        buf += c.toString('utf8');
        const lines = buf.split('\\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.id === 1) {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', capabilities: {} } }) + '\\n');
          } else if (msg.id === 2) {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: 2,
              result: {
                tools: [
                  {
                    name: 'batch_search',
                    description: 'Fast parallel search',
                    inputSchema: { type: 'object', properties: { cwd: { type: 'string' }, queries: { type: 'array' } }, required: ['queries'] }
                  },
                  {
                    name: 'heavy_analyzer',
                    description: ${JSON.stringify(bigDesc)},
                    inputSchema: { type: 'object', properties: { target: { type: 'string' }, deep: { type: 'boolean' } }, required: ['target'] }
                  }
                ]
              }
            }) + '\\n');
          }
        }
      });
    `);

    const mcpPath = path.join(agyFastDir, 'mcp_config.json');
    fs.writeFileSync(mcpPath, JSON.stringify({
      mcpServers: {
        fast: {
          command: process.execPath,
          args: ['${PLUGIN_ROOT}/mock-mcp.js'],
          disabled: true,
          tools: {
            batch_search: { eager: false }
          }
        }
      }
    }, null, 2));

    // 1. Force Eager + probeTools：自动探测工具并全部设为 eager: true，解除 disabled
    const eagerRes = await applyMcpPolicy({
      pluginName: 'agy-fast',
      scope: 'global',
      mode: 'force-eager',
      probeTools: true
    }, opts);
    assert.equal(eagerRes.ok, true);
    assert.equal(eagerRes.mode, 'force-eager');
    assert.equal(eagerRes.tokenAnalysis.exceedsBudgetBefore, true);
    assert.equal(eagerRes.tokenAnalysis.exceedsBudgetAfter, true);
    const afterEagerCfg = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    assert.equal(afterEagerCfg.mcpServers.fast.disabled, false);
    assert.equal(afterEagerCfg.mcpServers.fast.tools.batch_search.eager, true);
    assert.equal(afterEagerCfg.mcpServers.fast.tools.heavy_analyzer.eager, true);

    // 2. Smart Lazy (keepEagerUnderBudget: true)：自动把超预算重工具降级为 lazy 并生成代理 Schema
    const smartKeepRes = await applyMcpPolicy({
      pluginName: 'agy-fast',
      scope: 'global',
      mode: 'smart-lazy',
      probeTools: true,
      keepEagerUnderBudget: true,
      tokenBudget: 20000,
      lazyStyle: 'explicit-false',
      writeProxySchemaFile: true,
      writeProxyRule: true
    }, opts);
    assert.equal(smartKeepRes.ok, true);
    assert.equal(smartKeepRes.tokenAnalysis.exceedsBudgetBefore, true);
    assert.equal(smartKeepRes.tokenAnalysis.exceedsBudgetAfter, false);
    assert.deepEqual(smartKeepRes.servers.fast.eagerToolsAfter, ['batch_search']);
    assert.deepEqual(smartKeepRes.servers.fast.lazyToolsAfter, ['heavy_analyzer']);
    assert.ok(smartKeepRes.servers.fast.proxySchema);
    assert.ok(smartKeepRes.servers.fast.proxySchema.stats.savedTokens > 10000);
    assert.equal(fs.existsSync(path.join(agyFastDir, 'proxy-schema.fast.json')), true);
    assert.equal(fs.existsSync(path.join(agyFastDir, 'rules', 'mcp-proxy-fast.md')), true);

    // 3. 强制全部转为 lazy（strip-tools 移除 tools 声明，eager token = 0）
    const lazyRes = await applyMcpPolicy({
      pluginName: 'agy-fast',
      scope: 'global',
      mode: 'smart-lazy',
      probeTools: true
    }, opts);
    assert.equal(lazyRes.ok, true);
    assert.equal(lazyRes.tokenAnalysis.eagerTokensAfter, 0);
    assert.equal(lazyRes.tokenAnalysis.exceedsBudgetAfter, false);
    const afterLazyCfg = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    assert.equal(afterLazyCfg.mcpServers.fast.tools, undefined);

    // 4. 备份检查与回滚恢复
    const backups = listMcpConfigBackups({ pluginName: 'agy-fast', scope: 'global' }, opts);
    assert.equal(backups.length, 3);
    const rbRes = rollbackMcpConfig({ pluginName: 'agy-fast', scope: 'global' }, opts);
    assert.equal(rbRes.ok, true);
    const restoredCfg = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    assert.equal(restoredCfg.mcpServers.fast.tools.batch_search.eager, true);
    assert.equal(restoredCfg.mcpServers.fast.tools.heavy_analyzer.eager, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Daemon Bridge HTTP、RPC 工作区探测与 Worker IPC (host.control.invoke) 协议兼容', async () => {
  const { root, stateDir, pluginsDir, geminiConfigDir, workspaceDir } = createFixtureDirs();

  // 预置全局插件 agy-fast
  const agyFastDir = path.join(geminiConfigDir, 'plugins', 'agy-fast');
  fs.mkdirSync(agyFastDir, { recursive: true });
  fs.writeFileSync(path.join(agyFastDir, 'plugin.json'), JSON.stringify({ name: 'agy-fast', version: '0.3.1' }));
  fs.writeFileSync(path.join(agyFastDir, 'mcp_config.json'), JSON.stringify({
    mcpServers: {
      fast: {
        command: 'node',
        args: ['${PLUGIN_ROOT}/dist/mcp-server.mjs'],
        tools: { batch_search: { eager: true } }
      }
    }
  }));

  // 预置一个运行在独立 Worker (T1) 且持有 host:control 的插件，通过 service 暴露 IPC 调用能力
  const workerPluginDir = path.join(root, 'worker-ctl-plugin');
  fs.mkdirSync(path.join(workerPluginDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workerPluginDir, 'agy-plugin.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'test.worker-ctl',
    publisher: 'test',
    version: '1.0.0',
    displayName: { en: 'Worker Ctl' },
    engines: { agyDaddy: '^1.0.0' },
    main: './src/node.js',
    world: 'isolated',
    permissions: ['host:control']
  }));
  fs.writeFileSync(path.join(workerPluginDir, 'src', 'node.js'), `
    module.exports = {
      async activate(host) {
        await host.services.provide('cust-ipc', {
          scan: () => host.control.invoke('/host/customizations', {}),
          blocked: async () => {
            try {
              await host.control.invoke('/host/not-in-allowlist', {});
              return { blocked: false };
            } catch (err) {
              return { blocked: true, code: err.code || null, message: err.message };
            }
          }
        });
      },
      async deactivate() {}
    };
  `);

  const daemon = new AgyDaddyDaemon({
    stateDir,
    pluginsDir,
    geminiConfigDir,
    workspaceRoot: workspaceDir,
    plugins: [
      {
        id: 'test.worker-ctl',
        installPath: workerPluginDir,
        trustLevel: 'T1',
        grantedPermissions: ['host:control'],
        enabled: true
      }
    ]
  });

  try {
    const started = await daemon.start();
    const baseUrl = `http://127.0.0.1:${started.port}`;
    const postHost = async (route, body = {}, token = started.hostToken) => {
      const resp = await fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AGY-Host-Token': token
        },
        body: JSON.stringify(body)
      });
      return { status: resp.status, data: await resp.json() };
    };

    // 1. Token 鉴权门禁
    const unauth = await postHost('/host/customizations', {}, 'wrong-token');
    assert.equal(unauth.status, 403);

    // 2. HTTP Bridge /host/customizations 扫描
    const scanRes = await postHost('/host/customizations', {});
    assert.equal(scanRes.status, 200);
    assert.equal(scanRes.data.ok, true);
    assert.equal(scanRes.data.workspace.root, path.resolve(workspaceDir));
    assert.ok(scanRes.data.items.plugins.some((p) => p.name === 'agy-fast'));

    // 3. HTTP Bridge /host/customizations/migrate 一键落位到工作区
    const migRes = await postHost('/host/customizations/migrate', {
      type: 'plugin',
      name: 'agy-fast'
    });
    assert.equal(migRes.status, 200);
    assert.equal(migRes.data.ok, true);
    assert.equal(fs.existsSync(path.join(workspaceDir, '.agents', 'plugins', 'agy-fast', 'plugin.json')), true);

    // 4. HTTP Bridge /host/customizations/mcp/policy & rollback
    const polRes = await postHost('/host/customizations/mcp/policy', {
      pluginName: 'agy-fast',
      scope: 'global',
      mode: 'lazy'
    });
    assert.equal(polRes.status, 200);
    assert.equal(polRes.data.ok, true);
    assert.equal(polRes.data.servers.fast.summary.toolLoading, 'lazy');

    const rbRes = await postHost('/host/customizations/mcp/rollback', {
      pluginName: 'agy-fast',
      scope: 'global'
    });
    assert.equal(rbRes.status, 200);
    assert.equal(rbRes.data.rolledBack, true);

    // 5. HTTP Bridge toggle & install & uninstall
    const toggleRes = await postHost('/host/customizations/toggle', {
      type: 'plugin',
      name: 'agy-fast',
      scope: 'global',
      enabled: false
    });
    assert.equal(toggleRes.status, 200);
    assert.equal(toggleRes.data.enabled, false);

    const extraSkillDir = path.join(root, 'extra-skill');
    fs.mkdirSync(extraSkillDir, { recursive: true });
    fs.writeFileSync(path.join(extraSkillDir, 'SKILL.md'), '---\nname: extra-skill\ndescription: Extra\n---\n');
    const instRes = await postHost('/host/customizations/install', {
      type: 'skill',
      sourcePath: extraSkillDir,
      scope: 'workspace',
      mode: 'copy'
    });
    assert.equal(instRes.status, 200);
    assert.equal(instRes.data.ok, true);

    const uninstRes = await postHost('/host/customizations/uninstall', {
      type: 'skill',
      name: 'extra-skill',
      scope: 'workspace'
    });
    assert.equal(uninstRes.status, 200);
    assert.equal(uninstRes.data.ok, true);

    // 6. Worker IPC (host.control.invoke) 调用与白名单拦截
    const ipcScan = await daemon.bus.callService('cust-ipc', 'scan', [], { callerRealm: 'node' });
    assert.equal(ipcScan.ok, true);
    assert.equal(ipcScan.value.ok, true);
    assert.equal(ipcScan.value.workspace.root, path.resolve(workspaceDir));

    const ipcBlocked = await daemon.bus.callService('cust-ipc', 'blocked', [], { callerRealm: 'node' });
    assert.equal(ipcBlocked.ok, true);
    assert.equal(ipcBlocked.value.blocked, true);
    assert.equal(ipcBlocked.value.code, 'HOST_CONTROL_ROUTE_BLOCKED');
  } finally {
    await daemon.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
