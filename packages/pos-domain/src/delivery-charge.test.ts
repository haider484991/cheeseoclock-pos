import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DELIVERY_ZONES,
  DEFAULT_SETTINGS_AT,
  compareSettingsStamp,
  isDeliveryChargeName,
  settingsBlockProblem,
  type DeliveryZoneSetting,
  type PublishedMenu,
} from '@cheeseoclock/shared-types';
import { deliveryAreas } from './delivery-areas.js';
import {
  buildSettingsBlock,
  deliveryChargeRowState,
  deliveryChargeTarget,
  deliveryChargeWords,
  deliveryZonesPutBack,
  makeDeliveryAreaTeller,
  planDeliveryChargeLines,
  planDeliveryChargeOnAreaChange,
  planFeeItems,
  sameDeliveryArea,
  settingsStampOf,
  websiteNeedsSettings,
  type FeeItemCandidate,
} from './delivery-charge.js';

// Made-up ids and figures (the repository is public).
const idForFee = (cents: number) => `v5-fee-${cents}`;
const item = (
  id: string,
  name: string,
  cents: number,
  extra: Partial<FeeItemCandidate> = {},
): FeeItemCandidate => ({
  id,
  name,
  basePriceCents: cents,
  isActive: true,
  deleted: false,
  createdAt: '2026-09-01T00:00:00.000Z',
  ...extra,
});
const TODAY = [
  item('legacy-200', 'Delivery Charge (Rs 200)', 20_000),
  item('legacy-250', 'Delivery Charge (Rs 250)', 25_000),
  item('fries', 'Fries — Regular', 20_000),
];
const zonesWith = (change: (z: DeliveryZoneSetting) => DeliveryZoneSetting) =>
  DEFAULT_DELIVERY_ZONES.zones.map((z) =>
    change({ ...z, aliases: [...z.aliases], hints: [...z.hints] }),
  );

