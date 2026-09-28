/**
 * The pages a till's publish refreshes (api/bridge/menu and
 * api/bridge/settings call revalidatePath('/', 'layout')) must still answer
 * after it. A dynamic route that is ISR must not set `dynamicParams = false`:
 * under `next start` (Next 14.2) a path revalidated on demand leaves the
 * cache, and a route with no fallback then throws NoFallbackError — all
 * seven /delivery/[area] pages answered 404 after any publish, even a
 * v0.7.28 till's (review of f55e3f0; reproduced with a production build).
 * An unknown slug is still a 404: the middleware sends it to the site's 404
 * page (below), and the page calls notFound() itself as a second guard.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP = fileURLToPath(new URL('../app', import.meta.url));

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pages(path);
    return name === 'page.tsx' ? [path] : [];
  });
}

describe('pages a publish refreshes keep answering', () => {
  it('the publish routes refresh every page (so every ISR page is revalidated on demand)', () => {
    for (const route of ['api/bridge/menu/route.ts', 'api/bridge/settings/route.ts']) {
      expect(readFileSync(join(APP, route), 'utf8'), route).toContain("revalidatePath('/', 'layout')");
    }
  });

  it('no dynamic ISR route sets dynamicParams = false (its pages would 404 after a publish under next start)', () => {
    const wrong: string[] = [];
    let dynamicIsr = 0;
    for (const path of pages(APP)) {
      const file = relative(APP, path).replace(/\\/g, '/');
      if (!/\[[^\]]+\]/.test(file)) continue;
      const src = readFileSync(path, 'utf8');
      if (!/export const revalidate\s*=/.test(src)) continue;
      dynamicIsr += 1;
      if (/export const dynamicParams\s*=\s*false/.test(src)) wrong.push(file);
    }
    expect(dynamicIsr).toBeGreaterThan(0);
    expect(wrong).toEqual([]);
  });

  it('the area page still 404s an unknown slug by itself', () => {
    const src = readFileSync(join(APP, 'delivery/[area]/page.tsx'), 'utf8');
    expect(src).toMatch(/const found = getArea\(params\.area\);\s*\n\s*if \(!found\) notFound\(\);/);
    expect(src).toMatch(/generateStaticParams\(\)\s*\{\s*\n\s*return DELIVERY_AREAS\.map/);
  });
});

/**
 * An unknown /delivery/<slug> never reaches the ISR route (review of
 * 865657b). Without `dynamicParams = false`, Next rendered it on demand:
 * the page's notFound() gave a 404 whose server HTML was Next's empty error
 * shell (<html id="__next_error__">, the not-found page only after
 * JavaScript), cached for an hour as an ISR entry — one per made-up slug.
 * A segment not-found.tsx does not change that in Next 14.2 (tried under
 * next start). The middleware sends every slug that is not one of the seven
 * pages to a path no route answers, so Next serves the site's own 404 page
 * (app/not-found.tsx: "Page not found", "This page went cold"), uncached —
 * as for /nope, and as on v0.7.28.
 */
describe('an unknown /delivery/<slug> is the site’s own 404 page, never an ISR render', () => {
  it('the middleware knows exactly the seven area pages (the list the route prerenders and the sitemap names)', async () => {
    const { AREA_SLUGS } = await import('./area-slugs');
    const { DELIVERY_AREAS } = await import('./areas');
    expect([...AREA_SLUGS]).toEqual(DELIVERY_AREAS.map((a) => a.slug));
  });

  it('the seven pages pass through; any other slug — a made-up one, another spelling or case — is sent to the 404', async () => {
    const { NextRequest } = await import('next/server');
    const { middleware, UNKNOWN_AREA_PATH } = await import('../middleware');
    const { DELIVERY_AREAS } = await import('./areas');
    const run = (path: string) => middleware(new NextRequest(`http://localhost${path}`));
    expect(UNKNOWN_AREA_PATH.startsWith('/_')).toBe(true); // a private folder name: no route can ever answer it

    for (const a of DELIVERY_AREAS) {
      const res = run(`/delivery/${a.slug}`);
      expect(res.headers.get('x-middleware-next'), a.slug).toBe('1');
      expect(res.headers.get('x-middleware-rewrite'), a.slug).toBeNull();
      // A client-side navigation's request (RSC) to a real page passes too.
      expect(run(`/delivery/${a.slug}?_rsc=abc`).headers.get('x-middleware-rewrite')).toBeNull();
    }
    for (const path of [
      '/delivery/nope',
      '/delivery/made-up-1',
      '/delivery/DHA-Phase-8',
      '/delivery/dha-phase-8x',
      '/delivery/dha-phase-9',
      '/delivery/dha%2Dphase%2D8',
      '/delivery/nope?_rsc=abc',
    ]) {
      const res = run(path);
      expect(res.headers.get('x-middleware-rewrite'), path).toBe(`http://localhost${UNKNOWN_AREA_PATH}`);
      expect(res.headers.get('x-middleware-next'), path).toBeNull();
    }
    // Anything else it might be handed is left alone.
    for (const path of ['/delivery', '/delivery/dha-phase-8/opengraph-image', '/Delivery/dha-phase-8']) {
      expect(run(path).headers.get('x-middleware-rewrite'), path).toBeNull();
    }
  });

  // The matcher as Next compiles it (next build writes this regexp to middleware-manifest.json).
  // A bare "/delivery/:area" compiles to a regexp that matches only "/delivery" — Next appends
  // "(.json)?" and the param takes it as its pattern — so the middleware never ran for a slug
  // (found under next start). Next's own compiler, so a Next upgrade that changes it is caught.
  it('the matcher, as Next compiles it, runs the middleware for every /delivery/<one segment> and nothing else', async () => {
    const { config } = await import('../middleware');
    const { DELIVERY_AREAS } = await import('./areas');
    const { getMiddlewareMatchers } = (await import(
      'next/dist/build/analysis/get-page-static-info.js'
    )) as { getMiddlewareMatchers: (m: string, c: object) => Array<{ regexp: string }> };
    const matchers = getMiddlewareMatchers(config.matcher, {}).map((m) => new RegExp(m.regexp));
    const runs = (path: string) => matchers.some((re) => re.test(path));
    for (const path of [...DELIVERY_AREAS.map((a) => `/delivery/${a.slug}`), '/delivery/nope', '/delivery/DHA-Phase-8', '/delivery/made-up-1']) {
      expect(runs(path), path).toBe(true);
    }
    for (const path of ['/delivery', '/', '/menu', '/nope', '/delivery/dha-phase-8/opengraph-image', '/api/menu']) {
      expect(runs(path), path).toBe(false);
    }
  });
});
