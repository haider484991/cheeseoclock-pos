/**
 * Where price history starts on this till (costing spec Phase 4, D8): once,
 * at boot after the migrations, every ingredient gets ONE starting price
 * ('seed' row) — the price it had that day. Reports then price a take from
 * before the history began at that starting price, which is what they did
 * until now, and a take after it at the price in force when it was taken.
 *
 * No old price is reconstructed (no audit-log parsing, no cross-till
 * merge). The rows are written through the repository (synced, audited),
 * with name-based ids, so the other till's starting rows are the same rows
 * and the link settles them by id. A flag in this till's own settings says
 * it has been done; an ingredient that already has a history is skipped, so
 * running it again writes nothing.
 */
import log from 'electron-log/main';
import type { AppDatabase } from '../db/connection.js';
import { getSettingRaw, setSetting } from '../db/repositories/settings-repo.js';
import { writeSeedPrices } from '../db/repositories/ingredient-cost-repo.js';

/** This till's own flag (pure-local `settings`): the starting prices are written. */
export const PRICE_HISTORY_SEEDED_KEY = 'costing.priceHistorySeeded';

export interface PriceSeedResult {
  /** Starting prices written now. */
  written: number;
  /** It had been done before: nothing was looked at. */
  alreadyDone: boolean;
}

/** Write the starting prices once per till (and the flag with them, in one transaction). */
export function seedPriceHistoryOnce(db: AppDatabase, deviceId: string, now: Date = new Date()): PriceSeedResult {
  if (getSettingRaw(db, PRICE_HISTORY_SEEDED_KEY) !== null) return { written: 0, alreadyDone: true };
  const written = db.transaction((): number => {
    const n = writeSeedPrices(db, { userId: null, deviceId });
    setSetting(db, PRICE_HISTORY_SEEDED_KEY, { at: now.toISOString(), rows: n });
    return n;
  })();
  log.info('Costing: starting prices written for the price history', { rows: written });
  return { written, alreadyDone: false };
}
