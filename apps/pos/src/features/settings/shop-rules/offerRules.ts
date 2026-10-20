import { getShopLocale, shopIsInPakistan } from '@cheeseoclock/shared-types';
/**
 * Settings → Money & discounts → "Automatic offers" ('discounts.offers'):
 * what is typed ↔ what is saved, and the card's words. The main process
 * checks every value again with the key's schema (shared-schemas
 * business-settings.ts); this only says what is wrong before Save, in the
 * same plain words, naming the offer. Every number in the words comes from
 * the values (pos-domain offerAmount works the example, as the till does).
 */
import { formatCents, isCategoryOffer, offerAmount } from '@cheeseoclock/pos-domain';
import {
  CAME_BY_CHOICES,
  CAME_BY_LABEL,
  NOT_ON_VALUE_DEALS,
  OFFER_CATEGORIES_MAX,
  OFFER_ID_RE,
  OFFER_MAX_FLAT_CENTS,
  OFFER_MAX_ORDER_CENTS,
  OFFER_MAX_PERCENT,
  OFFER_NAME_MAX,
  OFFERS_MAX,
  SHOP_SETTING_FORMAT,
  type CameBy,
  type ChannelOffer,
  type DiscountOffers,
  type OfferOrderType,
} from '@cheeseoclock/shared-types';
import { andList, centsFromRupeesText } from './foodpandaWords';
import type { Parsed } from './foodpandaForm';

/** Monday first, as the trading week runs (0 = Monday … 6 = Sunday). */
export const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6] as const;

/** One offer as the card edits it. */
export interface OfferForm {
  id: string;
  name: string;
  on: boolean;
  /** "Any way": the cashier needn't say how it came in. */
  anyWay: boolean;
  cameBy: CameBy[];
  takeaway: boolean;
  delivery: boolean;
  type: 'percent' | 'flat';
  /** The % or the rupees, as typed. */
  amount: string;
  /** On some categories only (0.7.44), and which; off = the whole menu. */
  onCategories: boolean;
  categoryIds: string[];
  minOrder: string;
  maxOff: string;
  days: number[];
  allDay: boolean;
  /** The first hour, "0"–"23". */
  fromHour: string;
  /** Until this hour (not included), "1"–"24" (24 = midnight). */
  untilHour: string;
  startsOn: string;
  endsOn: string;
  oncePerCustomerPerDay: boolean;
}

export interface OffersForm {
  askCameBy: boolean;
  offers: OfferForm[];
}

const rupeesText = (cents: number | null) => (cents === null ? '' : String(cents / 100));

export function offerToForm(o: ChannelOffer): OfferForm {
  return {
    id: o.id,
    name: o.name,
    on: o.on,
    anyWay: o.cameBy === 'any',
    cameBy: o.cameBy === 'any' ? [] : [...o.cameBy],
    takeaway: o.orderTypes.includes('takeaway'),
    delivery: o.orderTypes.includes('delivery'),
    type: o.type,
    amount: o.type === 'percent' ? String(o.value) : String(o.value / 100),
    onCategories: isCategoryOffer(o),
    categoryIds: [...(o.categoryIds ?? [])],
    minOrder: rupeesText(o.minOrderCents),
    maxOff: rupeesText(o.maxOffCents),
    days: [...o.days].sort((a, b) => a - b),
    allDay: o.hours === null,
    fromHour: o.hours ? String(o.hours.fromHour) : '12',
    untilHour: o.hours ? String(((o.hours.toHour + 1) % 24) || 24) : '16',
    startsOn: o.startsOn ?? '',
    endsOn: o.endsOn ?? '',
    oncePerCustomerPerDay: o.oncePerCustomerPerDay,
  };
}

export function offersToForm(v: DiscountOffers): OffersForm {
  return { askCameBy: v.askCameBy, offers: v.offers.map(offerToForm) };
}

/** A fresh id (letters and digits), different from `taken`. */
export function newOfferId(taken: ReadonlyArray<string>, now: number = Date.now(), rand: () => number = Math.random): string {
  for (;;) {
    const id = `o${now.toString(36)}${Math.floor(rand() * 1_000_000).toString(36)}`;
    if (!taken.includes(id) && OFFER_ID_RE.test(id)) return id;
    now += 1;
  }
}

/**
 * A new offer: on, DELIVERY ONLY (there the rider, not the cashier, takes the
 * cash — takeaway must be chosen on purpose), any way it came in, 10% off the
 * food, every day, all day.
 */
export function newOfferForm(taken: ReadonlyArray<string>): OfferForm {
  return {
    id: newOfferId(taken),
    name: '',
    on: true,
    anyWay: true,
    cameBy: [],
    takeaway: false,
    delivery: true,
    type: 'percent',
    amount: '10',
    onCategories: false,
    categoryIds: [],
    minOrder: '',
    maxOff: '',
    days: [...ALL_DAYS],
    allDay: true,
    fromHour: '12',
    untilHour: '16',
    startsOn: '',
    endsOn: '',
    oncePerCustomerPerDay: false,
  };
}


