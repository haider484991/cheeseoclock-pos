/**
 * Licence maths, pure: a token string, the till's Device ID, the clock and the
 * stored trial/clock facts in; a LicenceStatus out. No database, no Electron.
 *
 * Rules (the words the card and banner show come from here too):
 *   - No token: a 30-day trial from the first start. After it, sales stop until
 *     a key is entered. Everything else (reports, backups, settings) stays open.
 *   - Valid token: sells until `expires`, then through `graceDays` of grace with
 *     a reminder, then sales stop. A new token for a later period lifts it.
 *   - A token for another Device ID, with a bad signature, or that does not
 *     parse is refused when pasted (activate) and ignored when found stored
 *     (the trial rules apply, with the reason shown).
 *   - The clock only moves forward: `lastSeenAt` is the latest time the till
 *     has seen; a clock set back more than a day does not rewind the licence.
 *
 * Token: `COC1.<base64url payload JSON>.<base64url Ed25519 signature>`; the
 * signature covers the exact payload bytes; the till holds the public key only.
 */
import { createPublicKey, verify } from 'node:crypto';
import { licencePayloadSchema, type LicencePayload } from '@cheeseoclock/shared-schemas';
import type { LicenceStatus } from '@cheeseoclock/shared-types';

export const LICENCE_TOKEN_PREFIX = 'COC1';
export const TRIAL_DAYS = 30;
/** A clock set back by more than this is ignored (the later time counts). */
export const CLOCK_ROLLBACK_TOLERANCE_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** SPKI DER header for an Ed25519 public key; the raw 32 bytes follow it. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export type TokenCheck =
  | { ok: true; payload: LicencePayload }
  | { ok: false; problem: string };

/** Signature + shape + device check. `publicKeyRaw` is the vendor key, base64url of 32 bytes. */
export function checkLicenceToken(token: string, deviceId: string, publicKeyRaw: string): TokenCheck {
  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts[0] !== LICENCE_TOKEN_PREFIX || !parts[1] || !parts[2]) {
    return { ok: false, problem: 'This is not a licence key. A key starts with COC1 and has three parts.' };
  }
  let body: Buffer;
  let sig: Buffer;
  try {
    body = Buffer.from(parts[1], 'base64url');
    sig = Buffer.from(parts[2], 'base64url');
  } catch {
    return { ok: false, problem: 'The key is damaged. Paste it again exactly as it was sent.' };
  }
  let signatureOk = false;
  try {
    const raw = Buffer.from(publicKeyRaw, 'base64url');
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
    signatureOk = sig.length === 64 && verify(null, body, key, sig);
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) {
    return { ok: false, problem: 'The key is not genuine or was changed after it was issued.' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { ok: false, problem: 'The key is damaged. Paste it again exactly as it was sent.' };
  }
  const shape = licencePayloadSchema.safeParse(parsed);
  if (!shape.success) {
    return { ok: false, problem: 'The key was made for a newer version of the till. Update the till, then paste it again.' };
  }
  if (shape.data.device !== deviceId) {
    return {
      ok: false,
      problem: `This key belongs to another till (device ${shortId(shape.data.device)}). This till's Device ID is ${shortId(deviceId)}.`,
    };
  }
  return { ok: true, payload: shape.data };
}

export interface LicenceFacts {
  /** The stored token, or null when none was ever entered. */
  token: string | null;
  deviceId: string;
  /** ISO. When the trial began (the first start). Null = begins now. */
  trialStartedAt: string | null;
  /** ISO. The latest time this till has seen; null the first time. */
  lastSeenAt: string | null;
  publicKeyRaw: string;
  now: Date;
}

/** The clock the licence uses: never earlier than the latest time already seen (minus a day's tolerance). */
export function effectiveNow(now: Date, lastSeenAt: string | null): Date {
  if (!lastSeenAt) return now;
  const seen = Date.parse(lastSeenAt);
  if (Number.isNaN(seen)) return now;
  return now.getTime() < seen - CLOCK_ROLLBACK_TOLERANCE_MS ? new Date(seen) : now;
}

function daysBetween(fromMs: number, toMs: number): number {
  return Math.ceil((toMs - fromMs) / DAY_MS);
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function dateWords(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** The whole answer for the card, the banner and the sales guard. */
export function evaluateLicence(facts: LicenceFacts): LicenceStatus {
  const now = effectiveNow(facts.now, facts.lastSeenAt);
  const nowMs = now.getTime();
  const base = {
    deviceId: facts.deviceId,
    plan: null,
    shop: null,
    licenceId: null,
    paidUntil: null,
    problem: null,
  };

  let problem: string | null = null;
  if (facts.token) {
    const check = checkLicenceToken(facts.token, facts.deviceId, facts.publicKeyRaw);
    if (check.ok) {
      const p = check.payload;
      const expiresMs = Date.parse(p.expires);
      const graceEndMs = expiresMs + p.graceDays * DAY_MS;
      const common = { ...base, plan: p.plan, shop: p.shop, licenceId: p.id, paidUntil: p.expires };
      if (nowMs < expiresMs) {
        const daysLeft = daysBetween(nowMs, expiresMs);
        return {
          ...common,
          state: 'active',
          salesAllowed: true,
          daysLeft,
          message: `Licensed to ${p.shop} (${planWords(p.plan)}) until ${dateWords(p.expires)}.`,
        };
      }
      if (nowMs < graceEndMs) {
        const daysLeft = daysBetween(nowMs, graceEndMs);
        return {
          ...common,
          state: 'grace',
          salesAllowed: true,
          daysLeft,
          message: `The licence ran out on ${dateWords(p.expires)}. Sales stop in ${dayWords(daysLeft)} — renew and paste the new key.`,
        };
      }
      return {
        ...common,
        state: 'expired',
        salesAllowed: false,
        daysLeft: -daysBetween(graceEndMs, nowMs),
        message: `The licence ran out on ${dateWords(p.expires)} and the ${p.graceDays}-day grace period is over. Sales are stopped until a new key is entered.`,
      };
    }
    problem = check.problem;
  }

  const trialStartMs = facts.trialStartedAt ? Date.parse(facts.trialStartedAt) : nowMs;
  const trialEndMs = (Number.isNaN(trialStartMs) ? nowMs : trialStartMs) + TRIAL_DAYS * DAY_MS;
  if (nowMs < trialEndMs) {
    const daysLeft = daysBetween(nowMs, trialEndMs);
    return {
      ...base,
      state: 'trial',
      salesAllowed: true,
      daysLeft,
      paidUntil: new Date(trialEndMs).toISOString(),
      problem,
      message: `Free trial: ${dayWords(daysLeft)} left. Enter a licence key before ${dateWords(new Date(trialEndMs).toISOString())} to keep selling.`,
    };
  }
  return {
    ...base,
    state: 'expired',
    salesAllowed: false,
    daysLeft: -daysBetween(trialEndMs, nowMs),
    paidUntil: new Date(trialEndMs).toISOString(),
    problem,
    message: `The free trial ended on ${dateWords(new Date(trialEndMs).toISOString())}. Sales are stopped until a licence key is entered.`,
  };
}

function planWords(plan: LicencePayload['plan']): string {
  return plan === 'starter' ? 'Starter' : plan === 'pro' ? 'Pro' : 'Business';
}

function dayWords(n: number): string {
  return n === 1 ? '1 day' : `${n} days`;
}
