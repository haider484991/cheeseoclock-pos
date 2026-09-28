/**
 * The settings block of the menu publish (shared-types web-bridge.ts, THE
 * SETTINGS BLOCK): the owner's delivery areas and fees and the website's
 * pick-up offer, stamped with the carried keys' row versions and times, and
 * checked against the very menu it travels with before it goes (the website
 * refuses a block whose active area names an item not in that menu at its
 * fee — and the menu with it). Read-only and free of Electron: the bridge
 * builds it; tests call it directly.
 */
import {
  PUBLISHED_SETTING_KEYS,
  settingsBlockProblem,
  type PublishedMenu,
  type PublishedSettings,
  type SettingsStamp,
} from '@cheeseoclock/shared-types';
import { buildSettingsBlock, type SettingStamp } from '@cheeseoclock/pos-domain';
import type { AppDatabase } from '../db/connection.js';
import {
  readBusinessSettingRow,
  readDeliveryZones,
  readWebsitePickup,
} from '../db/business-settings-read.js';

/** The carried keys' rows as they are on this till (null = never saved). */
function carriedStamps(db: AppDatabase): Array<SettingStamp | null> {
  return PUBLISHED_SETTING_KEYS.map((key) => {
    const row = readBusinessSettingRow(db, key);
    return row ? { version: row.version, updatedAt: row.updatedAt } : null;
  });
}

/**
 * This till's settings stamp: the sum of the carried keys' row versions and
 * their newest updated_at. Rev 0 = neither key is saved on either till —
 * the website then goes on exactly as before (no block is sent).
 */
export function localSettingsStamp(db: AppDatabase): SettingsStamp {
  const b = buildSettingsBlock({
    zones: [],
    pickup: { offered: true, percent: 0 },
    stamps: carriedStamps(db),
    menuItems: [],
  });
  return { settingsRev: b.settingsRev, settingsAt: b.settingsAt };
}

/**
 * The block to send with `menu`, or why none goes:
 *  - nothing saved (rev 0): no block, no problem — the website stays as today;
 *  - the block fails the website's own check against this menu (a fee item
 *    hidden, re-priced by an older till…): no block, and the reason in the
 *    owner's words ("Website not updated: …"); the menu still goes.
 */
export function settingsBlockFor(
  db: AppDatabase,
  menu: PublishedMenu,
): { block: PublishedSettings | null; problem: string | null; stamp: SettingsStamp } {
  const stamps = carriedStamps(db);
  const menuItems = menu.categories.flatMap((c) =>
    c.items.map((i) => ({ id: i.posItemId, name: i.name, basePriceCents: i.basePriceCents })),
  );
  const pickup = readWebsitePickup(db);
  const block = buildSettingsBlock({
    zones: readDeliveryZones(db),
    pickup: { offered: pickup.offered, percent: pickup.percent },
    stamps,
    menuItems,
  });
  const stamp = { settingsRev: block.settingsRev, settingsAt: block.settingsAt };
  if (block.settingsRev === 0) return { block: null, problem: null, stamp };
  const problem = settingsBlockProblem(block, menu);
  return problem ? { block: null, problem, stamp } : { block, problem: null, stamp };
}
