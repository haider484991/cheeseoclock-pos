/**
 * The shift report on paper (steps 19e-2 and 19e-3): the sample night
 * against the owner's sample papers at 80 mm (48 columns) and 58 mm (32) —
 * ITEMS SOLD and the ORDERS list included — every row within the paper,
 * Pakistan time whatever the PC's zone, the rules of each section and the
 * owner's switches.
 *
 * Six whole papers are pinned as goldens next to this file
 * (shift-report-*.golden.txt, the mock printer's text). A golden changes
 * only on purpose: run
 *   SHIFT_REPORT_GOLDENS=write npx vitest run src/shift-report.test.ts
 * in packages/printer-core, then read the diff (git diff) before committing.
 *
 * Every name, number and amount here is made up (the menu's item names are
 * the shop's own, public on its website).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SHIFT_REPORT_SECTIONS,
  type PrinterWidth,
  type ShiftReport,
  type ShiftReportCancelled,
  type ShiftReportOrder,
  type ShiftReportSection,
} from '@cheeseoclock/shared-types';
import { CUT_MARKER, QR_MARKER, decodeEscPos, escPosToText } from './escpos-decode.js';
import { drawerPulseBytes } from './escpos.js';
import { fingerprint } from './receipt-goldens.fixture.js';
import { renderShiftReport, SHIFT_REPORT_LIST_MAX, type RenderShiftReportOpts } from './shift-report.js';
import {
  QUIET_SHIFT_REPORT,
  SAMPLE_SHIFT_REPORT,
  SAMPLE_SHIFT_REPORT_FINGERPRINT,
  sampleNightAt,
  sampleNightOrderNumber,
} from './shift-report.fixture.js';

const ALL_ON = Object.fromEntries(SHIFT_REPORT_SECTIONS.map((s) => [s.key, true])) as Record<ShiftReportSection, boolean>;

/** The close of the sample night (01:48 on 2 Oct, Pakistan) and a reprint the next morning (09:15). */
const CLOSED_AT = SAMPLE_SHIFT_REPORT.closedAt;
const REPRINT_AT = '2026-10-02T04:15:00.000Z';

function opts(width: PrinterWidth, more: Partial<RenderShiftReportOpts> = {}): RenderShiftReportOpts {
  return { width, sections: ALL_ON, items: 'items', printedAt: CLOSED_AT, printedByName: 'Imran Ali', ...more };
}

const REPRINT: Partial<RenderShiftReportOpts> = {
  printedAt: REPRINT_AT,
  stamp: { reprintNo: 2, at: REPRINT_AT, byName: 'Imran Ali' },
  sinceClose: { testDeletedCashCents: 120_000 },
};

/** The quiet afternoon's paper, printed at its close (15:30 on 2 Oct, Pakistan). */
const QUIET: Partial<RenderShiftReportOpts> = { printedAt: QUIET_SHIFT_REPORT.closedAt };

/** The paper's rows as the mock printer writes them (centred rows lose their spaces). */
function rowsOf(report: ShiftReport, width: PrinterWidth, more: Partial<RenderShiftReportOpts> = {}): string[] {
  return escPosToText(renderShiftReport(report, opts(width, more))).split('\n');
}

const isRule = (row: string) => /^(-+|=+|\*+)$/.test(row);

/** The paper cut at its rules: the blocks of rows between them. */
function blocks(rows: readonly string[]): string[][] {
  const out: string[][] = [[]];
  for (const r of rows) {
    if (isRule(r)) out.push([]);
    else out[out.length - 1]!.push(r);
  }
  return out;
}

/**
 * The paper's blocks with the ORDERS block taken out (the owner's sample
 * paper has none; it came on its own excerpt): { rest, orders }.
 */
function withoutOrders(all: readonly string[][]): { rest: string[][]; orders: string[] } {
  const at = all.findIndex((b) => b[0]?.startsWith('ORDERS') === true);
  return { rest: all.filter((_, i) => i !== at), orders: at < 0 ? [] : all[at]! };
}

/** The rows of the section whose first row starts with `heading`, up to the next rule. */
function sectionRows(rows: readonly string[], heading: string): string[] {
  const start = rows.findIndex((r) => r.startsWith(heading));
  if (start < 0) return [];
  const end = rows.findIndex((r, i) => i > start && isRule(r));
  return rows.slice(start, end < 0 ? undefined : end);
}

/** '-1,725.00' -> -172500. */
function centsOf(amount: string): number {
  const m = /^(-?)([\d,]+)\.(\d{2})$/.exec(amount);
  if (!m) throw new Error(`Not an amount: ${amount}`);
  return (m[1] ? -1 : 1) * (Number(m[2]!.replace(/,/g, '')) * 100 + Number(m[3]));
}

/** A row's label and amount ('Cash sales   96,350.00'); null for a row with no amount. */
function amountRow(row: string): { label: string; cents: number } | null {
  const m = /^(.*?)\s+(-?[\d,]+\.\d{2})$/.exec(row);
  return m ? { label: m[1]!, cents: centsOf(m[2]!) } : null;
}

/**
 * The CASH DRAWER rows put back together: every row with an amount and no
 * indent, from Opening float to the row before EXPECTED CASH, and the
 * EXPECTED CASH printed.
 */
function drawerOnPaper(rows: readonly string[]): { parts: Array<{ label: string; cents: number }>; expected: number; indented: string[] } {
  const block = sectionRows(rows, 'CASH DRAWER');
  const last = block.findIndex((r) => r.startsWith('EXPECTED CASH'));
  const body = block.slice(1, last);
  const parts = body.filter((r) => /^\S/.test(r)).map(amountRow).filter((x): x is { label: string; cents: number } => x !== null);
  return { parts, expected: amountRow(block[last]!)!.cents, indented: body.filter((r) => /^\s/.test(r)) };
}

const sum = (xs: readonly number[]) => xs.reduce((a, x) => a + x, 0);

function containsBytes(bytes: Uint8Array, seq: readonly number[]): boolean {
  outer: for (let i = 0; i + seq.length <= bytes.length; i++) {
    for (let k = 0; k < seq.length; k++) if (bytes[i + k] !== seq[k]) continue outer;
    return true;
  }
  return false;
}

function withReport(change: (r: ShiftReport) => void): ShiftReport {
  const r = structuredClone(SAMPLE_SHIFT_REPORT);
  change(r);
  return r;
}

/** n cancels of made-up orders #0100 onwards, at 20:00, Rs 100 more each. */
function cancels(n: number, made: (i: number) => ShiftReportCancelled['made'] = (i) => (i % 2 ? 'made' : 'not_made')): ShiftReportCancelled[] {
  return Array.from({ length: n }, (_, i) => ({
    orderNumber: sampleNightOrderNumber(100 + i),
    at: sampleNightAt('20:00'),
    cents: 10_000 * (i + 1),
    made: made(i),
    reason: 'Customer left',
  }));
}

// ---------------------------------------------------------------------------
// The owner's sample papers (C:\Projects\coc-till-awake-notes\Sample-Shift-Report-80mm.txt
// and shift-report-design.json review.samplePaper58), block by block between the rules.
// Two rows differ from the hand-made sample, on purpose:
//  - 'Cash (38)', not (32): the till counts an order under every method it was
//    paid by (the split cash + card order and five outside riders' EasyPaisa +
//    cash settlements have a cash part), as pos-domain's builder does;
//  - the riders row is the close result's since v0.7.34, 'Paid to outside
//    riders (8)' with '8 delivery charges kept' under it, not 'Delivery charges
//    kept by riders (8)' ('To outside riders (8)' at 58 mm, not 'Kept by riders').
// The ORDERS list is not on that paper: its rows are the ORDERS excerpt's
// (C:\Projects\coc-till-awake-notes\Sample-Shift-Report-v2-orders.txt), but for
// #0007, which the excerpt flagged '(refunded)': the night's one refund is
// #0033 (CANCELLED AND REFUNDED says so), and #0033 is the row flagged here.

const TITLE = ['SHIFT REPORT', "Cheese O'Clock", 'Till: DESKTOP-7Q2M1KD'];

/** The sample paper's ITEMS SOLD at 80 mm, row for row. */
const ITEMS_80 = [
  'ITEMS SOLD (158)                      168,760.00',
  'SIGNATURE PIZZAS (22)                  48,400.00',
  '8x Shawarma Pizza - Large              17,600.00',
  '5x Crown Crust - Large                 11,000.00',
  '4x Cheesy Star - Large                  8,800.00',
  '3x Meat Lovers - Large                  6,600.00',
  '2x Cheetos - Large                      4,400.00',
  'PIZZA (26)                             45,500.00',
  '5x Fajita Pizza - Medium                7,500.00',
  '4x Chicken Tikka Pizza - Large          8,000.00',
  '4x Fajita Pizza - Large                 8,000.00',
  '4x Malai Supreme - Medium               6,000.00',
  '3x Classic Pepperoni - Large            6,000.00',
  '3x Cheesalious - Medium                 4,500.00',
  '2x Chicken Tikka Malai - Large          4,000.00',
  '1x Veggie Lovers - Medium               1,500.00',
  'BURGERS (19)                           16,050.00',
  '7x Crispy Signature                     5,600.00',
  '5x Nashville Authentic (Hot)            4,750.00',
  '4x Signature Cheese Dipped              3,600.00',
  '3x Classic Crispy Chicken               2,100.00',
  'FRIES & SIDES (23)                     13,410.00',
  '8x Fries - Large                        3,600.00',
  '6x Signature Loaded Fries               4,200.00',
  '4x Signature Mayo Masala Fries - Large  2,200.00',
  '3x Nuggets                              2,010.00',
  '2x Baked Wings                          1,400.00',
  'DIPS (29)                               2,900.00',
  '14x Signature Orange Dip                1,400.00',
  '9x Garlic Mayo Dip                        900.00',
  '6x Ranch Dip                              600.00',
  'VALUE DEALS (12)                       37,700.00',
  '5x Big Two                             18,000.00',
  '4x Perfect Pair                        10,400.00',
  '3x Family Feast                         9,300.00',
  'DRINKS (27)                             4,800.00',
  '15x Soft Drink - 345 ml                 1,800.00',
  '12x Soft Drink - 1 litre                3,000.00',
];

