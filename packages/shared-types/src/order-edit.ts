import type { OrderSnapshot } from './order.js';

/**
 * Edit order (v0.7.36; the owner, 2 Oct 2026: "same number, ADDED / REMOVED
 * kitchen slips, bill reprint; add = any cashier, remove = manager PIN"; the
 * user, 3 Oct 2026, with a discount on a sent order until it is paid and a
 * Free order). An order the kitchen already has is changed by a list of
 * these, worked out on the till first (orders:previewEdit, nothing written)
 * and saved in one step (orders:saveEdit).
 *
 * - add: a new line. `lineId` is made by the screen (a UUID v7) so the
 *   preview and the save give the line the same id, and later changes in the
 *   same edit can point at it.
 * - qty / remove: any line on the order; a line the kitchen already has
 *   that goes down or comes off needs a manager's PIN at Save.
 * - options: a line added in THIS edit only (a line the kitchen has is taken
 *   off and added again instead).
 * - discount / clearDiscount: the order's discount, until it is paid. `free`
 *   = a Free order: 100% off every line, value deals and delivery charge
 *   included, with a manager's PIN and a reason.
 */
export type OrderEditOp =
  | { op: 'add'; lineId: string; menuItemId: string; quantity: number; modifierIds: string[]; notes?: string | null }
  | { op: 'qty'; orderItemId: string; quantity: number }
  | { op: 'remove'; orderItemId: string }
  | { op: 'options'; orderItemId: string; modifierIds: string[]; notes: string | null }
  | { op: 'discount'; discountType: 'percent' | 'flat'; value: number; reason?: string | null; free?: boolean }
  | { op: 'clearDiscount' };

/** One line of an edit's kitchen slip: what was added or taken off. */
export interface OrderEditChangeLine {
  /** The order line it is about. */
  lineId: string;
  menuItemName: string;
  /** How many were added or taken off (not the line's new quantity). */
  quantity: number;
  /** Its choices as the kitchen reads them. */
  modifiers: string[];
  notes: string | null;
  /** A delivery charge: never on the kitchen slip. */
  fee: boolean;
}

/** What an edit changes, worked out from the order's lines before and after. */
export interface OrderEditDiff {
  added: OrderEditChangeLine[];
  removed: OrderEditChangeLine[];
  /** The discount was given, changed or taken off. */
  discountChanged: boolean;
  /** The order is a Free order after the edit, and was not before. */
  freeOrder: boolean;
  totalBeforeCents: number;
  totalAfterCents: number;
}

/** What Save will ask for before it writes anything. */
export interface OrderEditNeeds {
  /** A manager's PIN or password (typed even when one is signed in). */
  pin: boolean;
  /** Why, in words, one per reason. */
  why: string[];
  /** A reason must be given: something the kitchen has comes off, or a Free order. */
  reason: boolean;
}

/** orders:previewEdit — the order as the edit would leave it. Nothing is written. */
export interface OrderEditPreview {
  snapshot: OrderSnapshot;
  diff: OrderEditDiff;
  needs: OrderEditNeeds;
  /**
   * The order as the edit was worked on, as a key over its lines and its
   * discount (not its status: the kitchen moving it to Preparing or Ready
   * is no reason to start again). Save is refused if it no longer matches.
   */
  baseKey: string;
}

/** orders:saveEdit — the edit, the order it was worked on (baseKey), and Save's answers. */
export interface OrderEditSaveInput {
  orderId: string;
  baseKey: string;
  ops: OrderEditOp[];
  approverPin?: string;
  reason?: string | null;
  /** For each line the kitchen had that goes down or comes off (by line id): was that food made? */
  foodMade?: Record<string, 'made' | 'not_made'>;
}

/** orders:saveEdit's answer: the order as it is now, and what the edit changed (the kitchen slip's lines). */
export interface OrderEditSaved {
  snapshot: OrderSnapshot;
  diff: OrderEditDiff;
}

/** Why an order already sent can't be changed now (null in orderEditBlock: it can). */
export type OrderEditBlock = 'not_sent' | 'paid' | 'out' | 'closed' | 'foodpanda';
