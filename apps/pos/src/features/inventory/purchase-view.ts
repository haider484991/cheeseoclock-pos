/**
 * How the purchase screens say a bill (costing spec Phase 5, D1, D15: plain
 * words, few numbers): what a line of a bill works out to per kg / piece,
 * and D1's question when it is far from the usual price — "25% dearer than
 * usual (Rs 150 / kg). Use Rs 187.50 / kg as the new price?". The same
 * pure guard the main process runs (pos-domain checkBillPrice), so what the
 * screen asks is what the till does. Pure, so the words and the arithmetic
 * are tested.
 */
import {
  billPack,
  checkBillPrice,
  effectivePack,
  formatCents,
  formatQty,
  orderedPack,
  thousandSize,
  unitCostMc,
  usualPackSize,
  type PriceCheck,
} from '@cheeseoclock/pos-domain';
import type { Ingredient, PurchaseKind, PurchaseOrder, PurchaseOrderItem } from '@cheeseoclock/shared-types';
import { formatBps, formatUnitPrice, parseRupees, readAmount, thousandUnit } from '../costing/costingFormat';

/** "Rs 187.50 / kg" for a bill of `billCents` for `qty` base units. */
export function billUnitText(qty: number, billCents: number, unit: string): string {
  return formatUnitPrice(unitCostMc(billPack(qty, billCents)), unit);
}

/** A purchase order line's ordered price, as bought: "Rs 375 / kg", "Rs 2,250 for 6,000 g", "Rs 40 / pcs". */
export function orderedPriceText(item: Pick<PurchaseOrderItem, 'orderedPackSize' | 'orderedPackPriceCents' | 'unitCostCents'>, unit: string): string {
  const pack = orderedPack(item);
  if (pack.size > 1 && pack.size !== thousandSize(unit)) {
    return `${formatCents(pack.priceCents)} for ${new Intl.NumberFormat('en-PK').format(pack.size)} ${unit}`;
  }
  return formatUnitPrice(unitCostMc(pack), unit);
}

/** The price costing uses for an ingredient now, as D1's guard reads it. */
export function currentPriceOf(i: Pick<Ingredient, 'costPerUnitCents' | 'packSize' | 'packPriceCents' | 'priceKind' | 'priceFromRecipe'>) {
  return { pack: effectivePack(i), kind: i.priceKind, madeHere: i.priceFromRecipe === true };
}

/** D1's guard for one line of a bill (null until the line can be read). */
export function lineCheck(
  i: Pick<Ingredient, 'unit' | 'costPerUnitCents' | 'packSize' | 'packPriceCents' | 'priceKind' | 'priceFromRecipe'>,
  qty: number | null,
  billCents: number | null,
  kind: PurchaseKind,
): PriceCheck | null {
  if (qty === null || qty < 1 || billCents === null || billCents < 0) return null;
  return checkBillPrice({ kind, current: currentPriceOf(i), usualSize: usualPackSize(i), qty, billCents });
}

const pct = (bps: number) => formatBps(Math.abs(bps));

export interface LineWords {
  /** "Rs 187.50 / kg" */
  price: string;
  /** What happens to the ingredient's price, or the question. */
  note: string;
  /** The screen asks: "Use it as the new price?" (with the default answer picked). */
  ask: boolean;
  /** Amber when the bill is far from the usual price. */
  warn: boolean;
}

/**
 * What the screen says under a line of a bill (D15: plain words): the price
 * it works out to, and what happens to the ingredient's price — used,
 * kept, or the question D1 asks.
 */
export function lineWords(check: PriceCheck, qty: number, billCents: number, unit: string): LineWords {
  const price = billUnitText(qty, billCents, unit);
  const usual = check.currentUnitMc === null ? null : formatUnitPrice(check.currentUnitMc, unit);
  switch (check.why) {
    case 'same':
      return { price, note: 'The usual price.', ask: false, warn: false };
    case 'no_price':
      return { price, note: `No price yet: ${price} becomes its price.`, ask: false, warn: false };
    case 'within':
      return { price, note: `Close to the usual ${usual}: the price becomes ${price}.`, ask: false, warn: false };
    case 'higher':
    case 'lower':
      return {
        price,
        note: `${pct(check.changeBps ?? 0)} ${check.why === 'higher' ? 'dearer' : 'cheaper'} than usual (${usual}). Use ${price} as the new price?`,
        ask: true,
        warn: true,
      };
    case 'was_free':
      return { price, note: `It was marked free. Use ${price} as its price?`, ask: true, warn: true };
    case 'guess':
      return check.ask
        ? { price, note: `Its price was a guess (${usual}). Use this bill's ${price}?`, ask: true, warn: true }
        : { price, note: `Its price was a guess: the price becomes ${price}.`, ask: false, warn: false };
    case 'made_here':
      return { price, note: 'Made here: its price comes from its batch recipe, not a bill.', ask: false, warn: false };
    case 'zero_bill':
      return { price, note: 'Rs 0: the stock comes in, the price stays as it is.', ask: false, warn: false };
    default:
      return { price, note: '', ask: false, warn: false };
  }
}

