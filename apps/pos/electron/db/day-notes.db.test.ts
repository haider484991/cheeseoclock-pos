/**
 * Day notes (migration 0037, costing spec Phase 7), against a real database
 * built from every migration:
 *   - adding a note is the row, its sync entry and a hash-chained audit row,
 *     in one transaction; taking it off is a soft delete, synced and
 *     audited the same way — nothing is erased;
 *   - the note travels to the other till (the row image) and its removal too;
 *   - Reports reads only the notes still on, in day order;
 *   - a day that is not a real date, before 2020 or more than a year ahead is
 *     refused in plain words; closed days and Eid are left out of forecasts
 *     unless told otherwise.
 *
 * node:sqlite behind better-sqlite3's shape; skips where it is missing.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from './connection.js';
import { CASHIER, DEV, DatabaseSync, MANAGER, OWNER, openMigrated } from './costing-shop.fixture.js';
import { verifyAuditChain, type AuditChainRow } from './audit-chain.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

const live = describe.skipIf(!DatabaseSync);
const TILL_2 = 'till-2';
const NOW = new Date('2026-09-29T09:00:00.000Z');

const n = (db: AppDatabase, sql: string, ...p: unknown[]) => Number((db.prepare(sql).get(...p) as { n: number } | undefined)?.n ?? 0);

function chainOk(db: AppDatabase): boolean {
  const rows = (
    db
      .prepare(
        `SELECT rowid, id, entity_type AS entityType, entity_id AS entityId, action, actor_user_id AS actorUserId,
                before_json AS beforeJson, after_json AS afterJson, ip, created_at AS createdAt,
                prev_hash AS prevHash, row_hash AS rowHash
           FROM audit_log ORDER BY rowid`,
      )
      .all() as unknown as AuditChainRow[]
  ).map((r) => ({ ...r, rowid: Number(r.rowid) }));
  return verifyAuditChain(rows).ok;
}

function till(deviceId: string): AppDatabase {
  const db = openMigrated();
  const user = db.prepare(`INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, 'x', 'x', ?)`);
  user.run(CASHIER.userId, 'Test Cashier', 'cashier', DEV);
  user.run(MANAGER.userId, 'Test Manager', 'manager', DEV);
  user.run(OWNER.userId, 'Test Owner', 'admin', DEV);
  db.prepare(`INSERT INTO device_info (id, device_id, display_name, registered_at) VALUES ('singleton', ?, ?, ?)`).run(deviceId, deviceId, NOW.toISOString());
  return db;
}

async function repos() {
  return {
    ...(await import('./repositories/day-note-repo.js')),
    ...(await import('./repositories/sync-repo.js')),
    ...(await import('./repositories/apply-remote.js')),
    ...(await import('./day-notes-read.js')),
  };
}

live('day notes (costing Phase 7)', () => {
  it('adding one writes the row, its sync entry and an audit row together; the chain verifies', async () => {
    const r = await repos();
    const db = till(DEV);
    const note = r.addDayNote(db, { day: '2026-09-26', tag: 'rain', note: '  Heavy   rain after 8 ' }, MANAGER, NOW);
    expect(note).toMatchObject({ day: '2026-09-26', tag: 'rain', note: 'Heavy rain after 8', excludeFromForecast: false, addedBy: 'Test Manager' });
    expect(n(db, `SELECT COUNT(*) AS n FROM day_notes WHERE id = ? AND deleted_at IS NULL AND device_id = ?`, note.id, DEV)).toBe(1);
    expect(n(db, `SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'day_notes' AND entity_id = ? AND op = 'upsert'`, note.id)).toBe(1);
    const audit = db.prepare(`SELECT action, actor_user_id AS actor, after_json FROM audit_log WHERE entity_type = 'day_notes' AND entity_id = ?`).all(note.id) as Array<{
      action: string;
      actor: string;
      after_json: string;
    }>;
    expect(audit.map((a) => [a.action, a.actor])).toEqual([['day_note_add', MANAGER.userId]]);
    expect(JSON.parse(audit[0]!.after_json)).toMatchObject({ day: '2026-09-26', tag: 'rain', createdByUserId: MANAGER.userId, deviceId: DEV });
    expect(chainOk(db)).toBe(true);
  });

  it('taking one off marks it removed (never erased), synced and audited; Reports no longer lists it', async () => {
    const r = await repos();
    const db = till(DEV);
    const keep = r.addDayNote(db, { day: '2026-09-25', tag: 'eid' }, OWNER, NOW);
    const off = r.addDayNote(db, { day: '2026-09-24', tag: 'cricket', note: 'Final' }, MANAGER, NOW);
    expect(r.readDayNotes(db, '2026-09-20', '2026-09-27').map((x) => x.id)).toEqual([off.id, keep.id]);

    expect(r.removeDayNote(db, off.id, OWNER)).toBe(true);
    expect(n(db, `SELECT COUNT(*) AS n FROM day_notes WHERE id = ? AND deleted_at IS NOT NULL AND version = 2`, off.id)).toBe(1);
    expect(n(db, `SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'day_notes' AND entity_id = ? AND op = 'delete'`, off.id)).toBe(1);
    expect(n(db, `SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'day_notes' AND entity_id = ? AND action = 'day_note_remove'`, off.id)).toBe(1);
    expect(r.readDayNotes(db, '2026-09-20', '2026-09-27').map((x) => x.id)).toEqual([keep.id]);
    // A second time: nothing to take off, nothing written.
    expect(r.removeDayNote(db, off.id, OWNER)).toBe(false);
    expect(n(db, `SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'day_notes' AND entity_id = ?`, off.id)).toBe(2);
    expect(chainOk(db)).toBe(true);
  });

  it('a note and its removal travel to the other till', async () => {
    const r = await repos();
    const a = till(DEV);
    const b = till(TILL_2);
    const push = async () => {
      const pending = r.listPendingSync(a, 1_000);
      const res = await r.applyRemoteBatch(b, pending.map((p) => r.pendingToChange(p, DEV)), { pause: async () => {} });
      r.markSyncedIds(a, pending.map((p) => p.id));
      return res;
    };
    const note = r.addDayNote(a, { day: '2026-09-18', tag: 'closed', note: 'Gas line repair' }, MANAGER, NOW);
    expect(await push()).toMatchObject({ waiting: 0, dropped: 0 });
    expect(r.readDayNotes(b, '2026-09-18', '2026-09-18')).toEqual([
      expect.objectContaining({ id: note.id, tag: 'closed', note: 'Gas line repair', excludeFromForecast: true, addedBy: 'Test Manager' }),
    ]);
    r.removeDayNote(a, note.id, MANAGER);
    expect(await push()).toMatchObject({ waiting: 0, dropped: 0 });
    expect(r.readDayNotes(b, '2026-09-18', '2026-09-18')).toEqual([]);
    expect(n(b, `SELECT COUNT(*) AS n FROM day_notes WHERE id = ? AND deleted_at IS NOT NULL`, note.id)).toBe(1);
  });

  it('refuses a day that will not do, in plain words, and writes nothing', async () => {
    const r = await repos();
    const db = till(DEV);
    expect(() => r.addDayNote(db, { day: '2026-02-30', tag: 'rain' }, MANAGER, NOW)).toThrow('That is not a real date.');
    expect(() => r.addDayNote(db, { day: '2019-12-31', tag: 'rain' }, MANAGER, NOW)).toThrow('Pick a day from 2020 on.');
    expect(() => r.addDayNote(db, { day: '2027-10-01', tag: 'closed' }, MANAGER, NOW)).toThrow('Pick a day within the next year.');
    expect(() => r.addDayNote(db, { day: '2026-09-26', tag: 'party' as never }, MANAGER, NOW)).toThrow('Pick what the day was.');
    expect(n(db, `SELECT COUNT(*) AS n FROM day_notes`)).toBe(0);
    expect(n(db, `SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'day_notes'`)).toBe(0);
    // A closed day ahead (Eid next month) is fine; closed and Eid leave forecasts unless told otherwise.
    expect(r.addDayNote(db, { day: '2026-10-20', tag: 'eid' }, MANAGER, NOW).excludeFromForecast).toBe(true);
    expect(r.addDayNote(db, { day: '2026-10-21', tag: 'closed', excludeFromForecast: false }, MANAGER, NOW).excludeFromForecast).toBe(false);
    expect(r.addDayNote(db, { day: '2026-09-27', tag: 'rain' }, MANAGER, NOW).excludeFromForecast).toBe(false);
  });

  it('a tag from a newer till still shows, as "Other"', async () => {
    const r = await repos();
    const db = till(DEV);
    db.prepare(
      `INSERT INTO day_notes (id, day, tag, note, exclude_from_forecast, created_by_user_id, created_at, updated_at, device_id)
       VALUES ('n-new', '2026-09-26', 'hailstorm', 'From a newer till', 0, NULL, 'x', 'x', ?)`,
    ).run(TILL_2);
    expect(r.readDayNotes(db, '2026-09-26', '2026-09-26')).toEqual([expect.objectContaining({ id: 'n-new', tag: 'other', note: 'From a newer till', addedBy: null })]);
  });
});
