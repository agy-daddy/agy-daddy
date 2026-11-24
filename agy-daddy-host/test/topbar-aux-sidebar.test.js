'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHostRuntime } = require('../src/renderer/host-runtime');
const { loadAnchorsRegistry } = require('../src/core/anchors');
const { createMockDocument } = require('../sdk/mock-harness');

const HOST_ROOT = path.resolve(__dirname, '..');

function attachAuxSidebarChrome(doc, { open = false, rightOverlayWidth = 36, includeStateAttrs = true, stripInViewport = true } = {}) {
  const auxRoot = doc.createElement('div');
  auxRoot.className = 'h-full w-full';
  if (includeStateAttrs) {
    auxRoot.setAttribute('data-aux-pane-open', open ? 'true' : 'false');
    auxRoot.setAttribute('data-side-panel-open', open ? 'true' : 'false');
  }

  const strip = doc.createElement('div');
  strip.setAttribute('data-side-panel-strip', 'true');
  strip.className = 'agy-layout-vars shrink-0 flex items-center gap-0.5 border-b pl-1.5 pr-20';
  strip.getBoundingClientRect = () => (stripInViewport
    ? { top: 0, left: 1000, right: 1920, bottom: 40, width: 920, height: 40 }
    : { top: 0, left: 1920, right: 2919, bottom: 40, width: 999, height: 40 });
  auxRoot.appendChild(strip);

  const rightOverlay = doc.createElement('div');
  rightOverlay.className = 'absolute right-0 z-50 flex items-center shrink-0';
  rightOverlay.getBoundingClientRect = () => ({
    top: 0,
    left: 1920 - rightOverlayWidth,
    right: 1920,
    bottom: 40,
    width: rightOverlayWidth,
    height: 40
  });
  const toggleBtn = doc.createElement('button');
  toggleBtn.setAttribute('data-testid', 'toggle-aux-sidebar');
  rightOverlay.appendChild(toggleBtn);

  doc.body.appendChild(auxRoot);
  doc.body.appendChild(rightOverlay);
  return { auxRoot, strip, rightOverlay, toggleBtn };
}

