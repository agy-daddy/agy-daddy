'use strict';

// 零依赖纯 JS Byte 模式 QR Code 矩阵与 SVG / ASCII 生成器（支持 Version 1~10, ECC Level L）

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    const root = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data, ecCount) {
  const gen = rsGeneratorPoly(ecCount);
  const res = new Array(data.length + ecCount).fill(0);
  for (let i = 0; i < data.length; i++) res[i] = data[i];
  for (let i = 0; i < data.length; i++) {
    const coef = res[i];
    if (coef === 0) continue;
    for (let j = 0; j < gen.length; j++) {
      res[i + j] ^= gfMul(gen[j], coef);
    }
  }
  return res.slice(data.length);
}

// Version 1..10 (ECC Level L): [version, size, totalDataCodewords, ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data, alignCoords]
const VERSION_SPECS = [
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

function selectVersion(byteLen) {
  for (const spec of VERSION_SPECS) {
    const headerBits = 4 + (spec[0] >= 10 ? 16 : 8);
    const availBits = spec[2] * 8;
    if (headerBits + byteLen * 8 <= availBits) return spec;
  }
  throw new Error(`QR payload too long (${byteLen} bytes > max 271 bytes)`);
}

function encodeDataCodewords(bytes, spec) {
  const [ver, , totalData] = spec;
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  pushBits(0b0100, 4); // Byte mode
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

function interleaveCodewords(data, spec) {
  const [, , , ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data] = spec;
  const blocks = [];
  let offset = 0;
  for (let i = 0; i < g1Blocks; i++) {
    const d = data.slice(offset, offset + g1Data);
    offset += g1Data;
    blocks.push({ d, ec: rsRemainder(d, ecPerBlock) });
  }
  for (let i = 0; i < g2Blocks; i++) {
    const d = data.slice(offset, offset + g2Data);
    offset += g2Data;
    blocks.push({ d, ec: rsRemainder(d, ecPerBlock) });
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

function bchFormatInfo(maskId) {
  // ECC L = 01 (bits 0..1 of 5-bit data)
  const data = (0b01 << 3) | maskId;
  let d = data << 10;
  const poly = 0b10100110111;
  for (let i = 14; i >= 10; i--) {
    if ((d >>> i) & 1) d ^= poly << (i - 10);
  }
  return ((data << 10) | d) ^ 0b101010000010010;
}

function bchVersionInfo(ver) {
  if (ver < 7) return 0;
  let d = ver << 12;
  const poly = 0b1111100100101;
  for (let i = 17; i >= 12; i--) {
    if ((d >>> i) & 1) d ^= poly << (i - 12);
  }
  return (ver << 12) | d;
}

function placeMatrix(spec, codewords) {
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
        const val = dist !== 2 && dist !== 4;
        setFixed(cx + dx, cy + dy, val);
      }
    }
  };
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    const val = i % 2 === 0;
    setFixed(i, 6, val);
    setFixed(6, i, val);
  }

  // Alignment patterns
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

  // Dark module
  setFixed(8, size - 8, 1);

  // Reserve format info areas
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

  // Version info (>= 7)
  if (ver >= 7) {
    const vBits = bchVersionInfo(ver);
    for (let i = 0; i < 18; i++) {
      const bit = (vBits >>> i) & 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFixed(a, b, bit);
      setFixed(b, a, bit);
    }
  }

  // Place interleaved bits using Mask 0 ((x + y) % 2 === 0) directly and cleanly
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

  // Write Format Info
  const fmt = bchFormatInfo(maskId);
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

function generateQrMatrix(text) {
  const bytes = Array.from(Buffer.from(String(text || ''), 'utf8'));
  const spec = selectVersion(bytes.length);
  const data = encodeDataCodewords(bytes, spec);
  const interleaved = interleaveCodewords(data, spec);
  return placeMatrix(spec, interleaved);
}

function generateQrSvg(text, options = {}) {
  const { size, modules } = generateQrMatrix(text);
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

function generateQrAscii(text) {
  const { size, modules } = generateQrMatrix(text);
  const rows = [];
  for (let y = 0; y < size; y++) {
    let line = '';
    for (let x = 0; x < size; x++) line += modules[y][x] ? '██' : '  ';
    rows.push(line);
  }
  return rows.join('\n');
}

module.exports = {
  generateQrMatrix,
  generateQrSvg,
  generateQrAscii
};
