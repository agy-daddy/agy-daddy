'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const {
  LOOPBACK_HOST,
  TOKEN_HEADER,
  TOKEN_HEADER_CANONICAL,
  DEFAULT_GATEWAY_PORT,
  TICKET_TTL_MS,
  TICKET_HARD_TTL_MS,
  MAX_ACTIVE_TICKETS,
  ERROR_CODES,
  classifyExtension,
  isTrustedOrigin,
  safeErrorPayload
} = require('./constants');
const { validatePathAccess } = require('./path-guard');
const { readSvgPayload } = require('./svg-sanitizer');
const { computeFileFingerprint } = require('./markers-store');

function isTestMode() {
  return (
    process.env.AGY_DADDY_TEST_MODE === '1'
    || process.env.NODE_ENV === 'test'
    || Boolean(process.env.NODE_TEST_CONTEXT)
  );
}

function redactGatewayUrl(rawUrl) {
  return String(rawUrl || '').replace(/([?&]t=)[^&]+/gi, '$1[REDACTED]');
}

function timingSafeEqualTokens(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function extractRefererOrigin(rawReferer) {
  if (typeof rawReferer !== 'string' || !rawReferer.trim()) return '';
  try {
    const u = new URL(rawReferer.trim());
    if (u.protocol === 'vscode-file:' || u.protocol === 'vscode-webview:') {
      return `${u.protocol}//${u.host}`;
    }
    return u.origin === 'null' ? '' : u.origin;
  } catch {
    return 'INVALID';
  }
}

/**
 * Parses single-range RFC 9110 byte ranges using Number.isSafeInteger (up to 8 PB).
 * Rejects multi-range syntax and invalid bounds.
 */
function parseHttpByteRange(rangeHeader, fileSize) {
  if (typeof rangeHeader !== 'string' || !rangeHeader.trim()) {
    return { present: false };
  }
  const size = Number(fileSize);
  if (!Number.isSafeInteger(size) || size <= 0) {
    return { present: true, satisfiable: false };
  }
  const match = rangeHeader.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    return { present: true, satisfiable: false };
  }

  const startStr = match[1];
  const endStr = match[2];
  if (!startStr && !endStr) {
    return { present: true, satisfiable: false };
  }

  let start;
  let end;

  if (startStr && endStr) {
    start = Number.parseInt(startStr, 10);
    end = Number.parseInt(endStr, 10);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || start > end) {
      return { present: true, satisfiable: false };
    }
    if (end >= size) end = size - 1;
  } else if (startStr && !endStr) {
    start = Number.parseInt(startStr, 10);
    if (!Number.isSafeInteger(start) || start < 0 || start >= size) {
      return { present: true, satisfiable: false };
    }
    end = size - 1;
  } else {
    const suffix = Number.parseInt(endStr, 10);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      return { present: true, satisfiable: false };
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  }

  return {
    present: true,
    satisfiable: true,
    start,
    end,
    length: end - start + 1
  };
}

function buildSecurityHeaders(validatedOrigin = '') {
  const headers = {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; sandbox; frame-ancestors 'none'",
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': `Range, If-Range, ${TOKEN_HEADER_CANONICAL}`,
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Range, Content-Length, Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
    'Vary': 'Origin'
  };
  if (validatedOrigin) {
    headers['Access-Control-Allow-Origin'] = validatedOrigin;
  }
  return headers;
}

