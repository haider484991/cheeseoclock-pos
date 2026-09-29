import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS_AT,
  DEFAULT_SHOP_HOURS,
  DEFAULT_SHOP_PROFILE,
  DEFAULT_SHOP_WEBSITE,
  DEFAULT_WEBSITE_HOME,
  PUBLISHED_SETTING_KEYS,
  SHOP_DAYS,
  SHOP_PUBLISHED_KEYS,
  SHOP_SETTING_DEFAULTS,
  SHOP_SETTING_FORMAT,
  cashOnly,
  closesAfterMidnight,
  compareShopStamp,
  daysWords,
  everyDay,
  homeDuplicateProblem,
  homeLineup,
  homeMissing,
  homeNameKey,
  hoursLine,
  hoursRange,
  matchHomeItem,
  nameInProse,
  normalizePhone as sharedNormalizePhone,
  opensBy,
  paymentAccepted,
  paymentsWords,
  schemaOrgDays,
  shopBlockTakes,
  shopHoursProblem,
  socialLabel,
  socialLinkProblem,
  telUrl,
  timeWords,
  waLinkWith,
  waUrl,
  type HomeMenuItem,
  type WebsiteHome,
} from '@cheeseoclock/shared-types';
import { buildShopBlock, shopStampOf, websiteNeedsShop } from './shop-block.js';
import { normalizePhone } from './phone.js';

/**
 * The shop's details the website shows (sweep B2 + B4; shared-types
 * website-shop.ts and web-bridge.ts THE SHOP BLOCK). The defaults ARE the
 * website today, byte for byte — released, NEVER edit one (if this fails, put
 * the value back). Everything else here uses made-up names, numbers and
 * prices.
 */
describe('the released defaults are the website today', () => {
  it('shop.profile: today’s name, tagline, call line, both WhatsApp lines, street address, no social profiles, the price range', () => {
    expect(DEFAULT_SHOP_PROFILE).toEqual({
      v: 1,
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
    });
    // Each printed number dials itself, and the first WhatsApp line is today's order link.
    for (const l of [DEFAULT_SHOP_PROFILE.phone, ...DEFAULT_SHOP_PROFILE.whatsappLines]) expect(normalizePhone(l.display)).toBe(l.e164);
    expect(waUrl(DEFAULT_SHOP_PROFILE.whatsappLines[0]!.e164)).toBe('https://wa.me/923009367865');
  });

  it('shop.hours: every day, 12 noon to 1 am — the words the website prints today', () => {
    expect(DEFAULT_SHOP_HOURS).toEqual({ v: 1, opens: '12:00', closes: '01:00', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] });
    expect(hoursLine(DEFAULT_SHOP_HOURS)).toBe('Open daily · 12 noon – 1 am');
    expect(hoursRange(DEFAULT_SHOP_HOURS)).toBe('12 noon – 1 am');
    expect(hoursRange(DEFAULT_SHOP_HOURS).toUpperCase()).toBe('12 NOON – 1 AM');
    expect(schemaOrgDays(DEFAULT_SHOP_HOURS.days)).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
    expect([everyDay(DEFAULT_SHOP_HOURS), closesAfterMidnight(DEFAULT_SHOP_HOURS), opensBy(DEFAULT_SHOP_HOURS, '13:00')]).toEqual([true, true, true]);
    expect(shopHoursProblem(DEFAULT_SHOP_HOURS)).toBeNull();
  });

  it('shop.website: today’s greeting with its trailing space, cash at the door and the counter, the printed menu’s allergy words', () => {
    expect(DEFAULT_SHOP_WEBSITE).toEqual({
      v: 1,
      whatsappGreeting: "Hi Cheese O'Clock! I'd like to place an order: ",
      doorPayments: ['cash'],
      pickupPayments: ['cash'],
      allergyNotice:
        'Allergy? Tell us in the item’s “Allergy or special request” box and we’ll leave ingredients out. Our kitchen shares equipment, so we can’t guarantee any dish is allergen-free.',
    });
    // Today's order link, encoded once (apps/web WA_ORDER_URL before B4).
    expect(waLinkWith('+923009367865', DEFAULT_SHOP_WEBSITE.whatsappGreeting)).toBe(
      'https://wa.me/923009367865?text=Hi%20Cheese%20O\'Clock!%20I\'d%20like%20to%20place%20an%20order%3A%20',
    );
    expect(paymentAccepted(DEFAULT_SHOP_WEBSITE.doorPayments)).toBe('Cash on Delivery');
    expect(cashOnly(DEFAULT_SHOP_WEBSITE.doorPayments)).toBe(true);
  });

  it('website.home: today’s five signature pizzas (Large), the Signature Cheese Dipped burger and the three value deals, with today’s own words (no headline or text)', () => {
    expect(DEFAULT_WEBSITE_HOME).toEqual({
      v: 1,
      pizzas: [
        { itemRef: { posItemId: null, name: 'Cheesy Star — Large' } },
        { itemRef: { posItemId: null, name: 'Crown Crust — Large' } },
        { itemRef: { posItemId: null, name: 'Shawarma Pizza — Large' } },
        { itemRef: { posItemId: null, name: 'Meat Lovers — Large' } },
        { itemRef: { posItemId: null, name: 'Cheetos — Large' } },
      ],
      burger: { itemRef: { posItemId: null, name: 'Signature Cheese Dipped' } },
      deals: [
        { itemRef: { posItemId: null, name: 'Big Two' } },
        { itemRef: { posItemId: null, name: 'Family Feast' } },
        { itemRef: { posItemId: null, name: 'Perfect Pair' } },
      ],
    });
    expect(homeDuplicateProblem(DEFAULT_WEBSITE_HOME)).toBeNull();
  });

  it('each is the key’s registered default, format 1, deeply frozen', () => {
    expect(SHOP_SETTING_DEFAULTS['shop.profile']).toBe(DEFAULT_SHOP_PROFILE);
    expect(SHOP_SETTING_DEFAULTS['shop.hours']).toBe(DEFAULT_SHOP_HOURS);
    expect(SHOP_SETTING_DEFAULTS['shop.website']).toBe(DEFAULT_SHOP_WEBSITE);
    expect(SHOP_SETTING_DEFAULTS['website.home']).toBe(DEFAULT_WEBSITE_HOME);
    for (const key of SHOP_PUBLISHED_KEYS) expect(SHOP_SETTING_FORMAT[key]).toBe(1);
    const frozen = (o: unknown): boolean =>
      o === null || typeof o !== 'object' || (Object.isFrozen(o) && Object.values(o as object).every(frozen));
    for (const d of [DEFAULT_SHOP_PROFILE, DEFAULT_SHOP_HOURS, DEFAULT_SHOP_WEBSITE, DEFAULT_WEBSITE_HOME]) expect(frozen(d)).toBe(true);
  });

  it('the shop block is its own: the settings block’s keys and stamp are exactly as released', () => {
    expect([...SHOP_PUBLISHED_KEYS]).toEqual(['shop.profile', 'shop.hours', 'shop.website', 'website.home']);
    expect([...PUBLISHED_SETTING_KEYS]).toEqual(['delivery.zones', 'discounts.websitePickup', 'online.options']);
  });
});

