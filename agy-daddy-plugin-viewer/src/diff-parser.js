'use strict';

const MAX_WORD_LINE_CHARS = 1024;
const MAX_WORD_PAIR_BLOCK_LINES = 80;
const MAX_LCS_CELLS = 65536;

/**
 * Parses `git status --porcelain=v1 -z -uall` buffer.
 * Handles spaces, CJK, quotes, parentheses, and renames (`R  new\0old\0`).
 */
function parseStatusPorcelainZ(bufOrStr) {
  const buf = Buffer.isBuffer(bufOrStr) ? bufOrStr : Buffer.from(String(bufOrStr || ''), 'utf8');
  if (buf.length === 0) return [];

  const tokens = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      tokens.push(buf.subarray(start, i).toString('utf8'));
      start = i + 1;
    }
  }
  if (start < buf.length) {
    tokens.push(buf.subarray(start).toString('utf8'));
  }

  const entries = [];
  for (let i = 0; i < tokens.length; i++) {
    const rec = tokens[i];
    if (!rec || rec.length < 4) continue;
    const x = rec[0];
    const y = rec[1];
    const relPath = rec.slice(3);
    let oldRelPath = null;

    if ((x === 'R' || x === 'C' || y === 'R' || y === 'C') && i + 1 < tokens.length) {
      oldRelPath = tokens[++i] || null;
    }

    let status = 'M';
    if (x === '?' && y === '?') {
      status = '?';
    } else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
      status = 'U';
    } else if (x === 'R' || y === 'R') {
      status = 'R';
    } else if (x === 'A' || y === 'A') {
      status = 'A';
    } else if (x === 'D' || y === 'D') {
      status = 'D';
    }

    const untracked = status === '?';
    entries.push({
      relPath,
      oldRelPath,
      status,
      staged: !untracked && x !== ' ',
      unstaged: untracked ? true : y !== ' '
    });
  }
  return entries;
}

/**
 * Parses `git diff ... --numstat -z` buffer.
 */
function parseNumstatZ(bufOrStr) {
  const buf = Buffer.isBuffer(bufOrStr) ? bufOrStr : Buffer.from(String(bufOrStr || ''), 'utf8');
  if (buf.length === 0) return new Map();

  const tokens = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      tokens.push(buf.subarray(start, i).toString('utf8'));
      start = i + 1;
    }
  }

  const map = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const rec = tokens[i];
    if (!rec) continue;
    const parts = rec.split('\t');
    if (parts.length < 3) continue;
    const addRaw = parts[0];
    const delRaw = parts[1];
    let filePath = parts.slice(2).join('\t');
    let oldPath = null;
    if (filePath === '' && i + 2 < tokens.length) {
      oldPath = tokens[++i];
      filePath = tokens[++i];
    }
    const binary = addRaw === '-' && delRaw === '-';
    map.set(filePath, {
      additions: binary ? 0 : (Number.parseInt(addRaw, 10) || 0),
      deletions: binary ? 0 : (Number.parseInt(delRaw, 10) || 0),
      binary,
      oldRelPath: oldPath
    });
  }
  return map;
}

function tokenizeForWordDiff(str) {
  const tokens = [];
  const re = /\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    tokens.push({
      text: m[0],
      start: m.index,
      end: m.index + m[0].length
    });
  }
  return tokens;
}

function mergeTokenSpans(tokens, changedIndices) {
  const spans = [];
  for (const idx of changedIndices) {
    const tok = tokens[idx];
    if (!tok) continue;
    if (spans.length > 0 && spans[spans.length - 1].end === tok.start) {
      spans[spans.length - 1].end = tok.end;
    } else {
      spans.push({ start: tok.start, end: tok.end });
    }
  }
  return spans;
}

