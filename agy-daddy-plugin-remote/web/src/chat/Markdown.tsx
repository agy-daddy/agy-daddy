import type { ComponentChildren } from 'preact';
import { memo } from 'preact/compat';
import { useState } from 'preact/hooks';
import styles from './Markdown.module.css';

interface CodeBlockProps {
  lang: string;
  code: string;
  unclosed?: boolean;
  streaming?: boolean;
}

function CodeBlock({ lang, code, unclosed, streaming }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const onCopy = () => {
    navigator.clipboard
      ?.writeText(code)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => {});
  };

  return (
    <div className={styles.codeWrap} data-hscroll="1">
      <div className={styles.codeHead}>
        <span className={styles.codeLang}>
          {lang || 'code'}
          {streaming && unclosed && <span className={styles.codeLive}>生成中</span>}
        </span>
        <button type="button" className={styles.copyBtn} onClick={onCopy}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className={styles.pre} data-hscroll="1">
        <code>
          {code}
          {streaming && unclosed && <span className={styles.streamCursor} aria-hidden="true" />}
        </code>
      </pre>
    </div>
  );
}

function isSafeHref(raw: string): boolean {
  try {
    const u = new URL(raw, 'https://example.invalid');
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function buildHighlightMatcher(
  query?: string,
  useRegex?: boolean,
  caseSensitive?: boolean
): RegExp | null {
  const raw = (query || '').trim();
  if (!raw) return null;
  const flags = caseSensitive ? 'g' : 'gi';
  try {
    const pattern = useRegex ? raw : raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

function renderHighlightedChunk(
  text: string,
  matcher: RegExp | null,
  isCurrentMatch: boolean,
  keyBase: string
): ComponentChildren {
  if (!matcher || !text) return text;
  const re = new RegExp(matcher.source, matcher.flags);
  const parts: ComponentChildren[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    if (m.index > lastIdx) {
      parts.push(text.slice(lastIdx, m.index));
    }
    parts.push(
      <mark
        key={`${keyBase}-m-${idx++}`}
        className="ag-search-mark"
        data-current={isCurrentMatch ? '1' : undefined}
      >
        {m[0]}
      </mark>
    );
    lastIdx = m.index + m[0].length;
    if (parts.length > 200) break;
  }
  if (parts.length === 0) return text;
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts;
}

function renderInline(
  text: string,
  matcher: RegExp | null = null,
  isCurrentMatch = false
): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  const tokenRe = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|~~[^~\n]+~~|\[[^\]\n]+\]\(([^)\s]+)\))/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  let k = 0;

  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > lastIdx) {
      out.push(renderHighlightedChunk(text.slice(lastIdx, match.index), matcher, isCurrentMatch, `p-${k}`));
    }
    const tok = match[0];
    if (tok.startsWith('`')) {
      out.push(
        <code key={k++} className={styles.inlineCode}>
          {renderHighlightedChunk(tok.slice(1, -1), matcher, isCurrentMatch, `c-${k}`)}
        </code>
      );
    } else if (tok.startsWith('**')) {
      out.push(
        <strong key={k++}>
          {renderHighlightedChunk(tok.slice(2, -2), matcher, isCurrentMatch, `b-${k}`)}
        </strong>
      );
    } else if (tok.startsWith('~~')) {
      out.push(
        <del key={k++}>
          {renderHighlightedChunk(tok.slice(2, -2), matcher, isCurrentMatch, `d-${k}`)}
        </del>
      );
    } else if (tok.startsWith('*')) {
      out.push(
        <em key={k++}>
          {renderHighlightedChunk(tok.slice(1, -1), matcher, isCurrentMatch, `i-${k}`)}
        </em>
      );
    } else if (tok.startsWith('[')) {
      const closeBracket = tok.indexOf('](');
      const label = tok.slice(1, closeBracket);
      const href = match[2] || '';
      if (isSafeHref(href)) {
        out.push(
          <a key={k++} href={href} target="_blank" rel="noreferrer noopener">
            {renderHighlightedChunk(label, matcher, isCurrentMatch, `a-${k}`)}
          </a>
        );
      } else {
        out.push(renderHighlightedChunk(tok, matcher, isCurrentMatch, `u-${k++}`));
      }
    }
    lastIdx = match.index + tok.length;
  }

  if (lastIdx < text.length) {
    out.push(renderHighlightedChunk(text.slice(lastIdx), matcher, isCurrentMatch, `e-${k}`));
  }
  return out;
}

