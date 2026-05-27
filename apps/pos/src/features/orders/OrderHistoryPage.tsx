import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, cn } from '@cheeseoclock/ui';
import {
  Banknote,
  Calendar,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Eye,
  Phone,
  Printer,
  Search,
  Truck,
  Undo2,
  UserRound,
  X,
  XCircle,
} from 'lucide-react';
import { formatCents } from '@cheeseoclock/pos-domain';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import type {
  OrderMode,
  OrderSnapshot,
  OrderStatus,
} from '@cheeseoclock/shared-types';
import { VoidOrderDialog } from './VoidOrderDialog';
import { RefundOrderDialog } from './RefundOrderDialog';
import { MarkDeliveredDialog } from './MarkDeliveredDialog';
import { CreditCard } from 'lucide-react';

/**
 * Order History page — every order ever, filterable. Click a row for a
 * detail panel with reprint + cancel/refund actions.
 */
export function OrderHistoryPage() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<OrderStatus | 'any'>('any');
  const [modeFilter, setModeFilter] = useState<OrderMode | 'any'>('any');
  const [range, setRange] = useState<'today' | '7d' | '30d' | 'all'>('today');
  const [openId, setOpenId] = useState<string | null>(null);

  const { sinceIso, untilIso } = useMemo(() => computeRange(range), [range]);

  const historyQ = useQuery({
    queryKey: [
      'orders',
      'history',
      { search, statusFilter, modeFilter, sinceIso, untilIso },
    ],
    queryFn: () =>
      ipc.orders.history({
        search: search.trim() || undefined,
        status: statusFilter === 'any' ? undefined : statusFilter,
        mode: modeFilter === 'any' ? undefined : modeFilter,
        sinceIso,
        untilIso,
        limit: 200,
      }),
    refetchInterval: 15_000,
  });

  const rows = historyQ.data ?? [];
  const totals = useMemo(() => {
    let count = 0;
    let revenueCents = 0;
    for (const r of rows) {
      if (r.status === 'void' || r.status === 'refunded') continue;
      count += 1;
      revenueCents += r.totalCents;
    }
    return { count, revenueCents };
  }, [rows]);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Order History</h1>
          <p className="mt-1 text-sm text-stone-500">
            {totals.count} {totals.count === 1 ? 'order' : 'orders'} ·{' '}
            <span className="font-semibold text-amber-700">
              {formatCents(totals.revenueCents)}
            </span>{' '}
            net revenue
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-xl bg-stone-100 p-1 dark:bg-stone-800">
          <Calendar className="ml-2 h-3.5 w-3.5 text-stone-500" />
          {(['today', '7d', '30d', 'all'] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={cn(
                'rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors',
                range === r
                  ? 'bg-white text-stone-900 shadow-soft-sm dark:bg-stone-700 dark:text-stone-100'
                  : 'text-stone-500 hover:text-stone-700 dark:hover:text-stone-300',
              )}
            >
              {r === 'today' ? 'Today' : r === 'all' ? 'All time' : `Last ${r === '7d' ? '7' : '30'}d`}
            </button>
          ))}
        </div>
      </header>

      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[14rem]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search order #, customer name, or phone"
              className="w-full rounded-lg border border-stone-200 bg-white pl-9 pr-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as OrderStatus | 'any')}
            className="rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-800"
          >
            <option value="any">Any status</option>
            <option value="open">Open</option>
            <option value="sent_to_kitchen">Sent to kitchen</option>
            <option value="preparing">Preparing</option>
            <option value="ready">Ready</option>
            <option value="out_for_delivery">Out for delivery</option>
            <option value="delivered">Delivered</option>
            <option value="paid">Paid</option>
            <option value="void">Voided</option>
            <option value="refunded">Refunded</option>
          </select>
          <select
            value={modeFilter}
            onChange={(e) => setModeFilter(e.target.value as OrderMode | 'any')}
            className="rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-800"
          >
            <option value="any">Any mode</option>
            <option value="dine_in">Dine-in</option>
            <option value="takeaway">Takeaway</option>
            <option value="delivery">Delivery</option>
            <option value="online">Online</option>
          </select>
        </div>
      </Card>

      <Card className="overflow-hidden">
        {historyQ.isLoading ? (
          <div className="py-10 text-center text-sm text-stone-400">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="py-10 text-center text-sm text-stone-400">
            No orders match these filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-stone-200 bg-stone-50/50 text-left text-xs uppercase tracking-wider text-stone-500 dark:border-stone-700 dark:bg-stone-800">
                <tr>
                  <th className="px-4 py-2 font-semibold">Order #</th>
                  <th className="px-4 py-2 font-semibold">Mode</th>
                  <th className="px-4 py-2 font-semibold">Customer</th>
                  <th className="px-4 py-2 font-semibold">Items</th>
                  <th className="px-4 py-2 text-right font-semibold">Total</th>
                  <th className="px-4 py-2 font-semibold">Status</th>
                  <th className="px-4 py-2 font-semibold">When</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100 dark:divide-stone-700">
                {rows.map((o) => (
                  <tr
                    key={o.id}
                    onClick={() => setOpenId(o.id)}
                    className="cursor-pointer transition-colors hover:bg-amber-50/60 dark:hover:bg-amber-950/20"
                  >
                    <td className="px-4 py-2 font-mono text-xs font-semibold text-stone-700 dark:text-stone-200">
                      #{o.orderNumber.split('-').pop()}
                    </td>
                    <td className="px-4 py-2">
                      <ModeBadgeRow mode={o.mode} />
                    </td>
                    <td className="px-4 py-2">
                      {o.customerName ? (
                        <div className="leading-tight">
                          <div className="font-medium">{o.customerName}</div>
                          {o.customerPhone && (
                            <div className="font-mono text-[10px] text-stone-500">
                              {o.customerPhone}
                            </div>
                          )}
                        </div>
                      ) : o.tableLabel ? (
                        <span className="text-stone-600 dark:text-stone-300">
                          Table {o.tableLabel}
                        </span>
                      ) : (
                        <span className="text-stone-400">Walk-in</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-stone-500">{o.itemCount}</td>
                    <td className="px-4 py-2 text-right font-mono font-semibold">
                      {formatCents(o.totalCents)}
                    </td>
                    <td className="px-4 py-2">
                      <StatusBadgeRow status={o.status} paidAt={o.paidAt} />
                    </td>
                    <td className="px-4 py-2 text-stone-500">
                      {relativeTime(o.createdAt)}
                    </td>
                    <td className="px-4 py-2 text-right text-stone-400">
                      <ChevronRight className="ml-auto h-4 w-4" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {openId && (
        <OrderDetailDrawer orderId={openId} onClose={() => setOpenId(null)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right-side drawer with order detail
// ---------------------------------------------------------------------------

interface DrawerProps {
  orderId: string;
  onClose: () => void;
}

function OrderDetailDrawer({ orderId, onClose }: DrawerProps) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [voidOpen, setVoidOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [collectOpen, setCollectOpen] = useState(false);

  const snapQ = useQuery({
    queryKey: ['orders', 'detail', orderId],
    queryFn: () => ipc.orders.get(orderId),
  });
  const snap = snapQ.data;

  const reprintMut = useMutation({
    mutationFn: () => ipc.printer.reprint(orderId),
    onSuccess: () => toast({ title: 'Receipt sent to printer' }),
    onError: (e) =>
      toast({
        title: 'Reprint failed',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      }),
  });

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm"
        onClick={onClose}
      />
      <aside className="fixed right-0 top-0 z-50 flex h-full w-[440px] flex-col bg-white shadow-soft-lg dark:bg-stone-900">
        <header className="flex items-start justify-between border-b border-stone-200 px-5 py-4 dark:border-stone-700">
          <div>
            <h3 className="text-lg font-bold">
              {snap ? `#${snap.order.orderNumber.split('-').pop()}` : '…'}
            </h3>
            {snap && (
              <p className="text-xs text-stone-500">
                {new Date(snap.order.createdAt).toLocaleString()} · by{' '}
                {snap.cashierName}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {snapQ.isLoading || !snap ? (
          <div className="flex flex-1 items-center justify-center text-sm text-stone-400">
            Loading…
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto p-5">
              <div className="mb-3 flex items-center gap-2">
                <ModeBadgeRow mode={snap.order.mode} />
                <StatusBadgeRow
                  status={snap.order.status}
                  paidAt={snap.order.paidAt}
                />
              </div>

              {(snap.customerName || snap.customerPhone || snap.deliveryAddress) && (
                <div className="mb-4 rounded-xl bg-stone-50 p-3 text-sm dark:bg-stone-800/60">
                  {snap.customerName && (
                    <div className="flex items-center gap-1.5 font-medium">
                      <UserRound className="h-3.5 w-3.5 text-stone-400" />
                      {snap.customerName}
                    </div>
                  )}
                  {snap.customerPhone && (
                    <a
                      href={`tel:${snap.customerPhone}`}
                      className="mt-1 flex items-center gap-1.5 text-xs text-stone-600 hover:text-amber-600 dark:text-stone-400"
                    >
                      <Phone className="h-3 w-3" />
                      {snap.customerPhone}
                    </a>
                  )}
                  {snap.deliveryAddress && (
                    <div className="mt-1 flex items-start gap-1.5 text-xs text-stone-600 dark:text-stone-400">
                      <Truck className="mt-0.5 h-3 w-3" />
                      {snap.deliveryAddress}
                    </div>
                  )}
                  {snap.rider && (
                    <div className="mt-2 flex items-center gap-1.5 rounded-md bg-violet-100 px-2 py-1 text-xs text-violet-800 dark:bg-violet-950 dark:text-violet-200">
                      Rider: <strong>{snap.rider.name}</strong> · {snap.rider.phone}
                    </div>
                  )}
                </div>
              )}

              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-stone-500">
                Items
              </h4>
              <ul className="space-y-1.5">
                {snap.items.map((i) => (
                  <li
                    key={i.id}
                    className="flex items-start justify-between gap-2 text-sm"
                  >
                    <div>
                      <div>
                        <span className="font-semibold">{i.quantity}×</span>{' '}
                        {i.menuItemName}
                      </div>
                      {i.modifiers.length > 0 && (
                        <ul className="ml-4 text-[11px] text-stone-500">
                          {i.modifiers.map((m) => (
                            <li key={m.id}>+ {m.modifierName}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div className="font-mono text-sm">
                      {formatCents(i.lineTotalCents)}
                    </div>
                  </li>
                ))}
              </ul>

              <dl className="mt-4 space-y-1 border-t border-stone-200 pt-3 text-sm dark:border-stone-700">
                <Row k="Subtotal" v={formatCents(snap.order.subtotalCents)} />
                {snap.order.discountCents > 0 && (
                  <Row
                    k="Discount"
                    v={`− ${formatCents(snap.order.discountCents)}`}
                    tone="emerald"
                  />
                )}
                <Row k="Tax" v={formatCents(snap.order.taxCents)} />
                <Row
                  k="Total"
                  v={formatCents(snap.order.totalCents)}
                  emphasize
                />
              </dl>

              {snap.payments.length > 0 && (
                <>
                  <h4 className="mt-4 mb-2 text-xs font-semibold uppercase tracking-wider text-stone-500">
                    Payments
                  </h4>
                  <ul className="space-y-1 text-sm">
                    {snap.payments.map((p) => (
                      <li
                        key={p.id}
                        className="flex items-center justify-between rounded-md bg-stone-50 px-2 py-1.5 dark:bg-stone-800"
                      >
                        <span className="flex items-center gap-1.5">
                          <Banknote className="h-3.5 w-3.5 text-emerald-600" />
                          <span className="font-semibold uppercase">{p.method}</span>
                          {p.referenceNo && (
                            <span className="font-mono text-xs text-stone-500">
                              ({p.referenceNo})
                            </span>
                          )}
                        </span>
                        <span className="font-mono">{formatCents(p.amountCents)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {snap.order.voidReason && (
                <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
                  <strong>Voided:</strong> {snap.order.voidReason}
                </div>
              )}
            </div>

            {/* Footer: primary action on top (full-width), secondary row of
                ghost buttons below. Avoids the 3-flex-1 wrap that crammed
                "Collect payment" onto two lines. */}
            <footer className="space-y-2 border-t border-stone-200 px-4 py-3 dark:border-stone-700">
              {/* Primary: the most likely next action for this status. */}
              {snap.order.paidAt === null &&
                (snap.order.status === 'served' ||
                  snap.order.status === 'delivered' ||
                  snap.order.status === 'ready') && (
                  <Button
                    variant="success"
                    size="md"
                    className="w-full whitespace-nowrap"
                    onClick={() => setCollectOpen(true)}
                  >
                    <CreditCard className="h-4 w-4" />
                    Collect payment
                  </Button>
                )}
              {snap.order.status === 'paid' && (
                <Button
                  variant="danger"
                  size="md"
                  className="w-full whitespace-nowrap"
                  onClick={() => setRefundOpen(true)}
                  title="Issue a full refund"
                >
                  <Undo2 className="h-4 w-4" />
                  Refund
                </Button>
              )}
              {/* Secondary row: lower-impact actions, always present. */}
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="md"
                  className="flex-1 whitespace-nowrap"
                  onClick={() => reprintMut.mutate()}
                  disabled={reprintMut.isPending}
                >
                  <Printer className="h-4 w-4" />
                  {reprintMut.isPending ? 'Sending…' : 'Reprint'}
                </Button>
                {snap.order.status !== 'void' &&
                  snap.order.status !== 'refunded' &&
                  snap.order.paidAt === null && (
                    <Button
                      variant="ghost"
                      size="md"
                      className="flex-1 whitespace-nowrap text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
                      onClick={() => setVoidOpen(true)}
                    >
                      <XCircle className="h-4 w-4" />
                      Cancel
                    </Button>
                  )}
              </div>
            </footer>
          </>
        )}
      </aside>

      {voidOpen && snap && (
        <VoidOrderDialog
          snap={snap}
          onClose={() => setVoidOpen(false)}
          onDone={() => {
            setVoidOpen(false);
            void qc.invalidateQueries({ queryKey: ['orders'] });
          }}
        />
      )}
      {refundOpen && snap && (
        <RefundOrderDialog
          snap={snap}
          onClose={() => setRefundOpen(false)}
          onDone={() => {
            setRefundOpen(false);
            void qc.invalidateQueries({ queryKey: ['orders'] });
          }}
        />
      )}
      {collectOpen && snap && (
        <MarkDeliveredDialog
          snap={snap}
          onClose={() => setCollectOpen(false)}
          onDone={() => {
            setCollectOpen(false);
            void qc.invalidateQueries({ queryKey: ['orders'] });
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function Row({
  k,
  v,
  tone,
  emphasize,
}: {
  k: string;
  v: string;
  tone?: 'emerald';
  emphasize?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex justify-between',
        emphasize && 'rounded-md bg-amber-50 px-2 py-1.5 text-base font-bold dark:bg-amber-950/60',
        tone === 'emerald' && 'text-emerald-700 dark:text-emerald-300',
      )}
    >
      <dt className="text-stone-600 dark:text-stone-300">{k}</dt>
      <dd className="font-mono">{v}</dd>
    </div>
  );
}

function ModeBadgeRow({ mode }: { mode: OrderMode }) {
  const tones: Record<OrderMode, string> = {
    dine_in: 'bg-sky-100 text-sky-800',
    takeaway: 'bg-emerald-100 text-emerald-800',
    delivery: 'bg-violet-100 text-violet-800',
    online: 'bg-amber-100 text-amber-800',
  };
  const labels: Record<OrderMode, string> = {
    dine_in: 'Dine-in',
    takeaway: 'Takeaway',
    delivery: 'Delivery',
    online: 'Online',
  };
  return (
    <span
      className={cn(
        'inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase',
        tones[mode],
      )}
    >
      {labels[mode]}
    </span>
  );
}

function StatusBadgeRow({
  status,
  paidAt,
}: {
  status: OrderStatus;
  paidAt: string | null;
}) {
  const tone: Record<OrderStatus, string> = {
    open: 'bg-sky-100 text-sky-800',
    sent_to_kitchen: 'bg-sky-100 text-sky-800',
    preparing: 'bg-amber-100 text-amber-800',
    ready: 'bg-emerald-100 text-emerald-800',
    out_for_delivery: 'bg-violet-100 text-violet-800',
    delivered: 'bg-stone-200 text-stone-700',
    served: 'bg-stone-200 text-stone-700',
    paid: 'bg-emerald-100 text-emerald-800',
    void: 'bg-red-100 text-red-700',
    refunded: 'bg-orange-100 text-orange-800',
  };
  const label: Record<OrderStatus, string> = {
    open: 'Open',
    sent_to_kitchen: 'Sent to kitchen',
    preparing: 'Preparing',
    ready: 'Ready',
    out_for_delivery: 'Out for delivery',
    delivered: 'Delivered',
    served: 'Served',
    paid: 'Paid',
    void: 'Void',
    refunded: 'Refunded',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold',
        tone[status],
      )}
    >
      {status === 'void' ? (
        <XCircle className="h-2.5 w-2.5" />
      ) : status === 'paid' || status === 'served' ? (
        <CheckCircle2 className="h-2.5 w-2.5" />
      ) : (
        <CircleDot className="h-2.5 w-2.5" />
      )}
      {label[status]}
      {paidAt && status !== 'paid' && status !== 'refunded' && (
        <span className="ml-1 text-emerald-700">(paid)</span>
      )}
    </span>
  );
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diffMs / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function computeRange(range: 'today' | '7d' | '30d' | 'all'): {
  sinceIso?: string;
  untilIso?: string;
} {
  if (range === 'all') return {};
  const now = new Date();
  if (range === 'today') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { sinceIso: start.toISOString() };
  }
  const days = range === '7d' ? 7 : 30;
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return { sinceIso: start.toISOString() };
}
