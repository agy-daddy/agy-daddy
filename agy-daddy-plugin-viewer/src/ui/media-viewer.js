'use strict';

const { TOKEN_HEADER_CANONICAL, MARKER_TONES } = require('../constants');
const {
  createEl,
  clearNode,
  formatBytes,
  formatDurationMs,
  copyText,
  renderStatusCard
} = require('./dom-helpers');

const WAVEFORM_BUCKETS = 320;
const PLAYBACK_RATES = [0.25, 0.5, 1, 1.5, 2, 4];
const FPS_OPTIONS = ['24', '25', '30', '60'];
const AUDIO_STEPS_SEC = [0.01, 0.1, 1];

function downsampleAudioBuffer(audioBuffer, buckets = WAVEFORM_BUCKETS) {
  const channelCount = Math.min(2, audioBuffer?.numberOfChannels || 1);
  const length = audioBuffer?.length || 0;
  if (!length) return [];
  const blockSize = Math.max(1, Math.floor(length / buckets));
  const peaks = [];
  for (let b = 0; b < buckets; b++) {
    const start = b * blockSize;
    const end = Math.min(length, start + blockSize);
    if (start >= end) break;
    let min = 1;
    let max = -1;
    for (let ch = 0; ch < channelCount; ch++) {
      const data = audioBuffer.getChannelData(ch);
      const stride = Math.max(1, Math.floor((end - start) / 64));
      for (let i = start; i < end; i += stride) {
        const v = data[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    peaks.push([Math.max(-1, min), Math.min(1, max)]);
  }
  return peaks;
}

function drawWaveformCanvas(canvas, peaks, progressRatio, markers = []) {
  if (!canvas || typeof canvas.getContext !== 'function') return;
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) return;
  const width = canvas.width || 600;
  const height = canvas.height || 64;
  ctx2d.clearRect(0, 0, width, height);

  if (!Array.isArray(peaks) || peaks.length === 0) {
    // Draw flat baseline when waveform decode is skipped/unavailable
    ctx2d.fillStyle = 'rgba(161, 161, 170, 0.28)';
    ctx2d.fillRect(0, Math.floor(height / 2) - 1, width, 2);
    if (progressRatio > 0) {
      ctx2d.fillStyle = 'rgba(228, 228, 231, 0.75)';
      ctx2d.fillRect(0, Math.floor(height / 2) - 2, Math.floor(width * Math.min(1, progressRatio)), 4);
    }
    return;
  }

  const barWidth = width / peaks.length;
  const midY = height / 2;
  for (let i = 0; i < peaks.length; i++) {
    const [min, max] = peaks[i];
    const amp = Math.max(0.06, Math.max(Math.abs(min), Math.abs(max)));
    const barH = Math.max(2, amp * (height - 8));
    const x = i * barWidth;
    const played = (i / peaks.length) <= progressRatio;
    ctx2d.fillStyle = played ? 'rgba(228, 228, 231, 0.85)' : 'rgba(161, 161, 170, 0.35)';
    ctx2d.fillRect(x, midY - barH / 2, Math.max(1, barWidth - 1), barH);
  }
}

async function mountMediaViewer({
  ctx,
  doc,
  t,
  rootEl,
  ticket,
  filePath,
  settings,
  signal,
  trackCleanup,
  onBackToNative,
  onRetry
}) {
  clearNode(rootEl);
  rootEl.setAttribute('tabindex', '0');

  const fileMeta = ticket?.fileMeta || {};
  const isAudio = String(fileMeta.mimeType || '').startsWith('audio/');
  const maxWaveMB = Math.max(10, Number(settings?.mediaWaveformMaxMB ?? 100));
  const maxWaveBytes = maxWaveMB * 1024 * 1024;
  const skipWaveform = Number(fileMeta.size || 0) > maxWaveBytes;

  let fps = Number.parseInt(settings?.mediaDefaultFps || '30', 10) || 30;
  let audioStepSec = 0.1;
  let loopA = null;
  let loopB = null;
  let abLoopActive = false;
  let markers = [];
  let waveformPeaks = [];
  let mediaError = null;
  let audioCtxInstance = null;

  const mediaEl = doc.createElement(isAudio ? 'audio' : 'video');
  mediaEl.className = 'agy-v-media-el';
  mediaEl.setAttribute('crossorigin', 'anonymous');
  mediaEl.setAttribute('preload', 'metadata');
  mediaEl.controls = false;
  mediaEl.src = ticket.streamUrl;

  trackCleanup(() => {
    try {
      mediaEl.pause?.();
      mediaEl.removeAttribute?.('src');
      mediaEl.load?.();
    } catch {}
    if (audioCtxInstance) {
      audioCtxInstance.close?.().catch?.(() => {});
      audioCtxInstance = null;
    }
  });

  // Top toolbar
  const toolbar = createEl(doc, 'div', { className: 'agy-v-toolbar' });
  const titleBadge = createEl(doc, 'span', {
    className: 'agy-v-badge',
    text: `${fileMeta.name || 'media'} · ${formatBytes(fileMeta.size)}`
  });
  const frameBadge = createEl(doc, 'span', {
    className: 'agy-v-badge',
    text: isAudio ? 'AUDIO' : t('media.frameLabel', { frame: 0 })
  });
  const backBtn = createEl(doc, 'button', {
    type: 'button',
    className: 'agy-v-btn',
    text: t('common.backToNative'),
    on: { click: () => onBackToNative?.() }
  });
  toolbar.appendChild(titleBadge);
  toolbar.appendChild(frameBadge);
  toolbar.appendChild(createEl(doc, 'div', { className: 'agy-v-toolbar-spacer' }));
  toolbar.appendChild(backBtn);
  rootEl.appendChild(toolbar);

  const errorSlot = createEl(doc, 'div');
  rootEl.appendChild(errorSlot);

  if (skipWaveform) {
    rootEl.appendChild(createEl(doc, 'div', {
      className: 'agy-v-banner-warn',
      text: t('media.waveformSkipped', { maxMB: maxWaveMB })
    }));
  }

  const body = createEl(doc, 'div', { className: 'agy-v-media-body' });
  rootEl.appendChild(body);

  if (!isAudio) {
    const videoWrap = createEl(doc, 'div', { className: 'agy-v-media-video-wrap' }, [mediaEl]);
    body.appendChild(videoWrap);
  } else {
    body.appendChild(mediaEl);
  }

  // Transport controls bar
  const playBtn = createEl(doc, 'button', {
    type: 'button',
    className: 'agy-v-btn',
    text: t('media.play'),
    on: { click: () => togglePlay() }
  });

  const timecodeEl = createEl(doc, 'span', {
    className: 'agy-v-badge',
    text: '00:00:00.000 / 00:00:00.000'
  });

  const seekInput = createEl(doc, 'input', {
    type: 'range',
    className: 'agy-v-input',
    value: '0',
    attrs: { min: '0', max: '1000', step: '1' },
    style: { flex: '1 1 160px', padding: '0' },
    on: {
      input: (e) => {
        const dur = Number(mediaEl.duration || 0);
        if (dur > 0) {
          mediaEl.currentTime = (Number(e.target.value || 0) / 1000) * dur;
          syncTimeDisplay();
        }
      }
    }
  });

  const muteBtn = createEl(doc, 'button', {
    type: 'button',
    className: 'agy-v-btn',
    text: t('media.mute'),
    on: {
      click: () => {
        mediaEl.muted = !mediaEl.muted;
        muteBtn.textContent = mediaEl.muted ? t('media.unmute') : t('media.mute');
      }
    }
  });

  const rateSelect = createEl(doc, 'select', {
    className: 'agy-v-select',
    title: t('media.speed'),
    on: {
      change: (e) => {
        mediaEl.playbackRate = Number(e.target.value || 1) || 1;
      }
    }
  }, PLAYBACK_RATES.map((r) => createEl(doc, 'option', {
    value: String(r),
    text: `${r}x`,
    attrs: r === 1 ? { selected: 'selected' } : {}
  })));
  rateSelect.value = '1';

  const transportBar = createEl(doc, 'div', { className: 'agy-v-toolbar' }, [
    playBtn,
    timecodeEl,
    seekInput,
    muteBtn,
    rateSelect
  ]);
  body.appendChild(transportBar);

  // Frame-step & A-B loop & Marker bar
  const stepUnitSelect = createEl(doc, 'select', {
    className: 'agy-v-select',
    on: {
      change: (e) => {
        if (isAudio) audioStepSec = Number(e.target.value || 0.1) || 0.1;
        else fps = Number.parseInt(e.target.value || '30', 10) || 30;
        syncTimeDisplay();
      }
    }
  }, isAudio
    ? AUDIO_STEPS_SEC.map((s) => createEl(doc, 'option', {
        value: String(s),
        text: s < 1 ? `${Math.round(s * 1000)}ms` : '1s'
      }))
    : FPS_OPTIONS.map((f) => createEl(doc, 'option', {
        value: f,
        text: `${f} fps`
      }))
  );
  stepUnitSelect.value = isAudio ? '0.1' : String(fps);

  const prevStepBtn = createEl(doc, 'button', {
    type: 'button',
    className: 'agy-v-btn',
    text: isAudio ? t('media.prevStep') : t('media.prevFrame'),
    on: { click: () => stepFrame(-1) }
  });
  const nextStepBtn = createEl(doc, 'button', {
    type: 'button',
    className: 'agy-v-btn',
    text: isAudio ? t('media.nextStep') : t('media.nextFrame'),
    on: { click: () => stepFrame(1) }
  });

  const setABtn = createEl(doc, 'button', {
    type: 'button',
    className: 'agy-v-btn',
    text: t('media.setA'),
    on: {
      click: () => {
        loopA = Number(mediaEl.currentTime || 0);
        if (loopB !== null && loopB > loopA) abLoopActive = true;
        syncABButtons();
      }
    }
  });
  const setBBtn = createEl(doc, 'button', {
    type: 'button',
    className: 'agy-v-btn',
    text: t('media.setB'),
    on: {
      click: () => {
        loopB = Number(mediaEl.currentTime || 0);
        if (loopA !== null && loopB > loopA) abLoopActive = true;
        syncABButtons();
      }
    }
  });
  const clearABBtn = createEl(doc, 'button', {
    type: 'button',
    className: 'agy-v-btn',
    text: t('media.clearAB'),
    on: {
      click: () => {
        loopA = null;
        loopB = null;
        abLoopActive = false;
        syncABButtons();
      }
    }
  });

  const addMarkerBtn = createEl(doc, 'button', {
    type: 'button',
    className: 'agy-v-btn',
    text: t('media.addMarker'),
    on: { click: () => void addMarkerAtCurrentTime() }
  });

  const stepBar = createEl(doc, 'div', { className: 'agy-v-toolbar' }, [
    stepUnitSelect,
    prevStepBtn,
    nextStepBtn,
    setABtn,
    setBBtn,
    clearABBtn,
    createEl(doc, 'div', { className: 'agy-v-toolbar-spacer' }),
    addMarkerBtn
  ]);
  body.appendChild(stepBar);

  // Waveform & marker overlay
  const waveWrap = createEl(doc, 'div', {
    className: 'agy-v-waveform-wrap',
    on: {
      click: (e) => {
        const dur = Number(mediaEl.duration || 0);
        if (!dur || typeof waveWrap.getBoundingClientRect !== 'function') return;
        const rect = waveWrap.getBoundingClientRect();
        if (!rect || rect.width <= 0) return;
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        mediaEl.currentTime = ratio * dur;
        syncTimeDisplay();
      }
    }
  });
  const waveCanvas = doc.createElement('canvas');
  waveCanvas.className = 'agy-v-waveform-canvas';
  waveCanvas.width = 640;
  waveCanvas.height = 64;
  waveWrap.appendChild(waveCanvas);
  const pinsLayer = createEl(doc, 'div');
  waveWrap.appendChild(pinsLayer);
  body.appendChild(waveWrap);

  // Cue markers list
  const markersCard = createEl(doc, 'div', { className: 'agy-v-markers-list' });
  body.appendChild(markersCard);

  function syncABButtons() {
    setABtn.setAttribute('data-active', loopA !== null ? 'true' : 'false');
    setBBtn.setAttribute('data-active', loopB !== null ? 'true' : 'false');
    clearABBtn.textContent = abLoopActive ? t('media.abLoopOn') : t('media.clearAB');
  }

  function syncTimeDisplay() {
    const cur = Number(mediaEl.currentTime || 0);
    const dur = Number(mediaEl.duration || 0);
    timecodeEl.textContent = `${formatDurationMs(cur)} / ${formatDurationMs(dur)}`;
    if (!isAudio) {
      const frameNum = Math.max(0, Math.floor(cur * fps));
      frameBadge.textContent = t('media.frameLabel', { frame: frameNum });
    }
    if (dur > 0) {
      seekInput.value = String(Math.round((cur / dur) * 1000));
    }
    drawWaveformCanvas(waveCanvas, waveformPeaks, dur > 0 ? cur / dur : 0, markers);
  }

  function togglePlay() {
    if (mediaEl.paused) {
      void mediaEl.play?.()?.catch?.(() => {});
      playBtn.textContent = t('media.pause');
    } else {
      mediaEl.pause?.();
      playBtn.textContent = t('media.play');
    }
  }

  function stepFrame(dir) {
    mediaEl.pause?.();
    playBtn.textContent = t('media.play');
    const step = isAudio ? audioStepSec : (1 / Math.max(1, fps));
    const dur = Number.isFinite(mediaEl.duration) && mediaEl.duration > 0 ? mediaEl.duration : Infinity;
    const nextTime = Math.max(0, Math.min(dur, Number(mediaEl.currentTime || 0) + dir * step));
    mediaEl.currentTime = nextTime;
    syncTimeDisplay();
  }

  async function persistMarkers() {
    try {
      const res = await ctx.bridge.post('/markers/save', { filePath, markers });
      if (res?.ok && Array.isArray(res.markers)) {
        markers = res.markers;
      }
    } catch {}
    renderMarkers();
  }

  async function addMarkerAtCurrentTime() {
    const timeSec = Math.round(Number(mediaEl.currentTime || 0) * 1000) / 1000;
    const item = {
      id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      timeSec,
      label: '',
      tone: 'neutral',
      createdAt: new Date().toISOString()
    };
    markers = [...markers, item].sort((a, b) => a.timeSec - b.timeSec);
    renderMarkers();
    await persistMarkers();
  }

  function renderMarkerPins() {
    clearNode(pinsLayer);
    const dur = Number(mediaEl.duration || 0);
    if (!dur) return;
    for (const m of markers) {
      const pct = Math.max(0, Math.min(100, (m.timeSec / dur) * 100));
      const pin = createEl(doc, 'div', {
        className: 'agy-v-marker-pin',
        title: `${formatDurationMs(m.timeSec)} ${m.label || ''}`.trim(),
        attrs: { 'data-tone': m.tone || 'neutral' },
        style: { left: `${pct}%` },
        on: {
          click: (e) => {
            e.stopPropagation?.();
            mediaEl.currentTime = m.timeSec;
            syncTimeDisplay();
          }
        }
      });
      pinsLayer.appendChild(pin);
    }
  }

  function renderMarkers() {
    renderMarkerPins();
    clearNode(markersCard);
    const headerRow = createEl(doc, 'div', { className: 'agy-v-toolbar', style: { padding: '0 0 6px 0', borderBottom: 'none' } }, [
      createEl(doc, 'span', { className: 'agy-v-badge', text: t('media.markersTitle', { count: markers.length }) }),
      createEl(doc, 'div', { className: 'agy-v-toolbar-spacer' }),
      createEl(doc, 'button', {
        type: 'button',
        className: 'agy-v-btn',
        text: t('media.exportMd'),
        disabled: markers.length === 0,
        on: {
          click: () => {
            const md = markers.map((m) => `- [${formatDurationMs(m.timeSec)}] (${m.tone}) ${m.label || '-'}`).join('\n');
            void copyText(md);
          }
        }
      }),
      createEl(doc, 'button', {
        type: 'button',
        className: 'agy-v-btn',
        text: t('media.exportJson'),
        disabled: markers.length === 0,
        on: {
          click: () => void copyText(JSON.stringify(markers, null, 2))
        }
      }),
      createEl(doc, 'button', {
        type: 'button',
        className: 'agy-v-btn',
        text: t('media.markerClearAll'),
        disabled: markers.length === 0,
        on: {
          click: () => {
            markers = [];
            void persistMarkers();
          }
        }
      })
    ]);
    markersCard.appendChild(headerRow);

    if (markers.length === 0) {
      markersCard.appendChild(createEl(doc, 'div', {
        className: 'agy-v-card-desc',
        text: t('media.markersEmpty')
      }));
      return;
    }

    for (const m of markers) {
      const timeBtn = createEl(doc, 'button', {
        type: 'button',
        className: 'agy-v-btn',
        text: formatDurationMs(m.timeSec),
        on: {
          click: () => {
            mediaEl.currentTime = m.timeSec;
            syncTimeDisplay();
          }
        }
      });
      const noteInput = createEl(doc, 'input', {
        type: 'text',
        className: 'agy-v-input',
        value: m.label || '',
        placeholder: t('media.markerPlaceholder'),
        style: { flex: '1 1 auto' },
        on: {
          change: (e) => {
            m.label = String(e.target.value || '').trim();
            void persistMarkers();
          }
        }
      });
      const toneSelect = createEl(doc, 'select', {
        className: 'agy-v-select',
        on: {
          change: (e) => {
            m.tone = MARKER_TONES.includes(e.target.value) ? e.target.value : 'neutral';
            void persistMarkers();
          }
        }
      }, MARKER_TONES.map((tn) => createEl(doc, 'option', {
        value: tn,
        text: t(`media.tone.${tn}`)
      })));
      toneSelect.value = m.tone || 'neutral';

      const delBtn = createEl(doc, 'button', {
        type: 'button',
        className: 'agy-v-btn',
        text: t('media.markerDelete'),
        on: {
          click: () => {
            markers = markers.filter((x) => x.id !== m.id);
            void persistMarkers();
          }
        }
      });

      markersCard.appendChild(createEl(doc, 'div', { className: 'agy-v-marker-row' }, [
        timeBtn,
        toneSelect,
        noteInput,
        delBtn
      ]));
    }
  }

  mediaEl.addEventListener?.('loadedmetadata', () => {
    syncTimeDisplay();
    renderMarkerPins();
  });
  mediaEl.addEventListener?.('timeupdate', () => {
    if (abLoopActive && loopA !== null && loopB !== null && loopB > loopA && mediaEl.currentTime >= loopB) {
      mediaEl.currentTime = loopA;
    }
    syncTimeDisplay();
  });
  mediaEl.addEventListener?.('play', () => { playBtn.textContent = t('media.pause'); });
  mediaEl.addEventListener?.('pause', () => { playBtn.textContent = t('media.play'); });
  mediaEl.addEventListener?.('error', () => {
    mediaError = t('media.codecUnsupported', { format: fileMeta.ext || fileMeta.mimeType || 'unknown' });
    clearNode(errorSlot);
    errorSlot.appendChild(renderStatusCard(doc, {
      title: mediaError,
      actions: [
        { label: t('common.retry'), onClick: () => onRetry?.() },
        { label: t('common.backToNative'), onClick: () => onBackToNative?.() }
      ]
    }));
  });

  // Stage-scoped keyboard shortcuts (never attached to document)
  const onStageKeyDown = (e) => {
    if (!e) return;
    const tag = String(e.target?.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.code === 'Space' || e.key === ' ') {
      e.preventDefault?.();
      togglePlay();
    } else if (e.key === 'ArrowLeft' || e.key === ',') {
      e.preventDefault?.();
      stepFrame(-1);
    } else if (e.key === 'ArrowRight' || e.key === '.') {
      e.preventDefault?.();
      stepFrame(1);
    } else if (e.code === 'KeyM' || String(e.key || '').toLowerCase() === 'm') {
      e.preventDefault?.();
      void addMarkerAtCurrentTime();
    }
  };
  rootEl.addEventListener?.('keydown', onStageKeyDown);
  trackCleanup(() => rootEl.removeEventListener?.('keydown', onStageKeyDown));

  // Load saved cue markers
  try {
    const markerRes = await ctx.bridge.post('/markers/get', { filePath });
    if (!signal?.aborted && markerRes?.ok && Array.isArray(markerRes.markers)) {
      markers = markerRes.markers;
    }
  } catch {}
  if (signal?.aborted) return;

  renderMarkers();
  syncTimeDisplay();

  // Tiered waveform decode during idle time
  const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!skipWaveform && typeof AudioCtx === 'function' && typeof globalThis.fetch === 'function') {
    const stopIdle = ctx?.schedule?.idle?.(() => {
      void (async () => {
        try {
          const resp = await globalThis.fetch(`${ticket.baseUrl}/v1/stream/${ticket.ticketId}`, {
            headers: { [TOKEN_HEADER_CANONICAL]: ticket.token },
            signal
          });
          if (!resp.ok || signal?.aborted) return;
          const arrBuf = await resp.arrayBuffer();
          if (signal?.aborted) return;
          audioCtxInstance = new AudioCtx();
          const decoded = await audioCtxInstance.decodeAudioData(arrBuf);
          if (signal?.aborted) return;
          waveformPeaks = downsampleAudioBuffer(decoded, WAVEFORM_BUCKETS);
          await audioCtxInstance.close?.().catch?.(() => {});
          audioCtxInstance = null;
          syncTimeDisplay();
        } catch {}
      })();
    });
    if (typeof stopIdle === 'function') trackCleanup(stopIdle);
  }
}

module.exports = {
  WAVEFORM_BUCKETS,
  downsampleAudioBuffer,
  mountMediaViewer
};
