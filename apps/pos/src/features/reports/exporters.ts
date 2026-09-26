/**
 * Getting a report off the screen: a CSV the owner can open in Excel, and a
 * one-document printout. The builders are pure (tested); `downloadText` and
 * the print CSS are the only browser-facing parts.
 *
 * Every number comes straight from the BusinessReport — nothing is worked out
 * again here, so paper, file and screen always agree.
 */
import type { BusinessReport, ReportKpis } from '@cheeseoclock/shared-types';
import { formatCents } from '@cheeseoclock/pos-domain';
import type { ReportPeriod } from './dateRange';
import {
  CHANNEL_LABEL,
  PAYMENT_LABEL,
  PAYMENT_ORDER,
  changeOf,
  daySeries,
  fmtMinutes,
  fmtQty,
  fmtWhen,
  hourLabel,
  hourSeries,
  methodLabel,
  percentOf,
} from './reportFormat';

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

export function buildCsv(r: BusinessReport, period: ReportPeriod, madeAt: Date = new Date()): string {
  const rows: CsvCell[][] = [];
  const blank = () => rows.push([]);
  const heading = (title: string) => {
    blank();
    rows.push([title.toUpperCase()]);
  };

  rows.push(['Sales report']);
  rows.push(['Period', `${period.title}: ${period.dates}`]);
  rows.push(['Trading day', '5 am to 5 am, Pakistan time. Orders count on the day they were started.']);
  if (period.compare) rows.push(['Compared with', period.compare.label]);
  rows.push(['Made', fmtWhen(madeAt.toISOString())]);

  heading('Summary');
  rows.push(['', 'This period', period.compare ? `Compared with ${period.compare.label}` : '']);
  rows.push(...kpiRows(r.kpis, r.previous));

  heading('Sales by day');
  rows.push(['Day', 'Orders', 'Sales Rs']);
  for (const d of daySeries(r.byDay, period, madeAt).bars) rows.push([d.title, d.orderCount, rs(d.netSalesCents)]);

  heading('Sales by hour (Pakistan time)');
  rows.push(['Hour', 'Orders', 'Sales Rs']);
  for (const h of hourSeries(r.byHour)) rows.push([hourLabel(h.hour), h.orderCount, rs(h.netSalesCents)]);

  heading('Items sold (menu price, before order discounts)');
  rows.push(['Item', 'Category', 'Quantity', 'Sales Rs']);
  for (const i of r.items) rows.push([i.name, i.categoryName, i.quantity, rs(i.salesCents)]);

  heading('Categories (menu price, before order discounts)');
  rows.push(['Category', 'Quantity', 'Sales Rs']);
  for (const c of r.categories) rows.push([c.name, c.quantity, rs(c.salesCents)]);

  heading('Order types');
  rows.push(['Order type', 'Orders', 'Sales Rs']);
  for (const c of r.channels) rows.push([CHANNEL_LABEL[c.channel], c.orderCount, rs(c.netSalesCents)]);

  heading('Staff');
  rows.push(['Taken by', 'Orders', 'Sales Rs', 'Discounts given Rs', 'Cancelled orders']);
  for (const s of r.staff) rows.push([s.name, s.orderCount, rs(s.netSalesCents), rs(s.discountCents), s.voidCount]);

  heading('Shifts (cash drawer)');
  rows.push(['Opened', 'Closed', 'Opened by', 'Closed by', 'Float Rs', 'Cash put in Rs', 'Cash taken out Rs', 'Expected Rs', 'Counted Rs', 'Short (-) / over (+) Rs']);
  for (const s of r.shifts) {
    rows.push([
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
    ]);
  }

  heading('Discounts by reason');
  rows.push(['Reason', 'Times', 'Amount Rs']);
  for (const d of r.discounts.byReason) rows.push([d.reason, d.count, rs(d.amountCents)]);
  heading('Discounts by person');
  rows.push(['Given by', 'Times', 'Amount Rs', 'With manager approval']);
  for (const d of r.discounts.byPerson) rows.push([d.name, d.count, rs(d.amountCents), d.approvedCount]);
  heading(
    r.discounts.recent.length < r.discounts.totalCount
      ? `Each discount (latest ${r.discounts.recent.length} of ${r.discounts.totalCount})`
      : 'Each discount',
  );
  rows.push(['When', 'Order', 'Amount Rs', 'Entered as', 'Reason', 'Given by', 'Approved by']);
  for (const d of r.discounts.recent) {
    rows.push([fmtWhen(d.createdAt), d.orderNumber, rs(d.amountCents), d.entered, d.reason, d.givenBy, d.approvedBy]);
  }

  heading('Refunds');
  rows.push(['Refunded', 'Order', 'Order started', 'Amount Rs', 'Paid back as', 'Whole order', 'Reason', 'Approved by']);
  for (const x of r.refunds) {
    rows.push([fmtWhen(x.refundedAt), x.orderNumber, fmtWhen(x.orderCreatedAt), rs(x.amountCents), methodLabel(x.method), x.full ? 'Yes' : 'No', x.reason, x.approvedBy]);
  }

  heading('Cancelled before payment');
  rows.push(['Cancelled', 'Order', 'Value Rs', 'Reason', 'Approved by', 'Taken by']);
  for (const v of r.voids) {
    rows.push([fmtWhen(v.voidedAt ?? v.createdAt), v.orderNumber, rs(v.amountCents), v.reason, v.approvedBy, v.takenBy]);
  }

  heading("Ingredients used (estimate at today's ingredient prices)");
  rows.push(['Ingredient', 'Unit', 'Used', 'Cost of used Rs', 'Wasted', 'Cost of waste Rs']);
  for (const i of r.foodCost.ingredients) {
    rows.push([i.name, i.unit, i.usedQty, rs(i.usedCents), i.wastedQty, rs(i.wastedCents)]);
  }
  rows.push(['Total', null, null, rs(r.foodCost.usedCents), null, rs(r.foodCost.wasteCents)]);

  heading('Deliveries by rider');
  rows.push(['Rider', 'Deliveries', 'Sales Rs', 'Average time on the road (minutes)']);
  for (const d of r.deliveries.byRider) rows.push([d.name, d.deliveries, rs(d.netSalesCents), d.avgMinutesOut]);
  heading('Deliveries by area');
  rows.push(['Area', 'Orders', 'Sales Rs']);
  for (const a of r.deliveries.byArea) rows.push([a.area, a.orderCount, rs(a.netSalesCents)]);

  return toCsv(rows);
}

