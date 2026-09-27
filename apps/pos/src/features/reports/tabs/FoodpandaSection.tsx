/**
 * Reports → Channels & delivery → foodpanda (Settings → foodpanda): the
 * period's foodpanda orders with the deal, what foodpanda keeps and what the
 * shop keeps, from the terms each order kept when it was paid — and the
 * orders to tick off against foodpanda's statement (no foodpanda number, or
 * a tablet total that differs, first). The owner's alone, like all of Reports.
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
  const keeps = fp.commissionCents + fp.feeCents + fp.commissionTaxCents;
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
        <Kpi label="You keep" value={formatCents(fp.youKeepCents)} sub="Before tax and food cost" big />
      </div>

      <div className="mt-3 space-y-2">
        <Note>
          foodpanda should pay you about <span className="font-semibold">{formatCents(fp.expectedPayoutCents)}</span> for these
          orders (the bills with tax, less what foodpanda keeps).
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
            tablet total more than Rs 1 away from the till’s ({fp.tabletDiffCount}).
          </>
        }
      >
        <DataTable
          columns={[
            { label: 'Day' },
            { label: 'Order' },
            { label: 'foodpanda #' },
            { label: 'Till total', right: true },
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
