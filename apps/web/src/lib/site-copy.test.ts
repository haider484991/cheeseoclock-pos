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
  DELIVERY_HUB_INTRO,
  HOME_DELIVERY_NOTE,
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
  return { v: 1, settingsAt: '2026-09-27T10:00:00.000Z', settingsRev: 3, settingsTie: 0, deviceId: 'till-test', pickup, zones };
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
      expect(feeText(getArea(g.slug)!, DEFAULT_FACTS)).toBe(g.feeText);
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
    // Two paragraphs moved out of the page files into page-copy (v0.7.26's words, the summary as the golden copy has it).
    expect(copyText(DELIVERY_HUB_INTRO, DEFAULT_FACTS)).toBe(
      `Every order fires from our kitchen in DHA Phase 6 — daily from 12 noon to 1 am, always cash on delivery. We deliver in DHA and Clifton only: ${golden.feeSummarySentence}. Pick your area below for the streets we cover and answers to the questions your area actually asks.`,
    );
    expect(copyText(HOME_DELIVERY_NOTE, DEFAULT_FACTS)).toBe(
      'Our kitchen is in Rahat Commercial Area, DHA Phase 6. Pick your area at checkout and the delivery charge is added for you — we don’t take online orders outside DHA and Clifton.',
    );
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
    // "the same for Emaar and Creek Vista" is no longer true, and Emaar is off: its fee is not named.
    expect(p8.intro[1]).toBe(
      'Delivery is Rs 300 across Phase 8; Creek Vista (Rs 250) is its own zone at checkout. Do Darya plans fell through? Skip the restaurant queue, order in and pay the rider cash.',
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
    // The home page's two-tier sentence gives way to the tiers — and, with Emaar paused and PECHS
    // added, its areas are written from the owner's list, not "DHA and Clifton".
    expect(copyText(HOME_FAQ_AREAS, facts)).toBe(
      "We deliver to DHA Phases 1–8, Creek Vista, Clifton Blocks 1–9, PECHS Block 6. Delivery is Rs 200 for DHA Phases 1–7, Clifton Blocks 3, 4 & 6–9; Rs 220 for Clifton Block 5; Rs 250 for DHA Creek Vista, Clifton Blocks 1 & 2; Rs 300 for DHA Phase 8; Rs 350 for PECHS Block 6. We don't deliver outside DHA, Clifton and PECHS.",
    );
    expect(outsideZoneMessage(facts)).toBe(
      'We deliver in DHA, Clifton and PECHS only. Choose your area from the list — if it is not there, we cannot deliver to it.',
    );
  });

  it('never says it delivers only to DHA and Clifton once the owner’s areas say otherwise (an area added, a group switched off, every area off)', () => {
    // A new group, the fees otherwise as today.
    const pechs = factsFromBlock(
      block((zs) => {
        zs.push({ id: 'pechs-6', name: 'PECHS Block 6', shortName: 'Block 6', group: 'PECHS', feeCents: 30_000, feeItemId: 'fee-300', active: true, sort: zs.length, aliases: [] });
      }),
    );
    const everywhere = [
      copyText(HOME_FAQ_AREAS, pechs),
      copyText(HOME_DELIVERY_NOTE, pechs),
      copyText(DELIVERY_HUB_DESCRIPTION, pechs),
      copyText(DELIVERY_HUB_INTRO, pechs),
      copyText(LATE_NIGHT_FAQ_AREAS, pechs),
      copyText(PIZZA_FAQ_AREAS, pechs),
      copyText(BURGER_FAQ_AREAS, pechs),
      ...DELIVERY_AREAS.flatMap((a) => renderArea(a, pechs).faqs.map((f) => f.a)),
    ];
    for (const t of everywhere) {
      expect(t).not.toMatch(/(outside|in) DHA and Clifton|DHA and Clifton only/);
    }
    expect(copyText(PIZZA_FAQ_AREAS, pechs)).toContain('We deliver in DHA, Clifton and PECHS only.');
    expect(copyText(LATE_NIGHT_FAQ_AREAS, pechs)).toContain('We do not deliver outside DHA, Clifton and PECHS at any hour.');
    expect(copyText(HOME_FAQ_AREAS, pechs)).toContain("Rs 300 for PECHS Block 6. We don't deliver outside DHA, Clifton and PECHS.");
    // "Do you deliver beyond Clifton? No — DHA and Clifton only" is left out; Phase 2 Ext's answer names the owner's groups.
    expect(renderArea(getArea('clifton')!, pechs).faqs.some((f) => f.q === 'Do you deliver beyond Clifton?')).toBe(false);
    expect(renderArea(getArea('dha-phase-1-2')!, pechs).faqs.map((f) => f.a)).toContain(
      'Yes, Phase 2 Ext has its own option at checkout. We deliver in DHA, Clifton and PECHS only, so for boundary streets near Korangi Road, drop us a WhatsApp first and we will confirm your address is in zone.',
    );

    // Clifton switched off, fees as today: no sentence prices or offers Clifton.
    const noClifton = factsFromBlock(
      block((zs) => {
        for (const z of zs) if (z.group === 'Clifton') z.active = false;
      }),
    );
    for (const t of [copyText(HOME_FAQ_AREAS, noClifton), copyText(LATE_NIGHT_FAQ_AREAS, noClifton), copyText(DELIVERY_HUB_DESCRIPTION, noClifton), copyText(DELIVERY_HUB_INTRO, noClifton)]) {
      expect(t).not.toContain('Clifton');
    }

    // Every area switched off: the /delivery paragraph still reads (no "only: ." with the fees missing),
    // and names no fee (an area switched off never has its fee printed): it says delivery is paused.
    const none = factsFromBlock(block((zs) => zs.forEach((z) => (z.active = false))));
    const intro = copyText(DELIVERY_HUB_INTRO, none);
    expect(intro).not.toMatch(/: \.|is \./);
    expect(intro).not.toMatch(/Rs \d/);
    expect(intro).toContain('Delivery is paused right now');
    expect(copyText(HOME_FAQ_AREAS, none)).not.toMatch(/is \.|to \./);
  });

  it('a free area reads as free, never "Rs 0", on the chips and in the checkout list', () => {
    const free6 = factsFromBlock(block((zs) => ((zone(zs, 'dha-6').feeCents = 0), (zone(zs, 'dha-6').feeItemId = null))));
    expect(feeText(getArea('dha-phase-6')!, free6)).toBe('Free delivery');
    const labels = zoneOptionGroups(free6.zones).flatMap((g) => g.options.map((o) => o.label));
    expect(labels).toContain('DHA Phase 6 — free delivery');
    expect(labels.some((l) => /Rs 0\b/.test(l))).toBe(false);
    const allFree = factsFromBlock(block((zs) => zs.forEach((z) => ((z.feeCents = 0), (z.feeItemId = null)))));
    expect(deliveryChip(allFree)).toBe('Free delivery · DHA & Clifton');
    expect(deliveryOptionNote(allFree)).toBe('Free · DHA & Clifton');
    for (const a of DELIVERY_AREAS) expect(renderArea(a, allFree).fee).toBe('Free delivery');
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
    // Its words still read, with no fee named for blocks switched off; the description says it is paused.
    expect(c.intro.join(' ')).not.toMatch(/Rs \d/);
    expect(c.faqs.map((f) => f.a).join(' ')).not.toMatch(/Rs \d/);
    expect(c.description).toMatch(/Delivery to Clifton is paused right now/);
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
    expect(copyText(HOME_HERO_FEE, none)).toBe('Delivery paused right now');
  });
});

