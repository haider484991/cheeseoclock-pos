import { randomBytes, createHash } from 'node:crypto';
import {
  DASH_KEEPALIVE_MINUTES,
  DASH_LOGIN_REFUSAL_WORDS,
  DASH_PUSH_MAX_CHARS,
  DASH_PUSH_MAX_ORDERS,
  DASH_PUSH_MAX_ROWS,
  DASH_PUSH_SETTING_KEY,
  DASH_SETUP_CODE_ALPHABET,
  DASH_SETUP_CODE_HOURS,
  DASH_SETUP_CODE_LENGTH,
  formatSetupCode,
  normalizeSetupCode,
  type DashDayFigures,
  type DashLive,
  type DashLoginAction,
  type DashLoginMade,
  type DashLoginRefusal,
  type DashLoginView,
  type DashOrderDoc,
  type DashPushBody,
  type DashPushCursors,
  type DashPushPhase,
  type DashPushStatus,
} from '@cheeseoclock/shared-types';
import { dashLoginsResponseSchema, dashPushResponseSchema, dashPushStateResponseSchema } from '@cheeseoclock/shared-schemas/dashboard';
import type { AppDatabase } from '../db/connection.js';
import { getSettingRaw, setSetting } from '../db/repositories/settings-repo.js';
import {
  buildOrderDocs,
  changedCashMoves,
  changedDrawerOpens,
  changedOrders,
  changedShifts,
  changedStockMoves,
  dayFigures,
  daysWithOrders,
  docHash,
  liveBlock,
  lookFrom,
  type LookKey,
  menuChangedAt,
  menuSnapshot,
  recentOrderIds,
  stockChangedAt,
  stockSnapshot,
} from './dashboard-docs.js';

/**
 * The owner's phone dashboard, the till's side (shared-types dashboard.ts):
 * sends the website what changed, and keeps the sign-in list the owner
 * manages on the till.
 *
 * WHEN. A look every LOOK_MS while the website link is set up and the
 * owner's switch is on (never saved = on). A look that finds nothing new —
 * no audit or sync row since the last push, the history all sent — sends
 * nothing, so the free database can sleep while the shop is shut; with a
 * shift open it still says the till is there every DASH_KEEPALIVE_MINUTES.
 * While the history is on its way the next batch goes after HISTORY_MS. A
 * failed push waits BACKOFF_FIRST_MS, doubling to BACKOFF_MAX_MS; a website
 * without the dashboard (404) is asked again hourly.
 *
 * WHAT. Where the website is up to (its cursors) is asked once at start and
 * then followed in memory: each kind of row since a little before its
 * cursor (dashboard-docs DASH_OVERLAP_MS), each order whole, an order not
 * changed since it was last sent left out. The last two days' orders are
 * looked over again every REHASH_MS (a change that moved no updated_at — a
 * cancel the other till won — is not missed). Day figures go for the days
 * the website lacks, the days a batch touched, and today every few minutes.
 *
 * Nothing here writes a business row. The switch is this till's own setting.
 */

export const LOOK_MS = 30_000;
export const HISTORY_MS = 3_000;
export const IDLE_MS = 60_000;
export const BACKOFF_FIRST_MS = 60_000;
export const BACKOFF_MAX_MS = 15 * 60_000;
export const WEBSITE_OLD_MS = 60 * 60_000;
export const REHASH_MS = 30 * 60_000;
/** Today's figures are worked out again at most this often while it changes. */
export const TODAY_FIGURES_MS = 5 * 60_000;
/** Day figures worked out per push (each is two Reports builders over one day). */
export const DAYS_PER_PUSH = 7;

export interface DashboardPushDeps {
  db: AppDatabase;
  deviceId: string;
  deviceName: string | null;
  appVersion: string;
  /** The web bridge's authenticated call (BRIDGE_SECRET); throws without a link. */
  callWebsite: (path: string, init?: RequestInit) => Promise<Response>;
  /** The website link is set up (address and password). */
  linked: () => boolean;
  /** The website's address as the link has it ('https://www.example.com'), or null. */
  siteUrl: () => string | null;
  /** The website switch on this till, for the live block. */
  web: () => DashLive['web'];
  /** Kitchen tickets this till gave up printing. */
  notPrinted: () => number | Promise<number>;
  /** The second-till link is on: this till's Reports cover the whole shop. */
  shopWide: () => boolean;
  now?: () => number;
  log?: { info: (m: string, d?: unknown) => void; warn: (m: string, d?: unknown) => void };
}

