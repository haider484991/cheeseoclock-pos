import { createHashRouter, Navigate, redirect } from 'react-router-dom';
import { LoginPage } from './features/auth/LoginPage';
import { AppShell } from './features/shell/AppShell';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { CheckoutPage } from './features/checkout/CheckoutPage';
import { MenuPage } from './features/menu-mgmt/MenuPage';
import { SettingsPage } from './features/settings/SettingsPage';
import { InventoryPage } from './features/inventory/InventoryPage';
import { ReportsPage } from './features/reports/ReportsPage';
import { CustomersPage } from './features/customers/CustomersPage';
import { UsersPage } from './features/users/UsersPage';
import { useSessionStore } from './stores/sessionStore';
import { hasCapability, type Capability } from '@cheeseoclock/shared-types';

function requireAuth() {
  const session = useSessionStore.getState().user;
  if (!session) throw redirect('/login');
  return session;
}

function requireCapability(cap: Capability) {
  return () => {
    const user = requireAuth();
    if (!hasCapability(user.role, cap)) throw redirect('/');
    return user;
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
      { path: 'checkout', element: <CheckoutPage />, loader: requireCapability('order.create') },
      { path: 'menu', element: <MenuPage />, loader: requireCapability('menu.manage') },
      {
        path: 'inventory',
        element: <InventoryPage />,
        loader: requireCapability('menu.manage'),
      },
      {
        path: 'reports',
        element: <ReportsPage />,
        loader: requireCapability('report.view'),
      },
      {
        path: 'customers',
        element: <CustomersPage />,
        loader: requireCapability('order.create'),
      },
      {
        path: 'users',
        element: <UsersPage />,
        loader: requireCapability('users.manage'),
      },
      {
        path: 'settings',
        element: <SettingsPage />,
        loader: requireCapability('settings.manage'),
      },
    ],
  },
  // Catch-all: any stale or unknown hash → bounce to dashboard.
  { path: '*', element: <Navigate to="/" replace /> },
]);
