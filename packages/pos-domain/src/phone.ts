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
