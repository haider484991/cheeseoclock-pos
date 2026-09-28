import { describe, expect, it } from 'vitest';
import type { OrderStockLine, OrderStockStatus, StockSettlement } from '@cheeseoclock/shared-types';
import { foodMadeQuestion } from '@cheeseoclock/pos-domain';
import {
  CANCEL_REASONS,
  REFUND_REASONS,
  reasonChips,
  aboutCost,
  answerFromReason,
  cancelToast,
  drinkLines,
  historyStockStep,
  kitchenLine,
  lineText,
  linesSummary,
  outcomePreview,
  refundToast,
  stockNotes,
} from './stockCopy';

// Made-up names and prices.
const line = (name: string, qty: number, unit: string, estCostCents = 0, more: Partial<OrderStockLine> = {}): OrderStockLine => ({
  ingredientId: `i_${name.toLowerCase().replace(/\W+/g, '_')}`,
  name,
  unit,
  qty,
  estCostCents,
  drink: false,
  note: null,
  ...more,
});
const CHEESE = line('Cheese', 90, 'g', 180);
const DOUGH = line('Dough', 300, 'g', 300);
const CHICKEN = line('Chicken', 60, 'g', 180);
const BOX = line('Box', 1, 'pcs', 0);
const ONION = line('Onion', 15, 'g', 0);
const COLA = line('Cola 1.5 L', 1, 'pcs', 0, { drink: true });

const status = (lines: OrderStockLine[], more: Partial<OrderStockStatus> = {}): OrderStockStatus => ({
  orderId: 'o1',
  status: 'sent_to_kitchen',
  state: 'out',
  takenAt: null,
  lines,
  estCostCents: lines.reduce((s, l) => s + l.estCostCents, 0),
  hasCosts: lines.some((l) => l.estCostCents > 0),
  question: { ask: 'choose', preselect: null, lean: null, hint: '' },
  kitchenTicket: 'printed',
  otherTill: false,
  settledAt: null,
  settledByName: null,
  approvedByName: null,
  answer: null,
  wasteCents: 0,
  hiddenLines: 0,
  ...more,
});

const settlement = (more: Partial<StockSettlement>): StockSettlement => ({
  outcome: 'not_made',
  answered: 'staff',
  how: 'cancelled',
  statusBefore: 'sent_to_kitchen',
  lines: [{ ...CHEESE, putBack: 90, wasted: 0 }],
  wasteCents: 0,
  drinksBack: 0,
  returnedLines: 1,
  wastedLines: 0,
  skipped: 0,
  hasCosts: true,
  hiddenLines: 0,
  ...more,
});

describe('lines', () => {
  it('names a line with its amount; pieces as ×n', () => {
    expect(lineText(CHEESE)).toBe('Cheese 90 g');
    expect(lineText(line('Flour', 2_000, 'g'))).toBe('Flour 2 kg');
    expect(lineText(COLA)).toBe('Cola 1.5 L ×1');
  });

  it('sums up the biggest costs first, then "and N more"', () => {
    expect(linesSummary([ONION, CHEESE, BOX, DOUGH, CHICKEN])).toBe('Dough 300 g, Cheese 90 g, Chicken 60 g and 2 more');
    expect(linesSummary([CHEESE])).toBe('Cheese 90 g');
    expect(linesSummary([])).toBe('');
  });

  it('never says "about Rs 0"', () => {
    expect(aboutCost(18_000, true)).toBe(' · about Rs 180');
    expect(aboutCost(0, true)).toBe('');
    expect(aboutCost(500, false)).toBe('');
  });
});

