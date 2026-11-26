'use strict';

const VALID_PLUGIN_ACTIONS = new Set(['enable', 'disable', 'install', 'uninstall', 'rollback']);
const TOPBAR_PANELS = ['context', 'usage', 'quota'];
const HOST_SETTINGS_SCOPE_ID = 'agy-daddy.host';

const CANONICAL_HOST_LANGUAGES = Object.freeze([
  Object.freeze({ code: 'zh', bcp47: 'zh-CN', nativeName: '简体中文', shortLabel: '简中' }),
  Object.freeze({ code: 'zh-TW', bcp47: 'zh-TW', nativeName: '繁體中文', shortLabel: '繁中' }),
  Object.freeze({ code: 'ja', bcp47: 'ja', nativeName: '日本語', shortLabel: '日本語' }),
  Object.freeze({ code: 'ko', bcp47: 'ko', nativeName: '한국어', shortLabel: '한국어' }),
  Object.freeze({ code: 'es', bcp47: 'es', nativeName: 'Español', shortLabel: 'ES' }),
  Object.freeze({ code: 'pt', bcp47: 'pt', nativeName: 'Português', shortLabel: 'PT' }),
  Object.freeze({ code: 'fr', bcp47: 'fr', nativeName: 'Français', shortLabel: 'FR' }),
  Object.freeze({ code: 'ru', bcp47: 'ru', nativeName: 'Русский', shortLabel: 'RU' }),
  Object.freeze({ code: 'it', bcp47: 'it', nativeName: 'Italiano', shortLabel: 'IT' }),
  Object.freeze({ code: 'en', bcp47: 'en', nativeName: 'English', shortLabel: 'EN' })
]);

const DEFAULT_HOST_LANGUAGE = CANONICAL_HOST_LANGUAGES[CANONICAL_HOST_LANGUAGES.length - 1];

const WEB_RELEVANT_PLUGIN_POLICY = Object.freeze({
  'agy-daddy.web': Object.freeze({
    mode: 'all',
    reason: 'Web harness server, appearance, drawer speed and workspace roots'
  }),
  'agy-daddy.composer': Object.freeze({
    mode: 'fields',
    fields: Object.freeze([
      'showQuickBar',
      'ghostSuggest',
      'autoCompact',
      'autoCompactThresholdTokens',
      'quickPrompts'
    ]),
    reason: 'Web composer quick prompt bar and compact threshold'
  }),
  'agy-daddy.zh-cn': Object.freeze({
    mode: 'fields',
    fields: Object.freeze(['lang', 'englishLabels']),
    reason: 'Host display language synced with Web UI'
  }),
  'agy-daddy.context': Object.freeze({
    mode: 'all',
    reason: 'Topbar Context capsule telemetry'
  }),
  'agy-daddy.usage': Object.freeze({
    mode: 'all',
    reason: 'Topbar Usage capsule telemetry'
  }),
  'agy-daddy.quota': Object.freeze({
    mode: 'all',
    reason: 'Topbar Quota capsule telemetry'
  }),
  'agy-daddy.pet': Object.freeze({
    mode: 'all',
    reason: 'Desktop & PC-Web companion pet, themes, and session watch filters'
  })
});

