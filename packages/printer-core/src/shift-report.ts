/**
 * The shift report on the receipt printer (v0.7.35): the paper that prints
 * when a shift closes, and again from Shift history. Pure, like the receipt
 * renderer: the same saved report and options always give the same bytes,
 * whatever the PC's own time zone (every time prints in Pakistan time).
 *
 * It prints the figures saved at the close (shared-types ShiftReport,
 * shifts.close_report_json) and never works one out again; a reprint after
 * an update may lay them out differently, never change them. It is its own
 * renderer, not renderPlainDocument: a PlainDocument never carries a price.
 * No logo, no QR code, no drawer pulse. No food cost, waste rupees,
 * commission or profit is in the report, so none can print.
 *
 * Layout (80 mm / 48 cols; the owner's sample paper of 2 Oct 2026):
 *
 *      ************************************************   <- a reprint only:
 *                         DUPLICATE                          the DUPLICATE band
 *      Reprint #2 | 02/10/2026 09:15 | by Imran Ali
 *      ************************************************
 *                    SHIFT REPORT                    <- bold, double size
 *                   Cheese O'Clock
 *               Till: DESKTOP-7Q2M1KD
 *      ------------------------------------------------
 *      Opened 01/10/2026 16:02                 Ali Raza
 *      Closed 02/10/2026 01:48                Imran Ali
 *        PIN on Ali Raza's login
 *      ================================================
 *      SALES                             62 orders paid   <- each section only
 *      ...                                                   when it is switched on
 *      ------------------------------------------------
 *      MONEY TAKEN / BY CHANNEL / CANCELLED AND REFUNDED /
 *      CASH DRAWER / CASH COUNTED / UNPAID - CARRIED OVER /
 *      ITEMS SOLD / ORDERS, a '-' rule between
 *      ================================================
 *      Printed 02/10/2026 01:48 by Imran Ali
 *      Some sections are off.                    <- only when the owner
 *      See Settings > Printers.                     switched one off
 *      Sales = orders paid on this till this shift.
 *      Figures as saved when the shift closed.
 *                -- END OF SHIFT REPORT --
 *              ** DUPLICATE - Reprint #2 **        <- a reprint only
 *
 * ITEMS SOLD lists every item under its category (bold, in capitals), or
 * the category rows only (opts.items 'categories'). ORDERS, printed last,
 * lists every order paid (the same orders as SALES), one row each at 80 mm:
 *
 *      ORDERS (62)                           189,911.00
 *      #0001 16:20 Takeaway, Cash              2,530.00
 *      #0006 18:02 Delivery, EasyPaisa + Cash  4,370.00
 *      #0033 21:31 Takeaway, Cash (refunded)   1,725.00
 *
 * and two rows each at 58 mm ('#0001 16:20' with the total, then
 * '  Takeaway, Cash'). It has no cap: the owner asked for every order.
 *
 * At 58 mm (32 cols) the times are dd/mm hh:mm (the full date is in the
 * 'Printed' line), a cancel or refund whose reason does not fit prints the
 * reason on its own rows indented 4, and a few labels are shorter.
 *
 * The CASH DRAWER's riders row says what the close result says since
 * v0.7.34 ('Paid to outside riders (5): 4 delivery charges kept, 1 trip'),
 * not the sample's 'Delivery charges kept by riders (n)': a trip paid for a
 * cancelled order is not a delivery charge kept.
 *
 * Every row goes through row(): the amount on the right when label and
 * amount share a row; otherwise the label wraps at the width less its
 * indent, every wrapped row keeping the indent, and the amount prints
 * right-aligned under it — never a row the printer has to break, and never
 * an indent lost (EscPosBuilder.line alone would drop it). All text goes
 * through toPrinterAscii ('—' prints '-', '×' prints 'x').
 */
import {
  CASH_PAISA_DIFFERENCE_LABEL,
  SHIFT_REPORT_SECTIONS,
  cashPaisaDifferenceCents,
  cashVarianceVerdict,
  paperClock,
  paperDateTime,
  paperDayMonthClock,
  shortOrderNumber,
  type PrinterWidth,
  type ReportChannel,
  type ShiftReport,
  type ShiftReportCancelled,
  type ShiftReportDiscountKind,
  type ShiftReportOrder,
  type ShiftReportRefund,
  type ShiftReportSection,
} from '@cheeseoclock/shared-types';
import { EscPosBuilder, toPrinterAscii, wrap } from './escpos.js';
import { paperMoney, paperRupees, paperSignedMoney } from './paper-money.js';

