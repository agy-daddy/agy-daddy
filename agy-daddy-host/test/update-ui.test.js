'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockDocument } = require('../sdk/mock-harness');
const { createHostRuntime } = require('../src/renderer/host-runtime');

function buildTestAnchors() {
  return {
    schemaVersion: 1,
    anchors: {
      'topbar.rightCluster': { versions: [{ range: '>=2.0.0', selectors: ['[data-testid="toggle-aux-sidebar"]'] }] },
      'composer.root': { versions: [{ range: '>=2.0.0', selectors: ['.surface-composer'] }] }
    }
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushAsync(turns = 6) {
  for (let i = 0; i < turns; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

function createMockBridge(handlers = {}) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const parsed = new URL(url);
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ path: parsed.pathname, body });
    const handler = handlers[parsed.pathname];
    const result = typeof handler === 'function' ? await handler(body, init) : { ok: true };
    const status = result && Number.isInteger(result.statusCode) ? result.statusCode : 200;
    const payload = result && typeof result === 'object' ? { ...result } : { ok: true };
    delete payload.statusCode;
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return payload;
      }
    };
  };
  return { calls, fetchFn };
}

test('desktop update UI loads status, enforces immediate loading state, and handles check/apply/handoff', async () => {
  const doc = createMockDocument();
  const checkDeferred = createDeferred();
  const hostUpdateDeferred = createDeferred();

  const { calls, fetchFn } = createMockBridge({
    '/host/plugins': () => ({
      ok: true,
      updatesSummary: {
        availableCount: 2,
        pluginAvailableCount: 1,
        hostAvailable: true,
        registryAvailable: false,
        blockedCount: 0
      },
      plugins: [
        {
          id: 'agy-daddy.quota',
          displayName: 'Quota Monitor',
          description: 'Quota stats',
          version: '1.1.1',
          trustLevel: 'T0',
          enabled: true,
          active: true,
          hasNative: false,
          hasRollback: true,
          pinned: false,
          permissions: ['rpc:read'],
          sourceKind: 'npm',
          sourceSpec: 'npm:@agy-daddy/plugin-quota@latest',
          updateInfo: {
            targetId: 'agy-daddy.quota',
            currentVersion: '1.1.1',
            latestVersion: '1.2.0',
            status: 'available',
            addedPermissions: [],
            addedHighRiskPermissions: [],
            releaseNotesUrl: 'https://github.com/agy-daddy/agy-daddy/releases/tag/v1.2.0'
          }
        },
        {
          id: 'community.pinned',
          displayName: 'Pinned Helper',
          description: 'Community plugin',
          version: '1.0.0',
          trustLevel: 'T1',
          enabled: true,
          active: true,
          hasNative: false,
          hasRollback: false,
          pinned: true,
          permissions: [],
          sourceKind: 'github',
          sourceSpec: 'github:user/repo#v1.0.0'
        }
      ],
      catalog: []
    }),
    '/host/updates/status': () => ({
      ok: true,
      hostVersion: '1.1.1',
      hostApiVersion: '1.2.0',
      anchorsVersion: '1.1.1',
      installMode: 'wrapper',
      writable: true,
      dirtyWorktree: false,
      settings: {
        updateChannel: 'stable',
        autoUpdateMode: 'notify',
        updateCheckInterval: '6h',
        updateSourcePreference: 'auto',
        npmRegistryUrl: ''
      },
      scheduler: {
        enabled: true,
        runningCheck: false,
        applyingUpdate: false,
        lastCheckedAt: '2026-11-28T08:30:00.000Z',
        nextCheckAt: '2026-11-28T14:30:00.000Z'
      },
      summary: {
        availableCount: 2,
        pluginAvailableCount: 1,
        hostAvailable: true,
        registryAvailable: false,
        blockedCount: 0
      },
      targets: {
        host: {
          targetId: 'host',
          kind: 'host',
          installMode: 'wrapper',
          currentVersion: '1.1.1',
          latestVersion: '1.2.0',
          status: 'available',
          hasRollback: true,
          wrapperUpdateRecommended: true,
          wrapperMinVersion: '1.2.0',
          releaseNotesUrl: 'https://github.com/agy-daddy/agy-daddy/releases/tag/v1.2.0'
        },
        'agy-daddy.quota': {
          targetId: 'agy-daddy.quota',
          kind: 'plugin',
          currentVersion: '1.1.1',
          latestVersion: '1.2.0',
          status: 'available',
          addedPermissions: [],
          addedHighRiskPermissions: []
        }
      },
      recentHistory: [
        {
          targetId: 'agy-daddy.quota',
          fromVersion: '1.1.0',
          toVersion: '1.1.1',
          outcome: 'succeeded',
          errorCode: null
        }
      ]
    }),
    '/host/updates/check': async () => checkDeferred.promise,
    '/host/updates/apply': async (body) => {
      if (Array.isArray(body.targets) && body.targets[0] === 'host') {
        return hostUpdateDeferred.promise;
      }
      return {
        ok: true,
        runId: 'upd_1',
        handoff: false,
        results: [{ targetId: 'agy-daddy.quota', outcome: 'succeeded', fromVersion: '1.1.1', toVersion: '1.2.0' }],
        plugins: []
      };
    }
  });

  const runtime = createHostRuntime({
    document: doc,
    fetch: fetchFn,
    bridgePort: 39111,
    hostToken: 'secret-tok',
    anchorsRegistry: buildTestAnchors(),
    hostSettings: { injectNativeSettings: false }
  });

  try {
    await runtime.openSettings({ tab: 'plugins' });
    await flushAsync();

    const shadow = doc.getElementById('agy-daddy-host').shadowRoot;
    assert.equal(shadow.querySelector('#agy-update-dot').hidden, false);
    assert.ok(shadow.querySelector('#agy-host-update-card'));
    assert.equal(shadow.querySelector('#agy-host-install-mode-chip').textContent, '包装器');
    assert.match(shadow.querySelector('#agy-host-update-available-chip').textContent, /v1\.2\.0/);
    assert.ok(shadow.querySelector('#agy-wrapper-update-notice'));
    assert.ok(shadow.querySelector('#agy-update-history-list'));
    assert.equal(shadow.querySelector('[data-plugin-update-chip="agy-daddy.quota"]').textContent, 'v1.1.1 → v1.2.0');
    assert.equal(shadow.querySelector('[data-plugin-pinned-badge="community.pinned"]').textContent, '已锁定');

    // Immediate loading state & anti-double-submit on check updates
    const checkBtn = shadow.querySelector('#agy-check-updates-btn');
    checkBtn.click();
    const checkBtnWhileBusy = shadow.querySelector('#agy-check-updates-btn');
    assert.equal(checkBtnWhileBusy.disabled, true);
    assert.match(checkBtnWhileBusy.textContent, /检查中/);
    assert.ok(checkBtnWhileBusy.querySelector('.ag-spinner'));

    // Second click while busy should not issue a second request
    checkBtnWhileBusy.click();
    assert.equal(calls.filter((c) => c.path === '/host/updates/check').length, 1);

    checkDeferred.resolve({
      ok: true,
      debounced: true,
      hostVersion: '1.1.1',
      summary: { availableCount: 2, hostAvailable: true, pluginAvailableCount: 1 },
      targets: {
        host: { targetId: 'host', currentVersion: '1.1.1', latestVersion: '1.2.0', status: 'available', hasRollback: true },
        'agy-daddy.quota': { targetId: 'agy-daddy.quota', currentVersion: '1.1.1', latestVersion: '1.2.0', status: 'available' }
      },
      errors: []
    });
    await flushAsync();
    assert.match(shadow.querySelector('#agy-manage-toast').textContent, /防抖缓存/);

    // Trigger host update and verify loading state + handoff message
    const hostUpdBtn = shadow.querySelector('#agy-host-update-btn');
    hostUpdBtn.click();
    const hostUpdBusy = shadow.querySelector('#agy-host-update-btn');
    assert.equal(hostUpdBusy.disabled, true);
    assert.match(hostUpdBusy.textContent, /更新中/);
    assert.ok(hostUpdBusy.querySelector('.ag-spinner'));

    hostUpdateDeferred.resolve({
      ok: true,
      handoff: true,
      targetVersion: '1.2.0'
    });
    await flushAsync();
    assert.match(shadow.querySelector('#agy-manage-toast').textContent, /独立更新器升级底座至 v1\.2\.0/);
  } finally {
    await runtime.dispose();
  }
});

