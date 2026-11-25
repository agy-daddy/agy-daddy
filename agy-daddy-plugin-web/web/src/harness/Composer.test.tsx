import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import type { ComposerStateResponse, ModelCatalogTree, ModelItem } from '../types';
import { Composer } from './Composer';

const MODELS: ModelItem[] = [
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
    quotaInfo: { remainingFraction: 0.9 },
  },
];

const TREE: ModelCatalogTree = {
  supportsCustomOrchestrator: true,
  defaultSelectionKey: 'family/gemini-4-neon/medium',
  nodes: [
    {
      kind: 'branch',
      key: 'family/gemini-4-neon',
      role: 'family',
      label: 'Gemini 4 Neon',
      defaultChildKey: 'family/gemini-4-neon/medium',
      children: [
        {
          kind: 'leaf',
          key: 'family/gemini-4-neon/medium',
          role: 'thinking_level',
          label: 'Medium',
          defaultThinkingSuffix: 'medium',
          selectedDisplayLabel: 'Gemini 4 Neon · Medium',
          selection: {
            mode: 'single',
            requestedModel: 'MODEL_PLACEHOLDER_M533',
            modelId: 'gemini-4-neon-medium',
          },
        },
      ],
    },
    {
      kind: 'branch',
      key: 'orch',
      role: 'orchestrator_root',
      label: 'Orchestrator',
      defaultChildKey: 'orch/gemini-4-neon',
      children: [
        {
          kind: 'leaf',
          key: 'orch/gemini-4-neon',
          role: 'planner_model',
          label: 'Gemini 4 Neon',
          secondaryLabel: 'Extra High · → Hydrogen',
          defaultThinkingSuffix: 'xhigh',
          supportedThinkingLevels: ['low', 'medium', 'high', 'xhigh'],
          selectedDisplayLabel: 'Orchestrator · Gemini 4 Neon Extra High',
          selection: {
            mode: 'orchestrator_preset',
            requestedModel: 'MODEL_PLACEHOLDER_M537',
            modelId: 'gemini-pro-orchestrator-neon',
            plannerFamilyId: 'gemini-4-neon',
            executorFamilyId: 'gemini-4-hydrogen',
            plannerThinkingSuffix: 'xhigh',
          },
        },
      ],
    },
  ],
};

const COMPOSER_STATE: ComposerStateResponse = {
  ok: true,
  enabled: true,
  settings: {
    quickPromptsEnabled: true,
    ghostSuggest: true,
    autoCompactThreshold: 80,
    optimizerShortcut: 'Alt+Shift+O',
  },
  quickPrompts: [
    { id: 'compact', label: '压缩上下文', template: '/compact ', builtin: true },
    { id: 'plan', label: '规划模式', template: '/plan ', builtin: true },
    { id: 'goal', label: '持续到底', template: '/goal ', builtin: true },
    { id: 'grill-me', label: '追问对齐', template: '/grill-me ', builtin: true },
    { id: 'boost', label: '深度攻坚', template: '/boost ', builtin: true },
  ],
  frequentPrompts: ['Run tests and summarize', 'Check git diff'],
};

