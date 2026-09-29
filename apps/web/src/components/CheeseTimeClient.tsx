'use client';

import { useEffect, useState } from 'react';
import type { PublishedShopHours } from '@cheeseoclock/shared-types';
import { cheeseTimeFallback, cheeseTimeLine, karachiClock } from '@/lib/cheese-time';

/**
 * Time-aware brand line: "It's 8:47 PM in DHA — definitely Cheese O'Clock."
 * Renders a static fallback on the server (the ISR page is the same for
 * everyone), then — once it has asked the website whether the till is
 * taking orders (GET /api/store-status: once, and again when the tab comes
 * back into view) — the live Karachi time and what that means: taking
 * orders, open by the hours but not taking website orders yet, or when it
 * opens. The status can't be read: the hours alone, as before. The hours
 * and the name are the owner's (the server half, CheeseTime, passes them).
 */
export function CheeseTimeClient({
  className = '',
  hours,
  nameIsDefault,
  nameProse,
}: {
  className?: string;
  hours: Pick<PublishedShopHours, 'opens' | 'closes' | 'days'>;
  nameIsDefault: boolean;
  nameProse: string;
}) {
  const [line, setLine] = useState<{ time: string; words: string } | null>(null);

  useEffect(() => {
    let alive = true;
    // undefined = not asked yet (the served line stays); null = could not tell (the hours decide).
    let accepting: boolean | null | undefined;
    const show = () => {
      if (accepting === undefined) return;
      const clock = karachiClock(new Date());
      setLine({ time: clock.time, words: cheeseTimeLine({ hours, nameIsDefault, nameProse, ...clock, accepting }) });
    };
    const ask = async () => {
      try {
        const res = await fetch('/api/store-status', { cache: 'no-store' });
        const body = (await res.json()) as { ok?: boolean; data?: { acceptingOrders?: unknown } };
        accepting = res.ok && typeof body.data?.acceptingOrders === 'boolean' ? body.data.acceptingOrders : null;
      } catch {
        accepting = null;
      }
      if (alive) show();
    };
    void ask();
    const tick = setInterval(show, 30_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void ask();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(tick);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [hours, nameIsDefault, nameProse]);

  return (
    <p className={className}>
      {line ? (
        <>
          It&rsquo;s <span className="font-semibold text-cheese">{line.time}</span>{' '}
          in DHA —{' '}
          {line.words}
        </>
      ) : (
        cheeseTimeFallback({ nameIsDefault, nameProse })
      )}
    </p>
  );
}
