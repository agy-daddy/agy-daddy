#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const DEFAULT_ICON_DIR = path.resolve(__dirname, '..', 'assets', 'icons');

// CRC32 lookup table for PNG chunk encoding
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, crcInput, crcBuf]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // Filter type 0 (None)
    rgba.copy(raw, rowStart + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = zlib.deflateSync(raw, { level: 9 });
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function encodeIco(entries) {
  // entries: Array<{ size: number, png: Buffer }>
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = 1 (ICO)
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(count * 16);
  let offset = 6 + dir.length;
  const chunks = [header, dir];

  for (let i = 0; i < count; i++) {
    const { size, png } = entries[i];
    const dim = size >= 256 ? 0 : size;
    const base = i * 16;
    dir[base] = dim;
    dir[base + 1] = dim;
    dir[base + 2] = 0; // palette colors
    dir[base + 3] = 0; // reserved
    dir.writeUInt16LE(1, base + 4); // planes
    dir.writeUInt16LE(32, base + 6); // bpp
    dir.writeUInt32LE(png.length, base + 8);
    dir.writeUInt32LE(offset, base + 12);
    chunks.push(png);
    offset += png.length;
  }

  return Buffer.concat(chunks);
}

function encodeIcns(chunksSpec) {
  // chunksSpec: Array<{ type: string, png: Buffer }>
  const parts = [];
  let totalLen = 8;
  for (const item of chunksSpec) {
    const body = item.png;
    const recHeader = Buffer.alloc(8);
    recHeader.write(item.type, 0, 4, 'ascii');
    recHeader.writeUInt32BE(8 + body.length, 4);
    parts.push(recHeader, body);
    totalLen += 8 + body.length;
  }
  const fileHeader = Buffer.alloc(8);
  fileHeader.write('icns', 0, 4, 'ascii');
  fileHeader.writeUInt32BE(totalLen, 4);
  return Buffer.concat([fileHeader, ...parts]);
}

// --- SDF Geometry Helpers ---

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function sdRoundedRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const denom = bax * bax + bay * bay;
  const h = denom > 0 ? clamp((pax * bax + pay * bay) / denom, 0, 1) : 0;
  return Math.hypot(pax - bax * h, pay - bay * h);
}

function sdPolygon(px, py, pts) {
  let d = Infinity;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0];
    const yi = pts[i][1];
    const xj = pts[j][0];
    const yj = pts[j][1];
    const segD = sdSegment(px, py, xi, yi, xj, yj);
    if (segD < d) d = segD;
    const intersect = ((yi > py) !== (yj > py)) &&
      (px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside ? -d : d;
}

function sdEllipseRing(px, py, cx, cy, rx, ry, angleRad, thickness) {
  const dx = px - cx;
  const dy = py - cy;
  const cosA = Math.cos(-angleRad);
  const sinA = Math.sin(-angleRad);
  const lx = dx * cosA - dy * sinA;
  const ly = dx * sinA + dy * cosA;
  const k0 = Math.hypot(lx / rx, ly / ry);
  if (k0 < 1e-6) return Math.min(rx, ry) - thickness * 0.5;
  const k1 = Math.hypot(lx / (rx * rx), ly / (ry * ry));
  const dist = (k0 * (k0 - 1)) / Math.max(k1, 1e-6);
  return Math.abs(dist) - thickness * 0.5;
}

function alphaOver(dstR, dstG, dstB, dstA, srcR, srcG, srcB, srcA) {
  const a = clamp(srcA, 0, 1);
  if (a <= 0) return [dstR, dstG, dstB, dstA];
  const outA = a + dstA * (1 - a);
  if (outA <= 1e-6) return [0, 0, 0, 0];
  const r = (srcR * a + dstR * dstA * (1 - a)) / outA;
  const g = (srcG * a + dstG * dstA * (1 - a)) / outA;
  const b = (srcB * a + dstB * dstA * (1 - a)) / outA;
  return [r, g, b, outA];
}

// Launch "A" Delta Chevron + Crossbar + Orbital Arc coordinates in normalized [0..1] space
const CHEVRON_OUTER = [
  [0.50, 0.21],
  [0.76, 0.77],
  [0.64, 0.77],
  [0.50, 0.45],
  [0.36, 0.77],
  [0.24, 0.77]
];

const CHEVRON_CORE = [
  [0.50, 0.53],
  [0.60, 0.70],
  [0.54, 0.67],
  [0.50, 0.77],
  [0.46, 0.67],
  [0.40, 0.70]
];

