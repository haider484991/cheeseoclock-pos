'use client';

import { useEffect, useState } from 'react';
import { timeWords, type PublishedShopHours } from '@cheeseoclock/shared-types';
import { karachiClock, nextOpening, openByHours } from '@/lib/cheese-time';

type Status = { kind: 'open' } | { kind: 'paused' } | { kind: 'closed'; opens: string };

/**
 * The brand's clock at the top of the home page (3 Nov 2026: people from Google come for a delivery now): the time in
 * Karachi and whether the kitchen takes orders. The page is served with the opening hours (`fallback`, the same for
 * everyone); after it loads, the website's own answer (api/store-status: the till is on and taking orders) and the
 * Karachi clock:
 *  - taking orders → "It's 9:42 pm in DHA · Taking orders till 1 am";
 *  - not, outside the hours → "It's 3:16 am in DHA · Closed now · we open at 1 pm" (tomorrow / on Monday when not
 *    today);
 *  - not, inside the hours (the till is off) → "It's 2:05 pm in DHA · Not taking online orders right now".
 * One request per page view, cached by the CDN for a few seconds; it never blocks the page.
 */
export function OpenNowClient({
  className = '',
  fallback,
  hours,
}: {
  className?: string;
  fallback: string;
  hours: Pick<PublishedShopHours, 'opens' | 'closes' | 'days'>;
}) {
  const [status, setStatus] = useState<{ time: string; now: Status } | null>(null);

  useEffect(() => {
    let live = true;
    fetch('/api/store-status', { cache: 'no-store' })
      .then((r) => r.json() as Promise<{ ok?: boolean; data?: { acceptingOrders?: boolean } }>)
      .then((j) => {
        if (!live || !j.ok || !j.data) return;
        const clock = karachiClock(new Date());
        const now: Status = j.data.acceptingOrders
          ? { kind: 'open' }
          : openByHours(hours, clock.day, clock.now)
            ? { kind: 'paused' }
            : { kind: 'closed', opens: nextOpening(hours, clock.day, clock.now) };
        setStatus({ time: clock.time, now });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [hours]);

  const open = status?.now.kind === 'open';
  return (
    <p className={`flex items-center gap-2.5 ${className}`} aria-live="polite">
      <span
        aria-hidden
        className={`h-2.5 w-2.5 shrink-0 rounded-full ${open ? 'animate-pulse bg-emerald-400 motion-reduce:animate-none' : status ? 'bg-cream/35' : 'bg-cheese'}`}
      />
      <span>
        {status === null ? (
          fallback
        ) : (
          <>
            It&rsquo;s <span className="text-cheese">{status.time}</span> in DHA ·{' '}
            {status.now.kind === 'open'
              ? `Taking orders till ${timeWords(hours.closes)}`
              : status.now.kind === 'paused'
                ? 'Not taking online orders right now'
                : `Closed now · we open ${status.now.opens}`}
          </>
        )}
      </span>
    </p>
  );
}
