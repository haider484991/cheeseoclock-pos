'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import Script from 'next/script';
import { GA_MEASUREMENT_ID, gaConfigure, gaPageView, gaSnippet } from '@/lib/google-analytics';
import { isPrivatePath, isTrackingPath } from '@/lib/meta-pixel';

/**
 * Google Analytics 4 (lib/google-analytics): Google's tag, loaded once, and a page view on the first load and on
 * every client-side route change (the App Router moves between pages without loading one, and the stream's own
 * history-change page views are off: the site pushes a history entry for every sheet it opens).
 *
 * Never on the owner's dashboard or a tracking page: an owner who opens one first gets no Google tag at all, and a
 * customer who reaches a tracking page after checkout sends nothing from it (gaPageView, gaEvent). The tag's queue
 * snippet runs inside next/script's own effect, which React runs before this component's, so `gtag` exists by the
 * time the effects below call it.
 */
export function SiteAnalytics() {
  const pathname = usePathname();
  if (isPrivatePath(pathname) || isTrackingPath(pathname)) return null;
  return <GoogleTag />;
}

function GoogleTag() {
  const pathname = usePathname();
  // React's StrictMode (development only) runs an effect twice: one page view per route, not two.
  const counted = useRef<string | null>(null);
  useEffect(() => {
    gaConfigure();
    if (counted.current === pathname) return;
    counted.current = pathname;
    gaPageView();
  }, [pathname]);
  return (
    <>
      <Script id="google-analytics" strategy="afterInteractive">
        {gaSnippet(GA_MEASUREMENT_ID)}
      </Script>
      <Script src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`} strategy="afterInteractive" />
    </>
  );
}
