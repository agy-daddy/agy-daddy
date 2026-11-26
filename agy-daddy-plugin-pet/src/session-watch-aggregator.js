'use strict';

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

function stripMarkdownToPlain(text, maxLen = 68) {
  const s = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/[*_~>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(1, maxLen - 1))}…`;
}

function normalizePathKey(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  if (s.startsWith('file://')) {
    try { s = decodeURIComponent(new URL(s).pathname); } catch {}
  }
  return s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function resolveSessionOrgInfo(session = {}, orgSummary = null) {
  const cascadeId = String(session.cascadeId || '').trim();
  const projects = Array.isArray(orgSummary?.projects) ? orgSummary.projects : [];
  const groups = Array.isArray(orgSummary?.groups) ? orgSummary.groups : [];
  const projectGroupMap = orgSummary?.projectGroupMap || {};
  const sessionGroupMap = orgSummary?.sessionGroupMap || {};
  const sessionProjectOverrides = orgSummary?.sessionProjectOverrides || {};

  let matchedProject = null;
  const overridePid = sessionProjectOverrides[cascadeId];
  if (overridePid) {
    matchedProject = projects.find((p) => p.id === overridePid || (Array.isArray(p.aliases) && p.aliases.includes(overridePid))) || null;
  }

  if (!matchedProject) {
    const wsKey = normalizePathKey(session.workspaceUri || session.workspacePath || '');
    const explicitPid = String(session.projectId || '').trim();
    if (explicitPid) {
      matchedProject = projects.find((p) => p.id === explicitPid || (Array.isArray(p.aliases) && p.aliases.includes(explicitPid))) || null;
    }
    if (!matchedProject && wsKey) {
      matchedProject = projects.find((p) => {
        const pKey = normalizePathKey(p.rootPath || p.uri);
        return pKey && (wsKey === pKey || wsKey.startsWith(`${pKey}/`));
      }) || null;
    }
  }

  const projectId = matchedProject?.id || (session.projectId ? String(session.projectId) : null);
  const projectName = matchedProject?.name || session.projectName || null;
  const groupId = sessionGroupMap[cascadeId] || (projectId ? projectGroupMap[projectId] : null) || matchedProject?.groupId || session.groupId || null;
  const groupObj = groupId ? groups.find((g) => g.id === groupId) : null;

  return {
    projectId,
    projectAliases: Array.isArray(matchedProject?.aliases) ? matchedProject.aliases : [],
    projectName,
    groupId,
    groupName: groupObj?.name || null
  };
}

/**
 * Deterministic 4D Watch Filter evaluation matching DESKTOP_PET_DESIGN.md Section 3.4:
 * 1. Lifecycle exclusion (deleted / archived / isSubagent)
 * 2. Hard exclusion (excludeCurrentSession && cascadeId === currentFocusSessionId)
 * 3. Whitelist union (projectWhitelist ∪ groupWhitelist) or followCurrentSession
 */
function isSessionWatched(session = {}, filterConfig = {}, orgSummary = null, currentFocusSessionId = null) {
  const cascadeId = String(session.cascadeId || '').trim();
  if (!cascadeId) return false;

  // 1. Lifecycle exclusion
  if (session.isSubagent === true) return false;
  const deletedSet = new Set(Array.isArray(orgSummary?.deletedSessionIds) ? orgSummary.deletedSessionIds : []);
  const archivedSet = new Set(Array.isArray(orgSummary?.archivedSessionIds) ? orgSummary.archivedSessionIds : []);
  if (deletedSet.has(cascadeId) || archivedSet.has(cascadeId)) return false;

  // 2. Highest-priority hard exclusion
  const isCurrentFocus = Boolean(currentFocusSessionId && cascadeId === currentFocusSessionId);
  if (filterConfig.excludeCurrentSession === true && isCurrentFocus) {
    return false;
  }

  // 3. Whitelist evaluation
  const projectWhitelist = Array.isArray(filterConfig.projectWhitelist) ? filterConfig.projectWhitelist.filter(Boolean) : [];
  const groupWhitelist = Array.isArray(filterConfig.groupWhitelist) ? filterConfig.groupWhitelist.filter(Boolean) : [];
  const hasWhitelist = projectWhitelist.length > 0 || groupWhitelist.length > 0;
  const followCurrent = filterConfig.followCurrentSession !== false;

  if (!hasWhitelist) {
    return true;
  }

  const orgInfo = resolveSessionOrgInfo(session, orgSummary);
  const projectMatch = orgInfo.projectId
    ? (projectWhitelist.includes(orgInfo.projectId) || orgInfo.projectAliases.some((a) => projectWhitelist.includes(a)))
    : false;
  const groupMatch = orgInfo.groupId ? groupWhitelist.includes(orgInfo.groupId) : false;

  if (projectMatch || groupMatch) return true;
  if (followCurrent && isCurrentFocus) return true;
  return false;
}

function classifyStepAttention(step, stepIndex, sessionMeta = {}) {
  if (!step || typeof step !== 'object') return null;
  const status = String(step.status || '').toUpperCase();
  const type = String(step.type || '').toUpperCase();
  const isPending = status.includes('PENDING') || status.includes('WAITING');
  const cascadeId = String(sessionMeta.cascadeId || '');
  const sessionTitle = String(sessionMeta.sessionTitle || cascadeId.slice(0, 8));

  const req = step.requestedInteraction?.interaction || step.requestedInteraction;
  if (isPending && req && typeof req === 'object') {
    const matchedField = CONFIRM_INTERACTION_FIELDS.find((f) => req[f] !== undefined && req[f] !== null)
      || (req.filePermission ? 'filePermission' : null)
      || (req.runCommand ? 'runCommand' : null)
      || (req.permission ? 'permission' : null);
    if (matchedField) {
      return {
        id: `${cascadeId}:${stepIndex}:approval`,
        kind: 'approval',
        cascadeId,
        sessionTitle,
        projectId: sessionMeta.projectId || null,
        projectName: sessionMeta.projectName || null,
        groupId: sessionMeta.groupId || null,
        stepIndex,
        interactionType: matchedField,
        summary: stripMarkdownToPlain(
          req.runCommand?.commandLine || req.approvalInteraction?.summary || `等待人工审核 (${matchedField})`,
          76
        ) || `等待人工审核 (${matchedField})`,
        createdAt: Date.now()
      };
    }
  }

  if (isPending && type === 'CORTEX_STEP_TYPE_ASK_QUESTION' && (!Array.isArray(step.completedInteractions) || step.completedInteractions.length === 0)) {
    return {
      id: `${cascadeId}:${stepIndex}:approval`,
      kind: 'approval',
      cascadeId,
      sessionTitle,
      projectId: sessionMeta.projectId || null,
      projectName: sessionMeta.projectName || null,
      groupId: sessionMeta.groupId || null,
      stepIndex,
      interactionType: 'askQuestion',
      summary: stripMarkdownToPlain(step.askQuestion?.question || '等待回答确认问题', 76) || '等待回答确认问题',
      createdAt: Date.now()
    };
  }

  if (type === 'CORTEX_STEP_TYPE_ERROR_MESSAGE' || status.includes('ERROR')) {
    const errText = stripMarkdownToPlain(step.errorMessage?.message || step.error || '会话执行异常', 76);
    if (errText) {
      return {
        id: `${cascadeId}:${stepIndex}:error`,
        kind: 'error',
        cascadeId,
        sessionTitle,
        projectId: sessionMeta.projectId || null,
        projectName: sessionMeta.projectName || null,
        groupId: sessionMeta.groupId || null,
        stepIndex,
        summary: errText,
        createdAt: Date.now()
      };
    }
  }

  if (type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' && status.includes('DONE')) {
    const rawResp = step.plannerResponse?.modifiedResponse || step.plannerResponse?.response || '';
    const summary = stripMarkdownToPlain(rawResp, 68);
    if (summary) {
      return {
        id: `${cascadeId}:${stepIndex}:reply`,
        kind: 'reply',
        cascadeId,
        sessionTitle,
        projectId: sessionMeta.projectId || null,
        projectName: sessionMeta.projectName || null,
        groupId: sessionMeta.groupId || null,
        stepIndex,
        summary,
        createdAt: Date.now()
      };
    }
  }

  return null;
}

function estimateTextTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  let cjk = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3040 && code <= 0x30ff) || (code >= 0xac00 && code <= 0xd7af)) {
      cjk++;
    }
  }
  return (s.length - cjk) / 4 + cjk * 1.2;
}

class TailStepTpsEstimator {
  constructor(windowMs = 3000) {
    this.windowMs = windowMs;
    this.sessions = new Map();
  }

  sample(cascadeId, running, tailText, nowMs = Date.now()) {
    if (!running) {
      this.sessions.delete(cascadeId);
      return null;
    }
    const curTokens = estimateTextTokens(tailText);
    let rec = this.sessions.get(cascadeId);
    if (!rec || curTokens < rec.lastTokens) {
      rec = { samples: [{ t: nowMs, tokens: curTokens }], lastTokens: curTokens };
      this.sessions.set(cascadeId, rec);
      return null;
    }
    rec.lastTokens = curTokens;
    rec.samples.push({ t: nowMs, tokens: curTokens });
    const cutoff = nowMs - this.windowMs;
    while (rec.samples.length > 2 && rec.samples[1].t <= cutoff) {
      rec.samples.shift();
    }
    const anchor = rec.samples[0];
    const dtSec = (nowMs - anchor.t) / 1000;
    const dTok = curTokens - anchor.tokens;
    if (dtSec >= 0.4 && dTok >= 2) {
      return Number((dTok / dtSec).toFixed(1));
    }
    return null;
  }

  clear(cascadeId) {
    this.sessions.delete(cascadeId);
  }
}

module.exports = {
  CONFIRM_INTERACTION_FIELDS,
  stripMarkdownToPlain,
  resolveSessionOrgInfo,
  isSessionWatched,
  classifyStepAttention,
  TailStepTpsEstimator
};
