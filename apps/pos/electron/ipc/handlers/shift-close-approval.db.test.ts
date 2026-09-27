/**
 * Closing the shift, as the owner decided on 27 Sep 2026, through the real
 * shifts IPC handlers and shift repository on a database built from every
 * migration:
 *
 *   A. Cashiers never close. On a cashier's till the manager types their PIN
 *      or password (verifyManagerPin, the lockout rules unchanged) and the
 *      shift is closed by that manager; the audit row says it was approved
 *      with the manager's PIN on the cashier's till. The main process refuses
 *      a cashier with no PIN or a wrong one. The count stays blind: before
 *      the count the till hands over no money of the shift. A manager or the
 *      owner signed in closes as before.
 *   C. Unpaid orders on this till no longer block the close for good: the
 *      close box lists them, the manager gives one reason, and the shift
 *      closes; the orders stay unpaid for the next shift, each carried order
 *      gets an audit row (order, reason, approving manager, shift), and the
 *      shift row — synced like the rest — says how many and why. Without a
 *      reason the close is refused, as before.
 *
 * Only `defineHandler` is replaced (it captures the handler instead of
 * registering it with Electron); the session and the manager check are
 * stand-ins (auth-service owns PINs, passwords and their lockout, tested in
 * auth-service.db.test.ts), and the drawer pulse is a stand-in. node:sqlite
 * behind better-sqlite3's shape; skipped where it is missing. Every name and
 * amount is made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, BusinessReportRequest, Shift, ShiftCloseCheck, UUID } from '@cheeseoclock/shared-types';
import { DatabaseSync, openMigrated } from '../../db/costing-shop.fixture.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Handler = (ctx: unknown, payload: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown, payload: unknown) => Promise<unknown>>(),
  session: null as AuthenticatedUser | null,
  pinChecks: 0,
  webOrders: [] as Array<{ change: string }>,
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
      h.handlers.set(channel, async (ctx, payload) => fn(ctx, payload));
    },
  };
});
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, app: { getPath: () => '' } }));
// Who is signed in, and the manager check (auth-service owns the secrets and their lockout).
vi.mock('../../services/auth-service.js', () => ({
  getCurrentSession: () => h.session,
  verifyManagerPin: async (_db: unknown, pin: string) => {
    h.pinChecks += 1;
    if (pin === 'Manager-pass-7') return { approverUserId: 'u_mgr', approverName: 'Sara Manager' };
    throw new Error("That is not a manager's PIN or password");
  },
}));
// The drawer pulse: a printer is not what these tests are about.
vi.mock('../../services/print-spooler.js', () => ({
  printSpooler: {
    kickDrawerSoon: () => {},
    kickDrawerNow: async () => ({ ok: true, durationMs: 1 }),
  },
}));
// Website orders follow the shift (tested in web-orders-shift-pause.db.test.ts): recorded here only.
vi.mock('../../services/web-orders-shift-pause.js', () => ({
  followShiftForWebOrders: (_db: unknown, _device: string, change: string) => {
    h.webOrders.push({ change });
  },
}));

const DEV = 'dev-till-1';
const T0 = '2026-01-01T00:00:00.000Z';
const session = (id: string, fullName: string, role: AuthenticatedUser['role']): AuthenticatedUser => ({
  id: id as UUID,
  fullName,
  role,
  sessionId: `sess_${id}` as UUID,
});
const CASHIER = session('u_cash', 'Ali Cashier', 'cashier');
const MANAGER = session('u_mgr', 'Sara Manager', 'manager');
const OWNER = session('u_owner', 'The Owner', 'admin');
const PIN = 'Manager-pass-7';

let db: ReturnType<typeof openMigrated>;

async function call<T>(channel: string, payload: unknown): Promise<T> {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`No handler for ${channel}`);
  const r = (await fn({ db, deviceId: DEV }, payload)) as { ok: boolean; data: T };
  if (!r.ok) throw new Error(`${channel} said no: ${JSON.stringify(r)}`);
  return r.data;
}
const refusal = (channel: string, payload: unknown) =>
  h.handlers.get(channel)!({ db, deviceId: DEV }, payload).then(
    () => {
      throw new Error(`${channel} was not refused`);
    },
    (e: { apiError?: { code: string; message: string } }) => e.apiError,
  );
const row = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as T;
const rows = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[];

async function openShiftAs(who: AuthenticatedUser, float = 500_000): Promise<Shift> {
  h.session = who;
  return call<Shift>('shifts:open', { openingCashCents: float, notes: 'Evening shift, Ali on register' });
}

/** An order that went to the kitchen and was never paid. */
function unpaidOrder(id: string, no: string, opts: { createdAt: string; total: number; device?: string; source?: 'pos' | 'web' }) {
  db.prepare(
    `INSERT INTO orders (id, order_number, mode, status, cashier_id, subtotal_cents, discount_cents, tax_cents,
                         total_cents, source, paid_at, created_at, updated_at, device_id)
     VALUES (?, ?, 'delivery', 'out_for_delivery', 'u_cash', ?, 0, 0, ?, ?, NULL, ?, ?, ?)`,
  ).run(id, no, opts.total, opts.total, opts.source ?? 'pos', opts.createdAt, opts.createdAt, opts.device ?? DEV);
}

