import { describe, expect, it } from 'vitest';
import {
  BUSINESS_SETTING_READ_SCHEMAS,
  BUSINESS_SETTING_SCHEMAS,
  publishedShopReadSchema,
  publishedShopSchema,
  storedFormatIsNewer,
} from '@cheeseoclock/shared-schemas';
import {
  DEFAULT_SHOP_HOURS,
  DEFAULT_SHOP_PROFILE,
  DEFAULT_SHOP_WEBSITE,
  DEFAULT_WEBSITE_HOME,
  SHOP_PUBLISHED_KEYS,
  type ShopHours,
  type ShopProfile,
  type ShopWebsite,
  type WebsiteHome,
} from '@cheeseoclock/shared-types';
import { buildShopBlock } from '@cheeseoclock/pos-domain';

/**
 * The bounds of the shop's details (sweep B2 + B4): the till's Save
 * (business-settings.ts) and the website's check of the shop block
 * (web-settings.ts publishedShopSchema) are the SAME rules, so a Save always
 * passes the website. Made-up names, numbers and words.
 */

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const profile = (change: Partial<ShopProfile> = {}): ShopProfile => ({ ...copy(DEFAULT_SHOP_PROFILE), name: 'Test Shop', ...change });
const hours = (change: Partial<ShopHours> = {}): ShopHours => ({ ...copy(DEFAULT_SHOP_HOURS), ...change });
const website = (change: Partial<ShopWebsite> = {}): ShopWebsite => ({ ...copy(DEFAULT_SHOP_WEBSITE), ...change });
const home = (change: Partial<WebsiteHome> = {}): WebsiteHome => ({ ...copy(DEFAULT_WEBSITE_HOME), ...change });

/** The first message the key's write schema gives, or null when it saves. */
function saveProblem(key: (typeof SHOP_PUBLISHED_KEYS)[number], value: unknown): string | null {
  const r = BUSINESS_SETTING_SCHEMAS[key].safeParse(value);
  return r.success ? null : (r.error.issues[0]?.message ?? 'refused');
}

const phone = (display: string, e164: string) => ({ display, e164 });

describe('the defaults save, and as a block they pass the website', () => {
  it('each key’s default is a valid Save, and the block of all four passes publishedShopSchema', () => {
    expect(saveProblem('shop.profile', DEFAULT_SHOP_PROFILE)).toBeNull();
    expect(saveProblem('shop.hours', DEFAULT_SHOP_HOURS)).toBeNull();
    expect(saveProblem('shop.website', DEFAULT_SHOP_WEBSITE)).toBeNull();
    expect(saveProblem('website.home', DEFAULT_WEBSITE_HOME)).toBeNull();
    const block = buildShopBlock({
      profile: DEFAULT_SHOP_PROFILE,
      hours: DEFAULT_SHOP_HOURS,
      website: DEFAULT_SHOP_WEBSITE,
      home: DEFAULT_WEBSITE_HOME,
      stamps: [{ version: 1, updatedAt: '2026-10-01T10:00:00.000Z' }, null, null, null],
      deviceId: 'till-test',
    });
    const parsed = publishedShopSchema.safeParse(block);
    expect(parsed.success).toBe(true);
    // Nothing is lost or re-ordered on the way through the website's schema.
    expect(JSON.stringify(parsed.success ? parsed.data : null)).toBe(JSON.stringify(block));
  });
});

