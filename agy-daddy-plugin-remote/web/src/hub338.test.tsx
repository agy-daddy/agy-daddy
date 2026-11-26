import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeftDrawer, type LeftDrawerProps } from './drawers/LeftDrawer';
import { RightDrawer } from './drawers/RightDrawer';
import { I18nProvider } from './i18n';
import { SwipeDrawerShell } from './layout/SwipeDrawerShell';
import PtyTerminal, { deriveClientWorktreeKey } from './lazy/PtyTerminal';
import { api } from './store/api';
import { RemoteStoreController } from './store/useRemoteStore';
import { ThemeProvider } from './theme/ThemeProvider';
import type {
  HostProject,
  SessionGroup,
  SessionSummary,
  WorktreeDto
} from './types';

function makeTouchInit(x: number, y: number): TouchEventInit {
  const touch = { identifier: 1, clientX: x, clientY: y } as Touch;
  return {
    bubbles: true,
    cancelable: true,
    touches: [touch],
    targetTouches: [touch],
    changedTouches: [touch]
  };
}

function makeGroup(overrides: Partial<SessionGroup> & { id: string }): SessionGroup {
  return {
    name: overrides.name || overrides.id,
    source: 'user',
    pinned: false,
    collapsed: false,
    order: 0,
    projectIds: [],
    workspaceUris: [],
    sessionIds: [],
    ...overrides
  };
}

function makeProject(overrides: Partial<HostProject> & { id: string }): HostProject {
  return {
    name: overrides.name || overrides.id,
    uri: `file:///ws/${overrides.id}`,
    path: `/ws/${overrides.id}`,
    repoRootPath: `/ws/${overrides.id}`,
    groupId: null,
    pinned: false,
    branchName: 'main',
    sessionCount: 1,
    lastModifiedTime: '2026-11-26T10:00:00Z',
    isMultiWorktree: false,
    worktrees: [],
    ...overrides
  };
}

function makeWorktree(overrides: Partial<WorktreeDto> & { worktreeId: string; path: string }): WorktreeDto {
  return {
    uri: `file://${overrides.path}`,
    displaySubpath: overrides.path,
    branch: 'main',
    displayLabel: overrides.branch || 'main',
    isMain: false,
    bare: false,
    detached: false,
    locked: false,
    prunable: false,
    exists: true,
    status: 'ready',
    collapsed: false,
    allowed: true,
    sessionCount: 0,
    runningCount: 0,
    needsAttentionCount: 0,
    ...overrides
  };
}

function makeSession(overrides: Partial<SessionSummary> & { cascadeId: string }): SessionSummary {
  return {
    title: overrides.title || `Session ${overrides.cascadeId}`,
    summary: '',
    status: 'IDLE',
    needsAttention: false,
    stepCount: 2,
    lastModifiedTime: '2026-11-26T10:00:00Z',
    workspaceUri: 'file:///ws/repo',
    branchName: 'main',
    projectId: 'proj-repo',
    projectName: 'repo',
    ...overrides
  };
}

function makeLeftDrawerProps(overrides: Partial<LeftDrawerProps> = {}): LeftDrawerProps {
  return {
    sessions: [makeSession({ cascadeId: 's1', title: 'Session One' })],
    archivedList: [],
    archivedCount: 0,
    activeSessionId: 's1',
    workspaces: [{ uri: 'file:///ws/repo', name: 'repo', path: '/ws/repo' }],
    groups: [],
    projects: [makeProject({ id: 'proj-repo', name: 'repo', path: '/ws/repo', uri: 'file:///ws/repo' })],
    collapsedNodes: { projects: {}, worktrees: {} },
    orgRevision: 1,
    pins: { sessions: [], projects: [], groups: [] },
    channel: 'loopback',
    permissionLevel: 'L2',
    token: 'tok',
    appearance: 'auto',
    soundAlert: false,
    vibrateAlert: false,
    pushSubscribed: false,
    pushBusy: false,
    onSelectSession: vi.fn(),
    onCreateSession: vi.fn(async () => {}),
    onTogglePin: vi.fn(async () => {}),
    onCreateGroup: vi.fn(async () => {}),
    onRenameGroup: vi.fn(async () => {}),
    onDeleteGroup: vi.fn(async () => {}),
    onToggleGroupCollapsed: vi.fn(async () => {}),
    onToggleNodeCollapsed: vi.fn(async () => {}),
    onAssignProjectGroup: vi.fn(async () => {}),
    onAssignSessionProject: vi.fn(async () => true),
    onRenameProject: vi.fn(async () => {}),
    onRemoveProject: vi.fn(async () => {}),
    onRefreshWorktrees: vi.fn(async () => {}),
    onMutateWorktree: vi.fn(async () => true),
    onOpenWorktreeInRightDrawer: vi.fn(),
    onShowToast: vi.fn(),
    onReorderOrg: vi.fn(async () => {}),
    onArchiveSession: vi.fn(async () => true),
    onDeleteSession: vi.fn(async () => ({ ok: true })),
    onLoadArchived: vi.fn(async () => {}),
    onOpenNewProject: vi.fn(),
    onCycleAppearance: vi.fn(),
    onToggleSound: vi.fn(),
    onToggleVibrate: vi.fn(),
    onTogglePush: vi.fn(),
    onTestPush: vi.fn(),
    onOpenChannels: vi.fn(),
    onClose: vi.fn(),
    ...overrides
  };
}

