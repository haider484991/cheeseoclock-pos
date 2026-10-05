/**
 * The shop's details in the website's words (sweep B2 + B4, lib/shop-facts
 * and the Copy tokens and claims of lib/delivery-facts), pure:
 *  - with nothing stored they are today's, word for word;
 *  - every hours, name, payments and tax token and claim, for today's
 *    details and for others (all made up);
 *  - the brand line (CheeseTime) by the hours and the till's status;
 *  - no hour, greeting, shop name or phone number is typed by hand in the
 *    website's source again: they come from the owner's settings.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { PublishedShopHours, PublishedShopWebsite } from '@cheeseoclock/shared-types';
import { cheeseTimeFallback, cheeseTimeLine, karachiClock, nextOpening, openByHours } from './cheese-time';
import { CantPrint, DEFAULT_FACTS, NoMinimumToken, PausedFeeToken, claimHolds, copyText, fillFees, renderCopy, taxed, type Copy, type CopyFacts } from './delivery-facts';
import * as pageCopy from './page-copy';
import { DELIVERY_AREAS } from './areas';
import {
  DEFAULT_SHOP_FACTS,
  nameIsDefault,
  orderWhatsappUrl,
  shopFactsFromBlock,
  whatsappHello,
  whatsappLinesOf,
  whatsappNumbersText,
  type ShopFacts,
} from './shop-facts';
import { DEFAULT_TAX_BPS, taxBpsOf, taxPercentWords } from './tax-words';

/** Today's details with `over` applied (made-up values). */
function shop(over: { hours?: Partial<PublishedShopHours>; website?: Partial<PublishedShopWebsite>; name?: string } = {}): ShopFacts {
  return {
    ...DEFAULT_SHOP_FACTS,
    source: 'settings',
    profile: { ...DEFAULT_SHOP_FACTS.profile, ...(over.name ? { name: over.name } : {}) },
    hours: { ...DEFAULT_SHOP_FACTS.hours, ...over.hours },
    website: { ...DEFAULT_SHOP_FACTS.website, ...over.website },
  };
}
const facts = (s: ShopFacts, taxBps?: number | null): CopyFacts => ({ ...DEFAULT_FACTS, shop: s, ...(taxBps !== undefined ? { taxBps } : {}) });
const ALL_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as PublishedShopHours['days'];

describe('with nothing stored: today’s details, word for word (v0.7.30’s website)', () => {
  it('the facts', () => {
    expect(DEFAULT_SHOP_FACTS).toEqual({
      source: 'default',
      profile: {
        name: "Cheese O'Clock",
        tagline: 'Hygienically Made. Deliciously Unforgettable.',
        phone: { display: '0300 9367865', e164: '+923009367865' },
        whatsappLines: [
          { display: '0300 9367865', e164: '+923009367865' },
          { display: '0331 2188295', e164: '+923312188295' },
        ],
        address: {
          street: 'Shop 3, Ground Floor, 41-C, Sehar Lane No. 3, Rahat Commercial Area, DHA Phase 6',
          areaLine: 'Rahat Commercial Area, DHA Phase 6, Karachi',
          postalCode: '75500',
        },
        socialLinks: ['https://www.instagram.com/cheeseoclock_/', 'https://www.facebook.com/cheeseoclock.karachi'],
        priceRange: 'PKR 400–2,500',
      },
      hours: { opens: '13:00', closes: '01:00', days: ALL_DAYS },
      website: {
        whatsappGreeting: "Hi Cheese O'Clock! I'd like to place an order: ",
        doorPayments: ['cash'],
        pickupPayments: ['cash'],
        allergyNotice:
          'Allergy? Tell us in the item’s “Allergy or special request” box and we’ll leave ingredients out. Our kitchen shares equipment, so we can’t guarantee any dish is allergen-free.',
      },
      home: {
        pizzas: ['Cheesy Star — Large', 'Crown Crust — Large', 'Shawarma Pizza — Large', 'Meat Lovers — Large', 'Cheetos — Large'].map((name) => ({
          itemRef: { posItemId: null, name },
        })),
        burger: { itemRef: { posItemId: null, name: 'Signature Cheese Dipped' } },
        deals: ['Big Two', 'Family Feast', 'Perfect Pair'].map((name) => ({ itemRef: { posItemId: null, name } })),
      },
    });
    expect(Object.isFrozen(DEFAULT_SHOP_FACTS.profile.whatsappLines)).toBe(true);
    expect(shopFactsFromBlock(null)).toBe(DEFAULT_SHOP_FACTS);
  });

  it('today’s links and words', () => {
    expect(orderWhatsappUrl(DEFAULT_SHOP_FACTS)).toBe('https://wa.me/923009367865?text=Hi%20Cheese%20O\'Clock!%20I\'d%20like%20to%20place%20an%20order%3A%20');
    expect(whatsappLinesOf(DEFAULT_SHOP_FACTS).map((l) => l.url)).toEqual(['https://wa.me/923009367865', 'https://wa.me/923312188295']);
    expect(whatsappNumbersText(DEFAULT_SHOP_FACTS)).toBe('0300 9367865 or 0331 2188295');
    expect(whatsappHello(DEFAULT_SHOP_FACTS)).toBe("Hi Cheese O'Clock!");
    expect(nameIsDefault(DEFAULT_SHOP_FACTS)).toBe(true);
    // Plain SiteFacts (no shop, no tax) read as today's: every call written before B4 still works.
    const today =
      '{hours} | {opens} | {closes} | {days} | {hoursLine} | {name} | {nameProse} | {phone} | {waNumbers} | {street} | {areaLine} | {doorPayments} | {DoorPayments} | {pickupPayments} | {tax} | {Tax}';
    expect(fillFees(today, DEFAULT_FACTS)).toBe(
      "1 pm – 1 am | 1 pm | 1 am | daily | Open daily · 1 pm – 1 am | Cheese O'Clock | Cheese O’Clock | 0300 9367865 | 0300 9367865 or 0331 2188295 | Shop 3, Ground Floor, 41-C, Sehar Lane No. 3, Rahat Commercial Area, DHA Phase 6 | Rahat Commercial Area, DHA Phase 6, Karachi | cash | Cash | cash | 15% tax | 15% tax",
    );
    for (const claim of [
      { everyDay: true },
      { closesAfterMidnight: true },
      { opensBy: '13:00' },
      { cashOnly: true },
      { pickupCashOnly: true },
      { nameIsDefault: true },
      { oneTaxRate: true },
    ] as const) {
      expect(claimHolds(claim, DEFAULT_FACTS), JSON.stringify(claim)).toBe(true);
    }
  });
});

