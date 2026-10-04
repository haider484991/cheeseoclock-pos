import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHOP_HOURS,
  DEFAULT_SHOP_PROFILE,
  DEFAULT_SHOP_WEBSITE,
  DEFAULT_WEBSITE_HOME,
  type Category,
  type Cents,
  type MenuItem,
  type UUID,
  type ShopProfile,
  type ShopSettingCard,
  type ShopWebsite,
} from '@cheeseoclock/shared-types';
import {
  OPENING_TIMES,
  SHOP_CARD_FIELDS,
  allergyFromForm,
  allergyLacksGuarantee,
  WEBSITE_SHOP_WORDS,
  cardPart,
  closesLabel,
  closingTimes,
  contactFromForm,
  contactSummary,
  contactToForm,
  googleListingChanges,
  greetingFromForm,
  greetingLink,
  greetingNameNote,
  greetingOf,
  greetingToForm,
  homeFromForm,
  homeMissingHere,
  homeMissingWords,
  homePreview,
  homeSummary,
  hoursEffects,
  hoursFromForm,
  menuPriceHint,
  moved,
  paymentsEffect,
  paymentsFromForm,
  pickableItems,
  pickedEntry,
  shopDetailsFromForm,
  shopDetailsToForm,
  togglePayment,
  withWords,
} from './websiteShopForm';
import { homeMissingSentence, publishedToast, shopNotOnWebsiteSentence } from './publishWords';
import { SHOP_DETAILS_WORDS, settingsPublishWords } from './deliveryZonesForm';

/**
 * Settings → Shop & logo → "Website: shop details (both tills)": what is
 * typed ↔ the four keys, each card's part of a shared key, the preview of
 * the home page (THE matcher the website uses), and the words. Made-up
 * names, numbers, items and prices.
 */

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const T1 = '2026-10-01T10:00:00.000Z';
const T2 = '2026-10-01T11:00:00.000Z';

function cardOf<K extends 'shop.profile' | 'shop.website'>(
  key: K,
  value: ShopSettingCard<K>['value'],
  history: Array<{ at: string; value: ShopSettingCard<K>['value'] | null }> = [],
): ShopSettingCard<K> {
  return {
    key,
    value,
    defaultValue: value,
    isDefault: false,
    readOnly: false,
    lastChanged: history[0] ? { at: history[0].at, byName: 'Test Owner', onThisTill: true } : null,
    notOnOtherTillYet: false,
    history: history.map((h) => ({ at: h.at, byName: 'Test Owner', onThisTill: true, value: h.value })),
  } as ShopSettingCard<K>;
}

describe('one card’s part of a shared key (B1’s part helpers, for any key)', () => {
  const renamed: ShopProfile = { ...copy(DEFAULT_SHOP_PROFILE), name: 'Test Shop' };
  const linked: ShopProfile = { ...renamed, socialLinks: ['https://www.instagram.com/test.shop'] };

  it('each card is its own default, puts back ITS fields only, and shows only the saves that changed them', () => {
    // Saved: first the name (Shop details), then a social link (WhatsApp & social).
    const card = cardOf('shop.profile', linked, [
      { at: T2, value: linked },
      { at: T1, value: renamed },
    ]);
    const details = cardPart(card, SHOP_CARD_FIELDS.details);
    const contact = cardPart(card, SHOP_CARD_FIELDS.contact);
    expect([details.isDefault, contact.isDefault]).toEqual([false, false]);
    expect(details.history.map((h) => h.at)).toEqual([T1]);
    expect(contact.history.map((h) => h.at)).toEqual([T2]);
    expect(details.lastChanged?.at).toBe(T1);
    // "Put back the default" of Shop details keeps the social link; of the links, keeps the name.
    expect(details.defaultValue).toEqual({ ...linked, name: DEFAULT_SHOP_PROFILE.name });
    expect(contact.defaultValue).toEqual({ ...renamed, socialLinks: [] });
    // Only the name saved: the links card is at its default, never changed.
    const onlyName = cardPart(cardOf('shop.profile', renamed, [{ at: T1, value: renamed }]), SHOP_CARD_FIELDS.contact);
    expect(onlyName).toMatchObject({ isDefault: true, lastChanged: null, history: [] });
  });

  it('a card’s Save keeps the other cards’ fields exactly as saved', () => {
    const saved: ShopWebsite = { ...copy(DEFAULT_SHOP_WEBSITE), doorPayments: ['cash', 'card'], allergyNotice: 'x'.repeat(50) };
    const r = greetingFromForm('Hi Test Shop!', saved);
    expect(r.value).toEqual({ ...saved, whatsappGreeting: 'Hi Test Shop! ' });
  });
});

