/**
 * The owner's automatic offers (Settings → Money & discounts,
 * 'discounts.offers'; shared-types shop-settings.ts) as pure rules. The
 * owner, 28 Sep 2026: "the offer discount should have settings … so it
 * automatically applies on the whole order except delivery fee".
 *
 * The values come in as parameters; nothing here reads a setting, a clock or
 * the database, so the tests pin every edge. The same rules run in the main
 * process (order-repo puts the offer on and re-works it) and on the screen
 * (the came-by chips, the cart's hint), so the two can't disagree.
 *
 *  - WHICH ORDERS: a counter order only (source 'pos', not foodpanda),
 *    takeaway or delivery as the offer says. Never a website order (the
 *    website prices its own orders and the till honours them) and never a
 *    foodpanda order (the foodpanda deal is its own). Website offers come
 *    later with the website settings block (Settings plan step 3): they will
 *    be priced by the website, never by matchOffer.
 *  - WHEN: when the order was STARTED, Pakistan time: its trading day (from
 *    05:00, so 01:30 on Saturday is Friday's) for the days and the dates, its
 *    clock hour for the hours.
 *  - ON WHAT: the food — the delivery charge is paid in full unless the
 *    owner's "A discount also comes off the delivery charge" said Yes when the
 *    offer went on (frozen with it). The minimum is always measured on the
 *    food.
 *  - WHICH ONE: the biggest that fits. The one already on the order keeps
 *    its FROZEN terms while they still fit (a Save while the order is open
 *    can't move it; a switched-off offer stops for new orders at once, not
 *    for one already open); a live offer replaces it only by taking more off.
 *    Ties keep the one on the order, then the owner's order of the list.
 *  - ABUSE: an offer claimed because the order came by Phone or WhatsApp,
 *    and any "once per customer per day" offer, needs the customer's phone on
 *    the order; "once per customer per day" is checked against that phone's
 *    other orders today (`usedToday`, from the database).
 *
 * The approval limit does NOT apply: the offer is the owner's own rule
 * (approved by the owner who saved it). One discount per order stays: a
 * staff discount (F3) replaces the offer, and the offer never replaces one.
 */
import {
  CAME_BY_CHOICES,
  daypartHours,
  type CameBy,
  type ChannelOffer,
  type CounterOffers,
  type OfferFlag,
  type OfferOrderType,
  type OfferRule,
  type OfferTerms,
  type OrderCameBy,
} from '@cheeseoclock/shared-types';
import { computeDiscountCents } from './discount.js';
import { dayYmd, pakistanHourOfMs, tradingDayOfMs, weekdayOfDay } from './trends.js';

/** The order as an offer sees it. */
export interface OfferOrder {
  /** 'pos' (the counter) or 'web'. */
  source: string;
  mode: string;
  /** orders.came_by: how it came in; null/undefined = not said. */
  cameBy?: OrderCameBy | null;
  /** The customer's phone is on the order. */
  hasPhone: boolean;
  /** When the order was started (orders.created_at, ISO). */
  createdAt: string;
  /** The food, before tax (the delivery charge left out): the minimum is measured on it. */
  foodCents: number;
  /** Every line, before tax (the subtotal): what an offer that also comes off the delivery charge is worked on. */
  subtotalCents: number;
}

/** An order an automatic offer can ever be on: a counter order that is not foodpanda. */
export function offerCanApplyTo(order: Pick<OfferOrder, 'source' | 'mode'>): boolean {
  return order.source === 'pos' && order.mode !== 'foodpanda';
}

/**
 * The trading day (YYYY-MM-DD), its weekday (0 = Monday) and the Pakistan
 * clock hour of the instant an order was started; null for a date that does
 * not read.
 */
export function offerTimeOf(createdAt: string): { day: string; weekday: number; hour: number } | null {
  const ms = Date.parse(createdAt);
  if (!Number.isFinite(ms)) return null;
  const dayNumber = tradingDayOfMs(ms);
  return { day: dayYmd(dayNumber), weekday: weekdayOfDay(dayNumber), hour: pakistanHourOfMs(ms) };
}

/** On, and its first and last day around the trading day `day` (YYYY-MM-DD). */
export function offerRunsOnDay(offer: Pick<ChannelOffer, 'on' | 'startsOn' | 'endsOn'>, day: string): boolean {
  if (!offer.on) return false;
  if (offer.startsOn && day < offer.startsOn) return false;
  if (offer.endsOn && day > offer.endsOn) return false;
  return true;
}