function sampleAppIcon(nx, ny, pxScale) {
  const aa = Math.max(0.0012, 1.15 / pxScale);

  // macOS squircle-like rounded badge with subtle drop margin
  const badgeDist = sdRoundedRect(nx, ny, 0.5, 0.5, 0.425, 0.425, 0.195);
  const badgeMask = 1 - smoothstep(-aa, aa, badgeDist);
  const shadowDist = sdRoundedRect(nx, ny - 0.014, 0.5, 0.5, 0.425, 0.425, 0.195);
  const shadowMask = (1 - smoothstep(0, 0.042, Math.max(0, shadowDist))) * 0.26;
  if (badgeMask <= 0) {
    return shadowMask > 1e-4 ? [6, 6, 10, shadowMask] : [0, 0, 0, 0];
  }

  // Obsidian-zinc gradient background (#22222a -> #0e0e12)
  const diag = clamp((nx * 0.45 + ny * 0.85) * 0.82, 0, 1);
  let r = 34 + (14 - 34) * diag;
  let g = 34 + (14 - 34) * diag;
  let b = 42 + (18 - 42) * diag;
  let a = 1;

  // Soft violet-indigo core ambient glow (#6366f1 / #8b5cf6)
  const glowDist = Math.hypot((nx - 0.5) * 0.95, (ny - 0.47) * 0.9);
  const glow = Math.exp(-glowDist * glowDist * 14.5);
  r = r + (116 - r) * glow * 0.42;
  g = g + (108 - g) * glow * 0.34;
  b = b + (246 - b) * glow * 0.58;

  // Subtle top-left specular highlight
  const spec = Math.exp(-Math.pow(Math.hypot(nx - 0.34, ny - 0.24), 2) * 12) * 0.12;
  r = clamp(r + 255 * spec, 0, 255);
  g = clamp(g + 255 * spec, 0, 255);
  b = clamp(b + 255 * spec, 0, 255);

  // Subtle luminous rim inside badge
  const rimDist = Math.abs(badgeDist + 0.008) - 0.0055;
  const rimAlpha = (1 - smoothstep(-aa, aa, rimDist)) * 0.18;
  [r, g, b, a] = alphaOver(r, g, b, a, 245, 245, 255, rimAlpha * badgeMask);

  // Tilted antigravity orbital arc behind/around chevron
  const orbitDist = sdEllipseRing(nx, ny, 0.50, 0.56, 0.31, 0.115, -0.34, 0.024);
  const orbitMask = (1 - smoothstep(-aa, aa, orbitDist)) * badgeMask;
  if (orbitMask > 0) {
    // Fade rear arc behind top of chevron for depth
    const isRear = ny < 0.51 && nx > 0.36 && nx < 0.64;
    const arcAlpha = isRear ? 0.24 : 0.78;
    const arcGrad = clamp((nx - 0.2) / 0.6, 0, 1);
    const ar = 129 + (165 - 129) * arcGrad;
    const ag = 140 + (180 - 140) * arcGrad;
    const ab = 248 + (252 - 248) * arcGrad;
    [r, g, b, a] = alphaOver(r, g, b, a, ar, ag, ab, orbitMask * arcAlpha);
  }

  // Bold geometric upward launch "A" delta chevron (#fafafa -> #d4d4d8)
  const chevDist = sdPolygon(nx, ny, CHEVRON_OUTER);
  const chevMask = (1 - smoothstep(-aa, aa, chevDist)) * badgeMask;
  if (chevMask > 0) {
    const shade = clamp((ny - 0.21) / 0.56, 0, 1);
    const cr = 250 - 38 * shade;
    const cg = 250 - 38 * shade;
    const cb = 252 - 30 * shade;
    [r, g, b, a] = alphaOver(r, g, b, a, cr, cg, cb, chevMask);
  }

  // Inner propulsion diamond / thruster core
  const coreDist = sdPolygon(nx, ny, CHEVRON_CORE);
  const coreMask = (1 - smoothstep(-aa, aa, coreDist)) * badgeMask;
  if (coreMask > 0) {
    [r, g, b, a] = alphaOver(r, g, b, a, 139, 92, 246, coreMask * 0.92);
  }

  // Glowing orbital apex node on upper-right of arc
  const nodeDist = Math.hypot(nx - 0.77, ny - 0.45) - 0.033;
  const nodeMask = (1 - smoothstep(-aa, aa, nodeDist)) * badgeMask;
  if (nodeMask > 0) {
    [r, g, b, a] = alphaOver(r, g, b, a, 244, 244, 248, nodeMask);
  }

  return alphaOver(6, 6, 10, shadowMask, r, g, b, badgeMask);
}

