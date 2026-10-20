/**
 * First-time setup's Website step (shared-types new-shop.ts): where the form
 * starts and what it takes from the Business step, the answers it sends, the
 * check the main process makes again (shared-schemas checkedNewShop), and the
 * step on screen (static renders, react-dom/server: no browser, nothing calls
 * the till). Every name, number and address is made up — and none of them,
 * nor anything the step shows, is the first shop's.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { checkedNewShop, publishedShopSchema } from '@cheeseoclock/shared-schemas';
import {
  DEFAULT_SHOP_HOURS,
  DEFAULT_SHOP_PROFILE,
  DEFAULT_SHOP_WEBSITE,
  DEFAULT_WEBSITE_HOME,
  NEW_SHOP_KEYS,
  NOTHING_FEATURED,
  SHOP_DAYS,
  newShopGreeting,
} from '@cheeseoclock/shared-types';
import { buildShopBlock } from '@cheeseoclock/pos-domain';
import { WebsiteStep } from './WebsiteStep';
import { startingWebsiteForm, websiteAnswers, withBusinessDetails, withDay, type WebsiteForm } from './websiteStepForm';

const filled = (more: Partial<WebsiteForm> = {}): WebsiteForm => ({
  ...startingWebsiteForm(),
  phone: '0300 1112233',
  street: 'Plot 9, Test Street, Test Block 2',
  areaLine: 'Test Town, Karachi',
  postalCode: '75999',
  priceRange: 'PKR 100–900',
  ...more,
});

/** The first shop's details (its frozen defaults) and the words of its name and street, lower-case. */
const FIRST_SHOP_WORDS = (() => {
  const p = DEFAULT_SHOP_PROFILE;
  const h = DEFAULT_WEBSITE_HOME;
  return [
    p.name,
    p.tagline,
    ...[p.phone, ...p.whatsappLines].flatMap((l) => [l.display, l.e164.replace(/^\+92/, '')]),
    p.address.street,
    p.address.areaLine,
    p.address.postalCode,
    ...p.socialLinks,
    p.priceRange,
    DEFAULT_SHOP_WEBSITE.whatsappGreeting,
    ...[...h.pizzas, ...(h.burger ? [h.burger] : []), ...h.deals].map((e) => e.itemRef.name),
    'cheese',
    'clock',
    'rahat',
    'dha',
  ].map((w) => w.toLowerCase());
})();
const firstShopWordsIn = (text: string) => FIRST_SHOP_WORDS.filter((w) => text.toLowerCase().includes(w));

const problem = (name: string, form: WebsiteForm | unknown, tagline = '') =>
  checkedNewShop(name, tagline, form && typeof form === 'object' && 'pickupOffered' in form ? websiteAnswers(form as WebsiteForm) : form).problem;

