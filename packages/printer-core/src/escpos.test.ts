import { describe, expect, it } from 'vitest';
import {
  EscPosBuilder,
  LINES_BEFORE_CUT,
  RASTER_BAND_ROWS,
  qrCode,
  toPrinterAscii,
  wrap,
} from './escpos.js';
import { CUT_MARKER, QR_MARKER, decodeEscPos, escPosToText, logoMarker } from './escpos-decode.js';

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

describe('EscPosBuilder.rasterImage', () => {
  const img = (width: number, height: number, fill = 0xff) => ({
    width,
    height,
    data: new Uint8Array((width / 8) * height).fill(fill),
  });

  it('sends GS v 0 with bytes-per-row and rows, then the dots', () => {
    const data = Uint8Array.from([0x80, 0x01, 0xf0, 0x0f, 0xaa, 0x55]);
    const bytes = new EscPosBuilder(48).rasterImage({ width: 16, height: 3, data }).build();
    expect([...bytes]).toEqual([
      0x1b, 0x40, // ESC @ from the constructor
      0x1d, 0x76, 0x30, 0x00, // GS v 0, normal density
      0x02, 0x00, // xL xH: 2 bytes a row
      0x03, 0x00, // yL yH: 3 rows
      0x80, 0x01, 0xf0, 0x0f, 0xaa, 0x55,
    ]);
  });

  it('splits a tall picture into bands, each with its own header', () => {
    const bytes = new EscPosBuilder(48).rasterImage(img(8, 130), 64).build();
    expect(bytes).toHaveLength(2 + 3 * 8 + 130);
    const header = (at: number) => [...bytes.slice(at, at + 8)];
    expect(header(2)).toEqual([0x1d, 0x76, 0x30, 0x00, 0x01, 0x00, 64, 0x00]);
    expect(header(2 + 8 + 64)).toEqual([0x1d, 0x76, 0x30, 0x00, 0x01, 0x00, 64, 0x00]);
    expect(header(2 + 2 * (8 + 64))).toEqual([0x1d, 0x76, 0x30, 0x00, 0x01, 0x00, 2, 0x00]);
  });

  it('sends a whole logo (up to 160 rows) as one command by default', () => {
    expect(RASTER_BAND_ROWS).toBeGreaterThanOrEqual(160);
    const bytes = new EscPosBuilder(48).rasterImage(img(576, 160)).build();
    expect(bytes).toHaveLength(2 + 8 + 72 * 160);
    expect([...bytes.slice(2, 10)]).toEqual([0x1d, 0x76, 0x30, 0x00, 72, 0x00, 160, 0x00]);
  });

  it('puts the high byte of the row count in yH', () => {
    const bytes = new EscPosBuilder(48).rasterImage(img(8, 300), 300).build();
    expect([...bytes.slice(2, 10)]).toEqual([0x1d, 0x76, 0x30, 0x00, 0x01, 0x00, 0x2c, 0x01]);
  });

  it('refuses a malformed picture without writing anything', () => {
    const b = new EscPosBuilder(48);
    expect(() => b.rasterImage({ width: 10, height: 1, data: new Uint8Array(2) })).toThrow(RangeError);
    expect(() => b.rasterImage({ width: 16, height: 3, data: new Uint8Array(5) })).toThrow(RangeError);
    expect(() => b.rasterImage({ width: 16, height: 0, data: new Uint8Array(0) })).toThrow(RangeError);
    expect(() => b.rasterImage(img(8, 2), 0)).toThrow(RangeError);
    expect([...b.build()]).toEqual([0x1b, 0x40]);
  });

  it('never sends a real-time command (drawer pulse, power off) hidden in the dots', () => {
    // DLE DC4 1 0 1 would pulse the cash drawer; DLE EOT / ENQ ask for status.
    const data = Uint8Array.from([0x10, 0x14, 0x01, 0x00, 0x01, 0x10, 0x04, 0x10, 0x05, 0x10, 0x10, 0x20]);
    const bytes = new EscPosBuilder(48).rasterImage({ width: 96, height: 1, data }).build();
    const dots = [...bytes.slice(10)];
    expect(dots).toHaveLength(data.length);
    for (let i = 0; i + 1 < dots.length; i++) {
      if (dots[i] === 0x10) expect([0x04, 0x05, 0x14]).not.toContain(dots[i + 1]);
    }
    // Only the DLE bytes that led a command changed, each to 0x18 (one more dot).
    expect(dots).toEqual([0x18, 0x14, 0x01, 0x00, 0x01, 0x18, 0x04, 0x18, 0x05, 0x10, 0x10, 0x20]);
  });

  it('feedDots and reset', () => {
    expect([...new EscPosBuilder(48).feedDots(16).build()].slice(2)).toEqual([0x1b, 0x4a, 16]);
    expect([...new EscPosBuilder(48).feedDots(999).build()].slice(2)).toEqual([0x1b, 0x4a, 255]);
    expect([...new EscPosBuilder(48).reset().build()].slice(2)).toEqual([0x1b, 0x40]);
  });
});

describe('decodeEscPos — pictures', () => {
  it('shows a picture as one row and never reads its dots as text or commands', () => {
    // Dots that look like LF, ESC and a cut (GS V) must not turn into rows.
    const data = Uint8Array.from([0x0a, 0x1b, 0x1d, 0x56, 0x00, 0x0a]);
    const b = new EscPosBuilder(48).rasterImage({ width: 16, height: 3, data }).text('after').newline();
    const rows = decodeEscPos(b.build());
    expect(rows.map((r) => r.text)).toEqual([logoMarker(16, 3), 'after']);
    expect(logoMarker(16, 3)).toBe('[logo 16×3]');
  });

  it('merges the bands of one picture into one row', () => {
    const img = { width: 576, height: 160, data: new Uint8Array(72 * 160).fill(0x0a) };
    const one = rowsOf(new EscPosBuilder(48).rasterImage(img).build());
    const banded = rowsOf(new EscPosBuilder(48).rasterImage(img, 64).build());
    expect(one).toEqual(['[logo 576×160]']);
    expect(banded).toEqual(['[logo 576×160]']);
  });

  it('keeps two pictures apart when something prints between them', () => {
    const img = { width: 8, height: 2, data: new Uint8Array(2) };
    const b = new EscPosBuilder(48).rasterImage(img).text('x').newline().rasterImage(img);
    expect(rowsOf(b.build())).toEqual(['[logo 8×2]', 'x', '[logo 8×2]']);
  });
});
