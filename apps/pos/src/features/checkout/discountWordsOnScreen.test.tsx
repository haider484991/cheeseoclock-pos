/**
 * The owner, 28 Sep 2026: "Delivery charges is separate we don't want to add
 * discount to it". Every screen that shows a bill says so when an order's
 * discount left its delivery charge alone — the cart, Pay, the receipt after
 * Pay and the order drawer — from the discount's OWN frozen rule (the
 * snapshot's alsoOffDeliveryCharge), and reads exactly as before for a
 * discount that came off the charge too. Static renders (react-dom/server,
 * no browser; nothing calls the till); Radix's dialog is stood in for by
 * plain elements. Every name and amount is made up.
 *
 * v0.7.34 (step 15-3): the receipt after Pay shows a delivery with a
 * delivery charge as the owner's delivery bill, the same rows and figures as
 * the paper (shared-types deliveryBillOf; the owner, 2 Oct 2026: "Food /
 * Sales tax / FOOD TOTAL (with tax) / Delivery charge / CUSTOMER PAYS").
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, OrderSnapshot, UUID } from '@cheeseoclock/shared-types';
import { decodeEscPos, renderReceipt } from '@cheeseoclock/printer-core';
import { ToastProvider } from '../../components/toast/ToastProvider';
import { useSessionStore } from '../../stores/sessionStore';
import { useCheckoutStore } from '../../stores/checkoutStore';
import { CartPane } from './CartPane';
import { TenderDialog } from './TenderDialog';
import { ReceiptDialog } from './ReceiptDialog';
import { OrderDetailDrawer } from '../orders/OrderDetailDrawer';

// A server render has no portal: the dialog's parts render in place.
vi.mock('@radix-ui/react-dialog', async () => {
  const React = await import('react');
  const h = React.createElement;
  type P = { children?: ReactNode; className?: string };
  const pass = ({ children }: P) => h(React.Fragment, null, children);
  const tag =
    (t: string, extra: Record<string, string> = {}) =>
    ({ children, className }: P) =>
      h(t, { className, ...extra }, children);
  return {
    Root: pass,
    Portal: pass,
    Overlay: () => null,
    Content: tag('div', { role: 'dialog' }),
    Title: tag('h2'),
    Description: tag('p'),
    Close: pass,
    Trigger: pass,
  };
});

// A server render reads a zustand store's INITIAL state; the till's window reads each as it is now.
vi.mock('zustand', async (importOriginal) => {
  const z = await importOriginal<typeof import('zustand')>();
  type Hook = ((select?: (state: unknown) => unknown) => unknown) & { getState: () => unknown };
  const live = (hook: Hook) =>
    Object.assign((select: (state: unknown) => unknown = (state) => state) => select(hook.getState()), hook);
  const make = (init: unknown) => live(z.create(init as Parameters<typeof z.create>[0]) as unknown as Hook);
  return { ...z, create: (init?: unknown) => (init === undefined ? make : make(init)) };
});

function signIn(role: AuthenticatedUser['role']) {
  useSessionStore.setState({ user: { id: 'u1' as UUID, fullName: 'Test', role, sessionId: 's1' as UUID }, status: 'authenticated' });
}

function render(node: ReactNode, seed: Array<[readonly unknown[], unknown]> = []): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const [key, data] of seed) qc.setQueryData(key, data);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ToastProvider>{node}</ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const text = (markup: string) => decode(markup.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

const line = (id: string, name: string, cents: number) => ({
  id,
  orderId: 'o1',
  menuItemId: `m_${id}`,
  menuItemName: name,
  quantity: 1,
  unitPriceCents: cents,
  lineTotalCents: cents,
  taxRateBps: 1_600,
  notes: null,
  modifiers: [],
  kitchenStatus: 'pending',
  createdAt: '2026-09-28T10:00:00.000Z',
});

/**
 * A delivery order: Rs 2,000 of food and a Rs 200 delivery charge, 10% off.
 * `alsoOff` is the discount's frozen rule: false = the food only (Rs 200
 * off), true = the whole bill (Rs 220), undefined = a row with no rule.
 */