const BUILTIN_ARTIFACT_PREVIEWERS = Object.freeze([
  Object.freeze({
    id: 'builtin.markdown',
    name: 'Markdown',
    extensions: Object.freeze(['md', 'markdown']),
    mimeTypes: Object.freeze(['text/markdown']),
    source: 'builtin',
    renderKind: 'markdown'
  }),
  Object.freeze({
    id: 'builtin.svg',
    name: 'SVG',
    extensions: Object.freeze(['svg']),
    mimeTypes: Object.freeze(['image/svg+xml']),
    source: 'builtin',
    renderKind: 'svg'
  }),
  Object.freeze({
    id: 'builtin.image',
    name: 'Image',
    extensions: Object.freeze(['jpg', 'jpeg', 'png', 'gif', 'webp']),
    mimeTypes: Object.freeze(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
    source: 'builtin',
    renderKind: 'image'
  }),
  Object.freeze({
    id: 'builtin.html',
    name: 'HTML',
    extensions: Object.freeze(['html', 'htm']),
    mimeTypes: Object.freeze(['text/html']),
    source: 'builtin',
    renderKind: 'html'
  }),
  Object.freeze({
    id: 'builtin.pdf',
    name: 'PDF',
    extensions: Object.freeze(['pdf']),
    mimeTypes: Object.freeze(['application/pdf']),
    source: 'builtin',
    renderKind: 'pdf'
  })
]);

const VALID_PLUGIN_RENDER_KINDS = new Set([
  'markdown',
  'image',
  'svg',
  'html',
  'pdf',
  'plugin_iframe',
  'plugin_html',
  'plugin_markdown'
]);

function normalizeArtifactExtension(raw) {
  return String(raw || '').trim().replace(/^\./, '').toLowerCase();
}

function normalizePluginPreviewerDescriptor(raw, fallbackPluginId = '') {
  if (!isPlainObject(raw)) return null;
  const pluginId = String(raw.pluginId || fallbackPluginId || '').trim() || undefined;
  const id = String(raw.id || (pluginId ? `${pluginId}.previewer` : '')).trim();
  if (!id) return null;

  const extensions = Array.isArray(raw.extensions)
    ? Array.from(new Set(raw.extensions.map(normalizeArtifactExtension).filter(Boolean)))
    : [];
  const mimeTypes = Array.isArray(raw.mimeTypes)
    ? Array.from(new Set(raw.mimeTypes.map((m) => String(m || '').trim().toLowerCase()).filter(Boolean)))
    : [];
  if (extensions.length === 0 && mimeTypes.length === 0) return null;

  const rawRenderKind = typeof raw.renderKind === 'string' ? raw.renderKind.trim() : '';
  const iframeUrlTemplate = typeof raw.iframeUrlTemplate === 'string' && raw.iframeUrlTemplate.trim()
    ? raw.iframeUrlTemplate.trim()
    : undefined;
  const renderKind = VALID_PLUGIN_RENDER_KINDS.has(rawRenderKind)
    ? rawRenderKind
    : (iframeUrlTemplate ? 'plugin_iframe' : 'plugin_html');

  const out = {
    id,
    name: String(raw.name || id).trim(),
    extensions,
    mimeTypes,
    source: 'plugin',
    renderKind
  };
  if (pluginId) out.pluginId = pluginId;
  if (iframeUrlTemplate) out.iframeUrlTemplate = iframeUrlTemplate;
  return out;
}

function extractPreviewerItems(rawVal, fallbackPluginId = '') {
  const val = unwrapStateEntry(rawVal);
  if (val === null) return [];
  const list = Array.isArray(val)
    ? val
    : (isPlainObject(val) && Array.isArray(val.previewers) ? val.previewers : (isPlainObject(val) && val.id ? [val] : []));
  const out = [];
  for (const item of list) {
    const normalized = normalizePluginPreviewerDescriptor(item, fallbackPluginId);
    if (normalized) out.push(normalized);
  }
  return out;
}

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function resolveHostLanguageEntry(raw) {
  let candidate = raw;
  if (isPlainObject(raw)) {
    candidate = raw.bcp47 ?? raw.locale ?? raw.code ?? raw.lang ?? '';
  }
  const clean = String(candidate || '').trim().replace(/_/g, '-').toLowerCase();
  if (!clean) return DEFAULT_HOST_LANGUAGE;

  if (clean === 'zh-tw' || clean === 'zh-hk' || clean === 'zh-mo' || clean.startsWith('zh-hant')) {
    return CANONICAL_HOST_LANGUAGES.find((entry) => entry.code === 'zh-TW') || DEFAULT_HOST_LANGUAGE;
  }
  if (clean === 'zh' || clean === 'zh-cn' || clean === 'zh-sg' || clean.startsWith('zh-hans') || clean.startsWith('zh-')) {
    return CANONICAL_HOST_LANGUAGES.find((entry) => entry.code === 'zh') || DEFAULT_HOST_LANGUAGE;
  }
  for (const entry of CANONICAL_HOST_LANGUAGES) {
    if (entry.code === 'zh' || entry.code === 'zh-TW') continue;
    const lower = entry.code.toLowerCase();
    if (clean === lower || clean.startsWith(`${lower}-`)) {
      return entry;
    }
  }
  return DEFAULT_HOST_LANGUAGE;
}

function toBcp47Locale(raw) {
  return resolveHostLanguageEntry(raw).bcp47;
}

function toHostLangCode(raw) {
  return resolveHostLanguageEntry(raw).code;
}

function normalizeSupportedLanguages(rawList) {
  if (!Array.isArray(rawList) || rawList.length === 0) {
    return CANONICAL_HOST_LANGUAGES.map((entry) => ({ ...entry }));
  }
  const normalized = [];
  for (const item of rawList) {
    if (typeof item === 'string') {
      const entry = resolveHostLanguageEntry(item);
      normalized.push({ ...entry });
    } else if (isPlainObject(item)) {
      const fallback = resolveHostLanguageEntry(item);
      normalized.push({
        code: String(item.code || item.lang || fallback.code),
        bcp47: String(item.bcp47 || item.locale || fallback.bcp47),
        nativeName: String(item.nativeName || item.label || fallback.nativeName),
        shortLabel: String(item.shortLabel || fallback.shortLabel)
      });
    }
  }
  return normalized.length > 0 ? normalized : CANONICAL_HOST_LANGUAGES.map((entry) => ({ ...entry }));
}

function annotateWebPluginItem(item) {
  if (!isPlainObject(item)) return item;
  const pluginId = String(item.id || '').trim();
  const policy = Object.prototype.hasOwnProperty.call(WEB_RELEVANT_PLUGIN_POLICY, pluginId)
    ? WEB_RELEVANT_PLUGIN_POLICY[pluginId]
    : null;

  let webRelevant;
  let webRelevanceReason;
  let webVisibleFields;

  if (Array.isArray(item.surfaces)) {
    webRelevant = item.surfaces.includes('web');
    if (webRelevant) {
      webRelevanceReason = item.webRelevanceReason || policy?.reason || 'Declared for web surface';
      webVisibleFields = policy?.mode === 'fields' ? [...policy.fields] : '*';
    } else {
      webRelevanceReason = item.webRelevanceReason || 'Desktop-only plugin (not declared for web surface)';
      webVisibleFields = null;
    }
  } else if (policy) {
    webRelevant = true;
    webRelevanceReason = policy.reason;
    webVisibleFields = policy.mode === 'fields' ? [...policy.fields] : '*';
  } else {
    webRelevant = false;
    webRelevanceReason = 'Desktop-only plugin';
    webVisibleFields = null;
  }

  return {
    ...item,
    webRelevant,
    webRelevanceReason,
    webVisibleFields
  };
}

function isSchemaFieldWebVisible(field, policy) {
  if (Array.isArray(field?.surfaces)) {
    return field.surfaces.includes('web');
  }
  if (!policy) return false;
  if (policy.mode === 'all') return true;
  if (policy.mode === 'fields') {
    return Boolean(field?.key && policy.fields.includes(field.key));
  }
  return false;
}

function projectWebPluginSettings(pluginId, res) {
  const policy = Object.prototype.hasOwnProperty.call(WEB_RELEVANT_PLUGIN_POLICY, pluginId)
    ? WEB_RELEVANT_PLUGIN_POLICY[pluginId]
    : null;
  const rawValues = isPlainObject(res?.values) ? res.values : {};
  const rawSecretState = isPlainObject(res?.secretState) ? res.secretState : undefined;
  const rawSchema = isPlainObject(res?.schema) ? res.schema : undefined;

  let filteredSchema = rawSchema;
  let filteredDesktopFieldCount = 0;
  let filteredValues = {};
  let filteredSecretState = rawSecretState;

  if (rawSchema && Array.isArray(rawSchema.fields)) {
    const visibleFields = rawSchema.fields.filter((f) => isSchemaFieldWebVisible(f, policy));
    const hiddenKeys = new Set(
      rawSchema.fields
        .filter((f) => !isSchemaFieldWebVisible(f, policy))
        .map((f) => f?.key)
        .filter(Boolean)
    );
    const visibleKeys = new Set(visibleFields.map((f) => f?.key).filter(Boolean));
    filteredDesktopFieldCount = rawSchema.fields.length - visibleFields.length;
    filteredSchema = { ...rawSchema, fields: visibleFields };

    for (const [k, v] of Object.entries(rawValues)) {
      if (hiddenKeys.has(k)) continue;
      if (visibleKeys.has(k)) {
        filteredValues[k] = v;
      } else if (policy?.mode === 'all') {
        filteredValues[k] = v;
      } else if (policy?.mode === 'fields' && policy.fields.includes(k)) {
        filteredValues[k] = v;
      }
    }

    if (rawSecretState) {
      filteredSecretState = {};
      for (const [k, v] of Object.entries(rawSecretState)) {
        if (hiddenKeys.has(k)) continue;
        if (visibleKeys.has(k) || policy?.mode === 'all' || (policy?.mode === 'fields' && policy.fields.includes(k))) {
          filteredSecretState[k] = v;
        }
      }
    }
  } else if (policy?.mode === 'all') {
    filteredValues = { ...rawValues };
  } else if (policy?.mode === 'fields') {
    const allowed = new Set(policy.fields);
    for (const [k, v] of Object.entries(rawValues)) {
      if (allowed.has(k)) {
        filteredValues[k] = v;
      } else {
        filteredDesktopFieldCount += 1;
      }
    }
    if (rawSecretState) {
      filteredSecretState = {};
      for (const [k, v] of Object.entries(rawSecretState)) {
        if (allowed.has(k)) filteredSecretState[k] = v;
      }
    }
  } else {
    filteredDesktopFieldCount = Object.keys(rawValues).length;
    if (rawSecretState) filteredSecretState = {};
  }

  return {
    filteredValues,
    filteredSchema,
    filteredSecretState,
    filteredDesktopFieldCount
  };
}

function createHttpError(statusCode, message, code = message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

// Zero-dependency Byte-mode QR Code matrix & SVG generator (Version 1..10, ECC Level L)
const QR_GF_EXP = new Uint8Array(512);
const QR_GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    QR_GF_EXP[i] = x;
    QR_GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) QR_GF_EXP[i] = QR_GF_EXP[i - 255];
})();

function qrGfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return QR_GF_EXP[QR_GF_LOG[a] + QR_GF_LOG[b]];
}

function qrRsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    const root = QR_GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= qrGfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