function offerFromForm(f: OfferForm, i: number): Parsed<ChannelOffer> {
  const name = f.name.replace(/\s+/g, ' ').trim();
  const who = name ? `“${name}”` : `Offer ${i + 1}`;
  const bad = (problem: string): Parsed<ChannelOffer> => ({ value: null, problem: `${who}: ${problem}` });
  if (!name) return bad('give it a name — it prints on the bill.');
  if (name.length > OFFER_NAME_MAX) return bad(`keep the name to ${OFFER_NAME_MAX} letters.`);
  if (!f.anyWay && f.cameBy.length === 0) return bad('pick how the order came in, or “Any way”.');
  const orderTypes: OfferOrderType[] = [...(f.takeaway ? (['takeaway'] as const) : []), ...(f.delivery ? (['delivery'] as const) : [])];
  if (orderTypes.length === 0) return bad('pick takeaway, delivery or both.');
  const amt = f.amount.trim().replace(/,/g, '');
  let value: number;
  if (f.type === 'percent') {
    if (!/^\d{1,2}$/.test(amt) || Number(amt) < 1 || Number(amt) > OFFER_MAX_PERCENT) return bad(`the % off is a whole % from 1 to ${OFFER_MAX_PERCENT}.`);
    value = Number(amt);
  } else {
    const cents = centsFromRupeesText(amt);
    if (cents === null || Number.isNaN(cents) || cents < 100 || cents > OFFER_MAX_FLAT_CENTS) return bad(`the ${getShopLocale().words.major} off are whole ${getShopLocale().words.major}, ${formatCents(100)} to ${formatCents(OFFER_MAX_FLAT_CENTS)}.`);
    value = cents;
  }
  const categoryIds = [...new Set(f.categoryIds)];
  if (f.onCategories && categoryIds.length === 0) return bad('pick at least one category, or “The whole menu”.');
  if (f.onCategories && categoryIds.length > OFFER_CATEGORIES_MAX) return bad(`pick at most ${OFFER_CATEGORIES_MAX} categories.`);
  const minOrderCents = centsFromRupeesText(f.minOrder);
  if (Number.isNaN(minOrderCents) || (minOrderCents ?? 0) > OFFER_MAX_ORDER_CENTS) return bad(`the smallest order is whole ${getShopLocale().words.major} up to ${formatCents(OFFER_MAX_ORDER_CENTS)}, or empty.`);
  const maxOffCents = centsFromRupeesText(f.maxOff);
  if (Number.isNaN(maxOffCents) || maxOffCents === 0 || (maxOffCents ?? 0) > OFFER_MAX_ORDER_CENTS) {
    return bad(`the most off one order is whole ${getShopLocale().words.major}, ${formatCents(100)} to ${formatCents(OFFER_MAX_ORDER_CENTS)}, or empty.`);
  }
  const days = [...new Set(f.days)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
  if (days.length === 0) return bad('pick at least one day.');
  let hours: ChannelOffer['hours'] = null;
  if (!f.allDay) {
    const from = Number(f.fromHour);
    const until = Number(f.untilHour);
    if (!Number.isInteger(from) || from < 0 || from > 23 || !Number.isInteger(until) || until < 1 || until > 24) return bad('pick its hours, or “All day”.');
    if (from === until % 24) return bad('the hours start and end at the same time — pick “All day” instead.');
    hours = { fromHour: from, toHour: (until + 23) % 24 };
  }
  const startsOn = f.startsOn.trim() || null;
  const endsOn = f.endsOn.trim() || null;
  if (startsOn && endsOn && endsOn < startsOn) return bad('it can’t end before it starts.');
  return {
    value: {
      id: f.id,
      name,
      on: f.on,
      cameBy: f.anyWay ? 'any' : CAME_BY_CHOICES.filter((c) => f.cameBy.includes(c)),
      orderTypes,
      type: f.type,
      value,
      // On some categories only: the list. The whole menu writes NO field at all, so a till older than
      // 0.7.44 reads the offer exactly as before (a field it does not know would switch its offers off).
      ...(f.onCategories ? { categoryIds } : {}),
      minOrderCents,
      maxOffCents,
      days,
      hours,
      startsOn,
      endsOn,
      oncePerCustomerPerDay: f.oncePerCustomerPerDay,
    },
    problem: null,
  };
}

export function offersFromForm(f: OffersForm): Parsed<DiscountOffers> {
  if (f.offers.length > OFFERS_MAX) return { value: null, problem: `At most ${OFFERS_MAX} offers.` };
  const offers: ChannelOffer[] = [];
  for (const [i, o] of f.offers.entries()) {
    const p = offerFromForm(o, i);
    if (p.value === null) return p;
    offers.push(p.value);
  }
  const names = offers.map((o) => o.name.toLowerCase());
  const twin = names.find((n, i) => names.indexOf(n) !== i);
  if (twin !== undefined) return { value: null, problem: `Two offers are called “${offers[names.indexOf(twin)]!.name}” — each prints on the bill, so give them different names.` };
  return { value: { v: SHOP_SETTING_FORMAT['discounts.offers'], askCameBy: f.askCameBy, offers }, problem: null };
}

/**
 * An offer's on / off switch on its row, saved at once: the SAVED offers
 * with only this one switched — nothing typed and not yet saved goes with
 * it (it is saved by Save, or not at all).
 */
export function withOfferSwitched(saved: DiscountOffers, id: string): DiscountOffers {
  return { ...saved, offers: saved.offers.map((o) => (o.id === id ? { ...o, on: !o.on } : o)) };
}

/** The form after the switch was saved: that offer's switch as saved, everything else typed kept. */
export function formWithOfferSwitched(form: OffersForm, id: string, on: boolean): OffersForm {
  return { ...form, offers: form.offers.map((o) => (o.id === id ? { ...o, on } : o)) };
}

// -------------------------------------------------------------- words --

/** "10% off", "Rs 300 off". */
export function offerAmountWords(o: Pick<ChannelOffer, 'type' | 'value'>): string {
  return o.type === 'percent' ? `${o.value}% off` : `${formatCents(o.value)} off`;
}

/** "WhatsApp", "Phone or WhatsApp", "any way". */
export function cameByWords(c: ChannelOffer['cameBy']): string {
  if (c === 'any') return 'any way';
  return andList(c.map((x) => CAME_BY_LABEL[x])).replace(/ and /g, ' or ');
}

/** "every day", "Fri and Sat", "Mon to Thu". */
export function dayWords(days: ReadonlyArray<number>): string {
  const d = [...new Set(days)].sort((a, b) => a - b);
  if (d.length === 7) return 'every day';
  const run = d.length > 2 && d.every((x, i) => i === 0 || x === d[i - 1]! + 1);
  if (run) return `${DAY_SHORT[d[0]!]} to ${DAY_SHORT[d[d.length - 1]!]}`;
  return andList(d.map((x) => DAY_SHORT[x]!));
}

/** "12:00 to 16:00", "all day". */
export function hourWords(h: ChannelOffer['hours']): string {
  if (!h) return 'all day';
  const hh = (n: number) => `${String(n).padStart(2, '0')}:00`;
  return `${hh(h.fromHour)} to ${hh((h.toHour + 1) % 24)}`;
}

/**
 * One offer in a line (its card row, History): "10% off the food ·
 * deliveries · came by WhatsApp · every day, all day · from Rs 1,500 ·
 * at most Rs 500 · once a customer a day · 1–31 Oct". "10% off the food,
 * not on value deals · …" while a category is never discounted
 * (`notOnValueDeals`, Menu → Categories): an offer never comes off them.
 */
export function offerSummary(o: ChannelOffer, notOnValueDeals = false, names?: ReadonlyMap<string, string>): string {
  const parts: string[] = [];
  parts.push(
    isCategoryOffer(o)
      ? `${offerAmountWords(o)} ${categoryWords(o.categoryIds!, names)} only`
      : `${offerAmountWords(o)} the food${notOnValueDeals ? `, ${NOT_ON_VALUE_DEALS}` : ''}`,
  );
  parts.push(o.orderTypes.length === 2 ? 'takeaway and delivery' : o.orderTypes[0] === 'delivery' ? 'deliveries' : 'takeaways');
  parts.push(o.cameBy === 'any' ? 'any way it came in' : `came by ${cameByWords(o.cameBy)}`);
  parts.push(`${dayWords(o.days)}, ${hourWords(o.hours)}`);
  if (o.minOrderCents !== null) parts.push(`from ${formatCents(o.minOrderCents)} of food`);
  if (o.maxOffCents !== null) parts.push(`at most ${formatCents(o.maxOffCents)}`);
  if (o.oncePerCustomerPerDay) parts.push('once a customer a day');
  if (o.startsOn || o.endsOn) parts.push(o.startsOn && o.endsOn ? `${o.startsOn} to ${o.endsOn}` : o.startsOn ? `from ${o.startsOn}` : `until ${o.endsOn}`);
  return parts.join(' · ');
}

/** "Regular Pizzas and Burgers" — an offer's categories by their names now (one deleted since: "a category no longer on the menu"). */
export function categoryWords(ids: ReadonlyArray<string>, names?: ReadonlyMap<string, string>): string {
  const known = ids.map((id) => names?.get(id) ?? null);
  const shown = known.filter((n): n is string => n !== null);
  const gone = known.length - shown.length;
  const all = [...shown, ...(gone > 0 ? [gone === 1 ? 'a category no longer on the menu' : `${gone} categories no longer on the menu`] : [])];
  return all.length > 0 ? andList(all) : 'its categories';
}

/** The whole setting in one line, for History and "Put back the default". */
export function offersSummary(v: DiscountOffers): string {
  const asked = v.askCameBy ? 'the cashier is asked how each order came in' : 'the cashier is not asked how orders came in';
  if (v.offers.length === 0) return `No automatic offers; ${asked}`;
  const list = v.offers.map((o) => `${o.name} (${o.on ? offerAmountWords(o) : 'off'})`).join(', ');
  return `${v.offers.length} offer${v.offers.length === 1 ? '' : 's'}: ${list}; ${asked}`;
}

/** The worked example's order: Rs 2,000 of food and a Rs 200 delivery charge (made up). */
export const EXAMPLE_FOOD_CENTS = 200_000;
export const EXAMPLE_CHARGE_CENTS = 20_000;

/**
 * The worked example for one offer, worked the way the till works it (the
 * food only unless the owner's switch says the delivery charge too; the
 * minimum on the food): "A delivery that came by WhatsApp, Rs 2,000 of food
 * and a Rs 200 delivery charge: 10% off takes Rs 200 off the food. The Rs
 * 200 delivery charge is paid in full."
 */
export function offerExample(o: ChannelOffer, alsoOffDeliveryCharge: boolean, names?: ReadonlyMap<string, string>): string {
  const on = o.orderTypes.includes('delivery') ? 'delivery' : 'takeaway';
  if (isCategoryOffer(o)) {
    // On some categories: Rs 2,000 of their items on the order; never the delivery charge.
    const off = offerAmount(o, EXAMPLE_FOOD_CENTS, EXAMPLE_FOOD_CENTS);
    const what = categoryWords(o.categoryIds!, names);
    if (off === 0) return `A ${on} with ${formatCents(EXAMPLE_FOOD_CENTS)} of ${what}: nothing off — it starts from ${formatCents(o.minOrderCents ?? 0)} of food.`;
    return `A ${on} with ${formatCents(EXAMPLE_FOOD_CENTS)} of ${what}: ${offerAmountWords(o)} takes ${formatCents(off)} off them, on its own line of the bill. The rest of the food takes your whole-menu offer, if one fits — never both on one item.`;
  }
  const charge = on === 'delivery' ? EXAMPLE_CHARGE_CENTS : 0;
  const base = alsoOffDeliveryCharge ? EXAMPLE_FOOD_CENTS + charge : EXAMPLE_FOOD_CENTS;
  const off = offerAmount(o, base, EXAMPLE_FOOD_CENTS);
  const how = o.cameBy === 'any' ? '' : ` that came by ${cameByWords(o.cameBy)}`;
  const order = `A ${on}${how}, ${formatCents(EXAMPLE_FOOD_CENTS)} of food${charge ? ` and a ${formatCents(charge)} delivery charge` : ''}`;
  if (off === 0) {
    return `${order}: nothing off — it starts from ${formatCents(o.minOrderCents ?? 0)} of food.`;
  }
  const tail = charge
    ? alsoOffDeliveryCharge
      ? ' It comes off the delivery charge too (your setting below).'
      : ` The ${formatCents(charge)} delivery charge is paid in full.`
    : '';
  return `${order}: ${offerAmountWords(o)} takes ${formatCents(off)} off${alsoOffDeliveryCharge && charge ? ' the bill' : ' the food'}.${tail}`;
}

/** The rules every offer follows, as the card says them: in the shop's money, and
 * foodpanda only where the till takes it (Pakistan). */
export function offerRulesNote(): readonly string[] {
  const l = getShopLocale();
  return [
    `The till puts the biggest offer that fits on a counter order by itself — never on a website${shopIsInPakistan(l) ? ' or foodpanda' : ''} order. An offer on some categories goes on beside it: their items take that offer, the rest of the food the whole-menu one, never both on one item, and each prints on its own line. A cashier’s discount (F3) replaces them all with the usual manager rule, and removing that brings the offers back.`,
    'Phone and WhatsApp offers need the customer’s phone on the order. How the order came in is locked when it is sent: changing it after needs a manager’s PIN or password, and the till keeps a record.',
    `The offer’s name prints on the bill. An order keeps the terms it got; a change here is for orders started from then on. Reports list offers under Standing offers, and Team & leakage flags a cashier with far more Phone or WhatsApp orders, or offer ${l.words.major}, than the shop.`,
  ];
}
