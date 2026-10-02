import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, cn } from '@cheeseoclock/ui';
import {
  Bike,
  ChefHat,
  CheckCircle2,
  Clock,
  Filter,
  Hourglass,
  Inbox,
  MapPin,
  Phone,
  Printer,
  RefreshCw,
  Search,
  Truck,
  UserRound,
  X,
  XCircle,
} from 'lucide-react';
import { formatCents } from '@cheeseoclock/pos-domain';
import { ipc } from '../../ipc/client';
import { reprintReceipt, reprintToast } from '../printing/reprint';
import { useToast } from '../../components/toast/ToastProvider';
import { useAcknowledgeOnlineOrders } from '../notifications/alertStore';
import type { OrderMode, OrderSnapshot, OrderStatus } from '@cheeseoclock/shared-types';
import { isOutsideRiderOrder, orderNotesOf, riderKeepsNothingWhy } from '@cheeseoclock/shared-types';
import { NoShiftBanner } from '../shell/NoShiftBanner';
import { AssignRiderDialog } from './AssignRiderDialog';
import { MarkDeliveredDialog, REFUSED_ITEM_REFUND } from './MarkDeliveredDialog';
import { SendOutDialog } from './SendOutDialog';
import { VoidOrderDialog } from './VoidOrderDialog';
import { RefundOrderDialog } from './RefundOrderDialog';
import { ModeBadge, PaidChip, TicketNotPrinted } from './OrderBadges';
import { ALERT_WATCH_KEY } from '../notifications/useAlertWatch';
import {
  ageLabel,
  ageMinutes,
  ageTitle,
  ageTone,
  ASSIGN_RIDER_LINK_TITLE,
  cardFlags,
  compareOrderClock,
  cardLineDetails,
  cardItemCount,
  cardLines,
  isOutWithOutsideRider,
  matchesBoardSearch,
  nextBoardAction,
  offersKitchenReprint,
  orderClockFrom,
  outsideRiderKeepsText,
  riderOwesCents,
  riderOwesText,
  samePhoneDelivery,
  secondaryBoardAction,
  sendOutAsks,
  boardColoursText,
  lateCountText,
  type AgeTone,
  type BoardTiming,
  type SecondaryBoardAction,
} from './boardLogic';
import { useKitchenTiming } from '../settings/shop-rules/useShopSetting';

/**
 * Live Orders Board.
 *
 * Every placed order that is not finished, in four columns that follow the
 * order's life: New → Preparing → Ready → Out for delivery. Each card has one
 * big button for its next step. The one sent longest ago first in every
 * column; a card turns amber, then red, after the owner's minutes from when it
 * was sent to the kitchen (the owner, 2 Oct 2026; from when it was started,
 * for an order from before 0.7.34), by default 15 and 30 (Settings → Staff &
 * kitchen timing). Polls every 5 seconds.
 *
 * A Ready delivery's button is "Send out" (the owner, 2 Oct 2026): an outside
 * rider takes it, keeps its delivery charge, and the bill prints. "Assign
 * rider" is the card's small link, for one of the shop's own riders (they
 * bring back the full bill).
 *
 * Send out asks "Has the rider paid the shop?" first (SendOutDialog; a paid
 * order: the drawer pays the rider his charge); only a paid order whose
 * rider keeps nothing goes in one tap, and not even that when the same
 * customer has another delivery to say something about ("send them
 * together", or "#0042 has already gone out" on a bill with no charge;
 * samePhoneDelivery, from this board's own list). While an outside rider owes, his Out
 * card says "Rider owes Rs …" beside the total and has "Rider paid" next to
 * "Delivered + Pay"; once paid it has the PAID chip and "Delivered".
 */

type ColumnKey = 'new' | 'preparing' | 'ready' | 'out';

