import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { apiClient } from '../api/client';
import { RightDock } from './RightDock';

describe('RightDock 5-tab & keepalive', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(apiClient, 'getFsTree').mockResolvedValue({
      ok: true,
      root: '/repo',
      path: '.',
      entries: [],
    });
    vi.spyOn(apiClient, 'getGitDiff').mockResolvedValue({
      ok: true,
      isGitRepo: false,
      branch: '',
      files: [],
      diffText: '',
    });
    vi.spyOn(apiClient, 'listArtifacts').mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      items: [],
    });
    vi.spyOn(apiClient, 'listTerminalSessions').mockResolvedValue({
      ok: true,
      runtimeAvailable: true,
      writable: true,
      requiredPermission: 'L2',
      maxSessions: 8,
      sessions: [],
    });
  });

  it('renders all 5 tabs and preserves Terminal/SideChat mounted state via hidden keepalive when switching tabs', () => {
    render(
      <I18nProvider defaultLocale="en">
        <RightDock
          activeSessionId="sess-1"
          defaultWorkspaceRoot="/repo"
          channel="loopback"
          permissionLevel="L2"
          models={[]}
        />
      </I18nProvider>,
    );

    expect(screen.getByTestId('dock-tab-files')).toBeInTheDocument();
    expect(screen.getByTestId('dock-tab-diff')).toBeInTheDocument();
    expect(screen.getByTestId('dock-tab-artifacts')).toBeInTheDocument();
    expect(screen.getByTestId('dock-tab-terminal')).toBeInTheDocument();
    expect(screen.getByTestId('dock-tab-sideChat')).toBeInTheDocument();

    const termPane = screen.getByTestId('terminal-panel').parentElement as HTMLElement;
    const sidePane = screen.getByTestId('side-chat-panel').parentElement as HTMLElement;
    expect(termPane.hidden).toBe(true);
    expect(sidePane.hidden).toBe(true);

    fireEvent.click(screen.getByTestId('dock-tab-sideChat'));
    expect(sidePane.hidden).toBe(false);
    fireEvent.change(screen.getByTestId('side-chat-input'), {
      target: { value: 'preserved draft' },
    });

    fireEvent.click(screen.getByTestId('dock-tab-terminal'));
    expect(termPane.hidden).toBe(false);
    expect(sidePane.hidden).toBe(true);

    fireEvent.click(screen.getByTestId('dock-tab-sideChat'));
    expect((screen.getByTestId('side-chat-input') as HTMLTextAreaElement).value).toBe(
      'preserved draft',
    );
  });

  it('passes truncated file preview and git diff snippets to SideChat active_selection context', async () => {
    const longContent = 'a'.repeat(8500);
    vi.spyOn(apiClient, 'getFsTree').mockResolvedValue({
      ok: true,
      root: '/repo',
      path: '.',
      entries: [
        { name: 'big.ts', path: 'src/big.ts', type: 'file', size: longContent.length },
      ],
    });
    vi.spyOn(apiClient, 'readFsFile').mockResolvedValue({
      ok: true,
      path: 'src/big.ts',
      content: longContent,
      size: longContent.length,
      truncated: false,
    });
    vi.spyOn(apiClient, 'getGitDiff').mockResolvedValue({
      ok: true,
      isGitRepo: true,
      branch: 'main',
      files: [{ path: 'src/app.ts', status: 'modified', additions: 1, deletions: 0 }],
      diffText: [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1 +1,2 @@',
        ' const a = 1;',
        '+const b = 2;',
      ].join('\n'),
    });
    const streamSpy = vi
      .spyOn(apiClient, 'streamSideChatCompletion')
      .mockImplementation(async (_req, handlers) => {
        handlers.onDone?.({
          requestId: 'req-dock-1',
          text: 'done',
          model: 'MODEL_FAST',
          label: 'Fast Auto',
          durationMs: 10,
        });
      });

    render(
      <I18nProvider defaultLocale="en">
        <RightDock
          activeSessionId="sess-1"
          defaultWorkspaceRoot="/repo"
          channel="loopback"
          permissionLevel="L2"
          models={[]}
        />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('fs-node-src/big.ts')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('fs-node-src/big.ts'));
    await waitFor(() => {
      expect(screen.getByTestId('fs-editor-textarea')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('dock-tab-sideChat'));
    fireEvent.change(screen.getByTestId('side-chat-scope-select'), {
      target: { value: 'active_selection' },
    });
    fireEvent.change(screen.getByTestId('side-chat-input'), {
      target: { value: 'Summarize current file' },
    });
    fireEvent.click(screen.getByTestId('side-chat-send-btn'));

    expect(streamSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        contextScope: 'active_selection',
        selectionContext: {
          path: 'src/big.ts',
          snippet: 'a'.repeat(8000),
          kind: 'file',
        },
      }),
      expect.any(Object),
    );

    // Switch to Diff tab, select a diff file, then send from SideChat again
    fireEvent.click(screen.getByTestId('dock-tab-diff'));
    await waitFor(() => {
      expect(screen.getByTestId('git-file-src/app.ts')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('git-file-src/app.ts'));

    fireEvent.click(screen.getByTestId('dock-tab-sideChat'));
    fireEvent.change(screen.getByTestId('side-chat-input'), {
      target: { value: 'Explain diff' },
    });
    fireEvent.click(screen.getByTestId('side-chat-send-btn'));

    expect(streamSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        contextScope: 'active_selection',
        selectionContext: expect.objectContaining({
          path: 'src/app.ts',
          kind: 'diff',
          snippet: expect.stringContaining('+const b = 2;'),
        }),
      }),
      expect.any(Object),
    );
  });

  it('prefers highlighted editor substring over full file prefix for SideChat active_selection', async () => {
    const longContent = `${'a'.repeat(8500)}TARGET_SLICE_CONTENT${'b'.repeat(100)}`;
    vi.spyOn(apiClient, 'getFsTree').mockResolvedValue({
      ok: true,
      root: '/repo',
      path: '.',
      entries: [{ name: 'big.ts', path: 'src/big.ts', type: 'file', size: longContent.length }],
    });
    vi.spyOn(apiClient, 'readFsFile').mockResolvedValue({
      ok: true,
      path: 'src/big.ts',
      content: longContent,
      size: longContent.length,
      truncated: false,
    });
    const streamSpy = vi
      .spyOn(apiClient, 'streamSideChatCompletion')
      .mockImplementation(async (_req, handlers) => {
        handlers.onDone?.({
          requestId: 'req-slice-1',
          text: 'done',
          model: 'MODEL_FAST',
          label: 'Fast Auto',
          durationMs: 10,
        });
      });

    render(
      <I18nProvider defaultLocale="en">
        <RightDock
          activeSessionId="sess-1"
          defaultWorkspaceRoot="/repo"
          channel="loopback"
          permissionLevel="L2"
          models={[]}
        />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('fs-node-src/big.ts')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('fs-node-src/big.ts'));

    const textarea = (await screen.findByTestId('fs-editor-textarea')) as HTMLTextAreaElement;
    textarea.setSelectionRange(8500, 8520);
    fireEvent.select(textarea);

    fireEvent.click(screen.getByTestId('dock-tab-sideChat'));
    fireEvent.change(screen.getByTestId('side-chat-scope-select'), {
      target: { value: 'active_selection' },
    });
    fireEvent.change(screen.getByTestId('side-chat-input'), {
      target: { value: 'Explain selected slice' },
    });
    fireEvent.click(screen.getByTestId('side-chat-send-btn'));

    expect(streamSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        contextScope: 'active_selection',
        selectionContext: {
          path: 'src/big.ts',
          snippet: 'TARGET_SLICE_CONTENT',
          kind: 'file',
        },
      }),
      expect.any(Object),
    );
  });

  it('hydrates focusedFilePath snippet even when RightDock opens directly on sideChat tab', async () => {
    vi.spyOn(apiClient, 'readFsFile').mockResolvedValue({
      ok: true,
      path: 'src/direct.ts',
      content: 'export const direct = 42;',
      size: 25,
      truncated: false,
    });
    const streamSpy = vi
      .spyOn(apiClient, 'streamSideChatCompletion')
      .mockImplementation(async (_req, handlers) => {
        handlers.onDone?.({
          requestId: 'req-direct-1',
          text: 'done',
          model: 'MODEL_FAST',
          label: 'Fast Auto',
          durationMs: 10,
        });
      });

    render(
      <I18nProvider defaultLocale="en">
        <RightDock
          activeSessionId="sess-1"
          defaultWorkspaceRoot="/repo"
          activeTab="sideChat"
          focusedFilePath={{ path: '/repo/src/direct.ts', nonce: 1 }}
          channel="loopback"
          permissionLevel="L2"
          models={[]}
        />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(apiClient.readFsFile).toHaveBeenCalledWith(
        { root: '/repo', path: 'src/direct.ts' },
        expect.anything(),
      );
    });

    fireEvent.change(screen.getByTestId('side-chat-scope-select'), {
      target: { value: 'active_selection' },
    });
    fireEvent.change(screen.getByTestId('side-chat-input'), {
      target: { value: 'Inspect focused file' },
    });
    fireEvent.click(screen.getByTestId('side-chat-send-btn'));

    expect(streamSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        contextScope: 'active_selection',
        selectionContext: {
          path: 'src/direct.ts',
          snippet: 'export const direct = 42;',
          kind: 'file',
        },
      }),
      expect.any(Object),
    );
  });
});
