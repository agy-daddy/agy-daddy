'use strict';

const QUICK_PROMPT_GROUPS = Object.freeze([
  { id: 'daily', label: '🔥 日常高频与上下文', labelEn: '🔥 Daily & Context' },
  { id: 'heavy', label: '🚀 复杂攻坚与多 Agent', labelEn: '🚀 Heavy & Multi-Agent' },
  { id: 'tools', label: '🛠️ 会话工具与规则', labelEn: '🛠️ Session & Rules' }
]);

const BUILTIN_QUICK_POOL = [
  {
    id: 'compact',
    group: 'daily',
    label: '压缩上下文',
    labelEn: 'Compact',
    slash: 'compact',
    text: '/compact',
    rec: '★必开',
    recEn: '★Must',
    tag: '防卡死',
    tagEn: 'Anti-Stall',
    role: '触发官方本地压缩，将冗长历史浓缩为高密度摘要。',
    roleEn: 'Triggers native compaction to summarize long conversation history.',
    scene: '上下文超过 150K~240K、响应变慢，或切换下一阶段任务前。',
    sceneEn: 'When context exceeds 150K-240K, slows down, or before switching sub-tasks.',
    title: '压缩上下文（执行官方压缩命令），防止超 240K~300K 缓存过期卡死',
    titleEn: 'Compact context via native command',
    defaultEnabled: true
  },
  {
    id: 'plan',
    group: 'daily',
    label: '规划模式',
    labelEn: 'Plan',
    slash: 'plan',
    text: '/plan',
    rec: '★推荐',
    recEn: '★Rec',
    tag: '先谋后动',
    tagEn: 'Plan First',
    role: '切换规划模式，强制先读代码并给出方案，确认后再动手改文件。',
    roleEn: 'Enter planning mode to inspect code and propose a plan before editing.',
    scene: '涉及多文件改造、架构调整，想先审阅思路再让 AI 动手时。',
    sceneEn: 'Multi-file changes or architectural edits where you want to approve a plan first.',
    title: '进入或切换规划模式，先出方案再动手改代码',
    titleEn: 'Enter plan mode',
    defaultEnabled: true
  },
  {
    id: 'grill-me',
    group: 'daily',
    label: '追问对齐',
    labelEn: 'Clarify',
    slash: 'grill-me',
    text: '/grill-me',
    rec: '★推荐',
    recEn: '★Rec',
    tag: '需求澄清',
    tagEn: 'Clarify',
    role: '让 AI 像面试官一样连环追问，逐项确认模糊需求与边界条件。',
    roleEn: 'Have the AI interview you relentlessly to clarify requirements and edge cases.',
    scene: '只有一个大概想法、细节还没想透，怕 AI 自作主张乱写时。',
    sceneEn: 'When your idea is still rough and you want alignment before execution.',
    title: '让 AI 像面试一样主动追问，把模糊需求与边界全部对齐',
    titleEn: 'Interview me to align on requirements and plan',
    defaultEnabled: false
  },
  {
    id: 'btw',
    group: 'daily',
    label: '插话提问',
    labelEn: 'Side Q',
    slash: 'btw',
    text: '/btw',
    rec: '',
    recEn: '',
    tag: '旁路问答',
    tagEn: 'Side Q',
    role: '开启轻量旁路问答，不打断当前主线进度也不污染主上下文。',
    roleEn: 'Ask a quick side question without interrupting the main conversation flow.',
    scene: '主线正在跑任务，你想顺手确认某条语法、报错或无关知识点。',
    sceneEn: 'Quickly checking syntax or concepts without derailing the main task.',
    title: '不打断主线上下文，临时快速旁路提问',
    titleEn: 'Ask a quick side question without interrupting main chat',
    defaultEnabled: false
  },
  {
    id: 'learn',
    group: 'daily',
    label: '提炼经验',
    labelEn: 'Learn',
    slash: 'learn',
    text: '/learn',
    rec: '',
    recEn: '',
    tag: '规则沉淀',
    tagEn: 'Learn',
    role: '复盘本轮对话中你的纠正或成功路径，沉淀为可复用的规则或 Skill。',
    roleEn: 'Reflect on corrections or setups from this turn into reusable rules or skills.',
    scene: '费了多轮才教会 AI 某件事，希望它下次永远直接做对时。',
    sceneEn: 'After correcting the agent or solving a tricky setup to persist the workflow.',
    title: '复盘本轮纠偏与踩坑，沉淀为长期规则或 Skill',
    titleEn: 'Capture lessons learned as reusable skills or rules',
    defaultEnabled: false
  },
  {
    id: 'goal',
    group: 'heavy',
    label: '持续到底',
    labelEn: 'Goal',
    slash: 'goal',
    text: '/goal',
    rec: '★推荐',
    recEn: '★Rec',
    tag: '长程死磕',
    tagEn: 'Long Run',
    role: '开启长程目标循环模式，反复校验执行直到目标彻底达成。',
    roleEn: 'Run relentlessly toward the specified goal until every criterion is verified.',
    scene: '全量测试修完所有报错、批量机械重构、夜间挂机跑完长任务。',
    sceneEn: 'Fixing all failing tests, large refactors, or unattended long-horizon runs.',
    title: '启动长程自主目标模式，持续推进直到目标彻底完成',
    titleEn: 'Run until the specified goal is completely finished',
    defaultEnabled: true
  },
  {
    id: 'boost',
    group: 'heavy',
    label: '深度攻坚',
    labelEn: 'Boost',
    slash: 'boost',
    text: '/boost',
    rec: '★推荐',
    recEn: '★Rec',
    tag: '单点深研',
    tagEn: 'Deep Dive',
    role: '调用 Boost 多智能体编排器，深度推理并从多视角严格校验。',
    roleEn: 'Invoke the Boost multi-agent orchestrator for deep thinking and strict verification.',
    scene: '棘手疑难 Bug 反复修不好、复杂算法或需要严密论证的核心工程。',
    sceneEn: 'Hard bugs, intricate algorithms, or research/code needing rigorous verification.',
    title: '调用 Boost 多模型深度推理与严格验证编排',
    titleEn: 'Invoke Boost multi-agent orchestrator for complex tasks',
    defaultEnabled: false
  },
  {
    id: 'swarm',
    group: 'heavy',
    label: '蜂群并发',
    labelEn: 'Swarm',
    slash: 'swarm',
    text: '/swarm',
    rec: '',
    recEn: '',
    tag: '横向分包',
    tagEn: 'Parallel',
    role: '主 Agent 当协调者，在共享消息板上同时派多名工人+复核员并行分工。',
    roleEn: 'Spawn parallel workers collaborating through a shared message board.',
    scene: '可拆成多个互不冲突的子任务并行提速（改多文件/交叉审查，极耗额度）。',
    sceneEn: 'Independent subtasks that can run simultaneously or need peer verification (quota heavy).',
    title: '调度多个子 Agent 并发协作拆分复杂任务',
    titleEn: 'Spawn parallel agents collaborating on one task',
    defaultEnabled: false
  },
  {
    id: 'teamwork',
    group: 'heavy',
    label: '团队协作',
    labelEn: 'Teamwork',
    slash: 'teamwork',
    text: '/teamwork',
    rec: '',
    recEn: '',
    tag: '军团流水',
    tagEn: 'Pipeline',
    role: '拉起探查→拆解→求解→批判审校→修补 5 阶段专业 Agent 团队接管项目。',
    roleEn: 'Invoke an autonomous 5-phase team pipeline to tackle large projects end-to-end.',
    scene: '超大型工程重构或从零搭建完整大项目，希望团队全自动一条龙交付。',
    sceneEn: 'Large projects or greenfield builds best handled by a full autonomous team.',
    title: '调动自治 Agent 团队接管大型复杂项目',
    titleEn: 'Invoke autonomous agent team for large projects',
    defaultEnabled: false
  },
  {
    id: 'browser',
    group: 'heavy',
    label: '浏览器',
    labelEn: 'Browser',
    slash: 'browser',
    text: '/browser',
    rec: '',
    recEn: '',
    tag: '网页实操',
    tagEn: 'Web UI',
    role: '派遣内置浏览器子 Agent 访问网页、点击填表并截取视觉状态。',
    roleEn: 'Launch the browser subagent to navigate, click, fill forms, and inspect UI.',
    scene: '验证 localhost 前端页面表现、检查 UI 错位或跑通网页端交互流程。',
    sceneEn: 'Testing localhost web apps, verifying rendered UI, or interactive web flows.',
    title: '唤醒浏览器子 Agent 执行网页操作与核验',
    titleEn: 'Invoke browser agent for web tasks',
    defaultEnabled: false
  },
  {
    id: 'schedule',
    group: 'heavy',
    label: '定时任务',
    labelEn: 'Schedule',
    slash: 'schedule',
    text: '/schedule',
    rec: '',
    recEn: '',
    tag: '定时巡检',
    tagEn: 'Cron',
    role: '创建后台 Cron 周期巡检或一次性倒计时提醒任务，到点自动唤醒。',
    roleEn: 'Schedule a recurring cron job or a one-time delayed timer notification.',
    scene: '每 N 分钟巡检构建/服务状态，或约定稍后自动触发某项检查。',
    sceneEn: 'Periodic monitoring, polling builds, or setting a delayed reminder.',
    title: '创建定时轮询或一次性定时提醒任务',
    titleEn: 'Schedule a recurring cron or one-shot timer',
    defaultEnabled: false
  },
  {
    id: 'reload',
    group: 'tools',
    label: '重载规则',
    labelEn: 'Reload Rules',
    slash: '',
    text: '重新读取 AGENTS',
    rec: '★默认',
    recEn: '★Default',
    tag: '恢复约束',
    tagEn: 'Rules',
    role: '一键填入「重新读取 AGENTS」，让 AI 立刻重新加载全局行为规则。',
    roleEn: 'Insert "Reload AGENTS" so the agent immediately re-reads ~/.codex/AGENTS.md.',
    scene: '刚改完 AGENTS.md 配置文件，或长对话后觉得 AI 忘了约定规矩时。',
    sceneEn: 'Right after editing AGENTS.md or when guidelines start drifting in long chats.',
    title: '让 AI 重新读取 ~/.codex/AGENTS.md 行为规则',
    titleEn: 'Fill reload AGENTS prompt',
    defaultEnabled: true
  }
];

