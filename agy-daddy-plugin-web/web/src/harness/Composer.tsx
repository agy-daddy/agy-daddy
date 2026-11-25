import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import type {
  ComposerStateResponse,
  ContextDisplayLocation,
  ModelCatalogTree,
  ModelItem,
  TopbarPanelSlot,
} from '../types';
import {
  detectHighRiskPrompt,
  getGhostSuggestions,
  isOptimizerShortcut,
  resolveQuickPrompts,
  truncateGhostLabel,
} from './composerUtils';
import { ComposerContextBar } from './ComposerContextBar';
import { ModelPicker } from './ModelPicker';
import styles from './Composer.module.css';

export interface ComposerProps {
  models: ModelItem[];
  modelTree?: ModelCatalogTree | null;
  selectedModelId?: string | null;
  onSelectModel?: (modelId: string) => void;
  selectedThinkingLevel?: string | null;
  onSelectThinkingLevel?: (level: string | null) => void;
  onSend: (text: string, modelId?: string, thinkingLevel?: string | null) => void | Promise<void>;
  onCancel?: () => void;
  isRunning?: boolean;
  disabled?: boolean;
  sending?: boolean;
  canceling?: boolean;
  placeholder?: string;
  composerState?: ComposerStateResponse | null;
  contextUsagePct?: number | null;
  onOptimizePrompt?: (text: string) => Promise<string | null>;
  onExportMarkdown?: () => void | Promise<void>;
  exportingMarkdown?: boolean;
  contextPanel?: TopbarPanelSlot | null;
  contextDisplayLocation?: ContextDisplayLocation;
  contextShowSpeed?: boolean;
  onRefreshContext?: () => void;
  onRunCompact?: () => void;
  externalDraftPatch?: { text: string; nonce: number } | null;
}

function QuickPromptIcon({ id, template }: { id: string; template: string }) {
  const key = id.trim().toLowerCase();
  const common = {
    width: 12,
    height: 12,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.85,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
  };

  if (key === 'compact') {
    return (
      <svg {...common}>
        <path d="M4 14h6v6" />
        <path d="M20 10h-6V4" />
        <path d="m14 10 7-7" />
        <path d="m3 21 7-7" />
      </svg>
    );
  }
  if (key === 'plan') {
    return (
      <svg {...common}>
        <path d="M9 6h11" />
        <path d="M9 12h11" />
        <path d="M9 18h11" />
        <path d="M4 6h.01" />
        <path d="M4 12h.01" />
        <path d="M4 18h.01" />
      </svg>
    );
  }
  if (key === 'grill-me') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M9.5 9a2.5 2.5 0 0 1 5 .5c0 1.8-2.5 2.2-2.5 3.8" />
        <path d="M12 17h.01" />
      </svg>
    );
  }
  if (key === 'btw') {
    return (
      <svg {...common}>
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    );
  }
  if (key === 'learn') {
    return (
      <svg {...common}>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z" />
      </svg>
    );
  }
  if (key === 'goal') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="4" />
        <circle cx="12" cy="12" r="1" />
      </svg>
    );
  }
  if (key === 'boost') {
    return (
      <svg {...common}>
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      </svg>
    );
  }
  if (key === 'swarm') {
    return (
      <svg {...common}>
        <circle cx="6" cy="6" r="2.5" />
        <circle cx="18" cy="6" r="2.5" />
        <circle cx="12" cy="18" r="2.5" />
        <path d="M8.2 7.5 15.8 7.5" />
        <path d="M7.3 8.2 10.7 15.8" />
        <path d="M16.7 8.2 13.3 15.8" />
      </svg>
    );
  }
  if (key === 'teamwork') {
    return (
      <svg {...common}>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="3" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a3 3 0 0 1 0 5.74" />
      </svg>
    );
  }
  if (key === 'browser') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M3.6 9h16.8" />
        <path d="M3.6 15h16.8" />
        <path d="M12 3a14 14 0 0 1 0 18" />
        <path d="M12 3a14 14 0 0 0 0 18" />
      </svg>
    );
  }
  if (key === 'schedule') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
    );
  }
  if (key === 'reload') {
    return (
      <svg {...common}>
        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
        <path d="M21 3v6h-6" />
      </svg>
    );
  }
  if (template.trim().startsWith('/')) {
    return (
      <svg {...common}>
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <polyline points="9 10 4 15 9 20" />
      <path d="M20 4v7a4 4 0 0 1-4 4H4" />
    </svg>
  );
}

function SparkleIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <path d="M20 3v4" />
      <path d="M22 5h-4" />
    </svg>
  );
}

function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeOpacity="0.24" strokeWidth="1.8" />
      <path
        d="M8 2.5A5.5 5.5 0 0 1 13.5 8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11" />
    </svg>
  );
}

function SendArrowIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

export function Composer({
  models,
  modelTree,
  selectedModelId,
  onSelectModel,
  selectedThinkingLevel,
  onSelectThinkingLevel,
  onSend,
  onCancel,
  isRunning = false,
  disabled = false,
  sending = false,
  canceling = false,
  placeholder,
  composerState,
  contextUsagePct = null,
  onOptimizePrompt,
  contextPanel = null,
  contextDisplayLocation = 'topbar',
  contextShowSpeed = false,
  onRefreshContext,
  onRunCompact,
  externalDraftPatch = null,
}: ComposerProps) {
  const { locale, t } = useI18n();
  const [text, setText] = useState('');
  const [optimizing, setOptimizing] = useState(false);
  const [preOptimizeText, setPreOptimizeText] = useState<string | null>(null);
  const [optimizedResultText, setOptimizedResultText] = useState<string | null>(null);
  const [ghostIndex, setGhostIndex] = useState(0);
  const [ghostDismissed, setGhostDismissed] = useState(false);
  const [quickPillsOverflowRight, setQuickPillsOverflowRight] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const quickPillsRef = useRef<HTMLDivElement | null>(null);
  const lastDraftPatchNonceRef = useRef<number | null>(null);
  const textRef = useRef<string>(text);
  textRef.current = text;

  const defaultModelId = useMemo(() => {
    const flaggedDefault = models.find((m) => m.isDefault && !m.disabled);
    if (flaggedDefault) return flaggedDefault.id;
    const firstEnabled = models.find((m) => !m.disabled);
    return firstEnabled?.id || models[0]?.id || '';
  }, [models]);

  const [internalModelId, setInternalModelId] = useState<string>(defaultModelId);
  const [internalThinkingLevel, setInternalThinkingLevel] = useState<string | null>(null);

  useEffect(() => {
    if (selectedModelId !== undefined) return;
    if (!internalModelId && defaultModelId) {
      setInternalModelId(defaultModelId);
    }
  }, [selectedModelId, internalModelId, defaultModelId]);

  const activeModelId =
    selectedModelId !== undefined && selectedModelId !== null
      ? selectedModelId
      : internalModelId || defaultModelId;

  const activeThinkingLevel =
    selectedThinkingLevel !== undefined ? selectedThinkingLevel : internalThinkingLevel;

  const settings = composerState?.settings || {};
  const showQuickBar =
    settings.quickPromptsEnabled !== false &&
    settings.quickPromptBarVisible !== false &&
    settings.showQuickBar !== false;

  const quickPrompts = useMemo(
    () => resolveQuickPrompts(composerState, locale),
    [composerState, locale],
  );

  const autoCompactThreshold =
    typeof settings.autoCompactThreshold === 'number' ? settings.autoCompactThreshold : 80;
  const compactRecommended =
    settings.autoCompactEnabled !== false &&
    typeof contextUsagePct === 'number' &&
    contextUsagePct >= autoCompactThreshold;

  const highRiskEnabled = settings.highRiskGuardEnabled !== false;
  const riskCheck = useMemo(
    () => (highRiskEnabled ? detectHighRiskPrompt(text) : { risky: false, labels: [] }),
    [highRiskEnabled, text],
  );

  const showOptimize =
    Boolean(onOptimizePrompt) &&
    settings.promptOptimizerEnabled !== false &&
    settings.showPromptOptimizer !== false;

  const ghostEnabled = settings.ghostSuggest !== false;
  const ghostSuggestions = useMemo(
    () =>
      ghostEnabled
        ? getGhostSuggestions({
            text,
            composerState,
            quickPrompts,
            contextUsagePct,
            autoCompactThreshold,
          })
        : [],
    [ghostEnabled, text, composerState, quickPrompts, contextUsagePct, autoCompactThreshold],
  );

  const ghostSig = ghostSuggestions.join('|');
  useEffect(() => {
    setGhostIndex(0);
    setGhostDismissed(false);
  }, [ghostSig]);

  const activeGhostSuggestion =
    ghostEnabled && !ghostDismissed && ghostSuggestions.length > 0
      ? ghostSuggestions[ghostIndex % ghostSuggestions.length]
      : null;

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    if (el.scrollHeight > 0) {
      el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
    }
  }, [text]);

  const trimmed = text.trim();
  const canSend = trimmed.length > 0 && !disabled && !sending;

  const handleTextChange = (nextVal: string) => {
    textRef.current = nextVal;
    setText(nextVal);
    if (preOptimizeText !== null && nextVal !== optimizedResultText) {
      setPreOptimizeText(null);
      setOptimizedResultText(null);
    }
  };

  useEffect(() => {
    if (!externalDraftPatch) return;
    if (lastDraftPatchNonceRef.current === externalDraftPatch.nonce) return;
    lastDraftPatchNonceRef.current = externalDraftPatch.nonce;
    handleTextChange(externalDraftPatch.text);
    textareaRef.current?.focus();
  }, [externalDraftPatch]);

  useLayoutEffect(() => {
    const el = quickPillsRef.current;
    if (!el) {
      setQuickPillsOverflowRight(false);
      return;
    }
    const updateOverflow = () => {
      setQuickPillsOverflowRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
    };
    updateOverflow();
    el.addEventListener('scroll', updateOverflow, { passive: true });
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(updateOverflow) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', updateOverflow);
      ro?.disconnect();
    };
  }, [showQuickBar, quickPrompts.length, compactRecommended]);

  const submitMessage = async () => {
    if (!canSend) return;
    const payload = trimmed;
    const draftBeforeSend = text;
    const prevPreOptimize = preOptimizeText;
    const prevOptimizedResult = optimizedResultText;
    const modelToUse = activeModelId || undefined;

    textRef.current = '';
    setText('');
    setPreOptimizeText(null);
    setOptimizedResultText(null);

    try {
      const result = activeThinkingLevel
        ? onSend(payload, modelToUse, activeThinkingLevel)
        : onSend(payload, modelToUse);
      if (result && typeof (result as Promise<void>).then === 'function') {
        await result;
      }
    } catch {
      // Restore draft only if the user hasn't started typing a new message while send was in-flight.
      if (textRef.current === '') {
        textRef.current = draftBeforeSend;
        setText(draftBeforeSend);
        setPreOptimizeText(prevPreOptimize);
        setOptimizedResultText(prevOptimizedResult);
      }
    }
  };

  const acceptGhostSuggestion = () => {
    if (!activeGhostSuggestion) return false;
    const nextVal = activeGhostSuggestion.startsWith('/')
      ? `${activeGhostSuggestion} `
      : activeGhostSuggestion;
    handleTextChange(nextVal);
    setGhostDismissed(true);
    textareaRef.current?.focus();
    return true;
  };

  const cycleGhostSuggestion = () => {
    if (ghostSuggestions.length <= 1) return;
    setGhostDismissed(false);
    setGhostIndex((prev) => (prev + 1) % ghostSuggestions.length);
  };

  const handleOptimizeClick = async () => {
    if (!onOptimizePrompt || !trimmed || optimizing || disabled) return;
    const draftBefore = text;
    setOptimizing(true);
    try {
      const next = await onOptimizePrompt(draftBefore);
      if (typeof next === 'string' && next.trim()) {
        setPreOptimizeText(draftBefore);
        setOptimizedResultText(next);
        setText(next);
        textareaRef.current?.focus();
      }
    } finally {
      setOptimizing(false);
    }
  };

  const handleUndoOptimize = () => {
    if (preOptimizeText === null || optimizing || disabled) return;
    const restored = preOptimizeText;
    setPreOptimizeText(null);
    setOptimizedResultText(null);
    setText(restored);
    textareaRef.current?.focus();
  };

  const handleKeyDown = (ev: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showOptimize && isOptimizerShortcut(ev, settings.optimizerShortcut)) {
      ev.preventDefault();
      if (preOptimizeText !== null && text === optimizedResultText) {
        handleUndoOptimize();
      } else {
        void handleOptimizeClick();
      }
      return;
    }

    if (
      (ev.key === 'Tab' || (ev.key === 'ArrowRight' && text.length === 0)) &&
      !ev.shiftKey &&
      !ev.ctrlKey &&
      !ev.metaKey &&
      !ev.altKey &&
      activeGhostSuggestion
    ) {
      ev.preventDefault();
      acceptGhostSuggestion();
      return;
    }

    if (ev.key === 'Escape' && activeGhostSuggestion) {
      ev.preventDefault();
      setGhostDismissed(true);
      return;
    }

    if (
      (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') &&
      text.length === 0 &&
      !ev.shiftKey &&
      !ev.ctrlKey &&
      !ev.metaKey &&
      !ev.altKey &&
      ghostSuggestions.length > 1
    ) {
      ev.preventDefault();
      setGhostDismissed(false);
      setGhostIndex((prev) =>
        ev.key === 'ArrowDown'
          ? (prev + 1) % ghostSuggestions.length
          : (prev - 1 + ghostSuggestions.length) % ghostSuggestions.length,
      );
      return;
    }

    if (ev.key === 'Enter' && !ev.shiftKey && !ev.nativeEvent.isComposing) {
      ev.preventDefault();
      void submitMessage();
    }
  };

  const handleSubmit = (ev: React.FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    void submitMessage();
  };

  const handleModelChange = (nextId: string) => {
    if (selectedModelId === undefined) {
      setInternalModelId(nextId);
    }
    onSelectModel?.(nextId);
  };

  const handleThinkingLevelChange = (nextLevel: string | null) => {
    if (selectedThinkingLevel === undefined) {
      setInternalThinkingLevel(nextLevel);
    }
    onSelectThinkingLevel?.(nextLevel);
  };

  const handleInsertQuickPrompt = (template: string) => {
    const cleanTpl = template.trim();
    const prevTrimmed = text.trimStart();
    const nextVal = !prevTrimmed
      ? `${cleanTpl} `
      : prevTrimmed.startsWith(cleanTpl)
        ? text
        : `${cleanTpl} ${prevTrimmed}`;
    handleTextChange(nextVal);
    textareaRef.current?.focus();
  };

  const handlePlusClick = () => {
    if (disabled) return;
    if (!text.trim()) {
      handleTextChange('/');
    }
    textareaRef.current?.focus();
  };

  const canUndoOptimize = preOptimizeText !== null && !optimizing;
  const showTopBar = showQuickBar || Boolean(activeGhostSuggestion);

  return (
    <form className={styles.composer} onSubmit={handleSubmit} data-testid="composer-form">
      {showTopBar && (
        <div
          className={styles.topBar}
          role="toolbar"
          aria-label={t('composer.quickBarLabel')}
          data-testid="composer-quick-bar"
        >
          {showQuickBar && (
            <div
              ref={quickPillsRef}
              className={styles.quickPills}
              data-overflow-right={quickPillsOverflowRight ? 'true' : 'false'}
            >
              {quickPrompts.map((item) => {
                const isCompactHighlight =
                  compactRecommended && (item.id === 'compact' || item.label.includes('/compact'));
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`${styles.quickPill} ${isCompactHighlight ? styles.quickPillAlert : ''}`}
                    onClick={() => handleInsertQuickPrompt(item.template)}
                    disabled={disabled}
                    title={item.template.trim()}
                    data-testid={`quick-prompt-${item.id}`}
                  >
                    <span className={styles.quickPillIcon} aria-hidden="true">
                      <QuickPromptIcon id={item.id} template={item.template} />
                    </span>
                    <span className={styles.quickPillLabel}>{item.label}</span>
                  </button>
                );
              })}
              {compactRecommended && (
                <span className={styles.compactNotice} data-testid="composer-compact-recommended">
                  {t('composer.compactRecommended')}
                </span>
              )}
            </div>
          )}

          {activeGhostSuggestion && (
            <div className={styles.ghostWrap} data-testid="composer-ghost-bar">
              <button
                type="button"
                className={styles.ghostAcceptBtn}
                onClick={acceptGhostSuggestion}
                title={activeGhostSuggestion}
                data-full-suggestion={activeGhostSuggestion}
                data-testid="composer-ghost-accept"
              >
                <span className={styles.ghostIcon}>
                  <SparkleIcon size={12} />
                </span>
                <span className={styles.ghostPrefix}>{t('composer.perceptionHint')}</span>
                <span className={styles.ghostText} data-testid="composer-ghost-text">
                  {truncateGhostLabel(activeGhostSuggestion, 48)}
                </span>
                <kbd className={styles.ghostKbd}>{t('composer.ghostAcceptHint')}</kbd>
              </button>
              {ghostSuggestions.length > 1 && (
                <button
                  type="button"
                  className={styles.ghostCycleBtn}
                  onClick={cycleGhostSuggestion}
                  aria-label={t('composer.ghostCycle')}
                  title={t('composer.ghostCycle')}
                  data-testid="composer-ghost-cycle"
                >
                  ↓ {(ghostIndex % ghostSuggestions.length) + 1}/{ghostSuggestions.length}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {riskCheck.risky && (
        <div
          className={styles.highRiskBanner}
          role="alert"
          data-testid="composer-high-risk-banner"
        >
          <span aria-hidden="true">⚠</span>
          <span>{t('composer.highRiskWarning', { labels: riskCheck.labels.join(', ') })}</span>
        </div>
      )}

      <div className={styles.inner}>
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          value={text}
          onChange={(ev) => handleTextChange(ev.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? t('composer.placeholder')}
          disabled={disabled}
          rows={2}
          aria-label={t('composer.placeholder')}
          data-testid="composer-textarea"
        />

        {showOptimize && (
          <div className={styles.optRow}>
            {canUndoOptimize && (
              <button
                type="button"
                className={`${styles.optCircleBtn} ${styles.undoBtn}`}
                onClick={handleUndoOptimize}
                disabled={disabled}
                title={t('composer.undoOptimize')}
                aria-label={t('composer.undoOptimize')}
                data-testid="composer-undo-optimize-btn"
              >
                <UndoIcon />
              </button>
            )}
            <button
              type="button"
              className={styles.optCircleBtn}
              onClick={() => void handleOptimizeClick()}
              disabled={!trimmed || optimizing || disabled}
              aria-busy={optimizing}
              aria-label={optimizing ? t('composer.optimizing') : t('composer.optimize')}
              title={
                settings.optimizerShortcut
                  ? `${t('composer.optimize')} (${settings.optimizerShortcut})`
                  : `${t('composer.optimize')} (Cmd/Ctrl+Shift+O)`
              }
              data-testid="composer-optimize-btn"
            >
              {optimizing ? (
                <SpinnerIcon className={styles.spinIcon} />
              ) : (
                <SparkleIcon size={14} />
              )}
            </button>
          </div>
        )}

        <div className={styles.toolbar}>
          <div className={styles.leftControls}>
            <button
              type="button"
              className={styles.plusBtn}
              onClick={handlePlusClick}
              disabled={disabled}
              title={t('composer.quickInsert')}
              aria-label={t('composer.quickInsert')}
              data-testid="composer-plus-btn"
            >
              <PlusIcon />
            </button>
            <ModelPicker
              models={models}
              tree={modelTree}
              selectedModelId={activeModelId}
              onSelectModel={handleModelChange}
              selectedThinkingLevel={activeThinkingLevel}
              onSelectThinkingLevel={handleThinkingLevelChange}
              disabled={disabled}
            />
          </div>

          <div className={styles.actions}>
            {isRunning && (
              <button
                type="button"
                className={styles.stopBtn}
                onClick={onCancel}
                disabled={canceling || !onCancel}
                data-testid="composer-cancel-btn"
              >
                {canceling ? t('composer.stopping') : t('composer.stop')}
              </button>
            )}
            <button
              type="submit"
              className={styles.sendBtn}
              disabled={!canSend}
              aria-label={sending ? t('composer.sending') : t('composer.send')}
              title={sending ? t('composer.sending') : t('composer.send')}
              data-testid="composer-send-btn"
            >
              {sending ? <SpinnerIcon className={styles.spinIcon} /> : <SendArrowIcon />}
            </button>
          </div>
        </div>
      </div>
      {contextDisplayLocation === 'composer' && contextPanel?.available && (
        <ComposerContextBar
          slot={contextPanel}
          showSpeed={contextShowSpeed}
          isRunning={isRunning}
          hasDraft={trimmed.length > 0}
          onRefresh={onRefreshContext}
          onRunCompact={
            onRunCompact ??
            (() => {
              handleInsertQuickPrompt('/compact ');
            })
          }
        />
      )}
    </form>
  );
}
