import { fireEvent, render, screen } from '@testing-library/react';
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
});
