/**
 * FbrAdapter — the abstract interface for FBR Digital Invoicing (PRAL) submission.
 * Shaped against the documented POST `/di_data/v1/di/postinvoicedata` endpoint.
 *
 * Implementations live in apps/pos/electron/adapters/fbr/*:
 *  - noop      : stores payload, returns placeholder. Default until credentials configured.
 *  - sandbox   : POSTs to a local mock or FBR sandbox URL.
 *  - production: POSTs to the live FBR gateway.
 *
 * The adapter is dumb: it transforms a payload and POSTs it. The queue (which orders
 * are pending, retried, etc.) is owned by apps/pos/electron/services/fbr-worker.ts.
 */

export type FbrMode = 'noop' | 'sandbox' | 'production';

export interface FbrAdapterConfig {
  mode: FbrMode;
  endpoint?: string;
  bearerToken?: string;
  sellerNTN: string;
  retry: { maxAttempts: number; backoffMs: number };
}

export interface FbrInvoiceItem {
  hsCode: string;
  productDescription: string;
  rate: string;
  uoM: string;
  quantity: number;
  totalValues: number;
  valueSalesExcludingST: number;
  fixedNotifiedValueOrRetailPrice: number;
  salesTaxApplicable: number;
  salesTaxWithheldAtSource: number;
  extraTax?: number;
  furtherTax?: number;
  sroScheduleNo?: string;
  fedPayable?: number;
  discount?: number;
  saleType: string;
  sroItemSerialNo?: string;
}

export interface FbrInvoicePayload {
  invoiceType: 'Sale Invoice' | 'Debit Note';
  invoiceDate: string;
  sellerNTNCNIC: string;
  sellerBusinessName: string;
  sellerProvince: string;
  sellerAddress: string;
  buyerNTNCNIC?: string;
  buyerBusinessName?: string;
  buyerProvince?: string;
  buyerAddress?: string;
  buyerRegistrationType: 'Registered' | 'Unregistered';
  invoiceRefNo: string;
  scenarioId?: string;
  items: FbrInvoiceItem[];
}

export interface FbrSubmitResult {
  ok: boolean;
  irn?: string;
  qrPayload?: string;
  rawResponse: unknown;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export interface FbrValidationResult {
  ok: boolean;
  errors: string[];
}

export interface FbrAdapter {
  readonly mode: FbrMode;
  validateInvoice(payload: FbrInvoicePayload): Promise<FbrValidationResult>;
  submitInvoice(payload: FbrInvoicePayload): Promise<FbrSubmitResult>;
}

export const FBR_PRODUCTION_ENDPOINT =
  'https://gw.fbr.gov.pk/di_data/v1/di/postinvoicedata';
export const FBR_VALIDATE_ENDPOINT =
  'https://gw.fbr.gov.pk/di_data/v1/di/validateinvoicedata';

export { mapOrderToFbrPayload, DEFAULT_FBR_MAP_OPTS } from './mapper.js';
export type { FbrSellerInfo, FbrMapOptions } from './mapper.js';
