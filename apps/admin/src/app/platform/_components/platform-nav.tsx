'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { cn } from '@favornoms/ui';
import { SignOutIconButton } from '@/components/sign-out';
import { usePendingRequestCount } from './pending-requests';

const TABS = [
  { href: '/platform', key: 'dashboard' },
  { href: '/platform/reports', key: 'reports' },
  { href: '/platform/subscriptions', key: 'subscriptions', exact: true },
  { href: '/platform/subscriptions/requests', key: 'requests', pendingBadge: true },
  { href: '/platform/plans', key: 'catalog' },
  { href: '/platform/discounts', key: 'discounts' },
  { href: '/platform/settings', key: 'settings' },
] as const;

export function PlatformNav() {
  const t = useTranslations('platform.nav');
  const pathname = usePathname();
  const pending = usePendingRequestCount();
  return (
    // One scrolling row rather than flex-wrap: the tabs wrapped to three ragged
    // lines on a phone, and the border-b then cut through the middle of them.
    // The console is where a platform admin lands after sign-in and it has no sidebar, so the way
    // out sits at the end of the tab row.
    <div className="mb-6 flex items-center gap-2">
      <nav
        aria-label={t('ariaLabel')}
        className="flex min-w-0 flex-1 gap-1 overflow-x-auto border-b border-border [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {TABS.map((tab) => {
          // Subscriptions is a prefix of Requests, so it has to match exactly or
          // both tabs light up on the requests page.
          const active =
            tab.href === '/platform' || ('exact' in tab && tab.exact)
              ? pathname === tab.href
              : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
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
              {t(tab.key)}
              {'pendingBadge' in tab && tab.pendingBadge && pending > 0 && (
                <span className="ml-1.5 inline-flex min-w-5 items-center justify-center rounded-full bg-danger px-1.5 text-[11px] font-semibold leading-5 text-white tabular-nums">
                  {t.rich('pendingBadge', {
                    count: pending,
                    sr: (chunks) => <span className="sr-only">{chunks}</span>,
                  })}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
      <SignOutIconButton className="border border-border bg-card text-danger hover:bg-danger/10" />
    </div>
  );
}

export function PlatformAccessDenied() {
  const t = useTranslations('platform.accessDenied');
  return (
    <div className="grid min-h-dynamic-screen place-items-center p-8 text-center">
      <div>
        <h1 className="font-display text-3xl font-bold">{t('title')}</h1>
        <p className="mt-2 text-muted-foreground">{t('body')}</p>
      </div>
    </div>
  );
}
