/**
 * First-time setup through the real `system:completeOnboarding` handler,
 * against a real SQLite database built from every migration:
 *   - the owner's name and PIN or password, and the website's answers, are
 *     checked before anything is written (a bad PIN once saved the branding
 *     and tax, and each retry added the tax categories again);
 *   - the owner, branding, website details and tax land together or not at
 *     all;
 *   - it runs once;
 *   - a new till's website details are its own (new-shop.ts): the shop
 *     block and the settings block of a freshly set-up till carry nothing
 *     of the first shop's, while a till set up before this setup (the first
 *     shop's) still reads exactly its built-in details.
 * The repository mechanism is tested in auth-service.db.test.ts; this pins
 * the handler's wiring, so moving a write back above createUser fails here.
 *
 * Only `defineHandler` is replaced (it captures the handler instead of
 * registering it with Electron); the handler body, createUser, the branding
 * and tax repositories are the real ones. better-sqlite3 is built for
 * Electron's ABI, so this uses `node:sqlite` with a small `transaction()`
 * shim and skips itself where node:sqlite is missing. Every name and secret
 * is made up.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// Real argon2id for the owner's secret: seconds on a slow CI runner.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

type Handler = (ctx: unknown, payload: unknown) => Promise<unknown>;
const registered = vi.hoisted(() => new Map<string, Handler>());

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
      registered.set(channel, fn);
    },
  };
});
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  const userData = mkdtempSync(joinPath(tmpdir(), 'coc-setup-test-'));
  return {
    BrowserWindow: { getAllWindows: () => [] },
    safeStorage: { isEncryptionAvailable: () => false },
    app: { getPath: () => userData, getVersion: () => '0.0.0-test', isPackaged: false },
  };
});

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
    return (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => RawDb })
      .DatabaseSync;
  } catch {
    return null;
  }
})();

/** better-sqlite3's `db.transaction(fn)`: BEGIN at the outside, SAVEPOINTs inside. */
function withTransactions(raw: RawDb) {
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

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');

function makeDb() {
  const raw = new Sqlite!(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  return { raw, db: withTransactions(raw) as never };
}

/** The Website step's answers (made up). */
const WEBSITE = {
  phone: ' 0300 1112233 ',
  whatsapp: '0321 4445566',
  street: 'Plot 9, Test Street, Test Block 2',
  areaLine: 'Test Town, Karachi',
  postalCode: '75999',
  priceRange: 'PKR 100–900',
  opens: '12:00',
  closes: '00:00',
  days: ['sun', 'tue', 'wed', 'thu', 'fri', 'sat'],
  pickup: { offered: false, percent: 15 },
};

const setup = (pin: string, more: Record<string, unknown> = {}) => ({
  storeName: 'Test Pizza',
  storeTagline: 'Hot and fresh',
  taxCategories: [
    { name: 'GST', rateBps: 1600 },
    { name: '  ', rateBps: 0 }, // a blank row on the form: skipped
    { name: 'Card', rateBps: 500 },
  ],
  website: WEBSITE,
  admin: { fullName: 'Owner', pin },
  ...more,
});

/**
 * Everything that names the first shop: its built-in details (the frozen
 * defaults — name, tagline, numbers as printed and dialled, address, social
 * links, price range, greeting, the home page's dishes) and the words of
 * its name and street. Not its allergy words or "cash": they name no shop.
 */
async function firstShopWords(): Promise<string[]> {
  const { DEFAULT_SHOP_PROFILE: p, DEFAULT_SHOP_WEBSITE: w, DEFAULT_WEBSITE_HOME: h } = await import('@cheeseoclock/shared-types');
  const lines = [p.phone, ...p.whatsappLines].flatMap((l) => [l.display, l.e164, l.e164.replace(/^\+92/, '')]);
  const dishes = [...h.pizzas, ...(h.burger ? [h.burger] : []), ...h.deals].map((e) => e.itemRef.name);
  return [
    p.name,
    p.tagline,
    ...lines,
    p.address.street,
    p.address.areaLine,
    p.address.postalCode,
    ...p.socialLinks,
    p.priceRange,
    w.whatsappGreeting,
    ...dishes,
    'cheese',
    'clock',
    'Rahat',
    'DHA',
  ];
}

describe.skipIf(!Sqlite)('first-time setup through system:completeOnboarding', () => {
  it('checks the owner first, then writes owner, branding and tax together — once', async () => {
    const { registerSystemHandlers } = await import('./system-handlers.js');
    const { BRANDING_KEY } = await import('../../services/printer-config.js');
    const { verifyAuditChain } = await import('../../db/audit-chain.js');
    const { raw, db } = makeDb();
    const ctx = { db, deviceId: 'dev-A' };
    registerSystemHandlers(ctx as never);
    const complete = registered.get('system:completeOnboarding')!;
    expect(complete).toBeTypeOf('function');

    const count = (sql: string) => Number(raw.prepare(sql).get()?.n ?? 0);
    const snapshot = () => ({
      users: count(`SELECT COUNT(*) AS n FROM users`),
      tax: count(`SELECT COUNT(*) AS n FROM tax_categories`),
      branding: count(`SELECT COUNT(*) AS n FROM settings WHERE key = '${BRANDING_KEY}'`),
      settings: count(`SELECT COUNT(*) AS n FROM settings`),
      business: count(`SELECT COUNT(*) AS n FROM business_settings`),
      sync: count(`SELECT COUNT(*) AS n FROM sync_queue`),
      audit: count(`SELECT COUNT(*) AS n FROM audit_log`),
    });
    const empty = snapshot();
    expect(empty.users).toBe(0);

    // A PIN or name that breaks the rules is refused before anything is written.
    await expect(complete(ctx, setup('12'))).rejects.toMatchObject({
      apiError: { code: 'validation_failed', message: 'A PIN is 4 to 12 numbers' },
    });
    await expect(complete(ctx, setup('abc'))).rejects.toMatchObject({
      apiError: { code: 'validation_failed', message: 'A password is at least 6 characters' },
    });
    await expect(
      complete(ctx, setup('Owner pass 1', { admin: { fullName: '   ', pin: 'Owner pass 1' } })),
    ).rejects.toMatchObject({ apiError: { code: 'validation_failed', message: 'Type your name' } });
    // So are website answers that don't fit — or none (a screen without the Website step).
    const refused = async (more: Record<string, unknown>, message: string) =>
      expect(complete(ctx, setup('Owner pass 1', more))).rejects.toMatchObject({ apiError: { code: 'validation_failed', message } });
    await refused({ website: undefined }, 'Fill in what the website shows');
    await refused({ website: { ...WEBSITE, phone: '021 111 222 333' } }, 'Type the shop’s phone number as it is dialled in Pakistan (like 0300 1234567)');
    await refused({ website: { ...WEBSITE, postalCode: '7550' } }, 'The postal code is five digits');
    await refused({ website: { ...WEBSITE, pickup: { offered: true, percent: 60 } } }, 'The pick-up discount is a whole % from 0 to 50');
    await refused({ storeName: '   ' }, 'The shop’s name can’t be empty');
    expect(snapshot()).toEqual(empty);

    // Something failing after the owner is written takes the owner back out,
    // and the branding, website details and tax written before it.
    await expect(complete(ctx, setup('Owner pass 1', { deliveryCity: 42 }))).rejects.toThrow();
    expect(snapshot()).toEqual(empty);

    // Then a good one: one owner, the branding, the two named tax rates, the
    // website's five details and the (empty) delivery areas.
    await expect(complete(ctx, setup(' Owner pass 1 '))).resolves.toMatchObject({ ok: true });
    const done = snapshot();
    expect(done.users).toBe(1);
    expect(done.tax).toBe(empty.tax + 2);
    expect(done.branding).toBe(1);
    expect(done.business).toBe(empty.business + 6);
    const branding = JSON.parse(
      String(raw.prepare(`SELECT value_json FROM settings WHERE key = ?`).get(BRANDING_KEY)?.value_json),
    ) as Record<string, unknown>;
    expect(branding).toMatchObject({ storeName: 'Test Pizza', storeTagline: 'Hot and fresh' });
    expect(raw.prepare(`SELECT role, secret_kind FROM users`).get()).toEqual({
      role: 'admin',
      secret_kind: 'password',
    });

    // A second run is refused and adds nothing — no second owner, no tax twice.
    await expect(complete(ctx, setup('Other pass 2'))).rejects.toMatchObject({
      apiError: { code: 'precondition_failed', message: 'Setup is already complete' },
    });
    expect(snapshot()).toEqual(done);

    // The rolled-back attempt left no gap in the audit trail.
    const rows = raw
      .prepare(
        `SELECT rowid, id, entity_type, entity_id, action, actor_user_id, before_json, after_json,
                ip, created_at, prev_hash, row_hash
           FROM audit_log ORDER BY rowid`,
      )
      .all()
      .map((r) => ({
        rowid: Number(r.rowid),
        id: String(r.id),
        entityType: String(r.entity_type),
        entityId: String(r.entity_id),
        action: String(r.action),
        actorUserId: (r.actor_user_id as string | null) ?? null,
        beforeJson: (r.before_json as string | null) ?? null,
        afterJson: (r.after_json as string | null) ?? null,
        ip: (r.ip as string | null) ?? null,
        createdAt: String(r.created_at),
        prevHash: (r.prev_hash as string | null) ?? null,
        rowHash: (r.row_hash as string | null) ?? null,
      }));
    expect(rows.length).toBeGreaterThan(0);
    expect(verifyAuditChain(rows)).toMatchObject({ ok: true, brokenAt: null });
  });
});

describe.skipIf(!Sqlite)('system:getBranding (the sign-in screen, before anyone logs in)', () => {
  it('answers the receipt’s name, and the website’s name for the shop only once the owner saved one (never the built-in first shop’s)', async () => {
    const { registerSystemHandlers } = await import('./system-handlers.js');
    const { setBusinessSetting } = await import('../../db/repositories/business-settings-repo.js');
    const { DEFAULT_SHOP_PROFILE } = await import('@cheeseoclock/shared-types');
    const { raw, db } = makeDb();
    const T0 = '2026-01-01T00:00:00.000Z';
    raw
      .prepare(`INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES ('u_owner', 'Test Owner', 'x', 'admin', ?, ?, 'dev-A')`)
      .run(T0, T0);
    const ctx = { db, deviceId: 'dev-A' };
    registerSystemHandlers(ctx as never);
    const branding = registered.get('system:getBranding')!;
    const beforeSave = (await branding(ctx, undefined)) as { ok: boolean; data: { storeName: string; shopName?: string } };
    expect(beforeSave).toMatchObject({ ok: true, data: { storeName: 'My Store' } });
    expect(beforeSave.data.shopName).toBeUndefined();
    // The owner's Save of Shop details (made-up name) — synced, both tills.
    setBusinessSetting(db, 'shop.profile', { ...structuredClone(DEFAULT_SHOP_PROFILE), name: 'Test Shop' } as never, { userId: 'u_owner', deviceId: 'dev-A' });
    expect(await branding(ctx, undefined)).toMatchObject({ ok: true, data: { shopName: 'Test Shop' } });
  });
});

/** An empty menu, as a new till's first publish sends it (the settings block is checked against it). */
const NO_MENU = {
  categories: [],
  publishedAt: '2026-10-20T00:00:00.000Z',
  store: { name: 'Test Pizza', phone: null, whatsapp: null, addressLine: null, tagline: null },
};

describe.skipIf(!Sqlite)('a new till’s website details are its own — never the first shop’s', () => {
  it('first-time setup stores the five, each synced and audited; the website’s blocks carry them from the first publish', async () => {
    const { registerSystemHandlers } = await import('./system-handlers.js');
    const { readShopSetting } = await import('../../db/business-settings-read.js');
    const { shopBlockFor } = await import('../../services/website-shop-block.js');
    const { settingsBlockFor } = await import('../../services/website-settings-block.js');
    const { businessSettingId } = await import('../../db/business-settings-ids.js');
    const { publishedShopSchema } = await import('@cheeseoclock/shared-schemas');
    const { DEFAULT_SHOP_HOURS, DEFAULT_SHOP_WEBSITE, NEW_SHOP_KEYS, NOTHING_FEATURED } = await import('@cheeseoclock/shared-types');
    const { raw, db } = makeDb();
    const ctx = { db, deviceId: 'dev-A' };
    registerSystemHandlers(ctx as never);
    await registered.get('system:completeOnboarding')!(ctx, setup('Owner pass 1'));

    // What the till reads now: the answers, nothing built in.
    const read = Object.fromEntries(NEW_SHOP_KEYS.map((k) => [k, readShopSetting(db, k)]));
    for (const k of NEW_SHOP_KEYS) expect(read[k]).toMatchObject({ isDefault: false, newerFormat: false });
    expect(read['shop.profile']!.value).toEqual({
      v: 1,
      name: 'Test Pizza',
      tagline: 'Hot and fresh',
      phone: { display: '0300 1112233', e164: '+923001112233' },
      whatsappLines: [{ display: '0321 4445566', e164: '+923214445566' }],
      address: { street: 'Plot 9, Test Street, Test Block 2', areaLine: 'Test Town, Karachi', postalCode: '75999' },
      socialLinks: [],
      priceRange: 'PKR 100–900',
    });
    // Monday first, each once — whatever order they came in.
    expect(read['shop.hours']!.value).toEqual({ v: 1, opens: '12:00', closes: '00:00', days: ['tue', 'wed', 'thu', 'fri', 'sat', 'sun'] });
    expect(read['shop.website']!.value).toEqual({
      v: 1,
      whatsappGreeting: "Hi Test Pizza! I'd like to place an order: ",
      doorPayments: ['cash'],
      pickupPayments: ['cash'],
      allergyNotice: DEFAULT_SHOP_WEBSITE.allergyNotice,
    });
    expect(read['website.home']!.value).toEqual(NOTHING_FEATURED);
    // Pick-up not offered: no % (the 15 typed into the hidden box goes), never on a delivery.
    expect(read['discounts.websitePickup']!.value).toEqual({ v: 2, offered: false, percent: 0, alsoDelivery: false });
    expect(readShopSetting(db, 'delivery.zones').value.zones).toEqual([]);

    // Each one a business row with its sync entry and its audit row (the repositories rule).
    for (const k of NEW_SHOP_KEYS) {
      const id = businessSettingId(k);
      expect(Number(raw.prepare(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'business_settings' AND entity_id = ?`).get(id)?.n)).toBe(1);
      expect(Number(raw.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'business_settings' AND entity_id = ? AND action = 'create'`).get(id)?.n)).toBe(1);
    }

    // The sign-in screen names the shop as the website does.
    expect(await registered.get('system:getBranding')!(ctx, undefined)).toMatchObject({ ok: true, data: { shopName: 'Test Pizza' } });

    // The shop block goes from the first publish, passes the website's check — and names nothing of the first shop's.
    const shop = shopBlockFor(db, 'dev-A');
    expect(shop.problem).toBeNull();
    expect(shop.block).not.toBeNull();
    expect(publishedShopSchema.safeParse(shop.block).success).toBe(true);
    expect(shop.block!.home).toEqual({ pizzas: [], burger: null, deals: [] });
    expect(shop.block!.hours).not.toMatchObject({ opens: DEFAULT_SHOP_HOURS.opens, closes: DEFAULT_SHOP_HOURS.closes });
    const said = JSON.stringify(shop.block).toLowerCase();
    const words = await firstShopWords();
    for (const word of words) expect(said, word).not.toContain(word.toLowerCase());
    // The check finds every one of them in the first shop's own block — so finding none above means something.
    const { buildShopBlock } = await import('@cheeseoclock/pos-domain');
    const { DEFAULT_SHOP_PROFILE, DEFAULT_WEBSITE_HOME } = await import('@cheeseoclock/shared-types');
    const firstShops = JSON.stringify(
      buildShopBlock({
        profile: DEFAULT_SHOP_PROFILE,
        hours: DEFAULT_SHOP_HOURS,
        website: DEFAULT_SHOP_WEBSITE,
        home: DEFAULT_WEBSITE_HOME,
        stamps: [{ version: 1, updatedAt: '2026-10-20T00:00:00.000Z' }, null, null, null],
        deviceId: 'dev-A',
      }),
    ).toLowerCase();
    for (const word of words) expect(firstShops, word).toContain(word.toLowerCase());

    // The settings block carries the shop's own pick-up answer (off) and no areas — never 10% off and Karachi's
    // list. (The website takes a settings block once it names an area: until the owner saves one, a publish
    // goes without it, as it always has for a till with none.)
    const settings = settingsBlockFor(db, NO_MENU as never, 'dev-A');
    expect(settings.problem).toBeNull();
    expect(settings.block).toMatchObject({ pickup: { offered: false, percent: 0 }, zones: [] });
  });

  it('pick-up offered at setup goes as answered; the Karachi preset is still the owner’s pick', async () => {
    const { registerSystemHandlers } = await import('./system-handlers.js');
    const { readShopSetting } = await import('../../db/business-settings-read.js');
    const { db } = makeDb();
    const ctx = { db, deviceId: 'dev-A' };
    registerSystemHandlers(ctx as never);
    await registered.get('system:completeOnboarding')!(
      ctx,
      setup('Owner pass 1', { website: { ...WEBSITE, whatsapp: '', pickup: { offered: true, percent: 5 } }, deliveryAreas: 'karachi-dha-clifton' }),
    );
    expect(readShopSetting(db, 'discounts.websitePickup').value).toEqual({ v: 2, offered: true, percent: 5, alsoDelivery: false });
    // No WhatsApp number typed: the call line is the WhatsApp line.
    expect(readShopSetting(db, 'shop.profile').value.whatsappLines).toEqual([{ display: '0300 1112233', e164: '+923001112233' }]);
    expect(readShopSetting(db, 'delivery.zones').value.zones.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!Sqlite)('the first shop’s tills (set up before the Website step): exactly what they read before', () => {
  it('every one of the five reads its built-in default, and neither block goes until the owner saves a card', async () => {
    const { readShopSetting } = await import('../../db/business-settings-read.js');
    const { shopBlockFor } = await import('../../services/website-shop-block.js');
    const { settingsBlockFor } = await import('../../services/website-settings-block.js');
    const { NEW_SHOP_KEYS, SHOP_SETTING_DEFAULTS } = await import('@cheeseoclock/shared-types');
    const { raw, db } = makeDb();
    const T0 = '2026-01-01T00:00:00.000Z';
    // An owner made by an older setup: no website details, no delivery areas stored.
    raw
      .prepare(`INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES ('u_owner', 'Test Owner', 'x', 'admin', ?, ?, 'dev-A')`)
      .run(T0, T0);
    for (const k of NEW_SHOP_KEYS) {
      expect(readShopSetting(db, k)).toMatchObject({ isDefault: true, value: SHOP_SETTING_DEFAULTS[k] });
    }
    expect(shopBlockFor(db, 'dev-A')).toMatchObject({ block: null, problem: null, stamp: { shopRev: 0 } });
    expect(settingsBlockFor(db, NO_MENU as never, 'dev-A')).toMatchObject({ block: null, problem: null, stamp: { settingsRev: 0 } });
  });
});
