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
import { REPORT_TAB_LABEL, REPORT_TABS, type ReportKpis, type ReportTab, type ReportTabData } from '@cheeseoclock/shared-types';
import { formatCents } from '@cheeseoclock/pos-domain';
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
  stockCellText,
  unpaidFoodText,
  websiteVsTill,
} from './reportFormat';
import { formatBps } from '../costing/costingFormat';

/** Some or all of the tabs, as fetched (for "Print everything"). */
export type SomeReportTabs = { [K in ReportTab]?: ReportTabData[K] };

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
  },

  menu: (sheet, r) => {
    sheet.heading('Items sold (menu price, before order discounts)');
    sheet.push(['Item', 'Category', 'Quantity', 'Sales Rs']);
    for (const i of r.items) sheet.push([i.name, i.categoryName, i.quantity, rs(i.salesCents)]);
    sheet.heading('Categories (menu price, before order discounts)');
    sheet.push(['Category', 'Quantity', 'Sales Rs']);
    for (const c of r.categories) sheet.push([c.name, c.quantity, rs(c.salesCents)]);
  },

  channels: (sheet, r) => {
    sheet.heading('Order types');
    sheet.push(['Order type', 'Orders', 'Sales Rs']);
    for (const c of r.channels) sheet.push([CHANNEL_LABEL[c.channel], c.orderCount, rs(c.netSalesCents)]);
    sheet.heading('Deliveries by rider');
    sheet.push(['Rider', 'Deliveries', 'Sales Rs', 'Average time on the road (minutes)']);
    for (const d of r.deliveries.byRider) sheet.push([d.name, d.deliveries, rs(d.netSalesCents), d.avgMinutesOut]);
    sheet.heading('Deliveries by area');
    sheet.push(['Area', 'Orders', 'Sales Rs']);
    for (const a of r.deliveries.byArea) sheet.push([a.area, a.orderCount, rs(a.netSalesCents)]);
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
  },

  team: (sheet, r) => {
    const hasCosts = r.foodCost?.hasCosts ?? false;
    sheet.heading('Staff');
    sheet.push(['Taken by', 'Orders', 'Sales Rs', 'Discounts given Rs', 'Cancelled orders', 'Drawer opened with no sale']);
    for (const s of r.staff) {
      sheet.push([s.name, s.orderCount, rs(s.netSalesCents), rs(s.discountCents), s.voidCount, s.noSaleOpens]);
    }

    sheet.heading('Shifts (cash drawer)');
    sheet.push(['Opened', 'Closed', 'Opened by', 'Closed by', 'Float Rs', 'Cash put in Rs', 'Cash taken out Rs', 'Expected Rs', 'Counted Rs', 'Short (-) / over (+) Rs', 'Cash in/out entries', 'Drawer opened with no sale']);
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
        ? `Cash drawer opened by hand (no sale) — latest ${r.drawerOpens.length} of ${r.drawerOpenCount}`
        : 'Cash drawer opened by hand (no sale)',
    );
    sheet.push(['When', 'Why', 'Reason', 'Opened by', 'Approved by', 'Shift open']);
    for (const d of r.drawerOpens) {
      sheet.push([fmtWhen(d.createdAt), DRAWER_OPEN_WHY[d.kind], d.reason, d.openedBy, d.approvedBy, d.outsideShift ? 'No' : 'Yes']);
    }
  },
};

/** One tab as a CSV file: the period, then that tab's sections only. */
export function buildTabCsv<K extends ReportTab>(tab: K, data: ReportTabData[K], period: ReportPeriod, madeAt: Date = new Date()): string {
  const sheet = new CsvSheet();
  sheet.push(['Sales report', REPORT_TAB_LABEL[tab]]);
  sheet.push(['Period', `${period.title}: ${period.dates}`]);
  sheet.push(['Trading day', '5 am to 5 am, Pakistan time. Orders count on the day they were started.']);
  if (tab === 'overview' && period.compare) sheet.push(['Compared with', period.compare.label]);
  sheet.push(['Made', fmtWhen(madeAt.toISOString())]);
  (CSV_PARTS[tab] as CsvPart<K>)(sheet, data, period, madeAt);
  return toCsv(sheet.rows);
}

