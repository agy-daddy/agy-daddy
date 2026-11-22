'use strict';

let disposers = [];

async function activate(host) {
  let count = 0;
  const stopSvc = host.services.provide('hello', {
    greet(name = 'Agy-Daddy') {
      count++;
      const out = { ok: true, message: `Hello, ${name}!`, count };
      host.state.set('state:hello.greeting@1', out);
      return out;
    }
  }, { realm: 'node', version: '1.0.0' });

  const stopRoute = await host.bridge.registerRoute('/greet', async () => ({
    ok: true,
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
