/**
 * Renders an order to a printable ESC/POS byte buffer. Pure function — given
 * the same snapshot + branding, you always get the same bytes.
 *
 * Layout (80mm / 48 cols):
 *
 *               [ shop logo ]
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
 *           Large (12")
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

import type { DrawerSettings, OrderSnapshot, PrinterWidth, ReceiptCopy } from '@cheeseoclock/shared-types';
import { isLeaveOutChoice } from '@cheeseoclock/shared-types';
import { EscPosBuilder, wrap, qrCode } from './escpos.js';
import {
  centreOnPaper,
  isPrintableLogo,
  isValidMonoRaster,
  logoBox,
  type MonoRaster,
} from './logo-raster.js';

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
  /**
   * Pulse the cash drawer at the end of the receipt. The till no longer uses
   * this: a cash payment sends the pulse as its own job, first, so the drawer
   * opens at once instead of after the logo, the FBR wait and the kitchen
   * ticket (see print-spooler.ts).
   */
  openDrawer?: boolean;
  /** Which pin and pulse length the drawer wants (default pin 2, 50 ms). */
  drawer?: DrawerSettings;
  /** Cut paper after printing — default true. Disable for a previewing/test print. */
  cutPaper?: boolean;
  /** FBR Digital Invoicing data once the worker has submitted. */
  fbr?: {
    irn: string;
    qrPayload?: string | null;
  };
  /**
   * 'shop' prints the same receipt with a SHOP COPY banner and a "Received by"
   * signature line, and leaves out the fiscal QR (the customer's copy carries
   * it). Default 'customer'.
   */
  copy?: ReceiptCopy;
  /**
   * Shop logo for the top, as made for this paper width. Skipped when
   * missing, malformed, blank, too dark or too big for this paper — the
   * receipt then prints exactly as it would without one.
   */
  logo?: MonoRaster | null;
}

/** Gap between the logo and the shop name (ESC J units: about 2 mm). */
export const LOGO_GAP_DOTS = 16;

/**
 * Put the logo on the page, centred across the full paper width. Never
 * throws: with a missing or unusable picture nothing is written and it
 * returns false, so a logo can never be the reason a print fails.
 *
 * Right after the picture the printer is reset (ESC @) and centring set
 * again. A printer that prints pictures has finished it by then; one that
 * can't read GS v 0 takes the picture bytes as text and commands, and the
 * reset stops those from turning the rest of the bill upside down, inverted
 * or oversized.
 */
export function appendLogo(
  b: EscPosBuilder,
  logo: MonoRaster | null | undefined,
  width: PrinterWidth,
): boolean {
  try {
    if (!logo || !isPrintableLogo(logo, width)) return false;
    const onPaper = centreOnPaper(logo, logoBox(width).maxWidth);
    if (!isValidMonoRaster(onPaper)) return false;
    b.align('center').rasterImage(onPaper).reset().align('center').feedDots(LOGO_GAP_DOTS);
    return true;
  } catch {
    return false;
  }
}

const MODE_LABEL: Record<OrderSnapshot['order']['mode'], string> = {
  dine_in: 'Dine-in',
  takeaway: 'Takeaway',
  delivery: 'Delivery',
  online: 'Online',
  foodpanda: 'Foodpanda',
};

const METHOD_LABEL: Record<string, string> = {
  cash: 'Cash',
  card: 'Card',
  easypaisa: 'EasyPaisa',
  jazzcash: 'JazzCash',
  bank_transfer: 'Bank Transfer',
  foodpanda: 'Foodpanda',
};

