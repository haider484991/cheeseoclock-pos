import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KITCHEN_TICKET_RULES,
  DEFAULT_MENU_IMPORT_POLICY,
  DEFAULT_STOCK_RULES,
  DEFAULT_VARIANCE_BANDS,
  SHOP_SETTING_DEFAULTS,
  SHOP_SETTING_FORMAT,
  WASTE_REASONS,
  WASTE_REASON_DEFAULT_LABEL,
  kitchenTicketRules,
  type StockRules,
  type WasteReasonSetting,
} from '@cheeseoclock/shared-types';
import {
  VARIANCE_DO_THIS_BPS,
  VARIANCE_DO_THIS_MIN_WINDOW_MS,
  isBuiltInWasteReason,
  newWasteReasonId,
  ownerWasteLabels,
  rankDoThis,
  releasedWasteReasonLabel,
  removedWasteReasonIds,
  stockFill,
  stockRulesPutBack,
  stockTakesDue,
  varianceBand,
  varianceDoThisRules,
  visibleWasteReasons,
  wasteReasonOf,
} from './index.js';

/**
 * Settings phase 7 (Kitchen & stock; the kitchen ticket's rules): the
 * released defaults are TODAY's numbers and behaviour, pinned here — never
 * edit one (two tills on different versions with the key unsaved would
 * disagree; a change is a saved setting). And the pure rules the screens,
 * the main process and Reports share, with the owner's values. Every name
 * and figure is made up.
 */
const DAY = 86_400_000;

describe('the released stock rules are today’s', () => {
  it('"Do this" over 3% of food sales, between stock takes 6 days or more apart; bands 2 / 3 / 5%; no reminders; a full bar at 3 × low; the seven waste reasons', () => {
    expect(DEFAULT_STOCK_RULES).toEqual({
      v: 1,
      varianceDoThisBps: 300,
      bands: { goodUnderBps: 200, okUpToBps: 300, needsWorkUpToBps: 500 },
      varianceMinWindowDays: 6,
      reminders: { keyItemsEveryDays: null, fullEveryDays: null },
      reorderMultiple: 3,
      wasteReasons: [
        { id: 'burnt', label: 'Burnt', hidden: false },
        { id: 'dropped', label: 'Dropped', hidden: false },
        { id: 'expired', label: 'Expired / went off', hidden: false },
        { id: 'wrong_order', label: 'Wrong order made', hidden: false },
        { id: 'returned', label: 'Sent back', hidden: false },
        { id: 'staff_meal', label: 'Staff meal', hidden: false },
        { id: 'other', label: 'Other', hidden: false },
      ],
    });
    expect(DEFAULT_VARIANCE_BANDS).toBe(DEFAULT_STOCK_RULES.bands);
    expect(Object.isFrozen(DEFAULT_STOCK_RULES)).toBe(true);
    expect(Object.isFrozen(DEFAULT_STOCK_RULES.bands)).toBe(true);
    expect(Object.isFrozen(DEFAULT_STOCK_RULES.reminders)).toBe(true);
    expect(Object.isFrozen(DEFAULT_STOCK_RULES.wasteReasons)).toBe(true);
    expect(DEFAULT_STOCK_RULES.wasteReasons.every((r) => Object.isFrozen(r))).toBe(true);
    expect(SHOP_SETTING_DEFAULTS['stock.rules']).toBe(DEFAULT_STOCK_RULES);
    expect(SHOP_SETTING_FORMAT['stock.rules']).toBe(1);
  });

  it('the constants the till used before stay what they were, and are the defaults', () => {
    expect(VARIANCE_DO_THIS_BPS).toBe(300);
    expect(VARIANCE_DO_THIS_MIN_WINDOW_MS).toBe(6 * DAY);
    expect(varianceDoThisRules()).toEqual({ minBps: 300, minWindowMs: 6 * DAY });
    expect(WASTE_REASON_DEFAULT_LABEL).toEqual({
      burnt: 'Burnt',
      dropped: 'Dropped',
      expired: 'Expired / went off',
      wrong_order: 'Wrong order made',
      returned: 'Sent back',
      staff_meal: 'Staff meal',
      other: 'Other',
    });
  });

  it('the released import rule: the file wins on everything the till has (ingredient prices stay the till’s, v0.7.14)', () => {
    expect(DEFAULT_MENU_IMPORT_POLICY).toEqual({ v: 1, itemPrices: 'file', choices: 'file', recipes: 'file', tax: 'file' });
    expect(Object.isFrozen(DEFAULT_MENU_IMPORT_POLICY)).toBe(true);
    expect(SHOP_SETTING_DEFAULTS['menu.importPolicy']).toBe(DEFAULT_MENU_IMPORT_POLICY);
  });

  it('the released kitchen ticket: one ticket, the phone and the drinks on it', () => {
    expect(DEFAULT_KITCHEN_TICKET_RULES).toEqual({ copies: 1, phone: true, drinks: true });
    expect(Object.isFrozen(DEFAULT_KITCHEN_TICKET_RULES)).toBe(true);
  });
});

