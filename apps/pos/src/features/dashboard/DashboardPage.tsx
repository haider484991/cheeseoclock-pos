import { Card } from '@cheeseoclock/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useSessionStore } from '../../stores/sessionStore';
import { ipc } from '../../ipc/client';
import { FbrStatusCard } from './FbrStatusCard';
import { SyncStatusCard } from './SyncStatusCard';
import { BackupHealthBanner } from './BackupHealthBanner';
import { MenuDeployBanner } from './MenuDeployBanner';
import { OwnerWeekCard } from './OwnerWeekCard';
import { SettingsOverview } from '../settings/SettingsPage';
import {
  ShoppingCart,
  UtensilsCrossed,
  BarChart3,
  Settings,
  Users,
  Boxes,
  Contact,
  Receipt,
  Calculator,
  type LucideIcon,
} from 'lucide-react';
import { presetRecipeCalculator } from '../costing/deepLinks';

interface TileSpec {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  to: string;
  /** Tailwind gradient classes for the icon background. */
  tone: string;
  /** Set the screen up before going there (a tab of a page). */
  preset?: () => void;
}

export function DashboardPage() {
  const user = useSessionStore((s) => s.user);
  const can = useSessionStore((s) => s.can);
  const navigate = useNavigate();

  const { data: deviceInfo } = useQuery({
    queryKey: ['system', 'deviceInfo'],
    queryFn: () => ipc.system.getDeviceInfo(),
  });

  const { data: appInfo } = useQuery({
    queryKey: ['system', 'version'],
    queryFn: () => ipc.system.getVersion(),
  });

  const tiles: Array<{ tile: TileSpec; allowed: boolean }> = [
    {
      allowed: can('order.create'),
      tile: {
        icon: ShoppingCart,
        title: 'New order',
        subtitle: 'Open the checkout',
        to: '/checkout',
        tone: 'from-emerald-400 to-emerald-600',
      },
    },
    {
      allowed: can('menu.manage'),
      tile: {
        icon: UtensilsCrossed,
        title: 'Menu',
        subtitle: 'Items, prices, add-ons',
        to: '/menu',
        tone: 'from-amber-400 to-orange-500',
      },
    },
    {
      allowed: can('menu.manage'),
      tile: {
        icon: Boxes,
        title: 'Inventory',
        subtitle: 'Stock, recipes, purchases',
        to: '/inventory',
        tone: 'from-fuchsia-400 to-pink-500',
      },
    },
    {
      // Owner, 2026-09-27: "make it more easy if a manager wants to see how
      // much ingredients a recipe needs". Inventory → Recipe calculator.
      allowed: can('menu.manage'),
      tile: {
        icon: Calculator,
        title: 'Recipe calculator',
        subtitle: 'How much for 10 pizzas?',
        to: '/inventory',
        tone: 'from-amber-400 to-yellow-500',
        preset: () => presetRecipeCalculator(),
      },
    },
    {
      // The counter's window on this shift; managers have Order History.
      allowed: can('order.create') && !can('order.history'),
      tile: {
        icon: Receipt,
        title: 'Recent orders',
        subtitle: 'This shift at this till',
        to: '/orders/recent',
        tone: 'from-sky-400 to-blue-500',
      },
    },
    {
      allowed: can('customers.manage'),
      tile: {
        icon: Contact,
        title: 'Customers',
        subtitle: 'Phones, addresses, history',
        to: '/customers',
        tone: 'from-sky-400 to-blue-500',
      },
    },
    {
      allowed: can('report.view'),
      tile: {
        icon: BarChart3,
        title: 'Reports',
        subtitle: 'Sales, best sellers, costs',
        to: '/reports',
        tone: 'from-violet-400 to-purple-600',
      },
    },
    {
      allowed: can('users.manage'),
      tile: {
        icon: Users,
        title: 'Users',
        subtitle: 'Staff logins, PINs and passwords',
        to: '/users',
        tone: 'from-rose-400 to-red-500',
      },
    },
    {
      allowed: can('settings.manage'),
      tile: {
        icon: Settings,
        title: 'Settings',
        subtitle: 'Shop, printers, backups',
        to: '/settings',
        tone: 'from-stone-400 to-stone-600',
      },
    },
  ];

  return (
    <div className="mx-auto max-w-7xl space-y-8">
      <header className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-widest text-amber-600 dark:text-amber-400">
          {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
        </p>
        <h1 className="text-4xl font-bold tracking-tight">
          Welcome back,{' '}
          <span className="text-amber-600 dark:text-amber-400">
            {user?.fullName?.split(' ')[0]}
          </span>
        </h1>
        <p className="text-stone-500 dark:text-stone-400">What would you like to do?</p>
      </header>

      <section>
        <SectionTitle>Quick actions</SectionTitle>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {tiles
            .filter((t) => t.allowed)
            .map(({ tile }) => (
              // By title: two tiles go to /inventory.
              <ActionTile key={tile.title} {...tile} />
            ))}
        </div>
      </section>

      {/* The owner's week (costing spec Phase 7): report.view; hidden until tapped. */}
      {can('report.view') && (
        <section>
          <SectionTitle>How the week is going</SectionTitle>
          <OwnerWeekCard />
        </section>
      )}

      {can('settings.manage') && (
        <section className="space-y-4">
          <SectionTitle>Shop status</SectionTitle>
          <BackupHealthBanner />
          {/* A menu file from the costing PC that needs the owner (refused, given up, too new, stopped halfway). */}
          <MenuDeployBanner />
          <SettingsOverview onSelect={(tab) => navigate(`/settings?tab=${tab}`)} />
          {/* Each card shows itself only while that feature is switched on. */}
          <div className="grid grid-cols-1 gap-4 empty:hidden lg:grid-cols-2">
            <FbrStatusCard />
            <SyncStatusCard />
          </div>
        </section>
      )}

      <footer className="border-t border-stone-200 pt-4 text-xs text-stone-400 dark:border-stone-800">
        This till: <span className="font-medium text-stone-500">{deviceInfo?.displayName ?? '…'}</span>
        {' · '}version {appInfo?.version ?? '…'}
        {appInfo?.isDev ? ' · development build' : ''}
        {can('printer.manage') && (
          <>
            {' · '}
            <Link to="/settings?tab=about" className="hover:underline">
              About this till
            </Link>
          </>
        )}
      </footer>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-stone-500">
      <span className="inline-block h-px w-6 bg-stone-300 dark:bg-stone-700" />
      {children}
    </div>
  );
}

function ActionTile({ icon: Icon, title, subtitle, to, tone, preset }: TileSpec) {
  return (
    <Link to={to} onClick={preset} className="block group">
      <Card interactive className="h-full">
        <div className="flex items-start gap-3">
          <div
            className={`flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br ${tone} text-white shadow-soft transition-transform group-hover:scale-110`}
          >
            <Icon className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-semibold tracking-tight text-stone-900 dark:text-stone-100">
              {title}
            </div>
            <div className="text-xs text-stone-500">{subtitle}</div>
          </div>
        </div>
      </Card>
    </Link>
  );
}
