import { describe, expect, it } from 'vitest';
import { DEFAULT_DISCOUNT_OFFERS, type ChannelOffer, type CounterOffers } from '@cheeseoclock/shared-types';
import {
  OFFER_FLAG_MIN_MARKED,
  cameByWasTapped,
  cameByChipsShown,
  declinedOfferRule,
  matchOffer,
  offerAmount,
  offerCanApplyTo,
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
import {
  discountBaseCents,
  discountRuleAlsoOffDeliveryCharge,
  discountRuleScope,
  parseDiscountBaseRule,
  type DiscountLine,
} from './discount-base.js';

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

  it('the counter check itself refuses foodpanda and website orders, whatever an offer names', () => {
    // The schema already limits an offer to takeaway or delivery; this pins the second lock on its own.
    expect(offerCanApplyTo({ source: 'pos', mode: 'foodpanda' })).toBe(false);
    expect(offerCanApplyTo({ source: 'web', mode: 'delivery' })).toBe(false);
    expect(offerCanApplyTo({ source: 'pos', mode: 'delivery' })).toBe(true);
    const namesFoodpanda = [offer({ cameBy: 'any', orderTypes: ['foodpanda' as unknown as 'delivery'] })];
    expect(matchOffer(order({ mode: 'foodpanda' }), namesFoodpanda, opts)).toBeNull();
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

/**
 * The owner, 2 Oct 2026: value deals never get any discount, an automatic
 * offer included. The counter and the main process hand matchOffer the food
 * an offer may come off (value deals left out: discountBaseCents with the
 * offer's scope); the minimum is measured on the same food. A made-up
 * Rs 3,600 deal, Rs 500 of fries and a Rs 200 delivery charge.
 */
describe('value deals never: an offer is worked on, and its minimum measured on, the food without them', () => {
  const DEAL: DiscountLine = { lineTotalCents: 360_000, menuItemName: 'Test Deal for Two', noDiscount: true };
  const FRIES: DiscountLine = { lineTotalCents: 50_000, menuItemName: 'Test Fries' };
  const CHARGE: DiscountLine = { lineTotalCents: 20_000, menuItemName: 'Delivery Charge (Rs 200)' };
  /** The order as the till hands it to an offer: what it may come off, value deals never. */
  const orderOf = (lines: DiscountLine[], over: Partial<OfferOrder> = {}): OfferOrder =>
    order({
      foodCents: discountBaseCents(lines, { alsoOffDeliveryCharge: false, skipsNoDiscountLines: true }),
      subtotalCents: discountBaseCents(lines, { alsoOffDeliveryCharge: true, skipsNoDiscountLines: true }),
      ...over,
    });
  const fromRs1000 = offer({ cameBy: 'any', minOrderCents: 100_000 });
  const noMinimum = offer({ cameBy: 'any' });

  it('an order of deals only gets no offer, and the cart hints none', () => {
    const dealsOnly = orderOf([DEAL, CHARGE]);
    expect(dealsOnly.foodCents).toBe(0);
    expect(matchOffer(dealsOnly, [fromRs1000], opts)).toBeNull();
    expect(matchOffer(dealsOnly, [noMinimum], opts)).toBeNull();
    expect(matchOffer(orderOf([DEAL], { mode: 'takeaway' }), [offer({ cameBy: 'any', orderTypes: ['takeaway'] })], opts)).toBeNull();
    // No "add Rs N more food" and no "save the phone" for an offer that would take nothing off.
    expect(offerHint(dealsOnly, { askCameBy: false, offers: [fromRs1000] }, false)).toBeNull();
    expect(offerHint(orderOf([DEAL, CHARGE], { hasPhone: false }), { askCameBy: false, offers: [offer()] }, false)).toBeNull();
  });

  it('a deal and Rs 500 of fries: Rs 500 towards a "from Rs 2,000" offer, so none; 10% with no minimum is Rs 50', () => {
    const dealAndFries = orderOf([DEAL, FRIES, CHARGE]);
    expect(dealAndFries.foodCents).toBe(50_000);
    expect(matchOffer(dealAndFries, [offer({ cameBy: 'any', minOrderCents: 200_000 })], opts)).toBeNull();
    expect(matchOffer(dealAndFries, [noMinimum], opts)?.amountCents).toBe(5_000);
    // The switch on: the delivery charge in too, still never the deal (10% of Rs 700).
    expect(matchOffer(dealAndFries, [noMinimum], { ...opts, alsoOffDeliveryCharge: true })?.amountCents).toBe(7_000);
    expect(offerAmount(noMinimum, dealAndFries.foodCents, dealAndFries.foodCents)).toBe(5_000);
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

  it('the owner saving a bigger offer never moves an order already on screen: it keeps the one it got while that fits', () => {
    // The owner saved again since the 20% went on: a new 25% is in the list.
    const bigger = offer({ id: 'big', name: 'Big', cameBy: 'any', value: 25 });
    const afterSave = { ...opts, settingsAt: '2026-10-02T08:00:00.000Z' };
    expect(matchOffer(order(), [bigger], { ...afterSave, current: frozen })).toMatchObject({ isCurrent: true, amountCents: 40_000 });
    // …but once its own terms stop fitting (the chip changed), the list decides afresh.
    const walkIn = offer({ id: 'walk', name: 'Walk-in 5%', cameBy: ['walk_in'], value: 5 });
    expect(matchOffer(order({ cameBy: 'walk_in' }), [walkIn], { ...afterSave, current: frozen })?.rule.offer.id).toBe('walk');
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
    // THE reader every after-the-fact place uses (tax split, FBR, profit): food only, value deals left out.
    expect(discountRuleAlsoOffDeliveryCharge(json)).toBe(false);
    expect(parseDiscountBaseRule(json)).toEqual({ kind: 'discount_base', v: 1, alsoOffDeliveryCharge: false, from: 'till', skipsNoDiscountLines: true });
    expect(parseOfferRule(JSON.stringify(declinedOfferRule(rule)))?.offer.declined).toBe(true);
  });

  it('freezes "value deals never" with the offer, and reads it back; an offer frozen before 0.7.34 has none', () => {
    const rule = offerRule(offerTerms(offer(), '2026-10-01T10:00:00.000Z'), false);
    expect(rule.skipsNoDiscountLines).toBe(true);
    expect(offerRule(offerTerms(offer(), null), true).skipsNoDiscountLines).toBe(true);
    const json = JSON.stringify(rule);
    expect(parseOfferRule(json)?.skipsNoDiscountLines).toBe(true);
    expect(discountRuleScope(json)).toEqual({ alsoOffDeliveryCharge: false, skipsNoDiscountLines: true });
    expect(parseOfferRule(JSON.stringify(declinedOfferRule(rule)))?.skipsNoDiscountLines).toBe(true);
    // A new offer put on by matchOffer carries it.
    expect(matchOffer(order(), [offer()], opts)?.rule.skipsNoDiscountLines).toBe(true);
    // Frozen before 0.7.34: it was worked over the deals too, and is read so.
    const { skipsNoDiscountLines: _left, ...before } = rule;
    const old = JSON.stringify(before);
    expect(parseOfferRule(old)).toEqual(before);
    expect(Object.keys(parseOfferRule(old) ?? {})).not.toContain('skipsNoDiscountLines');
    expect(discountRuleScope(old)).toEqual({ alsoOffDeliveryCharge: false, skipsNoDiscountLines: false });
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
    // Once a customer a day: only the till knows whether that phone had it today, so the hint says it may not go on.
    expect(offerHint(order({ hasPhone: false }), rules({ offers: [offer({ oncePerCustomerPerDay: true })] }), false)).toEqual({
      name: 'Test WhatsApp 10%',
      needs: 'phone',
      oncePerDay: true,
    });
    expect(offerHint(order({ foodCents: 100_000 }), rules({ offers: [offer({ minOrderCents: 150_000 })] }), false)).toEqual({
      name: 'Test WhatsApp 10%',
      needs: 'more_food',
      fromCents: 150_000,
    });
    expect(offerHint(order({ source: 'web' }), rules(), false)).toBeNull();
  });
});

describe('Team & leakage: 1.5 × the shop', () => {
  const shop = { counterOrders: 100, phoneOrWhatsapp: 20, offerOrders: 20, offerCents: 100_000 };

  it('flags a share of Phone / WhatsApp orders over 1.5 × the shop’s, and offers’ rupees per order likewise', () => {
    // The shop: 20%. 30% is exactly 1.5 ×: not flagged; 31% is.
    expect(offerFlags({ counterOrders: 100, phoneOrWhatsapp: 30, offerOrders: 30, offerCents: 150_000 }, shop)).toEqual([]);
    expect(offerFlags({ counterOrders: 100, phoneOrWhatsapp: 31, offerOrders: 31, offerCents: 150_100 }, shop)).toEqual(['phone_share', 'offer_rupees']);
    expect(offerFlags({ counterOrders: 40, phoneOrWhatsapp: 4, offerOrders: 4, offerCents: 90_000 }, shop)).toEqual(['offer_rupees']);
  });

  it('no minimum of orders taken: a part-timer with 19 orders, every one marked WhatsApp with Rs 200 off, is flagged', () => {
    expect(offerFlags({ counterOrders: 19, phoneOrWhatsapp: 19, offerOrders: 19, offerCents: 19 * 20_000 }, shop)).toEqual([
      'phone_share',
      'offer_rupees',
    ]);
    expect(offerFlags({ counterOrders: 3, phoneOrWhatsapp: 2, offerOrders: 2, offerCents: 40_000 }, shop)).toEqual(['phone_share', 'offer_rupees']);
  });

  it('one order alone is never a pattern: a flag needs at least two such orders; and nothing against a shop with none', () => {
    expect(OFFER_FLAG_MIN_MARKED).toBe(2);
    expect(offerFlags({ counterOrders: 1, phoneOrWhatsapp: 1, offerOrders: 1, offerCents: 20_000 }, shop)).toEqual([]);
    expect(offerFlags({ counterOrders: 30, phoneOrWhatsapp: 0, offerOrders: 0, offerCents: 0 }, { counterOrders: 0, phoneOrWhatsapp: 0, offerOrders: 0, offerCents: 0 })).toEqual([]);
    expect(offerFlags({ counterOrders: 0, phoneOrWhatsapp: 0, offerOrders: 0, offerCents: 0 }, shop)).toEqual([]);
  });

  it('worked on the orders whose way in was tapped: Walk-in, Phone or WhatsApp — never "not asked"', () => {
    expect(['walk_in', 'phone', 'whatsapp'].map(cameByWasTapped)).toEqual([true, true, true]);
    expect([null, undefined, 'website', 'foodpanda', 'not_asked'].map(cameByWasTapped)).toEqual([false, false, false, false, false]);
    // The history reviewer's month: 600 counter orders, 500 from before the offers (never asked), 30 of the
    // 100 asked marked Phone / WhatsApp; a cashier who worked only since, at exactly that 30%, is not flagged.
    const asked = { counterOrders: 100, phoneOrWhatsapp: 30, offerOrders: 30, offerCents: 30 * 20_000 };
    expect(offerFlags({ counterOrders: 40, phoneOrWhatsapp: 12, offerOrders: 12, offerCents: 12 * 20_000 }, asked)).toEqual([]);
  });
});
