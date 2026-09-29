/**
 * The menu files from the costing PC on screen (v0.7.32), rendered to static
 * markup (react-dom/server, no browser; nothing calls the till):
 *   - Settings → Kitchen & stock: "Menu updates from the costing file" (put
 *     in by themselves by default, or wait for the owner's OK), and "Menu file
 *     from the costing PC" — the key by its last 4 characters only, where the
 *     till stands, the history, and "Make a new upload key" for the owner;
 *   - Menu → Import: the panel above the file picker, and "Show the changes"
 *     only when the file waits for someone;
 *   - the Dashboard's banner only for a file that needs the owner.
 * Every name and number is made up.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MENU_AUTO_UPDATE,
  SHOP_SETTING_DEFAULTS,
  type AuthenticatedUser,
  type MenuDeployView,
  type ShopSettingCard,
  type ShopSettingKey,
  type UUID,
} from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../../components/toast/ToastProvider';
import { useSessionStore } from '../../../stores/sessionStore';
import { MenuFromCostingPc } from '../MenuFromCostingPc';
import { ImportTab } from '../../menu-mgmt/ImportTab';
import { MenuDeployBanner } from '../../dashboard/MenuDeployBanner';
import { MENU_DEPLOY_KEY } from '../../menu-mgmt/useMenuDeploy';
import { SHOP_SETTINGS_KEY } from './useShopSetting';
import { KEY_DIALOG_STAYS_OPEN, applyQuestion, keyStatusText, menuAutoUpdateSummary, phaseTone } from './menuDeployWords';

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

function card<K extends ShopSettingKey>(key: K, value: ShopSettingCard<K>['value'], saved = true): ShopSettingCard<K> {
  return {
    key,
    value,
    defaultValue: SHOP_SETTING_DEFAULTS[key] as ShopSettingCard<K>['value'],
    isDefault: !saved,
    readOnly: false,
    lastChanged: saved ? { at: '2026-09-29T09:02:00.000Z', byName: 'Test Owner', onThisTill: true } : null,
    notOnOtherTillYet: false,
    history: [],
  };
}

const VIEW: MenuDeployView = {
  websiteLinked: true,
  phase: 'waiting_for_owner',
  message: 'A new menu file is waiting for your OK: file #4 (test-menu.json). Menu → Import shows what it changes.',
  scope: 'shared',
  mode: 'ask',
  key: { keyHint: 'ab_Z', createdAt: '2026-09-29T08:00:00.000Z', deviceName: 'Test Till 1', madeOnThisTill: true },
  package: {
    id: '0b8f6c8e-8f8a-4c8a-9d2e-1c6a7d2b9e10',
    seq: 4,
    fileName: 'test-menu.json',
    source: 'test',
    generatedAt: '2026-09-29T08:30:00.000Z',
    uploadedAt: '2026-09-29T08:31:00.000Z',
    itemCount: 12,
    ingredientCount: 9,
    formatVersion: 3,
    state: 'pending',
  },
  appliedHere: null,
  canApplyNow: true,
  applyNeedsOwner: false,
  lastCheckedAt: '2026-09-29T09:00:00.000Z',
  nextCheckAt: '2026-09-29T09:03:00.000Z',
  lastError: null,
  history: [
    { at: '2026-09-29T08:31:00.000Z', text: 'test-menu.json sent from TEST-PC (12 items, 9 ingredients)', tone: 'ok' },
    { at: '2026-09-29T08:32:00.000Z', text: 'Till 2 could not put in test-menu.json: Test error', tone: 'warn' },
  ],
};

describe('Settings → Kitchen & stock: the menu files from the costing PC', () => {
  it('nothing saved: "Apply by themselves" is the default; the key by its last 4 characters; the owner may make a new one', () => {
    signIn('admin');
    const out = render(<MenuFromCostingPc />, [
      [[...SHOP_SETTINGS_KEY, 'menu.autoUpdate'], card('menu.autoUpdate', DEFAULT_MENU_AUTO_UPDATE, false)],
      [[...MENU_DEPLOY_KEY, 'history'], VIEW],
    ]);
    const words = text(out);
    expect(words).toContain('Menu updates from the costing file');
    expect(words).toContain('Apply by themselves');
    expect(words).toContain('Wait for my OK (Menu → Import)');
    expect(out).toMatch(/role="radio" aria-checked="true"[^>]*><span[^>]*>Apply by themselves/);
    expect(words).toContain('never Start fresh');
    expect(words).toContain('Menu file from the costing PC');
    expect(words).toContain('Upload key made 29 Sep on this till (…ab_Z).');
    expect(words).toContain(VIEW.message);
    expect(words).toContain('Make a new upload key');
    expect(words).toContain('Check now');
    expect(words).toContain('Till 2 could not put in test-menu.json: Test error');
    expect(words).toContain('Make a new one: the old one stops at once.');
  });

  it('a manager (Settings is the owner’s, but the card never offers a key to anyone else)', () => {
    signIn('manager');
    const out = render(<MenuFromCostingPc />, [
      [[...SHOP_SETTINGS_KEY, 'menu.autoUpdate'], card('menu.autoUpdate', { v: 1, mode: 'ask' })],
      [[...MENU_DEPLOY_KEY, 'history'], VIEW],
    ]);
    expect(text(out)).not.toContain('Make a new upload key');
    expect(out).toMatch(/role="radio" aria-checked="true"[^>]*><span[^>]*>Wait for my OK/);
  });

  it('what a leaked key could do is said truly: item prices and tax follow the rules above; big cuts and tax changes wait', () => {
    signIn('admin');
    const words = text(
      render(<MenuFromCostingPc />, [
        [[...SHOP_SETTINGS_KEY, 'menu.autoUpdate'], card('menu.autoUpdate', DEFAULT_MENU_AUTO_UPDATE, false)],
        [[...MENU_DEPLOY_KEY, 'history'], VIEW],
      ]),
    );
    expect(words).not.toMatch(/keeps its prices|keeps the prices/);
    expect(words).toContain('item prices, tax, choices and recipes change as far as “What a menu file may change” above allows');
    expect(words).toContain('A file that would cut prices to less than half, or change the tax, always waits for your OK');
    expect(words).toContain('still waits for your OK');
  });

  it('a till with no website link: never "no key yet, make one below" (it cannot see the key, and the button is off)', () => {
    signIn('admin');
    const noLink: MenuDeployView = { ...VIEW, websiteLinked: false, phase: 'not_linked', key: null, canApplyNow: false, message: 'x' };
    const words = text(
      render(<MenuFromCostingPc />, [
        [[...SHOP_SETTINGS_KEY, 'menu.autoUpdate'], card('menu.autoUpdate', DEFAULT_MENU_AUTO_UPDATE, false)],
        [[...MENU_DEPLOY_KEY, 'history'], noLink],
      ]),
    );
    expect(words).not.toContain('No upload key yet');
    expect(words).toContain('This till has no website link, so it cannot see the upload key.');
    expect(keyStatusText(null, false)).toContain('made, and checked, on a till that has the website link');
  });

  it('the new key’s window closes only with its own buttons (a tap beside it or Esc would lose the key)', () => {
    for (const handler of Object.values(KEY_DIALOG_STAYS_OPEN)) {
      const e = { preventDefault: vi.fn() };
      handler(e);
      expect(e.preventDefault).toHaveBeenCalledTimes(1);
    }
    expect(Object.keys(KEY_DIALOG_STAYS_OPEN).sort()).toEqual(['onEscapeKeyDown', 'onInteractOutside', 'onPointerDownOutside']);
  });

  it('the words: no key yet, the other till’s key, History lines, tones', () => {
    expect(keyStatusText(null)).toBe('No upload key yet: make one below, then put it on the costing PC.');
    expect(keyStatusText({ keyHint: 'x9Yz', createdAt: '2026-09-28T10:00:00.000Z', deviceName: 'Test Till 2', madeOnThisTill: false })).toBe(
      'Upload key made 28 Sep on Test Till 2 (…x9Yz).',
    );
    expect(menuAutoUpdateSummary({ v: 1, mode: 'auto' })).toBe('Menu files from the costing PC go in by themselves');
    expect(menuAutoUpdateSummary({ v: 1, mode: 'ask' })).toBe('Menu files wait for your OK (Menu → Import)');
    expect(phaseTone('refused')).toBe('bad');
    expect(phaseTone('applied')).toBe('good');
    const s = { newItems: 1, updatedItems: 2, priceChanges: 0, recipesSet: 1, newIngredients: 0, updatedIngredients: 0, priceLine: 'Prices: 1 kept.', keptLine: null };
    expect(applyQuestion({ phase: 'waiting_for_owner' }, s)).toMatch(/^Apply this menu file\?/);
    expect(applyQuestion({ phase: 'stalled' }, s)).toContain('doubled items');
  });
});

describe('Menu → Import: the panel above the file picker', () => {
  it('waiting for the OK: the sentence, the file, and "Show the changes"', () => {
    signIn('manager');
    const out = render(<ImportTab />, [[[...MENU_DEPLOY_KEY, 'view'], VIEW]]);
    const words = text(out);
    expect(words).toContain(VIEW.message);
    expect(words).toContain('File #4: test-menu.json');
    expect(words).toContain('Show the changes');
    expect(words).toContain('Choose menu file');
  });

  it('the button says what the sentence says: "Try again…" after it gave up, "Take it over…" when the other till stopped', () => {
    signIn('admin');
    const gaveUp: MenuDeployView = { ...VIEW, phase: 'gave_up', message: 'Putting in file #4 failed 5 times. Tap Try again in Menu → Import.' };
    const w1 = text(render(<ImportTab />, [[[...MENU_DEPLOY_KEY, 'view'], gaveUp]]));
    expect(w1).toContain('Try again…');
    expect(w1).not.toContain('Show the changes');
    const stalled: MenuDeployView = { ...VIEW, phase: 'stalled', applyNeedsOwner: true, message: 'The owner can tap Take it over in Menu → Import.' };
    expect(text(render(<ImportTab />, [[[...MENU_DEPLOY_KEY, 'view'], stalled]]))).toContain('Take it over…');
  });

  it('put in by itself: the sentence, no button; no website link: no panel at all', () => {
    signIn('manager');
    const applied: MenuDeployView = { ...VIEW, phase: 'applied', mode: 'auto', canApplyNow: false, message: 'This till put in the newest menu file, file #4 (test-menu.json), by itself.' };
    const words = text(render(<ImportTab />, [[[...MENU_DEPLOY_KEY, 'view'], applied]]));
    expect(words).toContain(applied.message);
    expect(words).not.toContain('Show the changes');
    const notLinked: MenuDeployView = { ...VIEW, websiteLinked: false, phase: 'not_linked', canApplyNow: false, message: 'x' };
    expect(text(render(<ImportTab />, [[[...MENU_DEPLOY_KEY, 'view'], notLinked]]))).not.toContain('Menu file from the costing PC');
  });
});

describe('Dashboard → Shop status', () => {
  it('a banner only for a file that needs the owner', () => {
    signIn('admin');
    const refused: MenuDeployView = { ...VIEW, phase: 'refused', message: 'File #4 (test-menu.json) was refused: Test problem. Nothing was changed.' };
    const words = text(render(<MenuDeployBanner />, [[[...MENU_DEPLOY_KEY, 'view'], refused]]));
    expect(words).toContain('A menu file from the costing PC needs you');
    expect(words).toContain(refused.message);
    for (const phase of ['applied', 'received', 'idle', 'not_linked', 'waiting_quiet'] as const) {
      expect(text(render(<MenuDeployBanner />, [[[...MENU_DEPLOY_KEY, 'view'], { ...VIEW, phase }]]))).toBe('');
    }
    // A file waiting for the owner's OK stays on the Dashboard until he looks (its one note may have
    // gone by while a cashier was signed in).
    const waiting = text(render(<MenuDeployBanner />, [[[...MENU_DEPLOY_KEY, 'view'], VIEW]]));
    expect(waiting).toContain('A menu file from the costing PC waits for your OK');
    expect(waiting).toContain(VIEW.message);
    // Held back by a broken link: nothing else on the screens would say so.
    const link = render(<MenuDeployBanner />, [[[...MENU_DEPLOY_KEY, 'view'], { ...VIEW, phase: 'waiting_link', canApplyNow: false }]]);
    expect(text(link)).toContain('waits for the link to the other till');
    expect(link).toContain('href="/settings?tab=advanced"');
    const tooOld = render(<MenuDeployBanner />, [[[...MENU_DEPLOY_KEY, 'view'], { ...VIEW, phase: 'too_old' }]]);
    expect(tooOld).toContain('href="/settings?tab=about"');
  });
});
