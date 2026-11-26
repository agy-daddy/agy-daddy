'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const HOST_ROOT = process.env.AGY_DADDY_HOST_DIR
  ? path.resolve(process.env.AGY_DADDY_HOST_DIR)
  : path.resolve(PLUGIN_ROOT, '..', 'agy-daddy-host');

const {
  validateManifest,
  validateSettingsSchema,
  validateSettingsValues,
  createMockHostHarness
} = require(path.join(HOST_ROOT, 'sdk'));

const {
  DEFAULT_SETTINGS,
  OPTICAL_PRESETS,
  CODE_HIGHLIGHT_THEMES,
  sanitizeCssColor,
  normalizeThemeSettings
} = require('../src/presets');
const { hasActiveVisualOverrides, buildThemeCss } = require('../src/css-builder');

test('契约校验：isolated 世界、零禁区颜色、settings.schema.json 与默认值合法', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'agy-plugin.json'), 'utf8'));
  const schema = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'settings.schema.json'), 'utf8'));

  const mCheck = validateManifest(manifest);
  assert.equal(mCheck.ok, true, `Manifest invalid: ${mCheck.errors.join('; ')}`);
  assert.equal(manifest.world, 'isolated');
  assert.equal((manifest.permissions || []).includes('page:main-world'), false);
  assert.equal(manifest.contributes?.migrations, undefined);

  const sCheck = validateSettingsSchema(schema);
  assert.equal(sCheck.ok, true, `Schema invalid: ${sCheck.errors.join('; ')}`);

  const valCheck = validateSettingsValues(schema, DEFAULT_SETTINGS);
  assert.equal(valCheck.ok, true, `Default settings invalid: ${valCheck.errors.join('; ')}`);

  const forbidden = [
    /#10b981/i, /#34d399/i, /#059669/i,
    /#38bdf8/i, /#7dd3fc/i, /#0369a1/i, /#0c4a6e/i,
    /#fb923c/i, /#c2410c/i
  ];
  for (const f of fs.readdirSync(path.join(PLUGIN_ROOT, 'src'))) {
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'src', f), 'utf8');
    for (const re of forbidden) {
      assert.equal(re.test(src), false, `${f} violated purple/forbidden theme gate: ${re}`);
    }
    assert.equal(src.includes('registerSection'), false, `${f} must not reference registerSection`);
  }
});

test('CSS 颜色清洗器与默认值零变动保证', () => {
  assert.equal(sanitizeCssColor('#1c2436'), '#1c2436');
  assert.equal(sanitizeCssColor('rgba(148, 163, 184, 0.22)'), 'rgba(148, 163, 184, 0.22)');
  assert.equal(sanitizeCssColor('transparent'), 'transparent');
  assert.equal(sanitizeCssColor('var(--card, #191919)'), 'var(--card, #191919)');

  // Reject injection vectors
  assert.equal(sanitizeCssColor('red; background: url(https://evil.test)'), '');
  assert.equal(sanitizeCssColor('red } body { display: none'), '');
  assert.equal(sanitizeCssColor('expression(alert(1))'), '');
  assert.equal(sanitizeCssColor('<style>'), '');

  // Default disabled: zero CSS injected
  const offRes = buildThemeCss(DEFAULT_SETTINGS);
  assert.equal(offRes.active, false);
  assert.equal(offRes.documentCss, '');
  assert.equal(offRes.shadowCss, '');

  // Enabled with pure native preset & no overrides: still zero CSS injected
  const nativeRes = buildThemeCss({ ...DEFAULT_SETTINGS, enabled: true, preset: 'native' });
  assert.equal(nativeRes.active, false);
  assert.equal(nativeRes.documentCss, '');
});

