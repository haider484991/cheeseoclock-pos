/**
 * Phone-number normalization for Pakistani mobile + landline numbers.
 *
 * Accepts:
 *   "03001234567"      → "+923001234567"
 *   "+92 300 1234567"  → "+923001234567"
 *   "0092-300-1234567" → "+923001234567"
 *   "300 1234567"      → "+923001234567"  (10 digits, treated as PK mobile)
 *   "  ali  "          → null             (non-numeric)
 *   ""                 → null
 *
 * Returns the canonical "+92XXXXXXXXXX" or null if the input can't be parsed.
 * Storing only the canonical form prevents duplicate-customer rows for the
 * same human (the audit calls this out explicitly).
 *
 * Lives here (not in pos-domain, which re-exports it) so the shop-details
 * schemas in shared-schemas — which depend on shared-types only — check a
 * website phone line with the SAME rule the till uses for customers
 * ('shop.profile': normalizePhone(display) === e164).
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Strip all non-digits except a leading '+'.
  let digits = trimmed.replace(/[^\d+]/g, '');

  // Convert leading 00 to + (international dialling convention).
  if (digits.startsWith('00')) digits = '+' + digits.slice(2);

  if (digits.startsWith('+92')) {
    digits = '+92' + digits.slice(3).replace(/\D/g, '');
  } else if (digits.startsWith('92') && digits.length >= 11) {
    digits = '+92' + digits.slice(2).replace(/\D/g, '');
  } else if (digits.startsWith('0')) {
    digits = '+92' + digits.slice(1).replace(/\D/g, '');
  } else if (/^\d{10}$/.test(digits)) {
    // Bare 10-digit (300 1234567 without leading 0 or +)
    digits = '+92' + digits;
  } else {
    // Doesn't look like a Pakistani phone — bail.
    return null;
  }

  // Final sanity: +92 followed by 10 digits → 13 chars.
  if (!/^\+92\d{10}$/.test(digits)) return null;
  return digits;
}