function sampleTrayTemplateIcon(nx, ny, pxScale) {
  const aa = Math.max(0.002, 1.1 / pxScale);
  // Crisp monochrome launch "A" chevron + orbital arc + apex dot (#000000 with alpha)
  const chevPts = [
    [0.50, 0.13],
    [0.84, 0.85],
    [0.68, 0.85],
    [0.50, 0.43],
    [0.32, 0.85],
    [0.16, 0.85]
  ];
  const barPts = [
    [0.37, 0.67],
    [0.63, 0.67],
    [0.67, 0.77],
    [0.33, 0.77]
  ];
  const chevMask = 1 - smoothstep(-aa, aa, sdPolygon(nx, ny, chevPts));
  const barMask = 1 - smoothstep(-aa, aa, sdPolygon(nx, ny, barPts));
  const dotMask = 1 - smoothstep(-aa, aa, Math.hypot(nx - 0.80, ny - 0.25) - 0.085);
  const alpha = clamp(Math.max(chevMask, barMask, dotMask), 0, 1);
  return [0, 0, 0, alpha];
}

function rasterizeIcon(size, sampler, supersample = 4) {
  const rgba = Buffer.alloc(size * size * 4);
  const ss = size <= 36 ? Math.max(supersample, 4) : supersample;
  const invSamples = 1 / (ss * ss);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let accR = 0;
      let accG = 0;
      let accB = 0;
      let accA = 0;

      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const nx = (x + (sx + 0.5) / ss) / size;
          const ny = (y + (sy + 0.5) / ss) / size;
          const [sr, sg, sb, sa] = sampler(nx, ny, size);
          accR += sr * sa;
          accG += sg * sa;
          accB += sb * sa;
          accA += sa;
        }
      }

      const outA = clamp(accA * invSamples, 0, 1);
      const idx = (y * size + x) * 4;
      if (outA > 1e-4) {
        rgba[idx] = clamp(Math.round(accR / (accA || 1)), 0, 255);
        rgba[idx + 1] = clamp(Math.round(accG / (accA || 1)), 0, 255);
        rgba[idx + 2] = clamp(Math.round(accB / (accA || 1)), 0, 255);
        rgba[idx + 3] = clamp(Math.round(outA * 255), 0, 255);
      } else {
        rgba[idx] = 0;
        rgba[idx + 1] = 0;
        rgba[idx + 2] = 0;
        rgba[idx + 3] = 0;
      }
    }
  }
  return encodePng(size, size, rgba);
}

function buildAppIconSvg() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="bgGrad" x1="0.15" y1="0.05" x2="0.85" y2="0.95">
      <stop offset="0%" stop-color="#22222a"/>
      <stop offset="100%" stop-color="#0e0e12"/>
    </linearGradient>
    <radialGradient id="coreGlow" cx="50%" cy="46%" r="42%">
      <stop offset="0%" stop-color="#8b5cf6" stop-opacity="0.42"/>
      <stop offset="55%" stop-color="#6366f1" stop-opacity="0.16"/>
      <stop offset="100%" stop-color="#0e0e12" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="chevGrad" x1="0.5" y1="0.2" x2="0.5" y2="0.8">
      <stop offset="0%" stop-color="#fafafa"/>
      <stop offset="100%" stop-color="#d4d4d8"/>
    </linearGradient>
    <linearGradient id="orbitGrad" x1="0" y1="0.5" x2="1" y2="0.5">
      <stop offset="0%" stop-color="#818cf8" stop-opacity="0.65"/>
      <stop offset="50%" stop-color="#a5b4fc" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="#c4b5fd" stop-opacity="0.85"/>
    </linearGradient>
  </defs>
  <rect x="76" y="76" width="872" height="872" rx="200" fill="url(#bgGrad)" stroke="#ffffff" stroke-opacity="0.16" stroke-width="6"/>
  <rect x="76" y="76" width="872" height="872" rx="200" fill="url(#coreGlow)"/>
  <ellipse cx="512" cy="574" rx="318" ry="118" transform="rotate(-19.5 512 574)" fill="none" stroke="url(#orbitGrad)" stroke-width="24"/>
  <polygon points="512,215 778,788 655,788 512,460 369,788 246,788" fill="url(#chevGrad)"/>
  <polygon points="512,542 614,716 553,686 512,788 471,686 410,716" fill="#8b5cf6" fill-opacity="0.92"/>
  <circle cx="788" cy="460" r="34" fill="#f4f4f8"/>
