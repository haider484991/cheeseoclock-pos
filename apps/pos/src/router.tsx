import { createHashRouter, Navigate, redirect } from 'react-router-dom';
import { LoginPage } from './features/auth/LoginPage';
import { AppShell } from './features/shell/AppShell';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { CheckoutPage } from './features/checkout/CheckoutPage';
import { MenuPage } from './features/menu-mgmt/MenuPage';
import { SettingsPage } from './features/settings/SettingsPage';
import { InventoryPage } from './features/inventory/InventoryPage';
import { CostingPage } from './features/costing/CostingPage';
import { ReportsPage } from './features/reports/ReportsPage';
import { CustomersPage } from './features/customers/CustomersPage';
import { UsersPage } from './features/users/UsersPage';
import { OrdersBoardPage } from './features/orders/OrdersBoardPage';
import { OrderHistoryPage } from './features/orders/OrderHistoryPage';
import { RidersPage } from './features/riders/RidersPage';
import { RecentOrdersPage } from './features/orders/RecentOrdersPage';
import { useSessionStore } from './stores/sessionStore';
import { canOpenPage, homeFor, type GatedPage } from './features/shell/navAccess';
import { OnlyFor } from './features/shell/OnlyFor';
import type { ReactNode } from 'react';

function requireAuth() {
  const session = useSessionStore.getState().user;
  if (!session) throw redirect('/login');
  return session;
}

/**
 * A page for some logins only (who: PAGE_ACCESS in navAccess.ts). Navigating
 * there without it goes to that person's start page; someone already on it
 * when their role changes is sent there by OnlyFor, with a toast.
 */
function gated(page: GatedPage, element: ReactNode) {
  return {
    path: page.slice(1),
    element: <OnlyFor page={page}>{element}</OnlyFor>,
    loader: () => {
      const user = requireAuth();
      if (!canOpenPage(user.role, page)) throw redirect(homeFor(user.role));
      return user;
    },
  };
}

export const router: ReturnType<typeof createHashRouter> = createHashRouter([
  {
    path: '/login',
    element: <LoginPage />,
  },
  {
    path: '/',
    element: <AppShell />,
    loader: () => requireAuth(),
    children: [
      { index: true, element: <DashboardPage /> },
      gated('/checkout', <CheckoutPage />),
      gated('/orders', <OrdersBoardPage />),
      gated('/orders/recent', <RecentOrdersPage />),
      gated('/orders/history', <OrderHistoryPage />),
      gated('/riders', <RidersPage />),
      gated('/menu', <MenuPage />),
      gated('/inventory', <InventoryPage />),
      gated('/costing', <CostingPage />),
      gated('/reports', <ReportsPage />),
      gated('/customers', <CustomersPage />),
      gated('/users', <UsersPage />),
      gated('/settings', <SettingsPage />),
    ],
  },
  // Catch-all: any stale or unknown hash → bounce to dashboard.
  { path: '*', element: <Navigate to="/" replace /> },
]);
