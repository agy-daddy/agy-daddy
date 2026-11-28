#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { summarizeApiCost, summarizeByPeriod } = require('../src/pricing-ledger');

function readUsageSummary(dataDir) {
  const dir = dataDir || process.env.AGY_DADDY_PLUGIN_DATA_DIR || '';
  const ledgerPath = dir ? path.join(dir, 'token-pricing-ledger.json') : '';
  const planPath = dir ? path.join(dir, 'custom-plan.json') : '';
  const cyclePath = dir ? path.join(dir, 'cycle-window.json') : '';
  const quotaSnapPath = dir ? path.resolve(dir, '..', 'agy-daddy.quota', 'latest-snapshot.json') : '';
  let calls = [];
  let plan = {};
  let rawCycle = null;
  if (ledgerPath && fs.existsSync(ledgerPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      calls = Object.values(parsed?.calls || {});
    } catch {}
  }
  if (planPath && fs.existsSync(planPath)) {
    try { plan = JSON.parse(fs.readFileSync(planPath, 'utf8')) || {}; } catch {}
  }
  if (cyclePath && fs.existsSync(cyclePath)) {
    try {
      const parsedCycle = JSON.parse(fs.readFileSync(cyclePath, 'utf8'));
      if (parsedCycle && typeof parsedCycle === 'object' && !parsedCycle.isFallback) {
        rawCycle = {
          endAtMs: parsedCycle.endAtMs,
          durationMs: parsedCycle.durationMs,
          windowKey: parsedCycle.windowKey,
          source: parsedCycle.source || 'cached_window'
        };
      }
    } catch {}
  }
  if (!rawCycle && quotaSnapPath && fs.existsSync(quotaSnapPath)) {
    try {
      const parsedSnap = JSON.parse(fs.readFileSync(quotaSnapPath, 'utf8'));
      if (parsedSnap && typeof parsedSnap === 'object') {
        rawCycle = { ...parsedSnap, source: 'cached_window' };
      }
    } catch {}
  }
  const periods = summarizeByPeriod(calls, Date.now(), plan, { cycleWindow: rawCycle });
  return {
    ok: true,
    ...summarizeApiCost(calls),
    periods,
    cycleWindow: periods.cycleWindow,
    plan
  };
}

function handleRpcMessage(msg, dataDir) {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.method === 'notifications/initialized') return null;

  if (msg.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: msg.id ?? null,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'agy-daddy-usage-mcp', version: '1.0.0' }
      }
    };
  }

  if (msg.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id: msg.id ?? null,
      result: {
        tools: [
          {
            name: 'usage_summary',
            description: 'Summarize Antigravity token usage, estimated API USD cost, today/month/year breakdown, and Ultra plan tier.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false }
          }
        ]
      }
    };
  }

  if (msg.method === 'tools/call') {
    const toolName = msg.params?.name;
    if (toolName !== 'usage_summary') {
      return {
        jsonrpc: '2.0',
        id: msg.id ?? null,
        error: { code: -32601, message: `Unknown tool: ${toolName}` }
      };
    }
    const summary = readUsageSummary(dataDir);
    return {
      jsonrpc: '2.0',
      id: msg.id ?? null,
      result: {
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
        structuredContent: summary
      }
    };
  }

  if (msg.id !== undefined) {
    return {
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${msg.method}` }
    };
  }
  return null;
}

function startStdioServer(dataDir) {
  let buf = Buffer.alloc(0);
  let useContentLength = false;

  const sendReply = (obj) => {
    if (!obj) return;
    const json = JSON.stringify(obj);
    if (useContentLength) {
      const byteLen = Buffer.byteLength(json, 'utf8');
      process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
    } else {
      process.stdout.write(`${json}\n`);
    }
  };

  process.stdin.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length > 0) {
      const str = buf.toString('utf8');
      if (/^Content-Length:\s*(\d+)/i.test(str)) {
        useContentLength = true;
        const headerEnd = buf.indexOf('\r\n\r\n');
        const altEnd = headerEnd < 0 ? buf.indexOf('\n\n') : -1;
        const sepIdx = headerEnd >= 0 ? headerEnd : altEnd;
        const sepLen = headerEnd >= 0 ? 4 : 2;
        if (sepIdx < 0) return;
        const headerText = buf.subarray(0, sepIdx).toString('utf8');
        const m = headerText.match(/Content-Length:\s*(\d+)/i);
        const bodyLen = m ? Number(m[1]) : 0;
        const totalNeed = sepIdx + sepLen + bodyLen;
        if (buf.length < totalNeed) return;
        const bodyRaw = buf.subarray(sepIdx + sepLen, totalNeed).toString('utf8');
        buf = buf.subarray(totalNeed);
        try { sendReply(handleRpcMessage(JSON.parse(bodyRaw), dataDir)); } catch {}
        continue;
      }
      const nlIdx = buf.indexOf(10);
      if (nlIdx < 0) return;
      const line = buf.subarray(0, nlIdx).toString('utf8').trim();
      buf = buf.subarray(nlIdx + 1);
      if (!line) continue;
      try { sendReply(handleRpcMessage(JSON.parse(line), dataDir)); } catch {}
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

if (require.main === module) {
  startStdioServer(process.env.AGY_DADDY_PLUGIN_DATA_DIR || '');
}

module.exports = { readUsageSummary, handleRpcMessage, startStdioServer };
