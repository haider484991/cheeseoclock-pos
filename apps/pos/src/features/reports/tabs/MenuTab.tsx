/**
 * Reports → Menu (costing spec Phase 3): what sells, by item and by
 * category. The section moved here unchanged from ReportSections.tsx; the
 * tab loads only these figures (reports:menu).
 *
 * Phase 9 adds each item's and category's cost and food cost (a login that
 * may see costs) and profit (profit.view) — from the cost each sale kept,
 * over the sales whose cost is fully known — and the menu map (profit.view,
 * its own channel: reports:menuMap): each category's dishes by how popular
 * and how profitable, in plain words. The main process leaves out what a
 * login may not see; the screen only follows. Later phases add add-ons and
 * leave-outs here.
 */
import { useState } from 'react';
import { cn } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import { MENU_MAP_WORDS, type MenuMapCategory, type ReportLineCost, type ReportMenuMap, type ReportMenuTab } from '@cheeseoclock/shared-types';
import { Loader2, Map as MapIcon, UtensilsCrossed } from 'lucide-react';
import { MenuMapScatter, ShareBar } from '../charts';
import { DataTable, Note, Panel, Section, useShowAll } from '../reportUi';
import { costingStartText, percentOf } from '../reportFormat';
import { formatBps } from '../../costing/costingFormat';
import { menuMapAdvice } from '../profitFormat';

/** The menu map as the page loaded it (profit.view only), and which days it covers. */
export interface MenuMapView {
  data: ReportMenuMap | undefined;
  loading: boolean;
  error: string | null;
  /** The last 28 days (the default), or the period picked above. */
  lastDays: boolean;
  setLastDays: (v: boolean) => void;
}

export function MenuTab({ data, menuMap = null }: { data: ReportMenuTab; menuMap?: MenuMapView | null }) {
  return (
    <div className="space-y-10">
      <ItemsSection report={data} />
      {menuMap && <MenuMapSection view={menuMap} />}
    </div>
  );
}

/** "29%", or "—" while nothing about it is known. */
const fc = (c: ReportLineCost | undefined) => (c && c.knownUnits > 0 ? formatBps(c.foodCostBps) : '—');
const known = (c: ReportLineCost | undefined) => (c ? formatBps(c.coverageBps) : '—');
const money = (v: number | null | undefined) => (v === null || v === undefined ? '—' : formatCents(v));

