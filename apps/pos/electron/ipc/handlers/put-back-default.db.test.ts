/**
 * "Put back the default" for the rules first-time setup stores (the shop's
 * details, opening hours, website words, home page, website pick-up and the
 * delivery areas), through the real setup and settings handlers and the real
 * repositories, on a real SQLite database built from every migration:
 *   - on a Pixel & Oak POS till (edition 'pixelandoak') the default is what
 *     that till's setup stored: each card shows it as the default right after
 *     setup, and a put back after a change writes it again — never the
 *     built-in values, which are Cheese O'Clock's;
 *   - on Cheese O'Clock's tills (edition 'cheeseoclock', every build without
 *     an edition) a put back is exactly what it always was: the built-in
 *     values (db/till-defaults.ts).
 * Only `defineHandler` (captured), the signed-in session, the edition, the
 * printer spooler and the FBR worker are stood in for; node's own
 * `node:sqlite` stands in for better-sqlite3 (built for Electron), skipped
 * where it is missing. Every name, number and area is made up.
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SHOP_PROFILE,
  DEFAULT_SHOP_WEBSITE,
  DEFAULT_WEBSITE_HOME,
  EDITIONS,
  NEW_SHOP_KEYS,
  SHOP_SETTING_DEFAULTS,
  type AuthenticatedUser,
  type EditionId,
  type ShopSettingCard,
  type ShopSettingKey,
  type UUID,
} from '@cheeseoclock/shared-types';

// Real argon2id for the owner's secret at setup: seconds on a slow CI runner.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

type Handler = (ctx: unknown, payload: unknown) => unknown;
const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown, payload: unknown) => unknown>(),
  session: null as unknown,
  /** The edition every module sees (electron/edition.ts): switched per test, read at each call. */
  edition: {} as Record<string, unknown>,
}));

vi.mock('../registry.js', () => {
  class IpcGuardError extends Error {
    readonly apiError: { code: string; message: string };
    constructor(apiError: { code: string; message: string }) {
      super(apiError.message);
      this.apiError = apiError;
      this.name = 'IpcGuardError';
    }
  }
  return {
    IpcGuardError,
    defineHandler: (channel: string, _ctx: unknown, fn: Handler) => {
      h.handlers.set(channel, fn);
    },
  };
});
vi.mock('../../edition.js', async () => {
  const shared = await import('@cheeseoclock/shared-types');
  Object.assign(h.edition, shared.EDITIONS.pixelandoak);
  return { EDITION: h.edition };
});
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  const userData = mkdtempSync(joinPath(tmpdir(), 'coc-put-back-test-'));
  return {
    BrowserWindow: { getAllWindows: () => [] },
    safeStorage: { isEncryptionAvailable: () => false },
    app: { getPath: () => userData, getVersion: () => '0.0.0-test', isPackaged: false },
  };
});
vi.mock('../../services/auth-service.js', () => ({ getCurrentSession: () => h.session }));
vi.mock('../../services/print-spooler.js', () => ({
  printSpooler: new Proxy({}, { get: () => () => undefined }),
}));
vi.mock('../../services/fbr-worker.js', () => ({ fbrWorker: { kick: () => {}, resetAdapter: () => {} } }));

interface Stmt {
  run(...p: unknown[]): unknown;
  all(...p: unknown[]): Array<Record<string, unknown>>;
  get(...p: unknown[]): Record<string, unknown> | undefined;
}
interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
}
const Sqlite = (() => {
  try {
    return (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => RawDb }).DatabaseSync;
  } catch {
    return null;
  }
})();
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');

