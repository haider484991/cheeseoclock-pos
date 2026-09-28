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

import type { ClosedNotice, WebsiteAnnouncement } from './website-messages.js';

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
  /**
   * Set to "Pick-up only" on the till (Menu → the item → On the website:
   * MenuItem.webAvailability 'pickup_only'). Sent ONLY as `true`; absent on
   * every other item, so a menu at the defaults is byte-for-byte the menu an
   * older till sends. See "SELLING ON THE WEBSITE" below.
   */
  pickupOnly?: boolean;
}

/**
 * The longest item photo the publish carries (data-URL characters, not
 * bytes — about 300 KB): a bigger one is left out (the item goes with no
 * photo) so a handful of old photos can't blow past the website host's
 * request-size limit. The till says which (Menu editor, publish result).
 */
export const PUBLISHED_IMAGE_MAX_CHARS = 300_000;

/** An item whose photo the publish left out (over PUBLISHED_IMAGE_MAX_CHARS). */
export interface PhotoLeftOut {
  /** The till's menu_items.id. */
  id: string;
  name: string;
}

/** What the till's "Publish menu" answers (webBridge:publishMenu). */
export interface PublishMenuSummary {
  categories: number;
  items: number;
  /** Items published WITHOUT their photo (too big for the website), in menu order; [] when none. */
  photosLeftOut: PhotoLeftOut[];
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
   * till older than v0.7.29, and from a publish whose block did not pass
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
// THE STAMP. Three numbers, compared in this order (compareSettingsStamp):
// `settingsRev` = the sum of the carried keys' row versions on the till
// (PUBLISHED_SETTING_KEYS), `settingsAt` = the newest of their updated_at,
// `settingsTie` = the SUM of their updated_at in ms. The tills settle each
// key by (version, updated_at), so the settled state is at least as new as
// any till's, key by key — and any state that differs from it compares
// strictly older on these three (the sum and the newest time alone did not:
// two area lists saved offline at the same version could share them).
// Wall-clock order is NOT the order: a till that saved twice offline wins
// with an older time. `deviceId` = the till that sent the block.
//
// WHEN THE TILL SENDS ONE. Only once one of the carried keys is saved on
// either till (settingsRev >= 1): until then no block is ever sent and the
// website stays exactly as today. From then on every menu publish (the
// owner's Publish, a menu file import, "Publish the menu by itself")
// carries the block. And ANY till with the website link sends the block
// ALONE by itself (PUT /api/bridge/settings, below) when the website needs
// it (websiteNeedsSettings in the till): the website holds no block, an
// older stamp, a block its stored menu lacks a fee item for (settingsProblem
// below), or this till's own block while this till has saved since at a
// later time (after a restore from an older backup its versions went back).
// A Save there, or one synced from the other till. A Save NEVER sends the
// till's menu: menu changes not published stay on the till. The WEBSITE
// decides what it stores. A block the website refused, or one the till's
// own check stopped, is not sent again by itself until the stamp changes.
//
// THE BLOCK ALONE: PUT /api/bridge/settings (PublishSettingsBody) = the
// block and `feeItems`, the "Delivery Charge (Rs N)" items its ACTIVE areas
// name (each as the till's menu has it, with its category). The website
// stores the block with the menu it ALREADY holds — the last one published
// — with only those items put in (replaced in place when there, else added
// to their category, made when missing): never food, never another price.
//   - no menu stored yet → 409 { ok:false, error:'menu_not_published' }
//     (the till says "press Publish");
//   - a fee item no active area of the block names at its fee, or not named
//     as a delivery charge → 400 { ok:false, error:'validation' };
//   - settingsBlockProblem against the menu WITH the items → 400
//     settings_invalid (as below), nothing stored;
//   - the stamp rule of step 3 below; an older block writes nothing
//     ('ignored_older');
//   - one guarded UPDATE (the menu as read, unchanged): a menu publish that
//     lands between the read and the write is never overwritten — the
//     website reads again and puts the items into the new menu;
//   - 200 { ok:true, data: PublishMenuResult } for the menu stored now.
// A website older than this route answers 404: the till says the website
// needs its update, and sends nothing more by itself.
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
//        'ignored_older' — UNLESS the stored block came from the same till
//        (deviceId) and this one's settingsAt is later: a till may always
//        replace its own block with a later Save;
//      - otherwise (newer or EQUAL) the block is stored with the menu → 'stored'.
//   4. 200 { ok:true, data: PublishMenuResult }: data.settingsAt /
//      settingsRev / settingsTie / settingsDeviceId = the block held now
//      (null when none), and data.settingsProblem = settingsBlockProblem of
//      that held block against the menu stored now (null when it fits): a
//      kept block may meet a menu from a till that has not received its fee
//      item yet. revalidatePath after anything was stored.
//   GET /api/bridge/status answers the same under data.settings
//   (WebsiteSettingsHeld; null = no block), so a till can see a website that
//   lost its block (a database rollback).
//
// WHAT THE TILL DOES WITH THE ANSWER (web-orders-bridge publishMenu and
// publishSettingsAlone):
//   - 200 with data.settings: it records what the website holds (stamp,
//     device, problem) and sends again only when websiteNeedsSettings says;
//   - 200 WITHOUT data.settings (a menu publish), or 404 (the block alone):
//     a website older than the block; Settings says the website needs its
//     update;
//   - 400 { ok:false, error:'settings_invalid', message }: a Publish sends
//     the same menu again WITHOUT the block (so the menu still goes); the
//     block alone stops there. Either way `message` is shown to the owner.
//     Keep that body shape exactly: any other failure is treated as a
//     failed publish and retried.
//
// Because a kept block may meet a menu that lacks its fee item, the order
// route looks a zone's item up in the stored menu by feeItemId, then by name
// and price (today's findDeliveryChargeItem), then writes today's "add the
// delivery charge by hand" note — the block and the menu from ONE read, so a
// publish landing in between can't pair an area with another menu's items.
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
//
// ---------------------------------------------------------------------------
// v0.7.30 — WEBSITE MESSAGES (sweep B1) and SELLING ON THE WEBSITE (B5 + M2).
// The contract between the till (builder A) and the website (builder B).
// ---------------------------------------------------------------------------
//
// DEPLOY ORDER. The website goes first (a push to main deploys it), the tills
// follow within hours. So the website must behave EXACTLY as today until a
// till sends the new fields, and keep working when a v0.7.29 till publishes
// (its block has none of them; its items never carry `pickupOnly`).
//
// WEBSITE MESSAGES. The block (PublishedSettings, still `v: 1`) gains three
// OPTIONAL fields, flat on the block (types and pure helpers:
// shared-types website-messages.ts; bounds: publishedSettingsSchema):
//   closedNotice?: { text, until }  text: one line, <= CLOSED_NOTICE_MAX (160)
//       letters, no WEBSITE_TEXT_FORBIDDEN_RE characters; '' = no notice.
//       until: 'YYYY-MM-DD', the LAST Karachi calendar day it shows (whole
//       day included), or null = no end (every night the website is closed).
//   announcement?: { on, text }     text <= ANNOUNCEMENT_MAX (120), same rule.
//   minDeliveryOrderCents?: number  paisa, whole rupees, 0..500_000
//       (MIN_DELIVERY_ORDER_MAX_CENTS); 0 = no minimum.
// A till of this version ALWAYS sends all three, at their defaults too
// ('' / null, off, 0): a field sent at its default CLEARS it on the website.
// A block WITHOUT a field (a v0.7.29 till) means "no word about it": the
// website KEEPS the value it stored for that field (field by field — the
// stored block's key survives when the incoming block lacks it), exactly as
// it keeps the stored block when a publish carries none. Nothing stored for
// a field = its default = today's website.
// What the website does with them (the defaults change nothing):
//   - closedNoticeInForce(block.closedNotice, now) → the owner's words, or
//     null. While the shop is closed and it is not null, the words REPLACE
//     the explanation sentence of the closed banner (/menu) and of the long
//     closed note at checkout, and the `store_closed` refusal sentence (POST
//     /api/orders; the checkout shows the server's message). The short
//     labels ("Closed", "View order · closed"…) and the WhatsApp and call
//     buttons stay as they are. Worked out on the SERVER per request (the
//     order route; /menu is dynamic and passes the resolved words down):
//     never on a statically built (ISR) page — `until` must end on time.
//   - announcementInForce(block.announcement) → the words while on, else
//     null: the home page's hero/marquee and the /menu header show them;
//     React text only — never in <title>, meta, JSON-LD or
//     dangerouslySetInnerHTML. Off: every page byte-for-byte as today.
//   - minDeliveryOrderCents > 0: a website DELIVERY whose food (each line's
//     unit price with its choices × quantity, BEFORE tax, the delivery
//     charge and any discount) is under it is refused ON THE SERVER, after
//     pricing: 409 { ok:false, error:'below_minimum', message } with a plain
//     sentence built with formatCents (deliveryMinimumShortfallCents says by
//     how much). A pick-up is NEVER refused; the checkout shows "add Rs N
//     more" and blocks. The till's import of a web order never checks it,
//     and orders rung up at the till are not checked. The FAQ "No minimum on
//     the website" line is built from it (0 = today's words).
// The stamp: 'online.options' joins PUBLISHED_SETTING_KEYS, so a Save of the
// messages alone changes the stamp and is sent ALONE (PUT
// /api/bridge/settings) like a Save of the areas — never the menu. Nothing
// changes in the stamp rules; a v0.7.29 till's block (it does not count
// 'online.options') mostly compares older and is 'ignored_older' once an
// updated till has sent one, which is fine: the updated till carries its
// area and pick-up Saves on through the link.
//
// SELLING ON THE WEBSITE. Per item (MenuItem.webAvailability: 'on' |
// 'pickup_only' | 'off') and per category (Category.isOnWebsite), set in the
// till's Menu editor by whoever may edit the menu (menu.manage):
//   - 'off' items, and every item of a category that is off the website, are
//     NOT PUBLISHED (not in PUT /api/bridge/menu, not in feeItems). A web
//     order for one is refused as today's `item_not_on_menu`; the website
//     needs nothing new for them.
//   - 'pickup_only' items are published with `pickupOnly: true`
//     (PublishedMenuItem); the key is absent on every other item. The
//     website reads an item as pick-up only when `pickupOnly === true` OR
//     its description says "pick-up only" (today's rule, kept as the
//     fallback), shows it so, and refuses a DELIVERY with it on the SERVER
//     (today's `not_deliverable`); pick-up passes. Its item schema must
//     accept `pickupOnly: boolean` (optional) — today's strips it, which is
//     why the website deploys first.
//   - Delivery-charge items (an area's feeItemId, or named "Delivery
//     Charge…") are ALWAYS published, whatever their item's or category's
//     website setting — the block's fee check needs them; the website keeps
//     leaving them off its menu pages as today.
//   - Nothing else in the item changes; with every item 'on' and every
//     category on (the defaults after migration 0045) the published menu is
//     byte-for-byte today's.

/** The stamp of a block made from defaults only (no key saved on the till). */
export const DEFAULT_SETTINGS_AT = '1970-01-01T00:00:00.000Z';

/** The website refuses a block stamped further than this ahead of its own clock. */
export const SETTINGS_MAX_CLOCK_AHEAD_MS = 10 * 60_000;

/**
 * The shop settings a block carries (their row versions and times make its
 * stamp). 'online.options' since v0.7.30: its website messages and delivery
 * minimum travel in the block (a Save of them alone changes the stamp).
 */
export const PUBLISHED_SETTING_KEYS = ['delivery.zones', 'discounts.websitePickup', 'online.options'] as const;

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
  /** Sum of the carried keys' updated_at, in ms since 1970 (0 = none saved): the stamp's third number. */
  settingsTie: number;
  /** The till that sent it (its device id): a till may replace its own block with a later Save. */
  deviceId: string;
  pickup: PublishedPickup;
  /** Every area, in display order. */
  zones: PublishedZone[];
  /**
   * WEBSITE MESSAGES (v0.7.30; absent from a v0.7.29 till's block = keep
   * what the website stored). The owner's words while the website is
   * closed; text '' = none.
   */
  closedNotice?: ClosedNotice;
  /** The announcement (off = none). */
  announcement?: WebsiteAnnouncement;
  /** The smallest website DELIVERY order's food, paisa (0 = no minimum). */
  minDeliveryOrderCents?: number;
}

