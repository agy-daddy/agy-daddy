import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  DEFAULT_ORCHESTRATOR_THINKING,
  groupModelsForPicker
} from '../store/modelCatalog';
import type {
  BackendModelGroup,
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

function getTierDescription(tierKey: string): string {
  switch (tierKey) {
    case 'minimal':
      return '极速响应 · 最低思考开销';
    case 'low':
      return '快速响应 · 适合日常轻量任务';
    case 'medium':
      return '均衡推理 · 速度与质量平衡';
    case 'high':
      return '深度推理 · 推荐用于复杂编码';
    case 'xhigh':
      return '超强推理 · 适合高难度架构设计';
    case 'max':
      return '极限推理 · 最大思考预算';
    case 'thinking':
      return '扩展思考 · 展示完整推理过程';
    default:
      return '默认思考配置';
  }
}

export function ModelPickerSheet(props: ModelPickerSheetProps) {
  const {
    open,
    models,
    modelGroups,
    backendModelGroups,
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
    return groupModelsForPicker(models, backendModelGroups);
  }, [modelGroups, models, backendModelGroups]);

  const [depth, setDepth] = useState<PickerDepth>(0);
  const [selectedGroupId, setSelectedGroupId] = useState<string>('');
  const [selectedMasterId, setSelectedMasterId] = useState<string>('');
  const [query, setQuery] = useState('');

  const swipeRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (open) {
      setDepth(0);
      setSelectedGroupId('');
      setSelectedMasterId('');
      setQuery('');
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
    if (depth === 0 || e.touches.length !== 1) return;
    const target = e.target;
    if (target instanceof Element && target.closest('input, textarea, select')) return;
    const t = e.touches[0];
    swipeRef.current = { x: t.clientX, y: t.clientY };
  };

  const onTouchEndSheet = (e: TouchEvent) => {
    const start = swipeRef.current;
    swipeRef.current = null;
    if (!start || depth === 0 || e.changedTouches.length !== 1) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (dx > 56 && Math.abs(dy) < Math.abs(dx) * 0.75) {
      handleBack();
    }
  };

  const headerTitle =
    depth === 0
      ? '选择模型'
      : depth === 1
        ? activeGroup?.isOrchestrator
          ? '选择主控模型'
          : activeGroup?.name || '选择思考等级'
        : activeMaster?.name || '选择思考等级';

  const headerBadge =
    depth === 0
      ? `${totalModels} 个可用`
      : depth === 1
        ? activeGroup?.isOrchestrator
          ? '1/2 · 编排主控'
          : '思考等级'
        : '2/2 · 思考等级';

  const backLabel = depth === 2 ? '主控模型' : '模型列表';

  const renderTierOptions = (
    variants: ModelPickerVariant[],
    ariaLabel: string,
    masterContext?: ModelPickerMasterGroup | null
  ) => {
    const masterKey = masterContext?.masterKey;
    const configuredTier = masterKey ? effectiveOrchThinking[masterKey] : null;
    const claimedTestIds = new Set<string>();

    return (
      <div className={styles.list} role="radiogroup" aria-label={ariaLabel}>
        {variants.map((variant) => {
          const isOrchMasterMode = Boolean(masterKey && variant.resolvedThinkingLevel);
          const isVarActive = isOrchMasterMode
            ? variant.resolvedThinkingLevel === configuredTier
            : variant.id === selectedModelId;
          const labelText = variant.tierLabel || variant.model.label || '标准';
          const descText = getTierDescription(variant.tierKey);

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
                    <span className={styles.activeBadge}>当前</span>
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
      aria-label="选择模型"
      data-testid="model-picker-sheet"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={styles.sheet}
        onTouchStart={onTouchStartSheet}
        onTouchEnd={onTouchEndSheet}
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
                aria-label={`返回${backLabel}`}
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
            aria-label="关闭模型选择"
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
          >
            {/* Stage 0: Model List */}
            <section className={styles.slidePane} aria-hidden={depth !== 0}>
              {groups.length > 6 && (
                <div className={styles.searchWrap}>
                  <input
                    type="search"
                    className={styles.searchInput}
                    placeholder="搜索模型、思考等级或编排主控..."
                    value={query}
                    onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
                  />
                </div>
              )}

              <div className={styles.list}>
                {filteredGroups.length === 0 ? (
                  <div className={styles.empty}>未找到匹配的模型</div>
                ) : (
                  filteredGroups.map((group) => {
                    const selectedVariant =
                      group.variants.find((v) => v.id === selectedModelId) || null;
                    const isSelectedGroup = group.id === activeStage0GroupId;
                    const singleVariant =
                      !group.hasSubLevels && !group.isOrchestrator ? group.variants[0] : null;
                    const isGroupDisabled = group.variants.every((v) => v.disabled);
                    const hasNextStage = group.isOrchestrator || group.hasSubLevels;

                    const activeOrchLabel =
                      group.isOrchestrator && activeOrchestratorMaster
                        ? `${activeOrchestratorMaster} · ${TIER_SHORT_LABELS[effectiveOrchThinking[activeOrchestratorMaster]] || effectiveOrchThinking[activeOrchestratorMaster]}`
                        : null;

                    const subtitleText = group.isOrchestrator
                      ? `${orchestratorCountLabel(group)} · Carbon / Argon / Neon / Opus 5.5`
                      : group.subtitle
                        ? group.subtitle
                        : group.hasSubLevels
                          ? `${group.variants.length} 档思考等级 · ${group.variants.map((v) => v.shortTag).join(' / ')}`
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
                              <span className={styles.groupName}>{group.name}</span>
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
                                    : '当前')}
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
                    <div className={styles.stageHint}>
                      第 1 步 / 共 2 步：选择主控模型（各主控独立保存思考等级）
                    </div>
                    {orchestratorMasters.map((master) => {
                      const mKey = master.masterKey;
                      const configuredTier = mKey ? effectiveOrchThinking[mKey] : 'high';
                      const tierBadge = TIER_SHORT_LABELS[configuredTier] || configuredTier;
                      const isMasterActive = Boolean(
                        mKey && activeOrchestratorMaster === mKey
                      );
                      const masterDisabled = master.variants.every((v) => v.disabled);
                      const subSummary = `${master.variants.length} 档可调思考等级 · 点击配置`;

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
                                <span className={styles.tierMiniPill} data-testid={`master-tier-${mKey || master.id}`}>
                                  {tierBadge}
                                </span>
                              </div>
                              <div className={styles.groupSub}>{subSummary}</div>
                            </div>
                            <div className={styles.groupRight}>
                              {isMasterActive && (
                                <span className={styles.activeBadge}>当前主控</span>
                              )}
                              <span className={styles.arrowRight} aria-hidden="true">
                                ›
                              </span>
                            </div>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  renderTierOptions(activeGroup.variants, `${activeGroup.name} 思考等级`)
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
                      第 2 步 / 共 2 步：为主控模型「{activeMaster.name}」配置思考等级
                    </span>
                  </div>
                  {renderTierOptions(
                    activeMaster.variants,
                    `${activeMaster.name} 思考等级`,
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

function orchestratorCountLabel(group: ModelPickerGroup): string {
  const count = group.masterGroups?.length || 4;
  return `${count} 个主控模型`;
}
