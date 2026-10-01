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
import type { ShopHours, ShopProfile, ShopWebsite, WebsiteHome } from './website-shop.js';

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
  /**
   * The till never discounts it (Menu → Categories → Discounts; Value Deals
   * by its name). Sent ONLY as `true`, so a menu with nothing marked is
   * byte-for-byte today's. See "NO DISCOUNT ON VALUE DEALS" below.
   */
  noDiscount?: boolean;
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
  /**
   * true when this publish carried something only a website of v0.7.30 on
   * keeps (a "Pick-up only" item, or a website message) and the website did
   * not say it keeps them (PublishMenuResult.websiteMessages): an older
   * website dropped them. Absent otherwise.
   */
  olderWebsite?: boolean;
  /**
   * The home page's featured items the website did not find on the menu it
   * holds now (PublishMenuResult.homeMissing: their cards are hidden), in the
   * lineup's order; [] when all are there. Absent from a website older than
   * the shop block.
   */
  homeMissing?: string[];
  /**
   * Where the shop details stand with the website after this publish (THE
   * SHOP BLOCK): absent while none is saved on either till.
   */
  shopPublish?: SettingsPublishStatus;
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
  /**
   * The shop's details, hours, website words and home lineup (sweep B2 +
   * B4): absent while none of the four keys is saved on either till, from
   * every till up to v0.7.30, and from a Publish the website refused it on
   * (then sent again without it). See THE SHOP BLOCK below.
   *
   * NOTE `store` above is LEGACY and never read by the website: it is this
   * till's per-till receipt branding, unstamped (two tills would swap the
   * website's details on every publish). It stays byte-for-byte as it was
   * (`whatsapp: null`); the website's shop details are THIS block.
   */
  shop?: PublishedShop;
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

// ---------------------------------------------------------------------------
// v0.7.34 — NO DISCOUNT ON VALUE DEALS (owner, 2026-10-02: "Deals never get
// any discount"). The contract between the till and the website.
// ---------------------------------------------------------------------------
//
// THE MARK. The till marks items no discount by their category (Menu →
// Categories → Discounts, owner only; a category named for deals or combos,
// like Value Deals, is marked by its name until the owner sets it). A till of
// v0.7.34 publishes each marked item with `noDiscount: true`
// (PublishedMenuItem); the key is absent on every other item and never sent
// on a delivery-charge item. So a menu with nothing marked, and every
// publish from a till up to v0.7.33, is byte-for-byte today's.
//
// WHAT THE WEBSITE DOES, on the SERVER, from the menu it stores (never from
// the browser):
//   - keeps the key: its item schema accepts `noDiscount: boolean`
//     (optional, no default). Today's strips it, which is why the website
//     deploys first;
//   - works a PICK-UP's % on the lines whose item is not marked: their sum
//     is the base, the discount is rounded once on it and split over them by
//     weight, and a marked line takes no share (it is taxed on its full
//     price). The subtotal is still every line. Nothing marked = today's
//     numbers exactly; marked lines only = no discount;
//   - copies `noDiscount: true` onto each stored order line (items_json,
//     WebOrderItem) whose item is marked, on a pick-up AND a delivery, as the
//     line's LAST key, so an unmarked line's JSON is today's. The
//     delivery-charge line never carries it;
//   - answers `noDiscountItems: true` from both PUT routes
//     (PublishMenuResult), next to `websiteMessages`;
//   - says NOT_ON_VALUE_DEALS where it applies: the /menu pick-up chip while
//     the menu has a mark, the pick-up totals and checkout while the cart has
//     one, the tracker of an order with a flagged line. The tracker's % is
//     webOrderPickupPercent's.
//
// WHAT THE TILL DOES (web-orders-bridge):
//   - reads the % back with webOrderPickupPercent(web), PICKUP_DISCOUNT_PERCENT
//     when null: the discount ÷ the lines it was worked on. Never discount ÷
//     subtotal, which reads Rs 150 off a Rs 1,500 pizza next to a Rs 2,600
//     deal as 4%;
//   - a pick-up with ANY flagged line follows the website: its lines take the
//     website's flags and the web discount is frozen to leave them alone.
//     Otherwise (a delivery, nothing marked, an older website) its lines take
//     the till's own category and the web discount covers every line, as
//     that website priced it. Either way the till takes off exactly what the
//     customer was shown;
//   - a pick-up of marked lines only reads 0%: no discount row;
//   - when its publish carried a mark and the answer lacks `noDiscountItems`,
//     it says the website is older and needs its update.
//
// DEPLOY ORDER. The website first (a push to main deploys it), then the
// tills. Until a till of v0.7.34 publishes marks the website is exactly as
// today. A till rolled back below v0.7.34 reads a flagged pick-up as
// discount ÷ subtotal ('total changed'): Publish on it once, which sends the
// menu with no marks.

