'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_UNPACKED_BYTES = 12 * 1024 * 1024; // 12 MB
const MAX_ENTRY_COUNT = 32;
const MAX_CUSTOM_THEMES = 20;
const MAX_THEME_JSON_BYTES = 128 * 1024;
const MAX_RASTER_BYTES = 1024 * 1024;
const MAX_RASTER_DIM = 512;

const FORBIDDEN_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx',
  '.wasm', '.html', '.htm', '.xhtml', '.sh', '.bash', '.zsh',
  '.ps1', '.psm1', '.bat', '.cmd', '.vbs', '.exe', '.dll', '.dylib', '.so'
]);

const ALLOWED_EXTENSIONS = new Set(['.json', '.png', '.webp', '.gif', '.svg']);

function loadTarParser() {
  try {
    const hostTarPath = path.resolve(__dirname, '..', '..', 'agy-daddy-host', 'src', 'core', 'tar.js');
    if (fs.existsSync(hostTarPath)) {
      return require(hostTarPath).parseTarBuffer;
    }
  } catch {}
  return function parseTarBufferFallback(buf) {
    const entries = [];
    let offset = 0;
    while (offset + 512 <= buf.length) {
      const header = buf.subarray(offset, offset + 512);
      let isZero = true;
      for (let i = 0; i < 512; i++) {
        if (header[i] !== 0) { isZero = false; break; }
      }
      if (isZero) break;
      const nameRaw = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
      const prefixRaw = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
      const sizeOctal = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
      const typeFlag = String.fromCharCode(header[156] || 48);
      const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
      const fullName = prefixRaw ? `${prefixRaw}/${nameRaw}` : nameRaw;
      offset += 512;
      const data = buf.subarray(offset, offset + size);
      offset += Math.ceil(size / 512) * 512;
      if (typeFlag === 'g' || typeFlag === 'x') continue;
      entries.push({ name: fullName, type: typeFlag, data });
    }
    return entries;
  };
}

const parseTarBuffer = loadTarParser();

function inspectRasterHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 10) return null;
  if (
    buf.length >= 24 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (
    buf.length >= 10 &&
    buf.subarray(0, 4).toString('ascii') === 'GIF8' &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return { format: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (
    buf.length >= 30 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    const chunk = buf.subarray(12, 16).toString('ascii');
    if (chunk === 'VP8X' && buf.length >= 30) {
      return {
        format: 'webp',
        width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
        height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16))
      };
    }
    if (chunk === 'VP8 ' && buf.length >= 30 && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      return {
        format: 'webp',
        width: buf.readUInt16LE(26) & 0x3fff,
        height: buf.readUInt16LE(28) & 0x3fff
      };
    }
    if (chunk === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
      const b1 = buf[21];
      const b2 = buf[22];
      const b3 = buf[23];
      const b4 = buf[24];
      return {
        format: 'webp',
        width: 1 + (((b2 & 0x3f) << 8) | b1),
        height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6))
      };
    }
  }
  return null;
}

function packError(code, msg) {
  return Object.assign(new Error(`${code}: ${msg}`), { code });
}

