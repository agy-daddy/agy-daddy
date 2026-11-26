'use strict';

const { OPTICAL_PRESETS, normalizeThemeSettings } = require('./presets');
const { buildThemeCss } = require('./css-builder');

const STUDIO_POPOVER_STYLES = `
.agy-theme-studio-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 248px;
}
.agy-theme-studio-status {
  font-size: 11.5px;
  color: var(--ag-text-muted, #71717a);
}
.agy-theme-preset-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}
.agy-theme-preset-btn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 7px;
  border: 1px solid var(--ag-border-card, rgba(161, 161, 170, 0.2));
  background: var(--ag-bg-subcard, rgba(161, 161, 170, 0.06));
  color: var(--ag-text-primary, inherit);
  font-size: 11.5px;
  cursor: pointer;
  text-align: left;
}
.agy-theme-preset-btn[data-active="true"] {
  border-color: var(--ag-effective-accent, currentColor);
  background: var(--ag-accent-bg, rgba(161, 161, 170, 0.14));
  font-weight: 600;
}
.agy-theme-swatch {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  border: 1px solid rgba(128, 128, 128, 0.35);
  flex-shrink: 0;
}
.agy-theme-studio-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-top: 4px;
  border-top: 1px solid var(--ag-border-panel, rgba(161, 161, 170, 0.14));
}
`;

const PALETTE_ICON_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2Z"/></svg>';

let disposers = [];

