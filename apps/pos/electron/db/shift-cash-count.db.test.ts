/**
 * The drawer counted by note at Close shift (owner, 2 Oct 2026: "when
 * closing the cash count should have 5000rs x note 1000 x 500 100 and 50 and
 * 20 and 10"), stored in shifts.counted_notes_json (migration 0050).
 *
 * The schema part: what a close may save (cashCountInputSchema, strict —
 * every refusal in its own plain words) and what a stored count may hold
 * (cashCountSchema, lenient — a newer till's extra key, row or paisa still
 * reads), and parseCashCountJson, which never throws. shared-schemas has no
 * test runner, so these live here as a plain describe that needs no
 * database.
 *
 * The database part (migration 0050 shifts.counted_notes_json), on real
 * databases built from the migrations, through the real shift repository:
 *   - a close counted by note stores the counted cash and the canonical text
 *     (cashCountJson's, whatever order the keys came in), and its expected
 *     cash and over / short are a twin close's without the notes;
 *   - a close without notes stores NULL and reads null;
 *   - notes that do not add up to the counted cash, or that hide a count
 *     below 0, are refused in plain words before the unpaid orders are
 *     looked at: the shift stays open, no sync or audit row;
 *   - the sync entry carries the stored text and the hash-chained audit row
 *     the count as an object;
 *   - two tills: the other till on this version gets the count; a till still
 *     on v0.7.34 or v0.7.33 applies the shift with nothing left waiting; an
 *     image without the key gives NULL on a new row and leaves a stored count
 *     alone;
 *   - stored text that cannot be read is null (noted in the log), and every
 *     list still reads; getLastCount stays the total only.
 * node's own `node:sqlite` stands in for better-sqlite3 there; skipped where
 * it is missing. Made-up names and counts (the repository is public).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cashCountInputSchema, cashCountSchema, parseCashCountJson } from '@cheeseoclock/shared-schemas';
import { CASH_NOTE_FACE_CENTS, type CashCount } from '@cheeseoclock/shared-types';
import { cashCountJson, cashCountTotalCents } from '@cheeseoclock/pos-domain';
import type { SyncChange } from '@cheeseoclock/sync-core';
import type { AppDatabase } from './connection.js';
import { DatabaseSync, openMigrated } from './costing-shop.fixture.js';
import { TEST_USERS, iAm, openTill } from './two-tills.fixture.js';
import { verifyAuditChain, type AuditChainRow } from './audit-chain.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const h = vi.hoisted(() => ({ warns: [] as Array<[string, unknown]> }));
vi.mock('electron-log/main', () => ({
  default: {
    info: () => {},
    warn: (message: string, data: unknown) => {
      h.warns.push([message, data]);
    },
    error: () => {},
    debug: () => {},
  },
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, app: { getPath: () => '', getVersion: () => '0.0.0-test' } }));

/** The owner's example: 5,000 × 2, 1,000 × 3, 500 × 1, 100 × 7, 10 × 4 and Rs 35 in coins. */
const EXAMPLE: CashCount = {
  notes: [
    { faceCents: 500_000, count: 2 },
    { faceCents: 100_000, count: 3 },
    { faceCents: 50_000, count: 1 },
    { faceCents: 10_000, count: 7 },
    { faceCents: 5_000, count: 0 },
    { faceCents: 2_000, count: 0 },
    { faceCents: 1_000, count: 4 },
  ],
  otherCents: 3_500,
};
const EXAMPLE_JSON =
  '{"notes":[{"faceCents":500000,"count":2},{"faceCents":100000,"count":3},{"faceCents":50000,"count":1},' +
  '{"faceCents":10000,"count":7},{"faceCents":5000,"count":0},{"faceCents":2000,"count":0},' +
  '{"faceCents":1000,"count":4}],"otherCents":3500}';

const WHOLE = 'A count is a whole number of notes';
const BELOW_ZERO = "A count can't be below 0";
const TOO_MANY = 'At most 9,999 notes in one row';
const COINS_WHOLE = 'Coins and other is in whole rupees';
const COINS_TOO_MUCH = 'Coins and other is at most Rs 99,999';
const ROWS = 'The note rows are Rs 5,000, 1,000, 500, 100, 50, 20 and 10';

