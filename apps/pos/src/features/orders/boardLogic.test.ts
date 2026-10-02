import { describe, expect, it } from 'vitest';
import type { OrderSnapshot, OrderStatus } from '@cheeseoclock/shared-types';
import { KITCHEN_TICKET_STATUSES } from '@cheeseoclock/pos-domain';
import {
  ASSIGN_RIDER_LINK_TITLE,
  ageLabel,
  ageMinutes,
  ageTitle,
  ageTone,
  boardColoursText,
  cardFlags,
  cardItemCount,
  cardLineDetails,
  cardLines,
  compareOrderClock,
  isOutWithOutsideRider,
  matchesBoardSearch,
  nextBoardAction,
  offersKitchenReprint,
  orderClockFrom,
  outsideRiderChipText,
  outsideRiderKeepsText,
  parseRupeesToCents,
  riderOwesCents,
  riderOwesText,
  riderPaidEarlierChoice,
  sameCustomerLine,
  samePhoneDelivery,
  secondaryBoardAction,
  sendOutAsks,
  sendOutSplit,
  sentStepAt,
} from './boardLogic';
import { deliveryBillOf } from '@cheeseoclock/shared-types';
import { orderTimeLabel } from './historyFilters';

describe('age', () => {
  const now = Date.parse('2026-09-26T15:00:00.000Z');

  it('counts whole minutes since the order', () => {
    expect(ageMinutes('2026-09-26T14:47:30.000Z', now)).toBe(12);
    expect(ageMinutes('2026-09-26T15:00:30.000Z', now)).toBe(0); // clock skew: never negative
    expect(ageMinutes('not a date', now)).toBe(0);
  });

  it('turns amber at 15 minutes and red at 30', () => {
    expect(ageTone(14)).toBe('ok');
    expect(ageTone(15)).toBe('warn');
    expect(ageTone(29)).toBe('warn');
    expect(ageTone(30)).toBe('late');
  });

  it('reads short', () => {
    expect(ageLabel(0)).toBe('just now');
    expect(ageLabel(9)).toBe('9m');
    expect(ageLabel(65)).toBe('1h 05m');
  });
});

/** Pakistan wall-clock instants (UTC+5) on 26 Sep 2026. */
const pkt = (h: number, m: number, day = 26) => new Date(Date.UTC(2026, 8, day, h - 5, m)).toISOString();

