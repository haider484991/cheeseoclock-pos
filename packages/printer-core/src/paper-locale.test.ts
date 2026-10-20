/**
 * The paper follows the shop. The oracle proves Pakistan's receipt did not
 * move; this proves the symbol on it is no longer nailed down.
 *
 * Only the symbol and its spacing are checked here — the figure itself is
 * paperMoney's job and the oracle already holds that to v0.7.51.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  DEFAULT_SHOP_LOCALE,
  US_SHOP_LOCALE,
  setShopLocale,
  resetShopLocale,
} from '@cheeseoclock/shared-types';
import { goldenCases } from './receipt-goldens.fixture.js';
import { decodeEscPos, escPosToText } from './escpos-decode.js';

afterEach(resetShopLocale);

/** The plain text of a paper, as the mock printer writes it (escpos-decode.ts). */
function textOf(bytes: Uint8Array): string {
  return escPosToText(bytes);
}

/** A real receipt from the goldens — a paper the till actually prints. */
function receiptText(): string {
  const paper = goldenCases().find((c) => c.name.startsWith('receipt/'));
  if (!paper) throw new Error('no receipt among the golden papers');
  return textOf(paper.render((b) => b));
}

describe('the symbol on the paper comes from the shop', () => {
  it('prints Rs for Pakistan, as it always has', () => {
    const text = receiptText();
    expect(text).toContain('Rs ');
    expect(text).not.toContain('$');
  });

  it('prints $ for a US shop, with no space', () => {
    setShopLocale(US_SHOP_LOCALE);
    const text = receiptText();
    expect(text).toContain('$');
    // A US customer should never see a rupee on a receipt.
    expect(text).not.toContain('Rs ');
  });

  it('names the tax in the shop’s words: "Tax" in Pakistan, "Sales tax" in the US', () => {
    expect(receiptText()).toContain('Tax (16%)');
    expect(receiptText()).not.toContain('Sales tax (16%)');
    setShopLocale(US_SHOP_LOCALE);
    expect(receiptText()).toContain('Sales tax (16%)');
  });

  it('goes back to Rs when the locale is reset', () => {
    setShopLocale(US_SHOP_LOCALE);
    receiptText();
    resetShopLocale();
    expect(receiptText()).toContain('Rs ');
  });

  it('keeps every symbol printable on a thermal printer', () => {
    for (const locale of [DEFAULT_SHOP_LOCALE, US_SHOP_LOCALE]) {
      // The printer's code page is ASCII; anything else comes out as '?'.
      expect(/^[\x20-\x7e]*$/.test(locale.paperSymbol + locale.paperSymbolSeparator)).toBe(true);
    }
  });
});

describe('the time on paper is the shop’s own', () => {
  it('prints New York time, month first, on a 12-hour clock', async () => {
    const { paperDateTime, paperDayMonthClock, paperClock } = await import('@cheeseoclock/shared-types');
    setShopLocale(US_SHOP_LOCALE);
    // 00:35 UTC on the 21st is 20:35 on the 20th in New York (EDT).
    expect(paperDateTime('2026-10-21T00:35:00.000Z')).toBe('10/20/2026 8:35 PM');
    expect(paperDayMonthClock('2026-10-21T00:35:00.000Z')).toBe('10/20 8:35 PM');
    expect(paperClock('2026-10-20T16:05:00.000Z')).toBe('12:05 PM');
    expect(paperClock('2026-10-20T04:00:00.000Z')).toBe('12:00 AM');
    // Winter: EST is UTC-5.
    expect(paperDateTime('2026-01-15T17:00:00.000Z')).toBe('01/15/2026 12:00 PM');
    expect(paperDateTime('not a date')).toBe('');
  });

  it('keeps every line of every golden paper inside the paper on a US till', () => {
    setShopLocale(US_SHOP_LOCALE);
    for (const paper of goldenCases()) {
      const width = paper.name.endsWith('/32') ? 32 : 48;
      for (const { text, scale } of decodeEscPos(paper.render((b) => b))) {
        if (text.startsWith('[')) continue; // [cut], [QR], [logo …], [drawer …]: not printed text
        const columns = text.length * scale; // double-width text takes two columns a letter
        if (columns > width) throw new Error(`${paper.name}: "${text}" takes ${columns} columns on ${width}-column paper`);
      }
    }
  });
});