describe('the kitchen ticket’s rules on a till', () => {
  it('nothing saved (a policy from before they existed, or none at all): the released ones', () => {
    expect(kitchenTicketRules(undefined)).toEqual({ copies: 1, phone: true, drinks: true });
    expect(kitchenTicketRules({})).toEqual({ copies: 1, phone: true, drinks: true });
  });

  it('what is saved; a value out of bounds reads as the released one', () => {
    expect(kitchenTicketRules({ kitchenCopies: 2, kitchenPhone: false, kitchenDrinks: false })).toEqual({ copies: 2, phone: false, drinks: false });
    for (const kitchenCopies of [0, 4, 1.5, -1]) expect(kitchenTicketRules({ kitchenCopies }).copies).toBe(1);
  });
});

describe('the variance rating with the owner’s bands', () => {
  /** Today's rule, as it was written before the bands were a setting. */
  const today = (bps: number | null) => {
    if (bps === null) return null;
    const a = Math.abs(bps);
    if (a < 200) return 'good';
    if (a <= 300) return 'ok';
    if (a <= 500) return 'needs_work';
    return 'look_now';
  };

  it('the default bands rate every share exactly as before', () => {
    for (let bps = -1_200; bps <= 1_200; bps += 5) expect({ bps, band: varianceBand(bps, DEFAULT_VARIANCE_BANDS) }).toEqual({ bps, band: today(bps) });
    expect(varianceBand(null, DEFAULT_VARIANCE_BANDS)).toBeNull();
  });

  it('the owner’s bands: good under, OK up to, needs work up to, look at it now above — either way', () => {
    const bands = { goodUnderBps: 500, okUpToBps: 1_000, needsWorkUpToBps: 1_500 };
    expect(varianceBand(499, bands)).toBe('good');
    expect(varianceBand(500, bands)).toBe('ok');
    expect(varianceBand(1_000, bands)).toBe('ok');
    expect(varianceBand(1_250, bands)).toBe('needs_work');
    expect(varianceBand(-1_250, bands)).toBe('needs_work');
    expect(varianceBand(1_501, bands)).toBe('look_now');
  });

  it('"Do this" from the owner’s share and shortest stretch', () => {
    expect(varianceDoThisRules({ varianceDoThisBps: 250, varianceMinWindowDays: 2 })).toEqual({ minBps: 250, minWindowMs: 2 * DAY });
  });
});

describe('the stock bar with the owner’s multiple', () => {
  it('nothing given: a full bar at 3 × the low level, as before', () => {
    expect(stockFill({ currentQty: 500, lowThreshold: 500 })).toBeCloseTo(1 / 3);
    expect(stockFill({ currentQty: 1_500, lowThreshold: 500 }, DEFAULT_STOCK_RULES.reorderMultiple)).toBe(1);
  });

  it('4 ×: the low level a quarter of the way along, full at 4 ×', () => {
    expect(stockFill({ currentQty: 500, lowThreshold: 500 }, 4)).toBeCloseTo(1 / 4);
    expect(stockFill({ currentQty: 1_500, lowThreshold: 500 }, 4)).toBeCloseTo(0.75);
    expect(stockFill({ currentQty: 2_000, lowThreshold: 500 }, 4)).toBe(1);
    expect(stockFill({ currentQty: 0, lowThreshold: 500 }, 4)).toBe(0);
  });
});

