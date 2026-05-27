import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useMutation } from '@tanstack/react-query';
import { Button } from '@cheeseoclock/ui';
import { Undo2, X } from 'lucide-react';
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
 * Full refund. Inserts a negative payment for each original payment so the
 * books balance, marks status='refunded', prints a refund receipt.
 * Manager PIN required (server enforces).
 *
 * Partial refunds aren't supported yet; this is a "give them all their money
 * back" path. Adding partial later is mostly UI work — the repo can take a
 * subset/amount.
 */
export function RefundOrderDialog({ snap, onClose, onDone }: Props) {
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const { toast } = useToast();

  const refundMut = useMutation({
    mutationFn: () =>
      ipc.orders.refund({
        orderId: snap.order.id,
        reason: reason.trim(),
        approverPin: pin.trim(),
      }),
    onSuccess: () => {
      toast({ title: 'Refund issued — receipt printed' });
      onDone();
    },
    onError: (e) =>
      toast({
        title: 'Refund failed',
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
    refundMut.mutate();
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[60] w-[460px] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-5 shadow-soft-lg dark:bg-stone-900">
          <header className="mb-4 flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-200">
                <Undo2 className="h-4 w-4" />
              </span>
              <div>
                <Dialog.Title className="text-lg font-semibold">Issue refund</Dialog.Title>
                <Dialog.Description className="mt-0.5 text-xs text-stone-500">
                  Order #{snap.order.orderNumber.split('-').pop()} ·{' '}
                  {snap.customerName ?? 'Walk-in'}
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

          <div className="mb-4 rounded-xl bg-orange-50 px-4 py-3 dark:bg-orange-950/30">
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-orange-700 dark:text-orange-300">
                Refund amount
              </span>
              <span className="font-mono text-2xl font-bold text-orange-900 dark:text-orange-100">
                {formatCents(snap.order.totalCents)}
              </span>
            </div>
            <div className="mt-1 text-xs text-orange-800 dark:text-orange-200">
              Each original payment gets a matching negative entry. For cash
              payments, the drawer pops so you can return notes.
            </div>
          </div>

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
                placeholder="Wrong order delivered, customer unhappy…"
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
          </div>

          <div className="mt-5 flex gap-2">
            <Button variant="ghost" size="md" className="flex-1" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="md"
              className="flex-1"
              onClick={submit}
              disabled={refundMut.isPending}
            >
              {refundMut.isPending ? 'Refunding…' : `Refund ${formatCents(snap.order.totalCents)}`}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
