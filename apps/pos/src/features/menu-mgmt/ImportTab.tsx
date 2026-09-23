import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { formatCents, formatPack, formatUnitCost } from '@cheeseoclock/pos-domain';
import type {
  MenuImportAction,
  MenuImportItemPlan,
  MenuImportIngredientPlan,
  MenuImportPreview,
} from '@cheeseoclock/shared-types';
import { ipc, IpcError } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { FileUp, AlertTriangle } from 'lucide-react';

const ACTION_LABEL: Record<MenuImportAction, string> = {
  create: 'New',
  update: 'Changes',
  same: 'No change',
  skip: 'Skipped',
};

const ACTION_CLASS: Record<MenuImportAction, string> = {
  create: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  update: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300',
  same: 'bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-400',
  skip: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
};

function Badge({ action }: { action: MenuImportAction }) {
  return (
    <span className={cn('rounded px-2 py-0.5 text-xs font-semibold', ACTION_CLASS[action])}>
      {ACTION_LABEL[action]}
    </span>
  );
}

/** Menu → Import: load a menu file, read every change, then apply it in one go. */
export function ImportTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [preview, setPreview] = useState<MenuImportPreview | null>(null);
  const [showUnchanged, setShowUnchanged] = useState(false);

  const pickMut = useMutation({
    mutationFn: () => ipc.menu.importPick(),
    onSuccess: (p) => {
      if (p) setPreview(p);
    },
    onError: (e) =>
      toast({
        title: 'Could not read that file',
        description: e instanceof IpcError ? e.message : String(e),
        variant: 'error',
      }),
  });

  const applyMut = useMutation({
    mutationFn: () => ipc.menu.importApply(),
    onSuccess: (s) => {
      toast({
        title: 'Menu imported',
        description: `${s.newItems} new items, ${s.updatedItems} updated, ${s.recipesSet} recipes, ${s.newIngredients + s.updatedIngredients} ingredients.`,
        variant: 'success',
      });
      setPreview(null);
      void qc.invalidateQueries({ queryKey: ['menu'] });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (e) =>
      toast({
        title: 'Import failed — nothing was changed',
        description: e instanceof IpcError ? e.message : String(e),
        variant: 'error',
      }),
  });

  const s = preview?.summary;
  const nothingToDo =
    !!s && s.newItems + s.updatedItems + s.newIngredients + s.updatedIngredients + s.newCategories === 0;
  const visibleItems = (preview?.items ?? []).filter((i) => showUnchanged || i.action !== 'same');
  const visibleIngredients = (preview?.ingredients ?? []).filter(
    (i) => showUnchanged || i.action !== 'same',
  );

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <h2 className="font-semibold">Import a menu file</h2>
            <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
              Loads prices, ingredients and recipes from a menu file (.json). You will see every
              change before anything is saved. Nothing is deleted, renamed or moved; items not in the
              file stay exactly as they are. Stock is never added or removed — an ingredient kept in kg
              is switched to grams (the same amount, ×1000) so recipes can use it.
            </p>
          </div>
          <Button variant="secondary" onClick={() => pickMut.mutate()} disabled={pickMut.isPending || applyMut.isPending}>
            <FileUp className="h-4 w-4" /> {pickMut.isPending ? 'Reading…' : preview ? 'Choose another file…' : 'Choose menu file…'}
          </Button>
        </div>
      </Card>

      {preview && s && (
        <>
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="font-semibold">{preview.fileName}</div>
                {preview.source && <div className="text-xs text-stone-500">{preview.source}</div>}
              </div>
              <Button
                variant="primary"
                disabled={applyMut.isPending || nothingToDo}
                onClick={() => {
                  if (
                    confirm(
                      `Apply this menu file?\n\n${s.newItems} new items, ${s.updatedItems} items changed (${s.priceChanges} price changes), ${s.recipesSet} recipes, ${s.newIngredients} new and ${s.updatedIngredients} changed ingredients.`,
                    )
                  )
                    applyMut.mutate();
                }}
              >
                {applyMut.isPending ? 'Importing…' : nothingToDo ? 'Nothing to change' : 'Apply import'}
              </Button>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              {[
                ['New items', s.newItems],
                ['Items changed', s.updatedItems],
                ['Price changes', s.priceChanges],
                ['Recipes set', s.recipesSet],
                ['New ingredients', s.newIngredients],
                ['Ingredients changed', s.updatedIngredients],
                ['New categories', s.newCategories],
                ['Skipped', s.skipped],
              ].map(([label, n]) => (
                <div key={label} className="rounded-lg bg-stone-50 p-3 dark:bg-stone-800/50">
                  <dt className="text-xs text-stone-500">{label}</dt>
                  <dd className="text-2xl font-bold tabular-nums">{n}</dd>
                </div>
              ))}
            </dl>
            {preview.taxCategoryName && s.newItems > 0 && (
              <p className="mt-3 text-xs text-stone-500">
                New items get the “{preview.taxCategoryName}” tax category, like most of the menu.
              </p>
            )}
            {preview.warnings.map((w) => (
              <p key={w} className="mt-3 flex items-center gap-2 text-sm text-red-700 dark:text-red-400">
                <AlertTriangle className="h-4 w-4 flex-none" /> {w}
              </p>
            ))}
            <label className="mt-4 flex items-center gap-2 text-sm text-stone-600 dark:text-stone-400">
              <input type="checkbox" checked={showUnchanged} onChange={(e) => setShowUnchanged(e.target.checked)} />
              Also show rows with no change
            </label>
          </Card>

          <Card>
            <h3 className="mb-2 font-semibold">Menu items</h3>
            <ItemTable rows={visibleItems} />
          </Card>

          <Card>
            <h3 className="mb-2 font-semibold">Ingredients</h3>
            <IngredientTable rows={visibleIngredients} />
          </Card>

          {preview.categories.some((c) => c.action === 'create') && (
            <Card>
              <h3 className="mb-2 font-semibold">New categories</h3>
              <p className="text-sm">
                {preview.categories.filter((c) => c.action === 'create').map((c) => c.name).join(', ')}
              </p>
            </Card>
          )}

          {preview.untouchedItems.length > 0 && (
            <Card>
              <h3 className="mb-1 font-semibold">Not in the file — left as they are</h3>
              <p className="text-sm text-stone-600 dark:text-stone-400">{preview.untouchedItems.join(' · ')}</p>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function ItemTable({ rows }: { rows: MenuImportItemPlan[] }) {
  if (rows.length === 0) return <p className="text-sm text-stone-500">No changes.</p>;
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs uppercase tracking-wider text-stone-500">
        <tr>
          <th className="pb-2">Item</th>
          <th className="pb-2">Category</th>
          <th className="pb-2 text-right">Price</th>
          <th className="pb-2 pl-4">What happens</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name} className="border-t border-stone-100 align-top dark:border-stone-800">
            <td className="py-2 pr-2">
              <div className="font-medium">{r.existingName ?? r.name}</div>
              {r.existingName && r.existingName !== r.name && (
                <div className="text-xs text-stone-500">file: {r.name}</div>
              )}
            </td>
            <td className="py-2 pr-2 text-stone-600 dark:text-stone-400">{r.categoryName}</td>
            <td className="py-2 text-right font-mono">{formatCents(r.priceCents)}</td>
            <td className="py-2 pl-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge action={r.action} />
                {r.action === 'create' && r.recipeChange === 'set' && (
                  <span className="text-xs text-stone-500">with recipe ({r.recipeLines} lines)</span>
                )}
                {r.changes.map((c) => (
                  <span key={c} className="text-xs text-stone-700 dark:text-stone-300">{c}</span>
                ))}
              </div>
              {r.reason && <div className="mt-1 text-xs text-red-700 dark:text-red-400">{r.reason}</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function IngredientTable({ rows }: { rows: MenuImportIngredientPlan[] }) {
  if (rows.length === 0) return <p className="text-sm text-stone-500">No changes.</p>;
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs uppercase tracking-wider text-stone-500">
        <tr>
          <th className="pb-2">Ingredient</th>
          <th className="pb-2 text-right">Cost</th>
          <th className="pb-2 pl-4">What happens</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name} className="border-t border-stone-100 align-top dark:border-stone-800">
            <td className="py-2 pr-2">
              <div className="font-medium">{r.existingName ?? r.name}</div>
              {r.existingName && r.existingName !== r.name && (
                <div className="text-xs text-stone-500">file: {r.name}</div>
              )}
            </td>
            <td className="py-2 text-right">
              <div className="font-mono">{formatUnitCost(r)}</div>
              {formatPack(r) && <div className="text-xs text-stone-500">{formatPack(r)}</div>}
            </td>
            <td className="py-2 pl-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge action={r.action} />
                {r.changes.map((c) => (
                  <span key={c} className="text-xs text-stone-700 dark:text-stone-300">{c}</span>
                ))}
              </div>
              {r.reason && <div className="mt-1 text-xs text-red-700 dark:text-red-400">{r.reason}</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
