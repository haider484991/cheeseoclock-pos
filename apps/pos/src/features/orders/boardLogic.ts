/**
 * Pure rules behind the Live Orders board: how late a card is, which one-tap
 * action it offers, which leave-out / allergy flags it must show, and the
 * quick search. Tested in boardLogic.test.ts.
 */
import type { KitchenTiming, Order, OrderMode, OrderSnapshot, OrderStatus, RiderKeepsNothingWhy } from '@cheeseoclock/shared-types';
import { DEFAULT_KITCHEN_TIMING, deliveryChargeLinesCents, isLeaveOutChoice, isOutsideRiderOrder } from '@cheeseoclock/shared-types';
import { KITCHEN_TICKET_STATUSES, formatCents, normalizePhone } from '@cheeseoclock/pos-domain';
import { orderTimeLabel } from './historyFilters';

/**
 * Minutes after which a card turns amber, then red, by default (15, 30). The
 * owner's are Settings → Staff & kitchen timing ('kitchen.timing', from
 * checkout:getRules).
 */
export const WARN_AFTER_MIN = DEFAULT_KITCHEN_TIMING.amberMin;
export const LATE_AFTER_MIN = DEFAULT_KITCHEN_TIMING.redMin;

/** The board's colour minutes. */
export type BoardTiming = Pick<KitchenTiming, 'amberMin' | 'redMin'>;
const DEFAULT_BOARD_TIMING: BoardTiming = { amberMin: WARN_AFTER_MIN, redMin: LATE_AFTER_MIN };

export function ageMinutes(fromIso: string, now: number): number {
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now - t) / 60_000));
}

/** The order's times the board's clock reads. */
export type OrderClockTimes = Pick<Order, 'sentAt' | 'createdAt'>;

/**
 * Where a card's minutes start (the owner, 2 Oct 2026: count from when the
 * order is sent): when the order was sent to the kitchen (orders.sent_at,
 * migration 0048). An order sent before 0.7.34 has no sentAt and counts from
 * when it was started, as before. The main process sorts and watches by the
 * same moment (order-repo ORDER_CLOCK_SQL).
 */
export function orderClockFrom(o: OrderClockTimes): string {
  return o.sentAt ?? o.createdAt;
}

/** Sent this long or more after it was started: the send is shown as its own time. */
const SENT_SHOWN_AFTER_MS = 60_000;

/**
 * When the order was sent, when that is worth showing beside when it was
 * started: a minute or more after it (a quick Pay or Send would show the
 * same time twice). Null for an order sent within the minute, or one with
 * no sentAt (never sent, or from before 0.7.34). Order History's "Sent" step.
 */
export function sentStepAt(o: OrderClockTimes): string | null {
  if (!o.sentAt) return null;
  return Date.parse(o.sentAt) - Date.parse(o.createdAt) >= SENT_SHOWN_AFTER_MS ? o.sentAt : null;
}

/**
 * The age chip's tooltip: "Sent 7:42 pm · started 7:10 pm" (the cart was
 * started a minute or more before it was sent), "Sent 7:42 pm" (sent within a
 * minute of starting), or "Taken 7:10 pm" for an order sent before 0.7.34.
 * Times as the board's other clocks write them (orderTimeLabel: Pakistan
 * time, the day too when it is not today's trading day).
 */
export function ageTitle(o: OrderClockTimes, now: Date = new Date()): string {
  if (!o.sentAt) return `Taken ${orderTimeLabel(o.createdAt, now)}`;
  const sent = `Sent ${orderTimeLabel(o.sentAt, now)}`;
  return sentStepAt(o) ? `${sent} · started ${orderTimeLabel(o.createdAt, now)}` : sent;
}

/**
 * The board's order within a column: the one sent longest ago first (started,
 * for an order from before 0.7.34), then the one started first, as
 * orders:listActive sorts them. A time that does not read goes last.
 */
export function compareOrderClock(a: OrderClockTimes, b: OrderClockTimes): number {
  const at = (iso: string) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  const cmp = (x: number, y: number) => (x === y ? 0 : x < y ? -1 : 1);
  return cmp(at(orderClockFrom(a)), at(orderClockFrom(b))) || cmp(at(a.createdAt), at(b.createdAt));
}

export type AgeTone = 'ok' | 'warn' | 'late';

export function ageTone(minutes: number, timing: BoardTiming = DEFAULT_BOARD_TIMING): AgeTone {
  if (minutes >= timing.redMin) return 'late';
  if (minutes >= timing.amberMin) return 'warn';
  return 'ok';
}

