/**
 * Menu → Categories: the owner's "Never discounted" (migration 0047; the
 * owner, 2026-10-02: value deals never get a discount). Value Deals shows it
 * by its name with nothing set; only the owner's login can change the box
 * (a manager sees it off); Save sends it only when it changed, so a rename or
 * a manager's edit never does; no native confirm(). Static renders
 * (react-dom/server, no browser; nothing calls the till); Radix's dialog is
 * stood in for by plain elements. Every name is made up.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, Category, UUID } from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../components/toast/ToastProvider';
import { useSessionStore } from '../../stores/sessionStore';
import { CATEGORY_DISCOUNT_WORDS, WEBSITE_CHANGE_NOTE, itemNeverDiscountedNote } from '../settings/shop-rules/publishWords';
import { CategoriesTab, CategoryDialog, categoryCreateRequest, categoryUpdateRequest, type CategoryForm } from './CategoriesTab';

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

const category = (name: string, noDiscount: boolean | null, i = 0): Category => ({
  id: `c${i}` as UUID,
  name,
  displayOrder: i,
  colorHex: '#dc2626',
  isActive: true,
  isOnWebsite: true,
  noDiscount,
});

/** The "Never discounted" box's own tag, in a dialog's markup. */
function neverDiscountedBox(markup: string): string {
  const at = markup.indexOf(`${CATEGORY_DISCOUNT_WORDS.box}</label>`);
  expect(at).toBeGreaterThan(-1);
  const open = markup.lastIndexOf('<input', at);
  return markup.slice(open, markup.indexOf('>', open) + 1);
}

const noop = () => {};

describe('the list', () => {
  it('"Never discounted" beside Value Deals (by its name) and a category the owner marked — nowhere else', () => {
    signIn('admin');
    const out = render(<CategoriesTab />, [
      [
        ['menu', 'categories', 'all'],
        [category('Pizza', null, 0), category('Value Deals', null, 1), category('Test Combos', false, 2), category('Test Specials', true, 3)],
      ],
      [['menu', 'items', 'all'], []],
    ]);
    const rows = out
      .split('<tr')
      .slice(2)
      .map((r) => text(`<tr${r}`));
    const row = (name: string) => rows.find((r) => r.startsWith(name)) ?? '';
    expect(row('Value Deals')).toContain(CATEGORY_DISCOUNT_WORDS.badge);
    expect(row('Test Specials')).toContain(CATEGORY_DISCOUNT_WORDS.badge);
    expect(row('Pizza')).not.toContain(CATEGORY_DISCOUNT_WORDS.badge);
    // The owner said discounts come off it, whatever its name says.
    expect(row('Test Combos')).not.toContain(CATEGORY_DISCOUNT_WORDS.badge);
  });
});

describe('the category dialog', () => {
  it('the owner: Value Deals ticked by its name, the box his to change, and what it does in words', () => {
    signIn('admin');
    const out = render(<CategoryDialog existing={category('Value Deals', null)} onClose={noop} />);
    const box = neverDiscountedBox(out);
    expect(box).toContain('checked');
    expect(box).not.toContain('disabled');
    const words = text(out);
    expect(words).toContain('Discounts');
    expect(words).toContain(
      'No discount comes off its items: not the website’s pick-up discount, not the discount button, not an automatic offer. The rest of the order still gets its discount.',
    );
    expect(words).toContain('Set by its name: Value Deals, Deals and Combos are never discounted.');
    expect(words).toContain('Orders already rung up keep what they had.');
    expect(words).toContain(WEBSITE_CHANGE_NOTE);
    expect(words).not.toContain(CATEGORY_DISCOUNT_WORDS.ownerOnly);
  });

  it('a manager sees it, the box off: only the owner can change it', () => {
    signIn('manager');
    const out = render(<CategoryDialog existing={category('Value Deals', null)} onClose={noop} />);
    const box = neverDiscountedBox(out);
    expect(box).toContain('checked');
    expect(box).toContain('disabled');
    expect(text(out)).toContain('Only the owner can change this.');
  });

  it('what the owner set shows as he set it, without the name sentence', () => {
    signIn('admin');
    const off = render(<CategoryDialog existing={category('Value Deals', false)} onClose={noop} />);
    expect(neverDiscountedBox(off)).not.toContain('checked');
    expect(text(off)).not.toContain('Set by its name');
    const on = render(<CategoryDialog existing={category('Test Specials', true)} onClose={noop} />);
    expect(neverDiscountedBox(on)).toContain('checked');
    // A new category: by the name typed (empty: not ticked), with the name sentence.
    const fresh = render(<CategoryDialog existing={null} onClose={noop} />);
    expect(neverDiscountedBox(fresh)).not.toContain('checked');
    expect(text(fresh)).toContain('Set by its name');
  });
});

describe('Save sends "Never discounted" only when it changed', () => {
  const form = (over: Partial<CategoryForm> = {}): CategoryForm => ({
    name: 'Value Deals',
    displayOrder: 1,
    colorHex: '#dc2626',
    isActive: true,
    isOnWebsite: true,
    neverDiscounted: true,
    ...over,
  });

  it('editing: a box left as it was (a rename, a manager’s Save) sends nothing; a change sends it', () => {
    const deals = category('Value Deals', null);
    expect(categoryUpdateRequest(deals, form())).not.toHaveProperty('noDiscount');
    expect(categoryUpdateRequest(deals, form({ name: 'Test Bundles' }))).not.toHaveProperty('noDiscount');
    expect(categoryUpdateRequest(deals, form({ neverDiscounted: false }))).toMatchObject({ id: 'c0', noDiscount: false });
    const pizza = category('Pizza', null);
    expect(categoryUpdateRequest(pizza, form({ name: 'Pizza', neverDiscounted: false }))).not.toHaveProperty('noDiscount');
    expect(categoryUpdateRequest(pizza, form({ name: 'Pizza', neverDiscounted: true }))).toMatchObject({ noDiscount: true });
    // What the owner set counts as what it does now.
    expect(categoryUpdateRequest(category('Value Deals', false), form({ neverDiscounted: false }))).not.toHaveProperty('noDiscount');
    // The website box keeps its own rule.
    expect(categoryUpdateRequest(deals, form())).not.toHaveProperty('isOnWebsite');
  });

  it('a new category: nothing when the box says what its name says (the name decides), else the box', () => {
    expect(categoryCreateRequest(form())).not.toHaveProperty('noDiscount');
    expect(categoryCreateRequest(form({ name: 'Pizza', neverDiscounted: false }))).not.toHaveProperty('noDiscount');
    expect(categoryCreateRequest(form({ name: 'Pizza', neverDiscounted: true }))).toMatchObject({ name: 'Pizza', noDiscount: true });
    expect(categoryCreateRequest(form({ neverDiscounted: false }))).toMatchObject({ noDiscount: false });
  });

  it('the dialog saves through them, and asks nothing with the browser’s own confirm()', () => {
    const src = readFileSync(fileURLToPath(new URL('./CategoriesTab.tsx', import.meta.url)), 'utf8');
    expect(src).toContain('ipc.menu.updateCategory(categoryUpdateRequest(existing, form))');
    expect(src).toContain('ipc.menu.createCategory(categoryCreateRequest(form))');
    expect(src).not.toMatch(/(^|[^.\w])confirm\(|window\.confirm|\balert\(/m);
  });
});

describe('the item editor', () => {
  it('says, read-only, when its category is never discounted', () => {
    expect(itemNeverDiscountedNote('Value Deals')).toBe('Never discounted — it is in “Value Deals” (Menu → Categories).');
  });
});
