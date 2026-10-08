import { copyText } from '@/lib/delivery-facts';
import { getCopyFacts } from '@/lib/site-facts';

export const dynamic = 'force-static';
export const revalidate = 3600;

/**
 * The dashboard's own home-screen app (the site's manifest opens the shop's
 * menu): starts at /dashboard and stays inside it. Nothing private: the
 * shop's name and the logo.
 */
export async function GET(): Promise<Response> {
  let name = 'Dashboard';
  try {
    name = `${copyText('{name}', await getCopyFacts())} Dashboard`;
  } catch {
    // The plain name: a manifest never fails for want of the shop's details.
  }
  return Response.json(
    {
      name,
      short_name: 'Dashboard',
      start_url: '/dashboard',
      scope: '/dashboard',
      display: 'standalone',
      background_color: '#151412',
      theme_color: '#151412',
      icons: [{ src: '/logo.png', sizes: 'any', type: 'image/png', purpose: 'any' }],
    },
    { headers: { 'Content-Type': 'application/manifest+json' } },
  );
}
