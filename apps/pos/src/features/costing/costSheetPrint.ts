/**
 * The printed cost sheet for one item (Costing → an item → Print cost
 * sheet): the same figures as the drawer, on one A4 page. Built as escaped
 * HTML and printed like the Reports page (PRINT_CSS, window.print).
 *
 * It never prints a missing price as a Rs 0 cost: an item that can't be
 * costed says why instead of a cost, a profit and a %, an extra with no
 * priced lines prints "—", and a sum with an unpriced part says "at least".
 * What you keep is printed only when the sheet carries it (profit.view, the
 * owner's: the main process leaves it out for anyone else).
 */
import { formatCents } from '@cheeseoclock/pos-domain';
import type { BatchCalc, CostLineView, ItemCostSheet, MenuCostRow } from '@cheeseoclock/shared-types';
import { escapeHtml } from '../reports/exporters';
import {
  FLAG_LABEL,
  atLeast,
  cantCostReason,
  formatBps,
  formatHundredths,
  formatQtyUnit,
  formatUnitPrice,
  hasMissing,
  leaveOutText,
  madeOfNote,
  priceKindNote,
} from './costingFormat';

const esc = escapeHtml;
const money = (c: number) => esc(formatCents(c));

function madeOfRows(line: { costCents: number; priceKind: CostLineView['priceKind'] }, calc: BatchCalc, depth: number): string {
  const note = madeOfNote(line, calc);
  const noteRow = note ? `<tr class="muted"><td colspan="5" style="padding-left:${8 + depth * 10}px">${esc(note)}</td></tr>` : '';
  return (
    noteRow +
    calc.lines
      .map((l) => {
        const pad = `padding-left:${8 + depth * 10}px`;
        const own = `<tr class="muted"><td style="${pad}">${esc(l.name)}</td><td class="r">${esc(formatHundredths(l.scaledHundredths, l.unit))}</td><td class="r">${esc(formatUnitPrice(l.unitCostMc, l.unit))}</td><td class="r">${money(l.costCents)}</td><td></td></tr>`;
        return own + (l.madeOf ? madeOfRows(l, l.madeOf, depth + 1) : '');
      })
      .join('')
  );
}

function lineRows(lines: CostLineView[]): string {
  if (lines.length === 0) return '<tr><td colspan="5" class="muted">Nothing.</td></tr>';
  return lines
    .map((l) => {
      const note = priceKindNote(l.priceKind);
      return (
        `<tr><td>${esc(l.name)}${note ? ` <span class="muted">(${esc(note)})</span>` : ''}</td>` +
        `<td class="r">${esc(formatQtyUnit(l.qty, l.unit))}</td>` +
        `<td class="r">${esc(formatUnitPrice(l.unitCostMc, l.unit))}</td>` +
        `<td class="r">${money(l.costCents)}</td>` +
        `<td class="r">${l.shareBps === null ? '' : esc(formatBps(l.shareBps))}</td></tr>` +
        (l.madeOf ? madeOfRows(l, l.madeOf, 1) : '')
      );
    })
    .join('');
}

const HEAD = (share: string) =>
  `<thead><tr><th>Ingredient</th><th class="r">Amount</th><th class="r">Price</th><th class="r">Cost</th><th class="r">${esc(share)}</th></tr></thead>`;

/**
 * The headline: what it costs (and, for profit.view, what you keep), or —
 * when it can't be costed — why, with no figures that would read as Rs 0.
 */
function headline(r: MenuCostRow): string {
  if (r.flag === 'grey') {
    return `${esc(r.categoryName)} · can't be costed yet: ${esc(cantCostReason(r))}. Price ${money(r.priceCents)}.`;
  }
  const keep = r.profitCents === null ? `, price ${money(r.priceCents)}` : `, you keep ${money(r.profitCents)} per sale at ${money(r.priceCents)}`;
  return (
    `${esc(r.categoryName)} · costs ${money(r.costCents)} to make${keep}` +
    ` · food cost ${esc(formatBps(r.foodCostBps))} (target ${esc(formatBps(r.targetBps))}${r.targetConfirmed ? '' : ', suggested'}) · ${esc(FLAG_LABEL[r.flag])}`
  );
}

