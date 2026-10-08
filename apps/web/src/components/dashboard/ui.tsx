import Link from 'next/link';
import type { ReactNode } from 'react';
import { IconChevronRight } from './icons';

/**
 * The dashboard's building blocks (server-safe: no hooks). One look on every
 * page: white cards on a warm page, hairline borders, ink text, gold only for
 * what you can press or what is chosen. Status words always carry their own
 * word (and colour only adds to it).
 */

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function PageHeader({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="truncate text-[1.6rem] font-semibold leading-tight tracking-tight text-dash-ink sm:text-3xl">{title}</h1>
        {sub ? <p className="mt-0.5 text-sm text-dash-muted">{sub}</p> : null}
      </div>
      {right ? <div className="flex shrink-0 items-center gap-2">{right}</div> : null}
    </div>
  );
}

export function Card({
  title,
  sub,
  action,
  children,
  className,
  flush,
  id,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  /** No inner padding (a list or table that runs edge to edge). */
  flush?: boolean;
  id?: string;
}) {
  return (
    <section
      id={id}
      className={cx('min-w-0 rounded-2xl border border-dash-line bg-dash-surface', className)}
      style={{ boxShadow: 'var(--d-shadow)' }}
    >
      {title || action ? (
        <header className={cx('flex items-start justify-between gap-3 px-4 pt-4', flush ? 'pb-3' : 'pb-1')}>
          <div className="min-w-0">
            {title ? <h2 className="text-[0.95rem] font-semibold text-dash-ink">{title}</h2> : null}
            {sub ? <p className="mt-0.5 text-xs text-dash-muted">{sub}</p> : null}
          </div>
          {action ? <div className="shrink-0 text-sm">{action}</div> : null}
        </header>
      ) : null}
      <div className={flush ? '' : 'px-4 pb-4 pt-2'}>{children}</div>
    </section>
  );
}

export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral' | 'accent';

const TONE: Record<Tone, string> = {
  good: 'bg-dash-good-bg text-dash-good-text',
  warn: 'bg-dash-warn-bg text-dash-warn-text',
  bad: 'bg-dash-bad-bg text-dash-bad-text',
  info: 'bg-dash-info-bg text-dash-info-text',
  neutral: 'bg-dash-sunk text-dash-soft border border-dash-line',
  accent: 'bg-dash-accent text-dash-accent-ink',
};

export function Pill({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold', TONE[tone], className)}>
      {children}
    </span>
  );
}

/** A coloured dot that goes beside a word (never alone). */
export function Dot({ tone }: { tone: Tone }) {
  const color: Record<Tone, string> = {
    good: 'var(--d-good)',
    warn: 'var(--d-warn)',
    bad: 'var(--d-bad)',
    info: 'var(--d-series-2)',
    neutral: 'var(--d-axis)',
    accent: 'var(--d-accent)',
  };
  return <span aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: color[tone] }} />;
}

export interface Delta {
  /** Whole percent change, or null with nothing to compare. */
  pct: number | null;
  /** "vs last week" */
  vs: string;
  /** Up is good (sales) or bad (refunds). */
  upIsGood?: boolean;
  /** What to say when there is nothing to compare ("the records start 28 Sep"). */
  none?: string;
}

export function DeltaLine({ delta }: { delta: Delta }) {
  if (delta.pct === null) return <span className="text-xs text-dash-muted">{delta.none ?? `nothing to compare ${delta.vs}`}</span>;
  const up = delta.pct > 0;
  const flat = delta.pct === 0;
  const good = flat ? null : up === (delta.upIsGood ?? true);
  return (
    <span className="text-xs">
      <span className={cx('font-semibold', good === null ? 'text-dash-soft' : good ? 'text-dash-good-text' : 'text-dash-bad-text')}>
        <span aria-hidden>{flat ? '■' : up ? '▲' : '▼'}</span> {flat ? 'same' : `${up ? 'up' : 'down'} ${Math.abs(delta.pct)}%`}
      </span>
      <span className="text-dash-muted"> {delta.vs}</span>
    </span>
  );
}