type Block =
  | { kind: 'code'; lang: string; code: string; unclosed: boolean }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'hr' }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; headers: string[]; rows: string[][] }
  | { kind: 'para'; text: string };

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code block (auto-closes partial/unclosed fence safely while streaming)
    const fenceMatch = line.match(/^\s*(`{3,})([\w.+-]*).*$/);
    if (fenceMatch) {
      const fenceTicks = fenceMatch[1];
      const lang = fenceMatch[2] || '';
      const codeLines: string[] = [];
      let closed = false;
      i++;
      while (i < lines.length) {
        if (lines[i].trimStart().startsWith(fenceTicks)) {
          closed = true;
          i++;
          break;
        }
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({ kind: 'code', lang, code: codeLines.join('\n'), unclosed: !closed });
      continue;
    }

    // Horizontal rule
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ kind: 'hr' });
      i++;
      continue;
    }

    // Headings
    const hMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (hMatch) {
      blocks.push({ kind: 'heading', level: Math.min(3, hMatch[1].length), text: hMatch[2] });
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith('>')) {
      const qLines: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        qLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ kind: 'quote', lines: qLines });
      continue;
    }

    // Pipe table
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])
    ) {
      const splitRow = (r: string) =>
        r
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim());
      const headers = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ kind: 'table', headers, rows });
      continue;
    }

    // Lists
    const ulMatch = line.match(/^\s*[-*]\s+(.+)$/);
    const olMatch = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ulMatch || olMatch) {
      const ordered = Boolean(olMatch);
      const items: string[] = [];
      while (i < lines.length) {
        const m = ordered
          ? lines[i].match(/^\s*\d+\.\s+(.+)$/)
          : lines[i].match(/^\s*[-*]\s+(.+)$/);
        if (!m) break;
        items.push(m[1]);
        i++;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    // Paragraph
    const pLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*`{3,}/.test(lines[i]) &&
      !lines[i].startsWith('>') &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !/^\s*([-*]|\d+\.)\s+/.test(lines[i]) &&
      !/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) {
      pLines.push(lines[i]);
      i++;
    }
    blocks.push({ kind: 'para', text: pLines.join('\n') });
  }

  return blocks;
}

export interface MarkdownProps {
  text: string;
  streaming?: boolean;
  highlightQuery?: string;
  highlightRegex?: boolean;
  highlightCaseSensitive?: boolean;
  isCurrentMatch?: boolean;
}

export const Markdown = memo(function Markdown({
  text,
  streaming = false,
  highlightQuery,
  highlightRegex = false,
  highlightCaseSensitive = false,
  isCurrentMatch = false
}: MarkdownProps) {
  if (!text) return null;
  const blocks = parseBlocks(text);
  const matcher = buildHighlightMatcher(highlightQuery, highlightRegex, highlightCaseSensitive);
  const lastIdx = blocks.length - 1;

  return (
    <div className={styles.md}>
      {blocks.map((b, idx) => {
        const isLast = idx === lastIdx;
        const showInlineCursor = streaming && isLast;
        switch (b.kind) {
          case 'code':
            return (
              <CodeBlock
                key={idx}
                lang={b.lang}
                code={b.code}
                unclosed={b.unclosed}
                streaming={streaming && isLast}
              />
            );
          case 'hr':
            return <hr key={idx} className={styles.hr} />;
          case 'heading': {
            const content = (
              <>
                {renderInline(b.text, matcher, isCurrentMatch)}
                {showInlineCursor && <span className={styles.streamCursor} aria-hidden="true" />}
              </>
            );
            if (b.level === 1) return <h1 key={idx}>{content}</h1>;
            if (b.level === 2) return <h2 key={idx}>{content}</h2>;
            return <h3 key={idx}>{content}</h3>;
          }
          case 'quote':
            return (
              <blockquote key={idx}>
                {b.lines.map((l, j) => (
                  <div key={j}>
                    {renderInline(l, matcher, isCurrentMatch)}
                    {showInlineCursor && j === b.lines.length - 1 && (
                      <span className={styles.streamCursor} aria-hidden="true" />
                    )}
                  </div>
                ))}
              </blockquote>
            );
          case 'list': {
            const Tag = b.ordered ? 'ol' : 'ul';
            return (
              <Tag key={idx}>
                {b.items.map((item, j) => (
                  <li key={j}>
                    {renderInline(item, matcher, isCurrentMatch)}
                    {showInlineCursor && j === b.items.length - 1 && (
                      <span className={styles.streamCursor} aria-hidden="true" />
                    )}
                  </li>
                ))}
              </Tag>
            );
          }
          case 'table':
            return (
              <div key={idx} className={styles.tableWrap} data-hscroll="1">
                <table className={styles.table}>
                  <thead>
                    <tr>
                      {b.headers.map((h, j) => (
                        <th key={j}>{renderInline(h, matcher, isCurrentMatch)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, rIdx) => (
                      <tr key={rIdx}>
                        {row.map((cell, cIdx) => (
                          <td key={cIdx}>{renderInline(cell, matcher, isCurrentMatch)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'para':
            return (
              <p key={idx}>
                {renderInline(b.text, matcher, isCurrentMatch)}
                {showInlineCursor && <span className={styles.streamCursor} aria-hidden="true" />}
              </p>
            );
        }
      })}
    </div>
  );
});