/** "3 waiting over 30 min" — the board's header, with the owner's red minutes. */
export function lateCountText(count: number, timing: BoardTiming): string {
  return `${count} waiting over ${timing.redMin} min`;
}

/** The board's colours in words (its help line): "A card turns amber 15 minutes after the order was sent and red after 30." */
export function boardColoursText(timing: BoardTiming): string {
  return `A card turns amber ${timing.amberMin} minutes after the order was sent and red after ${timing.redMin}.`;
}

/** "just now", "12m", "1h 05m". */
export function ageLabel(minutes: number): string {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  return `${h}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export type BoardAction =
  | { kind: 'preparing'; label: string }
  | { kind: 'ready'; label: string }
  /**
   * A Ready delivery goes out with an outside rider and its bill prints (the
   * owner, 2 Oct 2026: "Ready delivery -> Send out"). One of the shop's own
   * riders is the card's small "Assign rider" link.
   */
  | { kind: 'send_out'; label: string }
  /** Opens the hand-over dialog (takes the payment when one is due). */
  | { kind: 'hand_over'; label: string }
  /** Paid and not a delivery: closes the order with no dialog. */
  | { kind: 'served'; label: string }
  /** Paid delivery back from the rider: closes the order with no dialog. */
  | { kind: 'delivered'; label: string }
  | { kind: 'none'; label: string };

/**
 * The one big button on a card: the next step for this order. An outside
 * rider's Out card has the same one (the owner, 2 Oct 2026: Delivered + Pay
 * while the rider owes, Delivered once paid); his "Rider paid" is the
 * card's second button (secondaryBoardAction).
 */
export function nextBoardAction(status: OrderStatus, mode: OrderMode, paid: boolean): BoardAction {
  switch (status) {
    case 'open':
    case 'sent_to_kitchen':
      return { kind: 'preparing', label: 'Start preparing' };
    case 'preparing':
      return { kind: 'ready', label: 'Mark ready' };
    case 'ready':
      // Paid or not: the money is settled when he comes back (Delivered + Pay).
      if (mode === 'delivery') return { kind: 'send_out', label: 'Send out' };
      // Unpaid must not close without its payment: the dialog takes it.
      if (!paid) return { kind: 'hand_over', label: 'Picked up + Pay' };
      return { kind: 'served', label: 'Picked up' };
    case 'out_for_delivery':
      return paid
        ? { kind: 'delivered', label: 'Delivered' }
        : { kind: 'hand_over', label: 'Delivered + Pay' };
    default:
      return { kind: 'none', label: '' };
  }
}

/** A card's second button, beside the big one. */
export type SecondaryBoardAction = { kind: 'rider_paid'; label: string };

/**
 * The card's second button: "Rider paid" on an Out card whose outside rider
 * has not paid the shop yet (the owner, 2 Oct 2026: "Rider owes Rs …" +
 * [Rider paid] and [Delivered + Pay]). It takes his money while the order
 * stays out. `outside`: sent out with an outside rider (isOutsideRiderOrder,
 * what the till itself goes by). Null on every other card: they keep their
 * one big button.
 */
export function secondaryBoardAction(
  status: OrderStatus,
  mode: OrderMode,
  paid: boolean,
  outside: boolean,
): SecondaryBoardAction | null {
  if (status === 'out_for_delivery' && mode === 'delivery' && outside && !paid) {
    return { kind: 'rider_paid', label: 'Rider paid' };
  }
  return null;
}

/**
 * What an outside rider owes the shop on an Out card: the total less what
 * he keeps (frozen at Send out) — the FOOD TOTAL. Null when he owes
 * nothing to show: paid, not out, or one of the shop's own riders.
 */
export function riderOwesCents(
  order: Pick<Order, 'status' | 'mode' | 'paidAt' | 'totalCents' | 'riderKeepsCents'>,
): number | null {
  if (!secondaryBoardAction(order.status, order.mode, order.paidAt !== null, isOutsideRiderOrder(order))) return null;
  return order.totalCents - (order.riderKeepsCents ?? 0);
}

/** "Rider owes Rs 4,515" — the amber words beside an Out card's total. */
export function riderOwesText(cents: number): string {
  return `Rider owes ${formatCents(cents)}`;
}

/** Send out's money, before it is sent: what the customer pays, what the rider keeps, what he hands the shop. */
export interface SendOutSplit {
  /** The stored total: CUSTOMER PAYS. */
  customerPaysCents: number;
  /** What Send out will freeze for him (Order.riderKeepsCents). */
  keepsCents: number;
  /** The total less what he keeps: the FOOD TOTAL (deliveryBillOf's foodTotalCents when the bill has a charge). */
  givesCents: number;
}

/**
 * What Send out will freeze, worked out the way the till does it
 * (sendOutOrder): the delivery-charge lines as sold
 * (deliveryChargeLinesCents), never more than the total; nothing when the
 * rider was already paid for this trip (`riderAlreadyPaid`, one trip, one
 * fee). Shown in the Send out box before it is sent; everything after reads
 * the frozen value.
 */
export function sendOutSplit(
  snap: {
    order: { readonly totalCents: number };
    items: ReadonlyArray<{ readonly menuItemName?: string | null; readonly lineTotalCents: number }>;
  },
  opts: { riderAlreadyPaid?: boolean } = {},
): SendOutSplit {
  const total = snap.order.totalCents;
  const keeps = opts.riderAlreadyPaid === true ? 0 : Math.min(deliveryChargeLinesCents(snap), total);
  return { customerPaysCents: total, keepsCents: keeps, givesCents: total - keeps };
}

/**
 * One trip, one fee (the owner, 2 Oct 2026: refunded and sent again on the
 * same trip, the rider gets one Rs 200, not two): the order the rider was
 * already paid on (OrderSnapshot.riderPaidEarlier) when this order has a
 * delivery charge for him to keep — the Send out box then starts on "No
 * delivery charge for him this time" with "Charge again". Null otherwise:
 * with no charge on this bill there is nothing to choose.
 */
export function riderPaidEarlierChoice(
  snap: Parameters<typeof sendOutSplit>[0] & { riderPaidEarlier?: OrderSnapshot['riderPaidEarlier'] },
): NonNullable<OrderSnapshot['riderPaidEarlier']> | null {
  const earlier = snap.riderPaidEarlier ?? null;
  return earlier && sendOutSplit(snap).keepsCents > 0 ? earlier : null;
}

/**
 * Another delivery of the same customer on Live Orders (samePhoneDelivery):
 * `out` once it has gone out for delivery.
 */
export interface SamePhoneDelivery {
  orderId: string;
  orderNumber: string;
  out: boolean;
}

/** A delivery the shop still has: the add-on rule's (order-repo liveDeliveryNotOutFor), the same three. */
const NOT_OUT_YET: readonly OrderStatus[] = ['sent_to_kitchen', 'preparing', 'ready'];

/**
 * Add-on delivery (the owner, 2 Oct 2026: "if its out then it should charge
 * if the rider is not out"): another live delivery on the board — not this
 * order — with the same phone (pos-domain normalizePhone: "0300 1234567" and
 * "+92 300 1234567" are one customer), whatever its source. One still in the
 * kitchen or Ready (sent to the kitchen, being made or Ready, as the till's
 * add-on rule reads it) comes first: the two can go on one trip. Otherwise
 * one already out for delivery (`out` true). Null with no phone, or none:
 * closed orders and other phones never count. The first sent first when
 * there are several.
 */
export function samePhoneDelivery(
  all: ReadonlyArray<{ order: Pick<Order, 'id' | 'orderNumber' | 'mode' | 'status' | 'sentAt' | 'createdAt'>; customerPhone?: string | null }>,
  snap: { order: Pick<Order, 'id'>; customerPhone?: string | null },
): SamePhoneDelivery | null {
  const phone = normalizePhone(snap.customerPhone);
  if (!phone) return null;
  const same = all
    .filter(
      (o) =>
        o.order.id !== snap.order.id &&
        o.order.mode === 'delivery' &&
        (NOT_OUT_YET.includes(o.order.status) || o.order.status === 'out_for_delivery') &&
        normalizePhone(o.customerPhone) === phone,
    )
    .sort((a, b) => compareOrderClock(a.order, b.order));
  const pick = same.find((o) => o.order.status !== 'out_for_delivery') ?? same[0];
  return pick ? { orderId: pick.order.id, orderNumber: pick.order.orderNumber, out: pick.order.status === 'out_for_delivery' } : null;
}

/** What Send out says about the same customer's other delivery (sameCustomerLine). */
export interface SameCustomerLine {
  /** 'together': it can go on this trip; 'gone': it went out, and this bill has no delivery charge. */
  kind: 'together' | 'gone';
  text: string;
}

/**
 * The Send out box's line about the same customer's other delivery
 * (samePhoneDelivery):
 *  - still in the kitchen or Ready: "Same customer as #0042 — send them
 *    together." (one trip);
 *  - already out, and this bill has no delivery charge (an add-on rung while
 *    #0042 was still in the shop, counter or website): "No delivery charge on
 *    this order: #0042 has already gone out." — he goes again for nothing;
 *  - already out and this bill is charged: nothing (a new trip, as the owner
 *    said). Null with no other delivery.
 */
export function sameCustomerLine(
  other: SamePhoneDelivery | null,
  snap: { readonly items: ReadonlyArray<{ readonly menuItemName?: string | null; readonly lineTotalCents: number }> },
): SameCustomerLine | null {
  if (!other) return null;
  const n = other.orderNumber.split('-').pop() ?? other.orderNumber;
  if (!other.out) return { kind: 'together', text: `Same customer as #${n} — send them together.` };
  if (deliveryChargeLinesCents(snap) === 0) {
    return { kind: 'gone', text: `No delivery charge on this order: #${n} has already gone out.` };
  }
  return null;
}

