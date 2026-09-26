import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { deliveryFeeText, formatCents, resolveAreaText } from '@cheeseoclock/pos-domain';
import {
  DELIVERY_CITY,
  DELIVERY_ZONES,
  type Customer,
  type CustomerAddress,
  type CustomerListSort,
} from '@cheeseoclock/shared-types';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { Plus, Edit, X, Phone, Mail, MapPin, History, Star, Trash2, Users } from 'lucide-react';
import { askConfirm } from '../../components/confirm/ConfirmHost';
import {
  FilterChips,
  Pagination,
  SearchBox,
  useDebouncedValue,
  useSessionState,
  type ChipOption,
} from '../../components/list';
import { AreaPicker } from './AreaPicker';

/** "all", a whole group ("group:DHA") or one zone ("zone:dha-6"). */
type AreaFilter = 'all' | `group:${'DHA' | 'Clifton'}` | `zone:${string}`;

function zoneIdsFor(filter: AreaFilter): string[] | undefined {
  if (filter === 'all') return undefined;
  if (filter.startsWith('group:')) {
    const group = filter.slice('group:'.length);
    return DELIVERY_ZONES.filter((z) => z.group === group).map((z) => z.id);
  }
  return [filter.slice('zone:'.length)];
}

const SORTS: ReadonlyArray<ChipOption<CustomerListSort>> = [
  { id: 'recent', label: 'Ordered recently' },
  { id: 'orders', label: 'Most orders' },
  { id: 'name', label: 'A–Z' },
];

const dateFmt = new Intl.DateTimeFormat('en-PK', { day: 'numeric', month: 'short', year: 'numeric' });

function shortDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : dateFmt.format(d);
}

/**
 * Customers — phone-first lookup, paged in SQL so the screen stays fast with
 * thousands of regulars. Search finds a name, a phone number (typed any way)
 * or a house number; the area filter uses the same DHA / Clifton list as the
 * till's delivery-area picker.
 */
