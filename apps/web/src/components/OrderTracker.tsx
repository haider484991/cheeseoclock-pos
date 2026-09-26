'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { formatCents } from '@/lib/format';
import { BUSINESS, waLink } from '@/lib/business';
import { STORAGE_KEYS, parseLastOrder, readStored, serializeReorder, writeStored } from '@/lib/device-memory';
import { orderItemChoices, orderMoney, savedLinesFromOrderItems, shortOrderNumber } from '@/lib/order-display';
import { type WebFulfilment, type WebOrderItem, type WebOrderStatus } from '@cheeseoclock/shared-types';

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
const POLL_MS = 6_000;

type LoadState = 'loading' | 'ok' | 'need_phone' | 'not_found' | 'offline';

export function OrderTracker({ orderId }: { orderId: string }) {
  const router = useRouter();
  const search = useSearchParams();
  const urlPhone = search.get('phone') ?? '';
  const justPlaced = search.get('placed') === '1';
  // "Track it" links from this phone carry no number: use the one the order
  // was placed with here, kept on the phone rather than in the address bar.
  const [phone, setPhone] = useState(urlPhone);
  const [phoneChecked, setPhoneChecked] = useState(Boolean(urlPhone));
  useEffect(() => {
    if (urlPhone) return;
    const last = parseLastOrder(readStored(STORAGE_KEYS.lastOrder));
    if (last?.orderId === orderId) setPhone(last.phone);
    setPhoneChecked(true);
  }, [orderId, urlPhone]);

  const [order, setOrder] = useState<TrackedOrder | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  /** Asking again won't help (no number, or no such order for it) until the customer types one. */
  const stopped = useRef(false);

  const load = useCallback(async () => {
    if (!phone) {
      stopped.current = true;
      setState('need_phone');
      return;
    }
    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}?phone=${encodeURIComponent(phone)}`, {
        cache: 'no-store',
      });
      const json = (await res.json().catch(() => null)) as { ok: boolean; data?: TrackedOrder; error?: string } | null;
      stopped.current = json?.error === 'not_found' || json?.error === 'phone_required';
      if (json?.ok && json.data) {
        setOrder(json.data);
        setState('ok');
        setUpdatedAt(Date.now());
      } else if (json?.error === 'not_found') {
        setState('not_found');
      } else if (json?.error === 'phone_required') {
        setState('need_phone');
      } else {
        setState('offline');
      }
    } catch {
      setState('offline');
    }
  }, [orderId, phone]);

  const finished = order?.status === 'delivered' || order?.status === 'cancelled';
  useEffect(() => {
    if (!phoneChecked) return;
    void load();
    if (finished) return;
    // Poll while the order is moving; a tab in the background waits until it
    // is looked at again, and a finished order stops asking altogether.
    const t = setInterval(() => {
      if (document.hidden || stopped.current) return;
      void load();
    }, POLL_MS);
    const onVisible = () => {
      if (!document.hidden && !stopped.current) void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load, finished, phoneChecked]);

  // Re-render once a minute so the "not confirmed yet" notice appears on time.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  const statusLabel = order ? currentLabel(order) : null;
  useEffect(() => {
    if (statusLabel) document.title = `${statusLabel} · Track your order · Cheese O'Clock`;
  }, [statusLabel]);

  if (!order) {
    if (state === 'need_phone' || state === 'not_found') {
      return (
        <PhoneGate
          notFound={state === 'not_found'}
          initial={phone}
          onSubmit={(p) => {
            setState('loading');
            if (p === phone) void load();
            else setPhone(p);
          }}
        />
      );
    }
    if (state === 'offline') {
      return (
        <div className="py-16 text-center" role="alert">
          <div className="text-5xl" aria-hidden>
            📶
          </div>
          <h1 className="mt-3 text-xl font-black text-cream">Can&rsquo;t reach the server — retrying…</h1>
          <p className="mt-2 text-sm text-smoke">Check your connection. This page keeps trying on its own.</p>
          <ContactButtons />
        </div>
      );
    }
    return <TrackerSkeleton />;
  }

  const cancelled = order.status === 'cancelled';
  // Cancelled without ever being acked by the till: the restaurant never saw
  // it (expired by the site's sweep, or the shop closed before it was pulled).
  const unconfirmed = cancelled && !order.posOrderNumber;
  // Placed but not picked up by the till within a few minutes: tell the
  // customer to call rather than leave them staring at "Order placed".
  const waitingTooLong = order.status === 'new' && Date.now() - Date.parse(order.createdAt) > UNCONFIRMED_NOTICE_MS;
  const pickup = order.fulfilment === 'pickup';
  const STEPS = pickup ? PICKUP_STEPS : DELIVERY_STEPS;
  const idx = STEPS.findIndex((s) => s.key === order.status);
  const discount = order.discountCents ?? 0;
  // The percent this order got (the till's offer when it was placed).
  const pct = order.subtotalCents > 0 ? Math.round((discount * 100) / order.subtotalCents) : 0;
  const { food, itemsCents, deliveryCents } = orderMoney(order);
  const number = shortOrderNumber(order.posOrderNumber);
  const celebrate = justPlaced && !cancelled;
  const waAbout = waLink(
    `Hi Cheese O'Clock! About my website order${number ? ` #${number}` : ''} (${order.customerName}): `,
  );

  function orderAgain() {
    writeStored(STORAGE_KEYS.reorder, serializeReorder(savedLinesFromOrderItems(order!.items)));
    router.push('/menu');
  }

  return (
    <div className="animate-fade-in">
      {celebrate && (
        <div className="mb-5 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-center">
          <div className="text-3xl" aria-hidden>
            🎉
          </div>
          <h1 className="mt-1 text-lg font-black text-emerald-300">
            Order placed, {order.customerName.split(' ')[0]}!
          </h1>
          <p className="text-sm text-emerald-200/80">
            This page updates by itself. You can close it — &ldquo;Track it&rdquo; on our menu page brings you back.
          </p>
        </div>
      )}

      <div className="rounded-2xl border border-white/10 bg-night-card p-5">
        <div className="flex items-baseline justify-between gap-3">
          {celebrate ? (
            <h2 className="font-black text-cream">{number ? `Order #${number}` : 'Your order'}</h2>
          ) : (
            <h1 className="font-black text-cream">{number ? `Order #${number}` : 'Your order'}</h1>
          )}
          <span className="font-mono text-sm font-bold tabular-nums text-cheese">{formatCents(order.totalCents)}</span>
        </div>
        <p className="mt-1 flex items-center gap-2 text-xs text-smoke" aria-live="polite">
          {finished ? (
            'Final status'
          ) : state === 'offline' ? (
            <>
              <span className="h-2 w-2 rounded-full bg-amber-400" aria-hidden /> Reconnecting…
            </>
          ) : (
            <>
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" aria-hidden /> Live
              {updatedAt ? ` · updated ${clock(updatedAt)}` : ''}
            </>
          )}
        </p>

        {pickup && !cancelled && (
          <div className="mt-3 rounded-xl border border-cheese/30 bg-cheese/10 p-3 text-sm">
            <p className="font-bold text-cream">Pick-up{pct > 0 ? ` · ${pct}% off` : ''} · pay at the counter</p>
            <p className="mt-0.5 text-cream/75">
              {BUSINESS.streetAddress}, {BUSINESS.locality}
            </p>
            <a
              href={BUSINESS.mapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-block py-1 font-bold text-cheese hover:text-cheese-hot"
            >
              Directions →
            </a>
          </div>
        )}

        {waitingTooLong && (
          <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-center text-sm">
            <p className="font-bold text-amber-200">The restaurant hasn&rsquo;t confirmed your order yet.</p>
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
          <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-center" role="alert">
            <div className="text-3xl" aria-hidden>
              😞
            </div>
            {unconfirmed ? (
              <>
                <p className="mt-1 font-bold text-red-300">The restaurant couldn&rsquo;t confirm this order.</p>
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
                <p className="text-sm text-red-300/80">If that&rsquo;s unexpected, call us — {BUSINESS.phoneDisplay}.</p>
              </>
            )}
          </div>
        ) : (
          <ol className="mt-4 space-y-0" aria-label="Order progress">
            {STEPS.map((s, i) => {
              const reached = i <= idx;
              const current = i === idx;
              return (
                <li key={s.key} className="flex gap-3" aria-current={current ? 'step' : undefined}>
                  <div className="flex flex-col items-center">
                    <div
                      aria-hidden
                      className={`flex h-9 w-9 items-center justify-center rounded-full text-base transition-colors ${
                        reached ? 'bg-cheese shadow-glow' : 'bg-white/5 grayscale'
                      } ${current ? 'ring-4 ring-cheese/30' : ''}`}
                    >
                      {s.emoji}
                    </div>
                    {i < STEPS.length - 1 && (
                      <div aria-hidden className={`h-6 w-0.5 ${reached && i < idx ? 'bg-cheese' : 'bg-white/10'}`} />
                    )}
                  </div>
                  <div className={`pb-2 pt-1.5 ${current ? '' : 'opacity-60'}`}>
                    <div className={`text-sm text-cream ${current ? 'font-black' : 'font-semibold'}`}>
                      {s.label}
                      {reached && !current && <span className="sr-only"> (done)</span>}
                      {current && (
                        <span aria-hidden className="ml-2 inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
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
          <ul className="mt-2 space-y-1.5 text-sm">
            {food.map((i, n) => {
              const { leaveOuts, others } = orderItemChoices(i);
              return (
                <li key={n} className="flex justify-between gap-3 text-cream/90">
                  <span className="min-w-0">
                    <span className="font-bold">{i.quantity}×</span> {i.name}
                    {others.length > 0 && <span className="block text-xs text-smoke">{others.join(' · ')}</span>}
                    {leaveOuts.length > 0 && (
                      <span className="block text-xs font-bold text-red-300">{leaveOuts.join(' · ')}</span>
                    )}
                    {i.notes && <span className="block break-words text-xs text-smoke">Note: {i.notes}</span>}
                  </span>
                  <span className="shrink-0 font-mono tabular-nums text-smoke">
                    {formatCents(i.unitPriceCents * i.quantity)}
                  </span>
                </li>
              );
            })}
          </ul>
          <dl className="mt-3 space-y-1 border-t border-white/10 pt-2 text-sm text-smoke">
            <div className="flex justify-between">
              <dt>Items</dt>
              <dd className="font-mono tabular-nums">{formatCents(itemsCents)}</dd>
            </div>
            {deliveryCents > 0 && (
              <div className="flex justify-between">
                <dt>Delivery</dt>
                <dd className="font-mono tabular-nums">{formatCents(deliveryCents)}</dd>
              </div>
            )}
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
              <dt>Total{pickup ? ' · pay at the counter' : ' · cash on delivery'}</dt>
              <dd className="font-mono tabular-nums">{formatCents(order.totalCents)}</dd>
            </div>
          </dl>
          <p className="mt-2 text-xs text-smoke">The printed receipt from the kitchen is the final bill.</p>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-2">
        <a
          href={`tel:${BUSINESS.phoneE164}`}
          className="flex min-h-[3rem] items-center justify-center gap-2 rounded-full border border-white/15 px-4 font-bold text-cream hover:border-cheese/60 hover:text-cheese"
        >
          <span aria-hidden>📞</span> Call us
        </a>
        <a
          href={waAbout}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-h-[3rem] items-center justify-center gap-2 rounded-full border border-white/15 px-4 font-bold text-cream hover:border-cheese/60 hover:text-cheese"
        >
          <span aria-hidden>💬</span> WhatsApp
        </a>
      </div>
      {finished ? (
        <button
          type="button"
          onClick={orderAgain}
          className="mt-3 flex min-h-[3.25rem] w-full items-center justify-center rounded-full bg-cheese px-6 font-display text-xl uppercase tracking-wide text-night shadow-glow hover:bg-cheese-hot"
        >
          Order this again →
        </button>
      ) : (
        <Link
          href="/menu"
          className="mt-3 flex min-h-[3rem] w-full items-center justify-center rounded-full text-sm font-bold text-cheese hover:text-cheese-hot"
        >
          Back to the menu
        </Link>
      )}
    </div>
  );
}

function currentLabel(order: TrackedOrder): string {
  if (order.status === 'cancelled') return 'Cancelled';
  const steps = order.fulfilment === 'pickup' ? PICKUP_STEPS : DELIVERY_STEPS;
  return steps.find((s) => s.key === order.status)?.label ?? 'Your order';
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-PK', { hour: 'numeric', minute: '2-digit' });
}

function ContactButtons() {
  return (
    <div className="mt-5 flex flex-wrap justify-center gap-2">
      <a
        href={`tel:${BUSINESS.phoneE164}`}
        className="rounded-full border border-white/15 px-5 py-3 font-bold text-cream hover:border-cheese/60 hover:text-cheese"
      >
        📞 {BUSINESS.phoneDisplay}
      </a>
      <a
        href={BUSINESS.whatsappUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="rounded-full border border-white/15 px-5 py-3 font-bold text-cream hover:border-cheese/60 hover:text-cheese"
      >
        💬 WhatsApp
      </a>
    </div>
  );
}

/**
 * The order is shown only to someone who knows the number it was placed
 * with (api/orders/[id]). A link without it, or with a mistyped one, asks.
 */
function PhoneGate({
  notFound,
  initial,
  onSubmit,
}: {
  notFound: boolean;
  initial: string;
  onSubmit: (phone: string) => void;
}) {
  const [value, setValue] = useState(notFound ? '' : initial);
  return (
    <div className="py-10">
      <div className="text-center text-5xl" aria-hidden>
        {notFound ? '🤔' : '🔒'}
      </div>
      <h1 className="mt-3 text-center text-xl font-black text-cream">
        {notFound ? 'We couldn’t find that order' : 'Track your order'}
      </h1>
      <p className="mt-2 text-center text-sm text-smoke">
        {notFound
          ? 'Check the mobile number you ordered with and try again — or call us.'
          : 'Enter the mobile number you ordered with to see your order.'}
      </p>
      <form
        className="mx-auto mt-5 flex max-w-sm flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
      >
        <label htmlFor="track-phone" className="text-xs font-bold uppercase tracking-wider text-smoke">
          Mobile number
        </label>
        <input
          id="track-phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="0300 1234567"
          maxLength={20}
          className="w-full rounded-xl border-2 border-white/15 bg-night-soft px-3.5 py-3 text-base font-medium text-cream outline-none placeholder:text-cream/30 focus:border-cheese"
        />
        <button
          type="submit"
          className="min-h-[3rem] rounded-full bg-cheese px-6 font-bold text-night hover:bg-cheese-hot disabled:opacity-50"
          disabled={!value.trim()}
        >
          Show my order
        </button>
      </form>
      <ContactButtons />
    </div>
  );
}

function TrackerSkeleton() {
  return (
    <div className="animate-pulse" aria-busy="true" aria-label="Loading your order">
      <div className="rounded-2xl border border-white/10 bg-night-card p-5">
        <div className="h-5 w-32 rounded bg-white/10" />
        <div className="mt-2 h-3 w-24 rounded bg-white/5" />
        <div className="mt-6 space-y-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-full bg-white/10" />
              <div className="h-3 w-40 rounded bg-white/10" />
            </div>
          ))}
        </div>
      </div>
      <p className="sr-only">Loading your order…</p>
    </div>
  );
}
