/**
 * Menu without the delivery charges (the owner, 10 Oct 2026: "i want to
 * remove menu delivery charges only"): the Items tab leaves the "Delivery
 * Charge (Rs N)" items out and says where they are (Settings → Delivery
 * areas & fees); the Categories tab leaves out the category that holds
 * nothing else; a new item's category and tax never start on theirs. Static
 * renders (react-dom/server, no browser; nothing calls the till); Radix's
 * dialog is stood in for by plain elements. Every name is made up.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, Category, MenuItem, TaxCategory, UUID } from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../components/toast/ToastProvider';
import { useSessionStore } from '../../stores/sessionStore';
import { CategoriesTab } from './CategoriesTab';
import { ItemsTab } from './ItemsTab';
import { CHARGES_NOT_LISTED_NOTE, CHARGE_CATEGORY_NOT_LISTED_NOTE } from './menuLists';
import { foodTaxChoices } from './useMenuCharges';

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

const category = (id: string, name: string, displayOrder: number): Category => ({
  id: id as UUID,
  name,
  displayOrder,
  colorHex: '#dc2626',
  isActive: true,
  isOnWebsite: true,
  noDiscount: null,
});
const item = (id: string, name: string, categoryId: string, cents: number): MenuItem =>
  ({
    id,
    categoryId,
    name,
    description: null,
    basePriceCents: cents,
    sku: null,
    barcode: null,
    imageUrl: null,
    isActive: true,
    prepStation: 'kitchen',
    taxCategoryId: 'tax-gst',
    sortOrder: 0,
    currentStock: null,
    lowStockThreshold: null,
    webAvailability: 'on',
  }) as unknown as MenuItem;

// "Delivery Charges" sorts first, as the till's menu file put it.
const CATEGORIES = [category('c-fees', 'Delivery Charges', 0), category('c-pizza', 'Test Pizzas', 1)];
const ITEMS = [
  item('m-pizza', 'Test Pizza', 'c-pizza', 150_000),
  item('d200', 'Delivery Charge (Rs 200)', 'c-fees', 20_000),
  item('d250', 'Delivery Charge (Rs 250)', 'c-fees', 25_000),
];

function render(node: ReactNode): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['menu', 'categories', 'all'], CATEGORIES);
  qc.setQueryData(['menu', 'items', 'all'], ITEMS);
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

describe('Menu leaves the delivery charges out', () => {
  it('Items: the pizza is listed, the two charges are not, nor their category’s chip — and it says where they are', () => {
    signIn('admin');
    const t = text(render(<ItemsTab />));
    expect(t).toContain('Test Pizza');
    expect(t).not.toContain('Delivery Charge (Rs 200)');
    expect(t).not.toContain('Delivery Charge (Rs 250)');
    expect(t).not.toContain('Delivery Charges');
    expect(t).toContain('Test Pizzas');
    expect(t).toContain(CHARGES_NOT_LISTED_NOTE);
  });

  it('Categories: Delivery Charges is not listed, the food’s categories are — and it says where the charges are', () => {
    signIn('admin');
    const t = text(render(<CategoriesTab />));
    expect(t).toContain('Test Pizzas');
    expect(t).not.toMatch(/Delivery Charges(?!’)/);
    expect(t).toContain(CHARGE_CATEGORY_NOT_LISTED_NOTE);
  });

  it('a food item’s tax choices leave “Delivery charge tax” out (never a new item’s first pick), unless the item is on it', () => {
    const taxes = [
      { id: 'tax-dct', name: 'Delivery charge tax', rateBps: 0 },
      { id: 'tax-gst', name: 'Test GST', rateBps: 1_500 },
    ] as unknown as TaxCategory[];
    expect(foodTaxChoices(taxes).map((t) => t.id)).toEqual(['tax-gst']);
    expect(foodTaxChoices(taxes, 'tax-dct').map((t) => t.id)).toEqual(['tax-dct', 'tax-gst']);
  });
});
