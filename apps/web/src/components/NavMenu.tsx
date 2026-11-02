'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { LocationChip } from './location/LocationChip';
import { RecentOrderLink } from './RecentOrderLink';

/** One header a page: its panel's id is fixed (an id React makes up would differ from page to page). */
const PANEL_ID = 'site-menu';

/**
 * The header's menu on a phone (3 Nov 2026, the user: the links on the left, the logo in the middle, Order now on the
 * right): one button opens the site's pages, WhatsApp, the area and the last order's tracking; a wide screen shows
 * the links in the bar instead (SiteHeader). Closes on a link, a tap outside, Escape, or a new page.
 */
export function NavMenu({ whatsappUrl, zones }: { whatsappUrl: string; zones: ReadonlyArray<{ id: string; shortName: string }> }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const item = 'block rounded-xl px-3 py-2.5 font-cond text-lg font-bold uppercase tracking-wide text-cream transition-colors hover:bg-white/5 hover:text-cheese';
  return (
    <div ref={box} className="relative sm:hidden">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={PANEL_ID}
        aria-label={open ? 'Close the menu' : 'Open the menu'}
        onClick={() => setOpen((o) => !o)}
        className="grid h-10 w-10 place-items-center rounded-full text-cream transition-colors hover:bg-white/5 hover:text-cheese"
      >
        <svg viewBox="0 0 24 24" aria-hidden className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
          {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h10" />}
        </svg>
      </button>
      {open && (
        <div
          id={PANEL_ID}
          className="absolute left-0 top-[calc(100%+0.75rem)] w-64 rounded-3xl border border-white/10 bg-night-card p-2 shadow-soft-lg"
        >
          <Link href="/menu" onClick={() => setOpen(false)} className={item}>
            Menu &amp; prices
          </Link>
          <Link href="/delivery" onClick={() => setOpen(false)} className={item}>
            Delivery areas
          </Link>
          <a href={whatsappUrl} target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)} className={item}>
            Order on WhatsApp
          </a>
          <div className="mt-1 flex flex-wrap items-center gap-2 border-t border-white/10 px-2 pb-1 pt-3">
            <LocationChip zones={zones} />
            <RecentOrderLink />
          </div>
        </div>
      )}
    </div>
  );
}