describe('planFeeItems (Settings → Delivery areas, Save)', () => {
  it('the first Save adopts today’s Rs 200 and Rs 250 items, keeping their ids', () => {
    const plan = planFeeItems({
      zones: DEFAULT_DELIVERY_ZONES.zones,
      previousFeeItemIds: new Set(),
      items: TODAY,
      idForFee,
    });
    expect(plan.actions).toEqual([
      {
        kind: 'keep',
        id: 'legacy-200',
        feeCents: 20_000,
        name: 'Delivery Charge (Rs 200)',
        adopted: true,
      },
      {
        kind: 'keep',
        id: 'legacy-250',
        feeCents: 25_000,
        name: 'Delivery Charge (Rs 250)',
        adopted: true,
      },
    ]);
    expect(plan.zones.find((z) => z.id === 'dha-6')?.feeItemId).toBe('legacy-200');
    expect(plan.zones.find((z) => z.id === 'dha-8')?.feeItemId).toBe('legacy-250');
    // Food at the same price is never taken for a delivery charge.
    expect(plan.zones.every((z) => z.feeItemId !== 'fries')).toBe(true);
  });

  it('a new fee makes the "Delivery Charge (Rs N)" item with the fee’s name-based id — the same on both tills', () => {
    const zones = zonesWith((z) => (z.id === 'dha-8' ? { ...z, feeCents: 30_000 } : z));
    const tillA = planFeeItems({
      zones,
      previousFeeItemIds: new Set(['legacy-200', 'legacy-250']),
      items: TODAY,
      idForFee,
    });
    const tillB = planFeeItems({
      zones,
      previousFeeItemIds: new Set(['legacy-200', 'legacy-250']),
      items: TODAY,
      idForFee,
    });
    expect(tillA).toEqual(tillB);
    expect(tillA.actions).toContainEqual({
      kind: 'create',
      id: 'v5-fee-30000',
      feeCents: 30_000,
      name: 'Delivery Charge (Rs 300)',
    });
    expect(tillA.zones.find((z) => z.id === 'dha-8')?.feeItemId).toBe('v5-fee-30000');
    // Emaar, Creek Vista and Clifton 1–2 still charge Rs 250: that item stays on.
    expect(tillA.actions.some((a) => a.kind === 'switchOff')).toBe(false);
    expect(tillA.zones.find((z) => z.id === 'emaar')?.feeItemId).toBe('legacy-250');
  });

  it('an item no area charges any more is switched off, never deleted', () => {
    const zones = zonesWith((z) => (z.feeCents === 25_000 ? { ...z, feeCents: 30_000 } : z));
    const plan = planFeeItems({
      zones,
      previousFeeItemIds: new Set(['legacy-200', 'legacy-250']),
      items: TODAY,
      idForFee,
    });
    expect(plan.actions).toContainEqual({ kind: 'switchOff', id: 'legacy-250' });
    expect(plan.actions.filter((a) => a.kind === 'switchOff')).toHaveLength(1);
  });

  it('the FIRST Save that moves every Rs 250 area switches today’s Rs 250 item off (the default found it by name and price) — and a stale item a Save made, but not the owner’s own look-alike', () => {
    const items = [
      ...TODAY,
      item('by-hand', 'Delivery charge long distance', 60_000),
      // Made by a Save on the other till that the link settled against (two offline Saves).
      item('v5-fee-35000', 'Delivery Charge (Rs 350)', 35_000),
    ];
    const zones = zonesWith((z) => (z.feeCents === 25_000 ? { ...z, feeCents: 30_000 } : z));
    const plan = planFeeItems({
      zones,
      // Nothing saved yet: no area names an item…
      previousFeeItemIds: new Set(),
      // …but the default's areas charged Rs 200 and Rs 250, by name and price.
      previousFees: new Set([20_000, 25_000]),
      items,
      idForFee,
    });
    expect(plan.actions.filter((a) => a.kind === 'switchOff')).toEqual([
      { kind: 'switchOff', id: 'legacy-250' },
      { kind: 'switchOff', id: 'v5-fee-35000' },
    ]);
    expect(plan.actions).toContainEqual({
      kind: 'create',
      id: 'v5-fee-30000',
      feeCents: 30_000,
      name: 'Delivery Charge (Rs 300)',
    });
    expect(plan.actions.some((a) => a.id === 'by-hand' || a.id === 'legacy-200' && a.kind === 'switchOff')).toBe(false);
    expect(plan.actions.some((a) => a.id === 'fries')).toBe(false);
  });

  it('never touches an item that only looks like a delivery charge and no area ever pointed at', () => {
    const items = [...TODAY, item('by-hand', 'Delivery charge long distance', 60_000)];
    const plan = planFeeItems({
      zones: DEFAULT_DELIVERY_ZONES.zones,
      previousFeeItemIds: new Set(),
      items,
      idForFee,
    });
    expect(plan.actions.some((a) => a.id === 'by-hand')).toBe(false);
  });

  it('brings back the fee’s own row when it was deleted, and prefers it over an older look-alike', () => {
    const items = [
      item('v5-fee-30000', 'Delivery Charge (Rs 300)', 30_000, { deleted: true }),
      item('v5-fee-20000', 'Delivery Charge (Rs 200)', 20_000),
      ...TODAY,
    ];
    const zones = zonesWith((z) => (z.id === 'dha-8' ? { ...z, feeCents: 30_000 } : z));
    const plan = planFeeItems({ zones, previousFeeItemIds: new Set(), items, idForFee });
    expect(plan.actions).toContainEqual({
      kind: 'restore',
      id: 'v5-fee-30000',
      feeCents: 30_000,
      name: 'Delivery Charge (Rs 300)',
    });
    expect(plan.zones.find((z) => z.id === 'dha-6')?.feeItemId).toBe('v5-fee-20000');
  });

  it('each area keeps its item while its fee stays (a fresh start that made new look-alikes changes nothing)', () => {
    const items = [
      ...TODAY,
      item('fresh-200', 'Delivery Charge (Rs 200)', 20_000, {
        createdAt: '2026-08-01T00:00:00.000Z',
      }),
    ];
    const plan = planFeeItems({
      zones: DEFAULT_DELIVERY_ZONES.zones,
      previousFeeItemIds: new Set(['legacy-200', 'legacy-250']),
      items,
      idForFee,
    });
    expect(plan.zones.find((z) => z.id === 'dha-6')?.feeItemId).toBe('legacy-200');
  });

  it('a Rs 0 area takes no item; a switched-off area points at its fee’s item only when one exists', () => {
    const zones = zonesWith((z) =>
      z.id === 'dha-1'
        ? { ...z, feeCents: 0 }
        : z.id === 'creek-vista'
          ? { ...z, active: false, feeCents: 40_000 }
          : z,
    );
    const plan = planFeeItems({ zones, previousFeeItemIds: new Set(), items: TODAY, idForFee });
    expect(plan.zones.find((z) => z.id === 'dha-1')?.feeItemId).toBeNull();
    expect(plan.zones.find((z) => z.id === 'creek-vista')?.feeItemId).toBeNull();
    expect(plan.actions.some((a) => a.kind === 'create')).toBe(false);
  });

  it('names every fee item so the name test still recognises it (the discount rule reads the sold-under name)', () => {
    const zones = zonesWith((z) => (z.id === 'dha-8' ? { ...z, feeCents: 150_000 } : z));
    const plan = planFeeItems({
      zones,
      previousFeeItemIds: new Set(),
      items: [item('odd', 'Delivery 200', 20_000)],
      idForFee,
    });
    for (const a of plan.actions)
      if (a.kind !== 'switchOff') expect(isDeliveryChargeName(a.name), a.name).toBe(true);
    expect(plan.actions).toContainEqual({
      kind: 'create',
      id: 'v5-fee-150000',
      feeCents: 150_000,
      name: 'Delivery Charge (Rs 1,500)',
    });
  });
});

