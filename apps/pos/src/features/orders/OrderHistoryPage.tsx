import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { Calendar, ChevronLeft, ChevronRight, Printer, Search, X } from 'lucide-react';
import { formatCents } from '@cheeseoclock/pos-domain';
import type {
  OrderHistoryChannel,
  OrderHistoryFilter,
  OrderHistoryRow,
  OrderHistoryStatusGroup,
  PaymentMethod,
} from '@cheeseoclock/shared-types';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { OrderDetailDrawer } from './OrderDetailDrawer';
import { ModeBadge, StatusBadge } from './OrderBadges';
import {
  CHANNEL_CHOICES,
  DATE_PRESETS,
  HISTORY_PAGE_SIZE,
  PAYMENT_CHOICES,
  PAYMENT_LABELS,
  STATUS_CHOICES,
  historyRange,
  isOwed,
  orderTimeLabel,
  pageLabel,
  paymentLabel,
  shortOrderNumber,
  type HistoryDatePreset,
} from './historyFilters';

/**
 * Order History — every order that was actually placed (sent to the kitchen,
 * paid, handed over, cancelled or refunded). A cart still being rung up at
 * Checkout never shows here. Search by number, name or phone; filter by day,
 * status, type and payment; totals cover every page. Click a row for the
 * order in full with reprint / collect payment / refund / cancel.
 */
