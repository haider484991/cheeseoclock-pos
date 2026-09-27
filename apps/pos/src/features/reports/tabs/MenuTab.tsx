/**
 * Reports → Menu (costing spec Phase 3): what sells, by item and by
 * category. The section moved here unchanged from ReportSections.tsx; the
 * tab loads only these figures (reports:menu). Later phases add cost and
 * profit columns, menu engineering, add-ons and leave-outs here.
 */
import { useState } from 'react';
import { cn } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import type { ReportMenuTab } from '@cheeseoclock/shared-types';
import { UtensilsCrossed } from 'lucide-react';
import { ShareBar } from '../charts';
import { DataTable, Panel, Section, useShowAll } from '../reportUi';
import { percentOf } from '../reportFormat';

export function MenuTab({ data }: { data: ReportMenuTab }) {
  return <ItemsSection report={data} />;
}

export function ItemsSection({ report }: { report: Pick<ReportMenuTab, 'kpis' | 'items' | 'categories'> }) {
  const [sortBy, setSortBy] = useState<'sales' | 'qty'>('sales');
  const items = sortBy === 'sales' ? report.items : [...report.items].sort((a, b) => b.quantity - a.quantity || b.salesCents - a.salesCents);
  const { shown, toggle } = useShowAll(items, 10);
  const total = report.kpis.menuSalesCents;

  return (
    <Section
      id="items"
      icon={UtensilsCrossed}
      title="What sells"
      subtitle="At menu price, before order discounts. Refunded-in-full and cancelled orders are left out."
    >
      <div className="grid gap-4 xl:grid-cols-5">
        <Panel className="xl:col-span-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold tracking-tight text-stone-700 dark:text-stone-200">Items</h3>
            <div className="flex rounded-lg bg-stone-100 p-0.5 text-xs font-semibold dark:bg-stone-800" role="group" aria-label="Sort items">
              {(['sales', 'qty'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={sortBy === s}
                  onClick={() => setSortBy(s)}
                  className={cn(
                    'rounded-md px-3 py-1.5',
                    sortBy === s ? 'bg-white shadow-sm dark:bg-stone-700' : 'text-stone-500',
                  )}
                >
                  {s === 'sales' ? 'Most money' : 'Most sold'}
                </button>
              ))}
            </div>
          </div>
          <DataTable
            columns={[{ label: '#', className: 'w-8 text-stone-400' }, { label: 'Item' }, { label: 'Sold', right: true }, { label: 'Sales', right: true }, { label: 'Share', right: true }]}
            rows={shown.map((i, n) => [
              n + 1,
              <div key="n">
                <div className="font-medium">{i.name}</div>
                <div className="text-xs text-stone-500">{i.categoryName}</div>
              </div>,
              i.quantity,
              formatCents(i.salesCents),
              percentOf(i.salesCents, total),
            ])}
            footer={items.length > 0 ? ['', 'All items', report.kpis.itemCount, formatCents(total), ''] : undefined}
            empty="Nothing sold in this period."
          />
          {toggle}
        </Panel>

        <Panel title="Categories" className="xl:col-span-2">
          {report.categories.length === 0 ? (
            <p className="py-4 text-center text-sm text-stone-500">Nothing sold in this period.</p>
          ) : (
            <ul className="space-y-3">
              {report.categories.map((c) => (
                <li key={c.categoryId ?? c.name}>
                  <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
                    <span className="truncate font-medium">{c.name}</span>
                    <span className="whitespace-nowrap tabular-nums">
                      {formatCents(c.salesCents)} <span className="text-xs text-stone-500">· {c.quantity} sold</span>
                    </span>
                  </div>
                  <ShareBar value={c.salesCents} total={total} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </Section>
  );
}
