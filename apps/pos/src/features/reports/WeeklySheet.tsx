/**
 * The weekly owner sheet (costing spec §5, Phase 7): one A4 page, printed
 * from Reports → Overview → "Print this week" (or last week, in full):
 *  - the five numbers against last week — sales, orders, the average order,
 *    and (only for a login that may see costs) food cost and waste, each
 *    with last week's figure beside it;
 *  - the top five "Do this", each with its rupees a week;
 *  - for a login that may see costs: the three dishes that earn the most per
 *    sale and the three that earn the least (ranked; what one sale earns in
 *    rupees only for profit.view), and waste by reason.
 * Phase 8 adds the last stock-take variance (what went that sales, batches
 * and logged waste don't explain, between the latest two stock takes);
 * Phase 9 profit before overheads, for profit.view only (never on the
 * Dashboard card).
 *
 * The builder is pure (tested): every value escaped, every figure as the
 * main process sent it — which, for a login without costs, has no cost lines
 * at all; `canSeeCosts` leaves them out here too.
 */
import { Printer } from 'lucide-react';
import { Button } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import type { OwnerWeek, OwnerWeekItem, OwnerWeekWhich } from '@cheeseoclock/shared-types';
import { escapeHtml } from './exporters';
import { WASTE_REASON_LABEL, coverageText, fmtWhen } from './reportFormat';
import { doThisWords, trendChangeOf, weekDates } from './ownerWeekFormat';
import { formatBps } from '../costing/costingFormat';
import { fmtMoment } from './dateRange';
import { VARIANCE_BAND_LABEL, varianceTotalText } from './varianceFormat';

const esc = escapeHtml;
const money = (c: number) => esc(formatCents(c));
const signed = (c: number) => `${c < 0 ? '−' : ''}${money(Math.abs(c))}`;

