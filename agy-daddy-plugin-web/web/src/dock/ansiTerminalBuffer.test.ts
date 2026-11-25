import { describe, expect, it } from 'vitest';
import { createAnsiTerminalBuffer } from './ansiTerminalBuffer';

describe('ansiTerminalBuffer', () => {
  it('parses CRLF, SGR styles, OSC titles, and CSI cursor/erase sequences cleanly', () => {
    const buf = createAnsiTerminalBuffer(40, 10);
    buf.write('\x1b]0;shell title\x07');
    buf.write('\x1b[1;32mPASS\x1b[0m build done\r\n');
    buf.write('123456\r\x1b[2Kreplaced line');

    const snap = buf.getSnapshot();
    expect(snap.lines[0].spans[0]).toEqual({
      text: 'PASS',
      style: { bold: true, fg: '#16a34a' },
    });
    expect(snap.lines[0].spans[1]).toEqual({ text: ' build done' });
    expect(snap.lines[1].spans).toEqual([{ text: 'replaced line' }]);
  });

  it('caps scrollback at maxScrollback and supports alt-screen ?1049h/?1049l without losing main lines', () => {
    const buf = createAnsiTerminalBuffer(40, 4, 100);
    for (let i = 0; i < 150; i += 1) {
      buf.write(`line-${i}\n`);
    }
    const mainSnap = buf.getSnapshot();
    expect(mainSnap.lines.length).toBeLessThanOrEqual(104);
    expect(mainSnap.lines[0].spans[0].text).not.toBe('line-0');

    buf.write('\x1b[?1049h\x1b[2JALT MODE');
    const altSnap = buf.getSnapshot();
    expect(altSnap.isAltScreen).toBe(true);
    expect(altSnap.lines[0].spans[0].text).toBe('ALT MODE');

    buf.write('\x1b[?1049l');
    const restoredSnap = buf.getSnapshot();
    expect(restoredSnap.isAltScreen).toBe(false);
    expect(restoredSnap.lines.some((l) => l.spans[0]?.text === 'line-149')).toBe(true);
  });

  it('handles split escape sequences across chunks', () => {
    const buf = createAnsiTerminalBuffer(40, 8);
    buf.write('hello \x1b[38;2;20;');
    buf.write('40;60mrgb');
    const snap = buf.getSnapshot();
    expect(snap.lines[0].spans).toEqual([
      { text: 'hello ' },
      { text: 'rgb', style: { fg: 'rgb(20, 40, 60)' } },
    ]);
  });
});
