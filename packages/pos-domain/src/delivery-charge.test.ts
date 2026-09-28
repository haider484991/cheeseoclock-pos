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
  deliveryChargeTarget,
  deliveryChargeWords,
  deliveryZonesPutBack,
  planDeliveryChargeLines,
  planFeeItems,
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
    });
    expect(block.zones.find((z) => z.id === 'emaar')?.active).toBe(false);
    expect(settingsBlockProblem(block, menu)).toMatch(/DHA Phase 8/);
    expect(block.settingsRev).toBe(0);
    expect(block.settingsAt).toBe(DEFAULT_SETTINGS_AT);
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
