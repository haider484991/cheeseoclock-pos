/**
 * Which cloud copies to keep for one device.
 *
 * The old rule, "newest 8", had a hole: eight quick uploads — a misbehaving
 * client, or someone with the bridge secret trying to bury history — evicted
 * every real copy. This rule cannot be gamed that way:
 *
 *   - the newest 3 copies, whatever they are (the latest state);
 *   - the EARLIEST copy of each of the last 14 days (a later upload on the
 *     same day can never displace the one already recorded for that day);
 *   - every "before-restore" safety copy from the last 30 days (the state a
 *     restore overwrote must survive the restore).
 *
 * Bounded at 3 + 14 + a few, so a free-tier database still holds it.
 */

export interface RetainableBackup {
  id: string;
  createdAt: string | Date;
  reason?: string | null;
}

export const KEEP_NEWEST = 3;
export const KEEP_DAILY_DAYS = 14;
export const KEEP_SAFETY_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Returns the ids that should be deleted. Order of `rows` does not matter. */
export function selectBackupsToDelete(rows: RetainableBackup[], now: Date = new Date()): string[] {
  const items = rows
    .map((r) => ({ id: r.id, at: new Date(r.createdAt), reason: r.reason ?? null }))
    .filter((r) => !Number.isNaN(r.at.getTime()))
    .sort((a, b) => b.at.getTime() - a.at.getTime()); // newest first

  const keep = new Set<string>();

  for (const r of items.slice(0, KEEP_NEWEST)) keep.add(r.id);

  const dailyCutoff = now.getTime() - KEEP_DAILY_DAYS * DAY_MS;
  const earliestPerDay = new Map<string, { id: string; at: number }>();
  for (const r of items) {
    if (r.at.getTime() < dailyCutoff) continue;
    const key = dayKey(r.at);
    const cur = earliestPerDay.get(key);
    if (!cur || r.at.getTime() < cur.at) earliestPerDay.set(key, { id: r.id, at: r.at.getTime() });
  }
  for (const v of earliestPerDay.values()) keep.add(v.id);

  const safetyCutoff = now.getTime() - KEEP_SAFETY_DAYS * DAY_MS;
  for (const r of items) {
    if (r.reason === 'before-restore' && r.at.getTime() >= safetyCutoff) keep.add(r.id);
  }

  return items.filter((r) => !keep.has(r.id)).map((r) => r.id);
}