</svg>
`;
}

function buildTrayTemplateSvg() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22" width="22" height="22">
  <polygon points="11,2.8 18.5,18.7 15,18.7 11,9.5 7,18.7 3.5,18.7" fill="#000000"/>
  <polygon points="8.1,14.7 13.9,14.7 14.7,16.9 7.3,16.9" fill="#000000"/>
  <circle cx="17.6" cy="5.5" r="1.9" fill="#000000"/>
</svg>
`;
}

function generateAllIcons(options = {}) {
  const outDir = path.resolve(options.outDir || DEFAULT_ICON_DIR);
  fs.mkdirSync(outDir, { recursive: true });

  const appSizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
  const pngBySize = new Map();
  const writtenFiles = [];

  for (const size of appSizes) {
    const ss = size >= 512 ? 2 : 4;
    const png = rasterizeIcon(size, sampleAppIcon, ss);
    pngBySize.set(size, png);
    if (size !== 24 && size !== 48) {
      const p = path.join(outDir, `icon-${size}.png`);
      fs.writeFileSync(p, png);
      writtenFiles.push(p);
    }
  }

  const tray18 = rasterizeIcon(18, sampleTrayTemplateIcon, 6);
  const tray36 = rasterizeIcon(36, sampleTrayTemplateIcon, 4);
  const tray16 = rasterizeIcon(16, sampleTrayTemplateIcon, 6);
  const tray24 = rasterizeIcon(24, sampleTrayTemplateIcon, 4);
  const tray32 = rasterizeIcon(32, sampleTrayTemplateIcon, 4);

  const tray18Path = path.join(outDir, 'tray-template-18.png');
  const tray36Path = path.join(outDir, 'tray-template-36.png');
  fs.writeFileSync(tray18Path, tray18);
  fs.writeFileSync(tray36Path, tray36);
  writtenFiles.push(tray18Path, tray36Path);

  const icoBuf = encodeIco([
    { size: 16, png: pngBySize.get(16) },
    { size: 24, png: pngBySize.get(24) },
    { size: 32, png: pngBySize.get(32) },
    { size: 48, png: pngBySize.get(48) },
    { size: 64, png: pngBySize.get(64) },
    { size: 128, png: pngBySize.get(128) },
    { size: 256, png: pngBySize.get(256) }
  ]);
  const icoPath = path.join(outDir, 'agy-daddy-launcher.ico');
  fs.writeFileSync(icoPath, icoBuf);
  writtenFiles.push(icoPath);

  const trayIcoBuf = encodeIco([
    { size: 16, png: tray16 },
    { size: 24, png: tray24 },
    { size: 32, png: tray32 }
  ]);
  const trayIcoPath = path.join(outDir, 'tray-icon.ico');
  fs.writeFileSync(trayIcoPath, trayIcoBuf);
  writtenFiles.push(trayIcoPath);

  const icnsBuf = encodeIcns([
    { type: 'icp4', png: pngBySize.get(16) },
    { type: 'icp5', png: pngBySize.get(32) },
    { type: 'icp6', png: pngBySize.get(64) },
    { type: 'ic07', png: pngBySize.get(128) },
    { type: 'ic08', png: pngBySize.get(256) },
    { type: 'ic09', png: pngBySize.get(512) },
    { type: 'ic10', png: pngBySize.get(1024) },
    { type: 'ic11', png: pngBySize.get(32) },
    { type: 'ic12', png: pngBySize.get(64) },
    { type: 'ic13', png: pngBySize.get(256) },
    { type: 'ic14', png: pngBySize.get(512) }
  ]);
  const icnsPath = path.join(outDir, 'AgyDaddyLauncher.icns');
  fs.writeFileSync(icnsPath, icnsBuf);
  writtenFiles.push(icnsPath);

  const svgPath = path.join(outDir, 'agy-daddy-launcher.svg');
  fs.writeFileSync(svgPath, buildAppIconSvg(), 'utf8');
  writtenFiles.push(svgPath);

  const traySvgPath = path.join(outDir, 'tray-icon-template.svg');
  fs.writeFileSync(traySvgPath, buildTrayTemplateSvg(), 'utf8');
  writtenFiles.push(traySvgPath);

  return {
    ok: true,
    outDir,
    files: writtenFiles
  };
}

if (require.main === module) {
  const res = generateAllIcons();
  console.log(`Generated ${res.files.length} icon assets in ${res.outDir}`);
}

module.exports = {
  DEFAULT_ICON_DIR,
  encodePng,
  encodeIco,
  encodeIcns,
  generateAllIcons
};
