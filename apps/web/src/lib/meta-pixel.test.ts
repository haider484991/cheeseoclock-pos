import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  META_PIXEL_ID,
  PIXEL_CURRENCY,
  PURCHASE_KEY_PREFIX,
  addToCartPayload,
  createPixel,
  initiateCheckoutPayload,
  isTrackingPath,
  metaPixelSnippet,
  pixel,
  pkr,
  purchaseEventId,
  purchasePayload,
  readPixelId,
  shouldTrackPageView,
  viewItemPayload,
  viewMenuPayload,
  type PixelLine,
  type PixelStorage,
  type PixelWindow,
} from './meta-pixel';
import { priceOrder } from './pricing';

const ID = '123456789012345';
const ORDER_A = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const ORDER_B = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';

/** Today's prices, in paisa: a large pizza, the same with extras, and two deals. */
const PIZZA = { id: 'item-fajita-l', name: 'Fajita Pizza · Large 12"', unitCents: 220_000 };
const PIZZA_EXTRAS = { id: 'item-fajita-l', unitCents: 260_000 };
const BIG_TWO = { id: 'item-big-two', unitCents: 360_000 };
const FAMILY = { id: 'item-family', unitCents: 310_000 };
const TAX_BPS = 1500;

const line = (item: { id: string; unitCents: number }, quantity = 1): PixelLine => ({
  id: item.id,
  quantity,
  unitCents: item.unitCents,
});

/** A phone's window: a recording `fbq`, a working localStorage, on /menu. `over` swaps any part of it. */
function phone(over: Partial<PixelWindow> = {}) {
  const calls: unknown[][] = [];
  const kept = new Map<string, string>();
  const win: PixelWindow = {
    fbq: (...args: unknown[]) => {
      calls.push(args);
    },
    location: { pathname: '/menu' },
    document: { referrer: '' },
    localStorage: {
      getItem: (k) => kept.get(k) ?? null,
      setItem: (k, v) => {
        kept.set(k, v);
      },
    },
    ...over,
  };
  return { win, calls, kept };
}

const on = (win: PixelWindow) => createPixel({ pixelId: ID, getWindow: () => win });

// ---------------------------------------------------------------------------

describe('readPixelId', () => {
  it('takes a pixel id, trimmed', () => {
    expect(readPixelId(ID)).toBe(ID);
    expect(readPixelId(`  ${ID}\n`)).toBe(ID);
    expect(readPixelId('12345678')).toBe('12345678');
    expect(readPixelId('12345678901234567890')).toBe('12345678901234567890');
  });

  it('is off (null) for unset, empty, or anything that is not 8–20 digits', () => {
    for (const raw of [
      undefined,
      null,
      '',
      '   ',
      '1234567',
      '123456789012345678901',
      'abcdefghij',
      '1234 5678 9012',
      `"${ID}"`,
      `${ID}');alert(1);('`,
    ]) {
      expect(readPixelId(raw), String(raw)).toBeNull();
    }
  });
});

