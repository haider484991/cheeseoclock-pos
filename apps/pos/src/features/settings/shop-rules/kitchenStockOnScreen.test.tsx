/**
 * Settings phase 7 on screen, rendered to static markup (react-dom/server,
 * no browser; nothing calls the till): the Kitchen & stock tab's two cards
 * with their help and worked examples built from the saved values (and
 * today's when nothing is saved), the tab only on the owner's login, the
 * kitchen ticket's rules on Settings → Printers, and the default food-cost
 * target's box on Costing → Targets. Every name and amount is made up.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MENU_IMPORT_POLICY,
  DEFAULT_STOCK_RULES,
  SHOP_SETTING_DEFAULTS,
  type AuthenticatedUser,
  type CostingTargetsView,
  type PrintPolicy,
  type ShopSettingCard,
  type ShopSettingKey,
  type StockRules,
  type UUID,
} from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../../components/toast/ToastProvider';
import { useSessionStore } from '../../../stores/sessionStore';
import { KitchenStockSettings } from '../KitchenStockSettings';
import { PrintingRulesSettings } from '../PrintingRulesSettings';
import { SettingsPage } from '../SettingsPage';
import { TargetsTab } from '../../costing/TargetsTab';
import { SHOP_SETTINGS_KEY } from './useShopSetting';

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
const values = (markup: string) => [...markup.matchAll(/value="([^"]*)"/g)].map((m) => decode(m[1]!));

/** An owner card as settings:getBusiness answers it. */
function card<K extends ShopSettingKey>(key: K, value: ShopSettingCard<K>['value'], saved = true): ShopSettingCard<K> {
  return {
    key,
    value,
    defaultValue: SHOP_SETTING_DEFAULTS[key] as ShopSettingCard<K>['value'],
    isDefault: !saved,
    readOnly: false,
    lastChanged: saved ? { at: '2026-09-28T09:02:00.000Z', byName: 'Test Owner', onThisTill: true } : null,
    notOnOtherTillYet: false,
    history: [],
  };
}
const seedCards = (stock: StockRules, saved: boolean): Array<[readonly unknown[], unknown]> => [
  [[...SHOP_SETTINGS_KEY, 'stock.rules'], card('stock.rules', stock, saved)],
  [[...SHOP_SETTINGS_KEY, 'menu.importPolicy'], card('menu.importPolicy', saved ? { ...DEFAULT_MENU_IMPORT_POLICY, itemPrices: 'till' } : DEFAULT_MENU_IMPORT_POLICY, saved)],
];

describe('Settings → Kitchen & stock', () => {
  it('nothing saved: today’s numbers in the boxes, the seven reasons, and the examples built from them', () => {
    signIn('admin');
    const out = render(<KitchenStockSettings />, seedCards(DEFAULT_STOCK_RULES as StockRules, false));
    const words = text(out);
    expect(words).toContain('Stock takes and waste');
    expect(words).toContain('Never changed: the till works as it always has.');
    expect(values(out).slice(0, 5)).toEqual(['3', '6', '2', '3', '5']);
    expect(values(out)).toEqual(expect.arrayContaining(['Burnt', 'Dropped', 'Expired / went off', 'Wrong order made', 'Sent back', 'Staff meal', 'Other']));
    expect(words).toContain('Rs 3,000 (3%) is OK; Rs 5,000 (5%) is Needs work');
    expect(words).toContain('Off: the Dashboard never asks for a stock take.');
    expect(words).toContain('its stock bar is full at 6 kg');
    expect(words).toContain('What a menu file may change');
    expect(words).toContain('the import changes it to Rs 1,300');
    expect(words).toContain('ingredient prices stay the till’s');
  });

  it('the owner’s values: his numbers, his reasons (a renamed one says what it was; a hidden one says so), and the examples follow', () => {
    signIn('admin');
    const stock: StockRules = {
      ...structuredClone(DEFAULT_STOCK_RULES as StockRules),
      varianceDoThisBps: 250,
      reorderMultiple: 4,
      reminders: { keyItemsEveryDays: 7, fullEveryDays: null },
      wasteReasons: [
        ...DEFAULT_STOCK_RULES.wasteReasons.map((r) => (r.id === 'returned' ? { ...r, label: 'Customer returned' } : r.id === 'staff_meal' ? { ...r, hidden: true } : r)),
        { id: 'test_spill', label: 'Test spill', hidden: false },
      ],
    };
    const out = render(<KitchenStockSettings />, seedCards(stock, true));
    const words = text(out);
    // His added reason is saved, so either till may have waste entries with it: Hide, no Remove.
    expect(words).not.toContain('Remove');
    expect(words).toContain('A reason you add can be removed until you save it');
    // Each reminder's words tick its own box; the days box has its own name.
    expect(out).toMatch(/<label for="stock-keyItemsOn"[^>]*><input id="stock-keyItemsOn" type="checkbox"[^>]*\/><span>Remind me to count the key items every<\/span><\/label>/);
    expect(out).toMatch(/<label for="stock-fullOn"[^>]*><input id="stock-fullOn" type="checkbox"[^>]*\/><span>Remind me to do a full stock take every<\/span><\/label>/);
    expect(out).toMatch(/<input id="stock-keyItemsDays" aria-label="Days between key-items counts"/);
    expect(out).toMatch(/<input id="stock-fullDays" aria-label="Days between full stock takes"[^>]*disabled=""/);
    expect(words).toContain('Last changed by Test Owner on this till');
    expect(words).toContain('lists it when more than 2.5% went (Rs 2,500 here)');
    expect(words).toContain('“Count the key items” when the last key-items or full stock take was 7 days ago or more');
    expect(words).toContain('its stock bar is full at 8 kg');
    expect(words).toContain('was “Sent back”');
    expect(words).toContain('hidden: off the Waste screen, still named in Reports');
    expect(words).toContain('the till keeps Rs 1,200');
  });

  it('only the owner’s login has the tab, in the design’s place: after Staff & kitchen timing, before Printers', () => {
    const tabs = (markup: string) =>
      markup
        .split('role="tab"')
        .slice(1)
        .map((t) => text(`<x ${t.slice(0, t.indexOf('</button>'))}`));
    signIn('admin');
    const all = tabs(render(<SettingsPage />));
    expect(all.slice(0, 7)).toEqual([
      'foodpanda',
      'Money & discounts',
      'Delivery areas & fees',
      'Shop & logo',
      'Staff & kitchen timing',
      'Kitchen & stock',
      'Printers',
    ]);
    for (const role of ['manager', 'cashier'] as const) {
      signIn(role);
      expect({ role, tabs: tabs(render(<SettingsPage />)) }).toEqual({ role, tabs: ['Printers', 'Sounds', 'About'] });
    }
  });
});

