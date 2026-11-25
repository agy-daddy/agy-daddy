import { memo } from 'preact/compat';
import { useEffect, useState } from 'preact/hooks';
import type { PermissionLevel, SessionEvent, SessionEventStatus } from '../types';
import {
  extractPlannerText,
  extractUserText,
  formatBasename,
  isToolEvent,
  KIND_LABELS,
  summarizeToolEvent
} from './chatFilter';
import {
  extractCodeActionDiffLines,
  extractCodeActionDiffStats,
  extractCodeActionTargetFile
} from './codeActionUtils';
import { Markdown } from './Markdown';
import styles from './StepCard.module.css';

export interface StepCardProps {
  event: SessionEvent;
  permissionLevel?: PermissionLevel;
  onInspectFile?: (filePath: string) => void;
  onViewDiffFile?: (filePath: string) => void;
  onApprove?: (seq: number, decision: 'allow' | 'deny') => Promise<void> | void;
  onAnswer?: (seq: number, answers: unknown) => Promise<void> | void;
  thinkingExpandVersion?: number;
  thinkingExpandTarget?: boolean | null;
  searchQuery?: string;
  searchRegex?: boolean;
  searchCaseSensitive?: boolean;
  isCurrentMatch?: boolean;
}

const TERMINAL_STATUSES = new Set<SessionEventStatus>(['done', 'error', 'canceled']);

interface NormalizedQuestionOption {
  id: string;
  label: string;
  description?: string;
}

interface NormalizedQuestion {
  header?: string;
  question: string;
  isMultiSelect: boolean;
  options: NormalizedQuestionOption[];
}

interface ParsedCompletedAnswer {
  question?: string;
  answers: string[];
  skipped?: boolean;
}

