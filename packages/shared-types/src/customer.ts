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

/** One row of the Customers screen: the customer plus what the list shows. */
export interface CustomerListRow extends Customer {
  /** Placed orders (not open drafts, not voided). */
  orderCount: number;
  lastOrderAt: string | null;
  /** Area of the default address (else the newest one), for the list's Area column. */
  area: string | null;
}

export type CustomerListSort = 'name' | 'recent' | 'orders';
