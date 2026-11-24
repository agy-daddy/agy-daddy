'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { BUILTIN_QUICK_POOL } = require('./quick-prompts');

const MAX_CANDIDATE_PROMPT_CHARS = 280;
const MIN_CANDIDATE_PROMPT_CHARS = 2;

const NOISE_PROMPT_PATTERNS = [
  /^Conversation history, background context only\b/i,
  /^The following conversation history is background context\b/i,
  /^You did not call any tools\./i,
  /^Translate ALL \d+ UI strings/i,
  /^\[plan review/i,
  /^<SYSTEM_MESSAGE>/i,
  /^<conversation_history>/i,
  /^Plan mode is off\b/i
];

function getDefaultBrainDirs() {
  const home = os.homedir();
  return [
    path.join(home, '.gemini', 'antigravity', 'brain'),
    path.join(home, '.gemini', 'antigravity-ide', 'brain'),
    path.join(home, '.gemini', 'antigravity-cli', 'brain')
  ];
}

function extractCleanManualPrompt(rawContent = '') {
  const raw = String(rawContent || '');
  if (!raw) return '';
  const reqMatch = raw.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  const body = (reqMatch ? reqMatch[1] : raw).trim();
  if (!body) return '';
  const normalized = body.replace(/\s+/g, ' ').trim();
  if (normalized.length < MIN_CANDIDATE_PROMPT_CHARS || normalized.length > MAX_CANDIDATE_PROMPT_CHARS) {
    return '';
  }
  for (const re of NOISE_PROMPT_PATTERNS) {
    if (re.test(normalized)) return '';
  }
  return normalized;
}

function buildBuiltinCommandSet(builtinPool = []) {
  const set = new Set();
  for (const item of (Array.isArray(builtinPool) ? builtinPool : [])) {
    const t = String(item?.text || '').trim().toLowerCase();
    if (t) set.add(t);
    if (item?.slash) set.add(`/${String(item.slash).trim().toLowerCase()}`);
  }
  return set;
}

function scanTranscriptFilesOnDisk(brainDirs, { maxSessions = 500 } = {}) {
  const files = [];
  for (const dir of brainDirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      const sessionDir = path.join(dir, ent.name);
      const candidates = [
        path.join(sessionDir, '.system_generated', 'logs', 'transcript.jsonl'),
        path.join(sessionDir, 'transcript.jsonl')
      ];
      for (const fp of candidates) {
        try {
          const st = fs.statSync(fp);
          if (st.isFile() && st.size > 0) {
            files.push({ fp, mtimeMs: st.mtimeMs });
            break;
          }
        } catch {}
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.slice(0, Math.max(1, Number(maxSessions) || 500));
}

async function collectManualUserMessages({
  brainDirs = null,
  rpc = null,
  skipDiskScan = undefined,
  builtinPool = BUILTIN_QUICK_POOL,
  maxSessions = 500
} = {}) {
  const builtinSet = buildBuiltinCommandSet(builtinPool);
  const countMap = new Map();
  const recentShort = [];
  const seenRecent = new Set();
  let sessionsScanned = 0;
  let messagesScanned = 0;

  const addMessage = (rawContent) => {
    const clean = extractCleanManualPrompt(rawContent);
    if (!clean) return;
    const key = clean.toLowerCase();
    if (builtinSet.has(key)) return;
    messagesScanned++;
    const prev = countMap.get(key);
    if (prev) {
      prev.count += 1;
    } else {
      countMap.set(key, { text: clean, count: 1 });
    }
    if (!seenRecent.has(key) && recentShort.length < 40) {
      seenRecent.add(key);
      recentShort.push(clean);
    }
  };

  const shouldSkipDisk = skipDiskScan !== undefined
    ? Boolean(skipDiskScan)
    : (!Array.isArray(brainDirs) && (process.env.AGY_DADDY_TEST_MODE === '1' || Boolean(process.env.NODE_TEST_CONTEXT)));

  if (!shouldSkipDisk) {
    const dirs = Array.isArray(brainDirs) ? brainDirs : getDefaultBrainDirs();
    const files = scanTranscriptFilesOnDisk(dirs, { maxSessions });
    for (const { fp } of files) {
      let content = '';
      try {
        content = fs.readFileSync(fp, 'utf8');
      } catch {
        continue;
      }
      sessionsScanned++;
      for (const line of content.split(/\r?\n/)) {
        if (!line || !line.includes('"USER_INPUT"')) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev?.type === 'USER_INPUT' && ev?.source === 'USER_EXPLICIT') {
          addMessage(ev.content);
        }
      }
    }
  }

  if (sessionsScanned === 0 && rpc && typeof rpc.call === 'function') {
    try {
      const traj = await rpc.call('GetAllCascadeTrajectories', {}, { timeoutMs: 8000 });
      const summaries = traj?.trajectorySummaries || traj?.summaries || {};
      const ids = Object.keys(summaries).slice(0, 40);
      for (const cid of ids) {
        try {
          const stepsRes = await rpc.call('GetCascadeTrajectorySteps', { cascadeId: cid }, { timeoutMs: 5000 });
          const steps = Array.isArray(stepsRes?.steps) ? stepsRes.steps : [];
          if (steps.length > 0) sessionsScanned++;
          for (const st of steps) {
            if (st?.type === 'CORTEX_STEP_TYPE_USER_INPUT' || st?.userInput) {
              const txt = st?.userInput?.userResponse || st?.userInput?.items?.map((i) => i?.text || '').join(' ') || '';
              addMessage(txt);
            }
          }
        } catch {}
      }
    } catch {}
  }

  const allUnique = Array.from(countMap.values()).sort((a, b) => (b.count - a.count) || (a.text.length - b.text.length));
  const topRepeated = allUnique.slice(0, 60);

  return {
    sessionsScanned,
    messagesScanned,
    uniqueCount: allUnique.length,
    topRepeated,
    recentShort
  };
}

function buildFrequentPromptsInstruction(stats = {}, builtinPool = []) {
  const repeatedLines = (stats.topRepeated || [])
    .slice(0, 50)
    .map((item, idx) => `${idx + 1}. [${item.count}次] ${item.text}`)
    .join('\n');
  const recentLines = (stats.recentShort || [])
    .slice(0, 25)
    .map((txt, idx) => `- ${txt}`)
    .join('\n');
  const builtinList = (Array.isArray(builtinPool) ? builtinPool : [])
    .map((b) => b.text || `/${b.slash || b.id}`)
    .filter(Boolean)
    .join(', ');

  return [
    '你是一位资深研发效能与交互体验工程师，擅长从用户的历史对话指令中提炼可复用的快捷提示词（Key-Value 映射）。',
    '请分析以下从用户全部历史会话中采集的真实手动输入消息（已按出现频次降序统计），提炼出 **最值得放进输入框上方快捷栏的高频可复用指令**。',
    '',
    '## 提炼规则',
    '1. **合并同义表达**：例如「提交pr」「提pr」「提交并推送」等相近表达应合并为一条最通用、最清晰的标准指令。',
    '2. **去除一次性噪声**：剔除具体项目名、临时 URL、一次性报错片段、单纯单字敷衍回复（如「好」「要」「嗯」）或过长定制需求。',
    `3. **排除已有内置项**：以下内置指令已存在，禁止重复输出：${builtinList || '/compact, /plan, /goal, /boost, 重新读取 AGENTS'}`,
    '4. **严格区分 UI 显示名（label）与实际填充命令（text）**：',
    '   - `label`：界面按钮展示名称，简洁直观（2~10 个字），如 `提交 PR`、`运行全测`、`继续执行`、`检查进度`、`同步文档`。',
    '   - `text`：点击按钮后实际填入输入框的完整提示词或命令（可直接执行的清晰指令），如 `请运行相关测试，确认无误后提交 PR 并推送分支` 或 `继续完成剩余步骤并验证`。',
    '   - `tag`：2~4 字短标签（如 `高频·3次`、`Git 协作`、`测试验证`）。',
    '   - `description`：一句简短说明（不超过 28 字），说明适用场景。',
    '   - `count`：对应历史合并后的大致频次整数。',
    '5. **数量限制**：返回 4~10 条最有价值、相互正交的候选条目，按实用价值与频次降序排列。',
    '',
    '## 输出格式要求（严格 JSON 数组）',
    '只输出纯 JSON 数组，不要包含任何解释文字、开场白或 Markdown 代码块包裹。每项格式：',
    '[{"label":"提交 PR","text":"请运行相关测试，确认通过后提交并创建 PR","tag":"Git 协作","description":"快速完成测试验证与 PR 提交","count":7}]',
    '',
    `## 历史高频手动输入统计（共扫描 ${stats.sessionsScanned || 0} 个会话 / ${stats.messagesScanned || 0} 条输入）`,
    repeatedLines || '(无重复统计)',
    '',
    '## 最近不重复短指令参考',
    recentLines || '(无)'
  ].join('\n');
}

function stripJsonCodeFences(raw = '') {
  let s = String(raw || '').trim();
  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    s = fenceMatch[1].trim();
  }
  const firstBracket = s.indexOf('[');
  const lastBracket = s.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    s = s.slice(firstBracket, lastBracket + 1);
  }
  return s;
}

