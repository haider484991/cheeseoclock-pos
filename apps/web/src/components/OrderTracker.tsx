'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { formatCents } from '@/lib/format';
import { BUSINESS } from '@/lib/business';
import type { WebOrderItem, WebOrderStatus } from '@cheeseoclock/shared-types';

interface TrackedOrder {
  id: string;
  status: WebOrderStatus;
  customerName: string;
  items: WebOrderItem[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  posOrderNumber: string | null;
  createdAt: string;
}

const STEPS: Array<{ key: WebOrderStatus; label: string; emoji: string }> = [
  { key: 'new', label: 'Order placed', emoji: '📝' },
  { key: 'accepted', label: 'Restaurant confirmed', emoji: '✅' },
  { key: 'preparing', label: 'In the kitchen', emoji: '👨‍🍳' },
  { key: 'ready', label: 'Packed & ready', emoji: '📦' },
  { key: 'out_for_delivery', label: 'Rider on the way', emoji: '🛵' },
  { key: 'delivered', label: 'Delivered — enjoy!', emoji: '🎉' },
];

function stepIndex(status: WebOrderStatus): number {
  return STEPS.findIndex((s) => s.key === status);
}

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

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);

  if (error && !order) {
    return (
      <div className="py-16 text-center">
        <div className="text-5xl">🤔</div>
        <h1 className="mt-3 text-xl font-black">{error}</h1>
        <a
          href={`tel:${BUSINESS.phoneE164}`}
          className="mt-4 inline-block font-bold text-amber-600 hover:underline"
        >
          📞 {BUSINESS.phoneDisplay}
        </a>
      </div>
    );
  }
  if (!order) {
    return <div className="py-24 text-center text-stone-400">Loading your order…</div>;
  }

  const cancelled = order.status === 'cancelled';
  const idx = stepIndex(order.status);

  return (
    <div className="animate-fade-in">
      {justPlaced && (
        <div className="mb-5 rounded-2xl bg-emerald-50 p-4 text-center ring-1 ring-emerald-200">
          <div className="text-3xl">🎉</div>
          <h1 className="mt-1 text-lg font-black text-emerald-900">
            Order placed, {order.customerName.split(' ')[0]}!
          </h1>
          <p className="text-sm text-emerald-700">
            Keep this page open to follow your order live.
          </p>
        </div>
      )}

      <div className="rounded-2xl bg-white p-5 shadow-soft-md ring-1 ring-stone-100">
        <div className="flex items-baseline justify-between">
          <h2 className="font-black">
            {order.posOrderNumber
              ? `Order #${order.posOrderNumber.split('-').pop()}`
              : 'Your order'}
          </h2>
          <span className="font-mono text-sm font-bold text-amber-700">
            {formatCents(order.totalCents)}
          </span>
        </div>

        {cancelled ? (
          <div className="mt-4 rounded-xl bg-red-50 p-4 text-center">
            <div className="text-3xl">😞</div>
            <p className="mt-1 font-bold text-red-800">This order was cancelled.</p>
            <p className="text-sm text-red-600">
              If that&rsquo;s unexpected, call us — {BUSINESS.phoneDisplay}.
            </p>
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
                          ? 'bg-gradient-to-br from-amber-400 to-amber-500 shadow-soft-sm'
                          : 'bg-stone-100 grayscale'
                      } ${current ? 'ring-4 ring-amber-200' : ''}`}
                    >
                      {s.emoji}
                    </div>
                    {i < STEPS.length - 1 && (
                      <div
                        className={`h-6 w-0.5 ${reached && i < idx ? 'bg-amber-400' : 'bg-stone-200'}`}
                      />
                    )}
                  </div>
                  <div className={`pb-2 pt-1.5 ${current ? '' : 'opacity-70'}`}>
                    <div className={`text-sm ${current ? 'font-black' : 'font-semibold'}`}>
                      {s.label}
                      {current && (
                        <span className="ml-2 inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        <div className="mt-4 border-t border-stone-100 pt-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-stone-400">Items</h3>
          <ul className="mt-2 space-y-1 text-sm">
            {order.items.map((i, n) => (
              <li key={n} className="flex justify-between">
                <span>
                  <span className="font-bold">{i.quantity}×</span> {i.name}
                  {i.modifiers.length > 0 && (
                    <span className="text-xs text-stone-400">
                      {' '}
                      (+{i.modifiers.map((m) => m.name).join(', ')})
                    </span>
                  )}
                </span>
                <span className="font-mono text-stone-500">
                  {formatCents(i.unitPriceCents * i.quantity)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <p className="mt-4 text-center text-sm text-stone-400">
        Questions about your order?{' '}
        <a href={BUSINESS.whatsappUrl} className="font-bold text-amber-600 hover:underline">
          WhatsApp us
        </a>{' '}
        or call {BUSINESS.phoneDisplay}.
      </p>
    </div>
  );
}
