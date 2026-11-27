'use strict';

const { TOKEN_HEADER_CANONICAL } = require('../constants');
const {
  createEl,
  clearNode,
  formatBytes,
  renderStatusCard
} = require('./dom-helpers');

const WATERFALL_SIZES = [12, 14, 16, 20, 24, 32, 48, 64];

async function mountFontViewer({
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
  const maxMB = Math.max(1, Number(settings?.fontMaxSizeMB ?? 50));
  if (Number(fileMeta.size || 0) > maxMB * 1024 * 1024) {
    rootEl.appendChild(renderStatusCard(doc, {
      title: t('font.tooLarge', { maxMB }),
      danger: true,
      actions: [
        { label: t('common.backToNative'), onClick: () => onBackToNative?.() }
      ]
    }));
    return;
  }

  const fontFamilyName = `agy-viewer-font-${ticket.ticketId}`;
  let registeredFace = null;
  let loadDurationMs = 0;

  trackCleanup(() => {
    if (registeredFace && doc?.fonts && typeof doc.fonts.delete === 'function') {
      try { doc.fonts.delete(registeredFace); } catch {}
      registeredFace = null;
    }
  });

  const startedAt = Date.now();
  let buffer = null;
  try {
    const resp = await globalThis.fetch(`${ticket.baseUrl}/v1/stream/${ticket.ticketId}`, {
      headers: { [TOKEN_HEADER_CANONICAL]: ticket.token },
      signal
    });
    if (!resp.ok) throw new Error(`HTTP_${resp.status}`);
    buffer = await resp.arrayBuffer();
  } catch (err) {
    if (signal?.aborted) return;
    rootEl.appendChild(renderStatusCard(doc, {
      title: t('error.loadFailed', { message: err?.message || 'FONT_FETCH_FAILED' }),
      actions: [
        { label: t('common.retry'), onClick: () => onRetry?.() },
        { label: t('common.backToNative'), onClick: () => onBackToNative?.() }
      ]
    }));
    return;
  }
  if (signal?.aborted) return;

  if (typeof globalThis.FontFace === 'function' && doc?.fonts) {
    try {
      const face = new globalThis.FontFace(fontFamilyName, buffer);
      await face.load();
      if (signal?.aborted) return;
      doc.fonts.add(face);
      registeredFace = face;
    } catch {
      if (signal?.aborted) return;
      rootEl.appendChild(renderStatusCard(doc, {
        title: t('font.loadError'),
        actions: [
          { label: t('common.retry'), onClick: () => onRetry?.() },
          { label: t('common.backToNative'), onClick: () => onBackToNative?.() }
        ]
      }));
      return;
    }
  }
  loadDurationMs = Math.max(1, Date.now() - startedAt);

  let sampleText = String(settings?.fontSampleText || '').trim() || t('font.defaultSample');
  let customSize = 28;
  let lineHeight = 1.4;
  let backdrop = 'dark';
  let glyphGridOpen = false;

  const formatLabel = String(fileMeta.ext || '').replace(/^\./, '').toUpperCase() || 'FONT';

  const sampleInput = createEl(doc, 'input', {
    type: 'text',
    className: 'agy-v-input',
    value: settings?.fontSampleText || '',
    placeholder: t('font.samplePlaceholder'),
    style: { flex: '1 1 220px' },
    on: {
      input: (e) => {
        const val = String(e.target.value || '');
        sampleText = val.trim() ? val : t('font.defaultSample');
        renderPreview();
      }
    }
  });

  const sizeLabel = createEl(doc, 'span', { className: 'agy-v-badge', text: t('font.sizeLabel', { size: customSize }) });
  const sizeSlider = createEl(doc, 'input', {
    type: 'range',
    value: String(customSize),
    attrs: { min: '12', max: '96', step: '1' },
    on: {
      input: (e) => {
        customSize = Number.parseInt(e.target.value, 10) || 28;
        sizeLabel.textContent = t('font.sizeLabel', { size: customSize });
        renderPreview();
      }
    }
  });

  const lhLabel = createEl(doc, 'span', { className: 'agy-v-badge', text: t('font.lineHeightLabel', { lh: lineHeight.toFixed(1) }) });
  const lhSlider = createEl(doc, 'input', {
    type: 'range',
    value: String(lineHeight),
    attrs: { min: '1.0', max: '2.2', step: '0.1' },
    on: {
      input: (e) => {
        lineHeight = Number.parseFloat(e.target.value) || 1.4;
        lhLabel.textContent = t('font.lineHeightLabel', { lh: lineHeight.toFixed(1) });
        renderPreview();
      }
    }
  });

  const backdropBtn = createEl(doc, 'button', {
    type: 'button',
    className: 'agy-v-btn',
    text: t('font.themeLight'),
    on: {
      click: () => {
        backdrop = backdrop === 'dark' ? 'light' : 'dark';
        bodyEl.setAttribute('data-backdrop', backdrop);
        backdropBtn.textContent = backdrop === 'dark' ? t('font.themeLight') : t('font.themeDark');
      }
    }
  });

  const glyphToggleBtn = createEl(doc, 'button', {
    type: 'button',
    className: 'agy-v-btn',
    text: t('font.glyphGridToggle'),
    attrs: { 'data-active': 'false' },
    on: {
      click: () => {
        glyphGridOpen = !glyphGridOpen;
        glyphToggleBtn.setAttribute('data-active', glyphGridOpen ? 'true' : 'false');
        glyphGridEl.style.display = glyphGridOpen ? 'grid' : 'none';
      }
    }
  });

  const toolbarTop = createEl(doc, 'div', { className: 'agy-v-toolbar' }, [
    createEl(doc, 'span', {
      className: 'agy-v-badge',
      text: `${fileMeta.name || 'font'} · ${formatLabel} · ${formatBytes(fileMeta.size)}`
    }),
    createEl(doc, 'span', { className: 'agy-v-badge', text: t('font.loadDuration', { ms: loadDurationMs }) }),
    backdropBtn,
    glyphToggleBtn,
    createEl(doc, 'div', { className: 'agy-v-toolbar-spacer' }),
    createEl(doc, 'button', {
      type: 'button',
      className: 'agy-v-btn',
      text: t('common.backToNative'),
      on: { click: () => onBackToNative?.() }
    })
  ]);

  const controlsBar = createEl(doc, 'div', { className: 'agy-v-toolbar' }, [
    sampleInput,
    sizeLabel,
    sizeSlider,
    lhLabel,
    lhSlider
  ]);

  const bodyEl = createEl(doc, 'div', {
    className: 'agy-v-font-body',
    attrs: { 'data-backdrop': backdrop }
  });

  const customPreviewEl = createEl(doc, 'div', {
    style: { fontFamily: `"${fontFamilyName}", sans-serif`, wordBreak: 'break-word' }
  });
  const waterfallEl = createEl(doc, 'div', { className: 'agy-v-font-waterfall' });
  const glyphGridEl = createEl(doc, 'div', {
    className: 'agy-v-glyph-grid',
    style: { display: 'none', fontFamily: `"${fontFamilyName}", sans-serif` }
  });
  for (let code = 0x21; code <= 0x7e; code++) {
    const ch = String.fromCharCode(code);
    glyphGridEl.appendChild(createEl(doc, 'div', {
      className: 'agy-v-glyph-cell',
      text: ch,
      title: `U+${code.toString(16).toUpperCase().padStart(4, '0')}`
    }));
  }

  bodyEl.appendChild(customPreviewEl);
  bodyEl.appendChild(waterfallEl);
  bodyEl.appendChild(glyphGridEl);

  rootEl.appendChild(toolbarTop);
  rootEl.appendChild(controlsBar);
  rootEl.appendChild(bodyEl);

  function renderPreview() {
    customPreviewEl.textContent = sampleText;
    customPreviewEl.style.fontSize = `${customSize}px`;
    customPreviewEl.style.lineHeight = String(lineHeight);

    clearNode(waterfallEl);
    for (const sz of WATERFALL_SIZES) {
      waterfallEl.appendChild(createEl(doc, 'div', { className: 'agy-v-font-row' }, [
        createEl(doc, 'span', { className: 'agy-v-font-size-tag', text: `${sz}px` }),
        createEl(doc, 'div', {
          text: sampleText,
          style: {
            fontFamily: `"${fontFamilyName}", sans-serif`,
            fontSize: `${sz}px`,
            lineHeight: String(lineHeight),
            wordBreak: 'break-word'
          }
        })
      ]));
    }
  }

  renderPreview();
}

module.exports = {
  WATERFALL_SIZES,
  mountFontViewer
};
