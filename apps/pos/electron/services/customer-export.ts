/**
 * The customer book as a file the owner can take away: one row per saved
 * address (a customer without one gets a single row), UTF-8 with a byte-order
 * mark so Excel opens Urdu names correctly. Owner only (the handler checks);
 * the export is recorded in the settings (and so in the audit trail).
 */
import fs from 'node:fs';
import { dialog } from 'electron';
import log from 'electron-log/main';
import type { AppDatabase } from '../db/connection.js';
import { exportCustomerRows, type CustomerExportRow } from '../db/repositories/customer-repo.js';
import { setSetting } from '../db/repositories/settings-repo.js';

export const CUSTOMERS_LAST_EXPORT_KEY = 'customers.lastExport';

export const CUSTOMER_EXPORT_COLUMNS = [
  'Customer ID',
  'Name',
  'Phone',
  'Email',
  'Notes',
  'Loyalty points',
  'Active',
  'Customer since',
  'Address label',
  'Address',
  'Area',
  'City',
  'Address notes',
  'Usual address',
] as const;

function cell(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v);
  // Quote when needed; a leading =, +, - or @ is prefixed so a spreadsheet never runs it as a formula.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Pure: the rows as CSV text (CRLF lines, header first). */
export function customersToCsv(rows: readonly CustomerExportRow[]): string {
  const lines = [CUSTOMER_EXPORT_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.customerId,
        r.name,
        r.phone,
        r.email,
        r.notes,
        r.loyaltyPoints,
        r.isActive,
        r.createdAt.slice(0, 10),
        r.addressLabel,
        r.addressLine,
        r.area,
        r.city,
        r.addressNotes,
        r.isDefaultAddress,
      ]
        .map(cell)
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

export interface CustomerExportResult {
  path: string | null;
  customers: number;
  addresses: number;
}

/** Ask where to save, write the file, record the export. Cancelled = nothing written. */
export async function exportCustomersCsv(db: AppDatabase, actorUserId: string | null): Promise<CustomerExportResult> {
  const rows = exportCustomerRows(db);
  const customers = new Set(rows.map((r) => r.customerId)).size;
  const addresses = rows.filter((r) => r.addressLine !== null).length;
  const result = await dialog.showSaveDialog({
    title: 'Save the customer list',
    defaultPath: `customers-${new Date().toISOString().slice(0, 10)}.csv`,
    filters: [{ name: 'CSV (Excel, Google Sheets)', extensions: ['csv'] }],
  });
  if (result.canceled || !result.filePath) return { path: null, customers, addresses };
  fs.writeFileSync(result.filePath, '﻿' + customersToCsv(rows), 'utf8');
  setSetting(db, CUSTOMERS_LAST_EXPORT_KEY, { at: new Date().toISOString(), path: result.filePath, customers, addresses }, { actorUserId });
  log.info('Customer list exported', { path: result.filePath, customers, addresses });
  return { path: result.filePath, customers, addresses };
}
