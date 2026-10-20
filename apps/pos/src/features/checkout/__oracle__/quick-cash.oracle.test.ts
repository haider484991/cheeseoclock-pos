/**
 * ORACLE: the one-tap cash amounts a Pakistani cashier sees must not move.
 *
 * Compares the live quickCashRupees against the v0.7.51 copy with no shop
 * locale set. Passes today and must pass after every phase; a failure means
 * the buttons on Pay changed for Cheese O'Clock. Fix the live code, never
 * the baseline.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetShopLocale } from '@cheeseoclock/shared-types';
import { quickCashRupees } from '../tenderAmounts';
import { baselineQuickCashRupees, seededRandom } from './baseline-v0.7.51';

beforeEach(resetShopLocale);

describe('quick cash stays what the pilot offers', () => {
  const edges = [
    0, -1, 1, 99, 100, 101, 116_000, 100_000, 99_900, 100_100, 500_000, 499_999, 500_001,
    1_000_000, 1_234_567, 5_000_000, 12_345_678,
  ];

  it('matches the baseline on the edge cases, at every button count', () => {
    for (const cents of edges) {
      for (const count of [1, 2, 3, 4, 6]) {
        expect(quickCashRupees(cents, count), `cents=${cents} count=${count}`).toEqual(
          baselineQuickCashRupees(cents, count),
        );
      }
    }
  });

  it('matches the baseline on 100k seeded bills', () => {
    const rnd = seededRandom(0xca_54_00);
    for (let i = 0; i < 100_000; i++) {
      // Mostly real bills, Rs 50 to Rs 20,000, some of them round.
      const raw = Math.floor(rnd() * 2_000_000) + 5_000;
      const cents = rnd() < 0.2 ? Math.round(raw / 10_000) * 10_000 : raw;
      const live = quickCashRupees(cents).join(',');
      const frozen = baselineQuickCashRupees(cents).join(',');
      if (live !== frozen) throw new Error(`quickCashRupees(${cents}) = [${live}], the pilot offered [${frozen}]`);
    }
  });
});
