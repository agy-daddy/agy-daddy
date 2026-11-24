import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { MarkdownContent } from './MarkdownContent';

describe('MarkdownContent', () => {
  it('renders headings, emphasis, lists, tasks, tables, code fences with copy, and safe file links', async () => {
    const onInspectFile = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const sample = [
      '### Summary Heading',
      '',
      'Here is **bold**, *italic*, ~~old~~, and `inlineCode`.',
      '',
      '- [x] Done task',
      '- [ ] Pending task',
      '',
      '| File | Status |',
      '| --- | --- |',
      '| app.ts | ok |',
      '',
      '```ts',
      'const ready = true;',
      '```',
      '',
      'Open [App.tsx](file:///Volumes/external/Projects/agy-daddy/App.tsx#L10) or [Docs](https://example.com) or [Bad](javascript:alert(1)).',
    ].join('\n');

    render(
      <I18nProvider defaultLocale="en">
        <MarkdownContent text={sample} onInspectFile={onInspectFile} />
      </I18nProvider>,
    );

    expect(screen.getByRole('heading', { level: 3, name: 'Summary Heading' })).toBeInTheDocument();
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByText('italic').tagName).toBe('EM');
    expect(screen.getByText('old').tagName).toBe('DEL');
    expect(screen.getByText('inlineCode').tagName).toBe('CODE');
    expect(screen.getByText('Done task')).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('app.ts')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('const ready = true;');

    fireEvent.click(screen.getByRole('button', { name: 'App.tsx' }));
    expect(onInspectFile).toHaveBeenCalledWith('/Volumes/external/Projects/agy-daddy/App.tsx');

    const extLink = screen.getByRole('link', { name: 'Docs' });
    expect(extLink).toHaveAttribute('href', 'https://example.com');
    expect(screen.queryByRole('link', { name: 'Bad' })).not.toBeInTheDocument();
  });

  it('highlights search terms inside markdown prose without breaking formatting', () => {
    render(
      <I18nProvider defaultLocale="en">
        <MarkdownContent
          text={'Check **package scripts** and `npm test`.'}
          highlightRegex={/package scripts/gi}
          markClassName="hit-mark"
        />
      </I18nProvider>,
    );

    const mark = document.querySelector('mark.hit-mark');
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toBe('package scripts');
  });

  it('renders inline code nested inside bold emphasis and file links without literal markers', () => {
    const onInspectFile = vi.fn();
    const { container } = render(
      <I18nProvider defaultLocale="en">
        <MarkdownContent
          text={'Use **controller `createLauncherController`** and open [`launcher.js`](file:///Volumes/external/Projects/agy-daddy/launcher.js).'}
          onInspectFile={onInspectFile}
        />
      </I18nProvider>,
    );

    const strongEl = container.querySelector('strong');
    expect(strongEl).not.toBeNull();
    expect(strongEl?.textContent).toBe('controller createLauncherController');
    expect(strongEl?.querySelector('code')?.textContent).toBe('createLauncherController');
    expect(container.textContent).not.toContain('**');

    const linkBtn = screen.getByRole('button', { name: 'launcher.js' });
    expect(linkBtn.querySelector('code')?.textContent).toBe('launcher.js');
    fireEvent.click(linkBtn);
    expect(onInspectFile).toHaveBeenCalledWith('/Volumes/external/Projects/agy-daddy/launcher.js');
  });
});
