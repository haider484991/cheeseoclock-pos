/**
 * The owner's phone dashboard, end to end through the route handlers on a
 * real Postgres (PGlite, in memory, with db/schema.sql): a till's push and
 * what the dashboard adds up from it, the sign-in list a till keeps, the
 * setup code, passwords, lock-outs, and that nothing answers another site.
 *
 * Every order, person and shop here is made up.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DASH_SETUP_CODE_ALPHABET,
  DASH_SETUP_CODE_LENGTH,
  DASH_SETUP_CODE_TRIES,
  DASH_WRONG_PASSWORDS,
  formatSetupCode,
  normalizeSetupCode,
  type DashDayFigures,
  type DashLive,
  type DashOrderDoc,
  type DashPushBody,
} from '@cheeseoclock/shared-types';

const db = vi.hoisted(() => ({ pg: null as unknown as { query: (t: string, v: unknown[]) => Promise<{ rows: unknown[] }> } }));
vi.mock('@/lib/db', () => ({
  // The Neon client is a tagged template returning rows; PGlite takes $n params.
  sql: () => (strings: TemplateStringsArray, ...values: unknown[]) =>
    db.pg.query(strings.reduce((acc, s, i) => acc + (i > 0 ? `$${i}` : '') + s, ''), values).then((r) => r.rows),
}));
const cookieJar = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('next/headers', () => ({
  cookies: () => ({ get: (name: string) => (name === 'coc_dash' && cookieJar.value ? { name, value: cookieJar.value } : undefined) }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const push = await import('@/app/api/bridge/dashboard/push/route');
const logins = await import('@/app/api/bridge/dashboard/logins/route');
const signIn = await import('@/app/dashboard/api/sign-in/route');
const setup = await import('@/app/dashboard/api/setup/route');
const password = await import('@/app/dashboard/api/password/route');
const signOut = await import('@/app/dashboard/api/sign-out/route');
const queries = await import('@/lib/dashboard/queries');
const session = await import('@/lib/dashboard/session');
const { DASH_SCHEMA_STATEMENTS } = await import('@/lib/dashboard/schema');

const SECRET = 'test-bridge-secret-0123456789';
const SITE = 'https://site.test';
const TILL = 'till-test-1';

/**
 * The tests' passwords, made up as they run: a secret scanner reads any
 * password typed into the repository as a leaked one (GitGuardian, 8 Oct
 * 2026). Each name stands for one; TOO_SHORT is too short on purpose.
 */
const PW_NAMES = ['first', 'second', 'third', 'nope', 'right', 'wrong', 'good', 'nobody', 'site', 'page'] as const;
const PW = Object.fromEntries(PW_NAMES.map((k) => [k, `${k}-${randomBytes(6).toString('hex')}`])) as Record<(typeof PW_NAMES)[number], string>;
const TOO_SHORT = 'abcde';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const answers: Response[] = [];
async function call(res: Promise<Response> | Response): Promise<Response> {
  const r = await res;
  answers.push(r);
  return r;
}

