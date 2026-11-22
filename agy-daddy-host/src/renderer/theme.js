(function (root) {
  'use strict';

  const HEAT_PRESETS = {
    purple: {
      dark: ['#27272a', '#3f1e6b', '#652ab7', '#9053f8', '#c084fc'],
      light: ['#e4e4e7', '#e9d5ff', '#c084fc', '#9333ea', '#6b21a8'],
      accentDark: '#a78bfa',
      accentLight: '#7c3aed'
    },
    yellow: {
      dark: ['#27272a', '#713f12', '#a16207', '#eab308', '#fde047'],
      light: ['#e4e4e7', '#fef08a', '#facc15', '#ca8a04', '#854d0e'],
      accentDark: '#eab308',
      accentLight: '#ca8a04'
    },
    green: {
      dark: ['#27272a', '#14532d', '#15803d', '#22c55e', '#86efac'],
      light: ['#e4e4e7', '#bbf7d0', '#4ade80', '#16a34a', '#14532d'],
      accentDark: '#22c55e',
      accentLight: '#16a34a'
    },
    blue: {
      dark: ['#27272a', '#1e3a8a', '#1d4ed8', '#3b82f6', '#93c5fd'],
      light: ['#e4e4e7', '#bfdbfe', '#60a5fa', '#2563eb', '#1e3a8a'],
      accentDark: '#3b82f6',
      accentLight: '#2563eb'
    },
    red: {
      dark: ['#27272a', '#7f1d1d', '#b91c1c', '#ef4444', '#fca5a5'],
      light: ['#e4e4e7', '#fecaca', '#f87171', '#dc2626', '#7f1d1d'],
      accentDark: '#ef4444',
      accentLight: '#dc2626'
    }
  };

  const COLOR_SLOTS = {
    panelBg: '--ag-custom-panel-bg',
    ringUsed: '--ag-custom-ring-used',
    ringTrack: '--ag-custom-ring-track',
    contextText: '--ag-custom-context-text',
    speedText: '--ag-custom-speed',
    tokenTotal: '--ag-custom-token-total',
    tokenAccent: '--ag-custom-token-accent',
    heatLow: '--ag-custom-heat-low',
    heatHigh: '--ag-custom-heat-high',
    heatLvl0: '--ag-custom-heat-lvl-0',
    heatLvl1: '--ag-custom-heat-lvl-1',
    heatLvl2: '--ag-custom-heat-lvl-2',
    heatLvl3: '--ag-custom-heat-lvl-3',
    heatLvl4: '--ag-custom-heat-lvl-4'
  };

  function hexToRgba(hex, alpha) {
    const clean = String(hex || '').trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(clean)) {
      const r = parseInt(clean[0] + clean[0], 16);
      const g = parseInt(clean[1] + clean[1], 16);
      const b = parseInt(clean[2] + clean[2], 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    if (/^[0-9a-f]{6}$/i.test(clean)) {
      const r = parseInt(clean.slice(0, 2), 16);
      const g = parseInt(clean.slice(2, 4), 16);
      const b = parseInt(clean.slice(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    return `rgba(167, 139, 250, ${alpha})`;
  }

  function detectHostPrefersLight(doc, win) {
    const targets = [doc?.body, doc?.documentElement].filter(Boolean);
    for (const el of targets) {
      const cls = String(el.className || '');
      const attrTheme = typeof el.getAttribute === 'function' ? String(el.getAttribute('data-theme') || '') : '';
      const combined = `${cls} ${attrTheme}`;
      if (/(?:^|\s)(?:theme-light|vscode-light|light)(?:\s|$)/i.test(combined)) return true;
      if (/(?:^|\s)(?:theme-dark|vscode-dark|dark)(?:\s|$)/i.test(combined)) return false;
    }
    const gcs = win && typeof win.getComputedStyle === 'function' ? win.getComputedStyle.bind(win) : null;
    if (gcs) {
      for (const el of targets) {
        try {
          const bg = String(gcs(el).backgroundColor || '');
          const m = bg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?\s*\)/i);
          if (m) {
            const alpha = m[4] !== undefined ? Number(m[4]) : 1;
            if (alpha > 0.05) {
              const luma = 0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3]);
              return luma > 140;
            }
          }
        } catch {}
      }
    }
    try {
      if (win && typeof win.matchMedia === 'function') {
        return Boolean(win.matchMedia('(prefers-color-scheme: light)')?.matches);
      }
    } catch {}
    return false;
  }

  function resolveEffectiveThemeMode(mode = 'auto', prefersLight = false) {
    if (mode === 'light') return 'light';
    if (mode === 'dark') return 'dark';
    return prefersLight ? 'light' : 'dark';
  }

  function buildSurfaceTokens(effectiveMode, effectiveAccent) {
    const isLight = effectiveMode === 'light';
    return {
      '--ag-effective-accent': effectiveAccent,
      '--ag-custom-token-accent': effectiveAccent,
      '--ag-token-accent-default': effectiveAccent,
      '--ag-accent-bg': hexToRgba(effectiveAccent, isLight ? 0.11 : 0.15),
      '--ag-accent-bg-hover': hexToRgba(effectiveAccent, isLight ? 0.19 : 0.25),
      '--ag-accent-border': hexToRgba(effectiveAccent, isLight ? 0.30 : 0.36),
      '--ag-accent-border-hover': hexToRgba(effectiveAccent, isLight ? 0.50 : 0.58),
      '--ag-bg-panel': isLight ? '#ffffff' : '#18181b',
      '--ag-border-panel': isLight ? 'rgba(15, 23, 42, 0.12)' : 'rgba(255, 255, 255, 0.12)',
      '--ag-bg-card': isLight ? 'rgba(15, 23, 42, 0.028)' : 'rgba(255, 255, 255, 0.03)',
      '--ag-border-card': isLight ? 'rgba(15, 23, 42, 0.09)' : 'rgba(255, 255, 255, 0.09)',
      '--ag-bg-subcard': isLight ? 'rgba(15, 23, 42, 0.045)' : 'rgba(255, 255, 255, 0.05)',
      '--ag-border-subcard': isLight ? 'rgba(15, 23, 42, 0.10)' : 'rgba(255, 255, 255, 0.10)',
      '--ag-bg-input': isLight ? 'rgba(15, 23, 42, 0.04)' : 'rgba(255, 255, 255, 0.06)',
      '--ag-text-primary': isLight ? '#18181b' : '#ececef',
      '--ag-text-secondary': isLight ? '#3f3f46' : '#c8c8d0',
      '--ag-text-muted': isLight ? '#71717a' : '#a1a1aa',
      '--ag-ring-warn': '#f59e0b',
      '--ag-ring-danger': '#ef4444'
    };
  }

  function applyThemeVariables(doc, hostEl, prefs = {}) {
    const presetName = HEAT_PRESETS[prefs.heatPreset] ? prefs.heatPreset : 'purple';
    const preset = HEAT_PRESETS[presetName];
    const winRef = prefs.window || (typeof root.window !== 'undefined' ? root.window : null);
    const prefersLight = prefs.prefersLight !== undefined
      ? Boolean(prefs.prefersLight)
      : detectHostPrefersLight(doc, winRef);
    const effectiveMode = resolveEffectiveThemeMode(prefs.themeMode || 'auto', prefersLight);
    const levels = effectiveMode === 'light' ? preset.light : preset.dark;
    const defaultAccent = effectiveMode === 'light' ? preset.accentLight : preset.accentDark;
    const customColors = (prefs.customColors && typeof prefs.customColors === 'object') ? prefs.customColors : {};
    const effectiveAccent = customColors.tokenAccent || defaultAccent;
    const surfaceTokens = buildSurfaceTokens(effectiveMode, effectiveAccent);

    const applyTo = (el) => {
      if (!el || !el.style || typeof el.style.setProperty !== 'function') return;
      for (const [varName, varVal] of Object.entries(surfaceTokens)) {
        el.style.setProperty(varName, varVal);
      }
      for (let i = 0; i < 5; i++) {
        const key = `heatLvl${i}`;
        el.style.setProperty(COLOR_SLOTS[key], customColors[key] || levels[i]);
      }
      for (const [k, cssVar] of Object.entries(COLOR_SLOTS)) {
        if (customColors[k]) {
          el.style.setProperty(cssVar, customColors[k]);
        }
      }
    };

    if (doc?.documentElement) {
      applyTo(doc.documentElement);
      doc.documentElement.setAttribute?.('data-agy-theme', effectiveMode);
    }
    if (hostEl) {
      applyTo(hostEl);
      hostEl.setAttribute?.('data-theme', effectiveMode);
      hostEl.setAttribute?.('data-preset', presetName);
    }

    return {
      heatPreset: presetName,
      themeMode: prefs.themeMode || 'auto',
      effectiveMode,
      accent: effectiveAccent,
      heatLevels: levels
    };
  }

  const themeApi = {
    HEAT_PRESETS,
    COLOR_SLOTS,
    detectHostPrefersLight,
    resolveEffectiveThemeMode,
    applyThemeVariables
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = themeApi;
  } else {
    root.__AGYThemeEngine = themeApi;
  }
})(globalThis);
