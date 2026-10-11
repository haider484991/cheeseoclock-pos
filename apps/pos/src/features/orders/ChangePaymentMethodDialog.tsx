import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, cn } from '@cheeseoclock/ui';
import { Printer, X } from 'lucide-react';
import { formatCents } from '@cheeseoclock/pos-domain';
import {
  CHANGEABLE_PAYMENT_METHODS,
  type ChangeablePaymentMethod,
  type Payment,
  type PaymentChangeOption,
  type PaymentMethodChanged,
} from '@cheeseoclock/shared-types';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { askManagerSecret } from '../printing/managerApproval';
import { reprintReceipt, reprintToast } from '../printing/reprint';
import { PAYMENT_LABELS } from './historyFilters';
import {
  CHANGE_METHOD_NOTE,
  CHANGE_METHOD_PIN_NOTE,
  CHANGE_METHOD_PIN_WHY,
  CHANGE_METHOD_TITLE,
  CHANGE_REFUND_TITLE,
  changeHandOver,
  methodChangedToast,
} from './paymentMethodWords';

/**
 * Change how one payment of a paid order was paid (v0.7.42 the owner;
 * 0.7.45 the counter too while its shift is open). Each other way shows what
 * the payment comes to that way — the bill is worked out again when its tax
 * depends on how it is paid (Cash Rs 1,150 → Card Rs 1,050) — and the main
 * process says so first (orders:paymentChangePreview). A cashier is asked
 * for a manager's PIN; the main process checks every rule again and refuses
 * foodpanda (paymentMethodWords.ts, payment-method-repo.ts). Once a bill
 * changed, the new one can be printed from here.
 */
