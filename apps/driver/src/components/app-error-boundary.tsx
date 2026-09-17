'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';

interface AppErrorBoundaryProps {
  children: React.ReactNode;
}

interface AppErrorBoundaryState {
  failed: boolean;
}

/**
 * Catches any render-time exception inside /app/* and gives the rider a way out.
 *
 * Installed, the app has no address bar and — on iOS — no back chrome, so a null deref on the
 * active-delivery screen or a bad deep link used to leave a rider staring at Next's bare
 * "Application error: a client-side exception has occurred" with force-quitting as the only
 * move. Reset first, since most of these are transient; the home link is a full navigation
 * rather than a router push because the router lives in the tree that just broke.
 */
export class AppErrorBoundary extends React.Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  constructor(props: AppErrorBoundaryProps) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;

    return <AppErrorFallback onRetry={() => this.setState({ failed: false })} />;
  }
}

/** A function component so the fallback can read translations (a class cannot use hooks). */
function AppErrorFallback({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('shell.crash');
  const tCommon = useTranslations('common');

  return (
    <div className="min-h-dynamic-screen bg-background grid place-items-center px-6 text-center">
      <div>
        <p className="font-display text-lg font-semibold">{t('title')}</p>
        <p className="text-muted-foreground mt-1 text-sm">{t('body')}</p>
        <button
          onClick={onRetry}
          className="focus-ring bg-primary text-primary-foreground mt-5 inline-flex h-12 items-center rounded-2xl px-5 text-sm font-semibold"
        >
          {tCommon('tryAgain')}
        </button>
        <button
          onClick={() => window.location.assign('/app/home')}
          className="focus-ring text-muted-foreground mt-3 block h-auto min-h-0 w-full text-xs underline"
        >
          {t('backHome')}
        </button>
      </div>
    </div>
  );
}
