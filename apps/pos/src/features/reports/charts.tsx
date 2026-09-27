/**
 * Small, dependency-free charts for the Reports page. Plain divs rather than
 * a stretched SVG: bars stay crisp at any width, labels stay readable, and
 * every bar carries its exact figure in a tooltip and in the table beside it.
 */
import { cn } from '@cheeseoclock/ui';

export interface ColumnBar {
  key: string;
  /** Short label under the bar ("8 pm", "26"). */
  label: string;
  /** Tooltip, e.g. "Sat 26 Sep: Rs 3,174 · 6 orders". */
  title: string;
  value: number;
  /** A stretch still going (this month so far): drawn hollow, never picked out as the best. */
  partial?: boolean;
}

/**
 * Vertical bars. The tallest bar is picked out in a stronger colour so the
 * busiest hour / best day jumps out. Labels thin out when there are many bars.
 */
export function ColumnChart({
  bars,
  ariaLabel,
  height = 'h-44',
}: {
  bars: ColumnBar[];
  ariaLabel: string;
  height?: string;
}) {
  if (bars.length === 0) return null;
  const max = Math.max(...bars.map((b) => b.value), 1);
  const best = bars.reduce((m, b, i) => (!b.partial && b.value > (bars[m]?.value ?? -Infinity) ? i : m), bars.findIndex((b) => !b.partial));
  const labelEvery = bars.length <= 16 ? 1 : Math.ceil(bars.length / 12);
  return (
    <div role="img" aria-label={ariaLabel}>
      <div className={cn('flex items-end gap-[3px] border-b border-stone-200 dark:border-stone-700', height)}>
        {bars.map((b, i) => {
          const pct = b.value > 0 ? Math.max((b.value / max) * 100, 1.5) : 0;
          return (
            <div key={b.key} className="group flex h-full min-w-0 flex-1 flex-col justify-end" title={b.title}>
              <div
                className={cn(
                  'w-full rounded-t-[3px] transition-colors',
                  b.partial
                    ? 'border border-b-0 border-dashed border-amber-500 bg-amber-100/60 dark:border-amber-400 dark:bg-amber-900/30'
                    : i === best && b.value > 0
                      ? 'bg-amber-500 dark:bg-amber-400'
                      : 'bg-amber-200 group-hover:bg-amber-300 dark:bg-amber-900/70 dark:group-hover:bg-amber-700',
                )}
                style={{ height: `${pct}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex gap-[3px]">
        {bars.map((b, i) => (
          <div key={b.key} className="min-w-0 flex-1 truncate text-center text-[10px] tabular-nums text-stone-500">
            {i % labelEvery === 0 ? b.label : ''}
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------ Phase 7: the owner's week --

export interface HeatmapCellView {
  weekday: number;
  hour: number;
  value: number;
  /** Tooltip: "Fri 8 pm: Rs 4,000 on an average Friday · 4 orders". */
  title: string;
}

/**
 * Weekday × hour: a row per weekday (Monday first), a column per hour, each
 * cell shaded by its share of the busiest cell. Every cell is a button: a
 * tap picks it (`onPick`), and the panel reads its exact figures out below
 * (a touch screen has no hover); the tooltip says the same, and the file has
 * them all.
 */
export function Heatmap({
  cells,
  hours,
  weekdays,
  hourLabel,
  ariaLabel,
  picked = null,
  onPick,
}: {
  cells: HeatmapCellView[];
  hours: number[];
  weekdays: readonly string[];
  hourLabel: (h: number) => string;
  ariaLabel: string;
  /** The picked cell (weekday × 24 + hour), outlined. */
  picked?: number | null;
  onPick?: (key: number) => void;
}) {
  if (hours.length === 0) return null;
  const max = Math.max(...cells.map((c) => c.value), 1);
  const at = new Map(cells.map((c) => [c.weekday * 24 + c.hour, c]));
  const labelEvery = hours.length <= 14 ? 1 : 2;
  return (
    <div role="group" aria-label={ariaLabel} className="overflow-x-auto">
      <div className="grid min-w-[480px] gap-[3px]" style={{ gridTemplateColumns: `2.5rem repeat(${hours.length}, minmax(0, 1fr))` }}>
        <div />
        {hours.map((h, i) => (
          <div key={`h${h}`} className="truncate text-center text-[10px] tabular-nums text-stone-500">
            {i % labelEvery === 0 ? hourLabel(h).replace(' ', '') : ''}
          </div>
        ))}
        {weekdays.map((day, w) => (
          <HeatRow key={day} day={day} weekday={w} hours={hours} at={at} max={max} picked={picked} onPick={onPick} />
        ))}
      </div>
    </div>
  );
}

function HeatRow({
  day,
  weekday,
  hours,
  at,
  max,
  picked,
  onPick,
}: {
  day: string;
  weekday: number;
  hours: number[];
  at: Map<number, HeatmapCellView>;
  max: number;
  picked: number | null;
  onPick?: (key: number) => void;
}) {
  return (
    <>
      <div className="flex items-center text-xs font-medium text-stone-600 dark:text-stone-400">{day}</div>
      {hours.map((h) => {
        const key = weekday * 24 + h;
        const c = at.get(key);
        const share = c && c.value > 0 ? c.value / max : 0;
        return (
          <button
            key={h}
            type="button"
            title={c?.title}
            aria-label={c?.title}
            aria-pressed={picked === key}
            onClick={onPick ? () => onPick(key) : undefined}
            className={cn(
              'h-8 rounded-[4px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500',
              share === 0 && 'bg-stone-100 dark:bg-stone-800/60',
              picked === key && 'ring-2 ring-stone-900 dark:ring-stone-100',
            )}
            style={share > 0 ? { backgroundColor: `rgba(245, 158, 11, ${(0.12 + share * 0.88).toFixed(3)})` } : undefined}
          />
        );
      })}
    </>
  );
}

/** A small line of values (oldest first), for a trend at a glance. Scaled evenly, never stretched out of shape. */
export function Sparkline({ values, ariaLabel }: { values: number[]; ariaLabel: string }) {
  if (values.length < 2) return null;
  const W = 120;
  const H = 28;
  const hi = Math.max(...values, 1);
  const lo = Math.min(...values, 0);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * W).toFixed(1)},${(H - 2 - ((v - lo) / span) * (H - 4)).toFixed(1)}`);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} className="h-7 w-full" preserveAspectRatio="none">
      <polyline points={pts.join(' ')} fill="none" className="stroke-amber-500 dark:stroke-amber-400" strokeWidth={1.8} strokeLinejoin="round" />
    </svg>
  );
}

export interface MonthBarView extends ColumnBar {
  /** A second line under the bar ("29%"): the month's food cost, for a login that may see costs. */
  under?: string | null;
}

/** Twelve months as columns, this month last, with an optional line under each bar. */
export function MonthBars({ bars, ariaLabel }: { bars: MonthBarView[]; ariaLabel: string }) {
  if (bars.length === 0) return null;
  const withUnder = bars.some((b) => b.under);
  return (
    <div>
      <ColumnChart bars={bars} ariaLabel={ariaLabel} height="h-36" />
      {withUnder && (
        <div className="mt-0.5 flex gap-[3px]">
          {bars.map((b) => (
            <div key={b.key} className="min-w-0 flex-1 truncate text-center text-[10px] tabular-nums text-stone-500">
              {b.under ?? ''}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A thin share-of-total bar for table rows. */
export function ShareBar({ value, total, tone = 'amber' }: { value: number; total: number; tone?: 'amber' | 'emerald' | 'sky' }) {
  const pct = total > 0 ? Math.max(0, Math.min(100, (value / total) * 100)) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-stone-100 dark:bg-stone-800" aria-hidden>
      <div
        className={cn(
          'h-full rounded-full',
          tone === 'amber' && 'bg-amber-400',
          tone === 'emerald' && 'bg-emerald-500',
          tone === 'sky' && 'bg-sky-500',
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export interface PricePointView {
  /** When this price came in (ms). */
  at: number;
  value: number;
  /** "Rs 375 / kg" */
  label: string;
}

/**
 * A price over time, as a small step line: a price holds until the next
 * one comes in, so the line steps rather than slopes, and runs on to today.
 * Each change is a dot with its price and date in a tooltip; the first and
 * latest prices are written at the ends. Scaled evenly (never stretched).
 */
export function PriceLineChart({ points, ariaLabel, now = Date.now() }: { points: PricePointView[]; ariaLabel: string; now?: number }) {
  if (points.length === 0) return null;
  const W = 560;
  const H = 150;
  const pad = { l: 12, r: 12, t: 22, b: 24 };
  const t0 = points[0]!.at;
  const t1 = Math.max(now, points[points.length - 1]!.at + 1);
  const values = points.map((p) => p.value);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || Math.max(hi, 1);
  const x = (t: number) => pad.l + ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r);
  const y = (v: number) => (hi === lo ? (pad.t + H - pad.b) / 2 : pad.t + (1 - (v - lo + span * 0.05) / (span * 1.1)) * (H - pad.t - pad.b));
  let d = '';
  points.forEach((p, i) => {
    const px = x(p.at);
    const py = y(p.value);
    d += i === 0 ? `M ${px} ${py}` : ` H ${px} V ${py}`;
  });
  d += ` H ${x(t1)}`;
  const day = (t: number) => new Date(t).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: '2-digit' });
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} className="h-auto w-full">
      <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} className="stroke-stone-200 dark:stroke-stone-700" strokeWidth={1} />
      <path d={d} fill="none" className="stroke-amber-500 dark:stroke-amber-400" strokeWidth={2.5} strokeLinejoin="round" />
      {points.map((p, i) => (
        <circle key={`${p.at}-${i}`} cx={x(p.at)} cy={y(p.value)} r={4} className="fill-white stroke-amber-600 dark:fill-stone-900 dark:stroke-amber-400" strokeWidth={2}>
          <title>{`${day(p.at)}: ${p.label}`}</title>
        </circle>
      ))}
      <text x={x(first.at)} y={y(first.value) - 9} className="fill-stone-500 text-[11px]" textAnchor="start">
        {points.length > 1 ? first.label : ''}
      </text>
      <text x={W - pad.r} y={y(last.value) - 9} className="fill-stone-800 text-[12px] font-semibold dark:fill-stone-100" textAnchor="end">
        {last.label}
      </text>
      <text x={pad.l} y={H - 6} className="fill-stone-500 text-[10px]" textAnchor="start">
        {day(t0)}
      </text>
      <text x={W - pad.r} y={H - 6} className="fill-stone-500 text-[10px]" textAnchor="end">
        today
      </text>
    </svg>
  );
}
