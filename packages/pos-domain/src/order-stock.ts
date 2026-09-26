/**
 * "Was the food made?" — asked when an order that already took stock is
 * cancelled or refunded in full. Stock leaves at "send to kitchen", and staff
 * often forget "Start preparing", so the order's status alone can't say
 * whether the food was cooked: a person answers, and the answer goes into the
 * stock ledger (apps/pos/electron/db/repositories/order-stock-repo.ts).
 *
 * The till never answers for them while the food is still in the shop: an
 * order still "sent to kitchen" has no answer tapped (the time since sending
 * is only a hint), and one marked preparing / ready starts on "Made" (one tap
 * to change it for a mis-tap). Once the food has left the shop it can't go
 * back on the shelf, so there is no question — it counts as waste.
 *
 * Pure: the clock is passed in.
 */

import type {
  FoodMade,
  FoodMadeQuestion,
  OrderMode,
  OrderStatus,
  OrderStockHow,
  OrderStockLine,
  OrderStockStatus,
  StockSettlement,
} from '@cheeseoclock/shared-types';
import { guessIngredientCategory, isIngredientCategory } from './ingredient-category.js';
import { normalizeUnit } from './units.js';

/** Under this long after sending, an untouched order was probably not started. Wording only. */
export const PROBABLY_NOT_STARTED_MIN = 5;
/** From this long after sending it was probably made (the board's own "running late" mark). Wording only. */
export const PROBABLY_MADE_MIN = 15;

/** The food has left the shop (with the rider, or handed over): it can't go back on the shelf. */
export const FOOD_LEFT_SHOP: readonly OrderStatus[] = ['out_for_delivery', 'served', 'delivered', 'paid'];
/** Handed to the customer: not even a sealed drink comes back. */
export const HANDED_OVER: readonly OrderStatus[] = ['served', 'delivered', 'paid'];

export function foodLeftShop(status: OrderStatus): boolean {
  return FOOD_LEFT_SHOP.includes(status);
}

export function handedOver(status: OrderStatus): boolean {
  return HANDED_OVER.includes(status);
}

/**
 * Whether cancelling an order, or refunding it in full, from `statusBefore` is
 * sent to the kitchen printer. The print spooler then prints a CANCELLED slip
 * only when a kitchen ticket for the order printed, may have printed (the
 * printer failed mid-way) or is printing now (print-spooler kitchenCancelSlip).
 *
 * Yes while the food had not been handed over — still cooking, ready on the
 * pass, or out with the rider (cancels from ready / out for delivery used to
 * get no slip; 2026-09-27). No once it was served or delivered, for a cancel
 * just as for a refund: that slip always reads "CANCELLED - DO NOT MAKE - DO
 * NOT SEND", and for food the customer already has, perhaps an hour later, it
 * would only confuse the line. The stock is booked as waste without asking
 * then, and a ticket or bill still waiting to print is dropped at print time
 * all the same (print-spooler cancelledMeanwhile).
 */
export function kitchenHearsOfClose(statusBefore: OrderStatus): boolean {
  return !handedOver(statusBefore);
}