describe('shop.profile', () => {
  it('name: 1–40 letters, one line, no spaces at its ends', () => {
    expect(saveProblem('shop.profile', profile({ name: '' }))).toMatch(/can’t be empty/);
    expect(saveProblem('shop.profile', profile({ name: 'x'.repeat(41) }))).toMatch(/40 letters/);
    expect(saveProblem('shop.profile', profile({ name: 'x'.repeat(40) }))).toBeNull();
    expect(saveProblem('shop.profile', profile({ name: 'Test\nShop' }))).toMatch(/one line/);
    expect(saveProblem('shop.profile', profile({ name: ' Test Shop' }))).toMatch(/no spaces at its start or end/);
    expect(saveProblem('shop.profile', profile({ name: 'Test‮Shop' }))).toMatch(/hidden or direction mark/);
  });

  it('tagline: up to 80 letters, may be empty', () => {
    expect(saveProblem('shop.profile', profile({ tagline: '' }))).toBeNull();
    expect(saveProblem('shop.profile', profile({ tagline: 'x'.repeat(81) }))).toMatch(/80 letters/);
  });

  it('the call line: the printed number must dial the number given', () => {
    expect(saveProblem('shop.profile', profile({ phone: phone('0300 1234567', '+923001234567') }))).toBeNull();
    expect(saveProblem('shop.profile', profile({ phone: phone('0300 1234567', '+923001234568') }))).toMatch(/not a Pakistani phone number/);
    expect(saveProblem('shop.profile', profile({ phone: phone('call us', '+923001234567') }))).toMatch(/digits, spaces/);
    expect(saveProblem('shop.profile', profile({ phone: phone('0300 1234567', '923001234567') }))).toMatch(/\+92 and ten digits/);
  });

  it('WhatsApp lines: one to three, each once, each dialling its own number', () => {
    expect(saveProblem('shop.profile', profile({ whatsappLines: [] }))).toMatch(/at least one WhatsApp/);
    const four = ['0300 1111111', '0300 2222222', '0300 3333333', '0300 4444444'].map((d) => phone(d, `+92${d.replace(/\D/g, '').slice(1)}`));
    expect(saveProblem('shop.profile', profile({ whatsappLines: four }))).toMatch(/At most 3/);
    expect(saveProblem('shop.profile', profile({ whatsappLines: four.slice(0, 3) }))).toBeNull();
    expect(saveProblem('shop.profile', profile({ whatsappLines: [four[0]!, phone('+92 300 1111111', '+923001111111')] }))).toMatch(/listed twice/);
  });

  it('social links: https profiles, each at most 200 letters, no spaces, each once, at most six, never the shop’s own site', () => {
    const ok = (socialLinks: string[]) => saveProblem('shop.profile', profile({ socialLinks }));
    expect(ok([])).toBeNull();
    expect(ok(['https://www.instagram.com/test.shop', 'https://www.facebook.com/test.shop'])).toBeNull();
    expect(ok(['http://www.instagram.com/test.shop'])).toMatch(/https/);
    expect(ok(['https://www.instagram.com/test shop'])).toMatch(/spaces/);
    expect(ok(['https://www.instagram.com/Test.Shop', 'https://WWW.instagram.com/test.shop/'])).toMatch(/listed twice/);
    expect(ok(Array.from({ length: 7 }, (_, i) => `https://example.com/p${i}`))).toMatch(/At most 6/);
    expect(ok([`https://example.com/${'p'.repeat(190)}`])).toMatch(/200 letters/);
    expect(ok(['https://www.cheeseoclock.net'])).toMatch(/own website/);
  });

  it('address and price range', () => {
    expect(saveProblem('shop.profile', profile({ address: { street: 'Test Street 1', areaLine: 'Test Area, Karachi', postalCode: '1234' } }))).toMatch(/five digits/);
    expect(saveProblem('shop.profile', profile({ address: { street: '', areaLine: 'Test Area, Karachi', postalCode: '12345' } }))).toMatch(/can’t be empty/);
    expect(saveProblem('shop.profile', profile({ priceRange: 'x'.repeat(31) }))).toMatch(/30 letters/);
    expect(saveProblem('shop.profile', profile({ priceRange: '' }))).toMatch(/can’t be empty/);
  });
});

describe('shop.hours (THE rule: shopHoursProblem)', () => {
  it('refuses a time off the quarter hour, an opening before 5 am, a close at or after 5 am past midnight, equal times, no days', () => {
    expect(saveProblem('shop.hours', hours({ opens: '11:00', closes: '23:00' }))).toBeNull();
    expect(saveProblem('shop.hours', hours({ opens: '12:05' }))).toMatch(/quarter hour/);
    expect(saveProblem('shop.hours', hours({ opens: '04:30' }))).toMatch(/from 5 am/);
    expect(saveProblem('shop.hours', hours({ closes: '05:30' }))).toMatch(/before 5 am/);
    expect(saveProblem('shop.hours', hours({ opens: '12:00', closes: '12:00' }))).toMatch(/can’t be the opening/);
    expect(saveProblem('shop.hours', hours({ days: [] }))).toMatch(/at least one day/);
    expect(saveProblem('shop.hours', hours({ days: ['sun', 'mon'] }))).toMatch(/Monday first/);
  });
});