describe('the Live Orders clock counts from when the order was sent (the owner, 2 Oct 2026)', () => {
  it('orderClockFrom: sent, or started for an order with no send time (before 0.7.34)', () => {
    expect(orderClockFrom({ createdAt: pkt(19, 10), sentAt: pkt(19, 42) })).toBe(pkt(19, 42));
    expect(orderClockFrom({ createdAt: pkt(19, 10) })).toBe(pkt(19, 10));
    expect(orderClockFrom({ createdAt: pkt(19, 10), sentAt: null })).toBe(pkt(19, 10));
  });

  it('a cart started 31 minutes ago and sent 2 minutes ago is 2 minutes old, not late', () => {
    const now = Date.parse(pkt(19, 41));
    const o = { createdAt: pkt(19, 10), sentAt: pkt(19, 39) };
    expect(ageMinutes(orderClockFrom(o), now)).toBe(2);
    expect(ageTone(ageMinutes(orderClockFrom(o), now))).toBe('ok');
    // Without the send time it counts from the start, as before.
    expect(ageTone(ageMinutes(orderClockFrom({ createdAt: o.createdAt }), now))).toBe('late');
  });

  it('ageTitle: "Sent … · started …", "Sent …" within a minute, "Taken …" before 0.7.34', () => {
    const now = new Date(pkt(20, 0));
    const both = ageTitle({ createdAt: pkt(19, 10), sentAt: pkt(19, 42) }, now);
    expect(both).toBe(`Sent ${orderTimeLabel(pkt(19, 42), now)} · started ${orderTimeLabel(pkt(19, 10), now)}`);
    expect(both).toMatch(/^Sent 7:42\spm · started 7:10\spm$/);
    // Sent within a minute of starting (a quick Pay): one time.
    expect(ageTitle({ createdAt: pkt(19, 42), sentAt: new Date(Date.parse(pkt(19, 42)) + 59_000).toISOString() }, now)).toMatch(
      /^Sent 7:42\spm$/,
    );
    // Exactly a minute: both.
    expect(ageTitle({ createdAt: pkt(19, 41), sentAt: pkt(19, 42) }, now)).toMatch(/^Sent 7:42\spm · started 7:41\spm$/);
    expect(ageTitle({ createdAt: pkt(19, 10) }, now)).toMatch(/^Taken 7:10\spm$/);
    expect(ageTitle({ createdAt: pkt(19, 10), sentAt: null }, now)).toMatch(/^Taken 7:10\spm$/);
  });

  it('ageTitle: the day too for a time on another trading day', () => {
    const now = new Date(pkt(20, 0, 26));
    expect(ageTitle({ createdAt: pkt(21, 15, 24), sentAt: pkt(21, 30, 24) }, now)).toMatch(
      /^Sent Thu 24 Sept?, 9:30\spm · started Thu 24 Sept?, 9:15\spm$/,
    );
  });

  it('sentStepAt: the send time only when it came a minute or more after the start', () => {
    expect(sentStepAt({ createdAt: pkt(19, 10), sentAt: pkt(19, 42) })).toBe(pkt(19, 42));
    expect(sentStepAt({ createdAt: pkt(19, 41), sentAt: pkt(19, 42) })).toBe(pkt(19, 42));
    expect(sentStepAt({ createdAt: pkt(19, 42), sentAt: new Date(Date.parse(pkt(19, 42)) + 59_000).toISOString() })).toBeNull();
    expect(sentStepAt({ createdAt: pkt(19, 10) })).toBeNull();
    expect(sentStepAt({ createdAt: pkt(19, 10), sentAt: null })).toBeNull();
  });

  it('compareOrderClock: the one sent longest ago first, then the one started first', () => {
    const startedEarlySentLate = { id: 'a', createdAt: pkt(19, 0), sentAt: pkt(19, 40) };
    const startedLateSentEarly = { id: 'b', createdAt: pkt(19, 20), sentAt: pkt(19, 25) };
    const old = { id: 'c', createdAt: pkt(19, 30) };
    const sameSentStartedLater = { id: 'd', createdAt: pkt(19, 5), sentAt: pkt(19, 25) };
    const sorted = [startedEarlySentLate, old, startedLateSentEarly, sameSentStartedLater].sort(compareOrderClock);
    expect(sorted.map((o) => o.id)).toEqual(['d', 'b', 'c', 'a']);
    // A time that does not read goes last.
    expect([{ createdAt: 'not a date' }, { createdAt: pkt(19, 0) }].sort(compareOrderClock)[0]!.createdAt).toBe(pkt(19, 0));
  });

  it('the board’s colours in words say so', () => {
    expect(boardColoursText({ amberMin: 15, redMin: 30 })).toBe('A card turns amber 15 minutes after the order was sent and red after 30.');
  });
});

