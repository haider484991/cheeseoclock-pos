/**
 * The shift's two notes (audit 2026-09-27; migration 0039): the note typed
 * when a shift is opened and the one typed when it is closed are kept apart.
 * The close used to write its note over the opening one (notes =
 * COALESCE(NULLIF(?, ''), notes)), and neither was shown anywhere.
 *
 * On a real database built from the migrations, through the real shift
 * repository and the Reports code the Team & leakage tab runs:
 *   - the opening note stays as typed when the shift is closed with a note;
 *   - the closing note is saved on its own (and a close with none leaves it
 *     empty, the opening note untouched);
 *   - both are on the shift history rows (Reports → Team & leakage);
 *   - the sync entry carries close_notes as the row is stored, and the audit
 *     row has both, with the hash chain still whole;
 *   - a shift saved before 0039 (one note) still reads: its note is the
 *     opening note, and there is no closing note.
 *
 * node:sqlite behind better-sqlite3's shape (better-sqlite3 here is built for
 * Electron); skips where it is missing. Names, notes and amounts are made up.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { BusinessReportRequest } from '@cheeseoclock/shared-types';
import { DatabaseSync, MIGRATIONS, migrationFiles, openMigrated } from './costing-shop.fixture.js';
import { verifyAuditChain, type AuditChainRow } from './audit-chain.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

const live = describe.skipIf(!DatabaseSync);

const DEV = 'till-1';
const T0 = '2026-01-01T00:00:00.000Z';
const MANAGER = { userId: 'u_sara', deviceId: DEV };
const CASHIER = { userId: 'u_ali', deviceId: DEV };
const OPEN_NOTE = 'Morning shift, Ali on register';
const CLOSE_NOTE = 'Rs 100 short, change given wrong on #0042';
/** Every shift these tests open, whenever the test runs. */
const ALL_TIME: BusinessReportRequest = { sinceIso: '2000-01-01T00:00:00.000Z', untilIso: '2100-01-01T00:00:00.000Z' };

type Db = ReturnType<typeof openMigrated>;
type Row = Record<string, unknown>;

function seedUsers(db: Db): void {
  const user = db.prepare(`INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, ?)`);
  user.run('u_ali', 'Ali', 'cashier', T0, T0, DEV);
  user.run('u_sara', 'Sara', 'manager', T0, T0, DEV);
}

function auditRows(db: Db): AuditChainRow[] {
  return db
    .prepare(
      `SELECT rowid, id, entity_type AS entityType, entity_id AS entityId, action,
              actor_user_id AS actorUserId, before_json AS beforeJson, after_json AS afterJson,
              ip, created_at AS createdAt, prev_hash AS prevHash, row_hash AS rowHash
         FROM audit_log ORDER BY rowid`,
    )
    .all() as unknown as AuditChainRow[];
}

