'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const {
  DEFAULT_REMOTE_PORT,
  DEFAULT_CHANNELS,
  DEFAULT_REMOTE_DISPLAY_CONFIG,
  normalizePermissionLevel,
  isPermissionAtLeast,
  sanitizeRemoteDisplayConfig,
  normalizeChannelConfig,
  isTailscaleIp,
  isLanIp,
  parseTailscaleServeHttpsUrl,
  validateCloudflareTunnelToken,
  validateTunnelHostname,
  generatePairingToken
} = require('./tunnel-security');
const { generateQrSvg, generateQrAscii } = require('./qr-svg');
const { detectCloudflaredBinary, getCloudflaredInstallHints, CloudflaredManager } = require('./cloudflared');
const { MobileRemoteServer, stripPairingSecrets } = require('./pwa-server');
const { createWebPushManager } = require('./web-push');
const { createPtyManager } = require('./pty-bridge');
const { createMobileWorkspaceService } = require('./mobile-workspace');
const { createSseBroker } = require('./sse-broker');
const {
  DEFAULT_SESSION_LIMIT,
  isTempBridgeWorkspace,
  sanitizeModelCatalogResult,
  createSessionOrgStore
} = require('./session-org-store');

const CHANNEL_KEYS = ['loopback', 'lan', 'tailscale', 'bonjour', 'cloudflare'];
const PRIMARY_CHANNEL_ORDER = ['cloudflare', 'tailscale', 'lan', 'bonjour', 'loopback'];
const CHANNEL_DISPLAY_NAMES = Object.freeze({
  loopback: '本地',
  lan: '局域网',
  bonjour: '局域网',
  tailscale: 'Tailscale',
  cloudflare: 'Cloudflare',
  offline: '离线'
});
const DEFAULT_RPC_METADATA = Object.freeze({
  ideName: 'antigravity',
  extensionName: 'antigravity'
});
const TERMINAL_STEP_STATUSES = new Set(['done', 'error', 'canceled']);
const STEP_STATUS_MAP = Object.freeze({
  CORTEX_STEP_STATUS_DONE: 'done',
  CORTEX_STEP_STATUS_GENERATING: 'generating',
  CORTEX_STEP_STATUS_RUNNING: 'running',
  CORTEX_STEP_STATUS_PENDING: 'pending',
  CORTEX_STEP_STATUS_ERROR: 'error',
  CORTEX_STEP_STATUS_CANCELED: 'canceled',
  CORTEX_STEP_STATUS_CANCELLED: 'canceled',
  done: 'done',
  generating: 'generating',
  running: 'running',
  pending: 'pending',
  error: 'error',
  canceled: 'canceled',
  cancelled: 'canceled'
});
const STEP_KIND_MAP = Object.freeze({
  CORTEX_STEP_TYPE_USER_INPUT: { kind: 'user', field: 'userInput' },
  CORTEX_STEP_TYPE_PLANNER_RESPONSE: { kind: 'thinking_and_text', field: 'plannerResponse' },
  CORTEX_STEP_TYPE_RUN_COMMAND: { kind: 'command', field: 'runCommand' },
  CORTEX_STEP_TYPE_VIEW_FILE: { kind: 'file_view', field: 'viewFile' },
  CORTEX_STEP_TYPE_CODE_ACTION: { kind: 'code_action', field: 'codeAction' },
  CORTEX_STEP_TYPE_ASK_QUESTION: { kind: 'ask_question', field: 'askQuestion' },
  CORTEX_STEP_TYPE_SEARCH_WEB: { kind: 'web_search', field: 'searchWeb' },
  CORTEX_STEP_TYPE_CHECKPOINT: { kind: 'checkpoint', field: 'checkpoint' },
  CORTEX_STEP_TYPE_SYSTEM_MESSAGE: { kind: 'system', field: 'systemMessage' },
  CORTEX_STEP_TYPE_GENERIC: { kind: 'tool_generic', field: 'generic' },
  CORTEX_STEP_TYPE_ERROR_MESSAGE: { kind: 'error', field: 'errorMessage' }
});
const CONFIRM_INTERACTION_FIELDS = [
  'approvalInteraction',
  'mcp',
  'openBrowserUrl',
  'executeBrowserJavaScript',
  'captureBrowserScreenshot',
  'clickBrowserPixel',
  'readUrlContent',
  'sendCommandInput'
];

let disposers = [];

const ORCHESTRATOR_MASTER_KEYS = Object.freeze(['carbon', 'argon', 'neon', 'opus5.5']);
const ORCHESTRATOR_THINKING_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh']);
const ORCHESTRATOR_SETTING_KEY_MAP = Object.freeze({
  carbon: 'orchestratorCarbonThinking',
  argon: 'orchestratorArgonThinking',
  neon: 'orchestratorNeonThinking',
  'opus5.5': 'orchestratorOpusThinking'
});
const MODEL_SORT_MODES = Object.freeze(['custom', 'name_asc', 'name_desc', 'provider', 'frequency']);

function normalizeOrchestratorMasterKey(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'carbon') return 'carbon';
  if (s === 'argon') return 'argon';
  if (s === 'neon') return 'neon';
  if (s === 'opus5.5' || s === 'opus 5.5' || s === 'opus-5.5' || s === 'opus') return 'opus5.5';
  return null;
}

function normalizeOrchestratorThinkingLevel(raw, fallback = 'high') {
  const s = String(raw || '').trim().toLowerCase();
  return ORCHESTRATOR_THINKING_LEVELS.includes(s) ? s : fallback;
}

function sanitizeOrchestratorThinkingMap(raw = {}) {
  const src = isPlainObject(raw) ? raw : {};
  return {
    carbon: normalizeOrchestratorThinkingLevel(src.carbon, 'high'),
    argon: normalizeOrchestratorThinkingLevel(src.argon, 'high'),
    neon: normalizeOrchestratorThinkingLevel(src.neon, 'high'),
    'opus5.5': normalizeOrchestratorThinkingLevel(src['opus5.5'] ?? src.opus, 'high')
  };
}

function normalizeModelSortMode(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return MODEL_SORT_MODES.includes(s) ? s : 'custom';
}

function sanitizeModelFilterOrder(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const s = String(item || '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function inferModelProviderCategory(nameOrId = '') {
  const hay = String(nameOrId || '').toLowerCase();
  if (hay.includes('orchestrator') || hay.includes('编排')) return 'orchestrator';
  if (hay.includes('claude') || hay.includes('opus') || hay.includes('sonnet') || hay.includes('haiku')) return 'claude';
  if (hay.includes('gemini') || hay.includes('neon') || hay.includes('flash') || hay.includes('carbon') || hay.includes('argon')) return 'gemini';
  if (hay.includes('gpt') || hay.includes('openai') || /\bo[134]\b/.test(hay)) return 'openai';
  return 'other';
}

function isTestMode() {
  return process.env.AGY_DADDY_TEST_MODE === '1';
}

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function normalizePickedDirPath(rawPath) {
  const raw = String(rawPath || '').trim();
  if (!raw) return '';
  let expanded = raw;
  if (expanded === '~') {
    expanded = os.homedir();
  } else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }
  if (expanded === '/') return '/';
  return expanded.replace(/[\\/]+$/, '') || '/';
}

function runExecFileAsync(bin, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, {
      timeout: opts.timeout ?? 120000,
      maxBuffer: opts.maxBuffer ?? 1024 * 1024,
      env: opts.env || process.env,
      encoding: 'utf8'
    }, (err, stdout, stderr) => {
      if (err) {
        resolve({
          ok: false,
          code: err.code ?? null,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: err.message || String(err)
        });
        return;
      }
      resolve({
        ok: true,
        code: 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || '')
      });
    });
  });
}

function isUserCancelledOsascript(res) {
  const text = `${res?.stderr || ''} ${res?.error || ''}`;
  return /-128\b|user canceled|用户已取消/i.test(text);
}

async function openAllowedRootDirectoryDialog(opts = {}) {
  const defaultDir = normalizePickedDirPath(opts.defaultDir || '') || os.homedir();
  const promptText = String(opts.title || '选择允许访问的工作区根目录').trim();

  if (typeof opts.dirPickerFn === 'function') {
    const res = await opts.dirPickerFn({ defaultDir, title: promptText });
    if (res && res.ok === false) {
      return { ok: false, cancelled: false, path: '', error: String(res.error || '无法打开文件夹选择对话框') };
    }
    if (!res || res.cancelled || !res.path) {
      return { ok: true, cancelled: true, path: '' };
    }
    return { ok: true, cancelled: false, path: normalizePickedDirPath(res.path) };
  }

  if (isTestMode() || process.env.NODE_ENV === 'test' || process.env.AGY_DADDY_TEST_DIR_DIALOG_RESULT !== undefined) {
    const testResult = String(process.env.AGY_DADDY_TEST_DIR_DIALOG_RESULT || '').trim();
    if (!testResult || testResult === '__CANCEL__') {
      return { ok: true, cancelled: true, path: '' };
    }
    return { ok: true, cancelled: false, path: normalizePickedDirPath(testResult) };
  }

  const platform = opts.platform || process.platform;
  if (platform === 'darwin') {
    const hasDir = defaultDir && fs.existsSync(defaultDir);
    const script = hasDir
      ? [
          'on run argv',
          '  set pTitle to item 1 of argv',
          '  set pDir to item 2 of argv',
          '  tell current application to activate',
          '  return POSIX path of (choose folder with prompt pTitle default location ((POSIX file pDir) as alias))',
          'end run'
        ].join('\n')
      : [
          'on run argv',
          '  set pTitle to item 1 of argv',
          '  tell current application to activate',
          '  return POSIX path of (choose folder with prompt pTitle)',
          'end run'
        ].join('\n');
    const args = ['-e', script, '--', promptText];
    if (hasDir) args.push(defaultDir);
    const res = await runExecFileAsync('osascript', args, { timeout: 120000 });
    if (!res.ok) {
      if (isUserCancelledOsascript(res)) {
        return { ok: true, cancelled: true, path: '' };
      }
      return { ok: false, cancelled: false, path: '', error: (res.stderr || res.error || '无法打开文件夹选择对话框').trim() };
    }
    const picked = normalizePickedDirPath(res.stdout);
    return picked
      ? { ok: true, cancelled: false, path: picked }
      : { ok: true, cancelled: true, path: '' };
  }

  if (platform === 'win32') {
    const psScript = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$d.Description = $env:AGY_DLG_TITLE',
      'if ($env:AGY_DLG_DIR -and (Test-Path $env:AGY_DLG_DIR)) { $d.SelectedPath = $env:AGY_DLG_DIR }',
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }'
    ].join('; ');
    const res = await runExecFileAsync('powershell.exe', ['-NoProfile', '-Command', psScript], {
      timeout: 120000,
      env: { ...process.env, AGY_DLG_TITLE: promptText, AGY_DLG_DIR: defaultDir }
    });
    if (!res.ok && !res.stdout.trim()) {
      return { ok: false, cancelled: false, path: '', error: (res.stderr || res.error || '无法打开文件夹选择对话框').trim() };
    }
    const picked = normalizePickedDirPath(res.stdout);
    return picked ? { ok: true, cancelled: false, path: picked } : { ok: true, cancelled: true, path: '' };
  }

  const zen = await runExecFileAsync('zenity', ['--file-selection', '--directory', `--title=${promptText}`, `--filename=${defaultDir}/`], { timeout: 120000 });
  if (zen.ok && zen.stdout.trim()) {
    return { ok: true, cancelled: false, path: normalizePickedDirPath(zen.stdout) };
  }
  const kd = await runExecFileAsync('kdialog', ['--getexistingdirectory', defaultDir, '--title', promptText], { timeout: 120000 });
  if (kd.ok && kd.stdout.trim()) {
    return { ok: true, cancelled: false, path: normalizePickedDirPath(kd.stdout) };
  }
  if (!zen.ok && !kd.ok && (zen.code !== 1 && kd.code !== 1)) {
    return { ok: false, cancelled: false, path: '', error: (zen.stderr || kd.stderr || zen.error || kd.error || '无法打开文件夹选择对话框').trim() };
  }
  return { ok: true, cancelled: true, path: '' };
}

