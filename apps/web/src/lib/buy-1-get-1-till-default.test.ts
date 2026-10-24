import { describe, expect, it } from 'vitest';
import { DEFAULT_BUY_1_GET_1_RULES, buy1Get1WindowWords, type Buy1Get1Rules } from '@cheeseoclock/shared-types';
import { DEFAULT_FACTS, factsFromBlock, tillBuy1Get1Rules } from './delivery-facts';

/** A till's block as it publishes it, with these Buy 1 Get 1 rules (only the fields factsFromBlock reads). */
function block(buy1Get1: Buy1Get1Rules) {
  return {
    v: 1,
    settingsAt: '2026-10-11T16:32:52.855Z',
    settingsRev: 3,
    settingsTie: 1,
    deviceId: 'till-1',
    pickup: { offered: true, percent: 10 },
    zones: DEFAULT_FACTS.zones.map((z) => ({ ...z, aliases: [...z.aliases] })),
    buy1Get1,
  };
}

describe('Buy 1 Get 1 from a till that never saved its hours (24 Oct 2026: 12–7 PM)', () => {
  it('reads the tills’ old built-in rules (on, 1–7 PM, the name asked) as today’s default: 12–7 PM', () => {
    const sent = { on: true, opensMinute: 13 * 60, closesMinute: 19 * 60, asksSocial: true };
    expect(tillBuy1Get1Rules(sent)).toEqual(DEFAULT_BUY_1_GET_1_RULES);
    const facts = factsFromBlock(block(sent) as never);
    expect(buy1Get1WindowWords(facts.buy1Get1)).toBe('12–7 PM');
  });

  it('keeps any other hours the owner saved, and off as off', () => {
    for (const saved of [
      { on: true, opensMinute: 13 * 60 + 30, closesMinute: 19 * 60, asksSocial: true },
      { on: true, opensMinute: 13 * 60, closesMinute: 19 * 60, asksSocial: false },
      { on: false, opensMinute: 13 * 60, closesMinute: 19 * 60, asksSocial: true },
      { on: true, opensMinute: 22 * 60, closesMinute: 60, asksSocial: true },
    ]) {
      expect(tillBuy1Get1Rules(saved), JSON.stringify(saved)).toEqual(saved);
      expect(factsFromBlock(block(saved) as never).buy1Get1).toEqual(saved);
    }
  });

  it('a till that already sends 12–7 PM is read as it is', () => {
    expect(tillBuy1Get1Rules({ ...DEFAULT_BUY_1_GET_1_RULES })).toEqual(DEFAULT_BUY_1_GET_1_RULES);
  });
});
