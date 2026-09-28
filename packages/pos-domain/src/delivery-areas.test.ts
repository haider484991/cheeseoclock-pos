import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DELIVERY_ZONES,
  DELIVERY_PLACES,
  DELIVERY_ZONES,
  findDeliveryChargeItem,
  isDeliveryChargeName,
  zoneAliasProblem,
  type DeliveryZoneSetting,
} from '@cheeseoclock/shared-types';
import { deliveryAreas, normalizeAreaText } from './delivery-areas.js';

/** The released areas: what a till with nothing saved uses. */
const A = deliveryAreas(DEFAULT_DELIVERY_ZONES.zones);
const labels = (q: string, limit = 8) => A.suggest(q, { limit }).map((o) => o.label);
const option = (label: string) => {
  const o = A.options.find((x) => x.label === label);
  if (!o) throw new Error(`no option ${label}`);
  return o;
};
/** The default list with some areas changed, as a Save would leave it. */
const edited = (change: (z: DeliveryZoneSetting) => DeliveryZoneSetting): DeliveryZoneSetting[] =>
  DEFAULT_DELIVERY_ZONES.zones.map((z) =>
    change({ ...z, aliases: [...z.aliases], hints: [...z.hints] }),
  );

describe('the shared area list', () => {
  it('pins every place to real zones of one group', () => {
    for (const p of DELIVERY_PLACES) {
      expect(p.zoneIds.length).toBeGreaterThan(0);
      for (const id of p.zoneIds) expect(A.findZone(id), `${p.label} → ${id}`).toBeDefined();
      expect(new Set(p.zoneIds.map((id) => A.findZone(id)?.group)).size).toBe(1);
    }
  });

  it('has unique labels, so a saved area reads back as one place', () => {
    const all = A.options.map((o) => o.label.toLowerCase());
    expect(new Set(all).size).toBe(all.length);
  });

  it('never trusts a bare number or "block N" to mean a zone outside search', () => {
    for (const z of DELIVERY_ZONES) {
      for (const a of z.aliases) {
        expect(normalizeAreaText(a)).not.toMatch(/^\d+$/);
        expect(normalizeAreaText(a)).not.toMatch(/^(block|blk) \d+$/);
        expect(zoneAliasProblem(a), a).toBeNull();
      }
    }
    expect(zoneAliasProblem('6')).not.toBeNull();
    expect(zoneAliasProblem('Block 5')).not.toBeNull();
  });
});

describe('the default areas are today’s, exactly', () => {
  it('is the compiled list: same ids, names, groups, fees, spellings and order, all on', () => {
    const zones = DEFAULT_DELIVERY_ZONES.zones;
    expect(zones.map((z) => z.id)).toEqual(DELIVERY_ZONES.map((z) => z.id));
    expect(zones).toHaveLength(21);
    for (const [i, z] of zones.entries()) {
      const c = DELIVERY_ZONES[i]!;
      expect(z).toEqual({
        id: c.id,
        name: c.name,
        shortName: c.shortName,
        group: c.group,
        feeCents: c.feeCents,
        feeItemId: null,
        active: true,
        aliases: [...c.aliases],
        hints: [...c.hints],
      });
    }
    expect(A.findZone('dha-8')?.feeCents).toBe(25_000);
    expect(
      zones
        .filter((z) => z.feeCents === 25_000)
        .map((z) => z.id)
        .sort(),
    ).toEqual(['clifton-1', 'clifton-2', 'creek-vista', 'dha-8', 'emaar'].sort());
    expect(new Set(zones.map((z) => z.feeCents))).toEqual(new Set([20_000, 25_000]));
  });
});

describe('suggest', () => {
  it('lists zones with nothing typed — the nearest phases first', () => {
    const out = A.suggest('', { limit: 4 });
    expect(out.every((o) => o.kind === 'zone')).toBe(true);
    expect(out[0]?.label).toBe('DHA Phase 6');
  });

  it('puts the zones this till delivers to most at the front', () => {
    const usage = new Map([
      ['clifton-2', 40],
      ['dha-8', 12],
    ]);
    const out = A.suggest('', { limit: 3, usage }).map((o) => o.label);
    expect(out).toEqual(['Clifton Block 2', 'DHA Phase 8', 'DHA Phase 6']);
    expect(A.rankZones(usage)).toHaveLength(DELIVERY_ZONES.length);
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
    expect(A.suggest('gulshan')).toEqual([]);
    expect(A.suggest('saddar')).toEqual([]);
  });
});

