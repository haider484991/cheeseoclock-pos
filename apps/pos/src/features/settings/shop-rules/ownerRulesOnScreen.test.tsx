/**
 * The owner's Money & discounts and Staff & kitchen timing on screen,
 * rendered to static markup (react-dom/server, no browser; nothing calls the
 * till): the F3 Discount screen's buttons, locks and rule, and the Live
 * Orders header, built from what checkout:getRules answered — and today's
 * when nothing is saved (or it has not answered yet); the two new owner
 * cards on Settings, and only the owner's login sees their tabs. Radix's
 * dialog is stood in for by plain elements (a server render has no portal).
 * Every name and amount is made up.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
  SHOP_SETTING_DEFAULTS,
  type AuthenticatedUser,
  type CheckoutRules,
  type OrderSnapshot,
  type ShopSettingCard,
  type ShopSettingKey,
  type UUID,
} from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../../components/toast/ToastProvider';
import { useSessionStore } from '../../../stores/sessionStore';
import { useCheckoutStore } from '../../../stores/checkoutStore';
import { DiscountDialog } from '../../checkout/DiscountDialog';
import { OrdersBoardPage } from '../../orders/OrdersBoardPage';
import { MoneySettings } from '../MoneySettings';
import { TimingSettings } from '../TimingSettings';
import { SettingsPage } from '../SettingsPage';
import { CHECKOUT_RULES_KEY, SHOP_SETTINGS_KEY } from './useShopSetting';

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
/** Every aria-label on the page. */
const ariaLabels = (markup: string) => [...markup.matchAll(/aria-label="([^"]*)"/g)].map((m) => decode(m[1]!));

const RULES = (over: Partial<CheckoutRules> = {}): CheckoutRules => ({
  discounts: {
    approval: { percentOver: 10, flatOverCents: 20_000 },
    presets: { percents: [5, 15], flatCents: [15_000, 25_000], reasons: ['Birthday', 'Test reason'] },
    alsoOffDeliveryCharge: false,
  },
  kitchen: { amberMin: 5, redMin: 10, notStartedMin: 5, notDoneMin: 20 },
  foodpanda: { deal: null, checks: { orderCode: 'optional', tabletTotal: 'optional' }, tabletToleranceCents: 100, upliftBps: 0 },
  ...over,
});

/** A Rs 2,000 order on the till (made-up lines). */
function ringUp(): void {
  useCheckoutStore.setState({
    snapshot: {
      order: { id: 'o1', subtotalCents: 200_000, mode: 'takeaway' },
      items: [
        { id: 'l1', lineTotalCents: 100_000, taxRateBps: 1600 },
        { id: 'l2', lineTotalCents: 100_000, taxRateBps: 1600 },
      ],
      discounts: [],
    } as unknown as OrderSnapshot,
    busy: false,
  });
}

