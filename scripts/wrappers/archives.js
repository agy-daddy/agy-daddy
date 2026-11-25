'use strict';

const { crc32, deflateRawSync, gzipSync } = require('node:zlib');

// The wrappers contain only small regular files. Writing these two archive
// formats lets builders preserve Unix executable bits even on Windows.
function zip(entries) {
  const files = [];
  const directory = [];
  let offset = 0;
  let directorySize = 0;

  for (const { name, data, mode } of entries) {
    const filename = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // ZIP 2.0 is required for Deflate.
    header.writeUInt16LE(0x0800, 6); // UTF-8 filenames.
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0x0021, 12); // DOS date 1980-01-01.
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    files.push(header, filename, compressed);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(0x0314, 4); // Unix file attributes.
    header.copy(record, 6, 4);
    record.writeUInt32LE((0o100000 | mode) * 0x10000, 38);
    record.writeUInt32LE(offset, 42);
    directory.push(record, filename);
    offset += header.length + filename.length + compressed.length;
    directorySize += record.length + filename.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, ...directory, end]);
}

function tarGz(entries) {
  const blocks = [];
  for (const { name, data, mode } of entries) {
    const header = Buffer.alloc(512);
    if (Buffer.byteLength(name) >= 100) throw new Error(`Tar filename is too long: ${name}`);
    header.write(name, 0);
    header.write(mode.toString(8).padStart(7, '0'), 100);
    header.write('0000000', 108); // uid
    header.write('0000000', 116); // gid
    header.write(data.length.toString(8).padStart(11, '0'), 124);
    header.write('00000000000', 136); // mtime
    header.fill(0x20, 148, 156); // Treat the checksum field as spaces while summing.
    header.write('0', 156); // Regular file.
    header.write('ustar\0' + '00', 257);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]), { level: 9 });
}

module.exports = { zip, tarGz };
