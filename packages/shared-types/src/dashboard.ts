/**
 * The owner's phone dashboard (v0.7.40): the till's figures on the website,
 * behind a sign-in of its own (the user, 8 Oct 2026: "on the website I want
 * the POS data — orders, till data, inventory, menu, all analytics, cash in
 * and out, shifts — the site should have a login for the owner or manager
 * to check it on their phone anytime").
 *
 *   till ──(BRIDGE_SECRET)──▶ website ◀──(own password, cookie)── phone
 *   dashboard-push.ts          /api/bridge/dashboard/*            /dashboard
 *
 * TWO HALVES, ONE FILE.
 *  - SIGN-INS (this part): who may open /dashboard. NOT the till's PINs: a
 *    4-digit PIN would be guessed on the open internet. The owner adds a
 *    person on a till (Settings → Online orders → Phone dashboard); the till
 *    makes a ONE-TIME SETUP CODE, shows it once, and sends the website only
 *    its SHA-256 (as the menu upload key, menu-deploy.ts). The person opens
 *    /dashboard on their phone, types the code and picks their own password,
 *    which only the website ever holds (scrypt). The website keeps the list;
 *    every till with the website link reads and changes the same list.
 *  - FIGURES (DASHBOARD PUSH, below): what the till sends, and when.
 *
 * WHO SEES WHAT mirrors the till's roles (auth.ts ROLE_CAPABILITIES):
 *  - owner: everything;
 *  - manager: the live status, orders, the shift open now, stock and the
 *    menu with costs (a manager's till shows all of these: order.history,
 *    shift.close, COST_CAPABILITY). Sales reports, past shifts and their
 *    cash in and out are report.view on the till, the owner's (owner,
 *    2026-09-27) — a manager sees them only when the owner ticks
 *    `seesReports` for that person. Profit, the drawer log and the sign-in
 *    list: the owner's alone, whatever the tick says.
 *
 * Pure constants, types and helpers; the wire schemas are shared-schemas
 * dashboard.ts.
 */

// ---------------------------------------------------------------------------
// SIGN-INS
// ---------------------------------------------------------------------------

export const DASH_ROLES = ['owner', 'manager'] as const;
export type DashRole = (typeof DASH_ROLES)[number];

/**
 * A username: 3–32 of a–z, 0–9, '.', '_' and '-', starting with a letter or
 * digit. Typed by the owner on the till ("yawar", "ali.manager"); matched
 * case-blind (normalizeDashUsername) on both sides.
 */
export const DASH_USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export function normalizeDashUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

/** The name the dashboard greets them by and the till's list shows. */
export const DASH_DISPLAY_NAME_MAX = 40;

/**
 * Setup codes: 12 symbols from 32 that can't be mixed up on a phone keyboard
 * or in a WhatsApp font (no 0/O, no 1/I), 60 bits — shown as XXXX-XXXX-XXXX.
 * A code works once, for DASH_SETUP_CODE_HOURS, and DASH_SETUP_CODE_TRIES
 * wrong tries void it (the owner makes a new one on the till).
 */
export const DASH_SETUP_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const DASH_SETUP_CODE_LENGTH = 12;
export const DASH_SETUP_CODE_HOURS = 72;
export const DASH_SETUP_CODE_TRIES = 5;

/**
 * What both sides hash: the code without spaces or dashes, in capitals. A
 * typed O or I is read as the 0 or 1 it can't be (the alphabet has neither),
 * so it simply fails rather than being "corrected" into a different code.
 */
export function normalizeSetupCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, '');
}

/** XXXX-XXXX-XXXX, for the till's show-once box. */
export function formatSetupCode(code: string): string {
  const c = normalizeSetupCode(code);
  return c.match(/.{1,4}/g)?.join('-') ?? c;
}

export function isSetupCodeShape(raw: string): boolean {
  const c = normalizeSetupCode(raw);
  if (c.length !== DASH_SETUP_CODE_LENGTH) return false;
  for (const ch of c) if (!DASH_SETUP_CODE_ALPHABET.includes(ch)) return false;
  return true;
}