describe('HUB-338 Stage 4C PWA Collapse Sync, Worktree Subgroups & PTY Isolation', () => {
  beforeEach(() => {
    window.localStorage?.clear();
    delete document.documentElement.dataset.agyDragging;
    delete document.documentElement.dataset.agyDragEndedAt;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.agyDragging;
    delete document.documentElement.dataset.agyDragEndedAt;
  });

  it('syncs SSE group/project/worktree collapse state without stale local shadowing and isolates transient search expansion', async () => {
    const onToggleNodeCollapsed = vi.fn(async () => {});
    const wtMain = makeWorktree({
      worktreeId: 'wt_main',
      path: '/ws/repo',
      branch: 'main',
      isMain: true,
      collapsed: false
    });
    const wtFeat = makeWorktree({
      worktreeId: 'wt_feat',
      path: '/ws/repo-feat',
      branch: 'feat/wt',
      collapsed: true
    });
    const g1 = makeGroup({ id: 'g1', name: 'Core', collapsed: false });
    const p1 = makeProject({
      id: 'proj-repo',
      name: 'repo',
      path: '/ws/repo',
      uri: 'file:///ws/repo',
      groupId: 'g1',
      isMultiWorktree: true,
      worktrees: [wtMain, wtFeat]
    });
    const s1 = makeSession({
      cascadeId: 's1',
      title: 'Main Chat',
      projectId: 'proj-repo',
      worktreeId: 'wt_main',
      worktreePath: '/ws/repo'
    });
    const s2 = makeSession({
      cascadeId: 's2',
      title: 'Secret Feature Chat',
      projectId: 'proj-repo',
      worktreeId: 'wt_feat',
      worktreePath: '/ws/repo-feat',
      workspaceUri: 'file:///ws/repo-feat'
    });

    const initialProps = makeLeftDrawerProps({
      groups: [g1],
      projects: [p1],
      sessions: [s1, s2],
      collapsedNodes: { projects: {}, worktrees: { wt_feat: true } },
      orgRevision: 5,
      onToggleNodeCollapsed
    });

    const { rerender } = render(
      <I18nProvider locale="en">
        <ThemeProvider>
          <LeftDrawer {...initialProps} />
        </ThemeProvider>
      </I18nProvider>
    );

    // 1. Click group collapse locally -> optimistic collapse at rev 5
    fireEvent.click(screen.getByTestId('group-toggle-g1'));
    expect(onToggleNodeCollapsed).toHaveBeenCalledWith('group', 'g1', true);
    expect(screen.queryByTestId('project-toggle-proj-repo')).toBeNull();

    // 2. Remote SSE pushes rev 6 with g1.collapsed=false -> must NOT be shadowed by local click
    rerender(
      <I18nProvider locale="en">
        <ThemeProvider>
          <LeftDrawer
            {...initialProps}
            groups={[{ ...g1, collapsed: false }]}
            orgRevision={6}
          />
        </ThemeProvider>
      </I18nProvider>
    );
    expect(screen.getByTestId('project-toggle-proj-repo')).toBeTruthy();

    // 3. wt_feat is persisted collapsed (s2 hidden), search expands transiently without calling API
    expect(screen.queryByText('Secret Feature Chat')).toBeNull();
    const callsBeforeSearch = onToggleNodeCollapsed.mock.calls.length;
    const searchInput = screen.getByPlaceholderText('Search groups, projects, sessions, or branches...');
    fireEvent.input(searchInput, { target: { value: 'Secret Feature' } });
    expect(screen.getByText('Secret Feature Chat')).toBeTruthy();
    expect(onToggleNodeCollapsed).toHaveBeenCalledTimes(callsBeforeSearch);

    // Clearing search restores persisted collapsed state of wt_feat
    fireEvent.input(searchInput, { target: { value: '' } });
    expect(screen.queryByText('Secret Feature Chat')).toBeNull();

    // 4. Toggle project & worktree collapse persist via onToggleNodeCollapsed
    fireEvent.click(screen.getByTestId('wt-toggle-wt_feat'));
    expect(onToggleNodeCollapsed).toHaveBeenCalledWith('worktree', 'wt_feat', false);
    fireEvent.click(screen.getByTestId('project-toggle-proj-repo'));
    expect(onToggleNodeCollapsed).toHaveBeenCalledWith('project', 'proj-repo', true);
  });

  it('requires confirmation before deleting non-empty group, deletes empty group directly, and supports session project assignment', async () => {
    const onDeleteGroup = vi.fn(async () => {});
    const onAssignSessionProject = vi.fn(async () => true);

    const gEmpty = makeGroup({ id: 'g-empty', name: 'EmptyGroup' });
    const gFull = makeGroup({ id: 'g-full', name: 'FullGroup' });
    const p1 = makeProject({ id: 'p1', name: 'Alpha', groupId: 'g-full' });
    const p2 = makeProject({ id: 'p2', name: 'Beta', groupId: 'g-full' });
    const s1 = makeSession({
      cascadeId: 's-solo',
      title: 'Standalone Chat',
      projectId: null,
      workspaceUri: null
    });

    const { container } = render(
      <I18nProvider locale="en">
        <ThemeProvider>
          <LeftDrawer
            {...makeLeftDrawerProps({
              groups: [gEmpty, gFull],
              projects: [p1, p2],
              sessions: [s1],
              onDeleteGroup,
              onAssignSessionProject
            })}
          />
        </ThemeProvider>
      </I18nProvider>
    );

    // Empty group deletes directly without modal
    fireEvent.click(screen.getByTestId('group-more-g-empty'));
    fireEvent.click(screen.getByTestId('action-delete-group'));
    expect(screen.queryByTestId('delete-group-modal')).toBeNull();
    await waitFor(() => expect(onDeleteGroup).toHaveBeenCalledWith('g-empty'));

    // Non-empty group opens confirm modal with project count
    fireEvent.click(screen.getByTestId('group-more-g-full'));
    fireEvent.click(screen.getByTestId('action-delete-group'));
    const modal = screen.getByTestId('delete-group-modal');
    expect(modal.textContent).toContain('2 project(s)');
    expect(modal.textContent).toContain('Unassigned');
    fireEvent.click(screen.getByText('Cancel'));
    expect(onDeleteGroup).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('group-more-g-full'));
    fireEvent.click(screen.getByTestId('action-delete-group'));
    fireEvent.click(screen.getByTestId('confirm-delete-group-btn'));
    await waitFor(() => expect(onDeleteGroup).toHaveBeenCalledWith('g-full'));

    // Session ActionSheet -> Assign project
    fireEvent.click(screen.getByTestId('session-more-s-solo'));
    fireEvent.click(screen.getByTestId('action-assign-session-project'));
    fireEvent.click(screen.getByTestId('assign-session-proj-p2'));
    await waitFor(() => expect(onAssignSessionProject).toHaveBeenCalledWith('s-solo', 'p2'));

    expect(container.textContent).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('renders Worktree subgroups with status guards, lazy WorktreeSheet, and gesture interlock without horizontal overflow', async () => {
    const onCreateSession = vi.fn(async () => {});
    const onMutateWorktree = vi.fn(async () => true);
    const onSetLeft = vi.fn();

    const wtMain = makeWorktree({
      worktreeId: 'wt_main',
      path: '/ws/repo',
      displaySubpath: 'Main',
      branch: 'main',
      isMain: true
    });
    const wtDetached = makeWorktree({
      worktreeId: 'wt_det',
      path: '/ws/repo-det',
      displaySubpath: '../repo-det',
      branch: '',
      detached: true,
      headShort: 'a1b2c3d',
      locked: true
    });
    const wtMissing = makeWorktree({
      worktreeId: 'wt_miss',
      path: '/ws/repo-dead',
      displaySubpath: '../repo-dead',
      branch: 'feat/dead',
      status: 'missing',
      prunable: true,
      exists: false
    });

    const pFlat = makeProject({
      id: 'p-flat',
      name: 'FlatProj',
      isMultiWorktree: false,
      worktrees: []
    });
    const pMulti = makeProject({
      id: 'p-multi',
      name: 'MultiRepo',
      path: '/ws/repo',
      repoRootPath: '/ws/repo',
      isMultiWorktree: true,
      worktrees: [wtMain, wtDetached, wtMissing]
    });

    const sWt = makeSession({
      cascadeId: 's-wt',
      title: 'WT Chat',
      projectId: 'p-multi',
      worktreeId: 'wt_det',
      worktreePath: '/ws/repo-det'
    });

    const { container } = render(
      <I18nProvider locale="en">
        <ThemeProvider>
          <SwipeDrawerShell
            leftOpen={true}
            rightOpen={false}
            onSetLeft={onSetLeft}
            onSetRight={vi.fn()}
            leftContent={
              <LeftDrawer
                {...makeLeftDrawerProps({
                  projects: [pFlat, pMulti],
                  sessions: [sWt],
                  activeSessionId: 's-wt',
                  onCreateSession,
                  onMutateWorktree
                })}
              />
            }
            rightContent={<div />}
          >
            <div />
          </SwipeDrawerShell>
        </ThemeProvider>
      </I18nProvider>
    );

    // Single workspace project stays flat (no wt badge/list)
    expect(screen.queryByTestId('project-wt-badge-p-flat')).toBeNull();
    expect(screen.queryByTestId('project-wt-list-p-flat')).toBeNull();

    // Multi-worktree project renders badge + subgroups
    expect(screen.getByTestId('project-wt-badge-p-multi').textContent).toBe('3 wt');
    expect(screen.getByTestId('project-wt-list-p-multi')).toBeTruthy();
    expect(screen.getByText('detached @ a1b2c3d')).toBeTruthy();
    expect(screen.getByText('Locked')).toBeTruthy();
    expect(screen.getByText('Missing')).toBeTruthy();
    expect(screen.getByTestId('wt-missing-hint-wt_miss')).toBeTruthy();
    expect((screen.getByTestId('wt-new-session-wt_miss') as HTMLButtonElement).disabled).toBe(true);

    // Clicking '+' on detached worktree locks new session to wt_det
    fireEvent.click(screen.getByTestId('wt-new-session-wt_det'));
    expect(screen.getByTestId('new-session-wt-chip')).toBeTruthy();
    fireEvent.click(screen.getByTestId('confirm-create-session-btn'));
    await waitFor(() =>
      expect(onCreateSession).toHaveBeenCalledWith(undefined, 'file:///ws/repo-det', {
        worktreePath: '/ws/repo-det',
        projectId: 'p-multi'
      })
    );

    // Locked worktree disables Remove Worktree in ActionSheet
    fireEvent.click(screen.getByTestId('wt-more-wt_det'));
    expect((screen.getByTestId('wt-action-remove') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('Cancel'));

    // Lazy WorktreeSheet opens from Project ActionSheet and suggests sibling path
    fireEvent.click(screen.getByTestId('project-more-p-multi'));
    fireEvent.click(screen.getByTestId('action-new-worktree'));
    const wtModal = await screen.findByTestId('worktree-create-modal');
    expect(wtModal).toBeTruthy();
    fireEvent.input(screen.getByPlaceholderText('feat/my-branch'), {
      target: { value: 'feat/payments' }
    });
    const pathInput = screen.getByPlaceholderText('/path/to/repo-feat') as HTMLInputElement;
    await waitFor(() => expect(pathInput.value).toBe('/ws/repo-feat-payments'));
    fireEvent.click(screen.getByTestId('worktree-create-submit'));
    await waitFor(() =>
      expect(onMutateWorktree).toHaveBeenCalledWith({
        root: '/ws/repo',
        action: 'add',
        path: '/ws/repo-feat-payments',
        branch: 'feat/payments',
        createBranch: true
      })
    );

    // Gesture interlock: 350ms hold on session row inside Worktree locks SwipeDrawerShell
    vi.useFakeTimers();
    const sessRow = container.querySelector(
      '[data-dnd-item="1"][data-dnd-id="s-wt"][data-dnd-container="wt_det"]'
    ) as HTMLElement;
    expect(sessRow).toBeTruthy();
    fireEvent.touchStart(sessRow, makeTouchInit(80, 200));
    await vi.advanceTimersByTimeAsync(360);
    expect(document.documentElement.dataset.agyDragging).toBe('1');
    const shell = container.firstElementChild as HTMLElement;
    fireEvent.touchStart(shell, makeTouchInit(240, 200));
    fireEvent.touchMove(shell, makeTouchInit(40, 200));
    expect(onSetLeft).not.toHaveBeenCalled();
    fireEvent(window, new TouchEvent('touchend', makeTouchInit(80, 200)));

    expect(container.textContent).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('locks RightDrawer to active session Worktree, blocks missing Worktree without main-repo fallback, and isolates PtyTerminal per rootPath', async () => {
    const ctrl = new RemoteStoreController();
    const wtMain = makeWorktree({
      worktreeId: 'wt_main',
      path: '/ws/repo',
      branch: 'main',
      isMain: true
    });
    const wtMissing = makeWorktree({
      worktreeId: 'wt_dead',
      path: '/ws/repo-dead',
      branch: 'feat/dead',
      status: 'missing',
      prunable: true,
      exists: false
    });
    const proj = makeProject({
      id: 'p1',
      name: 'repo',
      path: '/ws/repo',
      isMultiWorktree: true,
      worktrees: [wtMain, wtMissing]
    });
    const sLive = makeSession({
      cascadeId: 's-live',
      projectId: 'p1',
      worktreeId: 'wt_main',
      worktreePath: '/ws/repo',
      workspaceUri: 'file:///ws/repo'
    });
    const sDead = makeSession({
      cascadeId: 's-dead',
      projectId: 'p1',
      worktreeId: 'wt_dead',
      worktreePath: '/ws/repo-dead',
      worktreeStatus: 'missing',
      workspaceUri: 'file:///ws/repo-dead'
    });

    (ctrl as unknown as { setState: (p: Record<string, unknown>) => void }).setState({
      projects: [proj],
      sessions: [sLive, sDead],
      activeSessionId: 's-dead'
    });

    const ctxMissing = ctrl.getActiveWorkspaceContext();
    expect(ctxMissing.isMissing).toBe(true);
    expect(ctxMissing.rootPath).toBe('');
    expect(ctxMissing.missingPath).toBe('/ws/repo-dead');

    // RightDrawer shows readonly missing-worktree guard without falling back to /ws/repo
    const { container: rdContainer } = render(
      <I18nProvider locale="en">
        <ThemeProvider>
          <RightDrawer
            open={true}
            activeTab="diff"
            rootPath={ctxMissing.rootPath}
            worktreeId={ctxMissing.worktreeId}
            worktreeBranch={ctxMissing.worktreeBranch}
            isMissingWorktree={ctxMissing.isMissing}
            missingWorktreePath={ctxMissing.missingPath}
            sessionId="s-dead"
            permissionLevel="L2"
            token="tok"
            inspectTargetFile=""
            onSelectTab={vi.fn()}
            onClose={vi.fn()}
            onInjectQuote={vi.fn()}
            onShowToast={vi.fn()}
            onRefreshDiffBadge={vi.fn()}
          />
        </ThemeProvider>
      </I18nProvider>
    );
    expect(screen.getByTestId('right-drawer-missing-worktree')).toBeTruthy();
    expect(rdContainer.textContent).toContain('/ws/repo-dead');
    expect(rdContainer.textContent).not.toMatch(/[\u4e00-\u9fff]/);
    cleanup();

    // PtyTerminal strict isolation across Worktree switches
    const listPtySpy = vi.spyOn(api, 'listPtySessions').mockImplementation(async (cwd?: string) => {
      if (cwd === '/ws/wt1') {
        return {
          ok: true,
          sessions: [{ id: 'pty-wt1-srv', sessionId: 'pty-wt1-srv', cwd: '/ws/wt1', worktreeId: 'wt_1' }]
        };
      }
      return {
        ok: true,
        sessions: []
      };
    });

    const wsUrls: string[] = [];
    class MockWebSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((ev: { data: string }) => void) | null = null;
      onclose: ((ev: { reason?: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(url: string) {
        wsUrls.push(url);
      }
      send() {}
      close() {}
    }
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
    vi.mock('@xterm/xterm', () => ({
      Terminal: class {
        cols = 80;
        rows = 24;
        loadAddon() {}
        open() {}
        write() {}
        onData() {}
        dispose() {}
      }
    }));
    vi.mock('@xterm/addon-fit', () => ({
      FitAddon: class {
        fit() {}
      }
    }));
    vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

    const { rerender: rerenderPty } = render(
      <I18nProvider locale="en">
        <ThemeProvider>
          <PtyTerminal
            rootPath="/ws/wt1"
            worktreeId="wt_1"
            worktreeBranch="feat/one"
            sessionId="chat-1"
            permissionLevel="L2"
            token="tok"
          />
        </ThemeProvider>
      </I18nProvider>
    );

    await waitFor(() => expect(listPtySpy).toHaveBeenCalledWith('/ws/wt1'));
    expect(screen.getByTestId('pty-sandbox-capsule').textContent).toContain('feat/one · /ws/wt1');
    await waitFor(() =>
      expect(wsUrls.some((u) => u.includes('cwd=%2Fws%2Fwt1') && u.includes('sessionId=pty-wt1-srv'))).toBe(true)
    );

    // Switch to W2 -> must NOT reuse pty-wt1-srv or 'pty-1'
    rerenderPty(
      <I18nProvider locale="en">
        <ThemeProvider>
          <PtyTerminal
            rootPath="/ws/wt2"
            worktreeId="wt_2"
            worktreeBranch="feat/two"
            sessionId="chat-2"
            permissionLevel="L2"
            token="tok"
          />
        </ThemeProvider>
      </I18nProvider>
    );

    await waitFor(() => expect(listPtySpy).toHaveBeenCalledWith('/ws/wt2'));
    expect(screen.getByTestId('pty-sandbox-capsule').textContent).toContain('feat/two · /ws/wt2');
    await waitFor(() =>
      expect(
        wsUrls.some(
          (u) =>
            u.includes('cwd=%2Fws%2Fwt2') &&
            u.includes('sessionId=pty-wt_2-1') &&
            !u.includes('pty-wt1-srv') &&
            !u.includes('sessionId=pty-1&')
        )
      ).toBe(true)
    );
    expect(deriveClientWorktreeKey('/ws/wt1')).not.toBe(deriveClientWorktreeKey('/ws/wt2'));
  });

  it('persists collapse state via RemoteStoreController.setNodeCollapsed and handles worktree.updated SSE', async () => {
    const ctrl = new RemoteStoreController();
    (ctrl as unknown as { setState: (p: Record<string, unknown>) => void }).setState({
      token: 'tok',
      online: true,
      permissionLevel: 'L2',
      groups: [makeGroup({ id: 'g1', name: 'G1', collapsed: false })],
      projects: [
        makeProject({
          id: 'p1',
          name: 'Repo',
          isMultiWorktree: true,
          worktrees: [makeWorktree({ worktreeId: 'wt_1', path: '/ws/wt1', collapsed: false })]
        })
      ]
    });

    const collapseSpy = vi.spyOn(api, 'setNodeCollapsed').mockResolvedValue({
      ok: true,
      nodeType: 'worktree',
      id: 'wt_1',
      collapsed: true,
      collapsedNodes: { projects: {}, worktrees: { wt_1: true } },
      revision: 15
    });

    await ctrl.setNodeCollapsed('worktree', 'wt_1', true);
    expect(collapseSpy).toHaveBeenCalledWith({
      nodeType: 'worktree',
      id: 'wt_1',
      collapsed: true
    });
    expect(ctrl.getState().collapsedNodes.worktrees.wt_1).toBe(true);
    expect(ctrl.getState().projects[0].worktrees?.[0].collapsed).toBe(true);
    expect(ctrl.getState().orgRevision).toBe(15);
  });
});
