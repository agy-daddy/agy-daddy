import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../api/client';
import { I18nProvider } from '../i18n';
import type { ArtifactItem, ArtifactPreviewerDescriptor } from '../types';
import {
  adaptHostPluginPreviewer,
  ArtifactsPanel,
  clearRuntimeArtifactPreviewers,
  registerArtifactPreviewer,
  resolveArtifactPreviewer,
} from './index';

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nProvider>{ui}</I18nProvider>);
}

function makeItem(overrides: Partial<ArtifactItem>): ArtifactItem {
  return {
    name: 'file.txt',
    path: 'file.txt',
    size: 128,
    mime: 'text/plain',
    modifiedAt: '2026-11-24T10:00:00.000Z',
    ...overrides,
  };
}

describe('artifactPreviewers & ArtifactsPanel', () => {
  beforeEach(() => {
    clearRuntimeArtifactPreviewers();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearRuntimeArtifactPreviewers();
    vi.restoreAllMocks();
  });

  it('resolves built-in previewers for md, svg, jpg, png, html, pdf, text, and unknown binary', () => {
    expect(resolveArtifactPreviewer(makeItem({ name: 'plan.md', mime: 'text/markdown' })).id).toBe(
      'builtin.markdown',
    );
    expect(resolveArtifactPreviewer(makeItem({ name: 'diagram.svg', mime: 'image/svg+xml' })).id).toBe(
      'builtin.svg',
    );
    expect(resolveArtifactPreviewer(makeItem({ name: 'photo.jpg', mime: 'image/jpeg' })).id).toBe(
      'builtin.image',
    );
    expect(resolveArtifactPreviewer(makeItem({ name: 'screen.png', mime: 'image/png' })).id).toBe(
      'builtin.image',
    );
    expect(resolveArtifactPreviewer(makeItem({ name: 'report.html', mime: 'text/html' })).id).toBe(
      'builtin.html',
    );
    expect(resolveArtifactPreviewer(makeItem({ name: 'spec.pdf', mime: 'application/pdf' })).id).toBe(
      'builtin.pdf',
    );
    expect(resolveArtifactPreviewer(makeItem({ name: 'data.json', mime: 'application/json' })).id).toBe(
      'builtin.text',
    );
    expect(
      resolveArtifactPreviewer(makeItem({ name: 'archive.bin', mime: 'application/octet-stream' })).id,
    ).toBe('builtin.unsupported');
  });

  it('supports custom runtime plugin priority override and unregister cleanup', () => {
    const mdItem = makeItem({ name: 'notes.md', mime: 'text/markdown' });
    expect(resolveArtifactPreviewer(mdItem).id).toBe('builtin.markdown');

    const unregister = registerArtifactPreviewer({
      id: 'custom.markdown.pro',
      name: 'Markdown Pro',
      priority: 120,
      extensions: ['.md'],
      mimeTypes: ['text/markdown'],
      requiresTextContent: true,
      supportsRawToggle: true,
      canPreview: (item) => item.name.endsWith('.md'),
      render: (ctx) => <div data-testid="custom-md">{ctx.textContent}</div>,
    });

    expect(resolveArtifactPreviewer(mdItem).id).toBe('custom.markdown.pro');

    unregister();
    expect(resolveArtifactPreviewer(mdItem).id).toBe('builtin.markdown');
  });

  it('adapts host plugin descriptors for plugin_iframe, plugin_html, and plugin_markdown', () => {
    const iframeDesc: ArtifactPreviewerDescriptor = {
      id: 'plugin.csv',
      name: 'CSV Table',
      extensions: ['.csv'],
      mimeTypes: ['text/csv'],
      source: 'plugin',
      pluginId: 'agy-daddy.csv',
      renderKind: 'plugin_iframe',
      iframeUrlTemplate: '/preview/csv?file={file}&session={sessionId}',
    };
    const csvItem = makeItem({ name: 'metrics.csv', path: 'dir/metrics.csv', mime: 'text/csv' });
    const csvPlugin = resolveArtifactPreviewer(csvItem, [iframeDesc]);
    expect(csvPlugin.id).toBe('plugin.csv');
    expect(csvPlugin.requiresTextContent).toBe(false);

    const { unmount } = render(
      <>{csvPlugin.render({
        sessionId: 'sess-1',
        item: csvItem,
        rawUrl: '/api/v1/artifacts/sess-1/raw?file=dir%2Fmetrics.csv',
        textContent: null,
        mode: 'preview',
        zoom: 1,
        t: (k) => String(k),
      })}</>,
    );
    const iframe = screen.getByTestId('artifact-plugin-iframe') as HTMLIFrameElement;
    expect(iframe.getAttribute('src')).toBe('/preview/csv?file=dir%2Fmetrics.csv&session=sess-1');
    unmount();

    const htmlPlugin = adaptHostPluginPreviewer({
      id: 'plugin.html-viz',
      name: 'HTML Viz',
      extensions: ['.viz'],
      mimeTypes: ['application/x-viz'],
      source: 'plugin',
      pluginId: 'agy-daddy.viz',
      renderKind: 'plugin_html',
    });
    render(
      <>{htmlPlugin.render({
        sessionId: 'sess-1',
        item: makeItem({ name: 'chart.viz', mime: 'application/x-viz' }),
        rawUrl: '/raw',
        textContent: null,
        mode: 'preview',
        zoom: 1,
        pluginPayload: { ok: true, kind: 'html', content: '<p>Plugin Chart</p>' },
        t: (k) => String(k),
      })}</>,
    );
    const htmlFrame = screen.getByTestId('artifact-plugin-html-frame') as HTMLIFrameElement;
    expect(htmlFrame.getAttribute('sandbox')).toBe('');
    expect(htmlFrame.getAttribute('srcdoc')).toBe('<p>Plugin Chart</p>');

    const mdPlugin = adaptHostPluginPreviewer({
      id: 'plugin.md-report',
      name: 'MD Report',
      extensions: ['.report'],
      mimeTypes: ['text/x-report'],
      source: 'plugin',
      pluginId: 'agy-daddy.report',
      renderKind: 'plugin_markdown',
    });
    render(
      <>{mdPlugin.render({
        sessionId: 'sess-1',
        item: makeItem({ name: 'summary.report', mime: 'text/x-report' }),
        rawUrl: '/raw',
        textContent: null,
        mode: 'preview',
        zoom: 1,
        pluginPayload: { ok: true, kind: 'markdown', content: '# Host Summary\n\n**Ready**' },
        t: (k) => String(k),
      })}</>,
    );
    expect(screen.getByTestId('artifact-plugin-markdown-preview')).toHaveTextContent('Host Summary');
  });

  it('renders rich Markdown blocks/inline elements safely and toggles Raw mode', async () => {
    const mdSource = [
      '# Release Plan',
      '',
      '> Stay **focused** on *safety*.',
      '',
      '---',
      '',
      '- Item `one`',
      '- [Safe Link](https://example.com/docs)',
      '- [Blocked Link](javascript:alert(1))',
      '',
      '1. Step first',
      '2. Step second',
      '',
      '| Format | Status |',
      '| --- | ---: |',
      '| Markdown | Ready |',
      '',
      '```ts',
      'export const ok = true;',
      '```',
    ].join('\n');

    vi.spyOn(apiClient, 'listArtifactPreviewers').mockRejectedValue(new Error('offline'));
    vi.spyOn(apiClient, 'listArtifacts').mockResolvedValue({
      ok: true,
      sessionId: 's1',
      items: [makeItem({ name: 'plan.md', path: 'plan.md', mime: 'text/markdown', size: 240 })],
    });
    const readSpy = vi.spyOn(apiClient, 'readArtifact').mockResolvedValue({
      ok: true,
      name: 'plan.md',
      path: 'plan.md',
      mime: 'text/markdown',
      size: 240,
      truncated: false,
      content: mdSource,
    });

    renderWithI18n(<ArtifactsPanel sessionId="s1" />);

    const mdView = await screen.findByTestId('artifact-markdown-preview');
    expect(mdView.querySelector('h1')).toHaveTextContent('Release Plan');
    expect(mdView.querySelector('blockquote')).toHaveTextContent('Stay focused on safety.');
    expect(mdView.querySelector('hr')).not.toBeNull();
    expect(mdView.querySelectorAll('ul li')).toHaveLength(3);
    expect(mdView.querySelectorAll('ol li')).toHaveLength(2);
    expect(mdView.querySelector('table')).toHaveTextContent('Markdown');
    expect(mdView.querySelector('pre code')).toHaveTextContent('export const ok = true;');

    const links = Array.from(mdView.querySelectorAll('a'));
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', 'https://example.com/docs');
    expect(mdView).toHaveTextContent('Blocked Link');

    fireEvent.click(screen.getByTestId('artifact-mode-raw'));
    const rawPre = await screen.findByTestId('artifact-raw-content');
    expect(rawPre).toHaveTextContent('# Release Plan');
    expect(readSpy).toHaveBeenCalledTimes(1);
  });

  it('skips readArtifact for binary png/jpg/pdf and svg preview, and reads svg lazily in Raw mode', async () => {
    const items: ArtifactItem[] = [
      makeItem({ name: 'shot.png', path: 'shot.png', mime: 'image/png', size: 4096 }),
      makeItem({ name: 'photo.jpg', path: 'photo.jpg', mime: 'image/jpeg', size: 8192 }),
      makeItem({ name: 'manual.pdf', path: 'manual.pdf', mime: 'application/pdf', size: 12000 }),
      makeItem({ name: 'logo.svg', path: 'logo.svg', mime: 'image/svg+xml', size: 512 }),
      makeItem({ name: 'page.html', path: 'page.html', mime: 'text/html', size: 320 }),
      makeItem({ name: 'blob.bin', path: 'blob.bin', mime: 'application/octet-stream', size: 900 }),
    ];

    vi.spyOn(apiClient, 'listArtifactPreviewers').mockResolvedValue({
      ok: true,
      builtins: [],
      plugins: [],
    });
    vi.spyOn(apiClient, 'listArtifacts').mockResolvedValue({
      ok: true,
      sessionId: 's2',
      items,
    });
    const readSpy = vi.spyOn(apiClient, 'readArtifact').mockImplementation(async (_sid, file) => {
      if (file === 'logo.svg') {
        return {
          ok: true,
          name: 'logo.svg',
          path: 'logo.svg',
          mime: 'image/svg+xml',
          size: 512,
          truncated: false,
          content: '<svg><circle r="10" /></svg>',
        };
      }
      return {
        ok: true,
        name: 'page.html',
        path: 'page.html',
        mime: 'text/html',
        size: 320,
        truncated: false,
        content: '<h1>Sandboxed</h1><script>alert(1)</script>',
      };
    });

    renderWithI18n(<ArtifactsPanel sessionId="s2" />);

    // 1. PNG selected automatically: renders <img> with rawUrl, zero readArtifact calls
    const pngImg = (await screen.findByTestId('artifact-image-preview')) as HTMLImageElement;
    expect(pngImg.getAttribute('src')).toBe('/api/v1/artifacts/s2/raw?file=shot.png');
    expect(readSpy).not.toHaveBeenCalled();

    Object.defineProperty(pngImg, 'naturalWidth', { value: 640, configurable: true });
    Object.defineProperty(pngImg, 'naturalHeight', { value: 480, configurable: true });
    fireEvent.load(pngImg);
    expect(screen.getByTestId('artifact-image-dimensions')).toHaveTextContent('640 × 480');

    fireEvent.click(screen.getByTestId('artifact-zoom-in'));
    expect(screen.getByTestId('artifact-image-preview')).toHaveAttribute('data-zoom', '1.25');
    fireEvent.click(screen.getByTestId('artifact-zoom-fit'));
    expect(screen.getByTestId('artifact-image-preview')).toHaveAttribute('data-zoom', 'fit');
    fireEvent.click(screen.getByTestId('artifact-zoom-actual'));
    expect(screen.getByTestId('artifact-image-preview')).toHaveAttribute('data-zoom', '1');

    // 2. JPG: renders <img> with rawUrl, zero readArtifact calls
    fireEvent.click(screen.getByTestId('artifact-item-photo.jpg'));
    const jpgImg = await screen.findByTestId('artifact-image-preview');
    expect(jpgImg.getAttribute('src')).toBe('/api/v1/artifacts/s2/raw?file=photo.jpg');
    expect(readSpy).not.toHaveBeenCalled();

    // 3. PDF: renders <iframe> with rawUrl, zero readArtifact calls
    fireEvent.click(screen.getByTestId('artifact-item-manual.pdf'));
    const pdfFrame = await screen.findByTestId('artifact-pdf-frame');
    expect(pdfFrame.getAttribute('src')).toBe('/api/v1/artifacts/s2/raw?file=manual.pdf');
    expect(screen.getByTestId('artifact-open-raw')).toHaveAttribute(
      'href',
      '/api/v1/artifacts/s2/raw?file=manual.pdf',
    );
    expect(readSpy).not.toHaveBeenCalled();

    // 4. SVG: renders safe <img> in preview mode without readArtifact, fetches lazily on Raw click
    fireEvent.click(screen.getByTestId('artifact-item-logo.svg'));
    const svgImg = await screen.findByTestId('artifact-svg-preview');
    expect(svgImg.tagName).toBe('IMG');
    expect(svgImg.getAttribute('src')).toBe('/api/v1/artifacts/s2/raw?file=logo.svg');
    expect(readSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('artifact-mode-raw'));
    const svgRaw = await screen.findByTestId('artifact-raw-content');
    expect(svgRaw).toHaveTextContent('<svg><circle r="10" /></svg>');
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(readSpy).toHaveBeenCalledWith('s2', 'logo.svg', expect.any(AbortSignal));

    // 5. HTML: renders sandboxed iframe with srcDoc and notice bar
    fireEvent.click(screen.getByTestId('artifact-item-page.html'));
    const htmlFrame = await screen.findByTestId('artifact-html-frame');
    expect(htmlFrame.getAttribute('sandbox')).toBe('');
    expect(htmlFrame.getAttribute('srcdoc')).toContain('<h1>Sandboxed</h1>');
    expect(screen.getByTestId('artifact-html-notice')).toBeInTheDocument();

    // 6. Unknown binary fallback: renders unsupported card with download link
    fireEvent.click(screen.getByTestId('artifact-item-blob.bin'));
    const unsupported = await screen.findByTestId('artifact-unsupported-preview');
    expect(unsupported).toBeInTheDocument();
    expect(screen.getByTestId('artifact-unsupported-download')).toHaveAttribute(
      'href',
      '/api/v1/artifacts/s2/raw?file=blob.bin',
    );
  });

  it('calls renderPluginArtifactPreview for host plugin_html previewers', async () => {
    vi.spyOn(apiClient, 'listArtifactPreviewers').mockResolvedValue({
      ok: true,
      builtins: [],
      plugins: [
        {
          id: 'plugin.sql',
          name: 'SQL Viewer',
          extensions: ['.sql'],
          mimeTypes: ['application/sql'],
          source: 'plugin',
          pluginId: 'agy-daddy.sql',
          renderKind: 'plugin_html',
        },
      ],
    });
    vi.spyOn(apiClient, 'listArtifacts').mockResolvedValue({
      ok: true,
      sessionId: 's3',
      items: [makeItem({ name: 'query.sql', path: 'query.sql', mime: 'application/sql', size: 64 })],
    });
    const readSpy = vi.spyOn(apiClient, 'readArtifact');
    const pluginSpy = vi.spyOn(apiClient, 'renderPluginArtifactPreview').mockResolvedValue({
      ok: true,
      kind: 'html',
      content: '<div>SELECT 1</div>',
    });

    renderWithI18n(<ArtifactsPanel sessionId="s3" />);

    const frame = await screen.findByTestId('artifact-plugin-html-frame');
    expect(frame.getAttribute('srcdoc')).toBe('<div>SELECT 1</div>');
    expect(pluginSpy).toHaveBeenCalledWith('s3', {
      pluginId: 'agy-daddy.sql',
      file: 'query.sql',
      mime: 'application/sql',
    });
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('formats JSON text fallback and supports Copy action', async () => {
    vi.spyOn(apiClient, 'listArtifactPreviewers').mockResolvedValue({
      ok: true,
      builtins: [],
      plugins: [],
    });
    vi.spyOn(apiClient, 'listArtifacts').mockResolvedValue({
      ok: true,
      sessionId: 's4',
      items: [makeItem({ name: 'config.json', path: 'config.json', mime: 'application/json', size: 22 })],
    });
    vi.spyOn(apiClient, 'readArtifact').mockResolvedValue({
      ok: true,
      name: 'config.json',
      path: 'config.json',
      mime: 'application/json',
      size: 22,
      truncated: false,
      content: '{"ok":true,"count":2}',
    });

    renderWithI18n(<ArtifactsPanel sessionId="s4" />);

    const pre = await screen.findByTestId('artifact-preview-content');
    expect(pre.textContent).toContain('"ok": true');
    expect(pre.textContent).toContain('"count": 2');
    expect(screen.getByTestId('artifact-copy-btn')).toBeInTheDocument();
  });
});