export function ChangePaymentMethodDialog({
  orderId,
  orderLabel,
  payment,
  needsManager = false,
  onClose,
}: {
  orderId: string;
  /** "Order #12", for the toast. */
  orderLabel: string;
  payment: Pick<Payment, 'id' | 'method' | 'amountCents'>;
  /** A cashier: a manager's PIN or password is asked before it is saved. */
  needsManager?: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [pick, setPick] = useState<ChangeablePaymentMethod | null>(null);
  // Saved, and the bill changed with it: the new bill can be printed.
  const [done, setDone] = useState<PaymentMethodChanged | null>(null);
  const refund = payment.amountCents < 0;
  const previewQ = useQuery({
    queryKey: ['orders', orderId, 'paymentChangePreview', payment.id],
    queryFn: () => ipc.orders.paymentChangePreview(orderId, payment.id),
  });
  const optionOf = (m: ChangeablePaymentMethod): PaymentChangeOption | null => previewQ.data?.find((o) => o.method === m) ?? null;
  const picked = pick ? optionOf(pick) : null;

  const saveMut = useMutation({
    mutationFn: async (method: ChangeablePaymentMethod) => {
      let approverPin: string | undefined;
      if (needsManager) {
        const secret = await askManagerSecret(CHANGE_METHOD_PIN_WHY, null, null, CHANGE_METHOD_PIN_NOTE);
        if (!secret) throw new Error('Not changed - no manager approval');
        approverPin = secret;
      }
      return ipc.orders.changePaymentMethod({ orderId, paymentId: payment.id, method, ...(approverPin ? { approverPin } : {}) });
    },
    onSuccess: (r, method) => {
      toast({ ...methodChangedToast(orderLabel, payment.method, method, r.closedShift, r.rebilled ?? null), variant: 'success' });
      // The order, the shift's drawer (open or closed) and every report that splits by method.
      for (const key of ['orders', 'shifts', 'reports'] as const) void qc.invalidateQueries({ queryKey: [key] });
      // A bill that changed: stay open to print the new one. Else done.
      if (r.rebilled) setDone(r);
      else onClose();
    },
    onError: (e) => toast({ title: 'Not changed', description: e instanceof Error ? e.message : 'Unknown error', variant: 'error' }),
  });

  const printMut = useMutation({
    mutationFn: () => reprintReceipt(orderId),
    onSuccess: (r) => {
      toast({ title: reprintToast(r), variant: 'success' });
      onClose();
    },
    onError: (e) => toast({ title: 'Not printed', description: e instanceof Error ? e.message : 'Unknown error', variant: 'error' }),
  });

  return (
    <Dialog.Root open onOpenChange={(o) => !o && !saveMut.isPending && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[460px] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-5 shadow-soft-lg dark:bg-stone-900">
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

          {done?.rebilled ? (
            <div className="space-y-3" data-testid="payment-changed">
              <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100">
                Saved. The bill is now <span className="font-mono font-semibold">{formatCents(done.rebilled.totalAfterCents)}</span> (it was{' '}
                <span className="font-mono">{formatCents(done.rebilled.totalBeforeCents)}</span>).
              </p>
              <div className="flex gap-2">
                <Button variant="ghost" size="md" className="flex-1" onClick={onClose} disabled={printMut.isPending}>
                  Done
                </Button>
                <Button variant="primary" size="md" className="flex-1" onClick={() => printMut.mutate()} disabled={printMut.isPending}>
                  <Printer className="mr-1.5 h-4 w-4" />
                  {printMut.isPending ? 'Printing…' : 'Print the new bill'}
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2">
                {CHANGEABLE_PAYMENT_METHODS.map((m) => {
                  const now = m === payment.method;
                  const option = now ? null : optionOf(m);
                  const refused = option !== null && 'refusal' in option;
                  return (
                    <button
                      key={m}
                      type="button"
                      disabled={now || saveMut.isPending || previewQ.isLoading}
                      aria-pressed={pick === m}
                      title={refused ? option.refusal : undefined}
                      onClick={() => setPick(m)}
                      className={cn(
                        'rounded-lg border-2 px-2 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed',
                        now
                          ? 'border-stone-200 bg-stone-100 text-stone-400 dark:border-stone-700 dark:bg-stone-800'
                          : pick === m
                            ? 'border-amber-500 bg-amber-50 dark:bg-amber-950'
                            : 'border-stone-200 hover:border-stone-300 dark:border-stone-700',
                        refused && 'text-stone-400',
                      )}
                    >
                      {PAYMENT_LABELS[m]}
                      {now && <span className="block text-[10px] font-normal">now</span>}
                      {/* What the payment comes to this way (the bill worked out again when the tax differs). */}
                      {option && 'amountCents' in option && (
                        <span className="block font-mono text-[11px] font-normal text-stone-500">
                          {refund ? `− ${formatCents(-option.amountCents)}` : formatCents(option.amountCents)}
                        </span>
                      )}
                      {refused && <span className="block text-[10px] font-normal">can’t</span>}
                    </button>
                  );
                })}
              </div>

              {picked && 'refusal' in picked ? (
                <p role="alert" className="mt-3 text-sm font-semibold text-red-700 dark:text-red-300">
                  {picked.refusal}
                </p>
              ) : picked && 'amountCents' in picked && !refund ? (
                <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-100" data-testid="hand-over">
                  {changeHandOver(payment.method, payment.amountCents, picked.method, picked.amountCents)}
                </p>
              ) : null}
              {previewQ.isError && (
                <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">
                  {previewQ.error instanceof Error ? previewQ.error.message : 'Could not work out the other ways'}
                </p>
              )}

              <p className="mt-3 text-xs text-stone-600 dark:text-stone-300">{CHANGE_METHOD_NOTE}</p>

              <div className="mt-4 flex gap-2">
                <Button variant="ghost" size="md" className="flex-1" onClick={onClose} disabled={saveMut.isPending}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="md"
                  className="flex-1"
                  disabled={!pick || saveMut.isPending || (picked !== null && 'refusal' in picked)}
                  onClick={() => pick && saveMut.mutate(pick)}
                >
                  {saveMut.isPending ? 'Saving…' : pick ? `Change to ${PAYMENT_LABELS[pick]}` : 'Pick how it was paid'}
                </Button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