describe('the form', () => {
  it('starts with nothing of any shop: empty boxes, every day 11 am to 11 pm, no pick-up', () => {
    expect(startingWebsiteForm()).toEqual({
      phone: '',
      whatsapp: '',
      street: '',
      areaLine: '',
      postalCode: '',
      priceRange: '',
      opens: '11:00',
      closes: '23:00',
      days: [...SHOP_DAYS],
      pickupOffered: false,
      pickupPercent: '0',
    });
    expect(startingWebsiteForm()).not.toMatchObject({ opens: DEFAULT_SHOP_HOURS.opens });
    expect(startingWebsiteForm()).not.toMatchObject({ closes: DEFAULT_SHOP_HOURS.closes });
  });

  it('takes the Business step’s phone (only one the website can call), address line and city — into empty boxes only', () => {
    const business = { phoneLine: ' 0300 1112233 ', branchLine: ' Plot 9, Test Street ', city: 'Karachi' };
    expect(withBusinessDetails(startingWebsiteForm(), business)).toMatchObject({
      phone: '0300 1112233',
      street: 'Plot 9, Test Street',
      areaLine: 'Karachi',
    });
    // A UAN number is not one the website can call: the box stays empty for the owner.
    expect(withBusinessDetails(startingWebsiteForm(), { ...business, phoneLine: '021 111 222 333' }).phone).toBe('');
    // What the owner typed here stays.
    const typed = filled({ phone: '0321 4445566', street: 'Shop 1, Made-up Road', areaLine: 'Test Town, Karachi' });
    expect(withBusinessDetails(typed, business)).toEqual(typed);
  });

  it('keeps the days Monday first; sends a pick-up % only when pick-up is offered', () => {
    expect(withDay(['sun', 'mon'], 'wed', true)).toEqual(['mon', 'wed', 'sun']);
    expect(withDay([...SHOP_DAYS], 'mon', false)).toEqual(['tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
    expect(websiteAnswers(filled({ pickupOffered: false, pickupPercent: '15' })).pickup).toEqual({ offered: false, percent: 0 });
    expect(websiteAnswers(filled({ pickupOffered: true, pickupPercent: '' })).pickup).toEqual({ offered: true, percent: 0 });
    expect(websiteAnswers(filled({ pickupOffered: true, pickupPercent: ' 12 ' })).pickup).toEqual({ offered: true, percent: 12 });
    expect(websiteAnswers(filled({ pickupOffered: true, pickupPercent: '12.5' })).pickup.percent).toBeNaN();
  });
});

describe('the check (shared-schemas checkedNewShop: the same one the main process makes)', () => {
  it('gives the five values: the shop’s own details, its own greeting, nothing featured, pick-up as answered', () => {
    const r = checkedNewShop(' Test Kitchen ', 'Made-up words', websiteAnswers(filled()));
    expect(r.problem).toBeNull();
    const v = r.value!;
    expect(Object.keys(v)).toEqual([...NEW_SHOP_KEYS]);
    expect(v['shop.profile']).toMatchObject({
      name: 'Test Kitchen',
      tagline: 'Made-up words',
      phone: { display: '0300 1112233', e164: '+923001112233' },
      // No WhatsApp number typed: the call line.
      whatsappLines: [{ display: '0300 1112233', e164: '+923001112233' }],
      socialLinks: [],
    });
    expect(v['shop.website'].whatsappGreeting).toBe("Hi Test Kitchen! I'd like to place an order: ");
    expect(newShopGreeting(' Test Kitchen ')).toBe(v['shop.website'].whatsappGreeting);
    expect(v['website.home']).toEqual(NOTHING_FEATURED);
    expect(v['discounts.websitePickup']).toEqual({ v: 2, offered: false, percent: 0, alsoDelivery: false });
    expect(firstShopWordsIn(JSON.stringify(v))).toEqual([]);
    // …while the first shop's own details hold every one of those words (the check is not empty).
    expect(firstShopWordsIn(JSON.stringify([DEFAULT_SHOP_PROFILE, DEFAULT_SHOP_WEBSITE, DEFAULT_WEBSITE_HOME]))).toEqual(FIRST_SHOP_WORDS);
    // As the till sends them, they pass the website's own check.
    const block = buildShopBlock({
      profile: v['shop.profile'],
      hours: v['shop.hours'],
      website: v['shop.website'],
      home: v['website.home'],
      stamps: [{ version: 1, updatedAt: '2026-10-20T10:00:00.000Z' }, null, null, null],
      deviceId: 'till-test',
    });
    expect(publishedShopSchema.safeParse(block).success).toBe(true);
  });

  it('says what to fix first, in the owner’s words', () => {
    expect(problem('Test Kitchen', filled({ phone: '' }))).toBe('Type the shop’s phone number as it is dialled in Pakistan (like 0300 1234567)');
    expect(problem('Test Kitchen', filled({ phone: '021 111 222 333' }))).toMatch(/^Type the shop’s phone number/);
    expect(problem('Test Kitchen', filled({ whatsapp: 'not a number' }))).toBe(
      'Type the WhatsApp number as it is dialled in Pakistan (like 0300 1234567), or leave it empty for the same number',
    );
    expect(problem('Test Kitchen', filled({ street: '  ' }))).toBe('The street address can’t be empty');
    expect(problem('Test Kitchen', filled({ areaLine: '' }))).toBe('The short address line can’t be empty');
    expect(problem('Test Kitchen', filled({ postalCode: '7599' }))).toBe('The postal code is five digits');
    expect(problem('Test Kitchen', filled({ priceRange: '' }))).toBe('The price range can’t be empty');
    expect(problem('Test Kitchen', filled({ days: [] }))).toBe('Pick at least one day the shop opens');
    expect(problem('Test Kitchen', filled({ opens: '12:00', closes: '12:00' }))).toBe('The closing time can’t be the opening time');
    expect(problem('Test Kitchen', filled({ pickupOffered: true, pickupPercent: '60' }))).toBe('The pick-up discount is a whole % from 0 to 50');
    expect(problem('Test Kitchen', filled({ pickupOffered: true, pickupPercent: 'ten' }))).toBe('The pick-up discount is a whole % from 0 to 50');
    expect(problem('  ', filled())).toBe('The shop’s name can’t be empty');
    expect(problem('x'.repeat(41), filled())).toBe('Keep the shop’s name to 40 letters');
    expect(problem('Test Kitchen', filled(), 'x'.repeat(81))).toBe('Keep the tagline to 80 letters');
    // A screen without the step (or one that sends something else) is refused, not filled in.
    expect(problem('Test Kitchen', undefined)).toBe('Fill in what the website shows');
    expect(problem('Test Kitchen', { ...websiteAnswers(filled()), socialLinks: [] })).toBe('Fill in what the website shows');
  });
});

describe('the step on screen', () => {
  const render = (form: WebsiteForm, p: string | null = null) =>
    renderToStaticMarkup(createElement(WebsiteStep, { form, problem: p, onChange: () => {} }));

  it('every box with its label; the % box only while pick-up is offered; the first thing to fix', () => {
    const html = render(filled());
    for (const label of ['Phone for calls *', 'WhatsApp for orders', 'Street address *', 'Area and city *', 'Postal code *', 'Price range *', 'Opens', 'Closes', 'Open on']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('Customers can also order on the website and pick it up');
    expect(html).not.toContain('% off a pick-up order');
    expect(html).not.toContain('role="status"');
    expect(render(filled({ pickupOffered: true, pickupPercent: '10' }))).toContain('% off a pick-up order');
    expect(render(filled(), 'The postal code is five digits')).toMatch(/role="status"[^>]*>The postal code is five digits</);
    // A closing time the opening time no longer allows asks to be picked again (the Settings card's way).
    expect(render(filled({ opens: '23:00', closes: '23:00' }))).toContain('(pick again)');
  });

  it('shows nothing of the first shop’s: no name, number, address or dish — not even as an example', () => {
    expect(firstShopWordsIn(render(startingWebsiteForm()))).toEqual([]);
    expect(firstShopWordsIn(render(filled({ pickupOffered: true }), 'Something to fix'))).toEqual([]);
  });
});