describe('the Discount screen (F3)', () => {
  it('shows the owner’s buttons and reasons, the lock above his limit, and his rule in words', () => {
    signIn('cashier');
    ringUp();
    const out = render(<DiscountDialog onClose={() => {}} />, [[CHECKOUT_RULES_KEY, RULES()]]);
    const words = text(out);
    expect(words).toContain(
      "Up to 10% off, or up to Rs 200 off if that is no more than 10% of the order, without a manager. More needs a manager's PIN or password.",
    );
    const labels = ariaLabels(out);
    expect(labels).toContain('5% off, takes Rs 100 off');
    expect(labels).toContain("15% off, takes Rs 300 off, needs a manager's PIN or password");
    expect(labels).toContain('Rs 150 off, takes Rs 150 off');
    expect(labels).toContain("Rs 250 off, takes Rs 250 off, needs a manager's PIN or password");
    expect(words).toContain('Birthday');
    expect(words).toContain('Test reason');
    // Today's buttons are gone; typing any other amount still works.
    expect(labels.some((l) => l.startsWith('20% off'))).toBe(false);
    expect(words).not.toContain('Regular customer');
    expect(labels).toContain('Other percent off');
  });

  it('on an order with a delivery charge: worked on the food, and it says so (the owner, 28 Sep 2026)', () => {
    signIn('cashier');
    useCheckoutStore.setState({
      snapshot: {
        order: { id: 'o2', subtotalCents: 220_000, mode: 'delivery' },
        items: [
          { id: 'l1', lineTotalCents: 200_000, taxRateBps: 1600, menuItemName: 'Test Pizza' },
          { id: 'l2', lineTotalCents: 20_000, taxRateBps: 1600, menuItemName: 'Delivery Charge (Rs 200)' },
        ],
        discounts: [],
      } as unknown as OrderSnapshot,
      busy: false,
    });
    const out = render(<DiscountDialog onClose={() => {}} />, [[CHECKOUT_RULES_KEY, RULES()]]);
    expect(text(out)).toContain('Food Rs 2,000 before tax · delivery charge Rs 200 not discounted');
    const labels = ariaLabels(out);
    // A % of the food, not of Rs 2,200.
    expect(labels).toContain('5% off, takes Rs 100 off');
    expect(labels).toContain("15% off, takes Rs 300 off, needs a manager's PIN or password");
    // The owner's switch on: the whole bill, as before.
    const whole = render(<DiscountDialog onClose={() => {}} />, [
      [CHECKOUT_RULES_KEY, RULES({ discounts: { ...RULES().discounts, alsoOffDeliveryCharge: true } })],
    ]);
    expect(text(whole)).toContain('Order Rs 2,200 before tax');
    expect(ariaLabels(whole)).toContain('5% off, takes Rs 110 off');
  });

  it('nothing saved (or no answer yet): today’s buttons, locks and rule', () => {
    signIn('cashier');
    ringUp();
    const out = render(<DiscountDialog onClose={() => {}} />);
    const labels = ariaLabels(out);
    expect(labels.filter((l) => / off, takes /.test(l))).toEqual([
      '10% off, takes Rs 200 off',
      "20% off, takes Rs 400 off, needs a manager's PIN or password",
      "25% off, takes Rs 500 off, needs a manager's PIN or password",
      "50% off, takes Rs 1,000 off, needs a manager's PIN or password",
      "100% off, takes Rs 2,000 off, needs a manager's PIN or password",
      'Rs 100 off, takes Rs 100 off',
      'Rs 200 off, takes Rs 200 off',
      "Rs 500 off, takes Rs 500 off, needs a manager's PIN or password",
    ]);
    const words = text(out);
    for (const r of ['Staff', 'Friends & family', 'Regular customer', 'Complaint']) expect(words).toContain(r);
    expect(words).toContain('Up to 10% off, or up to Rs 500 off if that is no more than 10% of the order, without a manager.');
  });
});

describe('the Live Orders header', () => {
  const order = (minutesOld: number) =>
    ({
      order: {
        id: `o${minutesOld}`,
        orderNumber: `20260928-00${minutesOld}`,
        mode: 'takeaway',
        status: 'sent_to_kitchen',
        source: 'pos',
        notes: null,
        createdAt: new Date(Date.now() - minutesOld * 60_000 - 1_000).toISOString(),
        paidAt: null,
        dispatchedAt: null,
        totalCents: 100_000,
      },
      items: [],
      discounts: [],
      payments: [],
      customerName: null,
      customerPhone: null,
      deliveryNotes: null,
      rider: null,
    }) as unknown as OrderSnapshot;
  const board = (orders: OrderSnapshot[]) => [['orders', 'active', 'all'], orders] as [readonly unknown[], unknown];

  it('counts the cards past the owner’s red minutes, and says his minutes', () => {
    signIn('cashier');
    const words = text(render(<OrdersBoardPage />, [board([order(12), order(3)]), [CHECKOUT_RULES_KEY, RULES()]]));
    expect(words).toContain('· 1 waiting over 10 min');
  });

  it('nothing saved: red at 30 minutes, as today', () => {
    signIn('cashier');
    expect(text(render(<OrdersBoardPage />, [board([order(12)])]))).not.toContain('waiting over');
    expect(text(render(<OrdersBoardPage />, [board([order(31), order(12)])]))).toContain('· 1 waiting over 30 min');
  });
});

/** An owner card as settings:getBusiness answers it. */
function card<K extends ShopSettingKey>(key: K, value: ShopSettingCard<K>['value']): ShopSettingCard<K> {
  return {
    key,
    value,
    defaultValue: SHOP_SETTING_DEFAULTS[key] as ShopSettingCard<K>['value'],
    isDefault: false,
    readOnly: false,
    lastChanged: { at: '2026-09-28T09:02:00.000Z', byName: 'Test Owner', onThisTill: true },
    notOnOtherTillYet: false,
    history: [],
  };
}

