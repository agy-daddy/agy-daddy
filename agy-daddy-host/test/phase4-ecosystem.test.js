'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HOST_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = path.resolve(HOST_ROOT, '..');
const CHAT_NAV_DIR = path.join(WORKSPACE_ROOT, 'agy-daddy-plugin-chat-nav');
const GITHUB_INFRA_DIR = path.join(WORKSPACE_ROOT, 'agy-daddy-.github');
const REGISTRY_DIR = path.join(WORKSPACE_ROOT, 'agy-daddy-registry');
const TEMPLATE_DIR = path.join(WORKSPACE_ROOT, 'agy-daddy-plugin-template');

const { createMockHostHarness, createMockElement } = require('../sdk/mock-harness');

test('Phase 4 基础设施 3 仓结构完备且 chat-nav 内置全文检索与 chat.navButtons 扩展联动成功', async () => {
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
  for (const txt of ['Step 1: boot host', 'Step 2: verify builtin chat search']) {
    const c = createMockElement('div', harness.mockDoc);
    c.textContent = txt;
    listEl.appendChild(c);
  }

  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });

    // 加载 T0 隔离世界 chat-nav，内置对话全文检索与 chat.navButtons 扩展槽位
    const navLoaded = await harness.loadAndRunPlugin(CHAT_NAV_DIR, { trustLevel: 'T0' });
    assert.equal(navLoaded.trust.world, 'isolated');

    const slot = harness.mockDoc.querySelector('#agy-chat-search-slot');
    assert.ok(slot);
    assert.ok(slot.querySelector('#agy-chat-search-box'));

    const searchInput = harness.mockDoc.getElementById('agy-chat-search-input');
    searchInput.value = 'builtin';
    searchInput.dispatchEvent({ type: 'change', target: searchInput });
    assert.equal(harness.mockDoc.getElementById('agy-chat-search-count').textContent, '1/1');

    // 第三方隔离插件通过 ctx.surfaces.mount 消费 chat.navButtons 插槽
    let stopNavExt = null;
    await harness.rendererHost.mountPlugin('community.nav-ext', {
      mount(ctx) {
        stopNavExt = ctx.surfaces.mount('chat.navButtons', (slotEl) => {
          const extBtn = createMockElement('button', harness.mockDoc);
          extBtn.id = 'community-nav-ext-btn';
          slotEl.appendChild(extBtn);
          return () => extBtn.remove();
        });
      },
      dispose() {
        stopNavExt?.();
        stopNavExt = null;
      }
    });
    assert.ok(harness.mockDoc.getElementById('agy-chat-nav-extra').querySelector('#community-nav-ext-btn'));

    await harness.rendererHost.disposePlugin('community.nav-ext');
    assert.equal(harness.mockDoc.getElementById('community-nav-ext-btn'), null);

    await harness.unloadPlugin('agy-daddy.chat-nav');
    harness.assertCleanDispose('agy-daddy.chat-nav');
  } finally {
    await harness.cleanup();
  }
});
