'use client';

import { useEffect, useState } from 'react';
import type { PublishedShopHours } from '@cheeseoclock/shared-types';
import { cheeseTimeFallback, cheeseTimeLine, karachiClock } from '@/lib/cheese-time';

/**
 * Time-aware brand line: "It's 8:47 PM in DHA — definitely Cheese O'Clock."
 * Renders a static fallback on the server (the ISR page is the same for
 * everyone), then swaps in the live Karachi time after hydration (avoids a
 * server/client mismatch) and what the owner's opening hours say about it —
 * the hours alone, as the line always was: it never asks the website (no
 * request per page view). Whether the kitchen is taking website orders is
 * the /menu page's to say (its closed banner). The hours and the name are
 * the owner's (the server half, CheeseTime, passes them).
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
    const update = () => {
      const clock = karachiClock(new Date());
      setLine({ time: clock.time, words: cheeseTimeLine({ hours, nameIsDefault, nameProse, ...clock }) });
    };
    update();
    const id = setInterval(update, 30_000);
    return () => clearInterval(id);
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
