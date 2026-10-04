/**
 * The sales guard and the website rule follow the licence: a till whose
 * licence has run out refuses new orders and payments with the licence's own
 * words, and tells the website it is not accepting; a selling till is left
 * alone. The licence service is replaced by a stub; nothing else is.
 */
import { describe, expect, it, vi } from 'vitest';
import type { LicenceStatus } from '@cheeseoclock/shared-types';

const stub = vi.hoisted(() => ({ status: null as LicenceStatus | null }));
vi.mock('../services/licence/licence-service.js', () => ({
  licenceService: {
    status: () => stub.status!,
    salesAllowed: () => stub.status!.salesAllowed,
  },
}));
vi.mock('../services/auth-service.js', () => ({ getCurrentSession: () => null }));
// guards.ts throws the registry's IpcGuardError; the real registry pulls in every handler, so a stand-in class here.
vi.mock('./registry.js', () => {
  class IpcGuardError extends Error {
    readonly apiError: { code: string; message: string; details?: Record<string, unknown> };
    constructor(apiError: { code: string; message: string; details?: Record<string, unknown> }) {
      super(apiError.message);
      this.apiError = apiError;
      this.name = 'IpcGuardError';
    }
  }
  return { IpcGuardError, defineHandler: () => {}, markShuttingDown: () => {} };
});
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));

import { requireLicenceForSales } from './guards.js';
import { IpcGuardError } from './registry.js';
import { storeAcceptingOrders } from '../services/web-bridge-config.js';

const base: LicenceStatus = {
  state: 'active',
  message: 'Licensed to Made Up Pizza (Pro) until 5 Oct 2027.',
  deviceId: 'dev-1',
  plan: 'pro',
  shop: 'Made Up Pizza',
  licenceId: 'lic_test',
  paidUntil: '2027-10-05T00:00:00.000Z',
  daysLeft: 365,
  salesAllowed: true,
  problem: null,
  clockSuspect: false,
};

describe('requireLicenceForSales', () => {
  it('lets a selling till through: trial, active and grace alike', () => {
    for (const state of ['trial', 'active', 'grace'] as const) {
      stub.status = { ...base, state, salesAllowed: true };
      expect(() => requireLicenceForSales()).not.toThrow();
    }
  });

  it('refuses a stopped till with the licence’s own words and where to go', () => {
    stub.status = {
      ...base,
      state: 'expired',
      salesAllowed: false,
      daysLeft: -3,
      message: 'The free trial ended on 4 Oct 2026. Sales are stopped until a licence key is entered.',
    };
    let thrown: unknown;
    try {
      requireLicenceForSales();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(IpcGuardError);
    const err = thrown as IpcGuardError;
    expect(err.apiError.code).toBe('precondition_failed');
    expect(err.apiError.message).toContain('The free trial ended on 4 Oct 2026');
    expect(err.apiError.message).toContain('Settings → About → Licence');
    expect(err.apiError.details).toMatchObject({ licence: 'expired', daysLeft: -3 });
  });
});

describe('storeAcceptingOrders follows the licence', () => {
  it('a selling till with the switch on and no pause accepts; a stopped one does not', () => {
    stub.status = { ...base, salesAllowed: true };
    expect(storeAcceptingOrders({ enabled: true }, null)).toBe(true);
    stub.status = { ...base, state: 'expired', salesAllowed: false };
    expect(storeAcceptingOrders({ enabled: true }, null)).toBe(false);
  });

  it('the switch and a shift pause still rule when the licence sells', () => {
    stub.status = { ...base, salesAllowed: true };
    expect(storeAcceptingOrders({ enabled: false }, null)).toBe(false);
    expect(storeAcceptingOrders({ enabled: true }, { pausedAt: '2026-10-04T00:00:00.000Z' } as never)).toBe(false);
  });
});