describe('Shop details', () => {
  it('reads what is typed, the phone dialled as typed; a number that is not Pakistani is refused in words', () => {
    const f = { ...shopDetailsToForm(DEFAULT_SHOP_PROFILE), name: '  Test Shop ', phone: '+92 300 1234567' };
    const r = shopDetailsFromForm(f, DEFAULT_SHOP_PROFILE);
    expect(r.value).toMatchObject({ v: 1, name: 'Test Shop', phone: { display: '+92 300 1234567', e164: '+923001234567' } });
    // The other card's fields as saved.
    expect(r.value?.whatsappLines).toEqual(DEFAULT_SHOP_PROFILE.whatsappLines);
    expect(shopDetailsFromForm({ ...f, phone: '12345' }, DEFAULT_SHOP_PROFILE)).toMatchObject({ value: null, problem: expect.stringMatching(/Pakistan/) });
    expect(shopDetailsFromForm({ ...f, name: '' }, DEFAULT_SHOP_PROFILE)).toMatchObject({ value: null, problem: expect.stringMatching(/can’t be empty/) });
    expect(shopDetailsFromForm({ ...f, postalCode: '7550' }, DEFAULT_SHOP_PROFILE).problem).toMatch(/five digits/);
  });

  it('names what the Google listing must follow: the name, the phone, the address — not the tagline or the price range', () => {
    const next = { ...copy(DEFAULT_SHOP_PROFILE), name: 'Test Shop', address: { ...DEFAULT_SHOP_PROFILE.address, postalCode: '12345' } };
    expect(googleListingChanges(DEFAULT_SHOP_PROFILE, next)).toEqual(['the name', 'the address']);
    expect(googleListingChanges(DEFAULT_SHOP_PROFILE, { ...copy(DEFAULT_SHOP_PROFILE), tagline: 'Test', priceRange: 'PKR 1–2' })).toEqual([]);
  });

  it('the price-range hint reads the menu going to the website', () => {
    expect(menuPriceHint([30_000, 0, 360_000, 90_000])).toBe('Your menu on the website: Rs 300 to Rs 3,600.');
    expect(menuPriceHint([])).toBeNull();
  });
});

describe('Opening hours', () => {
  it('opens from 5 am; closes after the opening time or after midnight before 5 am; days saved Monday first', () => {
    expect(OPENING_TIMES[0]).toBe('05:00');
    expect(OPENING_TIMES[OPENING_TIMES.length - 1]).toBe('23:45');
    const closes = closingTimes('12:00');
    expect(closes[0]).toBe('12:15');
    expect(closes).toContain('00:00');
    expect(closes).toContain('04:45');
    expect(closes).not.toContain('05:00');
    expect(closes).not.toContain('11:45');
    const r = hoursFromForm({ opens: '11:00', closes: '23:00', days: ['sun', 'mon', 'sat'] }, DEFAULT_SHOP_HOURS);
    expect(r.value).toEqual({ v: 1, opens: '11:00', closes: '23:00', days: ['mon', 'sat', 'sun'] });
    expect(hoursFromForm({ opens: '12:00', closes: '01:00', days: [] }, DEFAULT_SHOP_HOURS).problem).toMatch(/at least one day/);
  });

  it('the Closes list calls a time "after midnight" only when the website does: midnight itself is not (its late-night warning agrees)', () => {
    expect(closesLabel('00:00')).toBe('midnight');
    expect(hoursEffects({ ...DEFAULT_SHOP_HOURS, closes: '00:00' }).join(' ')).toMatch(/needs a closing time after midnight/);
    expect(closesLabel('00:15')).toBe('12:15 am (after midnight)');
    expect(closesLabel('01:00')).toBe('1 am (after midnight)');
    expect(closesLabel('04:45')).toBe('4:45 am (after midnight)');
    expect(closesLabel('23:45')).toBe('11:45 pm');
    // The card's list is these words.
    const cards = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'WebsiteShopSettings.tsx'), 'utf8');
    expect(cards).toContain('{closesLabel(t)}');
    expect(cards).not.toMatch(/'\s*\(after midnight\)'/);
  });

  it('says what else follows: no "daily", no late night, no lunch — and nothing for today’s hours', () => {
    expect(hoursEffects(DEFAULT_SHOP_HOURS)).toEqual([]);
    const effects = hoursEffects({ opens: '14:00', closes: '23:00', days: ['mon', 'tue'] });
    expect(effects).toHaveLength(3);
    expect(effects.join(' ')).toMatch(/daily/);
    expect(effects.join(' ')).toMatch(/after midnight/);
    expect(effects.join(' ')).toMatch(/lunch/);
  });
});