describe('outcomePreview', () => {
  const s = status([CHEESE, DOUGH, COLA]);

  it('says nothing until an answer is picked', () => {
    expect(outcomePreview(s, null, new Set())).toEqual([]);
  });

  it('"Not made": what goes back on the shelf', () => {
    expect(outcomePreview(s, 'not_made', new Set())).toEqual(['Goes back on the shelf: Dough 300 g, Cheese 90 g, Cola 1.5 L ×1']);
  });

  it('"Made": what is waste and what it costs; a sealed drink back to the fridge', () => {
    expect(outcomePreview(s, 'made', new Set([COLA.ingredientId]))).toEqual([
      'Counted as waste: Dough 300 g, Cheese 90 g · about Rs 4.80',
      'Cola 1.5 L ×1 goes back to the fridge',
    ]);
    expect(outcomePreview(s, 'made', new Set())).toEqual(['Counted as waste: Dough 300 g, Cheese 90 g, Cola 1.5 L ×1 · about Rs 4.80']);
  });

  it('a deleted ingredient is left out of both', () => {
    const d = status([CHEESE, line('Olives', 10, 'g', 0, { note: 'deleted' })]);
    expect(outcomePreview(d, 'not_made', new Set())).toEqual(['Goes back on the shelf: Cheese 90 g']);
  });

  it('only drinks not yet handed over can go back — the other till\'s too (back on its count)', () => {
    expect(drinkLines(s).map((l) => l.name)).toEqual(['Cola 1.5 L']);
    expect(drinkLines({ ...s, status: 'served' })).toEqual([]);
    expect(drinkLines({ ...s, status: 'out_for_delivery' }).map((l) => l.name)).toEqual(['Cola 1.5 L']);
    expect(drinkLines(status([{ ...COLA, note: 'other_till' }])).map((l) => l.name)).toEqual(['Cola 1.5 L']);
  });

  it('a counter login sees what happens in words, not the ingredient list or rupees', () => {
    const counter = status([COLA], { hiddenLines: 2, hasCosts: false, estCostCents: 0 });
    expect(outcomePreview(counter, null, new Set())).toEqual([]);
    expect(outcomePreview(counter, 'not_made', new Set())).toEqual(['Everything goes back on the shelf.']);
    expect(outcomePreview(counter, 'made', new Set([COLA.ingredientId]))).toEqual([
      'The food counts as waste.',
      'Cola 1.5 L ×1 goes back to the fridge',
    ]);
    // Nothing held at all: nothing to say.
    expect(outcomePreview(status([]), 'made', new Set())).toEqual([]);
  });
});

describe('stockNotes', () => {
  it('one plain line per thing worth knowing', () => {
    expect(
      stockNotes(
        status([
          line('Olives', 10, 'g', 0, { note: 'deleted' }),
          line('Cheese', 90, 'g', 0, { note: 'counted_since' }),
          line('Dough', 300, 'g', 0, { note: 'other_till' }),
        ]),
      ),
    ).toEqual([
      "Olives was deleted from Inventory, so it can't go back.",
      'Cheese was counted in a stock take after this was sent, so it is not added again.',
      "Some of this order's stock was taken on the other till. What goes back goes on that till's count when the tills sync.",
    ]);
    expect(stockNotes(status([CHEESE]))).toEqual([]);
    // A counter login has no lines: the order-level flag still says it.
    expect(stockNotes(status([], { otherTill: true, hiddenLines: 3 }))).toEqual([
      "Some of this order's stock was taken on the other till. What goes back goes on that till's count when the tills sync.",
    ]);
  });
});

describe('kitchenLine', () => {
  it('while the kitchen has it: the slip, or tell them', () => {
    expect(kitchenLine('sent_to_kitchen', 'printed', '#42')).toBe('The kitchen gets a CANCELLED slip.');
    expect(kitchenLine('preparing', 'not_printed', '#42')).toBe('The kitchen ticket did not print — tell the kitchen to stop #42.');
    expect(kitchenLine('sent_to_kitchen', 'none', '#42')).toBe('Tell the kitchen to stop #42.');
    expect(kitchenLine('sent_to_kitchen', undefined, '#42')).toBe('Tell the kitchen to stop #42.');
  });
  it('nothing once it is out of the kitchen', () => {
    expect(kitchenLine('ready', 'printed', '#42')).toBeNull();
    expect(kitchenLine('served', 'printed', '#42')).toBeNull();
  });
});

