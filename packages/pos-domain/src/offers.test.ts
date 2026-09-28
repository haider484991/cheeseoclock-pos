import { describe, expect, it } from 'vitest';
import { DEFAULT_DISCOUNT_OFFERS, type ChannelOffer, type CounterOffers } from '@cheeseoclock/shared-types';
import {
  OFFER_FLAG_MIN_ORDERS,
  cameByChipsShown,
  declinedOfferRule,
  matchOffer,
  offerAmount,
  offerFlags,
  offerHint,
  offerMiss,
  offerRule,
  offerRuleAmount,
  offerRunsAt,
  offerTerms,
  offerTimeOf,
  parseOfferRule,
  type OfferOrder,
} from './offers.js';
import { discountRuleAlsoOffDeliveryCharge, parseDiscountBaseRule } from './discount-base.js';

/**
 * The owner's automatic offers as pure rules (shared-types
 * DiscountOffers; the main process and the counter both call these). Every
 * name and figure is made up.
 */

/** Friday 2 October 2026, 14:00 Pakistan time (09:00 UTC): a Friday afternoon. */
const FRI_2PM = '2026-10-02T09:00:00.000Z';

function offer(over: Partial<ChannelOffer> = {}): ChannelOffer {
  return {
    id: 'test-wa',
    name: 'Test WhatsApp 10%',
    on: true,
    cameBy: ['whatsapp'],
    orderTypes: ['delivery'],
    type: 'percent',
    value: 10,
    minOrderCents: null,
    maxOffCents: null,
    days: [0, 1, 2, 3, 4, 5, 6],
    hours: null,
    startsOn: null,
    endsOn: null,
    oncePerCustomerPerDay: false,
    ...over,
  };
}

/** A counter delivery that came by WhatsApp with the phone saved: Rs 2,000 of food and a Rs 200 delivery charge. */
function order(over: Partial<OfferOrder> = {}): OfferOrder {
  return {
    source: 'pos',
    mode: 'delivery',
    cameBy: 'whatsapp',
    hasPhone: true,
    createdAt: FRI_2PM,
    foodCents: 200_000,
    subtotalCents: 220_000,
    ...over,
  };
}

const opts = { alsoOffDeliveryCharge: false, settingsAt: '2026-10-01T10:00:00.000Z' };

describe('no offers: nothing changes', () => {
  it('the released setting has no offers and does not ask; nothing is matched', () => {
    expect(DEFAULT_DISCOUNT_OFFERS).toEqual({ v: 1, askCameBy: false, offers: [] });
    expect(matchOffer(order(), DEFAULT_DISCOUNT_OFFERS.offers, opts)).toBeNull();
    expect(cameByChipsShown(DEFAULT_DISCOUNT_OFFERS, 'delivery', FRI_2PM)).toBe(false);
  });
});

describe('which orders', () => {
  it('a counter order only — never a website order, never a foodpanda order', () => {
    const offers = [offer({ cameBy: 'any', orderTypes: ['takeaway', 'delivery'] })];
    expect(matchOffer(order(), offers, opts)?.amountCents).toBe(20_000);
    expect(matchOffer(order({ source: 'web' }), offers, opts)).toBeNull();
    expect(matchOffer(order({ mode: 'foodpanda' }), offers, opts)).toBeNull();
    expect(matchOffer(order({ mode: 'dine_in' }), offers, opts)).toBeNull();
  });

  it('the order types it names: a new offer is delivery only, takeaway must be chosen', () => {
    expect(matchOffer(order({ mode: 'takeaway' }), [offer()], opts)).toBeNull();
    expect(matchOffer(order({ mode: 'takeaway' }), [offer({ orderTypes: ['takeaway', 'delivery'] })], opts)).not.toBeNull();
  });

  it('how the order came in: its chips, or any way', () => {
    expect(matchOffer(order({ cameBy: 'walk_in' }), [offer()], opts)).toBeNull();
    expect(matchOffer(order({ cameBy: null }), [offer()], opts)).toBeNull();
    expect(matchOffer(order({ cameBy: 'phone' }), [offer({ cameBy: ['phone', 'whatsapp'] })], opts)).not.toBeNull();
    // "Any way" needs no chip at all.
    expect(matchOffer(order({ cameBy: null, hasPhone: false }), [offer({ cameBy: 'any' })], opts)?.amountCents).toBe(20_000);
  });
});