/**
 * Where this till's settings block stands with the website (the bridge's
 * status, Settings → Online orders):
 *  - 'none': nothing to send (no setting in the block is saved on either till);
 *  - 'published': the website holds exactly this till's settings, fitting its menu (`at`: when it said so);
 *  - 'waiting': the website does not hold them yet (no website link, offline,
 *    a newer block from the other till the link has not brought here, a
 *    menu missing a fee item) — `message` says which;
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
  settingsTie?: number | null;
  /** The till that sent the block the website holds. */
  settingsDeviceId?: string | null;
  /**
   * Why the block the website holds does not fit the menu it holds now (an
   * active area's fee item missing — a till behind on the link published),
   * in the owner's words; null when it fits or there is no block.
   */
  settingsProblem?: string | null;
}

/** A fee item the block's areas need, as the till's menu has it, with the category it sits in (PUT /api/bridge/settings). */
export interface PublishedFeeItem {
  category: Pick<PublishedMenuCategory, 'posCategoryId' | 'name' | 'displayOrder'>;
  item: PublishedMenuItem;
}

/** Body of PUT /api/bridge/settings: the settings block alone, with its areas' fee items (THE BLOCK ALONE). */
export interface PublishSettingsBody {
  settings: PublishedSettings;
  feeItems: PublishedFeeItem[];
}

