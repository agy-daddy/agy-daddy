'use strict';

const {
  DEFAULT_SETTINGS,
  OPTICAL_PRESETS,
  CODE_HIGHLIGHT_THEMES,
  normalizeThemeSettings
} = require('./presets');

let disposers = [];

async function activate(host) {
  function readConfig() {
    return normalizeThemeSettings(host.settings?.get?.() || {});
  }

  let config = readConfig();
  let syncingSettings = false;

  function publishState() {
    host.state.set('state:theme.config@1', {
      ...config,
      presets: Object.keys(OPTICAL_PRESETS),
      codeThemes: Object.keys(CODE_HIGHLIGHT_THEMES)
    });
  }

  async function applyPatch(patch = {}) {
    const candidate = normalizeThemeSettings({ ...config, ...(patch || {}) });
    syncingSettings = true;
    try {
      const res = await host.settings.update(candidate);
      if (res && res.ok === false) {
        return { ok: false, errors: res.errors || ['SETTINGS_UPDATE_FAILED'], config: { ...config } };
      }
      config = normalizeThemeSettings(res?.values || candidate);
      publishState();
      return { ok: true, config: { ...config } };
    } finally {
      syncingSettings = false;
    }
  }

  const stopSettingsSub = host.settings.onChange((nextValues) => {
    if (syncingSettings) return;
    config = normalizeThemeSettings(nextValues || {});
    publishState();
  });

  const serviceMethods = {
    getConfig() {
      config = readConfig();
      return { ...config };
    },
    getPresets() {
      return {
        presets: Object.values(OPTICAL_PRESETS)
          .filter(Boolean)
          .map((p) => ({ id: p.id, mode: p.mode, label: p.label })),
        codeThemes: Object.keys(CODE_HIGHLIGHT_THEMES)
      };
    },
    async updateConfig(patch = {}) {
      return await applyPatch(patch);
    },
    async setPreset(presetId = 'native') {
      const nextPreset = Object.prototype.hasOwnProperty.call(OPTICAL_PRESETS, presetId)
        ? presetId
        : 'native';
      return await applyPatch({
        enabled: nextPreset !== 'native' ? true : config.enabled,
        preset: nextPreset
      });
    },
    async toggleEnabled(force) {
      const nextEnabled = typeof force === 'boolean' ? force : !config.enabled;
      const res = await applyPatch({ enabled: nextEnabled });
      return {
        ...res,
        message: nextEnabled ? '已启用视觉主题增强' : '已关闭并回退至宿主原生外观'
      };
    },
    async togglePowerSave(force) {
      const nextPowerSave = typeof force === 'boolean' ? force : !config.powerSaveMode;
      const res = await applyPatch({
        enabled: nextPowerSave ? true : config.enabled,
        powerSaveMode: nextPowerSave
      });
      return {
        ...res,
        message: nextPowerSave ? '已开启静默省电模式' : '已关闭静默省电模式'
      };
    },
    async resetToNative() {
      const res = await applyPatch({ ...DEFAULT_SETTINGS });
      return {
        ...res,
        message: '已恢复至宿主原生外观（全部自定义已清零）'
      };
    }
  };

  const stopService = await host.services.provide('theme', serviceMethods, {
    realm: 'node',
    version: '1.0.0'
  });

  const stopCmdToggle = await host.commands.register('theme.toggle-enabled', async (force) => {
    return await serviceMethods.toggleEnabled(typeof force === 'boolean' ? force : undefined);
  });

  const stopCmdPreset = await host.commands.register('theme.set-preset', async (presetId) => {
    return await serviceMethods.setPreset(typeof presetId === 'string' ? presetId : 'native');
  });

  const stopCmdPowerSave = await host.commands.register('theme.toggle-power-save', async (force) => {
    return await serviceMethods.togglePowerSave(typeof force === 'boolean' ? force : undefined);
  });

  const stopCmdReset = await host.commands.register('theme.reset-native', async () => {
    return await serviceMethods.resetToNative();
  });

  publishState();

  disposers.push(
    stopSettingsSub,
    stopService,
    stopCmdToggle,
    stopCmdPreset,
    stopCmdPowerSave,
    stopCmdReset
  );
}

async function deactivate() {
  for (const fn of disposers) {
    try {
      if (typeof fn === 'function') fn();
    } catch {}
  }
  disposers = [];
}

module.exports = { activate, deactivate };
