import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, Card } from '@cheeseoclock/ui';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import type { Supplier } from '@cheeseoclock/shared-types';
import { Plus, Edit, X, Phone, Mail, MapPin } from 'lucide-react';

export function SuppliersTab() {
  const q = useQuery({ queryKey: ['inventory', 'suppliers'], queryFn: () => ipc.inventory.listSuppliers() });
  const [editing, setEditing] = useState<Supplier | null | 'new'>(null);

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">Suppliers</h2>
        <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
          <Plus className="h-4 w-4" /> Add supplier
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {(q.data ?? []).map((s) => (
          <div key={s.id} className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
            <div className="flex items-start justify-between">
              <div>
                <div className="font-semibold">{s.name}</div>
                {s.contactPerson && (
                  <div className="text-xs text-stone-500">{s.contactPerson}</div>
                )}
              </div>
              <button
                onClick={() => setEditing(s)}
                className="rounded p-1 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
                aria-label="Edit"
              >
                <Edit className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-2 space-y-0.5 text-xs text-stone-600 dark:text-stone-400">
              {s.phone && (
                <div className="flex items-center gap-1">
                  <Phone className="h-3 w-3" /> {s.phone}
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
            </div>
          </div>
        ))}
        {(!q.data || q.data.length === 0) && (
          <div className="col-span-2 py-6 text-center text-stone-500">No suppliers yet.</div>
        )}
      </div>
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

  const mut = useMutation({
    mutationFn: () =>
      existing
        ? ipc.inventory.updateSupplier({
            id: existing.id,
            name,
            contactPerson: contactPerson || null,
            phone: phone || null,
            email: email || null,
            address: address || null,
          })
        : ipc.inventory.createSupplier({
            name,
            contactPerson: contactPerson || null,
            phone: phone || null,
            email: email || null,
            address: address || null,
          }),
    onSuccess: () => {
      toast({ title: existing ? 'Updated' : 'Created', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['inventory', 'suppliers'] });
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
            <Field label="Contact person">
              <input
                type="text"
                value={contactPerson}
                onChange={(e) => setContactPerson(e.target.value)}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Phone">
                <input
                  type="text"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
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
            </div>
            <Field label="Address">
              <input
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">{label}</label>
      {children}
    </div>
  );
}
