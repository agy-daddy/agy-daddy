import { describe, expect, it } from 'vitest';
import {
  detectHighRiskPrompt,
  getGhostSuggestions,
  isOptimizerShortcut,
  matchesShortcutEvent,
  resolveQuickPrompts,
  serializeEventsToMarkdown,
} from './composerUtils';

describe('composerUtils', () => {
  it('detects high-risk shell and SQL patterns accurately', () => {
    expect(detectHighRiskPrompt('list all files in src/')).toEqual({ risky: false, labels: [] });
    expect(detectHighRiskPrompt('rm -rf /tmp/test && git push --force origin main')).toEqual({
      risky: true,
      labels: ['rm -rf', 'git push --force'],
    });
    expect(detectHighRiskPrompt('DROP TABLE users;')).toEqual({
      risky: true,
      labels: ['SQL DROP/TRUNCATE/DELETE'],
    });
  });

  it('resolves quick prompts from composerState and builds ghost suggestions', () => {
    const resolved = resolveQuickPrompts(
      {
        ok: true,
        enabled: true,
        settings: {},
        quickPrompts: [
          { id: 'plan', label: '规划', template: '/plan ', builtin: true },
          { id: 'custom-1', label: 'Review', template: 'Review this diff', builtin: false },
        ],
      },
      'zh-CN',
    );
    expect(resolved).toHaveLength(2);
    expect(resolved[0].label).toBe('规划');

    const emptySuggestions = getGhostSuggestions({
      text: '',
      composerState: {
        ok: true,
        enabled: true,
        settings: {},
        quickPrompts: resolved,
        frequentPrompts: ['Run vitest suite', { id: 'f2', label: 'Check build', template: 'npm run build' }],
      },
      quickPrompts: resolved,
      contextUsagePct: 90,
      autoCompactThreshold: 80,
    });
    expect(emptySuggestions[0]).toBe('/compact');
    expect(emptySuggestions).toContain('Run vitest suite');
    expect(emptySuggestions).toContain('npm run build');

    const slashSuggestions = getGhostSuggestions({
      text: '/gr',
      quickPrompts: resolved,
    });
    expect(slashSuggestions).toEqual(['/grill-me']);
  });

  it('matches Cmd/Ctrl+Shift+O and custom optimizer shortcuts', () => {
    expect(isOptimizerShortcut({ key: 'O', metaKey: true, shiftKey: true })).toBe(true);
    expect(isOptimizerShortcut({ key: 'o', ctrlKey: true, shiftKey: true })).toBe(true);
    expect(isOptimizerShortcut({ key: 'O', altKey: true, shiftKey: true }, 'Alt+Shift+O')).toBe(true);
    expect(matchesShortcutEvent({ key: 'o', altKey: true, shiftKey: true }, 'Alt+Shift+O')).toBe(true);
    expect(isOptimizerShortcut({ key: 'o', shiftKey: true })).toBe(false);
  });

  it('serializes timeline events into readable Markdown', () => {
    const md = serializeEventsToMarkdown('Demo Session', [
      {
        seq: 0,
        kind: 'user',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
        payload: { text: 'Hello' },
      },
      {
        seq: 1,
        kind: 'command',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_RUN_COMMAND',
        payload: { commandLine: 'echo ok', combinedOutput: 'ok' },
      },
    ]);

    expect(md).toContain('# Demo Session');
    expect(md).toContain('Hello');
    expect(md).toContain('$ echo ok');
    expect(md).toContain('ok');
  });
});