export function costSheetPrintHtml(sheet: ItemCostSheet, printedAt: Date = new Date()): string {
  const r = sheet.row;
  const parts: string[] = [];
  parts.push(
    `<header><h1>Cost sheet — ${esc(r.name)}</h1>` +
      `<div>${headline(r)}</div>` +
      `<div class="muted">At today's prices on this till, menu price before tax. Sold in the last 28 days: ${r.soldLast28}. Printed ${esc(printedAt.toLocaleString('en-PK'))}.</div></header>`,
  );
  parts.push(
    `<section><h2>Always in it — ${esc(atLeast(sheet.alwaysCostCents, hasMissing(sheet.always)))}</h2><table>${HEAD('Of the plate')}<tbody>${lineRows(sheet.always)}</tbody></table></section>`,
  );
  for (const g of sheet.groups) {
    const partial = g.options.some((o) => o.missingLines > 0);
    const basis =
      g.basis === 'observed' ? 'weighted by what customers picked in the last 28 days' : `not enough sales yet: ${g.kMax} × the average option`;
    parts.push(
      `<section><h2>${esc(g.name)} — usually ${esc(atLeast(g.typicalCostCents, partial))}</h2>` +
        `<p class="muted">Picks ${g.kMin === g.kMax ? g.kMin : `${g.kMin} to ${g.kMax}`}; ${esc(basis)}. Cheapest ${esc(atLeast(g.cheapestCostCents, partial))}, dearest ${esc(atLeast(g.dearestCostCents, partial))}.</p>` +
        `<table><thead><tr><th>Option</th><th class="r">Extra price</th><th class="r">Cost</th><th class="r">Picked</th></tr></thead><tbody>` +
        g.options
          .map(
            (o) =>
              `<tr><td>${esc(o.name)}${o.missingLines ? ' <span class="muted">(no price yet)</span>' : ''}</td><td class="r">${o.priceDeltaCents ? money(o.priceDeltaCents) : ''}</td>` +
              `<td class="r">${esc(atLeast(o.costCents, o.missingLines > 0))}</td><td class="r">${o.pickedShareBps === null ? '' : esc(formatBps(o.pickedShareBps))}</td></tr>`,
          )
          .join('') +
        `</tbody></table></section>`,
    );
  }
  if (sheet.paidExtras.length > 0) {
    // "You keep" only when the sheet carries it (profit.view).
    const withKeep = sheet.paidExtras.some((x) => x.marginCents !== null);
    parts.push(
      `<section><h2>Paid extras</h2><table><thead><tr><th>Extra</th><th class="r">Price</th><th class="r">Cost</th>${withKeep ? '<th class="r">You keep</th>' : ''}<th class="r">Food cost</th></tr></thead><tbody>` +
        sheet.paidExtras
          .map((x) => {
            // An extra with no priced lines (or none at all) is not a Rs 0 cost: it is not known.
            const unknown = x.flag === 'grey';
            const why = unknown ? ` <span class="muted">(${x.lines.length === 0 ? 'no recipe lines' : 'no price yet'})</span>` : '';
            return (
              `<tr><td>${esc(x.name)}${why}</td><td class="r">${money(x.priceDeltaCents)}</td>` +
              `<td class="r">${unknown ? '—' : money(x.costCents)}</td>` +
              (withKeep ? `<td class="r">${unknown || x.marginCents === null ? '—' : money(x.marginCents)}</td>` : '') +
              `<td class="r">${unknown ? '—' : esc(formatBps(x.foodCostBps))}</td></tr>`
            );
          })
          .join('') +
        `</tbody></table></section>`,
    );
  }
  if (sheet.leaveOuts.length > 0) {
    parts.push(
      `<section><h2>Leave-outs</h2><table><tbody>` +
        sheet.leaveOuts.map((l) => `<tr><td>${esc(l.name)}</td><td class="r">${esc(leaveOutText(l))}</td></tr>`).join('') +
        `</tbody></table></section>`,
    );
  }
  return parts.join('');
}
