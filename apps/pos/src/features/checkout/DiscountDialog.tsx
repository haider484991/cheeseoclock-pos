import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, cn } from '@cheeseoclock/ui';
import { useCheckoutStore } from '../../stores/checkoutStore';
import { useToast } from '../../components/toast/ToastProvider';
import { requiresManagerApproval } from '@cheeseoclock/pos-domain';
import { X } from 'lucide-react';

interface Props {
  onClose: () => void;
}

export function DiscountDialog({ onClose }: Props) {
  const [discountType, setDiscountType] = useState<'percent' | 'flat'>('percent');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [approverPin, setApproverPin] = useState('');
  const applyDiscount = useCheckoutStore((s) => s.applyDiscount);
  const busy = useCheckoutStore((s) => s.busy);
  const { toast } = useToast();

  const numericValue = parseFloat(value) || 0;
  const valueForApproval = discountType === 'flat' ? numericValue * 100 : numericValue;
  const needsApproval = requiresManagerApproval({
    type: discountType,
    value: valueForApproval,
  });

  async function submit() {
    if (numericValue <= 0) {
      toast({ title: 'Enter a discount amount', variant: 'warning' });
      return;
    }
    if (needsApproval && approverPin.length < 4) {
      toast({ title: 'Manager PIN required', variant: 'warning' });
      return;
    }
    try {
      await applyDiscount(
        discountType,
        discountType === 'flat' ? numericValue * 100 : numericValue,
        reason || undefined,
        needsApproval ? approverPin : undefined,
      );
      onClose();
    } catch (e) {
      toast({
        title: 'Discount failed',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      });
    }
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[480px] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-5 shadow-xl dark:bg-stone-900">
          <header className="mb-4 flex items-center justify-between">
            <Dialog.Title className="text-xl font-bold">Apply discount</Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
              >
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>

          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">
                Type
              </label>
              <div className="grid grid-cols-2 gap-2">
                {(['percent', 'flat'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setDiscountType(t)}
                    className={cn(
                      'rounded-lg border-2 px-3 py-2 font-semibold transition-colors',
                      discountType === t
                        ? 'border-amber-500 bg-amber-50 dark:bg-amber-950'
                        : 'border-stone-200 hover:border-stone-300 dark:border-stone-700',
                    )}
                  >
                    {t === 'percent' ? 'Percent (%)' : 'Flat amount (Rs)'}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">
                {discountType === 'percent' ? 'Percent off (0-100)' : 'Amount off in PKR'}
              </label>
              <input
                type="number"
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 text-lg font-mono dark:border-stone-700 dark:bg-stone-800"
                min={0}
                max={discountType === 'percent' ? 100 : undefined}
                placeholder={discountType === 'percent' ? '10' : '500'}
              />
            </div>

            <div>
              <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">
                Reason (optional)
              </label>
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
                placeholder="e.g. Friend & family"
              />
            </div>

            {needsApproval && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950">
                <div className="mb-2 text-sm font-semibold text-amber-900 dark:text-amber-100">
                  Manager approval required
                </div>
                <input
                  type="password"
                  value={approverPin}
                  onChange={(e) => setApproverPin(e.target.value.replace(/\D/g, ''))}
                  className="w-full rounded-lg border border-amber-300 bg-white px-3 py-2 font-mono tracking-widest dark:border-amber-700 dark:bg-stone-900"
                  placeholder="Manager PIN"
                  maxLength={8}
                />
              </div>
            )}
          </div>

          <footer className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy} onClick={submit}>
              Apply
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