/** The newest sync entry for a shift, as it will be sent. */
function lastSyncPayload(db: Db, shiftId: string): Row {
  const row = db
    .prepare(`SELECT payload_json FROM sync_queue WHERE entity_type = 'shifts' AND entity_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(shiftId) as { payload_json: string };
  return JSON.parse(row.payload_json) as Row;
}

let repo: typeof import('./repositories/shift-repo.js');
let tabs: typeof import('../services/analytics/report-tabs.js');

beforeAll(async () => {
  if (!DatabaseSync) return;
  repo = await import('./repositories/shift-repo.js');
  tabs = await import('../services/analytics/report-tabs.js');
});

live('shift notes: the opening note and the closing note, each kept', () => {
  it('a close with a note keeps the opening note and saves the closing note on its own', () => {
    const db = openMigrated();
    seedUsers(db);
    const opened = repo.openShift(db, { openingCashCents: 500_000, notes: `  ${OPEN_NOTE}  ` }, CASHIER);
    expect(opened).toMatchObject({ notes: OPEN_NOTE, closeNotes: null });

    const closed = repo.closeShift(db, { shiftId: opened.id, countedCashCents: 490_000, notes: CLOSE_NOTE }, MANAGER);
    expect(closed).toMatchObject({ notes: OPEN_NOTE, closeNotes: CLOSE_NOTE, varianceCents: -10_000 });
    // As stored: two columns, the opening note not written over.
    expect(db.prepare(`SELECT notes, close_notes FROM shifts WHERE id = ?`).get(opened.id)).toEqual({
      notes: OPEN_NOTE,
      close_notes: CLOSE_NOTE,
    });
    expect(repo.findShift(db, opened.id)).toMatchObject({ notes: OPEN_NOTE, closeNotes: CLOSE_NOTE });
    expect(repo.listShifts(db, {}).find((s) => s.id === opened.id)).toMatchObject({ notes: OPEN_NOTE, closeNotes: CLOSE_NOTE });
  });

  it('a close with no note leaves the opening note alone and the closing note empty; a shift opened with no note has neither', () => {
    const db = openMigrated();
    seedUsers(db);
    const a = repo.openShift(db, { openingCashCents: 0, notes: OPEN_NOTE }, CASHIER);
    expect(repo.closeShift(db, { shiftId: a.id, countedCashCents: 0, notes: '   ' }, MANAGER)).toMatchObject({
      notes: OPEN_NOTE,
      closeNotes: null,
    });
    const b = repo.openShift(db, { openingCashCents: 0 }, CASHIER);
    expect(repo.closeShift(db, { shiftId: b.id, countedCashCents: 0 }, MANAGER)).toMatchObject({ notes: null, closeNotes: null });
  });

  it('both notes are on the shift history rows (Reports → Team & leakage), each in its own field', () => {
    const db = openMigrated();
    seedUsers(db);
    const noted = repo.openShift(db, { openingCashCents: 500_000, notes: OPEN_NOTE }, CASHIER);
    repo.closeShift(db, { shiftId: noted.id, countedCashCents: 490_000, notes: CLOSE_NOTE }, MANAGER);
    const open = repo.openShift(db, { openingCashCents: 490_000, notes: 'Evening, Sara' }, MANAGER);

    const shifts = tabs.buildReportTab(db, 'team', ALL_TIME, new Date()).shifts;
    const byId = new Map(shifts.map((s) => [s.id, s]));
    expect(byId.get(noted.id)).toMatchObject({ openingNote: OPEN_NOTE, closingNote: CLOSE_NOTE, varianceCents: -10_000 });
    // Still open: its opening note, no closing note yet.
    expect(byId.get(open.id)).toMatchObject({ openingNote: 'Evening, Sara', closingNote: null, closedAt: null });
  });

  it('the sync entry carries close_notes (the row as stored) and the audit row has both notes; the chain is whole', () => {
    const db = openMigrated();
    seedUsers(db);
    const opened = repo.openShift(db, { openingCashCents: 500_000, notes: OPEN_NOTE }, CASHIER);
    repo.closeShift(db, { shiftId: opened.id, countedCashCents: 500_000, notes: CLOSE_NOTE }, MANAGER);

    const payload = lastSyncPayload(db, opened.id);
    expect(payload['__rowImage']).toBe(1);
    expect(payload).toMatchObject({ id: opened.id, notes: OPEN_NOTE, closeNotes: CLOSE_NOTE, closedByUserId: 'u_sara', deviceId: DEV });

    const audit = db
      .prepare(`SELECT before_json AS before, after_json AS after FROM audit_log WHERE entity_id = ? AND action = 'shift_close'`)
      .get(opened.id) as { before: string; after: string };
    expect(JSON.parse(audit.before)).toMatchObject({ notes: OPEN_NOTE, closeNotes: null });
    expect(JSON.parse(audit.after)).toMatchObject({ notes: OPEN_NOTE, closeNotes: CLOSE_NOTE });
    expect(verifyAuditChain(auditRows(db)).ok).toBe(true);
  });

  it('a shift saved before migration 0039 still reads: its one note is the opening note, and there is no closing note', () => {
    // A till still on 0038: a shift closed the old way, its one note in `notes`.
    const db = openMigrated({ stopBefore: '0039' });
    seedUsers(db);
    db.prepare(
      `INSERT INTO shifts (id, device_id, opened_by_user_id, opened_at, opening_cash_cents, closed_by_user_id, closed_at,
         counted_cash_cents, expected_cash_cents, variance_cents, notes, created_at, updated_at)
       VALUES ('s_old', ?, 'u_ali', '2026-09-20T07:00:00.000Z', 400000, 'u_sara', '2026-09-20T20:00:00.000Z',
         700000, 700000, 0, 'Old shift, one note', ?, ?)`,
    ).run(DEV, T0, T0);
    // The update arrives: 0039 runs on that database, and every migration
    // after it (0042 drawer log, 0043 test-order delete: Reports reads their
    // columns too).
    for (const f of migrationFiles().filter((m) => m >= '0039')) db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));

    expect(repo.findShift(db, 's_old')).toMatchObject({ notes: 'Old shift, one note', closeNotes: null, varianceCents: 0 });
    const line = tabs.buildReportTab(db, 'team', ALL_TIME, new Date()).shifts.find((s) => s.id === 's_old');
    expect(line).toMatchObject({ openingNote: 'Old shift, one note', closingNote: null, countedCashCents: 700_000 });

    // And the till carries on: a new shift on it keeps both notes.
    const next = repo.openShift(db, { openingCashCents: 700_000, notes: OPEN_NOTE }, CASHIER);
    expect(repo.closeShift(db, { shiftId: next.id, countedCashCents: 700_000, notes: CLOSE_NOTE }, MANAGER)).toMatchObject({
      notes: OPEN_NOTE,
      closeNotes: CLOSE_NOTE,
    });
  });
});