describe('the fee follows the area (owner, 28 Sep 2026)', () => {
  const A = deliveryAreas(DEFAULT_DELIVERY_ZONES.zones);
  const menu = TODAY;

  it('a delivery with an area gets that area’s fee item', () => {
    expect(deliveryChargeTarget(A, 'delivery', 'DHA Phase 6', menu)).toEqual({
      kind: 'fee',
      feeCents: 20_000,
      itemId: 'legacy-200',
      zoneName: 'DHA Phase 6',
    });
    expect(
      deliveryChargeTarget(A, 'delivery', 'Zulfiqar Commercial, DHA Phase 8', menu),
    ).toMatchObject({ kind: 'fee', itemId: 'legacy-250' });
  });

  it('uses the area’s own fee item when the setting names one', () => {
    const B = deliveryAreas(
      zonesWith((z) =>
        z.id === 'dha-8' ? { ...z, feeCents: 30_000, feeItemId: 'v5-fee-30000' } : z,
      ),
    );
    const withNew = [...menu, item('v5-fee-30000', 'Delivery Charge (Rs 300)', 30_000)];
    expect(deliveryChargeTarget(B, 'delivery', 'DHA Phase 8', withNew)).toMatchObject({
      kind: 'fee',
      feeCents: 30_000,
      itemId: 'v5-fee-30000',
    });
  });

  it('adds nothing for foodpanda, takeaway or no area', () => {
    expect(deliveryChargeTarget(A, 'foodpanda', 'DHA Phase 6', menu)).toEqual({
      kind: 'none',
      reason: 'not_delivery',
    });
    expect(deliveryChargeTarget(A, 'takeaway', 'DHA Phase 6', menu)).toEqual({
      kind: 'none',
      reason: 'not_delivery',
    });
    expect(deliveryChargeTarget(A, 'delivery', '  ', menu)).toEqual({
      kind: 'none',
      reason: 'no_area',
    });
  });

  it('a switched-off area adds no fee, and says so', () => {
    const B = deliveryAreas(zonesWith((z) => (z.id === 'dha-8' ? { ...z, active: false } : z)));
    expect(deliveryChargeTarget(B, 'delivery', 'DHA Phase 8', menu)).toEqual({
      kind: 'none',
      reason: 'paused',
      zoneName: 'DHA Phase 8',
    });
  });

  it('a place across areas where one is switched off asks which — it never charges the other area’s fee to someone who may be in the paused one', () => {
    const B = deliveryAreas(zonesWith((z) => (z.id === 'dha-8' ? { ...z, active: false } : z)));
    for (const place of ['Khayaban-e-Shahbaz, DHA', 'Khayaban-e-Ittehad, DHA', 'Ittehad Commercial, DHA']) {
      const { zoneIds } = B.resolveAreaText(place);
      if (!zoneIds.includes('dha-8') || zoneIds.length < 2) continue;
      const t = deliveryChargeTarget(B, 'delivery', place, menu);
      expect(t, place).toEqual({ kind: 'leave', reason: 'which', pausedName: 'DHA Phase 8' });
      expect(planDeliveryChargeLines(t, [])).toEqual({ remove: [], add: null });
      expect(deliveryChargeWords(t)).toMatch(/Pick the phase.*DHA Phase 8 is switched off/);
    }
    // At least the road the reviewer named crosses into Phase 8.
    expect(B.resolveAreaText('Khayaban-e-Shahbaz, DHA').zoneIds).toContain('dha-8');
  });

  it('leaves the bill alone until the phase is known, or for an area it does not know', () => {
    expect(deliveryChargeTarget(A, 'delivery', 'Khayaban-e-Shahbaz, DHA', menu)).toEqual({
      kind: 'leave',
      reason: 'which',
    });
    expect(deliveryChargeTarget(A, 'delivery', 'Gulshan Block 13', menu)).toEqual({
      kind: 'leave',
      reason: 'unknown_area',
    });
  });

  it('says what the bill carries, in words built from the values', () => {
    expect(deliveryChargeWords(deliveryChargeTarget(A, 'delivery', 'DHA Phase 8', menu))).toBe(
      'Rs 250 delivery charge',
    );
    expect(deliveryChargeWords(deliveryChargeTarget(A, 'delivery', 'DHA Phase 8', []))).toBe(
      'No “Delivery Charge (Rs 250)” item on the menu — the owner saves Settings → Delivery areas to make it',
    );
    const B = deliveryAreas(
      zonesWith((z) =>
        z.id === 'dha-8' ? { ...z, active: false } : z.id === 'dha-1' ? { ...z, feeCents: 0 } : z,
      ),
    );
    expect(deliveryChargeWords(deliveryChargeTarget(B, 'delivery', 'DHA Phase 8', menu))).toMatch(
      /switched off in Settings/,
    );
    expect(deliveryChargeWords(deliveryChargeTarget(B, 'delivery', 'DHA Phase 1', menu))).toBe(
      'Delivery to DHA Phase 1 is free',
    );
    expect(
      deliveryChargeWords(deliveryChargeTarget(A, 'delivery', 'Khayaban-e-Shahbaz, DHA', menu)),
    ).toMatch(/Pick the phase/);
    expect(
      deliveryChargeWords(deliveryChargeTarget(A, 'takeaway', 'DHA Phase 8', menu)),
    ).toBeNull();
  });

  it('adds when there is none, swaps a wrong fee, never doubles, and takes it off', () => {
    const fee200 = deliveryChargeTarget(A, 'delivery', 'DHA Phase 6', menu);
    const fee250 = deliveryChargeTarget(A, 'delivery', 'DHA Phase 8', menu);
    // add
    expect(planDeliveryChargeLines(fee200, [])).toEqual({ remove: [], add: 'legacy-200' });
    // never doubled
    expect(
      planDeliveryChargeLines(fee200, [{ id: 'l1', unitPriceCents: 20_000, quantity: 1 }]),
    ).toEqual({ remove: [], add: null });
    // swap
    expect(
      planDeliveryChargeLines(fee250, [{ id: 'l1', unitPriceCents: 20_000, quantity: 1 }]),
    ).toEqual({ remove: ['l1'], add: 'legacy-250' });
    // off
    const none = deliveryChargeTarget(A, 'takeaway', 'DHA Phase 6', menu);
    expect(
      planDeliveryChargeLines(none, [{ id: 'l1', unitPriceCents: 20_000, quantity: 1 }]),
    ).toEqual({ remove: ['l1'], add: null });
    // leave
    const which = deliveryChargeTarget(A, 'delivery', 'Schon Circle, Clifton', menu);
    expect(
      planDeliveryChargeLines(which, [{ id: 'l1', unitPriceCents: 20_000, quantity: 1 }]),
    ).toEqual({ remove: [], add: null });
  });
});