export function StatTile({
  label,
  value,
  sub,
  delta,
  href,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  delta?: Delta;
  href?: string;
  tone?: Tone;
}) {
  const inner = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-dash-muted">{label}</p>
        {href ? <IconChevronRight className="text-dash-muted" /> : null}
      </div>
      <p
        className={cx(
          'mt-1 text-[1.45rem] font-semibold leading-tight tracking-tight',
          tone === 'bad' ? 'text-dash-bad-text' : tone === 'warn' ? 'text-dash-warn-text' : tone === 'good' ? 'text-dash-good-text' : 'text-dash-ink',
        )}
      >
        {value}
      </p>
      {sub ? <p className="mt-0.5 text-xs text-dash-soft">{sub}</p> : null}
      {delta ? (
        <p className="mt-1">
          <DeltaLine delta={delta} />
        </p>
      ) : null}
    </>
  );
  const cls = 'block rounded-2xl border border-dash-line bg-dash-surface p-3.5 sm:p-4';
  return href ? (
    <Link href={href} className={cx(cls, 'transition-colors hover:border-dash-axis')} style={{ boxShadow: 'var(--d-shadow)' }}>
      {inner}
    </Link>
  ) : (
    <div className={cls} style={{ boxShadow: 'var(--d-shadow)' }}>
      {inner}
    </div>
  );
}

/** The one number a page leads with. */
export function Hero({ label, value, sub, delta }: { label: string; value: ReactNode; sub?: ReactNode; delta?: Delta }) {
  return (
    <div>
      <p className="text-sm font-medium text-dash-muted">{label}</p>
      <p className="mt-1 text-[2.75rem] font-semibold leading-none tracking-tight text-dash-ink sm:text-[3.25rem]">{value}</p>
      {sub ? <p className="mt-2 text-sm text-dash-soft">{sub}</p> : null}
      {delta ? (
        <p className="mt-1.5">
          <DeltaLine delta={delta} />
        </p>
      ) : null}
    </div>
  );
}

/** A label and its value on one line (a receipt's rows). */
export function Row({ label, value, strong, muted, sub }: { label: ReactNode; value: ReactNode; strong?: boolean; muted?: boolean; sub?: ReactNode }) {
  return (
    <div className={cx('flex items-baseline justify-between gap-3 py-1.5', strong && 'font-semibold')}>
      <span className={cx('min-w-0', muted ? 'text-dash-muted' : 'text-dash-soft', strong && 'text-dash-ink')}>
        {label}
        {sub ? <span className="block text-xs font-normal text-dash-muted">{sub}</span> : null}
      </span>
      <span className={cx('tnum shrink-0 text-right', muted ? 'text-dash-muted' : 'text-dash-ink')}>{value}</span>
    </div>
  );
}

export function Divider() {
  return <hr className="my-1.5 border-dash-line" />;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-dash-line px-4 py-8 text-center">
      <p className="font-medium text-dash-ink">{title}</p>
      {children ? <div className="mx-auto mt-1 max-w-md text-sm text-dash-muted">{children}</div> : null}
    </div>
  );
}

/** A filter or period choice: a link that keeps the page server-rendered. */
export function Chip({ href, active, children }: { href: string; active?: boolean; children: ReactNode }) {
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={active ? 'true' : undefined}
      className={cx(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-3 py-1.5 text-sm font-medium transition-colors',
        active
          ? 'border-transparent bg-dash-ink text-dash-page'
          : 'border-dash-line bg-dash-surface text-dash-soft hover:border-dash-axis hover:text-dash-ink',
      )}
    >
      {children}
    </Link>
  );
}

/** A row of chips that scrolls sideways on a phone instead of wrapping into a wall. */
export function ChipRow({ children, label }: { children: ReactNode; label: string }) {
  return (
    <nav aria-label={label} className="-mx-4 mb-3 overflow-x-auto px-4 scrollbar-hide sm:mx-0 sm:px-0">
      <div className="flex w-max gap-2">{children}</div>
    </nav>
  );
}

/** A tappable list row (an order, a shift) with a chevron. */
export function ListLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-dash-sunk">
      <div className="min-w-0 flex-1">{children}</div>
      <IconChevronRight className="shrink-0 text-dash-muted" />
    </Link>
  );
}

export const TH = 'px-3 py-2 text-left text-xs font-semibold text-dash-muted first:pl-4 last:pr-4';
export const TD = 'px-3 py-2.5 align-top text-sm first:pl-4 last:pr-4';
export const TD_NUM = 'tnum px-3 py-2.5 text-right align-top text-sm first:pl-4 last:pr-4';

/** A table that scrolls sideways inside its card on a narrow phone, never the page. */
export function TableWrap({ children, caption }: { children: ReactNode; caption: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[30rem] border-collapse">
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

/** A note under a section: where the figure comes from, or why it is missing. */
export function Note({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-xs leading-relaxed text-dash-muted">{children}</p>;
}
