/**
 * The words around "Was the food made?" — the question in the Cancel and
 * Refund dialogs, the toasts after, and the line in Order History. Pure
 * (tested in stockCopy.test.ts); plain, short English for a busy counter.
 */

import { formatCents, formatQty } from '@cheeseoclock/pos-domain';
import type {
  FoodMade,
  OrderStatus,
  OrderStockLine,
  OrderStockStatus,
  StockSettlement,
} from '@cheeseoclock/shared-types';

/** "Test Cheese 90 g" — a drink counted in pieces reads "Cola 1.5 L ×1". */
export function lineText(l: Pick<OrderStockLine, 'name' | 'qty' | 'unit'>, qty = l.qty): string {
  if (l.unit === 'pcs') return `${l.name} ×${qty}`;
  return `${l.name} ${formatQty(qty, l.unit)}`;
}

/** "Cheese 90 g, Dough 300 g, Chicken 60 g and 3 more" — biggest cost first. */
export function linesSummary(lines: Array<Pick<OrderStockLine, 'name' | 'qty' | 'unit' | 'estCostCents'>>, max = 3): string {
  const shown = lines
    .filter((l) => l.qty > 0)
    .slice()
    .sort((a, b) => b.estCostCents - a.estCostCents || a.name.localeCompare(b.name));
  if (shown.length === 0) return '';
  const head = shown.slice(0, max).map((l) => lineText(l)).join(', ');
  const rest = shown.length - max;
  return rest > 0 ? `${head} and ${rest} more` : head;
}

/** " · about Rs 180" — nothing when no prices are set (never "about Rs 0"). */
export function aboutCost(cents: number, hasCosts: boolean): string {
  return hasCosts && cents > 0 ? ` · about ${formatCents(cents)}` : '';
}

/** The lines that can actually be booked here (not deleted, not in an unconvertible unit). */
export function bookable(lines: OrderStockLine[]): OrderStockLine[] {
  return lines.filter((l) => l.note !== 'deleted' && l.note !== 'unit_changed' && l.qty > 0);
}

/** The sealed drinks that could go back to the fridge although the food was made. */
export function drinkLines(status: Pick<OrderStockStatus, 'lines' | 'status'>): OrderStockLine[] {
  if (status.status === 'served' || status.status === 'delivered' || status.status === 'paid') return [];
  return bookable(status.lines).filter((l) => l.drink);
}

/**
 * What the chosen answer will do, one or two lines under the buttons.
 * `drinksBack`: drink ids going back to the fridge although the food was made.
 * A counter login sees no ingredient lines (`hiddenLines`), so it reads what
 * happens in words instead of the list.
 */
export function outcomePreview(
  status: Pick<OrderStockStatus, 'lines' | 'hasCosts' | 'status'> & { hiddenLines?: number },
  answer: FoodMade | null,
  drinksBack: ReadonlySet<string>,
): string[] {
  const lines = bookable(status.lines);
  const hidden = status.hiddenLines ?? 0;
  if (answer === null || (lines.length === 0 && hidden === 0)) return [];
  if (answer === 'not_made') {
    if (hidden > 0) return ['Everything goes back on the shelf.'];
    return [`Goes back on the shelf: ${linesSummary(lines)}`];
  }
  const drinks = drinkLines(status).filter((l) => drinksBack.has(l.ingredientId));
  const drinkIds = new Set(drinks.map((d) => d.ingredientId));
  const waste = lines.filter((l) => !drinkIds.has(l.ingredientId));
  const out: string[] = [];
  if (hidden > 0) out.push('The food counts as waste.');
  else if (waste.length > 0) {
    const cost = waste.reduce((s, l) => s + l.estCostCents, 0);
    out.push(`Counted as waste: ${linesSummary(waste)}${aboutCost(cost, status.hasCosts)}`);
  }
  for (const d of drinks) out.push(`${lineText(d)} goes back to the fridge`);
  return out;
}

/** Notes worth one line each (a deleted ingredient, a stock take since, the other till). */
export function stockNotes(status: Pick<OrderStockStatus, 'lines' | 'otherTill'> & { hiddenLines?: number }): string[] {
  const out: string[] = [];
  for (const l of status.lines) {
    if (l.note === 'deleted') out.push(`${l.name} was deleted from Inventory, so it can't go back.`);
    else if (l.note === 'unit_changed') out.push(`${l.name} changed unit in a way the till can't convert, so it is left as it is.`);
    else if (l.note === 'counted_since') {
      out.push(`${l.name} was counted in a stock take after this was sent, so it is not added again.`);
    }
  }
  // A counter login has no lines to read it from: the order-level flag says it.
  if (status.lines.some((l) => l.note === 'other_till') || (status.otherTill && (status.hiddenLines ?? 0) > 0)) {
    out.push("Some of this order's stock was taken on the other till. What goes back goes on that till's count when the tills sync.");
  }
  return out;
}

/** What the kitchen hears about a cancel, while it still has the order. Null once it is out of the kitchen. */
export function kitchenLine(
  orderStatus: OrderStatus,
  kitchenTicket: OrderStockStatus['kitchenTicket'] | undefined,
  shortNumber: string,
): string | null {
  if (orderStatus !== 'sent_to_kitchen' && orderStatus !== 'preparing') return null;
  if (kitchenTicket === 'printed') return 'The kitchen gets a CANCELLED slip.';
  if (kitchenTicket === 'not_printed') return `The kitchen ticket did not print — tell the kitchen to stop ${shortNumber}.`;
  return `Tell the kitchen to stop ${shortNumber}.`;
}

