'use strict';

const {
  DEFAULT_SETTINGS,
  EVENT_VIEWER_MODE_CHANGED,
  EVENT_DIFF_OPENED
} = require('./constants');
const { createTranslator } = require('./i18n');
const { createTakeoverController } = require('./ui/takeover-controller');
const { mountMediaViewer } = require('./ui/media-viewer');
const { mountCsvViewer } = require('./ui/csv-viewer');
const { mountSvgViewer } = require('./ui/svg-viewer');
const { mountFontViewer } = require('./ui/font-viewer');
const { mountDiffStage, createWorkspaceDiffDrawer } = require('./ui/git-diff-viewer');

let activeInstance = null;

async function mount(ctx) {
  dispose();

  const doc = globalThis.document;
  const t = createTranslator(doc);
  let disposed = false;
  const disposers = [];

  let currentSettings = {
    ...DEFAULT_SETTINGS,
    ...(ctx?.settings?.get?.() || {})
  };

  const getSettings = () => currentSettings;

  const drawer = createWorkspaceDiffDrawer({
    ctx,
    doc,
    t,
    getSettings,
    onOpenFileInOmni: () => {
      void controller.switchToOmni();
    }
  });

  const controller = createTakeoverController({
    ctx,
    doc,
    t,
    getSettings,
    viewers: {
      mountMediaViewer,
      mountCsvViewer,
      mountSvgViewer,
      mountFontViewer,
      mountDiffStage
    }
  });

  if (ctx?.settings?.onChange) {
    disposers.push(ctx.settings.onChange((nextValues) => {
      if (disposed) return;
      currentSettings = { ...DEFAULT_SETTINGS, ...(nextValues || {}) };
      if (!currentSettings.enabled || currentSettings.enableGitDiff === false) {
        drawer.close();
      }
      void controller.onSettingsChanged();
    }));
  }

  if (ctx?.events?.on) {
    disposers.push(ctx.events.on(EVENT_VIEWER_MODE_CHANGED, (payload) => {
      if (disposed) return;
      if (payload?.requestedAction === 'toggle') {
        void controller.toggleCurrentMode();
      }
    }));

    disposers.push(ctx.events.on(EVENT_DIFF_OPENED, (payload) => {
      if (disposed) return;
      if (payload?.source === 'renderer') return;
      if (!currentSettings.enabled || currentSettings.enableGitDiff === false) return;
      void drawer.open({
        rootHint: payload?.rootHint || '',
        anchorHeaderEl: ctx.anchors.query('fileViewer.header')
      });
    }));
  }

  if (ctx?.services?.provide) {
    disposers.push(ctx.services.provide('viewer', {
      toggleMode: () => controller.toggleCurrentMode(),
      switchToNative: () => controller.switchToNative(),
      switchToOmni: () => controller.switchToOmni(),
      openFileDiff: () => controller.openDiffForCurrent(),
      inspectCurrent: () => controller.refresh(),
      openDiffDrawer: (opts = {}) => drawer.open({
        ...(opts || {}),
        anchorHeaderEl: ctx.anchors.query('fileViewer.header')
      }),
      closeDiffDrawer: () => drawer.close(),
      getState: () => ({
        ...controller.getState(),
        drawerOpen: drawer.isOpen()
      })
    }));
  }

  activeInstance = {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const fn of disposers) {
        try { if (typeof fn === 'function') fn(); } catch {}
      }
      disposers.length = 0;
      drawer.dispose();
      controller.dispose();
    }
  };

  return activeInstance;
}

function dispose() {
  if (activeInstance) {
    const inst = activeInstance;
    activeInstance = null;
    inst.dispose();
  }
}

function isMounted() {
  return Boolean(activeInstance);
}

module.exports = {
  mount,
  dispose,
  isMounted
};
