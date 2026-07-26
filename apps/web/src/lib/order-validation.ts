import type { PublishedMenuItem } from '@cheeseoclock/shared-types';

/**
 * Enforce the modifier-group rules server-side.
 *
 * OrderingApp already enforces these in the UI (radio vs checkbox, a
 * "required" badge, a disabled Add button), but the UI is not a security
 * boundary — a crafted POST bypasses all of it. Without this check a caller
 * could skip a required group entirely (a pizza with no size reaching the
 * kitchen) or repeat one modifier id, since nothing deduped them and every
 * repeat re-applied priceDeltaCents — which the bridge schema allows to be
 * negative, so a repeated discount modifier walks the total downwards.
 *
 * Mirrors the client rules exactly: single-select caps at one, maxSelect
 * caps when set, and a required group needs at least max(1, minSelect).
 *
 * Lives here rather than in the route module because Next.js rejects
 * non-route exports from a route file, and this needs to be unit-testable.
 *
 * @returns a customer-facing message, or null when the selection is valid.
 */
export function validateModifierSelection(
  item: PublishedMenuItem,
  modifierIds: string[],
): string | null {
  const unique = new Set(modifierIds);
  if (unique.size !== modifierIds.length) {
    return `Duplicate modifiers sent for "${item.name}".`;
  }
  for (const group of item.modifierGroups) {
    const idsInGroup = new Set(group.modifiers.map((m) => m.posModifierId));
    const chosen = modifierIds.filter((id) => idsInGroup.has(id)).length;

    if (group.selectionType === 'single' && chosen > 1) {
      return `"${group.name}" allows only one choice.`;
    }
    if (group.maxSelect > 0 && chosen > group.maxSelect) {
      return `"${group.name}" allows at most ${group.maxSelect} choices.`;
    }
    if (group.isRequired) {
      const needed = Math.max(1, group.minSelect);
      if (chosen < needed) {
        return `"${group.name}" is required for "${item.name}".`;
      }
    }
  }
  return null;
}
