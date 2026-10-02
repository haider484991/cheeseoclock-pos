/**
 * The shift report (shared-types shift-report.ts ShiftReport), worked out
 * from the rows the till read at the close (owner, 2 Oct 2026: "while
 * closing there should full sales from printer").
 *
 * ShiftReportFacts is what the main process reads inside the close (the
 * service of step 19d-3); buildShiftReport turns it into the report; and
 * shiftReportJson is the one writer of shifts.close_report_json (migration
 * 0051). Nothing here reads the database, a setting or the clock, so the
 * tests pin every figure.
 *
 * The bases (see the type's header):
 *  - SALES, BY CHANNEL, ITEMS SOLD and ORDERS count the orders SETTLED on
 *    this till in this shift, GROSS: an order refunded later, or in this
 *    shift, stays in them (ORDERS flags it), and its money comes off at
 *    Refunds.
 *  - MONEY TAKEN counts the payment rows of this shift on this till (money
 *    in, money handed back). NET SALES and MONEY TAKEN are the same figure
 *    in every flow today, because every order's money comes in at one time
 *    and equals its total; partPaymentsCents is the guard that prints only
 *    when they are not.
 *  - CASH DRAWER is copied from the close's own figures, never worked out
 *    again, so the paper always shows the close's EXPECTED CASH.
 *
 * Money in integer cents. No food cost, waste rupees, commission or profit
 * is read or worked out here.
 *
 * Pure. buildShiftReport never throws on what it is given: an empty shift
 * is all zeros and empty lists.
 */
import type {
  CashCount,
  OrderStatus,
  ReportChannel,
  ShiftReport,
  ShiftReportCancelled,
  ShiftReportCategory,
  ShiftReportChannelLine,
  ShiftReportCountCents,
  ShiftReportDiscountKind,
  ShiftReportDiscountLine,
  ShiftReportDrawer,
  ShiftReportMoneyLine,
  ShiftReportOrder,
  ShiftReportRefund,
  ShiftReportSales,
  ShiftReportUnpaid,
} from '@cheeseoclock/shared-types';
import { SHIFT_REPORT_VERSION } from '@cheeseoclock/shared-types';

// -----------------------------------------------------------------------------
// The facts: what the till reads at the close
// -----------------------------------------------------------------------------

/** An order settled on this till in this shift (its money taken here). */
export interface ShiftReportFactsOrder {
  id: string;
  orderNumber: string;
  /** Reports' channel of the order (analytics channelOf(mode, source)). */
  channel: ReportChannel;
  /** Sent out with an outside rider (orders.rider_keeps_cents set). */
  outside: boolean;
  /** The order's stored figures. */
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  /** Its delivery-charge lines (line totals, before discount and tax); 0 with none. */
  deliveryChargeCents: number;
  /** What kind of discount it had (shiftReportDiscountKind); null when discountCents is 0. */
  discountKind: ShiftReportDiscountKind | null;
  /** When it was paid (orders.paid_at). */
  paidAt: string;
  /** Its status at the close ('refunded' = refunded in full). */
  status: OrderStatus;
  /** The methods of its live positive payments, each once, in any order. */
  methods: string[];
  /** It has a live negative payment (a refund, in full or in part). */
  hasRefund: boolean;
}

/** One line of a settled order (never a delivery-charge line). */
export interface ShiftReportFactsLine {
  orderId: string;
  /** The menu item sold; null for a line with none. */
  menuItemId: string | null;
  /** The menu's name at the close, else the name on the line. */
  name: string;
  /** Its category's name at the close; null with no category ('No category', printed last). */
  categoryName: string | null;
  /** Its category's place in the till's own order (ORDER BY display_order, name); null with no category. */
  categoryRank: number | null;
  quantity: number;
  lineTotalCents: number;
  /** The line's tax rate in basis points (1500 = 15%). */
  taxRateBps: number;
}

/** One live payment row of this shift on this till. */
export interface ShiftReportFactsPayment {
  orderId: string;
  method: string;
  /** Signed: money in is positive, money handed back negative. */
  cents: number;
}

/** A refund given on this till in this shift (one negative payment row), with its order. */
export interface ShiftReportFactsRefund extends ShiftReportRefund {
  orderId: string;
}