// ---------------------------------------------------------------------------
// THE SHOP BLOCK (sweep B2 + B4, after v0.7.30) — the shop's name, numbers,
// address and social links, its opening hours, its website words and the
// home page's lineup, from Settings → Shop & logo → "Website: shop details
// (both tills)". The contract between the till (builder A) and the website
// (builders B and C). Types and pure helpers: website-shop.ts. Bounds:
// shared-schemas web-settings.ts (publishedShopSchema / publishedShopReadSchema).
// ---------------------------------------------------------------------------
//
// WHY ITS OWN BLOCK. B1 put its three messages INSIDE the settings block and
// keeps a field a block lacks (KEPT_MESSAGE_FIELDS in the website's one
// statement) — a per-FIELD rule inside ONE stamp, made only so a v0.7.29
// till's block can't clear them. It is not a per-section rule to reuse. The
// shop details travel as a SEPARATE stamped block instead, because:
//   1. the settings block is refused WHOLE for a fee-item problem
//      (settingsBlockProblem, carriedKeyProblem): hours or a name must never
//      wait on a delivery charge item, nor a fee on a bad social link;
//   2. PUBLISHED_SETTING_KEYS and the settings stamp stay as released: a
//      v0.7.30 till compares exactly as before, and none of the settings
//      block's scenarios move;
//   3. a website that loses the block (a rollback to v0.7.30 rebuilds
//      menu_json from each publish and drops `shop`) answers no held shop
//      stamp once it is back, and the tills send it again BY THEMSELVES — a
//      flat field dropped under an unchanged stamp would wait for a Publish;
//   4. with nothing saved the publish carries no `shop` key at all: the body
//      is byte-for-byte a v0.7.30 till's.
// It REUSES step 3's whole-block rule and arithmetic under shop names
// (settingsStampOf, compareSettingsStamp, websiteNeedsSettings; pos-domain
// shopStampOf / websiteNeedsShop), and B1's line rule (websiteLine,
// WEBSITE_TEXT_FORBIDDEN_RE) and per-section read fallback. B1's field-keep
// idiom is kept for fields added INSIDE `shop` later: v1 always sends all
// four sections, every field, at their defaults too.
//
// WHAT. PublishedMenu.shop = PublishedShop:
//   { v: 1, shopRev, shopAt, shopTie, deviceId,
//     profile: ShopProfile without v,   hours: ShopHours without v,
//     website: ShopWebsite without v,   home: WebsiteHome without v }
// from the four keys SHOP_PUBLISHED_KEYS ('shop.profile', 'shop.hours',
// 'shop.website', 'website.home'). No money travels in it: the home lineup
// NAMES items (posItemId + name); prices, deal worth and tax come from the
// menu. Every DEFAULT_* (website-shop.ts) is today's website byte for byte:
// the website with no block stored uses them.
//
// THE STAMP. Exactly THE STAMP of the settings block, over SHOP_PUBLISHED_KEYS:
// shopRev = the sum of their row versions, shopAt = the newest updated_at,
// shopTie = the sum of their updated_at in ms (pos-domain shopStampOf).
// Compare with compareShopStamp (= compareSettingsStamp). deviceId = the
// sending till. The website's keep-or-take rule is shopBlockTakes.
//
// WHEN THE TILL SENDS IT. Only once one of the four keys is saved on either
// till (shopRev >= 1): until then NO `shop` key is ever sent. From then on:
//   - EVERY menu publish (the owner's Publish, a menu file import, "Publish
//     the menu by itself") carries it, next to `settings`;
//   - ANY till with the website link sends it ALONE (PUT /api/bridge/shop)
//     when the website needs it (pos-domain websiteNeedsShop: no block held,
//     an older one, or this till's own older one after a restore) — after a
//     Save here, one synced from the other till, or at start-up. A Save
//     NEVER sends the menu or the settings block.
//   - a till holding one of the four keys saved by a NEWER version of the
//     app (or one it can't read) sends NO shop block: it would send its
//     defaults in that key's place (the updated till sends it).
//
// THE WEBSITE'S STORE RULE for `shop` — in the SAME single statement that
// stores the menu and decides the settings block (PUT /api/bridge/menu), and
// independent of the settings block's outcome:
//   - no `shop` in the publish (every till up to v0.7.30, or a Publish sent
//     again without it) → KEEP the stored one → answer shop 'kept' ('none'
//     when nothing is stored either);
//   - `shop` whose stamp is OLDER than the stored one (compareShopStamp < 0)
//     → keep the stored one → 'ignored_older' — UNLESS the stored one came
//     from the same deviceId and the incoming shopAt is later (a till may
//     always replace its own block with a later Save): shopBlockTakes;
//   - otherwise (newer or EQUAL, or nothing stored) → store it whole →
//     'stored'.
// The menu (and the settings block, by its own rule) is stored either way.
// Refused, with NOTHING stored (not the menu either):
//   - `shop` that fails publishedShopSchema, or whose shopAt is more than
//     SETTINGS_MAX_CLOCK_AHEAD_MS ahead of the website's clock →
//     400 { ok:false, error:'shop_invalid', message }. NEVER 'validation'
//     for the shop block (MenuSchema takes `shop` as unknown and checks it
//     apart), so the till can tell it apart and send the menu again without
//     it. Keep that body shape exactly.
//   The settings block's refusals ('validation', 'settings_invalid') are
//   unchanged. A publish may be refused for one, then the other: the till
//   drops whichever was refused and sends again (at most three sends).
//
// THE BLOCK ALONE: PUT /api/bridge/shop, body PublishShopBody { shop }.
//   - no menu stored yet → 409 { ok:false, error:'menu_not_published' }
//     (the till says "press Publish");
//   - shop_invalid as above → 400, nothing stored;
//   - the store rule above on the stored row's `shop` ONLY — one guarded
//     UPDATE (jsonb_set of '{shop}' WHERE the stamp rule holds against the
//     row as it is): the menu, the settings block and everything else of
//     the row stay exactly as stored; an older block writes nothing
//     ('ignored_older');
//   - 200 { ok:true, data: PublishShopResult }.
//   A website older than this route answers 404: the till says the website
//   needs its update and sends that stamp no more by itself.
//   revalidatePath('/', 'layout') after 'stored' (every page shows the
//   details: add the route to isr-routes.test).
//
// THE ANSWERS (from a website with the shop block on, ALWAYS — with or
// without a `shop` sent):
//   PUT /api/bridge/menu 200 data (PublishMenuResult) gains
//     shop: PublishSettingsOutcome, and the block held NOW: shopRev, shopAt,
//     shopTie, shopDeviceId (all null when none), and homeMissing.
//   PUT /api/bridge/shop 200 data (PublishShopResult): the same fields.
//   GET /api/bridge/status data gains shop: WebsiteShopHeld | null (null =
//     no block held) and homeMissing: string[].
//   An ABSENT `shop` key = a website older than the block (it stripped a
//   `shop` sent to it): the till says the website needs its update.
//   homeMissing: the itemRef.name of each featured entry of the lineup in
//   force — the stored block's `home`, or DEFAULT_WEBSITE_HOME when none —
//   the website can't find on the menu it holds now (website-shop.ts
//   homeMissing: the pizzas, then the burger, then the deals; [] = all found).
//
// PUBLIC. GET /api/menu, the /menu props and every page NEVER carry the
// block's stamps or deviceId: publicMenu strips `shop` entirely, and pages
// read ShopFacts (the four sections, merged over the defaults) instead.
//
// WHAT THE PAGES DO WITH IT (the defaults print today's pages exactly):
//   profile — name: titles, JSON-LD name, OG, manifest, footer, WhatsApp
//     texts (the page-specific messages keep their words; only the name
//     comes from here); name-pun slogans take their `otherwise` words once
//     the name is not the default. tagline, phone (telUrl + JSON-LD
//     telephone), whatsappLines (the first = the order link; waUrl),
//     address (street / areaLine / postalCode; the city, region, country,
//     pin, Maps link and listing id stay in code), socialLinks (footer row
//     AND JSON-LD sameAs, both only when there is one; socialLabel names
//     them), priceRange (JSON-LD).
//   hours — DISPLAY ONLY (ordering follows the shift): hoursLine,
//     hoursRange, timeWords, everyDay, closesAfterMidnight (the late-night
//     page's premise; its slug is never removed), opensBy, schemaOrgDays.
//   website — whatsappGreeting (encoded once: waLinkWith),
//     doorPayments / pickupPayments (cashOnly, paymentsWords,
//     paymentAccepted: ['cash'] → "Cash on Delivery" exactly; titles saying
//     "Cash on Delivery" stay — cash is always taken), allergyNotice.
//   home — the lineup (homeLineup): a missing item hides its card, slide or
//     deal; `headline`/`text` absent = today's curated words for today's
//     items, else the item's description; drink brands never shown.
//
// WHAT THE TILL DOES WITH THE ANSWERS (web-orders-bridge):
//   - 200 with data.shop: records what the website holds (stamp, device,
//     homeMissing) and sends again only when websiteNeedsShop says;
//   - 200 WITHOUT data.shop while it sent a block, or 404 from the block
//     alone: an older website — "the website needs its update"; nothing more
//     by itself for that stamp (the owner's Publish or a Save after the
//     website's update sends it; a start-up status read that finds the
//     updated website clears the note);
//   - 400 shop_invalid: a Publish sends the same menu again WITHOUT `shop`
//     (the settings block still goes); the block alone stops there. The
//     message is shown to the owner either way.
//
// DEPLOY ORDER. The website first (a push to main deploys it), the tills the
// same day. A website older than the block strips `shop` (its MenuSchema is
// z.object) and has no /api/bridge/shop: the tills say it needs its update.
// A website ROLLED BACK to v0.7.30 drops the stored `shop` on the next
// publish (its statement rebuilds menu_json): the pages show the defaults
// (today's) and, once the website is back, the tills see no held block and
// send it again by themselves.

