'use strict';

let disposers = [];

async function mount(ctx) {
  let settings = { terminalApp: 'auto', customTerminalPath: '', cliMuxHost: '', cliDefaultModel: '', cliSkipPermissions: false };
  try {
    const res = await ctx.bridge.post('/settings', { action: 'get' });
    if (res?.ok && res.values) settings = { ...settings, ...res.values };
  } catch {}

  const stopUnit = ctx.topbar.registerUnit({
    id: 'cli',
    order: 40,
    label: 'CLI',
    icon: 'terminal',
    onClick() {
      void ctx.bridge.post('/launch', {}).catch(() => {});
    }
  });

  const stopSection = ctx.settings.registerSection({
    id: 'cli-settings',
    title: { 'zh-CN': 'CLI 终端启动器', en: 'CLI Terminal Launcher' },
    values: settings,
    onChange(key, value) {
      settings = { ...settings, [key]: value };
      void ctx.bridge.post('/settings', { action: 'save', values: { [key]: value } }).catch(() => {});
    }
  });

  disposers.push(stopUnit, stopSection);
}

function dispose() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = {
  mount,
  dispose
};
