/**
 * Getting a report off the screen, a tab at a time (costing spec Phase 3):
 * a CSV the owner can open in Excel and a printout, each with that tab's
 * figures only, plus "Print everything" (every tab this login can see, one
 * document). The builders are pure (tested); `downloadText` and the print
 * CSS are the only browser-facing parts.
 *
 * Every number comes straight from the tab's figures — nothing is worked out
 * again here, so paper, file and screen always agree.
 */
import {
  MENU_MAP_WORDS,
  REPORT_TAB_LABEL,
  REPORT_TABS,
  type DeletedTestsPage,
  type DrawerLogCounts,
  type ReportDrawerLogLine,
  type ReportChannelProfit,
  type ReportKpis,
  type ReportLineCost,
  type ReportMenuMap,
  type ReportTab,
  type ReportTabData,
  type ReportTrends,
  type ReportVariance,
  type TrendComparison,
} from '@cheeseoclock/shared-types';
import { formatCents, formatQty, staleLinkText } from '@cheeseoclock/pos-domain';
import type { ReportPeriod } from './dateRange';
import {
  CHANNEL_LABEL,
  DRAWER_OPEN_WHY,
  MISSING_COST_WHY,
  PAYMENT_LABEL,
  PAYMENT_ORDER,
  WASTE_REASON_LABEL,
  changeOf,
  costingStartText,
  coverageText,
  daySeries,
  estimatedText,
  foodCostHeadline,
  menuPriceLine,
  fmtMinutes,
  fmtWhen,
  hourLabel,
  hourSeries,
  methodLabel,
  percentOf,
  shiftDetailLines,
  stockCellText,
  unpaidFoodText,
  websiteVsTill,
  byHandText,
  hasPurchases,
  purchaseBillsText,
  purchaseChangeText,
  purchaseHeadline,
  purchasePriceText,
} from './reportFormat';
import { formatBps, thousandUnit } from '../costing/costingFormat';
import { DAY_NOTE_TAG_LABEL } from '@cheeseoclock/shared-types';
import { fmtDay, fmtMonth, WEEKDAYS } from './dateRange';
import { TREND_LABEL, dayNoteText, daypartHoursText, heatmapShown, monthNote, trendChangeOf } from './ownerWeekFormat';
import {
  VARIANCE_BAND_LABEL,
  actualCogsText,
  lineVerdict,
  signedCents,
  signedQty,
  varianceHeadline,
  varianceWindowText,
} from './varianceFormat';
import {
  DRAWER_LOG_COLUMNS,
  drawerCash,
  drawerLogChips,
  drawerLogRow,
  drawerLogSinceText,
  drawerLogTitle,
  drawerResult,
  drawerTill,
  drawerWhy,
  shiftTestDeletedNote,
} from './drawerLogFormat';
import { deletedPaidWords, deletedStockWords } from '../orders/testDeleteCopy';
import { commissionText, menuMapAdvice, profitHeadline, riderText, stepAmount, stepLabel, stockGainNote, unknownCostNote } from './profitFormat';

/** Some or all of the tabs, as fetched (for "Print everything"). */
export type SomeReportTabs = { [K in ReportTab]?: ReportTabData[K] };

/**
 * What a tab shows from its own channel rather than the tab's figures:
 * Overview's trend strip and 12 months (costing spec Phase 7,
 * reports:trends); Food cost & stock's "used vs should have used" between
 * two stock takes (Phase 8, reports:variance). Print and file follow the tab
 * (D12), so they carry it too.
 */
export interface ReportExtras {
  trends?: ReportTrends | null;
  variance?: ReportVariance | null;
  /**
   * Team & leakage (migrations 0040 / 0041): the period's whole cash drawer
   * log (reports:drawerLog) and its deleted test orders.
   */
  drawerLog?: { rows: ReportDrawerLogLine[]; counts: DrawerLogCounts; logSince: string | null } | null;
  deletedTests?: DeletedTestsPage | null;
  /** Menu's menu map (costing spec Phase 9, reports:menuMap; profit.view). */
  menuMap?: ReportMenuMap | null;
}

/** Where a Team & leakage list could not be read (it is null): said in its place, never silently left out. */
export const TEAM_EXTRA_UNREAD = 'Could not be read when this was made. Make it again to see it.';

/** A list that holds fewer rows than there are: said, so no one takes the rest as missing. */
export function partialListText(shown: number, total: number): string | null {
  return shown < total ? `The latest ${shown} of ${total} — narrow the dates for the rest.` : null;
}

// ------------------------------------------------ Phase 9: cost and profit --

/** A cost line's cells: food cost and how much is known; profit and per sale only when the login may see profit. */
function costCells(c: ReportLineCost | undefined, withProfit: boolean): CsvCell[] {
  return [
    c && c.knownUnits > 0 && c.foodCostBps !== null ? formatBps(c.foodCostBps) : null,
    c && c.coverageBps !== null ? formatBps(c.coverageBps) : null,
    ...(withProfit ? [c?.profitCents != null ? rs(c.profitCents) : null, c?.profitPerSaleCents != null ? rs(c.profitPerSaleCents) : null] : []),
  ];
}

/** Profit is profit.view's: the main process sends it only then, and paper and file follow the data. */
function menuHasProfit(r: ReportTabData['menu']): boolean {
  return r.costs !== null && Object.values(r.costs.items).some((c) => c.profitCents !== null);
}

function channelProfitRows(channels: readonly ReportChannelProfit[]): CsvCell[][] {
  return [
    ['Order type', 'Orders', 'Sales before tax Rs', 'Of it delivery charges Rs', 'Food cost Rs', 'Sales with unknown cost Rs', 'Commission Rs', 'Price uplift Rs', 'Card and wallet fees Rs', 'Rider Rs', 'Earns Rs (known costs)', 'Per order Rs (known costs)'],
    ...channels.map((c) => [
      CHANNEL_LABEL[c.channel],
      c.orderCount,
      rs(c.salesCents),
      rs(c.feeSalesCents),
      rs(c.foodCostCents),
      rs(c.unknownSalesCents),
      rs(c.commissionCents),
      rs(c.upliftCents),
      rs(c.paymentFeeCents),
      rs(c.riderCents),
      rs(c.contributionCents),
      c.contributionPerOrderCents === null ? null : rs(c.contributionPerOrderCents),
    ]),
  ];
}

// --------------------------------------------------------------------- CSV --

/** Money for a spreadsheet: plain rupees with two decimals, so Excel sees a number. */
export interface Money {
  cents: number;
}
export type CsvCell = string | number | Money | null;

const rs = (cents: number): Money => ({ cents });

