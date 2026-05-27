import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import type { MenuItem } from '@cheeseoclock/shared-types';
import { X, Plus, Trash2, Edit, BookOpen } from 'lucide-react';

export function RecipesTab() {
  const itemsQ = useQuery({ queryKey: ['menu', 'items', 'all'], queryFn: () => ipc.menu.listItems() });
  const catsQ = useQuery({ queryKey: ['menu', 'categories', 'all'], queryFn: () => ipc.menu.listCategories() });
  const [editingItem, setEditingItem] = useState<MenuItem | null>(null);
  const [filter, setFilter] = useState<string | 'all'>('all');

  // For each item, fetch a count of recipe lines so we can show "no recipe" badge.
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
        <ul className="mt-2 space-y-0.5 text-xs">
          {lines.map((l) => (
            <li key={l.id} className="flex justify-between">
              <span>{l.ingredientName}</span>
              <span className="font-mono">
                {l.qtyPerUnit} {l.unit}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-2 inline-flex items-center gap-1 rounded bg-stone-100 px-2 py-0.5 text-xs text-stone-500 dark:bg-stone-800">
          <BookOpen className="h-3 w-3" /> No recipe — won't decrement stock
        </div>
      )}
    </div>
  );
}

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

  const [lines, setLines] = useState<Array<{ ingredientId: string; qtyPerUnit: number }>>([]);

  useEffect(() => {
    if (existingQ.data) {
      setLines(
        existingQ.data.map((l) => ({ ingredientId: l.ingredientId, qtyPerUnit: l.qtyPerUnit })),
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
    const firstUnused = ingredientsQ.data?.find(
      (i) => !lines.some((l) => l.ingredientId === i.id),
    );
    if (!firstUnused) {
      toast({ title: 'No more ingredients to add', variant: 'warning' });
      return;
    }
    setLines((prev) => [...prev, { ingredientId: firstUnused.id, qtyPerUnit: 1 }]);
  }

  function updateLine(i: number, patch: Partial<{ ingredientId: string; qtyPerUnit: number }>) {
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
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-[560px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-white shadow-xl dark:bg-stone-900">
          <header className="flex items-center justify-between border-b border-stone-200 p-5 dark:border-stone-800">
            <div>
              <Dialog.Title className="text-lg font-bold">Recipe for {item.name}</Dialog.Title>
              <Dialog.Description className="text-xs text-stone-500">
                Ingredients consumed per ONE sold unit. Sells will decrement stock automatically.
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
                  step="0.01"
                  value={line.qtyPerUnit}
                  onChange={(e) => updateLine(i, { qtyPerUnit: parseFloat(e.target.value) || 0 })}
                  className="w-24 rounded-lg border border-stone-300 px-3 py-2 text-right font-mono dark:border-stone-700 dark:bg-stone-800"
                />
                <span className="w-12 text-sm text-stone-500">{ingUnit(line.ingredientId)}</span>
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
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
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