/** A dashboard password: at least 8 characters (any), at most 200. */
export const DASH_PASSWORD_MIN = 8;
export const DASH_PASSWORD_MAX = 200;

/** Wrong passwords for one username before it is locked for DASH_LOCK_MINUTES. */
export const DASH_WRONG_PASSWORDS = 5;
export const DASH_LOCK_MINUTES = 15;
/** Wrong sign-ins (any username) from one address in 15 minutes before it is refused. */
export const DASH_WRONG_PER_ADDRESS = 30;
/** A phone stays signed in this long after its last use (and never longer than DASH_SESSION_MAX_DAYS). */
export const DASH_SESSION_IDLE_DAYS = 30;
export const DASH_SESSION_MAX_DAYS = 180;

/** One sign-in, as a till's Settings card lists it (never a hash, never a code). */
export interface DashLoginView {
  id: string;
  username: string;
  displayName: string;
  role: DashRole;
  /** Manager only: also sees sales reports and past shifts (always true for an owner). */
  seesReports: boolean;
  /** They have picked a password (finished their setup code). */
  hasPassword: boolean;
  /** A setup code is waiting to be used and has not run out. */
  setupPending: boolean;
  setupExpiresAt: string | null;
  lastSignInAt: string | null;
  /** Phones signed in now. */
  signedInPhones: number;
  createdAt: string;
}

/**
 * What a till asks the website to do with the list
 * (POST /api/bridge/dashboard/logins). Every action names the till and the
 * owner who pressed it, for the website's history.
 */
export type DashLoginAction =
  | {
      action: 'add';
      username: string;
      displayName: string;
      role: DashRole;
      seesReports: boolean;
      setupCodeHash: string;
    }
  | { action: 'update'; id: string; displayName: string; role: DashRole; seesReports: boolean }
  | { action: 'newCode'; id: string; setupCodeHash: string }
  | { action: 'signOutAll'; id: string }
  | { action: 'remove'; id: string };

export type DashLoginRefusal = 'username_taken' | 'not_found' | 'validation';

/** The website's words for a refusal, for the till to show as they are. */
export const DASH_LOGIN_REFUSAL_WORDS: Record<DashLoginRefusal, string> = {
  username_taken: 'That username is taken. Pick another.',
  not_found: 'That person is not on the website any more. Close this and look again.',
  validation: 'The website did not accept that. Check the name and username.',
};

// ---------------------------------------------------------------------------
// DASHBOARD PUSH — what the till sends, and when
// ---------------------------------------------------------------------------
//
// WHAT. POST /api/bridge/dashboard/push (DashPushBody): this till's changed
// orders, shifts, cash in/out, drawer log, stock movements — each the till's
// own row id, so a re-send overwrites, never doubles — plus snapshots that
// replace this till's last one (its stock on hand, its menu) and `live`
// (the shift open now, the board, the website switch). The answer names
// where the website is up to (DashPushCursors), which the till keeps only in
// memory: at start it asks GET /api/bridge/dashboard/push?device=<id>.
//
// NUMBERS ARE THE TILL'S. The website adds up, it never re-derives:
//  - every order carries the till's own verdicts (DashOrderDoc.counted =
//    analytics/sql.ts COUNTED; netCents = total − partial refunds, REFUNDED;
//    tradingDay / hour from created_at, as Reports date a sale);
//  - food cost, waste and profit arrive per trading day (DashDayFigures),
//    worked out by the till's Reports builders for that one day: every one
//    of those figures is a sum over the day's orders and stock rows, so the
//    website adds days up for any period and works the percentages from the
//    sums, exactly as the till does for a longer period.
//
// WHEN. Only when something changed (a new row in the audit trail or the
// sync queue since the last look), at most once a minute, and while a shift
// is open at least every DASH_KEEPALIVE_MINUTES (so the dashboard knows the
// till is there). Nothing at all while the shop is shut and idle: the free
// database may sleep. A till the website has never heard from (or after a
// restore) sends its history first, oldest first, DASH_PUSH_MAX_ORDERS at a
// time, every few seconds until it has caught up.
//
// WHO. Every till with the website link (BRIDGE_SECRET) pushes what it holds;
// two linked tills hold the same orders, and the website keeps the newest
// copy of each (docUpdatedAt). Stock and the menu are per till: each till's
// own count (ingredients.current_qty is per till), each till's own menu.

