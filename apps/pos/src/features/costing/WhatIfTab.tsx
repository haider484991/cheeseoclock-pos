/**
 * Costing → What-if (costing spec 4.9, Phase 9; profit.view): try a new
 * price for an ingredient (cheese, chicken…) or a new menu price, and see
 * what it does to every dish and per week at the last 4 weeks' sales. An
 * ingredient's price flows through everything made from it (the Cheese Mix,
 * the sauce). "Fix all reds" tries, for every dish over its target, the price
 * that brings it back. NOTHING is saved and no price on the till changes:
 * the answer prints as a "price change list" for whoever keeps the costing
 * sheet, the printed menu and the website.
 *
 * The prices being tried are kept for the rest of this login (session
 * memory, per login), so a look at Menu costs, another dish's "Try a
 * price" or Targets & fees adds to the list instead of starting it again.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import type { Ingredient, WhatIfRequest, WhatIfRow } from '@cheeseoclock/shared-types';
import { FileSpreadsheet, Loader2, Plus, Printer, Sparkles, Trash2 } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useOneShotLink, useSessionState } from '../../components/list';
import { useSessionStore } from '../../stores/sessionStore';
import { downloadText } from '../reports/exporters';
import { breakEvenText, perWeekUnits, weekText } from '../reports/profitFormat';
import { initialPriceEntry, perChoices, perLabel, readPriceEntry, rupeesInput, type PriceEntry } from '../inventory/price-view';
import { COSTING_KEY, useMenuCosts } from './costingQueries';
import { FoodCostChip } from './CostChip';
import { formatUnitPrice, parseRupees } from './costingFormat';
import { buildPriceChangeCsv, buildPriceChangePrint, fixAllReds, priceChangeListReady } from './whatIfFormat';
import { usePrintSheet } from './usePrintSheet';

/** "Try a price" on an item cost sheet opens What-if with that dish (a one-shot link). */
export const WHAT_IF_TRY = 'costing.whatif.try';

/** Where this login's tries are kept between visits to the tab (session memory): the ingredients' and the menu prices'. */
export function whatIfTriesKeys(userId: string): { ingredients: string; prices: string } {
  return { ingredients: `costing.whatif.tries.ingredients.${userId}`, prices: `costing.whatif.tries.prices.${userId}` };
}

export interface IngredientTry {
  ingredientId: string;
  entry: PriceEntry;
}

