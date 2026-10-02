import { useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useMutation } from '@tanstack/react-query';
import { Button, cn } from '@cheeseoclock/ui';
import { Undo2, X } from 'lucide-react';
import { formatCents } from '@cheeseoclock/pos-domain';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { SecretInput } from '../../components/secret/SecretInput';
import { SecretHint } from '../../components/secret/SecretHint';
import { approvalProblem } from '../../components/secret/secretRules';
import { isOutsideRiderOrder, type OrderSnapshot, type PaymentMethod } from '@cheeseoclock/shared-types';
import { riderSettledWhileOut } from '@cheeseoclock/printer-core';
import { parseRupeesToCents } from './boardLogic';
import { FoodMadeQuestion, useFoodMadeAnswer } from './FoodMadeQuestion';
import { reasonChips, refundToast } from './stockCopy';
import { useOrderReasons } from '../settings/shop-rules/useShopSetting';
import { shortOrderNumber } from './historyFilters';

/** 'All of it' or 'Part of it'. */
type RefundMode = 'full' | 'partial';

interface Props {
  snap: OrderSnapshot;
  onClose: () => void;
  onDone: () => void;
  /** Open with this choice made (otherwise neither, or 'Part of it' while an outside rider who paid the shop is still out). */
  startOn?: RefundMode;
  /** Open with 'Give back as' on this method (otherwise Cash while an outside rider who paid the shop is still out, or how most was paid). */
  startMethod?: PaymentMethod;
  /** A line at the top of the box saying why it opened. */
  note?: string;
}

/**
 * Give money back on a paid order — all of what is left, or part of it.
 * Needs a reason + a manager's PIN or password (the server checks both). A full refund moves
 * the order to Refunded; a part refund leaves it as it is until nothing is left.
 * The refund that ends the order (all of it, or the last part) also asks
 * "Was the food made?" when the order took stock. Enter confirms.
 *
 * It opens with neither 'All of it' nor 'Part of it' chosen (owner, 2 Oct
 * 2026), so Enter can never give the whole order back by accident: it only
 * says "Choose All of it or Part of it". An order an outside rider (Send out)
 * paid the shop for while he is still out (riderSettledWhileOut: the paper's
 * own rule) opens on 'Part of it' with Cash: the money goes back through him.
 * One the customer paid before it left opens neutral, on how it was paid —
 * he collects nothing for it. What the drawer paid that rider is never taken
 * back by a refund, and the box says so.
 */
