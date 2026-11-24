(function (root) {
  'use strict';

  const HEAT_PRESETS = {
    system: {
      dark: ['#27272a', '#3f3f46', '#52525b', '#a1a1aa', '#e4e4e7'],
      light: ['#e4e4e7', '#d4d4d8', '#a1a1aa', '#52525b', '#18181b'],
      accentDark: '#e4e4e7',
      accentLight: '#18181b'
    },
    purple: {
      dark: ['#27272a', '#3f3f46', '#52525b', '#a1a1aa', '#e4e4e7'],
      light: ['#e4e4e7', '#d4d4d8', '#a1a1aa', '#52525b', '#18181b'],
      accentDark: '#e4e4e7',
      accentLight: '#18181b'
    },
    yellow: {
      dark: ['#27272a', '#3f3f46', '#52525b', '#a1a1aa', '#e4e4e7'],
      light: ['#e4e4e7', '#d4d4d8', '#a1a1aa', '#52525b', '#18181b'],
      accentDark: '#e4e4e7',
      accentLight: '#18181b'
    },
    green: {
      dark: ['#27272a', '#3f3f46', '#52525b', '#a1a1aa', '#e4e4e7'],
      light: ['#e4e4e7', '#d4d4d8', '#a1a1aa', '#52525b', '#18181b'],
      accentDark: '#e4e4e7',
      accentLight: '#18181b'
    },
    blue: {
      dark: ['#27272a', '#3f3f46', '#52525b', '#a1a1aa', '#e4e4e7'],
      light: ['#e4e4e7', '#d4d4d8', '#a1a1aa', '#52525b', '#18181b'],
      accentDark: '#e4e4e7',
      accentLight: '#18181b'
    },
    red: {
      dark: ['#27272a', '#3f3f46', '#52525b', '#a1a1aa', '#e4e4e7'],
      light: ['#e4e4e7', '#d4d4d8', '#a1a1aa', '#52525b', '#18181b'],
      accentDark: '#e4e4e7',
      accentLight: '#18181b'
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
    return `rgba(113, 113, 122, ${alpha})`;
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
      '--ag-accent-bg': isLight ? 'var(--secondary, rgba(10, 10, 12, 0.06))' : 'var(--secondary, rgba(255, 255, 255, 0.08))',
      '--ag-accent-bg-hover': isLight ? 'var(--sidebar-secondary, rgba(10, 10, 12, 0.09))' : 'var(--sidebar-secondary, rgba(255, 255, 255, 0.13))',
      '--ag-accent-border': isLight ? 'rgba(10, 10, 12, 0.14)' : 'rgba(255, 255, 255, 0.16)',
      '--ag-accent-border-hover': isLight ? 'rgba(10, 10, 12, 0.24)' : 'rgba(255, 255, 255, 0.28)',
      '--ag-bg-panel': isLight ? 'var(--background, #ffffff)' : 'var(--background, #101010)',
      '--ag-border-panel': isLight ? 'var(--border, rgba(10, 10, 12, 0.08))' : 'var(--border, rgba(255, 255, 255, 0.10))',
      '--ag-bg-card': isLight ? 'var(--card, #ffffff)' : 'var(--card, #191919)',
      '--ag-border-card': isLight ? 'var(--border, rgba(10, 10, 12, 0.08))' : 'var(--border, rgba(255, 255, 255, 0.09))',
      '--ag-bg-subcard': isLight ? 'var(--muted, rgba(10, 10, 12, 0.038))' : 'var(--muted, rgba(255, 255, 255, 0.04))',
      '--ag-border-subcard': isLight ? 'var(--border, rgba(10, 10, 12, 0.075))' : 'var(--border, rgba(255, 255, 255, 0.09))',
      '--ag-bg-input': isLight ? 'var(--muted, rgba(10, 10, 12, 0.04))' : 'var(--secondary, rgba(255, 255, 255, 0.06))',
      '--ag-text-primary': isLight ? 'var(--foreground, #0a0a0c)' : 'var(--foreground, #e4e4e7)',
      '--ag-text-secondary': isLight ? 'var(--secondary-foreground, #3f3f46)' : 'var(--secondary-foreground, #a1a1aa)',
      '--ag-text-muted': isLight ? 'var(--muted-foreground, #71717a)' : 'var(--muted-foreground, #91919a)',
      '--ag-ring-warn': '#f59e0b',
      '--ag-ring-danger': '#ef4444'
    };
  }

  function applyThemeVariables(doc, hostEl, prefs = {}) {
    const presetName = HEAT_PRESETS[prefs.heatPreset] ? prefs.heatPreset : 'system';
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
    hexToRgba,
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
