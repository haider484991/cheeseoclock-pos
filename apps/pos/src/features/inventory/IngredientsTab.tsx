import { useCallback, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, Card, cn } from '@cheeseoclock/ui';
import {
  INGREDIENT_CATEGORIES,
  INGREDIENT_UNITS,
  baseUnitConversion,
  formatCents,
  formatPack,
  formatQty,
  formatUnitCost,
  guessIngredientCategory,
  ingredientCategoryLabel,
  stockFill,
  stockStatus,
  stockValueCents,
  thousandSize,
} from '@cheeseoclock/pos-domain';
import { ipc, IpcError } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import type { Ingredient, IngredientCategory, PriceKind, StockMovementReason, WasteReason } from '@cheeseoclock/shared-types';
import { Plus, Edit, Trash2, X, AlertTriangle, Scale, History, PackagePlus, ChefHat, Tag } from 'lucide-react';
import { askConfirm } from '../../components/confirm/ConfirmHost';
import {
  FilterChips,
  Pagination,
  SearchBox,
  SortHeader,
  countBy,
  useDeepLinkOpen,
  useListQuery,
  useSessionState,
  type ChipOption,
} from '../../components/list';
import {
  INGREDIENT_SORTS,
  compareIngredients,
  ingredientSearchText,
  matchesStockFilter,
  nextSort,
  type IngredientSort,
  type StockFilter,
} from './ingredient-list';
import { PriceFields, SetPriceDialog } from './SetPriceDialog';
import { ChangeMark, PriceHistoryDrawer, SourceChip } from './PriceHistoryDrawer';
import { initialPriceEntry, perChoices, readPriceEntry, tagView, type PriceEntry } from './price-view';

const INGREDIENTS_KEY = ['inventory', 'ingredients', 'all'] as const;

type CategoryFilter = IngredientCategory | 'all';

