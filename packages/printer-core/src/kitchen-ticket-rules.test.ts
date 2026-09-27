import { describe, expect, it } from 'vitest';
import type { Cents, OrderNumber, OrderSnapshot, UUID } from '@cheeseoclock/shared-types';
import { CUT_MARKER, decodeEscPos } from './escpos-decode.js';
import { isDrinkLine, renderKitchenTicket } from './receipt-renderer.js';

/**
 * The kitchen ticket's rules (Settings → Printers, this till's
 * printer.policy; Settings phase 7): the customer's phone and the drinks on
 * the ticket, and several tickets at once. With the rules left out — a till
 * with nothing saved — the ticket is byte for byte today's. The allergy and
 * leave-out wording never changes. Every name and number is made up.
 */
const id = (s: string) => s as UUID;
const cents = (n: number) => n as Cents;
const rows = (bytes: Uint8Array) => decodeEscPos(bytes).map((r) => r.text);
const now = new Date(2026, 8, 28, 19, 35);

type Line = OrderSnapshot['items'][number];
function line(n: string, name: string, categoryName: string, prepStation: Line['prepStation'], quantity: number, extra: Partial<Line> = {}): Line {
  return {
    id: id(`i${n}`),
    orderId: id('o1'),
    menuItemId: id(`m${n}`),
    comboId: null,
    parentOrderItemId: null,
    quantity,
    unitPriceCents: cents(100_000),
    lineTotalCents: cents(100_000 * quantity),
    taxCategoryId: id('t1'),
    notes: null,
    kitchenStatus: 'pending',
    menuItemName: name,
    categoryName,
    prepStation,
    modifiers: [],
    ...extra,
  };
}

function order(items: Line[]): OrderSnapshot {
  return {
    order: {
      id: id('o1'),
      orderNumber: '20260928-0077' as OrderNumber,
      mode: 'delivery',
      status: 'sent_to_kitchen',
      tableId: null,
      customerId: id('c1'),
      cashierId: id('u1'),
      shiftId: id('s1'),
      source: 'pos',
      notes: null,
      subtotalCents: cents(300_000),
      discountCents: cents(0),
      taxCents: cents(0),
      totalCents: cents(300_000),
      createdAt: '2026-09-28T14:30:00.000Z',
      paidAt: null,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
      assignedRiderId: null,
      dispatchedAt: null,
      deliveredAt: null,
    },
    items,
    discounts: [],
    payments: [],
    cashierName: 'Test Cashier',
    tableLabel: null,
    customerName: 'Test Customer',
    customerPhone: '0300 0000001',
    deliveryAddress: 'Test Street 1',
    rider: null,
  } as OrderSnapshot;
}

const PIZZA = line('1', 'Test Pizza', 'Pizza', 'kitchen', 2, {
  notes: 'No nuts at all',
  modifiers: [{ id: id('mo1'), orderItemId: id('i1'), modifierId: id('md1'), modifierName: 'No onions', priceDeltaCents: cents(0) }],
});
const COLA = line('2', 'Test Cola 345ml', 'Drinks', 'kitchen', 2);
const JUICE = line('3', 'Test Juice', 'Starters', 'bar', 1);
const MIXED = () => order([PIZZA, COLA, JUICE]);

describe('a till with nothing saved: today’s ticket', () => {
  it('the rules left out, or given as the released ones, print the same bytes', () => {
    const today = renderKitchenTicket(MIXED(), { now });
    expect([...renderKitchenTicket(MIXED(), { now, showPhone: true, showDrinks: true, copyOf: null })]).toEqual([...today]);
    expect([...renderKitchenTicket(MIXED(), { now, copyOf: { n: 1, of: 1 } })]).toEqual([...today]);
    const r = rows(today);
    expect(r.some((x) => /^Customer: Test Customer\s+0300 0000001$/.test(x))).toBe(true);
    expect(r).toContain('2 x Test Cola 345ml');
    expect(r).toContain('1 x Test Juice');
    expect(r.join(' ')).not.toContain('COPY');
    expect(r.join(' ')).not.toContain('from the counter');
  });
});

