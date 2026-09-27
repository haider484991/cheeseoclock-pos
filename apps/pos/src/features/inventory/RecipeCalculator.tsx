import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { keepPreviousData, useMutation, useQueries, useQuery } from '@tanstack/react-query';
import { Button, Card, cn } from '@cheeseoclock/ui';
import {
  batchesText,
  formatCents,
  kitchenQty,
  LEAVE_OUTS_NOTE,
  maxBatchAmount,
  packsText,
  packsToBuy,
  prepListDocument,
  prepListText,
} from '@cheeseoclock/pos-domain';
import type {
  CostedRecipeCalc,
  Ingredient,
  RecipeCalc,
  RecipeCalcBatchRow,
  RecipeCalcCosts,
  RecipeCalcLineView,
  RecipeCalcQtyRow,
  RecipeCalcTree,
  TypicalPicksView,
} from '@cheeseoclock/shared-types';
import {
  AlertTriangle,
  Calculator,
  ChefHat,
  ChevronDown,
  ChevronRight,
  Copy,
  Minus,
  Plus,
  Printer,
  Search,
  Soup,
  X,
} from 'lucide-react';
import { ipc, IpcError } from '../../ipc/client';
import { useDebouncedValue, useSessionState } from '../../components/list';
import { useToast } from '../../components/toast/ToastProvider';
import { useSessionStore } from '../../stores/sessionStore';
import { useCanSeeCosts } from '../costing/costingQueries';
import { atLeast, noPriceText, thousandUnit } from '../costing/costingFormat';
import { BatchCalculatorDialog } from './BatchCalculator';
import { BatchCalculatorButton } from './BatchPicker';
import {
  CALC_LINES_KEY,
  CALC_RECENT_KEY,
  RECIPE_CALC_KEY,
  batchLine,
  calcRequest,
  calcSearch,
  countedGroups,
  effectivePortions,
  hasLeaveOuts,
  itemLine,
  lacksLines,
  makeAmounts,
  readCount,
  readLine,
  shortFirst,
  usualPicks,
  whenText,
  withRecent,
  type CalcHit,
  type BatchCalcLine,
  type CalcLine,
  type ItemCalcLine,
  type LineReading,
  type RecentPick,
} from './recipeCalcView';

const n = (x: number) => new Intl.NumberFormat('en-PK').format(x);

/** The query key of an answer: quantities, or quantities with costs, for exactly this request. */
export function recipeCalcQueryKey(costed: boolean, request: string | null) {
  return [...RECIPE_CALC_KEY, costed ? 'costed' : 'qty', request] as const;
}

/** The query key of an item's choices and usual picks. */
export function typicalPicksKey(menuItemId: string) {
  return ['inventory', 'calc', 'picks', menuItemId] as const;
}

/**
 * Inventory → Recipe calculator (owner, 2026-09-27: "just need how many
 * pizzas, then it will show the exact batch amount based on the selected
 * recipe"). Pick what you are making — a pizza (each size its own recipe), a
 * burger, a deal, a dip, or a sauce by the gram — say how many, and see at
 * once: the batches to make first (each once, in order, with "Make /
 * calculate" at that amount), what comes straight from stock, and every
 * ingredient from scratch, with this till's stock and what is short. With
 * costs (managers and the owner today), what it all costs.
 *
 * It writes nothing: stock only moves through the batch calculator's Make.
 */