function openMigrated() {
  const raw = new Sqlite!(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  raw.exec('PRAGMA foreign_keys = ON');
  let depth = 0;
  return {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
    transaction:
      <A extends unknown[], R>(fn: (...args: A) => R) =>
      (...args: A): R => {
        const sp = `sp_${depth}`;
        raw.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${sp}`);
        depth += 1;
        try {
          const out = fn(...args);
          depth -= 1;
          raw.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
          return out;
        } catch (e) {
          depth -= 1;
          if (depth === 0) raw.exec('ROLLBACK');
          else raw.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
          throw e;
        }
      },
  };
}

/** The Website step's answers (made up): pick-up off, no delivery areas. */
const WEBSITE = {
  phone: '0300 1112233',
  whatsapp: '',
  street: 'Plot 9, Test Street, Test Block 2',
  areaLine: 'Test Town, Karachi',
  postalCode: '75999',
  priceRange: 'PKR 100–900',
  opens: '12:00',
  closes: '00:00',
  days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
  pickup: { offered: false, percent: 0 },
};

/** A key's value without its format number (what it SAYS). */
const said = (v: unknown) => {
  const { v: _v, ...rest } = v as Record<string, unknown>;
  return rest;
};

/** A fresh till of `edition`, set up through the real first-time setup; the owner signed in. */
async function setUpTill(edition: EditionId) {
  Object.assign(h.edition, EDITIONS[edition]);
  h.handlers.clear();
  const db = openMigrated();
  const ctx = { db, deviceId: 'dev-A' };
  (await import('./system-handlers.js')).registerSystemHandlers(ctx as never);
  (await import('./settings-handlers.js')).registerSettingsHandlers(ctx as never);
  const done = (await h.handlers.get('system:completeOnboarding')!(ctx, {
    storeName: 'Test Kitchen',
    storeTagline: 'Made-up words',
    taxCategories: [{ name: 'GST', rateBps: 1500 }],
    deliveryAreas: 'none',
    website: WEBSITE,
    admin: { fullName: 'Test Owner', pin: 'Owner pass 1' },
  })) as { data: { adminUserId: string } };
  const owner: AuthenticatedUser = { id: done.data.adminUserId as UUID, fullName: 'Test Owner', role: 'admin', sessionId: 'sess' as UUID };
  h.session = owner;
  const call = async <T>(channel: string, payload: unknown): Promise<T> => {
    const r = (await h.handlers.get(channel)!(ctx, payload)) as { ok: boolean; data: T };
    expect(r.ok, channel).toBe(true);
    return r.data;
  };
  const card = <K extends ShopSettingKey>(key: K) => call<ShopSettingCard<K>>('settings:getBusiness', { key });
  return { db, call, card };
}

/** What the owner changes after setup, one save per rule (made up). */
const CHANGES: Array<[ShopSettingKey, (v: Record<string, unknown>) => unknown]> = [
  ['shop.profile', (v) => ({ ...v, name: 'Test Kitchen Two', tagline: 'Other words' })],
  ['shop.hours', (v) => ({ ...v, opens: '10:00', closes: '22:00' })],
  ['shop.website', (v) => ({ ...v, whatsappGreeting: 'Salaam! One order please: ' })],
  ['website.home', (v) => ({ ...v, pizzas: [{ itemRef: { posItemId: null, name: 'Test Pizza — Large' } }] })],
  ['discounts.websitePickup', (v) => ({ ...v, offered: true, percent: 10 })],
];
const AREA = { id: 'test-town', name: 'Test Town', shortName: 'Test Town', group: 'Test', feeCents: 0, active: true, aliases: [], hints: [] };

/** Everything that names the first shop (its built-in details), lower-case. */
const FIRST_SHOP = [
  DEFAULT_SHOP_PROFILE.name,
  DEFAULT_SHOP_PROFILE.phone.e164,
  DEFAULT_SHOP_PROFILE.address.street,
  DEFAULT_SHOP_PROFILE.priceRange,
  DEFAULT_SHOP_WEBSITE.whatsappGreeting,
  ...DEFAULT_WEBSITE_HOME.pizzas.map((e) => e.itemRef.name),
  'cheese',
  'dha',
].map((w) => w.toLowerCase());

describe.skipIf(!Sqlite)('"Put back the default" for the rules first-time setup stores', () => {
  it('Pixel & Oak POS: the default is what this till’s setup stored — shown after setup, and written back after a change; never the first shop’s', async () => {
    const { call, card } = await setUpTill('pixelandoak');
    const setup = new Map<ShopSettingKey, unknown>();
    // Right after setup every card is at its default, and its default is the setup's value.
    for (const key of NEW_SHOP_KEYS) {
      const c = await card(key);
      expect(c.isDefault, key).toBe(true);
      expect(said(c.defaultValue), key).toEqual(said(c.value));
      setup.set(key, c.value);
    }
    expect((await card('discounts.websitePickup')).defaultValue).toMatchObject({ offered: false, percent: 0 });
    expect((await card('website.home')).defaultValue).toMatchObject({ pizzas: [], burger: null, deals: [] });

    // The owner changes each one…
    for (const [key, change] of CHANGES) {
      const c = await call<ShopSettingCard<typeof key>>('settings:setBusiness', { key, value: change(setup.get(key) as Record<string, unknown>) });
      expect(c.isDefault, key).toBe(false);
    }
    await call('settings:saveDeliveryZones', { zones: [AREA] });
    // …and puts each back: the setup's values again, the card at its default.
    const putBack: unknown[] = [];
    for (const key of NEW_SHOP_KEYS) {
      const c = await call<ShopSettingCard<typeof key>>('settings:setBusiness', { key, useDefault: true });
      expect(said(c.value), key).toEqual(said(setup.get(key)));
      expect(c.isDefault, key).toBe(true);
      putBack.push(c.value);
    }
    // The areas: setup chose none, so the area added since stays (never removed), switched off.
    await call('settings:saveDeliveryZones', { useDefault: true });
    const zones = (await card('delivery.zones')).value.zones;
    expect(zones.map((z) => [z.id, z.active])).toEqual([['test-town', false]]);
    putBack.push(zones);

    const text = JSON.stringify(putBack).toLowerCase();
    for (const word of FIRST_SHOP) expect(text, word).not.toContain(word);
    // The check finds those words in what a put back writes on Cheese O'Clock's tills.
    const builtIn = JSON.stringify(NEW_SHOP_KEYS.map((k) => SHOP_SETTING_DEFAULTS[k])).toLowerCase();
    for (const word of FIRST_SHOP.filter((w) => w !== 'dha')) expect(builtIn, word).toContain(word);
  });

  it('Cheese O’Clock’s tills: a put back writes the built-in values, exactly as always — even on a till set up with the new setup', async () => {
    const { call, card } = await setUpTill('cheeseoclock');
    for (const key of NEW_SHOP_KEYS) {
      const c = await card(key);
      expect(said(c.defaultValue), key).toEqual(said(SHOP_SETTING_DEFAULTS[key]));
    }
    for (const [key, change] of CHANGES) {
      await call('settings:setBusiness', { key, value: change((await card(key)).value as unknown as Record<string, unknown>) });
    }
    for (const key of NEW_SHOP_KEYS) {
      const c = await call<ShopSettingCard<typeof key>>('settings:setBusiness', { key, useDefault: true });
      expect(said(c.value), key).toEqual(said(SHOP_SETTING_DEFAULTS[key]));
      expect(c.isDefault, key).toBe(true);
    }
    await call('settings:saveDeliveryZones', { zones: [AREA] });
    await call('settings:saveDeliveryZones', { useDefault: true });
    const zones = (await card('delivery.zones')).value.zones;
    // Today's 21 areas, and the one added since switched off.
    expect(zones.map((z) => z.id)).toEqual([...SHOP_SETTING_DEFAULTS['delivery.zones'].zones.map((z) => z.id), 'test-town']);
    expect(zones.find((z) => z.id === 'test-town')?.active).toBe(false);
  });

  it('db/till-defaults: Cheese O’Clock’s built-in default for every rule; Pixel & Oak POS’s setup value only for the rules setup stores', async () => {
    const { tillDefaultOf, setupValueOf, SETUP_KEYS } = await import('../../db/till-defaults.js');
    const { db } = await setUpTill('pixelandoak');
    expect([...SETUP_KEYS].sort()).toEqual([...NEW_SHOP_KEYS, 'delivery.zones'].sort());
    for (const key of NEW_SHOP_KEYS) expect(said(tillDefaultOf(db as never, key)), key).toEqual(said(setupValueOf(db as never, key)));
    // A rule setup does not store keeps its built-in default (they name no shop).
    expect(tillDefaultOf(db as never, 'staff.timing')).toBe(SHOP_SETTING_DEFAULTS['staff.timing']);
    Object.assign(h.edition, EDITIONS.cheeseoclock);
    for (const key of [...NEW_SHOP_KEYS, 'delivery.zones' as const]) expect(tillDefaultOf(db as never, key), key).toBe(SHOP_SETTING_DEFAULTS[key]);
  });
});
