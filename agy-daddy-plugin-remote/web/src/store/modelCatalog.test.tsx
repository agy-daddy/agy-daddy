import { fireEvent, render, screen } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from '../chat/Composer';
import { ModelPickerSheet } from '../chat/ModelPickerSheet';
import { sanitizePresets } from './useRemoteStore';
import {
  applyModelPreferences,
  formatCompactModelBadge,
  groupModelsForPicker,
  normalizeModelCatalog,
  reconcileOrchestratorThinkingMap,
  resolveMasterThinkingTier,
  resolveUnifiedModelName
} from './modelCatalog';
import type { ModelCatalogTree, ModelOption } from '../types';

const REALISTIC_MODELS: ModelOption[] = [
  { id: 'MODEL_PLACEHOLDER_M18', label: 'MODEL_PLACEHOLDER_M18' }, // should be dropped
  { id: 'MODEL_PLACEHOLDER_M19' }, // no label, should be dropped
  { id: 'MODEL_PLACEHOLDER_M537', label: 'Gemini 4 Neon (High)', isDefault: true },
  { id: 'MODEL_PLACEHOLDER_M538', label: 'Gemini 4 Neon (Medium)' },
  { id: 'MODEL_PLACEHOLDER_M539', label: 'Gemini 4 Neon (Low)' },
  { id: 'MODEL_PLACEHOLDER_M540', label: 'Gemini 4 Neon (XHigh)' },
  { id: 'MODEL_PLACEHOLDER_M501', label: 'Claude Opus 5.5 (High)' },
  { id: 'MODEL_PLACEHOLDER_M502', label: 'Claude Opus 5.5 (Medium)' },
  { id: 'MODEL_PLACEHOLDER_M503', label: 'Claude Opus 5.5 (Low)' },
  { id: 'MODEL_PLACEHOLDER_M601', label: 'Orchestrator (Carbon)' },
  { id: 'gemini-pro-orchestrator-argon', label: 'Orchestrator (Argon)' },
  { id: 'MODEL_PLACEHOLDER_M603', label: 'Orchestrator (Neon)' },
  { id: 'gpt-oss-120b', label: 'GPT-OSS 120B' }
];

