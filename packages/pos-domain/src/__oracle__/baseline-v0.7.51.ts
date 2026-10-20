/**
 * FROZEN BASELINE — v0.7.51 (origin/main 182d8cb). DO NOT EDIT. DO NOT "FIX".
 *
 * Word-for-word copies of the money and phone functions as the pilot tills in
 * Cheese O'Clock run them today. The international edition (shop locale) moves
 * the live versions; these stay still, so a test can prove the Pakistani path
 * still gives the same answer it gave before any of that work started.
 *
 * The rule: when an oracle test fails, the live code changed Pakistan's
 * behaviour. That is the bug. Changing this file to match hides it.
 *
 * Till code is identical at v0.7.51 and 182d8cb (the only change between them
 * removed a stray apps/pos/login-attempts.key), so this is the shipped tills'
 * behaviour, not a development snapshot.
 */

/** v0.7.51 pos-domain/src/money.ts formatCents, copied word for word. */
export function baselineFormatCents(cents: number, opts?: { showSymbol?: boolean }): string {
  const showSymbol = opts?.showSymbol ?? true;
  const value = cents / 100;
  // Whole rupees print bare ("Rs 4,000"); part rupees always show both
  // paisa digits ("Rs 641.10", never "Rs 641.1").
  const whole = Math.round(cents) % 100 === 0;
  const formatted = new Intl.NumberFormat('en-PK', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
  return showSymbol ? `Rs ${formatted}` : formatted;
}

/** v0.7.51 shared-types/src/phone.ts normalizePhone, copied word for word. */
export function baselineNormalizePhone(raw: string | null | undefined): string | null {
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
 * A small deterministic PRNG (mulberry32) so the hundred-thousand-input sweeps
 * are the same run after run and on every machine. A failure is reproducible
 * by its seed; a random one would not be.
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
