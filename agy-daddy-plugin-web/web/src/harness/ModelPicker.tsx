import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n, type I18nKey, type TranslateFn } from '../i18n';
import type {
  ModelBadge,
  ModelCatalogTree,
  ModelItem,
  ModelTreeBranchNode,
  ModelTreeLeafNode,
  ModelTreeNode,
} from '../types';
import styles from './ModelPicker.module.css';

export interface ModelPickerProps {
  models: ModelItem[];
  tree?: ModelCatalogTree | null;
  selectedModelId?: string | null;
  onSelectModel: (modelId: string) => void;
  selectedThinkingLevel?: string | null;
  onSelectThinkingLevel?: (level: string | null) => void;
  disabled?: boolean;
}

const DEFAULT_ORCH_THINKING_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;

const THINKING_DISPLAY_NAMES: Record<string, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
};

function normalizeThinkingLevel(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw === 1) return 'low';
    if (raw === 2) return 'medium';
    if (raw === 3) return 'high';
    if (raw === 100) return 'xhigh';
    return null;
  }
  const clean = String(raw).trim().toLowerCase().replace(/^thinking_level_/, '');
  if (!clean) return null;
  if (clean === 'x-high' || clean === 'extra high' || clean === 'extra_high' || clean === 'xhigh') {
    return 'xhigh';
  }
  if (clean === 'med' || clean === 'medium') return 'medium';
  if (clean === 'minimal' || clean === 'low' || clean === 'high') return clean;
  return null;
}

function getThinkingDisplayName(level: string | null | undefined): string {
  const norm = normalizeThinkingLevel(level);
  if (!norm) return '';
  return THINKING_DISPLAY_NAMES[norm] || norm;
}

function resolveLeafThinkingSuffix(leaf: ModelTreeLeafNode | null | undefined): string | null {
  if (!leaf) return null;
  if (leaf.defaultThinkingSuffix) {
    return normalizeThinkingLevel(leaf.defaultThinkingSuffix) || leaf.defaultThinkingSuffix;
  }
  if (leaf.selection.mode === 'orchestrator_preset' && leaf.selection.plannerThinkingSuffix) {
    return (
      normalizeThinkingLevel(leaf.selection.plannerThinkingSuffix) ||
      leaf.selection.plannerThinkingSuffix
    );
  }
  if (leaf.thinkingLevel !== undefined && leaf.thinkingLevel !== null) {
    return normalizeThinkingLevel(leaf.thinkingLevel);
  }
  if (leaf.role === 'thinking_level') {
    const tail = leaf.key.split('/').pop();
    return normalizeThinkingLevel(tail);
  }
  return null;
}

function resolveOrchestratorSecondaryLabel(
  leaf: ModelTreeLeafNode,
  thinkingLevel: string | null,
): string | undefined {
  const display = getThinkingDisplayName(thinkingLevel);
  if (!display) return leaf.secondaryLabel;
  if (leaf.secondaryLabel && leaf.secondaryLabel.includes('·')) {
    const parts = leaf.secondaryLabel.split('·');
    return `${display} ·${parts.slice(1).join('·')}`;
  }
  if (leaf.selection.mode === 'orchestrator_preset' && leaf.selection.executorFamilyId) {
    const execTail = leaf.selection.executorFamilyId.split('-').pop() || 'Hydrogen';
    const execName = execTail.charAt(0).toUpperCase() + execTail.slice(1);
    return `${display} · → ${execName}`;
  }
  return `${display} · → Hydrogen`;
}

