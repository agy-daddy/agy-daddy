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

  it('shows explicit reconnect button when SSE disconnects and resubscribes on click', async () => {
    vi.spyOn(apiClient, 'listTerminalSessions').mockResolvedValue({
      ok: true,
      runtimeAvailable: true,
      writable: true,
      requiredPermission: 'L2',
      maxSessions: 8,
      sessions: [
        {
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
      ],
    });

    let streamHandlers: Parameters<typeof apiClient.subscribeTerminalStream>[1] | null = null;
    const unsubscribeMock = vi.fn();
    const subscribeSpy = vi
      .spyOn(apiClient, 'subscribeTerminalStream')
      .mockImplementation((_id, handlers) => {
        streamHandlers = handlers;
        handlers.onOpen?.();
        return unsubscribeMock;
      });

    render(
      <I18nProvider defaultLocale="en">
        <TerminalPanel activeRoot="/repo" channel="loopback" permissionLevel="L2" />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('terminal-screen')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('terminal-reconnect-btn')).toBeNull();

    act(() => {
      streamHandlers?.onOutput?.({ seq: 3, chunk: 'hi\n', alive: true });
      streamHandlers?.onError?.(new Event('error'));
    });

    const reconnectBtn = await screen.findByTestId('terminal-reconnect-btn');
    expect(reconnectBtn).toHaveTextContent('Reconnect');

    fireEvent.click(reconnectBtn);

    await waitFor(() => {
      expect(subscribeSpy).toHaveBeenCalledTimes(2);
    });
    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
    expect(subscribeSpy).toHaveBeenLastCalledWith(
      'term-1',
      expect.objectContaining({ afterSeq: 4 }),
    );
    expect(screen.queryByTestId('terminal-reconnect-btn')).toBeNull();
  });

  it('isolates terminals strictly by activeRoot worktree without global first-alive fallback and retries 409 PTY_CWD_MISMATCH', async () => {
    const wtMain = {
      worktreeId: 'wt-main',
      path: '/repo',
      uri: 'file:///repo',
      displaySubpath: 'repo',
      head: '111',
      headShort: '111',
      branch: 'main',
      displayLabel: 'main',
      isMain: true,
      bare: false,
      detached: false,
      locked: false,
      prunable: false,
      exists: true,
      status: 'ready' as const,
      collapsed: false,
      allowed: true,
    };
    const wtFeat = {
      ...wtMain,
      worktreeId: 'wt-feat',
      path: '/repo/.worktrees/feat-a',
      uri: 'file:///repo/.worktrees/feat-a',
      displaySubpath: '.worktrees/feat-a',
      branch: 'feat/a',
      displayLabel: 'feat/a',
      isMain: false,
    };

    const listSpy = vi.spyOn(apiClient, 'listTerminalSessions').mockResolvedValue({
      ok: true,
      runtimeAvailable: true,
      writable: true,
      requiredPermission: 'L2',
      maxSessions: 8,
      sessions: [
        {
          sessionId: 'term-main',
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
      ],
    });

    vi.spyOn(apiClient, 'subscribeTerminalStream').mockImplementation((_id, handlers) => {
      handlers.onOpen?.();
      return () => {};
    });

    render(
      <I18nProvider defaultLocale="en">
        <TerminalPanel
          activeRoot="/repo/.worktrees/feat-a"
          activeBranchLabel="feat/a"
          worktrees={[wtMain, wtFeat]}
          channel="loopback"
          permissionLevel="L2"
        />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith({ cwd: '/repo/.worktrees/feat-a' });
    });

    // Even if server returned a /repo PTY, TerminalPanel must NOT attach to /repo when activeRoot is feat-a
    expect(screen.getByTestId('terminal-empty-card')).toHaveTextContent('feat/a');
    expect(screen.getByTestId('terminal-sandbox-capsule')).toHaveTextContent('feat/a');
    expect(screen.queryByTestId('terminal-screen')).not.toBeInTheDocument();

    // Auto-isolate on 409 PTY_CWD_MISMATCH
    const createSpy = vi
      .spyOn(apiClient, 'createTerminalSession')
      .mockRejectedValueOnce(new ApiError('cwd mismatch', 409, 'PTY_CWD_MISMATCH'))
      .mockResolvedValueOnce({
        ok: true,
        created: true,
        session: {
          sessionId: 'term-feat',
          title: 'zsh',
          cwd: '/repo/.worktrees/feat-a',
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

    fireEvent.click(screen.getByTestId('terminal-empty-launch-btn'));
    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('terminal-screen')).toBeInTheDocument();
    });
  });
});
