import { z } from 'zod';

export const uuidSchema = z.string().uuid();

/** ISO 8601 timestamp string with millisecond precision, UTC. */
export const isoTimestampSchema = z.string().datetime({ offset: true });

export const centsSchema = z.number().int().nonnegative();
export const signedCentsSchema = z.number().int();
export const bpsSchema = z.number().int().min(0).max(10000);

/** Pakistani phone — accepts +92, 0092, or 0-prefixed local form. */
export const pakPhoneSchema = z
  .string()
  .trim()
  .regex(/^(?:\+?92|0)?3\d{9}$/, 'Invalid Pakistani mobile number');

/** Normalize a Pakistani phone to canonical +92XXXXXXXXXX form. */
export function normalizePakPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('92')) return `+${digits}`;
  if (digits.startsWith('0')) return `+92${digits.slice(1)}`;
  if (digits.length === 10 && digits.startsWith('3')) return `+92${digits}`;
  return raw;
}
