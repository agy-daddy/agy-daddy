'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('vm');
const { createMockDocument, createMockElement } = require('../sdk/mock-harness');
const { createHostRuntime } = require('../src/renderer/host-runtime');

const HOST_ROOT = path.resolve(__dirname, '..');

function buildFullAnchorsRegistry() {
  return {
    schemaVersion: 1,
    anchors: {
      'topbar.rightCluster': { versions: [{ range: '>=2.0.0', selectors: ['[data-testid="toggle-aux-sidebar"]'] }] },
      'settings.dialog': { versions: [{ range: '>=2.0.0', selectors: ['[data-testid="settings-dialog"]', '[role="dialog"]'] }] },
      'settings.nav': { versions: [{ range: '>=2.0.0', selectors: ['[data-testid="settings-nav"]', '[role="dialog"] nav'] }] },
      'settings.content': { versions: [{ range: '>=2.0.0', selectors: ['[data-testid="settings-content"]', '[role="dialog"] main'] }] }
    }
  };
}

function createMockBridgeFetch(handlers = {}) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const parsed = new URL(url);
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ path: parsed.pathname, body });
    const handler = handlers[parsed.pathname];
    const data = typeof handler === 'function'
      ? await handler(body, init)
      : { ok: true };
    return {
      ok: data?.httpOk !== undefined ? Boolean(data.httpOk) : true,
      status: data?.httpStatus || 200,
      async json() { return data; }
    };
  };
  return { calls, fetchFn };
}

function createSampleStore() {
  return {
    workspacePath: '/Users/demo/projects/alpha-app',
    workspaceName: 'alpha-app',
    items: [
      {
        id: 'skill:global:brainstorming',
        name: 'brainstorming',
        displayName: 'Brainstorming',
        kind: 'skills',
        scope: 'global',
        version: '1.2.0',
        description: '创意设计与架构头脑风暴技能',
        sourcePath: '~/.gemini/config/skills/brainstorming/SKILL.md',
        enabled: true,
        tokens: 2400
      },
      {
        id: 'rule:workspace:ts-strict',
        name: 'ts-strict',
        displayName: 'TypeScript Strict Rule',
        kind: 'rules',
        scope: 'workspace',
        version: '1.0.0',
        description: '项目级严格类型与禁用 any 约束规则',
        sourcePath: '/Users/demo/projects/alpha-app/.agents/rules/ts-strict.md',
        enabled: true,
        tokens: 3100
      },
      {
        id: 'mcp:global:agy-fast',
        name: 'agy-fast',
        displayName: 'agy-fast MCP',
        kind: 'mcp',
        scope: 'global',
        version: '0.9.4',
        description: '高速文件批搜与编辑 MCP 工具集',
        sourcePath: '~/.gemini/config/plugins/agy-fast/mcp_config.json',
        enabled: true,
        tokens: 1666,
        excluded: true,
        mcp: {
          serverName: 'fast',
          policy: 'eager',
          totalTools: 5,
          eagerTools: 5,
          lazyTools: 0,
          excludedTools: ['apply_edits', 'batch_search', 'run_checks', 'read_slices'],
          tools: [
            { name: 'quick_outline', tokens: 183, eager: true, excluded: false },
            { name: 'apply_edits', tokens: 574, eager: true, excluded: true },
            { name: 'batch_search', tokens: 404, eager: true, excluded: true },
            { name: 'run_checks', tokens: 356, eager: true, excluded: true },
            { name: 'read_slices', tokens: 149, eager: true, excluded: true }
          ]
        }
      },
      {
        id: 'plugin:workspace:local-lint',
        name: 'local-lint',
        displayName: 'Workspace Lint Guard',
        kind: 'plugins',
        scope: 'workspace',
        version: '0.3.1',
        description: '仅限当前工作区的提交前检查扩展',
        sourcePath: '/Users/demo/projects/alpha-app/.agents/plugins/local-lint',
        enabled: true,
        tokens: 10200
      }
    ]
  };
}

function buildPayload(store) {
  let customUsed = 0;
  let customExcluded = 0;
  let rulesUsed = 0;
  for (const it of store.items) {
    if (!it.enabled) continue;
    if (it.kind === 'rules') {
      rulesUsed += it.tokens;
    } else {
      customUsed += it.tokens;
      if (it.excluded) customExcluded += (it.mcp?.excludedTools?.length || 1);
    }
  }
  return {
    ok: true,
    workspacePath: store.workspacePath,
    workspaceName: store.workspaceName,
    budgets: {
      customizations: { limit: 20000, used: customUsed, warnThreshold: 16000, excludedCount: customExcluded },
      rules: { limit: 20000, used: rulesUsed, warnThreshold: 16000, excludedCount: 0 }
    },
    items: store.items.map((it) => JSON.parse(JSON.stringify(it)))
  };
}

