import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { api } from '../store/api';
import { BackgroundTasksSheet } from './BackgroundTasksSheet';

describe('BackgroundTasksSheet filtering & global count preservation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('filters by project and session, converges sessions, clears filters, and preserves totalRunningCount', async () => {
    const onRunningCountChange = vi.fn();
    const listSpy = vi.spyOn(api, 'listTasks').mockImplementation(async (params) => {
      if (params?.project === '/work/alpha' && params?.sessionId === 'sess-1') {
        return {
          ok: true,
          runningCount: 0,
          totalRunningCount: 4,
          running: [],
          recent: [],
          filters: {
            projects: [
              { key: '/work/alpha', name: 'Alpha', path: '/work/alpha', count: 1 },
              { key: '/work/beta', name: 'Beta', path: '/work/beta', count: 1 },
            ],
            sessions: [
              { id: 'sess-1', title: 'Alpha Sess', projectPath: '/work/alpha', count: 1 },
              { id: 'sess-2', title: 'Beta Sess', projectPath: '/work/beta', count: 1 },
            ],
          },
        };
      }
      if (params?.project === '/work/alpha') {
        return {
          ok: true,
          runningCount: 1,
          totalRunningCount: 4,
          running: [
            {
              id: 'cmd:sess-1:0',
              kind: 'command',
              title: 'npm test',
              status: 'running',
              sessionId: 'sess-1',
              sessionTitle: 'Alpha Sess',
              projectPath: '/work/alpha',
              projectName: 'Alpha',
              startedAt: Date.now() - 1000,
              stopCapability: { canStop: true, requiredLevel: 'L1' },
            },
          ],
          recent: [],
          filters: {
            projects: [
              { key: '/work/alpha', name: 'Alpha', path: '/work/alpha', count: 1 },
              { key: '/work/beta', name: 'Beta', path: '/work/beta', count: 1 },
            ],
            sessions: [
              { id: 'sess-1', title: 'Alpha Sess', projectPath: '/work/alpha', count: 1 },
              { id: 'sess-2', title: 'Beta Sess', projectPath: '/work/beta', count: 1 },
            ],
          },
        };
      }
      return {
        ok: true,
        runningCount: 2,
        totalRunningCount: 4,
        running: [
          {
            id: 'cmd:sess-1:0',
            kind: 'command',
            title: 'npm test',
            status: 'running',
            sessionId: 'sess-1',
            sessionTitle: 'Alpha Sess',
            projectPath: '/work/alpha',
            projectName: 'Alpha',
            startedAt: Date.now() - 1000,
            stopCapability: { canStop: true, requiredLevel: 'L1' },
          },
          {
            id: 'cmd:sess-2:0',
            kind: 'command',
            title: 'npm run build',
            status: 'running',
            sessionId: 'sess-2',
            sessionTitle: 'Beta Sess',
            projectPath: '/work/beta',
            projectName: 'Beta',
            startedAt: Date.now() - 2000,
            stopCapability: { canStop: true, requiredLevel: 'L1' },
          },
        ],
        recent: [],
        filters: {
          projects: [
            { key: '/work/alpha', name: 'Alpha', path: '/work/alpha', count: 1 },
            { key: '/work/beta', name: 'Beta', path: '/work/beta', count: 1 },
          ],
          sessions: [
            { id: 'sess-1', title: 'Alpha Sess', projectPath: '/work/alpha', count: 1 },
            { id: 'sess-2', title: 'Beta Sess', projectPath: '/work/beta', count: 1 },
          ],
        },
      };
    });

    render(
      <I18nProvider locale="en">
        <BackgroundTasksSheet
          open={true}
          activeSessionId="sess-1"
          activeSessionTitle="Alpha Sess"
          activeProjectPath="/work/alpha"
          activeProjectName="Alpha"
          onRunningCountChange={onRunningCountChange}
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('bg-task-cmd:sess-1:0')).toBeTruthy());
    expect(screen.getByTestId('bg-task-cmd:sess-2:0')).toBeTruthy();
    expect(onRunningCountChange).toHaveBeenLastCalledWith(4);

    fireEvent.click(screen.getByTestId('bg-tasks-filter-current-project'));
    await waitFor(() =>
      expect(listSpy).toHaveBeenLastCalledWith({ project: '/work/alpha', sessionId: undefined }),
    );
    await waitFor(() => expect(screen.queryByTestId('bg-task-cmd:sess-2:0')).toBeNull());
    // Session select converges to Alpha Sess only
    const sessSelect = screen.getByTestId('bg-tasks-filter-session-select');
    expect(sessSelect.textContent).toContain('Alpha Sess');
    expect(sessSelect.textContent).not.toContain('Beta Sess');
    expect(onRunningCountChange).toHaveBeenLastCalledWith(4);

    // Combine with Current session -> triggers empty filtered state while preserving global running count = 4
    fireEvent.click(screen.getByTestId('bg-tasks-filter-current-session'));
    await waitFor(() =>
      expect(listSpy).toHaveBeenLastCalledWith({ project: '/work/alpha', sessionId: 'sess-1' }),
    );
    await waitFor(() => expect(screen.getByTestId('bg-tasks-empty')).toBeTruthy());
    expect(onRunningCountChange).toHaveBeenLastCalledWith(4);

    // Clear filters from empty state restores full list
    fireEvent.click(screen.getByTestId('bg-tasks-empty-clear'));
    await waitFor(() => expect(screen.getByTestId('bg-task-cmd:sess-2:0')).toBeTruthy());
  });
});
