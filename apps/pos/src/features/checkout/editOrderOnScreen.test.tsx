/**
 * Edit order and Free order on screen (v0.7.36): the ticket while an order
 * the kitchen has is changed (NEW lines, "was 2", what comes off, Save asks
 * for a manager when it must), the Save box (what changes, "Was the food
 * made?" for each item taken off, the reason, the manager's PIN), and the
 * Discount dialog's Free order (never on foodpanda; while changing an order
 * the kitchen has, the PIN is Save's). Static renders (react-dom/server, no
 * browser; nothing calls the till); Radix's dialog is stood in for by plain
 * elements. Every name and amount is made up.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, CheckoutRules, OrderEditDiff, OrderEditNeeds, OrderSnapshot, UUID } from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../components/toast/ToastProvider';
import { useSessionStore } from '../../stores/sessionStore';
import { useCheckoutStore, type EditSession } from '../../stores/checkoutStore';
import { CHECKOUT_RULES_KEY } from '../settings/shop-rules/useShopSetting';
import { makeEmptyCustomerForm } from './CustomerInlinePanel';
import { DiscountDialog } from './DiscountDialog';
import { EditOrderTicket } from './EditOrderTicket';
import { EditSaveDialog } from './EditSaveDialog';

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

const RULES = {
  discounts: {
    approval: { percentOver: 10, flatOverCents: 50_000 },
    presets: { percents: [10, 20], flatCents: [10_000], reasons: ['Staff'] },
    alsoOffDeliveryCharge: false,
    reasonRequired: false,
  },
  kitchen: { amberMin: 5, redMin: 10, notStartedMin: 5, notDoneMin: 20 },
  foodpanda: { deal: null, checks: { orderCode: 'optional', tabletTotal: 'optional' }, tabletToleranceCents: 100, upliftBps: 0 },
} as unknown as CheckoutRules;

function render(node: ReactNode): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(CHECKOUT_RULES_KEY, RULES);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ToastProvider>{node}</ToastProvider>
    </QueryClientProvider>,
  );
}
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const text = (markup: string) => decode(markup.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
/** The opening tag of the button whose words are exactly these. */
const buttonTag = (markup: string, words: string) =>
  [...markup.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].find((m) => text(m[2] ?? '') === words)?.[1] ?? null;
const noop = () => {};

const line = (id: string, name: string, quantity: number, category = 'Pizza') => ({
  id,
  orderId: 'o9',
  menuItemId: `m_${id}`,
  menuItemName: name,
  quantity,
  unitPriceCents: 50_000,
  lineTotalCents: 50_000 * quantity,
  taxRateBps: 1_600,
  notes: null,
  modifiers: [],
  kitchenStatus: 'pending',
  categoryName: category,
  createdAt: '2026-10-03T10:00:00.000Z',
});

function order(items: ReadonlyArray<{ lineTotalCents: number }>, extra: Partial<OrderSnapshot['order']> = {}, discounts: unknown[] = []): OrderSnapshot {
  const subtotal = items.reduce((n, l) => n + l.lineTotalCents, 0);
  return {
    order: {
      id: 'o9',
      orderNumber: '20261003-0042',
      mode: 'delivery',
      status: 'preparing',
      source: 'pos',
      tableId: null,
      subtotalCents: subtotal,
      discountCents: 0,
      taxCents: 0,
      totalCents: subtotal,
      createdAt: '2026-10-03T10:00:00.000Z',
      paidAt: null,
      ...extra,
    },
    items,
    discounts,
    payments: [],
    customerName: 'Test Customer',
    customerPhone: '0300 0000001',
    deliveryAddress: 'House 1, Test Street',
    rider: null,
  } as unknown as OrderSnapshot;
}

