import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../api/client';
import { I18nProvider } from '../i18n';
import { formatInlineDiffQuote, GitDiffPanel, parseUnifiedDiff } from './GitDiffPanel';

const SAMPLE_DIFF = [
  'diff --git a/src/service.ts b/src/service.ts',
  'index 1111111..2222222 100644',
  '--- a/src/service.ts',
  '+++ b/src/service.ts',
  '@@ -10,4 +20,5 @@ export function run() {',
  '   const base = 1;',
  '-  const oldVal = 2;',
  '+  const nextVal = 3;',
  '+  const label = `v${nextVal}`;',
  '   return base;',
  '\\ No newline at end of file',
].join('\n');

describe('parseUnifiedDiff & formatInlineDiffQuote', () => {
  it('computes real hunk line numbers for context, del, and add lines', () => {
    const sections = parseUnifiedDiff(SAMPLE_DIFF);
    expect(sections).toHaveLength(1);
    expect(sections[0].filePath).toBe('src/service.ts');

    const codeLines = sections[0].lines.filter(
      (l) => l.kind === 'add' || l.kind === 'del' || l.kind === 'context',
    );
    expect(codeLines.map((l) => ({ kind: l.kind, lineNo: l.lineNo }))).toEqual([
      { kind: 'context', lineNo: 20 },
      { kind: 'del', lineNo: 11 },
      { kind: 'add', lineNo: 21 },
      { kind: 'add', lineNo: 22 },
      { kind: 'context', lineNo: 23 },
    ]);
  });

  it('formats inline diff quotes cleanly including code containing backticks', () => {
    expect(
      formatInlineDiffQuote('src/service.ts', 21, '+  const nextVal = 3;', 'Check boundary'),
    ).toBe('`src/service.ts:21`\n> `const nextVal = 3;`\nCheck boundary');

    expect(
      formatInlineDiffQuote('src/service.ts', 22, '+  const label = `v${nextVal}`;', 'Template ok?'),
    ).toBe('`src/service.ts:22`\n> `` const label = `v${nextVal}`; ``\nTemplate ok?');
  });
});

