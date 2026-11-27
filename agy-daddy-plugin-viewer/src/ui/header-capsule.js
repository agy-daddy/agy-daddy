'use strict';

const { VIEWER_HEADER_STYLES } = require('../styles');
const { createEl, clearNode } = require('./dom-helpers');

const HEADER_HOST_ID = 'agy-viewer-header-host';
const OMNI_CATEGORIES = new Set(['media', 'csv', 'svg', 'font']);

function createHeaderCapsule({ doc, t, onAction }) {
  let hostEl = null;
  let shadowRoot = null;
  let containerEl = null;
  let currentHeaderEl = null;

  function ensureMounted(headerEl) {
    if (!headerEl || !doc?.createElement) return null;
    if (currentHeaderEl !== headerEl || !hostEl || hostEl.parentElement !== headerEl) {
      dispose();
      const existing = headerEl.querySelector?.(`#${HEADER_HOST_ID}`);
      if (existing) existing.remove?.();

      hostEl = doc.createElement('div');
      hostEl.id = HEADER_HOST_ID;
      hostEl.setAttribute('id', HEADER_HOST_ID);
      hostEl.setAttribute('data-agy-plugin', 'agy-daddy.viewer');

      shadowRoot = typeof hostEl.attachShadow === 'function'
        ? hostEl.attachShadow({ mode: 'open' })
        : hostEl;

      const styleEl = doc.createElement('style');
      styleEl.textContent = VIEWER_HEADER_STYLES;
      shadowRoot.appendChild(styleEl);

      containerEl = createEl(doc, 'div', { className: 'agy-v-capsule' });
      shadowRoot.appendChild(containerEl);

      headerEl.appendChild(hostEl);
      currentHeaderEl = headerEl;
    }
    return containerEl;
  }

  function update(headerEl, state = {}) {
    if (!headerEl || !state.enabled || !state.showHeaderSwitchButton) {
      dispose();
      return;
    }

    const category = state.category || 'other';
    const mode = state.mode || 'native';
    const supportsOmni = OMNI_CATEGORIES.has(category) && isCategoryEnabled(category, state.settings);
    const showDiffBtn = Boolean(state.enableGitDiff && (state.gitChanged || mode === 'diff'));

    if (!supportsOmni && !showDiffBtn && mode === 'native') {
      dispose();
      return;
    }

    const wrap = ensureMounted(headerEl);
    if (!wrap) return;
    clearNode(wrap);

    if (supportsOmni) {
      if (mode === 'omni') {
        wrap.appendChild(createEl(doc, 'button', {
          type: 'button',
          id: 'agy-viewer-btn-native',
          className: 'agy-v-pill-btn',
          text: t('capsule.native'),
          title: t('capsule.nativeTitle'),
          attrs: { 'data-viewer-action': 'native', 'data-active': 'false' },
          on: { click: () => onAction?.('native') }
        }));
      } else {
        wrap.appendChild(createEl(doc, 'button', {
          type: 'button',
          id: 'agy-viewer-btn-omni',
          className: 'agy-v-pill-btn',
          text: t('capsule.omni'),
          title: t('capsule.omniTitle'),
          attrs: { 'data-viewer-action': 'omni', 'data-active': 'false' },
          on: { click: () => onAction?.('omni') }
        }));
      }
    } else if (mode !== 'native') {
      wrap.appendChild(createEl(doc, 'button', {
        type: 'button',
        id: 'agy-viewer-btn-native',
        className: 'agy-v-pill-btn',
        text: t('capsule.native'),
        title: t('capsule.nativeTitle'),
        attrs: { 'data-viewer-action': 'native', 'data-active': 'false' },
        on: { click: () => onAction?.('native') }
      }));
    }

    if (showDiffBtn) {
      const diffBtn = createEl(doc, 'button', {
        type: 'button',
        id: 'agy-viewer-btn-diff',
        className: 'agy-v-pill-btn',
        title: t('capsule.diffTitle'),
        attrs: {
          'data-viewer-action': 'diff',
          'data-active': mode === 'diff' ? 'true' : 'false'
        },
        on: { click: () => onAction?.(mode === 'diff' ? 'native' : 'diff') }
      }, [
        createEl(doc, 'span', { text: t('capsule.diff') }),
        state.gitStats ? createEl(doc, 'span', {
          className: 'agy-v-stat-add',
          text: `+${state.gitStats.additions || 0}`
        }) : null,
        state.gitStats ? createEl(doc, 'span', {
          className: 'agy-v-stat-del',
          text: `-${state.gitStats.deletions || 0}`
        }) : null
      ]);
      wrap.appendChild(diffBtn);
    }
  }

  function dispose() {
    if (hostEl) {
      hostEl.remove?.();
    }
    hostEl = null;
    shadowRoot = null;
    containerEl = null;
    currentHeaderEl = null;
  }

  function getHostElement() {
    return hostEl;
  }

  return {
    update,
    dispose,
    getHostElement
  };
}

function isCategoryEnabled(category, settings = {}) {
  if (category === 'media') return settings.enableMediaViewer !== false;
  if (category === 'csv') return settings.enableCsvViewer !== false;
  if (category === 'svg') return settings.enableSvgViewer !== false;
  if (category === 'font') return settings.enableFontViewer !== false;
  return false;
}

module.exports = {
  HEADER_HOST_ID,
  OMNI_CATEGORIES,
  createHeaderCapsule
};
