import { z } from 'zod';

/**
 * What a licence token says, once its signature is checked. Issued by the
 * vendor's `apps/pos/scripts/licence.mjs issue`, verified on the till by
 * `electron/services/licence/licence-core.ts`. One token per till: `device` is
 * the till's own Device ID (Settings → About).
 *
 * Token: `COC1.<base64url(JSON of this)>.<base64url(Ed25519 signature)>`.
 */
export const licencePlanSchema = z.enum(['starter', 'pro', 'business']);
export type LicencePlan = z.infer<typeof licencePlanSchema>;

export const licencePayloadSchema = z.object({
  v: z.literal(1),
  /** Vendor's reference for this licence, e.g. `lic_x7Qm…`. */
  id: z.string().min(1).max(64),
  /** The shop it was sold to, for the card and the vendor's records. */
  shop: z.string().min(1).max(120),
  /** The till's Device ID. A token for another till is refused. */
  device: z.string().min(1).max(64),
  plan: licencePlanSchema,
  /** When the vendor issued it (ISO 8601 UTC). */
  issued: z.string().datetime(),
  /** Paid until (ISO 8601 UTC). Sales continue through the grace period after it. */
  expires: z.string().datetime(),
  /** Days after `expires` during which the till still sells, with a reminder. */
  graceDays: z.number().int().min(0).max(90),
});
export type LicencePayload = z.infer<typeof licencePayloadSchema>;
