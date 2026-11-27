'use strict';

const { TOKEN_HEADER_CANONICAL, SVG_MAX_BYTES } = require('../constants');
const {
  createEl,
  clearNode,
  formatBytes,
  renderStatusCard,
  setStyleProps
} = require('./dom-helpers');

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 16.0;

function sanitizeSvgInRenderer(svgText) {
  const raw = String(svgText || '');
  if (typeof globalThis.DOMParser === 'function' && typeof globalThis.XMLSerializer === 'function') {
    try {
      const parser = new globalThis.DOMParser();
      const parsed = parser.parseFromString(raw, 'image/svg+xml');
      const root = parsed?.documentElement;
      if (root && root.nodeName.toLowerCase() === 'svg') {
        const forbidden = parsed.querySelectorAll('script, foreignObject, iframe, object, embed, applet, meta, link, base');
        for (const node of forbidden) node.remove();
        const allNodes = parsed.querySelectorAll('*');
        for (const el of [root, ...allNodes]) {
          for (const attr of Array.from(el.attributes || [])) {
            const name = String(attr.name || '').toLowerCase();
            const val = String(attr.value || '').trim();
            if (name.startsWith('on')) {
              el.removeAttribute(attr.name);
            } else if (
              (name === 'href' || name === 'xlink:href' || name === 'src' || name === 'action' || name === 'formaction')
              && !/^#[A-Za-z_][\w:.-]*$/.test(val)
              && !/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,/i.test(val)
            ) {
              el.removeAttribute(attr.name);
            }
          }
        }
        return new globalThis.XMLSerializer().serializeToString(root);
      }
    } catch {}
  }
  return raw;
}