/** The newest the website keeps, per kind of row (ISO, the till's own updated_at). */
export interface DashPushCursors {
  /** Orders and everything inside them: lines, choices, payments, discounts, costs, foodpanda terms. */
  orders: string | null;
  shifts: string | null;
  cashMoves: string | null;
  drawerOpens: string | null;
  stockMoves: string | null;
  /** The newest menu row the last menu snapshot covered. */
  menu: string | null;
}

export const DASH_CURSOR_KINDS = ['orders', 'shifts', 'cashMoves', 'drawerOpens', 'stockMoves', 'menu'] as const;

/** One push carries at most this many orders (about 0.5 MB): the history goes in turns. */
export const DASH_PUSH_MAX_ORDERS = 200;
/** …and of each other kind of row. */
export const DASH_PUSH_MAX_ROWS = 1_000;
/** The whole body, as JSON characters: under the host's 4.5 MB limit with room. */
export const DASH_PUSH_MAX_CHARS = 2_500_000;
/** Stock movements older than this many days are not sent with the history (the dashboard lists recent ones). */
export const DASH_STOCK_MOVES_DAYS = 120;
/** While a shift is open and nothing changes, the till still says it is there this often. */
export const DASH_KEEPALIVE_MINUTES = 10;
/** The dashboard calls a till quiet when it has not been heard from for this long while its shift is open. */
export const DASH_QUIET_MINUTES = 25;

export type DashOrderStatus =
  | 'open'
  | 'sent_to_kitchen'
  | 'preparing'
  | 'ready'
  | 'out_for_delivery'
  | 'delivered'
  | 'served'
  | 'paid'
  | 'void'
  | 'refunded';

export type DashOrderMode = 'dine_in' | 'takeaway' | 'delivery' | 'online' | 'foodpanda';

/** analytics/sql.ts channelOf. */
export type DashChannel = 'takeaway' | 'delivery' | 'web_pickup' | 'web_delivery' | 'foodpanda' | 'dine_in' | 'online';

/** orders.came_by (shop-settings.ts CAME_BY), null = not asked. */
export type DashCameBy = 'walk_in' | 'phone' | 'whatsapp' | 'website' | 'foodpanda';

export type DashPaymentMethod = 'cash' | 'card' | 'easypaisa' | 'jazzcash' | 'bank_transfer' | 'foodpanda';

export interface DashOrderLine {
  /** order_items.id */
  id: string;
  /** The name it was sold under (snapshot). */
  name: string;
  /** The item's category today (null when the item is gone). */
  category: string | null;
  menuItemId: string | null;
  qty: number;
  unitPriceCents: number;
  lineTotalCents: number;
  /** "Large: Fajita", "No onion", "+ Extra cheese (Rs …)" — the choices as sold, in the till's order. */
  choices: DashLineChoice[];
  note: string | null;
  /** A delivery charge (by the name it was sold under, or a delivery area's fee item): never a "top item". */
  isFee: boolean;
  /** This line's food cost kept with the sale (order_item_costs, failed rows left out); null when none kept. Owner and managers only. */
  costCents: number | null;
}

export interface DashLineChoice {
  name: string;
  priceDeltaCents: number;
}

export interface DashPayment {
  id: string;
  method: DashPaymentMethod;
  /** Below 0: money handed back (a refund). */
  amountCents: number;
  tenderedCents: number | null;
  at: string;
  /** Who took it (on a refund: who approved it). */
  by: string | null;
  shiftId: string | null;
}