function deliveryOrder(status: 'open' | 'paid', alsoOff: boolean | undefined): OrderSnapshot {
  const discountCents = alsoOff === false ? 20_000 : 22_000;
  const taxCents = alsoOff === false ? 32_000 : 31_680;
  const totalCents = 220_000 - discountCents + taxCents;
  return {
    order: {
      id: 'o1',
      orderNumber: '20260928-0007',
      mode: 'delivery',
      status,
      source: 'pos',
      notes: null,
      cashierId: 'u1',
      tableId: null,
      subtotalCents: 220_000,
      discountCents,
      taxCents,
      totalCents,
      createdAt: '2026-09-28T10:00:00.000Z',
      paidAt: status === 'paid' ? '2026-09-28T10:20:00.000Z' : null,
      dispatchedAt: null,
    },
    items: [line('l1', 'Test Pizza', 100_000), line('l2', 'Delivery Charge (Rs 200)', 20_000), line('l3', 'Test Side', 100_000)],
    discounts: [
      {
        id: 'd1',
        orderId: 'o1',
        discountType: 'percent',
        value: 10,
        reason: 'Staff',
        appliedByUserId: 'u1',
        approvedByUserId: null,
        amountCents: discountCents,
        source: null,
        foodpanda: null,
        ...(alsoOff === undefined ? {} : { alsoOffDeliveryCharge: alsoOff }),
      },
    ],
    payments:
      status === 'paid'
        ? [{ id: 'p1', orderId: 'o1', method: 'cash', amountCents: totalCents, tenderedCents: totalCents, referenceNo: null, receivedByUserId: 'u1', paidAt: '2026-09-28T10:20:00.000Z' }]
        : [],
    cashierName: 'Test Cashier',
    tableLabel: null,
    customerName: 'Test Customer',
    customerPhone: '03001234567',
    deliveryAddress: 'House 1, Test Street',
    deliveryNotes: null,
    rider: null,
  } as unknown as OrderSnapshot;
}

const noop = () => {};

describe('a discount that left the delivery charge alone says "food only" on every bill screen', () => {
  it('the cart', () => {
    signIn('cashier');
    useCheckoutStore.setState({ snapshot: deliveryOrder('open', false), busy: false });
    const words = text(
      render(
        <CartPane
          step="items"
          onContinue={noop}
          onBack={noop}
          onPay={noop}
          onDiscount={noop}
          onRemoveDeal={noop}
          onSendToKitchen={noop}
          onCustomize={noop}
        />,
      ),
    );
    expect(words).toContain('Discount · 10% off food · Staff');
  });

  it('Pay', () => {
    signIn('cashier');
    const snapshot = deliveryOrder('open', false);
    useCheckoutStore.setState({ snapshot, busy: false });
    expect(text(render(<TenderDialog snapshot={snapshot} onClose={noop} onPaid={noop} />))).toContain('Discount (food only)');
  });

  // Changed on purpose in v0.7.34 (step 15-3): a delivery with a delivery charge shows the
  // delivery bill (Food / Sales tax / Food total (with tax) / Delivery charge / Customer pays),
  // where it showed 'Subtotal 2,200 Discount (Staff, food only) −200 Tax 320 Total Rs 2,320'.
  it('the receipt after Pay: "Discount (Staff, food only)" under Rs 2,000 of food, on the delivery bill', () => {
    signIn('cashier');
    const words = text(render(<ReceiptDialog snapshot={deliveryOrder('paid', false)} onClose={noop} />));
    expect(words).toContain('Discount (Staff, food only)');
    expect(words).toContain(
      'Food 2,000 Discount (Staff, food only) −200 Sales tax 16% 288 Sales tax on delivery 16% 32 Food total (with tax) Rs 2,120 Delivery charge 200 Customer pays Rs 2,320',
    );
  });

  it('the order drawer', () => {
    signIn('admin');
    const snapshot = deliveryOrder('paid', false);
    const words = text(render(<OrderDetailDrawer orderId="o1" onClose={noop} />, [[['orders', 'detail', 'o1'], snapshot]]));
    expect(words).toContain('Discount (Staff, food only)');
  });
});

describe('a discount that came off the delivery charge too (or given before the rule) reads exactly as before', () => {
  for (const alsoOff of [true, undefined]) {
    it(`frozen rule ${String(alsoOff)}: no "food only" anywhere`, () => {
      signIn('admin');
      const open = deliveryOrder('open', alsoOff);
      useCheckoutStore.setState({ snapshot: open, busy: false });
      const cart = text(
        render(
          <CartPane
            step="items"
            onContinue={noop}
            onBack={noop}
            onPay={noop}
            onDiscount={noop}
            onRemoveDeal={noop}
            onSendToKitchen={noop}
            onCustomize={noop}
          />,
        ),
      );
      expect(cart).toContain('Discount · 10% · Staff');
      const pay = text(render(<TenderDialog snapshot={open} onClose={noop} onPaid={noop} />));
      const paid = deliveryOrder('paid', alsoOff);
      const receipt = text(render(<ReceiptDialog snapshot={paid} onClose={noop} />));
      expect(receipt).toContain('Discount (Staff)');
      const drawer = text(render(<OrderDetailDrawer orderId="o1" onClose={noop} />, [[['orders', 'detail', 'o1'], paid]]));
      expect(drawer).toContain('Discount (Staff)');
      for (const words of [cart, pay, receipt, drawer]) expect(words).not.toContain('food only');
    });
  }
});

