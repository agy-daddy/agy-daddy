'use strict';

const { createPetCanvasStage } = require('./shared/pet-canvas-stage');
const { getBuiltinThemes, getBuiltinThemeById } = require('./shared/themes');

let disposers = [];

async function mount(ctx) {
  dispose();

  const doc = globalThis.document;
  let latestSnapshot = null;
  let panelEl = null;
  let canvasStage = null;
  let lastSessionKey = '';

  const stopStyles = ctx.styles.inject(`
    #agy-pet-panel {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 10px 12px;
      color: var(--ag-text-primary, #e4e4e7);
      font-size: 12px;
    }
    .ag-pet-preview-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px;
      border-radius: 10px;
      background: rgba(167, 139, 250, 0.08);
      border: 1px solid rgba(167, 139, 250, 0.22);
    }
    .ag-pet-btn-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .ag-pet-btn {
      padding: 5px 10px;
      border-radius: 8px;
      border: 1px solid var(--ag-custom-token-accent, var(--ag-token-accent-default, #a78bfa));
      background: rgba(167, 139, 250, 0.14);
      color: inherit;
      cursor: pointer;
      font-size: 11px;
    }
    .ag-pet-themes {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
    }
    .ag-pet-theme-btn {
      padding: 5px 6px;
      border-radius: 7px;
      border: 1px solid rgba(161, 161, 170, 0.25);
      background: transparent;
      color: inherit;
      cursor: pointer;
      font-size: 11px;
      text-align: left;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ag-pet-theme-btn[data-active="true"] {
      border-color: var(--ag-custom-token-accent, var(--ag-token-accent-default, #a78bfa));
      background: rgba(167, 139, 250, 0.18);
    }
  `, { scope: 'shadow', id: 'pet-panel-styles' });

  function renderPanel() {
    if (!panelEl) return;
    panelEl.textContent = '';

    const petState = latestSnapshot?.state || {};
    const curThemeId = petState.themeId || ctx.settings?.get?.()?.themeId || 'daddy-orb';
    const curTheme = getBuiltinThemeById(curThemeId);
    const themes = Array.isArray(latestSnapshot?.themes) && latestSnapshot.themes.length > 0
      ? latestSnapshot.themes
      : getBuiltinThemes();

    const previewRow = doc.createElement('div');
    previewRow.className = 'ag-pet-preview-row';

    if (typeof doc.createElement === 'function') {
      const canvas = doc.createElement('canvas');
      canvas.width = 96;
      canvas.height = 96;
      previewRow.appendChild(canvas);
      if (canvasStage) canvasStage.dispose();
      canvasStage = createPetCanvasStage(canvas, {
        width: 96,
        height: 96,
        scene: latestSnapshot?.scene || curTheme.scene,
        state: {
          animState: petState.motion?.animState || 'idle',
          speedFactor: petState.motion?.speedFactor || 1.0
        }
      });
      canvasStage.start();
    }

    const meta = doc.createElement('div');
    const title = doc.createElement('div');
    title.textContent = `${curTheme.name?.['zh-CN'] || curThemeId}`;
    const sub = doc.createElement('div');
    const tpsStr = petState.motion?.tps != null ? ` · ${petState.motion.tps} tok/s` : '';
    sub.textContent = `状态：${petState.motion?.animState || 'idle'}${tpsStr}`;
    meta.appendChild(title);
    meta.appendChild(sub);
    previewRow.appendChild(meta);
    panelEl.appendChild(previewRow);

    const btnRow = doc.createElement('div');
    btnRow.className = 'ag-pet-btn-row';

    const toggleDeskBtn = doc.createElement('button');
    toggleDeskBtn.type = 'button';
    toggleDeskBtn.className = 'ag-pet-btn';
    toggleDeskBtn.textContent = petState.desktopVisible !== false ? '桌面置顶：开' : '桌面置顶：关';
    toggleDeskBtn.addEventListener('click', () => {
      void ctx.commands?.execute?.('pet.toggleDesktop');
    });

    const toggleWebBtn = doc.createElement('button');
    toggleWebBtn.type = 'button';
    toggleWebBtn.className = 'ag-pet-btn';
    toggleWebBtn.textContent = petState.webVisible !== false ? 'PC-Web：开' : 'PC-Web：关';
    toggleWebBtn.addEventListener('click', () => {
      void ctx.commands?.execute?.('pet.toggleWeb');
    });

    const openSettingsBtn = doc.createElement('button');
    openSettingsBtn.type = 'button';
    openSettingsBtn.className = 'ag-pet-btn';
    openSettingsBtn.textContent = '完整设置与白名单';
    openSettingsBtn.addEventListener('click', () => {
      void ctx.settings?.open?.({ pluginId: ctx.pluginId });
    });

    btnRow.appendChild(toggleDeskBtn);
    btnRow.appendChild(toggleWebBtn);
    btnRow.appendChild(openSettingsBtn);
    panelEl.appendChild(btnRow);

    const grid = doc.createElement('div');
    grid.className = 'ag-pet-themes';
    for (const th of themes.slice(0, 15)) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'ag-pet-theme-btn';
      b.setAttribute('data-active', th.id === curThemeId ? 'true' : 'false');
      b.textContent = th.name?.['zh-CN'] || th.name?.en || th.id;
      b.addEventListener('click', () => {
        void ctx.settings?.update?.({ themeId: th.id });
      });
      grid.appendChild(b);
    }
    panelEl.appendChild(grid);
  }

  function syncActiveSession() {
    const cascadeId = ctx.hostDom?.getSessionId?.() || null;
    const busy = Boolean(ctx.hostDom?.isAssistantBusy?.());
    const key = `${cascadeId || ''}:${busy ? 1 : 0}`;
    if (key === lastSessionKey) return;
    lastSessionKey = key;
    Promise.resolve(ctx.bridge?.post?.('/active-session', { cascadeId, busy })).catch(() => {});
  }

  const stopUnit = ctx.topbar.registerUnit({
    id: 'pet-chip',
    order: 35,
    label: '桌宠',
    iconSvg: '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><circle cx="8" cy="8" r="5"/></svg>',
    title: '桌面与 PC-Web 伴侣宠物'
  });

  const popoverHandle = ctx.topbar.registerPopover({
    id: 'pet-panel',
    anchorId: 'pet-chip',
    title: '伴侣宠物控制台',
    render(node) {
      panelEl = node;
      panelEl.id = 'agy-pet-panel';
      renderPanel();
    }
  });

  const stopStateSub = ctx.state?.subscribe?.('state:pet.state@1', () => {
    void Promise.resolve(ctx.bridge?.post?.('/state', {}))
      .then((snap) => {
        if (snap && snap.ok) {
          latestSnapshot = snap;
          renderPanel();
        }
      })
      .catch(() => {});
  });

  const stopActivePoll = ctx.schedule.every(1000, () => {
    syncActiveSession();
  });

  syncActiveSession();
  try {
    latestSnapshot = await ctx.bridge.post('/state', {});
  } catch {}

  disposers.push(
    stopStyles,
    stopUnit,
    () => popoverHandle?.dispose?.(),
    () => { if (typeof stopStateSub === 'function') stopStateSub(); },
    () => { if (typeof stopActivePoll === 'function') stopActivePoll(); },
    () => { if (canvasStage) { canvasStage.dispose(); canvasStage = null; } }
  );
}

function dispose() {
  for (const fn of disposers.splice(0)) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
}

module.exports = {
  mount,
  dispose
};
