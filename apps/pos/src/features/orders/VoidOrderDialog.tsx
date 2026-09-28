import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useMutation } from '@tanstack/react-query';
import { Button, cn } from '@cheeseoclock/ui';
import { ShieldAlert, X } from 'lucide-react';
import { formatCents } from '@cheeseoclock/pos-domain';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { SecretInput } from '../../components/secret/SecretInput';
import { SecretHint } from '../../components/secret/SecretHint';
import { approvalProblem } from '../../components/secret/secretRules';
import type { OrderSnapshot } from '@cheeseoclock/shared-types';
import { FoodMadeQuestion, useFoodMadeAnswer } from './FoodMadeQuestion';
import { cancelToast, reasonChips } from './stockCopy';
import { useOrderReasons } from '../settings/shop-rules/useShopSetting';
import { shortOrderNumber } from './historyFilters';

interface Props {
  snap: OrderSnapshot;
  onClose: () => void;
  onDone: () => void;
}

/**
 * Cancel (void) an unpaid order. Needs a reason, the answer to "Was the food
 * made?" when the order took stock, and a manager's PIN or password (the
 * server checks all three). Used from the Live Orders board and from Order
 * History; a paid order is refunded instead. Enter confirms.
 */
export function VoidOrderDialog({ snap, onClose, onDone }: Props) {
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const { toast } = useToast();
  const fm = useFoodMadeAnswer(snap);
  const short = shortOrderNumber(snap.order.orderNumber);
  // The owner's buttons (Settings → Staff & kitchen); any other reason can still be typed.
  const chips = reasonChips(useOrderReasons().cancel);

  const voidMut = useMutation({
    mutationFn: () =>
      ipc.orders.void({
        orderId: snap.order.id,
        reason: reason.trim(),
        approverPin: pin.trim(),
        ...fm.payload(),
      }),
    onSuccess: (done) => {
      // What the till actually did to stock, from its reply — not the dialog's guess.
      toast(cancelToast(done.stock));
      onDone();
    },
    onError: (e) =>
      toast({
        title: 'Could not cancel',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      }),
  });

  function pickReason(label: string) {
    setReason(label);
    // Fills the question only while nobody has answered it (never flips a tap
    // or the "Made" the till starts on once cooking was marked).
    fm.pickReason(chips, label);
  }

  function submit() {
    if (voidMut.isPending || fm.loading) return;
    if (!reason.trim()) {
      toast({ title: 'Say why it is cancelled', variant: 'warning' });
      return;
    }
    if (fm.missing) {
      toast({ title: 'Tap Made or Not made', variant: 'warning' });
      return;
    }
    const pinProblem = approvalProblem(pin);
    if (pinProblem) {
      toast({ title: pinProblem, variant: 'warning' });
      return;
    }
    voidMut.mutate();
  }

  const asksStock = fm.question !== null;

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[460px] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl bg-white shadow-soft-lg dark:bg-stone-900">
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <header className="flex items-start justify-between gap-3 px-5 pb-3 pt-5">
              <div className="flex items-start gap-2">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-200">
                  <ShieldAlert className="h-4 w-4" />
                </span>
                <div>
                  <Dialog.Title className="text-lg font-semibold">Cancel order</Dialog.Title>
                  <Dialog.Description className="mt-0.5 text-xs text-stone-500">
                    Order {short} · {snap.customerName ?? 'Walk-in'} · {formatCents(snap.order.totalCents)}
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

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 pb-1">
              <div className="block text-sm">
                <label htmlFor="void-reason" className="mb-1 block font-medium text-stone-700 dark:text-stone-200">
                  Reason
                </label>
                <div className="mb-1.5 flex flex-wrap gap-1.5">
                  {chips.map((r) => (
                    <button
                      key={r.label}
                      type="button"
                      onClick={() => pickReason(r.label)}
                      aria-pressed={reason === r.label}
                      className={cn(
                        'rounded-full px-2.5 py-1 text-xs font-medium ring-1 transition-colors',
                        reason === r.label
                          ? 'bg-amber-100 text-amber-900 ring-amber-300 dark:bg-amber-950 dark:text-amber-100 dark:ring-amber-700'
                          : 'bg-stone-50 text-stone-700 ring-stone-200 hover:bg-stone-100 dark:bg-stone-800 dark:text-stone-200 dark:ring-stone-700',
                      )}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
                <input
                  id="void-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  autoFocus
                  className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
                  placeholder="Or type why…"
                />
              </div>

              <FoodMadeQuestion fm={fm} shortNumber={short} />

              <label className="block text-sm">
                <span className="mb-1 block font-medium text-stone-700 dark:text-stone-200">
                  Manager PIN or password
                  {asksStock && (
                    <span className="ml-1 font-normal text-stone-500">— approves the cancel and the stock</span>
                  )}
                </span>
                <SecretInput
                  value={pin}
                  onChange={setPin}
                  className="min-w-0 flex-1 rounded-lg border border-stone-200 px-3 py-2 text-center font-mono text-lg tracking-[0.5em] focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
                  placeholder="••••"
                />
                <SecretHint value={pin} className="mt-1" />
              </label>
              <div className="rounded-lg bg-amber-50 p-2.5 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                Cancelling can't be undone and is recorded with the manager's name. If the customer already
                paid, use <strong>Refund</strong> instead.
              </div>
            </div>

            <div className="flex gap-2 border-t border-stone-100 px-5 py-4 dark:border-stone-800">
              <Button type="button" variant="ghost" size="md" className="flex-1" onClick={onClose}>
                Keep order
              </Button>
              <Button type="submit" variant="danger" size="md" className="flex-1" disabled={voidMut.isPending || fm.loading}>
                {fm.loading ? 'Checking stock…' : voidMut.isPending ? 'Cancelling…' : 'Cancel order'}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