describe('GitDiffPanel Git workbench & inline diff comment backfill', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(apiClient, 'getGitDiff').mockResolvedValue({
      ok: true,
      isGitRepo: true,
      branch: 'feat/git-ui',
      files: [
        {
          path: 'src/service.ts',
          status: 'modified',
          additions: 2,
          deletions: 1,
          staged: false,
          unstaged: true,
        },
        {
          path: 'src/staged.ts',
          status: 'added',
          additions: 5,
          deletions: 0,
          staged: true,
          unstaged: false,
        },
      ],
      diffText: SAMPLE_DIFF,
    });
    vi.spyOn(apiClient, 'getGitWorktrees').mockResolvedValue({
      ok: true,
      isGitRepo: true,
      worktrees: [
        {
          path: '/repo/main',
          head: 'abcdef1234567890',
          branch: 'feat/git-ui',
          bare: false,
          detached: false,
          locked: false,
          prunable: false,
          isCurrent: true,
          allowed: true,
        },
        {
          path: '/repo/wt-hotfix',
          head: '9876543210fedcba',
          branch: 'fix/hotfix',
          bare: false,
          detached: false,
          locked: false,
          prunable: true,
          isCurrent: false,
          allowed: false,
        },
      ],
    });
  });

  it('quotes clicked diff lines (with custom or default prompt) back into Composer and cancels on Escape', async () => {
    const onInsert = vi.fn();
    render(
      <I18nProvider defaultLocale="zh-CN">
        <GitDiffPanel
          root="/repo/main"
          channel="loopback"
          permissionLevel="L2"
          onInsertToComposer={onInsert}
        />
      </I18nProvider>,
    );

    const addLine = await screen.findByTestId('diff-line-src/service.ts-add-21');
    fireEvent.click(addLine);

    expect(screen.getByTestId('diff-inline-comment-box')).toBeInTheDocument();
    const input = screen.getByTestId('diff-inline-comment-input');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('diff-inline-comment-box')).not.toBeInTheDocument();

    // Re-open on deleted line and submit default prompt with Enter
    const delLine = screen.getByTestId('diff-line-src/service.ts-del-11');
    fireEvent.click(delLine);
    fireEvent.keyDown(screen.getByTestId('diff-inline-comment-input'), { key: 'Enter' });

    expect(onInsert).toHaveBeenCalledWith(
      '`src/service.ts:11`\n> `const oldVal = 2;`\n请检查这一行',
    );

    // Custom comment on added line
    fireEvent.click(addLine);
    fireEvent.change(screen.getByTestId('diff-inline-comment-input'), {
      target: { value: '建议改用常量命名' },
    });
    fireEvent.click(screen.getByTestId('diff-inline-comment-submit'));

    expect(onInsert).toHaveBeenLastCalledWith(
      '`src/service.ts:21`\n> `const nextVal = 3;`\n建议改用常量命名',
    );
  });

  it('enforces L0 vs L1 non-loopback permission gating accurately', async () => {
    const onInsert = vi.fn();
    const { rerender } = render(
      <I18nProvider defaultLocale="en">
        <GitDiffPanel
          root="/repo/main"
          channel="lan"
          permissionLevel="L0"
          onInsertToComposer={onInsert}
        />
      </I18nProvider>,
    );

    expect(await screen.findByTestId('git-readonly-badge')).toHaveTextContent('L0 read-only');
    expect(screen.queryByTestId('git-push-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('git-commit-bar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('git-stage-file-src/service.ts')).not.toBeInTheDocument();

    // L0 blocks composer quote insertion
    fireEvent.click(screen.getByTestId('diff-line-src/service.ts-add-21'));
    expect(screen.queryByTestId('diff-inline-comment-submit')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('diff-inline-comment-cancel'));

    // Upgrade to L1: Git mutations remain read-only, but Diff inline quote backfill is enabled
    rerender(
      <I18nProvider defaultLocale="en">
        <GitDiffPanel
          root="/repo/main"
          channel="lan"
          permissionLevel="L1"
          onInsertToComposer={onInsert}
        />
      </I18nProvider>,
    );

    expect(await screen.findByTestId('git-readonly-badge')).toHaveTextContent('L1 read-only');
    expect(screen.queryByTestId('git-push-btn')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('diff-line-src/service.ts-add-21'));
    fireEvent.click(screen.getByTestId('diff-inline-comment-submit'));
    expect(onInsert).toHaveBeenCalledWith(
      '`src/service.ts:21`\n> `const nextVal = 3;`\nPlease check this line',
    );
  });

  it('drives stage, stage-all, commit, push, and worktree create/switch/remove/prune actions', async () => {
    const stageSpy = vi
      .spyOn(apiClient, 'gitStage')
      .mockResolvedValue({ ok: true, staged: true, paths: ['src/service.ts'] });
    const commitSpy = vi.spyOn(apiClient, 'gitCommit').mockResolvedValue({
      ok: true,
      commitSha: '1234567890abcdef',
      branch: 'feat/git-ui',
      message: 'feat: update service',
      stdout: '',
    });
    const pushSpy = vi.spyOn(apiClient, 'gitPush').mockResolvedValue({
      ok: true,
      remote: 'origin',
      branch: 'feat/git-ui',
      stdout: '',
      stderr: '',
    });
    const wtSpy = vi.spyOn(apiClient, 'gitWorktree').mockResolvedValue({
      ok: true,
      isGitRepo: true,
      worktrees: [],
    });
    const onAuthorizeRoot = vi.fn().mockResolvedValue(undefined);
    const onSelectRoot = vi.fn();
    const onGitMutated = vi.fn();

    render(
      <I18nProvider defaultLocale="en">
        <GitDiffPanel
          root="/repo/main"
          channel="loopback"
          permissionLevel="L2"
          onAuthorizeRoot={onAuthorizeRoot}
          onSelectWorkspaceRoot={onSelectRoot}
          onGitMutated={onGitMutated}
        />
      </I18nProvider>,
    );

    // Stage individual unstaged file
    fireEvent.click(await screen.findByTestId('git-stage-file-src/service.ts'));
    await waitFor(() =>
      expect(stageSpy).toHaveBeenCalledWith({
        root: '/repo/main',
        paths: ['src/service.ts'],
        unstage: false,
      }),
    );

    // Stage all
    fireEvent.click(screen.getByTestId('git-stage-all-btn'));
    await waitFor(() =>
      expect(stageSpy).toHaveBeenCalledWith({
        root: '/repo/main',
        all: true,
        unstage: false,
      }),
    );

    // Commit staged changes
    const commitInput = screen.getByTestId('git-commit-input');
    fireEvent.change(commitInput, { target: { value: 'feat: update service' } });
    fireEvent.click(screen.getByTestId('git-commit-btn'));
    await waitFor(() =>
      expect(commitSpy).toHaveBeenCalledWith({
        root: '/repo/main',
        message: 'feat: update service',
      }),
    );
    expect(await screen.findByTestId('git-action-notice')).toHaveTextContent('Committed 1234567');

    // Push
    fireEvent.click(screen.getByTestId('git-push-btn'));
    await waitFor(() =>
      expect(pushSpy).toHaveBeenCalledWith({
        root: '/repo/main',
        branch: 'feat/git-ui',
        setUpstream: true,
      }),
    );

    // Open Worktrees drawer: switch auto-authorizes unallowed worktree, create, prune, remove
    fireEvent.click(screen.getByTestId('git-worktrees-toggle-btn'));
    expect(screen.getByTestId('git-worktrees-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('git-worktree-switch-/repo/wt-hotfix'));
    await waitFor(() => expect(onAuthorizeRoot).toHaveBeenCalledWith('/repo/wt-hotfix'));
    expect(onSelectRoot).toHaveBeenCalledWith('/repo/wt-hotfix');

    fireEvent.click(screen.getByTestId('git-worktree-prune-btn'));
    await waitFor(() =>
      expect(wtSpy).toHaveBeenCalledWith({ root: '/repo/main', action: 'prune' }),
    );

    fireEvent.change(screen.getByTestId('git-worktree-path-input'), {
      target: { value: '../wt-next' },
    });
    fireEvent.change(screen.getByTestId('git-worktree-branch-input'), {
      target: { value: 'feat/wt-next' },
    });
    fireEvent.click(screen.getByTestId('git-worktree-create-btn'));
    await waitFor(() =>
      expect(wtSpy).toHaveBeenCalledWith({
        root: '/repo/main',
        action: 'add',
        path: '../wt-next',
        branch: 'feat/wt-next',
        createBranch: true,
      }),
    );
    expect(onGitMutated).toHaveBeenCalled();
  });
});
