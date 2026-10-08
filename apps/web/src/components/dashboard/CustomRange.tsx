'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { cx } from './ui';

/** "Pick dates": two date boxes (trading days) that open the page for that range. */
export function CustomRange({ base, keep, from, to, today, active }: { base: string; keep: string; from: string; to: string; today: string; active: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [a, setA] = useState(from);
  const [b, setB] = useState(to);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cx(
          'inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-3 py-1.5 text-sm font-medium',
          active ? 'border-transparent bg-dash-ink text-dash-page' : 'border-dash-line bg-dash-surface text-dash-soft hover:text-dash-ink',
        )}
      >
        {active ? `${from === to ? from : `${from} → ${to}`}` : 'Pick dates'}
      </button>
    );
  }
  return (
    <form
      className="flex shrink-0 items-center gap-1.5 rounded-full border border-dash-line bg-dash-surface py-1 pl-2 pr-1"
      onSubmit={(e) => {
        e.preventDefault();
        router.push(`${base}?p=custom&from=${a}&to=${b || a}${keep ? `&${keep}` : ''}`);
        setOpen(false);
      }}
    >
      <label className="sr-only" htmlFor="range-from">
        From
      </label>
      <input id="range-from" type="date" value={a} max={today} onChange={(e) => setA(e.target.value)} className="bg-transparent text-sm text-dash-ink" required />
      <span className="text-dash-muted">→</span>
      <label className="sr-only" htmlFor="range-to">
        To
      </label>
      <input id="range-to" type="date" value={b} max={today} onChange={(e) => setB(e.target.value)} className="bg-transparent text-sm text-dash-ink" />
      <button type="submit" className="rounded-full bg-dash-accent px-3 py-1 text-sm font-semibold text-dash-accent-ink">
        Show
      </button>
    </form>
  );
}
