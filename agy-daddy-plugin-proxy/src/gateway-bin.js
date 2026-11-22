#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { DEFAULT_GATEWAY_PORT, DEFAULT_NO_PROXY } = require('./proxy-config');
const { LocalProxyGateway } = require('./gateway');

function parseArgs(argv) {
  const opts = { port: DEFAULT_GATEWAY_PORT, configPath: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) {
      opts.port = Number(argv[++i]);
    } else if (argv[i] === '--config' && argv[i + 1]) {
      opts.configPath = path.resolve(argv[++i]);
    }
  }
  return opts;
}

function readGatewayConfig(configPath) {
  if (!configPath || !fs.existsSync(configPath)) {
    return { mode: 'direct', upstreamUrl: '', noProxy: DEFAULT_NO_PROXY, fallbackToDirectOnUpstreamError: false };
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return {
    mode: raw.mode === 'upstream' || (raw.enabled === true && (raw.httpProxy || raw.upstreamUrl)) ? 'upstream' : 'direct',
    upstreamUrl: raw.upstreamUrl || raw.httpProxy || raw.proxyUrl || '',
    noProxy: raw.noProxy !== undefined ? raw.noProxy : DEFAULT_NO_PROXY,
    fallbackToDirectOnUpstreamError: Boolean(raw.fallbackToDirectOnUpstreamError)
  };
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const initial = readGatewayConfig(opts.configPath);
  const gateway = new LocalProxyGateway({ port: opts.port, ...initial });
  const stats = await gateway.start(opts.port);
  console.log(`[agy-daddy-proxy] listening on 127.0.0.1:${stats.port} (mode=${stats.mode})`);

  const reload = () => {
    try {
      gateway.updateConfig(readGatewayConfig(opts.configPath));
    } catch (err) {
      console.error(`[agy-daddy-proxy] config reload failed: ${err.message}`);
    }
  };

  let watcher = null;
  if (opts.configPath && fs.existsSync(path.dirname(opts.configPath))) {
    try {
      watcher = fs.watch(path.dirname(opts.configPath), (_, file) => {
        if (!file || file === path.basename(opts.configPath)) reload();
      });
    } catch {}
  }
  process.on('SIGHUP', reload);

  const shutdown = async () => {
    if (watcher) try { watcher.close(); } catch {}
    await gateway.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[agy-daddy-proxy] fatal: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, readGatewayConfig, main };
