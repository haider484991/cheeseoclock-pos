import type { ReactNode } from 'react';
import { cx } from './ui';

/**
 * Lists with bars (server-safe): the dashboard's answer to "who sold most",
 * "how they paid", "which areas". One hue (slot-1 amber) for one series —
 * the bar's length does the comparing, the printed value is the figure, so
 * nothing needs a tooltip and every value is readable without the pointer.
 * A list is also the phone's best table: the name gets the whole width.
 */

export interface BarRow {
  key: string;
  label: ReactNode;
  /** What the bar measures (same unit for every row). */
  value: number;
  /** The figure printed at the end ("Rs …", "12"). */
  shown: ReactNode;
  /** A second, quieter line ("34 orders · 21%"). */
  sub?: ReactNode;
}

export function BarList({ rows, empty = 'Nothing yet.', max }: { rows: BarRow[]; empty?: string; max?: number }) {
  if (rows.length === 0) return <p className="py-4 text-sm text-dash-muted">{empty}</p>;
  const top = max ?? Math.max(0, ...rows.map((r) => Math.abs(r.value)));
  return (
    <ul className="divide-y divide-dash-line">
      {rows.map((r) => (
        <li key={r.key} className="py-2.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-sm text-dash-ink">{r.label}</span>
            <span className="tnum shrink-0 text-sm font-semibold text-dash-ink">{r.shown}</span>
          </div>
          <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-dash-sunk" aria-hidden>
            <div
              className="h-full rounded-full"
              style={{ width: `${top > 0 ? Math.max(1.5, (Math.abs(r.value) / top) * 100) : 0}%`, background: 'var(--d-series-1)' }}
            />
          </div>
          {r.sub ? <p className="mt-1 text-xs text-dash-muted">{r.sub}</p> : null}
        </li>
      ))}
    </ul>
  );
}

export interface ShareSlice {
  key: string;
  label: string;
  value: number;
  shown: ReactNode;
}

const SLOTS = ['var(--d-series-1)', 'var(--d-series-2)', 'var(--d-series-3)', 'var(--d-series-4)'];

/**
 * Part of a whole on one bar (channels): at most four colours in the
 * validated order, the rest folded into "Other" in grey; a 2px gap between
 * pieces; a legend that names each piece with its figure and share.
 * Colour follows the key's place in `order` (never its size), so a filter
 * never repaints a channel.
 */
export function ShareBar({ slices, order }: { slices: ShareSlice[]; order: string[] }) {
  const total = slices.reduce((s, x) => s + Math.max(0, x.value), 0);
  if (total <= 0) return <p className="py-4 text-sm text-dash-muted">Nothing yet.</p>;
  const colourOf = (key: string) => {
    const i = order.indexOf(key);
    return i >= 0 && i < SLOTS.length ? SLOTS[i]! : 'var(--d-axis)';
  };
  const shown = [...slices].filter((s) => s.value > 0).sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  return (
    <div>
      <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-full" aria-hidden>
        {shown.map((s) => (
          <div key={s.key} className="h-full first:rounded-l-full last:rounded-r-full" style={{ width: `${(s.value / total) * 100}%`, background: colourOf(s.key) }} />
        ))}
      </div>
      <ul className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        {shown.map((s) => (
          <li key={s.key} className="flex items-baseline justify-between gap-3 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: colourOf(s.key) }} />
              <span className="truncate text-dash-ink">{s.label}</span>
            </span>
            <span className="tnum shrink-0 text-dash-ink">
              {s.shown} <span className="text-xs text-dash-muted">{Math.round((s.value / total) * 100)}%</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface Step {
  key: string;
  label: string;
  /** Signed: sales add, costs take off. */
  cents: number;
  shown: ReactNode;
  /** The result line (profit): drawn in ink, set apart. */
  total?: boolean;
}

/** A waterfall as a list: each step's bar is its size against the sales, money in amber, money out grey. */
export function StepList({ steps, base }: { steps: Step[]; base: number }) {
  return (
    <ul className="divide-y divide-dash-line">
      {steps.map((s) => (
        <li key={s.key} className={cx('py-2', s.total && 'border-t-2 border-dash-ink')}>
          <div className="flex items-baseline justify-between gap-3">
            <span className={cx('text-sm', s.total ? 'font-semibold text-dash-ink' : 'text-dash-soft')}>{s.label}</span>
            <span className={cx('tnum text-sm', s.total ? 'font-semibold text-dash-ink' : 'text-dash-ink')}>{s.shown}</span>
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-dash-sunk" aria-hidden>
            <div
              className="h-full rounded-full"
              style={{
                width: `${base > 0 ? Math.min(100, Math.max(1, (Math.abs(s.cents) / base) * 100)) : 0}%`,
                background: s.total ? 'var(--d-ink)' : s.cents >= 0 ? 'var(--d-series-1)' : 'var(--d-axis)',
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
