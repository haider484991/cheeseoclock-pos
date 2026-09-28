import { describe, expect, it } from 'vitest';
import { DEFAULT_DISCOUNT_OFFERS, type ChannelOffer } from '@cheeseoclock/shared-types';
import { discountOffersSchema } from '@cheeseoclock/shared-schemas';
import {
  OFFER_RULES_NOTE,
  dayWords,
  hourWords,
  newOfferForm,
  newOfferId,
  offerExample,
  offerSummary,
  offersFromForm,
  offersSummary,
  offersToForm,
} from './offerRules';
import { withCameByNeeded, CAME_BY_NEEDED } from '../../checkout/useTenderGate';

/**
 * Settings → Money & discounts → "Automatic offers": what the owner types ↔
 * what is saved, and the card's words, built from the values. Every name
 * and figure is made up.
 */
const offer = (over: Partial<ChannelOffer> = {}): ChannelOffer => ({
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
});

describe('the form', () => {
  it('round-trips every saved value, and what it saves passes the main process’s schema', () => {
    for (const o of [
      offer(),
      offer({ cameBy: 'any', orderTypes: ['takeaway', 'delivery'], type: 'flat', value: 30_000, minOrderCents: 150_000, maxOffCents: 50_000 }),
      offer({ days: [4, 5], hours: { fromHour: 22, toHour: 1 }, startsOn: '2026-10-01', endsOn: '2026-10-31', oncePerCustomerPerDay: true }),
      offer({ hours: { fromHour: 12, toHour: 15 } }),
      offer({ hours: { fromHour: 18, toHour: 23 } }),
    ]) {
      const value = { v: 1, askCameBy: true, offers: [o] };
      const back = offersFromForm(offersToForm(value));
      expect(back).toEqual({ value, problem: null });
      expect(discountOffersSchema.safeParse(back.value).success).toBe(true);
    }
    expect(offersFromForm(offersToForm(DEFAULT_DISCOUNT_OFFERS))).toEqual({ value: { v: 1, askCameBy: false, offers: [] }, problem: null });
  });

  it('a new offer is on, DELIVERY ONLY, any way, 10% of the food, every day, all day — with a fresh id', () => {
    const f = newOfferForm(['a']);
    expect(f).toMatchObject({ on: true, anyWay: true, takeaway: false, delivery: true, type: 'percent', amount: '10', allDay: true, days: [0, 1, 2, 3, 4, 5, 6] });
    expect(offersFromForm({ askCameBy: false, offers: [{ ...f, name: 'Test new' }] }).value?.offers[0]).toMatchObject({
      cameBy: 'any',
      orderTypes: ['delivery'],
      type: 'percent',
      value: 10,
    });
    expect(newOfferId(['x'], 1, () => 0)).toMatch(/^o[a-z0-9]+$/);
    expect(newOfferId([newOfferId([], 5, () => 0)], 5, () => 0)).not.toBe(newOfferId([], 5, () => 0));
  });

  it('says what is wrong before Save, naming the offer', () => {
    const f = (over: Partial<ReturnType<typeof newOfferForm>>) => offersFromForm({ askCameBy: false, offers: [{ ...newOfferForm([]), name: 'Test', ...over }] }).problem;
    expect(f({ name: '  ' })).toBe('Offer 1: give it a name — it prints on the bill.');
    expect(f({ amount: '60' })).toBe('“Test”: the % off is a whole % from 1 to 50.');
    expect(f({ type: 'flat', amount: '6000' })).toBe('“Test”: the rupees off are whole rupees, Rs 1 to Rs 5,000.');
    expect(f({ anyWay: false, cameBy: [] })).toBe('“Test”: pick how the order came in, or “Any way”.');
    expect(f({ delivery: false })).toBe('“Test”: pick takeaway, delivery or both.');
    expect(f({ days: [] })).toBe('“Test”: pick at least one day.');
    expect(f({ allDay: false, fromHour: '12', untilHour: '12' })).toBe('“Test”: the hours start and end at the same time — pick “All day” instead.');
    expect(f({ startsOn: '2026-10-05', endsOn: '2026-10-04' })).toBe('“Test”: it can’t end before it starts.');
    expect(f({ maxOff: '0' })).toBe('“Test”: the most off one order is whole rupees, Rs 1 to Rs 50,000, or empty.');
    const twins = offersFromForm({ askCameBy: false, offers: [{ ...newOfferForm([]), name: 'Same' }, { ...newOfferForm(['z']), id: 'other', name: 'same' }] });
    expect(twins.problem).toMatch(/Two offers are called “Same”/);
  });
});

