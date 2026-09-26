import type { ChoiceGroupLike, ModifierSelectionType } from '@cheeseoclock/shared-types';

/**
 * When the till asks for an item's choices. Pure — unit-tested in
 * choiceFlow.test.ts. The order the groups are asked in is the shared
 * `orderChoiceGroups` (required, dips on the side, extras, drinks, leave-outs).
 */

/**
 * Adding an item: does the choices popup open first? Yes whenever the item has
 * any choice group (owner 2026-09-27: after a pizza's size, go on to its dips,
 * extras and leave-outs). Nothing has to be picked — the popup opens on "Add to
 * order", so Enter adds the item as it is. Dips have no choices and still go in
 * with one tap; a soft drink asks only its flavour (see `onePickAdds`).
 */
export function opensChoicesOnAdd(groups: readonly ChoiceGroupLike[]): boolean {
  return groups.length > 0;
}

/**
 * The item's only choice is one pick from one list it cannot go without (a
 * dip, a soft drink's flavour): the tap on that pick adds the item. Never while
 * editing a cart line.
 */
export function onePickAdds(
  groups: ReadonlyArray<ChoiceGroupLike & { selectionType: ModifierSelectionType }>,
  editing: boolean,
): boolean {
  const only = groups.length === 1 ? groups[0]! : null;
  return !editing && only !== null && only.isRequired && only.selectionType === 'single';
}

/**
 * How long after the choices popup opens a tap on the screen is still the
 * second half of the double tap that opened it.
 */
export const STRAY_TAP_MS = 500;

/**
 * Items that used to go in with one tap (fries, burgers, a pizza after its
 * size) now open the choices popup, which covers the middle of the screen. A
 * cashier's habitual double tap on the tile or the size then lands on the
 * popup: on a paid "Side of …" (selected, then added by the Enter that
 * follows), on Cancel or on the X. For the first STRAY_TAP_MS every tap —
 * inside the popup or beside it — does nothing. The keyboard is never held
 * back: Enter on "Add to order" still adds at once.
 *
 * Wiring: `pointerDown()` on every press inside the popup, `keepsFocus()` on
 * its mousedown (a stray tap must not move focus off "Add to order" into the
 * note), `swallowsClick(detail)` on its click, `isStray()` for a press outside.
 */
export function strayTapGuard(now: () => number = Date.now) {
  const openedAt = now();
  let pressIsStray = false;
  const isStray = () => now() - openedAt < STRAY_TAP_MS;
  return {
    isStray,
    /** A finger or the mouse went down on the popup. True: ignore this tap. */
    pointerDown(): boolean {
      pressIsStray = isStray();
      return pressIsStray;
    },
    /** The mousedown of that tap: true to keep focus where it is. */
    keepsFocus(): boolean {
      return pressIsStray;
    },
    /**
     * A click reached the popup. `detail` is 0 for a click made by the keyboard
     * (Enter or Space on a button), which is never swallowed. True: drop it.
     */
    swallowsClick(detail: number): boolean {
      if (detail === 0) return false;
      const stray = pressIsStray;
      pressIsStray = false;
      return stray;
    },
  };
}

export type StrayTapGuard = ReturnType<typeof strayTapGuard>;