/** A moment as the till stores or makes it: a Date, epoch ms or an ISO text. */
export type ShiftReportPaperTime = Date | number | string;

/** Which copy a reprint is (from this till's print log), when and by whom. */
export interface ShiftReportStamp {
  /** 1 = the first reprint; 0 when the print log could not say. */
  reprintNo: number;
  at: ShiftReportPaperTime;
  byName?: string | null;
}

export interface RenderShiftReportOpts {
  width: PrinterWidth;
  /**
   * The owner's switches (Settings → Printers → Shift report): a section
   * prints unless its switch is false. They change only what prints; when
   * any is off the footer says so.
   */
  sections: Record<ShiftReportSection, boolean>;
  /** ITEMS SOLD: every item under its category, or the category totals only. */
  items: 'items' | 'categories';
  printedAt: ShiftReportPaperTime;
  printedByName: string;
  /** Set on a reprint: the paper says DUPLICATE at the top and the bottom. */
  stamp?: ShiftReportStamp | null;
  /**
   * A reprint only: what changed since the close and is NOT in the saved
   * figures — the cash of test orders deleted since (signed cents).
   */
  sinceClose?: { testDeletedCashCents: number } | null;
}

/**
 * At most this many cancels, refunds or unpaid orders are listed; then 'and
 * N more'. ITEMS SOLD and ORDERS have no cap.
 */
export const SHIFT_REPORT_LIST_MAX = 10;

/** The two footer rows when the owner switched a section off (each fits 32 columns). */
const SECTIONS_OFF_ROWS = ['Some sections are off.', 'See Settings > Printers.'] as const;

/** The sections in the paper's order (SHIFT_REPORT_SECTIONS' order): ORDERS last, before the footer. */
const PRINTED_SECTIONS: ReadonlyArray<readonly [ShiftReportSection, (p: Paper, r: ShiftReport) => void]> = [
  ['sales', appendSales],
  ['moneyTaken', appendMoneyTaken],
  ['channels', appendChannels],
  ['cancelsRefunds', appendCancelsRefunds],
  ['drawer', appendDrawer],
  ['counted', appendCounted],
  ['unpaid', appendUnpaid],
  ['items', appendItems],
  ['orders', appendOrders],
];

/** The payment methods in the paper's words: MONEY TAKEN and the orders list. */
const METHOD_LABEL: Record<string, string> = {
  cash: 'Cash',
  card: 'Card',
  easypaisa: 'EasyPaisa',
  jazzcash: 'JazzCash',
  bank_transfer: 'Bank transfer',
  foodpanda: 'foodpanda',
};

/** The same, inside a refund's row: "#0033 22:05 cash: Cold pizza". */
const METHOD_WORD: Record<string, string> = {
  cash: 'cash',
  card: 'card',
  easypaisa: 'EasyPaisa',
  jazzcash: 'JazzCash',
  bank_transfer: 'bank transfer',
  foodpanda: 'foodpanda',
};

/** The channels in Reports' words (shortened for paper). */
const CHANNEL_LABEL: Record<ReportChannel, string> = {
  takeaway: 'Takeaway',
  delivery: 'Delivery',
  web_pickup: 'Website pick-up',
  web_delivery: 'Website delivery',
  foodpanda: 'foodpanda',
  dine_in: 'Dine-in (old)',
  online: 'Online (old)',
};

/** The kinds of discount, indented under 'Discounts (n)'. */
const DISCOUNT_LABEL: Record<ShiftReportDiscountKind, string> = {
  foodpanda: 'foodpanda deal',
  staff: 'Staff discounts',
  website: 'Pick-up discount',
  offer: 'Automatic offers',
};

/** The paper being printed: the builder, its width and how ITEMS SOLD prints. */
interface Paper {
  b: EscPosBuilder;
  width: PrinterWidth;
  items: 'items' | 'categories';
}

/**
 * The shift report as ESC/POS bytes, ending with a cut. Pure: no clock, no
 * zone, no IO.
 */
