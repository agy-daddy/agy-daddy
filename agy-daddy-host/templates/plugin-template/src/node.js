'use strict';

let disposers = [];

async function activate(host) {
  const stopService = host.services.provide('hello', {
    greet(name = 'Agy') {
      const cfg = host.storage.readJson('settings.json', { prefix: 'Hi' }).data || { prefix: 'Hi' };
      return `${cfg.prefix || 'Hi'}, ${name}!`;
    }
  }, { realm: 'node', version: '1.0.0' });

  const stopRoute = await host.bridge.registerRoute('/ping', async (body) => {
    return { ok: true, pong: body?.msg || 'hello' };
  });

  host.state.set('state:hello.greeting@1', { ready: true });
  disposers.push(stopService, stopRoute);
}

async function deactivate() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = { activate, deactivate };