describe('formatAreaText', () => {
  it('writes the zone name for a zone', () => {
    expect(A.formatAreaText(option('DHA Phase 6'))).toBe('DHA Phase 6');
    expect(A.formatAreaText(option('Clifton Block 2'))).toBe('Clifton Block 2');
  });

  it('adds the zone to a place pinned to one', () => {
    expect(A.formatAreaText(option('Rahat Commercial'))).toBe('Rahat Commercial, DHA Phase 6');
    expect(A.formatAreaText(option('Boat Basin'))).toBe('Boat Basin, Clifton Block 5');
  });

  it('names only the group until the phase or block is chosen', () => {
    expect(A.formatAreaText(option('Khayaban-e-Ittehad'))).toBe('Khayaban-e-Ittehad, DHA');
    expect(A.formatAreaText(option('Khayaban-e-Ittehad'), 'dha-7')).toBe(
      'Khayaban-e-Ittehad, DHA Phase 7',
    );
    expect(A.formatAreaText(option('Schon Circle'), 'clifton-8')).toBe(
      'Schon Circle, Clifton Block 8',
    );
    // A zone the place is not in is ignored rather than written on the ticket.
    expect(A.formatAreaText(option('Schon Circle'), 'dha-6')).toBe('Schon Circle, Clifton');
  });
});