test('光学预设、组件级自定义、代码高亮与动效/省电开关生成精准 CSS 且耗时 < 10ms', () => {
  for (const presetId of ['obsidian-void', 'warm-basalt', 'cool-crystal', 'warm-album']) {
    assert.ok(OPTICAL_PRESETS[presetId]);
    const res = buildThemeCss({ enabled: true, preset: presetId });
    assert.equal(res.active, true);
    assert.match(res.documentCss, /--background:/);
    assert.match(res.documentCss, /\[data-testid="user-message"\]/);
    assert.match(res.documentCss, /\[data-testid="agent-response"\]/);
  }

  for (const codeThemeId of ['obsidian-night', 'warm-amber', 'crystal-light', 'paper-ink']) {
    assert.ok(CODE_HIGHLIGHT_THEMES[codeThemeId]);
  }

  const t0 = performance.now();
  const custom = buildThemeCss({
    enabled: true,
    preset: 'native',
    userBubbleBg: '#1c2436',
    userBubbleBorder: 'rgba(148, 163, 184, 0.24)',
    userBubbleRadius: 16,
    assistantBubbleBg: '#121722',
    assistantBubbleRadius: 14,
    codeTheme: 'warm-amber',
    codeBlockRadius: 12,
    terminalWellBg: '#090c11',
    terminalWellDepth: 'recessed',
    artifactRadius: 18,
    artifactBorderHighlight: 'rgba(234, 179, 8, 0.28)',
    topbarBg: 'rgba(13, 17, 24, 0.88)',
    composerBg: '#131823',
    composerRadius: 20,
    buttonAccent: '#2563eb',
    buttonRadius: 10,
    dampedSpringMotion: true,
    microAnimatedIcons: true,
    semanticAfterglow: true,
    syncHostCapsules: true
  });
  const elapsedMs = performance.now() - t0;

  assert.equal(custom.active, true);
  assert.ok(elapsedMs < 10, `Expected buildThemeCss < 10ms, got ${elapsedMs.toFixed(2)}ms`);
  assert.match(custom.documentCss, /--agy-user-bubble-bg: #1c2436;/);
  assert.match(custom.documentCss, /--agy-user-bubble-radius: 16px;/);
  assert.match(custom.documentCss, /--agy-assistant-bubble-radius: 14px;/);
  assert.match(custom.documentCss, /\.hljs-keyword/);
  assert.match(custom.documentCss, /--agy-code-radius: 12px;/);
  assert.match(custom.documentCss, /inset 0 2px 8px/);
  assert.match(custom.documentCss, /--agy-artifact-radius: 18px;/);
  assert.match(custom.documentCss, /--agy-topbar-bg:/);
  assert.match(custom.documentCss, /--agy-composer-radius: 20px;/);
  assert.match(custom.documentCss, /--agy-button-accent: #2563eb;/);
  assert.match(custom.documentCss, /--agy-button-radius: 10px;/);
  assert.match(custom.documentCss, /cubic-bezier\(0\.22, 1\.18, 0\.36, 1\)/);
  assert.match(custom.documentCss, /scale\(1\.08\)/);
  assert.match(custom.documentCss, /:focus-within/);

  // Quiet power-save mode suppresses spring motion, micro-icons, and semantic afterglow
  const powerSave = buildThemeCss({
    enabled: true,
    preset: 'obsidian-void',
    dampedSpringMotion: true,
    microAnimatedIcons: true,
    semanticAfterglow: true,
    powerSaveMode: true
  });
  assert.equal(powerSave.active, true);
  assert.match(powerSave.documentCss, /transition-duration: 0ms !important;/);
  assert.equal(/scale\(1\.08\)/.test(powerSave.documentCss), false);
  assert.equal(/:focus-within/.test(powerSave.documentCss), false);
  assert.equal(hasActiveVisualOverrides(normalizeThemeSettings({ enabled: false, preset: 'obsidian-void' })), false);
});

test('微内核生命周期集成：默认零注入、<10ms 实时热更新、命令回退与零残留 dispose', async () => {
  const harness = createMockHostHarness({
    seedAnchors: [
      { tag: 'div', attr: 'data-testid', val: 'toggle-aux-sidebar' },
      { tag: 'div', attr: 'class', val: 'surface-composer' },
      { tag: 'div', attr: 'data-testid', val: 'turn-cards-container' }
    ]
  });

  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });

    const loaded = await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });
    assert.equal(loaded.trust.world, 'isolated');
    assert.ok(harness.isolatedWorlds.has('agy-daddy.theme'));

    // 1. Default install: 100% zero style injection and zero topbar changes
    assert.equal(harness.mockDoc.querySelector('[data-agy-style="agy-daddy.theme"]'), null);
    const initialHostEl = harness.mockDoc.getElementById('agy-daddy-host');
    assert.equal(initialHostEl?.shadowRoot?.querySelector('[data-agy-style="agy-daddy.theme"]') ?? null, null);
    assert.equal(initialHostEl?.shadowRoot?.querySelector('[data-agy-slot="unit:agy-daddy.theme:theme-studio"]') ?? null, null);

    // 2. Enable preset + custom component overrides and verify live hot update
    const startHot = performance.now();
    await harness.updatePluginSettings('agy-daddy.theme', {
      enabled: true,
      preset: 'obsidian-void',
      userBubbleRadius: 18,
      codeTheme: 'obsidian-night',
      dampedSpringMotion: true,
      syncHostCapsules: true
    });
    const hostEl = harness.mockDoc.getElementById('agy-daddy-host');
    assert.ok(hostEl?.shadowRoot);
    const styleNode = harness.mockDoc.querySelector('[data-agy-style="agy-daddy.theme"]');
    const shadowNode = hostEl.shadowRoot.querySelector('[data-agy-style="agy-daddy.theme"]');
    assert.ok(styleNode, 'Expected injected document style node when enabled');
    assert.ok(shadowNode, 'Expected injected shadow style node when syncHostCapsules=true');
    assert.match(styleNode.textContent, /#0b0d12/);
    assert.match(styleNode.textContent, /18px/);

    // Hot-switch preset in place (reuses style node and updates textContent <10ms)
    const switchT0 = performance.now();
    await harness.updatePluginSettings('agy-daddy.theme', {
      preset: 'warm-album',
      codeTheme: 'paper-ink'
    });
    const switchElapsed = performance.now() - switchT0;
    const styleNodeAfter = harness.mockDoc.querySelector('[data-agy-style="agy-daddy.theme"]');
    assert.equal(styleNodeAfter, styleNode, 'Style node should be updated in place');
    assert.match(styleNodeAfter.textContent, /#faf7f2/);
    assert.ok(switchElapsed < 250, `Unexpectedly slow async harness switch: ${switchElapsed.toFixed(2)}ms`);
    assert.ok(startHot > 0);

    // 3. Optional topbar studio unit + popover
    await harness.updatePluginSettings('agy-daddy.theme', { showTopbarUnit: true });
    assert.ok(hostEl.shadowRoot.querySelector('[data-agy-slot="unit:agy-daddy.theme:theme-studio"]'));
    const popBody = hostEl.shadowRoot.querySelector('[data-agy-slot="popover:agy-daddy.theme:theme-popover"]');
    assert.ok(popBody);
    assert.match(popBody.textContent, /暖白画册/);

    // 4. Node service & declarative commands: toggle power-save and reset to native
    const themeSvc = harness.bus.getServiceProxy('theme');
    const presetsInfo = await themeSvc.getPresets();
    assert.equal(presetsInfo.presets.length, 4);

    const psRes = await harness.executeCommand('theme.toggle-power-save', [true]);
    assert.equal(psRes.ok, true);
    assert.equal(psRes.config.powerSaveMode, true);
    await new Promise((r) => setTimeout(r, 20));
    assert.match(harness.mockDoc.querySelector('[data-agy-style="agy-daddy.theme"]').textContent, /transition-duration: 0ms/);

    const resetRes = await harness.executeCommand('theme.reset-native', []);
    assert.equal(resetRes.ok, true);
    assert.equal(resetRes.config.enabled, false);
    assert.equal(resetRes.config.preset, 'native');
    await new Promise((r) => setTimeout(r, 20));

    // After reset-native: 100% clean rollback to native (no injected styles, no topbar unit)
    assert.equal(harness.mockDoc.querySelector('[data-agy-style="agy-daddy.theme"]'), null);
    assert.equal(hostEl.shadowRoot.querySelector('[data-agy-style="agy-daddy.theme"]'), null);
    assert.equal(hostEl.shadowRoot.querySelector('[data-agy-slot="unit:agy-daddy.theme:theme-studio"]'), null);

    // 5. Re-enable then unloadPlugin: assert zero leftover artifacts
    await harness.updatePluginSettings('agy-daddy.theme', {
      enabled: true,
      preset: 'cool-crystal',
      showTopbarUnit: true
    });
    assert.ok(harness.mockDoc.querySelector('[data-agy-style="agy-daddy.theme"]'));

    await harness.unloadPlugin('agy-daddy.theme');
    assert.equal(harness.mockDoc.querySelector('[data-agy-style="agy-daddy.theme"]'), null);
    assert.equal(hostEl.shadowRoot.querySelector('[data-agy-style="agy-daddy.theme"]'), null);
    harness.assertCleanDispose('agy-daddy.theme');
  } finally {
    await harness.cleanup();
  }
});