export function csvFileName(period: Pick<ReportPeriod, 'firstDay' | 'lastDay'>): string {
  return period.firstDay === period.lastDay
    ? `sales-report-${period.firstDay}.csv`
    : `sales-report-${period.firstDay}-to-${period.lastDay}.csv`;
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

/**
 * The printed report's body (HTML, escaped). One page for a normal day:
 * the figures the owner checks, then who/why lists.
 */
export function buildPrintBody(r: BusinessReport, period: ReportPeriod, madeAt: Date = new Date()): string {
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
    `<header><h1>Sales report — ${esc(period.title)}</h1><div>${esc(period.dates)} · trading day 5 am to 5 am` +
      `${period.compare ? ` · compared with ${esc(period.compare.label)}` : ''}</div>` +
      `<div class="muted">Printed ${esc(fmtWhen(madeAt.toISOString()))}${period.isCurrent ? ' · the period is still running' : ''}</div></header>`,
  );

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

  parts.push(
    `<section><h2>Order types</h2>${table(
      ['Order type', 'Orders', 'Sales', 'Share'],
      r.channels.map((c) => [esc(CHANNEL_LABEL[c.channel]), String(c.orderCount), money(c.netSalesCents), esc(percentOf(c.netSalesCents, k.netSalesCents))]),
      [1, 2, 3],
    )}</section>`,
  );

  const items = limited(r.items, 15);
  parts.push(
    `<section class="two"><div><h2>Top items</h2>${table(
      ['Item', 'Qty', 'Sales'],
      items.shown.map((i) => [esc(i.name), String(i.quantity), money(i.salesCents)]),
      [1, 2],
    )}${items.note}</div><div><h2>Categories</h2>${table(
      ['Category', 'Qty', 'Sales'],
      r.categories.map((c) => [esc(c.name), String(c.quantity), money(c.salesCents)]),
      [1, 2],
    )}<p class="muted">At menu price, before order discounts.</p></div></section>`,
  );

  parts.push(
    `<section><h2>Staff</h2>${table(
      ['Taken by', 'Orders', 'Sales', 'Discounts given', 'Cancelled'],
      r.staff.map((s) => [esc(s.name), String(s.orderCount), money(s.netSalesCents), money(s.discountCents), String(s.voidCount)]),
      [1, 2, 3, 4],
    )}</section>`,
  );

  if (r.shifts.length > 0) {
    parts.push(
      `<section><h2>Cash drawer (shifts)</h2>${table(
        ['Opened', 'Closed', 'By', 'Float', 'Expected', 'Counted', 'Short / over'],
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
        ]),
        [3, 4, 5, 6],
      )}</section>`,
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
        ['When', 'Order', 'Amount', 'Paid back as', 'Reason', 'Approved by'],
        list.shown.map((x) => [
          esc(fmtWhen(x.refundedAt)),
          esc(x.orderNumber),
          `${money(x.amountCents)}${x.full ? ' (whole order)' : ''}`,
          esc(methodLabel(x.method)),
          esc(x.reason),
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
        ['When', 'Order', 'Value', 'Reason', 'Approved by', 'Taken by'],
        list.shown.map((v) => [
          esc(fmtWhen(v.voidedAt ?? v.createdAt)),
          esc(v.orderNumber),
          money(v.amountCents),
          esc(v.reason),
          esc(v.approvedBy),
          esc(v.takenBy),
        ]),
        [2],
      )}${list.note}</section>`,
    );
  }

  if (r.foodCost.hasUsage) {
    const salesExTax = k.netSalesCents - k.taxCents;
    const ing = limited(r.foodCost.ingredients, 12);
    parts.push(
      `<section><h2>Ingredients and food cost (estimate)</h2><p>Food cost ${money(r.foodCost.usedCents)}` +
        (salesExTax > 0 ? ` — ${esc(percentOf(r.foodCost.usedCents, salesExTax))} of sales before tax` : '') +
        (r.foodCost.wasteCents > 0 ? ` · waste ${money(r.foodCost.wasteCents)}` : '') +
        `. Valued at today's ingredient prices.</p>${table(
          ['Ingredient', 'Used', 'Cost', 'Wasted', 'Waste cost'],
          ing.shown.map((i) => [
            esc(i.name),
            esc(fmtQty(i.usedQty, i.unit)),
            money(i.usedCents),
            i.wastedQty ? esc(fmtQty(i.wastedQty, i.unit)) : '—',
            i.wastedCents ? money(i.wastedCents) : '—',
          ]),
          [1, 2, 3, 4],
        )}${ing.note}</section>`,
    );
  }

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
