'use strict';

const crypto = require('node:crypto');

const DEFAULT_METADATA = Object.freeze({
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

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function createAdapterError(message, statusCode, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function extractItemsText(items) {
  if (!Array.isArray(items)) return '';
  return items
    .map((item) => (typeof item === 'string' ? item : (typeof item?.text === 'string' ? item.text : '')))
    .filter(Boolean)
    .join('\n');
}

function normalizeStepStatus(rawStatus) {
  if (typeof rawStatus !== 'string') return 'pending';
  const trimmed = rawStatus.trim();
  if (!trimmed) return 'pending';
  return STEP_STATUS_MAP[trimmed] || STEP_STATUS_MAP[trimmed.toUpperCase()] || 'pending';
}

const STEP_TYPE_MAPPERS = Object.freeze({
  CORTEX_STEP_TYPE_USER_INPUT: Object.freeze({
    kind: 'user',
    field: 'userInput',
    map(raw) {
      const items = Array.isArray(raw.items) ? raw.items : [];
      return {
        ...raw,
        items,
        userResponse: raw.userResponse ?? null,
        activeUserState: raw.activeUserState ?? null,
        userConfig: raw.userConfig ?? null,
        userAgentSpec: raw.userAgentSpec ?? null,
        clientMessageId: raw.clientMessageId ?? null,
        text: raw.userResponse || extractItemsText(items)
      };
    }
  }),
  CORTEX_STEP_TYPE_PLANNER_RESPONSE: Object.freeze({
    kind: 'thinking_and_text',
    field: 'plannerResponse',
    map(raw) {
      const toolCalls = Array.isArray(raw.toolCalls) ? raw.toolCalls : [];
      return {
        ...raw,
        thinking: raw.thinking ?? '',
        messageId: raw.messageId ?? null,
        toolCalls,
        thinkingDuration: raw.thinkingDuration ?? null,
        stopReason: raw.stopReason ?? null,
        response: raw.response ?? '',
        modifiedResponse: raw.modifiedResponse ?? null,
        text: raw.modifiedResponse ?? raw.response ?? ''
      };
    }
  }),
  CORTEX_STEP_TYPE_RUN_COMMAND: Object.freeze({
    kind: 'command',
    field: 'runCommand',
    title: (raw) => raw.commandLine || raw.proposedCommandLine || 'Run Command',
    map(raw) {
      return {
        ...raw,
        commandLine: raw.commandLine ?? '',
        proposedCommandLine: raw.proposedCommandLine ?? null,
        cwd: raw.cwd ?? null,
        waitMsBeforeAsync: raw.waitMsBeforeAsync ?? null,
        blocking: raw.blocking ?? null,
        exitCode: raw.exitCode ?? null,
        combinedOutput: raw.combinedOutput ?? '',
        shellName: raw.shellName ?? null
      };
    }
  }),
  CORTEX_STEP_TYPE_VIEW_FILE: Object.freeze({
    kind: 'file_view',
    field: 'viewFile',
    title: (raw) => raw.absolutePathUri || 'View File',
    map(raw) {
      return {
        ...raw,
        absolutePathUri: raw.absolutePathUri ?? null,
        startLine: raw.startLine ?? null,
        endLine: raw.endLine ?? null,
        content: raw.content ?? '',
        lineRangeBytes: raw.lineRangeBytes ?? null,
        numLines: raw.numLines ?? null,
        numBytes: raw.numBytes ?? null
      };
    }
  }),
  CORTEX_STEP_TYPE_CODE_ACTION: Object.freeze({
    kind: 'code_action',
    field: 'codeAction',
    title: (raw) => raw.actionSpec?.description || raw.actionSpec?.targetFile || 'Code Action',
    map(raw) {
      return {
        ...raw,
        actionSpec: raw.actionSpec ?? null,
        actionResult: raw.actionResult ?? null,
        diffStats: raw.diffStats ?? null
      };
    }
  }),
  CORTEX_STEP_TYPE_ASK_QUESTION: Object.freeze({
    kind: 'ask_question',
    field: 'askQuestion',
    map(raw, step) {
      const completedInteractions = Array.isArray(step?.completedInteractions)
        ? step.completedInteractions
        : (Array.isArray(raw.completedInteractions) ? raw.completedInteractions : []);
      return {
        ...raw,
        questions: Array.isArray(raw.questions) ? raw.questions : [],
        completedInteractions
      };
    }
  }),
  CORTEX_STEP_TYPE_SEARCH_WEB: Object.freeze({
    kind: 'web_search',
    field: 'searchWeb',
    title: (raw) => raw.query || 'Search Web',
    map(raw) {
      return {
        ...raw,
        query: raw.query ?? '',
        webDocuments: Array.isArray(raw.webDocuments) ? raw.webDocuments : [],
        summary: raw.summary ?? '',
        thirdPartyConfig: raw.thirdPartyConfig ?? null,
        searchType: raw.searchType ?? null
      };
    }
  }),
  CORTEX_STEP_TYPE_CHECKPOINT: Object.freeze({
    kind: 'checkpoint',
    field: 'checkpoint',
    title: (raw) => raw.sessionSummary || 'Checkpoint',
    map(raw) {
      return {
        ...raw,
        includedStepIndexEnd: raw.includedStepIndexEnd ?? null,
        sessionSummary: raw.sessionSummary ?? '',
        artifactSnapshots: Array.isArray(raw.artifactSnapshots) ? raw.artifactSnapshots : [],
        capturedUserRequests: Array.isArray(raw.capturedUserRequests) ? raw.capturedUserRequests : [],
        totalSubagentCount: raw.totalSubagentCount ?? 0,
        accumulatedSections: Array.isArray(raw.accumulatedSections) ? raw.accumulatedSections : []
      };
    }
  }),
  CORTEX_STEP_TYPE_SYSTEM_MESSAGE: Object.freeze({
    kind: 'system',
    field: 'systemMessage',
    map(raw) {
      return {
        ...raw,
        message: raw.message ?? '',
        renderInfo: raw.renderInfo ?? null,
        eventType: raw.eventType ?? null
      };
    }
  }),
  CORTEX_STEP_TYPE_GENERIC: Object.freeze({
    kind: 'tool_generic',
    field: 'generic',
    map(raw) {
      return {
        ...raw,
        args: raw.args ?? null,
        result: raw.result ?? null
      };
    }
  }),
  CORTEX_STEP_TYPE_ERROR_MESSAGE: Object.freeze({
    kind: 'error',
    field: 'errorMessage',
    map(raw) {
      return {
        ...raw,
        error: raw.error ?? null
      };
    }
  })
});

function inferStepType(step) {
  if (typeof step.type === 'string' && step.type.trim()) {
    return step.type.trim();
  }
  for (const [stepType, mapper] of Object.entries(STEP_TYPE_MAPPERS)) {
    if (step[mapper.field] !== undefined) {
      return stepType;
    }
  }
  return 'CORTEX_STEP_TYPE_GENERIC';
}

function buildUnknownStepPayload(step) {
  const payload = {};
  for (const [k, v] of Object.entries(step)) {
    if (k === 'type' || k === 'status' || k === 'stepIndex' || k === 'title') continue;
    payload[k] = v;
  }
  return payload;
}

function humanizeStepType(rawType) {
  const stripped = String(rawType || '')
    .trim()
    .replace(/^CORTEX_STEP_TYPE_/i, '')
    .replace(/^_+/, '');
  if (!stripped) return 'Tool';
  return stripped
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function stepTypeToCamelKey(rawType) {
  const stripped = String(rawType || '')
    .trim()
    .replace(/^CORTEX_STEP_TYPE_/i, '')
    .replace(/^_+/, '');
  if (!stripped) return '';
  const parts = stripped.split(/[_\s-]+/).filter(Boolean);
  return parts
    .map((part, idx) => {
      const lower = part.toLowerCase();
      return idx === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join('');
}

function collectCandidateObjects(payload, rawType) {
  const seen = new Set();
  const list = [];
  const pushObj = (obj) => {
    if (!isPlainObject(obj) || seen.has(obj)) return;
    seen.add(obj);
    list.push(obj);
  };

  pushObj(payload);
  const camelKey = stepTypeToCamelKey(rawType);
  if (camelKey && isPlainObject(payload[camelKey])) {
    pushObj(payload[camelKey]);
  }
  for (const key of ['toolCall', 'call', 'actionSpec', 'args', 'arguments', 'input']) {
    if (isPlainObject(payload[key])) {
      pushObj(payload[key]);
    }
  }
  for (const val of Object.values(payload)) {
    if (isPlainObject(val)) {
      pushObj(val);
      for (const nestedKey of ['actionSpec', 'args', 'arguments', 'input']) {
        if (isPlainObject(val[nestedKey])) {
          pushObj(val[nestedKey]);
        }
      }
    }
  }
  return list;
}

function pickNonEmptyString(candidates, keys, { ignoreGenericTool = false } = {}) {
  for (const key of keys) {
    for (const obj of candidates) {
      const val = obj[key];
      if (typeof val === 'string') {
        const trimmed = val.trim();
        if (!trimmed) continue;
        if (ignoreGenericTool && trimmed.toLowerCase() === 'tool') continue;
        return trimmed;
      }
    }
  }
  return '';
}

function formatCompactTargetHint(raw) {
  if (typeof raw !== 'string') return '';
  let text = raw.trim().replace(/\s+/g, ' ');
  if (!text) return '';
  if (/^file:\/\//i.test(text)) {
    text = text.replace(/^file:\/\//i, '');
    if (/%[0-9a-f]{2}/i.test(text)) {
      try {
        text = decodeURIComponent(text);
      } catch {
        // Keep un-decoded if malformed
      }
    }
  }
  if (text.length <= 80) return text;
  if (text.includes('/')) {
    const parts = text.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const tail = `.../${parts.slice(-2).join('/')}`;
      if (tail.length <= 80) return tail;
    }
  }
  return `${text.slice(0, 77)}...`;
}

function enrichToolGenericPayload(rawPayload, rawType, explicitTitle) {
  const candidates = collectCandidateObjects(rawPayload, rawType);
  const serverName = pickNonEmptyString(candidates, ['serverName', 'mcpServerName']);
  const cleanToolCandidate = pickNonEmptyString(
    candidates,
    ['toolName', 'name', 'mcpToolName'],
    { ignoreGenericTool: true }
  );
  const actionName = pickNonEmptyString(candidates, ['action'], { ignoreGenericTool: true });

  let toolName = '';
  if (serverName) {
    if (cleanToolCandidate) {
      toolName = cleanToolCandidate.startsWith(`${serverName}/`)
        ? cleanToolCandidate
        : `${serverName}/${cleanToolCandidate}`;
    } else {
      toolName = serverName;
    }
  } else if (cleanToolCandidate) {
    toolName = cleanToolCandidate;
  } else if (actionName) {
    toolName = actionName;
  } else {
    toolName = humanizeStepType(rawType);
  }

  const rawHint = pickNonEmptyString(candidates, [
    'targetFile',
    'path',
    'directoryPath',
    'query',
    'pattern',
    'absolutePathUri'
  ]);
  const targetHint = formatCompactTargetHint(rawHint);

  const cleanExplicitTitle = typeof explicitTitle === 'string' && explicitTitle.trim().toLowerCase() !== 'tool'
    ? explicitTitle.trim()
    : '';
  const title = cleanExplicitTitle || (targetHint && targetHint !== toolName ? `${toolName}: ${targetHint}` : toolName);

  return {
    title,
    payload: {
      ...rawPayload,
      toolName
    }
  };
}

function normalizeStepToSessionEvent(step, seq) {
  const safeStep = isPlainObject(step) ? step : {};
  const resolvedSeq = Number.isInteger(seq)
    ? seq
    : (Number.isInteger(safeStep.stepIndex) ? safeStep.stepIndex : 0);
  const rawType = inferStepType(safeStep);
  const status = normalizeStepStatus(safeStep.status);
  const mapper = STEP_TYPE_MAPPERS[rawType];

  if (mapper) {
    const rawPayload = isPlainObject(safeStep[mapper.field]) ? safeStep[mapper.field] : {};
    const mappedPayload = mapper.map(rawPayload, safeStep);
    if (mapper.kind === 'tool_generic') {
      const enriched = enrichToolGenericPayload(mappedPayload, rawType, safeStep.title);
      return {
        seq: resolvedSeq,
        kind: mapper.kind,
        status,
        rawType,
        ...(enriched.title ? { title: enriched.title } : {}),
        payload: enriched.payload
      };
    }
    const title = typeof mapper.title === 'function' ? mapper.title(rawPayload, safeStep) : safeStep.title;
    return {
      seq: resolvedSeq,
      kind: mapper.kind,
      status,
      rawType,
      ...(title ? { title } : {}),
      payload: mappedPayload
    };
  }

  const unknownPayload = buildUnknownStepPayload(safeStep);
  const enriched = enrichToolGenericPayload(unknownPayload, rawType, safeStep.title);
  return {
    seq: resolvedSeq,
    kind: 'tool_generic',
    status,
    rawType,
    ...(enriched.title ? { title: enriched.title } : {}),
    payload: enriched.payload
  };
}

function computeEventFingerprint(event) {
  return crypto.createHash('sha1').update(JSON.stringify(event)).digest('hex');
}

function pickSummaryField(entry, meta, keys) {
  for (const key of keys) {
    if (entry[key] !== undefined && entry[key] !== null) return entry[key];
    if (meta[key] !== undefined && meta[key] !== null) return meta[key];
  }
  return undefined;
}

function normalizeSessionSummary(cascadeId, item) {
  const entry = isPlainObject(item) ? item : {};
  const meta = isPlainObject(entry.metadata) ? entry.metadata : {};
  const workspaces = Array.isArray(entry.workspaces) ? entry.workspaces : [];
  const ws0 = isPlainObject(workspaces[0]) ? workspaces[0] : {};
  const annTitle = typeof entry.annotations?.title === 'string' ? entry.annotations.title.trim() : '';
  const entryTitle = typeof entry.title === 'string' ? entry.title.trim() : '';
  const summaryTitle = typeof entry.summary === 'string' ? entry.summary.trim() : '';

  let title = '';
  let titleSource = 'none';
  if (annTitle) {
    title = annTitle;
    titleSource = 'annotation';
  } else if (entryTitle) {
    title = entryTitle;
    titleSource = 'title';
  } else if (summaryTitle) {
    title = summaryTitle;
    titleSource = 'summary';
  }

  const parentConversationId = pickSummaryField(entry, meta, ['parentConversationId', 'parent_conversation_id']);
  const rawNestingDepth = pickSummaryField(entry, meta, ['nestingDepth', 'nesting_depth']);
  const agentName = pickSummaryField(entry, meta, ['agentName', 'agent_name']);
  const isSubagent = pickSummaryField(entry, meta, ['isSubagent', 'is_subagent']);
  const rawLastUserInputStepIndex = pickSummaryField(entry, meta, ['lastUserInputStepIndex', 'last_user_input_step_index']);
  const notFullyIdle = pickSummaryField(entry, meta, ['notFullyIdle', 'not_fully_idle']);
  const killed = pickSummaryField(entry, meta, ['killed']);
  const lastCompletedTime = pickSummaryField(entry, meta, ['lastCompletedTime', 'last_completed_time']);
  const source = pickSummaryField(entry, meta, ['source']);

  const extra = {};
  if (typeof parentConversationId === 'string' && parentConversationId.trim()) {
    extra.parentConversationId = parentConversationId.trim();
  }
  if (rawNestingDepth !== undefined && Number.isFinite(Number(rawNestingDepth))) {
    extra.nestingDepth = Number(rawNestingDepth);
  }
  if (typeof agentName === 'string' && agentName.trim()) {
    extra.agentName = agentName.trim();
  }
  if (isSubagent !== undefined) {
    extra.isSubagent = Boolean(isSubagent);
  }
  if (rawLastUserInputStepIndex !== undefined && Number.isFinite(Number(rawLastUserInputStepIndex))) {
    extra.lastUserInputStepIndex = Number(rawLastUserInputStepIndex);
  }
  if (notFullyIdle !== undefined) {
    extra.notFullyIdle = Boolean(notFullyIdle);
  }
  if (killed !== undefined) {
    extra.killed = Boolean(killed);
  }
  if (typeof lastCompletedTime === 'string' && lastCompletedTime.trim()) {
    extra.lastCompletedTime = lastCompletedTime.trim();
  }
  if (typeof source === 'string' && source.trim()) {
    extra.source = source.trim();
  }

  return {
    cascadeId,
    shortId: String(cascadeId || '').slice(0, 8),
    hasTitle: Boolean(title),
    titleSource,
    title,
    summary: entry.summary || '',
    status: entry.status || 'CASCADE_RUN_STATUS_IDLE',
    stepCount: Number(entry.stepCount || 0),
    lastModifiedTime: entry.lastModifiedTime || entry.createdTime || null,
    createdTime: entry.createdTime || null,
    workspaceUri: ws0.workspaceFolderAbsoluteUri || ws0.workspaceUri || null,
    gitRootUri: ws0.gitRootAbsoluteUri || ws0.gitRootUri || null,
    repoName: ws0.repository?.computedName || ws0.repository?.name || ws0.repoName || null,
    branchName: ws0.branchName || null,
    workspaces,
    ...extra
  };
}

const INTERNAL_MODEL_ID_RE = /^(?:tab_|gemini-flash-worker|.*-sonar$|.*-tiered(?:-|$))/i;
const PLACEHOLDER_ENUM_RE = /^MODEL_PLACEHOLDER_M\d+$/i;

function isInternalAvailModel(enumId, modelId, item) {
  if (INTERNAL_MODEL_ID_RE.test(modelId) || INTERNAL_MODEL_ID_RE.test(enumId)) {
    return true;
  }
  const hasHumanName = Boolean(
    (typeof item?.displayName === 'string' && item.displayName.trim() && !PLACEHOLDER_ENUM_RE.test(item.displayName.trim()))
    || (typeof item?.label === 'string' && item.label.trim() && !PLACEHOLDER_ENUM_RE.test(item.label.trim()))
  );
  return !hasHumanName;
}

function classifyBadge(tagTitle, tagDescription) {
  const title = typeof tagTitle === 'string' ? tagTitle.trim() : '';
  if (!title) return undefined;
  const lower = title.toLowerCase();
  let kind = 'notice';
  let labelKey = 'models.badge.notice';
  if (lower === 'new') {
    kind = 'new';
    labelKey = 'models.badge.new';
  } else if (lower.includes('leaving')) {
    kind = 'leaving_soon';
    labelKey = 'models.badge.leaving_soon';
  } else if (lower.includes('beta')) {
    kind = 'beta';
    labelKey = 'models.badge.beta';
  }
  return {
    kind,
    labelKey,
    rawTitle: title,
    ...(typeof tagDescription === 'string' && tagDescription.trim()
      ? { description: tagDescription.trim() }
      : {})
  };
}

function buildQuotaSummary(quotaInfo) {
  if (!isPlainObject(quotaInfo)) return null;
  const frac = Number(quotaInfo.remainingFraction);
  if (!Number.isFinite(frac)) return null;
  return {
    remainingFraction: frac,
    resetTime: typeof quotaInfo.resetTime === 'string' ? quotaInfo.resetTime : null
  };
}

const THINKING_LEVEL_BY_NUM = Object.freeze({
  1: 'low',
  2: 'medium',
  3: 'high',
  100: 'xhigh'
});

const THINKING_NUM_BY_SUFFIX = Object.freeze({
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 100
});

const THINKING_DISPLAY_NAME = Object.freeze({
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High'
});

function normalizeThinkingSuffix(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return THINKING_LEVEL_BY_NUM[raw] || null;
  }
  const str = String(raw).trim();
  if (!str) return null;
  if (/^\d+$/.test(str)) {
    return THINKING_LEVEL_BY_NUM[Number(str)] || null;
  }
  const lower = str.toLowerCase().replace(/^thinking_level_/, '');
  if (lower === 'x-high' || lower === 'extra high' || lower === 'extra_high' || lower === 'xhigh') {
    return 'xhigh';
  }
  if (lower === 'med' || lower === 'medium') return 'medium';
  if (lower === 'low' || lower === 'high') return lower;
  return null;
}

function isOrchestratorEntry(entry) {
  const modelId = String(entry?.modelId || '');
  const label = String(entry?.label || entry?.displayName || '');
  return /^gemini-pro-orchestrator/i.test(modelId) || /^Orchestrator\s*\(/i.test(label);
}

function resolveOrchestratorPlannerInfo(entry, groupedModelsMap) {
  const modelId = String(entry?.modelId || '').trim();
  const label = String(entry?.label || entry?.displayName || '').trim();
  const match = label.match(/^Orchestrator\s*\(([^)]+)\)/i);
  const parenName = match ? match[1].trim() : '';

  let familyId = '';
  if (/^gemini-pro-orchestrator-(.+)$/i.test(modelId)) {
    const suffix = modelId.replace(/^gemini-pro-orchestrator-/i, '').toLowerCase();
    familyId = suffix.startsWith('gemini-') ? suffix : `gemini-4-${suffix}`;
  } else if (modelId === 'gemini-pro-orchestrator') {
    familyId = 'gemini-4-carbon';
  } else if (parenName) {
    familyId = `gemini-4-${parenName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  } else {
    familyId = modelId || String(entry?.id || 'orchestrator').toLowerCase();
  }

  const groupMeta = isPlainObject(groupedModelsMap?.[familyId]) ? groupedModelsMap[familyId] : null;
  const plannerDisplayName = groupMeta?.displayName
    || (parenName ? (/^gemini/i.test(parenName) ? parenName : `Gemini 4 ${parenName}`) : (label || familyId));

  return { familyId, plannerDisplayName };
}

function buildModelCatalogTree({
  orderedConfigs,
  groupedModelsMap,
  defaultModelId,
  fallbackFlatModels
}) {
  const sourceItems = orderedConfigs.length > 0 ? orderedConfigs : fallbackFlatModels;
  const byModelId = new Map();
  for (const item of sourceItems) {
    if (item.modelId && !byModelId.has(item.modelId)) {
      byModelId.set(item.modelId, item);
    }
  }

  // Map "<familyId>-<thinkingSuffix>" -> group metadata
  const variantToFamily = new Map();
  if (isPlainObject(groupedModelsMap)) {
    for (const [familyId, group] of Object.entries(groupedModelsMap)) {
      if (!isPlainObject(group) || !Array.isArray(group.supportedThinkingLevels)) continue;
      for (const level of group.supportedThinkingLevels) {
        const suffix = String(level?.thinkingSuffix || '').trim();
        if (!suffix) continue;
        variantToFamily.set(`${familyId}-${suffix}`, {
          familyId,
          group
        });
      }
    }
  }

  const nodes = [];
  const emittedFamilies = new Set();
  let emittedOrchestrator = false;
  const orchestratorEntries = sourceItems.filter((item) => isOrchestratorEntry(item));

  for (const entry of sourceItems) {
    if (isOrchestratorEntry(entry)) {
      if (emittedOrchestrator) continue;
      emittedOrchestrator = true;

      const children = orchestratorEntries.map((preset) => {
        const { familyId, plannerDisplayName } = resolveOrchestratorPlannerInfo(preset, groupedModelsMap);
        const badge = classifyBadge(preset.tagTitle, preset.tagDescription);
        const quota = buildQuotaSummary(preset.quotaInfo);
        const presetModelId = preset.modelId || preset.id;
        const defaultThinkingSuffix = normalizeThinkingSuffix(preset.thinkingLevel) || 'high';
        const groupMeta = isPlainObject(groupedModelsMap?.[familyId]) ? groupedModelsMap[familyId] : null;
        const groupSuffixes = Array.isArray(groupMeta?.supportedThinkingLevels)
          ? groupMeta.supportedThinkingLevels
              .map((l) => normalizeThinkingSuffix(l?.thinkingSuffix) || String(l?.thinkingSuffix || '').trim().toLowerCase())
              .filter(Boolean)
          : [];
        const fallbackLevels = (familyId.includes('neon') || defaultThinkingSuffix === 'xhigh')
          ? ['low', 'medium', 'high', 'xhigh']
          : ['low', 'medium', 'high'];
        const supportedThinkingLevels = Array.from(
          new Set([
            ...(groupSuffixes.length > 0 ? groupSuffixes : fallbackLevels),
            defaultThinkingSuffix
          ])
        );
        const thinkingDisplay = THINKING_DISPLAY_NAME[defaultThinkingSuffix] || defaultThinkingSuffix;
        return {
          kind: 'leaf',
          key: `orch/${familyId}`,
          role: 'planner_model',
          label: plannerDisplayName,
          secondaryLabel: `${thinkingDisplay} · → Hydrogen`,
          ...(badge ? { badge } : {}),
          quota,
          disabled: Boolean(preset.disabled),
          ...(preset.recommended || preset.isDefault ? { isRecommended: true } : {}),
          supportedThinkingLevels,
          defaultThinkingSuffix,
          ...(preset.thinkingLevel !== null && preset.thinkingLevel !== undefined
            ? { thinkingLevel: preset.thinkingLevel }
            : {}),
          selectedDisplayLabel: `Orchestrator · ${plannerDisplayName} ${thinkingDisplay}`,
          selection: {
            mode: 'orchestrator_preset',
            requestedModel: preset.id,
            modelId: presetModelId,
            plannerFamilyId: familyId,
            executorFamilyId: 'gemini-4-hydrogen',
            plannerThinkingSuffix: defaultThinkingSuffix
          }
        };
      });

      const hasOpusOrch = children.some((c) => /^orch\/claude-opus/i.test(c.key));
      if (!hasOpusOrch) {
        let opusFamilyId = '';
        let opusGroupMeta = null;
        if (isPlainObject(groupedModelsMap)) {
          for (const [fid, grp] of Object.entries(groupedModelsMap)) {
            if (/^claude-opus/i.test(fid)) {
              opusFamilyId = fid;
              opusGroupMeta = isPlainObject(grp) ? grp : null;
              break;
            }
          }
        }
        const opusItems = sourceItems.filter((item) => {
          const mid = String(item?.modelId || '');
          const lbl = String(item?.displayName || item?.label || '');
          if (opusFamilyId) {
            return mid.startsWith(`${opusFamilyId}-`) || mid === opusFamilyId;
          }
          return /^claude-opus/i.test(mid) || /^claude\s+opus/i.test(lbl);
        });
        if (!opusFamilyId && opusItems.length > 0) {
          const firstMid = String(opusItems[0].modelId || '');
          const m = firstMid.match(/^(claude-opus-[\w.]+)-(?:low|medium|high|xhigh)$/i);
          opusFamilyId = m ? m[1] : 'claude-opus-5-5';
        }
        if (opusFamilyId && (opusItems.length > 0 || opusGroupMeta)) {
          const backingModels = {};
          const suffixOrder = [];
          if (Array.isArray(opusGroupMeta?.supportedThinkingLevels)) {
            for (const lvl of opusGroupMeta.supportedThinkingLevels) {
              const sfx = normalizeThinkingSuffix(lvl?.thinkingSuffix)
                || String(lvl?.thinkingSuffix || '').trim().toLowerCase();
              if (!sfx) continue;
              const cfg = byModelId.get(`${opusFamilyId}-${sfx}`);
              if (cfg) {
                backingModels[sfx] = cfg.id;
                if (!suffixOrder.includes(sfx)) suffixOrder.push(sfx);
              }
            }
          }
          for (const item of opusItems) {
            const mid = String(item.modelId || '');
            const tail = mid.replace(new RegExp(`^${opusFamilyId}-`, 'i'), '');
            const sfx = normalizeThinkingSuffix(item.thinkingLevel) || normalizeThinkingSuffix(tail) || 'medium';
            if (!backingModels[sfx]) backingModels[sfx] = item.id;
            if (!suffixOrder.includes(sfx)) suffixOrder.push(sfx);
          }
          const supportedThinkingLevels = suffixOrder.length > 0 ? suffixOrder : ['low', 'medium', 'high'];
          const defaultSuffix = backingModels.high
            ? 'high'
            : (backingModels.medium ? 'medium' : supportedThinkingLevels[0]);
          const defaultBacking = (defaultSuffix && byModelId.get(`${opusFamilyId}-${defaultSuffix}`))
            || opusItems.find((i) => !i.disabled)
            || opusItems[0]
            || null;
          if (defaultBacking || Object.keys(backingModels).length > 0) {
            const rawOpusName = String(
              opusGroupMeta?.displayName
              || defaultBacking?.displayName
              || defaultBacking?.label
              || 'Claude Opus 5.5'
            ).trim();
            const opusDisplayName = rawOpusName.replace(/\s*\((?:low|medium|high|xhigh)\)\s*$/i, '').trim() || 'Claude Opus 5.5';
            const badge = defaultBacking ? classifyBadge(defaultBacking.tagTitle, defaultBacking.tagDescription) : undefined;
            const quota = defaultBacking ? buildQuotaSummary(defaultBacking.quotaInfo) : null;
            const defaultThinkingDisplay = THINKING_DISPLAY_NAME[defaultSuffix] || 'High';
            children.push({
              kind: 'leaf',
              key: `orch/${opusFamilyId}`,
              role: 'planner_model',
              label: opusDisplayName,
              secondaryLabel: `${defaultThinkingDisplay} · → Hydrogen`,
              ...(badge ? { badge } : {}),
              quota,
              disabled: defaultBacking ? Boolean(defaultBacking.disabled) : false,
              supportedThinkingLevels,
              defaultThinkingSuffix: defaultSuffix,
              selectedDisplayLabel: `Orchestrator · ${opusDisplayName} ${defaultThinkingDisplay}`,
              selection: {
                mode: 'orchestrator_preset',
                requestedModel: `orchestrator:${opusFamilyId}`,
                modelId: `${opusFamilyId}-orchestrator`,
                plannerFamilyId: opusFamilyId,
                executorFamilyId: 'gemini-4-hydrogen',
                plannerThinkingSuffix: defaultSuffix,
                backingModels
              }
            });
          }
        }
      }

      const preferredChild =
        children.find((c) => c.selection.requestedModel === defaultModelId && !c.disabled)
        || children.find((c) => c.key === 'orch/gemini-4-neon' && !c.disabled)
        || children.find((c) => !c.disabled)
        || children[0];
      const firstBadge = children.find((c) => c.badge)?.badge;
      const preferredThinkingDisplay = preferredChild
        ? (THINKING_DISPLAY_NAME[preferredChild.defaultThinkingSuffix] || 'High')
        : 'High';

      nodes.push({
        kind: 'branch',
        key: 'orch',
        role: 'orchestrator_root',
        label: 'Orchestrator',
        ...(preferredChild ? { secondaryLabel: `${preferredChild.label} ${preferredThinkingDisplay}` } : {}),
        ...(firstBadge ? { badge: firstBadge } : {}),
        quota: preferredChild?.quota ?? null,
        disabled: children.length > 0 && children.every((c) => c.disabled),
        ...(preferredChild ? { defaultChildKey: preferredChild.key } : {}),
        children
      });
      continue;
    }

    const familyMatch = entry.modelId ? variantToFamily.get(entry.modelId) : null;
    if (familyMatch) {
      const { familyId, group } = familyMatch;
      if (emittedFamilies.has(familyId)) continue;
      emittedFamilies.add(familyId);

      const familySupportedLevels = [];
      const childSpecs = [];
      for (const level of group.supportedThinkingLevels) {
        const suffix = String(level?.thinkingSuffix || '').trim();
        if (!suffix) continue;
        const variantId = `${familyId}-${suffix}`;
        const cfg = byModelId.get(variantId);
        if (!cfg) continue;
        familySupportedLevels.push(suffix);
        childSpecs.push({ level, suffix, variantId, cfg });
      }

      const children = childSpecs.map(({ level, suffix, variantId, cfg }) => {
        const thinkingLabel = String(level.thinkingDisplayName || suffix).trim();
        const badge = classifyBadge(cfg.tagTitle, cfg.tagDescription);
        const quota = buildQuotaSummary(cfg.quotaInfo);
        const familyLabel = String(group.displayName || familyId).trim();
        return {
          kind: 'leaf',
          key: `family/${familyId}/${suffix}`,
          role: 'thinking_level',
          label: thinkingLabel,
          ...(badge ? { badge } : {}),
          quota,
          disabled: Boolean(cfg.disabled),
          ...(suffix === 'medium' || cfg.recommended ? { isRecommended: true } : {}),
          supportedThinkingLevels: [...familySupportedLevels],
          defaultThinkingSuffix: suffix,
          selectedDisplayLabel: `${familyLabel} · ${thinkingLabel}`,
          selection: {
            mode: 'single',
            requestedModel: cfg.id,
            modelId: variantId
          }
        };
      });

      if (children.length > 0) {
        const defaultChild =
          children.find((c) => c.selection.requestedModel === defaultModelId && !c.disabled)
          || children.find((c) => c.key === `family/${familyId}/medium` && !c.disabled)
          || children.find((c) => !c.disabled)
          || children[0];
        const familyBadge = defaultChild?.badge || children.find((c) => c.badge)?.badge;
        nodes.push({
          kind: 'branch',
          key: `family/${familyId}`,
          role: 'family',
          label: String(group.displayName || familyId).trim(),
          ...(defaultChild ? { secondaryLabel: defaultChild.label } : {}),
          ...(familyBadge ? { badge: familyBadge } : {}),
          quota: defaultChild?.quota ?? null,
          disabled: children.every((c) => c.disabled),
          ...(defaultChild ? { defaultChildKey: defaultChild.key } : {}),
          children
        });
        continue;
      }
    }

    // Single-tier / ungrouped model (e.g. GPT-OSS 120B (Medium))
    const slug = String(entry.modelId || entry.id).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
    const badge = classifyBadge(entry.tagTitle, entry.tagDescription);
    const quota = buildQuotaSummary(entry.quotaInfo);
    const label = entry.displayName || entry.label || entry.id;
    const singleThinking = normalizeThinkingSuffix(entry.thinkingLevel);
    nodes.push({
      kind: 'leaf',
      key: `family/${slug}`,
      role: 'family',
      label,
      ...(badge ? { badge } : {}),
      quota,
      disabled: Boolean(entry.disabled),
      ...(entry.recommended || entry.isDefault ? { isRecommended: true } : {}),
      ...(singleThinking ? { defaultThinkingSuffix: singleThinking } : {}),
      selectedDisplayLabel: label,
      selection: {
        mode: 'single',
        requestedModel: entry.id,
        modelId: entry.modelId || entry.id
      }
    });
  }

  let defaultSelectionKey = null;
  const leaves = [];
  const collectLeaves = (list) => {
    for (const node of list) {
      if (node.kind === 'leaf') leaves.push(node);
      else if (Array.isArray(node.children)) collectLeaves(node.children);
    }
  };
  collectLeaves(nodes);

  const matchedDefault = leaves.find(
    (l) => !l.disabled && (l.selection.requestedModel === defaultModelId || l.selection.modelId === defaultModelId)
  );
  const firstEnabled = leaves.find((l) => !l.disabled);
  defaultSelectionKey = (matchedDefault || firstEnabled || leaves[0])?.key || null;

  return {
    supportsCustomOrchestrator: true,
    defaultSelectionKey,
    nodes
  };
}

function normalizeModelCatalog(userStatusRes, availRes) {
  const userStatusRoot = userStatusRes?.userStatus || userStatusRes || {};
  const modelConfigData = userStatusRoot.cascadeModelConfigData || {};
  const clientConfigs = Array.isArray(modelConfigData.clientModelConfigs)
    ? modelConfigData.clientModelConfigs
    : [];
  const availRoot = availRes?.response || availRes || {};
  const rawAvailModels = availRoot.models;

  const defaultModelId = availRoot.defaultAgentModelId
    || modelConfigData.defaultOverrideModelConfig?.modelOrAlias?.model
    || null;

  const byId = new Map();
  const availByEnum = new Map();
  const availByModelId = new Map();

  const availEntries = Array.isArray(rawAvailModels)
    ? rawAvailModels.map((m) => [m?.modelId || m?.model || m?.id || '', m])
    : (isPlainObject(rawAvailModels) ? Object.entries(rawAvailModels) : []);

  for (const [key, item] of availEntries) {
    if (!isPlainObject(item)) continue;
    const enumId = String(item.model || item.id || key || '').trim();
    if (!enumId) continue;
    const stableModelId = String(item.modelId || (!Array.isArray(rawAvailModels) ? key : '') || '').trim();
    const meta = {
      id: enumId,
      model: enumId,
      modelId: stableModelId || null,
      label: item.label || item.displayName || enumId,
      displayName: item.displayName || item.label || enumId,
      maxTokens: Number.isFinite(Number(item.maxTokens)) ? Number(item.maxTokens) : null,
      disabled: Boolean(item.disabled),
      supportsImages: Boolean(item.supportsImages),
      recommended: Boolean(item.recommended),
      thinkingLevel: item.thinkingLevel ?? null,
      tagTitle: item.tagTitle || null,
      tagDescription: item.tagDescription || null,
      isDefault: enumId === defaultModelId || (stableModelId && stableModelId === defaultModelId),
      quotaInfo: item.quotaInfo || null
    };
    availByEnum.set(enumId, meta);
    if (stableModelId) availByModelId.set(stableModelId, meta);

    // Filter out internal/non-chat models (tab_*, *-sonar, *-tiered, nameless placeholders)
    // unless explicitly whitelisted by clientModelConfigs below.
    if (!isInternalAvailModel(enumId, stableModelId, item)) {
      byId.set(enumId, meta);
    }
  }

  const orderedClientItems = [];
  const seenClientKeys = new Set();

  const pushClientEntry = (cfg) => {
    const id = String(cfg.modelOrAlias?.model || cfg.model || cfg.modelId || '').trim();
    if (!id) return;
    const stableModelId = String(cfg.modelId || '').trim() || null;
    const availMeta = (stableModelId && availByModelId.get(stableModelId)) || availByEnum.get(id) || null;
    const prev = byId.get(id) || availMeta || {
      id,
      model: id,
      modelId: stableModelId,
      label: id,
      displayName: id,
      maxTokens: null,
      disabled: false,
      supportsImages: false,
      recommended: false,
      thinkingLevel: null,
      isDefault: id === defaultModelId,
      quotaInfo: null
    };

    const merged = {
      ...prev,
      id,
      model: id,
      modelId: stableModelId || prev.modelId || null,
      label: cfg.label || prev.label || id,
      displayName: (availMeta?.displayName && !PLACEHOLDER_ENUM_RE.test(availMeta.displayName))
        ? availMeta.displayName
        : (cfg.label || (prev.displayName !== id ? prev.displayName : id)),
      maxTokens: prev.maxTokens ?? null,
      disabled: Boolean(cfg.disabled || cfg.enabled === false || prev.disabled),
      supportsImages: Boolean(cfg.supportsImages || prev.supportsImages),
      recommended: Boolean(cfg.recommended || prev.recommended),
      thinkingLevel: cfg.thinkingLevel ?? prev.thinkingLevel ?? null,
      tagTitle: cfg.tagTitle || prev.tagTitle || null,
      tagDescription: cfg.tagDescription || prev.tagDescription || null,
      quotaInfo: cfg.quotaInfo || prev.quotaInfo || null,
      isDefault: Boolean(id === defaultModelId || (stableModelId && stableModelId === defaultModelId))
    };
    byId.set(id, merged);
    if (!seenClientKeys.has(id)) {
      seenClientKeys.add(id);
      orderedClientItems.push(merged);
    }
  };

  // Respect clientModelSorts or agentModelSorts ordering when present
  const sortLabels = modelConfigData.clientModelSorts?.[0]?.groups?.[0]?.modelLabels;
  const sortModelIds = availRoot.agentModelSorts?.[0]?.groups?.[0]?.modelIds;
  if (Array.isArray(sortLabels) && sortLabels.length > 0) {
    const byLabel = new Map();
    for (const cfg of clientConfigs) {
      if (isPlainObject(cfg) && cfg.label) byLabel.set(cfg.label, cfg);
    }
    for (const lbl of sortLabels) {
      const cfg = byLabel.get(lbl);
      if (cfg) pushClientEntry(cfg);
    }
  } else if (Array.isArray(sortModelIds) && sortModelIds.length > 0) {
    const byCfgModelId = new Map();
    for (const cfg of clientConfigs) {
      if (isPlainObject(cfg) && cfg.modelId) byCfgModelId.set(cfg.modelId, cfg);
    }
    for (const mid of sortModelIds) {
      const cfg = byCfgModelId.get(mid);
      if (cfg) pushClientEntry(cfg);
    }
  }

  for (const cfg of clientConfigs) {
    if (isPlainObject(cfg)) pushClientEntry(cfg);
  }

  // Ensure mergedModels follows clientConfigs order first when clientConfigs exist
  const finalModelsMap = new Map();
  for (const item of orderedClientItems) {
    finalModelsMap.set(item.id, item);
  }
  if (clientConfigs.length === 0) {
    for (const [id, item] of byId.entries()) {
      finalModelsMap.set(id, item);
    }
  } else {
    // Preserve explicit non-internal avail models (e.g. unit test fixtures adding MODEL_C)
    for (const [id, item] of byId.entries()) {
      if (!finalModelsMap.has(id) && !PLACEHOLDER_ENUM_RE.test(id)) {
        finalModelsMap.set(id, item);
      }
    }
  }

  const groupedModelsMap = isPlainObject(modelConfigData.groupedModels)
    ? modelConfigData.groupedModels
    : (isPlainObject(availRoot.groupedModels) ? availRoot.groupedModels : null);

  const groups = Array.isArray(availRoot.groupedModels)
    ? availRoot.groupedModels
    : (groupedModelsMap
      ? Object.entries(groupedModelsMap).map(([groupId, g]) => ({ groupId, ...g }))
      : (Array.isArray(availRoot.agentModelSorts) ? availRoot.agentModelSorts : []));

  const flatModels = Array.from(finalModelsMap.values());
  let canonicalDefaultModelId = defaultModelId;
  if (defaultModelId) {
    const matched = flatModels.find(
      (m) => m.id === defaultModelId || m.modelId === defaultModelId
    ) || availByModelId.get(defaultModelId) || availByEnum.get(defaultModelId);
    if (matched?.id) {
      canonicalDefaultModelId = matched.id;
    }
  }
  for (const item of flatModels) {
    item.isDefault = Boolean(
      canonicalDefaultModelId &&
      (item.id === canonicalDefaultModelId || item.modelId === canonicalDefaultModelId)
    );
  }

  const tree = buildModelCatalogTree({
    orderedConfigs: orderedClientItems,
    groupedModelsMap,
    defaultModelId: canonicalDefaultModelId,
    fallbackFlatModels: flatModels
  });

  return {
    ok: true,
    defaultModelId: canonicalDefaultModelId,
    models: flatModels,
    groups,
    tree
  };
}

function buildMessageItems(text, attachments) {
  const items = [];
  if (typeof text === 'string' && text.trim().length > 0) {
    items.push({ text });
  }
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return items;
  }
  for (const att of attachments) {
    if (typeof att === 'string' && att.trim()) {
      items.push({ text: att });
    } else if (isPlainObject(att) && typeof att.text === 'string') {
      items.push({ text: att.text });
    }
  }
  return items;
}

function normalizeImageAttachments(images) {
  if (!Array.isArray(images) || images.length === 0) return [];
  const out = [];
  for (const img of images) {
    if (!isPlainObject(img)) continue;
    if (typeof img.inlineData === 'string' && img.inlineData) {
      out.push({
        mimeType: img.mimeType || img.mime || 'image/jpeg',
        inlineData: img.inlineData
      });
      continue;
    }
    if (typeof img.dataUrl === 'string' && img.dataUrl.startsWith('data:')) {
      const m = img.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (m) {
        out.push({
          mimeType: img.mime || m[1] || 'image/jpeg',
          inlineData: m[2]
        });
      }
    }
  }
  return out;
}

function buildConversationalPlannerConfig(mode) {
  if (typeof mode !== 'string' || !mode.trim()) return null;
  const clean = mode.trim().toLowerCase();
  if (clean === 'plan' || clean === 'read_only' || clean === 'readonly') {
    return {
      plannerMode: 'CONVERSATIONAL_PLANNER_MODE_READ_ONLY',
      agenticMode: false
    };
  }
  if (clean === 'chat' || clean === 'default' || clean === 'agent') {
    return {
      plannerMode: 'CONVERSATIONAL_PLANNER_MODE_DEFAULT',
      agenticMode: true
    };
  }
  return null;
}

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

function buildApprovalInteractionPayload({ step, allow, payload = {} }) {
  const reqInteraction = isPlainObject(step?.requestedInteraction?.interaction)
    ? step.requestedInteraction.interaction
    : (isPlainObject(step?.requestedInteraction)
      ? step.requestedInteraction
      : (isPlainObject(payload?.requestedInteraction) ? payload.requestedInteraction : {}));

  for (const field of CONFIRM_INTERACTION_FIELDS) {
    if (reqInteraction[field] !== undefined) {
      return {
        interactionType: field,
        body: { confirm: allow }
      };
    }
  }

  if (reqInteraction.filePermission !== undefined) {
    return {
      interactionType: 'filePermission',
      body: {
        allow,
        scope: payload?.scope || 'PERMISSION_SCOPE_ONCE',
        absolutePathUri: reqInteraction.filePermission?.absolutePathUri || payload?.absolutePathUri || ''
      }
    };
  }

  if (
    reqInteraction.runCommand !== undefined ||
    (reqInteraction.permission === undefined && step?.type === 'CORTEX_STEP_TYPE_RUN_COMMAND')
  ) {
    const cmdLine =
      payload?.submittedCommandLine ||
      reqInteraction.runCommand?.proposedCommandLine ||
      step?.runCommand?.proposedCommandLine ||
      step?.runCommand?.commandLine ||
      '';
    return {
      interactionType: 'runCommand',
      body: {
        confirm: allow,
        ...(cmdLine ? { proposedCommandLine: cmdLine, submittedCommandLine: cmdLine } : {}),
        ...(payload?.sandboxOverride !== undefined ? { sandboxOverride: Boolean(payload.sandboxOverride) } : {})
      }
    };
  }

  return {
    interactionType: 'permission',
    body: {
      allow,
      scope: payload?.scope || 'PERMISSION_SCOPE_ONCE',
      ...(payload?.editedTarget ? { editedTarget: payload.editedTarget } : {}),
      ...(payload?.userDenyInstruction ? { userDenyInstruction: payload.userDenyInstruction } : {})
    }
  };
}

function normalizeQuestionOptions(rawOptions) {
  if (!Array.isArray(rawOptions)) return [];
  return rawOptions.map((opt, idx) => {
    if (typeof opt === 'string') {
      return { id: opt, text: opt };
    }
    if (isPlainObject(opt)) {
      const text = String(opt.text || opt.label || opt.id || `Option ${idx + 1}`);
      const id = String(opt.id || opt.value || opt.label || opt.text || String(idx));
      return { id, text };
    }
    return { id: String(idx), text: String(opt) };
  });
}

function buildAskQuestionResponses(step, answers, payload = {}) {
  if (isPlainObject(answers) && Array.isArray(answers.responses)) {
    return answers.responses;
  }
  if (isPlainObject(payload) && Array.isArray(payload.responses)) {
    return payload.responses;
  }

  const stepQuestions =
    step?.requestedInteraction?.interaction?.askQuestion?.questions ||
    step?.requestedInteraction?.askQuestion?.questions ||
    step?.askQuestion?.questions ||
    [];

  const answerList = Array.isArray(answers) ? answers : (isPlainObject(answers) ? [answers] : []);
  const count = Math.max(stepQuestions.length, answerList.length);
  const responses = [];

  for (let idx = 0; idx < count; idx++) {
    const rawQ = stepQuestions[idx];
    const qObj = isPlainObject(rawQ) ? rawQ : {};
    const matchedAns = answerList.find((a) => isPlainObject(a) && a.index === idx) ?? answerList[idx];
    const ansObj = isPlainObject(matchedAns) ? matchedAns : {};

    const questionText =
      (typeof rawQ === 'string' ? rawQ : null) ||
      qObj.question ||
      qObj.prompt ||
      qObj.text ||
      ansObj.question ||
      `Question ${idx + 1}`;

    const options = normalizeQuestionOptions(qObj.options || ansObj.options);

    if (Array.isArray(ansObj.selectedOptionIds) || typeof ansObj.writeInResponse === 'string') {
      responses.push({
        question: String(questionText),
        options,
        isMultiSelect: Boolean(qObj.isMultiSelect ?? ansObj.isMultiSelect),
        selectedOptionIds: Array.isArray(ansObj.selectedOptionIds) ? ansObj.selectedOptionIds.map(String) : [],
        writeInResponse: typeof ansObj.writeInResponse === 'string' ? ansObj.writeInResponse : '',
        skipped: Boolean(ansObj.skipped)
      });
      continue;
    }

    const ansText = typeof matchedAns === 'string'
      ? matchedAns
      : (typeof ansObj.answer === 'string' ? ansObj.answer : '');
    const matchedOpt = options.find((o) => o.id === ansText || o.text === ansText);
    responses.push({
      question: String(questionText),
      options,
      isMultiSelect: Boolean(qObj.isMultiSelect),
      selectedOptionIds: matchedOpt ? [matchedOpt.id] : [],
      writeInResponse: matchedOpt ? '' : ansText,
      skipped: Boolean(ansObj.skipped)
    });
  }

  return responses;
}

function createHarnessAdapter({ rpc } = {}) {
  if (!rpc || typeof rpc.call !== 'function') {
    throw new TypeError('createHarnessAdapter requires an rpc transport with .call(method, params)');
  }

  // Per-session cursor: { stepOffset: number, fingerprints: Map<number, string> }
  const sessionCursors = new Map();
  const createdCascadeIds = new Set();
  const modelCatalogCache = {
    variantMap: new Map(),
    idToFamily: new Map(),
    orchestratorIds: new Set(),
    orchestratorBackingMap: new Map()
  };

  function updateModelCatalogCache(catalog) {
    modelCatalogCache.variantMap.clear();
    modelCatalogCache.idToFamily.clear();
    modelCatalogCache.orchestratorIds.clear();
    modelCatalogCache.orchestratorBackingMap.clear();

    const walk = (nodes) => {
      if (!Array.isArray(nodes)) return;
      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        if (node.kind === 'leaf' && node.selection) {
          const req = String(node.selection.requestedModel || '').trim();
          const mid = String(node.selection.modelId || '').trim();
          if (node.selection.mode === 'orchestrator_preset') {
            if (req) modelCatalogCache.orchestratorIds.add(req);
            if (mid) modelCatalogCache.orchestratorIds.add(mid);
            if (isPlainObject(node.selection.backingModels)) {
              if (req) modelCatalogCache.orchestratorBackingMap.set(req, node.selection.backingModels);
              if (mid) modelCatalogCache.orchestratorBackingMap.set(mid, node.selection.backingModels);
            }
          } else if (node.role === 'thinking_level' && node.key.startsWith('family/')) {
            const parts = node.key.split('/');
            if (parts.length >= 3) {
              const familyId = parts[1];
              const suffix = normalizeThinkingSuffix(parts[2]) || parts[2];
              if (req) modelCatalogCache.idToFamily.set(req, familyId);
              if (mid) modelCatalogCache.idToFamily.set(mid, familyId);
              if (familyId && suffix && req) {
                modelCatalogCache.variantMap.set(`${familyId}:${suffix}`, req);
              }
            }
          }
        } else if (Array.isArray(node.children)) {
          walk(node.children);
        }
      }
    };
    walk(catalog?.tree?.nodes);
  }

  function getOrCreateCursor(cascadeId) {
    let cursor = sessionCursors.get(cascadeId);
    if (!cursor) {
      cursor = { stepOffset: 0, fingerprints: new Map() };
      sessionCursors.set(cascadeId, cursor);
    }
    return cursor;
  }

  function assertCascadeId(cascadeId) {
    if (typeof cascadeId !== 'string' || !cascadeId.trim()) {
      throw createAdapterError('cascadeId is required', 400, 'INVALID_CASCADE_ID');
    }
    return cascadeId.trim();
  }

  return {
    async listSessions({ limit = 50 } = {}) {
      const resp = await rpc.call('GetAllCascadeTrajectories', {});
      const summaries = isPlainObject(resp?.trajectorySummaries) ? resp.trajectorySummaries : {};
      const sessions = Object.entries(summaries)
        .map(([cascadeId, item]) => normalizeSessionSummary(cascadeId, item))
        .sort((a, b) => {
          const tb = Date.parse(b.lastModifiedTime || '') || 0;
          const ta = Date.parse(a.lastModifiedTime || '') || 0;
          return tb - ta;
        });

      const parsedLimit = Number(limit);
      const bounded = Number.isFinite(parsedLimit) && parsedLimit > 0
        ? sessions.slice(0, Math.floor(parsedLimit))
        : sessions;
      return { ok: true, sessions: bounded };
    },

    async getSessionDetail(cascadeId) {
      const id = assertCascadeId(cascadeId);
      let resp = null;
      try {
        resp = await rpc.call('GetCascadeTrajectory', { cascadeId: id });
      } catch (err) {
        const msg = String(err?.message || '');
        const isNotFound = err?.statusCode === 404
          || /not[\s_]*found|no[\s_]*trajectory|unknown[\s_]*cascade/i.test(msg);
        if (isNotFound && createdCascadeIds.has(id)) {
          return {
            ok: true,
            session: {
              cascadeId: id,
              trajectoryId: null,
              trajectoryType: null,
              status: 'CASCADE_RUN_STATUS_IDLE',
              numTotalSteps: 0,
              source: null,
              metadata: null,
              generatorMetadata: []
            },
            events: []
          };
        }
        throw err;
      }
      const trajectory = isPlainObject(resp?.trajectory) ? resp.trajectory : (isPlainObject(resp) ? resp : {});
      const rawSteps = Array.isArray(trajectory.steps)
        ? trajectory.steps
        : (Array.isArray(resp?.steps) ? resp.steps : []);
      const events = rawSteps.map((step, idx) => normalizeStepToSessionEvent(step, idx));
      const status = (typeof resp?.status === 'string' && resp.status.trim())
        || (typeof trajectory.status === 'string' && trajectory.status.trim())
        || 'CASCADE_RUN_STATUS_IDLE';
      const hasNumTotal = resp?.numTotalSteps !== null
        && resp?.numTotalSteps !== undefined
        && Number.isFinite(Number(resp.numTotalSteps));
      const session = {
        cascadeId: trajectory.cascadeId || id,
        trajectoryId: trajectory.trajectoryId || null,
        trajectoryType: trajectory.trajectoryType || null,
        status,
        numTotalSteps: hasNumTotal ? Number(resp.numTotalSteps) : rawSteps.length,
        source: trajectory.source || null,
        metadata: trajectory.metadata || null,
        generatorMetadata: Array.isArray(trajectory.generatorMetadata) ? trajectory.generatorMetadata : []
      };
      return { ok: true, session, events };
    },

    async pollDelta(cascadeId, { afterSeq } = {}) {
      const id = assertCascadeId(cascadeId);
      const cursor = getOrCreateCursor(id);
      const hasExplicitAfter = afterSeq !== undefined && afterSeq !== null && Number.isInteger(Number(afterSeq));
      const requestOffset = hasExplicitAfter
        ? Math.max(0, Number(afterSeq) + 1)
        : cursor.stepOffset;

      const resp = await rpc.call('GetCascadeTrajectorySteps', {
        cascadeId: id,
        stepOffset: requestOffset
      });

      const rawSteps = Array.isArray(resp?.steps)
        ? resp.steps
        : (Array.isArray(resp?.trajectory?.steps) ? resp.trajectory.steps : []);

      const normalized = rawSteps.map((step, idx) => {
        const seq = Number.isInteger(step?.stepIndex) ? step.stepIndex : requestOffset + idx;
        return normalizeStepToSessionEvent(step, seq);
      });

      const emitted = [];
      for (const ev of normalized) {
        if (hasExplicitAfter) {
          emitted.push(ev);
          continue;
        }
        const fp = computeEventFingerprint(ev);
        if (cursor.fingerprints.get(ev.seq) !== fp) {
          cursor.fingerprints.set(ev.seq, fp);
          emitted.push(ev);
        }
      }

      let contiguousTerminal = requestOffset;
      for (const ev of normalized) {
        if (ev.seq !== contiguousTerminal) break;
        if (!TERMINAL_STEP_STATUSES.has(ev.status)) break;
        contiguousTerminal++;
      }

      if (!hasExplicitAfter) {
        cursor.stepOffset = contiguousTerminal;
        for (const seqKey of cursor.fingerprints.keys()) {
          if (seqKey < cursor.stepOffset) {
            cursor.fingerprints.delete(seqKey);
          }
        }
      }

      const activeOffset = hasExplicitAfter ? contiguousTerminal : cursor.stepOffset;
      const totalSteps = Number.isFinite(Number(resp?.numTotalSteps))
        ? Number(resp.numTotalSteps)
        : Math.max(requestOffset + normalized.length, activeOffset);

      const hasNonTerminal = normalized.some((ev) => !TERMINAL_STEP_STATUSES.has(ev.status));
      const status = resp?.status
        || resp?.trajectory?.status
        || (hasNonTerminal ? 'CASCADE_RUN_STATUS_RUNNING' : 'CASCADE_RUN_STATUS_IDLE');

      return {
        ok: true,
        cascadeId: id,
        status,
        totalSteps,
        stepOffset: activeOffset,
        events: emitted,
        hasChanges: emitted.length > 0
      };
    },

    resetSessionCursor(cascadeId) {
      if (cascadeId === undefined || cascadeId === null) {
        sessionCursors.clear();
        return { ok: true };
      }
      sessionCursors.delete(String(cascadeId).trim());
      return { ok: true };
    },

    async createSession({ title, workspaceUri } = {}) {
      const baseParams = {
        source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT',
        metadata: { ...DEFAULT_METADATA }
      };
      const cleanUri = typeof workspaceUri === 'string' && workspaceUri.trim() ? workspaceUri.trim() : '';
      let resp;
      if (cleanUri) {
        try {
          resp = await rpc.call('StartCascade', {
            ...baseParams,
            workspaceUris: [cleanUri]
          });
        } catch {
          resp = await rpc.call('StartCascade', baseParams);
        }
      } else {
        resp = await rpc.call('StartCascade', baseParams);
      }
      if (!resp?.cascadeId) {
        throw createAdapterError('StartCascade did not return cascadeId', 502, 'RPC_INVALID_RESPONSE');
      }
      createdCascadeIds.add(resp.cascadeId);
      return {
        ok: true,
        cascadeId: resp.cascadeId,
        ...(title ? { title } : {}),
        ...(cleanUri ? { workspaceUri: cleanUri } : {})
      };
    },

    async sendMessage(cascadeId, { text, modelId, thinkingLevel, mode, attachments, images } = {}) {
      const id = assertCascadeId(cascadeId);
      const hasText = typeof text === 'string' && text.trim().length > 0;
      const normalizedImages = normalizeImageAttachments(images);
      if (!hasText && normalizedImages.length === 0) {
        throw createAdapterError('Message text must be a non-empty string', 400, 'EMPTY_MESSAGE_TEXT');
      }
      const params = {
        cascadeId: id,
        items: buildMessageItems(hasText ? text : '', attachments),
        metadata: { ...DEFAULT_METADATA }
      };
      if (normalizedImages.length > 0) {
        params.images = normalizedImages;
      }
      const cleanModelId = typeof modelId === 'string' && modelId.trim() ? modelId.trim() : '';
      const cleanThinking = normalizeThinkingSuffix(thinkingLevel);
      const conversational = buildConversationalPlannerConfig(mode);

      if (cleanModelId) {
        let resolvedModel = cleanModelId;
        const isSyntheticOrch = cleanModelId.startsWith('orchestrator:');
        if (isSyntheticOrch && modelCatalogCache.orchestratorBackingMap.size === 0) {
          try {
            await this.listModels();
          } catch {
            // Best-effort cold cache hydration
          }
        }
        const backingMap = modelCatalogCache.orchestratorBackingMap.get(cleanModelId);
        let resolvedFromBacking = false;
        if (backingMap) {
          const targetSuffix = cleanThinking || 'high';
          const candidate = backingMap[targetSuffix]
            || backingMap.high
            || backingMap.medium
            || Object.values(backingMap)[0];
          if (candidate) {
            resolvedModel = candidate;
            resolvedFromBacking = true;
          }
        } else if (isSyntheticOrch) {
          const fam = cleanModelId.slice('orchestrator:'.length).trim();
          const targetSuffix = cleanThinking || 'high';
          const fallbackCandidate = modelCatalogCache.variantMap.get(`${fam}:${targetSuffix}`)
            || modelCatalogCache.variantMap.get(`${fam}:high`)
            || modelCatalogCache.variantMap.get(`${fam}:medium`)
            || modelCatalogCache.variantMap.get(`${fam}:low`);
          if (fallbackCandidate) {
            resolvedModel = fallbackCandidate;
            resolvedFromBacking = true;
          }
        }

        const isOrch = !resolvedFromBacking && (
          modelCatalogCache.orchestratorIds.has(cleanModelId)
          || /^gemini-pro-orchestrator/i.test(cleanModelId)
        );

        if (cleanThinking && !isOrch && !resolvedFromBacking) {
          const familyId = modelCatalogCache.idToFamily.get(cleanModelId);
          const variantModel = familyId
            ? modelCatalogCache.variantMap.get(`${familyId}:${cleanThinking}`)
            : null;
          if (variantModel) {
            resolvedModel = variantModel;
          }
        }

        const basePlannerConfig = {
          requestedModel: {
            model: resolvedModel
          },
          ...(conversational ? { conversational } : {})
        };

        const needsThinkingField = Boolean(
          cleanThinking && !resolvedFromBacking && (isOrch || resolvedModel === cleanModelId)
        );
        if (needsThinkingField) {
          const numericThinking = THINKING_NUM_BY_SUFFIX[cleanThinking];
          const plannerConfigWithThinking = {
            ...basePlannerConfig,
            thinkingLevel: numericThinking || cleanThinking
          };
          try {
            await rpc.call('SendUserCascadeMessage', {
              ...params,
              cascadeConfig: { plannerConfig: plannerConfigWithThinking }
            });
            return { ok: true, cascadeId: id };
          } catch {
            params.cascadeConfig = { plannerConfig: basePlannerConfig };
          }
        } else {
          params.cascadeConfig = { plannerConfig: basePlannerConfig };
        }
      } else if (conversational) {
        params.cascadeConfig = { plannerConfig: { conversational } };
      }

      await rpc.call('SendUserCascadeMessage', params);
      return { ok: true, cascadeId: id };
    },

    async cancelSession(cascadeId) {
      const id = assertCascadeId(cascadeId);
      await rpc.call('CancelCascadeInvocation', { cascadeId: id });
      return { ok: true, cascadeId: id };
    },

    async deleteSession(cascadeId) {
      const id = assertCascadeId(cascadeId);
      await rpc.call('DeleteCascadeTrajectory', { cascadeId: id });
      sessionCursors.delete(id);
      createdCascadeIds.delete(id);
      return { ok: true, cascadeId: id, hostCleaned: true };
    },

    async approveStep(cascadeId, stepIdx, decision = 'allow', payload = {}) {
      const id = assertCascadeId(cascadeId);
      const idx = Number(stepIdx);
      if (!Number.isInteger(idx) || idx < 0) {
        throw createAdapterError('stepIdx must be a non-negative integer', 400, 'INVALID_STEP_INDEX');
      }
      const allow = typeof decision === 'boolean'
        ? decision
        : !['deny', 'reject', 'false', '0', 'cancel'].includes(String(decision || 'allow').trim().toLowerCase());

      const detail = await rpc.call('GetCascadeTrajectory', { cascadeId: id });
      const trajectory = isPlainObject(detail?.trajectory) ? detail.trajectory : (isPlainObject(detail) ? detail : {});
      const steps = Array.isArray(trajectory.steps)
        ? trajectory.steps
        : (Array.isArray(detail?.steps) ? detail.steps : []);
      const step = steps.find((s, i) => (Number.isInteger(s?.stepIndex) ? s.stepIndex : i) === idx) || steps[idx] || null;
      const trajectoryId = step?.sourceTrajectoryStepInfo?.trajectoryId || payload?.trajectoryId || trajectory.trajectoryId || id;
      const resolvedStepIndex = Number.isInteger(step?.sourceTrajectoryStepInfo?.stepIndex)
        ? step.sourceTrajectoryStepInfo.stepIndex
        : (Number.isInteger(step?.stepIndex) ? step.stepIndex : idx);

      const { interactionType, body } = buildApprovalInteractionPayload({
        step,
        allow,
        payload
      });

      await rpc.call('HandleCascadeUserInteraction', {
        cascadeId: id,
        interaction: {
          trajectoryId,
          stepIndex: resolvedStepIndex,
          [interactionType]: body
        }
      });

      return {
        ok: true,
        supported: true,
        cascadeId: id,
        stepIndex: resolvedStepIndex,
        trajectoryId,
        interactionType,
        decision: allow ? 'allow' : 'deny'
      };
    },

    async answerQuestion(cascadeId, stepIdx, answers = [], payload = {}) {
      const id = assertCascadeId(cascadeId);
      const idx = Number(stepIdx);
      if (!Number.isInteger(idx) || idx < 0) {
        throw createAdapterError('stepIdx must be a non-negative integer', 400, 'INVALID_STEP_INDEX');
      }

      const detail = await rpc.call('GetCascadeTrajectory', { cascadeId: id });
      const trajectory = isPlainObject(detail?.trajectory) ? detail.trajectory : (isPlainObject(detail) ? detail : {});
      const steps = Array.isArray(trajectory.steps)
        ? trajectory.steps
        : (Array.isArray(detail?.steps) ? detail.steps : []);
      const step = steps.find((s, i) => (Number.isInteger(s?.stepIndex) ? s.stepIndex : i) === idx) || steps[idx] || null;
      const trajectoryId = step?.sourceTrajectoryStepInfo?.trajectoryId || payload?.trajectoryId || trajectory.trajectoryId || id;
      const resolvedStepIndex = Number.isInteger(step?.sourceTrajectoryStepInfo?.stepIndex)
        ? step.sourceTrajectoryStepInfo.stepIndex
        : (Number.isInteger(step?.stepIndex) ? step.stepIndex : idx);

      const responses = buildAskQuestionResponses(step, answers, payload);
      const cancelled = Boolean(payload?.cancelled || answers?.cancelled);

      await rpc.call('HandleCascadeUserInteraction', {
        cascadeId: id,
        interaction: {
          trajectoryId,
          stepIndex: resolvedStepIndex,
          askQuestion: {
            responses,
            cancelled
          }
        }
      });

      return {
        ok: true,
        supported: true,
        cascadeId: id,
        stepIndex: resolvedStepIndex,
        trajectoryId,
        responses
      };
    },

    async listModels() {
      const [userStatusOutcome, availOutcome] = await Promise.allSettled([
        rpc.call('GetUserStatus', { metadata: { ...DEFAULT_METADATA } }),
        rpc.call('GetAvailableModels', { forceRefresh: false })
      ]);

      if (userStatusOutcome.status === 'rejected' && availOutcome.status === 'rejected') {
        throw availOutcome.reason || userStatusOutcome.reason;
      }

      const userStatusRes = userStatusOutcome.status === 'fulfilled' ? userStatusOutcome.value : {};
      const availRes = availOutcome.status === 'fulfilled' ? availOutcome.value : {};
      const catalog = normalizeModelCatalog(userStatusRes, availRes);
      updateModelCatalogCache(catalog);
      return catalog;
    }
  };
}

module.exports = {
  normalizeStepStatus,
  normalizeStepToSessionEvent,
  normalizeSessionSummary,
  STEP_TYPE_MAPPERS,
  createHarnessAdapter
};
