import React, { useState } from 'react';
import { useI18n } from '../i18n';
import styles from './MarkdownContent.module.css';

export interface MarkdownContentProps {
  text: string;
  compact?: boolean;
  highlightRegex?: RegExp | null;
  markClassName?: string;
  onInspectFile?: (filePath: string) => void;
}

function highlightLeafText(
  text: string,
  regex: RegExp | null | undefined,
  markClassName: string | undefined,
  keyPrefix: string,
): React.ReactNode {
  if (!regex || !text || !markClassName) return text;
  const re = new RegExp(regex.source, regex.flags);
  const nodes: React.ReactNode[] = [];
  let lastIdx = 0;
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    if (m.index > lastIdx) {
      nodes.push(text.slice(lastIdx, m.index));
    }
    nodes.push(
      <mark key={`${keyPrefix}-m-${count}`} className={markClassName}>
        {m[0]}
      </mark>,
    );
    lastIdx = m.index + m[0].length;
    count += 1;
    if (count >= 200) break;
  }
  if (count === 0) return text;
  if (lastIdx < text.length) {
    nodes.push(text.slice(lastIdx));
  }
  return nodes;
}

function parseFileLinkPath(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!/^file:\/\//i.test(trimmed)) return null;
  const withoutHash = trimmed.split('#')[0];
  let p = withoutHash.replace(/^file:\/\//i, '');
  if (/^localhost\//i.test(p)) {
    p = p.slice('localhost'.length);
  }
  try {
    p = decodeURIComponent(p);
  } catch {
    // Keep raw path when percent encoding is malformed
  }
  return p || null;
}

function isSafeExternalUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  return /^(?:https?:\/\/|mailto:)/i.test(trimmed);
}

interface InlineContext {
  highlightRegex?: RegExp | null;
  markClassName?: string;
  onInspectFile?: (filePath: string) => void;
  inspectFileTitle: string;
}

