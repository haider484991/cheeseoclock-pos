/**
 * The pages a till's publish refreshes (api/bridge/menu and
 * api/bridge/settings call revalidatePath('/', 'layout')) must still answer
 * after it. A dynamic route that is ISR must not set `dynamicParams = false`:
 * under `next start` (Next 14.2) a path revalidated on demand leaves the
 * cache, and a route with no fallback then throws NoFallbackError — all
 * seven /delivery/[area] pages answered 404 after any publish, even a
 * v0.7.28 till's (review of f55e3f0; reproduced with a production build).
 * An unknown slug is still a 404: the page calls notFound() itself.
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
