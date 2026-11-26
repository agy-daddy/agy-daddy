import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useI18n } from '../i18n';
import { compressImageFile } from '../store/image';
import {
  formatCompactModelBadge,
  groupModelsForPicker,
  normalizeModelCatalog
} from '../store/modelCatalog';
import { sanitizePresets } from '../store/useRemoteStore';
import type {
  ChatMode,
  ComposerPreset,
  ComposerQuickPrompt,
  ComposerSettingsDto,
  ComposerStateResponse,
  DispatchMode,
  ImageAttachment,
  ModelOption,
  ModelPickerGroup,
  OrchestratorMasterKey,
  OrchestratorThinkingMap,
  OrchestratorThinkingTier,
  PermissionInfo,
  PermissionLevel,
  QueuedMessage,
  TelemetryPanels
} from '../types';
import {
  detectHighRiskPrompt,
  getGhostSuggestions,
  normalizeCacheHitRatePct,
  resolveQuickPrompts,
  truncateGhostLabel
} from './composerUtils';
import { ModelPickerSheet } from './ModelPickerSheet';
import styles from './Composer.module.css';

export interface ComposerProps {
  text: string;
  images: ImageAttachment[];
  presets: ComposerPreset[];
  models: Array<ModelOption | string>;
  modelGroups?: ModelPickerGroup[];
  selectedModelId: string;
  orchestratorThinking?: OrchestratorThinkingMap;
  activeOrchestratorMaster?: OrchestratorMasterKey | null;
  chatMode: ChatMode;
  dispatchMode?: DispatchMode;
  permissionLevel: PermissionLevel;
  permissionInfo?: PermissionInfo | null;
  running: boolean;
  voiceSupported: boolean;
  queue?: QueuedMessage[];
  telemetry?: TelemetryPanels;
  composerSettings?: ComposerSettingsDto;
  quickPrompts?: ComposerQuickPrompt[];
  frequentPrompts?: string[];
  composerState?: ComposerStateResponse | null;
  onTextChange: (next: string) => void;
  onAddImage: (img: ImageAttachment) => void;
  onRemoveImage: (id: string) => void;
  onModelChange: (modelId: string) => void;
  onSelectOrchestrator?: (
    modelId: string,
    masterKey: OrchestratorMasterKey,
    thinkingLevel: OrchestratorThinkingTier
  ) => void;
  onOpenModelPicker?: () => void;
  onOpenTelemetry?: () => void;
  onCompact?: () => Promise<boolean> | void;
  onChatModeChange: (mode: ChatMode) => void;
  onDispatchModeChange?: (mode: DispatchMode) => void;
  onSend: (overrideDispatch?: DispatchMode) => void;
  onCancel: () => void;
  onOptimize: () => Promise<string | null | void>;
  onRemoveQueueItem?: (id: string) => void;
}

const PERM_LEVEL_KEYS: PermissionLevel[] = ['L0', 'L1', 'L2'];

const TEXTAREA_MIN_HEIGHT = 66; // 3 lines default
const TEXTAREA_MAX_HEIGHT = 156;

function fmtCtxTok(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '0';
  const n = Math.max(0, Number(v));
  if (n >= 1e6) return `${(n / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '')}K`;
  return String(Math.round(n));
}

