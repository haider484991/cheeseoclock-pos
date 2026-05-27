/**
 * Currency: PKR. All amounts stored and passed as integer cents.
 * Tax rates stored as basis points (1600 = 16.00%).
 */

export type Cents = number & { readonly __brand: 'Cents' };
export type Bps = number & { readonly __brand: 'Bps' };

export const toCents = (n: number): Cents => Math.round(n) as Cents;
export const toBps = (n: number): Bps => Math.round(n) as Bps;

export type Currency = 'PKR';
export const CURRENCY: Currency = 'PKR';