describe('modelCatalog', () => {
  it('preserves all real MODEL_PLACEHOLDER_* models with human labels and drops bare placeholders', () => {
    const normalized = normalizeModelCatalog(REALISTIC_MODELS);
    expect(normalized).toHaveLength(11);
    expect(normalized.some((m) => m.id === 'MODEL_PLACEHOLDER_M18')).toBe(false);
    expect(normalized.some((m) => m.id === 'MODEL_PLACEHOLDER_M19')).toBe(false);
    expect(normalized.some((m) => m.id === 'MODEL_PLACEHOLDER_M537')).toBe(true);
    expect(normalized.some((m) => m.id === 'MODEL_PLACEHOLDER_M601')).toBe(true);
  });

  it('aggregates thinking tiers into family groups and orchestrator models into one group', () => {
    const groups = groupModelsForPicker(REALISTIC_MODELS);
    const neonGroup = groups.find((g) => g.name === 'Gemini 4 Neon');
    expect(neonGroup).toBeDefined();
    expect(neonGroup?.hasSubLevels).toBe(true);
    expect(neonGroup?.variants.map((v) => v.tierLabel)).toEqual(['Low', 'Medium', 'High', 'XHigh']);

    const opusGroup = groups.find((g) => g.name === 'Claude Opus 5.5');
    expect(opusGroup).toBeDefined();
    expect(opusGroup?.variants.map((v) => v.tierLabel)).toEqual(['Low', 'Medium', 'High']);

    const orchGroup = groups.find((g) => g.isOrchestrator);
    expect(orchGroup).toBeDefined();
    expect(orchGroup?.name).toBe('编排模型');
    expect(orchGroup?.variants.map((v) => v.tierLabel)).toEqual(['Carbon', 'Argon', 'Neon']);

    const standalone = groups.find((g) => g.name === 'GPT-OSS 120B');
    expect(standalone?.hasSubLevels).toBe(false);
  });

  it('resolves MODEL_PLACEHOLDER telemetry IDs and formats compact badges cleanly', () => {
    const unified = resolveUnifiedModelName(
      { context: { available: true, data: { used: 1000, budget: 100000, model: 'MODEL_PLACEHOLDER_M537' } } },
      REALISTIC_MODELS,
      'MODEL_PLACEHOLDER_M501'
    );
    expect(unified).toBe('Gemini 4 Neon (High)');

    const neonBadge = formatCompactModelBadge('MODEL_PLACEHOLDER_M537', REALISTIC_MODELS);
    expect(neonBadge.shortName).toBe('4 Neon');
    expect(neonBadge.tag).toBe('High');

    const orchBadge = formatCompactModelBadge('MODEL_PLACEHOLDER_M601', REALISTIC_MODELS);
    expect(orchBadge.shortName).toBe('编排');
    expect(orchBadge.tag).toBe('Carbon');
    expect(orchBadge.isOrchestrator).toBe(true);
  });

  it('strips trailing thinking suffix defensively even when explicitFamily contains one', () => {
    const models: ModelOption[] = [
      { id: 'm1', label: 'Gemini 4 Neon (High)', family: 'Gemini 4 Neon', thinkingLevel: 'high' },
      { id: 'm2', label: 'Gemini 4 Neon (XHigh)', family: 'Gemini 4 Neon (XHigh)', thinkingLevel: null }
    ];
    const groups = groupModelsForPicker(models);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('Gemini 4 Neon');
    expect(groups[0].variants.map((v) => v.tierLabel)).toEqual(['High', 'XHigh']);

    const badge = formatCompactModelBadge('m2', models);
    expect(badge.name).toBe('Gemini 4 Neon');
    expect(badge.shortName).toBe('4 Neon');
    expect(badge.tag).toBe('XHigh');
    expect(badge.full).toBe('Gemini 4 Neon · XHigh');
  });
});

