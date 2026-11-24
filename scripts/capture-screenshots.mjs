#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT_DIR, 'docs', 'assets', 'screenshots');

const {
  buildHostBootstrapScript,
  bundlePluginRendererSource,
  buildIsolatedWorldPluginScript,
} = require(path.join(ROOT_DIR, 'agy-daddy-host', 'src', 'core', 'injector.js'));
const { renderHeatmapSvg } = require(path.join(ROOT_DIR, 'agy-daddy-plugin-usage', 'src', 'heatmap-svg.js'));
const { generateQrSvg } = require(path.join(ROOT_DIR, 'agy-daddy-plugin-remote', 'src', 'qr-svg.js'));

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function findChromeBinary() {
  const candidates = [
    process.env.AGY_CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);

  for (const cand of candidates) {
    if (fs.existsSync(cand)) return cand;
  }
  throw new Error('Chrome/Chromium binary not found. Set AGY_CHROME_PATH to a Chromium-based executable.');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadOfficialPlugins() {
  const dirs = fs
    .readdirSync(ROOT_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('agy-daddy-plugin-') && d.name !== 'agy-daddy-plugin-template')
    .map((d) => d.name)
    .sort();

  return dirs.map((dirName) => {
    const dirPath = path.join(ROOT_DIR, dirName);
    const manifest = JSON.parse(fs.readFileSync(path.join(dirPath, 'agy-plugin.json'), 'utf8'));
    const schemaPath = path.join(dirPath, 'settings.schema.json');
    const schema = fs.existsSync(schemaPath) ? JSON.parse(fs.readFileSync(schemaPath, 'utf8')) : null;
    const values = {};
    if (schema && Array.isArray(schema.fields)) {
      for (const field of schema.fields) {
        if (field.key && field.default !== undefined) {
          values[field.key] = field.default;
        }
      }
    }
    return { dirName, dirPath, manifest, schema, values };
  });
}

function buildDemoTelemetry() {
  const days = [];
  const startDate = new Date('2025-11-30T00:00:00Z');
  for (let i = 0; i < 364; i++) {
    const d = new Date(startDate.getTime() + i * 86400_000);
    const wave = (Math.sin(i * 0.23) + Math.cos(i * 0.11) + 2) / 4;
    const weekendFactor = d.getUTCDay() === 0 || d.getUTCDay() === 6 ? 0.55 : 1;
    const recentBoost = i > 300 ? 1.25 : 1;
    const score = wave * weekendFactor * recentBoost;
    const level = score > 0.85 ? 4 : score > 0.62 ? 3 : score > 0.4 ? 2 : score > 0.22 ? 1 : 0;
    const tokens = level === 0 ? 0 : Math.round((level * 180_000) + ((i * 7919) % 95_000));
    days.push({
      date: d.toISOString().slice(0, 10),
      level,
      tokens,
    });
  }

  const heatmapSvg = renderHeatmapSvg({ weeks: 52, days }, { cellSize: 10, gap: 2 });
  const qrSvg = generateQrSvg('https://remote.example.dev/?t=demo-pairing-token', { width: 152, height: 152 });

  const contextSnapshot = {
    hasSession: true,
    status: 'reported',
    model: 'Gemini 2.5 Pro',
    used: 184_200,
    budget: 1_000_000,
    percent: 18.4,
    remainPercent: 81.6,
    cacheHitRate: 92,
    cachedTokens: 149_800,
    inputTokens: 162_800,
    outputTokens: 6_920,
    warnThreshold: '240K',
    cliffThreshold: '328K',
    warnThresholdTokens: 240_000,
    cliffThresholdTokens: 328_000,
    cacheCliffRisk: 'none',
    cacheDropDetected: false,
    speed: {
      tps: 74,
      streamingTps: 92,
      ttft: 0.38,
      outputTokens: 1_840,
      duration: 24.8,
    },
    sessionUsage: {
      callsCount: 14,
      totalTokens: 648_500,
      outputTokens: 28_400,
      cachedTokens: 542_000,
      inputTokens: 78_100,
      thinkingTokens: 11_600,
      responseTokens: 16_800,
      avgTps: 69,
      avgStreamingTps: 86,
    },
    groups: {
      system: 18_400,
      user: 14_200,
      assistant: 48_600,
      tool: 89_200,
      thinking: 13_800,
    },
    attachments: {
      totals: { count: 2, high: 4_200 },
    },
    alerts: [],
  };

  const quotaSnapshot = {
    ultraSubTier: '20X',
    quotaMultiplier: 20,
    tightestFraction: 0.68,
    tightestPercentText: '68%',
    highestUsedPercentText: '32%',
    gemini: {
      remainingFraction: 0.86,
      remainingPercent: 86,
      percentText: '86%',
      fiveHour: { remainingFraction: 0.86, remainingPercent: 86, percentText: '86%', countdownText: '3h 18m' },
      weekly: { remainingFraction: 0.91, remainingPercent: 91, percentText: '91%', countdownText: '4d 11h' },
    },
    claude: {
      remainingFraction: 0.68,
      remainingPercent: 68,
      percentText: '68%',
      fiveHour: { remainingFraction: 0.68, remainingPercent: 68, percentText: '68%', countdownText: '2h 42m' },
      weekly: { remainingFraction: 0.79, remainingPercent: 79, percentText: '79%', countdownText: '5d 06h' },
    },
    pools: [
      {
        title: 'Gemini 2.5 Pro / Flash',
        tightestFraction: 0.86,
        tightestPercentText: '86%',
        highestUsedPercentText: '14%',
        fiveHourBucket: { remainingFraction: 0.86, percentText: '86%', countdownText: '3h 18m' },
        weeklyBucket: { remainingFraction: 0.91, percentText: '91%', countdownText: '4d 11h' },
      },
      {
        title: 'Claude Sonnet / Opus',
        tightestFraction: 0.68,
        tightestPercentText: '68%',
        highestUsedPercentText: '32%',
        fiveHourBucket: { remainingFraction: 0.68, percentText: '68%', countdownText: '2h 42m' },
        weeklyBucket: { remainingFraction: 0.79, percentText: '79%', countdownText: '5d 06h' },
      },
    ],
  };

  const usageSummary = {
    currency: 'USD',
    currencySymbol: '$',
    exchangeRate: 1,
    totalTokens: 18_420_000,
    totalUsd: 142.8,
    totalDisplayCost: 142.8,
    callsCount: 412,
    cacheReadTokens: 14_890_000,
    plan: {
      detectedTier: 'ultra',
      detectedSubTier: '20x',
      detectedLabel: '20X',
      currency: 'USD',
      costInfo: { regionFlag: 'US', regionName: 'US' },
    },
    backfillStatus: { earliestDate: '2025-12-01' },
    periods: {
      today: {
        totalTokens: 648_500,
        geminiTokens: 482_000,
        otherTokens: 166_500,
        totalUsd: 4.82,
        totalDisplayCost: 4.82,
        callsCount: 14,
        cacheReadTokens: 542_000,
      },
      month: {
        totalTokens: 7_240_000,
        geminiTokens: 5_120_000,
        otherTokens: 2_120_000,
        totalUsd: 54.6,
        callsCount: 168,
        cacheReadTokens: 5_890_000,
      },
      year: {
        totalTokens: 18_420_000,
        geminiTokens: 13_180_000,
        otherTokens: 5_240_000,
        totalUsd: 142.8,
        callsCount: 412,
        cacheReadTokens: 14_890_000,
      },
      allTime: {
        totalTokens: 18_420_000,
        geminiTokens: 13_180_000,
        otherTokens: 5_240_000,
        totalUsd: 142.8,
        callsCount: 412,
        cacheReadTokens: 14_890_000,
        byModel: {
          'Gemini 2.5 Pro': { tokens: 10_420_000, costUSD: 68.4, calls: 224, isPriced: true },
          'Claude 3.7 Sonnet': { tokens: 5_240_000, costUSD: 61.2, calls: 118, isPriced: true },
          'Gemini 2.5 Flash': { tokens: 2_760_000, costUSD: 13.2, calls: 70, isPriced: true },
        },
      },
      roi: {
        subscriptionCurrency: 'USD',
        subscriptionCurrencySymbol: '$',
        billingCycle: 'monthly',
        monthlyNative: 200,
        actualPaidUsd: 200,
        estimatedApiUsd: 142.8,
        effectiveSavedUsd: 57.2,
      },
    },
    heatmapSvg,
  };

  const remoteStatus = {
    ok: true,
    available: true,
    running: true,
    port: 18900,
    url: 'http://192.168.1.42:18900',
    pairingUrl: 'http://192.168.1.42:18900/?t=demo-pairing-token',
    qrSvg,
    primaryChannel: 'lan',
    permissionLevel: 'L1',
    allowRemoteWrite: true,
    channels: { loopback: true, lan: true, tailscale: true, bonjour: false, cloudflare: false },
    deviceCount: 1,
    pcWeb: { running: true, url: 'http://127.0.0.1:18910/' },
  };

  const projects = [
    {
      id: 'proj-acme',
      name: 'acme-web-platform',
      rootPath: '/workspace/acme-web-platform',
      groupId: 'grp-core',
      sessionCount: 3,
      lastModifiedTime: '2026-11-24T15:30:00Z',
    },
    {
      id: 'proj-gateway',
      name: 'edge-api-gateway',
      rootPath: '/workspace/edge-api-gateway',
      groupId: 'grp-core',
      sessionCount: 1,
      lastModifiedTime: '2026-11-24T13:10:00Z',
    },
  ];

  const groups = [
    {
      id: 'grp-core',
      name: 'Active Workspaces',
      sortOrder: 0,
      collapsed: false,
      projectIds: ['proj-acme', 'proj-gateway'],
      workspaceUris: ['file:///workspace/acme-web-platform'],
      sessionIds: ['sess-demo-1', 'sess-demo-2', 'sess-demo-3'],
    },
  ];

  const sessions = [
    {
      cascadeId: 'sess-demo-1',
      shortId: 'sess-dem',
      hasTitle: true,
      titleSource: 'title',
      title: 'Refactor auth middleware & rate-limit tests',
      summary: 'Added sliding-window limiter and verified integration suite',
      status: 'CASCADE_RUN_STATUS_IDLE',
      needsAttention: false,
      stepCount: 5,
      lastModifiedTime: '2026-11-24T15:32:00Z',
      createdTime: '2026-11-24T14:40:00Z',
      workspaceUri: 'file:///workspace/acme-web-platform',
      gitRootUri: 'file:///workspace/acme-web-platform',
      repoName: 'acme-web-platform',
      branchName: 'feat/rate-limiter',
      workspaces: [{ workspaceUri: 'file:///workspace/acme-web-platform', repoName: 'acme-web-platform', branchName: 'feat/rate-limiter' }],
      projectId: 'proj-acme',
      projectName: 'acme-web-platform',
      pinned: true,
    },
    {
      cascadeId: 'sess-demo-2',
      shortId: 'sess-2',
      hasTitle: true,
      titleSource: 'title',
      title: 'Optimize WebSocket reconnect backoff',
      summary: 'Exponential jitter + heartbeat timeout tuning',
      status: 'CASCADE_RUN_STATUS_IDLE',
      needsAttention: true,
      attentionReason: 'Command approval required',
      stepCount: 4,
      lastModifiedTime: '2026-11-24T14:18:00Z',
      createdTime: '2026-11-24T13:50:00Z',
      workspaceUri: 'file:///workspace/acme-web-platform',
      gitRootUri: 'file:///workspace/acme-web-platform',
      repoName: 'acme-web-platform',
      branchName: 'fix/ws-backoff',
      workspaces: [{ workspaceUri: 'file:///workspace/acme-web-platform', repoName: 'acme-web-platform', branchName: 'fix/ws-backoff' }],
      projectId: 'proj-acme',
      projectName: 'acme-web-platform',
    },
    {
      cascadeId: 'sess-demo-3',
      shortId: 'sess-3',
      hasTitle: true,
      titleSource: 'title',
      title: 'Audit TLS certificate rotation job',
      summary: 'Verified zero-downtime reload in staging',
      status: 'CASCADE_RUN_STATUS_IDLE',
      needsAttention: false,
      stepCount: 3,
      lastModifiedTime: '2026-11-24T11:05:00Z',
      createdTime: '2026-11-24T10:20:00Z',
      workspaceUri: 'file:///workspace/edge-api-gateway',
      gitRootUri: 'file:///workspace/edge-api-gateway',
      repoName: 'edge-api-gateway',
      branchName: 'main',
      workspaces: [{ workspaceUri: 'file:///workspace/edge-api-gateway', repoName: 'edge-api-gateway', branchName: 'main' }],
      projectId: 'proj-gateway',
      projectName: 'edge-api-gateway',
    },
  ];

  const events = [
    {
      seq: 1,
      kind: 'user',
      status: 'done',
      rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
      payload: {
        items: [{ text: 'Add a per-IP sliding-window rate limiter to src/middleware/auth.ts and run the middleware tests.' }],
        text: 'Add a per-IP sliding-window rate limiter to src/middleware/auth.ts and run the middleware tests.',
      },
    },
    {
      seq: 2,
      kind: 'file_view',
      status: 'done',
      rawType: 'CORTEX_STEP_TYPE_VIEW_FILE',
      title: 'src/middleware/auth.ts',
      payload: {
        absolutePathUri: 'file:///workspace/acme-web-platform/src/middleware/auth.ts',
        startLine: 1,
        endLine: 64,
        numLines: 64,
        numBytes: 1840,
        content: 'export function createAuthMiddleware(opts) { /* ... */ }',
      },
    },
    {
      seq: 3,
      kind: 'code_action',
      status: 'done',
      rawType: 'CORTEX_STEP_TYPE_CODE_ACTION',
      title: 'Update src/middleware/auth.ts',
      payload: {
        actionSpec: {
          description: 'Integrate SlidingWindowLimiter with configurable burst and TTL',
          targetFile: 'src/middleware/auth.ts',
        },
        diffStats: { additions: 28, deletions: 4 },
        actionResult: { applied: true },
      },
    },
    {
      seq: 4,
      kind: 'command',
      status: 'done',
      rawType: 'CORTEX_STEP_TYPE_RUN_COMMAND',
      title: 'npm test -- auth.test.ts',
      payload: {
        commandLine: 'npm test -- auth.test.ts',
        cwd: '/workspace/acme-web-platform',
        exitCode: 0,
        combinedOutput: 'PASS tests/auth.test.ts (14 passed, 0 failed, 182ms)',
        shellName: 'zsh',
      },
    },
    {
      seq: 5,
      kind: 'thinking_and_text',
      status: 'done',
      rawType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      payload: {
        thinking: 'All 14 middleware assertions pass with zero regressions across token refresh and rate-limit burst windows.',
        thinkingDuration: '1.4s',
        response: [
          'Implemented the sliding-window rate limiter in `src/middleware/auth.ts` and verified all 14 unit tests:',
          '',
          '- **Sliding Window**: Tracks request timestamps per client key with automatic stale-bucket pruning.',
          '- **Headers**: Emits `X-RateLimit-Remaining` and `Retry-After` on `429` responses.',
          '- **Verification**: `npm test -- auth.test.ts` passed (`14/14` green).',
        ].join('\n'),
      },
    },
  ];

  const fsEntries = [
    {
      name: 'src',
      path: 'src',
      type: 'directory',
      children: [
        {
          name: 'middleware',
          path: 'src/middleware',
          type: 'directory',
          children: [
            { name: 'auth.ts', path: 'src/middleware/auth.ts', type: 'file', size: 2410 },
            { name: 'rate-limit.ts', path: 'src/middleware/rate-limit.ts', type: 'file', size: 1620 },
          ],
        },
        { name: 'server.ts', path: 'src/server.ts', type: 'file', size: 3180 },
        { name: 'router.ts', path: 'src/router.ts', type: 'file', size: 1940 },
      ],
    },
    {
      name: 'tests',
      path: 'tests',
      type: 'directory',
      children: [
        { name: 'auth.test.ts', path: 'tests/auth.test.ts', type: 'file', size: 2890 },
      ],
    },
    { name: 'package.json', path: 'package.json', type: 'file', size: 840 },
    { name: 'README.md', path: 'README.md', type: 'file', size: 4200 },
  ];

  const diffResponse = {
    ok: true,
    isGitRepo: true,
    branch: 'feat/rate-limiter',
    files: [
      { path: 'src/middleware/auth.ts', status: 'modified', additions: 28, deletions: 4 },
      { path: 'tests/auth.test.ts', status: 'modified', additions: 19, deletions: 0 },
    ],
    diffText: [
      'diff --git a/src/middleware/auth.ts b/src/middleware/auth.ts',
      '--- a/src/middleware/auth.ts',
      '+++ b/src/middleware/auth.ts',
      '@@ -18,6 +18,14 @@ export function createAuthMiddleware(opts: AuthOptions) {',
      '+  const limiter = new SlidingWindowLimiter({',
      '+    windowMs: opts.windowMs ?? 60_000,',
      '+    maxRequests: opts.maxRequests ?? 120,',
      '+  });',
      '+',
      '   return async function authMiddleware(req, res, next) {',
      '+    if (!limiter.consume(req.ip)) {',
      '+      return res.status(429).json({ error: "RATE_LIMITED" });',
      '+    }',
    ].join('\n'),
  };

  const models = [
    {
      id: 'gemini-2.5-pro',
      model: 'gemini-2.5-pro',
      modelId: 'gemini-2.5-pro',
      label: 'Gemini 2.5 Pro',
      displayName: 'Gemini 2.5 Pro',
      shortName: 'Gemini 2.5 Pro',
      maxTokens: 1_000_000,
      disabled: false,
      supportsImages: true,
      isDefault: true,
      quotaInfo: { remainingFraction: 0.86 },
    },
    {
      id: 'claude-3.7-sonnet',
      model: 'claude-3.7-sonnet',
      modelId: 'claude-3.7-sonnet',
      label: 'Claude 3.7 Sonnet',
      displayName: 'Claude 3.7 Sonnet',
      shortName: 'Claude 3.7 Sonnet',
      maxTokens: 200_000,
      disabled: false,
      supportsImages: true,
      isDefault: false,
      quotaInfo: { remainingFraction: 0.68 },
    },
  ];

  return {
    contextSnapshot,
    quotaSnapshot,
    usageSummary,
    remoteStatus,
    projects,
    groups,
    sessions,
    events,
    fsEntries,
    diffResponse,
    models,
  };
}

function buildSimulatedAntigravityHtml() {
  return `<!doctype html>
<html lang="zh-CN" class="dark" data-theme="dark">
<head>
<meta charset="utf-8" />
<title>Antigravity — acme-web-platform</title>
<style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; width: 100%; height: 100%;
    background: #101012; color: #e4e4e7;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif;
    font-size: 13px; overflow: hidden;
    --background: #101012;
    --foreground: #e4e4e7;
    --card: #18181b;
    --secondary: rgba(255,255,255,0.075);
    --sidebar-secondary: rgba(255,255,255,0.12);
    --muted: rgba(255,255,255,0.045);
    --muted-foreground: #8e8e98;
    --secondary-foreground: #a1a1aa;
    --border: rgba(255,255,255,0.09);
  }
  .app-frame { display: flex; flex-direction: column; width: 100vw; height: 100vh; }
  .titlebar {
    height: 40px; padding: 0 14px;
    display: flex; align-items: center; justify-content: space-between;
    background: #141417; border-bottom: 1px solid rgba(255,255,255,0.08);
    flex-shrink: 0;
  }
  .tb-left { display: flex; align-items: center; gap: 12px; }
  .traffic { display: inline-flex; gap: 7px; }
  .traffic i { width: 11px; height: 11px; border-radius: 50%; display: block; }
  .t-red { background: #ff5f57; } .t-yel { background: #febc2e; } .t-grn { background: #28c840; }
  .tb-title { font-weight: 600; font-size: 12.5px; color: #d4d4d8; }
  .tb-ws { font-size: 11.5px; color: #8e8e98; padding: 2px 8px; border-radius: 999px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); }
  .tb-right { display: flex; align-items: center; gap: 6px; }
  .native-aux-btn {
    height: 26px; padding: 0 9px; border-radius: 7px; border: 1px solid rgba(255,255,255,0.09);
    background: rgba(255,255,255,0.04); color: #a1a1aa; font-size: 11.5px;
    display: inline-flex; align-items: center; gap: 5px;
  }
  .workspace-body { display: grid; grid-template-columns: 256px 1fr; flex: 1; min-height: 0; }
  .sidebar {
    background: #131316; border-right: 1px solid rgba(255,255,255,0.08);
    padding: 12px 10px; display: flex; flex-direction: column; gap: 6px;
  }
  .sb-head { font-size: 11px; font-weight: 600; color: #71717a; padding: 4px 8px; letter-spacing: 0.03em; }
  .sb-row {
    padding: 8px 10px; border-radius: 8px; display: flex; flex-direction: column; gap: 2px;
    color: #a1a1aa; font-size: 12px;
  }
  .sb-row.active { background: rgba(255,255,255,0.08); color: #f4f4f5; }
  .sb-row-sub { font-size: 11px; color: #71717a; }
  .main-chat { display: flex; flex-direction: column; min-height: 0; background: #101012; }
  .chat-scroll { flex: 1; padding: 20px 32px; overflow: hidden; display: flex; flex-direction: column; gap: 16px; max-width: 760px; }
  .msg-user {
    align-self: flex-end; max-width: 82%; padding: 10px 14px; border-radius: 12px;
    background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.1); color: #f4f4f5; line-height: 1.5;
  }
  .msg-agent {
    padding: 14px 16px; border-radius: 12px;
    background: #16161a; border: 1px solid rgba(255,255,255,0.08);
    display: flex; flex-direction: column; gap: 10px; line-height: 1.55;
  }
  .step-chip {
    display: inline-flex; align-items: center; gap: 6px; width: fit-content;
    padding: 3px 9px; border-radius: 999px; font-size: 11px;
    background: rgba(255,255,255,0.06); color: #a1a1aa; border: 1px solid rgba(255,255,255,0.08);
  }
  .code-inline { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; padding: 1px 5px; border-radius: 4px; background: rgba(255,255,255,0.08); }
  .composer-wrap { padding: 12px 24px 18px; border-top: 1px solid rgba(255,255,255,0.07); }
  .surface-composer {
    max-width: 720px; border-radius: 12px; padding: 10px 12px;
    background: #18181b; border: 1px solid rgba(255,255,255,0.12);
    display: flex; flex-direction: column; gap: 8px;
  }
  .composer-editor { min-height: 22px; color: #71717a; outline: none; }
  .composer-foot { display: flex; align-items: center; justify-content: space-between; font-size: 11.5px; color: #8e8e98; }
  .send-btn {
    padding: 4px 12px; border-radius: 7px; border: none;
    background: #e4e4e7; color: #101012; font-weight: 600; font-size: 11.5px;
  }
</style>
</head>
<body>
<div class="app-frame">
  <header class="titlebar @container/titlebar">
    <div class="tb-left">
      <span class="traffic"><i class="t-red"></i><i class="t-yel"></i><i class="t-grn"></i></span>
      <span class="tb-title">Antigravity</span>
      <span class="tb-ws">acme-web-platform · feat/rate-limiter</span>
    </div>
    <div class="tb-right shrink-0">
      <button type="button" class="native-aux-btn" data-testid="toggle-aux-sidebar" aria-expanded="false">文件</button>
    </div>
  </header>
  <div class="workspace-body">
    <aside class="sidebar">
      <div class="sb-head">对话历史</div>
      <div class="sb-row active" data-testid="conversation-row-sidebar" aria-selected="true" data-cascade-id="sess-demo-1">
        <span>重构鉴权中间件与限流测试</span>
        <span class="sb-row-sub">acme-web-platform · 2 分钟前</span>
      </div>
      <div class="sb-row" data-testid="conversation-row-sidebar" data-cascade-id="sess-demo-2">
        <span>优化 WebSocket 重连退避</span>
        <span class="sb-row-sub">acme-web-platform · 1 小时前</span>
      </div>
      <div class="sb-row" data-testid="conversation-row-sidebar" data-cascade-id="sess-demo-3">
        <span>巡检 TLS 证书自动轮换任务</span>
        <span class="sb-row-sub">edge-api-gateway · 4 小时前</span>
      </div>
    </aside>
    <main class="main-chat">
      <div class="chat-scroll" data-testid="autoscroll-viewport">
        <div data-testid="turn-cards-container" style="display:flex;flex-direction:column;gap:14px;">
          <div class="msg-user" data-testid="user-message">为 src/middleware/auth.ts 增加基于滑动窗口的限流保护，并运行单元测试验证。</div>
          <div class="msg-agent" data-testid="agent-response">
            <span class="step-chip">已编辑 <span class="code-inline">src/middleware/auth.ts</span> (+28 -4) · 14/14 测试通过</span>
            <div>已接入 <span class="code-inline">SlidingWindowLimiter</span>，支持突发流量阈值与过期桶自动清理，全部中间件集成测试已通过（<span class="code-inline">182ms</span>）。</div>
          </div>
        </div>
      </div>
      <div class="composer-wrap">
        <div class="surface-composer" data-testid="agent-input-box">
          <div class="composer-editor" data-lexical-editor="true" contenteditable="true">向 Antigravity 发送指令...</div>
          <div class="composer-foot">
            <span>Gemini 2.5 Pro · 代码模式</span>
            <button type="button" class="send-btn" data-testid="input-send-button">发送</button>
          </div>
        </div>
      </div>
    </main>
  </div>
</div>
</body>
</html>`;
}

function startHostRendererMockServer(demoData, officialPlugins) {
  const { contextSnapshot, quotaSnapshot, usageSummary, remoteStatus } = demoData;
  const server = http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    if (urlPath === '/' || urlPath === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buildSimulatedAntigravityHtml());
      return;
    }

    const sendJson = (obj) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };

    if (urlPath === '/plugins/agy-daddy.context/snapshot' || urlPath === '/plugins/agy-daddy.context/rescan') {
      return sendJson(contextSnapshot);
    }
    if (urlPath === '/plugins/agy-daddy.quota/snapshot' || urlPath === '/plugins/agy-daddy.quota/refresh') {
      return sendJson(quotaSnapshot);
    }
    if (urlPath === '/plugins/agy-daddy.usage/summary') {
      return sendJson(usageSummary);
    }
    if (urlPath === '/plugins/agy-daddy.usage/heatmap-svg') {
      return sendJson({ ok: true, svg: usageSummary.heatmapSvg });
    }
    if (urlPath === '/plugins/agy-daddy.cli/workspace') {
      return sendJson({ ok: true, cwd: '/workspace/acme-web-platform' });
    }
    if (urlPath === '/plugins/agy-daddy.remote/status') {
      return sendJson(remoteStatus);
    }
    if (urlPath === '/plugins/agy-daddy.remote/pairing') {
      return sendJson({
        ok: true,
        primaryChannel: 'lan',
        pairingUrl: remoteStatus.pairingUrl,
        qrSvg: remoteStatus.qrSvg,
        pcWeb: remoteStatus.pcWeb,
      });
    }
    if (urlPath === '/host/plugins') {
      return sendJson({
        ok: true,
        plugins: officialPlugins.map((p) => ({
          id: p.manifest.id,
          displayName: p.manifest.displayName,
          description: p.manifest.description,
          version: p.manifest.version,
          trustLevel: 'T0',
          world: p.manifest.world,
          enabled: true,
          active: true,
          permissions: p.manifest.permissions || [],
          settingsSchema: p.schema,
          settingsValues: p.values,
        })),
      });
    }
    sendJson({ ok: true });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function serveStaticFile(distDir, reqPath, res) {
  const cleanRel = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
  let target = path.resolve(distDir, cleanRel);
  if (!target.startsWith(distDir) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    target = path.join(distDir, 'index.html');
  }
  const ext = path.extname(target).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
  fs.createReadStream(target).pipe(res);
}

