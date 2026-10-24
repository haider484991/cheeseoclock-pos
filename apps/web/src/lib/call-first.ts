/**
 * "Call to confirm before cooking" (user, 24 Oct 2026, after order #4 came in from "ABC Road House No 99, DHA Phase 7"
 * and nobody at the shop knew the number): COD has no payment step, so a made-up name, number and address cook and ride
 * exactly like a real order. Nothing here refuses an order — a real customer's first order goes through as before. It
 * only leads the order's notes with a warning the till shows, so the shop rings the number before the kitchen starts:
 *
 *  - a number that has never had a website order delivered (a first-time customer, or one whose earlier orders were all
 *    cancelled);
 *  - and, for such a number, an address that reads like a placeholder ("ABC Road", "test", "xyz"), has no house
 *    number, or is a few letters; or a number that reads like one (the checkout's own "0300 1234567", one digit
 *    seven times).
 *
 * A number with a delivered website order is trusted: no warning, whatever its address says.
 *
 * The till prints the notes on the kitchen slip ("!! ORDER NOTE: ...", above the items) AND on the customer's bill
 * ("Order note: ...", printer-core receipt-renderer), so the words are plain checks a customer can read without
 * offence ("check the address"), never "fake". Plain ASCII for the thermal printer. Pure and unit-tested
 * (call-first.test.ts); api/orders asks the database whether the number is trusted.
 */

export const CALL_FIRST_HEADLINE = 'CALL TO CONFIRM BEFORE COOKING';

/** Words people type when they are not giving a real address. Whole words, any case. */
const PLACEHOLDER_WORDS =
  /\b(test|testing|abc|abcd|xyz|asdf|asd|qwerty|fake|dummy|sample|demo|lorem|ipsum|blah|none|nothing|null|nil|n\/a|na|xxx+|aaa+)\b/i;

/** What to check about a delivery address that looks made up, or null when it reads like a real one. */
export function junkAddressReason(address: string): string | null {
  const text = address.replace(/\s+/g, ' ').trim();
  const word = PLACEHOLDER_WORDS.exec(text);
  if (word) return `check the address ("${word[0]}")`;
  if (/([^\s.,\-/#])\1{3,}/.test(text)) return 'check the address (repeated letters)';
  if (text.length < 8) return 'check the address (too short)';
  if (!/\d/.test(text)) return 'check the address (no house number)';
  return null;
}

/** 'check the number' for a phone number that looks made up, else null. Takes the stored form (+92 and ten digits). */
export function junkPhoneReason(phone: string): string | null {
  const national = phone.replace(/^\+92/, '');
  const subscriber = national.slice(-7);
  if (/^(\d)\1{6}$/.test(subscriber)) return 'check the number';
  if (subscriber === '1234567' || subscriber === '7654321') return 'check the number';
  if (/(\d)\1{5,}/.test(national)) return 'check the number';
  return null;
}

export interface CallFirstFacts {
  /** The number has a delivered website order: trusted, no warning. */
  trusted: boolean;
  /** The stored phone (+92…). */
  phone: string;
  /** The delivery address; null for a pick-up (nothing to check). */
  address: string | null;
}

/**
 * The warning that leads the notes, or null for a trusted number:
 * "CALL TO CONFIRM BEFORE COOKING: new number; check the address ("ABC")".
 */
export function callFirstLine(facts: CallFirstFacts): string | null {
  if (facts.trusted) return null;
  const reasons = [
    'new number',
    junkPhoneReason(facts.phone),
    facts.address === null ? null : junkAddressReason(facts.address),
  ].filter((r): r is string => r !== null);
  return `${CALL_FIRST_HEADLINE}: ${reasons.join('; ')}`;
}