test('Customization Center Pro: 卡片化视图、多作用域筛选、20K预算预警、MCP策略切换与落位/装卸全交互', async () => {
  const doc = createMockDocument();
  const store = createSampleStore();

  const { calls, fetchFn } = createMockBridgeFetch({
    '/host/plugins': () => ({
      ok: true,
      plugins: [],
      catalog: [
        {
          id: 'agy-daddy.context',
          displayName: '上下文治理插件',
          description: '实时监控对话 Token 与速度',
          version: '1.1.0',
          trustLevel: 'T0',
          recommendedSpec: 'npm:@agy-daddy/plugin-context'
        }
      ]
    }),
    '/host/customizations': () => buildPayload(store),
    '/host/customizations/toggle': (body) => {
      const target = store.items.find((x) => x.id === body.id);
      if (target) target.enabled = Boolean(body.enabled);
      return buildPayload(store);
    },
    '/host/customizations/promote': (body) => {
      const target = store.items.find((x) => x.id === body.id);
      if (target) {
        target.promotedToWorkspace = true;
        store.items.push({
          ...JSON.parse(JSON.stringify(target)),
          id: `${target.kind}:workspace:${target.name}`,
          scope: 'workspace',
          sourcePath: `${store.workspacePath}/.agents/${target.kind}/${target.name}`
        });
      }
      return buildPayload(store);
    },
    '/host/customizations/mcp-policy': (body) => {
      const target = store.items.find((x) => x.id === body.id);
      if (target && target.mcp) {
        target.mcp.policy = body.policy;
        if (body.policy === 'lazy') {
          target.tokens = 183;
          target.excluded = false;
          target.mcp.excludedTools = [];
          target.mcp.eagerTools = 1;
          target.mcp.lazyTools = 4;
          target.mcp.tools = target.mcp.tools.map((t) => ({
            ...t,
            eager: t.name === 'quick_outline',
            excluded: false
          }));
        } else {
          target.tokens = 1666;
          target.excluded = true;
          target.mcp.excludedTools = ['apply_edits', 'batch_search', 'run_checks', 'read_slices'];
        }
      }
      return buildPayload(store);
    },
    '/host/customizations/uninstall': (body) => {
      store.items = store.items.filter((x) => x.id !== body.id);
      return buildPayload(store);
    },
    '/host/customizations/install': (body) => {
      const newScope = body.scope === 'workspace' ? 'workspace' : 'global';
      const newKind = body.kind && body.kind !== 'auto' ? body.kind : 'skills';
      const name = String(body.pluginId || body.source || 'custom-item').split('/').pop();
      store.items.push({
        id: `${newKind}:${newScope}:${name}`,
        name,
        displayName: name,
        kind: newKind,
        scope: newScope,
        version: '1.0.0',
        description: `Imported from ${body.source}`,
        sourcePath: newScope === 'workspace'
          ? `${store.workspacePath}/.agents/${newKind}/${name}`
          : `~/.gemini/config/${newKind}/${name}`,
        enabled: true,
        tokens: 650
      });
      return buildPayload(store);
    }
  });

  const host = createHostRuntime({
    document: doc,
    window: { location: { href: 'https://127.0.0.1:51410/' } },
    fetch: fetchFn,
    bridgePort: 19888,
    hostToken: 'test-token',
    anchorsRegistry: buildFullAnchorsRegistry()
  });

  try {
    await host.openCustomizations();
    await new Promise((r) => setTimeout(r, 30));

    const shadow = doc.getElementById('agy-daddy-host').shadowRoot;
    assert.ok(shadow.querySelector('#agy-tab-customizations'));
    assert.equal(shadow.querySelector('#agy-tab-customizations').getAttribute('data-active'), 'true');
    assert.ok(shadow.querySelector('#agy-customization-center'));

    // 1. 验证 20,000 Token 预算进度条与排除预警横幅
    const budgetFigure = shadow.querySelector('#agy-custom-budget-figure');
    assert.match(budgetFigure.textContent, /20,000 Token/);
    assert.equal(budgetFigure.getAttribute('data-tone'), 'danger');
    const exclusionAlert = shadow.querySelector('#agy-custom-exclusion-alert');
    assert.ok(exclusionAlert);
    assert.match(exclusionAlert.textContent, /apply_edits/);

    // 2. 验证资产卡片展示（4 张初始卡片，含 Global 与 Workspace .agents）
    assert.equal(shadow.querySelectorAll('.ag-asset-card').length, 4);
    const mcpCard = shadow.querySelector('[data-custom-card-id="mcp:global:agy-fast"]');
    assert.ok(mcpCard);
    assert.equal(mcpCard.getAttribute('data-asset-kind'), 'mcp');
    assert.equal(mcpCard.getAttribute('data-asset-scope'), 'global');

    // 3. 切换作用域 Tab（仅工作区 .agents -> 2 项；切回全部 -> 4 项）
    shadow.querySelector('[data-custom-scope="workspace"]').click();
    assert.equal(shadow.querySelectorAll('.ag-asset-card').length, 2);
    assert.ok(shadow.querySelector('[data-custom-card-id="rule:workspace:ts-strict"]'));
    assert.ok(shadow.querySelector('[data-custom-card-id="plugin:workspace:local-lint"]'));

    shadow.querySelector('[data-custom-scope="all"]').click();
    assert.equal(shadow.querySelectorAll('.ag-asset-card').length, 4);

    // 4. 类型筛选（MCP）+ 搜索过滤（按 MCP 工具名 batch_search 命中）
    shadow.querySelector('[data-custom-type="mcp"]').click();
    assert.equal(shadow.querySelectorAll('.ag-asset-card').length, 1);
    shadow.querySelector('[data-custom-type="all"]').click();

    const searchInput = shadow.querySelector('#agy-settings-search');
    searchInput.value = 'batch_search';
    searchInput.dispatchEvent({ type: 'input', target: searchInput });
    assert.equal(shadow.querySelectorAll('.ag-asset-card').length, 1);
    assert.ok(shadow.querySelector('[data-custom-card-id="mcp:global:agy-fast"]'));
    searchInput.value = '';
    searchInput.dispatchEvent({ type: 'input', target: searchInput });
    assert.equal(shadow.querySelectorAll('.ag-asset-card').length, 4);

    // 5. 一键将 agy-fast 转为 Smart Lazy -> 清除排除预警并更新为 lazy 模式
    shadow.querySelector('[data-custom-fix-lazy="mcp:global:agy-fast"]').click();
    await new Promise((r) => setTimeout(r, 30));
    const policyCall = calls.find((c) => c.path === '/host/customizations/mcp-policy');
    assert.ok(policyCall);
    assert.equal(policyCall.body.policy, 'lazy');
    assert.equal(Boolean(shadow.querySelector('#agy-custom-exclusion-alert')), false);
    assert.equal(
      shadow.querySelector('[data-custom-mcp-policy="mcp:global:agy-fast:lazy"]').getAttribute('data-active'),
      'true'
    );

    // 展开 MCP 工具清单查看明细
    shadow.querySelector('[data-custom-mcp-expand="mcp:global:agy-fast"]').click();
    assert.equal(shadow.querySelectorAll('.ag-mcp-tool-chip').length, 5);

    // 6. 启停 Toggle（禁用 brainstorming）
    const skillToggle = shadow.querySelector('[data-custom-toggle="skill:global:brainstorming"]');
    skillToggle.checked = false;
    skillToggle.dispatchEvent({ type: 'change', target: skillToggle });
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(calls.some((c) => c.path === '/host/customizations/toggle' && c.body.enabled === false));
    assert.equal(shadow.querySelector('[data-custom-card-id="skill:global:brainstorming"]').getAttribute('data-enabled'), 'false');

    // 7. 全局一键落位到当前工作区 .agents
    shadow.querySelector('[data-custom-promote="skill:global:brainstorming"]').click();
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(calls.some((c) => c.path === '/host/customizations/promote' && c.body.toScope === 'workspace'));
    assert.ok(shadow.querySelector('[data-custom-card-id="skills:workspace:brainstorming"]'));

    // 8. 二次确认卸载工作区插件
    const unBtn = shadow.querySelector('[data-custom-uninstall="plugin:workspace:local-lint"]');
    assert.match(unBtn.textContent, /卸载/);
    unBtn.click();
    assert.match(shadow.querySelector('[data-custom-uninstall="plugin:workspace:local-lint"]').textContent, /确认卸载\?/);
    shadow.querySelector('[data-custom-uninstall="plugin:workspace:local-lint"]').click();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(Boolean(shadow.querySelector('[data-custom-card-id="plugin:workspace:local-lint"]')), false);

    // 9. 导入/安装模态框：Esc 仅关子弹窗，支持本地路径与工作区目标选择 + 市场安装
    shadow.querySelector('#agy-custom-open-install-btn').click();
    assert.ok(shadow.querySelector('#agy-custom-install-modal'));
    doc.dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.equal(Boolean(shadow.querySelector('#agy-custom-install-modal')), false);
    assert.equal(host.getSettingsMode(), 'modal');

    // 重新打开导入弹窗，选择工作区作用域并提交本地导入
    shadow.querySelector('#agy-custom-open-install-btn').click();
    shadow.querySelector('[data-install-scope="workspace"]').click();
    const specInp = shadow.querySelector('#agy-custom-install-spec');
    specInp.value = '/tmp/my-custom-skill';
    specInp.dispatchEvent({ type: 'input', target: specInp });
    shadow.querySelector('#agy-custom-install-submit').click();
    await new Promise((r) => setTimeout(r, 30));
    const installLocalCall = calls.find((c) => c.path === '/host/customizations/install' && c.body.mode === 'local');
    assert.ok(installLocalCall);
    assert.equal(installLocalCall.body.scope, 'workspace');
    assert.equal(installLocalCall.body.source, '/tmp/my-custom-skill');
    assert.ok(shadow.querySelector('[data-custom-card-id="skills:workspace:my-custom-skill"]'));

    // 10. 独立 Popover 呼出与跳转完整中心
    host.closeSettings();
    assert.equal(host.getSettingsMode(), 'closed');
    const popOpen = host.toggleCustomizationPopover(true);
    assert.equal(popOpen, true);
    const popEl = shadow.querySelector('#agy-customization-popover');
    assert.equal(popEl.hidden, false);
    assert.ok(popEl.querySelector('[data-pop-mcp-toggle="mcp:global:agy-fast"]'));
    popEl.querySelector('#agy-custom-pop-open-center').click();
    assert.equal(popEl.hidden, true);
    assert.equal(host.getSettingsMode(), 'modal');
    assert.equal(shadow.querySelector('#agy-tab-customizations').getAttribute('data-active'), 'true');
  } finally {
    await host.dispose();
  }
});