describe('the whole order except the delivery charge', () => {
  it('worked on the food only: 10% of Rs 2,000 of food, the Rs 200 delivery charge untouched', () => {
    const pick = matchOffer(order(), [offer()], opts)!;
    expect(pick.amountCents).toBe(20_000);
    expect(pick.rule).toMatchObject({ kind: 'discount_base', v: 1, alsoOffDeliveryCharge: false, from: 'till' });
    // Rupees off are at most the food; 100% is never possible (50% at most), and a flat bigger than the food takes the food.
    expect(offerAmount({ type: 'flat', value: 500_000, minOrderCents: null, maxOffCents: null }, 200_000, 200_000)).toBe(200_000);
  });

  it('with the owner’s switch on ("A discount also comes off the delivery charge") it is worked on every line, frozen so', () => {
    const pick = matchOffer(order(), [offer()], { ...opts, alsoOffDeliveryCharge: true })!;
    expect(pick.amountCents).toBe(22_000);
    expect(pick.rule.alsoOffDeliveryCharge).toBe(true);
  });

  it('the minimum is measured on the food, never the delivery charge', () => {
    const min = offer({ minOrderCents: 210_000 });
    // Rs 2,000 of food + Rs 200 charge = Rs 2,200: still under the Rs 2,100 minimum of FOOD.
    expect(matchOffer(order(), [min], opts)).toBeNull();
    expect(matchOffer(order(), [min], { ...opts, alsoOffDeliveryCharge: true })).toBeNull();
    expect(matchOffer(order({ foodCents: 210_000, subtotalCents: 230_000 }), [min], opts)?.amountCents).toBe(21_000);
  });

  it('the most off caps it', () => {
    expect(matchOffer(order(), [offer({ maxOffCents: 15_000 })], opts)?.amountCents).toBe(15_000);
  });
});

describe('the biggest fitting offer wins', () => {
  const tenPct = offer({ id: 'ten', name: 'Ten', cameBy: 'any' });
  const rs300 = offer({ id: 'flat', name: 'Flat 300', cameBy: 'any', type: 'flat', value: 30_000, minOrderCents: 200_000 });

  it('Rs 300 beats 10% on Rs 2,000 of food; 10% beats it on Rs 4,000', () => {
    expect(matchOffer(order(), [tenPct, rs300], opts)?.rule.offer.id).toBe('flat');
    expect(matchOffer(order({ foodCents: 400_000, subtotalCents: 420_000 }), [tenPct, rs300], opts)?.rule.offer.id).toBe('ten');
  });

  it('a tie keeps the one already on the order, then the owner’s list order', () => {
    const rs200 = offer({ id: 'flat2', name: 'Flat 200', cameBy: 'any', type: 'flat', value: 20_000 });
    expect(matchOffer(order(), [tenPct, rs200], opts)?.rule.offer.id).toBe('ten');
    expect(matchOffer(order(), [rs200, tenPct], opts)?.rule.offer.id).toBe('flat2');
    const current = offerRule(offerTerms(rs200, null), false);
    expect(matchOffer(order(), [tenPct, rs200], { ...opts, current })).toMatchObject({ isCurrent: true, amountCents: 20_000 });
  });
});

describe('the offer on the order keeps its frozen terms', () => {
  const frozen = offerRule(offerTerms(offer({ value: 20 }), '2026-10-01T10:00:00.000Z'), false);

  it('a Save while the order is open (20% → 5%, or switched off) does not move it', () => {
    const now5 = [offer({ value: 5 })];
    expect(matchOffer(order(), now5, { ...opts, current: frozen })).toMatchObject({ isCurrent: true, amountCents: 40_000 });
    expect(matchOffer(order(), [offer({ on: false })], { ...opts, current: frozen })).toMatchObject({ isCurrent: true, amountCents: 40_000 });
    // …and outside its hours now: the order's start decided, and the frozen terms carry no hours.
    expect(matchOffer(order(), [], { ...opts, current: frozen })).toMatchObject({ isCurrent: true });
  });

  it('a live offer replaces it only by taking more off', () => {
    const bigger = offer({ id: 'big', name: 'Big', cameBy: 'any', value: 25 });
    expect(matchOffer(order(), [bigger], { ...opts, current: frozen })).toMatchObject({ isCurrent: false, amountCents: 50_000 });
  });

  it('when its terms no longer fit (the chip changed, under the minimum) it comes off, and a live one may go on', () => {
    expect(matchOffer(order({ cameBy: 'walk_in' }), [], { ...opts, current: frozen })).toBeNull();
    const walkIn = offer({ id: 'walk', name: 'Walk-in 5%', cameBy: ['walk_in'], value: 5 });
    expect(matchOffer(order({ cameBy: 'walk_in' }), [walkIn], { ...opts, current: frozen })?.rule.offer.id).toBe('walk');
  });

  it('one the cashier took off is not put back by itself', () => {
    const declined = declinedOfferRule(frozen);
    expect(offerRuleAmount(declined, order())).toBe(0);
    expect(matchOffer(order(), [], { ...opts, current: declined })).toBeNull();
  });
});