test('desktop update UI handles permission/major confirmation, rollback loading, pin toggle, settings persistence, and bus state sync', async () => {
  const doc = createMockDocument();
  const rollbackDeferred = createDeferred();
  let applyAttempt = 0;

  const { calls, fetchFn } = createMockBridge({
    '/host/plugins': () => ({
      ok: true,
      updatesSummary: { availableCount: 1, pluginAvailableCount: 1, hostAvailable: false },
      plugins: [
        {
          id: 'third.sample',
          displayName: 'Sample Plugin',
          description: 'Third-party plugin',
          version: '1.0.0',
          trustLevel: 'T2',
          enabled: true,
          active: true,
          hasNative: false,
          hasRollback: true,
          pinned: false,
          permissions: ['dom:read'],
          sourceKind: 'github',
          sourceSpec: 'github:third/sample',
          updateInfo: {
            targetId: 'third.sample',
            currentVersion: '1.0.0',
            latestVersion: '2.0.0',
            majorUpdateAvailable: '2.0.0',
            status: 'available',
            addedPermissions: ['process:spawn'],
            addedHighRiskPermissions: ['process:spawn']
          }
        }
      ],
      catalog: []
    }),
    '/host/updates/status': () => ({
      ok: true,
      hostVersion: '1.1.1',
      anchorsVersion: '1.1.1',
      installMode: 'git',
      settings: {
        updateChannel: 'stable',
        autoUpdateMode: 'notify',
        updateCheckInterval: '6h',
        updateSourcePreference: 'auto',
        npmRegistryUrl: ''
      },
      summary: { availableCount: 1, pluginAvailableCount: 1, hostAvailable: false },
      targets: {
        host: { targetId: 'host', currentVersion: '1.1.1', latestVersion: '1.1.1', status: 'up_to_date' },
        'third.sample': {
          targetId: 'third.sample',
          currentVersion: '1.0.0',
          latestVersion: '2.0.0',
          majorUpdateAvailable: '2.0.0',
          status: 'available',
          addedPermissions: ['process:spawn'],
          addedHighRiskPermissions: ['process:spawn']
        }
      }
    }),
    '/host/updates/apply': (body) => {
      applyAttempt++;
      if (applyAttempt === 1) {
        return {
          ok: false,
          errorCode: 'PERMISSION_CONFIRMATION_REQUIRED',
          needsPermissionConfirm: true,
          needsMajorConfirm: true,
          confirmations: [
            {
              pluginId: 'third.sample',
              displayName: 'Sample Plugin',
              trustLevel: 'T2',
              fromVersion: '1.0.0',
              toVersion: '2.0.0',
              majorUpdate: true,
              currentPermissions: ['dom:read'],
              addedPermissions: ['process:spawn'],
              addedHighRiskPermissions: ['process:spawn']
            }
          ]
        };
      }
      return {
        ok: true,
        hostRestartRequired: true,
        hostRestartNotice: { required: true, reason: 'launch_args', message: '需要重启 Antigravity 生效' },
        results: [{ targetId: 'third.sample', outcome: 'succeeded', fromVersion: '1.0.0', toVersion: '2.0.0' }],
        plugins: []
      };
    },
    '/host/updates/rollback': async () => rollbackDeferred.promise,
    '/host/updates/pin': (body) => ({
      ok: true,
      pluginId: body.pluginId,
      pinned: body.pinned,
      plugins: []
    }),
    '/host/host-settings': (body) => ({ ok: true, values: body.values })
  });

  const runtime = createHostRuntime({
    document: doc,
    fetch: fetchFn,
    bridgePort: 39112,
    hostToken: 'tok-2',
    anchorsRegistry: buildTestAnchors(),
    hostSettings: { injectNativeSettings: false }
  });

  try {
    await runtime.openSettings({ tab: 'plugins' });
    await flushAsync();
    const shadow = doc.getElementById('agy-daddy-host').shadowRoot;

    // 1. Update settings controls persistence
    const channelSel = shadow.querySelector('#agy-update-channel-select');
    channelSel.value = 'next';
    channelSel.dispatchEvent({ type: 'change' });
    await flushAsync();

    const modeSel = shadow.querySelector('#agy-auto-update-mode-select');
    modeSel.value = 'manual';
    modeSel.dispatchEvent({ type: 'change' });
    await flushAsync();
    assert.equal(shadow.querySelector('#agy-update-interval-select').disabled, true);

    const regInput = shadow.querySelector('#agy-npm-registry-input');
    regInput.value = 'ftp://invalid.example.com';
    regInput.dispatchEvent({ type: 'input' });
    shadow.querySelector('#agy-npm-registry-save-btn').click();
    assert.match(shadow.querySelector('#agy-manage-toast').textContent, /http:\/\/ 或 https:\/\//);

    const regInput2 = shadow.querySelector('#agy-npm-registry-input');
    regInput2.value = 'https://registry.npmmirror.com/';
    regInput2.dispatchEvent({ type: 'input' });
    shadow.querySelector('#agy-npm-registry-save-btn').click();
    await flushAsync();

    const hostSettingCalls = calls.filter((c) => c.path === '/host/host-settings');
    assert.ok(hostSettingCalls.some((c) => c.body.values.updateChannel === 'next'));
    assert.ok(hostSettingCalls.some((c) => c.body.values.autoUpdateMode === 'manual'));
    assert.ok(hostSettingCalls.some((c) => c.body.values.npmRegistryUrl === 'https://registry.npmmirror.com'));

    // 2. Review update opens detail view, shows permission/major confirmation flow
    const reviewBtn = shadow.querySelector('[data-plugin-review-update="third.sample"]');
    assert.ok(reviewBtn);
    reviewBtn.click();
    assert.ok(shadow.querySelector('#agy-plugin-update-card'));
    assert.match(shadow.querySelector('#agy-plugin-update-card').textContent, /T2 第三方插件禁止静默自动更新/);

    // Pin toggle
    const pinInput = shadow.querySelector('[data-plugin-pin-update="third.sample"]');
    pinInput.checked = true;
    pinInput.dispatchEvent({ type: 'change' });
    await flushAsync();
    assert.ok(calls.some((c) => c.path === '/host/updates/pin' && c.body.pinned === true));

    // Apply update -> triggers permission & major confirmation box
    shadow.querySelector('[data-plugin-apply-update="third.sample"]').click();
    await flushAsync();
    const confirmBox = shadow.querySelector('#agy-update-confirm-box');
    assert.ok(confirmBox);
    assert.match(confirmBox.textContent, /process:spawn \(高危\)/);
    assert.match(confirmBox.textContent, /跨大版本升级/);

    // Approve confirmation -> retries with allowMajor and merged permissions + triggers restart banner
    shadow.querySelector('#agy-update-confirm-btn').click();
    await flushAsync();
    const applyCalls = calls.filter((c) => c.path === '/host/updates/apply');
    assert.equal(applyCalls.length, 2);
    assert.equal(applyCalls[1].body.allowMajor, true);
    assert.deepEqual(applyCalls[1].body.grantedPermissions['third.sample'], ['dom:read', 'process:spawn']);
    assert.ok(shadow.querySelector('#agy-host-restart-banner'));

    // Rollback button shows immediate loading spinner
    const rbBtn = shadow.querySelector('[data-plugin-rollback="third.sample"]');
    rbBtn.click();
    const rbBtnBusy = shadow.querySelector('[data-plugin-rollback="third.sample"]');
    assert.equal(rbBtnBusy.disabled, true);
    assert.match(rbBtnBusy.textContent, /回滚中/);
    assert.ok(rbBtnBusy.querySelector('.ag-spinner'));
    rollbackDeferred.resolve({ ok: true, target: 'third.sample', restoredVersion: '0.9.0', plugins: [] });
    await flushAsync();
    assert.match(shadow.querySelector('#agy-manage-toast').textContent, /0\.9\.0/);

    // 3. Bus state:host.updates@1 clears dot when availableCount reaches 0
    runtime.setStickyState('state:host.updates@1', { availableCount: 0, hostAvailable: false });
    assert.equal(shadow.querySelector('#agy-update-dot').hidden, true);
  } finally {
    await runtime.dispose();
  }
});
