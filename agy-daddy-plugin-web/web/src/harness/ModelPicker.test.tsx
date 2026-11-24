import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import type { ModelCatalogTree, ModelItem } from '../types';
import { ModelPicker } from './ModelPicker';

const SAMPLE_MODELS: ModelItem[] = [
  {
    id: 'MODEL_PLACEHOLDER_M533',
    model: 'MODEL_PLACEHOLDER_M533',
    modelId: 'gemini-4-neon-medium',
    label: 'Gemini 4 Neon (Medium)',
    displayName: 'Gemini 4 Neon (Medium)',
    maxTokens: 1048576,
    disabled: false,
    supportsImages: true,
    isDefault: true,
    tagTitle: 'New',
    quotaInfo: { remainingFraction: 0.9 },
  },
  {
    id: 'MODEL_PLACEHOLDER_M532',
    model: 'MODEL_PLACEHOLDER_M532',
    modelId: 'gemini-4-neon-high',
    label: 'Gemini 4 Neon (High)',
    displayName: 'Gemini 4 Neon (High)',
    maxTokens: 1048576,
    disabled: false,
    supportsImages: true,
    isDefault: false,
    tagTitle: 'New',
    quotaInfo: { remainingFraction: 0.9 },
  },
  {
    id: 'MODEL_PLACEHOLDER_M537',
    model: 'MODEL_PLACEHOLDER_M537',
    modelId: 'gemini-pro-orchestrator-neon',
    label: 'Orchestrator (Neon)',
    displayName: 'Orchestrator (Neon)',
    maxTokens: 1048576,
    disabled: false,
    supportsImages: true,
    isDefault: false,
    tagTitle: 'New',
    quotaInfo: { remainingFraction: 0.9 },
  },
  {
    id: 'MODEL_PLACEHOLDER_M667',
    model: 'MODEL_PLACEHOLDER_M667',
    modelId: 'gemini-pro-orchestrator',
    label: 'Orchestrator (Carbon)',
    displayName: 'Orchestrator (Carbon)',
    maxTokens: 1048576,
    disabled: false,
    supportsImages: true,
    isDefault: false,
    tagTitle: 'New',
    quotaInfo: { remainingFraction: 0.9 },
  },
  {
    id: 'MODEL_PLACEHOLDER_M681',
    model: 'MODEL_PLACEHOLDER_M681',
    modelId: 'gemini-pro-orchestrator-argon',
    label: 'Orchestrator (Argon)',
    displayName: 'Orchestrator (Argon)',
    maxTokens: 1048576,
    disabled: false,
    supportsImages: true,
    isDefault: false,
    tagTitle: 'New',
    quotaInfo: { remainingFraction: 0.9 },
  },
  {
    id: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
    model: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
    modelId: 'gpt-oss-120b-medium',
    label: 'GPT-OSS 120B (Medium)',
    displayName: 'GPT-OSS 120B (Medium)',
    maxTokens: 131072,
    disabled: false,
    supportsImages: false,
    isDefault: false,
    tagTitle: 'Notice',
    quotaInfo: null,
  },
];

