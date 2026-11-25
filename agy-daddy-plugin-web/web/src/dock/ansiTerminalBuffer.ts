export interface TerminalCellStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface TerminalSpan {
  text: string;
  style?: TerminalCellStyle;
}

export interface TerminalLine {
  spans: TerminalSpan[];
}

export interface TerminalSnapshot {
  lines: TerminalLine[];
  cursorRow: number;
  cursorCol: number;
  cols: number;
  rows: number;
  isAltScreen: boolean;
}

interface Cell {
  ch: string;
  style?: TerminalCellStyle;
}

const MAX_SCROLLBACK_DEFAULT = 2000;

// Safe neutral / semantic ANSI palette (no forbidden theme accent hexes)
const ANSI_16_PALETTE: string[] = [
  '#1f2328', // 0 black
  '#dc2626', // 1 red
  '#16a34a', // 2 green
  '#ca8a04', // 3 yellow
  '#2563eb', // 4 blue
  '#9333ea', // 5 magenta
  '#0891b2', // 6 cyan
  '#d4d4d8', // 7 white
  '#71717a', // 8 bright black
  '#f87171', // 9 bright red
  '#4ade80', // 10 bright green
  '#facc15', // 11 bright yellow
  '#60a5fa', // 12 bright blue
  '#c084fc', // 13 bright magenta
  '#22d3ee', // 14 bright cyan
  '#fafafa', // 15 bright white
];

function color256(idx: number): string | undefined {
  if (!Number.isFinite(idx) || idx < 0 || idx > 255) return undefined;
  if (idx < 16) return ANSI_16_PALETTE[idx];
  if (idx >= 232) {
    const gray = 8 + (idx - 232) * 10;
    return `rgb(${gray}, ${gray}, ${gray})`;
  }
  const n = idx - 16;
  const rIdx = Math.floor(n / 36);
  const gIdx = Math.floor((n % 36) / 6);
  const bIdx = n % 6;
  const step = [0, 95, 135, 175, 215, 255];
  return `rgb(${step[rIdx]}, ${step[gIdx]}, ${step[bIdx]})`;
}

function sameStyle(a?: TerminalCellStyle, b?: TerminalCellStyle): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    Boolean(a.bold) === Boolean(b.bold) &&
    Boolean(a.dim) === Boolean(b.dim)
    && Boolean(a.italic) === Boolean(b.italic)
    && Boolean(a.underline) === Boolean(b.underline)
  );
}

function hasAnyStyle(style: TerminalCellStyle): boolean {
  return Boolean(
    style.fg || style.bg || style.bold || style.dim || style.italic || style.underline,
  );
}

function cloneStyle(style?: TerminalCellStyle): TerminalCellStyle | undefined {
  if (!style || !hasAnyStyle(style)) return undefined;
  return { ...style };
}

function makeBlankRow(): Cell[] {
  return [];
}

function rowToLine(row: Cell[]): TerminalLine {
  // Trim trailing unstyled spaces
  let end = row.length;
  while (end > 0) {
    const cell = row[end - 1];
    if (cell && (cell.ch !== ' ' || cell.style?.bg || cell.style?.underline)) break;
    end -= 1;
  }
  if (end === 0) return { spans: [{ text: '' }] };

  const spans: TerminalSpan[] = [];
  let buf = '';
  let currentStyle: TerminalCellStyle | undefined;
  let initialized = false;

  for (let i = 0; i < end; i += 1) {
    const cell = row[i] ?? { ch: ' ' };
    if (!initialized) {
      buf = cell.ch;
      currentStyle = cell.style;
      initialized = true;
    } else if (sameStyle(currentStyle, cell.style)) {
      buf += cell.ch;
    } else {
      spans.push(currentStyle ? { text: buf, style: { ...currentStyle } } : { text: buf });
      buf = cell.ch;
      currentStyle = cell.style;
    }
  }
  if (buf.length > 0) {
    spans.push(currentStyle ? { text: buf, style: { ...currentStyle } } : { text: buf });
  }
  return { spans };
}

