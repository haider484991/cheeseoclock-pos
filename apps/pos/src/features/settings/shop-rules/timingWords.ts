/**
 * Settings → Staff & kitchen timing in plain words: the History lines, the
 * worked examples, and the reprint rule as Settings → Printers says it. Every
 * number in them comes from the values, never typed into the text.
 */
import type { KitchenTiming, StaffTiming } from '@cheeseoclock/shared-types';

const COPIES = ['no copy', 'one copy', 'two copies', 'three copies'] as const;
const minutes = (n: number) => `${n} minute${n === 1 ? '' : 's'}`;
const hours = (n: number) => `${n} hour${n === 1 ? '' : 's'}`;

/**
 * The reprint rule (Settings → Printers → Refunds and reprints), built from
 * the owner's values. Null (the setting could not be read here): the rule
 * without its numbers.
 */
export function reprintRuleText(t: Pick<StaffTiming, 'freeReprints' | 'reprintWindowMin'> | null): string {
  if (!t) {
    return "A counter login gets a set number of copies of a paid receipt for the order in front of it (Settings → Staff & kitchen); any more, or an older order, needs a manager's PIN or password.";
  }
  if (t.freeReprints <= 0) {
    // reprint-policy.ts: the paper that adds the FBR number, when the receipt printed without it, is
    // never counted — for the order in front of the counter it is free whatever the owner allows.
    return `A counter login can't print a paid receipt again by hand: every copy needs a manager's PIN or password, except the one copy that adds the FBR number when the receipt first printed without it (for the order in front of it: on Live Orders, or paid in the last ${minutes(t.reprintWindowMin)}).`;
  }
  const copies = COPIES[t.freeReprints] ?? `${t.freeReprints} copies`;
  return `A counter login gets ${copies} of a paid receipt for the order in front of it (on Live Orders, or paid in the last ${minutes(t.reprintWindowMin)}); any more, or an older order, needs a manager's PIN or password.`;
}

/** One line for History: "Idle sign-out 15 min · logins 12 h · step-in 10 min · 1 free reprint within 30 min". */
export function staffTimingSummary(t: StaffTiming): string {
  const reprints = t.freeReprints === 0 ? 'no free reprints' : `${t.freeReprints} free reprint${t.freeReprints === 1 ? '' : 's'} within ${t.reprintWindowMin} min`;
  return `Idle sign-out ${t.idleLogoutMin} min · logins ${t.maxLoginHours} h · step-in ${t.stepInMin} min · ${reprints}`;
}

/** The staff card's worked example, from the values. */
export function staffTimingExample(t: StaffTiming): string {
  return [
    `The owner or a manager leaves the till signed in and walks away: after ${minutes(t.idleLogoutMin)} with nobody touching it, the till signs them out. A cashier is never signed out for that.`,
    `A cashier who signs in at 12 noon is signed out ${hours(t.maxLoginHours)} later at the latest, and signs in again.`,
    `A manager who signs in on the till a cashier was just using gets ${minutes(t.stepInMin)}; then the till asks for their PIN again or hands back to the cashier.`,
    reprintRuleText(t),
  ].join(' ');
}

/** One line for History: "Amber 15 min, red 30 · reminders: not started 10, not done 30". */
export function kitchenTimingSummary(t: KitchenTiming): string {
  return `Amber ${t.amberMin} min, red ${t.redMin} · reminders: not started ${t.notStartedMin}, not done ${t.notDoneMin}`;
}

/** The kitchen card's worked example, from the values. */
export function kitchenTimingExample(t: KitchenTiming): string {
  return `An order sent to the kitchen at 7:00 turns amber on Live Orders at ${clock(19 * 60 + t.amberMin)} and red at ${clock(19 * 60 + t.redMin)}. A website order still in New at ${clock(19 * 60 + t.notStartedMin)} gets a soft beep and a note; if it is still not done at ${clock(19 * 60 + t.notDoneMin)}, another (Settings → Sounds turns the beep on or off).`;
}

/** Minutes after midnight as "7:15" (the example's evening, no AM / PM). */
function clock(minutesOfDay: number): string {
  const h = Math.floor(minutesOfDay / 60) % 12 || 12;
  const m = minutesOfDay % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}
