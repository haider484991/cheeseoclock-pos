import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, cn } from '@cheeseoclock/ui';
import {
  Bike,
  ChefHat,
  CheckCircle2,
  CircleDashed,
  Clock,
  Filter,
  Hourglass,
  Inbox,
  MapPin,
  Phone,
  RefreshCw,
  Truck,
  UserRound,
} from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import type { OrderMode, OrderSnapshot, OrderStatus } from '@cheeseoclock/shared-types';
import { AssignRiderDialog } from './AssignRiderDialog';
import { MarkDeliveredDialog } from './MarkDeliveredDialog';

/**
 * Live Orders Board.
 *
 * Unified kanban for every active order — dine-in, takeaway, delivery.
 * Five columns map to the order lifecycle. Cashier/manager taps the action
 * button on each card to advance the order. Polls every 5 seconds so the
 * board stays current without a manual refresh.
 */

type ColumnKey = 'new' | 'preparing' | 'ready' | 'out' | 'done';

const COLUMNS: Array<{
  key: ColumnKey;
  label: string;
  statuses: OrderStatus[];
  icon: typeof CircleDashed;
  tone: string;
}> = [
  {
    key: 'new',
    label: 'New',
    statuses: ['open', 'sent_to_kitchen'],
    icon: Inbox,
    tone: 'from-sky-400 to-sky-500',
  },
  {
    key: 'preparing',
    label: 'Preparing',
    statuses: ['preparing'],
    icon: ChefHat,
    tone: 'from-amber-400 to-amber-500',
  },
  {
    key: 'ready',
    label: 'Ready',
    statuses: ['ready'],
    icon: CheckCircle2,
    tone: 'from-emerald-400 to-emerald-500',
  },
  {
    key: 'out',
    label: 'Out for delivery',
    statuses: ['out_for_delivery'],
    icon: Truck,
    tone: 'from-violet-400 to-violet-500',
  },
];

const MODE_FILTERS: Array<{ key: 'all' | OrderMode; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'dine_in', label: 'Dine-in' },
  { key: 'takeaway', label: 'Takeaway' },
  { key: 'delivery', label: 'Delivery' },
];