describe('the phone rule lives in shared-types (the shop-details schemas use it); pos-domain re-exports the same function', () => {
  it('is one function', () => {
    expect(normalizePhone).toBe(sharedNormalizePhone);
    expect(normalizePhone('0300 1234567')).toBe('+923001234567');
    expect(normalizePhone('hello')).toBeNull();
  });
});

describe('hours in words', () => {
  it('times: noon, midnight, am, pm, quarter hours', () => {
    expect(['12:00', '00:00', '01:00', '13:30', '23:00', '12:30', '00:15', '11:45', '05:00'].map(timeWords)).toEqual([
      '12 noon',
      'midnight',
      '1 am',
      '1:30 pm',
      '11 pm',
      '12:30 pm',
      '12:15 am',
      '11:45 am',
      '5 am',
    ]);
  });

  it('11 am – 11 pm: no "past midnight"; closing at midnight is not after it; a 2 am close is', () => {
    const h = { opens: '11:00', closes: '23:00', days: [...SHOP_DAYS] };
    expect(hoursLine(h)).toBe('Open daily · 11 am – 11 pm');
    expect(closesAfterMidnight(h)).toBe(false);
    expect(closesAfterMidnight({ closes: '00:00' })).toBe(false);
    expect(closesAfterMidnight({ closes: '02:00' })).toBe(true);
    expect(opensBy({ opens: '14:00' }, '13:00')).toBe(false);
  });

  it('days: "daily" only for all seven; runs of three or more as a range; JSON-LD names Monday first', () => {
    expect(daysWords(['mon', 'tue', 'wed', 'thu', 'fri', 'sat'])).toBe('Mon–Sat');
    expect(daysWords(['tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).toBe('Tue–Sun');
    expect(daysWords(['mon', 'tue', 'thu', 'fri', 'sat', 'sun'])).toBe('Mon, Tue, Thu–Sun');
    expect(daysWords(['sat', 'sun'])).toBe('Sat, Sun');
    const noMonday = { opens: '12:00', closes: '01:00', days: ['tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as typeof SHOP_DAYS[number][] };
    expect(everyDay(noMonday)).toBe(false);
    expect(hoursLine(noMonday)).toBe('Open Tue–Sun · 12 noon – 1 am');
    expect(hoursLine(noMonday)).not.toMatch(/daily/);
    expect(schemaOrgDays(noMonday.days)).not.toContain('Monday');
  });

  it('THE rule: quarter hours; opens from 5 am; closes later that day or after midnight before 5 am; never equal; days each once, Monday first', () => {
    const all = [...SHOP_DAYS];
    const ok = (opens: string, closes: string, days: string[] = all) => shopHoursProblem({ opens, closes, days: days as typeof all });
    expect(ok('12:00', '01:00')).toBeNull();
    expect(ok('11:00', '23:45')).toBeNull();
    expect(ok('11:00', '00:00')).toBeNull();
    expect(ok('05:00', '04:45')).toBeNull();
    expect(ok('04:45', '23:00')).toMatch(/from 5 am/);
    expect(ok('12:10', '01:00')).toMatch(/quarter hour/);
    expect(ok('12:00', '1:00')).toMatch(/quarter hour/);
    expect(ok('12:00', '05:00')).toMatch(/before 5 am/);
    expect(ok('12:00', '11:00')).toMatch(/before 5 am/);
    expect(ok('12:00', '12:00')).toMatch(/can’t be the opening/);
    expect(ok('12:00', '01:00', [])).toMatch(/at least one day/);
    expect(ok('12:00', '01:00', ['mon', 'mon'])).toMatch(/once/);
    expect(ok('12:00', '01:00', ['tue', 'mon'])).toMatch(/Monday first/);
    expect(ok('12:00', '01:00', ['someday'])).toMatch(/not a day/);
  });
});

describe('payments in words (website words only)', () => {
  it('cash alone is today’s "Cash on Delivery" exactly; more are listed after it', () => {
    expect(paymentAccepted(['cash', 'card', 'easypaisa', 'jazzcash'])).toBe('Cash on Delivery, Card, EasyPaisa, JazzCash');
    expect(paymentAccepted(['cash', 'bank_transfer'])).toBe('Cash on Delivery, Bank transfer');
    expect(paymentsWords(['cash'])).toBe('cash');
    expect(paymentsWords(['cash', 'card'])).toBe('cash or card');
    expect(paymentsWords(['cash', 'card', 'easypaisa'])).toBe('cash, card or EasyPaisa');
    expect(cashOnly(['cash', 'card'])).toBe(false);
  });
});

describe('names and links', () => {
  it('the name in prose takes a curly apostrophe; wa.me and tel: links from the number', () => {
    expect(nameInProse("Test O'Pizza")).toBe('Test O’Pizza');
    expect(waUrl('+923001234567')).toBe('https://wa.me/923001234567');
    expect(telUrl('+923001234567')).toBe('tel:+923001234567');
    expect(waLinkWith('+923001234567', 'Hi & hello: ')).toBe('https://wa.me/923001234567?text=Hi%20%26%20hello%3A%20');
  });

  it('social links: https profiles only, never the shop’s own site; labelled by their host', () => {
    expect(socialLinkProblem('https://www.instagram.com/test.shop')).toBeNull();
    expect(socialLinkProblem('http://instagram.com/test')).toMatch(/https/);
    expect(socialLinkProblem('https://insta gram.com/x')).toMatch(/spaces/);
    expect(socialLinkProblem('https://www.cheeseoclock.net/menu')).toMatch(/own website/);
    expect(socialLinkProblem('https://shop.cheeseoclock.net')).toMatch(/own website/);
    expect(socialLinkProblem(`https://example.com/${'x'.repeat(200)}`)).toMatch(/200/);
    expect(socialLinkProblem('https://localhost')).toMatch(/web address/);
    expect(
      ['https://www.instagram.com/t', 'https://m.facebook.com/t', 'https://fb.me/t', 'https://www.tiktok.com/@t', 'https://youtu.be/t', 'https://www.foodpanda.pk/restaurant/t', 'https://x.com/t', 'https://example.org/t'].map(socialLabel),
    ).toEqual(['Instagram', 'Facebook', 'Facebook', 'TikTok', 'YouTube', 'foodpanda', 'X', 'example.org']);
  });
});

// ---------------------------------------------------------------------------
// The home lineup matcher (made-up menu, ids and prices)
// ---------------------------------------------------------------------------

const item = (posItemId: string, name: string, basePriceCents: number, sortOrder = 0): HomeMenuItem => ({ posItemId, name, basePriceCents, sortOrder });
const menu = () => ({
  categories: [
    { displayOrder: 2, items: [item('d-1', 'Test Deal', 300_000), item('fee-1', 'Delivery Charge (Rs 200)', 20_000)] },
    {
      displayOrder: 1,
      items: [
        item('p-2', 'Test Star — Large', 123_400, 2),
        item('p-1', 'Test Star — Medium', 99_900, 1),
        item('p-3', 'Zero Pizza — Large', 0, 3),
      ],
    },
    { displayOrder: 3, items: [item('p-9', 'Test Star — Large', 555_500)] },
  ],
});
const entry = (name: string, posItemId: string | null = null) => ({ itemRef: { posItemId, name } });

describe('the home lineup: one matcher for the website and the till’s Home card', () => {
  it('matches by name — base and size, whatever the case, spaces, dash or apostrophe — the first in menu order', () => {
    expect(homeNameKey('Test Star — Large')).toBe(homeNameKey('  test  STAR – large '));
    expect(homeNameKey("Chef's Pick")).toBe(homeNameKey('Chef’s Pick'));
    expect(homeNameKey('Test Star — Large')).not.toBe(homeNameKey('Test Star — Medium'));
    expect(homeNameKey('Test Star')).not.toBe(homeNameKey('Test Star — Large'));
    // Category 1 comes before category 3, whatever order they arrive in.
    expect(matchHomeItem(entry('test star — LARGE').itemRef, menu())?.posItemId).toBe('p-2');
  });

  it('by posItemId first; a missing id falls back to the name', () => {
    expect(matchHomeItem(entry('Test Star — Large', 'p-9').itemRef, menu())?.posItemId).toBe('p-9');
    expect(matchHomeItem(entry('Test Star — Large', 'gone').itemRef, menu())?.posItemId).toBe('p-2');
  });

  it('missing: not on the menu, priced at Rs 0, or a delivery charge — never a card at Rs 0', () => {
    expect(matchHomeItem(entry('Nothing Here').itemRef, menu())).toBeNull();
    expect(matchHomeItem(entry('Zero Pizza — Large').itemRef, menu())).toBeNull();
    expect(matchHomeItem(entry('whatever', 'p-3').itemRef, menu())).toBeNull();
    expect(matchHomeItem(entry('Delivery Charge (Rs 200)').itemRef, menu())).toBeNull();
    expect(matchHomeItem(entry('x', 'fee-1').itemRef, menu(), new Set(['fee-1']))).toBeNull();
  });

  it('homeMissing names the missing entries, pizzas then the burger then the deals; [] when all are found', () => {
    const home: Pick<WebsiteHome, 'pizzas' | 'burger' | 'deals'> = {
      pizzas: [entry('Test Star — Large'), entry('Gone Pizza — Large')],
      burger: entry('Gone Burger'),
      deals: [entry('Test Deal'), entry('Gone Deal')],
    };
    expect(homeMissing(home, menu())).toEqual(['Gone Pizza — Large', 'Gone Burger', 'Gone Deal']);
    const l = homeLineup(home, menu());
    expect(l.pizzas.map((e) => e.item?.posItemId ?? null)).toEqual(['p-2', null]);
    expect(l.deals[0]!.item?.basePriceCents).toBe(300_000);
    expect(homeMissing({ pizzas: [entry('Test Star — Medium')], burger: null, deals: [] }, menu())).toEqual([]);
  });

  it('the same item twice is refused (by id, or by name)', () => {
    expect(homeDuplicateProblem({ pizzas: [entry('A', 'x'), entry('B', 'x')], burger: null, deals: [] })).toMatch(/twice/);
    expect(homeDuplicateProblem({ pizzas: [entry('Test Star — Large')], burger: null, deals: [entry('test star – large')] })).toMatch(/twice/);
    expect(homeDuplicateProblem({ pizzas: [entry('A'), entry('B')], burger: entry('C'), deals: [entry('D')] })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The stamp, the website's rule, and the block
// ---------------------------------------------------------------------------

const T1 = '2026-10-01T10:00:00.000Z';
const T2 = '2026-10-01T11:00:00.000Z';

describe('the shop stamp is THE STAMP of the settings block, over the four keys', () => {
  it('nothing saved: rev 0 at the epoch; saved rows add up', () => {
    expect(shopStampOf([null, null, null, null])).toEqual({ shopRev: 0, shopAt: DEFAULT_SETTINGS_AT, shopTie: 0 });
    expect(shopStampOf([{ version: 2, updatedAt: T1 }, null, { version: 1, updatedAt: T2 }, null])).toEqual({
      shopRev: 3,
      shopAt: T2,
      shopTie: Date.parse(T1) + Date.parse(T2),
    });
  });

  it('the website’s rule (shopBlockTakes): newer or equal takes; older is ignored unless it is the same till’s later Save', () => {
    const held = { shopRev: 3, shopAt: T2, shopTie: 10, deviceId: 'till-a' };
    expect(shopBlockTakes({ shopRev: 4, shopAt: T1, shopTie: 1, deviceId: 'till-b' }, held)).toBe(true);
    expect(shopBlockTakes({ ...held, deviceId: 'till-b' }, held)).toBe(true);
    expect(shopBlockTakes({ shopRev: 2, shopAt: T2, shopTie: 10, deviceId: 'till-b' }, held)).toBe(false);
    expect(shopBlockTakes({ shopRev: 2, shopAt: '2026-10-01T12:00:00.000Z', shopTie: 1, deviceId: 'till-a' }, held)).toBe(true);
    expect(shopBlockTakes({ shopRev: 1, shopAt: T1, shopTie: 1, deviceId: 'till-a' }, null)).toBe(true);
    expect(compareShopStamp({ shopRev: 1, shopAt: T1 }, { shopRev: 1, shopAt: T2 })).toBeLessThan(0);
  });

  it('websiteNeedsShop: never with nothing saved; yes with none held or an older one; no for the same or the other till’s newer one; yes for this till’s own later Save', () => {
    const local = { shopRev: 2, shopAt: T2, shopTie: 5 };
    expect(websiteNeedsShop({ shopRev: 0, shopAt: DEFAULT_SETTINGS_AT, shopTie: 0 }, null, 'till-a')).toBe(false);
    expect(websiteNeedsShop(local, null, 'till-a')).toBe(true);
    expect(websiteNeedsShop(local, { stamp: { shopRev: 1, shopAt: T1, shopTie: 1 }, deviceId: 'till-b' }, 'till-a')).toBe(true);
    expect(websiteNeedsShop(local, { stamp: local, deviceId: 'till-b' }, 'till-a')).toBe(false);
    expect(websiteNeedsShop(local, { stamp: { shopRev: 5, shopAt: T1, shopTie: 1 }, deviceId: 'till-b' }, 'till-a')).toBe(false);
    expect(websiteNeedsShop(local, { stamp: { shopRev: 5, shopAt: T1, shopTie: 1 }, deviceId: 'till-a' }, 'till-a')).toBe(true);
  });

  it('the block: all four sections without their format, fresh copies, stamped and signed', () => {
    const block = buildShopBlock({
      profile: { ...DEFAULT_SHOP_PROFILE, name: 'Test Shop' },
      hours: DEFAULT_SHOP_HOURS,
      website: DEFAULT_SHOP_WEBSITE,
      home: { v: 1, pizzas: [{ itemRef: { posItemId: 'p-1', name: 'Test Star — Large' }, headline: 'Made-up hook' }], burger: null, deals: [] },
      stamps: [{ version: 1, updatedAt: T1 }, null, null, null],
      deviceId: 'till-a',
    });
    expect(block).toEqual({
      v: 1,
      shopRev: 1,
      shopAt: T1,
      shopTie: Date.parse(T1),
      deviceId: 'till-a',
      profile: { ...(({ v: _v, ...p }) => p)(DEFAULT_SHOP_PROFILE), name: 'Test Shop' },
      hours: { opens: '12:00', closes: '01:00', days: [...SHOP_DAYS] },
      website: (({ v: _v, ...w }) => w)(DEFAULT_SHOP_WEBSITE),
      home: { pizzas: [{ itemRef: { posItemId: 'p-1', name: 'Test Star — Large' }, headline: 'Made-up hook' }], burger: null, deals: [] },
    });
    // No `v` inside a section, nothing shared with the frozen defaults, and a headline left out stays out (no undefined key).
    expect(JSON.stringify(block.home)).not.toMatch(/"text"/);
    expect(block.profile.whatsappLines).not.toBe(DEFAULT_SHOP_PROFILE.whatsappLines);
    expect(Object.isFrozen(block.hours.days)).toBe(false);
  });
});
