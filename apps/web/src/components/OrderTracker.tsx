'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { formatCents } from '@/lib/format';
import { BUSINESS } from '@/lib/business';
import {
  type WebFulfilment,
  type WebOrderItem,
  type WebOrderStatus,
} from '@cheeseoclock/shared-types';

interface TrackedOrder {
  id: string;
  status: WebOrderStatus;
  customerName: string;
  /** Absent on orders from before pickup existed. */
  fulfilment?: WebFulfilment;
  items: WebOrderItem[];
  subtotalCents: number;
  discountCents?: number;
  taxCents: number;
  totalCents: number;
  posOrderNumber: string | null;
  createdAt: string;
}

type Step = { key: WebOrderStatus; label: string; emoji: string };

const DELIVERY_STEPS: Step[] = [
  { key: 'new', label: 'Order placed', emoji: '📝' },
  { key: 'accepted', label: 'Restaurant confirmed', emoji: '✅' },
  { key: 'preparing', label: 'In the kitchen', emoji: '👨‍🍳' },
  { key: 'ready', label: 'Packed & ready', emoji: '📦' },
  { key: 'out_for_delivery', label: 'Rider on the way', emoji: '🛵' },
  { key: 'delivered', label: 'Delivered — enjoy!', emoji: '🎉' },
];

// A pickup has no rider; the till reports "delivered" once it is collected.
const PICKUP_STEPS: Step[] = [
  { key: 'new', label: 'Order placed', emoji: '📝' },
  { key: 'accepted', label: 'Restaurant confirmed', emoji: '✅' },
  { key: 'preparing', label: 'In the kitchen', emoji: '👨‍🍳' },
  { key: 'ready', label: 'Ready — come and collect it', emoji: '🛍️' },
  { key: 'delivered', label: 'Collected — enjoy!', emoji: '🎉' },
];

/** How long "Order placed" may sit unconfirmed before the page suggests calling. */
const UNCONFIRMED_NOTICE_MS = 5 * 60_000;