describe('an AREA CHANGE (owner, 28 Sep 2026: changing the area swaps the charge)', () => {
  const A = deliveryAreas(DEFAULT_DELIVERY_ZONES.zones);
  const menu = [
    { id: 'legacy-200', name: 'Delivery Charge (Rs 200)', basePriceCents: 20_000 },
    { id: 'legacy-250', name: 'Delivery Charge (Rs 250)', basePriceCents: 25_000 },
  ];
  const on200 = [{ id: 'l1', unitPriceCents: 20_000, quantity: 1 }];
  const t = (area: string | null) => deliveryChargeTarget(A, 'delivery', area, menu);

  it('an area the till can’t pin to one fee, after one it charged, takes that charge off', () => {
    expect(planDeliveryChargeOnAreaChange(t('DHA Phase 6'), t('Gulshan Block 13'), on200)).toEqual({ remove: ['l1'], add: null });
    expect(planDeliveryChargeOnAreaChange(t('DHA Phase 6'), t('Khayaban-e-Shahbaz, DHA'), on200)).toEqual({ remove: ['l1'], add: null });
  });

  it('after no area, an unknown one, a free or paused one, it leaves a charge tapped on by hand alone', () => {
    expect(planDeliveryChargeOnAreaChange(null, t('Gulshan Block 13'), on200)).toEqual({ remove: [], add: null });
    expect(planDeliveryChargeOnAreaChange(t(null), t('Gulshan Block 13'), on200)).toEqual({ remove: [], add: null });
    expect(planDeliveryChargeOnAreaChange(t('Gulshan Block 13'), t('Tariq Road'), on200)).toEqual({ remove: [], add: null });
  });

  it('otherwise exactly as planDeliveryChargeLines: add, swap, never double, off', () => {
    expect(planDeliveryChargeOnAreaChange(null, t('DHA Phase 6'), [])).toEqual({ remove: [], add: 'legacy-200' });
    expect(planDeliveryChargeOnAreaChange(t('DHA Phase 6'), t('DHA Phase 8'), on200)).toEqual({ remove: ['l1'], add: 'legacy-250' });
    expect(planDeliveryChargeOnAreaChange(t('DHA Phase 8'), t('DHA Phase 6'), on200)).toEqual({ remove: [], add: null });
    expect(planDeliveryChargeOnAreaChange(t('DHA Phase 6'), t(null), on200)).toEqual({ remove: ['l1'], add: null });
  });

  it('the same place in other words is not a change (two saved addresses for one area); another place is', () => {
    expect(sameDeliveryArea(A, 'DHA Phase 6', 'Phase 6, DHA')).toBe(true);
    expect(sameDeliveryArea(A, 'dha  phase 6', 'DHA Phase 6')).toBe(true);
    expect(sameDeliveryArea(A, 'Khayaban-e-Shahbaz', 'Khayaban-e-Shahbaz, DHA')).toBe(true);
    expect(sameDeliveryArea(A, 'DHA Phase 6', 'DHA Phase 8')).toBe(false);
    expect(sameDeliveryArea(A, 'DHA Phase 6', 'Khayaban-e-Shahbaz, DHA')).toBe(false);
    expect(sameDeliveryArea(A, 'DHA Phase 6', null)).toBe(false);
    expect(sameDeliveryArea(A, null, '  ')).toBe(true);
    // Not on the list: by its words only.
    expect(sameDeliveryArea(A, 'Gulshan Block 13', 'gulshan block 13')).toBe(true);
    expect(sameDeliveryArea(A, 'Gulshan Block 13', 'Tariq Road')).toBe(false);
  });

  it('the row says so for an area not on the list: no charge from the till, and one it put on for the area before comes off', () => {
    expect(deliveryChargeWords(t('Gulshan Block 13'))).toBe(
      'Not one of the delivery areas (Settings → Delivery areas): the till adds no delivery charge, and takes off the one it added for the area before. Add one by hand if you deliver there.',
    );
  });
});

