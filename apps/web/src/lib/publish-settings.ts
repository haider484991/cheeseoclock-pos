import {
  DEFAULT_WEBSITE_HOME,
  DELIVERY_ZONES,
  SETTINGS_MAX_CLOCK_AHEAD_MS,
  compareSettingsStamp,
  compareShopStamp,
  deliveryZoneFeeItemIds,
  homeMissing,
  settingsBlockProblem,
  type PublishSettingsOutcome,
  type PublishedFeeItem,
  type PublishedMenu,
  type PublishedMenuCategory,
  type PublishedSettings,
  type PublishedShop,
  type WebsiteSettingsHeld,
  type WebsiteShopHeld,
} from '@cheeseoclock/shared-types';
import { publishedShopSchema } from '@cheeseoclock/shared-schemas/web-settings';
import { sql } from './db';
import { parseStoredSettings, parseStoredShop } from './site-facts';

/**
 * Storing a menu publish, its settings block and its shop block (PUT
 * /api/bridge/menu), and either block alone (PUT /api/bridge/settings, PUT
 * /api/bridge/shop), per the contract in shared-types web-bridge.ts ("THE
 * SETTINGS BLOCK", "THE SHOP BLOCK").
 */

/**
 * Why the website refuses this block with this menu, in the owner's words
 * (the till shows "Website not updated: …"), or null:
 *  - the shared check against the SAME menu (settingsBlockProblem): every
 *    active area with a fee names an item of this menu at exactly its fee;
 *  - a stamp far ahead of this clock: one till with a wrong clock must not
 *    lock every later block out (a newer stamp always wins);
 *  - a compiled area missing: every area keeps its page and slug for good, so
 *    the till sends each one, switched off or not.
 */
export function websiteBlockProblem(
  block: PublishedSettings,
  menu: Pick<PublishedMenu, 'categories'>,
  now: number = Date.now(),
): string | null {
  const shared = settingsBlockProblem(block, menu);
  if (shared) return shared;
  if (Date.parse(block.settingsAt) - now > SETTINGS_MAX_CLOCK_AHEAD_MS) {
    return 'The till’s clock is ahead of the website’s — set the till’s date and time, then save the settings again.';
  }
  const ids = new Set(block.zones.map((z) => z.id));
  const missing = DELIVERY_ZONES.find((z) => !ids.has(z.id));
  if (missing) {
    return `${missing.name} is missing from the delivery areas — an area is switched off, never removed (its page stays on the website).`;
  }
  return null;
}

/**
 * The block's website messages (v0.7.30, shared-types web-bridge.ts: WEBSITE
 * MESSAGES): a block WITHOUT one of them (a v0.7.29 till's) says nothing
 * about it, so the website keeps the one it stored — field by field, as it
 * keeps the whole stored block when a publish carries none. A block WITH one
 * (a till of v0.7.30 on sends all three, at their defaults too) replaces it.
 * The Buy 1 Get 1 deals' rules the same way since v0.7.39 (`buy1Get1`: an
 * older till's block has none). The same names are written into
 * storePublishedMenu's statement.
 */
export const KEPT_MESSAGE_FIELDS = ['closedNotice', 'announcement', 'minDeliveryOrderCents', 'buy1Get1'] as const;

/**
 * `incoming` with each message field it lacks taken from `stored`: the block
 * the row holds, AS STORED (null = none) — read or not, as the publish's
 * statement keeps them straight from the row (jsonb). So a Save and a
 * publish keep the same fields even when the stored block does not read (a
 * hand-edited row) or one of its messages does not (it reads as absent
 * either way: parseStoredSettings). Only a JSON object holds fields.
 */
export function withKeptMessages(incoming: PublishedSettings, stored: unknown): PublishedSettings {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return incoming;
  const held = stored as Record<string, unknown>;
  const out: Record<string, unknown> = { ...incoming };
  for (const key of KEPT_MESSAGE_FIELDS) {
    if (out[key] === undefined && held[key] !== undefined) out[key] = held[key];
  }
  return out as unknown as PublishedSettings;
}

