import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useMutation } from '@tanstack/react-query';
import { Button, cn } from '@cheeseoclock/ui';
import { Banknote, CheckCircle2, CreditCard, PackageX, Smartphone, X } from 'lucide-react';
import { formatCents } from '@cheeseoclock/pos-domain';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { isOutsideRiderOrder, riderKeepsNothingWhy, type OrderSnapshot, type PaymentMethod } from '@cheeseoclock/shared-types';
import { parseRupeesToCents, tripPaidToast, type PaidNowAtSendOut } from './boardLogic';
import { quickCashRupees } from '../checkout/tenderAmounts';

/**
 * What the dialog's onDone hears after Delivered + Pay with "Customer refused
 * an item" on: open the Refund box next (REFUSED_ITEM_REFUND), on this till,
 * with `snap` — the order as the till answered after taking the money.
 */
export interface RefundItemNext {
  refundItem: true;
  snap: OrderSnapshot;
}

/**
 * The Refund box after "Customer refused an item" (order-edit finding #5):
 * 'Part of it', Cash, and why it opened. The rider was taken for the whole
 * food total; the part refund in Cash, with no cash handed out, leaves the
 * drawer at what he really brought. Until that refund is done the till keeps
 * it as owed (Delivered + Pay sends refusedItem): the order and the Close
 * shift box say so.
 */
export const REFUSED_ITEM_REFUND = {
  startOn: 'partial',
  startMethod: 'cash',
  note: "The rider brought less than the bill. Type the refused item's price with tax, keep Cash, and hand out no cash: the drawer then matches what he brought.",
} as const;

interface Props {
  snap: OrderSnapshot;
  onClose: () => void;
  onDone: (next?: RefundItemNext) => void;
  /**
   * Rider paid (Send out's "Paid now", the Out card's "Rider paid"): the
   * outside rider pays the shop while still out. It calls orders:riderPaid
   * and the order stays out; Delivered closes it later.
   */
  riderPaidOnly?: boolean;
  /**
   * Send out's "Paid now" (e2e fix A): the order is still Ready. Confirm
   * sends it out and takes his money in one step (orders:sendOut with
   * riderPayment); only then does the bill print, so its SHOP COPY says
   * RIDER PAID THE SHOP. What he keeps is the figure the Send out box showed.
   * Closed without paying — "Pays after delivery", the X or Esc — it sends
   * the order out anyway (Send out alone): the bill prints once, and the Out
   * card says Rider owes. A refused Confirm changes nothing and keeps the box.
   */
  sendOutFirst?: PaidNowAtSendOut;
}

/**
 * Hand an order over and take its payment in one step. Mode-aware:
 *  - delivery  → `markDelivered` (stamps delivered_at)
 *  - takeaway / foodpanda → `markServed`
 * An order already paid skips the payment part.
 *
 * Cash asks what the customer gave (tap a note or type it) and shows the
 * change. Enter confirms.
 *
 * An order sent out with an outside rider (Send out) and not paid yet: the
 * rider keeps the delivery charge frozen at Send out, so the dialog takes
 * the food total from him (total − what he keeps), by Cash, EasyPaisa or
 * JazzCash — never a card. The payment sent is still the full total: the
 * till pays his share out of it (owner, 2 Oct 2026). With `riderPaidOnly` it
 * records Rider paid instead and the order stays out. On Delivered + Pay,
 * "Customer refused an item" takes his cash at the food total and then
 * opens the Refund box (onDone with refundItem). With `sendOutFirst` (Send
 * out's "Paid now") it is Rider paid on an order not sent out yet: see the
 * prop.
 */