const DEFAULT_QUICK_ITEMS = Object.freeze([
  'compact',
  'plan',
  'goal',
  'reload'
]);

const MIGRATED_REMOVED_BUILTIN_IDS = Object.freeze(new Set(['copyid', 'export']));

const DEFAULT_OPTIMIZER_SHORTCUT = 'Alt+Shift+O';

const DEFAULT_OPTIMIZER_PROMPT = [
  '你是一位精通 Google Cloud 提示工程（Prompt Engineering）原则的提示词优化专家。',
  '你的唯一任务是将 `<draft>` 标签内的用户原始提示词草稿，改写并优化为更清晰、具体、高质量的提示词，供软件工程与通用 AI 助手直接执行。',
  '',
  '## 提示词优化准则',
  '1. **明确任务与具体性（Clarity & Specificity）**：消除口语化模糊表达与指代不明，使用清晰的动作动词界定核心目标。',
  '2. **语境与角色定位（Context & Persona）**：根据任务性质自然提炼所需专业视角与作用范围；严禁编造草稿中未提及的业务事实、文件路径、接口名或参数。',
  '3. **复杂任务分步拆解（Step-by-Step Breakdown）**：若原草稿包含多个需求或复杂目标，拆解为逻辑清晰的有序步骤；若原草稿只是简单直接的单步指令，则保持精炼紧凑，不要强行扩写成冗长模板。',
  '4. **明确边界与输出格式（Constraints & Output Format）**：按需补充合理的边界约束、验收标准或期望的输出结构。',
  '5. **格式与标识符保真（Strict Preservation）**：',
  '   - 保持与原草稿一致的自然语言（中文输入则输出中文，英文输入则输出英文）；',
  '   - 原样保留草稿中的所有文件路径、代码片段、变量/函数名、URL 与 `@` 引用。',
  '',
  '> **重要限制**：不要回答、执行或解释 `<draft>` 中的问题！只直接输出优化后的提示词正文，不要包含任何开场白、解释说明、引号或外层代码块包裹。'
].join('\n');

