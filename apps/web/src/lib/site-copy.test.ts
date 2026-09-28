/**
 * The website's words about delivery, from the owner's settings (Settings
 * step 3):
 *  - with no settings block stored, every page, chip, message, slug, title,
 *    canonical and JSON-LD node reads EXACTLY as v0.7.26 did (a golden copy
 *    taken from v0.7.26 before the change, __fixtures__/site-copy-v0.7.26.json);
 *  - a block with other fees flows into the chips, the pages' sentences and
 *    the fee summary, and a sentence whose claim breaks steps aside;
 *  - an area switched off keeps its page and says delivery is paused;
 *  - no fee is ever typed by hand again.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FEE_SUMMARY, type PublishedSettings } from '@cheeseoclock/shared-types';
import golden from './__fixtures__/site-copy-v0.7.26.json';
import { DELIVERY_AREAS, feeText, getArea, renderArea } from './areas';
import {
  DEFAULT_FACTS,
  DEFAULT_ZONE_FACTS,
  checkoutAreaHint,
  copyText,
  deliveryAreasText,
  deliveryChip,
  deliveryFeeRange,
  deliveryOptionNote,
  expandZoneIds,
  factsFromBlock,
  feeSummary,
  feeSummarySentence,
  fillFees,
  generatedFeeSummary,
  outsideZoneMessage,
  placesWords,
  zoneOptionGroups,
  type FactZone,
  type SiteFacts,
} from './delivery-facts';
import { validateCheckout } from './checkout-validation';
import {
  BURGER_FAQ_AREAS,
  DELIVERY_HUB_DESCRIPTION,
  HOME_FAQ_AREAS,
  HOME_HERO_FEE,
  HOME_STAT_FEE,
  LATE_NIGHT_FAQ_AREAS,
  PIZZA_FAQ_AREAS,
} from './page-copy';
import { menuNode, restaurantNode, webPageNode, webSiteNode } from './seo';
import sitemap from '../app/sitemap';

/** A block as the till sends it: today's areas, with `edit` applied (made-up changes). */
function block(edit: (zones: FactZone[]) => void = () => {}, pickup = { offered: true, percent: 10 }): PublishedSettings {
  const zones = DEFAULT_ZONE_FACTS.map((z) => ({ ...z, aliases: [...z.aliases] }));
  edit(zones);
  return { v: 1, settingsAt: '2026-09-27T10:00:00.000Z', settingsRev: 3, pickup, zones };
}
const zone = (zones: FactZone[], id: string) => zones.find((z) => z.id === id)!;

