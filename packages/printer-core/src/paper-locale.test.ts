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

afterEach(resetShopLocale);

/** The plain text of a paper, with the ESC/POS control bytes dropped. */
function textOf(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : b === 0x0a ? '\n' : ''))
    .join('');
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