/**
 * Does the offer run for an order started at `createdAt`: on, inside its
 * dates, on one of its days, in its hours — the trading day and the clock
 * hour in Pakistan.
 */
export function offerRunsAt(
  offer: Pick<ChannelOffer, 'on' | 'days' | 'hours' | 'startsOn' | 'endsOn'>,
  createdAt: string,
): boolean {
  const t = offerTimeOf(createdAt);
  if (!t || !offerRunsOnDay(offer, t.day)) return false;
  if (!offer.days.includes(t.weekday)) return false;
  if (offer.hours && !daypartHours(offer.hours).includes(t.hour)) return false;
  return true;
}

/** The terms frozen onto an order when the offer goes on (settingsAt: when 'discounts.offers' was saved). */
export function offerTerms(offer: ChannelOffer, settingsAt: string | null): OfferTerms {
  return {
    v: 1,
    id: offer.id,
    name: offer.name,
    type: offer.type,
    value: offer.value,
    minOrderCents: offer.minOrderCents,
    maxOffCents: offer.maxOffCents,
    cameBy: offer.cameBy === 'any' ? 'any' : [...offer.cameBy],
    orderTypes: [...offer.orderTypes],
    oncePerCustomerPerDay: offer.oncePerCustomerPerDay,
    settingsAt,
  };
}

/**
 * The rule frozen on the offer's discount row: a till discount rule (kind
 * 'discount_base' — so a till that does not know offers still splits it
 * over the right lines) carrying the offer. `alsoOffDeliveryCharge` is the
 * owner's switch when the offer went on (No by default: the food only).
 */
export function offerRule(terms: OfferTerms, alsoOffDeliveryCharge: boolean): OfferRule {
  return { kind: 'discount_base', v: 1, alsoOffDeliveryCharge, from: 'till', offer: terms };
}

/** The same rule, taken off by the cashier: Rs 0 on the order until "Put it back". */
export function declinedOfferRule(rule: OfferRule): OfferRule {
  return { ...rule, offer: { ...rule.offer, declined: true } };
}

const isWhole = (n: unknown, lo: number): n is number => typeof n === 'number' && Number.isInteger(n) && n >= lo;
const isRupeesOrNull = (n: unknown): n is number | null => n === null || isWhole(n, 0);

/** An offer row's rule_json back as a rule, or null when it is not an offer this version reads. */
export function parseOfferRule(json: string | null | undefined): OfferRule | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r['kind'] !== 'discount_base' || r['v'] !== 1 || typeof r['alsoOffDeliveryCharge'] !== 'boolean') return null;
  const o = r['offer'];
  if (typeof o !== 'object' || o === null) return null;
  const t = o as Record<string, unknown>;
  if (t['v'] !== 1 || typeof t['id'] !== 'string' || typeof t['name'] !== 'string') return null;
  const type = t['type'];
  if (type !== 'percent' && type !== 'flat') return null;
  if (!isWhole(t['value'], 0) || (type === 'percent' && (t['value'] as number) > 100)) return null;
  const minOrderCents = t['minOrderCents'] ?? null;
  const maxOffCents = t['maxOffCents'] ?? null;
  if (!isRupeesOrNull(minOrderCents) || !isRupeesOrNull(maxOffCents)) return null;
  const cameByRaw = t['cameBy'];
  const cameBy: 'any' | CameBy[] | null =
    cameByRaw === 'any'
      ? 'any'
      : Array.isArray(cameByRaw) && cameByRaw.every((c) => (CAME_BY_CHOICES as readonly unknown[]).includes(c))
        ? (cameByRaw as CameBy[])
        : null;
  if (cameBy === null) return null;
  const typesRaw = t['orderTypes'];
  if (!Array.isArray(typesRaw) || !typesRaw.every((m) => m === 'takeaway' || m === 'delivery')) return null;
  const terms: OfferTerms = {
    v: 1,
    id: t['id'] as string,
    name: t['name'] as string,
    type,
    value: t['value'] as number,
    minOrderCents,
    maxOffCents,
    cameBy,
    orderTypes: typesRaw as OfferOrderType[],
    oncePerCustomerPerDay: t['oncePerCustomerPerDay'] === true,
    settingsAt: typeof t['settingsAt'] === 'string' ? t['settingsAt'] : null,
    ...(t['declined'] === true ? { declined: true as const } : {}),
  };
  return { kind: 'discount_base', v: 1, alsoOffDeliveryCharge: r['alsoOffDeliveryCharge'], from: 'till', offer: terms };
}

