import { NextResponse, type NextRequest } from 'next/server';
import { AREA_SLUGS } from '@/lib/area-slugs';

/**
 * A path no route answers (a folder starting with "_" is private in the app
 * router, so none can ever be made): a request sent here gets the site's own
 * 404 page (app/not-found.tsx), status 404 and uncached, as for any unknown URL.
 */
export const UNKNOWN_AREA_PATH = '/_unknown-delivery-area';

const KNOWN = new Set<string>(AREA_SLUGS);

/**
 * /delivery/<slug> for a slug that is not one of the seven area pages goes to
 * the site's 404 page before the area route sees it.
 *
 * The area route has no `dynamicParams = false` (with it, `next start`
 * answered 404 for all seven pages after any publish — isr-routes.test.ts),
 * so Next renders an unknown slug on demand. Its notFound() then gave a 404
 * whose server HTML was Next's empty error shell, cached for an hour as one
 * ISR entry per made-up slug. The check is exact — another case or spelling
 * of a real slug is unknown too, as it was on v0.7.28 — which a rewrite in
 * next.config could not do (its paths match without regard to case).
 * Everything else under the matcher passes untouched.
 */
export function middleware(req: NextRequest): NextResponse {
  const slug = /^\/delivery\/([^/]+)$/.exec(req.nextUrl.pathname)?.[1];
  if (slug === undefined || KNOWN.has(slug)) return NextResponse.next();
  return NextResponse.rewrite(new URL(UNKNOWN_AREA_PATH, req.url));
}

/**
 * One path segment under /delivery: the area pages (not the hub, not their OG
 * images). The pattern is spelt out: Next appends "(.json)?" to a matcher,
 * and a bare "/delivery/:area" then takes it as its own pattern and matches
 * only "/delivery" (isr-routes.test.ts compiles it as Next does).
 */
export const config = { matcher: '/delivery/:area([^/]+)' };