/** The sheet's HTML (for the Reports page's print sheet). */
export function buildWeeklySheet(week: OwnerWeek, opts: { canSeeCosts: boolean; canSeeProfit?: boolean; madeAt?: Date }): string {
  const madeAt = opts.madeAt ?? new Date();
  const costs = opts.canSeeCosts ? week.costs : null;
  const sheet = opts.canSeeCosts ? week.sheet : null;
  // Rupee profit is profit.view's (costing spec Phase 9): the main process sends it only then.
  const profit = opts.canSeeProfit && sheet ? sheet.profit : null;
  const withProfit = opts.canSeeProfit === true && sheet !== null;
  const lines = (opts.canSeeCosts ? week.doThis : week.doThis.filter((i) => !i.cost)).slice(0, 5);
  const p = week.previous;
  const vs = (change: OwnerWeek['change']['sales'], was: string | null) => {
    const c = trendChangeOf(change);
    return `<small>${esc(c.text)}${was ? `, was ${was}` : ''}</small>`;
  };
  const kpi = (label: string, value: string, sub: string) => `<div class="kpi"><span>${esc(label)}</span><b>${value}</b>${sub}</div>`;
  const parts: string[] = [];

  parts.push(
    `<header><h1>${week.isCurrent ? 'This week' : 'Last week'}: ${esc(weekDates(week.firstDay, week.lastDay))}</h1>` +
      `<div>${week.isCurrent ? 'So far, compared with last week by the same time.' : 'The whole week, compared with the week before.'} This till's orders; the trading day runs 5 am to 5 am.</div>` +
      `<div class="muted">Printed ${esc(fmtWhen(madeAt.toISOString()))}</div></header>`,
  );

  const tiles = [
    kpi('Sales', money(week.current.netSalesCents), vs(week.change.sales, p ? money(p.netSalesCents) : null)),
    kpi('Orders', esc(String(week.current.orderCount)), vs(week.change.orders, p ? esc(String(p.orderCount)) : null)),
    kpi('Average order', money(week.current.avgOrderCents), vs(week.change.avgOrder, p ? money(p.avgOrderCents) : null)),
  ];
  if (costs) {
    // Last week's food cost and waste, over the same stretch the sales are compared with.
    const before = sheet?.previousCosts ?? null;
    const wasFood = before?.foodCostBps != null ? `, was ${esc(formatBps(before.foodCostBps))}` : '';
    const wasWaste = before ? `, was ${money(before.wasteCents)}` : '';
    tiles.push(
      kpi(
        'Food cost',
        costs.foodCostBps === null ? '—' : esc(formatBps(costs.foodCostBps)),
        `<small>${esc(costs.coverageBps === null ? 'No food sold' : coverageText({ coverageBps: costs.coverageBps }))}${wasFood}</small>`,
      ),
      kpi('Waste', money(costs.wasteCents), `<small>thrown away, at cost${wasWaste}</small>`),
    );
  }
  if (profit) {
    const was = profit.previousProfitCents !== null ? `, was ${signed(profit.previousProfitCents)}` : '';
    const unknown = profit.unknownSalesCents > 0 ? `; ${money(profit.unknownSalesCents)} of sales with an unknown cost left out` : '';
    tiles.push(kpi('Profit before overheads', signed(profit.profitCents), `<small>before rent, salaries and bills${unknown}${was}</small>`));
  }
  parts.push(`<section><div class="kpis">${tiles.join('')}</div></section>`);

  parts.push(
    `<section><h2>Do this</h2>${
      lines.length === 0
        ? '<p class="muted">Nothing needs you right now.</p>'
        : `<ol>${lines
            .map((i) => {
              const w = doThisWords(i);
              return `<li><b>${esc(w.title)}</b>${w.amount ? ` — ${esc(w.amount.text)}` : ''}<br><span class="muted">${esc(w.detail)}</span></li>`;
            })
            .join('')}</ol>`
    }</section>`,
  );

  if (sheet) {
    const dishRows = (list: readonly OwnerWeekItem[]) =>
      list.length === 0
        ? '<p class="muted">No dish with a known cost sold yet.</p>'
        : `<table><thead><tr><th>Dish</th><th class="r">Sold</th><th class="r">Food cost</th>${withProfit ? '<th class="r">Earns a sale</th>' : ''}</tr></thead><tbody>${list
            .map(
              (d) =>
                `<tr><td>${esc(d.name)}</td><td class="r">${d.soldThisWeek}</td><td class="r">${esc(formatBps(d.foodCostBps))}</td>${
                  withProfit ? `<td class="r">${d.profitPerSaleCents === null ? '—' : money(d.profitPerSaleCents)}</td>` : ''
                }</tr>`,
            )
            .join('')}</tbody></table>`;
    parts.push(
      `<section class="two"><div><h2>Earn the most per sale</h2>${dishRows(sheet.earnsMost)}</div>` +
        `<div><h2>Earn the least per sale</h2>${dishRows(sheet.earnsLeast)}</div></section>` +
        `<p class="muted">Of the dishes sold this week whose cost is fully known, at menu price and today's costs (Costing → Menu costs).</p>`,
    );
    const st = sheet.lastStockTake;
    const between = st ? `Between the stock takes of ${esc(fmtMoment(st.sinceIso))} and ${esc(fmtMoment(st.untilIso))}.` : '';
    let stockTake: string;
    if (!st) {
      stockTake = '<p class="muted">Needs two finished stock takes of the key items (or full ones) on different days (Inventory → Stock takes).</p>';
    } else if (st.compared === 0) {
      // Nothing counted on both: no figure and no rating (never a clean "Good").
      stockTake =
        '<p><b>Nothing was counted on both stock takes, so nothing could be compared.</b></p>' +
        `<p class="muted">${between} Count the same items each time (the key items) to see what went.</p>`;
    } else {
      stockTake =
        `<p><b>${esc(varianceTotalText(st.totalCents, st.varianceBps))}</b>${st.band ? ` Rating: ${esc(VARIANCE_BAND_LABEL[st.band])}.` : ''}${
          st.topIngredient && st.totalCents > 0 ? ` Most of it: ${esc(st.topIngredient)}.` : ''
        }</p>` + `<p class="muted">${between} Every till's stock.</p>`;
    }
    parts.push(`<section><h2>Last stock take: used vs should have used</h2>${stockTake}</section>`);
    const waste = sheet.wasteByReason;
    parts.push(
      `<section><h2>Waste by reason</h2>${
        waste.length === 0
          ? '<p class="muted">Nothing thrown away.</p>'
          : `<table><thead><tr><th>Reason</th><th class="r">Times</th><th class="r">Cost</th></tr></thead><tbody>${waste
              .map((x) => `<tr><td>${esc(WASTE_REASON_LABEL[x.reason])}</td><td class="r">${x.times}</td><td class="r">${money(x.cents)}</td></tr>`)
              .join('')}</tbody></table>`
      }</section>`,
    );
  }
  return parts.join('');
}

/** "Print this week" / "Print last week" on Reports → Overview. */
export function WeeklySheetButtons({ onPrint, busy }: { onPrint: (week: OwnerWeekWhich) => void; busy: boolean }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" disabled={busy} onClick={() => onPrint('this')}>
        <Printer className="h-4 w-4" />
        Print this week
      </Button>
      <Button variant="ghost" disabled={busy} onClick={() => onPrint('last')}>
        Print last week
      </Button>
    </div>
  );
}