/** The four keys the shop block carries (their row versions and times make its stamp). */
export const SHOP_PUBLISHED_KEYS = ['shop.profile', 'shop.hours', 'shop.website', 'website.home'] as const;

/** The shop block's sections: each key's value without its format `v`. */
export type PublishedShopProfile = Omit<ShopProfile, 'v'>;
export type PublishedShopHours = Omit<ShopHours, 'v'>;
export type PublishedShopWebsite = Omit<ShopWebsite, 'v'>;
export type PublishedWebsiteHome = Omit<WebsiteHome, 'v'>;

/** The shop block (PublishedMenu.shop, PUT /api/bridge/shop): THE SHOP BLOCK. */
export interface PublishedShop {
  /** The block's format: 1. */
  v: number;
  /** Sum of the four keys' row versions on the till (0 = none saved: never sent). */
  shopRev: number;
  /** Newest updated_at of the four keys (ISO 8601 UTC). */
  shopAt: string;
  /** Sum of their updated_at in ms since 1970: the stamp's third number. */
  shopTie: number;
  /** The till that sent it: a till may replace its own block with a later Save. */
  deviceId: string;
  profile: PublishedShopProfile;
  hours: PublishedShopHours;
  website: PublishedShopWebsite;
  home: PublishedWebsiteHome;
}