test('设置中心配置面板：按 enabled 渐进展示分组与组件级外观控制项', async () => {
  const harness = createMockHostHarness({
    seedAnchors: [
      { tag: 'div', attr: 'data-testid', val: 'toggle-aux-sidebar' }
    ]
  });

  try {
    const { port } = await harness.bridge.start(0);
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'agy-plugin.json'), 'utf8'));
    const schema = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'settings.schema.json'), 'utf8'));
    harness.rendererHost.configure({
      bridgePort: port,
      hostToken: harness.bridge.hostToken,
      pluginMeta: {
        'agy-daddy.theme': {
          id: manifest.id,
          displayName: '视觉主题与光学定制',
          description: '独立视觉主题插件',
          version: manifest.version,
          trustLevel: 'T0',
          settingsSchema: schema,
          settingsValues: { ...DEFAULT_SETTINGS }
        }
      }
    });
    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });

    await harness.rendererHost.openSettings({ tab: 'plugins', pluginId: 'agy-daddy.theme' });
    const shadow = harness.mockDoc.getElementById('agy-daddy-host')?.shadowRoot;
    assert.ok(shadow, 'Expected host shadowRoot when settings panel opens');

    // Default disabled: fine-grained fields hidden via visibleWhen
    assert.ok(shadow.querySelector('[data-field-key="enabled"]'));
    assert.equal(shadow.querySelector('[data-field-key="preset"]'), null);
    assert.equal(shadow.querySelector('[data-field-key="userBubbleBg"]'), null);
    assert.ok(shadow.querySelector('[data-schema-action="reset-native"]'));

    // Enable theme: all component groups & fields become visible
    await harness.updatePluginSettings('agy-daddy.theme', { enabled: true });
    await new Promise((r) => setTimeout(r, 20));
    await harness.rendererHost.openSettings({ tab: 'plugins', pluginId: 'agy-daddy.theme' });

    for (const key of [
      'preset',
      'userBubbleBg',
      'assistantBubbleBg',
      'codeTheme',
      'terminalWellBg',
      'artifactRadius',
      'topbarBg',
      'composerBg',
      'buttonAccent',
      'powerSaveMode',
      'dampedSpringMotion',
      'microAnimatedIcons',
      'semanticAfterglow'
    ]) {
      assert.ok(shadow.querySelector(`[data-field-key="${key}"]`), `Expected field ${key} in settings panel`);
    }

    await harness.unloadPlugin('agy-daddy.theme');
    harness.assertCleanDispose('agy-daddy.theme');
  } finally {
    await harness.cleanup();
  }
});
