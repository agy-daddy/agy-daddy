'use strict';

const PLUGIN_ID = 'agy-daddy.viewer';
const SERVICE_NODE_NAME = 'viewer-node';
const STATE_GATEWAY_KEY = 'state:viewer.gateway@1';
const EVENT_VIEWER_MODE_CHANGED = 'viewer:viewer-mode-changed@1';
const EVENT_DIFF_OPENED = 'viewer:diff-opened@1';

const LOOPBACK_HOST = '127.0.0.1';
const TOKEN_HEADER = 'x-viewer-token';
const TOKEN_HEADER_CANONICAL = 'X-Viewer-Token';

const DEFAULT_GATEWAY_PORT = 18770;
const TICKET_TTL_MS = 5 * 60 * 1000;
const TICKET_HARD_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_ACTIVE_TICKETS = 64;

const CSV_CHECKPOINT_STRIDE = 256;
const CSV_SCAN_CHUNK_BYTES = 1024 * 1024;
const CSV_CELL_PREVIEW_MAX_CHARS = 4096;
const CSV_CELL_FULL_MAX_CHARS = 256 * 1024;
const CSV_INSPECT_SAMPLE_BYTES = 64 * 1024;
const CSV_DEFAULT_CHUNK_SIZE = 200;
const CSV_MAX_CHUNK_SIZE = 2000;

const SVG_MAX_BYTES = 20 * 1024 * 1024;
const SVG_SOURCE_FULL_MAX_BYTES = 2 * 1024 * 1024;
const SVG_SOURCE_TRUNCATE_BYTES = 262144;

const MARKERS_MAX_PER_FILE = 500;
const MARKERS_MAX_FILES = 200;
const MARKERS_STORAGE_FILE = 'markers.json';
const MARKER_TONES = Object.freeze(['neutral', 'info', 'warn', 'danger']);

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  officialFirstDeferral: true,
  showHeaderSwitchButton: true,
  allowedRoots: [],
  enableMediaViewer: true,
  mediaThresholdMB: 5,
  mediaDefaultFps: '30',
  mediaWaveformMaxMB: 100,
  enableCsvViewer: true,
  csvThresholdMB: 1,
  csvThresholdLines: 2000,
  csvChunkSize: 200,
  csvFirstRowHeader: true,
  enableSvgViewer: true,
  svgTakeoverMode: 'threshold',
  svgThresholdKB: 64,
  svgDefaultBackground: 'checkerboard',
  enableFontViewer: true,
  fontAutoTakeover: true,
  fontMaxSizeMB: 50,
  fontSampleText: '',
  enableGitDiff: true,
  diffDefaultScope: 'head',
  diffDefaultLayout: 'unified',
  diffShowWordHighlight: true,
  diffContextLines: 3,
  diffMaxFileSizeMB: 2,
  diffMaxLines: 5000,
  gatewayPortMode: 'auto',
  gatewayPort: DEFAULT_GATEWAY_PORT
});

const MEDIA_EXT_MIME = Object.freeze({
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
  '.opus': 'audio/opus'
});

const CSV_EXT_MIME = Object.freeze({
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8'
});

const SVG_EXT_MIME = Object.freeze({
  '.svg': 'image/svg+xml; charset=utf-8'
});

const FONT_EXT_MIME = Object.freeze({
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff'
});

