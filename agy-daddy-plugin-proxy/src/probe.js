'use strict';

const net = require('net');
const http = require('http');
const {
  parseAndValidateProxyUrl,
  redactProxyUrl,
  detectLoginShellProxyConflict
} = require('./proxy-config');

function probeTcp(host, port, timeoutMs = 2500) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: Number(port) });
    let settled = false;
    const done = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch {}
      resolve({ ...res, latencyMs: Date.now() - t0 });
    };
    const timer = setTimeout(() => done({ ok: false, error: 'TCP timeout' }), timeoutMs);
    socket.once('connect', () => done({ ok: true }));
    socket.once('error', (err) => done({ ok: false, error: err?.message || 'TCP error' }));
  });
}

function probeHttpViaGateway(gatewayPort, targetUrl, timeoutMs = 4000) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let parsedTarget;
    try {
      parsedTarget = new URL(targetUrl);
    } catch (err) {
      resolve({ ok: false, error: `Invalid target URL: ${err.message}` });
      return;
    }

    const req = http.request({
      hostname: '127.0.0.1',
      port: Number(gatewayPort),
      method: 'GET',
      path: targetUrl,
      headers: { Host: parsedTarget.host },
      agent: false
    }, (res) => {
      res.resume();
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 500,
          statusCode: res.statusCode,
          latencyMs: Date.now() - t0
        });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('HTTP probe timeout')));
    req.on('error', (err) => resolve({ ok: false, error: err?.message || 'HTTP probe failed', latencyMs: Date.now() - t0 }));
    req.end();
  });
}

async function probeConnectivity(options = {}) {
  const config = options.config || {};
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 4000;
  const mode = config.mode === 'upstream' ? 'upstream' : 'direct';

  let configValid = { ok: true };
  let parsedUpstream = null;
  if (mode === 'upstream') {
    const checked = parseAndValidateProxyUrl(config.upstreamUrl || '');
    if (!checked.ok) {
      configValid = { ok: false, error: checked.error };
    } else {
      parsedUpstream = checked;
    }
  }

  const shellConflict = detectLoginShellProxyConflict({
    envOutput: options.shellEnvOutput,
    platform: options.platform
  });

  const gatewayPort = Number(options.gatewayPort || config.gatewayPort || 0);
  const gatewayTcp = gatewayPort > 0
    ? await probeTcp('127.0.0.1', gatewayPort, timeoutMs)
    : { ok: false, skipped: true, error: 'Gateway not listening' };

  let upstreamTcp = { ok: true, skipped: true };
  if (mode === 'upstream') {
    if (!parsedUpstream) {
      upstreamTcp = { ok: false, skipped: true, error: configValid.error };
    } else {
      upstreamTcp = await probeTcp(parsedUpstream.hostname, parsedUpstream.port, timeoutMs);
    }
  }

  let endToEndHttp = { ok: true, skipped: true };
  if (options.targetUrl && gatewayTcp.ok) {
    endToEndHttp = await probeHttpViaGateway(gatewayPort, options.targetUrl, timeoutMs);
  }

  const ok = Boolean(
    configValid.ok &&
    gatewayTcp.ok &&
    (mode !== 'upstream' || upstreamTcp.ok) &&
    (!options.targetUrl || endToEndHttp.ok)
  );

  return {
    ok,
    mode,
    upstreamUrl: redactProxyUrl(config.upstreamUrl || ''),
    configValid,
    shellConflict,
    gatewayTcp,
    upstreamTcp,
    endToEndHttp
  };
}

module.exports = {
  probeTcp,
  probeHttpViaGateway,
  probeConnectivity
};