// ---------------------------------------------------------------------------
// The delivery bill on the receipt after Pay (v0.7.34, step 15-3)
// ---------------------------------------------------------------------------

/** An order line at the given tax rate; `noDiscount` marks a value deal. */
const billLine = (id: string, name: string, cents: number, taxRateBps: number, noDiscount = false) => ({
  ...line(id, name, cents),
  taxRateBps,
  ...(noDiscount ? { noDiscount: true } : {}),
});
type BillLine = ReturnType<typeof billLine>;

/**
 * An order paid in cash at the counter, with the stored discount and tax
 * given (worked by hand in each case); the total is subtotal − discount +
 * tax, as the till stores it. A delivery unless `mode` says otherwise.
 */
function paidBill(
  items: BillLine[],
  stored: { discount?: number; tax: number },
  discounts: Array<Record<string, unknown>> = [],
  mode: 'delivery' | 'takeaway' = 'delivery',
): OrderSnapshot {
  const subtotalCents = items.reduce((n, l) => n + l.lineTotalCents, 0);
  const discountCents = stored.discount ?? 0;
  const totalCents = subtotalCents - discountCents + stored.tax;
  return {
    order: {
      id: 'o1',
      orderNumber: '20261002-0042',
      mode,
      status: 'paid',
      source: 'pos',
      notes: null,
      cashierId: 'u1',
      tableId: null,
      subtotalCents,
      discountCents,
      taxCents: stored.tax,
      totalCents,
      createdAt: '2026-10-02T14:30:00.000Z',
      sentAt: '2026-10-02T14:31:00.000Z',
      paidAt: '2026-10-02T14:40:00.000Z',
      dispatchedAt: null,
    },
    items,
    discounts,
    payments: [
      { id: 'p1', orderId: 'o1', method: 'cash', amountCents: totalCents, tenderedCents: totalCents, referenceNo: null, receivedByUserId: 'u1', paidAt: '2026-10-02T14:40:00.000Z' },
    ],
    cashierName: 'Test Cashier',
    tableLabel: null,
    customerName: 'Test Customer',
    customerPhone: '03001234567',
    deliveryAddress: 'House 1, Test Street',
    deliveryNotes: null,
    rider: null,
  } as unknown as OrderSnapshot;
}

const BIG_TWO = () => billLine('b1', 'Big Two', 360_000, 1_500, true);
const FRIES = () => billLine('b2', 'Fries', 30_000, 1_500);
const PIZZA = () => billLine('b3', 'Test Pizza', 220_000, 1_500);
const CHARGE = (bps: number) => billLine('b4', 'Delivery Charge (Rs 200)', 20_000, bps);

/** The owner's example: Big Two Rs 3,600 and Fries Rs 300 at 15%, and the Rs 200 charge (0%, or 15% as the live menu has it). */
const ownerExample = (chargeBps: 0 | 1_500) => paidBill([BIG_TWO(), FRIES(), CHARGE(chargeBps)], { tax: 58_500 + (chargeBps ? 3_000 : 0) });

/**
 * Big Two Rs 3,600 (a value deal), a Rs 2,200 pizza and the Rs 200 charge,
 * all at 15%, with a staff 10% that left the deal and the charge alone: Rs
 * 220 off the pizza; tax Rs 837 on the food and Rs 30 on the charge (the
 * paper's own example, receipt-delivery-bill.test.ts).
 */
const dealAndStaff = () =>
  paidBill([BIG_TWO(), PIZZA(), CHARGE(1_500)], { discount: 22_000, tax: 86_700 }, [
    {
      id: 'd1',
      orderId: 'o1',
      discountType: 'percent',
      value: 10,
      reason: 'Staff',
      appliedByUserId: 'u1',
      approvedByUserId: null,
      amountCents: 22_000,
      source: null,
      foodpanda: null,
      alsoOffDeliveryCharge: false,
      skipsNoDiscountLines: true,
    },
  ]);

