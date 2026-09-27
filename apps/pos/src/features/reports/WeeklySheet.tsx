/**
 * The weekly owner sheet (costing spec §5, Phase 7): one A4 page, printed
 * from Reports → Overview → "Print this week" (or last week, in full):
 *  - the five numbers against last week — sales, orders, the average order,
 *    and (only for a login that may see costs) food cost and waste, each
 *    with last week's figure beside it;
 *  - the top five "Do this", each with its rupees a week;
 *  - for a login that may see costs: the three dishes that earn the most per
 *    sale and the three that earn the least (ranked, with no rupee profit on
 *    the page: that is profit.view's, Phase 9), and waste by reason.
 * Phase 8 adds the last stock-take variance, Phase 9 profit before
 * overheads.
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

const esc = escapeHtml;
const money = (c: number) => esc(formatCents(c));

/** The sheet's HTML (for the Reports page's print sheet). */
export function buildWeeklySheet(week: OwnerWeek, opts: { canSeeCosts: boolean; madeAt?: Date }): string {
  const madeAt = opts.madeAt ?? new Date();
  const costs = opts.canSeeCosts ? week.costs : null;
  const sheet = opts.canSeeCosts ? week.sheet : null;
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
        : `<table><thead><tr><th>Dish</th><th class="r">Sold</th><th class="r">Food cost</th></tr></thead><tbody>${list
            .map((d) => `<tr><td>${esc(d.name)}</td><td class="r">${d.soldThisWeek}</td><td class="r">${esc(formatBps(d.foodCostBps))}</td></tr>`)
            .join('')}</tbody></table>`;
    parts.push(
      `<section class="two"><div><h2>Earn the most per sale</h2>${dishRows(sheet.earnsMost)}</div>` +
        `<div><h2>Earn the least per sale</h2>${dishRows(sheet.earnsLeast)}</div></section>` +
        `<p class="muted">Of the dishes sold this week whose cost is fully known, at menu price and today's costs (Costing → Menu costs).</p>`,
    );
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