export class AnsiTerminalBuffer {
  private cols: number;
  private rows: number;
  private maxScrollback: number;
  private scrollback: Cell[][] = [];
  private screen: Cell[][] = [];
  private altScreen: Cell[][] = [];
  private isAltScreen = false;
  private cursorRow = 0;
  private cursorCol = 0;
  private savedCursor: { row: number; col: number } | null = null;
  private currentStyle: TerminalCellStyle = {};
  private pendingEscape = '';

  constructor(cols = 80, rows = 24, maxScrollback = MAX_SCROLLBACK_DEFAULT) {
    this.cols = Math.max(10, Math.floor(cols));
    this.rows = Math.max(4, Math.floor(rows));
    this.maxScrollback = Math.max(100, Math.floor(maxScrollback));
    this.screen = Array.from({ length: this.rows }, makeBlankRow);
    this.altScreen = Array.from({ length: this.rows }, makeBlankRow);
  }

  private get activeRows(): Cell[][] {
    return this.isAltScreen ? this.altScreen : this.screen;
  }

  resize(cols: number, rows: number): void {
    const nextCols = Math.max(10, Math.floor(cols));
    const nextRows = Math.max(4, Math.floor(rows));
    this.cols = nextCols;
    this.rows = nextRows;

    const adjustBuffer = (buf: Cell[][]): Cell[][] => {
      const next = buf.slice(Math.max(0, buf.length - nextRows));
      while (next.length < nextRows) next.push(makeBlankRow());
      return next;
    };
    this.screen = adjustBuffer(this.screen);
    this.altScreen = adjustBuffer(this.altScreen);
    this.cursorRow = Math.max(0, Math.min(this.rows - 1, this.cursorRow));
    this.cursorCol = Math.max(0, Math.min(this.cols - 1, this.cursorCol));
  }

  clear(): void {
    this.scrollback = [];
    if (this.isAltScreen) {
      this.altScreen = Array.from({ length: this.rows }, makeBlankRow);
    } else {
      this.screen = Array.from({ length: this.rows }, makeBlankRow);
    }
    this.cursorRow = 0;
    this.cursorCol = 0;
  }

  private scrollUp(count = 1): void {
    const buf = this.activeRows;
    for (let i = 0; i < count; i += 1) {
      const shifted = buf.shift() ?? makeBlankRow();
      if (!this.isAltScreen) {
        this.scrollback.push(shifted);
        if (this.scrollback.length > this.maxScrollback) {
          this.scrollback.splice(0, this.scrollback.length - this.maxScrollback);
        }
      }
      buf.push(makeBlankRow());
    }
  }

  private lineFeed(): void {
    if (this.cursorRow >= this.rows - 1) {
      this.scrollUp(1);
    } else {
      this.cursorRow += 1;
    }
  }

  private putChar(ch: string): void {
    if (this.cursorCol >= this.cols) {
      this.cursorCol = 0;
      this.lineFeed();
    }
    const row = this.activeRows[this.cursorRow];
    while (row.length < this.cursorCol) {
      row.push({ ch: ' ' });
    }
    const styled = cloneStyle(this.currentStyle);
    row[this.cursorCol] = styled ? { ch, style: styled } : { ch };
    this.cursorCol += 1;
  }

