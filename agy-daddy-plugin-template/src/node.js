'use strict';

const DEFAULT_SETTINGS = Object.freeze({
  greeting: 'Hello Agy-Daddy',
  showBadge: true
});

let disposers = [];

async function activate(host) {
  let count = 0;

  function readSettings() {
    return {
      ...DEFAULT_SETTINGS,
      ...(host.settings?.get?.() || {})
    };
  }

  let settings = readSettings();

  const serviceMethods = {
    greet(name = 'Agy-Daddy') {
      settings = readSettings();
      count++;
      const out = {
        ok: true,
        message: `Hello, ${name}!`,
        greeting: settings.greeting,
        count
      };
      host.state.set('state:hello.greeting@1', { ready: true, ...out });
      return out;
    },
    getSettings() {
      settings = readSettings();
      return { ...settings };
    }
  };

  const stopSettings = host.settings?.onChange?.((nextValues) => {
    settings = { ...DEFAULT_SETTINGS, ...(nextValues || {}) };
    host.state.set('state:hello.greeting@1', {
      ready: true,
      greeting: settings.greeting,
      showBadge: settings.showBadge,
      count
    });
  });

  const stopSvc = await host.services.provide('hello', serviceMethods, { realm: 'node', version: '1.0.0' });
  const stopCmd = await host.commands.register('hello.greet', (name = 'Agy-Daddy') => {
    return serviceMethods.greet(name);
  });

  host.state.set('state:hello.greeting@1', {
    ready: true,
    greeting: settings.greeting,
    showBadge: settings.showBadge,
    count
  });

  disposers.push(stopSettings, stopSvc, stopCmd);
}

async function deactivate() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = { activate, deactivate };
