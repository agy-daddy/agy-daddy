'use strict';

const {
  OPTICAL_PRESETS,
  CODE_HIGHLIGHT_THEMES,
  normalizeThemeSettings
} = require('./presets');

function hasActiveVisualOverrides(cfg) {
  if (!cfg || !cfg.enabled) return false;
  if (cfg.preset !== 'native') return true;
  if (cfg.codeTheme !== 'native') return true;
  if (cfg.terminalWellDepth !== 'native') return true;
  if (
    cfg.userBubbleBg || cfg.userBubbleBorder || cfg.userBubbleRadius > 0 ||
    cfg.assistantBubbleBg || cfg.assistantBubbleBorder || cfg.assistantBubbleRadius > 0 ||
    cfg.codeBlockBg || cfg.codeBlockBorder || cfg.codeBlockRadius > 0 ||
    cfg.terminalWellBg || cfg.terminalWellBorder ||
    cfg.artifactRadius > 0 || cfg.artifactBorderHighlight ||
    cfg.topbarBg || cfg.composerBg || cfg.composerRadius > 0 ||
    cfg.buttonAccent || cfg.buttonRadius > 0
  ) {
    return true;
  }
  if (!cfg.powerSaveMode && (cfg.dampedSpringMotion || cfg.microAnimatedIcons || cfg.semanticAfterglow)) {
    return true;
  }
  if (cfg.powerSaveMode) return true;
  return false;
}