  private applySgr(params: number[]): void {
    const codes = params.length === 0 ? [0] : params;
    for (let i = 0; i < codes.length; i += 1) {
      const code = codes[i];
      if (code === 0) {
        this.currentStyle = {};
      } else if (code === 1) {
        this.currentStyle.bold = true;
      } else if (code === 2) {
        this.currentStyle.dim = true;
      } else if (code === 3) {
        this.currentStyle.italic = true;
      } else if (code === 4) {
        this.currentStyle.underline = true;
      } else if (code === 22) {
        delete this.currentStyle.bold;
        delete this.currentStyle.dim;
      } else if (code === 23) {
        delete this.currentStyle.italic;
      } else if (code === 24) {
        delete this.currentStyle.underline;
      } else if (code >= 30 && code <= 37) {
        this.currentStyle.fg = ANSI_16_PALETTE[code - 30];
      } else if (code === 39) {
        delete this.currentStyle.fg;
      } else if (code >= 90 && code <= 97) {
        this.currentStyle.fg = ANSI_16_PALETTE[code - 90 + 8];
      } else if (code >= 40 && code <= 47) {
        this.currentStyle.bg = ANSI_16_PALETTE[code - 40];
      } else if (code === 49) {
        delete this.currentStyle.bg;
      } else if (code >= 100 && code <= 107) {
        this.currentStyle.bg = ANSI_16_PALETTE[code - 100 + 8];
      } else if (code === 38 || code === 48) {
        const isFg = code === 38;
        const mode = codes[i + 1];
        if (mode === 5 && i + 2 < codes.length) {
          const color = color256(codes[i + 2]);
          if (color) {
            if (isFg) this.currentStyle.fg = color;
            else this.currentStyle.bg = color;
          }
          i += 2;
        } else if (mode === 2 && i + 4 < codes.length) {
          const r = Math.max(0, Math.min(255, codes[i + 2]));
          const g = Math.max(0, Math.min(255, codes[i + 3]));
          const b = Math.max(0, Math.min(255, codes[i + 4]));
          const color = `rgb(${r}, ${g}, ${b})`;
          if (isFg) this.currentStyle.fg = color;
          else this.currentStyle.bg = color;
          i += 4;
        }
      }
    }
  }

  private applyCsi(seq: string): void {
    const finalChar = seq[seq.length - 1];
    const body = seq.slice(0, -1);
    const isPrivate = body.startsWith('?');
    const cleanBody = isPrivate ? body.slice(1) : body;
    const rawParams = cleanBody === '' ? [] : cleanBody.split(';').map((s) => (s === '' ? 0 : Number(s) || 0));

    if (isPrivate) {
      if (finalChar === 'h' && rawParams.includes(1049)) {
        this.isAltScreen = true;
        this.altScreen = Array.from({ length: this.rows }, makeBlankRow);
        this.cursorRow = 0;
        this.cursorCol = 0;
      } else if (finalChar === 'l' && rawParams.includes(1049)) {
        this.isAltScreen = false;
        this.cursorRow = Math.max(0, Math.min(this.rows - 1, this.cursorRow));
        this.cursorCol = Math.max(0, Math.min(this.cols - 1, this.cursorCol));
      }
      return;
    }

    const p1 = rawParams[0] || 1;
    const p2 = rawParams[1] || 1;
    const buf = this.activeRows;

    switch (finalChar) {
      case 'm':
        this.applySgr(rawParams);
        break;
      case 'A':
        this.cursorRow = Math.max(0, this.cursorRow - p1);
        break;
      case 'B':
        this.cursorRow = Math.min(this.rows - 1, this.cursorRow + p1);
        break;
      case 'C':
        this.cursorCol = Math.min(this.cols - 1, this.cursorCol + p1);
        break;
      case 'D':
        this.cursorCol = Math.max(0, this.cursorCol - p1);
        break;
      case 'G':
        this.cursorCol = Math.max(0, Math.min(this.cols - 1, p1 - 1));
        break;
      case 'd':
        this.cursorRow = Math.max(0, Math.min(this.rows - 1, p1 - 1));
        break;
      case 'H':
      case 'f':
        this.cursorRow = Math.max(0, Math.min(this.rows - 1, p1 - 1));
        this.cursorCol = Math.max(0, Math.min(this.cols - 1, p2 - 1));
        break;
      case 'J': {
        const mode = rawParams[0] ?? 0;
        if (mode === 2 || mode === 3) {
          for (let r = 0; r < this.rows; r += 1) buf[r] = makeBlankRow();
          if (mode === 3 && !this.isAltScreen) this.scrollback = [];
        } else if (mode === 0) {
          buf[this.cursorRow] = buf[this.cursorRow].slice(0, this.cursorCol);
          for (let r = this.cursorRow + 1; r < this.rows; r += 1) buf[r] = makeBlankRow();
        } else if (mode === 1) {
          for (let r = 0; r < this.cursorRow; r += 1) buf[r] = makeBlankRow();
          const cur = buf[this.cursorRow];
          for (let c = 0; c <= this.cursorCol && c < cur.length; c += 1) cur[c] = { ch: ' ' };
        }
        break;
      }
      case 'K': {
        const mode = rawParams[0] ?? 0;
        const row = buf[this.cursorRow];
        if (mode === 0) {
          buf[this.cursorRow] = row.slice(0, this.cursorCol);
        } else if (mode === 1) {
          for (let c = 0; c <= this.cursorCol && c < row.length; c += 1) row[c] = { ch: ' ' };
        } else if (mode === 2) {
          buf[this.cursorRow] = makeBlankRow();
        }
        break;
      }
      case 'P': {
        const row = buf[this.cursorRow];
        row.splice(this.cursorCol, p1);
        break;
      }
      case 's':
        this.savedCursor = { row: this.cursorRow, col: this.cursorCol };
        break;
      case 'u':
        if (this.savedCursor) {
          this.cursorRow = Math.max(0, Math.min(this.rows - 1, this.savedCursor.row));
          this.cursorCol = Math.max(0, Math.min(this.cols - 1, this.savedCursor.col));
        }
        break;
      default:
        break;
    }
  }

