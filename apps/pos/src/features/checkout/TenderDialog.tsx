import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, cn, NumberPad } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import { useCheckoutStore } from '../../stores/checkoutStore';
import { useToast } from '../../components/toast/ToastProvider';
import type { OrderSnapshot, PaymentMethod } from '@cheeseoclock/shared-types';
import { Banknote, CreditCard, Smartphone, Building, X } from 'lucide-react';

interface Props {
  snapshot: OrderSnapshot;
  onClose: () => void;
  onPaid: () => void;
}

const METHODS: Array<{
  id: PaymentMethod;
  label: string;
  icon: typeof Banknote;
  showTendered: boolean;
}> = [
  { id: 'cash', label: 'Cash', icon: Banknote, showTendered: true },
  { id: 'card', label: 'Card', icon: CreditCard, showTendered: false },
  { id: 'easypaisa', label: 'EasyPaisa', icon: Smartphone, showTendered: false },
  { id: 'jazzcash', label: 'JazzCash', icon: Smartphone, showTendered: false },
  { id: 'bank_transfer', label: 'Bank', icon: Building, showTendered: false },
];

export function TenderDialog({ snapshot, onClose, onPaid }: Props) {
  const total = snapshot.order.totalCents;
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [tendered, setTendered] = useState('');
  const tender = useCheckoutStore((s) => s.tender);
  const busy = useCheckoutStore((s) => s.busy);
  const { toast } = useToast();

  const tenderedCents = parseTenderedCents(tendered);
  const methodSpec = METHODS.find((m) => m.id === method)!;
  // For cash: tendered must be >= total. For others: amount = total exactly.
  const enough = methodSpec.showTendered ? tenderedCents >= total : true;
  const changeCents = methodSpec.showTendered && tenderedCents >= total ? tenderedCents - total : 0;

  async function submit() {
    if (!enough) {
      toast({ title: 'Tendered amount is less than total', variant: 'warning' });
      return;
    }
    try {
      await tender([
        {
          method,
          amountCents: total,
          tenderedCents: methodSpec.showTendered ? tenderedCents : null,
        },
      ]);
      onPaid();
    } catch (e) {
      toast({
        title: 'Payment failed',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      });
    }
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex w-[720px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-white shadow-xl dark:bg-stone-900">
          <header className="flex items-center justify-between border-b border-stone-200 p-5 dark:border-stone-800">
            <Dialog.Title className="text-xl font-bold">Payment</Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
              >
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>

          <div className="grid grid-cols-2 gap-5 p-5">
            <div>
              <div className="mb-2 text-xs uppercase tracking-wider text-stone-500">
                Method
              </div>
              <div className="grid grid-cols-2 gap-2">
                {METHODS.map((m) => {
                  const Icon = m.icon;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => {
                        setMethod(m.id);
                        if (!m.showTendered) setTendered('');
                      }}
                      className={cn(
                        'flex flex-col items-center gap-1 rounded-lg border-2 p-3 transition-colors',
                        method === m.id
                          ? 'border-amber-500 bg-amber-50 dark:bg-amber-950'
                          : 'border-stone-200 hover:border-stone-300 dark:border-stone-700',
                      )}
                    >
                      <Icon className="h-6 w-6" />
                      <span className="text-sm font-semibold">{m.label}</span>
                    </button>
                  );
                })}
              </div>

              <div className="mt-5 rounded-lg bg-stone-100 p-4 dark:bg-stone-800">
                <dl className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <dt>Subtotal</dt>
                    <dd className="font-mono">{formatCents(snapshot.order.subtotalCents)}</dd>
                  </div>
                  {snapshot.order.discountCents > 0 && (
                    <div className="flex justify-between text-emerald-700 dark:text-emerald-300">
                      <dt>Discount</dt>
                      <dd className="font-mono">−{formatCents(snapshot.order.discountCents)}</dd>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <dt>Tax</dt>
                    <dd className="font-mono">{formatCents(snapshot.order.taxCents)}</dd>
                  </div>
                  <div className="flex justify-between border-t border-stone-300 pt-1 text-lg font-bold dark:border-stone-600">
                    <dt>Total</dt>
                    <dd className="font-mono">{formatCents(total)}</dd>
                  </div>
                </dl>
              </div>
            </div>

            <div>
              {methodSpec.showTendered ? (
                <>
                  <div className="mb-2 text-xs uppercase tracking-wider text-stone-500">
                    Cash tendered
                  </div>
                  <NumberPad value={tendered} onChange={setTendered} maxLength={8} onSubmit={submit} />
                  <div className="mt-3 rounded-lg bg-emerald-50 p-3 text-center dark:bg-emerald-950">
                    <div className="text-xs uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                      Change
                    </div>
                    <div className="font-mono text-2xl font-bold">
                      {formatCents(changeCents)}
                    </div>
                  </div>
                </>
              ) : (
                <div className="mt-12 rounded-lg bg-stone-100 p-6 text-center dark:bg-stone-800">
                  <div className="mb-2 text-sm text-stone-500">Charge to {methodSpec.label}</div>
                  <div className="font-mono text-4xl font-bold">{formatCents(total)}</div>
                </div>
              )}
            </div>
          </div>

          <footer className="flex justify-end gap-2 border-t border-stone-200 p-5 dark:border-stone-800">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="success" disabled={!enough || busy} onClick={submit}>
              {busy ? 'Processing…' : 'Confirm payment'}
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function parseTenderedCents(input: string): number {
  if (!input) return 0;
  // Interpret raw input as PKR rupees (no decimals on numpad). User types "1500" → 1500 rupees → 150000 cents.
  const rupees = parseInt(input, 10);
  if (Number.isNaN(rupees)) return 0;
  return rupees * 100;
}