function buildThemeCss(rawSettings = {}) {
  const cfg = normalizeThemeSettings(rawSettings);
  if (!hasActiveVisualOverrides(cfg)) {
    return { active: false, documentCss: '', shadowCss: '', config: cfg };
  }

  const preset = OPTICAL_PRESETS[cfg.preset] || null;
  const codePalette = CODE_HIGHLIGHT_THEMES[cfg.codeTheme] || null;
  const rules = [];
  const rootVars = [];

  if (preset) {
    rootVars.push(
      `--background: ${preset.bgBase};`,
      `--foreground: ${preset.fgPrimary};`,
      `--card: ${preset.bgCard};`,
      `--card-foreground: ${preset.fgPrimary};`,
      `--secondary: ${preset.bgSubcard};`,
      `--secondary-foreground: ${preset.fgSecondary};`,
      `--muted: ${preset.bgSubcard};`,
      `--muted-foreground: ${preset.fgMuted};`,
      `--border: ${preset.border};`,
      `--sidebar: ${preset.bgPanel};`,
      `--sidebar-secondary: ${preset.bgSubcard};`,
      `--sidebar-muted: ${preset.bgSubcard};`,
      `--ring: ${preset.buttonAccent};`,
      `--agy-theme-mode: ${preset.mode};`,
      `--agy-theme-bg: ${preset.bgBase};`,
      `--agy-theme-panel: ${preset.bgPanel};`,
      `--agy-theme-card: ${preset.bgCard};`,
      `--agy-theme-fg: ${preset.fgPrimary};`,
      `--agy-theme-fg-secondary: ${preset.fgSecondary};`,
      `--agy-theme-border: ${preset.border};`,
      `--agy-theme-glow: ${preset.glowColor};`
    );
  }

  const userBg = cfg.userBubbleBg || preset?.userBubbleBg || '';
  const userBorder = cfg.userBubbleBorder || preset?.userBubbleBorder || '';
  if (userBg) rootVars.push(`--agy-user-bubble-bg: ${userBg};`);
  if (userBorder) rootVars.push(`--agy-user-bubble-border: ${userBorder};`);
  if (cfg.userBubbleRadius > 0) rootVars.push(`--agy-user-bubble-radius: ${cfg.userBubbleRadius}px;`);

  const asstBg = cfg.assistantBubbleBg || preset?.assistantBubbleBg || '';
  const asstBorder = cfg.assistantBubbleBorder || preset?.assistantBubbleBorder || '';
  if (asstBg) rootVars.push(`--agy-assistant-bubble-bg: ${asstBg};`);
  if (asstBorder) rootVars.push(`--agy-assistant-bubble-border: ${asstBorder};`);
  if (cfg.assistantBubbleRadius > 0) rootVars.push(`--agy-assistant-bubble-radius: ${cfg.assistantBubbleRadius}px;`);

  const codeBg = cfg.codeBlockBg || codePalette?.bg || preset?.codeBlockBg || '';
  const codeBorder = cfg.codeBlockBorder || codePalette?.border || preset?.codeBlockBorder || '';
  if (codeBg) rootVars.push(`--agy-code-bg: ${codeBg};`);
  if (codePalette?.fg) rootVars.push(`--agy-code-fg: ${codePalette.fg};`);
  if (codeBorder) rootVars.push(`--agy-code-border: ${codeBorder};`);
  if (cfg.codeBlockRadius > 0) rootVars.push(`--agy-code-radius: ${cfg.codeBlockRadius}px;`);

  const termBg = cfg.terminalWellBg || preset?.terminalWellBg || '';
  const termBorder = cfg.terminalWellBorder || preset?.terminalWellBorder || '';
  if (termBg) rootVars.push(`--agy-terminal-bg: ${termBg};`);
  if (termBorder) rootVars.push(`--agy-terminal-border: ${termBorder};`);

  const artHighlight = cfg.artifactBorderHighlight || preset?.artifactBorderHighlight || '';
  if (artHighlight) rootVars.push(`--agy-artifact-border: ${artHighlight};`);
  if (cfg.artifactRadius > 0) rootVars.push(`--agy-artifact-radius: ${cfg.artifactRadius}px;`);

  const topbarBg = cfg.topbarBg || preset?.topbarBg || '';
  if (topbarBg) rootVars.push(`--agy-topbar-bg: ${topbarBg};`);

  const composerBg = cfg.composerBg || preset?.composerBg || '';
  if (composerBg) rootVars.push(`--agy-composer-bg: ${composerBg};`);
  if (cfg.composerRadius > 0) rootVars.push(`--agy-composer-radius: ${cfg.composerRadius}px;`);

  const btnAccent = cfg.buttonAccent || preset?.buttonAccent || '';
  if (btnAccent) rootVars.push(`--agy-button-accent: ${btnAccent};`);
  if (cfg.buttonRadius > 0) rootVars.push(`--agy-button-radius: ${cfg.buttonRadius}px;`);

  if (rootVars.length > 0) {
    rules.push(`:root {\n  ${rootVars.join('\n  ')}\n}`);
  }

  if (preset) {
    rules.push(
      `html, body {\n  background-color: var(--agy-theme-bg);\n  color: var(--agy-theme-fg);\n}`
    );
  }

  // User Bubble rules
  const userDecls = [];
  if (userBg) userDecls.push('background-color: var(--agy-user-bubble-bg) !important;');
  if (userBorder) userDecls.push('border: 1px solid var(--agy-user-bubble-border) !important;');
  if (cfg.userBubbleRadius > 0) userDecls.push('border-radius: var(--agy-user-bubble-radius) !important;');
  if (userDecls.length > 0) {
    rules.push(
      `[data-testid="user-message"],\n[data-testid="user-message-content"] {\n  ${userDecls.join('\n  ')}\n}`
    );
  }

  // Assistant Bubble rules
  const asstDecls = [];
  if (asstBg) asstDecls.push('background-color: var(--agy-assistant-bubble-bg) !important;');
  if (asstBorder) asstDecls.push('border: 1px solid var(--agy-assistant-bubble-border) !important;');
  if (cfg.assistantBubbleRadius > 0) asstDecls.push('border-radius: var(--agy-assistant-bubble-radius) !important;');
  if (asstDecls.length > 0) {
    rules.push(
      `[data-testid="agent-response"] {\n  ${asstDecls.join('\n  ')}\n}`
    );
  }

  // Code Block & Syntax rules
  const codeDecls = [];
  if (codeBg) codeDecls.push('background-color: var(--agy-code-bg) !important;');
  if (codePalette?.fg) codeDecls.push('color: var(--agy-code-fg) !important;');
  if (codeBorder) codeDecls.push('border: 1px solid var(--agy-code-border) !important;');
  if (cfg.codeBlockRadius > 0) codeDecls.push('border-radius: var(--agy-code-radius) !important;');
  if (codeDecls.length > 0) {
    rules.push(
      `[data-testid="turn-cards-container"] pre,\n[data-testid="agent-response"] pre,\npre:has(> code) {\n  ${codeDecls.join('\n  ')}\n}`
    );
  }
  if (codePalette) {
    rules.push(
      `[data-testid="turn-cards-container"] pre code,\n[data-testid="agent-response"] pre code {\n  color: ${codePalette.fg};\n}`,
      `pre .hljs-comment, pre .token.comment { color: ${codePalette.comment} !important; font-style: italic; }`,
      `pre .hljs-keyword, pre .hljs-selector-tag, pre .token.keyword { color: ${codePalette.keyword} !important; }`,
      `pre .hljs-string, pre .hljs-attr, pre .token.string { color: ${codePalette.string} !important; }`,
      `pre .hljs-number, pre .hljs-literal, pre .token.number { color: ${codePalette.number} !important; }`,
      `pre .hljs-title, pre .hljs-function, pre .token.function { color: ${codePalette.fn} !important; }`,
      `pre .hljs-type, pre .hljs-built_in, pre .token.class-name { color: ${codePalette.type} !important; }`,
      `pre .hljs-operator, pre .token.operator { color: ${codePalette.operator} !important; }`
    );
  }

  // Terminal Well rules
  const termDecls = [];
  if (termBg) termDecls.push('background-color: var(--agy-terminal-bg) !important;');
  if (termBorder) termDecls.push('border: 1px solid var(--agy-terminal-border) !important;');
  if (cfg.terminalWellDepth === 'recessed') {
    termDecls.push('box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.04) !important;');
  } else if (cfg.terminalWellDepth === 'subtle') {
    termDecls.push('box-shadow: inset 0 1px 4px rgba(0, 0, 0, 0.16) !important;');
  } else if (cfg.terminalWellDepth === 'flat') {
    termDecls.push('box-shadow: none !important;');
  }
  if (termDecls.length > 0) {
    rules.push(
      `[data-testid="terminal-container"],\n[data-testid="command-output"],\n[data-testid="turn-cards-container"] [data-testid*="terminal"],\n.xterm-viewport {\n  ${termDecls.join('\n  ')}\n}`
    );
  }

  // Artifact Card rules
  const artDecls = [];
  if (artHighlight) artDecls.push('border-color: var(--agy-artifact-border) !important;');
  if (cfg.artifactRadius > 0) artDecls.push('border-radius: var(--agy-artifact-radius) !important;');
  if (artHighlight) {
    artDecls.push('box-shadow: inset 0 1px 0 var(--agy-artifact-border) !important;');
  }
  if (artDecls.length > 0) {
    rules.push(
      `[data-testid*="artifact"],\n[data-testid="turn-cards-container"] [data-uri] {\n  ${artDecls.join('\n  ')}\n}`
    );
  }

  // Topbar rules
  if (topbarBg) {
    rules.push(
      `[class*="@container/titlebar"],\ndiv.h-screen.w-screen > div.flex-1 > div.absolute.right-0.z-50 {\n  background-color: var(--agy-topbar-bg) !important;\n}`
    );
  }

  // Composer rules
  const composerDecls = [];
  if (composerBg) composerDecls.push('background-color: var(--agy-composer-bg) !important;');
  if (cfg.composerRadius > 0) composerDecls.push('border-radius: var(--agy-composer-radius) !important;');
  if (composerDecls.length > 0) {
    rules.push(
      `.surface-composer,\n[data-testid="agent-input-box"] {\n  ${composerDecls.join('\n  ')}\n}`
    );
  }

  // Button rules
  const sendBtnDecls = [];
  if (btnAccent) {
    sendBtnDecls.push('background-color: var(--agy-button-accent) !important;');
    sendBtnDecls.push('border-color: var(--agy-button-accent) !important;');
    if (preset?.buttonText) {
      sendBtnDecls.push(`color: ${preset.buttonText} !important;`);
    }
  }
  if (cfg.buttonRadius > 0) {
    sendBtnDecls.push('border-radius: var(--agy-button-radius) !important;');
  }
  if (sendBtnDecls.length > 0) {
    rules.push(
      `.surface-composer [data-testid="input-send-button"],\n.surface-composer [data-testid="send-button"] {\n  ${sendBtnDecls.join('\n  ')}\n}`
    );
  }
  if (cfg.buttonRadius > 0) {
    rules.push(
      `[data-testid="agent-response"] button,\n[data-testid="turn-cards-container"] button,\n.surface-composer button {\n  border-radius: var(--agy-button-radius) !important;\n}`
    );
  }

  // Motion, Micro-icons, Semantic Afterglow & Power-Save Mode
  if (cfg.powerSaveMode) {
    rules.push(
      `[data-testid="turn-cards-container"] *,\n.surface-composer *,\n[data-testid="agent-response"] * {\n  transition-duration: 0ms !important;\n  animation-duration: 0ms !important;\n  backdrop-filter: none !important;\n}`
    );
  } else {
    if (cfg.dampedSpringMotion) {
      rules.push(
        `[data-testid="user-message"],\n[data-testid="agent-response"],\n[data-testid*="artifact"],\n.surface-composer,\n.surface-composer button,\n[data-testid="agent-response"] button {\n  transition: transform 280ms cubic-bezier(0.22, 1.18, 0.36, 1), background-color 220ms cubic-bezier(0.22, 1, 0.36, 1), border-color 220ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 260ms cubic-bezier(0.22, 1, 0.36, 1) !important;\n}`
      );
    }
    if (cfg.microAnimatedIcons) {
      rules.push(
        `.surface-composer button svg,\n[data-testid="agent-response"] button svg,\n[data-testid="turn-cards-container"] button svg {\n  transition: transform 200ms cubic-bezier(0.22, 1.24, 0.36, 1);\n}\n.surface-composer button:hover svg,\n[data-testid="agent-response"] button:hover svg {\n  transform: scale(1.08);\n}\n.surface-composer button:active svg,\n[data-testid="agent-response"] button:active svg {\n  transform: scale(0.94);\n}`
      );
    }
    if (cfg.semanticAfterglow) {
      const glow = btnAccent ? 'var(--agy-button-accent)' : (preset?.glowColor || 'rgba(96, 165, 250, 0.22)');
      rules.push(
        `.surface-composer:focus-within,\n[data-testid="agent-input-box"]:focus-within {\n  box-shadow: 0 0 0 1px ${glow}, 0 6px 24px -6px ${preset?.glowColor || 'rgba(96, 165, 250, 0.22)'} !important;\n}`
      );
      if (artHighlight) {
        rules.push(
          `[data-testid*="artifact"]:hover {\n  box-shadow: 0 0 0 1px var(--agy-artifact-border), 0 6px 20px -6px ${preset?.glowColor || 'rgba(96, 165, 250, 0.20)'} !important;\n}`
        );
      }
    }
  }

  // Optional Shadow DOM token sync for Agy-Daddy capsules
  let shadowCss = '';
  if (cfg.syncHostCapsules && preset) {
    shadowCss = [
      ':host {',
      `  --ag-bg-panel: ${preset.bgPanel};`,
      `  --ag-border-panel: ${preset.border};`,
      `  --ag-bg-card: ${preset.bgCard};`,
      `  --ag-border-card: ${preset.border};`,
      `  --ag-bg-subcard: ${preset.bgSubcard};`,
      `  --ag-border-subcard: ${preset.border};`,
      `  --ag-bg-input: ${preset.bgSubcard};`,
      `  --ag-text-primary: ${preset.fgPrimary};`,
      `  --ag-text-secondary: ${preset.fgSecondary};`,
      `  --ag-text-muted: ${preset.fgMuted};`,
      `  --ag-effective-accent: ${btnAccent || preset.buttonAccent};`,
      `  --ag-custom-token-accent: ${btnAccent || preset.buttonAccent};`,
      '}'
    ].join('\n');
  }

  return {
    active: rules.length > 0,
    documentCss: rules.join('\n\n'),
    shadowCss,
    config: cfg
  };
}

module.exports = {
  hasActiveVisualOverrides,
  buildThemeCss
};