const COLUMNS: Array<{
  key: ColumnKey;
  label: string;
  statuses: OrderStatus[];
  icon: typeof Inbox;
  tone: string;
}> = [
  // Not 'open': that is a cart still being rung up at the till.
  { key: 'new', label: 'New', statuses: ['sent_to_kitchen'], icon: Inbox, tone: 'from-sky-400 to-sky-500' },
  { key: 'preparing', label: 'Preparing', statuses: ['preparing'], icon: ChefHat, tone: 'from-amber-400 to-amber-500' },
  { key: 'ready', label: 'Ready', statuses: ['ready'], icon: CheckCircle2, tone: 'from-emerald-400 to-emerald-500' },
  { key: 'out', label: 'Out for delivery', statuses: ['out_for_delivery'], icon: Truck, tone: 'from-violet-400 to-violet-500' },
];

const MODE_FILTERS: Array<{ key: 'all' | OrderMode; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'takeaway', label: 'Takeaway' },
  { key: 'delivery', label: 'Delivery' },
  { key: 'foodpanda', label: 'Foodpanda' },
];

/** Re-render on a clock so age timers move even when no order changes. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function OrdersBoardPage() {
  const [modeFilter, setModeFilter] = useState<'all' | OrderMode>('all');
  const [search, setSearch] = useState('');
  const [assignFor, setAssignFor] = useState<OrderSnapshot | null>(null);
  const [deliverFor, setDeliverFor] = useState<OrderSnapshot | null>(null);
  // Send out's question, on a Ready delivery. chargeAgain: the rider was
  // already paid for this trip (one trip, one fee) and "Charge again" was tapped.
  // payTrip / pin: an add-on that now goes alone, "Pay the rider Rs 200 for this
  // trip" ticked, and the manager's PIN or password typed for it.
  const [sendOutFor, setSendOutFor] = useState<{
    snap: OrderSnapshot;
    chargeAgain: boolean;
    payTrip?: boolean;
    pin?: string;
  } | null>(null);
  // Rider paid: the outside rider pays the shop while the order stays out
  // (the Out card's button, or Send out's "Paid now" on the order as sent).
  const [riderPaidFor, setRiderPaidFor] = useState<OrderSnapshot | null>(null);
  const [voidFor, setVoidFor] = useState<OrderSnapshot | null>(null);
  // A paid order can't be voided (the server refuses): its Cancel is a refund.
  // refusedItem: opened after Delivered + Pay with "Customer refused an item" (Part of it, Cash, the note).
  const [refundFor, setRefundFor] = useState<{ snap: OrderSnapshot; refusedItem: boolean } | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();
  const now = useNow(20_000);
  // The owner's amber / red minutes (checkout:getRules; the released 15 / 30 until it answers).
  const timing = useKitchenTiming();

  const ordersQ = useQuery({
    queryKey: ['orders', 'active', modeFilter],
    queryFn: () => ipc.orders.listActive(modeFilter === 'all' ? undefined : { mode: modeFilter }),
    refetchInterval: 5_000,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['orders'] });
  const failed = (title: string) => (e: unknown) =>
    toast({ title, description: e instanceof Error ? e.message : 'Unknown error', variant: 'error' });

  // One-tap steps. No success toast: the card moving column is the feedback,
  // and a stack of toasts in a rush hides the board.
  const step = useMutation({
    mutationFn: ({ orderId, kind }: { orderId: string; kind: 'preparing' | 'ready' | 'served' | 'delivered' }) => {
      switch (kind) {
        case 'preparing':
          return ipc.orders.markPreparing(orderId);
        case 'ready':
          return ipc.orders.markReady(orderId);
        case 'served':
          return ipc.orders.markServed({ orderId });
        case 'delivered':
          return ipc.orders.markDelivered({ orderId });
      }
    },
    onSettled: () => void refresh(),
    onError: failed('Could not move the order'),
  });
  // Send out in one tap (the owner, 2 Oct 2026): a paid Ready delivery whose
  // rider keeps nothing and whose box would say nothing about the same
  // customer's other delivery; the rest ask first (SendOutDialog). No success toast
  // either: the card moves to Out.
  const sendOut = useMutation({
    mutationFn: (orderId: string) => ipc.orders.sendOut({ orderId }),
    onSettled: () => void refresh(),
    onError: failed('Could not send out'),
  });
  const reprint = useMutation({
    mutationFn: (orderId: string) => reprintReceipt(orderId),
    onSuccess: (r) => toast({ title: reprintToast(r) }),
    onError: failed('Reprint failed'),
  });
  const reprintKitchen = useMutation({
    mutationFn: (orderId: string) => ipc.printer.reprintKitchen(orderId),
    onSuccess: (r) => {
      toast({ title: reprintToast(r) });
      // A ticket on its way: "Ticket not printed" goes from the card and the PIN screen at once.
      void qc.invalidateQueries({ queryKey: ['orders', 'active'] });
      void qc.invalidateQueries({ queryKey: ALERT_WATCH_KEY });
    },
    onError: failed('Reprint failed'),
  });

  // A website order that did not come in: the alarm and the red note are on
  // every screen now (notifications/OrderAlerts). Opening the board counts as
  // seeing the new online orders on it.
  useAcknowledgeOnlineOrders();

  const all = useMemo(() => ordersQ.data ?? [], [ordersQ.data]);
  const visible = useMemo(() => all.filter((s) => matchesBoardSearch(s, search)), [all, search]);
  const grouped = useMemo(() => {
    const out: Record<ColumnKey, OrderSnapshot[]> = { new: [], preparing: [], ready: [], out: [] };
    for (const snap of visible) {
      const col = COLUMNS.find((c) => c.statuses.includes(snap.order.status));
      if (col) out[col.key].push(snap);
    }
    // The one sent longest ago first (orders:listActive's own order, kept here too).
    for (const key of Object.keys(out) as ColumnKey[]) out[key].sort((a, b) => compareOrderClock(a.order, b.order));
    return out;
  }, [visible]);

  const lateCount = all.filter((s) => ageTone(ageMinutes(orderClockFrom(s.order), now), timing) === 'late').length;
  // A card waiting on its one-tap step or its Send out reads "Saving…".
  const pendingIds = new Set([step.isPending ? step.variables?.orderId : undefined, sendOut.isPending ? sendOut.variables : undefined]);

  return (
    <div className="flex h-full flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Live Orders</h1>
          <p className="mt-1 text-sm text-stone-500">
            {all.length} active {all.length === 1 ? 'order' : 'orders'}
            {lateCount > 0 && (
              <span className="ml-1 font-semibold text-red-600" title={boardColoursText(timing)}>
                · {lateCountText(lateCount, timing)}
              </span>
            )}
            {ordersQ.isError && <span className="ml-1 font-semibold text-red-600">· could not refresh</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setSearch('')}
              placeholder="Find #, name, phone"
              aria-label="Find an order"
              className="h-10 w-52 rounded-lg border border-stone-200 bg-white pl-8 pr-8 text-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                aria-label="Clear"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-stone-400 hover:text-stone-700"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1 rounded-xl bg-stone-100 p-1 dark:bg-stone-800">
            <Filter className="ml-2 h-3.5 w-3.5 text-stone-500" />
            {MODE_FILTERS.map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => setModeFilter(m.key)}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors',
                  modeFilter === m.key
                    ? 'bg-white text-stone-900 shadow-soft-sm dark:bg-stone-700 dark:text-stone-100'
                    : 'text-stone-500 hover:text-stone-700 dark:hover:text-stone-300',
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
          <Button variant="ghost" size="sm" onClick={() => void refresh()} aria-label="Refresh">
            <RefreshCw className={cn('h-4 w-4', ordersQ.isFetching && 'animate-spin')} />
          </Button>
        </div>
      </header>

      {/* "Picked up + Pay" / "Delivered + Pay" are refused with no shift open on this till. */}
      <NoShiftBanner />

      <div className="grid flex-1 grid-cols-4 gap-3 overflow-hidden">
        {COLUMNS.map((col) => {
          const Icon = col.icon;
          const orders = grouped[col.key];
          return (
            <section key={col.key} className="flex min-h-0 flex-col rounded-2xl bg-stone-100/70 p-2.5 dark:bg-stone-900/40">
              <header className="mb-2 flex items-center justify-between px-1">
                <div className="flex items-center gap-2">
                  <span className={cn('flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br text-white', col.tone)}>
                    <Icon className="h-4 w-4" />
                  </span>
                  <h2 className="text-base font-bold">{col.label}</h2>
                </div>
                <span className="min-w-[2rem] rounded-full bg-white px-2 py-0.5 text-center text-sm font-bold text-stone-700 ring-1 ring-stone-200 dark:bg-stone-800 dark:text-stone-200 dark:ring-stone-700">
                  {orders.length}
                </span>
              </header>

              <div className="flex-1 space-y-2 overflow-y-auto pr-0.5">
                {ordersQ.isLoading ? (
                  <div className="flex h-32 items-center justify-center text-xs text-stone-400">Loading…</div>
                ) : orders.length === 0 ? (
                  <div className="flex h-32 items-center justify-center text-xs italic text-stone-400">
                    {search ? 'No match' : 'No orders here'}
                  </div>
                ) : (
                  orders.map((snap) => {
                    const paid = snap.order.paidAt !== null;
                    const action = nextBoardAction(snap.order.status, snap.order.mode, paid);
                    // Rider paid: by what the till goes by (what he keeps frozen on the order), as the Delivered box does.
                    const second = secondaryBoardAction(snap.order.status, snap.order.mode, paid, isOutsideRiderOrder(snap.order));
                    return (
                      <OrderCard
                        key={snap.order.id}
                        snap={snap}
                        now={now}
                        timing={timing}
                        busy={pendingIds.has(snap.order.id)}
                        onPrimary={() => {
                          switch (action.kind) {
                            case 'preparing':
                            case 'ready':
                            case 'served':
                            case 'delivered':
                              step.mutate({ orderId: snap.order.id, kind: action.kind });
                              return;
                            case 'send_out':
                              // "Has the rider paid the shop?" (or the drawer pays a prepaid order's rider) first;
                              // the same customer's other delivery is said there too.
                              if (sendOutAsks(snap, samePhoneDelivery(all, snap))) setSendOutFor({ snap, chargeAgain: false });
                              else sendOut.mutate(snap.order.id);
                              return;
                            case 'hand_over':
                              setDeliverFor(snap);
                              return;
                            case 'none':
                              return;
                          }
                        }}
                        primaryLabel={action.kind === 'none' ? null : action.label}
                        primaryKind={action.kind}
                        secondary={second}
                        onSecondary={() => setRiderPaidFor(snap)}
                        onChangeRider={() => setAssignFor(snap)}
                        onReprint={() => reprint.mutate(snap.order.id)}
                        onReprintKitchen={() => reprintKitchen.mutate(snap.order.id)}
                        onCancel={() => (snap.order.paidAt !== null ? setRefundFor({ snap, refusedItem: false }) : setVoidFor(snap))}
                      />
                    );
                  })
                )}
              </div>
            </section>
          );
        })}
      </div>

      {assignFor && (
        <AssignRiderDialog
          snap={assignFor}
          // An add-on going alone is said there too (only the words: an own rider brings back the full bill).
          sameCustomer={samePhoneDelivery(all, assignFor)}
          onClose={() => setAssignFor(null)}
          onAssigned={() => {
            setAssignFor(null);
            void refresh();
          }}
        />
      )}
      {sendOutFor && (
        <SendOutDialog
          snap={sendOutFor.snap}
          // Read from the board as it is now: the other delivery may go out while the box is open.
          sameCustomer={samePhoneDelivery(all, sendOutFor.snap)}
          chargeAgain={sendOutFor.chargeAgain}
          onChargeAgain={() => setSendOutFor((s) => (s ? { ...s, chargeAgain: true } : s))}
          payTrip={sendOutFor.payTrip === true}
          // Unticked, the PIN typed for it goes.
          onPayTrip={(on) => setSendOutFor((s) => (s ? { ...s, payTrip: on, pin: on ? s.pin : '' } : s))}
          pin={sendOutFor.pin ?? ''}
          onPin={(pin) => setSendOutFor((s) => (s ? { ...s, pin } : s))}
          onClose={() => setSendOutFor(null)}
          onSent={(next, riderPaidNow) => {
            setSendOutFor(null);
            void refresh();
            // "Paid now": Rider paid on the order as the till sent it out (what he keeps, frozen).
            if (riderPaidNow) setRiderPaidFor(next);
          }}
          onAssignInstead={() => {
            const { snap } = sendOutFor;
            setSendOutFor(null);
            setAssignFor(snap);
          }}
        />
      )}
      {riderPaidFor && (
        <MarkDeliveredDialog
          snap={riderPaidFor}
          riderPaidOnly
          onClose={() => setRiderPaidFor(null)}
          onDone={() => {
            setRiderPaidFor(null);
            void refresh();
          }}
        />
      )}
      {deliverFor && (
        <MarkDeliveredDialog
          snap={deliverFor}
          onClose={() => setDeliverFor(null)}
          onDone={(next) => {
            setDeliverFor(null);
            void refresh();
            // The customer refused an item (outside rider, order-edit #5): the
            // Refund box next, on this till, with the order as the till now has it.
            if (next?.refundItem) setRefundFor({ snap: next.snap, refusedItem: true });
          }}
        />
      )}
      {refundFor && (
        <RefundOrderDialog
          snap={refundFor.snap}
          {...(refundFor.refusedItem ? REFUSED_ITEM_REFUND : {})}
          onClose={() => setRefundFor(null)}
          onDone={() => {
            setRefundFor(null);
            void refresh();
          }}
        />
      )}
      {voidFor && (
        <VoidOrderDialog
          snap={voidFor}
          onClose={() => setVoidFor(null)}
          onDone={() => {
            setVoidFor(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// OrderCard — one order on the board
// ---------------------------------------------------------------------------

const CARD_RING: Record<AgeTone, string> = {
  ok: 'ring-stone-200 dark:ring-stone-700',
  warn: 'ring-2 ring-amber-400 dark:ring-amber-500',
  late: 'ring-2 ring-red-500 dark:ring-red-500',
};

const PRIMARY_VARIANT: Record<ReturnType<typeof nextBoardAction>['kind'], 'primary' | 'success'> = {
  preparing: 'primary',
  ready: 'success',
  send_out: 'primary',
  hand_over: 'success',
  served: 'success',
  delivered: 'success',
  none: 'primary',
};

const PRIMARY_ICON: Record<ReturnType<typeof nextBoardAction>['kind'], typeof ChefHat> = {
  preparing: ChefHat,
  ready: CheckCircle2,
  send_out: Truck,
  hand_over: CheckCircle2,
  served: CheckCircle2,
  delivered: CheckCircle2,
  none: CheckCircle2,
};

const MAX_LINES = 4;

interface OrderCardProps {
  snap: OrderSnapshot;
  now: number;
  timing: BoardTiming;
  busy: boolean;
  primaryLabel: string | null;
  primaryKind: ReturnType<typeof nextBoardAction>['kind'];
  onPrimary: () => void;
  /** The card's second button ("Rider paid"), or null. */
  secondary: SecondaryBoardAction | null;
  onSecondary: () => void;
  onChangeRider: () => void;
  onReprint: () => void;
  onReprintKitchen: () => void;
  onCancel: () => void;
}

function OrderCard({
  snap,
  now,
  timing,
  busy,
  primaryLabel,
  primaryKind,
  onPrimary,
  secondary,
  onSecondary,
  onChangeRider,
  onReprint,
  onReprintKitchen,
  onCancel,
}: OrderCardProps) {
  const { order } = snap;
  const paid = order.paidAt !== null;
  const lines = cardLines(snap.items);
  const itemCount = cardItemCount(snap.items);
  const flags = cardFlags(snap);
  const orderNotes = orderNotesOf(snap);
  // From when it was sent to the kitchen (started, for an order from before 0.7.34).
  const minutes = ageMinutes(orderClockFrom(order), now);
  const tone = ageTone(minutes, timing);
  // How long it has been out, from when it left (dispatchedAt): on an own
  // rider's row and on an outside rider's row alike.
  const outMinutes = order.status === 'out_for_delivery' && order.dispatchedAt ? ageMinutes(order.dispatchedAt, now) : null;
  // Sent out with an outside rider: he keeps the delivery charge frozen at Send out.
  const outside = isOutWithOutsideRider(snap);
  // A Ready delivery goes out with Send out; one of the shop's own riders is this small link.
  const offersAssignLink = order.status === 'ready' && order.mode === 'delivery' && !snap.rider;
  // An outside rider still owes the shop the food total (the total less what he keeps).
  const owes = riderOwesCents(order);
  const PrimaryIcon = PRIMARY_ICON[primaryKind];
  const icons = (
    <>
      {/* Only while the kitchen still has it: the till refuses the ticket after that. */}
      {offersKitchenReprint(order.status) && (
        <IconButton label="Reprint kitchen ticket" onClick={onReprintKitchen}>
          <ChefHat className="h-4 w-4" />
        </IconButton>
      )}
      {/* The bill while unpaid, the receipt once paid. Printed with this button it always says DUPLICATE (the owner's rule; order-papers.ts). */}
      <IconButton label="Print bill or receipt" onClick={onReprint}>
        <Printer className="h-4 w-4" />
      </IconButton>
      <IconButton
        label={paid ? 'Refund order (manager approval)' : 'Cancel order (manager approval)'}
        onClick={onCancel}
        danger
      >
        <XCircle className="h-4 w-4" />
      </IconButton>
    </>
  );

  return (
    <article
      className={cn(
        'rounded-xl bg-white p-3 shadow-soft-sm ring-1 transition-shadow hover:shadow-soft-md dark:bg-stone-800',
        CARD_RING[tone],
      )}
    >
      <header className="mb-1.5 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-lg font-bold leading-none text-stone-900 dark:text-stone-100">
              #{order.orderNumber.split('-').pop() ?? order.orderNumber}
            </span>
            <ModeBadge mode={order.mode} />
            {order.source === 'web' && (
              // A website takeaway is a customer on the way to collect it, with
              // the online pick-up discount already on the bill.
              <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase text-amber-700 ring-1 ring-amber-200 dark:bg-amber-950/50 dark:text-amber-200 dark:ring-amber-800">
                {order.mode === 'takeaway' ? 'Web pick-up' : 'Web'}
              </span>
            )}
          </div>
          {snap.customerName && (
            <div className="mt-1 flex items-center gap-1.5 truncate text-sm font-semibold text-stone-700 dark:text-stone-200">
              <UserRound className="h-3.5 w-3.5 shrink-0 text-stone-400" />
              <span className="truncate">{snap.customerName}</span>
            </div>
          )}
        </div>
        <span
          className={cn(
            'flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-sm font-semibold',
            tone === 'late'
              ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-200'
              : tone === 'warn'
                ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200'
                : 'text-stone-500',
          )}
          title={ageTitle(order, new Date(now))}
        >
          {tone === 'late' ? <Hourglass className="h-3.5 w-3.5" /> : <Clock className="h-3.5 w-3.5" />}
          {ageLabel(minutes)}
        </span>
      </header>

      <ul className="space-y-0.5 text-sm text-stone-700 dark:text-stone-300">
        {lines.slice(0, MAX_LINES).map((i) => (
          <li key={i.id}>
            <div className="truncate">
              <span className="font-bold text-stone-900 dark:text-stone-100">{i.quantity}×</span> {i.menuItemName}
            </div>
            {cardLineDetails(i, snap.items).map((d, n) => (
              <div key={n} className="ml-5 text-xs leading-snug text-stone-500 dark:text-stone-400">
                {d}
              </div>
            ))}
          </li>
        ))}
        {lines.length > MAX_LINES && <li className="text-xs text-stone-400">+{lines.length - MAX_LINES} more…</li>}
      </ul>

      {/* Leave-outs and allergy / special-request notes, whatever line they are on:
          the card lists four lines at most, and this must not be one of the hidden ones. */}
      {flags.length > 0 && (
        <div className="mt-1.5 rounded-md bg-red-50 px-2 py-1 text-xs font-semibold leading-snug text-red-800 dark:bg-red-950/50 dark:text-red-200">
          Leave out / allergy: {flags.join(' · ')}
        </div>
      )}
      {/* The kitchen never got its ticket (this till's printer gave up), while it still has the order. */}
      {snap.kitchenTicketNotPrinted === true && offersKitchenReprint(order.status) && (
        <TicketNotPrinted onReprint={onReprintKitchen} />
      )}
      {/* The order's notes: the counter's "Order notes" box and a website customer's note, alike. */}
      {orderNotes.map((note) => (
        <div
          key={note}
          className="mt-1.5 rounded-md bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-800"
        >
          Order note: {note}
        </div>
      ))}

      {(order.mode === 'delivery' || snap.customerPhone) && (
        <div className="mt-2 space-y-1 rounded-lg bg-stone-50 p-2 text-xs dark:bg-stone-900/60">
          {snap.customerPhone && (
            <div className="flex items-center gap-1.5 font-mono text-stone-600 dark:text-stone-300">
              <Phone className="h-3 w-3 shrink-0" />
              {snap.customerPhone}
            </div>
          )}
          {order.mode === 'delivery' && snap.deliveryAddress && (
            <div className="flex items-start gap-1.5 text-stone-600 dark:text-stone-300">
              <MapPin className="mt-0.5 h-3 w-3 shrink-0" />
              <span className="line-clamp-2">{snap.deliveryAddress}</span>
            </div>
          )}
          {snap.rider && (
            <div className="flex items-center justify-between gap-1.5 rounded-md bg-violet-50 p-1.5 text-violet-800 dark:bg-violet-950/40 dark:text-violet-200">
              <span className="flex min-w-0 items-center gap-1.5">
                <Bike className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate font-semibold">{snap.rider.name}</span>
                <span className="font-mono text-[10px]">{snap.rider.phone}</span>
                {outMinutes !== null && <span className="whitespace-nowrap text-[10px]">· out {ageLabel(outMinutes)}</span>}
              </span>
              {order.status === 'out_for_delivery' && (
                <button
                  type="button"
                  className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold text-violet-700 underline-offset-2 hover:underline dark:text-violet-300"
                  onClick={onChangeRider}
                >
                  Change
                </button>
              )}
            </div>
          )}
          {outside && (
            // One wrapping row: "Outside rider" stays whole on a narrow card (it was cut to "Outside …");
            // what does not fit goes to the next line, the link last, on the right.
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-md bg-violet-50 p-1.5 text-violet-800 dark:bg-violet-950/40 dark:text-violet-200">
              <span className="flex items-center gap-1.5 whitespace-nowrap font-semibold">
                <Truck className="h-3.5 w-3.5 shrink-0" />
                Outside rider
              </span>
              {outMinutes !== null && <span className="whitespace-nowrap text-[10px]">· out {ageLabel(outMinutes)}</span>}
              <span className="whitespace-nowrap text-[10px]">· {outsideRiderKeepsText(order.riderKeepsCents ?? 0, riderKeepsNothingWhy(snap))}</span>
              <button
                type="button"
                className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold text-violet-700 underline-offset-2 hover:underline dark:text-violet-300"
                onClick={onChangeRider}
                title={ASSIGN_RIDER_LINK_TITLE}
              >
                Assign rider
              </button>
            </div>
          )}
          {offersAssignLink && (
            <button
              type="button"
              className="flex items-center gap-1.5 rounded px-0.5 py-0.5 text-[11px] font-semibold text-violet-700 underline-offset-2 hover:underline dark:text-violet-300"
              onClick={onChangeRider}
              title={ASSIGN_RIDER_LINK_TITLE}
            >
              <Bike className="h-3.5 w-3.5 shrink-0" />
              Assign rider
            </button>
          )}
        </div>
      )}

      <div className="mt-2 flex items-center justify-between border-t border-stone-100 pt-2 dark:border-stone-700">
        <div className={owes === null ? 'flex items-center gap-2' : 'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1'}>
          <span className="font-mono text-base font-bold text-stone-900 dark:text-stone-100">
            {formatCents(order.totalCents)}
          </span>
          {owes === null ? (
            <PaidChip paid={paid} />
          ) : (
            // In place of "Not paid": what he hands the shop, the FOOD TOTAL.
            <span className="inline-flex items-center whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              {riderOwesText(owes)}
            </span>
          )}
        </div>
        <span className="text-xs text-stone-500">
          {itemCount} {itemCount === 1 ? 'item' : 'items'}
        </span>
      </div>

      {/* "Rider paid" on its own row, full width, above the card's usual row: beside Delivered + Pay
          it pushed Print and Cancel off a narrow card (review 2 Oct 2026, at 1011 × 663). */}
      {secondary && (
        <Button
          size="md"
          variant="secondary"
          className="mt-2 h-11 w-full text-sm text-amber-900 ring-amber-300 hover:bg-amber-50 dark:text-amber-200 dark:ring-amber-800"
          onClick={onSecondary}
          disabled={busy}
        >
          {secondary.label}
        </Button>
      )}
      <div className={secondary ? 'mt-1 flex items-center gap-1' : CARD_ACTION_ROW}>
        {primaryLabel && (
          <Button
            size="md"
            variant={PRIMARY_VARIANT[primaryKind]}
            // Under "Rider paid" the words may take two lines on a narrow card, so the icons keep their room.
            className={secondary ? 'h-11 flex-1 px-2 text-sm leading-tight' : 'h-11 flex-1 whitespace-nowrap text-sm'}
            onClick={onPrimary}
            disabled={busy}
          >
            <PrimaryIcon className="h-4 w-4" />
            {busy ? 'Saving…' : primaryLabel}
          </Button>
        )}
        {secondary ? icons : <div className={CARD_ICONS}>{icons}</div>}
      </div>
    </article>
  );
}

/**
 * A card's last row with no "Rider paid" above it: the big button, then its
 * icons as one group that never shrinks. Where the button's words and the
 * icons don't fit side by side (the till's narrowest window, 1011 × 663: a
 * kitchen or Ready card's 'Start preparing' / 'Picked up + Pay' and three
 * icons need about 270 px of a 172 px card, and Cancel was cut off with the
 * column scrolling sideways), the group goes under the button on its own
 * line, on the right, and the button takes the whole width. A wide window
 * keeps the one row.
 */
const CARD_ACTION_ROW = 'mt-2 flex flex-wrap items-center gap-1';
/** The icons' group in that row (Reprint kitchen ticket, Print, Cancel / Refund). */
const CARD_ICONS = 'ml-auto flex shrink-0 items-center gap-1';

function IconButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'flex h-11 w-9 items-center justify-center rounded-lg text-stone-400 transition-colors',
        danger
          ? 'hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950 dark:hover:text-red-300'
          : 'hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-stone-700 dark:hover:text-stone-200',
      )}
    >
      {children}
    </button>
  );
}