/** What Send out and Assign rider say about an add-on that now goes alone (goesAloneLine). */
export interface GoesAloneLine {
  text: string;
  /** What 'Pay the rider … for this trip' pays from the drawer: the area's charge left off (0: not offered). */
  tripCents: number;
}

/**
 * An add-on delivery that now goes alone (OrderSnapshot.goesAlone: its
 * delivery charge was left off for the same customer's first delivery, and
 * that one is no longer here — cancelled, refunded, delivered or closed):
 * "#0042 is no longer here: this order goes alone with no delivery charge."
 * Null when the bill has a delivery charge after all, or when another
 * delivery of the same customer is still in the shop (`sameCustomer`,
 * samePhoneDelivery, not out: they can go together, and "send them together"
 * says so). Send out offers to pay the outside rider `tripCents` for the
 * trip; Assign rider (one of the shop's own riders) only says it.
 */
export function goesAloneLine(
  snap: {
    readonly items: ReadonlyArray<{ readonly menuItemName?: string | null; readonly lineTotalCents: number }>;
    goesAlone?: OrderSnapshot['goesAlone'];
  },
  sameCustomer: SamePhoneDelivery | null = null,
): GoesAloneLine | null {
  const alone = snap.goesAlone ?? null;
  if (!alone || deliveryChargeLinesCents(snap) > 0) return null;
  if (sameCustomer && !sameCustomer.out) return null;
  const n = alone.orderNumber.split('-').pop() ?? alone.orderNumber;
  return {
    text: `#${n} is no longer here: this order goes alone with no delivery charge.`,
    tripCents: Math.max(0, alone.feeCents as number),
  };
}