describe('shop.website', () => {
  it('the greeting: 1–120 letters, one line, words first, ending in ONE space', () => {
    expect(saveProblem('shop.website', website({ whatsappGreeting: 'Hi Test Shop! ' }))).toBeNull();
    expect(saveProblem('shop.website', website({ whatsappGreeting: 'Hi Test Shop!' }))).toMatch(/ends with one space/);
    expect(saveProblem('shop.website', website({ whatsappGreeting: 'Hi Test Shop!  ' }))).toMatch(/ends with one space/);
    expect(saveProblem('shop.website', website({ whatsappGreeting: ' Hi Test Shop! ' }))).toMatch(/no space at its start/);
    expect(saveProblem('shop.website', website({ whatsappGreeting: `${'x'.repeat(120)} ` }))).toMatch(/120 letters/);
    expect(saveProblem('shop.website', website({ whatsappGreeting: 'Hi\nthere ' }))).toMatch(/one line/);
  });

  it('what the rider and the counter take: cash always, known ways only, each once, in the usual order', () => {
    expect(saveProblem('shop.website', website({ doorPayments: ['cash', 'card', 'easypaisa', 'jazzcash', 'bank_transfer'] }))).toBeNull();
    expect(saveProblem('shop.website', website({ doorPayments: ['card'] }))).toMatch(/always includes cash/);
    expect(saveProblem('shop.website', website({ doorPayments: [] }))).toMatch(/includes cash/);
    expect(saveProblem('shop.website', website({ doorPayments: ['cash', 'cheque' as 'card'] }))).toMatch(/cash, card, EasyPaisa/);
    expect(saveProblem('shop.website', website({ doorPayments: ['cash', 'card', 'card'] }))).toMatch(/each one once/);
    expect(saveProblem('shop.website', website({ doorPayments: ['card', 'cash'] }))).toMatch(/usual order/);
    expect(saveProblem('shop.website', website({ pickupPayments: ['easypaisa'] }))).toMatch(/always includes cash/);
  });

  it('the allergy notice: 40–300 letters, never empty', () => {
    expect(saveProblem('shop.website', website({ allergyNotice: '' }))).toMatch(/at least 40/);
    expect(saveProblem('shop.website', website({ allergyNotice: 'x'.repeat(39) }))).toMatch(/at least 40/);
    expect(saveProblem('shop.website', website({ allergyNotice: 'x'.repeat(40) }))).toBeNull();
    expect(saveProblem('shop.website', website({ allergyNotice: 'x'.repeat(301) }))).toMatch(/300 letters/);
  });
});

describe('website.home', () => {
  const e = (name: string, more: Record<string, unknown> = {}) => ({ itemRef: { posItemId: null, name }, ...more });
  it('1–8 pizzas, at most one burger, 0–4 deals; no item twice; a deal takes no headline; words within bounds', () => {
    expect(saveProblem('website.home', home({ pizzas: [] }))).toMatch(/at least one pizza/);
    expect(saveProblem('website.home', home({ pizzas: Array.from({ length: 9 }, (_, i) => e(`Pizza ${i}`)) }))).toMatch(/at most 8 pizzas/);
    expect(saveProblem('website.home', home({ deals: Array.from({ length: 5 }, (_, i) => e(`Deal ${i}`)) }))).toMatch(/at most 4 deals/);
    expect(saveProblem('website.home', home({ burger: null, deals: [] }))).toBeNull();
    expect(saveProblem('website.home', home({ deals: [e('Cheesy Star — Large')] }))).toMatch(/twice/);
    expect(saveProblem('website.home', home({ deals: [e('Test Deal', { headline: 'Test' })] }))).toMatch(/A deal shows no headline/);
    expect(saveProblem('website.home', home({ pizzas: [e('Test Pizza', { headline: 'x'.repeat(61) })] }))).toMatch(/60 letters/);
    expect(saveProblem('website.home', home({ pizzas: [e('Test Pizza', { text: 'x'.repeat(241) })] }))).toMatch(/240 letters/);
    expect(saveProblem('website.home', home({ pizzas: [e('Test Pizza', { headline: '' })] }))).toMatch(/can’t be empty/);
    expect(saveProblem('website.home', home({ pizzas: [e('')] }))).toMatch(/Pick an item/);
    expect(saveProblem('website.home', home({ pizzas: [{ itemRef: { posItemId: 'id-1', name: 'Test Pizza' }, headline: 'Made-up hook', text: 'Made-up words.' }] }))).toBeNull();
  });
});

