import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, Card, ImagePicker, cn } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import { ipc, IpcError } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import type { MenuItem, PrepStation } from '@cheeseoclock/shared-types';
import { Plus, Edit, Trash2, X } from 'lucide-react';

const PREP_STATIONS: PrepStation[] = ['kitchen', 'bar', 'cold'];

export function ItemsTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [filter, setFilter] = useState<string | 'all'>('all');
  const [editing, setEditing] = useState<MenuItem | null | 'new'>(null);

  const catQ = useQuery({ queryKey: ['menu', 'categories', 'all'], queryFn: () => ipc.menu.listCategories() });
  const itemsQ = useQuery({ queryKey: ['menu', 'items', 'all'], queryFn: () => ipc.menu.listItems() });

  const deleteMut = useMutation({
    mutationFn: (id: string) => ipc.menu.deleteItem(id),
    onSuccess: () => {
      toast({ title: 'Item removed', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['menu'] });
    },
    onError: (e) =>
      toast({
        title: 'Cannot delete',
        description: e instanceof IpcError ? e.message : String(e),
        variant: 'error',
      }),
  });

  const items = (itemsQ.data ?? []).filter((i) => filter === 'all' || i.categoryId === filter);
  const catName = (id: string) => catQ.data?.find((c) => c.id === id)?.name ?? '?';

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setFilter('all')}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-semibold transition-colors',
              filter === 'all'
                ? 'bg-amber-500 text-stone-900'
                : 'bg-stone-100 text-stone-700 hover:bg-stone-200 dark:bg-stone-800 dark:text-stone-300',
            )}
          >
            All
          </button>
          {catQ.data?.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setFilter(c.id)}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-semibold transition-colors',
                filter === c.id
                  ? 'text-stone-900'
                  : 'bg-stone-100 text-stone-700 hover:bg-stone-200 dark:bg-stone-800 dark:text-stone-300',
              )}
              style={filter === c.id ? { background: c.colorHex } : undefined}
            >
              {c.name}
            </button>
          ))}
        </div>
        <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
          <Plus className="h-4 w-4" /> Add item
        </Button>
      </div>

      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wider text-stone-500">
          <tr>
            <th className="pb-2">Item</th>
            <th className="pb-2">Category</th>
            <th className="pb-2">Station</th>
            <th className="pb-2 text-right">Price</th>
            <th className="pb-2">Status</th>
            <th className="pb-2" />
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id} className="border-t border-stone-100 dark:border-stone-800">
              <td className="py-2">
                <div className="font-medium">{i.name}</div>
                {i.description && <div className="text-xs text-stone-500">{i.description}</div>}
              </td>
              <td className="py-2 text-stone-500">{catName(i.categoryId)}</td>
              <td className="py-2 capitalize text-stone-500">{i.prepStation}</td>
              <td className="py-2 text-right font-mono">{formatCents(i.basePriceCents)}</td>
              <td className="py-2">
                {i.isActive ? (
                  <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                    Active
                  </span>
                ) : (
                  <span className="rounded bg-stone-200 px-2 py-0.5 text-xs text-stone-600 dark:bg-stone-700 dark:text-stone-300">
                    Inactive
                  </span>
                )}
              </td>
              <td className="py-2 text-right">
                <button onClick={() => setEditing(i)} className="rounded p-1 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800" aria-label="Edit">
                  <Edit className="h-4 w-4" />
                </button>
                <button
                  onClick={() => {
                    if (confirm(`Delete "${i.name}"?`)) deleteMut.mutate(i.id);
                  }}
                  className="rounded p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
                  aria-label="Delete"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr>
              <td colSpan={6} className="py-6 text-center text-stone-500">
                No items in this view.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {editing && (
        <ItemDialog
          key={editing === 'new' ? 'new' : editing.id}
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}

function ItemDialog({
  existing,
  onClose,
}: {
  existing: MenuItem | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const catQ = useQuery({ queryKey: ['menu', 'categories', 'all'], queryFn: () => ipc.menu.listCategories() });
  const taxQ = useQuery({ queryKey: ['menu', 'taxCategories'], queryFn: () => ipc.menu.listTaxCategories() });
  const modGroupsQ = useQuery({ queryKey: ['menu', 'modifierGroups'], queryFn: () => ipc.menu.listModifierGroups() });
  const attachedQ = useQuery({
    queryKey: ['menu', 'attachedGroups', existing?.id],
    queryFn: () => (existing ? ipc.menu.listModifierGroupsForItem(existing.id) : Promise.resolve([])),
    enabled: !!existing,
  });

  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [categoryId, setCategoryId] = useState(existing?.categoryId ?? '');
  const [taxCategoryId, setTaxCategoryId] = useState(existing?.taxCategoryId ?? '');
  const [priceRupees, setPriceRupees] = useState(((existing?.basePriceCents ?? 0) / 100).toString());
  const [prepStation, setPrepStation] = useState<PrepStation>(existing?.prepStation ?? 'kitchen');
  const [sortOrder, setSortOrder] = useState(existing?.sortOrder ?? 0);
  const [sku, setSku] = useState(existing?.sku ?? '');
  const [barcode, setBarcode] = useState(existing?.barcode ?? '');
  const [isActive, setIsActive] = useState(existing?.isActive ?? true);
  const [imageUrl, setImageUrl] = useState<string | null>(existing?.imageUrl ?? null);
  const [attachedGroupIds, setAttachedGroupIds] = useState<Set<string>>(
    () => new Set(attachedQ.data?.map((g) => g.id) ?? []),
  );

  // Sync attached groups once they load (for existing item edit)
  if (attachedQ.data && attachedGroupIds.size === 0 && attachedQ.data.length > 0) {
    setAttachedGroupIds(new Set(attachedQ.data.map((g) => g.id)));
  }

  // Pick defaults when creating new
  if (!existing && !categoryId && catQ.data && catQ.data[0]) {
    setCategoryId(catQ.data[0].id);
  }
  if (!existing && !taxCategoryId && taxQ.data && taxQ.data[0]) {
    setTaxCategoryId(taxQ.data[0].id);
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      const basePriceCents = Math.round(parseFloat(priceRupees || '0') * 100);
      let itemId: string;
      if (existing) {
        const updated = await ipc.menu.updateItem({
          id: existing.id,
          name,
          description: description || null,
          categoryId,
          taxCategoryId,
          basePriceCents,
          prepStation,
          sortOrder,
          sku: sku || null,
          barcode: barcode || null,
          imageUrl,
          isActive,
        });
        itemId = updated.id;
      } else {
        const created = await ipc.menu.createItem({
          name,
          description: description || null,
          categoryId,
          taxCategoryId,
          basePriceCents,
          prepStation,
          sortOrder,
          sku: sku || null,
          barcode: barcode || null,
          imageUrl,
        });
        itemId = created.id;
      }
      // Sync attached modifier groups
      await ipc.menu.setItemModifierGroups({
        menuItemId: itemId,
        groups: Array.from(attachedGroupIds).map((id, i) => ({ modifierGroupId: id, sortOrder: i })),
      });
    },
    onSuccess: () => {
      toast({ title: existing ? 'Item updated' : 'Item created', variant: 'success' });
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

  function toggleGroup(id: string) {
    setAttachedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[640px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-white shadow-xl dark:bg-stone-900">
          <header className="flex items-center justify-between border-b border-stone-200 p-5 dark:border-stone-800">
            <Dialog.Title className="text-lg font-bold">
              {existing ? `Edit ${existing.name}` : 'Add menu item'}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>
          <div className="flex-1 space-y-3 overflow-auto p-5">
            <Field label="Photo">
              <ImagePicker value={imageUrl} onChange={setImageUrl} emptyLabel="Tap to add a photo" />
            </Field>
            <Field label="Name">
              <input
                type="text"
                value={name}
                autoFocus
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
              />
            </Field>
            <Field label="Description">
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Category">
                <select
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
                >
                  {catQ.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
              <Field label="Tax category">
                <select
                  value={taxCategoryId}
                  onChange={(e) => setTaxCategoryId(e.target.value)}
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
                >
                  {taxQ.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Price (PKR)">
                <input
                  type="number"
                  step="0.01"
                  value={priceRupees}
                  onChange={(e) => setPriceRupees(e.target.value)}
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono dark:border-stone-700 dark:bg-stone-800"
                />
              </Field>
              <Field label="Prep station">
                <select
                  value={prepStation}
                  onChange={(e) => setPrepStation(e.target.value as PrepStation)}
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 capitalize dark:border-stone-700 dark:bg-stone-800"
                >
                  {PREP_STATIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </Field>
              <Field label="Sort order">
                <input
                  type="number"
                  value={sortOrder}
                  onChange={(e) => setSortOrder(parseInt(e.target.value, 10) || 0)}
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="SKU">
                <input
                  type="text"
                  value={sku}
                  onChange={(e) => setSku(e.target.value)}
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono dark:border-stone-700 dark:bg-stone-800"
                />
              </Field>
              <Field label="Barcode">
                <input
                  type="text"
                  value={barcode}
                  onChange={(e) => setBarcode(e.target.value)}
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono dark:border-stone-700 dark:bg-stone-800"
                />
              </Field>
            </div>
            {existing && (
              <Field label="Status">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
                  {isActive ? 'Active (visible in checkout)' : 'Inactive (hidden)'}
                </label>
              </Field>
            )}

            <Field label="Modifier groups">
              <div className="space-y-1 rounded-lg border border-stone-200 p-2 dark:border-stone-700">
                {modGroupsQ.data?.length === 0 && (
                  <div className="text-sm text-stone-500">
                    No modifier groups yet — create them in the Modifiers tab.
                  </div>
                )}
                {modGroupsQ.data?.map((g) => (
                  <label
                    key={g.id}
                    className="flex cursor-pointer items-center gap-2 rounded p-2 hover:bg-stone-50 dark:hover:bg-stone-800"
                  >
                    <input
                      type="checkbox"
                      checked={attachedGroupIds.has(g.id)}
                      onChange={() => toggleGroup(g.id)}
                    />
                    <span className="flex-1">
                      <span className="font-medium">{g.name}</span>
                      <span className="ml-2 text-xs text-stone-500">
                        {g.selectionType === 'single' ? 'Choose 1' : `${g.minSelect}-${g.maxSelect}`}
                        {' · '}
                        {g.modifiers.length} options
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </Field>
          </div>
          <footer className="flex justify-end gap-2 border-t border-stone-200 p-5 dark:border-stone-800">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={saveMut.isPending || !name.trim() || !categoryId || !taxCategoryId}
              onClick={() => saveMut.mutate()}
            >
              {saveMut.isPending ? 'Saving…' : 'Save'}
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">{label}</label>
      {children}
    </div>
  );
}
