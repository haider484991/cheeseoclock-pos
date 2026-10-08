'use client';

import { useMemo, useState } from 'react';
import { money, stockQty } from '@/lib/dashboard/format';
import { levelOf } from '@/lib/dashboard/stock-level';
import { IconSearch } from './icons';
import { Pill, cx } from './ui';

/**
 * A till's stock list, filtered on the phone (the whole list is a few
 * hundred rows at most): by name, by shelf, low or out only. Out of stock
 * first, then low, then the rest by name.
 */

export interface StockItemView {
  id: string;
  name: string;
  unit: string;
  category: string | null;
  onHand: number;
  lowAt: number | null;
  /** Price per 1,000 units in paisa (null: not priced, or not shown to this login). */
  pricePerThousandCents: number | null;
  keyItem: boolean;
  batch: boolean;
}

type Show = 'all' | 'low' | 'key';

const RANK = { out: 0, low: 1, ok: 2 } as const;

export function StockList({ items, initialShow, withValue }: { items: StockItemView[]; initialShow: Show; withValue: boolean }) {
  const [q, setQ] = useState('');
  const [show, setShow] = useState<Show>(initialShow);
  const [shelf, setShelf] = useState<string>('');
  const shelves = useMemo(() => [...new Set(items.map((i) => i.category).filter((c): c is string => !!c))].sort(), [items]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items
      .filter((i) => (needle ? i.name.toLowerCase().includes(needle) : true))
      .filter((i) => (shelf ? i.category === shelf : true))
      .filter((i) => (show === 'low' ? levelOf(i) !== 'ok' : show === 'key' ? i.keyItem : true))
      .sort((a, b) => RANK[levelOf(a)] - RANK[levelOf(b)] || a.name.localeCompare(b.name));
  }, [items, q, show, shelf]);

  const chip = (s: Show, label: string) => (
    <button
      type="button"
      onClick={() => setShow(s)}
      aria-pressed={show === s}
      className={cx(
        'shrink-0 rounded-full border px-3 py-1.5 text-sm font-medium',
        show === s ? 'border-transparent bg-dash-ink text-dash-page' : 'border-dash-line bg-dash-surface text-dash-soft',
      )}
    >
      {label}
    </button>
  );

  return (
    <div>
      <div className="relative mb-3">
        <IconSearch className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-dash-muted" />
        <label htmlFor="stock-search" className="sr-only">
          Find an ingredient
        </label>
        <input
          id="stock-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Find an ingredient"
          className="block w-full rounded-xl border border-dash-line bg-dash-surface py-2.5 pl-10 pr-3 text-[15px] text-dash-ink placeholder:text-dash-muted focus:border-dash-ink focus:outline-none"
        />
      </div>
      <div className="-mx-4 mb-3 flex gap-2 overflow-x-auto px-4 scrollbar-hide sm:mx-0 sm:px-0">
        {chip('all', 'Everything')}
        {chip('low', 'Low or out')}
        {chip('key', 'Key items')}
        {shelves.length > 1 ? (
          <select
            value={shelf}
            onChange={(e) => setShelf(e.target.value)}
            aria-label="Shelf"
            className="shrink-0 rounded-full border border-dash-line bg-dash-surface px-3 py-1.5 text-sm font-medium text-dash-soft"
          >
            <option value="">Every shelf</option>
            {shelves.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <div className="overflow-hidden rounded-2xl border border-dash-line bg-dash-surface" style={{ boxShadow: 'var(--d-shadow)' }}>
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-sm text-dash-muted">Nothing here.</p>
        ) : (
          <ul className="divide-y divide-dash-line">
            {rows.map((i) => {
              const level = levelOf(i);
              const value = withValue && i.pricePerThousandCents !== null && i.onHand > 0 ? Math.round((i.onHand * i.pricePerThousandCents) / 1000) : null;
              return (
                <li key={i.id} className="flex items-start justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-dash-ink">
                      {i.name}
                      {i.keyItem ? <span className="ml-1.5 text-xs font-normal text-dash-muted">key item</span> : null}
                    </p>
                    <p className="text-xs text-dash-muted">
                      {i.category ?? 'No shelf'}
                      {i.lowAt !== null ? ` · low at ${stockQty(i.lowAt, i.unit)}` : ''}
                      {i.batch ? ' · made here' : ''}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="tnum font-semibold text-dash-ink">{stockQty(i.onHand, i.unit)}</p>
                    <p className="mt-0.5">
                      {level === 'out' ? <Pill tone="bad">Out</Pill> : level === 'low' ? <Pill tone="warn">Low</Pill> : value !== null ? <span className="tnum text-xs text-dash-muted">{money(value)}</span> : null}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
