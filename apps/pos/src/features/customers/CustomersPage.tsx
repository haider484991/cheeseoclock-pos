import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, Card } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import type { Customer, CustomerAddress } from '@cheeseoclock/shared-types';
import { Plus, Edit, X, Phone, Mail, MapPin, History, Star, Trash2 } from 'lucide-react';

export function CustomersPage() {
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Customer | null | 'new'>(null);
  const [detailFor, setDetailFor] = useState<Customer | null>(null);

  const q = useQuery({
    queryKey: ['customers', search],
    queryFn: () => ipc.customers.list({ search: search || undefined, limit: 200 }),
  });

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Customers</h1>
          <p className="mt-1 text-stone-600 dark:text-stone-400">
            Phone-first lookup. Addresses + order history per customer.
          </p>
        </div>
        <Button variant="primary" onClick={() => setEditing('new')}>
          <Plus className="h-4 w-4" /> Add customer
        </Button>
      </header>

      <Card>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or phone…"
          className="mb-3 w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
        />
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-stone-500">
            <tr>
              <th className="pb-2">Name</th>
              <th className="pb-2">Phone</th>
              <th className="pb-2">Email</th>
              <th className="pb-2 text-right">Loyalty pts</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody>
            {(q.data ?? []).map((c) => (
              <tr
                key={c.id}
                className="cursor-pointer border-t border-stone-100 hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-800"
                onClick={() => setDetailFor(c)}
              >
                <td className="py-2 font-medium">{c.name}</td>
                <td className="py-2 font-mono">{c.phone ?? '—'}</td>
                <td className="py-2 text-stone-500">{c.email ?? '—'}</td>
                <td className="py-2 text-right font-mono">{c.loyaltyPoints}</td>
                <td className="py-2 text-right">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditing(c);
                    }}
                    className="rounded p-1 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
                    aria-label="Edit"
                  >
                    <Edit className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
            {(!q.data || q.data.length === 0) && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-stone-500">
                  {search ? 'No matching customers.' : 'No customers yet.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
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
            name,
            phone: phone || null,
            email: email || null,
            notes: notes || null,
          })
        : ipc.customers.create({
            name,
            phone: phone || null,
            email: email || null,
            notes: notes || null,
          }),
    onSuccess: (c) => {
      toast({ title: existing ? 'Updated' : 'Created', variant: 'success' });
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
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-5 shadow-xl dark:bg-stone-900">
          <header className="mb-4 flex items-center justify-between">
            <Dialog.Title className="text-lg font-bold">
              {existing ? 'Edit customer' : 'New customer'}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>
          <div className="space-y-3">
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
                placeholder="+92 300 1234567"
                className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono dark:border-stone-700 dark:bg-stone-800"
              />
            </Field>
            <Field label="Email">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
              />
            </Field>
            <Field label="Notes">
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
              />
            </Field>
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

function CustomerDetailDialog({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ['customers', 'detail', customer.id], queryFn: () => ipc.customers.get(customer.id) });
  const historyQ = useQuery({
    queryKey: ['customers', 'history', customer.id],
    queryFn: () => ipc.customers.orderHistory(customer.id, 20),
  });
  const [addrOpen, setAddrOpen] = useState(false);

  const setDefaultMut = useMutation({
    mutationFn: (addressId: string) => ipc.customers.setDefaultAddress(addressId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['customers'] }),
    onError: (e) =>
      toast({ title: 'Failed', description: e instanceof Error ? e.message : String(e), variant: 'error' }),
  });
  const deleteAddrMut = useMutation({
    mutationFn: (addressId: string) => ipc.customers.deleteAddress(addressId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['customers'] }),
  });

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[680px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-white shadow-xl dark:bg-stone-900">
          <header className="flex items-center justify-between border-b border-stone-200 p-5 dark:border-stone-800">
            <div>
              <Dialog.Title className="text-lg font-bold">{customer.name}</Dialog.Title>
              <div className="mt-1 flex items-center gap-3 text-sm text-stone-500">
                {customer.phone && (
                  <span className="inline-flex items-center gap-1">
                    <Phone className="h-3 w-3" /> {customer.phone}
                  </span>
                )}
                {customer.email && (
                  <span className="inline-flex items-center gap-1">
                    <Mail className="h-3 w-3" /> {customer.email}
                  </span>
                )}
                <span className="inline-flex items-center gap-1">
                  <Star className="h-3 w-3" /> {customer.loyaltyPoints} pts
                </span>
              </div>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>
          <div className="flex-1 overflow-auto p-5">
            <section className="mb-6">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="font-semibold inline-flex items-center gap-1">
                  <MapPin className="h-4 w-4" /> Addresses
                </h3>
                <Button variant="secondary" size="sm" onClick={() => setAddrOpen(true)}>
                  <Plus className="h-3 w-3" /> Add address
                </Button>
              </div>
              {q.data?.addresses.length ? (
                <ul className="space-y-1">
                  {q.data.addresses.map((a) => (
                    <li
                      key={a.id}
                      className="flex items-center justify-between rounded border border-stone-200 p-2 text-sm dark:border-stone-700"
                    >
                      <div>
                        <div className="flex items-center gap-2 font-medium">
                          {a.label}
                          {a.isDefault && (
                            <span className="rounded bg-amber-100 px-2 py-0.5 text-[10px] uppercase tracking-wider text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                              default
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-stone-500">
                          {a.addressLine}
                          {a.area ? `, ${a.area}` : ''}
                          {a.city ? `, ${a.city}` : ''}
                        </div>
                      </div>
                      <div className="flex gap-1">
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
                            if (confirm('Delete address?')) deleteAddrMut.mutate(a.id);
                          }}
                          className="rounded p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
                          aria-label="Delete"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-sm text-stone-500">No addresses on file.</div>
              )}
            </section>

            <section>
              <h3 className="mb-2 font-semibold inline-flex items-center gap-1">
                <History className="h-4 w-4" /> Order history
              </h3>
              {historyQ.data?.length ? (
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wider text-stone-500">
                    <tr>
                      <th className="pb-2">When</th>
                      <th className="pb-2">Order #</th>
                      <th className="pb-2 capitalize">Mode</th>
                      <th className="pb-2">Status</th>
                      <th className="pb-2 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyQ.data.map((o) => (
                      <tr key={o.orderId} className="border-t border-stone-100 dark:border-stone-800">
                        <td className="py-2 text-stone-500">
                          {new Date(o.createdAt).toLocaleString()}
                        </td>
                        <td className="py-2 font-mono">{o.orderNumber}</td>
                        <td className="py-2 capitalize">{o.mode.replace('_', '-')}</td>
                        <td className="py-2 text-stone-500">{o.status}</td>
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
      {addrOpen && (
        <AddressDialog customerId={customer.id} onClose={() => setAddrOpen(false)} />
      )}
    </Dialog.Root>
  );
}

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
  const [city, setCity] = useState('');
  const [notes, setNotes] = useState('');
  const [isDefault, setIsDefault] = useState(true);

  const mut = useMutation({
    mutationFn: () =>
      ipc.customers.createAddress({
        customerId,
        label,
        addressLine,
        area: area || null,
        city: city || null,
        notes: notes || null,
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
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[60] w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-5 shadow-xl dark:bg-stone-900">
          <header className="mb-4 flex items-center justify-between">
            <Dialog.Title className="text-lg font-bold">New address</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>
          <div className="space-y-3">
            <Field label="Label">
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
              />
            </Field>
            <Field label="Address line">
              <input
                type="text"
                value={addressLine}
                autoFocus
                onChange={(e) => setAddressLine(e.target.value)}
                placeholder="House 12, Street 4"
                className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Area / sector">
                <input
                  type="text"
                  value={area}
                  onChange={(e) => setArea(e.target.value)}
                  placeholder="F-10"
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
                />
              </Field>
              <Field label="City">
                <input
                  type="text"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="Islamabad"
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
                />
              </Field>
            </div>
            <Field label="Delivery notes">
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. ring upper bell"
                className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
              Set as default address
            </label>
          </div>
          <footer className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={mut.isPending || !addressLine.trim()} onClick={() => mut.mutate()}>
              {mut.isPending ? 'Saving…' : 'Save'}
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
