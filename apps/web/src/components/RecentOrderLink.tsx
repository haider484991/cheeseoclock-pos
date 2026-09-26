'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { STORAGE_KEYS, isTrackable, parseLastOrder, readStored } from '@/lib/device-memory';
import { trackPath } from '@/lib/order-display';

/**
 * "Track order" in the header, on every page, while this phone has an order
 * from the last few hours — so a customer who closed the tracking page can
 * get back to it in one tap. Renders nothing on the server or without one.
 */
export function RecentOrderLink() {
  const pathname = usePathname();
  const [href, setHref] = useState<string | null>(null);

  useEffect(() => {
    const last = parseLastOrder(readStored(STORAGE_KEYS.lastOrder));
    setHref(last && isTrackable(last) ? trackPath(last.orderId) : null);
  }, [pathname]);

  if (!href || pathname?.startsWith('/track/')) return null;
  return (
    <Link
      href={href}
      className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-cream/90 transition-colors hover:bg-white/5 hover:text-cheese"
    >
      <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
      Track<span className="hidden sm:inline">&nbsp;order</span>
    </Link>
  );
}
