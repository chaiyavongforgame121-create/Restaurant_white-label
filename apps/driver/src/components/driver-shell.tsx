'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion } from 'framer-motion';
import { History, Home, Map as MapIcon, Navigation, User, Wallet } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@favornoms/ui';
import { useDelivery } from './delivery-provider';

export function DriverShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const t = useTranslations('nav');
  const { active, offered } = useDelivery();
  const badge = offered ? '!' : active ? '•' : undefined;

  const tabs = [
    { href: '/app/home', label: t('home'), icon: Home },
    { href: '/app/active', label: t('active'), icon: Navigation, badge },
    { href: '/app/map', label: 'Map', icon: MapIcon },
    { href: '/app/history', label: t('history'), icon: History },
    { href: '/app/earnings', label: t('earnings'), icon: Wallet },
    { href: '/app/profile', label: t('profile'), icon: User },
  ];

  return (
    <div className="relative flex min-h-dynamic-screen flex-col bg-background">
      <main className="flex-1 pb-24">{children}</main>

      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border/60 bg-card pb-safe"
      >
        <ul className="grid h-[68px] grid-cols-6">
          {tabs.map((tab) => {
            const active = pathname?.startsWith(tab.href) ?? false;
            const Icon = tab.icon;
            return (
              <li key={tab.href} className="flex">
                <Link
                  href={tab.href}
                  className={cn(
                    'focus-ring relative flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors',
                    active ? 'text-primary' : 'text-muted-foreground',
                  )}
                >
                  {active && (
                    <motion.span
                      layoutId="driver-nav-pill"
                      className="absolute inset-x-4 -top-px h-1 rounded-full bg-primary"
                      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                    />
                  )}
                  <span className="relative">
                    <Icon className="h-6 w-6" aria-hidden />
                    {tab.badge && (
                      <span className="absolute -right-2 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-danger text-[10px] font-bold text-white shadow-soft">
                        {tab.badge}
                      </span>
                    )}
                  </span>
                  {tab.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
