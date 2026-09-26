/**
 * The rules of an item's choice groups, checked on the till's own writes
 * (add an item, change a line's choices). The screen already asks in this
 * order, but a crafted call could add "Soft Drink — 1 litre" with no flavour
 * (owner test 2026-09-27): no bottle comes off stock and the counter hands
 * over a guess. Same rules as the website's validateModifierSelection.
 */

export interface ChoiceGroupRule {
  id: string;
  /** Shown in the refusal, e.g. "Choose a flavour · 1 litre". */
  label: string;
  selectionType: 'single' | 'multi';
  isRequired: boolean;
  minSelect: number;
  /** 0 = no upper limit. */
  maxSelect: number;
  optionIds: readonly string[];
}

/** A plain refusal for the cashier, or null when the picks are fine. */
export function checkChoicePicks(groups: readonly ChoiceGroupRule[], modifierIds: readonly string[]): string | null {
  if (new Set(modifierIds).size !== modifierIds.length) return 'The same choice was picked twice';
  for (const g of groups) {
    const inGroup = new Set(g.optionIds);
    const chosen = modifierIds.filter((id) => inGroup.has(id)).length;
    if (g.selectionType === 'single' && chosen > 1) return `${g.label}: pick only one`;
    if (g.maxSelect > 0 && chosen > g.maxSelect) return `${g.label}: pick at most ${g.maxSelect}`;
    const needed = g.isRequired || g.minSelect > 0 ? Math.max(1, g.minSelect) : 0;
    if (chosen < needed) return needed === 1 ? `${g.label}: pick one` : `${g.label}: pick ${needed}`;
  }
  return null;
}