beforeEach(async () => {
  if (!DatabaseSync) return;
  h.handlers.clear();
  h.session = null;
  h.pinChecks = 0;
  h.webOrders.length = 0;
  db = openMigrated();
  const user = db.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, ?)`,
  );
  user.run('u_cash', 'Ali Cashier', 'cashier', T0, T0, DEV);
  user.run('u_mgr', 'Sara Manager', 'manager', T0, T0, DEV);
  user.run('u_owner', 'The Owner', 'admin', T0, T0, DEV);
  const { registerShiftsHandlers } = await import('./shifts-handlers.js');
  registerShiftsHandlers({ db, deviceId: DEV } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const live = describe.skipIf(!DatabaseSync);

live('A. a manager closes the shift on a cashier’s till with their PIN or password', () => {
  it('a cashier alone is refused, with no PIN or a wrong one; the shift stays open', async () => {
    const shift = await openShiftAs(CASHIER);
    h.session = CASHIER;
    for (const approverPin of [undefined, '', '   ']) {
      expect(await refusal('shifts:close', { shiftId: shift.id, countedCashCents: 500_000, ...(approverPin === undefined ? {} : { approverPin }) })).toMatchObject({
        code: 'forbidden',
        message: expect.stringContaining('Only a manager or the owner can close the shift'),
      });
      expect(await refusal('shifts:closeCheck', { shiftId: shift.id, ...(approverPin === undefined ? {} : { approverPin }) })).toMatchObject({
        code: 'forbidden',
      });
    }
    expect(await refusal('shifts:close', { shiftId: shift.id, countedCashCents: 500_000, approverPin: '1111' })).toEqual({
      code: 'forbidden',
      message: "That is not a manager's PIN or password",
    });
    expect(row<{ closed_at: string | null }>(`SELECT closed_at FROM shifts WHERE id = ?`, shift.id).closed_at).toBeNull();
    // Nothing was written about a close that did not happen.
    expect(rows(`SELECT 1 FROM audit_log WHERE action = 'shift_close'`)).toHaveLength(0);
  });

  it('the PIN step says who closes and lists nothing of the shift’s money (the count is blind)', async () => {
    const shift = await openShiftAs(CASHIER);
    h.session = CASHIER;
    const check = await call<ShiftCloseCheck>('shifts:closeCheck', { shiftId: shift.id, approverPin: PIN });
    expect(check).toEqual({ closerName: 'Sara Manager', viaManagerPin: true, unpaidOrders: [] });
    expect(JSON.stringify(check)).not.toMatch(/expected|cash/i);
    // The shift's totals stay refused to a cashier's login, PIN or not.
    expect(await refusal('shifts:summary', { shiftId: shift.id })).toMatchObject({ code: 'forbidden' });
  });

  it('the drawer opens to count only with the manager’s PIN, on record as approved by them', async () => {
    const shift = await openShiftAs(CASHIER);
    h.session = CASHIER;
    expect(await refusal('shifts:openDrawer', { kind: 'count' })).toMatchObject({ code: 'forbidden' });
    expect(await refusal('shifts:openDrawer', { kind: 'count', approverPin: '1111' })).toMatchObject({ code: 'forbidden' });
    await call('shifts:openDrawer', { kind: 'count', approverPin: PIN });
    // The float went in when the shift opened (the drawer log, 0042), then the count.
    expect(rows(`SELECT kind, user_id, approved_by_user_id, shift_id FROM drawer_opens ORDER BY rowid`)).toEqual([
      { kind: 'float', user_id: 'u_cash', approved_by_user_id: null, shift_id: shift.id },
      { kind: 'count', user_id: 'u_cash', approved_by_user_id: 'u_mgr', shift_id: shift.id },
    ]);
  });

  it('closed by the manager whose PIN was typed; the audit says it was their PIN on the cashier’s till', async () => {
    const shift = await openShiftAs(CASHIER);
    h.session = CASHIER;
    const closed = await call<Shift>('shifts:close', {
      shiftId: shift.id,
      countedCashCents: 490_000,
      notes: 'Rs 100 short, change given wrong',
      approverPin: PIN,
    });
    expect(closed).toMatchObject({
      closedByUserId: 'u_mgr',
      closedByName: 'Sara Manager',
      countedCashCents: 490_000,
      varianceCents: -10_000,
      notes: 'Evening shift, Ali on register',
      closeNotes: 'Rs 100 short, change given wrong',
      carriedUnpaidCount: 0,
      carryOverReason: null,
    });
    // The manager sees Over / Short; the expected cash does not go to the
    // cashier's screen. The shift row keeps it (Shift history, the owner).
    expect(closed.expectedCashCents).toBeNull();
    expect(row<{ expected_cash_cents: number }>(`SELECT expected_cash_cents FROM shifts WHERE id = ?`, shift.id)).toEqual({
      expected_cash_cents: 500_000,
    });
    const audit = row<{ actor_user_id: string; after_json: string }>(
      `SELECT actor_user_id, after_json FROM audit_log WHERE action = 'shift_close' AND entity_id = ?`,
      shift.id,
    );
    expect(audit.actor_user_id).toBe('u_mgr');
    expect(JSON.parse(audit.after_json)).toMatchObject({
      closedByUserId: 'u_mgr',
      approval: { via: 'manager_pin', tillSignedInUserId: 'u_cash' },
    });
    // Website orders were told the till's last shift closed.
    expect(h.webOrders).toEqual([{ change: 'opened' }, { change: 'closed' }]);
  });

  it('a manager or the owner signed in closes as before: no PIN asked, none checked, no approval in the audit', async () => {
    for (const who of [MANAGER, OWNER]) {
      const shift = await openShiftAs(who);
      h.session = who;
      const before = h.pinChecks;
      const check = await call<ShiftCloseCheck>('shifts:closeCheck', { shiftId: shift.id });
      expect(check).toEqual({ closerName: who.fullName, viaManagerPin: false, unpaidOrders: [] });
      const closed = await call<Shift>('shifts:close', { shiftId: shift.id, countedCashCents: 500_000 });
      expect(closed.closedByUserId).toBe(who.id);
      // Their own login: the expected cash comes back, as it always did.
      expect(closed.expectedCashCents).toBe(500_000);
      expect(h.pinChecks).toBe(before);
      const audit = row<{ after_json: string }>(
        `SELECT after_json FROM audit_log WHERE action = 'shift_close' AND entity_id = ?`,
        shift.id,
      );
      expect(JSON.parse(audit.after_json)).not.toHaveProperty('approval');
    }
  });

  it('a manager’s PIN is checked again at the close itself (the renderer is not trusted with it)', async () => {
    const shift = await openShiftAs(CASHIER);
    h.session = CASHIER;
    await call('shifts:closeCheck', { shiftId: shift.id, approverPin: PIN });
    expect(await refusal('shifts:close', { shiftId: shift.id, countedCashCents: 1, approverPin: 'not-it' })).toMatchObject({
      code: 'forbidden',
    });
    expect(row<{ closed_at: string | null }>(`SELECT closed_at FROM shifts WHERE id = ?`, shift.id).closed_at).toBeNull();
  });
});

live('C. unpaid orders are carried over to the next shift with a manager’s reason', () => {
  beforeEach(() => {
    if (!DatabaseSync) return;
    // On this till: a rider still out from two days ago, and a website order from tonight.
    unpaidOrder('o_old', '20260925-0042', { createdAt: '2026-09-25T15:00:00.000Z', total: 124_000 });
    unpaidOrder('o_web', '20260927-0007', { createdAt: '2026-09-27T16:30:00.000Z', total: 86_000, source: 'web' });
    // Not carried: another till's unpaid order, a paid one, a cancelled one.
    unpaidOrder('o_other_till', '20260927-0100', { createdAt: '2026-09-27T16:00:00.000Z', total: 50_000, device: 'dev-till-2' });
    db.prepare(
      `INSERT INTO orders (id, order_number, mode, status, cashier_id, total_cents, source, paid_at, created_at, updated_at, device_id)
       VALUES ('o_paid', '20260927-0008', 'takeaway', 'paid', 'u_cash', 40000, 'pos', ?, ?, ?, ?),
              ('o_void', '20260927-0009', 'takeaway', 'void', 'u_cash', 40000, 'pos', NULL, ?, ?, ?)`,
    ).run(T0, T0, T0, DEV, T0, T0, DEV);
  });

  it('the close box lists them: number, when, total and who took them, oldest first', async () => {
    const shift = await openShiftAs(MANAGER);
    const check = await call<ShiftCloseCheck>('shifts:closeCheck', { shiftId: shift.id });
    expect(check.unpaidOrders).toEqual([
      { orderId: 'o_old', orderNumber: '20260925-0042', createdAt: '2026-09-25T15:00:00.000Z', totalCents: 124_000, takenBy: 'Ali Cashier' },
      { orderId: 'o_web', orderNumber: '20260927-0007', createdAt: '2026-09-27T16:30:00.000Z', totalCents: 86_000, takenBy: 'Website' },
    ]);
  });

  it('without a reason the close is refused, naming them; nothing is written', async () => {
    const shift = await openShiftAs(MANAGER);
    for (const carryOverReason of [undefined, null, '', '   ']) {
      const r = await refusal('shifts:close', { shiftId: shift.id, countedCashCents: 500_000, carryOverReason });
      expect(r).toMatchObject({ code: 'precondition_failed' });
      expect(r?.message).toContain('2 orders on this till are not paid yet (#0042, #0007)');
      expect(r?.message).toContain('Give a reason to carry them over to the next shift');
    }
    expect(row<{ closed_at: string | null }>(`SELECT closed_at FROM shifts WHERE id = ?`, shift.id).closed_at).toBeNull();
    expect(rows(`SELECT 1 FROM audit_log WHERE action IN ('shift_close', 'carried_over_unpaid')`)).toHaveLength(0);
  });

  it('with a reason the shift closes; the orders stay unpaid; each has its audit row; the synced shift row says how many and why', async () => {
    const shift = await openShiftAs(MANAGER);
    const closed = await call<Shift>('shifts:close', {
      shiftId: shift.id,
      countedCashCents: 500_000,
      carryOverReason: '  Rider still out, customer pays tomorrow  ',
    });
    expect(closed).toMatchObject({ closedByUserId: 'u_mgr', carriedUnpaidCount: 2, carryOverReason: 'Rider still out, customer pays tomorrow' });

    // Still unpaid, still where they were on the board.
    expect(rows(`SELECT id, status, paid_at FROM orders WHERE id IN ('o_old', 'o_web') ORDER BY id`)).toEqual([
      { id: 'o_old', status: 'out_for_delivery', paid_at: null },
      { id: 'o_web', status: 'out_for_delivery', paid_at: null },
    ]);

    // One audit row per carried order: the order, the reason, who approved, which shift.
    const carried = rows<{ entity_type: string; entity_id: string; actor_user_id: string; after_json: string }>(
      `SELECT entity_type, entity_id, actor_user_id, after_json FROM audit_log WHERE action = 'carried_over_unpaid' ORDER BY entity_id`,
    );
    expect(carried.map((c) => [c.entity_type, c.entity_id, c.actor_user_id])).toEqual([
      ['orders', 'o_old', 'u_mgr'],
      ['orders', 'o_web', 'u_mgr'],
    ]);
    expect(JSON.parse(carried[0]!.after_json)).toMatchObject({
      orderId: 'o_old',
      orderNumber: '20260925-0042',
      reason: 'Rider still out, customer pays tomorrow',
      approvedByUserId: 'u_mgr',
      shiftId: shift.id,
    });

    // The close's sync row carries the post-image, carried-over fields and close note included.
    const sync = row<{ payload_json: string }>(
      `SELECT payload_json FROM sync_queue WHERE entity_type = 'shifts' AND entity_id = ? ORDER BY rowid DESC LIMIT 1`,
      shift.id,
    );
    expect(JSON.parse(sync.payload_json)).toMatchObject({
      closedByUserId: 'u_mgr',
      carriedUnpaidCount: 2,
      carryOverReason: 'Rider still out, customer pays tomorrow',
    });

    // The audit chain is still whole, every row hashed (writeAudit wrote them all).
    const { verifyAuditChain } = await import('../../db/audit-chain.js');
    const chain = rows<Record<string, unknown>>(
      `SELECT rowid, id, entity_type AS entityType, entity_id AS entityId, action, actor_user_id AS actorUserId,
              before_json AS beforeJson, after_json AS afterJson, ip, created_at AS createdAt,
              prev_hash AS prevHash, row_hash AS rowHash
         FROM audit_log ORDER BY rowid`,
    );
    expect(verifyAuditChain(chain as never)).toMatchObject({ ok: true, legacyRows: 0, brokenAt: null });
  });

  it('an order that came in unpaid during the count is not carried over on a reason given for the others', async () => {
    const shift = await openShiftAs(MANAGER);
    const shown = (await call<ShiftCloseCheck>('shifts:closeCheck', { shiftId: shift.id })).unpaidOrders.map((o) => o.orderId);
    expect(shown).toEqual(['o_old', 'o_web']);
    // While the manager counts, a website order is imported (sent to the kitchen, not paid).
    unpaidOrder('o_new', '20260927-0010', { createdAt: '2026-09-27T21:00:00.000Z', total: 99_000, source: 'web' });

    const r = await refusal('shifts:close', {
      shiftId: shift.id,
      countedCashCents: 500_000,
      carryOverReason: 'Rider still out',
      carryOverOrderIds: shown,
    });
    expect(r).toEqual({
      code: 'precondition_failed',
      message: 'An order came in unpaid while you were counting (#0010). Check the list of unpaid orders, then close the shift again.',
    });
    // Nothing closed, nothing on record as approved.
    expect(row<{ closed_at: string | null }>(`SELECT closed_at FROM shifts WHERE id = ?`, shift.id).closed_at).toBeNull();
    expect(rows(`SELECT 1 FROM audit_log WHERE action IN ('shift_close', 'carried_over_unpaid')`)).toHaveLength(0);

    // The box asks again, the manager sees all three and closes.
    const again = (await call<ShiftCloseCheck>('shifts:closeCheck', { shiftId: shift.id })).unpaidOrders.map((o) => o.orderId);
    expect(again).toEqual(['o_old', 'o_web', 'o_new']);
    const closed = await call<Shift>('shifts:close', {
      shiftId: shift.id,
      countedCashCents: 500_000,
      carryOverReason: 'Rider still out; the web order is cooking',
      carryOverOrderIds: again,
    });
    expect(closed.carriedUnpaidCount).toBe(3);
  });

  it('none shown, one came in: refused as new — not a "give a reason" the box never asked for', async () => {
    db.prepare(`UPDATE orders SET paid_at = ?, status = 'paid' WHERE id IN ('o_old', 'o_web')`).run('2026-09-27T20:00:00.000Z');
    const shift = await openShiftAs(MANAGER);
    const shown = (await call<ShiftCloseCheck>('shifts:closeCheck', { shiftId: shift.id })).unpaidOrders;
    expect(shown).toEqual([]);
    unpaidOrder('o_new', '20260927-0010', { createdAt: '2026-09-27T21:00:00.000Z', total: 99_000, source: 'web' });
    expect(await refusal('shifts:close', { shiftId: shift.id, countedCashCents: 500_000, carryOverOrderIds: [] })).toMatchObject({
      code: 'precondition_failed',
      message: expect.stringContaining('An order came in unpaid while you were counting (#0010)'),
    });
  });

  it('one paid off during the count is simply not carried; only the ones shown and still unpaid are', async () => {
    const shift = await openShiftAs(MANAGER);
    const shown = (await call<ShiftCloseCheck>('shifts:closeCheck', { shiftId: shift.id })).unpaidOrders.map((o) => o.orderId);
    db.prepare(`UPDATE orders SET paid_at = ?, status = 'paid' WHERE id = 'o_web'`).run('2026-09-27T21:00:00.000Z');
    const closed = await call<Shift>('shifts:close', {
      shiftId: shift.id,
      countedCashCents: 500_000,
      carryOverReason: 'Rider still out',
      carryOverOrderIds: shown,
    });
    expect(closed).toMatchObject({ carriedUnpaidCount: 1, carryOverReason: 'Rider still out' });
    expect(rows<{ entity_id: string }>(`SELECT entity_id FROM audit_log WHERE action = 'carried_over_unpaid'`)).toEqual([
      { entity_id: 'o_old' },
    ]);
  });

  it('on a cashier’s till the manager’s PIN approves the carry-over too, in the manager’s name', async () => {
    const shift = await openShiftAs(CASHIER);
    h.session = CASHIER;
    const check = await call<ShiftCloseCheck>('shifts:closeCheck', { shiftId: shift.id, approverPin: PIN });
    expect(check.unpaidOrders.map((o) => o.orderId)).toEqual(['o_old', 'o_web']);
    await call('shifts:close', { shiftId: shift.id, countedCashCents: 500_000, approverPin: PIN, carryOverReason: 'Rider still out' });
    const carried = rows<{ actor_user_id: string; after_json: string }>(
      `SELECT actor_user_id, after_json FROM audit_log WHERE action = 'carried_over_unpaid'`,
    );
    expect(carried).toHaveLength(2);
    for (const c of carried) {
      expect(c.actor_user_id).toBe('u_mgr');
      expect(JSON.parse(c.after_json)).toMatchObject({ approval: { via: 'manager_pin', tillSignedInUserId: 'u_cash' } });
    }
  });

  it('they carry over: the next shift’s close lists them again, and a close with nothing unpaid asks no reason', async () => {
    const first = await openShiftAs(MANAGER);
    await call('shifts:close', { shiftId: first.id, countedCashCents: 500_000, carryOverReason: 'Rider still out' });
    const next = await openShiftAs(MANAGER);
    expect((await call<ShiftCloseCheck>('shifts:closeCheck', { shiftId: next.id })).unpaidOrders).toHaveLength(2);
    // Paid meanwhile (on whichever shift took the money): nothing is left to carry.
    db.prepare(`UPDATE orders SET paid_at = ?, status = 'paid' WHERE id IN ('o_old', 'o_web')`).run('2026-09-28T10:00:00.000Z');
    const closed = await call<Shift>('shifts:close', { shiftId: next.id, countedCashCents: 500_000 });
    expect(closed).toMatchObject({ carriedUnpaidCount: 0, carryOverReason: null });
  });

  it('Shift history (owner-only Reports → Team & leakage) has the count, the reason and who approved it', async () => {
    const shift = await openShiftAs(MANAGER);
    await call('shifts:close', { shiftId: shift.id, countedCashCents: 500_000, notes: 'All good', carryOverReason: 'Rider still out' });
    const tabs = await import('../../services/analytics/report-tabs.js');
    const range: BusinessReportRequest = { sinceIso: '2000-01-01T00:00:00.000Z', untilIso: '2100-01-01T00:00:00.000Z' };
    const line = tabs.buildReportTab(db as never, 'team', range, new Date()).shifts.find((s) => s.id === shift.id);
    expect(line).toMatchObject({
      closedBy: 'Sara Manager',
      carriedUnpaidCount: 2,
      carryOverReason: 'Rider still out',
      openingNote: 'Evening shift, Ali on register',
      closingNote: 'All good',
    });
  });
});