export function RecipeCalculatorTab() {
  const canCost = useCanSeeCosts();
  const user = useSessionStore((s) => s.user);
  const { toast } = useToast();
  const [lines, setLines] = useSessionState<CalcLine[]>(CALC_LINES_KEY, []);
  const [recent, setRecent] = useSessionState<RecentPick[]>(CALC_RECENT_KEY, []);
  const [adding, setAdding] = useState(false);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [making, setMaking] = useState<{ ingredientId: string; amount: number } | null>(null);

  const itemsQ = useQuery({ queryKey: ['menu', 'items', 'all'], queryFn: () => ipc.menu.listItems() });
  const catsQ = useQuery({ queryKey: ['menu', 'categories', 'all'], queryFn: () => ipc.menu.listCategories() });
  const ingredientsQ = useQuery({ queryKey: ['inventory', 'ingredients', 'all'], queryFn: () => ipc.inventory.listIngredients() });
  const batches = useMemo(() => (ingredientsQ.data ?? []).filter((i) => i.batchYield !== null), [ingredientsQ.data]);

  const itemIds = [...new Set(lines.flatMap((l) => (l.kind === 'item' ? [l.menuItemId] : [])))];
  const picksQs = useQueries({
    queries: itemIds.map((id) => ({ queryKey: typicalPicksKey(id), queryFn: () => ipc.inventory.typicalPicks(id), staleTime: 60_000 })),
  });
  const picksOf = new Map<string, TypicalPicksView>();
  itemIds.forEach((id, i) => {
    const d = picksQs[i]?.data;
    if (d) picksOf.set(id, d);
  });
  const picksError = new Map<string, string>();
  itemIds.forEach((id, i) => {
    const e = picksQs[i]?.error;
    if (e) picksError.set(id, e instanceof IpcError ? e.message : String(e));
  });

  /** A line as a request — or why not (an item whose choices could not be read is not waited for). */
  const readingOf = (l: CalcLine): LineReading => {
    const err = l.kind === 'item' ? picksError.get(l.menuItemId) : undefined;
    return err ? { ok: false, waiting: false, problem: err } : readLine(l, l.kind === 'item' ? picksOf.get(l.menuItemId) : undefined);
  };
  const shownLines = focusKey && lines.some((l) => l.key === focusKey) ? lines.filter((l) => l.key === focusKey) : lines;
  const readings = shownLines.map(readingOf);
  const request = calcRequest(readings);
  /** The lines the request holds, in its order (a line that cannot be read yet is left out). */
  const askedKeys = shownLines.filter((_, i) => readings[i]!.ok).map((l) => l.key);
  const requestText = request ? JSON.stringify(request) : null;
  const asked = useDebouncedValue(requestText, 250);

  const costQ = useQuery({
    queryKey: recipeCalcQueryKey(true, asked),
    queryFn: () => ipc.costing.recipeCalc(JSON.parse(asked!)),
    enabled: canCost && asked !== null,
    staleTime: 0,
    placeholderData: keepPreviousData,
  });
  // Costs that cannot be worked out: the quantities alone, as for a login without costs.
  const costed = canCost && !(costQ.isError && !costQ.isFetching);
  const qtyQ = useQuery({
    queryKey: recipeCalcQueryKey(false, asked),
    queryFn: () => ipc.inventory.recipeCalc(JSON.parse(asked!)),
    enabled: !costed && asked !== null,
    staleTime: 0,
    placeholderData: keepPreviousData,
  });
  const q = costed ? costQ : qtyQ;
  const calc: RecipeCalc | CostedRecipeCalc | null = requestText ? (q.data ?? null) : null;
  const fresh = calc !== null && asked === requestText && !q.isPlaceholderData;
  const costs: RecipeCalcCosts | null = costed && calc && 'costs' in calc ? (calc as CostedRecipeCalc).costs : null;
  const failed = asked === requestText && q.isError && !q.isFetching ? (q.error instanceof IpcError ? q.error.message : String(q.error)) : null;

  const print = useMutation({
    mutationFn: () => ipc.inventory.printPrepList(JSON.parse(asked!)),
    onSuccess: (r) =>
      r.ok
        ? toast({ title: 'Prep list printed', variant: 'success' })
        : toast({
            title: 'The prep list did not print',
            description: `${r.error?.message ?? 'The receipt printer did not answer.'} Check the receipt printer, then press Print again.`,
            variant: 'error',
          }),
    onError: (e) => toast({ title: 'The prep list did not print', description: e instanceof IpcError ? e.message : String(e), variant: 'error' }),
  });

  const copy = async () => {
    if (!calc) return;
    const text = prepListText(prepListDocument(calc, { when: whenText(new Date()), by: user?.fullName ?? null }), null);
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: 'Copied: paste it into a message', variant: 'success' });
    } catch {
      toast({ title: 'Could not copy', description: 'Print it instead, or try again.', variant: 'error' });
    }
  };

  const setLine = (key: string, next: CalcLine) => setLines((ls) => ls.map((l) => (l.key === key ? next : l)));
  const removeLine = (key: string) => {
    setLines((ls) => ls.filter((l) => l.key !== key));
    if (focusKey === key) setFocusKey(null);
  };
  const pick = (hit: CalcLine, r: RecentPick) => {
    setLines((ls) => [...ls, hit]);
    setRecent((rs) => withRecent(rs, r));
    setAdding(false);
    setFocusKey(null);
  };
  const ingredientOf = (id: string) => ingredientsQ.data?.find((i) => i.id === id) ?? null;
  const makingIngredient = making ? ingredientOf(making.ingredientId) : null;

  const picking = lines.length === 0 || adding;

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-2 text-xl font-bold">
              <Calculator className="h-5 w-5 text-amber-600" /> Recipe calculator
            </h2>
            <p className="max-w-2xl text-sm text-stone-600 dark:text-stone-400">
              How much of everything for 10 pizzas, 20 burgers or 2 kg of sauce: the batches to make first, what comes
              straight from stock, and what is short on this till.
            </p>
          </div>
          {/* With something being worked out, it sits with the other buttons below the answer. */}
          {lines.length === 0 && <BatchCalculatorButton variant="secondary" />}
        </div>

        {lines.length > 0 && (
          <div className="mt-4 space-y-3">
            {lines.map((l) => (
              <LineCard
                key={l.key}
                line={l}
                picks={l.kind === 'item' ? picksOf.get(l.menuItemId) : undefined}
                batch={l.kind === 'batch' ? ingredientOf(l.ingredientId) : null}
                reading={readingOf(l)}
                view={calc && fresh ? viewOf(calc, askedKeys, l.key) : null}
                multi={lines.length > 1}
                last={l.key === lines[lines.length - 1]?.key}
                focused={focusKey === l.key}
                onFocus={() => setFocusKey(focusKey === l.key ? null : l.key)}
                onChange={(next) => setLine(l.key, next)}
                onRemove={() => removeLine(l.key)}
              />
            ))}
          </div>
        )}

        {picking && (
          <RecipePicker
            items={itemsQ.data ?? []}
            categories={catsQ.data ?? []}
            batches={batches}
            recent={recent}
            loading={itemsQ.isLoading}
            onPick={pick}
            onCancel={lines.length > 0 ? () => setAdding(false) : undefined}
          />
        )}
      </Card>

      {lines.length > 0 && (
        <Card>
          {focusKey && lines.length > 1 && (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-stone-100 px-3 py-2 text-sm dark:bg-stone-800">
              Showing only one recipe.
              <button type="button" className="font-semibold text-amber-700 underline dark:text-amber-300" onClick={() => setFocusKey(null)}>
                Show all together
              </button>
            </div>
          )}
          {failed && (
            <p className="mb-3 flex items-start gap-1.5 text-sm text-red-700 dark:text-red-400">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" /> {failed}
            </p>
          )}
          {calc ? (
            <div className={cn('transition-opacity', !fresh && 'opacity-50')} aria-busy={!fresh}>
              <CalcResult calc={calc} costs={costs} onMake={(ingredientId, amount) => setMaking({ ingredientId, amount })} canMake={!!ingredientsQ.data} />
            </div>
          ) : (
            !failed && <div className="py-6 text-center text-sm text-stone-500">{request || readings.some((r) => !r.ok && r.waiting) ? 'Working it out…' : 'Say how many to see what it takes.'}</div>
          )}
          <footer className="mt-4 flex flex-wrap items-center gap-2 border-t border-stone-200 pt-4 dark:border-stone-800">
            <Button variant="primary" size="sm" disabled={!fresh || print.isPending} onClick={() => print.mutate()}>
              <Printer className="h-4 w-4" /> {print.isPending ? 'Printing…' : 'Print prep list'}
            </Button>
            <Button variant="secondary" size="sm" disabled={!fresh} onClick={() => void copy()}>
              <Copy className="h-4 w-4" /> Copy as text
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setAdding(true)} disabled={picking}>
              <Plus className="h-4 w-4" /> Add another recipe
            </Button>
            <BatchCalculatorButton variant="secondary" />
            <button
              type="button"
              className="ml-auto text-sm text-stone-500 underline hover:text-stone-800 dark:hover:text-stone-200"
              onClick={() => {
                setLines([]);
                setFocusKey(null);
              }}
            >
              Start again
            </button>
          </footer>
        </Card>
      )}

      {making && makingIngredient && (
        <BatchCalculatorDialog
          key={`${making.ingredientId}:${making.amount}`}
          ingredient={makingIngredient}
          initialAmount={making.amount}
          onClose={() => setMaking(null)}
        />
      )}
    </div>
  );
}