describe('deliveryZonesPutBack (“Put back the default”)', () => {
  it('today’s 21 at today’s fees; an added area stays, switched off; an area keeps its item while its fee stays', () => {
    const saved = zonesWith((z) => ({
      ...z,
      feeItemId: z.feeCents === 20_000 ? 'item-200' : 'item-250',
    })).map((z) => (z.id === 'dha-8' ? { ...z, feeCents: 30_000, feeItemId: 'item-300' } : z));
    const added: DeliveryZoneSetting = {
      id: 'pechs-6',
      name: 'PECHS Block 6',
      shortName: 'Block 6',
      group: 'PECHS',
      feeCents: 30_000,
      feeItemId: 'item-300',
      active: true,
      aliases: [],
      hints: [],
    };
    const back = deliveryZonesPutBack([...saved, added]);
    expect(back.slice(0, 21).map((z) => [z.id, z.feeCents, z.active])).toEqual(
      DEFAULT_DELIVERY_ZONES.zones.map((z) => [z.id, z.feeCents, true]),
    );
    expect(back.find((z) => z.id === 'dha-6')?.feeItemId).toBe('item-200');
    expect(back.find((z) => z.id === 'dha-8')?.feeItemId).toBeNull();
    expect(back[21]).toMatchObject({ id: 'pechs-6', active: false });
  });
});

