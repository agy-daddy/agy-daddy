'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const {
  ERROR_CODES,
  classifyExtension,
  safeErrorPayload
} = require('./constants');
const {
  resolveRealPath,
  isInsideAnyRoot,
  validatePathAccess
} = require('./path-guard');
const {
  parseStatusPorcelainZ,
  parseNumstatZ,
  parseUnifiedDiff,
  synthesizeUntrackedDiff
} = require('./diff-parser');

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_CONTEXT_LINES_PER_REQUEST = 200;

const ALLOWED_GIT_SUBCOMMANDS = Object.freeze(new Set([
  'rev-parse',
  'symbolic-ref',
  'status',
  'diff',
  'show'
]));

const SAFE_GIT_GLOBAL_ARGS = Object.freeze([
  '--no-pager',
  '-c', 'core.fsmonitor=false',
  '-c', 'diff.external=',
  '-c', 'core.quotePath=false',
  '-c', 'color.ui=false',
  '-c', 'protocol.file.allow=never'
]);

const STRIPPED_GIT_ENV_KEYS = Object.freeze([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  'GIT_EXEC_PATH',
  'GIT_CONFIG',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM'
]);

function buildSanitizedGitEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const key of STRIPPED_GIT_ENV_KEYS) {
    delete env[key];
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.LC_ALL = 'C.UTF-8';
  return env;
}

function execSafeGit(cwd, subcommand, args = [], options = {}) {
  if (!ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
    const err = new Error(`Forbidden git subcommand: ${String(subcommand)}`);
    err.code = ERROR_CODES.GIT_WRITE_FORBIDDEN;
    return Promise.reject(err);
  }

  const fullArgs = [...SAFE_GIT_GLOBAL_ARGS, '-C', cwd, subcommand, ...args];
  return new Promise((resolve) => {
    execFile('git', fullArgs, {
      shell: false,
      windowsHide: true,
      timeout: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : GIT_TIMEOUT_MS,
      maxBuffer: Number(options.maxBuffer) > 0 ? Number(options.maxBuffer) : GIT_MAX_BUFFER_BYTES,
      encoding: 'buffer',
      env: buildSanitizedGitEnv()
    }, (err, stdout, stderr) => {
      const outBuf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || '', 'utf8');
      const errText = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || '');
      if (err) {
        resolve({
          ok: false,
          code: typeof err.code === 'number' ? err.code : 1,
          killed: Boolean(err.killed),
          stdout: outBuf,
          stderr: errText
        });
        return;
      }
      resolve({ ok: true, code: 0, killed: false, stdout: outBuf, stderr: errText });
    });
  });
}

function toSafeGitRelPath(realToplevel, realTarget) {
  const rel = path.relative(realToplevel, realTarget).split(path.sep).join('/');
  if (!rel || rel === '.') return '';
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel.includes('\0')) {
    return null;
  }
  return rel.startsWith('-') ? `./${rel}` : rel;
}

function normalizeScope(raw) {
  if (raw === 'unstaged' || raw === 'staged' || raw === 'head') return raw;
  return 'head';
}

