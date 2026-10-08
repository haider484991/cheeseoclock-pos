'use client';

import { useId, useMemo, useState } from 'react';
import { compactRupees, count as countWord, counted, money } from '@/lib/dashboard/format';

/**
 * The dashboard's two drawn charts (everything else is a list with bars):
 *  - ColumnChart: one series over days or hours — slot-1 amber, columns at
 *    most 24px wide with a 4px rounded top and a square foot, a 2px gap
 *    between neighbours, hairline grid, clean rupee ticks;
 *  - Heatmap: weekday × hour on the amber ramp (one hue, more = darker by
 *    day, brighter by night), with its scale.
 * Both answer hover AND keyboard focus with a tooltip (value first), and
 * both have a "Show as a table" twin, so no value needs the pointer.
 * Built in HTML, not a canvas: crisp at any width, no library.
 */

export interface ColumnPoint {
  key: string;
  /** Under the column (kept short: "8", "Mon", "1p"). */
  axis: string;
  /** In the tooltip and the table ("Wed 8 Oct"). */
  title: string;
  value: number;
  /** A second line for the tooltip ("12 orders"). */
  extra?: string;
}

function niceStep(max: number): number {
  if (max <= 0) return 1;
  const raw = max / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * pow) return m * pow;
  return 10 * pow;
}