/**
 * Whether a Ready delivery's Send out asks first (SendOutDialog: "Has the
 * rider paid the shop?", or the drawer paying a prepaid order's rider).
 * Only an order already paid whose rider keeps nothing goes in one tap:
 * nothing to ask, and no money moves — and only when the box would have no
 * line about the same customer's other delivery (`sameCustomer`,
 * samePhoneDelivery; sameCustomerLine), none about an add-on that now goes
 * alone (goesAloneLine) and none about a rider already paid for this trip
 * (riderPaidEarlierChoice: that bill has a charge, so its box always opens
 * anyway).
 */
export function sendOutAsks(
  snap: Parameters<typeof sendOutSplit>[0] & {
    order: Pick<Order, 'paidAt'>;
    riderPaidEarlier?: OrderSnapshot['riderPaidEarlier'];
    goesAlone?: OrderSnapshot['goesAlone'];
  },
  sameCustomer: SamePhoneDelivery | null = null,
): boolean {
  return (
    snap.order.paidAt === null ||
    sendOutSplit(snap).keepsCents > 0 ||
    riderPaidEarlierChoice(snap) !== null ||
    sameCustomerLine(sameCustomer, snap) !== null ||
    goesAloneLine(snap, sameCustomer) !== null
  );
}

/** The small "Assign rider" link's title on a Ready delivery and an outside rider's Out card. */
export const ASSIGN_RIDER_LINK_TITLE = 'Optional — one of your own riders (they bring back the full bill)';

/**
 * The order is out now with an outside rider (Send out): out for delivery,
 * what he keeps frozen on it, and none of the shop's own riders named. An
 * own rider's order, and one an older till changed, read as before.
 */
export function isOutWithOutsideRider(snap: {
  order: Pick<Order, 'status' | 'riderKeepsCents'>;
  rider: OrderSnapshot['rider'];
}): boolean {
  return snap.order.status === 'out_for_delivery' && isOutsideRiderOrder(snap.order) && !snap.rider;
}

/**
 * What the outside rider keeps, in the Out card's words: "keeps Rs 200", or
 * for 0 the paper's own reason (riderKeepsNothingWhy of the order): "already
 * paid for this trip" when the bill still has its charge (one trip, one
 * fee), else "no delivery charge".
 */