describe('Payments at the door (website words only)', () => {
  it('cash stays ticked; the list is saved in the usual order; the words follow', () => {
    expect(togglePayment(['cash'], 'cash')).toEqual(['cash']);
    expect(togglePayment(['cash'], 'jazzcash')).toEqual(['cash', 'jazzcash']);
    expect(togglePayment(['cash', 'jazzcash'], 'card')).toEqual(['cash', 'card', 'jazzcash']);
    expect(togglePayment(['cash', 'card'], 'card')).toEqual(['cash']);
    const r = paymentsFromForm({ door: ['jazzcash', 'card'], pickup: [] }, DEFAULT_SHOP_WEBSITE);
    expect(r.value).toMatchObject({ doorPayments: ['cash', 'card', 'jazzcash'], pickupPayments: ['cash'] });
    expect(paymentsEffect(DEFAULT_SHOP_WEBSITE)).toMatch(/cash to the rider \(as today\)/);
    expect(paymentsEffect(r.value!)).toMatch(/stops saying “cash only”.*cash, card or JazzCash.*Cash on Delivery, Card, JazzCash/);
  });
});

describe('WhatsApp numbers & social links', () => {
  it('each number dialled as typed; empty rows left out; a bad number or link is refused in words', () => {
    const f = { ...contactToForm(DEFAULT_SHOP_PROFILE), lines: ['0300 1234567', '  '], links: ['https://www.instagram.com/test.shop', ''] };
    const r = contactFromForm(f, DEFAULT_SHOP_PROFILE);
    expect(r.value).toMatchObject({
      whatsappLines: [{ display: '0300 1234567', e164: '+923001234567' }],
      socialLinks: ['https://www.instagram.com/test.shop'],
      // Shop details as saved.
      name: DEFAULT_SHOP_PROFILE.name,
    });
    expect(contactSummary(r.value!)).toBe('WhatsApp 0300 1234567; Instagram');
    expect(contactFromForm({ ...f, lines: ['hello'] }, DEFAULT_SHOP_PROFILE).problem).toMatch(/not a Pakistani phone number/);
    expect(contactFromForm({ ...f, lines: [] }, DEFAULT_SHOP_PROFILE).problem).toMatch(/at least one WhatsApp/);
    expect(contactFromForm({ ...f, links: ['http://example.com/x'] }, DEFAULT_SHOP_PROFILE).problem).toMatch(/https/);
  });
});

