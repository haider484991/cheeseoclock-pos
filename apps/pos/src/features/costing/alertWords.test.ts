/**
 * How Costing → Alerts says things (costing spec Phase 6, D15): which
 * ingredient moved, which dishes it moved, what it costs per week — plain
 * words, no basis points. Every name and price is made up.
 */
import { describe, expect, it } from 'vitest';
import type { CostAlert, CostAlertItemMove } from '@cheeseoclock/shared-types';
import { alertHeadline, alertMoves, alertSummary, changeText, impactText, moveText } from './alertWords';

const move = (p: Partial<CostAlertItemMove> = {}): CostAlertItemMove => ({
  menuItemId: 'm1',
  name: 'Test Fajita — Large',
  priceCents: 200_000,
  costBeforeCents: 61_200,
  costAfterCents: 65_000,
  foodCostBeforeBps: 3_060,
  foodCostAfterBps: 3_250,
  soldLast28: 48,
  impactWeekCents: 45_600,
  ...p,
});

const alert = (p: Partial<CostAlert>): CostAlert => ({
  id: 'a1',
  kind: 'price_jump',
  createdAt: '2026-09-27T10:00:00.000Z',
  seenAt: null,
  seenByName: null,
  impactWeekCents: 0,
  detail: null,
  ...p,
});

describe('alert words', () => {
  it('says a change and its weekly cost in plain words', () => {
    expect(changeText(1_800)).toBe('went up 18%');
    expect(changeText(-1_250)).toBe('went down 12.5%');
    expect(changeText(null)).toBe('changed price');
    expect(impactText(234_000)).toBe('about Rs 2,340 a week more');
    expect(impactText(-82_000)).toBe('about Rs 820 a week less');
    expect(impactText(0)).toBeNull();
  });

  it('a dish it moved: cost to make, food cost, how many a week, what that comes to', () => {
    expect(moveText(move())).toBe(
      'Test Fajita — Large: Rs 612 → Rs 650 to make (food cost 30.6% → 32.5%), about 12 a week: about Rs 456 a week more',
    );
    expect(moveText(move({ soldLast28: 0, impactWeekCents: 0 }))).toBe(
      'Test Fajita — Large: Rs 612 → Rs 650 to make (food cost 30.6% → 32.5%), not sold in the last 4 weeks',
    );
    expect(moveText(move({ flagBefore: 'amber', flagAfter: 'red', targetBps: 3_000 }))).toContain(', now over its target of 30%, about 12 a week');
  });

  it('a key ingredient that jumped', () => {
    const a = alert({
      impactWeekCents: 234_000,
      detail: {
        kind: 'price_jump',
        ingredientId: 'i1',
        ingredientName: 'Test mozzarella',
        unit: 'g',
        before: { unitCostMc: 150_000, priceKind: 'set' },
        after: { unitCostMc: 177_000, priceKind: 'set' },
        changeBps: 1_800,
        source: 'delivery',
        key: true,
        keyBatches: [
          { ingredientId: 'b1', name: 'Test cheese mix', unit: 'g', before: { unitCostMc: 140_000, priceKind: 'set' }, after: { unitCostMc: 162_000, priceKind: 'set' }, changeBps: 1_571 },
        ],
        items: [move()],
        itemsMoved: 6,
      },
    });
    expect(alertHeadline(a)).toBe('Test mozzarella went up 18%: Rs 1,500 / kg → Rs 1,770 / kg');
    expect(alertSummary(a)).toBe(
      "A key ingredient (from a delivery bill). 6 dishes cost more to make: about Rs 2,340 a week more at this till's sales. Test cheese mix went up 15.7% with it.",
    );
    expect(alertMoves(a)).toHaveLength(1);
    // Nothing on the menu uses it.
    expect(alertSummary({ ...a, detail: { ...(a.detail as Extract<CostAlert['detail'], { kind: 'price_jump' }>), key: false, keyBatches: [], items: [], itemsMoved: 0, source: 'manual' } })).toBe(
      'The new price (typed on the till). No dish on the menu uses it.',
    );
  });

  it('a key ingredient that got cheaper, used only by dishes not sold here lately (Rs 0 a week): its dishes cost less, never "more"', () => {
    const a = alert({
      impactWeekCents: 0,
      detail: {
        kind: 'price_jump',
        ingredientId: 'i1',
        ingredientName: 'Test mozzarella',
        unit: 'g',
        before: { unitCostMc: 150_000, priceKind: 'set' },
        after: { unitCostMc: 120_000, priceKind: 'set' },
        changeBps: -2_000,
        source: 'manual',
        key: true,
        keyBatches: [],
        items: [move({ costBeforeCents: 65_000, costAfterCents: 61_200, soldLast28: 0, impactWeekCents: 0 }), move({ menuItemId: 'm2', costBeforeCents: 40_000, costAfterCents: 37_000, soldLast28: 0, impactWeekCents: 0 })],
        itemsMoved: 2,
      },
    });
    expect(alertHeadline(a)).toBe('Test mozzarella went down 20%: Rs 1,500 / kg → Rs 1,200 / kg');
    expect(alertSummary(a)).toBe('A key ingredient (typed on the till). 2 dishes cost less to make.');
    // With no dishes kept to look at, the price's own direction decides.
    const d = a.detail as Extract<CostAlert['detail'], { kind: 'price_jump' }>;
    expect(alertSummary({ ...a, detail: { ...d, items: [] } })).toBe('A key ingredient (typed on the till). 2 dishes cost less to make.');
    // A rise with Rs 0 a week still says more.
    expect(alertSummary({ ...a, detail: { ...d, items: [], changeBps: 2_000 } })).toBe('A key ingredient (typed on the till). 2 dishes cost more to make.');
  });

  it('a batch that kept its old price', () => {
    const a = alert({
      kind: 'batch_unpriced_input',
      detail: {
        kind: 'batch_unpriced_input',
        ingredientId: 'b1',
        ingredientName: 'Test sauce',
        unit: 'g',
        unpricedInputs: [{ ingredientId: 'i9', name: 'Test oregano' }],
        kept: { unitCostMc: 17_813, priceKind: 'set' },
        because: 'price',
        changedName: 'Test tomato',
      },
    });
    expect(alertHeadline(a)).toBe('Test sauce kept its old price');
    expect(alertSummary(a)).toBe(
      "Test tomato changed, but it can't be priced from its batch recipe: Test oregano has no price, so it still costs Rs 178.13 / kg. Give it a price and it follows its recipe again.",
    );
    expect(alertMoves(a)).toEqual([]);
  });

  it('the Monday digest', () => {
    const a = alert({
      kind: 'weekly_digest',
      impactWeekCents: 45_600,
      detail: { kind: 'weekly_digest', weekOf: '2026-09-21', sinceWeekOf: '2026-09-14', changes: [move({ flagBefore: 'amber', flagAfter: 'red', targetBps: 3_000 })] },
    });
    expect(alertHeadline(a)).toBe("This week's prices moved 1 dish across their target");
    expect(alertSummary(a)).toBe(
      "Worked out at the same customer picks as last week, so only price changes count: about Rs 456 a week more at this till's sales.",
    );
    expect(alertMoves(a)).toHaveLength(1);
  });

  it('an alert this till cannot read', () => {
    expect(alertHeadline(alert({ detail: null }))).toBe('An alert from a newer version of the till');
    expect(alertSummary(alert({ detail: null }))).toBe('Update this till to read it.');
  });
});
