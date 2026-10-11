/**
 * Tax by how the customer pays, one rate for each way of paying (0.7.45; the
 * owner, 12 Oct 2026: "add settings to set percentage tax on jazz cash or any
 * payment method"). 0052 gave a tax category two rates: its rate (cash) and
 * one card rate for card, the wallets and bank transfer alike. Each of those
 * can now have its own:
 *
 *   tax_categories.digital_rate_bps    the card rate — and the rate of every
 *                                      other way but cash that has none of
 *                                      its own, exactly as before;
 *   tax_categories.method_rates_json   the ways whose rate differs from the
 *                                      card rate: {"jazzcash": 1500}. NULL =
 *                                      none (every category before 0.7.45).
 *
 * A line freezes both when it is added (digital_rate_bps_snapshot,
 * method_rates_snapshot_json), and an order stores its bill by each way of
 * paying beside its total: digital_total_cents at the card rates, as before,
 * and method_totals_json for the ways whose bill differs from that one.
 *
 * Pure, with no other package: the till, the receipts and the FBR invoice
 * read a rate and a bill by the same few lines here.
 */
import type { PaymentMethod } from './order.js';

/** The ways of paying that may carry their own rate: every one but cash (and foodpanda, which settles its own orders). */
export const RATED_PAYMENT_METHODS = ['card', 'easypaisa', 'jazzcash', 'bank_transfer'] as const;
export type RatedPaymentMethod = (typeof RATED_PAYMENT_METHODS)[number];

/** How the tax forms and the bill name each of them. */
export const RATED_METHOD_LABEL: Readonly<Record<RatedPaymentMethod, string>> = Object.freeze({
  card: 'Card',
  easypaisa: 'EasyPaisa',
  jazzcash: 'JazzCash',
  bank_transfer: 'Bank transfer',
});

/** The rates (basis points) of the ways of paying whose rate differs from the card rate. */
export type MethodRatesBps = Partial<Record<RatedPaymentMethod, number>>;

/** The bill (paisa) if paid entirely one way, for the ways whose bill differs from the bill by card. */
export type MethodTotalsCents = Partial<Record<RatedPaymentMethod, number>>;

export function isRatedPaymentMethod(method: string): method is RatedPaymentMethod {
  return (RATED_PAYMENT_METHODS as ReadonlyArray<string>).includes(method);
}

/** A tax category's rates, or a line's as it froze them. */
export interface RatesByMethod {
  /** The rate (cash). */
  rateBps: number;
  /** The card rate, and every other way's that has none of its own; null / absent = the rate. */
  digitalRateBps?: number | null;
  /** The ways with a rate of their own; null / absent = none. */
  methodRatesBps?: MethodRatesBps | null;
}

/**
 * The rate charged when the bill is paid `method`: cash (and foodpanda) the
 * rate; a card, a wallet or a bank transfer its own rate, else the card
 * rate, else the rate.
 */
export function rateByMethod(r: RatesByMethod, method: PaymentMethod | string): number {
  if (!isRatedPaymentMethod(method)) return r.rateBps;
  const own = r.methodRatesBps?.[method];
  if (typeof own === 'number') return own;
  return typeof r.digitalRateBps === 'number' ? r.digitalRateBps : r.rateBps;
}

/** Whole basis points, 0% to 100%. */
function isRate(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000;
}