const BASE = order([line('k1', 'Test Pizza', 2), line('k2', 'Test Cola', 1, 'Drinks'), line('k3', 'Test Wings', 1, 'Wings')]);
/** One pizza less, the wings off, fries added. */
const CHANGED = order([line('k1', 'Test Pizza', 1), line('k2', 'Test Cola', 1, 'Drinks'), line('n1', 'Test Fries', 1, 'Sides')]);
const change = (l: { id: string; name: string }, quantity = 1) => ({ lineId: l.id, menuItemName: l.name, quantity, modifiers: [], notes: null, fee: false });
const DIFF: OrderEditDiff = {
  added: [change({ id: 'n1', name: 'Test Fries' })],
  removed: [change({ id: 'k1', name: 'Test Pizza' }), change({ id: 'k3', name: 'Test Wings' })],
  discountChanged: false,
  freeOrder: false,
  totalBeforeCents: 200_000,
  totalAfterCents: 150_000,
} as unknown as OrderEditDiff;
const NEEDS: OrderEditNeeds = { pin: true, why: ['Items the kitchen has come off'], reason: true };

function editing(
  snapshot: OrderSnapshot,
  diff: OrderEditDiff = DIFF,
  needs: OrderEditNeeds = NEEDS,
  ops: EditSession['ops'] = [{ op: 'add', lineId: 'n1', menuItemId: 'm_n1', quantity: 1, modifierIds: [], notes: null }],
) {
  const session: EditSession = {
    orderId: 'o9',
    base: BASE,
    baseKey: 'key-1',
    ops,
    diff,
    needs,
    returnTo: '/orders',
    parked: { snapshot: null, mode: 'takeaway', tableId: null, cameBy: null, form: makeEmptyCustomerForm(), committed: null },
  };
  useCheckoutStore.setState({ snapshot, edit: session, busy: false, lastTouch: null });
}

function signIn(role: AuthenticatedUser['role']) {
  useSessionStore.setState({ user: { id: 'u1' as UUID, fullName: 'Test', role, sessionId: 's1' as UUID }, status: 'authenticated' });
}

afterEach(() => {
  useCheckoutStore.setState({ snapshot: null, edit: null });
});

describe('the ticket while an order the kitchen has is changed', () => {
  it('NEW on a line added, "was 2" on one that went down, the wings under Taking off, and what Save will ask', () => {
    editing(CHANGED);
    const out = render(<EditOrderTicket onSave={noop} onCancel={noop} onDiscount={noop} onCustomize={noop} />);
    const words = text(out);
    expect(words).toContain('#0042 Changing an order the kitchen has');
    expect(words).toContain('Delivery · Test Customer · 0300 0000001');
    expect(words).toMatch(/Test Fries NEW/);
    expect(words).toMatch(/Test Pizza was 2/);
    expect(words).not.toMatch(/Test Cola (NEW|was)/);
    expect(words).toContain('Taking off · the kitchen gets DO NOT MAKE 1 × Test Wings Undo');
    expect(words).toContain('Items the kitchen has come off — Save asks for a manager’s PIN or password.');
    expect(words).toContain('before this change');
    // Customize only on the line added here.
    expect(words.match(/\+ Extras · dips · allergy/g)).toHaveLength(1);
    expect(buttonTag(out, 'Save changes')).not.toContain('disabled');
    // No Send, no Pay: an order the kitchen has goes on from Live Orders.
    expect(words).not.toContain('Send to kitchen');
    expect(words).not.toContain('Pay now');
  });

  it('nothing changed yet: Save is off and says why', () => {
    const none = { ...DIFF, added: [], removed: [], totalAfterCents: 200_000 } as OrderEditDiff;
    editing(BASE, none, { pin: false, why: [], reason: false });
    const out = render(<EditOrderTicket onSave={noop} onCancel={noop} onDiscount={noop} onCustomize={noop} />);
    expect(buttonTag(out, 'Save changes')).toContain('disabled');
    expect(text(out)).toContain('Nothing is saved until Save.');
  });

  it('a website order says its page keeps the first items', () => {
    editing(order(CHANGED.items, { source: 'web' }));
    expect(text(render(<EditOrderTicket onSave={noop} onCancel={noop} onDiscount={noop} onCustomize={noop} />))).toContain(
      'website page keeps showing the first items',
    );
  });
});

