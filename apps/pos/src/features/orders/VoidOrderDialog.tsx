import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useMutation } from '@tanstack/react-query';
import { Button } from '@cheeseoclock/ui';
import { ShieldAlert, X } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import type { OrderSnapshot } from '@cheeseoclock/shared-types';

interface Props {
  snap: OrderSnapshot;
  onClose: () => void;
  onDone: () => void;
}

/**
 * Cancel an order. Requires a reason + manager PIN (server enforces).
 * Reused from the Live Orders board AND from Order History for unpaid
 * orders that still need to be voided rather than refunded.
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
      toast({ title: 'Order voided' });
      onDone();
    },
    onError: (e) =>
      toast({
        title: 'Could not void',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      }),
  });

  function submit() {
    if (!reason.trim()) {
      toast({ title: 'Reason is required', variant: 'warning' });
      return;
    }
    if (pin.length < 4) {
      toast({ title: 'Manager PIN required', variant: 'warning' });
      return;
    }
    voidMut.mutate();
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-5 shadow-soft-lg dark:bg-stone-900">
          <header className="mb-4 flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-200">
                <ShieldAlert className="h-4 w-4" />
              </span>
              <div>
                <Dialog.Title className="text-lg font-semibold">Cancel order</Dialog.Title>
                <Dialog.Description className="mt-0.5 text-xs text-stone-500">
                  Order #{snap.order.orderNumber.split('-').pop()} ·{' '}
                  {snap.customerName ?? 'Walk-in'} · Rs{' '}
                  {(snap.order.totalCents / 100).toFixed(0)}
                </Dialog.Description>
              </div>
            </div>
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
                Reason
              </span>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                autoFocus
                className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
                placeholder="Customer changed mind, kitchen out of stock…"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-stone-700 dark:text-stone-200">
                Manager PIN
              </span>
              <input
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                type="password"
                inputMode="numeric"
                maxLength={8}
                className="w-full rounded-lg border border-stone-200 px-3 py-2 text-center text-lg font-mono tracking-[0.5em] focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
                placeholder="••••"
              />
            </label>
            <div className="rounded-lg bg-amber-50 p-2.5 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              Voiding is permanent and audited. For a paid order, use{' '}
              <strong>Refund</strong> instead.
            </div>
          </div>

          <div className="mt-5 flex gap-2">
            <Button variant="ghost" size="md" className="flex-1" onClick={onClose}>
              Keep order
            </Button>
            <Button
              variant="danger"
              size="md"
              className="flex-1"
              onClick={submit}
              disabled={voidMut.isPending}
            >
              {voidMut.isPending ? 'Voiding…' : 'Confirm void'}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