function csvCell(v: CsvCell): string {
  if (v === null) return '';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') return (v.cents / 100).toFixed(2);
  // A name typed at the till must not run as a formula in Excel.
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const UTF8_BOM = String.fromCharCode(0xfeff);

export function toCsv(rows: CsvCell[][]): string {
  // BOM so Excel reads UTF-8 (names in Urdu, "–", "·") correctly.
  return UTF8_BOM + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function kpiRows(k: ReportKpis, p: ReportKpis | null): CsvCell[][] {
  const row = (label: string, pick: (x: ReportKpis) => number, money: boolean): CsvCell[] => [
    label,
    money ? rs(pick(k)) : pick(k),
    p ? (money ? rs(pick(p)) : pick(p)) : null,
  ];
  return [
    row('Sales (after discounts and refunds, tax included) Rs', (x) => x.netSalesCents, true),
    row('Orders', (x) => x.orderCount, false),
    row('Average order Rs', (x) => x.avgOrderCents, true),
    row('Items sold', (x) => x.itemCount, false),
    row('Items at menu price Rs', (x) => x.menuSalesCents, true),
    row('Discounts given Rs', (x) => x.discountCents, true),
    row('Orders with a discount', (x) => x.discountedOrderCount, false),
    row('Tax collected Rs', (x) => x.taxCents, true),
    row('Refunds on kept orders Rs', (x) => x.partialRefundCents, true),
    row('Orders refunded in full', (x) => x.fullRefundCount, false),
    row('Refunded in full Rs', (x) => x.fullRefundCents, true),
    row('Cancelled before payment (orders)', (x) => x.voidCount, false),
    row('Cancelled before payment Rs', (x) => x.voidCents, true),
    row('Not paid yet (orders)', (x) => x.unpaidCount, false),
    row('Not paid yet Rs', (x) => x.unpaidCents, true),
    ...PAYMENT_ORDER.map((g) => row(`Paid by ${PAYMENT_LABEL[g]} Rs`, (x) => x.payments[g], true)),
    row('No payment method recorded Rs', (x) => x.unrecordedPaymentCents, true),
  ];
}

/** A tab's part of the file: its sections, each under a heading. */
type CsvPart<K extends ReportTab> = (sheet: CsvSheet, data: ReportTabData[K], period: ReportPeriod, madeAt: Date) => void;

class CsvSheet {
  readonly rows: CsvCell[][] = [];
  push(...rows: CsvCell[][]): void {
    this.rows.push(...rows);
  }
  heading(title: string): void {
    this.rows.push([]);
    this.rows.push([title.toUpperCase()]);
  }
}

const CSV_PARTS: { [K in ReportTab]: CsvPart<K> } = {
  overview: (sheet, r, period) => {
    sheet.heading('Summary');
    sheet.push(['', 'This period', period.compare ? `Compared with ${period.compare.label}` : '']);
    sheet.push(...kpiRows(r.kpis, r.previous));
    const split = websiteVsTill(r.channels);
    sheet.heading('Website vs till');
    sheet.push(['Taken on', 'Orders', 'Sales Rs']);
    sheet.push(['Website (pick-up and delivery)', split.website.orderCount, rs(split.website.netSalesCents)]);
    sheet.push(['Till (counter, phone, Foodpanda)', split.till.orderCount, rs(split.till.netSalesCents)]);
  },

  when: (sheet, r, period, madeAt) => {
    const days = daySeries(r.byDay, period, madeAt);
    sheet.heading(days.unit === 'day' ? 'Sales by day' : 'Sales by month');
    sheet.push([days.unit === 'day' ? 'Day' : 'Month', 'Orders', 'Sales Rs']);
    for (const d of days.bars) sheet.push([d.title, d.orderCount, rs(d.netSalesCents)]);
    sheet.heading('Sales by hour (Pakistan time)');
    sheet.push(['Hour', 'Orders', 'Sales Rs']);
    for (const h of hourSeries(r.byHour)) sheet.push([hourLabel(h.hour), h.orderCount, rs(h.netSalesCents)]);

    sheet.heading('Parts of the day');
    sheet.push(['Part', 'Hours', 'Orders', 'Sales Rs', 'Average order Rs']);
    for (const l of [...r.dayparts.lines, ...(r.dayparts.other ? [r.dayparts.other] : [])]) {
      sheet.push([l.name, daypartHoursText(l.fromHour, l.toHour), l.orderCount, rs(l.netSalesCents), l.orderCount > 0 ? rs(l.avgOrderCents) : null]);
    }

    const hm = r.heatmap;
    if (heatmapShown(hm)) {
      sheet.heading('An average day by weekday and hour (sales Rs; closed days left out)');
      sheet.push(['Day', 'Days counted', ...hm.hours.map(hourLabel)]);
      WEEKDAYS.forEach((day, w) => {
        sheet.push([day, hm.dayCounts[w] ?? 0, ...hm.hours.map((h) => rs(hm.cells.find((c) => c.weekday === w && c.hour === h)?.avgNetSalesCents ?? 0))]);
      });
      if (hm.closedDays > 0) sheet.push([`Days marked closed, left out: ${hm.closedDays}`]);
    }

    sheet.heading('Notes on days');
    sheet.push(['Day', 'What', 'Note', 'Added by', 'Left out of forecasts']);
    for (const n of r.dayNotes) sheet.push([fmtDay(n.day), DAY_NOTE_TAG_LABEL[n.tag], n.note, n.addedBy, n.excludeFromForecast ? 'Yes' : 'No']);
  },

  menu: (sheet, r) => {
    const costs = r.costs;
    const withProfit = menuHasProfit(r);
    const costHead = costs ? ['Food cost (known sales)', 'Costs known for', ...(withProfit ? ['Profit Rs (before channel costs)', 'Profit per sale Rs'] : [])] : [];
    sheet.heading('Items sold (menu price, before order discounts)');
    sheet.push(['Item', 'Category', 'Quantity', 'Sales Rs', ...costHead]);
    for (const i of r.items) sheet.push([i.name, i.categoryName, i.quantity, rs(i.salesCents), ...(costs ? costCells(costs.items[i.key], withProfit) : [])]);
    sheet.heading('Categories (menu price, before order discounts)');
    sheet.push(['Category', 'Quantity', 'Sales Rs', ...costHead]);
    for (const c of r.categories) {
      sheet.push([c.name, c.quantity, rs(c.salesCents), ...(costs ? costCells(costs.categories[c.categoryId ?? `name:${c.name}`], withProfit) : [])]);
    }
    if (costs) sheet.push([`Food cost${withProfit ? ' and profit' : ''}: on the sales whose cost is fully known, at what customers paid. ${costingStartText(costs.costingStartedAt)}`]);
  },

  channels: (sheet, r) => {
    sheet.heading('Order types');
    sheet.push(['Order type', 'Orders', 'Sales Rs']);
    for (const c of r.channels) sheet.push([CHANNEL_LABEL[c.channel], c.orderCount, rs(c.netSalesCents)]);
    if (r.profit) {
      sheet.heading('What each order type earns (before waste and missing stock)');
      sheet.push(...channelProfitRows(r.profit.channels));
      sheet.push([commissionText(r.profit.fees)]);
      sheet.push([riderText(r.profit.riderCost)]);
    }
    sheet.heading('Deliveries by rider');
    sheet.push(['Rider', 'Deliveries', 'Sales Rs', 'Average time on the road (minutes)']);
    for (const d of r.deliveries.byRider) sheet.push([d.name, d.deliveries, rs(d.netSalesCents), d.avgMinutesOut]);
    const withProfit = r.areas.some((a) => a.riderCents !== null);
    sheet.heading('Deliveries by area');
    sheet.push([
      'Area',
      'Delivery zone',
      'Orders',
      'Sales Rs',
      'Average order Rs',
      'Delivery charges before tax Rs',
      'Average time on the road (minutes)',
      'Customers',
      'Came back (2+ orders in 90 days)',
      ...(withProfit ? ['Rider Rs', 'Earns per order Rs'] : []),
    ]);
    for (const a of r.areas) {
      sheet.push([
        a.area,
        a.zoneId === null ? 'Not matched' : 'Yes',
        a.orderCount,
        rs(a.netSalesCents),
        rs(a.avgOrderCents),
        rs(a.feesCollectedCents),
        a.avgMinutesOut,
        a.customers,
        a.repeatCustomers,
        ...(withProfit ? [a.riderCents === null ? null : rs(a.riderCents), a.contributionPerOrderCents === null ? null : rs(a.contributionPerOrderCents)] : []),
      ]);
    }
    if (r.noRateCount > 0) {
      sheet.heading(`Deliveries with no area and no delivery charge (${r.noRateCount})`);
      sheet.push(['Order', 'Started', 'Area as typed']);
      for (const d of r.noRateDeliveries) sheet.push([d.orderNumber, fmtWhen(d.createdAt), d.area]);
    }
  },

  foodStock: (sheet, r) => {
    const f = r.foodCost;
    sheet.heading('Food cost (this till; sales before tax, after discounts)');
    sheet.push(['', 'Orders', 'Rs', 'Share']);
    sheet.push(['Food sales', null, rs(f.foodSalesCents), null]);
    sheet.push(['Cost of food sold', null, rs(f.costOfSalesCents), null]);
    sheet.push(['Food cost (sales with a known cost)', null, null, f.foodCostBps === null ? null : formatBps(f.foodCostBps)]);
    sheet.push(['Costs known for', null, rs(f.knownSalesCents), f.coverageBps === null ? null : formatBps(f.coverageBps)]);
    if (f.menuFoodCostBps !== null) sheet.push(['Food cost at menu prices', null, null, formatBps(f.menuFoodCostBps)]);
    if (f.estimatedOrders > 0) sheet.push(['Estimated at the prices of the time', f.estimatedOrders, rs(f.estimatedCostCents), null]);
    sheet.push(['Food sent out, not paid', f.sentNotPaid.orderCount, rs(f.sentNotPaid.costCents), null]);
    if (f.stillOpen.orderCount > 0) sheet.push(['Still open from earlier days', f.stillOpen.orderCount, rs(f.stillOpen.costCents), null]);

    sheet.heading('Waste by reason (at what the stock cost when taken)');
    sheet.push(['Reason', 'Times', 'Cost Rs']);
    for (const w of f.wasteByReason) sheet.push([WASTE_REASON_LABEL[w.reason], w.times, rs(w.cents)]);
    sheet.push(['Total', null, rs(f.wasteCents)]);
    if (f.cancelledOrderCount > 0) {
      sheet.push(['Of the waste: food made for cancelled orders', f.cancelledOrderCount, rs(f.cancelledWasteCents)]);
    }

    sheet.heading('Sales with missing costs');
    sheet.push(['Item', 'Why', 'Sold', 'Sales Rs']);
    for (const m of f.missingSales) sheet.push([m.name, MISSING_COST_WHY[m.why], m.quantity, rs(m.salesCents)]);
    sheet.push(['Total', null, null, rs(f.missingSalesCents)]);

    sheet.heading('Ingredients wasted');
    sheet.push(['Ingredient', 'Unit', 'Wasted', 'Cost Rs']);
    for (const i of f.wasteIngredients) sheet.push([i.name, i.unit, i.wastedQty, rs(i.wastedCents)]);

    const p = r.purchases;
    sheet.heading('Purchases (this till, at the bills)');
    sheet.push(['Bought from', 'Bills', 'Spent Rs']);
    // Stock booked in by hand has no bills: its Bills cell is empty, and it is not in the total's count.
    for (const s of p.bySupplier) sheet.push([s.name, s.from === 'by_hand' ? null : s.bills, rs(s.spendCents)]);
    sheet.push(['Total', p.bills, rs(p.spendCents)]);
    if (p.byHandEntries > 0) sheet.push([`Of it: booked in by hand ${p.byHandEntries} ${p.byHandEntries === 1 ? 'time' : 'times'}, no bill (at the price then)`, null, rs(p.byHandCents)]);

    sheet.heading('Purchases by ingredient');
    sheet.push(['Ingredient', 'Unit', 'Bought', 'Times', 'Spent Rs', 'Latest price Rs', 'Per', 'Change on the purchase before']);
    for (const l of p.byIngredient) {
      // Per kg / litre for something weighed (a gram's price in millicents is paisa per kg), else per unit.
      const big = thousandUnit(l.unit);
      const price = l.lastUnitCostMc === null ? null : rs(big ? l.lastUnitCostMc : Math.round(l.lastUnitCostMc / 1000));
      sheet.push([l.name, l.unit, l.qty, l.times, rs(l.spendCents), price, big ?? l.unit, purchaseChangeText(l)?.text ?? null]);
    }
  },

  team: (sheet, r) => {
    const hasCosts = r.foodCost?.hasCosts ?? false;
    sheet.heading('Staff');
    sheet.push(['Taken by', 'Orders', 'Sales Rs', 'Discounts given Rs', 'Cancelled orders', 'Drawer opened with no sale', 'Drawer opens (all)']);
    for (const s of r.staff) {
      sheet.push([s.name, s.orderCount, rs(s.netSalesCents), rs(s.discountCents), s.voidCount, s.noSaleOpens, s.drawerOpens ?? null]);
    }

    sheet.heading('Shifts (cash drawer)');
    sheet.push(['Opened', 'Closed', 'Opened by', 'Closed by', 'Float Rs', 'Cash put in Rs', 'Cash taken out Rs', 'Expected Rs', 'Counted Rs', 'Short (-) / over (+) Rs', 'Cash in/out entries', 'Drawer opened with no sale', 'Opening note', 'Closing note', 'Unpaid orders carried over', 'Carry-over reason', 'Drawer used (all)', 'Test orders deleted after close Rs', 'Carried over, later deleted as tests']);
    for (const s of r.shifts) {
      sheet.push([
        fmtWhen(s.openedAt),
        s.closedAt ? fmtWhen(s.closedAt) : 'Still open',
        s.openedBy,
        s.closedBy,
        rs(s.openingCashCents),
        rs(s.cashInCents),
        rs(s.cashOutCents),
        s.expectedCashCents === null ? null : rs(s.expectedCashCents),
        s.countedCashCents === null ? null : rs(s.countedCashCents),
        s.varianceCents === null ? null : rs(s.varianceCents),
        s.cashMovementCount,
        s.noSaleOpens,
        s.openingNote?.trim() || null,
        s.closingNote?.trim() || null,
        s.carriedUnpaidCount ?? 0,
        (s.carriedUnpaidCount ?? 0) > 0 ? s.carryOverReason?.trim() || null : null,
        // The drawer log (0040) and the owner's deleted test orders (0041), after the columns 0.7.21 shipped.
        s.drawerOpenCount ?? null,
        s.testDeletedCashCents ? rs(s.testDeletedCashCents) : null,
        s.carriedTestDeletedCount ? s.carriedTestDeletedCount : null,
      ]);
    }

    sheet.heading('Discounts by reason');
    sheet.push(['Reason', 'Times', 'Amount Rs']);
    for (const d of r.discounts.byReason) sheet.push([d.reason, d.count, rs(d.amountCents)]);
    sheet.heading('Discounts by person');
    sheet.push(['Given by', 'Times', 'Amount Rs', 'With manager approval']);
    for (const d of r.discounts.byPerson) sheet.push([d.name, d.count, rs(d.amountCents), d.approvedCount]);
    sheet.heading(
      r.discounts.recent.length < r.discounts.totalCount
        ? `Each discount (latest ${r.discounts.recent.length} of ${r.discounts.totalCount})`
        : 'Each discount',
    );
    sheet.push(['When', 'Order', 'Amount Rs', 'Entered as', 'Reason', 'Given by', 'Approved by']);
    for (const d of r.discounts.recent) {
      sheet.push([fmtWhen(d.createdAt), d.orderNumber, rs(d.amountCents), d.entered, d.reason, d.givenBy, d.approvedBy]);
    }

    sheet.heading('Refunds');
    sheet.push(['Refunded', 'Order', 'Order started', 'Amount Rs', 'Paid back as', 'Whole order', 'Reason', 'Stock', 'Approved by']);
    for (const x of r.refunds) {
      sheet.push([
        fmtWhen(x.refundedAt),
        x.orderNumber,
        fmtWhen(x.orderCreatedAt),
        rs(x.amountCents),
        methodLabel(x.method),
        x.full ? 'Yes' : 'No',
        x.reason,
        stockCellText(x.stock, hasCosts),
        x.approvedBy,
      ]);
    }

    sheet.heading('Cancelled before payment');
    sheet.push(['Cancelled', 'Order', 'Value Rs', 'Reason', 'Stock', 'Approved by', 'Taken by']);
    for (const v of r.voids) {
      sheet.push([
        fmtWhen(v.voidedAt ?? v.createdAt),
        v.orderNumber,
        rs(v.amountCents),
        v.reason,
        stockCellText(v.stock, hasCosts),
        v.approvedBy,
        v.takenBy,
      ]);
    }

    sheet.heading(
      r.drawerOpens.length < r.drawerOpenCount
        ? `Cash drawer opened by hand (no sale, count, test) — latest ${r.drawerOpens.length} of ${r.drawerOpenCount}`
        : 'Cash drawer opened by hand (no sale, count, test)',
    );
    sheet.push(['When', 'Why', 'Reason', 'Opened by', 'Approved by', 'Shift open']);
    for (const d of r.drawerOpens) {
      sheet.push([fmtWhen(d.createdAt), DRAWER_OPEN_WHY[d.kind], d.reason, d.openedBy, d.approvedBy, d.outsideShift ? 'No' : 'Yes']);
    }
  },

  profit: (sheet, r) => {
    sheet.heading('From sales to profit before overheads (this till)');
    sheet.push(['', 'Rs']);
    for (const s of r.steps) sheet.push([stepLabel(s.key, s.cents), rs(s.cents)]);
    sheet.push(['Profit before overheads', rs(r.profitCents)]);
    const unknown = unknownCostNote(r);
    if (unknown) sheet.push([unknown]);
    const gain = stockGainNote(r);
    if (gain) sheet.push([gain]);
    if (r.stockLoss.state !== 'counted' && r.stockLoss.message) sheet.push([r.stockLoss.message]);
    sheet.push([commissionText(r.fees)]);
    sheet.push([riderText(r.riderCost)]);
    if (r.estimatedOrders > 0) sheet.push([estimatedText(r)]);
    sheet.heading('What was thrown away, by reason');
    sheet.push(['Reason', 'Times', 'Cost Rs']);
    for (const w of r.wasteByReason) sheet.push([WASTE_REASON_LABEL[w.reason], w.times, rs(w.cents)]);
    sheet.push(['Food sent out, not paid', r.sentNotPaid.orderCount, rs(r.sentNotPaid.costCents)]);
    sheet.heading('What each order type earns (before waste and missing stock)');
    sheet.push(...channelProfitRows(r.channels));
    sheet.heading('Profit by category (food only, fully costed sales, before channel costs)');
    sheet.push(['Category', 'Sold', 'Sales before tax Rs', 'Costs known for', 'Food cost', 'Profit Rs', 'Profit per sale Rs']);
    for (const c of r.categories) {
      sheet.push([
        c.name,
        c.units,
        rs(c.salesCents),
        c.coverageBps === null ? null : formatBps(c.coverageBps),
        c.foodCostBps === null ? null : formatBps(c.foodCostBps),
        c.profitCents === null ? null : rs(c.profitCents),
        c.profitPerSaleCents === null ? null : rs(c.profitPerSaleCents),
      ]);
    }
  },
};

/** The menu map in the file (costing spec 4.8). */
function menuMapCsv(sheet: CsvSheet, m: ReportMenuMap): void {
  sheet.heading(`Menu map (${m.lastDays ? 'the last 28 days' : 'the period'}; what one sale earns at menu price)`);
  sheet.push(['Category', 'Dish', 'Sold', 'Share of the category', 'Earns a sale Rs', 'Price Rs', 'Cost Rs', 'Where it sits', 'What to do']);
  for (const c of m.categories) {
    if (c.state === 'few_sales') sheet.push([c.name, `Not enough sales yet: ${c.units} sold, it needs 200.`]);
    if (c.state === 'few_dishes') sheet.push([c.name, 'Not enough dishes with a known cost sold yet: it needs 3.']);
    for (const d of c.items) {
      sheet.push([c.name, d.name, d.units, formatBps(d.mixBps), rs(d.profitPerSaleCents), rs(d.priceCents), rs(d.costCents), `${MENU_MAP_WORDS[d.class].plain} (${MENU_MAP_WORDS[d.class].term})`, menuMapAdvice(d, c.name)]);
    }
    for (const x of c.cantPlace) sheet.push([c.name, x.name, x.units, null, null, null, null, `Can't place yet: costs known for ${formatBps(x.costedShareBps)} of its sales`]);
  }
}

/** One tab as a CSV file: the period, then that tab's sections only. */
export function buildTabCsv<K extends ReportTab>(
  tab: K,
  data: ReportTabData[K],
  period: ReportPeriod,
  madeAt: Date = new Date(),
  extras: ReportExtras = {},
): string {
  const sheet = new CsvSheet();
  sheet.push(['Sales report', REPORT_TAB_LABEL[tab]]);
  sheet.push(['Period', `${period.title}: ${period.dates}`]);
  sheet.push(['Trading day', '5 am to 5 am, Pakistan time. Orders count on the day they were started.']);
  if (tab === 'overview' && period.compare) sheet.push(['Compared with', period.compare.label]);
  sheet.push(['Made', fmtWhen(madeAt.toISOString())]);
  (CSV_PARTS[tab] as CsvPart<K>)(sheet, data, period, madeAt);
  if (tab === 'overview' && extras.trends) trendsCsv(sheet, extras.trends);
  if (tab === 'foodStock' && extras.variance) varianceCsv(sheet, extras.variance);
  if (tab === 'team') teamExtrasCsv(sheet, extras);
  if (tab === 'menu' && extras.menuMap) menuMapCsv(sheet, extras.menuMap);
  return toCsv(sheet.rows);
}

/** Team & leakage in the file: the whole cash drawer log and the deleted test orders. */
function teamExtrasCsv(sheet: CsvSheet, extras: ReportExtras): void {
  const log = extras.drawerLog;
  if (log === null) {
    sheet.heading('Cash drawer log');
    sheet.push([TEAM_EXTRA_UNREAD]);
  } else if (log) {
    sheet.heading(drawerLogTitle(log.counts.total));
    sheet.push([drawerLogSinceText(log.logSince)]);
    sheet.push(drawerLogChips(log.counts).map((c) => `${c.label} ${c.n}`));
    const partial = partialListText(log.rows.length, log.counts.total);
    if (partial) sheet.push([partial]);
    sheet.push([...DRAWER_LOG_COLUMNS]);
    const now = Date.now();
    for (const l of log.rows) {
      const [when, till, why, order, , by, approved, result, note] = drawerLogRow(l, now);
      sheet.push([when, till, why, order, l.amountCents === null ? null : rs(l.amountCents), by, approved, result, note]);
    }
  }
  const t = extras.deletedTests;
  if (t === null) {
    sheet.heading('Deleted test orders');
    sheet.push([TEAM_EXTRA_UNREAD]);
  } else if (t) {
    sheet.heading(`Deleted test orders — ${t.total} (${formatCents(t.totalCents)})`);
    const partial = partialListText(t.rows.length, t.total);
    if (partial) sheet.push([partial]);
    sheet.push(['Order', 'Items', 'Taken', 'Taken by', 'Deleted', 'Deleted by', 'Why', 'Total Rs', 'Paid', 'Stock']);
    for (const d of t.rows) {
      sheet.push([
        d.orderNumber,
        d.itemsSummary,
        fmtWhen(d.takenAt),
        d.takenBy,
        fmtWhen(d.deletedAt),
        d.deletedBy,
        d.reason,
        rs(d.totalCents),
        deletedPaidWords(d),
        deletedStockWords(d),
      ]);
    }
  }
}

/** Team & leakage on paper: the drawer log's counts and latest 25, and the deleted test orders. */
function teamExtrasPrint(extras: ReportExtras): string[] {
  const parts: string[] = [];
  const log = extras.drawerLog;
  if (log === null) parts.push(`<section><h2>Cash drawer log</h2><p class="muted">${esc(TEAM_EXTRA_UNREAD)}</p></section>`);
  if (log) {
    const chips = drawerLogChips(log.counts)
      .filter((c) => c.n > 0)
      .map((c) => `${c.label} ${c.n}`)
      .join(' · ');
    const now = Date.now();
    const shown = log.rows.slice(0, 25);
    parts.push(
      `<section><h2>${esc(drawerLogTitle(log.counts.total))}</h2>` +
        (chips ? `<p>${esc(chips)}</p>` : '') +
        table(
          ['When', 'Till', 'Why', 'Cash', 'By', 'Approved by', 'Result'],
          shown.map((d) => [
            esc(fmtWhen(d.createdAt)),
            esc(drawerTill(d.till)),
            esc(drawerWhy(d)),
            esc(drawerCash(d.amountCents) || '—'),
            esc(d.openedBy),
            d.approvedBy ? esc(d.approvedBy) : '—',
            esc(drawerResult(d, now)),
          ]),
          [3],
        ) +
        `<p class="muted">${log.counts.total > shown.length ? `The latest ${shown.length} of ${log.counts.total}. ` : ''}${
          log.rows.length < log.counts.total
            ? `The Excel file holds the latest ${log.rows.length} — narrow the dates for the rest.`
            : 'The full log is in the Excel file.'
        } ${esc(drawerLogSinceText(log.logSince))}</p></section>`,
    );
  }
  const t = extras.deletedTests;
  if (t === null) parts.push(`<section><h2>Test orders deleted</h2><p class="muted">${esc(TEAM_EXTRA_UNREAD)}</p></section>`);
  if (t && t.total > 0) {
    const list = limitedOf(t.rows, 25, t.total);
    parts.push(
      `<section><h2>Test orders deleted — ${t.total} (${money(t.totalCents)})</h2>${table(
        ['Order', 'Taken', 'Deleted', 'Why', 'Total', 'Paid', 'Stock'],
        list.shown.map((d) => [
          `${esc(d.orderNumber)}${d.itemsSummary ? ` <span class="muted">${esc(d.itemsSummary)}</span>` : ''}`,
          `${esc(fmtWhen(d.takenAt))} <span class="muted">by ${esc(d.takenBy)}</span>`,
          `${esc(fmtWhen(d.deletedAt))} <span class="muted">by ${esc(d.deletedBy)}</span>`,
          esc(d.reason ?? '—'),
          money(d.totalCents),
          esc(deletedPaidWords(d)),
          esc(deletedStockWords(d)),
        ]),
        [4],
      )}${list.note}</section>`,
    );
  }
  return parts;
}

/** "Used vs should have used" between two stock takes in the file (costing spec Phase 8). */
function varianceCsv(sheet: CsvSheet, v: ReportVariance): void {
  sheet.heading('Used vs should have used (every till\'s stock)');
  if (v.state !== 'ok') {
    sheet.push([v.message]);
    return;
  }
  const window = varianceWindowText(v);
  if (window) sheet.push([window]);
  const stale = v.staleSync ? staleLinkText(v.link) : null;
  if (stale) sheet.push([stale]);
  sheet.push([varianceHeadline(v)]);
  sheet.push(['Not explained Rs', rs(v.totalCents)]);
  sheet.push(['Food sales Rs', rs(v.foodSalesCents)]);
  sheet.push(['Of food sales', v.varianceBps === null ? null : formatBps(Math.abs(v.varianceBps)), v.band ? VARIANCE_BAND_LABEL[v.band] : null]);
  sheet.push([
    'Ingredient',
    'Unit',
    'Counted before',
    'Delivered',
    'Made here',
    'Counted after',
    'Went',
    'Sold',
    'Used in batches',
    'Should have used',
    'Waste logged',
    'Not explained',
    'Not explained Rs',
    'Fixes typed',
  ]);
  for (const l of v.lines) {
    sheet.push([
      l.name,
      l.unit,
      l.opening,
      l.delivered,
      l.madeHere,
      l.closing,
      l.used,
      l.sold,
      l.usedInBatches,
      l.shouldHaveUsed,
      l.wasted,
      l.unexplained,
      l.priced ? rs(l.unexplainedCents) : null,
      l.corrections === 0 ? null : l.corrections,
    ]);
  }
  for (const p of v.pairs) if (p.warning) sheet.push([p.warning]);
  if (v.corrections.length > 0) {
    sheet.heading('Fixes typed between the stock takes (not counted in what went)');
    sheet.push(['When', 'Ingredient', 'Unit', 'Change', 'Note']);
    for (const c of v.corrections) sheet.push([fmtWhen(c.at), c.name, c.unit, c.qty, c.notes]);
  }
  if (v.alreadyCounted.length > 0) {
    sheet.heading('Left out: cancelled orders a stock take had already counted');
    sheet.push(['Order', 'Ingredient', 'Unit', 'Qty']);
    for (const a of v.alreadyCounted) sheet.push([a.orderNumber ?? a.orderId, a.name, a.unit, Math.abs(a.qty)]);
  }
  sheet.heading('Real food cost (both stock takes full)');
  if (v.actualCogs) {
    const a = v.actualCogs;
    sheet.push([actualCogsText(a)]);
    sheet.push(['Stock held at the first stock take Rs', rs(a.openingCents)]);
    sheet.push(['Bought in between Rs', rs(a.purchasesCents)]);
    sheet.push(['Stock held at the second Rs', rs(a.closingCents)]);
    sheet.push(['Food used Rs', rs(a.costCents)]);
    sheet.push(['Includes price changes on stock you held. Only ingredients a recipe or a batch uses.']);
    if (a.otherPurchasesCents > 0) sheet.push(['Other things bought (left out) Rs', rs(a.otherPurchasesCents)]);
  } else {
    sheet.push([v.actualCogsWhyNot]);
  }
}

/** Overview's trend strip and 12 months in the file (not tied to the period: so far, to the minute). */
function trendsCsv(sheet: CsvSheet, t: ReportTrends): void {
  const then = (c: TrendComparison): CsvCell => (c.figures ? rs(c.figures.netSalesCents) : 'no data then');
  sheet.heading('How the shop is trending (so far, to the minute; not tied to the period)');
  sheet.push(['', 'Sales Rs', 'Orders', 'Average order Rs', 'Compared with', 'Then Rs', 'Change', 'A year ago Rs', 'Change']);
  for (const line of t.lines) {
    const label = TREND_LABEL[line.period];
    const f = line.current.figures;
    sheet.push([
      label.title,
      rs(f.netSalesCents),
      f.orderCount,
      rs(f.avgOrderCents),
      label.previous,
      then(line.previous),
      trendChangeOf(line.previous.change.sales).text,
      line.lastYear ? then(line.lastYear) : null,
      line.lastYear ? trendChangeOf(line.lastYear.change.sales).text : null,
    ]);
  }
  if (t.partial) sheet.push(['Worked out on the till itself: only stretches of 31 days or less.']);
  if (t.months.length === 0) return;
  const costs = new Map((t.monthCosts ?? []).map((m) => [m.month, m]));
  sheet.heading('The last 12 months');
  sheet.push(['Month', 'Sales Rs', 'Orders', 'Average order Rs', ...(t.monthCosts ? ['Food cost', 'Costs known for'] : []), 'Note']);
  t.months.forEach((m, i) => {
    const note = monthNote(m, i === t.months.length - 1);
    const none = note === 'no data then';
    const c = costs.get(m.month);
    sheet.push([
      fmtMonth(`${m.month}-01`),
      none ? null : rs(m.netSalesCents),
      none ? null : m.orderCount,
      none || m.orderCount === 0 ? null : rs(m.avgOrderCents),
      ...(t.monthCosts
        ? [c?.foodCostBps != null ? formatBps(c.foodCostBps) : null, c?.coverageBps != null ? formatBps(c.coverageBps) : null]
        : []),
      note,
    ]);
  });
}

const TAB_SLUG: Record<ReportTab, string> = {
  overview: 'overview',
  when: 'when',
  menu: 'menu',
  channels: 'channels-delivery',
  foodStock: 'food-cost-stock',
  team: 'team-leakage',
  profit: 'profit',
};

export function csvFileName(period: Pick<ReportPeriod, 'firstDay' | 'lastDay'>, tab?: ReportTab): string {
  const name = tab ? `sales-report-${TAB_SLUG[tab]}` : 'sales-report';
  return period.firstDay === period.lastDay ? `${name}-${period.firstDay}.csv` : `${name}-${period.firstDay}-to-${period.lastDay}.csv`;
}

/** Hand a text file to the browser's "Save as" (Electron shows the Windows save dialog). */
export function downloadText(fileName: string, text: string, mime = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ------------------------------------------------------------------- print --

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

const esc = escapeHtml;
const money = (c: number) => esc(formatCents(c));

function table(headers: string[], rows: string[][], right: number[] = []): string {
  if (rows.length === 0) return '<p class="muted">None.</p>';
  const cls = (i: number) => (right.includes(i) ? ' class="r"' : '');
  return `<table><thead><tr>${headers.map((h, i) => `<th${cls(i)}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c, i) => `<td${cls(i)}>${c}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

function limited<T>(rows: T[], n: number): { shown: T[]; note: string } {
  return rows.length > n
    ? { shown: rows.slice(0, n), note: `<p class="muted">Showing ${n} of ${rows.length}. Download for Excel for the full list.</p>` }
    : { shown: rows, note: '' };
}

/** `limited` for a list the report already stopped at a cap: `total` is how many there really were. */
function limitedOf<T>(rows: T[], n: number, total: number): { shown: T[]; note: string } {
  const shown = rows.slice(0, n);
  if (shown.length >= total) return { shown, note: '' };
  const more = rows.length >= total ? ' Download for Excel for the full list.' : ` Download for Excel for the latest ${rows.length}.`;
  return { shown, note: `<p class="muted">Showing the latest ${shown.length} of ${total}.${more}</p>` };
}

/** A tab's part of the printout: its sections, HTML, every value escaped. */
type PrintPart<K extends ReportTab> = (data: ReportTabData[K], period: ReportPeriod, madeAt: Date) => string[];

const PRINT_PARTS: { [K in ReportTab]: PrintPart<K> } = {
  overview: (r) => {
    const k = r.kpis;
    const p = r.previous;
    const vs = (cur: number, prev: number | undefined, isMoney = true) => {
      const c = changeOf(cur, prev);
      if (!c.text || prev === undefined) return '';
      return `<span class="muted"> ${esc(c.text)}, was ${isMoney ? money(prev) : esc(String(prev))}</span>`;
    };
    const kpi = (label: string, value: string, sub: string) =>
      `<div class="kpi"><span>${esc(label)}</span><b>${value}</b>${sub}</div>`;
    const refunds = k.partialRefundCents + k.fullRefundCents;
    const parts: string[] = [];
    parts.push(
      `<section><div class="kpis">${[
        kpi('Sales', money(k.netSalesCents), `<small>after discounts and refunds, tax included${vs(k.netSalesCents, p?.netSalesCents)}</small>`),
        kpi('Orders', String(k.orderCount), `<small>${vs(k.orderCount, p?.orderCount, false) || '&nbsp;'}</small>`),
        kpi('Average order', money(k.avgOrderCents), `<small>${vs(k.avgOrderCents, p?.avgOrderCents) || '&nbsp;'}</small>`),
        kpi('Discounts given', money(k.discountCents), `<small>on ${k.discountedOrderCount} order${k.discountedOrderCount === 1 ? '' : 's'}</small>`),
        kpi('Refunds', money(refunds), `<small>${k.fullRefundCount} whole order${k.fullRefundCount === 1 ? '' : 's'} + ${k.partialRefundOrderCount} part</small>`),
        kpi('Tax collected', money(k.taxCents), '<small>&nbsp;</small>'),
      ].join('')}</div>` +
        (k.voidCount > 0
          ? `<p>Cancelled before payment: ${k.voidCount} order${k.voidCount === 1 ? '' : 's'} (${money(k.voidCents)}) — not in the sales.</p>`
          : '') +
        (k.unpaidCount > 0
          ? `<p>Not paid yet: ${k.unpaidCount} order${k.unpaidCount === 1 ? '' : 's'} (${money(k.unpaidCents)}) — they count once paid.</p>`
          : '') +
        `</section>`,
    );

    const payRows = PAYMENT_ORDER.filter((g) => k.payments[g] !== 0).map((g) => [
      esc(PAYMENT_LABEL[g]),
      money(k.payments[g]),
      esc(percentOf(k.payments[g], k.netSalesCents)),
    ]);
    if (k.unrecordedPaymentCents !== 0) payRows.push(['No method recorded', money(k.unrecordedPaymentCents), '']);
    parts.push(
      `<section class="two"><div><h2>How customers paid</h2>${table(['Paid by', 'Amount', 'Share'], payRows, [1, 2])}</div>` +
        `<div><h2>How the sales add up</h2>${table(
          ['', ''],
          [
            ['Items at menu price', money(k.menuSalesCents)],
            ['− Discounts', money(k.discountCents)],
            ['+ Tax', money(k.taxCents)],
            ['− Refunds on these orders', money(k.partialRefundCents)],
            ['<b>= Sales</b>', `<b>${money(k.netSalesCents)}</b>`],
          ],
          [1],
        )}</div></section>`,
    );

    const split = websiteVsTill(r.channels);
    parts.push(
      `<section><h2>Website vs till</h2>${table(
        ['Taken on', 'Orders', 'Sales', 'Share'],
        [
          ['Website (pick-up and delivery)', String(split.website.orderCount), money(split.website.netSalesCents), esc(percentOf(split.website.netSalesCents, k.netSalesCents))],
          ['Till (counter, phone, Foodpanda)', String(split.till.orderCount), money(split.till.netSalesCents), esc(percentOf(split.till.netSalesCents, k.netSalesCents))],
        ],
        [1, 2, 3],
      )}</section>`,
    );
    return parts;
  },

  when: (r, period, madeAt) => {
    const days = daySeries(r.byDay, period, madeAt);
    const hours = hourSeries(r.byHour);
    const parts = [...r.dayparts.lines, ...(r.dayparts.other ? [r.dayparts.other] : [])];
    return [
      `<section class="two"><div><h2>${days.unit === 'day' ? 'Sales by day' : 'Sales by month'}</h2>${table(
        [days.unit === 'day' ? 'Day' : 'Month', 'Orders', 'Sales'],
        days.bars.map((d) => [esc(d.title), String(d.orderCount), money(d.netSalesCents)]),
        [1, 2],
      )}</div><div><h2>Sales by hour (Pakistan time)</h2>${table(
        ['Hour', 'Orders', 'Sales'],
        hours.map((h) => [esc(hourLabel(h.hour)), String(h.orderCount), money(h.netSalesCents)]),
        [1, 2],
      )}</div></section>`,
      `<section class="two"><div><h2>Parts of the day</h2>${table(
        ['Part', 'Orders', 'Sales', 'Average order'],
        parts.map((l) => [`${esc(l.name)} <span class="muted">${esc(daypartHoursText(l.fromHour, l.toHour))}</span>`, String(l.orderCount), money(l.netSalesCents), l.orderCount > 0 ? money(l.avgOrderCents) : '—']),
        [1, 2, 3],
      )}</div><div><h2>Notes on days</h2>${table(
        ['Day', 'What'],
        r.dayNotes.map((n) => [esc(fmtDay(n.day)), esc(dayNoteText(n))]),
      )}</div></section>`,
    ];
  },

  menu: (r) => {
    const items = limited(r.items, 15);
    const costs = r.costs;
    const withProfit = menuHasProfit(r);
    const bps = (v: number | null | undefined) => esc(v === null || v === undefined ? '—' : formatBps(v));
    const opt = (v: number | null | undefined) => (v === null || v === undefined ? '—' : money(v));
    const cells = (c: ReportLineCost | undefined): string[] =>
      costs ? [c && c.knownUnits > 0 ? bps(c.foodCostBps) : '—', ...(withProfit ? [opt(c?.profitCents)] : [])] : [];
    const head = costs ? ['Food cost', ...(withProfit ? ['Profit'] : [])] : [];
    const right = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
    return [
      `<section class="two"><div><h2>Top items</h2>${table(
        ['Item', 'Qty', 'Sales', ...head],
        items.shown.map((i) => [esc(i.name), String(i.quantity), money(i.salesCents), ...cells(costs?.items[i.key])]),
        right(2 + head.length),
      )}${items.note}</div><div><h2>Categories</h2>${table(
        ['Category', 'Qty', 'Sales', ...head],
        r.categories.map((c) => [esc(c.name), String(c.quantity), money(c.salesCents), ...cells(costs?.categories[c.categoryId ?? `name:${c.name}`])]),
        right(2 + head.length),
      )}<p class="muted">At menu price, before order discounts.${
        costs ? ` Food cost${withProfit ? ' and profit (before channel costs)' : ''} on the sales whose cost is fully known, at what customers paid.` : ''
      }</p></div></section>`,
    ];
  },

  channels: (r) => {
    const k = r.kpis;
    const parts = [
      `<section><h2>Order types</h2>${table(
        ['Order type', 'Orders', 'Sales', 'Share'],
        r.channels.map((c) => [esc(CHANNEL_LABEL[c.channel]), String(c.orderCount), money(c.netSalesCents), esc(percentOf(c.netSalesCents, k.netSalesCents))]),
        [1, 2, 3],
      )}</section>`,
    ];
    if (r.profit) parts.push(channelProfitPrint(r.profit.channels, `${commissionText(r.profit.fees)} ${riderText(r.profit.riderCost)}`));
    if (r.deliveries.byRider.length > 0) {
      const withProfit = r.areas.some((a) => a.riderCents !== null);
      const areas = limited(r.areas, 15);
      parts.push(
        `<section><h2>Deliveries by rider</h2>${table(
          ['Rider', 'Deliveries', 'Sales', 'Avg time out'],
          r.deliveries.byRider.map((d) => [esc(d.name), String(d.deliveries), money(d.netSalesCents), esc(fmtMinutes(d.avgMinutesOut))]),
          [1, 2, 3],
        )}</section><section><h2>Deliveries by area</h2>${table(
          ['Area', 'Orders', 'Sales', 'Charges before tax', 'Avg time out', 'Came back', ...(withProfit ? ['Rider', 'Earns / order'] : [])],
          areas.shown.map((a) => [
            esc(a.area),
            String(a.orderCount),
            money(a.netSalesCents),
            money(a.feesCollectedCents),
            esc(fmtMinutes(a.avgMinutesOut)),
            a.customers > 0 ? esc(`${a.repeatCustomers} of ${a.customers}`) : '—',
            ...(withProfit
              ? [a.riderCents === null ? '—' : money(a.riderCents), a.contributionPerOrderCents === null ? '—' : money(a.contributionPerOrderCents)]
              : []),
          ]),
          withProfit ? [1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 4, 5],
        )}${areas.note}${
          r.noRateCount > 0
            ? `<p><b>${r.noRateCount} ${r.noRateCount === 1 ? 'delivery has' : 'deliveries have'} no area and no delivery charge:</b> ${r.noRateDeliveries
                .slice(0, 15)
                .map((d) => esc(`order ${d.orderNumber}${d.area ? ` (“${d.area}”)` : ''}`))
                .join(', ')}.</p>`
            : ''
        }</section>`,
      );
    } else {
      parts.push('<section><h2>Deliveries</h2><p class="muted">No deliveries in this period.</p></section>');
    }
    return parts;
  },

  foodStock: (r) => {
    const food = r.foodCost;
    if (!food.hasUsage && food.foodSalesCents === 0) {
      return [
        '<section><h2>Food cost (this till)</h2><p class="muted">No food sold or wasted in this period.</p></section>',
        purchasesPrint(r.purchases),
      ];
    }
    const estimated = estimatedText(food);
    const reconcile = menuPriceLine(food);
    const missing = limited(food.missingSales, 10);
    return [
      `<section><h2>Food cost (this till)</h2><p><b>${esc(foodCostHeadline(food))}</b>` +
        (food.foodSalesCents > 0 ? `, ${esc(coverageText(food))}` : '') +
        ` · cost of food sold ${money(food.costOfSalesCents)} of ${money(food.foodSalesCents)} food sales (before tax, after discounts)` +
        (food.wasteCents > 0 ? ` · waste ${money(food.wasteCents)}` : '') +
        (food.sentNotPaid.orderCount > 0 ? ` · sent out, not paid: ${esc(unpaidFoodText(food.sentNotPaid))}` : '') +
        `.</p>` +
        (reconcile ? `<p class="muted">${esc(reconcile)}.</p>` : '') +
        (estimated ? `<p class="muted">${esc(estimated)} ${esc(costingStartText(food.costingStartedAt))}</p>` : '') +
        `<div class="two"><div>${table(
          ['Waste by reason', 'Times', 'Cost'],
          food.wasteByReason.map((w) => [esc(WASTE_REASON_LABEL[w.reason]), String(w.times), money(w.cents)]),
          [1, 2],
        )}</div><div>${table(
          ['Sales with missing costs', 'Why', 'Sales'],
          missing.shown.map((m) => [esc(m.name), esc(MISSING_COST_WHY[m.why]), money(m.salesCents)]),
          [2],
        )}${missing.note}</div></div></section>`,
      purchasesPrint(r.purchases),
    ];
  },

  team: (r) => {
    const hasCosts = r.foodCost?.hasCosts ?? false;
    const parts: string[] = [];
    parts.push(
      `<section><h2>Staff</h2>${table(
        ['Taken by', 'Orders', 'Sales', 'Discounts given', 'Cancelled', 'No-sale opens', 'Drawer opens'],
        r.staff.map((s) => [
          esc(s.name),
          String(s.orderCount),
          money(s.netSalesCents),
          money(s.discountCents),
          String(s.voidCount),
          String(s.noSaleOpens),
          s.drawerOpens === undefined ? '—' : String(s.drawerOpens),
        ]),
        [1, 2, 3, 4, 5, 6],
      )}</section>`,
    );

    if (r.shifts.length > 0) {
      parts.push(
        `<section><h2>Cash drawer (shifts)</h2>${table(
          ['Opened', 'Closed', 'By', 'Float', 'Expected', 'Counted', 'Short / over', 'Cash in/out', 'No-sale opens', 'Notes'],
          r.shifts.map((s) => [
            `${esc(fmtWhen(s.openedAt))}${shiftTestDeletedNote(s) ? ` <span class="muted">${esc(shiftTestDeletedNote(s) ?? '')}</span>` : ''}`,
            s.closedAt ? esc(fmtWhen(s.closedAt)) : 'Still open',
            esc(s.closedBy ?? s.openedBy),
            money(s.openingCashCents),
            s.expectedCashCents === null ? '—' : money(s.expectedCashCents),
            s.countedCashCents === null ? '—' : money(s.countedCashCents),
            s.varianceCents === null
              ? '—'
              : s.varianceCents === 0
                ? 'Matched'
                : `${s.varianceCents > 0 ? 'Over' : 'Short'} ${money(Math.abs(s.varianceCents))}`,
            String(s.cashMovementCount),
            String(s.noSaleOpens),
            // Opening and closing notes, then any unpaid orders carried over — each on its own line.
            shiftDetailLines(s).map(esc).join('<br>') || '—',
          ]),
          [3, 4, 5, 6, 7, 8],
        )}</section>`,
      );
    }

    if (r.drawerOpenCount > 0) {
      const list = limitedOf(r.drawerOpens, 25, r.drawerOpenCount);
      parts.push(
        `<section><h2>Cash drawer opened by hand (no sale, count, test) — ${r.drawerOpenCount} time${r.drawerOpenCount === 1 ? '' : 's'}</h2>${table(
          ['When', 'Why', 'Reason', 'Opened by', 'Approved by'],
          list.shown.map((d) => [
            `${esc(fmtWhen(d.createdAt))}${d.outsideShift ? ' <span class="muted">(no shift open)</span>' : ''}`,
            esc(DRAWER_OPEN_WHY[d.kind]),
            d.reason ? esc(d.reason) : '—',
            esc(d.openedBy),
            d.approvedBy ? esc(d.approvedBy) : '—',
          ]),
        )}${list.note}</section>`,
      );
    }

    if (r.discounts.totalCount > 0) {
      parts.push(
        `<section class="two"><div><h2>Discounts — why</h2>${table(
          ['Reason', 'Times', 'Amount'],
          r.discounts.byReason.map((d) => [esc(d.reason), String(d.count), money(d.amountCents)]),
          [1, 2],
        )}</div><div><h2>Discounts — who</h2>${table(
          ['Given by', 'Times', 'Amount'],
          r.discounts.byPerson.map((d) => [esc(d.name), String(d.count), money(d.amountCents)]),
          [1, 2],
        )}</div></section>`,
      );
    }

    if (r.refunds.length > 0) {
      const list = limited(r.refunds, 25);
      parts.push(
        `<section><h2>Refunds</h2>${table(
          ['When', 'Order', 'Amount', 'Paid back as', 'Reason', 'Stock', 'Approved by'],
          list.shown.map((x) => [
            esc(fmtWhen(x.refundedAt)),
            esc(x.orderNumber),
            `${money(x.amountCents)}${x.full ? ' (whole order)' : ''}`,
            esc(methodLabel(x.method)),
            esc(x.reason),
            esc(stockCellText(x.stock, hasCosts)),
            esc(x.approvedBy),
          ]),
          [2],
        )}${list.note}</section>`,
      );
    }

    if (r.voids.length > 0) {
      const list = limited(r.voids, 25);
      parts.push(
        `<section><h2>Cancelled before payment</h2>${table(
          ['When', 'Order', 'Value', 'Reason', 'Stock', 'Approved by', 'Taken by'],
          list.shown.map((v) => [
            esc(fmtWhen(v.voidedAt ?? v.createdAt)),
            esc(v.orderNumber),
            money(v.amountCents),
            esc(v.reason),
            esc(stockCellText(v.stock, hasCosts)),
            esc(v.approvedBy),
            esc(v.takenBy),
          ]),
          [2],
        )}${list.note}</section>`,
      );
    }
    return parts;
  },

  profit: (r) => profitPrint(r),
};

function printHeader(title: string, period: ReportPeriod, madeAt: Date, withCompare: boolean): string {
  return (
    `<header><h1>${esc(title)}</h1><div>${esc(period.dates)} · trading day 5 am to 5 am` +
    `${withCompare && period.compare ? ` · compared with ${esc(period.compare.label)}` : ''}</div>` +
    `<div class="muted">Printed ${esc(fmtWhen(madeAt.toISOString()))}${period.isCurrent ? ' · the period is still running' : ''}</div></header>`
  );
}

/** What each order type earns, on paper (costing spec Phase 9). */
function channelProfitPrint(channels: readonly ReportChannelProfit[], note: string): string {
  return `<section><h2>What each order type earns</h2>${table(
    ['Order type', 'Orders', 'Sales before tax', 'Food cost', 'Commission', 'Rider', 'Earns', 'Per order'],
    channels.map((c) => [
      esc(CHANNEL_LABEL[c.channel]),
      String(c.orderCount),
      money(c.salesCents),
      money(c.foodCostCents),
      c.commissionCents > 0 ? money(c.commissionCents) : '—',
      c.riderCents > 0 ? money(c.riderCents) : '—',
      `<b>${money(c.contributionCents)}</b>`,
      c.contributionPerOrderCents === null ? '—' : money(c.contributionPerOrderCents),
    ]),
    [1, 2, 3, 4, 5, 6, 7],
  )}<p class="muted">Sales before tax, less the food whose cost is known, commission, card fees and the rider; before waste and missing stock. An order with food of unknown cost counts only in the share that is known. ${esc(note)}</p></section>`;
}

/** The menu map on paper (costing spec 4.8). */
function menuMapPrint(m: ReportMenuMap): string {
  const cats = m.categories.map((c) => {
    if (c.state !== 'ok') {
      return `<p><b>${esc(c.name)}</b>: ${esc(c.state === 'few_sales' ? `not enough sales yet (${c.units} sold, it needs 200)` : 'not enough dishes with a known cost sold yet (it needs 3)')}.</p>`;
    }
    return `<p><b>${esc(c.name)}</b> <span class="muted">${c.units} sold · a sale earns ${money(c.averageProfitCents ?? 0)} on average</span></p>${table(
      ['Dish', 'Sold', 'Earns a sale', 'What to do'],
      c.items.map((d) => [esc(d.name), `${d.units} (${esc(formatBps(d.mixBps))})`, money(d.profitPerSaleCents), `${esc(menuMapAdvice(d, c.name))} <span class="muted">(${esc(MENU_MAP_WORDS[d.class].term)})</span>`]),
      [1, 2],
    )}`;
  });
  return `<section><h2>Menu map (${m.lastDays ? 'the last 28 days' : 'the period'})</h2>${cats.join('')}<p class="muted">What one sale earns at menu price, less its cost. Nothing changes on the till.</p></section>`;
}

/** Profit (costing spec Phase 9, profit.view) on paper: the waterfall, then by order type and by category. */
function profitPrint(r: ReportTabData['profit']): string[] {
  const unknown = unknownCostNote(r);
  const gain = stockGainNote(r);
  return [
    `<section><h2>From sales to profit before overheads (this till)</h2><p><b>${esc(profitHeadline(r))}</b></p>${table(
      ['', 'Rs'],
      [...r.steps.map((s) => [esc(stepLabel(s.key, s.cents)), esc(stepAmount(s.key, s.cents))]), ['<b>Profit before overheads</b>', `<b>${money(r.profitCents)}</b>`]],
      [1],
    )}${unknown ? `<p class="muted">${esc(unknown)}</p>` : ''}${gain ? `<p class="muted">${esc(gain)}</p>` : ''}${
      r.stockLoss.state !== 'counted' && r.stockLoss.message ? `<p class="muted">${esc(r.stockLoss.message)}</p>` : ''
    }<p class="muted">${esc(commissionText(r.fees))} ${esc(riderText(r.riderCost))} ${esc(estimatedText(r))}</p></section>`,
    channelProfitPrint(r.channels, ''),
    `<section><h2>Profit by category</h2>${table(
      ['Category', 'Sold', 'Sales', 'Costs known', 'Food cost', 'Profit', 'Per sale'],
      r.categories.map((c) => [
        esc(c.name),
        String(c.units),
        money(c.salesCents),
        esc(c.coverageBps === null ? '—' : formatBps(c.coverageBps)),
        esc(c.foodCostBps === null ? '—' : formatBps(c.foodCostBps)),
        c.profitCents === null ? '—' : money(c.profitCents),
        c.profitPerSaleCents === null ? '—' : money(c.profitPerSaleCents),
      ]),
      [1, 2, 3, 4, 5, 6],
    )}<p class="muted">Food only, on the sales whose cost is fully known, before channel costs (commission, rider).</p></section>`,
  ];
}

/** Purchases (costing spec Phase 5): spend by supplier and by ingredient, with the latest price's change. */
function purchasesPrint(p: ReportTabData['foodStock']['purchases']): string {
  if (!hasPurchases(p)) return '<section><h2>Purchases (this till)</h2><p class="muted">No stock bought in this period.</p></section>';
  const hand = byHandText(p);
  const ings = limited(p.byIngredient, 20);
  return (
    `<section><h2>Purchases (this till)</h2><p><b>${esc(purchaseHeadline(p))}</b></p>` +
    (hand ? `<p class="muted">${esc(hand)}</p>` : '') +
    `<div class="two"><div>${table(
      ['Bought from', 'Bills', 'Spent'],
      p.bySupplier.map((s) => [esc(s.name), purchaseBillsText(s), money(s.spendCents)]),
      [1, 2],
    )}</div><div>${table(
      ['Ingredient', 'Spent', 'Latest price'],
      ings.shown.map((l) => [esc(l.name), money(l.spendCents), esc(`${purchasePriceText(l)}${purchaseChangeText(l) ? ` ${purchaseChangeText(l)!.text}` : ''}`)]),
      [1, 2],
    )}${ings.note}</div></div></section>`
  );
}

export function buildTabPrintBody<K extends ReportTab>(
  tab: K,
  data: ReportTabData[K],
  period: ReportPeriod,
  madeAt: Date = new Date(),
  extras: ReportExtras = {},
): string {
  const parts = (PRINT_PARTS[tab] as PrintPart<K>)(data, period, madeAt);
  if (tab === 'overview' && extras.trends) parts.push(trendsPrint(extras.trends));
  if (tab === 'foodStock' && extras.variance) parts.unshift(variancePrint(extras.variance));
  if (tab === 'team') parts.push(...teamExtrasPrint(extras));
  if (tab === 'menu' && extras.menuMap) parts.push(menuMapPrint(extras.menuMap));
  return printHeader(`${REPORT_TAB_LABEL[tab]} — ${period.title}`, period, madeAt, tab === 'overview') + parts.join('');
}

/** "Used vs should have used" between two stock takes, on paper (costing spec Phase 8). */
function variancePrint(v: ReportVariance): string {
  if (v.state !== 'ok') return `<section><h2>Used vs should have used</h2><p class="muted">${esc(v.message ?? '')}</p></section>`;
  const stale = v.staleSync ? staleLinkText(v.link) : null;
  const lines = limited(v.lines, 25);
  const warnings = v.pairs.filter((p) => p.warning).map((p) => `<p><b>${esc(p.warning ?? '')}</b></p>`).join('');
  const a = v.actualCogs;
  return (
    `<section><h2>Used vs should have used (every till's stock)</h2>` +
    `<p class="muted">${esc(varianceWindowText(v) ?? '')}</p>` +
    (stale ? `<p><b>${esc(stale)}</b></p>` : '') +
    `<p><b>${esc(varianceHeadline(v))}</b>${v.band ? ` Rating: ${esc(VARIANCE_BAND_LABEL[v.band])}.` : ''}</p>` +
    warnings +
    table(
      ['Ingredient', 'Should have used', 'Went', 'Waste logged', 'Not explained', 'Rs'],
      lines.shown.map((l) => [
        `${esc(l.name)} <span class="muted">${esc(lineVerdict(l))}</span>`,
        esc(formatQty(l.shouldHaveUsed, l.unit)),
        esc(formatQty(l.used, l.unit)),
        l.wasted === 0 ? '—' : esc(formatQty(l.wasted, l.unit)),
        esc(signedQty(l.unexplained, l.unit)),
        l.priced ? esc(signedCents(l.unexplainedCents)) : 'no price',
      ]),
      [1, 2, 3, 4, 5],
    ) +
    lines.note +
    (v.corrections.length > 0
      ? `<p class="muted">Fixes typed in this time (not counted in what went): ${v.corrections
          .map((c) => esc(`${c.name} ${signedQty(c.qty, c.unit)}`))
          .join(', ')}.</p>`
      : '') +
    (v.alreadyCounted.length > 0
      ? `<p class="muted">Left out, already counted by a stock take: ${v.alreadyCounted
          .map((x) => esc(`order ${x.orderNumber ?? x.orderId.slice(0, 8)} ${formatQty(Math.abs(x.qty), x.unit)} ${x.name}`))
          .join(', ')}.</p>`
      : '') +
    `</section><section><h2>Real food cost</h2>` +
    (a
      ? `<p><b>${esc(actualCogsText(a))}</b></p>${table(
          ['', 'Rs'],
          [
            ['Stock held at the first stock take', money(a.openingCents)],
            ['+ bought in between', money(a.purchasesCents)],
            ['− stock held at the second', money(a.closingCents)],
            ['= food used', money(a.costCents)],
          ],
          [1],
        )}<p class="muted">Includes price changes on stock you held. Only ingredients a recipe or a batch uses.</p>`
      : `<p class="muted">${esc(v.actualCogsWhyNot ?? '')}</p>`) +
    `</section>`
  );
}

/** Overview's trend strip and 12 months on paper. */
function trendsPrint(t: ReportTrends): string {
  const then = (c: TrendComparison) =>
    `${esc(trendChangeOf(c.change.sales).text)}${c.figures ? `<span class="muted">, was ${money(c.figures.netSalesCents)}</span>` : ''}`;
  const lines = table(
    ['', 'Sales', 'Orders', 'Average order', 'Against before', 'Against a year ago'],
    t.lines.map((line) => {
      const f = line.current.figures;
      return [
        esc(TREND_LABEL[line.period].title),
        money(f.netSalesCents),
        String(f.orderCount),
        money(f.avgOrderCents),
        `${then(line.previous)} <span class="muted">(${esc(TREND_LABEL[line.period].previous)})</span>`,
        line.lastYear ? then(line.lastYear) : '—',
      ];
    }),
    [1, 2, 3],
  );
  const costs = new Map((t.monthCosts ?? []).map((m) => [m.month, m]));
  const months =
    t.months.length === 0
      ? ''
      : `<section><h2>The last 12 months</h2>${table(
          ['Month', 'Sales', 'Orders', 'Average order', ...(t.monthCosts ? ['Food cost'] : [])],
          t.months.map((m, i) => {
            const note = monthNote(m, i === t.months.length - 1);
            const none = note === 'no data then';
            const c = costs.get(m.month);
            return [
              `${esc(fmtMonth(`${m.month}-01`))}${note ? ` <span class="muted">${esc(note)}</span>` : ''}`,
              none ? '—' : money(m.netSalesCents),
              none ? '—' : String(m.orderCount),
              none || m.orderCount === 0 ? '—' : money(m.avgOrderCents),
              ...(t.monthCosts ? [c?.foodCostBps != null ? esc(formatBps(c.foodCostBps)) : '—'] : []),
            ];
          }),
          t.monthCosts ? [1, 2, 3, 4] : [1, 2, 3],
        )}</section>`;
  return (
    `<section><h2>How the shop is trending</h2><p class="muted">So far, to the minute; not tied to the period above. This till's orders.</p>${lines}` +
    `${t.partial ? '<p class="muted">Worked out on the till itself: only stretches of 31 days or less.</p>' : ''}</section>${months}`
  );
}

/**
 * "Print everything": every tab given (the ones this login can see), in the
 * page's order, under one heading, each tab under its own name.
 */
export function buildPrintEverything(tabs: SomeReportTabs, period: ReportPeriod, madeAt: Date = new Date(), extras: ReportExtras = {}): string {
  const parts = [printHeader(`Sales report — ${period.title}`, period, madeAt, tabs.overview !== undefined)];
  for (const tab of REPORT_TABS) {
    const data = tabs[tab];
    if (data === undefined) continue;
    parts.push(`<div class="tab-title">${esc(REPORT_TAB_LABEL[tab])}</div>`);
    if (tab === 'foodStock' && extras.variance) parts.push(variancePrint(extras.variance));
    parts.push(...(PRINT_PARTS[tab] as PrintPart<typeof tab>)(data as never, period, madeAt));
    if (tab === 'overview' && extras.trends) parts.push(trendsPrint(extras.trends));
    if (tab === 'team') parts.push(...teamExtrasPrint(extras));
    if (tab === 'menu' && extras.menuMap) parts.push(menuMapPrint(extras.menuMap));
  }
  return parts.join('');
}

/**
 * Print CSS for the report sheet. The sheet is rendered into document.body
 * next to the app; on paper everything else is hidden and the page is freed
 * from the app's full-height, no-scroll layout so long reports run on.
 */
export const PRINT_SHEET_CLASS = 'coc-report-print';
export const PRINT_CSS = `
@media screen { .${PRINT_SHEET_CLASS} { display: none !important; } }
@media print {
  @page { size: A4; margin: 12mm; }
  html, body, #root { height: auto !important; overflow: visible !important; }
  body { background: #fff !important; background-image: none !important; }
  body > *:not(.${PRINT_SHEET_CLASS}) { display: none !important; }
  .${PRINT_SHEET_CLASS} { display: block; color: #111; font: 11px/1.4 'Segoe UI', Inter, system-ui, sans-serif; }
  .${PRINT_SHEET_CLASS} h1 { font-size: 18px; margin: 0 0 2px; }
  .${PRINT_SHEET_CLASS} h2 { font-size: 12px; margin: 12px 0 4px; padding-bottom: 2px; border-bottom: 1.5px solid #333; text-transform: uppercase; letter-spacing: .04em; }
  .${PRINT_SHEET_CLASS} .tab-title { font-size: 15px; font-weight: 700; margin: 18px 0 0; }
  .${PRINT_SHEET_CLASS} header { margin-bottom: 8px; }
  .${PRINT_SHEET_CLASS} section { break-inside: avoid; }
  .${PRINT_SHEET_CLASS} .two { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .${PRINT_SHEET_CLASS} .kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
  .${PRINT_SHEET_CLASS} .kpi { border: 1px solid #999; border-radius: 4px; padding: 5px 7px; }
  .${PRINT_SHEET_CLASS} .kpi span { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #444; }
  .${PRINT_SHEET_CLASS} .kpi b { display: block; font-size: 17px; }
  .${PRINT_SHEET_CLASS} table { width: 100%; border-collapse: collapse; }
  .${PRINT_SHEET_CLASS} th, .${PRINT_SHEET_CLASS} td { padding: 2px 4px; text-align: left; border-bottom: 1px solid #ddd; vertical-align: top; }
  .${PRINT_SHEET_CLASS} th { font-size: 10px; color: #444; }
  .${PRINT_SHEET_CLASS} .r { text-align: right; white-space: nowrap; }
  .${PRINT_SHEET_CLASS} .muted { color: #555; }
  .${PRINT_SHEET_CLASS} p { margin: 4px 0; }
}`;
