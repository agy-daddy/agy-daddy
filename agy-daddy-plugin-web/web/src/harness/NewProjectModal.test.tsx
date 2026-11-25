import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { I18nProvider } from '../i18n';
import type { ProjectGroup } from '../types';
import { NewProjectModal } from './NewProjectModal';

const apiMocks = vi.hoisted(() => ({
  browseWorkspace: vi.fn(),
  mkdirWorkspace: vi.fn(),
  getRemotePreflight: vi.fn(),
  listGithubRepos: vi.fn(),
  startRemoteProjectJob: vi.fn(),
  getRemoteProjectJob: vi.fn(),
  cancelRemoteProjectJob: vi.fn(),
}));

vi.mock('../api/client', () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    payload?: unknown;
    constructor(message: string, status = 500, code = 'API_ERROR', payload?: unknown) {
      super(message);
      this.status = status;
      this.code = code;
      this.payload = payload;
    }
  }
  return {
    ApiError: MockApiError,
    apiClient: {
      browseWorkspace: apiMocks.browseWorkspace,
      mkdirWorkspace: apiMocks.mkdirWorkspace,
      getRemotePreflight: apiMocks.getRemotePreflight,
      listGithubRepos: apiMocks.listGithubRepos,
      startRemoteProjectJob: apiMocks.startRemoteProjectJob,
      getRemoteProjectJob: apiMocks.getRemoteProjectJob,
      cancelRemoteProjectJob: apiMocks.cancelRemoteProjectJob,
    },
  };
});

const groups: ProjectGroup[] = [
  { id: 'grp-1', name: 'Core', sortOrder: 1, collapsed: false },
];