test('顶栏胶囊与展开侧边栏联动折叠、聚合菜单交互、无损恢复与层级清理', async () => {
  const prevMo = globalThis.MutationObserver;
  const observerRecords = [];
  globalThis.MutationObserver = class MockMutationObserver {
    constructor(cb) {
      this.cb = cb;
      this.observeCalls = [];
      this.disconnected = false;
      observerRecords.push(this);
    }
    observe(target, opts) {
      this.observeCalls.push({ target, opts });
    }
    disconnect() {
      this.disconnected = true;
    }
  };

  const doc = createMockDocument();
  const portalCalls = [];
  const win = {
    innerWidth: 1920,
    innerHeight: 993,
    location: { href: 'https://127.0.0.1:51410/' },
    electronNative: {
      wcvBrowser: {
        setPortalOverlayOpen(open) {
          portalCalls.push(Boolean(open));
          return Promise.resolve();
        }
      }
    }
  };

  const host = createHostRuntime({
    document: doc,
    window: win,
    anchorsRegistry: loadAnchorsRegistry(),
    hostSettings: {
      themeMode: 'light',
      topbarOrder: ['p.quota:quota', 'p.usage:tokens', 'p.cli:cli'],
      maxVisibleUnits: 6,
      showTopbarEntry: true
    }
  });

  try {
    const { auxRoot } = attachAuxSidebarChrome(doc, { open: false, rightOverlayWidth: 44 });
    let quotaPop = null;
    let cliLaunched = 0;

    await host.mountPlugin('p.quota', {
      mount(ctx) {
        quotaPop = ctx.topbar.registerPopover({ id: 'quota-panel', anchorId: 'quota', title: '额度监控' });
        ctx.topbar.registerUnit({
          id: 'quota',
          order: 10,
          label: 'G:88% · C:3%',
          tone: 'warn',
          onClick() {
            quotaPop.toggle();
          }
        });
      }
    });
    await host.mountPlugin('p.usage', {
      mount(ctx) {
        ctx.topbar.registerUnit({
          id: 'tokens',
          order: 20,
          label: '本月 G:4922.79M',
          tone: 'danger'
        });
      }
    });
    await host.mountPlugin('p.cli', {
      mount(ctx) {
        ctx.topbar.registerUnit({
          id: 'cli',
          order: 30,
          label: 'AGY',
          onClick() {
            cliLaunched += 1;
          }
        });
      }
    });

    const hostEl = doc.getElementById('agy-daddy-host');
    const shadow = hostEl.shadowRoot;
    const barEl = shadow.querySelector('#agy-topbar-slots');
    const overflowBtn = shadow.querySelector('#agy-topbar-overflow-btn');
    const overflowMenu = shadow.querySelector('#agy-topbar-overflow-menu');
    const overflowList = shadow.querySelector('#agy-topbar-overflow-list');
    const settingsBtn = shadow.querySelector('#agy-btn-settings');

    // Mock hostEl 尺寸以便测算 --agy-aux-strip-pr
    hostEl.getBoundingClientRect = () => {
      const compact = hostEl.getAttribute('data-aux-collapsed') === 'true';
      return {
        top: 6,
        left: compact ? 1812 : 1300,
        right: compact ? 1868 : 1804,
        bottom: 34,
        width: compact ? 56 : 504,
        height: 28
      };
    };

    // 1. 侧边栏折叠态：所有胶囊平铺在 #agy-topbar-slots，无 compact 标记
    assert.equal(host.isAuxSidebarExpanded(), false);
    assert.equal(hostEl.getAttribute('data-aux-collapsed'), 'false');
    assert.equal(barEl.getAttribute('data-compact'), 'false');
    assert.deepEqual(
      barEl.children.filter((c) => c.getAttribute('data-unit-id')).map((c) => c.getAttribute('data-unit-id')),
      ['quota', 'tokens', 'cli']
    );
    assert.equal(settingsBtn.parentElement, barEl);
    assert.equal(overflowBtn.hidden, true);
    assert.equal(doc.documentElement.getAttribute('data-agy-aux-compact'), null);

    // 确认已注册监听侧边栏属性的 MutationObserver（不依赖 childList 变更）
    const attrObserver = observerRecords.find((obs) =>
      obs.observeCalls.some((c) =>
        c.opts?.attributes === true
        && Array.isArray(c.opts?.attributeFilter)
        && c.opts.attributeFilter.includes('data-side-panel-open')
        && c.opts.attributeFilter.includes('data-aux-pane-open')
      )
    );
    assert.ok(attrObserver, 'Expected attribute MutationObserver for side-panel state');

    // 2. 侧边栏展开：通过属性变更触发自动折叠
    auxRoot.setAttribute('data-side-panel-open', 'true');
    auxRoot.setAttribute('data-aux-pane-open', 'true');
    attrObserver.cb([{ type: 'attributes', attributeName: 'data-side-panel-open', target: auxRoot }]);

    assert.equal(host.isAuxSidebarExpanded(), true);
    assert.equal(hostEl.getAttribute('data-aux-collapsed'), 'true');
    assert.equal(barEl.getAttribute('data-compact'), 'true');
    // 顶栏仅保留紧凑聚合菜单按钮
    assert.deepEqual(
      barEl.children.filter((c) => !c.hidden).map((c) => c.id),
      ['agy-topbar-overflow-btn']
    );
    assert.equal(overflowBtn.hidden, false);
    assert.equal(overflowBtn.getAttribute('data-compact-trigger'), 'true');
    assert.equal(overflowBtn.getAttribute('data-overflow-count'), '3');
    assert.equal(overflowBtn.getAttribute('aria-expanded'), 'false');

    // 聚合入口展示最高风险提示点（danger > warn）与数量角标
    const riskDot = overflowBtn.querySelector('.ag-unit-dot');
    assert.ok(riskDot);
    assert.equal(riskDot.getAttribute('data-level'), 'danger');
    assert.equal(overflowBtn.querySelector('.ag-compact-count')?.textContent, '3');

    // 所有插件胶囊与 Agy 入口均已收入聚合菜单列表
    assert.deepEqual(
      overflowList.children.map((c) => c.getAttribute('data-unit-id') || c.id),
      ['quota', 'tokens', 'cli', 'agy-btn-settings']
    );
    assert.equal(overflowMenu.querySelector('.ag-panel-title')?.textContent, '顶栏插件');

    // 动态计算 right 偏移与 Light-DOM strip padding-right
    // rightOverlayWidth=44 -> compactRight=52px; hostW=56 -> stripPr=max(80, 52+56+12)=120px
    assert.equal(hostEl.style.getPropertyValue('--ag-host-right'), '52px');
    assert.equal(doc.documentElement.getAttribute('data-agy-aux-compact'), 'true');
    assert.equal(doc.documentElement.style.getPropertyValue('--agy-aux-strip-pr'), '120px');

    // 3. 点击聚合菜单入口：展开面板、提升层级并激活 browser occluder
    overflowBtn.click();
    assert.equal(overflowMenu.hidden, false);
    assert.equal(overflowBtn.getAttribute('aria-expanded'), 'true');
    assert.equal(hostEl.getAttribute('data-elevated'), 'true');
    const occluder = doc.getElementById('agy-popover-browser-occluder');
    assert.ok(occluder && occluder.hidden === false);
    assert.equal(portalCalls[portalCalls.length - 1], true);

    // 4. 点击聚合菜单中的 Popover 型胶囊（quota）：关闭菜单并打开对应原面板，且定位锚定 overflowBtn
    const quotaBtn = shadow.querySelector('[data-agy-slot="unit:p.quota:quota"]');
    quotaBtn.click();
    const quotaPanel = shadow.querySelector('[data-agy-popover="p.quota:quota-panel"]');
    assert.equal(overflowMenu.hidden, true);
    assert.equal(overflowBtn.getAttribute('aria-expanded'), 'false');
    assert.equal(quotaPanel.hidden, false);
    assert.equal(overflowBtn.getAttribute('data-popover-open'), 'true');

    // 5. 再次打开菜单并点击动作型胶囊（cli）：触发原动作并自动关闭菜单
    overflowBtn.click();
    assert.equal(overflowMenu.hidden, false);
    assert.equal(quotaPanel.hidden, true);
    const cliBtn = shadow.querySelector('[data-agy-slot="unit:p.cli:cli"]');
    cliBtn.click();
    assert.equal(cliLaunched, 1);
    assert.equal(overflowMenu.hidden, true);

    // 6. 点击聚合菜单中的 Agy 入口：关闭菜单并打开设置弹窗
    overflowBtn.click();
    assert.equal(overflowMenu.hidden, false);
    settingsBtn.click();
    assert.equal(overflowMenu.hidden, true);
    assert.equal(host.getSettingsMode(), 'modal');
    shadow.querySelector('#agy-settings-close-btn').click();
    assert.equal(host.getSettingsMode(), 'closed');

    // 7. 保持 quota 面板打开时收起侧边栏：恢复平铺顺序，清理 Light-DOM 压缩状态并重新锚定面板
    quotaPop.toggle(true);
    assert.equal(quotaPanel.hidden, false);
    auxRoot.setAttribute('data-side-panel-open', 'false');
    auxRoot.setAttribute('data-aux-pane-open', 'false');
    attrObserver.cb([{ type: 'attributes', attributeName: 'data-side-panel-open', target: auxRoot }]);

    assert.equal(host.isAuxSidebarExpanded(), false);
    assert.equal(hostEl.getAttribute('data-aux-collapsed'), 'false');
    assert.equal(barEl.getAttribute('data-compact'), 'false');
    assert.equal(overflowBtn.hidden, true);
    assert.equal(overflowBtn.getAttribute('data-compact-trigger'), null);
    assert.deepEqual(
      barEl.children.filter((c) => c.getAttribute('data-unit-id')).map((c) => c.getAttribute('data-unit-id')),
      ['quota', 'tokens', 'cli']
    );
    assert.equal(settingsBtn.parentElement, barEl);
    assert.equal(hostEl.style.getPropertyValue('--ag-host-right'), '');
    assert.equal(doc.documentElement.getAttribute('data-agy-aux-compact'), null);
    assert.equal(doc.documentElement.style.getPropertyValue('--agy-aux-strip-pr'), '');
    assert.equal(quotaPanel.hidden, false);
    assert.equal(overflowBtn.getAttribute('data-popover-open'), 'false');

    // 8. dispose 彻底断开观察器并清理所有 Light-DOM 标记
    auxRoot.setAttribute('data-side-panel-open', 'true');
    attrObserver.cb([{ type: 'attributes', attributeName: 'data-side-panel-open', target: auxRoot }]);
    assert.equal(doc.documentElement.getAttribute('data-agy-aux-compact'), 'true');
    await host.dispose();
    assert.equal(attrObserver.disconnected, true);
    assert.equal(doc.documentElement.getAttribute('data-agy-aux-compact'), null);
    assert.equal(doc.documentElement.style.getPropertyValue('--agy-aux-strip-pr'), '');
  } finally {
    await host.dispose();
    if (prevMo === undefined) delete globalThis.MutationObserver;
    else globalThis.MutationObserver = prevMo;
  }
});