describe('waste reasons keyed by a fixed id', () => {
  const reasons = (...extra: WasteReasonSetting[]): WasteReasonSetting[] => [...DEFAULT_STOCK_RULES.wasteReasons.map((r) => ({ ...r })), ...extra];

  it('a row keeps its reason id, so a rename changes nothing about which reason it counts under', () => {
    // Nothing given: the seven built in, as before ("eaten_by_cat" is Other).
    expect(wasteReasonOf('waste:burnt', null)).toBe('burnt');
    expect(wasteReasonOf('waste:eaten_by_cat', null)).toBe('other');
    // With the owner's list (a renamed Burnt, one he added): still by id.
    const mine = reasons({ id: 'spilled', label: 'Spilled', hidden: true }).map((r) => (r.id === 'burnt' ? { ...r, label: 'Burnt edges' } : r));
    const known = mine.map((r) => r.id);
    expect(wasteReasonOf('waste:burnt', null, known)).toBe('burnt');
    expect(wasteReasonOf('waste:spilled', null, known)).toBe('spilled');
    expect(wasteReasonOf('waste:eaten_by_cat', null, known)).toBe('other');
    expect(wasteReasonOf('cancel_made', 'o1', known)).toBe('cancelled_made');
  });

  it('the owner’s names only where they are not the released ones', () => {
    expect(ownerWasteLabels(DEFAULT_STOCK_RULES.wasteReasons)).toBeNull();
    const mine = reasons({ id: 'spilled', label: 'Spilled', hidden: false }).map((r) => (r.id === 'returned' ? { ...r, label: 'Customer returned' } : r));
    expect(ownerWasteLabels(mine)).toEqual({ returned: 'Customer returned', spilled: 'Spilled' });
    expect(releasedWasteReasonLabel('returned')).toBe('Sent back');
    expect(releasedWasteReasonLabel('spilled')).toBeNull();
    expect(WASTE_REASONS.every(isBuiltInWasteReason)).toBe(true);
    expect(isBuiltInWasteReason('spilled')).toBe(false);
  });

  it('the Waste screen offers the ones not hidden, in the owner’s order', () => {
    const mine = reasons().map((r) => (r.id === 'staff_meal' ? { ...r, hidden: true } : r));
    expect(visibleWasteReasons(mine).map((r) => r.id)).toEqual(['burnt', 'dropped', 'expired', 'wrong_order', 'returned', 'other']);
  });

  it('a new reason’s id is made once from its name: never taken, never one Reports keep, always starting with a letter', () => {
    expect(newWasteReasonId('Spilled on the floor!', WASTE_REASONS)).toBe('spilled_on_the_floor');
    expect(newWasteReasonId('Burnt', WASTE_REASONS)).toBe('burnt_2');
    expect(newWasteReasonId('Burnt', [...WASTE_REASONS, 'burnt_2'])).toBe('burnt_3');
    expect(newWasteReasonId('Test order', [])).toBe('test_order_2');
    expect(newWasteReasonId('Cancelled made', [])).toBe('cancelled_made_2');
    expect(newWasteReasonId('2nd day bread', [])).toBe('r_2nd_day_bread');
    expect(newWasteReasonId('Jalapeño gone soft', [])).toBe('jalapeno_gone_soft');
    expect(newWasteReasonId('!!!', [])).toBe('reason');
    expect(newWasteReasonId('A very long waste reason name that goes on', []).length).toBeLessThanOrEqual(32);
  });

  it('what a Save would remove (hiding is not removing)', () => {
    const before = reasons({ id: 'spilled', label: 'Spilled', hidden: false }, { id: 'mice', label: 'Mice', hidden: false });
    const after = before.filter((r) => r.id !== 'mice').map((r) => (r.id === 'spilled' ? { ...r, hidden: true } : r));
    expect(removedWasteReasonIds(before, after)).toEqual(['mice']);
  });

  it('"Put back the default": exactly the default with nothing added; every reason the owner added stays, hidden (either till may have rows with it)', () => {
    const current: StockRules = {
      ...DEFAULT_STOCK_RULES,
      varianceDoThisBps: 500,
      reorderMultiple: 5,
      wasteReasons: reasons({ id: 'spilled', label: 'Spilled', hidden: false }, { id: 'mice', label: 'Mice', hidden: true }).map((r) =>
        r.id === 'burnt' ? { ...r, label: 'Burnt edges', hidden: true } : r,
      ),
    };
    expect(stockRulesPutBack(DEFAULT_STOCK_RULES)).toEqual(DEFAULT_STOCK_RULES);
    expect(stockRulesPutBack({ wasteReasons: current.wasteReasons.filter((r) => isBuiltInWasteReason(r.id)) })).toEqual(DEFAULT_STOCK_RULES);
    const kept = stockRulesPutBack(current);
    expect(kept.wasteReasons).toEqual([
      ...DEFAULT_STOCK_RULES.wasteReasons,
      { id: 'spilled', label: 'Spilled', hidden: true },
      { id: 'mice', label: 'Mice', hidden: true },
    ]);
    expect(kept.varianceDoThisBps).toBe(300);
    expect(kept.reorderMultiple).toBe(3);
    expect(Object.isFrozen(kept.wasteReasons)).toBe(false);
    // Putting back twice writes the same thing: it is the default from then on.
    expect(stockRulesPutBack(kept)).toEqual(kept);
  });
});

