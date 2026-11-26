'use strict';

/**
 * Clean-room MIT optical presets, code highlight themes, and settings normalization
 * for @agy-daddy/plugin-theme.
 *
 * Default configuration keeps Antigravity host UI 100% untouched.
 */

const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  preset: 'native',
  showTopbarUnit: false,
  syncHostCapsules: false,
  userBubbleBg: '',
  userBubbleBorder: '',
  userBubbleRadius: 0,
  assistantBubbleBg: '',
  assistantBubbleBorder: '',
  assistantBubbleRadius: 0,
  codeTheme: 'native',
  codeBlockBg: '',
  codeBlockBorder: '',
  codeBlockRadius: 0,
  terminalWellBg: '',
  terminalWellBorder: '',
  terminalWellDepth: 'native',
  artifactRadius: 0,
  artifactBorderHighlight: '',
  topbarBg: '',
  composerBg: '',
  composerRadius: 0,
  buttonAccent: '',
  buttonRadius: 0,
  powerSaveMode: false,
  dampedSpringMotion: false,
  microAnimatedIcons: false,
  semanticAfterglow: false
});

const OPTICAL_PRESETS = Object.freeze({
  native: null,
  'obsidian-void': Object.freeze({
    id: 'obsidian-void',
    mode: 'dark',
    label: { 'zh-CN': '深空黑曜', en: 'Obsidian Void' },
    bgBase: '#0b0d12',
    bgPanel: '#10141d',
    bgCard: '#151a25',
    bgSubcard: '#1b2230',
    fgPrimary: '#e2e8f0',
    fgSecondary: '#94a3b8',
    fgMuted: '#64748b',
    border: 'rgba(148, 163, 184, 0.14)',
    userBubbleBg: '#1c2436',
    userBubbleBorder: 'rgba(148, 163, 184, 0.22)',
    assistantBubbleBg: '#121722',
    assistantBubbleBorder: 'rgba(148, 163, 184, 0.12)',
    codeBlockBg: '#0d1118',
    codeBlockBorder: 'rgba(148, 163, 184, 0.16)',
    terminalWellBg: '#090c11',
    terminalWellBorder: 'rgba(148, 163, 184, 0.16)',
    artifactBorderHighlight: 'rgba(148, 163, 184, 0.28)',
    topbarBg: 'rgba(13, 17, 24, 0.88)',
    composerBg: '#131823',
    buttonAccent: '#60a5fa',
    buttonText: '#0b0d12',
    glowColor: 'rgba(96, 165, 250, 0.22)'
  }),
  'warm-basalt': Object.freeze({
    id: 'warm-basalt',
    mode: 'dark',
    label: { 'zh-CN': '暖炭玄岩', en: 'Warm Basalt' },
    bgBase: '#13110f',
    bgPanel: '#1a1714',
    bgCard: '#211d19',
    bgSubcard: '#29241e',
    fgPrimary: '#f2ede6',
    fgSecondary: '#b8ada0',
    fgMuted: '#8a7f72',
    border: 'rgba(217, 179, 130, 0.14)',
    userBubbleBg: '#2a241d',
    userBubbleBorder: 'rgba(217, 179, 130, 0.22)',
    assistantBubbleBg: '#1b1815',
    assistantBubbleBorder: 'rgba(217, 179, 130, 0.12)',
    codeBlockBg: '#15120f',
    codeBlockBorder: 'rgba(217, 179, 130, 0.16)',
    terminalWellBg: '#0f0d0b',
    terminalWellBorder: 'rgba(217, 179, 130, 0.16)',
    artifactBorderHighlight: 'rgba(234, 179, 8, 0.28)',
    topbarBg: 'rgba(22, 19, 16, 0.90)',
    composerBg: '#1e1a16',
    buttonAccent: '#d97706',
    buttonText: '#13110f',
    glowColor: 'rgba(217, 119, 6, 0.22)'
  }),
  'cool-crystal': Object.freeze({
    id: 'cool-crystal',
    mode: 'light',
    label: { 'zh-CN': '冷晶白', en: 'Cool Crystal' },
    bgBase: '#f5f7fb',
    bgPanel: '#ffffff',
    bgCard: '#ffffff',
    bgSubcard: '#eef2f7',
    fgPrimary: '#0f172a',
    fgSecondary: '#475569',
    fgMuted: '#64748b',
    border: 'rgba(15, 23, 42, 0.10)',
    userBubbleBg: '#e8eff9',
    userBubbleBorder: 'rgba(37, 99, 235, 0.18)',
    assistantBubbleBg: '#ffffff',
    assistantBubbleBorder: 'rgba(15, 23, 42, 0.09)',
    codeBlockBg: '#f1f5f9',
    codeBlockBorder: 'rgba(15, 23, 42, 0.11)',
    terminalWellBg: '#e9eef5',
    terminalWellBorder: 'rgba(15, 23, 42, 0.12)',
    artifactBorderHighlight: 'rgba(37, 99, 235, 0.26)',
    topbarBg: 'rgba(255, 255, 255, 0.90)',
    composerBg: '#ffffff',
    buttonAccent: '#2563eb',
    buttonText: '#ffffff',
    glowColor: 'rgba(37, 99, 235, 0.16)'
  }),
  'warm-album': Object.freeze({
    id: 'warm-album',
    mode: 'light',
    label: { 'zh-CN': '暖白画册', en: 'Warm Album' },
    bgBase: '#faf7f2',
    bgPanel: '#fffdf8',
    bgCard: '#fffdf8',
    bgSubcard: '#f3ede3',
    fgPrimary: '#29231d',
    fgSecondary: '#5c5247',
    fgMuted: '#85796c',
    border: 'rgba(120, 96, 68, 0.13)',
    userBubbleBg: '#efe6d8',
    userBubbleBorder: 'rgba(180, 83, 9, 0.18)',
    assistantBubbleBg: '#fffcf6',
    assistantBubbleBorder: 'rgba(120, 96, 68, 0.12)',
    codeBlockBg: '#f4efe6',
    codeBlockBorder: 'rgba(120, 96, 68, 0.14)',
    terminalWellBg: '#ede6da',
    terminalWellBorder: 'rgba(120, 96, 68, 0.15)',
    artifactBorderHighlight: 'rgba(180, 83, 9, 0.24)',
    topbarBg: 'rgba(250, 247, 242, 0.92)',
    composerBg: '#fffdf8',
    buttonAccent: '#b45309',
    buttonText: '#fffdf8',
    glowColor: 'rgba(180, 83, 9, 0.16)'
  })
});

