import type { UUID } from './ids.js';

export interface Customer {
  id: UUID;
  name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
  loyaltyPoints: number;
  isActive: boolean;
  createdAt: string;
}

export interface CustomerAddress {
  id: UUID;
  customerId: UUID;
  label: string;
  addressLine: string;
  area: string | null;
  city: string | null;
  notes: string | null;
  isDefault: boolean;
}

/** A saved address found by house number / street, with who it belongs to. */
export interface CustomerAddressMatch extends CustomerAddress {
  customerName: string;
  customerPhone: string | null;
}

export interface CustomerWithAddresses extends Customer {
  addresses: CustomerAddress[];
}
