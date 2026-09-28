/**
 * Web bridge contract — the JSON shapes that travel between the online
 * ordering website (apps/web, Next.js on Vercel + Neon Postgres) and the
 * POS bridge worker (apps/pos/electron/services/web-orders-bridge.ts).
 *
 * Flow:
 *   1. POS publishes its menu → PUT /api/bridge/menu  (PublishedMenu)
 *   2. Customer orders on the site → row in web_orders (WebOrder, status 'new')
 *   3. POS polls GET /api/bridge/orders?status=new → imports each order
 *      locally (mode 'delivery', source 'web') → POST .../ack with the local
 *      order number
 *   4. As the order advances on the Live Orders board, the POS pushes
 *      POST .../status so the customer's tracking page stays live.
 *
 * All money in cents, all rates in basis points — same discipline as the POS.
 */

export interface PublishedMenuItem {
  /** POS menu_items.id — the bridge uses this to add real order items. */
  posItemId: string;
  name: string;
  description: string | null;
  basePriceCents: number;
  /** Snapshot of the tax rate so the cart can estimate totals. */
  taxRateBps: number;
  imageUrl: string | null;
  sortOrder: number;
  modifierGroups: PublishedModifierGroup[];
}

export interface PublishedModifierGroup {
  posGroupId: string;
  name: string;
  selectionType: 'single' | 'multi';
  minSelect: number;
  maxSelect: number;
  isRequired: boolean;
  sortOrder: number;
  modifiers: PublishedModifier[];
}

export interface PublishedModifier {
  posModifierId: string;
  name: string;
  priceDeltaCents: number;
  isDefault: boolean;
  sortOrder: number;
}

export interface PublishedMenuCategory {
  posCategoryId: string;
  name: string;
  displayOrder: number;
  items: PublishedMenuItem[];
}

export interface PublishedMenu {
  categories: PublishedMenuCategory[];
  /** ISO timestamp of the publish — site shows menus only if non-stale. */
  publishedAt: string;
  store: {
    name: string;
    phone: string | null;
    whatsapp: string | null;
    addressLine: string | null;
    tagline: string | null;
  };
  /**
   * The owner's settings the website needs (Settings step 3): absent from a
   * till older than v0.7.27, and from a publish whose block did not pass
   * settingsBlockProblem against this same menu. See THE SETTINGS BLOCK below.
   */
  settings?: PublishedSettings;
}

