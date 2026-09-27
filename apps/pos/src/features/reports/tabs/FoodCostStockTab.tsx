/**
 * Reports → Food cost & stock (costing spec Phase 3), for a login that may
 * see costs (COST_CAPABILITY): the main process refuses the rest, and the
 * tab is not shown to them. The section moved here unchanged from
 * ReportSections.tsx; the tab loads only these figures (reports:foodStock),
 * plus the ingredients running low now. Phase 5 adds Purchases (what was
 * spent on stock, by supplier and by ingredient); later phases add variance
 * and actual cost of goods here.
 */
import { Link } from 'react-router-dom';
import { cn } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import type { ReportFoodCost, ReportFoodStockTab, ReportPurchases } from '@cheeseoclock/shared-types';
import { Truck, Wheat } from 'lucide-react';
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
  byHandText,
  hasPurchases,
  purchaseBillsText,
  purchaseChangeText,
  purchaseHeadline,
  purchasePriceText,
} from '../reportFormat';
import { formatBps } from '../../costing/costingFormat';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function FoodCostStockTab({ data, lowStockCount }: { data: ReportFoodStockTab; lowStockCount: number | null }) {
  return (
    <div className="space-y-10">
      <FoodCostSection report={data} food={data.foodCost} lowStockCount={lowStockCount} />
      <PurchasesSection purchases={data.purchases} />
    </div>
  );
}

/**
 * Purchases (costing spec Phase 5): what was spent on stock in the period,
 * at the bills, from the purchases booked on this till — by supplier, and by
 * ingredient with its latest price against the purchase before.
 */
export function PurchasesSection({ purchases: p }: { purchases: ReportPurchases }) {
  const ingredients = useShowAll(p.byIngredient, 8);
  const handNote = byHandText(p);
  return (
    <Section
      id="purchases"
      icon={Truck}
      title="Purchases"
      subtitle="What was spent on stock, at the bills, from the purchases booked in on this till."
    >
      {!hasPurchases(p) ? (
        <Panel>
          <p className="py-4 text-center text-sm text-stone-500">
            No stock bought in this period. Deliveries and purchases are booked in under Inventory → Purchases.
          </p>
        </Panel>
      ) : (
        <div className="space-y-3">
          <p className="text-sm font-semibold">{purchaseHeadline(p)}</p>
          {handNote && <Note>{handNote}</Note>}
          <div className="grid gap-4 xl:grid-cols-2">
            <Panel title="By supplier">
              <DataTable
                columns={[{ label: 'Bought from' }, { label: 'Bills', right: true }, { label: 'Spent', right: true }]}
                rows={p.bySupplier.map((s) => [
                  <span key="n" className={cn('font-medium', s.from !== 'supplier' && 'text-stone-500')}>{s.name}</span>,
                  purchaseBillsText(s),
                  formatCents(s.spendCents),
                ])}
                footer={['All', p.bills, formatCents(p.spendCents)]}
                empty="Nothing bought."
              />
            </Panel>
            <Panel title="By ingredient" note="Price: what one kg (or piece) cost on its latest paid purchase, and the change on the one before. Rs 0 bills and stock booked in by hand are not prices.">
              <DataTable
                columns={[{ label: 'Ingredient' }, { label: 'Bought', right: true }, { label: 'Spent', right: true }, { label: 'Price', right: true }]}
                rows={ingredients.shown.map((l) => {
                  const change = purchaseChangeText(l);
                  return [
                    <span key="n" className="font-medium">{l.name}</span>,
                    fmtQty(l.qty, l.unit),
                    formatCents(l.spendCents),
                    <span key="p" className="whitespace-nowrap">
                      {purchasePriceText(l)}
                      {change && (
                        <span
                          className={cn(
                            'ml-1.5 text-xs font-semibold',
                            change.tone === 'up' && 'text-red-700 dark:text-red-400',
                            change.tone === 'down' && 'text-emerald-700 dark:text-emerald-400',
                            change.tone === 'same' && 'text-stone-500',
                          )}
                        >
                          {change.text}
                        </span>
                      )}
                    </span>,
                  ];
                })}
                empty="Nothing bought."
              />
              {ingredients.toggle}
            </Panel>
          </div>
        </div>
      )}
    </Section>
  );
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
