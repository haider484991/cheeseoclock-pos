import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MENU_IMPORT_POLICY,
  DEFAULT_STOCK_RULES,
  DEFAULT_VARIANCE_BANDS,
  type StockRules,
} from '@cheeseoclock/shared-types';
import {
  addWasteReason,
  bpsFromShareText,
  canRemoveWasteReason,
  removeWasteReason,
  renameWasteReason,
  sameStockRules,
  setWasteReasonHidden,
  stockRulesFromForm,
  stockRulesToForm,
  wasteReasonsProblem,
} from './stockRulesForm';
import {
  importPolicyExample,
  importPolicySummary,
  remindersText,
  reorderExample,
  stockRulesSummary,
  varianceExample,
  wasteReasonsSummary,
} from './stockRulesWords';
import { kitchenTicketText, printPolicyDiffers } from './printingWords';
import { DEFAULT_COUNTER_STOCK, stockRulesOf } from './counterRules';
import { varianceBandsText } from '../../reports/varianceFormat';
import { WASTE_REASON_LABEL, wasteReasonLabel } from '../../reports/reportFormat';
import { defaultTargetText, followsDefaultTarget, withDefaultFollowed } from '../../costing/costingFormat';
import { stockRulesPutBack } from '@cheeseoclock/pos-domain';
import { movementLabel } from '../../inventory/movement-view';
import { suggestReorderQty } from '../../inventory/ingredient-list';
import { stockTakeDueWords } from '../../reports/ownerWeekFormat';

/**
 * Settings → Kitchen & stock and the kitchen ticket's rules in words, and
 * the forms behind the cards: every number is built from the values, the
 * released defaults read as today's, and the owner's changes show where
 * the till uses them (Reports, the stock history, the purchase order, the
 * Dashboard). Every name and figure is made up.
 */
const mine = (over: Partial<StockRules>): StockRules => ({ ...structuredClone(DEFAULT_STOCK_RULES as StockRules), ...over });

describe('the counter’s stock rules before the till answers', () => {
  it('are the released ones', () => {
    expect(stockRulesOf(undefined)).toBe(DEFAULT_COUNTER_STOCK);
    expect(DEFAULT_COUNTER_STOCK).toEqual({ reorderMultiple: 3, wasteReasons: DEFAULT_STOCK_RULES.wasteReasons, reminders: { keyItemsEveryDays: null, fullEveryDays: null } });
  });
});