/**
 * The offer is being claimed because the order came by Phone or WhatsApp
 * (an offer for "any way" is not), or it is once per customer per day:
 * either way it needs the customer's phone on the order.
 */
export function offerNeedsPhone(
  terms: Pick<OfferTerms, 'cameBy' | 'oncePerCustomerPerDay'>,
  cameBy: OrderCameBy | null | undefined,
): boolean {
  if (terms.oncePerCustomerPerDay) return true;
  return terms.cameBy !== 'any' && (cameBy === 'phone' || cameBy === 'whatsapp');
}

/** Why an offer does not fit an order (for the cart's hint), or null when it does. */
export type OfferMiss = 'order_type' | 'came_by' | 'phone' | 'used_today';

/**
 * Does the order fit the offer's terms — its type, how it came in, the
 * customer's phone, once per customer per day? (Time and the minimum are
 * checked apart: offerRunsAt, offerAmount.)
 */
export function offerMiss(
  terms: Pick<OfferTerms, 'id' | 'cameBy' | 'orderTypes' | 'oncePerCustomerPerDay'>,
  order: Pick<OfferOrder, 'mode' | 'cameBy' | 'hasPhone'>,
  usedToday: ReadonlySet<string> = new Set(),
): OfferMiss | null {
  if (!(terms.orderTypes as readonly string[]).includes(order.mode)) return 'order_type';
  if (terms.cameBy !== 'any' && !(order.cameBy && (terms.cameBy as readonly string[]).includes(order.cameBy))) return 'came_by';
  if (offerNeedsPhone(terms, order.cameBy) && !order.hasPhone) return 'phone';
  if (terms.oncePerCustomerPerDay && usedToday.has(terms.id)) return 'used_today';
  return null;
}

/**
 * What the offer takes off (paisa): nothing below its minimum (measured on
 * the food); else the % of what it is worked on (`baseCents`: the food, or
 * every line when it also comes off the delivery charge) or its rupees, at
 * most that, and at most its most-off.
 */
export function offerAmount(
  terms: Pick<OfferTerms, 'type' | 'value' | 'minOrderCents' | 'maxOffCents'>,
  baseCents: number,
  foodCents: number,
): number {
  if (!(baseCents > 0)) return 0;
  if (terms.minOrderCents !== null && foodCents < terms.minOrderCents) return 0;
  let off = computeDiscountCents(baseCents, { type: terms.type, value: terms.value }) as number;
  if (terms.maxOffCents !== null) off = Math.min(off, terms.maxOffCents);
  return Math.max(0, off);
}

/** What a frozen rule takes off this order: on the food, or on every line when the rule says so. */
export function offerRuleAmount(rule: Pick<OfferRule, 'alsoOffDeliveryCharge' | 'offer'>, order: Pick<OfferOrder, 'foodCents' | 'subtotalCents'>): number {
  if (rule.offer.declined) return 0;
  return offerAmount(rule.offer, rule.alsoOffDeliveryCharge ? order.subtotalCents : order.foodCents, order.foodCents);
}

export interface OfferMatchOptions {
  /** 'discounts.delivery' now: whether a new offer also comes off the delivery charge (frozen with it). */
  alsoOffDeliveryCharge: boolean;
  /** When 'discounts.offers' was saved (frozen with a new offer); null = never. */
  settingsAt: string | null;
  /** The ids of the offers this customer's phone already had today on another order ("once per customer per day"). */
  usedToday?: ReadonlySet<string>;
  /** The offer already on the order, as frozen on its row (null: none). */
  current?: OfferRule | null;
}

export interface OfferPick {
  rule: OfferRule;
  amountCents: number;
  /** It is the offer already on the order (its frozen terms), not a new one. */
  isCurrent: boolean;
}

/**
 * The offer the order should carry now, or null for none: the biggest that
 * fits (see the file header). `offers` is the live setting's list; the one
 * already on the order competes with its FROZEN terms.
 */