describe('next action', () => {
  it('walks the kitchen steps', () => {
    expect(nextBoardAction('sent_to_kitchen', 'takeaway', false).kind).toBe('preparing');
    expect(nextBoardAction('preparing', 'delivery', true).kind).toBe('ready');
  });

  // Changed on purpose in v0.7.34 (step 16-3; the owner, 2 Oct 2026: "Ready
  // delivery -> Send out", "Assign rider" optional and smaller): this was
  // { kind: 'assign_rider', label: 'Assign rider' }.
  it('a ready delivery is sent out, paid or not', () => {
    expect(nextBoardAction('ready', 'delivery', false)).toEqual({ kind: 'send_out', label: 'Send out' });
    expect(nextBoardAction('ready', 'delivery', true)).toEqual({ kind: 'send_out', label: 'Send out' });
  });

  it('no step offers "Assign rider" as the big button any more', () => {
    const statuses: OrderStatus[] = ['open', 'sent_to_kitchen', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'served', 'paid', 'void', 'refunded'];
    for (const status of statuses) {
      for (const mode of ['dine_in', 'takeaway', 'delivery', 'online', 'foodpanda'] as const) {
        for (const paid of [false, true]) {
          const a = nextBoardAction(status, mode, paid);
          expect({ status, mode, paid, label: a.label }).not.toEqual({ status, mode, paid, label: 'Assign rider' });
          if (a.kind === 'send_out') expect({ status, mode }).toEqual({ status: 'ready', mode: 'delivery' });
        }
      }
    }
  });

  it('an unpaid order never closes without its payment', () => {
    expect(nextBoardAction('ready', 'takeaway', false)).toEqual({ kind: 'hand_over', label: 'Picked up + Pay' });
    expect(nextBoardAction('ready', 'foodpanda', false).kind).toBe('hand_over');
    expect(nextBoardAction('out_for_delivery', 'delivery', false)).toEqual({
      kind: 'hand_over',
      label: 'Delivered + Pay',
    });
  });

  it('a paid order closes in one tap', () => {
    expect(nextBoardAction('ready', 'takeaway', true)).toEqual({ kind: 'served', label: 'Picked up' });
    expect(nextBoardAction('ready', 'foodpanda', true).kind).toBe('served');
    expect(nextBoardAction('out_for_delivery', 'delivery', true)).toEqual({ kind: 'delivered', label: 'Delivered' });
  });

  it('finished orders offer nothing', () => {
    for (const s of ['paid', 'served', 'delivered', 'void', 'refunded'] as const) {
      expect(nextBoardAction(s, 'takeaway', true).kind).toBe('none');
    }
  });
});

describe('an outside rider on the board (Send out, v0.7.34)', () => {
  const out = (riderKeepsCents: number | null | undefined, rider: { id: string } | null = null, status: OrderStatus = 'out_for_delivery') =>
    ({
      order: { status, ...(riderKeepsCents === undefined ? {} : { riderKeepsCents }) },
      rider,
    }) as Parameters<typeof isOutWithOutsideRider>[0];

  it('out for delivery, what he keeps frozen on it (0 too), and no own rider named', () => {
    expect(isOutWithOutsideRider(out(20_000))).toBe(true);
    expect(isOutWithOutsideRider(out(0))).toBe(true);
    // One of the shop's own riders, an order from before 0.7.34, or not out yet.
    expect(isOutWithOutsideRider(out(undefined))).toBe(false);
    expect(isOutWithOutsideRider(out(null))).toBe(false);
    expect(isOutWithOutsideRider(out(20_000, null, 'ready'))).toBe(false);
    expect(isOutWithOutsideRider(out(20_000, null, 'delivered'))).toBe(false);
    // An older till named a rider and left the keep: his row, not the outside one.
    expect(isOutWithOutsideRider(out(20_000, { id: 'r1' }))).toBe(false);
  });

  it('the Out card says what he keeps; the order panel what he kept', () => {
    expect(outsideRiderKeepsText(20_000)).toBe('keeps Rs 200');
    expect(outsideRiderKeepsText(25_000)).toBe('keeps Rs 250');
    expect(outsideRiderKeepsText(0)).toBe('no delivery charge');
    expect(outsideRiderChipText(20_000)).toBe('Outside rider · kept Rs 200 delivery charge');
    expect(outsideRiderChipText(0)).toBe('Outside rider · no delivery charge');
    // Keeping nothing on a bill that still has its charge (one trip, one fee): the paper's reason.
    expect(outsideRiderKeepsText(0, 'already paid for this trip')).toBe('already paid for this trip');
    expect(outsideRiderChipText(0, 'already paid for this trip')).toBe('Outside rider · already paid for this trip');
    // What he keeps wins over any reason.
    expect(outsideRiderKeepsText(20_000, 'already paid for this trip')).toBe('keeps Rs 200');
    expect(outsideRiderChipText(20_000, 'already paid for this trip')).toBe('Outside rider · kept Rs 200 delivery charge');
  });

  it('the "Assign rider" link says it is optional and for the shop’s own riders', () => {
    expect(ASSIGN_RIDER_LINK_TITLE).toBe('Optional — one of your own riders (they bring back the full bill)');
  });
});

