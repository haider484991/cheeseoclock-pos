/**
 * The till's side of the menu files from the costing PC (v0.7.32;
 * menu-package-service.ts), against a real database from every migration and
 * the stand-in website (menu-deploy-website.fixture.ts) on a clock the test
 * moves:
 *   - by itself: claim → a backup copy BEFORE anything changes → the same
 *     import as Menu → Import → reported with its counts → the menu sent to
 *     the website once;
 *   - "Wait for my OK": nothing goes in until the owner taps; said once;
 *   - the link off (own scope), a broken link, a file too new for the till,
 *     a damaged file, a refused file (never tried again), an import that
 *     keeps failing (never a tight loop: a handful of claims an hour, then
 *     it stops), a failed backup (nothing imported), an older website (a
 *     look an hour later), a report lost after the import (said again, never
 *     imported twice), a till that stopped halfway (never taken over by
 *     itself), the counter busy a moment ago, and two looks at once.
 * EVERY MENU IS MADE UP.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MENU_DEPLOY_MAX_ATTEMPTS } from '@cheeseoclock/shared-types';
import { DatabaseSync } from '../db/costing-shop.fixture.js';
import { linkOn, openTill, push } from '../db/two-tills.fixture.js';
import type { AppDatabase } from '../db/connection.js';
import { FakeMenuWebsite, madeUpMenu, type Clock } from './menu-deploy-website.fixture.js';
import { menuRows, orderRungUp, serviceTill } from './menu-package-till.fixture.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getVersion: () => '0.0.0-test' },
  dialog: {},
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false },
}));

const live = describe.skipIf(!DatabaseSync);
const T0 = Date.parse('2026-09-29T09:00:00.000Z');
const MIN = 60_000;

afterEach(() => {
  vi.useRealTimers();
});

function setup(opts: { link?: 'on' | 'off'; db?: AppDatabase } = {}) {
  const clock: Clock = { t: T0 };
  const website = new FakeMenuWebsite(clock);
  const till = serviceTill('till-1', website, clock, opts);
  return { clock, website, till };
}

/** The menu import's own audit rows (Menu → Import and the costing PC's alike). */
const imports = (db: AppDatabase) => Number((db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'menu_import'`).get() as { n: number }).n);

/** The till keeps the link fresh (the sync worker's last pass) as the clock moves. */
function tick(c: { clock: Clock; till: { db: AppDatabase } }, ms: number) {
  c.clock.t += ms;
  linkOn(c.till.db, c.clock.t);
}

live('by itself (the default)', () => {
  it('claim → backup copy first → the import → reported with its counts → the menu sent to the website once', async () => {
    const c = setup();
    const p = c.website.upload(madeUpMenu('one'));
    let rowsAtBackup: number | null = null;
    c.till.onBackup.fn = () => {
      rowsAtBackup = menuRows(c.till.db).items;
    };
    const v = await c.till.service.checkNow();
    expect(v.phase).toBe('applied');
    // The backup was made before anything changed.
    expect(rowsAtBackup).toBe(0);
    expect(c.till.steps).toEqual(['backup', 'publish']);
    expect(menuRows(c.till.db).items).toBe(2);
    expect(c.website.claims()).toHaveLength(1);
    expect(c.website.reports('applied')).toHaveLength(1);
    expect(c.website.reports('applied')[0]!.body).toMatchObject({
      scope: 'shared',
      counts: { newItems: 2, newIngredients: 2, newCategories: 2, choiceGroupsChanged: 1 },
    });
    expect(c.website.byId(p.id)).toMatchObject({ state: 'applied', appliedBy: 'till-1' });
    // The note for the people who manage the menu: once, with the counts.
    const notices = c.till.emits.map((e) => e.notice).filter(Boolean);
    expect(notices).toEqual([expect.objectContaining({ kind: 'applied', title: 'New menu put in from the costing file' })]);
    expect(notices[0]!.description).toContain('2 new items');
    // Another look changes nothing and says nothing more.
    tick(c, 3 * MIN);
    await c.till.service.checkNow();
    expect(c.website.claims()).toHaveLength(1);
    expect(c.website.reports('applied')).toHaveLength(1);
    expect(c.till.emits.map((e) => e.notice).filter(Boolean)).toHaveLength(1);
    expect(c.till.steps).toEqual(['backup', 'publish']);
  });

  it('the view says what came in, by itself, and where from — never the file', async () => {
    const c = setup();
    c.website.upload(madeUpMenu('one'));
    const v = await c.till.service.checkNow();
    expect(v).toMatchObject({
      websiteLinked: true,
      scope: 'shared',
      mode: 'auto',
      package: { seq: 1, fileName: 'test-menu-import.json', itemCount: 2, ingredientCount: 2, formatVersion: 3, state: 'applied' },
      appliedHere: { seq: 1, automatic: true, byThisTill: true, counts: { newItems: 2 } },
      canApplyNow: false,
    });
    expect(JSON.stringify(v)).not.toMatch(/Test Margherita|110000|contentGz/);
  });
});

live('"Wait for my OK"', () => {
  it('no claim, said once over three looks; the owner’s tap puts it in', async () => {
    const c = setup();
    const { setBusinessSetting } = await import('../db/repositories/business-settings-repo.js');
    setBusinessSetting(c.till.db, 'menu.autoUpdate', { v: 1, mode: 'ask' }, { userId: 'u_admin', deviceId: 'till-1' });
    const p = c.website.upload(madeUpMenu('one'));
    for (let i = 0; i < 3; i++) {
      const v = await c.till.service.checkNow();
      expect(v).toMatchObject({ phase: 'waiting_for_owner', canApplyNow: true, applyNeedsOwner: false });
      tick(c, 3 * MIN);
    }
    expect(c.website.claims()).toHaveLength(0);
    expect(c.website.reports('waiting_for_owner')).toHaveLength(1);
    expect(menuRows(c.till.db).items).toBe(0);
    expect(c.till.emits.map((e) => e.notice?.kind).filter(Boolean)).toEqual(['waiting_for_owner']);
    // The preview is the normal one, never a fresh start; it changes nothing.
    const preview = await c.till.service.preview(p.id);
    expect(preview).toMatchObject({ packageId: p.id, fresh: null, summary: { newItems: 2 } });
    expect(menuRows(c.till.db).items).toBe(0);
    expect(c.website.claims()).toHaveLength(0);
    // The owner's tap: the same import, by the owner.
    const sum = await c.till.service.apply(p.id, { userId: 'u_admin', deviceId: 'till-1' });
    expect(sum.newItems).toBe(2);
    expect(menuRows(c.till.db).items).toBe(2);
    const audit = c.till.db.prepare(`SELECT actor_user_id, after_json FROM audit_log WHERE entity_type = 'menu_import'`).get() as {
      actor_user_id: string;
      after_json: string;
    };
    expect(audit.actor_user_id).toBe('u_admin');
    expect(JSON.parse(audit.after_json)).toMatchObject({ fresh: false, package: { id: p.id, automatic: false } });
    expect(c.till.steps).toEqual(['backup', 'publish']);
    // The owner who tapped hears it from Menu → Import: no second "New menu put in" note.
    expect(c.till.emits.map((e) => e.notice?.kind).filter(Boolean)).toEqual(['waiting_for_owner']);
  });
});

live('where the till stands decides', () => {
  it('the link off: this till puts it in for itself (own scope); the website’s state is not the till’s to change', async () => {
    const c = setup({ link: 'off' });
    const p = c.website.upload(madeUpMenu('one'));
    const v = await c.till.service.checkNow();
    expect(v).toMatchObject({ phase: 'applied', scope: 'own' });
    expect(c.website.claims()[0]!.body).toMatchObject({ scope: 'own', lastPackageSeq: null });
    expect(c.website.byId(p.id)!.state).toBe('pending');
    expect(c.website.reports('applied')[0]!.body).toMatchObject({ scope: 'own' });
    // Said once.
    c.clock.t += 20 * MIN;
    await c.till.service.checkNow();
    expect(c.website.reports('applied')).toHaveLength(1);
    expect(c.website.claims()).toHaveLength(1);
  });

  it('a broken link: no claim (both tills must end with the same menu)', async () => {
    const c = setup();
    c.website.upload(madeUpMenu('one'));
    // The last sync pass was an hour ago: the link is stale.
    c.clock.t += 60 * MIN;
    const v = await c.till.service.checkNow();
    expect(v.phase).toBe('waiting_link');
    expect(c.website.claims()).toHaveLength(0);
    // Paused counts as broken too.
    linkOn(c.till.db, c.clock.t, { paused: true });
    expect((await c.till.service.checkNow()).phase).toBe('waiting_link');
    expect(c.website.claims()).toHaveLength(0);
  });

  it('a file newer than this till reads: never downloaded, "update the till", said once', async () => {
    const c = setup();
    c.website.upload(madeUpMenu('v4', { version: 4 }));
    for (let i = 0; i < 3; i++) {
      const v = await c.till.service.checkNow();
      expect(v.phase).toBe('too_old');
      expect(v.message).toContain('format 4; this till reads up to 3');
      expect(v.message).toContain('Update the till');
      tick(c, 3 * MIN);
    }
    expect(c.website.claims()).toHaveLength(0);
    expect(c.website.callsTo(/\/content$/)).toHaveLength(0);
    expect(c.website.reports('too_old')).toHaveLength(1);
    expect(c.website.reports('too_old')[0]!.body).toMatchObject({ formatVersion: 4, maxFormatVersion: 3 });
    expect(c.till.emits.map((e) => e.notice?.kind).filter(Boolean)).toEqual(['problem']);
  });

  it('an order rung up a minute ago: no claim; three minutes later it goes in', async () => {
    const c = setup();
    c.website.upload(madeUpMenu('one'));
    orderRungUp(c.till.db, 'till-1', c.clock.t - MIN);
    expect((await c.till.service.checkNow()).phase).toBe('waiting_quiet');
    expect(c.website.claims()).toHaveLength(0);
    tick(c, 3 * MIN);
    expect((await c.till.service.checkNow()).phase).toBe('applied');
    expect(c.website.claims()).toHaveLength(1);
  });

  it('two looks at once make ONE claim', async () => {
    const c = setup();
    c.website.upload(madeUpMenu('one'));
    await Promise.all([c.till.service.checkNow(), c.till.service.checkNow(), c.till.service.checkNow()]);
    expect(c.website.claims()).toHaveLength(1);
    expect(imports(c.till.db)).toBe(1);
  });

  it('another till stopped halfway (its claim ran out): stalled — never taken over by itself', async () => {
    const c = setup();
    const p = c.website.upload(madeUpMenu('one'));
    Object.assign(c.website.byId(p.id)!, { state: 'claimed', claimedBy: 'till-2', claimedAt: c.clock.t, leaseUntil: c.clock.t + 10 * MIN });
    expect((await c.till.service.checkNow()).phase).toBe('other_till');
    tick(c, 11 * MIN);
    const v = await c.till.service.checkNow();
    expect(v).toMatchObject({ phase: 'stalled', canApplyNow: true, applyNeedsOwner: true });
    expect(v.message).toContain('doubled items');
    tick(c, 20 * MIN);
    await c.till.service.checkNow();
    expect(c.website.claims()).toHaveLength(0);
    expect(menuRows(c.till.db).items).toBe(0);
    // The owner's take-over (the handler asks for the owner's login): it goes in, and the website says who took it.
    await c.till.service.apply(p.id, { userId: 'u_admin', deviceId: 'till-1' }, { takeOver: true });
    expect(menuRows(c.till.db).items).toBe(2);
    expect(c.website.events.map((e) => e.kind)).toContain('taken_over');
  });
});

live('when it goes wrong: said, never a tight loop', () => {
  it('a damaged file (its checksum): failed and reported, nothing imported, tried again only after the back-off', async () => {
    const c = setup();
    const p = c.website.upload(madeUpMenu('one'));
    c.website.byId(p.id)!.sha256 = 'f'.repeat(64);
    const v = await c.till.service.checkNow();
    expect(v.phase).toBe('failed');
    expect(v.lastError).toContain('checksum');
    expect(menuRows(c.till.db).items).toBe(0);
    expect(c.till.steps).toEqual([]);
    expect(c.website.reports('failed')[0]!.body).toMatchObject({ retryable: true });
    // Straight away: no second claim.
    tick(c, 10_000);
    await c.till.service.checkNow();
    expect(c.website.claims()).toHaveLength(1);
  });

  it('a file its full check refuses: refused, reported, never tried again', async () => {
    const c = setup();
    const bad = madeUpMenu('bad');
    (bad['items'] as Array<Record<string, unknown>>)[0]!['category'] = 'No Such Category';
    c.website.upload(bad);
    const v = await c.till.service.checkNow();
    expect(v.phase).toBe('refused');
    expect(v.message).toContain('which the file does not list');
    expect(c.website.reports('refused')).toHaveLength(1);
    expect(c.website.latest()!.state).toBe('refused');
    for (let i = 0; i < 5; i++) {
      tick(c, 20 * MIN);
      expect((await c.till.service.checkNow()).phase).toBe('refused');
    }
    expect(c.website.claims()).toHaveLength(1);
    expect(c.till.steps).toEqual([]);
    expect(c.till.emits.map((e) => e.notice?.kind).filter(Boolean)).toEqual(['problem']);
  });

  it('an import that keeps failing: at most a handful of claims in an hour, then it stops for the owner’s "Try again"', async () => {
    const c = setup();
    // The database refuses every new menu item (standing in for anything that throws inside the import).
    c.till.db.exec(`CREATE TRIGGER test_refuse_items BEFORE INSERT ON menu_items BEGIN SELECT RAISE(ABORT, 'Test: the database said no'); END;`);
    const p = c.website.upload(madeUpMenu('one'));
    for (let minute = 0; minute < 60; minute++) {
      await c.till.service.checkNow();
      tick(c, MIN);
    }
    expect(c.website.claims().length).toBeLessThanOrEqual(6);
    expect(c.website.claims()).toHaveLength(MENU_DEPLOY_MAX_ATTEMPTS);
    expect(c.website.reports('failed')).toHaveLength(MENU_DEPLOY_MAX_ATTEMPTS);
    expect(c.website.byId(p.id)!.state).toBe('failed');
    const v = await c.till.service.checkNow();
    expect(v).toMatchObject({ phase: 'gave_up', canApplyNow: true });
    expect(v.message).toContain('Nothing was changed');
    expect(menuRows(c.till.db).items).toBe(0);
    // No import audit row: every try rolled back whole.
    expect(imports(c.till.db)).toBe(0);
    // "Try again" once the owner fixed it.
    c.till.db.exec(`DROP TRIGGER test_refuse_items`);
    await c.till.service.apply(p.id, { userId: 'u_admin', deviceId: 'till-1' }, { retry: true });
    expect(menuRows(c.till.db).items).toBe(2);
    expect(c.website.byId(p.id)!.state).toBe('applied');
  });

  it('the backup copy fails: nothing is imported, the try is counted', async () => {
    const c = setup();
    c.website.upload(madeUpMenu('one'));
    c.till.failBackup.next = true;
    const v = await c.till.service.checkNow();
    expect(v.phase).toBe('failed');
    expect(v.lastError).toContain('backup copy could not be made first');
    expect(menuRows(c.till.db).items).toBe(0);
    expect(imports(c.till.db)).toBe(0);
    expect(c.website.reports('failed')).toHaveLength(1);
    // After the back-off it goes in.
    tick(c, 2 * MIN);
    expect((await c.till.service.checkNow()).phase).toBe('applied');
  });

  it('a website older than this: nothing to do, and the next look is an hour away', async () => {
    const c = setup();
    c.website.old = true;
    c.till.service.start();
    try {
      const v = await c.till.service.checkNow();
      expect(v.phase).toBe('website_old');
      expect(Date.parse(v.nextCheckAt!) - c.clock.t).toBeGreaterThanOrEqual(60 * MIN);
    } finally {
      c.till.service.stop();
    }
  });

  it('on its own: the first look 30 s after start, then every few minutes; a setting from the other till looks 5 s later; stop stops', async () => {
    const c = setup();
    const { nudgeMenuDeploy } = await import('./menu-deploy-events.js');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    c.till.service.start();
    try {
      c.website.upload(madeUpMenu('one'));
      await vi.advanceTimersByTimeAsync(29_000);
      expect(c.website.callsTo(/menu-deploy$/)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(c.website.claims()).toHaveLength(1));
      await vi.waitFor(() => expect(c.till.service.view().nextCheckAt).not.toBeNull());
      // "Accept online orders" on: about 3 minutes (±20%; the test's spread is the middle).
      expect(Date.parse(c.till.service.view().nextCheckAt!) - c.clock.t).toBe(3 * MIN);
      const looks = c.website.callsTo(/menu-deploy$/).length;
      nudgeMenuDeploy();
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(c.website.callsTo(/menu-deploy$/).length).toBe(looks + 1));
      // A look that joins the owner's tap still leaves the next one scheduled.
      await vi.waitFor(() => expect(c.till.service.view().nextCheckAt).not.toBeNull());
      c.till.service.stop();
      expect(c.till.service.view().nextCheckAt).toBeNull();
      await vi.advanceTimersByTimeAsync(60 * MIN);
      expect(c.website.callsTo(/menu-deploy$/).length).toBe(looks + 1);
    } finally {
      c.till.service.stop();
      vi.useRealTimers();
    }
  });

  it('a regular look that lands during the owner’s tap waits for it, looks no second time, and the next look is still scheduled', async () => {
    const c = setup();
    const { setBusinessSetting } = await import('../db/repositories/business-settings-repo.js');
    setBusinessSetting(c.till.db, 'menu.autoUpdate', { v: 1, mode: 'ask' }, { userId: 'u_admin', deviceId: 'till-1' });
    const p = c.website.upload(madeUpMenu('one'));
    let release: () => void = () => {};
    c.till.onBackup.fn = () => new Promise<void>((r) => (release = r));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    c.till.service.start();
    try {
      const tap = c.till.service.apply(p.id, { userId: 'u_admin', deviceId: 'till-1' });
      await vi.waitFor(() => expect(c.website.claims()).toHaveLength(1));
      const looks = c.website.callsTo(/menu-deploy$/).length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(c.till.service.view().nextCheckAt).toBeNull();
      release();
      await tap;
      await vi.waitFor(() => expect(c.till.service.view().nextCheckAt).not.toBeNull());
      // The look that waited did not go to the website again, nor claim again.
      expect(c.website.callsTo(/menu-deploy$/).length).toBe(looks);
      expect(c.website.claims()).toHaveLength(1);
      expect(menuRows(c.till.db).items).toBe(2);
    } finally {
      c.till.service.stop();
      vi.useRealTimers();
    }
  });

  it('the website out of reach: the gap doubles (up to 30 minutes)', async () => {
    const c = setup();
    c.website.down = true;
    c.till.service.start();
    try {
      const gaps: number[] = [];
      for (let i = 0; i < 5; i++) {
        const v = await c.till.service.checkNow();
        gaps.push(Date.parse(v.nextCheckAt!) - c.clock.t);
      }
      expect(gaps).toEqual([6 * MIN, 12 * MIN, 24 * MIN, 30 * MIN, 30 * MIN]);
    } finally {
      c.till.service.stop();
    }
  });

  it('the till stopped right after the import (its report lost): the next look says "applied" — never imported twice', async () => {
    const c = setup();
    const p = c.website.upload(madeUpMenu('one'));
    c.website.drop(/\/report$/);
    await c.till.service.checkNow();
    expect(menuRows(c.till.db).items).toBe(2);
    expect(c.website.byId(p.id)!.state).toBe('claimed');
    tick(c, 3 * MIN);
    const v = await c.till.service.checkNow();
    expect(v.phase).toBe('applied');
    expect(c.website.byId(p.id)).toMatchObject({ state: 'applied', appliedBy: 'till-1', result: { newItems: 2 } });
    expect(c.website.claims()).toHaveLength(1);
    expect(imports(c.till.db)).toBe(1);
  });

  it('a new service on the same till (a restart) after the import: the marker says it is in', async () => {
    const c = setup();
    c.website.upload(madeUpMenu('one'));
    await c.till.service.checkNow();
    const again = serviceTill('till-1', c.website, c.clock, { db: c.till.db });
    tick(c, 3 * MIN);
    expect((await again.service.checkNow()).phase).toBe('applied');
    expect(c.website.claims()).toHaveLength(1);
    expect(imports(c.till.db)).toBe(1);
  });
});

live('the upload key', () => {
  it('only its hash and last 4 characters reach the website; the key is stored nowhere on the till', async () => {
    const c = setup();
    const made = await c.till.service.createKey('u_admin');
    expect(made.key).toMatch(/^cocmenu_[A-Za-z0-9_-]{43}$/);
    expect(made.keyHint).toBe(made.key.slice(-4));
    const put = c.website.callsTo(/\/key$/)[0]!;
    expect(JSON.stringify(put.body)).not.toContain(made.key);
    expect(put.body).toMatchObject({ keyHint: made.keyHint, keyHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const everywhere = [
      ...(c.till.db.prepare(`SELECT value_json AS v FROM settings`).all() as Array<{ v: string }>).map((r) => r.v),
      ...(c.till.db.prepare(`SELECT before_json AS b, after_json AS a FROM audit_log`).all() as Array<{ b: string | null; a: string | null }>).flatMap((r) => [r.b ?? '', r.a ?? '']),
      ...(c.till.db.prepare(`SELECT payload_json AS p FROM sync_queue`).all() as Array<{ p: string }>).map((r) => r.p),
    ].join('\n');
    expect(everywhere).not.toContain(made.key);
    expect(everywhere).toContain(made.keyHint);
    // The view names the key by its last 4 characters only.
    const v = await c.till.service.checkNow();
    expect(v.key).toMatchObject({ keyHint: made.keyHint, madeOnThisTill: true });
    expect(JSON.stringify(v)).not.toContain(made.key);
  });

  it('a website that does not take it: nothing changes here, and the words say the old key still works', async () => {
    const c = setup();
    c.website.refuseNext(/\/key$/, 503);
    await expect(c.till.service.createKey('u_admin')).rejects.toThrow('The website did not take the new key — nothing changed; the old key still works.');
    expect(c.till.db.prepare(`SELECT COUNT(*) AS n FROM settings WHERE key = 'menuDeploy.keyInfo'`).get()).toMatchObject({ n: 0 });
  });

  it('no answer from the website (it may have saved the key after the till stopped waiting): never "the old key still works"', async () => {
    const c = setup();
    // The website did its work, and the answer was lost on the way back.
    c.website.drop(/\/key$/, { afterWork: true });
    const err = await c.till.service.createKey('u_admin').catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain('still works');
    expect((err as Error).message).toContain('the old key has stopped working: make a new key again');
    // It had: the old key is gone there — which is why the words must not promise otherwise.
    expect(c.website.key).not.toBeNull();
  });

  it('the website took the key but the till could not note it: the key is still shown (the costing PC would be locked out otherwise)', async () => {
    const c = setup();
    // Settings on this till refuse writes for a moment.
    c.till.db.exec(`CREATE TRIGGER no_key_note BEFORE INSERT ON settings WHEN NEW.key = 'menuDeploy.keyInfo' BEGIN SELECT RAISE(ABORT, 'test: disk busy'); END`);
    const made = await c.till.service.createKey('u_admin');
    expect(made.key).toMatch(/^cocmenu_/);
    expect(c.website.key!.keyHint).toBe(made.keyHint);
  });
});

live('after a restore, a reset website, a slow backup, a file that cuts prices (the review, 29 Sep)', () => {
  it('link off: after the before-menu copy is restored, the same file is NOT put in again by itself; one tap does', async () => {
    const c = setup({ link: 'off' });
    const p = c.website.upload(madeUpMenu('one'));
    expect((await c.till.service.checkNow()).phase).toBe('applied');
    expect(menuRows(c.till.db).items).toBe(2);
    c.till.service.stop();
    // The owner restores the copy made before the import (the menu as it was) and the till starts again.
    const restoredDb = openTill('till-1');
    c.clock.t += 5 * MIN;
    const restored = serviceTill('till-1', c.website, c.clock, { link: 'off', db: restoredDb });
    for (let i = 0; i < 3; i++) {
      const v = await restored.service.checkNow();
      expect(v).toMatchObject({ phase: 'waiting_for_owner', canApplyNow: true });
      expect(v.message).toContain('It is not put in again by itself');
      c.clock.t += 20 * MIN;
    }
    expect(menuRows(restoredDb).items).toBe(0);
    expect(c.website.claims()).toHaveLength(1);
    expect(restored.steps).toEqual([]);
    expect(c.website.reports('waiting_for_owner')).toHaveLength(1);
    // The owner's one tap puts it in again.
    await restored.service.apply(p.id, { userId: 'u_admin', deviceId: 'till-1' });
    expect(menuRows(restoredDb).items).toBe(2);
  });

  it('linked, the before-menu copy restored on the only till that looks: the file is not put in again, and the NEXT file goes in (never "waiting" for ever)', async () => {
    const c = setup();
    c.website.upload(madeUpMenu('one'));
    expect((await c.till.service.checkNow()).phase).toBe('applied');
    c.till.service.stop();
    const restoredDb = openTill('till-1');
    c.clock.t += 5 * MIN;
    const restored = serviceTill('till-1', c.website, c.clock, { db: restoredDb });
    const v = await restored.service.checkNow();
    expect(v.phase).toBe('other_till');
    expect(v.message).toContain('It is not put in again by itself');
    expect(v.canApplyNow).toBe(false);
    expect(menuRows(restoredDb).items).toBe(0);
    const p2 = c.website.upload(madeUpMenu('two', { source: 'test menu two' }));
    c.clock.t += 3 * MIN;
    linkOn(restoredDb, c.clock.t);
    expect((await restored.service.checkNow()).phase).toBe('applied');
    expect(menuRows(restoredDb).items).toBe(2);
    expect(c.website.byId(p2.id)).toMatchObject({ state: 'applied', appliedBy: 'till-1' });
  });

  it('a lost "applied" report and a newer file: the other till (which has the first file through the link) is not told "stalled" — it puts the new one in', async () => {
    const clock: Clock = { t: T0 };
    const website = new FakeMenuWebsite(clock);
    const t1 = serviceTill('till-1', website, clock);
    const t2 = serviceTill('till-2', website, clock);
    const p1 = website.upload(madeUpMenu('one'));
    website.drop(/\/report$/);
    expect((await t1.service.checkNow()).phase).toBe('applied');
    expect(website.byId(p1.id)!.state).toBe('claimed');
    expect((await push(t1.db, 'till-1', t2.db)).waiting).toBe(0);
    expect((await t2.service.checkNow()).phase).toBe('received');
    const p2 = website.upload(madeUpMenu('two', { source: 'test menu two' }));
    // Till 1 is busy at the counter; its claim on file 1 has run out.
    clock.t += 11 * MIN;
    linkOn(t1.db, clock.t);
    linkOn(t2.db, clock.t);
    orderRungUp(t1.db, 'till-1', clock.t - 30_000);
    expect((await t1.service.checkNow()).phase).toBe('waiting_quiet');
    const v2 = await t2.service.checkNow();
    expect(v2.phase).toBe('applied');
    expect(website.byId(p1.id)).toMatchObject({ state: 'applied', appliedBy: 'till-1' });
    expect(website.byId(p2.id)).toMatchObject({ state: 'applied', appliedBy: 'till-2' });
    expect(website.events.filter((e) => e.kind === 'taken_over')).toHaveLength(0);
  });

  it('the website’s database was reset (its numbers start again): a new file #1 still goes in', async () => {
    const c = setup();
    const old = c.website.upload(madeUpMenu('one'));
    expect((await c.till.service.checkNow()).phase).toBe('applied');
    c.till.service.stop();
    c.clock.t += 60 * MIN;
    const fresh = new FakeMenuWebsite(c.clock);
    const again = serviceTill('till-1', fresh, c.clock, { db: c.till.db });
    const p = fresh.upload(madeUpMenu('two', { source: 'test menu two' }));
    expect(p.seq).toBe(old.seq);
    const v = await again.service.checkNow();
    expect(v.phase).toBe('applied');
    expect(fresh.claims()).toHaveLength(1);
    expect(fresh.claims()[0]!.body).toMatchObject({ lastPackageSeq: old.seq, lastPackageId: old.id });
    expect(fresh.byId(p.id)).toMatchObject({ state: 'applied', appliedBy: 'till-1' });
    expect(imports(c.till.db)).toBe(2);
  });

  it('a backup copy that takes 9 minutes: the till claims again and puts the file in; the other till never sees it as stalled', async () => {
    const clock: Clock = { t: T0 };
    const website = new FakeMenuWebsite(clock);
    const t1 = serviceTill('till-1', website, clock);
    const t2 = serviceTill('till-2', website, clock);
    const p = website.upload(madeUpMenu('one'));
    let seenByTill2: string | null = null;
    t1.onBackup.fn = async () => {
      clock.t += 9 * MIN;
      linkOn(t2.db, clock.t);
      seenByTill2 = (await t2.service.checkNow()).phase;
    };
    const v = await t1.service.checkNow();
    expect(v.phase).toBe('applied');
    expect(seenByTill2).toBe('other_till');
    expect(t1.steps.filter((s) => s === 'backup')).toHaveLength(1);
    expect(website.claims('till-1')).toHaveLength(2);
    expect(website.byId(p.id)).toMatchObject({ state: 'applied', appliedBy: 'till-1' });
    expect(menuRows(t1.db).items).toBe(2);
    expect(imports(t1.db)).toBe(1);
  });

  it('by themselves, but a file that would cut a price to less than half, or change the tax, waits for the owner — never claimed; one tap puts it in', async () => {
    const c = setup();
    c.website.upload(madeUpMenu('one'));
    expect((await c.till.service.checkNow()).phase).toBe('applied');
    const price = () => (c.till.db.prepare(`SELECT base_price_cents AS p FROM menu_items WHERE name = 'Test Margherita' AND deleted_at IS NULL`).get() as { p: number }).p;
    expect(price()).toBe(110_000);
    const base = madeUpMenu('cheap');
    const items = (base['items'] as Array<Record<string, unknown>>).map((i) => (i['name'] === 'Test Margherita' ? { ...i, priceCents: 100 } : i));
    const p2 = c.website.upload({ ...base, items });
    for (let i = 0; i < 3; i++) {
      tick(c, 3 * MIN);
      const v = await c.till.service.checkNow();
      expect(v).toMatchObject({ phase: 'waiting_for_owner', canApplyNow: true });
      expect(v.message).toContain('waits for your OK: it would cut 1 price to less than half');
    }
    expect(c.website.claims()).toHaveLength(1);
    expect(c.website.reports('waiting_for_owner')).toHaveLength(1);
    expect(c.till.steps).toEqual(['backup', 'publish']);
    expect(price()).toBe(110_000);
    expect(c.till.emits.filter((e) => e.notice?.kind === 'waiting_for_owner').map((e) => e.notice!.description)).toEqual([
      expect.stringContaining('it would cut 1 price to less than half'),
    ]);
    // The owner looked and said yes.
    await c.till.service.apply(p2.id, { userId: 'u_admin', deviceId: 'till-1' });
    expect(price()).toBe(100);

    // A file that moves the items onto another tax: the same.
    const p3 = c.website.upload(madeUpMenu('tax', { tax: { name: 'Test Tax Zero', rateBps: 0 } }));
    tick(c, 3 * MIN);
    const v = await c.till.service.checkNow();
    expect(v.phase).toBe('waiting_for_owner');
    expect(v.message).toContain('it would change the tax on 2 items');
    expect(c.website.byId(p3.id)!.state).toBe('pending');
    // An ordinary price rise goes in by itself.
    const p4 = c.website.upload(madeUpMenu('dearer', { items: items.map((i) => ({ ...i, priceCents: Number(i['priceCents']) + 5_000 })) }));
    tick(c, 3 * MIN);
    expect((await c.till.service.checkNow()).phase).toBe('applied');
    expect(c.website.byId(p4.id)!.state).toBe('applied');
  });

  it('a saved "by themselves / wait" this version cannot read (a newer till’s) counts as Wait for my OK', async () => {
    const c = setup();
    const { setBusinessSetting } = await import('../db/repositories/business-settings-repo.js');
    setBusinessSetting(c.till.db, 'menu.autoUpdate', { v: 1, mode: 'auto' }, { userId: 'u_admin', deviceId: 'till-1' });
    c.till.db.prepare(`UPDATE business_settings SET value_json = ? WHERE key = 'menu.autoUpdate'`).run(JSON.stringify({ v: 2, mode: 'after_hours' }));
    c.website.upload(madeUpMenu('one'));
    const v = await c.till.service.checkNow();
    expect(v).toMatchObject({ phase: 'waiting_for_owner', mode: 'ask' });
    expect(c.website.claims()).toHaveLength(0);
    expect(menuRows(c.till.db).items).toBe(0);
  });
});