/** A refusal for the owner, in plain words (the handlers show it as it is). */
export class DashboardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DashboardError';
  }
}

const WEBSITE_TOO_OLD = 'The website needs its update before it has the phone dashboard.';
const NO_LINK = 'Set up the website link first (Settings → Online orders: the website’s address and password).';
const NOT_REACHED = 'Could not reach the website. Check the internet and try again.';

export function readPushOn(db: AppDatabase): boolean {
  const raw = getSettingRaw(db, DASH_PUSH_SETTING_KEY) as { on?: unknown } | null;
  return raw?.on !== false;
}

/** A setup code: DASH_SETUP_CODE_LENGTH symbols of the unmistakable alphabet, from the OS's random source. */
export function makeSetupCode(): string {
  const alphabet = DASH_SETUP_CODE_ALPHABET;
  const out: string[] = [];
  // 32 symbols: the low five bits of each random byte pick one with no bias.
  for (const b of randomBytes(DASH_SETUP_CODE_LENGTH)) out.push(alphabet[b & 31]!);
  return out.join('');
}

export function setupCodeHash(code: string): string {
  return createHash('sha256').update(normalizeSetupCode(code), 'utf8').digest('hex');
}

type RowKind = 'orders' | 'shifts' | 'cashMoves' | 'drawerOpens' | 'stockMoves';

function blankKeys(): Record<RowKind, LookKey> {
  return { orders: lookFrom(null), shifts: lookFrom(null), cashMoves: lookFrom(null), drawerOpens: lookFrom(null), stockMoves: lookFrom(null) };
}

/** Each kind's key a little before its cursor: after a start, and on the look back now and then. */
function keysFrom(c: DashPushCursors): Record<RowKind, LookKey> {
  return { orders: lookFrom(c.orders), shifts: lookFrom(c.shifts), cashMoves: lookFrom(c.cashMoves), drawerOpens: lookFrom(c.drawerOpens), stockMoves: lookFrom(c.stockMoves) };
}

function emptyCursors(): DashPushCursors {
  return { orders: null, shifts: null, cashMoves: null, drawerOpens: null, stockMoves: null, menu: null };
}

const maxIso = (a: string | null, b: string | null | undefined): string | null => (b && (!a || b > a) ? b : a);

/** The key after the last row read (rows come in key order), or where it was. */
function lastKey(rows: ReadonlyArray<LookKey>, was: LookKey): LookKey {
  const last = rows[rows.length - 1];
  return last ? { at: last.at, id: last.id } : was;
}

export class DashboardPushService {
  private readonly d: DashboardPushDeps;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private started = false;
  private cursors: DashPushCursors | null = null;
  /** Where each kind of row goes on from (in memory; from the website's cursors at a start). */
  private keys: Record<RowKind, LookKey> = blankKeys();
  private daysKnown = new Set<string>();
  private pendingDays = new Set<string>();
  private sentHashes = new Map<string, { hash: string; day: string }>();
  private lastProbe: string | null = null;
  private lastPushAt = 0;
  private lastSentAt: string | null = null;
  private lastError: string | null = null;
  private backoffMs = 0;
  private caughtUp = false;
  private websiteOld = false;
  private lastRehashAt = 0;
  private lastTodayAt = 0;
  private stockStamp: string | null = null;
  /** The stock list went at least once since the start (a till with no stock at all has no stamp). */
  private stockSent = false;
  private ordersSent = 0;
  private shrink = 1;

  constructor(deps: DashboardPushDeps) {
    this.d = deps;
  }

