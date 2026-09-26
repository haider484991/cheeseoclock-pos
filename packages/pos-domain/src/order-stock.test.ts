import { describe, expect, it } from 'vitest';
import type { OrderStatus, OrderStockLine, OrderStockStatus, StockSettlement } from '@cheeseoclock/shared-types';
import {
  PROBABLY_MADE_MIN,
  PROBABLY_NOT_STARTED_MIN,
  answerWentAgainstHint,
  drinksGoBackByDefault,
  foodLeftShop,
  foodMadeQuestion,
  handedOver,
  isDrinkShelf,
  isSealedDrink,
  kitchenHearsOfClose,
  minutesAgoText,
  noteKindAnswer,
  orderStockNote,
  orderStockNoteKind,
  returnsToOtherTill,
  stockSettlementForCounter,
  stockStatusForCounter,
} from './order-stock.js';
import { ingredientCostCents, unitFactor } from './units.js';

const NOW = Date.parse('2026-09-26T15:00:00.000Z');
const sentMinAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const q = (status: OrderStatus, takenAt: string | null = sentMinAgo(2)) => foodMadeQuestion({ status, takenAt, now: NOW });

describe('foodMadeQuestion', () => {
  it('never answers for them while the order is still "sent to kitchen": one tap is required', () => {
    for (const m of [0, 2, 4.99, 5, 8, 14.99, 15, 90]) {
      const r = q('sent_to_kitchen', sentMinAgo(m));
      expect(r.ask).toBe('choose');
      expect(r.preselect).toBeNull();
    }
  });

  it('says how long ago it was sent, and leans only at the clear ends', () => {
    expect(q('sent_to_kitchen', sentMinAgo(3))).toEqual({
      ask: 'choose',
      preselect: null,
      lean: 'not_made',
      hint: "Sent to the kitchen 3 min ago · 'Start preparing' not tapped",
    });
    expect(q('sent_to_kitchen', sentMinAgo(8))).toMatchObject({ lean: null, hint: "Sent to the kitchen 8 min ago · 'Start preparing' not tapped" });
    expect(q('sent_to_kitchen', sentMinAgo(25))).toMatchObject({ lean: 'made', hint: 'Sent to the kitchen 25 min ago · probably made' });
    expect(q('sent_to_kitchen', sentMinAgo(0.2)).hint).toBe("Sent to the kitchen just now · 'Start preparing' not tapped");
  });

  it('the lean flips exactly at the edges (4:59 vs 5:00, 14:59 vs 15:00)', () => {
    expect(PROBABLY_NOT_STARTED_MIN).toBe(5);
    expect(PROBABLY_MADE_MIN).toBe(15);
    expect(q('sent_to_kitchen', sentMinAgo(4 + 59 / 60)).lean).toBe('not_made');
    expect(q('sent_to_kitchen', sentMinAgo(5)).lean).toBeNull();
    expect(q('sent_to_kitchen', sentMinAgo(14 + 59 / 60)).lean).toBeNull();
    expect(q('sent_to_kitchen', sentMinAgo(15)).lean).toBe('made');
  });

  it('with no send time (or a bad one) it only says the button was not tapped', () => {
    for (const t of [null, 'not a date']) {
      expect(q('sent_to_kitchen', t)).toEqual({ ask: 'choose', preselect: null, lean: null, hint: "'Start preparing' not tapped" });
    }
    // a clock that ran backwards reads as just now
    expect(q('sent_to_kitchen', new Date(NOW + 60_000).toISOString()).hint).toMatch(/just now/);
  });

  it('starts on "Made" once cooking was marked, still one tap to change', () => {
    expect(q('preparing')).toEqual({ ask: 'choose', preselect: 'made', lean: 'made', hint: "'Start preparing' was tapped" });
    expect(q('ready')).toEqual({ ask: 'choose', preselect: 'made', lean: 'made', hint: 'It was marked ready' });
  });

  it('once the food left the shop there is nothing to choose: it counts as waste', () => {
    expect(q('out_for_delivery')).toEqual({ ask: 'made_only', preselect: 'made', lean: 'made', hint: 'It went out with the rider' });
    for (const s of ['served', 'delivered', 'paid'] as const) {
      expect(q(s)).toEqual({ ask: 'made_only', preselect: 'made', lean: 'made', hint: 'It was handed over' });
    }
  });

  it('knows which statuses left the shop and which were handed over', () => {
    const all: OrderStatus[] = ['open', 'sent_to_kitchen', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'served', 'paid', 'void', 'refunded'];
    expect(all.filter(foodLeftShop)).toEqual(['out_for_delivery', 'delivered', 'served', 'paid']);
    expect(all.filter(handedOver)).toEqual(['delivered', 'served', 'paid']);
  });

  it('flags an answer that went against the hint', () => {
    expect(answerWentAgainstHint(q('preparing'), 'not_made')).toBe(true);
    expect(answerWentAgainstHint(q('preparing'), 'made')).toBe(false);
    expect(answerWentAgainstHint(q('sent_to_kitchen', sentMinAgo(30)), 'not_made')).toBe(true);
    expect(answerWentAgainstHint(q('sent_to_kitchen', sentMinAgo(8)), 'not_made')).toBe(false);
    expect(answerWentAgainstHint(q('sent_to_kitchen', sentMinAgo(1)), 'made')).toBe(true);
  });
});

