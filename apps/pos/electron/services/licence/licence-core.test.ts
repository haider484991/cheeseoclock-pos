/**
 * Licence maths against a throwaway Ed25519 key made here: genuine keys pass,
 * every kind of bad key is refused with a plain reason, and the trial, grace,
 * expiry and clock-rollback rules give the states the card and the sales
 * guard rely on. No database, no Electron. Every name is made up.
 */
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CLOCK_ROLLBACK_TOLERANCE_MS,
  TRIAL_DAYS,
  checkLicenceToken,
  effectiveNow,
  evaluateLicence,
} from './licence-core.js';

const DAY = 24 * 60 * 60 * 1000;
const DEVICE = '01a10799-4d17-7ff9-9b8a-25c16b9d08e7';
const OTHER_DEVICE = '01a10799-4d17-7ff9-9b8a-000000000000';
const NOW = new Date('2026-10-05T10:00:00.000Z');

const pair = generateKeyPairSync('ed25519');
const spki = pair.publicKey.export({ type: 'spki', format: 'der' });
const PUBLIC_RAW = Buffer.from(spki.subarray(spki.length - 32)).toString('base64url');
const otherPair = generateKeyPairSync('ed25519');

function issue(
  overrides: Partial<{
    v: number;
    id: string;
    shop: string;
    device: string;
    plan: string;
    issued: string;
    expires: string;
    graceDays: number;
  }> = {},
  privateKey = pair.privateKey,
): string {
  const payload = {
    v: 1,
    id: 'lic_test',
    shop: 'Made Up Pizza',
    device: DEVICE,
    plan: 'pro',
    issued: NOW.toISOString(),
    expires: new Date(NOW.getTime() + 365 * DAY).toISOString(),
    graceDays: 14,
    ...overrides,
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = sign(null, body, createPrivateKey(privateKey.export({ type: 'pkcs8', format: 'pem' })));
  return `COC1.${body.toString('base64url')}.${sig.toString('base64url')}`;
}

describe('checkLicenceToken', () => {
  it('accepts a genuine key for this till', () => {
    const r = checkLicenceToken(issue(), DEVICE, PUBLIC_RAW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.shop).toBe('Made Up Pizza');
      expect(r.payload.plan).toBe('pro');
    }
  });

  it('tolerates surrounding whitespace from a paste', () => {
    expect(checkLicenceToken(`  ${issue()}\n`, DEVICE, PUBLIC_RAW).ok).toBe(true);
  });

  it('refuses a key signed by someone else', () => {
    const r = checkLicenceToken(issue({}, otherPair.privateKey), DEVICE, PUBLIC_RAW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toMatch(/not genuine/);
  });

  it('refuses a key whose payload was edited after signing', () => {
    const token = issue();
    const [prefix, body, sig] = token.split('.') as [string, string, string];
    const edited = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { expires: string };
    edited.expires = new Date(NOW.getTime() + 10 * 365 * DAY).toISOString();
    const forged = `${prefix}.${Buffer.from(JSON.stringify(edited)).toString('base64url')}.${sig}`;
    const r = checkLicenceToken(forged, DEVICE, PUBLIC_RAW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toMatch(/not genuine/);
  });

  it('refuses a key for another till and names both device ids', () => {
    const r = checkLicenceToken(issue({ device: OTHER_DEVICE }), DEVICE, PUBLIC_RAW);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problem).toMatch(/another till/);
      expect(r.problem).toContain('01a10799');
    }
  });

  it('refuses text that is not a key at all', () => {
    for (const bad of ['', 'hello', 'COC1.onlytwo', 'ABC.x.y', 'COC1..']) {
      const r = checkLicenceToken(bad, DEVICE, PUBLIC_RAW);
      expect(r.ok).toBe(false);
    }
  });

  it('refuses a genuine key with a shape this till does not know (newer version)', () => {
    const r = checkLicenceToken(issue({ v: 2 }), DEVICE, PUBLIC_RAW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toMatch(/newer version/);
    const r2 = checkLicenceToken(issue({ plan: 'platinum' }), DEVICE, PUBLIC_RAW);
    expect(r2.ok).toBe(false);
  });
});

describe('evaluateLicence', () => {
  const base = { deviceId: DEVICE, publicKeyRaw: PUBLIC_RAW, lastSeenAt: null, now: NOW };

  it('starts a 30-day trial when nothing was ever entered', () => {
    const s = evaluateLicence({ ...base, token: null, trialStartedAt: null });
    expect(s.state).toBe('trial');
    expect(s.salesAllowed).toBe(true);
    expect(s.daysLeft).toBe(TRIAL_DAYS);
    expect(s.message).toMatch(/Free trial: 30 days left/);
  });

  it('counts the trial from when it began, and stops sales after it', () => {
    const started = new Date(NOW.getTime() - 29 * DAY).toISOString();
    const nearEnd = evaluateLicence({ ...base, token: null, trialStartedAt: started });
    expect(nearEnd.state).toBe('trial');
    expect(nearEnd.daysLeft).toBe(1);
    const over = evaluateLicence({ ...base, token: null, trialStartedAt: new Date(NOW.getTime() - 31 * DAY).toISOString() });
    expect(over.state).toBe('expired');
    expect(over.salesAllowed).toBe(false);
    expect(over.message).toMatch(/free trial ended/);
  });

  it('is active until paid-until, with the shop and plan on the card', () => {
    const s = evaluateLicence({ ...base, token: issue(), trialStartedAt: null });
    expect(s.state).toBe('active');
    expect(s.salesAllowed).toBe(true);
    expect(s.daysLeft).toBe(365);
    expect(s.shop).toBe('Made Up Pizza');
    expect(s.plan).toBe('pro');
    expect(s.licenceId).toBe('lic_test');
  });

  it('sells through the grace period with a reminder, then stops', () => {
    const expires = new Date(NOW.getTime() - 3 * DAY).toISOString();
    const grace = evaluateLicence({ ...base, token: issue({ expires, graceDays: 14 }), trialStartedAt: null });
    expect(grace.state).toBe('grace');
    expect(grace.salesAllowed).toBe(true);
    expect(grace.daysLeft).toBe(11);
    expect(grace.message).toMatch(/Sales stop in 11 days/);

    const dead = evaluateLicence({
      ...base,
      token: issue({ expires: new Date(NOW.getTime() - 20 * DAY).toISOString(), graceDays: 14 }),
      trialStartedAt: null,
    });
    expect(dead.state).toBe('expired');
    expect(dead.salesAllowed).toBe(false);
    expect(dead.daysLeft).toBe(-6);
    expect(dead.message).toMatch(/grace period is over/);
  });

  it('with no grace days the licence stops the day it runs out', () => {
    const s = evaluateLicence({
      ...base,
      token: issue({ expires: new Date(NOW.getTime() - 1).toISOString(), graceDays: 0 }),
      trialStartedAt: null,
    });
    expect(s.state).toBe('expired');
  });

  it('a stored key for another till falls back to the trial rules and says why', () => {
    const s = evaluateLicence({ ...base, token: issue({ device: OTHER_DEVICE }), trialStartedAt: null });
    expect(s.state).toBe('trial');
    expect(s.problem).toMatch(/another till/);
  });

  it('a stored key signed by someone else is ignored, not honoured', () => {
    const s = evaluateLicence({ ...base, token: issue({}, otherPair.privateKey), trialStartedAt: new Date(NOW.getTime() - 40 * DAY).toISOString() });
    expect(s.state).toBe('expired');
    expect(s.salesAllowed).toBe(false);
    expect(s.problem).toMatch(/not genuine/);
  });

  it('a clock set back does not rewind an expired licence', () => {
    const expires = new Date(NOW.getTime() - 30 * DAY).toISOString();
    const token = issue({ expires, graceDays: 7 });
    const honest = evaluateLicence({ ...base, token, trialStartedAt: null, lastSeenAt: NOW.toISOString() });
    expect(honest.state).toBe('expired');
    const rolledBack = evaluateLicence({
      ...base,
      token,
      trialStartedAt: null,
      lastSeenAt: NOW.toISOString(),
      now: new Date(NOW.getTime() - 60 * DAY),
    });
    expect(rolledBack.state).toBe('expired');
  });

  it('says when the clock looks wrong: the latest time seen is more than a day ahead of now', () => {
    const seenAhead = new Date(NOW.getTime() + 40 * DAY).toISOString();
    const suspect = evaluateLicence({ ...base, token: issue(), trialStartedAt: null, lastSeenAt: seenAhead });
    expect(suspect.clockSuspect).toBe(true);
    // …and the licence counts from that later time until the owner fixes the clock.
    expect(suspect.daysLeft).toBe(325);
    const fine = evaluateLicence({ ...base, token: issue(), trialStartedAt: null, lastSeenAt: NOW.toISOString() });
    expect(fine.clockSuspect).toBe(false);
    expect(evaluateLicence({ ...base, token: null, trialStartedAt: null }).clockSuspect).toBe(false);
  });

  it('a clock within a day of the latest seen time is believed (time zones, small corrections)', () => {
    const seen = NOW.toISOString();
    expect(effectiveNow(new Date(NOW.getTime() - CLOCK_ROLLBACK_TOLERANCE_MS + 1000), seen).getTime()).toBe(
      NOW.getTime() - CLOCK_ROLLBACK_TOLERANCE_MS + 1000,
    );
    expect(effectiveNow(new Date(NOW.getTime() - CLOCK_ROLLBACK_TOLERANCE_MS - 1000), seen).getTime()).toBe(NOW.getTime());
    expect(effectiveNow(NOW, null)).toBe(NOW);
  });
});