const SHORTCUT_KEY_ALIAS = Object.freeze({
  SPACE: 'SPACE',
  ' ': 'SPACE',
  SPACEBAR: 'SPACE',
  ENTER: 'ENTER',
  RETURN: 'ENTER',
  TAB: 'TAB',
  ESC: 'ESCAPE',
  ESCAPE: 'ESCAPE',
  SLASH: '/',
  BACKQUOTE: '`',
  MINUS: '-',
  EQUAL: '=',
  BRACKETLEFT: '[',
  BRACKETRIGHT: ']',
  BACKSLASH: '\\',
  SEMICOLON: ';',
  QUOTE: "'",
  COMMA: ',',
  PERIOD: '.',
  ARROWUP: 'ARROWUP',
  UP: 'ARROWUP',
  ARROWDOWN: 'ARROWDOWN',
  DOWN: 'ARROWDOWN',
  ARROWLEFT: 'ARROWLEFT',
  LEFT: 'ARROWLEFT',
  ARROWRIGHT: 'ARROWRIGHT',
  RIGHT: 'ARROWRIGHT'
});

function normalizeShortcutTokenKey(rawKey = '') {
  const k = String(rawKey || '').trim();
  if (!k) return '';
  const upper = k.toUpperCase();
  if (Object.prototype.hasOwnProperty.call(SHORTCUT_KEY_ALIAS, upper)) {
    return SHORTCUT_KEY_ALIAS[upper];
  }
  return upper;
}

function parseShortcutSpec(shortcutStr = '') {
  const raw = String(shortcutStr || '').trim();
  if (!raw) return null;
  const parts = raw.split('+').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  const spec = { ctrl: false, meta: false, mod: false, alt: false, shift: false, key: '' };
  for (const part of parts) {
    const low = part.toLowerCase();
    if (low === 'ctrl' || low === 'control') {
      spec.ctrl = true;
    } else if (low === 'cmd' || low === 'meta' || low === 'command' || low === 'super') {
      spec.meta = true;
    } else if (low === 'mod' || low === 'cmdorctrl') {
      spec.mod = true;
    } else if (low === 'alt' || low === 'option' || low === 'opt') {
      spec.alt = true;
    } else if (low === 'shift') {
      spec.shift = true;
    } else if (!spec.key) {
      spec.key = normalizeShortcutTokenKey(part);
    } else {
      return null;
    }
  }
  return spec.key ? spec : null;
}