export interface DashDiscount {
  /** 'percent' | 'flat' */
  kind: string;
  /** The percent (10 = 10%), or the flat amount in cents. */
  value: number;
  amountCents: number;
  reason: string | null;
  /** null = staff (or the website's pick-up / delivery %), else 'foodpanda' | 'offer'. */
  source: string | null;
  by: string | null;
  approvedBy: string | null;
  at: string;
}

/** One order, whole: the till's row and everything inside it, with the till's own verdicts. */
export interface DashOrderDoc {
  id: string;
  /** The till that took it (orders.device_id). */
  deviceId: string;
  /** YYYYMMDD-NNNN; two tills can give the same number — the id is the key. */
  number: string;
  status: DashOrderStatus;
  mode: DashOrderMode;
  source: 'pos' | 'web';
  channel: DashChannel;
  cameBy: DashCameBy | null;
  createdAt: string;
  sentAt: string | null;
  paidAt: string | null;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  voidedAt: string | null;
  /** The newest updated_at of anything inside it: the website keeps the newest copy. */
  docUpdatedAt: string;
  /** Sales are dated by when the order was started: created_at's trading day (05:00–05:00 Karachi = the UTC date). */
  tradingDay: string;
  /** Karachi hour (0–23) the order was started. */
  hour: number;
  /** analytics/sql.ts COUNTED: not deleted, paid, not void or refunded. */
  counted: boolean;
  /** 'test' = a test order the owner deleted; 'discarded' = a cart thrown away; null = live. */
  deleted: 'test' | 'discarded' | null;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  /** Partial refunds (and a full refund's money), from the negative payments. */
  refundedCents: number;
  /** total − refunded: what Reports count for it. */
  netCents: number;
  /** The bill had it all been paid by card (0052), null when no card rate. */
  digitalTotalCents: number | null;
  /** An outside rider kept this much of the delivery charge (frozen at Send out). */
  riderKeepsCents: number | null;
  customer: { name: string | null; phone: string | null; address: string | null; area: string | null } | null;
  notes: string | null;
  cashier: string | null;
  rider: string | null;
  voidedBy: string | null;
  voidReason: string | null;
  deletedBy: string | null;
  deleteReason: string | null;
  shiftId: string | null;
  lines: DashOrderLine[];
  payments: DashPayment[];
  discounts: DashDiscount[];
  /** A foodpanda order's terms, frozen at payment (order_channel_terms). */
  foodpanda: { commissionCents: number | null; expectedPayoutCents: number | null; dealLabel: string | null } | null;
}

export interface DashShiftDoc {
  id: string;
  deviceId: string;
  openedAt: string;
  openedBy: string | null;
  openingCashCents: number;
  closedAt: string | null;
  closedBy: string | null;
  expectedCashCents: number | null;
  countedCashCents: number | null;
  varianceCents: number | null;
  openNote: string | null;
  closeNote: string | null;
  carriedUnpaidCount: number;
  carryOverReason: string | null;
  /** counted_notes_json as stored (shared-schemas cash-count); null when not counted by note. */
  countedNotes?: unknown;
  /** close_report_json as stored (shared-types shift-report ShiftReport); null before 0.7.35 or while open. */
  closeReport?: unknown;
  updatedAt: string;
}

export interface DashCashMove {
  id: string;
  shiftId: string;
  deviceId: string;
  type: 'payin' | 'payout' | 'tip_out';
  amountCents: number;
  reason: string;
  by: string | null;
  approvedBy: string | null;
  /** A payout to an outside rider for this order. */
  orderId: string | null;
  /** A payout that paid for stock. */
  purchase: boolean;
  createdAt: string;
  deleted: boolean;
  updatedAt: string;
}

