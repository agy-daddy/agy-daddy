'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const {
  importThemePack,
  listCustomThemes,
  deleteCustomTheme
} = require('../src/theme-pack-sandbox');

function createTinyPngBuffer(width = 64, height = 64) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrLen = Buffer.from([0, 0, 0, 13]);
  const ihdrTag = Buffer.from('IHDR', 'ascii');
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 6;
  return Buffer.concat([sig, ihdrLen, ihdrTag, ihdrData, Buffer.alloc(4)]);
}

function buildTar(entries) {
  const blocks = [];
  for (const ent of entries) {
    const buf = Buffer.isBuffer(ent.data) ? ent.data : Buffer.from(String(ent.data || ''), 'utf8');
    const header = Buffer.alloc(512, 0);
    header.write(ent.name.slice(0, 100), 0, 'utf8');
    header.write('0000644\0', 100, 'utf8');
    header.write('0000000\0', 108, 'utf8');
    header.write('0000000\0', 116, 'utf8');
    header.write(buf.length.toString(8).padStart(11, '0') + '\0', 124, 'utf8');
    header.write('00000000000\0', 136, 'utf8');
    header.fill(' ', 148, 156);
    header.write(ent.type || '0', 156, 'utf8');
    header.write('ustar\0', 257, 'utf8');
    header.write('00', 263, 'utf8');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8');
    blocks.push(header);
    if (buf.length > 0) {
      blocks.push(buf);
      const rem = buf.length % 512;
      if (rem !== 0) blocks.push(Buffer.alloc(512 - rem, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

test('六层导入安全沙箱拦截可执行脚本、路径穿越、symlink、脚本 SVG 与伪造超尺寸图片', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-pet-sandbox-'));
  const customDir = path.join(tmpDir, 'custom-themes');
  try {
    // 1. 拒绝含 .js 文件的 .agypet 归档
    const jsArchive = buildTar([
      { name: 'pet-theme.json', data: JSON.stringify({ id: 'bad', layers: [{ id: 'c', kind: 'circle', cx: 80, cy: 80, r: 20 }] }) },
      { name: 'evil.js', data: 'process.exit(1)' }
    ]);
    assert.throws(
      () => importThemePack({ customThemesDir: customDir, archiveBase64: jsArchive.toString('base64'), fileName: 'bad.agypet' }),
      /UNSAFE_PACK_FILE_TYPE/
    );

    // 2. 拒绝路径穿越 ../
    const travArchive = buildTar([
      { name: '../../evil.json', data: '{}' }
    ]);
    assert.throws(
      () => importThemePack({ customThemesDir: customDir, archiveBase64: travArchive.toString('base64'), fileName: 'trav.agypet' }),
      /UNSAFE_PACK_PATH/
    );

    // 3. 拒绝 symlink
    const symArchive = buildTar([
      { name: 'sprites/link.png', type: '2', data: '' }
    ]);
    assert.throws(
      () => importThemePack({ customThemesDir: customDir, archiveBase64: symArchive.toString('base64'), fileName: 'sym.agypet' }),
      /UNSAFE_PACK_LINK/
    );

    // 4. 拒绝含 <script> 或事件处理器的 SVG
    assert.throws(
      () => importThemePack({ customThemesDir: customDir, svgText: '<svg><script>alert(1)</script><path d="M0 0 L10 10"/></svg>', fileName: 'xss.svg' }),
      /UNSAFE_SVG_CONTENT/
    );
    assert.throws(
      () => importThemePack({ customThemesDir: customDir, svgText: '<svg><path onload="alert(1)" d="M0 0 L10 10"/></svg>', fileName: 'evt.svg' }),
      /UNSAFE_SVG_CONTENT/
    );

    // 5. 拒绝伪造魔数 PNG 与超过 512x512 图片
    const fakePngArchive = buildTar([
      { name: 'pet-theme.json', data: JSON.stringify({ id: 'fake', layers: [{ id: 's', kind: 'sprite', spritePath: 'sprites/idle.png' }] }) },
      { name: 'sprites/idle.png', data: Buffer.from('fake-png-header') }
    ]);
    assert.throws(
      () => importThemePack({ customThemesDir: customDir, archiveBase64: fakePngArchive.toString('base64'), fileName: 'fake.agypet' }),
      /UNSAFE_SPRITE_FORMAT/
    );

    const bigPngArchive = buildTar([
      { name: 'pet-theme.json', data: JSON.stringify({ id: 'big', layers: [{ id: 's', kind: 'sprite', spritePath: 'sprites/idle.png' }] }) },
      { name: 'sprites/idle.png', data: createTinyPngBuffer(700, 700) }
    ]);
    assert.throws(
      () => importThemePack({ customThemesDir: customDir, archiveBase64: bigPngArchive.toString('base64'), fileName: 'big.agypet' }),
      /UNSAFE_SPRITE_DIMENSIONS/
    );

    // 6. 合法 .agypet（gzip 压缩含有效 PNG 与 manifest）+ 单 SVG + JSON 均正常导入与删除
    const validTar = buildTar([
      {
        name: 'pet-theme.json',
        data: JSON.stringify({
          id: 'my-pixel-fox',
          name: '像素小狐狸',
          accentHex: '#a78bfa',
          viewBox: { width: 128, height: 128 },
          layers: [{ id: 'idle', kind: 'sprite', spritePath: 'sprites/idle.png', x: 0, y: 0, width: 128, height: 128 }]
        })
      },
      { name: 'sprites/idle.png', data: createTinyPngBuffer(128, 128) }
    ]);
    const gzipped = zlib.gzipSync(validTar);
    const imported = importThemePack({
      customThemesDir: customDir,
      archiveBase64: gzipped.toString('base64'),
      fileName: 'my-pixel-fox.agypet'
    });
    assert.equal(imported.id, 'custom:my-pixel-fox');
    assert.equal(imported.builtin, false);
    assert.ok(fs.existsSync(imported.scene.layers[0].spritePath));

    const svgImported = importThemePack({
      customThemesDir: customDir,
      svgText: '<svg viewBox="0 0 100 100"><path d="M10 10 L90 10 L50 90 Z" fill="#a78bfa"/></svg>',
      fileName: 'clean-triangle.svg'
    });
    assert.equal(svgImported.id, 'custom:clean-triangle');
    assert.equal(listCustomThemes(customDir).length, 2);

    const delRes = deleteCustomTheme(customDir, 'custom:my-pixel-fox');
    assert.equal(delRes.ok, true);
    assert.equal(listCustomThemes(customDir).length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
