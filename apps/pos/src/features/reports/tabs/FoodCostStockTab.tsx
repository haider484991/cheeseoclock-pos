/**
 * Reports → Food cost & stock (costing spec Phase 3), for a login that may
 * see costs (COST_CAPABILITY): the main process refuses the rest, and the
 * tab is not shown to them. The section moved here unchanged from
 * ReportSections.tsx; the tab loads only these figures (reports:foodStock),
 * plus the ingredients running low now. Later phases add purchases,
 * variance and actual cost of goods here.
 */
import { Link } from 'react-router-dom';
import { formatCents } from '@cheeseoclock/pos-domain';
import type { ReportFoodCost, ReportFoodStockTab } from '@cheeseoclock/shared-types';
import { Wheat } from 'lucide-react';
import { DataTable, Note, Panel, Section, useShowAll } from '../reportUi';
import {
  MISSING_COST_WHY,
  WASTE_REASON_LABEL,
  cancelledWasteText,
  costingStartText,
  coverageText,
  estimatedText,
  foodCostHeadline,
  fmtQty,
  menuPriceLine,
} from '../reportFormat';
import { formatBps } from '../../costing/costingFormat';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function FoodCostStockTab({ data, lowStockCount }: { data: ReportFoodStockTab; lowStockCount: number | null }) {
  return <FoodCostSection report={data} food={data.foodCost} lowStockCount={lowStockCount} />;
}

/**
 * Food cost (costing spec Phase 2): what the food sold cost to make, on the
 * same paid orders as the sales, with how much of it is known; the sales
 * whose cost is missing; waste by reason; food that went out unpaid. Only
 * for a login that may see costs (the main process leaves it out otherwise).
 */