/**
 * The drawer exactly as closeShift worked it out, with its breakdown of the
 * cash movements (shift-repo cashMovementTotals).
 */
export interface ShiftReportDrawerFacts {
  openingCents: number;
  cashSalesCents: number;
  cashRefundsCents: number;
  /** Cash put in (type 'payin'). */
  cashIn: ShiftReportCountCents;
  /** Payouts typed by hand (type 'payout' with no order). */
  payouts: ShiftReportCountCents;
  /** Rider tips (type 'tip_out'). */
  tips: ShiftReportCountCents;
  /** The payouts linked to an order (outside riders), and how many of them were trips. */
  riderKept: { count: number; cents: number; tripCount: number };
  expectedCents: number;
  countedCents: number;
  varianceCents: number;
  countedNotes: CashCount | null;
}

/**
 * The close's own list of orders carried over unpaid (shift-repo's
 * UnpaidOrderAtClose rows fit as they are), and the manager's reason.
 */
export interface ShiftReportUnpaidFacts {
  orders: ReadonlyArray<{ orderNumber: string; createdAt: string; totalCents: number; takenBy: string }>;
  reason: string | null;
}

/** Everything the report is made from, read inside the close. */
export interface ShiftReportFacts {
  shiftId: string;
  deviceId: string;
  tillName: string;
  shopName: string;
  openedAt: string;
  closedAt: string;
  openedBy: string;
  closedBy: string;
  pinOnLoginOf: string | null;
  /** The orders settled on this till in this shift, each once. */
  settled: readonly ShiftReportFactsOrder[];
  /** Their lines, delivery charges left out. */
  lines: readonly ShiftReportFactsLine[];
  /** The live payment rows of this shift on this till. */
  payments: readonly ShiftReportFactsPayment[];
  /** The refunds given on this till in this shift, as read. */
  refunds: readonly ShiftReportFactsRefund[];
  /** This till's orders cancelled in this shift, as read. */
  cancelled: readonly ShiftReportCancelled[];
  drawer: ShiftReportDrawerFacts;
  unpaid: ShiftReportUnpaidFacts;
}

// -----------------------------------------------------------------------------
// Orders and names
// -----------------------------------------------------------------------------

/** The discount kinds in the paper's order. */
const DISCOUNT_ORDER: readonly ShiftReportDiscountKind[] = ['foodpanda', 'staff', 'website', 'offer'];

/** The payment methods in the paper's order; any other comes after them, by name. */
const METHOD_ORDER: readonly string[] = ['cash', 'card', 'easypaisa', 'jazzcash', 'bank_transfer', 'foodpanda'];

/** The channels in the paper's order. */
const CHANNEL_ORDER: readonly ReportChannel[] = ['takeaway', 'delivery', 'web_pickup', 'web_delivery', 'foodpanda', 'dine_in', 'online'];

/** The channels that split out the outside riders' orders. */
const OUTSIDE_CHANNELS: ReadonlySet<ReportChannel> = new Set<ReportChannel>(['delivery', 'web_delivery']);

/** Plain code-point order, the same on every PC. */
function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Place in a fixed order, unknown ones after, by name. */
function inOrder(order: readonly string[], a: string, b: string): number {
  const ia = order.indexOf(a);
  const ib = order.indexOf(b);
  const ra = ia < 0 ? order.length : ia;
  const rb = ib < 0 ? order.length : ib;
  return ra - rb || byName(a, b);
}

/**
 * The kind of an order's discount, as Reports reads it: from the latest live
 * discount row's source, and only when the order's stored discount is above
 * Rs 0 (a declined automatic offer keeps its row, re-worked to Rs 0, and
 * never counts). 'foodpanda' is the foodpanda deal, 'offer' an automatic
 * offer; a row with no source is the website's pick-up discount on a website
 * order and the staff's discount on a counter order.
 */
export function shiftReportDiscountKind(
  discountCents: number,
  discountSource: string | null | undefined,
  orderSource: string,
): ShiftReportDiscountKind | null {
  if (!(discountCents > 0)) return null;
  if (discountSource === 'foodpanda') return 'foodpanda';
  if (discountSource === 'offer') return 'offer';
  return orderSource === 'web' ? 'website' : 'staff';
}

// -----------------------------------------------------------------------------
// The builder
// -----------------------------------------------------------------------------

