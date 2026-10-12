/**
 * A client's voucher on the till's screens (v0.7.48; the owner, 12 Oct 2026:
 * "we are giving these vouchers to abhi company … add it to pos system so we
 * can track it"): the cart offers "Use a voucher" on a counter order being
 * rung up, and once one is on, names it ("Voucher No. 001 · abhi") with an ×
 * to take it off — as Pay, the receipt after Pay and the order drawer do,
 * never "Discount (…)". Static renders (react-dom/server, no browser; nothing
 * calls the till); Radix's dialog is stood in for by plain elements. Every
 * name, code and amount is made up.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, Category, CheckoutRules, OrderSnapshot, UUID, VoucherBatchSummary, VoucherCheck, VoucherCheckLine } from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../components/toast/ToastProvider';
import { useSessionStore } from '../../stores/sessionStore';
import { useCheckoutStore } from '../../stores/checkoutStore';
import { CHECKOUT_RULES_KEY } from '../settings/shop-rules/useShopSetting';
import { CartPane } from './CartPane';
import { TenderDialog } from './TenderDialog';
import { ReceiptDialog } from './ReceiptDialog';
import { OrderDetailDrawer } from '../orders/OrderDetailDrawer';
import { VoucherDialog, voucherChoices, voucherLinesOfSnapshot } from './VoucherDialog';
import { VoucherBatchDialog } from '../vouchers/VoucherBatchDialog';
import { VoucherSettings } from '../settings/VoucherSettings';
import { SettingsPage } from '../settings/SettingsPage';

/** The props the last dialog rendered gave Radix's Content: the handlers Radix would call (on open, on a key). */
const radix = vi.hoisted(() => ({ content: null as Record<string, unknown> | null }));

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
    Content: (props: P & Record<string, unknown>) => {
      radix.content = props;
      return h('div', { className: props.className, role: 'dialog' }, props.children);
    },
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
const ariaLabels = (markup: string) => [...markup.matchAll(/aria-label="([^"]*)"/g)].map((m) => decode(m[1]!));

const RULES: CheckoutRules = {
  discounts: {
    approval: { percentOver: 10, flatOverCents: 50_000 },
    presets: { percents: [10, 20], flatCents: [10_000], reasons: ['Staff'] },
    alsoOffDeliveryCharge: false,
    reasonRequired: false,
  },
  kitchen: { amberMin: 5, redMin: 10, notStartedMin: 5, notDoneMin: 20 },
  foodpanda: { deal: null, checks: { orderCode: 'optional', tabletTotal: 'optional' }, tabletToleranceCents: 100, upliftBps: 0 },
} as unknown as CheckoutRules;
const RULES_SEED: Array<[readonly unknown[], unknown]> = [[CHECKOUT_RULES_KEY, RULES]];

const line = (id: string, name: string, cents: number, extra: Record<string, unknown> = {}) => ({
  id,
  orderId: 'o1',
  menuItemId: `m_${id}`,
  menuItemName: name,
  categoryName: 'Pizza',
  quantity: 1,
  unitPriceCents: cents,
  lineTotalCents: cents,
  taxRateBps: 1_600,
  notes: null,
  modifiers: [],
  kitchenStatus: 'pending',
  noDiscount: false,
  ...extra,
});