/** What the website holds, from the stored block and the menu stored with it (null = no block). */
export function heldSettingsOf(
  block: PublishedSettings | null,
  menu: Pick<PublishedMenu, 'categories'> | null,
): WebsiteSettingsHeld | null {
  if (!block) return null;
  return {
    settingsRev: block.settingsRev,
    settingsAt: block.settingsAt,
    settingsTie: typeof block.settingsTie === 'number' ? block.settingsTie : null,
    settingsDeviceId: typeof block.deviceId === 'string' ? block.deviceId : null,
    // A kept block may meet a menu from a till the link has not caught up yet: say so, and the
    // till that holds the block's fee items sends its menu again (pos-domain websiteNeedsSettings).
    settingsProblem: menu ? settingsBlockProblem(block, menu) : null,
  };
}

// ---------------------------------------------------------------------------
// THE SHOP BLOCK (sweep B2 + B4)
// ---------------------------------------------------------------------------

/** A shop block the website refuses (400 shop_invalid): the owner's words, shown on the till. */
export type ShopBlockCheck = { ok: true; shop: PublishedShop } | { ok: false; problem: string };

/**
 * Check a shop block a till sent (PUT /api/bridge/menu's `shop`, PUT
 * /api/bridge/shop): its sections within their bounds (shared-schemas
 * publishedShopSchema — the till's own Save rules), and its stamp not far
 * ahead of this clock (one till with a wrong clock must not lock every later
 * block out). The block as checked: a newer till's extra fields dropped.
 */
export function checkShopBlock(raw: unknown, now: number = Date.now()): ShopBlockCheck {
  const parsed = publishedShopSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` (${issue.path.join('.')})` : '';
    return { ok: false, problem: issue ? `${issue.message}${where}` : 'The shop details are not in a form the website reads.' };
  }
  if (Date.parse(parsed.data.shopAt) - now > SETTINGS_MAX_CLOCK_AHEAD_MS) {
    return {
      ok: false,
      problem: 'The till’s clock is ahead of the website’s — set the till’s date and time, then save the shop details again.',
    };
  }
  return { ok: true, shop: parsed.data };
}

/** What the website holds of the shop block (null = none), from the stored block. */
export function heldShopOf(block: PublishedShop | null): WebsiteShopHeld | null {
  if (!block) return null;
  return {
    shopRev: block.shopRev,
    shopAt: block.shopAt,
    shopTie: typeof block.shopTie === 'number' ? block.shopTie : null,
    shopDeviceId: typeof block.deviceId === 'string' ? block.deviceId : null,
  };
}

/**
 * The home page's featured items this menu lacks (their cards are hidden):
 * the stored block's lineup, or today's with none (DEFAULT_WEBSITE_HOME) —
 * shared-types homeMissing, the matcher the till's Home page card uses too.
 * The settings block's delivery charge items are never a featured item. No
 * menu = nothing hidden (the pages show the lineup without prices).
 */
export function homeMissingOn(
  menu: Pick<PublishedMenu, 'categories'> | null,
  settings: PublishedSettings | null,
  shop: PublishedShop | null,
): string[] {
  if (!menu) return [];
  return homeMissing(shop?.home ?? DEFAULT_WEBSITE_HOME, menu, deliveryZoneFeeItemIds(settings?.zones ?? []));
}

/** What the website did with a publish's shop block: `sent` = the block of this publish (undefined = none). */
function shopOutcomeOf(sent: PublishedShop | undefined, held: WebsiteShopHeld | null): PublishSettingsOutcome {
  if (!sent) return held ? 'kept' : 'none';
  return held && held.shopDeviceId === sent.deviceId && compareShopStamp(held, sent) === 0 && held.shopTie === sent.shopTie
    ? 'stored'
    : 'ignored_older';
}