function sanitizeSvgToLayers(svgText) {
  const raw = String(svgText || '');
  if (!raw.trim()) {
    throw packError('UNSAFE_SVG_CONTENT', 'Empty SVG file');
  }
  const forbiddenPatterns = [
    /<\s*script\b/i,
    /<\s*foreignObject\b/i,
    /on[a-z]+\s*=/i,
    /javascript\s*:/i,
    /data\s*:\s*text\/html/i,
    /https?:\/\//i,
    /@import\b/i
  ];
  for (const re of forbiddenPatterns) {
    if (re.test(raw)) {
      throw packError('UNSAFE_SVG_CONTENT', `SVG contains forbidden active/external content (${re})`);
    }
  }

  const layers = [];
  const pathRe = /<path\b([^>]*)>/gi;
  let m;
  while ((m = pathRe.exec(raw)) !== null && layers.length < 48) {
    const attrs = m[1] || '';
    const dMatch = /\bd\s*=\s*["']([^"']+)["']/i.exec(attrs);
    if (!dMatch) continue;
    const d = dMatch[1].trim();
    if (!/^[MLHVCSQTAZmlhvcsqtaz0-9.,\s+-]+$/.test(d)) {
      throw packError('UNSAFE_SVG_CONTENT', 'SVG path data contains invalid tokens');
    }
    const fillMatch = /\bfill\s*=\s*["']([^"']+)["']/i.exec(attrs);
    const strokeMatch = /\bstroke\s*=\s*["']([^"']+)["']/i.exec(attrs);
    const swMatch = /\bstroke-width\s*=\s*["']([^"']+)["']/i.exec(attrs);
    layers.push({
      id: `svg-path-${layers.length}`,
      kind: 'path',
      d,
      fill: fillMatch ? fillMatch[1].trim() : '#a78bfa',
      ...(strokeMatch ? { stroke: strokeMatch[1].trim() } : {}),
      ...(swMatch && Number.isFinite(Number(swMatch[1])) ? { strokeWidth: Number(swMatch[1]) } : {})
    });
  }

  const circleRe = /<circle\b([^>]*)>/gi;
  while ((m = circleRe.exec(raw)) !== null && layers.length < 64) {
    const attrs = m[1] || '';
    const cx = Number((/\bcx\s*=\s*["']([^"']+)["']/i.exec(attrs) || [])[1] || 0);
    const cy = Number((/\bcy\s*=\s*["']([^"']+)["']/i.exec(attrs) || [])[1] || 0);
    const r = Number((/\br\s*=\s*["']([^"']+)["']/i.exec(attrs) || [])[1] || 0);
    if (!Number.isFinite(r) || r <= 0) continue;
    const fillMatch = /\bfill\s*=\s*["']([^"']+)["']/i.exec(attrs);
    layers.push({
      id: `svg-circle-${layers.length}`,
      kind: 'circle',
      cx,
      cy,
      r,
      fill: fillMatch ? fillMatch[1].trim() : '#a78bfa'
    });
  }

  if (layers.length === 0) {
    throw Object.assign(new Error('SVG yielded no valid geometric path/circle layers'), {
      code: 'UNSAFE_SVG_CONTENT'
    });
  }
  return layers;
}

function slugifyThemeId(rawId) {
  const clean = String(rawId || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return clean || `custom-${Date.now()}`;
}

function validateSafeArchiveEntryName(rawName) {
  const name = String(rawName || '');
  if (!name || name.includes('\0') || name.startsWith('/') || name.startsWith('\\') || /^[a-zA-Z]:/.test(name)) {
    throw packError('UNSAFE_PACK_PATH', `Unsafe archive path: ${name}`);
  }
  const normalized = name.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((p) => p === '..')) {
    throw packError('UNSAFE_PACK_PATH', `Path traversal in archive entry: ${name}`);
  }
  return parts.join('/');
}

