/**
 * A deal on the kitchen ticket (the user, 25 Oct 2026: "kitchen slip make them easy to understand"; v0.7.57): its
 * choices are its parts, one "- " line each, in the order the kitchen makes them — what was picked, the deal's fixed
 * parts ("Comes with"), the dips, the drink last. With its fixed parts among its choices the long "Includes:" sentence
 * is left out; without them it stays, as before. Any other item's choices are additions: "+ ". Every name is made up.
 */
import { describe, expect, it } from 'vitest';
import type { Cents, OrderNumber, OrderSnapshot, UUID } from '@cheeseoclock/shared-types';
import { escPosToText } from './escpos-decode.js';
import { dealPartsInOrder, renderKitchenTicket } from './receipt-renderer.js';

const id = (s: string) => s as UUID;
const cents = (n: number) => n as Cents;
const NOW = new Date('2026-10-25T11:30:00.000Z');

type Line = OrderSnapshot['items'][number];
const mod = (name: string, fixed = false) => ({
  id: id(`m:${name}`),
  orderItemId: id('l1'),
  modifierId: id(`x:${name}`),
  modifierName: name,
  priceDeltaCents: cents(0),
  ...(fixed ? { fixed: true as const } : {}),
});

function line(name: string, over: Partial<Line> = {}): Line {
  return {
    id: id(`l:${name}`),
    orderId: id('o1'),
    menuItemId: id(`i:${name}`),
    comboId: null,
    parentOrderItemId: null,
    quantity: 1,
    unitPriceCents: cents(480_000),
    lineTotalCents: cents(480_000),
    taxCategoryId: id('t1'),
    taxRateBps: 1500,
    notes: null,
    kitchenStatus: 'pending',
    noDiscount: true,
    menuItemName: name,
    categoryName: 'Value Deals',
    prepStation: 'kitchen',
    modifiers: [],
    ...over,
  } as Line;
}

function ticket(items: Line[]): string {
  const snap = {
    order: {
      id: id('o1'),
      orderNumber: '20261025-0018' as OrderNumber,
      mode: 'takeaway',
      status: 'preparing',
      tableId: null,
      customerId: null,
      cashierId: id('u1'),
      shiftId: id('s1'),
      source: 'pos',
      notes: null,
      subtotalCents: cents(480_000),
      discountCents: cents(0),
      taxCents: cents(0),
      totalCents: cents(480_000),
      createdAt: NOW.toISOString(),
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
    customerName: null,
    customerPhone: null,
    deliveryAddress: null,
    rider: null,
  } as unknown as OrderSnapshot;
  return escPosToText(renderKitchenTicket(snap, { now: NOW }));
}

const listed = (t: string) => t.split('\n').map((l) => l.trim()).filter((l) => /^[-+] /.test(l));

describe('a deal on the kitchen ticket', () => {
  it('with its fixed parts among its choices: each part on its own "- " line, food first, dips, the drink last; no Includes', () => {
    const t = ticket([
      line('Test Mega Box', {
        dealContents: 'Large + Medium regular pizza + Cheese Dipped or Nashville burger + Signature Crispy burger + fries + 1 litre drink + 2 dips',
        dealPartsListed: true,
        modifiers: [
          mod('Signature Crispy burger', true),
          mod('Regular fries', true),
          mod('Large: Malai Supreme'),
          mod('Medium: Fajita Pizza'),
          mod('Burger: Signature Cheese Dipped'),
          mod('Pepsi 1 litre'),
          mod('Signature Orange Dip'),
          mod('2nd dip: Signature Orange Dip'),
        ],
      }),
    ]);
    expect(listed(t)).toEqual([
      '- Large: Malai Supreme',
      '- Medium: Fajita Pizza',
      '- Burger: Signature Cheese Dipped',
      '- Signature Crispy burger',
      '- Regular fries',
      '- Signature Orange Dip',
      '- 2nd dip: Signature Orange Dip',
      '- Pepsi 1 litre',
    ]);
    expect(t).not.toContain('Includes:');
  });

  it('a burger deal: the burger and the fries, then the drink', () => {
    const t = ticket([
      line('Test Classic Crispy Deal', {
        dealContents: 'Classic Crispy burger + regular fries + 345 ml drink',
        dealPartsListed: true,
        modifiers: [mod('Classic Crispy burger', true), mod('Regular fries', true), mod('Pepsi 345 ml')],
      }),
    ]);
    expect(listed(t)).toEqual(['- Classic Crispy burger', '- Regular fries', '- Pepsi 345 ml']);
  });

  it('without fixed parts: its Includes stays, and its choices are listed as parts too', () => {
    const t = ticket([line('Test Deal', { dealContents: 'Large pizza + 1 litre drink', modifiers: [mod('Pepsi 1 litre'), mod('Large: Fajita Pizza')] })]);
    expect(t).toContain('Includes: Large pizza + 1 litre drink');
    expect(listed(t)).toEqual(['- Large: Fajita Pizza', '- Pepsi 1 litre']);
  });

  it('any other item: its choices are additions, as before', () => {
    const t = ticket([line('Test Fajita Pizza — Large', { categoryName: 'Pizza', noDiscount: false, modifiers: [mod('Extra cheese'), mod('Ranch Dip')] })]);
    expect(listed(t)).toEqual(['+ Extra cheese', '+ Ranch Dip']);
  });

  it('dealPartsInOrder: picks, fixed parts, dips, drinks — each kind in the order asked', () => {
    expect(dealPartsInOrder(['2nd: 7Up 345 ml', 'BBQ Dip', 'Fries', 'Large: Fajita', 'Pepsi 345 ml', 'Ranch Dip'], new Set(['Fries']))).toEqual([
      'Large: Fajita',
      'Fries',
      'BBQ Dip',
      'Ranch Dip',
      '2nd: 7Up 345 ml',
      'Pepsi 345 ml',
    ]);
  });
});