function renderInlineNodes(text: string, ctx: InlineContext, keyPrefix: string): React.ReactNode {
  if (!text) return null;

  // Replace inline code spans with PUA sentinel tokens first so formatting like
  // **`code`** or [`file.ts`](file:///...) parses cleanly while keeping code literal.
  const codeTokens: string[] = [];
  const tokenized = text.replace(/`([^`\n]+)`/g, (_full, code: string) => {
    const idx = codeTokens.push(code) - 1;
    return `\uE000C${idx}\uE001`;
  });

  const renderTextAndCode = (raw: string, leafKey: string): React.ReactNode => {
    if (!raw) return null;
    if (codeTokens.length === 0 || !raw.includes('\uE000C')) {
      return highlightLeafText(raw, ctx.highlightRegex, ctx.markClassName, leafKey);
    }
    const nodes: React.ReactNode[] = [];
    const tokenRe = /\uE000C(\d+)\uE001/g;
    let last = 0;
    let hit: RegExpExecArray | null;
    let pieceIdx = 0;
    while ((hit = tokenRe.exec(raw)) !== null) {
      if (hit.index > last) {
        nodes.push(
          <React.Fragment key={`${leafKey}-p-${pieceIdx++}`}>
            {highlightLeafText(raw.slice(last, hit.index), ctx.highlightRegex, ctx.markClassName, `${leafKey}-p-${pieceIdx}`)}
          </React.Fragment>,
        );
      }
      const tokenIdx = Number(hit[1]);
      const code = codeTokens[tokenIdx];
      if (code !== undefined) {
        nodes.push(
          <code key={`${leafKey}-c-${pieceIdx++}`} className={styles.inlineCode}>
            {highlightLeafText(code, ctx.highlightRegex, ctx.markClassName, `${leafKey}-c-${pieceIdx}`)}
          </code>,
        );
      } else {
        nodes.push(hit[0]);
      }
      last = hit.index + hit[0].length;
    }
    if (last < raw.length) {
      nodes.push(
        <React.Fragment key={`${leafKey}-pt-${pieceIdx++}`}>
          {highlightLeafText(raw.slice(last), ctx.highlightRegex, ctx.markClassName, `${leafKey}-pt`)}
        </React.Fragment>,
      );
    }
    return nodes.length === 1 ? nodes[0] : nodes;
  };

  const parts: React.ReactNode[] = [];
  // Match markdown links, bold, strikethrough, italic
  const inlineRe = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|~~([^~\n]+)~~|\*([^*\n]+)\*/g;
  let pos = 0;
  let tokenIdx = 0;
  let m: RegExpExecArray | null;

  while ((m = inlineRe.exec(tokenized)) !== null) {
    if (m.index > pos) {
      const plain = tokenized.slice(pos, m.index);
      parts.push(
        <React.Fragment key={`${keyPrefix}-t-${tokenIdx++}`}>
          {renderTextAndCode(plain, `${keyPrefix}-t-${tokenIdx}`)}
        </React.Fragment>,
      );
    }

    if (m[1] !== undefined && m[2] !== undefined) {
      const linkLabel = m[1];
      const href = m[2];
      const filePath = parseFileLinkPath(href);
      if (filePath && ctx.onInspectFile) {
        parts.push(
          <button
            key={`${keyPrefix}-fl-${tokenIdx++}`}
            type="button"
            className={styles.fileLinkBtn}
            title={`${ctx.inspectFileTitle}: ${filePath}`}
            onClick={() => ctx.onInspectFile?.(filePath)}
          >
            {renderTextAndCode(linkLabel, `${keyPrefix}-fl-${tokenIdx}`)}
          </button>,
        );
      } else if (isSafeExternalUrl(href)) {
        parts.push(
          <a
            key={`${keyPrefix}-a-${tokenIdx++}`}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.link}
          >
            {renderTextAndCode(linkLabel, `${keyPrefix}-a-${tokenIdx}`)}
          </a>,
        );
      } else {
        parts.push(
          <span key={`${keyPrefix}-lt-${tokenIdx++}`}>
            {renderTextAndCode(linkLabel, `${keyPrefix}-lt-${tokenIdx}`)}
          </span>,
        );
      }
    } else if (m[3] !== undefined) {
      parts.push(
        <strong key={`${keyPrefix}-b-${tokenIdx++}`}>
          {renderTextAndCode(m[3], `${keyPrefix}-b-${tokenIdx}`)}
        </strong>,
      );
    } else if (m[4] !== undefined) {
      parts.push(
        <del key={`${keyPrefix}-d-${tokenIdx++}`} className={styles.del}>
          {renderTextAndCode(m[4], `${keyPrefix}-d-${tokenIdx}`)}
        </del>,
      );
    } else if (m[5] !== undefined) {
      parts.push(
        <em key={`${keyPrefix}-i-${tokenIdx++}`}>
          {renderTextAndCode(m[5], `${keyPrefix}-i-${tokenIdx}`)}
        </em>,
      );
    }

    pos = m.index + m[0].length;
  }

  if (pos < tokenized.length) {
    parts.push(
      <React.Fragment key={`${keyPrefix}-tail-${tokenIdx++}`}>
        {renderTextAndCode(tokenized.slice(pos), `${keyPrefix}-tail`)}
      </React.Fragment>,
    );
  }

  return parts.length === 1 ? parts[0] : parts;
}

function splitTableCells(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((cell) => cell.trim());
}

function isTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|') || !trimmed.includes('-')) return false;
  const cells = splitTableCells(trimmed);
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

function CodeFenceBlock({
  lang,
  code,
  highlightRegex,
  markClassName,
}: {
  lang: string;
  code: string;
  highlightRegex?: RegExp | null;
  markClassName?: string;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Ignore clipboard failures in restricted browser contexts
    }
  };

  return (
    <div className={styles.codeWrap}>
      <div className={styles.codeHeader}>
        <span className={styles.codeLang}>{lang || 'text'}</span>
        <button type="button" className={styles.copyBtn} onClick={() => void handleCopy()}>
          {copied ? t('markdown.copied') : t('markdown.copy')}
        </button>
      </div>
      <pre className={styles.codePre}>
        <code>{highlightLeafText(code, highlightRegex, markClassName, 'fence')}</code>
      </pre>
    </div>
  );
}

export const MarkdownContent = React.memo(function MarkdownContent({
  text,
  compact = false,
  highlightRegex,
  markClassName,
  onInspectFile,
}: MarkdownContentProps) {
  const { t } = useI18n();
  const src = String(text ?? '').replace(/\r\n/g, '\n');
  if (!src.trim()) return null;

  const ctx: InlineContext = {
    highlightRegex,
    markClassName,
    onInspectFile,
    inspectFileTitle: t('markdown.inspectFile'),
  };

  const lines = src.split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line separator
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // Fenced code block
    const fenceOpen = line.match(/^\s*```([a-zA-Z0-9_-]*)\s*$/);
    if (fenceOpen) {
      const lang = fenceOpen[1] || '';
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // consume closing ```
      blocks.push(
        <CodeFenceBlock
          key={`code-${blocks.length}`}
          lang={lang}
          code={codeLines.join('\n')}
          highlightRegex={highlightRegex}
          markClassName={markClassName}
        />,
      );
      continue;
    }

    // Horizontal rule
    if (/^\s*(?:---+|===+|\*\*\*+)\s*$/.test(line)) {
      blocks.push(<hr key={`hr-${blocks.length}`} className={styles.hr} />);
      i += 1;
      continue;
    }

    // Headings (# to ######)
    const headingMatch = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = renderInlineNodes(headingMatch[2], ctx, `h-${blocks.length}`);
      if (level === 1) blocks.push(<h1 key={`h-${blocks.length}`} className={styles.h1}>{content}</h1>);
      else if (level === 2) blocks.push(<h2 key={`h-${blocks.length}`} className={styles.h2}>{content}</h2>);
      else if (level === 3) blocks.push(<h3 key={`h-${blocks.length}`} className={styles.h3}>{content}</h3>);
      else blocks.push(<h4 key={`h-${blocks.length}`} className={styles.h4}>{content}</h4>);
      i += 1;
      continue;
    }

    // GFM Table (header + |---|---| + body rows)
    if (line.includes('|') && i + 1 < lines.length && isTableSeparatorLine(lines[i + 1])) {
      const headers = splitTableCells(line);
      i += 2; // skip header & separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitTableCells(lines[i]));
        i += 1;
      }
      const key = `tbl-${blocks.length}`;
      blocks.push(
        <div key={key} className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr className={styles.tr}>
                {headers.map((h, colIdx) => (
                  <th key={colIdx} className={styles.th}>
                    {renderInlineNodes(h, ctx, `${key}-h-${colIdx}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIdx) => (
                <tr key={rowIdx} className={styles.tr}>
                  {headers.map((_, colIdx) => (
                    <td key={colIdx} className={styles.td}>
                      {renderInlineNodes(row[colIdx] || '', ctx, `${key}-r${rowIdx}-c${colIdx}`)}
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

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      const qKey = `q-${blocks.length}`;
      blocks.push(
        <blockquote key={qKey} className={styles.blockquote}>
          {renderInlineNodes(quoteLines.join('\n'), ctx, qKey)}
        </blockquote>,
      );
      continue;
    }

    // Unordered / Task list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: Array<{ text: string; taskChecked: boolean | null }> = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const rawItem = lines[i].replace(/^\s*[-*+]\s+/, '');
        const taskMatch = rawItem.match(/^\[( |x|X)\]\s+(.*)$/);
        if (taskMatch) {
          items.push({
            taskChecked: taskMatch[1].toLowerCase() === 'x',
            text: taskMatch[2],
          });
        } else {
          items.push({ taskChecked: null, text: rawItem });
        }
        i += 1;
      }
      const isTaskList = items.some((it) => it.taskChecked !== null);
      const listKey = `ul-${blocks.length}`;
      blocks.push(
        <ul key={listKey} className={`${styles.ul} ${isTaskList ? styles.taskList : ''}`}>
          {items.map((it, idx) => (
            <li key={idx} className={`${styles.li} ${it.taskChecked !== null ? styles.taskItem : ''}`}>
              {it.taskChecked !== null && (
                <span
                  className={`${styles.taskBox} ${it.taskChecked ? styles.taskBoxChecked : ''}`}
                  aria-hidden="true"
                >
                  {it.taskChecked ? '✓' : ''}
                </span>
              )}
              <span>{renderInlineNodes(it.text, ctx, `${listKey}-${idx}`)}</span>
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    // Ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
        i += 1;
      }
      const listKey = `ol-${blocks.length}`;
      blocks.push(
        <ol key={listKey} className={styles.ol}>
          {items.map((it, idx) => (
            <li key={idx} className={styles.li}>
              {renderInlineNodes(it, ctx, `${listKey}-${idx}`)}
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    // Paragraph (consume contiguous plain text lines until blank or block boundary)
    const paraLines: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*```/.test(lines[i]) &&
      !/^\s*#{1,6}\s+/.test(lines[i]) &&
      !/^\s*(?:---+|===+|\*\*\*+)\s*$/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSeparatorLine(lines[i + 1]))
    ) {
      paraLines.push(lines[i]);
      i += 1;
    }
    const pKey = `p-${blocks.length}`;
    blocks.push(
      <p key={pKey} className={styles.p}>
        {renderInlineNodes(paraLines.join('\n'), ctx, pKey)}
      </p>,
    );
  }

  return (
    <div className={`${styles.md} ${compact ? styles.mdCompact : ''}`}>
      {blocks}
    </div>
  );
});