export function renderShiftReport(report: ShiftReport, opts: RenderShiftReportOpts): Uint8Array {
  const width: PrinterWidth = opts.width === 32 ? 32 : 48;
  const p: Paper = { b: new EscPosBuilder(width), width, items: opts.items === 'categories' ? 'categories' : 'items' };
  const { b } = p;
  const stamp = opts.stamp ?? null;

  appendHeader(p, report, stamp);

  let printed = 0;
  for (const [key, append] of PRINTED_SECTIONS) {
    if (opts.sections[key] === false) continue;
    if (printed > 0) b.rule('-');
    append(p, report);
    printed += 1;
  }
  if (printed > 0) b.rule('=');

  appendFooter(p, opts, stamp);
  return b.cut().build();
}

// ---------------------------------------------------------------------------
// Rows

/** One printable row's worth of text: transliterated, no line breaks or tabs. */
function ascii(s: string): string {
  return toPrinterAscii(s).replace(/[\n\t]/g, ' ');
}

/**
 * A row: the label (after `indent` spaces) with the amount right-aligned.
 * When they cannot share a row, the label wraps at width − indent keeping
 * the indent on every row, and the amount prints right-aligned under it.
 */
function row(p: Paper, label: string, amount = '', indent = 0): void {
  const lead = ' '.repeat(indent);
  const text = lead + ascii(label);
  const value = ascii(amount);
  if (!value && text.length <= p.width) {
    p.b.text(text).newline();
    return;
  }
  if (value && text.length + 1 + value.length <= p.width) {
    p.b.line(text, value);
    return;
  }
  for (const r of wrap(label, p.width - indent)) p.b.text(lead + r).newline();
  for (const r of wrap(value, p.width)) p.b.line('', r);
}

/** A bold row: a section's heading, NET SALES, EXPECTED CASH, COUNTED. */
function strongRow(p: Paper, label: string, amount = ''): void {
  p.b.bold(true);
  row(p, label, amount);
  p.b.bold(false);
}

const money = paperMoney;

/** Money taken away on paper: '-1,725.00' (0 stays '0.00'). */
function minus(cents: number): string {
  return paperMoney(-cents);
}

function sum(xs: readonly number[]): number {
  return xs.reduce((a, x) => a + x, 0);
}

/** "and 15 more" under a list cut at SHIFT_REPORT_LIST_MAX. */
function andMore(p: Paper, total: number, indent: number): void {
  if (total > SHIFT_REPORT_LIST_MAX) row(p, `and ${total - SHIFT_REPORT_LIST_MAX} more`, '', indent);
}

/** "01/10/2026 16:02" at 80 mm, "01/10 16:02" at 58 mm. */
function openCloseTime(p: Paper, at: string): string {
  return p.width >= 48 ? paperDateTime(at) : paperDayMonthClock(at);
}

// ---------------------------------------------------------------------------
// Header and footer

function appendHeader(p: Paper, r: ShiftReport, stamp: ShiftReportStamp | null): void {
  const { b, width } = p;
  b.align('center');
  if (stamp) appendDuplicateBand(p, stamp);
  b.bold(true).doubleSize(true).wrappedText('SHIFT REPORT', width / 2);
  b.doubleSize(false).bold(false);
  if (r.shopName.trim()) b.wrappedText(r.shopName.trim(), width);
  b.wrappedText(`Till: ${r.tillName}`, width);
  b.align('left');
  b.rule('-');
  row(p, `Opened ${openCloseTime(p, r.openedAt)}`, r.openedBy);
  row(p, `Closed ${openCloseTime(p, r.closedAt)}`, r.closedBy);
  if (r.pinOnLoginOf) row(p, `PIN on ${r.pinOnLoginOf}'s login`, '', 2);
  b.rule('=');
}

/** "Reprint #2", or "Reprint" when the print log could not say which. */
function reprintLabel(stamp: ShiftReportStamp): string {
  return Number.isInteger(stamp.reprintNo) && stamp.reprintNo > 0 ? `Reprint #${stamp.reprintNo}` : 'Reprint';
}