async function mountSvgViewer({
  doc,
  t,
  rootEl,
  ticket,
  settings,
  signal,
  trackCleanup,
  onBackToNative,
  onRetry
}) {
  clearNode(rootEl);

  const fileMeta = ticket?.fileMeta || {};
  if (Number(fileMeta.size || 0) > SVG_MAX_BYTES) {
    rootEl.appendChild(renderStatusCard(doc, {
      title: t('svg.tooLarge'),
      danger: true,
      actions: [
        { label: t('common.backToNative'), onClick: () => onBackToNative?.() }
      ]
    }));
    return;
  }

  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let naturalW = 300;
  let naturalH = 300;
  let viewMode = 'canvas'; // 'canvas' | 'source'
  let bgMode = settings?.svgDefaultBackground || 'checkerboard';
  let blobUrl = null;
  let sourceLoaded = null;

  trackCleanup(() => {
    if (blobUrl && typeof globalThis.URL?.revokeObjectURL === 'function') {
      try { globalThis.URL.revokeObjectURL(blobUrl); } catch {}
      blobUrl = null;
    }
  });

  const resp = await globalThis.fetch(`${ticket.baseUrl}/v1/svg/${ticket.ticketId}?mode=sanitized`, {
    headers: { [TOKEN_HEADER_CANONICAL]: ticket.token },
    signal
  }).catch(() => null);

  if (signal?.aborted) return;

  let data = null;
  try { data = resp ? await resp.json() : null; } catch {}

  if (!data?.ok) {
    rootEl.appendChild(renderStatusCard(doc, {
      title: data?.errorCode === 'SVG_TOO_LARGE'
        ? t('svg.tooLarge')
        : t('error.loadFailed', { message: data?.message || data?.errorCode || 'SVG_LOAD_ERROR' }),
      danger: data?.errorCode === 'SVG_TOO_LARGE',
      actions: [
        { label: t('common.retry'), onClick: () => onRetry?.() },
        { label: t('common.backToNative'), onClick: () => onBackToNative?.() }
      ]
    }));
    return;
  }

  naturalW = Number(data.naturalWidth) > 0 ? Number(data.naturalWidth) : 300;
  naturalH = Number(data.naturalHeight) > 0 ? Number(data.naturalHeight) : 300;

  const cleanSvg = sanitizeSvgInRenderer(data.content || '');
  if (typeof globalThis.Blob === 'function' && typeof globalThis.URL?.createObjectURL === 'function') {
    const blob = new globalThis.Blob([cleanSvg], { type: 'image/svg+xml;charset=utf-8' });
    blobUrl = globalThis.URL.createObjectURL(blob);
  }

  const zoomLabel = createEl(doc, 'span', { className: 'agy-v-badge', text: '100%' });
  const metaText = [
    data.viewBox ? `viewBox: ${data.viewBox}` : null,
    `${Math.round(naturalW)}×${Math.round(naturalH)}`,
    formatBytes(fileMeta.size)
  ].filter(Boolean).join(' · ');

  const bgButtons = {};
  const modeCanvasBtn = createEl(doc, 'button', {
    type: 'button',
    className: 'agy-v-btn',
    text: t('svg.modeCanvas'),
    attrs: { 'data-active': 'true' },
    on: { click: () => void switchViewMode('canvas') }
  });
  const modeSourceBtn = createEl(doc, 'button', {
    type: 'button',
    className: 'agy-v-btn',
    text: t('svg.modeSource'),
    attrs: { 'data-active': 'false' },
    on: { click: () => void switchViewMode('source') }
  });

  const toolbar = createEl(doc, 'div', { className: 'agy-v-toolbar' }, [
    createEl(doc, 'button', {
      type: 'button',
      className: 'agy-v-btn',
      text: '-',
      title: t('svg.zoomOut'),
      on: { click: () => setZoom(zoom / 1.25) }
    }),
    zoomLabel,
    createEl(doc, 'button', {
      type: 'button',
      className: 'agy-v-btn',
      text: '+',
      title: t('svg.zoomIn'),
      on: { click: () => setZoom(zoom * 1.25) }
    }),
    createEl(doc, 'button', {
      type: 'button',
      className: 'agy-v-btn',
      text: t('svg.fit'),
      on: { click: () => fitToViewport() }
    }),
    createEl(doc, 'button', {
      type: 'button',
      className: 'agy-v-btn',
      text: t('svg.oneToOne'),
      on: {
        click: () => {
          panX = 0;
          panY = 0;
          setZoom(1);
        }
      }
    }),
    ...['checkerboard', 'light', 'dark'].map((preset) => {
      const btn = createEl(doc, 'button', {
        type: 'button',
        className: 'agy-v-btn',
        text: t(`svg.bg.${preset}`),
        attrs: { 'data-active': bgMode === preset ? 'true' : 'false' },
        on: {
          click: () => {
            bgMode = preset;
            canvasEl.setAttribute('data-bg', preset);
            for (const [k, b] of Object.entries(bgButtons)) {
              b.setAttribute('data-active', k === preset ? 'true' : 'false');
            }
          }
        }
      });
      bgButtons[preset] = btn;
      return btn;
    }),
    modeCanvasBtn,
    modeSourceBtn,
    createEl(doc, 'span', { className: 'agy-v-badge', text: metaText }),
    createEl(doc, 'div', { className: 'agy-v-toolbar-spacer' }),
    createEl(doc, 'button', {
      type: 'button',
      className: 'agy-v-btn',
      text: t('common.backToNative'),
      on: { click: () => onBackToNative?.() }
    })
  ]);

  const imgEl = doc.createElement('img');
  imgEl.className = 'agy-v-svg-img';
  imgEl.setAttribute('decoding', 'sync');
  imgEl.setAttribute('draggable', 'false');
  if (blobUrl) imgEl.src = blobUrl;

  const canvasEl = createEl(doc, 'div', {
    className: 'agy-v-svg-canvas',
    attrs: { 'data-bg': bgMode }
  }, [imgEl]);

  const sourceSlot = createEl(doc, 'div', {
    style: { display: 'none', flexDirection: 'column', flex: '1 1 auto', minHeight: '0' }
  });

  rootEl.appendChild(toolbar);
  rootEl.appendChild(canvasEl);
  rootEl.appendChild(sourceSlot);

  function applyTransform() {
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
    setStyleProps(imgEl, {
      width: `${Math.max(1, Math.round(naturalW * zoom))}px`,
      height: `${Math.max(1, Math.round(naturalH * zoom))}px`,
      transform: `translate3d(${Math.round(panX)}px, ${Math.round(panY)}px, 0)`
    });
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  }

  function setZoom(nextZoom) {
    zoom = nextZoom;
    applyTransform();
  }

  function fitToViewport() {
    const cw = Number(canvasEl.clientWidth || 400) - 32;
    const ch = Number(canvasEl.clientHeight || 320) - 32;
    const ratio = Math.min(cw / Math.max(1, naturalW), ch / Math.max(1, naturalH), 1);
    panX = 0;
    panY = 0;
    setZoom(Math.max(MIN_ZOOM, ratio));
  }

  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let panStartX = 0;
  let panStartY = 0;

  canvasEl.addEventListener?.('mousedown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    dragging = true;
    dragStartX = e.clientX || 0;
    dragStartY = e.clientY || 0;
    panStartX = panX;
    panStartY = panY;
  });

  canvasEl.addEventListener?.('mousemove', (e) => {
    if (!dragging) return;
    panX = panStartX + ((e.clientX || 0) - dragStartX);
    panY = panStartY + ((e.clientY || 0) - dragStartY);
    applyTransform();
  });

  const stopDrag = () => { dragging = false; };
  canvasEl.addEventListener?.('mouseup', stopDrag);
  canvasEl.addEventListener?.('mouseleave', stopDrag);
  canvasEl.addEventListener?.('dblclick', () => fitToViewport());
  canvasEl.addEventListener?.('wheel', (e) => {
    e.preventDefault?.();
    const factor = (e.deltaY || 0) < 0 ? 1.15 : (1 / 1.15);
    const prevZoom = zoom;
    const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prevZoom * factor));
    if (typeof canvasEl.getBoundingClientRect === 'function') {
      const rect = canvasEl.getBoundingClientRect();
      const cx = (e.clientX || 0) - (rect.left + rect.width / 2);
      const cy = (e.clientY || 0) - (rect.top + rect.height / 2);
      const scaleChange = nextZoom / prevZoom;
      panX = cx - (cx - panX) * scaleChange;
      panY = cy - (cy - panY) * scaleChange;
    }
    setZoom(nextZoom);
  }, { passive: false });

  async function switchViewMode(nextMode) {
    viewMode = nextMode;
    modeCanvasBtn.setAttribute('data-active', viewMode === 'canvas' ? 'true' : 'false');
    modeSourceBtn.setAttribute('data-active', viewMode === 'source' ? 'true' : 'false');
    if (viewMode === 'canvas') {
      canvasEl.style.display = 'flex';
      sourceSlot.style.display = 'none';
      return;
    }

    canvasEl.style.display = 'none';
    sourceSlot.style.display = 'flex';
    if (!sourceLoaded) {
      try {
        const sResp = await globalThis.fetch(`${ticket.baseUrl}/v1/svg/${ticket.ticketId}?mode=source`, {
          headers: { [TOKEN_HEADER_CANONICAL]: ticket.token },
          signal
        });
        sourceLoaded = await sResp.json();
      } catch {}
    }
    if (signal?.aborted) return;
    clearNode(sourceSlot);
    if (sourceLoaded?.truncated) {
      sourceSlot.appendChild(createEl(doc, 'div', { className: 'agy-v-banner-warn', text: t('svg.sourceTruncated') }));
    }
    sourceSlot.appendChild(createEl(doc, 'pre', {
      className: 'agy-v-source-pre',
      text: sourceLoaded?.content || cleanSvg
    }));
  }

  applyTransform();
}

module.exports = {
  MIN_ZOOM,
  MAX_ZOOM,
  sanitizeSvgInRenderer,
  mountSvgViewer
};