/** The ORDERS excerpt's first rows at 80 mm (#0007 not refunded, see above). */
const ORDERS_80_HEAD = [
  'ORDERS (62)                           189,911.00',
  '#0001 16:20 Takeaway, Cash              2,530.00',
  '#0002 16:41 Delivery, Cash              4,370.00',
  '#0003 17:05 foodpanda, foodpanda        2,645.00',
  '#0004 17:22 Takeaway, Card              1,725.00',
  '#0005 17:48 Website pick-up, Cash       2,898.00',
  '#0006 18:02 Delivery, EasyPaisa + Cash  4,370.00',
  '#0007 18:15 Takeaway, Cash              1,725.00',
  '#0008 18:31 Takeaway, JazzCash          3,565.00',
];

/** The ORDERS excerpt's rows at 58 mm: #0001 to #0004 in a row (the excerpt then skipped #0005). */
const ORDERS_58_HEAD = [
  'ORDERS (62)           189,911.00',
  '#0001 16:20             2,530.00',
  '  Takeaway, Cash',
  '#0002 16:41             4,370.00',
  '  Delivery, Cash',
  '#0003 17:05             2,645.00',
  '  foodpanda, foodpanda',
  '#0004 17:22             1,725.00',
  '  Takeaway, Card',
];
const ORDERS_58_0006 = ['#0006 18:02             4,370.00', '  Delivery, EasyPaisa + Cash', '#0007 18:15             1,725.00', '  Takeaway, Cash'];

const SAMPLE_80: string[][] = [
  TITLE,
  ['Opened 01/10/2026 16:02                 Ali Raza', 'Closed 02/10/2026 01:48                Imran Ali', "  PIN on Ali Raza's login"],
  [
    'SALES                             62 orders paid',
    'Food                                  168,760.00',
    'Delivery charges (18)                   4,000.00',
    'Discounts (16)                         -7,620.00',
    '  foodpanda deal (9)                   -4,860.00',
    '  Staff discounts (3)                  -1,640.00',
    '  Pick-up discount (2)                   -560.00',
    '  Automatic offers (2)                   -560.00',
    'Sales tax 15%                          24,771.00',
    'TOTAL (with tax)                      189,911.00',
    'Refunds (1)                            -1,725.00',
    'NET SALES                             188,186.00',
    'Average bill                            3,063.08',
  ],
  [
    'MONEY TAKEN',
    'Cash (38)                              96,350.00',
    'Card (12)                              35,260.00',
    'EasyPaisa (6)                          17,430.00',
    'JazzCash (3)                            9,200.00',
    'foodpanda (9)                          31,671.00',
    'Cash refunds (1)                       -1,725.00',
    'TOTAL                                 188,186.00',
  ],
  [
    'BY CHANNEL',
    'Takeaway (33)                          94,370.00',
    'Delivery (17)                          55,130.00',
    '  own riders (9)                       29,600.00',
    '  outside riders (8)                   25,530.00',
    'Website pick-up (2)                     5,796.00',
    'Website delivery (1)                    2,944.00',
    'foodpanda (9)                          31,671.00',
  ],
  [
    'CANCELLED AND REFUNDED',
    'Cancelled (2)                           3,450.00',
    '  1 made (food wasted), 1 not made',
    '  #0021 21:14 made: Customer left       2,070.00',
    '  #0047 23:40 not made: Wrong item rung 1,380.00',
    'Refunded (1)                            1,725.00',
    '  #0033 22:05 cash: Cold pizza          1,725.00',
  ],
  [
    'CASH DRAWER',
    'Opening float                           5,000.00',
    'Cash sales                             96,350.00',
    'Cash refunds                           -1,725.00',
    'Cash put in (1)                         2,000.00',
    'Cash taken out (5)                     -3,750.00',
    '  rider tips (3)                         -600.00',
    'Paid to outside riders (8)             -1,800.00',
    '  8 delivery charges kept',
    'EXPECTED CASH                          96,075.00',
  ],
  [
    'CASH COUNTED',
    'Rs 5,000 x 12                          60,000.00',
    'Rs 1,000 x 24                          24,000.00',
    'Rs 500 x 15                             7,500.00',
    'Rs 100 x 31                             3,100.00',
    'Rs 50 x 14                                700.00',
    'Rs 20 x 18                                360.00',
    'Rs 10 x 23                                230.00',
    'Coins and other                            85.00',
    'COUNTED                                95,975.00',
    'SHORT                                    -100.00',
  ],
  [
    'UNPAID - CARRIED OVER (2)               4,060.00',
    '#0064 01:12 Ali Raza                    2,470.00',
    '#0066 01:30 Website                     1,590.00',
    'Reason: Rider still out',
  ],
  ITEMS_80,
  [
    'Printed 02/10/2026 01:48 by Imran Ali',
    'Sales = orders paid on this till this shift.',
    'Figures as saved when the shift closed.',
    '-- END OF SHIFT REPORT --',
    '',
    '',
    '',
    '',
    '',
    '',
    CUT_MARKER,
  ],
];

const SAMPLE_58: string[][] = [
  TITLE,
  ['Opened 01/10 16:02      Ali Raza', 'Closed 02/10 01:48     Imran Ali', "  PIN on Ali Raza's login"],
  [
    'SALES             62 orders paid',
    'Food                  168,760.00',
    'Delivery charges (18)   4,000.00',
    'Discounts (16)         -7,620.00',
    '  foodpanda deal (9)   -4,860.00',
    '  Staff discounts (3)  -1,640.00',
    '  Pick-up discount (2)   -560.00',
    '  Automatic offers (2)   -560.00',
    'Sales tax 15%          24,771.00',
    'TOTAL (with tax)      189,911.00',
    'Refunds (1)            -1,725.00',
    'NET SALES             188,186.00',
    'Average bill            3,063.08',
  ],
  [
    'MONEY TAKEN',
    'Cash (38)              96,350.00',
    'Card (12)              35,260.00',
    'EasyPaisa (6)          17,430.00',
    'JazzCash (3)            9,200.00',
    'foodpanda (9)          31,671.00',
    'Cash refunds (1)       -1,725.00',
    'TOTAL                 188,186.00',
  ],
  [
    'BY CHANNEL',
    'Takeaway (33)          94,370.00',
    'Delivery (17)          55,130.00',
    '  own riders (9)       29,600.00',
    '  outside riders (8)   25,530.00',
    'Website pick-up (2)     5,796.00',
    'Website delivery (1)    2,944.00',
    'foodpanda (9)          31,671.00',
  ],
  [
    'CANCELLED AND REFUNDED',
    'Cancelled (2)           3,450.00',
    '  1 made, 1 not made',
    '  #0021 21:14 made      2,070.00',
    '    Customer left',
    '  #0047 23:40 not made  1,380.00',
    '    Wrong item rung',
    'Refunded (1)            1,725.00',
    '  #0033 22:05 cash      1,725.00',
    '    Cold pizza',
  ],
  [
    'CASH DRAWER',
    'Opening float           5,000.00',
    'Cash sales             96,350.00',
    'Cash refunds           -1,725.00',
    'Cash put in (1)         2,000.00',
    'Cash taken out (5)     -3,750.00',
    '  rider tips (3)         -600.00',
    'To outside riders (8)  -1,800.00',
    '  8 delivery charges kept',
    'EXPECTED CASH          96,075.00',
  ],
  [
    'CASH COUNTED',
    'Rs 5,000 x 12          60,000.00',
    'Rs 1,000 x 24          24,000.00',
    'Rs 500 x 15             7,500.00',
    'Rs 100 x 31             3,100.00',
    'Rs 50 x 14                700.00',
    'Rs 20 x 18                360.00',
    'Rs 10 x 23                230.00',
    'Coins and other            85.00',
    'COUNTED                95,975.00',
    'SHORT                    -100.00',
  ],
  [
    // The heading and its total cannot share 32 columns: the total sits under it.
    'UNPAID - CARRIED OVER (2)',
    '                        4,060.00',
    '#0064 01:12 Ali Raza    2,470.00',
    '#0066 01:30 Website     1,590.00',
    'Reason: Rider still out',
  ],
  [
    // An item and its amount that cannot share 32 columns: the amount sits right-aligned under it.
    'ITEMS SOLD (158)      168,760.00',
    'SIGNATURE PIZZAS (22)  48,400.00',
    '8x Shawarma Pizza - Large',
    '                       17,600.00',
    '5x Crown Crust - Large 11,000.00',
    '4x Cheesy Star - Large  8,800.00',
    '3x Meat Lovers - Large  6,600.00',
    '2x Cheetos - Large      4,400.00',
    'PIZZA (26)             45,500.00',
    '5x Fajita Pizza - Medium',
    '                        7,500.00',
    '4x Chicken Tikka Pizza - Large',
    '                        8,000.00',
    '4x Fajita Pizza - Large 8,000.00',
    '4x Malai Supreme - Medium',
    '                        6,000.00',
    '3x Classic Pepperoni - Large',
    '                        6,000.00',
    '3x Cheesalious - Medium 4,500.00',
    '2x Chicken Tikka Malai - Large',
    '                        4,000.00',
    '1x Veggie Lovers - Medium',
    '                        1,500.00',
    'BURGERS (19)           16,050.00',
    '7x Crispy Signature     5,600.00',
    '5x Nashville Authentic (Hot)',
    '                        4,750.00',
    '4x Signature Cheese Dipped',
    '                        3,600.00',
    '3x Classic Crispy Chicken',
    '                        2,100.00',
    'FRIES & SIDES (23)     13,410.00',
    '8x Fries - Large        3,600.00',
    '6x Signature Loaded Fries',
    '                        4,200.00',
    '4x Signature Mayo Masala Fries -',
    'Large',
    '                        2,200.00',
    '3x Nuggets              2,010.00',
    '2x Baked Wings          1,400.00',
    'DIPS (29)               2,900.00',
    '14x Signature Orange Dip',
    '                        1,400.00',
    '9x Garlic Mayo Dip        900.00',
    '6x Ranch Dip              600.00',
    'VALUE DEALS (12)       37,700.00',
    '5x Big Two             18,000.00',
    '4x Perfect Pair        10,400.00',
    '3x Family Feast         9,300.00',
    'DRINKS (27)             4,800.00',
    '15x Soft Drink - 345 ml 1,800.00',
    '12x Soft Drink - 1 litre',
    '                        3,000.00',
  ],
  [
    'Printed 02/10/2026 01:48 by',
    'Imran Ali',
    'Sales = orders paid on this till',
    'this shift.',
    'Figures as saved when the shift',
    'closed.',
    '-- END OF SHIFT REPORT --',
    '',
    '',
    '',
    '',
    '',
    '',
    CUT_MARKER,
  ],
];