describe('minutesAgoText', () => {
  it('reads like a person would say it', () => {
    expect(minutesAgoText(0)).toBe('just now');
    expect(minutesAgoText(0.9)).toBe('just now');
    expect(minutesAgoText(1)).toBe('1 min ago');
    expect(minutesAgoText(59.9)).toBe('59 min ago');
    expect(minutesAgoText(60)).toBe('1 h ago');
    expect(minutesAgoText(65)).toBe('1 h 5 min ago');
    expect(minutesAgoText(Number.NaN)).toBe('just now');
  });
});

describe('orderStockNote / orderStockNoteKind', () => {
  const KINDS = [
    'put_back',
    'moved_to_waste',
    'waste',
    'drink_back',
    'already_counted',
    'put_back_other_till',
    'drink_back_other_till',
  ] as const;

  it('writes one note per kind, and reads each back', () => {
    for (const how of ['cancelled', 'refunded'] as const) {
      for (const kind of KINDS) {
        expect(orderStockNoteKind(orderStockNote(kind, how))).toBe(kind);
      }
    }
    expect(orderStockNote('put_back', 'cancelled')).toBe('Cancelled, not made — put back');
    expect(orderStockNote('waste', 'refunded')).toBe('Refunded after cooking — counted as waste');
    expect(orderStockNote('put_back_other_till', 'cancelled')).toBe('Cancelled, not made — put back on the till that sent it');
  });

  it('knows which rows go back on the other till, and which answer each row stands for', () => {
    expect(KINDS.filter((k) => returnsToOtherTill(k))).toEqual(['put_back_other_till', 'drink_back_other_till']);
    expect(returnsToOtherTill(null)).toBe(false);
    expect(KINDS.map((k) => [k, noteKindAnswer(k)])).toEqual([
      ['put_back', 'not_made'],
      ['moved_to_waste', 'made'],
      ['waste', 'made'],
      ['drink_back', 'made'],
      ['already_counted', 'not_made'],
      ['put_back_other_till', 'not_made'],
      ['drink_back_other_till', 'made'],
    ]);
    expect(noteKindAnswer(null)).toBeNull();
  });

  it('reads the note older tills wrote as "put back", and anything else as nothing', () => {
    expect(orderStockNoteKind('Order cancelled before cooking — stock put back')).toBe('put_back');
    expect(orderStockNoteKind('Made 2 batches')).toBeNull();
    expect(orderStockNoteKind(null)).toBeNull();
    expect(orderStockNoteKind('')).toBeNull();
  });
});