/** Whole paisa, zero or more. */
function isCents(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** Only the ways of paying (in their own order) whose value passes `ok`; null when none does. */
function pick(raw: unknown, ok: (v: unknown) => v is number): Partial<Record<RatedPaymentMethod, number>> | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Partial<Record<RatedPaymentMethod, number>> = {};
  for (const m of RATED_PAYMENT_METHODS) {
    const v = (raw as Record<string, unknown>)[m];
    if (ok(v)) out[m] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * A stored method_rates_json read back: the ways of paying with a whole rate
 * from 0% to 100%, in their own order. Anything else in it (a way this till
 * does not know, a rate that is not one) is left out, and text that is not
 * JSON reads as none: those ways then pay the card rate, as before 0.7.45.
 */
export function parseMethodRates(json: string | null | undefined): MethodRatesBps | null {
  if (typeof json !== 'string' || json === '') return null;
  try {
    return pick(JSON.parse(json), isRate);
  } catch {
    return null;
  }
}

/** A stored method_totals_json read back, the same way (whole paisa, zero or more). */
export function parseMethodTotals(json: string | null | undefined): MethodTotalsCents | null {
  if (typeof json !== 'string' || json === '') return null;
  try {
    return pick(JSON.parse(json), isCents);
  } catch {
    return null;
  }
}

/** What method_rates_json / method_totals_json stores: the ways in their own order, or NULL for none. */
export function methodMapJson(map: Partial<Record<RatedPaymentMethod, number>> | null | undefined): string | null {
  if (!map) return null;
  const out: Partial<Record<RatedPaymentMethod, number>> = {};
  for (const m of RATED_PAYMENT_METHODS) {
    const v = map[m];
    if (typeof v === 'number') out[m] = v;
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out) : null;
}

/**
 * The ways of paying with a rate of their own, as a tax category stores
 * them: each one's rate in `wanted` that differs from the card rate (the
 * rate when there is none) — the card's own is the card rate, never stored
 * here. Null when none differs, so a category whose ways all pay the card
 * rate is stored exactly as before 0.7.45.
 */
export function cleanMethodRates(
  wanted: MethodRatesBps | null | undefined,
  rates: { rateBps: number; digitalRateBps?: number | null },
): MethodRatesBps | null {
  if (!wanted) return null;
  const card = typeof rates.digitalRateBps === 'number' ? rates.digitalRateBps : rates.rateBps;
  const out: MethodRatesBps = {};
  for (const m of RATED_PAYMENT_METHODS) {
    if (m === 'card') continue;
    const v = wanted[m];
    if (v === undefined || v === null) continue;
    if (!isRate(v)) throw new Error('A payment method’s tax rate is a whole number of basis points between 0 and 10000');
    if (v !== card) out[m] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** The figures of an order's bill that depend on how it is paid. */
export interface BillByMethod {
  /** The stored total: the bill at the cash rates (before it is paid). */
  totalCents: number;
  /** The bill paid entirely by card (orders.digital_total_cents); null = the total. */
  digitalTotalCents?: number | null;
  /** The ways whose bill differs from the bill by card (orders.method_totals_json); null = none. */
  methodTotalsCents?: MethodTotalsCents | null;
}

/**
 * The bill if it is paid entirely `method`: cash (and foodpanda) the total;
 * a card, a wallet or a bank transfer its own bill, else the bill by card,
 * else the total.
 */
export function billByMethod(order: BillByMethod, method: PaymentMethod | string): number {
  if (!isRatedPaymentMethod(method)) return order.totalCents;
  const own = order.methodTotalsCents?.[method];
  if (typeof own === 'number') return own;
  return typeof order.digitalTotalCents === 'number' ? order.digitalTotalCents : order.totalCents;
}

/**
 * Is a part paid `method` taxed at a rate of its own (the card part of the
 * bill, as the receipt and Reports put it)? Yes for a way with a bill of its
 * own that is not the total, and — as since 0052 — for any way that pays the
 * bill by card when the order has one. Never for cash.
 */
export function paysOwnRate(order: BillByMethod, method: PaymentMethod | string): boolean {
  if (!isRatedPaymentMethod(method)) return false;
  const own = order.methodTotalsCents?.[method];
  if (typeof own === 'number') return own !== order.totalCents;
  return typeof order.digitalTotalCents === 'number';
}

/** Does the bill depend on how it is paid: is any way's bill not the total? */
export function billDependsOnMethod(order: BillByMethod): boolean {
  return RATED_PAYMENT_METHODS.some((m) => billByMethod(order, m) !== order.totalCents);
}

/**
 * The ways of paying grouped by what the bill comes to that way, for the
 * ways whose bill is not the total ("By card / EasyPaisa Rs 1,080"), in the
 * ways' own order. Empty when the bill is the same however it is paid.
 */
export function billsByMethod(order: BillByMethod): Array<{ methods: RatedPaymentMethod[]; totalCents: number }> {
  const out: Array<{ methods: RatedPaymentMethod[]; totalCents: number }> = [];
  for (const m of RATED_PAYMENT_METHODS) {
    const t = billByMethod(order, m);
    if (t === order.totalCents) continue;
    const same = out.find((g) => g.totalCents === t);
    if (same) same.methods.push(m);
    else out.push({ methods: [m], totalCents: t });
  }
  return out;
}
