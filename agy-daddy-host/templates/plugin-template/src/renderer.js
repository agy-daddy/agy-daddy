'use strict';

const { HELLO_STYLES } = require('./styles');

const DEFAULT_SETTINGS = Object.freeze({
  enabledGreeting: true,
  prefix: 'Hi'
});

let disposers = [];

function mount(ctx) {
  let settings = {
    ...DEFAULT_SETTINGS,
    ...(ctx.settings?.get?.() || {})
  };

  const stopStyles = ctx.styles?.inject?.(HELLO_STYLES, {
    scope: 'shadow',
    id: 'hello-badge-styles'
  });

  let removeUnit = null;

  function syncUnit() {
    if (settings.enabledGreeting === false) {
      if (typeof removeUnit === 'function') {
        try { removeUnit(); } catch {}
        removeUnit = null;
      }
      return;
    }
    const label = settings.prefix ? `${settings.prefix}` : 'Hello';
    if (!removeUnit) {
      removeUnit = ctx.topbar.registerUnit({
        id: 'hello-badge',
        order: 90,
        label,
        tone: 'accent',
        onClick: () => {
          void ctx.commands?.execute?.('hello.greet', ['Agy']).catch?.(() => {});
        }
      });
    } else {
      void ctx.topbar.updateUnit?.('hello-badge', { label, tone: 'accent' })?.catch?.(() => {});
    }
  }

  syncUnit();

  const stopSettings = ctx.settings?.onChange?.((nextValues) => {
    settings = { ...DEFAULT_SETTINGS, ...(nextValues || {}) };
    syncUnit();
  });

  const stopTimer = ctx.schedule.every(10000, () => {});
  const stopAnchor = ctx.anchors.observe('topbar.rightCluster', () => {});
  const stopState = ctx.state.subscribe('state:hello.greeting@1', () => {});

  disposers.push(
    () => { if (typeof removeUnit === 'function') removeUnit(); removeUnit = null; },
    stopSettings,
    stopStyles,
    stopTimer,
    stopAnchor,
    stopState
  );
}

function dispose() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = { mount, dispose };