describe('Rider owes / Rider paid on an outside rider’s Out card (v0.7.34, step 18-6)', () => {
  const STATUSES: OrderStatus[] = ['open', 'sent_to_kitchen', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'served', 'paid', 'void', 'refunded'];
  const MODES = ['dine_in', 'takeaway', 'delivery', 'online', 'foodpanda'] as const;

  it('secondaryBoardAction: "Rider paid" only on an unpaid delivery out with an outside rider', () => {
    expect(secondaryBoardAction('out_for_delivery', 'delivery', false, true)).toEqual({ kind: 'rider_paid', label: 'Rider paid' });
    // Paid (by him, or by the customer before it left): the PAID chip and Delivered only.
    expect(secondaryBoardAction('out_for_delivery', 'delivery', true, true)).toBeNull();
    // One of the shop's own riders (outside false): exactly as before, one big button.
    expect(secondaryBoardAction('out_for_delivery', 'delivery', false, false)).toBeNull();
    expect(secondaryBoardAction('out_for_delivery', 'delivery', true, false)).toBeNull();
    for (const status of STATUSES) {
      for (const mode of MODES) {
        for (const paid of [false, true]) {
          for (const outside of [false, true]) {
            const a = secondaryBoardAction(status, mode, paid, outside);
            if (a) expect({ status, mode, paid, outside }).toEqual({ status: 'out_for_delivery', mode: 'delivery', paid: false, outside: true });
          }
        }
      }
    }
  });

  it('the big button stays the owner’s: Delivered + Pay while he owes, Delivered once paid', () => {
    expect(nextBoardAction('out_for_delivery', 'delivery', false)).toEqual({ kind: 'hand_over', label: 'Delivered + Pay' });
    expect(nextBoardAction('out_for_delivery', 'delivery', true)).toEqual({ kind: 'delivered', label: 'Delivered' });
  });

  /** An order out for delivery: Rs 4,715 (FOOD TOTAL Rs 4,515), what he keeps frozen on it. */
  const order = (over: Record<string, unknown> = {}) =>
    ({
      status: 'out_for_delivery',
      mode: 'delivery',
      paidAt: null,
      totalCents: 471_500,
      riderKeepsCents: 20_000,
      ...over,
    }) as Parameters<typeof riderOwesCents>[0];

  it('riderOwesCents: the total less what he keeps, while he owes it', () => {
    expect(riderOwesCents(order())).toBe(451_500);
    expect(riderOwesText(riderOwesCents(order())!)).toBe('Rider owes Rs 4,515');
    // No delivery charge: he owes the whole bill.
    expect(riderOwesCents(order({ riderKeepsCents: 0 }))).toBe(471_500);
    expect(riderOwesText(471_500)).toBe('Rider owes Rs 4,715');
    // Paid, an own rider's order, an order from before 0.7.34, not out, not a delivery: nothing owed to show.
    expect(riderOwesCents(order({ paidAt: '2026-10-02T15:00:00.000Z' }))).toBeNull();
    expect(riderOwesCents(order({ riderKeepsCents: null }))).toBeNull();
    expect(riderOwesCents(order({ riderKeepsCents: undefined }))).toBeNull();
    expect(riderOwesCents(order({ status: 'ready' }))).toBeNull();
    expect(riderOwesCents(order({ status: 'delivered' }))).toBeNull();
    expect(riderOwesCents(order({ mode: 'takeaway' }))).toBeNull();
  });

  /** A made-up delivery's lines: food, and the charge as sold. */
  const snap = (totalCents: number, lines: Array<[string, number]>, paidAt: string | null = null) => ({
    order: { totalCents, paidAt },
    items: lines.map(([menuItemName, lineTotalCents]) => ({ menuItemName, lineTotalCents })),
  });

  it('sendOutSplit: what Send out will freeze — the charge as sold, never more than the bill', () => {
    // The owner's example: Food 3,900 + 15% tax, Delivery charge 200 + 15% tax.
    const owner = snap(471_500, [
      ['Test Family Pizza', 390_000],
      ['Delivery Charge (Rs 200)', 20_000],
    ]);
    expect(sendOutSplit(owner)).toEqual({ customerPaysCents: 471_500, keepsCents: 20_000, givesCents: 451_500 });
    // The FOOD TOTAL of the delivery bill: the paper and the box say the same.
    const bill = deliveryBillOf({
      order: { mode: 'delivery', subtotalCents: 410_000, discountCents: 0, taxCents: 61_500, totalCents: 471_500 },
      items: owner.items,
      discounts: [],
    });
    expect(sendOutSplit(owner).givesCents).toBe(bill!.foodTotalCents);
    // No delivery charge: he keeps nothing and hands over the whole bill.
    expect(sendOutSplit(snap(448_500, [['Test Family Pizza', 390_000]]))).toEqual({
      customerPaysCents: 448_500,
      keepsCents: 0,
      givesCents: 448_500,
    });
    // A discount that took the bill below the charge: never more than the customer pays.
    expect(sendOutSplit(snap(15_000, [['Test Fries', 0], ['Delivery Charge (Rs 200)', 20_000]]))).toEqual({
      customerPaysCents: 15_000,
      keepsCents: 15_000,
      givesCents: 0,
    });
    // Two charge lines (two areas' fees): both.
    expect(sendOutSplit(snap(500_000, [['Delivery Charge (Rs 200)', 20_000], ['Delivery charge (Rs 250)', 25_000]])).keepsCents).toBe(45_000);
  });

  it('sendOutAsks: only a paid order whose rider keeps nothing goes out in one tap', () => {
    const lines: Array<[string, number]> = [['Test Family Pizza', 390_000], ['Delivery Charge (Rs 200)', 20_000]];
    const food: Array<[string, number]> = [['Test Family Pizza', 390_000]];
    expect(sendOutAsks(snap(471_500, lines))).toBe(true);
    expect(sendOutAsks(snap(448_500, food))).toBe(true);
    // Paid: the drawer gives him his charge, so it asks first.
    expect(sendOutAsks(snap(471_500, lines, '2026-10-02T14:00:00.000Z'))).toBe(true);
    expect(sendOutAsks(snap(448_500, food, '2026-10-02T14:00:00.000Z'))).toBe(false);
  });

  it('one trip, one fee: riderAlreadyPaid freezes nothing for him, and he hands over the whole bill', () => {
    const owner = snap(471_500, [
      ['Test Family Pizza', 390_000],
      ['Delivery Charge (Rs 200)', 20_000],
    ]);
    expect(sendOutSplit(owner, { riderAlreadyPaid: true })).toEqual({ customerPaysCents: 471_500, keepsCents: 0, givesCents: 471_500 });
    expect(sendOutSplit(owner, { riderAlreadyPaid: false })).toEqual(sendOutSplit(owner));
    expect(sendOutSplit(owner, {})).toEqual({ customerPaysCents: 471_500, keepsCents: 20_000, givesCents: 451_500 });
  });

  it('riderPaidEarlierChoice: the order he was paid on, only when this bill has a charge for him to keep', () => {
    const earlier = { orderId: 'o41', orderNumber: '20261002-0041', amountCents: 20_000 } as unknown as NonNullable<
      OrderSnapshot['riderPaidEarlier']
    >;
    const lines: Array<[string, number]> = [['Test Family Pizza', 390_000], ['Delivery Charge (Rs 200)', 20_000]];
    const food: Array<[string, number]> = [['Test Family Pizza', 390_000]];
    expect(riderPaidEarlierChoice({ ...snap(471_500, lines), riderPaidEarlier: earlier })).toBe(earlier);
    // Prepaid too: the drawer would pay him again.
    expect(riderPaidEarlierChoice({ ...snap(471_500, lines, '2026-10-02T14:00:00.000Z'), riderPaidEarlier: earlier })).toBe(earlier);
    // No charge on this bill: nothing to choose.
    expect(riderPaidEarlierChoice({ ...snap(448_500, food), riderPaidEarlier: earlier })).toBeNull();
    // None found, or not asked (not a delivery in the kitchen or Ready).
    expect(riderPaidEarlierChoice({ ...snap(471_500, lines), riderPaidEarlier: null })).toBeNull();
    expect(riderPaidEarlierChoice(snap(471_500, lines))).toBeNull();
    // Its box always opens: the bill has a charge.
    expect(sendOutAsks({ ...snap(471_500, lines, '2026-10-02T14:00:00.000Z'), riderPaidEarlier: earlier } as Parameters<typeof sendOutAsks>[0])).toBe(true);
  });
});