describe('with no settings block the site reads exactly as v0.7.26', () => {
  it('every area page: words, fee chip, OG subtitle', () => {
    expect(DELIVERY_AREAS.map((a) => a.slug)).toEqual(golden.areas.map((a) => a.slug));
    for (const g of golden.areas) {
      const r = renderArea(getArea(g.slug)!, DEFAULT_FACTS);
      expect(r.name).toBe(g.name);
      expect(r.h1).toBe(g.h1);
      expect(r.title).toBe(g.title);
      expect(r.description, g.slug).toBe(g.description);
      expect(r.intro, g.slug).toEqual(g.intro);
      expect(r.landmarks).toEqual(g.landmarks);
      expect(r.popular).toEqual(g.popular);
      expect(r.faqs, g.slug).toEqual(g.faqs);
      expect(r.adjacent).toEqual(g.adjacent);
      expect(getArea(g.slug)!.zoneIds).toEqual(g.zoneIds);
      expect(r.fee).toBe(g.feeText);
      expect(feeText(getArea(g.slug)!)).toBe(g.feeText);
      expect(`PIZZA & BURGER DELIVERY — ${feeText(getArea(g.slug)!, DEFAULT_FACTS).toUpperCase()}`).toBe(g.ogSubtitle);
      expect(r.pausedNote).toBeNull();
    }
  });

  it('the fee summary, its sentence and the fee range', () => {
    expect(feeSummary(DEFAULT_FACTS)).toEqual(golden.feeSummary);
    expect(feeSummarySentence(DEFAULT_FACTS)).toBe(golden.feeSummarySentence);
    expect(deliveryFeeRange(DEFAULT_FACTS)).toBe(golden.feeRange);
  });

  it('the pages’ sentences that name a fee', () => {
    expect(copyText(HOME_FAQ_AREAS, DEFAULT_FACTS)).toBe(golden.pages.homeFaqAreas);
    expect(copyText(HOME_HERO_FEE, DEFAULT_FACTS)).toBe(golden.pages.homeHeroChip);
    expect(copyText(HOME_STAT_FEE, DEFAULT_FACTS)).toBe(golden.pages.homeStatFee);
    expect(copyText(DELIVERY_HUB_DESCRIPTION, DEFAULT_FACTS)).toBe(golden.pages.deliveryHubDescription);
    expect(copyText(LATE_NIGHT_FAQ_AREAS, DEFAULT_FACTS)).toBe(golden.pages.lateNightFaqAreas);
    expect(copyText(PIZZA_FAQ_AREAS, DEFAULT_FACTS)).toBe(golden.pages.pizzaFaqAreas);
    expect(copyText(BURGER_FAQ_AREAS, DEFAULT_FACTS)).toBe(golden.pages.burgerFaqAreas);
  });

  it('the ordering flow: refusal, checkout messages, chips and the area list', () => {
    expect(outsideZoneMessage(DEFAULT_FACTS)).toBe(golden.pages.orderRouteOutsideZone);
    const noZone = validateCheckout({
      fulfilment: 'delivery',
      hasZone: false,
      name: 'Test',
      phone: '0300 1234567',
      address: 'House 1',
      cartSize: 1,
      pickupOnlyInCart: [],
      canPickup: false,
      deliveryAreas: deliveryAreasText(DEFAULT_FACTS),
    });
    expect(noZone?.message).toBe(golden.pages.checkoutNoZone);
    expect(checkoutAreaHint(DEFAULT_FACTS, { canPickup: false, pickupPct: 10 })).toBe(golden.pages.checkoutHint);
    expect(deliveryChip(DEFAULT_FACTS)).toBe(golden.pages.menuHeaderChip);
    expect(deliveryOptionNote(DEFAULT_FACTS)).toBe(golden.pages.fulfilmentDeliveryNote);
    const options = zoneOptionGroups(DEFAULT_FACTS.zones).flatMap((g) =>
      g.options.map((o) => ({ group: g.group, id: o.id, label: o.label, disabled: o.disabled })),
    );
    expect(options.map(({ group, id, label }) => ({ group, id, label }))).toEqual(golden.pages.checkoutOptions);
    expect(options.every((o) => !o.disabled)).toBe(true);
    expect(zoneOptionGroups(DEFAULT_FACTS.zones).map((g) => g.group)).toEqual(['DHA', 'Clifton']);
  });

  it('SEO: slugs, titles, canonicals, sitemap and JSON-LD', () => {
    expect(restaurantNode()).toEqual(golden.seo.restaurant);
    expect(webSiteNode()).toEqual(golden.seo.website);
    expect(
      DELIVERY_AREAS.map((a) => {
        const r = renderArea(a, DEFAULT_FACTS);
        return webPageNode({
          path: `/delivery/${a.slug}`,
          name: r.title,
          description: r.description,
          breadcrumb: [
            { name: 'Home', path: '/' },
            { name: 'Delivery areas', path: '/delivery' },
            { name: r.name, path: `/delivery/${a.slug}` },
          ],
        });
      }),
    ).toEqual(golden.seo.areaPages);
    expect(sitemap().map((e) => ({ ...e, lastModified: undefined }))).toEqual(
      golden.seo.sitemap.map((e) => ({ ...e, lastModified: undefined })),
    );
    // The Menu node, delivery charges left out (the made-up menu the golden copy was taken with).
    const item = (posItemId: string, name: string, cents: number, description: string | null = null) => ({
      posItemId,
      name,
      description,
      basePriceCents: cents,
      taxRateBps: 1500,
      imageUrl: null,
      sortOrder: 0,
      modifierGroups: [],
    });
    expect(
      menuNode({
        categories: [
          { posCategoryId: 'c1', name: 'Pizza', displayOrder: 1, items: [item('p1', 'Test Pizza — Large', 123_400, 'Made-up')] },
          { posCategoryId: 'c9', name: 'Delivery Charges', displayOrder: 9, items: [item('d1', 'Delivery Charge (Rs 200)', 20_000)] },
        ],
        publishedAt: '2026-01-01T00:00:00.000Z',
        store: { name: 'x', phone: null, whatsapp: null, addressLine: null, tagline: null },
      }),
    ).toEqual(golden.seo.menu);
  });

  it('pins the seven area slugs and the six static paths', () => {
    expect(DELIVERY_AREAS.map((a) => a.slug)).toEqual([
      'dha-phase-6',
      'dha-phase-7',
      'dha-phase-8',
      'dha-phase-5',
      'dha-phase-4',
      'dha-phase-1-2',
      'clifton',
    ]);
    expect(sitemap().map((e) => e.url.replace('https://www.cheeseoclock.net', ''))).toEqual([
      '/',
      '/menu',
      '/delivery',
      '/pizza-delivery-dha-karachi',
      '/burger-delivery-dha-karachi',
      '/late-night-food-delivery-dha',
      ...DELIVERY_AREAS.map((a) => `/delivery/${a.slug}`),
    ]);
  });

  it('the generator writes today’s two tiers from today’s areas (so a block with today’s fees reads the same)', () => {
    expect(generatedFeeSummary(DEFAULT_ZONE_FACTS)).toEqual(FEE_SUMMARY.map((f) => ({ ...f })));
    expect(feeSummary(factsFromBlock(block()))).toEqual(golden.feeSummary);
    // A block that changes nothing reads exactly as no block.
    const same = factsFromBlock(block());
    for (const g of golden.areas) {
      const r = renderArea(getArea(g.slug)!, same);
      expect([r.description, r.intro, r.faqs, r.fee]).toEqual([g.description, g.intro, g.faqs, g.feeText]);
    }
    expect(copyText(HOME_FAQ_AREAS, same)).toBe(golden.pages.homeFaqAreas);
    expect(outsideZoneMessage(same)).toBe(golden.pages.orderRouteOutsideZone);
  });
});

