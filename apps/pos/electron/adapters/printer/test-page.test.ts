import { describe, expect, it } from 'vitest';
import { CUT_MARKER, LINES_BEFORE_CUT, decodeEscPos, type MonoRaster } from '@cheeseoclock/printer-core';
import { renderTestPage } from './test-page.js';

const SENTENCE =
  'If you can read this, the printer is wired correctly. Save the settings, then print a receipt to see the real layout.';

describe('renderTestPage', () => {
  for (const width of [48, 32] as const) {
    it(`fits ${width} columns`, () => {
      for (const r of decodeEscPos(renderTestPage(width, 'USB: BC-85AC G1'))) {
        expect(r.text.length * r.scale, JSON.stringify(r.text)).toBeLessThanOrEqual(width);
      }
    });
  }

  it('names the connection it was sent through', () => {
    const rows = decodeEscPos(renderTestPage(48, 'USB: BC-85AC G1')).map((r) => r.text);
    expect(rows.some((r) => /^Connection\s+USB: BC-85AC G1$/.test(r))).toBe(true);
    expect(rows.some((r) => /^Paper\s+80 mm \(48 columns\)$/.test(r))).toBe(true);
    const plain = decodeEscPos(renderTestPage(32)).map((r) => r.text);
    expect(plain.some((r) => /^Connection\s+not set$/.test(r))).toBe(true);
    expect(plain.some((r) => /^Paper\s+58 mm \(32 columns\)$/.test(r))).toBe(true);
  });

  it('wraps the closing sentence between words and leaves a margin before the cut', () => {
    const rows = decodeEscPos(renderTestPage(48, 'USB: BC-85AC G1')).map((r) => r.text);
    expect(rows.at(-1)).toBe(CUT_MARKER);
    const margin = rows.slice(-1 - LINES_BEFORE_CUT, -1);
    expect(margin.every((r) => r === '')).toBe(true);
    // The sentence sits between the last rule and that margin, whole words per row.
    const lastRule = rows.lastIndexOf('-'.repeat(48));
    const sentenceRows = rows.slice(lastRule + 1, -1 - LINES_BEFORE_CUT);
    expect(sentenceRows.length).toBeGreaterThan(1);
    expect(sentenceRows.join(' ')).toBe(SENTENCE);
    for (const r of sentenceRows) expect(r).toMatch(/^\S.*\S$/);
  });
});

describe('renderTestPage — shop logo', () => {
  const logo = (): MonoRaster => ({ width: 64, height: 20, data: new Uint8Array(8 * 20).fill(0x81) });

  it('prints the logo at the top and says what receipts do with it', () => {
    const rows = decodeEscPos(
      renderTestPage(48, 'USB: BC-85AC G1', { logo: logo(), logoNote: 'should be above', logoOnReceipts: true }),
    ).map((r) => r.text);
    expect(rows[0]).toBe('[logo 576×20]');
    expect(rows[1]).toBe('TEST PAGE');
    expect(rows.some((r) => /^Logo\s+should be above$/.test(r))).toBe(true);
    expect(rows.some((r) => /^Logo on receipts\s+on$/.test(r))).toBe(true);
  });

  it('says why when there is no logo to print', () => {
    const rows = decodeEscPos(renderTestPage(32, 'LAN', { logo: null, logoNote: 'too dark to print', logoOnReceipts: false })).map(
      (r) => r.text,
    );
    expect(rows[0]).toBe('TEST PAGE');
    expect(rows.some((r) => /^Logo\s+too dark to print$/.test(r))).toBe(true);
    expect(rows.some((r) => /^Logo on receipts\s+off$/.test(r))).toBe(true);
  });

  for (const width of [48, 32] as const) {
    it(`with a logo still fits ${width} columns`, () => {
      const page = renderTestPage(width, 'USB: BC-85AC G1', {
        logo: logo(),
        logoNote: 'too light to print',
        logoOnReceipts: false,
      });
      for (const r of decodeEscPos(page)) {
        expect(r.text.length * r.scale, JSON.stringify(r.text)).toBeLessThanOrEqual(width);
      }
    });
  }

  it('without the options is the page it always was', () => {
    const rows = decodeEscPos(renderTestPage(48, 'USB: BC-85AC G1')).map((r) => r.text);
    expect(rows[0]).toBe('TEST PAGE');
    expect(rows.some((r) => r.startsWith('Logo'))).toBe(false);
  });
});