export function Composer(props: ComposerProps) {
  const {
    text,
    images,
    presets,
    models,
    modelGroups,
    selectedModelId,
    orchestratorThinking,
    activeOrchestratorMaster,
    chatMode,
    permissionLevel,
    permissionInfo,
    running,
    voiceSupported,
    telemetry,
    composerSettings,
    quickPrompts,
    frequentPrompts,
    composerState,
    onTextChange,
    onAddImage,
    onRemoveImage,
    onModelChange,
    onSelectOrchestrator,
    onOpenModelPicker,
    onOpenTelemetry,
    onCompact,
    onChatModeChange,
    onSend,
    onCancel,
    onOptimize
  } = props;

  const { locale, t } = useI18n();
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [permOpen, setPermOpen] = useState(false);
  const [localModelPickerOpen, setLocalModelPickerOpen] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [preOptimizeText, setPreOptimizeText] = useState<string | null>(null);
  const [pendingHighRisk, setPendingHighRisk] = useState<{
    labels: string[];
    overrideDispatch?: DispatchMode;
  } | null>(null);
  const [compactBusy, setCompactBusy] = useState(false);
  const [quickFade, setQuickFade] = useState<'none' | 'right' | 'left' | 'both'>('right');
  const [kbdOffset, setKbdOffset] = useState(0);
  const [isFocused, setIsFocused] = useState(false);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const quickBarRef = useRef<HTMLDivElement | null>(null);

  const isReadOnly = permissionLevel === 'L0';
  const safePresets = useMemo(() => sanitizePresets(presets), [presets]);
  const catalog = useMemo(() => normalizeModelCatalog(models), [models]);
  const pickerGroups = useMemo(
    () => (Array.isArray(modelGroups) && modelGroups.length > 0 ? modelGroups : groupModelsForPicker(models)),
    [modelGroups, models]
  );

  const effectiveModelId = useMemo(() => {
    if (catalog.some((m) => m.id === selectedModelId)) return selectedModelId;
    return catalog[0]?.id || '';
  }, [catalog, selectedModelId]);

  const modelBadge = useMemo(() => {
    const raw = formatCompactModelBadge(
      effectiveModelId,
      models,
      undefined,
      activeOrchestratorMaster
        ? { master: activeOrchestratorMaster, thinkingMap: orchestratorThinking }
        : null
    );
    if (raw.isOrchestrator && raw.shortName === '编排') {
      return {
        ...raw,
        name: t('model.orchestratorGroup'),
        shortName: t('model.orchestratorShort'),
        full: raw.tag ? `${t('model.orchestratorShort')} · ${raw.tag}` : t('model.orchestratorGroup')
      };
    }
    if (raw.name === '选择模型') {
      return {
        ...raw,
        name: t('model.selectTitle'),
        shortName: t('model.selectShort'),
        full: t('model.selectTitle')
      };
    }
    return raw;
  }, [effectiveModelId, models, activeOrchestratorMaster, orchestratorThinking, t]);

  const permDetails = useMemo(() => {
    if (permissionInfo?.levels && permissionInfo.levels.length > 0 && locale.startsWith('zh')) {
      return permissionInfo.levels;
    }
    return PERM_LEVEL_KEYS.map((lvl) => ({
      level: lvl,
      label: t(`perm.${lvl}.label`),
      description: t(`perm.${lvl}.desc`)
    }));
  }, [permissionInfo, locale, t]);

  const resolvedQuickPrompts = useMemo(
    () => resolveQuickPrompts(quickPrompts, locale),
    [quickPrompts, locale]
  );

  const ctxData = telemetry?.context?.available ? telemetry.context.data : undefined;
  const ctxUsed = ctxData ? (ctxData.usedTokens ?? ctxData.used ?? null) : null;
  const ctxLimit = ctxData ? (ctxData.maxTokens ?? ctxData.budget ?? null) : null;
  const ctxPct =
    ctxData && typeof ctxData.percent === 'number'
      ? Math.round(ctxData.percent)
      : ctxData && typeof ctxData.usageRatio === 'number'
        ? Math.round(ctxData.usageRatio * 100)
        : ctxUsed !== null && ctxLimit && ctxLimit > 0
          ? Math.round((ctxUsed / ctxLimit) * 100)
          : null;
  const ctxRiskRaw = ctxData?.cacheCliffRisk || ctxData?.riskLevel || '';
  const ctxLevel: 'ok' | 'warn' | 'critical' =
    ctxRiskRaw === 'critical' || (ctxPct !== null && ctxPct >= 92)
      ? 'critical'
      : ctxRiskRaw === 'warn' || (ctxPct !== null && ctxPct >= 80)
        ? 'warn'
        : 'ok';
  const autoCompactPct =
    composerSettings?.autoCompactThresholdTokens && ctxLimit && ctxLimit > 0
      ? Math.round((composerSettings.autoCompactThresholdTokens / ctxLimit) * 100)
      : 80;
  const showQuickBar = composerSettings?.showQuickBar !== false && !isReadOnly;
  const ghostEnabled = composerSettings?.ghostSuggest !== false && !isReadOnly;

  const ghostSuggestions = useMemo(() => {
    if (!ghostEnabled) return [];
    return getGhostSuggestions({
      text,
      frequentPrompts,
      quickPrompts: resolvedQuickPrompts,
      composerState,
      contextUsagePct: ctxPct,
      autoCompactThreshold: autoCompactPct
    });
  }, [
    ghostEnabled,
    text,
    frequentPrompts,
    resolvedQuickPrompts,
    composerState,
    ctxPct,
    autoCompactPct
  ]);

  const showGhostChip =
    ghostSuggestions.length > 0 &&
    (text.trim().length > 0 || (ctxPct !== null && ctxPct >= autoCompactPct));

  const updateQuickFade = () => {
    const el = quickBarRef.current;
    if (!el) return;
    const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
    if (maxScroll <= 4) {
      setQuickFade('none');
      return;
    }
    const leftClip = el.scrollLeft > 4;
    const rightClip = el.scrollLeft < maxScroll - 4;
    if (leftClip && rightClip) setQuickFade('both');
    else if (leftClip) setQuickFade('left');
    else if (rightClip) setQuickFade('right');
    else setQuickFade('none');
  };

  useEffect(() => {
    updateQuickFade();
  }, [resolvedQuickPrompts.length, showQuickBar]);

  // Upgrade visualViewport listener for clean iOS Safari & Android Chrome keyboard lift (zero occlusion)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const root = document.documentElement;
    const vv = window.visualViewport;

    const updateViewport = () => {
      const vvh = vv ? vv.height : window.innerHeight;
      const offsetTop = vv ? vv.offsetTop : 0;
      const rawDiff = vv ? Math.max(0, window.innerHeight - vv.height - offsetTop) : 0;
      const nextKbd = rawDiff > 40 ? Math.round(rawDiff) : 0;

      root.style.setProperty('--ag-vvh', `${Math.round(vvh)}px`);
      root.style.setProperty('--ag-kbd-offset', `${nextKbd}px`);
      setKbdOffset(nextKbd);
    };

    updateViewport();
    vv?.addEventListener('resize', updateViewport);
    vv?.addEventListener('scroll', updateViewport);
    window.addEventListener('resize', updateViewport);

    return () => {
      vv?.removeEventListener('resize', updateViewport);
      vv?.removeEventListener('scroll', updateViewport);
      window.removeEventListener('resize', updateViewport);
      root.style.removeProperty('--ag-kbd-offset');
    };
  }, []);

  // Close popovers when tapping outside composer
  useEffect(() => {
    if (!presetsOpen && !permOpen) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setPresetsOpen(false);
        setPermOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [presetsOpen, permOpen]);

  // Smooth auto-height starting from 3 lines (66px) up to 156px
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const nextH = Math.min(TEXTAREA_MAX_HEIGHT, Math.max(TEXTAREA_MIN_HEIGHT, el.scrollHeight));
    el.style.height = `${nextH}px`;
  }, [text]);

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    for (let i = 0; i < Math.min(files.length, 4 - images.length); i++) {
      const compressed = await compressImageFile(files[i]);
      onAddImage(compressed);
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const handleOptimize = async () => {
    if (!text.trim() || optimizing) return;
    const before = text;
    setOptimizing(true);
    try {
      const optimized = await onOptimize();
      if (optimized !== null) {
        setPreOptimizeText(before);
      }
    } finally {
      setOptimizing(false);
    }
  };

  const attemptSend = (overrideDispatch?: DispatchMode) => {
    if (!canSend) return;
    const risk = detectHighRiskPrompt(text);
    if (risk.risky) {
      setPendingHighRisk({ labels: risk.labels, overrideDispatch });
      return;
    }
    setPendingHighRisk(null);
    setPreOptimizeText(null);
    onSend(overrideDispatch);
  };

  const handleFocus = () => {
    setIsFocused(true);
    if (typeof window !== 'undefined') {
      const scrollInto = () => {
        wrapRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
      };
      requestAnimationFrame(scrollInto);
      setTimeout(scrollInto, 220);
    }
  };

  const handleOpenModelSelector = () => {
    setPresetsOpen(false);
    setPermOpen(false);
    if (onOpenModelPicker) {
      onOpenModelPicker();
    } else {
      setLocalModelPickerOpen(true);
    }
  };

  const canSend = !isReadOnly && (text.trim().length > 0 || images.length > 0);
  // Sending while running always defaults to queue; switching to Steer happens on the queued message card
  const actionLabel = running ? t('composer.enqueue') : t('composer.send');

  const permToneClass =
    permissionLevel === 'L2'
      ? styles.permL2
      : permissionLevel === 'L1'
        ? styles.permL1
        : styles.permL0;

  return (
    <div
      ref={wrapRef}
      className={styles.wrap}
      data-testid="composer-wrap"
      style={
        kbdOffset > 0
          ? { paddingBottom: `calc(20px + ${kbdOffset}px + env(safe-area-inset-bottom, 0px))` }
          : undefined
      }
    >
      {/* / 快捷词 + Plan 模式合并浮层 */}
      {presetsOpen && (
        <div className={styles.popover} data-testid="presets-popover">
          <button
            type="button"
            role="switch"
            aria-checked={chatMode === 'plan'}
            className={`${styles.planToggleRow} ${chatMode === 'plan' ? styles.planToggleRowActive : ''}`}
            data-testid="presets-plan-toggle"
            onClick={() => {
              if (text === '/') onTextChange('');
              onChatModeChange(chatMode === 'plan' ? 'chat' : 'plan');
              setPresetsOpen(false);
              taRef.current?.focus();
            }}
          >
            <div className={styles.planToggleText}>
              <div className={styles.planToggleTitle}>
                <span>{t('composer.planMode')}</span>
                {chatMode === 'plan' && (
                  <span className={styles.planOnBadge}>{t('composer.planEnabled')}</span>
                )}
              </div>
              <div className={styles.planToggleSub}>{t('composer.planDesc')}</div>
            </div>
            <span
              className={`${styles.switchTrack} ${chatMode === 'plan' ? styles.switchTrackOn : ''}`}
              aria-hidden="true"
            >
              <span className={styles.switchThumb} />
            </span>
          </button>

          <div className={styles.popDivider} />
          <div className={styles.popSectionLabel}>{t('composer.quickPromptsLabel')}</div>

          {safePresets.length === 0 ? (
            <div className={styles.popEmpty}>{t('composer.noPresets')}</div>
          ) : (
            <div className={styles.presetsList}>
              {safePresets.map((p, idx) => (
                <button
                  key={p.id || idx}
                  type="button"
                  className={styles.presetItem}
                  onClick={() => {
                    const cleaned = text === '/' ? '' : text;
                    onTextChange(cleaned ? `${cleaned}\n${p.prompt}` : p.prompt);
                    setPresetsOpen(false);
                    taRef.current?.focus();
                  }}
                >
                  <div className={styles.presetLabel}>{p.label || p.prompt}</div>
                  <div className={styles.presetPrompt}>{p.prompt}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 权限说明浮层 */}
      {permOpen && (
        <div className={styles.popover} data-testid="permission-popover">
          <div className={styles.permPopHeader}>
            <span className={styles.permPopTitle}>
              {t('composer.permTitle', { level: permissionLevel })}
            </span>
            <button
              type="button"
              className={styles.popCloseBtn}
              aria-label={t('composer.closePermInfo')}
              onClick={() => setPermOpen(false)}
            >
              ✕
            </button>
          </div>
          <div className={styles.permList}>
            {permDetails.map((item) => {
              const active = item.level === permissionLevel;
              return (
                <div
                  key={item.level}
                  className={`${styles.permRow} ${active ? styles.permRowActive : ''}`}
                >
                  <div className={styles.permRowTop}>
                    <span className={styles.permRowLabel}>{item.label}</span>
                    {active && <span className={styles.permCurrentTag}>{t('composer.currentTag')}</span>}
                  </div>
                  <div className={styles.permRowDesc}>{item.description}</div>
                </div>
              );
            })}
          </div>
          <div className={styles.permFootnote}>{t('composer.permFootnote')}</div>
        </div>
      )}

      {pendingHighRisk && (
        <div className={styles.highRiskBanner} data-testid="composer-high-risk-banner" role="alert">
          <div className={styles.highRiskText}>
            {t('composer.highRiskConfirm', { labels: pendingHighRisk.labels.join(' / ') })}
          </div>
          <div className={styles.highRiskActions}>
            <button
              type="button"
              className={styles.riskCancelBtn}
              onClick={() => setPendingHighRisk(null)}
              data-testid="composer-high-risk-cancel"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className={styles.riskProceedBtn}
              onClick={() => {
                const disp = pendingHighRisk.overrideDispatch;
                setPendingHighRisk(null);
                setPreOptimizeText(null);
                onSend(disp);
              }}
              data-testid="composer-high-risk-confirm"
            >
              {t('composer.sendAnyway')}
            </button>
          </div>
        </div>
      )}

      {showQuickBar && resolvedQuickPrompts.length > 0 && (
        <div
          ref={quickBarRef}
          className={styles.quickBar}
          data-hscroll="1"
          data-fade={quickFade}
          data-testid="composer-quick-bar"
          onScroll={updateQuickFade}
        >
          {resolvedQuickPrompts.map((qp) => (
            <button
              key={qp.id}
              type="button"
              className={styles.quickPill}
              onClick={() => {
                const cleaned = text === '/' ? '' : text;
                const next = cleaned ? `${cleaned.trimEnd()} ${qp.template}` : qp.template;
                onTextChange(next);
                setPendingHighRisk(null);
                taRef.current?.focus();
              }}
            >
              {qp.label}
            </button>
          ))}
        </div>
      )}

      {(preOptimizeText !== null || showGhostChip) && (
        <div className={styles.ghostRow}>
          {preOptimizeText !== null && (
            <button
              type="button"
              className={styles.undoOptimizeBtn}
              data-testid="composer-undo-optimize-btn"
              onClick={() => {
                onTextChange(preOptimizeText);
                setPreOptimizeText(null);
                taRef.current?.focus();
              }}
            >
              ↶ {t('composer.undoOptimize')}
            </button>
          )}
          {showGhostChip && (
            <button
              type="button"
              className={styles.ghostBtn}
              data-testid="composer-ghost-btn"
              onClick={() => {
                onTextChange(ghostSuggestions[0]);
                setPendingHighRisk(null);
                taRef.current?.focus();
              }}
            >
              <span>
                {t('composer.suggestPrefix')}: {truncateGhostLabel(ghostSuggestions[0], 26)}
              </span>
              <span>↵</span>
            </button>
          )}
        </div>
      )}

      {/* 统一圆角卡片输入框：所有操作控件均收纳在卡片内部 */}
      <div
        className={`${styles.card} ${isFocused ? styles.cardFocused : ''} ${isReadOnly ? styles.cardReadOnly : ''}`}
        data-testid="composer-card"
      >
        {/* 内部状态头：Plan 激活标签 & 图片附件缩略图 */}
        {(chatMode === 'plan' || images.length > 0) && (
          <div className={styles.cardHeader}>
            {chatMode === 'plan' && (
              <span className={styles.planChip} data-testid="composer-plan-chip">
                <span className={styles.planChipDot} />
                {t('composer.planMode')}
                <button
                  type="button"
                  className={styles.planChipClose}
                  aria-label={t('composer.exitPlan')}
                  onClick={() => onChatModeChange('chat')}
                >
                  ×
                </button>
              </span>
            )}
            {images.length > 0 && (
              <div className={styles.imgStrip} data-hscroll="1">
                {images.map((img) => (
                  <div key={img.id} className={styles.thumbWrap}>
                    <img src={img.dataUrl} alt={img.name} className={styles.thumbImg} />
                    <button
                      type="button"
                      className={styles.thumbDel}
                      aria-label={t('composer.removeImage')}
                      onClick={() => onRemoveImage(img.id)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 3行高度主输入区 */}
        <textarea
          ref={taRef}
          rows={3}
          className={styles.textarea}
          data-testid="composer-textarea"
          disabled={isReadOnly}
          placeholder={
            isReadOnly
              ? t('composer.placeholderReadOnly')
              : running
                ? t('composer.placeholderRunning')
                : chatMode === 'plan'
                  ? t('composer.placeholderPlan')
                  : t('composer.placeholder')
          }
          value={text}
          onFocus={handleFocus}
          onBlur={() => setIsFocused(false)}
          onInput={(e) => {
            const val = (e.target as HTMLTextAreaElement).value;
            onTextChange(val);
            if (!val) {
              setPendingHighRisk(null);
              setPreOptimizeText(null);
            }
            if (val === '/') {
              setPermOpen(false);
              setPresetsOpen(true);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              if (canSend) attemptSend('queue');
            }
          }}
        />

        {/* 内部底部工具栏：附件 + /快捷词 + 模型选择 + 权限 + 提示词优化 + 发送/停止 */}
        <div className={styles.toolbar} data-testid="composer-toolbar">
          <div className={styles.toolLeft}>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => handleFiles((e.target as HTMLInputElement).files)}
            />
            <button
              type="button"
              className={styles.toolIconBtn}
              aria-label={t('composer.uploadImage')}
              title={t('composer.attachImageTitle')}
              data-testid="composer-attach-btn"
              disabled={isReadOnly}
              onClick={() => fileRef.current?.click()}
            >
              +
            </button>

            <button
              type="button"
              className={`${styles.toolChipBtn} ${presetsOpen ? styles.toolChipActive : ''}`}
              aria-label={t('composer.presetsAria')}
              data-testid="composer-presets-btn"
              disabled={isReadOnly}
              onClick={() => {
                setPermOpen(false);
                setPresetsOpen((o) => !o);
              }}
            >
              {t('composer.presetsBtn')}
            </button>

            {catalog.length > 0 && (
              <button
                type="button"
                className={styles.modelTriggerBtn}
                aria-label={t('composer.switchModel')}
                data-testid="composer-model-btn"
                disabled={isReadOnly}
                onClick={handleOpenModelSelector}
                title={modelBadge.full}
              >
                <span className={styles.modelNameText}>{modelBadge.shortName}</span>
                {modelBadge.tag && (
                  <span className={styles.modelTagText}>{modelBadge.tag}</span>
                )}
                <span className={styles.modelChevron} aria-hidden="true">
                  ▾
                </span>
              </button>
            )}

            <button
              type="button"
              className={`${styles.permBtn} ${permToneClass}`}
              aria-label={t('composer.currentPermAria', { level: permissionLevel })}
              data-testid="composer-permission-btn"
              onClick={() => {
                setPresetsOpen(false);
                setPermOpen((o) => !o);
              }}
            >
              <span className={styles.permDot} />
              <span>{permissionLevel}</span>
            </button>
          </div>

          <div className={styles.toolRight}>
            <button
              type="button"
              className={`${styles.toolIconBtn} ${optimizing ? styles.optimizing : ''}`}
              aria-label={t('composer.optimize')}
              title={t('composer.optimizeTitle')}
              data-testid="composer-optimize-btn"
              disabled={isReadOnly || !text.trim() || optimizing}
              onClick={handleOptimize}
            >
              {optimizing ? '…' : '✦'}
            </button>

            {voiceSupported && (
              <button
                type="button"
                className={styles.toolIconBtn}
                aria-label={t('composer.voiceInput')}
                disabled={isReadOnly}
                data-testid="voice-input-btn"
              >
                🎙
              </button>
            )}

            {running && (
              <button
                type="button"
                className={styles.stopBtn}
                onClick={onCancel}
                aria-label={t('composer.stop')}
                title={t('composer.stop')}
                data-testid="composer-stop-btn"
              >
                <span className={styles.stopSquare} aria-hidden="true" />
              </button>
            )}

            <button
              type="button"
              className={styles.sendBtn}
              disabled={!canSend}
              onClick={() => attemptSend('queue')}
              data-testid="composer-send-btn"
            >
              {actionLabel}
            </button>
          </div>
        </div>
      </div>

      {ctxData && ctxData.displayLocation === 'composer' && (
        <div className={styles.contextBar} data-testid="composer-context-bar">
          <button
            type="button"
            className={styles.contextBarMain}
            onClick={() => onOpenTelemetry?.()}
            aria-label={t('composer.viewTelemetry')}
          >
            <span className={styles.contextBarTrack}>
              <span
                className={styles.contextBarFill}
                data-tone={ctxLevel}
                style={{ width: `${Math.min(100, Math.max(0, ctxPct ?? 0))}%` }}
              />
            </span>
            <span className={styles.contextBarMeta}>
              {ctxPct ?? 0}% · {fmtCtxTok(ctxUsed)} / {fmtCtxTok(ctxLimit)}
              {(() => {
                const hitPct = normalizeCacheHitRatePct(ctxData.cacheHitRate);
                return hitPct !== null ? ` · ${t('composer.cacheHitShort')} ${hitPct}%` : '';
              })()}
            </span>
          </button>
          {ctxLevel !== 'ok' && onCompact && (
            <button
              type="button"
              className={styles.contextBarCompactBtn}
              disabled={compactBusy || isReadOnly}
              onClick={async () => {
                setCompactBusy(true);
                try {
                  await onCompact();
                } finally {
                  setCompactBusy(false);
                }
              }}
              data-testid="composer-compact-btn"
            >
              {compactBusy ? '…' : '/compact'}
            </button>
          )}
        </div>
      )}

      {/* Standalone fallback sheet when Composer is rendered without a shared App-level ModelPickerSheet */}
      {!onOpenModelPicker && (
        <ModelPickerSheet
          open={localModelPickerOpen}
          models={models}
          modelGroups={pickerGroups}
          selectedModelId={effectiveModelId}
          orchestratorThinking={orchestratorThinking}
          activeOrchestratorMaster={activeOrchestratorMaster}
          disabled={isReadOnly}
          onSelectModel={onModelChange}
          onSelectOrchestrator={onSelectOrchestrator}
          onClose={() => setLocalModelPickerOpen(false)}
        />
      )}
    </div>
  );
}
