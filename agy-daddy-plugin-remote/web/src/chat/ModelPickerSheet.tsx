import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { type TranslateFn, useI18n } from '../i18n';
import {
  DEFAULT_ORCHESTRATOR_THINKING,
  groupModelsForPicker,
  resolveMasterThinkingTier
} from '../store/modelCatalog';
import type {
  BackendModelGroup,
  ModelCatalogTree,
  ModelOption,
  ModelPickerGroup,
  ModelPickerMasterGroup,
  ModelPickerVariant,
  OrchestratorMasterKey,
  OrchestratorThinkingMap,
  OrchestratorThinkingTier
} from '../types';
import styles from './ModelPickerSheet.module.css';

export interface ModelPickerSheetProps {
  open: boolean;
  models: Array<ModelOption | string>;
  modelGroups?: ModelPickerGroup[];
  backendModelGroups?: BackendModelGroup[];
  modelTree?: ModelCatalogTree | null;
  selectedModelId: string;
  orchestratorThinking?: OrchestratorThinkingMap;
  activeOrchestratorMaster?: OrchestratorMasterKey | null;
  disabled?: boolean;
  onSelectModel: (modelId: string) => void;
  onSelectOrchestrator?: (
    modelId: string,
    masterKey: OrchestratorMasterKey,
    thinkingLevel: OrchestratorThinkingTier
  ) => void;
  onClose: () => void;
}

type PickerDepth = 0 | 1 | 2;

const TIER_SHORT_LABELS: Record<string, string> = {
  minimal: 'Min',
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  thinking: 'Think'
};

function providerDotClass(provider: ModelPickerGroup['provider']): string {
  switch (provider) {
    case 'gemini':
      return styles.dotGemini;
    case 'claude':
      return styles.dotClaude;
    case 'openai':
      return styles.dotOpenai;
    case 'orchestrator':
      return styles.dotOrch;
    default:
      return styles.dotOther;
  }
}

function getTierDescription(tierKey: string, t: TranslateFn): string {
  switch (tierKey) {
    case 'minimal':
      return t('model.tierDesc.minimal');
    case 'low':
      return t('model.tierDesc.low');
    case 'medium':
      return t('model.tierDesc.medium');
    case 'high':
      return t('model.tierDesc.high');
    case 'xhigh':
      return t('model.tierDesc.xhigh');
    case 'max':
      return t('model.tierDesc.max');
    case 'thinking':
      return t('model.tierDesc.thinking');
    default:
      return t('model.tierDesc.default');
  }
}