export function ItemsSection({ report }: { report: Pick<ReportMenuTab, 'kpis' | 'items' | 'categories'> & { costs?: ReportMenuTab['costs'] } }) {
  const [sortBy, setSortBy] = useState<'sales' | 'qty'>('sales');
  const items = sortBy === 'sales' ? report.items : [...report.items].sort((a, b) => b.quantity - a.quantity || b.salesCents - a.salesCents);
  const { shown, toggle } = useShowAll(items, 10);
  const total = report.kpis.menuSalesCents;
  const costs = report.costs ?? null;
  // Profit is profit.view's: the main process sends it only then.
  const withProfit = costs !== null && Object.values(costs.items).some((c) => c.profitCents !== null);

  return (
    <Section
      id="items"
      icon={UtensilsCrossed}
      title="What sells"
      subtitle="At menu price, before order discounts. Refunded-in-full and cancelled orders are left out."
    >
      <div className="grid gap-4 xl:grid-cols-5">
        <Panel
          className="xl:col-span-3"
          note={
            costs
              ? `Food cost${withProfit ? ' and profit' : ''} are on the sales whose cost is fully known, at what customers paid (after discounts)${
                  withProfit ? ', before channel costs (commission, rider)' : ''
                }. ${costingStartText(costs.costingStartedAt)}`
              : undefined
          }
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold tracking-tight text-stone-700 dark:text-stone-200">Items</h3>
            <div className="flex rounded-lg bg-stone-100 p-0.5 text-xs font-semibold dark:bg-stone-800" role="group" aria-label="Sort items">
              {(['sales', 'qty'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={sortBy === s}
                  onClick={() => setSortBy(s)}
                  className={cn('rounded-md px-3 py-1.5', sortBy === s ? 'bg-white shadow-sm dark:bg-stone-700' : 'text-stone-500')}
                >
                  {s === 'sales' ? 'Most money' : 'Most sold'}
                </button>
              ))}
            </div>
          </div>
          <DataTable
            columns={[
              { label: '#', className: 'w-8 text-stone-400' },
              { label: 'Item' },
              { label: 'Sold', right: true },
              { label: 'Sales', right: true },
              { label: 'Share', right: true },
              ...(costs ? [{ label: 'Food cost', right: true }, { label: 'Costs known', right: true }] : []),
              ...(withProfit ? [{ label: 'Profit', right: true }, { label: 'Per sale', right: true }] : []),
            ]}
            rows={shown.map((i, n) => {
              const c = costs?.items[i.key];
              return [
                n + 1,
                <div key="n">
                  <div className="font-medium">{i.name}</div>
                  <div className="text-xs text-stone-500">{i.categoryName}</div>
                </div>,
                i.quantity,
                formatCents(i.salesCents),
                percentOf(i.salesCents, total),
                ...(costs ? [fc(c), c ? known(c) : 'not food'] : []),
                ...(withProfit ? [money(c?.profitCents), money(c?.profitPerSaleCents)] : []),
              ];
            })}
            footer={
              items.length > 0
                ? ['', 'All items', report.kpis.itemCount, formatCents(total), '', ...(costs ? ['', ''] : []), ...(withProfit ? ['', ''] : [])]
                : undefined
            }
            empty="Nothing sold in this period."
          />
          {toggle}
        </Panel>

        <Panel title="Categories" className="xl:col-span-2">
          {report.categories.length === 0 ? (
            <p className="py-4 text-center text-sm text-stone-500">Nothing sold in this period.</p>
          ) : (
            <ul className="space-y-3">
              {report.categories.map((c) => {
                const cost = costs?.categories[c.categoryId ?? `name:${c.name}`];
                return (
                  <li key={c.categoryId ?? c.name}>
                    <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
                      <span className="truncate font-medium">{c.name}</span>
                      <span className="whitespace-nowrap tabular-nums">
                        {formatCents(c.salesCents)} <span className="text-xs text-stone-500">· {c.quantity} sold</span>
                      </span>
                    </div>
                    <ShareBar value={c.salesCents} total={total} />
                    {cost && cost.knownUnits > 0 && (
                      <div className="mt-1 text-xs text-stone-500">
                        Food cost {formatBps(cost.foodCostBps)} ({known(cost)} known)
                        {cost.profitCents !== null ? ` · profit ${formatCents(cost.profitCents)}` : ''}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>
    </Section>
  );
}

/** The menu map (costing spec 4.8): each category's dishes by how popular and how profitable, in plain words. */
export function MenuMapSection({ view }: { view: MenuMapView }) {
  const d = view.data;
  return (
    <Section
      id="menu-map"
      icon={MapIcon}
      title="Menu map"
      subtitle="Each category's dishes by how often they sell and what one sale earns (menu price less its cost). Nothing changes on the till."
      action={
        <div className="flex rounded-lg bg-stone-100 p-0.5 text-xs font-semibold dark:bg-stone-800" role="group" aria-label="Days for the menu map">
          {([true, false] as const).map((last) => (
            <button
              key={String(last)}
              type="button"
              aria-pressed={view.lastDays === last}
              onClick={() => view.setLastDays(last)}
              className={cn('rounded-md px-3 py-1.5', view.lastDays === last ? 'bg-white shadow-sm dark:bg-stone-700' : 'text-stone-500')}
            >
              {last ? 'Last 28 days' : 'The period above'}
            </button>
          ))}
        </div>
      }
    >
      {view.error ? (
        <Note tone="warn">{view.error}</Note>
      ) : !d ? (
        <Panel>
          <p className="flex items-center justify-center gap-2 py-4 text-sm text-stone-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Working out the menu map…
          </p>
        </Panel>
      ) : d.categories.length === 0 ? (
        <Panel>
          <p className="py-4 text-center text-sm text-stone-500">No food dishes on the menu.</p>
        </Panel>
      ) : (
        <div className={cn('space-y-4', view.loading && 'opacity-60')}>
          {d.categories.map((c) => (
            <MenuMapCard key={c.categoryId} category={c} />
          ))}
          <p className="text-xs text-stone-500">{costingStartText(d.costingStartedAt)}</p>
        </div>
      )}
    </Section>
  );
}

function MenuMapCard({ category: c }: { category: MenuMapCategory }) {
  const tone = { star: 'text-emerald-700 dark:text-emerald-400', plowhorse: 'text-amber-700 dark:text-amber-400', puzzle: 'text-sky-700 dark:text-sky-400', dog: 'text-rose-700 dark:text-rose-400' } as const;
  // The dot's colour on the chart, so the table's numbers read as its key.
  const dot = { star: 'bg-emerald-500', plowhorse: 'bg-amber-500', puzzle: 'bg-sky-500', dog: 'bg-rose-500' } as const;
  return (
    <Panel>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">{c.name}</h3>
        <span className="text-xs text-stone-500">
          {c.units} sold
          {c.state === 'ok' && c.averageProfitCents !== null && c.popularLineBps !== null
            ? ` · a sale earns ${formatCents(c.averageProfitCents)} on average · popular = at least ${formatBps(c.popularLineBps)} of the category's sales`
            : ''}
        </span>
      </div>
      {c.state === 'few_sales' && (
        <p className="text-sm text-stone-600 dark:text-stone-300">Not enough sales yet: {c.units} sold, it needs 200 to say anything useful.</p>
      )}
      {c.state === 'few_dishes' && (
        <p className="text-sm text-stone-600 dark:text-stone-300">Not enough dishes with a known cost sold yet: it needs 3 to compare them.</p>
      )}
      {c.state === 'ok' && c.averageProfitCents !== null && c.popularLineBps !== null && (
        <div className="grid gap-4 lg:grid-cols-2">
          <MenuMapScatter
            ariaLabel={`${c.name}: dishes by how popular and how profitable`}
            xLine={c.popularLineBps}
            yLine={c.averageProfitCents}
            corners={[MENU_MAP_WORDS.puzzle.plain, MENU_MAP_WORDS.star.plain, MENU_MAP_WORDS.dog.plain, MENU_MAP_WORDS.plowhorse.plain]}
            points={c.items.map((i, n) => ({
              key: i.menuItemId,
              x: i.mixBps,
              y: i.profitPerSaleCents,
              label: String(n + 1),
              title: `${n + 1}. ${i.name}: ${i.units} sold (${formatBps(i.mixBps)}), earns ${formatCents(i.profitPerSaleCents)} a sale`,
              tone: i.class,
            }))}
          />
          <DataTable
            columns={[{ label: '#', className: 'w-8 text-stone-400' }, { label: 'Dish' }, { label: 'Sold', right: true }, { label: 'Earns a sale', right: true }, { label: 'What to do' }]}
            rows={c.items.map((i, n) => [
              <span key="k" className={cn('inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full px-1 text-[10px] font-bold text-white', dot[i.class])}>
                {n + 1}
              </span>,
              <span key="n" className="font-medium">{i.name}</span>,
              `${i.units} · ${formatBps(i.mixBps)}`,
              formatCents(i.profitPerSaleCents),
              <span key="a" className="text-xs">
                <span className={cn('font-semibold', tone[i.class])}>{menuMapAdvice(i, c.name)}</span>{' '}
                <span className="text-stone-400">({MENU_MAP_WORDS[i.class].term})</span>
              </span>,
            ])}
            empty="—"
          />
        </div>
      )}
      {c.cantPlace.length > 0 && (
        <p className="mt-2 text-xs text-stone-500">
          Can&apos;t place yet (under 90% of its sales have a known cost):{' '}
          {c.cantPlace.map((x) => `${x.name} (${formatBps(x.costedShareBps)})`).join(', ')}.
        </p>
      )}
      {c.notSold.length > 0 && <p className="mt-1 text-xs text-stone-500">Not sold in these days: {c.notSold.map((x) => x.name).join(', ')}.</p>}
    </Panel>
  );
}
