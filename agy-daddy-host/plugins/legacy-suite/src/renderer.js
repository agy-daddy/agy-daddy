'use strict';

let disposers = [];

function cleanupLegacyGlobals(win = globalThis) {
  const cleaned = [];
  try {
    if (typeof win.__AGEnhancer?.dispose === 'function') { win.__AGEnhancer.dispose(); cleaned.push('__AGEnhancer'); }
    delete win.__AGEnhancer;
  } catch {}
  try {
    if (typeof win.__AGY_CTX_CAPSULE_DISPOSE__ === 'function') { win.__AGY_CTX_CAPSULE_DISPOSE__(); cleaned.push('__AGY_CTX_CAPSULE__'); }
    win.__AGY_CTX_CAPSULE_ACTIVE__ = false;
  } catch {}
  try {
    if (typeof win.__antigravityZhPatchCleanup === 'function') { win.__antigravityZhPatchCleanup(); cleaned.push('__antigravityZhPatch'); }
    delete win.__antigravityZhPatchInstalled;
  } catch {}
  try {
    if (typeof win.__AGContextMeter?.dispose === 'function') { win.__AGContextMeter.dispose(); cleaned.push('__AGContextMeter'); }
    delete win.__AGContextMeter;
  } catch {}
  try { delete win.__AGContextMeterLive; } catch {}
  return cleaned;
}

async function mount(ctx, options = {}) {
  const win = options.window || globalThis;
  cleanupLegacyGlobals(win);

  const removeUnit = ctx.topbar.registerUnit({
    id: 'legacy-indicator',
    order: 99,
    label: 'Legacy',
    onClick: () => {}
  });

  if (options.liveBridgeInfo && win) {
    win.__AGContextMeterLive = {
      port: options.liveBridgeInfo.port,
      token: options.liveBridgeInfo.token
    };
  }

  if (Array.isArray(options.bundleParts) && typeof options.evalCode === 'function') {
    for (const part of options.bundleParts) {
      await options.evalCode(part.code, part.key);
    }
  }

  disposers.push(removeUnit, () => cleanupLegacyGlobals(win));
}

function dispose() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = {
  cleanupLegacyGlobals,
  mount,
  dispose
};
