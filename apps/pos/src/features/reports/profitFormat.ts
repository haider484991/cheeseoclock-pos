/**
 * How the profit screens say things (costing spec Phase 9, D15: plain words,
 * a few numbers, no jargon on screen): the waterfall's steps, the notes under
 * it, the menu map's advice, What-if's per week and break-even. Pure, so the
 * wording is tested (profitFormat.test.ts).
 */
import { formatCents } from '@cheeseoclock/pos-domain';
import {
  MENU_MAP_WORDS,
  type MenuMapItem,
  type ProfitFees,
  type ProfitStepKey,
  type ReportProfitTab,
  type RiderCostSetting,
} from '@cheeseoclock/shared-types';
import { formatBps } from '../costing/costingFormat';
import { andList } from '../settings/shop-rules/foodpandaWords';

export const PROFIT_STEP_LABEL: Record<ProfitStepKey, string> = {
  sales: 'Sales before tax',
  food_cost: 'Food cost',
  unknown_cost: 'Sales with an unknown cost (left out)',
  waste: 'Waste',
  sent_not_paid: 'Food sent out, not paid',
  stock_loss: 'Stock that went missing',
  // Commission + fee per order + tax on the commission: "foodpanda kept" on Channels' foodpanda block.
  commission: 'foodpanda commission and fees',
  uplift: 'foodpanda price uplift (estimated)',
  payment_fees: 'Card and wallet fees',
  rider: 'Rider cost',
};

/**
 * A step's label with its direction (costing spec D15: say what happened):
 * the stock-loss step is below 0 when stock went missing, and above 0 when
 * more was on the shelves than the till expected — which adds to profit,
 * and says so rather than "+Rs X" under "Stock that went missing".
 */
export function stepLabel(key: ProfitStepKey, cents: number): string {
  if (key === 'stock_loss' && cents > 0) return 'More stock on the shelves than expected';
  return PROFIT_STEP_LABEL[key];
}

/**
 * Under the waterfall when the stock takes found MORE than expected: the
 * usual cause is a delivery that was never recorded as a purchase, and the
 * profit is higher than it should be until it is.
 */
export function stockGainNote(t: Pick<ReportProfitTab, 'stockLoss'>): string | null {
  const cents = t.stockLoss.state === 'counted' ? t.stockLoss.cents : null;
  if (cents === null || cents >= 0) return null;
  return `The stock takes found ${formatCents(-cents)} more on the shelves than the till expected. The usual cause is a delivery that was not recorded as a purchase: until it is, this profit is too high.`;
}

/** "Rs 1,200" with its sign: "+Rs 1,200", "−Rs 400", "Rs 0". */
export function signedRupees(cents: number): string {
  if (cents === 0) return formatCents(0);
  return `${cents > 0 ? '+' : '−'}${formatCents(Math.abs(cents))}`;
}

/** A step as the list shows it: sales and the uplift as they are, the rest taken off. */
export function stepAmount(key: ProfitStepKey, cents: number): string {
  if (key === 'sales') return formatCents(cents);
  return signedRupees(cents);
}

/** "Profit before overheads: Rs 52,300 — 21% of sales." (or the loss, in words). */
export function profitHeadline(t: Pick<ReportProfitTab, 'profitCents' | 'steps'>): string {
  if (t.profitCents < 0) return `Before overheads this period lost ${formatCents(-t.profitCents)}.`;
  const sales = t.steps.find((s) => s.key === 'sales')?.cents ?? 0;
  const share = sales > 0 ? ` — ${formatBps(Math.round((t.profitCents * 10_000) / sales))} of sales` : '';
  return `Profit before overheads: ${formatCents(t.profitCents)}${share}.`;
}

/**
 * The sentence under the unknown-cost bar, or null when every food sale's
 * cost is known. The bar is those sales less what went with them on their
 * orders (their share of foodpanda's commission, delivery charges, the rider
 * and card fees): all of it left out together.
 */
export function unknownCostNote(t: Pick<ReportProfitTab, 'steps' | 'coverageBps' | 'unknownSalesCents'>): string | null {
  const unknown = t.unknownSalesCents;
  if (unknown <= 0) return null;
  const bar = -(t.steps.find((s) => s.key === 'unknown_cost')?.cents ?? 0);
  const withThem = bar !== unknown ? ", with their share of their orders' commission, delivery charges, rider and card fees" : '';
  const known = t.coverageBps === null ? '' : ` Costs are known for ${formatBps(t.coverageBps)} of food sales.`;
  return `${formatCents(unknown)} of sales have an unknown cost (no recipe, or an ingredient with no price): they are left out of the profit${withThem}, never counted as free.${known}`;
}