function buildFallbackTree(models: ModelItem[]): ModelCatalogTree {
  const nodes: ModelTreeLeafNode[] = models.map((m) => {
    const label = m.displayName || m.label || m.id;
    const badge: ModelBadge | undefined = m.tagTitle
      ? {
          kind: m.tagTitle.toLowerCase().includes('leaving')
            ? 'leaving_soon'
            : m.tagTitle.toLowerCase() === 'new'
              ? 'new'
              : 'notice',
          labelKey: m.tagTitle.toLowerCase().includes('leaving')
            ? 'models.badge.leaving_soon'
            : m.tagTitle.toLowerCase() === 'new'
              ? 'models.badge.new'
              : 'models.badge.notice',
          rawTitle: m.tagTitle,
          description: m.tagDescription || undefined,
        }
      : undefined;

    return {
      kind: 'leaf',
      key: `family/${m.modelId || m.id}`,
      role: 'family',
      label,
      ...(badge ? { badge } : {}),
      disabled: m.disabled,
      isRecommended: m.isDefault,
      selectedDisplayLabel: label,
      selection: {
        mode: 'single',
        requestedModel: m.id,
        modelId: m.modelId || m.id,
      },
    };
  });

  const defLeaf =
    nodes.find((l) => !l.disabled && models.some((m) => m.isDefault && m.id === l.selection.requestedModel)) ||
    nodes.find((l) => !l.disabled) ||
    nodes[0];

  return {
    supportsCustomOrchestrator: false,
    defaultSelectionKey: defLeaf?.key || null,
    nodes,
  };
}

function ensureOpusOrchestratorPreset(
  tree: ModelCatalogTree,
  models: ModelItem[],
): ModelCatalogTree {
  const orchIndex = tree.nodes.findIndex(
    (n) => n.kind === 'branch' && n.role === 'orchestrator_root',
  );
  if (orchIndex < 0) return tree;
  const orchBranch = tree.nodes[orchIndex] as ModelTreeBranchNode;
  if (orchBranch.children.some((c) => /^orch\/claude-opus/i.test(c.key))) {
    return tree;
  }

  const opusModels = models.filter((m) =>
    /^claude-opus/i.test(String(m.modelId || m.label || m.displayName || '')),
  );
  if (opusModels.length === 0) return tree;

  const firstMid = String(opusModels[0].modelId || '');
  const famMatch = firstMid.match(/^(claude-opus-[\w.]+)-(?:low|medium|high|xhigh)$/i);
  const opusFamilyId = famMatch ? famMatch[1] : 'claude-opus-5-5';
  const backingModels: Record<string, string> = {};
  const supportedThinkingLevels: string[] = [];

  for (const m of opusModels) {
    const mid = String(m.modelId || '');
    const tail = mid.replace(new RegExp(`^${opusFamilyId}-`, 'i'), '');
    const labelMatch = String(m.displayName || m.label || '').match(/\((low|medium|high|xhigh)\)/i);
    const sfx = normalizeThinkingLevel(tail) || normalizeThinkingLevel(labelMatch?.[1]) || 'medium';
    if (!backingModels[sfx]) backingModels[sfx] = m.id;
    if (!supportedThinkingLevels.includes(sfx)) supportedThinkingLevels.push(sfx);
  }

  const orderedLevels = ['low', 'medium', 'high', 'xhigh'].filter((l) =>
    supportedThinkingLevels.includes(l),
  );
  const finalLevels = orderedLevels.length > 0 ? orderedLevels : ['low', 'medium', 'high'];
  const defaultSuffix = backingModels.high
    ? 'high'
    : backingModels.medium
      ? 'medium'
      : finalLevels[0];
  const defaultId = backingModels[defaultSuffix];
  const defaultModel = opusModels.find((m) => m.id === defaultId) || opusModels[0];
  const cleanLabel =
    String(defaultModel.displayName || defaultModel.label || 'Claude Opus 5.5')
      .replace(/\s*\((?:low|medium|high|xhigh)\)\s*$/i, '')
      .trim() || 'Claude Opus 5.5';
  const defaultDisplay = getThinkingDisplayName(defaultSuffix) || 'High';
  const rawFrac = Number(defaultModel.quotaInfo?.remainingFraction);
  const quota = Number.isFinite(rawFrac)
    ? {
        remainingFraction: rawFrac,
        resetTime:
          typeof defaultModel.quotaInfo?.resetTime === 'string'
            ? defaultModel.quotaInfo.resetTime
            : null,
      }
    : null;

  const opusLeaf: ModelTreeLeafNode = {
    kind: 'leaf',
    key: `orch/${opusFamilyId}`,
    role: 'planner_model',
    label: cleanLabel,
    secondaryLabel: `${defaultDisplay} · → Hydrogen`,
    quota,
    disabled: opusModels.every((m) => m.disabled),
    supportedThinkingLevels: finalLevels,
    defaultThinkingSuffix: defaultSuffix,
    selectedDisplayLabel: `Orchestrator · ${cleanLabel} ${defaultDisplay}`,
    selection: {
      mode: 'orchestrator_preset',
      requestedModel: `orchestrator:${opusFamilyId}`,
      modelId: `${opusFamilyId}-orchestrator`,
      plannerFamilyId: opusFamilyId,
      executorFamilyId: 'gemini-4-hydrogen',
      plannerThinkingSuffix: defaultSuffix,
      backingModels,
    },
  };

  const nextNodes = tree.nodes.map((node, idx) =>
    idx === orchIndex
      ? {
          ...orchBranch,
          children: [...orchBranch.children, opusLeaf],
        }
      : node,
  );
  return {
    ...tree,
    nodes: nextNodes,
  };
}