/** A row of stars, DUPLICATE in double size, which reprint, when and by whom, a row of stars. */
function appendDuplicateBand(p: Paper, stamp: ShiftReportStamp): void {
  const { b, width } = p;
  b.rule('*');
  b.bold(true).doubleSize(true).text('DUPLICATE').newline();
  b.doubleSize(false).bold(false);
  const facts = [reprintLabel(stamp), paperDateTime(stamp.at), stamp.byName ? `by ${stamp.byName}` : ''].filter((f) => f !== '');
  const joined = facts.join(' | ');
  if (ascii(joined).length <= width) b.text(joined).newline();
  else for (const f of facts) b.wrappedText(f, width);
  b.rule('*');
}

function appendFooter(p: Paper, opts: RenderShiftReportOpts, stamp: ShiftReportStamp | null): void {
  const { b, width } = p;
  const by = opts.printedByName.trim() ? ` by ${opts.printedByName.trim()}` : '';
  b.wrappedText(`Printed ${paperDateTime(opts.printedAt)}${by}`, width);
  // Right under 'Printed', as on the sample the owner was sent: this paper is not all of the report.
  if (SHIFT_REPORT_SECTIONS.some((s) => opts.sections[s.key] === false)) {
    for (const r of SECTIONS_OFF_ROWS) b.text(r).newline();
  }
  b.wrappedText('Sales = orders paid on this till this shift.', width);
  b.wrappedText('Figures as saved when the shift closed.', width);
  const deleted = opts.sinceClose?.testDeletedCashCents ?? 0;
  if (stamp && deleted !== 0) {
    b.wrappedText(`Since the close: test orders deleted, cash ${money(deleted)} (not taken off above)`, width);
  }
  b.align('center');
  b.text('-- END OF SHIFT REPORT --').newline();
  if (stamp) {
    b.text(reprintLabel(stamp) === 'Reprint' ? '** DUPLICATE **' : `** DUPLICATE - Reprint #${stamp.reprintNo} **`).newline();
  }
  b.align('left');
}

// ---------------------------------------------------------------------------
// Sections

/** "Sales tax 15%"; plain "Sales tax" when the rates were mixed. */
function taxLabel(bps: number | null): string {
  if (bps === null || !Number.isInteger(bps) || bps <= 0) return 'Sales tax';
  const pct = bps % 100 === 0 ? String(bps / 100) : (bps / 100).toFixed(2).replace(/0$/, '');
  return `Sales tax ${pct}%`;
}

/**
 * SALES: the orders settled on this till in this shift, gross; a refund
 * comes off at Refunds. Rows at 0 are left out, except Food, TOTAL and NET
 * SALES.
 */
function appendSales(p: Paper, r: ShiftReport): void {
  const s = r.sales;
  strongRow(p, 'SALES', `${s.orderCount} ${s.orderCount === 1 ? 'order' : 'orders'} paid`);
  row(p, 'Food', money(s.foodCents));
  if (s.delivery.cents !== 0) row(p, `Delivery charges (${s.delivery.orderCount})`, money(s.delivery.cents));
  const discounts = s.discounts.filter((d) => d.cents !== 0);
  if (discounts.length > 0) {
    row(p, `Discounts (${sum(discounts.map((d) => d.orderCount))})`, minus(sum(discounts.map((d) => d.cents))));
    for (const d of discounts) row(p, `${DISCOUNT_LABEL[d.kind] ?? d.kind} (${d.orderCount})`, minus(d.cents), 2);
  }
  if (s.taxCents !== 0) row(p, taxLabel(s.taxRateBps), money(s.taxCents));
  row(p, 'TOTAL (with tax)', money(s.billedCents));
  if (s.refunds.cents !== 0) row(p, `Refunds (${s.refunds.orderCount})`, minus(s.refunds.cents));
  strongRow(p, 'NET SALES', money(s.netCents));
  if (s.averageCents !== 0) row(p, 'Average bill', money(s.averageCents));
}

/**
 * MONEY TAKEN: each method's money in, then each method's money handed
 * back, then the TOTAL (= NET SALES). 'Part payments, other shifts' is a
 * guard: no flow makes it, so it prints only when something is wrong.
 */