/** A takeaway of a Rs 1,899 Large pizza and a Rs 150 drink; `voucher`: voucher No. 001 of abhi on the pizza. */
function order(opts: { status?: 'open' | 'paid'; voucher?: boolean; mode?: string; source?: string } = {}): OrderSnapshot {
  const status = opts.status ?? 'open';
  const items = [line('l1', 'Test Fajita Pizza — Large', 189_900), line('l2', 'Test Cola', 15_000), line('l3', 'Test Big Deal', 360_000, { noDiscount: true })];
  const subtotalCents = items.reduce((s, i) => s + i.lineTotalCents, 0);
  const discountCents = opts.voucher ? 189_900 : 0;
  const taxCents = Math.round(((subtotalCents - discountCents) * 16) / 100);
  const totalCents = subtotalCents - discountCents + taxCents;
  return {
    order: {
      id: 'o1',
      orderNumber: '20261014-0042',
      mode: opts.mode ?? 'takeaway',
      status,
      source: opts.source ?? 'pos',
      notes: null,
      cashierId: 'u1',
      tableId: null,
      subtotalCents,
      discountCents,
      taxCents,
      totalCents,
      createdAt: '2026-10-14T10:00:00.000Z',
      paidAt: status === 'paid' ? '2026-10-14T10:05:00.000Z' : null,
      dispatchedAt: null,
    },
    items,
    discounts: opts.voucher
      ? [
          {
            id: 'd1',
            orderId: 'o1',
            discountType: 'flat',
            value: 189_900,
            reason: 'Voucher No. 001 · abhi',
            appliedByUserId: 'u1',
            approvedByUserId: 'u0',
            amountCents: 189_900,
            source: 'voucher',
            foodpanda: null,
            alsoOffDeliveryCharge: false,
            skipsNoDiscountLines: true,
            voucher: {
              id: 'v1',
              batchId: 'b1',
              number: 1,
              batchName: 'abhi',
              gives: 'One Large pizza from the Regular menu',
              coversCents: 189_900,
              lineId: 'l1',
            },
          },
        ]
      : [],
    payments:
      status === 'paid'
        ? [{ id: 'p1', orderId: 'o1', method: 'cash', amountCents: totalCents, tenderedCents: totalCents, referenceNo: null, receivedByUserId: 'u1', paidAt: '2026-10-14T10:05:00.000Z' }]
        : [],
    cashierName: 'Test Cashier',
    tableLabel: null,
    customerName: null,
    customerPhone: null,
    deliveryAddress: null,
    deliveryNotes: null,
    rider: null,
  } as unknown as OrderSnapshot;
}

const noop = () => {};
const cart = ({ withVoucher = true }: { withVoucher?: boolean } = {}) =>
  render(
    <CartPane
      step="items"
      onContinue={noop}
      onBack={noop}
      onPay={noop}
      onDiscount={noop}
      {...(withVoucher ? { onVoucher: noop } : {})}
      onRemoveDeal={noop}
      onSendToKitchen={noop}
      onCustomize={noop}
    />,
    RULES_SEED,
  );

describe('a voucher on the till', () => {
  it('the cart offers "Use a voucher" on a counter order being rung up; not on a foodpanda or website order', () => {
    signIn('cashier');
    useCheckoutStore.setState({ snapshot: order(), busy: false });
    expect(text(cart())).toContain('Use a voucher');
    useCheckoutStore.setState({ snapshot: order({ mode: 'foodpanda' }), busy: false });
    expect(text(cart())).not.toContain('Use a voucher');
    useCheckoutStore.setState({ snapshot: order({ source: 'web' }), busy: false });
    expect(text(cart())).not.toContain('Use a voucher');
    // A screen that does not offer it (no handler): no link.
    useCheckoutStore.setState({ snapshot: order(), busy: false });
    expect(text(cart({ withVoucher: false }))).not.toContain('Use a voucher');
  });

  it('once on, the cart names it with an × to take it off, and offers no second one', () => {
    signIn('cashier');
    useCheckoutStore.setState({ snapshot: order({ voucher: true }), busy: false });
    const markup = cart();
    expect(text(markup)).toContain('Voucher No. 001 · abhi −1,899 Tax 600 Total Rs 4,350');
    expect(text(markup)).not.toContain('Use a voucher');
    expect(text(markup)).not.toContain('Discount ·');
    expect(ariaLabels(markup)).toContain('Take the voucher off');
  });

  it('Pay, the receipt after Pay and the order drawer name it as the bill prints it', () => {
    signIn('admin');
    const open = order({ voucher: true });
    useCheckoutStore.setState({ snapshot: open, busy: false });
    expect(text(render(<TenderDialog snapshot={open} onClose={noop} onPaid={noop} />, RULES_SEED))).toContain('Voucher No. 001 · abhi');
    const paid = order({ voucher: true, status: 'paid' });
    expect(text(render(<ReceiptDialog snapshot={paid} onClose={noop} />, RULES_SEED))).toContain('Voucher No. 001 · abhi');
    const drawer = text(render(<OrderDetailDrawer orderId="o1" onClose={noop} />, [...RULES_SEED, [['orders', 'detail', 'o1'], paid]]));
    expect(drawer).toContain('Subtotal');
    expect(drawer).toContain('Voucher No. 001 · abhi');
    expect(drawer).not.toContain('Discount (Voucher');
  });

  it('the voucher box: the number and the code, and only the food it can come off', () => {
    signIn('cashier');
    useCheckoutStore.setState({ snapshot: order(), busy: false });
    const words = text(render(<VoucherDialog onClose={noop} />, RULES_SEED));
    expect(words).toContain('Use a voucher Type the number and the code printed on the voucher (a photo of it is fine).');
    expect(words).toContain('Voucher No.');
    expect(words).toContain('Code');
    expect(words).toContain('One voucher per order.');
    // The pizza and the drink, never the value deal.
    expect(voucherLinesOfSnapshot(order()).map((l) => l.id)).toEqual(['l1', 'l2']);
  });
});

