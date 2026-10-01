import { describe, expect, it, vi } from 'vitest';
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

  it('says when it printed in Pakistan time, day first, whatever zone the PC is set to', () => {
    const was = process.env.TZ;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // 14:35 UTC on 14 Sep 2026 is 19:35 in Pakistan; release CI runs in UTC.
      vi.setSystemTime(new Date('2026-09-14T14:35:00.000Z'));
      for (const zone of ['UTC', 'America/New_York', 'Asia/Karachi']) {
        process.env.TZ = zone;
        const rows = decodeEscPos(renderTestPage(48, 'USB: BC-85AC G1')).map((r) => r.text);
        expect(rows.some((r) => /^Printed\s+14\/09\/2026 19:35$/.test(r)), zone).toBe(true);
      }
    } finally {
      vi.useRealTimers();
      if (was === undefined) delete process.env.TZ;
      else process.env.TZ = was;
    }
  });

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
    // …then a blank row and the closing TEST PRINT - NOT A RECEIPT.
    expect(rows.slice(-3 - LINES_BEFORE_CUT, -1 - LINES_BEFORE_CUT)).toEqual(['', 'TEST PRINT - NOT A RECEIPT']);
    const sentenceRows = rows.slice(lastRule + 1, -3 - LINES_BEFORE_CUT);
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
    expect(rows[1]).toBe('TEST PRINT');
    expect(rows.some((r) => /^Logo\s+should be above$/.test(r))).toBe(true);
    expect(rows.some((r) => /^Logo on receipts\s+on$/.test(r))).toBe(true);
  });

  it('says why when there is no logo to print', () => {
    const rows = decodeEscPos(renderTestPage(32, 'LAN', { logo: null, logoNote: 'too dark to print', logoOnReceipts: false })).map(
      (r) => r.text,
    );
    expect(rows[0]).toBe('TEST PRINT');
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
    expect(rows[0]).toBe('TEST PRINT');
    expect(rows.some((r) => r.startsWith('Logo'))).toBe(false);
  });
});

describe('renderTestPage — never mistaken for a receipt', () => {
  it('says TEST PRINT / NOT A RECEIPT at the top and at the bottom', () => {
    const rows = decodeEscPos(renderTestPage(32, 'LAN', { station: 'receipt' }));
    expect(rows[0]).toEqual({ text: 'TEST PRINT', scale: 2 });
    expect(rows[1]).toEqual({ text: 'NOT A RECEIPT', scale: 1 });
    const text = rows.map((r) => r.text);
    expect(text.at(-2 - LINES_BEFORE_CUT)).toBe('TEST PRINT - NOT A RECEIPT');
    expect(text.join('\n')).not.toMatch(/TOTAL|PAID|Rs /);
  });

  it('names the station it was asked for, and says so when a kitchen test fell back to the receipt printer', () => {
    const receipt = decodeEscPos(renderTestPage(48, 'LAN', { station: 'receipt' })).map((r) => r.text);
    expect(receipt).toContain('Station: Receipt printer');
    const kitchen = decodeEscPos(renderTestPage(48, 'LAN', { station: 'kitchen' })).map((r) => r.text);
    expect(kitchen).toContain('Station: Kitchen printer');
    const fellBack = decodeEscPos(
      renderTestPage(32, 'LAN', {
        station: 'kitchen',
        stationNote: 'Kitchen test - no kitchen printer set up, printed on the receipt printer',
      }),
    );
    expect(fellBack.map((r) => r.text).join(' ')).toContain(
      'Kitchen test - no kitchen printer set up, printed on the receipt printer',
    );
    for (const r of fellBack) expect(r.text.length * r.scale).toBeLessThanOrEqual(32);
  });
});
