import { describe, expect, it } from 'vitest';
import { COST_CAPABILITY, ROLE_CAPABILITIES, hasCapability, type Role } from '@cheeseoclock/shared-types';
import { PAGE_ACCESS, canOpenPage, homeFor, navPagesFor, showInNav, type GatedPage } from './navAccess';

const ALL_PAGES = Object.keys(PAGE_ACCESS) as GatedPage[];

describe('who opens which page', () => {
  it('a cashier: Checkout, Live Orders, Recent Orders and Riders — nothing else', () => {
    expect(navPagesFor('cashier')).toEqual(['/checkout', '/orders', '/orders/recent', '/riders']);
    for (const p of ['/customers', '/orders/history', '/reports', '/menu', '/inventory', '/costing', '/users', '/settings'] as const) {
      expect(canOpenPage('cashier', p)).toBe(false);
    }
  });

  it('costs: managers and the owner, between Inventory and Customers; never the counter', () => {
    for (const role of ['manager', 'admin'] as Role[]) {
      const pages = navPagesFor(role);
      expect(pages.indexOf('/costing')).toBe(pages.indexOf('/inventory') + 1);
      expect(pages.indexOf('/customers')).toBe(pages.indexOf('/costing') + 1);
    }
    expect(canOpenPage('cashier', '/costing')).toBe(false);
    expect(PAGE_ACCESS['/costing'].capability).toBe(COST_CAPABILITY);
  });

  it('a manager: everything but Users, with Order History instead of Recent Orders', () => {
    const pages = navPagesFor('manager');
    expect(pages).toContain('/customers');
    expect(pages).toContain('/orders/history');
    expect(pages).not.toContain('/users');
    expect(pages).not.toContain('/orders/recent');
    expect(canOpenPage('manager', '/users')).toBe(false);
  });

  it('the owner: every page (Recent Orders only by its address)', () => {
    for (const p of ALL_PAGES) expect(canOpenPage('admin', p)).toBe(true);
    expect(navPagesFor('admin')).toEqual(ALL_PAGES.filter((p) => p !== '/orders/recent'));
    expect(showInNav('admin', '/orders/recent')).toBe(false);
  });

  it('every page is shown to someone who may open it, never to someone who may not', () => {
    for (const role of ['admin', 'manager', 'cashier'] as Role[]) {
      for (const p of ALL_PAGES) {
        if (showInNav(role, p)) expect(canOpenPage(role, p)).toBe(true);
      }
    }
  });
});

describe('the start page', () => {
  it('the counter starts at Checkout; managers and the owner at the dashboard', () => {
    expect(homeFor('cashier')).toBe('/checkout');
    expect(homeFor('manager')).toBe('/');
    expect(homeFor('admin')).toBe('/');
  });

  it('a start page is always one that person may open', () => {
    for (const role of ['admin', 'manager', 'cashier'] as Role[]) {
      const home = homeFor(role);
      if (home !== '/') expect(canOpenPage(role, home as GatedPage)).toBe(true);
    }
  });
});

describe('the capabilities behind it (packages/shared-types auth.ts)', () => {
  it('a cashier has neither the customer list nor order history', () => {
    expect(hasCapability('cashier', 'customers.manage')).toBe(false);
    expect(hasCapability('cashier', 'order.history')).toBe(false);
    expect([...ROLE_CAPABILITIES.cashier].sort()).toEqual(['discount.apply', 'order.create', 'shift.open']);
  });

  it('managers and the owner have both', () => {
    for (const role of ['manager', 'admin'] as Role[]) {
      expect(hasCapability(role, 'customers.manage')).toBe(true);
      expect(hasCapability(role, 'order.history')).toBe(true);
    }
  });
});
