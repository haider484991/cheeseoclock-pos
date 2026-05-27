import { NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@cheeseoclock/ui';
import { useSessionStore } from '../../stores/sessionStore';
import { ipc } from '../../ipc/client';
import type { Capability } from '@cheeseoclock/shared-types';
import {
  LayoutDashboard,
  ShoppingCart,
  UtensilsCrossed,
  Boxes,
  BarChart3,
  Users,
  Contact,
  Settings,
  Pizza,
  ClipboardList,
  Bike,
  History,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  capability?: Capability;
  comingSoon?: boolean;
  /** Key for a live count badge (e.g. 'liveOrders'). */
  badgeKey?: 'liveOrders';
}

const ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/checkout', label: 'Checkout', icon: ShoppingCart, capability: 'order.create' },
  { to: '/orders', label: 'Live Orders', icon: ClipboardList, capability: 'order.create', badgeKey: 'liveOrders' },
  { to: '/orders/history', label: 'Order History', icon: History, capability: 'order.create' },
  { to: '/riders', label: 'Riders', icon: Bike, capability: 'order.create' },
  { to: '/menu', label: 'Menu', icon: UtensilsCrossed, capability: 'menu.manage' },
  { to: '/inventory', label: 'Inventory', icon: Boxes, capability: 'menu.manage' },
  { to: '/customers', label: 'Customers', icon: Contact, capability: 'order.create' },
  { to: '/reports', label: 'Reports', icon: BarChart3, capability: 'report.view' },
  { to: '/users', label: 'Users', icon: Users, capability: 'users.manage' },
  { to: '/settings', label: 'Settings', icon: Settings, capability: 'settings.manage' },
];

export function Sidebar() {
  const can = useSessionStore((s) => s.can);
  const cfgQ = useQuery({
    queryKey: ['printer', 'config'],
    queryFn: () => ipc.printer.getConfig(),
    staleTime: 60_000,
  });
  // Live count of active orders for the sidebar badge. Refetches every 15s
  // so it's roughly current without thrashing the DB.
  const activeQ = useQuery({
    queryKey: ['orders', 'active', 'sidebar-count'],
    queryFn: () => ipc.orders.listActive(),
    refetchInterval: 15_000,
    enabled: can('order.create'),
  });
  const liveCount = activeQ.data?.length ?? 0;
  const logoUrl = cfgQ.data?.branding.logoUrl;
  const storeName = cfgQ.data?.branding.storeName ?? 'CheeseOclock';

  return (
    <aside className="flex w-60 flex-col border-r border-stone-200/70 bg-white/70 backdrop-blur-md dark:border-stone-800/70 dark:bg-stone-900/70">
      <div className="flex items-center gap-3 px-5 py-5">
        <div className="relative flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br from-amber-400 to-amber-600 text-white shadow-lift">
          {logoUrl ? (
            /* eslint-disable-next-line jsx-a11y/alt-text */
            <img src={logoUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <Pizza className="h-5 w-5" />
          )}
          <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-white dark:ring-stone-900" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-bold tracking-tight">{storeName}</div>
          <div className="text-[10px] uppercase tracking-widest text-stone-500">
            Point of Sale
          </div>
        </div>
      </div>

      <nav className="flex-1 space-y-0.5 px-3 pb-3">
        {ITEMS.map((item) => {
          const allowed = !item.capability || can(item.capability);
          if (!allowed) return null;
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                cn(
                  'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all',
                  isActive
                    ? 'bg-gradient-to-r from-amber-500/15 to-amber-500/5 text-amber-900 shadow-soft-sm dark:from-amber-400/15 dark:to-amber-400/0 dark:text-amber-100'
                    : 'text-stone-600 hover:bg-stone-100 hover:text-stone-900 dark:text-stone-400 dark:hover:bg-stone-800/70 dark:hover:text-stone-100',
                  item.comingSoon && 'opacity-50',
                )
              }
              onClick={(e) => item.comingSoon && e.preventDefault()}
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <span
                      className="absolute left-0 top-1/2 h-6 -translate-y-1/2 rounded-r-full bg-amber-500"
                      style={{ width: 3 }}
                    />
                  )}
                  <Icon
                    className={cn(
                      'h-4 w-4 transition-transform group-hover:scale-110',
                      isActive && 'text-amber-600 dark:text-amber-400',
                    )}
                  />
                  <span className="flex-1">{item.label}</span>
                  {item.badgeKey === 'liveOrders' && liveCount > 0 && (
                    <span
                      className={cn(
                        'flex h-5 min-w-[1.25rem] items-center justify-center rounded-full px-1.5 text-[10px] font-bold',
                        'bg-amber-500 text-white shadow-soft-sm',
                      )}
                      title={`${liveCount} active order${liveCount === 1 ? '' : 's'}`}
                    >
                      {liveCount}
                    </span>
                  )}
                  {item.comingSoon && (
                    <span className="rounded-md bg-stone-200 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-stone-600 dark:bg-stone-700 dark:text-stone-300">
                      soon
                    </span>
                  )}
                </>
              )}
            </NavLink>
          );
        })}
      </nav>

      <SidebarFooter />
    </aside>
  );
}

function SidebarFooter() {
  const versionQ = useQuery({
    queryKey: ['system', 'version'],
    queryFn: () => ipc.system.getVersion(),
    staleTime: Infinity,
  });
  return (
    <div className="border-t border-stone-200/70 px-5 py-3 text-[10px] uppercase tracking-widest text-stone-400 dark:border-stone-800/70">
      Built for restaurants · v{versionQ.data?.version ?? '…'}
    </div>
  );
}