function makeDeterministicFreqId(text = '') {
  const hash = crypto.createHash('sha1').update(String(text || '').trim().toLowerCase()).digest('hex').slice(0, 8);
  return `freq_${hash}`;
}

function parseFrequentPromptsResponse(rawResponse = '', builtinPool = BUILTIN_QUICK_POOL, nowIso = new Date().toISOString()) {
  const cleaned = stripJsonCodeFences(rawResponse);
  if (!cleaned) return [];
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : (Array.isArray(parsed?.items) ? parsed.items : (Array.isArray(parsed?.presets) ? parsed.presets : []));

  const builtinSet = buildBuiltinCommandSet(builtinPool);
  const seenText = new Set();
  const seenLabel = new Set();
  const results = [];

  for (const entry of arr) {
    if (!entry || typeof entry !== 'object') continue;
    const label = String(entry.label || entry.title || '').trim().slice(0, 24);
    const text = String(entry.text || entry.command || entry.content || '').trim();
    if (!label || !text) continue;

    const textKey = text.replace(/\s+/g, ' ').toLowerCase();
    const labelKey = label.toLowerCase();
    if (builtinSet.has(textKey) || seenText.has(textKey) || seenLabel.has(labelKey)) continue;

    seenText.add(textKey);
    seenLabel.add(labelKey);

    const count = Number.isFinite(Number(entry.count)) && Number(entry.count) > 0
      ? Math.round(Number(entry.count))
      : 0;
    const rawTag = String(entry.tag || '').trim().slice(0, 12);
    const tag = rawTag || (count > 1 ? `高频·${count}次` : 'AI提炼');
    const description = String(entry.description || '').trim().slice(0, 80);

    results.push({
      id: makeDeterministicFreqId(text),
      label,
      text,
      tag,
      description,
      source: 'llm-summary',
      count,
      autoSend: false,
      updatedAt: nowIso
    });
    if (results.length >= 10) break;
  }

  return results;
}

module.exports = {
  getDefaultBrainDirs,
  extractCleanManualPrompt,
  collectManualUserMessages,
  buildFrequentPromptsInstruction,
  parseFrequentPromptsResponse,
  makeDeterministicFreqId
};