// ---------------------------------------------------------------------------
// THE SETTINGS BLOCK (Settings step 3) — the contract between the till and
// the website. Builder of the website side: read this, nothing else.
// ---------------------------------------------------------------------------
//
// WHAT. PUT /api/bridge/menu (PublishedMenu) gains an optional `settings`
// (PublishedSettings): the delivery areas with their fees and fee items, and
// the pick-up offer. One document, so a fee can never arrive without its
// item. Schema: @cheeseoclock/shared-schemas publishedSettingsSchema (Zod;
// non-strict, unknown fields are dropped). Money in paisa, whole rupees.
//
// THE STAMP. `settingsRev` = the sum of the carried keys' row versions on
// the till (PUBLISHED_SETTING_KEYS), `settingsAt` = the newest of their
// updated_at. The tills settle each key by (version, updated_at), so this
// pair only ever grows as the tills agree; compare with compareSettingsStamp
// (rev first, then settingsAt). Wall-clock order is NOT the order: a till
// that saved twice offline wins with an older time.
//
// WHEN THE TILL SENDS ONE. Only once one of the carried keys is saved on
// either till (settingsRev >= 1): until then no block is ever sent and the
// website stays exactly as today. From then on every menu publish carries
// the block, and ANY till with the website link publishes by itself when
// its stamp is newer than the one the website last confirmed to it
// (data.settingsRev / data.settingsAt of the 200 below) — a Save there, or
// one synced from the other till. The WEBSITE decides what it stores.
//
// WHAT THE WEBSITE DOES with a PUT /api/bridge/menu, in ONE SQL statement on
// the site_menu row (a read-then-write lets an older till wipe a newer block):
//   1. Menu and block shape checked together (MenuSchema + the block schema):
//      a malformed block → 400 { ok:false, error:'validation', details }.
//   2. settingsBlockProblem(block, menu) (this file) on the SAME incoming
//      menu → 400 { ok:false, error:'settings_invalid', message } and
//      NOTHING is stored (not the menu either). The message is shown to the
//      owner ("Website not updated: …"). The till checks this itself first
//      and never sends a block that fails it; it then publishes without one.
//      Also refuse a settingsAt more than SETTINGS_MAX_CLOCK_AHEAD_MS ahead
//      of the website's clock (settings_invalid, "the till's clock is
//      ahead"): one till with a wrong clock must not lock out later blocks.
//   3. Stored:
//      - a publish WITHOUT a block (an older till) keeps the stored block
//        with the new menu → data.settings 'kept' (or 'none' when there is
//        no stored block either);
//      - a block whose stamp is OLDER than the stored one (compareSettingsStamp
//        < 0) is dropped, the stored block kept, the menu still stored →
//        'ignored_older';
//      - otherwise (newer or EQUAL) the block is stored with the menu → 'stored'.
//   4. 200 { ok:true, data: PublishMenuResult }, data.settingsAt /
//      data.settingsRev = the block stored now (null when none).
//      revalidatePath after anything was stored.
//
// WHAT THE TILL DOES WITH THE ANSWER (web-orders-bridge publishMenu):
//   - 200 with data.settings 'stored' | 'ignored_older' | 'kept': the block
//     (or a newer one) is on the website; the till records the higher of
//     its stamp and data's, and sends again only when it has a newer one;
//   - 200 WITHOUT data.settings: a website older than the block (it dropped
//     it, the menu is stored); Settings says the website needs its update;
//   - 400 { ok:false, error:'settings_invalid', message }: the till sends
//     the same menu again WITHOUT the block (so the menu still goes) and
//     shows `message` to the owner. Keep that body shape exactly: any other
//     failure is treated as a failed publish and retried.
//
// Because a kept block may meet a menu from an older till that lacks its
// fee item, the order route looks a zone's item up in the stored menu by
// feeItemId, then by name and price (today's findDeliveryChargeItem), then
// writes today's "add the delivery charge by hand" note.
//
// ZONES. The till sends EVERY area it has ever had (switched-off ones with
// active:false; an id never changes and is never removed; the 21 compiled
// ids are always there), in display order (`sort` 0, 1, 2…). An area
// switched off keeps its page and slug on the website and says delivery is
// paused; checkout refuses it. `group` is free text ("DHA", "Clifton",
// "PECHS"). `feeCents` 0 = no delivery charge (feeItemId null, no line).
// For an ACTIVE area with a fee, feeItemId is the posItemId of an item in
// the same menu at exactly feeCents, named "Delivery Charge (Rs N)"
// (isDeliveryChargeName) — so the website's by-name fee filters keep
// working; recognise fee items by name OR by these ids.
//
// PICK-UP. pickup.offered AND the heartbeat's 'pickup' feature AND the
// shop accepting orders = pick-up available; pickup.percent (a whole %,
// 0–50) is the discount. The heartbeat keeps sending pickupDiscountPercent
// (always 10) for an older website: ignore it once a block is stored.
//
// WITHOUT A BLOCK the website is exactly as today (the compiled
// DELIVERY_ZONES, FEE_SUMMARY, the heartbeat's %).

/** The stamp of a block made from defaults only (no key saved on the till). */
export const DEFAULT_SETTINGS_AT = '1970-01-01T00:00:00.000Z';

/** The website refuses a block stamped further than this ahead of its own clock. */
export const SETTINGS_MAX_CLOCK_AHEAD_MS = 10 * 60_000;

/** The shop settings a block carries (their row versions and times make its stamp). */
export const PUBLISHED_SETTING_KEYS = ['delivery.zones', 'discounts.websitePickup'] as const;

/** One delivery area in the settings block. */
export interface PublishedZone {
  /** Never changes, never removed: ^[a-z0-9]+(-[a-z0-9]+)*$, at most 40 long. */
  id: string;
  /** "DHA Phase 6". */
  name: string;
  /** "Phase 6". */
  shortName: string;
  /** Free text group heading ("DHA", "Clifton"). */
  group: string;
  /** Paisa, whole rupees, 0–200,000 (Rs 0–2,000). */
  feeCents: number;
  /** posItemId of the fee's "Delivery Charge (Rs N)" item in the same menu; null for Rs 0 (and possible on an inactive area). */
  feeItemId: string | null;
  /** false = delivery there is paused (its page stays; checkout refuses it). */
  active: boolean;
  /** Display order, 0-based. */
  sort: number;
  /** Other names for it (old names after a rename): for recognising, never shown. */
  aliases: string[];
}

