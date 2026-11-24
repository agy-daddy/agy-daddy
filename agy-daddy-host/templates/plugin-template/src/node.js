'use strict';

const DEFAULT_SETTINGS = Object.freeze({
  enabledGreeting: true,
  prefix: 'Hi'
});

let disposers = [];

async function activate(host) {
  function readSettings() {
    return {
      ...DEFAULT_SETTINGS,
      ...(host.settings?.get?.() || {})
    };
  }

  let settings = readSettings();

  function formatGreeting(name = 'Agy') {
    settings = readSettings();
    return `${settings.prefix || 'Hi'}, ${name}!`;
  }

  const stopSettings = host.settings?.onChange?.((nextValues) => {
    settings = { ...DEFAULT_SETTINGS, ...(nextValues || {}) };
    host.state.set('state:hello.greeting@1', {
      ready: true,
      prefix: settings.prefix || 'Hi',
      enabledGreeting: settings.enabledGreeting !== false
    });
  });

  const stopService = await host.services.provide('hello', {
    greet(name = 'Agy') {
      return formatGreeting(name);
    }
  }, { realm: 'node', version: '1.0.0' });

  const stopCommand = await host.commands.register('hello.greet', (name = 'Agy') => {
    const message = formatGreeting(name);
    host.state.set('state:hello.greeting@1', {
      ready: true,
      prefix: settings.prefix || 'Hi',
      lastMessage: message
    });
    return { ok: true, message };
  });

  host.state.set('state:hello.greeting@1', {
    ready: true,
    prefix: settings.prefix || 'Hi',
    enabledGreeting: settings.enabledGreeting !== false
  });

  disposers.push(stopSettings, stopService, stopCommand);
}

async function deactivate() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = { activate, deactivate };