describe('the words', () => {
  it('one line per offer, and the whole setting for History', () => {
    expect(offerSummary(offer())).toBe('10% off the food · deliveries · came by WhatsApp · every day, all day');
    expect(
      offerSummary(offer({ cameBy: ['phone', 'whatsapp'], orderTypes: ['takeaway', 'delivery'], type: 'flat', value: 30_000, minOrderCents: 150_000, maxOffCents: 50_000, days: [0, 1, 2, 3], hours: { fromHour: 12, toHour: 15 }, oncePerCustomerPerDay: true, startsOn: '2026-10-01', endsOn: '2026-10-31' })),
    ).toBe(
      'Rs 300 off the food · takeaway and delivery · came by Phone or WhatsApp · Mon to Thu, 12:00 to 16:00 · from Rs 1,500 of food · at most Rs 500 · once a customer a day · 2026-10-01 to 2026-10-31',
    );
    expect(offersSummary(DEFAULT_DISCOUNT_OFFERS)).toBe('No automatic offers; the cashier is not asked how orders came in');
    expect(offersSummary({ v: 1, askCameBy: true, offers: [offer(), offer({ id: 'b', name: 'Test off', on: false })] })).toBe(
      '2 offers: Test WhatsApp 10% (10% off), Test off (off); the cashier is asked how each order came in',
    );
    expect(dayWords([4, 5])).toBe('Fri and Sat');
    expect(hourWords({ fromHour: 22, toHour: 1 })).toBe('22:00 to 02:00');
  });

  it('the worked example is worked as the till works it: on the food, the minimum on the food', () => {
    expect(offerExample(offer(), false)).toBe(
      'A delivery that came by WhatsApp, Rs 2,000 of food and a Rs 200 delivery charge: 10% off takes Rs 200 off the food. The Rs 200 delivery charge is paid in full.',
    );
    expect(offerExample(offer(), true)).toBe(
      'A delivery that came by WhatsApp, Rs 2,000 of food and a Rs 200 delivery charge: 10% off takes Rs 220 off the bill. It comes off the delivery charge too (your setting below).',
    );
    expect(offerExample(offer({ minOrderCents: 250_000 }), false)).toBe(
      'A delivery that came by WhatsApp, Rs 2,000 of food and a Rs 200 delivery charge: nothing off — it starts from Rs 2,500 of food.',
    );
    expect(offerExample(offer({ cameBy: 'any', orderTypes: ['takeaway'], type: 'flat', value: 30_000 }), false)).toBe(
      'A takeaway, Rs 2,000 of food: Rs 300 off takes Rs 300 off the food.',
    );
    expect(OFFER_RULES_NOTE.join(' ')).toMatch(/never on a website or foodpanda order/);
  });
});

describe('Send and Pay wait for a came-by button when the owner asks', () => {
  const ok = { ok: true, missing: [] };
  it('on a counter takeaway or delivery with no button lit; never on foodpanda or a website order', () => {
    expect(withCameByNeeded(ok, { askCameBy: true, mode: 'delivery', source: 'pos', cameBy: null })).toEqual({ ok: false, missing: [CAME_BY_NEEDED] });
    expect(withCameByNeeded(ok, { askCameBy: true, mode: 'takeaway', source: 'pos', cameBy: 'walk_in' })).toBe(ok);
    expect(withCameByNeeded(ok, { askCameBy: false, mode: 'delivery', source: 'pos', cameBy: null })).toBe(ok);
    expect(withCameByNeeded(ok, { askCameBy: true, mode: 'foodpanda', source: 'pos', cameBy: null })).toBe(ok);
    expect(withCameByNeeded(ok, { askCameBy: true, mode: 'delivery', source: 'web', cameBy: null })).toBe(ok);
  });
});
