import { COST_CAPABILITY, hasCapability, type Capability, type Role } from '@cheeseoclock/shared-types';

/**
 * Who may open which page: one list for the routes, the sidebar and the
 * "you can't be here" redirect, so they never disagree. The main process
 * refuses the same people on every channel behind these pages; hiding a
 * page here is only so nobody is shown a door that won't open.
 *
 * `hideWith`: shown in the sidebar only to someone WITHOUT that capability —
 * Recent Orders is the counter's small window on this shift, and managers
 * have Order History instead.
 */
export const PAGE_ACCESS = {
  '/checkout': { capability: 'order.create', label: 'Checkout' },
  '/orders': { capability: 'order.create', label: 'Live Orders' },
  '/orders/recent': { capability: 'order.create', label: 'Recent Orders', hideWith: 'order.history' },
  '/orders/history': { capability: 'order.history', label: 'Order History' },
  '/riders': { capability: 'order.create', label: 'Riders' },
  '/menu': { capability: 'menu.manage', label: 'Menu' },
  '/inventory': { capability: 'menu.manage', label: 'Inventory' },
  // What dishes cost to make (costing spec D6: COST_CAPABILITY, today menu.manage).
  '/costing': { capability: COST_CAPABILITY, label: 'Costing' },
  '/customers': { capability: 'customers.manage', label: 'Customers' },
  '/reports': { capability: 'report.view', label: 'Reports' },
  '/users': { capability: 'users.manage', label: 'Users' },
  // Managers reach Settings for the printers; the page shows them nothing else.
  '/settings': { capability: 'printer.manage', label: 'Settings' },
} as const satisfies Record<string, { capability: Capability; label: string; hideWith?: Capability }>;

export type GatedPage = keyof typeof PAGE_ACCESS;

export function canOpenPage(role: Role, page: GatedPage): boolean {
  return hasCapability(role, PAGE_ACCESS[page].capability);
}

/** In this person's sidebar: allowed, and not a counter-only page they have a fuller one for. */
export function showInNav(role: Role, page: GatedPage): boolean {
  const spec: { capability: Capability; hideWith?: Capability } = PAGE_ACCESS[page];
  if (!hasCapability(role, spec.capability)) return false;
  return !(spec.hideWith && hasCapability(role, spec.hideWith));
}

/**
 * Where this person starts, and where they are sent from a page that is not
 * theirs. The counter goes straight to Checkout (the dashboard has nothing
 * else for it); managers and the owner keep the dashboard.
 */
export function homeFor(role: Role): string {
  if (hasCapability(role, 'order.history')) return '/';
  return hasCapability(role, 'order.create') ? '/checkout' : '/';
}

/** Every gated page this person's sidebar lists, in order. */
export function navPagesFor(role: Role): GatedPage[] {
  return (Object.keys(PAGE_ACCESS) as GatedPage[]).filter((p) => showInNav(role, p));
}