describe('resolveAreaText', () => {
  const zones = (t: string) => [...A.resolveAreaText(t).zoneIds];

  it('reads back every area the picker writes', () => {
    for (const o of A.options) {
      const r = A.resolveAreaText(A.formatAreaText(o));
      expect(r.option?.key, o.label).toBe(o.key);
      expect([...r.zoneIds]).toEqual([...o.zoneIds]);
      for (const z of o.zoneIds) expect(zones(A.formatAreaText(o, z))).toEqual([z]);
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
    expect(A.resolveAreaText('').option).toBeNull();
    expect(A.resolveAreaText(null).option).toBeNull();
  });
});

describe('fees', () => {
  it('knows the fee when every candidate zone agrees', () => {
    expect(A.feeForZones(['dha-6'])).toBe(20_000);
    expect(A.feeForZones(['clifton-1'])).toBe(25_000);
    expect(A.feeForZones(option('Rahat Commercial').zoneIds)).toBe(20_000);
    expect(A.feeForZones(['dha-8'])).toBe(25_000);
  });

  it('asks the phase on a khayaban, now that Phase 8 costs more (owner 2026-09-27)', () => {
    expect(A.feeForZones(option('Khayaban-e-Shahbaz').zoneIds)).toBeNull();
    expect(A.feeRangeForZones(option('Khayaban-e-Shahbaz').zoneIds)).toEqual({
      minCents: 20_000,
      maxCents: 25_000,
    });
  });

  it('refuses to guess when the block decides the fee', () => {
    expect(A.feeForZones(option('Schon Circle').zoneIds)).toBeNull();
    expect(A.feeRangeForZones(option('Schon Circle').zoneIds)).toEqual({
      minCents: 20_000,
      maxCents: 25_000,
    });
    expect(A.feeForZones([])).toBeNull();
    expect(A.feeForZones(['gizri'])).toBeNull();
  });

  it('fees the area a saved address carries', () => {
    expect(A.feeForZones(A.resolveAreaText('Boat Basin, Clifton Block 5').zoneIds)).toBe(20_000);
    expect(A.feeForZones(A.resolveAreaText('Creek Vista (DHA)').zoneIds)).toBe(25_000);
  });

  it('writes the fee the way the till shows it', () => {
    expect(A.deliveryFeeText(['dha-6'])).toBe('Rs 200');
    expect(A.deliveryFeeText(['emaar'])).toBe('Rs 250');
    expect(A.deliveryFeeText(option('Schon Circle').zoneIds)).toBe('Rs 200–250');
    expect(A.deliveryFeeText([])).toBeNull();
    expect(A.areaOptionWhere(option('Rahat Commercial'))).toBe('DHA Phase 6');
    expect(A.areaOptionWhere(option('Schon Circle'))).toBe('Clifton · which block?');
    expect(A.areaOptionWhere(option('Khayaban-e-Tariq'))).toBe('DHA · which phase?');
    expect(A.whichQuestion(option('Khayaban-e-Tariq').zoneIds)).toBe('Which phase?');
    expect(A.whichQuestion(option('Schon Circle').zoneIds)).toBe('Which block?');
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
    const usage = A.zoneUsageFromAreas([
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

describe('the helpers follow the saved areas (Settings → Delivery areas)', () => {
  it('charges the fee the owner saved: Phase 8 at Rs 300', () => {
    const B = deliveryAreas(edited((z) => (z.id === 'dha-8' ? { ...z, feeCents: 30_000 } : z)));
    expect(B.feeForZones(['dha-8'])).toBe(30_000);
    expect(B.deliveryFeeText(['dha-8'])).toBe('Rs 300');
    expect(B.feeForZones(B.resolveAreaText('Zulfiqar Commercial, DHA Phase 8').zoneIds)).toBe(
      30_000,
    );
    // The released list is untouched.
    expect(A.feeForZones(['dha-8'])).toBe(25_000);
  });

  it('a rename keeps the old name as a spelling: old addresses still resolve', () => {
    const B = deliveryAreas(
      edited((z) =>
        z.id === 'emaar'
          ? { ...z, name: 'Emaar Oceanfront', aliases: [...z.aliases, 'Emaar Crescent Bay (DHA)'] }
          : z,
      ),
    );
    expect([...B.resolveAreaText('Emaar Crescent Bay (DHA)').zoneIds]).toEqual(['emaar']);
    expect([...B.resolveAreaText('Emaar Oceanfront').zoneIds]).toEqual(['emaar']);
    expect(B.suggest('oceanfront')[0]?.label).toBe('Emaar Oceanfront');
    expect(B.formatAreaText(B.options.find((o) => o.key === 'zone:emaar')!)).toBe(
      'Emaar Oceanfront',
    );
  });

  it('an area added in Settings is offered and recognised, after the released order', () => {
    const pechs: DeliveryZoneSetting = {
      id: 'pechs-6',
      name: 'PECHS Block 6',
      shortName: 'Block 6',
      group: 'PECHS',
      feeCents: 35_000,
      feeItemId: null,
      active: true,
      aliases: ['pechs 6'],
      hints: [],
    };
    const B = deliveryAreas([...DEFAULT_DELIVERY_ZONES.zones, pechs]);
    expect(B.groups).toEqual(['DHA', 'Clifton', 'PECHS']);
    expect(B.suggest('pechs')[0]?.label).toBe('PECHS Block 6');
    expect([...B.resolveAreaText('PECHS Block 6').zoneIds]).toEqual(['pechs-6']);
    expect(B.feeForZones(['pechs-6'])).toBe(35_000);
    expect(B.rankZones().at(-1)?.id).toBe('pechs-6');
  });

  it('a switched-off area is recognised but never offered', () => {
    const B = deliveryAreas(edited((z) => (z.id === 'dha-8' ? { ...z, active: false } : z)));
    expect(B.isActive('dha-8')).toBe(false);
    expect(B.isActive('dha-6')).toBe(true);
    expect(B.suggest('p8').map((o) => o.label)).not.toContain('DHA Phase 8');
    expect(B.suggest('zulfiqar')).toEqual([]);
    expect(B.rankZones().map((z) => z.id)).not.toContain('dha-8');
    // An old address still reads back.
    expect([...B.resolveAreaText('DHA Phase 8').zoneIds]).toEqual(['dha-8']);
    // A road across phases is still offered through the phases that are on.
    expect(B.suggest('kh ittehad')[0]?.label).toBe('Khayaban-e-Ittehad');
  });

  it('builds once per list: the same list (or a fresh read of it) gives the same helpers', () => {
    expect(deliveryAreas(DEFAULT_DELIVERY_ZONES.zones)).toBe(A);
    expect(
      deliveryAreas(
        JSON.parse(JSON.stringify(DEFAULT_DELIVERY_ZONES.zones)) as DeliveryZoneSetting[],
      ),
    ).toBe(A);
    const B = deliveryAreas(edited((z) => (z.id === 'dha-8' ? { ...z, feeCents: 30_000 } : z)));
    expect(B).not.toBe(A);
  });

  it('never throws on a list whose places lie in areas of two groups (Save refuses that list instead)', () => {
    const split = edited((z) => (z.id === 'dha-7' ? { ...z, group: 'Elsewhere' } : z));
    expect(() => deliveryAreas(split)).not.toThrow();
  });
});
