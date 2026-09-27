import { describe, expect, it } from 'vitest';
import { stepInClock } from '../shell/stepInClock';
import { OWNER_CARD_SHOW_MS, cardHideReason, cardHidesInMs, cardMayShow, type CardLogin, type CardShown } from './ownerCardClock';

/**
 * The Dashboard "This week" card at the counter (costing spec §2, Phase 7):
 * hidden until tapped, and hidden again after 2 minutes, on the idle lock,
 * and on a step-in. Only the owner sees the card (report.view; managers lost
 * it on 2026-09-27), so the step-in here is the owner's at a cashier's till.
 */
const T0 = Date.parse('2026-09-30T10:00:00.000Z');
const OWNER: CardLogin = { who: 'u_admin:admin', stepInEndsAt: null, stepInHeld: false };
const shownBy = (login: CardLogin, atMs = T0): CardShown => ({ atMs, who: login.who!, stepInEndsAt: login.stepInEndsAt });

describe('the "This week" card hides its figures again', () => {
  it('stays for 2 minutes after the tap, then hides', () => {
    const shown = shownBy(OWNER);
    expect(OWNER_CARD_SHOW_MS).toBe(120_000);
    expect(cardHideReason(shown, OWNER, T0 + 119_999)).toBeNull();
    expect(cardHidesInMs(shown, T0 + 100_000)).toBe(20_000);
    expect(cardHideReason(shown, OWNER, T0 + 120_000)).toBe('timeout');
    expect(cardHidesInMs(shown, T0 + 130_000)).toBe(0);
  });

  it('the idle lock (the login ended on its own) hides them at once', () => {
    expect(cardHideReason(shownBy(OWNER), { who: null, stepInEndsAt: null, stepInHeld: false }, T0 + 1_000)).toBe('signedOut');
  });

  it('someone else signing in (or the same person with another role) hides them', () => {
    const shown = shownBy(OWNER);
    expect(cardHideReason(shown, { ...OWNER, who: 'u_mgr:manager' }, T0 + 1_000)).toBe('otherLogin');
    expect(cardHideReason(shown, { ...OWNER, who: 'u_admin:manager' }, T0 + 1_000)).toBe('otherLogin');
  });

  it("the owner's step-in: hidden when it starts, when the till holds it (StepInHold), and never shown while held", () => {
    const ends = new Date(T0 + 10 * 60_000).toISOString();
    // A normal login tapped; then the till becomes a stepping-in login (a cashier's till): hide.
    expect(cardHideReason(shownBy(OWNER), { ...OWNER, stepInEndsAt: ends }, T0 + 1_000)).toBe('stepIn');
    // Tapped during a step-in: stays until the till holds the login…
    const stepping: CardLogin = { ...OWNER, stepInEndsAt: ends };
    const shown = shownBy(stepping);
    expect(cardHideReason(shown, stepping, T0 + 60_000)).toBeNull();
    // …which happens at stepInClock's hold time: then the PIN box is over the page and the figures go.
    const hold = stepInClock(ends, T0)!;
    expect(hold.holdInMs).toBe(10 * 60_000);
    expect(cardHideReason(shown, { ...stepping, stepInHeld: true }, T0 + hold.holdInMs)).toBe('stepIn');
    expect(cardMayShow({ ...stepping, stepInHeld: true })).toBe(false);
    // The owner types their PIN: a normal login again (no end time) — the figures stay hidden until tapped.
    expect(cardHideReason(shown, { ...stepping, stepInEndsAt: null }, T0 + 1_000)).toBe('stepIn');
  });

  it('nobody signed in: nothing to show', () => {
    expect(cardMayShow({ who: null, stepInEndsAt: null, stepInHeld: false })).toBe(false);
    expect(cardMayShow(OWNER)).toBe(true);
  });
});
