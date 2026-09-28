import {
  DELIVERY_ZONES,
  SETTINGS_MAX_CLOCK_AHEAD_MS,
  compareSettingsStamp,
  settingsBlockProblem,
  type PublishSettingsOutcome,
  type PublishedFeeItem,
  type PublishedMenu,
  type PublishedMenuCategory,
  type PublishedSettings,
  type WebsiteSettingsHeld,
} from '@cheeseoclock/shared-types';
import { sql } from './db';
import { parseStoredSettings } from './site-facts';

/**
 * Storing a menu publish and its settings block (PUT /api/bridge/menu), per
 * the contract in shared-types web-bridge.ts ("THE SETTINGS BLOCK").
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
 * The same three names are written into storePublishedMenu's statement.
 */
export const KEPT_MESSAGE_FIELDS = ['closedNotice', 'announcement', 'minDeliveryOrderCents'] as const;

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

/**
 * Store the menu, and decide its block, in ONE statement on the site_menu
 * row (a read-then-write would let an older till publishing at the same
 * moment wipe a newer block):
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
 * @returns what the website holds now (null = no block) and what happened
 *   to the one sent.
 */
export async function storePublishedMenu(
  menu: Omit<PublishedMenu, 'settings'>,
  settings: PublishedSettings | undefined,
): Promise<{ held: WebsiteSettingsHeld | null; outcome: PublishSettingsOutcome }> {
  const doc: PublishedMenu = settings ? { ...menu, settings } : { ...menu };
  const hasBlock = settings !== undefined;
  const rows = (await sql()`
    INSERT INTO site_menu (id, menu_json, published_at)
    VALUES (1, ${JSON.stringify(doc)}, now())
    ON CONFLICT (id) DO UPDATE SET
      menu_json = CASE
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
                WHERE kept.key IN ('closedNotice', 'announcement', 'minDeliveryOrderCents')),
              '{}'::jsonb)
            || (EXCLUDED.menu_json -> 'settings'))
        WHEN site_menu.menu_json -> 'settings' IS NOT NULL
          THEN jsonb_set(EXCLUDED.menu_json - 'settings', '{settings}', site_menu.menu_json -> 'settings')
        ELSE EXCLUDED.menu_json - 'settings'
      END,
      published_at = now()
    RETURNING menu_json -> 'settings' AS settings
  `) as Array<{ settings: unknown }>;
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
  return { held, outcome };
}

/** The block the website holds (null = none) and whether it fits the menu stored with it, for the bridge's status read. */
export async function storedSettingsHeld(): Promise<WebsiteSettingsHeld | null> {
  const rows = (await sql()`
    SELECT menu_json FROM site_menu WHERE id = 1
  `) as Array<{ menu_json: PublishedMenu | string | null }>;
  const raw = rows[0]?.menu_json ?? null;
  const menu = typeof raw === 'string' ? (JSON.parse(raw) as PublishedMenu) : raw;
  if (!menu) return null;
  return heldSettingsOf(parseStoredSettings(menu.settings ?? null), menu);
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
