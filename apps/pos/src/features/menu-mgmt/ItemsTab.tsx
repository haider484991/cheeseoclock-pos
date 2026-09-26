import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, Card, ImagePicker, cn } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import { ipc, IpcError } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import type { MenuItem, PrepStation } from '@cheeseoclock/shared-types';
import { Plus, Edit, Trash2, X, Eye, EyeOff, ChevronRight } from 'lucide-react';
import { askConfirm } from '../../components/confirm/ConfirmHost';
import {
  FilterChips,
  Pagination,
  SearchBox,
  compareText,
  countBy,
  matchesSearch,
  useListQuery,
  useSessionState,
  type ChipOption,
} from '../../components/list';
import {
  GROUP_KIND_LABEL,
  groupItemName,
  modifierGroupKind,
  modifierGroupSearchText,
  sectionGroupsForItem,
} from './menuLists';

const PREP_STATIONS: PrepStation[] = ['kitchen', 'bar', 'cold'];

type StatusFilter = 'all' | 'active' | 'hidden';

export function ItemsTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [category, setCategory] = useSessionState<string>('menu.items.cat', 'all');
  const [status, setStatus] = useSessionState<StatusFilter>('menu.items.status', 'all');
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

  // Hide an item from the till for tonight (sold out) without deleting it.
  const activeMut = useMutation({
    mutationFn: (v: { id: string; isActive: boolean }) => ipc.menu.updateItem(v),
    onSuccess: (i) => {
      toast({ title: i.isActive ? `${i.name} is back on the till` : `${i.name} is hidden from the till`, variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['menu'] });
    },
    onError: (e) =>
      toast({ title: 'Could not change it', description: e instanceof IpcError ? e.message : String(e), variant: 'error' }),
  });

  const categories = useMemo(() => catQ.data ?? [], [catQ.data]);
  const catById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const catOrder = useMemo(() => new Map(categories.map((c, i) => [c.id, i])), [categories]);

  const filter = useCallback(
    (i: MenuItem) =>
      (category === 'all' || i.categoryId === category) &&
      (status === 'all' || (status === 'active' ? i.isActive : !i.isActive)),
    [category, status],
  );
  // The printed menu's order: category, then the item's own sort order.
  const sort = useCallback(
    (a: MenuItem, b: MenuItem) =>
      (catOrder.get(a.categoryId) ?? 999) - (catOrder.get(b.categoryId) ?? 999) ||
      a.sortOrder - b.sortOrder ||
      compareText(a.name, b.name),
    [catOrder],
  );
  const list = useListQuery({
    items: itemsQ.data,
    searchText: (i) =>
      `${i.name} ${i.description ?? ''} ${i.sku ?? ''} ${i.barcode ?? ''} ${catById.get(i.categoryId)?.name ?? ''}`,
    filter,
    sort,
    persistKey: 'menu.items',
    resetPageOn: [category, status],
  });

  const categoryCounts = useMemo(
    () =>
      countBy(
        list.searched.filter((i) => status === 'all' || (status === 'active' ? i.isActive : !i.isActive)),
        (i) => i.categoryId,
      ),
    [list.searched, status],
  );
  const categoryOptions: ChipOption<string>[] = [
    { id: 'all', label: 'All', count: Object.values(categoryCounts).reduce<number>((a, b) => a + (b ?? 0), 0) },
    ...categories.map((c) => ({ id: c.id, label: c.name, count: categoryCounts[c.id] ?? 0 })),
  ];
  const inCategory = list.searched.filter((i) => category === 'all' || i.categoryId === category);
  const statusOptions: ChipOption<StatusFilter>[] = [
    { id: 'all', label: 'Any status' },
    { id: 'active', label: 'On the till', count: inCategory.filter((i) => i.isActive).length, tone: 'green' },
    { id: 'hidden', label: 'Hidden', count: inCategory.filter((i) => !i.isActive).length },
  ];

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <SearchBox
          value={list.query}
          onChange={list.setQuery}
          placeholder="Search item, description, SKU…"
          label="Search menu items"
        />
        <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
          <Plus className="h-4 w-4" /> Add item
        </Button>
      </div>
      <FilterChips label="Category" options={categoryOptions} value={category} onChange={setCategory} className="mb-2" />
      <FilterChips label="Status" options={statusOptions} value={status} onChange={setStatus} className="mb-3" />

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-stone-500">
            <tr>
              <th className="pb-2">Item</th>
              <th className="pb-2">Category</th>
              <th className="pb-2">Station</th>
              <th className="pb-2 text-right">Price</th>
              <th className="pb-2">Status</th>
              <th className="pb-2">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.items.map((i) => {
              const cat = catById.get(i.categoryId);
              return (
                <tr key={i.id} className={cn('border-t border-stone-100 dark:border-stone-800', !i.isActive && 'text-stone-400')}>
                  <td className="py-2">
                    <button type="button" onClick={() => setEditing(i)} className="text-left font-medium hover:underline">
                      {i.name}
                    </button>
                    {i.description && <div className="max-w-md truncate text-xs text-stone-500">{i.description}</div>}
                  </td>
                  <td className="py-2 text-stone-500">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: cat?.colorHex ?? '#a8a29e' }} aria-hidden="true" />
                      {cat?.name ?? '?'}
                    </span>
                  </td>
                  <td className="py-2 capitalize text-stone-500">{i.prepStation}</td>
                  <td className="py-2 text-right font-mono">{formatCents(i.basePriceCents)}</td>
                  <td className="py-2">
                    <button
                      type="button"
                      disabled={activeMut.isPending}
                      onClick={() => activeMut.mutate({ id: i.id, isActive: !i.isActive })}
                      title={i.isActive ? 'Hide from the till (e.g. sold out)' : 'Put back on the till'}
                      className={cn(
                        'inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs',
                        i.isActive
                          ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200 dark:bg-emerald-950 dark:text-emerald-200'
                          : 'bg-stone-200 text-stone-600 hover:bg-stone-300 dark:bg-stone-700 dark:text-stone-300',
                      )}
                    >
                      {i.isActive ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                      {i.isActive ? 'On the till' : 'Hidden'}
                    </button>
                  </td>
                  <td className="py-2 text-right">
                    <button
                      type="button"
                      onClick={() => setEditing(i)}
                      className="rounded p-1 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
                      aria-label={`Edit ${i.name}`}
                      title="Edit"
                    >
                      <Edit className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void askConfirm(
                          `Delete "${i.name}"? Past orders keep their copy. To take it off the till for a while, use "Hidden" instead.`,
                        ).then((ok) => {
                          if (ok) deleteMut.mutate(i.id);
                        });
                      }}
                      className="rounded p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
                      aria-label={`Delete ${i.name}`}
                      title="Delete"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              );
            })}
            {list.items.length === 0 && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-stone-500">
                  {itemsQ.isLoading ? 'Loading…' : (itemsQ.data?.length ?? 0) === 0 ? 'No items yet — add one, or use Import.' : 'No items match.'}
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
        noun="items"
      />

      {editing && (
        <ItemDialog
          key={editing === 'new' ? 'new' : editing.id}
          existing={editing === 'new' ? null : editing}
          defaultCategoryId={category === 'all' ? undefined : category}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}

function ItemDialog({
  existing,
  defaultCategoryId,
  onClose,
}: {
  existing: MenuItem | null;
  defaultCategoryId?: string;
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
  const [categoryId, setCategoryId] = useState(existing?.categoryId ?? defaultCategoryId ?? '');
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
  const [groupSearch, setGroupSearch] = useState('');

  // Seed attached groups once they load (for existing item edit). Seeding
  // only once lets the user detach the last group without it re-appearing.
  const attachedInitialised = useRef(!existing);
  useEffect(() => {
    if (attachedInitialised.current || !attachedQ.data) return;
    attachedInitialised.current = true;
    setAttachedGroupIds(new Set(attachedQ.data.map((g) => g.id)));
  }, [attachedQ.data]);
  // Saving before an item's groups have loaded would detach them all.
  const groupsReady = !existing || attachedQ.isSuccess;

  // Pick defaults when creating new
  useEffect(() => {
    if (existing) return;
    if (!categoryId && catQ.data?.[0]) setCategoryId(catQ.data[0].id);
    if (!taxCategoryId && taxQ.data?.[0]) setTaxCategoryId(taxQ.data[0].id);
  }, [existing, categoryId, taxCategoryId, catQ.data, taxQ.data]);

  const price = Number(priceRupees);
  const priceValid = priceRupees.trim() !== '' && Number.isFinite(price) && price >= 0;

  const saveMut = useMutation({
    mutationFn: async () => {
      const basePriceCents = Math.round(price * 100);
      let itemId: string;
      if (existing) {
        const updated = await ipc.menu.updateItem({
          id: existing.id,
          name: name.trim(),
          description: description.trim() || null,
          categoryId,
          taxCategoryId,
          basePriceCents,
          prepStation,
          sortOrder,
          sku: sku.trim() || null,
          barcode: barcode.trim() || null,
          imageUrl,
          isActive,
        });
        itemId = updated.id;
      } else {
        const created = await ipc.menu.createItem({
          name: name.trim(),
          description: description.trim() || null,
          categoryId,
          taxCategoryId,
          basePriceCents,
          prepStation,
          sortOrder,
          sku: sku.trim() || null,
          barcode: barcode.trim() || null,
          imageUrl,
        });
        itemId = created.id;
      }
      // Sync attached modifier groups, keeping the item's existing order.
      const previousOrder = new Map<string, number>((attachedQ.data ?? []).map((g) => [g.id, g.sortOrder]));
      const ordered = Array.from(attachedGroupIds).sort(
        (a, b) => (previousOrder.get(a) ?? 1e6) - (previousOrder.get(b) ?? 1e6),
      );
      await ipc.menu.setItemModifierGroups({
        menuItemId: itemId,
        groups: ordered.map((id, i) => ({ modifierGroupId: id, sortOrder: i })),
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

  // Sections are worked out from the groups saved on the item (not the
  // ticks), so ticking a box does not make the row jump to another section.
  const savedGroupIds = useMemo(() => new Set((attachedQ.data ?? []).map((g) => g.id)), [attachedQ.data]);
  const allGroups = modGroupsQ.data ?? [];
  const visibleGroups = groupSearch.trim()
    ? allGroups.filter((g) => matchesSearch(modifierGroupSearchText(g), groupSearch))
    : allGroups;
  const sections = sectionGroupsForItem(visibleGroups, savedGroupIds, existing?.name ?? name);

  const canSave =
    !saveMut.isPending && groupsReady && name.trim() !== '' && !!categoryId && !!taxCategoryId && priceValid;

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[680px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-white shadow-xl dark:bg-stone-900">
          <header className="flex items-center justify-between border-b border-stone-200 p-5 dark:border-stone-800">
            <Dialog.Title className="text-lg font-bold">
              {existing ? `Edit ${existing.name}` : 'Add menu item'}
            </Dialog.Title>
            <Dialog.Description className="sr-only">Name, price, category and choices for this menu item.</Dialog.Description>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
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
              <Field label="Price (Rs)">
                <input
                  type="number"
                  step="any"
                  min="0"
                  inputMode="decimal"
                  value={priceRupees}
                  onChange={(e) => setPriceRupees(e.target.value)}
                  className={cn(
                    'w-full rounded-lg border px-3 py-2 font-mono dark:bg-stone-800',
                    priceValid ? 'border-stone-300 dark:border-stone-700' : 'border-red-400',
                  )}
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
                  {isActive ? 'On the till (customers can order it)' : 'Hidden from the till'}
                </label>
              </Field>
            )}

            <Field label={`Choices (${attachedGroupIds.size} on this item)`}>
              <div className="rounded-lg border border-stone-200 p-2 dark:border-stone-700">
                {allGroups.length === 0 ? (
                  <div className="p-2 text-sm text-stone-500">
                    No choice groups yet — create them in the Choices tab.
                  </div>
                ) : (
                  <>
                    <input
                      type="search"
                      value={groupSearch}
                      onChange={(e) => setGroupSearch(e.target.value)}
                      placeholder="Find a group or an option (e.g. dip, onion)…"
                      aria-label="Search choice groups"
                      className="mb-2 h-9 w-full rounded-md border border-stone-300 px-2 text-sm dark:border-stone-700 dark:bg-stone-800"
                    />
                    {!groupsReady && <div className="p-2 text-sm text-stone-500">Loading this item's choices…</div>}
                    {groupsReady && sections.length === 0 && (
                      <div className="p-2 text-sm text-stone-500">No group matches “{groupSearch}”.</div>
                    )}
                    {groupsReady &&
                      sections.map((s) => (
                        <details key={s.id} open={!s.collapsed || groupSearch.trim() !== ''} className="group/sec mb-1">
                          <summary className="flex cursor-pointer list-none items-center gap-1 rounded px-1 py-1 text-xs font-semibold uppercase tracking-wider text-stone-500 hover:bg-stone-50 dark:hover:bg-stone-800">
                            <ChevronRight className="h-3.5 w-3.5 transition-transform group-open/sec:rotate-90" aria-hidden="true" />
                            {s.title}
                            <span className="font-normal normal-case">({s.groups.length})</span>
                          </summary>
                          {s.groups.map((g) => {
                            const forItem = groupItemName(g.name);
                            return (
                              <label
                                key={g.id}
                                className="flex cursor-pointer items-center gap-2 rounded p-2 hover:bg-stone-50 dark:hover:bg-stone-800"
                              >
                                <input
                                  type="checkbox"
                                  checked={attachedGroupIds.has(g.id)}
                                  onChange={() => toggleGroup(g.id)}
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="font-medium">{g.name}</span>
                                  <span className="ml-2 text-xs text-stone-500">
                                    {GROUP_KIND_LABEL[modifierGroupKind(g)]}
                                    {' · '}
                                    {g.selectionType === 'single'
                                      ? 'choose 1'
                                      : g.minSelect === g.maxSelect
                                        ? `choose ${g.minSelect}`
                                        : `up to ${g.maxSelect}`}
                                    {' · '}
                                    {g.modifiers.length} options
                                  </span>
                                  {forItem && existing && forItem.toLowerCase() !== existing.name.toLowerCase() && attachedGroupIds.has(g.id) && (
                                    <span className="block text-[11px] text-amber-700 dark:text-amber-300">
                                      Made for {forItem} — check it belongs on {existing.name}.
                                    </span>
                                  )}
                                </span>
                              </label>
                            );
                          })}
                        </details>
                      ))}
                  </>
                )}
              </div>
            </Field>
          </div>
          <footer className="flex items-center justify-end gap-2 border-t border-stone-200 p-5 dark:border-stone-800">
            {!priceValid && <span className="mr-auto text-xs text-red-600">Enter a price (0 or more).</span>}
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!canSave} onClick={() => saveMut.mutate()}>
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
      <div className="mb-1 block text-xs uppercase tracking-wider text-stone-500">{label}</div>
      {children}
    </div>
  );
}