export function ModelPickerSheet(props: ModelPickerSheetProps) {
  const { t } = useI18n();
  const {
    open,
    models,
    modelGroups,
    backendModelGroups,
    modelTree,
    selectedModelId,
    orchestratorThinking,
    activeOrchestratorMaster = null,
    disabled = false,
    onSelectModel,
    onSelectOrchestrator,
    onClose
  } = props;

  const [localOrchThinking, setLocalOrchThinking] = useState<OrchestratorThinkingMap>(
    () => orchestratorThinking || { ...DEFAULT_ORCHESTRATOR_THINKING }
  );

  useEffect(() => {
    if (orchestratorThinking) {
      setLocalOrchThinking(orchestratorThinking);
    }
  }, [orchestratorThinking]);

  const effectiveOrchThinking = orchestratorThinking || localOrchThinking;

  const groups = useMemo(() => {
    if (Array.isArray(modelGroups) && modelGroups.length > 0) return modelGroups;
    return groupModelsForPicker(models, backendModelGroups, undefined, modelTree);
  }, [modelGroups, models, backendModelGroups, modelTree]);

  const [depth, setDepth] = useState<PickerDepth>(0);
  const [selectedGroupId, setSelectedGroupId] = useState<string>('');
  const [selectedMasterId, setSelectedMasterId] = useState<string>('');
  const [query, setQuery] = useState('');
  const [sheetDragY, setSheetDragY] = useState(0);
  const [sheetDragging, setSheetDragging] = useState(false);
  const [pickerDragX, setPickerDragX] = useState(0);
  const [pickerDragging, setPickerDragging] = useState(false);

  const swipeRef = useRef<{
    x: number;
    y: number;
    mode: 'pending' | 'vertical' | 'horizontal' | 'locked-out';
    fromHeader: boolean;
  } | null>(null);

  useEffect(() => {
    if (open) {
      setDepth(0);
      setSelectedGroupId('');
      setSelectedMasterId('');
      setQuery('');
      setSheetDragY(0);
      setSheetDragging(false);
      setPickerDragX(0);
      setPickerDragging(false);
    }
  }, [open]);

  const handleBack = () => {
    setDepth((prev) => {
      if (prev === 2) return 1;
      if (prev === 1) return 0;
      return 0;
    });
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (depth > 0) {
        e.preventDefault();
        setDepth((prev) => (prev === 2 ? 1 : 0));
      } else {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, depth, onClose]);

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((g) => {
      if (g.name.toLowerCase().includes(q)) return true;
      if (g.subtitle && g.subtitle.toLowerCase().includes(q)) return true;
      if (
        g.masterGroups?.some(
          (m) =>
            m.name.toLowerCase().includes(q) ||
            m.variants.some(
              (v) =>
                v.tierLabel.toLowerCase().includes(q) ||
                v.model.label.toLowerCase().includes(q) ||
                v.id.toLowerCase().includes(q)
            )
        )
      ) {
        return true;
      }
      return g.variants.some(
        (v) =>
          v.tierLabel.toLowerCase().includes(q) ||
          v.model.label.toLowerCase().includes(q) ||
          v.id.toLowerCase().includes(q)
      );
    });
  }, [groups, query]);

  const activeGroup = useMemo(
    () => groups.find((g) => g.id === selectedGroupId) || null,
    [groups, selectedGroupId]
  );

  const orchestratorMasters = useMemo<ModelPickerMasterGroup[]>(() => {
    if (!activeGroup?.isOrchestrator) return [];
    if (Array.isArray(activeGroup.masterGroups) && activeGroup.masterGroups.length > 0) {
      return activeGroup.masterGroups;
    }
    return [];
  }, [activeGroup]);

  const activeMaster = useMemo(
    () => orchestratorMasters.find((m) => m.id === selectedMasterId) || null,
    [orchestratorMasters, selectedMasterId]
  );

  // Guarantee Stage 0 highlights at most ONE group: orchestrator OR one model family.
  const activeStage0GroupId = useMemo(() => {
    const orchGroup = groups.find((g) => g.isOrchestrator) || null;
    if (
      orchGroup &&
      (activeOrchestratorMaster ||
        orchGroup.variants.some((v) => v.id === selectedModelId && v.model.isOrchestrator))
    ) {
      return orchGroup.id;
    }
    const matched = groups.find(
      (g) => !g.isOrchestrator && g.variants.some((v) => v.id === selectedModelId)
    );
    return matched ? matched.id : null;
  }, [groups, activeOrchestratorMaster, selectedModelId]);

  if (!open) return null;

  const totalModels = groups.reduce((acc, g) => acc + g.variants.length, 0);

  const handleGroupTap = (group: ModelPickerGroup) => {
    if (disabled) return;
    if (group.isOrchestrator || group.hasSubLevels) {
      setSelectedGroupId(group.id);
      setSelectedMasterId('');
      setDepth(1);
      return;
    }
    const target = group.variants[0];
    if (target && !target.disabled) {
      onSelectModel(target.id);
      onClose();
    }
  };

  const handleMasterTap = (master: ModelPickerMasterGroup) => {
    if (disabled) return;
    const allDisabled = master.variants.every((v) => v.disabled);
    if (allDisabled) return;
    const hasTierSubLevels = master.hasSubLevels ?? master.variants.length > 1;
    if (!hasTierSubLevels) {
      const target = master.variants.find((v) => !v.disabled) || master.variants[0];
      if (target) handleVariantTap(target, master);
      return;
    }
    setSelectedMasterId(master.id);
    setDepth(2);
  };

  const handleVariantTap = (
    variant: ModelPickerVariant,
    masterContext?: ModelPickerMasterGroup | null
  ) => {
    if (disabled || variant.disabled) return;
    if (masterContext?.masterKey && variant.resolvedThinkingLevel) {
      const mKey = masterContext.masterKey;
      const tLvl = variant.resolvedThinkingLevel;
      setLocalOrchThinking((prev) => ({ ...prev, [mKey]: tLvl }));
      if (onSelectOrchestrator) {
        onSelectOrchestrator(variant.id, mKey, tLvl);
      } else {
        onSelectModel(variant.id);
      }
      onClose();
      return;
    }
    onSelectModel(variant.id);
    onClose();
  };

  const onTouchStartSheet = (e: TouchEvent) => {
    if (e.touches.length !== 1) return;
    const target = e.target;
    if (target instanceof Element && target.closest('input, textarea, select, button')) return;
    const t = e.touches[0];
    const fromHeader = Boolean(
      target instanceof Element &&
        target.closest(`.${styles.handleWrap}, .${styles.header}`)
    );
    swipeRef.current = { x: t.clientX, y: t.clientY, mode: 'pending', fromHeader };
  };

  const onTouchMoveSheet = (e: TouchEvent) => {
    const start = swipeRef.current;
    if (!start || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;

    if (start.mode === 'pending') {
      if (Math.hypot(dx, dy) < 8) return;
      if (start.fromHeader && dy > 0 && Math.abs(dy) >= Math.abs(dx)) {
        start.mode = 'vertical';
        setSheetDragging(true);
      } else if (depth > 0 && dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.1) {
        start.mode = 'horizontal';
        setPickerDragging(true);
      } else {
        start.mode = 'locked-out';
        return;
      }
    }

    if (start.mode === 'vertical') {
      setSheetDragY(Math.max(0, dy));
    } else if (start.mode === 'horizontal') {
      setPickerDragX(Math.max(0, dx));
    }
  };

  const onTouchEndSheet = (e: TouchEvent) => {
    const start = swipeRef.current;
    swipeRef.current = null;
    if (!start) return;

    const t = e.changedTouches[0];
    const dx = t ? t.clientX - start.x : pickerDragX;
    const dy = t ? t.clientY - start.y : sheetDragY;

    if (start.mode === 'vertical') {
      setSheetDragging(false);
      if (dy > 80) {
        setSheetDragY(0);
        onClose();
        return;
      }
      setSheetDragY(0);
      return;
    }

    if (start.mode === 'horizontal' || (start.mode === 'pending' && depth > 0)) {
      setPickerDragging(false);
      setPickerDragX(0);
      if (dx > 56 && Math.abs(dy) < Math.abs(dx) * 0.75) {
        handleBack();
      }
      return;
    }

    setSheetDragging(false);
    setPickerDragging(false);
    setSheetDragY(0);
    setPickerDragX(0);
  };

  const activeGroupTitle = activeGroup
    ? activeGroup.isOrchestrator
      ? t('model.orchestratorGroup')
      : activeGroup.name
    : '';

  const headerTitle =
    depth === 0
      ? t('model.selectTitle')
      : depth === 1
        ? activeGroup?.isOrchestrator
          ? t('model.selectMaster')
          : activeGroupTitle || t('model.selectThinking')
        : activeMaster?.name || t('model.selectThinking');

  const headerBadge =
    depth === 0
      ? t('model.availableCount', { count: totalModels })
      : depth === 1
        ? activeGroup?.isOrchestrator
          ? t('model.step1Master')
          : t('model.thinkingLevel')
        : t('model.step2Thinking');

  const backLabel = depth === 2 ? t('model.masterModel') : t('model.modelList');

  const renderTierOptions = (
    variants: ModelPickerVariant[],
    ariaLabel: string,
    masterContext?: ModelPickerMasterGroup | null
  ) => {
    const masterKey = masterContext?.masterKey ?? null;
    const configuredTier = masterKey
      ? resolveMasterThinkingTier(masterContext, effectiveOrchThinking[masterKey])
      : null;
    const claimedTestIds = new Set<string>();

    return (
      <div className={styles.list} role="radiogroup" aria-label={ariaLabel}>
        {variants.map((variant) => {
          const isOrchMasterMode = Boolean(masterKey && variant.resolvedThinkingLevel);
          const isVarActive = isOrchMasterMode
            ? variant.resolvedThinkingLevel === configuredTier
            : variant.id === selectedModelId;
          const labelText =
            variant.tierLabel === '标准'
              ? t('model.standard')
              : variant.tierLabel || variant.model.label || t('model.standard');
          const descText = getTierDescription(variant.tierKey, t);

          let testId = `model-variant-${variant.id}`;
          if (isOrchMasterMode && masterKey) {
            const isExactTierMatch =
              variant.model.thinkingLevel === variant.resolvedThinkingLevel &&
              !claimedTestIds.has(testId);
            if (isExactTierMatch) {
              claimedTestIds.add(testId);
            } else if (!claimedTestIds.has(testId) && variant.tierKey === 'high' && !variant.model.thinkingLevel) {
              claimedTestIds.add(testId);
            } else {
              testId = `model-orch-tier-${masterKey}-${variant.tierKey}`;
            }
          }

          return (
            <button
              key={isOrchMasterMode ? `${masterKey}:${variant.tierKey}` : variant.id}
              type="button"
              role="radio"
              aria-checked={isVarActive}
              disabled={disabled || variant.disabled}
              data-testid={testId}
              data-tier={variant.tierKey}
              className={`${styles.tierCard} ${isVarActive ? styles.tierCardActive : ''}`}
              onClick={() => handleVariantTap(variant, masterContext)}
            >
              <div className={styles.tierMain}>
                <div className={styles.tierTopRow}>
                  <span className={styles.tierName}>{labelText}</span>
                  {variant.tagTitle && (
                    <span className={styles.tagPill}>{variant.tagTitle}</span>
                  )}
                </div>
                <div className={styles.tierDesc}>{descText}</div>
              </div>
              <div className={styles.tierRight}>
                {isVarActive ? (
                  <>
                    <span className={styles.activeBadge}>{t('model.current')}</span>
                    <span className={styles.checkIcon} aria-hidden="true">
                      ✓
                    </span>
                  </>
                ) : (
                  <span className={styles.radioRing} aria-hidden="true" />
                )}
              </div>
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <div
      className={styles.backdrop}
      data-hscroll="1"
      role="dialog"
      aria-modal="true"
      aria-label={t('model.selectTitle')}
      data-testid="model-picker-sheet"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={styles.sheet}
        data-dragging={sheetDragging ? '1' : '0'}
        style={{ '--sheet-drag-y': `${sheetDragY}px` } as Record<string, string>}
        onTouchStart={onTouchStartSheet}
        onTouchMove={onTouchMoveSheet}
        onTouchEnd={onTouchEndSheet}
        onTouchCancel={onTouchEndSheet}
      >
        <div className={styles.handleWrap}>
          <span className={styles.handle} />
        </div>

        <div className={styles.header}>
          <div className={styles.headerLeft}>
            {depth > 0 && (
              <button
                type="button"
                className={styles.backBtn}
                data-testid="model-picker-back"
                aria-label={t('model.backTo', { target: backLabel })}
                onClick={handleBack}
              >
                <span className={styles.backArrow} aria-hidden="true">
                  ‹
                </span>
                <span>{backLabel}</span>
              </button>
            )}
            <div className={styles.headerTitleGroup}>
              <h2 className={styles.title}>{headerTitle}</h2>
              <span className={styles.countBadge}>{headerBadge}</span>
            </div>
          </div>
          <button
            type="button"
            className={styles.closeBtn}
            aria-label={t('common.close')}
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className={styles.slideViewport}>
          <div
            className={styles.slideTrack}
            data-testid="model-picker-track"
            data-depth={String(depth)}
            data-dragging={pickerDragging ? '1' : '0'}
            style={{ '--picker-drag-x': `${pickerDragX}px` } as Record<string, string>}
          >
            {/* Stage 0: Model List */}
            <section className={styles.slidePane} aria-hidden={depth !== 0}>
              {groups.length > 6 && (
                <div className={styles.searchWrap}>
                  <input
                    type="search"
                    className={styles.searchInput}
                    placeholder={t('model.searchPlaceholder')}
                    value={query}
                    onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
                  />
                </div>
              )}

              <div className={styles.list}>
                {filteredGroups.length === 0 ? (
                  <div className={styles.empty}>{t('model.emptySearch')}</div>
                ) : (
                  filteredGroups.map((group) => {
                    const selectedVariant =
                      group.variants.find((v) => v.id === selectedModelId) || null;
                    const isSelectedGroup = group.id === activeStage0GroupId;
                    const singleVariant =
                      !group.hasSubLevels && !group.isOrchestrator ? group.variants[0] : null;
                    const isGroupDisabled = group.variants.every((v) => v.disabled);
                    const hasNextStage = group.isOrchestrator || group.hasSubLevels;

                    const masterList = group.masterGroups || [];
                    const activeMasterEntry =
                      group.isOrchestrator && activeOrchestratorMaster
                        ? masterList.find((m) => m.masterKey === activeOrchestratorMaster) || null
                        : null;
                    const resolvedActiveMasterTier =
                      group.isOrchestrator && activeOrchestratorMaster
                        ? activeMasterEntry
                          ? resolveMasterThinkingTier(
                              activeMasterEntry,
                              effectiveOrchThinking[activeOrchestratorMaster]
                            )
                          : effectiveOrchThinking[activeOrchestratorMaster]
                        : null;
                    const activeOrchLabel =
                      group.isOrchestrator && activeOrchestratorMaster
                        ? resolvedActiveMasterTier
                          ? `${activeMasterEntry?.name || activeOrchestratorMaster} · ${TIER_SHORT_LABELS[resolvedActiveMasterTier] || resolvedActiveMasterTier}`
                          : activeMasterEntry?.name || activeOrchestratorMaster
                        : null;

                    const groupDisplayName = group.isOrchestrator
                      ? t('model.orchestratorGroup')
                      : group.name;

                    const subtitleText = group.isOrchestrator
                      ? t('model.orchestratorSub', {
                          count: masterList.length,
                          names: masterList.map((m) => m.name).join(' / ')
                        })
                      : group.subtitle
                        ? group.subtitle
                        : group.hasSubLevels
                          ? t('model.tiersSub', {
                              count: group.variants.length,
                              tags: group.variants
                                .map((v) => (v.shortTag === '标准' ? t('model.standard') : v.shortTag))
                                .join(' / ')
                            })
                          : '';

                    return (
                      <div
                        key={group.id}
                        className={`${styles.groupCard} ${isSelectedGroup ? styles.groupCardActive : ''}`}
                        data-testid={`model-group-${group.id}`}
                      >
                        <button
                          type="button"
                          className={styles.groupRow}
                          disabled={disabled || isGroupDisabled}
                          onClick={() => handleGroupTap(group)}
                        >
                          <span
                            className={`${styles.providerDot} ${providerDotClass(group.provider)}`}
                          />

                          <div className={styles.groupMeta}>
                            <div className={styles.groupNameRow}>
                              <span className={styles.groupName}>{groupDisplayName}</span>
                              {singleVariant?.tagTitle && (
                                <span className={styles.tagPill}>{singleVariant.tagTitle}</span>
                              )}
                              {singleVariant?.tierLabel && (
                                <span className={styles.tierMiniPill}>
                                  {singleVariant.tierLabel}
                                </span>
                              )}
                            </div>
                            {subtitleText && (
                              <div className={styles.groupSub}>{subtitleText}</div>
                            )}
                          </div>

                          <div className={styles.groupRight}>
                            {isSelectedGroup && (activeOrchLabel || selectedVariant) && (
                              <span className={styles.activeBadge}>
                                {activeOrchLabel ||
                                  (hasNextStage && selectedVariant?.tierLabel
                                    ? selectedVariant.tierLabel
                                    : t('model.current'))}
                              </span>
                            )}
                            {hasNextStage ? (
                              <span className={styles.arrowRight} aria-hidden="true">
                                ›
                              </span>
                            ) : isSelectedGroup ? (
                              <span className={styles.checkIcon} aria-hidden="true">
                                ✓
                              </span>
                            ) : null}
                          </div>
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </section>

            {/* Stage 1: Thinking Levels (normal model) OR 4 Master Models (orchestrator) */}
            <section className={styles.slidePane} aria-hidden={depth !== 1}>
              {activeGroup ? (
                activeGroup.isOrchestrator ? (
                  <div className={styles.list}>
                    <div className={styles.stageHint}>{t('model.step1Hint')}</div>
                    {orchestratorMasters.map((master) => {
                      const mKey = master.masterKey ?? null;
                      const configuredTier = mKey ? effectiveOrchThinking[mKey] : null;
                      const resolvedTier = resolveMasterThinkingTier(master, configuredTier);
                      const tierBadge = resolvedTier
                        ? TIER_SHORT_LABELS[resolvedTier] || resolvedTier
                        : master.variants[0]?.shortTag === '标准'
                          ? t('model.standard')
                          : master.variants[0]?.shortTag || '';
                      const isMasterActive = Boolean(
                        (mKey && activeOrchestratorMaster === mKey) ||
                          (!mKey && master.variants.some((v) => v.id === selectedModelId))
                      );
                      const masterDisabled = master.variants.every((v) => v.disabled);
                      const hasTierSubLevels = master.hasSubLevels ?? master.variants.length > 1;
                      const subSummary = hasTierSubLevels
                        ? t('model.masterSub', { count: master.variants.length })
                        : resolvedTier
                          ? master.variants[0]?.tierLabel || tierBadge
                          : t('model.standard');

                      return (
                        <div
                          key={master.id}
                          className={`${styles.groupCard} ${isMasterActive ? styles.groupCardActive : ''}`}
                          data-testid={`model-master-${master.id}`}
                        >
                          <button
                            type="button"
                            className={styles.groupRow}
                            disabled={disabled || masterDisabled}
                            onClick={() => handleMasterTap(master)}
                          >
                            <span
                              className={`${styles.providerDot} ${providerDotClass(master.provider)}`}
                            />
                            <div className={styles.groupMeta}>
                              <div className={styles.groupNameRow}>
                                <span className={styles.groupName}>{master.name}</span>
                                {tierBadge && (
                                  <span className={styles.tierMiniPill} data-testid={`master-tier-${mKey || master.id}`}>
                                    {tierBadge}
                                  </span>
                                )}
                              </div>
                              <div className={styles.groupSub}>{subSummary}</div>
                            </div>
                            <div className={styles.groupRight}>
                              {isMasterActive && (
                                <span className={styles.activeBadge}>{t('model.currentMaster')}</span>
                              )}
                              {hasTierSubLevels ? (
                                <span className={styles.arrowRight} aria-hidden="true">
                                  ›
                                </span>
                              ) : isMasterActive ? (
                                <span className={styles.checkIcon} aria-hidden="true">
                                  ✓
                                </span>
                              ) : null}
                            </div>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  renderTierOptions(
                    activeGroup.variants,
                    `${activeGroup.name} ${t('model.thinkingLevel')}`
                  )
                )
              ) : (
                <div className={styles.empty} />
              )}
            </section>

            {/* Stage 2: Orchestrator Thinking Levels for Selected Master */}
            <section className={styles.slidePane} aria-hidden={depth !== 2}>
              {activeGroup?.isOrchestrator && activeMaster ? (
                <>
                  <div className={styles.stageSubHeader}>
                    <span className={styles.stageHintInline}>
                      {t('model.step2Hint', { name: activeMaster.name })}
                    </span>
                  </div>
                  {renderTierOptions(
                    activeMaster.variants,
                    `${activeMaster.name} ${t('model.thinkingLevel')}`,
                    activeMaster
                  )}
                </>
              ) : (
                <div className={styles.empty} />
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
