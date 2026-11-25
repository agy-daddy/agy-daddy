import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { apiClient } from '../api/client';
import type { ModelItem } from '../types';
import { SideChatPanel } from './SideChatPanel';

const MODELS: ModelItem[] = [
  {
    id: 'MODEL_FAST',
    model: 'MODEL_FAST',
    modelId: 'fast-model',
    label: 'Fast Auto',
    displayName: 'Fast Auto',
    maxTokens: 128000,
    disabled: false,
    supportsImages: false,
    isDefault: true,
    quotaInfo: null,
  },
];

describe('SideChatPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('streams isolated reply, supports insert-to-composer without touching main session, and keeps per-session buckets', async () => {
    let capturedHandlers: Parameters<typeof apiClient.streamSideChatCompletion>[1] | null = null;

    const streamSpy = vi
      .spyOn(apiClient, 'streamSideChatCompletion')
      .mockImplementation(async (_req, handlers) => {
        capturedHandlers = handlers;
        handlers.onMeta?.({
          requestId: 'req-1',
          model: 'MODEL_FAST',
          label: 'Fast Auto',
          contextScope: 'none',
        });
      });
    const onInsertToComposer = vi.fn();

    const { rerender } = render(
      <I18nProvider defaultLocale="en">
        <SideChatPanel
          activeSessionId="sess-A"
          models={MODELS}
          channel="loopback"
          permissionLevel="L2"
          onInsertToComposer={onInsertToComposer}
        />
      </I18nProvider>,
    );

    expect(screen.getByTestId('side-chat-isolation-badge')).toHaveTextContent(
      'Never pollutes main session',
    );
    expect((screen.getByTestId('side-chat-scope-select') as HTMLSelectElement).value).toBe('none');

    fireEvent.change(screen.getByTestId('side-chat-input'), {
      target: { value: 'Explain this regex' },
    });
    fireEvent.click(screen.getByTestId('side-chat-send-btn'));

    expect(streamSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        contextScope: 'none',
        selectionContext: null,
      }),
      expect.any(Object),
    );
    expect(screen.getByTestId('side-chat-stop-btn')).toBeInTheDocument();

    const markdownReply = '**Answer** with `regex`\n\n- Match digits';
    act(() => {
      capturedHandlers?.onDelta?.({ delta: markdownReply });
      capturedHandlers?.onDone?.({
        requestId: 'req-1',
        text: markdownReply,
        model: 'MODEL_FAST',
        label: 'Fast Auto',
        durationMs: 120,
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('side-chat-insert-btn')).toBeInTheDocument();
    });

    const assistantCard = screen.getByTestId('side-chat-msg-assistant');
    expect(assistantCard.querySelector('strong')).toHaveTextContent('Answer');
    expect(assistantCard.querySelector('code')).toHaveTextContent('regex');
    expect(assistantCard.querySelector('li')).toHaveTextContent('Match digits');
    expect(assistantCard.querySelector('pre')).toBeNull();

    fireEvent.click(screen.getByTestId('side-chat-insert-btn'));
    expect(onInsertToComposer).toHaveBeenCalledWith(markdownReply);

    // Switching active session isolates memory bucket
    rerender(
      <I18nProvider defaultLocale="en">
        <SideChatPanel
          activeSessionId="sess-B"
          models={MODELS}
          channel="loopback"
          permissionLevel="L2"
          onInsertToComposer={onInsertToComposer}
        />
      </I18nProvider>,
    );
    expect(screen.queryByTestId('side-chat-msg-assistant')).not.toBeInTheDocument();
  });

  it('disables input on non-loopback L0 channel', () => {
    render(
      <I18nProvider defaultLocale="en">
        <SideChatPanel
          activeSessionId="sess-A"
          models={MODELS}
          channel="cloudflare"
          permissionLevel="L0"
        />
      </I18nProvider>,
    );

    expect(screen.getByTestId('side-chat-l0-banner')).toBeInTheDocument();
    expect(screen.getByTestId('side-chat-input')).toBeDisabled();
  });
});