/** A publish's answer about the shop block (PublishMenuResult / PublishShopResult: WebsiteShopAnswer). */
export interface ShopAnswer {
  shop: PublishSettingsOutcome;
  shopRev: number | null;
  shopAt: string | null;
  shopTie: number | null;
  shopDeviceId: string | null;
  homeMissing: string[];
}

function shopAnswerOf(outcome: PublishSettingsOutcome, held: WebsiteShopHeld | null, missing: string[]): ShopAnswer {
  return {
    shop: outcome,
    shopRev: held?.shopRev ?? null,
    shopAt: held?.shopAt ?? null,
    shopTie: held?.shopTie ?? null,
    shopDeviceId: held?.shopDeviceId ?? null,
    homeMissing: missing,
  };
}

// ---------------------------------------------------------------------------

/**
 * Store the menu, and decide its two blocks, in ONE statement on the
 * site_menu row (a read-then-write would let an older till publishing at the
 * same moment wipe a newer block). The settings block:
 *  - no block (an older till): the stored block stays, with the new menu;
 *  - a block older than the stored one: dropped, the stored block stays, the
 *    menu is stored — unless the stored block came from the same till and
 *    this one's time is later (a till restored from an older backup that
 *    has saved since: a till may always replace its own block);
 *  - otherwise (newer or EQUAL, or nothing stored): stored with the menu —
 *    with the stored block's website messages it lacks kept (a v0.7.29
 *    till's block has none: KEPT_MESSAGE_FIELDS, withKeptMessages).
 * The row comparison (rev, at, tie) >= (rev, at, tie) is compareSettingsStamp:
 * revision first, then the newest time, then the sum of the times.
 *
 * The shop block (THE SHOP BLOCK), decided the same way on its own stamp and
 * independently of the settings block — over the settings step's result:
 *  - no shop block (every till up to v0.7.30): the stored one stays;
 *  - an older one: dropped (the stored one stays), unless the same till with
 *    a later time (shopBlockTakes);
 *  - otherwise: stored whole.
 * The caller checked the shop block (checkShopBlock).
 *
 * @returns what the website holds now of each block (null = none), what
 *   happened to the ones sent, and the featured home items the menu lacks.
 */