/** Rupees as the screen ("Rs 4,515", "−220", "316.80") or the paper ("4,515.00", "- 220.00") shows them, to paisa. */
const paisaOf = (amount: string) => {
  const minus = /^(−|- )/.test(amount);
  const rupees = Number(amount.replace(/^(−|- )/, '').replace(/^Rs /, '').replace(/,/g, ''));
  return (minus ? -1 : 1) * Math.round(rupees * 100);
};

/** The receipt's money rows on screen from `first` ('Food' or 'Subtotal') to the last total row: [words, paisa]. */
function screenRows(markup: string, first: string, last: string): Array<[string, number]> {
  const rows = [...markup.matchAll(/<div class="flex justify-between[^"]*"><span>([^<]*)<\/span><span>([^<]*)<\/span><\/div>/g)].map(
    (m): [string, number] => [decode(m[1] ?? ''), paisaOf(decode(m[2] ?? ''))],
  );
  const start = rows.findIndex(([words]) => words === first);
  const end = rows.findIndex(([words]) => words === last);
  expect(start, first).toBeGreaterThan(-1);
  expect(end, last).toBeGreaterThan(start);
  return rows.slice(start, end + 1);
}

/**
 * The paper's delivery-bill rows (printer-core renderReceipt at 80 mm), Food
 * to CUSTOMER PAYS, the rules left out: [words, paisa]. A label too long for
 * its row (the paper wraps it) is joined to the row that carries its amount.
 */
function paperRows(snapshot: OrderSnapshot): Array<[string, number]> {
  const rows = decodeEscPos(renderReceipt(snapshot, { branding: { storeName: 'Test Shop' } })).map((r) => r.text);
  const start = rows.findIndex((r) => /^Food\s/.test(r));
  const end = rows.findIndex((r) => r.startsWith('CUSTOMER PAYS'));
  expect(start, 'Food').toBeGreaterThan(-1);
  expect(end, 'CUSTOMER PAYS').toBeGreaterThan(start);
  const out: Array<[string, number]> = [];
  let wrapped = '';
  for (const r of rows.slice(start, end + 1)) {
    if (/^[-=]+$/.test(r)) continue;
    const m = /^(.*?)\s*((?:- )?(?:Rs )?[\d,]+\.\d\d)$/.exec(r);
    if (!m) {
      wrapped = `${wrapped} ${r.trim()}`.trim();
      continue;
    }
    out.push([`${wrapped} ${(m[1] ?? '').trim()}`.trim(), paisaOf(m[2] ?? '')]);
    wrapped = '';
  }
  return out;
}

const receiptOf = (snapshot: OrderSnapshot) => render(<ReceiptDialog snapshot={snapshot} onClose={noop} />);