function formatJson(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function normalizeQuestions(p: Record<string, unknown>): NormalizedQuestion[] {
  const reqInt =
    p.requestedInteraction && typeof p.requestedInteraction === 'object'
      ? (p.requestedInteraction as Record<string, unknown>)
      : null;
  const nestedInt =
    reqInt?.interaction && typeof reqInt.interaction === 'object'
      ? (reqInt.interaction as Record<string, unknown>)
      : null;
  const askFromNested =
    nestedInt?.askQuestion && typeof nestedInt.askQuestion === 'object'
      ? (nestedInt.askQuestion as Record<string, unknown>)
      : null;
  const askFromReq =
    reqInt?.askQuestion && typeof reqInt.askQuestion === 'object'
      ? (reqInt.askQuestion as Record<string, unknown>)
      : null;

  const rawQuestions =
    (Array.isArray(p.questions) && p.questions.length > 0 && p.questions) ||
    (Array.isArray(askFromNested?.questions) && askFromNested.questions) ||
    (Array.isArray(askFromReq?.questions) && askFromReq.questions) ||
    [];

  return rawQuestions.map((q, qIdx) => {
    if (typeof q === 'string') {
      return { question: q, isMultiSelect: false, options: [] };
    }
    const obj = (q && typeof q === 'object' ? q : {}) as Record<string, unknown>;
    const rawOpts = Array.isArray(obj.options) ? obj.options : [];
    const options: NormalizedQuestionOption[] = rawOpts.map((opt, oIdx) => {
      if (typeof opt === 'string') {
        return { id: opt, label: opt };
      }
      const o = (opt && typeof opt === 'object' ? opt : {}) as Record<string, unknown>;
      const label = String(o.label || o.text || o.id || `选项 ${oIdx + 1}`);
      const id = String(o.id || o.label || o.text || oIdx);
      const description = typeof o.description === 'string' ? o.description : undefined;
      return { id, label, description };
    });
    return {
      header: typeof obj.header === 'string' && obj.header ? obj.header : undefined,
      question: String(obj.question || obj.prompt || obj.text || `问题 ${qIdx + 1}`),
      isMultiSelect: Boolean(obj.isMultiSelect || obj.multiSelect),
      options
    };
  });
}

function parseCompletedAnswers(
  p: Record<string, unknown>,
  questions: NormalizedQuestion[]
): ParsedCompletedAnswer[] {
  const rawResponses: unknown[] = [];

  if (Array.isArray(p.responses)) {
    rawResponses.push(...p.responses);
  }
  if (Array.isArray(p.answers)) {
    rawResponses.push(...p.answers);
  }
  const completedList: unknown[] = [];
  if (Array.isArray(p.completedInteractions)) {
    completedList.push(...p.completedInteractions);
  }
  if (p.completedInteraction && typeof p.completedInteraction === 'object') {
    completedList.push(p.completedInteraction);
  }
  for (const ci of completedList) {
    if (!ci || typeof ci !== 'object') continue;
    const obj = ci as Record<string, unknown>;
    const askObj =
      obj.askQuestion && typeof obj.askQuestion === 'object'
        ? (obj.askQuestion as Record<string, unknown>)
        : obj.interaction &&
            typeof obj.interaction === 'object' &&
            (obj.interaction as Record<string, unknown>).askQuestion &&
            typeof (obj.interaction as Record<string, unknown>).askQuestion === 'object'
          ? ((obj.interaction as Record<string, unknown>).askQuestion as Record<string, unknown>)
          : null;
    if (askObj && Array.isArray(askObj.responses)) {
      rawResponses.push(...askObj.responses);
    } else if (Array.isArray(obj.responses)) {
      rawResponses.push(...obj.responses);
    } else if (
      obj.answer !== undefined ||
      obj.selectedOptionIds !== undefined ||
      obj.writeInResponse !== undefined
    ) {
      rawResponses.push(obj);
    }
  }
  if (rawResponses.length === 0 && typeof p.userResponse === 'string' && p.userResponse.trim()) {
    rawResponses.push(p.userResponse.trim());
  }

  return rawResponses.map((r, idx) => {
    if (typeof r === 'string') {
      return { answers: r ? [r] : [] };
    }
    const obj = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const q = questions[idx];
    const optMap = new Map<string, string>();
    if (q) {
      for (const o of q.options) optMap.set(o.id, o.label);
    }
    if (Array.isArray(obj.options)) {
      for (const o of obj.options) {
        if (o && typeof o === 'object') {
          const rec = o as Record<string, unknown>;
          const id = String(rec.id || rec.label || rec.text || '');
          const label = String(rec.label || rec.text || rec.id || '');
          if (id) optMap.set(id, label);
        }
      }
    }

    const chosen: string[] = [];
    if (Array.isArray(obj.selectedOptionIds)) {
      for (const id of obj.selectedOptionIds) {
        const key = String(id);
        chosen.push(optMap.get(key) || key);
      }
    }
    if (typeof obj.writeInResponse === 'string' && obj.writeInResponse.trim()) {
      chosen.push(obj.writeInResponse.trim());
    }
    if (chosen.length === 0 && typeof obj.answer === 'string' && obj.answer.trim()) {
      chosen.push(obj.answer.trim());
    }
    if (chosen.length === 0 && Array.isArray(obj.selectedOptions)) {
      for (const s of obj.selectedOptions) {
        if (typeof s === 'string' && s.trim()) chosen.push(s.trim());
      }
    }

    return {
      question: typeof obj.question === 'string' ? obj.question : q?.question,
      answers: chosen,
      skipped: Boolean(obj.skipped)
    };
  });
}

function getPendingSummaryLines(ev: SessionEvent): {
  command?: string;
  filePath?: string;
  cwd?: string;
  description?: string;
} {
  const p = ev.payload || {};
  const reqInt =
    p.requestedInteraction && typeof p.requestedInteraction === 'object'
      ? (p.requestedInteraction as Record<string, unknown>)
      : null;
  const nested =
    reqInt?.interaction && typeof reqInt.interaction === 'object'
      ? (reqInt.interaction as Record<string, unknown>)
      : reqInt;

  const runCmdObj =
    nested?.runCommand && typeof nested.runCommand === 'object'
      ? (nested.runCommand as Record<string, unknown>)
      : null;
  const filePermObj =
    nested?.filePermission && typeof nested.filePermission === 'object'
      ? (nested.filePermission as Record<string, unknown>)
      : null;
  const spec =
    p.actionSpec && typeof p.actionSpec === 'object'
      ? (p.actionSpec as Record<string, unknown>)
      : null;

  const command =
    (typeof p.commandLine === 'string' && p.commandLine) ||
    (typeof p.proposedCommandLine === 'string' && p.proposedCommandLine) ||
    (typeof runCmdObj?.proposedCommandLine === 'string' && runCmdObj.proposedCommandLine) ||
    undefined;

  const filePath =
    (typeof p.absolutePathUri === 'string' && p.absolutePathUri) ||
    (typeof spec?.targetFile === 'string' && spec.targetFile) ||
    (typeof filePermObj?.absolutePathUri === 'string' && filePermObj.absolutePathUri) ||
    undefined;

  const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : undefined;
  const description =
    (typeof spec?.description === 'string' && spec.description) ||
    (typeof p.description === 'string' && p.description) ||
    (!command && !filePath ? ev.title || summarizeToolEvent(ev) : undefined);

  return { command, filePath, cwd, description };
}

function formatDurationBadge(raw: unknown): string {
  if (raw === null || raw === undefined || raw === '') return '';
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw >= 1000 ? `${(raw / 1000).toFixed(1)}s` : `${Math.round(raw)}ms`;
  }
  return String(raw);
}

