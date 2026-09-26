import { describe, expect, it } from 'vitest';
import {
  ALERT_SOUND_EVENTS,
  DEFAULT_ALERT_SOUND_SETTINGS,
  clampAlertVolume,
  newOrderSoundIsOff,
  normalizeAlertSoundSettings,
  orderNumberList,
  shortOrderNumber,
} from '@cheeseoclock/shared-types';

describe('Settings → Sounds defaults', () => {
  it('rings for everything, at 80%, with the ding-dong, until someone looks', () => {
    expect(DEFAULT_ALERT_SOUND_SETTINGS).toEqual({
      enabled: true,
      volume: 80,
      newOrderTone: 'bell',
      repeatUntilSeen: true,
      waitingIncludesCounter: false,
      events: {
        newOnlineOrder: true,
        importFailed: true,
        waitingTooLong: true,
        printerProblem: true,
        lowStock: true,
      },
    });
  });

  it('cannot be changed by accident', () => {
    expect(Object.isFrozen(DEFAULT_ALERT_SOUND_SETTINGS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_ALERT_SOUND_SETTINGS.events)).toBe(true);
  });
});

describe('normalizeAlertSoundSettings', () => {
  it('gives the defaults for nothing saved or junk', () => {
    for (const raw of [null, undefined, 'loud', 42, [], [1, 2], true]) {
      expect(normalizeAlertSoundSettings(raw)).toEqual(DEFAULT_ALERT_SOUND_SETTINGS);
    }
  });

  it('keeps a valid saved choice exactly', () => {
    const saved = {
      enabled: false,
      volume: 35,
      newOrderTone: 'counterBell',
      repeatUntilSeen: false,
      waitingIncludesCounter: true,
      events: { newOnlineOrder: false, importFailed: true, waitingTooLong: false, printerProblem: true, lowStock: false },
    };
    expect(normalizeAlertSoundSettings(saved)).toEqual(saved);
  });

  it('clamps and rounds the volume, and a broken one goes back to 80', () => {
    expect(normalizeAlertSoundSettings({ volume: 150 }).volume).toBe(100);
    expect(normalizeAlertSoundSettings({ volume: -5 }).volume).toBe(0);
    expect(normalizeAlertSoundSettings({ volume: 33.7 }).volume).toBe(34);
    expect(normalizeAlertSoundSettings({ volume: Number.NaN }).volume).toBe(80);
    expect(normalizeAlertSoundSettings({ volume: Infinity }).volume).toBe(80);
    expect(normalizeAlertSoundSettings({ volume: '50' }).volume).toBe(80);
    expect(clampAlertVolume(0)).toBe(0);
  });

  it('falls back field by field: one bad value never resets the rest', () => {
    const s = normalizeAlertSoundSettings({ enabled: 'yes', volume: 40, newOrderTone: 'siren', events: { lowStock: false, printerProblem: 'no' } });
    expect(s.enabled).toBe(true);
    expect(s.volume).toBe(40);
    expect(s.newOrderTone).toBe('bell');
    expect(s.events.lowStock).toBe(false);
    expect(s.events.printerProblem).toBe(true);
  });

  it('turns on any event it has not heard of yet (a till upgraded from an older build)', () => {
    const s = normalizeAlertSoundSettings({ events: { newOnlineOrder: false } });
    for (const e of ALERT_SOUND_EVENTS) expect(s.events[e]).toBe(e !== 'newOnlineOrder');
  });

  it('drops keys it does not know', () => {
    const s = normalizeAlertSoundSettings({ volume: 50, extra: 'x', events: { lowStock: true, other: false } });
    expect(Object.keys(s).sort()).toEqual(['enabled', 'events', 'newOrderTone', 'repeatUntilSeen', 'volume', 'waitingIncludesCounter']);
    expect(Object.keys(s.events).sort()).toEqual([...ALERT_SOUND_EVENTS].sort());
  });

  it('returns a new object, never the frozen defaults', () => {
    const s = normalizeAlertSoundSettings(null);
    expect(s).not.toBe(DEFAULT_ALERT_SOUND_SETTINGS);
    expect(Object.isFrozen(s)).toBe(false);
  });
});

describe('newOrderSoundIsOff (the "sound is off" note on every screen)', () => {
  const d = DEFAULT_ALERT_SOUND_SETTINGS;
  it('is on by default', () => expect(newOrderSoundIsOff(d)).toBe(false));
  it('is off when sounds, the order sound, or nearly all the volume is off', () => {
    expect(newOrderSoundIsOff({ ...d, enabled: false })).toBe(true);
    expect(newOrderSoundIsOff({ ...d, events: { ...d.events, newOnlineOrder: false } })).toBe(true);
    expect(newOrderSoundIsOff({ ...d, volume: 15 })).toBe(true);
    expect(newOrderSoundIsOff({ ...d, volume: 20 })).toBe(false);
  });
  it('does not care about the other sounds', () => {
    expect(newOrderSoundIsOff({ ...d, events: { ...d.events, lowStock: false, printerProblem: false } })).toBe(false);
  });
});

describe('order numbers on alerts', () => {
  it('shows the short number, the way Live Orders does', () => {
    expect(shortOrderNumber('CO-20260926-0042')).toBe('#0042');
    expect(shortOrderNumber('0042')).toBe('#0042');
    expect(shortOrderNumber('')).toBe('#?');
  });
  it('says "+N more" only when some are left out', () => {
    expect(orderNumberList(['A-1', 'A-2', 'A-3'])).toBe('#1, #2, #3');
    expect(orderNumberList(['A-1', 'A-2', 'A-3', 'A-4', 'A-5'])).toBe('#1, #2, #3 +2 more');
    expect(orderNumberList(['A-1'])).toBe('#1');
  });
});