describe('buildSettingsBlock (the website’s settings block)', () => {
  const menu: PublishedMenu = {
    publishedAt: '2026-09-28T10:00:00.000Z',
    store: { name: 'Test', phone: null, whatsapp: null, addressLine: null, tagline: null },
    categories: [
      {
        posCategoryId: 'cat-fee',
        name: 'Delivery Charges',
        displayOrder: 99,
        items: TODAY.filter((i) => i.id !== 'fries').map((i) => ({
          posItemId: i.id,
          name: i.name,
          description: null,
          basePriceCents: i.basePriceCents,
          taxRateBps: 0,
          imageUrl: null,
          sortOrder: 0,
          modifierGroups: [],
        })),
      },
    ],
  };
  const menuItems = menu.categories.flatMap((c) =>
    c.items.map((i) => ({ id: i.posItemId, name: i.name, basePriceCents: i.basePriceCents })),
  );

  it('carries every area in order, each on one with its fee item, and passes the website’s check', () => {
    const block = buildSettingsBlock({
      zones: DEFAULT_DELIVERY_ZONES.zones,
      pickup: { offered: true, percent: 10 },
      stamps: [{ version: 2, updatedAt: '2026-09-28T09:00:00.000Z' }, null],
      menuItems,
      deviceId: 'till-a',
    });
    expect(block.settingsRev).toBe(2);
    expect(block.settingsAt).toBe('2026-09-28T09:00:00.000Z');
    expect(block.zones.map((z) => z.id)).toEqual(DEFAULT_DELIVERY_ZONES.zones.map((z) => z.id));
    expect(block.zones.map((z) => z.sort)).toEqual(block.zones.map((_, i) => i));
    expect(block.zones.find((z) => z.id === 'dha-8')?.feeItemId).toBe('legacy-250');
    expect(settingsBlockProblem(block, menu)).toBeNull();
  });

  it('a switched-off area is still in the block (its page stays), and a missing fee item is caught before sending', () => {
    const zones = zonesWith((z) =>
      z.id === 'emaar'
        ? { ...z, active: false }
        : z.id === 'dha-8'
          ? { ...z, feeCents: 30_000 }
          : z,
    );
    const block = buildSettingsBlock({
      zones,
      pickup: { offered: false, percent: 0 },
      stamps: [],
      menuItems,
      deviceId: 'till-a',
    });
    expect(block.zones.find((z) => z.id === 'emaar')?.active).toBe(false);
    expect(settingsBlockProblem(block, menu)).toMatch(/DHA Phase 8/);
    expect(block.settingsRev).toBe(0);
    expect(block.settingsAt).toBe(DEFAULT_SETTINGS_AT);
  });

  it('two different area lists never share a stamp once the tills settle: the settled one is strictly newer (the sum of the times breaks the tie)', () => {
    // Till A saves areas ZA at 10:00 and the pick-up offer at 10:05 and publishes; till B, offline,
    // saved areas ZB at 10:02 (the same version). The link keeps ZB (same version, later time).
    const published = settingsStampOf([
      { version: 1, updatedAt: '2026-09-28T10:00:00.000Z' },
      { version: 1, updatedAt: '2026-09-28T10:05:00.000Z' },
    ]);
    const settled = settingsStampOf([
      { version: 1, updatedAt: '2026-09-28T10:02:00.000Z' },
      { version: 1, updatedAt: '2026-09-28T10:05:00.000Z' },
    ]);
    // The sum of versions and the newest time are the same…
    expect([settled.settingsRev, settled.settingsAt]).toEqual([published.settingsRev, published.settingsAt]);
    // …the stamp is not: the till that settled sends it, and the website takes it.
    expect(compareSettingsStamp(settled, published)).toBeGreaterThan(0);
    expect(
      websiteNeedsSettings(settled, { stamp: published, deviceId: 'till-a', problem: null }, 'till-a'),
    ).toBe(true);
  });

  it('when the website needs this till’s block', () => {
    const at = (t: string, rev = 2) => settingsStampOf([{ version: rev, updatedAt: t }, null]);
    const mine = at('2026-09-28T10:00:00.000Z');
    const held = (stamp = mine, deviceId: string | null = 'till-a', problem: string | null = null) => ({
      stamp,
      deviceId,
      problem,
    });
    // nothing saved: never
    expect(websiteNeedsSettings(settingsStampOf([null, null]), null, 'till-a')).toBe(false);
    // no block there / an older one: yes
    expect(websiteNeedsSettings(mine, null, 'till-a')).toBe(true);
    expect(websiteNeedsSettings(mine, held(at('2026-09-28T09:00:00.000Z', 1)), 'till-a')).toBe(true);
    // the same one: no — unless the website's menu lacks its fee item (a till behind on the link published)
    expect(websiteNeedsSettings(mine, held(), 'till-a')).toBe(false);
    expect(websiteNeedsSettings(mine, held(mine, 'till-b', 'DHA Phase 8: its item is not on the menu'), 'till-a')).toBe(true);
    // a newer one from the other till: no (the link brings it)
    expect(websiteNeedsSettings(mine, held(at('2026-09-28T09:00:00.000Z', 5), 'till-b'), 'till-a')).toBe(false);
    // this till's own newer-versioned block, and a Save here since at a later time (a restore moved the versions back): yes
    expect(websiteNeedsSettings(mine, held(at('2026-09-28T09:00:00.000Z', 5), 'till-a'), 'till-a')).toBe(true);
    // …but not merely restored (its own block is the later one): no
    expect(websiteNeedsSettings(mine, held(at('2026-09-28T11:00:00.000Z', 5), 'till-a'), 'till-a')).toBe(false);
  });

  it('orders stamps by revision first, then time', () => {
    const older = { settingsRev: 3, settingsAt: '2026-09-28T09:00:00.000Z' };
    const newerRevEarlierClock = { settingsRev: 4, settingsAt: '2026-09-28T08:00:00.000Z' };
    expect(compareSettingsStamp(newerRevEarlierClock, older)).toBeGreaterThan(0);
    expect(compareSettingsStamp(older, older)).toBe(0);
    expect(
      compareSettingsStamp({ settingsRev: 3, settingsAt: '2026-09-28T10:00:00.000Z' }, older),
    ).toBeGreaterThan(0);
  });
});