/** The answer's view of one line (its warnings), when the answer is for these lines. */
function viewOf(calc: RecipeCalc, askedKeys: readonly string[], key: string): RecipeCalcLineView | null {
  const i = askedKeys.indexOf(key);
  return i >= 0 && calc.lines.length === askedKeys.length ? (calc.lines[i] ?? null) : null;
}

// ------------------------------------------------------------- the picker --

function RecipePicker({
  items,
  categories,
  batches,
  recent,
  loading,
  onPick,
  onCancel,
}: {
  items: Parameters<typeof calcSearch>[0];
  categories: Parameters<typeof calcSearch>[1];
  batches: Ingredient[];
  recent: RecentPick[];
  loading: boolean;
  onPick: (line: CalcLine, recent: RecentPick) => void;
  onCancel?: () => void;
}) {
  const [query, setQuery] = useState('');
  const hits = calcSearch(items, categories, batches, query);
  const pickItem = (item: { id: string; name: string }) => onPick(itemLine(item), { kind: 'item', id: item.id, name: item.name });
  const pickBatch = (b: Ingredient) => onPick(batchLine(b), { kind: 'batch', id: b.id, name: b.name });
  const fromRecent = (r: RecentPick) => {
    if (r.kind === 'item') {
      const item = items.find((i) => i.id === r.id);
      if (item) pickItem(item);
    } else {
      const b = batches.find((i) => i.id === r.id);
      if (b) pickBatch(b);
    }
  };
  return (
    <div className="mt-4 space-y-3">
      <label className="block">
        <span className="mb-1 block text-sm font-semibold">What are you making?</span>
        <span className="relative block">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-stone-400" />
          <input
            type="search"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && onCancel?.()}
            placeholder="Fajita pizza, zinger burger, ranch dip, pizza sauce…"
            aria-label="What are you making?"
            className="h-14 w-full rounded-xl border border-stone-300 bg-white pl-12 pr-4 text-lg dark:border-stone-700 dark:bg-stone-800"
          />
        </span>
      </label>
      {query.trim() === '' && recent.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-stone-500">Lately:</span>
          {recent.map((r) => (
            <button
              key={`${r.kind}:${r.id}`}
              type="button"
              onClick={() => fromRecent(r)}
              className="h-9 rounded-full bg-stone-100 px-3 font-medium text-stone-700 hover:bg-stone-200 dark:bg-stone-800 dark:text-stone-200"
            >
              {r.name}
            </button>
          ))}
        </div>
      )}
      {query.trim() !== '' && (
        <ul className="divide-y divide-stone-100 rounded-xl border border-stone-200 dark:divide-stone-800 dark:border-stone-800">
          {hits.map((h) => (
            <HitRow key={h.key} hit={h} onItem={pickItem} onBatch={pickBatch} />
          ))}
          {hits.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-stone-500">{loading ? 'Loading the menu…' : 'Nothing on the menu or in the batch recipes matches.'}</li>
          )}
        </ul>
      )}
      {onCancel && (
        <button type="button" onClick={onCancel} className="text-sm text-stone-500 underline">
          Cancel
        </button>
      )}
    </div>
  );
}

