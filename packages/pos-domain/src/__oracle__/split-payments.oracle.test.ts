/**
 * ORACLE: how a Pakistani till splits a payment — and the words it refuses
 * one with — must not move. The plan froze these in Phase 0; they are frozen
 * now, copied from v0.7.51 by git show, before their "Rs" messages are swept.
 *
 * Seeded quotes and payment legs, valid and not (fractional, negative, more
 * than the bill), because the refusals are where the words are. Compared as
 * whole outcomes: ok, the amounts, the reason, character for character.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetShopLocale } from '@cheeseoclock/shared-types';
import { splitTender } from '../split-tender.js';
import { settleLegs } from '../settle-legs.js';
import { splitTender as baselineSplitTender } from './split-tender-v0.7.51.js';
import { settleLegs as baselineSettleLegs } from './settle-legs-v0.7.51.js';
import { seededRandom } from './baseline-v0.7.51.js';

beforeEach(resetShopLocale);

const METHODS = ['cash', 'card', 'easypaisa', 'jazzcash', 'bank_transfer'] as const;
const RATED = ['card', 'easypaisa', 'jazzcash', 'bank_transfer'] as const;

/** An amount, now and then one a cashier should never be able to type. */
function amount(rnd: () => number, upTo: number): number {
  const r = rnd();
  if (r < 0.03) return -Math.floor(rnd() * 10_000);
  if (r < 0.06) return Math.floor(rnd() * upTo) + 0.5;
  return Math.floor(rnd() * upTo * 1.3);
}

describe('split payments stay what the pilot does', () => {
  it('splitTender: 100k seeded quotes', () => {
    const rnd = seededRandom(0x5b_11_70);
    for (let i = 0; i < 100_000; i++) {
      const totalCents = Math.floor(rnd() * 2_000_000) + 100;
      const quote = {
        totalCents,
        digitalTotalCents: rnd() < 0.5 ? null : Math.floor(totalCents * (0.9 + rnd() * 0.08)),
        netCents: Math.floor(totalCents / 1.16),
      };
      const card = amount(rnd, totalCents);
      const live = JSON.stringify(splitTender(quote, card));
      const frozen = JSON.stringify(baselineSplitTender(quote, card));
      if (live !== frozen) throw new Error(`splitTender(${JSON.stringify(quote)}, ${card})\n live:   ${live}\n pilot:  ${frozen}`);
    }
  });

  it('settleLegs: 100k seeded quotes and legs', () => {
    const rnd = seededRandom(0x5e_77_1e);
    for (let i = 0; i < 100_000; i++) {
      const totalCents = Math.floor(rnd() * 2_000_000) + 100;
      const methodTotalsCents: Record<string, number> = {};
      for (const m of RATED) if (rnd() < 0.3) methodTotalsCents[m] = Math.floor(totalCents * (0.88 + rnd() * 0.1));
      const quote = {
        totalCents,
        digitalTotalCents: rnd() < 0.5 ? null : Math.floor(totalCents * (0.9 + rnd() * 0.08)),
        methodTotalsCents: Object.keys(methodTotalsCents).length ? methodTotalsCents : null,
        netCents: Math.floor(totalCents / 1.16),
      };
      const legs = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => ({
        method: METHODS[Math.floor(rnd() * METHODS.length)]!,
        amountCents: amount(rnd, totalCents / 2),
      }));
      const live = JSON.stringify(settleLegs(quote as never, legs));
      const frozen = JSON.stringify(baselineSettleLegs(quote as never, legs));
      if (live !== frozen) throw new Error(`settleLegs(${JSON.stringify(quote)}, ${JSON.stringify(legs)})\n live:   ${live}\n pilot:  ${frozen}`);
    }
  });

  it('really says something: the refusals in the sweep are reached', () => {
    // A guard against an oracle that only ever compared two "ok"s.
    const tooMuch = splitTender({ totalCents: 100_000, digitalTotalCents: null, netCents: 86_207 }, 150_000);
    expect(tooMuch.ok).toBe(false);
    expect(JSON.stringify(tooMuch)).toBe(
      JSON.stringify(baselineSplitTender({ totalCents: 100_000, digitalTotalCents: null, netCents: 86_207 }, 150_000)),
    );
    expect(JSON.stringify(tooMuch)).toContain('on the card is more than the bill');
  });
});