function createGatewayServer(options = {}) {
  const bindHost = options.bindHost !== undefined ? options.bindHost : LOOPBACK_HOST;
  if (bindHost !== LOOPBACK_HOST) {
    const err = new Error(`FATAL_INVALID_BIND_HOST: gateway must bind strictly to ${LOOPBACK_HOST}`);
    err.code = 'FATAL_INVALID_BIND_HOST';
    throw err;
  }

  const resolveAllowedRoots = options.resolveAllowedRoots;
  const csvEngine = options.csvEngine;
  const onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : null;

  const tickets = new Map();
  let server = null;
  let actualPort = 0;
  let running = false;
  let portMode = 'auto';
  let requestedPort = 0;
  let portFallback = false;
  let fallbackReason = null;
  let updatedAt = new Date().toISOString();

  function getPublicStatus() {
    let activeCount = 0;
    const now = Date.now();
    for (const t of tickets.values()) {
      if (!t.revoked && now <= t.expiresAt && now <= t.hardExpiresAt) activeCount++;
    }
    return {
      ok: true,
      running,
      host: LOOPBACK_HOST,
      port: actualPort,
      portMode,
      requestedPort,
      portFallback,
      ...(fallbackReason ? { fallbackReason } : {}),
      activeTickets: activeCount,
      indexedCsvCount: csvEngine?.getIndexedCount?.() ?? 0,
      updatedAt
    };
  }

  function notifyState() {
    updatedAt = new Date().toISOString();
    if (onStateChange) {
      try { onStateChange(getPublicStatus()); } catch {}
    }
  }

  function evictTicketsIfNeeded() {
    const now = Date.now();
    for (const [id, rec] of tickets.entries()) {
      if (rec.revoked || now > rec.expiresAt || now > rec.hardExpiresAt) {
        tickets.delete(id);
      }
    }
    while (tickets.size >= MAX_ACTIVE_TICKETS) {
      let oldestId = null;
      let oldestSeen = Infinity;
      for (const [id, rec] of tickets.entries()) {
        const seen = rec.lastUsedAt || rec.createdAt;
        if (seen < oldestSeen) {
          oldestSeen = seen;
          oldestId = id;
        }
      }
      if (!oldestId) break;
      tickets.delete(oldestId);
    }
  }

  async function issueTicket({ filePath, purpose, clientOrigin = '', host = null, settings = {} } = {}) {
    if (!running || !actualPort) {
      return { ok: false, statusCode: 503, ...safeErrorPayload(ERROR_CODES.GATEWAY_DISABLED) };
    }
    if (!['media', 'csv', 'svg', 'font'].includes(purpose)) {
      return { ok: false, statusCode: 400, ...safeErrorPayload(ERROR_CODES.INVALID_ARGUMENT, 'purpose 必须是 media/csv/svg/font') };
    }

    let resolvedOrigin = String(clientOrigin || '').trim();
    if (!resolvedOrigin && host?.rpc && typeof host.rpc.getOrigin === 'function') {
      try {
        resolvedOrigin = String(await host.rpc.getOrigin() || '').trim();
      } catch {}
    }

    const allowEmptyInTest = isTestMode() && resolvedOrigin === '';
    if (!isTrustedOrigin(resolvedOrigin, allowEmptyInTest)) {
      return { ok: false, statusCode: 403, ...safeErrorPayload(ERROR_CODES.FORBIDDEN_ORIGIN) };
    }

    const allowedRealRoots = typeof resolveAllowedRoots === 'function'
      ? await resolveAllowedRoots({ settings, host })
      : [];

    const pathCheck = validatePathAccess(filePath, {
      allowedRealRoots,
      mustExist: true,
      requireRegularFile: true
    });
    if (!pathCheck.ok) {
      return pathCheck;
    }

    const pathMod = require('node:path');
    const name = pathMod.basename(pathCheck.realPath);
    const ext = pathMod.extname(pathCheck.realPath).toLowerCase();
    const { category, mimeType } = classifyExtension(ext);
    if (category !== purpose) {
      return { ok: false, statusCode: 400, ...safeErrorPayload(ERROR_CODES.UNSUPPORTED_FORMAT) };
    }

    evictTicketsIfNeeded();
    const now = Date.now();
    const ticketId = crypto.randomBytes(16).toString('base64url');
    const secret = crypto.randomBytes(32).toString('base64url');

    const record = {
      ticketId,
      secret,
      realPath: pathCheck.realPath,
      fileSize: pathCheck.stat.size,
      mtimeMs: pathCheck.stat.mtimeMs,
      mimeType,
      purpose,
      boundOrigin: resolvedOrigin,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: now + TICKET_TTL_MS,
      hardExpiresAt: now + TICKET_HARD_TTL_MS,
      revoked: false
    };
    tickets.set(ticketId, record);
    notifyState();

    const baseUrl = `http://${LOOPBACK_HOST}:${actualPort}`;
    const streamUrl = (purpose === 'media' || purpose === 'font')
      ? `${baseUrl}/v1/stream/${ticketId}?t=${encodeURIComponent(secret)}`
      : `${baseUrl}/v1/${purpose}/${ticketId}`;

    return {
      ok: true,
      ticketId,
      token: secret,
      baseUrl,
      streamUrl,
      fileMeta: {
        name,
        ext,
        size: pathCheck.stat.size,
        mtimeMs: pathCheck.stat.mtimeMs,
        mimeType,
        fingerprint: computeFileFingerprint(pathCheck.realPath, pathCheck.stat.size, pathCheck.stat.mtimeMs)
      }
    };
  }

  function revokeTicket({ ticketId, all = false } = {}) {
    let revokedCount = 0;
    if (all) {
      for (const rec of tickets.values()) {
        if (!rec.revoked) {
          rec.revoked = true;
          revokedCount++;
        }
      }
      tickets.clear();
      csvEngine?.invalidate?.();
      notifyState();
      return { ok: true, revokedCount };
    }

    if (typeof ticketId === 'string' && tickets.has(ticketId)) {
      const rec = tickets.get(ticketId);
      if (rec && !rec.revoked) {
        rec.revoked = true;
        revokedCount = 1;
      }
      tickets.delete(ticketId);
      notifyState();
    }
    return { ok: true, revokedCount };
  }

  function sendJson(res, statusCode, payload, validatedOrigin = '', extraHeaders = {}) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
      ...buildSecurityHeaders(validatedOrigin),
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body, 'utf8'),
      ...extraHeaders
    });
    res.end(body);
  }

  async function handleHttpRequest(req, res, runtimeCtx = {}) {
    // Gate A: Loopback socket check
    const remoteAddr = req.socket?.remoteAddress;
    if (remoteAddr !== LOOPBACK_HOST) {
      return sendJson(res, 403, safeErrorPayload(ERROR_CODES.NON_LOOPBACK_SOCKET));
    }

    // Gate B: Read-only HTTP method allowlist
    const method = String(req.method || '').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      return sendJson(res, 405, safeErrorPayload(ERROR_CODES.METHOD_NOT_ALLOWED), '', {
        Allow: 'GET, HEAD, OPTIONS'
      });
    }

    // Gate C: Strict Host header match
    const expectedHost = `${LOOPBACK_HOST}:${actualPort}`;
    if (String(req.headers.host || '') !== expectedHost) {
      return sendJson(res, 403, safeErrorPayload(ERROR_CODES.INVALID_HOST_HEADER));
    }

    // Gate D: Origin / Sec-Fetch-Site / Referer anti-CSRF check
    const hasOriginHeader = Object.prototype.hasOwnProperty.call(req.headers, 'origin');
    const rawOrigin = hasOriginHeader ? String(req.headers.origin || '').trim() : '';
    let validatedOrigin = '';

    if (hasOriginHeader) {
      if (!isTrustedOrigin(rawOrigin, false)) {
        return sendJson(res, 403, safeErrorPayload(ERROR_CODES.FORBIDDEN_ORIGIN));
      }
      validatedOrigin = rawOrigin;
    } else {
      const secFetchSite = String(req.headers['sec-fetch-site'] || '').trim().toLowerCase();
      if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
        return sendJson(res, 403, safeErrorPayload(ERROR_CODES.CROSS_SITE_NO_CORS_BLOCKED));
      }
      if (req.headers.referer) {
        const refOrigin = extractRefererOrigin(req.headers.referer);
        if (refOrigin === 'INVALID' || !isTrustedOrigin(refOrigin, false)) {
          return sendJson(res, 403, safeErrorPayload(ERROR_CODES.FORBIDDEN_REFERER));
        }
      }
    }

    if (method === 'OPTIONS') {
      res.writeHead(204, buildSecurityHeaders(validatedOrigin));
      res.end();
      return;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(req.url || '/', `http://${expectedHost}`);
    } catch {
      return sendJson(res, 400, safeErrorPayload(ERROR_CODES.INVALID_ARGUMENT), validatedOrigin);
    }

    const pathname = parsedUrl.pathname;
    const streamMatch = pathname.match(/^\/v1\/stream\/([A-Za-z0-9_-]+)$/);
    const csvMatch = pathname.match(/^\/v1\/csv\/([A-Za-z0-9_-]+)\/(meta|rows|cell|search)$/);
    const svgMatch = pathname.match(/^\/v1\/svg\/([A-Za-z0-9_-]+)$/);

    if (!streamMatch && !csvMatch && !svgMatch) {
      return sendJson(res, 404, safeErrorPayload(ERROR_CODES.NOT_FOUND), validatedOrigin);
    }

    // Gate E: Capability ticket & constant-time token check
    const ticketId = (streamMatch || csvMatch || svgMatch)[1];
    const ticket = tickets.get(ticketId);
    const now = Date.now();
    if (!ticket || ticket.revoked || now > ticket.expiresAt || now > ticket.hardExpiresAt) {
      if (ticket && (now > ticket.expiresAt || now > ticket.hardExpiresAt)) tickets.delete(ticketId);
      return sendJson(res, 403, safeErrorPayload(ERROR_CODES.INVALID_OR_EXPIRED_TICKET), validatedOrigin);
    }

    if (ticket.boundOrigin && hasOriginHeader && rawOrigin !== ticket.boundOrigin) {
      return sendJson(res, 403, safeErrorPayload(ERROR_CODES.FORBIDDEN_ORIGIN), validatedOrigin);
    }
    if (ticket.boundOrigin && !hasOriginHeader) {
      return sendJson(res, 403, safeErrorPayload(ERROR_CODES.FORBIDDEN_ORIGIN), validatedOrigin);
    }

    const headerToken = typeof req.headers[TOKEN_HEADER] === 'string' ? req.headers[TOKEN_HEADER].trim() : '';
    const queryToken = streamMatch ? String(parsedUrl.searchParams.get('t') || '').trim() : '';
    const presentedToken = headerToken || (streamMatch ? queryToken : '');

    if (!timingSafeEqualTokens(presentedToken, ticket.secret)) {
      return sendJson(res, 403, safeErrorPayload(ERROR_CODES.INVALID_OR_EXPIRED_TICKET), validatedOrigin);
    }

    // Purpose check
    if (streamMatch && ticket.purpose !== 'media' && ticket.purpose !== 'font') {
      return sendJson(res, 403, safeErrorPayload(ERROR_CODES.INVALID_OR_EXPIRED_TICKET), validatedOrigin);
    }
    if (csvMatch && ticket.purpose !== 'csv') {
      return sendJson(res, 403, safeErrorPayload(ERROR_CODES.INVALID_OR_EXPIRED_TICKET), validatedOrigin);
    }
    if (svgMatch && ticket.purpose !== 'svg') {
      return sendJson(res, 403, safeErrorPayload(ERROR_CODES.INVALID_OR_EXPIRED_TICKET), validatedOrigin);
    }

    // Slide TTL
    ticket.lastUsedAt = now;
    ticket.expiresAt = Math.min(ticket.hardExpiresAt, now + TICKET_TTL_MS);

    // TOCTOU re-validation against allowedRealRoots before touching file contents
    const allowedRealRoots = typeof resolveAllowedRoots === 'function'
      ? await resolveAllowedRoots({
          settings: runtimeCtx.getSettings?.() || {},
          host: runtimeCtx.host || null
        })
      : [];

    const recheck = validatePathAccess(ticket.realPath, {
      allowedRealRoots,
      mustExist: true,
      requireRegularFile: true
    });
    if (!recheck.ok) {
      ticket.revoked = true;
      tickets.delete(ticketId);
      notifyState();
      return sendJson(res, recheck.statusCode || 403, {
        ok: false,
        errorCode: recheck.errorCode,
        message: recheck.message
      }, validatedOrigin);
    }

    const stat = recheck.stat;
    const realPath = recheck.realPath;

    if (streamMatch) {
      const fileSize = stat.size;
      const rangeInfo = parseHttpByteRange(req.headers.range, fileSize);
      const secHeaders = buildSecurityHeaders(validatedOrigin);

      if (rangeInfo.present && !rangeInfo.satisfiable) {
        res.writeHead(416, {
          ...secHeaders,
          'Content-Type': ticket.mimeType,
          'Content-Range': `bytes */${fileSize}`,
          'Accept-Ranges': 'bytes'
        });
        res.end();
        return;
      }

      if (rangeInfo.present && rangeInfo.satisfiable) {
        res.writeHead(206, {
          ...secHeaders,
          'Content-Type': ticket.mimeType,
          'Content-Range': `bytes ${rangeInfo.start}-${rangeInfo.end}/${fileSize}`,
          'Content-Length': rangeInfo.length,
          'Accept-Ranges': 'bytes'
        });
        if (method === 'HEAD') {
          res.end();
          return;
        }
        const stream = fs.createReadStream(realPath, {
          start: rangeInfo.start,
          end: rangeInfo.end,
          highWaterMark: 256 * 1024
        });
        req.once('close', () => stream.destroy());
        res.once('error', () => stream.destroy());
        stream.on('error', () => {
          if (!res.headersSent) {
            sendJson(res, 500, { ok: false, errorCode: 'STREAM_READ_ERROR', message: '读取流媒体分片失败' }, validatedOrigin);
          } else {
            res.destroy();
          }
        });
        stream.pipe(res);
        return;
      }

      res.writeHead(200, {
        ...secHeaders,
        'Content-Type': ticket.mimeType,
        'Content-Length': fileSize,
        'Accept-Ranges': 'bytes'
      });
      if (method === 'HEAD') {
        res.end();
        return;
      }
      if (fileSize === 0) {
        res.end();
        return;
      }
      const stream = fs.createReadStream(realPath, { highWaterMark: 256 * 1024 });
      req.once('close', () => stream.destroy());
      res.once('error', () => stream.destroy());
      stream.on('error', () => {
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, errorCode: 'STREAM_READ_ERROR', message: '读取文件流失败' }, validatedOrigin);
        } else {
          res.destroy();
        }
      });
      stream.pipe(res);
      return;
    }

    if (csvMatch) {
      if (!csvEngine) {
        return sendJson(res, 500, { ok: false, errorCode: 'CSV_ENGINE_UNAVAILABLE', message: 'CSV 引擎未初始化' }, validatedOrigin);
      }
      const action = csvMatch[2];
      const queryObj = Object.fromEntries(parsedUrl.searchParams.entries());
      const abortCtrl = new AbortController();
      req.once('close', () => abortCtrl.abort());

      let result;
      if (action === 'meta') {
        result = await csvEngine.getMeta(realPath, stat, queryObj);
      } else if (action === 'rows') {
        result = await csvEngine.getRows(realPath, stat, queryObj);
      } else if (action === 'cell') {
        result = await csvEngine.getCell(realPath, stat, queryObj);
      } else {
        result = await csvEngine.search(realPath, stat, queryObj, abortCtrl.signal);
      }
      const status = result.ok ? 200 : (result.statusCode || 400);
      const { statusCode: _s, ...body } = result;
      return sendJson(res, status, body, validatedOrigin);
    }

    if (svgMatch) {
      const mode = parsedUrl.searchParams.get('mode') || 'sanitized';
      const svgRes = readSvgPayload(realPath, stat, mode);
      const status = svgRes.ok ? 200 : (svgRes.statusCode || 400);
      const { statusCode: _s, ...body } = svgRes;
      return sendJson(res, status, body, validatedOrigin);
    }
  }

  function listenOnPort(srv, port) {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        srv.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        srv.removeListener('error', onError);
        resolve(srv.address());
      };
      srv.once('error', onError);
      srv.once('listening', onListening);
      srv.listen(port, LOOPBACK_HOST);
    });
  }

  async function start(startOptions = {}) {
    if (running && server) {
      return getPublicStatus();
    }

    const mode = startOptions.portMode === 'fixed' ? 'fixed' : 'auto';
    portMode = mode;
    portFallback = false;
    fallbackReason = null;

    let targetPort = 0;
    if (Number.isInteger(startOptions.explicitTestPort)) {
      targetPort = startOptions.explicitTestPort;
    } else if (!isTestMode() && mode === 'fixed') {
      const candidate = Number.parseInt(startOptions.gatewayPort ?? DEFAULT_GATEWAY_PORT, 10);
      targetPort = (Number.isInteger(candidate) && candidate >= 1024 && candidate <= 65535)
        ? candidate
        : DEFAULT_GATEWAY_PORT;
    }
    requestedPort = targetPort;

    const runtimeCtx = {
      getSettings: startOptions.getSettings,
      host: startOptions.host
    };

    const srv = http.createServer((req, res) => {
      void handleHttpRequest(req, res, runtimeCtx).catch(() => {
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, errorCode: 'INTERNAL_ERROR', message: '本地网关内部错误' });
        } else {
          res.destroy();
        }
      });
    });
    srv.keepAliveTimeout = 15_000;
    srv.requestTimeout = 30_000;

    try {
      const addr = await listenOnPort(srv, targetPort);
      actualPort = addr.port;
    } catch (err) {
      if (targetPort !== 0 && (err?.code === 'EADDRINUSE' || err?.code === 'EACCES')) {
        portFallback = true;
        fallbackReason = err.code;
        const addr = await listenOnPort(srv, 0);
        actualPort = addr.port;
      } else {
        try { srv.close(); } catch {}
        throw err;
      }
    }

    server = srv;
    running = true;
    notifyState();
    return getPublicStatus();
  }

  async function stop() {
    tickets.clear();
    csvEngine?.invalidate?.();
    const srv = server;
    server = null;
    running = false;
    actualPort = 0;
    if (srv) {
      await new Promise((resolve) => {
        try { srv.closeAllConnections?.(); } catch {}
        srv.close(() => resolve());
      });
    }
    notifyState();
    return getPublicStatus();
  }

  return {
    start,
    stop,
    issueTicket,
    revokeTicket,
    getPublicStatus
  };
}

module.exports = {
  LOOPBACK_HOST,
  redactGatewayUrl,
  timingSafeEqualTokens,
  parseHttpByteRange,
  buildSecurityHeaders,
  createGatewayServer
};