export function IngredientsTab({ onShowHistory }: { onShowHistory?: (ingredient: Ingredient) => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState<Ingredient | null | 'new'>(null);
  const [movementFor, setMovementFor] = useState<Ingredient | null>(null);
  /** "Set price" open for this one (costing Phase 4). */
  const [pricing, setPricing] = useState<Ingredient | null>(null);
  /** Its price history open in the drawer. */
  const [historyFor, setHistoryFor] = useState<Ingredient | null>(null);
  const [category, setCategory] = useSessionState<CategoryFilter>('inv.ing.category', 'all');
  const [stock, setStock] = useSessionState<StockFilter>('inv.ing.stock', 'all');
  const [sort, setSort] = useSessionState<IngredientSort>('inv.ing.sort', { key: 'name', dir: 'asc' });

  const q = useQuery({
    queryKey: INGREDIENTS_KEY,
    queryFn: () => ipc.inventory.listIngredients(),
    // Sales take stock all day; keep the numbers on screen current.
    refetchInterval: 30_000,
  });
  const sup = useQuery({
    queryKey: ['inventory', 'suppliers'],
    queryFn: () => ipc.inventory.listSuppliers(),
  });
  const supplierName = useCallback(
    (id: string | null) => (id ? sup.data?.find((s) => s.id === id)?.name : undefined),
    [sup.data],
  );
  // "Set price" on Costing → Missing costs lands here with that ingredient's "Set price" open.
  useDeepLinkOpen('inv.ing.openId', q.data, setPricing);

  const filter = useCallback(
    (i: Ingredient) => (category === 'all' || i.category === category) && matchesStockFilter(i, stock),
    [category, stock],
  );
  const sorter = useMemo(() => compareIngredients(sort), [sort]);
  const searchText = useCallback(
    (i: Ingredient) => ingredientSearchText(i, supplierName(i.defaultSupplierId)),
    [supplierName],
  );
  const list = useListQuery({
    items: q.data,
    searchText,
    filter,
    sort: sorter,
    persistKey: 'inv.ing',
    resetPageOn: [category, stock, sort],
  });

  // Chip counts follow the search box and the other chip row, so each chip
  // says exactly how many rows it would show.
  const categoryCounts = useMemo(
    () => countBy(list.searched.filter((i) => matchesStockFilter(i, stock)), (i) => i.category),
    [list.searched, stock],
  );
  const inCategory = useMemo(
    () => list.searched.filter((i) => category === 'all' || i.category === category),
    [list.searched, category],
  );
  const categoryOptions: ChipOption<CategoryFilter>[] = [
    {
      id: 'all',
      label: 'All',
      count: Object.values(categoryCounts).reduce<number>((a, b) => a + (b ?? 0), 0),
    },
    ...INGREDIENT_CATEGORIES.filter((c) => (categoryCounts[c.id] ?? 0) > 0 || c.id === category).map((c) => ({
      id: c.id as CategoryFilter,
      label: c.label,
      count: categoryCounts[c.id] ?? 0,
    })),
  ];
  const stockOptions: ChipOption<StockFilter>[] = [
    { id: 'all', label: 'Any stock' },
    { id: 'low', label: 'Low stock', count: inCategory.filter((i) => matchesStockFilter(i, 'low')).length, tone: 'amber' },
    { id: 'out', label: 'Out of stock', count: inCategory.filter((i) => matchesStockFilter(i, 'out')).length, tone: 'red' },
  ];

  const all = q.data ?? [];
  // "Low" counts the ones already out too, the same as the Low stock chip.
  const lowCount = all.filter((i) => stockStatus(i) !== 'ok').length;
  const outCount = all.filter((i) => stockStatus(i) === 'out').length;
  const totalValue = all.reduce((sum, i) => sum + stockValueCents(i), 0);

  const deleteMut = useMutation({
    mutationFn: (id: string) => ipc.inventory.deleteIngredient(id),
    onSuccess: () => {
      toast({ title: 'Ingredient removed', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (e) =>
      toast({
        title: 'Cannot delete',
        description: e instanceof IpcError ? e.message : String(e),
        variant: 'error',
      }),
  });

  const convertMut = useMutation({
    mutationFn: (id: string) => ipc.inventory.convertIngredientUnit(id),
    onSuccess: (i) => {
      toast({ title: `${i.name} is now counted in ${i.unit}`, variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (e) =>
      toast({
        title: 'Cannot convert',
        description: e instanceof IpcError ? e.message : String(e),
        variant: 'error',
      }),
  });

  const categoryMut = useMutation({
    mutationFn: (v: { id: string; category: IngredientCategory | null }) => ipc.inventory.updateIngredient(v),
    onSuccess: (i) => {
      toast({ title: `${i.name} → ${ingredientCategoryLabel(i.category)}`, variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (e) =>
      toast({ title: 'Could not move it', description: e instanceof IpcError ? e.message : String(e), variant: 'error' }),
  });

  const sortId = INGREDIENT_SORTS.find((s) => s.sort.key === sort.key && s.sort.dir === sort.dir)?.id ?? '';
  const filtersOn = list.query.trim() !== '' || category !== 'all' || stock !== 'all';

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Ingredients</h2>
          {q.data && (
            <p className="mt-0.5 text-sm text-stone-500">
              {all.length} ingredients
              {lowCount > 0 && (
                <>
                  {' · '}
                  <button type="button" className="font-semibold text-amber-700 hover:underline dark:text-amber-300" onClick={() => setStock('low')}>
                    {lowCount} low
                  </button>
                </>
              )}
              {outCount > 0 && (
                <>
                  {' · '}
                  <button type="button" className="font-semibold text-red-700 hover:underline dark:text-red-400" onClick={() => setStock('out')}>
                    {outCount} out
                  </button>
                </>
              )}
              {' · '}stock worth <span className="font-semibold text-stone-700 dark:text-stone-200">{formatCents(totalValue)}</span>
            </p>
          )}
        </div>
        <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
          <Plus className="h-4 w-4" /> Add ingredient
        </Button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchBox
          value={list.query}
          onChange={list.setQuery}
          placeholder="Search ingredient, supplier, SKU…"
          label="Search ingredients"
        />
        <FilterChips label="Stock" options={stockOptions} value={stock} onChange={setStock} />
        <label className="flex items-center gap-1.5 text-sm text-stone-600 dark:text-stone-400">
          Sort
          <select
            value={sortId}
            onChange={(e) => {
              const s = INGREDIENT_SORTS.find((x) => x.id === e.target.value);
              if (s) setSort(s.sort);
            }}
            className="h-9 rounded-lg border border-stone-300 bg-white px-2 text-sm text-stone-800 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-100"
          >
            {!sortId && <option value="">Custom</option>}
            {INGREDIENT_SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <FilterChips
        label="Category"
        className="mb-3"
        options={categoryOptions}
        value={category}
        onChange={setCategory}
      />

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-stone-500">
            <tr>
              <SortHeader label="Name" active={sort.key === 'name'} direction={sort.dir} onClick={() => setSort(nextSort(sort, 'name'))} />
              <th className="pb-2">Category</th>
              <SortHeader
                label="On hand"
                align="right"
                active={sort.key === 'stock'}
                direction={sort.dir}
                onClick={() => setSort(nextSort(sort, 'stock'))}
              />
              <th className="pb-2 text-right">Price</th>
              <SortHeader
                label="Value"
                align="right"
                active={sort.key === 'value'}
                direction={sort.dir}
                onClick={() => setSort(nextSort(sort, 'value'))}
              />
              <th className="pb-2 pl-4">Supplier</th>
              <th className="pb-2">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.items.map((i) => (
              <tr key={i.id} className="border-t border-stone-100 align-top dark:border-stone-800">
                <td className="py-2.5 pr-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{i.name}</span>
                    <StatusBadge ingredient={i} />
                    {i.batchYield !== null && (
                      <span className="inline-flex items-center gap-1 rounded bg-stone-100 px-1.5 py-0.5 text-[11px] text-stone-600 dark:bg-stone-800 dark:text-stone-300">
                        <ChefHat className="h-3 w-3" /> made here
                      </span>
                    )}
                  </div>
                  {i.sku && <div className="text-xs text-stone-500">SKU {i.sku}</div>}
                </td>
                <td className="py-2.5 pr-2">
                  <CategoryPicker
                    ingredient={i}
                    disabled={categoryMut.isPending}
                    onPick={(c) => categoryMut.mutate({ id: i.id, category: c })}
                  />
                </td>
                <td className="py-2.5 text-right">
                  <StockLevel ingredient={i} />
                </td>
                <td className="py-2.5 pl-3 text-right">
                  <PriceCell ingredient={i} onHistory={() => setHistoryFor(i)} />
                  {baseUnitConversion(i.unit) && (
                    <button
                      type="button"
                      disabled={convertMut.isPending}
                      onClick={() => {
                        const to = baseUnitConversion(i.unit)!;
                        void askConfirm(
                          `Count "${i.name}" in ${to.unit} instead of ${i.unit}?\n\nStock, low level and every recipe that uses it are multiplied by ${to.factor} — the same amounts, in ${to.unit}. Recipes can then say 300 ${to.unit}.`,
                        ).then((ok) => {
                          if (ok) convertMut.mutate(i.id);
                        });
                      }}
                      className="mt-1 inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900 hover:bg-amber-200 dark:bg-amber-950 dark:text-amber-200"
                    >
                      <Scale className="h-3 w-3" /> Convert to {baseUnitConversion(i.unit)!.unit}
                    </button>
                  )}
                </td>
                <td className="whitespace-nowrap py-2.5 pl-3 text-right font-mono text-xs">{formatCents(stockValueCents(i))}</td>
                <td className="py-2.5 pl-4 text-stone-500">{supplierName(i.defaultSupplierId) ?? '—'}</td>
                <td className="py-2 pl-2 text-right">
                  <div className="flex items-center justify-end gap-0.5">
                    <Button variant="secondary" size="sm" onClick={() => setMovementFor(i)} title="Delivery, waste or stock take">
                      <PackagePlus className="h-4 w-4" /> Stock
                    </Button>
                    <IconButton label="Set price" onClick={() => setPricing(i)}>
                      <Tag className="h-4 w-4" />
                    </IconButton>
                    {onShowHistory && (
                      <IconButton label="Stock history" onClick={() => onShowHistory(i)}>
                        <History className="h-4 w-4" />
                      </IconButton>
                    )}
                    <IconButton label="Edit" onClick={() => setEditing(i)}>
                      <Edit className="h-4 w-4" />
                    </IconButton>
                    <IconButton
                      label="Delete"
                      danger
                      onClick={() => {
                        void askConfirm(`Delete "${i.name}"?\nOnly an ingredient that no recipe uses can be deleted.`).then((ok) => {
                          if (ok) deleteMut.mutate(i.id);
                        });
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  </div>
                </td>
              </tr>
            ))}
            {list.total === 0 && (
              <tr>
                <td colSpan={7} className="py-10 text-center text-stone-500">
                  {q.isLoading ? (
                    'Loading…'
                  ) : all.length === 0 ? (
                    'No ingredients yet. Add one, or import the menu file in Settings.'
                  ) : (
                    <div className="space-y-2">
                      <div>
                        No ingredients match
                        {list.query.trim() ? <> “{list.query.trim()}”</> : ' these filters'}.
                      </div>
                      {filtersOn && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            list.setQuery('');
                            setCategory('all');
                            setStock('all');
                          }}
                        >
                          Show all ingredients
                        </Button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pagination
        page={list.page}
        pageCount={list.pageCount}
        total={list.total}
        from={list.from}
        to={list.to}
        onPage={list.setPage}
        pageSize={list.pageSize}
        onPageSize={list.setPageSize}
        noun={list.total === 1 ? 'ingredient' : 'ingredients'}
      />

      {editing && (
        <IngredientDialog
          key={editing === 'new' ? 'new' : editing.id}
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {pricing && <SetPriceDialog key={pricing.id} ingredient={pricing} onClose={() => setPricing(null)} />}
      {historyFor && (
        <PriceHistoryDrawer
          key={historyFor.id}
          ingredient={historyFor}
          onClose={() => setHistoryFor(null)}
          onSetPrice={(i) => {
            setHistoryFor(null);
            setPricing(i);
          }}
        />
      )}
      {movementFor && (
        <MovementDialog key={movementFor.id} ingredient={movementFor} onClose={() => setMovementFor(null)} />
      )}
    </Card>
  );
}

function IconButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        'rounded-lg p-2',
        danger
          ? 'text-red-500 hover:bg-red-50 dark:hover:bg-red-950'
          : 'text-stone-500 hover:bg-stone-100 hover:text-stone-800 dark:hover:bg-stone-800 dark:hover:text-stone-100',
      )}
    >
      {children}
    </button>
  );
}

/**
 * How the price is known (costing spec D1): "no price yet" (listed under
 * Costing → Missing costs), "free" (a real Rs 0), or "guess". A sauce made
 * here with no price of its own is costed from its batch recipe.
 */
function PriceKindTag({ kind, madeHere }: { kind: PriceKind; madeHere: boolean }) {
  const tag =
    kind === 'unset'
      ? madeHere
        ? { text: 'from its batch', cls: 'bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300' }
        : { text: 'no price yet', cls: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200' }
      : kind === 'free'
        ? { text: 'free', cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200' }
        : kind === 'estimate'
          ? { text: 'guess', cls: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200' }
          : null;
  if (!tag) return null;
  return <span className={cn('mr-1.5 rounded px-1.5 py-0.5 font-sans text-[11px] font-medium', tag.cls)}>{tag.text}</span>;
}

/**
 * The price column (costing spec Phase 4): the price per kg / litre / piece,
 * the pack it is bought in, where it came from (Bill, Typed, Sheet, Batch…)
 * and up or down on the price before — from the newest line of its price
 * history. A tap opens the whole history.
 */
function PriceCell({ ingredient: i, onHistory }: { ingredient: Ingredient; onHistory: () => void }) {
  const tag = i.latestPrice ?? null;
  // After a Convert the newest line is in the unit now; one in another unit is not this price.
  const view = tag && tag.unit === i.unit ? tagView(tag) : null;
  const kind = view && tag ? tag.priceKind : i.priceKind;
  const packLine = view ? view.pack : (i.packSize ?? 0) > 1 && i.packSize !== thousandSize(i.unit) ? formatPack(i) : null;
  return (
    <button
      type="button"
      onClick={onHistory}
      title="Price history"
      className="ml-auto flex flex-col items-end gap-0.5 rounded px-1 py-0.5 text-right hover:bg-stone-50 dark:hover:bg-stone-800"
    >
      <span className="whitespace-nowrap font-mono text-xs">
        <PriceKindTag kind={kind} madeHere={i.batchYield !== null} />
        {kind !== 'unset' && kind !== 'free' && (view ? view.price : formatUnitCost(i))}
      </span>
      {packLine && <span className="whitespace-nowrap text-xs text-stone-500">{packLine}</span>}
      {view && tag && (
        <span className="flex items-center gap-1.5">
          <SourceChip source={tag.source} />
          {tag.source !== 'convert' && <ChangeMark prevUnitCostMc={tag.prevUnitCostMc} unitCostMc={tag.unitCostMc} priceKind={tag.priceKind} />}
        </span>
      )}
    </button>
  );
}

function StatusBadge({ ingredient }: { ingredient: Ingredient }) {
  const s = stockStatus(ingredient);
  if (s === 'ok') return null;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase',
        s === 'out'
          ? 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200'
          : 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
      )}
    >
      <AlertTriangle className="h-3 w-3" /> {s === 'out' ? 'Out' : 'Low'}
    </span>
  );
}

/** "12.5 kg", a bar with the low level a third of the way along, "low at 5 kg". */
function StockLevel({ ingredient: i }: { ingredient: Ingredient }) {
  const s = stockStatus(i);
  const fill = stockFill(i);
  return (
    <div className="ml-auto flex w-32 flex-col items-end gap-1">
      <span
        className={cn(
          'whitespace-nowrap font-mono font-semibold',
          s === 'out' && 'text-red-700 dark:text-red-400',
          s === 'low' && 'text-amber-700 dark:text-amber-300',
        )}
        title={`${new Intl.NumberFormat('en-PK').format(i.currentQty)} ${i.unit}`}
      >
        {formatQty(i.currentQty, i.unit)}
      </span>
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-stone-200 dark:bg-stone-700" aria-hidden>
        <div
          className={cn(
            'h-full rounded-full',
            s === 'out' ? 'bg-red-500' : s === 'low' ? 'bg-amber-500' : 'bg-emerald-500',
          )}
          style={{ width: `${Math.round(fill * 100)}%` }}
        />
        {i.lowThreshold > 0 && <div className="absolute inset-y-0 left-1/3 w-px bg-stone-500/60" />}
      </div>
      <span className="whitespace-nowrap text-[11px] text-stone-500">
        {i.lowThreshold > 0 ? `low at ${formatQty(i.lowThreshold, i.unit)}` : 'no low level set'}
      </span>
    </div>
  );
}

/** The category, changeable right in the row. A guessed one is shown dashed until someone picks. */
function CategoryPicker({
  ingredient,
  disabled,
  onPick,
}: {
  ingredient: Ingredient;
  disabled: boolean;
  onPick: (category: IngredientCategory) => void;
}) {
  return (
    <select
      value={ingredient.category}
      disabled={disabled}
      onChange={(e) => onPick(e.target.value as IngredientCategory)}
      aria-label={`Category of ${ingredient.name}`}
      title={ingredient.categoryAuto ? 'Guessed from the name — pick to set it' : 'Change category'}
      className={cn(
        'max-w-[10.5rem] cursor-pointer rounded-full border bg-transparent px-2.5 py-1 text-xs font-medium',
        'hover:bg-stone-50 dark:hover:bg-stone-800',
        ingredient.categoryAuto
          ? 'border-dashed border-stone-300 text-stone-500 dark:border-stone-600'
          : 'border-stone-300 text-stone-700 dark:border-stone-600 dark:text-stone-200',
      )}
    >
      {INGREDIENT_CATEGORIES.map((c) => (
        <option key={c.id} value={c.id}>
          {c.label}
        </option>
      ))}
    </select>
  );
}

function IngredientDialog({
  existing,
  onClose,
}: {
  existing: Ingredient | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  // An ingredient's price changes only through "Set price" (it keeps the price history), opened over this form.
  const [settingPrice, setSettingPrice] = useState(false);
  const listed = useQuery({ queryKey: INGREDIENTS_KEY, queryFn: () => ipc.inventory.listIngredients(), enabled: !!existing });
  const current = (existing && listed.data?.find((x) => x.id === existing.id)) || existing;
  const [name, setName] = useState(existing?.name ?? '');
  /** '' = guess from the name. */
  const [category, setCategory] = useState<IngredientCategory | ''>(
    existing && !existing.categoryAuto ? existing.category : '',
  );
  const [unit, setUnit] = useState(existing?.unit ?? 'g');
  const [currentQty, setCurrentQty] = useState((existing?.currentQty ?? 0).toString());
  const [lowThreshold, setLowThreshold] = useState((existing?.lowThreshold ?? 0).toString());
  // A new ingredient's price, as it is bought (the same boxes as "Set price").
  const [priceEntry, setPriceEntry] = useState<PriceEntry>(() =>
    initialPriceEntry({ unit: existing?.unit ?? 'g', costPerUnitCents: 0, packSize: null, packPriceCents: null, priceKind: 'unset' }),
  );
  const priceReading = readPriceEntry(priceEntry, unit);
  const priceBlocked = !existing && !priceReading.ok && !priceReading.empty;
  const unitChoices = [...new Set([...INGREDIENT_UNITS, ...(existing ? [existing.unit] : [])])];
  const [supplierId, setSupplierId] = useState(existing?.defaultSupplierId ?? '');
  const [sku, setSku] = useState(existing?.sku ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const guessed = guessIngredientCategory(name);

  const sup = useQuery({
    queryKey: ['inventory', 'suppliers'],
    queryFn: () => ipc.inventory.listSuppliers(),
  });

  const mut = useMutation({
    mutationFn: () => {
      const low = parseInt(lowThreshold, 10) || 0;
      if (existing) {
        // The price is not sent: it changes through "Set price", with its history.
        return ipc.inventory.updateIngredient({
          id: existing.id,
          name: name.trim(),
          category: category || null,
          lowThreshold: low,
          defaultSupplierId: supplierId || null,
          sku: sku || null,
          notes: notes || null,
        });
      }
      // No price typed: added as "no price yet" (Costing → Missing costs lists it).
      const priceFields: { packSize?: number; packPriceCents?: number; priceKind?: PriceKind } = !priceReading.ok
        ? {}
        : priceReading.free
          ? { priceKind: 'free' }
          : { packSize: priceReading.pack.size, packPriceCents: priceReading.pack.priceCents, priceKind: priceReading.priceKind };
      return ipc.inventory.createIngredient({
        name: name.trim(),
        category: category || null,
        unit,
        currentQty: parseInt(currentQty, 10) || 0,
        lowThreshold: low,
        ...priceFields,
        defaultSupplierId: supplierId || null,
        sku: sku || null,
        notes: notes || null,
      });
    },
    onSuccess: () => {
      toast({ title: existing ? 'Saved' : 'Ingredient added', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      onClose();
    },
    onError: (e) =>
      toast({
        title: 'Save failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      }),
  });

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[520px] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-xl bg-white p-5 shadow-xl dark:bg-stone-900">
          <header className="mb-4 flex items-center justify-between">
            <Dialog.Title className="text-lg font-bold">
              {existing ? `Edit ${existing.name}` : 'Add ingredient'}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>
          <Dialog.Description className="sr-only">Name, category, unit, stock level and cost of the ingredient.</Dialog.Description>
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <FieldLabel htmlFor="ing-name">Name</FieldLabel>
                <input
                  id="ing-name"
                  type="text"
                  value={name}
                  autoFocus
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
                />
              </div>
              <div>
                <FieldLabel htmlFor="ing-unit">Unit</FieldLabel>
                <select
                  id="ing-unit"
                  value={unit}
                  onChange={(e) => {
                    const next = e.target.value;
                    setUnit(next);
                    // Per kg fits grams, per piece fits pieces: keep the price boxes to a way this unit is bought.
                    setPriceEntry((pe) => (perChoices(next).includes(pe.per) ? pe : { ...pe, per: perChoices(next)[0]! }));
                  }}
                  // An existing ingredient changes unit only through Convert (it rescales stock and recipes).
                  disabled={!!existing}
                  title={existing ? 'Use Convert to change the unit' : undefined}
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono dark:border-stone-700 dark:bg-stone-800"
                >
                  {unitChoices.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <FieldLabel htmlFor="ing-category">Category</FieldLabel>
              <select
                id="ing-category"
                value={category}
                onChange={(e) => setCategory(e.target.value as IngredientCategory | '')}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
              >
                <option value="">Automatic — {ingredientCategoryLabel(guessed)}</option>
                {INGREDIENT_CATEGORIES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {!existing && (
                <div>
                  <FieldLabel htmlFor="ing-opening">Opening stock ({unit})</FieldLabel>
                  <input
                    id="ing-opening"
                    type="number"
                    step="1"
                    min={0}
                    inputMode="numeric"
                    value={currentQty}
                    onChange={(e) => setCurrentQty(e.target.value)}
                    className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono dark:border-stone-700 dark:bg-stone-800"
                  />
                </div>
              )}
              <div>
                <FieldLabel htmlFor="ing-low">Low at ({unit})</FieldLabel>
                <input
                  id="ing-low"
                  type="number"
                  step="1"
                  min={0}
                  inputMode="numeric"
                  value={lowThreshold}
                  onChange={(e) => setLowThreshold(e.target.value)}
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono dark:border-stone-700 dark:bg-stone-800"
                />
              </div>
            </div>
            {existing && (
              <p className="text-xs text-stone-500">
                In stock now: <strong>{formatQty(existing.currentQty, existing.unit)}</strong>. Use the Stock button to
                book a delivery, waste or a stock take.
              </p>
            )}
            <div className="rounded-lg bg-stone-50 p-3 dark:bg-stone-800/50">
              <div className="mb-2 text-xs uppercase tracking-wider text-stone-500">Price</div>
              {current ? (
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span>
                    <PriceCellText ingredient={current} />
                  </span>
                  <Button variant="secondary" size="sm" onClick={() => setSettingPrice(true)}>
                    <Tag className="h-4 w-4" /> Change price
                  </Button>
                  {settingPrice && <SetPriceDialog ingredient={current} onClose={() => setSettingPrice(false)} />}
                </div>
              ) : (
                <PriceFields unit={unit} entry={priceEntry} onChange={setPriceEntry} idPrefix="ing-price" optional />
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <FieldLabel htmlFor="ing-supplier">Usual supplier</FieldLabel>
                <select
                  id="ing-supplier"
                  value={supplierId}
                  onChange={(e) => setSupplierId(e.target.value)}
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
                >
                  <option value="">— None —</option>
                  {sup.data
                    ?.filter((s) => s.isActive || s.id === supplierId)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <FieldLabel htmlFor="ing-sku">SKU / code</FieldLabel>
                <input
                  id="ing-sku"
                  type="text"
                  value={sku}
                  onChange={(e) => setSku(e.target.value)}
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono dark:border-stone-700 dark:bg-stone-800"
                />
              </div>
            </div>
            <div>
              <FieldLabel htmlFor="ing-notes">Notes</FieldLabel>
              <input
                id="ing-notes"
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
              />
            </div>
          </div>
          <footer className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={mut.isPending || !name.trim() || !unit.trim() || priceBlocked} onClick={() => mut.mutate()}>
              {mut.isPending ? 'Saving…' : 'Save'}
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The price as one line (edit dialog): "Rs 375 / kg · 6,000 g for Rs 2,250", with its chip. */
function PriceCellText({ ingredient: i }: { ingredient: Ingredient }) {
  const tag = i.latestPrice ?? null;
  const view = tag && tag.unit === i.unit ? tagView(tag) : null;
  const kind = view && tag ? tag.priceKind : i.priceKind;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="font-mono">
        <PriceKindTag kind={kind} madeHere={i.batchYield !== null} />
        {kind !== 'unset' && kind !== 'free' && (view ? view.price : formatUnitCost(i))}
      </span>
      {view?.pack && <span className="text-xs text-stone-500">{view.pack}</span>}
      {view && tag && <SourceChip source={tag.source} />}
    </span>
  );
}

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-xs uppercase tracking-wider text-stone-500">
      {children}
    </label>
  );
}

type ManualReason = Extract<StockMovementReason, 'delivery' | 'waste' | 'count' | 'adjustment'>;

/** Why it was thrown away: Reports splits waste by these (costing spec Phase 2). */
const WASTE_REASON_CHIPS: ReadonlyArray<{ id: WasteReason; label: string }> = [
  { id: 'burnt', label: 'Burnt' },
  { id: 'dropped', label: 'Dropped' },
  { id: 'expired', label: 'Expired / went off' },
  { id: 'wrong_order', label: 'Wrong order made' },
  { id: 'returned', label: 'Sent back' },
  { id: 'staff_meal', label: 'Staff meal' },
  { id: 'other', label: 'Other' },
];

const MANUAL_REASONS: ReadonlyArray<{ id: ManualReason; label: string; hint: string }> = [
  { id: 'delivery', label: 'Delivery in', hint: 'Stock that arrived without a purchase order' },
  { id: 'waste', label: 'Waste', hint: 'Spoiled, dropped or thrown away' },
  { id: 'count', label: 'Stock take', hint: 'You counted it — type what is on the shelf' },
  { id: 'adjustment', label: 'Fix', hint: 'Correct a mistake (use minus to take away)' },
];

function MovementDialog({
  ingredient,
  onClose,
}: {
  ingredient: Ingredient;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [reason, setReason] = useState<ManualReason>('delivery');
  const [wasteReason, setWasteReason] = useState<WasteReason | null>(null);
  const [delta, setDelta] = useState('');
  const [notes, setNotes] = useState('');
  const needsWhy = reason === 'waste' && wasteReason === null;

  const isCount = reason === 'count';
  // Every reason needs an explicit integer — an empty "count" must never be
  // read as 0 (that would silently zero the ingredient).
  const deltaValid = /^-?\d+$/.test(delta.trim());
  const numericDelta = deltaValid ? parseInt(delta.trim(), 10) : 0;
  const normalize = (d: number): number =>
    reason === 'waste' ? -Math.abs(d) : reason === 'delivery' ? Math.abs(d) : d;
  const previewDelta = normalize(isCount ? numericDelta - ingredient.currentQty : numericDelta);
  const countNegative = isCount && numericDelta < 0;

  // One save per click. Waste and deliveries used to go through a second,
  // unguarded call that ignored "Saving…": a double-click wasted the stock twice.
  const submitting = useRef(false);
  const mut = useMutation({
    mutationFn: async () => {
      let d = numericDelta;
      if (isCount) {
        // Sales keep taking stock while this dialog is open: work the
        // difference out from the level right now, not when it was opened.
        const fresh = (await ipc.inventory.listIngredients()).find((x) => x.id === ingredient.id);
        d = numericDelta - (fresh?.currentQty ?? ingredient.currentQty);
      }
      return ipc.inventory.recordMovement({
        ingredientId: ingredient.id,
        deltaQty: normalize(d),
        reason,
        notes: notes.trim() || null,
        ...(reason === 'waste' && wasteReason ? { wasteReason } : {}),
      });
    },
    onSettled: () => {
      submitting.current = false;
    },
    onSuccess: (r) => {
      toast({
        title: 'Stock updated',
        description: `${ingredient.name}: now ${formatQty(r.resultingQty, ingredient.unit)}`,
        variant: 'success',
      });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      onClose();
    },
    onError: (e) =>
      toast({
        title: 'Failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      }),
  });

  const hint = MANUAL_REASONS.find((r) => r.id === reason)?.hint;

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[460px] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-5 shadow-xl dark:bg-stone-900">
          <header className="mb-4 flex items-center justify-between">
            <Dialog.Title className="text-lg font-bold">Stock: {ingredient.name}</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>
          <Dialog.Description className="mb-3 rounded-lg bg-stone-100 p-3 text-sm dark:bg-stone-800">
            In stock now: <strong>{formatQty(ingredient.currentQty, ingredient.unit)}</strong>
            {ingredient.lowThreshold > 0 && (
              <span className="text-stone-500"> · low at {formatQty(ingredient.lowThreshold, ingredient.unit)}</span>
            )}
          </Dialog.Description>
          <div className="space-y-3">
            <div>
              <div className="mb-1 text-xs uppercase tracking-wider text-stone-500">What happened?</div>
              <div className="grid grid-cols-4 gap-2" role="group" aria-label="What happened">
                {MANUAL_REASONS.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    aria-pressed={reason === r.id}
                    onClick={() => setReason(r.id)}
                    className={cn(
                      'rounded-lg border-2 px-2 py-2 text-xs font-semibold transition-colors',
                      reason === r.id
                        ? 'border-amber-500 bg-amber-50 dark:bg-amber-950'
                        : 'border-stone-200 hover:border-stone-300 dark:border-stone-700',
                    )}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              {hint && <p className="mt-1 text-xs text-stone-500">{hint}</p>}
            </div>
            {reason === 'waste' && (
              <div>
                <div className="mb-1 text-xs uppercase tracking-wider text-stone-500">Why?</div>
                <div className="flex flex-wrap gap-2" role="group" aria-label="Why was it wasted">
                  {WASTE_REASON_CHIPS.map((w) => (
                    <button
                      key={w.id}
                      type="button"
                      aria-pressed={wasteReason === w.id}
                      onClick={() => setWasteReason(w.id)}
                      className={cn(
                        'rounded-full border-2 px-3 py-1.5 text-xs font-semibold transition-colors',
                        wasteReason === w.id
                          ? 'border-amber-500 bg-amber-50 dark:bg-amber-950'
                          : 'border-stone-200 hover:border-stone-300 dark:border-stone-700',
                      )}
                    >
                      {w.label}
                    </button>
                  ))}
                </div>
                {needsWhy && <p className="mt-1 text-xs text-stone-500">Pick why, so Reports can show waste by reason.</p>}
              </div>
            )}
            <div>
              <label htmlFor="mv-qty" className="mb-1 block text-xs uppercase tracking-wider text-stone-500">
                {isCount
                  ? `On the shelf now (${ingredient.unit})`
                  : reason === 'delivery'
                    ? `How much came in (${ingredient.unit})`
                    : reason === 'waste'
                      ? `How much was wasted (${ingredient.unit})`
                      : `Change (${ingredient.unit}, minus to take away)`}
              </label>
              <input
                id="mv-qty"
                type="number"
                step="1"
                inputMode="numeric"
                value={delta}
                autoFocus
                onChange={(e) => setDelta(e.target.value)}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono text-lg dark:border-stone-700 dark:bg-stone-800"
              />
              {deltaValid && !countNegative && (
                <div className="mt-1 text-xs text-stone-500">
                  {previewDelta > 0 ? '+' : ''}
                  {formatQty(previewDelta, ingredient.unit)} → new stock{' '}
                  <strong>{formatQty(ingredient.currentQty + previewDelta, ingredient.unit)}</strong>
                </div>
              )}
              {countNegative && <div className="mt-1 text-xs text-red-600">A count cannot be below zero.</div>}
            </div>
            <div>
              <label htmlFor="mv-note" className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Note</label>
              <input
                id="mv-note"
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={reason === 'waste' ? 'Spoiled / dropped / etc.' : ''}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
              />
            </div>
          </div>
          <footer className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={mut.isPending || !deltaValid || countNegative || needsWhy}
              onClick={() => {
                if (submitting.current) return;
                submitting.current = true;
                mut.mutate();
              }}
            >
              {mut.isPending ? 'Saving…' : 'Save'}
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
