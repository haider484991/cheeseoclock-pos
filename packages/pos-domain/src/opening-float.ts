/**
 * What the Open shift box starts the float count on (Settings → Staff &
 * kitchen → Opening float, per till: 'drawer.openingFloat').
 *
 *  - 'lastCount' (the default, and the till before the setting): what this
 *    till's last closed shift counted — the cash that stayed in the drawer
 *    overnight. A first shift has none: the box starts at 0.
 *  - 'fixed': the owner's amount, every shift, whatever the last count was.
 *
 * Only a starting figure in a box: the float is still counted and typed,
 * and the close stays a blind count (no expected cash is shown).
 *
 * Pure.
 */
import type { OpeningFloatPrefill, OpeningFloatSetting } from '@cheeseoclock/shared-types';

export function openingFloatPrefill(
  setting: Pick<OpeningFloatSetting, 'mode' | 'fixedCents'>,
  lastCount: { countedCashCents: number; closedAt: string } | null,
): OpeningFloatPrefill {
  if (setting.mode === 'fixed') return { prefillCents: setting.fixedCents, from: 'fixed', lastCount };
  if (lastCount) return { prefillCents: lastCount.countedCashCents, from: 'last_count', lastCount };
  return { prefillCents: null, from: 'none', lastCount: null };
}
