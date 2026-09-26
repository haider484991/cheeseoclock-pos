import { useCallback, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import type { Supplier } from '@cheeseoclock/shared-types';
import { Plus, Edit, X, Phone, Mail, MapPin, StickyNote } from 'lucide-react';
import {
  FilterChips,
  Pagination,
  SearchBox,
  compareText,
  useListQuery,
  useSessionState,
  type ChipOption,
} from '../../components/list';

type ActiveFilter = 'active' | 'inactive' | 'all';

const supplierSearchText = (s: Supplier) =>
  [s.name, s.contactPerson, s.phone, s.email, s.address, s.notes].filter(Boolean).join(' · ');
const byName = (a: Supplier, b: Supplier) => compareText(a.name, b.name);

export function SuppliersTab() {
  const q = useQuery({ queryKey: ['inventory', 'suppliers'], queryFn: () => ipc.inventory.listSuppliers() });
  const ingQ = useQuery({ queryKey: ['inventory', 'ingredients', 'all'], queryFn: () => ipc.inventory.listIngredients() });
  const posQ = useQuery({
    queryKey: ['inventory', 'pos', 'list'],
    queryFn: () => ipc.inventory.listPurchaseOrders({ limit: 2000 }),
  });
  const [editing, setEditing] = useState<Supplier | null | 'new'>(null);
  const [active, setActive] = useSessionState<ActiveFilter>('inv.sup.active', 'active');

  const filter = useCallback(
    (s: Supplier) => active === 'all' || (active === 'active' ? s.isActive : !s.isActive),
    [active],
  );
  const list = useListQuery({
    items: q.data,
    searchText: supplierSearchText,
    filter,
    sort: byName,
    persistKey: 'inv.sup',
    defaultPageSize: 25,
    resetPageOn: active,
  });
  const options: ChipOption<ActiveFilter>[] = [
    { id: 'active', label: 'In use', count: list.searched.filter((s) => s.isActive).length },
    { id: 'inactive', label: 'Not in use', count: list.searched.filter((s) => !s.isActive).length },
    { id: 'all', label: 'All', count: list.searched.length },
  ];

  const ingredientCount = (id: string) => (ingQ.data ?? []).filter((i) => i.defaultSupplierId === id).length;
  const openOrders = (id: string) =>
    (posQ.data ?? []).filter(
      (p) => p.supplierId === id && (p.status === 'draft' || p.status === 'ordered' || p.status === 'partial'),
    ).length;

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">Suppliers</h2>
        <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
          <Plus className="h-4 w-4" /> Add supplier
        </Button>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchBox value={list.query} onChange={list.setQuery} placeholder="Search name, phone, contact…" label="Search suppliers" />
        <FilterChips label="Show" options={options} value={active} onChange={setActive} />
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {list.items.map((s) => {
          const ings = ingredientCount(s.id);
          const open = openOrders(s.id);
          return (
            <div
              key={s.id}
              className={cn('rounded-lg border border-stone-200 p-3 dark:border-stone-800', !s.isActive && 'opacity-60')}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2 font-semibold">
                    {s.name}
                    {!s.isActive && (
                      <span className="rounded bg-stone-200 px-1.5 py-0.5 text-[11px] font-medium text-stone-600 dark:bg-stone-700 dark:text-stone-300">
                        not in use
                      </span>
                    )}
                  </div>
                  {s.contactPerson && <div className="text-xs text-stone-500">{s.contactPerson}</div>}
                </div>
                <button
                  type="button"
                  onClick={() => setEditing(s)}
                  className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
                  aria-label={`Edit ${s.name}`}
                  title="Edit"
                >
                  <Edit className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-2 space-y-0.5 text-xs text-stone-600 dark:text-stone-400">
                {s.phone && (
                  <div className="flex items-center gap-1">
                    <Phone className="h-3 w-3" /> <span className="font-mono">{s.phone}</span>
                  </div>
                )}
                {s.email && (
                  <div className="flex items-center gap-1">
                    <Mail className="h-3 w-3" /> {s.email}
                  </div>
                )}
                {s.address && (
                  <div className="flex items-center gap-1">
                    <MapPin className="h-3 w-3" /> {s.address}
                  </div>
                )}
                {s.notes && (
                  <div className="flex items-center gap-1">
                    <StickyNote className="h-3 w-3" /> {s.notes}
                  </div>
                )}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                <span className="rounded bg-stone-100 px-1.5 py-0.5 text-stone-600 dark:bg-stone-800 dark:text-stone-300">
                  {ings} ingredient{ings === 1 ? '' : 's'}
                </span>
                {open > 0 && (
                  <span className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-800 dark:bg-blue-950 dark:text-blue-200">
                    {open} open order{open === 1 ? '' : 's'}
                  </span>
                )}
              </div>
            </div>
          );
        })}
        {list.total === 0 && (
          <div className="col-span-full py-8 text-center text-stone-500">
            {q.isLoading
              ? 'Loading…'
              : (q.data ?? []).length === 0
                ? 'No suppliers yet. Add the people you buy from.'
                : 'No suppliers match.'}
          </div>
        )}
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
        noun={list.total === 1 ? 'supplier' : 'suppliers'}
      />
      {editing && (
        <SupplierDialog key={editing === 'new' ? 'new' : editing.id} existing={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
    </Card>
  );
}

function SupplierDialog({ existing, onClose }: { existing: Supplier | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState(existing?.name ?? '');
  const [contactPerson, setContactPerson] = useState(existing?.contactPerson ?? '');
  const [phone, setPhone] = useState(existing?.phone ?? '');
  const [email, setEmail] = useState(existing?.email ?? '');
  const [address, setAddress] = useState(existing?.address ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [isActive, setIsActive] = useState(existing?.isActive ?? true);

  const text = (v: string) => v.trim() || null;
  const mut = useMutation({
    mutationFn: () =>
      existing
        ? ipc.inventory.updateSupplier({
            id: existing.id,
            name: name.trim(),
            contactPerson: text(contactPerson),
            phone: text(phone),
            email: text(email),
            address: text(address),
            notes: text(notes),
            isActive,
          })
        : ipc.inventory.createSupplier({
            name: name.trim(),
            contactPerson: text(contactPerson),
            phone: text(phone),
            email: text(email),
            address: text(address),
            notes: text(notes),
          }),
    onSuccess: () => {
      toast({ title: existing ? 'Saved' : 'Supplier added', variant: 'success' });
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
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[480px] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-5 shadow-xl dark:bg-stone-900">
          <header className="mb-4 flex items-center justify-between">
            <Dialog.Title className="text-lg font-bold">{existing ? 'Edit supplier' : 'Add supplier'}</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>
          <Dialog.Description className="sr-only">Who you buy from and how to reach them.</Dialog.Description>
          <div className="space-y-3">
            <Field label="Name" htmlFor="sup-name">
              <input
                id="sup-name"
                type="text"
                value={name}
                autoFocus
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
              />
            </Field>
            <Field label="Contact person" htmlFor="sup-contact">
              <input
                id="sup-contact"
                type="text"
                value={contactPerson}
                onChange={(e) => setContactPerson(e.target.value)}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Phone" htmlFor="sup-phone">
                <input
                  id="sup-phone"
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono dark:border-stone-700 dark:bg-stone-800"
                />
              </Field>
              <Field label="Email" htmlFor="sup-email">
                <input
                  id="sup-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
                />
              </Field>
            </div>
            <Field label="Address" htmlFor="sup-address">
              <input
                id="sup-address"
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
              />
            </Field>
            <Field label="Notes" htmlFor="sup-notes">
              <input
                id="sup-notes"
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. delivers Tue and Fri, cash only"
                className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
              />
            </Field>
            {existing && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
                Still buying from them
                <span className="text-xs text-stone-500">(untick to hide from new orders)</span>
              </label>
            )}
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

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block text-xs uppercase tracking-wider text-stone-500">
        {label}
      </label>
      {children}
    </div>
  );
}