export function ColumnChart({
  points,
  kind = 'money',
  caption,
  highlightKey,
  height = 168,
}: {
  points: ColumnPoint[];
  kind?: 'money' | 'count';
  caption: string;
  /** The column to mark as "now" (today, this hour). */
  highlightKey?: string;
  height?: number;
}) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const max = useMemo(() => Math.max(0, ...points.map((p) => p.value)), [points]);
  const step = niceStep(kind === 'money' ? max / 100 : max) * (kind === 'money' ? 100 : 1);
  const top = max > 0 ? Math.ceil(max / step) * step : step;
  const ticks = [];
  for (let t = 0; t <= top + 1e-9; t += step) ticks.push(t);
  const fmt = (v: number) => (kind === 'money' ? money(v) : countWord(v));
  const tick = (v: number) => (kind === 'money' ? compactRupees(v) : countWord(v));
  const every = Math.max(1, Math.ceil(points.length / 8));
  const active = hover !== null ? points[hover] : undefined;

  return (
    <figure className="m-0">
      <figcaption className="sr-only">{caption}</figcaption>
      {table ? (
        <div className="max-h-80 overflow-y-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="py-1.5 text-left text-xs font-semibold text-dash-muted">When</th>
                <th className="py-1.5 text-right text-xs font-semibold text-dash-muted">{kind === 'money' ? 'Sales' : 'Count'}</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.key} className="border-t border-dash-line">
                  <td className="py-1.5 text-dash-soft">
                    {p.title}
                    {p.extra ? <span className="ml-1 text-xs text-dash-muted">· {p.extra}</span> : null}
                  </td>
                  <td className="tnum py-1.5 text-right text-dash-ink">{fmt(p.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative flex gap-2" onMouseLeave={() => setHover(null)}>
          {/* The value axis. */}
          <div className="tnum relative w-9 shrink-0 text-right text-[10px] text-dash-muted" style={{ height }} aria-hidden>
            {ticks.map((t) => (
              <span key={t} className="absolute right-0 -translate-y-1/2" style={{ top: `${(1 - t / top) * 100}%` }}>
                {tick(t)}
              </span>
            ))}
          </div>
          <div className="relative min-w-0 flex-1">
            <div className="relative" style={{ height }}>
              {ticks.map((t) => (
                <div
                  key={t}
                  aria-hidden
                  className="absolute inset-x-0 border-t"
                  style={{ top: `${(1 - t / top) * 100}%`, borderColor: t === 0 ? 'var(--d-axis)' : 'var(--d-grid)' }}
                />
              ))}
              <div className="absolute inset-0 flex items-end" role="list" aria-label={caption}>
                {points.map((p, i) => {
                  const h = top > 0 ? (p.value / top) * 100 : 0;
                  const isHi = p.key === highlightKey;
                  const dim = hover !== null && hover !== i;
                  return (
                    <button
                      key={p.key}
                      type="button"
                      role="listitem"
                      aria-label={`${p.title}: ${fmt(p.value)}${p.extra ? `, ${p.extra}` : ''}`}
                      aria-describedby={hover === i ? `${id}-tip` : undefined}
                      onMouseEnter={() => setHover(i)}
                      onFocus={() => setHover(i)}
                      onBlur={() => setHover(null)}
                      className="group relative flex h-full min-w-0 flex-1 items-end justify-center outline-none"
                      style={{ paddingInline: 1 }}
                    >
                      <span
                        className="block w-full transition-opacity group-focus-visible:ring-2 group-focus-visible:ring-dash-accent"
                        style={{
                          maxWidth: 24,
                          height: `${Math.max(h, p.value > 0 ? 1.5 : 0)}%`,
                          minHeight: p.value > 0 ? 2 : 0,
                          background: isHi ? 'var(--d-ink)' : 'var(--d-series-1)',
                          borderRadius: '4px 4px 0 0',
                          opacity: dim ? 0.45 : 1,
                        }}
                      />
                    </button>
                  );
                })}
              </div>
              {active ? (
                <div
                  id={`${id}-tip`}
                  role="tooltip"
                  className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-dash-line bg-dash-surface px-2.5 py-1.5 text-xs shadow-lg"
                  style={{
                    left: `${((hover! + 0.5) / points.length) * 100}%`,
                    top: `${Math.max(0, (1 - active.value / top) * 100)}%`,
                  }}
                >
                  <p className="tnum text-sm font-semibold text-dash-ink">{fmt(active.value)}</p>
                  <p className="text-dash-muted">
                    {active.title}
                    {active.extra ? ` · ${active.extra}` : ''}
                  </p>
                </div>
              ) : null}
            </div>
            {/* The category axis (thinned so labels never collide). */}
            <div className="mt-1 flex text-[10px] text-dash-muted" aria-hidden>
              {points.map((p, i) => (
                <span key={p.key} className="min-w-0 flex-1 overflow-visible whitespace-nowrap text-center">
                  {i % every === 0 || p.key === highlightKey ? p.axis : ''}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
      <button type="button" onClick={() => setTable((t) => !t)} className="mt-2 text-xs font-medium text-dash-soft underline-offset-2 hover:underline">
        {table ? 'Show as a chart' : 'Show as a table'}
      </button>
    </figure>
  );
}

export interface HeatPoint {
  dow: number;
  hour: number;
  value: number;
  orders: number;
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function hourLabel(h: number): string {
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}${h < 12 ? 'a' : 'p'}`;
}

/** Hours in trading order: 5 am → 4 am (a trading day starts at 5). */
function tradingHours(): number[] {
  return Array.from({ length: 24 }, (_, i) => (i + 5) % 24);
}

export function Heatmap({ cells, caption }: { cells: HeatPoint[]; caption: string }) {
  const id = useId();
  const [hover, setHover] = useState<string | null>(null);
  const [table, setTable] = useState(false);
  const byKey = useMemo(() => new Map(cells.map((c) => [`${c.dow}-${c.hour}`, c])), [cells]);
  // Only the hours anything sold in (the shop's day), in trading order.
  const hours = useMemo(() => {
    const used = new Set(cells.filter((c) => c.orders > 0).map((c) => c.hour));
    const order = tradingHours();
    const idx = order.map((h, i) => (used.has(h) ? i : -1)).filter((i) => i >= 0);
    if (idx.length === 0) return order.slice(7, 21);
    return order.slice(Math.min(...idx), Math.max(...idx) + 1);
  }, [cells]);
  const max = Math.max(0, ...cells.map((c) => c.value));
  const stepOf = (v: number) => (v <= 0 || max <= 0 ? 0 : Math.min(7, Math.max(1, Math.ceil((v / max) * 7))));
  const active = hover ? byKey.get(hover) : undefined;
  const [hd, hh] = hover ? hover.split('-').map(Number) : [0, 0];

  return (
    <figure className="m-0">
      <figcaption className="sr-only">{caption}</figcaption>
      {table ? (
        <div className="max-h-80 overflow-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                <th className="py-1 pr-2 text-left font-semibold text-dash-muted">Hour</th>
                {DAYS.map((d) => (
                  <th key={d} className="py-1 text-right font-semibold text-dash-muted">
                    {d}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {hours.map((h) => (
                <tr key={h} className="border-t border-dash-line">
                  <td className="py-1 pr-2 text-dash-soft">{hourLabel(h)}</td>
                  {DAYS.map((_, d) => {
                    const c = byKey.get(`${d + 1}-${h}`);
                    return (
                      <td key={d} className="tnum py-1 text-right text-dash-ink">
                        {c && c.value > 0 ? compactRupees(c.value) : '–'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative overflow-x-auto pb-1" onMouseLeave={() => setHover(null)}>
          <div className="inline-grid min-w-full gap-[2px]" style={{ gridTemplateColumns: `2.25rem repeat(${hours.length}, minmax(14px, 1fr))` }}>
            <span />
            {hours.map((h, i) => (
              <span key={h} className="text-center text-[10px] text-dash-muted" aria-hidden>
                {i % 2 === 0 ? hourLabel(h) : ''}
              </span>
            ))}
            {DAYS.map((d, di) => (
              <div key={d} className="contents">
                <span className="pr-1 text-right text-[11px] leading-[20px] text-dash-muted">{d}</span>
                {hours.map((h) => {
                  const k = `${di + 1}-${h}`;
                  const c = byKey.get(k);
                  const s = stepOf(c?.value ?? 0);
                  return (
                    <button
                      key={k}
                      type="button"
                      aria-label={`${d} ${hourLabel(h)}: ${c ? `${money(c.value)}, ${counted(c.orders, 'order')}` : 'nothing'}`}
                      aria-describedby={hover === k ? `${id}-tip` : undefined}
                      onMouseEnter={() => setHover(k)}
                      onFocus={() => setHover(k)}
                      onBlur={() => setHover(null)}
                      className="h-5 rounded-[3px] outline-none focus-visible:ring-2 focus-visible:ring-dash-accent"
                      style={{ background: `var(--d-heat-${s})`, outline: hover === k ? '2px solid var(--d-ink)' : undefined, outlineOffset: -1 }}
                    />
                  );
                })}
              </div>
            ))}
          </div>
          {hover ? (
            <div id={`${id}-tip`} role="tooltip" className="mt-2 rounded-lg border border-dash-line bg-dash-sunk px-2.5 py-1.5 text-xs">
              <span className="tnum text-sm font-semibold text-dash-ink">{active ? money(active.value) : money(0)}</span>
              <span className="text-dash-muted">
                {' '}
                · {DAYS[(hd ?? 1) - 1]} {hourLabel(hh ?? 0)} · {active ? counted(active.orders, 'order') : 'no orders'}
              </span>
            </div>
          ) : (
            <div className="mt-2 flex items-center gap-2 text-[10px] text-dash-muted" aria-hidden>
              <span>Less</span>
              {[1, 2, 3, 4, 5, 6, 7].map((s) => (
                <span key={s} className="h-3 w-4 rounded-[2px]" style={{ background: `var(--d-heat-${s})` }} />
              ))}
              <span>More sales</span>
            </div>
          )}
        </div>
      )}
      <button type="button" onClick={() => setTable((t) => !t)} className="mt-2 text-xs font-medium text-dash-soft underline-offset-2 hover:underline">
        {table ? 'Show as a chart' : 'Show as a table'}
      </button>
    </figure>
  );
}
