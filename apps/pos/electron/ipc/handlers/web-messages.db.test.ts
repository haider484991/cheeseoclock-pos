/**
 * Settings → Online orders: the website's messages and its smallest
 * delivery order (Settings sweep B1; 'online.options' format 2, v0.7.30).
 * Through the real settings handlers and repositories on a real SQLite
 * database built from every migration:
 *   - the owner alone saves them (settings.manage); a manager or a cashier
 *     is refused and nothing is written;
 *   - the bounds are the main process's: 160 / 120 letters, one line of
 *     plain words, Rs 0–5,000 in whole rupees, an announcement with words;
 *     only this version's format, nothing unknown;
 *   - a value v0.7.29 saved (format 1: "publish by itself" only) reads with
 *     the messages at today's defaults, is the default when it says what the
 *     default says, and is saved again as format 2 with its answer kept;
 *   - a newer version's value is read-only here and never saved over;
 *   - a message whose last day has passed still reads (it is only not in
 *     force), and a broken message never takes "publish by itself" with it.
 *
 * Only `defineHandler` (captured) and the signed-in session are stood in
 * for. node's own `node:sqlite` stands in for better-sqlite3; skipped where
 * it is missing. Every word, id and amount is made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ONLINE_OPTIONS,
  type AuthenticatedUser,
  type OnlineOptions,
  type ShopSettingCard,
  type UUID,
} from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../../db/connection.js';
import { DatabaseSync, openMigrated } from '../../db/costing-shop.fixture.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Handler = (ctx: unknown, payload: unknown) => unknown;
const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown, payload: unknown) => unknown>(),
  session: null as unknown,
  websiteChanged: 0,
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
vi.mock('electron-log/main', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {} },
}));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '', getVersion: () => '0.0.0-test' },
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock('../../services/auth-service.js', () => ({
  getCurrentSession: () => h.session,
}));
// The word to the web bridge (a Save the website needs): counted, nothing sent.
vi.mock('../../services/website-settings-events.js', () => ({
  websiteSettingsChanged: () => {
    h.websiteChanged += 1;
  },
  onWebsiteSettingsChanged: () => () => {},
}));

const live = describe.skipIf(!DatabaseSync);

const DEV = 'dev-till-1';
const T0 = '2026-01-01T00:00:00.000Z';
const session = (id: string, role: AuthenticatedUser['role']): AuthenticatedUser => ({
  id: id as UUID,
  fullName: id,
  role,
  sessionId: 'sess' as UUID,
});
const CASHIER = session('u_cash', 'cashier');
const MANAGER = session('u_mgr', 'manager');
const OWNER = session('u_admin', 'admin');

type Db = ReturnType<typeof openMigrated>;
let db: Db;

type Outcome = { ok: true; data: unknown } | { ok: false; code: string; message: string };
async function call(channel: string, payload?: unknown): Promise<Outcome> {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`No handler for ${channel}`);
  try {
    const r = (await fn({ db, deviceId: DEV }, payload)) as
      | { ok: true; data: unknown }
      | { ok: false; error: { code: string; message: string } };
    return r.ok ? { ok: true, data: r.data } : { ok: false, code: r.error.code, message: r.error.message };
  } catch (e) {
    const api = (e as { apiError?: { code: string; message: string } }).apiError;
    if (api) return { ok: false, code: api.code, message: api.message };
    return { ok: false, code: 'threw', message: e instanceof Error ? e.message : String(e) };
  }
}
async function card(): Promise<ShopSettingCard<'online.options'>> {
  const o = await call('settings:getBusiness', { key: 'online.options' });
  if (!o.ok) throw new Error(`refused: ${o.message}`);
  return o.data as ShopSettingCard<'online.options'>;
}
const save = (value: unknown) => call('settings:setBusiness', { key: 'online.options', value });
const stored = () =>
  db.prepare(`SELECT value_json, version FROM business_settings WHERE key = 'online.options' AND deleted_at IS NULL`).get() as
    | { value_json: string; version: number }
    | undefined;
/** A row as another till (or an older version) left it: written straight into the table, as the link would. */
function rawRow(value: unknown, version = 1): void {
  db.prepare(
    `INSERT INTO business_settings (id, key, value_json, updated_by_user_id, created_at, updated_at, device_id, version)
     VALUES (?, 'online.options', ?, 'u_admin', ?, ?, 'dev-till-2', ?)`,
  ).run(onlineOptionsId(), JSON.stringify(value), T0, T0, version);
}
let onlineOptionsId: () => string;

