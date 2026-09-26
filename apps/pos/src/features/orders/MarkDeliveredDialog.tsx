import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useMutation } from '@tanstack/react-query';
import { Button, cn } from '@cheeseoclock/ui';
import { Banknote, CheckCircle2, CreditCard, Smartphone, X } from 'lucide-react';
import { formatCents } from '@cheeseoclock/pos-domain';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import type { OrderSnapshot, PaymentMethod } from '@cheeseoclock/shared-types';
import { parseRupeesToCents, quickCashOptions } from './boardLogic';

interface Props {
  snap: OrderSnapshot;
  onClose: () => void;
  onDone: () => void;
}

/**
 * Hand an order over and take its payment in one step. Mode-aware:
 *  - delivery  → `markDelivered` (stamps delivered_at)
 *  - takeaway / foodpanda → `markServed`
 * An order already paid skips the payment part.
 *
 * Cash asks what the customer gave (tap a note or type it) and shows the
 * change. Enter confirms.
 */
export function MarkDeliveredDialog({ snap, onClose, onDone }: Props) {
  const { order } = snap;
  const isDelivery = order.mode === 'delivery';
  const alreadyPaid = order.paidAt !== null;
  // Foodpanda settles its own orders: the only method for one, and never offered for anything else.
  const isFoodpanda = order.mode === 'foodpanda';
  const [method, setMethod] = useState<PaymentMethod>(isFoodpanda ? 'foodpanda' : 'cash');
  // Starts at the exact bill (with paisa) so Enter straight away is right for exact cash.
  const [tendered, setTendered] = useState((order.totalCents / 100).toFixed(2).replace(/\.00$/, ''));
  const [reference, setReference] = useState('');
  const { toast } = useToast();

  const tenderedCents = parseRupeesToCents(tendered);
  const changeCents =
    method === 'cash' && Number.isFinite(tenderedCents) ? Math.max(0, tenderedCents - order.totalCents) : 0;

  const verb = isDelivery ? 'delivered' : 'picked up';
  const verbCap = isDelivery ? 'Delivered' : 'Picked up';

  const deliverMut = useMutation({
    mutationFn: () => {
      const payment = alreadyPaid
        ? undefined
        : {
            method,
            amountCents: order.totalCents,
            tenderedCents: method === 'cash' ? tenderedCents : null,
            referenceNo: method !== 'cash' ? reference.trim() || null : null,
          };
      const args = { orderId: order.id, ...(payment ? { payment } : {}) };
      return isDelivery ? ipc.orders.markDelivered(args) : ipc.orders.markServed(args);
    },
    onSuccess: () => {
      toast({
        title: alreadyPaid ? `Marked ${verb}` : `${verbCap} · payment taken`,
        ...(changeCents > 0 ? { description: `Give change: ${formatCents(changeCents)}` } : {}),
      });
      onDone();
    },
    onError: (e) =>
      toast({
        title: `Could not mark ${verb}`,
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      }),
  });

  function submit() {
    if (deliverMut.isPending) return;
    if (!alreadyPaid && method === 'cash' && !(tenderedCents >= order.totalCents)) {
      toast({ title: 'Cash given must cover the total', variant: 'warning' });
      return;
    }
    deliverMut.mutate();
  }

  const methods: Array<{ key: PaymentMethod; label: string; icon: typeof Banknote }> = isFoodpanda
    ? [{ key: 'foodpanda', label: 'Foodpanda', icon: Smartphone }]
    : [
        { key: 'cash', label: 'Cash', icon: Banknote },
        { key: 'card', label: 'Card', icon: CreditCard },
        { key: 'easypaisa', label: 'EasyPaisa', icon: Smartphone },
        { key: 'jazzcash', label: 'JazzCash', icon: Smartphone },
      ];

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[460px] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-5 shadow-soft-lg dark:bg-stone-900">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <header className="mb-4 flex items-start justify-between gap-3">
              <div>
                <Dialog.Title className="text-lg font-semibold">
                  {alreadyPaid ? `Mark ${verb}` : `${verbCap} + take payment`}
                </Dialog.Title>
                <Dialog.Description className="mt-0.5 text-xs text-stone-500">
                  Order #{order.orderNumber.split('-').pop()} · {snap.customerName ?? 'Walk-in'}
                  {alreadyPaid && ' · already paid'}
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

            <div className="mb-4 flex items-baseline justify-between rounded-xl bg-amber-50 px-4 py-3 dark:bg-amber-950/30">
              <span className="text-xs font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300">
                {alreadyPaid ? 'Total (paid)' : 'To collect'}
              </span>
              <span className="font-mono text-2xl font-bold text-amber-900 dark:text-amber-100">
                {formatCents(order.totalCents)}
              </span>
            </div>

            {!alreadyPaid && (
              <>
                <div className="mb-3">
                  <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-stone-500">Paid by</div>
                  <div className={cn('grid gap-1.5', methods.length === 1 ? 'grid-cols-1' : 'grid-cols-4')}>
                    {methods.map((m) => {
                      const Icon = m.icon;
                      return (
                        <button
                          key={m.key}
                          type="button"
                          onClick={() => setMethod(m.key)}
                          aria-pressed={method === m.key}
                          className={cn(
                            'flex flex-col items-center gap-1 rounded-lg border-2 p-2 text-xs font-semibold transition-colors',
                            method === m.key
                              ? 'border-amber-400 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-100'
                              : 'border-stone-200 bg-white text-stone-600 hover:border-stone-300 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-300',
                          )}
                        >
                          <Icon className="h-4 w-4" />
                          {m.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {method === 'cash' ? (
                  <div className="text-sm">
                    <label className="block">
                      <span className="mb-1 block font-medium text-stone-700 dark:text-stone-200">Cash given (Rs)</span>
                      <input
                        inputMode="decimal"
                        value={tendered}
                        onChange={(e) => setTendered(e.target.value)}
                        onFocus={(e) => e.currentTarget.select()}
                        autoFocus
                        className="w-full rounded-lg border border-stone-200 px-3 py-2 font-mono text-lg focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
                      />
                    </label>
                    <div className="mt-1.5 grid grid-cols-4 gap-1.5">
                      {quickCashOptions(order.totalCents).map((c) => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => setTendered(String(c / 100))}
                          className={cn(
                            'rounded-lg border px-2 py-1.5 font-mono text-xs font-semibold transition-colors',
                            tenderedCents === c
                              ? 'border-amber-400 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100'
                              : 'border-stone-200 text-stone-600 hover:border-stone-300 dark:border-stone-700 dark:text-stone-300',
                          )}
                        >
                          {c === order.totalCents ? 'Exact' : formatCents(c)}
                        </button>
                      ))}
                    </div>
                    {changeCents > 0 && (
                      <div className="mt-2 flex items-center justify-between rounded-lg bg-emerald-50 px-3 py-2 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100">
                        <span className="font-semibold">Change to give</span>
                        <span className="font-mono text-lg font-bold">{formatCents(changeCents)}</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <label className="block text-sm">
                    <span className="mb-1 block font-medium text-stone-700 dark:text-stone-200">
                      Reference / txn no. (optional)
                    </span>
                    <input
                      value={reference}
                      onChange={(e) => setReference(e.target.value)}
                      className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
                      placeholder="e.g. EP-981-XXX"
                    />
                  </label>
                )}
              </>
            )}

            <div className="mt-5 flex gap-2">
              <Button type="button" variant="ghost" size="md" className="flex-1" onClick={onClose}>
                Back
              </Button>
              <Button
                type="submit"
                variant="success"
                size="md"
                className="flex-1"
                disabled={deliverMut.isPending}
                autoFocus={alreadyPaid || method !== 'cash'}
              >
                <CheckCircle2 className="h-4 w-4" />
                {deliverMut.isPending ? 'Saving…' : alreadyPaid ? `Mark ${verb}` : 'Confirm'}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