const CODE_HIGHLIGHT_THEMES = Object.freeze({
  native: null,
  'obsidian-night': Object.freeze({
    bg: '#0d1118',
    fg: '#e2e8f0',
    border: 'rgba(148, 163, 184, 0.18)',
    comment: '#64748b',
    keyword: '#60a5fa',
    string: '#a3e635',
    number: '#f59e0b',
    fn: '#93c5fd',
    type: '#cbd5e1',
    operator: '#94a3b8'
  }),
  'warm-amber': Object.freeze({
    bg: '#15120f',
    fg: '#f2ede6',
    border: 'rgba(217, 179, 130, 0.18)',
    comment: '#8a7f72',
    keyword: '#f59e0b',
    string: '#bef264',
    number: '#eab308',
    fn: '#fde68a',
    type: '#d6d3d1',
    operator: '#b8ada0'
  }),
  'crystal-light': Object.freeze({
    bg: '#f1f5f9',
    fg: '#0f172a',
    border: 'rgba(15, 23, 42, 0.11)',
    comment: '#64748b',
    keyword: '#2563eb',
    string: '#15803d',
    number: '#b45309',
    fn: '#1d4ed8',
    type: '#334155',
    operator: '#475569'
  }),
  'paper-ink': Object.freeze({
    bg: '#f4efe6',
    fg: '#29231d',
    border: 'rgba(120, 96, 68, 0.14)',
    comment: '#85796c',
    keyword: '#b45309',
    string: '#3f6212',
    number: '#9a3412',
    fn: '#92400e',
    type: '#57534e',
    operator: '#78716c'
  })
});