/** A whole format-2 value (made-up words), with `over` on top. */
const v2 = (over: Partial<OnlineOptions> = {}): OnlineOptions => ({
  v: 2,
  autoPublishMenu: false,
  closedNotice: { text: 'Closed for a made-up holiday — back on Monday', until: '2026-10-03' },
  announcement: { on: true, text: 'New: a made-up pizza' },
  minDeliveryOrderCents: 100_000,
  ...over,
});

beforeEach(async () => {
  if (!DatabaseSync) return;
  h.handlers.clear();
  h.session = null;
  h.websiteChanged = 0;
  db = openMigrated({});
  const user = db.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, ?)`,
  );
  user.run('u_admin', 'Test Owner', 'admin', T0, T0, DEV);
  user.run('u_cash', 'Test Cashier', 'cashier', T0, T0, DEV);
  user.run('u_mgr', 'Test Manager', 'manager', T0, T0, DEV);
  const { businessSettingId } = await import('../../db/business-settings-ids.js');
  onlineOptionsId = () => businessSettingId('online.options');
  (await import('./settings-handlers.js')).registerSettingsHandlers({ db, deviceId: DEV } as never);
});

live('the owner alone saves the website messages', () => {
  it('nothing saved: today’s website — no notice, no announcement, no smallest order — and the card says Default', async () => {
    h.session = OWNER;
    const c = await card();
    expect(c.value).toEqual(DEFAULT_ONLINE_OPTIONS);
    expect(c).toMatchObject({ isDefault: true, readOnly: false, lastChanged: null });
    const { readOnlineOptions } = await import('../../db/business-settings-read.js');
    expect(readOnlineOptions(db as AppDatabase)).toEqual(DEFAULT_ONLINE_OPTIONS);
  });

  it('the owner saves them (the web bridge is told: the block goes alone); a manager or a cashier is refused and nothing is written', async () => {
    for (const who of [MANAGER, CASHIER]) {
      h.session = who;
      expect(await save(v2())).toMatchObject({ ok: false, code: 'forbidden' });
      expect(await call('settings:getBusiness', { key: 'online.options' })).toMatchObject({ ok: false, code: 'forbidden' });
      expect(await call('settings:setBusiness', { key: 'online.options', useDefault: true })).toMatchObject({ ok: false, code: 'forbidden' });
    }
    expect(stored()).toBeUndefined();
    expect(h.websiteChanged).toBe(0);
    h.session = OWNER;
    const saved = await save(v2());
    expect(saved).toMatchObject({ ok: true });
    expect(JSON.parse(stored()!.value_json)).toEqual(v2());
    expect(h.websiteChanged).toBe(1);
    expect(await card()).toMatchObject({ value: v2(), isDefault: false });
    // Row, sync entry and audit row together (the repositories rule).
    const id = onlineOptionsId();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_id = ?`).get(id)).toEqual({ n: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ?`).get(id)).toEqual({ n: 1 });
  });

  it('the words are trimmed by the card, never here: spaces at the ends are refused, as is anything but this version’s whole value', async () => {
    h.session = OWNER;
    for (const [what, value] of [
      ['spaces at the ends', v2({ closedNotice: { text: ' Closed ', until: null } })],
      ['format 1', { v: 1, autoPublishMenu: true }],
      ['format 1 with the fields', { ...v2(), v: 1 }],
      ['a newer format', { ...v2(), v: 3 }],
      ['an unknown field', { ...v2(), colour: 'red' }],
      ['an unknown notice field', v2({ closedNotice: { text: 'Closed', until: null, colour: 'red' } as never })],
      ['a missing field', { v: 2, autoPublishMenu: false }],
    ] as const) {
      expect({ what, o: await save(value) }).toMatchObject({ what, o: { ok: false, code: 'validation_failed' } });
    }
    expect(stored()).toBeUndefined();
  });
});

live('the bounds, in the main process', () => {
  const refused = async (value: unknown, message: RegExp) => {
    h.session = OWNER;
    const o = await save(value);
    expect(o).toMatchObject({ ok: false, code: 'validation_failed' });
    expect(o.ok ? '' : o.message).toMatch(message);
  };

  it('the closed notice: 160 letters at most, one line of plain words — a line break, a tab, a control character, a line separator or a direction mark is refused', async () => {
    h.session = OWNER;
    expect(await save(v2({ closedNotice: { text: 'x'.repeat(160), until: null } }))).toMatchObject({ ok: true });
    await refused(v2({ closedNotice: { text: 'x'.repeat(161), until: null } }), /160 letters/);
    const B = String.fromCharCode;
    for (const bad of [`Closed${B(10)}today`, `Closed${B(9)}today`, `Closed${B(0)}today`, `Closed${B(0x7f)}`, `Closed${B(0x2028)}today`, `${B(0x202e)}Closed`]) {
      await refused(v2({ closedNotice: { text: bad, until: null } }), /one line of plain words/);
    }
    // Urdu, dashes and quotes are plain words.
    expect(await save(v2({ closedNotice: { text: 'عید مبارک — “closed”', until: null } }))).toMatchObject({ ok: true });
  });

  it('the Arabic letter mark and the invisible characters are refused anywhere in the notice or the announcement (the website’s rule); Urdu still saves', async () => {
    h.session = OWNER;
    const B = String.fromCharCode;
    for (const code of [0x061c, 0x200b, 0x200c, 0x200d, 0x2060, 0x2064, 0xfeff]) {
      for (const bad of [`Closed${B(code)}today`, `${B(code)}Closed`, `Closed${B(code)}`]) {
        await refused(v2({ closedNotice: { text: bad, until: null } }), /one line of plain words/);
        await refused(v2({ announcement: { on: true, text: bad } }), /one line of plain words/);
      }
    }
    expect(await save(v2({ announcement: { on: true, text: 'نیا ریپ — اس ہفتے' } }))).toMatchObject({ ok: true });
  });

  it('its last day is a real calendar day or none; a day already past is not the schema’s business (the card checks it when it is typed)', async () => {
    h.session = OWNER;
    await refused(v2({ closedNotice: { text: 'Closed', until: '2026-02-30' } }), /real date/);
    await refused(v2({ closedNotice: { text: 'Closed', until: '3 Oct' } }), /Pick a day/);
    expect(await save(v2({ closedNotice: { text: 'Closed', until: '2020-01-01' } }))).toMatchObject({ ok: true });
    expect((await card()).value.closedNotice).toEqual({ text: 'Closed', until: '2020-01-01' });
  });

  it('the announcement: 120 letters at most, one line, and words while it is on', async () => {
    h.session = OWNER;
    expect(await save(v2({ announcement: { on: true, text: 'x'.repeat(120) } }))).toMatchObject({ ok: true });
    await refused(v2({ announcement: { on: true, text: 'x'.repeat(121) } }), /120 letters/);
    await refused(v2({ announcement: { on: true, text: '' } }), /Type the announcement, or switch it off/);
    await refused(v2({ announcement: { on: true, text: `New${String.fromCharCode(10)}pizza` } }), /one line/);
    // Off with words kept (they come back when it is switched on again): fine.
    expect(await save(v2({ announcement: { on: false, text: 'New: a made-up pizza' } }))).toMatchObject({ ok: true });
  });

  it('the smallest delivery order: whole rupees from Rs 0 to Rs 5,000', async () => {
    h.session = OWNER;
    for (const ok of [0, 100, 500_000]) expect(await save(v2({ minDeliveryOrderCents: ok }))).toMatchObject({ ok: true });
    await refused(v2({ minDeliveryOrderCents: 500_100 }), /at most Rs 5,000/);
    await refused(v2({ minDeliveryOrderCents: 100_050 }), /whole rupees/);
    await refused(v2({ minDeliveryOrderCents: -100 }), /below Rs 0/);
    await refused(v2({ minDeliveryOrderCents: 1.5 }), /whole rupees/);
  });
});

live('a value v0.7.29 saved (format 1), and one a newer version saved', () => {
  it('format 1 reads with the messages at today’s defaults; with “publish by itself” off it IS the default, not read-only', async () => {
    rawRow({ v: 1, autoPublishMenu: false });
    h.session = OWNER;
    const c = await card();
    expect(c.value).toEqual({ ...DEFAULT_ONLINE_OPTIONS, v: 1 });
    expect(c).toMatchObject({ isDefault: true, readOnly: false });
    const { readOnlineOptions } = await import('../../db/business-settings-read.js');
    expect(readOnlineOptions(db as AppDatabase)).toMatchObject({
      autoPublishMenu: false,
      closedNotice: { text: '', until: null },
      announcement: { on: false, text: '' },
      minDeliveryOrderCents: 0,
    });
  });

  it('format 1 with “publish by itself” on keeps it on; saving the messages writes format 2 and keeps the answer', async () => {
    rawRow({ v: 1, autoPublishMenu: true });
    h.session = OWNER;
    expect((await card()).value).toMatchObject({ v: 1, autoPublishMenu: true, minDeliveryOrderCents: 0 });
    // What the messages card sends: the whole value in this version's format, the other card's answer as saved.
    expect(await save(v2({ autoPublishMenu: true }))).toMatchObject({ ok: true });
    expect(JSON.parse(stored()!.value_json)).toMatchObject({ v: 2, autoPublishMenu: true, minDeliveryOrderCents: 100_000 });
    expect(stored()!.version).toBe(2);
  });

  it('a newer version’s value (a higher format, or a field this one does not know — in the notice too) is read-only here and never saved over', async () => {
    for (const newer of [
      { ...v2(), v: 3 },
      { ...v2(), openingHours: [] },
      v2({ closedNotice: { text: 'Closed', until: null, from: '2026-10-01' } as never }),
    ]) {
      db.prepare(`DELETE FROM business_settings`).run();
      rawRow(newer, 4);
      h.session = OWNER;
      const c = await card();
      expect(c).toMatchObject({ readOnly: true, isDefault: false });
      // What this version knows of it is used.
      expect(c.value.announcement).toEqual({ on: true, text: 'New: a made-up pizza' });
      expect(await save(v2())).toMatchObject({ ok: false, code: 'validation_failed', message: expect.stringMatching(/newer version/) });
      expect(JSON.parse(stored()!.value_json)).toEqual(newer);
    }
  });

  it('a message that does not read (a hand edit, a changed shape) falls back to its default ALONE: “publish by itself” and the rest are kept', async () => {
    rawRow({ v: 2, autoPublishMenu: true, closedNotice: 'Closed', announcement: { on: true, text: 'New: a made-up pizza' }, minDeliveryOrderCents: 12.5 });
    h.session = OWNER;
    const { readOnlineOptions } = await import('../../db/business-settings-read.js');
    expect(readOnlineOptions(db as AppDatabase)).toEqual({
      v: 2,
      autoPublishMenu: true,
      closedNotice: { text: '', until: null },
      announcement: { on: true, text: 'New: a made-up pizza' },
      minDeliveryOrderCents: 0,
    });
  });
});
