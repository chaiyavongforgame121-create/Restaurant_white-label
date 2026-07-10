'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@favornoms/ui';

const TABS = [
  { href: '/platform', label: 'Dashboard' },
  { href: '/platform/reports', label: 'Reports' },
  { href: '/platform/plans', label: 'Plans' },
  { href: '/platform/settings', label: 'Settings' },
];

export function PlatformNav() {
  const pathname = usePathname();
  return (
    <nav className="mb-6 flex gap-1 border-b border-border">
      {TABS.map((t) => {
        const active =
          t.href === '/platform' ? pathname === '/platform' : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={cn(
              '-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
              active
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function PlatformAccessDenied() {
  return (
    <div className="grid min-h-dynamic-screen place-items-center p-8 text-center">
      <div>
        <h1 className="font-display text-3xl font-bold">Access denied</h1>
        <p className="mt-2 text-muted-foreground">Platform admin only.</p>
      </div>
    </div>
  );
}
