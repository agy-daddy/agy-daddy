'use strict';

const net = require('net');

function ipv6ToBuffer(ip) {
  const clean = String(ip).split('%')[0];
  const halves = clean.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (part) => {
    if (!part) return [];
    const tokens = part.split(':');
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.includes('.')) {
        const ipv4Parts = t.split('.').map(Number);
        if (ipv4Parts.length !== 4 || ipv4Parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        out.push((ipv4Parts[0] << 8) | ipv4Parts[1], (ipv4Parts[2] << 8) | ipv4Parts[3]);
      } else {
        const val = parseInt(t, 16);
        if (!Number.isInteger(val) || val < 0 || val > 0xffff) return null;
        out.push(val);
      }
    }
    return out;
  };

  const left = parseGroups(halves[0]);
  if (!left) return null;
  let groups;
  if (halves.length === 1) {
    groups = left;
  } else {
    const right = parseGroups(halves[1]);
    if (!right) return null;
    const missing = 8 - (left.length + right.length);
    if (missing < 0) return null;
    groups = [...left, ...new Array(missing).fill(0), ...right];
  }
  if (groups.length !== 8) return null;
  const buf = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    buf.writeUInt16BE(groups[i], i * 2);
  }
  return buf;
}

function buildSocks5ConnectPacket(targetHost, targetPort) {
  const host = String(targetHost || '').trim().replace(/^\[|\]$/g, '');
  const port = Number(targetPort);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid SOCKS5 target ${targetHost}:${targetPort}`);
  }

  let addrBuf;
  let atyp;
  if (net.isIPv4(host)) {
    atyp = 0x01;
    addrBuf = Buffer.from(host.split('.').map(Number));
  } else if (net.isIPv6(host)) {
    const parsed = ipv6ToBuffer(host);
    if (!parsed) throw new Error(`Invalid IPv6 address: ${host}`);
    atyp = 0x04;
    addrBuf = parsed;
  } else {
    const domainBuf = Buffer.from(host, 'utf8');
    if (domainBuf.length > 255) throw new Error(`SOCKS5 domain name too long: ${host}`);
    atyp = 0x03;
    addrBuf = Buffer.concat([Buffer.from([domainBuf.length]), domainBuf]);
  }

  const header = Buffer.from([0x05, 0x01, 0x00, atyp]);
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port, 0);
  return Buffer.concat([header, addrBuf, portBuf]);
}

function connectViaSocks5(options = {}) {
  const {
    proxyHost,
    proxyPort,
    username = '',
    password = '',
    targetHost,
    targetPort,
    timeoutMs = 8000
  } = options;

  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxyHost, port: Number(proxyPort) });
    let stage = 'greeting';
    let buf = Buffer.alloc(0);
    let settled = false;

    const cleanupListeners = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      clearTimeout(timer);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      try { socket.destroy(); } catch {}
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const timer = setTimeout(() => {
      fail(new Error(`SOCKS5 handshake timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    const onError = (err) => fail(err);
    const onClose = () => fail(new Error('SOCKS5 socket closed before handshake completed'));

    const sendConnect = () => {
      try {
        const pkt = buildSocks5ConnectPacket(targetHost, targetPort);
        stage = 'connect';
        socket.write(pkt);
      } catch (err) {
        fail(err);
      }
    };

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (!settled) {
        if (stage === 'greeting') {
          if (buf.length < 2) return;
          const ver = buf[0];
          const method = buf[1];
          buf = buf.subarray(2);
          if (ver !== 0x05) {
            return fail(new Error(`Invalid SOCKS5 version: ${ver}`));
          }
          if (method === 0xff) {
            return fail(new Error('SOCKS5 upstream rejected auth methods'));
          }
          if (method === 0x02) {
            const uBuf = Buffer.from(String(username), 'utf8');
            const pBuf = Buffer.from(String(password), 'utf8');
            if (uBuf.length > 255 || pBuf.length > 255) {
              return fail(new Error('SOCKS5 credentials exceed 255 bytes'));
            }
            stage = 'auth';
            socket.write(Buffer.concat([Buffer.from([0x01, uBuf.length]), uBuf, Buffer.from([pBuf.length]), pBuf]));
            continue;
          }
          if (method === 0x00) {
            sendConnect();
            continue;
          }
          return fail(new Error(`Unsupported SOCKS5 auth method: ${method}`));
        }

        if (stage === 'auth') {
          if (buf.length < 2) return;
          const authVer = buf[0];
          const status = buf[1];
          buf = buf.subarray(2);
          if (authVer !== 0x01 || status !== 0x00) {
            return fail(new Error(`SOCKS5 authentication failed (status=${status})`));
          }
          sendConnect();
          continue;
        }

        if (stage === 'connect') {
          if (buf.length < 4) return;
          const ver = buf[0];
          const rep = buf[1];
          const atyp = buf[3];
          let needLen;
          if (atyp === 0x01) {
            needLen = 10;
          } else if (atyp === 0x03) {
            if (buf.length < 5) return;
            needLen = 5 + buf[4] + 2;
          } else if (atyp === 0x04) {
            needLen = 22;
          } else {
            return fail(new Error(`Unsupported SOCKS5 reply ATYP: ${atyp}`));
          }
          if (buf.length < needLen) return;
          const trailing = buf.subarray(needLen);
          if (ver !== 0x05) {
            return fail(new Error(`Invalid SOCKS5 connect reply version: ${ver}`));
          }
          if (rep !== 0x00) {
            return fail(new Error(`SOCKS5 CONNECT failed (REP=0x${rep.toString(16)})`));
          }

          settled = true;
          cleanupListeners();
          if (trailing.length > 0) {
            socket.unshift(trailing);
          }
          resolve(socket);
          return;
        }
      }
    };

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.once('connect', () => {
      if (username || password) {
        socket.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
      } else {
        socket.write(Buffer.from([0x05, 0x01, 0x00]));
      }
    });
  });
}

module.exports = {
  ipv6ToBuffer,
  buildSocks5ConnectPacket,
  connectViaSocks5
};
