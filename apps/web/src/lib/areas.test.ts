import { describe, expect, it } from 'vitest';
import { DELIVERY_PLACES } from '@cheeseoclock/shared-types';
import { DELIVERY_AREAS, feeText, getArea, landmarkOf } from './areas';
import { DEFAULT_FACTS, DEFAULT_ZONE_FACTS } from './delivery-facts';
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
      for (const l of a.landmarks) {
        const lm = landmarkOf(a, l).name;
        const place = DELIVERY_PLACES.find((p) => p.label === lm);
        if (!place) continue;
        expect(
          place.zoneIds.some((z) => a.zoneIds.includes(z)),
          `${lm} on /delivery/${a.slug}`,
        ).toBe(true);
      }
    }
  });

  it('tag each street or spot with areas of its own page — the ones the till puts it in — so a switched-off one is not listed', () => {
    const zoneNamed = (name: string) =>
      DEFAULT_ZONE_FACTS.find((z) =>
        [z.name, z.shortName, ...z.aliases].some((n) => n.toLowerCase() === name.toLowerCase()),
      );
    for (const a of DELIVERY_AREAS) {
      for (const l of a.landmarks) {
        const { name, in: zones } = landmarkOf(a, l);
        const where = `${name} on /delivery/${a.slug}`;
        expect(zones.length, where).toBeGreaterThan(0);
        for (const z of zones) expect(a.zoneIds, where).toContain(z);
        // A place the till knows lies only in areas the till puts it in.
        const place = DELIVERY_PLACES.find((p) => p.label === name);
        if (place) for (const z of zones) expect(place.zoneIds, where).toContain(z);
        // A place that IS an area (Emaar Crescent Bay, Creek Vista, DHA Phase 3…) is that area alone.
        const zone = zoneNamed(name);
        if (zone) expect(zones, where).toEqual([zone.id]);
        // On a page of several areas, a place is tagged unless it is known to span them.
        if (a.zoneIds.length > 1 && typeof l === 'string') {
          expect(['Korangi Road stretch', 'Schon Circle', 'Bilawal Chowrangi', 'Sea View apartments side'], where).toContain(name);
        }
      }
    }
  });
});
