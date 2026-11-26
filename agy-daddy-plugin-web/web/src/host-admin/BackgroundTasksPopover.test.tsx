import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { BackgroundTasksPopover } from './BackgroundTasksPopover';
import { apiClient } from '../api/client';
import type { BackgroundTasksListResponse } from '../types';

const SAMPLE_TASKS: BackgroundTasksListResponse = {
  ok: true,
  runningCount: 1,
  serverTime: Date.now(),
  running: [
    {
      taskId: 'cmd:sess-1:step-2',
      kind: 'command',
      title: 'npm run verify',
      status: 'running',
      startedAt: new Date(Date.now() - 5000).toISOString(),
      endedAt: null,
      durationMs: 5000,
      sessionId: 'sess-1',
      cwd: '/repo',
      exitCode: null,
      stopCapability: {
        canStop: true,
        requiredPermission: 'L1',
        stopScope: 'cascade_invocation',
      },
    },
  ],
  recent: [
    {
      taskId: 'pty:t1',
      kind: 'pty',
      title: 'Terminal · zsh',
      status: 'done',
      startedAt: new Date(Date.now() - 12000).toISOString(),
      endedAt: new Date(Date.now() - 2000).toISOString(),
      durationMs: 10000,
      sessionId: null,
      cwd: '/repo',
      exitCode: 0,
      stopCapability: {
        canStop: false,
        requiredPermission: 'L2',
        stopScope: 'none',
      },
    },
  ],
};

describe('BackgroundTasksPopover', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('displays running and recent tasks, opens 64KB truncated detail log, and handles alreadyFinished stop', async () => {
    vi.spyOn(apiClient, 'getBackgroundTaskDetail').mockResolvedValue({
      ok: true,
      task: {
        ...SAMPLE_TASKS.running[0],
        logText: 'line 1\nline 2\n',
        truncated: true,
        totalBytes: 120_000,
        retainedBytes: 65536,
      },
    });
    const onStopTask = vi.fn().mockResolvedValue({
      ok: true,
      taskId: 'cmd:sess-1:step-2',
      alreadyFinished: true,
      status: 'done',
    });
    const onSelectSession = vi.fn();

    render(
      <I18nProvider defaultLocale="en">
        <BackgroundTasksPopover
          tasksData={SAMPLE_TASKS}
          channel="loopback"
          permissionLevel="L2"
          onStopTask={onStopTask}
          onSelectSession={onSelectSession}
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByTestId('task-row-cmd:sess-1:step-2')).toBeInTheDocument();
    expect(screen.getByTestId('task-row-pty:t1')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('task-stop-btn-cmd:sess-1:step-2'));
    expect(screen.getByTestId('tasks-stop-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('tasks-stop-confirm')).toHaveTextContent('aborts the linked session run');

    fireEvent.click(screen.getByTestId('tasks-stop-confirm-submit'));
    await waitFor(() => {
      expect(onStopTask).toHaveBeenCalledWith('cmd:sess-1:step-2');
      expect(screen.getByTestId('tasks-neutral-notice')).toHaveTextContent('Task already finished');
    });

    fireEvent.click(screen.getByTestId('task-detail-btn-cmd:sess-1:step-2'));
    await waitFor(() => {
      expect(screen.getByTestId('task-detail-view')).toBeInTheDocument();
      expect(screen.getByTestId('task-log-truncated-banner')).toBeInTheDocument();
      expect(screen.getByTestId('task-detail-log')).toHaveTextContent('line 1');
    });

    fireEvent.click(screen.getByTestId('task-jump-session-btn'));
    expect(onSelectSession).toHaveBeenCalledWith('sess-1');
  });

  it('disables stop buttons on L0 tier', () => {
    render(
      <I18nProvider defaultLocale="en">
        <BackgroundTasksPopover
          tasksData={SAMPLE_TASKS}
          channel="lan"
          permissionLevel="L0"
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByTestId('task-stop-btn-cmd:sess-1:step-2')).toBeDisabled();
  });

  it('supports project/session filters, linked convergence, quick chips, and clear empty state', () => {
    const onFiltersChange = vi.fn();
    const filteredResponse: BackgroundTasksListResponse = {
      ok: true,
      runningCount: 1,
      totalRunningCount: 3,
      serverTime: Date.now(),
      running: [
        {
          ...SAMPLE_TASKS.running[0],
          projectPath: '/work/alpha',
          projectName: 'Alpha',
          sessionTitle: 'Alpha Session',
        },
      ],
      recent: [
        {
          ...SAMPLE_TASKS.recent[0],
          taskId: 'cmd:sess-2:step-1',
          sessionId: 'sess-2',
          sessionTitle: 'Beta Session',
          projectPath: '/work/beta',
          projectName: 'Beta',
        },
      ],
      filters: {
        projects: [
          { key: '/work/alpha', name: 'Alpha', path: '/work/alpha', count: 1 },
          { key: '/work/beta', name: 'Beta', path: '/work/beta', count: 1 },
        ],
        sessions: [
          { id: 'sess-1', title: 'Alpha Session', projectPath: '/work/alpha', count: 1 },
          { id: 'sess-2', title: 'Beta Session', projectPath: '/work/beta', count: 1 },
        ],
      },
    };

    const { rerender } = render(
      <I18nProvider defaultLocale="en">
        <BackgroundTasksPopover
          tasksData={filteredResponse}
          activeSessionId="sess-1"
          activeSessionTitle="Alpha Session"
          activeProjectPath="/work/alpha"
          activeProjectName="Alpha"
          filterProject=""
          filterSessionId=""
          onFiltersChange={onFiltersChange}
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByTestId('tasks-filter-current-project'));
    expect(onFiltersChange).toHaveBeenLastCalledWith({ project: '/work/alpha', sessionId: '' });

    // Re-render with project=/work/alpha selected: session options converge to Alpha Session only
    rerender(
      <I18nProvider defaultLocale="en">
        <BackgroundTasksPopover
          tasksData={filteredResponse}
          activeSessionId="sess-1"
          activeSessionTitle="Alpha Session"
          activeProjectPath="/work/alpha"
          activeProjectName="Alpha"
          filterProject="/work/alpha"
          filterSessionId=""
          onFiltersChange={onFiltersChange}
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    const sessionSelect = screen.getByTestId('tasks-filter-session-select');
    expect(sessionSelect).toHaveTextContent('Alpha Session');
    expect(sessionSelect).not.toHaveTextContent('Beta Session');

    fireEvent.click(screen.getByTestId('tasks-filter-current-session'));
    expect(onFiltersChange).toHaveBeenLastCalledWith({ project: '/work/alpha', sessionId: 'sess-1' });

    // Empty filtered state exposes Clear filters action
    rerender(
      <I18nProvider defaultLocale="en">
        <BackgroundTasksPopover
          tasksData={{ ...filteredResponse, runningCount: 0, running: [], recent: [] }}
          activeSessionId="sess-1"
          activeProjectPath="/work/alpha"
          filterProject="/work/alpha"
          filterSessionId="sess-1"
          onFiltersChange={onFiltersChange}
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByTestId('tasks-empty')).toHaveTextContent(
      'No background tasks match the current filters.',
    );
    fireEvent.click(screen.getByTestId('tasks-empty-clear-btn'));
    expect(onFiltersChange).toHaveBeenLastCalledWith({ project: '', sessionId: '' });
  });
});