export function OrderHistoryPage() {
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search.trim(), 250);
  const [preset, setPreset] = useState<HistoryDatePreset>('today');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [statusGroup, setStatusGroup] = useState<OrderHistoryStatusGroup>('all');
  const [channel, setChannel] = useState<OrderHistoryChannel>('all');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | 'all'>('all');
  const [offset, setOffset] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const { toast } = useToast();

  // Any filter change goes back to the first page.
  const withReset =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setOffset(0);
    };

  // Recomputed every render; only changes when the trading day does, so the
  // query key stays put between refreshes.
  const range = historyRange(preset, new Date(), { from: customFrom, to: customTo });
  const request: OrderHistoryFilter = {
    ...range,
    ...(debouncedSearch ? { search: debouncedSearch } : {}),
    statusGroup,
    channel,
    paymentMethod,
    limit: HISTORY_PAGE_SIZE,
    offset,
  };

  const historyQ = useQuery({
    queryKey: ['orders', 'history', request],
    queryFn: () => ipc.orders.history(request),
    // Keep the old page on screen while the next one loads — no flashing.
    placeholderData: keepPreviousData,
    // Only ranges that include "now" change on their own. Totals over a whole
    // year take ~150 ms on the till's database thread: not every 15 s.
    refetchInterval: preset === 'today' || preset === 'week' ? 15_000 : false,
  });

  const page = historyQ.data;
  const rows = page?.rows ?? [];
  const total = page?.total ?? 0;
  const summary = page?.summary;

  const reprintMut = useMutation({
    mutationFn: (orderId: string) => ipc.printer.reprint(orderId),
    onSuccess: () => toast({ title: 'Receipt sent to printer' }),
    onError: (e) =>
      toast({ title: 'Reprint failed', description: e instanceof Error ? e.message : 'Unknown error', variant: 'error' }),
  });

  const filtersActive =
    search !== '' || statusGroup !== 'all' || channel !== 'all' || paymentMethod !== 'all';

  function clearFilters() {
    setSearch('');
    setStatusGroup('all');
    setChannel('all');
    setPaymentMethod('all');
    setOffset(0);
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Order History</h1>
          <p className="mt-1 text-sm text-stone-500">
            Orders sent to the kitchen or paid. A cart still being rung up is not shown.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-xl bg-stone-100 p-1 dark:bg-stone-800">
            <Calendar className="ml-2 h-4 w-4 text-stone-500" />
            {DATE_PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => withReset(setPreset)(p.key)}
                className={cn(
                  'rounded-lg px-3 py-2 text-sm font-semibold transition-colors',
                  preset === p.key
                    ? 'bg-white text-stone-900 shadow-soft-sm dark:bg-stone-700 dark:text-stone-100'
                    : 'text-stone-500 hover:text-stone-800 dark:hover:text-stone-200',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          {preset === 'custom' && (
            <div className="flex items-center gap-1.5 text-sm">
              <input
                type="date"
                value={customFrom}
                onChange={(e) => withReset(setCustomFrom)(e.target.value)}
                aria-label="From date"
                className="rounded-lg border border-stone-200 bg-white px-2 py-1.5 dark:border-stone-700 dark:bg-stone-800"
              />
              <span className="text-stone-400">to</span>
              <input
                type="date"
                value={customTo}
                onChange={(e) => withReset(setCustomTo)(e.target.value)}
                aria-label="To date"
                className="rounded-lg border border-stone-200 bg-white px-2 py-1.5 dark:border-stone-700 dark:bg-stone-800"
              />
            </div>
          )}
        </div>
      </header>

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[16rem] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
            <input
              value={search}
              onChange={(e) => withReset(setSearch)(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && search) {
                  e.stopPropagation();
                  withReset(setSearch)('');
                }
                // One match for what was typed: Enter opens it.
                const only = rows.length === 1 ? rows[0] : undefined;
                if (e.key === 'Enter' && only && debouncedSearch === search.trim() && !historyQ.isPlaceholderData) {
                  setOpenId(only.id);
                }
              }}
              autoFocus
              placeholder="Order #, customer name or phone"
              aria-label="Search orders"
              className="h-11 w-full rounded-lg border border-stone-200 bg-white pl-9 pr-9 text-base focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
            />
            {search && (
              <button
                type="button"
                onClick={() => withReset(setSearch)('')}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-stone-700"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <select
            value={channel}
            onChange={(e) => withReset(setChannel)(e.target.value as OrderHistoryChannel)}
            aria-label="Order type"
            className="h-11 rounded-lg border border-stone-200 bg-white px-3 text-sm dark:border-stone-700 dark:bg-stone-800"
          >
            {CHANNEL_CHOICES.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
          <select
            value={paymentMethod}
            onChange={(e) => withReset(setPaymentMethod)(e.target.value as PaymentMethod | 'all')}
            aria-label="Payment method"
            className="h-11 rounded-lg border border-stone-200 bg-white px-3 text-sm dark:border-stone-700 dark:bg-stone-800"
          >
            {PAYMENT_CHOICES.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
          {filtersActive && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              <X className="h-4 w-4" />
              Clear filters
            </Button>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Status">
          {STATUS_CHOICES.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => withReset(setStatusGroup)(s.key)}
              aria-pressed={statusGroup === s.key}
              className={cn(
                'rounded-full px-3.5 py-1.5 text-sm font-semibold ring-1 transition-colors',
                statusGroup === s.key
                  ? 'bg-stone-900 text-white ring-stone-900 dark:bg-amber-400 dark:text-stone-900 dark:ring-amber-400'
                  : 'bg-white text-stone-600 ring-stone-200 hover:ring-stone-300 dark:bg-stone-800 dark:text-stone-300 dark:ring-stone-700',
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </Card>

      {summary && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <SummaryTile label="Orders" value={summary.orderCount.toLocaleString('en-PK')} />
          <SummaryTile
            label="Sales (paid)"
            value={formatCents(summary.salesCents)}
            sub={`${summary.paidCount} paid`}
            tone="amber"
          />
          <SummaryTile
            label="Not paid yet"
            value={formatCents(summary.notPaidCents)}
            sub={`${summary.notPaidCount} ${summary.notPaidCount === 1 ? 'order' : 'orders'}`}
            tone={summary.notPaidCount > 0 ? 'warn' : undefined}
            onClick={() => withReset(setStatusGroup)('not_paid')}
          />
          <SummaryTile
            label="Cancelled"
            value={String(summary.cancelledCount)}
            sub={summary.cancelledCount > 0 ? formatCents(summary.cancelledCents) : undefined}
            onClick={() => withReset(setStatusGroup)('cancelled')}
          />
          <SummaryTile
            label="Refunded"
            value={formatCents(summary.refundedCents)}
            sub={`${summary.refundCount} ${summary.refundCount === 1 ? 'order' : 'orders'}`}
            onClick={() => withReset(setStatusGroup)('refunded')}
          />
        </div>
      )}
      {summary && summary.byMethod.length > 0 && (
        <p className="-mt-1 text-sm text-stone-500">
          Money in:{' '}
          {summary.byMethod.map((m, i) => (
            <span key={m.method}>
              {i > 0 && ' · '}
              {PAYMENT_LABELS[m.method]}{' '}
              <span className="font-semibold text-stone-700 dark:text-stone-200">{formatCents(m.netCents)}</span>
            </span>
          ))}
        </p>
      )}

      <Card className="overflow-hidden p-0">
        {historyQ.isError ? (
          <div className="py-12 text-center text-sm text-red-600">
            Could not load orders. {historyQ.error instanceof Error ? historyQ.error.message : ''}
          </div>
        ) : historyQ.isLoading ? (
          <div className="py-12 text-center text-sm text-stone-400">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="py-12 text-center text-sm text-stone-500">
            No orders match.{' '}
            {(filtersActive || preset !== 'all') && (
              <span>
                Try{' '}
                {preset !== 'all' && (
                  <button type="button" className="font-semibold text-amber-700 underline" onClick={() => withReset(setPreset)('all')}>
                    all dates
                  </button>
                )}
                {preset !== 'all' && filtersActive && ' or '}
                {filtersActive && (
                  <button type="button" className="font-semibold text-amber-700 underline" onClick={clearFilters}>
                    clearing the filters
                  </button>
                )}
                .
              </span>
            )}
          </div>
        ) : (
          <div className={cn('overflow-x-auto transition-opacity', historyQ.isPlaceholderData && 'opacity-60')}>
            <table className="w-full text-sm">
              <thead className="border-b border-stone-200 bg-stone-50 text-left text-xs uppercase tracking-wider text-stone-500 dark:border-stone-700 dark:bg-stone-800">
                <tr>
                  <th className="px-4 py-2.5 font-semibold">Order</th>
                  <th className="px-3 py-2.5 font-semibold">Time</th>
                  <th className="px-3 py-2.5 font-semibold">Type</th>
                  <th className="px-3 py-2.5 font-semibold">Customer</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Items</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Total</th>
                  <th className="px-3 py-2.5 font-semibold">Payment</th>
                  <th className="px-3 py-2.5 font-semibold">Status</th>
                  <th className="px-3 py-2.5" aria-label="Reprint" />
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100 dark:divide-stone-800">
                {rows.map((o) => (
                  <HistoryRow
                    key={o.id}
                    o={o}
                    onOpen={() => setOpenId(o.id)}
                    onReprint={() => reprintMut.mutate(o.id)}
                    reprinting={reprintMut.isPending && reprintMut.variables === o.id}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {total > 0 && (
          <footer className="flex items-center justify-between gap-3 border-t border-stone-200 px-4 py-2.5 text-sm dark:border-stone-700">
            <span className="text-stone-500">{pageLabel(offset, rows.length, total)}</span>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - HISTORY_PAGE_SIZE))}
              >
                <ChevronLeft className="h-4 w-4" />
                Newer
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={offset + rows.length >= total}
                onClick={() => setOffset(offset + HISTORY_PAGE_SIZE)}
              >
                Older
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </footer>
        )}
      </Card>

      {openId && <OrderDetailDrawer orderId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function HistoryRow({
  o,
  onOpen,
  onReprint,
  reprinting,
}: {
  o: OrderHistoryRow;
  onOpen: () => void;
  onReprint: () => void;
  reprinting: boolean;
}) {
  const owed = isOwed(o);
  const cancelled = o.status === 'void' || o.status === 'refunded';
  return (
    <tr
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      tabIndex={0}
      className={cn(
        'cursor-pointer transition-colors hover:bg-amber-50/70 focus:bg-amber-50 focus:outline-none dark:hover:bg-amber-950/20 dark:focus:bg-amber-950/30',
        cancelled && 'text-stone-400',
      )}
    >
      <td className="px-4 py-2.5">
        <div className="font-mono text-base font-bold text-stone-800 dark:text-stone-100">
          {shortOrderNumber(o.orderNumber)}
        </div>
        {o.source === 'web' && (
          <div className="text-[10px] font-semibold uppercase text-amber-700 dark:text-amber-300">Website</div>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-stone-600 dark:text-stone-300">{orderTimeLabel(o.createdAt)}</td>
      <td className="px-3 py-2.5">
        <ModeBadge mode={o.mode} />
      </td>
      <td className="px-3 py-2.5">
        {o.customerName || o.customerPhone ? (
          <div className="leading-tight">
            {o.customerName && <div className="font-medium">{o.customerName}</div>}
            {o.customerPhone && <div className="font-mono text-xs text-stone-500">{o.customerPhone}</div>}
            {o.riderName && <div className="text-xs text-violet-700 dark:text-violet-300">Rider: {o.riderName}</div>}
          </div>
        ) : o.tableLabel ? (
          <span className="text-stone-600 dark:text-stone-300">Table {o.tableLabel}</span>
        ) : (
          <span className="text-stone-400">Walk-in</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-right text-stone-600 dark:text-stone-300">{o.itemCount}</td>
      <td className="whitespace-nowrap px-3 py-2.5 text-right">
        <div className={cn('font-mono font-semibold', cancelled && 'line-through')}>{formatCents(o.totalCents)}</div>
        {o.refundedCents > 0 && (
          <div className="font-mono text-xs text-orange-700 dark:text-orange-300">− {formatCents(o.refundedCents)} back</div>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5">
        <span className={cn(owed ? 'font-bold text-amber-700 dark:text-amber-300' : 'text-stone-600 dark:text-stone-300')}>
          {paymentLabel(o)}
        </span>
      </td>
      <td className="px-3 py-2.5">
        <StatusBadge status={o.status} />
      </td>
      <td className="px-3 py-2.5 text-right">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onReprint();
          }}
          disabled={reprinting}
          aria-label="Reprint receipt"
          title="Reprint receipt"
          className="rounded-lg p-2 text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700 disabled:opacity-40 dark:hover:bg-stone-700 dark:hover:text-stone-200"
        >
          <Printer className="h-4 w-4" />
        </button>
      </td>
    </tr>
  );
}

function SummaryTile({
  label,
  value,
  sub,
  tone,
  onClick,
}: {
  label: string;
  value: string;
  sub?: string | undefined;
  tone?: 'amber' | 'warn' | undefined;
  onClick?: () => void;
}) {
  const body = (
    <>
      <div className="text-xs font-semibold uppercase tracking-wider text-stone-500">{label}</div>
      <div
        className={cn(
          'mt-0.5 font-mono text-xl font-bold',
          tone === 'amber' && 'text-amber-700 dark:text-amber-300',
          tone === 'warn' && 'text-orange-700 dark:text-orange-300',
        )}
      >
        {value}
      </div>
      {sub && <div className="text-xs text-stone-500">{sub}</div>}
    </>
  );
  const cls =
    'rounded-xl bg-white p-3 text-left ring-1 ring-stone-200/70 dark:bg-stone-900 dark:ring-stone-800';
  return onClick ? (
    <button type="button" onClick={onClick} className={cn(cls, 'transition-colors hover:ring-amber-300')} title={`Show ${label.toLowerCase()} orders`}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