describe('the stock rules card’s words, from the values', () => {
  it('History: the released rules', () => {
    expect(stockRulesSummary(DEFAULT_STOCK_RULES)).toBe(
      '“Do this” over 3% (6+ days apart) · good under 2%, OK to 3%, needs work to 5% · no reminders · full bar 3 × low · 7 waste reasons',
    );
    expect(
      stockRulesSummary(
        mine({
          varianceDoThisBps: 250,
          varianceMinWindowDays: 3,
          reminders: { keyItemsEveryDays: 7, fullEveryDays: 30 },
          reorderMultiple: 4,
          wasteReasons: DEFAULT_STOCK_RULES.wasteReasons.map((r) => ({ ...r, hidden: r.id === 'other' })),
        }),
      ),
    ).toBe('“Do this” over 2.5% (3+ days apart) · good under 2%, OK to 3%, needs work to 5% · reminders: key items every 7 days, full every 30 days · full bar 4 × low · 7 waste reasons (hidden: “Other”)');
  });

  it('History tells two saves apart that differ only in a waste reason’s name (“Burnt” → “Burnt edges”)', () => {
    const renamed = mine({ wasteReasons: renameWasteReason(DEFAULT_STOCK_RULES.wasteReasons, 'burnt', 'Burnt edges') });
    expect(stockRulesSummary(renamed)).not.toBe(stockRulesSummary(DEFAULT_STOCK_RULES));
    expect(wasteReasonsSummary(renamed.wasteReasons)).toBe('7 waste reasons (“Burnt” renamed “Burnt edges”)');
    const added = setWasteReasonHidden(addWasteReason(renamed.wasteReasons, 'Test spill'), 'staff_meal', true);
    expect(wasteReasonsSummary(added)).toBe('8 waste reasons (“Burnt” renamed “Burnt edges”; added “Test spill”; hidden: “Staff meal”)');
  });

  it('the "Put back the default" dialog says what is written: an added reason stays, hidden', () => {
    const current = mine({
      reorderMultiple: 5,
      wasteReasons: addWasteReason(renameWasteReason(DEFAULT_STOCK_RULES.wasteReasons, 'burnt', 'Burnt edges'), 'Test spill'),
    });
    // SettingCard's dialog describes card.defaultValue, which the main process sets to what Put back writes (putBackOf).
    expect(stockRulesSummary(stockRulesPutBack(current))).toBe(
      '“Do this” over 3% (6+ days apart) · good under 2%, OK to 3%, needs work to 5% · no reminders · full bar 3 × low · 8 waste reasons (added “Test spill”; hidden: “Test spill”)',
    );
    expect(stockRulesSummary(stockRulesPutBack(DEFAULT_STOCK_RULES))).toBe(stockRulesSummary(DEFAULT_STOCK_RULES));
  });

  it('the variance worked through on Rs 100,000 of food sales', () => {
    expect(varianceExample(DEFAULT_STOCK_RULES)).toBe(
      'With Rs 100,000 of food sales between two stock takes, stock gone with nothing to explain it: Rs 1,500 (1.5%) is Good; Rs 3,000 (3%) is OK; Rs 5,000 (5%) is Needs work; Rs 6,000 (6%) is Look at it now. The Dashboard’s “Do this” lists it when more than 3% went (Rs 3,000 here) and the two stock takes are at least 6 days apart; closer ones show in Reports only, as they are.',
    );
    expect(varianceExample(mine({ varianceDoThisBps: 200, varianceMinWindowDays: 1, bands: { goodUnderBps: 100, okUpToBps: 250, needsWorkUpToBps: 400 } }))).toBe(
      'With Rs 100,000 of food sales between two stock takes, stock gone with nothing to explain it: Rs 500 (0.5%) is Good; Rs 2,500 (2.5%) is OK; Rs 4,000 (4%) is Needs work; Rs 5,000 (5%) is Look at it now. The Dashboard’s “Do this” lists it when more than 2% went (Rs 2,000 here) and the two stock takes are at least 1 day apart; closer ones show in Reports only, as they are.',
    );
  });

  it('the reminders: off by default; each one said when on', () => {
    expect(remindersText(DEFAULT_STOCK_RULES.reminders)).toBe('Off: the Dashboard never asks for a stock take. Turn one on and “Do this” pins it when it is due.');
    expect(remindersText({ keyItemsEveryDays: 7, fullEveryDays: 30 })).toBe(
      'The Dashboard’s “Do this” pins “Count the key items” when the last key-items or full stock take was 7 days ago or more, and “Time for a full stock take” when the last full one was 30 days ago or more (or when there has never been one).',
    );
    expect(remindersText({ keyItemsEveryDays: 1, fullEveryDays: null })).toContain('was 1 day ago or more');
  });

  it('the stock bar and "Add low-stock items", from the multiple', () => {
    expect(reorderExample(3)).toBe(
      'Cheese with its low level at 2 kg: its stock bar is full at 6 kg, with the low mark a third of the way along. With 1.5 kg left, “Add low-stock items” on a purchase order puts 4.5 kg on it (whole packs when it comes in packs).',
    );
    expect(reorderExample(4)).toBe(
      'Cheese with its low level at 2 kg: its stock bar is full at 8 kg, with the low mark 1/4 of the way along. With 1.5 kg left, “Add low-stock items” on a purchase order puts 6.5 kg on it (whole packs when it comes in packs).',
    );
  });

  it('the purchase order’s quantity follows the multiple; nothing given is today’s 3 ×', () => {
    expect(suggestReorderQty({ currentQty: 200, lowThreshold: 500, packSize: null })).toBe(1_300);
    expect(suggestReorderQty({ currentQty: 200, lowThreshold: 500, packSize: null }, 4)).toBe(1_800);
    expect(suggestReorderQty({ currentQty: 200, lowThreshold: 500, packSize: 1_000 }, 4)).toBe(2_000);
  });

  it('the import rule and its example', () => {
    expect(importPolicySummary(DEFAULT_MENU_IMPORT_POLICY)).toBe('The file wins on everything (ingredient prices stay the till’s)');
    expect(importPolicySummary({ ...DEFAULT_MENU_IMPORT_POLICY, itemPrices: 'till', recipes: 'till' })).toBe('The till keeps: menu item prices, recipes and batch recipes');
    expect(importPolicyExample(DEFAULT_MENU_IMPORT_POLICY)).toBe(
      'A menu file has a pizza at Rs 1,300 that the till sells at Rs 1,200: the import changes it to Rs 1,300, and the preview shows “price Rs 1,200 → Rs 1,300” before anything is saved.',
    );
    expect(importPolicyExample({ itemPrices: 'till' })).toBe(
      'A menu file has a pizza at Rs 1,300 that the till sells at Rs 1,200: the till keeps Rs 1,200, and the import preview lists it under “Kept on the till” (price Rs 1,200, the file says Rs 1,300).',
    );
  });
});