describe('the owner’s cards', () => {
  it('Money & discounts: the limit, the buttons, and examples built from the saved values', () => {
    signIn('admin');
    const words = text(
      render(<MoneySettings />, [
        [[...SHOP_SETTINGS_KEY, 'discounts.approval'], card('discounts.approval', { v: 1, percentOver: 20, flatOverCents: 100_000 })],
        [
          [...SHOP_SETTINGS_KEY, 'discounts.presets'],
          card('discounts.presets', { v: 1, percents: [5, 25], flatCents: [30_000], reasons: ['Birthday'] }),
        ],
      ]),
    );
    expect(words).toContain('When a cashier needs a manager');
    expect(words).toContain(
      'On a Rs 2,000 order a cashier can give up to 20% off, or up to Rs 400 off in rupees, without a manager. On a Rs 10,000 order: up to 20% off, or up to Rs 1,000 off in rupees.',
    );
    expect(words).toContain('Discount buttons');
    expect(words).toContain('Reasons: Birthday.');
    expect(words).toContain('Last changed by Test Owner on this till');
  });

  it('Money & discounts: "A discount also comes off the delivery charge", No by default, its words built from the value', () => {
    signIn('admin');
    const seed = (value: { v: number; alsoOffDeliveryCharge: boolean }, never: boolean): Array<[readonly unknown[], unknown]> => [
      [[...SHOP_SETTINGS_KEY, 'discounts.approval'], card('discounts.approval', { v: 1, percentOver: 10, flatOverCents: 50_000 })],
      [
        [...SHOP_SETTINGS_KEY, 'discounts.presets'],
        card('discounts.presets', { v: 1, percents: [10], flatCents: [10_000], reasons: ['Staff'] }),
      ],
      [
        [...SHOP_SETTINGS_KEY, 'discounts.delivery'],
        { ...card('discounts.delivery', value), ...(never ? { isDefault: true, lastChanged: null } : {}) },
      ],
    ];
    const no = render(<MoneySettings />, seed({ v: 1, alsoOffDeliveryCharge: false }, true));
    const words = text(no);
    expect(words).toContain('Discounts and the delivery charge');
    expect(words).toContain('A discount also comes off the delivery charge');
    expect(words).toContain(
      'On Rs 2,000 of food with a Rs 200 delivery charge, 10% off takes Rs 200 off (10% of the food). The Rs 200 delivery charge is paid in full: Rs 3,000 off takes Rs 2,000 (all the food), and even 100% off leaves the Rs 200 delivery charge (and its tax) to pay.',
    );
    expect(words).toContain('A discount already on an order keeps the rule it was given with, and paid orders never change.');
    // Never saved is not "as the till always worked" here.
    expect(words).toContain('Never changed: a discount is on the food only');
    expect(words).not.toContain('the till works as it always has');
    expect(no).toMatch(/aria-checked="true"[^>]*>\s*<span[^>]*>No</);

    const yes = text(render(<MoneySettings />, seed({ v: 1, alsoOffDeliveryCharge: true }, false)));
    expect(yes).toContain(
      'On Rs 2,000 of food with a Rs 200 delivery charge, 10% off takes Rs 220 off: the delivery charge is discounted too. Rs 3,000 off takes Rs 2,200, and 100% off leaves nothing to pay.',
    );
  });

  it('Staff & kitchen timing: both cards, with examples built from the saved values', () => {
    signIn('admin');
    const words = text(
      render(<TimingSettings />, [
        [
          [...SHOP_SETTINGS_KEY, 'staff.timing'],
          card('staff.timing', { v: 1, idleLogoutMin: 20, maxLoginHours: 16, stepInMin: 15, freeReprints: 2, reprintWindowMin: 45 }),
        ],
        [[...SHOP_SETTINGS_KEY, 'kitchen.timing'], card('kitchen.timing', { v: 1, amberMin: 20, redMin: 40, notStartedMin: 15, notDoneMin: 45 })],
      ]),
    );
    expect(words).toContain('Staff logins and reprints');
    expect(words).toContain('after 20 minutes with nobody touching it');
    expect(words).toContain('two copies of a paid receipt');
    expect(words).toContain('Kitchen timing');
    expect(words).toContain('turns amber on Live Orders at 7:20 and red at 7:40');
    expect(words).toContain('Cashiers are never signed out for being idle');
  });

  it('only the owner’s login sees the two new tabs, in the design’s order', () => {
    /** The Settings tabs' names, left to right. */
    const tabs = (markup: string) =>
      markup
        .split('role="tab"')
        .slice(1)
        .map((t) => text(`<x ${t.slice(0, t.indexOf('</button>'))}`));
    signIn('admin');
    expect(tabs(render(<SettingsPage />)).slice(0, 5)).toEqual([
      'foodpanda',
      'Money & discounts',
      'Shop & logo',
      'Staff & kitchen timing',
      'Printers',
    ]);
    for (const role of ['manager', 'cashier'] as const) {
      signIn(role);
      const other = tabs(render(<SettingsPage />));
      expect({ role, other }).toEqual({ role, other: ['Printers', 'Sounds', 'About'] });
    }
  });
});