describe('pkr: paisa to rupees', () => {
  it('is rupees with at most two decimals', () => {
    expect(pkr(220_000)).toBe(2200);
    expect(pkr(359_999)).toBe(3599.99);
    expect(pkr(320_850)).toBe(3208.5);
    expect(pkr(110)).toBe(1.1);
    expect(pkr(1)).toBe(0.01);
    expect(pkr(0)).toBe(0);
    // Whole paisa only: a fraction of a paisa is rounded, never carried into the value.
    expect(pkr(199_999.6)).toBe(2000);
  });

  it('never leaves float noise (1999.9999…) for any amount', () => {
    const noisy: number[] = [];
    for (let cents = 0; cents <= 3_000_000; cents += 37) {
      const rupees = pkr(cents);
      if (!/^\d+(\.\d{1,2})?$/.test(String(rupees)) || Math.round(rupees * 100) !== cents)
        noisy.push(cents);
    }
    expect(noisy).toEqual([]);
  });

  it('reads anything that is not an amount as 0', () => {
    for (const bad of [NaN, Infinity, -Infinity, -5]) expect(pkr(bad)).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('the events', () => {
  it('ViewContent for an item: the item, at its own price', () => {
    expect(viewItemPayload(PIZZA)).toEqual({
      content_type: 'product',
      content_ids: ['item-fajita-l'],
      content_name: 'Fajita Pizza · Large 12"',
      value: 2200,
      currency: 'PKR',
    });
  });

  it('ViewContent for the menu page', () => {
    expect(viewMenuPayload()).toEqual({ content_name: 'Menu', content_category: 'Menu' });
  });

  it('AddToCart: value is what was added, with its extras, times its quantity', () => {
    expect(addToCartPayload([line(PIZZA_EXTRAS)])).toEqual({
      content_type: 'product',
      content_ids: ['item-fajita-l'],
      contents: [{ id: 'item-fajita-l', quantity: 1 }],
      num_items: 1,
      value: 2600,
      currency: 'PKR',
    });
    const two = addToCartPayload([line(PIZZA, 2)]);
    expect(two.value).toBe(4400);
    expect(two.num_items).toBe(2);
    expect(two.contents).toEqual([{ id: 'item-fajita-l', quantity: 2 }]);
  });

  it('counts one item once in the ids and contents, however many lines it is on', () => {
    // Same pizza, with and without extras: two cart lines, one item.
    const p = addToCartPayload([line(PIZZA), line(PIZZA_EXTRAS), line(BIG_TWO)]);
    expect(p.content_ids).toEqual(['item-fajita-l', 'item-big-two']);
    expect(p.contents).toEqual([
      { id: 'item-fajita-l', quantity: 2 },
      { id: 'item-big-two', quantity: 1 },
    ]);
    expect(p.num_items).toBe(3);
    expect(p.value).toBe(2200 + 2600 + 3600);
  });

  it('InitiateCheckout: the cart, before tax, delivery and any discount', () => {
    // Rs 3,600 + Rs 3,100 + 2 × Rs 2,200 = Rs 11,100.
    expect(initiateCheckoutPayload([line(BIG_TWO), line(FAMILY), line(PIZZA, 2)])).toEqual({
      content_ids: ['item-big-two', 'item-family', 'item-fajita-l'],
      contents: [
        { id: 'item-big-two', quantity: 1 },
        { id: 'item-family', quantity: 1 },
        { id: 'item-fajita-l', quantity: 2 },
      ],
      num_items: 4,
      value: 11_100,
      currency: 'PKR',
    });
  });

  it('Purchase: value is what the customer pays, as the server priced it (tax included), not the cart sum', () => {
    // The server's own arithmetic (lib/pricing, as api/orders runs it): 15% tax on the food.
    for (const [cents, pays] of [
      [220_000, 253_000],
      [260_000, 299_000],
      [310_000, 356_500],
      [360_000, 414_000],
    ] as const) {
      const totals = priceOrder([{ lineTotalCents: cents, taxRateBps: TAX_BPS }]);
      expect(totals.totalCents).toBe(pays);
      const p = purchasePayload(totals.totalCents, [line({ id: 'item-x', unitCents: cents })])!;
      expect(p.value).toBe(pays / 100);
      expect(p.value).not.toBe(cents / 100);
      expect(p.currency).toBe('PKR');
    }
  });

  it('Purchase of a delivery: the delivery charge is in the value, the cart is the contents', () => {
    const totals = priceOrder([
      { lineTotalCents: BIG_TWO.unitCents, taxRateBps: TAX_BPS },
      { lineTotalCents: 20_000, taxRateBps: 0 }, // Rs 200 delivery, untaxed
    ]);
    expect(totals.totalCents).toBe(434_000);
    expect(purchasePayload(totals.totalCents, [line(BIG_TWO)])).toEqual({
      content_ids: ['item-big-two'],
      contents: [{ id: 'item-big-two', quantity: 1 }],
      num_items: 1,
      value: 4340,
      currency: 'PKR',
    });
  });

  it('Purchase of a pick-up: the discount is off, and paisa survive', () => {
    const totals = priceOrder([{ lineTotalCents: FAMILY.unitCents, taxRateBps: TAX_BPS }], 10);
    expect(totals.totalCents).toBe(320_850);
    expect(purchasePayload(totals.totalCents, [line(FAMILY)])!.value).toBe(3208.5);
  });

  it('Purchase takes the server total or nothing: no total, no number made up', () => {
    for (const bad of [undefined, null, NaN, Infinity, -1]) {
      expect(purchasePayload(bad, [line(FAMILY)]), String(bad)).toBeNull();
    }
    expect(purchasePayload(0, [line(FAMILY)])!.value).toBe(0);
  });

  it('is always in rupees', () => {
    expect(PIXEL_CURRENCY).toBe('PKR');
  });
});

describe('no personal data in any event', () => {
  // The whole set of keys each event may carry. A new key fails here until someone decides it is not personal.
  const ALLOWED = {
    viewItem: ['content_ids', 'content_name', 'content_type', 'currency', 'value'],
    viewMenu: ['content_category', 'content_name'],
    addToCart: ['content_ids', 'content_type', 'contents', 'currency', 'num_items', 'value'],
    initiateCheckout: ['content_ids', 'contents', 'currency', 'num_items', 'value'],
    purchase: ['content_ids', 'contents', 'currency', 'num_items', 'value'],
  };

  /** What a careless caller might hand over: a whole cart line, with the customer's words on it. */
  const dirty = [
    {
      id: 'item-fajita-l',
      quantity: 2,
      unitCents: 220_000,
      label: 'Fajita Pizza · Large 12"',
      notes: 'allergic to nuts, no onion please',
      modifierIds: ['no-onion'],
      customerName: 'Ahmed Khan',
      phone: '0300 1234567',
      email: 'ahmed@example.com',
      address: 'House 12, Street 4, Khayaban-e-Shamsheer',
      area: 'DHA Phase 6',
    },
  ];

  const payloads = {
    viewItem: viewItemPayload({ ...dirty[0]!, name: 'Fajita Pizza · Large 12"' }),
    viewMenu: viewMenuPayload(),
    addToCart: addToCartPayload(dirty),
    initiateCheckout: initiateCheckoutPayload(dirty),
    purchase: purchasePayload(506_000, dirty)!,
  };

  it('each event carries exactly its allowed keys', () => {
    for (const [event, payload] of Object.entries(payloads)) {
      expect(Object.keys(payload).sort(), event).toEqual(ALLOWED[event as keyof typeof ALLOWED]);
    }
  });

  it('a content entry is an id and a quantity, nothing else', () => {
    for (const p of [payloads.addToCart, payloads.initiateCheckout, payloads.purchase]) {
      for (const c of p.contents) expect(Object.keys(c).sort()).toEqual(['id', 'quantity']);
    }
  });

  it('no key names a person, a place or a note', () => {
    const personal =
      /(^|_)(customer|phone|mobile|tel|e?mail|address|street|house|area|zone|city|zip|postal|notes?|first|last|ph|em|fn|ln|ct|st|zp)($|_)/i;
    for (const [event, payload] of Object.entries(payloads)) {
      for (const key of Object.keys(payload)) expect(key, `${event}.${key}`).not.toMatch(personal);
    }
  });

  it('none of what the customer wrote reaches an event, even when handed over', () => {
    const sent = JSON.stringify(Object.values(payloads));
    for (const secret of [
      'allergic',
      'onion',
      'Ahmed',
      'Khan',
      '0300',
      'example.com',
      'House 12',
      'Khayaban',
      'DHA Phase',
      'no-onion',
    ]) {
      expect(sent, secret).not.toContain(secret);
    }
  });
});

// ---------------------------------------------------------------------------

describe('tracking pages are never sent', () => {
  it('knows /track and everything under it, however it is written', () => {
    for (const path of [
      '/track',
      '/track/',
      '/track/0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
      '/track/0199a1b2/',
      '/track/abc?phone=%2B923001234567&placed=1',
      '/Track/ABC',
      '/%74rack/abc',
      '/%54rack/abc',
      '/menu/../track/abc',
      '//track/abc',
      // A referrer is a whole address:
      'https://www.cheeseoclock.net/track/0199a1b2?phone=0300%201234567&placed=1',
      'http://localhost:3000/track/abc#x',
    ]) {
      expect(isTrackingPath(path), path).toBe(true);
    }
  });

  it('leaves every other page alone', () => {
    for (const path of [
      '/',
      '/menu',
      '/menu/track',
      '/menu?track=1',
      '/tracker',
      '/tracking',
      '/delivery/dha-6',
      '/pizza-delivery-dha-karachi',
      'https://l.facebook.com/',
      'https://www.cheeseoclock.net/menu',
      '',
      'track/abc',
      '/%E0%A4%A', // a malformed escape is just a path
    ]) {
      expect(isTrackingPath(path), path).toBe(false);
    }
    expect(isTrackingPath(null)).toBe(false);
    expect(isTrackingPath(undefined)).toBe(false);
  });

  it('sends a page view for a known page that is not a tracking page', () => {
    expect(shouldTrackPageView('/')).toBe(true);
    expect(shouldTrackPageView('/menu')).toBe(true);
    expect(shouldTrackPageView('/delivery/dha-6')).toBe(true);
    expect(shouldTrackPageView('/track/0199a1b2')).toBe(false);
    expect(shouldTrackPageView('/track')).toBe(false);
    expect(shouldTrackPageView('/%74rack/x')).toBe(false);
    expect(shouldTrackPageView(null)).toBe(false);
    expect(shouldTrackPageView(undefined)).toBe(false);
    expect(shouldTrackPageView('')).toBe(false);
  });

  it('pageView() sends one for /menu and none for /track', () => {
    const { win, calls } = phone();
    const p = on(win);
    expect(p.pageView('/menu')).toBe(true);
    expect(p.pageView('/track/0199a1b2')).toBe(false);
    expect(calls).toEqual([['track', 'PageView']]);
  });

  it('sends no event of any kind from a tracking page', () => {
    const { win, calls } = phone({ location: { pathname: '/track/0199a1b2' } });
    const p = on(win);
    expect(p.pageView('/menu')).toBe(false);
    expect(p.viewMenu()).toBe(false);
    expect(p.addToCart([line(PIZZA)])).toBe(false);
    expect(p.initiateCheckout([line(PIZZA)])).toBe(false);
    expect(p.purchase(ORDER_A, 253_000, [line(PIZZA)])).toBe(false);
    expect(p.track('Lead')).toBe(false);
    expect(calls).toEqual([]);
  });

  it('sends none from a page that was opened from one: the pixel would send that address as the referrer', () => {
    const referrer = 'https://www.cheeseoclock.net/track/0199a1b2?phone=0300%201234567&placed=1';
    const { win, calls, kept } = phone({ document: { referrer } });
    const p = on(win);
    expect(p.pageView('/menu')).toBe(false);
    expect(p.purchase(ORDER_A, 253_000, [line(PIZZA)])).toBe(false);
    expect(calls).toEqual([]);
    expect(kept.size).toBe(0);
  });

  it('is not put off by a referrer that is some other page', () => {
    for (const referrer of ['', 'https://l.facebook.com/', 'https://www.cheeseoclock.net/menu']) {
      const { win, calls } = phone({ document: { referrer } });
      expect(on(win).pageView('/menu'), referrer).toBe(true);
      expect(calls).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------

describe('the base snippet', () => {
  /**
   * Runs the snippet in a stand-in page, as a browser would: `window` is the global scope, so
   * the bare `fbq(...)` calls the snippet makes find the function it defined. Hands back what it made.
   */
  function run(code: string) {
    type Made = { src?: string; async?: boolean };
    const inserted: Made[] = [];
    const first = { parentNode: { insertBefore: (el: Made) => inserted.push(el) } };
    const doc = { createElement: (): Made => ({}), getElementsByTagName: () => [first] };
    const win: Record<string, unknown> = { document: doc };
    win['window'] = win;
    runInNewContext(code, win);
    return { win, inserted };
  }

  const fbqOf = (win: Record<string, unknown>) =>
    win['fbq'] as ((...a: unknown[]) => void) & {
      queue: ArrayLike<unknown>[];
      loaded: boolean;
      version: string;
      disablePushState?: boolean;
      allowDuplicatePageViews?: boolean;
    };

  it('runs: defines fbq, loads Meta’s script once, asks to init this pixel', () => {
    const { win, inserted } = run(metaPixelSnippet(ID));
    const fbq = fbqOf(win);
    expect(typeof fbq).toBe('function');
    expect(fbq.version).toBe('2.0');
    expect(inserted).toEqual([
      { src: 'https://connect.facebook.net/en_US/fbevents.js', async: true },
    ]);
    expect(Array.from(fbq.queue, (q) => Array.from(q))).toEqual([
      ['set', 'autoConfig', false, ID],
      ['init', ID],
    ]);
  });

  it('keeps the pixel from counting pages by itself (the history API, and every sheet that is opened)', () => {
    const fbq = fbqOf(run(metaPixelSnippet(ID)).win);
    expect(fbq.disablePushState).toBe(true);
    expect(fbq.allowDuplicatePageViews).toBe(true);
  });

  it('sends no event of its own: the page views come from the route changes', () => {
    const code = metaPixelSnippet(ID);
    expect(code).not.toContain("'PageView'");
    expect(code).not.toMatch(/fbq\(\s*'track'/);
    // …and no <noscript> image, which would count a page view by itself.
    expect(code).not.toContain('<noscript');
  });

  it('is empty for anything that is not a pixel id, so nothing else reaches the script', () => {
    for (const bad of ['', 'abc', `${ID}');alert(1);('`, '12 34'])
      expect(metaPixelSnippet(bad), bad).toBe('');
  });
});

// ---------------------------------------------------------------------------

describe('without a pixel id, nothing happens', () => {
  const off = (win: PixelWindow) =>
    createPixel({ pixelId: readPixelId(undefined), getWindow: () => win });

  it('is off and sends nothing', () => {
    const { win, calls, kept } = phone();
    const p = off(win);
    expect(p.enabled).toBe(false);
    expect(() => {
      expect(p.track('PageView')).toBe(false);
      expect(p.pageView('/menu')).toBe(false);
      expect(p.viewMenu()).toBe(false);
      expect(p.viewItem(PIZZA)).toBe(false);
      expect(p.addToCart([line(PIZZA)])).toBe(false);
      expect(p.initiateCheckout([line(PIZZA)])).toBe(false);
      expect(p.purchase(ORDER_A, 253_000, [line(PIZZA)])).toBe(false);
      expect(p.trackPurchaseOnce(ORDER_A, {})).toBe(false);
    }).not.toThrow();
    expect(calls).toEqual([]);
    expect(kept.size).toBe(0);
  });

  it('is also off for an id that is not valid', () => {
    const { win, calls } = phone();
    expect(createPixel({ pixelId: 'not-an-id', getWindow: () => win }).viewMenu()).toBe(false);
    expect(calls).toEqual([]);
  });

  it('the site’s own pixel does nothing here: no window in node, and the build has no id unless one is set', () => {
    expect(pixel.enabled).toBe(META_PIXEL_ID !== null);
    expect(pixel.viewMenu()).toBe(false);
    expect(pixel.purchase(ORDER_A, 253_000, [line(PIZZA)])).toBe(false);
  });
});

describe('track() is safe', () => {
  it('sends the event, with its parameters and options in the pixel’s order', () => {
    const { win, calls } = phone();
    const p = on(win);
    expect(p.track('AddToCart', { value: 1 })).toBe(true);
    expect(p.track('Purchase', { value: 2 }, { eventID: 'x' })).toBe(true);
    expect(p.track('Purchase', undefined, { eventID: 'y' })).toBe(true);
    expect(p.track('PageView')).toBe(true);
    expect(calls).toEqual([
      ['track', 'AddToCart', { value: 1 }],
      ['track', 'Purchase', { value: 2 }, { eventID: 'x' }],
      ['track', 'Purchase', {}, { eventID: 'y' }],
      ['track', 'PageView'],
    ]);
  });

  it('does nothing, and does not throw, when fbq is missing, not a function, or the window is absent', () => {
    for (const win of [
      phone({ fbq: undefined }).win,
      phone({ fbq: 'nope' }).win,
      phone({ fbq: { track: () => {} } }).win,
      undefined,
    ]) {
      const p = createPixel({ pixelId: ID, getWindow: () => win });
      expect(() => p.track('ViewContent', {})).not.toThrow();
      expect(p.track('ViewContent', {})).toBe(false);
      expect(p.addToCart([line(PIZZA)])).toBe(false);
      expect(p.purchase(ORDER_A, 253_000, [line(PIZZA)])).toBe(false);
    }
  });

  it('swallows an fbq that throws', () => {
    const fbq = vi.fn(() => {
      throw new Error('the pixel broke');
    });
    const { win } = phone({ fbq });
    const p = on(win);
    expect(() => p.track('AddToCart', {})).not.toThrow();
    expect(p.track('AddToCart', {})).toBe(false);
    expect(() => p.addToCart([line(PIZZA)])).not.toThrow();
    expect(() => p.initiateCheckout([line(PIZZA)])).not.toThrow();
    expect(() => p.purchase(ORDER_A, 253_000, [line(PIZZA)])).not.toThrow();
    expect(fbq).toHaveBeenCalled();
  });

  it('swallows whatever the page hands it', () => {
    const { win, calls } = phone();
    const p = on(win);
    expect(() => {
      p.addToCart(null as unknown as PixelLine[]);
      p.initiateCheckout(undefined as unknown as PixelLine[]);
      p.viewItem(null as unknown as { id: string; name: string; unitCents: number });
      p.pageView(42 as unknown as string);
    }).not.toThrow();
    expect(calls).toEqual([]);
  });

  it('does not send a cart event for a cart with nothing in it', () => {
    const { win, calls } = phone();
    const p = on(win);
    expect(p.addToCart([])).toBe(false);
    expect(
      p.initiateCheckout([
        { id: '', quantity: 1, unitCents: 100 },
        { id: 'a', quantity: 0, unitCents: 100 },
      ]),
    ).toBe(false);
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('a Purchase is sent once per order', () => {
  const payload = { value: 2530, currency: 'PKR' };

  it('sends it once however many times it is asked, with the order id as the event id', () => {
    const { win, calls } = phone();
    const p = on(win);
    expect(p.trackPurchaseOnce(ORDER_A, payload)).toBe(true);
    expect(p.trackPurchaseOnce(ORDER_A, payload)).toBe(false);
    expect(p.trackPurchaseOnce(ORDER_A, payload)).toBe(false);
    expect(calls).toEqual([['track', 'Purchase', payload, { eventID: ORDER_A }]]);
  });

  it('sends the next order’s', () => {
    const { win, calls } = phone();
    const p = on(win);
    expect(p.trackPurchaseOnce(ORDER_A, payload)).toBe(true);
    expect(p.trackPurchaseOnce(ORDER_B, payload)).toBe(true);
    expect(calls.map((c) => (c[3] as { eventID: string }).eventID)).toEqual([ORDER_A, ORDER_B]);
  });

  it('keeps its claim on the phone: a refresh, or a second tab, finds the order taken', () => {
    const first = phone();
    expect(on(first.win).trackPurchaseOnce(ORDER_A, payload)).toBe(true);
    expect(first.kept.has(`${PURCHASE_KEY_PREFIX}${ORDER_A}`)).toBe(true);
    // A new page load on the same phone: nothing in memory, the same storage.
    const again = phone({ localStorage: first.win.localStorage });
    expect(on(again.win).trackPurchaseOnce(ORDER_A, payload)).toBe(false);
    expect(again.calls).toEqual([]);
    expect(first.calls).toHaveLength(1);
  });

  it('makes the claim before it sends, so nothing that replays the order in between can count it twice', () => {
    const { win, kept } = phone();
    let claimedWhenSent: boolean | null = null;
    win.fbq = () => {
      claimedWhenSent = kept.has(`${PURCHASE_KEY_PREFIX}${ORDER_A}`);
    };
    on(win).trackPurchaseOnce(ORDER_A, payload);
    expect(claimedWhenSent).toBe(true);
  });

  it('still sends it once when localStorage throws (a private tab)', () => {
    const blocked: PixelStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const { win, calls } = phone({ localStorage: blocked });
    const p = on(win);
    expect(p.trackPurchaseOnce(ORDER_A, payload)).toBe(true);
    expect(p.trackPurchaseOnce(ORDER_A, payload)).toBe(false);
    expect(p.trackPurchaseOnce(ORDER_B, payload)).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('still sends it once when even reaching localStorage throws', () => {
    const { win, calls } = phone();
    Object.defineProperty(win, 'localStorage', {
      get() {
        throw new Error('SecurityError');
      },
    });
    const p = on(win);
    expect(p.trackPurchaseOnce(ORDER_A, payload)).toBe(true);
    expect(p.trackPurchaseOnce(ORDER_A, payload)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('does not use the claim up while the pixel cannot send (not loaded, or blocked)', () => {
    const { win, calls, kept } = phone({ fbq: undefined });
    const p = on(win);
    expect(p.trackPurchaseOnce(ORDER_A, payload)).toBe(false);
    expect(kept.size).toBe(0);
    win.fbq = (...args: unknown[]) => {
      calls.push(args);
    };
    expect(p.trackPurchaseOnce(ORDER_A, payload)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('refuses an id that is not an order id', () => {
    const { win, calls, kept } = phone();
    const p = on(win);
    for (const bad of ['', 'a b', '../../etc', 'x'.repeat(65), undefined as unknown as string]) {
      expect(p.trackPurchaseOnce(bad, payload), String(bad)).toBe(false);
    }
    expect(calls).toEqual([]);
    expect(kept.size).toBe(0);
  });

  it('is by the order id as the site sends it: the event id is the order id', () => {
    expect(purchaseEventId(ORDER_A)).toBe(ORDER_A);
  });
});

describe('purchase(): the server’s total and the cart, once', () => {
  it('sends the server total in rupees with the cart as its contents, and only once for a replayed order', () => {
    const { win, calls } = phone();
    const p = on(win);
    const totals = priceOrder([{ lineTotalCents: BIG_TWO.unitCents, taxRateBps: TAX_BPS }]);
    // The first answer, then the same order handed back for a resend (api/orders: replayed).
    expect(p.purchase(ORDER_A, totals.totalCents, [line(BIG_TWO)])).toBe(true);
    expect(p.purchase(ORDER_A, totals.totalCents, [line(BIG_TWO)])).toBe(false);
    expect(calls).toEqual([
      [
        'track',
        'Purchase',
        {
          content_ids: ['item-big-two'],
          contents: [{ id: 'item-big-two', quantity: 1 }],
          num_items: 1,
          value: 4140,
          currency: 'PKR',
        },
        { eventID: ORDER_A },
      ],
    ]);
  });

  it('sends nothing, and keeps the order unclaimed, when the server gave no total', () => {
    const { win, calls, kept } = phone();
    const p = on(win);
    expect(p.purchase(ORDER_A, undefined, [line(BIG_TWO)])).toBe(false);
    expect(kept.size).toBe(0);
    expect(p.purchase(ORDER_A, 414_000, [line(BIG_TWO)])).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe('the events as the site sends them', () => {
  it('sends each as its payload, from /menu', () => {
    const { win, calls } = phone();
    const p = on(win);
    p.viewMenu();
    p.viewItem(PIZZA);
    p.addToCart([line(PIZZA_EXTRAS)]);
    p.initiateCheckout([line(BIG_TWO), line(FAMILY)]);
    expect(calls).toEqual([
      ['track', 'ViewContent', viewMenuPayload()],
      ['track', 'ViewContent', viewItemPayload(PIZZA)],
      ['track', 'AddToCart', addToCartPayload([line(PIZZA_EXTRAS)])],
      ['track', 'InitiateCheckout', initiateCheckoutPayload([line(BIG_TWO), line(FAMILY)])],
    ]);
  });
});