describe('a stored block that lacks a compiled area (a hand-edited row, an older till)', () => {
  it('the area is filled back in from the built-in list — at its built-in fee, on — so its page and the checkout keep it', () => {
    const facts = factsFromBlock({ ...block(), zones: block().zones.filter((z) => z.id !== 'dha-6') });
    const dha6 = facts.zones.find((z) => z.id === 'dha-6');
    expect(dha6).toMatchObject({ feeCents: 20_000, active: true, name: 'DHA Phase 6' });
    expect(facts.zones.map((z) => z.id).sort()).toEqual(DEFAULT_ZONE_FACTS.map((z) => z.id).sort());
    expect(renderArea(getArea('dha-phase-6')!, facts).fee).toBe('Rs 200 delivery');
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

/** The ways JSX and templates hide the space between "Rs" and a number, made plain. */
function plainLine(line: string): string {
  return line
    .replace(/&nbsp;|&#160;|&#xa0;|\u00a0/gi, ' ')
    .replace(/\{\s*(['"`])\s*\1\s*\}/g, ' ')
    .replace(/[ \t]+/g, ' ');
}

/** Does this line of source write a rupee amount by hand: "Rs 250", "Rs&nbsp;250", "Rs{' '}250", `Rs ${n}`, formatCents(25_000)? */
function typesAFee(line: string): boolean {
  const l = plainLine(line);
  return /\bRs\.?\s*\d/.test(l) || /\bRs\.?\s*\$\{/.test(l) || /\bformatCents\(\s*\d/.test(l);
}

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
    ['lib/format.ts', 'return `Rs ${rupees'],
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
          if (!typesAFee(line)) return;
          // An allowed line is fine only for its own words: a fee added beside them is still caught.
          const rest = ALLOWED.filter(([f, text]) => f === file && line.includes(text)).reduce((l, [, text]) => l.replace(text, ''), line);
          if (!typesAFee(rest)) return;
          found.push(`${file}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(found, 'a fee typed by hand — use a {fee:…} token (lib/delivery-facts fillFees)').toEqual([]);
  });

  it('catches a fee hidden from a plain "Rs 250" search', () => {
    for (const hidden of [
      "'Rs 250 delivery'",
      'Rs.250',
      'Rs\u00a0250',
      '<span>Rs&nbsp;250</span>',
      "<b>Rs{' '}250</b>",
      '<b>Rs{" "}250</b>',
      'const fee = `Rs ${n}`;',
      'formatCents(25_000)',
      'Rs  250',
    ]) {
      expect(typesAFee(hidden), hidden).toBe(true);
    }
    for (const fine of ['{fee:dha-6}', 'formatCents(zone.feeCents)', 'Rs: see the menu', 'Track&nbsp;order']) {
      expect(typesAFee(fine), fine).toBe(false);
    }
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

/**
 * Every line of page text the site builds from the fees: the area pages
 * (description, intro, FAQs, fee chip), the home, delivery-hub and landing
 * pages' fee sentences, the fee tiers and the site's chips.
 */
function generatedText(facts: SiteFacts): string {
  const pages = DELIVERY_AREAS.map((a) => renderArea(a, facts)).flatMap((r) => [
    r.description,
    ...r.intro,
    ...r.faqs.flatMap((f) => [f.q, f.a]),
    r.fee,
  ]);
  const copies = [
    HOME_FAQ_AREAS,
    HOME_DELIVERY_NOTE,
    HOME_HERO_FEE,
    HOME_STAT_FEE,
    DELIVERY_HUB_DESCRIPTION,
    DELIVERY_HUB_INTRO,
    LATE_NIGHT_FAQ_AREAS,
    PIZZA_FAQ_AREAS,
    BURGER_FAQ_AREAS,
  ].map((c) => copyText(c, facts));
  const tiers = feeSummary(facts).map((t) => `${t.feeCents} ${t.places}`);
  return [...pages, ...copies, ...tiers, deliveryChip(facts), deliveryOptionNote(facts), deliveryFeeRange(facts)].join('\n');
}

describe('a switched-off area’s fee never appears in the page text; its paused note stays', () => {
  /** A made-up fee no area has, so any line that prints it is caught. */
  const PAUSED = 77_700;
  const off = (ids: readonly string[]) =>
    factsFromBlock(
      block((zs) => {
        for (const id of ids) {
          zone(zs, id).active = false;
          zone(zs, id).feeCents = PAUSED;
        }
      }),
    );

  it('each area switched off on its own: its fee is on no page, and its page says it is paused', () => {
    for (const z of DEFAULT_ZONE_FACTS) {
      const facts = off([z.id]);
      expect(generatedText(facts), z.id).not.toContain('Rs 777');
      const page = DELIVERY_AREAS.find((a) => a.zoneIds.includes(z.id))!;
      expect(renderArea(page, facts).pausedNote, z.id).toContain(z.name);
    }
  });

  it('a group switched off — Emaar and Creek Vista, Clifton Blocks 1 & 2, all of Clifton, a whole page — the same', () => {
    for (const ids of [
      ['emaar', 'creek-vista'],
      ['dha-8', 'emaar', 'creek-vista'],
      ['clifton-1', 'clifton-2'],
      ['clifton-3', 'clifton-4', 'clifton-5', 'clifton-6', 'clifton-7', 'clifton-8', 'clifton-9'],
      DEFAULT_ZONE_FACTS.filter((z) => z.group === 'Clifton').map((z) => z.id),
      ['dha-6', 'dha-7'],
      ['dha-1', 'dha-2', 'dha-2-ext'],
    ]) {
      const facts = off(ids);
      expect(generatedText(facts), ids.join()).not.toContain('Rs 777');
      for (const a of DELIVERY_AREAS.filter((p) => p.zoneIds.some((id) => ids.includes(id)))) {
        expect(renderArea(a, facts).pausedNote, `${a.slug} ${ids.join()}`).not.toBeNull();
      }
    }
  });

  it('the Phase 8 page with Emaar switched off names Phase 8’s and Creek Vista’s fees, not Emaar’s', () => {
    const p8 = renderArea(getArea('dha-phase-8')!, off(['emaar']));
    expect(p8.intro.join(' ')).toContain('Delivery is Rs 250 across Phase 8; Creek Vista (Rs 250) is its own zone at checkout.');
    expect(p8.pausedNote).toMatch(/^Delivery to Emaar Crescent Bay \(DHA\) is paused right now/);
    expect(p8.fee).toBe('Rs 250 delivery');
  });

  it('an area switched off at the SAME fee as its neighbours is not spoken for beside their fee ("the same for …", "all of them")', () => {
    const offAtItsFee = (id: string) => factsFromBlock(block((zs) => (zone(zs, id).active = false)));
    const p8 = renderArea(getArea('dha-phase-8')!, offAtItsFee('emaar'));
    expect(p8.intro[1]).toBe(
      'Delivery is Rs 250 across Phase 8; Creek Vista (Rs 250) is its own zone at checkout. Do Darya plans fell through? Skip the restaurant queue, order in and pay the rider cash.',
    );
    expect(p8.faqs.some((f) => f.q.startsWith('Why is delivery to Phase 8'))).toBe(false);
    const faqOf = (slug: string, facts: SiteFacts, q: string) => renderArea(getArea(slug)!, facts).faqs.find((f) => f.q === q)?.a;
    expect(faqOf('dha-phase-4', offAtItsFee('dha-4'), 'Do you deliver to DHA Phase 3?')).toBe('Yes — pick DHA Phase 3 at checkout. It is Rs 200.');
    expect(faqOf('dha-phase-7', offAtItsFee('dha-7'), 'Do you deliver to Phase 7 Extension?')).toBe(
      'Yes — Phase 7 Extension has its own option at checkout, with its own Rs 200 fee.',
    );
    expect(faqOf('dha-phase-7', offAtItsFee('dha-6'), 'Which area do I pick at checkout?')).toBe(
      'DHA Phase 7, or DHA Phase 7 Extension if you are in Ext. If your street sits on the Phase 6 border, pick the phase your address is in.',
    );
    expect(renderArea(getArea('dha-phase-1-2')!, offAtItsFee('dha-3')).intro[0]).toMatch(/Delivery here is Rs 200\.$/);
    expect(faqOf('clifton', offAtItsFee('clifton-1'), 'Which Clifton blocks do you deliver to?')).toBeUndefined();
  });

  it('every area switched off: no fee anywhere, and the pages say delivery is paused', () => {
    const facts = factsFromBlock(block((zs) => zs.forEach((z) => ((z.active = false), (z.feeCents = PAUSED)))));
    expect(generatedText(facts)).not.toContain('Rs 777');
    expect(copyText(HOME_HERO_FEE, facts)).toBe('Delivery paused right now');
    expect(feeSummary(facts)).toEqual([]);
    for (const a of DELIVERY_AREAS) expect(renderArea(a, facts).description).toMatch(/paused right now/);
  });
});