function findLeafByModelId(
  nodes: ModelTreeNode[],
  targetId: string | null | undefined,
): { leaf: ModelTreeLeafNode; branch: ModelTreeBranchNode | null } | null {
  if (!targetId) return null;
  for (const node of nodes) {
    if (node.kind === 'leaf') {
      if (node.selection.requestedModel === targetId || node.selection.modelId === targetId) {
        return { leaf: node, branch: null };
      }
    } else {
      for (const child of node.children) {
        if (
          child.kind === 'leaf' &&
          (child.selection.requestedModel === targetId || child.selection.modelId === targetId)
        ) {
          return { leaf: child, branch: node };
        }
        if (child.kind === 'branch') {
          const nested = findLeafByModelId([child], targetId);
          if (nested) return { leaf: nested.leaf, branch: node };
        }
      }
    }
  }
  return null;
}

function translateBadgeText(badge: ModelBadge, t: TranslateFn): string {
  const translated = t(badge.labelKey as I18nKey);
  if (translated && translated !== badge.labelKey) return translated;
  return badge.rawTitle || '';
}

function localizeThinkingSuffixLabel(suffix: string, t: TranslateFn): string {
  const norm = normalizeThinkingLevel(suffix) || suffix;
  const key = `models.thinking.${norm}` as I18nKey;
  const tr = t(key);
  if (tr && tr !== key) return tr;
  return getThinkingDisplayName(norm) || suffix;
}

function localizeThinkingLabel(node: ModelTreeNode, t: TranslateFn): string {
  if (node.role === 'thinking_level') {
    const suffix = node.key.split('/').pop() || '';
    return localizeThinkingSuffixLabel(suffix, t) || node.label;
  }
  return node.label;
}

