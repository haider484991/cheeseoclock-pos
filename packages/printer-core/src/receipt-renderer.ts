/**
 * Renders an order to a printable ESC/POS byte buffer. Pure function — given
 * the same snapshot + branding, you always get the same bytes.
 *
 * Layout (80mm / 48 cols):
 *
 *      ****************************************   <- only on a DUPLICATE
 *                    DUPLICATE
 *      Reprint #1 | 25/05/2026 19:52 | by Sana
 *      Original: 25/05/2026 19:35
 *      ****************************************
 *               [ shop logo ]         <- or CHEESE O CLOCK, big, when no
 *      Pakistani Pizza · Cafe            logo prints (never both)
 *
 *                  RECEIPT            <- or BILL - NOT PAID / REFUND /
 *                 DUPLICATE              CANCELLED ORDER
 *
 *      Order #20260525-0042   Dine-in T-3
 *      Cashier: Ali Akbar     25/05/2026 19:35
 *      ----------------------------------------
 *      1x Pepperoni Pizza               1,499.00
 *           Large (12")
 *           Stuffed Crust              + 200.00
 *           Extra Cheese               + 150.00
 *      ----------------------------------------
 *      Subtotal                         1,849.00
 *      Discount (Friend & family)         -200.00
 *      Tax (16%)                          263.84
 *      ============= DUPLICATE ================
 *      TOTAL                            1,912.84
 *      ----------------------------------------
 *      Cash                             2,000.00
 *      Tendered                         2,000.00
 *      Change                              87.16
 *
 *      PAID - CASH (DUPLICATE)
 *
 *            F-10, Islamabad          <- the shop's address, phone and
 *            +92 ...                     website: at the bottom, on every
 *            cheeseoclock.net            paper (owner 2026-09-27)
 *           Thank you — visit us again!
 *
 *           FBR block (live FBR only)
 *        ** DUPLICATE - Reprint #1 **
 */

import type { DrawerSettings, OrderSnapshot, PrinterWidth, ReceiptCopy } from '@cheeseoclock/shared-types';
import { discountBillLabel, isLeaveOutChoice, orderNotesOf } from '@cheeseoclock/shared-types';
import { EscPosBuilder, wrap, qrCode, toPrinterAscii } from './escpos.js';
import {
  centreOnPaper,
  isPrintableLogo,
  isValidMonoRaster,
  logoBox,
  type MonoRaster,
} from './logo-raster.js';

export interface ReceiptBranding {
  /** Printed big at the top only when no logo prints: a paper is never nameless. */
  storeName: string;
  /** Under the logo (or the name). */
  storeTagline?: string;
  /** The address: at the bottom. */
  branchLine?: string;
  /** At the bottom, under the address. */
  phoneLine?: string;
  /** The shop's website ("cheeseoclock.net"): at the bottom, under the phone. */
  websiteLine?: string;
  /** The thank-you line, under the website (a receipt or bill for the customer only). */
  footerLine?: string;
}

/** The thank-you line when the shop set none. */
export const DEFAULT_FOOTER_LINE = 'Thank you — visit us again!';

/**
 * The shop's lines at the top of a customer paper (owner 2026-09-27: "on
 * top logo and tagline"). The logo is the shop's name there: when it prints,
 * the plain name line is left off. With no logo on paper (none set, one that
 * can't print, "Logo on receipts" off) the name prints instead, so a paper is
 * never nameless. The Settings preview lays itself out from this too.
 */
export function receiptHeadLines(
  branding: Pick<ReceiptBranding, 'storeName' | 'storeTagline'>,
  logoPrinted: boolean,
): { name: string | null; tagline: string | null } {
  const name = branding.storeName.trim();
  const tagline = branding.storeTagline?.trim() ?? '';
  return { name: logoPrinted || !name ? null : name, tagline: tagline || null };
}

/**
 * The shop's lines at the bottom of every customer paper, in order: the
 * address, the phone, the website — each only when it is set. The thank-you
 * line (where the paper has one) comes after them.
 */
export function receiptShopLines(branding: Pick<ReceiptBranding, 'branchLine' | 'phoneLine' | 'websiteLine'>): string[] {
  return [branding.branchLine, branding.phoneLine, branding.websiteLine]
    .map((l) => l?.trim() ?? '')
    .filter((l) => l !== '');
}

/**
 * Which paper a customer-facing job prints as. Decided when it prints, from
 * the order as it is then — never from the button that was pressed:
 *  - receipt: money was taken (PAID), or the order was refunded;
 *  - bill:    money is still owed (BILL - NOT PAID);
 *  - refund:  the slip for one refund (the job says so — reason 'refund');
 *  - void:    the order was cancelled (CANCELLED ORDER, nothing to pay).
 */
export type ReceiptDocument = 'receipt' | 'bill' | 'refund' | 'void';

/**
 * The paper an order prints as now (a refund slip is chosen by its job, not
 * here). A cancelled order never prints as a receipt or a bill; an order
 * nobody has paid for yet is a bill, even when its total is 0.
 */
export function receiptDocumentFor(s: OrderSnapshot): 'receipt' | 'bill' | 'void' {
  if (s.order.status === 'void') return 'void';
  if (s.order.paidAt || s.order.status === 'refunded') return 'receipt';
  return 'bill';
}

