import type { DiscountBaseRule } from './shop-settings.js';

/**
 * Vouchers (v0.7.48; the owner, 12 Oct 2026: "we are giving these vouchers
 * to abhi company … can you add it to pos system so we can track it"). A
 * client buys printed vouchers in bulk — "One Large pizza from the Regular
 * menu", No. 001–100, each with a code — and hands them out. At the till the
 * cashier types a voucher's number and code; the till checks it was never
 * used and takes one of the item off the bill, up to what the voucher covers.
 * Extras are paid as usual.
 *
 * Whether a voucher is used is read from the orders, never kept beside them
 * (migration 0056 order_discounts.voucher_id): a voucher is used while a
 * live discount row names it on an order that is not cancelled or deleted.
 * Cancel the order, delete it, or take the voucher off, and it is free again.
 */

/** The letters a made code is drawn from: no 0/O, 1/I, 2/Z, 5/S or 8/B, which read alike on paper. */
export const VOUCHER_CODE_LETTERS = 'ACDEFGHJKLMNPQRTUVWXY34679';

/** How long a made code is. A typed list may have codes of 3 to 12 letters. */
export const VOUCHER_CODE_LENGTH = 4;

/** The most vouchers one batch holds. */
export const VOUCHER_BATCH_MAX = 2000;

/** One client's vouchers (voucher_batches). */
export interface VoucherBatch {
  id: string;
  /** Who they are for ("abhi"): prints on the bill beside the voucher's number. */
  name: string;
  /** What one voucher gets ("One Large pizza from the Regular menu"): shown at the till. */
  gives: string;
  /** The most one voucher takes off (paisa): one of the item it is used on, never more. */
  coversCents: number;
  /** The last trading day it can be used (YYYY-MM-DD); null = no end. */
  goodUntil: string | null;
  createdAt: string;
  /** Who added them (the user's name now); null when not known. */
  createdByName: string | null;
}

/** A batch with how many of its vouchers are used (the Vouchers page's list). */
export interface VoucherBatchSummary extends VoucherBatch {
  count: number;
  /** On an order that is paid. */
  used: number;
  /** On an order still being rung up or not paid yet. */
  onOrder: number;
  notUsed: number;
  firstNumber: number | null;
  lastNumber: number | null;
}

/**
 * Where a voucher stands:
 *  - not_used: no live order carries it;
 *  - on_order: on an order not paid yet (still being rung up, or in the kitchen);
 *  - used: on a paid order.
 */
export type VoucherState = 'not_used' | 'on_order' | 'used';

/** An order a voucher is on: what the paper log's row said, read from the order. */
export interface VoucherUse {
  orderId: string;
  orderNumber: string;
  /** When the voucher went on the order. */
  at: string;
  paidAt: string | null;
  /** The order was refunded since (the voucher stays used). */
  refunded: boolean;
  /** What it was used on: the line's name and its choices ("Fajita Pizza — Large · Extra cheese"); null when the line is gone. */
  item: string | null;
  /** What it took off (paisa). */
  amountCents: number;
  /** Who put it on the order. */
  staffName: string | null;
  customerName: string | null;
  customerPhone: string | null;
}

/** One printed voucher and where it stands. */
export interface VoucherRow {
  id: string;
  number: number;
  code: string;
  state: VoucherState;
  /** The order it is on (the paid one first); null when not used. */
  use: VoucherUse | null;
  /**
   * Any OTHER live order it is on as well — only when the two tills both
   * took it while the link between them was down. Listed so it can be
   * checked; empty otherwise.
   */
  alsoOn: VoucherUse[];
}

export interface VoucherBatchDetail {
  batch: VoucherBatchSummary;
  vouchers: VoucherRow[];
}

/** A number and code as printed on a voucher. */
export interface VoucherNumberAndCode {
  number: number;
  code: string;
}

/** vouchers:addBatch — the batch, and its vouchers as typed (a list) or made by the till. */
export type AddVoucherBatchRequest = {
  name: string;
  gives: string;
  coversCents: number;
  goodUntil: string | null;
} & (
  | { from: 'list'; vouchers: VoucherNumberAndCode[] }
  | { from: 'make'; count: number; firstNumber: number }
);

/** vouchers:updateBatch — its words, what it covers and its last day. The vouchers stay as printed. */
export interface UpdateVoucherBatchRequest {
  id: string;
  name: string;
  gives: string;
  coversCents: number;
  goodUntil: string | null;
}

/** Why a voucher can't be used now. */
export type VoucherProblem = 'not_found' | 'used' | 'on_order' | 'on_this_order' | 'ended';

/** vouchers:check — what the till says about a typed number and code. */
export type VoucherCheck =
  | {
      ok: true;
      voucherId: string;
      number: number;
      code: string;
      batch: VoucherBatch;
    }
  | {
      ok: false;
      problem: VoucherProblem;
      /** In plain words, for the cashier. */
      message: string;
      /** The order it is on, for used / on_order. */
      use?: VoucherUse;
    };

/**
 * A voucher's terms as they were when it went on an order, FROZEN on its
 * discount row. Every cart change works its rupees out of THESE (one of the
 * line's items, up to `coversCents`), never the live batch.
 */
export interface VoucherTerms {
  v: 1;
  id: string;
  batchId: string;
  number: number;
  /** The batch's name then ("abhi"). */
  batchName: string;
  gives: string;
  coversCents: number;
  /**
   * The order line (order_items id) it is for. The line taken off: the
   * dearest line it can still come off takes it (the customer swapped the
   * flavour); none left, the voucher comes off the order.
   */
  lineId: string;
}

/**
 * A voucher frozen on its discount row (order_discounts.rule_json, source
 * 'voucher'). It IS a till discount rule (kind 'discount_base', from
 * 'till', the food only, never a value deal), carrying the voucher's terms
 * in `voucher`. So a till that knows the rule but not vouchers still splits
 * it over the food for the tax, the FBR invoice and profit — the row's flat
 * value is kept equal to what it takes off, so it works out the same rupees.
 */
export interface VoucherRule extends DiscountBaseRule {
  from: 'till';
  voucher: VoucherTerms;
}

/** A voucher on the order snapshot (cart, Pay, the bill, the order drawer). */
export interface VoucherShare {
  id: string;
  batchId: string;
  number: number;
  batchName: string;
  gives: string;
  coversCents: number;
  lineId: string;
}

/** vouchers:check's request: a number and code as typed, and the order being rung up (to say "already on this order"). */
export interface CheckVoucherRequest {
  number: number;
  code: string;
  orderId?: string | null;
}

/** orders:applyVoucher's request: the voucher as typed, and the line it is for. */
export interface ApplyVoucherRequest {
  orderId: string;
  number: number;
  code: string;
  lineId: string;
}