function resolveEventShortcutKey(event) {
  const code = String(event?.code || '');
  if (/^Key([A-Z])$/.test(code)) return code.slice(3);
  if (/^Digit([0-9])$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  if (code) {
    const mapped = normalizeShortcutTokenKey(code);
    if (mapped && mapped !== code.toUpperCase()) return mapped;
    if (code === 'Space' || code === 'Enter' || code === 'Tab' || /^Arrow(?:Up|Down|Left|Right)$/.test(code)) {
      return mapped;
    }
  }
  return normalizeShortcutTokenKey(event?.key || '');
}

function matchesShortcutEvent(event, shortcutStr = '') {
  if (!event) return false;
  const spec = parseShortcutSpec(shortcutStr);
  if (!spec) return false;

  const evCtrl = Boolean(event.ctrlKey);
  const evMeta = Boolean(event.metaKey);
  const evAlt = Boolean(event.altKey);
  const evShift = Boolean(event.shiftKey);

  if (spec.mod) {
    if (!(evCtrl || evMeta)) return false;
  } else {
    if (evCtrl !== spec.ctrl) return false;
    if (evMeta !== spec.meta) return false;
  }
  if (evAlt !== spec.alt) return false;
  if (evShift !== spec.shift) return false;

  const codeKey = resolveEventShortcutKey(event);
  const rawKey = normalizeShortcutTokenKey(event.key || '');
  return codeKey === spec.key || rawKey === spec.key;
}

function truncateGhostLabel(text = '', maxChars = 8) {
  const s = String(text || '').trim();
  const limit = Number(maxChars) > 0 ? Number(maxChars) : 8;
  const chars = Array.from(s);
  if (chars.length <= limit) return s;
  return `${chars.slice(0, limit).join('')}…`;
}

function splitSlashDraft(rawInput = '') {
  const trimmed = String(rawInput || '').trim();
  if (!trimmed) return { slashPrefix: '', draftBody: '', isSlashOnly: false };
  const slashMatch = trimmed.match(/^(\/[a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/);
  if (slashMatch) {
    const slashPrefix = slashMatch[1];
    const draftBody = (slashMatch[2] || '').trim();
    return {
      slashPrefix,
      draftBody,
      isSlashOnly: !draftBody
    };
  }
  return { slashPrefix: '', draftBody: trimmed, isSlashOnly: false };
}

function buildPromptOptimizeInstruction(draftText = '', customTemplate = '') {
  const draft = String(draftText || '').trim();
  const base = String(customTemplate || '').trim() || DEFAULT_OPTIMIZER_PROMPT;
  if (base.includes('{{draft}}')) {
    return base.replace(/\{\{draft\}\}/g, draft);
  }
  return `${base}\n\n<draft>\n${draft}\n</draft>`;
}

function cleanOptimizedPromptOutput(raw = '', slashPrefix = '') {
  let out = String(raw || '').replace(/\r\n?/g, '\n').trim();
  out = out.replace(/^<draft>\s*/i, '').replace(/\s*<\/draft>$/i, '').trim();
  const fenceMatch = out.match(/^```(?:markdown|md|text|txt|prompt)?\r?\n([\s\S]*?)\r?\n```$/i);
  if (fenceMatch) {
    out = fenceMatch[1].trim();
  }
  if (slashPrefix && out) {
    const cleanPrefix = slashPrefix.trim();
    const escapedPrefix = cleanPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`^${escapedPrefix}\\s*`), '').trim();
    return `${cleanPrefix} ${out}`;
  }
  return out;
}

function scoreOptimizeModelCandidate(entry, isDefaultOverride = false) {
  const mid = String(entry?.modelId || '').toLowerCase();
  const label = String(entry?.label || '').toLowerCase();
  const model = String(entry?.model || '').toLowerCase();
  const text = `${mid} ${label} ${model}`;
  const remaining = entry?.remainingFraction;
  const exhaustedPenalty = (typeof remaining === 'number' && Number.isFinite(remaining) && remaining <= 0) ? 200 : 0;

  let baseScore = 50;
  if (text.includes('orchestrator')) {
    baseScore = 90;
  } else if (text.includes('flash')) {
    if (text.includes('low') || text.includes('lite')) baseScore = 10;
    else if (text.includes('medium')) baseScore = 15;
    else if (text.includes('high') || text.includes('xhigh')) baseScore = 24;
    else baseScore = 18;
  } else if (text.includes('sonnet') && text.includes('low')) {
    baseScore = 20;
  } else if (/\b(?:haiku|mini|lite)\b|gpt[-_]oss/i.test(text)) {
    baseScore = 22;
  } else if (/\blow\b|\(low\)|-low\b|_low\b/.test(text)) {
    baseScore = 26;
  } else if (/\bmedium\b|\(medium\)|-medium\b|_medium\b/.test(text)) {
    baseScore = 36;
  } else if (/\bxhigh\b|\(xhigh\)|-xhigh\b|_xhigh\b/.test(text)) {
    baseScore = 72;
  } else if (/\bhigh\b|\(high\)|-high\b|_high\b/.test(text)) {
    baseScore = 62;
  } else if (isDefaultOverride) {
    baseScore = 44;
  }

  return baseScore + exhaustedPenalty;
}

function detectOptimizeModelFamily(entry) {
  const text = `${entry?.modelId || ''} ${entry?.label || ''} ${entry?.model || ''}`.toLowerCase();
  if (text.includes('orchestrator')) return 'orchestrator';
  if (text.includes('claude') || text.includes('sonnet') || text.includes('opus') || text.includes('haiku')) return 'claude';
  if (text.includes('gpt') || text.includes('openai')) return 'openai';
  if (text.includes('flash')) return 'gemini-flash';
  if (text.includes('gemini')) return 'gemini';
  return 'other';
}

function buildOptimizeModelCandidates(cfgData) {
  if (!cfgData || typeof cfgData !== 'object') return [];
  const configs = Array.isArray(cfgData.clientModelConfigs) ? cfgData.clientModelConfigs : [];
  const primaryOverride = String(cfgData.defaultOverrideModelConfig?.modelOrAlias?.model || '').trim();
  const byModel = new Map();

  configs.forEach((c, idx) => {
    const model = String(c?.modelOrAlias?.model || '').trim();
    if (!model || byModel.has(model)) return;
    const item = {
      model,
      modelId: String(c?.modelId || '').trim(),
      label: String(c?.label || c?.modelId || model).trim(),
      remainingFraction: typeof c?.quotaInfo?.remainingFraction === 'number' ? c.quotaInfo.remainingFraction : null,
      isDefaultOverride: model === primaryOverride,
      idx
    };
    item.score = scoreOptimizeModelCandidate(item, item.isDefaultOverride);
    item.family = detectOptimizeModelFamily(item);
    byModel.set(model, item);
  });

  if (primaryOverride && !byModel.has(primaryOverride)) {
    const item = {
      model: primaryOverride,
      modelId: '',
      label: primaryOverride,
      remainingFraction: null,
      isDefaultOverride: true,
      idx: configs.length
    };
    item.score = scoreOptimizeModelCandidate(item, true);
    item.family = detectOptimizeModelFamily(item);
    byModel.set(primaryOverride, item);
  }

  const sorted = Array.from(byModel.values()).sort((a, b) => (a.score - b.score) || (a.idx - b.idx));
  if (sorted.length <= 4) {
    return sorted.map(({ model, modelId, label, family, score }) => ({ model, modelId, label, family, score }));
  }

  const picked = [];
  const pickedModels = new Set();
  const pushItem = (item) => {
    if (!item || pickedModels.has(item.model)) return;
    pickedModels.add(item.model);
    picked.push(item);
  };

  pushItem(sorted[0]);
  const crossFamily = sorted.find((it) => !pickedModels.has(it.model) && it.family !== sorted[0].family && it.score < 200);
  if (crossFamily) pushItem(crossFamily);
  for (const it of sorted) {
    if (picked.length >= 3) break;
    pushItem(it);
  }
  if (primaryOverride && !pickedModels.has(primaryOverride) && byModel.has(primaryOverride)) {
    pushItem(byModel.get(primaryOverride));
  }
  for (const it of sorted) {
    if (picked.length >= 4) break;
    pushItem(it);
  }
  return picked.map(({ model, modelId, label, family, score }) => ({ model, modelId, label, family, score }));
}

function formatQuickItemDisplayLabel(rawLabel = '', item = null, builtinPool = BUILTIN_QUICK_POOL) {
  let clean = String(rawLabel || '').trim();
  if (!clean && item && typeof item === 'object') {
    clean = String(item.label || item.id || '').trim();
  }
  const withDescMatch = clean.match(/^\/[a-zA-Z][\w-]*\s+(.+)$/);
  if (withDescMatch) {
    return withDescMatch[1].trim();
  }
  const bareSlashMatch = clean.match(/^\/([a-zA-Z][\w-]*)$/);
  if (bareSlashMatch) {
    const cmd = bareSlashMatch[1].toLowerCase();
    const hit = Array.isArray(builtinPool)
      ? builtinPool.find((b) => String(b.slash || '').toLowerCase() === cmd || String(b.id || '').toLowerCase() === cmd)
      : null;
    return hit ? hit.label : bareSlashMatch[1];
  }
  return clean;
}

function parseSlashCommandText(rawText = '', itemMeta = null) {
  const raw = String(rawText ?? '');
  const trimmed = raw.trim();
  const match = trimmed.match(/^\/([a-zA-Z0-9][a-zA-Z0-9_-]*)(?:\s+([\s\S]*))?$/);
  if (match) {
    const slash = match[1];
    return {
      slash,
      commandText: `/${slash}`,
      restText: (match[2] || '').trim()
    };
  }
  const metaSlash = String(itemMeta?.slash || '').trim().replace(/^\/+/, '');
  if (!trimmed && metaSlash && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(metaSlash)) {
    return {
      slash: metaSlash,
      commandText: `/${metaSlash}`,
      restText: ''
    };
  }
  return {
    slash: '',
    commandText: raw,
    restText: ''
  };
}

function parseQuickItemEntry(entry, builtinPool = BUILTIN_QUICK_POOL) {
  if (!entry) return null;
  if (typeof entry === 'object') {
    const id = String(entry.id || '').trim();
    const rawLabel = String(entry.label || id).trim();
    if (!id && !rawLabel) return null;
    if (MIGRATED_REMOVED_BUILTIN_IDS.has(id) && (entry.builtinAction === 'copyid' || entry.builtinAction === 'export' || !String(entry.text || '').trim())) {
      return null;
    }
    const builtin = id ? builtinPool.find((b) => b.id === id) : null;
    if (builtin) {
      const displayLabel = formatQuickItemDisplayLabel(rawLabel, builtin, builtinPool);
      const rawText = entry.text !== undefined ? String(entry.text) : builtin.text;
      const parsedText = parseSlashCommandText(rawText, builtin);
      const normalizedText = (parsedText.slash && !parsedText.restText) ? parsedText.commandText : rawText;
      return {
        ...builtin,
        ...entry,
        id: builtin.id,
        label: displayLabel || builtin.label,
        text: normalizedText,
        autoSend: entry.autoSend !== undefined ? Boolean(entry.autoSend) : builtin.id === 'compact'
      };
    }
    const textStr = String(entry.text || '');
    const parsedCustom = parseSlashCommandText(textStr, entry);
    const normalizedText = (parsedCustom.slash && !parsedCustom.restText) ? parsedCustom.commandText : textStr;
    const inferredSlash = entry.slash ? String(entry.slash).trim().replace(/^\/+/, '') : parsedCustom.slash;
    const label = formatQuickItemDisplayLabel(rawLabel, { id, slash: inferredSlash }, builtinPool) || rawLabel;
    return {
      id: id || `custom_${label}`,
      group: String(entry.group || 'custom'),
      label,
      text: normalizedText,
      slash: inferredSlash,
      tag: entry.tag ? String(entry.tag) : '',
      description: entry.description ? String(entry.description) : '',
      source: entry.source ? String(entry.source) : 'custom',
      autoSend: Boolean(entry.autoSend),
      role: String(entry.role || entry.title || label),
      scene: String(entry.scene || entry.description || '自定义快捷指令'),
      builtin: false
    };
  }
  const raw = String(entry).trim();
  if (!raw) return null;
  if (MIGRATED_REMOVED_BUILTIN_IDS.has(raw)) {
    return null;
  }
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return parseQuickItemEntry(parsed, builtinPool);
      }
    } catch {}
  }
  const hit = builtinPool.find((b) => b.id === raw);
  if (hit) {
    return {
      ...hit,
      autoSend: hit.id === 'compact',
      builtin: true
    };
  }
  const cleanLabel = formatQuickItemDisplayLabel(raw, null, builtinPool) || raw;
  const parsedRaw = parseSlashCommandText(raw);
  return {
    id: raw,
    group: 'custom',
    label: cleanLabel,
    text: (parsedRaw.slash && !parsedRaw.restText) ? parsedRaw.commandText : raw,
    slash: parsedRaw.slash,
    autoSend: false,
    role: cleanLabel,
    scene: '自定义快捷指令',
    builtin: false
  };
}