/**
 * How a paper that is not the first of its kind is marked. Worked out by the
 * spooler from the print log (document_prints), never from which button was
 * pressed:
 *  - reprint: someone pressed a reprint button — "DUPLICATE / Reprint #N";
 *  - copy:    printed again by the till itself (e.g. the dispatch bill after
 *             the counter already printed one) — "DUPLICATE / Copy #N";
 *  - retry:   the printer failed mid-way on this same job, so the first try
 *             may have printed — "DUPLICATE / Printer retry";
 *  - late:    the FIRST paper of this document, printed by hand well after
 *             the sale — not a duplicate, but it says when and by whom.
 */
export type CopyStampKind = 'reprint' | 'copy' | 'retry' | 'late';

export interface CopyStamp {
  kind: CopyStampKind;
  /** reprint: which reprint (1 = the first); copy: which paper (2 = the second). */
  number: number;
  /** When this paper prints. */
  printedAt: Date;
  /** Who asked for it (a reprint, or a late first print). */
  byName?: string | null;
  /** The manager whose PIN or password allowed it. */
  approvedByName?: string | null;
  /** When the first paper of this document went out (unknown for one an older version printed). */
  firstPrintedAt?: Date | null;
  /** The first paper carrying the FBR invoice number; the earlier one printed without it. */
  fbrCopy?: boolean;
  /**
   * The print log could not be read when this paper was pressed for by hand,
   * so which copy it is is not known: it still says DUPLICATE (a paper pressed
   * for by hand is never passed off as an original), just without a number —
   * "DUPLICATE / Reprint | time | by X" and "** DUPLICATE **".
   */
  numberUnknown?: boolean;
}

/** A stamp that makes the paper a DUPLICATE (every kind but a late first print). */
export function isDuplicateStamp(stamp: CopyStamp | null | undefined): stamp is CopyStamp {
  return !!stamp && stamp.kind !== 'late';
}

/** FBR's number for this paper, or why a live till has none yet. */
export interface FbrPrint {
  irn: string;
  qrPayload?: string | null;
  /** Sandbox: a test number, not a tax invoice (no QR). */
  test?: boolean;
}

/** One refund, for its slip. Amounts are positive (what went back). */
export interface RefundSlipInfo {
  refundedAt: Date;
  rows: Array<{ method: string; amountCents: number }>;
  reason: string | null;
  refundedByName: string | null;
  approvedByName: string | null;
  /** Everything refunded on the order so far, this refund included. */
  totalRefundedCents: number;
  /** The debit note for this refund once FBR issued it (customer copy only). */
  debitNote?: (FbrPrint & { saleIrn?: string | null }) | null;
  /** Live FBR, the sale was fiscalised, and the debit note is not issued yet. */
  debitNoteMissing?: 'pending' | 'failed' | null;
}

/** Who cancelled an order, when and why — for the cancelled-order and kitchen CANCELLED slips. */
export interface CancelInfo {
  at: Date | null;
  byName?: string | null;
  reason?: string | null;
}

