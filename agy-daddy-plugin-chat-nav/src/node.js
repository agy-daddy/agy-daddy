'use strict';

const { readFileSafe, writeFileSafe } = require('./file-service');

let disposers = [];

async function activate(host) {
  let settings = {
    showFloatDock: true,
    keepThinkingExpanded: false,
    enableInlineFileEditor: true,
    enableCmdClickLinks: true,
    ...(host.storage.readJson('settings.json', {}).data || {})
  };

  const stopReadRoute = await host.bridge.registerRoute('/file/read', async (body) => readFileSafe(body?.path || body?.uri));
  const stopWriteRoute = await host.bridge.registerRoute('/file/write', async (body) => {
    return writeFileSafe(body?.path || body?.uri, body?.content);
  });
  const stopSettingsRoute = await host.bridge.registerRoute('/settings', async (body) => {
    if (body?.action === 'save' && body.values) {
      settings = { ...settings, ...body.values };
      host.storage.writeJson('settings.json', settings);
    }
    return { ok: true, values: settings };
  });

  disposers.push(stopReadRoute, stopWriteRoute, stopSettingsRoute);
}

async function deactivate() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = {
  activate,
  deactivate
};