/**
 * Add-on delivery (v0.7.34, step 18-11; the owner, 2 Oct 2026: "if its out
 * then it should charge if the rider is not out"): Send out names the same
 * customer's other delivery on Live Orders. Made-up orders and phones.
 */
describe('the same customer’s other delivery on Live Orders (step 18-11)', () => {
  type Live = Parameters<typeof samePhoneDelivery>[0][number];
  const live = (n: number, status: OrderStatus, customerPhone: string | null, over: Record<string, unknown> = {}): Live =>
    ({
      order: {
        id: `o${n}`,
        orderNumber: `20261002-00${n}`,
        mode: 'delivery',
        status,
        sentAt: `2026-10-02T14:${String(n).padStart(2, '0')}:00.000Z`,
        createdAt: `2026-10-02T14:${String(n).padStart(2, '0')}:00.000Z`,
        ...over,
      },
      customerPhone,
    }) as unknown as Live;
  const ADD_ON = live(45, 'ready', '03001234567');
  /** The add-on with its phone typed another way (or none). */
  const addOnWith = (customerPhone: string | null): Live => ({ ...ADD_ON, customerPhone });

  it('samePhoneDelivery: the same phone however it was typed — "0300…" and "+92 300…" are one customer', () => {
    for (const phone of ['+92 300 1234567', '0300-1234567', '923001234567', '+923001234567']) {
      expect(samePhoneDelivery([live(42, 'preparing', phone), ADD_ON], ADD_ON)).toEqual({
        orderId: 'o42',
        orderNumber: '20261002-0042',
        out: false,
      });
    }
    // This order's own phone typed the other way round.
    expect(samePhoneDelivery([live(42, 'ready', '03001234567')], addOnWith('+92 300 1234567'))).toMatchObject({
      orderId: 'o42',
    });
  });

  it('reports out false while the kitchen has it or it is Ready, true once it went out', () => {
    for (const status of ['sent_to_kitchen', 'preparing', 'ready'] as const) {
      expect(samePhoneDelivery([live(42, status, '03001234567'), ADD_ON], ADD_ON)).toMatchObject({ orderNumber: '20261002-0042', out: false });
    }
    expect(samePhoneDelivery([live(42, 'out_for_delivery', '03001234567'), ADD_ON], ADD_ON)).toMatchObject({
      orderNumber: '20261002-0042',
      out: true,
    });
    // A website delivery of the same customer counts too.
    expect(samePhoneDelivery([live(42, 'preparing', '+923001234567', { orderNumber: 'CO-20261002-0042' }), ADD_ON], ADD_ON)).toMatchObject({
      orderNumber: 'CO-20261002-0042',
      out: false,
    });
  });

  it('ignores itself, closed orders, other phones, other order types and orders with no phone', () => {
    expect(samePhoneDelivery([ADD_ON], ADD_ON)).toBeNull();
    for (const status of ['open', 'delivered', 'served', 'paid', 'void', 'refunded'] as const) {
      expect(samePhoneDelivery([live(42, status, '03001234567'), ADD_ON], ADD_ON)).toBeNull();
    }
    expect(samePhoneDelivery([live(42, 'preparing', '03017654321'), ADD_ON], ADD_ON)).toBeNull();
    expect(samePhoneDelivery([live(42, 'preparing', null), ADD_ON], ADD_ON)).toBeNull();
    expect(samePhoneDelivery([live(42, 'preparing', '03001234567', { mode: 'takeaway' }), ADD_ON], ADD_ON)).toBeNull();
    // This order with no phone (a walk-in), or not a Pakistani number: no add-on rule.
    expect(samePhoneDelivery([live(42, 'preparing', '03001234567')], addOnWith(null))).toBeNull();
    expect(samePhoneDelivery([live(42, 'preparing', '12345')], addOnWith('12345'))).toBeNull();
  });

  it('one still in the shop comes first; then the one sent first', () => {
    const out = live(40, 'out_for_delivery', '03001234567');
    const kitchen = live(43, 'sent_to_kitchen', '03001234567');
    const ready = live(41, 'ready', '03001234567');
    expect(samePhoneDelivery([out, kitchen, ready, ADD_ON], ADD_ON)).toMatchObject({ orderId: 'o41', out: false });
    expect(samePhoneDelivery([out, live(44, 'out_for_delivery', '03001234567'), ADD_ON], ADD_ON)).toMatchObject({ orderId: 'o40', out: true });
  });

  const items = (charge: boolean) => [
    { menuItemName: 'Test Fries', lineTotalCents: 50_000 },
    ...(charge ? [{ menuItemName: 'Delivery Charge (Rs 200)', lineTotalCents: 20_000 }] : []),
  ];

  it('sameCustomerLine: "send them together" while #0042 is still here, charged or not', () => {
    for (const charge of [false, true]) {
      expect(sameCustomerLine({ orderId: 'o42', orderNumber: '20261002-0042', out: false }, { items: items(charge) })).toEqual({
        kind: 'together',
        text: 'Same customer as #0042 — send them together.',
      });
    }
  });

  it('sameCustomerLine: #0042 out and no charge on this bill — "has already gone out"; charged — nothing (a new trip); none — nothing', () => {
    const gone = { orderId: 'o42', orderNumber: '20261002-0042', out: true };
    expect(sameCustomerLine(gone, { items: items(false) })).toEqual({
      kind: 'gone',
      text: 'No delivery charge on this order: #0042 has already gone out.',
    });
    expect(sameCustomerLine(gone, { items: items(true) })).toBeNull();
    expect(sameCustomerLine(null, { items: items(false) })).toBeNull();
  });

  it('sendOutAsks: the paid one-tap only when the box would say nothing about the other delivery', () => {
    const paidNoCharge = { order: { totalCents: 57_500, paidAt: '2026-10-02T14:00:00.000Z' }, items: items(false) };
    expect(sendOutAsks(paidNoCharge)).toBe(false);
    expect(sendOutAsks(paidNoCharge, null)).toBe(false);
    expect(sendOutAsks(paidNoCharge, { orderId: 'o42', orderNumber: '20261002-0042', out: false })).toBe(true);
    expect(sendOutAsks(paidNoCharge, { orderId: 'o42', orderNumber: '20261002-0042', out: true })).toBe(true);
    // Charged: its box opens anyway (the drawer pays the rider).
    const paidCharged = { order: { totalCents: 80_500, paidAt: '2026-10-02T14:00:00.000Z' }, items: items(true) };
    expect(sendOutAsks(paidCharged, { orderId: 'o42', orderNumber: '20261002-0042', out: true })).toBe(true);
  });
});

