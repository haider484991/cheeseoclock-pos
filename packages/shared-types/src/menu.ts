import type { Cents, Bps } from './money.js';
import type { UUID } from './ids.js';

export type PrepStation = 'kitchen' | 'bar' | 'cold';

export interface Category {
  id: UUID;
  name: string;
  displayOrder: number;
  colorHex: string;
  isActive: boolean;
}

export interface MenuItem {
  id: UUID;
  categoryId: UUID;
  name: string;
  description: string | null;
  basePriceCents: Cents;
  sku: string | null;
  barcode: string | null;
  imageUrl: string | null;
  isActive: boolean;
  prepStation: PrepStation;
  taxCategoryId: UUID;
  sortOrder: number;
  currentStock: number | null;
  lowStockThreshold: number | null;
}

export type ModifierSelectionType = 'single' | 'multi';

export interface ModifierGroup {
  id: UUID;
  name: string;
  selectionType: ModifierSelectionType;
  minSelect: number;
  maxSelect: number;
  isRequired: boolean;
}

export interface Modifier {
  id: UUID;
  modifierGroupId: UUID;
  name: string;
  priceDeltaCents: Cents;
  isDefault: boolean;
  sortOrder: number;
  /**
   * A "leave out" choice ("No onion") names the ingredient it takes off the
   * dish: picked on an order line, that ingredient's base recipe line is not
   * deducted for the line. Null for every ordinary choice.
   */
  removesIngredientId?: UUID | null;
}

/**
 * The heading to show for a choice group. Group names are unique on the till,
 * so a per-item group carries the item after " · " ("Leave out · Fajita
 * Pizza"); customers and cashiers see only the part before it ("Leave out").
 */
export function groupDisplayName(name: string): string {
  const i = name.indexOf(' · ');
  return i > 0 ? name.slice(0, i) : name;
}

/** A "leave out" choice: printed as "NO ONION" on the kitchen ticket. */
export function isLeaveOutChoice(name: string): boolean {
  return /^no\s/i.test(name.trim());
}

export interface Combo {
  id: UUID;
  name: string;
  description: string | null;
  priceCents: Cents;
  isActive: boolean;
}

export type ComboSelectionType = 'fixed' | 'choice';

export interface ComboComponent {
  id: UUID;
  comboId: UUID;
  slotName: string;
  selectionType: ComboSelectionType;
  sortOrder: number;
}

export interface ComboComponentChoice {
  id: UUID;
  comboComponentId: UUID;
  menuItemId: UUID;
  priceDeltaCents: Cents;
}

export interface TaxCategory {
  id: UUID;
  name: string;
  rateBps: Bps;
}