describe('WhatsApp greeting', () => {
  it('the box shows it without its space; the till saves it with ONE; the link encodes it once', () => {
    expect(greetingToForm(DEFAULT_SHOP_WEBSITE)).toBe("Hi Cheese O'Clock! I'd like to place an order:");
    expect(greetingOf('  Hi Test Shop!   ')).toBe('Hi Test Shop! ');
    // Today's greeting typed back is today's greeting exactly (the trailing space kept).
    expect(greetingFromForm(greetingToForm(DEFAULT_SHOP_WEBSITE), DEFAULT_SHOP_WEBSITE).value).toEqual(DEFAULT_SHOP_WEBSITE);
    expect(greetingFromForm('   ', DEFAULT_SHOP_WEBSITE).problem).toMatch(/Type the WhatsApp greeting/);
    expect(greetingFromForm('Hi‮There', DEFAULT_SHOP_WEBSITE).problem).toMatch(/direction mark/);
    expect(greetingLink('Hi & hello! ', { whatsappLines: [{ display: '0300 1234567', e164: '+923001234567' }] })).toBe(
      'https://wa.me/923001234567?text=Hi%20%26%20hello!%20',
    );
    expect(greetingLink('Hi ', { whatsappLines: [] })).toBeNull();
  });

  it('a greeting still naming today’s shop under another name: the card says so for as long as it lasts', () => {
    const today = DEFAULT_SHOP_WEBSITE.whatsappGreeting;
    expect(greetingNameNote(today, DEFAULT_SHOP_PROFILE.name)).toBeNull();
    expect(greetingNameNote(today, 'Cheese O’Clock')).toBeNull();
    expect(greetingNameNote(today, 'Test Crust Co')).toBe(
      'The greeting still says “Cheese O’Clock”, but the shop’s name is now “Test Crust Co” (Shop details): change the greeting too.',
    );
    // Typed with a curly apostrophe or other spaces, it is still today's name.
    expect(greetingNameNote('Hi cheese o’clock!  Order please ', 'Test Crust Co')).toMatch(/still says/);
    expect(greetingNameNote('Hi Test Crust Co! Order please ', 'Test Crust Co')).toBeNull();
    // The card shows it (from Shop details' saved name), not only while the name is being typed.
    const cards = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'WebsiteShopSettings.tsx'), 'utf8');
    expect(cards).toContain('greetingNameNote(greeting, shopName)');
    expect(cards).toContain('shopName={profile.q.data?.value.name ?? null}');
    expect(cards).toContain('{nameNote && <GoogleNote>{nameNote}</GoogleNote>}');
  });
});