  private now(): number {
    return this.d.now ? this.d.now() : Date.now();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.schedule(5_000);
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Look now (after the owner's "Send now", or the switch). */
  kick(): void {
    if (!this.started) return;
    this.backoffMs = 0;
    this.websiteOld = false;
    this.schedule(0);
  }

  private schedule(ms: number): void {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
    (this.timer as { unref?: () => void }).unref?.();
  }

  status(): DashPushStatus {
    const on = readPushOn(this.d.db);
    let phase: DashPushPhase;
    if (!on) phase = 'off';
    else if (!this.d.linked()) phase = 'not_linked';
    else if (this.websiteOld) phase = 'website_old';
    else if (this.lastError) phase = 'failing';
    else if (this.cursors === null) phase = 'starting';
    else phase = this.caughtUp ? 'up_to_date' : 'sending_history';
    const site = this.d.siteUrl();
    return {
      on,
      phase,
      lastSentAt: this.lastSentAt,
      lastError: this.lastError,
      ordersSent: this.ordersSent,
      dashboardUrl: site ? `${site.replace(/\/+$/, '')}/dashboard` : null,
    };
  }

  /** One look (exported for the tests through tick()). */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    let next = LOOK_MS;
    try {
      next = await this.look();
    } catch (e) {
      this.lastError = e instanceof Error ? e.message.slice(0, 300) : String(e);
      this.backoffMs = this.backoffMs === 0 ? BACKOFF_FIRST_MS : Math.min(BACKOFF_MAX_MS, this.backoffMs * 2);
      next = this.backoffMs;
      this.d.log?.warn('Dashboard: a push failed; trying again later', { error: this.lastError, inMs: next });
    } finally {
      this.running = false;
    }
    this.schedule(next);
  }

  /** The audit trail and the sync queue only grow with business writes: a cheap "anything new?". */
  private probe(): string {
    const r = this.d.db
      .prepare(`SELECT (SELECT MAX(rowid) FROM audit_log) AS a, (SELECT MAX(rowid) FROM sync_queue) AS q`)
      .get() as { a: number | null; q: number | null };
    return `${r.a ?? 0}:${r.q ?? 0}`;
  }

  private async look(): Promise<number> {
    if (!readPushOn(this.d.db) || !this.d.linked()) return IDLE_MS;
    if (this.websiteOld) return WEBSITE_OLD_MS;
    const now = this.now();
    if (this.cursors === null) {
      const state = await this.readState();
      if (state === 'old') return WEBSITE_OLD_MS;
      this.cursors = state.cursors ?? emptyCursors();
      this.keys = keysFrom(this.cursors);
      this.daysKnown = new Set(state.daysKnown);
      const today = new Date(now).toISOString().slice(0, 10);
      for (const day of daysWithOrders(this.d.db)) if (!this.daysKnown.has(day) || day === today) this.pendingDays.add(day);
      this.caughtUp = false;
    }

    const probe = this.probe();
    let notPrinted = 0;
    try {
      notPrinted = await this.d.notPrinted();
    } catch {
      // An extra on the dashboard: never a reason not to send.
    }
    const live = liveBlock(this.d.db, this.d.deviceId, new Date(now), { web: this.d.web(), notPrinted });
    const keepalive = live.shift !== null && now - this.lastPushAt >= DASH_KEEPALIVE_MINUTES * 60_000;
    // The recent orders are looked over again only while the shop is working (a shut, idle shop sends nothing).
    const rehash = now - this.lastRehashAt >= REHASH_MS && (live.shift !== null || probe !== this.lastProbe);
    const daysDue = [...this.pendingDays].some((d) => !this.todayThrottled(d, now));
    if (probe === this.lastProbe && this.caughtUp && !daysDue && !keepalive && !rehash) return LOOK_MS;

    // The look back: rows written late with an older updated_at, a clock nudged back.
    if (rehash && this.caughtUp && this.cursors) this.keys = keysFrom(this.cursors);
    const body = this.buildBatch(now, live, rehash);
    if (body.empty && !keepalive && !body.truncated) {
      // Nothing new after all (rows read again, unchanged documents): no request at all.
      this.cursors = body.push.cursors;
      this.keys = body.keys;
      this.lastProbe = probe;
      if (rehash) this.lastRehashAt = now;
      this.caughtUp = body.push.caughtUp;
      return LOOK_MS;
    }
    let json = JSON.stringify(body.push);
    while (json.length > DASH_PUSH_MAX_CHARS && (body.push.orders?.length ?? 0) > 1) {
      // Too big for one request: half the orders now, the rest next time.
      this.shrink = Math.min(64, this.shrink * 2);
      const keep = Math.max(1, Math.floor((body.push.orders?.length ?? 0) / 2));
      body.push.orders = body.push.orders?.slice(0, keep);
      const cut = body.ordersCut(keep);
      body.push.cursors = { ...body.push.cursors, orders: cut.cursor };
      body.keys = { ...body.keys, orders: cut.key };
      body.truncated = true;
      body.push.caughtUp = false;
      json = JSON.stringify(body.push);
    }
    const res = await this.d.callWebsite('/api/bridge/dashboard/push', { method: 'POST', body: json });
    if (res.status === 404) {
      this.websiteOld = true;
      this.lastError = WEBSITE_TOO_OLD;
      return WEBSITE_OLD_MS;
    }
    const answer = dashPushResponseSchema.safeParse(await res.json().catch(() => null));
    if (!res.ok || !answer.success || !answer.data.ok) {
      const why = answer.success && !answer.data.ok ? `${answer.data.error}${answer.data.message ? `: ${answer.data.message}` : ''}` : `HTTP ${res.status}`;
      throw new DashboardError(`The website did not take the figures (${why}).`);
    }

    // Kept: move on.
    this.cursors = body.push.cursors;
    this.keys = body.keys;
    for (const o of body.push.orders ?? []) this.sentHashes.set(o.id, { hash: body.hashes.get(o.id) ?? '', day: o.tradingDay });
    for (const day of body.days) {
      this.pendingDays.delete(day);
      this.daysKnown.add(day);
    }
    if (body.push.stock) {
      this.stockStamp = body.stockStamp;
      this.stockSent = true;
    }
    if (rehash) this.lastRehashAt = now;
    if (body.days.includes(new Date(now).toISOString().slice(0, 10))) this.lastTodayAt = now;
    this.pruneHashes(now);
    this.ordersSent += body.push.orders?.length ?? 0;
    this.lastProbe = body.truncated ? null : probe;
    this.lastPushAt = now;
    this.lastSentAt = new Date(now).toISOString();
    this.lastError = null;
    this.backoffMs = 0;
    this.caughtUp = body.push.caughtUp;
    if (this.caughtUp) this.shrink = 1;
    return this.caughtUp ? LOOK_MS : HISTORY_MS;
  }

  private async readState(): Promise<{ cursors: DashPushCursors | null; daysKnown: string[] } | 'old'> {
    const res = await this.d.callWebsite(`/api/bridge/dashboard/push?device=${encodeURIComponent(this.d.deviceId)}`, { method: 'GET' });
    if (res.status === 404) {
      this.websiteOld = true;
      this.lastError = WEBSITE_TOO_OLD;
      return 'old';
    }
    const parsed = dashPushStateResponseSchema.safeParse(await res.json().catch(() => null));
    if (!res.ok || !parsed.success || !parsed.data.ok) throw new DashboardError(`The website did not say where it is up to (HTTP ${res.status}).`);
    return { cursors: parsed.data.data.cursors, daysKnown: parsed.data.data.daysKnown };
  }

  /** Today's figures wait TODAY_FIGURES_MS after the last time they went (it changes all evening). */
  private todayThrottled(day: string, now: number): boolean {
    return day === new Date(now).toISOString().slice(0, 10) && this.daysKnown.has(day) && now - this.lastTodayAt < TODAY_FIGURES_MS;
  }

  private pruneHashes(now: number): void {
    const keepFrom = new Date(now - 3 * 86_400_000).toISOString().slice(0, 10);
    for (const [id, v] of this.sentHashes) if (v.day < keepFrom) this.sentHashes.delete(id);
  }

  /** Everything to send now, and where the cursors will be once the website keeps it. */
  private buildBatch(
    now: number,
    live: DashLive,
    rehash: boolean,
  ): {
    push: DashPushBody;
    hashes: Map<string, string>;
    days: string[];
    truncated: boolean;
    /** Nothing to send but the live block. */
    empty: boolean;
    stockStamp: string | null;
    /** Where each kind goes on from once this push is kept. */
    keys: Record<RowKind, LookKey>;
    /** The orders cut to the first `keep` (too big for one request): the cursor and key they leave. */
    ordersCut: (keep: number) => { cursor: string | null; key: LookKey };
  } {
    const db = this.d.db;
    const c = this.cursors ?? emptyCursors();
    const nowDate = new Date(now);
    const orderLimit = Math.max(1, Math.floor(DASH_PUSH_MAX_ORDERS / this.shrink));

    const k = this.keys;
    // Orders: the changed ones, oldest change first; then (now and then) the recent ones looked over again.
    const changed = changedOrders(db, k.orders, orderLimit);
    const truncatedOrders = changed.length >= orderLimit;
    const ids = new Set(changed.map((x) => x.id));
    if (rehash && !truncatedOrders) {
      const since = new Date(now - 2 * 86_400_000).toISOString();
      for (const id of recentOrderIds(db, since)) if (ids.size < orderLimit) ids.add(id);
    }
    const hashes = new Map<string, string>();
    const docs: DashOrderDoc[] = [];
    for (const doc of buildOrderDocs(db, [...ids])) {
      const h = docHash(doc);
      hashes.set(doc.id, h);
      if (this.sentHashes.get(doc.id)?.hash !== h) docs.push(doc);
    }
    // Keep the changed order first (oldest change first), then the looked-over ones.
    const rank = new Map(changed.map((x, i) => [x.id, i]));
    docs.sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
    const orderCursor = changed.reduce<string | null>((m, x) => maxIso(m, x.at), c.orders);
    for (const d of docs) this.pendingDays.add(d.tradingDay);

    const shifts = changedShifts(db, k.shifts, DASH_PUSH_MAX_ROWS);
    const cashMoves = changedCashMoves(db, k.cashMoves, DASH_PUSH_MAX_ROWS);
    const drawerOpens = changedDrawerOpens(db, k.drawerOpens, DASH_PUSH_MAX_ROWS);
    const stockMoves = changedStockMoves(db, k.stockMoves, DASH_PUSH_MAX_ROWS, nowDate);
    for (const m of stockMoves) this.pendingDays.add(m.at.slice(0, 10));
    const truncated =
      truncatedOrders ||
      shifts.length >= DASH_PUSH_MAX_ROWS ||
      cashMoves.length >= DASH_PUSH_MAX_ROWS ||
      drawerOpens.length >= DASH_PUSH_MAX_ROWS ||
      stockMoves.length >= DASH_PUSH_MAX_ROWS;

    const stockStamp = stockChangedAt(db);
    const stock = !this.stockSent || stockStamp !== this.stockStamp ? stockSnapshot(db) : undefined;
    const menuAt = menuChangedAt(db);
    const menu = menuAt !== null && (c.menu === null || menuAt > c.menu) ? menuSnapshot(db, nowDate) : undefined;

    // Day figures: today at most every few minutes while it changes, then the rest, newest first.
    const wanted = [...this.pendingDays]
      .filter((d) => !this.todayThrottled(d, now))
      .sort()
      .reverse()
      .slice(0, DAYS_PER_PUSH);
    const days: DashDayFigures[] = [];
    const shopWide = this.d.shopWide();
    for (const day of wanted) {
      try {
        days.push(dayFigures(db, day, nowDate, shopWide));
      } catch (e) {
        // A day that can't be worked out is dropped, not retried for ever.
        this.pendingDays.delete(day);
        this.d.log?.warn('Dashboard: a day’s figures could not be worked out', { day, error: e instanceof Error ? e.message : String(e) });
      }
    }
    // Still to go after this push (today waiting for its turn does not count: it goes by itself).
    const moreDays = [...this.pendingDays].filter((d) => !this.todayThrottled(d, now) && !days.some((x) => x.day === d)).length > 0;

    const push: DashPushBody = {
      v: 1,
      till: { deviceId: this.d.deviceId, deviceName: this.d.deviceName, appVersion: this.d.appVersion, sentAt: nowDate.toISOString() },
      live,
      ...(docs.length ? { orders: docs } : {}),
      ...(shifts.length ? { shifts } : {}),
      ...(cashMoves.length ? { cashMoves } : {}),
      ...(drawerOpens.length ? { drawerOpens } : {}),
      ...(stockMoves.length ? { stockMoves } : {}),
      ...(stock ? { stock } : {}),
      ...(menu ? { menu } : {}),
      ...(days.length ? { days } : {}),
      cursors: {
        orders: orderCursor,
        shifts: shifts.reduce<string | null>((m, x) => maxIso(m, x.updatedAt), c.shifts),
        cashMoves: cashMoves.reduce<string | null>((m, x) => maxIso(m, x.updatedAt), c.cashMoves),
        drawerOpens: drawerOpens.reduce<string | null>((m, x) => maxIso(m, x.updatedAt), c.drawerOpens),
        stockMoves: stockMoves.reduce<string | null>((m, x) => maxIso(m, x.updatedAt), c.stockMoves),
        menu: menu ? maxIso(c.menu, menu.updatedAt) : c.menu,
      },
      caughtUp: !truncated && !moreDays,
    };
    return {
      push,
      hashes,
      days: days.map((x) => x.day),
      truncated,
      empty: !docs.length && !shifts.length && !cashMoves.length && !drawerOpens.length && !stockMoves.length && !stock && !menu && !days.length,
      stockStamp,
      keys: {
        orders: lastKey(changed.map((x) => ({ at: x.at, id: x.id })), k.orders),
        shifts: lastKey(shifts.map((x) => ({ at: x.updatedAt, id: x.id })), k.shifts),
        cashMoves: lastKey(cashMoves.map((x) => ({ at: x.updatedAt, id: x.id })), k.cashMoves),
        drawerOpens: lastKey(drawerOpens.map((x) => ({ at: x.updatedAt, id: x.id })), k.drawerOpens),
        stockMoves: lastKey(stockMoves.map((x) => ({ at: x.updatedAt, id: x.id })), k.stockMoves),
      },
      // Cut to the first `keep` orders sent: the key and cursor move only past those that changed, in order.
      ordersCut: (keep) => {
        const sent = new Set((push.orders ?? []).slice(0, keep).map((o) => o.id));
        const upTo = changed.findIndex((x) => !sent.has(x.id));
        const done = upTo === -1 ? changed : changed.slice(0, upTo);
        return {
          cursor: done.reduce<string | null>((m, x) => maxIso(m, x.at), c.orders),
          key: lastKey(done.map((x) => ({ at: x.at, id: x.id })), k.orders),
        };
      },
    };
  }

  // -------------------------------------------------------------------------
  // The sign-in list (the website keeps it; every change is the owner's)
  // -------------------------------------------------------------------------

  private async loginsCall(init?: RequestInit): Promise<DashLoginView[]> {
    if (!this.d.linked()) throw new DashboardError(NO_LINK);
    let res: Response;
    try {
      res = await this.d.callWebsite('/api/bridge/dashboard/logins', init);
    } catch {
      throw new DashboardError(NOT_REACHED);
    }
    if (res.status === 404 && init?.method !== 'POST') throw new DashboardError(WEBSITE_TOO_OLD);
    const parsed = dashLoginsResponseSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) {
      if (res.status === 404) throw new DashboardError(WEBSITE_TOO_OLD);
      throw new DashboardError(`The website did not answer as expected (HTTP ${res.status}).`);
    }
    if (!parsed.data.ok) {
      const words = DASH_LOGIN_REFUSAL_WORDS[parsed.data.error as DashLoginRefusal];
      if (words) throw new DashboardError(words);
      if (res.status === 404) throw new DashboardError(WEBSITE_TOO_OLD);
      throw new DashboardError(`The website refused it (${parsed.data.error}).`);
    }
    return parsed.data.data.logins;
  }