describe('Settings → Printers: the kitchen ticket’s rules (this till)', () => {
  const config = (policy: PrintPolicy) => [
    ['printer', 'config'],
    {
      config: { transport: 'network', network: { host: 'mock', port: 9100 }, width: 48 },
      branding: { storeName: 'Test Shop' },
      transports: ['network'],
      mockEnabled: true,
      policy,
      kitchenPrinter: null,
      logo: { state: 'none', enabled: true, stored: null, checked: false },
    },
  ] as [readonly unknown[], unknown];
  const BASE: PrintPolicy = { kitchenTicket: true, deliveryBillOnDispatch: true, shopCopy: 'delivery', logoOnReceipt: true };

  it('a policy saved before the rules existed: one ticket, the phone and the drinks, in words', () => {
    signIn('admin');
    const words = text(render(<PrintingRulesSettings />, [config(BASE)]));
    expect(words).toContain('Printed once, the moment an order goes to the kitchen');
    expect(words).toContain("The customer's name and phone are on it.");
    expect(words).toContain('Kitchen tickets per order');
    expect(words).toContain("Customer's phone on kitchen tickets");
    expect(words).toContain('Drinks on kitchen tickets');
    expect(words).toContain('Drinks are listed with the food.');
  });

  it('two tickets, no phone, no drinks: the words follow', () => {
    signIn('admin');
    const words = text(render(<PrintingRulesSettings />, [config({ ...BASE, kitchenCopies: 2, kitchenPhone: false, kitchenDrinks: false })]));
    expect(words).toContain('2 tickets an order, printed together and marked COPY 1 OF 2 and COPY 2 OF 2');
    expect(words).toContain("Only the customer's name prints");
    expect(words).not.toContain('Your changes are not saved yet');
    expect(words).toContain('An order of only drinks prints no kitchen ticket.');
  });
});

describe('Costing → Targets: the default food-cost target has its box', () => {
  const TARGETS: CostingTargetsView = {
    defaultBps: 2_750,
    amberBps: 500,
    priceStepCents: 1_000,
    categories: [{ categoryId: 'pizza', name: 'Pizza', bps: 3_000, suggestedBps: 3_000, confirmed: true, nonFood: false, itemCount: 4 }],
    anyUnconfirmed: false,
    savedAt: '2026-09-28T09:00:00.000Z',
  };
  const box = (markup: string) => /<input[^>]*aria-label="Default food-cost target for a new menu category, per cent"[^>]*>/.exec(markup)?.[0] ?? '';

  it('the owner types it; the words are built from it', () => {
    signIn('admin');
    const out = render(<TargetsTab />, [[['costing', 'targets'], TARGETS]]);
    expect(box(out)).toContain('value="27.5"');
    expect(box(out)).not.toMatch(/\sdisabled=""/);
    expect(text(out)).toContain('A new menu category starts at');
    expect(text(out)).toContain('starts at 27.5% — shown as “suggested”');
  });

  it('a manager sees it, locked (the main process refuses him anyway)', () => {
    signIn('manager');
    expect(box(render(<TargetsTab />, [[['costing', 'targets'], TARGETS]]))).toMatch(/\sdisabled=""/);
  });
});