function HitRow({ hit, onItem, onBatch }: { hit: CalcHit; onItem: (item: { id: string; name: string }) => void; onBatch: (b: Ingredient) => void }) {
  if (hit.kind === 'batch') {
    const b = hit.ingredient;
    return (
      <li>
        <button type="button" onClick={() => onBatch(b)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-amber-50 dark:hover:bg-amber-950/30">
          <Soup className="h-5 w-5 flex-none text-amber-600" />
          <span className="min-w-0 flex-1">
            <span className="block font-semibold">{b.name}</span>
            <span className="block text-xs text-stone-500">
              batch · one batch makes {b.batchYield ? kitchenQty(b.batchYield, b.unit) : '?'} · {kitchenQty(b.currentQty, b.unit)} in stock here
            </span>
          </span>
        </button>
      </li>
    );
  }
  const single = hit.sizes.length === 1 && hit.sizes[0]!.label === null;
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <span className="min-w-0 flex-1">
        {single ? (
          <button type="button" onClick={() => onItem(hit.sizes[0]!.item)} className="text-left font-semibold hover:underline">
            {hit.base}
          </button>
        ) : (
          <span className="font-semibold">{hit.base}</span>
        )}
        <span className="block text-xs text-stone-500">{hit.categoryName}</span>
      </span>
      <span className="flex flex-wrap gap-1.5">
        {hit.sizes.map((s) => (
          <Button key={s.item.id} variant={single ? 'primary' : 'secondary'} size="sm" onClick={() => onItem(s.item)}>
            {s.label ?? 'Choose'}
            {!s.item.isActive && <span className="ml-1 text-[10px] font-normal opacity-70">(off the menu)</span>}
          </Button>
        ))}
      </span>
    </li>
  );
}

// -------------------------------------------------------------- the lines --

const QUICK_COUNTS = [5, 10, 20, 50];