describe('the customer’s phone', () => {
  it('off: the name without the phone; the allergy and leave-out notes as loud as ever', () => {
    const r = rows(renderKitchenTicket(MIXED(), { now, showPhone: false }));
    expect(r.some((x) => /^Customer: Test Customer\s*$/.test(x))).toBe(true);
    expect(r.join(' ')).not.toContain('0300 0000001');
    expect(r).toContain('    NO ONIONS');
    expect(r.join(' ')).toContain('!! ALLERGY/NOTE: No nuts at all');
  });

  it('off, and no name: no customer line at all', () => {
    const s = MIXED();
    s.customerName = null;
    expect(rows(renderKitchenTicket(s, { now, showPhone: false })).some((x) => x.startsWith('Customer:'))).toBe(false);
  });
});

describe('the drinks', () => {
  it('a drink is an item sent to the bar or in a Drinks / Beverages category', () => {
    expect(isDrinkLine({ categoryName: 'Drinks', prepStation: 'kitchen' })).toBe(true);
    expect(isDrinkLine({ categoryName: 'Cold Drinks', prepStation: 'kitchen' })).toBe(true);
    expect(isDrinkLine({ categoryName: 'Beverages', prepStation: 'kitchen' })).toBe(true);
    expect(isDrinkLine({ categoryName: 'Starters', prepStation: 'bar' })).toBe(true);
    expect(isDrinkLine({ categoryName: 'Pizza', prepStation: 'kitchen' })).toBe(false);
    expect(isDrinkLine({ categoryName: 'Drinking Chocolate Cake', prepStation: 'kitchen' })).toBe(false);
  });

  it('off: left off the ticket, one line says how many the counter hands out; the food and its notes stay', () => {
    const r = rows(renderKitchenTicket(MIXED(), { now, showDrinks: false }));
    expect(r.join(' ')).not.toContain('Test Cola');
    expect(r.join(' ')).not.toContain('Test Juice');
    expect(r).toContain('+ 3 drinks from the counter (not listed)');
    expect(r.some((x) => x.startsWith('2 x Test Pizza'))).toBe(true);
    expect(r).toContain('    NO ONIONS');
    expect(r.join(' ')).toContain('!! ALLERGY/NOTE: No nuts at all');
  });

  it('off, one drink: said once', () => {
    const r = rows(renderKitchenTicket(order([PIZZA, line('4', 'Test Water', 'Drinks', 'kitchen', 1)]), { now, showDrinks: false }));
    expect(r).toContain('+ 1 drink from the counter (not listed)');
  });

  it('off, only drinks (a ticket printed by hand): says there is nothing to cook', () => {
    const r = rows(renderKitchenTicket(order([COLA]), { now, showDrinks: false }));
    expect(r).toContain('Only drinks (2) - nothing to cook');
  });
});

describe('several tickets at once', () => {
  it('each says which it is, under the order type', () => {
    for (const n of [1, 2]) {
      const r = rows(renderKitchenTicket(MIXED(), { now, copyOf: { n, of: 2 } }));
      expect(r).toContain(`COPY ${n} OF 2`);
      expect(r.indexOf(`COPY ${n} OF 2`)).toBeGreaterThan(r.indexOf('DELIVERY'));
      expect(r.at(-1)).toBe(CUT_MARKER);
    }
  });

  it('never wider than the paper', () => {
    for (const width of [48, 32] as const) {
      for (const row of decodeEscPos(renderKitchenTicket(MIXED(), { width, now, copyOf: { n: 3, of: 3 }, showDrinks: false, showPhone: false }))) {
        expect(row.text.length * row.scale, JSON.stringify(row.text)).toBeLessThanOrEqual(width);
      }
    }
  });
});