describe('stock-take reminders', () => {
  it('a due reminder is first of the pinned lines: two low key items and three money lines can’t push it off the card', () => {
    const line = (key: string, weekCents: number | null, pinned = false, pinFirst = false) => ({ kind: key.split(':')[0]!, key, weekCents, pinned, pinFirst, cost: false });
    const lines = [
      line('low_stock:a', null, true),
      line('low_stock:b', null, true),
      line('red_item:x', 30_000),
      line('red_item:y', 20_000),
      line('red_item:z', 10_000),
      line('stock_take_due:key_items', null, true, true),
    ];
    const r = rankDoThis(lines, { canSeeCosts: true });
    expect(r.items.map((i) => i.key)).toEqual(['stock_take_due:key_items', 'low_stock:a', 'red_item:x', 'red_item:y', 'red_item:z']);
    expect(r.more).toBe(1);
    // Without the reminder the list is as it always was (the pins by key).
    expect(rankDoThis(lines.slice(0, 5), { canSeeCosts: true }).items.map((i) => i.key)).toEqual([
      'low_stock:a',
      'low_stock:b',
      'red_item:x',
      'red_item:y',
      'red_item:z',
    ]);
  });

  // Trading days start at 05:00 PKT (00:00 UTC). Mon 21 Sep 2026, 10:00 PKT.
  const NOW = Date.parse('2026-09-21T05:00:00.000Z');
  const OFF = { keyItemsEveryDays: null, fullEveryDays: null };

  it('off (the default): never due, whatever was counted', () => {
    expect(stockTakesDue(OFF, { keyItemsAt: null, fullAt: null }, NOW)).toEqual([]);
    expect(stockTakesDue(DEFAULT_STOCK_RULES.reminders, { keyItemsAt: '2026-01-01T06:00:00.000Z', fullAt: null }, NOW)).toEqual([]);
  });

  it('the key items every 7 days: due on the same weekday a week on, not the day before; never counted is due', () => {
    const r = { keyItemsEveryDays: 7, fullEveryDays: null };
    // Last Monday 23:30 PKT (18:30 UTC) is still last Monday's trading day.
    expect(stockTakesDue(r, { keyItemsAt: '2026-09-14T18:30:00.000Z', fullAt: null }, NOW)).toEqual([
      { scope: 'key_items', everyDays: 7, lastAt: '2026-09-14T18:30:00.000Z', daysSince: 7 },
    ]);
    expect(stockTakesDue(r, { keyItemsAt: '2026-09-15T06:00:00.000Z', fullAt: null }, NOW)).toEqual([]);
    expect(stockTakesDue(r, { keyItemsAt: null, fullAt: null }, NOW)).toEqual([{ scope: 'key_items', everyDays: 7, lastAt: null, daysSince: null }]);
  });

  it('a full stock take counts the key items too; when a full one is due, only it is listed', () => {
    const r = { keyItemsEveryDays: 7, fullEveryDays: 30 };
    // A full count 3 days ago covers the key items; the full is not due either.
    expect(stockTakesDue(r, { keyItemsAt: '2026-09-01T06:00:00.000Z', fullAt: '2026-09-18T06:00:00.000Z' }, NOW)).toEqual([]);
    // The full one is due (never done): only it.
    expect(stockTakesDue(r, { keyItemsAt: '2026-09-01T06:00:00.000Z', fullAt: null }, NOW)).toEqual([
      { scope: 'full', everyDays: 30, lastAt: null, daysSince: null },
    ]);
    // Full done 20 days ago (not due), key items 10 days ago: the key items.
    expect(stockTakesDue(r, { keyItemsAt: '2026-09-11T06:00:00.000Z', fullAt: '2026-09-01T06:00:00.000Z' }, NOW)).toEqual([
      { scope: 'key_items', everyDays: 7, lastAt: '2026-09-11T06:00:00.000Z', daysSince: 10 },
    ]);
  });
});
