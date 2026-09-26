import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { ChevronRight, Receipt, Search, X } from 'lucide-react';
import type { RecentCounterOrder } from '@cheeseoclock/shared-types';
import { RECENT_AT_COUNTER_LIMIT, counterOrderNumber } from '@cheeseoclock/pos-domain';
import { ipc } from '../../ipc/client';
import { OrderDetailDrawer } from './OrderDetailDrawer';
import { ModeBadge, PaidChip, StatusBadge } from './OrderBadges';
import { orderTimeLabel, shortOrderNumber } from './historyFilters';

/**
 * Recent Orders — the counter's small window on this shift (owner,
 * 2026-09-26). A cashier has no Order History; this lists the orders taken
 * on THIS till since the shift opened, newest first, so a customer back a few
 * minutes after pickup is served there and then: open the order, reprint the
 * receipt, or refund / cancel it with a manager's PIN. On a busy night the
 * newest few are not enough, so one order of the same shift can be found by
 * its WHOLE number off the receipt ("1043") — never by a part of one. No
 * totals, no customer names or phones in the list. Anything older is a
 * manager's, in Order History. The main process gives this list and opens
 * these orders only (orders:recentAtCounter, order-access.ts).
 */
export function RecentOrdersPage() {
  const [openId, setOpenId] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  /** The number being looked up, as typed; null = the newest orders. */
  const [lookingFor, setLookingFor] = useState<string | null>(null);
  const [typedProblem, setTypedProblem] = useState(false);

  const recentQ = useQuery({
    queryKey: ['orders', 'recent', lookingFor],
    queryFn: () => ipc.orders.recentAtCounter(lookingFor ?? undefined),
    refetchInterval: lookingFor === null ? 15_000 : false,
  });
  const rows = recentQ.data ?? [];

  function find() {
    const t = typed.trim();
    if (!t) {
      setLookingFor(null);
      setTypedProblem(false);
      return;
    }
    if (!counterOrderNumber(t)) {
      setTypedProblem(true);
      return;
    }
    setTypedProblem(false);
    setLookingFor(t);
  }

  function showNewest() {
    setTyped('');
    setTypedProblem(false);
    setLookingFor(null);
  }

  const shownNumber = lookingFor === null ? '' : `#${lookingFor.replace(/^#\s*/, '').split('-').pop() ?? lookingFor}`;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Recent orders</h1>
        <p className="mt-1 text-sm text-stone-500">
          Orders taken on this till since the shift opened (the last {RECENT_AT_COUNTER_LIMIT}). Tap one to reprint it
          or, with a manager&apos;s PIN, refund or cancel it. Not in the list? Type the order number from the receipt.
          For older orders, ask a manager.
        </p>
      </header>

      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          find();
        }}
      >
        <label className="sr-only" htmlFor="recent-order-number">
          Order number
        </label>
        <input
          id="recent-order-number"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value);
            setTypedProblem(false);
          }}
          placeholder="Order number, e.g. 1043"
          className="h-11 w-56 rounded-lg border border-stone-300 bg-white px-3 font-mono text-base dark:border-stone-700 dark:bg-stone-900"
        />
        <Button type="submit" variant="secondary" size="md" className="h-11">
          <Search className="h-4 w-4" />
          Find
        </Button>
        {lookingFor !== null && (
          <Button type="button" variant="ghost" size="md" className="h-11" onClick={showNewest}>
            <X className="h-4 w-4" />
            Show the latest
          </Button>
        )}
        {typedProblem && (
          <p role="alert" className="w-full text-sm text-amber-700 dark:text-amber-300">
            Type the whole order number from the receipt, like 1043.
          </p>
        )}
      </form>

      <Card className="p-0">
        {recentQ.isError ? (
          <div className="p-6 text-center text-sm text-red-600">Could not load the orders. Try again in a moment.</div>
        ) : recentQ.isLoading ? (
          <div className="p-6 text-center text-sm text-stone-400">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-8 text-center text-sm text-stone-500">
            <Receipt className="h-6 w-6 text-stone-300" />
            {lookingFor === null
              ? 'No orders on this till in this shift yet. Orders still cooking or out with a rider are on Live Orders.'
              : `No order ${shownNumber} on this till in this shift. If it is still cooking or out with a rider, it is on Live Orders. Older orders: ask a manager.`}
          </div>
        ) : (
          <ul className="divide-y divide-stone-100 dark:divide-stone-800">
            {rows.map((o) => (
              <RecentRow key={o.id} order={o} onOpen={() => setOpenId(o.id)} />
            ))}
          </ul>
        )}
      </Card>

      {openId && <OrderDetailDrawer orderId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function RecentRow({ order: o, onOpen }: { order: RecentCounterOrder; onOpen: () => void }) {
  const cancelled = o.status === 'void' || o.status === 'refunded';
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          'flex min-h-[56px] w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-amber-50/70 focus:bg-amber-50 focus:outline-none dark:hover:bg-amber-950/20 dark:focus:bg-amber-950/30',
          cancelled && 'text-stone-400',
        )}
      >
        <div className="w-24 shrink-0">
          <div className="font-mono text-base font-bold text-stone-800 dark:text-stone-100">
            {shortOrderNumber(o.orderNumber)}
          </div>
          {o.source === 'web' && (
            <div className="text-[10px] font-semibold uppercase text-amber-700 dark:text-amber-300">Website</div>
          )}
        </div>
        <span className="w-28 shrink-0 whitespace-nowrap text-sm text-stone-600 dark:text-stone-300">
          {orderTimeLabel(o.createdAt)}
        </span>
        <ModeBadge mode={o.mode} />
        <span className="ml-auto flex items-center gap-2">
          <StatusBadge status={o.status} />
          {!cancelled && <PaidChip paid={o.paid} />}
          <ChevronRight className="h-4 w-4 text-stone-300" />
        </span>
      </button>
    </li>
  );
}