describe('isDrinkShelf', () => {
  it('only the Drinks shelf', () => {
    expect(isDrinkShelf('drinks')).toBe(true);
    expect(isDrinkShelf('packaging')).toBe(false);
    expect(isDrinkShelf(null)).toBe(false);
  });
});

describe('isSealedDrink', () => {
  const ing = (name: string, unit: string, category: string | null = null) => ({ name, unit, category });

  it('a bottle, can or pack on the Drinks shelf (chosen, or guessed from the name)', () => {
    expect(isSealedDrink(ing('Pepsi 345 ml', 'pcs'))).toBe(true);
    expect(isSealedDrink(ing('7Up 1 Litre', 'pcs'))).toBe(true);
    expect(isSealedDrink(ing('Mineral Water 500ml', 'Pieces'))).toBe(true);
    expect(isSealedDrink(ing('Mango Juice 200 ml', 'pkt'))).toBe(true);
    expect(isSealedDrink(ing('House bottle', 'pcs', 'drinks'))).toBe(true);
  });

  it('not what is poured or mixed: tea, coffee, juice, lemonade, shake mix are weighed or measured', () => {
    expect(isSealedDrink(ing('Coffee', 'g'))).toBe(false);
    expect(isSealedDrink(ing('Tea', 'g'))).toBe(false);
    expect(isSealedDrink(ing('Orange Juice', 'ml'))).toBe(false);
    expect(isSealedDrink(ing('Lemonade', 'ml'))).toBe(false);
    expect(isSealedDrink(ing('Milkshake mix', 'g'))).toBe(false);
    expect(isSealedDrink(ing('Shake base', 'ml', 'drinks'))).toBe(false);
  });

  it('not a piece that is not a drink, nor a drink moved to another shelf', () => {
    expect(isSealedDrink(ing('Pizza Box Large', 'pcs'))).toBe(false);
    expect(isSealedDrink(ing('Cola 1.5 L', 'pcs', 'other'))).toBe(false);
  });
});

describe('drinksGoBackByDefault', () => {
  it('a takeaway or delivery not handed over: its bottles are still sealed', () => {
    for (const mode of ['takeaway', 'delivery', 'online', 'foodpanda'] as const) {
      for (const status of ['sent_to_kitchen', 'preparing', 'ready', 'out_for_delivery'] as const) {
        expect(drinksGoBackByDefault(mode, status)).toBe(true);
      }
    }
  });
  it('not at a table (the drinks go out straight away), and not once handed over', () => {
    for (const status of ['sent_to_kitchen', 'preparing', 'ready'] as const) expect(drinksGoBackByDefault('dine_in', status)).toBe(false);
    for (const status of ['served', 'delivered', 'paid'] as const) expect(drinksGoBackByDefault('takeaway', status)).toBe(false);
  });
});