/** Each switch's section, by the heading it starts with. */
const SECTION_HEADING: Record<ShiftReportSection, string> = {
  sales: 'SALES',
  moneyTaken: 'MONEY TAKEN',
  channels: 'BY CHANNEL',
  cancelsRefunds: 'CANCELLED AND REFUNDED',
  drawer: 'CASH DRAWER',
  counted: 'CASH COUNTED',
  unpaid: 'UNPAID - CARRIED OVER',
  items: 'ITEMS SOLD',
  orders: 'ORDERS',
};

const ALL_OFF = Object.fromEntries(SHIFT_REPORT_SECTIONS.map((s) => [s.key, false])) as Record<ShiftReportSection, boolean>;

/** Only these switches on. */
function onlyOn(...keys: ShiftReportSection[]): Record<ShiftReportSection, boolean> {
  return Object.fromEntries(SHIFT_REPORT_SECTIONS.map((s) => [s.key, keys.includes(s.key)])) as Record<ShiftReportSection, boolean>;
}

/** The footer's two rows when a switch is off. */
const SECTIONS_OFF = ['Some sections are off.', 'See Settings > Printers.'];

/** One order of the list. */
function order(n: number, more: Partial<ShiftReportOrder> = {}): ShiftReportOrder {
  return {
    orderNumber: sampleNightOrderNumber(n),
    paidAt: sampleNightAt('20:00'),
    channel: 'takeaway',
    outside: false,
    methods: ['cash'],
    totalCents: 100_000,
    refunded: 'no',
    ...more,
  };
}

/** A night that pushes every row: long names and reasons, big money, long lists, every guard row. */
function stressReport(): ShiftReport {
  return withReport((r) => {
    r.tillName = 'FRONT-COUNTER-TILL-WITH-A-VERY-LONG-WINDOWS-NAME (win32)';
    r.shopName = "Cheese O'Clock — Pizza, Burgers and Shakes, Main Boulevard Branch";
    r.openedBy = 'Muhammad Abdullah Khan Niazi';
    r.closedBy = 'Syeda Fatima Zahra Bukhari';
    r.pinOnLoginOf = 'Muhammad Abdullah Khan Niazi';
    r.sales.billedCents = 9_999_999_999;
    r.sales.taxRateBps = 1650;
    r.payments.push({ method: 'a_payment_method_this_version_does_not_know', orderCount: 1_234, cents: 9_999_999_999 });
    r.paymentRefunds.push({ method: 'bank_transfer', orderCount: 2, cents: 5_000 });
    r.partPaymentsCents = 120_000;
    r.channels.push({ channel: 'web_delivery', orderCount: 1_000, billedCents: 9_999_999_999, outside: { orderCount: 999, billedCents: 9_999_999_000 } });
    r.cancelled = cancels(25, (i) => (i % 3 === 0 ? 'made' : i % 3 === 1 ? 'not_made' : null)).map((c, i) => ({
      ...c,
      reason: i === 0 ? 'Customer waited forty minutes and left before the rider came back with the order' : c.reason,
    }));
    r.refunds = Array.from({ length: 12 }, (_, i) => ({
      orderNumber: sampleNightOrderNumber(200 + i),
      at: sampleNightAt('21:00'),
      method: i === 0 ? 'some_new_wallet' : 'card',
      cents: 99_999_999,
      full: i % 2 === 0,
      reason: 'The pizza was cold and the customer asked for the money back',
    }));
    r.drawer.riderKept = { count: 120, cents: 2_500_000, tripCount: 17 };
    r.drawer.otherCents = -123_456;
    r.unpaid.orders = Array.from({ length: 13 }, (_, i) => ({
      orderNumber: sampleNightOrderNumber(300 + i),
      at: i === 0 ? '2026-09-30T12:00:00.000Z' : sampleNightAt('01:00'),
      takenBy: i === 0 ? 'Syeda Fatima Zahra Bukhari Senior Cashier' : 'Website',
      cents: 99_999_999,
    }));
    r.unpaid.reason = 'The rider is still out with these orders and the customers will pay him at the door';
    r.items.push({
      category: 'Deals of the Week for the Whole Family — Bring Everyone Along',
      quantity: 99_999,
      cents: 9_999_999_999,
      items: [
        { name: 'Super Supreme Stuffed Crust Pizza with Extra Cheese — Family Size', quantity: 12_345, cents: 9_999_999_999 },
        { name: 'Kids meal', quantity: 1, cents: 0 },
      ],
    });
    r.orders.push(
      order(400, { channel: 'web_delivery', outside: true, methods: ['easypaisa', 'cash', 'a_payment_method_this_version_does_not_know'], totalCents: 9_999_999_999, refunded: 'part' }),
      order(401, { methods: [], totalCents: 0 }),
      order(402, { channel: 'a_channel_this_version_does_not_know' as unknown as ShiftReportOrder['channel'], refunded: 'full' }),
    );
  });
}

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

// ---------------------------------------------------------------------------

describe('the sample night (shift-report.fixture.ts)', () => {
  const r = SAMPLE_SHIFT_REPORT;

  it("is pos-domain's sample night put through buildShiftReport: the same JSON fingerprint as pos-domain pins", () => {
    expect(fingerprint(new TextEncoder().encode(JSON.stringify(r)))).toBe(SAMPLE_SHIFT_REPORT_FINGERPRINT);
  });

  it('adds up: 62 orders to TOTAL (with tax), the channels, the items to Food, MONEY TAKEN to NET SALES, the drawer and the notes', () => {
    expect(r.orders).toHaveLength(r.sales.orderCount);
    expect(sum(r.orders.map((o) => o.totalCents))).toBe(r.sales.billedCents);
    expect(sum(r.channels.map((c) => c.billedCents))).toBe(r.sales.billedCents);
    expect(sum(r.channels.map((c) => c.orderCount))).toBe(r.sales.orderCount);
    expect(sum(r.items.map((c) => c.cents))).toBe(r.sales.foodCents);
    const s = r.sales;
    expect(s.foodCents + s.delivery.cents - sum(s.discounts.map((d) => d.cents)) + s.taxCents).toBe(s.billedCents);
    expect(s.billedCents - s.refunds.cents).toBe(s.netCents);
    expect(sum(r.payments.map((m) => m.cents)) - sum(r.paymentRefunds.map((m) => m.cents))).toBe(r.moneyTakenCents);
    expect(r.moneyTakenCents).toBe(s.netCents);
    const d = r.drawer;
    expect(d.openingCents + d.cashSalesCents - d.cashRefundsCents + d.cashIn.cents - d.cashOut.cents - d.riderKept.cents + d.otherCents).toBe(
      d.expectedCents,
    );
    expect(sum(d.countedNotes!.notes.map((n) => n.faceCents * n.count)) + d.countedNotes!.otherCents).toBe(d.countedCents);
    expect(d.countedCents - d.expectedCents).toBe(d.varianceCents);
    expect(r.orders.filter((o) => o.refunded !== 'no').map((o) => o.orderNumber)).toEqual([r.refunds[0]!.orderNumber]);
  });
});

describe('the quiet afternoon (shift-report.fixture.ts)', () => {
  const r = QUIET_SHIFT_REPORT;

  it('adds up as the till’s would, and its drawer is Rs 0.50 over: a perfect count of a Rs 517.50 bill', () => {
    expect(r.orders).toHaveLength(r.sales.orderCount);
    expect(sum(r.orders.map((o) => o.totalCents))).toBe(r.sales.billedCents);
    expect(sum(r.channels.map((c) => c.billedCents))).toBe(r.sales.billedCents);
    expect(sum(r.items.map((c) => c.cents))).toBe(r.sales.foodCents);
    const s = r.sales;
    expect(s.foodCents + s.delivery.cents - sum(s.discounts.map((d) => d.cents)) + s.taxCents).toBe(s.billedCents);
    expect(s.taxCents).toBe(Math.round(((s.foodCents + s.delivery.cents) * 1500) / 10_000));
    expect(sum(r.payments.map((m) => m.cents)) - sum(r.paymentRefunds.map((m) => m.cents))).toBe(r.moneyTakenCents);
    expect(r.moneyTakenCents).toBe(s.netCents);
    const d = r.drawer;
    expect(d.openingCents + d.cashSalesCents - d.cashRefundsCents + d.cashIn.cents - d.cashOut.cents - d.riderKept.cents + d.otherCents).toBe(
      d.expectedCents,
    );
    expect(sum(d.countedNotes!.notes.map((n) => n.faceCents * n.count)) + d.countedNotes!.otherCents).toBe(d.countedCents);
    expect(d.countedCents - d.expectedCents).toBe(d.varianceCents);
    expect(d.varianceCents).toBe(50);
    expect(r.channels.find((c) => c.channel === 'delivery')?.outside?.orderCount).toBe(1);
  });
});

describe('renderShiftReport: the sample night at 80 mm (48 columns)', () => {
  const rows = rowsOf(SAMPLE_SHIFT_REPORT, 48);

  it("every block between the rules is the owner's sample paper's, ITEMS SOLD included; then ORDERS, last, as the excerpt", () => {
    const { rest, orders } = withoutOrders(blocks(rows));
    expect(rest).toEqual(SAMPLE_80);
    // ORDERS is the last section, right before the footer.
    expect(blocks(rows).at(-2)).toEqual(orders);
    expect(orders.slice(0, ORDERS_80_HEAD.length)).toEqual(ORDERS_80_HEAD);
    // The heading and one row per order paid: 63 rows, no cap.
    expect(orders).toHaveLength(1 + SAMPLE_SHIFT_REPORT.orders.length);
    expect(orders).toContain('#0033 21:31 Takeaway, Cash (refunded)   1,725.00');
    expect(orders.at(-1)).toBe('#0065 01:25 Takeaway, Cash              2,530.00');
  });

  it("the rules: '-' under the title, '=' after the times, '-' between sections, '=' before the footer", () => {
    expect(rows.filter(isRule)).toEqual(['-', '=', '-', '-', '-', '-', '-', '-', '-', '-', '='].map((c) => c.repeat(48)));
  });

  it("the title is bold double size: 'SHIFT REPORT' takes 24 columns", () => {
    const title = decodeEscPos(renderShiftReport(SAMPLE_SHIFT_REPORT, opts(48))).find((l) => l.text === 'SHIFT REPORT');
    expect(title?.scale).toBe(2);
  });
});