const ERROR_CODES = Object.freeze({
  INVALID_PATH: 'INVALID_PATH',
  UNC_PATH_BLOCKED: 'UNC_PATH_BLOCKED',
  SENSITIVE_PATH_BLOCKED: 'SENSITIVE_PATH_BLOCKED',
  PATH_OUT_OF_BOUNDS: 'PATH_OUT_OF_BOUNDS',
  SYMLINK_ESCAPE: 'SYMLINK_ESCAPE',
  NOT_A_REGULAR_FILE: 'NOT_A_REGULAR_FILE',
  UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
  NON_LOOPBACK_SOCKET: 'NON_LOOPBACK_SOCKET',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  INVALID_HOST_HEADER: 'INVALID_HOST_HEADER',
  FORBIDDEN_ORIGIN: 'FORBIDDEN_ORIGIN',
  CROSS_SITE_NO_CORS_BLOCKED: 'CROSS_SITE_NO_CORS_BLOCKED',
  FORBIDDEN_REFERER: 'FORBIDDEN_REFERER',
  INVALID_OR_EXPIRED_TICKET: 'INVALID_OR_EXPIRED_TICKET',
  RANGE_NOT_SATISFIABLE: 'RANGE_NOT_SATISFIABLE',
  INVALID_REGEX: 'INVALID_REGEX',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  SVG_TOO_LARGE: 'SVG_TOO_LARGE',
  FONT_TOO_LARGE: 'FONT_TOO_LARGE',
  GATEWAY_DISABLED: 'GATEWAY_DISABLED',
  NOT_FOUND: 'NOT_FOUND',
  NOT_A_GIT_REPO: 'NOT_A_GIT_REPO',
  INVALID_GIT_ARG: 'INVALID_GIT_ARG',
  GIT_WRITE_FORBIDDEN: 'GIT_WRITE_FORBIDDEN',
  GIT_TIMEOUT: 'GIT_TIMEOUT',
  GIT_EXEC_FAILED: 'GIT_EXEC_FAILED'
});

const SAFE_ERROR_MESSAGES = Object.freeze({
  [ERROR_CODES.INVALID_PATH]: '无效的文件路径格式',
  [ERROR_CODES.UNC_PATH_BLOCKED]: '出于本地安全隔离策略，已拦截 UNC 或远程网络路径访问请求',
  [ERROR_CODES.SENSITIVE_PATH_BLOCKED]: '出于本地安全隔离策略，已拦截系统或敏感凭据目录访问请求',
  [ERROR_CODES.PATH_OUT_OF_BOUNDS]: '出于本地安全隔离策略，已拦截越界或非授权工作区路径访问请求',
  [ERROR_CODES.SYMLINK_ESCAPE]: '出于本地安全隔离策略，已拦截指向授权工作区外部或失效的符号链接',
  [ERROR_CODES.NOT_A_REGULAR_FILE]: '目标路径不是可读普通文件',
  [ERROR_CODES.UNSUPPORTED_FORMAT]: '当前文件格式暂不支持此检视或流式操作',
  [ERROR_CODES.NON_LOOPBACK_SOCKET]: '仅允许本地回环地址 127.0.0.1 访问',
  [ERROR_CODES.METHOD_NOT_ALLOWED]: '本地只读网关仅允许 GET / HEAD / OPTIONS 请求',
  [ERROR_CODES.INVALID_HOST_HEADER]: '非法 Host 请求头',
  [ERROR_CODES.FORBIDDEN_ORIGIN]: '非法或未授权的 Origin 来源',
  [ERROR_CODES.CROSS_SITE_NO_CORS_BLOCKED]: '已拦截跨站无 Origin 探测请求',
  [ERROR_CODES.FORBIDDEN_REFERER]: '非法 Referer 来源',
  [ERROR_CODES.INVALID_OR_EXPIRED_TICKET]: '能力票据无效、已吊销或已过期',
  [ERROR_CODES.RANGE_NOT_SATISFIABLE]: '请求的字节范围越界或格式不合法',
  [ERROR_CODES.INVALID_REGEX]: '正则表达式语法无效',
  [ERROR_CODES.INVALID_ARGUMENT]: '请求参数无效',
  [ERROR_CODES.SVG_TOO_LARGE]: 'SVG 文件体积超过 20 MB 安全上限',
  [ERROR_CODES.FONT_TOO_LARGE]: '字体文件体积超过安全上限',
  [ERROR_CODES.GATEWAY_DISABLED]: '本地流式检视网关未启用',
  [ERROR_CODES.NOT_FOUND]: '请求的端点或资源不存在',
  [ERROR_CODES.INVALID_GIT_ARG]: 'Git 只读请求参数不合法',
  [ERROR_CODES.GIT_WRITE_FORBIDDEN]: 'Git 服务严格只读，禁止执行写操作子命令',
  [ERROR_CODES.GIT_TIMEOUT]: 'Git 只读命令执行超时',
  [ERROR_CODES.GIT_EXEC_FAILED]: 'Git 只读命令执行失败'
});

