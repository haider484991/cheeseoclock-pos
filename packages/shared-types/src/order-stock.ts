import type { OrderStatus } from './order.js';

/**
 * "Was the food made?" — what happens to the stock an order took when it is
 * cancelled or refunded in full. The answer is written into the stock ledger
 * against the order (apps/pos/electron/db/repositories/order-stock-repo.ts):
 *   not made → what was taken goes back on the shelf;
 *   made     → it stays off the shelf, booked as waste for that order.
 */
export type FoodMade = 'made' | 'not_made';

/** Which money action ended the order. */
export type OrderStockHow = 'cancelled' | 'refunded';

/**
 * Where an order's stock stands:
 *  - none:     it took no stock (never sent, or nothing on it has a recipe);
 *  - out:      it holds stock (on this till or the other) — cancelling asks the question;
 *  - returned: settled, and what could go back went back (here, or on the till that took it) —
 *              "not made", or "made" when only sealed drinks moved (see `answer`);
 *  - wasted:   settled, and the food was booked as waste (sealed drinks may have gone back);
 *  - kept:     cancelled before this question existed: the stock stayed out as a sale.
 */
export type OrderStockState = 'none' | 'out' | 'returned' | 'wasted' | 'kept';

/**
 * Why a line is special:
 *  - deleted:       the ingredient was deleted from Inventory, so nothing can go back into it;
 *  - unit_changed:  its unit changed in a way the till can't convert back;
 *  - counted_since: a stock take after the order was sent already counted it on the shelf;
 *  - other_till:    taken on the other till — what goes back goes on THAT till's count,
 *                   when the tills next sync (each till keeps its own count).
 */
export type OrderStockLineNote = 'deleted' | 'unit_changed' | 'counted_since' | 'other_till';

/** One ingredient an order holds (or held). Quantities are in the ingredient's unit NOW. */
export interface OrderStockLine {
  ingredientId: string;
  name: string;
  unit: string;
  /** How much the order holds (or held), positive. */
  qty: number;
  /** What `qty` cost when the order took it (a take from before costing: at today's price); 0 when no price is set (or not shown to this login). */
  estCostCents: number;
  /**
   * A sealed drink: on the Drinks shelf and counted in pieces (a bottle or a
   * can), so it can go back to the fridge even when the food was made. Tea,
   * coffee, juice or a shake mix is weighed or measured, so it is not.
   */
  drink: boolean;
  note: OrderStockLineNote | null;
  /** Once settled: put back on this till's shelf (the count went up). */
  putBack?: number;
  /** Once settled: put back, but a stock take had already counted it (the count stayed). */
  alreadyCounted?: number;
  /** Once settled: put back on the till that took it (that till's count goes up when the tills sync). */
  putBackThere?: number;
  /** Once settled: booked as waste. */
  wasted?: number;
  /** What `wasted` cost when the order took it. */
  wasteCents?: number;
}

/** How the question is put for one order (packages/pos-domain foodMadeQuestion). */
export interface FoodMadeQuestion {
  /**
   * 'choose': ask "Was the food made?" with two buttons.
   * 'made_only': the food left the shop — it can't go back on the shelf, so it counts as waste.
   */
  ask: 'choose' | 'made_only';
  /** Tapped for them (Made once cooking was marked); null means one tap is required. */
  preselect: FoodMade | null;
  /** Which way the facts lean — a hint only, never an answer. */
  lean: FoodMade | null;
  /** One short line: why ("'Start preparing' was tapped"). */
  hint: string;
}

/** `orders:stockStatus` — what cancelling this order would do to stock, or what it did. */
export interface OrderStockStatus {
  orderId: string;
  status: OrderStatus;
  state: OrderStockState;
  /** When the order took its stock (sent to the kitchen or paid up front). */
  takenAt: string | null;
  /** Held now ('out', 'kept'), or what was settled ('returned', 'wasted'). */
  lines: OrderStockLine[];
  /** Cost of `lines`, at what the order's take cost. */
  estCostCents: number;
  /** Some line has a price on file (otherwise leave the rupees out). */
  hasCosts: boolean;
  /** Only when state is 'out'. */
  question: FoodMadeQuestion | null;
  /**
   * 'not_printed': a kitchen ticket was queued but has not printed (a real
   * sign the kitchen may not have it); 'printed'; 'none': none was queued
   * here (no kitchen printer, or finished jobs already cleared).
   */
  kitchenTicket: 'printed' | 'not_printed' | 'none';
  /** Some of this order's stock rows were written on the other till. */
  otherTill: boolean;
  /** When it was settled, who did it, who approved (the order's cancel / refund approver). */
  settledAt: string | null;
  settledByName: string | null;
  approvedByName: string | null;
  /**
   * Of a settled order: the answer to "Was the food made?". Null before it was
   * asked. 'made' with state 'returned' means only sealed drinks moved (back in
   * the fridge).
   */
  answer: FoodMade | null;
  /** Of a settled order: what was booked as waste, at what the take cost. */
  wasteCents: number;
  /**
   * Ingredient lines left out because this login may not see stock or costs
   * (a counter login: no `menu.manage`). Sealed drinks stay in, for the
   * "Back in the fridge" buttons; costs are 0 and `hasCosts` false.
   */
  hiddenLines: number;
}

/** What a cancel or full refund did to stock (`orders:void` / `orders:refund` reply). */
export interface StockSettlement {
  outcome: FoodMade;
  /** 'staff': someone answered; 'forced': the food had left the shop, so it could only be waste. */
  answered: 'staff' | 'forced';
  how: OrderStockHow;
  statusBefore: OrderStatus;
  lines: OrderStockLine[];
  /** Booked as waste, at what the order's take cost (a take from before costing: today's prices). */
  wasteCents: number;
  /** Sealed drinks put back although the food was made. */
  drinksBack: number;
  /** Lines where something went back on a shelf (this till's, or the till that took it). */
  returnedLines: number;
  /** Lines booked as waste. */
  wastedLines: number;
  /** Lines that could not be booked (deleted from Inventory, or a unit the till can't convert). */
  skipped: number;
  hasCosts: boolean;
  /** As in OrderStockStatus: lines left out for a login that may not see stock or costs. */
  hiddenLines: number;
}