export function CustomersPage() {
  const [search, setSearch] = useSessionState('cust.q', '');
  const [area, setArea] = useSessionState<AreaFilter>('cust.area', 'all');
  const [sort, setSort] = useSessionState<CustomerListSort>('cust.sort', 'recent');
  const [page, setPage] = useSessionState('cust.page', 1);
  const [pageSize, setPageSize] = useSessionState('cust.size', 50);
  const [editing, setEditing] = useState<Customer | null | 'new'>(null);
  const [detailFor, setDetailFor] = useState<Customer | null>(null);

  const debounced = useDebouncedValue(search.trim(), 250);
  const zoneIds = useMemo(() => zoneIdsFor(area), [area]);

  const q = useQuery({
    queryKey: ['customers', 'page', { search: debounced, area, sort, page, pageSize }],
    queryFn: () =>
      ipc.customers.page({
        ...(debounced ? { search: debounced } : {}),
        ...(zoneIds ? { zoneIds } : {}),
        sort,
        offset: (page - 1) * pageSize,
        limit: pageSize,
      }),
    placeholderData: keepPreviousData,
  });

  const total = q.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  // A filter that shrinks the list must not leave the screen on an empty page 7.
  useEffect(() => {
    if (q.data && page > pageCount) setPage(pageCount);
  }, [q.data, page, pageCount, setPage]);

  const rows = q.data?.rows ?? [];
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, (page - 1) * pageSize + rows.length);
  const filtered = debounced !== '' || area !== 'all';

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Customers</h1>
          <p className="mt-1 text-stone-600 dark:text-stone-400">
            Search by name, phone or house number. Tap a customer for their addresses and orders.
          </p>
        </div>
        <Button variant="primary" onClick={() => setEditing('new')}>
          <Plus className="h-4 w-4" /> Add customer
        </Button>
      </header>

      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <SearchBox
            value={search}
            onChange={(v) => {
              setSearch(v);
              setPage(1);
            }}
            placeholder="Name, phone or house no. (e.g. 0300…, 41-C)"
            label="Search customers"
          />
          <label className="flex items-center gap-1.5 text-sm text-stone-600 dark:text-stone-300">
            <MapPin className="h-4 w-4 text-stone-400" aria-hidden="true" />
            <span className="sr-only">Area</span>
            <select
              value={area}
              onChange={(e) => {
                setArea(e.target.value as AreaFilter);
                setPage(1);
              }}
              aria-label="Filter by delivery area"
              className="h-10 rounded-lg border border-stone-300 bg-white px-2 text-sm dark:border-stone-700 dark:bg-stone-800"
            >
              <option value="all">All areas</option>
              <option value="group:DHA">All of DHA</option>
              <option value="group:Clifton">All of Clifton</option>
              <optgroup label="DHA">
                {DELIVERY_ZONES.filter((z) => z.group === 'DHA').map((z) => (
                  <option key={z.id} value={`zone:${z.id}`}>
                    {z.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Clifton">
                {DELIVERY_ZONES.filter((z) => z.group === 'Clifton').map((z) => (
                  <option key={z.id} value={`zone:${z.id}`}>
                    {z.name}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
        </div>
        <FilterChips
          label="Sort customers"
          options={SORTS}
          value={sort}
          onChange={(s) => {
            setSort(s);
            setPage(1);
          }}
          className="mb-3"
        />

        <div className={cn('overflow-x-auto transition-opacity', q.isFetching && q.isPlaceholderData && 'opacity-60')}>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-stone-500">
              <tr>
                <th className="pb-2">Name</th>
                <th className="pb-2">Phone</th>
                <th className="pb-2">Area</th>
                <th className="pb-2 text-right">Orders</th>
                <th className="pb-2">Last order</th>
                <th className="pb-2 text-right">Points</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr
                  key={c.id}
                  className="cursor-pointer border-t border-stone-100 hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-800"
                  onClick={() => setDetailFor(c)}
                >
                  <td className="py-2">
                    <div className={cn('font-medium', !c.isActive && 'text-stone-400 line-through')}>{c.name}</div>
                    {c.notes && <div className="max-w-[16rem] truncate text-xs text-stone-500">{c.notes}</div>}
                  </td>
                  <td className="py-2 font-mono">{c.phone ?? '—'}</td>
                  <td className="py-2 text-stone-600 dark:text-stone-300">
                    <span className="block max-w-[14rem] truncate" title={c.area ?? undefined}>
                      {c.area ?? '—'}
                    </span>
                  </td>
                  <td className="py-2 text-right font-mono">{c.orderCount}</td>
                  <td className="py-2 text-stone-500">{shortDate(c.lastOrderAt)}</td>
                  <td className="py-2 text-right font-mono">{c.loyaltyPoints}</td>
                  <td className="py-2 text-right">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditing(c);
                      }}
                      className="rounded p-1 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
                      aria-label={`Edit ${c.name}`}
                      title="Edit"
                    >
                      <Edit className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-stone-500">
                    {q.isLoading ? (
                      'Loading…'
                    ) : q.isError ? (
                      'Could not load customers.'
                    ) : filtered ? (
                      <>
                        No customers match.{' '}
                        <button
                          type="button"
                          className="font-semibold text-amber-700 hover:underline dark:text-amber-300"
                          onClick={() => {
                            setSearch('');
                            setArea('all');
                            setPage(1);
                          }}
                        >
                          Clear the search
                        </button>
                      </>
                    ) : (
                      <span className="inline-flex items-center gap-2">
                        <Users className="h-4 w-4" /> No customers yet — they are saved with their first order.
                      </span>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination
          page={Math.min(page, pageCount)}
          pageCount={pageCount}
          total={total}
          from={from}
          to={to}
          onPage={setPage}
          pageSize={pageSize}
          onPageSize={(n) => {
            setPageSize(n);
            setPage(1);
          }}
          noun="customers"
        />
      </Card>

      {editing && (
        <CustomerDialog
          key={editing === 'new' ? 'new' : editing.id}
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {detailFor && (
        <CustomerDetailDialog
          key={detailFor.id}
          customer={detailFor}
          onClose={() => setDetailFor(null)}
          onEdit={() => {
            setEditing(detailFor);
            setDetailFor(null);
          }}
        />
      )}
    </div>
  );
}

export function CustomerDialog({
  existing,
  onClose,
  onCreated,
}: {
  existing: Customer | null;
  onClose: () => void;
  onCreated?: (c: Customer) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState(existing?.name ?? '');
  const [phone, setPhone] = useState(existing?.phone ?? '');
  const [email, setEmail] = useState(existing?.email ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');

  const mut = useMutation({
    mutationFn: () =>
      existing
        ? ipc.customers.update({
            id: existing.id,
            name: name.trim(),
            phone: phone.trim() || null,
            email: email.trim() || null,
            notes: notes.trim() || null,
          })
        : ipc.customers.create({
            name: name.trim(),
            phone: phone.trim() || null,
            email: email.trim() || null,
            notes: notes.trim() || null,
          }),
    onSuccess: (c) => {
      toast({ title: existing ? 'Customer updated' : 'Customer added', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['customers'] });
      if (onCreated) onCreated(c);
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
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[440px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-5 shadow-xl dark:bg-stone-900">
          <header className="mb-4 flex items-center justify-between">
            <Dialog.Title className="text-lg font-bold">
              {existing ? 'Edit customer' : 'New customer'}
            </Dialog.Title>
            <Dialog.Description className="sr-only">Name, phone and notes for this customer.</Dialog.Description>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() && !mut.isPending) mut.mutate();
            }}
          >
            <Field label="Name">
              <input
                type="text"
                value={name}
                autoFocus
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
              />
            </Field>
            <Field label="Phone">
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="0300 1234567"
                className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono dark:border-stone-700 dark:bg-stone-800"
              />
            </Field>
            <Field label="Email (optional)">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
              />
            </Field>
            <Field label="Notes (optional)">
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. regular, likes extra cheese"
                className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
              />
            </Field>
            <footer className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={onClose}>Cancel</Button>
              <Button type="submit" variant="primary" disabled={mut.isPending || !name.trim()}>
                {mut.isPending ? 'Saving…' : 'Save'}
              </Button>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CustomerDetailDialog({
  customer,
  onClose,
  onEdit,
}: {
  customer: Customer;
  onClose: () => void;
  onEdit: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ['customers', 'detail', customer.id], queryFn: () => ipc.customers.get(customer.id) });
  const historyQ = useQuery({
    queryKey: ['customers', 'history', customer.id],
    queryFn: () => ipc.customers.orderHistory(customer.id, 20),
  });
  const [addrOpen, setAddrOpen] = useState(false);
  // The live record (an edit elsewhere may have renamed them).
  const c = q.data ?? customer;

  const setDefaultMut = useMutation({
    mutationFn: (addressId: string) => ipc.customers.setDefaultAddress(addressId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['customers'] }),
    onError: (e) =>
      toast({ title: 'Failed', description: e instanceof Error ? e.message : String(e), variant: 'error' }),
  });
  const deleteAddrMut = useMutation({
    mutationFn: (addressId: string) => ipc.customers.deleteAddress(addressId),
    onSuccess: () => {
      toast({ title: 'Address deleted', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['customers'] });
    },
    onError: (e) =>
      toast({ title: 'Could not delete', description: e instanceof Error ? e.message : String(e), variant: 'error' }),
  });

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[680px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-white shadow-xl dark:bg-stone-900">
          <header className="flex items-start justify-between gap-3 border-b border-stone-200 p-5 dark:border-stone-800">
            <div className="min-w-0">
              <Dialog.Title className="text-lg font-bold">{c.name}</Dialog.Title>
              <Dialog.Description asChild>
                <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-stone-500">
                  {c.phone && (
                    <span className="inline-flex items-center gap-1">
                      <Phone className="h-3 w-3" /> <span className="font-mono">{c.phone}</span>
                    </span>
                  )}
                  {c.email && (
                    <span className="inline-flex items-center gap-1">
                      <Mail className="h-3 w-3" /> {c.email}
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1">
                    <Star className="h-3 w-3" /> {c.loyaltyPoints} pts
                  </span>
                </div>
              </Dialog.Description>
              {c.notes && <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">{c.notes}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button variant="secondary" size="sm" onClick={onEdit}>
                <Edit className="h-3.5 w-3.5" /> Edit
              </Button>
              <Dialog.Close asChild>
                <button type="button" aria-label="Close" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
                  <X className="h-5 w-5" />
                </button>
              </Dialog.Close>
            </div>
          </header>
          <div className="flex-1 overflow-auto p-5">
            <section className="mb-6">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="inline-flex items-center gap-1 font-semibold">
                  <MapPin className="h-4 w-4" /> Addresses
                </h3>
                <Button variant="secondary" size="sm" onClick={() => setAddrOpen(true)}>
                  <Plus className="h-3 w-3" /> Add address
                </Button>
              </div>
              {q.data?.addresses.length ? (
                <ul className="space-y-1">
                  {q.data.addresses.map((a) => {
                    const fee = deliveryFeeText(resolveAreaText(a.area).zoneIds);
                    return (
                      <li
                        key={a.id}
                        className="flex items-center justify-between gap-2 rounded border border-stone-200 p-2 text-sm dark:border-stone-700"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 font-medium">
                            {a.label}
                            {a.isDefault && (
                              <span className="rounded bg-amber-100 px-2 py-0.5 text-[10px] uppercase tracking-wider text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                                default
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-stone-500">
                            {[a.addressLine, a.area, a.city].filter(Boolean).join(', ')}
                          </div>
                          <div className="text-[11px]">
                            {fee ? (
                              <span className="text-emerald-700 dark:text-emerald-300">Delivery {fee}</span>
                            ) : (
                              <span className="text-amber-700 dark:text-amber-300">Area not on the delivery list</span>
                            )}
                            {a.notes && <span className="ml-2 text-stone-400">{a.notes}</span>}
                          </div>
                        </div>
                        <div className="flex shrink-0 gap-1">
                          {!a.isDefault && (
                            <button
                              type="button"
                              onClick={() => setDefaultMut.mutate(a.id)}
                              className="rounded px-2 py-1 text-xs text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
                            >
                              Set default
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              void askConfirm(`Delete this address? ${a.addressLine}`).then((ok) => {
                                if (ok) deleteAddrMut.mutate(a.id);
                              });
                            }}
                            className="rounded p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
                            aria-label="Delete address"
                            title="Delete address"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="text-sm text-stone-500">No addresses on file.</div>
              )}
            </section>

            <section>
              <h3 className="mb-2 inline-flex items-center gap-1 font-semibold">
                <History className="h-4 w-4" /> Order history
              </h3>
              {historyQ.data?.length ? (
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wider text-stone-500">
                    <tr>
                      <th className="pb-2">When</th>
                      <th className="pb-2">Order #</th>
                      <th className="pb-2">Type</th>
                      <th className="pb-2">Status</th>
                      <th className="pb-2 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyQ.data.map((o) => (
                      <tr key={o.orderId} className="border-t border-stone-100 dark:border-stone-800">
                        <td className="py-2 text-stone-500">{new Date(o.createdAt).toLocaleString()}</td>
                        <td className="py-2 font-mono">{o.orderNumber}</td>
                        <td className="py-2 capitalize">{o.mode.replace('_', '-')}</td>
                        <td className="py-2 capitalize text-stone-500">{o.status.replace(/_/g, ' ')}</td>
                        <td className="py-2 text-right font-mono">{formatCents(o.totalCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="text-sm text-stone-500">No orders yet.</div>
              )}
            </section>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
      {addrOpen && <AddressDialog customerId={customer.id} onClose={() => setAddrOpen(false)} />}
    </Dialog.Root>
  );
}

const ADDRESS_LABELS = ['Home', 'Office', 'Other'] as const;

export function AddressDialog({
  customerId,
  onClose,
  onCreated,
}: {
  customerId: string;
  onClose: () => void;
  onCreated?: (a: CustomerAddress) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [label, setLabel] = useState('Home');
  const [addressLine, setAddressLine] = useState('');
  const [area, setArea] = useState('');
  const [notes, setNotes] = useState('');
  const [isDefault, setIsDefault] = useState(true);

  const mut = useMutation({
    mutationFn: () =>
      ipc.customers.createAddress({
        customerId,
        label: label.trim() || 'Home',
        addressLine: addressLine.trim(),
        area: area.trim() || null,
        // Every address the shop delivers to is in Karachi.
        city: DELIVERY_CITY,
        notes: notes.trim() || null,
        isDefault,
      }),
    onSuccess: (a) => {
      toast({ title: 'Address added', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['customers'] });
      if (onCreated) onCreated(a);
      onClose();
    },
    onError: (e) =>
      toast({
        title: 'Failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      }),
  });

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[60] flex max-h-[90vh] w-[480px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-white shadow-xl dark:bg-stone-900">
          <header className="flex items-center justify-between p-5 pb-3">
            <Dialog.Title className="text-lg font-bold">New address</Dialog.Title>
            <Dialog.Description className="sr-only">House and street, then the delivery area.</Dialog.Description>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>
          <div className="flex-1 space-y-3 overflow-y-auto px-5">
            <Field label="Label">
              <div className="flex flex-wrap gap-1.5">
                {ADDRESS_LABELS.map((l) => (
                  <button
                    key={l}
                    type="button"
                    aria-pressed={label === l}
                    onClick={() => setLabel(l)}
                    className={cn(
                      'h-9 rounded-full px-3 text-sm font-medium ring-1',
                      label === l
                        ? 'bg-amber-500 text-stone-900 ring-amber-500'
                        : 'bg-white text-stone-700 ring-stone-200 hover:bg-stone-50 dark:bg-stone-800 dark:text-stone-200 dark:ring-stone-700',
                    )}
                  >
                    {l}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="House and street">
              <input
                type="text"
                value={addressLine}
                autoFocus
                onChange={(e) => setAddressLine(e.target.value)}
                placeholder="House 41-C, Lane 3, Khayaban-e-Bukhari"
                className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
              />
            </Field>
            <Field label="Delivery area">
              <AreaPicker value={area} onChange={setArea} variant="form" />
            </Field>
            <Field label="Delivery notes (optional)">
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. ring upper bell, near the mosque"
                className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
              Use this address first next time (default)
            </label>
          </div>
          <footer className="flex justify-end gap-2 p-5">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={mut.isPending || !addressLine.trim()} onClick={() => mut.mutate()}>
              {mut.isPending ? 'Saving…' : 'Save address'}
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
