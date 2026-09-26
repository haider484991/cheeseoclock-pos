/**
 * When the screen says what about a manager's stepping-in login (see
 * STEP_IN_MAX_MS in electron/services/auth-service.ts): a warning a minute
 * before the till holds it, then the PIN box. Pure, so it is tested alone.
 */

/** How long before the hold the warning shows. */
export const STEP_IN_WARN_BEFORE_MS = 60_000;

export interface StepInClock {
  /** ms until the warning; 0 = show it now; null = too late (already held). */
  warnInMs: number | null;
  /** ms until the till holds the login (0 = now). */
  holdInMs: number;
}

export function stepInClock(endsAtIso: string, nowMs: number): StepInClock | null {
  const endsMs = Date.parse(endsAtIso);
  if (!Number.isFinite(endsMs)) return null;
  const holdInMs = Math.max(0, endsMs - nowMs);
  if (holdInMs === 0) return { warnInMs: null, holdInMs };
  return { warnInMs: Math.max(0, endsMs - STEP_IN_WARN_BEFORE_MS - nowMs), holdInMs };
}

/** "2:32 PM", as the rest of the till writes the time. */
export function stepInTimeLabel(endsAtIso: string): string {
  return new Date(endsAtIso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}