function StepCardInner({
  event,
  permissionLevel = 'L1',
  onInspectFile,
  onViewDiffFile,
  onApprove,
  onAnswer,
  thinkingExpandVersion = 0,
  thinkingExpandTarget = null,
  searchQuery,
  searchRegex = false,
  searchCaseSensitive = false,
  isCurrentMatch = false
}: StepCardProps) {
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [toolOpen, setToolOpen] = useState(false);
  const [diffExpanded, setDiffExpanded] = useState(false);
  const [copiedTurn, setCopiedTurn] = useState(false);
  const [selectedOptions, setSelectedOptions] = useState<Record<number, string[]>>({});
  const [customInputs, setCustomInputs] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (thinkingExpandVersion > 0 && thinkingExpandTarget !== null) {
      setThinkingOpen(thinkingExpandTarget);
    }
  }, [thinkingExpandVersion, thinkingExpandTarget]);

  const handleCopyText = (text: string) => {
    if (!text) return;
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopiedTurn(true);
        setTimeout(() => setCopiedTurn(false), 1500);
      })
      .catch(() => {});
  };

  const p = event.payload || {};
  const isUser = event.kind === 'user';
  const isOptimistic = isUser && p.optimistic === true;
  const isPending = event.status === 'pending';
  const isGenerating = event.status === 'generating';
  const isRunning = event.status === 'running' || isGenerating;
  const isError = event.kind === 'error' || event.status === 'error';
  const isReadOnly = permissionLevel === 'L0';
  const isStandaloneTool = isToolEvent(event) && !isPending;

  const handleDecision = async (decision: 'allow' | 'deny') => {
    if (!onApprove || isReadOnly || busy) return;
    setBusy(true);
    try {
      await onApprove(event.seq, decision);
    } finally {
      setBusy(false);
    }
  };

  const renderToolExpandedBody = () => {
    switch (event.kind) {
      case 'command': {
        const cmd = String(p.commandLine || p.proposedCommandLine || event.title || '');
        const hasExit = typeof p.exitCode === 'number';
        return (
          <>
            {cmd && (
              <pre className={styles.codeBlock} data-hscroll="1">
                $ {cmd}
              </pre>
            )}
            <div className={styles.metaRow}>
              {typeof p.cwd === 'string' && p.cwd && <span className="ag-chip">cwd: {p.cwd}</span>}
              {hasExit && (
                <span className="ag-chip" data-tone={p.exitCode === 0 ? 'ok' : 'danger'}>
                  exit {String(p.exitCode)}
                </span>
              )}
            </div>
            {typeof p.combinedOutput === 'string' && p.combinedOutput.length > 0 && (
              <pre className={styles.codeBlock} data-hscroll="1">
                {p.combinedOutput}
              </pre>
            )}
          </>
        );
      }

      case 'file_view': {
        const filePath = String(p.absolutePathUri || event.title || '');
        const hasRange = p.startLine != null && p.endLine != null;
        return (
          <>
            <div className={styles.metaRow}>
              {filePath &&
                (onInspectFile ? (
                  <button
                    type="button"
                    className={styles.fileBtn}
                    onClick={() => onInspectFile(filePath)}
                  >
                    {filePath}
                  </button>
                ) : (
                  <span className="ag-chip">{filePath}</span>
                ))}
              {hasRange && (
                <span className="ag-chip">
                  L{String(p.startLine)}-{String(p.endLine)}
                </span>
              )}
              {typeof p.numLines === 'number' && <span className="ag-chip">{p.numLines} 行</span>}
            </div>
            {typeof p.content === 'string' && p.content && (
              <pre className={styles.codeBlock} data-hscroll="1">
                {p.content}
              </pre>
            )}
          </>
        );
      }

      case 'code_action': {
        const spec = (p.actionSpec as Record<string, unknown> | undefined) || null;
        const targetFile = extractCodeActionTargetFile(p, event.title);
        const { additions, deletions } = extractCodeActionDiffStats(p);
        const diffLines = extractCodeActionDiffLines(p, 80);
        const visibleLines = diffExpanded ? diffLines : diffLines.slice(0, 16);
        const openDiff = onViewDiffFile || onInspectFile;
        return (
          <>
            {typeof spec?.description === 'string' && spec.description && (
              <Markdown
                text={spec.description}
                highlightQuery={searchQuery}
                highlightRegex={searchRegex}
                highlightCaseSensitive={searchCaseSensitive}
                isCurrentMatch={isCurrentMatch}
              />
            )}
            <div className={styles.metaRow}>
              {targetFile &&
                (onInspectFile ? (
                  <button
                    type="button"
                    className={styles.fileBtn}
                    onClick={() => onInspectFile(targetFile)}
                  >
                    {targetFile}
                  </button>
                ) : (
                  <span className="ag-chip">{targetFile}</span>
                ))}
              {additions !== null && (
                <span className="ag-chip" data-tone="ok">
                  +{additions}
                </span>
              )}
              {deletions !== null && (
                <span className="ag-chip" data-tone="danger">
                  -{deletions}
                </span>
              )}
              {targetFile && openDiff && (
                <button
                  type="button"
                  className={styles.viewDiffBtn}
                  onClick={() => openDiff(targetFile)}
                  data-testid={`code-action-diff-${event.seq}`}
                >
                  在 Diff 中查看 ↗
                </button>
              )}
            </div>
            {visibleLines.length > 0 ? (
              <div className={styles.diffPreviewWrap} data-testid={`code-action-lines-${event.seq}`}>
                {visibleLines.map((line, i) => (
                  <div
                    key={i}
                    className={[
                      styles.diffLine,
                      line.kind === 'add'
                        ? styles.diffLineAdd
                        : line.kind === 'del'
                          ? styles.diffLineDel
                          : line.kind === 'hunk'
                            ? styles.diffLineHunk
                            : styles.diffLineCtx
                    ].join(' ')}
                  >
                    <span className={styles.diffSign}>
                      {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
                    </span>
                    <span>{line.text}</span>
                  </div>
                ))}
                {diffLines.length > 16 && (
                  <button
                    type="button"
                    className={styles.diffExpandBtn}
                    onClick={() => setDiffExpanded((v) => !v)}
                  >
                    {diffExpanded ? '收起预览' : `展开其余 ${diffLines.length - 16} 行`}
                  </button>
                )}
              </div>
            ) : (
              spec &&
              !spec.description && (
                <pre className={styles.codeBlock} data-hscroll="1">
                  {formatJson(spec)}
                </pre>
              )
            )}
          </>
        );
      }

      case 'web_search': {
        const docs = Array.isArray(p.webDocuments) ? p.webDocuments : [];
        return (
          <>
            <div className={styles.metaRow}>
              {typeof p.query === 'string' && p.query && (
                <span className="ag-chip">检索: {p.query}</span>
              )}
              {docs.length > 0 && <span className="ag-chip">{docs.length} 条来源</span>}
            </div>
            {typeof p.summary === 'string' && p.summary && <Markdown text={p.summary} />}
            {docs.length > 0 && (
              <div className={styles.subList}>
                {docs.slice(0, 6).map((d, idx) => {
                  const doc = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>;
                  const title = String(doc.title || doc.url || `结果 ${idx + 1}`);
                  const url = typeof doc.url === 'string' ? doc.url : '';
                  return (
                    <div key={idx} className={styles.subItem}>
                      <div className={styles.subTitle}>
                        {url && (url.startsWith('http://') || url.startsWith('https://')) ? (
                          <a href={url} target="_blank" rel="noreferrer noopener">
                            {title}
                          </a>
                        ) : (
                          title
                        )}
                      </div>
                      {typeof doc.snippet === 'string' && <div>{doc.snippet}</div>}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        );
      }

      case 'checkpoint': {
        return (
          <>
            {typeof p.sessionSummary === 'string' && p.sessionSummary && (
              <Markdown text={p.sessionSummary} />
            )}
            <div className={styles.metaRow}>
              {p.includedStepIndexEnd != null && (
                <span className="ag-chip">至步骤 #{String(p.includedStepIndexEnd)}</span>
              )}
              {typeof p.totalSubagentCount === 'number' && p.totalSubagentCount > 0 && (
                <span className="ag-chip">{p.totalSubagentCount} 子代理</span>
              )}
            </div>
          </>
        );
      }

      default: {
        return (
          <>
            {p.args !== undefined && (
              <pre className={styles.codeBlock} data-hscroll="1">
                {formatJson(p.args)}
              </pre>
            )}
            {p.result !== undefined && (
              <pre className={styles.codeBlock} data-hscroll="1">
                {formatJson(p.result)}
              </pre>
            )}
            {p.args === undefined && p.result === undefined && (
              <pre className={styles.codeBlock} data-hscroll="1">
                {formatJson(p)}
              </pre>
            )}
          </>
        );
      }
    }
  };

  // Standalone non-pending tool call: compact collapsed-by-default disclosure row
  if (isStandaloneTool) {
    const summary = summarizeToolEvent(event);
    const hasExit = event.kind === 'command' && typeof p.exitCode === 'number';
    const { additions, deletions } =
      event.kind === 'code_action'
        ? extractCodeActionDiffStats(p)
        : { additions: null, deletions: null };
    const inspectPath =
      event.kind === 'file_view' && typeof p.absolutePathUri === 'string'
        ? p.absolutePathUri
        : event.kind === 'code_action'
          ? extractCodeActionTargetFile(p, event.title)
          : '';
    const chipClickHandler =
      event.kind === 'code_action' && onViewDiffFile ? onViewDiffFile : onInspectFile;

    return (
      <article
        className={[
          styles.toolDisclosure,
          isRunning ? styles.toolDisclosureRunning : '',
          isError ? styles.cardError : ''
        ]
          .filter(Boolean)
          .join(' ')}
        data-testid={`step-card-${event.seq}`}
        data-kind={event.kind}
        data-status={event.status}
      >
        <div className={styles.toolRow}>
          <button
            type="button"
            className={styles.toolToggle}
            aria-expanded={toolOpen}
            onClick={() => setToolOpen((prev) => !prev)}
            data-testid={`tool-toggle-${event.seq}`}
          >
            {isRunning ? (
              <span className={styles.spinnerSm} aria-hidden="true" />
            ) : (
              <span
                className={[styles.statusDot, isError ? styles.dotError : styles.dotDone].join(' ')}
                aria-hidden="true"
              />
            )}
            <span className={styles.kind}>{KIND_LABELS[event.kind] || event.kind}</span>
            <span className={styles.toolSummaryText}>{summary}</span>
          </button>

          <div className={styles.toolRowRight}>
            {inspectPath && chipClickHandler && (
              <button
                type="button"
                className={styles.fileChipBtn}
                title={inspectPath}
                onClick={(e) => {
                  e.stopPropagation();
                  chipClickHandler(inspectPath);
                }}
              >
                <span className={styles.fileChipText}>{formatBasename(inspectPath)}</span>
              </button>
            )}
            {hasExit && (
              <span className="ag-chip" data-tone={p.exitCode === 0 ? 'ok' : 'danger'}>
                exit {String(p.exitCode)}
              </span>
            )}
            {additions !== null && (
              <span className="ag-chip" data-tone="ok">
                +{additions}
              </span>
            )}
            {deletions !== null && (
              <span className="ag-chip" data-tone="danger">
                -{deletions}
              </span>
            )}
            <button
              type="button"
              className={styles.chevronBtn}
              aria-label={toolOpen ? '收起' : '展开'}
              onClick={() => setToolOpen((prev) => !prev)}
            >
              <span className={[styles.chevron, toolOpen ? styles.chevronOpen : ''].join(' ')}>
                ▸
              </span>
            </button>
          </div>
        </div>

        {toolOpen && <div className={styles.toolExpanded}>{renderToolExpandedBody()}</div>}
      </article>
    );
  }

  // Pending authorization card (command / code_action / file_view / tool_generic / etc.)
  if (isPending && !isUser && event.kind !== 'ask_question') {
    const info = getPendingSummaryLines(event);
    return (
      <article
        className={`${styles.card} ${styles.cardPending}`}
        data-testid={`step-card-${event.seq}`}
        data-kind={event.kind}
        data-status={event.status}
      >
        <header className={styles.header}>
          <div className={styles.headerLeft}>
            <span className={styles.pendingDot} aria-hidden="true" />
            <span className={styles.kindPending}>待审批 · {KIND_LABELS[event.kind] || event.kind}</span>
            <span className={styles.seq}>#{event.seq}</span>
          </div>
          <span className={`${styles.status} ${styles.statusPending}`}>等待确认</span>
        </header>

        <div className={styles.approvalBody} data-testid={`inline-approval-${event.seq}`}>
          {info.description && <div className={styles.approvalDesc}>{info.description}</div>}
          {info.command && (
            <pre className={styles.approvalCmd} data-hscroll="1">
              $ {info.command}
            </pre>
          )}
          <div className={styles.metaRow}>
            {info.filePath &&
              (onInspectFile ? (
                <button
                  type="button"
                  className={styles.fileBtn}
                  onClick={() => onInspectFile(info.filePath!)}
                >
                  {info.filePath}
                </button>
              ) : (
                <span className="ag-chip">{info.filePath}</span>
              ))}
            {info.cwd && <span className="ag-chip">cwd: {info.cwd}</span>}
          </div>

          {onApprove && (
            <div className={styles.approvalActions}>
              <button
                type="button"
                className={`${styles.actionBtn} ${styles.denyBtn}`}
                disabled={isReadOnly || busy}
                onClick={() => handleDecision('deny')}
                data-testid={`inline-deny-${event.seq}`}
              >
                拒绝 Deny
              </button>
              <button
                type="button"
                className={`${styles.actionBtn} ${styles.allowBtn}`}
                disabled={isReadOnly || busy}
                onClick={() => handleDecision('allow')}
                data-testid={`inline-allow-${event.seq}`}
              >
                {busy ? '处理中...' : '允许 Allow'}
              </button>
            </div>
          )}

          {isReadOnly && (
            <div className={styles.roNote}>
              当前为 L0 只读模式，无法远程审批；请在桌面端处理或切换至 L1/L2
            </div>
          )}
        </div>
      </article>
    );
  }

  // Ask question card (interactive when pending, clean answer summary when done)
  if (event.kind === 'ask_question') {
    const questions = normalizeQuestions(p);
    const completedAnswers = !isPending ? parseCompletedAnswers(p, questions) : [];

    const toggleOption = (qIdx: number, optId: string, isMulti: boolean) => {
      setSelectedOptions((prev) => {
        const cur = prev[qIdx] || [];
        if (isMulti) {
          const exists = cur.includes(optId);
          return { ...prev, [qIdx]: exists ? cur.filter((id) => id !== optId) : [...cur, optId] };
        }
        return { ...prev, [qIdx]: cur[0] === optId ? [] : [optId] };
      });
    };

    const submitInlineAnswers = async () => {
      if (!onAnswer || isReadOnly || busy) return;
      setBusy(true);
      try {
        const payload = questions.map((q, idx) => {
          const selIds = selectedOptions[idx] || [];
          const custom = (customInputs[idx] || '').trim();
          const selLabels = selIds.map((id) => q.options.find((o) => o.id === id)?.label || id);
          const combinedAnswer = custom
            ? selLabels.length > 0
              ? `${selLabels.join(', ')}; ${custom}`
              : custom
            : selLabels.join(', ');
          return {
            index: idx,
            question: q.question,
            answer: combinedAnswer,
            selectedOptionIds: selIds,
            writeInResponse: custom
          };
        });
        await onAnswer(event.seq, payload);
      } finally {
        setBusy(false);
      }
    };

    return (
      <article
        className={[styles.card, isPending ? styles.cardPending : ''].filter(Boolean).join(' ')}
        data-testid={`step-card-${event.seq}`}
        data-kind={event.kind}
        data-status={event.status}
      >
        <header className={styles.header}>
          <div className={styles.headerLeft}>
            {isPending && <span className={styles.pendingDot} aria-hidden="true" />}
            <span className={isPending ? styles.kindPending : styles.kind}>
              {isPending ? '需要回答' : '已回答'}
            </span>
            <span className={styles.seq}>#{event.seq}</span>
          </div>
          <span className={`${styles.status} ${isPending ? styles.statusPending : ''}`}>
            {isPending ? '等待回复' : '已完成'}
          </span>
        </header>

        <div className={styles.subList} data-testid={`inline-question-${event.seq}`}>
          {questions.map((q, idx) => {
            const selIds = selectedOptions[idx] || [];
            const customVal = customInputs[idx] || '';
            const doneAns = completedAnswers[idx];

            return (
              <div key={idx} className={styles.qCard}>
                <div className={styles.qHead}>
                  {q.header && <span className={styles.qHeaderTag}>{q.header}</span>}
                  {q.isMultiSelect && isPending && <span className={styles.qMultiTag}>可多选</span>}
                </div>
                <div className={styles.qText}>{q.question}</div>

                {isPending ? (
                  <>
                    {q.options.length > 0 && (
                      <div className={styles.optRow}>
                        {q.options.map((opt) => {
                          const active = selIds.includes(opt.id);
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              disabled={isReadOnly || busy}
                              aria-pressed={active}
                              className={[
                                styles.optChip,
                                active ? styles.optChipActive : ''
                              ]
                                .filter(Boolean)
                                .join(' ')}
                              onClick={() => toggleOption(idx, opt.id, q.isMultiSelect)}
                            >
                              {q.isMultiSelect && (
                                <span className={styles.optCheck} aria-hidden="true">
                                  {active ? '✓' : '○'}
                                </span>
                              )}
                              <span>{opt.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                    <input
                      type="text"
                      className={styles.qInput}
                      disabled={isReadOnly || busy}
                      placeholder="或输入自定义回答..."
                      value={customVal}
                      onInput={(e) =>
                        setCustomInputs((prev) => ({
                          ...prev,
                          [idx]: (e.target as HTMLInputElement).value
                        }))
                      }
                    />
                  </>
                ) : (
                  <div className={styles.answeredRow}>
                    {doneAns?.skipped ? (
                      <span className="ag-chip">已跳过</span>
                    ) : doneAns && doneAns.answers.length > 0 ? (
                      doneAns.answers.map((ans, aIdx) => (
                        <span key={aIdx} className={styles.answeredChip}>
                          ✓ {ans}
                        </span>
                      ))
                    ) : q.options.length > 0 ? (
                      <div className={styles.metaRow}>
                        {q.options.map((opt) => (
                          <span key={opt.id} className="ag-chip">
                            {opt.label}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className={styles.mutedNote}>已提交</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {isPending && onAnswer && (
            <button
              type="button"
              className={`${styles.actionBtn} ${styles.allowBtn}`}
              disabled={isReadOnly || busy}
              onClick={submitInlineAnswers}
              data-testid={`inline-answer-submit-${event.seq}`}
            >
              {busy ? '提交中...' : '提交回答'}
            </button>
          )}

          {isPending && isReadOnly && (
            <div className={styles.roNote}>
              当前为 L0 只读模式，请在桌面端或升级 L1 后提交回答
            </div>
          )}
        </div>
      </article>
    );
  }

  // Standard cards: user, thinking_and_text, system, error
  const statusCls = isGenerating
    ? styles.statusGenerating
    : event.status === 'running'
      ? styles.statusRunning
      : event.status === 'error'
        ? styles.statusError
        : '';

  if (isUser) {
    const userText = extractUserText(p);
    return (
      <article
        className={[
          styles.userRow,
          isOptimistic ? styles.userRowOptimistic : '',
          isCurrentMatch ? styles.currentMatchOutline : ''
        ]
          .filter(Boolean)
          .join(' ')}
        data-testid={`step-card-${event.seq}`}
        data-kind={event.kind}
        data-status={event.status}
        data-optimistic={isOptimistic ? 'true' : undefined}
        data-current-match={isCurrentMatch ? '1' : undefined}
      >
        <div className={styles.userBubble}>
          <Markdown
            text={userText || '(空消息)'}
            highlightQuery={searchQuery}
            highlightRegex={searchRegex}
            highlightCaseSensitive={searchCaseSensitive}
            isCurrentMatch={isCurrentMatch}
          />
        </div>
        {(isOptimistic || isError || Boolean(userText)) && (
          <div className={styles.userFooter}>
            {isOptimistic && (
              <span className={`${styles.status} ${styles.statusOptimistic}`}>发送中…</span>
            )}
            {isError && (
              <span className={`${styles.status} ${styles.statusError}`}>发送异常</span>
            )}
            {userText && (
              <button
                type="button"
                className={styles.copyStepBtn}
                onClick={() => handleCopyText(userText)}
                aria-label="复制消息"
              >
                {copiedTurn ? '✓ 已复制' : '复制'}
              </button>
            )}
          </div>
        )}
      </article>
    );
  }

  if (event.kind === 'thinking_and_text') {
    const thinking = typeof p.thinking === 'string' ? p.thinking : '';
    const text = extractPlannerText(p);
    const duration = formatDurationBadge(p.thinkingDuration);
    const isThinkingLive = isRunning && !text;

    return (
      <article
        className={[
          styles.editorialAssistant,
          isError ? styles.editorialAssistantError : '',
          isCurrentMatch ? styles.currentMatchOutline : ''
        ]
          .filter(Boolean)
          .join(' ')}
        data-testid={`step-card-${event.seq}`}
        data-kind={event.kind}
        data-status={event.status}
        data-current-match={isCurrentMatch ? '1' : undefined}
      >
        {thinking && (
          <div
            className={[styles.thinkingBox, isThinkingLive ? styles.thinkingBoxLive : '']
              .filter(Boolean)
              .join(' ')}
          >
            <button
              type="button"
              className={styles.thinkingToggle}
              aria-expanded={thinkingOpen}
              onClick={() => setThinkingOpen((prev) => !prev)}
              data-testid={`thinking-toggle-${event.seq}`}
            >
              <span className={styles.thinkingLeft}>
                {isThinkingLive ? (
                  <span className={styles.pulseDot} aria-hidden="true" />
                ) : (
                  <span
                    className={[styles.chevron, thinkingOpen ? styles.chevronOpen : ''].join(' ')}
                  >
                    ▸
                  </span>
                )}
                <span>{isThinkingLive ? '正在思考' : '思考过程'}</span>
                {duration && <span className={styles.thinkingDur}>{duration}</span>}
              </span>
              <span className={styles.thinkingAction}>{thinkingOpen ? '收起' : '展开'}</span>
            </button>
            {thinkingOpen && (
              <pre className={styles.thinkingBody} data-testid={`thinking-body-${event.seq}`}>
                {thinking}
              </pre>
            )}
          </div>
        )}
        {text ? (
          <Markdown
            text={text}
            streaming={isRunning}
            highlightQuery={searchQuery}
            highlightRegex={searchRegex}
            highlightCaseSensitive={searchCaseSensitive}
            isCurrentMatch={isCurrentMatch}
          />
        ) : (
          isRunning &&
          !thinking && (
            <div className={styles.streamingPlaceholder}>
              <span className={styles.pulseDot} aria-hidden="true" />
              <span>正在生成回复...</span>
            </div>
          )
        )}
        {(isRunning || isError || Boolean(text)) && (
          <div className={styles.assistantMetaRow}>
            {(isRunning || isError) && (
              <span className={`${styles.status} ${statusCls}`}>
                {isGenerating ? '生成中' : event.status === 'running' ? '运行中' : '异常'}
              </span>
            )}
            {text && !isRunning && (
              <button
                type="button"
                className={styles.copyStepBtn}
                onClick={() => handleCopyText(text)}
                aria-label="复制回复"
                data-testid={`step-copy-${event.seq}`}
              >
                {copiedTurn ? '✓ 已复制' : '复制'}
              </button>
            )}
          </div>
        )}
      </article>
    );
  }

  const renderStandardBody = () => {
    switch (event.kind) {
      case 'system': {
        return (
          <>
            {typeof p.eventType === 'string' && p.eventType && (
              <div className={styles.metaRow}>
                <span className="ag-chip">{p.eventType}</span>
              </div>
            )}
            {typeof p.message === 'string' && p.message && (
              <Markdown
                text={p.message}
                highlightQuery={searchQuery}
                highlightRegex={searchRegex}
                highlightCaseSensitive={searchCaseSensitive}
                isCurrentMatch={isCurrentMatch}
              />
            )}
          </>
        );
      }

      case 'error': {
        return (
          <pre className={styles.codeBlock} data-hscroll="1">
            {formatJson(p.error ?? p) || '未知错误'}
          </pre>
        );
      }

      default:
        return (
          <pre className={styles.codeBlock} data-hscroll="1">
            {formatJson(p)}
          </pre>
        );
    }
  };

  return (
    <article
      className={[
        styles.card,
        isGenerating ? styles.cardGenerating : '',
        isError ? styles.cardError : '',
        isCurrentMatch ? styles.currentMatchOutline : ''
      ]
        .filter(Boolean)
        .join(' ')}
      data-testid={`step-card-${event.seq}`}
      data-kind={event.kind}
      data-status={event.status}
      data-current-match={isCurrentMatch ? '1' : undefined}
    >
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={[styles.kind, isError ? styles.kindError : ''].filter(Boolean).join(' ')}>
            {KIND_LABELS[event.kind] || event.kind}
          </span>
          {!isOptimistic && <span className={styles.seq}>#{event.seq}</span>}
          {event.title && <span className={styles.title}>{event.title}</span>}
        </div>
        {(isRunning || isError) && (
          <span className={`${styles.status} ${statusCls}`}>
            {isGenerating ? '生成中' : event.status === 'running' ? '运行中' : '异常'}
          </span>
        )}
      </header>
      <div className={styles.body}>{renderStandardBody()}</div>
    </article>
  );
}

export const StepCard = memo(StepCardInner, (prev, next) => {
  if (
    prev.permissionLevel !== next.permissionLevel ||
    prev.onInspectFile !== next.onInspectFile ||
    prev.onViewDiffFile !== next.onViewDiffFile ||
    prev.onApprove !== next.onApprove ||
    prev.onAnswer !== next.onAnswer ||
    prev.thinkingExpandVersion !== next.thinkingExpandVersion ||
    prev.thinkingExpandTarget !== next.thinkingExpandTarget ||
    prev.searchQuery !== next.searchQuery ||
    prev.searchRegex !== next.searchRegex ||
    prev.searchCaseSensitive !== next.searchCaseSensitive ||
    prev.isCurrentMatch !== next.isCurrentMatch
  ) {
    return false;
  }
  if (prev.event === next.event) return true;
  if (!TERMINAL_STATUSES.has(next.event.status)) return false;
  return (
    prev.event.seq === next.event.seq &&
    prev.event.status === next.event.status &&
    prev.event.kind === next.event.kind &&
    prev.event.payload === next.event.payload
  );
});
