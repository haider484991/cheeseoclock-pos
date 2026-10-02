import * as Dialog from '@radix-ui/react-dialog';
import { useMutation } from '@tanstack/react-query';
import { Button } from '@cheeseoclock/ui';
import { Bike, Truck, Users, X } from 'lucide-react';
import { formatCents } from '@cheeseoclock/pos-domain';
import type { OrderSnapshot } from '@cheeseoclock/shared-types';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { SecretInput } from '../../components/secret/SecretInput';
import { SecretHint } from '../../components/secret/SecretHint';
import { approvalProblem } from '../../components/secret/secretRules';
import {
  ASSIGN_RIDER_LINK_TITLE,
  goesAloneLine,
  riderPaidEarlierChoice,
  sameCustomerLine,
  sendOutSplit,
  tripPaidToast,
  type PaidNowAtSendOut,
  type SamePhoneDelivery,
  type SendOutRequest,
} from './boardLogic';

/** The box's tick for an add-on that now goes alone (goesAloneLine), word for word. */
export function payTripWords(tripCents: number): string {
  return `Pay the rider ${formatCents(tripCents)} for this trip`;
}

/** Which answer: the rider paid now, pays after delivery, or the customer paid already. */
type Answer = 'paid_now' | 'after' | 'prepaid';

interface Props {
  snap: OrderSnapshot;
  onClose: () => void;
  /**
   * Sent out (Pays after delivery, or paid already). `next` is the order as
   * the till answered, with what the rider keeps frozen on it.
   */
  onSent: (next: OrderSnapshot) => void;
  /**
   * "Paid now": nothing is sent yet. Open Rider paid with this; it sends the
   * order out and takes his money in one step, then the bill prints.
   */
  onPaidNow: (paidNow: PaidNowAtSendOut) => void;
  /** "One of your own riders? Assign rider instead": the Assign rider box, nothing sent. */
  onAssignInstead: () => void;
  /**
   * One trip, one fee: "Charge again" was tapped, so the rider keeps this
   * order's charge too. Only read when the rider was already paid for this
   * trip (riderPaidEarlierChoice). The board keeps it with the open box, so
   * the box itself keeps no state.
   */
  chargeAgain: boolean;
  /** "Charge again": show the box again with chargeAgain. */
  onChargeAgain: () => void;
  /**
   * The same customer's other delivery on Live Orders (samePhoneDelivery),
   * read by the board as it is now; null or left out for none.
   */
  sameCustomer?: SamePhoneDelivery | null;
  /**
   * An add-on that now goes alone (goesAloneLine): "Pay the rider Rs 200 for
   * this trip" is ticked. The board keeps it, and the manager's PIN or
   * password typed for it (`pin`), with the open box; left out, not ticked.
   */
  payTrip?: boolean;
  /** The tick tapped: show the box again with payTrip. */
  onPayTrip?: (on: boolean) => void;
  /** The manager's PIN or password for the trip, as typed. */
  pin?: string;
  onPin?: (pin: string) => void;
}

/**
 * Send out #0042 (the owner, 2 Oct 2026: "Has the rider paid the shop?").
 * An outside rider takes the order and keeps its delivery charge; the bill
 * prints. The figures are what Send out will freeze (sendOutSplit: the
 * charge as sold, never more than the bill).
 *
 * Not paid: the bill split, then "Has the rider paid the shop?" — Paid now
 * (the food total) or Pays after delivery (focused, so Enter means after).
 * Paid already: the drawer gives the rider his charge (owner Q2), so it
 * says so and opens.
 *
 * Pays after delivery and paid already send it out at once. "Paid now"
 * sends nothing yet (e2e fix A): it hands the request and the figures on to
 * Rider paid (onPaidNow), which sends it out and takes his money in one
 * step — only then does the bill print, so its SHOP COPY says RIDER PAID THE
 * SHOP; closed without paying, Rider paid sends it out anyway. Esc or the X
 * closes with nothing changed. A refusal keeps the box open and says "Could
 * not send out" in the till's own words.
 *
 * One trip, one fee (the owner, 2 Oct 2026): when the rider was already paid
 * on a refunded order of this customer (riderPaidEarlierChoice), the box
 * says so ("The rider already kept Rs 200 on #0042.") and starts on "No
 * delivery charge for him this time": he keeps Rs 0 and gives the shop the
 * whole bill, and Send out says riderAlreadyPaid. "Charge again" switches
 * to the order's own figures ("He keeps Rs 200 on this order too.").
 *
 * Add-on delivery (the owner, 2 Oct 2026: "if its out then it should charge
 * if the rider is not out"; sameCustomerLine): another delivery of the same
 * phone still in the kitchen or Ready — "Same customer as #0042 — send them
 * together."; one already out while this bill has no delivery charge — amber
 * "No delivery charge on this order: #0042 has already gone out.". Nothing
 * when it is out and this order is charged (a new trip).
 *
 * An add-on that now goes alone (goesAloneLine: #0042 was cancelled,
 * refunded or delivered before this one went out): amber "#0042 is no longer
 * here: this order goes alone with no delivery charge." in place of the
 * line above, and the tick "Pay the rider Rs 200 for this trip", NOT ticked
 * to start. Ticked, it asks for a manager's PIN or password (as a cancel's
 * trip payout does) and Send out pays him from the drawer, which opens;
 * with no PIN typed nothing is sent. Left unticked, nothing is paid.
 */