describe('renderShiftReport: the sample night at 58 mm (32 columns)', () => {
  const rows = rowsOf(SAMPLE_SHIFT_REPORT, 32);

  it("every block between the rules is the 58 mm sample's: dd/mm times, short made/not made, reasons under their order indented 4", () => {
    const { rest, orders } = withoutOrders(blocks(rows));
    expect(rest).toEqual(SAMPLE_58);
    expect(blocks(rows).at(-2)).toEqual(orders);
    // Two rows per order: the number and time with the total, then the words indented 2.
    expect(orders.slice(0, ORDERS_58_HEAD.length)).toEqual(ORDERS_58_HEAD);
    const at = orders.indexOf(ORDERS_58_0006[0]!);
    expect(orders.slice(at, at + ORDERS_58_0006.length)).toEqual(ORDERS_58_0006);
    expect(orders).toHaveLength(1 + 2 * SAMPLE_SHIFT_REPORT.orders.length);
    const flagged = orders.indexOf('#0033 21:31             1,725.00');
    expect(orders[flagged + 1]).toBe('  Takeaway, Cash (refunded)');
    expect(orders.slice(-2)).toEqual(['#0065 01:25             2,530.00', '  Takeaway, Cash']);
  });

  it('the same rules, 32 wide', () => {
    expect(rows.filter(isRule)).toEqual(['-', '=', '-', '-', '-', '-', '-', '-', '-', '-', '='].map((c) => c.repeat(32)));
  });
});

describe('every paper', () => {
  const reports: Array<[string, ShiftReport]> = [
    ['the sample night', SAMPLE_SHIFT_REPORT],
    ['a night that pushes every row', stressReport()],
    ['a quiet afternoon, Rs 0.50 over', QUIET_SHIFT_REPORT],
  ];
  const variants: Array<[string, Partial<RenderShiftReportOpts>]> = [
    ['original', {}],
    ['reprint', REPRINT],
    ['category totals', { items: 'categories' }],
    ['only the drawer, the count and unpaid', { sections: onlyOn('drawer', 'counted', 'unpaid') }],
    ['every section off', { sections: ALL_OFF }],
  ];

  for (const width of [48, 32] as const) {
    for (const [name, report] of reports) {
      for (const [variant, more] of variants) {
        it(`${width} columns, ${name}, ${variant}: every row fits, no '?', no drawer pulse, logo or QR, then the cut`, () => {
          const bytes = renderShiftReport(report, opts(width, more));
          const lines = decodeEscPos(bytes);
          for (const l of lines) expect(l.text.length * l.scale, l.text).toBeLessThanOrEqual(width);
          const text = lines.map((l) => l.text).join('\n');
          expect(text).not.toContain('?');
          expect(text).not.toContain('[drawer');
          expect(text).not.toContain('[logo');
          expect(text).not.toContain(QR_MARKER);
          // ESC p (the drawer pulse) and GS ( k (a QR code) never go out.
          expect(containsBytes(bytes, drawerPulseBytes().slice(0, 2))).toBe(false);
          expect(containsBytes(bytes, [0x1d, 0x28, 0x6b])).toBe(false);
          expect(lines.at(-1)?.text).toBe(CUT_MARKER);
          expect(lines.filter((l) => l.text === CUT_MARKER)).toHaveLength(1);
          // Nothing that is not the shop's to show staff.
          expect(/cost|profit|commission/i.test(text)).toBe(false);
        });
      }
    }
  }

  it('the same bytes whatever the PC’s zone: UTC, Asia/Karachi and America/New_York', () => {
    const papers = () =>
      [48, 32].flatMap((w) =>
        [{}, REPRINT, { items: 'categories' as const }].flatMap((more) =>
          [SAMPLE_SHIFT_REPORT, stressReport()].map((r) => fingerprint(renderShiftReport(r, opts(w as PrinterWidth, more)))),
        ),
      );
    const seen = ['UTC', 'Asia/Karachi', 'America/New_York'].map((zone) => {
      process.env.TZ = zone;
      return papers();
    });
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[2]).toEqual(seen[0]);
    // And the times are Pakistan's: opened 16:02 on 1 Oct, closed 01:48 on 2 Oct.
    process.env.TZ = 'America/New_York';
    expect(rowsOf(SAMPLE_SHIFT_REPORT, 48)).toContain('Closed 02/10/2026 01:48                Imran Ali');
    // An order paid five minutes after midnight in Pakistan (19:05 on 1 Oct in UTC).
    expect(rowsOf(SAMPLE_SHIFT_REPORT, 48)).toContain('#0060 00:05 Takeaway, Cash              1,725.00');
  });

  it('pure: the same report gives the same bytes, and the report is left as it was', () => {
    const before = JSON.stringify(SAMPLE_SHIFT_REPORT);
    const a = renderShiftReport(SAMPLE_SHIFT_REPORT, opts(48));
    const b = renderShiftReport(SAMPLE_SHIFT_REPORT, opts(48));
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(JSON.stringify(SAMPLE_SHIFT_REPORT)).toBe(before);
  });
});

describe('a long row wraps and keeps its indent', () => {
  it('58 mm: a cancel reason too long for its order row prints under it, indented 4 on every row', () => {
    const r = withReport((x) => {
      x.cancelled[0]!.reason = 'Customer waited forty minutes and left before the rider came back';
    });
    const block = sectionRows(rowsOf(r, 32), 'CANCELLED AND REFUNDED');
    const at = block.indexOf('  #0021 21:14 made      2,070.00');
    const reason = block.slice(at + 1, block.indexOf('  #0047 23:40 not made  1,380.00'));
    expect(reason.length).toBeGreaterThan(1);
    for (const r2 of reason) expect(r2).toMatch(/^ {4}\S/);
    expect(reason.map((x) => x.trim()).join(' ')).toBe('Customer waited forty minutes and left before the rider came back');
  });

  it('80 mm: the same reason goes on its own rows too, the amount staying on the order row', () => {
    const r = withReport((x) => {
      x.cancelled[0]!.reason = 'Customer waited forty minutes and left before the rider came back';
    });
    const block = sectionRows(rowsOf(r, 48), 'CANCELLED AND REFUNDED');
    const at = block.indexOf('  #0021 21:14 made                      2,070.00');
    expect(at).toBeGreaterThan(0);
    expect(block.slice(at + 1, at + 3)).toEqual(['    Customer waited forty minutes and left', '    before the rider came back']);
    // The next cancel's reason still fits on its row.
    expect(block[at + 3]).toBe('  #0047 23:40 not made: Wrong item rung 1,380.00');
  });

  it("an indent of 2 is kept too: '  outside riders (8)', and a made/not made line that wraps", () => {
    for (const width of [48, 32] as const) {
      expect(rowsOf(SAMPLE_SHIFT_REPORT, width).filter((x) => x.startsWith('  outside riders (8)'))).toHaveLength(1);
    }
    const r = withReport((x) => {
      x.cancelled = cancels(30, (i) => (i < 10 ? 'made' : i < 20 ? 'not_made' : null));
    });
    expect(sectionRows(rowsOf(r, 48), 'CANCELLED AND REFUNDED')[2]).toBe('  10 made, 10 not made, 10 not asked');
    const block58 = sectionRows(rowsOf(r, 32), 'CANCELLED AND REFUNDED');
    expect(block58.slice(2, 4)).toEqual(['  10 made, 10 not made, 10 not', '  asked']);
  });

  it('a name too long to share the row with its time sits right-aligned under it', () => {
    const r = withReport((x) => {
      x.openedBy = 'Muhammad Abdullah Khan Niazi';
    });
    const rows = rowsOf(r, 32);
    const at = rows.indexOf('Opened 01/10 16:02');
    expect(at).toBeGreaterThan(0);
    expect(rows[at + 1]).toBe('    Muhammad Abdullah Khan Niazi');
  });
});

describe('SALES', () => {
  it('an empty shift: 0 orders paid, Food, TOTAL and NET SALES at 0.00, every other row left out', () => {
    const r = withReport((x) => {
      x.sales = {
        orderCount: 0,
        foodCents: 0,
        delivery: { orderCount: 0, cents: 0 },
        discounts: [],
        taxCents: 0,
        taxRateBps: null,
        billedCents: 0,
        refunds: { orderCount: 0, cents: 0 },
        netCents: 0,
        averageCents: 0,
      };
    });
    expect(sectionRows(rowsOf(r, 48), 'SALES')).toEqual([
      'SALES                              0 orders paid',
      'Food                                        0.00',
      'TOTAL (with tax)                            0.00',
      'NET SALES                                   0.00',
    ]);
  });

  it("one order: '1 order paid'; mixed tax rates: 'Sales tax'; 16.5%: 'Sales tax 16.5%'", () => {
    const one = withReport((x) => {
      x.sales.orderCount = 1;
      x.sales.taxRateBps = null;
    });
    const rows = sectionRows(rowsOf(one, 48), 'SALES');
    expect(rows[0]).toBe('SALES                               1 order paid');
    expect(rows).toContain('Sales tax                              24,771.00');
    const odd = withReport((x) => {
      x.sales.taxRateBps = 1650;
    });
    expect(sectionRows(rowsOf(odd, 48), 'SALES')).toContain('Sales tax 16.5%                        24,771.00');
  });

  it('a Rs 0 discount kind is never printed or counted', () => {
    const r = withReport((x) => {
      x.sales.discounts.push({ kind: 'offer', orderCount: 4, cents: 0 });
    });
    const rows = sectionRows(rowsOf(r, 48), 'SALES');
    expect(rows).toContain('Discounts (16)                         -7,620.00');
    expect(rows.filter((x) => x.startsWith('  Automatic offers'))).toEqual(['  Automatic offers (2)                   -560.00']);
  });
});

describe('MONEY TAKEN', () => {
  it('a method this version does not know prints as stored; Bank transfer in words; refunds per method, negative', () => {
    const r = withReport((x) => {
      x.payments.push({ method: 'bank_transfer', orderCount: 2, cents: 400_000 }, { method: 'voucher', orderCount: 1, cents: 50_000 });
      x.paymentRefunds.push({ method: 'voucher', orderCount: 1, cents: 50_000 });
    });
    const rows = sectionRows(rowsOf(r, 48), 'MONEY TAKEN');
    expect(rows).toContain('Bank transfer (2)                       4,000.00');
    expect(rows).toContain('voucher (1)                               500.00');
    expect(rows).toContain('voucher refunds (1)                      -500.00');
  });

  it("'Part payments, other shifts' prints only when it is not 0, indented under TOTAL", () => {
    expect(rowsOf(SAMPLE_SHIFT_REPORT, 48).some((x) => x.includes('Part payments'))).toBe(false);
    const r = withReport((x) => {
      x.partPaymentsCents = 120_000;
    });
    const rows = sectionRows(rowsOf(r, 48), 'MONEY TAKEN');
    expect(rows.slice(-2)).toEqual(['TOTAL                                 188,186.00', '  Part payments, other shifts           1,200.00']);
  });
});

