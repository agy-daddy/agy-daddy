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
});