function qrRsRemainder(data, ecCount) {
  const gen = qrRsGeneratorPoly(ecCount);
  const res = new Array(data.length + ecCount).fill(0);
  for (let i = 0; i < data.length; i++) res[i] = data[i];
  for (let i = 0; i < data.length; i++) {
    const coef = res[i];
    if (coef === 0) continue;
    for (let j = 0; j < gen.length; j++) {
      res[i + j] ^= qrGfMul(gen[j], coef);
    }
  }
  return res.slice(data.length);
}

const QR_VERSION_SPECS = [
  [1, 21, 19, 7, 1, 19, 0, 0, []],
  [2, 25, 34, 10, 1, 34, 0, 0, [6, 18]],
  [3, 29, 55, 15, 1, 55, 0, 0, [6, 22]],
  [4, 33, 80, 20, 1, 80, 0, 0, [6, 26]],
  [5, 37, 108, 26, 1, 108, 0, 0, [6, 30]],
  [6, 41, 136, 18, 2, 68, 0, 0, [6, 34]],
  [7, 45, 156, 20, 2, 78, 0, 0, [6, 22, 38]],
  [8, 49, 194, 24, 2, 97, 0, 0, [6, 24, 42]],
  [9, 53, 232, 30, 2, 116, 0, 0, [6, 26, 46]],
  [10, 57, 274, 18, 2, 68, 2, 69, [6, 28, 50]]
];

function selectQrVersion(byteLen) {
  for (const spec of QR_VERSION_SPECS) {
    const headerBits = 4 + (spec[0] >= 10 ? 16 : 8);
    const availBits = spec[2] * 8;
    if (headerBits + byteLen * 8 <= availBits) return spec;
  }
  throw new Error(`QR payload too long (${byteLen} bytes > max 271 bytes)`);
}

function encodeQrDataCodewords(bytes, spec) {
  const [ver, , totalData] = spec;
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  pushBits(0b0100, 4);
  pushBits(bytes.length, ver >= 10 ? 16 : 8);
  for (const b of bytes) pushBits(b, 8);
  const capacity = totalData * 8;
  for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let val = 0;
    for (let j = 0; j < 8; j++) val = (val << 1) | bits[i + j];
    codewords.push(val);
  }
  let padIdx = 0;
  while (codewords.length < totalData) {
    codewords.push(padIdx % 2 === 0 ? 0xec : 0x11);
    padIdx++;
  }
  return codewords;
}

function interleaveQrCodewords(data, spec) {
  const [, , , ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data] = spec;
  const blocks = [];
  let offset = 0;
  for (let i = 0; i < g1Blocks; i++) {
    const d = data.slice(offset, offset + g1Data);
    offset += g1Data;
    blocks.push({ d, ec: qrRsRemainder(d, ecPerBlock) });
  }
  for (let i = 0; i < g2Blocks; i++) {
    const d = data.slice(offset, offset + g2Data);
    offset += g2Data;
    blocks.push({ d, ec: qrRsRemainder(d, ecPerBlock) });
  }
  const out = [];
  const maxD = Math.max(g1Data, g2Data);
  for (let col = 0; col < maxD; col++) {
    for (const blk of blocks) {
      if (col < blk.d.length) out.push(blk.d[col]);
    }
  }
  for (let col = 0; col < ecPerBlock; col++) {
    for (const blk of blocks) out.push(blk.ec[col]);
  }
  return out;
}

function qrBchFormatInfo(maskId) {
  const data = (0b01 << 3) | maskId;
  let d = data << 10;
  const poly = 0b10100110111;
  for (let i = 14; i >= 10; i--) {
    if ((d >>> i) & 1) d ^= poly << (i - 10);
  }
  return ((data << 10) | d) ^ 0b101010000010010;
}

function qrBchVersionInfo(ver) {
  if (ver < 7) return 0;
  let d = ver << 12;
  const poly = 0b1111100100101;
  for (let i = 17; i >= 12; i--) {
    if ((d >>> i) & 1) d ^= poly << (i - 12);
  }
  return (ver << 12) | d;
}

function placeQrMatrix(spec, codewords) {
  const [ver, size, , , , , , , align] = spec;
  const modules = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFixed = (x, y, val) => {
    if (x >= 0 && y >= 0 && x < size && y < size) {
      modules[y][x] = val ? 1 : 0;
      reserved[y][x] = true;
    }
  };

  const drawFinder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        setFixed(cx + dx, cy + dy, dist !== 2 && dist !== 4);
      }
    }
  };
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);

  for (let i = 8; i < size - 8; i++) {
    const val = i % 2 === 0;
    setFixed(i, 6, val);
    setFixed(6, i, val);
  }

  for (const cy of align) {
    for (const cx of align) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          setFixed(cx + dx, cy + dy, dist !== 1);
        }
      }
    }
  }

  setFixed(8, size - 8, 1);

  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      reserved[8][i] = true;
      reserved[i][8] = true;
    }
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }

  if (ver >= 7) {
    const vBits = qrBchVersionInfo(ver);
    for (let i = 0; i < 18; i++) {
      const bit = (vBits >>> i) & 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFixed(a, b, bit);
      setFixed(b, a, bit);
    }
  }

  const allBits = [];
  for (const cw of codewords) {
    for (let b = 7; b >= 0; b--) allBits.push((cw >>> b) & 1);
  }

  const maskId = 0;
  let bitIdx = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step;
      for (let colOff = 0; colOff < 2; colOff++) {
        const x = right - colOff;
        if (reserved[y][x]) continue;
        const dataBit = bitIdx < allBits.length ? allBits[bitIdx++] : 0;
        const maskBit = (x + y) % 2 === 0 ? 1 : 0;
        modules[y][x] = dataBit ^ maskBit;
      }
    }
    upward = !upward;
  }

  const fmt = qrBchFormatInfo(maskId);
  for (let i = 0; i < 15; i++) {
    const bit = (fmt >>> i) & 1;
    if (i < 6) modules[i][8] = bit;
    else if (i < 8) modules[i + 1][8] = bit;
    else modules[size - 15 + i][8] = bit;

    if (i < 8) modules[8][size - 1 - i] = bit;
    else if (i < 9) modules[8][15 - i] = bit;
    else modules[8][14 - i] = bit;
  }

  return { version: ver, size, modules };
}

function generateQrSvg(text, options = {}) {
  const bytes = Array.from(Buffer.from(String(text || ''), 'utf8'));
  const spec = selectQrVersion(bytes.length);
  const data = encodeQrDataCodewords(bytes, spec);
  const interleaved = interleaveQrCodewords(data, spec);
  const { size, modules } = placeQrMatrix(spec, interleaved);
  const margin = Number.isInteger(options.margin) ? options.margin : 2;
  const fg = String(options.fg || '#0a0a0c');
  const bg = String(options.bg || '#ffffff');
  const dim = size + margin * 2;
  const paths = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) paths.push(`M${x + margin},${y + margin}h1v1h-1z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${options.width || 180}" height="${options.height || 180}" shape-rendering="crispEdges" role="img" aria-label="Agy-Daddy Pairing QR">`
    + `<rect width="100%" height="100%" fill="${bg}"/>`
    + `<path d="${paths.join('')}" fill="${fg}"/>`
    + `</svg>`;
}

function unwrapStateEntry(entry) {
  if (entry === null || entry === undefined) return null;
  if (typeof entry === 'object' && 'value' in entry) {
    return entry.value === undefined ? null : entry.value;
  }
  return entry;
}