export function outsideRiderKeepsText(keepCents: number, nothingWhy: RiderKeepsNothingWhy = 'no delivery charge'): string {
  return keepCents > 0 ? `keeps ${formatCents(keepCents)}` : nothingWhy;
}

/** Order History's panel chip for an order sent out with an outside rider: what he kept of the bill (0: the paper's reason, as above). */
export function outsideRiderChipText(keptCents: number, nothingWhy: RiderKeepsNothingWhy = 'no delivery charge'): string {
  return keptCents > 0 ? `Outside rider · kept ${formatCents(keptCents)} delivery charge` : `Outside rider · ${nothingWhy}`;
}

/**
 * Whether a card offers "Reprint kitchen ticket": only while the kitchen still
 * has the order (new, preparing, ready). Once it is out for delivery (or
 * later) the till refuses that ticket for everyone (reprint-policy.ts
 * KITCHEN_REPRINT_STATUSES), so the button would only ever say no.
 */
export function offersKitchenReprint(status: OrderStatus): boolean {
  return KITCHEN_TICKET_STATUSES.includes(status);
}

/**
 * Leave-outs ("NO ONION") and allergy / special-request notes on any line.
 * The card lists only a few lines, so these are gathered separately and
 * always shown — a hidden allergy is the one thing the board must not do.
 */
export function cardFlags(snap: Pick<OrderSnapshot, 'items'>): string[] {
  return snap.items.flatMap((i) => [
    ...i.modifiers
      .filter((m) => isLeaveOutChoice(m.modifierName))
      .map((m) => `${m.modifierName.toUpperCase()} (${i.menuItemName})`),
    ...(i.notes?.trim() ? [`${i.notes.trim()} (${i.menuItemName})`] : []),
  ]);
}

/** Lines to list on a card: top-level lines only (deal parts belong to their deal). */
export function cardLines<T extends { parentOrderItemId: unknown }>(items: T[]): T[] {
  return items.filter((i) => !i.parentOrderItemId);
}

/**
 * What goes under one card line (owner 2026-09-27: the card said only
 * "Family Feast"): its deal parts, each with its picks ("Fajita Pizza —
 * Large + Extra cheese", "1.5 litre drink + 7up"), then the line's own
 * extras, flavours and dips. Leave-outs are left out here: cardFlags shows
 * them, in red, on every card.
 */
export function cardLineDetails(
  line: Pick<OrderSnapshot['items'][number], 'id' | 'modifiers'>,
  items: Array<Pick<OrderSnapshot['items'][number], 'id' | 'parentOrderItemId' | 'quantity' | 'menuItemName' | 'modifiers'>>,
): string[] {
  const picks = (mods: Array<{ modifierName: string }>) =>
    mods.filter((m) => !isLeaveOutChoice(m.modifierName)).map((m) => m.modifierName);
  const parts = items
    .filter((i) => i.parentOrderItemId === line.id)
    .map((i) => [`${i.quantity > 1 ? `${i.quantity}× ` : ''}${i.menuItemName}`, ...picks(i.modifiers)].join(' + '));
  return [...parts, ...picks(line.modifiers).map((name) => `+ ${name}`)];
}

/** Items on a card, deal parts not counted twice. */
export function cardItemCount(items: Array<{ parentOrderItemId: unknown; quantity: number }>): number {
  return cardLines(items).reduce((s, i) => s + i.quantity, 0);
}

/** "2,000" / " 1850.5 " → cents; blank or junk → NaN. */
export function parseRupeesToCents(text: string): number {
  const cleaned = text.replace(/[,\s]/g, '').replace(/^rs\.?/i, '');
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return Number.NaN;
  return Math.round(Number(cleaned) * 100);
}

/**
 * Quick find on the board: order number ("42", "#0042"), customer name,
 * phone digits, or rider name.
 */
export function matchesBoardSearch(
  snap: Pick<OrderSnapshot, 'order' | 'customerName' | 'customerPhone' | 'rider'>,
  query: string,
): boolean {
  const q = query.trim().toLowerCase().replace(/^#\s*/, '');
  if (!q) return true;
  const shortNo = snap.order.orderNumber.split('-').pop() ?? snap.order.orderNumber;
  if (/^\d+$/.test(q)) {
    if (q.length <= 4) return Number(shortNo) === Number(q);
    const digits = (snap.customerPhone ?? '').replace(/\D/g, '');
    const core = q.replace(/^0+/, '');
    return digits.includes(core);
  }
  return (
    (snap.customerName ?? '').toLowerCase().includes(q) ||
    (snap.rider?.name ?? '').toLowerCase().includes(q) ||
    snap.order.orderNumber.toLowerCase().includes(q)
  );
}
