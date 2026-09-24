import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { formatCents, formatUnitCost } from '@cheeseoclock/pos-domain';
import { ipc, IpcError } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import type { Ingredient, MenuItem } from '@cheeseoclock/shared-types';
import { X, Plus, Trash2, Edit, BookOpen, ChefHat, Soup } from 'lucide-react';

type Mode = 'items' | 'batches';

export function RecipesTab() {
  const [mode, setMode] = useState<Mode>('items');
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {([
          ['items', 'Menu items', BookOpen],
          ['batches', 'Batch recipes (made in-house)', Soup],
        ] as const).map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            onClick={() => setMode(id)}
            className={cn(
              'flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold',
              mode === id
                ? 'bg-stone-900 text-white dark:bg-amber-500 dark:text-stone-900'
                : 'bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300',
            )}
          >
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>
      {mode === 'items' ? <MenuItemRecipes /> : <BatchRecipes />}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Menu item recipes
// -----------------------------------------------------------------------------

function MenuItemRecipes() {
  const itemsQ = useQuery({ queryKey: ['menu', 'items', 'all'], queryFn: () => ipc.menu.listItems() });
  const catsQ = useQuery({ queryKey: ['menu', 'categories', 'all'], queryFn: () => ipc.menu.listCategories() });
  const [editingItem, setEditingItem] = useState<MenuItem | null>(null);
  const [filter, setFilter] = useState<string | 'all'>('all');

  const items = (itemsQ.data ?? []).filter((i) => filter === 'all' || i.categoryId === filter);
  const catName = (id: string) => catsQ.data?.find((c) => c.id === id)?.name ?? '?';

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setFilter('all')}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-semibold',
              filter === 'all'
                ? 'bg-amber-500 text-stone-900'
                : 'bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300',
            )}
          >
            All
          </button>
          {catsQ.data?.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setFilter(c.id)}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-semibold',
                filter === c.id
                  ? 'text-stone-900'
                  : 'bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300',
              )}
              style={filter === c.id ? { background: c.colorHex } : undefined}
            >
              {c.name}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {items.map((item) => (
          <RecipeCard key={item.id} item={item} categoryName={catName(item.categoryId)} onEdit={() => setEditingItem(item)} />
        ))}
        {items.length === 0 && (
          <div className="col-span-2 py-6 text-center text-stone-500">No menu items.</div>
        )}
      </div>

      {editingItem && <RecipeEditor item={editingItem} onClose={() => setEditingItem(null)} />}
    </Card>
  );
}