function resolveConfiguredQuickItems({ quickItems = null, quickPoolState = null, customQuickPrompts = [] } = {}, builtinPool = BUILTIN_QUICK_POOL) {
  const ordered = [];
  const seen = new Set();
  const pushUnique = (item) => {
    if (!item || !item.id || seen.has(item.id)) return;
    seen.add(item.id);
    ordered.push(item);
  };

  if (Array.isArray(quickItems)) {
    for (const rawEntry of quickItems) {
      pushUnique(parseQuickItemEntry(rawEntry, builtinPool));
    }
    for (const c of (Array.isArray(customQuickPrompts) ? customQuickPrompts : [])) {
      pushUnique(parseQuickItemEntry(c, builtinPool));
    }
    return ordered;
  }

  const poolState = quickPoolState && typeof quickPoolState === 'object' ? quickPoolState : {};
  for (const grp of QUICK_PROMPT_GROUPS) {
    for (const item of builtinPool) {
      if (item.group !== grp.id) continue;
      const enabled = typeof poolState[item.id] === 'boolean' ? poolState[item.id] : Boolean(item.defaultEnabled);
      if (enabled) pushUnique({ ...item, autoSend: item.id === 'compact', builtin: true });
    }
  }
  for (const c of (Array.isArray(customQuickPrompts) ? customQuickPrompts : [])) {
    pushUnique(parseQuickItemEntry(c, builtinPool));
  }
  return ordered;
}

