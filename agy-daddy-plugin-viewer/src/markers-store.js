'use strict';

const crypto = require('node:crypto');
const {
  MARKERS_MAX_PER_FILE,
  MARKERS_MAX_FILES,
  MARKERS_STORAGE_FILE,
  MARKER_TONES,
  ERROR_CODES,
  safeErrorPayload
} = require('./constants');

function computeFileFingerprint(realPath, size, mtimeMs) {
  const raw = `${String(realPath || '')}:${Number(size) || 0}:${Math.floor(Number(mtimeMs) || 0)}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function sanitizeMarker(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const timeSec = Number(raw.timeSec);
  if (!Number.isFinite(timeSec) || timeSec < 0) return null;

  const idRaw = typeof raw.id === 'string' && raw.id.trim()
    ? raw.id.trim().slice(0, 64)
    : `m_${crypto.randomBytes(4).toString('hex')}_${index}`;
  const label = typeof raw.label === 'string'
    ? raw.label.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200)
    : '';
  const tone = MARKER_TONES.includes(raw.tone) ? raw.tone : 'neutral';
  const createdAt = typeof raw.createdAt === 'string' && raw.createdAt.trim()
    ? raw.createdAt.trim().slice(0, 64)
    : new Date().toISOString();

  return {
    id: idRaw,
    timeSec: Math.round(timeSec * 1000) / 1000,
    label,
    tone,
    createdAt
  };
}

function createMarkersStore(storage) {
  let memoryFallback = { version: 1, entries: {} };

  function readAll() {
    if (storage && typeof storage.readJson === 'function') {
      const res = storage.readJson(MARKERS_STORAGE_FILE, { version: 1, entries: {} });
      const data = res?.data;
      if (data && typeof data === 'object' && data.entries && typeof data.entries === 'object') {
        return data;
      }
      return { version: 1, entries: {} };
    }
    return memoryFallback;
  }

  function writeAll(doc) {
    if (storage && typeof storage.writeJson === 'function') {
      return storage.writeJson(MARKERS_STORAGE_FILE, doc);
    }
    memoryFallback = doc;
    return { ok: true };
  }

  function pruneLru(entries) {
    const keys = Object.keys(entries);
    if (keys.length <= MARKERS_MAX_FILES) return entries;
    keys.sort((a, b) => (Number(entries[a]?.updatedAtMs) || 0) - (Number(entries[b]?.updatedAtMs) || 0));
    const removeCount = keys.length - MARKERS_MAX_FILES;
    for (let i = 0; i < removeCount; i++) {
      delete entries[keys[i]];
    }
    return entries;
  }

  function getMarkers(fingerprint) {
    const doc = readAll();
    const entry = doc.entries?.[fingerprint];
    const markers = Array.isArray(entry?.markers) ? entry.markers : [];
    return {
      ok: true,
      fingerprint,
      markers
    };
  }

  function saveMarkers(fingerprint, rawMarkers) {
    if (!Array.isArray(rawMarkers)) {
      return safeErrorPayload(ERROR_CODES.INVALID_ARGUMENT, 'markers 必须为数组');
    }

    const sanitized = [];
    const seenIds = new Set();
    for (let i = 0; i < rawMarkers.length && sanitized.length < MARKERS_MAX_PER_FILE; i++) {
      const m = sanitizeMarker(rawMarkers[i], i);
      if (!m) continue;
      if (seenIds.has(m.id)) continue;
      seenIds.add(m.id);
      sanitized.push(m);
    }
    sanitized.sort((a, b) => a.timeSec - b.timeSec);

    const doc = readAll();
    if (!doc.entries || typeof doc.entries !== 'object') doc.entries = {};

    if (sanitized.length === 0) {
      delete doc.entries[fingerprint];
    } else {
      doc.entries[fingerprint] = {
        updatedAtMs: Date.now(),
        markers: sanitized
      };
      pruneLru(doc.entries);
    }

    const writeRes = writeAll({ version: 1, entries: doc.entries });
    if (writeRes && writeRes.ok === false) {
      return { ok: false, errorCode: 'STORAGE_WRITE_FAILED', message: '打点记录持久化失败' };
    }

    return {
      ok: true,
      fingerprint,
      savedCount: sanitized.length
    };
  }

  return {
    getMarkers,
    saveMarkers
  };
}

module.exports = {
  computeFileFingerprint,
  sanitizeMarker,
  createMarkersStore
};
