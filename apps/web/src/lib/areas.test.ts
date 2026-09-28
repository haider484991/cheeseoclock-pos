import { describe, expect, it } from 'vitest';
import { DELIVERY_PLACES } from '@cheeseoclock/shared-types';
import { DELIVERY_AREAS, feeText, getArea } from './areas';
import { DEFAULT_FACTS } from './delivery-facts';
import { DELIVERY_ZONES } from './delivery-zones';

describe('delivery area pages', () => {
  it('give every checkout zone a page', () => {
    const covered = new Set(DELIVERY_AREAS.flatMap((a) => a.zoneIds));
    for (const z of DELIVERY_ZONES) expect(covered.has(z.id), z.id).toBe(true);
  });

  it('price every page from the shared zone list', () => {
    for (const a of DELIVERY_AREAS) expect(() => feeText(a, DEFAULT_FACTS)).not.toThrow();
    expect(feeText(getArea('dha-phase-6')!, DEFAULT_FACTS)).toBe('Rs 200 delivery');
    expect(feeText(getArea('clifton')!, DEFAULT_FACTS)).toMatch(/^Rs 200.250 delivery$/);
  });

  it('link only to pages that exist', () => {
    for (const a of DELIVERY_AREAS) for (const s of a.adjacent) expect(getArea(s), `${a.slug} → ${s}`).toBeDefined();
  });

  it('agree with the till about where a named landmark is', () => {
    // A landmark the till's area picker also knows must lie in one of the
    // page's zones — otherwise the page and the till disagree about the fee.
    for (const a of DELIVERY_AREAS) {
      for (const lm of a.landmarks) {
        const place = DELIVERY_PLACES.find((p) => p.label === lm);
        if (!place) continue;
        expect(
          place.zoneIds.some((z) => a.zoneIds.includes(z)),
          `${lm} on /delivery/${a.slug}`,
        ).toBe(true);
      }
    }
  });
});