export interface RenderReceiptOpts {
  width?: PrinterWidth;
  branding: ReceiptBranding;
  /** The paper to print (default: receiptDocumentFor the order). 'refund' needs `refund`. */
  document?: ReceiptDocument;
  /** DUPLICATE (or late-print) marking, from the print log. None on an original. */
  stamp?: CopyStamp | null;
  /** The refund this slip is for (document 'refund'). */
  refund?: RefundSlipInfo;
  /** Who cancelled the order, when and why (document 'void'). */
  cancelled?: CancelInfo | null;
  /**
   * FBR is live but this receipt has no invoice number: 'pending' prints
   * "not yet issued", 'failed' prints "not issued". Leave both this and `fbr`
   * out in noop mode: then nothing about FBR is printed at all.
   */
  fbrMissing?: 'pending' | 'failed' | null;
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
  /** FBR Digital Invoicing data once the worker has submitted (live modes only). */
  fbr?: FbrPrint;
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

/** Gap between the logo and the line under it (ESC J units: about 2 mm). */
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

/**
 * One customer-facing paper: a RECEIPT, a BILL - NOT PAID, a REFUND slip or
 * a CANCELLED ORDER slip, customer or SHOP COPY, original or DUPLICATE.
 *
 * Top to bottom: DUPLICATE band, logo (or the shop name when no logo
 * prints), tagline, TITLE (and its sub-line), DUPLICATE (again, inside the
 * body, so tearing the ends off doesn't leave an "original"), SHOP COPY,
 * order details, customer / rider, the order's notes, items, totals, payments and refunds, the
 * state line (PAID - CASH / TO COLLECT / REFUNDED), the rider note, the
 * signature line (shop copy), the bottom stamp, the shop's address, phone and
 * website, thank-you, FBR, DUPLICATE footer, cut. Everything between the two
 * DUPLICATE marks is exactly what the original said: same order number,
 * times, amounts, FBR number and QR.
 */
export function renderReceipt(
  snapshot: OrderSnapshot,
  opts: RenderReceiptOpts,
): Uint8Array {
  const width: PrinterWidth = opts.width ?? 48;
  const half = width / 2;
  const b = new EscPosBuilder(width);
  const doc: ReceiptDocument =
    opts.document === 'refund' && !opts.refund ? receiptDocumentFor(snapshot) : (opts.document ?? receiptDocumentFor(snapshot));
  const shopCopy = opts.copy === 'shop';
  const stamp = opts.stamp ?? null;
  const dup = isDuplicateStamp(stamp) ? stamp : null;

  b.align('center');
  if (dup) appendDuplicateBand(b, dup, width);

  // Header — the logo, then the tagline under it (owner 2026-09-27). The logo
  // is the shop's name here, so with it on paper the plain name line is left
  // off; with no logo on paper the name prints large instead — a paper is
  // never nameless. Every copy gets the same header: customer receipt, shop
  // copy, delivery bill, refund slip, cancelled order, reprint. Kitchen
  // tickets never carry it. Free text from settings, so every line is
  // word-wrapped here rather than broken by the printer at the paper edge;
  // double-size glyphs take two columns each. The address, phone and website
  // go at the bottom (receiptShopLines, below).
  const head = receiptHeadLines(opts.branding, appendLogo(b, opts.logo, width));
  b.align('center');
  if (head.name) {
    b.doubleSize(true).bold(true).wrappedText(head.name, half);
    b.doubleSize(false).bold(false);
  }
  if (head.tagline) b.wrappedText(head.tagline);
  b.newline();

  // What this paper IS, before anything else can be misread.
  appendTitle(b, doc, snapshot, opts.refund, width);
  if (dup) {
    b.bold(true).doubleHeight(true).text('DUPLICATE').newline();
    b.doubleHeight(false).bold(false);
  }
  if (stamp?.kind === 'late') {
    const who = stamp.byName ? ` by ${stamp.byName}` : '';
    b.bold(true).wrappedText(`Printed later: ${formatDateTime(stamp.printedAt)}${who}`).bold(false);
    if (stamp.approvedByName) b.wrappedText(`Approved by: ${stamp.approvedByName}`);
  }
  if (shopCopy) {
    b.bold(true).doubleHeight(true).text('SHOP COPY').newline();
    b.bold(false).doubleHeight(false);
  }
  b.newline();

  b.align('left');
  if (doc === 'void') {
    appendCancelledBody(b, snapshot, opts.cancelled ?? null, width);
  } else if (doc === 'refund' && opts.refund) {
    appendRefundBody(b, snapshot, opts.refund, shopCopy, width);
  } else {
    appendSaleBody(b, snapshot, doc === 'bill' ? 'bill' : 'receipt', dup, shopCopy, width);
  }

  // The shop's address, phone and website, on every paper, then the
  // thank-you: on a receipt and a bill (not once the sale was refunded in
  // full), never on the shop's own copy, a refund slip or a cancelled order.
  b.align('center');
  const shopLines = receiptShopLines(opts.branding);
  for (const line of shopLines) b.wrappedText(line);
  const thanks =
    !shopCopy && (doc === 'bill' || (doc === 'receipt' && snapshot.order.status !== 'refunded'));
  if (thanks) {
    b.wrappedText(opts.branding.footerLine?.trim() || DEFAULT_FOOTER_LINE);
  }
  if (thanks || shopLines.length > 0) b.newline();

  // FBR: the customer's copy of a receipt carries the sale invoice; the
  // customer's copy of a refund slip carries the debit note. A bill, a
  // cancelled order and the shop copy never carry one. In noop mode (the
  // default) nothing about FBR is printed — no promise of a QR to come.
  if (!shopCopy && doc === 'receipt') {
    appendFbrInvoice(b, opts.fbr ?? null, opts.fbrMissing ?? null);
  } else if (!shopCopy && doc === 'refund' && opts.refund) {
    appendFbrDebitNote(b, opts.refund);
  }

  if (dup) {
    b.align('center').bold(true).wrappedText(duplicateFooter(dup)).bold(false);
  }
  b.newline();

  if (opts.openDrawer) b.openDrawer(opts.drawer);
  if (opts.cutPaper !== false) b.cut(true);

  return b.build();
}

/**
 * "RECEIPT", "BILL - NOT PAID" (or "BILL - NOTHING TO PAY"), "REFUND",
 * "CANCELLED ORDER" — in double size, plus the line under it.
 */
function appendTitle(
  b: EscPosBuilder,
  doc: ReceiptDocument,
  snapshot: OrderSnapshot,
  refund: RefundSlipInfo | undefined,
  width: PrinterWidth,
): void {
  const half = width / 2;
  const big = (s: string) => {
    b.bold(true).doubleSize(true).wrappedText(s, half);
    b.doubleSize(false).bold(false);
  };
  switch (doc) {
    case 'void':
      big('CANCELLED ORDER');
      b.bold(true).wrappedText('NOT A BILL - NOTHING TO PAY').bold(false);
      return;
    case 'refund':
      if (!refund) break;
      big('REFUND');
      b.bold(true).doubleHeight(true).wrappedText(`Rs ${money(sumOf(refund.rows))} RETURNED`, width);
      b.doubleHeight(false).bold(false);
      return;
    case 'bill': {
      const cod = snapshot.order.mode === 'delivery';
      // Nothing due (a 100% discount, a free replacement): the headline
      // must not send the rider after cash the body says is not owed.
      if (billDueCents(snapshot) <= 0) {
        big('BILL - NOTHING TO PAY');
        if (cod) b.bold(true).wrappedText('RIDER COLLECTS NOTHING', width).bold(false);
        return;
      }
      big('BILL - NOT PAID');
      b.bold(true)
        .wrappedText(cod ? 'CASH ON DELIVERY' : 'PAY AT THE COUNTER')
        .bold(false);
      return;
    }
    case 'receipt':
      break;
  }
  big(snapshot.order.status === 'refunded' ? 'RECEIPT - REFUNDED' : 'RECEIPT');
}

/** Order number and mode, then who and when. */
function appendOrderMeta(b: EscPosBuilder, snapshot: OrderSnapshot): void {
  const { order, tableLabel } = snapshot;
  const orderTopRight = tableLabel ? `${MODE_LABEL[order.mode]} ${tableLabel}` : MODE_LABEL[order.mode];
  b.bold(true).line(`Order #${order.orderNumber}`, orderTopRight).bold(false);
}

/** Items with their prices and choices (receipts and bills). */
function appendPricedItems(b: EscPosBuilder, snapshot: OrderSnapshot, width: PrinterWidth): void {
  for (const it of snapshot.items) {
    const qty = `${it.quantity}x`;
    const name = `${qty} ${it.menuItemName}`;
    const total = money(it.lineTotalCents);

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
        b.line(modName, `${sign} ${money(Math.abs(mod.priceDeltaCents))}`);
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
}

/** A receipt or a bill: everything about the sale and where the money stands. */
function appendSaleBody(
  b: EscPosBuilder,
  snapshot: OrderSnapshot,
  doc: 'receipt' | 'bill',
  dup: CopyStamp | null,
  shopCopy: boolean,
  width: PrinterWidth,
): void {
  const { order, payments, discounts, cashierName } = snapshot;
  appendOrderMeta(b, snapshot);
  const dt = new Date(order.paidAt ?? order.createdAt);
  b.line(`Cashier: ${cashierName}`, formatDateTime(dt));

  // Customer / delivery block (only when present — snapshotted onto the order)
  if (snapshot.customerName || snapshot.customerPhone) {
    b.line(`Customer: ${snapshot.customerName ?? ''}`, snapshot.customerPhone ?? '');
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
  // What was written for the whole order (the counter's "Order notes", a
  // website customer's directions) — the rider and the customer read it here.
  for (const note of orderNotesOf(snapshot)) {
    b.bold(true).wrappedText(`Order note: ${note}`, width).bold(false);
  }
  b.rule();

  appendPricedItems(b, snapshot, width);
  b.rule();

  // Totals
  b.line('Subtotal', money(order.subtotalCents));
  for (const d of discounts) {
    // The shop's foodpanda deal prints as itself ("Foodpanda deal 20% off"),
    // with foodpanda's part on a line of its own when the deal is shared.
    // foodpanda's commission never prints.
    if (d.source === 'foodpanda' && d.amountCents === 0) {
      // Nothing off the shop's bill: foodpanda pays all of the deal (say so,
      // not "- 0.00"), or the order is under the deal's minimum (no line).
      const fp = d.foodpanda;
      if (fp && fp.platformCents > 0) b.line(`Foodpanda deal ${fp.dealPercent}% off, paid by foodpanda`, money(fp.platformCents));
      continue;
    }
    // One of the owner's automatic offers the cashier took off: nothing off, no line.
    if (d.source === 'offer' && d.amountCents === 0) continue;
    // "Discount (Staff)" — or, when its frozen rule left the delivery charge
    // alone, "Discount 10% (Staff, food only)"; an automatic offer by its name.
    const tag = discountBillLabel(d, snapshot.items);
    b.line(tag, `- ${money(d.amountCents)}`);
    if (d.foodpanda && d.foodpanda.platformCents > 0) {
      b.line('foodpanda pays another', money(d.foodpanda.platformCents));
    }
  }
  b.line(taxLabel(snapshot), money(order.taxCents));
  if (dup) b.text(ruleWith('=', ' DUPLICATE ', width)).newline();
  else b.rule('=');
  b.bold(true).doubleHeight(true).line('TOTAL', `Rs ${money(order.totalCents)}`);
  b.bold(false).doubleHeight(false);
  b.rule();

  // Money taken, then money given back.
  const taken = payments.filter((p) => p.amountCents > 0);
  const refunds = payments.filter((p) => p.amountCents < 0);
  for (const p of taken) {
    b.line(METHOD_LABEL[p.method] ?? p.method, money(p.amountCents));
    // foodpanda's own order number, when it was typed at Pay.
    if (p.method === 'foodpanda' && p.referenceNo) b.line('foodpanda order #', p.referenceNo);
  }
  // Change is what the customer handed over for the CASH part, less that
  // part — not less the whole bill (a card + cash split printed a negative
  // "Change" that way).
  const cash = taken.find((p) => p.method === 'cash' && p.tenderedCents != null);
  if (cash && cash.tenderedCents != null) {
    b.line('Tendered', money(cash.tenderedCents));
    b.line('Change', money(Math.max(0, cash.tenderedCents - cash.amountCents)));
  }
  for (const r of refunds) {
    const at = new Date(r.paidAt);
    b.line(`Refund ${formatClock(at)} ${METHOD_LABEL[r.method] ?? r.method}`, money(r.amountCents));
  }
  const takenCents = sumOf(taken);
  const refundedCents = -sumOf(refunds);
  if (refunds.length > 0) {
    b.bold(true).line('NET PAID', money(takenCents - refundedCents)).bold(false);
  }
  b.newline();

  if (doc === 'receipt') {
    appendPaidState(b, snapshot, taken, refunds, dup, width);
  } else {
    appendDueState(b, snapshot, takenCents, width);
  }

  if (shopCopy) {
    // Room for the rider or customer to sign; the shop keeps this copy.
    b.newline().text(`Received by: ${'_'.repeat(Math.max(8, width - 13))}`).newline();
  }
  b.newline();
}

/** PAID - CASH, PART REFUNDED, or REFUNDED IN FULL — and what the rider collects. */
function appendPaidState(
  b: EscPosBuilder,
  snapshot: OrderSnapshot,
  taken: OrderSnapshot['payments'],
  refunds: OrderSnapshot['payments'],
  dup: CopyStamp | null,
  width: PrinterWidth,
): void {
  const { order } = snapshot;
  const refundedCents = -sumOf(refunds);
  const lastRefund = refunds.reduce<string | null>((m, p) => (m === null || p.paidAt > m ? p.paidAt : m), null);
  const suffix = dup ? ' (DUPLICATE)' : '';
  if (order.status === 'refunded') {
    b.bold(true).doubleHeight(true).wrappedText(`REFUNDED IN FULL${suffix}`, width);
    b.doubleHeight(false);
    const when = lastRefund ? ` ${formatDateTime(new Date(lastRefund))}` : '';
    b.wrappedText(`Rs ${money(refundedCents)} returned${when}`, width).bold(false);
    b.newline();
    b.bold(true).wrappedText('This sale was refunded - not valid for any claim.', width).bold(false);
    return;
  }
  if (taken.length === 0 && order.totalCents <= 0) {
    b.bold(true).doubleHeight(true).wrappedText(`NO CHARGE - NOTHING TO PAY${suffix}`, width);
    b.doubleHeight(false).bold(false);
  } else {
    b.bold(true).doubleHeight(true).wrappedText(`PAID - ${paidMethods(taken)}${suffix}`, width);
    b.doubleHeight(false).bold(false);
  }
  if (refundedCents > 0) {
    b.bold(true).wrappedText(`PART REFUNDED - Rs ${money(refundedCents)} returned`, width).bold(false);
  }
  const when = order.mode === 'delivery' ? deliveryPaidLine(order) : null;
  if (when) b.bold(true).wrappedText(when, width).bold(false);
}

/**
 * When a delivery's money was taken, as the order's own times say — never
 * "PREPAID" for cash the rider brought back:
 *  - before the food left (paid before the rider was assigned, or with no
 *    rider and before it was delivered): PREPAID - RIDER COLLECTS NOTHING;
 *  - when it was delivered (cash on delivery: the board records the payment
 *    and the delivery together): PAID ON DELIVERY; later than that: PAID
 *    AFTER DELIVERY;
 *  - while the rider was out: nothing more than PAID - <method>.
 */
function deliveryPaidLine(order: OrderSnapshot['order']): string | null {
  const paid = order.paidAt ? Date.parse(order.paidAt) : NaN;
  if (!Number.isFinite(paid)) return null;
  const delivered = order.deliveredAt ? Date.parse(order.deliveredAt) : NaN;
  const dispatched = order.dispatchedAt ? Date.parse(order.dispatchedAt) : NaN;
  if (Number.isFinite(delivered) && paid >= delivered) {
    return paid - delivered <= 60_000 ? 'PAID ON DELIVERY' : 'PAID AFTER DELIVERY';
  }
  if (Number.isFinite(dispatched) && paid > dispatched) return null;
  return 'PREPAID - RIDER COLLECTS NOTHING';
}

/** What is still owed on a bill: the total less the money already taken. */
function billDueCents(snapshot: OrderSnapshot): number {
  return snapshot.order.totalCents - sumOf(snapshot.payments.filter((p) => p.amountCents > 0));
}

/** What is still owed on a bill, and who collects it. */
function appendDueState(b: EscPosBuilder, snapshot: OrderSnapshot, takenCents: number, width: PrinterWidth): void {
  const { order } = snapshot;
  const dueCents = order.totalCents - takenCents;
  const cod = order.mode === 'delivery';
  if (takenCents > 0) b.line('Paid so far', money(takenCents));
  if (dueCents <= 0) {
    // "No charge" only when nothing was ever charged; money already taken covers it otherwise.
    b.bold(true).doubleHeight(true).wrappedText(takenCents > 0 ? 'NOTHING MORE TO PAY' : 'NO CHARGE - NOTHING TO PAY', width);
    b.doubleHeight(false).bold(false);
    return;
  }
  b.bold(true).doubleHeight(true).line(cod ? 'TO COLLECT' : 'TO PAY', `Rs ${money(dueCents)}`);
  b.doubleHeight(false);
  b.newline();
  if (cod) {
    // The customer's only paper until the rider is paid: say who to pay.
    b.wrappedText('NOT PAID', width).wrappedText(`Pay the rider Rs ${money(dueCents)}`, width).bold(false);
  } else {
    b.wrappedText('NOT PAID - pay at the counter', width).bold(false);
    b.wrappedText('This bill is not a receipt.', width);
  }
}

/** A refund slip: how much went back, how, why, and who allowed it. */
function appendRefundBody(
  b: EscPosBuilder,
  snapshot: OrderSnapshot,
  refund: RefundSlipInfo,
  shopCopy: boolean,
  width: PrinterWidth,
): void {
  const { order, payments, cashierName } = snapshot;
  const returned = sumOf(refund.rows);
  appendOrderMeta(b, snapshot);
  b.text(`Refunded ${formatDateTime(refund.refundedAt)}`).newline();
  b.line(`Sale ${formatDateTime(new Date(order.paidAt ?? order.createdAt))}`, `Cashier: ${cashierName}`);
  b.rule();
  for (const r of refund.rows) {
    b.line(`${METHOD_LABEL[r.method] ?? r.method} refund`, money(r.amountCents));
  }
  if (refund.reason) b.wrappedText(`Reason: ${refund.reason}`, width);
  if (refund.refundedByName) b.wrappedText(`Refunded by: ${refund.refundedByName}`, width);
  if (refund.approvedByName) b.wrappedText(`Approved by: ${refund.approvedByName}`, width);
  b.rule();
  const paid = sumOf(payments.filter((p) => p.amountCents > 0));
  b.line('Original bill total', money(order.totalCents));
  b.line('Refunded in all', money(refund.totalRefundedCents));
  b.line('Net paid', money(Math.max(0, paid - refund.totalRefundedCents)));
  b.newline();
  if (shopCopy) {
    b.bold(true).wrappedText(`Customer received Rs ${money(returned)}`, width).bold(false);
    b.newline().text(`Signature: ${'_'.repeat(Math.max(8, width - 11))}`).newline().newline();
  }
  b.align('center').bold(true).wrappedText('REFUND SLIP - NOT A RECEIPT FOR PAYMENT', width).bold(false);
  b.newline();
}

/** A cancelled order: what it was, when and why it was cancelled — no prices, nothing to pay. */
function appendCancelledBody(
  b: EscPosBuilder,
  snapshot: OrderSnapshot,
  cancel: CancelInfo | null,
  width: PrinterWidth,
): void {
  const { order } = snapshot;
  appendOrderMeta(b, snapshot);
  const at = cancel?.at ?? (order.voidedAt ? new Date(order.voidedAt) : null);
  if (at) b.text(`Cancelled ${formatDateTime(at)}`).newline();
  const reason = cancel?.reason ?? order.voidReason;
  if (reason) b.wrappedText(`Reason: ${reason}`, width);
  if (cancel?.byName) b.wrappedText(`Approved by: ${cancel.byName}`, width);
  b.rule();
  for (const it of snapshot.items) {
    b.wrappedText(`${it.quantity} x ${it.menuItemName}`, width);
    for (const mod of it.modifiers) {
      for (const ln of wrap(mod.modifierName, width - 4)) b.text(`    ${ln}`).newline();
    }
  }
  b.rule();
  b.newline();
  b.align('center').bold(true).wrappedText('CANCELLED - NOTHING TO PAY', width).bold(false);
  b.newline();
}

/**
 * The sale's FBR invoice number and QR. A duplicate prints exactly the same
 * number and QR (never a new one: the same invoice, printed again).
 */
function appendFbrInvoice(b: EscPosBuilder, fbr: FbrPrint | null, missing: 'pending' | 'failed' | null): void {
  if (fbr?.irn) {
    b.rule();
    if (fbr.test) {
      b.bold(true).text('FBR SANDBOX TEST').newline().bold(false);
      b.text('Not a tax invoice').newline();
      b.wrappedText(`Test no: ${fbr.irn}`);
      return;
    }
    b.bold(true).text('FBR Digital Invoice').newline().bold(false);
    b.wrappedText(`FBR Invoice No: ${fbr.irn}`);
    if (fbr.qrPayload) qrCode(b, fbr.qrPayload, 6);
    return;
  }
  if (missing) {
    b.rule();
    b.wrappedText(missing === 'failed' ? 'FBR invoice no.: not issued' : 'FBR invoice no.: not yet issued');
  }
}

/** A refund's own FBR number (the debit note), never the sale's under "FBR Digital Invoice". */
function appendFbrDebitNote(b: EscPosBuilder, refund: RefundSlipInfo): void {
  const note = refund.debitNote;
  if (note?.irn) {
    b.rule();
    if (note.test) {
      b.bold(true).text('FBR SANDBOX TEST').newline().bold(false);
      b.text('Not a tax invoice').newline();
      b.wrappedText(`Test no: ${note.irn}`);
      return;
    }
    b.bold(true).text('FBR Debit Note').newline().bold(false);
    b.wrappedText(`FBR No: ${note.irn}`);
    if (note.qrPayload) qrCode(b, note.qrPayload, 6);
    if (note.saleIrn) b.wrappedText(`Against invoice: ${note.saleIrn}`);
    return;
  }
  if (refund.debitNoteMissing) {
    b.rule();
    b.wrappedText(refund.debitNoteMissing === 'failed' ? 'FBR debit note: not issued' : 'FBR debit note: not yet issued');
  }
}

/**
 * The band at the very top of a DUPLICATE: a row of stars, DUPLICATE in
 * double size, which copy it is, when and by whom, and when the original
 * went out.
 */
function appendDuplicateBand(b: EscPosBuilder, stamp: CopyStamp, width: PrinterWidth): void {
  b.align('center');
  b.rule('*');
  b.bold(true).doubleSize(true).text('DUPLICATE').newline();
  b.doubleSize(false).bold(false);
  const when = formatDateTime(stamp.printedAt);
  switch (stamp.kind) {
    case 'retry':
      factsLine(b, ['Printer retry', when], width);
      b.wrappedText('The first copy may have printed', width);
      break;
    case 'copy':
      factsLine(b, [`Copy #${stamp.number}`, when], width);
      break;
    default:
      factsLine(b, [reprintLabel(stamp), when, stamp.byName ? `by ${stamp.byName}` : null], width);
      break;
  }
  if (stamp.approvedByName) b.wrappedText(`Approved by: ${stamp.approvedByName}`, width);
  if (stamp.kind !== 'retry' && stamp.firstPrintedAt) {
    b.wrappedText(`Original: ${formatDateTime(stamp.firstPrintedAt)}`, width);
  }
  if (stamp.fbrCopy) b.wrappedText('FBR copy - the first with the FBR number', width);
  b.rule('*');
}

/** The line just above the cut on a DUPLICATE. */
function duplicateFooter(stamp: CopyStamp): string {
  switch (stamp.kind) {
    case 'retry':
      return '** DUPLICATE - printer retry **';
    case 'copy':
      return `** DUPLICATE - Copy #${stamp.number} **`;
    default:
      return stamp.numberUnknown ? '** DUPLICATE **' : `** DUPLICATE - Reprint #${stamp.number} **`;
  }
}

/** "Reprint #2", or just "Reprint" when the print log could not say which one. */
function reprintLabel(stamp: CopyStamp): string {
  return stamp.numberUnknown ? 'Reprint' : `Reprint #${stamp.number}`;
}

/** "a | b | c" on one row when it fits, otherwise one fact per row (58 mm paper). */
function factsLine(b: EscPosBuilder, facts: Array<string | null>, width: number): void {
  const parts = facts.filter((f): f is string => !!f);
  const joined = parts.join(' | ');
  if (toPrinterAscii(joined).length <= width) {
    b.text(joined).newline();
    return;
  }
  for (const p of parts) b.wrappedText(p, width);
}

/** "==== DUPLICATE ====" across the paper. */
function ruleWith(char: string, label: string, width: number): string {
  const left = Math.max(1, Math.floor((width - label.length) / 2));
  const right = Math.max(1, width - label.length - left);
  return `${char.repeat(left)}${label}${char.repeat(right)}`.slice(0, width);
}

/** "Tax (16%)" when every line carries the same rate, otherwise "Tax". */
function taxLabel(snapshot: OrderSnapshot): string {
  const rates = new Set(snapshot.items.map((it) => it.taxRateBps));
  if (rates.size !== 1) return 'Tax';
  const [bps] = [...rates];
  if (bps === undefined || !Number.isInteger(bps) || bps <= 0) return 'Tax';
  const pct = bps % 100 === 0 ? String(bps / 100) : (bps / 100).toFixed(2).replace(/0$/, '');
  return `Tax (${pct}%)`;
}

/** "CASH", "CARD + CASH": the methods money came in by, biggest first. */
function paidMethods(taken: OrderSnapshot['payments']): string {
  const byMethod = new Map<string, number>();
  for (const p of taken) byMethod.set(p.method, (byMethod.get(p.method) ?? 0) + p.amountCents);
  return [...byMethod.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([m]) => (METHOD_LABEL[m] ?? m).toUpperCase())
    .join(' + ');
}

function sumOf(rows: ReadonlyArray<{ amountCents: number }>): number {
  return rows.reduce((n, r) => n + r.amountCents, 0);
}

export interface RenderKitchenTicketOpts {
  width?: PrinterWidth;
  /** Cut paper after printing — default true. */
  cutPaper?: boolean;
  /**
   * Stamps the ticket REPRINT so the kitchen doesn't cook the order twice.
   * Only used when there is no `stamp` (older callers): the till's own
   * tickets are stamped from the print log.
   */
  reprint?: boolean;
  /** The order was cancelled while the kitchen had it: "CANCELLED — DO NOT MAKE", then what it was. */
  cancelled?: boolean;
  /** When, by whom and why it was cancelled (for a `cancelled` ticket). */
  cancelInfo?: CancelInfo | null;
  /**
   * From the print log. 'reprint' / 'copy': a ticket for this order already
   * printed — "* REPRINT * / SAME ORDER - DO NOT COOK TWICE". 'retry': the
   * printer failed mid-way, so the first try may have printed — "* RE-SENT *
   * / CHECK FOR TICKET #0042 BEFORE COOKING". None: the kitchen's first ticket.
   */
  stamp?: CopyStamp | null;
  /** When the ticket was queued: one printing 2 minutes or more later says "LATE - sent 19:35". */
  queuedAt?: Date | null;
  /** Clock for the "printed at" time — injectable for tests. */
  now?: Date;
  /**
   * This till's kitchen-ticket rules (Settings → Printers; PrintPolicy's
   * kitchen fields, read with kitchenTicketRules): the customer's phone —
   * default true — and the drinks — default true; off, they are left off
   * and one line says how many drinks the counter hands out.
   */
  showPhone?: boolean;
  showDrinks?: boolean;
  /** One of several tickets printed for the order at once: "COPY 1 OF 2" under the order type. Null / 1 of 1: nothing. */
  copyOf?: { n: number; of: number } | null;
}

/** A kitchen ticket printing this long after it was queued says LATE. */
export const KITCHEN_LATE_MS = 2 * 60_000;

/**
 * A drink, for the kitchen ticket's "drinks" rule (Settings → Printers): an
 * item sent to the bar, or in a menu category called Drinks or Beverages
 * ("Cold Drinks", "Soft drinks"…) — the names the till's food-cost
 * suggestions know drinks by.
 */
export function isDrinkLine(item: Pick<OrderSnapshot['items'][number], 'categoryName' | 'prepStation'>): boolean {
  return item.prepStation === 'bar' || /\bdrinks?\b|\bbeverages?\b/i.test(item.categoryName ?? '');
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
 * nothing about money. Order number and mode in double size (and WEBSITE
 * ORDER for one from the website), the order's notes in bold before the
 * items (the counter's "Order notes", a website customer's note — as loud as
 * an allergy note), one double-height row per item with its modifiers and
 * notes beneath, then — for deliveries — the address, so the bag can be
 * matched to its rider.
 *
 * Layout (80mm / 48 cols):
 *
 *                    KITCHEN
 *                     #0042
 *                    DELIVERY
 *                 WEBSITE ORDER
 *      14/09 19:35                     Ali Akbar
 *      Customer: Hamza              0300 9367865
 *      !! ORDER NOTE: Ring the upper bell
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

  const short = order.orderNumber.split('-').pop() ?? order.orderNumber;
  const stamp = opts.stamp ?? null;
  // The log decides; a caller without one may still ask for the old stamp.
  const reprinted = stamp ? stamp.kind === 'reprint' || stamp.kind === 'copy' : opts.reprint === true;
  const resent = !opts.cancelled && stamp?.kind === 'retry';

  b.align('center');
  b.bold(true).doubleSize(true).wrappedText('KITCHEN', half);
  if (opts.cancelled) {
    b.doubleSize(true).wrappedText('* CANCELLED *', half);
    b.doubleSize(false).doubleHeight(true).wrappedText('DO NOT MAKE - DO NOT SEND', width);
  } else if (resent) {
    // The first try may be on the rail already: look before cooking.
    b.doubleSize(false).doubleHeight(true).wrappedText('* RE-SENT *', width);
    b.doubleHeight(false).bold(false).wrappedText('Printer error on first try', width);
    b.bold(true).wrappedText(`CHECK FOR TICKET #${short}`, width).wrappedText('BEFORE COOKING', width);
  }
  b.bold(true).doubleSize(true).wrappedText(`#${short}`, half);
  if (!opts.cancelled && reprinted) {
    // Right under the number the kitchen looks for: the same order again.
    b.doubleSize(false).doubleHeight(true).wrappedText('* REPRINT *', width);
    b.wrappedText('SAME ORDER - DO NOT COOK TWICE', width);
    b.doubleHeight(false);
    if (stamp?.firstPrintedAt) {
      b.wrappedText(`First printed ${formatTicketTime(stamp.firstPrintedAt)} - check the rail`, width);
    }
    if (stamp) {
      b.bold(false);
      const who = stamp.byName ? ` by ${stamp.byName}` : '';
      const which = stamp.kind === 'copy' ? `Copy #${stamp.number}` : reprintLabel(stamp);
      b.wrappedText(`${which} ${formatTicketTime(stamp.printedAt)}${who}`, width);
      b.bold(true);
    }
  }
  b.doubleSize(false).doubleHeight(true).wrappedText(MODE_SHOUT[order.mode], width);
  b.doubleHeight(false);
  // Several tickets at once (Settings → Printers): each says which it is, so two are never cooked as two orders.
  if (opts.copyOf && opts.copyOf.of > 1) b.wrappedText(`COPY ${opts.copyOf.n} OF ${opts.copyOf.of}`, width);
  // Where it came from: the website order's "[web …]" tag used to be the
  // only sign of it on the ticket (as its note); the note now prints alone.
  if (order.source === 'web') {
    b.wrappedText(order.mode === 'takeaway' ? 'WEBSITE PICK-UP' : 'WEBSITE ORDER', width);
  }
  b.bold(false);

  b.align('left');
  const when = opts.now ?? new Date();
  b.line(formatTicketTime(when), snapshot.cashierName);
  if (opts.cancelled && opts.cancelInfo) {
    const c = opts.cancelInfo;
    b.bold(true);
    if (c.at) b.wrappedText(`Cancelled ${formatTicketTime(c.at)}${c.byName ? ` by ${c.byName}` : ''}`, width);
    if (c.reason) b.wrappedText(`Reason: ${c.reason}`, width);
    b.bold(false);
    if (stamp) b.wrappedText('(printed again: printer retry)', width);
  } else if (!reprinted && opts.queuedAt && when.getTime() - opts.queuedAt.getTime() >= KITCHEN_LATE_MS) {
    // A ticket that sat in the printer queue must not look fresh.
    b.bold(true).wrappedText(`LATE - sent ${formatClock(opts.queuedAt)}`, width).bold(false);
  }
  if (snapshot.tableLabel) b.line(`Table: ${snapshot.tableLabel}`);
  // The customer's phone only while this till's rule has it on (the default).
  const phone = opts.showPhone === false ? null : snapshot.customerPhone;
  if (snapshot.customerName || phone) {
    b.line(`Customer: ${snapshot.customerName ?? ''}`, phone ?? '');
  }
  // What was written for the whole order, before the first item and as loud
  // as an allergy note: the counter's "Order notes" box and a website
  // customer's note print the same way. It used to be missed altogether (the
  // counter's) or printed small after the items (the website's).
  for (const note of orderNotesOf(snapshot)) {
    b.bold(true);
    for (const ln of wrap(`!! ORDER NOTE: ${note}`, width)) b.text(ln).newline();
    b.bold(false);
  }
  b.rule();

  // Drinks left off when this till's rule says so: the counter hands them out.
  const toCook = opts.showDrinks === false ? items.filter((it) => !isDrinkLine(it)) : items;
  const drinksLeftOff = items.filter((it) => !toCook.includes(it)).reduce((n, it) => n + it.quantity, 0);
  for (const it of toCook) {
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
  if (drinksLeftOff > 0) {
    b.wrappedText(
      toCook.length === 0
        ? `Only drinks (${drinksLeftOff}) - nothing to cook`
        : `+ ${drinksLeftOff} drink${drinksLeftOff === 1 ? '' : 's'} from the counter (not listed)`,
      width,
    );
  }
  b.rule();

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

function money(cents: number): string {
  return formatCentsForReceipt(cents);
}

/** "26/09/2026 19:35" — the one date format on every paper (Pakistan writes the day first). */
function formatDateTime(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${day}/${m}/${y} ${formatClock(d)}`;
}

/** "19:35" */
function formatClock(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