describe('what the till’s delivery-charge row tells the main process (review of f55e3f0)', () => {
  it('a row that shows an EMPTY area (after an order-type switch, or a restart) tells nothing — the order keeps its area and its charge', () => {
    const row = makeDeliveryAreaTeller();
    expect(row.shouldTell('o1', '')).toBe(false);
    expect(row.shouldTell('o1', '   ')).toBe(false);
  });

  it('an area typed or picked is told; emptied after that, it is told (a clear takes the charge off)', () => {
    const row = makeDeliveryAreaTeller();
    expect(row.shouldTell('o1', 'DHA Phase 6')).toBe(true);
    row.told('o1', 'DHA Phase 6');
    expect(row.shouldTell('o1', '')).toBe(true);
    row.told('o1', '');
    // Already told empty: nothing more.
    expect(row.shouldTell('o1', '')).toBe(false);
  });

  it('a row shown again with the area still in the form tells it (the main process sees no change)', () => {
    expect(makeDeliveryAreaTeller().shouldTell('o1', 'DHA Phase 8')).toBe(true);
  });

  it('an area typed and deleted inside the wait was never told: the empty one is not told either', () => {
    const row = makeDeliveryAreaTeller();
    expect(row.shouldTell('o1', 'P')).toBe(true);
    // The wait was cut short by the next keystroke: nothing went.
    expect(row.shouldTell('o1', '')).toBe(false);
  });

  it('an area told for another order is not this order’s: its empty form tells nothing', () => {
    const row = makeDeliveryAreaTeller();
    row.told('o1', 'DHA Phase 6');
    expect(row.shouldTell('o2', '')).toBe(false);
    // An area told before the order existed (the row started it) is told again for the order.
    const first = makeDeliveryAreaTeller();
    first.told(null, 'DHA Phase 6');
    expect(first.shouldTell('o3', 'DHA Phase 6')).toBe(true);
    first.told('o3', 'DHA Phase 6');
    expect(first.shouldTell('o3', '')).toBe(true);
  });

  it('each row on screen starts knowing nothing (a new row after the details step is shown again)', () => {
    const before = makeDeliveryAreaTeller();
    before.told('o1', 'DHA Phase 6');
    expect(makeDeliveryAreaTeller().shouldTell('o1', '')).toBe(false);
  });
});

