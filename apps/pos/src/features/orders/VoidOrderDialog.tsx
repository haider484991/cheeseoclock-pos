import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useMutation } from '@tanstack/react-query';
import { Button } from '@cheeseoclock/ui';
import { ShieldAlert, X } from 'lucide-react';
import { formatCents } from '@cheeseoclock/pos-domain';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import type { OrderSnapshot } from '@cheeseoclock/shared-types';

interface Props {
  snap: OrderSnapshot;
  onClose: () => void;
  onDone: () => void;
}

/**
 * Cancel (void) an unpaid order. Needs a reason + manager PIN (the server
 * checks both). Used from the Live Orders board and from Order History; a
 * paid order is refunded instead. Enter confirms.
 */
export function VoidOrderDialog({ snap, onClose, onDone }: Props) {
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const { toast } = useToast();

  const voidMut = useMutation({
    mutationFn: () =>
      ipc.orders.void({
        orderId: snap.order.id,
        reason: reason.trim(),
        approverPin: pin.trim(),
      }),
    onSuccess: () => {
      toast({ title: 'Order cancelled' });
      onDone();
    },
    onError: (e) =>
      toast({
        title: 'Could not cancel',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      }),
  });

  function submit() {
    if (voidMut.isPending) return;
    if (!reason.trim()) {
      toast({ title: 'Say why it is cancelled', variant: 'warning' });
      return;
    }
    if (pin.length < 4) {
      toast({ title: 'Manager PIN needed', variant: 'warning' });
      return;
    }
    voidMut.mutate();
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[440px] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-5 shadow-soft-lg dark:bg-stone-900">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <header className="mb-4 flex items-start justify-between gap-3">
              <div className="flex items-start gap-2">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-200">
                  <ShieldAlert className="h-4 w-4" />
                </span>
                <div>
                  <Dialog.Title className="text-lg font-semibold">Cancel order</Dialog.Title>
                  <Dialog.Description className="mt-0.5 text-xs text-stone-500">
                    Order #{snap.order.orderNumber.split('-').pop()} · {snap.customerName ?? 'Walk-in'} ·{' '}
                    {formatCents(snap.order.totalCents)}
                  </Dialog.Description>
                </div>
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

            <div className="space-y-3">
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-stone-700 dark:text-stone-200">Reason</span>
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  autoFocus
                  className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
                  placeholder="Customer changed mind, out of stock…"
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-stone-700 dark:text-stone-200">Manager PIN</span>
                <input
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={8}
                  className="w-full rounded-lg border border-stone-200 px-3 py-2 text-center font-mono text-lg tracking-[0.5em] focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
                  placeholder="••••"
                />
              </label>
              <div className="rounded-lg bg-amber-50 p-2.5 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                Cancelling can't be undone and is recorded with the manager's name. If the customer already
                paid, use <strong>Refund</strong> instead.
              </div>
            </div>

            <div className="mt-5 flex gap-2">
              <Button type="button" variant="ghost" size="md" className="flex-1" onClick={onClose}>
                Keep order
              </Button>
              <Button type="submit" variant="danger" size="md" className="flex-1" disabled={voidMut.isPending}>
                {voidMut.isPending ? 'Cancelling…' : 'Cancel order'}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