async function mount(ctx) {
  let settings = normalizeThemeSettings(ctx.settings?.get?.() || {});
  let stopDocumentStyles = null;
  let stopShadowStyles = null;
  let stopStudioStyles = null;
  let stopUnit = null;
  let popoverHandle = null;
  let popoverBodyNode = null;
  let lastDocumentCss = '';
  let lastShadowCss = '';

  function applyThemeStyles() {
    const built = buildThemeCss(settings);
    if (!built.active || !built.documentCss) {
      if (typeof stopDocumentStyles === 'function') {
        try { stopDocumentStyles(); } catch {}
        stopDocumentStyles = null;
      }
      lastDocumentCss = '';
    } else if (built.documentCss !== lastDocumentCss) {
      lastDocumentCss = built.documentCss;
      stopDocumentStyles = ctx.styles?.inject?.(built.documentCss, {
        scope: 'document',
        id: 'theme-optical-sheet'
      }) || null;
    }

    if (!built.active || !built.shadowCss) {
      if (typeof stopShadowStyles === 'function') {
        try { stopShadowStyles(); } catch {}
        stopShadowStyles = null;
      }
      lastShadowCss = '';
    } else if (built.shadowCss !== lastShadowCss) {
      lastShadowCss = built.shadowCss;
      stopShadowStyles = ctx.styles?.inject?.(built.shadowCss, {
        scope: 'shadow',
        id: 'theme-shadow-tokens'
      }) || null;
    }
  }

  function renderPopoverContent(bodyNode) {
    if (!bodyNode) return;
    popoverBodyNode = bodyNode;
    const doc = bodyNode.ownerDocument || globalThis.document;
    if (!doc?.createElement) return;
    bodyNode.innerHTML = '';

    const card = doc.createElement('div');
    card.className = 'agy-theme-studio-card';

    const status = doc.createElement('div');
    status.className = 'agy-theme-studio-status';
    if (!settings.enabled) {
      status.textContent = '原生外观（零注入）';
    } else if (settings.powerSaveMode) {
      status.textContent = '静默省电模式已开启';
    } else {
      const presetObj = OPTICAL_PRESETS[settings.preset];
      status.textContent = presetObj
        ? `当前预设：${presetObj.label['zh-CN']}`
        : '原生基底 · 组件级自定义';
    }
    card.appendChild(status);

    const grid = doc.createElement('div');
    grid.className = 'agy-theme-preset-grid';
    const presetItems = [
      { id: 'native', label: '宿主原生', swatch: 'transparent' },
      ...Object.values(OPTICAL_PRESETS).filter(Boolean).map((p) => ({
        id: p.id,
        label: p.label['zh-CN'],
        swatch: p.bgBase
      }))
    ];
    for (const item of presetItems) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'agy-theme-preset-btn';
      btn.setAttribute('data-theme-preset', item.id);
      btn.setAttribute('data-active', settings.preset === item.id ? 'true' : 'false');
      const lbl = doc.createElement('span');
      lbl.textContent = item.label;
      btn.appendChild(lbl);
      const sw = doc.createElement('span');
      sw.className = 'agy-theme-swatch';
      sw.style?.setProperty?.('background', item.swatch);
      btn.appendChild(sw);
      btn.addEventListener('click', () => {
        void ctx.commands?.execute?.('theme.set-preset', [item.id]).catch(() => {});
      });
      grid.appendChild(btn);
    }
    card.appendChild(grid);

    const actions = doc.createElement('div');
    actions.className = 'agy-theme-studio-actions';

    const powerBtn = doc.createElement('button');
    powerBtn.type = 'button';
    powerBtn.className = 'ag-btn';
    powerBtn.textContent = settings.powerSaveMode ? '关闭省电模式' : '静默省电模式';
    powerBtn.addEventListener('click', () => {
      void ctx.commands?.execute?.('theme.toggle-power-save', []).catch(() => {});
    });
    actions.appendChild(powerBtn);

    const openSettingsBtn = doc.createElement('button');
    openSettingsBtn.type = 'button';
    openSettingsBtn.className = 'ag-btn ag-btn-primary';
    openSettingsBtn.textContent = '组件级定制';
    openSettingsBtn.addEventListener('click', () => {
      void ctx.settings?.open?.({ tab: 'plugins', pluginId: 'agy-daddy.theme' })?.catch?.(() => {});
    });
    actions.appendChild(openSettingsBtn);

    card.appendChild(actions);
    bodyNode.appendChild(card);
  }

  function syncTopbarControls() {
    const shouldShow = Boolean(settings.enabled && settings.showTopbarUnit);
    if (!shouldShow) {
      if (typeof stopUnit === 'function') {
        try { stopUnit(); } catch {}
        stopUnit = null;
      }
      if (popoverHandle) {
        try { popoverHandle.dispose(); } catch {}
        popoverHandle = null;
      }
      if (typeof stopStudioStyles === 'function') {
        try { stopStudioStyles(); } catch {}
        stopStudioStyles = null;
      }
      popoverBodyNode = null;
      return;
    }

    if (!stopStudioStyles) {
      stopStudioStyles = ctx.styles?.inject?.(STUDIO_POPOVER_STYLES, {
        scope: 'shadow',
        id: 'theme-studio-popover-ui'
      }) || null;
    }

    if (!popoverHandle && typeof ctx.topbar?.registerPopover === 'function') {
      popoverHandle = ctx.topbar.registerPopover({
        id: 'theme-popover',
        anchorId: 'theme-studio',
        title: '视觉主题与光学预设',
        render(bodyNode) {
          renderPopoverContent(bodyNode);
        }
      });
    }

    const presetObj = OPTICAL_PRESETS[settings.preset];
    const unitLabel = settings.powerSaveMode
      ? '省电'
      : (presetObj ? presetObj.label['zh-CN'] : '主题');

    if (!stopUnit && typeof ctx.topbar?.registerUnit === 'function') {
      stopUnit = ctx.topbar.registerUnit({
        id: 'theme-studio',
        order: 85,
        iconSvg: PALETTE_ICON_SVG,
        label: unitLabel,
        tone: 'accent',
        onClick() {
          void popoverHandle?.toggle?.();
        }
      });
    } else if (typeof ctx.topbar?.updateUnit === 'function') {
      void ctx.topbar.updateUnit('theme-studio', {
        label: unitLabel,
        tone: 'accent'
      }).catch?.(() => {});
    }

    if (popoverBodyNode) {
      renderPopoverContent(popoverBodyNode);
    }
  }

  applyThemeStyles();
  syncTopbarControls();

  const stopSettings = ctx.settings?.onChange?.((nextValues) => {
    settings = normalizeThemeSettings(nextValues || {});
    applyThemeStyles();
    syncTopbarControls();
  });

  disposers.push(
    stopSettings,
    () => {
      if (typeof stopDocumentStyles === 'function') stopDocumentStyles();
      stopDocumentStyles = null;
    },
    () => {
      if (typeof stopShadowStyles === 'function') stopShadowStyles();
      stopShadowStyles = null;
    },
    () => {
      if (typeof stopStudioStyles === 'function') stopStudioStyles();
      stopStudioStyles = null;
    },
    () => {
      if (typeof stopUnit === 'function') stopUnit();
      stopUnit = null;
    },
    () => {
      popoverHandle?.dispose?.();
      popoverHandle = null;
      popoverBodyNode = null;
    }
  );
}

function dispose() {
  for (const fn of disposers) {
    try {
      if (typeof fn === 'function') fn();
    } catch {}
  }
  disposers = [];
}

module.exports = { mount, dispose };
