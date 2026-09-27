/**
 * The words on the foodpanda cards (Settings → foodpanda), built from the
 * owner's own values: no sentence repeats a number by hand, so the example
 * can never disagree with what he typed.
 */
import { foodpandaExample, formatCents } from '@cheeseoclock/pos-domain';
import type { FoodpandaChecks, FoodpandaDeal, FoodpandaFees } from '@cheeseoclock/shared-types';

/** 2500 → "25%", 2250 → "22.5%", 1625 → "16.25%". */
export function percentFromBps(bps: number): string {
  const whole = bps / 100;
  return `${Number.isInteger(whole) ? whole : Number(whole.toFixed(2))}%`;
}

/** "25" / "22.5" as typed → basis points; null when it is not a number with at most two decimals. */
export function bpsFromPercentText(text: string): number | null {
  const t = text.trim().replace(/%$/, '').trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

/** Whole rupees as typed ("1,500" / "1500") → paisa; '' → null; anything else → NaN. */
export function centsFromRupeesText(text: string): number | null {
  const t = text.trim().replace(/,/g, '');
  if (t === '') return null;
  return /^\d{1,7}$/.test(t) ? Number(t) * 100 : Number.NaN;
}

/** Who pays for the deal, as the card asks it. */
export type DealPayer = 'shop' | 'foodpanda' | 'shared';

export function dealPayer(deal: Pick<FoodpandaDeal, 'percent' | 'shopPercent'>): DealPayer {
  if (deal.shopPercent >= deal.percent) return 'shop';
  if (deal.shopPercent <= 0) return 'foodpanda';
  return 'shared';
}

/** "1 Oct 2026" */
function day(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** One line for History and the header: "20% off, you pay 10% · orders from Rs 1,000 · at most Rs 300 off". */
export function dealSummary(deal: FoodpandaDeal): string {
  if (!(deal.percent > 0)) return 'No deal: foodpanda orders at full till price';
  const payer = dealPayer(deal);
  const parts = [
    `${deal.percent}% off, ${payer === 'shop' ? 'you pay all of it' : payer === 'foodpanda' ? 'foodpanda pays it' : `you pay ${deal.shopPercent}%`}`,
  ];
  if (deal.minOrderCents !== null) parts.push(`orders from ${formatCents(deal.minOrderCents)}`);
  if (deal.maxOffCents !== null) parts.push(`at most ${formatCents(deal.maxOffCents)} off`);
  if (deal.startsOn && deal.endsOn) parts.push(`${day(deal.startsOn)} to ${day(deal.endsOn)}`);
  else if (deal.startsOn) parts.push(`from ${day(deal.startsOn)}`);
  else if (deal.endsOn) parts.push(`until ${day(deal.endsOn)}`);
  return parts.join(' · ');
}

export function feesSummary(fees: FoodpandaFees): string {
  const parts = [
    `${percentFromBps(fees.commissionBps)} ${fees.base === 'after_deal' ? 'after the deal' : 'before the deal'}${fees.confirmed ? '' : ' (suggested)'}`,
  ];
  if (fees.fixedFeeCents > 0) parts.push(`${formatCents(fees.fixedFeeCents)} an order`);
  if (fees.commissionTaxBps > 0) parts.push(`${percentFromBps(fees.commissionTaxBps)} tax on it`);
  return parts.join(' · ');
}

export function checksSummary(checks: FoodpandaChecks): string {
  return `Order number ${checks.orderCode} · tablet total ${checks.tabletTotal}`;
}

/**
 * The worked example under the card, e.g. "A Rs 2,000 foodpanda order with
 * 20% off that you pay: the bill shows Rs 1,600 + tax; foodpanda keeps 25%
 * of Rs 1,600 = Rs 400; you keep Rs 1,200 before food cost." The order is
 * Rs 2,000, or the deal's minimum when that is more.
 */
export function workedExample(deal: FoodpandaDeal, fees: FoodpandaFees): string {
  const orderCents = Math.max(200_000, deal.minOrderCents ?? 0);
  const x = foodpandaExample(deal, fees, orderCents);
  const order = `A ${formatCents(x.orderCents)} foodpanda order`;
  let lead: string;
  let bill = `the bill shows ${formatCents(x.billCents)} + tax`;
  if (x.dealPercent === 0) {
    lead = `${order} with no deal`;
  } else {
    const capped = deal.maxOffCents !== null && x.shopCents + x.platformCents === deal.maxOffCents ? ` (at most ${formatCents(deal.maxOffCents)})` : '';
    const payer = dealPayer({ percent: x.dealPercent, shopPercent: x.shopPercent });
    if (payer === 'shop') lead = `${order} with ${x.dealPercent}% off${capped} that you pay`;
    else if (payer === 'foodpanda') {
      lead = `${order} with ${x.dealPercent}% off${capped} that foodpanda pays`;
      bill += ` and foodpanda pays the ${formatCents(x.platformCents)} off`;
    } else {
      lead = `${order} with ${x.dealPercent}% off${capped}, you paying ${x.shopPercent}%`;
      bill += ` and foodpanda pays the other ${formatCents(x.platformCents)}`;
    }
  }
  const rate = percentFromBps(x.commissionBps);
  let keeps = `foodpanda keeps ${fees.confirmed ? '' : 'about '}${rate} of ${formatCents(x.commissionBaseCents)} = ${formatCents(x.commissionCents)}`;
  const extras: string[] = [];
  if (x.commissionTaxCents > 0) extras.push(`${formatCents(x.commissionTaxCents)} tax on that`);
  if (x.fixedFeeCents > 0) extras.push(`a ${formatCents(x.fixedFeeCents)} fee`);
  if (extras.length > 0) keeps += `, plus ${extras.join(' and ')}`;
  const tail = fees.confirmed ? '' : ` (${rate} is only suggested until you confirm foodpanda's commission below.)`;
  return `${lead}: ${bill}; ${keeps}; you keep ${formatCents(x.youKeepCents)} before food cost.${tail}`;
}