export function OrderTracker({ orderId }: { orderId: string }) {
  const search = useSearchParams();
  const phone = search.get('phone') ?? '';
  const justPlaced = search.get('placed') === '1';
  const [order, setOrder] = useState<TrackedOrder | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/orders/${orderId}?phone=${encodeURIComponent(phone)}`,
        { cache: 'no-store' },
      );
      const json = (await res.json()) as { ok: boolean; data?: TrackedOrder };
      if (json.ok && json.data) {
        setOrder(json.data);
        setError(null);
      } else {
        setError('Order not found. Check the link, or call us.');
      }
    } catch {
      setError('Could not reach the server — retrying…');
    }
  }, [orderId, phone]);

  const finished = order?.status === 'delivered' || order?.status === 'cancelled';
  useEffect(() => {
    void load();
    if (finished) return;
    // Poll while the order is moving; a tab in the background waits until it
    // is looked at again, and a finished order stops asking altogether.
    const t = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void load();
    }, 6_000);
    const onVisible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load, finished]);

  // Re-render once a minute so the "not confirmed yet" notice appears on time.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  if (error && !order) {
    return (
      <div className="py-16 text-center">
        <div className="text-5xl">🤔</div>
        <h1 className="mt-3 text-xl font-black text-cream">{error}</h1>
        <a
          href={`tel:${BUSINESS.phoneE164}`}
          className="mt-4 inline-block font-bold text-cheese hover:text-cheese-hot"
        >
          📞 {BUSINESS.phoneDisplay}
        </a>
      </div>
    );
  }
  if (!order) {
    return <div className="py-24 text-center text-smoke">Loading your order…</div>;
  }

  const cancelled = order.status === 'cancelled';
  // Cancelled without ever being acked by the till: the restaurant never saw
  // it (expired by the site's sweep, or the shop closed before it was pulled).
  const unconfirmed = cancelled && !order.posOrderNumber;
  // Placed but not picked up by the till within a few minutes: tell the
  // customer to call rather than leave them staring at "Order placed".
  const waitingTooLong =
    order.status === 'new' &&
    Date.now() - Date.parse(order.createdAt) > UNCONFIRMED_NOTICE_MS;
  const pickup = order.fulfilment === 'pickup';
  const STEPS = pickup ? PICKUP_STEPS : DELIVERY_STEPS;
  const idx = STEPS.findIndex((s) => s.key === order.status);
  const discount = order.discountCents ?? 0;
  // The percent this order got (the till's offer when it was placed).
  const pct = order.subtotalCents > 0 ? Math.round((discount * 100) / order.subtotalCents) : 0;

  return (
    <div className="animate-fade-in">
      {justPlaced && (
        <div className="mb-5 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-center">
          <div className="text-3xl">🎉</div>
          <h1 className="mt-1 text-lg font-black text-emerald-300">
            Order placed, {order.customerName.split(' ')[0]}!
          </h1>
          <p className="text-sm text-emerald-200/80">
            Keep this page open to follow your order live.
          </p>
        </div>
      )}

      <div className="rounded-2xl border border-white/10 bg-night-card p-5">
        <div className="flex items-baseline justify-between">
          <h2 className="font-black text-cream">
            {order.posOrderNumber
              ? `Order #${order.posOrderNumber.split('-').pop()}`
              : 'Your order'}
          </h2>
          <span className="font-mono text-sm font-bold tabular-nums text-cheese">
            {formatCents(order.totalCents)}
          </span>
        </div>

        {pickup && !cancelled && (
          <div className="mt-3 rounded-xl border border-cheese/30 bg-cheese/10 p-3 text-sm">
            <p className="font-bold text-cream">
              Pick-up{pct > 0 ? ` · ${pct}% off` : ''} · pay at the counter
            </p>
            <p className="mt-0.5 text-cream/75">
              {BUSINESS.streetAddress}, {BUSINESS.locality}
            </p>
            <a
              href={BUSINESS.mapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-block font-bold text-cheese hover:text-cheese-hot"
            >
              Directions →
            </a>
          </div>
        )}

        {waitingTooLong && (
          <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-center text-sm">
            <p className="font-bold text-amber-200">
              The restaurant hasn&rsquo;t confirmed your order yet.
            </p>
            <p className="text-amber-200/80">
              Please call{' '}
              <a href={`tel:${BUSINESS.phoneE164}`} className="font-bold underline">
                {BUSINESS.phoneDisplay}
              </a>{' '}
              to make sure it was received.
            </p>
          </div>
        )}

        {cancelled ? (
          <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-center">
            <div className="text-3xl">😞</div>
            {unconfirmed ? (
              <>
                <p className="mt-1 font-bold text-red-300">
                  The restaurant couldn&rsquo;t confirm this order.
                </p>
                <p className="text-sm text-red-300/80">
                  Please call{' '}
                  <a href={`tel:${BUSINESS.phoneE164}`} className="font-bold underline">
                    {BUSINESS.phoneDisplay}
                  </a>
                  .
                </p>
              </>
            ) : (
              <>
                <p className="mt-1 font-bold text-red-300">This order was cancelled.</p>
                <p className="text-sm text-red-300/80">
                  If that&rsquo;s unexpected, call us — {BUSINESS.phoneDisplay}.
                </p>
              </>
            )}
          </div>
        ) : (
          <ol className="mt-4 space-y-0">
            {STEPS.map((s, i) => {
              const reached = i <= idx;
              const current = i === idx;
              return (
                <li key={s.key} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <div
                      className={`flex h-9 w-9 items-center justify-center rounded-full text-base transition-colors ${
                        reached
                          ? 'bg-cheese shadow-glow'
                          : 'bg-white/5 grayscale'
                      } ${current ? 'ring-4 ring-cheese/30' : ''}`}
                    >
                      {s.emoji}
                    </div>
                    {i < STEPS.length - 1 && (
                      <div
                        className={`h-6 w-0.5 ${reached && i < idx ? 'bg-cheese' : 'bg-white/10'}`}
                      />
                    )}
                  </div>
                  <div className={`pb-2 pt-1.5 ${current ? '' : 'opacity-60'}`}>
                    <div
                      className={`text-sm text-cream ${current ? 'font-black' : 'font-semibold'}`}
                    >
                      {s.label}
                      {current && (
                        <span className="ml-2 inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        <div className="mt-4 border-t border-white/10 pt-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-smoke">Items</h3>
          <ul className="mt-2 space-y-1 text-sm">
            {order.items.map((i, n) => (
              <li key={n} className="flex justify-between text-cream/90">
                <span>
                  <span className="font-bold">{i.quantity}×</span> {i.name}
                  {i.modifiers.length > 0 && (
                    <span className="text-xs text-smoke">
                      {' '}
                      (+{i.modifiers.map((m) => m.name).join(', ')})
                    </span>
                  )}
                </span>
                <span className="font-mono tabular-nums text-smoke">
                  {formatCents(i.unitPriceCents * i.quantity)}
                </span>
              </li>
            ))}
          </ul>
          <dl className="mt-3 space-y-1 border-t border-white/10 pt-2 text-sm text-smoke">
            <div className="flex justify-between">
              <dt>Subtotal</dt>
              <dd className="font-mono tabular-nums">{formatCents(order.subtotalCents)}</dd>
            </div>
            {discount > 0 && (
              <div className="flex justify-between text-emerald-300">
                <dt>Pick-up {pct}% off</dt>
                <dd className="font-mono tabular-nums">−{formatCents(discount)}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt>Tax</dt>
              <dd className="font-mono tabular-nums">{formatCents(order.taxCents)}</dd>
            </div>
            <div className="flex justify-between font-bold text-cream">
              <dt>Total</dt>
              <dd className="font-mono tabular-nums">{formatCents(order.totalCents)}</dd>
            </div>
          </dl>
        </div>
      </div>

      <p className="mt-4 text-center text-sm text-smoke">
        Questions about your order?{' '}
        <a href={BUSINESS.whatsappUrl} className="font-bold text-cheese hover:text-cheese-hot">
          WhatsApp us
        </a>{' '}
        or call {BUSINESS.phoneDisplay}.
      </p>
    </div>
  );
}