function appendMoneyTaken(p: Paper, r: ShiftReport): void {
  strongRow(p, 'MONEY TAKEN');
  for (const m of r.payments) row(p, `${METHOD_LABEL[m.method] ?? m.method} (${m.orderCount})`, money(m.cents));
  for (const m of r.paymentRefunds) row(p, `${METHOD_LABEL[m.method] ?? m.method} refunds (${m.orderCount})`, minus(m.cents));
  row(p, 'TOTAL', money(r.moneyTakenCents));
  if (r.partPaymentsCents !== 0) row(p, 'Part payments, other shifts', money(r.partPaymentsCents), 2);
}

/**
 * BY CHANNEL, in Reports' order and words; own and outside riders under a
 * delivery channel that had an outside rider. 'own riders' is left out when
 * every one of its orders went with an outside rider (no '(0)' row, as
 * every other section leaves its rows at 0 out).
 */
function appendChannels(p: Paper, r: ShiftReport): void {
  if (r.channels.length === 0) {
    strongRow(p, 'BY CHANNEL: none');
    return;
  }
  strongRow(p, 'BY CHANNEL');
  for (const c of r.channels) {
    row(p, `${CHANNEL_LABEL[c.channel] ?? c.channel} (${c.orderCount})`, money(c.billedCents));
    if (c.outside) {
      const own = c.orderCount - c.outside.orderCount;
      if (own !== 0) row(p, `own riders (${own})`, money(c.billedCents - c.outside.billedCents), 2);
      row(p, `outside riders (${c.outside.orderCount})`, money(c.outside.billedCents), 2);
    }
  }
}

/** "made" / "not made" / "not asked" (nobody said whether the kitchen made it). */
function madeWord(made: ShiftReportCancelled['made']): string {
  return made === 'made' ? 'made' : made === 'not_made' ? 'not made' : 'not asked';
}

/**
 * One cancel or refund, indented 2: "#0021 21:14 made: Customer left" with
 * its amount when it fits; otherwise "#0021 21:14 made" with the amount and
 * the reason under it, indented 4.
 */
function entryRow(p: Paper, head: string, reason: string | null, amount: string): void {
  const why = reason?.trim() ? reason.trim() : null;
  if (why) {
    const full = `${head}: ${why}`;
    if (2 + ascii(full).length + 1 + amount.length <= p.width) {
      row(p, full, amount, 2);
      return;
    }
  }
  row(p, head, amount, 2);
  if (why) row(p, why, '', 4);
}

/** "1 made (food wasted), 1 not made"; at 58 mm, or when that is too long, "1 made, 1 not made". */
function madeSummary(p: Paper, cancelled: readonly ShiftReportCancelled[]): void {
  const count = (m: ShiftReportCancelled['made']) => cancelled.filter((c) => c.made === m).length;
  const parts = (long: boolean) =>
    [
      count('made') > 0 ? `${count('made')} made${long ? ' (food wasted)' : ''}` : null,
      count('not_made') > 0 ? `${count('not_made')} not made` : null,
      count(null) > 0 ? `${count(null)} not asked` : null,
    ]
      .filter((x): x is string => x !== null)
      .join(', ');
  const long = parts(true);
  row(p, 2 + long.length <= p.width ? long : parts(false), '', 2);
}

/**
 * CANCELLED AND REFUNDED: this till's orders cancelled in the shift (whether
 * the food was made), then the refunds handed back; each list stops at 10.
 * 'Refunded (n)' counts the orders as SALES' 'Refunds (n)' does (by the
 * order, not its number: the two tills number their orders apart, so two
 * orders can share one).
 */
function appendCancelsRefunds(p: Paper, r: ShiftReport): void {
  strongRow(p, 'CANCELLED AND REFUNDED');
  if (r.cancelled.length === 0 && r.refunds.length === 0) {
    row(p, 'No cancels or refunds');
    return;
  }
  if (r.cancelled.length > 0) {
    row(p, `Cancelled (${r.cancelled.length})`, money(sum(r.cancelled.map((c) => c.cents))));
    madeSummary(p, r.cancelled);
    for (const c of r.cancelled.slice(0, SHIFT_REPORT_LIST_MAX)) {
      entryRow(p, `${shortOrderNumber(c.orderNumber)} ${paperClock(c.at)} ${madeWord(c.made)}`, c.reason, money(c.cents));
    }
    andMore(p, r.cancelled.length, 2);
  }
  if (r.refunds.length > 0) {
    row(p, `Refunded (${r.sales.refunds.orderCount})`, money(sum(r.refunds.map((x) => x.cents))));
    for (const x of r.refunds.slice(0, SHIFT_REPORT_LIST_MAX)) entryRow(p, refundHead(x), x.reason, money(x.cents));
    andMore(p, r.refunds.length, 2);
  }
}