describe('Add vouchers (the owner)', () => {
  it('takes the vouchers from a CSV file, or a pasted list', () => {
    signIn('admin');
    const markup = render(<VoucherBatchDialog onClose={noop} onSaved={noop} />, RULES_SEED);
    const words = text(markup);
    expect(words).toContain('From a CSV file');
    expect(words).toContain('Choose a CSV file');
    expect(words).toContain('Number and code on each line (001,AB3C). Or paste the list below.');
    expect(markup).toMatch(/<input[^>]*type="file"[^>]*accept="\.csv,\.txt,text\/csv,text\/plain"/);
  });
});

/** The menu's categories as Settings reads them (every name made up but the regular pizza one's). */
const CATEGORIES = [
  { id: 'c1', name: 'Pizza', displayOrder: 1, isActive: true },
  { id: 'c2', name: 'Test Signature Pizzas', displayOrder: 2, isActive: true },
  { id: 'c3', name: 'Test Drinks', displayOrder: 3, isActive: true },
  { id: 'c4', name: 'Test Old Menu', displayOrder: 4, isActive: false },
] as unknown as Category[];
const CATS_SEED: Array<[readonly unknown[], unknown]> = [...RULES_SEED, [['menu', 'categories', 'all'], CATEGORIES]];

/** The radios of a group that are chosen, and the toggles pressed: their labels. */
const chosenIn = (markup: string, group: string) => {
  const at = markup.indexOf(`aria-label="${group}"`);
  expect(at).toBeGreaterThan(-1);
  return markup
    .slice(at, markup.indexOf('</div>', at))
    .split('<button')
    .slice(1)
    .filter((b) => b.includes('aria-checked="true"') || b.includes('aria-pressed="true"'))
    .map((b) => text(`<x ${b}`));
};

const ABHI: VoucherBatchSummary = {
  id: 'b1',
  name: 'abhi',
  gives: 'One Large pizza from the Regular menu',
  coversCents: 100,
  goodUntil: null,
  for: { categoryIds: ['c1'], size: 'Large', wholeItem: true },
  forCategoryNames: ['Pizza'],
  createdAt: '2026-10-12T09:00:00.000Z',
  createdByName: 'Test Owner',
  count: 100,
  used: 3,
  onOrder: 0,
  notUsed: 97,
  firstNumber: 1,
  lastNumber: 100,
};