export async function storePublishedMenu(
  menu: Omit<PublishedMenu, 'settings' | 'shop'>,
  settings: PublishedSettings | undefined,
  shop?: PublishedShop,
): Promise<{ held: WebsiteSettingsHeld | null; outcome: PublishSettingsOutcome; shopAnswer: ShopAnswer }> {
  const doc: PublishedMenu = { ...menu, ...(settings ? { settings } : {}), ...(shop ? { shop } : {}) };
  const hasBlock = settings !== undefined;
  const hasShop = shop !== undefined;
  const rows = (await sql()`
    INSERT INTO site_menu (id, menu_json, published_at)
    VALUES (1, ${JSON.stringify(doc)}, now())
    ON CONFLICT (id) DO UPDATE SET
      menu_json = (
        SELECT CASE
          -- The shop block (THE SHOP BLOCK): sent and newer (or equal, or the same till's later
          -- Save, or none stored) → the one sent, as the settings step left it in; else the stored
          -- one; else none.
          WHEN ${hasShop}::boolean AND (
                 site_menu.menu_json -> 'shop' IS NULL
              OR (${shop?.shopRev ?? 0}::integer,
                  ${shop?.shopAt ?? null}::timestamptz,
                  ${shop?.shopTie ?? 0}::bigint)
                 >= ((site_menu.menu_json #>> '{shop,shopRev}')::integer,
                     (site_menu.menu_json #>> '{shop,shopAt}')::timestamptz,
                     COALESCE((site_menu.menu_json #>> '{shop,shopTie}')::bigint, 0))
              OR (site_menu.menu_json #>> '{shop,deviceId}' = ${shop?.deviceId ?? null}::text
                  AND ${shop?.shopAt ?? null}::timestamptz
                      > (site_menu.menu_json #>> '{shop,shopAt}')::timestamptz))
            THEN step.doc
          WHEN site_menu.menu_json -> 'shop' IS NOT NULL
            THEN jsonb_set(step.doc - 'shop', '{shop}', site_menu.menu_json -> 'shop')
          ELSE step.doc - 'shop'
        END
        FROM (SELECT CASE
          WHEN ${hasBlock}::boolean AND (
                 site_menu.menu_json -> 'settings' IS NULL
              OR (${settings?.settingsRev ?? 0}::integer,
                  ${settings?.settingsAt ?? null}::timestamptz,
                  ${settings?.settingsTie ?? 0}::bigint)
                 >= ((site_menu.menu_json #>> '{settings,settingsRev}')::integer,
                     (site_menu.menu_json #>> '{settings,settingsAt}')::timestamptz,
                     COALESCE((site_menu.menu_json #>> '{settings,settingsTie}')::bigint, 0))
              OR (site_menu.menu_json #>> '{settings,deviceId}' = ${settings?.deviceId ?? null}::text
                  AND ${settings?.settingsAt ?? null}::timestamptz
                      > (site_menu.menu_json #>> '{settings,settingsAt}')::timestamptz))
            -- The new block over the website messages of the stored one (KEPT_MESSAGE_FIELDS): a message
            -- the new block carries wins, one it lacks (a v0.7.29 till) is kept. Nothing else is kept.
            THEN jsonb_set(
              EXCLUDED.menu_json,
              '{settings}',
              COALESCE(
                (SELECT jsonb_object_agg(kept.key, kept.value)
                   FROM jsonb_each(
                          CASE WHEN jsonb_typeof(site_menu.menu_json -> 'settings') = 'object'
                               THEN site_menu.menu_json -> 'settings' ELSE '{}'::jsonb END) AS kept
                  WHERE kept.key IN ('closedNotice', 'announcement', 'minDeliveryOrderCents', 'buy1Get1')),
                '{}'::jsonb)
              || (EXCLUDED.menu_json -> 'settings'))
          WHEN site_menu.menu_json -> 'settings' IS NOT NULL
            THEN jsonb_set(EXCLUDED.menu_json - 'settings', '{settings}', site_menu.menu_json -> 'settings')
          ELSE EXCLUDED.menu_json - 'settings'
        END AS doc) AS step),
      published_at = now()
    RETURNING menu_json -> 'settings' AS settings, menu_json -> 'shop' AS shop
  `) as Array<{ settings: unknown; shop: unknown }>;
  const block = parseStoredSettings(rows[0]?.settings ?? null);
  const held = heldSettingsOf(block, menu);
  let outcome: PublishSettingsOutcome;
  if (settings) {
    outcome =
      held &&
      held.settingsDeviceId === settings.deviceId &&
      compareSettingsStamp(held, settings) === 0 &&
      held.settingsTie === settings.settingsTie
        ? 'stored'
        : 'ignored_older';
  } else outcome = held ? 'kept' : 'none';
  const shopBlock = parseStoredShop(rows[0]?.shop ?? null);
  const shopHeld = heldShopOf(shopBlock);
  const shopAnswer = shopAnswerOf(shopOutcomeOf(shop, shopHeld), shopHeld, homeMissingOn(menu, block, shopBlock));
  return { held, outcome, shopAnswer };
}

/** What the website holds, for the bridge's status read: each block (null = none) and the featured items the menu lacks. */
export interface StoredHeld {
  settings: WebsiteSettingsHeld | null;
  shop: WebsiteShopHeld | null;
  homeMissing: string[];
}

/** Both blocks the website holds (null = none) and whether the settings block fits the menu stored with it: ONE read. */
export async function storedHeld(): Promise<StoredHeld> {
  const rows = (await sql()`
    SELECT menu_json FROM site_menu WHERE id = 1
  `) as Array<{ menu_json: PublishedMenu | string | null }>;
  const raw = rows[0]?.menu_json ?? null;
  const menu = typeof raw === 'string' ? (JSON.parse(raw) as PublishedMenu) : raw;
  if (!menu) return { settings: null, shop: null, homeMissing: [] };
  const block = parseStoredSettings(menu.settings ?? null);
  const shop = parseStoredShop(menu.shop ?? null);
  return { settings: heldSettingsOf(block, menu), shop: heldShopOf(shop), homeMissing: homeMissingOn(menu, block, shop) };
}

