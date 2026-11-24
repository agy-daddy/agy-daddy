import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ThreeColumnShell } from '../layout/ThreeColumnShell';
import type { ProjectGroup, ProjectItem, SessionSummary } from '../types';
import {
  evaluateEventVisibility,
  partitionTimelineEvents,
  SessionSidebar,
  type VisibilityDecision,
} from './index';

function makeSession(overrides: Partial<SessionSummary> & { cascadeId: string }): SessionSummary {
  return {
    title: overrides.cascadeId,
    summary: '',
    status: 'CASCADE_RUN_STATUS_IDLE',
    stepCount: 3,
    lastModifiedTime: '2026-11-24T05:00:00Z',
    createdTime: '2026-11-24T04:00:00Z',
    workspaceUri: null,
    gitRootUri: null,
    repoName: null,
    branchName: null,
    workspaces: [],
    ...overrides,
  };
}

const sampleGroups: ProjectGroup[] = [
  { id: 'grp-work', name: 'Work', sortOrder: 1, collapsed: false },
  { id: 'grp-lab', name: 'Lab', sortOrder: 2, collapsed: true },
];

const sampleProjects: ProjectItem[] = [
  {
    id: 'proj-alpha',
    name: 'Alpha App',
    rootPath: '/Users/dev/alpha',
    groupId: 'grp-work',
    sessionCount: 2,
  },
  {
    id: 'proj-beta',
    name: 'Beta Implicit',
    rootPath: '/Users/dev/beta',
    groupId: null,
    implicit: true,
    sessionCount: 1,
  },
  {
    id: 'proj-lab',
    name: 'Lab Experiment',
    rootPath: '/Users/dev/lab',
    groupId: 'grp-lab',
    sessionCount: 0,
  },
];

describe('harness index visibility exports', () => {
  it('re-exports evaluateEventVisibility, partitionTimelineEvents, and VisibilityDecision', () => {
    const decision: VisibilityDecision = evaluateEventVisibility({
      seq: 1,
      kind: 'system',
      status: 'done',
      rawType: 'SYSTEM',
      payload: { message: '[swarm] internal update' },
    });
    expect(decision.visibility).toBe('hidden_by_default');
    const partitioned = partitionTimelineEvents([]);
    expect(partitioned).toEqual({ visibleEvents: [], hiddenCount: 0 });
  });
});