describe('the tokens and claims for the owner’s details (made up)', () => {
  it('hours in words: any quarter hour, midnight, noon; the days', () => {
    const f = facts(shop({ hours: { opens: '11:00', closes: '23:00', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'] } }));
    expect(fillFees('{hours}; {opens}; {closes}; {days}; {hoursLine}', f)).toBe('11 am – 11 pm; 11 am; 11 pm; Mon–Sat; Open Mon–Sat · 11 am – 11 pm');
    expect(fillFees('{hours}', facts(shop({ hours: { opens: '13:30', closes: '00:00' } })))).toBe('1:30 pm – midnight');
    expect(fillFees('{days}', facts(shop({ hours: { days: ['tue', 'thu'] } })))).toBe('Tue, Thu');
    expect(fillFees('{days}', facts(shop({ hours: { days: ['mon', 'tue', 'wed', 'fri', 'sun'] } })))).toBe('Mon–Wed, Fri, Sun');
  });

  it('the claims break when the details stop making them true', () => {
    const late = facts(shop({ hours: { closes: '02:00' } }));
    const early = facts(shop({ hours: { opens: '14:00', closes: '23:00', days: ['tue', 'wed'] } }));
    const atMidnight = facts(shop({ hours: { closes: '00:00' } }));
    expect(claimHolds({ closesAfterMidnight: true }, late)).toBe(true);
    expect(claimHolds({ closesAfterMidnight: true }, atMidnight)).toBe(false);
    expect(claimHolds({ closesAfterMidnight: true }, early)).toBe(false);
    expect(claimHolds({ everyDay: true }, early)).toBe(false);
    expect(claimHolds({ opensBy: '13:00' }, early)).toBe(false);
    const card = facts(shop({ website: { doorPayments: ['cash', 'card'], pickupPayments: ['cash'] } }));
    expect([claimHolds({ cashOnly: true }, card), claimHolds({ pickupCashOnly: true }, card)]).toEqual([false, true]);
    expect(fillFees('{DoorPayments} on delivery; {pickupPayments}', card)).toBe('Cash or card on delivery; cash');
    expect(fillFees('{doorPayments}', facts(shop({ website: { doorPayments: ['cash', 'card', 'easypaisa', 'jazzcash', 'bank_transfer'] } })))).toBe(
      'cash, card, EasyPaisa, JazzCash or bank transfer',
    );
    const renamed = facts(shop({ name: "Made-Up Pizza's" }));
    expect(claimHolds({ nameIsDefault: true }, renamed)).toBe(false);
    expect(fillFees('{name} / {nameProse}', renamed)).toBe("Made-Up Pizza's / Made-Up Pizza’s");
  });

  it('a claim that breaks takes the copy’s other words — and never leaves a copy with none silently', () => {
    const copy = { text: 'Open every day till {closes}.', when: { everyDay: true }, otherwise: 'Open {days} till {closes}.' } as const;
    expect(copyText(copy, facts(shop()))).toBe('Open every day till 1 am.');
    expect(copyText(copy, facts(shop({ hours: { days: ['fri', 'sat'] } })))).toBe('Open Fri, Sat till 1 am.');
    expect(renderCopy({ text: "IT'S ALWAYS {name}", when: { nameIsDefault: true } }, facts(shop({ name: 'Other' })))).toBeNull();
  });

  it('an unknown token still throws — a typo fails the tests and the build', () => {
    expect(() => fillFees('{closing}', DEFAULT_FACTS)).toThrow(/Unknown fee token \{closing\}/);
    expect(() => fillFees('{Hours}', DEFAULT_FACTS)).toThrow(/Unknown fee token/);
    // The "can't print" signals share one base (renderCopy takes the other words for any of them).
    expect(new PausedFeeToken('{fee:x}')).toBeInstanceOf(CantPrint);
    expect(new NoMinimumToken('{minOrder}')).toBeInstanceOf(CantPrint);
  });
});

describe('tax in words: the food’s one rate from the published menu', () => {
  const item = (id: string, name: string, bps: number) => ({ posItemId: id, name, taxRateBps: bps });
  const menu = (...items: Array<ReturnType<typeof item>>) => ({ categories: [{ items }] });

  it('one rate → its number; the menu unknown or empty → today’s 15%', () => {
    expect(taxBpsOf(menu(item('a', 'Test Pizza', 1500), item('b', 'Test Fries', 1500)))).toBe(1500);
    expect(taxBpsOf(null)).toBe(DEFAULT_TAX_BPS);
    expect(taxBpsOf(menu())).toBe(DEFAULT_TAX_BPS);
    expect(DEFAULT_TAX_BPS).toBe(1500);
    expect([taxPercentWords(1500), taxPercentWords(1650), taxPercentWords(1625), taxPercentWords(1000)]).toEqual(['15%', '16.5%', '16.25%', '10%']);
  });

  it('a delivery charge is not food: its rate never counts (by the block’s ids, or by its name)', () => {
    const m = menu(item('a', 'Test Pizza', 1650), item('fee', 'Test Charge', 1600), item('c', 'Delivery Charge (Rs 999)', 1300));
    expect(taxBpsOf(m, new Set(['fee']))).toBe(1650);
  });

  it('food at two rates names no number: "tax" / "Tax"', () => {
    expect(taxBpsOf(menu(item('a', 'Test Pizza', 1500), item('b', 'Test Drink — 1 litre', 1300)))).toBeNull();
    const words = '{Tax} is added; plus {tax} and';
    expect(fillFees(words, { ...DEFAULT_FACTS, taxBps: null })).toBe('Tax is added; plus tax and');
    expect(fillFees(words, { ...DEFAULT_FACTS, taxBps: 1650 })).toBe('16.5% tax is added; plus 16.5% tax and');
    expect(claimHolds({ oneTaxRate: true }, { ...DEFAULT_FACTS, taxBps: null })).toBe(false);
  });

  it('food taxed at 0%: no sentence says tax is added — {tax} can’t print, and taxed() copy reads its own words', () => {
    const zero = { ...DEFAULT_FACTS, taxBps: 0 };
    expect(taxBpsOf(menu(item('a', 'Test Pizza', 0), item('b', 'Test Fries', 0)))).toBe(0);
    expect(() => fillFees('{Tax} is added', zero)).toThrow(CantPrint);
    expect(claimHolds({ taxAdded: true }, zero)).toBe(false);
    // Tax is added at one rate, at mixed rates, and with the menu unknown (today's 15%).
    for (const taxBps of [1500, null, undefined]) expect(claimHolds({ taxAdded: true }, { ...DEFAULT_FACTS, taxBps })).toBe(true);
    const copy = taxed({ text: 'Cash only. Plus {tax}.', when: { cashOnly: true }, otherwise: 'Pay {doorPayments}. Plus {tax}.' }, {
      text: 'Cash only.',
      when: { cashOnly: true },
      otherwise: 'Pay {doorPayments}.',
    });
    expect(copyText(copy, DEFAULT_FACTS)).toBe('Cash only. Plus 15% tax.');
    expect(copyText(copy, zero)).toBe('Cash only.');
    const cardShop = { ...DEFAULT_SHOP_FACTS, website: { ...DEFAULT_SHOP_FACTS.website, doorPayments: ['cash', 'card'] as PublishedShopWebsite['doorPayments'] } };
    expect(copyText(copy, { ...DEFAULT_FACTS, shop: cardShop })).toBe('Pay cash or card. Plus 15% tax.');
    expect(copyText(copy, { ...zero, shop: cardShop })).toBe('Pay cash or card.');
    expect(() => taxed({ text: 'No otherwise {tax}', when: { cashOnly: true } }, 'x')).toThrow(/needs an otherwise/);
  });

  it('every sentence of the pages that names tax has its words for food at 0% — and none of them says tax is added', () => {
    const zero: CopyFacts = { ...DEFAULT_FACTS, taxBps: 0 };
    const cardShop = {
      ...DEFAULT_SHOP_FACTS,
      website: { ...DEFAULT_SHOP_FACTS.website, doorPayments: ['cash', 'card'] as PublishedShopWebsite['doorPayments'], pickupPayments: ['cash'] as PublishedShopWebsite['pickupPayments'] },
    };
    const copies: Array<[string, Copy]> = [];
    for (const [name, v] of Object.entries(pageCopy)) {
      if (typeof v === 'string' || (v && typeof v === 'object' && 'text' in v)) copies.push([name, v as Copy]);
    }
    for (const a of DELIVERY_AREAS) {
      a.faqs.forEach((f, i) => copies.push([`${a.slug} faq ${i}`, f.a]));
      a.intro.forEach((c, i) => copies.push([`${a.slug} intro ${i}`, c]));
    }
    const namesTax = (c: Copy): boolean =>
      typeof c === 'string' ? /\{[Tt]ax\}/.test(c) : /\{[Tt]ax\}/.test(c.text) || (c.otherwise !== undefined && namesTax(c.otherwise));
    const taxing = copies.filter(([, c]) => namesTax(c));
    expect(taxing.length).toBeGreaterThanOrEqual(10);
    for (const facts of [zero, { ...zero, shop: cardShop }]) {
      for (const [name, c] of taxing) {
        const out = renderCopy(c, facts);
        expect(out, name).not.toBeNull();
        expect(out!, name).not.toMatch(/\btax is added|plus tax|tax on the bill|tax added/i);
      }
    }
    // With tax added, every one reads as before (the rate named).
    for (const [name, c] of taxing) expect(renderCopy(c, DEFAULT_FACTS), name).toMatch(/15% tax/);
  });
});

describe('the brand line (CheeseTime): by the owner’s hours alone, as v0.7.30 by today’s', () => {
  const H = { opens: '12:00', closes: '01:00', days: ALL_DAYS };
  const at = (hh: number, mm = 0) => hh * 60 + mm;
  const words = (o: Partial<Parameters<typeof cheeseTimeLine>[0]>) =>
    cheeseTimeLine({ hours: H, nameIsDefault: true, nameProse: 'Cheese O’Clock', day: 'mon', now: at(20), ...o });

  it('the served line and today’s words by the clock: as before', () => {
    expect(cheeseTimeFallback({ nameIsDefault: true, nameProse: 'Cheese O’Clock' })).toBe('It’s always Cheese O’Clock in DHA.');
    expect(words({ now: at(20, 47) })).toBe('definitely Cheese O’Clock.');
    expect(words({ now: at(0, 30) })).toBe('definitely Cheese O’Clock.');
    expect(words({ now: at(9) })).toBe('we open at 12 noon. Almost Cheese O’Clock.');
    expect(words({ now: at(12) })).toBe('definitely Cheese O’Clock.');
    expect(words({ now: at(1) })).toBe('we open at 12 noon. Almost Cheese O’Clock.');
  });

  it('never asks the website: no request per page view, and the words are v0.7.30’s (the shift’s state is /menu’s to say)', () => {
    const src = readFileSync(new URL('../components/CheeseTimeClient.tsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toContain('store-status');
    expect(src).not.toContain('visibilitychange');
    // The line never speaks of website orders (v0.7.30 had only the two).
    for (const now of [at(0, 30), at(1), at(9), at(11, 59), at(12), at(20)]) {
      expect(words({ now })).toMatch(/^(definitely Cheese O’Clock\.|we open at 12 noon\. Almost Cheese O’Clock\.)$/);
    }
  });

  it('the owner’s hours and days, and another name (no pun)', () => {
    const hours = { opens: '11:30', closes: '23:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'] as PublishedShopHours['days'] };
    expect(openByHours(hours, 'mon', at(11, 30))).toBe(true);
    expect(openByHours(hours, 'mon', at(23))).toBe(false);
    expect(openByHours(hours, 'sat', at(13))).toBe(false);
    expect(nextOpening(hours, 'fri', at(23, 30))).toBe('on Monday at 11:30 am');
    expect(nextOpening(hours, 'thu', at(23, 30))).toBe('tomorrow at 11:30 am');
    expect(nextOpening(hours, 'mon', at(9))).toBe('at 11:30 am');
    const other = { hours, nameIsDefault: false, nameProse: 'Made-Up Kitchen' };
    expect(cheeseTimeLine({ ...other, day: 'sat', now: at(13) })).toBe('we open on Monday at 11:30 am.');
    expect(cheeseTimeLine({ ...other, day: 'mon', now: at(13) })).toBe('the kitchen is open.');
    expect(cheeseTimeFallback(other)).toBe('Hot from our kitchen in DHA.');
    // After midnight belongs to the day that opened: open till 01:00 on Sunday night only if Sunday is open.
    const sunOff = { opens: '12:00', closes: '01:00', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as PublishedShopHours['days'] };
    expect(openByHours(sunOff, 'sun', at(0, 30))).toBe(true); // Saturday night
    expect(openByHours(sunOff, 'mon', at(0, 30))).toBe(false); // Sunday night
  });

  it('Karachi’s clock, whatever the server’s zone', () => {
    const c = karachiClock(new Date('2026-09-28T19:30:00.000Z')); // 00:30 on Tuesday in Karachi
    expect([c.day, c.now]).toEqual(['tue', 30]);
    const d = karachiClock(new Date('2026-09-28T07:05:00.000Z')); // 12:05 on Monday
    expect([d.day, d.now]).toEqual(['mon', 12 * 60 + 5]);
  });
});

// ---------------------------------------------------------------------------
// Never typed by hand again
// ---------------------------------------------------------------------------

const SRC = fileURLToPath(new URL('..', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__fixtures__' ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

/** A line of a comment (never page text). */
const isComment = (line: string) => /^\s*(\*|\/\/|\/\*)/.test(line);

/** Lines that break a rule, "file:line: text", but those whose own words are on the allowed list. */
function offending(rule: (line: string) => boolean, allowed: ReadonlyArray<[file: string, text: string]>): string[] {
  const found: string[] = [];
  for (const path of sources(SRC)) {
    const file = relative(SRC, path).replace(/\\/g, '/');
    readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (isComment(line) || !rule(line)) return;
        const rest = allowed.filter(([f, text]) => f === file && line.includes(text)).reduce((l, [, text]) => l.replace(text, ''), line);
        if (!rule(rest)) return;
        found.push(`${file}:${i + 1}: ${line.trim()}`);
      });
  }
  return found;
}

function keepsTheListHonest(allowed: ReadonlyArray<[file: string, text: string]>): void {
  for (const [file, text] of allowed) expect(readFileSync(join(SRC, file), 'utf8').includes(text), `${file}: ${text}`).toBe(true);
}

/** An hour typed by hand: "1 am", "12 noon", "11:30 pm", "Till 1 AM", or an "HH:MM" string. */
function typesAnHour(line: string): boolean {
  return /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.test(line) || /\bnoon\b/i.test(line) || /(['"`])\d{2}:\d{2}\1/.test(line);
}

/** The WhatsApp greeting, or a message greeting the shop by a typed name. */
function typesTheGreeting(line: string): boolean {
  return /place an order/i.test(line) || /\bHi,?\s+Cheese\b/i.test(line) || /encodeURIComponent\(\s*["'`]Hi\b/.test(line);
}

/** The shop's name, however it is spelled or escaped. */
function typesTheName(line: string): boolean {
  return /cheese\s*o\s*(?:['’]|&rsquo;|&#x27;|&apos;)?\s*clock/i.test(line.replace(/@cheeseoclock\/|cheeseoclock\.net|'cheeseoclock'/gi, ''));
}

/**
 * A shop phone or WhatsApp number: "0300 9367865", "+923009367865",
 * "wa.me/92…", "tel:+92…" — not the example a customer's phone field shows
 * ("0300 1234567").
 */
function typesANumber(line: string): boolean {
  const l = line.replace(/0300 1234567/g, '');
  return /\b03\d{2}[\s-]?\d{7}\b/.test(l) || /\+92\s?\d{10}\b/.test(l) || /wa\.me\/\d/.test(l) || /tel:\+?\d/.test(l);
}

/** A tax rate: "15% tax", "16.5% sales tax", "17% GST". */
function typesATaxRate(line: string): boolean {
  return /\b\d{1,2}(?:\.\d{1,2})?\s*%\s*(?:tax|GST|sales tax)\b/i.test(line);
}

describe('the shop’s details are never typed by hand in the website’s source', () => {
  // Words that are not the shop's opening hours, each named.
  const HOURS_ALLOWED: Array<[string, string]> = [
    // An example the customer can type over (the pick-up time), not a claim about the shop.
    ['components/ordering/CheckoutSheet.tsx', "'I’ll be there at 9 pm'"],
    // "Lunch": the office FAQ says "lunch and dinner" only while the shop opens by then.
    ['lib/areas.ts', "{ opensBy: '13:00' }"],
    // The Buy 1 Get 1 offer's own hours (the poster's, owner 5 Oct 2026), not the shop's opening hours.
    ['lib/offers.ts', "'1–7 PM'"],
  ];
  // The logo's own words (the image says them) and the share images' static alt text.
  const NAME_ALLOWED: Array<[string, string]> = [
    ['components/BrandMark.tsx', 'alt="Cheese O\'Clock"'],
    ['components/Logo.tsx', 'Cheese O&rsquo;Clock'],
    ['app/opengraph-image.tsx', '"Cheese O\'Clock — Pizza & Burger Delivery in DHA Karachi"'],
    ['app/delivery/[area]/opengraph-image.tsx', '"Cheese O\'Clock delivery area"'],
  ];

  it('no opening hour: the owner’s hours are tokens ({hours}, {opens}, {closes}, {hoursLine})', () => {
    expect(offending(typesAnHour, HOURS_ALLOWED), 'an hour typed by hand — use an hours token (lib/delivery-facts fillFees)').toEqual([]);
  });

  it('no WhatsApp greeting: every order link carries the owner’s (lib/shop-facts orderWhatsappUrl, lineOrderUrl)', () => {
    expect(offending(typesTheGreeting, []), 'a greeting typed by hand').toEqual([]);
  });

  it('no shop name but the logo’s: the name is {name} / {nameProse} / shop.profile.name', () => {
    expect(offending(typesTheName, NAME_ALLOWED), 'the name typed by hand').toEqual([]);
  });

  it('no phone or WhatsApp number: the owner’s lines (lib/shop-facts)', () => {
    expect(offending(typesANumber, []), 'a number typed by hand').toEqual([]);
  });

  it('no tax rate: the food’s one rate from the published menu ({tax} / {Tax}; lib/tax-words DEFAULT_TAX_BPS is the one fallback)', () => {
    expect(offending(typesATaxRate, []), 'a tax rate typed by hand').toEqual([]);
    for (const t of ['15% tax', 'plus 15 % tax', '16.5% sales tax', '17% GST']) expect(typesATaxRate(t), t).toBe(true);
    for (const fine of ['{tax} on the bill', '10% off when you order online', '10% off online pick-up · not on value deals', 'Tax (est.)']) {
      expect(typesATaxRate(fine), fine).toBe(false);
    }
  });

  it('catches them however they are written', () => {
    for (const hour of ["'Open till 1 am'", 'Till 1 AM', 'from 12 noon', '11:30 pm', "opens: '12:00'", 'at 9pm']) expect(typesAnHour(hour), hour).toBe(true);
    for (const fine of ['{closes}', 'Phase 1', 'a 1 litre drink', 'Rs 1,000', '2026-09-28T07:00:00.000Z', 'amount']) expect(typesAnHour(fine), fine).toBe(false);
    for (const g of ["waLink(\"Hi Cheese O'Clock! I'd like to place an order: \")", 'encodeURIComponent("Hi there")', "'Hi Cheese O Clock!'"]) {
      expect(typesTheGreeting(g), g).toBe(true);
    }
    expect(typesTheGreeting("'Hi {name}! I\\'d like to order pizza. '")).toBe(false);
    for (const n of ["Cheese O'Clock", 'Cheese O’Clock', 'CHEESE O&rsquo;CLOCK', 'cheese o clock', 'Cheese O&#x27;Clock']) expect(typesTheName(n), n).toBe(true);
    for (const fine of ["from '@cheeseoclock/shared-types'", 'https://www.cheeseoclock.net', "'cheeseoclock'", '{nameProse}']) expect(typesTheName(fine), fine).toBe(false);
    for (const num of ['0300 9367865', '0331-2188295', '+923009367865', 'https://wa.me/923009367865', 'tel:+923009367865']) expect(typesANumber(num), num).toBe(true);
    for (const fine of ['orderLine(shop).url', "'75500'", 'Rs 2,200', 'placeholder="0300 1234567"']) expect(typesANumber(fine), fine).toBe(false);
  });

  it('keeps the lists honest: every allowed line is still there', () => {
    keepsTheListHonest(HOURS_ALLOWED);
    keepsTheListHonest(NAME_ALLOWED);
  });

  it('the shop’s words come from the facts: the place constants hold nothing else', () => {
    const business = readFileSync(join(SRC, 'lib/business.ts'), 'utf8');
    for (const gone of ['name:', 'tagline', 'phone', 'whatsapp', 'streetAddress', 'hours', 'sameAs', 'priceRange', 'WA_ORDER_URL', 'waLink']) {
      expect(business.replace(/^\s*(\*|\/\/).*$/gm, ''), gone).not.toContain(gone);
    }
  });
});

// ---------------------------------------------------------------------------
// A sentence true only for today's hours or payments is a claimed Copy
// ---------------------------------------------------------------------------

/**
 * A sentence that says the shop opens every day, is open after midnight, or
 * takes cash only is true for today's details and false for the owner's
 * next ones: it may print only as the `text` of a Copy whose `when` claims
 * it ({ everyDay }, { closesAfterMidnight }, { cashOnly } / {
 * pickupCashOnly }: lib/delivery-facts claimHolds), with its `otherwise`
 * for the other case. Read from the source's syntax (the TypeScript
 * parser), so a sentence over several lines, in a template or in JSX is
 * found too; comments are not page text.
 */
interface DayClaimRule {
  what: string;
  /** The claims that make the sentence true. */
  claims: readonly string[];
  says: (text: string) => boolean;
}

const SAYS_EVERY_DAY: DayClaimRule = {
  what: 'open every day',
  claims: ['everyDay'],
  says: (t) => /\bevery\s+(?:single\s+)?(?:day|night|evening)\b|\bdaily\b|\b(?:seven|7)\s+days\b|\ball\s+week\b|\b24\s*\/\s*7\b/i.test(t),
};
const SAYS_AFTER_MIDNIGHT: DayClaimRule = {
  what: 'open after midnight',
  claims: ['closesAfterMidnight'],
  says: (t) => /\bmidnight\b|\b(?:small|wee)\s+hours\b/i.test(t),
};
const SAYS_CASH_ONLY: DayClaimRule = {
  what: 'cash only',
  claims: ['cashOnly', 'pickupCashOnly'],
  says: (t) =>
    /\bcash[\s-]+only\b|\bonly\s+(?:in\s+)?cash\b|\bin\s+cash\b|\bno\s+(?:credit\s+|debit\s+)?cards?\b|\bno\s+online\s+payments?\b|\bevery\s+order\s+is\s+cash\b|\bcards?\s+(?:are\s+)?not\s+(?:accepted|taken)\b|\bdon[’']?t\s+take\s+cards?\b/i.test(
      t,
    ),
};
const DAY_CLAIM_RULES = [SAYS_EVERY_DAY, SAYS_AFTER_MIDNIGHT, SAYS_CASH_ONLY];

/** Each piece of text in a source file — its strings, templates and JSX text — with its line. */
function pageTexts(file: string, source: string): Array<{ node: ts.Node; text: string; line: number }> {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Array<{ node: ts.Node; text: string; line: number }> = [];
  const visit = (node: ts.Node): void => {
    let text: string | null = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)) text = node.text;
    else if (ts.isTemplateExpression(node)) text = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ');
    if (text !== null && text.trim() !== '') out.push({ node, text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * Is this text the `text` of a Copy that claims one of these? The nearest
 * property holding it must be `text:`, beside a `when:` naming the claim —
 * never its `otherwise`, a plain string, a JSX line or anything else.
 */
function claimedText(node: ts.Node, claims: readonly string[]): boolean {
  for (let n: ts.Node = node; n.parent; n = n.parent) {
    const p = n.parent;
    if (!ts.isPropertyAssignment(p) || p.initializer !== n) continue;
    if (p.name.getText() !== 'text' || !ts.isObjectLiteralExpression(p.parent)) return false;
    const when = p.parent.properties.find((q) => ts.isPropertyAssignment(q) && q.name.getText() === 'when');
    return !!when && claims.some((c) => new RegExp(`\\b${c}\\b`).test(when.getText()));
  }
  return false;
}

/** The unclaimed sentences of one source: "file:line: rule: text". */
function unclaimedIn(file: string, source: string, allowed: ReadonlyArray<[file: string, text: string]> = []): string[] {
  const found: string[] = [];
  for (const { node, text, line } of pageTexts(file, source)) {
    if (allowed.some(([f, t]) => f === file && t === text)) continue;
    for (const rule of DAY_CLAIM_RULES) {
      if (rule.says(text) && !claimedText(node, rule.claims)) found.push(`${file}:${line}: ${rule.what}: ${text.trim()}`);
    }
  }
  return found;
}

describe('no sentence true only for today’s hours or payments is typed outside a claimed Copy', () => {
  // Words that are not such a sentence, each named.
  const ALLOWED: Array<[file: string, text: string]> = [
    // The sitemap's hint to search engines (check /menu daily), not page text.
    ['app/sitemap.ts', 'daily'],
    // A question; its answer is the owner's payments (page-copy BURGER_FAQ_PAY: "No — the rider takes …").
    ['app/burger-delivery-dha-karachi/page.tsx', 'Is payment cash only?'],
  ];

  it('today’s website source: every such sentence is a Copy’s claimed `text`', () => {
    const found: string[] = [];
    for (const path of sources(SRC)) {
      const file = relative(SRC, path).replace(/\\/g, '/');
      found.push(...unclaimedIn(file, readFileSync(path, 'utf8'), ALLOWED));
    }
    expect(
      found,
      'a sentence true only for today’s details — write it as { text, when: { everyDay | closesAfterMidnight | cashOnly }, otherwise } (lib/page-copy.ts)',
    ).toEqual([]);
  });

  it('catches one typed anywhere else — a constant, a template, JSX, an `otherwise`, the wrong claim, a plain taxed() line', () => {
    const one = (file: string, source: string) => unclaimedIn(file, source).map((f) => f.replace(/^[^:]+:\d+: /, ''));
    // The skeptic's three (S10, S8b, S9b).
    expect(one('app/x/page.tsx', "export const SK_CASH = 'No card or app required — pay the rider in cash.';")).toEqual([
      'cash only: No card or app required — pay the rider in cash.',
    ]);
    expect(one('lib/areas.ts', "export const SK_MID = 'we deliver after midnight every night';")).toEqual([
      'open every day: we deliver after midnight every night',
      'open after midnight: we deliver after midnight every night',
    ]);
    expect(one('lib/areas.ts', "export const SK_DAY = 'we are open every day of the week';")).toEqual(['open every day: we are open every day of the week']);
    expect(one('app/x/page.tsx', 'export const P = () => <p className="x">We bake\n  seven days a week</p>;')).toHaveLength(1);
    expect(one('lib/x.ts', 'const s = `Open daily till ${closes}`;')).toEqual(['open every day: Open daily till']);
    expect(one('lib/x.ts', "const c: Copy = { text: 'open every day', when: { everyDay: true }, otherwise: 'open every day, honestly' };")).toEqual([
      'open every day: open every day, honestly',
    ]);
    expect(one('lib/x.ts', "const c: Copy = { text: 'Pay the rider in cash', when: { areasAsBuilt: true }, otherwise: 'Pay the rider' };")).toEqual([
      'cash only: Pay the rider in cash',
    ]);
    expect(one('lib/x.ts', "const faq = { q: 'How do I pay?', a: taxed('Cash only, plus {tax}.', 'Cash only.') };")).toHaveLength(2);
    expect(one('lib/x.ts', "const c = { text: 'Pay the rider in cash', when: { cashOnly: true }, extra: { text: 'no cards at all' } };")).toEqual([
      'cash only: no cards at all',
    ]);
  });

  it('lets through a claimed `text` (a list of claims too), and words that claim nothing', () => {
    const one = (file: string, source: string) => unclaimedIn(file, source);
    expect(
      one('lib/x.ts', "const c: Copy = { text: 'Past midnight, every night', when: [{ closesAfterMidnight: true }, { everyDay: true }], otherwise: 'Late, {days}' };"),
    ).toEqual([]);
    expect(
      one('lib/x.ts', "const c: Copy = { text: 'You pay in cash when you collect.', when: { pickupCashOnly: true }, otherwise: 'You pay when you collect.' };"),
    ).toEqual([]);
    expect(one('lib/x.ts', "const c: Copy = { text: 'Pay in cash', when: { cashOnly: true }, otherwise: { text: 'No cards, just wallets', when: { cashOnly: true } } };")).toEqual([]);
    for (const fine of ['Cash on delivery', '{days} from {opens} to {closes}', 'Every order fires from our kitchen', 'every DHA phase', 'everyDay', 'closesAfterMidnight', 'weekly']) {
      expect(DAY_CLAIM_RULES.some((r) => r.says(fine)), fine).toBe(false);
    }
    // Comments are not page text.
    expect(one('lib/x.ts', '// open every day, cash only, after midnight\n/** every night */\nconst x = 1;')).toEqual([]);
  });

  it('keeps the list honest: every allowed line is still there', () => {
    for (const [file, text] of ALLOWED) expect(readFileSync(join(SRC, file), 'utf8').includes(text), `${file}: ${text}`).toBe(true);
  });
});