  listLogins(): Promise<DashLoginView[]> {
    return this.loginsCall({ method: 'GET' });
  }

  async changeLogin(change: DashLoginAction, actorName: string | null): Promise<DashLoginView[]> {
    return this.loginsCall({
      method: 'POST',
      body: JSON.stringify({ change, deviceId: this.d.deviceId, deviceName: this.d.deviceName, appVersion: this.d.appVersion, actorName }),
    });
  }

  /** Add a person, or make a new code for one: the code is made here, only its SHA-256 goes. */
  async withNewCode(
    make: (codeHash: string) => DashLoginAction,
    actorName: string | null,
    username: (logins: DashLoginView[]) => string,
  ): Promise<DashLoginMade> {
    const code = makeSetupCode();
    const logins = await this.changeLogin(make(setupCodeHash(code)), actorName);
    return {
      logins,
      username: username(logins),
      code: formatSetupCode(code),
      expiresAt: new Date(this.now() + DASH_SETUP_CODE_HOURS * 3_600_000).toISOString(),
    };
  }
}

let current: DashboardPushService | null = null;

/** The till's one service; the web bridge makes it at start-up (null before). */
export function dashboardPushService(): DashboardPushService | null {
  return current;
}

export function setDashboardPushService(s: DashboardPushService | null): void {
  current = s;
}

/** The owner's switch for this till (never synced); audited as a setting the owner changed. */
export function writePushOn(db: AppDatabase, on: boolean, actorUserId: string): void {
  setSetting(db, DASH_PUSH_SETTING_KEY, { on }, { actorUserId });
}