export function FoodCostSection({
  report,
  food: f,
  lowStockCount,
}: {
  report: Pick<ReportFoodStockTab, 'kpis'>;
  food: ReportFoodCost;
  lowStockCount: number | null;
}) {
  const missing = useShowAll(f.missingSales, 8);
  const wasted = useShowAll(f.wasteIngredients, 8);
  const lowStock =
    lowStockCount !== null && lowStockCount > 0 ? (
      <Note tone="warn">
        {plural(lowStockCount, 'ingredient is', 'ingredients are')} running low right now.{' '}
        <Link to="/inventory" className="font-semibold underline">
          Open Inventory
        </Link>
      </Note>
    ) : null;
  const reconcile = menuPriceLine(f);
  const estimated = estimatedText(f);

  return (
    <Section
      id="food"
      icon={Wheat}
      title="Food cost"
      subtitle="What the food you sold cost to make, from the orders saved on this till. Sales here are before tax, after discounts."
    >
      {!f.hasUsage && f.foodSalesCents === 0 ? (
        <div className="space-y-3">
          <Panel>
            <p className="py-4 text-center text-sm text-stone-500">
              No food sold or wasted in this period. Items need recipes in Inventory before their ingredients are counted.
            </p>
          </Panel>
          {lowStock}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Panel>
              <div className="text-[11px] font-semibold uppercase tracking-widest text-stone-500">Food cost</div>
              <div className="mt-1 text-2xl font-bold tabular-nums">{f.foodCostBps !== null ? formatBps(f.foodCostBps) : '—'}</div>
              <div className="mt-1 text-xs text-stone-500">{f.foodSalesCents > 0 ? coverageText(f) : foodCostHeadline(f)}</div>
            </Panel>
            <Panel>
              <div className="text-[11px] font-semibold uppercase tracking-widest text-stone-500">Cost of food sold</div>
              <div className="mt-1 text-2xl font-bold tabular-nums">{f.hasCosts ? formatCents(f.costOfSalesCents) : '—'}</div>
              <div className="mt-1 text-xs text-stone-500">of {formatCents(f.foodSalesCents)} food sales</div>
            </Panel>
            <Panel>
              <div className="text-[11px] font-semibold uppercase tracking-widest text-stone-500">Wasted</div>
              <div className="mt-1 text-2xl font-bold tabular-nums">{f.wasteCents > 0 ? formatCents(f.wasteCents) : '—'}</div>
              {f.cancelledOrderCount > 0 && <div className="mt-1 text-xs text-stone-500">{cancelledWasteText(f)}</div>}
            </Panel>
            <Panel>
              <div className="text-[11px] font-semibold uppercase tracking-widest text-stone-500">Sent out, not paid</div>
              <div className="mt-1 text-2xl font-bold tabular-nums">{f.sentNotPaid.orderCount > 0 ? formatCents(f.sentNotPaid.costCents) : '—'}</div>
              <div className="mt-1 text-xs text-stone-500">
                {f.sentNotPaid.orderCount > 0
                  ? `Food of ${plural(f.sentNotPaid.orderCount, 'order')} served or delivered, never paid`
                  : 'Every order served or delivered was paid'}
              </div>
            </Panel>
          </div>
          {reconcile && <p className="text-xs text-stone-500">{reconcile}.</p>}
          {estimated && (
            <Note>
              {estimated} {costingStartText(f.costingStartedAt)}
            </Note>
          )}
          {report.kpis.partialRefundCents > 0 && (
            <Note>Part refunds lower the sales, not the cost: the food was made.</Note>
          )}
          {f.stillOpen.orderCount > 0 && (
            <Note tone="warn">
              {plural(f.stillOpen.orderCount, 'order')} from earlier days {f.stillOpen.orderCount === 1 ? 'is' : 'are'} still open on the
              Orders board ({formatCents(f.stillOpen.costCents)} of food). {f.stillOpen.orderCount === 1 ? 'It counts' : 'They count'} once
              paid or closed.
            </Note>
          )}
          {f.putBackAfterCookingCount > 0 && (
            <Note tone="warn">
              {plural(f.putBackAfterCookingCount, 'cancelled order')} had stock put back after cooking was marked. See
              Refunds and cancelled orders.
            </Note>
          )}
          {!f.hasCosts && <Note>No prices are set on these ingredients yet. Add what you pay for them in Inventory to see the food cost.</Note>}
          {lowStock}
          <div className="grid gap-4 xl:grid-cols-2">
            <Panel
              title={`Sales with missing costs — ${formatCents(f.missingSalesCents)}`}
              note={
                f.missingSales.length > 0 ? (
                  <>
                    Not in the food cost %.{' '}
                    <Link to="/costing" className="font-semibold underline">
                      Fix them on Costing
                    </Link>
                  </>
                ) : undefined
              }
            >
              <DataTable
                columns={[{ label: 'Item' }, { label: 'Why' }, { label: 'Sold', right: true }, { label: 'Sales', right: true }]}
                rows={missing.shown.map((m) => [
                  <span key="n" className="font-medium">{m.name}</span>,
                  MISSING_COST_WHY[m.why],
                  m.quantity,
                  formatCents(m.salesCents),
                ])}
                empty="Every sale's cost is known."
              />
              {missing.toggle}
            </Panel>
            <Panel
              title={`Waste by reason — ${f.wasteCents > 0 ? formatCents(f.wasteCents) : 'none'}`}
              note="At what the stock cost when it was taken. Times: orders for food cancelled after cooking, entries for the rest."
            >
              <DataTable
                columns={[{ label: 'Reason' }, { label: 'Times', right: true }, { label: 'Cost', right: true }]}
                rows={f.wasteByReason.map((w) => [WASTE_REASON_LABEL[w.reason], w.times, w.cents ? formatCents(w.cents) : '—'])}
                empty="Nothing was wasted."
              />
            </Panel>
          </div>
          {f.wasteIngredients.length > 0 && (
            <Panel title="What was wasted">
              <DataTable
                columns={[{ label: 'Ingredient' }, { label: 'Wasted', right: true }, { label: 'Cost', right: true }]}
                rows={wasted.shown.map((i) => [
                  <span key="n" className="font-medium">{i.name}</span>,
                  fmtQty(i.wastedQty, i.unit),
                  i.wastedCents ? formatCents(i.wastedCents) : '—',
                ])}
                footer={['All ingredients', '', f.wasteCents ? formatCents(f.wasteCents) : '—']}
                empty="None."
              />
              {wasted.toggle}
            </Panel>
          )}
        </div>
      )}
    </Section>
  );
}