describe('Composer', () => {
  it('renders all quick prompts in top bar alongside ghost bar and pulses compact when context is high', () => {
    const onSend = vi.fn();
    render(
      <I18nProvider defaultLocale="zh-CN">
        <Composer
          models={MODELS}
          modelTree={TREE}
          onSend={onSend}
          composerState={COMPOSER_STATE}
          contextUsagePct={85}
        />
      </I18nProvider>,
    );

    const topBar = screen.getByTestId('composer-quick-bar');
    expect(screen.getByTestId('quick-prompt-compact')).toBeInTheDocument();
    expect(screen.getByTestId('quick-prompt-boost')).toBeInTheDocument();
    expect(screen.queryByTestId('quick-prompt-more-btn')).not.toBeInTheDocument();
    expect(topBar.contains(screen.getByTestId('composer-ghost-bar'))).toBe(true);

    fireEvent.click(screen.getByTestId('quick-prompt-plan'));
    const textarea = screen.getByTestId('composer-textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe('/plan ');
  });

  it('supports ghost suggestions with Tab and ArrowRight accept and cycle button', () => {
    const onSend = vi.fn();
    render(
      <I18nProvider defaultLocale="en">
        <Composer
          models={MODELS}
          modelTree={TREE}
          onSend={onSend}
          composerState={COMPOSER_STATE}
        />
      </I18nProvider>,
    );

    expect(screen.getByTestId('composer-ghost-bar')).toBeInTheDocument();
    expect(screen.getByTestId('composer-ghost-text')).toHaveTextContent('Run tests and summarize');

    fireEvent.click(screen.getByTestId('composer-ghost-cycle'));
    expect(screen.getByTestId('composer-ghost-text')).toHaveTextContent('Check git diff');

    const textarea = screen.getByTestId('composer-textarea') as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: 'ArrowRight' });
    expect(textarea.value).toBe('Check git diff');

    fireEvent.change(textarea, { target: { value: '' } });
    fireEvent.keyDown(textarea, { key: 'Tab' });
    expect(textarea.value).toBe('Run tests and summarize');
  });

  it('supports circular icon-only prompt optimizer, keyboard shortcut, and undo restore without hint/export clutter', async () => {
    const onSend = vi.fn();
    const onOptimizePrompt = vi.fn().mockResolvedValue('Optimized detailed prompt');

    render(
      <I18nProvider defaultLocale="en">
        <Composer
          models={MODELS}
          modelTree={TREE}
          onSend={onSend}
          composerState={COMPOSER_STATE}
          onOptimizePrompt={onOptimizePrompt}
        />
      </I18nProvider>,
    );

    expect(screen.queryByTestId('composer-export-btn')).not.toBeInTheDocument();
    expect(screen.queryByText(/Enter to send/)).not.toBeInTheDocument();
    expect(screen.getByTestId('composer-plus-btn')).toBeInTheDocument();

    const optBtn = screen.getByTestId('composer-optimize-btn');
    expect(optBtn).toBeInTheDocument();
    expect(optBtn.textContent?.trim()).toBe('');

    const textarea = screen.getByTestId('composer-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'fix bug' } });

    fireEvent.keyDown(textarea, { key: 'O', metaKey: true, shiftKey: true });
    expect(onOptimizePrompt).toHaveBeenCalledWith('fix bug');

    await waitFor(() => {
      expect(textarea.value).toBe('Optimized detailed prompt');
    });

    const undoBtn = screen.getByTestId('composer-undo-optimize-btn');
    expect(undoBtn).toBeInTheDocument();
    fireEvent.click(undoBtn);
    expect(textarea.value).toBe('fix bug');
    expect(screen.queryByTestId('composer-undo-optimize-btn')).not.toBeInTheDocument();
  });

  it('passes selectedThinkingLevel through onSend and handles cancel when running', () => {
    const onSend = vi.fn();
    const onCancel = vi.fn();
    const onSelectThinkingLevel = vi.fn();

    render(
      <I18nProvider defaultLocale="en">
        <Composer
          models={MODELS}
          modelTree={TREE}
          selectedModelId="MODEL_PLACEHOLDER_M537"
          selectedThinkingLevel="medium"
          onSelectThinkingLevel={onSelectThinkingLevel}
          onSend={onSend}
          onCancel={onCancel}
          isRunning={true}
        />
      </I18nProvider>,
    );

    const textarea = screen.getByTestId('composer-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Plan architecture' } });
    fireEvent.click(screen.getByTestId('composer-send-btn'));

    expect(onSend).toHaveBeenCalledWith('Plan architecture', 'MODEL_PLACEHOLDER_M537', 'medium');

    fireEvent.click(screen.getByTestId('composer-cancel-btn'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('clears textarea immediately on send and restores draft on reject only if still empty', async () => {
    let rejectFirst!: (err: Error) => void;
    const onSend = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((_, reject) => {
            rejectFirst = reject;
          }),
      );

    render(
      <I18nProvider defaultLocale="en">
        <Composer models={MODELS} onSend={onSend} />
      </I18nProvider>,
    );

    const textarea = screen.getByTestId('composer-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'First message' } });
    fireEvent.click(screen.getByTestId('composer-send-btn'));

    // Cleared immediately while promise is still pending
    expect(onSend).toHaveBeenCalledWith('First message', 'MODEL_PLACEHOLDER_M533');
    expect(textarea.value).toBe('');

    // Rejecting while textarea is still empty restores draft
    rejectFirst(new Error('502 Bad Gateway'));
    await waitFor(() => {
      expect(textarea.value).toBe('First message');
    });

    // Send again, then type a new draft before rejection
    fireEvent.click(screen.getByTestId('composer-send-btn'));
    expect(textarea.value).toBe('');
    fireEvent.change(textarea, { target: { value: 'Next draft in progress' } });

    rejectFirst(new Error('502 Bad Gateway'));
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledTimes(2);
    });
    expect(textarea.value).toBe('Next draft in progress');
  });
});