describe('days, hours and dates: when the order was started, Pakistan time, the trading day from 05:00', () => {
  it('01:30 on Saturday is Friday’s trading day, at hour 1', () => {
    // Saturday 3 October 2026, 01:30 PKT = Friday 20:30 UTC.
    expect(offerTimeOf('2026-10-02T20:30:00.000Z')).toEqual({ day: '2026-10-02', weekday: 4, hour: 1 });
  });

  it('04:59 on Saturday is still Friday; 05:00 is Saturday', () => {
    const fridays = offer({ days: [4] });
    expect(offerRunsAt(fridays, '2026-10-02T23:59:00.000Z')).toBe(true); // Sat 04:59 PKT
    expect(offerRunsAt(fridays, '2026-10-03T00:00:00.000Z')).toBe(false); // Sat 05:00 PKT
    expect(offerRunsAt(offer({ days: [5] }), '2026-10-03T00:00:00.000Z')).toBe(true);
  });

  it('hours: first and last hour inclusive, across midnight', () => {
    const lunch = offer({ hours: { fromHour: 12, toHour: 15 } });
    expect(offerRunsAt(lunch, '2026-10-02T07:00:00.000Z')).toBe(true); // 12:00 PKT
    expect(offerRunsAt(lunch, '2026-10-02T10:59:00.000Z')).toBe(true); // 15:59 PKT
    expect(offerRunsAt(lunch, '2026-10-02T11:00:00.000Z')).toBe(false); // 16:00 PKT
    const late = offer({ days: [4], hours: { fromHour: 22, toHour: 1 } });
    expect(offerRunsAt(late, '2026-10-02T17:00:00.000Z')).toBe(true); // Fri 22:00
    expect(offerRunsAt(late, '2026-10-02T20:59:00.000Z')).toBe(true); // Sat 01:59 = Friday's
    expect(offerRunsAt(late, '2026-10-02T21:00:00.000Z')).toBe(false); // Sat 02:00
  });

  it('dates are trading days; off is off', () => {
    const oct = offer({ startsOn: '2026-10-03', endsOn: '2026-10-04' });
    expect(offerRunsAt(oct, FRI_2PM)).toBe(false);
    expect(offerRunsAt(oct, '2026-10-02T23:30:00.000Z')).toBe(false); // Sat 04:30 PKT, still the 2nd
    expect(offerRunsAt(oct, '2026-10-03T00:00:00.000Z')).toBe(true);
    expect(offerRunsAt(oct, '2026-10-05T00:00:00.000Z')).toBe(false);
    expect(offerRunsAt(offer({ on: false }), FRI_2PM)).toBe(false);
    expect(offerRunsAt(offer(), 'not a date')).toBe(false);
  });
});

describe('abuse controls', () => {
  it('Phone and WhatsApp offers need the customer’s phone on the order; "any way" does not', () => {
    expect(offerMiss(offer(), order({ hasPhone: false }))).toBe('phone');
    expect(matchOffer(order({ hasPhone: false }), [offer()], opts)).toBeNull();
    expect(offerMiss(offer({ cameBy: ['phone', 'walk_in'] }), order({ cameBy: 'walk_in', hasPhone: false }))).toBeNull();
    expect(offerMiss(offer({ cameBy: 'any' }), order({ cameBy: 'phone', hasPhone: false }))).toBeNull();
  });

  it('once per customer per day: needs the phone, and not twice the same day', () => {
    const once = offer({ cameBy: 'any', oncePerCustomerPerDay: true });
    expect(offerMiss(once, order({ hasPhone: false }))).toBe('phone');
    expect(matchOffer(order(), [once], { ...opts, usedToday: new Set(['test-wa']) })).toBeNull();
    expect(matchOffer(order(), [once], { ...opts, usedToday: new Set(['another']) })).not.toBeNull();
  });
});

