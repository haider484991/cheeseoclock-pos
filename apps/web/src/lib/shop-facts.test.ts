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
import { describe, expect, it } from 'vitest';
import type { PublishedShopHours, PublishedShopWebsite } from '@cheeseoclock/shared-types';
import { cheeseTimeFallback, cheeseTimeLine, karachiClock, nextOpening, openByHours } from './cheese-time';
import { CantPrint, DEFAULT_FACTS, NoMinimumToken, PausedFeeToken, claimHolds, copyText, fillFees, renderCopy, type CopyFacts } from './delivery-facts';
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
        socialLinks: [],
        priceRange: 'PKR 400–2,500',
      },
      hours: { opens: '12:00', closes: '01:00', days: ALL_DAYS },
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
      "12 noon – 1 am | 12 noon | 1 am | daily | Open daily · 12 noon – 1 am | Cheese O'Clock | Cheese O’Clock | 0300 9367865 | 0300 9367865 or 0331 2188295 | Shop 3, Ground Floor, 41-C, Sehar Lane No. 3, Rahat Commercial Area, DHA Phase 6 | Rahat Commercial Area, DHA Phase 6, Karachi | cash | Cash | cash | 15% tax | 15% tax",
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

  it('food at two rates names no number: "tax" / "Tax"; a rate of 0 names none either', () => {
    expect(taxBpsOf(menu(item('a', 'Test Pizza', 1500), item('b', 'Test Drink — 1 litre', 1300)))).toBeNull();
    const words = '{Tax} is added; plus {tax} and';
    expect(fillFees(words, { ...DEFAULT_FACTS, taxBps: null })).toBe('Tax is added; plus tax and');
    expect(fillFees(words, { ...DEFAULT_FACTS, taxBps: 0 })).toBe('Tax is added; plus tax and');
    expect(fillFees(words, { ...DEFAULT_FACTS, taxBps: 1650 })).toBe('16.5% tax is added; plus 16.5% tax and');
    expect(claimHolds({ oneTaxRate: true }, { ...DEFAULT_FACTS, taxBps: null })).toBe(false);
  });
});

describe('the brand line (CheeseTime): by the hours, and by whether the till is taking orders', () => {
  const H = { opens: '12:00', closes: '01:00', days: ALL_DAYS };
  const at = (hh: number, mm = 0) => hh * 60 + mm;
  const words = (o: Partial<Parameters<typeof cheeseTimeLine>[0]>) =>
    cheeseTimeLine({ hours: H, nameIsDefault: true, nameProse: 'Cheese O’Clock', day: 'mon', now: at(20), accepting: null, ...o });

  it('the served line and today’s words by the clock (the status unknown): as before', () => {
    expect(cheeseTimeFallback({ nameIsDefault: true, nameProse: 'Cheese O’Clock' })).toBe('It’s always Cheese O’Clock in DHA.');
    expect(words({ now: at(20, 47) })).toBe('definitely Cheese O’Clock.');
    expect(words({ now: at(0, 30) })).toBe('definitely Cheese O’Clock.');
    expect(words({ now: at(9) })).toBe('we open at 12 noon. Almost Cheese O’Clock.');
    expect(words({ now: at(12) })).toBe('definitely Cheese O’Clock.');
    expect(words({ now: at(1) })).toBe('we open at 12 noon. Almost Cheese O’Clock.');
  });

  it('the till’s status wins: taking orders → open; not taking them inside the hours → say so; outside → when it opens', () => {
    expect(words({ now: at(9), accepting: true })).toBe('definitely Cheese O’Clock.');
    expect(words({ now: at(20), accepting: false })).toBe('the kitchen isn’t taking website orders just now — WhatsApp us.');
    expect(words({ now: at(9), accepting: false })).toBe('we open at 12 noon. Almost Cheese O’Clock.');
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
    expect(cheeseTimeLine({ ...other, day: 'sat', now: at(13), accepting: null })).toBe('we open on Monday at 11:30 am.');
    expect(cheeseTimeLine({ ...other, day: 'mon', now: at(13), accepting: true })).toBe('the kitchen is open.');
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
  ];
  // The logo's own words (the image says them) and the share images' static alt text.
  const NAME_ALLOWED: Array<[string, string]> = [
    ['app/page.tsx', '<span className="sr-only">Cheese O&rsquo;Clock.</span>'],
    ['components/BrandMark.tsx', 'alt="Cheese O\'Clock"'],
    ['components/Logo.tsx', 'Cheese O&rsquo;Clock'],
    ['app/opengraph-image.tsx', '"Cheese O\'Clock — Pizza & Burger Delivery in DHA Karachi"'],
    ['app/delivery/[area]/opengraph-image.tsx', '"Cheese O\'Clock delivery area"'],
    // Sweep B2 (the carousel's lineup from the menu) passes the name to the carousel with it.
    ['components/PizzaCarousel3D.tsx', "pizza from Cheese O'Clock"],
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
    for (const fine of ['{tax} on the bill', '10% off when you order online', 'Tax (est.)']) expect(typesATaxRate(fine), fine).toBe(false);
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
