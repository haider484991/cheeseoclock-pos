import { describe, it, expect } from 'vitest';
import {
  DELIVERY_PLACES,
  DELIVERY_ZONES,
  feeForZones,
  feeRangeForZones,
  findDeliveryChargeItem,
  findZone,
  isDeliveryChargeName,
} from '@cheeseoclock/shared-types';
import {
  AREA_OPTIONS,
  areaOptionWhere,
  deliveryFeeText,
  formatAreaText,
  normalizeAreaText,
  rankZones,
  resolveAreaText,
  suggestDeliveryAreas,
  zoneUsageFromAreas,
} from './delivery-areas.js';

const labels = (q: string, limit = 8) => suggestDeliveryAreas(q, { limit }).map((o) => o.label);
const option = (label: string) => {
  const o = AREA_OPTIONS.find((x) => x.label === label);
  if (!o) throw new Error(`no option ${label}`);
  return o;
};

describe('the shared area list', () => {
  it('pins every place to real zones of one group', () => {
    for (const p of DELIVERY_PLACES) {
      expect(p.zoneIds.length).toBeGreaterThan(0);
      for (const id of p.zoneIds) expect(findZone(id), `${p.label} → ${id}`).toBeDefined();
      expect(new Set(p.zoneIds.map((id) => findZone(id)?.group)).size).toBe(1);
    }
  });

  it('has unique labels, so a saved area reads back as one place', () => {
    const all = AREA_OPTIONS.map((o) => o.label.toLowerCase());
    expect(new Set(all).size).toBe(all.length);
  });

  it('never trusts a bare number or "block N" to mean a zone outside search', () => {
    for (const z of DELIVERY_ZONES) {
      for (const a of z.aliases) {
        expect(normalizeAreaText(a)).not.toMatch(/^\d+$/);
        expect(normalizeAreaText(a)).not.toMatch(/^(block|blk) \d+$/);
      }
    }
  });
});

describe('suggestDeliveryAreas', () => {
  it('lists zones with nothing typed — the nearest phases first', () => {
    const out = suggestDeliveryAreas('', { limit: 4 });
    expect(out.every((o) => o.kind === 'zone')).toBe(true);
    expect(out[0]?.label).toBe('DHA Phase 6');
  });

  it('puts the zones this till delivers to most at the front', () => {
    const usage = new Map([
      ['clifton-2', 40],
      ['dha-8', 12],
    ]);
    const out = suggestDeliveryAreas('', { limit: 3, usage }).map((o) => o.label);
    expect(out).toEqual(['Clifton Block 2', 'DHA Phase 8', 'DHA Phase 6']);
    expect(rankZones(usage)).toHaveLength(DELIVERY_ZONES.length);
  });

  it('finds a phase and the places in it from a bare number', () => {
    const out = labels('6', 30);
    expect(out[0]).toBe('DHA Phase 6');
    expect(out).toContain('Rahat Commercial');
    expect(out).toContain('Bukhari Commercial');
    expect(out).not.toContain('Zamzama Commercial');
  });

  it('understands the ways people say a phase or a block', () => {
    expect(labels('ph6')[0]).toBe('DHA Phase 6');
    expect(labels('phase-7')[0]).toBe('DHA Phase 7');
    expect(labels('p8')[0]).toBe('DHA Phase 8');
    expect(labels('2 ext')[0]).toBe('DHA Phase 2 Extension');
    expect(labels('cl 2')[0]).toBe('Clifton Block 2');
    expect(labels('block 5')[0]).toBe('Clifton Block 5');
    expect(labels('clifton 9')[0]).toBe('Clifton Block 9');
    expect(labels('emaar')[0]).toBe('Emaar Crescent Bay (DHA)');
    expect(labels('creek')[0]).toBe('Creek Vista (DHA)');
  });

  it('matches word prefixes across names and nicknames', () => {
    expect(labels('kh sha')).toContain('Khayaban-e-Shahbaz');
    expect(labels('bokhari')[0]).toBe('Bukhari Commercial');
    expect(labels('rahat com')[0]).toBe('Rahat Commercial');
    expect(labels('zamzama')[0]).toBe('Zamzama Commercial');
    expect(labels('boat')[0]).toBe('Boat Basin');
    expect(labels('schön')[0]).toBe('Schon Circle');
  });

  it('is tolerant of punctuation and case', () => {
    expect(labels('KHAYABAN-E-ITTEHAD')[0]).toBe('Khayaban-e-Ittehad');
    expect(labels('ph-7')[0]).toBe('DHA Phase 7');
  });

  it('returns nothing for a place outside DHA and Clifton', () => {
    expect(suggestDeliveryAreas('gulshan')).toEqual([]);
    expect(suggestDeliveryAreas('saddar')).toEqual([]);
  });
});

describe('formatAreaText', () => {
  it('writes the zone name for a zone', () => {
    expect(formatAreaText(option('DHA Phase 6'))).toBe('DHA Phase 6');
    expect(formatAreaText(option('Clifton Block 2'))).toBe('Clifton Block 2');
  });

  it('adds the zone to a place pinned to one', () => {
    expect(formatAreaText(option('Rahat Commercial'))).toBe('Rahat Commercial, DHA Phase 6');
    expect(formatAreaText(option('Boat Basin'))).toBe('Boat Basin, Clifton Block 5');
  });

  it('names only the group until the phase or block is chosen', () => {
    expect(formatAreaText(option('Khayaban-e-Ittehad'))).toBe('Khayaban-e-Ittehad, DHA');
    expect(formatAreaText(option('Khayaban-e-Ittehad'), 'dha-7')).toBe('Khayaban-e-Ittehad, DHA Phase 7');
    expect(formatAreaText(option('Schon Circle'), 'clifton-8')).toBe('Schon Circle, Clifton Block 8');
    // A zone the place is not in is ignored rather than written on the ticket.
    expect(formatAreaText(option('Schon Circle'), 'dha-6')).toBe('Schon Circle, Clifton');
  });
});