function bridgeReq(path: string, init: { method?: string; body?: unknown; auth?: string } = {}): Request {
  return new Request(`${SITE}${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${init.auth ?? SECRET}`, 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

function phoneReq(path: string, body: unknown, init: { cookie?: string; origin?: string; site?: string; type?: string; ip?: string } = {}): Request {
  const headers: Record<string, string> = {
    'content-type': init.type ?? 'application/json',
    origin: init.origin ?? SITE,
    'sec-fetch-site': init.site ?? 'same-origin',
    'x-forwarded-for': init.ip ?? '203.0.113.9',
    'user-agent': 'test-phone',
  };
  if (init.cookie) headers['cookie'] = `coc_dash=${init.cookie}`;
  return new Request(`${SITE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

function cookieOf(res: Response): string | null {
  const set = res.headers.get('set-cookie') ?? '';
  const m = /coc_dash=([^;]*)/.exec(set);
  return m && m[1] ? m[1] : null;
}

function newCode(): string {
  const bytes = randomBytes(DASH_SETUP_CODE_LENGTH);
  return [...bytes].map((b) => DASH_SETUP_CODE_ALPHABET[b % DASH_SETUP_CODE_ALPHABET.length]).join('');
}
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const by = { deviceId: TILL, deviceName: 'Test Till', appVersion: '0.7.40', actorName: 'Test Owner' };

async function addPerson(username: string, role: 'owner' | 'manager', seesReports = false): Promise<{ id: string; code: string }> {
  const code = newCode();
  const res = await call(
    logins.POST(
      bridgeReq('/api/bridge/dashboard/logins', {
        method: 'POST',
        body: { change: { action: 'add', username, displayName: `Test ${username}`, role, seesReports, setupCodeHash: sha256(normalizeSetupCode(code)) }, ...by },
      }),
    ),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { logins: Array<{ id: string; username: string }> } };
  const id = body.data.logins.find((l) => l.username === username)?.id;
  expect(id).toBeTruthy();
  return { id: id!, code };
}

const LIVE: DashLive = {
  shift: null,
  board: { kitchen: 0, ready: 0, out: 0, unpaidHandedOver: 0, oldestWaitingSince: null },
  web: { linked: true, ordersOn: true, accepting: true, pausedByShift: false },
  notPrinted: 0,
  lowStock: 0,
};

const CURSORS = { orders: null, shifts: null, cashMoves: null, drawerOpens: null, stockMoves: null, menu: null };

let seq = 0;
function order(over: Partial<DashOrderDoc> = {}): DashOrderDoc {
  seq += 1;
  const createdAt = over.createdAt ?? '2026-10-07T15:30:00.000Z';
  const base: DashOrderDoc = {
    id: `o-${seq}`,
    deviceId: TILL,
    number: `20261007-${String(seq).padStart(4, '0')}`,
    status: 'paid',
    mode: 'takeaway',
    source: 'pos',
    channel: 'takeaway',
    cameBy: 'walk_in',
    createdAt,
    sentAt: createdAt,
    paidAt: createdAt,
    dispatchedAt: null,
    deliveredAt: null,
    voidedAt: null,
    docUpdatedAt: createdAt,
    tradingDay: createdAt.slice(0, 10),
    hour: (new Date(createdAt).getUTCHours() + 5) % 24,
    counted: true,
    deleted: null,
    subtotalCents: 100_000,
    discountCents: 0,
    taxCents: 15_000,
    totalCents: 115_000,
    refundedCents: 0,
    netCents: 115_000,
    digitalTotalCents: null,
    riderKeepsCents: null,
    customer: { name: 'Test Customer', phone: '+923001112223', address: null, area: null },
    notes: null,
    cashier: 'Test Cashier',
    rider: null,
    voidedBy: null,
    voidReason: null,
    deletedBy: null,
    deleteReason: null,
    shiftId: 'shift-1',
    lines: [
      { id: `l-${seq}-a`, name: 'Test Pie — Large', category: 'Test Pies', menuItemId: 'item-pie-l', qty: 1, unitPriceCents: 100_000, lineTotalCents: 100_000, choices: [], note: null, isFee: false, costCents: 30_000 },
    ],
    payments: [{ id: `p-${seq}`, method: 'cash', amountCents: 115_000, tenderedCents: 120_000, at: createdAt, by: 'Test Cashier', shiftId: 'shift-1' }],
    discounts: [],
    foodpanda: null,
  };
  return { ...base, ...over };
}

function body(over: Partial<DashPushBody> = {}): DashPushBody {
  return { v: 1, till: { deviceId: TILL, deviceName: 'Test Till', appVersion: '0.7.40', sentAt: new Date().toISOString() }, live: LIVE, cursors: CURSORS, caughtUp: true, ...over };
}

function day(d: string, over: Partial<DashDayFigures['food']> = {}, shopWide = false, workedOutAt = '2026-10-08T00:00:00.000Z'): DashDayFigures {
  return {
    day: d,
    shopWide,
    food: {
      foodSalesCents: 100_000,
      feeSalesCents: 0,
      costOfSalesCents: 30_000,
      knownSalesCents: 100_000,
      knownCostCents: 30_000,
      knownMenuSalesCents: 100_000,
      estimatedOrders: 0,
      estimatedCostCents: 0,
      missingSalesCents: 0,
      wasteCents: 1_000,
      cancelledWasteCents: 0,
      wasteByReason: [{ reason: 'expired', times: 1, cents: 1_000 }],
      ...over,
    },
    profit: { profitCents: 50_000, steps: [{ key: 'sales', cents: 100_000 }, { key: 'food', cents: -50_000 }], unknownSalesCents: 0, estimatedOrders: 0 },
    purchasesCents: 0,
    workedOutAt,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  process.env['BRIDGE_SECRET'] = SECRET;
  db.pg = new PGlite() as unknown as typeof db.pg;
  await (db.pg as unknown as PGlite).exec(readFileSync(new URL('../../../db/schema.sql', import.meta.url), 'utf8'));
});

beforeEach(async () => {
  cookieJar.value = undefined;
  await (db.pg as unknown as PGlite).exec(
    'TRUNCATE dash_sessions, dash_events, dash_logins, dash_tills, dash_orders, dash_shifts, dash_cash_moves, dash_drawer_opens, dash_stock, dash_stock_moves, dash_menu, dash_days RESTART IDENTITY CASCADE',
  );
});

afterEach(() => {
  for (const r of answers.splice(0)) expect(r.headers.get('cache-control')).toBe('no-store');
});

// ---------------------------------------------------------------------------

describe('the schema', () => {
  it('db/schema.sql carries every on-demand statement word for word', () => {
    const file = readFileSync(new URL('../../../db/schema.sql', import.meta.url), 'utf8').replace(/\s+/g, ' ');
    for (const s of DASH_SCHEMA_STATEMENTS) expect(file.includes(`${s.trim().replace(/\s+/g, ' ')};`), s.slice(0, 60)).toBe(true);
  });
});

describe('a till pushes its figures', () => {
  it('refuses without the bridge secret, and a first till has no cursors', async () => {
    expect((await call(push.GET(bridgeReq(`/api/bridge/dashboard/push?device=${TILL}`, { auth: 'nope' })))).status).toBe(401);
    expect((await call(push.POST(bridgeReq('/api/bridge/dashboard/push', { method: 'POST', body: body(), auth: 'nope' })))).status).toBe(401);
    const res = await call(push.GET(bridgeReq(`/api/bridge/dashboard/push?device=${TILL}`)));
    expect(await res.json()).toEqual({ ok: true, data: { cursors: null, daysKnown: [] } });
  });

  it('keeps orders once, the newest copy winning, and adds up what the till counts', async () => {
    const paid = order();
    const refundedPart = order({ refundedCents: 15_000, netCents: 100_000, payments: [
      { id: 'p-r1', method: 'card', amountCents: 115_000, tenderedCents: null, at: '2026-10-07T15:30:00.000Z', by: 'Test Cashier', shiftId: 'shift-1' },
      { id: 'p-r2', method: 'card', amountCents: -15_000, tenderedCents: null, at: '2026-10-07T16:00:00.000Z', by: 'Test Manager', shiftId: 'shift-1' },
    ] });
    const cancelled = order({ status: 'void', counted: false, paidAt: null, payments: [] });
    const testDeleted = order({ deleted: 'test', counted: false });
    const emptyCart = order({ status: 'open', counted: false, paidAt: null, totalCents: 0, subtotalCents: 0, taxCents: 0, netCents: 0, lines: [], payments: [] });
    const delivery = order({
      mode: 'delivery',
      channel: 'delivery',
      cameBy: 'phone',
      createdAt: '2026-10-07T18:10:00.000Z',
      customer: { name: 'Test Far', phone: '+923004445556', address: 'Test street', area: 'Test Phase 6' },
      lines: [
        { id: 'l-d1', name: 'Test Burger', category: 'Test Burgers', menuItemId: 'item-burger', qty: 2, unitPriceCents: 40_000, lineTotalCents: 80_000, choices: [{ name: 'No onion', priceDeltaCents: 0 }], note: null, isFee: false, costCents: 20_000 },
        { id: 'l-d2', name: 'Delivery Charge (test)', category: 'Delivery Charges', menuItemId: 'item-fee', qty: 1, unitPriceCents: 20_000, lineTotalCents: 20_000, choices: [], note: null, isFee: true, costCents: null },
      ],
    });
    const res = await call(push.POST(bridgeReq('/api/bridge/dashboard/push', { method: 'POST', body: body({ orders: [paid, refundedPart, cancelled, testDeleted, emptyCart, delivery] }) })));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { stored: { orders: number } } }).data.stored.orders).toBe(6);

    // The same push again: nothing doubles. An older copy of `paid` changes nothing.
    await call(push.POST(bridgeReq('/api/bridge/dashboard/push', { method: 'POST', body: body({ orders: [paid, delivery] }) })));
    const older = { ...paid, status: 'void' as const, counted: false, docUpdatedAt: '2026-10-07T10:00:00.000Z' };
    await call(push.POST(bridgeReq('/api/bridge/dashboard/push', { method: 'POST', body: body({ orders: [older] }) })));
    expect((await queries.getOrder(paid.id))?.status).toBe('paid');

    const s = await queries.getSalesSummary('2026-10-07', '2026-10-07');
    expect(s.orders).toBe(3); // paid, part refund, delivery
    expect(s.netCents).toBe(115_000 + 100_000 + 115_000);
    expect(s.partRefundCents).toBe(15_000);
    expect(s.cancels).toBe(1);
    expect(s.avgCents).toBe(Math.round(330_000 / 3));
    expect(s.items).toBe(1 + 1 + 2); // the delivery charge is not an item

    const methods = await queries.getPaymentMethods('2026-10-07', '2026-10-07');
    expect(Object.fromEntries(methods.map((m) => [m.method, m.cents]))).toEqual({ cash: 230_000, card: 100_000 });

    const top = await queries.getTopItems('2026-10-07', '2026-10-07');
    expect(top.map((t) => [t.name, t.qty, t.salesCents])).toEqual([
      ['Test Pie — Large', 2, 200_000],
      ['Test Burger', 2, 80_000],
    ]);
    expect(await queries.getDeliveryCharges('2026-10-07', '2026-10-07')).toEqual({ count: 1, cents: 20_000 });

    const all = await queries.listOrders({ from: '2026-10-07', to: '2026-10-07', filter: 'all', channel: null, q: null, before: null, limit: 50 });
    expect(all.map((o) => o.id).sort()).toEqual([paid.id, refundedPart.id, cancelled.id, delivery.id].sort()); // no empty cart, no test order
    const byPhone = await queries.listOrders({ from: '2026-10-07', to: '2026-10-07', filter: 'all', channel: null, q: '0300 444', before: null, limit: 50 });
    expect(byPhone.map((o) => o.id)).toEqual([delivery.id]);
    const deleted = await queries.listOrders({ from: '2026-10-07', to: '2026-10-07', filter: 'deleted', channel: null, q: null, before: null, limit: 50 });
    expect(deleted.map((o) => o.id)).toEqual([testDeleted.id]);
    const refunded = await queries.listOrders({ from: '2026-10-07', to: '2026-10-07', filter: 'refunded', channel: null, q: null, before: null, limit: 50 });
    expect(refunded.map((o) => o.id)).toEqual([refundedPart.id]);

    const deliveries = await queries.getDeliveries('2026-10-07', '2026-10-07');
    expect(deliveries.areas).toEqual([{ key: 'Test Phase 6', orders: 1, netCents: 115_000 }]);

    // Paging: the next page holds what the first did not.
    const first = await queries.listOrders({ from: '2026-10-07', to: '2026-10-07', filter: 'all', channel: null, q: null, before: null, limit: 2 });
    const last = first[first.length - 1]!;
    const next = await queries.listOrders({ from: '2026-10-07', to: '2026-10-07', filter: 'all', channel: null, q: null, before: { at: last.createdAt, id: last.id }, limit: 50 });
    expect([...first, ...next].map((o) => o.id).sort()).toEqual(all.map((o) => o.id).sort());
  });

  it('remembers where the till is up to, and replaces its stock list', async () => {
    const cursors = { ...CURSORS, orders: '2026-10-07T18:10:00.000Z' };
    const stock = [
      { id: 'ing-1', name: 'Test cheese', unit: 'g', category: 'Fridge', onHand: 2500, lowAt: 1000, pricePerThousandCents: 300_000, priceKind: 'set', keyItem: true, batch: false, active: true },
      { id: 'ing-2', name: 'Test flour', unit: 'g', category: 'Dry', onHand: 500, lowAt: 2000, pricePerThousandCents: null, priceKind: 'unset', keyItem: false, batch: false, active: true },
    ];
    await call(push.POST(bridgeReq('/api/bridge/dashboard/push', { method: 'POST', body: body({ cursors, stock }) })));
    const res = await call(push.GET(bridgeReq(`/api/bridge/dashboard/push?device=${TILL}`)));
    expect(((await res.json()) as { data: { cursors: unknown } }).data.cursors).toEqual(cursors);
    expect((await queries.getStock(TILL)).map((s) => s.name)).toEqual(['Test cheese', 'Test flour']);
    await call(push.POST(bridgeReq('/api/bridge/dashboard/push', { method: 'POST', body: body({ cursors, stock: [stock[0]!] }) })));
    expect((await queries.getStock(TILL)).map((s) => s.name)).toEqual(['Test cheese']);
  });

  it('adds days up, and takes one till alone on a day its Reports cover the whole shop', async () => {
    await call(push.POST(bridgeReq('/api/bridge/dashboard/push', { method: 'POST', body: body({ days: [day('2026-10-06'), day('2026-10-07')] }) })));
    const other = { ...body({ days: [day('2026-10-06')] }), till: { deviceId: 'till-test-2', deviceName: 'Test Till 2', appVersion: '0.7.40', sentAt: new Date().toISOString() } };
    await call(push.POST(bridgeReq('/api/bridge/dashboard/push', { method: 'POST', body: other })));
    let f = await queries.getFoodFigures('2026-10-06', '2026-10-07');
    expect(f.foodSalesCents).toBe(300_000); // two tills on the 6th, one on the 7th
    expect(f.profit?.profitCents).toBe(150_000);
    expect(f.wasteByReason).toEqual([{ reason: 'expired', times: 3, cents: 3_000 }]);

    // Till 2 is on the link: its figures for the 6th cover both tills — they ARE the day.
    const wide = { ...other, days: [day('2026-10-06', { foodSalesCents: 180_000 }, true, '2026-10-08T01:00:00.000Z')] };
    await call(push.POST(bridgeReq('/api/bridge/dashboard/push', { method: 'POST', body: wide })));
    f = await queries.getFoodFigures('2026-10-06', '2026-10-07');
    expect(f.foodSalesCents).toBe(180_000 + 100_000);
  });

  it('refuses a body that is not a push, or too big', async () => {
    expect((await call(push.POST(bridgeReq('/api/bridge/dashboard/push', { method: 'POST', body: { v: 2 } })))).status).toBe(400);
    const huge = body({ orders: [order({ notes: 'x'.repeat(5_000) })] });
    expect((await call(push.POST(bridgeReq('/api/bridge/dashboard/push', { method: 'POST', body: huge })))).status).toBe(400);
  });
});

describe('the sign-in list a till keeps', () => {
  it('adds, lists without secrets, refuses a taken username, updates and removes', async () => {
    await addPerson('testowner', 'owner');
    const res = await call(logins.GET(bridgeReq('/api/bridge/dashboard/logins')));
    const text = await res.text();
    expect(text).not.toMatch(/hash|scrypt/i);
    const list = (JSON.parse(text) as { data: { logins: Array<Record<string, unknown>> } }).data.logins;
    expect(list).toEqual([expect.objectContaining({ username: 'testowner', role: 'owner', seesReports: true, hasPassword: false, setupPending: true })]);

    const taken = await call(
      logins.POST(bridgeReq('/api/bridge/dashboard/logins', { method: 'POST', body: { change: { action: 'add', username: 'TestOwner', displayName: 'X', role: 'manager', seesReports: false, setupCodeHash: sha256('X') }, ...by } })),
    );
    expect(taken.status).toBe(409);

    const id = list[0]!['id'] as string;
    const upd = await call(logins.POST(bridgeReq('/api/bridge/dashboard/logins', { method: 'POST', body: { change: { action: 'update', id, displayName: 'Test Boss', role: 'owner', seesReports: false }, ...by } })));
    expect(upd.status).toBe(200);
    const gone = await call(logins.POST(bridgeReq('/api/bridge/dashboard/logins', { method: 'POST', body: { change: { action: 'remove', id }, ...by } })));
    expect(((await gone.json()) as { data: { logins: unknown[] } }).data.logins).toEqual([]);
    expect((await call(logins.POST(bridgeReq('/api/bridge/dashboard/logins', { method: 'POST', body: { change: { action: 'remove', id }, ...by } })))).status).toBe(404);
  });
});

describe('a person on their phone', () => {
  it('sets up with the code, signs in, changes the password, and is signed out when removed', async () => {
    const { id, code } = await addPerson('testmgr', 'manager');
    // Not set up yet: sign-in points to the code.
    expect((await call(signIn.POST(phoneReq('/dashboard/api/sign-in', { username: 'testmgr', password: PW.nobody })))).status).toBe(409);
    // A weak password does NOT use the code up.
    expect((await call(setup.POST(phoneReq('/dashboard/api/setup', { username: 'testmgr', code, password: TOO_SHORT })))).status).toBe(400);
    const done = await call(setup.POST(phoneReq('/dashboard/api/setup', { username: 'TESTMGR', code: formatSetupCode(code).toLowerCase(), password: PW.first })));
    expect(done.status).toBe(200);
    const token = cookieOf(done);
    expect(token).toBeTruthy();
    expect(done.headers.get('set-cookie')).toMatch(/HttpOnly/);
    expect(done.headers.get('set-cookie')).toMatch(/Path=\/dashboard/);
    expect(done.headers.get('set-cookie')).toMatch(/Secure/);
    // The code is used up.
    expect((await call(setup.POST(phoneReq('/dashboard/api/setup', { username: 'testmgr', code, password: PW.second })))).status).toBe(401);

    const user = await session.userForToken(token);
    expect(user).toMatchObject({ username: 'testmgr', role: 'manager', seesReports: false });

    // Sign in on a second phone, then change the password on the first: the second is signed out.
    const second = cookieOf(await call(signIn.POST(phoneReq('/dashboard/api/sign-in', { username: 'testmgr', password: PW.first }))));
    expect(second).toBeTruthy();
    expect((await call(password.POST(phoneReq('/dashboard/api/password', { current: PW.nope, next: PW.third }, { cookie: token! })))).status).toBe(401);
    expect((await call(password.POST(phoneReq('/dashboard/api/password', { current: PW.first, next: PW.third }, { cookie: token! })))).status).toBe(200);
    expect(await session.userForToken(token)).not.toBeNull();
    expect(await session.userForToken(second)).toBeNull();

    // The owner removes the person on the till: the phone is signed out at once.
    await call(logins.POST(bridgeReq('/api/bridge/dashboard/logins', { method: 'POST', body: { change: { action: 'remove', id }, ...by } })));
    expect(await session.userForToken(token)).toBeNull();
  });

  it('locks a username after five wrong passwords, and voids a code after five wrong tries', async () => {
    const { code } = await addPerson('testlock', 'owner');
    await call(setup.POST(phoneReq('/dashboard/api/setup', { username: 'testlock', code, password: PW.right })));
    for (let i = 0; i < DASH_WRONG_PASSWORDS - 1; i++) {
      expect((await call(signIn.POST(phoneReq('/dashboard/api/sign-in', { username: 'testlock', password: `${PW.wrong}-${i}` })))).status).toBe(401);
    }
    expect((await call(signIn.POST(phoneReq('/dashboard/api/sign-in', { username: 'testlock', password: PW.wrong })))).status).toBe(429);
    // Locked: even the right password waits.
    expect((await call(signIn.POST(phoneReq('/dashboard/api/sign-in', { username: 'testlock', password: PW.right })))).status).toBe(429);

    const { code: code2 } = await addPerson('testcode', 'manager');
    for (let i = 0; i < DASH_SETUP_CODE_TRIES; i++) {
      expect((await call(setup.POST(phoneReq('/dashboard/api/setup', { username: 'testcode', code: newCode(), password: PW.good }, { ip: '198.51.100.20' })))).status).toBe(401);
    }
    // Voided: the right code no longer works.
    expect((await call(setup.POST(phoneReq('/dashboard/api/setup', { username: 'testcode', code: code2, password: PW.good }, { ip: '198.51.100.20' })))).status).toBe(401);
  });

  it('answers an unknown username like a wrong password', async () => {
    const res = await call(signIn.POST(phoneReq('/dashboard/api/sign-in', { username: 'nobody', password: PW.nobody })));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('wrong');
  });

  it('refuses another site, a form post, and signs out', async () => {
    const { code } = await addPerson('testsite', 'owner');
    expect((await call(setup.POST(phoneReq('/dashboard/api/setup', { username: 'testsite', code, password: PW.site }, { origin: 'https://evil.test' })))).status).toBe(403);
    expect((await call(setup.POST(phoneReq('/dashboard/api/setup', { username: 'testsite', code, password: PW.site }, { site: 'cross-site' })))).status).toBe(403);
    expect((await call(setup.POST(phoneReq('/dashboard/api/setup', { username: 'testsite', code, password: PW.site }, { type: 'text/plain' })))).status).toBe(415);
    const token = cookieOf(await call(setup.POST(phoneReq('/dashboard/api/setup', { username: 'testsite', code, password: PW.site }))));
    expect(await session.userForToken(token)).not.toBeNull();
    const out = await call(signOut.POST(phoneReq('/dashboard/api/sign-out', {}, { cookie: token! })));
    expect(out.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect(await session.userForToken(token)).toBeNull();
  });

  it('pages read the cookie, and send a stranger to sign in', async () => {
    await expect(session.requireUser('/dashboard/orders')).rejects.toThrow('redirect:/dashboard/sign-in?next=%2Fdashboard%2Forders');
    const { code } = await addPerson('testpage', 'manager', true);
    cookieJar.value = cookieOf(await call(setup.POST(phoneReq('/dashboard/api/setup', { username: 'testpage', code, password: PW.page })))) ?? undefined;
    expect(await session.requireUser()).toMatchObject({ username: 'testpage', seesReports: true });
  });

  it('only ever sends a person back to a dashboard page', () => {
    expect(session.safeNext('/dashboard/orders?x=1')).toBe('/dashboard/orders?x=1');
    for (const bad of ['https://evil.test', '//evil.test', '/menu', '/dashboard\\..', '/dashboard/sign-in']) expect(session.safeNext(bad)).toBe('/dashboard');
  });
});

describe('the dashboard’s numbers', () => {
  it('never show minus zero (nothing short, or a few paisa either way)', async () => {
    const { money, moneyWhole } = await import('@/lib/dashboard/format');
    const zero = money(0);
    expect(money(-0)).toBe(zero);
    expect(moneyWhole(-0)).toBe(zero);
    expect(moneyWhole(-40)).toBe(zero);
    expect(moneyWhole(40)).toBe(zero);
    expect(moneyWhole(-160)).toBe(money(-200));
  });
});
