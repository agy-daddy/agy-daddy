import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import * as ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeftDrawer, type LeftDrawerProps } from '../drawers/LeftDrawer';
import NewProjectSheet from '../lazy/NewProjectSheet';
import { api } from '../store/api';
import { RemoteStoreController } from '../store/useRemoteStore';
import { ThemeProvider } from '../theme/ThemeProvider';
import type { HostProject, SessionSummary, SupportedLocale } from '../types';
import { createTranslator, I18nProvider, interpolate } from './index';
import { LOCALE_DICTS } from './locales';
import type { I18nKey } from './types';

const RAW_SOURCE_FILES = import.meta.glob<string>(
  ['../**/*.ts', '../**/*.tsx', '!../i18n/**', '!../**/*.test.ts', '!../**/*.test.tsx'],
  { query: '?raw', import: 'default', eager: true }
);

const ALL_LOCALES: SupportedLocale[] = [
  'zh-CN',
  'zh-TW',
  'en',
  'ja',
  'ko',
  'es',
  'pt',
  'fr',
  'ru',
  'it'
];

function extractPlaceholders(template: string): string[] {
  const vars = new Set<string>();
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    if (match[1]) vars.add(match[1]);
  }
  return Array.from(vars).sort();
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

function makeSession(overrides: Partial<SessionSummary> & { cascadeId: string }): SessionSummary {
  return {
    title: overrides.title || `Session ${overrides.cascadeId}`,
    summary: '',
    status: 'IDLE',
    needsAttention: false,
    stepCount: 2,
    lastModifiedTime: '2026-11-26T10:00:00Z',
    workspaceUri: 'file:///ws/alpha',
    branchName: 'main',
    projectId: 'proj-alpha',
    projectName: 'Alpha',
    ...overrides
  };
}

function makeLeftDrawerProps(overrides: Partial<LeftDrawerProps> = {}): LeftDrawerProps {
  return {
    sessions: [makeSession({ cascadeId: 's1', title: 'Session One' })],
    archivedList: [],
    archivedCount: 0,
    activeSessionId: 's1',
    workspaces: [{ uri: 'file:///ws/alpha', name: 'Alpha', path: '/ws/alpha' }],
    groups: [],
    projects: [makeProject({ id: 'proj-alpha', name: 'Alpha', uri: 'file:///ws/alpha' })],
    pins: { sessions: [], projects: [], groups: [] },
    channel: 'loopback',
    permissionLevel: 'L2',
    token: 'tok',
    appearance: 'auto',
    soundAlert: true,
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
    onClose: vi.fn(),
    ...overrides
  };
}

