import { Fragment, useCallback, useMemo, useState } from 'react';
import { Card, cn } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import type { MenuCostRow } from '@cheeseoclock/shared-types';
import { AlertTriangle, Target } from 'lucide-react';
import { FilterChips, SearchBox, matchesSearch, useDeepLinkOpen, useSessionState, type ChipOption } from '../../components/list';
import { useMenuCosts } from './costingQueries';
import { FoodCostChip } from './CostChip';
import { ItemCostSheetDrawer } from './ItemCostSheet';
import { groupSizes, splitSize, summarySentence } from './costingFormat';

/**
 * Menu costs: every item and size, worst first, with the five columns the
 * owner reads — item, price, cost to make, food-cost chip, profit per sale.
 * A row opens its cost sheet. Delivery charges and other non-food lines are
 * left out.
 */
export function MenuCostsTab({ onShowMissing, onShowTargets }: { onShowMissing: () => void; onShowTargets: () => void }) {
  const q = useMenuCosts();
  const [category, setCategory] = useSessionState<string>('costing.menu.cat', 'all');
  const [query, setQuery] = useSessionState('costing.menu:q', '');
  const [openId, setOpenId] = useState<string | null>(null);

  const food = useMemo(() => (q.data?.rows ?? []).filter((r) => r.flag !== 'nonfood'), [q.data]);
  // A dish named by the Dashboard's "Do this" list opens its cost sheet once the rows are in.
  const linkable = useMemo(() => (q.data ? q.data.rows.map((r) => ({ id: r.menuItemId })) : undefined), [q.data]);
  const openLinked = useCallback((r: { id: string }) => setOpenId(r.id), []);
  useDeepLinkOpen('costing.menu.openId', linkable, openLinked);
  const searched = useMemo(() => food.filter((r) => matchesSearch(`${r.name} ${r.categoryName}`, query)), [food, query]);
  const shown = useMemo(() => searched.filter((r) => category === 'all' || r.categoryId === category), [searched, category]);
  const groups = useMemo(() => groupSizes(shown), [shown]);

  const categoryOptions: ChipOption<string>[] = useMemo(() => {
    const counts = new Map<string, { name: string; n: number }>();
    for (const r of searched) {
      const c = counts.get(r.categoryId) ?? { name: r.categoryName, n: 0 };
      c.n += 1;
      counts.set(r.categoryId, c);
    }
    return [
      { id: 'all', label: 'All', count: searched.length },
      ...[...counts.entries()].map(([id, c]) => ({ id, label: c.name || '—', count: c.n })),
    ];
  }, [searched]);

  const s = q.data?.summary;

  return (
    <div className="space-y-3">
      {s && (
        <Card>
          <p className="text-lg font-semibold">{summarySentence(s)}</p>
          <p className="mt-1 text-sm text-stone-500">
            At today&apos;s prices and the menu price before tax. Choices a customer must make (a deal&apos;s pizzas, the
            veggies, the dip) are costed at what customers usually pick on this till.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {s.notConfirmed > 0 && (
              <button
                type="button"
                onClick={onShowTargets}
                className="inline-flex items-center gap-1.5 rounded-lg bg-stone-100 px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-200 dark:bg-stone-800 dark:text-stone-200 dark:hover:bg-stone-700"
              >
                <Target className="h-4 w-4" />
                The targets are only suggestions: no colours until they are confirmed
              </button>
            )}
            {s.cantCost > 0 && (
              <button
                type="button"
                onClick={onShowMissing}
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-50 px-3 py-1.5 text-sm font-medium text-red-800 hover:bg-red-100 dark:bg-red-950/50 dark:text-red-200 dark:hover:bg-red-950"
              >
                <AlertTriangle className="h-4 w-4" />
                {s.cantCost} can&apos;t be costed yet: see what&apos;s missing
              </button>
            )}
          </div>
        </Card>
      )}

      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <SearchBox value={query} onChange={setQuery} placeholder="Search items…" label="Search menu items" />
        </div>
        <FilterChips label="Menu category" className="mb-3" options={categoryOptions} value={category} onChange={setCategory} />

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-stone-500">
              <tr>
                <th className="pb-2">Item</th>
                <th className="pb-2 text-right">Price</th>
                <th className="pb-2 text-right">Cost to make</th>
                <th className="pb-2 text-center">Food cost</th>
                <th className="pb-2 text-right">You keep per sale</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) =>
                g.rows.length === 1 ? (
                  <CostRow key={g.key} row={g.rows[0]!} label={g.rows[0]!.name} onOpen={setOpenId} />
                ) : (
                  <Fragment key={g.key}>
                    <tr className="border-t border-stone-200 dark:border-stone-700">
                      <td colSpan={5} className="pb-0.5 pt-2.5 font-semibold">
                        {g.base}
                        <span className="ml-2 text-xs font-normal text-stone-500">{g.rows[0]!.categoryName}</span>
                      </td>
                    </tr>
                    {g.rows.map((r) => (
                      <CostRow key={r.menuItemId} row={r} label={splitSize(r.name).size ?? r.name} indent onOpen={setOpenId} />
                    ))}
                  </Fragment>
                ),
              )}
              {groups.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-stone-500">
                    {q.isLoading ? 'Working out the costs…' : q.isError ? 'Could not work out the costs.' : food.length === 0 ? 'No menu items yet.' : 'No items match.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {openId && <ItemCostSheetDrawer menuItemId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function CostRow({ row: r, label, indent, onOpen }: { row: MenuCostRow; label: string; indent?: boolean; onOpen: (id: string) => void }) {
  const costed = r.flag !== 'grey';
  const range = r.minCostCents !== r.maxCostCents ? `From ${formatCents(r.minCostCents)} to ${formatCents(r.maxCostCents)}, by what the customer picks` : undefined;
  return (
    <tr
      className={cn(
        'cursor-pointer border-t border-stone-100 hover:bg-amber-50/60 dark:border-stone-800 dark:hover:bg-stone-800/60',
        !r.isActive && 'text-stone-400',
      )}
      onClick={() => onOpen(r.menuItemId)}
    >
      <td className={cn('py-2', indent && 'pl-5')}>
        <button type="button" className="text-left font-medium hover:underline" onClick={(e) => { e.stopPropagation(); onOpen(r.menuItemId); }}>
          {label}
        </button>
        {!indent && <span className="ml-2 text-xs text-stone-500">{r.categoryName}</span>}
        {!r.isActive && (
          <span className="ml-2 rounded bg-stone-200 px-1.5 py-0.5 text-[11px] font-medium text-stone-600 dark:bg-stone-700 dark:text-stone-300">
            off the menu
          </span>
        )}
        {r.estimateLines > 0 && costed && (
          <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-900 dark:bg-amber-950 dark:text-amber-200" title="A price in it is a guess">
            includes a guess
          </span>
        )}
      </td>
      <td className="py-2 text-right font-mono" title={r.priceCents !== r.basePriceCents ? `Menu price ${formatCents(r.basePriceCents)} plus the usual paid picks` : undefined}>
        {formatCents(r.priceCents)}
      </td>
      <td className="py-2 text-right font-mono" title={range}>
        {costed ? formatCents(r.costCents) : <span className="text-stone-400">{r.hasRecipe ? 'price missing' : 'no recipe'}</span>}
      </td>
      <td className="py-2 text-center">
        <FoodCostChip flag={r.flag} bps={r.foodCostBps} targetBps={r.targetBps} />
      </td>
      <td className="py-2 text-right font-mono">{costed ? formatCents(r.profitCents) : '—'}</td>
    </tr>
  );
}