/** What the commission is taken on, in the owner's words (Settings → foodpanda). */
export const COMMISSION_BASE_WORDS = {
  after_deal: 'the food after your part of the deal, before tax',
  before_deal: 'the food before the deal, before tax',
} as const;

/**
 * foodpanda's terms in force (Settings → foodpanda, the one place they
 * live), in a sentence under Profit and Channels. Orders paid after the
 * commission was confirmed keep the terms they were paid with.
 */
export function commissionText(fees: Pick<ProfitFees, 'foodpanda'>): string {
  const f = fees.foodpanda;
  const extras: string[] = [];
  if (f.fixedFeeCents > 0) extras.push(`${formatCents(f.fixedFeeCents)} an order`);
  if (f.commissionTaxBps > 0) extras.push(`${formatBps(f.commissionTaxBps)} tax on the commission`);
  if (f.paymentFeeBps > 0) extras.push(`${formatBps(f.paymentFeeBps)} of each order's total`);
  const plus = extras.length > 0 ? `, plus ${andList(extras)}` : '';
  const confirmed = f.confirmed ? '' : ' (not confirmed yet)';
  const prices =
    f.upliftBps > 0
      ? ` foodpanda's menu is ${formatBps(f.upliftBps)} above the till's: the difference is its own line, and the commission is on the dearer price.`
      : ' foodpanda orders are at till prices.';
  return `foodpanda commission: ${formatBps(f.commissionBps)}${confirmed} of ${COMMISSION_BASE_WORDS[f.base]}${plus}.${prices} Orders paid with a confirmed commission keep the terms they were paid with; the rest use these (Settings → foodpanda).`;
}

/** After the rider sentence, whatever the setting: a delivery sent out with an outside rider costs what he kept (pos-domain riderCost, 'kept'). */
export const OUTSIDE_RIDER_COST_WORDS = 'An outside rider (Send out) costs what he kept: the delivery charge.';

/** How a delivery's rider cost is worked out, in a sentence, then what an outside rider costs. */
export function riderText(r: RiderCostSetting): string {
  return `${ownRiderText(r)} ${OUTSIDE_RIDER_COST_WORDS}`;
}

function ownRiderText(r: RiderCostSetting): string {
  switch (r.mode) {
    case 'zone_rate':
      return "Rider cost: the rider service's rate for each area (the delivery fee of its zone); with no area, the delivery charge on the bill.";
    case 'fixed':
      return `Rider cost: ${formatCents(r.fixedCents)} a trip.`;
    case 'none':
      return 'Rider cost: none per trip (your own riders on a salary).';
  }
}

/** "Rs 1,200 a week" with a sign, or "No change". */
export function weekText(cents: number): string {
  if (cents === 0) return 'No change a week';
  return `${signedRupees(cents)} a week`;
}

/** A menu price change's break-even volume in words. */
export function breakEvenText(bps: number | null): string {
  if (bps === null) return 'No amount of extra sales makes up for this price';
  if (bps === 0) return 'The same sales earn the same';
  if (bps < 0) return `Sales could fall ${formatBps(-bps)} before this earns less than now`;
  return `Sales must grow ${formatBps(bps)} to earn as much as now`;
}

/**
 * The menu map's advice for one dish, in the owner's words
 * ("Popular, low profit: earns Rs 55 less than your average Pizza; Rs 60
 * more on the price, or Rs 60 less cost, brings it to your average").
 */
export function menuMapAdvice(d: Pick<MenuMapItem, 'class' | 'belowAverageCents' | 'raiseToAverageCents'>, categoryName: string): string {
  const w = MENU_MAP_WORDS[d.class];
  if (d.class === 'plowhorse' && d.raiseToAverageCents !== null && d.raiseToAverageCents > 0) {
    const below = d.belowAverageCents !== null && d.belowAverageCents > 0 ? `earns ${formatCents(d.belowAverageCents)} less than your average ${categoryName.toLowerCase()}; ` : '';
    const y = formatCents(d.raiseToAverageCents);
    return `${w.plain}: ${below}${y} more on the price, or ${y} less cost, brings it to your average.`;
  }
  return `${w.plain}: ${w.advice}`;
}

/** Units a week from tenths: 125 → "12.5 a week". */
export function perWeekUnits(tenths: number): string {
  return `${new Intl.NumberFormat('en-PK', { maximumFractionDigits: 1 }).format(tenths / 10)} a week`;
}
