import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALERT_IMPACT_WEEK_CENTS,
  DEFAULT_ALERT_JUMP_BPS,
  isPriceJump,
  priceChangeAlerts,
  resolveAlertSettings,
  suggestedKeyIngredient,
  tradingWeekOf,
} from './cost-alerts.js';
import { PRICE_GUARD_BPS } from './purchase.js';
import { bandWithHysteresis, weeklyImpactCents } from './plate-cost.js';

describe('price alerts: the thresholds (costing spec Phase 6)', () => {
  it("defaults to D1's 10% and Rs 1,000 a week", () => {
    expect(DEFAULT_ALERT_JUMP_BPS).toBe(PRICE_GUARD_BPS);
    expect(DEFAULT_ALERT_JUMP_BPS).toBe(1_000);
    expect(DEFAULT_ALERT_IMPACT_WEEK_CENTS).toBe(100_000);
  });

  it('suggests the key items by name (whole words)', () => {
    for (const name of ['Mozzarella', 'Cheese Mix', 'Chicken Tikka', 'Beef Patty', 'Patties (frozen)', 'Pan Pizza Dough', 'Flour', 'Cooking Oil', 'Pizza Box Medium', 'Boxes'])
      expect({ name, key: suggestedKeyIngredient(name) }).toEqual({ name, key: true });
    for (const name of ['Onion', 'Oregano', 'Boiled Egg', 'Cheddar', 'Toilet roll', 'Burger Foil', 'Chickenpox'])
      expect({ name, key: suggestedKeyIngredient(name) }).toEqual({ name, key: false });
  });

  it('the key items are the ingredients marked as such — one list (costing spec Phase 8)', () => {
    // Nothing saved: the default thresholds, with the key items as they are marked.
    expect(resolveAlertSettings(null, ['a'])).toEqual({ jumpBps: 1_000, impactWeekCents: 100_000, keyIds: new Set(['a']), keysSuggested: true });
    // Saved thresholds keep the key items from the ingredients, never an old list kept inside the setting.
    expect(resolveAlertSettings({ jumpBps: 1_500, impactWeekCents: 0 }, [])).toEqual({
      jumpBps: 1_500,
      impactWeekCents: 0,
      keyIds: new Set(),
      keysSuggested: false,
    });
    const legacy = { jumpBps: 1_500, impactWeekCents: 0, keyIngredientIds: ['old'] };
    expect(resolveAlertSettings(legacy, ['b']).keyIds).toEqual(new Set(['b']));
  });

  it('a jump is more than the threshold either way, never at it', () => {
    expect(isPriceJump(1_000, 1_000)).toBe(false);
    expect(isPriceJump(1_001, 1_000)).toBe(true);
    expect(isPriceJump(-1_001, 1_000)).toBe(true);
    expect(isPriceJump(null, 1_000)).toBe(false);
  });

  it('alerts on a key jump, or on at least the weekly amount either way; never on nothing', () => {
    const s = { impactWeekCents: 100_000 };
    expect(priceChangeAlerts({ keyJump: true, impactWeekCents: 0 }, s)).toBe(true);
    expect(priceChangeAlerts({ keyJump: false, impactWeekCents: 99_999 }, s)).toBe(false);
    expect(priceChangeAlerts({ keyJump: false, impactWeekCents: 100_000 }, s)).toBe(true);
    expect(priceChangeAlerts({ keyJump: false, impactWeekCents: -100_000 }, s)).toBe(true);
    expect(priceChangeAlerts({ keyJump: false, impactWeekCents: 0 }, { impactWeekCents: 0 })).toBe(false);
    expect(priceChangeAlerts({ keyJump: false, impactWeekCents: 1 }, { impactWeekCents: 0 })).toBe(true);
  });

  it('the trading week is its Monday (UTC date = trading day, from 05:00 PKT)', () => {
    expect(tradingWeekOf('2026-09-21T00:00:00.000Z')).toBe('2026-09-21');
    expect(tradingWeekOf('2026-09-27T23:59:59.999Z')).toBe('2026-09-21');
    expect(tradingWeekOf('2026-09-20T23:59:59.999Z')).toBe('2026-09-14');
    // Across a month and a year end.
    expect(tradingWeekOf('2026-10-01T12:00:00.000Z')).toBe('2026-09-28');
    expect(tradingWeekOf('2027-01-01T12:00:00.000Z')).toBe('2026-12-28');
    expect(() => tradingWeekOf('not a date')).toThrow();
  });
});

