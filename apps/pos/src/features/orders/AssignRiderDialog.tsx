import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button } from '@cheeseoclock/ui';
import { Bike, Phone, Plus, X } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import type { OrderSnapshot } from '@cheeseoclock/shared-types';

interface Props {
  snap: OrderSnapshot;
  onClose: () => void;
  onAssigned: () => void;
}

/**
 * Modal to assign a rider to a delivery order. Lists active riders and lets
 * the dispatcher pick one — or quickly add a new rider inline if they're
 * not in the roster yet.
 */
export function AssignRiderDialog({ snap, onClose, onAssigned }: Props) {
  const [addingNew, setAddingNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const { toast } = useToast();

  const ridersQ = useQuery({
    queryKey: ['riders', 'active'],
    queryFn: () => ipc.riders.list({ activeOnly: true }),
  });

  const assignMut = useMutation({
    mutationFn: (riderId: string) =>
      ipc.orders.assignRider({ orderId: snap.order.id, riderId }),
    onSuccess: () => {
      toast({ title: 'Rider assigned — order is out for delivery' });
      onAssigned();
    },
    onError: (e) =>
      toast({
        title: 'Assign failed',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      }),
  });

  const createMut = useMutation({
    mutationFn: () => ipc.riders.create({ name: newName.trim(), phone: newPhone.trim() }),
    onSuccess: (rider) => {
      // Created — assign immediately.
      assignMut.mutate(rider.id);
    },
    onError: (e) =>
      toast({
        title: 'Could not add rider',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      }),
  });

  function submitNewRider() {
    if (!newName.trim() || !newPhone.trim()) {
      toast({ title: 'Name and phone are required', variant: 'warning' });
      return;
    }
    createMut.mutate();
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[460px] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-5 shadow-soft-lg dark:bg-stone-900">
          <header className="mb-4 flex items-start justify-between gap-3">
            <div>
              <Dialog.Title className="text-lg font-semibold">Assign a rider</Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-stone-500">
                Order #{snap.order.orderNumber.split('-').pop()} ·{' '}
                {snap.customerName ?? 'Walk-in'}
              </Dialog.Description>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800"
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          {!addingNew ? (
            <>
              <div className="max-h-72 overflow-y-auto rounded-xl border border-stone-200 dark:border-stone-700">
                {ridersQ.isLoading ? (
                  <div className="p-6 text-center text-sm text-stone-400">Loading…</div>
                ) : (ridersQ.data ?? []).length === 0 ? (
                  <div className="p-6 text-center text-sm text-stone-400">
                    No active riders yet. Add one below.
                  </div>
                ) : (
                  <ul className="divide-y divide-stone-100 dark:divide-stone-700">
                    {(ridersQ.data ?? []).map((r) => (
                      <li key={r.id}>
                        <button
                          type="button"
                          disabled={assignMut.isPending}
                          onClick={() => assignMut.mutate(r.id)}
                          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-amber-50 disabled:opacity-50 dark:hover:bg-amber-900/20"
                        >
                          <span className="flex items-center gap-3">
                            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                              <Bike className="h-4 w-4" />
                            </span>
                            <span>
                              <span className="block text-sm font-semibold text-stone-800 dark:text-stone-100">
                                {r.name}
                              </span>
                              <span className="flex items-center gap-1 text-xs text-stone-500">
                                <Phone className="h-3 w-3" />
                                {r.phone}
                              </span>
                            </span>
                          </span>
                          <span className="text-xs font-semibold uppercase tracking-wider text-amber-600">
                            Assign →
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <Button
                variant="secondary"
                size="sm"
                className="mt-3 w-full"
                onClick={() => setAddingNew(true)}
              >
                <Plus className="h-3.5 w-3.5" />
                Add a new rider
              </Button>
            </>
          ) : (
            <div className="space-y-3">
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-stone-700 dark:text-stone-200">
                  Name
                </span>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
                  placeholder="e.g. Ali Khan"
                  autoFocus
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-stone-700 dark:text-stone-200">
                  Phone
                </span>
                <input
                  value={newPhone}
                  onChange={(e) => setNewPhone(e.target.value)}
                  className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
                  placeholder="03001234567"
                  type="tel"
                />
              </label>
              <div className="mt-2 flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="flex-1"
                  onClick={() => setAddingNew(false)}
                >
                  Back
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  className="flex-1"
                  onClick={submitNewRider}
                  disabled={createMut.isPending || assignMut.isPending}
                >
                  {createMut.isPending || assignMut.isPending
                    ? 'Adding…'
                    : 'Add + Assign'}
                </Button>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
