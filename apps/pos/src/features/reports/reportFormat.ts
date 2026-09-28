/**
 * Plain-words labels and the small calculations the Reports page shows.
 * Pure (no React, no DOM) so they are unit-tested.
 */
import { formatCents, priceChangeBps } from '@cheeseoclock/pos-domain';
import { CAME_BY_LABEL } from '@cheeseoclock/shared-types';
import type {
  BusinessReport,
  OfferFlag,
  ReportCameBy,
  ReportChannel,
  ReportChannelLine,
  ReportFoodCost,
  ReportMissingCostWhy,
  ReportOfferCheck,
  ReportOrderStock,
  ReportPaymentGroup,
  ReportPurchaseIngredientLine,
  ReportPurchaseSupplierLine,
  ReportPurchases,
  ReportShiftLine,
  ReportWasteReason,
  WasteReasonLabels,
} from '@cheeseoclock/shared-types';
import { daysSoFar, fmtDateInput, fmtDay, fmtMonth, tradingDayNumber, weekdayIndex, WEEKDAYS, type ReportPeriod } from './dateRange';
import { formatBps, formatUnitPrice } from '../costing/costingFormat';

export const CHANNEL_LABEL: Record<ReportChannel, string> = {
  takeaway: 'Takeaway (counter)',
  delivery: 'Delivery (phone)',
  foodpanda: 'Foodpanda',
  web_delivery: 'Website delivery',
  web_pickup: 'Website pick-up',
  dine_in: 'Dine-in (old orders)',
  online: 'Online (old orders)',
};

/** How an order came in, in Reports' words (Channels → "How orders came in"). */
export function cameByLabel(c: ReportCameBy): string {
  return c === 'not_asked' ? 'Not asked' : CAME_BY_LABEL[c];
}

/** Team & leakage's flags on a cashier, in words. */
export const OFFER_FLAG_WORDS: Record<OfferFlag, string> = {
  phone_share: 'Phone / WhatsApp',
  offer_rupees: 'Offer rupees',
};

/**
 * The note under "Came by & offers": the shop's own rates this period and
 * when a cashier is flagged (pos-domain offerFlags), from the values.
 */
export function offerCheckNote(c: ReportOfferCheck): string {
  const factor = (c.factorPct / 100).toLocaleString('en-PK', { maximumFractionDigits: 2 });
  const share = `${(c.phoneShareBps / 100).toLocaleString('en-PK', { maximumFractionDigits: 1 })}%`;
  return (
    `Counter takeaways and deliveries only. The shop this period: ${share} marked Phone or WhatsApp, ${formatCents(c.offerCentsPerOrder)} of offers an order. ` +
    `Flagged: over ${factor} × either, with at least ${c.minOrders} counter orders. Check those orders' phones against the customers.`
  );
}

/**
 * Website orders (pick-up and delivery) against everything rung up at the
 * till (counter, phone, Foodpanda, older kinds), from the order types. Both
 * add up to the sales, as the order types do.
 */
export function websiteVsTill(channels: ReportChannelLine[]): Record<'website' | 'till', { orderCount: number; netSalesCents: number }> {
  const out = { website: { orderCount: 0, netSalesCents: 0 }, till: { orderCount: 0, netSalesCents: 0 } };
  for (const c of channels) {
    const side = c.channel === 'web_pickup' || c.channel === 'web_delivery' ? out.website : out.till;
    side.orderCount += c.orderCount;
    side.netSalesCents += c.netSalesCents;
  }
  return out;
}

export const PAYMENT_LABEL: Record<ReportPaymentGroup, string> = {
  cash: 'Cash',
  card: 'Card',
  foodpanda: 'Foodpanda',
  transfer: 'Easypaisa / JazzCash / bank',
};

export const PAYMENT_ORDER: ReportPaymentGroup[] = ['cash', 'card', 'foodpanda', 'transfer'];

/** Why the cash drawer was opened by hand, in the owner's words (screen, Excel and paper). */
export const DRAWER_OPEN_WHY: Record<BusinessReport['drawerOpens'][number]['kind'], string> = {
  no_sale: 'No sale',
  count: 'To count at close',
  test: 'Test (settings)',
  // A kind this till doesn't know (a newer till wrote it): never passed off as "No sale".
  other: 'Other',
};

const METHOD_LABEL: Record<string, string> = {
  cash: 'Cash',
  card: 'Card',
  foodpanda: 'Foodpanda',
  easypaisa: 'Easypaisa',
  jazzcash: 'JazzCash',
  bank_transfer: 'Bank transfer',
};

