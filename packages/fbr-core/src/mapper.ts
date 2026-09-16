/**
 * Map an internal OrderSnapshot to an FBR PRAL invoice payload.
 *
 * The trickiest piece is per-line tax + discount split, because FBR expects
 * each line item to carry its `valueSalesExcludingST` and `salesTaxApplicable`.
 * We mirror what `recomputeOrderTotals` does on the write path: prorate any
 * order-level discount across lines by line-total weight, then compute the
 * line's net (after-discount) and tax exactly the same way.
 */

import type { OrderSnapshot } from '@cheeseoclock/shared-types';
import type { FbrInvoicePayload, FbrInvoiceItem } from './index.js';

export interface FbrSellerInfo {
  sellerNTNCNIC: string;
  sellerBusinessName: string;
  sellerProvince: string;
  sellerAddress: string;
}

export interface FbrMapOptions {
  /** Default HS / PCT code applied when an item doesn't have its own. */
  defaultHsCode: string;
  /** Default sale type, e.g. 'Goods at standard rate (default)'. */
  defaultSaleType: string;
  /** Default unit of measure for food items. */
  defaultUoM: string;
}

export const DEFAULT_FBR_MAP_OPTS: FbrMapOptions = {
  defaultHsCode: '2106.9090', // 'Food preparations not elsewhere specified' — closest catch-all for prepared meals
  defaultSaleType: 'Goods at standard rate (default)',
  defaultUoM: 'Each',
};

export function mapOrderToFbrPayload(
  snapshot: OrderSnapshot,
  seller: FbrSellerInfo,
  opts: FbrMapOptions = DEFAULT_FBR_MAP_OPTS,
): FbrInvoicePayload {
  const { order, items } = snapshot;
  const subtotal = order.subtotalCents;
  const discount = order.discountCents;

  const fbrItems: FbrInvoiceItem[] = items.map((line) => {
    // Prorate discount across lines by weight.
    const weight = subtotal > 0 ? line.lineTotalCents / subtotal : 0;
    const lineDiscount = Math.round(discount * weight);
    const netCents = Math.max(0, line.lineTotalCents - lineDiscount);
    // Each line carries the tax rate snapshotted at order time (basis
    // points). FBR validates `rate` against its reference list per line, so a
    // blended order-average rate (16% pizza + 13% drink = "15.61%") is
    // rejected outright. Fall back to the order-average only for legacy
    // snapshots that predate the field.
    const lineRateBps =
      line.taxRateBps ?? Math.round((order.taxCents / Math.max(1, subtotal - discount)) * 10_000);
    const lineTaxCents = Math.round((netCents * lineRateBps) / 10_000);

    return {
      hsCode: opts.defaultHsCode,
      productDescription: line.menuItemName,
      rate: formatPercent(lineRateBps / 10_000),
      uoM: opts.defaultUoM,
      quantity: line.quantity,
      totalValues: rupeesFromCents(netCents + lineTaxCents),
      valueSalesExcludingST: rupeesFromCents(netCents),
      fixedNotifiedValueOrRetailPrice: rupeesFromCents(line.unitPriceCents),
      salesTaxApplicable: rupeesFromCents(lineTaxCents),
      salesTaxWithheldAtSource: 0,
      saleType: opts.defaultSaleType,
      ...(lineDiscount > 0 ? { discount: rupeesFromCents(lineDiscount) } : {}),
    };
  });

  return {
    invoiceType: 'Sale Invoice',
    invoiceDate: karachiDate(order.paidAt ?? order.createdAt), // YYYY-MM-DD in Asia/Karachi
    sellerNTNCNIC: seller.sellerNTNCNIC,
    sellerBusinessName: seller.sellerBusinessName,
    sellerProvince: seller.sellerProvince,
    sellerAddress: seller.sellerAddress,
    buyerRegistrationType: 'Unregistered',
    invoiceRefNo: order.orderNumber,
    items: fbrItems,
  };
}

/**
 * Calendar date of an instant in Asia/Karachi (UTC+5, no DST). Timestamps are
 * stored in UTC, so a sale at 01:30 local would otherwise be reported on the
 * previous day and the daily FBR totals would never match the shop's day.
 */
export function karachiDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso.slice(0, 10);
  return new Date(ms + 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * A refund reaches FBR as a Debit Note that references the original sale
 * invoice (`invoiceRefNo` = the IRN FBR returned for the sale). A full refund
 * mirrors the sale line for line; a partial refund is spread across the lines
 * by their weight in the order so each line keeps its own tax rate.
 *
 * ⚠ Field semantics for debit notes were taken from the DI spec as understood
 * here and have NOT been validated against the PRAL sandbox — run one through
 * sandbox mode before switching to production.
 */
export function mapRefundToFbrDebitNote(
  snapshot: OrderSnapshot,
  seller: FbrSellerInfo,
  refund: {
    /** IRN of the accepted sale invoice this note reverses. */
    originalIrn: string;
    /** Gross amount refunded (tax-inclusive), in cents. */
    refundedCents: number;
    /** When the refund was recorded (ISO, UTC). */
    refundedAt: string;
  },
  opts: FbrMapOptions = DEFAULT_FBR_MAP_OPTS,
): FbrInvoicePayload {
  const sale = mapOrderToFbrPayload(snapshot, seller, opts);
  const grossCents = Math.max(0, snapshot.order.totalCents);
  const full = refund.refundedCents >= grossCents;
  // Fraction of the order being reversed; a full refund is exactly 1.
  const share = full || grossCents === 0 ? 1 : refund.refundedCents / grossCents;

  const items: FbrInvoiceItem[] = sale.items.map((line) => {
    const net = Math.round(line.valueSalesExcludingST * share * 100) / 100;
    const tax = Math.round(line.salesTaxApplicable * share * 100) / 100;
    return {
      ...line,
      productDescription: full ? line.productDescription : `Refund: ${line.productDescription}`,
      quantity: full ? line.quantity : 1,
      fixedNotifiedValueOrRetailPrice: full ? line.fixedNotifiedValueOrRetailPrice : net,
      valueSalesExcludingST: net,
      salesTaxApplicable: tax,
      totalValues: Math.round((net + tax) * 100) / 100,
      ...(line.discount !== undefined && !full ? { discount: Math.round(line.discount * share * 100) / 100 } : {}),
    };
  });

  return {
    ...sale,
    invoiceType: 'Debit Note',
    invoiceDate: karachiDate(refund.refundedAt),
    invoiceRefNo: refund.originalIrn,
    items,
  };
}

function rupeesFromCents(cents: number): number {
  return Math.round(cents) / 100;
}

function formatPercent(fraction: number): string {
  const pct = Math.round(fraction * 10000) / 100;
  return `${pct}%`;
}