const SAMPLE_TREE: ModelCatalogTree = {
  supportsCustomOrchestrator: false,
  defaultSelectionKey: 'family/gemini-4-neon/medium',
  nodes: [
    {
      kind: 'branch',
      key: 'family/gemini-4-neon',
      role: 'family',
      label: 'Gemini 4 Neon',
      secondaryLabel: 'Medium',
      badge: { kind: 'new', labelKey: 'models.badge.new', rawTitle: 'New' },
      defaultChildKey: 'family/gemini-4-neon/medium',
      children: [
        {
          kind: 'leaf',
          key: 'family/gemini-4-neon/medium',
          role: 'thinking_level',
          label: 'Medium',
          selectedDisplayLabel: 'Gemini 4 Neon · Medium',
          selection: {
            mode: 'single',
            requestedModel: 'MODEL_PLACEHOLDER_M533',
            modelId: 'gemini-4-neon-medium',
          },
        },
        {
          kind: 'leaf',
          key: 'family/gemini-4-neon/high',
          role: 'thinking_level',
          label: 'High',
          selectedDisplayLabel: 'Gemini 4 Neon · High',
          selection: {
            mode: 'single',
            requestedModel: 'MODEL_PLACEHOLDER_M532',
            modelId: 'gemini-4-neon-high',
          },
        },
      ],
    },
    {
      kind: 'branch',
      key: 'orch',
      role: 'orchestrator_root',
      label: 'Orchestrator',
      secondaryLabel: 'Gemini 4 Neon High',
      badge: { kind: 'new', labelKey: 'models.badge.new', rawTitle: 'New' },
      defaultChildKey: 'orch/gemini-4-neon',
      children: [
        {
          kind: 'leaf',
          key: 'orch/gemini-4-neon',
          role: 'planner_model',
          label: 'Gemini 4 Neon',
          secondaryLabel: 'High · → Hydrogen',
          selectedDisplayLabel: 'Orchestrator · Gemini 4 Neon High',
          selection: {
            mode: 'orchestrator_preset',
            requestedModel: 'MODEL_PLACEHOLDER_M537',
            modelId: 'gemini-pro-orchestrator-neon',
            plannerFamilyId: 'gemini-4-neon',
            executorFamilyId: 'gemini-4-hydrogen',
            plannerThinkingSuffix: 'high',
          },
        },
        {
          kind: 'leaf',
          key: 'orch/gemini-4-carbon',
          role: 'planner_model',
          label: 'Gemini 4 Carbon',
          secondaryLabel: 'High · → Hydrogen',
          selectedDisplayLabel: 'Orchestrator · Gemini 4 Carbon High',
          selection: {
            mode: 'orchestrator_preset',
            requestedModel: 'MODEL_PLACEHOLDER_M667',
            modelId: 'gemini-pro-orchestrator',
            plannerFamilyId: 'gemini-4-carbon',
            executorFamilyId: 'gemini-4-hydrogen',
            plannerThinkingSuffix: 'high',
          },
        },
        {
          kind: 'leaf',
          key: 'orch/gemini-4-argon',
          role: 'planner_model',
          label: 'Gemini 4 Argon',
          secondaryLabel: 'High · → Hydrogen',
          selectedDisplayLabel: 'Orchestrator · Gemini 4 Argon High',
          selection: {
            mode: 'orchestrator_preset',
            requestedModel: 'MODEL_PLACEHOLDER_M681',
            modelId: 'gemini-pro-orchestrator-argon',
            plannerFamilyId: 'gemini-4-argon',
            executorFamilyId: 'gemini-4-hydrogen',
            plannerThinkingSuffix: 'high',
          },
        },
      ],
    },
    {
      kind: 'leaf',
      key: 'family/gpt-oss-120b-medium',
      role: 'family',
      label: 'GPT-OSS 120B (Medium)',
      badge: { kind: 'notice', labelKey: 'models.badge.notice', rawTitle: 'Notice' },
      selectedDisplayLabel: 'GPT-OSS 120B (Medium)',
      selection: {
        mode: 'single',
        requestedModel: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
        modelId: 'gpt-oss-120b-medium',
      },
    },
  ],
};