type Item = OrderSnapshot['items'][number];
type LineOver = Omit<Partial<Item>, 'id' | 'parentOrderItemId'> & { id?: string; parentOrderItemId?: string | null };
const line = (over: LineOver): Item =>
  ({
    id: 'i',
    menuItemName: 'Fajita Pizza',
    quantity: 1,
    notes: null,
    parentOrderItemId: null,
    modifiers: [],
    ...over,
  }) as Item;
const mod = (modifierName: string) => ({ id: modifierName, modifierName }) as Item['modifiers'][number];

describe('card flags', () => {
  it('shows leave-outs and notes from every line, even hidden ones', () => {
    const items = [
      line({ id: 'a', menuItemName: 'Fries' }),
      line({ id: 'b', menuItemName: 'Burger', modifiers: [mod('Extra cheese'), mod('No onion')] }),
      line({ id: 'c', menuItemName: 'Wings' }),
      line({ id: 'd', menuItemName: 'Pizza', notes: ' Nut allergy ' }),
    ];
    expect(cardFlags({ items })).toEqual(['NO ONION (Burger)', 'Nut allergy (Pizza)']);
  });

  it('nothing to flag', () => {
    expect(cardFlags({ items: [line({ notes: '  ' })] })).toEqual([]);
  });
});

describe('card lines', () => {
  it('lists and counts deal parts once, under their deal', () => {
    const items = [
      line({ id: 'deal', quantity: 2 }),
      line({ id: 'part', parentOrderItemId: 'deal', quantity: 2 }),
      line({ id: 'fries', quantity: 1 }),
    ];
    expect(cardLines(items).map((i) => i.id)).toEqual(['deal', 'fries']);
    expect(cardItemCount(items)).toBe(3);
  });

  it("shows a deal's picks and a line's extras under it, leave-outs left to the red box", () => {
    const items = [
      line({ id: 'deal', menuItemName: 'Family Feast' }),
      line({ id: 'p1', parentOrderItemId: 'deal', menuItemName: 'Fajita Pizza — Large', modifiers: [mod('Extra cheese'), mod('No onion')] }),
      line({ id: 'p2', parentOrderItemId: 'deal', menuItemName: 'Garlic Dip', quantity: 2 }),
      line({ id: 'd1', parentOrderItemId: 'deal', menuItemName: '1.5 litre drink', modifiers: [mod('7up')] }),
      line({ id: 'burger', menuItemName: 'Zinger Burger', modifiers: [mod('Add a drink: Cola'), mod('No mayo')] }),
      line({ id: 'fries', menuItemName: 'Fries' }),
    ];
    expect(cardLineDetails(items[0]!, items)).toEqual(['Fajita Pizza — Large + Extra cheese', '2× Garlic Dip', '1.5 litre drink + 7up']);
    expect(cardLineDetails(items[4]!, items)).toEqual(['+ Add a drink: Cola']);
    expect(cardLineDetails(items[5]!, items)).toEqual([]);
  });
});