describe('NewProjectModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.browseWorkspace.mockResolvedValue({
      ok: true,
      requestedPath: '/Users/dev',
      resolvedPath: '/Users/dev',
      exists: true,
      willCreateRelative: '',
      parentPath: '/Users',
      breadcrumbs: [
        { name: 'Users', path: '/Users' },
        { name: 'dev', path: '/Users/dev' },
      ],
      entries: [
        { name: 'alpha-repo', path: '/Users/dev/alpha-repo', isGitRepo: true, isSymlink: false },
        { name: 'notes', path: '/Users/dev/notes', isGitRepo: false, isSymlink: false },
      ],
      shortcuts: [
        { kind: 'home', label: 'Home (~)', path: '/Users/dev' },
        { kind: 'default', label: 'Default Workspace', path: '/Users/dev/ws' },
      ],
    });
    apiMocks.mkdirWorkspace.mockResolvedValue({
      ok: true,
      name: 'sub-app',
      path: '/Users/dev/sub-app',
      parentPath: '/Users/dev',
    });
  });

  it('browses local directories, creates a folder, and submits a local project', async () => {
    const onCreateLocalProject = vi.fn().mockResolvedValue({
      id: 'proj-new',
      name: 'alpha-repo',
      rootPath: '/Users/dev/alpha-repo',
      groupId: 'grp-1',
    });
    const onProjectCreated = vi.fn();

    render(
      <I18nProvider defaultLocale="en">
        <NewProjectModal
          open
          groups={groups}
          defaultSessionPath="/Users/dev"
          canAdminWorkspace
          onClose={vi.fn()}
          onCreateLocalProject={onCreateLocalProject}
          onProjectCreated={onProjectCreated}
        />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('dir-entry-alpha-repo')).toBeInTheDocument();
    });
    expect(screen.getByTestId('dir-entry-alpha-repo')).toHaveTextContent('Git');

    fireEvent.click(screen.getByTestId('dir-entry-alpha-repo'));
    expect((screen.getByTestId('local-project-path-input') as HTMLInputElement).value).toBe(
      '/Users/dev/alpha-repo',
    );
    expect((screen.getByTestId('local-project-name-input') as HTMLInputElement).value).toBe(
      'alpha-repo',
    );

    // Create subfolder
    fireEvent.click(screen.getByTestId('dir-browser-mkdir-toggle'));
    fireEvent.change(screen.getByTestId('dir-browser-mkdir-input'), {
      target: { value: 'sub-app' },
    });
    fireEvent.click(screen.getByTestId('dir-browser-mkdir-submit'));

    await waitFor(() => {
      expect(apiMocks.mkdirWorkspace).toHaveBeenCalledWith('/Users/dev', 'sub-app');
    });

    fireEvent.change(screen.getByTestId('new-project-group-select'), {
      target: { value: 'grp-1' },
    });
    fireEvent.click(screen.getByTestId('new-project-submit-local'));

    await waitFor(() => {
      expect(onCreateLocalProject).toHaveBeenCalledWith({
        name: 'sub-app',
        rootPath: '/Users/dev/sub-app',
        groupId: 'grp-1',
        createDir: false,
      });
      expect(onProjectCreated).toHaveBeenCalledTimes(1);
    });
  });

  it('degrades GitHub create when gh is unauthenticated and retries clone-only on CLONE_AFTER_CREATE_FAILED', async () => {
    apiMocks.getRemotePreflight.mockResolvedValueOnce({
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
        installHints: { ghLogin: 'gh auth login' },
      },
    });

    render(
      <I18nProvider defaultLocale="en">
        <NewProjectModal
          open
          groups={groups}
          defaultSessionPath="/Users/dev"
          canAdminWorkspace
          onClose={vi.fn()}
          onCreateLocalProject={vi.fn()}
          onProjectCreated={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByTestId('new-project-tab-github'));
    await waitFor(() => {
      expect(screen.getByTestId('gh-not-authed')).toBeInTheDocument();
    });
    expect(screen.getByTestId('gh-mode-create')).toBeDisabled();

    // Now simulate authenticated recheck and CLONE_AFTER_CREATE_FAILED partial success
    apiMocks.getRemotePreflight.mockResolvedValueOnce({
      ok: true,
      github: {
        gitInstalled: true,
        gitVersion: '2.45.0',
        ghInstalled: true,
        ghAuthenticated: true,
        activeAccount: 'alice',
        accounts: ['alice'],
        orgs: ['acme'],
        canClonePublicOrSsh: true,
        canCreateRepo: true,
        installHints: {},
      },
    });
    apiMocks.listGithubRepos.mockResolvedValue({ ok: true, repos: [] });

    fireEvent.click(screen.getByTestId('gh-recheck-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('gh-mode-create')).not.toBeDisabled();
    });

    fireEvent.click(screen.getByTestId('gh-mode-create'));
    fireEvent.change(screen.getByTestId('gh-new-repo-name-input'), {
      target: { value: 'demo-repo' },
    });

    apiMocks.startRemoteProjectJob
      .mockResolvedValueOnce({
        ok: true,
        jobId: 'job-1',
        job: {
          jobId: 'job-1',
          provider: 'github',
          mode: 'gh_create_and_clone',
          projectName: 'demo-repo',
          localDirName: 'demo-repo',
          groupId: null,
          targetDir: '/Users/dev/demo-repo',
          createdTargetDir: null,
          remoteCreated: {
            ownerRepo: 'alice/demo-repo',
            cloneUrl: 'https://github.com/alice/demo-repo.git',
            htmlUrl: 'https://github.com/alice/demo-repo',
          },
          status: 'failed',
          step: 'cloning',
          error: 'CLONE_AFTER_CREATE_FAILED',
          message: 'network error',
          project: null,
          startedAt: '',
          updatedAt: '',
          elapsedMs: 500,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        jobId: 'job-2',
        job: {
          jobId: 'job-2',
          provider: 'github',
          mode: 'gh_clone',
          projectName: 'demo-repo',
          localDirName: 'demo-repo',
          groupId: null,
          targetDir: '/Users/dev/demo-repo',
          createdTargetDir: null,
          remoteCreated: null,
          status: 'running',
          step: 'cloning',
          error: null,
          message: null,
          project: null,
          startedAt: '',
          updatedAt: '',
          elapsedMs: 10,
        },
      });

    fireEvent.click(screen.getByTestId('new-project-submit-github'));
    await waitFor(() => {
      expect(screen.getByTestId('gh-partial-created-box')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('gh-retry-clone-btn'));
    await waitFor(() => {
      expect(apiMocks.startRemoteProjectJob).toHaveBeenLastCalledWith(
        expect.objectContaining({
          provider: 'github',
          mode: 'gh_clone',
          github: { repoSpec: 'https://github.com/alice/demo-repo.git' },
        }),
      );
    });
  });

  it('hides Google Drive submit button when unavailable and supports switching to local tab', async () => {
    apiMocks.getRemotePreflight.mockResolvedValue({
      ok: true,
      gdrive: {
        tier: 'unavailable',
        mounts: [],
        rclone: { installed: false, driveRemotes: [] },
        gdriveCli: { installed: false, authenticated: false, account: null },
        setupHints: ['Install Google Drive Desktop'],
      },
    });

    render(
      <I18nProvider defaultLocale="en">
        <NewProjectModal
          open
          groups={groups}
          defaultSessionPath="/Users/dev"
          canAdminWorkspace
          onClose={vi.fn()}
          onCreateLocalProject={vi.fn()}
          onProjectCreated={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByTestId('new-project-tab-gdrive'));
    await waitFor(() => {
      expect(screen.getByTestId('gd-unavailable-tier')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('new-project-submit-gdrive')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('gd-switch-local-btn'));
    expect(screen.getByTestId('new-project-submit-local')).toBeInTheDocument();
  });

  it('blocks actions in L1/L0 mode and surfaces forbidden path errors from browseWorkspace', async () => {
    apiMocks.browseWorkspace.mockRejectedValueOnce(
      new ApiError('FORBIDDEN_SYSTEM_ROOT', 403, 'FORBIDDEN_SYSTEM_ROOT'),
    );

    render(
      <I18nProvider defaultLocale="en">
        <NewProjectModal
          open
          groups={groups}
          defaultSessionPath="/etc"
          canAdminWorkspace={false}
          onClose={vi.fn()}
          onCreateLocalProject={vi.fn()}
          onProjectCreated={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByTestId('new-project-l2-warning')).toBeInTheDocument();
    expect(screen.getByTestId('new-project-submit-local')).toBeDisabled();
  });
});
