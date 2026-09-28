/**
 * Reports → Channels & delivery → foodpanda (Settings → foodpanda): the
 * period's foodpanda orders with the deal, what foodpanda keeps and what the
 * shop keeps, from the terms each order kept when it was paid — and the
 * orders to tick off against foodpanda's statement (no foodpanda number, or
 * a tablet total that differs, first). The owner's alone, like all of Reports.
 *
 * Every figure comes from the one per-order rule (pos-domain
 * foodpandaOrderMoney) that Reports → Profit uses too: "foodpanda kept" is
 * the foodpanda row's "foodpanda kept" in "What each order type earns", and
 * the price uplift that row's — never a second figure for the same thing.
 * Part refunds come off both the same way (the note says how much).
 */
import { cn } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import type { ReportFoodpanda } from '@cheeseoclock/shared-types';
import { ClipboardCheck, ShoppingBag } from 'lucide-react';
import { DataTable, Kpi, Note, Panel, Section, useShowAll } from '../reportUi';
import { fmtWhen } from '../reportFormat';

/** 3750 bps → "37.5%". */
function bpsText(bps: number | null): string {
  if (bps === null) return '—';
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

/**
 * How far the tablet may be from what it should show before an order is
 * listed, in words, from the tolerance in force now (Settings → foodpanda;
 * the same Pay uses): "more than Rs 1 away from", or at Rs 0 "not exactly".
 */
export function tabletTotalWords(toleranceCents: number): string {
  return toleranceCents > 0 ? `more than ${formatCents(toleranceCents)} away from` : 'not exactly';
}

/** Under "You keep": the dearer menu's share and the part refunds already taken off, when there are any. */
export function foodpandaKeepSub(fp: Pick<ReportFoodpanda, 'upliftCents' | 'partRefundCents'>): string {
  const parts: string[] = [];
  if (fp.upliftCents !== 0) parts.push(`With ${formatCents(fp.upliftCents)} from foodpanda’s dearer menu`);
  if (fp.partRefundCents > 0) parts.push(`after ${formatCents(fp.partRefundCents)} handed back`);
  parts.push('before tax and food cost');
  const text = parts.join(' · ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The warning under the figures, every number from the report: the
 * commission the unconfirmed orders were worked out at (whatever the owner
 * typed, or the suggested figure), and how many orders were estimated.
 */
export function foodpandaEstimateNote(
  fp: Pick<ReportFoodpanda, 'commissionSuggested' | 'unconfirmedCommissionBps' | 'estimatedOrders'>,
): string {
  const parts: string[] = [];
  if (fp.commissionSuggested) {
    const rate = fp.unconfirmedCommissionBps === null ? '' : ` (${bpsText(fp.unconfirmedCommissionBps)})`;
    parts.push(`The commission${rate} is not confirmed yet: confirm foodpanda’s real one in Settings → foodpanda.`);
  }
  if (fp.estimatedOrders > 0) {
    const n = fp.estimatedOrders;
    parts.push(
      `${n} order${n === 1 ? ' has' : 's have'} no confirmed commission kept from when ${n === 1 ? 'it was' : 'they were'} paid: worked out with the fees in Settings now.`,
    );
  }
  return parts.join(' ');
}

export function FoodpandaSection({ foodpanda: fp }: { foodpanda: ReportFoodpanda | null | undefined }) {
  const check = useShowAll(fp?.toCheck ?? [], 12);
  if (!fp) return null;
  // foodpanda dearer than the till: the tablet is checked against the till's total at its prices.
  const showExpected = fp.toCheck.some((l) => l.expectedTabletCents !== l.tillTotalCents);
  const keeps = fp.foodpandaKeepsCents;
  return (
    <Section
      id="foodpanda"
      icon={ShoppingBag}
      title="foodpanda"
      subtitle={`${fp.orderCount} order${fp.orderCount === 1 ? '' : 's'}: foodpanda kept ${formatCents(keeps)}, you keep ${formatCents(fp.youKeepCents)} before tax and food cost.`}
    >
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Sales at till prices" value={formatCents(fp.tillPriceSalesCents)} sub={`${fp.orderCount} orders, before the deal`} />
        <Kpi
          label="The deal"
          value={formatCents(fp.shopDealCents + fp.foodpandaDealCents)}
          sub={`Your part ${formatCents(fp.shopDealCents)} · foodpanda’s ${formatCents(fp.foodpandaDealCents)}`}
        />
        <Kpi
          label="foodpanda kept"
          value={formatCents(keeps)}
          sub={`Commission ${formatCents(fp.commissionCents)}${fp.feeCents > 0 ? ` · fees ${formatCents(fp.feeCents)}` : ''}${fp.commissionTaxCents > 0 ? ` · tax ${formatCents(fp.commissionTaxCents)}` : ''}`}
        />
        <Kpi
          label="You keep"
          value={formatCents(fp.youKeepCents)}
          sub={foodpandaKeepSub(fp)}
          big
        />
      </div>

      <div className="mt-3 space-y-2">
        <Note>
          foodpanda should pay you about <span className="font-semibold">{formatCents(fp.expectedPayoutCents)}</span> for these
          orders (the bills with tax{fp.upliftCents !== 0 ? ' at foodpanda’s prices' : ''}
          {fp.partRefundCents > 0 ? ', less what was handed back' : ''}, less what foodpanda keeps).
          {fp.foodCost && (
            <>
              {' '}
              Their food cost {formatCents(fp.foodCost.costCents)}: {bpsText(fp.foodCost.ofSalesBps)} of what the food sold for, and{' '}
              {bpsText(fp.foodCost.ofKeptBps)} of what you keep
              {fp.foodCost.costedOrders < fp.orderCount ? ` (the ${fp.foodCost.costedOrders} orders whose cost is known)` : ''}.
            </>
          )}
        </Note>
        {(fp.commissionSuggested || fp.estimatedOrders > 0) && <Note tone="warn">{foodpandaEstimateNote(fp)}</Note>}
      </div>

      <Panel
        title="foodpanda orders to check"
        className="mt-4"
        note={
          <>
            Tick these off against foodpanda’s statement. First each day: no foodpanda number ({fp.missingCodeCount}) or a
            tablet total {tabletTotalWords(fp.tabletToleranceCents)} what it should show ({fp.tabletDiffCount}) — the till’s total, at
            foodpanda’s prices when its menu is dearer.
          </>
        }
      >
        <DataTable
          columns={[
            { label: 'Day' },
            { label: 'Order' },
            { label: 'foodpanda #' },
            { label: 'Till total', right: true },
            ...(showExpected ? [{ label: 'Tablet should show', right: true }] : []),
            { label: 'Tablet total', right: true },
            { label: 'Difference', right: true },
          ]}
          rows={check.shown.map((l) => [
            fmtWhen(l.createdAt),
            <span key="o" className="font-mono text-xs">{l.orderNumber}</span>,
            l.foodpandaCode ? (
              <span key="c" className="font-mono text-xs">{l.foodpandaCode}</span>
            ) : (
              <span key="c" className="font-semibold text-amber-700 dark:text-amber-300">None typed</span>
            ),
            formatCents(l.tillTotalCents),
            ...(showExpected ? [formatCents(l.expectedTabletCents)] : []),
            l.tabletTotalCents === null ? '—' : formatCents(l.tabletTotalCents),
            <span key="d" className={cn(l.differs && 'font-semibold text-amber-700 dark:text-amber-300')}>
              {l.diffCents === null ? '—' : `${l.diffCents > 0 ? '+' : l.diffCents < 0 ? '−' : ''}${formatCents(Math.abs(l.diffCents))}`}
            </span>,
          ])}
          empty="None."
        />
        {check.toggle}
        {fp.toCheck.length < fp.orderCount && (
          <p className="mt-2 flex items-center gap-1 text-xs text-stone-500">
            <ClipboardCheck className="h-3.5 w-3.5" /> Showing {fp.toCheck.length} of {fp.orderCount}. The totals above include all of them.
          </p>
        )}
      </Panel>
    </Section>
  );
}