describe('Allergy notice', () => {
  it('at least 40 letters; the card warns when the "can’t guarantee" words are gone', () => {
    expect(allergyFromForm('Too short.', DEFAULT_SHOP_WEBSITE).problem).toMatch(/at least 40/);
    expect(allergyFromForm(DEFAULT_SHOP_WEBSITE.allergyNotice, DEFAULT_SHOP_WEBSITE).value).toEqual(DEFAULT_SHOP_WEBSITE);
    expect(allergyLacksGuarantee(DEFAULT_SHOP_WEBSITE.allergyNotice)).toBe(false);
    expect(allergyLacksGuarantee('Allergy? Tell us in the box and we leave things out of your food.')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The Home page card (made-up menu)
// ---------------------------------------------------------------------------

const cat = (id: string, name: string, displayOrder: number, more: Partial<Category> = {}): Category => ({
  id: id as UUID,
  name,
  displayOrder,
  colorHex: '#aa5500',
  isActive: true,
  isOnWebsite: true,
  ...more,
});
const item = (id: string, categoryId: string, name: string, basePriceCents: number, more: Partial<MenuItem> = {}): MenuItem => ({
  id: id as UUID,
  categoryId: categoryId as UUID,
  name,
  description: null,
  basePriceCents: basePriceCents as Cents,
  sku: null,
  barcode: null,
  imageUrl: null,
  isActive: true,
  prepStation: 'kitchen',
  taxCategoryId: 'tax' as UUID,
  sortOrder: 0,
  currentStock: null,
  lowStockThreshold: null,
  webAvailability: 'on',
  ...more,
});
const cats = [cat('c-pizza', 'Test Pizzas', 1), cat('c-off', 'Test Hidden', 2, { isOnWebsite: false }), cat('c-fees', 'Delivery Charges', 3), cat('c-deal', 'Test Deals', 0)];
const menuItems = [
  item('p-1', 'c-pizza', 'Test Star — Large', 123_400, { sortOrder: 2 }),
  item('p-2', 'c-pizza', 'Test Crown — Large', 99_900, { sortOrder: 1 }),
  item('p-3', 'c-pizza', 'Test Pickup Pizza', 50_000, { webAvailability: 'pickup_only', sortOrder: 3 }),
  item('p-4', 'c-pizza', 'Test Off Pizza', 50_000, { webAvailability: 'off' }),
  item('p-5', 'c-pizza', 'Test Hidden Pizza', 50_000, { isActive: false }),
  item('p-6', 'c-off', 'Test Category Off', 50_000),
  item('fee-1', 'c-fees', 'Delivery Charge (Rs 200)', 20_000),
  item('fee-2', 'c-fees', 'Test Area Fee', 25_000),
  item('d-1', 'c-deal', 'Test Deal', 300_000),
  // On the website at Rs 0 (priced only by its choices): the website never features it.
  item('p-7', 'c-pizza', 'Test Zero Pizza', 0),
];
const pickable = pickableItems(menuItems, cats, new Set(['fee-2']));

describe('the Home page card: only items on the website, never a delivery charge', () => {
  it('lists what the next publish sends (pick-up only too), in the menu’s order — not items off the website, hidden, at Rs 0, or delivery charges', () => {
    expect(pickable.map((i) => i.id)).toEqual(['d-1', 'p-2', 'p-1', 'p-3']);
    expect(pickable.some((i) => i.priceCents === 0)).toBe(false);
    expect(pickable[0]).toMatchObject({ name: 'Test Deal', priceCents: 300_000, categoryName: 'Test Deals' });
  });

  it('previews with THE matcher: by id, else by name — and names what is missing (its card is left off)', () => {
    const home = {
      pizzas: [pickedEntry(pickable[2]!), { itemRef: { posItemId: null, name: 'test crown – LARGE' } }, { itemRef: { posItemId: null, name: 'Gone Pizza' } }],
      burger: { itemRef: { posItemId: 'p-4', name: 'Test Off Pizza' } },
      deals: [{ itemRef: { posItemId: 'gone-id', name: 'Test Deal' } }],
    };
    const p = homePreview(home, pickable);
    expect(p.pizzas.map((e) => e.item?.id ?? null)).toEqual(['p-1', 'p-2', null]);
    expect(p.burger?.item).toBeNull();
    expect(p.deals[0]!.item?.id).toBe('d-1');
    expect(homeMissingHere(home, pickable)).toEqual(['Gone Pizza', 'Test Off Pizza']);
    expect(homeMissingWords(['Gone Pizza', 'Test Off Pizza'])).toMatch(/left off the home page: “Gone Pizza” and “Test Off Pizza”/);
    // An item on the website at Rs 0 is left off too: the words say "at a price", never only "not on the website".
    expect(homePreview({ pizzas: [{ itemRef: { posItemId: 'p-7', name: 'Test Zero Pizza' } }], burger: null, deals: [] }, pickable).pizzas[0]!.item).toBeNull();
    expect(homeMissingWords(['Test Zero Pizza'])).toMatch(/^Not on the website’s menu at a price, so left off the home page: “Test Zero Pizza”\. Put the item on the website with its price/);
    expect(homeMissingWords([])).toBeNull();
    // Today's lineup against this made-up menu: all missing.
    expect(homeMissingHere(DEFAULT_WEBSITE_HOME, pickable)).toHaveLength(9);
  });

  it('a pick stores the item’s id and its till name; the words typed are kept as typed and trimmed on Save; empty = the website’s own', () => {
    const e = pickedEntry(pickable[1]!, { headline: 'Made-up hook' });
    expect(e).toEqual({ itemRef: { posItemId: 'p-2', name: 'Test Crown — Large' }, headline: 'Made-up hook' });
    const typing = withWords(e, { text: 'Made up words ' });
    expect(typing.text).toBe('Made up words ');
    const cleared = withWords(typing, { headline: '' });
    expect(cleared).not.toHaveProperty('headline');
    const r = homeFromForm({ pizzas: [typing, pickedEntry(pickable[2]!, { text: '   ' })], burger: null, deals: [] }, DEFAULT_WEBSITE_HOME);
    expect(r.value).toEqual({
      v: 1,
      pizzas: [
        { itemRef: { posItemId: 'p-2', name: 'Test Crown — Large' }, headline: 'Made-up hook', text: 'Made up words' },
        { itemRef: { posItemId: 'p-1', name: 'Test Star — Large' } },
      ],
      burger: null,
      deals: [],
    });
    expect(homeSummary(r.value!)).toBe('2 pizzas, no burger, 0 deals');
    expect(homeSummary(DEFAULT_WEBSITE_HOME)).toBe('5 pizzas, a burger, 3 deals');
  });

  it('the same item twice, or no pizza, is refused in words; entries move up and down', () => {
    const e = pickedEntry(pickable[1]!);
    expect(homeFromForm({ pizzas: [e, e], burger: null, deals: [] }, DEFAULT_WEBSITE_HOME).problem).toMatch(/twice/);
    expect(homeFromForm({ pizzas: [], burger: null, deals: [] }, DEFAULT_WEBSITE_HOME).problem).toMatch(/at least one pizza/);
    expect(moved(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moved(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
  });
});

describe('the publish toast and Settings → Online orders', () => {
  const base = { categories: 3, items: 12, photosLeftOut: [] };
  it('nothing new to say: the toast is exactly as before', () => {
    expect(publishedToast(base)).toEqual({ title: 'Menu published 🎉', description: '12 items in 3 categories are now live on the website.', variant: 'success' });
    expect(publishedToast({ ...base, homeMissing: [], shopPublish: { state: 'published', at: T1, message: null } })).toEqual(publishedToast(base));
  });

  it('names the home page’s missing items, and why the shop details did not reach the website', () => {
    const t = publishedToast({ ...base, homeMissing: ['Gone Pizza'], shopPublish: { state: 'unsupported', at: null, message: 'The website needs its update.' } });
    expect(t.variant).toBe('warning');
    expect(t.description).toMatch(/Home page: “Gone Pizza” is not on the website’s menu, so it is left off it/);
    expect(t.description).toMatch(/Shop details not on the website: The website needs its update\./);
    expect(homeMissingSentence(['A', 'B', 'C', 'D', 'E', 'F', 'G'])).toMatch(/and 2 more are not/);
    expect(shopNotOnWebsiteSentence({ state: 'waiting', at: null, message: null })).toBeNull();
  });

  it('the title names what to check: the shop details only when they did not reach the website; the home page when its missing items are the only news', () => {
    const shopRefused = { state: 'refused' as const, at: null, message: 'Test reason' };
    const homeOnly = publishedToast({ ...base, homeMissing: ['Gone Pizza'] });
    expect(homeOnly.title).toBe('Menu published — check the home page');
    expect(homeOnly.title).not.toMatch(/shop details/);
    expect(homeOnly.variant).toBe('warning');
    // The shop details published: the home page is still the only news.
    expect(publishedToast({ ...base, homeMissing: ['Gone Pizza'], shopPublish: { state: 'published', at: T1, message: null } }).title).toBe(
      'Menu published — check the home page',
    );
    expect(publishedToast({ ...base, shopPublish: shopRefused }).title).toBe('Menu published — check the website’s shop details');
    expect(publishedToast({ ...base, homeMissing: ['Gone Pizza'], shopPublish: shopRefused }).title).toBe('Menu published — check the website’s shop details');
    // A photo left out keeps the menu's own title.
    expect(publishedToast({ ...base, photosLeftOut: [{ id: 'a', name: 'Test Pizza' }], homeMissing: ['Gone Pizza'] }).title).toBe(
      'Menu published — some photos left out',
    );
  });

  it('the shop block’s status line reads like the settings block’s', () => {
    expect(settingsPublishWords({ state: 'refused', at: null, message: 'Test reason' }, SHOP_DETAILS_WORDS)).toEqual({
      tone: 'bad',
      text: 'Shop details, hours & home page: website not updated: Test reason',
    });
    expect(settingsPublishWords({ state: 'none', at: null, message: null }, SHOP_DETAILS_WORDS)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Source scans
// ---------------------------------------------------------------------------

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('M6: one fallback name for the till’s own screens', () => {
  it('the sign-in screen and the menu bar show nothing until the till’s own name is known, About says "My Store" — never the first shop’s name, no other hand-typed fallback', () => {
    expect(read('features/auth/LoginPage.tsx')).toMatch(/storeName \?\? brandingQ\.data\?\.shopName \?\? ''/);
    expect(read('features/settings/AboutCard.tsx')).toMatch(/storeName \?\? 'My Store'/);
    expect(read('features/shell/Sidebar.tsx')).toMatch(/storeName \?\? ''/);
    for (const f of ['features/auth/LoginPage.tsx', 'features/settings/AboutCard.tsx', 'features/shell/Sidebar.tsx']) {
      expect(read(f)).not.toMatch(/DEFAULT_SHOP_PROFILE|Cheese O/);
    }
    const handTyped = sources(SRC).filter((p) => /\?\?\s*['"`]Cheese\s?O'?\s?Clock/i.test(readFileSync(p, 'utf8')));
    expect(handTyped).toEqual([]);
  });

  it('the printed receipt keeps its own default (not this setting): Receipt branding’s name is untouched', () => {
    expect(read('features/settings/BrandingSettings.tsx')).toMatch(/const DEFAULT_NAME = 'My Store';/);
    expect(read('features/settings/BrandingSettings.tsx')).toMatch(/Receipt: shop details \(this till\)/);
  });

  it('the Home card’s preview says its prices are the till’s and a Save sends no menu (press Publish after menu changes)', () => {
    const cards = read('features/settings/WebsiteShopSettings.tsx');
    expect(cards).toContain('{WEBSITE_SHOP_WORDS.homePreview}');
    expect(WEBSITE_SHOP_WORDS.homePreview).toMatch(/this till’s/);
    expect(WEBSITE_SHOP_WORDS.homePreview).toMatch(/press Publish/);
    expect(WEBSITE_SHOP_WORDS.homePreview).toMatch(/Saving never sends the menu/);
    expect(cards).not.toMatch(/Not on the website: \{p\.entry/);
  });

  it('a new name: the card says the WhatsApp greeting is its own setting to change too', () => {
    expect(WEBSITE_SHOP_WORDS.nameRebrand).toMatch(/greeting on the “Order on WhatsApp” buttons is its own setting/);
  });

  it('a new name: the card never promises what stays — the share pictures’ hidden description keeps today’s name (Next reads it as a fixed text)', () => {
    expect(WEBSITE_SHOP_WORDS.nameRebrand).toMatch(/share pictures’ hidden description .* keeps “Cheese O’Clock”/);
    // What the website does keep: its share images' alt text is a fixed export.
    const web = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', 'web', 'src', 'app');
    expect(readFileSync(join(web, 'opengraph-image.tsx'), 'utf8')).toMatch(/export const alt =\s*"Cheese O'Clock/);
    expect(readFileSync(join(web, 'delivery', '[area]', 'opengraph-image.tsx'), 'utf8')).toMatch(/export const alt = "Cheese O'Clock/);
  });

  it('Shop & logo shows the website’s shop details group, on the owner-only tab', () => {
    const page = read('features/settings/SettingsPage.tsx');
    expect(page).toMatch(/tab === 'store' && \(\s*<>\s*<BrandingSettings \/>\s*<WebsiteShopSettings \/>/);
    const cards = read('features/settings/WebsiteShopSettings.tsx');
    expect(cards).toMatch(/Website: shop details \(both tills\)/);
    for (const title of ['Shop details', 'Opening hours', 'Payments at the door', 'WhatsApp numbers & social links', 'WhatsApp greeting', 'Allergy notice', 'Home page']) {
      expect(cards).toContain(`title="${title}"`);
    }
    // Never the browser's own confirm: "Put back the default" asks in the app's dialog (SettingCard).
    expect(cards).not.toMatch(/\bconfirm\(/);
  });
});
