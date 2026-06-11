'use client';

import { useEffect, useState } from 'react';

/**
 * Time-aware brand line: "It's 8:47 PM in DHA — definitely Cheese O'Clock."
 * Renders a static fallback on the server, swaps in the live Karachi time
 * after hydration (avoids a server/client mismatch).
 */
export function CheeseTime({ className = '' }: { className?: string }) {
  const [state, setState] = useState<{ time: string; open: boolean } | null>(null);

  useEffect(() => {
    const update = () => {
      const now = new Date();
      const time = now.toLocaleTimeString('en-PK', {
        timeZone: 'Asia/Karachi',
        hour: 'numeric',
        minute: '2-digit',
      });
      const hour = Number(
        now.toLocaleString('en-GB', { timeZone: 'Asia/Karachi', hour: 'numeric', hour12: false }),
      );
      // Kitchen hours: 12pm – 2am.
      const open = hour >= 12 || hour < 2;
      setState({ time, open });
    };
    update();
    const id = setInterval(update, 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <p className={className}>
      {state ? (
        <>
          It&rsquo;s <span className="font-semibold text-cheese">{state.time}</span>{' '}
          in DHA —{' '}
          {state.open
            ? 'definitely Cheese O’Clock.'
            : 'we open at 12pm. Almost Cheese O’Clock.'}
        </>
      ) : (
        <>It&rsquo;s always Cheese O&rsquo;Clock in DHA.</>
      )}
    </p>
  );
}