/** An amount of stock as typed: "5 kg", "5000", "2.5kg", "12" (whole base units; null when not usable). */
export function readQty(text: string, unit: string): number | null {
  const r = readAmount(text, false, unit);
  return r.ok ? r.amount : null;
}

/** An amount box on Receive or "Record a purchase", as read. */
export interface BoughtQty {
  /** Whole base units; null while it can't be used. */
  qty: number | null;
  /** "= 5 kg": what was read, shown under the box so a slip is seen before it is booked. */
  shows: string | null;
  /** Why it can't be used yet, in plain words; null when empty or fine. */
  problem: string | null;
}

/**
 * An amount of stock typed on a purchase screen (Receive, "Record a
 * purchase"). Like readQty, with one more rule for something weighed or
 * poured: a number alone under 1,000 is not taken as grams (or ml) — "5"
 * under a "5 kg" hint is far more likely 5 kg than 5 g, and booking 5 g
 * would leave the stock short and the bill's price absurd. It asks for the
 * unit instead. A number of 1,000 or more ("5000") is grams, as always.
 */
export function readBoughtQty(text: string, unit: string): BoughtQty {
  const t = text.trim();
  if (t === '') return { qty: null, shows: null, problem: null };
  const big = thousandUnit(unit);
  const r = readAmount(t, false, unit);
  if (!r.ok) {
    return { qty: null, shows: null, problem: big ? `Type it like 5 ${big} or 500 ${unit}.` : `Type a whole number, like 12 ${unit}.` };
  }
  if (big && /^[\d,]+$/.test(t) && r.amount < 1_000) {
    return { qty: null, shows: null, problem: `${r.amount} ${unit} or ${r.amount} ${big}? Type the unit.` };
  }
  // Exactly what will be booked: "5 kg", "2.5 kg", else in grams ("1,234 g": never rounded to "1.23 kg").
  const exact = big && r.amount >= 1_000 && r.amount % 10 === 0 ? formatQty(r.amount, unit) : `${new Intl.NumberFormat('en-PK').format(r.amount)} ${unit}`;
  return { qty: r.amount, shows: `= ${exact}`, problem: null };
}

/**
 * What the Purchases list shows as a purchase's total: for a purchase order
 * that something came in on, what its bills came to (the figure owed), with
 * what was ordered beside it; before anything comes in, what was ordered; a
 * purchase on the spot, what was paid.
 */
export function purchaseTotalText(po: Pick<PurchaseOrder, 'kind' | 'status' | 'totalCents' | 'billedCents'>): { main: string; note: string | null } {
  if (po.kind === 'quick') return { main: formatCents(po.totalCents), note: null };
  const cameIn = po.status === 'partial' || po.status === 'received' || po.billedCents > 0;
  if (!cameIn) return { main: formatCents(po.totalCents), note: null };
  return {
    main: formatCents(po.billedCents),
    note: po.billedCents === po.totalCents && po.status === 'received' ? 'billed' : `billed · ordered ${formatCents(po.totalCents)}`,
  };
}

/**
 * The Purchases list: the newest purchases (capped) and every order still
 * open, whatever its age, fetched on their own so one never drops off the
 * list. Newest first: the open ones missing from the newest are older than
 * all of them, so they go after, in their own order.
 */
export function mergePurchaseLists<T extends { id: string }>(newest: readonly T[], open: readonly T[]): T[] {
  const seen = new Set(newest.map((p) => p.id));
  return [...newest, ...open.filter((p) => !seen.has(p.id))];
}

/** Rupees as typed on a bill ("1,250" or "1250.50"), as paisa; null when not a price. Rs 0 is allowed. */
export function readBill(text: string): number | null {
  return parseRupees(text);
}

/** "Rs 3,000 was taken from the drawer; these lines come to Rs 2,800 (Rs 200 not on an ingredient)." */
export function payoutMatchText(payoutCents: number, linesCents: number): string | null {
  if (linesCents === payoutCents) return null;
  if (linesCents < payoutCents) {
    return `The payout was ${formatCents(payoutCents)}; these lines come to ${formatCents(linesCents)} (${formatCents(payoutCents - linesCents)} not on an ingredient). The drawer's figures stay as they are.`;
  }
  return `These lines come to ${formatCents(linesCents)}, more than the ${formatCents(payoutCents)} taken from the drawer. The drawer's figures stay as they are.`;
}