/**
 * "#0033 22:05 cash", "#0044 18:10 card, part": ', part' on a refund that
 * by itself handed back less than its order's total (full is false), so
 * an order refunded in two parts says part on both rows.
 */
function refundHead(x: ShiftReportRefund): string {
  const part = x.full ? '' : ', part';
  return `${shortOrderNumber(x.orderNumber)} ${paperClock(x.at)} ${METHOD_WORD[x.method] ?? x.method}${part}`;
}

/** "8 delivery charges kept", "4 delivery charges kept, 1 trip" — the close result's words. */
function riderParts(count: number, trips: number): string[] {
  const t = Math.min(count, Math.max(0, trips));
  const kept = Math.max(0, count - t);
  return [
    kept > 0 ? `${kept} ${kept === 1 ? 'delivery charge' : 'delivery charges'} kept` : null,
    t > 0 ? `${t} ${t === 1 ? 'trip' : 'trips'}` : null,
  ].filter((x): x is string => x !== null);
}

/**
 * CASH DRAWER, the close's own figures. Every row with an amount and no
 * indent adds up to EXPECTED CASH; 'rider tips' is a part of 'Cash taken
 * out' (as Shift history's 'Taken out' and the close result count it) and is
 * not taken off again.
 */
function appendDrawer(p: Paper, r: ShiftReport): void {
  const d = r.drawer;
  strongRow(p, 'CASH DRAWER');
  row(p, 'Opening float', money(d.openingCents));
  row(p, 'Cash sales', money(d.cashSalesCents));
  row(p, 'Cash refunds', minus(d.cashRefundsCents));
  if (d.cashIn.cents !== 0) row(p, `Cash put in (${d.cashIn.count})`, money(d.cashIn.cents));
  if (d.cashOut.cents !== 0) {
    row(p, `Cash taken out (${d.cashOut.count})`, minus(d.cashOut.cents));
    if (d.riderTips.cents !== 0) row(p, `rider tips (${d.riderTips.count})`, minus(d.riderTips.cents), 2);
  }
  if (d.riderKept.cents !== 0) {
    const n = d.riderKept.count;
    row(p, p.width >= 48 ? `Paid to outside riders (${n})` : `To outside riders (${n})`, minus(d.riderKept.cents));
    const parts = riderParts(n, d.riderKept.tripCount);
    const joined = parts.join(', ');
    if (parts.length > 0 && 2 + joined.length <= p.width) row(p, joined, '', 2);
    else for (const part of parts) row(p, part, '', 2);
  }
  if (d.otherCents !== 0) row(p, 'Other drawer changes', money(d.otherCents));
  strongRow(p, 'EXPECTED CASH', money(d.expectedCents));
}

/**
 * CASH COUNTED: each note row above 0 and 'Coins and other', COUNTED, then
 * SHORT / OVER / MATCHES EXPECTED in bold double height with the variance
 * as saved. Under Re 1 either way is MATCHES EXPECTED (cashVarianceVerdict,
 * the till's one rule): the count is in whole rupees and the tax leaves
 * paisa on the bills. Such a match that is not 0 says so under it, in
 * normal size: 'Paisa difference Rs 0.50'. A count not made by note (an
 * older close) prints COUNTED and the result only.
 */
function appendCounted(p: Paper, r: ShiftReport): void {
  const d = r.drawer;
  strongRow(p, 'CASH COUNTED');
  const notes = d.countedNotes;
  if (notes) {
    const rows = notes.notes.filter((n) => n.count > 0).sort((a, z) => z.faceCents - a.faceCents);
    for (const n of rows) row(p, `Rs ${paperRupees(n.faceCents)} x ${n.count}`, money(n.faceCents * n.count));
    if (notes.otherCents > 0) row(p, 'Coins and other', money(notes.otherCents));
  }
  strongRow(p, 'COUNTED', money(d.countedCents));
  const v = d.varianceCents;
  const verdict = cashVarianceVerdict(v);
  p.b.bold(true).doubleHeight(true);
  row(p, verdict === 'short' ? 'SHORT' : verdict === 'over' ? 'OVER' : 'MATCHES EXPECTED', paperSignedMoney(v));
  p.b.doubleHeight(false).bold(false);
  const paisa = cashPaisaDifferenceCents(v);
  if (paisa !== null) row(p, `${CASH_PAISA_DIFFERENCE_LABEL} Rs ${money(paisa)}`);
}

