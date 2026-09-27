/**
 * document-print-repo on a real database built from every migration (0030
 * included), foreign keys on: each paper in the print log is one row, one
 * sync entry and one hash-chained audit entry, written together — and the
 * chain still verifies. Plus how the log counts papers the version before it
 * printed, and the per-order "printed by hand" counts for Order History.
 *
 * node's own `node:sqlite` (better-sqlite3 here is built for Electron);
 * skipped where that is missing. Names and ids are made up.
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from './connection.js';
import { verifyAuditChain, type AuditChainRow } from './audit-chain.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));

interface Stmt {
  run(...p: unknown[]): unknown;
  all(...p: unknown[]): Array<Record<string, unknown>>;
  get(...p: unknown[]): Record<string, unknown> | undefined;
}
interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
}
type RawDbCtor = new (path: string) => RawDb;
let DatabaseSync: RawDbCtor | null = null;
try {
  DatabaseSync = (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: RawDbCtor }).DatabaseSync;
} catch {
  DatabaseSync = null;
}
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

function openMigrated(): AppDatabase {
  if (!DatabaseSync) throw new Error('node:sqlite unavailable');
  const raw = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
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
  } as unknown as AppDatabase;
}

const DEV = 'dev-till-1';
const T0 = '2026-01-01T00:00:00.000Z';

let db: AppDatabase;
beforeEach(() => {
  if (!DatabaseSync) return;
  db = openMigrated();
  const user = db.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, ?)`,
  );
  user.run('u_cash', 'Ali Akbar', 'cashier', T0, T0, DEV);
  user.run('u_mgr', 'Sana Khan', 'manager', T0, T0, DEV);
  for (const [oid, paidAt] of [
    ['o1', '2026-09-26T14:35:00.000Z'],
    ['o2', null],
  ] as const) {
    db.prepare(
      `INSERT INTO orders (id, order_number, mode, status, cashier_id, subtotal_cents, discount_cents, tax_cents,
                           total_cents, source, paid_at, created_at, updated_at, device_id)
       VALUES (?, ?, 'takeaway', ?, 'u_cash', 100000, 0, 16000, 116000, 'pos', ?, ?, ?, ?)`,
    ).run(oid, `20260926-00${oid.slice(1)}`, paidAt ? 'paid' : 'sent_to_kitchen', paidAt, T0, T0, DEV);
  }
});

const repo = () => import('./repositories/document-print-repo.js');
type Row = Record<string, unknown>;
const n = (sql: string, ...p: unknown[]) => Number((db.prepare(sql).get(...p) as Row)['n']);

function auditRows(): AuditChainRow[] {
  return db
    .prepare(
      `SELECT rowid, id, entity_type AS entityType, entity_id AS entityId, action,
              actor_user_id AS actorUserId, before_json AS beforeJson, after_json AS afterJson,
              ip, created_at AS createdAt, prev_hash AS prevHash, row_hash AS rowHash
         FROM audit_log ORDER BY rowid`,
    )
    .all() as unknown as AuditChainRow[];
}

const paper = (extra: Record<string, unknown> = {}) => ({
  orderId: 'o1',
  orderNumber: '20260926-0001',
  document: 'receipt' as const,
  docKey: 'receipt',
  copy: 'customer' as const,
  printNo: 0,
  outcome: 'printed' as const,
  reason: 'payment' as const,
  requestedByUserId: 'u_cash',
  approvedByUserId: null,
  printJobId: 'job-1',
  ...extra,
});

describe.skipIf(!DatabaseSync)('the print log: row + sync + audit together', () => {
  it('writes one row, one sync entry and one chained audit entry per paper', async () => {
    const { recordDocumentPrint } = await repo();
    const first = recordDocumentPrint(db, paper(), DEV);
    const dup = recordDocumentPrint(
      db,
      paper({ printNo: 1, reason: 'reprint', requestedByUserId: 'u_cash', approvedByUserId: 'u_mgr', printJobId: 'job-2', fbrIrn: 'IRN-1' }),
      DEV,
    );
    const unsure = recordDocumentPrint(db, paper({ printNo: 2, outcome: 'unsure', reason: 'reprint', printJobId: 'job-3' }), DEV);

    const row = db.prepare(`SELECT * FROM document_prints WHERE id = ?`).get(dup) as Row;
    expect(row).toMatchObject({
      order_id: 'o1',
      document: 'receipt',
      doc_key: 'receipt',
      copy: 'customer',
      print_no: 1,
      outcome: 'printed',
      reason: 'reprint',
      requested_by_user_id: 'u_cash',
      approved_by_user_id: 'u_mgr',
      print_job_id: 'job-2',
      fbr_irn: 'IRN-1',
      device_id: DEV,
      version: 1,
    });
    for (const idv of [first, dup, unsure]) {
      expect(n(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'document_prints' AND entity_id = ?`, idv)).toBe(1);
    }
    const audit = db
      .prepare(`SELECT entity_id AS id, action, actor_user_id AS actor, after_json AS after FROM audit_log WHERE entity_type = 'document_prints' ORDER BY rowid`)
      .all() as Row[];
    expect(audit.map((a) => a['action'])).toEqual(['print_original', 'print_duplicate', 'print_unsure']);
    expect(audit[1]!['actor']).toBe('u_cash');
    expect(JSON.parse(String(audit[1]!['after']))).toMatchObject({
      orderId: 'o1',
      orderNumber: '20260926-0001',
      document: 'receipt',
      copy: 'customer',
      printNo: 1,
      reason: 'reprint',
      outcome: 'printed',
      requestedByUserId: 'u_cash',
      approvedByUserId: 'u_mgr',
      deviceId: DEV,
    });
    expect(verifyAuditChain(auditRows()).ok).toBe(true);
  });

  it('lists a series oldest first; the SHOP COPY and a refund are their own series', async () => {
    const { recordDocumentPrint, listSeriesPrints, docKeyFor } = await repo();
    recordDocumentPrint(db, paper(), DEV);
    recordDocumentPrint(db, paper({ copy: 'shop' }), DEV);
    recordDocumentPrint(db, paper({ document: 'refund', docKey: docKeyFor('refund', '2026-09-26T15:00:00.000Z') }), DEV);
    recordDocumentPrint(db, paper({ printNo: 1, reason: 'reprint', printJobId: 'job-9' }), DEV);
    expect(listSeriesPrints(db, 'o1', 'receipt', 'customer').map((r) => [r.printNo, r.reason])).toEqual([
      [0, 'payment'],
      [1, 'reprint'],
    ]);
    expect(listSeriesPrints(db, 'o1', 'receipt', 'shop')).toHaveLength(1);
    expect(listSeriesPrints(db, 'o1', 'refund:2026-09-26T15:00:00.000Z', 'customer')).toHaveLength(1);
  });

  it('counts DUPLICATE papers printed by hand per order, one per press, for Order History', async () => {
    const { recordDocumentPrint, reprintCounts } = await repo();
    recordDocumentPrint(db, paper(), DEV);
    recordDocumentPrint(db, paper({ printNo: 1, reason: 'reprint', printJobId: 'j2' }), DEV);
    recordDocumentPrint(db, paper({ printNo: 2, reason: 'reprint', printJobId: 'j3' }), DEV);
    // A printer retry is not someone pressing Reprint.
    recordDocumentPrint(db, paper({ printNo: 3, outcome: 'unsure', reason: 'payment', printJobId: 'j4' }), DEV);
    // One press the printer fumbled (unsure), printed on the retry: ONE reprint, not two.
    recordDocumentPrint(db, paper({ printNo: 4, outcome: 'unsure', reason: 'reprint', printJobId: 'j5' }), DEV);
    recordDocumentPrint(db, paper({ printNo: 5, outcome: 'printed', reason: 'reprint', printJobId: 'j5' }), DEV);
    // Originals printed with the button are not reprints: a table's first
    // bill, and a first receipt printed by hand long after the sale…
    recordDocumentPrint(db, paper({ orderId: 'o2', document: 'bill', docKey: 'bill', reason: 'reprint', printJobId: 'j6' }), DEV);
    recordDocumentPrint(db, paper({ orderId: 'o2', reason: 'reprint', printJobId: 'j7' }), DEV);
    // …nor is the retry of a fumbled original (it says "printer retry", no one pressed twice).
    recordDocumentPrint(db, paper({ orderId: 'o2', document: 'bill', docKey: 'bill', copy: 'shop', outcome: 'unsure', reason: 'reprint', printJobId: 'j8' }), DEV);
    recordDocumentPrint(db, paper({ orderId: 'o2', document: 'bill', docKey: 'bill', copy: 'shop', printNo: 1, reason: 'reprint', printJobId: 'j8' }), DEV);
    // Kitchen reprints are not counted here.
    recordDocumentPrint(db, paper({ document: 'kitchen', docKey: 'kitchen', copy: 'kitchen', printNo: 1, reason: 'reprint', printJobId: 'j9' }), DEV);
    expect(reprintCounts(db, ['o1', 'o2', 'nope'])).toEqual({ o1: 3 });
    // The bill printed again: now o2 has a DUPLICATE by hand.
    recordDocumentPrint(db, paper({ orderId: 'o2', document: 'bill', docKey: 'bill', printNo: 1, reason: 'reprint', printJobId: 'j10' }), DEV);
    expect(reprintCounts(db, ['o1', 'o2'])).toEqual({ o1: 3, o2: 1 });
    expect(reprintCounts(db, [])).toEqual({});
  });

  it("the owner's rule: a first paper printed by hand says DUPLICATE (print_no 1) but is not a reprint; the next press is", async () => {
    const { recordDocumentPrint, reprintCounts } = await repo();
    for (const oid of ['o3', 'o4', 'o5']) {
      db.prepare(
        `INSERT INTO orders (id, order_number, mode, status, cashier_id, subtotal_cents, discount_cents, tax_cents,
                             total_cents, source, paid_at, created_at, updated_at, device_id)
         VALUES (?, ?, 'dine_in', 'served', 'u_cash', 100000, 0, 16000, 116000, 'pos', NULL, ?, ?, ?)`,
      ).run(oid, `20260926-00${oid.slice(1)}`, T0, T0, DEV);
    }
    // A table's only bill, printed from the board: logged as a DUPLICATE…
    recordDocumentPrint(db, paper({ orderId: 'o3', document: 'bill', docKey: 'bill', printNo: 1, reason: 'reprint', printJobId: 'k1' }), DEV);
    // …its shop copy is its own series, and so is the paid receipt (different papers).
    recordDocumentPrint(db, paper({ orderId: 'o3', document: 'bill', docKey: 'bill', copy: 'shop', printNo: 1, reason: 'reprint', printJobId: 'k2' }), DEV);
    recordDocumentPrint(db, paper({ orderId: 'o3', document: 'receipt', docKey: 'receipt', printNo: 1, reason: 'reprint', printJobId: 'k3' }), DEV);
    expect(reprintCounts(db, ['o3'])).toEqual({});
    // The same bill pressed for again: that one is a reprint (print_no 1 too — one paper before it).
    recordDocumentPrint(db, paper({ orderId: 'o3', document: 'bill', docKey: 'bill', printNo: 1, reason: 'reprint', printJobId: 'k4' }), DEV);
    expect(reprintCounts(db, ['o3'])).toEqual({ o3: 1 });
    // A press fumbled then printed on the retry is still one press, and its own first try is not "earlier".
    recordDocumentPrint(db, paper({ orderId: 'o4', printNo: 1, outcome: 'unsure', reason: 'reprint', printJobId: 'k5' }), DEV);
    recordDocumentPrint(db, paper({ orderId: 'o4', printNo: 1, reason: 'reprint', printJobId: 'k5' }), DEV);
    expect(reprintCounts(db, ['o4'])).toEqual({});
    // An earlier paper that came from the other till (synced, a later rowid but an earlier time) counts.
    recordDocumentPrint(db, paper({ orderId: 'o5', printNo: 1, reason: 'reprint', printJobId: 'k6' }), DEV);
    expect(reprintCounts(db, ['o5'])).toEqual({});
    recordDocumentPrint(db, paper({ orderId: 'o5', printJobId: 'k7' }), DEV);
    db.prepare(`UPDATE document_prints SET created_at = '2020-01-01T00:00:00.000Z' WHERE print_job_id = 'k7'`).run();
    expect(reprintCounts(db, ['o5'])).toEqual({ o5: 1 });
  });

  it("keeps the FBR number's QR and kind with it; the newest customer receipt's number is what another till reprints", async () => {
    const { recordDocumentPrint, latestLoggedSaleFbr } = await repo();
    expect(latestLoggedSaleFbr(db, 'o1')).toBeNull();
    // The shop copy and a refund slip (its debit note) are not the sale's number.
    recordDocumentPrint(db, paper({ copy: 'shop', fbrIrn: 'NOT-THIS', printJobId: 'a' }), DEV);
    recordDocumentPrint(db, paper({ document: 'refund', docKey: 'refund:x', fbrIrn: 'DEBIT-1', fbrQrPayload: 'qr-d', fbrMode: 'production', printJobId: 'b' }), DEV);
    expect(latestLoggedSaleFbr(db, 'o1')).toBeNull();
    const idv = recordDocumentPrint(
      db,
      paper({ fbrIrn: 'IRN-7', fbrQrPayload: 'https://verify.example/IRN-7', fbrMode: 'production', printJobId: 'c' }),
      'dev-till-2',
    );
    expect(db.prepare(`SELECT fbr_irn, fbr_qr_payload, fbr_mode FROM document_prints WHERE id = ?`).get(idv)).toEqual({
      fbr_irn: 'IRN-7',
      fbr_qr_payload: 'https://verify.example/IRN-7',
      fbr_mode: 'production',
    });
    expect(latestLoggedSaleFbr(db, 'o1')).toEqual({ irn: 'IRN-7', qrPayload: 'https://verify.example/IRN-7', mode: 'production' });
    // A QR or mode without a number is never kept.
    const bare = recordDocumentPrint(db, paper({ fbrQrPayload: 'stray', fbrMode: 'sandbox', printJobId: 'd' }), DEV);
    expect(db.prepare(`SELECT fbr_qr_payload AS q, fbr_mode AS m FROM document_prints WHERE id = ?`).get(bare)).toEqual({ q: null, m: null });
    // The sync entry (a row image) carries the new columns to the other till.
    const image = JSON.parse(
      String((db.prepare(`SELECT payload_json AS p FROM sync_queue WHERE entity_id = ?`).get(idv) as Row)['p']),
    ) as Record<string, unknown>;
    expect(JSON.stringify(image)).toContain('https://verify.example/IRN-7');
    expect(verifyAuditChain(auditRows()).ok).toBe(true);
  });
});

describe.skipIf(!DatabaseSync)('papers the version before the log printed', () => {
  function legacyJob(idv: string, kind: string, payload: Record<string, unknown>, plan: string | null = '"legacy"', status = 'done') {
    db.prepare(
      `INSERT INTO print_queue (id, job_kind, order_id, payload_json, status, attempts, next_attempt_at, created_at, updated_at, completed_at, sending_plan_json)
       VALUES (?, ?, 'o1', ?, ?, 0, ?, ?, ?, ?, ?)`,
    ).run(idv, kind, JSON.stringify({ orderId: 'o1', ...payload }), status, T0, T0, T0, T0, plan);
  }

  it('counts only finished receipt / kitchen jobs the migration marked — never drawers, refunds or new jobs', async () => {
    const { legacyPrintCount } = await repo();
    db.prepare(`UPDATE settings SET value_json = ? WHERE key = 'printing.printLogSince'`).run(JSON.stringify(T0));
    legacyJob('a', 'receipt', { reason: 'payment', copies: ['customer', 'shop'] });
    legacyJob('b', 'receipt', { reason: 'refund', copies: ['customer'] });
    legacyJob('c', 'kitchen', { reprint: false });
    legacyJob('d', 'kitchen', { cancelled: true });
    legacyJob('e', 'drawer', {});
    // Done by this version (plan cleared): not legacy.
    legacyJob('f', 'receipt', { reason: 'reprint', copies: ['customer'] }, null);
    const q = (document: 'receipt' | 'bill' | 'kitchen' | 'refund', copy: 'customer' | 'shop' | 'kitchen') =>
      legacyPrintCount(db, { orderId: 'o1', document, copy, paidAt: '2026-09-26T14:35:00.000Z' });
    expect(q('receipt', 'customer')).toBe(1);
    expect(q('receipt', 'shop')).toBe(1);
    expect(q('kitchen', 'kitchen')).toBe(1);
    expect(q('refund', 'customer')).toBe(0);
  });

  it('marks the old finished jobs when the migration runs', () => {
    if (!DatabaseSync) return;
    const raw = new DatabaseSync(':memory:');
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files.filter((x) => x < '0030')) raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
    const ins = raw.prepare(
      `INSERT INTO print_queue (id, job_kind, order_id, payload_json, status, attempts, last_error, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, 'o1', '{}', ?, 0, ?, ?, ?, ?)`,
    );
    ins.run('r-done', 'receipt', 'done', null, T0, T0, T0);
    ins.run('k-done', 'kitchen', 'done', null, T0, T0, T0);
    ins.run('d-done', 'drawer', 'done', null, T0, T0, T0);
    ins.run('d-served', 'drawer', 'done', 'Not sent: the drawer was opened after this sale by another pulse', T0, T0, T0);
    ins.run('r-failed', 'receipt', 'failed', 'offline', T0, T0, T0);
    ins.run('r-pending', 'receipt', 'pending', null, T0, T0, T0);
    for (const f of files.filter((x) => x >= '0030')) raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
    const marked = raw
      .prepare(`SELECT id FROM print_queue WHERE sending_plan_json = '"legacy"' ORDER BY id`)
      .all()
      .map((r) => r['id']);
    expect(marked).toEqual(['k-done', 'r-done']);
    const since = raw.prepare(`SELECT value_json AS v FROM settings WHERE key = 'printing.printLogSince'`).get();
    expect(typeof JSON.parse(String(since?.['v']))).toBe('string');
  });

  it('a receipt paid before the log started, with nothing left from then, counts once; a newer one does not', async () => {
    const { legacyPrintCount } = await repo();
    db.prepare(`UPDATE settings SET value_json = ? WHERE key = 'printing.printLogSince'`).run(
      JSON.stringify('2026-09-27T00:00:00.000Z'),
    );
    const before = { orderId: 'o1', document: 'receipt' as const, copy: 'customer' as const, paidAt: '2026-09-26T14:35:00.000Z' };
    expect(legacyPrintCount(db, before)).toBe(1);
    expect(legacyPrintCount(db, { ...before, paidAt: '2026-09-27T09:00:00.000Z' })).toBe(0);
    // Never for the kitchen, a bill or the shop copy by date alone.
    expect(legacyPrintCount(db, { ...before, document: 'kitchen', copy: 'kitchen' })).toBe(0);
    expect(legacyPrintCount(db, { ...before, document: 'bill' })).toBe(0);
    expect(legacyPrintCount(db, { ...before, copy: 'shop' })).toBe(0);
    // Failed jobs are kept 30 days, done ones 14: a failed drawer pulse,
    // kitchen ticket or refund slip left from then says nothing about the
    // receipt — the old version still printed it.
    legacyJob('fd', 'drawer', {}, null, 'failed');
    legacyJob('fk', 'kitchen', { reprint: false }, null, 'failed');
    legacyJob('fr', 'receipt', { reason: 'refund', copies: ['customer'] }, null, 'failed');
    legacyJob('fs', 'receipt', { reason: 'payment', copies: ['shop'] }, null, 'failed');
    expect(legacyPrintCount(db, before)).toBe(1);
    // A customer receipt job from before the log that failed: the old version did NOT print it.
    legacyJob('x', 'receipt', { reason: 'payment' }, null, 'failed');
    expect(legacyPrintCount(db, before)).toBe(0);
  });
});

describe.skipIf(!DatabaseSync)('the print log on the Reports page', () => {
  it('counts DUPLICATE papers printed by hand per person, one per press, and marks cancelled orders whose bill had been printed', async () => {
    const { recordDocumentPrint } = await repo();
    const { withHandPrints, withBillPrinted } = await import('../services/print-report.js');
    recordDocumentPrint(db, paper(), DEV);
    recordDocumentPrint(db, paper({ printNo: 1, reason: 'reprint', printJobId: 'j2' }), DEV);
    recordDocumentPrint(db, paper({ printNo: 2, reason: 'reprint', requestedByUserId: 'u_mgr', printJobId: 'j3' }), DEV);
    // Every table's first bill is printed with the button: an original, not a reprint.
    recordDocumentPrint(db, paper({ orderId: 'o2', document: 'bill', docKey: 'bill', reason: 'reprint', printJobId: 'j4' }), DEV);
    // A kitchen reprint and a printer retry are not counted.
    recordDocumentPrint(db, paper({ document: 'kitchen', docKey: 'kitchen', copy: 'kitchen', printNo: 1, reason: 'reprint', printJobId: 'j5' }), DEV);
    recordDocumentPrint(db, paper({ printNo: 3, outcome: 'unsure', reason: 'payment', printJobId: 'j6' }), DEV);
    // One press by the cashier, fumbled then printed: counted once.
    recordDocumentPrint(db, paper({ printNo: 4, outcome: 'unsure', reason: 'reprint', printJobId: 'j7' }), DEV);
    recordDocumentPrint(db, paper({ printNo: 5, reason: 'reprint', printJobId: 'j7' }), DEV);
    const range = { sinceIso: '2020-01-01T00:00:00.000Z', untilIso: '2100-01-01T00:00:00.000Z' };
    const staff = withHandPrints(
      db,
      range,
      [{ key: 'u_cash', name: 'Ali Akbar', isWebsite: false, orderCount: 3, netSalesCents: 1, discountCents: 0, voidCount: 0, noSaleOpens: 0 }],
      (userId) => (userId === 'u_mgr' ? 'Sana Khan' : null),
    );
    expect(staff.map((s) => [s.name, s.reprints])).toEqual([
      ['Ali Akbar', 2],
      ['Sana Khan', 1],
    ]);
    expect(withHandPrints(db, { sinceIso: '2099-01-01T00:00:00.000Z', untilIso: '2100-01-01T00:00:00.000Z' }, [], () => null)).toEqual([]);
    expect(withBillPrinted(db, [{ orderId: 'o1' }, { orderId: 'o2' }]).map((v) => v.billPrinted)).toEqual([false, true]);
  });
});