/**
 * What the till's delivery-charge row says about the bill for an area it
 * charges (CustomerInlinePanel): the area's charge on the bill; a charge at
 * ANOTHER fee on it — the fee raised while the order was open, or another
 * charge tapped on by hand — named with the area's fee and one tap to swap
 * (review of 865657b: it said "not on the bill (taken off by hand)" while a
 * Rs 250 charge WAS on the bill); none yet while the till is being told; none
 * after it answered = taken off by hand. Made-up ids.
 */
describe('the delivery-charge row’s words for the bill (review of 865657b)', () => {
  const line = (id: string, cents: number, quantity = 1) => ({ id, unitPriceCents: cents, quantity });

  it('the area’s charge on the bill: says so, with how many', () => {
    expect(deliveryChargeRowState(30_000, [line('a', 30_000)], true)).toEqual({ kind: 'on', text: 'Rs 300 delivery charge is on the bill', qty: 1 });
    expect(deliveryChargeRowState(30_000, [line('a', 30_000, 2)], false)).toMatchObject({ kind: 'on', qty: 2 });
  });

  it('a charge at another fee on the bill (a fee raised while the order is open): both fees and a one-tap swap — never “taken off by hand”', () => {
    for (const told of [true, false]) {
      const s = deliveryChargeRowState(30_000, [line('old', 25_000)], told);
      expect(s).toEqual({
        kind: 'other',
        text: 'The bill has a Rs 250 delivery charge — this area’s charge is Rs 300',
        action: 'Change to Rs 300',
      });
      expect(s.text).not.toContain('taken off by hand');
    }
    // Another charge tapped on by hand (Rs 200 on a Rs 250 area): the same.
    expect(deliveryChargeRowState(25_000, [line('x', 20_000)], true)).toMatchObject({
      kind: 'other',
      text: 'The bill has a Rs 200 delivery charge — this area’s charge is Rs 250',
    });
  });

  it('the area’s charge AND another one on the bill: says both, and the tap keeps only the area’s', () => {
    expect(deliveryChargeRowState(30_000, [line('old', 25_000), line('new', 30_000)], true)).toEqual({
      kind: 'other',
      text: 'The bill has a Rs 250 delivery charge as well as this area’s Rs 300 — check it',
      action: 'Keep only Rs 300',
    });
  });

  it('several charges at other fees: counted and named', () => {
    expect(deliveryChargeRowState(30_000, [line('a', 25_000), line('b', 20_000)], true)).toMatchObject({
      kind: 'other',
      text: 'The bill has 2 delivery charges at other fees (Rs 250, Rs 200) — this area’s charge is Rs 300',
    });
    expect(deliveryChargeRowState(30_000, [line('a', 25_000, 2)], true)).toMatchObject({
      text: 'The bill has 2 delivery charges at other fees (Rs 250) — this area’s charge is Rs 300',
    });
  });

  it('none on the bill: the fee alone while the till is being told; after it answered, taken off by hand with “Put it back”', () => {
    expect(deliveryChargeRowState(30_000, [], false)).toEqual({ kind: 'telling', text: 'Delivery to this area is Rs 300' });
    expect(deliveryChargeRowState(30_000, [], true)).toEqual({
      kind: 'off',
      text: 'Delivery to this area is Rs 300 — not on the bill (taken off by hand)',
      action: 'Put it back',
    });
  });
});