/**
 * The fee items `block`'s ACTIVE areas name, from `menu` (the till's own),
 * with their categories, in the menu's order: what goes with the block
 * alone (PUT /api/bridge/settings). An area whose item is not in the menu
 * contributes none (settingsBlockProblem says so first).
 */
export function feeItemsForBlock(
  block: Pick<PublishedSettings, 'zones'>,
  menu: Pick<PublishedMenu, 'categories'>,
): PublishedFeeItem[] {
  const wanted = new Set(block.zones.filter((z) => z.active && z.feeCents > 0 && z.feeItemId).map((z) => z.feeItemId!));
  const out: PublishedFeeItem[] = [];
  for (const c of menu.categories) {
    for (const item of c.items) {
      if (!wanted.has(item.posItemId)) continue;
      wanted.delete(item.posItemId);
      out.push({ category: { posCategoryId: c.posCategoryId, name: c.name, displayOrder: c.displayOrder }, item });
    }
  }
  return out;
}

/**
 * Why the website refuses these fee items with this block (THE BLOCK
 * ALONE), or null: each must be named as a delivery charge and be the item
 * an ACTIVE area of the block charges, at its fee — so the block alone can
 * never change food or any other price on the website's menu.
 */
export function feeItemsProblem(block: Pick<PublishedSettings, 'zones'>, feeItems: readonly PublishedFeeItem[]): string | null {
  const charged = new Map<string, number>();
  for (const z of block.zones) if (z.active && z.feeCents > 0 && z.feeItemId) charged.set(z.feeItemId, z.feeCents);
  const seen = new Set<string>();
  for (const { item } of feeItems) {
    if (seen.has(item.posItemId)) return `"${item.name}" is sent twice`;
    seen.add(item.posItemId);
    if (!/^delivery charge/i.test(item.name.trim())) return `"${item.name}" is not a delivery charge item`;
    const fee = charged.get(item.posItemId);
    if (fee === undefined) return `"${item.name}" is not the delivery charge item of any area that is on`;
    if (fee !== item.basePriceCents) return `"${item.name}" does not cost what its areas charge`;
  }
  return null;
}

