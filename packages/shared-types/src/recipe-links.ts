/**
 * A menu item's recipe linked to other items' recipes (0.7.47; the owner,
 * 12 Oct 2026: "Deal ki recipe bhi link ho, copy nahi"). A Big Two deal links
 * two Zinger Burgers and a Regular Fries; a deal's slot links each choice to
 * its item. Everything that reads a recipe opens the links up (pos-domain
 * recipe-links.ts), so the deal follows the burger's recipe.
 */

/** A link as the recipe editor saves it. */
export interface RecipeLinkInput {
  componentItemId: string;
  /** How many of the component one of this item takes (1–99). */
  qtyPerUnit: number;
  /** This item's choice the component comes with; null / absent = every sale. */
  modifierId?: string | null;
  /** The component's own choices whose lines come too (a pizza's size); absent = none. */
  componentModifierIds?: string[];
}

/** A link as the recipe screens show it. */
export interface RecipeLinkView {
  id: string;
  menuItemId: string;
  componentItemId: string;
  componentName: string;
  qtyPerUnit: number;
  modifierId: string | null;
  /** "Deal: Burger: Grilled"'s option name; null on every sale. */
  modifierName: string | null;
  componentModifierIds: string[];
  componentModifierNames: string[];
}