function RecipeCard({
  item,
  categoryName,
  onEdit,
}: {
  item: MenuItem;
  categoryName: string;
  onEdit: () => void;
}) {
  const q = useQuery({
    queryKey: ['inventory', 'recipe', item.id],
    queryFn: () => ipc.inventory.getRecipe(item.id),
  });
  const lines = q.data ?? [];
  const always = lines.filter((l) => !l.modifierId);
  const byChoice = new Map<string, typeof lines>();
  for (const l of lines.filter((x) => x.modifierId)) {
    const key = l.modifierName ?? '?';
    byChoice.set(key, [...(byChoice.get(key) ?? []), l]);
  }
  return (
    <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-semibold">{item.name}</div>
          <div className="text-xs text-stone-500">{categoryName}</div>
        </div>
        <Button variant="secondary" size="sm" onClick={onEdit}>
          {lines.length === 0 ? (
            <>
              <Plus className="h-3 w-3" /> Add recipe
            </>
          ) : (
            <>
              <Edit className="h-3 w-3" /> Edit
            </>
          )}
        </Button>
      </div>
      {lines.length > 0 ? (
        <>
          <ul className="mt-2 space-y-0.5 text-xs">
            {always.map((l) => (
              <li key={l.id} className="flex justify-between">
                <span>{l.ingredientName}</span>
                <span className="font-mono">
                  {l.qtyPerUnit} {l.unit}
                </span>
              </li>
            ))}
          </ul>
          {byChoice.size > 0 && (
            <div className="mt-2 rounded bg-amber-50 p-2 text-xs dark:bg-amber-950/40">
              <div className="mb-1 font-semibold text-amber-900 dark:text-amber-200">Only when chosen at the till</div>
              <ul className="space-y-0.5">
                {[...byChoice.entries()].map(([choice, ls]) => (
                  <li key={choice} className="flex justify-between gap-2">
                    <span>{choice}</span>
                    <span className="text-right font-mono">
                      {ls.map((l) => `${l.qtyPerUnit} ${l.unit} ${l.ingredientName}`).join(', ')}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : (
        <div className="mt-2 inline-flex items-center gap-1 rounded bg-stone-100 px-2 py-0.5 text-xs text-stone-500 dark:bg-stone-800">
          <BookOpen className="h-3 w-3" /> No recipe — won't decrement stock
        </div>
      )}
    </div>
  );
}

type EditLine = { ingredientId: string; qtyPerUnit: number; modifierId: string | null };

function RecipeEditor({ item, onClose }: { item: MenuItem; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const ingredientsQ = useQuery({
    queryKey: ['inventory', 'ingredients', 'all'],
    queryFn: () => ipc.inventory.listIngredients(),
  });
  const existingQ = useQuery({
    queryKey: ['inventory', 'recipe', item.id],
    queryFn: () => ipc.inventory.getRecipe(item.id),
  });
  const groupsQ = useQuery({
    queryKey: ['menu', 'modifierGroupsForItem', item.id],
    queryFn: () => ipc.menu.listModifierGroupsForItem(item.id),
  });
  const choices = (groupsQ.data ?? []).flatMap((g) => g.modifiers.map((m) => ({ id: m.id, label: `${g.name}: ${m.name}` })));

  const [lines, setLines] = useState<EditLine[]>([]);

  useEffect(() => {
    if (existingQ.data) {
      setLines(
        existingQ.data.map((l) => ({ ingredientId: l.ingredientId, qtyPerUnit: l.qtyPerUnit, modifierId: l.modifierId })),
      );
    }
  }, [existingQ.data]);

  const mut = useMutation({
    mutationFn: () => ipc.inventory.setRecipe({ menuItemId: item.id, lines }),
    onSuccess: () => {
      toast({ title: 'Recipe saved', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['inventory', 'recipe', item.id] });
      onClose();
    },
    onError: (e) =>
      toast({
        title: 'Save failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      }),
  });

  function addLine() {
    const firstUnused = ingredientsQ.data?.find((i) => !lines.some((l) => l.ingredientId === i.id));
    if (!firstUnused) {
      toast({ title: 'No more ingredients to add', variant: 'warning' });
      return;
    }
    setLines((prev) => [...prev, { ingredientId: firstUnused.id, qtyPerUnit: 1, modifierId: null }]);
  }

  function updateLine(i: number, patch: Partial<EditLine>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  function removeLine(i: number) {
    setLines((prev) => prev.filter((_, idx) => idx !== i));
  }

  function ingUnit(id: string): string {
    return ingredientsQ.data?.find((x) => x.id === id)?.unit ?? '';
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[760px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-white shadow-xl dark:bg-stone-900">
          <header className="flex items-center justify-between border-b border-stone-200 p-5 dark:border-stone-800">
            <div>
              <Dialog.Title className="text-lg font-bold">Recipe for {item.name}</Dialog.Title>
              <Dialog.Description className="text-xs text-stone-500">
                Ingredients used per ONE sold unit. A line set to a choice is only used when that choice is picked at
                the till (e.g. the veggies or the dip).
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>
          <div className="flex-1 space-y-2 overflow-auto p-5">
            {lines.length === 0 && (
              <div className="rounded-lg border-2 border-dashed border-stone-200 p-6 text-center text-sm text-stone-500 dark:border-stone-700">
                No ingredients yet. Click below to add.
              </div>
            )}
            {lines.map((line, i) => (
              <div key={i} className="flex items-center gap-2">
                <select
                  value={line.ingredientId}
                  onChange={(e) => updateLine(i, { ingredientId: e.target.value })}
                  className="flex-1 rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
                >
                  {ingredientsQ.data?.map((ing) => (
                    <option key={ing.id} value={ing.id}>
                      {ing.name}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  step="1"
                  min={1}
                  inputMode="numeric"
                  value={line.qtyPerUnit}
                  onChange={(e) => updateLine(i, { qtyPerUnit: parseInt(e.target.value, 10) || 0 })}
                  className="w-20 rounded-lg border border-stone-300 px-3 py-2 text-right font-mono dark:border-stone-700 dark:bg-stone-800"
                />
                <span className="w-10 text-sm text-stone-500">{ingUnit(line.ingredientId)}</span>
                <select
                  value={line.modifierId ?? ''}
                  onChange={(e) => updateLine(i, { modifierId: e.target.value || null })}
                  className="w-52 rounded-lg border border-stone-300 px-2 py-2 text-sm dark:border-stone-700 dark:bg-stone-800"
                  aria-label="When is this used"
                >
                  <option value="">Always</option>
                  {choices.map((c) => (
                    <option key={c.id} value={c.id}>
                      If {c.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => removeLine(i)}
                  className="rounded p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
                  aria-label="Remove"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            <Button variant="secondary" size="sm" onClick={addLine}>
              <Plus className="h-3 w-3" /> Add ingredient
            </Button>
          </div>
          <footer className="flex justify-end gap-2 border-t border-stone-200 p-5 dark:border-stone-800">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={mut.isPending || lines.some((l) => !l.ingredientId || l.qtyPerUnit <= 0)}
              onClick={() => mut.mutate()}
            >
              {mut.isPending ? 'Saving…' : 'Save recipe'}
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// -----------------------------------------------------------------------------
// Batch recipes — what the kitchen makes itself
// -----------------------------------------------------------------------------

function BatchRecipes() {
  const ingredientsQ = useQuery({
    queryKey: ['inventory', 'ingredients', 'all'],
    queryFn: () => ipc.inventory.listIngredients(),
  });
  const [editing, setEditing] = useState<Ingredient | null>(null);
  const [making, setMaking] = useState<Ingredient | null>(null);
  const [adding, setAdding] = useState('');
  const all = ingredientsQ.data ?? [];
  const made = all.filter((i) => i.batchYield !== null);
  const boughtIn = all.filter((i) => i.batchYield === null);

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-stone-600 dark:text-stone-400">
          Sauces, dough and mixes the kitchen makes. <b>Make a batch</b> takes the inputs out of stock and puts the
          batch in, so menu recipes can use it by the gram.
        </p>
        <div className="flex items-center gap-2">
          <select
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            className="rounded-lg border border-stone-300 px-2 py-1.5 text-sm dark:border-stone-700 dark:bg-stone-800"
          >
            <option value="">New batch recipe for…</option>
            {boughtIn.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
          <Button
            variant="secondary"
            size="sm"
            disabled={!adding}
            onClick={() => setEditing(all.find((i) => i.id === adding) ?? null)}
          >
            <Plus className="h-3 w-3" /> Add
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {made.map((i) => (
          <BatchCard key={i.id} ingredient={i} onEdit={() => setEditing(i)} onMake={() => setMaking(i)} />
        ))}
        {made.length === 0 && (
          <div className="col-span-2 py-6 text-center text-stone-500">No batch recipes yet.</div>
        )}
      </div>
      {editing && <BatchEditor key={editing.id} ingredient={editing} onClose={() => setEditing(null)} />}
      {making && <MakeBatchDialog key={making.id} ingredient={making} onClose={() => setMaking(null)} />}
    </Card>
  );
}

function BatchCard({ ingredient, onEdit, onMake }: { ingredient: Ingredient; onEdit: () => void; onMake: () => void }) {
  const q = useQuery({
    queryKey: ['inventory', 'batch', ingredient.id],
    queryFn: () => ipc.inventory.getBatchRecipe(ingredient.id),
  });
  const r = q.data;
  const perUnit = r && r.batchYield ? r.batchCostCents / r.batchYield : null;
  const [showMethod, setShowMethod] = useState(false);
  return (
    <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-semibold">{ingredient.name}</div>
          <div className="text-xs text-stone-500">
            One batch makes {r?.batchYield ?? '?'} {ingredient.unit} · costs {r ? formatCents(r.batchCostCents) : '…'}
            {perUnit !== null && (
              <> = {formatUnitCost({ unit: ingredient.unit, costPerUnitCents: 0, packSize: r!.batchYield, packPriceCents: r!.batchCostCents })}</>
            )}
          </div>
          <div className="text-xs text-stone-500">
            In stock: {new Intl.NumberFormat('en-PK').format(ingredient.currentQty)} {ingredient.unit}
          </div>
        </div>
        <div className="flex flex-none gap-1">
          <Button variant="secondary" size="sm" onClick={onEdit}>
            <Edit className="h-3 w-3" /> Edit
          </Button>
          <Button variant="primary" size="sm" onClick={onMake}>
            <ChefHat className="h-3 w-3" /> Make a batch
          </Button>
        </div>
      </div>
      <ul className="mt-2 space-y-0.5 text-xs">
        {r?.lines.map((l) => (
          <li key={l.inputIngredientId} className="flex justify-between">
            <span>{l.name}</span>
            <span className="font-mono">
              {l.qty} {l.unit}
            </span>
          </li>
        ))}
      </ul>
      {r?.batchMethod && (
        <div className="mt-2 text-xs">
          <button type="button" className="text-amber-700 underline dark:text-amber-300" onClick={() => setShowMethod((v) => !v)}>
            {showMethod ? 'Hide method' : 'Show method'}
          </button>
          {showMethod && <p className="mt-1 whitespace-pre-line text-stone-600 dark:text-stone-400">{r.batchMethod}</p>}
        </div>
      )}
    </div>
  );
}

function BatchEditor({ ingredient, onClose }: { ingredient: Ingredient; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const ingredientsQ = useQuery({
    queryKey: ['inventory', 'ingredients', 'all'],
    queryFn: () => ipc.inventory.listIngredients(),
  });
  const existingQ = useQuery({
    queryKey: ['inventory', 'batch', ingredient.id],
    queryFn: () => ipc.inventory.getBatchRecipe(ingredient.id),
  });
  const [lines, setLines] = useState<Array<{ inputIngredientId: string; qty: number }>>([]);
  const [yieldQty, setYieldQty] = useState('');
  const [method, setMethod] = useState('');

  useEffect(() => {
    if (!existingQ.data) return;
    setLines(existingQ.data.lines.map((l) => ({ inputIngredientId: l.inputIngredientId, qty: l.qty })));
    setYieldQty(existingQ.data.batchYield ? String(existingQ.data.batchYield) : '');
    setMethod(existingQ.data.batchMethod ?? '');
  }, [existingQ.data]);

  const inputs = (ingredientsQ.data ?? []).filter((i) => i.id !== ingredient.id);
  const mut = useMutation({
    mutationFn: () =>
      ipc.inventory.setBatchRecipe({
        ingredientId: ingredient.id,
        batchYield: parseInt(yieldQty, 10) || null,
        batchMethod: method.trim() || null,
        lines,
      }),
    onSuccess: () => {
      toast({ title: 'Batch recipe saved', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      onClose();
    },
    onError: (e) =>
      toast({ title: 'Save failed', description: e instanceof IpcError ? e.message : String(e), variant: 'error' }),
  });

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[620px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-white shadow-xl dark:bg-stone-900">
          <header className="flex items-center justify-between border-b border-stone-200 p-5 dark:border-stone-800">
            <div>
              <Dialog.Title className="text-lg font-bold">Batch recipe: {ingredient.name}</Dialog.Title>
              <Dialog.Description className="text-xs text-stone-500">
                What ONE batch uses, and how much it makes (in {ingredient.unit}).
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>
          <div className="flex-1 space-y-3 overflow-auto p-5">
            <label className="flex items-center gap-2 text-sm">
              One batch makes
              <input
                type="number"
                min={1}
                step="1"
                value={yieldQty}
                onChange={(e) => setYieldQty(e.target.value)}
                className="w-28 rounded-lg border border-stone-300 px-3 py-2 text-right font-mono dark:border-stone-700 dark:bg-stone-800"
              />
              {ingredient.unit}
            </label>
            {lines.map((line, i) => (
              <div key={i} className="flex items-center gap-2">
                <select
                  value={line.inputIngredientId}
                  onChange={(e) =>
                    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, inputIngredientId: e.target.value } : l)))
                  }
                  className="flex-1 rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
                >
                  {inputs.map((ing) => (
                    <option key={ing.id} value={ing.id}>
                      {ing.name}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min={1}
                  step="1"
                  value={line.qty}
                  onChange={(e) =>
                    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, qty: parseInt(e.target.value, 10) || 0 } : l)))
                  }
                  className="w-24 rounded-lg border border-stone-300 px-3 py-2 text-right font-mono dark:border-stone-700 dark:bg-stone-800"
                />
                <span className="w-10 text-sm text-stone-500">
                  {inputs.find((x) => x.id === line.inputIngredientId)?.unit ?? ''}
                </span>
                <button
                  type="button"
                  onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
                  className="rounded p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
                  aria-label="Remove"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const next = inputs.find((i) => !lines.some((l) => l.inputIngredientId === i.id));
                if (next) setLines((prev) => [...prev, { inputIngredientId: next.id, qty: 1 }]);
              }}
            >
              <Plus className="h-3 w-3" /> Add input
            </Button>
            <label className="block text-sm">
              Method (optional)
              <textarea
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                rows={4}
                className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-800"
              />
            </label>
          </div>
          <footer className="flex justify-end gap-2 border-t border-stone-200 p-5 dark:border-stone-800">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={mut.isPending || lines.some((l) => l.qty <= 0) || (lines.length > 0 && !(parseInt(yieldQty, 10) > 0))}
              onClick={() => mut.mutate()}
            >
              {mut.isPending ? 'Saving…' : 'Save'}
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function MakeBatchDialog({ ingredient, onClose }: { ingredient: Ingredient; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [batches, setBatches] = useState('1');
  const recipeQ = useQuery({
    queryKey: ['inventory', 'batch', ingredient.id],
    queryFn: () => ipc.inventory.getBatchRecipe(ingredient.id),
  });
  const n = parseInt(batches, 10) || 0;
  const r = recipeQ.data;
  const mut = useMutation({
    mutationFn: () => ipc.inventory.makeBatch({ ingredientId: ingredient.id, batches: n }),
    onSuccess: (res) => {
      toast({
        title: `Made ${new Intl.NumberFormat('en-PK').format(res.made)} ${ingredient.unit} of ${ingredient.name}`,
        description: `In stock now: ${new Intl.NumberFormat('en-PK').format(res.resultingQty)} ${ingredient.unit}`,
        variant: 'success',
      });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      onClose();
    },
    onError: (e) =>
      toast({ title: 'Could not record the batch', description: e instanceof IpcError ? e.message : String(e), variant: 'error' }),
  });
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[460px] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-5 shadow-xl dark:bg-stone-900">
          <Dialog.Title className="text-lg font-bold">Make {ingredient.name}</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-stone-500">
            The inputs come out of stock and the batch goes in.
          </Dialog.Description>
          <label className="mt-4 flex items-center gap-2 text-sm">
            Batches
            <input
              type="number"
              min={1}
              max={100}
              step="1"
              value={batches}
              autoFocus
              onChange={(e) => setBatches(e.target.value)}
              className="w-20 rounded-lg border border-stone-300 px-3 py-2 text-right font-mono dark:border-stone-700 dark:bg-stone-800"
            />
            <span className="text-stone-500">
              = {r?.batchYield ? new Intl.NumberFormat('en-PK').format(r.batchYield * n) : '?'} {ingredient.unit}
            </span>
          </label>
          {r && n > 0 && (
            <ul className="mt-3 max-h-48 space-y-0.5 overflow-auto rounded bg-stone-50 p-2 text-xs dark:bg-stone-800/50">
              {r.lines.map((l) => (
                <li key={l.inputIngredientId} className="flex justify-between">
                  <span>{l.name}</span>
                  <span className="font-mono">
                    −{new Intl.NumberFormat('en-PK').format(l.qty * n)} {l.unit}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={mut.isPending || n < 1 || n > 100} onClick={() => mut.mutate()}>
              <ChefHat className="h-4 w-4" /> {mut.isPending ? 'Recording…' : 'Record batch'}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