function resolveContextualQuickItems({
  baseItems = [],
  pool = BUILTIN_QUICK_POOL,
  contextSnap = null,
  isNewChat = false,
  isAssistantBusy = false,
  lastAssistantText = '',
  enabled = true
} = {}) {
  const list = Array.isArray(baseItems) ? baseItems.map((it) => ({ ...it })) : [];
  const used = Number(contextSnap?.used || 0);
  const percent = Number(contextSnap?.percent || 0);
  const cliffRisk = String(contextSnap?.cacheCliffRisk || '');
  const cacheDrop = Boolean(contextSnap?.cacheDropDetected);

  let contextRisk = '';
  if (cacheDrop || cliffRisk === 'critical' || used >= 328000) {
    contextRisk = 'danger';
  } else if (cliffRisk === 'warn' || used >= 240000 || percent >= 65) {
    contextRisk = 'warn';
  }

  const annotateCompactRisk = (items) => items.map((it) => (
    it.id === 'compact' && contextRisk ? { ...it, risk: contextRisk } : it
  ));

  if (!enabled) {
    return annotateCompactRisk(list);
  }

  const byPoolId = new Map((Array.isArray(pool) ? pool : []).map((p) => [p.id, p]));
  let working = list;

  if (isNewChat) {
    const newChatHidden = new Set(['compact']);
    working = working.filter((it) => !newChatHidden.has(it.id));
  }

  const seenIds = new Set(working.map((it) => it.id));
  const extraSuggestions = [];
  const addSuggestion = (id, reason) => {
    if (seenIds.has(id) || extraSuggestions.length >= 2) return;
    const preset = byPoolId.get(id);
    if (!preset) return;
    seenIds.add(id);
    extraSuggestions.push({
      ...preset,
      autoSend: preset.id === 'compact',
      builtin: true,
      contextSuggested: true,
      contextReason: reason
    });
  };

  if (isNewChat) {
    addSuggestion('plan', '新建对话推荐：先谋后动');
    addSuggestion('grill-me', '新建对话推荐：追问澄清需求');
    addSuggestion('goal', '新建对话推荐：开启长程自主执行');
  }

  if (contextRisk) {
    const existingCompactIdx = working.findIndex((it) => it.id === 'compact');
    if (existingCompactIdx >= 0) {
      working[existingCompactIdx] = { ...working[existingCompactIdx], risk: contextRisk };
      if (contextRisk === 'danger' && existingCompactIdx > 0) {
        const [compactItem] = working.splice(existingCompactIdx, 1);
        working.unshift(compactItem);
      }
    } else if (!isNewChat) {
      const compactPreset = byPoolId.get('compact');
      if (compactPreset) {
        const injected = {
          ...compactPreset,
          autoSend: true,
          builtin: true,
          risk: contextRisk,
          contextSuggested: true,
          contextReason: contextRisk === 'danger' ? '上下文高危：建议立即压缩' : '上下文偏高：建议适时压缩'
        };
        if (contextRisk === 'danger') {
          working.unshift(injected);
        } else {
          working.push(injected);
        }
        seenIds.add('compact');
      }
    }
  }

  if (isAssistantBusy) {
    addSuggestion('btw', '生成中：不打断主线旁路提问');
  }

  const reply = String(lastAssistantText || '').trim();
  if (reply && !isNewChat) {
    const recent = reply.slice(-700);
    const tail = reply.slice(-180);
    if (hasUnnegatedError(recent, tail)) {
      addSuggestion('boost', '检测到报错/测试失败：深度定位修复');
    }
    if (/(?:localhost|127\.0\.0\.1|browser|webview|dom|css|界面|页面|按钮|样式)/i.test(recent)) {
      addSuggestion('browser', '检测到前端/网页上下文：唤醒浏览器核验');
    }
    if (/(?:已完成|已修复|all\s+pass|passed|0\s*failed|committed|done|搞定|验证通过)/i.test(recent)) {
      addSuggestion('learn', '阶段任务完成：可沉淀为规则或 Skill');
    }
  }

  return annotateCompactRisk([...working, ...extraSuggestions]);
}

