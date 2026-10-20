/**
 * Screens that show times were pinned to Asia/Karachi at import. They now use
 * the shop's own clock, built when asked: Pakistan exactly as before (its own
 * tests pin "19:35" and "Sat 26 Sep 19:35"), a US till in its zone and on the
 * 12-hour clock its receipts use.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { US_SHOP_LOCALE, resetShopLocale, setShopLocale } from '@cheeseoclock/shared-types';
import { paperTime } from './paperLabels';
import { whenText } from '../inventory/recipeCalcView';
import { formatWhen } from '../inventory/movement-view';

afterEach(resetShopLocale);

// 00:35 UTC on 21 Oct = 20:35 on 20 Oct in New York (EDT); 05:35 on the 21st in Karachi.
const AT = '2026-10-21T00:35:00.000Z';

describe('Pakistan keeps its clock (Karachi, UTC+5) on these screens', () => {
  it('as before', () => {
    expect(paperTime(AT)).toBe('05:35');
    expect(whenText(new Date(AT))).toBe('21 Oct 2026, 05:35');
  });
});

describe('a US till shows its own clock', () => {
  it('in its zone, 12-hour, month first', () => {
    setShopLocale(US_SHOP_LOCALE);
    expect(paperTime(AT)).toBe('8:35 PM');
    expect(paperTime(AT, '2026-10-19T15:00:00.000Z')).toMatch(/^Tue, Oct 20 8:35 PM$|^Tue Oct 20 8:35 PM$/);
    expect(whenText(new Date(AT))).toBe('Oct 20 2026, 8:35 PM');
  });

  it('puts a stock movement on the right trading day and hour', () => {
    setShopLocale(US_SHOP_LOCALE);
    // "now" is 21:00 on the 20th in New York: an 8:35 pm movement is today.
    expect(formatWhen(AT, new Date('2026-10-21T01:00:00.000Z')).toLowerCase()).toBe('today 8:35 pm');
  });
});
