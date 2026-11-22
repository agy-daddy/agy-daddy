'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/**
 * 零依赖 ustar tar.gz 解包器（用于 npm tarball 安装，无第三方运行时依赖）
 */
function parseTarBuffer(buf) {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    // 连续全零块表示归档结束
    let isZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) {
        isZero = false;
        break;
      }
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
    const padded = Math.ceil(size / 512) * 512;
    offset += padded;

    if (typeFlag === 'g' || typeFlag === 'x') continue; // 跳过 PAX 扩展头
    entries.push({ name: fullName, type: typeFlag, data });
  }
  return entries;
}

function extractTarGzToDir(tgzBuffer, destDir, options = {}) {
  const strip = Number.isInteger(options.strip) ? options.strip : 1;
  const gunzipped = zlib.gunzipSync(tgzBuffer);
  const entries = parseTarBuffer(gunzipped);
  const resolvedDest = path.resolve(destDir);
  fs.mkdirSync(resolvedDest, { recursive: true });

  let extracted = 0;
  for (const ent of entries) {
    const cleanParts = ent.name.split('/').filter((p) => p && p !== '.');
    if (cleanParts.some((p) => p === '..')) {
      throw new Error(`Unsafe path traversal in tarball entry: ${ent.name}`);
    }
    const stripped = strip > 0 ? cleanParts.slice(strip) : cleanParts;
    if (!stripped.length) continue;

    const target = path.resolve(resolvedDest, ...stripped);
    if (!target.startsWith(resolvedDest + path.sep) && target !== resolvedDest) {
      throw new Error(`Tarball entry escaped destination: ${ent.name}`);
    }
    if (ent.type === '5') {
      fs.mkdirSync(target, { recursive: true });
    } else if (ent.type === '0' || ent.type === '\0') {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, ent.data);
      extracted++;
    }
  }
  return { ok: true, extracted };
}

function createTarGzBuffer(fileMap, rootPrefix = 'package') {
  const blocks = [];
  for (const [relPath, content] of Object.entries(fileMap)) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const name = `${rootPrefix}/${relPath}`;
    const header = Buffer.alloc(512, 0);
    header.write(name.slice(0, 100), 0, 'utf8');
    header.write('0000644\0', 100, 'utf8');
    header.write('0000000\0', 108, 'utf8');
    header.write('0000000\0', 116, 'utf8');
    header.write(buf.length.toString(8).padStart(11, '0') + '\0', 124, 'utf8');
    header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 'utf8');
    header.fill(' ', 148, 156);
    header.write('0', 156, 'utf8');
    header.write('ustar\0', 257, 'utf8');
    header.write('00', 263, 'utf8');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8');
    blocks.push(header, buf);
    const rem = buf.length % 512;
    if (rem !== 0) blocks.push(Buffer.alloc(512 - rem, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(blocks));
}

module.exports = {
  parseTarBuffer,
  extractTarGzToDir,
  createTarGzBuffer
};