describe('the receipt after Pay shows a delivery with a delivery charge as the paper does (v0.7.34)', () => {
  it('the owner’s example, the charge taxed at 15% (the live menu, Q1): Food / Sales tax 15% / Sales tax on delivery 15% / Food total (with tax) / Delivery charge / Customer pays', () => {
    signIn('cashier');
    const words = text(receiptOf(ownerExample(1_500)));
    expect(words).toContain(
      '1× Big Two 3,600 1× Fries 300 Food 3,900 Sales tax 15% 585 Sales tax on delivery 15% 30 Food total (with tax) Rs 4,515 Delivery charge 200 Customer pays Rs 4,715',
    );
    // The charge shows once, under Food total, never also as an item; the old rows are gone.
    expect(words).not.toContain('Delivery Charge (Rs 200)');
    expect(words).not.toContain('Subtotal');
    expect(words).not.toMatch(/\bTax\b/);
    expect(words).not.toMatch(/\bTotal\b/);
  });

  it('the charge zero-rated: no "Sales tax on delivery" row; Food total (with tax) Rs 4,485, Customer pays Rs 4,685', () => {
    signIn('cashier');
    const words = text(receiptOf(ownerExample(0)));
    expect(words).toContain('Food 3,900 Sales tax 15% 585 Food total (with tax) Rs 4,485 Delivery charge 200 Customer pays Rs 4,685');
    expect(words).not.toContain('Sales tax on delivery');
    expect(words).not.toContain('Delivery Charge (Rs 200)');
  });

  it('Food total is semibold; Customer pays takes the Total row’s style (rule above, bold, larger)', () => {
    signIn('cashier');
    const markup = receiptOf(ownerExample(1_500));
    expect(markup).toContain('<div class="flex justify-between font-semibold"><span>Food total (with tax)</span><span>Rs 4,515</span></div>');
    expect(markup).toContain(
      '<div class="flex justify-between border-t border-stone-300 pt-1 text-base font-bold dark:border-stone-700"><span>Customer pays</span><span>Rs 4,715</span></div>',
    );
  });

  it('every row and figure is the paper’s, in the same order (the paper says FOOD TOTAL and CUSTOMER PAYS in capitals)', () => {
    signIn('cashier');
    for (const s of [ownerExample(0), ownerExample(1_500), deliveryOrder('paid', true), deliveryOrder('paid', undefined)]) {
      const screen = screenRows(receiptOf(s), 'Food', 'Customer pays');
      const paper = paperRows(s);
      expect(screen.map(([words, cents]) => [words.toLowerCase(), cents])).toEqual(paper.map(([words, cents]) => [words.toLowerCase(), cents]));
    }
  });

  it('the deal + staff 10% example: the discount row’s words are the paper’s, and so is every figure', () => {
    signIn('cashier');
    const s = dealAndStaff();
    const markup = receiptOf(s);
    expect(text(markup)).toContain(
      'Food 5,800 Discount (Staff, food only, not on value deals) −220 Sales tax 15% 837 Sales tax on delivery 15% 30 Food total (with tax) Rs 6,447 Delivery charge 200 Customer pays Rs 6,647',
    );
    const screen = screenRows(markup, 'Food', 'Customer pays');
    const paper = paperRows(s);
    expect(screen.map(([, cents]) => cents)).toEqual([580_000, -22_000, 83_700, 3_000, 644_700, 20_000, 664_700]);
    expect(paper.map(([, cents]) => cents)).toEqual(screen.map(([, cents]) => cents));
    // The discount row: what it left alone, in the paper's words. The screen
    // names it as every receipt on screen does (receiptDiscountLabel, as
    // before); the paper also prints the % beside "Discount" (discountBillLabel).
    const [screenDiscount, paperDiscount] = [screen[1]?.[0] ?? '', paper[1]?.[0] ?? ''];
    expect(screenDiscount).toBe('Discount (Staff, food only, not on value deals)');
    expect(paperDiscount).toBe('Discount 10% (Staff, food only, not on value deals)');
    const inBrackets = (words: string) => /\((.*)\)$/.exec(words)?.[1];
    expect(inBrackets(screenDiscount)).toBe(inBrackets(paperDiscount));
    // Every other row word for word.
    const others = (rows: Array<[string, number]>) => rows.filter((_, i) => i !== 1).map(([words]) => words.toLowerCase());
    expect(others(screen)).toEqual(others(paper));
  });

  it('a discount that came off the charge too (or one from before the rule): all the tax on one "Sales tax 16%" row', () => {
    signIn('cashier');
    for (const alsoOff of [true, undefined]) {
      const words = text(receiptOf(deliveryOrder('paid', alsoOff)));
      expect(words).toContain('Food 2,000 Discount (Staff) −220 Sales tax 16% 316.80 Food total (with tax) Rs 2,096.80 Delivery charge 200 Customer pays Rs 2,296.80');
      expect(words).not.toContain('Sales tax on delivery');
    }
  });

  it('a takeaway still shows Subtotal / Tax / Total, every line as an item', () => {
    signIn('cashier');
    const words = text(receiptOf(paidBill([BIG_TWO(), FRIES()], { tax: 58_500 }, [], 'takeaway')));
    expect(words).toContain('1× Big Two 3,600 1× Fries 300 Subtotal 3,900 Tax 585 Total Rs 4,485');
    for (const bill of ['Food total', 'Customer pays', 'Sales tax', 'Delivery charge']) expect(words).not.toContain(bill);
  });

  it('a delivery with no charge line, or whose total is below its charge: Subtotal / Tax / Total, the charge line as an item', () => {
    signIn('cashier');
    const noCharge = text(receiptOf(paidBill([BIG_TWO(), FRIES()], { tax: 58_500 })));
    expect(noCharge).toContain('Subtotal 3,900 Tax 585 Total Rs 4,485');
    expect(noCharge).not.toContain('Customer pays');
    // Rs 3,900 of food and the Rs 200 charge, Rs 4,000 off: Rs 100 in all, below the charge (the old layout).
    const below = text(receiptOf(paidBill([BIG_TWO(), FRIES(), CHARGE(0)], { discount: 400_000, tax: 0 })));
    expect(below).toContain('1× Delivery Charge (Rs 200) 200');
    expect(below).toContain('Subtotal 4,100');
    expect(below).toContain('Total Rs 100');
    expect(below).not.toContain('Customer pays');
  });
});