function isBinaryBufferSample(buf) {
  if (!buf || buf.length === 0) return false;
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function findExistingDirForPath(targetPath) {
  let cur = targetPath;
  while (true) {
    try {
      const st = fs.statSync(cur);
      if (st.isDirectory()) return cur;
      cur = path.dirname(cur);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
  }
}

function createGitDiffService(options = {}) {
  const resolveAllowedRoots = options.resolveAllowedRoots;

  async function resolveRepoContext(rawInputPath, settings = {}, host = null) {
    const allowedRealRoots = typeof resolveAllowedRoots === 'function'
      ? await resolveAllowedRoots({ settings, host })
      : [];

    const pathCheck = validatePathAccess(rawInputPath, {
      allowedRealRoots,
      mustExist: false,
      requireRegularFile: false
    });
    if (!pathCheck.ok) {
      return pathCheck;
    }

    const targetDir = (pathCheck.exists && pathCheck.stat?.isDirectory())
      ? pathCheck.realPath
      : findExistingDirForPath(pathCheck.realPath);

    if (!targetDir || !isInsideAnyRoot(targetDir, allowedRealRoots)) {
      return { ok: false, statusCode: 403, ...safeErrorPayload(ERROR_CODES.PATH_OUT_OF_BOUNDS) };
    }

    const topRes = await execSafeGit(targetDir, 'rev-parse', ['--show-toplevel']);
    if (!topRes.ok) {
      return {
        ok: true,
        isGitRepo: false,
        state: 'NOT_A_GIT_REPO',
        pathCheck
      };
    }

    let realToplevel;
    try {
      realToplevel = resolveRealPath(topRes.stdout.toString('utf8').trim());
    } catch {
      return { ok: false, statusCode: 403, ...safeErrorPayload(ERROR_CODES.PATH_OUT_OF_BOUNDS) };
    }

    if (!isInsideAnyRoot(realToplevel, allowedRealRoots)) {
      return { ok: false, statusCode: 403, ...safeErrorPayload(ERROR_CODES.PATH_OUT_OF_BOUNDS) };
    }

    const headVerify = await execSafeGit(realToplevel, 'rev-parse', ['--verify', 'HEAD']);
    const hasHeadCommit = headVerify.ok;
    const headShortSha = hasHeadCommit
      ? (await execSafeGit(realToplevel, 'rev-parse', ['--short', 'HEAD'])).stdout.toString('utf8').trim()
      : '';

    const symRes = await execSafeGit(realToplevel, 'symbolic-ref', ['--short', 'HEAD']);
    const detached = !symRes.ok;
    const branch = symRes.ok
      ? symRes.stdout.toString('utf8').trim()
      : (headShortSha ? `HEAD (${headShortSha})` : 'HEAD (unborn)');

    return {
      ok: true,
      isGitRepo: true,
      realToplevel,
      repoName: path.basename(realToplevel),
      branch,
      detached,
      headShortSha,
      hasHeadCommit,
      pathCheck,
      allowedRealRoots
    };
  }

  async function getBlobSize(realToplevel, spec) {
    const res = await execSafeGit(realToplevel, 'cat-file', ['-s', spec]).catch(() => null);
    if (!res?.ok) return null;
    const n = Number.parseInt(res.stdout.toString('utf8').trim(), 10);
    return Number.isFinite(n) ? n : null;
  }

  async function getOldBlobSize(realToplevel, scope, relPath, hasHeadCommit) {
    if (scope === 'unstaged') {
      const res = await execSafeGit(realToplevel, 'show', [`--`, `:${relPath}`]);
      return res.ok ? res.stdout.length : null;
    }
    if (!hasHeadCommit) return 0;
    const res = await execSafeGit(realToplevel, 'show', [`HEAD:${relPath}`]);
    return res.ok ? res.stdout.length : null;
  }

  async function getWorkspaceChanges({ rootHint = '', scope: rawScope, filterText = '', settings = {}, host = null } = {}) {
    const scope = normalizeScope(rawScope || settings.diffDefaultScope);
    const allowedRealRoots = typeof resolveAllowedRoots === 'function'
      ? await resolveAllowedRoots({ settings, host })
      : [];

    const candidateRoot = (typeof rootHint === 'string' && rootHint.trim())
      ? rootHint.trim()
      : (allowedRealRoots[0] || '');

    if (!candidateRoot) {
      return { ok: false, statusCode: 403, ...safeErrorPayload(ERROR_CODES.PATH_OUT_OF_BOUNDS) };
    }

    const ctx = await resolveRepoContext(candidateRoot, settings, host);
    if (!ctx.ok) return ctx;
    if (!ctx.isGitRepo) {
      return {
        ok: true,
        state: 'NOT_A_GIT_REPO',
        isGitRepo: false,
        scope,
        totalChangedFiles: 0,
        files: []
      };
    }

    const baseRef = ctx.hasHeadCommit ? 'HEAD' : EMPTY_TREE_OID;
    const statusRes = await execSafeGit(ctx.realToplevel, 'status', ['--porcelain=v1', '-z', '-uall']);
    const statusEntries = statusRes.ok ? parseStatusPorcelainZ(statusRes.stdout) : [];

    let numstatArgs;
    if (scope === 'staged') {
      numstatArgs = ['--no-ext-diff', '--no-color', '--cached', '--numstat', '-z', baseRef];
    } else if (scope === 'unstaged') {
      numstatArgs = ['--no-ext-diff', '--no-color', '--numstat', '-z'];
    } else {
      numstatArgs = ['--no-ext-diff', '--no-color', '--numstat', '-z', baseRef];
    }

    const numstatRes = await execSafeGit(ctx.realToplevel, 'diff', numstatArgs);
    const numstatMap = numstatRes.ok ? parseNumstatZ(numstatRes.stdout) : new Map();

    const filterLower = String(filterText || '').trim().toLowerCase();
    const files = [];

    for (const st of statusEntries) {
      if (scope === 'staged' && !st.staged) continue;
      if (scope === 'unstaged' && !st.unstaged) continue;

      if (filterLower && !st.relPath.toLowerCase().includes(filterLower)) {
        continue;
      }

      const absCandidate = path.resolve(ctx.realToplevel, st.relPath);
      const checked = validatePathAccess(absCandidate, {
        allowedRealRoots: ctx.allowedRealRoots,
        mustExist: false,
        requireRegularFile: false
      });
      if (!checked.ok) continue;

      const statInfo = numstatMap.get(st.relPath) || { additions: 0, deletions: 0, binary: false };
      let binary = statInfo.binary;
      if (!binary && st.status === '?' && checked.exists && checked.stat?.isFile()) {
        try {
          const fd = fs.openSync(checked.realPath, 'r');
          try {
            const sample = Buffer.allocUnsafe(Math.min(checked.stat.size, 8192));
            const read = fs.readSync(fd, sample, 0, sample.length, 0);
            binary = isBinaryBufferSample(sample.subarray(0, read));
          } finally {
            fs.closeSync(fd);
          }
        } catch {}
      }

      const ext = path.extname(st.relPath).toLowerCase();
      const { category } = classifyExtension(ext);
      const omniCategory = category === 'other' ? null : category;

      files.push({
        relPath: st.relPath,
        oldRelPath: st.oldRelPath || statInfo.oldRelPath || null,
        filePath: checked.realPath,
        status: st.status,
        staged: st.staged,
        unstaged: st.unstaged,
        binary,
        additions: statInfo.additions,
        deletions: statInfo.deletions,
        omniCategory
      });
    }

    return {
      ok: true,
      state: files.length === 0 ? 'NO_CHANGES' : 'OK',
      isGitRepo: true,
      repoName: ctx.repoName,
      branch: ctx.branch,
      detached: ctx.detached,
      headShortSha: ctx.headShortSha,
      scope,
      totalChangedFiles: files.length,
      files
    };
  }

  async function getFileDiff({
    filePath,
    scope: rawScope,
    contextLines: rawContextLines,
    wordHighlight: rawWordHighlight,
    settings = {},
    host = null
  } = {}) {
    const scope = normalizeScope(rawScope || settings.diffDefaultScope);
    const contextLines = Math.max(0, Math.min(20, Number.parseInt(rawContextLines ?? settings.diffContextLines ?? 3, 10) || 3));
    const wordHighlight = rawWordHighlight !== undefined ? Boolean(rawWordHighlight) : Boolean(settings.diffShowWordHighlight ?? true);
    const maxFileBytes = (Number(settings.diffMaxFileSizeMB) > 0 ? Number(settings.diffMaxFileSizeMB) : 2) * 1024 * 1024;
    const maxDiffLines = Number(settings.diffMaxLines) > 0 ? Number(settings.diffMaxLines) : 5000;

    const ctx = await resolveRepoContext(filePath, settings, host);
    if (!ctx.ok) return ctx;
    if (!ctx.isGitRepo) {
      return {
        ok: true,
        state: 'NOT_A_GIT_REPO',
        isGitRepo: false,
        scope
      };
    }

    const safeRel = toSafeGitRelPath(ctx.realToplevel, ctx.pathCheck.realPath);
    if (!safeRel) {
      return { ok: false, statusCode: 403, ...safeErrorPayload(ERROR_CODES.PATH_OUT_OF_BOUNDS) };
    }
    const displayRel = safeRel.startsWith('./') ? safeRel.slice(2) : safeRel;

    const statusRes = await execSafeGit(ctx.realToplevel, 'status', ['--porcelain=v1', '-z', '-uall', '--', safeRel]);
    const statusEntries = statusRes.ok ? parseStatusPorcelainZ(statusRes.stdout) : [];
    const matchedStatus = statusEntries.find((e) => e.relPath === displayRel) || statusEntries[0] || null;
    const status = matchedStatus ? matchedStatus.status : 'M';
    const oldRelPath = matchedStatus?.oldRelPath || null;

    const ext = path.extname(displayRel).toLowerCase();
    const { category } = classifyExtension(ext);
    const omniCategory = category === 'other' ? null : category;
    const newSize = ctx.pathCheck.exists && ctx.pathCheck.stat ? ctx.pathCheck.stat.size : 0;

    // Untracked file handling
    if (status === '?') {
      if (scope === 'staged') {
        return {
          ok: true,
          state: 'NO_CHANGES',
          isGitRepo: true,
          repoName: ctx.repoName,
          branch: ctx.branch,
          scope,
          status: '?',
          relPath: displayRel,
          oldRelPath: null,
          binary: false,
          oldSize: 0,
          newSize,
          omniCategory,
          truncated: false,
          truncationMeta: null,
          stats: { additions: 0, deletions: 0, hunkCount: 0 },
          hunks: []
        };
      }

      if (!ctx.pathCheck.exists || !ctx.pathCheck.stat?.isFile()) {
        return { ok: false, statusCode: 403, ...safeErrorPayload(ERROR_CODES.NOT_A_REGULAR_FILE) };
      }

      // Binary check on first 8KB
      const fd = fs.openSync(ctx.pathCheck.realPath, 'r');
      let isBin = false;
      try {
        const sample = Buffer.allocUnsafe(Math.min(newSize, 8192));
        const bytesRead = fs.readSync(fd, sample, 0, sample.length, 0);
        isBin = isBinaryBufferSample(sample.subarray(0, bytesRead));
      } finally {
        fs.closeSync(fd);
      }

      if (isBin) {
        return {
          ok: true,
          state: 'BINARY_FILE',
          isGitRepo: true,
          repoName: ctx.repoName,
          branch: ctx.branch,
          scope,
          status: '?',
          relPath: displayRel,
          oldRelPath: null,
          binary: true,
          oldSize: 0,
          newSize,
          omniCategory,
          truncated: false,
          truncationMeta: null,
          stats: { additions: 0, deletions: 0, hunkCount: 0 },
          hunks: []
        };
      }

      if (newSize > maxFileBytes) {
        const headBuf = Buffer.allocUnsafe(Math.min(newSize, 262144));
        const fd2 = fs.openSync(ctx.pathCheck.realPath, 'r');
        let headText = '';
        try {
          const read = fs.readSync(fd2, headBuf, 0, headBuf.length, 0);
          headText = headBuf.subarray(0, read).toString('utf8');
        } finally {
          fs.closeSync(fd2);
        }
        const synth = synthesizeUntrackedDiff(headText, { maxLines: maxDiffLines });
        return {
          ok: true,
          state: 'DIFF_TRUNCATED',
          isGitRepo: true,
          repoName: ctx.repoName,
          branch: ctx.branch,
          scope,
          status: '?',
          relPath: displayRel,
          oldRelPath: null,
          binary: false,
          oldSize: 0,
          newSize,
          omniCategory,
          truncated: true,
          truncationMeta: { reason: 'FILE_SIZE_LIMIT', fileSize: newSize, maxBytes: maxFileBytes },
          stats: synth.stats,
          hunks: synth.hunks
        };
      }

      const content = fs.readFileSync(ctx.pathCheck.realPath, 'utf8');
      const synth = synthesizeUntrackedDiff(content, { maxLines: maxDiffLines });
      return {
        ok: true,
        state: synth.truncated ? 'DIFF_TRUNCATED' : 'OK',
        isGitRepo: true,
        repoName: ctx.repoName,
        branch: ctx.branch,
        scope,
        status: '?',
        relPath: displayRel,
        oldRelPath: null,
        binary: false,
        oldSize: 0,
        newSize,
        omniCategory,
        truncated: synth.truncated,
        truncationMeta: synth.truncated ? { reason: 'LINE_LIMIT', totalLines: synth.totalDiffLines, maxLines: maxDiffLines } : null,
        stats: synth.stats,
        hunks: synth.hunks
      };
    }

    // Tracked file diff
    const baseRef = ctx.hasHeadCommit ? 'HEAD' : EMPTY_TREE_OID;
    let numstatArgs;
    let diffArgs;
    if (scope === 'staged') {
      numstatArgs = ['--no-ext-diff', '--no-color', '--cached', '--numstat', '-z', baseRef, '--', safeRel];
      diffArgs = ['--no-ext-diff', '--no-color', '--cached', `-U${contextLines}`, baseRef, '--', safeRel];
    } else if (scope === 'unstaged') {
      numstatArgs = ['--no-ext-diff', '--no-color', '--numstat', '-z', '--', safeRel];
      diffArgs = ['--no-ext-diff', '--no-color', `-U${contextLines}`, '--', safeRel];
    } else {
      numstatArgs = ['--no-ext-diff', '--no-color', '--numstat', '-z', baseRef, '--', safeRel];
      diffArgs = ['--no-ext-diff', '--no-color', `-U${contextLines}`, baseRef, '--', safeRel];
    }

    const numstatRes = await execSafeGit(ctx.realToplevel, 'diff', numstatArgs);
    const numstatMap = numstatRes.ok ? parseNumstatZ(numstatRes.stdout) : new Map();
    const numEntry = numstatMap.get(displayRel) || Array.from(numstatMap.values())[0] || null;
    const oldSize = await getOldBlobSize(ctx.realToplevel, scope, oldRelPath || displayRel, ctx.hasHeadCommit);

    if (numEntry?.binary) {
      return {
        ok: true,
        state: 'BINARY_FILE',
        isGitRepo: true,
        repoName: ctx.repoName,
        branch: ctx.branch,
        scope,
        status,
        relPath: displayRel,
        oldRelPath,
        binary: true,
        oldSize,
        newSize,
        omniCategory,
        truncated: false,
        truncationMeta: null,
        stats: { additions: 0, deletions: 0, hunkCount: 0 },
        hunks: []
      };
    }

    if (newSize > maxFileBytes || (oldSize !== null && oldSize > maxFileBytes)) {
      const diffRes = await execSafeGit(ctx.realToplevel, 'diff', diffArgs);
      const parsed = diffRes.ok
        ? parseUnifiedDiff(diffRes.stdout.toString('utf8'), { wordHighlight: false, maxLines: Math.min(200, maxDiffLines) })
        : { hunks: [], stats: { additions: numEntry?.additions || 0, deletions: numEntry?.deletions || 0, hunkCount: 0 } };
      return {
        ok: true,
        state: 'DIFF_TRUNCATED',
        isGitRepo: true,
        repoName: ctx.repoName,
        branch: ctx.branch,
        scope,
        status,
        relPath: displayRel,
        oldRelPath,
        binary: false,
        oldSize,
        newSize,
        omniCategory,
        truncated: true,
        truncationMeta: {
          reason: 'FILE_SIZE_LIMIT',
          fileSize: Math.max(newSize, oldSize || 0),
          maxBytes: maxFileBytes
        },
        stats: {
          additions: numEntry?.additions ?? parsed.stats.additions,
          deletions: numEntry?.deletions ?? parsed.stats.deletions,
          hunkCount: parsed.hunks.length
        },
        hunks: parsed.hunks
      };
    }

    const diffRes = await execSafeGit(ctx.realToplevel, 'diff', diffArgs);
    if (!diffRes.ok) {
      return { ok: false, statusCode: 500, ...safeErrorPayload(ERROR_CODES.GIT_EXEC_FAILED) };
    }

    const diffText = diffRes.stdout.toString('utf8');
    if (diffText.includes('\nBinary files ') || diffText.includes('\nGIT binary patch')) {
      return {
        ok: true,
        state: 'BINARY_FILE',
        isGitRepo: true,
        repoName: ctx.repoName,
        branch: ctx.branch,
        scope,
        status,
        relPath: displayRel,
        oldRelPath,
        binary: true,
        oldSize,
        newSize,
        omniCategory,
        truncated: false,
        truncationMeta: null,
        stats: { additions: 0, deletions: 0, hunkCount: 0 },
        hunks: []
      };
    }

    const parsed = parseUnifiedDiff(diffText, { wordHighlight, maxLines: maxDiffLines });
    if (parsed.hunks.length === 0) {
      return {
        ok: true,
        state: 'NO_CHANGES',
        isGitRepo: true,
        repoName: ctx.repoName,
        branch: ctx.branch,
        scope,
        status,
        relPath: displayRel,
        oldRelPath,
        binary: false,
        oldSize,
        newSize,
        omniCategory,
        truncated: false,
        truncationMeta: null,
        stats: { additions: 0, deletions: 0, hunkCount: 0 },
        hunks: []
      };
    }

    return {
      ok: true,
      state: parsed.truncated ? 'DIFF_TRUNCATED' : 'OK',
      isGitRepo: true,
      repoName: ctx.repoName,
      branch: ctx.branch,
      scope,
      status,
      relPath: displayRel,
      oldRelPath,
      binary: false,
      oldSize,
      newSize,
      omniCategory,
      truncated: parsed.truncated,
      truncationMeta: parsed.truncated ? { reason: 'LINE_LIMIT', totalLines: parsed.totalDiffLines, maxLines: maxDiffLines } : null,
      stats: parsed.stats,
      hunks: parsed.hunks
    };
  }

  async function getContextLines({
    filePath,
    scope: rawScope,
    startLine,
    endLine,
    settings = {},
    host = null
  } = {}) {
    const scope = normalizeScope(rawScope || settings.diffDefaultScope);
    const start = Number.parseInt(startLine, 10);
    const end = Number.parseInt(endLine, 10);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
      return { ok: false, statusCode: 400, ...safeErrorPayload(ERROR_CODES.INVALID_ARGUMENT, 'startLine 与 endLine 参数无效') };
    }
    const clampedEnd = Math.min(end, start + MAX_CONTEXT_LINES_PER_REQUEST - 1);

    const ctx = await resolveRepoContext(filePath, settings, host);
    if (!ctx.ok) return ctx;
    if (!ctx.isGitRepo) {
      return { ok: false, statusCode: 400, ...safeErrorPayload(ERROR_CODES.NOT_A_GIT_REPO, '当前目录不是 Git 仓库') };
    }

    const safeRel = toSafeGitRelPath(ctx.realToplevel, ctx.pathCheck.realPath);
    if (!safeRel) {
      return { ok: false, statusCode: 403, ...safeErrorPayload(ERROR_CODES.PATH_OUT_OF_BOUNDS) };
    }
    const displayRel = safeRel.startsWith('./') ? safeRel.slice(2) : safeRel;

    let text = '';
    if (scope === 'staged') {
      const showRes = await execSafeGit(ctx.realToplevel, 'show', [`--`, `:${displayRel}`]);
      if (showRes.ok) {
        text = showRes.stdout.toString('utf8');
      } else if (ctx.hasHeadCommit) {
        const headRes = await execSafeGit(ctx.realToplevel, 'show', [`HEAD:${displayRel}`]);
        if (headRes.ok) text = headRes.stdout.toString('utf8');
      }
    } else if (ctx.pathCheck.exists && ctx.pathCheck.stat?.isFile()) {
      text = fs.readFileSync(ctx.pathCheck.realPath, 'utf8');
    } else if (ctx.hasHeadCommit) {
      const headRes = await execSafeGit(ctx.realToplevel, 'show', [`HEAD:${displayRel}`]);
      if (headRes.ok) text = headRes.stdout.toString('utf8');
    }

    const allLines = text.split(/\r?\n/);
    const lines = [];
    for (let ln = start; ln <= clampedEnd && ln <= allLines.length; ln++) {
      lines.push({
        oldLine: ln,
        newLine: ln,
        type: 'ctx',
        content: allLines[ln - 1]
      });
    }
    return { ok: true, lines };
  }

  return {
    getWorkspaceChanges,
    getFileDiff,
    getContextLines,
    resolveRepoContext
  };
}

module.exports = {
  ALLOWED_GIT_SUBCOMMANDS,
  SAFE_GIT_GLOBAL_ARGS,
  STRIPPED_GIT_ENV_KEYS,
  buildSanitizedGitEnv,
  execSafeGit,
  toSafeGitRelPath,
  createGitDiffService
};