describe('the Save box', () => {
  it('what changes, "Was the food made?" for each item taken off, the reason, then a manager', () => {
    editing(CHANGED);
    const words = text(render(<EditSaveDialog onClose={noop} onSaved={noop} />));
    expect(words).toContain('Save the change to #0042?');
    expect(words).toContain('Adding · make now + 1 × Test Fries');
    expect(words).toContain('Taking off · do not make − 1 × Test Pizza − 1 × Test Wings');
    expect(words).toContain('Was the food made?');
    expect(words.match(/Not made · back on the shelf/g)).toHaveLength(2);
    expect(words.match(/Made · it is waste/g)).toHaveLength(2);
    expect(words).toContain('Customer changed order');
    expect(words).toContain('Manager PIN or password — items the kitchen has come off');
  });

  it('only adding: no food question, no reason, no PIN', () => {
    editing(CHANGED, { ...DIFF, removed: [] } as OrderEditDiff, { pin: false, why: [], reason: false });
    const words = text(render(<EditSaveDialog onClose={noop} onSaved={noop} />));
    expect(words).not.toContain('Was the food made?');
    expect(words).not.toContain('Reason');
    expect(words).not.toContain('Manager PIN');
  });

  it('a Free order: nothing to pay, the drawer pays the rider at Send out, its own reasons, and its reason already in (not asked twice)', () => {
    editing(
      CHANGED,
      { ...DIFF, added: [], removed: [], discountChanged: true, freeOrder: true, totalAfterCents: 0 } as OrderEditDiff,
      { pin: true, why: ['A Free order'], reason: true },
      [{ op: 'discount', discountType: 'percent', value: 100, reason: 'Complaint', free: true }],
    );
    const out = render(<EditSaveDialog onClose={noop} onSaved={noop} />);
    const words = text(out);
    expect(words).toContain('Free order: nothing to pay. At Send out the drawer pays an outside rider his delivery charge.');
    expect(words).toContain('Staff meal');
    expect(words).not.toContain('Customer changed order');
    expect(out).toMatch(/<input id="edit-reason"[^>]*value="Complaint"/);
  });
});

describe('the Discount dialog’s Free order', () => {
  it('at the counter: offered (a manager’s), and never on foodpanda', () => {
    signIn('cashier');
    useCheckoutStore.setState({ snapshot: order(BASE.items, { status: 'open' }), edit: null, busy: false });
    const words = text(render(<DiscountDialog onClose={noop} />));
    expect(words).toContain('Free order · everything free, value deals and delivery too manager');
    useCheckoutStore.setState({ snapshot: order(BASE.items, { status: 'open', mode: 'foodpanda' }) });
    expect(text(render(<DiscountDialog onClose={noop} />))).not.toContain('everything free');
  });

  it('a Free order on the order opens on itself; while changing an order the kitchen has, the PIN is Save’s', () => {
    signIn('cashier');
    const free = order(BASE.items, {}, [
      { discountType: 'percent', value: 100, reason: 'Staff meal', amountCents: 200_000, freeOrder: true, alsoOffDeliveryCharge: true, skipsNoDiscountLines: false },
    ]);
    editing(free, { ...DIFF, added: [], removed: [], discountChanged: true, freeOrder: true } as OrderEditDiff, { pin: true, why: ['A Free order'], reason: true });
    const out = render(<DiscountDialog onClose={noop} />);
    const words = text(out);
    expect(words).toContain('now Free order (Staff meal)');
    // The whole bill, not what a discount is worked on, and no 10% limit line.
    // Rs 2,000 of lines at 16%.
    expect(words).toContain('The whole order: Rs 2,320 with tax');
    expect(words).not.toContain('not discounted');
    expect(words).not.toContain('without a manager');
    expect(words).toContain('Everything on this order is free: the food, the value deals and the delivery charge.');
    expect(words).toContain('A manager’s PIN or password is asked when you save the change.');
    expect(words).not.toContain('Manager PIN or password');
    expect(words).toContain('Take the Free order off');
    expect(words).toContain('Make it free');
  });
});
