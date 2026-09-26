import { describe, expect, it } from 'vitest';
import type { ChoiceGroupLike, ModifierSelectionType } from '@cheeseoclock/shared-types';
import { onePickAdds, opensChoicesOnAdd, STRAY_TAP_MS, strayTapGuard } from './choiceFlow';

type Group = ChoiceGroupLike & { selectionType: ModifierSelectionType };

function group(name: string, over: Partial<Group> = {}): Group {
  return { name, isRequired: false, minSelect: 0, selectionType: 'multi', modifiers: [{ name: 'x' }], ...over };
}

const CHOOSE_DIP = group('Choose your dip', { isRequired: true, minSelect: 1, selectionType: 'single' });
const SIDE_DIPS = group('Dips on the side');
const EXTRA_TOPPINGS = group('Extra toppings');
const LEAVE_OUT = group('Leave out · Fajita Pizza');

describe('opensChoicesOnAdd', () => {
  it('opens the choices for a pizza whose choices are all optional', () => {
    expect(opensChoicesOnAdd([LEAVE_OUT, EXTRA_TOPPINGS, SIDE_DIPS])).toBe(true);
  });

  it('opens them for an item that must have a choice', () => {
    expect(opensChoicesOnAdd([CHOOSE_DIP, SIDE_DIPS])).toBe(true);
  });

  it('adds a drink or a dip (no choices) with one tap', () => {
    expect(opensChoicesOnAdd([])).toBe(false);
  });
});

describe('onePickAdds', () => {
  it('a lone must-pick list: the tap on a pick adds the item', () => {
    expect(onePickAdds([CHOOSE_DIP], false)).toBe(true);
  });

  it('not with other lists to go through (dips on the side, leave-outs)', () => {
    expect(onePickAdds([CHOOSE_DIP, SIDE_DIPS], false)).toBe(false);
  });

  it('not for an optional list or a pick-several list', () => {
    expect(onePickAdds([SIDE_DIPS], false)).toBe(false);
    expect(onePickAdds([group('Choose 5 veggies', { isRequired: true, minSelect: 1, selectionType: 'multi' })], false)).toBe(false);
  });

  it('never while changing a line already in the cart', () => {
    expect(onePickAdds([CHOOSE_DIP], true)).toBe(false);
  });

  it('not before the choices have loaded', () => {
    expect(onePickAdds([], false)).toBe(false);
  });
});

describe('strayTapGuard', () => {
  /** A clock the test moves by hand; the popup opens at t = 1000. */
  function clock() {
    let t = 1000;
    return { now: () => t, advance: (ms: number) => void (t += ms) };
  }

  it('the second tap of a double tap lands on "Side of …": it neither selects nor moves focus', () => {
    const c = clock();
    const guard = strayTapGuard(c.now);
    c.advance(150);
    expect(guard.pointerDown()).toBe(true);
    expect(guard.keepsFocus()).toBe(true);
    c.advance(80);
    expect(guard.swallowsClick(1)).toBe(true);
  });

  it('a second tap on Cancel or the X is dropped the same way', () => {
    const c = clock();
    const guard = strayTapGuard(c.now);
    c.advance(STRAY_TAP_MS - 1);
    guard.pointerDown();
    c.advance(120); // the finger lifts after the window: still the same stray tap
    expect(guard.swallowsClick(1)).toBe(true);
  });

  it('a tap after the window is a real choice', () => {
    const c = clock();
    const guard = strayTapGuard(c.now);
    c.advance(STRAY_TAP_MS);
    expect(guard.pointerDown()).toBe(false);
    expect(guard.keepsFocus()).toBe(false);
    expect(guard.swallowsClick(1)).toBe(false);
  });

  it('never holds back the keyboard: Enter on "Add to order" adds at once', () => {
    const c = clock();
    const guard = strayTapGuard(c.now);
    c.advance(50);
    expect(guard.swallowsClick(0)).toBe(false);
  });

  it('a stray press that never became a click (a swipe) does not eat the next tap or key', () => {
    const c = clock();
    const guard = strayTapGuard(c.now);
    c.advance(100);
    guard.pointerDown(); // stray, then cancelled: no click
    c.advance(900);
    expect(guard.swallowsClick(0)).toBe(false); // Enter / Space on a button
    expect(guard.pointerDown()).toBe(false);
    expect(guard.swallowsClick(1)).toBe(false); // the next real tap
  });

  it('a tap beside the popup inside the window does not close it', () => {
    const c = clock();
    const guard = strayTapGuard(c.now);
    c.advance(200);
    expect(guard.isStray()).toBe(true);
    c.advance(STRAY_TAP_MS);
    expect(guard.isStray()).toBe(false);
  });
});
