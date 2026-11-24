import React, { useEffect, useState } from 'react';
import type { TranslateFn } from '../i18n';
import type {
  ArtifactItem,
  ArtifactPreviewerDescriptor,
  ArtifactReadResponse,
  PluginArtifactPreviewResponse,
} from '../types';
import { formatBytes } from './dockUtils';
import styles from './ArtifactsPanel.module.css';

export interface ArtifactPreviewContext {
  sessionId: string;
  item: ArtifactItem;
  rawUrl: string;
  textContent: string | null;
  previewData?: ArtifactReadResponse | null;
  mode: 'preview' | 'raw';
  zoom: number;
  pluginPayload?: PluginArtifactPreviewResponse | null;
  t: TranslateFn;
}

export interface ArtifactPreviewPlugin {
  id: string;
  name: string;
  priority: number;
  extensions: string[];
  mimeTypes: string[];
  requiresTextContent: boolean;
  supportsRawToggle?: boolean;
  source?: 'builtin' | 'plugin';
  pluginId?: string;
  renderKind?: ArtifactPreviewerDescriptor['renderKind'];
  iframeUrlTemplate?: string;
  canPreview: (item: ArtifactItem) => boolean;
  render: (ctx: ArtifactPreviewContext) => React.ReactNode;
}

const TEXT_EXTENSIONS = [
  '.txt',
  '.log',
  '.json',
  '.yaml',
  '.yml',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.scss',
  '.xml',
  '.csv',
  '.sh',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.toml',
  '.ini',
  '.sql',
];

const TEXT_MIME_TYPES = [
  'text/*',
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-yaml',
];

function getLowerExtension(item: ArtifactItem): string {
  const target = (item.name || item.path || '').trim().toLowerCase();
  const slashIdx = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'));
  const base = slashIdx >= 0 ? target.slice(slashIdx + 1) : target;
  const dotIdx = base.lastIndexOf('.');
  return dotIdx > 0 ? base.slice(dotIdx) : '';
}

function getLowerMime(item: ArtifactItem): string {
  return (item.mime || '').split(';')[0].trim().toLowerCase();
}

function normalizeExtensions(extensions: string[]): string[] {
  return extensions
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean)
    .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`));
}

function normalizeMimeTypes(mimeTypes: string[]): string[] {
  return mimeTypes
    .map((mime) => mime.split(';')[0].trim().toLowerCase())
    .filter(Boolean);
}

function matchesMimePattern(mime: string, pattern: string): boolean {
  if (!mime || !pattern) return false;
  if (pattern === '*/*' || pattern === mime) return true;
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -1);
    return mime.startsWith(prefix);
  }
  return false;
}

function matchesExtensionOrMime(
  item: ArtifactItem,
  extensions: string[],
  mimeTypes: string[],
): boolean {
  const ext = getLowerExtension(item);
  const mime = getLowerMime(item);
  const normExts = normalizeExtensions(extensions);
  const normMimes = normalizeMimeTypes(mimeTypes);

  if (ext && normExts.includes(ext)) {
    return true;
  }
  if (mime && normMimes.some((pattern) => matchesMimePattern(mime, pattern))) {
    return true;
  }
  return false;
}

function isSafeHttpUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isSafeIframeSrc(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    return true;
  }
  return isSafeHttpUrl(trimmed);
}

function renderInlineMarkdown(text: string, keyPrefix = 'inl'): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let remaining = text;
  let index = 0;

  while (remaining.length > 0) {
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch) {
      nodes.push(
        <code key={`${keyPrefix}-code-${index++}`} className={styles.mdInlineCode}>
          {codeMatch[1]}
        </code>,
      );
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)\s]+)\)/);
    if (linkMatch) {
      const [, label, href] = linkMatch;
      if (isSafeHttpUrl(href)) {
        nodes.push(
          <a
            key={`${keyPrefix}-link-${index++}`}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.mdLink}
          >
            {renderInlineMarkdown(label, `${keyPrefix}-lt-${index}`)}
          </a>,
        );
      } else {
        nodes.push(
          <span key={`${keyPrefix}-unsafe-${index++}`}>
            {renderInlineMarkdown(label, `${keyPrefix}-ut-${index}`)}
          </span>,
        );
      }
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    const boldMatch = remaining.match(/^(?:\*\*([^*]+)\*\*|__([^_]+)__)/);
    if (boldMatch) {
      const content = boldMatch[1] ?? boldMatch[2] ?? '';
      nodes.push(
        <strong key={`${keyPrefix}-b-${index++}`}>
          {renderInlineMarkdown(content, `${keyPrefix}-bt-${index}`)}
        </strong>,
      );
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    const italicStarMatch = remaining.match(/^\*([^*]+)\*/);
    if (italicStarMatch) {
      nodes.push(
        <em key={`${keyPrefix}-i-${index++}`}>
          {renderInlineMarkdown(italicStarMatch[1], `${keyPrefix}-it-${index}`)}
        </em>,
      );
      remaining = remaining.slice(italicStarMatch[0].length);
      continue;
    }

    const italicUnderscoreMatch = remaining.match(/^_([^_]+)_/);
    if (italicUnderscoreMatch) {
      nodes.push(
        <em key={`${keyPrefix}-iu-${index++}`}>
          {renderInlineMarkdown(italicUnderscoreMatch[1], `${keyPrefix}-iut-${index}`)}
        </em>,
      );
      remaining = remaining.slice(italicUnderscoreMatch[0].length);
      continue;
    }

    const nextSpecial = remaining.slice(1).search(/[`[*_]/);
    if (nextSpecial === -1) {
      nodes.push(remaining);
      break;
    }
    nodes.push(remaining.slice(0, nextSpecial + 1));
    remaining = remaining.slice(nextSpecial + 1);
  }

  return nodes;
}