describe('PWA i18n completeness, placeholder parity & callsite interpolation', () => {
  beforeEach(() => {
    window.localStorage?.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps identical key sets and placeholder variable sets across all 10 locales', () => {
    expect(Object.keys(LOCALE_DICTS).sort()).toEqual([...ALL_LOCALES].sort());
    const baseKeys = Object.keys(LOCALE_DICTS['zh-CN']) as I18nKey[];
    expect(baseKeys.length).toBeGreaterThan(500);

    const mismatches: string[] = [];
    for (const loc of ALL_LOCALES) {
      const dict = LOCALE_DICTS[loc];
      const locKeys = Object.keys(dict);
      for (const extra of locKeys) {
        if (!(extra in LOCALE_DICTS['zh-CN'])) {
          mismatches.push(`${loc} has extra key ${extra}`);
        }
      }
      for (const key of baseKeys) {
        const val = dict[key];
        if (!val) {
          mismatches.push(`${loc} missing or empty key ${key}`);
          continue;
        }
        const expectedVars = extractPlaceholders(LOCALE_DICTS['zh-CN'][key]);
        const actualVars = extractPlaceholders(val);
        if (JSON.stringify(actualVars) !== JSON.stringify(expectedVars)) {
          mismatches.push(
            `${loc} placeholder mismatch for ${key}: expected ${JSON.stringify(expectedVars)}, got ${JSON.stringify(actualVars)}`
          );
        }
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('passes all required template placeholders at every t()/tr()/this.t() callsite in web/src', () => {
    const fileEntries = Object.entries(RAW_SOURCE_FILES);
    expect(fileEntries.length).toBeGreaterThan(15);

    const baseDict = LOCALE_DICTS['zh-CN'];
    const errors: string[] = [];

    for (const [filePath, source] of fileEntries) {
      const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && node.arguments.length >= 1) {
          const expr = node.expression;
          const isTranslatorCall =
            (ts.isIdentifier(expr) && (expr.text === 't' || expr.text === 'tr')) ||
            (ts.isPropertyAccessExpression(expr) && expr.name.text === 't');

          if (isTranslatorCall) {
            const arg0 = node.arguments[0];
            if (ts.isStringLiteral(arg0) || ts.isNoSubstitutionTemplateLiteral(arg0)) {
              const key = arg0.text as I18nKey;
              const template = baseDict[key];
              const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
              if (!template) {
                errors.push(`${filePath}:${line + 1} unknown key "${key}"`);
              } else {
                const expectedVars = extractPlaceholders(template);
                if (expectedVars.length > 0) {
                  const arg1 = node.arguments[1];
                  if (!arg1) {
                    errors.push(
                      `${filePath}:${line + 1} key "${key}" missing params object (expected: ${expectedVars.join(', ')})`
                    );
                  } else if (ts.isObjectLiteralExpression(arg1)) {
                    const passed: string[] = [];
                    let hasSpreadOrDynamic = false;
                    for (const prop of arg1.properties) {
                      if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
                        if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) {
                          passed.push(prop.name.text);
                        } else {
                          hasSpreadOrDynamic = true;
                        }
                      } else {
                        hasSpreadOrDynamic = true;
                      }
                    }
                    if (!hasSpreadOrDynamic) {
                      const missing = expectedVars.filter((v) => !passed.includes(v));
                      const extra = passed.filter((v) => !expectedVars.includes(v));
                      if (missing.length > 0 || extra.length > 0) {
                        errors.push(
                          `${filePath}:${line + 1} key "${key}" param mismatch: missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`
                        );
                      }
                    }
                  }
                }
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }

    expect(errors).toEqual([]);
  });

  it('interpolates all 7 QA-reported sites and footer alert badges without leaking placeholders', async () => {
    // 1. LeftDrawer: project "+" aria-label, footer sound/vibrate pills, delete confirm project name, and 503 fallback desc
    const onDeleteSession = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        canFallbackLocalHide: true,
        reasonCode: 'HOST_DELETE_UNAVAILABLE',
        message: 'Host RPC offline'
      })
      .mockResolvedValueOnce({
        ok: false,
        canFallbackLocalHide: true,
        reasonCode: 'HOST_RPC_TIMEOUT'
      });

    const { rerender } = render(
      <I18nProvider locale="zh-CN">
        <ThemeProvider>
          <LeftDrawer {...makeLeftDrawerProps({ onDeleteSession })} />
        </ThemeProvider>
      </I18nProvider>
    );

    // Project "+" aria-label
    const newInProjBtn = screen.getByLabelText('在 Alpha 新建会话');
    expect(newInProjBtn).toBeTruthy();
    expect(newInProjBtn.getAttribute('aria-label')).not.toContain('{name}');

    // Footer sound & vibrate pills
    fireEvent.click(screen.getByText('系统、通知与权限'));
    const soundBtn = screen.getByText('音:开');
    const vibrateBtn = screen.getByText('震:关');
    expect(soundBtn.textContent).not.toContain('{state}');
    expect(vibrateBtn.textContent).not.toContain('{state}');

    // Delete confirm modal project name
    fireEvent.click(screen.getByTestId('session-more-s1'));
    fireEvent.click(screen.getByText('删除会话'));
    const modal = screen.getByTestId('delete-session-modal');
    expect(modal.textContent).toContain('所属项目：Alpha');
    expect(modal.textContent).not.toContain('{name}');
    expect(modal.textContent).not.toContain('{title}');

    // Confirm -> 503 fallback modal with reason + title
    fireEvent.click(screen.getByTestId('confirm-delete-session-btn'));
    await waitFor(() => expect(onDeleteSession).toHaveBeenCalledWith('s1', 'auto'));
    await waitFor(() =>
      expect(screen.getByTestId('delete-session-modal').textContent).toContain('Host RPC offline')
    );
    const fallbackText = screen.getByTestId('delete-session-modal').textContent || '';
    expect(fallbackText).toContain('Session One');
    expect(fallbackText).not.toMatch(/\{(reason|title|name)\}/);

    // Close and verify en locale + reasonCode fallback when message is omitted
    fireEvent.click(screen.getByText('取消'));
    rerender(
      <I18nProvider locale="en">
        <ThemeProvider>
          <LeftDrawer {...makeLeftDrawerProps({ onDeleteSession })} />
        </ThemeProvider>
      </I18nProvider>
    );
    expect(screen.getByLabelText('New session in Alpha')).toBeTruthy();
    fireEvent.click(screen.getByTestId('session-more-s1'));
    fireEvent.click(screen.getByText('Delete session'));
    expect(screen.getByTestId('delete-session-modal').textContent).toContain('Project: Alpha');
    fireEvent.click(screen.getByTestId('confirm-delete-session-btn'));
    await waitFor(() => expect(onDeleteSession).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId('delete-session-modal').textContent).toContain('HOST_RPC_TIMEOUT')
    );
    expect(screen.getByTestId('delete-session-modal').textContent).toContain('Session One');
    expect(screen.getByTestId('delete-session-modal').textContent).not.toMatch(
      /\{(reason|title|name)\}/
    );
  });

  it('interpolates NewProjectSheet GitHub/Google Drive degraded hints and RemoteStore removeProject toast', async () => {
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
    const preflightSpy = vi.spyOn(api, 'getRemotePreflight').mockResolvedValue({
      ok: true,
      github: {
        gitInstalled: false,
        gitVersion: null,
        ghInstalled: false,
        ghAuthenticated: false,
        activeAccount: null,
        accounts: [],
        orgs: [],
        canClonePublicOrSsh: false,
        canCreateRepo: false,
        installHints: {
          git: 'brew install git',
          ghLogin: 'gh auth login'
        }
      },
      gdrive: {
        tier: 'cli',
        mounts: [],
        rclone: { installed: true, driveRemotes: ['gdrive'] },
        gdriveCli: { installed: false, authenticated: false, account: null },
        setupHints: []
      }
    });

    const { rerender } = render(
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

    // GitHub tab: git missing -> {hint} interpolated
    fireEvent.click(screen.getByRole('tab', { name: 'GitHub' }));
    await waitFor(() => expect(preflightSpy).toHaveBeenCalled());
    expect(
      await screen.findByText('Git is not installed on the host. Install git first: brew install git')
    ).toBeTruthy();

    // Google Drive tab: cli tier (rclone) -> {tool} interpolated
    fireEvent.click(screen.getByRole('tab', { name: 'Google Drive' }));
    expect(await screen.findByText('Google Drive CLI Ready (rclone)')).toBeTruthy();

    // Switch preflight to gitInstalled=true, ghAuthenticated=false, gdriveCli
    preflightSpy.mockResolvedValueOnce({
      ok: true,
      github: {
        gitInstalled: true,
        gitVersion: '2.45.0',
        ghInstalled: true,
        ghAuthenticated: false,
        activeAccount: null,
        accounts: [],
        orgs: [],
        canClonePublicOrSsh: true,
        canCreateRepo: false,
        installHints: {
          ghLogin: 'gh auth login'
        }
      },
      gdrive: {
        tier: 'cli',
        mounts: [],
        rclone: { installed: false, driveRemotes: [] },
        gdriveCli: { installed: true, authenticated: true, account: 'u@example.com' },
        setupHints: []
      }
    });

    fireEvent.click(screen.getByText('Re-check'));
    await waitFor(() =>
      expect(screen.getByText('Google Drive CLI Ready (gdrive)')).toBeTruthy()
    );

    fireEvent.click(screen.getByRole('tab', { name: 'GitHub' }));
    fireEvent.click(await screen.findByText('Create New Repo & Clone'));
    expect(
      await screen.findByText(
        'GitHub CLI (gh) is not signed in. Run `gh auth login` on the host to create new repos. Public/SSH cloning remains available.'
      )
    ).toBeTruthy();
    rerender(<div />);

    // RemoteStoreController.removeProject toast -> {name} interpolated without raw placeholder
    const ctrl = new RemoteStoreController();
    (ctrl as unknown as { setState: (p: Record<string, unknown>) => void }).setState({
      token: 'tok',
      online: true,
      permissionLevel: 'L2',
      locale: 'zh-CN',
      projects: [makeProject({ id: 'proj-alpha', name: 'Alpha Project' })]
    });
    vi.spyOn(api, 'deleteProject').mockResolvedValue({ ok: true, revision: 3 } as never);
    vi.spyOn(ctrl, 'refreshSessionsAndOrg').mockResolvedValue(undefined);

    await ctrl.removeProject('proj-alpha');
    expect(ctrl.getState().toast).toBe('已从列表移除项目「Alpha Project」');
    expect(ctrl.getState().toast).not.toContain('{name}');

    // Also verify createTranslator / interpolate sanity on affected keys across all 10 locales
    for (const loc of ALL_LOCALES) {
      const tr = createTranslator(loc);
      const samples = [
        tr('left.deleteModalFallbackDesc', { reason: 'OFFLINE', title: 'Demo' }),
        tr('left.deleteModalProject', { name: 'Alpha' }),
        tr('left.newInProject', { name: 'Alpha' }),
        tr('left.soundShort', { state: tr('left.on') }),
        tr('left.vibrateShort', { state: tr('left.off') }),
        tr('newProject.ghGitMissing', { hint: 'brew install git' }),
        tr('newProject.ghNotAuthed', { hint: 'gh auth login' }),
        tr('newProject.gdCliTierTitle', { tool: 'rclone' }),
        tr('store.projectRemovedToast', { name: 'Alpha' })
      ];
      for (const s of samples) {
        expect(s).not.toMatch(/\{(reason|title|name|hint|tool|state)\}/);
      }
    }
    expect(interpolate('Hi {name}', { name: 'Agy' })).toBe('Hi Agy');
  });
});