export function methodLabel(method: string): string {
  return METHOD_LABEL[method] ?? method;
}

// ------------------------------------------------------------------ change --

export interface Change {
  /** "▲ 12%", "▼ 5%", "Same", "New", or "" when there is nothing to compare. */
  text: string;
  /** Up or down, ignoring whether that is good. */
  direction: 'up' | 'down' | 'flat' | 'none';
}

/** How a figure moved against the comparison period. */
export function changeOf(current: number, previous: number | null | undefined): Change {
  if (previous === null || previous === undefined) return { text: '', direction: 'none' };
  if (current === previous) return { text: 'Same', direction: 'flat' };
  if (previous === 0) return { text: 'New', direction: current > 0 ? 'up' : 'down' };
  const pct = Math.round(((current - previous) / Math.abs(previous)) * 100);
  if (pct === 0) return { text: current > previous ? '▲ <1%' : '▼ <1%', direction: current > previous ? 'up' : 'down' };
  return { text: `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}%`, direction: pct > 0 ? 'up' : 'down' };
}

/** Whole-number share, "0%" when there is no whole. */
export function percentOf(part: number, whole: number): string {
  if (whole <= 0) return '0%';
  const p = (part / whole) * 100;
  if (p > 0 && p < 1) return '<1%';
  return `${Math.round(p)}%`;
}

// ------------------------------------------------------------------ hours --

/** A Pakistan clock hour as people say it: 0 → "12 am", 13 → "1 pm". */
export function hourLabel(h: number): string {
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${h < 12 ? 'am' : 'pm'}`;
}

/** Hours in trading-day order: 5 am … 11 pm, then midnight … 4 am. */
export const TRADING_HOURS: number[] = [...Array.from({ length: 19 }, (_, i) => i + 5), 0, 1, 2, 3, 4];

/**
 * One bar per hour from the first hour with a sale to the last (in trading
 * order, so midnight and 1 am follow 11 pm), with empty hours between kept
 * so the gaps show.
 */
export function hourSeries(byHour: BusinessReport['byHour']): Array<{ hour: number; orderCount: number; netSalesCents: number }> {
  const at = new Map(byHour.map((h) => [h.hour, h]));
  const positions = TRADING_HOURS.map((h, i) => (at.has(h) ? i : -1)).filter((i) => i >= 0);
  if (positions.length === 0) return [];
  const from = Math.min(...positions);
  const to = Math.max(...positions);
  return TRADING_HOURS.slice(from, to + 1).map((hour) => ({
    hour,
    orderCount: at.get(hour)?.orderCount ?? 0,
    netSalesCents: at.get(hour)?.netSalesCents ?? 0,
  }));
}

// ------------------------------------------------------------------- days --

export interface DayBar {
  key: string;
  /** Short label under the bar. */
  label: string;
  /** Full label for the tooltip / table. */
  title: string;
  orderCount: number;
  netSalesCents: number;
}

/**
 * Sales over the period: a bar a day (empty days included, future days
 * left out) up to two months, a bar a month beyond that.
 */
export function daySeries(
  byDay: BusinessReport['byDay'],
  period: Pick<ReportPeriod, 'firstDay' | 'lastDay'>,
  now: Date = new Date(),
): { unit: 'day' | 'month'; bars: DayBar[] } {
  const days = daysSoFar(period, now);
  const at = new Map(byDay.map((d) => [d.day, d]));
  if (days.length <= 62) {
    return {
      unit: 'day',
      bars: days.map((day) => ({
        key: day,
        label: String(Number(day.slice(8, 10))),
        title: fmtDay(day),
        orderCount: at.get(day)?.orderCount ?? 0,
        netSalesCents: at.get(day)?.netSalesCents ?? 0,
      })),
    };
  }
  const months = new Map<string, DayBar>();
  for (const day of days) {
    const key = day.slice(0, 7);
    const bar = months.get(key) ?? {
      key,
      label: fmtMonth(day).slice(0, 3),
      title: fmtMonth(day),
      orderCount: 0,
      netSalesCents: 0,
    };
    bar.orderCount += at.get(day)?.orderCount ?? 0;
    bar.netSalesCents += at.get(day)?.netSalesCents ?? 0;
    months.set(key, bar);
  }
  return { unit: 'month', bars: [...months.values()] };
}

/**
 * The average trading day for each weekday in the period (so far): total
 * sales on Mondays ÷ number of Mondays, and so on. Days with no sales count
 * as zero — a shut Monday pulls Mondays down, which is the truth.
 */
export function weekdayAverages(
  byDay: BusinessReport['byDay'],
  period: Pick<ReportPeriod, 'firstDay' | 'lastDay'>,
  now: Date = new Date(),
): Array<{ weekday: string; days: number; avgSalesCents: number; avgOrders: number }> {
  const at = new Map(byDay.map((d) => [d.day, d]));
  const acc = WEEKDAYS.map((weekday) => ({ weekday, days: 0, sales: 0, orders: 0 }));
  for (const day of daysSoFar(period, now)) {
    const n = tradingDayNumber(day);
    if (n === null) continue;
    const slot = acc[weekdayIndex(n)]!;
    slot.days += 1;
    slot.sales += at.get(day)?.netSalesCents ?? 0;
    slot.orders += at.get(day)?.orderCount ?? 0;
  }
  return acc.map((a) => ({
    weekday: a.weekday,
    days: a.days,
    avgSalesCents: a.days > 0 ? Math.round(a.sales / a.days) : 0,
    avgOrders: a.days > 0 ? Math.round((a.orders / a.days) * 10) / 10 : 0,
  }));
}

// ------------------------------------------------------------------ times --

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** An instant on the Pakistan clock: "26 Sep, 8:30 pm". Fixed UTC+5, whatever the PC's zone. */
export function fmtWhen(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms + 5 * 3_600_000);
  const h = d.getUTCHours();
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? 'am' : 'pm'}`;
}