describe('what a counter login may see', () => {
  const line = (name: string, drink: boolean, more: Partial<OrderStockLine> = {}): OrderStockLine => ({
    ingredientId: `i_${name}`,
    name,
    unit: drink ? 'pcs' : 'g',
    qty: drink ? 1 : 90,
    estCostCents: 1_800,
    drink,
    note: null,
    ...more,
  });
  const lines = [line('Cheese', false, { wasted: 90, wasteCents: 1_800 }), line('Cola', true, { putBack: 1, wasteCents: 0 })];

  it('the question and the sealed drinks stay; ingredient lines and every rupee go', () => {
    const full: OrderStockStatus = {
      orderId: 'o1',
      status: 'sent_to_kitchen',
      state: 'out',
      takenAt: null,
      lines,
      estCostCents: 3_600,
      hasCosts: true,
      question: { ask: 'choose', preselect: null, lean: null, hint: 'x' },
      kitchenTicket: 'printed',
      otherTill: true,
      settledAt: null,
      settledByName: null,
      approvedByName: null,
      answer: null,
      wasteCents: 1_800,
      hiddenLines: 0,
    };
    const c = stockStatusForCounter(full);
    expect(c.lines.map((l) => [l.name, l.estCostCents, l.wasteCents])).toEqual([['Cola', 0, 0]]);
    expect(c).toMatchObject({ estCostCents: 0, hasCosts: false, wasteCents: 0, hiddenLines: 1, otherTill: true, question: full.question });
    expect(JSON.stringify(c)).not.toContain('Cheese');
  });

  it('the reply to a cancel keeps the counts its toast reads', () => {
    const full: StockSettlement = {
      outcome: 'made',
      answered: 'staff',
      how: 'cancelled',
      statusBefore: 'ready',
      lines,
      wasteCents: 1_800,
      drinksBack: 1,
      returnedLines: 1,
      wastedLines: 1,
      skipped: 0,
      hasCosts: true,
      hiddenLines: 0,
    };
    const c = stockSettlementForCounter(full);
    expect(c).toMatchObject({ wasteCents: 0, hasCosts: false, hiddenLines: 1, drinksBack: 1, returnedLines: 1, wastedLines: 1 });
    expect(JSON.stringify(c)).not.toContain('Cheese');
  });
});

describe('unitFactor', () => {
  it('1 when nothing changed, or the row has no unit (written before units were stamped)', () => {
    expect(unitFactor('g', 'g')).toBe(1);
    expect(unitFactor('Grams', 'g')).toBe(1);
    expect(unitFactor(null, 'g')).toBe(1);
    expect(unitFactor(undefined, 'kg')).toBe(1);
    expect(unitFactor('', 'pcs')).toBe(1);
  });
  it('1000 after a Convert (kg → g, l → ml)', () => {
    expect(unitFactor('kg', 'g')).toBe(1000);
    expect(unitFactor('Litre', 'ml')).toBe(1000);
  });
  it('null when the two cannot be converted', () => {
    expect(unitFactor('g', 'kg')).toBeNull();
    expect(unitFactor('pcs', 'g')).toBeNull();
    expect(unitFactor('kg', 'ml')).toBeNull();
  });
});

describe('ingredientCostCents', () => {
  it('prices exactly from the pack, rounding once, else the per-unit cost', () => {
    expect(ingredientCostCents(3, { costPerUnitCents: 38, packSize: 6000, packPriceCents: 225000 })).toBe(113);
    expect(ingredientCostCents(3, { costPerUnitCents: 38, packSize: null, packPriceCents: null })).toBe(114);
    expect(ingredientCostCents(0, { costPerUnitCents: 38, packSize: null, packPriceCents: null })).toBe(0);
    expect(ingredientCostCents(-2, { costPerUnitCents: 100, packSize: null, packPriceCents: null })).toBe(-200);
  });
});

describe('kitchenHearsOfClose: which cancels and refunds go to the kitchen printer', () => {
  const ALL: OrderStatus[] = ['open', 'sent_to_kitchen', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'served', 'paid', 'void', 'refunded'];

  it('a cancel or full refund: until the food was handed over — ready on the pass and out with the rider too', () => {
    for (const status of ['sent_to_kitchen', 'preparing', 'ready', 'out_for_delivery'] as const) {
      expect({ status, heard: kitchenHearsOfClose(status) }).toEqual({ status, heard: true });
    }
  });

  it('not once it was served or delivered: a "DO NOT MAKE" slip for food the customer has only confuses the line', () => {
    for (const status of ['served', 'delivered', 'paid'] as const) {
      expect({ status, heard: kitchenHearsOfClose(status) }).toEqual({ status, heard: false });
    }
    // Exactly the handed-over statuses are kept from the kitchen.
    expect(ALL.filter((s) => !kitchenHearsOfClose(s))).toEqual(['delivered', 'served', 'paid']);
  });
});