const TERMINAL_DEPTH_MODES = Object.freeze(['native', 'recessed', 'subtle', 'flat']);

/**
 * Sanitize a user-supplied CSS color/value to prevent CSS injection.
 * Accepts safe hex, rgb/rgba, hsl/hsla, var(--...), transparent, inherit, currentColor.
 */
function sanitizeCssColor(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 96) return '';
  if (/[;{}<>@\\]|url\s*\(|expression\s*\(|javascript:/i.test(trimmed)) return '';
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(trimmed)) {
    return trimmed;
  }
  if (/^(?:transparent|currentColor|inherit)$/i.test(trimmed)) {
    return trimmed;
  }
  if (/^(?:rgb|rgba|hsl|hsla)\(\s*[0-9.%\s,/+-]+\)$/i.test(trimmed)) {
    return trimmed;
  }
  if (/^var\(\s*--[a-zA-Z0-9_-]+(?:\s*,\s*[^;{}()]+)?\)$/.test(trimmed)) {
    return trimmed;
  }
  return '';
}

function clampRadius(val, max = 28) {
  const num = Number(val);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.min(max, Math.round(num));
}

function normalizeThemeSettings(raw = {}) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const preset = Object.prototype.hasOwnProperty.call(OPTICAL_PRESETS, src.preset)
    ? src.preset
    : DEFAULT_SETTINGS.preset;
  const codeTheme = Object.prototype.hasOwnProperty.call(CODE_HIGHLIGHT_THEMES, src.codeTheme)
    ? src.codeTheme
    : DEFAULT_SETTINGS.codeTheme;
  const terminalWellDepth = TERMINAL_DEPTH_MODES.includes(src.terminalWellDepth)
    ? src.terminalWellDepth
    : DEFAULT_SETTINGS.terminalWellDepth;

  return {
    enabled: Boolean(src.enabled),
    preset,
    showTopbarUnit: Boolean(src.showTopbarUnit),
    syncHostCapsules: Boolean(src.syncHostCapsules),
    userBubbleBg: sanitizeCssColor(src.userBubbleBg),
    userBubbleBorder: sanitizeCssColor(src.userBubbleBorder),
    userBubbleRadius: clampRadius(src.userBubbleRadius, 28),
    assistantBubbleBg: sanitizeCssColor(src.assistantBubbleBg),
    assistantBubbleBorder: sanitizeCssColor(src.assistantBubbleBorder),
    assistantBubbleRadius: clampRadius(src.assistantBubbleRadius, 28),
    codeTheme,
    codeBlockBg: sanitizeCssColor(src.codeBlockBg),
    codeBlockBorder: sanitizeCssColor(src.codeBlockBorder),
    codeBlockRadius: clampRadius(src.codeBlockRadius, 24),
    terminalWellBg: sanitizeCssColor(src.terminalWellBg),
    terminalWellBorder: sanitizeCssColor(src.terminalWellBorder),
    terminalWellDepth,
    artifactRadius: clampRadius(src.artifactRadius, 28),
    artifactBorderHighlight: sanitizeCssColor(src.artifactBorderHighlight),
    topbarBg: sanitizeCssColor(src.topbarBg),
    composerBg: sanitizeCssColor(src.composerBg),
    composerRadius: clampRadius(src.composerRadius, 28),
    buttonAccent: sanitizeCssColor(src.buttonAccent),
    buttonRadius: clampRadius(src.buttonRadius, 24),
    powerSaveMode: Boolean(src.powerSaveMode),
    dampedSpringMotion: Boolean(src.dampedSpringMotion),
    microAnimatedIcons: Boolean(src.microAnimatedIcons),
    semanticAfterglow: Boolean(src.semanticAfterglow)
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  OPTICAL_PRESETS,
  CODE_HIGHLIGHT_THEMES,
  TERMINAL_DEPTH_MODES,
  sanitizeCssColor,
  normalizeThemeSettings
};