describe('SessionSidebar', () => {
  it('renders clean resting session rows without repo/branch/step clutter, shows 4-dot running and unread indicators', () => {
    const now = Date.now();
    const threeMinutesAgo = new Date(now - 3 * 60 * 1000).toISOString();
    const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000).toISOString();

    const sessions: SessionSummary[] = [
      makeSession({
        cascadeId: 's-running',
        title: 'Running Task',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        isRunning: true,
        unread: true,
        stepCount: 12,
        repoName: 'secret-repo',
        branchName: 'feat/clean-ui',
        workspaceUri: 'file:///Users/dev/secret-ws',
        lastModifiedTime: threeMinutesAgo,
      }),
      makeSession({
        cascadeId: 's-unread',
        title: 'Unread Done Task',
        status: 'CASCADE_RUN_STATUS_IDLE',
        unread: true,
        stepCount: 7,
        repoName: 'alpha-repo',
        branchName: 'main',
        lastCompletedTime: threeMinutesAgo,
        lastModifiedTime: twoHoursAgo,
      }),
      makeSession({
        cascadeId: 's-read',
        title: 'Read Done Task',
        status: 'CASCADE_RUN_STATUS_IDLE',
        unread: false,
        stepCount: 4,
        lastModifiedTime: twoHoursAgo,
      }),
    ];

    render(
      <SessionSidebar
        sessions={sessions}
        activeSessionId="s-unread"
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        onAssignSessionProject={vi.fn()}
      />,
    );

    const runningRow = document.querySelector('[data-session-id="s-running"]') as HTMLElement;
    const unreadRow = document.querySelector('[data-session-id="s-unread"]') as HTMLElement;
    const readRow = document.querySelector('[data-session-id="s-read"]') as HTMLElement;

    expect(runningRow).toHaveTextContent('Running Task');
    expect(runningRow).not.toHaveTextContent('secret-repo');
    expect(runningRow).not.toHaveTextContent('feat/clean-ui');
    expect(runningRow).not.toHaveTextContent('secret-ws');
    expect(runningRow).not.toHaveTextContent('12 steps');
    expect(screen.queryByTestId('assign-project-s-running')).not.toBeInTheDocument();

    expect(within(runningRow).getByTestId('session-running-s-running')).toBeInTheDocument();
    expect(within(runningRow).queryByTestId('session-unread-s-running')).not.toBeInTheDocument();

    expect(within(unreadRow).getByTestId('session-unread-s-unread')).toBeInTheDocument();
    expect(within(unreadRow).queryByTestId('session-running-s-unread')).not.toBeInTheDocument();
    expect(unreadRow).toHaveAttribute('data-active', 'true');

    expect(within(readRow).queryByTestId('session-unread-s-read')).not.toBeInTheDocument();
    expect(within(readRow).queryByTestId('session-running-s-read')).not.toBeInTheDocument();
  });

  it('orders pinned sessions by pinnedAt desc with project subtitle, and toggles pin without selecting row', () => {
    const onSelectSession = vi.fn();
    const onCreateSession = vi.fn();
    const onPinSession = vi.fn();

    const sessions: SessionSummary[] = [
      makeSession({
        cascadeId: 's-regular-old',
        title: 'Regular Old',
        lastModifiedTime: '2026-11-24T01:00:00Z',
      }),
      makeSession({
        cascadeId: 's-pin-earlier',
        title: 'Pinned Earlier',
        pinned: true,
        pinnedAt: '2026-11-24T06:00:00Z',
        projectId: null,
        lastModifiedTime: '2026-11-24T02:00:00Z',
      }),
      makeSession({
        cascadeId: 's-regular-new',
        title: 'Regular New',
        lastModifiedTime: '2026-11-24T09:00:00Z',
      }),
      makeSession({
        cascadeId: 's-pin-later',
        title: 'Pinned Later',
        pinned: true,
        pinnedAt: '2026-11-24T08:00:00Z',
        projectId: 'proj-alpha',
        lastModifiedTime: '2026-11-24T01:30:00Z',
      }),
    ];

    render(
      <SessionSidebar
        sessions={sessions}
        projects={sampleProjects}
        projectGroups={sampleGroups}
        onSelectSession={onSelectSession}
        onCreateSession={onCreateSession}
        onPinSession={onPinSession}
      />,
    );

    const pinnedSection = screen.getByTestId('pinned-sessions-section');
    const pinnedItems = within(pinnedSection).getAllByRole('listitem');
    expect(pinnedItems.map((el) => el.getAttribute('data-session-id'))).toEqual([
      's-pin-later',
      's-pin-earlier',
    ]);
    expect(pinnedItems[0]).toHaveTextContent('Alpha App');
    expect(pinnedItems[1]).toHaveTextContent('No project (Standalone)');

    const allItems = screen.getAllByRole('listitem');
    expect(allItems.map((el) => el.getAttribute('data-session-id'))).toEqual([
      's-pin-later',
      's-pin-earlier',
      's-regular-new',
      's-regular-old',
    ]);

    fireEvent.click(screen.getByTestId('pin-session-s-regular-new'));
    expect(onPinSession).toHaveBeenCalledWith('s-regular-new', true);
    expect(onSelectSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('pin-session-s-pin-later'));
    expect(onPinSession).toHaveBeenCalledWith('s-pin-later', false);
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it('renders nested project->session tree expanded by default, shows empty project hint, and collapses/expands projects on click', () => {
    const sessions: SessionSummary[] = [
      makeSession({ cascadeId: 's-alpha-1', title: 'Alpha One', projectId: 'proj-alpha' }),
      makeSession({ cascadeId: 's-standalone-1', title: 'Standalone One', projectId: null }),
    ];

    render(
      <SessionSidebar
        sessions={sessions}
        projects={sampleProjects}
        projectGroups={sampleGroups}
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
      />,
    );

    const alphaSessionsContainer = screen.getByTestId('project-sessions-proj-alpha');
    expect(within(alphaSessionsContainer).getByText('Alpha One')).toBeInTheDocument();

    const betaSessionsContainer = screen.getByTestId('project-sessions-proj-beta');
    expect(within(betaSessionsContainer).getByText('No sessions in this project')).toBeInTheDocument();

    const standaloneSection = screen.getByTestId('standalone-sessions-section');
    expect(within(standaloneSection).getByText('Standalone One')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('project-item-proj-alpha'));
    expect(screen.queryByTestId('project-sessions-proj-alpha')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('project-item-proj-alpha'));
    expect(screen.getByTestId('project-sessions-proj-alpha')).toBeInTheDocument();
  });

  it('opens filter drawer for search, standalone filter, and internal sessions toggle', () => {
    const onSelectProjectFilter = vi.fn();
    const onToggleIncludeInternal = vi.fn();

    const sessions: SessionSummary[] = [
      makeSession({ cascadeId: 's-alpha-1', title: 'Alpha Auth', projectId: 'proj-alpha' }),
      makeSession({ cascadeId: 's-alpha-2', title: 'Alpha Billing', projectId: 'proj-alpha' }),
      makeSession({ cascadeId: 's-standalone', title: 'Quick Scratch', projectId: null }),
    ];

    const { rerender } = render(
      <SessionSidebar
        sessions={sessions}
        projects={sampleProjects}
        projectGroups={sampleGroups}
        selectedProjectFilter="all"
        onSelectProjectFilter={onSelectProjectFilter}
        hiddenInternalCount={3}
        includeInternal={false}
        onToggleIncludeInternal={onToggleIncludeInternal}
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('sidebar-filter-drawer')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('sidebar-filter-toggle'));
    expect(screen.getByTestId('sidebar-filter-drawer')).toBeInTheDocument();

    expect(screen.getByText('3 internal hidden')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('toggle-internal-sessions'));
    expect(onToggleIncludeInternal).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByTestId('project-filter-none'));
    expect(onSelectProjectFilter).toHaveBeenCalledWith('__none__');

    rerender(
      <SessionSidebar
        sessions={sessions}
        projects={sampleProjects}
        projectGroups={sampleGroups}
        selectedProjectFilter="__none__"
        onSelectProjectFilter={onSelectProjectFilter}
        hiddenInternalCount={3}
        includeInternal={true}
        onToggleIncludeInternal={onToggleIncludeInternal}
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
      />,
    );

    expect(screen.getAllByRole('listitem').map((el) => el.getAttribute('data-session-id'))).toEqual([
      's-standalone',
    ]);

    rerender(
      <SessionSidebar
        sessions={sessions}
        projects={sampleProjects}
        projectGroups={sampleGroups}
        selectedProjectFilter="proj-alpha"
        onSelectProjectFilter={onSelectProjectFilter}
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
      />,
    );

    expect(screen.getByTestId('project-item-proj-alpha')).toHaveAttribute('data-active', 'true');
    expect(screen.getAllByRole('listitem').map((el) => el.getAttribute('data-session-id'))).toEqual([
      's-alpha-1',
      's-alpha-2',
    ]);

    fireEvent.change(screen.getByTestId('session-search-input'), { target: { value: 'billing' } });
    expect(screen.getAllByRole('listitem').map((el) => el.getAttribute('data-session-id'))).toEqual([
      's-alpha-2',
    ]);

    fireEvent.click(screen.getByTestId('project-filter-all'));
    expect(onSelectProjectFilter).toHaveBeenCalledWith('all');
  });

  it('renders collapsible project groups, hides collapsed children, and invokes onToggleGroupCollapsed', () => {
    const onToggleGroupCollapsed = vi.fn();
    const onDeleteProject = vi.fn();
    const onUpdateProject = vi.fn();

    render(
      <SessionSidebar
        sessions={[]}
        projects={sampleProjects}
        projectGroups={sampleGroups}
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        onToggleGroupCollapsed={onToggleGroupCollapsed}
        onDeleteProject={onDeleteProject}
        onUpdateProject={onUpdateProject}
      />,
    );

    const workGroup = screen.getByTestId('project-group-grp-work');
    const labGroup = screen.getByTestId('project-group-grp-lab');

    expect(workGroup).toHaveAttribute('data-collapsed', 'false');
    expect(within(workGroup).getByTestId('project-item-proj-alpha')).toBeInTheDocument();

    expect(labGroup).toHaveAttribute('data-collapsed', 'true');
    expect(within(labGroup).queryByTestId('project-item-proj-lab')).not.toBeInTheDocument();

    expect(screen.getByTestId('project-item-proj-beta')).toBeInTheDocument();
    expect(screen.queryByTestId('delete-project-proj-beta')).not.toBeInTheDocument();
    expect(screen.getByTestId('delete-project-proj-alpha')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('toggle-group-grp-work'));
    expect(onToggleGroupCollapsed).toHaveBeenCalledWith('grp-work', true);

    fireEvent.click(screen.getByTestId('toggle-group-grp-lab'));
    expect(onToggleGroupCollapsed).toHaveBeenCalledWith('grp-lab', false);

    fireEvent.click(screen.getByTestId('delete-project-proj-alpha'));
    expect(onDeleteProject).toHaveBeenCalledWith('proj-alpha');
  });

  it('creates a project and a group via inline forms without window.prompt', async () => {
    const onCreateProject = vi.fn().mockResolvedValue(undefined);
    const onCreateGroup = vi.fn().mockResolvedValue(undefined);

    render(
      <SessionSidebar
        sessions={[]}
        projects={sampleProjects}
        projectGroups={sampleGroups}
        defaultSessionPath="/Users/dev/workspace"
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        onCreateProject={onCreateProject}
        onCreateGroup={onCreateGroup}
      />,
    );

    fireEvent.click(screen.getByTestId('open-new-project-btn'));
    const pathInput = screen.getByTestId('new-project-path') as HTMLInputElement;
    expect(pathInput.value).toBe('/Users/dev/workspace');

    fireEvent.change(screen.getByTestId('new-project-name'), { target: { value: 'Gamma Service' } });
    fireEvent.change(pathInput, { target: { value: '/Users/dev/gamma' } });
    fireEvent.change(screen.getByTestId('new-project-group'), { target: { value: 'grp-work' } });
    fireEvent.click(screen.getByTestId('new-project-createdir'));
    fireEvent.click(screen.getByTestId('create-project-submit'));

    await waitFor(() => {
      expect(onCreateProject).toHaveBeenCalledWith({
        name: 'Gamma Service',
        rootPath: '/Users/dev/gamma',
        groupId: 'grp-work',
        createDir: true,
      });
    });

    fireEvent.click(screen.getByTestId('open-new-group-btn'));
    fireEvent.change(screen.getByTestId('new-group-name'), { target: { value: 'Infra' } });
    fireEvent.click(screen.getByTestId('create-group-submit'));

    await waitFor(() => {
      expect(onCreateGroup).toHaveBeenCalledWith('Infra');
    });
  });

  it('orders header action buttons strictly as Filter -> New Group -> New Project -> New Session without duplicates', () => {
    render(
      <SessionSidebar
        sessions={[]}
        projects={sampleProjects}
        projectGroups={sampleGroups}
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        onCreateGroup={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    const actionsBar = screen.getByTestId('sidebar-header-actions');
    const buttons = within(actionsBar).getAllByRole('button');
    expect(buttons.map((btn) => btn.getAttribute('data-testid'))).toEqual([
      'sidebar-filter-toggle',
      'open-new-group-btn',
      'open-new-project-btn',
      'new-session-btn',
    ]);

    fireEvent.click(screen.getByTestId('sidebar-filter-toggle'));
    expect(screen.getByTestId('sidebar-filter-drawer')).toBeInTheDocument();
    expect(screen.getAllByTestId('open-new-group-btn')).toHaveLength(1);
  });

  it('starts a standalone session vs a session inside a project, and reassigns a session project via session-actions menu', () => {
    const onCreateSession = vi.fn();
    const onSelectSession = vi.fn();
    const onSelectProjectFilter = vi.fn();
    const onAssignSessionProject = vi.fn();

    const sessions: SessionSummary[] = [
      makeSession({ cascadeId: 's-1', title: 'Session One', projectId: 'proj-alpha' }),
    ];

    render(
      <SessionSidebar
        sessions={sessions}
        projects={sampleProjects}
        projectGroups={sampleGroups}
        onSelectSession={onSelectSession}
        onCreateSession={onCreateSession}
        onSelectProjectFilter={onSelectProjectFilter}
        onAssignSessionProject={onAssignSessionProject}
      />,
    );

    fireEvent.click(screen.getByTestId('new-session-btn'));
    expect(onCreateSession).toHaveBeenCalledWith({ standalone: true });

    fireEvent.click(screen.getByTestId('project-new-session-proj-alpha'));
    expect(onCreateSession).toHaveBeenCalledWith({
      projectId: 'proj-alpha',
      workspaceUri: 'file:///Users/dev/alpha',
    });
    expect(onSelectProjectFilter).not.toHaveBeenCalled();

    expect(screen.queryByTestId('assign-project-s-1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('session-actions-s-1'));
    expect(onSelectSession).not.toHaveBeenCalled();

    const assignSelect = screen.getByTestId('assign-project-s-1') as HTMLSelectElement;
    expect(assignSelect.value).toBe('proj-alpha');

    fireEvent.change(assignSelect, { target: { value: 'proj-beta' } });
    expect(onAssignSessionProject).toHaveBeenCalledWith('s-1', 'proj-beta');
    expect(onSelectSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('session-actions-s-1'));
    fireEvent.change(screen.getByTestId('assign-project-s-1'), { target: { value: '' } });
    expect(onAssignSessionProject).toHaveBeenCalledWith('s-1', null);
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it('displays synced App projects even with 0 sessions, shows accurate counts, creates sessions, and moves to groups', () => {
    const onCreateSession = vi.fn();
    const onUpdateProject = vi.fn();

    const syncedProjects: ProjectItem[] = [
      {
        id: 'app-proj-zero',
        name: 'App Synced Empty',
        rootPath: '/Users/dev/app-empty',
        groupId: null,
        implicit: false,
        syncedFromApp: true,
        source: 'app',
        sessionCount: 0,
      },
      {
        id: 'app-proj-busy',
        name: 'App Synced Busy',
        rootPath: '/Users/dev/app-busy',
        groupId: 'grp-work',
        implicit: true,
        syncedFromApp: true,
        source: 'app',
        sessionCount: 5,
      },
    ];

    const sessions: SessionSummary[] = [
      makeSession({ cascadeId: 's-busy-1', title: 'Busy One', projectId: 'app-proj-busy' }),
    ];

    render(
      <SessionSidebar
        sessions={sessions}
        projects={syncedProjects}
        projectGroups={sampleGroups}
        onSelectSession={vi.fn()}
        onCreateSession={onCreateSession}
        onUpdateProject={onUpdateProject}
      />,
    );

    expect(screen.getByTestId('sidebar-project-count')).toHaveTextContent('2');
    expect(screen.getByTestId('sidebar-session-count')).toHaveTextContent('1');

    const emptyProject = screen.getByTestId('project-item-app-proj-zero');
    expect(emptyProject).toHaveAttribute('data-source', 'app');
    expect(screen.getByTestId('project-app-badge-app-proj-zero')).toHaveTextContent('App');
    expect(screen.getByTestId('project-session-count-app-proj-zero')).toHaveTextContent('0');
    expect(screen.getByTestId('project-session-count-app-proj-busy')).toHaveTextContent('5');

    fireEvent.click(screen.getByTestId('project-new-session-app-proj-zero'));
    expect(onCreateSession).toHaveBeenCalledWith({
      projectId: 'app-proj-zero',
      workspaceUri: 'file:///Users/dev/app-empty',
    });

    const moveSelect = screen.getByTestId('move-project-group-app-proj-busy') as HTMLSelectElement;
    fireEvent.change(moveSelect, { target: { value: 'grp-lab' } });
    expect(onUpdateProject).toHaveBeenCalledWith('app-proj-busy', { groupId: 'grp-lab' });

    fireEvent.click(screen.getByTestId('sidebar-filter-toggle'));
    fireEvent.change(screen.getByTestId('session-search-input'), { target: { value: 'app-empty' } });
    expect(screen.getByTestId('project-item-app-proj-zero')).toBeInTheDocument();
  });

  it('sorts active/running/unread projects first, folds 4+ empty App projects, and supports rename & quick filters', () => {
    const onUpdateProject = vi.fn();
    const onRenameGroup = vi.fn();

    const manyProjects: ProjectItem[] = [
      { id: 'empty-1', name: 'Empty App 1', rootPath: '/ws/e1', groupId: null, syncedFromApp: true, source: 'app', sessionCount: 20 },
      { id: 'empty-2', name: 'Empty App 2', rootPath: '/ws/e2', groupId: null, syncedFromApp: true, source: 'app', sessionCount: 5 },
      { id: 'empty-3', name: 'Empty App 3', rootPath: '/ws/e3', groupId: null, syncedFromApp: true, source: 'app', sessionCount: 3 },
      { id: 'empty-4', name: 'Empty App 4', rootPath: '/ws/e4', groupId: null, syncedFromApp: true, source: 'app', sessionCount: 0 },
      { id: 'busy-app', name: 'Busy App', rootPath: '/ws/busy', groupId: null, syncedFromApp: true, source: 'app', sessionCount: 4 },
      { id: 'running-app', name: 'Running App', rootPath: '/ws/run', groupId: null, syncedFromApp: true, source: 'app', sessionCount: 1 },
    ];

    const sessions: SessionSummary[] = [
      makeSession({ cascadeId: 's-unread-1', title: 'Unread Session', projectId: 'busy-app', unread: true }),
      makeSession({ cascadeId: 's-run-1', title: 'Running Session', projectId: 'running-app', isRunning: true, status: 'CASCADE_RUN_STATUS_RUNNING' }),
    ];

    render(
      <SessionSidebar
        sessions={sessions}
        projects={manyProjects}
        projectGroups={sampleGroups}
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        onUpdateProject={onUpdateProject}
        onRenameGroup={onRenameGroup}
      />,
    );

    // Running project and Unread project appear before empty projects; 4 empty App projects fold cleanly
    expect(screen.getByTestId('project-item-running-app')).toBeInTheDocument();
    expect(screen.getByTestId('project-item-busy-app')).toBeInTheDocument();
    expect(screen.queryByTestId('project-item-empty-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('quiet-projects-toggle')).toHaveTextContent('Other projects (4)');

    fireEvent.click(screen.getByTestId('quiet-projects-toggle'));
    expect(screen.getByTestId('project-item-empty-1')).toBeInTheDocument();

    // Quick attention filters
    fireEvent.click(screen.getByTestId('sidebar-filter-running'));
    expect(screen.getAllByRole('listitem').map((el) => el.getAttribute('data-session-id'))).toEqual(['s-run-1']);
    fireEvent.click(screen.getByTestId('sidebar-filter-unread'));
    expect(screen.getAllByRole('listitem').map((el) => el.getAttribute('data-session-id'))).toEqual(['s-unread-1']);

    // Inline project rename
    fireEvent.click(screen.getByTestId('rename-project-busy-app'));
    const renameProjInput = screen.getByLabelText('Rename project') as HTMLInputElement;
    fireEvent.change(renameProjInput, { target: { value: 'Busy Renamed' } });
    fireEvent.submit(renameProjInput.closest('form')!);
    expect(onUpdateProject).toHaveBeenCalledWith('busy-app', { name: 'Busy Renamed' });

    // Inline group rename
    fireEvent.click(screen.getByTestId('rename-group-grp-work'));
    const renameGroupInput = screen.getByLabelText('Rename group') as HTMLInputElement;
    fireEvent.change(renameGroupInput, { target: { value: 'Core Work' } });
    fireEvent.submit(renameGroupInput.closest('form')!);
    expect(onRenameGroup).toHaveBeenCalledWith('grp-work', 'Core Work');
  });
});

describe('ThreeColumnShell bottom-left settings footer', () => {
  it('pins the bottom-left settings entry in both expanded drawer and collapsed rail', () => {
    const onOpenSettings = vi.fn();

    render(
      <ThreeColumnShell
        viewportWidth={1440}
        sidebar={
          <SessionSidebar
            sessions={[]}
            projects={sampleProjects}
            projectGroups={sampleGroups}
            onSelectSession={vi.fn()}
            onCreateSession={vi.fn()}
          />
        }
        onOpenSettings={onOpenSettings}
        center={<div>Center</div>}
      />,
    );

    const expandedDrawer = screen.getByTestId('shell-sidebar-drawer');
    expect(expandedDrawer).toHaveAttribute('aria-hidden', 'false');
    const expandedFooter = within(expandedDrawer).getByTestId('sidebar-footer');
    const expandedSettingsBtn = within(expandedFooter).getByTestId('bottom-left-settings-btn');
    expect(expandedSettingsBtn).toHaveTextContent('Settings');
    fireEvent.click(expandedSettingsBtn);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('toggle-sidebar-btn'));

    expect(screen.getByTestId('shell-sidebar')).toHaveAttribute('data-collapsed', 'true');
    const collapsedRail = screen.getByTestId('shell-sidebar-rail');
    expect(collapsedRail).toHaveAttribute('aria-hidden', 'false');
    const collapsedFooter = within(collapsedRail).getByTestId('sidebar-collapsed-footer');
    const collapsedSettingsBtn = within(collapsedFooter).getByTestId('bottom-left-settings-btn');
    fireEvent.click(collapsedSettingsBtn);
    expect(onOpenSettings).toHaveBeenCalledTimes(2);
  });

  it('supports custom sidebarFooter slot in the expanded drawer', () => {
    render(
      <ThreeColumnShell
        viewportWidth={1440}
        sidebar={<div>Sidebar</div>}
        sidebarFooter={<button type="button" data-testid="custom-footer-btn">Custom Settings</button>}
        center={<div>Center</div>}
      />,
    );

    const footer = screen.getByTestId('sidebar-footer');
    expect(within(footer).getByTestId('custom-footer-btn')).toHaveTextContent('Custom Settings');
  });
});