/**
 * Create a thin proxy around host.control / host.services / host.state for the PC Web gateway.
 */
function createHostProxy({ host, commands } = {}) {
  async function invokeControl(routePath, body = {}) {
    if (!host?.control || typeof host.control.invoke !== 'function') {
      throw createHttpError(503, 'HOST_CONTROL_UNAVAILABLE');
    }
    return await host.control.invoke(routePath, body);
  }

  function resolveLocalCommand(cmdId) {
    if (!commands) return null;
    if (commands instanceof Map) return commands.get(cmdId) || null;
    if (typeof commands === 'object' && typeof commands[cmdId] === 'function') {
      return commands[cmdId];
    }
    return null;
  }

  async function getPlugins({ scope } = {}) {
    const res = await invokeControl('/host/plugins', {});
    const rawPlugins = Array.isArray(res?.plugins) ? res.plugins : [];
    const rawCatalog = Array.isArray(res?.catalog) ? res.catalog : [];
    const annotatedPlugins = rawPlugins.map(annotateWebPluginItem);
    const annotatedCatalog = rawCatalog.map(annotateWebPluginItem);

    const normalizedScope = scope === 'web' ? 'web' : (scope === 'all' ? 'all' : undefined);
    if (normalizedScope === 'web') {
      const filteredPlugins = annotatedPlugins.filter((p) => p.webRelevant === true);
      const filteredCatalog = annotatedCatalog.filter((c) => c.webRelevant === true);
      const allPluginsCount = annotatedPlugins.length;
      const hiddenDesktopCount = allPluginsCount - filteredPlugins.length;
      const marketStats = {
        total: filteredPlugins.length + filteredCatalog.length,
        installed: filteredPlugins.length,
        active: filteredPlugins.filter((p) => Boolean(p?.active)).length,
        catalogCount: filteredCatalog.length
      };
      return {
        ok: res?.ok !== false,
        ...res,
        plugins: filteredPlugins,
        catalog: filteredCatalog,
        marketStats,
        scope: 'web',
        hiddenDesktopCount,
        allPluginsCount
      };
    }

    const marketStats = res?.marketStats || {
      total: annotatedPlugins.length + annotatedCatalog.length,
      installed: annotatedPlugins.length,
      active: annotatedPlugins.filter((p) => Boolean(p?.active)).length,
      catalogCount: annotatedCatalog.length
    };
    return {
      ok: res?.ok !== false,
      ...res,
      plugins: annotatedPlugins,
      catalog: annotatedCatalog,
      marketStats,
      ...(normalizedScope ? { scope: normalizedScope } : {})
    };
  }

  async function pluginAction(pluginId, action, body = {}) {
    const cleanId = String(pluginId || '').trim();
    const cleanAction = String(action || '').trim().toLowerCase();
    if (!cleanId) {
      throw createHttpError(400, 'PLUGIN_ID_REQUIRED');
    }
    if (!VALID_PLUGIN_ACTIONS.has(cleanAction)) {
      throw createHttpError(400, `INVALID_PLUGIN_ACTION: ${cleanAction}`, 'INVALID_PLUGIN_ACTION');
    }
    const extra = isPlainObject(body) ? body : {};

    if (cleanAction === 'enable' || cleanAction === 'disable') {
      return await invokeControl('/host/plugins/toggle', {
        ...extra,
        pluginId: cleanId,
        enabled: cleanAction === 'enable'
      });
    }
    if (cleanAction === 'install') {
      return await invokeControl('/host/plugins/install', {
        ...extra,
        spec: extra.spec || cleanId,
        pluginId: cleanId
      });
    }
    return await invokeControl(`/host/plugins/${cleanAction}`, {
      ...extra,
      pluginId: cleanId
    });
  }

  async function getHostSettings() {
    const res = await invokeControl('/host/settings', {
      pluginId: HOST_SETTINGS_SCOPE_ID,
      scope: 'host',
      action: 'get'
    });
    return {
      ok: res?.ok !== false,
      ...res,
      values: res?.values !== undefined ? res.values : {}
    };
  }

  async function mergeSettingsPatch(pluginId, patch, scope) {
    let base = {};
    try {
      const current = await invokeControl('/host/settings', {
        pluginId,
        ...(scope ? { scope } : {}),
        action: 'get'
      });
      if (isPlainObject(current?.values)) {
        base = { ...current.values };
      }
      const secretState = isPlainObject(current?.secretState) ? current.secretState : null;
      if (secretState) {
        for (const [k, sMeta] of Object.entries(secretState)) {
          if (Object.prototype.hasOwnProperty.call(patch, k)) continue;
          const masked = isPlainObject(sMeta) ? sMeta.masked : undefined;
          if (masked !== undefined && base[k] === masked) {
            delete base[k];
          }
        }
      }
    } catch {
      // Soft-fallback to patch directly if existing settings cannot be fetched
    }
    return { ...base, ...patch };
  }

  async function setHostSettings(patch) {
    if (!isPlainObject(patch)) {
      throw createHttpError(400, 'INVALID_SETTINGS_PATCH');
    }
    const mergedValues = await mergeSettingsPatch(HOST_SETTINGS_SCOPE_ID, patch, 'host');
    const res = await invokeControl('/host/settings', {
      pluginId: HOST_SETTINGS_SCOPE_ID,
      scope: 'host',
      action: 'save',
      values: mergedValues,
      patch
    });
    if (res?.ok === false) {
      return { statusCode: res.statusCode || 400, ...res };
    }
    if (res?.values !== undefined) {
      return { ok: true, ...res };
    }
    return {
      ok: true,
      ...res,
      values: mergedValues
    };
  }

  async function getPluginSettings(pluginId, { scope } = {}) {
    const cleanId = String(pluginId || '').trim();
    if (!cleanId) {
      throw createHttpError(400, 'PLUGIN_ID_REQUIRED');
    }
    const res = await invokeControl('/host/settings', {
      pluginId: cleanId,
      action: 'get'
    });
    if (scope === 'web') {
      const {
        filteredValues,
        filteredSchema,
        filteredSecretState,
        filteredDesktopFieldCount
      } = projectWebPluginSettings(cleanId, res);
      const out = {
        ok: res?.ok !== false,
        ...res,
        values: filteredValues,
        scope: 'web',
        filteredDesktopFieldCount
      };
      if (filteredSecretState !== undefined) out.secretState = filteredSecretState;
      if (filteredSchema !== undefined) out.schema = filteredSchema;
      return out;
    }
    const out = {
      ok: res?.ok !== false,
      ...res,
      values: res?.values !== undefined ? res.values : {},
      ...(scope === 'all' ? { scope: 'all' } : {})
    };
    if (res?.secretState !== undefined) out.secretState = res.secretState;
    if (res?.schema !== undefined) out.schema = res.schema;
    return out;
  }

  async function setPluginSettings(pluginId, patch) {
    const cleanId = String(pluginId || '').trim();
    if (!cleanId) {
      throw createHttpError(400, 'PLUGIN_ID_REQUIRED');
    }
    if (!isPlainObject(patch)) {
      throw createHttpError(400, 'INVALID_SETTINGS_PATCH');
    }
    const mergedValues = await mergeSettingsPatch(cleanId, patch);
    const res = await invokeControl('/host/settings', {
      pluginId: cleanId,
      action: 'save',
      values: mergedValues,
      patch
    });
    if (res?.ok === false) {
      return { statusCode: res.statusCode || 400, ...res };
    }
    if (res?.values !== undefined || res?.secretState !== undefined) {
      return { ok: true, ...res };
    }
    try {
      return await getPluginSettings(cleanId);
    } catch {
      return { ok: true, ...res, values: mergedValues };
    }
  }

  async function runCommand(cmdId, { args = [], pluginId } = {}) {
    const cleanCmd = String(cmdId || '').trim();
    if (!cleanCmd) {
      throw createHttpError(400, 'COMMAND_ID_REQUIRED');
    }
    const argList = Array.isArray(args) ? args : [];
    const localHandler = resolveLocalCommand(cleanCmd);
    if (typeof localHandler === 'function') {
      const result = await localHandler(...argList);
      return { ok: true, commandId: cleanCmd, result };
    }

    try {
      const res = await invokeControl('/host/bus/call', {
        service: pluginId || 'commands',
        method: 'runCommand',
        args: [cleanCmd, ...argList],
        commandId: cleanCmd,
        pluginId,
        optional: true
      });
      if (res && res.ok === false && res.unavailable) {
        return {
          ok: false,
          statusCode: 404,
          error: 'COMMAND_NOT_FOUND',
          commandId: cleanCmd
        };
      }
      const result = res?.result !== undefined
        ? res.result
        : (res?.value !== undefined ? res.value : res);
      return {
        ok: true,
        commandId: cleanCmd,
        result
      };
    } catch (err) {
      if (err?.statusCode === 503) throw err;
      const msg = String(err?.message || '');
      if (/SERVICE_METHOD_NOT_FOUND|SERVICE_UNAVAILABLE|COMMAND_NOT_FOUND/.test(msg)) {
        return {
          ok: false,
          statusCode: 404,
          error: 'COMMAND_NOT_FOUND',
          commandId: cleanCmd,
          message: msg
        };
      }
      return {
        ok: false,
        statusCode: err?.statusCode || 500,
        error: err?.code || 'COMMAND_EXECUTION_FAILED',
        commandId: cleanCmd,
        message: msg
      };
    }
  }

  async function getDoctor() {
    return await invokeControl('/host/health', {});
  }

  function buildContextSettings(data, extraSettings) {
    const rawDisplay = data?.displayLocation ?? extraSettings?.displayLocation;
    const displayLocation = rawDisplay === 'topbar' ? 'topbar' : 'composer';
    const rawShowSpeed = data?.showSpeed ?? extraSettings?.showSpeed;
    const showSpeed = rawShowSpeed === undefined ? true : Boolean(rawShowSpeed);
    const rawPolicy = data?.compactPolicy ?? extraSettings?.compactPolicy;
    const compactPolicy = typeof rawPolicy === 'string' && rawPolicy.trim() ? rawPolicy.trim() : 'remind';
    return {
      displayLocation,
      showSpeed,
      compactPolicy
    };
  }

  async function enrichContextSlot(slot) {
    let extraSettings = null;
    if (slot?.data?.displayLocation === undefined && host?.services && typeof host.services.call === 'function') {
      try {
        const res = await host.services.call('context', 'getSettings', [], { optional: true });
        if (res?.ok && isPlainObject(res.value)) {
          extraSettings = res.value;
        } else if (isPlainObject(res) && !('ok' in res) && res.unavailable !== true) {
          extraSettings = res;
        }
      } catch {
        // Soft-degrade to defaults when context.getSettings is unavailable
      }
    }
    return {
      ...slot,
      settings: buildContextSettings(slot.data, extraSettings)
    };
  }

  async function fetchTopbarPanel(name) {
    if (name === 'context' && typeof host?.services?.has === 'function' && host.services.has('context') === false) {
      return { available: false };
    }
    const serviceMethods = name === 'usage' ? ['getSummary', 'getSnapshot'] : ['getSnapshot'];
    if (host?.services && typeof host.services.call === 'function') {
      for (const methodName of serviceMethods) {
        try {
          const res = await host.services.call(name, methodName, [], { optional: true });
          if (res && res.ok === true && res.value !== null && res.value !== undefined) {
            const slot = { available: true, source: 'service', data: res.value };
            return name === 'context' ? await enrichContextSlot(slot) : slot;
          }
          if (res && typeof res === 'object' && !('ok' in res) && res.unavailable !== true) {
            const slot = { available: true, source: 'service', data: res };
            return name === 'context' ? await enrichContextSlot(slot) : slot;
          }
        } catch {
          // Try next candidate method or fall back to bus state snapshots.
        }
      }
    }

    if (host?.state && typeof host.state.get === 'function') {
      const candidateKeys = name === 'usage'
        ? ['state:usage.summary@1', 'state:usage.snapshot@1', 'state:usage.status@1']
        : [`state:${name}.snapshot@1`, `state:${name}.status@1`];
      for (const key of candidateKeys) {
        try {
          const val = unwrapStateEntry(host.state.get(key));
          if (val !== null) {
            const slot = { available: true, source: 'state', data: val };
            return name === 'context' ? await enrichContextSlot(slot) : slot;
          }
        } catch {
          // Ignore individual state lookup errors so other panels still render.
        }
      }
    }

    return { available: false };
  }

  async function getTopbar() {
    const entries = await Promise.all(
      TOPBAR_PANELS.map(async (name) => [name, await fetchTopbarPanel(name)])
    );
    return {
      ok: true,
      panels: Object.fromEntries(entries)
    };
  }

  async function callOptionalRemoteService(methodName) {
    if (!host?.services || typeof host.services.call !== 'function') return null;
    try {
      const res = await host.services.call('remote', methodName, [], { optional: true });
      if (res && res.ok === true && 'value' in res) {
        return isPlainObject(res.value) ? res.value : null;
      }
      if (isPlainObject(res) && res.ok !== false && res.unavailable !== true) {
        return res;
      }
    } catch {
      // Soft-degrade when remote service or method is absent
    }
    return null;
  }

  async function getRemoteStatus() {
    const snap = await callOptionalRemoteService('getSnapshot');
    let stateVal = null;
    if (host?.state && typeof host.state.get === 'function') {
      try {
        const rawState = unwrapStateEntry(host.state.get('state:remote.status@1'));
        if (isPlainObject(rawState)) stateVal = rawState;
      } catch {
        // Soft-ignore state read failures
      }
    }

    const hasUrlInPrimary = Boolean(
      (snap && (snap.pairingUrl || snap.primaryUrl))
      || (stateVal && (stateVal.pairingUrl || stateVal.primaryUrl))
    );
    let bundleVal = null;
    let statusVal = null;
    if (!hasUrlInPrimary && host?.services && typeof host.services.call === 'function') {
      [bundleVal, statusVal] = await Promise.all([
        callOptionalRemoteService('getPairingBundle'),
        callOptionalRemoteService('getStatus')
      ]);
    }

    const hasAnyData = Boolean(snap || stateVal || bundleVal || statusVal);
    if (!hasAnyData) {
      return {
        ok: true,
        available: false,
        running: false
      };
    }

    const merged = {
      ...(stateVal || {}),
      ...(statusVal || {}),
      ...(bundleVal || {}),
      ...(snap || {})
    };

    const pairingUrl = typeof merged.pairingUrl === 'string' && merged.pairingUrl.trim()
      ? merged.pairingUrl.trim()
      : (typeof merged.primaryUrl === 'string' && merged.primaryUrl.trim() ? merged.primaryUrl.trim() : '');
    const url = typeof merged.url === 'string' && merged.url.trim()
      ? merged.url.trim()
      : '';

    let qrSvg = typeof merged.qrSvg === 'string' && merged.qrSvg.trim()
      ? merged.qrSvg.trim()
      : '';
    if (!qrSvg && pairingUrl) {
      try {
        qrSvg = generateQrSvg(pairingUrl, { width: 180, height: 180 });
      } catch {
        qrSvg = '';
      }
    }

    const port = Number.isInteger(merged.port) ? merged.port : null;
    const running = merged.running !== undefined
      ? Boolean(merged.running)
      : Boolean(pairingUrl || port);
    const allowRemoteWrite = typeof merged.allowRemoteWrite === 'boolean'
      ? merged.allowRemoteWrite
      : (typeof merged.writeEnabled === 'boolean' ? merged.writeEnabled : undefined);
    const deviceCount = Number.isFinite(Number(merged.deviceCount))
      ? Number(merged.deviceCount)
      : (Number.isFinite(Number(merged.devicesCount)) ? Number(merged.devicesCount) : undefined);

    return {
      ok: true,
      available: true,
      running,
      port,
      ...(url ? { url } : {}),
      ...(pairingUrl ? { pairingUrl } : {}),
      ...(qrSvg ? { qrSvg } : {}),
      ...(typeof merged.primaryChannel === 'string' && merged.primaryChannel
        ? { primaryChannel: merged.primaryChannel }
        : {}),
      ...(typeof merged.permissionLevel === 'string' && merged.permissionLevel
        ? { permissionLevel: merged.permissionLevel }
        : {}),
      ...(allowRemoteWrite !== undefined ? { allowRemoteWrite } : {}),
      ...(isPlainObject(merged.channels) ? { channels: merged.channels } : {}),
      ...(deviceCount !== undefined ? { deviceCount } : {})
    };
  }

const DEFAULT_COMPOSER_SETTINGS = Object.freeze({
  showQuickBar: true,
  ghostSuggest: true,
  autoAccept: false,
  autoCompact: false,
  autoCompactThresholdTokens: 240000
});

const DEFAULT_WEB_QUICK_PROMPTS = Object.freeze([
  {
    id: 'compact',
    group: 'daily',
    label: '/compact 压缩',
    labelEn: '/compact',
    slash: 'compact',
    text: '/compact',
    title: '压缩上下文，防止上下文超限卡顿',
    titleEn: 'Compact context via /compact command',
    enabled: true,
    builtin: true
  },
  {
    id: 'plan',
    group: 'daily',
    label: '/plan 规划',
    labelEn: '/plan',
    slash: 'plan',
    text: '/plan ',
    title: '先制定计划再修改文件',
    titleEn: 'Enter planning mode before editing',
    enabled: true,
    builtin: true
  },
  {
    id: 'goal',
    group: 'heavy',
    label: '/goal 持续到底',
    labelEn: '/goal',
    slash: 'goal',
    text: '/goal ',
    title: '持续执行并校验直到目标彻底完成',
    titleEn: 'Run toward goal until verified complete',
    enabled: true,
    builtin: true
  },
  {
    id: 'grill-me',
    group: 'daily',
    label: '/grill-me 追问对齐',
    labelEn: '/grill-me',
    slash: 'grill-me',
    text: '/grill-me ',
    title: '主动追问澄清需求与边界条件',
    titleEn: 'Interview to clarify requirements and edge cases',
    enabled: false,
    builtin: true
  },
  {
    id: 'btw',
    group: 'daily',
    label: '/btw 旁路提问',
    labelEn: '/btw',
    slash: 'btw',
    text: '/btw ',
    title: '不打断主线上下文快速旁路提问',
    titleEn: 'Ask a quick side question without interrupting',
    enabled: false,
    builtin: true
  },
  {
    id: 'learn',
    group: 'daily',
    label: '/learn 提炼经验',
    labelEn: '/learn',
    slash: 'learn',
    text: '/learn ',
    title: '沉淀经验为可复用规则或 Skill',
    titleEn: 'Capture lessons as reusable rules or skills',
    enabled: false,
    builtin: true
  },
  {
    id: 'boost',
    group: 'heavy',
    label: '/boost 深度攻坚',
    labelEn: '/boost',
    slash: 'boost',
    text: '/boost ',
    title: '深度推理与严格验证',
    titleEn: 'Deep thinking and strict verification',
    enabled: false,
    builtin: true
  },
  {
    id: 'swarm',
    group: 'heavy',
    label: '/swarm 蜂群并发',
    labelEn: '/swarm',
    slash: 'swarm',
    text: '/swarm ',
    title: '多代理并发协同',
    titleEn: 'Parallel multi-agent execution',
    enabled: false,
    builtin: true
  }
]);

function localOptimizePrompt(rawText) {
  const clean = String(rawText || '').trim();
  if (!clean) return { ok: false, error: 'EMPTY_PROMPT' };
  const optimized = clean.includes('\n')
    ? clean
    : `Goal:\n${clean}\n\nRequirements:\n- Inspect relevant code before editing\n- Verify changes with tests or checks\n- Summarize files changed and verification results`;
  return {
    ok: true,
    original: clean,
    optimized,
    candidate: 'local-structurer',
    candidates: ['local-structurer']
  };
}

function localExportMarkdown(events = [], opts = {}) {
  const title = opts.title || 'Antigravity Session Export';
  const lines = [`# ${title}`, ''];
  for (const ev of Array.isArray(events) ? events : []) {
    const seq = ev?.seq ?? '';
    const kind = ev?.kind || ev?.rawType || 'event';
    lines.push(`## Step #${seq} (${kind})`);
    const p = ev?.payload || {};
    if (kind === 'user') {
      lines.push(String(p.userResponse || p.text || ''));
    } else if (kind === 'thinking_and_text') {
      if (p.thinking) lines.push(`<details><summary>Thinking</summary>\n\n${p.thinking}\n\n</details>\n`);
      if (p.modifiedResponse || p.response || p.text) lines.push(String(p.modifiedResponse || p.response || p.text));
    } else if (kind === 'command') {
      lines.push(`\`\`\`sh\n$ ${p.commandLine || p.proposedCommandLine || ''}\n\`\`\``);
      if (p.combinedOutput) lines.push(`\`\`\`text\n${p.combinedOutput}\n\`\`\``);
    } else {
      lines.push(`\`\`\`json\n${JSON.stringify(p, null, 2)}\n\`\`\``);
    }
    lines.push('');
  }
  return { ok: true, markdown: lines.join('\n') };
}

  async function getComposerState() {
    let available = false;
    let settings = { ...DEFAULT_COMPOSER_SETTINGS };
    let builtins = DEFAULT_WEB_QUICK_PROMPTS.map((item) => ({ ...item }));
    let custom = [];

    if (host?.services && typeof host.services.call === 'function') {
      try {
        const [setRes, listRes] = await Promise.all([
          host.services.call('composer-node', 'getSettings', [], { optional: true }),
          host.services.call('composer-node', 'listQuickPrompts', [], { optional: true })
        ]);
        if (setRes?.ok && isPlainObject(setRes.value)) {
          available = true;
          settings = { ...settings, ...setRes.value };
        }
        if (listRes?.ok && isPlainObject(listRes.value)) {
          available = true;
          if (Array.isArray(listRes.value.builtins) && listRes.value.builtins.length > 0) {
            builtins = listRes.value.builtins;
          }
          if (Array.isArray(listRes.value.custom)) {
            custom = listRes.value.custom;
          }
        }
      } catch {
        // Soft-degrade cleanly when composer plugin is absent
      }
    }

    if (!available && host?.state && typeof host.state.get === 'function') {
      try {
        const snap = unwrapStateEntry(host.state.get('state:composer.settings@1'));
        if (isPlainObject(snap) && snap.available === true) {
          available = true;
          if (isPlainObject(snap.settings)) {
            settings = { ...settings, ...snap.settings };
          }
          if (Array.isArray(snap.builtins) && snap.builtins.length > 0) {
            builtins = snap.builtins;
          }
          if (Array.isArray(snap.custom)) {
            custom = snap.custom;
          }
        }
      } catch {
        // Ignore state lookup failures
      }
    }

    return {
      ok: true,
      available,
      settings,
      builtins,
      custom
    };
  }

  async function optimizePrompt(rawText) {
    const clean = String(rawText || '').trim();
    if (!clean) {
      return { ok: false, statusCode: 400, error: 'EMPTY_PROMPT' };
    }
    if (host?.services && typeof host.services.call === 'function') {
      try {
        const res = await host.services.call('composer-node', 'optimizePrompt', [clean, {}], { optional: true, timeoutMs: 50000 });
        if (res?.ok && res.value?.ok) {
          return res.value;
        }
      } catch {
        // Fall back to local prompt structurer
      }
    }
    return localOptimizePrompt(clean);
  }

  async function exportSessionMarkdown({ cascadeId, title, events } = {}) {
    if (host?.services && typeof host.services.call === 'function' && cascadeId) {
      try {
        const res = await host.services.call('composer-node', 'exportMarkdown', [{ cascadeId, title }], { optional: true });
        if (res?.ok && res.value?.ok && typeof res.value.markdown === 'string') {
          return res.value;
        }
      } catch {
        // Fall back to local serializer below
      }
    }
    return localExportMarkdown(events, { title });
  }

  async function fetchSupportedHostLanguages() {
    if (host?.services && typeof host.services.call === 'function') {
      try {
        const res = await host.services.call('zh-cn', 'getSupportedLanguages', [], { optional: true });
        if (Array.isArray(res)) {
          return normalizeSupportedLanguages(res);
        }
        if (res && res.ok === true && Array.isArray(res.value)) {
          return normalizeSupportedLanguages(res.value);
        }
        if (isPlainObject(res) && res.ok !== false && Array.isArray(res.languages)) {
          return normalizeSupportedLanguages(res.languages);
        }
      } catch {
        // Fall back to canonical host languages
      }
    }
    return CANONICAL_HOST_LANGUAGES.map((entry) => ({ ...entry }));
  }

  function extractLocaleCandidate(raw) {
    if (typeof raw === 'string') {
      const s = raw.trim();
      return s || null;
    }
    if (isPlainObject(raw)) {
      const candidate = raw.bcp47 ?? raw.locale ?? raw.lang ?? raw.code;
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }
    return null;
  }

  async function getHostLocale() {
    let rawLocale = null;
    let source = 'default';

    if (host?.state && typeof host.state.get === 'function') {
      try {
        const hostLocaleVal = unwrapStateEntry(host.state.get('state:host.locale@1'));
        const candidate = extractLocaleCandidate(hostLocaleVal);
        if (candidate) {
          rawLocale = candidate;
          source = 'state:host.locale@1';
        }
      } catch {
        // Ignore state read failure and try next source
      }

      if (!rawLocale) {
        try {
          const zhCnVal = unwrapStateEntry(host.state.get('state:zh-cn.lang@1'));
          const candidate = extractLocaleCandidate(zhCnVal);
          if (candidate) {
            rawLocale = candidate;
            source = 'state:zh-cn.lang@1';
          }
        } catch {
          // Ignore state read failure and try service
        }
      }
    }

    if (!rawLocale && host?.services && typeof host.services.call === 'function') {
      try {
        const res = await host.services.call('zh-cn', 'getConfig', [], { optional: true });
        const cfg = res && res.ok === true && isPlainObject(res.value)
          ? res.value
          : (isPlainObject(res) && !('ok' in res) && res.unavailable !== true ? res : null);
        const candidate = extractLocaleCandidate(cfg);
        if (candidate) {
          rawLocale = candidate;
          source = 'service:zh-cn';
        }
      } catch {
        // Fall back to default 'en'
      }
    }

    const entry = resolveHostLanguageEntry(rawLocale || 'en');
    const supportedLanguages = await fetchSupportedHostLanguages();
    return {
      ok: true,
      locale: entry.bcp47,
      hostLang: entry.code,
      source,
      supportedLanguages
    };
  }

  async function setHostLocale(rawLang) {
    if (rawLang === undefined || rawLang === null || (typeof rawLang === 'string' && !rawLang.trim())) {
      throw createHttpError(400, 'LOCALE_REQUIRED');
    }
    const entry = resolveHostLanguageEntry(rawLang);
    const bcp47 = entry.bcp47;
    const hostLang = entry.code;

    let serviceHandled = false;
    if (host?.services && typeof host.services.call === 'function') {
      try {
        const res = await host.services.call('zh-cn', 'setLang', [hostLang], { optional: true });
        if (res && res.ok !== false && res.unavailable !== true) {
          serviceHandled = true;
        }
      } catch {
        // Fall back to plugin settings when zh-cn service is unavailable
      }
    }

    if (!serviceHandled && host?.control && typeof host.control.invoke === 'function') {
      await setPluginSettings('agy-daddy.zh-cn', { lang: hostLang });
    }

    if (host?.state && typeof host.state.set === 'function') {
      host.state.set('state:host.locale@1', {
        bcp47,
        locale: bcp47,
        lang: hostLang
      });
    }

    const supportedLanguages = await fetchSupportedHostLanguages();
    return {
      ok: true,
      locale: bcp47,
      hostLang,
      supportedLanguages
    };
  }

  async function getArtifactPreviewers() {
    const byId = new Map();
    const collect = (rawVal, fallbackPluginId = '') => {
      for (const desc of extractPreviewerItems(rawVal, fallbackPluginId)) {
        if (!byId.has(desc.id)) {
          byId.set(desc.id, desc);
        }
      }
    };

    if (host?.state && typeof host.state.get === 'function') {
      try {
        collect(await Promise.resolve(host.state.get('state:host.artifact-previewers@1')));
      } catch {
        // Ignore state read errors when artifact previewers state is unavailable
      }

      const enumMethod = typeof host.state.keys === 'function'
        ? () => host.state.keys()
        : (typeof host.state.list === 'function' ? () => host.state.list() : null);
      if (enumMethod) {
        try {
          const keys = await Promise.resolve(enumMethod());
          if (Array.isArray(keys)) {
            for (const entry of keys) {
              const key = typeof entry === 'string' ? entry : (isPlainObject(entry) ? entry.key : '');
              if (
                typeof key === 'string' &&
                /^state:.*\.artifact-previewers@1$/.test(key) &&
                key !== 'state:host.artifact-previewers@1'
              ) {
                try {
                  const pluginHint = key.slice('state:'.length, -'.artifact-previewers@1'.length);
                  const val = isPlainObject(entry) && 'value' in entry
                    ? entry
                    : await Promise.resolve(host.state.get(key));
                  collect(val, pluginHint);
                } catch {
                  // Ignore individual state entry lookup failures
                }
              }
            }
          }
        } catch {
          // Ignore state enumeration failures
        }
      }
    }

    if (host?.services && typeof host.services.call === 'function') {
      try {
        const res = await host.services.call('artifact-previewer', 'listPreviewers', [], { optional: true });
        if (res && res.ok !== false && res.unavailable !== true) {
          const payload = res.ok === true && 'value' in res ? res.value : res;
          collect(payload);
        }
      } catch {
        // Soft-degrade when artifact-previewer service is absent
      }
    }

    if (host?.control && typeof host.control.invoke === 'function') {
      try {
        const pluginsRes = await getPlugins();
        const activePlugins = Array.isArray(pluginsRes?.plugins)
          ? pluginsRes.plugins.filter((p) => p && (p.active === true || (p.active === undefined && p.enabled !== false)))
          : [];
        for (const plugin of activePlugins) {
          const pid = String(plugin.id || '').trim();
          if (!pid) continue;
          if (Array.isArray(plugin.artifactPreviewers)) {
            collect(plugin.artifactPreviewers, pid);
          } else if (Array.isArray(plugin.previewers)) {
            collect(plugin.previewers, pid);
          }
          if (host?.state && typeof host.state.get === 'function') {
            const shortId = pid.includes('.') ? pid.split('.').slice(1).join('.') : pid;
            const candidateKeys = Array.from(new Set([
              `state:${pid}.artifact-previewers@1`,
              `state:${shortId}.artifact-previewers@1`
            ]));
            for (const key of candidateKeys) {
              try {
                collect(await Promise.resolve(host.state.get(key)), pid);
              } catch {
                // Ignore individual plugin state lookup errors
              }
            }
          }
        }
      } catch {
        // Soft-degrade when host.control is unavailable
      }
    }

    return {
      ok: true,
      builtins: BUILTIN_ARTIFACT_PREVIEWERS,
      plugins: Array.from(byId.values())
    };
  }

  async function renderPluginArtifactPreview({ pluginId, sessionId, file, mime } = {}) {
    const cleanPluginId = String(pluginId || '').trim();
    if (!cleanPluginId) {
      return { ok: false, statusCode: 400, error: 'PLUGIN_ID_REQUIRED' };
    }
    if (!host?.services || typeof host.services.call !== 'function') {
      return {
        ok: false,
        statusCode: 501,
        error: 'ARTIFACT_PREVIEW_SERVICE_UNAVAILABLE',
        pluginId: cleanPluginId
      };
    }

    try {
      const res = await host.services.call(
        cleanPluginId,
        'previewArtifact',
        [{ sessionId, file, mime }],
        { optional: true }
      );
      if (!res || res.unavailable === true) {
        return {
          ok: false,
          statusCode: 404,
          error: 'ARTIFACT_PREVIEWER_UNAVAILABLE',
          pluginId: cleanPluginId
        };
      }
      if (res.ok === false) {
        return {
          statusCode: res.statusCode || 404,
          error: res.error || 'ARTIFACT_PREVIEWER_UNAVAILABLE',
          ...res,
          ok: false
        };
      }
      const payload = res.ok === true && 'value' in res ? res.value : res;
      if (payload === null || payload === undefined) {
        return {
          ok: false,
          statusCode: 404,
          error: 'ARTIFACT_PREVIEWER_UNAVAILABLE',
          pluginId: cleanPluginId
        };
      }
      if (typeof payload === 'string') {
        return { ok: true, kind: 'html', content: payload };
      }
      if (isPlainObject(payload)) {
        if (payload.ok === false) {
          return {
            statusCode: payload.statusCode || 500,
            error: payload.error || 'ARTIFACT_PREVIEW_FAILED',
            ...payload,
            ok: false
          };
        }
        return { ok: true, ...payload };
      }
      return {
        ok: false,
        statusCode: 501,
        error: 'INVALID_ARTIFACT_PREVIEW_RESPONSE',
        pluginId: cleanPluginId
      };
    } catch (err) {
      const msg = String(err?.message || '');
      if (err?.statusCode === 404 || /SERVICE_METHOD_NOT_FOUND|SERVICE[_\s]UNAVAILABLE|NOT[_\s]FOUND/i.test(msg)) {
        return {
          ok: false,
          statusCode: 404,
          error: 'ARTIFACT_PREVIEWER_UNAVAILABLE',
          pluginId: cleanPluginId,
          message: msg
        };
      }
      if (err?.statusCode === 501) {
        return {
          ok: false,
          statusCode: 501,
          error: err?.code || 'NOT_IMPLEMENTED',
          pluginId: cleanPluginId,
          message: msg
        };
      }
      return {
        ok: false,
        statusCode: err?.statusCode || 500,
        error: err?.code || 'ARTIFACT_PREVIEW_FAILED',
        pluginId: cleanPluginId,
        message: msg
      };
    }
  }

  async function getPetState() {
    if (!hasService('pet')) {
      return { ok: true, available: false, state: null, scene: null, themes: [] };
    }
    try {
      const res = await host.services.call('pet', 'getSnapshot', [], { optional: true });
      const val = res?.ok && 'value' in res ? res.value : res;
      if (!val || typeof val !== 'object') {
        return { ok: true, available: false, state: null, scene: null, themes: [] };
      }
      return { ok: true, available: true, ...val };
    } catch (err) {
      return { ok: false, available: false, error: err?.message || 'PET_STATE_FAILED' };
    }
  }

  async function interactPet(payload = {}) {
    if (!hasService('pet')) {
      return { ok: false, statusCode: 404, error: 'PET_SERVICE_UNAVAILABLE' };
    }
    if (payload?.action === 'set-active-session') {
      const res = await host.services.call('pet', 'setActiveWebSession', [payload.cascadeId || null], { optional: true });
      return { ok: true, activeSession: res?.value ?? res };
    }
    if (payload?.action === 'import-theme') {
      const res = await host.services.call('pet', 'importThemePack', [payload], { optional: true });
      return res?.value ?? res;
    }
    if (payload?.action === 'delete-theme') {
      const res = await host.services.call('pet', 'deleteCustomTheme', [payload.themeId], { optional: true });
      return res?.value ?? res;
    }
    const res = await host.services.call('pet', 'handleInteraction', [payload], { optional: true });
    return res?.value ?? res;
  }

  return {
    getPlugins,
    pluginAction,
    getHostSettings,
    setHostSettings,
    getPluginSettings,
    setPluginSettings,
    getHostLocale,
    setHostLocale,
    runCommand,
    getDoctor,
    getTopbar,
    getRemoteStatus,
    getComposerState,
    optimizePrompt,
    exportSessionMarkdown,
    getArtifactPreviewers,
    renderPluginArtifactPreview,
    getPetState,
    interactPet
  };
}

module.exports = {
  VALID_PLUGIN_ACTIONS,
  CANONICAL_HOST_LANGUAGES,
  WEB_RELEVANT_PLUGIN_POLICY,
  BUILTIN_ARTIFACT_PREVIEWERS,
  toBcp47Locale,
  toHostLangCode,
  createHostProxy
};
