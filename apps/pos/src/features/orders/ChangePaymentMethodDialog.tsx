import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, cn } from '@cheeseoclock/ui';
import { X } from 'lucide-react';
import { formatCents } from '@cheeseoclock/pos-domain';
import { CHANGEABLE_PAYMENT_METHODS, type ChangeablePaymentMethod, type Payment } from '@cheeseoclock/shared-types';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { PAYMENT_LABELS } from './historyFilters';
import { CHANGE_METHOD_NOTE, CHANGE_METHOD_TITLE, CHANGE_REFUND_TITLE, methodChangedToast } from './paymentMethodWords';

/**
 * The owner puts right how one payment of a paid order was paid (v0.7.42):
 * Cash that came by JazzCash, a card slip that was cash. The main process
 * checks the owner's login again and refuses foodpanda (paymentMethodWords.ts,
 * payment-method-repo.ts).
 */
export function ChangePaymentMethodDialog({
  orderId,
  orderLabel,
  payment,
  onClose,
}: {
  orderId: string;
  /** "Order #12", for the toast. */
  orderLabel: string;
  payment: Pick<Payment, 'id' | 'method' | 'amountCents'>;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [pick, setPick] = useState<ChangeablePaymentMethod | null>(null);
  const refund = payment.amountCents < 0;

  const saveMut = useMutation({
    mutationFn: (method: ChangeablePaymentMethod) => ipc.orders.changePaymentMethod({ orderId, paymentId: payment.id, method }),
    onSuccess: (r, method) => {
      toast({ ...methodChangedToast(orderLabel, payment.method, method, r.closedShift), variant: 'success' });
      // The order, the shift's drawer (open or closed) and every report that splits by method.
      for (const key of ['orders', 'shifts', 'reports'] as const) void qc.invalidateQueries({ queryKey: [key] });
      onClose();
    },
    onError: (e) =>
      toast({ title: 'Not changed', description: e instanceof Error ? e.message : 'Unknown error', variant: 'error' }),
  });

  return (
    <Dialog.Root open onOpenChange={(o) => !o && !saveMut.isPending && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[440px] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-5 shadow-soft-lg dark:bg-stone-900">
          <header className="mb-3 flex items-start justify-between gap-3">
            <div>
              <Dialog.Title className="text-lg font-semibold">{refund ? CHANGE_REFUND_TITLE : CHANGE_METHOD_TITLE}</Dialog.Title>
              <Dialog.Description className="mt-0.5 text-sm text-stone-600 dark:text-stone-300">
                {orderLabel} · {refund ? `refund ${formatCents(-payment.amountCents)}` : formatCents(payment.amountCents)} · now{' '}
                <span className="font-semibold">{PAYMENT_LABELS[payment.method]}</span>
              </Dialog.Description>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          <div className="grid grid-cols-3 gap-2">
            {CHANGEABLE_PAYMENT_METHODS.map((m) => {
              const now = m === payment.method;
              return (
                <button
                  key={m}
                  type="button"
                  disabled={now || saveMut.isPending}
                  aria-pressed={pick === m}
                  onClick={() => setPick(m)}
                  className={cn(
                    'rounded-lg border-2 px-2 py-2.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed',
                    now
                      ? 'border-stone-200 bg-stone-100 text-stone-400 dark:border-stone-700 dark:bg-stone-800'
                      : pick === m
                        ? 'border-amber-500 bg-amber-50 dark:bg-amber-950'
                        : 'border-stone-200 hover:border-stone-300 dark:border-stone-700',
                  )}
                >
                  {PAYMENT_LABELS[m]}
                  {now && <span className="block text-[10px] font-normal">now</span>}
                </button>
              );
            })}
          </div>

          <p className="mt-3 text-xs text-stone-600 dark:text-stone-300">{CHANGE_METHOD_NOTE}</p>

          <div className="mt-4 flex gap-2">
            <Button variant="ghost" size="md" className="flex-1" onClick={onClose} disabled={saveMut.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="md"
              className="flex-1"
              disabled={!pick || saveMut.isPending}
              onClick={() => pick && saveMut.mutate(pick)}
            >
              {saveMut.isPending ? 'Saving…' : pick ? `Change to ${PAYMENT_LABELS[pick]}` : 'Pick how it was paid'}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