describe('ModelPickerSheet right-slide multi-stage interaction', () => {
  const COMPOSITE_MODELS: ModelOption[] = [
    { id: 'neon-low', label: 'Gemini 4 Neon (Low)' },
    { id: 'neon-high', label: 'Gemini 4 Neon (High)', isDefault: true },
    { id: 'orch-carbon-low', label: 'Orchestrator (Carbon - Low)' },
    { id: 'orch-carbon-high', label: 'Orchestrator (Carbon - High)' },
    { id: 'orch-argon-med', label: 'Gemini 4 Argon Orchestrator (Medium)' },
    { id: 'gpt-oss', label: 'GPT-OSS 120B' }
  ];

  it('slides right only for multi-tier models/masters and selects single-tier items directly', () => {
    const onSelectModel = vi.fn();
    const onSelectOrchestrator = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(
      <ModelPickerSheet
        open={true}
        models={COMPOSITE_MODELS}
        selectedModelId="neon-high"
        orchestratorThinking={{ carbon: 'high', argon: 'low', neon: 'medium', 'opus5.5': 'xhigh' }}
        activeOrchestratorMaster={null}
        onSelectModel={onSelectModel}
        onSelectOrchestrator={onSelectOrchestrator}
        onClose={onClose}
      />
    );

    const track = screen.getByTestId('model-picker-track');
    expect(track.getAttribute('data-depth')).toBe('0');

    // Stage 0 -> tap Gemini 4 Neon (2 tiers: Low, High) -> slides right to Stage 1
    fireEvent.click(screen.getByTestId('model-group-family:gemini 4 neon').querySelector('button')!);
    expect(track.getAttribute('data-depth')).toBe('1');
    const neonButtons = track.querySelectorAll('section[aria-hidden="false"] [role="radio"]');
    expect(neonButtons).toHaveLength(2);
    fireEvent.click(screen.getByTestId('model-variant-neon-low'));
    expect(onSelectModel).toHaveBeenCalledWith('neon-low');
    expect(onClose).toHaveBeenCalledTimes(1);

    // Re-open and test Orchestrator actual masters (only carbon & argon exist in COMPOSITE_MODELS)
    rerender(
      <ModelPickerSheet
        open={false}
        models={COMPOSITE_MODELS}
        selectedModelId="neon-high"
        orchestratorThinking={{ carbon: 'high', argon: 'low', neon: 'medium', 'opus5.5': 'xhigh' }}
        onSelectModel={onSelectModel}
        onSelectOrchestrator={onSelectOrchestrator}
        onClose={onClose}
      />
    );
    rerender(
      <ModelPickerSheet
        open={true}
        models={COMPOSITE_MODELS}
        selectedModelId="neon-high"
        orchestratorThinking={{ carbon: 'high', argon: 'low', neon: 'medium', 'opus5.5': 'xhigh' }}
        onSelectModel={onSelectModel}
        onSelectOrchestrator={onSelectOrchestrator}
        onClose={onClose}
      />
    );

    const track2 = screen.getByTestId('model-picker-track');
    expect(track2.getAttribute('data-depth')).toBe('0');

    // 1st slide: Orchestrator -> strictly existing masters (carbon: 2 tiers, argon: 1 tier)
    fireEvent.click(screen.getByTestId('model-group-orchestrator').querySelector('button')!);
    expect(track2.getAttribute('data-depth')).toBe('1');
    expect(screen.getByTestId('model-master-master:carbon')).toBeInTheDocument();
    expect(screen.getByTestId('model-master-master:argon')).toBeInTheDocument();
    expect(screen.queryByTestId('model-master-master:neon')).toBeNull();
    expect(screen.queryByTestId('model-master-master:opus5.5')).toBeNull();
    expect(screen.getByTestId('master-tier-carbon')).toHaveTextContent('High');
    // Argon only supports 'medium' -> stale 'low' smoothly falls back to 'Med'
    expect(screen.getByTestId('master-tier-argon')).toHaveTextContent('Med');

    // 2nd slide: Master "Carbon" -> strictly 2 thinking levels (Low, High)
    fireEvent.click(screen.getByTestId('model-master-master:carbon').querySelector('button')!);
    expect(track2.getAttribute('data-depth')).toBe('2');
    expect(screen.getByTestId('model-variant-orch-carbon-low')).toBeInTheDocument();
    expect(screen.getByTestId('model-variant-orch-carbon-high')).toBeInTheDocument();
    const carbonTierButtons = track2.querySelectorAll('section[aria-hidden="false"] [role="radio"]');
    expect(carbonTierButtons).toHaveLength(2);

    // Back button steps back 2 -> 1 -> 0
    fireEvent.click(screen.getByTestId('model-picker-back'));
    expect(track2.getAttribute('data-depth')).toBe('1');
    fireEvent.click(screen.getByTestId('model-picker-back'));
    expect(track2.getAttribute('data-depth')).toBe('0');

    // Escape closes from depth 0, or steps back from depth > 0
    fireEvent.click(screen.getByTestId('model-group-orchestrator').querySelector('button')!);
    fireEvent.click(screen.getByTestId('model-master-master:carbon').querySelector('button')!);
    expect(track2.getAttribute('data-depth')).toBe('2');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(track2.getAttribute('data-depth')).toBe('1');

    // Confirm Master "Carbon" -> Low
    fireEvent.click(screen.getByTestId('model-master-master:carbon').querySelector('button')!);
    fireEvent.click(screen.getByTestId('model-variant-orch-carbon-low'));
    expect(onSelectOrchestrator).toHaveBeenCalledWith('orch-carbon-low', 'carbon', 'low');
    expect(onClose).toHaveBeenCalledTimes(2);

    // Reopen and tap single-tier Argon -> selects directly without sliding to Stage 2
    rerender(
      <ModelPickerSheet
        open={true}
        models={COMPOSITE_MODELS}
        selectedModelId="orch-carbon-low"
        orchestratorThinking={{ carbon: 'low', argon: 'low', neon: 'medium', 'opus5.5': 'xhigh' }}
        activeOrchestratorMaster="carbon"
        onSelectModel={onSelectModel}
        onSelectOrchestrator={onSelectOrchestrator}
        onClose={onClose}
      />
    );
    expect(screen.getByTestId('master-tier-carbon')).toHaveTextContent('Low');
    expect(screen.getByTestId('master-tier-argon')).toHaveTextContent('Med');
    fireEvent.click(screen.getByTestId('model-master-master:argon').querySelector('button')!);
    expect(onSelectOrchestrator).toHaveBeenCalledWith('orch-argon-med', 'argon', 'medium');
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('selects standalone models without sub-levels directly on tap', () => {
    const onSelectModel = vi.fn();
    const onClose = vi.fn();
    render(
      <ModelPickerSheet
        open={true}
        models={COMPOSITE_MODELS}
        selectedModelId="neon-high"
        onSelectModel={onSelectModel}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByTestId('model-group-family:gpt-oss 120b').querySelector('button')!);
    expect(onSelectModel).toHaveBeenCalledWith('gpt-oss');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('derives strictly actual master variants without padding and applies filter & sort preferences', () => {
    const groups = groupModelsForPicker(COMPOSITE_MODELS);
    const orch = groups.find((g) => g.isOrchestrator);
    expect(orch?.masterGroups?.map((m) => m.masterKey)).toEqual(['carbon', 'argon']);
    const carbon = orch?.masterGroups?.find((m) => m.masterKey === 'carbon');
    expect(carbon?.variants.map((v) => v.tierKey)).toEqual(['low', 'high']);
    const argon = orch?.masterGroups?.find((m) => m.masterKey === 'argon');
    expect(argon?.variants.map((v) => v.tierKey)).toEqual(['medium']);
    expect(argon?.hasSubLevels).toBe(false);

    const badge = formatCompactModelBadge('orch-carbon-high', COMPOSITE_MODELS, undefined, {
      master: 'opus5.5',
      thinkingMap: { carbon: 'low', argon: 'medium', neon: 'high', 'opus5.5': 'xhigh' }
    });
    expect(badge.shortName).toBe('编排');
    expect(badge.tag).toBe('Opus 5.5 · XHigh');

    // Filtering out gpt-oss and sorting by name_desc / frequency / custom
    const filteredDesc = applyModelPreferences(groups, {
      sortMode: 'name_desc',
      filterOrder: ['!family:gpt-oss 120b']
    });
    expect(filteredDesc.some((g) => g.id === 'family:gpt-oss 120b')).toBe(false);
    expect(filteredDesc[0].name.localeCompare(filteredDesc[1].name, 'zh-CN')).toBeGreaterThanOrEqual(0);

    const sortedFreq = applyModelPreferences(groups, {
      sortMode: 'frequency',
      filterOrder: [],
      usageCounts: { 'gpt-oss': 99 }
    });
    expect(sortedFreq[0].id).toBe('family:gpt-oss 120b');

    const sortedCustom = applyModelPreferences(groups, {
      sortMode: 'custom',
      filterOrder: ['orchestrator', 'family:gpt-oss 120b']
    });
    expect(sortedCustom.map((g) => g.id).slice(0, 2)).toEqual(['orchestrator', 'family:gpt-oss 120b']);
  });

  it('renders 1/2/3/4 thinking tiers accurately from modelTree & supportedThinkingLevels and reconciles stale orchestratorThinking', () => {
    const mixedModels: ModelOption[] = [
      {
        id: 'gpt-oss-120b',
        label: 'GPT-OSS 120B',
        supportedThinkingLevels: []
      },
      {
        id: 'sonnet-high',
        label: 'Claude Sonnet 4.6 (High)',
        supportedThinkingLevels: ['high']
      },
      {
        id: 'neon-med',
        label: 'Gemini 4 Neon (Medium)',
        supportedThinkingLevels: ['medium', 'high']
      },
      {
        id: 'neon-high',
        label: 'Gemini 4 Neon (High)',
        supportedThinkingLevels: ['medium', 'high']
      },
      {
        id: 'opus-low',
        label: 'Claude Opus 5.5 (Low)',
        supportedThinkingLevels: ['low', 'medium', 'high']
      },
      {
        id: 'opus-med',
        label: 'Claude Opus 5.5 (Medium)',
        supportedThinkingLevels: ['low', 'medium', 'high']
      },
      {
        id: 'opus-high',
        label: 'Claude Opus 5.5 (High)',
        supportedThinkingLevels: ['low', 'medium', 'high']
      },
      {
        id: 'pro-low',
        label: 'Gemini 4 Pro (Low)',
        supportedThinkingLevels: ['low', 'medium', 'high', 'xhigh']
      },
      {
        id: 'pro-med',
        label: 'Gemini 4 Pro (Medium)',
        supportedThinkingLevels: ['low', 'medium', 'high', 'xhigh']
      },
      {
        id: 'pro-high',
        label: 'Gemini 4 Pro (High)',
        supportedThinkingLevels: ['low', 'medium', 'high', 'xhigh']
      },
      {
        id: 'pro-xhigh',
        label: 'Gemini 4 Pro (XHigh)',
        supportedThinkingLevels: ['low', 'medium', 'high', 'xhigh']
      },
      {
        id: 'orch-carbon',
        label: 'Orchestrator (Carbon)',
        isOrchestrator: true,
        orchestratorMaster: 'Carbon',
        supportedThinkingLevels: ['medium', 'high']
      },
      {
        id: 'orch-argon',
        label: 'Orchestrator (Argon)',
        isOrchestrator: true,
        orchestratorMaster: 'Argon',
        supportedThinkingLevels: ['high']
      },
      {
        id: 'orch-neon',
        label: 'Orchestrator (Neon)',
        isOrchestrator: true,
        orchestratorMaster: 'Neon',
        supportedThinkingLevels: ['low', 'medium', 'high', 'xhigh']
      }
    ];

    const mixedTree: ModelCatalogTree = {
      supportsCustomOrchestrator: true,
      nodes: [
        {
          kind: 'branch',
          key: 'orch',
          role: 'orchestrator_root',
          label: 'Orchestrator',
          children: [
            {
              kind: 'leaf',
              key: 'orch/gemini-4-carbon',
              role: 'planner_model',
              label: 'Carbon',
              supportedThinkingLevels: ['medium', 'high'],
              defaultThinkingSuffix: 'high',
              selection: {
                mode: 'orchestrator_preset',
                requestedModel: 'orch-carbon',
                plannerFamilyId: 'gemini-4-carbon'
              }
            },
            {
              kind: 'leaf',
              key: 'orch/gemini-4-argon',
              role: 'planner_model',
              label: 'Argon',
              supportedThinkingLevels: ['high'],
              defaultThinkingSuffix: 'high',
              selection: {
                mode: 'orchestrator_preset',
                requestedModel: 'orch-argon',
                plannerFamilyId: 'gemini-4-argon'
              }
            },
            {
              kind: 'leaf',
              key: 'orch/gemini-4-neon',
              role: 'planner_model',
              label: 'Neon',
              supportedThinkingLevels: ['low', 'medium', 'high', 'xhigh'],
              defaultThinkingSuffix: 'high',
              selection: {
                mode: 'orchestrator_preset',
                requestedModel: 'orch-neon',
                plannerFamilyId: 'gemini-4-neon'
              }
            },
            {
              kind: 'leaf',
              key: 'orch/claude-opus-5-5',
              role: 'planner_model',
              label: 'Claude Opus 5.5',
              supportedThinkingLevels: ['low', 'medium', 'high'],
              defaultThinkingSuffix: 'high',
              selection: {
                mode: 'orchestrator_preset',
                requestedModel: 'orchestrator:claude-opus-5-5',
                plannerFamilyId: 'claude-opus-5-5'
              }
            }
          ]
        }
      ]
    };

    const groups = groupModelsForPicker(mixedModels, undefined, undefined, mixedTree);

    // Normal models: 1-tier/0-tier (no sublevels), 2-tier, 3-tier, 4-tier
    expect(groups.find((g) => g.name === 'GPT-OSS 120B')?.hasSubLevels).toBe(false);
    expect(groups.find((g) => g.name === 'Claude Sonnet 4.6')?.hasSubLevels).toBe(false);
    expect(groups.find((g) => g.name === 'Gemini 4 Neon')?.variants.map((v) => v.tierKey)).toEqual([
      'medium',
      'high'
    ]);
    expect(groups.find((g) => g.name === 'Claude Opus 5.5')?.variants.map((v) => v.tierKey)).toEqual([
      'low',
      'medium',
      'high'
    ]);
    expect(groups.find((g) => g.name === 'Gemini 4 Pro')?.variants.map((v) => v.tierKey)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh'
    ]);

    // Orchestrator masters: strictly 2, 1, 4, 3 tiers
    const orchGroup = groups.find((g) => g.isOrchestrator);
    expect(orchGroup?.masterGroups?.map((m) => [m.masterKey, m.variants.map((v) => v.tierKey)])).toEqual([
      ['carbon', ['medium', 'high']],
      ['argon', ['high']],
      ['neon', ['low', 'medium', 'high', 'xhigh']],
      ['opus5.5', ['low', 'medium', 'high']]
    ]);

    // Reconcile stale/unsupported saved orchestratorThinking values
    const reconciled = reconcileOrchestratorThinkingMap(
      { carbon: 'xhigh', argon: 'low', neon: 'xhigh', 'opus5.5': 'xhigh' },
      groups
    );
    expect(reconciled).toEqual({
      carbon: 'high',
      argon: 'high',
      neon: 'xhigh',
      'opus5.5': 'high'
    });

    const carbonMaster = orchGroup?.masterGroups?.find((m) => m.masterKey === 'carbon');
    expect(resolveMasterThinkingTier(carbonMaster, 'low')).toBe('high');

    // Compact badge falls back smoothly when stale tier is passed
    const carbonBadge = formatCompactModelBadge(
      'orch-carbon',
      mixedModels,
      undefined,
      {
        master: 'carbon',
        thinkingMap: { carbon: 'xhigh', argon: 'low', neon: 'xhigh', 'opus5.5': 'xhigh' }
      },
      mixedTree
    );
    expect(carbonBadge.tag).toBe('Carbon · High');

    // Render ModelPickerSheet and inspect actual rendered tier counts
    const onSelectModel = vi.fn();
    const onSelectOrchestrator = vi.fn();
    render(
      <ModelPickerSheet
        open={true}
        models={mixedModels}
        modelTree={mixedTree}
        selectedModelId="neon-high"
        orchestratorThinking={{ carbon: 'xhigh', argon: 'low', neon: 'xhigh', 'opus5.5': 'xhigh' }}
        activeOrchestratorMaster="carbon"
        onSelectModel={onSelectModel}
        onSelectOrchestrator={onSelectOrchestrator}
        onClose={vi.fn()}
      />
    );

    // Stage 0 -> single-tier Claude Sonnet selects directly without sliding
    fireEvent.click(screen.getByTestId('model-group-family:claude sonnet 4.6').querySelector('button')!);
    expect(onSelectModel).toHaveBeenCalledWith('sonnet-high');

    // Stage 0 -> Gemini 4 Neon shows 2 tiers
    fireEvent.click(screen.getByTestId('model-group-family:gemini 4 neon').querySelector('button')!);
    const track = screen.getByTestId('model-picker-track');
    expect(track.querySelectorAll('section[aria-hidden="false"] [role="radio"]')).toHaveLength(2);
    fireEvent.click(screen.getByTestId('model-picker-back'));

    // Stage 0 -> Orchestrator -> Carbon (2 tiers, reconciled High checked)
    fireEvent.click(screen.getByTestId('model-group-orchestrator').querySelector('button')!);
    expect(screen.getByTestId('master-tier-carbon')).toHaveTextContent('High');
    expect(screen.getByTestId('master-tier-opus5.5')).toHaveTextContent('High');
    fireEvent.click(screen.getByTestId('model-master-master:carbon').querySelector('button')!);
    const carbonRadios = track.querySelectorAll('section[aria-hidden="false"] [role="radio"]');
    expect(carbonRadios).toHaveLength(2);
    expect(track.querySelector('section[aria-hidden="false"] [data-tier="high"]')).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(track.querySelector('section[aria-hidden="false"] [data-tier="medium"]')).toHaveAttribute(
      'aria-checked',
      'false'
    );
    fireEvent.click(screen.getByTestId('model-picker-back'));

    // Opus 5.5 (3 tiers from modelTree synthetic leaf)
    fireEvent.click(screen.getByTestId('model-master-master:opus5.5').querySelector('button')!);
    const opusRadios = track.querySelectorAll('section[aria-hidden="false"] [role="radio"]');
    expect(opusRadios).toHaveLength(3);
    fireEvent.click(screen.getByTestId('model-orch-tier-opus5.5-medium'));
    expect(onSelectOrchestrator).toHaveBeenCalledWith(
      'orchestrator:claude-opus-5-5',
      'opus5.5',
      'medium'
    );
  });

  it('highlights at most one group in Stage 0 even when activeOrchestratorMaster coincides with a family model id', () => {
    const onSelectModel = vi.fn();
    const onClose = vi.fn();
    render(
      <ModelPickerSheet
        open={true}
        models={COMPOSITE_MODELS}
        selectedModelId="neon-high"
        activeOrchestratorMaster="neon"
        orchestratorThinking={{ carbon: 'high', argon: 'high', neon: 'medium', 'opus5.5': 'high' }}
        onSelectModel={onSelectModel}
        onClose={onClose}
      />
    );

    const orchCard = screen.getByTestId('model-group-orchestrator');
    const neonCard = screen.getByTestId('model-group-family:gemini 4 neon');
    expect(orchCard.className).toContain('groupCardActive');
    expect(neonCard.className).not.toContain('groupCardActive');
    const activeCards = screen
      .getByTestId('model-picker-track')
      .querySelectorAll('[data-testid^="model-group-"]');
    const highlighted = Array.from(activeCards).filter((el) =>
      el.className.includes('groupCardActive')
    );
    expect(highlighted).toHaveLength(1);
  });

  it('does not render remaining quota percentage in thinking level rows and uses consistent tier highlight styling', () => {
    const modelsWithQuota: ModelOption[] = [
      {
        id: 'neon-low',
        label: 'Gemini 4 Neon (Low)',
        quotaInfo: { remainingPercent: 85, remainingFraction: 0.85 }
      },
      {
        id: 'neon-high',
        label: 'Gemini 4 Neon (High)',
        quotaInfo: { remainingPercent: 42, remainingFraction: 0.42 }
      }
    ];
    render(
      <ModelPickerSheet
        open={true}
        models={modelsWithQuota}
        selectedModelId="neon-high"
        onSelectModel={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId('model-group-family:gemini 4 neon').querySelector('button')!);
    const activeVariant = screen.getByTestId('model-variant-neon-high');
    expect(activeVariant.className).toContain('tierCardActive');
    expect(activeVariant).toHaveAttribute('aria-checked', 'true');
    expect(activeVariant).toHaveTextContent('当前');
    expect(activeVariant).toHaveTextContent('✓');

    const sheet = screen.getByTestId('model-picker-sheet');
    expect(sheet).not.toHaveTextContent('85%');
    expect(sheet).not.toHaveTextContent('42%');
  });
});

describe('Composer redesigned layout', () => {
  const makeProps = () => ({
    text: '',
    images: [],
    presets: [{ id: 'p1', label: '代码审查', prompt: '请审查变更' }],
    models: REALISTIC_MODELS,
    selectedModelId: 'MODEL_PLACEHOLDER_M537',
    chatMode: 'chat' as const,
    permissionLevel: 'L1' as const,
    running: false,
    voiceSupported: false,
    onTextChange: vi.fn(),
    onAddImage: vi.fn(),
    onRemoveImage: vi.fn(),
    onModelChange: vi.fn(),
    onChatModeChange: vi.fn(),
    onSend: vi.fn(),
    onCancel: vi.fn(),
    onOptimize: vi.fn().mockResolvedValue(undefined)
  });

  it('places all controls inside composer-card with 3-line textarea, merges Plan into presets, and removes Queue/Steer toggle', () => {
    const props = makeProps();
    render(<Composer {...props} />);

    const card = screen.getByTestId('composer-card');
    const ta = screen.getByTestId('composer-textarea') as HTMLTextAreaElement;
    expect(ta.rows).toBe(3);

    // All key controls reside inside the unified card
    expect(card.contains(screen.getByTestId('composer-attach-btn'))).toBe(true);
    expect(card.contains(screen.getByTestId('composer-presets-btn'))).toBe(true);
    expect(card.contains(screen.getByTestId('composer-model-btn'))).toBe(true);
    expect(card.contains(screen.getByTestId('composer-permission-btn'))).toBe(true);
    expect(card.contains(screen.getByTestId('composer-optimize-btn'))).toBe(true);
    expect(card.contains(screen.getByTestId('composer-send-btn'))).toBe(true);

    // Queue/Steer toggle button is removed from composer toolbar
    expect(screen.queryByText(/Queue 排队|Steer 插话/)).toBeNull();

    // Open / 快捷词 popover -> toggle Plan mode
    fireEvent.click(screen.getByTestId('composer-presets-btn'));
    const planToggle = screen.getByTestId('presets-plan-toggle');
    fireEvent.click(planToggle);
    expect(props.onChatModeChange).toHaveBeenCalledWith('plan');

    // Open permission popover
    fireEvent.click(screen.getByTestId('composer-permission-btn'));
    expect(screen.getByTestId('permission-popover')).toHaveTextContent('L1');
  });

  it('shows dismissible Plan chip inside card when chatMode is plan', () => {
    const props = makeProps();
    render(<Composer {...props} chatMode="plan" />);
    const chip = screen.getByTestId('composer-plan-chip');
    expect(chip).toHaveTextContent('Plan 规划模式');
    fireEvent.click(screen.getByLabelText('退出 Plan 模式'));
    expect(props.onChatModeChange).toHaveBeenCalledWith('chat');
  });

  it('filters duplicate /plan shortcut entries while preserving Plan mode toggle and deduplicating presets', () => {
    const sanitized = sanitizePresets([
      { id: 'plan', label: '规划模式', prompt: '/plan' },
      { id: 'compact', label: '压缩上下文', prompt: '/compact' },
      { id: 'compact-dup', label: '压缩上下文', prompt: '/compact' },
      '/plan'
    ]);
    expect(sanitized).toHaveLength(1);
    expect(sanitized[0].prompt).toBe('/compact');

    const props = {
      ...makeProps(),
      text: '/',
      presets: [
        { id: 'plan', label: '规划模式', prompt: '/plan' },
        { id: 'compact', label: '压缩上下文', prompt: '/compact' }
      ]
    };
    render(<Composer {...props} />);
    fireEvent.click(screen.getByTestId('composer-presets-btn'));
    const pop = screen.getByTestId('presets-popover');
    expect(pop).toHaveTextContent('Plan 规划模式');
    expect(pop).toHaveTextContent('/compact');
    expect(pop).not.toHaveTextContent('/plan');

    fireEvent.click(screen.getByTestId('presets-plan-toggle'));
    expect(props.onTextChange).toHaveBeenCalledWith('');
    expect(props.onChatModeChange).toHaveBeenCalledWith('plan');
  });
});
