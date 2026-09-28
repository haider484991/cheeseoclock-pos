import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { ipc, IpcError } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import {
  FEE_ITEM_LOCKED_NOTE,
  chargedFeeItemIds,
  type Category,
} from '@cheeseoclock/shared-types';
import { useDeliveryAreas } from '../settings/shop-rules/useShopSetting';
import { Plus, Edit, Trash2, X, Globe } from 'lucide-react';
import { askConfirm } from '../../components/confirm/ConfirmHost';
import { WEBSITE_CHANGE_NOTE } from '../settings/shop-rules/publishWords';

const PALETTE = [
  '#dc2626', '#f59e0b', '#16a34a', '#2563eb',
  '#db2777', '#7c3aed', '#0891b2', '#65a30d',
];

export function CategoriesTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ['menu', 'categories', 'all'], queryFn: () => ipc.menu.listCategories() });
  // Same cache as the Items tab: how many items each category holds.
  const itemsQ = useQuery({ queryKey: ['menu', 'items', 'all'], queryFn: () => ipc.menu.listItems() });
  const itemCounts = useMemo(() => {
    const counts = new Map<string, { all: number; active: number }>();
    for (const i of itemsQ.data ?? []) {
      const c = counts.get(i.categoryId) ?? { all: 0, active: 0 };
      c.all += 1;
      if (i.isActive) c.active += 1;
      counts.set(i.categoryId, c);
    }
    return counts;
  }, [itemsQ.data]);
  // The categories holding a delivery charge that is on and that an area that is on charges:
  // Settings → Delivery areas' — never hidden here (the main process refuses it too).
  const areas = useDeliveryAreas();
  const feeCategories = useMemo(() => {
    const items = itemsQ.data ?? [];
    const charged = chargedFeeItemIds(areas.zones, items);
    return new Set(items.filter((i) => i.isActive && charged.has(i.id)).map((i) => i.categoryId));
  }, [itemsQ.data, areas]);
  // The till shows categories in display order; so does this list.
  const categories = useMemo(
    () => [...(q.data ?? [])].sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name)),
    [q.data],
  );

  const [editing, setEditing] = useState<Category | null | 'new'>(null);

  const deleteMut = useMutation({
    mutationFn: (id: string) => ipc.menu.deleteCategory(id),
    onSuccess: () => {
      toast({ title: 'Category removed', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['menu'] });
    },
    onError: (e: unknown) =>
      toast({
        title: 'Cannot delete',
        description: e instanceof IpcError ? e.message : String(e),
        variant: 'error',
      }),
  });

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">Categories</h2>
        <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
          <Plus className="h-4 w-4" /> Add category
        </Button>
      </div>

      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wider text-stone-500">
          <tr>
            <th className="pb-2">Color</th>
            <th className="pb-2">Name</th>
            <th className="pb-2 text-right">Items</th>
            <th className="pb-2 text-right">Order</th>
            <th className="pb-2">Status</th>
            <th className="pb-2">Website</th>
            <th className="pb-2">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {categories.map((c) => (
            <tr key={c.id} className="border-t border-stone-100 dark:border-stone-800">
              <td className="py-2">
                <span className="inline-block h-5 w-8 rounded" style={{ background: c.colorHex }} />
              </td>
              <td className="py-2 font-medium">{c.name}</td>
              <td className="py-2 text-right font-mono">
                {itemCounts.get(c.id)?.active ?? 0}
                {(itemCounts.get(c.id)?.all ?? 0) > (itemCounts.get(c.id)?.active ?? 0) && (
                  <span className="ml-1 text-xs text-stone-400" title="Hidden items">
                    +{(itemCounts.get(c.id)?.all ?? 0) - (itemCounts.get(c.id)?.active ?? 0)} hidden
                  </span>
                )}
              </td>
              <td className="py-2 text-right font-mono">{c.displayOrder}</td>
              <td className="py-2">
                {c.isActive ? (
                  <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                    Active
                  </span>
                ) : (
                  <span className="rounded bg-stone-200 px-2 py-0.5 text-xs text-stone-600 dark:bg-stone-700 dark:text-stone-300">
                    Inactive
                  </span>
                )}
              </td>
              <td className="py-2">
                {c.isOnWebsite ? (
                  <span className="inline-flex items-center gap-1 rounded bg-sky-50 px-2 py-0.5 text-xs text-sky-800 dark:bg-sky-950 dark:text-sky-200">
                    <Globe className="h-3 w-3" aria-hidden="true" /> On the website
                  </span>
                ) : (
                  <span className="rounded bg-stone-200 px-2 py-0.5 text-xs text-stone-600 dark:bg-stone-700 dark:text-stone-300">
                    Not on the website
                  </span>
                )}
              </td>
              <td className="py-2 text-right">
                <button
                  type="button"
                  onClick={() => setEditing(c)}
                  className="rounded p-1 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
                  aria-label={`Edit ${c.name}`}
                  title="Edit"
                >
                  <Edit className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const n = itemCounts.get(c.id)?.all ?? 0;
                    void askConfirm(
                      n > 0
                        ? `Delete category "${c.name}"? It still has ${n} item${n === 1 ? '' : 's'} — move or delete them first, or hide the category instead (Edit → Inactive).`
                        : `Delete category "${c.name}"?`,
                    ).then((ok) => {
                      if (ok) deleteMut.mutate(c.id);
                    });
                  }}
                  className="rounded p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
                  aria-label={`Delete ${c.name}`}
                  title="Delete"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </td>
            </tr>
          ))}
          {(!q.data || q.data.length === 0) && (
            <tr>
              <td colSpan={7} className="py-6 text-center text-stone-500">
                No categories yet. Click "Add category" to get started.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {editing && (
        <CategoryDialog
          key={editing === 'new' ? 'new' : editing.id}
          existing={editing === 'new' ? null : editing}
          holdsDeliveryCharges={editing !== 'new' && feeCategories.has(editing.id)}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}

function CategoryDialog({
  existing,
  holdsDeliveryCharges = false,
  onClose,
}: {
  existing: Category | null;
  /** It holds a delivery charge that is on: it stays on (the website needs it). */
  holdsDeliveryCharges?: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState(existing?.name ?? '');
  const [displayOrder, setDisplayOrder] = useState(existing?.displayOrder ?? 0);
  const [colorHex, setColorHex] = useState(existing?.colorHex ?? PALETTE[1]!);
  const [isActive, setIsActive] = useState(existing?.isActive ?? true);
  const [isOnWebsite, setIsOnWebsite] = useState(existing?.isOnWebsite ?? true);

  const mut = useMutation({
    mutationFn: () =>
      existing
        ? ipc.menu.updateCategory({
            id: existing.id,
            name,
            displayOrder,
            colorHex,
            isActive,
            // Sent only when changed: a rename leaves the website setting as it is.
            ...(isOnWebsite !== existing.isOnWebsite ? { isOnWebsite } : {}),
          })
        : ipc.menu.createCategory({ name, displayOrder, colorHex, isOnWebsite }),
    onSuccess: () => {
      toast({ title: existing ? 'Category updated' : 'Category created', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['menu'] });
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
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-5 shadow-xl dark:bg-stone-900">
          <header className="mb-4 flex items-center justify-between">
            <Dialog.Title className="text-lg font-bold">
              {existing ? `Edit ${existing.name}` : 'Add category'}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>

          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Display order</label>
                <input
                  type="number"
                  value={displayOrder}
                  onChange={(e) => setDisplayOrder(parseInt(e.target.value, 10) || 0)}
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
                />
              </div>
              {existing && (
                <div>
                  <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Status</label>
                  <label className="flex h-[42px] items-center gap-2">
                    <input
                      type="checkbox"
                      checked={isActive}
                      disabled={holdsDeliveryCharges && isActive}
                      title={holdsDeliveryCharges ? FEE_ITEM_LOCKED_NOTE : undefined}
                      onChange={(e) => setIsActive(e.target.checked)}
                    />
                    {isActive ? 'Active' : 'Inactive'}
                  </label>
                  {holdsDeliveryCharges && <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">{FEE_ITEM_LOCKED_NOTE}</p>}
                </div>
              )}
            </div>
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">On the website</label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={isOnWebsite} onChange={(e) => setIsOnWebsite(e.target.checked)} />
                {isOnWebsite ? 'On the website' : 'Not on the website (the till still sells its items)'}
              </label>
              <p className="mt-1 text-xs text-stone-500">
                Off: none of its items are on the website{holdsDeliveryCharges ? ' — the delivery charges in it still go (the website adds them to the bill)' : ''}. Each item can also be set on its own (Items → the item).{' '}
                {WEBSITE_CHANGE_NOTE}
              </p>
            </div>
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Color</label>
              <div className="flex flex-wrap gap-2">
                {PALETTE.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setColorHex(p)}
                    className={cn(
                      'h-9 w-9 rounded-lg border-2',
                      colorHex === p ? 'border-stone-900 dark:border-white' : 'border-transparent',
                    )}
                    style={{ background: p }}
                    aria-label={p}
                  />
                ))}
              </div>
            </div>
          </div>

          <footer className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={mut.isPending || !name.trim()} onClick={() => mut.mutate()}>
              {mut.isPending ? 'Saving…' : 'Save'}
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