describe('BY CHANNEL', () => {
  it('own and outside riders under Website delivery too; the old channels in their words; none', () => {
    const r = withReport((x) => {
      x.channels = [
        { channel: 'web_delivery', orderCount: 3, billedCents: 900_000, outside: { orderCount: 1, billedCents: 300_000 } },
        { channel: 'dine_in', orderCount: 1, billedCents: 100_000, outside: null },
        { channel: 'online', orderCount: 1, billedCents: 100_000, outside: null },
      ];
    });
    expect(sectionRows(rowsOf(r, 48), 'BY CHANNEL')).toEqual([
      'BY CHANNEL',
      'Website delivery (3)                    9,000.00',
      '  own riders (2)                        6,000.00',
      '  outside riders (1)                    3,000.00',
      'Dine-in (old) (1)                       1,000.00',
      'Online (old) (1)                        1,000.00',
    ]);
    const none = withReport((x) => {
      x.channels = [];
    });
    expect(sectionRows(rowsOf(none, 48), 'BY CHANNEL')).toEqual(['BY CHANNEL: none']);
  });

  it("every delivery with an outside rider: 'outside riders' only, no 'own riders (0)' row (80 and 58 mm)", () => {
    const r = withReport((x) => {
      x.channels = [
        { channel: 'delivery', orderCount: 2, billedCents: 276_000, outside: { orderCount: 2, billedCents: 276_000 } },
        { channel: 'web_delivery', orderCount: 1, billedCents: 138_000, outside: { orderCount: 1, billedCents: 138_000 } },
      ];
    });
    expect(sectionRows(rowsOf(r, 48), 'BY CHANNEL')).toEqual([
      'BY CHANNEL',
      'Delivery (2)                            2,760.00',
      '  outside riders (2)                    2,760.00',
      'Website delivery (1)                    1,380.00',
      '  outside riders (1)                    1,380.00',
    ]);
    expect(sectionRows(rowsOf(r, 32), 'BY CHANNEL')).toEqual([
      'BY CHANNEL',
      'Delivery (2)            2,760.00',
      '  outside riders (2)    2,760.00',
      'Website delivery (1)    1,380.00',
      '  outside riders (1)    1,380.00',
    ]);
    expect(rowsOf(QUIET_SHIFT_REPORT, 48).some((x) => x.includes('own riders'))).toBe(false);
  });
});