/** "45 min", "1 h 10 min". */
export function fmtMinutes(min: number | null): string {
  if (min === null) return '—';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** How long before `now` an instant was: "just now", "25 min ago", "5 h 10 min ago", "2 days 3 h ago". */
export function fmtAgo(iso: string, now: Date): string {
  const min = Math.floor((now.getTime() - Date.parse(iso)) / 60_000);
  // Not a date, or a clock a little behind the till that wrote it.
  if (!Number.isFinite(min) || min < 1) return 'just now';
  if (min < 24 * 60) return `${fmtMinutes(min)} ago`;
  const days = Math.floor(min / (24 * 60));
  const h = Math.floor((min % (24 * 60)) / 60);
  return `${days} ${days === 1 ? 'day' : 'days'}${h > 0 ? ` ${h} h` : ''} ago`;
}

/**
 * A shift's notes as the shift history, its print and its CSV say them:
 * "Opening note: …" (typed when it was opened), then "Closing note: …"
 * (typed when it was closed) — each only when something was typed.
 */
export function shiftNoteLines(s: Pick<ReportShiftLine, 'openingNote' | 'closingNote'>): string[] {
  const lines: string[] = [];
  const opening = s.openingNote?.trim();
  const closing = s.closingNote?.trim();
  if (opening) lines.push(`Opening note: ${opening}`);
  if (closing) lines.push(`Closing note: ${closing}`);
  return lines;
}

/**
 * "3 unpaid orders carried over — rider still out — approved by Sara": the
 * orders a close left unpaid for the next shift, why, and the manager who
 * closed it (who approved it). Null when none were carried.
 */
export function shiftCarryOverText(
  s: Pick<ReportShiftLine, 'carriedUnpaidCount' | 'carryOverReason' | 'closedBy' | 'carriedTestDeletedCount'>,
): string | null {
  const n = s.carriedUnpaidCount ?? 0;
  if (!(n > 0)) return null;
  const reason = s.carryOverReason?.trim() || 'no reason given';
  const text = `${n} unpaid ${n === 1 ? 'order' : 'orders'} carried over — ${reason} — approved by ${s.closedBy ?? 'unknown'}`;
  // One the owner deleted as a test order afterwards (0043): the saved count stays, and says so.
  const deleted = Math.min(s.carriedTestDeletedCount ?? 0, n);
  if (deleted <= 0) return text;
  if (n === 1) return `${text} (later deleted as a test order)`;
  return `${text} (${deleted} of them later deleted as ${deleted === 1 ? 'a test order' : 'test orders'})`;
}

/** Everything written on a shift, one line each: its notes, then any unpaid orders carried over (print and CSV). */
export function shiftDetailLines(
  s: Pick<ReportShiftLine, 'openingNote' | 'closingNote' | 'carriedUnpaidCount' | 'carryOverReason' | 'closedBy' | 'carriedTestDeletedCount'>,
): string[] {
  const carry = shiftCarryOverText(s);
  return carry ? [...shiftNoteLines(s), carry] : shiftNoteLines(s);
}

/** A quantity in an ingredient's unit, with thousands separators: "12,500 g". */
export function fmtQty(qty: number, unit: string): string {
  return `${new Intl.NumberFormat('en-PK').format(qty)} ${unit}`;
}

/**
 * The Stock column for a cancelled or refunded order: "Put back", "Put back ·
 * was Ready", "Wasted · Rs 180", "Made · drinks put back" (only sealed drinks
 * moved), or "—" (it held no stock, a part refund, or cancelled before the
 * till asked). The rupees only when prices are set.
 */
export function stockCellText(stock: ReportOrderStock | null, hasCosts: boolean): string {
  if (!stock) return '—';
  if (stock.outcome === 'wasted') {
    return hasCosts && stock.wasteCents > 0 ? `Wasted · ${formatCents(stock.wasteCents)}` : 'Wasted';
  }
  if (stock.answer === 'made') return 'Made · drinks put back';
  const was = stock.statusBefore ? STATUS_WAS[stock.statusBefore] : undefined;
  return stock.flagged && was ? `Put back · was ${was}` : 'Put back';
}

const STATUS_WAS: Record<string, string> = {
  sent_to_kitchen: 'with the kitchen',
  preparing: 'being cooked',
  ready: 'Ready',
};

/** Under the Wasted tile: "Rs 540 of it from 3 cancelled orders". */
export function cancelledWasteText(f: Pick<ReportFoodCost, 'cancelledWasteCents' | 'cancelledOrderCount' | 'hasCosts'>): string {
  const orders = `${f.cancelledOrderCount} cancelled order${f.cancelledOrderCount === 1 ? '' : 's'}`;
  return f.hasCosts && f.cancelledWasteCents > 0
    ? `${formatCents(f.cancelledWasteCents)} of it from ${orders}`
    : `Some of it from ${orders}`;
}

// -------------------------------------------------------------- food cost --

/** Why food was thrown away, in the owner's words (screen, Excel and paper). */
export const WASTE_REASON_LABEL: Record<ReportWasteReason, string> = {
  cancelled_made: 'Cancelled after cooking',
  test_order: 'Test orders (deleted)',
  burnt: 'Burnt',
  dropped: 'Dropped',
  expired: 'Expired / went off',
  wrong_order: 'Wrong order made',
  returned: 'Sent back',
  staff_meal: 'Staff meal',
  other: 'Other',
};

/**
 * A waste line's reason in the owner's words: his name for it where he
 * renamed it or added it (`labels`, from the report: Settings → Kitchen &
 * stock), else the released name. Reports group by the id each row keeps,
 * so a new name shows on every old row too. An id nobody knows reads
 * "Other" (Reports count such rows as Other anyway).
 */
export function wasteReasonLabel(reason: string, labels?: WasteReasonLabels | null): string {
  return labels?.[reason] ?? (WASTE_REASON_LABEL as Partial<Record<string, string>>)[reason] ?? WASTE_REASON_LABEL.other;
}

/** Why a sale's cost is not known, in plain words. */
export const MISSING_COST_WHY: Record<ReportMissingCostWhy, string> = {
  no_recipe: 'No recipe',
  no_price: 'An ingredient has no price',
  not_recorded: 'Cost not recorded',
};

/**
 * "costs known for 94% of sales". Rounded DOWN, so it never says "100%"
 * while some sale's cost is missing; "all" only when every one is known.
 */
export function coverageText(f: Pick<ReportFoodCost, 'coverageBps'>): string {
  if (f.coverageBps === null) return '';
  if (f.coverageBps >= 10_000) return 'costs known for all sales';
  if (f.coverageBps <= 0) return 'no sale has a known cost yet';
  const pct = Math.floor(f.coverageBps / 100);
  return `costs known for ${pct < 1 ? 'under 1' : pct}% of sales`;
}

/** The headline: "Food cost 29% of food sales", or why there is none. */
export function foodCostHeadline(f: Pick<ReportFoodCost, 'foodCostBps' | 'foodSalesCents'>): string {
  if (f.foodSalesCents <= 0) return 'No food sales in this period';
  if (f.foodCostBps === null) return 'Food cost not known yet';
  return `Food cost ${formatBps(f.foodCostBps)} of food sales`;
}

/**
 * The line that reconciles Reports with the Costing page: "At menu prices
 * 27.1% → after discounts 28.9% (discounts cost you 1.8 points)". Empty when
 * the two are the same (no discounts or refunds on those sales).
 */
export function menuPriceLine(f: Pick<ReportFoodCost, 'foodCostBps' | 'menuFoodCostBps'>): string {
  if (f.foodCostBps === null || f.menuFoodCostBps === null || f.foodCostBps === f.menuFoodCostBps) return '';
  const diff = f.foodCostBps - f.menuFoodCostBps;
  const points = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 1 }).format(Math.abs(diff) / 100);
  const why = diff > 0 ? `discounts and refunds cost you ${points} point${points === '1' ? '' : 's'}` : `${points} point${points === '1' ? '' : 's'} lower`;
  return `At menu prices ${formatBps(f.menuFoodCostBps)} → after discounts ${formatBps(f.foodCostBps)} (${why})`;
}