describe('the stock rules form', () => {
  it('the released rules round-trip unchanged', () => {
    const f = stockRulesToForm(DEFAULT_STOCK_RULES);
    expect(f).toMatchObject({ doThis: '3', good: '2', ok: '3', needsWork: '5', minWindowDays: '6', keyItemsOn: false, keyItemsDays: '7', fullOn: false, fullDays: '30', reorderMultiple: '3' });
    const back = stockRulesFromForm(f);
    expect(back.problem).toBeNull();
    expect(sameStockRules(back.value!, DEFAULT_STOCK_RULES)).toBe(true);
  });

  it('a reminder switched on takes its days; off, the days are not saved', () => {
    const f = { ...stockRulesToForm(DEFAULT_STOCK_RULES), keyItemsOn: true, keyItemsDays: '10' };
    expect(stockRulesFromForm(f).value?.reminders).toEqual({ keyItemsEveryDays: 10, fullEveryDays: null });
  });

  it('what is wrong, before Save, in the main process’s bounds', () => {
    const f = stockRulesToForm(DEFAULT_STOCK_RULES);
    expect(stockRulesFromForm({ ...f, doThis: '25' }).problem).toBe('“Do this” from: 0.5% to 20%, at most one decimal.');
    expect(stockRulesFromForm({ ...f, doThis: '2.55' }).problem).toBe('“Do this” from: 0.5% to 20%, at most one decimal.');
    expect(stockRulesFromForm({ ...f, ok: '2' }).problem).toBe('The ratings go up in order: Good, then OK, then Needs work.');
    expect(stockRulesFromForm({ ...f, minWindowDays: '0' }).problem).toBe('The shortest stretch between stock takes: 1 to 28 days.');
    expect(stockRulesFromForm({ ...f, fullOn: true, fullDays: '5' }).problem).toBe('The full stock take reminder: every 7 to 92 days.');
    expect(stockRulesFromForm({ ...f, reorderMultiple: '1' }).problem).toBe('A full stock bar: 2 to 10 times the low level.');
    expect(bpsFromShareText('2.5%', [50, 2_000])).toBe(250);
    expect(bpsFromShareText('0.4', [50, 2_000])).toBeNull();
  });

  it('waste reasons: an added one gets a fixed id before Other; a rename keeps the id; the till’s own can’t be removed', () => {
    const added = addWasteReason(DEFAULT_STOCK_RULES.wasteReasons, '  Spilled ');
    expect(added.map((r) => r.id)).toEqual(['burnt', 'dropped', 'expired', 'wrong_order', 'returned', 'staff_meal', 'spilled', 'other']);
    expect(added[6]).toEqual({ id: 'spilled', label: 'Spilled', hidden: false });
    const renamed = renameWasteReason(added, 'spilled', 'Spilled on the floor');
    expect(renamed[6]).toEqual({ id: 'spilled', label: 'Spilled on the floor', hidden: false });
    expect(setWasteReasonHidden(renamed, 'burnt', true)[0]).toEqual({ id: 'burnt', label: 'Burnt', hidden: true });
    expect(removeWasteReason(renamed, 'burnt')).toEqual(renamed);
    expect(removeWasteReason(renamed, 'spilled').map((r) => r.id)).not.toContain('spilled');
    // Remove is offered only for a reason added since the last Save: a saved one may be on either till's waste entries.
    expect(canRemoveWasteReason('spilled', DEFAULT_STOCK_RULES.wasteReasons)).toBe(true);
    expect(canRemoveWasteReason('spilled', added)).toBe(false);
    expect(canRemoveWasteReason('burnt', [])).toBe(false);
    expect(wasteReasonsProblem(renameWasteReason(added, 'spilled', 'burnt'))).toBe('Two waste reasons are called “burnt”.');
    expect(wasteReasonsProblem(renameWasteReason(added, 'spilled', ' '))).toBe('A waste reason needs a name.');
    expect(wasteReasonsProblem(added.map((r) => ({ ...r, hidden: true })))).toBe('Keep at least one waste reason on the Waste screen.');
  });
});