function hasUnnegatedError(recentText = '', tailText = '') {
  const txt = String(recentText || '');
  const tail = String(tailText || txt.slice(-180));
  if (!txt || /(?:已修复|验证通过|PASSED|0\s*failed)/i.test(tail)) return false;
  const re = /(?:报错|失败|异常|未通过|Error:|Exception|exited with code [1-9])/gi;
  let m;
  while ((m = re.exec(txt)) !== null) {
    const before = txt.slice(Math.max(0, m.index - 4), m.index);
    if (/(?:不|无|没有|未见|未发现|未|零|0\s*|避免|防止|防|非)$/.test(before)) continue;
    return true;
  }
  return false;
}

function selectOptimizerCandidates(availableModels = [], quotaSnapshot = null) {
  const list = Array.isArray(availableModels)
    ? availableModels
    : Object.entries(availableModels || {}).map(([id, m]) => ({ model: m?.model || m?.modelId || id, ...(m || {}) }));

  const geminiExhausted = quotaSnapshot?.gemini?.isExhausted === true || quotaSnapshot?.gemini?.remainingFraction === 0;
  const claudeExhausted = quotaSnapshot?.claude?.isExhausted === true || quotaSnapshot?.claude?.remainingFraction === 0;

  const scored = [];
  for (const raw of list) {
    const modelId = String(raw?.model || raw?.modelId || raw?.id || raw || '').trim();
    if (!modelId || raw?.disabled === true) continue;
    const lower = modelId.toLowerCase();
    const is3p = lower.includes('claude') || lower.includes('gpt-oss');
    if (is3p && claudeExhausted) continue;
    if (!is3p && geminiExhausted) continue;
    if (typeof raw?.remainingFraction === 'number' && raw.remainingFraction <= 0) continue;

    let score = 10;
    if (/flash-lite|lite/i.test(lower)) score += 100;
    else if (/flash/i.test(lower)) score += 85;
    else if (/argon/i.test(lower)) score += 70;
    else if (/carbon/i.test(lower)) score += 60;
    else if (/mini|haiku/i.test(lower)) score += 50;
    else if (/hydrogen|pro/i.test(lower)) score += 30;
    if (typeof raw?.remainingFraction === 'number') {
      score += Math.round(raw.remainingFraction * 20);
    }
    scored.push({ model: modelId, displayName: raw?.displayName || modelId, score });
  }

  scored.sort((a, b) => b.score - a.score || a.model.localeCompare(b.model));
  if (scored.length === 0 && list.length === 0) {
    return [
      { model: 'gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash Lite', score: 110 },
      { model: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', score: 95 },
      { model: 'gemini-4-argon', displayName: 'Gemini 4 Argon', score: 80 }
    ];
  }
  return scored;
}

function getGhostSuggestions(lastAssistantText = '', opts = {}) {
  const fullText = String(lastAssistantText || '').trim();
  const recent = fullText.slice(-700);
  const tail = fullText.slice(-180);
  const list = [];
  const addCandidate = (txt) => {
    if (txt && !list.includes(txt)) list.push(txt);
  };

  if (!fullText) {
    addCandidate('先帮我梳理下当前任务并给出方案');
    addCandidate('/plan');
    addCandidate('重新读取 AGENTS');
    return list;
  }

  const asksConfirm = /(?:请确认|是否确认|是否合适|确认后|是否继续|你倾向于|请选择|方案\s*[A-Z1-9]|选项\s*[A-Z1-9])/i.test(recent);
  const hasRecommend = /(?:推荐|方案\s*[A1](?!\d))/.test(recent);
  const asksQuestion = /[？?]\s*$/.test(tail);
  const hasError = hasUnnegatedError(recent, tail);
  const hasDoneOrPushed = /(?:已提交|已推送|origin\/main|commit\s+[0-9a-f]{6,}|验证通过|全部组件显示\s*✅|PASSED|0\s*failed)/i.test(recent);
  const mentionsCodeChange = /(?:已修改|已新增|已修复|文件修改|函数|补丁|\.(?:js|ts|tsx|py|sh|md|json)\b)/i.test(recent);

  if (asksConfirm) {
    if (hasRecommend) addCandidate('确认，按推荐方案执行');
    addCandidate('确认，直接按这个方案落地');
    addCandidate('先微调一下方案细节：');
  } else if (asksQuestion) {
    addCandidate('好，就按你说的执行');
  }

  if (hasError) {
    addCandidate('分析报错原因并直接修复');
    addCandidate('贴一下关键报错原因并给出修复方案');
  }

  if (mentionsCodeChange && !hasDoneOrPushed) {
    addCandidate('运行测试验证，通过后提交并推送');
    addCandidate('先跑一遍实测看看效果');
  }

  if (hasDoneOrPushed) {
    addCandidate('检查还有没有遗漏的边界情况');
    addCandidate('继续处理下一个问题');
  }

  const snap = opts?.contextSnap || null;
  const used = Number(snap?.used || 0);
  const percent = Number(snap?.percent || 0);
  const cacheDrop = Boolean(snap?.cacheDropDetected);
  const cliff = String(snap?.cacheCliffRisk || '');
  if (cacheDrop || cliff === 'critical' || used >= 328000) {
    const existingIdx = list.indexOf('/compact');
    if (existingIdx >= 0) list.splice(existingIdx, 1);
    list.unshift('/compact');
  } else if (cliff === 'warn' || used >= 240000 || percent >= 65) {
    addCandidate('/compact');
  }

  addCandidate('继续下一步');
  addCandidate('展开说说具体细节');

  return list.slice(0, 4);
}

function optimizePromptText(rawInput = '') {
  const clean = String(rawInput || '').trim().replace(/\s+/g, ' ');
  if (!clean) return '';
  if (clean.length < 16 && !/[？?。!！]$/.test(clean)) {
    return `${clean}（请先定位相关代码与约束，再执行并附带验证结果）`;
  }
  return clean;
}

module.exports = {
  QUICK_PROMPT_GROUPS,
  BUILTIN_QUICK_POOL,
  DEFAULT_QUICK_ITEMS,
  DEFAULT_OPTIMIZER_SHORTCUT,
  DEFAULT_OPTIMIZER_PROMPT,
  parseShortcutSpec,
  matchesShortcutEvent,
  truncateGhostLabel,
  parseSlashCommandText,
  splitSlashDraft,
  buildPromptOptimizeInstruction,
  cleanOptimizedPromptOutput,
  scoreOptimizeModelCandidate,
  detectOptimizeModelFamily,
  buildOptimizeModelCandidates,
  formatQuickItemDisplayLabel,
  parseQuickItemEntry,
  resolveConfiguredQuickItems,
  resolveContextualQuickItems,
  hasUnnegatedError,
  selectOptimizerCandidates,
  getGhostSuggestions,
  optimizePromptText
};