describe('CANCELLED AND REFUNDED', () => {
  it('25 cancels: 10 rows, then "and 15 more"; the count and the money are all 25', () => {
    const r = withReport((x) => {
      x.cancelled = cancels(25);
    });
    for (const width of [48, 32] as const) {
      const block = sectionRows(rowsOf(r, width), 'CANCELLED AND REFUNDED');
      expect(amountRow(block[1]!)).toEqual({ label: 'Cancelled (25)', cents: sum(r.cancelled.map((c) => c.cents)) });
      expect(block.filter((x) => /^ {2}#01\d\d /.test(x))).toHaveLength(SHIFT_REPORT_LIST_MAX);
      expect(block).toContain('  and 15 more');
      expect(block.some((x) => x.includes('#0110'))).toBe(false);
    }
  });

  it('12 refunds: 10 rows, then "and 2 more"; Refunded counts orders, a part refund says part, an unknown method as stored', () => {
    const r = withReport((x) => {
      x.refunds = Array.from({ length: 12 }, (_, i) => ({
        orderNumber: sampleNightOrderNumber(i < 2 ? 200 : 200 + i),
        at: sampleNightAt('21:00'),
        method: i === 0 ? 'voucher' : 'card',
        cents: 10_000,
        full: i > 1,
        reason: 'Cold',
      }));
      x.sales.refunds = { orderCount: 11, cents: 120_000 };
    });
    const block = sectionRows(rowsOf(r, 48), 'CANCELLED AND REFUNDED');
    // #0200 was refunded twice (two parts): 11 orders, 12 refunds.
    expect(block).toContain('Refunded (11)                           1,200.00');
    expect(block).toContain('  #0200 21:00 voucher, part: Cold         100.00');
    expect(block).toContain('  #0200 21:00 card, part: Cold            100.00');
    expect(block).toContain('  #0202 21:00 card: Cold                  100.00');
    expect(block.filter((x) => x.startsWith('  #02'))).toHaveLength(SHIFT_REPORT_LIST_MAX);
    expect(block.at(-1)).toBe('  and 2 more');
  });

  it("two orders that share a number (one from each till) are 'Refunded (2)', as SALES says 'Refunds (2)'", () => {
    // Till A's 20261002-0001 paid on till B, and till B's own 20261002-0001: part refunds on both.
    const r = withReport((x) => {
      x.refunds = [
        { orderNumber: '20261002-0001', at: sampleNightAt('21:00'), method: 'cash', cents: 10_000, full: false, reason: 'Cold' },
        { orderNumber: '20261002-0001', at: sampleNightAt('21:10'), method: 'card', cents: 20_000, full: false, reason: 'Late' },
      ];
      x.sales.refunds = { orderCount: 2, cents: 30_000 };
    });
    for (const width of [48, 32] as const) {
      const rows = rowsOf(r, width);
      expect(amountRow(sectionRows(rows, 'SALES').find((x) => x.startsWith('Refunds'))!)).toEqual({ label: 'Refunds (2)', cents: -30_000 });
      expect(amountRow(sectionRows(rows, 'CANCELLED AND REFUNDED').find((x) => x.startsWith('Refunded'))!)).toEqual({
        label: 'Refunded (2)',
        cents: 30_000,
      });
    }
  });

  it("an order refunded in two parts says ', part' on both rows; one refund of the whole order says nothing", () => {
    const r = withReport((x) => {
      x.refunds = [
        { orderNumber: sampleNightOrderNumber(201), at: sampleNightAt('21:00'), method: 'card', cents: 50_000, full: false, reason: 'One part' },
        { orderNumber: sampleNightOrderNumber(201), at: sampleNightAt('21:05'), method: 'card', cents: 65_000, full: false, reason: 'Rest of it' },
        { orderNumber: sampleNightOrderNumber(202), at: sampleNightAt('21:10'), method: 'cash', cents: 115_000, full: true, reason: 'Cold' },
      ];
      x.sales.refunds = { orderCount: 2, cents: 230_000 };
    });
    expect(sectionRows(rowsOf(r, 48), 'CANCELLED AND REFUNDED').slice(-4)).toEqual([
      'Refunded (2)                            2,300.00',
      '  #0201 21:00 card, part: One part        500.00',
      '  #0201 21:05 card, part: Rest of it      650.00',
      '  #0202 21:10 cash: Cold                1,150.00',
    ]);
  });

  it("nobody said whether it was made: 'not asked'; a cancel with no reason prints its order row only", () => {
    const r = withReport((x) => {
      x.cancelled = [{ ...x.cancelled[0]!, made: null, reason: null }];
      x.refunds = [];
    });
    expect(sectionRows(rowsOf(r, 48), 'CANCELLED AND REFUNDED')).toEqual([
      'CANCELLED AND REFUNDED',
      'Cancelled (1)                           2,070.00',
      '  1 not asked',
      '  #0021 21:14 not asked                 2,070.00',
    ]);
  });

  it("none: 'No cancels or refunds'", () => {
    const r = withReport((x) => {
      x.cancelled = [];
      x.refunds = [];
    });
    expect(sectionRows(rowsOf(r, 32), 'CANCELLED AND REFUNDED')).toEqual(['CANCELLED AND REFUNDED', 'No cancels or refunds']);
  });
});

describe('CASH DRAWER', () => {
  for (const width of [48, 32] as const) {
    it(`${width} columns: the rows put back together give EXPECTED CASH; the rider tips are a part of Cash taken out, never taken off twice`, () => {
      const { parts, expected, indented } = drawerOnPaper(rowsOf(SAMPLE_SHIFT_REPORT, width));
      expect(expected).toBe(SAMPLE_SHIFT_REPORT.drawer.expectedCents);
      expect(sum(parts.map((x) => x.cents))).toBe(expected);
      const tips = indented.map(amountRow).find((x) => x?.label.trim() === 'rider tips (3)');
      expect(tips?.cents).toBe(-60_000);
      // Taking the tips off again would leave the drawer Rs 600 short of its own EXPECTED CASH.
      expect(sum(parts.map((x) => x.cents)) + tips!.cents).not.toBe(expected);
    });
  }

  it("a drawer change this version does not know prints as 'Other drawer changes' and still adds up", () => {
    const r = withReport((x) => {
      x.drawer.otherCents = -12_345;
      x.drawer.expectedCents -= 12_345;
    });
    const rows = rowsOf(r, 48);
    expect(sectionRows(rows, 'CASH DRAWER')).toContain('Other drawer changes                     -123.45');
    const { parts, expected } = drawerOnPaper(rows);
    expect(expected).toBe(9_595_155);
    expect(sum(parts.map((x) => x.cents))).toBe(expected);
    expect(rowsOf(SAMPLE_SHIFT_REPORT, 48).some((x) => x.startsWith('Other drawer changes'))).toBe(false);
  });

  it('riders paid for trips: the close result’s words, 80 and 58 mm', () => {
    const r = withReport((x) => {
      x.drawer.riderKept = { count: 5, cents: 100_000, tripCount: 1 };
      x.drawer.expectedCents += 80_000;
    });
    const at80 = sectionRows(rowsOf(r, 48), 'CASH DRAWER');
    expect(at80).toContain('Paid to outside riders (5)             -1,000.00');
    expect(at80[at80.indexOf('Paid to outside riders (5)             -1,000.00') + 1]).toBe('  4 delivery charges kept, 1 trip');
    const at58 = sectionRows(rowsOf(r, 32), 'CASH DRAWER');
    const i = at58.indexOf('To outside riders (5)  -1,000.00');
    expect(at58.slice(i + 1, i + 3)).toEqual(['  4 delivery charges kept', '  1 trip']);
    const trips = withReport((x) => {
      x.drawer.riderKept = { count: 2, cents: 40_000, tripCount: 2 };
    });
    expect(sectionRows(rowsOf(trips, 48), 'CASH DRAWER')).toContain('  2 trips');
  });

  it('a quiet drawer: Opening float, Cash sales and Cash refunds always; the rest only when not 0', () => {
    const r = withReport((x) => {
      const d = x.drawer;
      d.cashRefundsCents = 0;
      d.cashIn = { count: 0, cents: 0 };
      d.cashOut = { count: 0, cents: 0 };
      d.riderTips = { count: 0, cents: 0 };
      d.riderKept = { count: 0, cents: 0, tripCount: 0 };
      d.expectedCents = d.openingCents + d.cashSalesCents;
    });
    expect(sectionRows(rowsOf(r, 48), 'CASH DRAWER')).toEqual([
      'CASH DRAWER',
      'Opening float                           5,000.00',
      'Cash sales                             96,350.00',
      'Cash refunds                                0.00',
      'EXPECTED CASH                         101,350.00',
    ]);
  });
});

describe('CASH COUNTED', () => {
  it("OVER '+250.00', MATCHES EXPECTED '0.00', SHORT '-100.00', bold double height", () => {
    const over = withReport((x) => {
      x.drawer.countedNotes!.otherCents += 35_000;
      x.drawer.countedCents += 35_000;
      x.drawer.varianceCents = 25_000;
    });
    expect(sectionRows(rowsOf(over, 48), 'CASH COUNTED').slice(-2)).toEqual([
      'COUNTED                                96,325.00',
      'OVER                                     +250.00',
    ]);
    const even = withReport((x) => {
      x.drawer.countedNotes!.otherCents += 10_000;
      x.drawer.countedCents += 10_000;
      x.drawer.varianceCents = 0;
    });
    expect(sectionRows(rowsOf(even, 32), 'CASH COUNTED').at(-1)).toBe('MATCHES EXPECTED            0.00');
    const bytes = renderShiftReport(SAMPLE_SHIFT_REPORT, opts(48));
    // GS ! 1 (double height) then the SHORT row, then back to normal.
    const short = escPosToText(bytes).split('\n').indexOf('SHORT                                    -100.00');
    expect(short).toBeGreaterThan(0);
    expect(containsBytes(bytes, [0x1d, 0x21, 0x01, ...new TextEncoder().encode('SHORT')])).toBe(true);
  });

  it("under Re 1 either way is MATCHES EXPECTED with 'Paisa difference' under it in normal size; Re 1 is SHORT or OVER", () => {
    /** The sample night counted `variance` paisa off its expected cash (the coins carry the paisa: a made-up count). */
    const off = (variance: number) =>
      withReport((x) => {
        x.drawer.countedCents = x.drawer.expectedCents + variance;
        x.drawer.varianceCents = variance;
        x.drawer.countedNotes = null;
      });
    const tail = (variance: number, width: PrinterWidth) => sectionRows(rowsOf(off(variance), width), 'CASH COUNTED').slice(2);
    expect(tail(50, 48)).toEqual(['MATCHES EXPECTED                           +0.50', 'Paisa difference Rs 0.50']);
    expect(tail(-50, 48)).toEqual(['MATCHES EXPECTED                           -0.50', 'Paisa difference Rs 0.50']);
    expect(tail(99, 48)).toEqual(['MATCHES EXPECTED                           +0.99', 'Paisa difference Rs 0.99']);
    expect(tail(-99, 32)).toEqual(['MATCHES EXPECTED           -0.99', 'Paisa difference Rs 0.99']);
    expect(tail(0, 48)).toEqual(['MATCHES EXPECTED                            0.00']);
    expect(tail(-100, 48)).toEqual(['SHORT                                      -1.00']);
    expect(tail(100, 32)).toEqual(['OVER                       +1.00']);
    // The verdict in bold double height (ESC E 1, GS ! 1); the paisa back in normal size (GS ! 0, ESC E 0).
    const bytes = renderShiftReport(off(50), opts(48));
    const ascii = (s: string) => [...new TextEncoder().encode(s)];
    expect(containsBytes(bytes, [0x1b, 0x45, 0x01, 0x1d, 0x21, 0x01, ...ascii('MATCHES EXPECTED')])).toBe(true);
    expect(containsBytes(bytes, [0x1d, 0x21, 0x00, 0x1b, 0x45, 0x00, ...ascii('Paisa difference Rs 0.50')])).toBe(true);
    expect(decodeEscPos(bytes).find((l) => l.text === 'Paisa difference Rs 0.50')?.scale).toBe(1);
  });

  it('a count not made by note (an older close) prints COUNTED and the result only', () => {
    const r = withReport((x) => {
      x.drawer.countedNotes = null;
    });
    expect(sectionRows(rowsOf(r, 48), 'CASH COUNTED')).toEqual([
      'CASH COUNTED',
      'COUNTED                                95,975.00',
      'SHORT                                    -100.00',
    ]);
  });

  it('note rows at 0 and Coins and other at 0 are left out', () => {
    const r = withReport((x) => {
      x.drawer.countedNotes = { notes: [{ faceCents: 500_000, count: 0 }, { faceCents: 1_000, count: 3 }], otherCents: 0 };
    });
    expect(sectionRows(rowsOf(r, 48), 'CASH COUNTED').slice(1, -2)).toEqual(['Rs 10 x 3                                  30.00']);
  });
});

describe('UNPAID - CARRIED OVER', () => {
  it('an order from an earlier Pakistan day prints its date; more than 10 stop at 10', () => {
    const r = withReport((x) => {
      x.unpaid.orders = Array.from({ length: 13 }, (_, i) => ({
        orderNumber: sampleNightOrderNumber(300 + i),
        // #0300 was started on 30 Sep at 17:00 Pakistan time and carried over twice.
        at: i === 0 ? '2026-09-30T12:00:00.000Z' : sampleNightAt('01:00'),
        takenBy: 'Website',
        cents: 10_000,
      }));
    });
    const block = sectionRows(rowsOf(r, 48), 'UNPAID - CARRIED OVER');
    expect(block[0]).toBe('UNPAID - CARRIED OVER (13)              1,300.00');
    expect(block[1]).toBe('#0300 30/09 17:00 Website                 100.00');
    expect(block[2]).toBe('#0301 01:00 Website                       100.00');
    expect(block.filter((x) => x.startsWith('#03'))).toHaveLength(SHIFT_REPORT_LIST_MAX);
    expect(block.slice(-2)).toEqual(['and 3 more', 'Reason: Rider still out']);
  });

  it("none: 'UNPAID - CARRIED OVER: none', no reason", () => {
    const r = withReport((x) => {
      x.unpaid = { orders: [], reason: null };
    });
    expect(sectionRows(rowsOf(r, 48), 'UNPAID - CARRIED OVER')).toEqual(['UNPAID - CARRIED OVER: none']);
  });
});

/** The amount of the first row of `rows` that starts with `label`. */
function amountOf(rows: readonly string[], label: string): number {
  const found = rows.find((r) => r.startsWith(label));
  const parsed = found === undefined ? null : amountRow(found);
  if (!parsed) throw new Error(`No amount row: ${label}`);
  return parsed.cents;
}

const isItemRow = (r: string) => /^\d+x /.test(r);

describe('ITEMS SOLD', () => {
  it("80 mm, every item: the items add up to their category, the categories to ITEMS SOLD, and ITEMS SOLD is Food", () => {
    const rows = rowsOf(SAMPLE_SHIFT_REPORT, 48);
    const block = sectionRows(rows, 'ITEMS SOLD');
    const head = amountRow(block[0]!)!;
    expect(head.cents).toBe(amountOf(sectionRows(rows, 'SALES'), 'Food'));
    const groups: Array<{ label: string; cents: number; items: Array<{ label: string; cents: number }> }> = [];
    for (const r of block.slice(1)) {
      const parsed = amountRow(r)!;
      if (isItemRow(r)) groups.at(-1)!.items.push(parsed);
      else groups.push({ ...parsed, items: [] });
    }
    expect(groups.map((g) => g.label)).toEqual(SAMPLE_SHIFT_REPORT.items.map((c) => `${c.category.toUpperCase()} (${c.quantity})`));
    for (const g of groups) {
      expect(sum(g.items.map((i) => i.cents))).toBe(g.cents);
      const quantity = Number(/\((\d+)\)$/.exec(g.label)![1]);
      expect(sum(g.items.map((i) => Number(/^(\d+)x /.exec(i.label)![1])))).toBe(quantity);
    }
    expect(sum(groups.map((g) => g.cents))).toBe(head.cents);
    expect(head.label).toBe(`ITEMS SOLD (${sum(SAMPLE_SHIFT_REPORT.items.map((c) => c.quantity))})`);
  });

  it('the categories print bold, the items do not', () => {
    const bytes = renderShiftReport(SAMPLE_SHIFT_REPORT, opts(48));
    const enc = (s: string) => Array.from(new TextEncoder().encode(s));
    expect(containsBytes(bytes, [0x1b, 0x45, 0x01, ...enc('ITEMS SOLD (158)')])).toBe(true);
    expect(containsBytes(bytes, [0x1b, 0x45, 0x01, ...enc('PIZZA (26)')])).toBe(true);
    expect(containsBytes(bytes, [0x1b, 0x45, 0x01, ...enc('5x Fajita')])).toBe(false);
    expect(containsBytes(bytes, enc('5x Fajita Pizza - Medium'))).toBe(true);
  });

  it("'categories': the category rows only, no '5x ' rows, adding up to ITEMS SOLD, at 80 and 58 mm", () => {
    for (const width of [48, 32] as const) {
      const block = sectionRows(rowsOf(SAMPLE_SHIFT_REPORT, width, { items: 'categories' }), 'ITEMS SOLD');
      expect(block.some(isItemRow)).toBe(false);
      const cats = block.slice(1).map((r) => amountRow(r)!);
      expect(cats.map((c) => c.label)).toEqual(SAMPLE_SHIFT_REPORT.items.map((c) => `${c.category.toUpperCase()} (${c.quantity})`));
      expect(sum(cats.map((c) => c.cents))).toBe(amountRow(block[0]!)!.cents);
    }
    // Nothing else on the paper changes: it is the every-item paper without the item rows.
    const every = rowsOf(SAMPLE_SHIFT_REPORT, 48);
    expect(rowsOf(SAMPLE_SHIFT_REPORT, 48, { items: 'categories' })).toEqual(every.filter((r) => !isItemRow(r)));
  });

  it("none: 'ITEMS SOLD: none'; a line with no category prints under NO CATEGORY", () => {
    const none = withReport((x) => {
      x.items = [];
    });
    expect(sectionRows(rowsOf(none, 48), 'ITEMS SOLD')).toEqual(['ITEMS SOLD: none']);
    const other = withReport((x) => {
      x.items = [{ category: 'No category', quantity: 2, cents: 60_000, items: [{ name: 'Old menu item — Large', quantity: 2, cents: 60_000 }] }];
    });
    expect(sectionRows(rowsOf(other, 48), 'ITEMS SOLD')).toEqual([
      'ITEMS SOLD (2)                            600.00',
      'NO CATEGORY (2)                           600.00',
      '2x Old menu item - Large                  600.00',
    ]);
  });
});

describe('ORDERS', () => {
  it("80 mm: one row per order paid, in the order paid; the rows add up to TOTAL (with tax) and count '<n> orders paid'", () => {
    const rows = rowsOf(SAMPLE_SHIFT_REPORT, 48);
    const sales = sectionRows(rows, 'SALES');
    const paid = Number(/(\d+) orders paid$/.exec(sales[0]!)![1]);
    const total = amountOf(sales, 'TOTAL (with tax)');
    const block = sectionRows(rows, 'ORDERS');
    expect(amountRow(block[0]!)).toEqual({ label: `ORDERS (${paid})`, cents: total });
    const body = block.slice(1).map((r) => amountRow(r)!);
    expect(body).toHaveLength(paid);
    expect(sum(body.map((x) => x.cents))).toBe(total);
    for (const x of body) expect(x.label).toMatch(/^#\d{4} \d{2}:\d{2} \S/);
    // In the order paid, as saved: #0013 (paid 19:12) before #0012 (19:20).
    expect(body.map((x) => x.label.slice(0, 5))).toEqual(SAMPLE_SHIFT_REPORT.orders.map((o) => `#${o.orderNumber.slice(-4)}`));
    expect(body.findIndex((x) => x.label.startsWith('#0013 19:12'))).toBeLessThan(body.findIndex((x) => x.label.startsWith('#0012 19:20')));
    // A split payment, and two outside riders paid at the same minute.
    expect(block).toContain('#0062 00:40 Takeaway, Cash + Card       3,967.50');
    expect(block).toContain('#0040 22:50 Delivery, Cash              5,117.50');
    expect(block).toContain('#0045 22:50 Delivery, EasyPaisa + Cash  2,817.50');
  });

  it("58 mm: two rows per order, '#0012 16:20' with the total, then the words indented 2; the same sums", () => {
    const rows = rowsOf(SAMPLE_SHIFT_REPORT, 32);
    const block = sectionRows(rows, 'ORDERS');
    const total = amountOf(sectionRows(rows, 'SALES'), 'TOTAL (with tax)');
    expect(amountRow(block[0]!)).toEqual({ label: 'ORDERS (62)', cents: total });
    const body = block.slice(1);
    expect(body).toHaveLength(2 * 62);
    const heads: number[] = [];
    for (let i = 0; i < body.length; i += 2) {
      const head = amountRow(body[i]!)!;
      expect(head.label).toMatch(/^#\d{4} \d{2}:\d{2}$/);
      expect(body[i + 1]).toMatch(/^ {2}\S/);
      heads.push(head.cents);
    }
    expect(sum(heads)).toBe(total);
  });

  it("refunded in full '(refunded)', in part '(part refunded)'; methods in words joined ' + '; 'no payment'; unknown ones as stored", () => {
    const r = withReport((x) => {
      x.orders = [
        order(1, { refunded: 'full' }),
        order(2, { methods: ['card'], refunded: 'part' }),
        order(3, { channel: 'web_pickup', methods: ['bank_transfer'] }),
        order(4, { methods: [], totalCents: 0 }),
        order(5, { channel: 'foodpanda', methods: ['foodpanda'] }),
        order(6, { channel: 'dine_in', methods: ['voucher', 'jazzcash'] }),
      ];
    });
    expect(sectionRows(rowsOf(r, 48), 'ORDERS')).toEqual([
      'ORDERS (6)                              5,000.00',
      '#0001 20:00 Takeaway, Cash (refunded)   1,000.00',
      // The label alone fits 48 columns, but not with its total: the total goes under it.
      '#0002 20:00 Takeaway, Card (part refunded)',
      '                                        1,000.00',
      '#0003 20:00 Website pick-up, Bank transfer',
      '                                        1,000.00',
      '#0004 20:00 Takeaway, no payment            0.00',
      '#0005 20:00 foodpanda, foodpanda        1,000.00',
      '#0006 20:00 Dine-in (old), voucher + JazzCash',
      '                                        1,000.00',
    ]);
    expect(sectionRows(rowsOf(r, 32), 'ORDERS').slice(0, 5)).toEqual([
      'ORDERS (6)              5,000.00',
      '#0001 20:00             1,000.00',
      '  Takeaway, Cash (refunded)',
      '#0002 20:00             1,000.00',
      '  Takeaway, Card (part refunded)',
    ]);
  });

  it('a label too long for 80 mm wraps, the total under it; at 58 mm the words wrap keeping their indent of 2', () => {
    const r = withReport((x) => {
      x.orders = [order(7, { channel: 'web_delivery', outside: true, methods: ['easypaisa', 'cash'], refunded: 'part', totalCents: 1_234_567 })];
    });
    expect(sectionRows(rowsOf(r, 48), 'ORDERS').slice(1)).toEqual([
      '#0007 20:00 Website delivery, EasyPaisa + Cash',
      '(part refunded)',
      '                                       12,345.67',
    ]);
    expect(sectionRows(rowsOf(r, 32), 'ORDERS').slice(1)).toEqual([
      '#0007 20:00            12,345.67',
      '  Website delivery, EasyPaisa +',
      '  Cash (part refunded)',
    ]);
  });

  it('no cap: 150 orders print 150 orders', () => {
    const r = withReport((x) => {
      x.orders = Array.from({ length: 150 }, (_, i) => order(1000 + i));
    });
    expect(sectionRows(rowsOf(r, 48), 'ORDERS')).toHaveLength(1 + 150);
    expect(sectionRows(rowsOf(r, 32), 'ORDERS')).toHaveLength(1 + 2 * 150);
    expect(sectionRows(rowsOf(r, 48), 'ORDERS').some((x) => x.includes('more'))).toBe(false);
  });

  it("none: 'ORDERS: none'", () => {
    const r = withReport((x) => {
      x.orders = [];
    });
    expect(sectionRows(rowsOf(r, 32), 'ORDERS')).toEqual(['ORDERS: none']);
  });
});

/** The footer block of a paper whose sections are all on, with the two 'sections off' rows under 'Printed'. */
function footerWithOff(footer: readonly string[]): string[] {
  const at = footer.findIndex((r) => r.startsWith('Printed'));
  // At 58 mm the 'Printed ... by NAME' row wraps over two rows.
  const end = footer[at]!.endsWith('Imran Ali') ? at + 1 : at + 2;
  return [...footer.slice(0, end), ...SECTIONS_OFF, ...footer.slice(end)];
}

describe("the owner's switches change only what prints", () => {
  it('the nine switches are the nine sections, in the order they print', () => {
    const rows = rowsOf(SAMPLE_SHIFT_REPORT, 48);
    const starts = SHIFT_REPORT_SECTIONS.map((s) => rows.findIndex((r) => r.startsWith(SECTION_HEADING[s.key])));
    expect(starts.every((i) => i > 0)).toBe(true);
    expect([...starts].sort((a, z) => a - z)).toEqual(starts);
  });

  for (const [key, heading] of Object.entries(SECTION_HEADING) as Array<[ShiftReportSection, string]>) {
    it(`'${key}' off leaves out exactly ${heading}, and the footer says some sections are off`, () => {
      const all = rowsOf(SAMPLE_SHIFT_REPORT, 48);
      const off = rowsOf(SAMPLE_SHIFT_REPORT, 48, { sections: { ...ALL_ON, [key]: false } });
      expect(off.some((x) => x.startsWith(heading))).toBe(false);
      for (const other of Object.values(SECTION_HEADING).filter((h) => h !== heading)) {
        expect(off.some((x) => x.startsWith(other))).toBe(true);
      }
      // The rest of the paper is unchanged: exactly that section and one rule fewer, and the footer's two rows.
      const gone = sectionRows(all, heading);
      expect(off.length).toBe(all.length - gone.length - 1 + SECTIONS_OFF.length);
      expect(blocks(off).at(-1)).toEqual(footerWithOff(SAMPLE_80.at(-1)!));
      expect(off.filter((x) => !SECTIONS_OFF.includes(x))).toEqual(
        all.filter((_, i) => {
          const start = all.indexOf(gone[0]!);
          // The section and the rule before it (after it, for the first section).
          const rule = start === all.findIndex((r) => r.startsWith('SALES')) ? start + gone.length : start - 1;
          return !(i >= start && i < start + gone.length) && i !== rule;
        }),
      );
    });
  }

  it("all on: no 'Some sections are off'", () => {
    for (const width of [48, 32] as const) {
      expect(rowsOf(SAMPLE_SHIFT_REPORT, width).some((x) => SECTIONS_OFF.includes(x))).toBe(false);
    }
  });

  it("ITEMS SOLD off: ORDERS still prints last; ORDERS off: ITEMS SOLD is last, right before the footer's '=' rule", () => {
    const noItems = blocks(rowsOf(SAMPLE_SHIFT_REPORT, 48, { sections: { ...ALL_ON, items: false } }));
    expect(noItems.at(-2)?.[0]).toBe(ORDERS_80_HEAD[0]);
    expect(noItems.at(-3)?.[0]).toBe('UNPAID - CARRIED OVER (2)               4,060.00');
    const noOrders = blocks(rowsOf(SAMPLE_SHIFT_REPORT, 48, { sections: { ...ALL_ON, orders: false } }));
    expect(noOrders.at(-2)).toEqual(ITEMS_80);
  });

  it('every section off: the header and the footer only, the footer saying so (80 and 58 mm)', () => {
    expect(blocks(rowsOf(SAMPLE_SHIFT_REPORT, 48, { sections: ALL_OFF }))).toEqual([SAMPLE_80[0], SAMPLE_80[1], footerWithOff(SAMPLE_80.at(-1)!)]);
    const at58 = blocks(rowsOf(SAMPLE_SHIFT_REPORT, 32, { sections: ALL_OFF }));
    expect(at58).toEqual([SAMPLE_58[0], SAMPLE_58[1], footerWithOff(SAMPLE_58.at(-1)!)]);
    expect(at58.at(-1)!.slice(0, 4)).toEqual(['Printed 02/10/2026 01:48 by', 'Imran Ali', 'Some sections are off.', 'See Settings > Printers.']);
  });

  it('a switch the options leave out counts as on (the owner’s default); a key the paper does not know changes nothing', () => {
    const partial = { sales: false } as unknown as Record<ShiftReportSection, boolean>;
    const rows = rowsOf(SAMPLE_SHIFT_REPORT, 48, { sections: partial });
    expect(rows.some((x) => x.startsWith('SALES'))).toBe(false);
    expect(rows.some((x) => x.startsWith('CASH DRAWER'))).toBe(true);
    expect(rows.some((x) => x.startsWith('ORDERS'))).toBe(true);
    expect(rows).toContain(SECTIONS_OFF[0]);
    const unknown = { ...ALL_ON, aSectionFromANewerTill: false } as unknown as Record<ShiftReportSection, boolean>;
    expect(fingerprint(renderShiftReport(SAMPLE_SHIFT_REPORT, opts(48, { sections: unknown })))).toBe(
      fingerprint(renderShiftReport(SAMPLE_SHIFT_REPORT, opts(48))),
    );
  });

  it('switched off and on again: the same paper, from the same saved report', () => {
    const before = fingerprint(renderShiftReport(SAMPLE_SHIFT_REPORT, opts(32)));
    renderShiftReport(SAMPLE_SHIFT_REPORT, opts(32, { sections: ALL_OFF }));
    expect(fingerprint(renderShiftReport(SAMPLE_SHIFT_REPORT, opts(32)))).toBe(before);
  });
});

describe('a reprint', () => {
  it('80 mm: the DUPLICATE band, the same figures, the reprint footer and what changed since the close', () => {
    const lines = decodeEscPos(renderShiftReport(SAMPLE_SHIFT_REPORT, opts(48, REPRINT)));
    const rows = lines.map((l) => l.text);
    expect(rows.slice(0, 5)).toEqual(['*'.repeat(48), 'DUPLICATE', 'Reprint #2 | 02/10/2026 09:15 | by Imran Ali', '*'.repeat(48), 'SHIFT REPORT']);
    expect(lines[1]?.scale).toBe(2);
    // Every figure as the first paper printed them, the orders list included.
    const { rest, orders } = withoutOrders(blocks(rows.slice(4)));
    expect(rest.slice(0, -1)).toEqual(SAMPLE_80.slice(0, -1));
    expect(orders).toEqual(withoutOrders(blocks(rowsOf(SAMPLE_SHIFT_REPORT, 48))).orders);
    expect(blocks(rows).at(-1)).toEqual([
      'Printed 02/10/2026 09:15 by Imran Ali',
      'Sales = orders paid on this till this shift.',
      'Figures as saved when the shift closed.',
      'Since the close: test orders deleted, cash',
      '1,200.00 (not taken off above)',
      '-- END OF SHIFT REPORT --',
      '** DUPLICATE - Reprint #2 **',
      '',
      '',
      '',
      '',
      '',
      '',
      CUT_MARKER,
    ]);
  });

  it('58 mm: the band one fact per row', () => {
    expect(rowsOf(SAMPLE_SHIFT_REPORT, 32, REPRINT).slice(0, 6)).toEqual([
      '*'.repeat(32),
      'DUPLICATE',
      'Reprint #2',
      '02/10/2026 09:15',
      'by Imran Ali',
      '*'.repeat(32),
    ]);
  });

  it("'Since the close' only on a reprint, and only when something changed", () => {
    const has = (more: Partial<RenderShiftReportOpts>) => rowsOf(SAMPLE_SHIFT_REPORT, 48, more).some((x) => x.startsWith('Since the close'));
    expect(has({ sinceClose: { testDeletedCashCents: 120_000 } })).toBe(false);
    expect(has({ ...REPRINT, sinceClose: { testDeletedCashCents: 0 } })).toBe(false);
    expect(has({ ...REPRINT, sinceClose: null })).toBe(false);
    expect(has(REPRINT)).toBe(true);
    const back = rowsOf(SAMPLE_SHIFT_REPORT, 48, { ...REPRINT, sinceClose: { testDeletedCashCents: -50_000 } });
    expect(back).toContain('Since the close: test orders deleted, cash');
    expect(back).toContain('-500.00 (not taken off above)');
  });

  it("a reprint the print log could not number: 'Reprint' and '** DUPLICATE **'", () => {
    const rows = rowsOf(SAMPLE_SHIFT_REPORT, 48, { ...REPRINT, stamp: { reprintNo: 0, at: REPRINT_AT, byName: null } });
    expect(rows[2]).toBe('Reprint | 02/10/2026 09:15');
    expect(rows).toContain('** DUPLICATE **');
  });

  it('the first paper has no band and no DUPLICATE', () => {
    expect(rowsOf(SAMPLE_SHIFT_REPORT, 48).some((x) => x.includes('DUPLICATE'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The goldens: four whole papers of the sample night and two of the quiet
// afternoon (v0.7.35 review: the paisa match, outside riders only), row for
// row, as the mock printer writes them (escPosToText; centred rows lose their
// spaces).

/** The golden papers: file name next to this test, and the paper. */
const GOLDENS: ReadonlyArray<readonly [string, () => Uint8Array]> = [
  // Every section and every item, 80 mm.
  ['shift-report-80.golden.txt', () => renderShiftReport(SAMPLE_SHIFT_REPORT, opts(48))],
  // Every section and every item, 58 mm.
  ['shift-report-58.golden.txt', () => renderShiftReport(SAMPLE_SHIFT_REPORT, opts(32))],
  // Only the drawer, the count and the unpaid orders on, 80 mm.
  ['shift-report-80-sections.golden.txt', () => renderShiftReport(SAMPLE_SHIFT_REPORT, opts(48, { sections: onlyOn('drawer', 'counted', 'unpaid') }))],
  // Reprint #2 the next morning, Rs 1,200 of test orders deleted since the close, 80 mm.
  ['shift-report-80-reprint.golden.txt', () => renderShiftReport(SAMPLE_SHIFT_REPORT, opts(48, REPRINT))],
  // A quiet afternoon counted Rs 0.50 over (MATCHES EXPECTED, the paisa under it), its one delivery with an outside rider, 80 mm.
  ['shift-report-80-quiet.golden.txt', () => renderShiftReport(QUIET_SHIFT_REPORT, opts(48, QUIET))],
  // The same, 58 mm.
  ['shift-report-58-quiet.golden.txt', () => renderShiftReport(QUIET_SHIFT_REPORT, opts(32, QUIET))],
];

const goldenPath = (file: string) => fileURLToPath(new URL(`./${file}`, import.meta.url));

/** A golden as saved (a Windows checkout may have turned its line ends into CRLF). */
const readGolden = (file: string) => readFileSync(goldenPath(file), 'utf8').replace(/\r\n/g, '\n');

describe('the goldens', () => {
  for (const [file, paper] of GOLDENS) {
    it(`${file} is the paper, row for row`, () => {
      const text = `${escPosToText(paper())}\n`;
      // Only on purpose (see the top of this file), and the diff read before it is committed.
      if (process.env.SHIFT_REPORT_GOLDENS === 'write') writeFileSync(goldenPath(file), text);
      expect(readGolden(file)).toBe(text);
    });
  }

  /** The golden's rows on paper: the feed before the cut and the cut left out. */
  const paperRows = (file: string) => readGolden(file).split('\n').slice(0, -1 - 1 - 6);

  it("80 mm: the sample paper's 118 rows (one more for the riders' words), then the ORDERS rule, heading and 62 orders", () => {
    const rows = paperRows('shift-report-80.golden.txt');
    expect(rows.at(-1)).toBe('-- END OF SHIFT REPORT --');
    expect(rows).toHaveLength(118 + 1 + 1 + 63);
    expect(sectionRows(rows, 'ITEMS SOLD')).toHaveLength(38);
    expect(sectionRows(rows, 'ORDERS')).toHaveLength(63);
  });

  it('58 mm: 140 rows (one more for the riders’ words), then the ORDERS rule, heading and two rows for each of the 62 orders', () => {
    const rows = paperRows('shift-report-58.golden.txt');
    expect(rows.at(-1)).toBe('-- END OF SHIFT REPORT --');
    expect(rows).toHaveLength(140 + 1 + 1 + 125);
    expect(sectionRows(rows, 'ORDERS')).toHaveLength(125);
  });

  it('only the drawer, the count and unpaid: those three sections, and the footer says some are off', () => {
    const rows = paperRows('shift-report-80-sections.golden.txt');
    const headings = Object.values(SECTION_HEADING).filter((h) => rows.some((r) => r.startsWith(h)));
    expect(headings).toEqual(['CASH DRAWER', 'CASH COUNTED', 'UNPAID - CARRIED OVER']);
    expect(rows).toContain(SECTIONS_OFF[0]);
    expect(rows).toContain(SECTIONS_OFF[1]);
  });

  it('the reprint: DUPLICATE at the top and the bottom, and what changed since the close', () => {
    const rows = paperRows('shift-report-80-reprint.golden.txt');
    expect(rows.slice(0, 3)).toEqual(['*'.repeat(48), 'DUPLICATE', 'Reprint #2 | 02/10/2026 09:15 | by Imran Ali']);
    expect(rows.at(-1)).toBe('** DUPLICATE - Reprint #2 **');
    expect(rows).toContain('Since the close: test orders deleted, cash');
  });

  it('the quiet afternoon: Rs 0.50 over reads MATCHES EXPECTED with the paisa under it; Delivery has outside riders only', () => {
    for (const [file, width] of [
      ['shift-report-80-quiet.golden.txt', 48],
      ['shift-report-58-quiet.golden.txt', 32],
    ] as const) {
      const rows = paperRows(file);
      const counted = sectionRows(rows, 'CASH COUNTED');
      expect(counted.slice(-2).map((x) => x.replace(/ +/g, ' '))).toEqual(['MATCHES EXPECTED +0.50', 'Paisa difference Rs 0.50']);
      expect(rows.some((x) => /^(SHORT|OVER)/.test(x))).toBe(false);
      const channels = sectionRows(rows, 'BY CHANNEL');
      expect(channels.map((x) => x.replace(/ +/g, ' '))).toEqual([
        'BY CHANNEL',
        'Takeaway (1) 517.50',
        'Delivery (1) 1,150.00',
        ' outside riders (1) 1,150.00',
      ]);
      expect(rows.every((x) => x.length <= width)).toBe(true);
    }
  });
});
