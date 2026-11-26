import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeftDrawer } from './drawers/LeftDrawer';
import {
  buildOrderedIdsAfterDrop,
  partitionAndOrderItems,
  reorderWithinZone,
  resolveNextActiveSessionId,
  sortPinnedQuickSessions
} from './hooks/useDrawerDragSort';
import { I18nProvider } from './i18n';
import { SwipeDrawerShell } from './layout/SwipeDrawerShell';
import NewProjectSheet from './lazy/NewProjectSheet';
import { type ApiError, api } from './store/api';
import { RemoteStoreController } from './store/useRemoteStore';
import { ThemeProvider } from './theme/ThemeProvider';
import type { HostProject, SessionGroup, SessionPins, SessionSummary } from './types';

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

function makeSession(overrides: Partial<SessionSummary> & { cascadeId: string }): SessionSummary {
  return {
    title: overrides.title || `Session ${overrides.cascadeId}`,
    summary: '',
    status: 'IDLE',
    needsAttention: false,
    stepCount: 3,
    lastModifiedTime: '2026-11-26T10:00:00Z',
    workspaceUri: 'file:///ws/alpha',
    branchName: 'main',
    projectId: 'proj-alpha',
    projectName: 'alpha',
    ...overrides
  };
}

function makeProject(overrides: Partial<HostProject> & { id: string }): HostProject {
  return {
    name: overrides.name || overrides.id,
    uri: `file:///ws/${overrides.id}`,
    path: `/ws/${overrides.id}`,
    groupId: null,
    pinned: false,
    branchName: 'main',
    sessionCount: 1,
    lastModifiedTime: '2026-11-26T10:00:00Z',
    ...overrides
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

describe('HUB-290 S4-2 Drawer Org, Drag-Sort, Archive/Delete & NewProject', () => {
  beforeEach(() => {
    window.localStorage?.clear();
    delete document.documentElement.dataset.agyDragging;
    delete document.documentElement.dataset.agyDragEndedAt;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete document.documentElement.dataset.agyDragging;
    delete document.documentElement.dataset.agyDragEndedAt;
  });

  describe('Pure ordering & focus fallback helpers', () => {
    it('partitions pinned vs normal zones preserving explicit order and placing new normal items on top', () => {
      const items = [
        { id: 'p1', pinned: true, ts: 10 },
        { id: 'p2', pinned: true, ts: 20 },
        { id: 'n1', pinned: false, ts: 10 },
        { id: 'n2', pinned: false, ts: 30 },
        { id: 'n3', pinned: false, ts: 25 }
      ];
      const res = partitionAndOrderItems({
        items,
        isPinned: (x) => x.pinned,
        getId: (x) => x.id,
        order: { pinned: ['p2', 'p1'], normal: ['n1'] },
        defaultPinnedCompare: (a, b) => b.ts - a.ts,
        defaultNormalCompare: (a, b) => b.ts - a.ts
      });
      expect(res.pinned.map((x) => x.id)).toEqual(['p2', 'p1']);
      expect(res.normal.map((x) => x.id)).toEqual(['n2', 'n3', 'n1']);
    });

    it('sorts pinned quick sessions honoring __pinned__ order', () => {
      const s1 = makeSession({ cascadeId: 's1', lastModifiedTime: '2026-11-26T09:00:00Z' });
      const s2 = makeSession({ cascadeId: 's2', lastModifiedTime: '2026-11-26T10:00:00Z' });
      const s3 = makeSession({ cascadeId: 's3', lastModifiedTime: '2026-11-26T11:00:00Z' });
      const sorted = sortPinnedQuickSessions(
        [s1, s2, s3],
        ['s1', 's2'],
        (a, b) => Date.parse(b.lastModifiedTime || '') - Date.parse(a.lastModifiedTime || '')
      );
      expect(sorted.map((s) => s.cascadeId)).toEqual(['s3', 's1', 's2']);
    });

    it('reorders within zone via menu actions and drop index', () => {
      expect(reorderWithinZone(['a', 'b', 'c'], 'b', 'up')).toEqual(['b', 'a', 'c']);
      expect(reorderWithinZone(['a', 'b', 'c'], 'a', 'last')).toEqual(['b', 'c', 'a']);
      expect(reorderWithinZone(['a', 'b', 'c'], 'a', 'up')).toBeNull();
      expect(buildOrderedIdsAfterDrop(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
      expect(buildOrderedIdsAfterDrop(['a', 'b', 'c'], 'a', 1)).toBeNull();
    });

    it('resolves next active session within same project, then global recent, then null', () => {
      const p1a = makeSession({
        cascadeId: 'p1-a',
        projectId: 'p1',
        lastModifiedTime: '2026-11-26T08:00:00Z'
      });
      const p1b = makeSession({
        cascadeId: 'p1-b',
        projectId: 'p1',
        lastModifiedTime: '2026-11-26T07:00:00Z'
      });
      const p2a = makeSession({
        cascadeId: 'p2-a',
        projectId: 'p2',
        workspaceUri: 'file:///ws/p2',
        lastModifiedTime: '2026-11-26T12:00:00Z'
      });

      expect(resolveNextActiveSessionId([p1a, p1b, p2a], 'p1-a', 'p1-a')).toBe('p1-b');
      expect(resolveNextActiveSessionId([p1a, p2a], 'p1-a', 'p1-a')).toBe('p2-a');
      expect(resolveNextActiveSessionId([p1a], 'p1-a', 'p1-a')).toBeNull();
      expect(resolveNextActiveSessionId([p1a, p2a], 'p2-a', 'p1-a')).toBe('p1-a');
    });
  });

  describe('RemoteStoreController L0 read-only, SSE sync, drag buffer & archive/delete rollback', () => {
    it('blocks L0 mutations without calling API or falling back to localStorage', async () => {
      const ctrl = new RemoteStoreController();
      const pinSpy = vi.spyOn(api, 'toggleSessionPin').mockResolvedValue({} as never);
      const grpSpy = vi.spyOn(api, 'mutateSessionGroups').mockResolvedValue({} as never);
      const archSpy = vi.spyOn(api, 'archiveSession').mockResolvedValue({} as never);

      // Default permissionLevel is L0
      await ctrl.togglePin('session', 's1', true);
      await ctrl.createGroup('My Group');
      const archived = await ctrl.archiveSession('s1', true);

      expect(archived).toBe(false);
      expect(pinSpy).not.toHaveBeenCalled();
      expect(grpSpy).not.toHaveBeenCalled();
      expect(archSpy).not.toHaveBeenCalled();
      expect(window.localStorage.getItem('agy_remote_pins_v1')).toBeNull();
      expect(window.localStorage.getItem('agy_remote_groups_v1')).toBeNull();
    });

    it('syncs state:session.org@1 and buffers SSE org updates while dragging', async () => {
      const ctrl = new RemoteStoreController();
      const s1 = makeSession({ cascadeId: 's1' });
      const s2 = makeSession({ cascadeId: 's2' });
      (ctrl as unknown as { setState: (p: Record<string, unknown>) => void }).setState({
        token: 'tok',
        online: true,
        permissionLevel: 'L2',
        sessions: [s1, s2],
        activeSessionId: 's1'
      });

      const listSpy = vi.spyOn(api, 'listSessions').mockResolvedValue({
        ok: true,
        sessions: [s1, s2],
        revision: 9,
        pins: { sessions: ['s2'], projects: [], groups: [] },
        groups: [],
        projects: [],
        groupOrder: { pinned: [], normal: [] },
        projectOrder: {},
        sessionOrder: { __pinned__: ['s2'] },
        archivedCount: 0
      });

      // Start dragging -> incoming org.updated must be deferred
      ctrl.setDraggingOrg(true);
      (ctrl as unknown as { handleOrgUpdated: (p: Record<string, unknown>) => void }).handleOrgUpdated(
        { revision: 9 }
      );
      expect(listSpy).not.toHaveBeenCalled();

      // state:session.org@1 also deferred while dragging
      (
        ctrl as unknown as { handleStatePatch: (p: Record<string, unknown>) => void }
      ).handleStatePatch({
        key: 'state:session.org@1',
        value: { revision: 8, pins: { sessions: ['s1'], projects: [], groups: [] } }
      });
      expect(ctrl.getState().orgRevision).toBe(0);

      // End drag -> triggers buffered refresh
      ctrl.setDraggingOrg(false);
      await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(ctrl.getState().orgRevision).toBe(9));
      expect(ctrl.getState().pins.sessions).toEqual(['s2']);
    });

    it('archives active session, unpins mutex, moves focus, sets 5s Undo toast, and rolls back on failure', async () => {
      const ctrl = new RemoteStoreController();
      const s1 = makeSession({ cascadeId: 's1', pinned: true, projectId: 'proj-alpha' });
      const s2 = makeSession({ cascadeId: 's2', pinned: false, projectId: 'proj-alpha' });
      (ctrl as unknown as { setState: (p: Record<string, unknown>) => void }).setState({
        token: 'tok',
        online: true,
        permissionLevel: 'L2',
        sessions: [s1, s2],
        pins: { sessions: ['s1'], projects: [], groups: [] },
        activeSessionId: 's1'
      });
      vi.spyOn(api, 'getSession').mockResolvedValue({
        session: {
          cascadeId: 's2',
          title: 'Session s2',
          summary: '',
          status: 'IDLE',
          stepCount: 1,
          lastModifiedTime: '2026-11-26T10:00:00Z',
          workspaceUri: 'file:///ws/alpha',
          branchName: 'main'
        },
        events: []
      } as never);
      vi.spyOn(api, 'listSessionQueue').mockResolvedValue({ ok: true, queue: [] } as never);
      const replaceSpy = vi.spyOn(window.history, 'replaceState');

      const archSpy = vi.spyOn(api, 'archiveSession').mockResolvedValue({
        ok: true,
        cascadeId: 's1',
        archived: true,
        unpinned: true,
        revision: 4,
        archivedCount: 1
      });

      const ok = await ctrl.archiveSession('s1', true);
      expect(ok).toBe(true);
      expect(archSpy).toHaveBeenCalledTimes(1);
      expect(ctrl.getState().sessions.map((s) => s.cascadeId)).toEqual(['s2']);
      expect(ctrl.getState().pins.sessions).toEqual([]);
      expect(ctrl.getState().activeSessionId).toBe('s2');
      expect(ctrl.getState().archivedCount).toBe(1);
      expect(ctrl.getState().toastAction?.label).toBeTruthy();
      expect(replaceSpy).toHaveBeenCalled();

      // Rollback when API fails on second archive
      archSpy.mockRejectedValueOnce(new Error('network down'));
      const ok2 = await ctrl.archiveSession('s2', true);
      expect(ok2).toBe(false);
      expect(ctrl.getState().sessions.map((s) => s.cascadeId)).toEqual(['s2']);
      expect(ctrl.getState().activeSessionId).toBe('s2');
    });

    it('returns canFallbackLocalHide on 503 HOST_DELETE_UNAVAILABLE and supports local_hide + L1 guard', async () => {
      const ctrl = new RemoteStoreController();
      const s1 = makeSession({ cascadeId: 's1' });
      (ctrl as unknown as { setState: (p: Record<string, unknown>) => void }).setState({
        token: 'tok',
        online: true,
        permissionLevel: 'L1',
        sessions: [s1],
        activeSessionId: 's1'
      });

      const delSpy = vi.spyOn(api, 'deleteSession');
      const l1Res = await ctrl.deleteSession('s1', 'auto');
      expect(l1Res.ok).toBe(false);
      expect(delSpy).not.toHaveBeenCalled();

      (ctrl as unknown as { setState: (p: Record<string, unknown>) => void }).setState({
        permissionLevel: 'L2'
      });

      const err503 = Object.assign(new Error('Host unavailable'), {
        status: 503,
        reasonCode: 'HOST_DELETE_UNAVAILABLE',
        canFallbackLocalHide: true
      }) as ApiError;
      delSpy.mockRejectedValueOnce(err503);
      const autoRes = await ctrl.deleteSession('s1', 'auto');
      expect(autoRes.ok).toBe(false);
      expect(autoRes.canFallbackLocalHide).toBe(true);
      // Rolled back
      expect(ctrl.getState().sessions.map((s) => s.cascadeId)).toEqual(['s1']);

      delSpy.mockResolvedValueOnce({
        ok: true,
        cascadeId: 's1',
        deletionMode: 'local_tombstone',
        hostCleaned: false,
        revision: 11,
        archivedCount: 0
      });
      vi.spyOn(api, 'listSessions').mockResolvedValue({
        ok: true,
        sessions: [],
        revision: 11,
        pins: { sessions: [], projects: [], groups: [] },
        groups: [],
        projects: []
      });
      const fallbackRes = await ctrl.deleteSession('s1', 'local_hide');
      expect(fallbackRes.ok).toBe(true);
      expect(delSpy).toHaveBeenLastCalledWith('s1', 'local_hide');
      expect(ctrl.getState().activeSessionId).toBe('');
    });
  });

  describe('LeftDrawer UI hierarchy, ActionSheets, Delete fallback & SwipeDrawerShell interlock', () => {
    const baseProps = () => ({
      sessions: [
        makeSession({ cascadeId: 's1', title: 'Alpha Chat', projectId: 'p1', pinned: true }),
        makeSession({ cascadeId: 's2', title: 'Beta Chat', projectId: 'p2' }),
        makeSession({
          cascadeId: 's-alone',
          title: 'Solo Task',
          projectId: null,
          workspaceUri: null
        })
      ],
      archivedList: [
        makeSession({
          cascadeId: 's-arch',
          title: 'Archived Rocket',
          archived: true,
          archivedAt: '2026-11-26T09:00:00Z'
        })
      ],
      archivedCount: 1,
      activeSessionId: 's1',
      workspaces: [{ uri: 'file:///ws/p1', name: 'p1', path: '/ws/p1' }],
      groups: [
        makeGroup({ id: 'g-norm', name: 'NormalGroup', pinned: false, order: 1 }),
        makeGroup({ id: 'g-pin', name: 'PinnedGroup', pinned: true, order: 0 })
      ],
      projects: [
        makeProject({ id: 'p1', name: 'Proj Pinned', groupId: 'g-pin' }),
        makeProject({ id: 'p2', name: 'Proj Normal', groupId: 'g-norm' }),
        makeProject({ id: 'p3', name: 'Proj Free', groupId: null })
      ],
      pins: { sessions: ['s1'], projects: [], groups: ['g-pin'] } as SessionPins,
      channel: 'loopback',
      permissionLevel: 'L2' as const,
      token: 'tok',
      appearance: 'auto' as const,
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
      onAssignProjectGroup: vi.fn(async () => {}),
      onRenameProject: vi.fn(async () => {}),
      onRemoveProject: vi.fn(async () => {}),
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
      onClose: vi.fn()
    });

    it('renders pinned groups above divider before normal groups, and supports unselected pill 450ms ActionSheet', async () => {
      vi.useFakeTimers();
      const props = baseProps();
      const { container } = render(
        <I18nProvider locale="en">
          <ThemeProvider>
            <LeftDrawer {...props} />
          </ThemeProvider>
        </I18nProvider>
      );

      expect(screen.getByTestId('group-tier-divider')).toBeTruthy();
      const sections = Array.from(container.querySelectorAll('section[data-group-id]'));
      expect(sections.map((el) => el.getAttribute('data-group-id'))).toEqual(['g-pin', 'g-norm']);

      // Long-press unselected normal group pill for 450ms -> opens ActionSheet directly without selecting filter
      const pill = screen.getByTestId('group-pill-g-norm');
      fireEvent.touchStart(pill, makeTouchInit(50, 50));
      await vi.advanceTimersByTimeAsync(460);
      fireEvent.touchEnd(pill, makeTouchInit(50, 50));

      const sheet = screen.getByTestId('left-action-sheet');
      expect(sheet.textContent).toContain('NormalGroup');
      expect(sheet.textContent).toContain('Pin group');
      expect(sheet.textContent).toContain('Rename group');
      expect(sheet.textContent).toContain('Delete group');

      // Assert zero hardcoded Chinese when English locale active
      expect(container.textContent).not.toMatch(/[\u4e00-\u9fff]/);
    });

    it('opens Project 5-item ActionSheet and invokes move-to-group, reorder, and L2 delete modal fallback', async () => {
      const props = baseProps();
      props.onDeleteSession = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, canFallbackLocalHide: true })
        .mockResolvedValueOnce({ ok: true });

      render(
        <I18nProvider locale="en">
          <ThemeProvider>
            <LeftDrawer {...props} />
          </ThemeProvider>
        </I18nProvider>
      );

      // Project more menu
      fireEvent.click(screen.getByTestId('project-more-p1'));
      const projSheet = screen.getByTestId('left-action-sheet');
      expect(projSheet.textContent).toContain('Pin project');
      expect(projSheet.textContent).toContain('Rename project');
      expect(projSheet.textContent).toContain('Move to group');
      expect(projSheet.textContent).toContain('Remove from list');

      // Switch to Archived search jump from empty active search
      fireEvent.click(screen.getByText('Cancel'));
      const searchInput = screen.getByPlaceholderText(
        'Search groups, projects, sessions, or branches...'
      );
      fireEvent.input(searchInput, { target: { value: 'Rocket' } });
      const jumpBanner = await screen.findByTestId('archived-search-jump');
      fireEvent.click(jumpBanner);
      expect(props.onLoadArchived).toHaveBeenCalled();
      expect(screen.getByTestId('archived-row-s-arch')).toBeTruthy();

      // Honest Delete Modal with 503 fallback -> local_hide
      fireEvent.click(screen.getAllByText('Delete session')[0]);
      expect(screen.getByTestId('delete-session-modal')).toBeTruthy();
      fireEvent.click(screen.getByTestId('confirm-delete-session-btn'));
      await waitFor(() => expect(props.onDeleteSession).toHaveBeenCalledWith('s-arch', 'auto'));
      await waitFor(() =>
        expect(screen.getByTestId('confirm-delete-session-btn').textContent).toContain(
          'Hide in Web & PWA only'
        )
      );
      fireEvent.click(screen.getByTestId('confirm-delete-session-btn'));
      await waitFor(() =>
        expect(props.onDeleteSession).toHaveBeenLastCalledWith('s-arch', 'local_hide')
      );
    });

    it('arms drag at 350ms on touch hold, yields on >=8px scroll, locks SwipeDrawerShell, clamps cross-zone, and auto-expands collapsed group at 600ms', async () => {
      vi.useFakeTimers();
      const props = baseProps();
      props.groups = [
        makeGroup({ id: 'g-norm', name: 'NormalGroup', pinned: false, collapsed: true }),
        makeGroup({ id: 'g-pin', name: 'PinnedGroup', pinned: true, collapsed: false })
      ];
      props.projects = [
        makeProject({ id: 'p-pin', name: 'PinnedProj', groupId: 'g-pin', pinned: true }),
        makeProject({ id: 'p-norm', name: 'NormalProj', groupId: 'g-pin', pinned: false })
      ];
      props.pins = { sessions: [], projects: ['p-pin'], groups: ['g-pin'] };

      const onSetLeft = vi.fn();
      const vibSpy = vi.fn();
      Object.defineProperty(navigator, 'vibrate', {
        value: vibSpy,
        configurable: true
      });

      const { container } = render(
        <I18nProvider locale="en">
          <ThemeProvider>
            <SwipeDrawerShell
              leftOpen={true}
              rightOpen={false}
              onSetLeft={onSetLeft}
              onSetRight={vi.fn()}
              leftContent={<LeftDrawer {...props} />}
              rightContent={<div>right</div>}
            >
              <div>main</div>
            </SwipeDrawerShell>
          </ThemeProvider>
        </I18nProvider>
      );

      const pinnedProjEl = container.querySelector(
        '[data-dnd-item="1"][data-dnd-id="p-pin"]'
      ) as HTMLElement;
      const normalProjEl = container.querySelector(
        '[data-dnd-item="1"][data-dnd-id="p-norm"]'
      ) as HTMLElement;
      const collapsedGroupHdr = container.querySelector(
        '[data-dnd-collapsed-group="g-norm"]'
      ) as HTMLElement;
      const groupContainer = container.querySelector(
        '[data-dnd-project-container="g-pin"]'
      ) as HTMLElement;

      vi.spyOn(pinnedProjEl, 'getBoundingClientRect').mockReturnValue({
        top: 100,
        bottom: 150,
        left: 10,
        right: 300,
        width: 290,
        height: 50,
        x: 10,
        y: 100,
        toJSON: () => ({})
      });
      vi.spyOn(normalProjEl, 'getBoundingClientRect').mockReturnValue({
        top: 160,
        bottom: 210,
        left: 10,
        right: 300,
        width: 290,
        height: 50,
        x: 10,
        y: 160,
        toJSON: () => ({})
      });
      vi.spyOn(groupContainer, 'getBoundingClientRect').mockReturnValue({
        top: 90,
        bottom: 220,
        left: 10,
        right: 300,
        width: 290,
        height: 130,
        x: 10,
        y: 90,
        toJSON: () => ({})
      });
      vi.spyOn(collapsedGroupHdr, 'getBoundingClientRect').mockReturnValue({
        top: 260,
        bottom: 304,
        left: 10,
        right: 300,
        width: 290,
        height: 44,
        x: 10,
        y: 260,
        toJSON: () => ({})
      });

      // 1) Scrolling >=8px before 350ms yields to native scroll (never arms drag)
      const projHeader = pinnedProjEl.firstElementChild as HTMLElement;
      fireEvent.touchStart(projHeader, makeTouchInit(100, 120));
      fireEvent(window, new TouchEvent('touchmove', makeTouchInit(100, 132)));
      await vi.advanceTimersByTimeAsync(360);
      expect(document.documentElement.dataset.agyDragging).toBeUndefined();
      fireEvent(window, new TouchEvent('touchend', makeTouchInit(100, 132)));

      // 2) Hold 350ms with <8px displacement -> arms drag + vibrates
      fireEvent.touchStart(projHeader, makeTouchInit(100, 120));
      await vi.advanceTimersByTimeAsync(360);
      expect(document.documentElement.dataset.agyDragging).toBe('1');
      expect(vibSpy).toHaveBeenCalledWith(15);

      // 3) Activate drag (dist >= 6px) and verify SwipeDrawerShell ignores horizontal swipe while dragging
      fireEvent(window, new TouchEvent('touchmove', makeTouchInit(100, 128)));
      await vi.advanceTimersByTimeAsync(20);
      const shell = container.firstElementChild as HTMLElement;
      fireEvent.touchStart(shell, makeTouchInit(250, 120));
      fireEvent.touchMove(shell, makeTouchInit(50, 120));
      expect(onSetLeft).not.toHaveBeenCalled();

      // 4) Move below boundary into normal zone -> shows zone clamp hint
      fireEvent(window, new TouchEvent('touchmove', makeTouchInit(100, 185)));
      await vi.advanceTimersByTimeAsync(20);
      expect(container.textContent).toContain('Pinned items sort within the pinned section only');

      // 5) Hover over collapsed group header for 600ms -> expands collapsed group
      fireEvent(window, new TouchEvent('touchmove', makeTouchInit(100, 280)));
      expect(container.querySelector('[data-dnd-collapsed-group="g-norm"]')).toBeTruthy();
      await vi.advanceTimersByTimeAsync(620);
      expect(container.querySelector('[data-dnd-collapsed-group="g-norm"]')).toBeNull();

      // 6) End drag and confirm swipe still does not close within 120ms cooldown
      fireEvent(window, new TouchEvent('touchend', makeTouchInit(100, 280)));
      expect(document.documentElement.dataset.agyDragging).toBeUndefined();
      fireEvent.touchStart(shell, makeTouchInit(250, 120));
      fireEvent.touchMove(shell, makeTouchInit(50, 120));
      fireEvent.touchEnd(shell, makeTouchInit(50, 120));
      expect(onSetLeft).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(150);
    });
  });

  describe('NewProjectSheet (Local DirBrowser, GitHub partial retry/cancel & Google Drive tiers)', () => {
    it('browses local folders, creates subfolder, and submits local project', async () => {
      const browseSpy = vi
        .spyOn(api, 'browseWorkspace')
        .mockResolvedValueOnce({
          ok: true,
          requestedPath: '/ws',
          resolvedPath: '/ws',
          exists: true,
          willCreateRelative: '',
          parentPath: '/',
          breadcrumbs: [{ name: 'ws', path: '/ws' }],
          entries: [{ name: 'demo', path: '/ws/demo', isGitRepo: true, isSymlink: false }],
          shortcuts: [{ kind: 'home', label: 'Home', path: '/Users/dev' }]
        })
        .mockResolvedValue({
          ok: true,
          requestedPath: '/ws/demo',
          resolvedPath: '/ws/demo',
          exists: true,
          willCreateRelative: '',
          parentPath: '/ws',
          breadcrumbs: [{ name: 'demo', path: '/ws/demo' }],
          entries: [],
          shortcuts: []
        });
      const mkdirSpy = vi.spyOn(api, 'mkdirWorkspace').mockResolvedValue({
        ok: true,
        name: 'sub',
        path: '/ws/demo/sub',
        parentPath: '/ws/demo'
      });
      const onCreateLocalProject = vi.fn(async () => makeProject({ id: 'p-new', name: 'sub' }));
      const onClose = vi.fn();

      render(
        <I18nProvider locale="en">
          <ThemeProvider>
            <NewProjectSheet
              open={true}
              permissionLevel="L2"
              groups={[makeGroup({ id: 'g1', name: 'Work' })]}
              defaultSessionPath="/ws"
              onCreateLocalProject={onCreateLocalProject}
              onRemoteCreated={vi.fn(async () => {})}
              onShowToast={vi.fn()}
              onClose={onClose}
            />
          </ThemeProvider>
        </I18nProvider>
      );

      await waitFor(() => expect(browseSpy).toHaveBeenCalled());
      expect(await screen.findByText('demo')).toBeTruthy();

      // Click `>` enter button
      fireEvent.click(screen.getByLabelText('Open demo'));
      await waitFor(() => expect(browseSpy).toHaveBeenCalledWith('/ws/demo', false, expect.anything()));

      // + New Folder
      fireEvent.click(screen.getByText('+ New Folder'));
      fireEvent.input(screen.getByPlaceholderText('New folder name…'), {
        target: { value: 'sub' }
      });
      fireEvent.click(screen.getByText('Create'));
      await waitFor(() => expect(mkdirSpy).toHaveBeenCalledWith('/ws/demo', 'sub'));

      fireEvent.click(screen.getByText('Create Project'));
      await waitFor(() =>
        expect(onCreateLocalProject).toHaveBeenCalledWith(
          expect.objectContaining({ rootPath: '/ws/demo/sub' })
        )
      );
      expect(onClose).toHaveBeenCalled();
    });

    it('handles GitHub partial-create retry without duplicating remote repo and honest Google Drive unavailable tier', async () => {
      vi.spyOn(api, 'browseWorkspace').mockResolvedValue({
        ok: true,
        requestedPath: '/ws',
        resolvedPath: '/ws',
        exists: true,
        willCreateRelative: '',
        parentPath: '/',
        breadcrumbs: [],
        entries: [],
        shortcuts: []
      });
      vi.spyOn(api, 'getRemotePreflight').mockResolvedValue({
        ok: true,
        github: {
          gitInstalled: true,
          gitVersion: '2.45.0',
          ghInstalled: true,
          ghAuthenticated: true,
          activeAccount: 'dev',
          accounts: ['dev'],
          orgs: ['acme'],
          canClonePublicOrSsh: true,
          canCreateRepo: true,
          installHints: {}
        },
        gdrive: {
          tier: 'unavailable',
          mounts: [],
          rclone: { installed: false, driveRemotes: [] },
          gdriveCli: { installed: false, authenticated: false, account: null },
          setupHints: ['Install Google Drive desktop or rclone']
        }
      });

      const startJobSpy = vi.spyOn(api, 'startRemoteProjectJob').mockResolvedValue({
        ok: true,
        jobId: 'job-1',
        job: {
          jobId: 'job-1',
          provider: 'github',
          mode: 'gh_create_and_clone',
          projectName: 'my-app',
          localDirName: 'my-app',
          groupId: null,
          targetDir: '/ws/my-app',
          createdTargetDir: null,
          remoteCreated: {
            ownerRepo: 'dev/my-app',
            cloneUrl: 'https://github.com/dev/my-app.git',
            htmlUrl: 'https://github.com/dev/my-app'
          },
          status: 'failed',
          step: 'cloning',
          error: 'clone timeout',
          message: null,
          project: null,
          startedAt: '2026-11-26T10:00:00Z',
          updatedAt: '2026-11-26T10:00:05Z',
          elapsedMs: 5000
        }
      });

      const { container } = render(
        <I18nProvider locale="en">
          <ThemeProvider>
            <NewProjectSheet
              open={true}
              permissionLevel="L2"
              groups={[]}
              defaultSessionPath="/ws"
              onCreateLocalProject={vi.fn(async () => null)}
              onRemoteCreated={vi.fn(async () => {})}
              onShowToast={vi.fn()}
              onClose={vi.fn()}
            />
          </ThemeProvider>
        </I18nProvider>
      );

      // Switch to Google Drive -> unavailable tier with zero fake buttons
      fireEvent.click(screen.getByRole('tab', { name: 'Google Drive' }));
      expect(await screen.findByTestId('gdrive-unavailable-card')).toBeTruthy();
      expect(screen.queryByText('Import & Create Project')).toBeNull();
      expect(screen.getByText('Switch to Local Directory')).toBeTruthy();

      // Switch to GitHub -> Create & Clone partial failure -> Retry Clone switches to gh_clone
      fireEvent.click(screen.getByRole('tab', { name: 'GitHub' }));
      await waitFor(() => expect(screen.getByText('Create New Repo & Clone')).toBeTruthy());
      fireEvent.click(screen.getByText('Create New Repo & Clone'));
      fireEvent.input(screen.getByPlaceholderText('my-new-project'), {
        target: { value: 'my-app' }
      });
      fireEvent.click(screen.getByText('Create Repo & Clone'));

      await waitFor(() => expect(startJobSpy).toHaveBeenCalledTimes(1));
      expect(await screen.findByText('Retry Clone Only')).toBeTruthy();
      fireEvent.click(screen.getByText('Retry Clone Only'));
      await waitFor(() => expect(startJobSpy).toHaveBeenCalledTimes(2));
      expect(startJobSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          mode: 'gh_clone',
          github: expect.objectContaining({ repoSpec: 'dev/my-app' })
        })
      );

      expect(container.textContent).not.toMatch(/[\u4e00-\u9fff]/);
    });
  });

  describe('HUB-319 Group & Project Icon Customization', () => {
    it('renders group/project icons and supports setting icons from LeftDrawer action sheet and store', async () => {
      const onSetGroupIcon = vi.fn(async () => {});
      const onSetProjectIcon = vi.fn(async () => {});
      const onCreateGroup = vi.fn(async () => {});

      const g = makeGroup({ id: 'g1', name: 'Core', icon: 'preset:layers' });
      const p = makeProject({ id: 'p1', name: 'Alpha', groupId: 'g1', icon: '🚀' });

      render(
        <I18nProvider locale="en">
          <ThemeProvider>
            <LeftDrawer
              sessions={[makeSession({ cascadeId: 's1', projectId: 'p1', groupId: 'g1' })]}
              archivedList={[]}
              archivedCount={0}
              activeSessionId="s1"
              workspaces={[]}
              groups={[g]}
              projects={[p]}
              pins={{ sessions: [], projects: [], groups: [] }}
              channel="loopback"
              permissionLevel="L2"
              token="tok"
              appearance="auto"
              soundAlert={false}
              vibrateAlert={false}
              pushSubscribed={false}
              pushBusy={false}
              onSelectSession={vi.fn()}
              onCreateSession={vi.fn(async () => {})}
              onCreateGroup={onCreateGroup}
              onSetGroupIcon={onSetGroupIcon}
              onSetProjectIcon={onSetProjectIcon}
              onCycleAppearance={vi.fn()}
              onToggleSound={vi.fn()}
              onToggleVibrate={vi.fn()}
              onTogglePush={vi.fn()}
              onTestPush={vi.fn()}
              onClose={vi.fn()}
            />
          </ThemeProvider>
        </I18nProvider>
      );

      // Existing icons rendered on group header, group filter pill, and project card
      expect(screen.getByTestId('group-icon-g1').querySelector('[data-entity-icon="preset:layers"]')).toBeTruthy();
      expect(screen.getByTestId('project-icon-p1')).toHaveTextContent('🚀');
      expect(screen.getByTestId('group-pill-g1').querySelector('[data-entity-icon="preset:layers"]')).toBeTruthy();

      // Open project action sheet -> Set icon -> select preset
      fireEvent.click(screen.getByTestId('project-more-p1'));
      fireEvent.click(screen.getByTestId('action-set-project-icon'));
      fireEvent.click(screen.getByTestId('sheet-project-icon-p1-preset-code'));
      await waitFor(() => expect(onSetProjectIcon).toHaveBeenCalledWith('p1', 'preset:code'));

      // Open group action sheet -> Set icon -> clear icon
      fireEvent.click(screen.getByTestId('group-more-g1'));
      fireEvent.click(screen.getByTestId('action-set-group-icon'));
      fireEvent.click(screen.getByTestId('sheet-group-icon-g1-clear'));
      await waitFor(() => expect(onSetGroupIcon).toHaveBeenCalledWith('g1', null));

      // Store methods call backend APIs
      const mutateSpy = vi.spyOn(api, 'mutateSessionGroups').mockResolvedValue({
        ok: true,
        groups: [{ ...g, icon: '🔥' }],
        pins: { sessions: [], projects: [], groups: [] },
        revision: 12
      });
      const updProjSpy = vi.spyOn(api, 'updateProject').mockResolvedValue({
        ok: true,
        project: { ...p, icon: 'preset:terminal' },
        revision: 13
      });

      const ctrl = new RemoteStoreController();
      (ctrl as unknown as { setState: (patch: Record<string, unknown>) => void }).setState({
        token: 'tok',
        online: true,
        groups: [g],
        projects: [p],
        permissionLevel: 'L2'
      });
      await ctrl.setGroupIcon('g1', '🔥');
      expect(mutateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'upsert', id: 'g1', icon: '🔥' })
      );
      expect(ctrl.getState().groups[0].icon).toBe('🔥');

      await ctrl.setProjectIcon('p1', 'preset:terminal');
      expect(updProjSpy).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ icon: 'preset:terminal' })
      );
      expect(ctrl.getState().projects[0].icon).toBe('preset:terminal');
    });
  });
});
