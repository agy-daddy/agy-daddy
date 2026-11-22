#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function readQuotaState(dataDir) {
  const dir = dataDir || process.env.AGY_DADDY_PLUGIN_DATA_DIR || '';
  const snapPath = dir ? path.join(dir, 'latest-snapshot.json') : '';
  if (snapPath && fs.existsSync(snapPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
      return { ok: true, available: true, source: 'snapshot-file', ...parsed };
    } catch {}
  }
  return {
    ok: true,
    available: false,
    reason: 'NO_SNAPSHOT_YET',
    ultraSubTier: null,
    quotaMultiplier: 1,
    pools: [],
    gemini: null,
    claude: null
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
        serverInfo: { name: 'agy-daddy-quota-mcp', version: '1.0.0' }
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
            name: 'quota_status',
            description: 'Query current Antigravity Gemini & Claude 5h/weekly quota pools and tightest remaining percentage.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false }
          }
        ]
      }
    };
  }

  if (msg.method === 'tools/call') {
    const toolName = msg.params?.name;
    if (toolName !== 'quota_status') {
      return {
        jsonrpc: '2.0',
        id: msg.id ?? null,
        error: { code: -32601, message: `Unknown tool: ${toolName}` }
      };
    }
    const status = readQuotaState(dataDir);
    return {
      jsonrpc: '2.0',
      id: msg.id ?? null,
      result: {
        content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
        structuredContent: status
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

module.exports = { readQuotaState, handleRpcMessage, startStdioServer };
