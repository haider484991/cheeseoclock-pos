/**
 * Settings → Money & discounts → "Buy 1 Get 1 deals" ('deals.buy1Get1'; shared-types buy-1-get-1.ts): the form's
 * words and its hours lists. Pure, so the card's rules are tested without a screen (buy1Get1Form.test.ts).
 */
import {
  SHOP_SETTING_FORMAT,
  buy1Get1ClosedMessage,
  buy1Get1HoursProblem,
  buy1Get1WindowWords,
  type Buy1Get1Deals,
} from '@cheeseoclock/shared-types';

/** The form: the value without its format. Every field is a pick, so it always reads. */
export type Buy1Get1Form = Omit<Buy1Get1Deals, 'v'>;

export function buy1Get1ToForm(v: Buy1Get1Deals): Buy1Get1Form {
  return { on: v.on, opensMinute: v.opensMinute, closesMinute: v.closesMinute, asksSocial: v.asksSocial };
}

/** The value to save, or why not (the hours: buy1Get1HoursProblem, the same rule the till and the website check). */
export function buy1Get1FromForm(f: Buy1Get1Form): { value: Buy1Get1Deals | null; problem: string | null } {
  const problem = buy1Get1HoursProblem(f);
  if (problem) return { value: null, problem };
  return { value: { v: SHOP_SETTING_FORMAT['deals.buy1Get1'], ...f }, problem: null };
}

/** The lists' steps: every half hour. */
const STEP = 30;

/** "1:00 PM", "12:00 PM (noon)", "12:00 AM (midnight)" for the day's end (1440). */
export function minuteLabel(minute: number): string {
  if (minute === 1440) return '12:00 AM (midnight)';
  const h = Math.floor(minute / 60);
  const mm = String(minute % 60).padStart(2, '0');
  const label = `${h % 12 || 12}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
  return minute === 720 ? `${label} (noon)` : label;
}

/**
 * The "From" list (12:00 AM to 11:30 PM) and the "To" list (12:30 AM to midnight), every half hour — with the saved
 * minute too when it is between two (a value saved elsewhere is shown as it is, never moved).
 */
export function hourOptions(kind: 'from' | 'to', saved: number): Array<{ minute: number; label: string }> {
  const minutes: number[] = [];
  for (let m = kind === 'from' ? 0 : STEP; m <= (kind === 'from' ? 1440 - STEP : 1440); m += STEP) minutes.push(m);
  if (!minutes.includes(saved)) minutes.push(saved);
  return minutes.sort((a, b) => a - b).map((minute) => ({ minute, label: minuteLabel(minute) }));
}

/** Under the hours: what they mean, past midnight included. */
export function hoursNote(f: Pick<Buy1Get1Form, 'opensMinute' | 'closesMinute'>): string {
  if (buy1Get1HoursProblem(f)) return 'Every day, Karachi time.';
  const words = buy1Get1WindowWords(f);
  if (words === 'all day') return 'Every day, all day.';
  return f.closesMinute < f.opensMinute
    ? `Every day ${words}: past midnight, into the next morning.`
    : `Every day ${words}, Karachi time.`;
}

/** The worked example under the card. */
export function buy1Get1Example(f: Buy1Get1Form): string {
  if (!f.on) {
    return 'The deals are greyed on the till and hidden on the website, with their banner. Switch them on to sell them again.';
  }
  if (buy1Get1HoursProblem(f)) return 'Pick the hours to see what they mean.';
  const sold = buy1Get1ClosedMessage({ ...f, on: true });
  const name = f.asksSocial
    ? 'Online, the customer must type their Instagram or Facebook name: it is the first line of the order’s notes, so the cashier knows whose post to check.'
    : 'Online, the Instagram or Facebook name is optional: check the post when the customer comes or the rider delivers.';
  return `${sold} Outside the hours the till greys them (an order started inside the hours keeps its deal) and the website shows them closed. ${name}`;
}

/** Under the card: where the deals themselves come from. */
export const BUY_1_GET_1_MENU_NOTE =
  'The deals are the menu’s “Buy 1 Get 1 Deals” items (they come with the menu file). They never take a % off — no discount, no website offer.';

/** What "never changed" means here: the poster's rules. */
export const BUY_1_GET_1_NEVER_CHANGED = 'Never changed: the poster’s rules — on, every day 1 PM to 7 PM, the name asked for online.';