function isSafeLoopbackUrl(rawUrl) {
  const str = String(rawUrl || '').trim();
  if (!str) return false;
  try {
    const u = new URL(str);
    return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

function normalizeRootUriToPath(uriOrPath) {
  const s = String(uriOrPath || '').trim();
  if (!s) return '';
  if (s.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(s).pathname);
    } catch {
      return s.slice(7);
    }
  }
  return s;
}

function isExistingDirectory(dirPath) {
  if (!dirPath || typeof dirPath !== 'string') return false;
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function normalizePcWebInfo(raw) {
  const empty = {
    available: false,
    running: false,
    host: '127.0.0.1',
    port: null,
    url: '',
    pairingUrl: ''
  };
  if (!raw || typeof raw !== 'object' || raw.ok === false) {
    return empty;
  }
  const running = Boolean(raw.running);
  const safeUrl = isSafeLoopbackUrl(raw.url) ? String(raw.url).trim() : '';
  const rawPairing = isSafeLoopbackUrl(raw.pairingUrl) ? String(raw.pairingUrl).trim() : '';
  const pairingUrl = rawPairing || (running && safeUrl ? safeUrl : '');
  const host = typeof raw.host === 'string' && raw.host.trim() ? raw.host.trim() : '127.0.0.1';
  const port = Number.isInteger(raw.port) && raw.port > 0 && raw.port <= 65535 ? raw.port : null;
  return {
    available: true,
    running: Boolean(running && (pairingUrl || safeUrl)),
    host,
    port,
    url: safeUrl,
    pairingUrl
  };
}

function openLocalBrowserUrl(url) {
  if (!isSafeLoopbackUrl(url)) {
    return { ok: false, error: 'INVALID_PC_WEB_URL' };
  }
  const safeUrl = String(url).trim();
  if (isTestMode()) {
    return { ok: true, opened: false, dryRun: true, url: safeUrl };
  }
  try {
    const spec = process.platform === 'darwin'
      ? { bin: 'open', args: [safeUrl] }
      : (process.platform === 'win32'
        ? { bin: 'cmd', args: ['/c', 'start', '', safeUrl], windowsHide: true }
        : { bin: 'xdg-open', args: [safeUrl] });
    const child = spawn(spec.bin, spec.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: Boolean(spec.windowsHide)
    });
    child.unref();
    return { ok: true, opened: true, dryRun: false, url: safeUrl };
  } catch (err) {
    return { ok: false, error: err?.message || 'OPEN_BROWSER_FAILED' };
  }
}

function isRedundantPlanPreset(item) {
  if (!item) return false;
  const id = String(item.id || '').trim().toLowerCase();
  const prompt = String(item.prompt || '').trim().toLowerCase();
  if (prompt === '/plan') return true;
  if (id === 'plan' && (prompt === '' || prompt === 'plan' || prompt === '/plan')) return true;
  return false;
}

function sanitizePresetItem(item, fallbackCat, idx) {
  if (typeof item === 'string') {
    const text = item.trim();
    if (!text) return null;
    return {
      id: `${fallbackCat}_${idx}`,
      label: text,
      prompt: text,
      category: fallbackCat
    };
  }
  if (!isPlainObject(item)) return null;
  const label = String(item.label ?? item.title ?? item.name ?? '').trim();
  const prompt = String(item.prompt ?? item.text ?? item.content ?? '').trim();
  if (!label && !prompt) return null;
  const id = item.id !== undefined && item.id !== null && String(item.id).trim()
    ? String(item.id).trim()
    : `${fallbackCat}_${idx}`;
  return {
    id,
    label: label || prompt,
    prompt: prompt || label,
    category: String(item.category || item.group || fallbackCat)
  };
}

function isVirtualInterfaceName(name) {
  return /^(?:lo\d*|utun\d*|bridge\d*|docker\d*|veth|br-|virbr|vmnet|vboxnet|awdl|llw|anpi|ap\d*)/i.test(String(name || ''));
}

function normalizeStepEvent(step, idx) {
  const safe = isPlainObject(step) ? step : {};
  const seq = Number.isInteger(safe.stepIndex) ? safe.stepIndex : idx;
  const rawType = typeof safe.type === 'string' && safe.type.trim() ? safe.type.trim() : 'CORTEX_STEP_TYPE_GENERIC';
  const rawStatus = typeof safe.status === 'string' ? safe.status.trim() : '';
  const status = STEP_STATUS_MAP[rawStatus] || STEP_STATUS_MAP[rawStatus.toUpperCase()] || 'pending';
  const spec = STEP_KIND_MAP[rawType];
  if (spec) {
    const rawPayload = isPlainObject(safe[spec.field]) ? safe[spec.field] : {};
    const payload = { ...rawPayload };
    if (spec.kind === 'user' && payload.text === undefined) {
      payload.text = payload.userResponse || (Array.isArray(payload.items)
        ? payload.items.map((it) => (typeof it === 'string' ? it : (it?.text || ''))).filter(Boolean).join('\n')
        : '');
    }
    if (spec.kind === 'thinking_and_text' && payload.text === undefined) {
      payload.text = payload.modifiedResponse ?? payload.response ?? '';
    }
    if (isPlainObject(safe.requestedInteraction) && payload.requestedInteraction === undefined) {
      payload.requestedInteraction = safe.requestedInteraction;
    }
    if (Array.isArray(safe.completedInteractions) && payload.completedInteractions === undefined) {
      payload.completedInteractions = safe.completedInteractions;
    }
    if (isPlainObject(safe.sourceTrajectoryStepInfo) && payload.sourceTrajectoryStepInfo === undefined) {
      payload.sourceTrajectoryStepInfo = safe.sourceTrajectoryStepInfo;
    }
    if (isPlainObject(safe.metadata) && payload.metadata === undefined) {
      payload.metadata = safe.metadata;
    }
    return {
      seq,
      kind: spec.kind,
      status,
      rawType,
      ...(safe.title ? { title: safe.title } : {}),
      payload
    };
  }
  return {
    seq,
    kind: 'tool_generic',
    status,
    rawType,
    ...(safe.title ? { title: safe.title } : {}),
    payload: { ...safe }
  };
}

function normalizeSummary(cascadeId, item) {
  const entry = isPlainObject(item) ? item : {};
  const workspaces = Array.isArray(entry.workspaces) ? entry.workspaces : [];
  const ws0 =
    workspaces.find((ws) => {
      if (!isPlainObject(ws)) return false;
      const u = ws.workspaceFolderAbsoluteUri || ws.workspaceUri || '';
      return Boolean(u) && !isTempBridgeWorkspace(u);
    }) ||
    (isPlainObject(workspaces[0]) ? workspaces[0] : {});
  const rawStatus = entry.status || 'CASCADE_RUN_STATUS_IDLE';
  const upper = String(rawStatus).toUpperCase();
  const needsAttention = Boolean(
    entry.needsAttention || entry.pendingInteraction || upper.includes('PENDING') || upper.includes('WAITING') || upper.includes('ERROR')
  );
  const attentionReason = entry.attentionReason || (upper.includes('ERROR') ? '运行出错' : (needsAttention ? '等待处理' : null));
  return {
    cascadeId,
    title: entry.annotations?.title || entry.title || entry.summary || cascadeId,
    summary: entry.summary || '',
    status: rawStatus,
    needsAttention,
    attentionReason,
    stepCount: Number(entry.stepCount || 0),
    lastModifiedTime: entry.lastModifiedTime || entry.createdTime || null,
    createdTime: entry.createdTime || null,
    workspaceUri: ws0.workspaceFolderAbsoluteUri || ws0.workspaceUri || null,
    gitRootUri: ws0.gitRootAbsoluteUri || ws0.gitRootUri || null,
    repoName: ws0.repository?.computedName || ws0.repository?.name || ws0.repoName || null,
    branchName: ws0.branchName || null,
    workspaces
  };
}

/**
 * Derives the delta cursor for a freshly loaded trajectory: the contiguous terminal prefix is
 * already on screen, so polling resumes right after it, with fingerprints for everything observed.
 */
function buildSeededCursor(events) {
  const fingerprints = new Map();
  for (const ev of events) {
    fingerprints.set(ev.seq, crypto.createHash('sha1').update(JSON.stringify(ev)).digest('hex'));
  }
  let stepOffset = 0;
  for (const ev of events) {
    if (ev.seq !== stepOffset || !TERMINAL_STEP_STATUSES.has(ev.status)) break;
    stepOffset += 1;
  }
  return { stepOffset, fingerprints };
}