/** The shop block's stamp. `shopTie` null only on a record made without it (it then decides nothing). */
export interface ShopStamp {
  shopRev: number;
  shopAt: string;
  shopTie?: number | null;
}

/** Order two shop stamps exactly as compareSettingsStamp orders settings stamps (revision, newest time, sum of times). */
export function compareShopStamp(a: ShopStamp, b: ShopStamp): number {
  return compareSettingsStamp(
    { settingsRev: a.shopRev, settingsAt: a.shopAt, settingsTie: a.shopTie ?? null },
    { settingsRev: b.shopRev, settingsAt: b.shopAt, settingsTie: b.shopTie ?? null },
  );
}

/**
 * THE WEBSITE'S STORE RULE for the shop block (the SQL implements exactly
 * this): does `incoming` replace `held` (null = none stored)? Newer or
 * equal, or the same till's later Save.
 */
export function shopBlockTakes(
  incoming: ShopStamp & { deviceId: string },
  held: (ShopStamp & { deviceId?: string | null }) | null,
): boolean {
  if (!held) return true;
  if (compareShopStamp(incoming, held) >= 0) return true;
  return held.deviceId === incoming.deviceId && Date.parse(incoming.shopAt) > Date.parse(held.shopAt);
}

/** What the website holds of the shop block (GET /api/bridge/status data.shop; null = none). */
export interface WebsiteShopHeld {
  shopRev: number;
  shopAt: string;
  shopTie: number | null;
  shopDeviceId: string | null;
}

/** The shop fields of an answer (PUT /api/bridge/menu, PUT /api/bridge/shop): absent = a website older than the block. */
export interface WebsiteShopAnswer {
  /** What the website did with the shop block of this publish (none sent: 'kept' / 'none'). */
  shop?: PublishSettingsOutcome;
  /** The block the website holds now (after this publish); null = none. */
  shopRev?: number | null;
  shopAt?: string | null;
  shopTie?: number | null;
  shopDeviceId?: string | null;
  /** The featured home items not on the menu the website holds now (their cards are hidden); [] = all found. */
  homeMissing?: string[];
}