export function RefundOrderDialog({ snap, onClose, onDone, startOn, startMethod, note }: Props) {
  // What can still be given back: every payment added up (refunds are negative).
  const remainingCents = useMemo(
    () => snap.payments.reduce((s, p) => s + p.amountCents, 0),
    [snap.payments],
  );
  const positivePayments = snap.payments.filter((p) => p.amountCents > 0);
  const dominantMethod: PaymentMethod =
    positivePayments.slice().sort((a, b) => b.amountCents - a.amountCents)[0]?.method ?? 'cash';
  const isFoodpanda = snap.order.mode === 'foodpanda';
  // Sent out with an outside rider who paid the shop while out, not back yet: the money goes
  // through him. The paper's rule (riderSettledWhileOut), so a customer-prepaid order is not this.
  const outsideOut = riderSettledWhileOut(snap.order);
  // What the drawer paid him for this order (a live payout); a refund never takes it back.
  const riderKeptCents =
    isOutsideRiderOrder(snap.order) && snap.deliveryChargeToRider ? snap.deliveryChargeToRider.amountCents : null;

  const [mode, setMode] = useState<RefundMode | null>(startOn ?? (outsideOut ? 'partial' : null));
  const [partialStr, setPartialStr] = useState('');
  const [method, setMethod] = useState<PaymentMethod>(startMethod ?? (outsideOut ? 'cash' : dominantMethod));
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const { toast } = useToast();
  const fm = useFoodMadeAnswer(snap);
  const short = shortOrderNumber(snap.order.orderNumber);
  // The owner's buttons (Settings → Staff & kitchen); any other reason can still be typed.
  const chips = reasonChips(useOrderReasons().refund);

  const partialCents = mode === 'partial' ? parseRupeesToCents(partialStr) : 0;
  const refundAmountCents = mode === 'full' ? remainingCents : Number.isFinite(partialCents) ? partialCents : 0;
  // Only the refund that ends the order touches stock; a part refund is money only.
  // Nothing is chosen yet: no stock question.
  const endsOrder = mode === 'full' || (mode === 'partial' && partialCents > 0 && partialCents === remainingCents);
  const asksStock = endsOrder && fm.question !== null;
  const typedCents = partialCents > 0 ? partialCents : null;
  const riderWords =
    riderKeptCents === null || mode === null
      ? null
      : mode === 'full'
        ? `The rider kept ${formatCents(riderKeptCents)} delivery charge when this was settled. A refund does not take it back: refunding the full ${formatCents(remainingCents)} comes out of the shop's money.`
        : typedCents === null
          ? `The rider keeps his ${formatCents(riderKeptCents)}.`
          : `${formatCents(typedCents)} goes back. The rider keeps his ${formatCents(riderKeptCents)}.`;

  const refundMut = useMutation({
    mutationFn: () =>
      ipc.orders.refund({
        orderId: snap.order.id,
        reason: reason.trim(),
        approverPin: pin.trim(),
        ...(mode === 'partial' ? { amountCents: partialCents, method } : {}),
        ...(endsOrder ? fm.payload() : { expectStatus: fm.orderStatus }),
      }),
    onSuccess: (done) => {
      // What the till actually did, from its reply.
      toast(refundToast(done.order.status === 'refunded', formatCents(refundAmountCents), done.stock));
      onDone();
    },
    onError: (e) =>
      toast({
        title: 'Refund failed',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      }),
  });

  function pickReason(label: string) {
    setReason(label);
    // A part refund moves no stock: a chip answers nothing then. Otherwise it
    // fills the question only while nobody has answered it.
    if (endsOrder) fm.pickReason(chips, label);
  }

  function submit() {
    if (refundMut.isPending || fm.loading) return;
    if (remainingCents <= 0) {
      toast({ title: 'Nothing left to refund on this order', variant: 'warning' });
      return;
    }
    // Enter before a choice gives nothing back.
    if (mode === null) {
      toast({ title: 'Choose All of it or Part of it', variant: 'warning' });
      return;
    }
    if (mode === 'partial') {
      if (!(partialCents > 0)) {
        toast({ title: 'Type how much to give back', variant: 'warning' });
        return;
      }
      if (partialCents > remainingCents) {
        toast({
          title: 'That is more than was paid',
          description: `Most you can give back: ${formatCents(remainingCents)}`,
          variant: 'warning',
        });
        return;
      }
    }
    if (!reason.trim()) {
      toast({ title: 'Say why you are refunding', variant: 'warning' });
      return;
    }
    if (endsOrder && fm.missing) {
      toast({ title: 'Tap Made or Not made', variant: 'warning' });
      return;
    }
    const pinProblem = approvalProblem(pin);
    if (pinProblem) {
      toast({ title: pinProblem, variant: 'warning' });
      return;
    }
    refundMut.mutate();
  }

  // Foodpanda money goes back through Foodpanda, never out of the drawer.
  const methods: Array<{ key: PaymentMethod; label: string }> = isFoodpanda
    ? [{ key: 'foodpanda', label: 'Foodpanda' }]
    : [
        { key: 'cash', label: 'Cash' },
        { key: 'card', label: 'Card' },
        { key: 'easypaisa', label: 'EasyPaisa' },
        { key: 'jazzcash', label: 'JazzCash' },
      ];

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[60] flex max-h-[90vh] w-[460px] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl bg-white shadow-soft-lg dark:bg-stone-900">
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <header className="flex items-start justify-between gap-3 px-5 pb-3 pt-5">
              <div className="flex items-start gap-2">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-200">
                  <Undo2 className="h-4 w-4" />
                </span>
                <div>
                  <Dialog.Title className="text-lg font-semibold">Refund</Dialog.Title>
                  <Dialog.Description className="mt-0.5 text-xs text-stone-500">
                    Order {short} · {snap.customerName ?? 'Walk-in'} · paid{' '}
                    {formatCents(remainingCents)}
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

            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-1">
            {note && (
              <div
                role="note"
                className="mb-3 rounded-lg bg-stone-100 px-3 py-2 text-xs text-stone-700 dark:bg-stone-800 dark:text-stone-200"
              >
                {note}
              </div>
            )}
            <div className="mb-3 flex gap-1 rounded-lg bg-stone-100 p-1 dark:bg-stone-800">
              {(['full', 'partial'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  aria-pressed={mode === m}
                  className={cn(
                    'flex-1 rounded-md px-3 py-2 text-sm font-semibold transition-colors',
                    mode === m
                      ? 'bg-white text-stone-900 shadow-soft-sm dark:bg-stone-700 dark:text-stone-100'
                      : 'text-stone-500 hover:text-stone-700 dark:hover:text-stone-300',
                  )}
                >
                  {m === 'full' ? 'All of it' : 'Part of it'}
                </button>
              ))}
            </div>

            <div className="mb-4 rounded-xl bg-orange-50 px-4 py-3 dark:bg-orange-950/30">
              <div className="flex items-baseline justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-orange-700 dark:text-orange-300">
                  Give back
                </span>
                <span className="font-mono text-2xl font-bold text-orange-900 dark:text-orange-100">
                  {mode === null ? '—' : formatCents(refundAmountCents)}
                </span>
              </div>
              <div className="mt-1 text-xs text-orange-800 dark:text-orange-200">
                {mode === null
                  ? 'Choose All of it or Part of it.'
                  : mode === 'full'
                    ? 'Everything still paid goes back, the way it was paid. The order becomes Refunded.'
                    : `Up to ${formatCents(remainingCents)}. The order stays paid until all of it is given back.`}
              </div>
              {riderWords && (
                <div className="mt-1.5 text-xs font-semibold text-orange-900 dark:text-orange-100">{riderWords}</div>
              )}
            </div>

            <div className="space-y-3">
              {mode === 'partial' && (
                <>
                  <label className="block text-sm">
                    <span className="mb-1 block font-medium text-stone-700 dark:text-stone-200">Amount (Rs)</span>
                    <input
                      inputMode="decimal"
                      value={partialStr}
                      onChange={(e) => setPartialStr(e.target.value)}
                      autoFocus
                      placeholder="e.g. 300"
                      className="w-full rounded-lg border border-stone-200 px-3 py-2 text-right font-mono text-lg focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
                    />
                  </label>
                  <div>
                    <span className="mb-1 block text-sm font-medium text-stone-700 dark:text-stone-200">Give back as</span>
                    <div className={cn('grid gap-1.5', methods.length === 1 ? 'grid-cols-1' : 'grid-cols-4')}>
                      {methods.map((m) => (
                        <button
                          key={m.key}
                          type="button"
                          onClick={() => setMethod(m.key)}
                          aria-pressed={method === m.key}
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
                    {outsideOut && method === 'cash' && (
                      <div className="mt-1.5 text-xs font-medium text-amber-800 dark:text-amber-200">
                        {typedCents === null
                          ? 'Give this to the rider: he collects that much less.'
                          : `Give this to the rider: he collects ${formatCents(typedCents)} less.`}
                      </div>
                    )}
                  </div>
                </>
              )}
              <div className="block text-sm">
                <label htmlFor="refund-reason" className="mb-1 block font-medium text-stone-700 dark:text-stone-200">
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
                  id="refund-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  autoFocus={mode !== 'partial'}
                  className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
                  placeholder="Or type why…"
                />
              </div>
              {endsOrder ? (
                <FoodMadeQuestion fm={fm} shortNumber={short} />
              ) : (
                mode === 'partial' &&
                fm.question !== null && (
                  <div className="rounded-lg bg-stone-50 p-2.5 text-xs text-stone-600 dark:bg-stone-800/60 dark:text-stone-300">
                    A part refund doesn't change stock. If an item was never made, fix it in Inventory → Stock.
                  </div>
                )
              )}
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-stone-700 dark:text-stone-200">
                  Manager PIN or password
                  {asksStock && (
                    <span className="ml-1 font-normal text-stone-500">— approves the refund and the stock</span>
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
            </div>
            </div>

            <div className="flex gap-2 border-t border-stone-100 px-5 py-4 dark:border-stone-800">
              <Button type="button" variant="ghost" size="md" className="flex-1" onClick={onClose}>
                Back
              </Button>
              <Button type="submit" variant="danger" size="md" className="flex-1" disabled={refundMut.isPending || fm.loading}>
                {fm.loading
                  ? 'Checking stock…'
                  : refundMut.isPending
                    ? 'Refunding…'
                    : mode === null
                      ? 'Refund…'
                      : `Refund ${formatCents(refundAmountCents)}`}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