function createStandaloneRpcAdapter(rpc) {
  const cursors = new Map();

  function ensureRpc() {
    if (!rpc || typeof rpc.call !== 'function') {
      const err = new Error('RPC_UNAVAILABLE');
      err.statusCode = 503;
      err.code = 'RPC_UNAVAILABLE';
      throw err;
    }
  }

  return {
    async listSessions({ limit = DEFAULT_SESSION_LIMIT } = {}) {
      ensureRpc();
      const resp = await rpc.call('GetAllCascadeTrajectories', {});
      const summaries = isPlainObject(resp?.trajectorySummaries) ? resp.trajectorySummaries : {};
      const sessions = Object.entries(summaries)
        .map(([id, item]) => normalizeSummary(id, item))
        .sort((a, b) => (Date.parse(b.lastModifiedTime || '') || 0) - (Date.parse(a.lastModifiedTime || '') || 0));
      return { ok: true, sessions: sessions.slice(0, Math.max(1, Number(limit) || DEFAULT_SESSION_LIMIT)) };
    },
    async getSessionDetail(cascadeId) {
      ensureRpc();
      const resp = await rpc.call('GetCascadeTrajectory', { cascadeId });
      const trajectory = isPlainObject(resp?.trajectory) ? resp.trajectory : (isPlainObject(resp) ? resp : {});
      const rawSteps = Array.isArray(trajectory.steps) ? trajectory.steps : (Array.isArray(resp?.steps) ? resp.steps : []);
      const events = rawSteps.map((s, idx) => normalizeStepEvent(s, idx));
      // Seed the delta cursor from the detail we just built: the client already rendered the
      // terminal prefix, so the first delta poll must not re-pull the whole trajectory from 0.
      cursors.set(cascadeId, buildSeededCursor(events));
      return {
        ok: true,
        session: {
          cascadeId: trajectory.cascadeId || cascadeId,
          trajectoryId: trajectory.trajectoryId || null,
          status: resp?.status || trajectory.status || 'CASCADE_RUN_STATUS_IDLE',
          numTotalSteps: Number.isFinite(Number(resp?.numTotalSteps)) ? Number(resp.numTotalSteps) : rawSteps.length,
          metadata: trajectory.metadata || null
        },
        events
      };
    },
    async getSessionDelta(cascadeId, { afterSeq } = {}) {
      ensureRpc();
      let cursor = cursors.get(cascadeId);
      if (!cursor) {
        cursor = { stepOffset: 0, fingerprints: new Map() };
        cursors.set(cascadeId, cursor);
      }
      const hasExplicitAfter = afterSeq !== undefined && afterSeq !== null && Number.isInteger(Number(afterSeq));
      const reqOffset = hasExplicitAfter ? Math.max(0, Number(afterSeq) + 1) : cursor.stepOffset;
      const resp = await rpc.call('GetCascadeTrajectorySteps', { cascadeId, stepOffset: reqOffset });
      const rawSteps = Array.isArray(resp?.steps) ? resp.steps : (Array.isArray(resp?.trajectory?.steps) ? resp.trajectory.steps : []);
      const normalized = rawSteps.map((s, i) => normalizeStepEvent(s, Number.isInteger(s?.stepIndex) ? s.stepIndex : reqOffset + i));
      const emitted = [];
      for (const ev of normalized) {
        if (hasExplicitAfter) {
          emitted.push(ev);
          continue;
        }
        const fp = crypto.createHash('sha1').update(JSON.stringify(ev)).digest('hex');
        if (cursor.fingerprints.get(ev.seq) !== fp) {
          cursor.fingerprints.set(ev.seq, fp);
          emitted.push(ev);
        }
      }
      let nextOffset = reqOffset;
      for (const ev of normalized) {
        if (ev.seq !== nextOffset || !TERMINAL_STEP_STATUSES.has(ev.status)) break;
        nextOffset++;
      }
      if (!hasExplicitAfter) cursor.stepOffset = nextOffset;
      const hasNonTerminal = normalized.some((ev) => !TERMINAL_STEP_STATUSES.has(ev.status));
      const status = resp?.status || resp?.trajectory?.status || (hasNonTerminal ? 'CASCADE_RUN_STATUS_RUNNING' : 'CASCADE_RUN_STATUS_IDLE');
      const totalSteps = Number.isFinite(Number(resp?.numTotalSteps))
        ? Number(resp.numTotalSteps)
        : Math.max(reqOffset + normalized.length, nextOffset);
      return {
        ok: true,
        cascadeId,
        status,
        totalSteps,
        stepOffset: hasExplicitAfter ? nextOffset : cursor.stepOffset,
        events: emitted,
        hasChanges: emitted.length > 0
      };
    },
    async createSession({ title, workspaceUri } = {}) {
      ensureRpc();
      const resp = await rpc.call('StartCascade', {
        source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT',
        metadata: { ...DEFAULT_RPC_METADATA }
      });
      return {
        ok: true,
        cascadeId: resp?.cascadeId || '',
        ...(title ? { title } : {}),
        ...(workspaceUri ? { workspaceUri } : {})
      };
    },
    async sendMessage(cascadeId, { text, modelId, mode, images, attachments } = {}) {
      ensureRpc();
      const items = [];
      if (typeof text === 'string' && text.trim()) items.push({ text });
      if (Array.isArray(attachments)) {
        for (const a of attachments) {
          if (typeof a === 'string' && a.trim()) items.push({ text: a });
          else if (isPlainObject(a) && typeof a.text === 'string') items.push({ text: a.text });
        }
      }
      const normImages = [];
      if (Array.isArray(images)) {
        for (const img of images) {
          if (isPlainObject(img) && typeof img.dataUrl === 'string') {
            const m = img.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
            if (m) normImages.push({ mimeType: img.mime || m[1], inlineData: m[2] });
          }
        }
      }
      const params = { cascadeId, items, metadata: { ...DEFAULT_RPC_METADATA } };
      if (normImages.length > 0) params.images = normImages;
      const plannerConfig = {};
      if (typeof modelId === 'string' && modelId.trim()) {
        plannerConfig.requestedModel = { model: modelId.trim() };
      }
      const cleanMode = typeof mode === 'string' ? mode.trim().toLowerCase() : '';
      if (cleanMode === 'plan') {
        plannerConfig.conversational = { plannerMode: 'CONVERSATIONAL_PLANNER_MODE_READ_ONLY', agenticMode: false };
      } else if (cleanMode === 'chat') {
        plannerConfig.conversational = { plannerMode: 'CONVERSATIONAL_PLANNER_MODE_DEFAULT', agenticMode: true };
      }
      if (Object.keys(plannerConfig).length > 0) params.cascadeConfig = { plannerConfig };
      await rpc.call('SendUserCascadeMessage', params);
      return { ok: true, cascadeId };
    },
    async cancelSession(cascadeId) {
      ensureRpc();
      await rpc.call('CancelCascadeInvocation', { cascadeId });
      return { ok: true, cascadeId };
    },
    async approveStep(cascadeId, stepIdx, decision = 'allow', payload = {}) {
      ensureRpc();
      const allow = typeof decision === 'boolean'
        ? decision
        : !['deny', 'reject', 'false', '0', 'cancel'].includes(String(decision || 'allow').trim().toLowerCase());
      const detail = await rpc.call('GetCascadeTrajectory', { cascadeId });
      const trajectory = isPlainObject(detail?.trajectory) ? detail.trajectory : (isPlainObject(detail) ? detail : {});
      const steps = Array.isArray(trajectory.steps) ? trajectory.steps : (Array.isArray(detail?.steps) ? detail.steps : []);
      const step = steps.find((s, i) => (Number.isInteger(s?.stepIndex) ? s.stepIndex : i) === stepIdx) || steps[stepIdx] || null;
      const trajectoryId = step?.sourceTrajectoryStepInfo?.trajectoryId || payload?.trajectoryId || trajectory.trajectoryId || cascadeId;
      const resolvedStepIndex = Number.isInteger(step?.sourceTrajectoryStepInfo?.stepIndex)
        ? step.sourceTrajectoryStepInfo.stepIndex
        : (Number.isInteger(step?.stepIndex) ? step.stepIndex : stepIdx);
      const reqInt = step?.requestedInteraction?.interaction || step?.requestedInteraction || payload?.requestedInteraction || {};

      let interactionType = 'permission';
      let interactionBody = { allow, scope: payload?.scope || 'PERMISSION_SCOPE_ONCE' };
      const matchedConfirm = CONFIRM_INTERACTION_FIELDS.find((f) => reqInt[f] !== undefined);
      if (matchedConfirm) {
        interactionType = matchedConfirm;
        interactionBody = { confirm: allow };
      } else if (reqInt.filePermission !== undefined) {
        interactionType = 'filePermission';
        interactionBody = {
          allow,
          scope: payload?.scope || 'PERMISSION_SCOPE_ONCE',
          absolutePathUri: reqInt.filePermission?.absolutePathUri || payload?.absolutePathUri || ''
        };
      } else if (reqInt.runCommand !== undefined || (reqInt.permission === undefined && step?.type === 'CORTEX_STEP_TYPE_RUN_COMMAND')) {
        interactionType = 'runCommand';
        const cmd = payload?.submittedCommandLine || reqInt.runCommand?.proposedCommandLine || step?.runCommand?.commandLine || '';
        interactionBody = { confirm: allow, ...(cmd ? { proposedCommandLine: cmd, submittedCommandLine: cmd } : {}) };
      }

      await rpc.call('HandleCascadeUserInteraction', {
        cascadeId,
        interaction: { trajectoryId, stepIndex: resolvedStepIndex, [interactionType]: interactionBody }
      });
      return { ok: true, supported: true, cascadeId, stepIndex: resolvedStepIndex, trajectoryId, interactionType };
    },
    async answerQuestion(cascadeId, stepIdx, answers = [], payload = {}) {
      ensureRpc();
      const detail = await rpc.call('GetCascadeTrajectory', { cascadeId });
      const trajectory = isPlainObject(detail?.trajectory) ? detail.trajectory : (isPlainObject(detail) ? detail : {});
      const steps = Array.isArray(trajectory.steps) ? trajectory.steps : (Array.isArray(detail?.steps) ? detail.steps : []);
      const step = steps.find((s, i) => (Number.isInteger(s?.stepIndex) ? s.stepIndex : i) === stepIdx) || steps[stepIdx] || null;
      const trajectoryId = step?.sourceTrajectoryStepInfo?.trajectoryId || payload?.trajectoryId || trajectory.trajectoryId || cascadeId;
      const resolvedStepIndex = Number.isInteger(step?.sourceTrajectoryStepInfo?.stepIndex)
        ? step.sourceTrajectoryStepInfo.stepIndex
        : (Number.isInteger(step?.stepIndex) ? step.stepIndex : stepIdx);
      const stepQs = step?.requestedInteraction?.interaction?.askQuestion?.questions
        || step?.requestedInteraction?.askQuestion?.questions
        || step?.askQuestion?.questions
        || [];
      const ansArr = Array.isArray(answers) ? answers : (isPlainObject(answers) && Array.isArray(answers.responses) ? null : [answers]);
      const responses = ansArr === null
        ? answers.responses
        : Array.from({ length: Math.max(stepQs.length, ansArr.length) }, (_, idx) => {
          const qRaw = stepQs[idx];
          const qObj = isPlainObject(qRaw) ? qRaw : {};
          const aRaw = ansArr.find((a) => isPlainObject(a) && a.index === idx) ?? ansArr[idx];
          const aObj = isPlainObject(aRaw) ? aRaw : {};
          const opts = Array.isArray(qObj.options)
            ? qObj.options.map((o, j) => (typeof o === 'string' ? { id: o, text: o } : { id: String(o?.id || o?.label || o?.text || j), text: String(o?.text || o?.label || o?.id || '') }))
            : [];
          const ansText = typeof aRaw === 'string' ? aRaw : (typeof aObj.answer === 'string' ? aObj.answer : '');
          const matchedOpt = opts.find((o) => o.id === ansText || o.text === ansText);
          return {
            question: String((typeof qRaw === 'string' ? qRaw : qObj.question || qObj.prompt || qObj.text) || aObj.question || `Question ${idx + 1}`),
            options: opts,
            isMultiSelect: Boolean(qObj.isMultiSelect),
            selectedOptionIds: Array.isArray(aObj.selectedOptionIds) ? aObj.selectedOptionIds : (matchedOpt ? [matchedOpt.id] : []),
            writeInResponse: typeof aObj.writeInResponse === 'string' ? aObj.writeInResponse : (matchedOpt ? '' : ansText),
            skipped: Boolean(aObj.skipped)
          };
        });
      await rpc.call('HandleCascadeUserInteraction', {
        cascadeId,
        interaction: {
          trajectoryId,
          stepIndex: resolvedStepIndex,
          askQuestion: { responses, cancelled: Boolean(payload?.cancelled || answers?.cancelled) }
        }
      });
      return { ok: true, supported: true, cascadeId, stepIndex: resolvedStepIndex, trajectoryId, responses };
    },
    async listModels() {
      ensureRpc();
      const [uRes, aRes] = await Promise.allSettled([
        rpc.call('GetUserStatus', { metadata: { ...DEFAULT_RPC_METADATA } }),
        rpc.call('GetAvailableModels', { forceRefresh: false })
      ]);
      if (uRes.status === 'rejected' && aRes.status === 'rejected') {
        throw aRes.reason || uRes.reason;
      }
      const uVal = uRes.status === 'fulfilled' ? (uRes.value?.userStatus || uRes.value || {}) : {};
      const aVal = aRes.status === 'fulfilled' ? (aRes.value?.response || aRes.value || {}) : {};
      const rawDefaultId = String(
        aVal.defaultAgentModelId
        || uVal.cascadeModelConfigData?.defaultOverrideModelConfig?.modelOrAlias?.model
        || ''
      ).trim() || null;
      const byId = new Map();
      const rawModels = aVal.models;
      const entries = Array.isArray(rawModels)
        ? rawModels.map((m) => [m?.model || m?.modelId || m?.id || '', m])
        : (isPlainObject(rawModels) ? Object.entries(rawModels) : []);
      for (const [k, item] of entries) {
        if (!isPlainObject(item)) continue;
        const id = String(item.model || item.modelId || item.id || item.modelOrAlias?.model || k || '').trim();
        if (!id) continue;
        const rawLabel = typeof item.label === 'string' ? item.label.trim() : '';
        const rawShort = typeof item.shortName === 'string' ? item.shortName.trim() : '';
        const rawName = typeof item.displayName === 'string' ? item.displayName.trim() : (typeof item.name === 'string' ? item.name.trim() : '');
        byId.set(id, {
          ...item,
          id,
          model: id,
          label: rawLabel || rawName || rawShort,
          name: rawName || rawLabel || rawShort,
          displayName: rawName || rawLabel || rawShort,
          shortName: rawShort || rawLabel || rawName,
          tagTitle: item.tagTitle || null,
          quotaInfo: item.quotaInfo || null,
          maxTokens: Number.isFinite(Number(item.maxTokens)) ? Number(item.maxTokens) : null,
          supportsImages: Boolean(item.supportsImages),
          disabled: Boolean(item.disabled || item.enabled === false)
        });
      }
      for (const cfg of (uVal.cascadeModelConfigData?.clientModelConfigs || [])) {
        if (!isPlainObject(cfg)) continue;
        const id = String(cfg?.modelOrAlias?.model || cfg?.model || cfg?.modelId || '').trim();
        if (!id) continue;
        const cfgLabel = typeof cfg.label === 'string' ? cfg.label.trim() : '';
        const cfgDisplay = typeof cfg.displayName === 'string' ? cfg.displayName.trim() : '';
        const prev = byId.get(id) || { id, model: id, label: '', name: '', displayName: '', disabled: false };
        byId.set(id, {
          ...prev,
          label: cfgLabel || prev.label || cfgDisplay,
          name: prev.name || cfgDisplay || cfgLabel,
          displayName: prev.displayName || cfgDisplay || cfgLabel,
          shortName: prev.shortName || cfgLabel || cfgDisplay,
          tagTitle: cfg.tagTitle || prev.tagTitle || null,
          quotaInfo: cfg.quotaInfo || prev.quotaInfo || null,
          maxTokens: Number.isFinite(Number(cfg.maxTokens)) ? Number(cfg.maxTokens) : (prev.maxTokens ?? null),
          supportsImages: Boolean(cfg.supportsImages || prev.supportsImages),
          disabled: Boolean(cfg.disabled || cfg.enabled === false || prev.disabled)
        });
      }
      const rawGroups = [
        ...(Array.isArray(aVal.groupedModels) ? aVal.groupedModels : []),
        ...(Array.isArray(aVal.agentModelSorts) ? aVal.agentModelSorts : []),
        ...(Array.isArray(uVal.cascadeModelConfigData?.agentModelSorts) ? uVal.cascadeModelConfigData.agentModelSorts : [])
      ];
      const cleaned = sanitizeModelCatalogResult({
        models: Array.from(byId.values()),
        defaultModelId: rawDefaultId,
        rawGroups
      });
      return {
        ok: true,
        defaultModelId: cleaned.defaultModelId,
        models: cleaned.models,
        modelGroups: cleaned.modelGroups,
        groups: rawGroups
      };
    }
  };
}