export function ModelPicker({
  models,
  tree,
  selectedModelId,
  onSelectModel,
  selectedThinkingLevel,
  onSelectThinkingLevel,
  disabled = false,
}: ModelPickerProps) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [activeBranchKey, setActiveBranchKey] = useState<string | null>(null);
  const [drillInSecondary, setDrillInSecondary] = useState(false);
  const [internalThinkingLevel, setInternalThinkingLevel] = useState<string | null>(null);
  const [orchThinkingTouched, setOrchThinkingTouched] = useState(false);
  const [focusedOrchLeafKey, setFocusedOrchLeafKey] = useState<string | null>(null);

  const controlledThinking =
    selectedThinkingLevel !== undefined
      ? normalizeThinkingLevel(selectedThinkingLevel)
      : internalThinkingLevel;

  const commitThinkingLevel = (next: string | null) => {
    const normalized = normalizeThinkingLevel(next);
    if (selectedThinkingLevel === undefined) {
      setInternalThinkingLevel(normalized);
    }
    onSelectThinkingLevel?.(normalized);
  };

  const effectiveTree = useMemo<ModelCatalogTree>(() => {
    const baseTree =
      tree && Array.isArray(tree.nodes) && tree.nodes.length > 0 ? tree : buildFallbackTree(models);
    return ensureOpusOrchestratorPreset(baseTree, models);
  }, [tree, models]);

  const activeMatch = useMemo(
    () => findLeafByModelId(effectiveTree.nodes, selectedModelId),
    [effectiveTree.nodes, selectedModelId],
  );

  const activeLeaf = useMemo(() => {
    if (activeMatch) return activeMatch.leaf;
    if (effectiveTree.defaultSelectionKey) {
      for (const n of effectiveTree.nodes) {
        if (n.kind === 'leaf' && n.key === effectiveTree.defaultSelectionKey) return n;
        if (n.kind === 'branch') {
          const hit = n.children.find(
            (c): c is ModelTreeLeafNode => c.kind === 'leaf' && c.key === effectiveTree.defaultSelectionKey,
          );
          if (hit) return hit;
        }
      }
    }
    return null;
  }, [activeMatch, effectiveTree]);

  const activeBranch = useMemo<ModelTreeBranchNode | null>(() => {
    const branches = effectiveTree.nodes.filter(
      (n): n is ModelTreeBranchNode => n.kind === 'branch',
    );
    if (branches.length === 0) return null;
    if (activeBranchKey) {
      const found = branches.find((b) => b.key === activeBranchKey);
      if (found) return found;
    }
    if (activeMatch?.branch) return activeMatch.branch;
    return branches[0];
  }, [effectiveTree.nodes, activeBranchKey, activeMatch]);

  const targetOrchLeaf = useMemo<ModelTreeLeafNode | null>(() => {
    if (!activeBranch || activeBranch.role !== 'orchestrator_root') return null;
    const leaves = activeBranch.children.filter(
      (c): c is ModelTreeLeafNode => c.kind === 'leaf',
    );
    if (focusedOrchLeafKey) {
      const focused = leaves.find((c) => c.key === focusedOrchLeafKey);
      if (focused) return focused;
    }
    if (activeMatch?.branch?.key === activeBranch.key && activeLeaf) {
      return activeLeaf;
    }
    return (
      leaves.find((c) => c.key === activeBranch.defaultChildKey && !c.disabled) ||
      leaves.find((c) => !c.disabled) ||
      leaves[0] ||
      null
    );
  }, [activeBranch, focusedOrchLeafKey, activeMatch, activeLeaf]);

  const orchSupportedThinkingLevels = useMemo<string[]>(() => {
    const raw = targetOrchLeaf?.supportedThinkingLevels;
    if (Array.isArray(raw) && raw.length > 0) {
      const normalized = raw
        .map((lvl) => normalizeThinkingLevel(lvl))
        .filter((lvl): lvl is string => Boolean(lvl));
      if (normalized.length > 0) return Array.from(new Set(normalized));
    }
    return [...DEFAULT_ORCH_THINKING_LEVELS];
  }, [targetOrchLeaf]);

  const activeOrchThinkingLevel = useMemo<string | null>(() => {
    if (!activeLeaf || activeLeaf.selection.mode !== 'orchestrator_preset') return null;
    return controlledThinking || resolveLeafThinkingSuffix(activeLeaf) || 'high';
  }, [activeLeaf, controlledThinking]);

  const previewOrchThinkingLevel = useMemo<string>(() => {
    if (activeMatch?.branch?.role === 'orchestrator_root' && activeOrchThinkingLevel) {
      return activeOrchThinkingLevel;
    }
    if (orchThinkingTouched && controlledThinking) {
      return controlledThinking;
    }
    return resolveLeafThinkingSuffix(targetOrchLeaf) || 'high';
  }, [activeMatch, activeOrchThinkingLevel, orchThinkingTouched, controlledThinking, targetOrchLeaf]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (ev: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(ev.target as Node)) {
        setOpen(false);
        setDrillInSecondary(false);
        setOrchThinkingTouched(false);
        setFocusedOrchLeafKey(null);
      }
    };
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        setOpen(false);
        setDrillInSecondary(false);
        setOrchThinkingTouched(false);
        setFocusedOrchLeafKey(null);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const handleToggle = () => {
    if (disabled || effectiveTree.nodes.length === 0) return;
    setOpen((prev) => {
      const next = !prev;
      if (next) {
        setActiveBranchKey(activeMatch?.branch?.key ?? null);
        setDrillInSecondary(false);
        setOrchThinkingTouched(false);
        setFocusedOrchLeafKey(
          activeMatch?.branch?.role === 'orchestrator_root' ? activeMatch.leaf.key : null,
        );
      }
      return next;
    });
  };

  const handleSelectLeaf = (leaf: ModelTreeLeafNode) => {
    if (leaf.disabled) return;
    onSelectModel(leaf.selection.requestedModel);
    if (leaf.selection.mode === 'orchestrator_preset') {
      const supported =
        leaf.supportedThinkingLevels && leaf.supportedThinkingLevels.length > 0
          ? leaf.supportedThinkingLevels
              .map((l) => normalizeThinkingLevel(l))
              .filter((l): l is string => Boolean(l))
          : [...DEFAULT_ORCH_THINKING_LEVELS];
      const keepExisting =
        (activeMatch?.branch?.role === 'orchestrator_root' || orchThinkingTouched) &&
        controlledThinking &&
        supported.includes(controlledThinking);
      const nextLevel = keepExisting
        ? controlledThinking
        : resolveLeafThinkingSuffix(leaf) || 'high';
      setFocusedOrchLeafKey(leaf.key);
      setOrchThinkingTouched(true);
      commitThinkingLevel(nextLevel);
      return;
    }
    commitThinkingLevel(resolveLeafThinkingSuffix(leaf));
    setOrchThinkingTouched(false);
    setFocusedOrchLeafKey(null);
    setOpen(false);
    setDrillInSecondary(false);
  };

  const handleSelectOrchThinking = (level: string) => {
    const normalized = normalizeThinkingLevel(level) || level;
    commitThinkingLevel(normalized);
    if (targetOrchLeaf && activeLeaf?.key !== targetOrchLeaf.key) {
      onSelectModel(targetOrchLeaf.selection.requestedModel);
    }
    setOrchThinkingTouched(false);
    setFocusedOrchLeafKey(null);
    setOpen(false);
    setDrillInSecondary(false);
  };

  const triggerParts = useMemo<{ primary: string; secondary: string | null }>(() => {
    if (activeLeaf?.selection.mode === 'orchestrator_preset') {
      const display = getThinkingDisplayName(activeOrchThinkingLevel) || 'High';
      return {
        primary: 'Orchestrator',
        secondary: `${activeLeaf.label} ${display}`,
      };
    }
    if (
      activeLeaf?.role === 'family' &&
      activeLeaf.supportedThinkingLevels &&
      activeLeaf.supportedThinkingLevels.length > 0 &&
      controlledThinking
    ) {
      const display = getThinkingDisplayName(controlledThinking);
      if (display) {
        return {
          primary: activeLeaf.label,
          secondary: display,
        };
      }
    }
    if (activeLeaf?.role === 'thinking_level' && activeMatch?.branch) {
      return {
        primary: activeMatch.branch.label,
        secondary: activeLeaf.label,
      };
    }
    const fallbackText =
      activeLeaf?.selectedDisplayLabel ||
      models.find((m) => m.id === selectedModelId)?.displayName ||
      t('composer.defaultModel');
    return { primary: fallbackText, secondary: null };
  }, [activeLeaf, activeMatch, activeOrchThinkingLevel, controlledThinking, models, selectedModelId, t]);

  return (
    <div ref={rootRef} className={styles.picker} data-testid="composer-model-picker">
      <button
        type="button"
        className={styles.trigger}
        onClick={handleToggle}
        disabled={disabled || effectiveTree.nodes.length === 0}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('models.selectModel')}
        data-testid="model-picker-trigger"
      >
        <span className={styles.triggerText}>
          <span className={styles.triggerPrimary}>{triggerParts.primary}</span>
          {triggerParts.secondary && (
            <span className={styles.triggerSecondary}> · {triggerParts.secondary}</span>
          )}
        </span>
        <svg
          className={styles.triggerCaret}
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4.5 6.25 8 9.75l3.5-3.5" />
        </svg>
      </button>

      {open && (
        <div
          className={styles.popover}
          role="menu"
          aria-label={t('models.selectModel')}
          data-testid="model-picker-popover"
        >
          <div
            className={styles.primaryPane}
            data-drill={drillInSecondary ? 'true' : 'false'}
            data-testid="model-picker-primary"
          >
            {effectiveTree.nodes.map((node) => {
              const isBranch = node.kind === 'branch';
              const containsSelected =
                node.kind === 'leaf'
                  ? activeLeaf?.key === node.key
                  : activeMatch?.branch?.key === node.key;
              const isHighlighted = isBranch && activeBranch?.key === node.key;

              const orchDisplay = getThinkingDisplayName(activeOrchThinkingLevel) || 'High';
              const rowSecondary =
                containsSelected && isBranch && activeLeaf
                  ? node.role === 'orchestrator_root'
                    ? `${activeLeaf.label} ${orchDisplay}`
                    : activeLeaf.label
                  : node.secondaryLabel;

              const displayLabel =
                node.role === 'orchestrator_root' ? t('models.orchestratorName') : node.label;

              return (
                <button
                  key={node.key}
                  type="button"
                  role="menuitem"
                  disabled={node.disabled}
                  className={[
                    styles.row,
                    containsSelected ? styles.rowSelected : '',
                    isHighlighted ? styles.rowHighlighted : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onMouseEnter={() => {
                    if (isBranch) setActiveBranchKey(node.key);
                  }}
                  onClick={() => {
                    if (node.kind === 'leaf') {
                      handleSelectLeaf(node);
                    } else {
                      setActiveBranchKey(node.key);
                      setDrillInSecondary(true);
                    }
                  }}
                  data-node-key={node.key}
                  data-node-kind={node.kind}
                  data-selected={containsSelected ? 'true' : 'false'}
                >
                  <span className={styles.rowMain}>
                    <span className={styles.rowLabel}>{displayLabel}</span>
                    {rowSecondary && <span className={styles.rowSecondary}>{rowSecondary}</span>}
                    {node.badge && (
                      <span
                        className={`${styles.badgePill} ${styles[`badge_${node.badge.kind}`] || ''}`}
                        title={node.badge.description}
                      >
                        {translateBadgeText(node.badge, t)}
                        {node.badge.description ? ' ⓘ' : ''}
                      </span>
                    )}
                  </span>

                  <span className={styles.rowEnd}>
                    {containsSelected && (
                      <span className={styles.checkMark} aria-label="Selected">
                        ✓
                      </span>
                    )}
                    {isBranch && (
                      <span className={styles.chevron} aria-hidden="true">
                        ›
                      </span>
                    )}
                  </span>
                </button>
              );
            })}

            {activeLeaf?.role === 'family' &&
              activeLeaf.supportedThinkingLevels &&
              activeLeaf.supportedThinkingLevels.length > 1 && (
                <div
                  className={styles.inlineThinkingSection}
                  data-testid="family-thinking-selector"
                >
                  <span className={styles.thinkingSectionTitle}>
                    {t('models.thinkingLevelConfig')}
                  </span>
                  <div className={styles.thinkingChips}>
                    {activeLeaf.supportedThinkingLevels.map((lvl) => {
                      const norm = normalizeThinkingLevel(lvl) || lvl;
                      const current =
                        controlledThinking || resolveLeafThinkingSuffix(activeLeaf) || 'medium';
                      const isChecked = current === norm;
                      return (
                        <button
                          key={norm}
                          type="button"
                          role="menuitemradio"
                          aria-checked={isChecked}
                          className={`${styles.thinkingChip} ${isChecked ? styles.thinkingChipActive : ''}`}
                          onClick={() => commitThinkingLevel(norm)}
                          data-testid={`family-thinking-level-${norm}`}
                        >
                          {localizeThinkingSuffixLabel(norm, t)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
          </div>

          {activeBranch && (
            <div
              className={styles.secondaryPane}
              data-drill={drillInSecondary ? 'true' : 'false'}
              data-testid="model-picker-secondary"
            >
              <button
                type="button"
                className={styles.backBtn}
                onClick={() => setDrillInSecondary(false)}
              >
                ‹ {t('models.back')}
              </button>

              <div className={styles.secondaryHeader}>
                <span className={styles.secondaryTitle}>
                  {activeBranch.role === 'orchestrator_root'
                    ? t('models.orchestratorPresetsTitle')
                    : `${activeBranch.label} · ${t('models.thinkingLevelTitle')}`}
                </span>
                {activeBranch.role === 'orchestrator_root' && (
                  <span className={styles.secondaryHint}>{t('models.orchestratorExecutorHint')}</span>
                )}
              </div>

              {activeBranch.children.map((child) => {
                if (child.kind !== 'leaf') return null;
                const isSelected = activeLeaf?.key === child.key;
                const quotaPct =
                  child.quota && Number.isFinite(child.quota.remainingFraction)
                    ? Math.round(child.quota.remainingFraction * 100)
                    : null;
                const childSecondary =
                  activeBranch.role === 'orchestrator_root' && isSelected
                    ? resolveOrchestratorSecondaryLabel(child, previewOrchThinkingLevel)
                    : child.secondaryLabel;

                return (
                  <button
                    key={child.key}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isSelected}
                    disabled={child.disabled}
                    className={`${styles.row} ${isSelected ? styles.rowSelected : ''}`}
                    onClick={() => handleSelectLeaf(child)}
                    data-node-key={child.key}
                    data-model-id={child.selection.requestedModel}
                    data-selected={isSelected ? 'true' : 'false'}
                  >
                    <span className={styles.rowMain}>
                      <span className={styles.rowLabel}>{localizeThinkingLabel(child, t)}</span>
                      {childSecondary && (
                        <span className={styles.rowSecondary}>{childSecondary}</span>
                      )}
                    </span>

                    <span className={styles.rowEnd}>
                      {quotaPct !== null && (
                        <span
                          className={styles.quotaChip}
                          title={t('models.quotaRemaining', { pct: quotaPct })}
                        >
                          {quotaPct}%
                        </span>
                      )}
                      {isSelected && <span className={styles.checkMark}>✓</span>}
                    </span>
                  </button>
                );
              })}

              {activeBranch.role === 'orchestrator_root' && (
                <div
                  className={styles.thinkingSection}
                  data-testid="orch-thinking-selector"
                >
                  <div className={styles.thinkingSectionHeader}>
                    <span className={styles.thinkingSectionTitle}>
                      {t('models.thinkingLevelConfig')}
                    </span>
                    {targetOrchLeaf && (
                      <span className={styles.thinkingSectionTarget}>
                        {targetOrchLeaf.label}
                      </span>
                    )}
                  </div>
                  <div className={styles.thinkingChips}>
                    {orchSupportedThinkingLevels.map((lvl) => {
                      const isChecked = previewOrchThinkingLevel === lvl;
                      return (
                        <button
                          key={lvl}
                          type="button"
                          role="menuitemradio"
                          aria-checked={isChecked}
                          className={`${styles.thinkingChip} ${isChecked ? styles.thinkingChipActive : ''}`}
                          onClick={() => handleSelectOrchThinking(lvl)}
                          data-testid={`orch-thinking-level-${lvl}`}
                          data-selected={isChecked ? 'true' : 'false'}
                        >
                          <span>{localizeThinkingSuffixLabel(lvl, t)}</span>
                          {isChecked && <span className={styles.checkMark}>✓</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
