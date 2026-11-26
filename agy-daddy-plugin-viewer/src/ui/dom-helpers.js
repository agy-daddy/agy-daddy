'use strict';

function getClientOrigin() {
  const loc = globalThis.location;
  if (loc?.origin && loc.origin !== 'null') return String(loc.origin);
  const href = String(loc?.href || globalThis.document?.URL || '');
  const m = href.match(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)/i);
  return m ? m[1] : '';
}

function getInlineDisplay(el) {
  if (!el?.style) return '';
  if (typeof el.style.getPropertyValue === 'function') {
    const pv = el.style.getPropertyValue('display');
    if (pv) return pv;
  }
  return typeof el.style.display === 'string' ? el.style.display : '';
}

function setInlineDisplay(el, val) {
  if (!el?.style) return;
  if (val) {
    if (typeof el.style.setProperty === 'function') el.style.setProperty('display', val);
    try { el.style.display = val; } catch {}
  } else {
    if (typeof el.style.removeProperty === 'function') el.style.removeProperty('display');
    try { el.style.display = ''; } catch {}
  }
}

function createEl(doc, tag, opts = {}, children = []) {
  const node = doc.createElement(tag);
  if (opts.id) {
    node.id = opts.id;
    node.setAttribute?.('id', opts.id);
  }
  if (opts.className) {
    node.className = opts.className;
    node.setAttribute?.('class', opts.className);
  }
  if (opts.type && (tag === 'button' || tag === 'input')) {
    node.type = opts.type;
    node.setAttribute?.('type', opts.type);
  }
  if (opts.text !== undefined) node.textContent = String(opts.text);
  if (opts.value !== undefined) node.value = String(opts.value);
  if (opts.placeholder !== undefined) node.placeholder = String(opts.placeholder);
  if (opts.title !== undefined) node.setAttribute?.('title', String(opts.title));
  if (opts.disabled !== undefined) node.disabled = Boolean(opts.disabled);
  if (opts.checked !== undefined) node.checked = Boolean(opts.checked);
  if (opts.attrs && typeof opts.attrs === 'object') {
    for (const [k, v] of Object.entries(opts.attrs)) {
      if (v !== undefined && v !== null) node.setAttribute?.(k, String(v));
    }
  }
  if (opts.style && typeof opts.style === 'object' && node.style) {
    for (const [k, v] of Object.entries(opts.style)) {
      if (typeof node.style.setProperty === 'function') node.style.setProperty(k, String(v));
      try { node.style[k] = String(v); } catch {}
    }
  }
  if (opts.on && typeof opts.on === 'object') {
    for (const [evName, handler] of Object.entries(opts.on)) {
      if (typeof handler === 'function') node.addEventListener?.(evName, handler);
    }
  }
  for (const child of children) {
    if (child == null) continue;
    if (typeof child === 'string' || typeof child === 'number') {
      const span = doc.createElement('span');
      span.textContent = String(child);
      node.appendChild(span);
    } else {
      node.appendChild(child);
    }
  }
  return node;
}

function clearNode(node) {
  if (!node) return;
  if (Array.isArray(node.children)) {
    for (const ch of [...node.children]) {
      ch.remove?.();
    }
  }
  node.textContent = '';
}

function createShadowHost(doc, hostId, cssText) {
  const hostEl = doc.createElement('div');
  hostEl.id = hostId;
  hostEl.setAttribute('id', hostId);
  hostEl.setAttribute('data-agy-plugin', 'agy-daddy.viewer');
  const shadowRoot = typeof hostEl.attachShadow === 'function'
    ? hostEl.attachShadow({ mode: 'open' })
    : hostEl;
  const styleEl = doc.createElement('style');
  styleEl.textContent = cssText;
  shadowRoot.appendChild(styleEl);
  const rootEl = doc.createElement('div');
  rootEl.className = 'agy-v-stage-root';
  rootEl.setAttribute('class', 'agy-v-stage-root');
  shadowRoot.appendChild(rootEl);
  return { hostEl, shadowRoot, rootEl, styleEl };
}

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDurationMs(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return '00:00:00.000';
  const totalMs = Math.round(s * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const hr = Math.floor(totalMin / 60);
  const pad2 = (v) => String(v).padStart(2, '0');
  const pad3 = (v) => String(v).padStart(3, '0');
  return `${pad2(hr)}:${pad2(min)}:${pad2(sec)}.${pad3(ms)}`;
}

async function copyText(text) {
  const str = String(text ?? '');
  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(str);
      return true;
    }
  } catch {}
  return false;
}

function renderStatusCard(doc, { title, desc, danger = false, actions = [] }) {
  const actionEls = actions.map((act) => createEl(doc, 'button', {
    type: 'button',
    className: 'agy-v-btn',
    text: act.label,
    attrs: act.id ? { 'data-action-id': act.id } : {},
    on: { click: act.onClick }
  }));
  return createEl(doc, 'div', { className: 'agy-v-card-center' }, [
    createEl(doc, 'div', { className: danger ? 'agy-v-card agy-v-card-danger' : 'agy-v-card' }, [
      createEl(doc, 'div', { className: 'agy-v-card-title', text: title }),
      desc ? createEl(doc, 'div', { className: 'agy-v-card-desc', text: desc }) : null,
      actionEls.length > 0 ? createEl(doc, 'div', { className: 'agy-v-card-actions' }, actionEls) : null
    ])
  ]);
}

function buildQueryString(params = {}) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join('&');
}

function setStyleProps(el, props = {}) {
  if (!el?.style) return;
  for (const [k, v] of Object.entries(props)) {
    if (typeof el.style.setProperty === 'function') el.style.setProperty(k, String(v));
    try { el.style[k] = String(v); } catch {}
  }
}

module.exports = {
  getClientOrigin,
  getInlineDisplay,
  setInlineDisplay,
  setStyleProps,
  createEl,
  clearNode,
  createShadowHost,
  formatBytes,
  formatDurationMs,
  copyText,
  renderStatusCard,
  buildQueryString
};