// The board's quick-cash notes are Pay's (checkout/tenderAmounts quickCashRupees): tested there.
describe('cash helpers', () => {
  it('reads rupees typed with commas', () => {
    expect(parseRupeesToCents('2,000')).toBe(200_000);
    expect(parseRupeesToCents(' 1850.5 ')).toBe(185_050);
    expect(parseRupeesToCents('Rs 500')).toBe(50_000);
    expect(parseRupeesToCents('')).toBeNaN();
    expect(parseRupeesToCents('12abc')).toBeNaN();
    expect(parseRupeesToCents('-5')).toBeNaN();
  });
});

describe('board search', () => {
  const snap = {
    order: { orderNumber: '20260926-0042' },
    customerName: 'Ali Khan',
    customerPhone: '0300-1234567',
    rider: { name: 'Bilal' },
  } as Parameters<typeof matchesBoardSearch>[0];

  it('finds by order number', () => {
    expect(matchesBoardSearch(snap, '42')).toBe(true);
    expect(matchesBoardSearch(snap, '#0042')).toBe(true);
    expect(matchesBoardSearch(snap, '4')).toBe(false);
  });

  it('finds by name, rider or phone', () => {
    expect(matchesBoardSearch(snap, 'ali')).toBe(true);
    expect(matchesBoardSearch(snap, 'bilal')).toBe(true);
    expect(matchesBoardSearch(snap, '03001234567')).toBe(true);
    expect(matchesBoardSearch(snap, '1234567')).toBe(true);
    expect(matchesBoardSearch(snap, 'sara')).toBe(false);
  });

  it('empty search shows everything', () => {
    expect(matchesBoardSearch(snap, '  ')).toBe(true);
  });
});

describe('the chef-hat button', () => {
  it('shows on New, Preparing and Ready cards only — never once the order is out for delivery or later', () => {
    const shown: OrderStatus[] = ['sent_to_kitchen', 'preparing', 'ready'];
    const hidden: OrderStatus[] = ['out_for_delivery', 'delivered', 'served', 'paid', 'void', 'refunded', 'open'];
    for (const status of shown) expect({ status, shown: offersKitchenReprint(status) }).toEqual({ status, shown: true });
    for (const status of hidden) expect({ status, shown: offersKitchenReprint(status) }).toEqual({ status, shown: false });
  });

  it('agrees with the counter rule the main process applies (the till refuses the rest for everyone)', () => {
    const all: OrderStatus[] = ['open', 'sent_to_kitchen', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'served', 'paid', 'void', 'refunded'];
    expect(all.filter(offersKitchenReprint)).toEqual([...KITCHEN_TICKET_STATUSES]);
  });
});
