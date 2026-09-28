import {
  DELIVERY_ZONES,
  SETTINGS_MAX_CLOCK_AHEAD_MS,
  compareSettingsStamp,
  settingsBlockProblem,
  type PublishSettingsOutcome,
  type PublishedMenu,
  type PublishedSettings,
  type SettingsStamp,
} from '@cheeseoclock/shared-types';
import { sql } from './db';

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
 * Store the menu, and decide its block, in ONE statement on the site_menu
 * row (a read-then-write would let an older till publishing at the same
 * moment wipe a newer block):
 *  - no block (an older till): the stored block stays, with the new menu;
 *  - a block older than the stored one: dropped, the stored block stays, the
 *    menu is stored;
 *  - otherwise (newer or EQUAL, or nothing stored): stored with the menu.
 * The row comparison (rev, at) >= (rev, at) is compareSettingsStamp:
 * revision first, then time.
 *
 * @returns the block the website holds now (null = none) and what happened
 *   to the one sent.
 */
export async function storePublishedMenu(
  menu: Omit<PublishedMenu, 'settings'>,
  settings: PublishedSettings | undefined,
): Promise<{ held: SettingsStamp | null; outcome: PublishSettingsOutcome }> {
  const doc: PublishedMenu = settings ? { ...menu, settings } : { ...menu };
  const hasBlock = settings !== undefined;
  const rows = (await sql()`
    INSERT INTO site_menu (id, menu_json, published_at)
    VALUES (1, ${JSON.stringify(doc)}, now())
    ON CONFLICT (id) DO UPDATE SET
      menu_json = CASE
        WHEN ${hasBlock}::boolean AND (
               site_menu.menu_json -> 'settings' IS NULL
            OR (${settings?.settingsRev ?? 0}::integer, ${settings?.settingsAt ?? null}::timestamptz)
               >= ((site_menu.menu_json #>> '{settings,settingsRev}')::integer,
                   (site_menu.menu_json #>> '{settings,settingsAt}')::timestamptz))
          THEN EXCLUDED.menu_json
        WHEN site_menu.menu_json -> 'settings' IS NOT NULL
          THEN jsonb_set(EXCLUDED.menu_json - 'settings', '{settings}', site_menu.menu_json -> 'settings')
        ELSE EXCLUDED.menu_json - 'settings'
      END,
      published_at = now()
    RETURNING menu_json #>> '{settings,settingsAt}' AS settings_at,
              (menu_json #>> '{settings,settingsRev}')::integer AS settings_rev
  `) as Array<{ settings_at: string | null; settings_rev: number | string | null }>;
  const row = rows[0];
  const held =
    row && row.settings_at !== null && row.settings_rev !== null
      ? { settingsAt: row.settings_at, settingsRev: Number(row.settings_rev) }
      : null;
  let outcome: PublishSettingsOutcome;
  if (settings) outcome = held && compareSettingsStamp(held, settings) === 0 ? 'stored' : 'ignored_older';
  else outcome = held ? 'kept' : 'none';
  return { held, outcome };
}

/** The block's stamp the website holds (null = none), for the bridge's status read. */
export async function storedSettingsStamp(): Promise<SettingsStamp | null> {
  const rows = (await sql()`
    SELECT menu_json #>> '{settings,settingsAt}' AS settings_at,
           (menu_json #>> '{settings,settingsRev}')::integer AS settings_rev
      FROM site_menu WHERE id = 1
  `) as Array<{ settings_at: string | null; settings_rev: number | string | null }>;
  const row = rows[0];
  return row && row.settings_at !== null && row.settings_rev !== null
    ? { settingsAt: row.settings_at, settingsRev: Number(row.settings_rev) }
    : null;
}