describe('the frozen rule', () => {
  it('reads back as written; an older till (0.7.26) reads it as a till rule on the food', () => {
    const rule = offerRule(offerTerms(offer({ minOrderCents: 100_000, maxOffCents: 30_000 }), '2026-10-01T10:00:00.000Z'), false);
    const json = JSON.stringify(rule);
    expect(parseOfferRule(json)).toEqual(rule);
    // THE reader every after-the-fact place uses (tax split, FBR, profit): food only.
    expect(discountRuleAlsoOffDeliveryCharge(json)).toBe(false);
    expect(parseDiscountBaseRule(json)).toEqual({ kind: 'discount_base', v: 1, alsoOffDeliveryCharge: false, from: 'till' });
    expect(parseOfferRule(JSON.stringify(declinedOfferRule(rule)))?.offer.declined).toBe(true);
  });

  it('a staff or website rule, the foodpanda deal or junk is not an offer', () => {
    expect(parseOfferRule(JSON.stringify({ kind: 'discount_base', v: 1, alsoOffDeliveryCharge: false, from: 'till' }))).toBeNull();
    expect(parseOfferRule(JSON.stringify({ kind: 'foodpanda_deal', v: 1 }))).toBeNull();
    expect(parseOfferRule('{nope')).toBeNull();
    expect(parseOfferRule(null)).toBeNull();
  });
});

describe('the counter', () => {
  const rules = (over: Partial<CounterOffers> = {}): CounterOffers => ({ askCameBy: false, offers: [offer()], ...over });

  it('shows the chips when asked, or when an offer that runs needs them, on takeaway and delivery only', () => {
    expect(cameByChipsShown(rules(), 'delivery', FRI_2PM)).toBe(true);
    expect(cameByChipsShown(rules(), 'takeaway', FRI_2PM)).toBe(false);
    expect(cameByChipsShown(rules({ offers: [offer({ cameBy: 'any' })] }), 'delivery', FRI_2PM)).toBe(false);
    expect(cameByChipsShown(rules({ askCameBy: true, offers: [] }), 'takeaway', FRI_2PM)).toBe(true);
    expect(cameByChipsShown(rules({ askCameBy: true }), 'foodpanda', FRI_2PM)).toBe(false);
    expect(cameByChipsShown(null, 'delivery', FRI_2PM)).toBe(false);
  });

  it('hints an offer waiting for the phone, or for more food', () => {
    expect(offerHint(order({ hasPhone: false }), rules(), false)).toEqual({ name: 'Test WhatsApp 10%', needs: 'phone' });
    expect(offerHint(order({ foodCents: 100_000 }), rules({ offers: [offer({ minOrderCents: 150_000 })] }), false)).toEqual({
      name: 'Test WhatsApp 10%',
      needs: 'more_food',
      fromCents: 150_000,
    });
    expect(offerHint(order({ source: 'web' }), rules(), false)).toBeNull();
  });
});

describe('Team & leakage: 1.5 × the shop', () => {
  const shop = { counterOrders: 100, phoneOrWhatsapp: 20, offerCents: 100_000 };

  it('flags a share of Phone / WhatsApp orders over 1.5 × the shop’s, and offers’ rupees per order likewise', () => {
    // The shop: 20%. 30% is exactly 1.5 ×: not flagged; 31% is.
    expect(offerFlags({ counterOrders: 100, phoneOrWhatsapp: 30, offerCents: 150_000 }, shop)).toEqual([]);
    expect(offerFlags({ counterOrders: 100, phoneOrWhatsapp: 31, offerCents: 150_100 }, shop)).toEqual(['phone_share', 'offer_rupees']);
    expect(offerFlags({ counterOrders: 40, phoneOrWhatsapp: 4, offerCents: 90_000 }, shop)).toEqual(['offer_rupees']);
  });

  it('never with fewer than the minimum orders', () => {
    expect(offerFlags({ counterOrders: OFFER_FLAG_MIN_ORDERS - 1, phoneOrWhatsapp: 19, offerCents: 90_000 }, shop)).toEqual([]);
    expect(offerFlags({ counterOrders: 30, phoneOrWhatsapp: 0, offerCents: 0 }, { counterOrders: 0, phoneOrWhatsapp: 0, offerCents: 0 })).toEqual([]);
  });
});