describe('what a price change costs per week (plate-cost weeklyImpactCents)', () => {
  it("a week's units × the change, a week being a quarter of 28 days; one rounding, symmetric", () => {
    // 40 sold in 28 days (10 a week), Rs 52 more each: Rs 520 a week.
    expect(weeklyImpactCents(40, 3_600_000, 8_800_000)).toBe(52_000);
    expect(weeklyImpactCents(40, 8_800_000, 3_600_000)).toBe(-52_000);
    // 3 sold, 1.5 paisa more each: 3 × 1,500 mc ÷ 4,000 = 1.125 → 1 paisa; the fall is the same size.
    expect(weeklyImpactCents(3, 0, 1_500)).toBe(1);
    expect(weeklyImpactCents(3, 1_500, 0)).toBe(-1);
    // Half a paisa rounds away from zero.
    expect(weeklyImpactCents(1, 0, 2_000)).toBe(1);
    expect(weeklyImpactCents(1, 2_000, 0)).toBe(-1);
    expect(weeklyImpactCents(0, 0, 9_999_999)).toBe(0);
  });
});

describe('the weekly digest band, with a 1-point margin (plate-cost bandWithHysteresis)', () => {
  // Target 30%, close up to 35%. Price Rs 1,000 (1,000,000 mc); cost as a % of it.
  const t = { bps: 3_000, amberBps: 500 };
  const at = (pct: number) => ({ costMc: Math.round(pct * 10_000), priceMc: 1_000_000 });

  it('with nothing before, the plain band (green ≤ T < amber ≤ T+A < red)', () => {
    expect(bandWithHysteresis(null, at(30), t)).toBe('green');
    expect(bandWithHysteresis(null, at(30.01), t)).toBe('amber');
    expect(bandWithHysteresis(null, at(35), t)).toBe('amber');
    expect(bandWithHysteresis(null, at(35.01), t)).toBe('red');
  });

  it('moves up as soon as it crosses a line (as Menu costs colours it), down only a point back under it', () => {
    // Up: the plain lines, so a dish Menu costs shows red is red in the digest too.
    expect(bandWithHysteresis('amber', at(35), t)).toBe('amber'); // on the line: still close
    expect(bandWithHysteresis('amber', at(35.5), t)).toBe('red'); // just over 35%: red, as Menu costs shows it
    expect(bandWithHysteresis('amber', at(35.8), t)).toBe('red');
    expect(bandWithHysteresis('green', at(30.5), t)).toBe('amber');
    // Down: a point back under the line it crossed.
    expect(bandWithHysteresis('red', at(34.5), t)).toBe('red'); // half a point under: stays
    expect(bandWithHysteresis('red', at(34.01), t)).toBe('red');
    expect(bandWithHysteresis('red', at(34), t)).toBe('amber'); // a point under
    expect(bandWithHysteresis('amber', at(29.5), t)).toBe('amber');
    expect(bandWithHysteresis('amber', at(29), t)).toBe('green');
    // A big move skips a band either way.
    expect(bandWithHysteresis('green', at(40), t)).toBe('red');
    expect(bandWithHysteresis('red', at(20), t)).toBe('green');
    expect(bandWithHysteresis('green', at(35.5), t)).toBe('red');
    expect(bandWithHysteresis('red', at(29.5), t)).toBe('amber'); // under T, but not a point under: close
  });

  it('crossing a line is listed once: a half-point wobble around it never flips it back and forth', () => {
    let band = bandWithHysteresis(null, at(34.8), t); // amber
    band = bandWithHysteresis(band, at(35.3), t); // crosses 35%: red, once
    expect(band).toBe('red');
    for (const pct of [34.8, 35.4, 34.9, 35.5, 34.6]) {
      band = bandWithHysteresis(band, at(pct), t);
      expect({ pct, band }).toEqual({ pct, band: 'red' });
    }
    band = bandWithHysteresis(band, at(33.9), t); // well back under: close again
    expect(band).toBe('amber');
    for (const pct of [34.4, 33.9, 34.5, 35]) band = bandWithHysteresis(band, at(pct), t);
    expect(band).toBe('amber');
  });

  it('compares exactly, never on a rounded %', () => {
    // 35.0001%: a hair over 35%.
    expect(bandWithHysteresis('amber', { costMc: 350_001, priceMc: 1_000_000 }, t)).toBe('red');
    expect(bandWithHysteresis('amber', { costMc: 350_000, priceMc: 1_000_000 }, t)).toBe('amber');
    // 34.0001%: a hair under a point back — still red; 34% exactly is a point back.
    expect(bandWithHysteresis('red', { costMc: 340_001, priceMc: 1_000_000 }, t)).toBe('red');
    expect(bandWithHysteresis('red', { costMc: 340_000, priceMc: 1_000_000 }, t)).toBe('amber');
  });
});
