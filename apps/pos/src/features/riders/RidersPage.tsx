import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, cn } from '@cheeseoclock/ui';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Bike,
  CheckCircle2,
  Pencil,
  Phone,
  Plus,
  Trash2,
  UserRoundX,
  X,
} from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import type { Rider } from '@cheeseoclock/shared-types';

/**
 * Riders roster. Cashiers see this list when assigning a delivery; managers
 * use it to add/edit/deactivate riders.
 */
export function RidersPage() {
  const [editing, setEditing] = useState<Rider | null>(null);
  const [showNew, setShowNew] = useState(false);
  const qc = useQueryClient();
  const { toast } = useToast();

  const ridersQ = useQuery({
    queryKey: ['riders', 'all'],
    queryFn: () => ipc.riders.list(),
  });

  const deactivateMut = useMutation({
    mutationFn: (id: string) => ipc.riders.deactivate(id),
    onSuccess: () => {
      toast({ title: 'Rider deactivated' });
      void qc.invalidateQueries({ queryKey: ['riders'] });
    },
    onError: (e) =>
      toast({
        title: 'Could not deactivate',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      }),
  });

  const riders = ridersQ.data ?? [];
  const active = riders.filter((r) => r.isActive);
  const inactive = riders.filter((r) => !r.isActive);

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Riders</h1>
          <p className="mt-1 text-sm text-stone-500">
            Delivery staff who can be assigned to orders. {active.length} active
            {inactive.length > 0 && ` · ${inactive.length} inactive`}.
          </p>
        </div>
        <Button onClick={() => setShowNew(true)}>
          <Plus className="h-4 w-4" />
          Add rider
        </Button>
      </header>

      <Card>
        {ridersQ.isLoading ? (
          <div className="py-10 text-center text-sm text-stone-400">Loading…</div>
        ) : riders.length === 0 ? (
          <div className="py-10 text-center">
            <Bike className="mx-auto mb-3 h-10 w-10 text-stone-300" />
            <p className="text-sm text-stone-500">No riders yet.</p>
            <p className="mt-1 text-xs text-stone-400">
              Add your first delivery person to start assigning orders.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-stone-200 dark:border-stone-700">
            <table className="w-full text-sm">
              <thead className="bg-stone-50 text-left text-xs uppercase tracking-wider text-stone-500 dark:bg-stone-800">
                <tr>
                  <th className="px-4 py-2 font-semibold">Name</th>
                  <th className="px-4 py-2 font-semibold">Phone</th>
                  <th className="px-4 py-2 font-semibold">Notes</th>
                  <th className="px-4 py-2 font-semibold">Status</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100 dark:divide-stone-700">
                {[...active, ...inactive].map((r) => (
                  <tr key={r.id} className={cn(!r.isActive && 'opacity-50')}>
                    <td className="px-4 py-3 font-semibold">
                      <div className="flex items-center gap-2">
                        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                          <Bike className="h-3.5 w-3.5" />
                        </span>
                        {r.name}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-stone-600 dark:text-stone-300">
                      <a
                        href={`tel:${r.phone}`}
                        className="inline-flex items-center gap-1 hover:text-amber-600"
                      >
                        <Phone className="h-3 w-3" />
                        {r.phone}
                      </a>
                    </td>
                    <td className="px-4 py-3 text-stone-500">{r.notes || '—'}</td>
                    <td className="px-4 py-3">
                      {r.isActive ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">
                          <CheckCircle2 className="h-3 w-3" />
                          Active
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2 py-0.5 text-xs font-semibold text-stone-500 ring-1 ring-stone-200">
                          <UserRoundX className="h-3 w-3" />
                          Inactive
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-1">
                        <button
                          onClick={() => setEditing(r)}
                          className="rounded-lg p-1.5 text-stone-500 hover:bg-stone-100 hover:text-stone-900 dark:hover:bg-stone-700"
                          title="Edit"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        {r.isActive && (
                          <button
                            onClick={() => {
                              if (
                                confirm(`Deactivate ${r.name}? They will no longer appear when assigning new deliveries.`)
                              ) {
                                deactivateMut.mutate(r.id);
                              }
                            }}
                            className="rounded-lg p-1.5 text-red-500 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950"
                            title="Deactivate"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {showNew && (
        <RiderDialog
          mode="create"
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            void qc.invalidateQueries({ queryKey: ['riders'] });
          }}
        />
      )}
      {editing && (
        <RiderDialog
          key={editing.id}
          mode="edit"
          existing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void qc.invalidateQueries({ queryKey: ['riders'] });
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RiderDialog — create + edit
// ---------------------------------------------------------------------------

interface RiderDialogProps {
  mode: 'create' | 'edit';
  existing?: Rider;
  onClose: () => void;
  onSaved: () => void;
}

function RiderDialog({ mode, existing, onClose, onSaved }: RiderDialogProps) {
  const [name, setName] = useState(existing?.name ?? '');
  const [phone, setPhone] = useState(existing?.phone ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [isActive, setIsActive] = useState(existing?.isActive ?? true);
  const { toast } = useToast();

  const saveMut = useMutation({
    mutationFn: () => {
      if (mode === 'create') {
        return ipc.riders.create({
          name: name.trim(),
          phone: phone.trim(),
          notes: notes.trim() || null,
        });
      }
      return ipc.riders.update({
        id: existing!.id,
        name: name.trim(),
        phone: phone.trim(),
        notes: notes.trim() || null,
        isActive,
      });
    },
    onSuccess: () => {
      toast({ title: mode === 'create' ? 'Rider added' : 'Rider updated' });
      onSaved();
    },
    onError: (e) =>
      toast({
        title: 'Save failed',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      }),
  });

  function submit() {
    if (!name.trim() || !phone.trim()) {
      toast({ title: 'Name and phone are required', variant: 'warning' });
      return;
    }
    saveMut.mutate();
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-5 shadow-soft-lg dark:bg-stone-900">
          <header className="mb-4 flex items-start justify-between gap-3">
            <Dialog.Title className="text-lg font-semibold">
              {mode === 'create' ? 'Add rider' : 'Edit rider'}
            </Dialog.Title>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800"
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          <div className="space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-stone-700 dark:text-stone-200">
                Name
              </span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
                placeholder="Ali Khan"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-stone-700 dark:text-stone-200">
                Phone
              </span>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                type="tel"
                className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
                placeholder="03001234567"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-stone-700 dark:text-stone-200">
                Notes (optional)
              </span>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
                placeholder="Owns bike, evening shift only…"
              />
            </label>
            {mode === 'edit' && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={isActive}
                  onChange={(e) => setIsActive(e.target.checked)}
                  className="h-4 w-4 rounded border-stone-300 text-amber-500 focus:ring-amber-400"
                />
                <span className="font-medium text-stone-700 dark:text-stone-200">Active</span>
                <span className="text-xs text-stone-400">
                  (inactive riders don't appear in the assignment list)
                </span>
              </label>
            )}
          </div>

          <div className="mt-5 flex gap-2">
            <Button variant="ghost" size="md" className="flex-1" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="md"
              className="flex-1"
              onClick={submit}
              disabled={saveMut.isPending}
            >
              {saveMut.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