describe('resolveAreaText', () => {
  const zones = (t: string) => [...resolveAreaText(t).zoneIds];

  it('reads back every area the picker writes', () => {
    for (const o of AREA_OPTIONS) {
      const r = resolveAreaText(formatAreaText(o));
      expect(r.option?.key, o.label).toBe(o.key);
      expect([...r.zoneIds]).toEqual([...o.zoneIds]);
      for (const z of o.zoneIds) expect(zones(formatAreaText(o, z))).toEqual([z]);
    }
  });

  it('prefers the longest zone name — an extension is not its phase', () => {
    expect(zones('DHA Phase 7 Extension')).toEqual(['dha-7-ext']);
    expect(zones('Phase 2 Extension, DHA Phase 2')).toEqual(['dha-2-ext']);
    expect(zones('DHA Phase 7')).toEqual(['dha-7']);
  });

  it('understands hand-typed areas from before the picker', () => {
    expect(zones('phase 6')).toEqual(['dha-6']);
    expect(zones('Ph-8')).toEqual(['dha-8']);
    expect(zones('defence phase 5')).toEqual(['dha-5']);
    expect(zones('Clifton 2')).toEqual(['clifton-2']);
    expect(zones('bukhari')).toEqual(['dha-6']);
    expect(zones('Emaar Crescent Bay (DHA)')).toEqual(['emaar']);
  });

  it('does not guess from shorthand that could be anywhere in Karachi', () => {
    expect(zones('Block 5')).toEqual([]);
    expect(zones('6')).toEqual([]);
    expect(zones('Gulshan-e-Iqbal Block 13')).toEqual([]);
    expect(resolveAreaText('').option).toBeNull();
    expect(resolveAreaText(null).option).toBeNull();
  });
});

describe('fees', () => {
  it('knows the fee when every candidate zone agrees', () => {
    expect(feeForZones(['dha-6'])).toBe(20_000);
    expect(feeForZones(['clifton-1'])).toBe(25_000);
    expect(feeForZones(option('Khayaban-e-Shahbaz').zoneIds)).toBe(20_000);
  });

  it('refuses to guess when the block decides the fee', () => {
    expect(feeForZones(option('Schon Circle').zoneIds)).toBeNull();
    expect(feeRangeForZones(option('Schon Circle').zoneIds)).toEqual({ minCents: 20_000, maxCents: 25_000 });
    expect(feeForZones([])).toBeNull();
    expect(feeForZones(['gizri'])).toBeNull();
  });

  it('fees the area a saved address carries', () => {
    expect(feeForZones(resolveAreaText('Boat Basin, Clifton Block 5').zoneIds)).toBe(20_000);
    expect(feeForZones(resolveAreaText('Creek Vista (DHA)').zoneIds)).toBe(25_000);
  });

  it('writes the fee the way the till shows it', () => {
    expect(deliveryFeeText(['dha-6'])).toBe('Rs 200');
    expect(deliveryFeeText(['emaar'])).toBe('Rs 250');
    expect(deliveryFeeText(option('Schon Circle').zoneIds)).toBe('Rs 200–250');
    expect(deliveryFeeText([])).toBeNull();
    expect(areaOptionWhere(option('Rahat Commercial'))).toBe('DHA Phase 6');
    expect(areaOptionWhere(option('Schon Circle'))).toBe('Clifton · which block?');
    expect(areaOptionWhere(option('Khayaban-e-Tariq'))).toBe('DHA · which phase?');
  });

  it('finds the delivery-charge item by price, never food at the same price', () => {
    const items = [
      { id: 'fries', name: 'Fries — Regular', basePriceCents: 20_000 },
      { id: 'd200', name: 'Delivery Charge (Rs 200)', basePriceCents: 20_000 },
      { id: 'd250', name: 'delivery charge 250', basePriceCents: 25_000 },
    ];
    expect(findDeliveryChargeItem(items, 20_000)?.id).toBe('d200');
    expect(findDeliveryChargeItem(items, 25_000)?.id).toBe('d250');
    expect(findDeliveryChargeItem(items, 30_000)).toBeUndefined();
    expect(isDeliveryChargeName('  Delivery Charge (Rs 250)')).toBe(true);
    expect(isDeliveryChargeName('Fries')).toBe(false);
  });
});

describe('zoneUsageFromAreas', () => {
  it('adds up saved areas per zone, whatever format they were saved in', () => {
    const usage = zoneUsageFromAreas([
      { area: 'DHA Phase 6', count: 5 },
      { area: 'Rahat Commercial, DHA Phase 6', count: 3 },
      { area: 'phase 6', count: 1 },
      { area: 'Clifton Block 2', count: 2 },
      { area: 'Khayaban-e-Ittehad, DHA', count: 7 },
      { area: 'Gulshan', count: 9 },
    ]);
    expect(usage.get('dha-6')).toBe(9);
    expect(usage.get('clifton-2')).toBe(2);
    expect(usage.size).toBe(2);
  });
});