function sum(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

function salesOf(f: ShiftReportFacts): ShiftReportSales {
  const settled = f.settled;
  const settledIds = new Set(settled.map((o) => o.id));

  const deliveryCents = sum(settled.map((o) => o.deliveryChargeCents));
  const deliveryOrders = settled.filter((o) => o.deliveryChargeCents > 0).length;

  // Only a discount above Rs 0 counts; a discounted order the facts left
  // without a kind is the staff's, as Reports reads a row with no source.
  const kinds = new Map<ShiftReportDiscountKind, { orderCount: number; cents: number }>();
  for (const o of settled) {
    if (!(o.discountCents > 0)) continue;
    const kind = o.discountKind ?? 'staff';
    const k = kinds.get(kind) ?? { orderCount: 0, cents: 0 };
    k.orderCount += 1;
    k.cents += o.discountCents;
    kinds.set(kind, k);
  }
  const discounts: ShiftReportDiscountLine[] = [];
  for (const kind of [...kinds.keys()].sort((a, b) => inOrder(DISCOUNT_ORDER, a, b))) {
    const k = kinds.get(kind)!;
    discounts.push({ kind, orderCount: k.orderCount, cents: k.cents });
  }

  // The one tax rate the food was sold at; none, or more than one, prints no rate.
  const rates = new Set<number>();
  for (const l of f.lines) if (settledIds.has(l.orderId) && l.taxRateBps > 0) rates.add(l.taxRateBps);
  const taxRateBps = rates.size === 1 ? [...rates][0]! : null;

  const billedCents = sum(settled.map((o) => o.totalCents));
  const refunds = {
    orderCount: new Set(f.refunds.map((r) => r.orderId)).size,
    cents: sum(f.refunds.map((r) => r.cents)),
  };
  const orderCount = settled.length;
  return {
    orderCount,
    foodCents: sum(settled.map((o) => o.subtotalCents)) - deliveryCents,
    delivery: { orderCount: deliveryOrders, cents: deliveryCents },
    discounts,
    taxCents: sum(settled.map((o) => o.taxCents)),
    taxRateBps,
    billedCents,
    refunds,
    netCents: billedCents - refunds.cents,
    averageCents: orderCount > 0 ? Math.round(billedCents / orderCount) : 0,
  };
}

/** Money in (sign 1) or handed back (sign −1) per method; orders counted once per method; cents positive. */
function moneyLines(rows: readonly ShiftReportFactsPayment[], sign: 1 | -1): ShiftReportMoneyLine[] {
  const byMethod = new Map<string, { orders: Set<string>; cents: number }>();
  for (const p of rows) {
    if (!(sign * p.cents > 0)) continue;
    const m = byMethod.get(p.method) ?? { orders: new Set<string>(), cents: 0 };
    m.orders.add(p.orderId);
    m.cents += sign * p.cents;
    byMethod.set(p.method, m);
  }
  return [...byMethod.keys()]
    .sort((a, b) => inOrder(METHOD_ORDER, a, b))
    .map((method) => {
      const m = byMethod.get(method)!;
      return { method, orderCount: m.orders.size, cents: m.cents };
    });
}

function channelsOf(settled: readonly ShiftReportFactsOrder[]): ShiftReportChannelLine[] {
  const byChannel = new Map<ReportChannel, { orderCount: number; billedCents: number; outsideCount: number; outsideCents: number }>();
  for (const o of settled) {
    const c = byChannel.get(o.channel) ?? { orderCount: 0, billedCents: 0, outsideCount: 0, outsideCents: 0 };
    c.orderCount += 1;
    c.billedCents += o.totalCents;
    if (o.outside) {
      c.outsideCount += 1;
      c.outsideCents += o.totalCents;
    }
    byChannel.set(o.channel, c);
  }
  return [...byChannel.keys()]
    .sort((a, b) => inOrder(CHANNEL_ORDER, a, b))
    .map((channel) => {
      const c = byChannel.get(channel)!;
      return {
        channel,
        orderCount: c.orderCount,
        billedCents: c.billedCents,
        outside:
          OUTSIDE_CHANNELS.has(channel) && c.outsideCount > 0 ? { orderCount: c.outsideCount, billedCents: c.outsideCents } : null,
      };
    });
}

function drawerOf(d: ShiftReportDrawerFacts): ShiftReportDrawer {
  // 'Cash taken out' keeps the close result's meaning: the payouts typed by
  // hand and the rider tips. The tips print under it as a part of it.
  const cashOut = { count: d.payouts.count + d.tips.count, cents: d.payouts.cents + d.tips.cents };
  const known =
    d.openingCents + d.cashSalesCents - d.cashRefundsCents + d.cashIn.cents - cashOut.cents - d.riderKept.cents;
  return {
    openingCents: d.openingCents,
    cashSalesCents: d.cashSalesCents,
    cashRefundsCents: d.cashRefundsCents,
    cashIn: { count: d.cashIn.count, cents: d.cashIn.cents },
    cashOut,
    riderTips: { count: d.tips.count, cents: d.tips.cents },
    riderKept: { count: d.riderKept.count, cents: d.riderKept.cents, tripCount: d.riderKept.tripCount },
    // A drawer change this version does not know (0 as a rule), so the
    // block always adds up to the close's EXPECTED CASH.
    otherCents: d.expectedCents - known,
    expectedCents: d.expectedCents,
    countedCents: d.countedCents,
    varianceCents: d.varianceCents,
    countedNotes: d.countedNotes,
  };
}

function unpaidOf(u: ShiftReportUnpaidFacts): ShiftReportUnpaid {
  return {
    orders: u.orders.map((o) => ({ orderNumber: o.orderNumber, at: o.createdAt, takenBy: o.takenBy, cents: o.totalCents })),
    reason: u.reason,
  };
}

/** The category ITEMS SOLD gives a line that has none; it prints last. */
export const SHIFT_REPORT_NO_CATEGORY = 'No category';

/**
 * ITEMS SOLD: every line of the settled orders (the facts never carry a
 * delivery-charge line), so the items add up to SALES' Food. The categories
 * in the till's own order (their rank, then name), a category the rank does
 * not place after them, and 'No category' last. An item is its menu item, or
 * the name it was sold under when the line has no menu item; its quantity
 * and its line totals (before discounts and tax) are summed. Items most sold
 * first: quantity, then money, then name.
 */
function itemsOf(f: ShiftReportFacts): ShiftReportCategory[] {
  interface Item {
    name: string;
    quantity: number;
    cents: number;
  }
  interface Category {
    name: string | null;
    rank: number | null;
    quantity: number;
    cents: number;
    items: Map<string, Item>;
  }
  const settledIds = new Set(f.settled.map((o) => o.id));
  const categories = new Map<string, Category>();
  for (const l of f.lines) {
    if (!settledIds.has(l.orderId)) continue;
    const rank = l.categoryName === null ? null : l.categoryRank;
    const catKey = l.categoryName === null ? 'none' : `${rank ?? ''}|${l.categoryName}`;
    const c = categories.get(catKey) ?? { name: l.categoryName, rank, quantity: 0, cents: 0, items: new Map<string, Item>() };
    const itemKey = l.menuItemId !== null ? `id|${l.menuItemId}` : `name|${l.name}`;
    const i = c.items.get(itemKey) ?? { name: l.name, quantity: 0, cents: 0 };
    // One name for an item whatever order its lines came in.
    if (byName(l.name, i.name) < 0) i.name = l.name;
    i.quantity += l.quantity;
    i.cents += l.lineTotalCents;
    c.items.set(itemKey, i);
    c.quantity += l.quantity;
    c.cents += l.lineTotalCents;
    categories.set(catKey, c);
  }
  const place = (c: Category): number => (c.name === null ? 2 : c.rank === null ? 1 : 0);
  return [...categories.entries()]
    .sort(
      ([ka, a], [kb, b]) =>
        place(a) - place(b) || (a.rank ?? 0) - (b.rank ?? 0) || byName(a.name ?? '', b.name ?? '') || byName(ka, kb),
    )
    .map(([, c]) => ({
      category: c.name ?? SHIFT_REPORT_NO_CATEGORY,
      quantity: c.quantity,
      cents: c.cents,
      items: [...c.items.entries()]
        .sort(([ka, a], [kb, b]) => b.quantity - a.quantity || b.cents - a.cents || byName(a.name, b.name) || byName(ka, kb))
        .map(([, i]) => ({ name: i.name, quantity: i.quantity, cents: i.cents })),
    }));
}

/**
 * The list's order: by when the order was paid (by the clock, so the same
 * moment written two ways is one time; a time that will not read goes after
 * every other), then by order number, then by id.
 */
function byPaid(a: ShiftReportFactsOrder, b: ShiftReportFactsOrder): number {
  const parsed = (iso: string): number => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  const ta = parsed(a.paidAt);
  const tb = parsed(b.paidAt);
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (ta === Number.POSITIVE_INFINITY && a.paidAt !== b.paidAt) return byName(a.paidAt, b.paidAt);
  return byName(a.orderNumber, b.orderNumber) || byName(a.id, b.id);
}

/**
 * ORDERS: one entry per settled order — the same set as SALES, so there are
 * sales.orderCount of them and their totals add up to TOTAL (with tax) — in
 * the order they were paid, then by order number (the id last, as two tills
 * number their orders apart). Its payment methods biggest first, as the
 * receipt and Orders history show them ('EasyPaisa + Cash' for an outside
 * rider's EasyPaisa settlement), from the money this shift took for it; a tie
 * in the MONEY TAKEN order. 'full' when the order was refunded in full by the
 * close, 'part' when it has any other refund, else 'no'.
 */
function ordersOf(f: ShiftReportFacts): ShiftReportOrder[] {
  const taken = new Map<string, Map<string, number>>();
  for (const p of f.payments) {
    if (!(p.cents > 0)) continue;
    const byMethod = taken.get(p.orderId) ?? new Map<string, number>();
    byMethod.set(p.method, (byMethod.get(p.method) ?? 0) + p.cents);
    taken.set(p.orderId, byMethod);
  }
  return [...f.settled]
    .sort(byPaid)
    .map((o) => {
      const amounts = taken.get(o.id);
      const amount = (m: string): number => amounts?.get(m) ?? 0;
      return {
        orderNumber: o.orderNumber,
        paidAt: o.paidAt,
        channel: o.channel,
        outside: o.outside,
        methods: [...new Set(o.methods)].sort((a, b) => amount(b) - amount(a) || inOrder(METHOD_ORDER, a, b)),
        totalCents: o.totalCents,
        refunded: o.status === 'refunded' ? 'full' : o.hasRefund ? 'part' : 'no',
      };
    });
}

/** The shift report from the facts read at the close. */
export function buildShiftReport(f: ShiftReportFacts): ShiftReport {
  const sales = salesOf(f);
  const moneyTakenCents = sum(f.payments.map((p) => p.cents));
  return {
    v: SHIFT_REPORT_VERSION,
    shiftId: f.shiftId,
    deviceId: f.deviceId,
    tillName: f.tillName,
    shopName: f.shopName,
    openedAt: f.openedAt,
    closedAt: f.closedAt,
    openedBy: f.openedBy,
    closedBy: f.closedBy,
    pinOnLoginOf: f.pinOnLoginOf,
    sales,
    payments: moneyLines(f.payments, 1),
    paymentRefunds: moneyLines(f.payments, -1),
    moneyTakenCents,
    partPaymentsCents: moneyTakenCents - sales.netCents,
    channels: channelsOf(f.settled),
    cancelled: f.cancelled.map((c) => ({ orderNumber: c.orderNumber, at: c.at, cents: c.cents, made: c.made, reason: c.reason })),
    refunds: f.refunds.map((r) => ({
      orderNumber: r.orderNumber,
      at: r.at,
      method: r.method,
      cents: r.cents,
      full: r.full,
      reason: r.reason,
    })),
    drawer: drawerOf(f.drawer),
    unpaid: unpaidOf(f.unpaid),
    items: itemsOf(f),
    orders: ordersOf(f),
  };
}

// -----------------------------------------------------------------------------
// The stored text, and the drawer check
// -----------------------------------------------------------------------------

function countCents(x: ShiftReportCountCents): ShiftReportCountCents {
  return { count: x.count, cents: x.cents };
}

function countedNotesOf(c: CashCount | null): CashCount | null {
  // cashCountJson's key order: the note rows {faceCents, count}, then the coins.
  return c ? { notes: c.notes.map((n) => ({ faceCents: n.faceCents, count: n.count })), otherCents: c.otherCents } : null;
}

/**
 * The stored text of a report (shifts.close_report_json) — the only way it
 * is written. The object is built key by key in the type's order, so the
 * text is always the same for the same report, whatever order its keys came
 * in and whatever else they carried; the read side (shared-schemas
 * parseShiftReportJson) gives the keys back in the same order.
 */
export function shiftReportJson(r: ShiftReport): string {
  const s = r.sales;
  const d = r.drawer;
  const canonical: ShiftReport = {
    v: r.v,
    shiftId: r.shiftId,
    deviceId: r.deviceId,
    tillName: r.tillName,
    shopName: r.shopName,
    openedAt: r.openedAt,
    closedAt: r.closedAt,
    openedBy: r.openedBy,
    closedBy: r.closedBy,
    pinOnLoginOf: r.pinOnLoginOf,
    sales: {
      orderCount: s.orderCount,
      foodCents: s.foodCents,
      delivery: { orderCount: s.delivery.orderCount, cents: s.delivery.cents },
      discounts: s.discounts.map((x) => ({ kind: x.kind, orderCount: x.orderCount, cents: x.cents })),
      taxCents: s.taxCents,
      taxRateBps: s.taxRateBps,
      billedCents: s.billedCents,
      refunds: { orderCount: s.refunds.orderCount, cents: s.refunds.cents },
      netCents: s.netCents,
      averageCents: s.averageCents,
    },
    payments: r.payments.map((p) => ({ method: p.method, orderCount: p.orderCount, cents: p.cents })),
    paymentRefunds: r.paymentRefunds.map((p) => ({ method: p.method, orderCount: p.orderCount, cents: p.cents })),
    moneyTakenCents: r.moneyTakenCents,
    partPaymentsCents: r.partPaymentsCents,
    channels: r.channels.map((c) => ({
      channel: c.channel,
      orderCount: c.orderCount,
      billedCents: c.billedCents,
      outside: c.outside ? { orderCount: c.outside.orderCount, billedCents: c.outside.billedCents } : null,
    })),
    cancelled: r.cancelled.map((c) => ({ orderNumber: c.orderNumber, at: c.at, cents: c.cents, made: c.made, reason: c.reason })),
    refunds: r.refunds.map((x) => ({
      orderNumber: x.orderNumber,
      at: x.at,
      method: x.method,
      cents: x.cents,
      full: x.full,
      reason: x.reason,
    })),
    drawer: {
      openingCents: d.openingCents,
      cashSalesCents: d.cashSalesCents,
      cashRefundsCents: d.cashRefundsCents,
      cashIn: countCents(d.cashIn),
      cashOut: countCents(d.cashOut),
      riderTips: countCents(d.riderTips),
      riderKept: { count: d.riderKept.count, cents: d.riderKept.cents, tripCount: d.riderKept.tripCount },
      otherCents: d.otherCents,
      expectedCents: d.expectedCents,
      countedCents: d.countedCents,
      varianceCents: d.varianceCents,
      countedNotes: countedNotesOf(d.countedNotes),
    },
    unpaid: {
      orders: r.unpaid.orders.map((o) => ({ orderNumber: o.orderNumber, at: o.at, takenBy: o.takenBy, cents: o.cents })),
      reason: r.unpaid.reason,
    },
    items: r.items.map((c) => ({
      category: c.category,
      quantity: c.quantity,
      cents: c.cents,
      items: c.items.map((i) => ({ name: i.name, quantity: i.quantity, cents: i.cents })),
    })),
    orders: r.orders.map((o) => ({
      orderNumber: o.orderNumber,
      paidAt: o.paidAt,
      channel: o.channel,
      outside: o.outside,
      methods: [...o.methods],
      totalCents: o.totalCents,
      refunded: o.refunded,
    })),
  };
  return JSON.stringify(canonical);
}

/**
 * Whether the CASH DRAWER block adds up to its EXPECTED CASH: opening + cash
 * sales − cash refunds + cash put in − cash taken out − paid to outside
 * riders + other = expected. The rider tips are a part of cash taken out and
 * are not taken off again.
 */
export function shiftReportDrawerAddsUp(r: ShiftReport): boolean {
  const d = r.drawer;
  return (
    d.openingCents + d.cashSalesCents - d.cashRefundsCents + d.cashIn.cents - d.cashOut.cents - d.riderKept.cents + d.otherCents ===
    d.expectedCents
  );
}
