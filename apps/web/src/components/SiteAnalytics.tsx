'use client';

import { Analytics } from '@vercel/analytics/next';
import { isPrivatePath } from '@/lib/meta-pixel';

/**
 * Vercel Web Analytics (visits and page views on the Vercel dashboard), with
 * the owner's phone dashboard left out: its addresses carry order ids, and
 * they are no visit to the shop's website.
 */
export function SiteAnalytics() {
  return <Analytics beforeSend={(event) => (isPrivatePath(event.url) ? null : event)} />;
}