export interface PublishedPickup {
  /** Customers may choose pick-up (still only while the shop accepts orders and the till can import pick-ups). */
  offered: boolean;
  /** A whole % off a pick-up, 0–50. */
  percent: number;
}

export interface PublishedSettings {
  /** The block's format: 1. */
  v: number;
  /** Newest updated_at of the carried keys (ISO 8601 UTC); DEFAULT_SETTINGS_AT when none is saved. */
  settingsAt: string;
  /** Sum of the carried keys' row versions on the till (0 = none saved). */
  settingsRev: number;
  pickup: PublishedPickup;
  /** Every area, in display order. */
  zones: PublishedZone[];
}

/**
 * Where this till's settings block stands with the website (the bridge's
 * status, Settings → Online orders):
 *  - 'none': nothing to send (no setting in the block is saved on either till);
 *  - 'published': the website holds this till's block, or a newer one (`at`);
 *  - 'waiting': a newer block is waiting to go (no website link, offline, retrying);
 *  - 'refused': the block did not go (`message`: why, in the owner's words);
 *  - 'unsupported': the website is older than the settings block (update it).
 */
export interface SettingsPublishStatus {
  state: 'none' | 'published' | 'waiting' | 'refused' | 'unsupported';
  /** When the website last confirmed a block from this till (ISO), else null. */
  at: string | null;
  message: string | null;
}

/** What the website did with a publish's block. */
export type PublishSettingsOutcome = 'stored' | 'kept' | 'ignored_older' | 'none';

/** data of a 200 from PUT /api/bridge/menu. `settings` is absent from a website older than the block. */
export interface PublishMenuResult {
  categories: number;
  items: number;
  settings?: PublishSettingsOutcome;
  /** The block the website holds now (after this publish); null = none. */
  settingsAt?: string | null;
  settingsRev?: number | null;
}

/** A block's stamp. */
export interface SettingsStamp {
  settingsRev: number;
  settingsAt: string;
}

/**
 * Order two blocks' stamps: negative when `a` is older than `b`, 0 when
 * the same, positive when newer. The revision first (the tills settle each
 * key by version first), then the time. An unreadable time counts as the
 * oldest.
 */
export function compareSettingsStamp(a: SettingsStamp, b: SettingsStamp): number {
  if (a.settingsRev !== b.settingsRev) return a.settingsRev < b.settingsRev ? -1 : 1;
  const ta = Date.parse(a.settingsAt);
  const tb = Date.parse(b.settingsAt);
  const x = Number.isFinite(ta) ? ta : -Infinity;
  const y = Number.isFinite(tb) ? tb : -Infinity;
  return x === y ? 0 : x < y ? -1 : 1;
}

/**
 * Why a block can't go with this menu, in the owner's words — or null when
 * it can. The website refuses a publish whose block fails it (nothing
 * stored); the till checks first and publishes without the block instead.
 * Every ACTIVE area with a fee must name an item of this menu that costs
 * exactly its fee and is named like a delivery charge; a Rs 0 area names
 * none. (Shape — ids, bounds, unique ids — is the schema's.)
 */
export function settingsBlockProblem(
  block: Pick<PublishedSettings, 'zones'>,
  menu: Pick<PublishedMenu, 'categories'>,
): string | null {
  const items = new Map<string, PublishedMenuItem>();
  for (const c of menu.categories) for (const i of c.items) items.set(i.posItemId, i);
  for (const z of block.zones) {
    if (!z.active) continue;
    const rupees = `Rs ${Math.round(z.feeCents / 100).toLocaleString('en-US')}`;
    if (z.feeCents === 0) {
      if (z.feeItemId !== null) return `${z.name}: delivery is free there, so it takes no delivery charge item`;
      continue;
    }
    if (!z.feeItemId) return `${z.name}: no "Delivery Charge (${rupees})" item on the menu`;
    const item = items.get(z.feeItemId);
    if (!item) return `${z.name}: its "Delivery Charge (${rupees})" item is not on the menu (hidden or removed?)`;
    if (item.basePriceCents !== z.feeCents) {
      return `${z.name}: its delivery charge item costs Rs ${Math.round(item.basePriceCents / 100).toLocaleString('en-US')}, not ${rupees}`;
    }
    if (!/^delivery charge/i.test(item.name.trim())) return `${z.name}: its delivery charge item is called "${item.name}"`;
  }
  return null;
}

