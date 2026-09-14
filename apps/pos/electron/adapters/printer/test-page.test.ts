import { describe, expect, it } from 'vitest';
import { CUT_MARKER, LINES_BEFORE_CUT, decodeEscPos } from '@cheeseoclock/printer-core';
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