function LineCard({
  line,
  picks,
  batch,
  reading,
  view,
  multi,
  last,
  focused,
  onFocus,
  onChange,
  onRemove,
}: {
  line: CalcLine;
  picks: TypicalPicksView | undefined;
  batch: Ingredient | null;
  reading: LineReading;
  view: RecipeCalcLineView | null;
  multi: boolean;
  /** The newest line: its amount box takes the keyboard. */
  last: boolean;
  focused: boolean;
  onFocus: () => void;
  onChange: (next: CalcLine) => void;
  onRemove: () => void;
}) {
  return (
    <div className={cn('rounded-xl border p-4', focused ? 'border-amber-400 ring-2 ring-amber-200 dark:ring-amber-900' : 'border-stone-200 dark:border-stone-800')}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-lg font-bold">
            {line.kind === 'batch' && <Soup className="h-5 w-5 flex-none text-amber-600" />}
            {line.name}
          </div>
          {line.kind === 'batch' && batch?.batchYield && (
            <div className="text-xs text-stone-500">
              batch · one batch makes {kitchenQty(batch.batchYield, batch.unit)} · {kitchenQty(batch.currentQty, batch.unit)} in stock here
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          {multi && (
            <button type="button" onClick={onFocus} className="rounded px-2 py-1 text-xs font-semibold text-amber-700 hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-950/40">
              {focused ? 'Show all together' : 'Show only this'}
            </button>
          )}
          <button type="button" aria-label={`Remove ${line.name}`} onClick={onRemove} className="rounded p-2 text-stone-400 hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-stone-800">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {line.kind === 'item' ? (
        <ItemAmount line={line} focus={last} onChange={onChange} />
      ) : (
        <BatchAmount line={line} batch={batch} focus={last} onChange={onChange} />
      )}
      {!reading.ok && !reading.waiting && <p className="mt-1 text-sm text-red-700 dark:text-red-400">{reading.problem}</p>}

      {line.kind === 'item' && picks && <Choices line={line} picks={picks} onChange={onChange} />}

      {view && view.warnings.length > 0 && (
        <ul className="mt-2 space-y-1">
          {view.warnings.map((w) => (
            <li key={w} className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" /> {w}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ItemAmount({ line, focus, onChange }: { line: ItemCalcLine; focus: boolean; onChange: (next: CalcLine) => void }) {
  const bad = line.countText.trim() !== '' && readCount(line.countText) === null;
  return (
    <div className="mt-3 flex flex-wrap items-end gap-3">
      <label className="text-sm">
        <span className="mb-1 block text-xs uppercase tracking-wider text-stone-500">How many?</span>
        <input
          type="text"
          inputMode="numeric"
          autoFocus={focus}
          onFocus={(e) => e.currentTarget.select()}
          value={line.countText}
          onChange={(e) => onChange({ ...line, countText: e.target.value })}
          aria-invalid={bad}
          className={cn(
            'h-14 w-32 rounded-xl border px-3 text-right font-mono text-2xl font-bold dark:bg-stone-800',
            bad ? 'border-red-500' : 'border-stone-300 dark:border-stone-700',
          )}
        />
      </label>
      <div className="flex flex-wrap gap-1.5 pb-1">
        {QUICK_COUNTS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onChange({ ...line, countText: String(c) })}
            aria-pressed={readCount(line.countText) === c}
            className={cn(
              'h-11 min-w-[3rem] rounded-xl px-3 text-base font-semibold',
              readCount(line.countText) === c ? 'bg-stone-900 text-white dark:bg-amber-500 dark:text-stone-900' : 'bg-stone-100 text-stone-700 hover:bg-stone-200 dark:bg-stone-800 dark:text-stone-200',
            )}
          >
            {c}
          </button>
        ))}
      </div>
    </div>
  );
}

function BatchAmount({
  line,
  batch,
  focus,
  onChange,
}: {
  line: BatchCalcLine;
  batch: Ingredient | null;
  focus: boolean;
  onChange: (next: CalcLine) => void;
}) {
  const big = thousandUnit(line.unit);
  const y = batch?.batchYield ?? 0;
  const reading = readLine(line, undefined);
  const amount = reading.ok && reading.req.kind === 'batch' ? reading.req.amount : null;
  const quick = y > 0 ? [
    { label: '¼ batch', v: Math.round(y / 4) },
    { label: '½ batch', v: Math.round(y / 2) },
    { label: '1 batch', v: y },
    { label: '2 batches', v: y * 2 },
  ].filter((x) => x.v > 0) : [];
  return (
    <div className="mt-3 space-y-1">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="mb-1 block text-xs uppercase tracking-wider text-stone-500">How much?</span>
          <input
            type="text"
            inputMode="decimal"
            autoFocus={focus}
            onFocus={(e) => e.currentTarget.select()}
            value={line.text}
            onChange={(e) => onChange({ ...line, text: e.target.value })}
            aria-invalid={line.text.trim() !== '' && !reading.ok}
            className={cn(
              'h-14 w-40 rounded-xl border px-3 text-right font-mono text-2xl font-bold dark:bg-stone-800',
              line.text.trim() !== '' && !reading.ok ? 'border-red-500' : 'border-stone-300 dark:border-stone-700',
            )}
          />
        </label>
        {big ? (
          <div className="flex overflow-hidden rounded-xl ring-1 ring-stone-300 dark:ring-stone-700" role="group" aria-label="Unit">
            {[false, true].map((b) => (
              <button
                key={String(b)}
                type="button"
                aria-pressed={line.inBig === b}
                onClick={() => {
                  if (b === line.inBig) return;
                  onChange({ ...line, inBig: b, text: amount !== null ? String(b ? amount / 1000 : amount) : line.text });
                }}
                className={cn(
                  'h-14 px-4 text-sm font-semibold',
                  line.inBig === b ? 'bg-stone-900 text-white dark:bg-amber-500 dark:text-stone-900' : 'bg-white text-stone-600 dark:bg-stone-800 dark:text-stone-300',
                )}
              >
                {b ? big : line.unit}
              </button>
            ))}
          </div>
        ) : (
          <span className="pb-4 text-sm text-stone-500">{line.unit}</span>
        )}
        <div className="flex flex-wrap gap-1.5 pb-1">
          {quick.map((x) => (
            <button
              key={x.label}
              type="button"
              onClick={() => onChange({ ...line, inBig: false, text: String(x.v) })}
              className="h-11 rounded-xl bg-stone-100 px-3 text-sm font-semibold text-stone-700 hover:bg-stone-200 dark:bg-stone-800 dark:text-stone-200"
            >
              {x.label}
            </button>
          ))}
        </div>
      </div>
      {amount !== null && y > 0 && (
        <p className="text-sm text-stone-500">
          {kitchenQty(amount, line.unit)} = {batchesText(amount, y)}
          {amount > maxBatchAmount(y) ? ` — more than one go of 100 batches` : ''}.
        </p>
      )}
    </div>
  );
}

/**
 * The choices: one line saying what is counted (the till's usual picks, or
 * the ones set here), and "Change" to count them by hand — how many of the
 * N get each. Leave-outs are not offered: they only use less.
 */
function Choices({ line, picks, onChange }: { line: ItemCalcLine; picks: TypicalPicksView; onChange: (next: CalcLine) => void }) {
  const [open, setOpen] = useState(false);
  const groups = countedGroups(picks);
  const count = readCount(line.countText);
  if (groups.length === 0 || count === null) {
    return hasLeaveOuts(picks) && groups.length === 0 ? <p className="mt-2 text-xs text-stone-500">{LEAVE_OUTS_NOTE}</p> : null;
  }
  const usual = usualPicks(picks, count);
  const current = effectivePortions(line, picks, count);
  const optionName = new Map(groups.flatMap((g) => g.options.map((o) => [o.modifierId, o.name] as const)));
  const chosen = Object.entries(current).filter(([, c]) => c > 0);
  const listText = chosen.length > 0 ? chosen.map(([id, c]) => `${n(c)} × ${optionName.get(id) ?? '?'}`).join(', ') : 'none';
  const anyRequired = groups.some((g) => g.kind === 'required');
  const set = (id: string, v: number) => onChange({ ...line, portions: { ...current, [id]: Math.max(0, Math.min(count, v)) } });

  return (
    <div className="mt-3 rounded-lg bg-stone-50 p-3 text-sm dark:bg-stone-800/50">
      <p>
        {line.portions === null ? (
          !anyRequired ? (
            <>Extras and dips on the side (only when asked for): </>
          ) : usual.evenGroups.length > 0 ? (
            <>
              <b>Not enough sales yet</b> to go by ({usual.evenGroups.join(', ')}): spread evenly — change them to what you are making.{' '}
            </>
          ) : (
            <>
              Using the till&apos;s usual picks (last 28 days, {n(usual.sold)} sold):{' '}
            </>
          )
        ) : (
          <>Your picks: </>
        )}
        <span className="font-medium">{listText}</span>{' '}
        <button type="button" onClick={() => setOpen((o) => !o)} className="font-semibold text-amber-700 underline dark:text-amber-300">
          {open ? 'Done' : 'Change'}
        </button>
        {line.portions !== null && (
          <>
            {' · '}
            <button type="button" onClick={() => onChange({ ...line, portions: null })} className="font-semibold text-amber-700 underline dark:text-amber-300">
              Back to usual picks
            </button>
          </>
        )}
      </p>
      {open && (
        <div className="mt-3 space-y-3">
          {groups.map((g) => (
            <div key={g.groupId}>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-stone-500">
                {g.name}
                {g.kind === 'required' ? ' · must choose' : ' · only when asked for'}
              </div>
              <ul className="space-y-1">
                {g.options.map((o) => {
                  const v = current[o.modifierId] ?? 0;
                  return (
                    <li key={o.modifierId} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1">
                        {o.name}
                        {lacksLines(g, o) && (
                          <span className="block text-xs text-red-700 dark:text-red-400">no recipe lines yet: counts nothing</span>
                        )}
                      </span>
                      <button type="button" aria-label={`One fewer ${o.name}`} disabled={v <= 0} onClick={() => set(o.modifierId, v - 1)} className="flex h-10 w-10 items-center justify-center rounded-lg bg-white ring-1 ring-stone-300 disabled:opacity-40 dark:bg-stone-900 dark:ring-stone-700">
                        <Minus className="h-4 w-4" />
                      </button>
                      <input
                        type="text"
                        inputMode="numeric"
                        aria-label={`How many get ${o.name}`}
                        value={String(v)}
                        onChange={(e) => set(o.modifierId, Number(e.target.value.replace(/\D/g, '') || '0'))}
                        className="h-10 w-16 rounded-lg border border-stone-300 text-center font-mono dark:border-stone-700 dark:bg-stone-900"
                      />
                      <button type="button" aria-label={`One more ${o.name}`} disabled={v >= count} onClick={() => set(o.modifierId, v + 1)} className="flex h-10 w-10 items-center justify-center rounded-lg bg-white ring-1 ring-stone-300 disabled:opacity-40 dark:bg-stone-900 dark:ring-stone-700">
                        <Plus className="h-4 w-4" />
                      </button>
                      <span className="w-16 text-xs text-stone-500">of {n(count)}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {hasLeaveOuts(picks) && <p className="text-xs text-stone-500">{LEAVE_OUTS_NOTE}</p>}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- the answer --

/** The answer: costs (with COST_CAPABILITY), batches to make first, from stock, from scratch. */
export function CalcResult({
  calc,
  costs,
  onMake,
  canMake,
}: {
  calc: RecipeCalc;
  costs: RecipeCalcCosts | null;
  onMake: (ingredientId: string, amount: number) => void;
  canMake: boolean;
}) {
  const [scratchOpen, setScratchOpen] = useState(false);
  const short = calc.fromScratch.filter((r) => r.shortBy > 0).length;
  return (
    <div className="space-y-5">
      {costs && <CostHeadline calc={calc} costs={costs} />}
      {calc.warnings.map((w) => (
        <p key={w} className="flex items-start gap-1.5 text-sm font-medium text-red-700 dark:text-red-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" /> {w}
        </p>
      ))}

      {calc.batches.length > 0 && (
        <section>
          <h3 className="mb-1 text-sm font-semibold uppercase tracking-wider text-stone-500">Batches in it — make these first</h3>
          <p className="mb-1 text-xs text-stone-500">What is already made on this till&apos;s shelf is used first: only the rest is made.</p>
          <ul className="divide-y divide-stone-100 dark:divide-stone-800">
            {calc.batches.map((b) => (
              <BatchRow key={b.ingredientId} row={b} costed={!!costs} cost={costs?.perRow[b.ingredientId] ?? null} onMake={onMake} canMake={canMake} />
            ))}
          </ul>
        </section>
      )}

      {calc.fromStock.length > 0 && (
        <section>
          <h3 className="mb-1 text-sm font-semibold uppercase tracking-wider text-stone-500">Straight from stock</h3>
          <ul className="divide-y divide-stone-100 dark:divide-stone-800">
            {calc.fromStock.map((r) => (
              <QtyRow key={r.ingredientId} row={r} cost={costs?.perRow[r.ingredientId] ?? null} />
            ))}
          </ul>
        </section>
      )}

      {calc.fromScratch.length > 0 && (
        <section>
          <button
            type="button"
            onClick={() => setScratchOpen((o) => !o)}
            aria-expanded={scratchOpen}
            className="flex w-full items-center gap-1.5 text-left text-sm font-semibold uppercase tracking-wider text-stone-500"
          >
            {scratchOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            Everything from scratch ({calc.fromScratch.length} ingredients{short > 0 ? `, ${short} short` : ''})
          </button>
          {scratchOpen && (
            <>
              <p className="mt-1 text-xs text-stone-500">
                Every bought-in ingredient for what is left to make, through every batch (each made once; batches already in
                stock here are used first).
              </p>
              <ul className="mt-1 divide-y divide-stone-100 dark:divide-stone-800">
                {shortFirst(calc.fromScratch).map((r) => (
                  <QtyRow key={r.ingredientId} row={r} cost={null} buy />
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {calc.batches.length === 0 && calc.fromStock.length === 0 && (
        <p className="text-sm text-stone-500">Nothing to work out: no recipe lines for this yet.</p>
      )}
      <p className="text-xs text-stone-500">
        In stock = this till&apos;s own count. {LEAVE_OUTS_NOTE}
      </p>
    </div>
  );
}

function CostHeadline({ calc, costs }: { calc: RecipeCalc; costs: RecipeCalcCosts }) {
  return (
    <div className="space-y-1 rounded-lg bg-amber-50 px-4 py-3 dark:bg-amber-950/40">
      {calc.lines.map((l, i) => {
        const c = costs.perLine[i];
        if (!c) return null;
        const what = l.kind === 'item' ? `${n(l.count)} × ${l.name}` : `${kitchenQty(l.count, l.unit ?? '')} of ${l.name}`;
        const each =
          c.eachCents === null
            ? ''
            : l.kind === 'item'
              ? ` (${atLeast(c.eachCents, !c.complete)} each)`
              : ` (${atLeast(c.eachCents, !c.complete)} per ${thousandUnit(l.unit ?? '') ?? l.unit})`;
        return (
          <div key={`${l.id}:${i}`} className="text-sm">
            <b>{what}</b> costs <b className="font-mono text-base">{atLeast(c.costCents, !c.complete)}</b> to make{each}
          </div>
        );
      })}
      {calc.lines.length > 1 && (
        <div className="border-t border-amber-200 pt-1 text-sm dark:border-amber-900">
          All together: <b className="font-mono text-base">{atLeast(costs.totalCostCents, !costs.complete)}</b>
        </div>
      )}
      {!costs.complete && <p className="text-xs text-red-700 dark:text-red-400">{noPriceText(costs.unpriced)}: counted as Rs 0.</p>}
      {costs.estimates.length > 0 && <p className="text-xs text-amber-800 dark:text-amber-300">Guessed price: {costs.estimates.join(', ')}.</p>}
      <p className="text-[11px] text-stone-500">At today&apos;s prices; a batch at the price worked out from its recipe.</p>
    </div>
  );
}

function StockNote({ row, buy = false }: { row: RecipeCalcQtyRow; buy?: boolean }) {
  const packs = packsText(row.qty, row.unit, row.packSize);
  const toBuy = buy ? packsToBuy(row.shortBy, row.unit, row.packSize) : null;
  return (
    <span className="block text-xs text-stone-500">
      {packs && <>{packs} · </>}
      in stock here {kitchenQty(Math.max(0, row.inStock), row.unit)}
      {row.shortBy > 0 && (
        <b className="text-red-700 dark:text-red-400">
          {' '}
          · short {kitchenQty(row.shortBy, row.unit)}
          {toBuy !== null && row.packSize ? ` — buy ${n(toBuy)} pack${toBuy === 1 ? '' : 's'} of ${kitchenQty(row.packSize, row.unit)}` : ''}
        </b>
      )}
    </span>
  );
}

function QtyRow({ row, cost, buy = false }: { row: RecipeCalcQtyRow; cost: { costCents: number; complete: boolean } | null; buy?: boolean }) {
  return (
    <li className={cn('flex items-start gap-3 py-2', row.shortBy > 0 && 'bg-red-50/60 dark:bg-red-950/20')}>
      <span className="min-w-0 flex-1">
        <span className="font-medium">{row.name}</span>
        <StockNote row={row} buy={buy} />
      </span>
      <span className="text-right font-mono text-base font-semibold">{kitchenQty(row.qty, row.unit)}</span>
      {cost && <span className="w-24 text-right font-mono text-sm text-stone-500">{cost.complete ? formatCents(cost.costCents) : 'no price'}</span>}
    </li>
  );
}

function BatchRow({
  row,
  costed,
  cost,
  onMake,
  canMake,
}: {
  row: RecipeCalcBatchRow;
  /** Costs are shown (COST_CAPABILITY). */
  costed: boolean;
  /** What the recipes' own use of it costs; null when it only goes into other batches. */
  cost: { costCents: number; complete: boolean } | null;
  onMake: (ingredientId: string, amount: number) => void;
  canMake: boolean;
}) {
  const [open, setOpen] = useState(false);
  const a = makeAmounts(row);
  const tree = row.tree;
  const enough = row.toMake === 0;
  return (
    <li className={cn('py-2', row.shortBy > 0 && 'bg-red-50/60 dark:bg-red-950/20')}>
      <div className="flex flex-wrap items-start gap-3">
        <Opener open={open} onToggle={tree ? () => setOpen((o) => !o) : null}>
          <span className="min-w-0">
            <span className="font-semibold text-amber-800 dark:text-amber-300">{row.name}</span>
            {row.direct > 0 && row.direct < row.qty && (
              <span className="block text-xs text-stone-500">
                {kitchenQty(row.direct, row.unit)} for the recipe, the rest in other batches
              </span>
            )}
            <span className="block text-xs text-stone-500">
              in stock here {kitchenQty(Math.max(0, row.inStock), row.unit)}
              {enough ? (
                <b className="text-emerald-700 dark:text-emerald-400"> — enough, no need to make</b>
              ) : (
                row.shortBy > 0 && <b className="text-red-700 dark:text-red-400"> · short {kitchenQty(row.shortBy, row.unit)}</b>
              )}
            </span>
            {!enough && (
              <span className="block text-sm font-semibold text-stone-800 dark:text-stone-100">
                Make {kitchenQty(row.toMake, row.unit)}
                <span className="font-normal text-stone-500">
                  {' '}
                  = {row.batchesText} of {kitchenQty(row.batchYield, row.unit)}
                </span>
              </span>
            )}
          </span>
        </Opener>
        <span className="text-right font-mono text-base font-semibold">{kitchenQty(row.qty, row.unit)}</span>
        {costed && (
          <span className="w-24 text-right font-mono text-sm text-stone-500">
            {cost ? (cost.complete ? formatCents(cost.costCents) : 'no price') : '—'}
            {cost && row.direct < row.qty && <span className="block font-sans text-[10px]">for {kitchenQty(row.direct, row.unit)}</span>}
          </span>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 pl-6">
        {a.make !== null && (
          <Button variant="secondary" size="sm" disabled={!canMake} onClick={() => onMake(row.ingredientId, a.make!)}>
            <ChefHat className="h-4 w-4" /> Make / calculate {kitchenQty(a.make, row.unit)}
          </Button>
        )}
        {a.all !== null && (
          <button type="button" disabled={!canMake} onClick={() => onMake(row.ingredientId, a.all!)} className="text-sm font-semibold text-amber-700 underline disabled:opacity-50 dark:text-amber-300">
            {a.make === null ? `make ${kitchenQty(a.all, row.unit)} anyway` : `or all ${kitchenQty(a.all, row.unit)}`}
          </button>
        )}
        {a.goes > 1 && <span className="text-xs text-amber-800 dark:text-amber-300">More than 100 batches: make it in {a.goes} goes.</span>}
      </div>
      {open && tree && (
        <div className="mt-2 pl-6">
          <p className="mb-1 text-xs text-stone-500">What {kitchenQty(row.toMake, row.unit)} takes, as Make takes it (whole grams, rounded half up):</p>
          <Tree tree={tree} depth={0} />
        </div>
      )}
    </li>
  );
}

/** A row's name that opens what it takes (a button with a chevron), or just the name when there is nothing to open. */
function Opener({ open, onToggle, children }: { open: boolean; onToggle: (() => void) | null; children: ReactNode }) {
  if (!onToggle) {
    return (
      <div className="flex min-w-0 flex-1 items-start gap-1.5">
        <span className="w-4 flex-none" />
        {children}
      </div>
    );
  }
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} className="flex min-w-0 flex-1 items-start gap-1.5 text-left">
      <Chevron className="mt-1 h-4 w-4 flex-none" />
      {children}
    </button>
  );
}

function Tree({ tree, depth }: { tree: RecipeCalcTree; depth: number }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <ul className={cn('text-sm', depth > 0 && 'mt-1 border-l border-amber-200 pl-3 dark:border-amber-900')}>
      {tree.lines.map((l, i) => {
        const expanded = !!open[l.ingredientId];
        return (
          <Fragment key={`${l.ingredientId}:${i}`}>
            <li className="flex items-start gap-3 py-1">
              <span className="min-w-0 flex-1">
                {l.madeOf ? (
                  <button type="button" aria-expanded={expanded} onClick={() => setOpen((o) => ({ ...o, [l.ingredientId]: !o[l.ingredientId] }))} className="inline-flex items-center gap-1 font-medium text-amber-800 hover:underline dark:text-amber-300">
                    {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    {l.name}
                  </button>
                ) : (
                  <span>{l.name}</span>
                )}
                {l.loop && <span className="ml-1.5 rounded bg-red-100 px-1 text-[10px] text-red-800 dark:bg-red-950 dark:text-red-200">uses itself: taken from stock</span>}
                {l.qty > 0 && <StockNote row={l} />}
              </span>
              <span className="text-right font-mono">{l.qty === 0 ? <span className="text-xs text-stone-500">under 1 {l.unit} — not taken</span> : kitchenQty(l.qty, l.unit)}</span>
            </li>
            {expanded && l.madeOf && (
              <li>
                <Tree tree={l.madeOf} depth={depth + 1} />
              </li>
            )}
          </Fragment>
        );
      })}
    </ul>
  );
}
