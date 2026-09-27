/**
 * Costing → What-if's words and its "price change list" (costing spec 4.9,
 * Phase 9): pure, so they are tested (whatIfFormat.test.ts). The list is a
 * HANDOFF — the prices tried, for whoever keeps the costing sheet, the
 * printed menu and the website (menu changes go everywhere); nothing on the
 * till changes.
 */
import { formatCents } from '@cheeseoclock/pos-domain';
import type { WhatIfResult, WhatIfRow } from '@cheeseoclock/shared-types';
import { escapeHtml, toCsv, type CsvCell } from '../reports/exporters';
import { fmtWhen } from '../reports/reportFormat';
import { breakEvenText, weekText } from '../reports/profitFormat';
import { formatBps, formatUnitPrice } from './costingFormat';

/** The dishes whose menu price was changed in the what-if, most per week first. */
export function priceChangeRows(result: Pick<WhatIfResult, 'rows'>): WhatIfRow[] {
  return result.rows
    .filter((r) => r.newBasePriceCents !== r.basePriceCents)
    .sort((a, b) => Math.abs(b.weekCents) - Math.abs(a.weekCents) || a.name.localeCompare(b.name));
}

/**
 * The dishes whose cost to make moves with the ingredient prices tried and
 * whose menu price was NOT tried: most per week first. With a new cheese
 * price alone, these are what the list is for.
 */
export function costMoveRows(result: Pick<WhatIfResult, 'rows'>): WhatIfRow[] {
  return result.rows
    .filter((r) => r.newCostCents !== r.costCents && r.newBasePriceCents === r.basePriceCents)
    .sort((a, b) => Math.abs(b.weekCents) - Math.abs(a.weekCents) || a.name.localeCompare(b.name));
}

/** Is there anything to hand over: a menu price tried, or an ingredient price (with what it moves)? */
export function priceChangeListReady(result: Pick<WhatIfResult, 'rows' | 'ingredients'>): boolean {
  return priceChangeRows(result).length > 0 || result.ingredients.length > 0;
}

/**
 * "Fix all reds": every dish over its target (red) at the costs tried gets
 * the price that brings it to its target, in the owner's price steps. Only
 * raises: a dish is never made cheaper here.
 */
export function fixAllReds(rows: readonly WhatIfRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r.newFlag !== 'red' || r.priceToHitCents === null) continue;
    if (r.priceToHitCents > r.newBasePriceCents) out[r.menuItemId] = r.priceToHitCents;
  }
  return out;
}

const change = (from: number, to: number) => `${to >= from ? '+' : '−'}${formatCents(Math.abs(to - from))}`;

/** The price change list as a spreadsheet (a handoff: nothing on the till changes). */
export function buildPriceChangeCsv(result: WhatIfResult, madeAt: Date = new Date()): string {
  const rs = (cents: number) => ({ cents });
  const rows: CsvCell[][] = [
    ['Price change list — prices tried on Costing → What-if'],
    ['Made', fmtWhen(madeAt.toISOString())],
    ['Nothing on the till has changed. Change these in the costing sheet, the printed menu and the website.'],
    [],
    ['Dish', 'Category', 'Price now Rs', 'New price Rs', 'Change Rs', 'Food cost now', 'Food cost after', 'Per week at the same sales Rs', 'Break-even'],
    ...priceChangeRows(result).map((r) => [
      r.name,
      r.categoryName,
      rs(r.basePriceCents),
      rs(r.newBasePriceCents),
      rs(r.newBasePriceCents - r.basePriceCents),
      r.foodCostBps === null ? null : formatBps(r.foodCostBps),
      r.newFoodCostBps === null ? null : formatBps(r.newFoodCostBps),
      rs(r.weekCents),
      breakEvenText(r.breakEvenBps),
    ]),
  ];
  const moves = costMoveRows(result);
  if (moves.length > 0) {
    rows.push([], ['Dishes whose cost moves (menu price not changed)', 'Category', 'Cost to make now Rs', 'Cost to make after Rs', 'Food cost now', 'Food cost after', 'Per week at the same sales Rs']);
    for (const r of moves) {
      rows.push([
        r.name,
        r.categoryName,
        rs(r.costCents),
        rs(r.newCostCents),
        r.foodCostBps === null ? null : formatBps(r.foodCostBps),
        r.newFoodCostBps === null ? null : formatBps(r.newFoodCostBps),
        rs(r.weekCents),
      ]);
    }
  }
  if (result.ingredients.length > 0) {
    rows.push([], ['Ingredient prices this assumes', 'Unit', 'Now', 'Tried', 'Made here']);
    for (const i of result.ingredients) {
      rows.push([
        i.name,
        i.unit,
        i.beforeUnitCostMc === null ? 'no price' : formatUnitPrice(i.beforeUnitCostMc, i.unit),
        i.afterUnitCostMc === null ? 'no price' : formatUnitPrice(i.afterUnitCostMc, i.unit),
        i.batch ? 'Yes (moves with what it is made from)' : null,
      ]);
    }
  }
  rows.push([], ['All dishes together, per week at the same sales', { cents: result.totalWeekCents }]);
  return toCsv(rows);
}