/** The settings block the website holds (null = none) and whether it fits the menu stored with it. */
export async function storedSettingsHeld(): Promise<WebsiteSettingsHeld | null> {
  return (await storedHeld()).settings;
}

export type StoreShopAloneResult = { kind: 'no_menu' } | ({ kind: 'done' } & ShopAnswer);

/**
 * PUT /api/bridge/shop (THE BLOCK ALONE of THE SHOP BLOCK): the block on the
 * stored row, and NOTHING else of it — one guarded UPDATE, jsonb_set of
 * '{shop}' only where the stamp rule holds against the row as it is (so a
 * publish landing at the same moment is never overwritten, and an older
 * block writes nothing: 'ignored_older'). The menu, the settings block and
 * everything else stay exactly as stored. No row yet: 'no_menu' (the till
 * says "press Publish"). The caller checked the block (checkShopBlock).
 */
export async function storeShopAlone(shop: PublishedShop): Promise<StoreShopAloneResult> {
  const written = (await sql()`
    UPDATE site_menu SET menu_json = jsonb_set(menu_json, '{shop}', ${JSON.stringify(shop)}::jsonb)
     WHERE id = 1 AND (
             menu_json -> 'shop' IS NULL
          OR (${shop.shopRev}::integer, ${shop.shopAt}::timestamptz, ${shop.shopTie}::bigint)
             >= ((menu_json #>> '{shop,shopRev}')::integer,
                 (menu_json #>> '{shop,shopAt}')::timestamptz,
                 COALESCE((menu_json #>> '{shop,shopTie}')::bigint, 0))
          OR (menu_json #>> '{shop,deviceId}' = ${shop.deviceId}::text
              AND ${shop.shopAt}::timestamptz > (menu_json #>> '{shop,shopAt}')::timestamptz))
    RETURNING menu_json
  `) as Array<{ menu_json: PublishedMenu | string }>;
  const stored = written[0];
  if (stored) {
    const menu = typeof stored.menu_json === 'string' ? (JSON.parse(stored.menu_json) as PublishedMenu) : stored.menu_json;
    const block = parseStoredShop(menu.shop ?? null);
    const held = heldShopOf(block);
    return { kind: 'done', ...shopAnswerOf(shopOutcomeOf(shop, held), held, homeMissingOn(menu, parseStoredSettings(menu.settings ?? null), block)) };
  }
  // Nothing written: no menu yet, or a newer block held (the row as it is now).
  const rows = (await sql()`
    SELECT menu_json FROM site_menu WHERE id = 1
  `) as Array<{ menu_json: PublishedMenu | string | null }>;
  const raw = rows[0]?.menu_json ?? null;
  const menu = typeof raw === 'string' ? (JSON.parse(raw) as PublishedMenu) : raw;
  if (!menu) return { kind: 'no_menu' };
  const block = parseStoredShop(menu.shop ?? null);
  const held = heldShopOf(block);
  return { kind: 'done', ...shopAnswerOf('ignored_older', held, homeMissingOn(menu, parseStoredSettings(menu.settings ?? null), block)) };
}

/**
 * `menu` with the block's fee items put in (THE BLOCK ALONE, shared-types
 * web-bridge.ts): an item already there is replaced in place (never twice —
 * taken out of any other category), one that is not is added at the end of
 * its category, and a category the menu lacks is made. Nothing else moves.
 */