export function SendOutDialog({
  snap,
  onClose,
  onSent,
  onPaidNow,
  onAssignInstead,
  chargeAgain,
  onChargeAgain,
  sameCustomer = null,
  payTrip = false,
  onPayTrip = () => {},
  pin = '',
  onPin = () => {},
}: Props) {
  const { order } = snap;
  const short = order.orderNumber.split('-').pop();
  const prepaid = order.paidAt !== null;
  const earlier = riderPaidEarlierChoice(snap);
  const riderAlreadyPaid = earlier !== null && !chargeAgain;
  const { customerPaysCents, keepsCents, givesCents } = sendOutSplit(snap, { riderAlreadyPaid });
  const alone = goesAloneLine(snap, sameCustomer);
  // An add-on going alone says so in place of "has already gone out".
  const together = alone ? null : sameCustomerLine(sameCustomer, snap);
  // 'Pay the rider Rs 200 for this trip': not ticked to start; ticked, a manager's PIN or password.
  const tripCents = alone && alone.tripCents > 0 && payTrip ? alone.tripCents : 0;
  const { toast } = useToast();
  // What Send out asks the till (Paid now hands it on to Rider paid instead).
  const request: SendOutRequest = {
    orderId: order.id,
    ...(earlier ? { riderAlreadyPaid } : {}),
    ...(tripCents > 0 ? { payRiderForTrip: true, approverPin: pin.trim() } : {}),
  };

  const send = useMutation({
    mutationFn: (_answer: Exclude<Answer, 'paid_now'>) => ipc.orders.sendOut(request),
    onSuccess: (next) => {
      if (tripCents > 0) toast({ title: tripPaidToast(tripCents), variant: 'success' });
      onSent(next);
    },
    onError: (e) =>
      toast({ title: 'Could not send out', description: e instanceof Error ? e.message : 'Unknown error', variant: 'error' }),
  });
  const busy = send.isPending;
  const saying = (answer: Exclude<Answer, 'paid_now'>, words: string) => (busy && send.variables === answer ? 'Saving…' : words);
  /**
   * Send it out, or (Paid now) hand it on to Rider paid. The trip ticked
   * needs the manager's PIN or password typed first: without it nothing is
   * sent and nothing opens.
   */
  const go = (answer: Answer) => {
    if (tripCents > 0) {
      const problem = approvalProblem(pin);
      if (problem) {
        toast({ title: problem, variant: 'warning' });
        return;
      }
    }
    if (answer === 'paid_now') onPaidNow({ request, keepsCents, tripCents });
    else send.mutate(answer);
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[460px] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-5 shadow-soft-lg dark:bg-stone-900">
          <header className="mb-4 flex items-start justify-between gap-3">
            <div>
              <Dialog.Title className="text-lg font-semibold">Send out #{short}</Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-stone-500">
                The bill prints now · {snap.customerName ?? 'Walk-in'}
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

          {together && (
            // The same customer's other delivery: one trip while it is still here; gone out with no charge on this bill.
            <p
              className={
                together.kind === 'together'
                  ? 'mb-3 flex items-center gap-2 rounded-xl bg-sky-50 px-4 py-3 text-sm font-semibold text-sky-900 dark:bg-sky-950/30 dark:text-sky-100'
                  : 'mb-3 flex items-center gap-2 rounded-xl bg-amber-100 px-4 py-3 text-sm font-semibold text-amber-900 ring-1 ring-amber-300 dark:bg-amber-950/50 dark:text-amber-100 dark:ring-amber-800'
              }
            >
              <Users className="h-4 w-4 shrink-0" aria-hidden="true" />
              {together.text}
            </p>
          )}

          {alone && (
            // An add-on whose first delivery is no longer here: it goes alone, with no delivery charge.
            <div className="mb-3 space-y-2 rounded-xl bg-amber-100 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-300 dark:bg-amber-950/50 dark:text-amber-100 dark:ring-amber-800">
              <p className="flex items-center gap-2 font-semibold">
                <Users className="h-4 w-4 shrink-0" aria-hidden="true" />
                {alone.text}
              </p>
              {alone.tripCents > 0 && (
                <>
                  <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg bg-white px-3 py-2 font-semibold text-stone-800 ring-1 ring-amber-200 dark:bg-stone-800 dark:text-stone-100 dark:ring-amber-800">
                    <input
                      type="checkbox"
                      checked={payTrip}
                      onChange={(e) => onPayTrip(e.target.checked)}
                      disabled={busy}
                      className="h-5 w-5 shrink-0 accent-amber-600"
                    />
                    {payTripWords(alone.tripCents)}
                  </label>
                  {payTrip && (
                    <div className="space-y-1">
                      <p className="text-xs">The drawer opens to pay him. A manager’s PIN or password is needed.</p>
                      <SecretInput
                        value={pin}
                        onChange={onPin}
                        aria-label="Manager PIN or password"
                        className="min-w-0 flex-1 rounded-lg border border-stone-200 bg-white px-3 py-2 text-center font-mono text-lg tracking-[0.5em] focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
                        placeholder="••••"
                      />
                      <SecretHint value={pin} />
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {earlier && (
            // One trip, one fee: he was paid on the refunded order; by default nothing more now.
            <div className="mb-3 space-y-1.5 rounded-xl bg-sky-50 px-4 py-3 text-sm text-sky-900 dark:bg-sky-950/30 dark:text-sky-100">
              <p className="font-semibold">
                The rider already kept {formatCents(earlier.amountCents)} on #{earlier.orderNumber.split('-').pop()}.
              </p>
              {riderAlreadyPaid ? (
                <div className="flex items-center justify-between gap-3">
                  <span>No delivery charge for him this time</span>
                  <Button variant="ghost" size="sm" className="shrink-0" onClick={onChargeAgain} disabled={busy}>
                    Charge again
                  </Button>
                </div>
              ) : (
                <p>He keeps {formatCents(keepsCents)} on this order too.</p>
              )}
            </div>
          )}

          {prepaid ? (
            <>
              <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
                {keepsCents > 0
                  ? `Paid already — give the rider ${formatCents(keepsCents)} from the drawer (his delivery charge). The drawer opens.`
                  : riderAlreadyPaid
                    ? 'Paid already — nothing comes out of the drawer this time.'
                    : 'Paid already, and no delivery charge: nothing comes out of the drawer.'}
              </p>
              <Button
                variant="primary"
                size="md"
                className="mt-4 h-14 w-full"
                onClick={() => go('prepaid')}
                disabled={busy}
                autoFocus
              >
                <Truck className="h-4 w-4" />
                {saying('prepaid', keepsCents > 0 || tripCents > 0 ? 'Send out · drawer opens' : 'Send out')}
              </Button>
            </>
          ) : (
            <>
              {/* What the customer pays him, what he keeps, what he hands the shop. */}
              <div className="space-y-1 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
                <div className="flex justify-between gap-3">
                  <span>Customer pays the rider</span>
                  <span className="font-mono">{formatCents(customerPaysCents)}</span>
                </div>
                {keepsCents > 0 ? (
                  <div className="flex justify-between gap-3">
                    <span>Rider keeps (delivery charge)</span>
                    <span className="font-mono">{formatCents(keepsCents)}</span>
                  </div>
                ) : riderAlreadyPaid ? (
                  // The bill has its charge; he was paid for this trip already.
                  <div className="flex justify-between gap-3">
                    <span>Rider keeps</span>
                    <span className="font-mono">{formatCents(0)}</span>
                  </div>
                ) : (
                  <div>No delivery charge on this bill</div>
                )}
                <div className="flex justify-between gap-3 border-t border-amber-200 pt-1 text-base font-bold dark:border-amber-800">
                  <span>Rider gives the shop</span>
                  <span className="font-mono">{formatCents(givesCents)}</span>
                </div>
              </div>
              <p className="mt-4 text-base font-semibold text-stone-800 dark:text-stone-100">Has the rider paid the shop?</p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Button
                  variant="success"
                  size="md"
                  className="h-14 px-3"
                  onClick={() => go('paid_now')}
                  disabled={busy}
                >
                  {`Paid now · ${formatCents(givesCents)}`}
                </Button>
                <Button
                  variant="primary"
                  size="md"
                  className="h-14 px-3"
                  onClick={() => go('after')}
                  disabled={busy}
                  autoFocus
                >
                  {saying('after', 'Pays after delivery')}
                </Button>
              </div>
            </>
          )}

          <button
            type="button"
            onClick={onAssignInstead}
            disabled={busy}
            title={ASSIGN_RIDER_LINK_TITLE}
            className="mt-4 flex w-full items-center justify-center gap-1.5 rounded px-1 py-1.5 text-sm font-semibold text-violet-700 underline-offset-2 hover:underline disabled:opacity-50 dark:text-violet-300"
          >
            <Bike className="h-4 w-4 shrink-0" />
            One of your own riders? Assign rider instead
          </button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
