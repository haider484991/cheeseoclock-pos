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
import { askConfirm } from '../../components/confirm/ConfirmHost';

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
  const fresh = !!preview?.fresh;

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

  // Switch between updating the menu and starting fresh: re-plan the same file.
  const modeMut = useMutation({
    mutationFn: (wantFresh: boolean) => ipc.menu.importPreview(wantFresh),
    onSuccess: (p) => setPreview(p),
    onError: (e) =>
      toast({
        title: 'Could not re-check the file',
        description: e instanceof IpcError ? e.message : String(e),
        variant: 'error',
      }),
  });

  const applyMut = useMutation({
    mutationFn: (asFresh: boolean) => ipc.menu.importApply(asFresh),
    onSuccess: (s, asFresh) => {
      toast({
        title: asFresh ? 'Menu replaced' : 'Menu imported',
        description: asFresh
          ? `${s.removedItems} old items removed; ${s.newItems} items, ${s.newIngredients} ingredients and ${s.recipesSet} recipes loaded. Count your stock next (Inventory).`
          : `${s.newItems} new items, ${s.updatedItems} updated, ${s.recipesSet} recipes, ${s.newIngredients + s.updatedIngredients} ingredients.`,
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
    !fresh &&
    !!s &&
    s.newItems + s.updatedItems + s.newIngredients + s.updatedIngredients + s.newCategories +
      s.choiceGroupsChanged + s.batchRecipesSet === 0;
  const blocked = fresh && (preview?.fresh?.openOrders ?? 0) > 0;
  const busy = pickMut.isPending || modeMut.isPending || applyMut.isPending;
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
              change before anything is saved. <b>Update</b> only adds and changes: nothing is deleted,
              renamed or moved, items not in the file stay as they are, and stock is never added or
              removed (an ingredient kept in kg is switched to grams, the same amount ×1000).{' '}
              <b>Start fresh</b> replaces the whole menu with the file.
            </p>
          </div>
          <Button variant="secondary" onClick={() => pickMut.mutate()} disabled={busy}>
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
                variant={fresh ? 'danger' : 'primary'}
                disabled={busy || nothingToDo || blocked}
                onClick={() => {
                  const f = preview.fresh;
                  const ask = f
                    ? `Replace the WHOLE menu with this file?\n\nRemoved: ${f.items.length} menu items, ${f.categories} categories, ${f.combos} combos, ${f.choiceGroups} choice groups and ${f.ingredients} ingredients, with their recipes and stock counts.\nLoaded: ${s.newItems} items, ${s.newIngredients} ingredients, ${s.recipesSet} recipes.\n\nSales history, customers, users, settings and tax stay. A backup is saved first (Settings → Backups).`
                    : `Apply this menu file?\n\n${s.newItems} new items, ${s.updatedItems} items changed (${s.priceChanges} price changes), ${s.recipesSet} recipes, ${s.newIngredients} new and ${s.updatedIngredients} changed ingredients.`;
                  void askConfirm(ask).then((ok) => {
                    if (ok) applyMut.mutate(fresh);
                  });
                }}
              >
                {applyMut.isPending
                  ? fresh
                    ? 'Replacing…'
                    : 'Importing…'
                  : fresh
                    ? 'Replace the whole menu'
                    : nothingToDo
                      ? 'Nothing to change'
                      : 'Apply import'}
              </Button>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="How to load the file">
              {[
                { value: false, title: 'Update the menu', body: 'Add and change what the file says. Everything else stays.' },
                {
                  value: true,
                  title: 'Start fresh',
                  body: 'Remove the whole menu on this POS, then load the file. Needs the owner login.',
                },
              ].map((o) => (
                <label
                  key={o.title}
                  className={cn(
                    'flex cursor-pointer gap-3 rounded-lg border-2 p-3 text-sm',
                    fresh === o.value
                      ? o.value
                        ? 'border-red-500 bg-red-50 dark:bg-red-950/40'
                        : 'border-amber-500 bg-amber-50 dark:bg-amber-950/40'
                      : 'border-stone-200 dark:border-stone-700',
                  )}
                >
                  <input
                    type="radio"
                    name="import-mode"
                    className="mt-1"
                    checked={fresh === o.value}
                    disabled={busy}
                    onChange={() => modeMut.mutate(o.value)}
                  />
                  <span>
                    <span className="block font-semibold">{o.title}</span>
                    <span className="text-stone-600 dark:text-stone-400">{o.body}</span>
                  </span>
                </label>
              ))}
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              {[
                ['New items', s.newItems],
                ['Items changed', s.updatedItems],
                ['Price changes', s.priceChanges],
                ['Tax changes', s.taxChanges],
                ['Recipes set', s.recipesSet],
                ['New ingredients', s.newIngredients],
                ['Ingredients changed', s.updatedIngredients],
                ['New categories', s.newCategories],
                ['Choice groups', s.choiceGroupsChanged],
                ['Batch recipes', s.batchRecipesSet],
                ['Skipped', s.skipped],
              ].map(([label, n]) => (
                <div key={label} className="rounded-lg bg-stone-50 p-3 dark:bg-stone-800/50">
                  <dt className="text-xs text-stone-500">{label}</dt>
                  <dd className="text-2xl font-bold tabular-nums">{n}</dd>
                </div>
              ))}
            </dl>
            {preview.taxCategoryName && (preview.taxFromFile || s.newItems > 0) && (
              <p className="mt-3 text-xs text-stone-500">
                {preview.taxFromFile ? 'Tax for the file’s items' : 'New items are charged the tax most of the menu uses'}
                : {preview.taxCategoryName}, added on top of the price
                {preview.taxCategoryIsNew ? ' — this tax category will be created.' : '.'}
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

          {preview.fresh && (
            <Card className="border-2 border-red-300 dark:border-red-900">
              <h3 className="flex items-center gap-2 font-semibold text-red-800 dark:text-red-300">
                <AlertTriangle className="h-4 w-4" /> Removed before the file is loaded
              </h3>
              <p className="mt-1 text-sm">
                {preview.fresh.items.length} menu items, {preview.fresh.categories} categories, {preview.fresh.combos} combos,{' '}
                {preview.fresh.choiceGroups} choice groups and {preview.fresh.ingredients} ingredients — with their recipes,
                photos and stock counts. Every ingredient in the file starts at zero stock: count your stock after
                (Inventory). Sales history, customers, users, settings and tax categories stay. A backup is saved first
                (Settings → Backups), so the old menu can be restored.
              </p>
              {preview.fresh.openOrders > 0 && (
                <p className="mt-2 flex items-center gap-2 text-sm font-semibold text-red-700 dark:text-red-400">
                  <AlertTriangle className="h-4 w-4 flex-none" />
                  {preview.fresh.openOrders} unpaid order{preview.fresh.openOrders === 1 ? ' is' : 's are'} still open — take
                  payment or discard {preview.fresh.openOrders === 1 ? 'it' : 'them'} first.
                </p>
              )}
              {preview.fresh.items.length > 0 && (
                <details className="mt-2 text-sm">
                  <summary className="cursor-pointer text-stone-600 dark:text-stone-400">Items removed</summary>
                  <p className="mt-1 text-stone-600 dark:text-stone-400">{preview.fresh.items.join(' · ')}</p>
                </details>
              )}
            </Card>
          )}

          <Card>
            <h3 className="mb-2 font-semibold">Menu items</h3>
            <ItemTable rows={visibleItems} />
          </Card>

          {preview.choiceGroups.length > 0 && (
            <Card>
              <h3 className="mb-2 font-semibold">Choices asked at the till</h3>
              <ul className="space-y-2 text-sm">
                {preview.choiceGroups.map((g) => (
                  <li key={g.name} className="flex flex-wrap items-center gap-2">
                    <Badge action={g.action} />
                    <span className="font-medium">{g.existingName ?? g.name}</span>
                    <span className="text-stone-500">{g.options.join(' · ')}</span>
                    {g.changes.map((c) => (
                      <span key={c} className="text-xs text-stone-700 dark:text-stone-300">{c}</span>
                    ))}
                  </li>
                ))}
              </ul>
            </Card>
          )}

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
