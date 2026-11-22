'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HOST_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = path.resolve(HOST_ROOT, '..');
const CHAT_NAV_DIR = path.join(WORKSPACE_ROOT, 'agy-daddy-plugin-chat-nav');
const CHAT_SEARCH_DIR = path.join(WORKSPACE_ROOT, 'agy-daddy-plugin-chat-search');
const GITHUB_INFRA_DIR = path.join(WORKSPACE_ROOT, 'agy-daddy-.github');
const REGISTRY_DIR = path.join(WORKSPACE_ROOT, 'agy-daddy-registry');
const TEMPLATE_DIR = path.join(WORKSPACE_ROOT, 'agy-daddy-plugin-template');

const { createMockHostHarness, createMockElement } = require('../sdk/mock-harness');

test('Phase 4 基础设施 3 仓结构完备且社区插件 community.chat-search 与 chat-nav 表面联动成功', async () => {
  for (const reqFile of [
    path.join(GITHUB_INFRA_DIR, '.github', 'workflows', 'plugin-ci.yml'),
    path.join(GITHUB_INFRA_DIR, '.github', 'workflows', 'anchors-matrix.yml'),
    path.join(GITHUB_INFRA_DIR, '.github', 'workflows', 'release.yml'),
    path.join(GITHUB_INFRA_DIR, 'CONTRIBUTING.md'),
    path.join(GITHUB_INFRA_DIR, 'REVIEW_CHECKLIST.md'),
    path.join(GITHUB_INFRA_DIR, 'LICENSE_AUDIT.md'),
    path.join(REGISTRY_DIR, 'registry.json'),
    path.join(TEMPLATE_DIR, 'agy-plugin.json')
  ]) {
    assert.ok(fs.existsSync(reqFile), `Missing Phase 4 deliverable: ${reqFile}`);
  }

  const harness = createMockHostHarness({
    seedAnchors: [
      { tag: 'div', attr: 'data-testid', val: 'autoscroll-viewport' },
      { tag: 'div', attr: 'data-testid', val: 'turn-cards-container' },
      { tag: 'button', attr: 'data-testid', val: 'thinking-collapsible-trigger' }
    ]
  });

  const listEl = harness.mockDoc.querySelector('[data-testid="turn-cards-container"]');
  for (const txt of ['Step 1: boot host', 'Step 2: verify chat.search surface']) {
    const c = createMockElement('div', harness.mockDoc);
    c.textContent = txt;
    listEl.appendChild(c);
  }

  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });

    // 先加载 T0 主世界 chat-nav，提供 #agy-chat-search-slot
    await harness.loadAndRunPlugin(CHAT_NAV_DIR, { trustLevel: 'T0', inProcessRenderer: true });
    // 再加载 T1/T2 隔离世界社区插件 community.chat-search
    const searchLoaded = await harness.loadAndRunPlugin(CHAT_SEARCH_DIR, { trustLevel: 'T2' });
    assert.equal(searchLoaded.trust.world, 'isolated');

    // chat-search 渲染入 chat-nav 提供的 #agy-chat-search-slot 扩展位内
    const slot = harness.mockDoc.getElementById('agy-chat-search-slot');
    assert.ok(slot);
    assert.ok(slot.querySelector('#agy-community-chat-search'));

    const searchInput = harness.mockDoc.getElementById('agy-community-search-input');
    searchInput.value = 'surface';
    searchInput.dispatchEvent({ type: 'change', target: searchInput });
    assert.equal(harness.mockDoc.getElementById('agy-community-search-count').textContent, '1/1');

    await harness.unloadPlugin('community.chat-search');
    assert.equal(slot.querySelector('#agy-community-chat-search'), null);
    harness.assertCleanDispose('community.chat-search');

    await harness.unloadPlugin('agy-daddy.chat-nav');
    harness.assertCleanDispose('agy-daddy.chat-nav');
  } finally {
    await harness.cleanup();
  }
});
