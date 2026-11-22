'use strict';

/**
 * 零依赖 SemVer 2.0 解析与区间匹配工具
 */
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseSemver(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const m = trimmed.match(SEMVER_RE);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  return {
    major,
    minor,
    patch,
    prerelease: m[4] ? m[4].split('.') : [],
    raw: trimmed
  };
}

function comparePrerelease(aParts, bParts) {
  const aLen = aParts.length;
  const bLen = bParts.length;
  if (aLen === 0 && bLen === 0) return 0;
  if (aLen === 0) return 1;
  if (bLen === 0) return -1;
  const len = Math.max(aLen, bLen);
  for (let i = 0; i < len; i++) {
    if (i >= aLen) return -1;
    if (i >= bLen) return 1;
    const ap = aParts[i];
    const bp = bParts[i];
    if (ap === bp) continue;
    const aNum = /^\d+$/.test(ap);
    const bNum = /^\d+$/.test(bp);
    if (aNum && bNum) {
      return Number(ap) < Number(bp) ? -1 : 1;
    }
    if (aNum !== bNum) {
      return aNum ? -1 : 1;
    }
    return ap < bp ? -1 : 1;
  }
  return 0;
}

function compareSemver(a, b) {
  const pa = typeof a === 'string' ? parseSemver(a) : a;
  const pb = typeof b === 'string' ? parseSemver(b) : b;
  if (!pa || !pb) {
    throw new Error(`Invalid semver comparison: ${String(a)} vs ${String(b)}`);
  }
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

function matchSimpleToken(ver, token) {
  const t = token.trim();
  if (!t || t === '*' || t.toLowerCase() === 'x') return true;

  if (t.startsWith('^')) {
    const base = parseSemver(t.slice(1));
    if (!base) return false;
    if (compareSemver(ver, base) < 0) return false;
    if (base.major > 0) {
      return ver.major === base.major;
    }
    if (base.minor > 0) {
      return ver.major === 0 && ver.minor === base.minor;
    }
    return ver.major === 0 && ver.minor === 0 && ver.patch === base.patch;
  }

  if (t.startsWith('~')) {
    const base = parseSemver(t.slice(1));
    if (!base) return false;
    if (compareSemver(ver, base) < 0) return false;
    return ver.major === base.major && ver.minor === base.minor;
  }

  const opMatch = t.match(/^(>=|<=|>|<|=)?\s*(.+)$/);
  if (!opMatch) return false;
  const op = opMatch[1] || '=';
  const targetStr = opMatch[2].trim();

  // 支持简写主/次版本号如 1.x 或 2.32
  const partial = targetStr.match(/^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/i);
  if (partial && (op === '=' || !opMatch[1]) && (!partial[2] || !partial[3] || /x|\*/i.test(partial[2] + partial[3]))) {
    const maj = Number(partial[1]);
    if (ver.major !== maj) return false;
    if (partial[2] && !/x|\*/i.test(partial[2]) && ver.minor !== Number(partial[2])) return false;
    if (partial[3] && !/x|\*/i.test(partial[3]) && ver.patch !== Number(partial[3])) return false;
    return true;
  }

  const target = parseSemver(targetStr);
  if (!target) return false;
  const cmp = compareSemver(ver, target);
  if (op === '=') return cmp === 0;
  if (op === '>=') return cmp >= 0;
  if (op === '<=') return cmp <= 0;
  if (op === '>') return cmp > 0;
  if (op === '<') return cmp < 0;
  return false;
}

function isValidRange(range) {
  if (typeof range !== 'string' || !range.trim()) return false;
  const orClauses = range.split('||');
  return orClauses.every((clause) => {
    const tokens = clause.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return false;
    return tokens.every((tok) => {
      if (tok === '*' || tok.toLowerCase() === 'x') return true;
      if (tok.startsWith('^') || tok.startsWith('~')) return Boolean(parseSemver(tok.slice(1)));
      const m = tok.match(/^(>=|<=|>|<|=)?\s*(.+)$/);
      if (!m) return false;
      const body = m[2].trim();
      if (/^v?\d+(?:\.(?:\d+|x|\*))?(?:\.(?:\d+|x|\*))?$/i.test(body)) return true;
      return Boolean(parseSemver(body));
    });
  });
}

function satisfies(version, range) {
  const ver = typeof version === 'string' ? parseSemver(version) : version;
  if (!ver || !isValidRange(range)) return false;
  const orClauses = range.split('||');
  return orClauses.some((clause) => {
    const tokens = clause.trim().split(/\s+/).filter(Boolean);
    return tokens.every((tok) => matchSimpleToken(ver, tok));
  });
}

module.exports = {
  parseSemver,
  compareSemver,
  isValidRange,
  satisfies
};