export function withFeeItems<M extends Pick<PublishedMenu, 'categories'>>(menu: M, feeItems: readonly PublishedFeeItem[]): M {
  const categories: PublishedMenuCategory[] = menu.categories.map((c) => ({ ...c, items: [...c.items] }));
  for (const { category, item } of feeItems) {
    let placed = false;
    for (const c of categories) {
      for (let i = c.items.length - 1; i >= 0; i -= 1) {
        if (c.items[i]!.posItemId !== item.posItemId) continue;
        if (!placed && c.posCategoryId === category.posCategoryId) {
          c.items[i] = item;
          placed = true;
        } else c.items.splice(i, 1);
      }
    }
    if (placed) continue;
    let home = categories.find((c) => c.posCategoryId === category.posCategoryId);
    if (!home) {
      home = { posCategoryId: category.posCategoryId, name: category.name, displayOrder: category.displayOrder, items: [] };
      categories.push(home);
    }
    home.items.push(item);
  }
  return { ...menu, categories };
}

/** Is `block` to replace `held` (the stamp rule of a menu publish, step 3 of THE SETTINGS BLOCK)? */
function blockReplaces(block: PublishedSettings, held: PublishedSettings | null): boolean {
  if (!held) return true;
  if (compareSettingsStamp(block, held) >= 0) return true;
  return held.deviceId === block.deviceId && Date.parse(block.settingsAt) > Date.parse(held.settingsAt);
}

export type StoreSettingsAloneResult =
  | { kind: 'no_menu' }
  | { kind: 'invalid'; problem: string }
  | { kind: 'done'; held: WebsiteSettingsHeld | null; outcome: PublishSettingsOutcome; categories: number; items: number };

/**
 * PUT /api/bridge/settings: store the block with the menu the website
 * ALREADY holds (the last one published) and only the block's fee items put
 * in (withFeeItems) — never the till's current menu. Read, then ONE guarded
 * UPDATE: only if the stored menu is still the one read (its md5) and the
 * stamp rule still holds, so a menu publish landing in between is never
 * overwritten with the older menu (read again, up to a few times). An older
 * block writes nothing. The caller checked the fee items (feeItemsProblem).
 */
export async function storeSettingsAlone(
  settings: PublishedSettings,
  feeItems: readonly PublishedFeeItem[],
): Promise<StoreSettingsAloneResult> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const rows = (await sql()`
      SELECT menu_json, md5(menu_json::text) AS h FROM site_menu WHERE id = 1
    `) as Array<{ menu_json: PublishedMenu | string | null; h: string }>;
    const row = rows[0];
    const raw = row?.menu_json ?? null;
    const stored = typeof raw === 'string' ? (JSON.parse(raw) as PublishedMenu) : raw;
    if (!row || !stored) return { kind: 'no_menu' };
    const { settings: storedRaw, ...menu } = stored;
    const heldBlock = parseStoredSettings(storedRaw ?? null);
    const count = (m: Pick<PublishedMenu, 'categories'>) => ({
      categories: m.categories.length,
      items: m.categories.reduce((n, c) => n + c.items.length, 0),
    });
    if (!blockReplaces(settings, heldBlock)) {
      return { kind: 'done', held: heldSettingsOf(heldBlock, menu), outcome: 'ignored_older', ...count(menu) };
    }
    const patched = withFeeItems(menu, feeItems);
    const problem = websiteBlockProblem(settings, patched);
    if (problem) return { kind: 'invalid', problem };
    // A message the block lacks (a v0.7.29 till's block) keeps the one stored, as the row holds it
    // (withKeptMessages: the publish's statement's rule, the stored block read or not).
    const kept = withKeptMessages(settings, storedRaw ?? null);
    const doc: PublishedMenu = { ...patched, settings: kept };
    const written = (await sql()`
      UPDATE site_menu SET menu_json = ${JSON.stringify(doc)}
      WHERE id = 1 AND md5(menu_json::text) = ${row.h}
      RETURNING id
    `) as Array<{ id: number }>;
    if (written.length === 1) {
      return { kind: 'done', held: heldSettingsOf(kept, patched), outcome: 'stored', ...count(patched) };
    }
    // The stored menu changed since it was read (a publish in between): read it again.
  }
  throw new Error('site_menu kept changing while the settings were stored');
}