function applyManagedSettingsToConfig(config, managed = {}, opts = {}) {
  if (!managed || typeof managed !== 'object') return { tunnelConfigError: '', syncBackPatch: {} };
  const isInit = opts.isInit === true;
  const syncBackPatch = {};

  if (Array.isArray(managed.allowedRoots)) {
    config.allowedRoots = managed.allowedRoots.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim());
  }

  for (const masterKey of ORCHESTRATOR_MASTER_KEYS) {
    const settingKey = ORCHESTRATOR_SETTING_KEY_MAP[masterKey];
    if (typeof managed[settingKey] === 'string' && ORCHESTRATOR_THINKING_LEVELS.includes(managed[settingKey].trim().toLowerCase())) {
      config.orchestratorThinking[masterKey] = managed[settingKey].trim().toLowerCase();
    }
  }
  if (typeof managed.modelSortMode === 'string') {
    config.modelSortMode = normalizeModelSortMode(managed.modelSortMode);
  }
  if (Array.isArray(managed.modelFilterOrder)) {
    config.modelFilterOrder = sanitizeModelFilterOrder(managed.modelFilterOrder);
  }

  // Bidirectional permissionLevel <-> allowRemoteWrite resolution
  const hasPermField = typeof managed.permissionLevel === 'string' && ['L0', 'L1', 'L2'].includes(managed.permissionLevel.trim().toUpperCase());
  const managedPerm = hasPermField ? normalizePermissionLevel(managed.permissionLevel) : null;
  const hasWriteField = typeof managed.allowRemoteWrite === 'boolean';

  if (isInit) {
    if (managedPerm === 'L2') {
      config.permissionLevel = 'L2';
      config.allowRemoteWrite = true;
    } else if (managedPerm === 'L1') {
      config.permissionLevel = 'L1';
      config.allowRemoteWrite = true;
    } else if (hasWriteField && managed.allowRemoteWrite === true) {
      config.permissionLevel = config.permissionLevel === 'L2' ? 'L2' : 'L1';
      config.allowRemoteWrite = true;
      syncBackPatch.permissionLevel = config.permissionLevel;
    } else if (managedPerm === 'L0') {
      config.permissionLevel = 'L0';
      config.allowRemoteWrite = false;
    }
  } else {
    const permChanged = managedPerm !== null && managedPerm !== config.permissionLevel;
    const writeChanged = hasWriteField && managed.allowRemoteWrite !== config.allowRemoteWrite;

    if (permChanged) {
      config.permissionLevel = managedPerm;
      config.allowRemoteWrite = isPermissionAtLeast(managedPerm, 'L1');
      if (hasWriteField && managed.allowRemoteWrite !== config.allowRemoteWrite) {
        syncBackPatch.allowRemoteWrite = config.allowRemoteWrite;
      }
    } else if (writeChanged) {
      config.allowRemoteWrite = managed.allowRemoteWrite;
      config.permissionLevel = config.allowRemoteWrite ? (config.permissionLevel === 'L2' ? 'L2' : 'L1') : 'L0';
      if (managedPerm !== config.permissionLevel) {
        syncBackPatch.permissionLevel = config.permissionLevel;
      }
    }
  }

  const chPatch = {};
  for (const chKey of CHANNEL_KEYS) {
    if (typeof managed[chKey] === 'boolean') {
      chPatch[chKey] = managed[chKey];
    }
  }
  if (Object.keys(chPatch).length > 0) {
    config.channels = normalizeChannelConfig({ ...config.channels, ...chPatch });
  }
  if (managed.tunnelMode === 'quick' || managed.tunnelMode === 'named') {
    config.tunnelMode = managed.tunnelMode;
  }

  let hostnameErr = '';
  let tokenErr = '';

  if (typeof managed.tunnelHostname === 'string') {
    const rawHost = managed.tunnelHostname.trim();
    if (!isInit || rawHost) {
      if (!rawHost) {
        config.tunnelHostname = '';
      } else {
        const hostCheck = validateTunnelHostname(rawHost);
        if (hostCheck.ok) {
          config.tunnelHostname = hostCheck.origin;
        } else {
          hostnameErr = hostCheck.error || 'INVALID_TUNNEL_HOSTNAME';
        }
      }
    }
  }

  if (typeof managed.tunnelToken === 'string') {
    const rawToken = managed.tunnelToken.trim();
    if (!isInit || rawToken) {
      if (!rawToken) {
        config.tunnelToken = '';
      } else {
        const tkCheck = validateCloudflareTunnelToken(rawToken);
        if (tkCheck.ok) {
          config.tunnelToken = tkCheck.token;
        } else {
          tokenErr = tkCheck.error || 'INVALID_TUNNEL_TOKEN';
        }
      }
    }
  }

  const tunnelConfigError = config.tunnelMode === 'named'
    ? (hostnameErr || tokenErr || '')
    : '';
  return { tunnelConfigError, syncBackPatch };
}