/** Customer-side order line as captured by the website cart. */
export interface WebOrderItem {
  posItemId: string;
  name: string;
  quantity: number;
  /** Price shown to the customer at order time (estimate; POS recomputes). */
  unitPriceCents: number;
  modifiers: Array<{
    posModifierId: string;
    name: string;
    priceDeltaCents: number;
  }>;
  notes: string | null;
}

/**
 * How the customer gets the food. 'pickup' = collected from the shop, with
 * PICKUP_DISCOUNT_PERCENT off. Orders from sites that predate pickup carry no
 * fulfilment field and are deliveries.
 */
export type WebFulfilment = 'delivery' | 'pickup';

/**
 * The printed menu's offer: "10% OFF · order online & pick up" (owner,
 * 2026-09-25: back to 10% — it was 10% in v0.7.0 and 15% in v0.7.1). This is
 * the percent the till applies at import; it announces it in its heartbeat so
 * the website always shows the discount the till will actually bill.
 */
export const PICKUP_DISCOUNT_PERCENT = 10;

/** What a till that offers pickup but sends no percent (v0.7.0) applies. */
export const LEGACY_PICKUP_DISCOUNT_PERCENT = 10;

/**
 * Capabilities a till announces in its heartbeat (PUT /api/bridge/status).
 * The site only offers pickup while the listening till says it can import
 * pickup orders — an older POS would book them as deliveries at full price.
 */
export type TillFeature = 'pickup';

/**
 * Why a till has stopped the website taking orders by itself. It is kept
 * apart from the owner's "Accept online orders" switch, which it never
 * changes. 'shift_closed': the last open shift on the till was closed (owner,
 * 2026-09-27). Opening a shift lifts it; a switch the owner turned off by hand
 * stays off.
 */
export type WebOrdersPauseReason = 'shift_closed';

/** The till's own pause of website orders, as Settings → Online orders shows it. */
export interface WebOrdersShiftPause {
  reason: WebOrdersPauseReason;
  /** When the pause began (ISO 8601 UTC). */
  since: string;
  /** One line for the owner: why orders stopped, and what starts them again. */
  message: string;
}

/** Body for PUT /api/bridge/status (the till's heartbeat). */
export interface BridgeHeartbeatBody {
  acceptingOrders: boolean;
  deviceId?: string | null;
  features?: TillFeature[];
  /** The pickup discount this till applies (absent from v0.7.0: 10). */
  pickupDiscountPercent?: number;
  /**
   * Sent with acceptingOrders false when the till paused itself rather than
   * the owner switching ordering off. Every site so far drops keys it does
   * not know (its schema is not strict), so older sites are unaffected.
   */
  reason?: WebOrdersPauseReason;
}

export type WebOrderStatus =
  | 'new' // placed on the site, not yet seen by the POS
  | 'accepted' // imported into the POS (ack'd)
  | 'preparing'
  | 'ready'
  | 'out_for_delivery'
  | 'delivered'
  | 'cancelled';

export interface WebOrder {
  /** UUID generated by the website. */
  id: string;
  status: WebOrderStatus;
  customerName: string;
  customerPhone: string;
  /** For a pickup order, a fixed "collect from the shop" line. */
  addressLine: string;
  area: string | null;
  notes: string | null;
  /** Absent on orders from sites that predate pickup: a delivery. */
  fulfilment?: WebFulfilment;
  items: WebOrderItem[];
  /** Estimates computed by the site; the POS receipt is authoritative. */
  subtotalCents: number;
  /** The pickup discount the site showed (0 for deliveries). */
  discountCents?: number;
  taxCents: number;
  totalCents: number;
  paymentMethod: 'cod';
  createdAt: string;
  /** Set when the POS imports the order. */
  posOrderId: string | null;
  posOrderNumber: string | null;
}

/** Body for POST /api/bridge/orders/:id/ack */
export interface BridgeAckBody {
  posOrderId: string;
  posOrderNumber: string;
}

/** Body for POST /api/bridge/orders/:id/status */
export interface BridgeStatusBody {
  status: Exclude<WebOrderStatus, 'new'>;
}
