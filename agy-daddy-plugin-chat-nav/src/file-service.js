'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_INLINE_FILE_BYTES = 2 * 1024 * 1024;

const BLOCKED_PATH_PREFIXES = Object.freeze([
  '/System',
  '/usr',
  '/bin',
  '/sbin',
  '/etc',
  '/var',
  '/private/etc',
  '/Applications/Antigravity.app'
]);

const SENSITIVE_PATH_REGEX = /\/(?:\.ssh|\.gnupg|\.aws|1Password)\//i;

function normalizeFilePathInput(rawPathOrUri) {
  const s = String(rawPathOrUri || '').trim();
  if (!s || s.includes('\0')) return null;

  let decoded = s;
  if (/^file:\/\//i.test(s)) {
    try {
      decoded = decodeURIComponent(new URL(s).pathname);
    } catch {
      return null;
    }
  }
  if (!path.isAbsolute(decoded)) return null;
  return path.resolve(decoded);
}

const ALLOWED_VAR_TEMP_PREFIXES = ['/var/folders/', '/private/var/folders/'];

function resolveSafeEditablePath(rawPathOrUri) {
  const resolved = normalizeFilePathInput(rawPathOrUri);
  if (!resolved) return null;
  const isMacUserTemp = ALLOWED_VAR_TEMP_PREFIXES.some((p) => resolved.startsWith(p));
  for (const prefix of BLOCKED_PATH_PREFIXES) {
    if (isMacUserTemp && prefix === '/var') continue;
    if (resolved === prefix || resolved.startsWith(prefix + '/')) {
      return null;
    }
  }
  if (SENSITIVE_PATH_REGEX.test(resolved)) {
    return null;
  }
  return resolved;
}

function readFileSafe(rawPathOrUri, options = {}) {
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : MAX_INLINE_FILE_BYTES;
  const normalized = normalizeFilePathInput(rawPathOrUri);
  if (!normalized) {
    return { ok: false, error: '无效的文件路径（必须为绝对路径或 file:// URI）' };
  }
  const resolved = resolveSafeEditablePath(normalized);
  if (!resolved) {
    return { ok: false, error: '禁止访问受保护的系统或敏感凭据目录', path: normalized };
  }
  if (!fs.existsSync(resolved)) {
    return { ok: false, error: '文件不存在', path: resolved };
  }
  const st = fs.statSync(resolved);
  if (!st.isFile()) {
    return { ok: false, error: '目标不是普通文件', path: resolved };
  }
  if (st.size > maxBytes) {
    return { ok: false, error: `文件过大 (${st.size} bytes > ${maxBytes})`, path: resolved };
  }
  const content = fs.readFileSync(resolved, 'utf8');
  return { ok: true, path: resolved, size: st.size, content };
}

function writeFileSafe(rawPathOrUri, content, options = {}) {
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : MAX_INLINE_FILE_BYTES;
  const normalized = normalizeFilePathInput(rawPathOrUri);
  if (!normalized) {
    return { ok: false, error: '无效的文件路径（必须为绝对路径或 file:// URI）' };
  }
  const resolved = resolveSafeEditablePath(normalized);
  if (!resolved) {
    return { ok: false, error: '禁止写入受保护的系统或敏感凭据目录', path: normalized };
  }
  const text = String(content ?? '');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maxBytes) {
    return { ok: false, error: `写入内容超限 (${bytes} bytes > ${maxBytes})`, path: resolved };
  }

  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const tmpPath = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmpPath, text, 'utf8');
    fs.renameSync(tmpPath, resolved);
    return { ok: true, path: resolved, bytesWritten: bytes };
  } catch (err) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
    return { ok: false, error: err?.message || '写入失败', path: resolved };
  }
}

module.exports = {
  MAX_INLINE_FILE_BYTES,
  BLOCKED_PATH_PREFIXES,
  SENSITIVE_PATH_REGEX,
  normalizeFilePathInput,
  resolveSafeEditablePath,
  readFileSafe,
  writeFileSafe
};