async function activate(host) {
  const loaded = host.storage.readJson('remote-config.json', null);
  const existing = (loaded.ok && loaded.data && typeof loaded.data === 'object') ? loaded.data : {};
  const managedInit = host.settings.get() || {};

  let token = (typeof existing.token === 'string' && existing.token.length >= 24)
    ? existing.token
    : '';
  let confirmSecret = (typeof existing.confirmSecret === 'string' && existing.confirmSecret.length >= 24)
    ? existing.confirmSecret
    : '';
  let changed = !loaded.ok || !token || !confirmSecret;
  if (!token) token = generatePairingToken();
  if (!confirmSecret) confirmSecret = generatePairingToken();

  const initialAllowWrite = existing.allowRemoteWrite === true;
  let config = {
    port: Number.isInteger(existing.port) && existing.port > 0 && existing.port < 65536
      ? existing.port
      : DEFAULT_REMOTE_PORT,
    token,
    confirmSecret,
    permissionLevel: normalizePermissionLevel(existing.permissionLevel, initialAllowWrite),
    allowRemoteWrite: initialAllowWrite,
    allowedRoots: Array.isArray(existing.allowedRoots)
      ? existing.allowedRoots.filter((r) => typeof r === 'string' && r.trim())
      : [],
    channels: normalizeChannelConfig(existing.channels || DEFAULT_CHANNELS),
    tunnelMode: existing.tunnelMode === 'named' ? 'named' : 'quick',
    tunnelToken: '',
    tunnelHostname: '',
    remoteDisplay: sanitizeRemoteDisplayConfig(existing.remoteDisplay || DEFAULT_REMOTE_DISPLAY_CONFIG),
    orchestratorThinking: sanitizeOrchestratorThinkingMap(existing.orchestratorThinking),
    modelSortMode: normalizeModelSortMode(existing.modelSortMode),
    modelFilterOrder: sanitizeModelFilterOrder(existing.modelFilterOrder),
    modelUsageCounts: isPlainObject(existing.modelUsageCounts) ? { ...existing.modelUsageCounts } : {},
    updatedAt: existing.updatedAt || new Date().toISOString()
  };

  if (existing.tunnelToken) {
    const tkCheck = validateCloudflareTunnelToken(existing.tunnelToken);
    if (tkCheck.ok) config.tunnelToken = tkCheck.token;
  }
  if (existing.tunnelHostname) {
    const hostCheck = validateTunnelHostname(existing.tunnelHostname);
    if (hostCheck.ok) config.tunnelHostname = hostCheck.origin;
  }

  const initApply = applyManagedSettingsToConfig(config, managedInit, { isInit: true });
  let tunnelConfigError = initApply.tunnelConfigError;

  function persistConfig() {
    config.updatedAt = new Date().toISOString();
    host.storage.writeJson('remote-config.json', config);
  }
  if (changed) persistConfig();

  let syncingSettings = false;
  async function syncManagedSettings(patch = {}) {
    if (!patch || Object.keys(patch).length === 0) return;
    syncingSettings = true;
    try {
      await host.settings.update(patch);
    } finally {
      syncingSettings = false;
    }
  }

  if (Object.keys(initApply.syncBackPatch).length > 0) {
    void syncManagedSettings(initApply.syncBackPatch).catch(() => {});
  }
  if (config.tunnelToken && !String(managedInit.tunnelToken || '').trim()) {
    void syncManagedSettings({ tunnelToken: config.tunnelToken }).catch(() => {});
  }

  const extraPanels = new Map();
  const extraActions = new Map();
  const discoveredSessionRoots = new Set();
  const standaloneRpcAdapter = createStandaloneRpcAdapter(host.rpc);

  let server = null;
  let publishStatus = () => buildStatus();
  let tailscaleHttpsUrl = '';
  let lastTailscaleCheckAt = 0;
  let tailscaleRefreshPromise = null;
  let latestPcWeb = normalizePcWebInfo(null);
  const cloudflared = new CloudflaredManager({
    onStateChange: () => publishStatus()
  });

  function getEffectiveAllowedRoots() {
    if (Array.isArray(config.allowedRoots) && config.allowedRoots.length > 0) {
      return [...config.allowedRoots];
    }
    return Array.from(discoveredSessionRoots);
  }

  const brainDir = process.env.AGY_DADDY_BRAIN_DIR
    ? path.resolve(process.env.AGY_DADDY_BRAIN_DIR)
    : path.join(os.homedir(), '.gemini', 'antigravity', 'brain');

  const webPush = createWebPushManager({
    storage: host.storage,
    isTestMode: isTestMode()
  });

  const mobileWorkspace = createMobileWorkspaceService({
    getAllowedRoots: getEffectiveAllowedRoots,
    brainDir
  });

  const ptyManager = createPtyManager({
    allowedRoots: getEffectiveAllowedRoots,
    idleTimeoutMs: isTestMode() ? 60000 : 600000
  });

  const sessionOrgStore = createSessionOrgStore({
    getAllowedRoots: getEffectiveAllowedRoots
  });

  async function callHarness(method, args = []) {
    if (typeof host?.services?.call === 'function') {
      try {
        const res = await host.services.call('web-harness', method, args, { optional: true });
        if (res && res.ok) {
          return res.value;
        }
        const errMsg = String(res?.error || '');
        const isMissing = res?.unavailable || errMsg.includes('SERVICE_NOT_FOUND') || errMsg.includes('SERVICE_METHOD_NOT_FOUND');
        if (res && !isMissing && res.error) {
          const err = new Error(res.error);
          err.statusCode = res.statusCode || 502;
          throw err;
        }
      } catch (err) {
        const msg = String(err?.message || '');
        if (!msg.includes('SERVICE_NOT_FOUND') && !msg.includes('SERVICE_METHOD_NOT_FOUND') && !msg.includes('unavailable')) {
          throw err;
        }
      }
    }
    if (typeof standaloneRpcAdapter[method] === 'function') {
      return await standaloneRpcAdapter[method](...args);
    }
    const err = new Error(`HARNESS_METHOD_UNSUPPORTED: ${method}`);
    err.statusCode = 501;
    throw err;
  }

  function recordDiscoveredRootsFromSessions(sessions) {
    if (!Array.isArray(sessions)) return;
    for (const s of sessions) {
      for (const rawUri of [s?.workspaceUri, s?.gitRootUri]) {
        const p = normalizeRootUriToPath(rawUri);
        if (p && !isTempBridgeWorkspace(p) && isExistingDirectory(p)) {
          discoveredSessionRoots.add(p);
        }
      }
    }
  }

  async function safeListSessions(opts = {}) {
    const requestedLimit = Number.isFinite(Number(opts.limit)) && Number(opts.limit) > 0
      ? Number(opts.limit)
      : DEFAULT_SESSION_LIMIT;
    const includeSubagents = Boolean(opts.includeSubagents);
    try {
      const res = await callHarness('listSessions', [{ limit: Math.max(requestedLimit, DEFAULT_SESSION_LIMIT), includeSubagents }]);
      const sessions = Array.isArray(res?.sessions) ? res.sessions : [];
      recordDiscoveredRootsFromSessions(sessions);
      const enriched = sessionOrgStore.enrichSessionsAndOrg({
        rpcSessions: sessions,
        allowedRoots: getEffectiveAllowedRoots(),
        includeSubagents,
        limit: requestedLimit
      });
      return {
        ok: true,
        rpcConnected: true,
        offline: false,
        sessions: enriched.sessions,
        groups: enriched.groups,
        projects: enriched.projects,
        pins: enriched.pins
      };
    } catch {
      const enriched = sessionOrgStore.enrichSessionsAndOrg({
        rpcSessions: [],
        allowedRoots: getEffectiveAllowedRoots(),
        includeSubagents,
        limit: requestedLimit
      });
      return {
        ok: true,
        rpcConnected: false,
        offline: true,
        sessions: [],
        groups: enriched.groups,
        projects: enriched.projects,
        pins: enriched.pins
      };
    }
  }

  async function refreshPcWebStatus() {
    try {
      const res = await host.services.call('web-harness', 'getStatus', [], { optional: true });
      if (res?.ok && res.value) {
        latestPcWeb = normalizePcWebInfo(res.value);
      } else {
        latestPcWeb = normalizePcWebInfo(null);
      }
    } catch {
      latestPcWeb = normalizePcWebInfo(null);
    }
    return latestPcWeb;
  }

  function execTailscaleServeStatus(bin) {
    return new Promise((resolve) => {
      execFile(bin, ['serve', 'status', '--json'], { timeout: 2000 }, (err, stdout) => {
        if (err) {
          resolve({ ok: false, code: err.code || '', stdout: '' });
          return;
        }
        resolve({ ok: true, code: '', stdout: String(stdout || '') });
      });
    });
  }

  async function refreshTailscaleServeUrl(force = false) {
    if (isTestMode() || !config.channels.tailscale || !server?.port) return tailscaleHttpsUrl;
    const now = Date.now();
    if (!force && now - lastTailscaleCheckAt < 15000) return tailscaleHttpsUrl;
    if (tailscaleRefreshPromise) return tailscaleRefreshPromise;

    tailscaleRefreshPromise = (async () => {
      lastTailscaleCheckAt = Date.now();
      let res = await execTailscaleServeStatus('tailscale');
      if (!res.ok && process.platform === 'darwin') {
        res = await execTailscaleServeStatus('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
      }
      const nextUrl = res.ok ? parseTailscaleServeHttpsUrl(res.stdout, server.port) : '';
      if (nextUrl !== tailscaleHttpsUrl) {
        tailscaleHttpsUrl = nextUrl;
        publishStatus();
      }
      return tailscaleHttpsUrl;
    })().finally(() => {
      tailscaleRefreshPromise = null;
    });
    return tailscaleRefreshPromise;
  }

  async function safeFetchPanel(serviceName, method = 'getMobileSnapshot') {
    try {
      const res = await host.services.call(serviceName, method, [], { optional: true });
      if (res && res.ok) {
        return { available: true, data: res.value };
      }
      return { available: false, reason: res?.error || 'SERVICE_UNAVAILABLE' };
    } catch (err) {
      return { available: false, reason: err?.message || 'SERVICE_ERROR' };
    }
  }

  async function collectAggregatedSnapshot() {
    const [contextPanel, usagePanel, quotaPanel] = await Promise.all([
      safeFetchPanel('context', 'getMobileSnapshot'),
      safeFetchPanel('usage', 'getMobileSnapshot'),
      safeFetchPanel('quota', 'getMobileSnapshot')
    ]);

    const panels = {
      context: contextPanel,
      usage: usagePanel,
      quota: quotaPanel
    };

    for (const [panelId, def] of extraPanels.entries()) {
      if (def.service) {
        panels[panelId] = await safeFetchPanel(def.service, def.method || 'getMobileSnapshot');
      }
    }

    return {
      ok: true,
      timestamp: Date.now(),
      permissionLevel: config.permissionLevel,
      writeEnabled: config.allowRemoteWrite === true,
      channels: { ...config.channels },
      display: { ...config.remoteDisplay },
      panels,
      actions: Array.from(extraActions.values()).map((a) => ({
        id: a.id,
        title: a.title || a.id,
        requiresWrite: a.requiresWrite !== false
      }))
    };
  }

  const sseBroker = createSseBroker({
    pollIntervalMs: isTestMode() ? 80 : 400,
    activePollIntervalMs: isTestMode() ? 45 : 70,
    metaPollIntervalMs: isTestMode() ? 100 : 1200,
    burstWindowMs: 2500,
    heartbeatIntervalMs: 15000,
    async getDelta(sessionId, _offset) {
      try {
        const res = await callHarness('getSessionDelta', [sessionId, {}]);
        if (!res || typeof res !== 'object') return null;
        const status = res.status || 'CASCADE_RUN_STATUS_IDLE';
        return {
          cascadeId: sessionId,
          sessionId,
          status,
          totalSteps: res.totalSteps,
          events: stripPairingSecrets(res.events || []),
          nextOffset: res.stepOffset,
          stepOffset: res.stepOffset,
          session: {
            cascadeId: sessionId,
            status,
            numTotalSteps: res.totalSteps
          }
        };
      } catch {
        return null;
      }
    },
    async listSessions() {
      const res = await safeListSessions({ limit: DEFAULT_SESSION_LIMIT });
      const normalizeBrokerStatus = (raw) => {
        const up = String(raw || '').trim().toUpperCase();
        if (!up) return 'IDLE';
        if (up.includes('RUNNING') || up.includes('GENERATING')) return 'RUNNING';
        if (up.includes('PENDING') || up.includes('WAITING')) return 'PENDING';
        if (up.includes('ERROR') || up.includes('FAIL')) return 'ERROR';
        if (up.includes('IDLE')) return 'IDLE';
        if (up.includes('DONE')) return 'DONE';
        return up;
      };
      return stripPairingSecrets((res.sessions || []).map((s) => ({
        ...s,
        status: normalizeBrokerStatus(s.status)
      })));
    },
    async getTelemetry() {
      const snap = await collectAggregatedSnapshot();
      return stripPairingSecrets({ panels: snap.panels });
    },
    async dispatchMessage(cascadeId, item) {
      return await callHarness('sendMessage', [cascadeId, item]);
    },
    async onAttentionTransition(payload) {
      if (!payload) return;
      if (payload.needsAttention || payload.status === 'PENDING' || payload.status === 'ERROR' || payload.status === 'DONE') {
        await webPush.sendNotification({
          type: 'attention',
          sessionId: payload.cascadeId,
          title: payload.title || 'Agy-Daddy Remote',
          body: payload.attentionReason || `会话状态变更: ${payload.status}`,
          status: payload.status
        });
      }
    }
  });

  function buildChannelUrls() {
    const localUrl = server?.getLocalUrl() || '';
    const urls = {};
    if (localUrl && config.channels.loopback) {
      urls.loopback = `${localUrl}/?t=${config.token}`;
    }
    const needLan = Boolean(server?.port && config.channels.lan);
    const needTailscale = Boolean(server?.port && config.channels.tailscale);
    if (needTailscale && tailscaleHttpsUrl) {
      urls.tailscale = `${tailscaleHttpsUrl}/?t=${config.token}`;
    }
    if (needLan || needTailscale) {
      const ifaces = os.networkInterfaces();
      let lanPreferred = '';
      let lanSecondary = '';
      let lanFallback = '';
      let tsIpv6Fallback = '';
      for (const [ifName, list] of Object.entries(ifaces)) {
        const isVirtual = isVirtualInterfaceName(ifName);
        const isPhysical = /^(?:en\d+|wlan\d+|eth\d+|wi-fi)$/i.test(ifName);
        for (const info of (list || [])) {
          if (info.internal || !info.address) continue;
          if (info.family === 'IPv4') {
            if (needTailscale && !urls.tailscale && isTailscaleIp(info.address)) {
              urls.tailscale = `http://${info.address}:${server.port}/?t=${config.token}`;
            } else if (needLan && isLanIp(info.address)) {
              const cand = `http://${info.address}:${server.port}/?t=${config.token}`;
              if (isPhysical && !lanPreferred) lanPreferred = cand;
              else if (!isVirtual && !lanSecondary) lanSecondary = cand;
              else if (!lanFallback) lanFallback = cand;
            } else if (needLan && !lanFallback && !isVirtual && !isTailscaleIp(info.address)) {
              lanFallback = `http://${info.address}:${server.port}/?t=${config.token}`;
            }
          } else if (info.family === 'IPv6' && needTailscale && !tsIpv6Fallback && isTailscaleIp(info.address)) {
            tsIpv6Fallback = `http://[${info.address}]:${server.port}/?t=${config.token}`;
          }
        }
      }
      if (needLan) {
        const pickedLan = lanPreferred || lanSecondary || lanFallback;
        if (pickedLan) urls.lan = pickedLan;
      }
      if (needTailscale && !urls.tailscale && tsIpv6Fallback) urls.tailscale = tsIpv6Fallback;
    }
    if (server?.port && config.channels.bonjour) {
      const hostName = os.hostname().replace(/\.local$/i, '');
      urls.bonjour = `http://${hostName}.local:${server.port}/?t=${config.token}`;
    }
    if (config.channels.cloudflare) {
      const cfState = cloudflared.getState();
      const pubUrl = cfState.publicUrl || (config.tunnelMode === 'named' ? config.tunnelHostname : '');
      if (pubUrl) urls.cloudflare = `${pubUrl}/?t=${config.token}`;
    }
    return urls;
  }

  function resolvePrimaryChannel(urls = buildChannelUrls(), channels = config.channels) {
    for (const key of PRIMARY_CHANNEL_ORDER) {
      if (urls[key]) {
        return { primaryChannel: key, primaryUrl: urls[key] };
      }
    }
    for (const key of PRIMARY_CHANNEL_ORDER) {
      if (channels?.[key]) {
        return { primaryChannel: key, primaryUrl: urls.loopback || server?.getLocalUrl() || '' };
      }
    }
    return { primaryChannel: 'offline', primaryUrl: '' };
  }

  function buildStatus() {
    const boundPort = server?.port || null;
    const localUrl = server?.getLocalUrl() || '';
    const tracked = server ? server.getTrackedDevices() : { devices: [], clients: [] };
    const urls = buildChannelUrls();
    const { primaryChannel, primaryUrl } = resolvePrimaryChannel(urls, config.channels);
    return {
      running: Boolean(server && boundPort),
      host: server?.host || '127.0.0.1',
      port: boundPort,
      configuredPort: config.port,
      url: localUrl,
      primaryChannel,
      primaryUrl,
      permissionLevel: config.permissionLevel,
      allowRemoteWrite: config.allowRemoteWrite === true,
      allowedRoots: getEffectiveAllowedRoots(),
      channels: { ...config.channels },
      tunnelMode: config.tunnelMode,
      tunnelHostname: config.tunnelHostname,
      hasTunnelToken: Boolean(config.tunnelToken),
      tunnelConfigError,
      tunnelState: cloudflared.getState(),
      remoteDisplay: { ...config.remoteDisplay },
      devicesCount: tracked.devices.length,
      clientsCount: tracked.clients.length,
      tokenPreview: `${config.token.slice(0, 6)}...${config.token.slice(-4)}`,
      pcWeb: {
        available: latestPcWeb.available,
        running: latestPcWeb.running,
        port: latestPcWeb.port,
        url: latestPcWeb.url
      },
      registeredPanels: Array.from(extraPanels.keys()),
      registeredActions: Array.from(extraActions.keys()),
      updatedAt: Date.now()
    };
  }

  publishStatus = function publishStatusImpl() {
    const st = buildStatus();
    host.state.set('state:remote.status@1', st);
    return st;
  };

  async function handleRemoteAction(body = {}) {
    if (config.allowRemoteWrite !== true) {
      return { ok: false, error: 'REMOTE_WRITE_DISABLED' };
    }
    const actionId = String(body.action || '').trim();
    if (!actionId) {
      return { ok: false, error: 'MISSING_ACTION' };
    }
    if (extraActions.has(actionId)) {
      const def = extraActions.get(actionId);
      const res = await host.services.call(def.service, def.method, [body.payload || {}], { optional: true });
      if (!res?.ok) {
        return { ok: false, action: actionId, error: res?.error || 'ACTION_FAILED' };
      }
      return { ok: true, action: actionId, result: res.value };
    }
    if (actionId === 'compact') {
      const res = await host.services.call('composer', 'triggerCompact', [], { optional: true });
      return { ok: Boolean(res?.ok), action: 'compact', result: res };
    }
    return { ok: false, error: 'UNKNOWN_ACTION', action: actionId };
  }

  function buildLandingChannelEntries(providedToken = '', reqCtx = {}) {
    if (!providedToken) {
      return {
        tunnelMode: config.tunnelMode,
        writeEnabled: config.allowRemoteWrite === true,
        entries: []
      };
    }
    if (config.channels.tailscale && !isTestMode()) {
      void refreshTailscaleServeUrl();
    }
    const urls = buildChannelUrls();
    const specs = [
      { key: 'lan', label: '局域网 (Wi-Fi)', subtitle: '同 Wi-Fi 直连低延迟访问' },
      { key: 'bonjour', label: 'Bonjour (.local)', subtitle: '局域网 mDNS 零 IP 访问' },
      { key: 'tailscale', label: 'Tailscale 私网', subtitle: '加密点对点虚拟私网' },
      { key: 'cloudflare', label: 'Cloudflare Tunnel', subtitle: '公网 HTTPS 穿透（移动网络可用）' },
      { key: 'loopback', label: '本机回环 (127.0.0.1)', subtitle: '当前宿主本机调试入口' }
    ];
    const entries = [];
    for (const sp of specs) {
      if (!config.channels[sp.key]) continue;
      if (sp.key === 'loopback' && reqCtx?.channel === 'cloudflare') continue;
      if (sp.key === 'cloudflare') {
        const cfBaseUrl = String(
          cloudflared.getState().publicUrl ||
          (config.tunnelMode === 'named' ? config.tunnelHostname : '') ||
          ''
        ).replace(/\/+$/, '');
        const cfPub = urls.cloudflare || cfBaseUrl;
        let displayHost = reqCtx?.channel === 'cloudflare'
          ? String(reqCtx?.req?.headers?.host || '').trim()
          : '';
        if (!displayHost && cfPub) {
          try { displayHost = new URL(cfPub).host; } catch {}
        }
        const useAbsCf = reqCtx?.channel !== 'cloudflare' && Boolean(cfBaseUrl);
        entries.push({
          key: 'cloudflare',
          label: sp.label,
          subtitle: sp.subtitle,
          displayHost,
          enterUrl: useAbsCf
            ? `${cfBaseUrl}/?t=${encodeURIComponent(providedToken)}&enter=1`
            : `/?t=${encodeURIComponent(providedToken)}&enter=1`,
          probeUrl: useAbsCf ? `${cfBaseUrl}/api/ping` : '/api/ping',
          fallbackProbeUrl: '',
          httpEntryUrl: '',
          isCurrent: reqCtx?.channel === 'cloudflare'
        });
        continue;
      }
      const rawUrl = urls[sp.key];
      if (!rawUrl) continue;
      try {
        const u = new URL(rawUrl);
        entries.push({
          key: sp.key,
          label: sp.label,
          subtitle: sp.subtitle,
          displayHost: u.host,
          enterUrl: rawUrl,
          probeUrl: `${u.origin}/api/ping`,
          fallbackProbeUrl: `${u.origin}/api/ping-gif`,
          httpEntryUrl: u.protocol === 'http:' ? `${u.origin}/entry?t=${encodeURIComponent(providedToken)}` : '',
          isCurrent: reqCtx?.channel === sp.key
        });
      } catch {}
    }
    return {
      tunnelMode: config.tunnelMode,
      writeEnabled: config.allowRemoteWrite === true,
      entries
    };
  }

  const v1Handlers = {
    async getBootstrap({ channel, permissionLevel }) {
      const [snap, sessionsRes, modelsRes] = await Promise.all([
        collectAggregatedSnapshot(),
        safeListSessions({ limit: DEFAULT_SESSION_LIMIT }),
        callHarness('listModels', []).catch(() => null)
      ]);
      const rootItems = mobileWorkspace.listRoots().roots.map((r) => ({
        uri: `file://${r.path}`,
        path: r.path,
        name: r.name,
        isGitRepo: r.isGitRepo
      }));
      const cleanModels = sanitizeModelCatalogResult({
        models: Array.isArray(modelsRes?.models) ? modelsRes.models : [],
        defaultModelId: modelsRes?.defaultModelId || '',
        rawGroups: Array.isArray(modelsRes?.groups) ? modelsRes.groups : []
      });
      return {
        ok: true,
        channel,
        permissionLevel,
        permissionInfo: {
          level: permissionLevel,
          canRead: true,
          canChat: isPermissionAtLeast(permissionLevel, 'L1'),
          canWriteFsGitPty: isPermissionAtLeast(permissionLevel, 'L2'),
          hostOnlyElevation: true,
          levels: [
            { level: 'L0', label: '只读观察', description: '仅查看会话、文件、Diff 与监控面板' },
            { level: 'L1', label: '对话与审批', description: '可发送消息、队列插队、审批步骤与回答提问' },
            { level: 'L2', label: '工作区与终端', description: '允许文件写入、Git 提交推送与 PTY 终端（需宿主机授权）' }
          ]
        },
        writeEnabled: isPermissionAtLeast(permissionLevel, 'L1'),
        rpcConnected: Boolean(sessionsRes.rpcConnected || modelsRes?.ok),
        models: cleanModels.models,
        modelGroups: cleanModels.modelGroups,
        defaultModelId: cleanModels.defaultModelId || undefined,
        orchestratorThinking: { ...config.orchestratorThinking },
        modelPreferences: {
          sortMode: config.modelSortMode,
          filterOrder: [...config.modelFilterOrder],
          usageCounts: { ...config.modelUsageCounts }
        },
        workspaces: rootItems,
        groups: sessionsRes.groups || [],
        projects: sessionsRes.projects || [],
        pins: sessionsRes.pins || { sessions: [], projects: [], groups: [] },
        vapidPublicKey: webPush.getPublicKey(),
        voiceSupported: false,
        telemetry: { panels: snap.panels, channel }
      };
    },
    async listSessions(opts) {
      return await safeListSessions(opts);
    },
    async getSessionOrg() {
      const res = await safeListSessions({ limit: DEFAULT_SESSION_LIMIT });
      return {
        ok: true,
        groups: res.groups || [],
        projects: res.projects || [],
        pins: res.pins || { sessions: [], projects: [], groups: [] }
      };
    },
    async togglePin(body) {
      return sessionOrgStore.togglePin(body);
    },
    async mutateGroup(body) {
      return sessionOrgStore.mutateGroup(body);
    },
    async createSession(body) {
      return await callHarness('createSession', [body]);
    },
    async getSessionDetail(id) {
      return await callHarness('getSessionDetail', [id]);
    },
    async listQueue(id) {
      return {
        ok: true,
        cascadeId: id,
        queue: sseBroker.listQueue(id)
      };
    },
    async removeQueuedMessage(id, queueId) {
      return sseBroker.removeQueuedMessage(id, queueId);
    },
    async steerQueuedMessage(id, queueId) {
      return await sseBroker.steerQueuedMessage(id, queueId);
    },
    async updateOrchestratorThinking(body = {}) {
      const patch = {};
      if (isPlainObject(body.map)) {
        for (const [k, v] of Object.entries(body.map)) {
          const mk = normalizeOrchestratorMasterKey(k);
          const lvl = normalizeOrchestratorThinkingLevel(v, '');
          if (mk && lvl) {
            config.orchestratorThinking[mk] = lvl;
            patch[ORCHESTRATOR_SETTING_KEY_MAP[mk]] = lvl;
          }
        }
      } else {
        const mk = normalizeOrchestratorMasterKey(body.master);
        const lvl = normalizeOrchestratorThinkingLevel(body.thinkingLevel, '');
        if (!mk || !lvl) {
          return { ok: false, statusCode: 400, error: 'INVALID_ORCHESTRATOR_THINKING_PARAMS' };
        }
        config.orchestratorThinking[mk] = lvl;
        patch[ORCHESTRATOR_SETTING_KEY_MAP[mk]] = lvl;
      }
      persistConfig();
      await syncManagedSettings(patch);
      return {
        ok: true,
        orchestratorThinking: { ...config.orchestratorThinking }
      };
    },
    async sendMessage(id, body) {
      if (typeof body?.modelId === 'string' && body.modelId.trim()) {
        const mid = body.modelId.trim();
        config.modelUsageCounts[mid] = (Number(config.modelUsageCounts[mid]) || 0) + 1;
        if (typeof body?.groupId === 'string' && body.groupId.trim()) {
          const gid = body.groupId.trim();
          config.modelUsageCounts[gid] = (Number(config.modelUsageCounts[gid]) || 0) + 1;
        }
        persistConfig();
      }
      const dispatchMode = String(body?.dispatchMode || 'steer').toLowerCase();
      if (dispatchMode === 'queue') {
        const sessRes = await safeListSessions({ limit: DEFAULT_SESSION_LIMIT });
        const cur = (sessRes.sessions || []).find((s) => s.cascadeId === id);
        const upperSt = String(cur?.status || '').toUpperCase();
        const isRunning = upperSt.includes('RUNNING') || upperSt.includes('GENERATING');
        if (isRunning) {
          const enq = sseBroker.enqueueMessage(id, {
            text: body.text || '',
            modelId: body.modelId,
            mode: body.mode,
            images: body.images,
            dispatchMode: 'queue'
          });
          return { ok: enq.ok, queued: true, queueId: enq.queueId, item: enq.item, queue: enq.queue };
        }
      }
      const res = await callHarness('sendMessage', [id, body]);
      sseBroker.triggerPoll(id);
      return { ...(isPlainObject(res) ? res : { ok: true }), queued: false };
    },
    async cancelSession(id) {
      const res = await callHarness('cancelSession', [id]);
      sseBroker.triggerPoll(id);
      return res;
    },
    async approveStep(id, seq, decision, payload) {
      const res = await callHarness('approveStep', [id, seq, decision, payload]);
      sseBroker.triggerPoll(id);
      return res;
    },
    async answerStep(id, seq, answers, payload) {
      const res = await callHarness('answerQuestion', [id, seq, answers, payload]);
      sseBroker.triggerPoll(id);
      return res;
    },
    async getComposerPresets() {
      const [quickRes, freqRes] = await Promise.all([
        host.services.call('composer-node', 'listQuickPrompts', [], { optional: true }).catch(() => null),
        host.services.call('composer-node', 'listFrequentPrompts', [], { optional: true }).catch(() => null)
      ]);
      const quickList = quickRes?.ok && quickRes.value
        ? [
            ...(Array.isArray(quickRes.value.builtins) ? quickRes.value.builtins.filter((b) => b && b.enabled !== false) : []),
            ...(Array.isArray(quickRes.value.custom) ? quickRes.value.custom : [])
          ]
            .map((it, idx) => sanitizePresetItem(it, 'quick', idx))
            .filter((it) => Boolean(it) && !isRedundantPlanPreset(it))
        : [];
      const freqRaw = freqRes?.ok && freqRes.value
        ? (Array.isArray(freqRes.value.presets) ? freqRes.value.presets : (Array.isArray(freqRes.value.items) ? freqRes.value.items : []))
        : [];
      const freqList = freqRaw
        .map((it, idx) => sanitizePresetItem(it, 'frequent', idx))
        .filter((it) => Boolean(it) && !isRedundantPlanPreset(it));
      return {
        ok: true,
        presets: [...quickList, ...freqList],
        quickPrompts: quickList,
        frequentPrompts: freqList
      };
    },
    async optimizePrompt(text, opts = {}) {
      const res = await host.services.call('composer-node', 'optimizePrompt', [text, opts], { optional: true, timeoutMs: 50000 });
      if (!res?.ok) {
        return { ok: false, statusCode: 503, error: res?.error || 'COMPOSER_UNAVAILABLE' };
      }
      const val = res.value || {};
      if (val.ok === false) return val;
      return {
        ...val,
        ok: true,
        optimizedText: val.optimized || val.optimizedText || val.text || text,
        text: val.optimized || val.optimizedText || val.text || text
      };
    }
  };

  const bindHost = (config.channels.lan || config.channels.tailscale || config.channels.bonjour) ? '0.0.0.0' : '127.0.0.1';
  const listenPort = isTestMode() ? 0 : config.port;
  server = new MobileRemoteServer({
    host: bindHost,
    port: listenPort,
    getToken: () => config.token,
    getConfirmSecret: () => config.confirmSecret,
    getPermissionLevel: () => config.permissionLevel,
    getSnapshot: collectAggregatedSnapshot,
    getChannels: () => config.channels,
    getChannelEntries: buildLandingChannelEntries,
    getTunnelHostname: () => config.tunnelHostname,
    isWriteEnabled: () => config.allowRemoteWrite === true,
    onAction: handleRemoteAction,
    v1Handlers,
    sseBroker,
    ptyManager,
    webPush,
    mobileWorkspace
  });

  if (config.channels.loopback !== false || config.channels.lan === true || config.channels.tailscale === true || config.channels.bonjour === true) {
    await server.start();
  }

  if (config.channels.tailscale && !isTestMode()) {
    void refreshTailscaleServeUrl(true);
  }

  async function reconcileServerBindHost() {
    if (isTestMode() || !server) return;
    const wantHost = (config.channels.lan || config.channels.tailscale || config.channels.bonjour) ? '0.0.0.0' : '127.0.0.1';
    if (server.host === wantHost) return;
    try {
      await server.stop();
      server.host = wantHost;
      await server.start();
      publishStatus();
    } catch {}
  }

  async function syncTunnelWithConfig() {
    if (isTestMode()) return;
    if (!config.channels.cloudflare) {
      await cloudflared.stop();
      return;
    }
    if (!server?.port) return;
    if (config.tunnelMode === 'named') {
      if (!config.tunnelToken) {
        await cloudflared.stop();
        if (!tunnelConfigError) tunnelConfigError = 'MISSING_TUNNEL_TOKEN';
        return;
      }
      await cloudflared.startNamedTunnel(config.tunnelToken, config.tunnelHostname, { dryRun: false });
      return;
    }
    await cloudflared.startQuickTunnel(server.port, { dryRun: false });
  }

  if (config.channels.cloudflare && !isTestMode()) {
    void syncTunnelWithConfig().then(() => { publishStatus(); }).catch(() => {});
  }

  const stopSettingsSub = host.settings.onChange((nextValues) => {
    if (syncingSettings) return;
    const prevCf = config.channels.cloudflare;
    const prevMode = config.tunnelMode;
    const prevHost = config.tunnelHostname;
    const prevTok = config.tunnelToken;
    const applied = applyManagedSettingsToConfig(config, nextValues, { isInit: false });
    tunnelConfigError = applied.tunnelConfigError;
    persistConfig();
    publishStatus();
    if (Object.keys(applied.syncBackPatch).length > 0) {
      void syncManagedSettings(applied.syncBackPatch).catch(() => {});
    }
    if (!isTestMode()) {
      void reconcileServerBindHost();
      if (config.channels.tailscale) {
        void refreshTailscaleServeUrl(true);
      } else if (tailscaleHttpsUrl) {
        tailscaleHttpsUrl = '';
        publishStatus();
      }
    }
    const cfRelevantChanged =
      prevCf !== config.channels.cloudflare ||
      (config.channels.cloudflare && (
        prevMode !== config.tunnelMode ||
        prevHost !== config.tunnelHostname ||
        prevTok !== config.tunnelToken
      ));
    if (cfRelevantChanged && !isTestMode()) {
      void syncTunnelWithConfig().then(() => { publishStatus(); }).catch(() => {});
    }
  });

  const serviceMethods = {
    getStatus() {
      return buildStatus();
    },
    getPairingToken() {
      return config.token;
    },
    getConfirmSecret() {
      return config.confirmSecret;
    },
    getPairingBundle() {
      const urls = buildChannelUrls();
      const { primaryChannel, primaryUrl } = resolvePrimaryChannel(urls, config.channels);
      return {
        ok: true,
        primaryChannel,
        primaryUrl,
        urls,
        qrSvg: primaryUrl ? generateQrSvg(primaryUrl) : '',
        qrAscii: primaryUrl ? generateQrAscii(primaryUrl) : '',
        channels: { ...config.channels },
        permissionLevel: config.permissionLevel,
        tunnelState: cloudflared.getState(),
        pcWeb: {
          available: latestPcWeb.available,
          running: latestPcWeb.running,
          port: latestPcWeb.port,
          url: latestPcWeb.url,
          pairingUrl: latestPcWeb.pairingUrl
        }
      };
    },
    async getPcWebStatus() {
      const info = await refreshPcWebStatus();
      return { ok: true, ...info };
    },
    async openPcWeb() {
      const info = await refreshPcWebStatus();
      const targetUrl = info.pairingUrl || info.url;
      if (!info.running || !isSafeLoopbackUrl(targetUrl)) {
        return { ok: false, error: 'PC_WEB_UNAVAILABLE' };
      }
      return openLocalBrowserUrl(targetUrl);
    },
    getDevices() {
      return server ? server.getTrackedDevices() : { devices: [], clients: [] };
    },
    kickDevices() {
      server?.clearTrackedDevices();
      return serviceMethods.rotateToken();
    },
    async probeChannels() {
      const urls = buildChannelUrls();
      const results = [];
      for (const ch of CHANNEL_KEYS) {
        results.push({
          channel: ch,
          enabled: Boolean(config.channels[ch]),
          url: urls[ch] || null,
          latencyMs: urls[ch] ? 1 : null
        });
      }
      return { ok: true, results };
    },
    async startTunnel(opts = {}) {
      if (!server?.port) return { ok: false, error: 'SERVER_NOT_RUNNING' };
      const mode = opts.mode || config.tunnelMode;
      const dryRun = opts.dryRun !== undefined ? Boolean(opts.dryRun) : isTestMode();
      if (mode === 'named') {
        if (!config.tunnelToken) return { ok: false, error: 'MISSING_TUNNEL_TOKEN' };
        return await cloudflared.startNamedTunnel(config.tunnelToken, config.tunnelHostname, { dryRun });
      }
      return await cloudflared.startQuickTunnel(server.port, { dryRun });
    },
    async stopTunnel() {
      await cloudflared.stop();
      return publishStatus();
    },
    async getSnapshot() {
      return await collectAggregatedSnapshot();
    },
    rotateToken() {
      config.token = generatePairingToken();
      config.confirmSecret = generatePairingToken();
      persistConfig();
      const status = publishStatus();
      return { ok: true, token: config.token, status };
    },
    async setAllowRemoteWrite(enabled) {
      config.allowRemoteWrite = enabled === true;
      config.permissionLevel = config.allowRemoteWrite
        ? (config.permissionLevel === 'L2' ? 'L2' : 'L1')
        : 'L0';
      persistConfig();
      await syncManagedSettings({
        allowRemoteWrite: config.allowRemoteWrite,
        permissionLevel: config.permissionLevel
      });
      const status = publishStatus();
      return { ok: true, allowRemoteWrite: config.allowRemoteWrite, permissionLevel: config.permissionLevel, status };
    },
    async setPermissionLevel(level) {
      config.permissionLevel = normalizePermissionLevel(level);
      config.allowRemoteWrite = isPermissionAtLeast(config.permissionLevel, 'L1');
      persistConfig();
      await syncManagedSettings({
        permissionLevel: config.permissionLevel,
        allowRemoteWrite: config.allowRemoteWrite
      });
      const status = publishStatus();
      return { ok: true, permissionLevel: config.permissionLevel, allowRemoteWrite: config.allowRemoteWrite, status };
    },
    async setChannelConfig(patch = {}) {
      const managedPatch = {};
      if (patch.channels && typeof patch.channels === 'object') {
        config.channels = normalizeChannelConfig({ ...config.channels, ...patch.channels });
        for (const chKey of CHANNEL_KEYS) {
          if (typeof patch.channels[chKey] === 'boolean') {
            managedPatch[chKey] = config.channels[chKey];
          }
        }
      }
      for (const chKey of CHANNEL_KEYS) {
        if (typeof patch[chKey] === 'boolean') {
          config.channels[chKey] = patch[chKey];
          managedPatch[chKey] = patch[chKey];
        }
      }
      if (patch.tunnelMode === 'quick' || patch.tunnelMode === 'named') {
        config.tunnelMode = patch.tunnelMode;
        managedPatch.tunnelMode = patch.tunnelMode;
      }
      if (typeof patch.permissionLevel === 'string') {
        config.permissionLevel = normalizePermissionLevel(patch.permissionLevel);
        config.allowRemoteWrite = isPermissionAtLeast(config.permissionLevel, 'L1');
        managedPatch.permissionLevel = config.permissionLevel;
        managedPatch.allowRemoteWrite = config.allowRemoteWrite;
      } else if (typeof patch.allowRemoteWrite === 'boolean') {
        config.allowRemoteWrite = patch.allowRemoteWrite;
        config.permissionLevel = config.allowRemoteWrite ? (config.permissionLevel === 'L2' ? 'L2' : 'L1') : 'L0';
        managedPatch.allowRemoteWrite = config.allowRemoteWrite;
        managedPatch.permissionLevel = config.permissionLevel;
      }
      if (Array.isArray(patch.allowedRoots)) {
        config.allowedRoots = patch.allowedRoots.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim());
        managedPatch.allowedRoots = config.allowedRoots;
      }
      if (typeof patch.tunnelToken === 'string') {
        if (!patch.tunnelToken.trim()) {
          config.tunnelToken = '';
          managedPatch.tunnelToken = '';
        } else {
          const check = validateCloudflareTunnelToken(patch.tunnelToken);
          if (!check.ok) return { ok: false, error: check.error };
          config.tunnelToken = check.token;
          managedPatch.tunnelToken = check.token;
        }
      }
      if (typeof patch.tunnelHostname === 'string') {
        if (!patch.tunnelHostname.trim()) {
          config.tunnelHostname = '';
          managedPatch.tunnelHostname = '';
        } else {
          const check = validateTunnelHostname(patch.tunnelHostname);
          if (!check.ok) return { ok: false, error: check.error };
          config.tunnelHostname = check.origin;
          managedPatch.tunnelHostname = check.origin;
        }
      }
      tunnelConfigError = '';
      if (patch.remoteDisplay && typeof patch.remoteDisplay === 'object') {
        config.remoteDisplay = sanitizeRemoteDisplayConfig({ ...config.remoteDisplay, ...patch.remoteDisplay });
      }
      persistConfig();
      await syncManagedSettings(managedPatch);
      const status = publishStatus();
      return { ok: true, status };
    },
    registerPanel(def = {}) {
      const id = String(def.id || '').trim();
      const service = String(def.service || '').trim();
      if (!id || !service) return { ok: false, error: 'INVALID_PANEL_DEF' };
      extraPanels.set(id, { id, service, method: String(def.method || 'getMobileSnapshot') });
      publishStatus();
      return { ok: true, id };
    },
    unregisterPanel(id) {
      const removed = extraPanels.delete(String(id || '').trim());
      if (removed) publishStatus();
      return { ok: removed };
    },
    listPanels() {
      return ['context', 'usage', 'quota', ...Array.from(extraPanels.keys())];
    },
    registerAction(def = {}) {
      const id = String(def.id || '').trim();
      const service = String(def.service || '').trim();
      const method = String(def.method || '').trim();
      if (!id || !service || !method) return { ok: false, error: 'INVALID_ACTION_DEF' };
      extraActions.set(id, { id, title: def.title || id, requiresWrite: def.requiresWrite !== false, service, method });
      publishStatus();
      return { ok: true, id };
    },
    unregisterAction(id) {
      const removed = extraActions.delete(String(id || '').trim());
      if (removed) publishStatus();
      return { ok: removed };
    },
    listActions() {
      return Array.from(extraActions.keys());
    },
    emitSseEvent(eventName, data, opts = {}) {
      return sseBroker.emit(eventName, stripPairingSecrets(data), opts);
    },
    async browseAllowedRoot(opts = {}) {
      const valueRoots = Array.isArray(opts?.values?.allowedRoots) ? opts.values.allowedRoots : [];
      const currentRoots = valueRoots.length > 0
        ? valueRoots
        : (Array.isArray(config.allowedRoots) ? config.allowedRoots : []);
      const lastRoot = currentRoots.length > 0 ? String(currentRoots[currentRoots.length - 1] || '').trim() : '';
      let defaultDir = typeof opts.defaultDir === 'string' && opts.defaultDir.trim()
        ? opts.defaultDir.trim()
        : '';
      if (!defaultDir && lastRoot) {
        defaultDir = fs.existsSync(lastRoot) ? lastRoot : path.dirname(lastRoot);
      }
      return openAllowedRootDirectoryDialog({
        defaultDir: defaultDir || os.homedir(),
        title: opts.title || '选择允许访问的工作区根目录',
        dirPickerFn: opts.dirPickerFn
      });
    },
    async listModelsForSettings() {
      const modelsRes = await callHarness('listModels', []).catch(() => null);
      const cleanModels = sanitizeModelCatalogResult({
        models: Array.isArray(modelsRes?.models) ? modelsRes.models : [],
        defaultModelId: modelsRes?.defaultModelId || '',
        rawGroups: Array.isArray(modelsRes?.groups) ? modelsRes.groups : []
      });
      const items = [];
      for (const g of cleanModels.modelGroups) {
        const label = g.isOrchestrator ? '编排模型 (Orchestrator)' : g.label;
        const category = g.isOrchestrator ? 'orchestrator' : inferModelProviderCategory(`${g.label} ${g.defaultModelId || ''}`);
        const freq = (g.modelIds || []).reduce(
          (acc, mid) => acc + (Number(config.modelUsageCounts[mid]) || 0),
          Number(config.modelUsageCounts[g.id]) || 0
        );
        items.push({
          id: g.id,
          label,
          category,
          description: g.isOrchestrator
            ? '支持 Carbon / Argon / Neon / Opus 5.5 主控编排'
            : (g.variants?.length > 1 ? `${g.variants.length} 档思考等级` : '单模型'),
          frequency: freq
        });
      }
      if (items.length === 0) {
        items.push(
          { id: 'family:gemini-4-neon', label: 'Gemini 4 Neon', category: 'gemini', description: 'Gemini 旗舰推理模型', frequency: Number(config.modelUsageCounts['family:gemini-4-neon']) || 0 },
          { id: 'family:claude-opus-5-5', label: 'Claude Opus 5.5', category: 'claude', description: 'Claude 高阶推理模型', frequency: Number(config.modelUsageCounts['family:claude-opus-5-5']) || 0 },
          { id: 'orchestrator', label: '编排模型 (Orchestrator)', category: 'orchestrator', description: '支持 Carbon / Argon / Neon / Opus 5.5 主控编排', frequency: Number(config.modelUsageCounts.orchestrator) || 0 }
        );
      }
      return { ok: true, items };
    },
    async stopServer() {
      sseBroker.dispose();
      ptyManager.disposeAll();
      await cloudflared.stop();
      await server.stop();
      return publishStatus();
    }
  };

  await refreshPcWebStatus();
  publishStatus();

  const stopWebStateSub = host.state?.subscribe?.('state:web.status@1', () => {
    void refreshPcWebStatus().then(() => publishStatus()).catch(() => {});
  });

  const stopSvc = host.services.provide('remote', serviceMethods, { realm: 'node', version: '1.0.0' });
  const stopStatusRoute = await host.bridge.registerRoute('/status', async () => {
    await refreshPcWebStatus();
    return serviceMethods.getStatus();
  });
  const stopSnapshotRoute = await host.bridge.registerRoute('/snapshot', async () => await serviceMethods.getSnapshot());
  const stopPairingRoute = await host.bridge.registerRoute('/pairing', async () => {
    await refreshPcWebStatus();
    return serviceMethods.getPairingBundle();
  });
  const stopOpenPcWebRoute = await host.bridge.registerRoute('/open-pc-web', async () => await serviceMethods.openPcWeb());
  const stopDevicesRoute = await host.bridge.registerRoute('/devices', async (body) => {
    if (body?.action === 'kick') return serviceMethods.kickDevices();
    return serviceMethods.getDevices();
  });
  const stopRotateRoute = await host.bridge.registerRoute('/rotate-token', async () => serviceMethods.rotateToken());
  const stopChannelRoute = await host.bridge.registerRoute('/channel', async (body) => await serviceMethods.setChannelConfig(body || {}));
  const stopActionsRoute = await host.bridge.registerRoute('/actions', async () => ({
    ok: true,
    permissionLevel: config.permissionLevel,
    allowRemoteWrite: config.allowRemoteWrite === true,
    actions: serviceMethods.listActions()
  }));

  const stopRotateCmd = host.commands.register('remote.rotate-token', async () => {
    const res = serviceMethods.rotateToken();
    return {
      ...res,
      message: `新令牌已生效 (${res.status?.tokenPreview || ''})`
    };
  });

  const stopStatusCmd = host.commands.register('remote.status', async () => {
    const st = serviceMethods.getStatus();
    const channelLabel = CHANNEL_DISPLAY_NAMES[st.primaryChannel] || st.primaryChannel || '离线';
    const errPart = st.tunnelConfigError ? ` · 隧道提示: ${st.tunnelConfigError}` : '';
    return {
      ...st,
      message: `${st.running ? '监听中' : '未启动'}${st.port ? ` :${st.port}` : ''} · 通道:${channelLabel} · ${st.devicesCount}台设备 · ${st.permissionLevel} (${st.allowRemoteWrite ? '可写' : '只读'}) · 令牌:${st.tokenPreview}${errPart}`
    };
  });

  const stopKickCmd = host.commands.register('remote.kick-devices', async () => {
    const res = serviceMethods.kickDevices();
    return {
      ...res,
      message: `已断开全部设备并轮换令牌 (${res.status?.tokenPreview || ''})`
    };
  });

  const stopCheckCfCmd = host.commands.register('remote.check-cloudflared', async () => {
    const bin = detectCloudflaredBinary();
    const hints = getCloudflaredInstallHints();
    if (bin.found) {
      return {
        ok: true,
        found: true,
        path: bin.path,
        message: `已检测到 cloudflared：${bin.path}`
      };
    }
    const platformLabel = process.platform === 'darwin'
      ? 'macOS (Homebrew)'
      : (process.platform === 'win32' ? 'Windows (winget)' : 'Linux');
    const installCmd = process.platform === 'darwin'
      ? hints.darwin
      : (process.platform === 'win32' ? hints.win32 : hints.linux);
    return {
      ok: true,
      found: false,
      error: 'CLOUDFLARED_NOT_INSTALLED',
      title: '未检测到 cloudflared 程序',
      message: '启用 Cloudflare Tunnel 需要先在本机安装 cloudflared。请选中或一键复制下方命令在终端运行安装，完成后点击「重新检测」：',
      commands: [
        { label: platformLabel, command: installCmd }
      ],
      links: [
        { label: '查看官方下载文档', url: hints.docsUrl },
        { label: '前往 Cloudflare 控制台 · 零信任隧道', url: 'https://one.dash.cloudflare.com/?to=/:account/networks/tunnels' }
      ]
    };
  });

  const stopBrowseRootCmd = host.commands.register('remote.browse-allowed-root', async (opts = {}) => {
    return serviceMethods.browseAllowedRoot(opts || {});
  });

  const stopListModelsCmd = host.commands.register('remote.list-models', async () => {
    return serviceMethods.listModelsForSettings();
  });

  disposers.push(
    stopSettingsSub,
    stopWebStateSub,
    () => { sseBroker.dispose(); },
    () => { ptyManager.disposeAll(); },
    async () => { await cloudflared.stop(); },
    async () => { await server.stop(); },
    stopSvc,
    stopStatusRoute,
    stopSnapshotRoute,
    stopPairingRoute,
    stopOpenPcWebRoute,
    stopDevicesRoute,
    stopRotateRoute,
    stopChannelRoute,
    stopActionsRoute,
    stopRotateCmd,
    stopStatusCmd,
    stopKickCmd,
    stopCheckCfCmd,
    stopBrowseRootCmd,
    stopListModelsCmd
  );
}

async function deactivate() {
  for (const fn of disposers) {
    try {
      if (typeof fn === 'function') await fn();
    } catch {}
  }
  disposers = [];
}

module.exports = {
  activate,
  deactivate
};