const TAB_SLUG: Record<ReportTab, string> = {
  overview: 'overview',
  when: 'when',
  menu: 'menu',
  channels: 'channels-delivery',
  foodStock: 'food-cost-stock',
  team: 'team-leakage',
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
    ];
  },

  menu: (r) => {
    const items = limited(r.items, 15);
    return [
      `<section class="two"><div><h2>Top items</h2>${table(
        ['Item', 'Qty', 'Sales'],
        items.shown.map((i) => [esc(i.name), String(i.quantity), money(i.salesCents)]),
        [1, 2],
      )}${items.note}</div><div><h2>Categories</h2>${table(
        ['Category', 'Qty', 'Sales'],
        r.categories.map((c) => [esc(c.name), String(c.quantity), money(c.salesCents)]),
        [1, 2],
      )}<p class="muted">At menu price, before order discounts.</p></div></section>`,
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
    if (r.deliveries.byRider.length > 0) {
      parts.push(
        `<section class="two"><div><h2>Deliveries by rider</h2>${table(
          ['Rider', 'Deliveries', 'Sales', 'Avg time out'],
          r.deliveries.byRider.map((d) => [esc(d.name), String(d.deliveries), money(d.netSalesCents), esc(fmtMinutes(d.avgMinutesOut))]),
          [1, 2, 3],
        )}</div><div><h2>Deliveries by area</h2>${table(
          ['Area', 'Orders', 'Sales'],
          limited(r.deliveries.byArea, 15).shown.map((a) => [esc(a.area), String(a.orderCount), money(a.netSalesCents)]),
          [1, 2],
        )}</div></section>`,
      );
    } else {
      parts.push('<section><h2>Deliveries</h2><p class="muted">No deliveries in this period.</p></section>');
    }
    return parts;
  },

  foodStock: (r) => {
    const food = r.foodCost;
    if (!food.hasUsage && food.foodSalesCents === 0) {
      return ['<section><h2>Food cost (this till)</h2><p class="muted">No food sold or wasted in this period.</p></section>'];
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
    ];
  },

  team: (r) => {
    const hasCosts = r.foodCost?.hasCosts ?? false;
    const parts: string[] = [];
    parts.push(
      `<section><h2>Staff</h2>${table(
        ['Taken by', 'Orders', 'Sales', 'Discounts given', 'Cancelled', 'No-sale opens'],
        r.staff.map((s) => [
          esc(s.name),
          String(s.orderCount),
          money(s.netSalesCents),
          money(s.discountCents),
          String(s.voidCount),
          String(s.noSaleOpens),
        ]),
        [1, 2, 3, 4, 5],
      )}</section>`,
    );

    if (r.shifts.length > 0) {
      parts.push(
        `<section><h2>Cash drawer (shifts)</h2>${table(
          ['Opened', 'Closed', 'By', 'Float', 'Expected', 'Counted', 'Short / over', 'Cash in/out', 'No-sale opens'],
          r.shifts.map((s) => [
            esc(fmtWhen(s.openedAt)),
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
          ]),
          [3, 4, 5, 6, 7, 8],
        )}</section>`,
      );
    }

    if (r.drawerOpenCount > 0) {
      const list = limitedOf(r.drawerOpens, 25, r.drawerOpenCount);
      parts.push(
        `<section><h2>Cash drawer opened by hand — ${r.drawerOpenCount} time${r.drawerOpenCount === 1 ? '' : 's'}</h2>${table(
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
};

function printHeader(title: string, period: ReportPeriod, madeAt: Date, withCompare: boolean): string {
  return (
    `<header><h1>${esc(title)}</h1><div>${esc(period.dates)} · trading day 5 am to 5 am` +
    `${withCompare && period.compare ? ` · compared with ${esc(period.compare.label)}` : ''}</div>` +
    `<div class="muted">Printed ${esc(fmtWhen(madeAt.toISOString()))}${period.isCurrent ? ' · the period is still running' : ''}</div></header>`
  );
}

/** One tab's printout (HTML, escaped): the period, then that tab's sections only. */
export function buildTabPrintBody<K extends ReportTab>(tab: K, data: ReportTabData[K], period: ReportPeriod, madeAt: Date = new Date()): string {
  const parts = (PRINT_PARTS[tab] as PrintPart<K>)(data, period, madeAt);
  return printHeader(`${REPORT_TAB_LABEL[tab]} — ${period.title}`, period, madeAt, tab === 'overview') + parts.join('');
}

/**
 * "Print everything": every tab given (the ones this login can see), in the
 * page's order, under one heading, each tab under its own name.
 */
export function buildPrintEverything(tabs: SomeReportTabs, period: ReportPeriod, madeAt: Date = new Date()): string {
  const parts = [printHeader(`Sales report — ${period.title}`, period, madeAt, tabs.overview !== undefined)];
  for (const tab of REPORT_TABS) {
    const data = tabs[tab];
    if (data === undefined) continue;
    parts.push(`<div class="tab-title">${esc(REPORT_TAB_LABEL[tab])}</div>`);
    parts.push(...(PRINT_PARTS[tab] as PrintPart<typeof tab>)(data as never, period, madeAt));
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