export interface DashDrawerOpen {
  id: string;
  shiftId: string | null;
  deviceId: string;
  kind: string;
  reason: string | null;
  by: string | null;
  approvedBy: string | null;
  orderId: string | null;
  /** Signed: + into the drawer, − out; null when no money moved. */
  amountCents: number | null;
  outcome: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DashStockItem {
  id: string;
  name: string;
  /** g, ml, pcs… */
  unit: string;
  category: string | null;
  /** This till's count, in `unit`. */
  onHand: number;
  lowAt: number | null;
  /** Price per 1,000 units, millicents-free (paisa): null when not priced. Owner and managers only. */
  pricePerThousandCents: number | null;
  priceKind: string | null;
  /** A key item counted weekly. */
  keyItem: boolean;
  /** Made in-house from a batch recipe. */
  batch: boolean;
  active: boolean;
}

export interface DashStockMove {
  id: string;
  deviceId: string;
  ingredientId: string;
  ingredient: string;
  /** Signed, in `unit`. */
  delta: number;
  unit: string;
  reason: 'sale' | 'delivery' | 'waste' | 'count' | 'transfer' | 'adjustment';
  /** batch_in, waste:<reason>, cancel_made, stock_take… */
  detail: string | null;
  /** Signed paisa at the stock's cost; null before costing. */
  valueCents: number | null;
  orderId: string | null;
  note: string | null;
  by: string | null;
  at: string;
  deleted: boolean;
  updatedAt: string;
}

export interface DashMenuItem {
  id: string;
  categoryId: string | null;
  name: string;
  priceCents: number;
  /** On sale at the till. */
  active: boolean;
  web: 'on' | 'pickup_only' | 'off';
  taxRateBps: number | null;
  sortOrder: number;
  /** Plate cost from the till's Costing (menu.manage): null when it can't be worked out. */
  costCents: number | null;
}

export interface DashMenuCategory {
  id: string;
  name: string;
  displayOrder: number;
  active: boolean;
  onWebsite: boolean;
}

export interface DashMenu {
  categories: DashMenuCategory[];
  items: DashMenuItem[];
  /** The newest updated_at among the menu rows. */
  updatedAt: string;
}

/**
 * One trading day's food cost, waste and profit, as the till's Reports
 * builders work them out for that day alone (Food cost & stock; Profit).
 * Only sums: the website adds days, then works percentages from the sums.
 */
export interface DashDayFigures {
  day: string;
  /**
   * The till's Reports cover every till of the shop: the second-till link is
   * on, so this till's database holds the other till's orders too. The
   * website then takes ONE till's figures for the day (the newest), never
   * the sum of both. false: this till's own orders only; tills are added.
   */
  shopWide: boolean;
  food: {
    foodSalesCents: number;
    feeSalesCents: number;
    costOfSalesCents: number;
    knownSalesCents: number;
    knownCostCents: number;
    knownMenuSalesCents: number;
    estimatedOrders: number;
    estimatedCostCents: number;
    missingSalesCents: number;
    wasteCents: number;
    cancelledWasteCents: number;
    wasteByReason: Array<{ reason: string; times: number; cents: number }>;
  };
  /** Owner only on the dashboard. null when the till could not work it out (logged on the till). */
  profit: {
    profitCents: number;
    steps: Array<{ key: string; cents: number }>;
    unknownSalesCents: number;
    estimatedOrders: number;
  } | null;
  purchasesCents: number;
  workedOutAt: string;
}

/** The till right now: sent with every push. */
export interface DashLive {
  /** This till's open shift, with the close box's figures as they stand. */
  shift: {
    id: string;
    openedAt: string;
    openedBy: string | null;
    openingCashCents: number;
    cashSalesCents: number;
    cashRefundsCents: number;
    cashInCents: number;
    cashOutCents: number;
    expectedCashCents: number;
  } | null;
  /** Orders on this till's Live Orders board, by column. */
  board: { kitchen: number; ready: number; out: number; unpaidHandedOver: number; oldestWaitingSince: string | null };
  /** The website switch on this till. */
  web: { linked: boolean; ordersOn: boolean; accepting: boolean; pausedByShift: boolean };
  /** Kitchen tickets or bills that did not print. */
  notPrinted: number;
  /** Ingredients at or under their low mark on this till. */
  lowStock: number;
}

export interface DashPushBody {
  v: 1;
  till: { deviceId: string; deviceName: string | null; appVersion: string; sentAt: string };
  live: DashLive;
  orders?: DashOrderDoc[];
  shifts?: DashShiftDoc[];
  cashMoves?: DashCashMove[];
  drawerOpens?: DashDrawerOpen[];
  stockMoves?: DashStockMove[];
  /** This till's whole stock list: replaces its last one. */
  stock?: DashStockItem[];
  /** This till's whole menu: replaces its last one. */
  menu?: DashMenu;
  days?: DashDayFigures[];
  /** Where the till will be up to once this push is kept. */
  cursors: DashPushCursors;
  /** false while the history is still on its way. */
  caughtUp: boolean;
}

export interface DashPushResult {
  cursors: DashPushCursors;
  stored: { orders: number; shifts: number; cashMoves: number; drawerOpens: number; stockMoves: number; days: number };
  serverTime: string;
}

export interface DashPushState {
  /** null: the website has never heard from this till (send the history). */
  cursors: DashPushCursors | null;
  /**
   * The trading days the website holds this till's day figures for (the last
   * DASH_DAYS_KNOWN_MAX): a till works out the days it has orders for and the
   * website lacks — the history after a restart part-way, or a first push.
   */
  daysKnown: string[];
}

/** How many of a till's known days the website lists back (well over a year of trading). */
export const DASH_DAYS_KNOWN_MAX = 500;

// ---------------------------------------------------------------------------
// Trading days (shared by the till's push and the website's periods)
// ---------------------------------------------------------------------------

/** Pakistan is UTC+5 all year (no daylight saving). */
export const KARACHI_OFFSET_MINUTES = 300;

/**
 * The trading day of an instant: 05:00–05:00 Karachi, which is exactly the
 * UTC date (analytics/sql.ts TRADING_DAY_OFFSET_MS = 0).
 */
export function dashTradingDay(iso: string): string {
  return new Date(Date.parse(iso)).toISOString().slice(0, 10);
}

/** The Karachi hour (0–23) of an instant. */
export function dashKarachiHour(iso: string): number {
  const ms = Date.parse(iso) + KARACHI_OFFSET_MINUTES * 60_000;
  return new Date(ms).getUTCHours();
}

// ---------------------------------------------------------------------------
// The till's side: the Settings card (Online orders → Phone dashboard)
// ---------------------------------------------------------------------------

/**
 * 'dashboard.push' (this till's own setting, never synced): { on }. Never
 * saved = on — a till with the website link sends its figures, as the user
 * asked (8 Oct 2026). The owner can switch one till off.
 */
export const DASH_PUSH_SETTING_KEY = 'dashboard.push';

export type DashPushPhase =
  /** The owner switched it off on this till. */
  | 'off'
  /** No website link (Settings → Online orders → the website's address and password). */
  | 'not_linked'
  /** The website has no dashboard yet (it needs its update). */
  | 'website_old'
  /** Just started: asking the website where it is up to. */
  | 'starting'
  /** Sending the history, a batch every few seconds. */
  | 'sending_history'
  /** Everything sent; it sends again when something changes. */
  | 'up_to_date'
  /** The last try failed; it tries again by itself. */
  | 'failing';

export interface DashPushStatus {
  on: boolean;
  phase: DashPushPhase;
  lastSentAt: string | null;
  lastError: string | null;
  /** Orders sent since the till started. */
  ordersSent: number;
  /** The dashboard on this till's website (from the website link), or null without one. */
  dashboardUrl: string | null;
}

/** A person added, or a new setup code made: the list as the website has it now, and the code, shown ONCE. */
export interface DashLoginMade {
  logins: DashLoginView[];
  username: string;
  /** XXXX-XXXX-XXXX — never stored on the till, never in a log. */
  code: string;
  expiresAt: string;
}

