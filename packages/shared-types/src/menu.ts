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
