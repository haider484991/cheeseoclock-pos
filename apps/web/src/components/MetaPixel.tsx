'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import Script from 'next/script';
import { META_PIXEL_ID, isPrivatePath, metaPixelSnippet, pixel } from '@/lib/meta-pixel';

/**
 * The Meta Pixel (lib/meta-pixel): its base snippet, loaded once, and a PageView on the first
 * load and on every client-side route change (the App Router moves between pages without
 * loading one, so the snippet alone would count a single page per visit). Renders nothing
 * without NEXT_PUBLIC_META_PIXEL_ID, and then the layout does not mount it at all.
 *
 * The snippet runs inside next/script's own effect, which React runs before this component's
 * (a child's effects come first), and in the layout this sits ahead of the page: so `fbq`
 * exists by the time the PageView below, or the menu page's own first event, fires.
 *
 * No <noscript> image (it would count a page by itself) and no useSearchParams (it would take
 * every statically built page out of its static render). No PageView for /track: see
 * lib/meta-pixel for why nothing is ever sent from there.
 */
export function MetaPixel() {
  // The dashboard's pages never load Meta's script: an owner who opens one first gets none at all.
  const pathname = usePathname();
  if (META_PIXEL_ID === null || isPrivatePath(pathname)) return null;
  return <PixelLoader pixelId={META_PIXEL_ID} />;
}

function PixelLoader({ pixelId }: { pixelId: string }) {
  const pathname = usePathname();
  // React's StrictMode (development only) runs an effect twice: one PageView per route, not two.
  const counted = useRef<string | null>(null);
  useEffect(() => {
    if (counted.current === pathname) return;
    counted.current = pathname;
    pixel.pageView(pathname);
  }, [pathname]);
  return (
    <Script id="meta-pixel" strategy="afterInteractive">
      {metaPixelSnippet(pixelId)}
    </Script>
  );
}