test('无状态属性时回退检测可见 strip 几何位置，且零胶囊时不进入紧凑态', async () => {
  const doc = createMockDocument();
  const win = { innerWidth: 1920, innerHeight: 993, location: { href: 'https://127.0.0.1:51410/' } };
  const host = createHostRuntime({
    document: doc,
    window: win,
    anchorsRegistry: loadAnchorsRegistry()
  });

  try {
    const { strip } = attachAuxSidebarChrome(doc, {
      includeStateAttrs: false,
      stripInViewport: false
    });
    let inViewport = false;
    strip.getBoundingClientRect = () => (inViewport
      ? { top: 0, left: 1000, right: 1920, bottom: 40, width: 920, height: 40 }
      : { top: 0, left: 1920, right: 2919, bottom: 40, width: 999, height: 40 });

    // 1. 零胶囊 + 视口内 strip：宿主壳尚未挂载且不设置紧凑标记
    inViewport = true;
    assert.equal(host.syncAuxSidebar(), true);
    assert.equal(doc.getElementById('agy-daddy-host'), null);
    assert.equal(doc.documentElement.getAttribute('data-agy-aux-compact'), null);

    // 2. 挂载 1 个胶囊后自动进入紧凑态；移出视口后恢复平铺
    await host.mountPlugin('p.single', {
      mount(ctx) {
        ctx.topbar.registerUnit({ id: 'one', order: 1, label: 'ONE' });
      }
    });
    const hostEl = doc.getElementById('agy-daddy-host');
    const shadow = hostEl.shadowRoot;
    assert.equal(hostEl.getAttribute('data-aux-collapsed'), 'true');
    assert.equal(shadow.querySelector('#agy-topbar-overflow-btn').getAttribute('data-compact-trigger'), 'true');

    inViewport = false;
    assert.equal(host.syncAuxSidebar(), false);
    assert.equal(hostEl.getAttribute('data-aux-collapsed'), 'false');
    assert.equal(shadow.querySelector('#agy-topbar-overflow-btn').hidden, true);
  } finally {
    await host.dispose();
  }
});

