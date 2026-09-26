import { useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, cn } from '@cheeseoclock/ui';
import { Bike, Phone, Plus, Undo2, X } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import type { OrderSnapshot } from '@cheeseoclock/shared-types';

interface Props {
  snap: OrderSnapshot;
  onClose: () => void;
  onAssigned: () => void;
}

/**
 * Pick the rider for a delivery (or change the one it has). Free riders come
 * first; a rider already out shows which orders they are carrying. A new
 * rider can be added and assigned in one go. An order already out can also
 * be taken back off its rider (it returns to Ready).
 */
export function AssignRiderDialog({ snap, onClose, onAssigned }: Props) {
  const [addingNew, setAddingNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const { toast } = useToast();
  const currentRiderId = snap.rider?.id ?? null;
  const isOut = snap.order.status === 'out_for_delivery';

  const ridersQ = useQuery({
    queryKey: ['riders', 'active'],
    queryFn: () => ipc.riders.list({ activeOnly: true }),
  });
  // Same key as the board's Delivery filter, so it is usually already cached.
  const deliveriesQ = useQuery({
    queryKey: ['orders', 'active', 'delivery'],
    queryFn: () => ipc.orders.listActive({ mode: 'delivery' }),
  });

  /** riderId → order numbers they are out with right now. */
  const carrying = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const s of deliveriesQ.data ?? []) {
      if (s.order.status !== 'out_for_delivery' || !s.rider || s.order.id === snap.order.id) continue;
      const list = m.get(s.rider.id) ?? [];
      list.push(`#${s.order.orderNumber.split('-').pop() ?? ''}`);
      m.set(s.rider.id, list);
    }
    return m;
  }, [deliveriesQ.data, snap.order.id]);

  const riders = useMemo(
    () =>
      (ridersQ.data ?? [])
        .slice()
        .sort((a, b) => (carrying.get(a.id)?.length ?? 0) - (carrying.get(b.id)?.length ?? 0)),
    [ridersQ.data, carrying],
  );

  const assignMut = useMutation({
    mutationFn: (riderId: string) => ipc.orders.assignRider({ orderId: snap.order.id, riderId }),
    onSuccess: (next) => {
      toast({ title: `Out for delivery with ${next.rider?.name ?? 'the rider'}` });
      onAssigned();
    },
    onError: (e) =>
      toast({ title: 'Could not assign', description: e instanceof Error ? e.message : 'Unknown error', variant: 'error' }),
  });

  const unassignMut = useMutation({
    mutationFn: () => ipc.orders.unassignRider(snap.order.id),
    onSuccess: () => {
      toast({ title: 'Rider taken off — order is back in Ready' });
      onAssigned();
    },
    onError: (e) =>
      toast({ title: 'Could not take the rider off', description: e instanceof Error ? e.message : 'Unknown error', variant: 'error' }),
  });

  const createMut = useMutation({
    mutationFn: () => ipc.riders.create({ name: newName.trim(), phone: newPhone.trim() }),
    // Created — assign straight away.
    onSuccess: (rider) => assignMut.mutate(rider.id),
    onError: (e) =>
      toast({ title: 'Could not add rider', description: e instanceof Error ? e.message : 'Unknown error', variant: 'error' }),
  });

  const busy = assignMut.isPending || unassignMut.isPending || createMut.isPending;

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
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[460px] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-5 shadow-soft-lg dark:bg-stone-900">
          <header className="mb-4 flex items-start justify-between gap-3">
            <div>
              <Dialog.Title className="text-lg font-semibold">
                {currentRiderId ? 'Change rider' : 'Assign a rider'}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-stone-500">
                Order #{snap.order.orderNumber.split('-').pop()} · {snap.customerName ?? 'Walk-in'}
                {snap.rider && ` · now with ${snap.rider.name}`}
              </Dialog.Description>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded p-1 text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800"
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          {!addingNew ? (
            <>
              <div className="max-h-80 overflow-y-auto rounded-xl border border-stone-200 dark:border-stone-700">
                {ridersQ.isLoading ? (
                  <div className="p-6 text-center text-sm text-stone-400">Loading…</div>
                ) : riders.length === 0 ? (
                  <div className="p-6 text-center text-sm text-stone-400">No active riders yet. Add one below.</div>
                ) : (
                  <ul className="divide-y divide-stone-100 dark:divide-stone-700">
                    {riders.map((r) => {
                      const out = carrying.get(r.id) ?? [];
                      const isCurrent = r.id === currentRiderId;
                      return (
                        <li key={r.id}>
                          <button
                            type="button"
                            disabled={busy || isCurrent}
                            onClick={() => assignMut.mutate(r.id)}
                            className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-amber-50 disabled:cursor-default disabled:opacity-60 dark:hover:bg-amber-900/20"
                          >
                            <span className="flex items-center gap-3">
                              <span
                                className={cn(
                                  'flex h-9 w-9 items-center justify-center rounded-lg',
                                  out.length === 0
                                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                                    : 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
                                )}
                              >
                                <Bike className="h-4 w-4" />
                              </span>
                              <span>
                                <span className="block text-sm font-semibold text-stone-800 dark:text-stone-100">{r.name}</span>
                                <span className="flex items-center gap-1 text-xs text-stone-500">
                                  <Phone className="h-3 w-3" />
                                  {r.phone}
                                  <span className={cn('ml-1 font-semibold', out.length === 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-violet-700 dark:text-violet-300')}>
                                    {out.length === 0 ? '· Free' : `· Out with ${out.join(', ')}`}
                                  </span>
                                </span>
                              </span>
                            </span>
                            <span className="text-xs font-semibold uppercase tracking-wider text-amber-600">
                              {isCurrent ? 'Has it' : 'Assign →'}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              <div className="mt-3 flex gap-2">
                <Button variant="secondary" size="sm" className="flex-1" onClick={() => setAddingNew(true)} disabled={busy}>
                  <Plus className="h-3.5 w-3.5" />
                  Add a new rider
                </Button>
                {isOut && currentRiderId && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="flex-1 text-violet-700 dark:text-violet-300"
                    onClick={() => unassignMut.mutate()}
                    disabled={busy}
                    title="The order goes back to Ready"
                  >
                    <Undo2 className="h-3.5 w-3.5" />
                    Take rider off
                  </Button>
                )}
              </div>
            </>
          ) : (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                submitNewRider();
              }}
            >
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-stone-700 dark:text-stone-200">Name</span>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
                  placeholder="e.g. Ali Khan"
                  autoFocus
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-stone-700 dark:text-stone-200">Phone</span>
                <input
                  value={newPhone}
                  onChange={(e) => setNewPhone(e.target.value)}
                  className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
                  placeholder="03001234567"
                  type="tel"
                />
              </label>
              <div className="mt-2 flex gap-2">
                <Button variant="ghost" size="sm" className="flex-1" onClick={() => setAddingNew(false)}>
                  Back
                </Button>
                <Button type="submit" variant="primary" size="sm" className="flex-1" disabled={busy}>
                  {busy ? 'Adding…' : 'Add + Assign'}
                </Button>
              </div>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
