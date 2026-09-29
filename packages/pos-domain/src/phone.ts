import { normalizePhone } from '@cheeseoclock/shared-types';

/**
 * Phone-number normalization for Pakistani mobile + landline numbers: THE
 * rule (shared-types phone.ts, where the shop-details schemas use it too),
 * re-exported here so every till import keeps working.
 */
export { normalizePhone };

export interface PhoneSearchTerms {
  /**
   * Canonical "+92XXXXXXXXXX" when the whole input normalises — match
   * `phone = ?` (exact) or `phone LIKE canonical || '%'`. Null for partial
   * or non-phone input.
   */
  canonical: string | null;
  /**
   * Digits-only remainder with the trunk prefix ("0", "92", "0092") dropped,
   * so "0300 123", "+92 300 123" and "300123" all become "300123". Match
   * `phone LIKE '%' || digits || '%'` so a number still being typed (a
   * prefix) and the last few digits (a suffix) both hit the stored canonical
   * form. Null when the input has no digits or nothing survives the strip.
   */
  digits: string | null;
}

/**
 * Derive the phone-matching terms for a customer search box. Phones are
 * stored canonical ("+923001234567") while cashiers type the local form
 * ("03001234567"), so a raw `LIKE '%input%'` never matches — this turns the
 * typed text into terms that do. Pure; the SQL lives in the repository.
 */
export function phoneSearchTerms(search: string): PhoneSearchTerms {
  const trimmed = search.trim();
  if (!/\d/.test(trimmed)) return { canonical: null, digits: null };
  const canonical = normalizePhone(trimmed);
  let digits = trimmed.replace(/\D/g, '');
  if (digits.startsWith('0092')) digits = digits.slice(4);
  else if (digits.startsWith('92')) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  return { canonical, digits: digits || null };
}

/**
 * Mask a phone for display in audit logs and partial reports.
 *   "+923001234567" → "+92 ••• ••• 4567"
 */
export function redactPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const normalized = normalizePhone(phone) ?? phone;
  if (normalized.length < 4) return '••••';
  const last4 = normalized.slice(-4);
  return `••• ••• ${last4}`;
}

/** Format the canonical phone for display: "+92 300 1234567". */
export function formatPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const normalized = normalizePhone(phone);
  if (!normalized) return phone;
  // +923001234567 → +92 300 1234567
  return `${normalized.slice(0, 3)} ${normalized.slice(3, 6)} ${normalized.slice(6)}`;
}