describe('a block with other fees', () => {
  // Made-up: Phase 8 up to Rs 300, Clifton Block 5 to Rs 220, Emaar paused, and a new area.
  const facts: SiteFacts = factsFromBlock(
    block((zs) => {
      zone(zs, 'dha-8').feeCents = 30_000;
      zone(zs, 'dha-8').feeItemId = 'fee-300';
      zone(zs, 'clifton-5').feeCents = 22_000;
      zone(zs, 'emaar').active = false;
      zs.push({
        id: 'pechs-6',
        name: 'PECHS Block 6',
        shortName: 'Block 6',
        group: 'PECHS',
        feeCents: 35_000,
        feeItemId: 'fee-350',
        active: true,
        sort: zs.length,
        aliases: [],
      });
    }),
  );

  it('moves the fee chips, the pages’ sentences and the range', () => {
    const p8 = renderArea(getArea('dha-phase-8')!, facts);
    expect(p8.fee).toBe('Rs 250–300 delivery'); // Emaar is off; Phase 8 and Creek Vista are on
    expect(p8.description).toContain('Rs 250–300 delivery');
    expect(p8.faqs.map((f) => f.a)).toContain('Yes — the Do Darya side is covered at the Phase 8 fee of Rs 300.');
    // "the same for Emaar and Creek Vista" is no longer true: the other wording.
    expect(p8.intro[1]).toBe(
      'Delivery is Rs 300 across Phase 8; Emaar Crescent Bay (Rs 250) and Creek Vista (Rs 250) are their own zones at checkout. Do Darya plans fell through? Skip the restaurant queue, order in and pay the rider cash.',
    );
    // "Why is Phase 8 Rs 250 — the rider service's card" explains a card the fee no longer follows: left out.
    expect(p8.faqs.some((f) => f.q.startsWith('Why is delivery to Phase 8'))).toBe(false);
    expect(renderArea(getArea('clifton')!, facts).intro[1]).toBe(
      'Coverage runs across all nine blocks, from Boat Basin and Schon Circle to Bilawal Chowrangi and the Sea View side. Delivery is Rs 200–220 for Blocks 3–9 and Rs 250 for Blocks 1 and 2.',
    );
    expect(deliveryFeeRange(facts)).toBe('Rs 200–350');
    expect(copyText(HOME_HERO_FEE, facts)).toBe('Delivery from Rs 200');
    expect(copyText(DELIVERY_HUB_DESCRIPTION, facts)).toContain('Rs 200–350 delivery');
  });

  it('writes the fee tiers from the areas, and the sentences that summarise them', () => {
    expect(feeSummary(facts)).toEqual([
      { feeCents: 20_000, places: 'DHA Phases 1–7 · Clifton Blocks 3, 4 & 6–9' },
      { feeCents: 22_000, places: 'Clifton Block 5' },
      { feeCents: 25_000, places: 'DHA Creek Vista · Clifton Blocks 1 & 2' },
      { feeCents: 30_000, places: 'DHA Phase 8' },
      { feeCents: 35_000, places: 'PECHS Block 6' },
    ]);
    // The home page's two-tier sentence gives way to the tiers.
    expect(copyText(HOME_FAQ_AREAS, facts)).toBe(
      "DHA Phases 1–8 and Clifton Blocks 1–9, including Emaar Crescent Bay and Creek Vista. Delivery is Rs 200 for DHA Phases 1–7, Clifton Blocks 3, 4 & 6–9; Rs 220 for Clifton Block 5; Rs 250 for DHA Creek Vista, Clifton Blocks 1 & 2; Rs 300 for DHA Phase 8; Rs 350 for PECHS Block 6. We don't deliver outside DHA and Clifton.",
    );
    expect(outsideZoneMessage(facts)).toBe(
      'We deliver in DHA, Clifton and PECHS only. Choose your area from the list — if it is not there, we cannot deliver to it.',
    );
  });

  it('lists a switched-off area in the checkout, not choosable', () => {
    const groups = zoneOptionGroups(facts.zones);
    expect(groups.map((g) => g.group)).toEqual(['DHA', 'Clifton', 'PECHS']);
    const emaar = groups[0]!.options.find((o) => o.id === 'emaar')!;
    expect(emaar).toEqual({ id: 'emaar', label: 'Emaar Crescent Bay (DHA) — delivery paused', disabled: true });
    expect(groups[2]!.options).toEqual([{ id: 'pechs-6', label: 'PECHS Block 6 — Rs 350', disabled: false }]);
  });

  it('keeps a switched-off area’s page, slug, title and words, and says delivery is paused', () => {
    const offClifton = factsFromBlock(
      block((zs) => {
        for (const z of zs) if (z.group === 'Clifton') z.active = false;
      }),
    );
    const c = renderArea(getArea('clifton')!, offClifton);
    expect(c.slug).toBe('clifton');
    expect(c.title).toBe(golden.areas.find((a) => a.slug === 'clifton')!.title);
    expect(c.fee).toBe('Delivery paused');
    expect(c.allPaused).toBe(true);
    expect(c.pausedNote).toBe(
      'Delivery to Clifton is paused right now — the checkout can’t take orders here for the moment. Message us on WhatsApp and we’ll tell you when it’s back.',
    );
    // Its words still read (the fee it will have when delivery is back).
    expect(c.intro[1]).toContain('Delivery is Rs 200 for Blocks 3–9 and Rs 250 for Blocks 1 and 2.');
    expect(sitemap().some((e) => e.url.endsWith('/delivery/clifton'))).toBe(true);
    expect(outsideZoneMessage(offClifton)).toMatch(/^We deliver in DHA only\./);

    const p8 = renderArea(getArea('dha-phase-8')!, factsFromBlock(block((zs) => (zone(zs, 'emaar').active = false))));
    expect(p8.pausedNote).toMatch(/^Delivery to Emaar Crescent Bay \(DHA\) is paused right now/);
    expect(p8.fee).toBe('Rs 250 delivery');
  });

  it('still renders every page when every area is switched off', () => {
    const none = factsFromBlock(block((zs) => zs.forEach((z) => (z.active = false))));
    for (const a of DELIVERY_AREAS) {
      const r = renderArea(a, none);
      expect(r.fee).toBe('Delivery paused');
      expect(r.pausedNote).not.toBeNull();
    }
    expect(deliveryChip(none)).toBe('Delivery paused');
    expect(deliveryOptionNote(none)).toBe('Paused right now');
    expect(outsideZoneMessage(none)).toMatch(/not delivering anywhere/);
    expect(copyText(HOME_HERO_FEE, none)).toBe('Delivery from Rs 200');
  });
});

