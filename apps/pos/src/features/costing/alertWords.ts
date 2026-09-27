/**
 * How Costing → Alerts says things (costing spec Phase 6, D15: plain words,
 * few numbers): which ingredient moved, which dishes it moved and what that
 * costs per week at this till's sales. Pure, so the wording is tested; the
 * Dashboard's "Do this" list (Phase 7) can say an alert the same way.
 */
import { formatCents } from '@cheeseoclock/pos-domain';
import type { CostAlert, CostAlertItemMove, CostAlertPrice, FoodCostFlag, PriceJumpAlert } from '@cheeseoclock/shared-types';
import { formatBps, formatUnitPrice } from './costingFormat';

/** "Rs 1,500 / kg", "free", "no price". */
export function alertPriceText(p: CostAlertPrice | null, unit: string): string {
  if (!p || p.priceKind === 'unset') return 'no price';
  if (p.priceKind === 'free') return 'free';
  return formatUnitPrice(p.unitCostMc, unit);
}

/** "went up 18%", "went down 12.5%", "moved" (nothing to compare with). */
export function changeText(changeBps: number | null): string {
  if (changeBps === null) return 'changed price';
  if (changeBps === 0) return 'kept its price';
  return changeBps > 0 ? `went up ${formatBps(changeBps)}` : `went down ${formatBps(-changeBps)}`;
}

/** What a week of it comes to: "about Rs 2,340 a week more", "about Rs 820 a week less"; null when nothing. */
export function impactText(cents: number): string | null {
  if (cents === 0) return null;
  return cents > 0 ? `about ${formatCents(cents)} a week more` : `about ${formatCents(-cents)} a week less`;
}

const BAND_WORD: Partial<Record<FoodCostFlag, string>> = {
  green: 'on target',
  amber: 'close to its target',
  red: 'over its target',
};

/** "over its target", "close to its target", "on target". */
export function bandWord(flag: FoodCostFlag | undefined): string {
  return (flag && BAND_WORD[flag]) ?? 'not coloured';
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A week's units from the last 28 days': "about 12 a week", or that it hardly sells. */
function perWeekText(soldLast28: number): string {
  if (soldLast28 <= 0) return 'not sold in the last 4 weeks';
  if (soldLast28 < 4) return 'sold now and then';
  return `about ${Math.round(soldLast28 / 4)} a week`;
}

/**
 * One dish a price change moved: "Fajita Pizza — Large: Rs 612 → Rs 650 to
 * make (food cost 30.6% → 32.5%), about 12 a week: about Rs 456 a week more".
 */
export function moveText(m: CostAlertItemMove): string {
  const cost = `${formatCents(m.costBeforeCents)} → ${formatCents(m.costAfterCents)} to make`;
  const fc =
    m.foodCostBeforeBps !== null && m.foodCostAfterBps !== null ? ` (food cost ${formatBps(m.foodCostBeforeBps)} → ${formatBps(m.foodCostAfterBps)})` : '';
  const band = m.flagAfter ? `, now ${bandWord(m.flagAfter)}${m.targetBps !== undefined ? ` of ${formatBps(m.targetBps)}` : ''}` : '';
  const week = impactText(m.impactWeekCents);
  return `${m.name}: ${cost}${fc}${band}, ${perWeekText(m.soldLast28)}${week ? `: ${week}` : ''}`;
}

/** The alert's one bold line. */
export function alertHeadline(a: CostAlert): string {
  const d = a.detail;
  if (!d) return 'An alert from a newer version of the till';
  switch (d.kind) {
    case 'price_jump':
      return `${d.ingredientName} ${changeText(d.changeBps)}: ${alertPriceText(d.before, d.unit)} → ${alertPriceText(d.after, d.unit)}`;
    case 'batch_unpriced_input':
      return `${d.ingredientName} kept its old price`;
    case 'weekly_digest':
      return `This week's prices moved ${plural(d.changes.length, 'dish', 'dishes')} across their target`;
  }
}

/**
 * Which way a price change moved its dishes: by what it costs a week, or —
 * when that is Rs 0 (the dishes did not sell here in 4 weeks) — by the dishes'
 * own costs, then by the price itself. Never "more" for a price that fell.
 */
function dishesDirection(impactWeekCents: number, d: PriceJumpAlert): 'more' | 'less' | 'a different amount' {
  const sign =
    Math.sign(impactWeekCents) ||
    Math.sign(d.items.reduce((s, m) => s + (m.costAfterCents - m.costBeforeCents), 0)) ||
    Math.sign(d.changeBps ?? 0);
  return sign > 0 ? 'more' : sign < 0 ? 'less' : 'a different amount';
}

const SOURCE_WORD: Record<string, string> = {
  delivery: 'from a delivery bill',
  purchase: 'from a purchase',
  manual: 'typed on the till',
  import: 'from the costing sheet',
};

/** The sentence under it: what it did to the menu and what that costs a week. */
export function alertSummary(a: CostAlert): string {
  const d = a.detail;
  if (!d) return 'Update this till to read it.';
  const week = impactText(a.impactWeekCents);
  switch (d.kind) {
    case 'price_jump': {
      const from = SOURCE_WORD[d.source] ? ` (${SOURCE_WORD[d.source]})` : '';
      const key = d.key ? 'A key ingredient' : 'The new price';
      const dishes =
        d.itemsMoved === 0
          ? 'No dish on the menu uses it.'
          : `${plural(d.itemsMoved, 'dish', 'dishes')} ${d.itemsMoved === 1 ? 'costs' : 'cost'} ${dishesDirection(a.impactWeekCents, d)} to make${week ? `: ${week} at this till's sales` : ''}.`;
      const batches = d.keyBatches.map((b) => ` ${b.name} ${changeText(b.changeBps)} with it.`).join('');
      return `${key}${from}. ${dishes}${batches}`;
    }
    case 'batch_unpriced_input': {
      const names = d.unpricedInputs.map((i) => i.name).join(', ');
      const why = d.because === 'import' ? 'After the menu file, it' : d.changedName ? `${d.changedName} changed, but it` : 'It';
      const kept = d.kept ? `, so it still costs ${alertPriceText(d.kept, d.unit)}` : ', so it has no price';
      return `${why} can't be priced from its batch recipe: ${names} ${d.unpricedInputs.length === 1 ? 'has' : 'have'} no price${kept}. Give ${d.unpricedInputs.length === 1 ? 'it' : 'them'} a price and it follows its recipe again.`;
    }
    case 'weekly_digest':
      return `Worked out at the same customer picks as last week, so only price changes count${week ? `: ${week} at this till's sales` : ''}.`;
  }
}

/** The dishes to list under "Show dishes" (the digest's and a price jump's). */
export function alertMoves(a: CostAlert): CostAlertItemMove[] {
  const d = a.detail;
  if (!d) return [];
  if (d.kind === 'price_jump') return d.items;
  if (d.kind === 'weekly_digest') return d.changes;
  return [];
}