/** The price change list on paper (escaped HTML for the print sheet). */
export function buildPriceChangePrint(result: WhatIfResult, madeAt: Date = new Date()): string {
  const esc = escapeHtml;
  const list = priceChangeRows(result);
  const dishes =
    list.length === 0
      ? '<p class="muted">No menu price was changed in this what-if.</p>'
      : `<table><thead><tr><th>Dish</th><th class="r">Now</th><th class="r">New</th><th class="r">Change</th><th class="r">Food cost</th><th class="r">Per week</th></tr></thead><tbody>${list
          .map(
            (r) =>
              `<tr><td>${esc(r.name)} <span class="muted">${esc(r.categoryName)}</span></td><td class="r">${esc(formatCents(r.basePriceCents))}</td><td class="r"><b>${esc(
                formatCents(r.newBasePriceCents),
              )}</b></td><td class="r">${esc(change(r.basePriceCents, r.newBasePriceCents))}</td><td class="r">${esc(formatBps(r.foodCostBps))} → ${esc(
                formatBps(r.newFoodCostBps),
              )}</td><td class="r">${esc(weekText(r.weekCents))}</td></tr>`,
          )
          .join('')}</tbody></table>`;
  const moves = costMoveRows(result);
  const moved =
    moves.length === 0
      ? ''
      : `<h2>Dishes whose cost moves</h2><table><thead><tr><th>Dish</th><th class="r">Cost to make</th><th class="r">Food cost</th><th class="r">Per week</th></tr></thead><tbody>${moves
          .map(
            (r) =>
              `<tr><td>${esc(r.name)} <span class="muted">${esc(r.categoryName)}</span></td><td class="r">${esc(formatCents(r.costCents))} → <b>${esc(
                formatCents(r.newCostCents),
              )}</b></td><td class="r">${esc(formatBps(r.foodCostBps))} → ${esc(formatBps(r.newFoodCostBps))}</td><td class="r">${esc(weekText(r.weekCents))}</td></tr>`,
          )
          .join('')}</tbody></table><p class="muted">The menu price stays; what one sale earns moves by the cost.</p>`;
  const ingredients =
    result.ingredients.length === 0
      ? ''
      : `<h2>Ingredient prices this assumes</h2><table><thead><tr><th>Ingredient</th><th class="r">Now</th><th class="r">Tried</th></tr></thead><tbody>${result.ingredients
          .map(
            (i) =>
              `<tr><td>${esc(i.name)}${i.batch ? ' <span class="muted">(made here)</span>' : ''}</td><td class="r">${esc(
                i.beforeUnitCostMc === null ? 'no price' : formatUnitPrice(i.beforeUnitCostMc, i.unit),
              )}</td><td class="r">${esc(i.afterUnitCostMc === null ? 'no price' : formatUnitPrice(i.afterUnitCostMc, i.unit))}</td></tr>`,
          )
          .join('')}</tbody></table>`;
  return (
    `<header><h1>Price change list</h1><div>Prices tried on Costing → What-if. <b>Nothing on the till has changed</b>: change these in the costing sheet, the printed menu and the website.</div>` +
    `<div class="muted">Printed ${esc(fmtWhen(madeAt.toISOString()))} · menu prices before tax · per week at the last 4 weeks' sales</div></header>` +
    `<section><h2>Menu prices</h2>${dishes}</section>` +
    (ingredients ? `<section>${ingredients}</section>` : '') +
    (moved ? `<section>${moved}</section>` : '') +
    `<p>All dishes together: <b>${esc(weekText(result.totalWeekCents))}</b> at the same sales.</p>`
  );
}
