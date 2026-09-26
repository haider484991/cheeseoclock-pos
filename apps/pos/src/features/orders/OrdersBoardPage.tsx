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
import { useToast } from '../../components/toast/ToastProvider';
import { useAcknowledgeOnlineOrders } from '../notifications/alertStore';
import type { OrderMode, OrderSnapshot, OrderStatus } from '@cheeseoclock/shared-types';
import { AssignRiderDialog } from './AssignRiderDialog';
import { MarkDeliveredDialog } from './MarkDeliveredDialog';
import { VoidOrderDialog } from './VoidOrderDialog';
import { RefundOrderDialog } from './RefundOrderDialog';
import { ModeBadge, PaidChip } from './OrderBadges';
import {
  ageLabel,
  ageMinutes,
  ageTone,
  cardFlags,
  cardItemCount,
  cardLines,
  matchesBoardSearch,
  nextBoardAction,
  type AgeTone,
} from './boardLogic';
import { orderTimeLabel } from './historyFilters';

/**
 * Live Orders Board.
 *
 * Every placed order that is not finished, in four columns that follow the
 * order's life: New → Preparing → Ready → Out for delivery. Each card has one
 * big button for its next step. Oldest first in every column; a card turns
 * amber after 15 minutes and red after 30. Polls every 5 seconds.
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
  const [voidFor, setVoidFor] = useState<OrderSnapshot | null>(null);
  // A paid order can't be voided (the server refuses): its Cancel is a refund.
  const [refundFor, setRefundFor] = useState<OrderSnapshot | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();
  const now = useNow(20_000);

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
  const reprint = useMutation({
    mutationFn: (orderId: string) => ipc.printer.reprint(orderId),
    onSuccess: () => toast({ title: 'Receipt sent to printer' }),
    onError: failed('Reprint failed'),
  });
  const reprintKitchen = useMutation({
    mutationFn: (orderId: string) => ipc.printer.reprintKitchen(orderId),
    onSuccess: () => toast({ title: 'Kitchen ticket sent to printer' }),
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
    return out;
  }, [visible]);

  const lateCount = all.filter((s) => ageTone(ageMinutes(s.order.createdAt, now)) === 'late').length;
  const pendingId = step.isPending ? step.variables?.orderId : undefined;

  return (
    <div className="flex h-full flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Live Orders</h1>
          <p className="mt-1 text-sm text-stone-500">
            {all.length} active {all.length === 1 ? 'order' : 'orders'}
            {lateCount > 0 && (
              <span className="ml-1 font-semibold text-red-600">
                · {lateCount} waiting over 30 min
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
                    const action = nextBoardAction(snap.order.status, snap.order.mode, snap.order.paidAt !== null);
                    return (
                      <OrderCard
                        key={snap.order.id}
                        snap={snap}
                        now={now}
                        busy={pendingId === snap.order.id}
                        onPrimary={() => {
                          switch (action.kind) {
                            case 'preparing':
                            case 'ready':
                            case 'served':
                            case 'delivered':
                              step.mutate({ orderId: snap.order.id, kind: action.kind });
                              return;
                            case 'assign_rider':
                              setAssignFor(snap);
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
                        onChangeRider={() => setAssignFor(snap)}
                        onReprint={() => reprint.mutate(snap.order.id)}
                        onReprintKitchen={() => reprintKitchen.mutate(snap.order.id)}
                        onCancel={() => (snap.order.paidAt !== null ? setRefundFor(snap) : setVoidFor(snap))}
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
          onClose={() => setAssignFor(null)}
          onAssigned={() => {
            setAssignFor(null);
            void refresh();
          }}
        />
      )}
      {deliverFor && (
        <MarkDeliveredDialog
          snap={deliverFor}
          onClose={() => setDeliverFor(null)}
          onDone={() => {
            setDeliverFor(null);
            void refresh();
          }}
        />
      )}
      {refundFor && (
        <RefundOrderDialog
          snap={refundFor}
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
  assign_rider: 'primary',
  hand_over: 'success',
  served: 'success',
  delivered: 'success',
  none: 'primary',
};

const PRIMARY_ICON: Record<ReturnType<typeof nextBoardAction>['kind'], typeof ChefHat> = {
  preparing: ChefHat,
  ready: CheckCircle2,
  assign_rider: Bike,
  hand_over: CheckCircle2,
  served: CheckCircle2,
  delivered: CheckCircle2,
  none: CheckCircle2,
};

const MAX_LINES = 4;

interface OrderCardProps {
  snap: OrderSnapshot;
  now: number;
  busy: boolean;
  primaryLabel: string | null;
  primaryKind: ReturnType<typeof nextBoardAction>['kind'];
  onPrimary: () => void;
  onChangeRider: () => void;
  onReprint: () => void;
  onReprintKitchen: () => void;
  onCancel: () => void;
}

function OrderCard({
  snap,
  now,
  busy,
  primaryLabel,
  primaryKind,
  onPrimary,
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
  const minutes = ageMinutes(order.createdAt, now);
  const tone = ageTone(minutes);
  const outMinutes = order.status === 'out_for_delivery' && order.dispatchedAt ? ageMinutes(order.dispatchedAt, now) : null;
  const PrimaryIcon = PRIMARY_ICON[primaryKind];

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
          title={`Taken ${orderTimeLabel(order.createdAt)}`}
        >
          {tone === 'late' ? <Hourglass className="h-3.5 w-3.5" /> : <Clock className="h-3.5 w-3.5" />}
          {ageLabel(minutes)}
        </span>
      </header>

      <ul className="space-y-0.5 text-sm text-stone-700 dark:text-stone-300">
        {lines.slice(0, MAX_LINES).map((i) => (
          <li key={i.id} className="truncate">
            <span className="font-bold text-stone-900 dark:text-stone-100">{i.quantity}×</span> {i.menuItemName}
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
      {order.notes && (
        <div className="mt-1.5 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Note: {order.notes}
        </div>
      )}

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
        </div>
      )}

      <div className="mt-2 flex items-center justify-between border-t border-stone-100 pt-2 dark:border-stone-700">
        <div className="flex items-center gap-2">
          <span className="font-mono text-base font-bold text-stone-900 dark:text-stone-100">
            {formatCents(order.totalCents)}
          </span>
          <PaidChip paid={paid} />
        </div>
        <span className="text-xs text-stone-500">
          {itemCount} {itemCount === 1 ? 'item' : 'items'}
        </span>
      </div>

      <div className="mt-2 flex items-center gap-1">
        {primaryLabel && (
          <Button
            size="md"
            variant={PRIMARY_VARIANT[primaryKind]}
            className="h-11 flex-1 whitespace-nowrap text-sm"
            onClick={onPrimary}
            disabled={busy}
          >
            <PrimaryIcon className="h-4 w-4" />
            {busy ? 'Saving…' : primaryLabel}
          </Button>
        )}
        <IconButton label="Reprint kitchen ticket" onClick={onReprintKitchen}>
          <ChefHat className="h-4 w-4" />
        </IconButton>
        <IconButton label="Reprint receipt" onClick={onReprint}>
          <Printer className="h-4 w-4" />
        </IconButton>
        <IconButton
          label={paid ? 'Refund order (manager approval)' : 'Cancel order (manager approval)'}
          onClick={onCancel}
          danger
        >
          <XCircle className="h-4 w-4" />
        </IconButton>
      </div>
    </article>
  );
}

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