describe('ModelPicker', () => {
  it('displays human-readable names without raw MODEL_PLACEHOLDER IDs and selects thinking & orchestrator presets', () => {
    const onSelectModel = vi.fn();

    render(
      <I18nProvider defaultLocale="zh-CN">
        <ModelPicker
          models={SAMPLE_MODELS}
          tree={SAMPLE_TREE}
          selectedModelId="MODEL_PLACEHOLDER_M533"
          onSelectModel={onSelectModel}
        />
      </I18nProvider>,
    );

    const trigger = screen.getByTestId('model-picker-trigger');
    expect(trigger).toHaveTextContent('Gemini 4 Neon · Medium');
    expect(trigger.textContent).not.toContain('MODEL_PLACEHOLDER');

    fireEvent.click(trigger);
    const popover = screen.getByTestId('model-picker-popover');
    expect(popover.textContent).not.toContain('MODEL_PLACEHOLDER');
    expect(popover).toHaveTextContent('新增');

    // Switch to Orchestrator branch -> sees official 3 presets
    const orchRow = popover.querySelector('[data-node-key="orch"]') as HTMLElement;
    fireEvent.click(orchRow);

    const secondary = screen.getByTestId('model-picker-secondary');
    expect(secondary).toHaveTextContent('Gemini 4 Neon');
    expect(secondary).toHaveTextContent('Gemini 4 Carbon');
    expect(secondary).toHaveTextContent('Gemini 4 Argon');

    const carbonLeaf = secondary.querySelector('[data-node-key="orch/gemini-4-carbon"]') as HTMLElement;
    fireEvent.click(carbonLeaf);
    expect(onSelectModel).toHaveBeenCalledWith('MODEL_PLACEHOLDER_M667');
    // Popover MUST stay open so user can configure thinking level right away
    expect(screen.getByTestId('model-picker-popover')).toBeInTheDocument();
  });

  it('injects Claude Opus preset into Orchestrator from models list, keeps popover open on planner click, and closes on thinking level click', () => {
    const onSelectModel = vi.fn();
    const onSelectThinkingLevel = vi.fn();

    const modelsWithOpus: ModelItem[] = [
      ...SAMPLE_MODELS,
      {
        id: 'MODEL_PLACEHOLDER_M400',
        model: 'MODEL_PLACEHOLDER_M400',
        modelId: 'claude-opus-5-5-low',
        label: 'Claude Opus 5.5 (Low)',
        displayName: 'Claude Opus 5.5 (Low)',
        maxTokens: 1048576,
        disabled: false,
        supportsImages: true,
        isDefault: false,
        quotaInfo: { remainingFraction: 0.42 },
      },
      {
        id: 'MODEL_PLACEHOLDER_M401',
        model: 'MODEL_PLACEHOLDER_M401',
        modelId: 'claude-opus-5-5-medium',
        label: 'Claude Opus 5.5 (Medium)',
        displayName: 'Claude Opus 5.5 (Medium)',
        maxTokens: 1048576,
        disabled: false,
        supportsImages: true,
        isDefault: false,
        quotaInfo: { remainingFraction: 0.42 },
      },
      {
        id: 'MODEL_PLACEHOLDER_M402',
        model: 'MODEL_PLACEHOLDER_M402',
        modelId: 'claude-opus-5-5-high',
        label: 'Claude Opus 5.5 (High)',
        displayName: 'Claude Opus 5.5 (High)',
        maxTokens: 1048576,
        disabled: false,
        supportsImages: true,
        isDefault: false,
        quotaInfo: { remainingFraction: 0.42 },
      },
    ];

    render(
      <I18nProvider defaultLocale="zh-CN">
        <ModelPicker
          models={modelsWithOpus}
          tree={SAMPLE_TREE}
          selectedModelId="MODEL_PLACEHOLDER_M533"
          onSelectModel={onSelectModel}
          onSelectThinkingLevel={onSelectThinkingLevel}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByTestId('model-picker-trigger'));
    const orchRow = screen
      .getByTestId('model-picker-primary')
      .querySelector('[data-node-key="orch"]') as HTMLElement;
    fireEvent.click(orchRow);

    const secondary = screen.getByTestId('model-picker-secondary');
    const opusLeaf = secondary.querySelector('[data-node-key="orch/claude-opus-5-5"]') as HTMLElement;
    expect(opusLeaf).toBeInTheDocument();
    expect(opusLeaf).toHaveTextContent('Claude Opus 5.5');
    expect(opusLeaf).toHaveTextContent('42%');

    // Selecting planner model keeps popover open & updates thinking section target
    fireEvent.click(opusLeaf);
    expect(onSelectModel).toHaveBeenCalledWith('orchestrator:claude-opus-5-5');
    expect(screen.getByTestId('model-picker-popover')).toBeInTheDocument();
    expect(screen.getByTestId('orch-thinking-selector')).toHaveTextContent('Claude Opus 5.5');

    // Selecting thinking level commits & closes popover
    fireEvent.click(screen.getByTestId('orch-thinking-level-medium'));
    expect(onSelectThinkingLevel).toHaveBeenCalledWith('medium');
    expect(screen.queryByTestId('model-picker-popover')).not.toBeInTheDocument();
  });

  it('allows direct selection of single-tier leaf model', () => {
    const onSelectModel = vi.fn();
    render(
      <I18nProvider defaultLocale="en">
        <ModelPicker
          models={SAMPLE_MODELS}
          tree={SAMPLE_TREE}
          selectedModelId="MODEL_PLACEHOLDER_M533"
          onSelectModel={onSelectModel}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByTestId('model-picker-trigger'));
    const gptLeaf = screen
      .getByTestId('model-picker-primary')
      .querySelector('[data-node-key="family/gpt-oss-120b-medium"]') as HTMLElement;
    fireEvent.click(gptLeaf);
    expect(onSelectModel).toHaveBeenCalledWith('MODEL_OPENAI_GPT_OSS_120B_MEDIUM');
  });

  it('supports configuring thinking level on Orchestrator presets and updates labels dynamically', () => {
    const onSelectModel = vi.fn();
    const onSelectThinkingLevel = vi.fn();

    const richTree: ModelCatalogTree = {
      ...SAMPLE_TREE,
      supportsCustomOrchestrator: true,
      nodes: SAMPLE_TREE.nodes.map((node) => {
        if (node.kind === 'branch' && node.key === 'orch') {
          return {
            ...node,
            children: node.children.map((child) => {
              if (child.kind !== 'leaf') return child;
              if (child.key === 'orch/gemini-4-neon') {
                return {
                  ...child,
                  secondaryLabel: 'Extra High · → Hydrogen',
                  selectedDisplayLabel: 'Orchestrator · Gemini 4 Neon Extra High',
                  defaultThinkingSuffix: 'xhigh',
                  supportedThinkingLevels: ['low', 'medium', 'high', 'xhigh'],
                };
              }
              return {
                ...child,
                defaultThinkingSuffix: 'high',
                supportedThinkingLevels: ['low', 'medium', 'high'],
              };
            }),
          };
        }
        return node;
      }),
    };

    const { rerender } = render(
      <I18nProvider defaultLocale="zh-CN">
        <ModelPicker
          models={SAMPLE_MODELS}
          tree={richTree}
          selectedModelId="MODEL_PLACEHOLDER_M537"
          selectedThinkingLevel="xhigh"
          onSelectModel={onSelectModel}
          onSelectThinkingLevel={onSelectThinkingLevel}
        />
      </I18nProvider>,
    );

    expect(screen.getByTestId('model-picker-trigger')).toHaveTextContent(
      'Orchestrator · Gemini 4 Neon Extra High',
    );

    fireEvent.click(screen.getByTestId('model-picker-trigger'));
    const orchRow = screen
      .getByTestId('model-picker-primary')
      .querySelector('[data-node-key="orch"]') as HTMLElement;
    fireEvent.click(orchRow);

    const secondary = screen.getByTestId('model-picker-secondary');
    expect(secondary).toHaveTextContent('思考等级');
    expect(screen.getByTestId('orch-thinking-selector')).toBeInTheDocument();
    expect(screen.getByTestId('orch-thinking-level-low')).toBeInTheDocument();
    expect(screen.getByTestId('orch-thinking-level-medium')).toBeInTheDocument();
    expect(screen.getByTestId('orch-thinking-level-high')).toBeInTheDocument();
    expect(screen.getByTestId('orch-thinking-level-xhigh')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('orch-thinking-level-medium'));
    expect(onSelectThinkingLevel).toHaveBeenCalledWith('medium');
    expect(screen.queryByTestId('model-picker-popover')).not.toBeInTheDocument();

    rerender(
      <I18nProvider defaultLocale="zh-CN">
        <ModelPicker
          models={SAMPLE_MODELS}
          tree={richTree}
          selectedModelId="MODEL_PLACEHOLDER_M537"
          selectedThinkingLevel="medium"
          onSelectModel={onSelectModel}
          onSelectThinkingLevel={onSelectThinkingLevel}
        />
      </I18nProvider>,
    );

    expect(screen.getByTestId('model-picker-trigger')).toHaveTextContent(
      'Orchestrator · Gemini 4 Neon Medium',
    );
    fireEvent.click(screen.getByTestId('model-picker-trigger'));
    const orchRowAgain = screen
      .getByTestId('model-picker-primary')
      .querySelector('[data-node-key="orch"]') as HTMLElement;
    fireEvent.click(orchRowAgain);
    const neonLeaf = screen
      .getByTestId('model-picker-secondary')
      .querySelector('[data-node-key="orch/gemini-4-neon"]') as HTMLElement;
    expect(neonLeaf).toHaveTextContent('Medium · → Hydrogen');
  });

  it('activates default Orchestrator preset when picking thinking level directly from another model', () => {
    const onSelectModel = vi.fn();
    const onSelectThinkingLevel = vi.fn();

    render(
      <I18nProvider defaultLocale="en">
        <ModelPicker
          models={SAMPLE_MODELS}
          tree={SAMPLE_TREE}
          selectedModelId="MODEL_PLACEHOLDER_M533"
          selectedThinkingLevel={null}
          onSelectModel={onSelectModel}
          onSelectThinkingLevel={onSelectThinkingLevel}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByTestId('model-picker-trigger'));
    const orchRow = screen
      .getByTestId('model-picker-primary')
      .querySelector('[data-node-key="orch"]') as HTMLElement;
    fireEvent.click(orchRow);

    // Fallback levels ['low', 'medium', 'high', 'xhigh'] are rendered even without supportedThinkingLevels on tree
    fireEvent.click(screen.getByTestId('orch-thinking-level-low'));
    expect(onSelectThinkingLevel).toHaveBeenCalledWith('low');
    expect(onSelectModel).toHaveBeenCalledWith('MODEL_PLACEHOLDER_M537');
  });
});