function normalizeAndValidateManifest(rawManifest, customSlug, assetPathMap = new Map()) {
  if (!rawManifest || typeof rawManifest !== 'object' || Array.isArray(rawManifest)) {
    throw Object.assign(new Error('Invalid pet-theme.json manifest'), { code: 'INVALID_THEME_MANIFEST' });
  }
  const sceneInput = rawManifest.scene && typeof rawManifest.scene === 'object' ? rawManifest.scene : rawManifest;
  const vbW = Math.min(512, Math.max(32, Number(sceneInput.viewBox?.width || 160)));
  const vbH = Math.min(512, Math.max(32, Number(sceneInput.viewBox?.height || 160)));
  const hitBox = {
    x: Number(sceneInput.hitBox?.x ?? 20),
    y: Number(sceneInput.hitBox?.y ?? 20),
    width: Math.min(vbW, Math.max(16, Number(sceneInput.hitBox?.width || vbW - 40))),
    height: Math.min(vbH, Math.max(16, Number(sceneInput.hitBox?.height || vbH - 40)))
  };

  const rawLayers = Array.isArray(sceneInput.layers) ? sceneInput.layers.slice(0, 64) : [];
  const layers = [];
  for (const item of rawLayers) {
    if (!item || typeof item !== 'object') continue;
    const kind = ['path', 'circle', 'rect', 'ellipse', 'sprite'].includes(item.kind) ? item.kind : 'path';
    const layer = { id: String(item.id || `layer-${layers.length}`), kind };
    if (kind === 'path') {
      const d = String(item.d || '').trim();
      if (!d || !/^[MLHVCSQTAZmlhvcsqtaz0-9.,\s+-]+$/.test(d)) {
        throw Object.assign(new Error(`Invalid SVG path data in custom theme layer ${layer.id}`), {
          code: 'UNSAFE_SVG_CONTENT'
        });
      }
      layer.d = d;
    } else if (kind === 'circle') {
      layer.cx = Number(item.cx || 0);
      layer.cy = Number(item.cy || 0);
      layer.r = Math.max(0.5, Number(item.r || 10));
    } else if (kind === 'ellipse') {
      layer.cx = Number(item.cx || 0);
      layer.cy = Number(item.cy || 0);
      layer.rx = Math.max(0.5, Number(item.rx || 10));
      layer.ry = Math.max(0.5, Number(item.ry || 10));
    } else if (kind === 'rect') {
      layer.x = Number(item.x || 0);
      layer.y = Number(item.y || 0);
      layer.width = Math.max(1, Number(item.width || 10));
      layer.height = Math.max(1, Number(item.height || 10));
      if (item.cornerRadius !== undefined) layer.cornerRadius = Math.max(0, Number(item.cornerRadius));
    } else if (kind === 'sprite') {
      const spRaw = String(item.spritePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
      const resolved = assetPathMap.get(spRaw);
      if (!resolved) {
        throw Object.assign(new Error(`Sprite missing or blocked by sandbox: ${item.spritePath}`), {
          code: 'UNSAFE_SPRITE_REF'
        });
      }
      layer.spritePath = resolved;
      layer.x = Number(item.x || 0);
      layer.y = Number(item.y || 0);
      layer.width = Math.max(8, Number(item.width || vbW));
      layer.height = Math.max(8, Number(item.height || vbH));
    }
    if (typeof item.fill === 'string') layer.fill = item.fill.trim();
    if (typeof item.stroke === 'string') layer.stroke = item.stroke.trim();
    if (item.strokeWidth !== undefined) layer.strokeWidth = Number(item.strokeWidth);
    if (item.opacity !== undefined) layer.opacity = Number(item.opacity);
    if (item.motion && typeof item.motion === 'object') layer.motion = item.motion;
    layers.push(layer);
  }

  if (layers.length === 0) {
    throw Object.assign(new Error('Custom theme must contain at least one valid layer'), {
      code: 'INVALID_THEME_MANIFEST'
    });
  }

  const nameRaw = rawManifest.name;
  const name = typeof nameRaw === 'string' && nameRaw.trim()
    ? { 'zh-CN': nameRaw.trim().slice(0, 40), en: nameRaw.trim().slice(0, 40) }
    : (nameRaw && typeof nameRaw === 'object' ? nameRaw : { 'zh-CN': customSlug, en: customSlug });

  return {
    id: `custom:${customSlug}`,
    slug: customSlug,
    name,
    description: rawManifest.description || { 'zh-CN': '本地导入自定义形象', en: 'Locally imported custom pet pack' },
    accentHex: typeof rawManifest.accentHex === 'string' && /^#[0-9a-fA-F]{6}$/.test(rawManifest.accentHex)
      ? rawManifest.accentHex
      : '#a78bfa',
    builtin: false,
    scene: {
      sceneId: `custom:${customSlug}`,
      viewBox: { width: vbW, height: vbH },
      fps: { active: 30, idle: 12, sleep: 4 },
      hitBox,
      particles: sceneInput.particles && typeof sceneInput.particles === 'object'
        ? sceneInput.particles
        : { preset: 'sparks', color: '#a78bfa' },
      layers
    }
  };
}

function listCustomThemes(customThemesDir) {
  if (!customThemesDir || !fs.existsSync(customThemesDir)) return [];
  const out = [];
  for (const ent of fs.readdirSync(customThemesDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const mfPath = path.join(customThemesDir, ent.name, 'theme.resolved.json');
    if (!fs.existsSync(mfPath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
      if (data && data.id && data.scene) out.push(data);
    } catch {}
  }
  return out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function deleteCustomTheme(customThemesDir, themeId) {
  const slug = String(themeId || '').replace(/^custom:/, '').trim();
  if (!slug || slug.includes('..') || slug.includes('/') || slug.includes('\\')) {
    return { ok: false, error: 'INVALID_THEME_ID' };
  }
  if (!fs.existsSync(customThemesDir)) return { ok: false, error: 'NOT_FOUND' };
  const realRoot = fs.realpathSync(customThemesDir);
  const targetDir = path.join(realRoot, slug);
  if (!fs.existsSync(targetDir)) return { ok: false, error: 'NOT_FOUND' };
  const realTarget = fs.realpathSync(targetDir);
  if (!realTarget.startsWith(realRoot + path.sep)) {
    return { ok: false, error: 'UNSAFE_PATH' };
  }
  fs.rmSync(realTarget, { recursive: true, force: true });
  return { ok: true, id: `custom:${slug}` };
}

function importThemePack({ customThemesDir, archiveBase64, jsonText, svgText, fileName = 'custom-pet.agypet' }) {
  if (!customThemesDir) throw new Error('customThemesDir is required');
  fs.mkdirSync(customThemesDir, { recursive: true });
  const realRoot = fs.realpathSync(customThemesDir);

  const existingCount = listCustomThemes(realRoot).length;
  if (existingCount >= MAX_CUSTOM_THEMES) {
    throw Object.assign(new Error(`Custom theme limit (${MAX_CUSTOM_THEMES}) reached`), {
      code: 'CUSTOM_THEME_LIMIT_EXCEEDED'
    });
  }

  const cleanFileName = String(fileName || '').toLowerCase();

  // Direct JSON manifest import
  if (jsonText !== undefined || cleanFileName.endsWith('.json')) {
    const rawStr = jsonText !== undefined
      ? String(jsonText)
      : Buffer.from(String(archiveBase64 || ''), 'base64').toString('utf8');
    if (Buffer.byteLength(rawStr, 'utf8') > MAX_THEME_JSON_BYTES) {
      throw Object.assign(new Error('JSON manifest exceeds 128 KB'), { code: 'UNSAFE_PACK_SIZE' });
    }
    const parsed = JSON.parse(rawStr);
    const slug = slugifyThemeId(parsed.id || path.basename(cleanFileName, '.json'));
    const themeDir = path.join(realRoot, slug);
    fs.mkdirSync(themeDir, { recursive: true });
    const resolved = normalizeAndValidateManifest(parsed, slug);
    fs.writeFileSync(path.join(themeDir, 'theme.resolved.json'), JSON.stringify(resolved, null, 2), 'utf8');
    return resolved;
  }

  // Direct single SVG import (Zero-Script SVG Sanitizer)
  if (svgText !== undefined || cleanFileName.endsWith('.svg')) {
    const rawSvg = svgText !== undefined
      ? String(svgText)
      : Buffer.from(String(archiveBase64 || ''), 'base64').toString('utf8');
    if (Buffer.byteLength(rawSvg, 'utf8') > MAX_RASTER_BYTES) {
      throw Object.assign(new Error('SVG exceeds 1 MB'), { code: 'UNSAFE_PACK_SIZE' });
    }
    const layers = sanitizeSvgToLayers(rawSvg);
    const slug = slugifyThemeId(path.basename(cleanFileName, '.svg'));
    const themeDir = path.join(realRoot, slug);
    fs.mkdirSync(themeDir, { recursive: true });
    const resolved = normalizeAndValidateManifest({ id: slug, name: slug, layers }, slug);
    fs.writeFileSync(path.join(themeDir, 'theme.resolved.json'), JSON.stringify(resolved, null, 2), 'utf8');
    return resolved;
  }

  // .agypet / .tar / .tar.gz archive import
  const rawBuf = Buffer.from(String(archiveBase64 || ''), 'base64');
  if (rawBuf.length === 0 || rawBuf.length > MAX_ARCHIVE_BYTES) {
    throw Object.assign(new Error(`Archive size invalid (${rawBuf.length} bytes, max 5 MB)`), {
      code: 'UNSAFE_PACK_SIZE'
    });
  }

  let tarBuf = rawBuf;
  if (rawBuf.length >= 2 && rawBuf[0] === 0x1f && rawBuf[1] === 0x8b) {
    tarBuf = zlib.gunzipSync(rawBuf, { maxOutputLength: MAX_UNPACKED_BYTES + 4096 });
  }
  if (tarBuf.length > MAX_UNPACKED_BYTES) {
    throw Object.assign(new Error('Unpacked archive exceeds 12 MB limit'), { code: 'UNSAFE_PACK_SIZE' });
  }

  const entries = parseTarBuffer(tarBuf);
  if (entries.length === 0 || entries.length > MAX_ENTRY_COUNT) {
    throw Object.assign(new Error(`Archive entry count invalid (${entries.length}, max ${MAX_ENTRY_COUNT})`), {
      code: 'UNSAFE_PACK_ENTRIES'
    });
  }

  let totalUnpacked = 0;
  let manifestJson = null;
  const safeFiles = [];

  for (const ent of entries) {
    if (ent.type === '1' || ent.type === '2' || ent.type === '3' || ent.type === '4' || ent.type === '6') {
      throw packError('UNSAFE_PACK_LINK', `Links/devices forbidden in .agypet archive: ${ent.name}`);
    }
    const safeRel = validateSafeArchiveEntryName(ent.name);
    if (!safeRel || ent.type === '5') continue;

    const ext = path.extname(safeRel).toLowerCase();
    if (FORBIDDEN_EXTENSIONS.has(ext) || !ALLOWED_EXTENSIONS.has(ext)) {
      throw packError('UNSAFE_PACK_FILE_TYPE', `Forbidden file type in .agypet archive: ${safeRel}`);
    }

    totalUnpacked += ent.data.length;
    if (totalUnpacked > MAX_UNPACKED_BYTES) {
      throw packError('UNSAFE_PACK_SIZE', 'Archive unpacked total exceeds 12 MB');
    }

    if (ext === '.json') {
      if (ent.data.length > MAX_THEME_JSON_BYTES) {
        throw packError('UNSAFE_PACK_SIZE', 'pet-theme.json exceeds 128 KB');
      }
      if (path.basename(safeRel) === 'pet-theme.json') {
        manifestJson = JSON.parse(ent.data.toString('utf8'));
      }
    } else if (ext === '.svg') {
      if (ent.data.length > MAX_RASTER_BYTES) {
        throw packError('UNSAFE_PACK_SIZE', `SVG exceeds 1 MB: ${safeRel}`);
      }
      const layers = sanitizeSvgToLayers(ent.data.toString('utf8'));
      safeFiles.push({ rel: safeRel, kind: 'svg-layers', layers });
    } else {
      if (ent.data.length > MAX_RASTER_BYTES) {
        throw packError('UNSAFE_PACK_SIZE', `Sprite exceeds 1 MB: ${safeRel}`);
      }
      const info = inspectRasterHeader(ent.data);
      if (!info) {
        throw packError('UNSAFE_SPRITE_FORMAT', `Invalid raster magic bytes: ${safeRel}`);
      }
      if (info.width <= 0 || info.height <= 0 || info.width > MAX_RASTER_DIM || info.height > MAX_RASTER_DIM) {
        throw packError('UNSAFE_SPRITE_DIMENSIONS', `Sprite dimensions exceed 512x512: ${safeRel}`);
      }
      safeFiles.push({ rel: safeRel, kind: 'raster', data: ent.data });
    }
  }

  if (!manifestJson) {
    throw Object.assign(new Error('Missing pet-theme.json in archive'), { code: 'INVALID_THEME_MANIFEST' });
  }

  const slug = slugifyThemeId(manifestJson.id || path.basename(cleanFileName, path.extname(cleanFileName)));
  const themeDir = path.join(realRoot, slug);
  fs.mkdirSync(themeDir, { recursive: true });
  const realThemeDir = fs.realpathSync(themeDir);
  if (!realThemeDir.startsWith(realRoot + path.sep)) {
    throw Object.assign(new Error('Theme directory escaped sandbox root'), { code: 'UNSAFE_PACK_PATH' });
  }

  const assetPathMap = new Map();
  for (const item of safeFiles) {
    if (item.kind === 'raster') {
      const dest = path.resolve(realThemeDir, item.rel);
      if (!dest.startsWith(realThemeDir + path.sep)) {
        throw Object.assign(new Error('Resolved sprite path escaped theme directory'), { code: 'UNSAFE_PACK_PATH' });
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, item.data);
      const realDest = fs.realpathSync(dest);
      if (!realDest.startsWith(realRoot + path.sep)) {
        throw Object.assign(new Error('Symlink escape detected after write'), { code: 'UNSAFE_PACK_PATH' });
      }
      assetPathMap.set(item.rel, realDest);
      assetPathMap.set(path.basename(item.rel), realDest);
    }
  }

  const resolved = normalizeAndValidateManifest(manifestJson, slug, assetPathMap);
  fs.writeFileSync(path.join(realThemeDir, 'theme.resolved.json'), JSON.stringify(resolved, null, 2), 'utf8');
  return resolved;
}

module.exports = {
  MAX_ARCHIVE_BYTES,
  MAX_UNPACKED_BYTES,
  MAX_ENTRY_COUNT,
  MAX_CUSTOM_THEMES,
  inspectRasterHeader,
  sanitizeSvgToLayers,
  importThemePack,
  listCustomThemes,
  deleteCustomTheme
};