export function matchOffer(order: OfferOrder, offers: ReadonlyArray<ChannelOffer>, opts: OfferMatchOptions): OfferPick | null {
  if (!offerCanApplyTo(order)) return null;
  const used = opts.usedToday ?? new Set<string>();
  const candidates: OfferPick[] = [];
  const current = opts.current && !opts.current.offer.declined ? opts.current : null;
  let currentFits = false;
  if (current && offerMiss(current.offer, order, used) === null) {
    const amountCents = offerRuleAmount(current, order);
    if (amountCents > 0) {
      currentFits = true;
      candidates.push({ rule: current, amountCents, isCurrent: true });
    }
  }
  for (const offer of offers) {
    // The one on the order keeps its frozen terms while they fit.
    if (currentFits && current && offer.id === current.offer.id) continue;
    if (!offerRunsAt(offer, order.createdAt)) continue;
    if (offerMiss(offer, order, used) !== null) continue;
    const rule = offerRule(offerTerms(offer, opts.settingsAt), opts.alsoOffDeliveryCharge);
    const amountCents = offerRuleAmount(rule, order);
    if (amountCents > 0) candidates.push({ rule, amountCents, isCurrent: false });
  }
  let best: OfferPick | null = null;
  for (const c of candidates) if (!best || c.amountCents > best.amountCents) best = c;
  return best;
}

/**
 * The counter shows the Walk-in · Phone · WhatsApp chips on a takeaway or
 * delivery order: always when the owner asks, else when an offer that runs
 * for this order needs to know how it came in.
 */
export function cameByChipsShown(rules: CounterOffers | null | undefined, mode: string, at: string): boolean {
  if (mode !== 'takeaway' && mode !== 'delivery') return false;
  if (!rules) return false;
  if (rules.askCameBy) return true;
  return rules.offers.some(
    (o) => o.cameBy !== 'any' && (o.orderTypes as readonly string[]).includes(mode) && offerRunsAt(o, at),
  );
}

/**
 * The cart's hint while no offer is on: an offer that would go on once the
 * customer's phone is saved on the order (it is saved at Pay or Send), or
 * from how much food one starts. Null when there is nothing to say.
 */
export function offerHint(
  order: OfferOrder,
  rules: CounterOffers | null | undefined,
  alsoOffDeliveryCharge: boolean,
): { name: string; needs: 'phone' | 'more_food'; fromCents?: number } | null {
  if (!rules || !offerCanApplyTo(order)) return null;
  for (const offer of rules.offers) {
    if (!offerRunsAt(offer, order.createdAt)) continue;
    const miss = offerMiss(offer, order);
    if (miss === 'phone') {
      const withPhone = { ...order, hasPhone: true };
      const rule = offerRule(offerTerms(offer, null), alsoOffDeliveryCharge);
      if (offerRuleAmount(rule, withPhone) > 0) return { name: offer.name, needs: 'phone' };
      continue;
    }
    if (miss !== null) continue;
    if (offer.minOrderCents !== null && order.foodCents < offer.minOrderCents && order.foodCents > 0) {
      return { name: offer.name, needs: 'more_food', fromCents: offer.minOrderCents };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reports → Team & leakage: who marks orders Phone / WhatsApp, and the offers
// ---------------------------------------------------------------------------

/** A cashier is flagged over 1.5 × the shop's rate… */
export const OFFER_FLAG_FACTOR_PCT = 150;
/** …once they took at least this many counter orders in the period (fewer can't tell). */
export const OFFER_FLAG_MIN_ORDERS = 20;

export interface OfferCheckFigures {
  /** Counter takeaway and delivery orders. */
  counterOrders: number;
  /** …marked Phone or WhatsApp. */
  phoneOrWhatsapp: number;
  /** What the automatic offers took off them. */
  offerCents: number;
}

/**
 * The flags on one cashier's figures against the shop's over the same
 * period: their share of orders marked Phone or WhatsApp, and their offers'
 * rupees per order, each over 1.5 × the shop's. Worked in whole numbers.
 */
export function offerFlags(person: OfferCheckFigures, shop: OfferCheckFigures): OfferFlag[] {
  if (person.counterOrders < OFFER_FLAG_MIN_ORDERS || shop.counterOrders <= 0) return [];
  const flags: OfferFlag[] = [];
  // person.pw / person.orders > 1.5 × shop.pw / shop.orders
  if (person.phoneOrWhatsapp * shop.counterOrders * 100 > OFFER_FLAG_FACTOR_PCT * shop.phoneOrWhatsapp * person.counterOrders) {
    flags.push('phone_share');
  }
  if (person.offerCents * shop.counterOrders * 100 > OFFER_FLAG_FACTOR_PCT * shop.offerCents * person.counterOrders) {
    flags.push('offer_rupees');
  }
  return flags;
}
