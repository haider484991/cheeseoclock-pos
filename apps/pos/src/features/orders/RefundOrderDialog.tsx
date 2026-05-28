import { useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useMutation } from '@tanstack/react-query';
import { Button, cn } from '@cheeseoclock/ui';
import { Undo2, X } from 'lucide-react';
import { formatCents } from '@cheeseoclock/pos-domain';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import type { OrderSnapshot, PaymentMethod } from '@cheeseoclock/shared-types';

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
  // Compute remaining refundable balance from the payments ledger (mirrors
  // the backend rule — sum of all payment amounts, positive minus negative).
  const remainingCents = useMemo(
    () => snap.payments.reduce((s, p) => s + p.amountCents, 0),
    [snap.payments],
  );
  const positivePayments = snap.payments.filter((p) => p.amountCents > 0);
  const dominantMethod: PaymentMethod =
    positivePayments.slice().sort((a, b) => b.amountCents - a.amountCents)[0]?.method ??
    'cash';

  const [mode, setMode] = useState<'full' | 'partial'>('full');
  const [partialStr, setPartialStr] = useState((remainingCents / 100).toFixed(2));
  const [method, setMethod] = useState<PaymentMethod>(dominantMethod);
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const { toast } = useToast();

  const partialCents = mode === 'partial' ? Math.round((parseFloat(partialStr) || 0) * 100) : 0;
  const refundAmountCents = mode === 'full' ? remainingCents : partialCents;

  const refundMut = useMutation({
    mutationFn: () =>
      ipc.orders.refund({
        orderId: snap.order.id,
        reason: reason.trim(),
        approverPin: pin.trim(),
        ...(mode === 'partial'
          ? { amountCents: partialCents, method }
          : {}),
      }),
    onSuccess: () => {
      toast({
        title: mode === 'full' ? 'Full refund issued' : 'Partial refund issued',
        description: 'Receipt sent to printer',
      });
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
    if (mode === 'partial') {
      if (partialCents <= 0) {
        toast({ title: 'Enter a positive refund amount', variant: 'warning' });
        return;
      }
      if (partialCents > remainingCents) {
        toast({
          title: 'Amount exceeds remaining balance',
          description: `Max refundable: ${formatCents(remainingCents)}`,
          variant: 'warning',
        });
        return;
      }
    }
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

  const methods: Array<{ key: PaymentMethod; label: string }> = [
    { key: 'cash', label: 'Cash' },
    { key: 'card', label: 'Card' },
    { key: 'easypaisa', label: 'EasyPaisa' },
    { key: 'jazzcash', label: 'JazzCash' },
  ];

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

          {/* Full vs Partial toggle. If the order has already been partially
              refunded, "remaining" reflects what's left. */}
          <div className="mb-3 flex gap-1 rounded-lg bg-stone-100 p-1 dark:bg-stone-800">
            <button
              type="button"
              onClick={() => setMode('full')}
              className={cn(
                'flex-1 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors',
                mode === 'full'
                  ? 'bg-white text-stone-900 shadow-soft-sm dark:bg-stone-700 dark:text-stone-100'
                  : 'text-stone-500 hover:text-stone-700 dark:hover:text-stone-300',
              )}
            >
              Full refund
            </button>
            <button
              type="button"
              onClick={() => setMode('partial')}
              className={cn(
                'flex-1 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors',
                mode === 'partial'
                  ? 'bg-white text-stone-900 shadow-soft-sm dark:bg-stone-700 dark:text-stone-100'
                  : 'text-stone-500 hover:text-stone-700 dark:hover:text-stone-300',
              )}
            >
              Partial refund
            </button>
          </div>

          <div className="mb-4 rounded-xl bg-orange-50 px-4 py-3 dark:bg-orange-950/30">
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-orange-700 dark:text-orange-300">
                Refund amount
              </span>
              <span className="font-mono text-2xl font-bold text-orange-900 dark:text-orange-100">
                {formatCents(refundAmountCents)}
              </span>
            </div>
            <div className="mt-1 text-xs text-orange-800 dark:text-orange-200">
              {mode === 'full'
                ? 'Each original payment gets a matching negative entry. Drawer pops for cash. Order moves to Refunded.'
                : `Remaining refundable: ${formatCents(remainingCents)}. Order stays Paid until total refunded equals the order total.`}
            </div>
          </div>

          <div className="space-y-3">
            {mode === 'partial' && (
              <>
                <label className="block text-sm">
                  <span className="mb-1 block font-medium text-stone-700 dark:text-stone-200">
                    Refund amount (Rs)
                  </span>
                  <input
                    inputMode="decimal"
                    value={partialStr}
                    onChange={(e) => setPartialStr(e.target.value)}
                    className="w-full rounded-lg border border-stone-200 px-3 py-2 text-right font-mono text-lg focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
                  />
                </label>
                <div>
                  <span className="mb-1 block text-sm font-medium text-stone-700 dark:text-stone-200">
                    Refund via
                  </span>
                  <div className="grid grid-cols-4 gap-1.5">
                    {methods.map((m) => (
                      <button
                        key={m.key}
                        type="button"
                        onClick={() => setMethod(m.key)}
                        className={cn(
                          'rounded-lg border-2 px-2 py-1.5 text-xs font-semibold transition-colors',
                          method === m.key
                            ? 'border-amber-400 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-100'
                            : 'border-stone-200 bg-white text-stone-600 hover:border-stone-300 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-300',
                        )}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-stone-700 dark:text-stone-200">
                Reason
              </span>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                autoFocus={mode === 'full'}
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
              {refundMut.isPending ? 'Refunding…' : `Refund ${formatCents(refundAmountCents)}`}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
