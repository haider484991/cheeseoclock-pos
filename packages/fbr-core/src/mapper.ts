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
    // The order_item carries the snapshotted tax-rate basis points.
    // We can reach back into the item snapshot for that — for now we approximate
    // from the order totals so this mapper stays pure-snapshot.
    // tax-bearing portion = netCents / (1 + rate). FBR wants the exclusive value.
    // But we don't have per-line rate in the snapshot shape, so we approximate
    // each line at the average effective rate of the order:
    const overallNet = Math.max(0, subtotal - discount);
    const effectiveRate = overallNet > 0 ? order.taxCents / overallNet : 0;
    const lineTaxCents = Math.round(netCents * effectiveRate);

    return {
      hsCode: opts.defaultHsCode,
      productDescription: line.menuItemName,
      rate: formatPercent(effectiveRate),
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
    invoiceDate: (order.paidAt ?? order.createdAt).slice(0, 10), // YYYY-MM-DD
    sellerNTNCNIC: seller.sellerNTNCNIC,
    sellerBusinessName: seller.sellerBusinessName,
    sellerProvince: seller.sellerProvince,
    sellerAddress: seller.sellerAddress,
    buyerRegistrationType: 'Unregistered',
    invoiceRefNo: order.orderNumber,
    items: fbrItems,
  };
}

function rupeesFromCents(cents: number): number {
  return Math.round(cents) / 100;
}

function formatPercent(fraction: number): string {
  const pct = Math.round(fraction * 10000) / 100;
  return `${pct}%`;
}
