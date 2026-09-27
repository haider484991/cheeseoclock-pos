/**
 * "Used vs should have used" and stock takes in the owner's words (costing
 * spec Phase 8): screen, paper and file say the same thing. Pure, so it is
 * tested (varianceFormat.test.ts).
 */
import { formatCents, formatQty } from '@cheeseoclock/pos-domain';
import {
  DEFAULT_VARIANCE_BANDS,
  STOCK_COUNT_SCOPE_LABEL,
  type VarianceBands,
  type ReportVariance,
  type StockCountLine,
  type StockCountSummary,
  type VarianceBand,
  type VarianceEnd,
  type VarianceLine,
} from '@cheeseoclock/shared-types';
import { formatBps } from '../costing/costingFormat';
import { fmtMoment } from './dateRange';

/** The rating, as the owner reads it: by default under 2% good, 2–3% OK, 3–5% needs work, over 5% look at it now. */
export const VARIANCE_BAND_LABEL: Record<VarianceBand, string> = {
  good: 'Good',
  ok: 'OK',
  needs_work: 'Needs work',
  look_now: 'Look at it now',
};

/**
 * The rating's bands under the figure, built from the ones the till used
 * (Settings → Kitchen & stock; the released 2% / 5% when the report has
 * none): "Under 2% is good; over 5%, look at it now".
 */
export function varianceBandsText(bands: VarianceBands | null | undefined): string {
  const b = bands ?? DEFAULT_VARIANCE_BANDS;
  return `Under ${formatBps(b.goodUnderBps)} is good; over ${formatBps(b.needsWorkUpToBps)}, look at it now`;
}

/** How the rating is coloured. */
export function bandTone(band: VarianceBand | null): 'good' | 'warn' | 'bad' | 'none' {
  if (band === null) return 'none';
  if (band === 'good' || band === 'ok') return 'good';
  return band === 'needs_work' ? 'warn' : 'bad';
}

/** "+1.2 kg", "−300 g", "0 g". */
export function signedQty(qty: number, unit: string): string {
  if (qty === 0) return formatQty(0, unit);
  return `${qty > 0 ? '+' : '−'}${formatQty(Math.abs(qty), unit)}`;
}

/** "+Rs 1,200", "−Rs 300". */
export function signedCents(cents: number): string {
  if (cents === 0) return formatCents(0);
  return `${cents > 0 ? '+' : '−'}${formatCents(Math.abs(cents))}`;
}

/** A stock take as the report names it: "Mon 21 Sep 2026, 09:40 (key items)". */
export function stockTakeName(end: Pick<VarianceEnd, 'finishedAt' | 'scope'>): string {
  return `${fmtMoment(end.finishedAt)} (${STOCK_COUNT_SCOPE_LABEL[end.scope].toLowerCase()})`;
}

/** "Between Mon 21 Sep 2026, 09:40 (key items) and Mon 28 Sep 2026, 10:15 (key items)." */
export function varianceWindowText(v: Pick<ReportVariance, 'from' | 'to'>): string | null {
  if (!v.from || !v.to) return null;
  return `Between ${stockTakeName(v.from)} and ${stockTakeName(v.to)}.`;
}

/**
 * The headline: what went unexplained, in rupees and as a share of food
 * sales. Above 0 is stock gone with nothing to explain it; below 0 is more
 * on the shelves than the till expected (a delivery not booked in, a
 * miscount…) — a sign too.
 */
export function varianceHeadline(v: Pick<ReportVariance, 'totalCents' | 'varianceBps' | 'lines'>): string {
  if (v.lines.length === 0) return 'Nothing was counted on both stock takes, so there is nothing to compare.';
  return varianceTotalText(v.totalCents, v.varianceBps);
}

/** What went unexplained in one sentence, either way (the headline's words, and the weekly sheet's). */
export function varianceTotalText(totalCents: number, varianceBps: number | null): string {
  const share = varianceBps === null ? '' : `: ${formatBps(Math.abs(varianceBps))} of food sales`;
  if (totalCents > 0) return `${formatCents(totalCents)} more went than sales, batches and logged waste explain${share}.`;
  if (totalCents < 0) return `${formatCents(-totalCents)} more is on the shelves than the till expected${share}.`;
  return 'Everything that went is explained by sales, batches and logged waste.';
}

/** One ingredient's verdict: "1.2 kg more went than should have", "300 g more on the shelf than expected", "As expected". */
export function lineVerdict(l: Pick<VarianceLine, 'unexplained' | 'unit'>): string {
  if (l.unexplained > 0) return `${formatQty(l.unexplained, l.unit)} more went than should have`;
  if (l.unexplained < 0) return `${formatQty(-l.unexplained, l.unit)} more on the shelf than expected`;
  return 'As expected';
}

/** Percentage points: 400 → "4 points", 100 → "1 point", 250 → "2.5 points". */
export function pointsText(bps: number): string {
  const n = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 1 }).format(bps / 100);
  return `${n} ${bps === 100 ? 'point' : 'points'}`;
}

/** The real food cost in one sentence, with what it should have been. */
export function actualCogsText(a: NonNullable<ReportVariance['actualCogs']>): string {
  if (a.actualBps === null) return `The food used cost ${formatCents(a.costCents)}; there were no food sales to set it against.`;
  const should = a.shouldHaveBps === null ? '' : ` Sales say it should have been ${formatBps(a.shouldHaveBps)}`;
  const gap = a.gapBps === null || a.gapBps === 0 ? '' : `, ${pointsText(Math.abs(a.gapBps))} ${a.gapBps > 0 ? 'more' : 'less'}`;
  return `Real food cost ${formatBps(a.actualBps)} of food sales.${should}${gap}${should ? '.' : ''}`;
}

/** A finished stock take's differences in one line: "Rs 1,240 short, Rs 300 over" / "Nothing missing". */
export function stockCountDifferenceText(c: Pick<StockCountSummary, 'shortCents' | 'overCents' | 'status'>): string {
  if (c.status === 'cancelled') return 'Cancelled';
  if (c.status === 'open' || c.shortCents === null || c.overCents === null) return 'Being counted';
  if (c.shortCents === 0 && c.overCents === 0) return 'As expected';
  const parts: string[] = [];
  if (c.shortCents > 0) parts.push(`${formatCents(c.shortCents)} short`);
  if (c.overCents > 0) parts.push(`${formatCents(c.overCents)} over`);
  return parts.join(', ');
}

/** A finished line's difference in words: "300 g less than expected", "1.2 kg more than expected", "As expected". */
export function countLineDifferenceText(l: Pick<StockCountLine, 'differenceQty' | 'unit'>): string {
  if (l.differenceQty === null) return '';
  if (l.differenceQty < 0) return `${formatQty(-l.differenceQty, l.unit)} less than expected`;
  if (l.differenceQty > 0) return `${formatQty(l.differenceQty, l.unit)} more than expected`;
  return 'As expected';
}