/** Quick reasons for a cancel; the ones that settle the question answer it too. */
export const CANCEL_REASONS: ReadonlyArray<{ label: string; foodMade?: FoodMade }> = [
  { label: 'Customer cancelled' },
  { label: 'Refused at the door', foodMade: 'made' },
  { label: 'Not collected', foodMade: 'made' },
  { label: 'Wrong order / duplicate', foodMade: 'not_made' },
  { label: 'Out of stock', foodMade: 'not_made' },
];

/** Quick reasons for a refund. */
export const REFUND_REASONS: ReadonlyArray<{ label: string; foodMade?: FoodMade }> = [
  { label: 'Customer unhappy' },
  { label: 'Wrong order' },
  { label: 'Cancelled by Foodpanda' },
  { label: 'Out of stock', foodMade: 'not_made' },
];

/** Who set the answer on screen: a tap on Made / Not made, a reason chip, or nobody yet. */
export type AnsweredBy = 'staff' | 'reason' | null;

/**
 * What a reason chip does to the answer. It only fills a question nobody has
 * answered: never over a tap, and never over the "Made" the till starts on
 * once cooking was marked (a chip is picked for the reason, so it must not
 * quietly flip what the stock does). A chip may replace an earlier chip's
 * answer; one that says nothing about the food then clears it again.
 * `keep`: leave the answer alone; otherwise set it to `answer` (null = unanswered).
 */
export function answerFromReason(
  reasons: ReadonlyArray<{ label: string; foodMade?: FoodMade }>,
  label: string,
  question: { ask: 'choose' | 'made_only'; preselect: FoodMade | null } | null,
  answeredBy: AnsweredBy,
): { keep: true } | { keep: false; answer: FoodMade | null } {
  if (question === null || question.ask !== 'choose' || answeredBy === 'staff') return { keep: true };
  if (answeredBy === null && question.preselect !== null) return { keep: true };
  const suggested = reasons.find((r) => r.label === label)?.foodMade ?? null;
  if (suggested === null && answeredBy !== 'reason') return { keep: true };
  return { keep: false, answer: suggested };
}

/** The note after a cancel, from what the till actually did (not what the dialog guessed). */
export function cancelToast(stock: StockSettlement | null): { title: string; description?: string } {
  if (!stock) return { title: 'Order cancelled' };
  return { title: `Order cancelled · ${stockPhrase(stock)}`, ...drinksDescription(stock) };
}

/** The note after a refund. `amountText`: "Rs 1,200". A part refund that leaves money on the order moves no stock. */
export function refundToast(
  full: boolean,
  amountText: string,
  stock: StockSettlement | null,
): { title: string; description?: string } {
  if (!stock) {
    return full
      ? { title: `Refund done · ${amountText} back` }
      : { title: 'Part refund done', description: `${amountText} back to the customer` };
  }
  return { title: `Refund done · ${amountText} back · ${stockPhrase(stock)}`, ...drinksDescription(stock) };
}

// From the reply's counts, not its lines: a counter login gets no ingredient lines.
function stockPhrase(stock: StockSettlement): string {
  if (stock.outcome === 'not_made') return stock.returnedLines > 0 ? 'stock put back' : 'nothing could go back';
  // Made, but only sealed drinks moved: they went back, nothing was wasted.
  if (stock.wastedLines === 0 && stock.drinksBack > 0) return 'nothing wasted';
  const cost = stock.hasCosts && stock.wasteCents > 0 ? ` (about ${formatCents(stock.wasteCents)})` : '';
  return `counted as waste${cost}`;
}

function drinksDescription(stock: StockSettlement): { description?: string } {
  if (stock.outcome !== 'made' || stock.drinksBack === 0) return {};
  return { description: stock.drinksBack === 1 ? 'The sealed drink went back in the fridge.' : 'The sealed drinks went back in the fridge.' };
}

/** The "What happened" step in Order History, once the order was settled. */
export function historyStockStep(
  status: Pick<OrderStockStatus, 'state' | 'wasteCents' | 'hasCosts' | 'settledByName' | 'approvedByName'> &
    Partial<Pick<OrderStockStatus, 'answer' | 'lines' | 'hiddenLines'>>,
): { label: string; extra: string } | null {
  const who = [
    status.settledByName ? `by ${status.settledByName}` : null,
    status.approvedByName ? `approved by ${status.approvedByName}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  const lines = status.lines ?? [];
  const seesLines = lines.length > 0 && (status.hiddenLines ?? 0) === 0;
  switch (status.state) {
    case 'returned': {
      if (status.answer === 'made') return { label: 'Made — sealed drinks put back', extra: who };
      if (seesLines) {
        const here = lines.some((l) => (l.putBack ?? 0) + (l.alreadyCounted ?? 0) > 0);
        const there = lines.some((l) => (l.putBackThere ?? 0) > 0);
        if (!here && !there) return { label: 'Stock — nothing could go back', extra: who };
        if (there && !here) return { label: 'Stock put back on the till that sent it', extra: who };
      }
      return { label: 'Stock put back', extra: who };
    }
    case 'wasted': {
      const cost = status.hasCosts && status.wasteCents > 0 ? `about ${formatCents(status.wasteCents)}` : '';
      return { label: 'Food wasted', extra: [cost, who].filter(Boolean).join(' · ') };
    }
    case 'kept':
      return { label: 'Stock', extra: 'not put back (cancelled before this was asked)' };
    default:
      return null;
  }
}