describe('what a voucher is for (v0.7.50, Settings → Vouchers)', () => {
  it('new vouchers start as one Large regular pizza, the whole item: no amount to type', () => {
    signIn('admin');
    const markup = render(<VoucherBatchDialog onClose={noop} onSaved={noop} />, CATS_SEED);
    const words = text(markup);
    expect(words).toContain('What it is for The till lets a voucher come off only such an item.');
    expect(chosenIn(markup, 'Size')).toEqual(['Large']);
    expect(chosenIn(markup, 'Menu categories')).toEqual(['Pizza']);
    expect(chosenIn(markup, 'Takes off')).toEqual(['The whole item']);
    expect(words).toContain('For: Large · Pizza · the whole item');
    expect(words).toContain('One of the item at its menu price. Extras are paid.');
    expect(words).not.toContain('Covers up to (Rs)');
    // A category taken off the menu is not offered.
    expect(words).not.toContain('Test Old Menu');
  });

  it('a batch added before says any food, up to its amount, until the owner changes it', () => {
    signIn('admin');
    const before = { ...ABHI, coversCents: 189_900, for: null, forCategoryNames: [] };
    const markup = render(<VoucherBatchDialog batch={before} onClose={noop} onSaved={noop} />, CATS_SEED);
    expect(chosenIn(markup, 'Size')).toEqual(['Any size']);
    expect(chosenIn(markup, 'Menu categories')).toEqual([]);
    expect(chosenIn(markup, 'Takes off')).toEqual(['Up to an amount']);
    expect(text(markup)).toContain('For: Any food · up to Rs 1,899');
    expect(markup).toMatch(/value="1899"/);
  });

  it('Settings → Vouchers lists each company’s vouchers and what they are for, to add, change or delete', () => {
    signIn('admin');
    const fresh = { ...ABHI, id: 'b2', name: 'Test Company', used: 0, notUsed: 100, for: null, forCategoryNames: [], coversCents: 70_000 };
    const markup = render(<VoucherSettings />, [[['vouchers', 'batches'], [ABHI, fresh]]]);
    const words = text(markup);
    expect(words).toContain('Company vouchers');
    expect(words).toContain('Add company vouchers');
    expect(words).toContain('abhi No. 001–100 One Large pizza from the Regular menu For: Large · Pizza · the whole item · no end date 3 of 100 used · 97 not used');
    expect(words).toContain('Test Company No. 001–100 One Large pizza from the Regular menu For: Any food · up to Rs 700 · no end date');
    // Delete only while none is used: one button, the unused company's.
    expect(words.match(/Delete/g)).toHaveLength(1);
    expect(words.match(/Change/g)).toHaveLength(2);
    expect(markup).toContain('href="/vouchers"');
    // The tab is the owner's, beside Money & discounts.
    expect(text(render(<SettingsPage />, RULES_SEED))).toContain('Money & discounts Vouchers Delivery areas & fees');
  });

  it('the voucher box offers only the items the till says it is for, the dearest first', () => {
    const lines = voucherLinesOfSnapshot(order());
    const ok = (extra: { lines?: VoucherCheckLine[] } = {}): VoucherCheck => ({ ok: true, voucherId: 'v1', number: 1, code: 'AB3C', batch: ABHI, ...extra });
    // For a Large pizza: the pizza only, never the drink.
    expect(voucherChoices(ok({ lines: [{ lineId: 'l1', amountCents: 189_900 }] }), lines).map((c) => [c.line.id, c.amountCents])).toEqual([['l1', 189_900]]);
    // Nothing on the order it is for: nothing to pick.
    expect(voucherChoices(ok({ lines: [] }), lines)).toEqual([]);
    // Asked without an order: every food line, by what it takes off.
    expect(voucherChoices(ok(), lines).map((c) => c.line.id)).toEqual(['l1', 'l2']);
    expect(voucherChoices({ ok: false, problem: 'used', message: 'Used' }, lines)).toEqual([]);
    expect(voucherChoices(null, lines)).toEqual([]);
  });
});
