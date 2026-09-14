import { describe, expect, it } from 'vitest';
import { EscPosBuilder, LINES_BEFORE_CUT, qrCode, toPrinterAscii, wrap } from './escpos.js';
import { CUT_MARKER, QR_MARKER, decodeEscPos, escPosToText } from './escpos-decode.js';

const rowsOf = (bytes: Uint8Array) => decodeEscPos(bytes).map((r) => r.text);

describe('toPrinterAscii', () => {
  it('keeps ASCII, swaps typography for stand-ins, and marks the rest', () => {
    expect(toPrinterAscii('Thank you — visit us again!')).toBe('Thank you - visit us again!');
    expect(toPrinterAscii('“Cheese” ‘O’ Clock… 2×3')).toBe('"Cheese" \'O\' Clock... 2x3');
    expect(toPrinterAscii('₨ 1,250 · open till late')).toBe('Rs 1,250 - open till late');
    expect(toPrinterAscii('پنیر')).toBe('????');
    expect(toPrinterAscii('a\tb\nc')).toBe('a\tb\nc');
    expect(toPrinterAscii('')).toBe('?');
  });
});

describe('wrap', () => {
  it('breaks between words and never past the width', () => {
    const rows = wrap('If you can read this, your printer is wired correctly.', 48);
    expect(rows).toEqual(['If you can read this, your printer is wired', 'correctly.']);
  });

  it('hard-wraps a single word longer than the width', () => {
    expect(wrap('ab supercalifragilistic cd', 8)).toEqual([
      'ab',
      'supercal',
      'ifragili',
      'stic cd',
    ]);
  });

  it('measures what the printer prints, not the source string', () => {
    // The em dash is one column on paper ('-'), so this fits in five.
    expect(wrap('a — b', 5)).toEqual(['a - b']);
  });

  it('tolerates a nonsense width', () => {
    expect(wrap('ab cd', 0)).toEqual(['a', 'b', 'c', 'd']);
    expect(wrap('', 10)).toEqual([]);
  });
});

describe('EscPosBuilder', () => {
  it('line pads a label and value to exactly the width', () => {
    const rows = rowsOf(new EscPosBuilder(48).line('Transport', 'OK').build());
    expect(rows).toEqual([`Transport${' '.repeat(37)}OK`]);
    expect(rows[0]).toHaveLength(48);
  });

  it('line that cannot share a row wraps the label and puts the value below, right-aligned', () => {
    const b = new EscPosBuilder(32).line(
      'Discount (Loyal customer of the month, thank you)',
      '- 200.00',
    );
    const rows = rowsOf(b.build());
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(32);
    expect(rows).toEqual([
      'Discount (Loyal customer of the',
      'month, thank you)',
      `${' '.repeat(24)}- 200.00`,
    ]);
  });

  it('line with no value never overflows either', () => {
    const rows = rowsOf(
      new EscPosBuilder(32).line('this label is well past thirty-two columns').build(),
    );
    expect(rows).toEqual(['this label is well past', 'thirty-two columns']);
  });

  it('wrappedText breaks on words within the given width', () => {
    const rows = rowsOf(
      new EscPosBuilder(48)
        .wrappedText('If you can read this, your printer is wired correctly.')
        .build(),
    );
    expect(rows).toEqual(['If you can read this, your printer is wired', 'correctly.']);
    // Half width for double-size text.
    const big = rowsOf(new EscPosBuilder(48).wrappedText('CHEESE O CLOCK PIZZA HOUSE', 24).build());
    expect(big).toEqual(['CHEESE O CLOCK PIZZA', 'HOUSE']);
  });

  it('cut feeds the last line clear of the blade, then cuts', () => {
    const bytes = new EscPosBuilder(48).text('bye').newline().cut(true).build();
    const rows = decodeEscPos(bytes);
    expect(rows[0]?.text).toBe('bye');
    expect(rows.at(-1)?.text).toBe(CUT_MARKER);
    const margin = rows.slice(1, -1);
    expect(margin).toHaveLength(LINES_BEFORE_CUT);
    expect(margin.every((r) => r.text === '')).toBe(true);
    // Three lines are eaten by the head-to-blade gap; anything less than five
    // leaves no visible bottom margin.
    expect(LINES_BEFORE_CUT).toBeGreaterThanOrEqual(5);
    // On the wire: ESC d n, then GS V 1 (partial cut).
    expect([...bytes.slice(-6)]).toEqual([0x1b, 0x64, LINES_BEFORE_CUT, 0x1d, 0x56, 0x01]);
  });
});

describe('decodeEscPos', () => {
  it('strips styling, tracks double width, and marks QR codes and cuts', () => {
    const b = new EscPosBuilder(48);
    b.align('center')
      .bold(true)
      .doubleSize(true)
      .text('BIG')
      .newline()
      .doubleSize(false)
      .bold(false)
      .underline(true)
      .text('u')
      .underline(false)
      .newline();
    qrCode(b, 'https://example.test/x', 6);
    b.openDrawer().feed(2).cut(false);
    const rows = decodeEscPos(b.build());
    expect(rows[0]).toEqual({ text: 'BIG', scale: 2 });
    expect(rows[1]).toEqual({ text: 'u', scale: 1 });
    expect(rows[2]).toEqual({ text: QR_MARKER, scale: 1 });
    expect(rows.at(-1)).toEqual({ text: CUT_MARKER, scale: 1 });
    expect(rows.slice(3, -1).every((r) => r.text === '')).toBe(true);
    expect(rows.slice(3, -1)).toHaveLength(2 + LINES_BEFORE_CUT);
    expect(escPosToText(b.build()).split('\n').slice(0, 3)).toEqual(['BIG', 'u', QR_MARKER]);
  });
});