/**
 * UNPAID - CARRIED OVER: the close's own list (at most 10 rows) with the
 * manager's reason. A time on an earlier Pakistan day than the close prints
 * with its date.
 */
function appendUnpaid(p: Paper, r: ShiftReport): void {
  const u = r.unpaid;
  if (u.orders.length === 0) {
    strongRow(p, 'UNPAID - CARRIED OVER: none');
    return;
  }
  strongRow(p, `UNPAID - CARRIED OVER (${u.orders.length})`, money(sum(u.orders.map((o) => o.cents))));
  const closeDay = paperDateTime(r.closedAt).slice(0, 10);
  for (const o of u.orders.slice(0, SHIFT_REPORT_LIST_MAX)) {
    const when = paperDateTime(o.at).slice(0, 10) === closeDay ? paperClock(o.at) : paperDayMonthClock(o.at);
    row(p, `${shortOrderNumber(o.orderNumber)} ${when} ${o.takenBy}`, money(o.cents));
  }
  andMore(p, u.orders.length, 0);
  if (u.reason?.trim()) row(p, `Reason: ${u.reason.trim()}`);
}

/**
 * ITEMS SOLD: how many and for how much (the line totals, before discounts
 * and tax, so it equals Food), then each category in bold capitals in the
 * saved order ('PIZZA (26)'), and under it, with 'items', every item most
 * sold first ('5x Fajita Pizza - Medium'). No cap.
 */
function appendItems(p: Paper, r: ShiftReport): void {
  if (r.items.length === 0) {
    strongRow(p, 'ITEMS SOLD: none');
    return;
  }
  strongRow(p, `ITEMS SOLD (${sum(r.items.map((c) => c.quantity))})`, money(sum(r.items.map((c) => c.cents))));
  for (const c of r.items) {
    strongRow(p, `${c.category.toUpperCase()} (${c.quantity})`, money(c.cents));
    if (p.items === 'categories') continue;
    for (const i of c.items) row(p, `${i.quantity}x ${i.name}`, money(i.cents));
  }
}

/** "Takeaway, Cash", "Delivery, EasyPaisa + Cash (refunded)", "foodpanda, no payment". */
function orderWords(o: ShiftReportOrder): string {
  const methods = o.methods.length > 0 ? o.methods.map((m) => METHOD_LABEL[m] ?? m).join(' + ') : 'no payment';
  const refunded = o.refunded === 'full' ? ' (refunded)' : o.refunded === 'part' ? ' (part refunded)' : '';
  return `${CHANNEL_LABEL[o.channel] ?? o.channel}, ${methods}${refunded}`;
}

/**
 * ORDERS (the owner's 'All orders'): every order paid, in the order paid —
 * the same orders as SALES, so the heading's count and money are '<n>
 * orders paid' and TOTAL (with tax). Each order's number (as the cancel and
 * unpaid rows print it), when it was paid, its channel and how it was paid,
 * flagged when it was refunded, with its total. One row at 80 mm (a label
 * too long wraps, the total under it); two at 58 mm, the words indented 2.
 * No cap.
 */
function appendOrders(p: Paper, r: ShiftReport): void {
  if (r.orders.length === 0) {
    strongRow(p, 'ORDERS: none');
    return;
  }
  strongRow(p, `ORDERS (${r.orders.length})`, money(sum(r.orders.map((o) => o.totalCents))));
  for (const o of r.orders) {
    const head = `${shortOrderNumber(o.orderNumber)} ${paperClock(o.paidAt)}`;
    if (p.width >= 48) {
      row(p, `${head} ${orderWords(o)}`, money(o.totalCents));
    } else {
      row(p, head, money(o.totalCents));
      row(p, orderWords(o), '', 2);
    }
  }
}
