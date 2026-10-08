'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { IconRefresh } from './icons';
import { cx } from './ui';

/**
 * Keeps a page fresh while someone looks at it: refetches the page every
 * `seconds` while the tab is in front, and at once when the phone comes
 * back to it. The page holds its last figures while the new ones load
 * (no blank flash), and says when it last looked.
 */
export function AutoRefresh({ seconds = 60, renderedAt }: { seconds?: number; renderedAt: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [, tick] = useState(0);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') start(() => router.refresh());
    };
    const timer = window.setInterval(refresh, seconds * 1000);
    const onShow = () => refresh();
    document.addEventListener('visibilitychange', onShow);
    // The "x min ago" words move on their own between refreshes.
    const clock = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(clock);
      document.removeEventListener('visibilitychange', onShow);
    };
  }, [router, seconds]);

  const mins = Math.max(0, Math.round((Date.now() - Date.parse(renderedAt)) / 60_000));
  return (
    <button
      type="button"
      onClick={() => start(() => router.refresh())}
      className="flex items-center gap-1.5 rounded-full border border-dash-line bg-dash-surface px-3 py-1.5 text-xs font-medium text-dash-soft hover:text-dash-ink"
      aria-label="Refresh now"
    >
      <IconRefresh className={cx('h-3.5 w-3.5', pending && 'animate-spin')} />
      {pending ? 'Updating…' : mins === 0 ? 'Up to date' : `${mins} min ago`}
    </button>
  );
}