/** The example with row `i`'s count replaced (any value, as a close might send it). */
function withCount(i: number, count: unknown): unknown {
  return { ...EXAMPLE, notes: EXAMPLE.notes.map((n, j) => (j === i ? { ...n, count } : n)) };
}

/** The words the till shows for the first problem, or null when the count may be saved. */
function refusal(input: unknown): string | null {
  const r = cashCountInputSchema.safeParse(input);
  return r.success ? null : (r.error.issues[0]?.message ?? '(no message)');
}

describe('what a close may save (cashCountInputSchema, strict)', () => {
  it('takes the owner’s example as it is, and it adds up to Rs 14,275', () => {
    const r = cashCountInputSchema.safeParse(EXAMPLE);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toEqual(EXAMPLE);
    expect(cashCountTotalCents(r.data)).toBe(1_427_500);
    expect(cashCountJson(r.data)).toBe(EXAMPLE_JSON);
  });

  it('takes all zeros, the most notes in a row and the most coins', () => {
    const zeros = { notes: CASH_NOTE_FACE_CENTS.map((faceCents) => ({ faceCents, count: 0 })), otherCents: 0 };
    expect(refusal(zeros)).toBeNull();
    expect(refusal(withCount(0, 9_999))).toBeNull();
    expect(refusal({ ...EXAMPLE, otherCents: 9_999_900 })).toBeNull();
  });

  it('a count that is not a whole number of notes: 1.5, "2", NaN, Infinity, or none', () => {
    expect(refusal(withCount(2, 1.5))).toBe(WHOLE);
    expect(refusal(withCount(2, '2'))).toBe(WHOLE);
    expect(refusal(withCount(2, Number.NaN))).toBe(WHOLE);
    expect(refusal(withCount(2, Number.POSITIVE_INFINITY))).toBe(WHOLE);
    expect(refusal(withCount(2, null))).toBe(WHOLE);
    expect(refusal({ ...EXAMPLE, notes: EXAMPLE.notes.map((n, j) => (j === 2 ? { faceCents: n.faceCents } : n)) })).toBe(WHOLE);
  });

  it('a count below 0, and more than 9,999 notes in one row', () => {
    expect(refusal(withCount(2, -1))).toBe(BELOW_ZERO);
    expect(refusal(withCount(2, 10_000))).toBe(TOO_MANY);
  });

  it('coins and other in paisa, above Rs 99,999, below 0 or not a number', () => {
    expect(refusal({ ...EXAMPLE, otherCents: 3_550 })).toBe(COINS_WHOLE);
    expect(refusal({ ...EXAMPLE, otherCents: 10_000_000 })).toBe(COINS_TOO_MUCH);
    expect(refusal({ ...EXAMPLE, otherCents: '35' })).toBe(COINS_WHOLE);
    expect(refusal({ ...EXAMPLE, otherCents: Number.NaN })).toBe(COINS_WHOLE);
    expect(refusal({ notes: EXAMPLE.notes })).toBe(COINS_WHOLE);
    expect(refusal({ ...EXAMPLE, otherCents: -100 })).toBe("Coins and other can't be below Rs 0");
  });

  it('only the owner’s seven rows, in his order: a missing row, rows out of order, a duplicate, a Rs 75 row', () => {
    expect(refusal({ ...EXAMPLE, notes: EXAMPLE.notes.slice(0, 6) })).toBe(ROWS);
    const swapped = [...EXAMPLE.notes];
    [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
    expect(refusal({ ...EXAMPLE, notes: swapped })).toBe(ROWS);
    expect(refusal({ ...EXAMPLE, notes: EXAMPLE.notes.map((n, j) => (j === 1 ? { ...n, faceCents: 500_000 } : n)) })).toBe(ROWS);
    expect(refusal({ ...EXAMPLE, notes: [...EXAMPLE.notes, EXAMPLE.notes[6]!] })).toBe(ROWS);
    expect(refusal({ ...EXAMPLE, notes: [...EXAMPLE.notes, { faceCents: 7_500, count: 1 }] })).toBe(ROWS);
    expect(refusal({ ...EXAMPLE, notes: EXAMPLE.notes.map((n, j) => (j === 6 ? { faceCents: 7_500, count: 1 } : n)) })).toBe(ROWS);
    expect(refusal({ ...EXAMPLE, notes: [] })).toBe(ROWS);
    expect(refusal({ ...EXAMPLE, notes: 5 })).toBe(ROWS);
    expect(refusal({ otherCents: 3_500 })).toBe(ROWS);
    expect(refusal({ ...EXAMPLE, notes: EXAMPLE.notes.map((n, j) => (j === 0 ? { ...n, faceCents: '500000' } : n)) })).toBe(ROWS);
  });

  it('nothing else: an extra key on a row or on the count', () => {
    expect(refusal({ ...EXAMPLE, notes: EXAMPLE.notes.map((n, j) => (j === 3 ? { ...n, rupees: 100 } : n)) })).toBe(ROWS);
    expect(refusal({ ...EXAMPLE, totalCents: 1_427_500 })).toBe(ROWS);
  });

  it('a count that is not an object at all', () => {
    expect(cashCountInputSchema.safeParse(null).success).toBe(false);
    expect(cashCountInputSchema.safeParse('2').success).toBe(false);
    expect(cashCountInputSchema.safeParse([]).success).toBe(false);
  });
});

describe('what a stored count may hold (cashCountSchema, lenient)', () => {
  it('reads the owner’s example', () => {
    expect(cashCountSchema.parse(EXAMPLE)).toEqual(EXAMPLE);
  });

  it('reads a row the list lacks (a Rs 75 note), keeping it in place', () => {
    const stored = {
      notes: [EXAMPLE.notes[0]!, { faceCents: 7_500, count: 1 }, ...EXAMPLE.notes.slice(1)],
      otherCents: 0,
    };
    expect(cashCountSchema.parse(stored)).toEqual(stored);
  });

  it('drops an extra key from a newer till instead of refusing the count', () => {
    const newer = {
      ...EXAMPLE,
      countedBy: 'Sara',
      notes: EXAMPLE.notes.map((n) => ({ ...n, bundle: false })),
    };
    expect(cashCountSchema.parse(newer)).toEqual(EXAMPLE);
  });

  it('reads coins and other in paisa', () => {
    expect(cashCountSchema.parse({ ...EXAMPLE, otherCents: 3_550 })).toEqual({ ...EXAMPLE, otherCents: 3_550 });
  });

  it('refuses no rows, the same note twice, a part note or a count below 0', () => {
    expect(cashCountSchema.safeParse({ notes: [], otherCents: 0 }).success).toBe(false);
    expect(cashCountSchema.safeParse({ ...EXAMPLE, notes: [...EXAMPLE.notes, EXAMPLE.notes[0]!] }).success).toBe(false);
    expect(cashCountSchema.safeParse(withCount(1, 0.5)).success).toBe(false);
    expect(cashCountSchema.safeParse(withCount(1, -1)).success).toBe(false);
  });
});

describe('parseCashCountJson (reads the stored text, never throws)', () => {
  it('nothing, empty, not JSON, or a shape it cannot read: null', () => {
    expect(parseCashCountJson(null)).toBeNull();
    expect(parseCashCountJson(undefined)).toBeNull();
    expect(parseCashCountJson('')).toBeNull();
    expect(parseCashCountJson('not json')).toBeNull();
    expect(parseCashCountJson('{"notes":5}')).toBeNull();
    expect(parseCashCountJson('{"notes":[]}')).toBeNull();
    expect(parseCashCountJson('{"notes":[],"otherCents":0}')).toBeNull();
    expect(parseCashCountJson('null')).toBeNull();
    expect(parseCashCountJson('[]')).toBeNull();
  });

  it('the canonical text reads as the count, and writes back as the same text', () => {
    const read = parseCashCountJson(EXAMPLE_JSON);
    expect(read).toEqual(EXAMPLE);
    expect(read && cashCountJson(read)).toBe(EXAMPLE_JSON);
  });

  it('a newer till’s text with an extra key and a Rs 75 row still reads', () => {
    const text = '{"notes":[{"faceCents":7500,"count":1,"x":1}],"otherCents":3550,"by":"Sara"}';
    expect(parseCashCountJson(text)).toEqual({ notes: [{ faceCents: 7_500, count: 1 }], otherCents: 3_550 });
  });
});

// ============================================================ database part

const live = describe.skipIf(!DatabaseSync);

const DEV = 'till-1';
const T0 = '2026-01-01T00:00:00.000Z';
const MANAGER = { userId: 'u_sara', deviceId: DEV };
const CASHIER = { userId: 'u_ali', deviceId: DEV };
/** The float: Rs 5,000. */
const FLOAT = 500_000;
/** The owner's example adds up to Rs 14,275. */
const EXAMPLE_CENTS = 1_427_500;

type Db = ReturnType<typeof openMigrated>;
type Row = Record<string, unknown>;

let repo: typeof import('./repositories/shift-repo.js');

beforeAll(async () => {
  if (!DatabaseSync) return;
  repo = await import('./repositories/shift-repo.js');
});

beforeEach(() => {
  h.warns.length = 0;
});

function seedUsers(db: Db): void {
  const user = db.prepare(`INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, ?)`);
  user.run('u_ali', 'Test Ali', 'cashier', T0, T0, DEV);
  user.run('u_sara', 'Test Sara', 'manager', T0, T0, DEV);
}

/** A till with a shift open on a Rs 5,000 float and Rs 200 paid out for gas (expected cash Rs 4,800). */
function tillWithShift(): { db: Db; shiftId: string } {
  const db = openMigrated();
  seedUsers(db);
  const shiftId = repo.openShift(db, { openingCashCents: FLOAT }, CASHIER).id;
  repo.recordCashMovement(db, { type: 'payout', amountCents: 20_000, reason: 'Test gas cylinder' }, MANAGER);
  return { db, shiftId };
}

const stored = (db: Db, shiftId: string) =>
  db.prepare(`SELECT closed_at, counted_cash_cents, counted_notes_json FROM shifts WHERE id = ?`).get(shiftId) as Row;
const count = (db: Db, table: 'sync_queue' | 'audit_log') => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

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

/** An order on this till that went to the kitchen and was never paid. */
function unpaidOrder(db: Db, id: string, orderNumber: string): void {
  db.prepare(
    `INSERT INTO orders (id, order_number, mode, status, cashier_id, subtotal_cents, discount_cents, tax_cents,
                         total_cents, source, paid_at, created_at, updated_at, device_id)
     VALUES (?, ?, 'delivery', 'out_for_delivery', 'u_ali', 124000, 0, 0, 124000, 'pos', NULL, ?, ?, ?)`,
  ).run(id, orderNumber, T0, T0, DEV);
}

live('a close counted by note (shifts.counted_notes_json, migration 0050)', () => {
  it('stores the counted cash and the canonical text; expected cash and over / short are a twin close’s without the notes', () => {
    const counted = tillWithShift();
    // Sent with the keys in another order: the stored text is cashCountJson's all the same.
    const sent = {
      otherCents: EXAMPLE.otherCents,
      notes: EXAMPLE.notes.map((n) => ({ count: n.count, faceCents: n.faceCents })),
    };
    const closed = repo.closeShift(
      counted.db,
      { shiftId: counted.shiftId, countedCashCents: EXAMPLE_CENTS, countedNotes: sent, notes: 'Test close' },
      MANAGER,
    );
    expect(closed).toMatchObject({ countedCashCents: EXAMPLE_CENTS, countedNotes: EXAMPLE, closeNotes: 'Test close' });
    expect(stored(counted.db, counted.shiftId)).toEqual({
      closed_at: closed.closedAt,
      counted_cash_cents: EXAMPLE_CENTS,
      counted_notes_json: EXAMPLE_JSON,
    });
    expect(repo.findShift(counted.db, counted.shiftId)?.countedNotes).toEqual(EXAMPLE);
    expect(repo.listShifts(counted.db, {}).find((s) => s.id === counted.shiftId)?.countedNotes).toEqual(EXAMPLE);

    // The twin: the same shift closed on the same total, typed as one figure.
    const twin = tillWithShift();
    const plain = repo.closeShift(twin.db, { shiftId: twin.shiftId, countedCashCents: EXAMPLE_CENTS }, MANAGER);
    const figures = (s: typeof closed) => ({ counted: s.countedCashCents, expected: s.expectedCashCents, variance: s.varianceCents });
    expect(figures(closed)).toEqual(figures(plain));
    expect(figures(closed)).toEqual({ counted: EXAMPLE_CENTS, expected: FLOAT - 20_000, variance: EXAMPLE_CENTS - (FLOAT - 20_000) });
  });

  it('a close without notes (or with null) stores NULL and reads null; so does a shift still open', () => {
    const a = tillWithShift();
    expect(repo.getCurrentShift(a.db, DEV)?.countedNotes).toBeNull();
    expect(repo.closeShift(a.db, { shiftId: a.shiftId, countedCashCents: 480_000 }, MANAGER).countedNotes).toBeNull();
    expect(stored(a.db, a.shiftId)).toMatchObject({ counted_cash_cents: 480_000, counted_notes_json: null });

    const b = tillWithShift();
    expect(repo.closeShift(b.db, { shiftId: b.shiftId, countedCashCents: 480_000, countedNotes: null }, MANAGER).countedNotes).toBeNull();
    expect(stored(b.db, b.shiftId)).toMatchObject({ counted_cash_cents: 480_000, counted_notes_json: null });
    expect(h.warns).toEqual([]);
  });

  it('notes that do not add up to the counted cash, or that hide a count below 0, are refused in plain words; the shift stays open and nothing is written', () => {
    const { db, shiftId } = tillWithShift();
    // An order still out and no reason given: the count is checked first, so its words are the ones shown.
    unpaidOrder(db, 'o_out', '20261002-0042');
    const before = { sync: count(db, 'sync_queue'), audit: count(db, 'audit_log'), row: stored(db, shiftId) };
    const refused = (countedCashCents: number, countedNotes: unknown) => () =>
      repo.closeShift(db, { shiftId, countedCashCents, countedNotes: countedNotes as CashCount }, MANAGER);

    expect(refused(1_400_000, EXAMPLE)).toThrow(
      new Error('The notes counted add up to Rs 14,275, not Rs 14,000. Count the drawer again.'),
    );
    expect(refused(1_427_550, EXAMPLE)).toThrow(
      new Error('The notes counted add up to Rs 14,275, not Rs 14,275.50. Count the drawer again.'),
    );
    // Rs 500 × -1 with the coins raised by Rs 1,000: the sum still matches, the count does not.
    const hidden = { ...EXAMPLE, notes: EXAMPLE.notes.map((n, i) => (i === 2 ? { ...n, count: -1 } : n)), otherCents: 3_500 + 100_000 };
    expect(cashCountTotalCents(hidden)).toBe(EXAMPLE_CENTS);
    expect(refused(EXAMPLE_CENTS, hidden)).toThrow(new Error("A count can't be below 0"));
    expect(refused(EXAMPLE_CENTS, withCount(2, 1.5))).toThrow(new Error('A count is a whole number of notes'));
    expect(refused(EXAMPLE_CENTS, { ...EXAMPLE, notes: EXAMPLE.notes.slice(0, 6) })).toThrow(new Error(ROWS));

    expect({ sync: count(db, 'sync_queue'), audit: count(db, 'audit_log'), row: stored(db, shiftId) }).toEqual(before);
    expect(before.row).toMatchObject({ closed_at: null, counted_cash_cents: null, counted_notes_json: null });

    // Counted again and a reason given: it closes.
    const closed = repo.closeShift(
      db,
      { shiftId, countedCashCents: EXAMPLE_CENTS, countedNotes: EXAMPLE, carryOverReason: 'Test rider still out' },
      MANAGER,
    );
    expect(closed).toMatchObject({ countedCashCents: EXAMPLE_CENTS, countedNotes: EXAMPLE, carriedUnpaidCount: 1 });
  });

  it('the sync entry carries the stored text; the shift_close audit row has the count as an object; the chain is whole', () => {
    const { db, shiftId } = tillWithShift();
    repo.closeShift(db, { shiftId, countedCashCents: EXAMPLE_CENTS, countedNotes: EXAMPLE }, MANAGER);

    const payload = lastSyncPayload(db, shiftId);
    expect(payload['__rowImage']).toBe(1);
    expect(payload).toMatchObject({ id: shiftId, countedCashCents: EXAMPLE_CENTS, countedNotesJson: EXAMPLE_JSON });

    const audit = db
      .prepare(`SELECT before_json AS before, after_json AS after FROM audit_log WHERE entity_id = ? AND action = 'shift_close'`)
      .get(shiftId) as { before: string; after: string };
    expect(JSON.parse(audit.before)).toMatchObject({ countedNotes: null, countedCashCents: null });
    expect(JSON.parse(audit.after)).toMatchObject({ countedNotes: EXAMPLE, countedCashCents: EXAMPLE_CENTS });
    // The shift_open row says it had no count yet.
    const opened = db.prepare(`SELECT after_json AS after FROM audit_log WHERE entity_id = ? AND action = 'shift_open'`).get(shiftId) as {
      after: string;
    };
    expect(JSON.parse(opened.after)).toMatchObject({ countedNotes: null });
    expect(verifyAuditChain(auditRows(db))).toMatchObject({ ok: true, brokenAt: null });
  });

  it('stored text that cannot be read is null and noted in the log; a newer till’s text still reads; every list still reads', () => {
    const { db, shiftId } = tillWithShift();
    repo.closeShift(db, { shiftId, countedCashCents: EXAMPLE_CENTS, countedNotes: EXAMPLE }, MANAGER);
    const next = repo.openShift(db, { openingCashCents: FLOAT }, MANAGER);
    const set = (text: string | null) => db.prepare(`UPDATE shifts SET counted_notes_json = ? WHERE id = ?`).run(text, shiftId);

    for (const text of ['{"notes":5}', 'not json', '{"notes":[],"otherCents":0}']) {
      set(text);
      h.warns.length = 0;
      expect(repo.findShift(db, shiftId)).toMatchObject({ id: shiftId, countedCashCents: EXAMPLE_CENTS, countedNotes: null });
      expect(h.warns).toEqual([['Shift: the note count could not be read; showing none', { id: shiftId }]]);
      expect(repo.listShifts(db, {}).map((s) => [s.id, s.countedNotes])).toEqual([
        [next.id, null],
        [shiftId, null],
      ]);
      expect(repo.getCurrentShift(db, DEV)?.id).toBe(next.id);
    }

    // Empty is simply none, with nothing to note.
    set('');
    h.warns.length = 0;
    expect(repo.findShift(db, shiftId)?.countedNotes).toBeNull();
    expect(h.warns).toEqual([]);

    // A newer till's count: an extra key, a Rs 75 row, coins in paisa.
    set('{"notes":[{"faceCents":500000,"count":2,"bundle":true},{"faceCents":7500,"count":1}],"otherCents":3550,"by":"Test"}');
    expect(repo.findShift(db, shiftId)?.countedNotes).toEqual({
      notes: [
        { faceCents: 500_000, count: 2 },
        { faceCents: 7_500, count: 1 },
      ],
      otherCents: 3_550,
    });
  });

  it('getLastCount (the next float) is still the total only', () => {
    const { db, shiftId } = tillWithShift();
    const closed = repo.closeShift(db, { shiftId, countedCashCents: EXAMPLE_CENTS, countedNotes: EXAMPLE }, MANAGER);
    expect(repo.getLastCount(db, DEV)).toEqual({ countedCashCents: EXAMPLE_CENTS, closedAt: closed.closedAt });
  });
});

// ------------------------------------------------------------- two tills

const TILL_A = 'till-a';
const A = { manager: { userId: 'u_mgr', deviceId: TILL_A }, cashier: { userId: 'u_cash', deviceId: TILL_A } };

/** Everything `from` has queued, as the link sends it (not marked sent: it can go to more than one till). */
async function queued(from: AppDatabase, fromDevice: string): Promise<SyncChange[]> {
  const sync = await import('./repositories/sync-repo.js');
  return sync.listPendingSync(from, 1_000_000).map((p) => sync.pendingToChange(p, fromDevice));
}

/** Applied on `to` as the sync worker does: everything written, nothing left waiting for a later pull. */
async function applyAll(to: AppDatabase, changes: SyncChange[]): Promise<void> {
  const { applyRemoteBatch } = await import('./repositories/apply-remote.js');
  const { readParked } = await import('./repositories/sync-repo.js');
  expect(await applyRemoteBatch(to, changes, { pause: async () => {} })).toMatchObject({ applied: changes.length, waiting: 0, dropped: 0 });
  expect(readParked(to)).toEqual([]);
}

/** A till still on an older version: its migrations up to `stopBefore`, the same made-up users, its own device id. */
function olderTill(stopBefore: string, deviceId: string): AppDatabase {
  const db = openMigrated({ stopBefore }) as unknown as AppDatabase;
  const user = db.prepare(`INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, 'x', 'x', ?)`);
  for (const u of Object.values(TEST_USERS)) user.run(u.userId, u.name, u.role, TILL_A);
  iAm(db, deviceId);
  return db;
}

const withoutCount = (c: SyncChange): SyncChange =>
  c.entityType === 'shifts'
    ? ({ ...c, payload: Object.fromEntries(Object.entries(c.payload as Row).filter(([k]) => k !== 'countedNotesJson')) } as SyncChange)
    : c;

/** Till A: a shift opened on a Rs 5,000 float and closed counted by note (the owner's example). */
function closedOnA(): { a: AppDatabase; shiftId: string } {
  const a = openTill(TILL_A);
  const shiftId = repo.openShift(a, { openingCashCents: FLOAT }, A.cashier).id;
  repo.closeShift(a, { shiftId, countedCashCents: EXAMPLE_CENTS, countedNotes: EXAMPLE, notes: 'Test close' }, A.manager);
  return { a, shiftId };
}

live('two tills: the count travels with the shift', () => {
  it('the other till on this version gets the stored text and reads the count', async () => {
    const { a, shiftId } = closedOnA();
    const b = openTill('till-b', { usersFrom: TILL_A });
    await applyAll(b, await queued(a, TILL_A));
    expect(b.prepare(`SELECT * FROM shifts WHERE id = ?`).get(shiftId)).toEqual(a.prepare(`SELECT * FROM shifts WHERE id = ?`).get(shiftId));
    expect(repo.findShift(b, shiftId)).toMatchObject({ countedCashCents: EXAMPLE_CENTS, countedNotes: EXAMPLE, closeNotes: 'Test close' });
  });

  for (const [version, stopBefore] of [
    ['v0.7.34', '0050'],
    ['v0.7.33', '0047'],
  ] as const) {
    it(`a till still on ${version} (no counted_notes_json) applies the shift with nothing waiting, every column it has written`, async () => {
      const { a, shiftId } = closedOnA();
      const old = olderTill(stopBefore, 'till-old');
      const cols = (old.prepare(`PRAGMA table_info(shifts)`).all() as Row[]).map((c) => c['name']);
      expect(cols).not.toContain('counted_notes_json');
      const changes = await queued(a, TILL_A);
      expect(changes.filter((c) => c.entityType === 'shifts').at(-1)?.payload).toMatchObject({ countedNotesJson: EXAMPLE_JSON });
      await applyAll(old, changes);
      const { counted_notes_json: _text, ...asOnOld } = a.prepare(`SELECT * FROM shifts WHERE id = ?`).get(shiftId) as Row;
      expect(old.prepare(`SELECT * FROM shifts WHERE id = ?`).get(shiftId)).toEqual(asOnOld);
    });
  }

  it('an image without the key (an older till’s) gives NULL on a new row, and leaves a stored count alone', async () => {
    const { a, shiftId } = closedOnA();
    const changes = await queued(a, TILL_A);

    // A till on this version that hears of the shift only from an older till: no count, the rest as closed.
    const c = openTill('till-c', { usersFrom: TILL_A });
    await applyAll(c, changes.map(withoutCount));
    expect(c.prepare(`SELECT counted_notes_json FROM shifts WHERE id = ?`).get(shiftId)).toEqual({ counted_notes_json: null });
    expect(repo.findShift(c, shiftId)).toMatchObject({ countedCashCents: EXAMPLE_CENTS, countedNotes: null, closeNotes: 'Test close' });

    // A till that has the count, then a later image of the shift without the key: the count stays.
    const b = openTill('till-b', { usersFrom: TILL_A });
    await applyAll(b, changes);
    const { readRowImage } = await import('./replicable-schema.js');
    const later = withoutCount({
      entityType: 'shifts',
      entityId: shiftId,
      op: 'upsert',
      payload: { ...readRowImage(a, 'shifts', shiftId)!, version: 9, updatedAt: '2026-10-02T20:00:00.000Z', closeNotes: 'Test close, checked' },
      updatedAt: '2026-10-02T20:00:00.000Z',
      deviceId: TILL_A,
      version: 9,
    } as SyncChange);
    expect(later.payload).not.toHaveProperty('countedNotesJson');
    await applyAll(b, [later]);
    expect(b.prepare(`SELECT version, close_notes, counted_notes_json FROM shifts WHERE id = ?`).get(shiftId)).toEqual({
      version: 9,
      close_notes: 'Test close, checked',
      counted_notes_json: EXAMPLE_JSON,
    });
  });
});
