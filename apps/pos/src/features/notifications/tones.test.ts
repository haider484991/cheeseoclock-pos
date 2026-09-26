import { describe, expect, it } from 'vitest';
import { DEFAULT_ALERT_SOUND_SETTINGS, NEW_ORDER_TONES, ALERT_SOUND_EVENTS } from '@cheeseoclock/shared-types';
import {
  FADE_FLOOR,
  SOUND_IDS,
  TONES,
  envelopeAt,
  maxPeakSum,
  noteEnd,
  soundForEvent,
  toneLength,
  volumeToGain,
  type SoundId,
} from './tones';

describe('every sound is well-formed', () => {
  it.each(SOUND_IDS)('%s', (id) => {
    const spec = TONES[id];
    expect(spec.label.length).toBeGreaterThan(0);
    expect(spec.notes.length).toBeGreaterThan(0);
    for (const n of spec.notes) {
      for (const v of [n.at, n.freq, n.peak, n.attack, n.hold, n.release]) expect(Number.isFinite(v)).toBe(true);
      expect(n.at).toBeGreaterThanOrEqual(0);
      expect(n.attack).toBeGreaterThan(0);
      expect(n.hold).toBeGreaterThanOrEqual(0);
      expect(n.release).toBeGreaterThan(0);
      expect(n.peak).toBeGreaterThan(0);
      expect(n.peak).toBeLessThanOrEqual(1);
      // Heard well on a small PC speaker, never above what it can play.
      expect(n.freq).toBeGreaterThanOrEqual(200);
      expect(n.freq).toBeLessThanOrEqual(5_000);
      for (const p of n.partials ?? []) {
        expect(n.freq * p.ratio).toBeLessThanOrEqual(8_000);
        expect(p.gain).toBeGreaterThan(0);
        expect(p.gain).toBeLessThan(1);
      }
    }
  });

  it('none is longer than 2.5 s (a repeat every 9 s leaves a gap)', () => {
    for (const id of SOUND_IDS) expect(toneLength(TONES[id])).toBeLessThanOrEqual(2.5);
  });

  it('none clips at full volume, even with every overtone in phase', () => {
    for (const id of SOUND_IDS) expect(maxPeakSum(TONES[id])).toBeLessThanOrEqual(1);
  });

  it('the bell chimes ring on (a fading tail), not a click', () => {
    for (const t of NEW_ORDER_TONES) {
      const longest = Math.max(...TONES[`newOrder:${t}`].notes.map((n) => n.release));
      expect(longest).toBeGreaterThanOrEqual(0.9);
    }
  });
});

describe('each sound can be told apart', () => {
  const signature = (id: SoundId) =>
    TONES[id].notes.map((n) => `${n.wave}:${Math.round(n.freq)}@${n.at.toFixed(2)}`).join(' ');

  it('no two sounds are the same', () => {
    const all = SOUND_IDS.map(signature);
    expect(new Set(all).size).toBe(all.length);
  });

  it('the alarm sounds nothing like any chime', () => {
    const alarm = TONES.importFailed.notes;
    expect(alarm.every((n) => n.wave === 'square')).toBe(true);
    for (const t of NEW_ORDER_TONES) {
      expect(TONES[`newOrder:${t}`].notes.some((n) => n.wave === 'square')).toBe(false);
    }
  });

  it('a problem falls, information rises', () => {
    const [p1, p2] = TONES.printer.notes;
    const [l1, l2] = TONES.lowStock.notes;
    expect(p2!.freq).toBeLessThan(p1!.freq);
    expect(l2!.freq).toBeGreaterThan(l1!.freq);
  });
});

describe('envelope', () => {
  const n = { at: 1, freq: 1000, wave: 'sine' as const, peak: 0.5, attack: 0.01, hold: 0.1, release: 1 };
  it('is silent before and after the note', () => {
    expect(envelopeAt(n, 0.99)).toBe(0);
    expect(envelopeAt(n, noteEnd(n))).toBe(0);
  });
  it('rises, holds, then fades to a thousandth', () => {
    expect(envelopeAt(n, 1.005)).toBeCloseTo(0.25, 5);
    expect(envelopeAt(n, 1.05)).toBe(0.5);
    expect(envelopeAt(n, noteEnd(n) - 1e-9)).toBeCloseTo(0.5 * FADE_FLOOR, 6);
  });
});

describe('soundForEvent', () => {
  it('uses the chosen chime for a new order', () => {
    for (const t of NEW_ORDER_TONES) {
      expect(soundForEvent('newOnlineOrder', { newOrderTone: t })).toBe(`newOrder:${t}`);
    }
  });
  it('has a sound for every event', () => {
    for (const e of ALERT_SOUND_EVENTS) expect(SOUND_IDS).toContain(soundForEvent(e, DEFAULT_ALERT_SOUND_SETTINGS));
  });
});

describe('volumeToGain', () => {
  it('0 is silent, 100 is full, 80 (the default) is 0.64', () => {
    expect(volumeToGain(0)).toBe(0);
    expect(volumeToGain(100)).toBe(1);
    expect(volumeToGain(80)).toBeCloseTo(0.64, 10);
  });
  it('only ever goes up as the slider goes up', () => {
    let last = -1;
    for (let v = 0; v <= 100; v += 5) {
      const g = volumeToGain(v);
      expect(g).toBeGreaterThan(last);
      last = g;
    }
  });
  it('never goes outside 0–1, and junk is silent', () => {
    expect(volumeToGain(250)).toBe(1);
    expect(volumeToGain(-10)).toBe(0);
    expect(volumeToGain(Number.NaN)).toBe(0);
  });
});