describe('formats: the write schema is strict, the read schema drops what it does not know (and the card goes read-only)', () => {
  it('an extra field is refused on Save, read past, and marks the value "newer" — top level and nested', () => {
    expect(saveProblem('shop.hours', { ...DEFAULT_SHOP_HOURS, special: true })).not.toBeNull();
    expect(saveProblem('shop.hours', { ...DEFAULT_SHOP_HOURS, v: 2 })).toMatch(/different version/);
    const read = BUSINESS_SETTING_READ_SCHEMAS['shop.hours'].safeParse({ ...DEFAULT_SHOP_HOURS, v: 2, special: true });
    expect(read.success && read.data).toEqual({ ...DEFAULT_SHOP_HOURS, v: 2 });
    expect(storedFormatIsNewer('shop.hours', { ...DEFAULT_SHOP_HOURS, special: true })).toBe(true);
    expect(storedFormatIsNewer('shop.hours', { ...DEFAULT_SHOP_HOURS, v: 2 })).toBe(true);
    expect(storedFormatIsNewer('shop.hours', DEFAULT_SHOP_HOURS)).toBe(false);
    const p = copy(DEFAULT_SHOP_PROFILE) as unknown as Record<string, unknown>;
    expect(storedFormatIsNewer('shop.profile', p)).toBe(false);
    expect(storedFormatIsNewer('shop.profile', { ...p, phone: { ...DEFAULT_SHOP_PROFILE.phone, label: 'x' } })).toBe(true);
    expect(storedFormatIsNewer('shop.profile', { ...p, address: { ...DEFAULT_SHOP_PROFILE.address, geo: 1 } })).toBe(true);
    expect(storedFormatIsNewer('shop.profile', { ...p, whatsappLines: [{ ...DEFAULT_SHOP_PROFILE.phone, hours: 'x' }] })).toBe(true);
    const h = copy(DEFAULT_WEBSITE_HOME) as unknown as Record<string, unknown>;
    expect(storedFormatIsNewer('website.home', h)).toBe(false);
    expect(storedFormatIsNewer('website.home', { ...h, burger: { itemRef: { posItemId: null, name: 'x', size: 'L' } } })).toBe(true);
    expect(storedFormatIsNewer('website.home', { ...h, deals: [{ itemRef: { posItemId: null, name: 'x' }, badge: 'New' }] })).toBe(true);
  });
});

describe('the website reads back a stored block section by section', () => {
  it('a section that does not read falls back to ITS default alone; the stamp and the others stay', () => {
    const block = buildShopBlock({
      profile: profile(),
      hours: hours({ opens: '11:00', closes: '23:00' }),
      website: website(),
      home: home(),
      stamps: [{ version: 3, updatedAt: '2026-10-01T10:00:00.000Z' }, null, null, null],
      deviceId: 'till-test',
    });
    const broken = { ...block, hours: { opens: 'noon', closes: '01:00', days: [] }, extra: 'dropped' };
    expect(publishedShopSchema.safeParse(broken).success).toBe(false);
    const read = publishedShopReadSchema.parse(broken);
    expect(read.hours).toEqual({ opens: '13:00', closes: '01:00', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] });
    expect(read.profile.name).toBe('Test Shop');
    expect(read.shopRev).toBe(3);
    expect(read).not.toHaveProperty('extra');
    // A fresh copy each time, never the frozen default.
    expect(Object.isFrozen(read.hours.days)).toBe(false);
  });
});