function computeWordSpansForPair(oldText, newText) {
  if (
    typeof oldText !== 'string'
    || typeof newText !== 'string'
    || oldText.length > MAX_WORD_LINE_CHARS
    || newText.length > MAX_WORD_LINE_CHARS
    || oldText === newText
  ) {
    return { oldSpans: [], newSpans: [] };
  }

  const oldTokens = tokenizeForWordDiff(oldText);
  const newTokens = tokenizeForWordDiff(newText);
  const m = oldTokens.length;
  const n = newTokens.length;

  if (m === 0 && n === 0) return { oldSpans: [], newSpans: [] };
  if (m === 0) return { oldSpans: [], newSpans: newText.length > 0 ? [{ start: 0, end: newText.length }] : [] };
  if (n === 0) return { oldSpans: oldText.length > 0 ? [{ start: 0, end: oldText.length }] : [], newSpans: [] };

  // Trim common prefix and suffix tokens before DP
  let prefix = 0;
  while (prefix < m && prefix < n && oldTokens[prefix].text === newTokens[prefix].text) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < (m - prefix)
    && suffix < (n - prefix)
    && oldTokens[m - 1 - suffix].text === newTokens[n - 1 - suffix].text
  ) {
    suffix++;
  }

  const oldMidLen = m - prefix - suffix;
  const newMidLen = n - prefix - suffix;
  const changedOld = [];
  const changedNew = [];

  if (oldMidLen * newMidLen > MAX_LCS_CELLS) {
    for (let i = prefix; i < m - suffix; i++) changedOld.push(i);
    for (let j = prefix; j < n - suffix; j++) changedNew.push(j);
  } else {
    const cols = newMidLen + 1;
    const dp = new Uint16Array((oldMidLen + 1) * cols);
    for (let i = oldMidLen - 1; i >= 0; i--) {
      const oText = oldTokens[prefix + i].text;
      const rowOffset = i * cols;
      const nextRowOffset = (i + 1) * cols;
      for (let j = newMidLen - 1; j >= 0; j--) {
        if (oText === newTokens[prefix + j].text) {
          dp[rowOffset + j] = 1 + dp[nextRowOffset + j + 1];
        } else {
          const down = dp[nextRowOffset + j];
          const right = dp[rowOffset + j + 1];
          dp[rowOffset + j] = down >= right ? down : right;
        }
      }
    }

    let i = 0;
    let j = 0;
    while (i < oldMidLen && j < newMidLen) {
      if (oldTokens[prefix + i].text === newTokens[prefix + j].text) {
        i++;
        j++;
      } else if (dp[(i + 1) * cols + j] >= dp[i * cols + j + 1]) {
        changedOld.push(prefix + i);
        i++;
      } else {
        changedNew.push(prefix + j);
        j++;
      }
    }
    while (i < oldMidLen) {
      changedOld.push(prefix + i);
      i++;
    }
    while (j < newMidLen) {
      changedNew.push(prefix + j);
      j++;
    }
  }

  return {
    oldSpans: mergeTokenSpans(oldTokens, changedOld),
    newSpans: mergeTokenSpans(newTokens, changedNew)
  };
}

