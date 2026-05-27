import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useMutation } from '@tanstack/react-query';
import { Button, cn } from '@cheeseoclock/ui';
import { Banknote, CheckCircle2, CreditCard, Smartphone, X } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import type { OrderSnapshot, PaymentMethod } from '@cheeseoclock/shared-types';

interface Props {
  snap: OrderSnapshot;
  onClose: () => void;
  onDone: () => void;
}

/**
 * Confirm delivery / pickup + capture COD payment in one step. Mode-aware:
 *  - delivery  → calls `markDelivered` (stamps delivered_at)
 *  - takeaway  → calls `markServed`
 * If the order is already paid (pre-pay flow), we skip the payment block.
 *
 * For cash we also capture "tendered" so we can show change due.
 */
export function MarkDeliveredDialog({ snap, onClose, onDone }: Props) {
  const { order } = snap;
  const isDelivery = order.mode === 'delivery';
  const alreadyPaid = order.paidAt !== null;
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [tendered, setTendered] = useState((order.totalCents / 100).toFixed(0));
  const [reference, setReference] = useState('');
  const { toast } = useToast();

  const totalPkr = (order.totalCents / 100).toFixed(0);
  const tenderedNum = parseFloat(tendered) || 0;
  const tenderedCents = Math.round(tenderedNum * 100);
  const changeCents = method === 'cash' ? Math.max(0, tenderedCents - order.totalCents) : 0;

  // Wording switches based on mode — we reuse this dialog for takeaway pickup.
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
      return isDelivery
        ? ipc.orders.markDelivered(args)
        : ipc.orders.markServed(args);
    },
    onSuccess: () => {
      toast({
        title: alreadyPaid ? `Marked ${verb}` : `${verbCap} + payment captured`,
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
    if (!alreadyPaid && method === 'cash' && tenderedCents < order.totalCents) {
      toast({ title: 'Tendered cash must cover the total', variant: 'warning' });
      return;
    }
    deliverMut.mutate();
  }

  const methods: Array<{ key: PaymentMethod; label: string; icon: typeof Banknote }> = [
    { key: 'cash', label: 'Cash', icon: Banknote },
    { key: 'card', label: 'Card', icon: CreditCard },
    { key: 'easypaisa', label: 'EasyPaisa', icon: Smartphone },
    { key: 'jazzcash', label: 'JazzCash', icon: Smartphone },
  ];

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[460px] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-5 shadow-soft-lg dark:bg-stone-900">
          <header className="mb-4 flex items-start justify-between gap-3">
            <div>
              <Dialog.Title className="text-lg font-semibold">
                {alreadyPaid
                  ? `Mark ${verb}`
                  : `${verbCap} + collect payment`}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-stone-500">
                Order #{order.orderNumber.split('-').pop()} ·{' '}
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

          <div className="mb-4 flex items-baseline justify-between rounded-xl bg-amber-50 px-4 py-3 dark:bg-amber-950/30">
            <span className="text-xs font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300">
              Total
            </span>
            <span className="font-mono text-2xl font-bold text-amber-900 dark:text-amber-100">
              Rs {totalPkr}
            </span>
          </div>

          {!alreadyPaid && (
            <>
              <div className="mb-3">
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-stone-500">
                  Payment method
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  {methods.map((m) => {
                    const Icon = m.icon;
                    return (
                      <button
                        key={m.key}
                        onClick={() => setMethod(m.key)}
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
                <label className="block text-sm">
                  <span className="mb-1 block font-medium text-stone-700 dark:text-stone-200">
                    Cash tendered (Rs)
                  </span>
                  <input
                    inputMode="decimal"
                    value={tendered}
                    onChange={(e) => setTendered(e.target.value)}
                    className="w-full rounded-lg border border-stone-200 px-3 py-2 text-lg font-mono focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
                  />
                  {changeCents > 0 && (
                    <div className="mt-2 flex items-center justify-between rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100">
                      <span className="font-semibold">Change due</span>
                      <span className="font-mono text-lg font-bold">
                        Rs {(changeCents / 100).toFixed(0)}
                      </span>
                    </div>
                  )}
                </label>
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
            <Button variant="ghost" size="md" className="flex-1" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="success"
              size="md"
              className="flex-1"
              onClick={submit}
              disabled={deliverMut.isPending}
            >
              <CheckCircle2 className="h-4 w-4" />
              {deliverMut.isPending
                ? 'Saving…'
                : alreadyPaid
                ? `Mark ${verb}`
                : 'Confirm'}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
