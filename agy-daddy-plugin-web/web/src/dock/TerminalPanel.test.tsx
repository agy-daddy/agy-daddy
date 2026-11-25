import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { ApiError, apiClient } from '../api/client';
import { TerminalPanel } from './TerminalPanel';

describe('TerminalPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('locks non-loopback non-L2 channels and keeps 503 degradation explicit', async () => {
    const { rerender } = render(
      <I18nProvider defaultLocale="en">
        <TerminalPanel channel="cloudflare" permissionLevel="L1" />
      </I18nProvider>,
    );
    expect(screen.getByTestId('terminal-perm-locked')).toHaveTextContent('L1');

    vi.spyOn(apiClient, 'listTerminalSessions').mockRejectedValue(
      new ApiError('python3 missing', 503, 'PTY_RUNTIME_UNAVAILABLE'),
    );
    rerender(
      <I18nProvider defaultLocale="en">
        <TerminalPanel channel="loopback" permissionLevel="L2" />
      </I18nProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('terminal-unavailable-card')).toHaveTextContent('python3 missing');
    });
  });

  it('creates terminal session, streams ANSI output, and batches + reuses writeConfirmToken lease', async () => {
    vi.spyOn(apiClient, 'listTerminalSessions').mockResolvedValue({
      ok: true,
      runtimeAvailable: true,
      writable: true,
      requiredPermission: 'L2',
      maxSessions: 8,
      sessions: [],
    });
    vi.spyOn(apiClient, 'createTerminalSession').mockResolvedValue({
      ok: true,
      created: true,
      session: {
        sessionId: 'term-1',
        title: 'zsh',
        cwd: '/repo',
        shell: '/bin/zsh',
        cols: 80,
        rows: 24,
        alive: true,
        exitCode: null,
        signal: null,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        endedAt: null,
        latestSeq: 0,
      },
    });

    let streamHandlers: Parameters<typeof apiClient.subscribeTerminalStream>[1] | null = null;
    vi.spyOn(apiClient, 'subscribeTerminalStream').mockImplementation((_id, handlers) => {
      streamHandlers = handlers;
      handlers.onOpen?.();
      return () => {};
    });

    const writeSpy = vi
      .spyOn(apiClient, 'sendTerminalInput')
      .mockImplementation(async (_id, _data, opts) => {
        opts?.onConfirmTokenRenewed?.('lease-token-1');
        return { ok: true, sessionId: 'term-1' };
      });

    render(
      <I18nProvider defaultLocale="en">
        <TerminalPanel activeRoot="/repo" channel="cloudflare" permissionLevel="L2" />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('terminal-empty-card')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('terminal-empty-launch-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-screen')).toBeInTheDocument();
    });

    act(() => {
      streamHandlers?.onOutput?.({ seq: 0, chunk: '\x1b[32mready> \x1b[0m', alive: true });
    });
    expect(screen.getByTestId('terminal-screen')).toHaveTextContent('ready>');

    const termScreen = screen.getByTestId('terminal-screen');
    fireEvent.keyDown(termScreen, { key: 'l' });
    fireEvent.keyDown(termScreen, { key: 's' });
    fireEvent.keyDown(termScreen, { key: 'Enter' });

    await waitFor(() => {
      expect(writeSpy).toHaveBeenCalledWith(
        'term-1',
        'ls\r',
        expect.objectContaining({ confirmToken: undefined }),
      );
    });

    fireEvent.keyDown(termScreen, { key: 'p' });
    await waitFor(() => {
      expect(writeSpy).toHaveBeenLastCalledWith(
        'term-1',
        'p',
        expect.objectContaining({ confirmToken: 'lease-token-1' }),
      );
    });
  });
});