/** "Includes 212 orders estimated at the prices of the time." Empty when none were. */
export function estimatedText(f: Pick<ReportFoodCost, 'estimatedOrders'>): string {
  if (f.estimatedOrders <= 0) return '';
  const n = f.estimatedOrders;
  return `Includes ${n} order${n === 1 ? '' : 's'} estimated at the prices of the time.`;
}

/**
 * When costs started being kept with each sale, and what that means for the
 * figures: "From Sat 3 Oct 2026 every sale keeps its cost; older or unrecorded
 * orders are estimated from what they took from stock at the prices of the
 * time." (Each take at the price in force when it was taken, from the
 * price history; the starting price for anything older — costing Phase 4.)
 */
export function costingStartText(costingStartedAt: string | null): string {
  if (costingStartedAt === null) {
    return 'From the next order sent to the kitchen, every sale keeps its cost. Until then orders are estimated from what they took from stock at the prices of the time.';
  }
  return `From ${fmtDay(fmtDateInput(costingStartedAt))} every sale keeps its cost; older or unrecorded orders are estimated from what they took from stock at the prices of the time.`;
}

/** "2 orders · Rs 540" for food sent out and not paid, or still open. */
export function unpaidFoodText(u: { orderCount: number; costCents: number }): string {
  if (u.orderCount === 0) return '—';
  return `${u.orderCount} order${u.orderCount === 1 ? '' : 's'} · ${formatCents(u.costCents)}`;
}

