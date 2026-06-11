/** Rs 1,234 (drops paisa when zero, shows 2dp otherwise) — mirrors the POS. */
export function formatCents(cents: number): string {
  const rupees = cents / 100;
  const hasPaisa = cents % 100 !== 0;
  return `Rs ${rupees.toLocaleString('en-PK', {
    minimumFractionDigits: hasPaisa ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}

/** Normalize a Pakistani phone to +92XXXXXXXXXX, or null if hopeless. */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, '');
  if (/^\+92\d{10}$/.test(digits)) return digits;
  if (/^92\d{10}$/.test(digits)) return `+${digits}`;
  if (/^0\d{10}$/.test(digits)) return `+92${digits.slice(1)}`;
  if (/^3\d{9}$/.test(digits)) return `+92${digits}`;
  return null;
}
