/**
 * The kitchen's CHANGE slip (Edit order, v0.7.36): only what the edit changed,
 * under the same order number — ADD - MAKE NOW, then REMOVE - DO NOT MAKE —
 * leave-outs in capitals as on the ticket, the till's drinks rule followed,
 * no money anywhere, and a retry after a printer error says so. Every name
 * and number is made up.
 */
import { describe, expect, it } from 'vitest';
import type { Cents, KitchenChange, OrderNumber, OrderSnapshot, UUID } from '@cheeseoclock/shared-types';
import { escPosToText } from './escpos-decode.js';
import { renderKitchenChangeTicket, renderKitchenTicket } from './receipt-renderer.js';

const id = (s: string) => s as UUID;
const cents = (n: number) => n as Cents;
const NOW = new Date('2026-10-03T14:52:00.000Z'); // 19:52 in Karachi

function order(): OrderSnapshot {
  return {
    order: {
      id: id('o1'),
      orderNumber: '20261003-0042' as OrderNumber,
      mode: 'delivery',
      status: 'preparing',
      tableId: null,
      customerId: null,
      cashierId: id('u1'),
      shiftId: id('s1'),
      source: 'pos',
      notes: null,
      subtotalCents: cents(250_000),
      discountCents: cents(0),
      taxCents: cents(37_500),
      totalCents: cents(287_500),
      createdAt: '2026-10-03T14:30:00.000Z',
      paidAt: null,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
      assignedRiderId: null,
      dispatchedAt: null,
      deliveredAt: null,
    },
    items: [],
    discounts: [],
    payments: [],
    cashierName: 'Test Cashier',
    tableLabel: null,
    customerName: 'Test Hamza',
    customerPhone: '0300 0000000',
    deliveryAddress: 'House 1, Test Street',
    rider: null,
  };
}

const change: KitchenChange = {
  editNo: 2,
  at: NOW.toISOString(),
  byUserId: 'u_mgr',
  reason: 'Customer changed order',
  added: [{ name: 'Test Fajita Pizza — Large', quantity: 1, modifiers: ['No onion', 'Extra cheese'], notes: 'Well done', drink: false }],
  removed: [
    { name: 'Test Cola 345 ml', quantity: 2, modifiers: [], notes: null, drink: true },
    { name: 'Test Wings', quantity: 1, modifiers: [], notes: null, drink: false },
  ],
};

const text = (c: KitchenChange = change, opts: Parameters<typeof renderKitchenChangeTicket>[2] = {}) =>
  escPosToText(renderKitchenChangeTicket(order(), c, { now: NOW, byName: 'Test Manager', ...opts }));

describe('the kitchen CHANGE slip', () => {
  it('says what to make now and what not to make, under the same number', () => {
    const t = text();
    const at = (s: string) => {
      const i = t.indexOf(s);
      expect(i, s).toBeGreaterThanOrEqual(0);
      return i;
    };
    expect(at('KITCHEN')).toBeLessThan(at('* ORDER CHANGED *'));
    expect(at('* ORDER CHANGED *')).toBeLessThan(at('#0042'));
    at('DELIVERY');
    at('Change 2 - by Test Manager');
    at('Reason: Customer changed order');
    at('Customer: Test Hamza');
    expect(at('ADD - MAKE NOW')).toBeLessThan(at('1 x Test Fajita Pizza'));
    // The leave-out first and in capitals, then the extra, then the note.
    expect(at('NO ONION')).toBeLessThan(at('+ Extra cheese'));
    at('!! ALLERGY/NOTE: Well done');
    expect(at('REMOVE - DO NOT MAKE')).toBeLessThan(at('2 x Test Cola 345 ml'));
    at('1 x Test Wings');
    at('Everything else on #0042 stays as it is.');
    // Nothing about money.
    expect(t).not.toMatch(/Rs|TOTAL|2,875|287/);
  });

  it('leaves the drinks off when this till leaves them off its tickets, and says so', () => {
    const t = text(change, { showDrinks: false });
    expect(t).not.toContain('Test Cola');
    expect(t).toContain('2 drinks changed at the counter (not listed)');
    expect(t).toContain('1 x Test Wings');
  });

  it('prints only the half that has lines', () => {
    const onlyAdd = text({ ...change, removed: [], reason: null });
    expect(onlyAdd).toContain('ADD - MAKE NOW');
    expect(onlyAdd).not.toContain('REMOVE');
    expect(onlyAdd).not.toContain('Reason:');
    const onlyRemove = text({ ...change, added: [] });
    expect(onlyRemove).not.toContain('ADD - MAKE NOW');
    expect(onlyRemove).toContain('REMOVE - DO NOT MAKE');
  });

  it('a retry after a printer error says to check for it, a reprint says not to do it twice, a late one says LATE', () => {
    expect(text(change, { stamp: { kind: 'retry', number: 0, printedAt: NOW } })).toContain('CHECK FOR THIS CHANGE BEFORE COOKING');
    expect(text(change, { stamp: { kind: 'reprint', number: 1, printedAt: NOW } })).toContain('SAME CHANGE - DO NOT DO IT TWICE');
    expect(text(change, { queuedAt: new Date(NOW.getTime() - 5 * 60_000) })).toContain('LATE - sent 19:47');
  });

  it('a deal says what it is made of, under it and before its choices, as on the ticket; other lines print nothing more', () => {
    const deal = {
      name: 'Test Burger Deal',
      quantity: 1,
      modifiers: ['No onion', 'Cola'],
      notes: null,
      drink: false,
      contents: '1 Test Crispy Burger + 1 Regular Fries + 345ml Drink',
    };
    const t = text({ ...change, added: [deal], removed: [{ ...deal, modifiers: [], name: 'Test Pizza Deal', contents: '2 Large test pizzas' }] });
    const at = (s: string) => {
      const i = t.indexOf(s);
      expect(i, s).toBeGreaterThanOrEqual(0);
      return i;
    };
    expect(at('1 x Test Burger Deal')).toBeLessThan(at('Includes: 1 Test Crispy Burger'));
    expect(at('Includes: 1 Test Crispy Burger')).toBeLessThan(at('345ml Drink'));
    expect(at('Includes: 1 Test Crispy Burger')).toBeLessThan(at('NO ONION'));
    expect(at('NO ONION')).toBeLessThan(at('+ Cola'));
    // What not to make says it too.
    expect(at('REMOVE - DO NOT MAKE')).toBeLessThan(at('Includes: 2 Large test pizzas'));
    // Wrapped under the line, indented, inside the paper.
    for (const ln of t.split('\n').filter((l) => /Includes:|345ml/.test(l))) {
      expect(ln.startsWith('    ')).toBe(true);
      expect(ln.length).toBeLessThanOrEqual(48);
    }
    // A line with no contents (and a slip frozen before there were any) prints no Includes.
    expect(text()).not.toContain('Includes:');
  });

  it('is not the order ticket: the ticket itself is unchanged', () => {
    const ticket = escPosToText(renderKitchenTicket(order(), { now: NOW }));
    expect(ticket).not.toContain('ORDER CHANGED');
  });
});
