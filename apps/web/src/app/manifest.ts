import type { MetadataRoute } from 'next';
import { copyText } from '@/lib/delivery-facts';
import { MANIFEST_NAME, SITE_SHORT_DESCRIPTION } from '@/lib/page-copy';
import { getCopyFacts } from '@/lib/site-facts';

/**
 * The app manifest names the shop and its hours from the owner's settings
 * (today's with none stored). Static, refreshed at build and at least
 * hourly — force-static keeps the settings read (a no-store fetch) from
 * turning it dynamic (a browser asks for it on every page). A publish's
 * revalidatePath does not reach it: under Next 14.2 a route handler's cached
 * body ignores revalidated tags (checked with next start), so it follows
 * within the hour.
 */
export const dynamic = 'force-static';
export const revalidate = 3600;

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const facts = await getCopyFacts();
  return {
    name: copyText(MANIFEST_NAME, facts),
    short_name: copyText('{name}', facts),
    description: copyText(SITE_SHORT_DESCRIPTION, facts),
    start_url: '/',
    display: 'standalone',
    background_color: '#0C0A07',
    theme_color: '#0C0A07',
    icons: [
      {
        src: '/logo.png',
        sizes: 'any',
        type: 'image/png',
        purpose: 'any',
      },
    ],
  };
}