describe('fee tokens', () => {
  it('fill a fee, a range, the lowest fee and the summary', () => {
    expect(fillFees('{fee:dha-6}', DEFAULT_FACTS)).toBe('Rs 200');
    expect(fillFees('{fee:clifton-1..9}', DEFAULT_FACTS)).toBe('Rs 200–250');
    expect(fillFees('{fees} / {minFee}', DEFAULT_FACTS)).toBe('Rs 200–250 / Rs 200');
    expect(fillFees('no tokens, Phase 6', DEFAULT_FACTS)).toBe('no tokens, Phase 6');
    expect(expandZoneIds('dha-1..3,dha-2-ext')).toEqual(['dha-1', 'dha-2', 'dha-3', 'dha-2-ext']);
  });

  it('refuse a typo rather than print a wrong fee', () => {
    expect(() => fillFees('{fee:dha-66}', DEFAULT_FACTS)).toThrow(/unknown delivery zone "dha-66"/);
    expect(() => fillFees('{price:dha-6}', DEFAULT_FACTS)).toThrow(/Unknown fee token/);
  });

  it('word places the way the fee summary does', () => {
    const z = (shortName: string, group = 'DHA'): FactZone => ({
      id: shortName,
      name: shortName,
      shortName,
      group,
      feeCents: 1,
      feeItemId: null,
      active: true,
      sort: 0,
      aliases: [],
    });
    expect(placesWords([z('Phase 2'), z('Phase 2 Ext'), z('Phase 4')])).toBe('DHA Phases 2 & 4');
    expect(placesWords([z('Phase 2 Ext')])).toBe('DHA Phase 2 Ext');
    expect(placesWords([z('Tariq Road', 'PECHS'), z('Shahrah-e-Faisal', 'PECHS')])).toBe(
      'PECHS Tariq Road & PECHS Shahrah-e-Faisal',
    );
  });
});