// ---------------------------------------------------------------------------
// Purchases (costing spec Phase 5)
// ---------------------------------------------------------------------------

/** Anything bought or booked in during the period (a purchase, a bill of Rs 0, or stock booked in by hand). */
export function hasPurchases(p: Pick<ReportPurchases, 'bySupplier'>): boolean {
  return p.bySupplier.length > 0;
}

/** "Rs 48,250 spent on stock, 14 bills." — bills are real purchases; stock booked in by hand is said in byHandText. */
export function purchaseHeadline(p: Pick<ReportPurchases, 'spendCents' | 'bills' | 'bySupplier'>): string {
  if (!hasPurchases(p)) return 'No stock bought in this period.';
  if (p.bills === 0) return `${formatCents(p.spendCents)} of stock booked in, no bills.`;
  return `${formatCents(p.spendCents)} spent on stock, ${p.bills} ${p.bills === 1 ? 'bill' : 'bills'}.`;
}

/** The Bills column: a number, or '—' for stock booked in by hand (it has no bills). */
export function purchaseBillsText(l: Pick<ReportPurchaseSupplierLine, 'from' | 'bills'>): string {
  return l.from === 'by_hand' ? '—' : String(l.bills);
}

/** "Rs 155 / kg" — what one unit cost on the latest purchase in the period. */
export function purchasePriceText(l: Pick<ReportPurchaseIngredientLine, 'lastUnitCostMc' | 'unit'>): string {
  return l.lastUnitCostMc === null ? '—' : formatUnitPrice(l.lastUnitCostMc, l.unit);
}

/** "▲ 12% on the one before", "▼ 3%", "same" — the latest purchase against the one before; null when there was none. */
export function purchaseChangeText(l: Pick<ReportPurchaseIngredientLine, 'lastUnitCostMc' | 'prevUnitCostMc'>): { text: string; tone: 'up' | 'down' | 'same' } | null {
  if (l.lastUnitCostMc === null || l.prevUnitCostMc === null) return null;
  const bps = priceChangeBps(l.prevUnitCostMc, l.lastUnitCostMc);
  if (bps === null) return null;
  if (bps === 0) return { text: 'same', tone: 'same' };
  return bps > 0 ? { text: `▲ ${formatBps(bps)}`, tone: 'up' } : { text: `▼ ${formatBps(-bps)}`, tone: 'down' };
}

/** Stock booked in by hand has no bill: said once, under the figures. */
export function byHandText(p: Pick<ReportPurchases, 'byHandCents' | 'byHandEntries'>): string | null {
  if (p.byHandEntries === 0) return null;
  const times = p.byHandEntries === 1 ? 'once' : `${p.byHandEntries} times`;
  return `${formatCents(p.byHandCents)} of it was stock booked in by hand ${times}, with no bill (valued at the price then).`;
}
