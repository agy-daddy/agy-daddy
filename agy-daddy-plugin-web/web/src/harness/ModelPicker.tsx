import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n, type I18nKey, type TranslateFn } from '../i18n';
import { useTheme } from '../theme/ThemeProvider';
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
  const { drawerSpeed } = useTheme();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const paneRefs = useRef<Array<HTMLDivElement | null>>([null, null, null]);
  const lastParentKeyRef = useRef<string | null>(null);

  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState<0 | 1 | 2>(0);
  const [activeBranchKey, setActiveBranchKey] = useState<string | null>(null);
  const [internalThinkingLevel, setInternalThinkingLevel] = useState<string | null>(null);
  const [orchThinkingTouched, setOrchThinkingTouched] = useState(false);
  const [focusedOrchLeafKey, setFocusedOrchLeafKey] = useState<string | null>(null);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setPrefersReducedMotion(Boolean(mql.matches));
    sync();
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', sync);
      return () => mql.removeEventListener('change', sync);
    }
    return undefined;
  }, []);

  const transitionMs = useMemo(() => {
    if (prefersReducedMotion || drawerSpeed === 'off') return 0;
    if (drawerSpeed === 'fast') return 120;
    if (drawerSpeed === 'smooth') return 320;
    return 220;
  }, [prefersReducedMotion, drawerSpeed]);

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

  const closePicker = (restoreTriggerFocus = false) => {
    setOpen(false);
    setLevel(0);
    setOrchThinkingTouched(false);
    setFocusedOrchLeafKey(null);
    if (restoreTriggerFocus) {
      requestAnimationFrame(() => triggerRef.current?.focus());
    }
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (ev: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(ev.target as Node)) {
        closePicker(false);
      }
    };
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        closePicker(true);
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
        setLevel(0);
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
      if (supported.length >= 2) {
        lastParentKeyRef.current = leaf.key;
        setLevel(2);
        return;
      }
      closePicker(true);
      return;
    }
    commitThinkingLevel(resolveLeafThinkingSuffix(leaf));
    closePicker(true);
  };

  const handleSelectOrchThinking = (thinkingLvl: string) => {
    const normalized = normalizeThinkingLevel(thinkingLvl) || thinkingLvl;
    commitThinkingLevel(normalized);
    if (targetOrchLeaf && activeLeaf?.key !== targetOrchLeaf.key) {
      onSelectModel(targetOrchLeaf.selection.requestedModel);
    }
    closePicker(true);
  };

  const stepBack = () => {
    setLevel((prev) => {
      const next = prev === 2 ? 1 : 0;
      requestAnimationFrame(() => {
        const pane = paneRefs.current[next];
        if (!pane) return;
        const parentKey = lastParentKeyRef.current;
        const target = parentKey
          ? (pane.querySelector(`[data-node-key="${CSS.escape ? CSS.escape(parentKey) : parentKey}"]`) as HTMLElement | null)
          : null;
        (target || (pane.querySelector('button:not(:disabled)') as HTMLElement | null))?.focus();
      });
      return next;
    });
  };

  const handlePaneKeyDown = (paneIndex: 0 | 1 | 2) => (ev: React.KeyboardEvent<HTMLDivElement>) => {
    const pane = paneRefs.current[paneIndex];
    if (!pane) return;
    const focusables = Array.from(
      pane.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]:not(:disabled), button[data-node-key]:not(:disabled)'),
    );
    const activeEl = document.activeElement as HTMLButtonElement | null;
    const currentIdx = activeEl ? focusables.indexOf(activeEl) : -1;

    if (ev.key === 'ArrowDown') {
      if (focusables.length === 0) return;
      ev.preventDefault();
      const nextIdx = currentIdx < 0 ? 0 : (currentIdx + 1) % focusables.length;
      focusables[nextIdx]?.focus();
      return;
    }
    if (ev.key === 'ArrowUp') {
      if (focusables.length === 0) return;
      ev.preventDefault();
      const prevIdx = currentIdx < 0 ? focusables.length - 1 : (currentIdx - 1 + focusables.length) % focusables.length;
      focusables[prevIdx]?.focus();
      return;
    }
    if (ev.key === 'ArrowRight') {
      if (activeEl && activeEl.dataset.nodeKind === 'branch') {
        ev.preventDefault();
        activeEl.click();
      }
      return;
    }
    if ((ev.key === 'ArrowLeft' || ev.key === 'Backspace') && paneIndex > 0) {
      ev.preventDefault();
      stepBack();
    }
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

  const isOrchBranch = activeBranch?.role === 'orchestrator_root';

  return (
    <div ref={rootRef} className={styles.picker} data-testid="composer-model-picker">
      <button
        ref={triggerRef}
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
          data-level={level}
          data-transition-ms={transitionMs}
          data-testid="model-picker-popover"
          style={
            {
              '--picker-level': String(level),
              '--picker-duration': `${transitionMs}ms`,
            } as React.CSSProperties
          }
        >
          <div className={styles.slideTrack} data-testid="model-picker-slide-track">
            <div
              ref={(el) => {
                paneRefs.current[0] = el;
              }}
              className={`${styles.pane} ${level === 0 ? styles.paneActive : styles.paneInactive}`}
              aria-hidden={level !== 0}
              onKeyDown={handlePaneKeyDown(0)}
              data-testid="model-picker-primary"
            >
              <div className={styles.paneHeader}>
                <span className={styles.secondaryTitle}>{t('models.pickerTitle')}</span>
              </div>
              {effectiveTree.nodes.map((node) => {
                const isBranch = node.kind === 'branch';
                const containsSelected =
                  node.kind === 'leaf'
                    ? activeLeaf?.key === node.key
                    : activeMatch?.branch?.key === node.key;
                const isHighlighted = isBranch && activeBranch?.key === node.key && level > 0;

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
                    tabIndex={level === 0 ? 0 : -1}
                    disabled={node.disabled}
                    className={[
                      styles.row,
                      containsSelected ? styles.rowSelected : '',
                      isHighlighted ? styles.rowHighlighted : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => {
                      if (node.kind === 'leaf') {
                        handleSelectLeaf(node);
                      } else {
                        lastParentKeyRef.current = node.key;
                        setActiveBranchKey(node.key);
                        setLevel(1);
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
            </div>

            <div
              ref={(el) => {
                paneRefs.current[1] = el;
              }}
              className={`${styles.pane} ${level === 1 ? styles.paneActive : styles.paneInactive}`}
              aria-hidden={level !== 1}
              onKeyDown={handlePaneKeyDown(1)}
              data-testid="model-picker-secondary"
            >
              <div className={styles.navBar}>
                <button
                  type="button"
                  tabIndex={level === 1 ? 0 : -1}
                  className={styles.backBtn}
                  onClick={stepBack}
                  data-testid="model-picker-back-1"
                >
                  ‹ {t('models.back')}
                </button>
              </div>

              {activeBranch && (
                <>
                  <div className={styles.secondaryHeader}>
                    <span className={styles.secondaryTitle}>
                      {isOrchBranch
                        ? t('models.orchestratorPresetsTitle')
                        : `${activeBranch.label} · ${t('models.thinkingLevelTitle')}`}
                    </span>
                    {isOrchBranch && (
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
                      isOrchBranch && isSelected
                        ? resolveOrchestratorSecondaryLabel(child, previewOrchThinkingLevel)
                        : child.secondaryLabel;
                    const hasLevel3 =
                      isOrchBranch &&
                      (!child.supportedThinkingLevels || child.supportedThinkingLevels.length !== 1);

                    return (
                      <button
                        key={child.key}
                        type="button"
                        role="menuitemradio"
                        tabIndex={level === 1 ? 0 : -1}
                        aria-checked={isSelected}
                        disabled={child.disabled}
                        className={`${styles.row} ${isSelected ? styles.rowSelected : ''}`}
                        onClick={() => handleSelectLeaf(child)}
                        data-node-key={child.key}
                        data-node-kind={hasLevel3 ? 'branch' : 'leaf'}
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
                          {hasLevel3 && (
                            <span className={styles.chevron} aria-hidden="true">
                              ›
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </>
              )}
            </div>

            <div
              ref={(el) => {
                paneRefs.current[2] = el;
              }}
              className={`${styles.pane} ${level === 2 ? styles.paneActive : styles.paneInactive}`}
              aria-hidden={level !== 2}
              onKeyDown={handlePaneKeyDown(2)}
              data-testid="orch-thinking-selector"
            >
              <div className={styles.navBar}>
                <button
                  type="button"
                  tabIndex={level === 2 ? 0 : -1}
                  className={styles.backBtn}
                  onClick={stepBack}
                  data-testid="model-picker-back-2"
                >
                  ‹ {t('models.back')}
                </button>
              </div>

              <div className={styles.secondaryHeader}>
                <span className={styles.secondaryTitle}>
                  {targetOrchLeaf
                    ? t('models.level3Title', { model: targetOrchLeaf.label })
                    : t('models.thinkingLevelConfig')}
                </span>
              </div>

              {orchSupportedThinkingLevels.map((lvl) => {
                const isChecked = previewOrchThinkingLevel === lvl;
                return (
                  <button
                    key={lvl}
                    type="button"
                    role="menuitemradio"
                    tabIndex={level === 2 ? 0 : -1}
                    aria-checked={isChecked}
                    className={`${styles.row} ${isChecked ? styles.rowSelected : ''}`}
                    onClick={() => handleSelectOrchThinking(lvl)}
                    data-testid={`orch-thinking-level-${lvl}`}
                    data-selected={isChecked ? 'true' : 'false'}
                  >
                    <span className={styles.rowMain}>
                      <span className={styles.rowLabel}>{localizeThinkingSuffixLabel(lvl, t)}</span>
                    </span>
                    <span className={styles.rowEnd}>
                      {isChecked && <span className={styles.checkMark}>✓</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