/** Body of PUT /api/bridge/shop: the shop block alone (THE BLOCK ALONE of THE SHOP BLOCK). */
export interface PublishShopBody {
  shop: PublishedShop;
}

/** data of a 200 from PUT /api/bridge/shop. */
export interface PublishShopResult extends WebsiteShopAnswer {
  shop: PublishSettingsOutcome;
  shopRev: number | null;
  shopAt: string | null;
  shopTie: number | null;
  shopDeviceId: string | null;
  homeMissing: string[];
}

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

/**
 * data of a 200 from PUT /api/bridge/menu. `settings` is absent from a
 * website older than the settings block, `shop` (WebsiteShopAnswer) from one
 * older than the shop block.
 */
export interface PublishMenuResult extends WebsiteShopAnswer {
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
  /**
   * true from a website of v0.7.30 on (both PUT routes): it keeps the
   * block's website messages (closedNotice, announcement,
   * minDeliveryOrderCents) and each item's `pickupOnly`. Absent = an older
   * website, which drops them silently while still answering 'stored' (the
   * website's deploy failed or was rolled back, the tills updated): when
   * this till sent any of them, it says the website needs its update
   * (web-orders-bridge OLDER_WEBSITE_DROPS) — a Publish once the website is
   * updated sends them again.
   */
  websiteMessages?: boolean;
  /**
   * true from a website of v0.7.34 on (both PUT routes): it keeps each
   * item's `noDiscount` and prices pick-ups without those items (NO DISCOUNT
   * ON VALUE DEALS). Absent = an older website, which strips the key while
   * still answering 'stored'.
   */
  noDiscountItems?: boolean;
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
  /**
   * Set by the website SERVER from the stored menu item on every order, never
   * from the browser; sent only as `true`. On a pick-up, the website gave this
   * line no share of the pick-up %. See "NO DISCOUNT ON VALUE DEALS".
   */
  noDiscount?: boolean;
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
 * The words for the items no discount comes off (owner, 2026-10-02: "Yes,
 * say 'not on value deals'"). The website, the till, the bill and the
 * printed coupon all say this one phrase, never one built from category
 * names. See "NO DISCOUNT ON VALUE DEALS".
 */
export const NOT_ON_VALUE_DEALS = 'not on value deals';

/**
 * The pick-up percent the customer was shown, read back from the order the
 * site sent: the discount ÷ the lines it was worked on (the subtotal less
 * the lines marked `noDiscount`, NO DISCOUNT ON VALUE DEALS). 0 for a
 * delivery, and for a pick-up of marked lines only. null when the order
 * carries no discount (a site that predates the field) or no subtotal: the
 * caller applies PICKUP_DISCOUNT_PERCENT, as before. Kept to 0–50%. With no
 * marked line this is exactly the till's v0.7.33 pickupPercentOf (discount ÷
 * subtotal), so every order from an older site reads as it did.
 */
export function webOrderPickupPercent(o: {
  fulfilment?: string;
  discountCents?: number;
  subtotalCents: number;
  items?: ReadonlyArray<{ unitPriceCents: number; quantity: number; noDiscount?: boolean }>;
}): number | null {
  if (o.fulfilment !== 'pickup') return 0;
  if (typeof o.discountCents !== 'number' || !(o.subtotalCents > 0)) return null;
  let leftOut = 0;
  for (const line of o.items ?? []) if (line.noDiscount === true) leftOut += line.unitPriceCents * line.quantity;
  const base = o.subtotalCents - leftOut;
  if (!(base > 0)) return 0;
  const pct = Math.round((o.discountCents * 100) / base);
  // 50 = WEBSITE_PICKUP_MAX_PERCENT, written out because shop-settings.ts
  // imports this file (importing it back would be a cycle at load time);
  // apps/web pickup-percent.test.ts keeps the two equal.
  return Math.max(0, Math.min(50, pct));
}

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

/**
 * The pause as the PIN screen and the shift controls see it (inside
 * alerts:getWatch): two yes/no answers and a time, nothing about customers,
 * orders, money or the connection.
 */
export interface WebOrdersPauseView {
  /** The owner's "Accept online orders" switch is on AND this till paused website orders because no shift is open. */
  paused: boolean;
  /** When the pause began (ISO 8601 UTC); only while paused. */
  since?: string;
  /** The website address and connection password are set (and readable) on this till. */
  websiteLinkSet: boolean;
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