describe('reason chips', () => {
  const SENT = { ask: 'choose' as const, preselect: null };
  const COOKING = { ask: 'choose' as const, preselect: 'made' as const };
  const LEFT = { ask: 'made_only' as const, preselect: 'made' as const };

  it('the ones that settle the question answer it — while nobody has answered it', () => {
    expect(answerFromReason(CANCEL_REASONS, 'Out of stock', SENT, null)).toEqual({ keep: false, answer: 'not_made' });
    expect(answerFromReason(CANCEL_REASONS, 'Wrong order / duplicate', SENT, null)).toEqual({ keep: false, answer: 'not_made' });
    expect(answerFromReason(CANCEL_REASONS, 'Refused at the door', SENT, null)).toEqual({ keep: false, answer: 'made' });
    expect(answerFromReason(CANCEL_REASONS, 'Not collected', SENT, null)).toEqual({ keep: false, answer: 'made' });
    expect(answerFromReason(CANCEL_REASONS, 'Customer cancelled', SENT, null)).toEqual({ keep: true });
    expect(answerFromReason(REFUND_REASONS, 'Out of stock', SENT, null)).toEqual({ keep: false, answer: 'not_made' });
    expect(answerFromReason(REFUND_REASONS, 'Customer unhappy', SENT, null)).toEqual({ keep: true });
  });

  it('never when there is nothing to choose', () => {
    expect(answerFromReason(CANCEL_REASONS, 'Out of stock', LEFT, null)).toEqual({ keep: true });
    expect(answerFromReason(CANCEL_REASONS, 'Out of stock', null, null)).toEqual({ keep: true });
  });

  it('never flips the "Made" the till starts on once cooking was marked (was: "Wrong order" put a cooking pizza back)', () => {
    expect(answerFromReason(CANCEL_REASONS, 'Wrong order / duplicate', COOKING, null)).toEqual({ keep: true });
    expect(answerFromReason(CANCEL_REASONS, 'Out of stock', COOKING, null)).toEqual({ keep: true });
    expect(answerFromReason(REFUND_REASONS, 'Out of stock', COOKING, null)).toEqual({ keep: true });
  });

  it('never over a tap', () => {
    expect(answerFromReason(CANCEL_REASONS, 'Wrong order / duplicate', SENT, 'staff')).toEqual({ keep: true });
    expect(answerFromReason(CANCEL_REASONS, 'Not collected', COOKING, 'staff')).toEqual({ keep: true });
  });

  it('a later chip replaces an earlier chip\'s answer; one that says nothing about the food clears it', () => {
    expect(answerFromReason(CANCEL_REASONS, 'Not collected', SENT, 'reason')).toEqual({ keep: false, answer: 'made' });
    expect(answerFromReason(CANCEL_REASONS, 'Customer cancelled', SENT, 'reason')).toEqual({ keep: false, answer: null });
  });
});

describe('the owner’s reason buttons (Settings → Staff & kitchen) as the boxes’ chips', () => {
  it('by default: exactly the chips the boxes had before the buttons could be edited, in the same order', () => {
    expect(CANCEL_REASONS).toEqual([
      { label: 'Customer cancelled' },
      { label: 'Refused at the door', foodMade: 'made' },
      { label: 'Not collected', foodMade: 'made' },
      { label: 'Wrong order / duplicate', foodMade: 'not_made' },
      { label: 'Out of stock', foodMade: 'not_made' },
    ]);
    expect(REFUND_REASONS).toEqual([
      { label: 'Customer unhappy' },
      { label: 'Wrong order' },
      { label: 'Cancelled by Foodpanda' },
      { label: 'Out of stock', foodMade: 'not_made' },
    ]);
  });

  it("'ask' says nothing about the food; 'made' and 'not_made' answer it", () => {
    expect(
      reasonChips([
        { label: 'Test ask', food: 'ask' },
        { label: 'Test made', food: 'made' },
        { label: 'Test not made', food: 'not_made' },
      ]),
    ).toEqual([{ label: 'Test ask' }, { label: 'Test made', foodMade: 'made' }, { label: 'Test not made', foodMade: 'not_made' }]);
  });

  it('a pre-answer never overrides the food having left the shop (FOOD_LEFT_SHOP): the question is not asked there', () => {
    const chips = reasonChips([
      { label: 'Test not made', food: 'not_made' },
      { label: 'Test made', food: 'made' },
    ]);
    for (const status of ['out_for_delivery', 'served', 'delivered', 'paid'] as const) {
      const q = foodMadeQuestion({ status, takenAt: null, now: 0, probablyMadeMin: 8 });
      expect(q.ask).toBe('made_only');
      for (const label of ['Test not made', 'Test made']) {
        expect({ status, label, r: answerFromReason(chips, label, q, null) }).toEqual({ status, label, r: { keep: true } });
      }
    }
    // Still in the kitchen, nobody answered: the owner's "not made" button answers it.
    const sent = foodMadeQuestion({ status: 'sent_to_kitchen', takenAt: null, now: 0 });
    expect(answerFromReason(chips, 'Test not made', sent, null)).toEqual({ keep: false, answer: 'not_made' });
  });
});

