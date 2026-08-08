'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@favornoms/ui';

const TABS = [
  { href: '/platform', label: 'Dashboard' },
  { href: '/platform/reports', label: 'Reports' },
  { href: '/platform/subscriptions', label: 'Subscriptions', exact: true },
  { href: '/platform/subscriptions/requests', label: 'Requests' },
  { href: '/platform/plans', label: 'Catalog' },
  { href: '/platform/settings', label: 'Settings' },
];

export function PlatformNav() {
  const pathname = usePathname();
  return (
    // One scrolling row rather than flex-wrap: six tabs wrapped to three ragged
    // lines on a phone, and the border-b then cut through the middle of them.
    <nav
      aria-label="Platform sections"
      className="mb-6 flex gap-1 overflow-x-auto border-b border-border [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {TABS.map((t) => {
        // Subscriptions is a prefix of Requests, so it has to match exactly or
        // both tabs light up on the requests page.
        const active =
          t.href === '/platform' || t.exact
            ? pathname === t.href
            : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            // The orange underline is the ONLY signal of the current tab, so
            // without aria-current a screen reader hears six identical links.
            aria-current={active ? 'page' : undefined}
            className={cn(
              '-mb-px shrink-0 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
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