test('Customization Center Pro: 原生设置注入模式切换、离线/404降级预览与 dist/host-renderer.js 产物校验', async () => {
  const doc = createMockDocument();
  const dialog = createMockElement('div', doc);
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('data-testid', 'settings-dialog');
  const nav = createMockElement('nav', doc);
  nav.setAttribute('data-testid', 'settings-nav');
  const content = createMockElement('main', doc);
  content.setAttribute('data-testid', 'settings-content');
  dialog.appendChild(nav);
  dialog.appendChild(content);
  doc.body.appendChild(dialog);

  const { fetchFn } = createMockBridgeFetch({
    '/host/customizations': () => ({ httpOk: false, httpStatus: 404, error: 'NOT_FOUND' }),
    '/host/plugins': () => ({ ok: true, plugins: [], catalog: [] })
  });

  const host = createHostRuntime({
    document: doc,
    window: { location: { href: 'https://127.0.0.1:51410/' } },
    fetch: fetchFn,
    bridgePort: 19889,
    hostToken: 'test-token',
    anchorsRegistry: buildFullAnchorsRegistry(),
    pluginMeta: {
      'agy-daddy.demo': {
        id: 'agy-daddy.demo',
        displayName: 'Demo Native Plugin',
        description: '带有原生 Skills 的测试插件',
        version: '1.0.0',
        hasNative: true,
        nativeInfo: {
          declared: { skills: ['demo-skill'], rules: ['demo-rule.md'], mcp: ['demo-mcp'] },
          config: { skills: true, rules: true, mcp: true }
        }
      }
    }
  });

  try {
    const res = await host.openSettings({ tab: 'customizations' });
    assert.equal(res.mode, 'native');
    await new Promise((r) => setTimeout(r, 30));

    const mountShadow = doc.querySelector('#agy-native-settings-mount').shadowRoot;
    assert.ok(mountShadow.querySelector('#agy-custom-fallback-banner'));
    assert.equal(mountShadow.querySelectorAll('.ag-asset-card').length, 4);
  } finally {
    await host.dispose();
  }

  // 验证编译产物 dist/host-renderer.js 已内联 Customization Center 模块与样式
  const distCode = fs.readFileSync(path.join(HOST_ROOT, 'dist', 'host-renderer.js'), 'utf8');
  assert.match(distCode, /__AGYCustomizationCenter/);
  assert.match(distCode, /ag-asset-card/);

  const vmDoc = createMockDocument();
  const sandbox = {
    document: vmDoc,
    location: { href: 'https://127.0.0.1:51410/' },
    console,
    Math,
    Date,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.runInNewContext(distCode, sandbox, { filename: 'host-renderer.js' });
  assert.equal(typeof sandbox.__AGYDaddyHost.openCustomizations, 'function');
  assert.equal(typeof sandbox.__AGYDaddyHost.toggleCustomizationPopover, 'function');
  await sandbox.__AGYDaddyHost.dispose();
});