/** Wait until typing stops before asking the till again. */
function useSettled<T>(value: T, ms = 350): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function WhatIfTab() {
  const tryLink = useOneShotLink<{ menuItemId: string }>(WHAT_IF_TRY);
  const menu = useMenuCosts();
  const ingredientsQ = useQuery({ queryKey: [...COSTING_KEY, 'whatIf', 'ingredients'], queryFn: () => ipc.inventory.listIngredients(), staleTime: 60_000 });
  const ingredients = useMemo(() => [...(ingredientsQ.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [ingredientsQ.data]);
  const byId = useMemo(() => new Map<string, Ingredient>(ingredients.map((i) => [i.id as string, i])), [ingredients]);
  const dishes = useMemo(() => (menu.data?.rows ?? []).filter((r) => r.flag !== 'nonfood').sort((a, b) => a.name.localeCompare(b.name)), [menu.data]);
  const dishById = useMemo(() => new Map(dishes.map((d) => [d.menuItemId, d])), [dishes]);

  // Kept for the rest of this login: leaving the tab (or another dish's "Try a price") adds to them.
  const signedIn = useSessionStore((s) => s.user?.id);
  // (The store's server snapshot, in a static render, is its first state: read the live one then.)
  const keys = whatIfTriesKeys(signedIn ?? useSessionStore.getState().user?.id ?? 'nobody');
  const [ingTries, setIngTries] = useSessionState<IngredientTry[]>(keys.ingredients, []);
  // Menu prices tried, as typed (rupees).
  const [priceTries, setPriceTries] = useSessionState<Record<string, string>>(keys.prices, {});
  const [showAll, setShowAll] = useState(false);
  const printer = usePrintSheet();

  // "Try a price" from a cost sheet: that dish, at its price now, ready to change.
  useEffect(() => {
    if (!tryLink) return;
    const d = dishById.get(tryLink.menuItemId);
    if (!d) return;
    setPriceTries((t) => (tryLink.menuItemId in t ? t : { ...t, [tryLink.menuItemId]: rupeesInput(d.basePriceCents) }));
  }, [tryLink, dishById, setPriceTries]);

  const readings = ingTries.map((t) => {
    const ing = byId.get(t.ingredientId);
    return { t, ing, reading: ing ? readPriceEntry(t.entry, ing.unit) : null };
  });
  const req: WhatIfRequest = {
    ingredients: readings.flatMap(({ t, reading }) =>
      reading && reading.ok && !reading.free ? [{ ingredientId: t.ingredientId, packSize: reading.pack.size, packPriceCents: reading.pack.priceCents }] : [],
    ),
    items: Object.entries(priceTries).flatMap(([menuItemId, text]) => {
      const cents = parseRupees(text);
      return cents === null ? [] : [{ menuItemId, priceCents: cents }];
    }),
  };
  const settled = useSettled(JSON.stringify(req));
  const q = useQuery({
    queryKey: [...COSTING_KEY, 'whatIf', settled],
    queryFn: () => ipc.costing.whatIf(JSON.parse(settled) as WhatIfRequest),
    placeholderData: (prev) => prev,
    staleTime: 30_000,
    retry: false,
  });
  const result = q.data;
  const tried = req.ingredients.length > 0 || req.items.length > 0;
  const rows = result ? (showAll ? result.rows : result.rows.filter((r) => r.changed)) : [];
  const reds = result ? fixAllReds(result.rows) : {};
  const redCount = Object.keys(reds).length;
  // Anything tried prints — a new cheese price alone too (the ingredient prices, and the dishes whose cost moves).
  const listReady = tried && !!result && priceChangeListReady(result);

  const addIngredient = (id: string) => {
    const ing = byId.get(id);
    if (!ing || ingTries.some((t) => t.ingredientId === id)) return;
    setIngTries((ts) => [...ts, { ingredientId: id, entry: { ...initialPriceEntry(ing), guess: false, free: false } }]);
  };
  const addDish = (id: string) => {
    const d = dishById.get(id);
    if (!d || id in priceTries) return;
    setPriceTries((t) => ({ ...t, [id]: rupeesInput(d.basePriceCents) }));
  };

  const selectCls = 'h-10 rounded-lg border border-stone-300 bg-white px-2 text-sm dark:border-stone-700 dark:bg-stone-800';
  const inputCls = 'w-28 rounded-lg border border-stone-300 px-2 py-1.5 text-right font-mono dark:border-stone-700 dark:bg-stone-800';

  return (
    <div className="space-y-4">
      <Card className="border border-amber-200 bg-amber-50/60 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
        Try prices here and see what they do per week. <b>Nothing is saved, and no price on the till changes.</b> The price change list is
        for whoever keeps the costing sheet, the printed menu and the website.
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mb-1 font-semibold">An ingredient&apos;s price</h2>
          <p className="mb-3 text-sm text-stone-500">Everything made from it moves too (the Cheese Mix, the sauce).</p>
          <select className={cn(selectCls, 'w-full')} value="" onChange={(e) => addIngredient(e.target.value)} aria-label="Add an ingredient to try">
            <option value="">Add an ingredient…</option>
            {ingredients
              .filter((i) => !ingTries.some((t) => t.ingredientId === i.id))
              .map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
          </select>
          <ul className="mt-3 space-y-3">
            {readings.map(({ t, ing, reading }) =>
              ing ? (
                <IngredientTryRow
                  key={t.ingredientId}
                  ing={ing}
                  entry={t.entry}
                  problem={reading && !reading.ok && !reading.empty ? reading.problem : null}
                  onChange={(entry) => setIngTries((ts) => ts.map((x) => (x.ingredientId === t.ingredientId ? { ...x, entry } : x)))}
                  onRemove={() => setIngTries((ts) => ts.filter((x) => x.ingredientId !== t.ingredientId))}
                />
              ) : null,
            )}
          </ul>
        </Card>

        <Card>
          <h2 className="mb-1 font-semibold">A menu price</h2>
          <p className="mb-3 text-sm text-stone-500">The dish&apos;s own price before tax, as on the menu.</p>
          <select className={cn(selectCls, 'w-full')} value="" onChange={(e) => addDish(e.target.value)} aria-label="Add a dish to try">
            <option value="">Add a dish…</option>
            {dishes
              .filter((d) => !(d.menuItemId in priceTries))
              .map((d) => (
                <option key={d.menuItemId} value={d.menuItemId}>
                  {d.name}
                </option>
              ))}
          </select>
          <ul className="mt-3 space-y-2">
            {Object.entries(priceTries).map(([id, text]) => {
              const d = dishById.get(id);
              if (!d) return null;
              const bad = parseRupees(text) === null;
              return (
                <li key={id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate font-medium">{d.name}</span>
                  <span className="text-stone-500">now {formatCents(d.basePriceCents)} →</span>
                  <label className="flex items-center gap-1">
                    Rs
                    <input
                      className={cn(inputCls, bad && 'border-red-400')}
                      inputMode="decimal"
                      value={text}
                      aria-label={`New price for ${d.name}`}
                      onChange={(e) => setPriceTries((t) => ({ ...t, [id]: e.target.value }))}
                    />
                  </label>
                  <button
                    type="button"
                    aria-label={`Stop trying a price for ${d.name}`}
                    onClick={() =>
                      setPriceTries((t) => {
                        const next = { ...t };
                        delete next[id];
                        return next;
                      })
                    }
                    className="rounded-lg p-1.5 text-stone-400 hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-stone-800"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>

      <Card>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 font-semibold">
              What it does {q.isFetching && <Loader2 className="h-4 w-4 animate-spin text-stone-400" aria-label="Working it out" />}
            </h2>
            {result && (
              <p className={cn('text-lg font-semibold', result.totalWeekCents < 0 && 'text-rose-700 dark:text-rose-400', result.totalWeekCents > 0 && 'text-emerald-700 dark:text-emerald-400')}>
                {tried ? `${weekText(result.totalWeekCents)} across the menu, at the same sales` : 'Add a price above to try it.'}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={!result || redCount === 0}
              onClick={() => setPriceTries((t) => ({ ...t, ...Object.fromEntries(Object.entries(reds).map(([id, c]) => [id, rupeesInput(c)])) }))}
              title="Try, for every dish over its target, the price that brings it back"
            >
              <Sparkles className="h-4 w-4" /> Fix all reds{redCount > 0 ? ` (${redCount})` : ''}
            </Button>
            <Button variant="secondary" size="sm" disabled={!listReady} onClick={() => result && printer.print(buildPriceChangePrint(result))}>
              <Printer className="h-4 w-4" /> Print the price change list
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={!listReady}
              onClick={() => result && downloadText(`price-change-list-${new Date().toISOString().slice(0, 10)}.csv`, buildPriceChangeCsv(result))}
            >
              <FileSpreadsheet className="h-4 w-4" /> Download for Excel
            </Button>
            {tried && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setIngTries([]);
                  setPriceTries({});
                }}
              >
                <Trash2 className="h-4 w-4" /> Start again
              </Button>
            )}
          </div>
        </div>
        {!tried && <p className="mb-2 text-xs text-stone-500">Try an ingredient&apos;s price or a menu price above to print the price change list.</p>}
        {q.isError && <p className="text-sm text-red-700">{q.error instanceof Error ? q.error.message : 'It could not be worked out.'}</p>}
        {result && result.ingredients.some((i) => i.batch) && (
          <p className="mb-2 text-sm text-stone-600 dark:text-stone-300">
            Made here and moving with it:{' '}
            {result.ingredients
              .filter((i) => i.batch)
              .map((i) => `${i.name} ${i.beforeUnitCostMc === null ? '' : formatUnitPrice(i.beforeUnitCostMc, i.unit)} → ${i.afterUnitCostMc === null ? 'no price' : formatUnitPrice(i.afterUnitCostMc, i.unit)}`)
              .join(', ')}
          </p>
        )}
        {result && <ResultTable rows={rows} />}
        {result && (
          <label className="mt-2 flex items-center gap-2 text-sm text-stone-600 dark:text-stone-300">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show every dish, not only the ones that move
          </label>
        )}
        <p className="mt-2 text-xs text-stone-500">
          Per week = what one sale earns after, less before, × the dish&apos;s average week of the last 4. Costs at the customers&apos; usual picks.
          Menu prices before tax. This till&apos;s sales.
        </p>
      </Card>
      {printer.portal}
    </div>
  );
}

function IngredientTryRow({
  ing,
  entry,
  problem,
  onChange,
  onRemove,
}: {
  ing: Ingredient;
  entry: PriceEntry;
  problem: string | null;
  onChange: (e: PriceEntry) => void;
  onRemove: () => void;
}) {
  const now = ing.priceKind === 'unset' ? 'no price yet' : formatUnitPrice(Math.round(((ing.packPriceCents ?? ing.costPerUnitCents) * 1000) / (ing.packSize ?? 1)), ing.unit);
  return (
    <li className="rounded-lg border border-stone-200 p-2 text-sm dark:border-stone-700">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{ing.name}</span>
        <span className="text-xs text-stone-500">now {now}</span>
        <button type="button" aria-label={`Stop trying ${ing.name}`} onClick={onRemove} className="rounded-lg p-1.5 text-stone-400 hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-stone-800">
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1">
          Rs
          <input
            className="w-24 rounded-lg border border-stone-300 px-2 py-1 text-right font-mono dark:border-stone-700 dark:bg-stone-800"
            inputMode="decimal"
            value={entry.rupees}
            aria-label={`Price to try for ${ing.name}`}
            onChange={(e) => onChange({ ...entry, rupees: e.target.value })}
          />
        </label>
        <select
          className="h-8 rounded-lg border border-stone-300 bg-white px-1 text-sm dark:border-stone-700 dark:bg-stone-800"
          value={entry.per}
          aria-label="How it is bought"
          onChange={(e) => onChange({ ...entry, per: e.target.value as PriceEntry['per'] })}
        >
          {perChoices(ing.unit).map((p) => (
            <option key={p} value={p}>
              {perLabel(p, ing.unit)}
            </option>
          ))}
        </select>
        {entry.per === 'pack' && (
          <label className="flex items-center gap-1 text-xs">
            of
            <input
              className="w-20 rounded-lg border border-stone-300 px-2 py-1 text-right font-mono dark:border-stone-700 dark:bg-stone-800"
              inputMode="numeric"
              value={entry.packSize}
              aria-label={`Pack size for ${ing.name}`}
              onChange={(e) => onChange({ ...entry, packSize: e.target.value })}
            />
            {ing.unit}
          </label>
        )}
      </div>
      {problem && <p className="mt-1 text-xs text-red-700 dark:text-red-400">{problem}</p>}
    </li>
  );
}

function ResultTable({ rows }: { rows: WhatIfRow[] }) {
  if (rows.length === 0) return <p className="py-3 text-center text-sm text-stone-500">Nothing moves yet.</p>;
  const cell = 'px-1 py-1.5 text-right tabular-nums whitespace-nowrap';
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-[11px] uppercase tracking-wider text-stone-500">
          <tr>
            <th className="px-1 pb-2">Dish</th>
            <th className="px-1 pb-2 text-right">Price</th>
            <th className="px-1 pb-2 text-right">Cost to make</th>
            <th className="px-1 pb-2 text-right">Food cost</th>
            <th className="px-1 pb-2 text-right">Earns a sale</th>
            <th className="px-1 pb-2 text-right">Sells</th>
            <th className="px-1 pb-2 text-right">Per week</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.menuItemId} className="border-t border-stone-100 align-top dark:border-stone-800">
              <td className="px-1 py-1.5">
                <div className="font-medium">{r.name}</div>
                <div className="text-xs text-stone-500">{r.categoryName}</div>
                {r.breakEvenBps !== null || r.newPriceCents !== r.priceCents ? (
                  <div className="text-xs text-stone-500">{breakEvenText(r.breakEvenBps)}</div>
                ) : null}
              </td>
              <td className={cell}>
                {r.newPriceCents !== r.priceCents ? (
                  <>
                    <span className="text-stone-400 line-through">{formatCents(r.priceCents)}</span> {formatCents(r.newPriceCents)}
                  </>
                ) : (
                  formatCents(r.priceCents)
                )}
              </td>
              <td className={cell}>
                {r.newCostCents !== r.costCents ? `${formatCents(r.costCents)} → ${formatCents(r.newCostCents)}` : formatCents(r.costCents)}
              </td>
              <td className={cell}>
                <span className="inline-flex items-center gap-1">
                  <FoodCostChip flag={r.flag} bps={r.foodCostBps} targetBps={r.targetBps} />
                  {(r.newFlag !== r.flag || r.newFoodCostBps !== r.foodCostBps) && (
                    <>
                      → <FoodCostChip flag={r.newFlag} bps={r.newFoodCostBps} targetBps={r.targetBps} />
                    </>
                  )}
                </span>
              </td>
              <td className={cell}>
                {r.newProfitCents !== r.profitCents ? `${formatCents(r.profitCents)} → ${formatCents(r.newProfitCents)}` : formatCents(r.profitCents)}
              </td>
              <td className={cell}>{perWeekUnits(r.weeklyUnitsTenths)}</td>
              <td className={cn(cell, 'font-semibold', r.weekCents < 0 && 'text-rose-700 dark:text-rose-400', r.weekCents > 0 && 'text-emerald-700 dark:text-emerald-400')}>
                {weekText(r.weekCents)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A button on the cost sheet: "Try a price" opens What-if with that dish (profit.view). */
export function TryAPriceButton({ menuItemId, onTry }: { menuItemId: string; onTry: (menuItemId: string) => void }) {
  return (
    <Button variant="secondary" size="sm" onClick={() => onTry(menuItemId)}>
      <Plus className="h-4 w-4" /> Try a price
    </Button>
  );
}