/** A block's stamp. `settingsTie` is absent only from a record made before it existed (it then decides nothing). */
export interface SettingsStamp {
  settingsRev: number;
  settingsAt: string;
  settingsTie?: number | null;
}

/** What the website holds (GET /api/bridge/status's data.settings; the same fields as PublishMenuResult's). */
export interface WebsiteSettingsHeld {
  settingsRev: number;
  settingsAt: string;
  settingsTie: number | null;
  settingsDeviceId: string | null;
  settingsProblem: string | null;
}

/**
 * Order two blocks' stamps: negative when `a` is older than `b`, 0 when
 * the same, positive when newer. The revision first (the tills settle each
 * key by version first), then the newest time, then the sum of the times.
 * An unreadable time counts as the oldest.
 */
export function compareSettingsStamp(a: SettingsStamp, b: SettingsStamp): number {
  if (a.settingsRev !== b.settingsRev) return a.settingsRev < b.settingsRev ? -1 : 1;
  const ta = Date.parse(a.settingsAt);
  const tb = Date.parse(b.settingsAt);
  const x = Number.isFinite(ta) ? ta : -Infinity;
  const y = Number.isFinite(tb) ? tb : -Infinity;
  if (x !== y) return x < y ? -1 : 1;
  const ia = a.settingsTie;
  const ib = b.settingsTie;
  if (typeof ia !== 'number' || typeof ib !== 'number' || ia === ib) return 0;
  return ia < ib ? -1 : 1;
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