describe('where the owner’s waste names show', () => {
  it('Reports: his name where he renamed or added a reason, else the released name', () => {
    expect(wasteReasonLabel('burnt')).toBe('Burnt');
    expect(wasteReasonLabel('cancelled_made')).toBe('Cancelled after cooking');
    expect(wasteReasonLabel('burnt', { burnt: 'Burnt edges' })).toBe('Burnt edges');
    expect(wasteReasonLabel('spilled', { spilled: 'Spilled' })).toBe('Spilled');
    expect(wasteReasonLabel('spilled')).toBe('Other');
    expect(WASTE_REASON_LABEL.staff_meal).toBe(DEFAULT_STOCK_RULES.wasteReasons.find((r) => r.id === 'staff_meal')?.label);
  });

  it('the stock history: an old row follows a rename; with the released names it reads as today', () => {
    const row = { reason: 'waste' as const, deltaQty: -5, notes: null, detail: 'waste:returned' as const };
    expect(movementLabel(row).label).toBe('Waste · sent back');
    expect(movementLabel(row, DEFAULT_STOCK_RULES.wasteReasons).label).toBe('Waste · sent back');
    expect(movementLabel(row, renameWasteReason(DEFAULT_STOCK_RULES.wasteReasons, 'returned', 'Customer returned')).label).toBe('Waste · Customer returned');
    const spill = { ...row, detail: 'waste:spilled' as const };
    expect(movementLabel(spill, addWasteReason(DEFAULT_STOCK_RULES.wasteReasons, 'Spilled')).label).toBe('Waste · Spilled');
    expect(movementLabel({ ...row, detail: 'waste:other' as const }, DEFAULT_STOCK_RULES.wasteReasons).label).toBe('Waste');
  });
});

