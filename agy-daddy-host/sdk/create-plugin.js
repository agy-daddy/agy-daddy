'use strict';

const fs = require('fs');
const path = require('path');
const { assertSafePluginId } = require('../src/core/paths');
const { validateManifest } = require('../src/contracts/manifest-validator');

function createPluginScaffold(targetDir, options = {}) {
  const dir = path.resolve(targetDir);
  const pluginId = assertSafePluginId(options.id || 'example.hello');
  const [publisher, shortName] = pluginId.split('.');
  const world = options.world === 'main' ? 'main' : 'isolated';
  const permissions = Array.isArray(options.permissions) && options.permissions.length
    ? [...options.permissions]
    : ['dom:write', 'bridge:route'];
  if (world === 'main' && !permissions.includes('page:main-world')) {
    permissions.push('page:main-world');
  }
  const anchors = Array.isArray(options.anchors) && options.anchors.length
    ? [...options.anchors]
    : ['topbar.rightCluster'];

  const manifest = {
    schemaVersion: 1,
    id: pluginId,
    publisher,
    version: '1.0.0',
    license: 'MIT',
    displayName: options.displayName || {
      'zh-CN': `${shortName} 插件`,
      en: `${shortName} Plugin`
    },
    engines: {
      agyDaddy: '^1.0.0',
      antigravity: '>=2.32.0'
    },
    main: './src/node.js',
    renderer: './src/renderer.js',
    world,
    activationEvents: ['onStartup'],
    requires: { anchors },
    provides: {
      services: {
        [shortName]: { version: '1.0.0', realm: 'node' }
      },
      states: [`state:${shortName}.status@1`]
    },
    permissions,
    contributes: {
      'topbar.units': [{ id: `${shortName}-unit`, order: 90 }],
      settings: { schema: './settings.schema.json' },
      locales: './locales'
    }
  };

  const v = validateManifest(manifest);
  if (!v.ok) {
    throw new Error(`Invalid scaffold manifest: ${v.errors.join('; ')}`);
  }

  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'locales'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });

  const pkg = {
    name: `@${publisher}/agy-daddy-plugin-${shortName}`,
    version: '1.0.0',
    description: typeof manifest.displayName === 'string' ? manifest.displayName : manifest.displayName.en,
    license: 'MIT',
    main: './src/node.js',
    agyPlugin: './agy-plugin.json',
    scripts: {
      test: 'AGY_DADDY_TEST_MODE=1 node --test test/*.test.js'
    },
    engines: {
      node: '>=22.4.0'
    }
  };

  const settingsSchema = {
    title: manifest.displayName,
    fields: [
      {
        key: 'enabledBadge',
        type: 'boolean',
        default: true,
        label: { 'zh-CN': '显示顶栏状态单元', en: 'Show topbar unit' }
      }
    ]
  };

  const nodeCode = `'use strict';

let disposers = [];

async function activate(host) {
  let count = 0;
  const stopSvc = host.services.provide(${JSON.stringify(shortName)}, {
    ping() {
      count++;
      host.state.set(${JSON.stringify(`state:${shortName}.status@1`)}, { count });
      return { ok: true, pluginId: host.pluginId, count };
    }
  }, { realm: 'node', version: '1.0.0' });

  const stopRoute = await host.bridge.registerRoute('/ping', async () => ({
    ok: true,
    pluginId: host.pluginId,
    count
  }));

  disposers.push(stopSvc, stopRoute);
}

async function deactivate() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = { activate, deactivate };
`;

  const rendererCode = `'use strict';

let disposers = [];

async function mount(ctx) {
  const stopUnit = ctx.topbar.registerUnit({
    id: ${JSON.stringify(`${shortName}-unit`)},
    order: 90,
    label: ${JSON.stringify(shortName)},
    render(node) {
      if (node.style && typeof node.style.setProperty === 'function') {
        node.style.setProperty('border-color', 'var(--ag-custom-token-accent, var(--ag-token-accent-default, #a78bfa))');
      }
    },
    onClick() {
      void ctx.bridge.post('/ping', {}).catch(() => {});
    }
  });
  disposers.push(stopUnit);
}

function dispose() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = { mount, dispose };
`;

  const testCode = `'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const HOST_ROOT = process.env.AGY_DADDY_HOST_DIR
  ? path.resolve(process.env.AGY_DADDY_HOST_DIR)
  : path.resolve(__dirname, '..', '..', 'agy-daddy-host');
const { createMockHostHarness } = require(path.join(HOST_ROOT, 'sdk', 'mock-harness'));

test(${JSON.stringify(`${pluginId} scaffold contract & clean dispose`)}, async () => {
  const harness = createMockHostHarness();
  try {
    await harness.loadAndRunPlugin(path.resolve(__dirname, '..'), { trustLevel: 'T2' });
    const svc = harness.bus.getServiceProxy(${JSON.stringify(shortName)});
    const pong = await svc.ping();
    assert.equal(pong.ok, true);
    await harness.unloadPlugin(${JSON.stringify(pluginId)});
    harness.assertCleanDispose(${JSON.stringify(pluginId)});
  } finally {
    await harness.cleanup();
  }
});
`;

  const files = [];
  const write = (rel, content) => {
    const out = path.join(dir, rel);
    fs.writeFileSync(out, content, 'utf8');
    files.push(out);
  };

  write('package.json', JSON.stringify(pkg, null, 2) + '\n');
  write('agy-plugin.json', JSON.stringify(manifest, null, 2) + '\n');
  write('settings.schema.json', JSON.stringify(settingsSchema, null, 2) + '\n');
  write('locales/zh-CN.json', JSON.stringify({ label: shortName }, null, 2) + '\n');
  write('locales/en.json', JSON.stringify({ label: shortName }, null, 2) + '\n');
  write('src/node.js', nodeCode);
  write('src/renderer.js', rendererCode);
  write('test/plugin.test.js', testCode);

  return { ok: true, targetDir: dir, pluginId, files };
}

module.exports = { createPluginScaffold };
