/**
 * Renders an order to a printable ESC/POS byte buffer. Pure function — given
 * the same snapshot + branding, you always get the same bytes.
 *
 * Layout (80mm / 48 cols):
 *
 *      CHEESE O CLOCK
 *      Pakistani Pizza · Cafe
 *
 *      Branch: F-10, Islamabad
 *      Phone: +92 ...
 *
 *      Order #20260525-0042   Dine-in T-3
 *      Cashier: Ali Akbar     2026-05-25 19:35
 *      ----------------------------------------
 *      1x Pepperoni Pizza               1,499.00
 *           Large (15")
 *           Stuffed Crust              + 200.00
 *           Extra Cheese               + 150.00
 *      ----------------------------------------
 *      Subtotal                         1,849.00
 *      Discount (Friend & family)         -200.00
 *      Tax (16%)                          263.84
 *      ========================================
 *      TOTAL                            1,912.84
 *      ----------------------------------------
 *      Cash                             2,000.00
 *      Change                              87.16
 *
 *           Thank you — visit us again!
 *
 *           [FBR QR placeholder]
 */

import type { OrderSnapshot, PrinterWidth } from '@cheeseoclock/shared-types';
import { EscPosBuilder, wrap, qrCode } from './escpos.js';

export interface ReceiptBranding {
  storeName: string;
  storeTagline?: string;
  branchLine?: string;
  phoneLine?: string;
  footerLine?: string;
}

export interface RenderReceiptOpts {
  width?: PrinterWidth;
  branding: ReceiptBranding;
  /** Open the cash drawer along with the receipt (typical for cash payment). */
  openDrawer?: boolean;
  /** Cut paper after printing — default true. Disable for a previewing/test print. */
  cutPaper?: boolean;
  /** FBR Digital Invoicing data once the worker has submitted. */
  fbr?: {
    irn: string;
    qrPayload?: string | null;
  };
}

const MODE_LABEL: Record<OrderSnapshot['order']['mode'], string> = {
  dine_in: 'Dine-in',
  takeaway: 'Takeaway',
  delivery: 'Delivery',
  online: 'Online',
};

const METHOD_LABEL: Record<string, string> = {
  cash: 'Cash',
  card: 'Card',
  easypaisa: 'EasyPaisa',
  jazzcash: 'JazzCash',
  bank_transfer: 'Bank Transfer',
};

export function renderReceipt(
  snapshot: OrderSnapshot,
  opts: RenderReceiptOpts,
): Uint8Array {
  const width: PrinterWidth = opts.width ?? 48;
  const b = new EscPosBuilder(width);
  const { order, items, payments, discounts, cashierName, tableLabel } = snapshot;

  // Header — large, centered store name + tagline
  b.align('center');
  b.doubleSize(true).bold(true).text(opts.branding.storeName).newline();
  b.doubleSize(false).bold(false);
  if (opts.branding.storeTagline) b.text(opts.branding.storeTagline).newline();
  if (opts.branding.branchLine) b.newline().text(opts.branding.branchLine).newline();
  if (opts.branding.phoneLine) b.text(opts.branding.phoneLine).newline();
  b.newline();

  // Order metadata block
  b.align('left');
  const orderTopRight = tableLabel
    ? `${MODE_LABEL[order.mode]} ${tableLabel}`
    : MODE_LABEL[order.mode];
  b.bold(true).line(`Order #${order.orderNumber}`, orderTopRight).bold(false);
  const dt = new Date(order.paidAt ?? order.createdAt);
  b.line(`Cashier: ${cashierName}`, formatDateTime(dt));

  // Customer / delivery block (only when present — snapshotted onto the order)
  if (snapshot.customerName || snapshot.customerPhone) {
    b.line(
      `Customer: ${snapshot.customerName ?? ''}`,
      snapshot.customerPhone ?? '',
    );
  }
  if (snapshot.deliveryAddress) {
    b.text('Deliver to:').newline();
    for (const ln of wrap(snapshot.deliveryAddress, width - 2)) {
      b.text(`  ${ln}`).newline();
    }
  }
  b.rule();

  // Items
  for (const it of items) {
    const qty = `${it.quantity}x`;
    const name = `${qty} ${it.menuItemName}`;
    const total = formatCentsForReceipt(it.lineTotalCents);

    // Item name may need wrapping if longer than width - total.length - 1.
    const maxNameWidth = width - total.length - 1;
    const wrapped = wrap(name, maxNameWidth);
    // First wrapped line shares the row with the total; subsequent lines just indent.
    if (wrapped.length === 0) wrapped.push(name);
    b.line(wrapped[0]!, total);
    for (let i = 1; i < wrapped.length; i++) {
      b.text(wrapped[i]!).newline();
    }
    // Modifiers
    for (const mod of it.modifiers) {
      const modName = `    ${mod.modifierName}`;
      if (mod.priceDeltaCents !== 0) {
        const sign = mod.priceDeltaCents > 0 ? '+' : '-';
        b.line(modName, `${sign} ${formatCentsForReceipt(Math.abs(mod.priceDeltaCents))}`);
      } else {
        b.text(modName).newline();
      }
    }
    // Per-line notes
    if (it.notes) {
      for (const line of wrap(`Note: ${it.notes}`, width - 4)) {
        b.text(`    ${line}`).newline();
      }
    }
  }

  b.rule();

  // Totals
  b.line('Subtotal', formatCentsForReceipt(order.subtotalCents));
  for (const d of discounts) {
    const tag = d.reason ? `Discount (${d.reason})` : 'Discount';
    b.line(tag, `- ${formatCentsForReceipt(d.amountCents)}`);
  }
  b.line('Tax', formatCentsForReceipt(order.taxCents));
  b.rule('=');
  b.bold(true).doubleHeight(true).line('TOTAL', `Rs ${formatCentsForReceipt(order.totalCents)}`);
  b.bold(false).doubleHeight(false);
  b.rule();

  // Payments
  for (const p of payments) {
    b.line(METHOD_LABEL[p.method] ?? p.method, formatCentsForReceipt(p.amountCents));
  }
  // Cash tendered + change (only if a cash payment with a tendered amount)
  const cash = payments.find((p) => p.method === 'cash' && p.tenderedCents != null);
  if (cash && cash.tenderedCents != null) {
    b.line('Tendered', formatCentsForReceipt(cash.tenderedCents));
    b.line('Change', formatCentsForReceipt(cash.tenderedCents - order.totalCents));
  }
  b.newline();

  // Footer
  b.align('center');
  b.text(opts.branding.footerLine ?? 'Thank you — visit us again!').newline();
  b.newline();

  // FBR fiscal block (shown if the worker has resolved an IRN for this order).
  if (opts.fbr?.irn) {
    b.rule();
    b.bold(true).text('FBR Digital Invoice').newline().bold(false);
    b.text(`IRN: ${opts.fbr.irn}`).newline();
    if (opts.fbr.qrPayload) {
      qrCode(b, opts.fbr.qrPayload, 6);
    }
  } else {
    b.text('[ FBR fiscal QR — pending ]').newline();
  }
  b.newline();

  if (opts.openDrawer) b.openDrawer();
  if (opts.cutPaper !== false) b.cut(true);

  return b.build();
}

// Helpers ---------------------------------------------------------------------

/** Format cents into "1,234.56" with thousands separators, no currency symbol. */
function formatCentsForReceipt(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const n = Math.abs(cents);
  const rupees = Math.floor(n / 100);
  const paisa = n % 100;
  const r = rupees.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${r}.${paisa.toString().padStart(2, '0')}`;
}

function formatDateTime(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
}