describe('Reports and the Dashboard say the owner’s numbers', () => {
  it('the rating’s bands under the figure', () => {
    expect(varianceBandsText(undefined)).toBe('Under 2% is good; over 5%, look at it now');
    expect(varianceBandsText(DEFAULT_VARIANCE_BANDS)).toBe('Under 2% is good; over 5%, look at it now');
    expect(varianceBandsText({ goodUnderBps: 150, okUpToBps: 300, needsWorkUpToBps: 450 })).toBe('Under 1.5% is good; over 4.5%, look at it now');
  });

  it('the stock-take reminder as a "Do this" line', () => {
    expect(stockTakeDueWords({ scope: 'key_items', everyDays: 7, daysSince: 9 })).toEqual({
      title: 'Count the key items',
      detail: 'The key items were last counted 9 days ago; you asked for a count every 7 days (Settings → Kitchen & stock).',
      action: 'Open stock takes',
      amount: null,
    });
    expect(stockTakeDueWords({ scope: 'full', everyDays: 30, daysSince: null }).detail).toBe(
      'No full stock take yet; you asked for one every 30 days (Settings → Kitchen & stock).',
    );
    expect(stockTakeDueWords({ scope: 'key_items', everyDays: 1, daysSince: 1 }).detail).toBe(
      'The key items were last counted yesterday; you asked for a count every 1 day (Settings → Kitchen & stock).',
    );
    // Never counted at all: said so, never "the last key-items count" (a full stock take counts them too).
    expect(stockTakeDueWords({ scope: 'key_items', everyDays: 7, daysSince: null }).detail).toBe(
      'The key items have never been counted; you asked for a count every 7 days (Settings → Kitchen & stock).',
    );
    expect(stockTakeDueWords({ scope: 'full', everyDays: 30, daysSince: 31 }).detail).toBe(
      'The last full stock take was 31 days ago; you asked for one every 30 days (Settings → Kitchen & stock).',
    );
    for (const daysSince of [null, 0, 1, 9]) {
      expect(stockTakeDueWords({ scope: 'key_items', everyDays: 7, daysSince }).detail).not.toContain('key-items count');
    }
  });

  it('the default food-cost target on Costing → Targets', () => {
    expect(defaultTargetText(3_000)).toBe(
      'A category the till has no suggestion for (one without Pizza, Burger, Fries, Side, Deal, Combo, Dip, Sauce, Drink or Beverage in its name) starts at 30% — shown as “suggested”, without colours, until you save the targets. That is any such category added later, and any above that is still “suggested”: its box follows this one. For example, a new “Wraps” category: a Rs 1,000 wrap is on target up to Rs 300 of ingredients.',
    );
    expect(defaultTargetText(2_750)).toContain('starts at 27.5%');
    expect(defaultTargetText(2_750)).toContain('up to Rs 275 of ingredients');
    // It no longer claims EVERY later category: a later "Cold Drinks" takes the drinks' suggestion.
    expect(defaultTargetText(3_000)).not.toContain('every category added later');
  });

  it('a “suggested” category on the default follows the default box, so Save keeps what the words say (“Test Wraps”)', () => {
    const cats = [
      { categoryId: 'wraps', name: 'Test Wraps', confirmed: false },
      { categoryId: 'drinks', name: 'Cold Drinks', confirmed: false },
      { categoryId: 'rolls', name: 'Test Rolls', confirmed: true },
      { categoryId: 'bowls', name: 'Test Bowls', confirmed: false },
      { categoryId: 'fees', name: 'Test Fees', confirmed: false },
    ];
    expect(cats.map((c) => followsDefaultTarget(c, c.categoryId === 'fees'))).toEqual([true, false, false, true, false]);
    const pct = { wraps: '30', drinks: '60', rolls: '30', bowls: '28', fees: '' };
    const nonFood = { fees: true };
    // The owner typed Bowls' box himself: his number stays.
    expect(withDefaultFollowed(cats, pct, nonFood, new Set(['bowls']), '25')).toEqual({ wraps: '25', drinks: '60', rolls: '30', bowls: '28', fees: '' });
    expect(withDefaultFollowed(cats, pct, nonFood, new Set(), '25')).toMatchObject({ wraps: '25', bowls: '25' });
  });
});

describe('the kitchen ticket’s rules in words (Settings → Printers, this till)', () => {
  const base = { kitchenTicket: true, deliveryBillOnDispatch: true, shopCopy: 'delivery' as const, logoOnReceipt: true };

  it('nothing saved: one ticket, the phone and the drinks on it', () => {
    expect(kitchenTicketText(base)).toBe(
      "Printed once, the moment an order goes to the kitchen — Send to kitchen, Pay now at the counter, or a website order arriving. What to cook, big print, no prices, with every allergy and leave-out note. The customer's name and phone are on it. Drinks are listed with the food. Comes out of the kitchen printer if one is set up below, otherwise the receipt printer. A ticket printed again by hand is one ticket.",
    );
  });

  it('two tickets, no phone, no drinks: said from the values', () => {
    const t = kitchenTicketText({ ...base, kitchenCopies: 2, kitchenPhone: false, kitchenDrinks: false });
    expect(t).toContain('Printed twice at once (each ticket marked COPY 1 OF 2, COPY 2 OF 2)');
    expect(t).toContain("The customer's name is on it, not the phone.");
    expect(t).toContain('an order of only drinks prints no ticket');
    expect(kitchenTicketText({ ...base, kitchenTicket: false })).toContain('Off: this till prints no kitchen tickets by itself.');
  });

  it('Save lights up only for a real change (a field left out reads as its default)', () => {
    expect(printPolicyDiffers(base, { ...base, kitchenCopies: 1, kitchenPhone: true, kitchenDrinks: true })).toBe(false);
    expect(printPolicyDiffers(base, { ...base, kitchenCopies: 2 })).toBe(true);
    expect(printPolicyDiffers(base, { ...base, kitchenDrinks: false })).toBe(true);
  });
});