describe('no delivery fee is typed by hand', () => {
  // Menu prices and comments that are not delivery fees — each one named, so a
  // fee typed into a page ("Rs 300 delivery") fails here: write a token instead.
  const ALLOWED: Array<[file: string, text: string]> = [
    ['app/burger-delivery-dha-karachi/page.tsx', "small: 'Rs 700 – Rs 950'"],
    ['app/burger-delivery-dha-karachi/page.tsx', 'Add cheese to any burger for Rs 100.'],
    ['app/burger-delivery-dha-karachi/page.tsx', "small: 'From Rs 300'"],
    ['app/burger-delivery-dha-karachi/page.tsx', 'Add cheese to any of them for Rs 100.'],
    ['app/late-night-food-delivery-dha/page.tsx', "small: 'Large · from Rs 480'"],
    ['app/pizza-delivery-dha-karachi/page.tsx', "big: 'From Rs 2,600'"],
    ['app/pizza-delivery-dha-karachi/page.tsx', 'dips are Rs 100 each.'],
    ['lib/format.ts', '/** Rs 1,234 (drops paisa when zero'],
    ['lib/menu-view.ts', 'the page can say "Save Rs 650" without a hard-coded number'],
    ['lib/signatures.ts', '(Medium Rs 1,500, Large Rs 2,000, 1 litre Rs 250)'],
  ];
  const SRC = fileURLToPath(new URL('..', import.meta.url));

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === '__fixtures__' ? [] : sources(path);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
    });
  }

  it('finds every "Rs <digits>" in the website’s source on the list above', () => {
    const found: string[] = [];
    for (const path of sources(SRC)) {
      const file = relative(SRC, path).replace(/\\/g, '/');
      readFileSync(path, 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (!/\bRs\.?\s?\d/.test(line)) return;
          if (ALLOWED.some(([f, text]) => f === file && line.includes(text))) return;
          found.push(`${file}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(found, 'a fee typed by hand — use a {fee:…} token (lib/delivery-facts fillFees)').toEqual([]);
  });

  it('keeps the list honest: every allowed line is still there', () => {
    for (const [file, text] of ALLOWED) {
      expect(readFileSync(join(SRC, file), 'utf8').includes(text), `${file}: ${text}`).toBe(true);
    }
  });

  it('reads the compiled area list only through the delivery facts', () => {
    // Pages and components take areas and fees from the owner's settings
    // (lib/delivery-facts); only these modules may touch the compiled list.
    const MAY = new Set(['lib/delivery-facts.ts', 'lib/delivery-zones.ts', 'lib/publish-settings.ts']);
    const found: string[] = [];
    for (const path of sources(SRC)) {
      const file = relative(SRC, path).replace(/\\/g, '/');
      if (MAY.has(file)) continue;
      readFileSync(path, 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (/\b(DELIVERY_ZONES|FEE_SUMMARY|findZone|deliveryChargeItemFor)\b/.test(line)) found.push(`${file}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(found).toEqual([]);
  });
});
