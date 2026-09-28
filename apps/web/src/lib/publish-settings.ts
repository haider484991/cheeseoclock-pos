import {
  DELIVERY_ZONES,
  SETTINGS_MAX_CLOCK_AHEAD_MS,
  compareSettingsStamp,
  settingsBlockProblem,
  type PublishSettingsOutcome,
  type PublishedMenu,
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
 *  - otherwise (newer or EQUAL, or nothing stored): stored with the menu.
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
          THEN EXCLUDED.menu_json
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
