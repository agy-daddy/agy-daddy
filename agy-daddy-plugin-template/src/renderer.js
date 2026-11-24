'use strict';

const { HELLO_TEMPLATE_STYLES } = require('./styles');

const DEFAULT_SETTINGS = Object.freeze({
  greeting: 'Hello Agy-Daddy',
  showBadge: true
});

let disposers = [];

async function mount(ctx) {
  let settings = {
    ...DEFAULT_SETTINGS,
    ...(ctx.settings?.get?.() || {})
  };

  const stopStyles = ctx.styles?.inject?.(HELLO_TEMPLATE_STYLES, {
    scope: 'shadow',
    id: 'hello-template-styles'
  });

  let stopUnit = null;
  let popoverHandle = null;
  let greetingNode = null;
  let statusNode = null;

  function renderPopoverContent(bodyNode) {
    const doc = bodyNode?.ownerDocument || globalThis.document;
    if (!bodyNode || !doc?.createElement) return;
    bodyNode.innerHTML = '';

    const card = doc.createElement('div');
    card.className = 'agy-hello-card';

    greetingNode = doc.createElement('div');
    greetingNode.className = 'agy-hello-greeting';
    greetingNode.textContent = settings.greeting;
    card.appendChild(greetingNode);

    statusNode = doc.createElement('div');
    statusNode.className = 'agy-hello-meta';
    statusNode.textContent = 'Isolated World · Host-Managed Settings';
    card.appendChild(statusNode);

    const actions = doc.createElement('div');
    actions.className = 'agy-hello-actions';
    const greetBtn = doc.createElement('button');
    greetBtn.type = 'button';
    greetBtn.className = 'ag-btn ag-btn-primary';
    greetBtn.textContent = '发送问候';
    greetBtn.addEventListener('click', () => {
      void ctx.commands?.execute?.('hello.greet', ['Agy-Daddy']).then((res) => {
        if (statusNode && res?.result?.message) {
          statusNode.textContent = `${res.result.message} (#${res.result.count})`;
        }
      }).catch(() => {});
    });
    actions.appendChild(greetBtn);
    card.appendChild(actions);

    bodyNode.appendChild(card);
  }

  popoverHandle = ctx.topbar.registerPopover({
    id: 'hello-popover',
    anchorId: 'hello-badge',
    title: 'Hello 示例插件',
    render(bodyNode) {
      renderPopoverContent(bodyNode);
    }
  });

  function syncUnit() {
    if (!settings.showBadge) {
      if (typeof stopUnit === 'function') {
        try { stopUnit(); } catch {}
        stopUnit = null;
      }
      return;
    }
    if (!stopUnit) {
      stopUnit = ctx.topbar.registerUnit({
        id: 'hello-badge',
        order: 90,
        label: 'Hello',
        tone: 'accent',
        onClick() {
          void popoverHandle?.toggle?.();
        }
      });
    } else {
      void ctx.topbar.updateUnit('hello-badge', {
        label: 'Hello',
        tone: 'accent'
      }).catch?.(() => {});
    }
  }

  syncUnit();

  const stopSettings = ctx.settings?.onChange?.((nextValues) => {
    settings = { ...DEFAULT_SETTINGS, ...(nextValues || {}) };
    if (greetingNode) greetingNode.textContent = settings.greeting;
    syncUnit();
  });

  disposers.push(
    stopSettings,
    stopStyles,
    () => { if (typeof stopUnit === 'function') stopUnit(); stopUnit = null; },
    () => { popoverHandle?.dispose?.(); popoverHandle = null; },
    () => { greetingNode = null; statusNode = null; }
  );
}

function dispose() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = { mount, dispose };
