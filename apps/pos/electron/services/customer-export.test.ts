/**
 * The customer CSV: one row per address, a lone row for a customer without
 * one, header first, quotes and commas escaped, a value that looks like a
 * spreadsheet formula made harmless. Every person is made up.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ dialog: { showSaveDialog: async () => ({ canceled: true }) } }));
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));

import { CUSTOMER_EXPORT_COLUMNS, customersToCsv } from './customer-export.js';
import type { CustomerExportRow } from '../db/repositories/customer-repo.js';

const base: CustomerExportRow = {
  customerId: 'c1',
  name: 'Test Customer',
  phone: '03000000001',
  email: null,
  notes: null,
  loyaltyPoints: 0,
  isActive: true,
  createdAt: '2026-10-01T10:00:00.000Z',
  addressLabel: 'Home',
  addressLine: '1 Test Street, "The Corner", Flat 2',
  area: 'Test Phase 1',
  city: 'Karachi',
  addressNotes: 'ring twice, then call',
  isDefaultAddress: true,
};

describe('customersToCsv', () => {
  it('writes the header and one line per address, escaping quotes and commas', () => {
    const csv = customersToCsv([base]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(CUSTOMER_EXPORT_COLUMNS.join(','));
    expect(lines[1]).toBe(
      'c1,Test Customer,03000000001,,,0,yes,2026-10-01,Home,"1 Test Street, ""The Corner"", Flat 2",Test Phase 1,Karachi,"ring twice, then call",yes',
    );
    expect(lines[2]).toBe('');
  });

  it('a customer without an address still gets a row', () => {
    const csv = customersToCsv([
      { ...base, customerId: 'c2', name: 'No Address', phone: null, addressLabel: null, addressLine: null, area: null, city: null, addressNotes: null, isDefaultAddress: null },
    ]);
    expect(csv.split('\r\n')[1]).toBe('c2,No Address,,,,0,yes,2026-10-01,,,,,,');
  });

  it('never lets a value run as a spreadsheet formula', () => {
    const csv = customersToCsv([{ ...base, name: '=HYPERLINK("http://bad")', notes: '+1' }]);
    expect(csv).toContain(`"'=HYPERLINK(""http://bad"")"`);
    expect(csv).toContain(",'+1,");
  });
});