/** "just now", "3 min ago", "1 h 5 min ago". */
export function minutesAgoText(minutes: number): string {
  if (!(minutes >= 1)) return 'just now';
  const m = Math.floor(minutes);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h} h ago` : `${h} h ${rest} min ago`;
}

/**
 * How to put the question for an order in `status` whose stock was taken at
 * `takenAt` (ISO), at `now` (epoch ms).
 */
export function foodMadeQuestion(input: {
  status: OrderStatus;
  takenAt: string | null;
  now: number;
}): FoodMadeQuestion {
  switch (input.status) {
    case 'preparing':
      return { ask: 'choose', preselect: 'made', lean: 'made', hint: "'Start preparing' was tapped" };
    case 'ready':
      return { ask: 'choose', preselect: 'made', lean: 'made', hint: 'It was marked ready' };
    case 'out_for_delivery':
      return { ask: 'made_only', preselect: 'made', lean: 'made', hint: 'It went out with the rider' };
    case 'served':
    case 'delivered':
    case 'paid':
      return { ask: 'made_only', preselect: 'made', lean: 'made', hint: 'It was handed over' };
    case 'sent_to_kitchen': {
      const at = input.takenAt ? Date.parse(input.takenAt) : Number.NaN;
      if (!Number.isFinite(at)) {
        return { ask: 'choose', preselect: null, lean: null, hint: "'Start preparing' not tapped" };
      }
      const minutes = Math.max(0, (input.now - at) / 60_000);
      const ago = `Sent to the kitchen ${minutesAgoText(minutes)}`;
      if (minutes >= PROBABLY_MADE_MIN) {
        return { ask: 'choose', preselect: null, lean: 'made', hint: `${ago} · probably made` };
      }
      return {
        ask: 'choose',
        preselect: null,
        lean: minutes < PROBABLY_NOT_STARTED_MIN ? 'not_made' : null,
        hint: `${ago} · 'Start preparing' not tapped`,
      };
    }
    default:
      return { ask: 'choose', preselect: null, lean: null, hint: '' };
  }
}

// ---------------------------------------------------------------------------
// The notes written on the stock rows (read back by Inventory → Stock history)
// ---------------------------------------------------------------------------

export type OrderStockNoteKind =
  /** Not made: back on the shelf (+ sale). */
  | 'put_back'
  /** Made: the sale undone (+ sale) so it is not counted as food sold… */
  | 'moved_to_waste'
  /** …and booked as waste (− waste). */
  | 'waste'
  /** Made, but a sealed drink went back in the fridge (+ sale). */
  | 'drink_back'
  /** Not made, but a stock take after sending already counted it (+ sale, then − count). */
  | 'already_counted'
  /**
   * Not made, and the stock was taken on the OTHER till (+ sale, written here
   * without moving this till's count): the till that took it puts it back on
   * its own count when the row arrives (apply-remote.ts applyOtherTillReturn).
   */
  | 'put_back_other_till'
  /** Made, but a sealed drink the other till took went back in the fridge: as above. */
  | 'drink_back_other_till';

/** The note on a stock row that settled an order. One place, so the labels can read it back. */
export function orderStockNote(kind: OrderStockNoteKind, how: OrderStockHow): string {
  const verb = how === 'refunded' ? 'Refunded' : 'Cancelled';
  switch (kind) {
    case 'put_back':
      return `${verb}, not made — put back`;
    case 'moved_to_waste':
      return `${verb} after cooking — moved to waste`;
    case 'waste':
      return `${verb} after cooking — counted as waste`;
    case 'drink_back':
      return `${verb} — sealed drink put back`;
    case 'already_counted':
      return `${verb}, not made — already in the stock take`;
    case 'put_back_other_till':
      return `${verb}, not made — put back on the till that sent it`;
    case 'drink_back_other_till':
      return `${verb} — sealed drink put back on the till that sent it`;
  }
}

/**
 * Which settle row a note belongs to. Before "Was the food made?" existed a
 * cancel before cooking wrote "Order cancelled before cooking — stock put
 * back": that still reads as put back.
 */
export function orderStockNoteKind(note: string | null | undefined): OrderStockNoteKind | null {
  const n = (note ?? '').trim();
  if (!n) return null;
  if (/— moved to waste$/.test(n)) return 'moved_to_waste';
  if (/after cooking — counted as waste$/.test(n)) return 'waste';
  if (/— sealed drink put back on the till that sent it$/.test(n)) return 'drink_back_other_till';
  if (/— sealed drink put back$/.test(n)) return 'drink_back';
  if (/— already in the stock take$/.test(n)) return 'already_counted';
  if (/not made — put back on the till that sent it$/.test(n)) return 'put_back_other_till';
  if (/not made — put back$/.test(n) || /^Order cancelled before cooking — stock put back$/.test(n)) return 'put_back';
  return null;
}

/** A settle row for stock the other till took: it goes back on THAT till's count, not the writer's. */
export function returnsToOtherTill(kind: OrderStockNoteKind | null): boolean {
  return kind === 'put_back_other_till' || kind === 'drink_back_other_till';
}

/**
 * The answer a settle row stands for — so a till that never saw the question
 * (the other till, whose order-level audit row stays local) still knows it.
 */
export function noteKindAnswer(kind: OrderStockNoteKind | null): FoodMade | null {
  switch (kind) {
    case 'put_back':
    case 'already_counted':
    case 'put_back_other_till':
      return 'not_made';
    case 'moved_to_waste':
    case 'waste':
    case 'drink_back':
    case 'drink_back_other_till':
      return 'made';
    default:
      return null;
  }
}

/** The shelf a stock row's ingredient sits on decides whether it is a sealed drink. */
export function isDrinkShelf(category: string | null | undefined): boolean {
  return category === 'drinks';
}

/** Units a sealed drink is counted in: a bottle or can (pcs), a juice pack (pkt). */
const SEALED_UNITS: ReadonlySet<string> = new Set(['pcs', 'pkt']);

/**
 * A sealed drink: it can go back in the fridge although the food was made.
 * On the Drinks shelf (the one chosen in Inventory, or guessed from the name
 * until one is) AND counted in pieces. Tea, coffee, juice, lemonade or a shake
 * mix sits on the same shelf but is weighed or measured (g, ml): once it is in
 * a cup it can't go back, so it is not "sealed".
 */
export function isSealedDrink(ing: { name: string; category: string | null; unit: string }): boolean {
  const shelf = isIngredientCategory(ing.category) ? ing.category : guessIngredientCategory(ing.name);
  return isDrinkShelf(shelf) && SEALED_UNITS.has(normalizeUnit(ing.unit));
}

/**
 * Under "Made", do sealed drinks go back in the fridge unless someone says
 * otherwise? Not once handed over, and not at a table: dine-in drinks go out
 * to the table straight away (opened, drunk), whatever the kitchen status
 * says. A takeaway or delivery that was never collected, or came back with
 * the rider, still has its bottles sealed in the bag. One tap changes either.
 */
export function drinksGoBackByDefault(mode: OrderMode, status: OrderStatus): boolean {
  return !handedOver(status) && mode !== 'dine_in';
}

// ---------------------------------------------------------------------------
// What a counter login may see
// ---------------------------------------------------------------------------

/**
 * Stock and costs are the owner's business data (owner 2026-09-26; Inventory
 * needs `menu.manage`). For a login without it the question keeps everything
 * it needs — the question, the hint, the kitchen ticket, the other-till flag,
 * the sealed drinks for their "Back in the fridge" buttons — and loses the
 * ingredient lines and every rupee. `hiddenLines` says how many went.
 */
export function stockStatusForCounter(status: OrderStockStatus): OrderStockStatus {
  const kept = status.lines.filter((l) => l.drink).map(withoutCost);
  return {
    ...status,
    lines: kept,
    estCostCents: 0,
    hasCosts: false,
    wasteCents: 0,
    hiddenLines: status.hiddenLines + (status.lines.length - kept.length),
  };
}

/** The same for what a cancel / refund did (its reply). The counts the toast needs stay. */
export function stockSettlementForCounter(stock: StockSettlement): StockSettlement {
  const kept = stock.lines.filter((l) => l.drink).map(withoutCost);
  return {
    ...stock,
    lines: kept,
    wasteCents: 0,
    hasCosts: false,
    hiddenLines: stock.hiddenLines + (stock.lines.length - kept.length),
  };
}

function withoutCost(l: OrderStockLine): OrderStockLine {
  const out: OrderStockLine = { ...l, estCostCents: 0 };
  if (out.wasteCents !== undefined) out.wasteCents = 0;
  return out;
}

/** True when the answer given differs from what the till hinted (tapped for them, or leaned). */
export function answerWentAgainstHint(q: FoodMadeQuestion, answer: FoodMade): boolean {
  const hinted = q.preselect ?? q.lean;
  return hinted !== null && hinted !== answer;
}