export function renderReceipt(
  snapshot: OrderSnapshot,
  opts: RenderReceiptOpts,
): Uint8Array {
  const width: PrinterWidth = opts.width ?? 48;
  const b = new EscPosBuilder(width);
  const { order, items, payments, discounts, cashierName, tableLabel } = snapshot;

  // Header — large, centered store name + tagline. Free text from settings,
  // so every line is word-wrapped here rather than broken by the printer at
  // the paper edge; double-size glyphs take two columns each. The logo (when
  // there is one) goes above the name on every copy — customer receipt, shop
  // copy, delivery bill, refund slip, reprint. Kitchen tickets never carry it.
  b.align('center');
  appendLogo(b, opts.logo, width);
  b.doubleSize(true).bold(true).wrappedText(opts.branding.storeName, width / 2);
  b.doubleSize(false).bold(false);
  if (opts.branding.storeTagline) b.wrappedText(opts.branding.storeTagline);
  if (opts.branding.branchLine) b.newline().wrappedText(opts.branding.branchLine);
  if (opts.branding.phoneLine) b.wrappedText(opts.branding.phoneLine);
  b.newline();

  const shopCopy = opts.copy === 'shop';
  if (shopCopy) {
    b.bold(true).doubleHeight(true).text('SHOP COPY').newline();
    b.bold(false).doubleHeight(false).newline();
  }

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
  if (snapshot.rider) {
    b.line(`Rider: ${snapshot.rider.name}`, snapshot.rider.phone);
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

  // Where the money stands. A bill that goes out with a delivery rider is
  // printed before any payment, so it must say what to collect; a settled
  // order says PAID so nobody asks twice.
  const settled = order.status === 'void' || order.status === 'refunded';
  if (!settled) {
    // Only money actually taken counts (refund rows are negative): after a
    // partial refund the net fell below the total and the slip — and every
    // reprint — read "TO PAY" the refunded amount, for a rider to collect
    // again (audit 2026-09-25). A paid order is paid.
    const paidCents = payments.reduce((sum, p) => sum + Math.max(0, p.amountCents), 0);
    const dueCents = order.paidAt ? 0 : order.totalCents - paidCents;
    if (dueCents > 0) {
      b.bold(true).doubleHeight(true).line('TO PAY', `Rs ${formatCentsForReceipt(dueCents)}`);
      b.bold(false).doubleHeight(false);
    } else if (payments.length > 0) {
      b.bold(true).text('PAID').newline().bold(false);
    }
  }
  b.newline();

  if (shopCopy) {
    // Room for the rider or customer to sign; the shop keeps this copy.
    b.text(`Received by: ${'_'.repeat(Math.max(8, width - 13))}`).newline();
    b.newline();
  }

  // Footer
  b.align('center');
  if (!shopCopy) {
    b.wrappedText(opts.branding.footerLine ?? 'Thank you — visit us again!');
    b.newline();
  }

  // FBR fiscal block (shown if the worker has resolved an IRN for this order).
  // The shop copy skips it: one fiscal QR per sale, on the customer's copy.
  if (shopCopy) {
    // nothing
  } else if (opts.fbr?.irn) {
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

  if (opts.openDrawer) b.openDrawer(opts.drawer);
  if (opts.cutPaper !== false) b.cut(true);

  return b.build();
}

export interface RenderKitchenTicketOpts {
  width?: PrinterWidth;
  /** Cut paper after printing — default true. */
  cutPaper?: boolean;
  /** Stamps the ticket REPRINT so the kitchen doesn't cook the order twice. */
  reprint?: boolean;
  /** Clock for the "printed at" time — injectable for tests. */
  now?: Date;
}

const MODE_SHOUT: Record<OrderSnapshot['order']['mode'], string> = {
  dine_in: 'DINE-IN',
  takeaway: 'TAKEAWAY',
  delivery: 'DELIVERY',
  online: 'ONLINE',
  foodpanda: 'FOODPANDA',
};

/**
 * The kitchen's copy: what to cook, big enough to read from the pass, and
 * nothing about money. Order number and mode in double size, one double-height
 * row per item with its modifiers and notes beneath, then any order notes and
 * — for deliveries — the address, so the bag can be matched to its rider.
 *
 * Layout (80mm / 48 cols):
 *
 *                    KITCHEN
 *                     #0042
 *                    DELIVERY
 *      14/09 19:35                     Ali Akbar
 *      Customer: Hamza              0300 9367865
 *      ----------------------------------------
 *      2 x Chicken Tikka Pizza Large (12")
 *          + Extra Cheese
 *          + No onions
 *          ** Extra crispy please
 *      1 x Coke 500ml
 *      ----------------------------------------
 *      Deliver to:
 *        House 12, Street 7, ...
 */
export function renderKitchenTicket(
  snapshot: OrderSnapshot,
  opts: RenderKitchenTicketOpts = {},
): Uint8Array {
  const width: PrinterWidth = opts.width ?? 48;
  const half = width / 2; // double-size glyphs take two columns each
  const b = new EscPosBuilder(width);
  const { order, items } = snapshot;

  b.align('center');
  b.bold(true).doubleSize(true).wrappedText('KITCHEN', half);
  if (opts.reprint) {
    b.doubleSize(false).doubleHeight(true).wrappedText('* REPRINT *', width);
  }
  const short = order.orderNumber.split('-').pop() ?? order.orderNumber;
  b.doubleSize(true).wrappedText(`#${short}`, half);
  b.doubleSize(false).doubleHeight(true).wrappedText(MODE_SHOUT[order.mode], width);
  b.doubleHeight(false).bold(false);

  b.align('left');
  const when = opts.now ?? new Date();
  b.line(formatTicketTime(when), snapshot.cashierName);
  if (snapshot.tableLabel) b.line(`Table: ${snapshot.tableLabel}`);
  if (snapshot.customerName || snapshot.customerPhone) {
    b.line(`Customer: ${snapshot.customerName ?? ''}`, snapshot.customerPhone ?? '');
  }
  b.rule();

  for (const it of items) {
    b.bold(true).doubleHeight(true);
    b.wrappedText(`${it.quantity} x ${it.menuItemName}`, width);
    b.bold(false).doubleHeight(false);
    // What to leave off comes first and loudest: "NO ONION" in bold capitals,
    // then the extras, then the line's allergy / special-request note — a
    // missed leave-out can put an allergic customer in hospital (2026-09-26).
    for (const mod of it.modifiers.filter((m) => isLeaveOutChoice(m.modifierName))) {
      b.bold(true);
      for (const ln of wrap(mod.modifierName.toUpperCase(), width - 4)) {
        b.text(`    ${ln}`).newline();
      }
      b.bold(false);
    }
    for (const mod of it.modifiers.filter((m) => !isLeaveOutChoice(m.modifierName))) {
      for (const ln of wrap(`+ ${mod.modifierName}`, width - 4)) {
        b.text(`    ${ln}`).newline();
      }
    }
    if (it.notes) {
      b.bold(true);
      for (const ln of wrap(`!! ALLERGY/NOTE: ${it.notes}`, width - 4)) {
        b.text(`    ${ln}`).newline();
      }
      b.bold(false);
    }
  }
  b.rule();

  if (order.notes) {
    b.bold(true);
    b.wrappedText(`Note: ${order.notes}`, width);
    b.bold(false);
  }
  if (snapshot.deliveryAddress) {
    b.text('Deliver to:').newline();
    for (const ln of wrap(snapshot.deliveryAddress, width - 2)) {
      b.text(`  ${ln}`).newline();
    }
  }
  b.newline();

  if (opts.cutPaper !== false) b.cut(true);
  return b.build();
}

/**
 * Just the cash-drawer pulse (ESC @ then ESC p) — what every cash payment,
 * cash refund, drawer cash in / out and the Open drawer button send, on its
 * own and ahead of any paper.
 */
export function renderDrawerKick(settings?: Partial<DrawerSettings> | null): Uint8Array {
  return new EscPosBuilder().openDrawer(settings).build();
}

// Helpers ---------------------------------------------------------------------

function formatTicketTime(d: Date): string {
  const day = String(d.getDate()).padStart(2, '0');
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${day}/${m} ${hh}:${mm}`;
}

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
