import { describe, expect, it } from 'vitest';
import { DEFAULT_DELIVERY_ZONES } from '@cheeseoclock/shared-types';
import {
  PICKUP_INTRO,
  ZONES_SAVED_TOAST,
  ZONES_SAVE_NOTE,
  moveZoneRow,
  newZoneRow,
  pickupExample,
  pickupFromForm,
  setFeeFor,
  settingsPublishWords,
  zonesFromForm,
  zonesSummary,
  zonesToForm,
} from './deliveryZonesForm';

/** Settings → Delivery areas and the website cards, as typed ↔ as saved. Made-up figures. */
describe('Settings → Delivery areas: the form', () => {
  const rows = () => zonesToForm(DEFAULT_DELIVERY_ZONES);

  it('today’s areas read back unchanged', () => {
    const parsed = zonesFromForm(rows());
    expect(parsed.problem).toBeNull();
    expect(parsed.value?.map((z) => [z.id, z.feeCents, z.active])).toEqual(
      DEFAULT_DELIVERY_ZONES.zones.map((z) => [z.id, z.feeCents, true]),
    );
    expect(zonesSummary(DEFAULT_DELIVERY_ZONES)).toBe('21 areas, 21 on · Rs 200 (16), Rs 250 (5)');
  });

  it('a rename keeps the old name as a spelling (saved addresses still find the area)', () => {
    const r = rows().map((z) => (z.id === 'emaar' ? { ...z, name: 'Emaar Oceanfront' } : z));
    const emaar = zonesFromForm(r).value?.find((z) => z.id === 'emaar');
    expect(emaar).toMatchObject({ name: 'Emaar Oceanfront' });
    expect(emaar?.aliases).toContain('Emaar Crescent Bay (DHA)');
  });

  it('“Change the fee for several areas”, Rs 0 for free delivery, and the owner’s bounds', () => {
    const ticked = new Set(['dha-7', 'dha-8']);
    const r = setFeeFor(rows(), ticked, '300');
    const v = zonesFromForm(r).value!;
    expect(v.filter((z) => ticked.has(z.id)).map((z) => z.feeCents)).toEqual([30_000, 30_000]);
    expect(
      zonesFromForm(setFeeFor(rows(), ticked, '0')).value?.find((z) => z.id === 'dha-8'),
    ).toMatchObject({ feeCents: 0, feeItemId: null });
    expect(zonesFromForm(setFeeFor(rows(), ticked, '2001')).problem).toMatch(/Rs 0 to 2,000/);
    expect(zonesFromForm(setFeeFor(rows(), ticked, '12.5')).problem).toMatch(/whole rupees/);
  });

  it('“Add an area”: its id made once from its name; the list’s own rules checked before Save', () => {
    const r = rows();
    const added = newZoneRow(r, {
      name: 'PECHS Block 6',
      shortName: '',
      group: 'PECHS',
      fee: '350',
      aliases: 'pechs 6',
    });
    expect(added).toMatchObject({
      id: 'pechs-block-6',
      shortName: 'PECHS Block 6',
      active: true,
      feeItemId: null,
    });
    expect(zonesFromForm([...r, added]).problem).toBeNull();
    // A spelling that is only a number could be anywhere: refused.
    expect(zonesFromForm([...r, { ...added, aliases: '6' }]).problem).toMatch(/only a number/);
    // Two areas under one name: refused.
    expect(zonesFromForm([...r, { ...added, name: 'DHA Phase 6' }]).problem).toMatch(/DHA Phase 6/);
  });

  it('moves an area up or down (the order the till and the website list them)', () => {
    const r = rows();
    expect(
      moveZoneRow(r, 'dha-2', -1)
        .slice(0, 2)
        .map((z) => z.id),
    ).toEqual(['dha-2', 'dha-1']);
    expect(moveZoneRow(r, 'dha-1', -1)).toEqual(r);
  });
});

describe('Settings → Money & discounts: website pick-up', () => {
  it('a whole % from 0 to 50; the example is built from the value', () => {
    expect(pickupFromForm({ offered: true, percent: '15' })).toEqual({
      value: { v: 1, offered: true, percent: 15 },
      problem: null,
    });
    expect(pickupFromForm({ offered: true, percent: '51' }).problem).toMatch(/0 to 50/);
    expect(pickupFromForm({ offered: true, percent: '7.5' }).problem).toMatch(/whole %/);
    expect(pickupExample({ offered: true, percent: 10 })).toMatch(
      /Rs 2,000 pick-up order gets 10% off: Rs 200 off, Rs 1,800/,
    );
    expect(pickupExample({ offered: false, percent: 10 })).toMatch(/only order delivery/);
  });
});

describe('Settings → Online orders: where the areas stand with the website', () => {
  it('says published, waiting or why not — nothing while nothing is saved', () => {
    expect(settingsPublishWords({ state: 'none', at: null, message: null })).toBeNull();
    expect(
      settingsPublishWords({ state: 'published', at: '2026-09-28T09:02:00.000Z', message: null }),
    ).toMatchObject({ tone: 'ok' });
    expect(settingsPublishWords({ state: 'waiting', at: null, message: null })?.text).toMatch(
      /waiting to reach the website/,
    );
    expect(
      settingsPublishWords({ state: 'refused', at: null, message: 'DHA Phase 8: no item' })?.text,
    ).toMatch(/website not updated: DHA Phase 8: no item/);
  });
});

describe('what a Save says about the website: the areas go ALONE, never the menu', () => {
  it('the areas’ Save note, the saved message and the pick-up card never say the menu goes with them', () => {
    for (const t of [ZONES_SAVE_NOTE, ZONES_SAVED_TOAST, PICKUP_INTRO]) {
      expect(t).toEqual(expect.any(String));
      expect(t).not.toMatch(/with the menu|menu changes not published yet go/i);
    }
    // And they say what stays on the till.
    expect(ZONES_SAVE_NOTE).toMatch(/Menu changes you have not published stay on the till/);
    expect(ZONES_SAVED_TOAST).toMatch(/not the rest of the menu/);
    expect(PICKUP_INTRO).toMatch(/by itself when saved/);
  });
});
