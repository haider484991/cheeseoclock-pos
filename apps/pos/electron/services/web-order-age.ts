/**
 * Is a web order too old to cook? Pure so it can be unit-tested without the
 * bridge. An unparseable timestamp is NOT treated as stale — the website's own
 * sweep still protects that case, and refusing a fresh order on a bad string
 * would be the worse mistake.
 */
export function isStaleWebOrder(createdAt: string, maxAgeMs: number, now: number = Date.now()): boolean {
  const placed = Date.parse(createdAt);
  return Number.isFinite(placed) && now - placed > maxAgeMs;
}