function annotateHunkWordSpans(lines) {
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type !== 'del') {
      i++;
      continue;
    }
    const delStart = i;
    while (i < lines.length && lines[i].type === 'del') i++;
    const delEnd = i;
    const addStart = i;
    while (i < lines.length && lines[i].type === 'add') i++;
    const addEnd = i;

    const delCount = delEnd - delStart;
    const addCount = addEnd - addStart;
    if (delCount === 0 || addCount === 0) continue;
    if (Math.max(delCount, addCount) > MAX_WORD_PAIR_BLOCK_LINES) continue;

    const pairs = Math.min(delCount, addCount);
    for (let k = 0; k < pairs; k++) {
      const delLine = lines[delStart + k];
      const addLine = lines[addStart + k];
      const { oldSpans, newSpans } = computeWordSpansForPair(delLine.content, addLine.content);
      if (oldSpans.length > 0) delLine.wordSpans = oldSpans;
      if (newSpans.length > 0) addLine.wordSpans = newSpans;
    }
  }
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function parseUnifiedDiff(diffText, options = {}) {
  const wordHighlight = options.wordHighlight !== false;
  const maxLines = Number(options.maxLines) > 0 ? Number(options.maxLines) : 5000;
  const rawLines = String(diffText || '').split(/\r?\n/);

  const hunks = [];
  let currentHunk = null;
  let oldCursor = 0;
  let newCursor = 0;
  let prevNewEnd = 0;
  let additions = 0;
  let deletions = 0;
  let totalDiffLines = 0;
  let truncated = false;

  const finalizeHunk = (h) => {
    if (!h) return;
    if (wordHighlight) annotateHunkWordSpans(h.lines);
    hunks.push(h);
  };

  for (const raw of rawLines) {
    const hunkMatch = raw.match(HUNK_HEADER_RE);
    if (hunkMatch) {
      finalizeHunk(currentHunk);
      if (totalDiffLines >= maxLines) {
        truncated = true;
        currentHunk = null;
        break;
      }
      const oldStart = Number.parseInt(hunkMatch[1], 10);
      const oldLines = hunkMatch[2] !== undefined ? Number.parseInt(hunkMatch[2], 10) : 1;
      const newStart = Number.parseInt(hunkMatch[3], 10);
      const newLines = hunkMatch[4] !== undefined ? Number.parseInt(hunkMatch[4], 10) : 1;
      const expandStart = prevNewEnd + 1;
      const expandEnd = newStart - 1;
      const canExpandBefore = expandEnd >= expandStart && expandStart >= 1;

      currentHunk = {
        index: hunks.length,
        header: raw,
        oldStart,
        oldLines,
        newStart,
        newLines,
        canExpandBefore,
        expandBeforeRange: canExpandBefore ? { startLine: expandStart, endLine: expandEnd } : null,
        lines: []
      };
      oldCursor = oldStart;
      newCursor = newStart;
      prevNewEnd = newStart + Math.max(0, newLines - 1);
      continue;
    }

    if (!currentHunk) continue;
    if (raw === '\\ No newline at end of file') continue;

    const prefix = raw[0];
    if (prefix !== '+' && prefix !== '-' && prefix !== ' ') continue;

    if (totalDiffLines >= maxLines) {
      truncated = true;
      break;
    }

    const content = raw.slice(1);
    if (prefix === ' ') {
      currentHunk.lines.push({
        type: 'ctx',
        oldLine: oldCursor++,
        newLine: newCursor++,
        content
      });
    } else if (prefix === '-') {
      deletions++;
      currentHunk.lines.push({
        type: 'del',
        oldLine: oldCursor++,
        newLine: null,
        content
      });
    } else {
      additions++;
      currentHunk.lines.push({
        type: 'add',
        oldLine: null,
        newLine: newCursor++,
        content
      });
    }
    totalDiffLines++;
  }

  finalizeHunk(currentHunk);

  return {
    hunks,
    stats: {
      additions,
      deletions,
      hunkCount: hunks.length
    },
    truncated,
    totalDiffLines
  };
}

function synthesizeUntrackedDiff(contentText, options = {}) {
  const maxLines = Number(options.maxLines) > 0 ? Number(options.maxLines) : 5000;
  const text = String(contentText || '');
  if (text.length === 0) {
    return {
      hunks: [],
      stats: { additions: 0, deletions: 0, hunkCount: 0 },
      truncated: false,
      totalDiffLines: 0
    };
  }
  const allLines = text.split(/\r?\n/);
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
    allLines.pop();
  }
  const truncated = allLines.length > maxLines;
  const slice = truncated ? allLines.slice(0, maxLines) : allLines;
  const lines = slice.map((line, i) => ({
    type: 'add',
    oldLine: null,
    newLine: i + 1,
    content: line
  }));

  const hunks = lines.length > 0
    ? [{
        index: 0,
        header: `@@ -0,0 +1,${lines.length} @@ (untracked)`,
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: lines.length,
        canExpandBefore: false,
        expandBeforeRange: null,
        lines
      }]
    : [];

  return {
    hunks,
    stats: {
      additions: lines.length,
      deletions: 0,
      hunkCount: hunks.length
    },
    truncated,
    totalDiffLines: allLines.length
  };
}

module.exports = {
  parseStatusPorcelainZ,
  parseNumstatZ,
  tokenizeForWordDiff,
  computeWordSpansForPair,
  parseUnifiedDiff,
  synthesizeUntrackedDiff
};