describe('toasts say what the till did', () => {
  it('cancel', () => {
    expect(cancelToast(null)).toEqual({ title: 'Order cancelled' });
    expect(cancelToast(settlement({}))).toEqual({ title: 'Order cancelled · stock put back' });
    expect(
      cancelToast(settlement({ outcome: 'made', wasteCents: 18_000, returnedLines: 0, wastedLines: 1, lines: [{ ...CHEESE, wasted: 90 }] })),
    ).toEqual({
      title: 'Order cancelled · counted as waste (about Rs 180)',
    });
    expect(cancelToast(settlement({ outcome: 'made', wasteCents: 0, hasCosts: false, drinksBack: 1, wastedLines: 1 }))).toEqual({
      title: 'Order cancelled · counted as waste',
      description: 'The sealed drink went back in the fridge.',
    });
    // "Made", but it was only a sealed drink, back in the fridge.
    expect(cancelToast(settlement({ outcome: 'made', drinksBack: 1, returnedLines: 1, wastedLines: 0 }))).toEqual({
      title: 'Order cancelled · nothing wasted',
      description: 'The sealed drink went back in the fridge.',
    });
    // Put back on the till that took it: still put back.
    expect(cancelToast(settlement({ lines: [{ ...CHEESE, putBack: 0, putBackThere: 90, note: 'other_till' }] })).title).toBe(
      'Order cancelled · stock put back',
    );
    expect(cancelToast(settlement({ returnedLines: 0, skipped: 1, lines: [{ ...CHEESE, putBack: 0, note: 'deleted' }] })).title).toBe(
      'Order cancelled · nothing could go back',
    );
    // A counter login's reply carries no lines: the counts still tell it.
    expect(cancelToast(settlement({ lines: [], hiddenLines: 3, hasCosts: false })).title).toBe('Order cancelled · stock put back');
  });

  it('refund', () => {
    expect(refundToast(true, 'Rs 1,200', settlement({ how: 'refunded' }))).toEqual({ title: 'Refund done · Rs 1,200 back · stock put back' });
    expect(refundToast(false, 'Rs 300', null)).toEqual({ title: 'Part refund done', description: 'Rs 300 back to the customer' });
    expect(refundToast(true, 'Rs 1,200', null)).toEqual({ title: 'Refund done · Rs 1,200 back' });
  });
});

describe('historyStockStep', () => {
  const base = { wasteCents: 0, hasCosts: true, settledByName: 'Ali', approvedByName: 'Sara' };
  it('put back, wasted, or stock that stayed out', () => {
    expect(historyStockStep({ ...base, state: 'returned' })).toEqual({ label: 'Stock put back', extra: 'by Ali, approved by Sara' });
    expect(historyStockStep({ ...base, state: 'wasted', wasteCents: 18_000 })).toEqual({
      label: 'Food wasted',
      extra: 'about Rs 180 · by Ali, approved by Sara',
    });
    expect(historyStockStep({ ...base, state: 'wasted', hasCosts: false, settledByName: null })).toEqual({
      label: 'Food wasted',
      extra: 'approved by Sara',
    });
    expect(historyStockStep({ ...base, state: 'kept' })).toEqual({ label: 'Stock', extra: 'not put back (cancelled before this was asked)' });
    expect(historyStockStep({ ...base, state: 'out' })).toBeNull();
    expect(historyStockStep({ ...base, state: 'none' })).toBeNull();
  });

  it('says "made" when only sealed drinks went back, and where the stock went', () => {
    expect(historyStockStep({ ...base, state: 'returned', answer: 'made' })).toEqual({
      label: 'Made — sealed drinks put back',
      extra: 'by Ali, approved by Sara',
    });
    const there = [{ ...CHEESE, putBack: 0, putBackThere: 90 }];
    expect(historyStockStep({ ...base, state: 'returned', answer: 'not_made', lines: there, hiddenLines: 0 })?.label).toBe(
      'Stock put back on the till that sent it',
    );
    const nothing = [{ ...CHEESE, putBack: 0, note: 'deleted' as const }];
    expect(historyStockStep({ ...base, state: 'returned', answer: 'not_made', lines: nothing, hiddenLines: 0 })?.label).toBe(
      'Stock — nothing could go back',
    );
    // Lines hidden from this login: no guessing from what is left.
    expect(historyStockStep({ ...base, state: 'returned', answer: 'not_made', lines: [], hiddenLines: 4 })?.label).toBe(
      'Stock put back',
    );
  });
});
