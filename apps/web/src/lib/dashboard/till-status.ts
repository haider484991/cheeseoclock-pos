import { DASH_QUIET_MINUTES } from '@cheeseoclock/shared-types';
import type { TillState } from './queries';
import type { Tone } from '@/components/dashboard/ui';

/**
 * How each till stands, in words, from what it last sent: a till sends only
 * when something changes, and every few minutes while a shift is open — so
 * an open till that has gone quiet is worth a look (off, asleep, or offline),
 * while a shut till that is quiet is normal.
 */

export interface TillWord {
  tone: Tone;
  /** "Open since 12:58 pm", "Closed". */
  title: string;
  /** "Updated 2 min ago", "Quiet for 40 min — is it on and online?" */
  detail: string;
}

export function tillWord(t: TillState, words: { clock: (iso: string) => string; ago: (iso: string) => string }, now = Date.now()): TillWord {
  const quietMin = Math.round((now - Date.parse(t.lastPushAt)) / 60_000);
  const shift = t.live?.shift ?? null;
  if (shift) {
    if (quietMin >= DASH_QUIET_MINUTES) {
      return {
        tone: 'warn',
        title: `Open since ${words.clock(shift.openedAt)}`,
        detail: `Nothing from this till for ${quietMin >= 120 ? `${Math.round(quietMin / 60)} h` : `${quietMin} min`} — is it on and online?`,
      };
    }
    return { tone: 'good', title: `Open since ${words.clock(shift.openedAt)}`, detail: `Updated ${words.ago(t.lastPushAt)}` };
  }
  return { tone: 'neutral', title: 'Closed', detail: `Last heard ${words.ago(t.lastPushAt)}` };
}

/** The shop as a whole: open when any till has a shift open. */
export function shopOpen(tills: TillState[]): boolean {
  return tills.some((t) => t.live?.shift);
}