test('CSS 层级与 Light-DOM 侧边栏预留规则符合防遮挡规范', () => {
  const shadowCss = fs.readFileSync(path.join(HOST_ROOT, 'src', 'renderer', 'styles.css'), 'utf8');
  const lightCss = fs.readFileSync(path.join(HOST_ROOT, 'src', 'renderer', 'lightdom-styles.css'), 'utf8');

  assert.match(shadowCss, /:host\s*\{[\s\S]*?right:\s*var\(--ag-host-right,\s*116px\);[\s\S]*?z-index:\s*45;/);
  assert.match(shadowCss, /:host\(\[data-elevated="true"\]\)\s*\{[\s\S]*?z-index:\s*2147483646\s*!important;/);
  assert.match(shadowCss, /:host\(\[data-under-dialog="true"\]\)\s*\{[\s\S]*?z-index:\s*10\s*!important;/);
  assert.match(shadowCss, /\.ag-overflow-menu\s*\{[\s\S]*?width:\s*max-content;[\s\S]*?min-width:\s*248px;/);
  assert.match(lightCss, /:root\[data-agy-aux-compact="true"\]\s+\[data-side-panel-strip="true"\]\s*\{[\s\S]*?padding-right:\s*var\(--agy-aux-strip-pr,\s*116px\)\s*!important;/);
});
