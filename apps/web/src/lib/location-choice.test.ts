import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LOCATION_DISMISSED_KEY,
  LOCATION_EVENT,
  LOCATION_KEY,
  PIN_FRESH_MS,
  dismissForThisVisit,
  freshPin,
  isQuietPath,
  kmBetween,
  onLocationChoice,
  parseLocationChoice,
  readLocationChoice,
  saveLocationChoice,
  serializeLocationChoice,
  shouldAsk,
  wasDismissedThisVisit,
  type LocationChoice,
} from './location-choice';
import { STORAGE_KEYS } from './device-memory';

const AT = Date.UTC(2026, 9, 24, 10, 0, 0);
const DELIVERY: LocationChoice = {
  fulfilment: 'delivery',
  zoneId: 'dha-6',
  pin: { lat: 24.8083, lng: 67.0684, accuracyM: 12 },
  pinAt: AT,
  at: AT,
};

describe('parseLocationChoice', () => {
  it('reads back what was saved', () => {
    expect(parseLocationChoice(serializeLocationChoice(DELIVERY))).toEqual(DELIVERY);
    const pickup: LocationChoice = { fulfilment: 'pickup', zoneId: null, pin: null, pinAt: null, at: AT };
    expect(parseLocationChoice(serializeLocationChoice(pickup))).toEqual(pickup);
  });

  it('a pick-up carries no area; a pin without its time has no time', () => {
    expect(parseLocationChoice(JSON.stringify({ fulfilment: 'pickup', zoneId: 'dha-6', at: AT }))?.zoneId).toBeNull();
    expect(parseLocationChoice(JSON.stringify({ ...DELIVERY, pinAt: 'yesterday' }))?.pinAt).toBeNull();
  });

  it('is null for anything that is not a choice', () => {
    for (const raw of [
      null,
      '',
      'not json',
      '[]',
      JSON.stringify({ fulfilment: 'walk', zoneId: 'dha-6', at: AT }),
      JSON.stringify({ fulfilment: 'delivery', at: AT }),
      JSON.stringify({ fulfilment: 'delivery', zoneId: 'DHA 6!', at: AT }),
      JSON.stringify({ fulfilment: 'pickup', at: 'now' }),
    ]) {
      expect(parseLocationChoice(raw), String(raw)).toBeNull();
    }
  });
});

describe('freshPin', () => {
  it('offers a pin for two hours, then never', () => {
    expect(freshPin(DELIVERY, AT + PIN_FRESH_MS)).toEqual(DELIVERY.pin);
    expect(freshPin(DELIVERY, AT + PIN_FRESH_MS + 1)).toBeNull();
    expect(freshPin(DELIVERY, AT - 1)).toBeNull();
    expect(freshPin(null)).toBeNull();
  });
});

describe('when the popup asks', () => {
  it('asks once, never on a tracking page or the dashboard', () => {
    expect(shouldAsk('/', null, false)).toBe(true);
    expect(shouldAsk('/menu', null, false)).toBe(true);
    expect(shouldAsk('/menu', DELIVERY, false)).toBe(false);
    expect(shouldAsk('/menu', null, true)).toBe(false);
    for (const p of ['/track/abc', '/TRACK', '/dashboard', '/dashboard/orders']) expect(isQuietPath(p), p).toBe(true);
    expect(isQuietPath('/delivery/dha-phase-6')).toBe(false);
  });
});

describe('kmBetween', () => {
  it('measures the shop to Clifton Block 5 at about 4 km', () => {
    const km = kmBetween({ lat: 24.8083, lng: 67.0684 }, { lat: 24.8197, lng: 67.0306 });
    expect(km).toBeGreaterThan(3.5);
    expect(km).toBeLessThan(4.5);
    expect(kmBetween({ lat: 1, lng: 2 }, { lat: 1, lng: 2 })).toBe(0);
  });
});

describe('saving, in a browser', () => {
  const store = new Map<string, string>();
  const session = new Map<string, string>();
  let win: EventTarget;

  beforeEach(() => {
    store.clear();
    session.clear();
    win = Object.assign(new EventTarget(), {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
      sessionStorage: {
        getItem: (k: string) => session.get(k) ?? null,
        setItem: (k: string, v: string) => void session.set(k, v),
      },
    });
    vi.stubGlobal('window', win);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('saves, tells the page, and keeps the area where the menu has always looked', () => {
    const heard: Array<LocationChoice | null> = [];
    const stop = onLocationChoice((c) => heard.push(c));
    saveLocationChoice(DELIVERY);
    expect(readLocationChoice()).toEqual(DELIVERY);
    expect(store.get(STORAGE_KEYS.zone)).toBe('dha-6');
    expect(heard).toEqual([DELIVERY]);
    stop();
    saveLocationChoice({ ...DELIVERY, fulfilment: 'pickup', zoneId: null });
    expect(heard).toHaveLength(1);
  });

  it('hears another tab', () => {
    const heard: Array<LocationChoice | null> = [];
    onLocationChoice((c) => heard.push(c));
    const e = new Event('storage') as Event & { key: string; newValue: string };
    Object.assign(e, { key: LOCATION_KEY, newValue: serializeLocationChoice(DELIVERY) });
    win.dispatchEvent(e);
    expect(heard).toEqual([DELIVERY]);
    expect(LOCATION_EVENT).toBe('coc:location');
  });

  it('"not now" lasts this visit', () => {
    expect(wasDismissedThisVisit()).toBe(false);
    dismissForThisVisit();
    expect(session.get(LOCATION_DISMISSED_KEY)).toBe('1');
    expect(wasDismissedThisVisit()).toBe(true);
  });
});