const TRUSTED_ORIGIN_REGEXES = Object.freeze([
  /^https?:\/\/127\.0\.0\.1:\d+$/,
  /^vscode-file:\/\/vscode-app$/,
  /^vscode-webview:\/\/[a-z0-9-]+$/i
]);

function classifyExtension(ext) {
  const lower = String(ext || '').toLowerCase();
  if (Object.prototype.hasOwnProperty.call(MEDIA_EXT_MIME, lower)) {
    return { category: 'media', mimeType: MEDIA_EXT_MIME[lower] };
  }
  if (Object.prototype.hasOwnProperty.call(CSV_EXT_MIME, lower)) {
    return { category: 'csv', mimeType: CSV_EXT_MIME[lower] };
  }
  if (Object.prototype.hasOwnProperty.call(SVG_EXT_MIME, lower)) {
    return { category: 'svg', mimeType: SVG_EXT_MIME[lower] };
  }
  if (Object.prototype.hasOwnProperty.call(FONT_EXT_MIME, lower)) {
    return { category: 'font', mimeType: FONT_EXT_MIME[lower] };
  }
  return { category: 'other', mimeType: 'application/octet-stream' };
}

function isTrustedOrigin(origin, allowEmptyInTest = false) {
  const val = String(origin || '').trim();
  if (!val) return Boolean(allowEmptyInTest);
  if (val.toLowerCase() === 'null') return false;
  return TRUSTED_ORIGIN_REGEXES.some((re) => re.test(val));
}

function safeErrorPayload(errorCode, customMessage = null) {
  return {
    ok: false,
    errorCode,
    message: customMessage || SAFE_ERROR_MESSAGES[errorCode] || '操作未通过本地安全策略校验'
  };
}

module.exports = {
  PLUGIN_ID,
  SERVICE_NODE_NAME,
  STATE_GATEWAY_KEY,
  EVENT_VIEWER_MODE_CHANGED,
  EVENT_DIFF_OPENED,
  LOOPBACK_HOST,
  TOKEN_HEADER,
  TOKEN_HEADER_CANONICAL,
  DEFAULT_GATEWAY_PORT,
  TICKET_TTL_MS,
  TICKET_HARD_TTL_MS,
  MAX_ACTIVE_TICKETS,
  CSV_CHECKPOINT_STRIDE,
  CSV_SCAN_CHUNK_BYTES,
  CSV_CELL_PREVIEW_MAX_CHARS,
  CSV_CELL_FULL_MAX_CHARS,
  CSV_INSPECT_SAMPLE_BYTES,
  CSV_DEFAULT_CHUNK_SIZE,
  CSV_MAX_CHUNK_SIZE,
  SVG_MAX_BYTES,
  SVG_SOURCE_FULL_MAX_BYTES,
  SVG_SOURCE_TRUNCATE_BYTES,
  MARKERS_MAX_PER_FILE,
  MARKERS_MAX_FILES,
  MARKERS_STORAGE_FILE,
  MARKER_TONES,
  DEFAULT_SETTINGS,
  MEDIA_EXT_MIME,
  CSV_EXT_MIME,
  SVG_EXT_MIME,
  FONT_EXT_MIME,
  ERROR_CODES,
  SAFE_ERROR_MESSAGES,
  TRUSTED_ORIGIN_REGEXES,
  classifyExtension,
  isTrustedOrigin,
  safeErrorPayload
};