type TableAlignment = 'left' | 'center' | 'right' | undefined;

function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);

  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === '\\' && trimmed[i + 1] === '|') {
      current += '|';
      i += 1;
    } else if (ch === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseTableSeparator(line: string): TableAlignment[] | null {
  if (!line.includes('|')) return null;
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const alignments: TableAlignment[] = [];
  for (const cell of cells) {
    if (!/^:?-{3,}:?$/.test(cell)) return null;
    if (cell.startsWith(':') && cell.endsWith(':')) {
      alignments.push('center');
    } else if (cell.endsWith(':')) {
      alignments.push('right');
    } else if (cell.startsWith(':')) {
      alignments.push('left');
    } else {
      alignments.push(undefined);
    }
  }
  return alignments;
}

function isBlockBoundary(line: string, nextLine?: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^#{1,6}\s+/.test(trimmed)) return true;
  if (/^(?:```|~~~)/.test(trimmed)) return true;
  if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) return true;
  if (/^\s*>\s?/.test(line)) return true;
  if (/^\s*[-*+]\s+/.test(line)) return true;
  if (/^\s*\d+\.\s+/.test(line)) return true;
  if (line.includes('|') && nextLine && parseTableSeparator(nextLine) !== null) return true;
  return false;
}

function renderMarkdownBlocks(markdown: string, depth = 0): React.ReactNode[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let blockKey = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    // Fenced code block
    const fenceMatch = trimmed.match(/^(```|~~~)\s*([^\s`~]*)/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const lang = fenceMatch[2] || '';
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push(
        <div key={`b-${blockKey++}`} className={styles.mdCodeBlock}>
          {lang && <div className={styles.mdCodeLang}>{lang}</div>}
          <pre className={styles.mdPre}>
            <code>{codeLines.join('\n')}</code>
          </pre>
        </div>,
      );
      continue;
    }

    // Heading
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = renderInlineMarkdown(headingMatch[2], `h-${blockKey}`);
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      blocks.push(
        <Tag key={`b-${blockKey++}`} className={`${styles.mdHeading} ${styles[`mdH${level}`]}`}>
          {content}
        </Tag>,
      );
      i += 1;
      continue;
    }

    // Horizontal rule
    if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) {
      blocks.push(<hr key={`b-${blockKey++}`} className={styles.mdHr} />);
      i += 1;
      continue;
    }

    // GFM Pipe Table
    if (line.includes('|') && i + 1 < lines.length) {
      const alignments = parseTableSeparator(lines[i + 1]);
      if (alignments) {
        const headers = splitTableRow(line);
        const rows: string[][] = [];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          rows.push(splitTableRow(lines[i]));
          i += 1;
        }
        const key = `b-${blockKey++}`;
        blocks.push(
          <div key={key} className={styles.mdTableWrap}>
            <table className={styles.mdTable}>
              <thead>
                <tr>
                  {headers.map((cell, colIdx) => (
                    <th
                      key={`${key}-th-${colIdx}`}
                      style={alignments[colIdx] ? { textAlign: alignments[colIdx] } : undefined}
                    >
                      {renderInlineMarkdown(cell, `${key}-th-${colIdx}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, rowIdx) => (
                  <tr key={`${key}-tr-${rowIdx}`}>
                    {headers.map((_, colIdx) => (
                      <td
                        key={`${key}-td-${rowIdx}-${colIdx}`}
                        style={alignments[colIdx] ? { textAlign: alignments[colIdx] } : undefined}
                      >
                        {renderInlineMarkdown(row[colIdx] ?? '', `${key}-td-${rowIdx}-${colIdx}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        );
        continue;
      }
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      const key = `b-${blockKey++}`;
      blocks.push(
        <blockquote key={key} className={styles.mdBlockquote}>
          {depth < 4
            ? renderMarkdownBlocks(quoteLines.join('\n'), depth + 1)
            : quoteLines.join('\n')}
        </blockquote>,
      );
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const listItems: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        listItems.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i += 1;
      }
      const key = `b-${blockKey++}`;
      blocks.push(
        <ul key={key} className={styles.mdList}>
          {listItems.map((itemText, idx) => (
            <li key={`${key}-li-${idx}`}>
              {renderInlineMarkdown(itemText, `${key}-li-${idx}`)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const listItems: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        listItems.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i += 1;
      }
      const key = `b-${blockKey++}`;
      blocks.push(
        <ol key={key} className={styles.mdList}>
          {listItems.map((itemText, idx) => (
            <li key={`${key}-oli-${idx}`}>
              {renderInlineMarkdown(itemText, `${key}-oli-${idx}`)}
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    // Paragraph
    const paraLines: string[] = [trimmed];
    i += 1;
    while (i < lines.length && !isBlockBoundary(lines[i], lines[i + 1])) {
      paraLines.push(lines[i].trim());
      i += 1;
    }
    const key = `b-${blockKey++}`;
    blocks.push(
      <p key={key} className={styles.mdParagraph}>
        {renderInlineMarkdown(paraLines.join(' '), key)}
      </p>,
    );
  }

  return blocks;
}

export function MarkdownArtifactView({
  content,
  testId = 'artifact-markdown-preview',
}: {
  content: string;
  testId?: string;
}) {
  return (
    <div className={styles.markdownBody} data-testid={testId}>
      {renderMarkdownBlocks(content)}
    </div>
  );
}

function ImageArtifactView({
  rawUrl,
  name,
  zoom,
  t,
}: {
  rawUrl: string;
  name: string;
  zoom: number;
  t: TranslateFn;
}) {
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    setNaturalSize(null);
  }, [rawUrl]);

  const isFit = zoom <= 0;
  const imgStyle: React.CSSProperties | undefined = isFit
    ? undefined
    : {
        transform: `scale(${zoom})`,
        transformOrigin: 'center center',
      };

  return (
    <div className={styles.imagePreviewWrap}>
      <div className={styles.imageStage}>
        <img
          src={rawUrl}
          alt={name}
          className={isFit ? styles.previewImgFit : styles.previewImgZoomed}
          style={imgStyle}
          data-zoom={isFit ? 'fit' : String(zoom)}
          data-testid="artifact-image-preview"
          onLoad={(ev) => {
            const img = ev.currentTarget;
            if (img.naturalWidth > 0 && img.naturalHeight > 0) {
              setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
            }
          }}
        />
      </div>
      <div className={styles.imageMetaBar}>
        <span>{isFit ? t('artifacts.zoomFit') : `${Math.round(zoom * 100)}%`}</span>
        {naturalSize && (
          <span data-testid="artifact-image-dimensions">
            {naturalSize.width} × {naturalSize.height}
          </span>
        )}
      </div>
    </div>
  );
}

function SvgArtifactView({
  rawUrl,
  name,
  zoom,
}: {
  rawUrl: string;
  name: string;
  zoom: number;
}) {
  const isFit = zoom <= 0;
  const imgStyle: React.CSSProperties | undefined = isFit
    ? undefined
    : {
        transform: `scale(${zoom})`,
        transformOrigin: 'center center',
      };

  return (
    <div className={styles.checkerboardStage}>
      <img
        src={rawUrl}
        alt={name}
        className={isFit ? styles.previewImgFit : styles.previewImgZoomed}
        style={imgStyle}
        data-zoom={isFit ? 'fit' : String(zoom)}
        data-testid="artifact-svg-preview"
      />
    </div>
  );
}

function formatTextArtifactContent(ctx: ArtifactPreviewContext): string {
  const content = ctx.textContent ?? '';
  const mime = getLowerMime(ctx.item);
  const ext = getLowerExtension(ctx.item);
  if ((mime === 'application/json' || ext === '.json') && !ctx.previewData?.truncated && content) {
    try {
      return JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      return content;
    }
  }
  return content;
}

function resolveIframeTemplate(
  template: string,
  ctx: ArtifactPreviewContext,
): string {
  const filePath = ctx.item.path || ctx.item.name;
  return template
    .replace(/\{sessionId\}/g, encodeURIComponent(ctx.sessionId))
    .replace(/\{file\}/g, encodeURIComponent(filePath))
    .replace(/\{path\}/g, encodeURIComponent(filePath))
    .replace(/\{name\}/g, encodeURIComponent(ctx.item.name))
    .replace(/\{mime\}/g, encodeURIComponent(ctx.item.mime || ''))
    .replace(/\{rawUrl\}/g, encodeURIComponent(ctx.rawUrl));
}

export const BUILTIN_MARKDOWN_PREVIEWER: ArtifactPreviewPlugin = {
  id: 'builtin.markdown',
  name: 'Markdown',
  priority: 50,
  extensions: ['.md', '.markdown'],
  mimeTypes: ['text/markdown', 'text/x-markdown'],
  requiresTextContent: true,
  supportsRawToggle: true,
  source: 'builtin',
  renderKind: 'markdown',
  canPreview: (item) => matchesExtensionOrMime(item, ['.md', '.markdown'], ['text/markdown', 'text/x-markdown']),
  render: (ctx) => {
    if (ctx.mode === 'raw') {
      return (
        <pre className={styles.previewContent} data-testid="artifact-raw-content">
          {ctx.textContent ?? ''}
        </pre>
      );
    }
    return <MarkdownArtifactView content={ctx.textContent ?? ''} />;
  },
};

export const BUILTIN_SVG_PREVIEWER: ArtifactPreviewPlugin = {
  id: 'builtin.svg',
  name: 'SVG',
  priority: 50,
  extensions: ['.svg'],
  mimeTypes: ['image/svg+xml'],
  requiresTextContent: false,
  supportsRawToggle: true,
  source: 'builtin',
  renderKind: 'svg',
  canPreview: (item) => matchesExtensionOrMime(item, ['.svg'], ['image/svg+xml']),
  render: (ctx) => {
    if (ctx.mode === 'raw') {
      return (
        <pre className={styles.previewContent} data-testid="artifact-raw-content">
          {ctx.textContent ?? ''}
        </pre>
      );
    }
    return <SvgArtifactView rawUrl={ctx.rawUrl} name={ctx.item.name} zoom={ctx.zoom} />;
  },
};

export const BUILTIN_IMAGE_PREVIEWER: ArtifactPreviewPlugin = {
  id: 'builtin.image',
  name: 'Image',
  priority: 50,
  extensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp'],
  mimeTypes: ['image/*'],
  requiresTextContent: false,
  supportsRawToggle: false,
  source: 'builtin',
  renderKind: 'image',
  canPreview: (item) => {
    const ext = getLowerExtension(item);
    const mime = getLowerMime(item);
    if (ext === '.svg' || mime === 'image/svg+xml') return false;
    return matchesExtensionOrMime(
      item,
      ['.jpg', '.jpeg', '.png', '.gif', '.webp'],
      ['image/*'],
    );
  },
  render: (ctx) => (
    <ImageArtifactView
      rawUrl={ctx.rawUrl}
      name={ctx.item.name}
      zoom={ctx.zoom}
      t={ctx.t}
    />
  ),
};

export const BUILTIN_HTML_PREVIEWER: ArtifactPreviewPlugin = {
  id: 'builtin.html',
  name: 'HTML',
  priority: 50,
  extensions: ['.html', '.htm'],
  mimeTypes: ['text/html', 'application/xhtml+xml'],
  requiresTextContent: true,
  supportsRawToggle: true,
  source: 'builtin',
  renderKind: 'html',
  canPreview: (item) =>
    matchesExtensionOrMime(item, ['.html', '.htm'], ['text/html', 'application/xhtml+xml']),
  render: (ctx) => {
    if (ctx.mode === 'raw') {
      return (
        <pre className={styles.previewContent} data-testid="artifact-raw-content">
          {ctx.textContent ?? ''}
        </pre>
      );
    }
    return (
      <div className={styles.frameContainer}>
        <div className={styles.noticeBar} data-testid="artifact-html-notice">
          {ctx.t('artifacts.sandboxedHtmlNotice')}
        </div>
        <iframe
          sandbox=""
          srcDoc={ctx.textContent ?? ''}
          title={ctx.item.name}
          className={styles.previewFrame}
          data-testid="artifact-html-frame"
        />
      </div>
    );
  },
};

export const BUILTIN_PDF_PREVIEWER: ArtifactPreviewPlugin = {
  id: 'builtin.pdf',
  name: 'PDF',
  priority: 50,
  extensions: ['.pdf'],
  mimeTypes: ['application/pdf'],
  requiresTextContent: false,
  supportsRawToggle: false,
  source: 'builtin',
  renderKind: 'pdf',
  canPreview: (item) => matchesExtensionOrMime(item, ['.pdf'], ['application/pdf']),
  render: (ctx) => (
    <div className={styles.frameContainer}>
      <iframe
        src={ctx.rawUrl}
        title={ctx.item.name}
        className={styles.previewFrame}
        data-testid="artifact-pdf-frame"
      />
      <div className={styles.pdfFooter}>
        <a
          href={ctx.rawUrl}
          target="_blank"
          rel="noreferrer"
          download={ctx.item.name}
          className={styles.actionLink}
          data-testid="artifact-pdf-download"
        >
          {ctx.t('artifacts.download')}
        </a>
      </div>
    </div>
  ),
};

export const BUILTIN_TEXT_PREVIEWER: ArtifactPreviewPlugin = {
  id: 'builtin.text',
  name: 'Text',
  priority: 20,
  extensions: TEXT_EXTENSIONS,
  mimeTypes: TEXT_MIME_TYPES,
  requiresTextContent: true,
  supportsRawToggle: false,
  source: 'builtin',
  canPreview: (item) => matchesExtensionOrMime(item, TEXT_EXTENSIONS, TEXT_MIME_TYPES),
  render: (ctx) => (
    <pre className={styles.previewContent} data-testid="artifact-preview-content">
      {formatTextArtifactContent(ctx)}
    </pre>
  ),
};

export const BUILTIN_UNSUPPORTED_PREVIEWER: ArtifactPreviewPlugin = {
  id: 'builtin.unsupported',
  name: 'Unsupported',
  priority: 0,
  extensions: [],
  mimeTypes: [],
  requiresTextContent: false,
  supportsRawToggle: false,
  source: 'builtin',
  canPreview: () => true,
  render: (ctx) => {
    const ext = getLowerExtension(ctx.item);
    const badgeLabel = ext ? ext.slice(1).toUpperCase() : (ctx.item.mime || 'FILE');
    return (
      <div className={styles.unsupportedCard} data-testid="artifact-unsupported-preview">
        <div className={styles.unsupportedBadge}>
          {badgeLabel} · {formatBytes(ctx.item.size)}
        </div>
        <div className={styles.unsupportedTitle}>{ctx.t('artifacts.unsupportedTitle')}</div>
        <div className={styles.unsupportedDesc}>{ctx.t('artifacts.unsupportedDesc')}</div>
        <a
          href={ctx.rawUrl}
          target="_blank"
          rel="noreferrer"
          download={ctx.item.name}
          className={styles.primaryActionLink}
          data-testid="artifact-unsupported-download"
        >
          {ctx.t('artifacts.download')}
        </a>
      </div>
    );
  },
};

export const BUILTIN_ARTIFACT_PREVIEWERS: ArtifactPreviewPlugin[] = [
  BUILTIN_MARKDOWN_PREVIEWER,
  BUILTIN_SVG_PREVIEWER,
  BUILTIN_IMAGE_PREVIEWER,
  BUILTIN_HTML_PREVIEWER,
  BUILTIN_PDF_PREVIEWER,
  BUILTIN_TEXT_PREVIEWER,
  BUILTIN_UNSUPPORTED_PREVIEWER,
];

const BUILTIN_BY_RENDER_KIND: Partial<
  Record<NonNullable<ArtifactPreviewerDescriptor['renderKind']>, ArtifactPreviewPlugin>
> = {
  markdown: BUILTIN_MARKDOWN_PREVIEWER,
  svg: BUILTIN_SVG_PREVIEWER,
  image: BUILTIN_IMAGE_PREVIEWER,
  html: BUILTIN_HTML_PREVIEWER,
  pdf: BUILTIN_PDF_PREVIEWER,
};

const runtimePlugins: ArtifactPreviewPlugin[] = [];

/**
 * Register or replace a runtime artifact preview plugin. Returns an unregister callback.
 */
export function registerArtifactPreviewer(plugin: ArtifactPreviewPlugin): () => void {
  const existingIdx = runtimePlugins.findIndex((p) => p.id === plugin.id);
  if (existingIdx >= 0) {
    runtimePlugins[existingIdx] = plugin;
  } else {
    runtimePlugins.push(plugin);
  }
  return () => {
    const idx = runtimePlugins.indexOf(plugin);
    if (idx >= 0) {
      runtimePlugins.splice(idx, 1);
    } else {
      const byIdIdx = runtimePlugins.findIndex((p) => p.id === plugin.id);
      if (byIdIdx >= 0) runtimePlugins.splice(byIdIdx, 1);
    }
  };
}

/**
 * Remove all runtime-registered previewers (primarily for deterministic test isolation).
 */
export function clearRuntimeArtifactPreviewers(): void {
  runtimePlugins.length = 0;
}

/**
 * Adapt a host-discovered ArtifactPreviewerDescriptor into a renderable ArtifactPreviewPlugin.
 */
export function adaptHostPluginPreviewer(
  desc: ArtifactPreviewerDescriptor,
): ArtifactPreviewPlugin {
  const extensions = normalizeExtensions(desc.extensions || []);
  const mimeTypes = normalizeMimeTypes(desc.mimeTypes || []);
  const renderKind =
    desc.renderKind ?? (desc.iframeUrlTemplate ? 'plugin_iframe' : 'plugin_html');
  const builtinDelegate = BUILTIN_BY_RENDER_KIND[renderKind];
  const isBuiltinKind = Boolean(builtinDelegate);

  return {
    id: desc.id,
    name: desc.name,
    priority: desc.source === 'builtin' ? 50 : 80,
    extensions,
    mimeTypes,
    requiresTextContent: isBuiltinKind ? builtinDelegate!.requiresTextContent : false,
    supportsRawToggle: isBuiltinKind ? builtinDelegate!.supportsRawToggle : false,
    source: desc.source || 'plugin',
    pluginId: desc.pluginId,
    renderKind,
    iframeUrlTemplate: desc.iframeUrlTemplate,
    canPreview: (item) => matchesExtensionOrMime(item, extensions, mimeTypes),
    render: (ctx) => {
      if (builtinDelegate) {
        return builtinDelegate.render(ctx);
      }

      const badge = (
        <div className={styles.noticeBar} data-testid="artifact-plugin-badge">
          {ctx.t('artifacts.pluginPreviewBadge')} · {desc.name}
        </div>
      );

      if (renderKind === 'plugin_iframe') {
        const candidateUrl =
          ctx.pluginPayload?.url ||
          (desc.iframeUrlTemplate ? resolveIframeTemplate(desc.iframeUrlTemplate, ctx) : '');
        const safeUrl = candidateUrl && isSafeIframeSrc(candidateUrl) ? candidateUrl : '';
        if (!safeUrl) {
          return (
            <div className={styles.frameContainer}>
              {badge}
              {BUILTIN_UNSUPPORTED_PREVIEWER.render(ctx)}
            </div>
          );
        }
        return (
          <div className={styles.frameContainer}>
            {badge}
            <iframe
              sandbox="allow-scripts allow-same-origin"
              src={safeUrl}
              title={ctx.item.name}
              className={styles.previewFrame}
              data-testid="artifact-plugin-iframe"
            />
          </div>
        );
      }

      if (renderKind === 'plugin_markdown') {
        const md = ctx.pluginPayload?.content ?? ctx.textContent ?? '';
        return (
          <div className={styles.frameContainer}>
            {badge}
            <MarkdownArtifactView content={md} testId="artifact-plugin-markdown-preview" />
          </div>
        );
      }

      // plugin_html (default safe sandboxed srcDoc)
      const html = ctx.pluginPayload?.content ?? ctx.textContent ?? '';
      return (
        <div className={styles.frameContainer}>
          {badge}
          <iframe
            sandbox=""
            srcDoc={html}
            title={ctx.item.name}
            className={styles.previewFrame}
            data-testid="artifact-plugin-html-frame"
          />
        </div>
      );
    },
  };
}

/**
 * Resolve the highest-priority previewer capable of rendering the given artifact item.
 */
export function resolveArtifactPreviewer(
  item: ArtifactItem,
  hostPluginDescriptors: ArtifactPreviewerDescriptor[] = [],
): ArtifactPreviewPlugin {
  const adaptedHostPlugins = hostPluginDescriptors.map(adaptHostPluginPreviewer);

  // Precedence order for equal priority or identical ID: runtime > host > builtin
  const candidatesById = new Map<string, { plugin: ArtifactPreviewPlugin; tier: number }>();
  const orderedGroups: Array<{ list: ArtifactPreviewPlugin[]; tier: number }> = [
    { list: runtimePlugins, tier: 3 },
    { list: adaptedHostPlugins, tier: 2 },
    { list: BUILTIN_ARTIFACT_PREVIEWERS, tier: 1 },
  ];

  for (const group of orderedGroups) {
    for (const plugin of group.list) {
      if (!candidatesById.has(plugin.id)) {
        candidatesById.set(plugin.id, { plugin, tier: group.tier });
      }
    }
  }

  const sorted = Array.from(candidatesById.values()).sort((a, b) => {
    if (b.plugin.priority !== a.plugin.priority) {
      return b.plugin.priority - a.plugin.priority;
    }
    return b.tier - a.tier;
  });

  for (const entry of sorted) {
    if (entry.plugin.canPreview(item)) {
      return entry.plugin;
    }
  }

  return BUILTIN_UNSUPPORTED_PREVIEWER;
}