  write(chunk: string): void {
    if (!chunk) return;
    const input = this.pendingEscape + chunk;
    this.pendingEscape = '';

    let i = 0;
    while (i < input.length) {
      const ch = input[i];
      if (ch === '\x1b') {
        if (i + 1 >= input.length) {
          this.pendingEscape = input.slice(i);
          break;
        }
        const next = input[i + 1];
        if (next === '[') {
          let j = i + 2;
          while (j < input.length && !(input[j] >= '@' && input[j] <= '~')) {
            j += 1;
          }
          if (j >= input.length) {
            this.pendingEscape = input.slice(i);
            break;
          }
          this.applyCsi(input.slice(i + 2, j + 1));
          i = j + 1;
          continue;
        }
        if (next === ']') {
          // OSC sequence terminated by BEL (\x07) or ST (\x1b\\)
          let j = i + 2;
          let closed = false;
          while (j < input.length) {
            if (input[j] === '\x07') {
              j += 1;
              closed = true;
              break;
            }
            if (input[j] === '\x1b' && input[j + 1] === '\\') {
              j += 2;
              closed = true;
              break;
            }
            j += 1;
          }
          if (!closed) {
            this.pendingEscape = input.slice(i);
            break;
          }
          i = j;
          continue;
        }
        if (next === 'c') {
          // RIS reset
          this.currentStyle = {};
          this.clear();
        }
        i += 2;
        continue;
      }

      if (ch === '\r') {
        this.cursorCol = 0;
      } else if (ch === '\n') {
        this.lineFeed();
        this.cursorCol = 0;
      } else if (ch === '\b') {
        this.cursorCol = Math.max(0, this.cursorCol - 1);
      } else if (ch === '\t') {
        const nextStop = Math.min(this.cols - 1, (Math.floor(this.cursorCol / 8) + 1) * 8);
        while (this.cursorCol < nextStop) this.putChar(' ');
      } else if (ch >= ' ' || ch === '\u00a0') {
        this.putChar(ch);
      }
      i += 1;
    }
  }

  getSnapshot(): TerminalSnapshot {
    const buf = this.activeRows;
    let lastNonEmpty = this.cursorRow;
    for (let r = buf.length - 1; r > this.cursorRow; r -= 1) {
      if (buf[r].length > 0) {
        lastNonEmpty = r;
        break;
      }
    }

    const visibleScreen = buf.slice(0, lastNonEmpty + 1).map(rowToLine);
    const history = this.isAltScreen ? [] : this.scrollback.map(rowToLine);
    return {
      lines: [...history, ...visibleScreen],
      cursorRow: history.length + this.cursorRow,
      cursorCol: this.cursorCol,
      cols: this.cols,
      rows: this.rows,
      isAltScreen: this.isAltScreen,
    };
  }
}

export function createAnsiTerminalBuffer(
  cols = 80,
  rows = 24,
  maxScrollback = MAX_SCROLLBACK_DEFAULT,
): AnsiTerminalBuffer {
  return new AnsiTerminalBuffer(cols, rows, maxScrollback);
}