export function MarkDeliveredDialog({ snap, onClose, onDone, riderPaidOnly: riderPaidProp = false, sendOutFirst }: Props) {
  const { order } = snap;
  const isDelivery = order.mode === 'delivery';
  // Send out's "Paid now" is Rider paid too, on an order still Ready.
  const riderPaidOnly = riderPaidProp || sendOutFirst !== undefined;
  // An outside rider's money, not settled yet (Rider paid always is: the till refuses a paid order itself).
  const outside = riderPaidOnly || (isOutsideRiderOrder(order) && order.paidAt === null);
  const alreadyPaid = !outside && order.paidAt !== null;
  // What he keeps, frozen at Send out; never worked out again from the lines.
  // Not sent out yet (Paid now): what the Send out box showed, which Send out freezes.
  const keepCents = sendOutFirst ? sendOutFirst.keepsCents : outside ? (order.riderKeepsCents ?? 0) : 0;
  // What the rider hands the shop: the food total.
  const takeCents = order.totalCents - keepCents;
  // What this dialog takes: the food total from an outside rider, else the whole bill.
  const dueCents = outside ? takeCents : order.totalCents;
  // Foodpanda settles its own orders: the only method for one, and never offered for anything else.
  const isFoodpanda = order.mode === 'foodpanda';
  const [method, setMethod] = useState<PaymentMethod>(isFoodpanda ? 'foodpanda' : 'cash');
  // Starts at the exact amount due (with paisa) so Enter straight away is right for exact cash.
  const [tendered, setTendered] = useState(rupeesText(dueCents));
  const [reference, setReference] = useState('');
  // Delivered + Pay with an outside rider: the customer refused an item at the door.
  const [refusedItem, setRefusedItem] = useState(false);
  const { toast } = useToast();

  const refusing = outside && !riderPaidOnly && refusedItem;
  const tenderedCents = parseRupeesToCents(tendered);
  const changeCents =
    method === 'cash' && !refusing && Number.isFinite(tenderedCents) ? Math.max(0, tenderedCents - dueCents) : 0;

  const verb = isDelivery ? 'delivered' : 'picked up';
  const verbCap = isDelivery ? 'Delivered' : 'Picked up';
  const short = order.orderNumber.split('-').pop();

  const deliverMut = useMutation({
    // `refuse`: "Customer refused an item" as it was when Confirm was pressed.
    mutationFn: ({ refuse }: { refuse: boolean }) => {
      const referenceNo = method !== 'cash' ? reference.trim() || null : null;
      if (outside) {
        // As the window showed it; the till refuses if the order changed since.
        const riderKeepsCents = keepCents;
        // Paid now: out and paid in one step (both or nothing), then the bill.
        if (sendOutFirst) {
          return ipc.orders.sendOut({ ...sendOutFirst.request, riderPayment: { method, referenceNo, riderKeepsCents } });
        }
        if (riderPaidOnly) return ipc.orders.riderPaid({ orderId: order.id, method, referenceNo, riderKeepsCents });
        // The full total, whatever the method: the till splits it and pays his share itself.
        // A refused item: the till keeps its part refund as owed until it is done.
        return ipc.orders.markDelivered({
          orderId: order.id,
          payment: { method, amountCents: order.totalCents, tenderedCents: null, referenceNo },
          riderKeepsCents,
          ...(refuse ? { refusedItem: true } : {}),
        });
      }
      const payment = alreadyPaid
        ? undefined
        : {
            method,
            amountCents: order.totalCents,
            tenderedCents: method === 'cash' ? tenderedCents : null,
            referenceNo,
          };
      const args = { orderId: order.id, ...(payment ? { payment } : {}) };
      return isDelivery ? ipc.orders.markDelivered(args) : ipc.orders.markServed(args);
    },
    onSuccess: (after, { refuse }) => {
      if (sendOutFirst && sendOutFirst.tripCents > 0) toast({ title: tripPaidToast(sendOutFirst.tripCents), variant: 'success' });
      const change =
        changeCents > 0
          ? { description: outside ? `Give the rider change: ${formatCents(changeCents)}` : `Give change: ${formatCents(changeCents)}` }
          : {};
      toast({
        title: riderPaidOnly
          ? `Rider paid · ${formatCents(takeCents)} for the shop`
          : alreadyPaid
            ? `Marked ${verb}`
            : `${verbCap} · payment taken`,
        ...change,
      });
      if (refuse) onDone({ refundItem: true, snap: after });
      else onDone();
    },
    onError: (e) =>
      toast({
        // Paid now refused: not sent out, nothing taken.
        title: sendOutFirst ? 'Could not send out' : riderPaidOnly ? "Could not take the rider's payment" : `Could not mark ${verb}`,
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      }),
  });

  // Paid now closed without paying: it goes out anyway (Send out alone), and its bill prints once.
  const goesOut = useMutation({
    mutationFn: (request: PaidNowAtSendOut['request']) => ipc.orders.sendOut(request),
    onSuccess: () => {
      if (sendOutFirst && sendOutFirst.tripCents > 0) toast({ title: tripPaidToast(sendOutFirst.tripCents), variant: 'success' });
      onDone();
    },
    onError: (e) => {
      toast({ title: 'Could not send out', description: e instanceof Error ? e.message : 'Unknown error', variant: 'error' });
      onClose();
    },
  });
  const saving = deliverMut.isPending || goesOut.isPending;
  /** The X, Esc and Back: closes — or, on Paid now, sends it out with the rider owing (once; never while saving). */
  const close = () => {
    if (!sendOutFirst) return onClose();
    if (saving) return;
    goesOut.mutate(sendOutFirst.request);
  };

  function submit() {
    if (saving) return;
    if (!alreadyPaid && method === 'cash' && !(tenderedCents >= dueCents)) {
      toast({
        title: outside ? `The rider's cash must cover ${formatCents(takeCents)}` : 'Cash given must cover the total',
        variant: 'warning',
      });
      return;
    }
    deliverMut.mutate({ refuse: refusing });
  }

  /** On: his cash is taken at the food total, as it is; the Refund box opens next. */
  function toggleRefusedItem() {
    const on = !refusedItem;
    setRefusedItem(on);
    if (on) {
      setMethod('cash');
      setTendered(rupeesText(takeCents));
    }
  }

  const methods: Array<{ key: PaymentMethod; label: string; icon: typeof Banknote }> = isFoodpanda
    ? [{ key: 'foodpanda', label: 'Foodpanda', icon: Smartphone }]
    : outside
      ? // An outside rider pays in cash or by wallet; the till refuses a card.
        [
          { key: 'cash', label: 'Cash', icon: Banknote },
          { key: 'easypaisa', label: 'EasyPaisa', icon: Smartphone },
          { key: 'jazzcash', label: 'JazzCash', icon: Smartphone },
        ]
      : [
          { key: 'cash', label: 'Cash', icon: Banknote },
          { key: 'card', label: 'Card', icon: CreditCard },
          { key: 'easypaisa', label: 'EasyPaisa', icon: Smartphone },
          { key: 'jazzcash', label: 'JazzCash', icon: Smartphone },
        ];
  // Exact, then the same notes Pay offers (tenderAmounts quickCashRupees: one rule), of what this dialog takes.
  const quickNotes = outside ? quickCashRupees(takeCents) : quickCashRupees(order.totalCents);

  return (
    <Dialog.Root open onOpenChange={(o) => !o && close()}>
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
                  {riderPaidOnly ? `Rider paid · #${short}` : alreadyPaid ? `Mark ${verb}` : `${verbCap} + take payment`}
                </Dialog.Title>
                <Dialog.Description className="mt-0.5 text-xs text-stone-500">
                  {sendOutFirst ? (
                    <>{snap.customerName ?? 'Walk-in'} · it goes out, then the bill prints</>
                  ) : riderPaidOnly ? (
                    <>{snap.customerName ?? 'Walk-in'} · the order stays out for delivery</>
                  ) : (
                    <>
                      Order #{short} · {snap.customerName ?? 'Walk-in'}
                      {alreadyPaid && ' · already paid'}
                    </>
                  )}
                </Dialog.Description>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label={sendOutFirst ? 'Pays after delivery' : 'Close'}
                className="rounded p-1 text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800"
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            {outside && (
              // What the customer pays him, less what he keeps (frozen at Send out).
              <dl className="mb-2 space-y-1 px-1 text-sm text-stone-600 dark:text-stone-300">
                <div className="flex justify-between gap-3">
                  <dt>Customer pays</dt>
                  <dd className="font-mono">{formatCents(order.totalCents)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  {keepCents > 0 ? (
                    <>
                      <dt>Rider keeps — delivery charge</dt>
                      <dd className="font-mono">− {formatCents(keepCents)}</dd>
                    </>
                  ) : (
                    <>
                      <dt>Rider keeps</dt>
                      {/* The paper's own reason (riderKeepsNothingWhy): one trip, one fee, or no charge at all. */}
                      <dd>nothing ({riderKeepsNothingWhy(snap)})</dd>
                    </>
                  )}
                </div>
              </dl>
            )}

            <div className="mb-4 flex items-baseline justify-between rounded-xl bg-amber-50 px-4 py-3 dark:bg-amber-950/30">
              <span className="text-xs font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300">
                {outside ? 'Take from the rider' : alreadyPaid ? 'Total (paid)' : 'To collect'}
              </span>
              <span className="font-mono text-2xl font-bold text-amber-900 dark:text-amber-100">
                {formatCents(dueCents)}
              </span>
            </div>

            {!alreadyPaid && (
              <>
                <div className="mb-3">
                  <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-stone-500">Paid by</div>
                  <div
                    className={cn(
                      'grid gap-1.5',
                      methods.length === 1 ? 'grid-cols-1' : methods.length === 3 ? 'grid-cols-3' : 'grid-cols-4',
                    )}
                  >
                    {methods.map((m) => {
                      const Icon = m.icon;
                      return (
                        <button
                          key={m.key}
                          type="button"
                          onClick={() => setMethod(m.key)}
                          aria-pressed={method === m.key}
                          // The refused item's money goes back in Cash: the rider brings cash.
                          disabled={refusing && m.key !== 'cash'}
                          className={cn(
                            'flex flex-col items-center gap-1 rounded-lg border-2 p-2 text-xs font-semibold transition-colors',
                            refusing && 'disabled:opacity-40',
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
                      <span className="mb-1 block font-medium text-stone-700 dark:text-stone-200">
                        {outside ? 'Cash from the rider (Rs)' : 'Cash given (Rs)'}
                      </span>
                      <input
                        inputMode="decimal"
                        value={tendered}
                        onChange={(e) => setTendered(e.target.value)}
                        onFocus={(e) => e.currentTarget.select()}
                        readOnly={refusing}
                        autoFocus
                        className={
                          'w-full rounded-lg border border-stone-200 px-3 py-2 font-mono text-lg focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800' +
                          (refusing ? ' bg-stone-100 text-stone-500' : '')
                        }
                      />
                    </label>
                    {refusing ? (
                      <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
                        Take the rider's cash. The refund box opens next: hand out no cash.
                      </div>
                    ) : (
                      <div className="mt-1.5 grid grid-cols-5 gap-1.5">
                        {/* Exact, then the same notes Pay offers (tenderAmounts quickCashRupees: one rule). */}
                        {[dueCents, ...quickNotes.map((r) => r * 100)].map((c) => (
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
                            {c === dueCents ? 'Exact' : formatCents(c)}
                          </button>
                        ))}
                      </div>
                    )}
                    {changeCents > 0 && (
                      <div className="mt-2 flex items-center justify-between rounded-lg bg-emerald-50 px-3 py-2 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100">
                        <span className="font-semibold">{outside ? 'Change to give the rider' : 'Change to give'}</span>
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

                {outside && !riderPaidOnly && (
                  // Order-edit finding #5: the customer refused an item at the door.
                  <button
                    type="button"
                    onClick={toggleRefusedItem}
                    aria-pressed={refusedItem}
                    className={cn(
                      'mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors',
                      refusedItem
                        ? 'border-orange-400 bg-orange-50 text-orange-800 dark:bg-orange-950/40 dark:text-orange-100'
                        : 'border-stone-200 text-stone-600 hover:border-stone-300 dark:border-stone-700 dark:text-stone-300',
                    )}
                  >
                    <PackageX className="h-4 w-4" />
                    Customer refused an item
                  </button>
                )}
              </>
            )}

            <div className="mt-5 flex gap-2">
              <Button type="button" variant="ghost" size="md" className="flex-1" onClick={close} disabled={sendOutFirst !== undefined && saving}>
                {/* Paid now: not paying now still sends it out — he pays after delivery. */}
                {sendOutFirst ? (goesOut.isPending ? 'Saving…' : 'Pays after delivery') : 'Back'}
              </Button>
              <Button
                type="submit"
                variant="success"
                size="md"
                className="flex-1"
                disabled={saving}
                autoFocus={alreadyPaid || method !== 'cash'}
              >
                <CheckCircle2 className="h-4 w-4" />
                {deliverMut.isPending
                  ? 'Saving…'
                  : alreadyPaid
                    ? `Mark ${verb}`
                    : refusing
                      ? 'Confirm · then refund the item'
                      : 'Confirm'}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Cents as the cash box shows them: "4515", "4515.50" (no ".00"). */
function rupeesText(cents: number): string {
  return (cents / 100).toFixed(2).replace(/\.00$/, '');
}
