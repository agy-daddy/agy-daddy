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
    label: '/compact 压缩',
    labelEn: '/compact',
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
    title: '压缩上下文（执行官方 /compact 命令），防止超 240K~300K 缓存过期卡死',
    titleEn: 'Compact context via native /compact command',
    defaultEnabled: true
  },
  {
    id: 'plan',
    group: 'daily',
    label: '/plan 规划',
    labelEn: '/plan',
    slash: 'plan',
    text: '/plan ',
    rec: '★推荐',
    recEn: '★Rec',
    tag: '先谋后动',
    tagEn: 'Plan First',
    role: '切换规划模式，强制先读代码并给出方案，确认后再动手改文件。',
    roleEn: 'Enter planning mode to inspect code and propose a plan before editing.',
    scene: '涉及多文件改造、架构调整，想先审阅思路再让 AI 动手时。',
    sceneEn: 'Multi-file changes or architectural edits where you want to approve a plan first.',
    title: '进入或切换规划模式，先出方案再动手改代码',
    titleEn: 'Enter plan mode via /plan',
    defaultEnabled: true
  },
  {
    id: 'grill-me',
    group: 'daily',
    label: '/grill-me 追问对齐',
    labelEn: '/grill-me',
    slash: 'grill-me',
    text: '/grill-me ',
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
    label: '/btw 插话提问',
    labelEn: '/btw',
    slash: 'btw',
    text: '/btw ',
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
    label: '/learn 提炼经验',
    labelEn: '/learn',
    slash: 'learn',
    text: '/learn ',
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
    label: '/goal 持续到底',
    labelEn: '/goal',
    slash: 'goal',
    text: '/goal ',
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
    label: '/boost 深度攻坚',
    labelEn: '/boost',
    slash: 'boost',
    text: '/boost ',
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
    label: '/swarm 蜂群并发',
    labelEn: '/swarm',
    slash: 'swarm',
    text: '/swarm ',
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
    label: '/teamwork 团队协作',
    labelEn: '/teamwork',
    slash: 'teamwork',
    text: '/teamwork ',
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
    label: '/browser 浏览器',
    labelEn: '/browser',
    slash: 'browser',
    text: '/browser ',
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
    label: '/schedule 定时任务',
    labelEn: '/schedule',
    slash: 'schedule',
    text: '/schedule ',
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
  },
  {
    id: 'copyid',
    group: 'tools',
    label: '复制会话 ID',
    labelEn: 'Copy ID',
    slash: '',
    text: '',
    builtinAction: 'copyid',
    rec: '★默认',
    recEn: '★Default',
    tag: '快速取值',
    tagEn: 'Copy ID',
    role: '一键提取并复制当前对话窗口的唯一会话 UUID。',
    roleEn: 'Extract and copy the current conversation UUID to the clipboard.',
    scene: '需要在终端定位当前会话日志，或在另一扇窗口中引用本会话时。',
    sceneEn: 'Checking session transcript logs or referencing this conversation elsewhere.',
    title: '一键复制当前对话窗口的会话 ID',
    titleEn: 'Copy current conversation ID',
    defaultEnabled: true
  },
  {
    id: 'export',
    group: 'tools',
    label: '导出 Markdown',
    labelEn: 'Export MD',
    slash: '',
    text: '',
    builtinAction: 'export',
    rec: '★默认',
    recEn: '★Default',
    tag: '对话归档',
    tagEn: 'Archive',
    role: '将当前完整对话导出为 Markdown 保存到 ~/Downloads 并复制。',
    roleEn: 'Export the full conversation as Markdown to ~/Downloads and copy it.',
    scene: '重要问题排查过程归档留存、发给他人复盘或跨工具交接上下文。',
    sceneEn: 'Archiving troubleshooting records, sharing logs, or migrating context.',
    title: '将完整对话导出为 Markdown 保存到 ~/Downloads 并复制',
    titleEn: 'Export conversation to Markdown in ~/Downloads and copy',
    defaultEnabled: true
  }
];

function truncateGhostLabel(text = '', maxChars = 8) {
  const s = String(text || '').trim();
  const limit = Number(maxChars) > 0 ? Number(maxChars) : 8;
  const chars = Array.from(s);
  if (chars.length <= limit) return s;
  return `${chars.slice(0, limit).join('')}…`;
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

function getGhostSuggestions(lastAssistantText = '') {
  const txt = String(lastAssistantText || '').toLowerCase();
  if (/test|测试|失败|error/.test(txt)) {
    return ['定位具体失败用例并修复', '补充边界回归测试并重跑验证'];
  }
  if (/plan|方案|设计/.test(txt)) {
    return ['按计划逐步实施', '检查未决约束与回退方案'];
  }
  return ['继续验证关键路径', '汇总变更与测试结果'];
}

function optimizePromptText(rawInput = '') {
  const clean = String(rawInput || '').trim().replace(/\s+/g, ' ');
  if (!clean) return '';
  if (clean.length < 16 && !/[？?。!！]$/.test(clean)) {
    return `${clean}（请先定位相关代码与约束，再执行并附带验证结果）`;
  }
  return clean;
}

function exportConversationMarkdown(steps = [], meta = {}) {
  const title = String(meta.title || meta.cascadeId || 'Antigravity Conversation').trim();
  const lines = [`# ${title}`, ''];
  if (meta.cascadeId) lines.push(`- Session ID: \`${meta.cascadeId}\``);
  if (meta.model) lines.push(`- Model: \`${meta.model}\``);
  lines.push('');

  for (let i = 0; i < (Array.isArray(steps) ? steps.length : 0); i++) {
    const s = steps[i] || {};
    if (s.userInput) {
      const text = s.userInput.userResponse || (s.userInput.items || []).map((it) => it.text || '').join('\n');
      lines.push(`## Turn ${i + 1} · User`, '', String(text || '').trim(), '');
    } else if (s.plannerResponse) {
      const thinking = String(s.plannerResponse.thinking || '').trim();
      const resp = String(s.plannerResponse.modifiedResponse || s.plannerResponse.response || '').trim();
      lines.push(`## Turn ${i + 1} · Assistant`, '');
      if (thinking) {
        lines.push('<details><summary>Thinking</summary>', '', thinking, '', '</details>', '');
      }
      if (resp) lines.push(resp, '');
    }
  }
  return lines.join('\n').trim() + '\n';
}

module.exports = {
  QUICK_PROMPT_GROUPS,
  BUILTIN_QUICK_POOL,
  truncateGhostLabel,
  selectOptimizerCandidates,
  getGhostSuggestions,
  optimizePromptText,
  exportConversationMarkdown
};