function startWebWorkbenchServer(demoData, officialPlugins) {
  const distDir = path.join(ROOT_DIR, 'agy-daddy-plugin-web', 'dist', 'web');
  const { contextSnapshot, quotaSnapshot, usageSummary, remoteStatus, projects, groups, sessions, events, fsEntries, diffResponse, models } = demoData;

  const pickText = (val, fallback = '') =>
    typeof val === 'string' ? val : (val?.['zh-CN'] || val?.en || fallback);

  const pluginItems = officialPlugins.map((p) => ({
    id: p.manifest.id,
    displayName: pickText(p.manifest.displayName, p.manifest.id),
    description: pickText(p.manifest.description, ''),
    version: p.manifest.version,
    trustLevel: 'T0',
    badge: 'Official',
    world: p.manifest.world || 'isolated',
    nodeIsolation: 'in-process',
    enabled: true,
    active: true,
    hasNative: Boolean(p.manifest.native),
    hasRollback: false,
    permissions: p.manifest.permissions || [],
    sourceKind: 'official',
    sourceSpec: `@agy-daddy/plugin-${p.dirName.replace('agy-daddy-plugin-', '')}`,
    webRelevant: ['agy-daddy.web', 'agy-daddy.remote', 'agy-daddy.context', 'agy-daddy.quota', 'agy-daddy.usage'].includes(p.manifest.id),
  }));

  const pluginMap = new Map(officialPlugins.map((p) => [p.manifest.id, p]));

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = reqUrl.pathname;

    const sendJson = (obj) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };

    if (pathname === '/api/v1/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
      const timer = setInterval(() => {
        if (!res.writableEnded) {
          res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
        }
      }, 5000);
      req.on('close', () => clearInterval(timer));
      return;
    }

    if (pathname === '/api/v1/health') {
      return sendJson({
        ok: true,
        rpcConnected: true,
        hubOrigin: 'http://127.0.0.1:18790',
        pluginVersion: '1.1.0',
        allowedRoots: ['/workspace/acme-web-platform', '/workspace/edge-api-gateway'],
        defaultSessionPath: '/workspace/acme-web-platform',
      });
    }
    if (pathname === '/api/v1/host/locale') {
      return sendJson({
        ok: true,
        locale: 'zh-CN',
        hostLang: 'zh',
        supportedLanguages: [
          { code: 'zh', bcp47: 'zh-CN', nativeName: '简体中文', shortLabel: '简中' },
          { code: 'en', bcp47: 'en', nativeName: 'English', shortLabel: 'EN' },
        ],
      });
    }
    if (pathname === '/api/v1/projects') {
      return sendJson({ ok: true, projects, groups, defaultSessionPath: '/workspace/acme-web-platform' });
    }
    if (pathname === '/api/v1/sessions') {
      return sendJson({ ok: true, sessions, hiddenInternalCount: 0 });
    }
    if (pathname.startsWith('/api/v1/sessions/') && pathname.endsWith('/read')) {
      return sendJson({ ok: true, cascadeId: 'sess-demo-1', lastReadAt: new Date().toISOString(), lastReadStepCount: 5 });
    }
    if (pathname.startsWith('/api/v1/sessions/')) {
      return sendJson({
        ok: true,
        session: {
          cascadeId: 'sess-demo-1',
          trajectoryId: 'traj-demo-1',
          trajectoryType: 'cascade',
          status: 'CASCADE_RUN_STATUS_IDLE',
          numTotalSteps: events.length,
          source: 'antigravity',
          metadata: null,
          generatorMetadata: [],
        },
        events,
      });
    }
    if (pathname === '/api/v1/models') {
      return sendJson({ ok: true, defaultModelId: 'gemini-2.5-pro', models, groups: [] });
    }
    if (pathname === '/api/v1/topbar') {
      return sendJson({
        ok: true,
        panels: {
          context: { available: true, source: 'service', data: contextSnapshot },
          usage: { available: true, source: 'service', data: usageSummary },
          quota: { available: true, source: 'service', data: quotaSnapshot },
        },
      });
    }
    if (pathname === '/api/v1/remote/status') {
      return sendJson(remoteStatus);
    }
    if (pathname === '/api/v1/composer/state') {
      return sendJson({
        ok: true,
        enabled: true,
        installed: true,
        settings: {
          quickPromptsEnabled: true,
          quickPromptBarVisible: true,
          promptOptimizerEnabled: true,
          exportMarkdownEnabled: true,
        },
        quickPrompts: [
          { id: 'plan', label: 'Plan', template: '/plan' },
          { id: 'compact', label: 'Compact', template: '/compact' },
          { id: 'learn', label: 'Learn', template: '/learn' },
        ],
      });
    }
    if (pathname === '/api/v1/fs/tree') {
      return sendJson({ ok: true, root: '/workspace/acme-web-platform', path: '', entries: fsEntries });
    }
    if (pathname === '/api/v1/fs/read') {
      return sendJson({
        ok: true,
        path: 'src/middleware/auth.ts',
        size: 620,
        truncated: false,
        content: [
          "import { SlidingWindowLimiter } from './rate-limit';",
          '',
          'export function createAuthMiddleware(opts) {',
          '  const limiter = new SlidingWindowLimiter({',
          '    windowMs: opts.windowMs ?? 60_000,',
          '    maxRequests: opts.maxRequests ?? 120,',
          '  });',
          '',
          '  return async function authMiddleware(req, res, next) {',
          '    if (!limiter.consume(req.ip)) {',
          '      return res.status(429).json({ error: "RATE_LIMITED" });',
          '    }',
          '    return next();',
          '  };',
          '}',
        ].join('\n'),
      });
    }
    if (pathname === '/api/v1/git/diff') {
      return sendJson(diffResponse);
    }
    if (pathname === '/api/v1/artifacts') {
      return sendJson({ ok: true, sessionId: 'sess-demo-1', items: [] });
    }
    if (pathname === '/api/v1/artifacts/previewers') {
      return sendJson({ ok: true, builtins: [], plugins: [] });
    }
    if (pathname === '/api/v1/host/plugins') {
      const scope = reqUrl.searchParams.get('scope') || 'web';
      const visible = scope === 'all' ? pluginItems : pluginItems.filter((p) => p.webRelevant);
      return sendJson({
        ok: true,
        plugins: visible,
        catalog: [],
        marketStats: { total: pluginItems.length, installed: pluginItems.length, active: pluginItems.length, catalogCount: 0 },
        scope,
        hiddenDesktopCount: pluginItems.length - pluginItems.filter((p) => p.webRelevant).length,
        allPluginsCount: pluginItems.length,
      });
    }
    const settingsMatch = /^\/api\/v1\/host\/plugins\/([^/]+)\/settings$/.exec(pathname);
    if (settingsMatch) {
      const pid = decodeURIComponent(settingsMatch[1]);
      const p = pluginMap.get(pid);
      return sendJson({
        ok: true,
        values: p ? p.values : {},
        schema: p?.schema || { version: 1, fields: [] },
        scope: reqUrl.searchParams.get('scope') || 'all',
        filteredDesktopFieldCount: 0,
      });
    }
    if (pathname.startsWith('/api/v1/')) {
      return sendJson({ ok: true });
    }
    serveStaticFile(distDir, pathname, res);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function startRemotePwaServer(demoData) {
  const distDir = path.join(ROOT_DIR, 'agy-daddy-plugin-remote', 'dist', 'web');
  const { contextSnapshot, quotaSnapshot, usageSummary, projects, groups, sessions, events, diffResponse, models } = demoData;

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = reqUrl.pathname;

    const sendJson = (obj) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };

    if (pathname === '/api/v1/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
      const timer = setInterval(() => {
        if (!res.writableEnded) {
          res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
        }
      }, 5000);
      req.on('close', () => clearInterval(timer));
      return;
    }

    if (pathname === '/api/v1/bootstrap') {
      return sendJson({
        ok: true,
        channel: 'lan',
        permissionLevel: 'L1',
        writeEnabled: true,
        models,
        defaultModelId: 'gemini-2.5-pro',
        workspaces: [{ uri: 'file:///workspace/acme-web-platform', path: '/workspace/acme-web-platform', name: 'acme-web-platform', branchName: 'feat/rate-limiter' }],
        groups,
        projects,
        pins: { sessions: ['sess-demo-1'], projects: [], groups: [] },
        voiceSupported: true,
        telemetry: {
          channel: 'lan',
          panels: {
            context: { available: true, data: contextSnapshot },
            quota: { available: true, data: quotaSnapshot },
            usage: { available: true, data: usageSummary },
          },
        },
      });
    }
    if (pathname === '/api/v1/sessions/org') {
      return sendJson({ ok: true, groups, projects, pins: { sessions: ['sess-demo-1'], projects: [], groups: [] } });
    }
    if (pathname === '/api/v1/sessions') {
      return sendJson({ ok: true, rpcConnected: true, sessions, groups, projects, pins: { sessions: ['sess-demo-1'], projects: [], groups: [] } });
    }
    if (pathname.startsWith('/api/v1/sessions/')) {
      return sendJson({
        ok: true,
        session: { cascadeId: 'sess-demo-1', status: 'CASCADE_RUN_STATUS_IDLE', numTotalSteps: events.length },
        events,
      });
    }
    if (pathname === '/api/v1/composer/presets') {
      return sendJson({
        ok: true,
        presets: [
          { id: 'plan', label: '规划', prompt: '/plan ' },
          { id: 'compact', label: '压缩', prompt: '/compact' },
        ],
      });
    }
    if (pathname === '/api/v1/git/diff') {
      return sendJson(diffResponse);
    }
    if (pathname.startsWith('/api/v1/')) {
      return sendJson({ ok: true });
    }
    serveStaticFile(distDir, pathname, res);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.openPromise = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', (err) => reject(err.error || new Error('WebSocket error')), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }

  async connect() {
    await this.openPromise;
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evalJs(expression, awaitPromise = true, contextId = undefined) {
    const params = {
      expression,
      awaitPromise,
      returnByValue: true,
    };
    if (typeof contextId === 'number') {
      params.contextId = contextId;
    }
    const res = await this.send('Runtime.evaluate', params);
    if (res.exceptionDetails) {
      const msg = res.exceptionDetails.exception?.description || res.exceptionDetails.text || JSON.stringify(res.exceptionDetails);
      throw new Error(msg);
    }
    return res.result?.value;
  }

  async waitFor(fnExpr, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ok = await this.evalJs(`Boolean((${fnExpr})())`);
      if (ok) return;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for condition: ${fnExpr}`);
  }

  async close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function launchHeadlessChrome() {
  const chromeBin = findChromeBinary();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-shot-chrome-'));
  const proc = spawn(
    chromeBin,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const wsUrl = await new Promise((resolve, reject) => {
    let stderrBuf = '';
    const timer = setTimeout(() => reject(new Error(`Chrome launch timeout:\n${stderrBuf}`)), 15000);
    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
      const m = stderrBuf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited prematurely (${code}):\n${stderrBuf}`));
    });
  });

  const browserWs = new CdpClient(wsUrl);
  await browserWs.connect();

  return {
    browserWs,
    async newPageClient() {
      const { targetId } = await browserWs.send('Target.createTarget', { url: 'about:blank' });
      const port = new URL(wsUrl).port;
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const target = targets.find((t) => t.id === targetId);
      const client = new CdpClient(target.webSocketDebuggerUrl);
      await client.connect();
      await client.send('Page.enable');
      await client.send('Runtime.enable');
      return {
        client,
        async dispose() {
          await client.close();
          await browserWs.send('Target.closeTarget', { targetId }).catch(() => {});
        },
      };
    },
    async close() {
      await browserWs.close();
      proc.kill('SIGTERM');
      await sleep(300);
      fs.rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

async function capturePng(client, outPath, { width, height, mobile = false, preferredScale = 2 }) {
  for (const scale of [preferredScale, 1.5, 1]) {
    await client.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: scale,
      mobile,
    });
    await sleep(150);
    const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(data, 'base64');
    fs.writeFileSync(outPath, buf);
    const kb = Math.round(buf.length / 1024);
    if (buf.length <= 500 * 1024 || scale === 1) {
      console.log(`Captured ${path.relative(ROOT_DIR, outPath)} (${width}x${height} @${scale}x, ${kb} KB)`);
      return { width: Math.round(width * scale), height: Math.round(height * scale), bytes: buf.length };
    }
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const officialPlugins = loadOfficialPlugins();
  const demoData = buildDemoTelemetry();

  const hostSrv = await startHostRendererMockServer(demoData, officialPlugins);
  const webSrv = await startWebWorkbenchServer(demoData, officialPlugins);
  const remoteSrv = await startRemotePwaServer(demoData);
  const chrome = await launchHeadlessChrome();

  try {
    // 1. topbar-and-popover.png
    {
      const page = await chrome.newPageClient();
      const { client } = page;
      await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 760, deviceScaleFactor: 2, mobile: false });
      await client.send('Page.navigate', { url: `http://127.0.0.1:${hostSrv.port}/` });
      await client.waitFor(() => Boolean(document.querySelector('.surface-composer')));

      const anchorsRegistry = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'agy-daddy-host', 'data', 'anchors.json'), 'utf8'));
      const hostBundlePath = path.join(ROOT_DIR, 'agy-daddy-host', 'dist', 'host-renderer.js');
      if (!fs.existsSync(hostBundlePath)) {
        const { buildHostRenderer } = require(path.join(ROOT_DIR, 'agy-daddy-host', 'scripts', 'build-renderer.js'));
        buildHostRenderer();
      }
      const hostBundle = fs.readFileSync(hostBundlePath, 'utf8');
      const xworldNonce = 'demo-xworld-nonce';
      const xworldChannelName = `__agy_xworld_${xworldNonce}`;

      const pluginMeta = {};
      for (const p of officialPlugins) {
        pluginMeta[p.manifest.id] = {
          id: p.manifest.id,
          displayName: p.manifest.displayName,
          description: p.manifest.description,
          version: p.manifest.version,
          trustLevel: 'T0',
          world: 'isolated',
          enabled: true,
          active: true,
          permissions: p.manifest.permissions || [],
          settingsSchema: p.schema,
          settingsValues: p.values,
        };
      }

      const bootScript = buildHostBootstrapScript(hostBundle, {
        bridgePort: hostSrv.port,
        hostToken: 'demo-host-token',
        locale: 'zh-CN',
        antigravityVersion: '2.33.0',
        anchorsRegistry,
        xworldNonce,
        hostSettings: {
          themeMode: 'dark',
          maxVisibleUnits: 10,
          showTopbarEntry: true,
          injectNativeSettings: true,
        },
        pluginMeta,
        pluginTokens: {
          'agy-daddy.context': 'tok-context',
          'agy-daddy.usage': 'tok-usage',
          'agy-daddy.quota': 'tok-quota',
          'agy-daddy.cli': 'tok-cli',
          'agy-daddy.remote': 'tok-remote',
        },
      });
      await client.evalJs(bootScript, false);

      const pluginsToMount = [
        { id: 'agy-daddy.context', dir: 'agy-daddy-plugin-context', settings: { displayLocation: 'topbar', showSpeed: true } },
        { id: 'agy-daddy.usage', dir: 'agy-daddy-plugin-usage', settings: { activePeriod: 'allTime', currency: 'USD' } },
        { id: 'agy-daddy.quota', dir: 'agy-daddy-plugin-quota', settings: { topbarCountdownMode: 'both', quotaDisplayMode: 'remaining' } },
        { id: 'agy-daddy.cli', dir: 'agy-daddy-plugin-cli', settings: {} },
        { id: 'agy-daddy.remote', dir: 'agy-daddy-plugin-remote', settings: {} },
      ];

      const frameTree = await client.send('Page.getFrameTree');
      const mainFrameId = frameTree.frameTree.frame.id;

      for (const item of pluginsToMount) {
        const pluginRoot = path.join(ROOT_DIR, item.dir);
        const rendererSource = bundlePluginRendererSource(path.join(pluginRoot, 'src', 'renderer.js'), pluginRoot);
        const { executionContextId } = await client.send('Page.createIsolatedWorld', {
          frameId: mainFrameId,
          worldName: `agy-daddy:${item.id}`,
          grantUniveralAccess: false,
        });
        const isoScript = buildIsolatedWorldPluginScript(item.id, rendererSource, {
          xworldChannelName,
          xworldNonce,
          bridgePort: hostSrv.port,
          pluginToken: `tok-${item.id}`,
          anchorsRegistry,
          initialSettings: item.settings,
        });
        await client.evalJs(isoScript, true, executionContextId);
      }

      await client.waitFor(() => {
        const host = document.getElementById('agy-daddy-host');
        if (!host || !host.shadowRoot) return false;
        const units = host.shadowRoot.querySelectorAll('#agy-topbar-slots .ag-unit');
        return units.length >= 5;
      });
      await sleep(350);

      // Open the Context popover to showcase unified popover floating card + topbar capsules
      await client.evalJs(`(() => {
        const host = document.getElementById('agy-daddy-host');
        const ringBtn = host.shadowRoot.querySelector('[data-unit-id="ring"], [data-plugin-id="agy-daddy.context"]');
        if (ringBtn) ringBtn.click();
      })()`, false);
      await client.waitFor(() => {
        const host = document.getElementById('agy-daddy-host');
        const panel = host?.shadowRoot?.querySelector('#agy-context-panel');
        return Boolean(panel && !panel.closest('[hidden]'));
      });
      await sleep(300);

      await capturePng(client, path.join(OUT_DIR, 'topbar-and-popover.png'), { width: 1280, height: 760, preferredScale: 2 });
      await page.dispose();
    }

    // 2 & 3. pc-web-workbench.png and settings-center.png
    {
      const page = await chrome.newPageClient();
      const { client } = page;
      await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
      await client.send('Page.navigate', { url: `http://127.0.0.1:${webSrv.port}/?session=sess-demo-1` });
      await client.waitFor(() => {
        const hasTitle = Boolean(document.body?.innerText?.includes('Refactor auth middleware'));
        const hasContextCapsule = Boolean(document.querySelector('[data-capsule="context"][data-available="true"]'));
        return hasTitle && hasContextCapsule;
      });
      await sleep(350);

      // Expand middleware dir & open auth.ts preview in the right dock so all 3 panes feel rich
      await client.evalJs(`(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const mwBtn = btns.find((b) => (b.textContent || '').trim() === 'middleware');
        if (mwBtn) mwBtn.click();
      })()`, false);
      await sleep(150);
      await client.evalJs(`(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const authBtn = btns.find((b) => (b.textContent || '').trim() === 'auth.ts');
        if (authBtn) authBtn.click();
      })()`, false);
      await sleep(350);

      await capturePng(client, path.join(OUT_DIR, 'pc-web-workbench.png'), { width: 1440, height: 900, preferredScale: 2 });

      // Open HostAdminModal (Declarative Settings Center + Plugin Management)
      await client.evalJs(`(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const pluginsBtn = btns.find((b) => /Plugins|插件/i.test(b.textContent || ''));
        if (pluginsBtn) pluginsBtn.click();
      })()`, false);
      await client.waitFor(() => Boolean(document.querySelector('[data-testid="host-admin-modal"]')));
      await sleep(250);

      // Toggle "Show desktop plugins" so all 10 official plugins appear in the list
      await client.evalJs(`(() => {
        const cb = document.querySelector('[data-testid="toggle-desktop-plugins"]');
        if (cb && !cb.checked) cb.click();
      })()`, false);
      await client.waitFor(() => Boolean(document.body?.innerText?.includes('agy-daddy.context')));
      await sleep(250);

      // Select agy-daddy.context to display its rich declarative Schema form alongside the plugin list
      await client.evalJs(`(() => {
        const cards = Array.from(document.querySelectorAll('[data-testid="host-admin-modal"] *'));
        const target = cards.find((el) => el.textContent && el.textContent.includes('agy-daddy.context') && el.className && String(el.className).includes('pluginCard'));
        if (target) target.click();
      })()`, false);
      await client.waitFor(() => Boolean(document.body?.innerText?.includes('warnThreshold') || document.body?.innerText?.includes('240K')));
      await sleep(300);

      await capturePng(client, path.join(OUT_DIR, 'settings-center.png'), { width: 1280, height: 820, preferredScale: 2 });
      await page.dispose();
    }

    // 4. mobile-remote-pwa.png
    {
      const page = await chrome.newPageClient();
      const { client } = page;
      await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await client.send('Page.navigate', { url: `http://127.0.0.1:${remoteSrv.port}/?t=demo-pairing-token&session=sess-demo-1` });
      await client.waitFor(() => {
        const cap = document.querySelector('[data-testid="context-capsule-btn"]');
        const step = document.querySelector('[data-testid="step-card-1"]');
        return Boolean(cap && step);
      });
      await sleep(350);

      // Expand TelemetryPanel (Context Window + Gemini/Claude 5h & Week Quota cards)
      await client.evalJs(`document.querySelector('[data-testid="context-capsule-btn"]')?.click()`, false);
      await client.waitFor(() => Boolean(document.querySelector('[data-testid="telemetry-panel"]')));
      await sleep(300);

      await capturePng(client, path.join(OUT_DIR, 'mobile-remote-pwa.png'), { width: 390, height: 844, mobile: true, preferredScale: 2 });
      await page.dispose();
    }
  } finally {
    await chrome.close();
    hostSrv.server.close();
    webSrv.server.close();
    remoteSrv.server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