export function OrdersBoardPage() {
  const [modeFilter, setModeFilter] = useState<'all' | OrderMode>('all');
  const [assignFor, setAssignFor] = useState<OrderSnapshot | null>(null);
  const [deliverFor, setDeliverFor] = useState<OrderSnapshot | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();

  const ordersQ = useQuery({
    queryKey: ['orders', 'active', modeFilter],
    queryFn: () =>
      ipc.orders.listActive(modeFilter === 'all' ? undefined : { mode: modeFilter }),
    refetchInterval: 5_000,
  });

  const markPreparing = useMutation({
    mutationFn: (orderId: string) => ipc.orders.markPreparing(orderId),
    onSuccess: () => {
      toast({ title: 'Marked preparing' });
      void qc.invalidateQueries({ queryKey: ['orders', 'active'] });
    },
    onError: (e) =>
      toast({
        title: 'Action failed',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      }),
  });
  const markReady = useMutation({
    mutationFn: (orderId: string) => ipc.orders.markReady(orderId),
    onSuccess: () => {
      toast({ title: 'Marked ready' });
      void qc.invalidateQueries({ queryKey: ['orders', 'active'] });
    },
    onError: (e) =>
      toast({
        title: 'Action failed',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      }),
  });
  const unassign = useMutation({
    mutationFn: (orderId: string) => ipc.orders.unassignRider(orderId),
    onSuccess: () => {
      toast({ title: 'Rider cleared' });
      void qc.invalidateQueries({ queryKey: ['orders', 'active'] });
    },
    onError: (e) =>
      toast({
        title: 'Action failed',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      }),
  });

  const grouped = useMemo(() => {
    const out: Record<ColumnKey, OrderSnapshot[]> = {
      new: [],
      preparing: [],
      ready: [],
      out: [],
      done: [],
    };
    const orders = ordersQ.data ?? [];
    for (const snap of orders) {
      const col = COLUMNS.find((c) => c.statuses.includes(snap.order.status));
      if (col) out[col.key].push(snap);
    }
    return out;
  }, [ordersQ.data]);

  const totalActive = (ordersQ.data ?? []).length;

  return (
    <div className="flex h-full flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Live Orders</h1>
          <p className="mt-1 text-sm text-stone-500">
            {totalActive} active {totalActive === 1 ? 'order' : 'orders'} · auto-refreshes every 5s
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 rounded-xl bg-stone-100 p-1 dark:bg-stone-800">
            <Filter className="ml-2 h-3.5 w-3.5 text-stone-500" />
            {MODE_FILTERS.map((m) => (
              <button
                key={m.key}
                onClick={() => setModeFilter(m.key)}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors',
                  modeFilter === m.key
                    ? 'bg-white text-stone-900 shadow-soft-sm dark:bg-stone-700 dark:text-stone-100'
                    : 'text-stone-500 hover:text-stone-700 dark:hover:text-stone-300',
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => qc.invalidateQueries({ queryKey: ['orders', 'active'] })}
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        </div>
      </header>

      <div className="grid flex-1 grid-cols-4 gap-4 overflow-hidden">
        {COLUMNS.map((col) => {
          const Icon = col.icon;
          const orders = grouped[col.key];
          return (
            <div
              key={col.key}
              className="flex min-h-0 flex-col rounded-2xl bg-stone-100/60 p-3 dark:bg-stone-900/40"
            >
              <header className="mb-2 flex items-center justify-between px-1">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br text-white',
                      col.tone,
                    )}
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                  <h2 className="text-sm font-semibold">{col.label}</h2>
                </div>
                <span className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-stone-600 ring-1 ring-stone-200 dark:bg-stone-800 dark:text-stone-300 dark:ring-stone-700">
                  {orders.length}
                </span>
              </header>

              <div className="flex-1 space-y-2 overflow-y-auto pr-1">
                {orders.length === 0 ? (
                  <div className="flex h-32 items-center justify-center text-xs italic text-stone-400">
                    No orders here
                  </div>
                ) : (
                  orders.map((snap) => (
                    <OrderCard
                      key={snap.order.id}
                      snap={snap}
                      onMarkPreparing={() => markPreparing.mutate(snap.order.id)}
                      onMarkReady={() => markReady.mutate(snap.order.id)}
                      onAssignRider={() => setAssignFor(snap)}
                      onUnassign={() => unassign.mutate(snap.order.id)}
                      onMarkDelivered={() => setDeliverFor(snap)}
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      {assignFor && (
        <AssignRiderDialog
          snap={assignFor}
          onClose={() => setAssignFor(null)}
          onAssigned={() => {
            setAssignFor(null);
            void qc.invalidateQueries({ queryKey: ['orders', 'active'] });
          }}
        />
      )}
      {deliverFor && (
        <MarkDeliveredDialog
          snap={deliverFor}
          onClose={() => setDeliverFor(null)}
          onDone={() => {
            setDeliverFor(null);
            void qc.invalidateQueries({ queryKey: ['orders', 'active'] });
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// OrderCard — single card on the board
// ---------------------------------------------------------------------------

interface OrderCardProps {
  snap: OrderSnapshot;
  onMarkPreparing: () => void;
  onMarkReady: () => void;
  onAssignRider: () => void;
  onUnassign: () => void;
  onMarkDelivered: () => void;
}

function OrderCard({
  snap,
  onMarkPreparing,
  onMarkReady,
  onAssignRider,
  onUnassign,
  onMarkDelivered,
}: OrderCardProps) {
  const { order } = snap;
  const itemCount = snap.items.reduce((s, i) => s + i.quantity, 0);
  const totalPkr = (order.totalCents / 100).toLocaleString();

  return (
    <div className="rounded-xl bg-white p-3 shadow-soft-sm ring-1 ring-stone-200 transition-shadow hover:shadow-soft-md dark:bg-stone-800 dark:ring-stone-700">
      <header className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs font-semibold text-stone-500">
              #{order.orderNumber.split('-').pop() ?? order.orderNumber}
            </span>
            <ModeBadge mode={order.mode} />
          </div>
          {snap.customerName && (
            <div className="mt-1 flex items-center gap-1.5 text-sm font-medium text-stone-700 dark:text-stone-200">
              <UserRound className="h-3.5 w-3.5 text-stone-400" />
              {snap.customerName}
            </div>
          )}
        </div>
        <TimeBadge createdAt={order.createdAt} />
      </header>

      <div className="space-y-0.5 text-xs text-stone-600 dark:text-stone-400">
        {snap.items.slice(0, 3).map((i) => (
          <div key={i.id} className="truncate">
            <span className="font-semibold text-stone-700 dark:text-stone-200">{i.quantity}×</span>{' '}
            {i.menuItemName}
          </div>
        ))}
        {snap.items.length > 3 && (
          <div className="text-stone-400">+{snap.items.length - 3} more…</div>
        )}
      </div>

      {/* Delivery-specific blob: address, phone, rider */}
      {order.mode === 'delivery' && (
        <div className="mt-2 space-y-1 rounded-lg bg-stone-50 p-2 text-xs dark:bg-stone-900/60">
          {snap.customerPhone && (
            <div className="flex items-center gap-1.5 text-stone-600 dark:text-stone-400">
              <Phone className="h-3 w-3 shrink-0" />
              <a href={`tel:${snap.customerPhone}`} className="hover:text-amber-600">
                {snap.customerPhone}
              </a>
            </div>
          )}
          {snap.deliveryAddress && (
            <div className="flex items-start gap-1.5 text-stone-600 dark:text-stone-400">
              <MapPin className="mt-0.5 h-3 w-3 shrink-0" />
              <span className="line-clamp-2">{snap.deliveryAddress}</span>
            </div>
          )}
          {snap.rider && (
            <div className="flex items-center justify-between gap-1.5 rounded-md bg-violet-50 p-1.5 text-violet-800 dark:bg-violet-950/40 dark:text-violet-200">
              <span className="flex items-center gap-1.5">
                <Bike className="h-3 w-3" />
                <span className="font-semibold">{snap.rider.name}</span>
                <a
                  href={`tel:${snap.rider.phone}`}
                  className="font-mono text-[10px] hover:underline"
                >
                  {snap.rider.phone}
                </a>
              </span>
              {order.status === 'out_for_delivery' && (
                <button
                  className="rounded px-1 text-[10px] uppercase tracking-wider text-violet-700 hover:text-violet-900 dark:text-violet-300"
                  onClick={onUnassign}
                  title="Clear assignment"
                >
                  ×
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <footer className="mt-2 flex items-center justify-between border-t border-stone-100 pt-2 dark:border-stone-700">
        <div className="text-sm font-bold text-stone-900 dark:text-stone-100">
          Rs {totalPkr}
        </div>
        <div className="text-xs text-stone-400">
          {itemCount} {itemCount === 1 ? 'item' : 'items'}
        </div>
      </footer>

      <div className="mt-2 flex flex-wrap gap-1.5">
        <OrderActions
          status={order.status}
          mode={order.mode}
          onMarkPreparing={onMarkPreparing}
          onMarkReady={onMarkReady}
          onAssignRider={onAssignRider}
          onMarkDelivered={onMarkDelivered}
          paid={order.paidAt !== null}
        />
      </div>
    </div>
  );
}

function OrderActions(props: {
  status: OrderStatus;
  mode: OrderMode;
  onMarkPreparing: () => void;
  onMarkReady: () => void;
  onAssignRider: () => void;
  onMarkDelivered: () => void;
  paid: boolean;
}) {
  const { status, mode } = props;
  if (status === 'open' || status === 'sent_to_kitchen') {
    return (
      <Button size="sm" variant="primary" className="flex-1" onClick={props.onMarkPreparing}>
        <ChefHat className="h-3.5 w-3.5" />
        Start preparing
      </Button>
    );
  }
  if (status === 'preparing') {
    return (
      <Button size="sm" variant="success" className="flex-1" onClick={props.onMarkReady}>
        <CheckCircle2 className="h-3.5 w-3.5" />
        Mark ready
      </Button>
    );
  }
  if (status === 'ready') {
    if (mode === 'delivery') {
      return (
        <Button size="sm" variant="primary" className="flex-1" onClick={props.onAssignRider}>
          <Bike className="h-3.5 w-3.5" />
          Assign rider
        </Button>
      );
    }
    return (
      <Button size="sm" variant="success" className="flex-1" onClick={props.onMarkDelivered}>
        <CheckCircle2 className="h-3.5 w-3.5" />
        {mode === 'dine_in' ? 'Served' : 'Picked up'}
      </Button>
    );
  }
  if (status === 'out_for_delivery') {
    return (
      <Button size="sm" variant="success" className="flex-1" onClick={props.onMarkDelivered}>
        <CheckCircle2 className="h-3.5 w-3.5" />
        {props.paid ? 'Delivered' : 'Delivered + Collect cash'}
      </Button>
    );
  }
  return null;
}

function ModeBadge({ mode }: { mode: OrderMode }) {
  const labels: Record<OrderMode, { text: string; tone: string }> = {
    dine_in: { text: 'Dine-in', tone: 'bg-sky-50 text-sky-700 ring-sky-200' },
    takeaway: { text: 'Takeaway', tone: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
    delivery: { text: 'Delivery', tone: 'bg-violet-50 text-violet-700 ring-violet-200' },
    online: { text: 'Online', tone: 'bg-amber-50 text-amber-700 ring-amber-200' },
  };
  const m = labels[mode];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ring-1',
        m.tone,
      )}
    >
      {m.text}
    </span>
  );
}

function TimeBadge({ createdAt }: { createdAt: string }) {
  const minutes = Math.floor((Date.now() - new Date(createdAt).getTime()) / 60_000);
  let tone = 'text-stone-500';
  if (minutes >= 30) tone = 'text-red-600 font-semibold';
  else if (minutes >= 15) tone = 'text-amber-600 font-semibold';
  return (
    <span
      className={cn('flex items-center gap-1 whitespace-nowrap text-xs', tone)}
      title={new Date(createdAt).toLocaleString()}
    >
      {minutes >= 30 ? <Hourglass className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
      {minutes < 1 ? 'just now' : `${minutes}m`}
    </span>
  );
}
