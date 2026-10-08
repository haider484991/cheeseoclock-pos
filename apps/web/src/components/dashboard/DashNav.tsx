'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ComponentType, SVGProps } from 'react';
import {
  IconLive,
  IconMenu,
  IconMoney,
  IconMore,
  IconOrders,
  IconReports,
  IconStock,
  IconUser,
} from './icons';
import { cx } from './ui';

/**
 * Where to go: a tab bar along the bottom of a phone (five places, the most
 * used first) and a side list on a wider screen (every place). What a login
 * may not open is not offered at all (the pages refuse it too).
 */

export type NavKey =
  | 'live'
  | 'orders'
  | 'reports'
  | 'money'
  | 'stock'
  | 'menu'
  | 'account'
  | 'more';

interface Item {
  key: NavKey;
  href: string;
  label: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
}

const ITEMS: Record<NavKey, Item> = {
  live: { key: 'live', href: '/dashboard', label: 'Live', Icon: IconLive },
  orders: { key: 'orders', href: '/dashboard/orders', label: 'Orders', Icon: IconOrders },
  reports: { key: 'reports', href: '/dashboard/reports', label: 'Reports', Icon: IconReports },
  money: { key: 'money', href: '/dashboard/money', label: 'Shifts & cash', Icon: IconMoney },
  stock: { key: 'stock', href: '/dashboard/stock', label: 'Stock', Icon: IconStock },
  menu: { key: 'menu', href: '/dashboard/menu', label: 'Menu', Icon: IconMenu },
  account: { key: 'account', href: '/dashboard/account', label: 'Account', Icon: IconUser },
  more: { key: 'more', href: '/dashboard/more', label: 'More', Icon: IconMore },
};

function activeKey(path: string): NavKey {
  const seg = path.split('/')[2] ?? '';
  if (seg === '') return 'live';
  return (Object.keys(ITEMS) as NavKey[]).includes(seg as NavKey) ? (seg as NavKey) : 'live';
}

export function DashNav({ reports, variant }: { reports: boolean; variant: 'side' | 'bottom' }) {
  const path = usePathname() ?? '/dashboard';
  const current = activeKey(path);
  const side: NavKey[] = reports
    ? ['live', 'orders', 'reports', 'money', 'stock', 'menu', 'account']
    : ['live', 'orders', 'money', 'stock', 'menu', 'account'];
  const bottom: NavKey[] = reports
    ? ['live', 'orders', 'reports', 'money', 'more']
    : ['live', 'orders', 'money', 'stock', 'more'];
  const inMore = !bottom.includes(current);

  if (variant === 'side') {
    return (
      <nav aria-label="Dashboard">
        <ul className="space-y-1">
          {side.map((k) => {
            const { href, label, Icon } = ITEMS[k];
            const on = current === k;
            return (
              <li key={k}>
                <Link
                  href={href}
                  aria-current={on ? 'page' : undefined}
                  className={cx(
                    'flex items-center gap-3 rounded-xl px-3 py-2.5 text-[0.95rem] font-medium transition-colors',
                    on
                      ? 'bg-dash-ink text-dash-page'
                      : 'text-dash-soft hover:bg-dash-surface hover:text-dash-ink',
                  )}
                >
                  <Icon className={cx('h-5 w-5', on ? 'text-dash-accent' : '')} />
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    );
  }
  return (
    <nav
      aria-label="Dashboard"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-dash-line bg-dash-surface lg:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <ul className="mx-auto flex max-w-xl">
        {bottom.map((k) => {
          const { href, label, Icon } = ITEMS[k];
          const on = k === 'more' ? inMore : current === k;
          return (
            <li key={k} className="flex-1">
              <Link
                href={href}
                aria-current={on ? 'page' : undefined}
                className={cx(
                  'flex flex-col items-center gap-0.5 px-1 pb-2 pt-2.5 text-[11px] font-medium',
                  on ? 'text-dash-ink' : 'text-dash-muted',
                )}
              >
                <span
                  className={cx(
                    'flex h-7 w-12 items-center justify-center rounded-full',
                    on && 'bg-dash-accent-soft',
                  )}
                >
                  <Icon className={cx('h-[22px] w-[22px]', on && 'text-dash-ink')} />
                </span>
                <span className="truncate">{k === 'money' ? 'Cash' : label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
