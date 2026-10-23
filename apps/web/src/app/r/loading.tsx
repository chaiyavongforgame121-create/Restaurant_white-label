import { useTranslations } from 'next-intl';

/**
 * The loading boundary for every storefront, and the reason app/loading.tsx (the FavorNoms splash)
 * never shows on one.
 *
 * A loading file wraps the segments BELOW its own folder, so [branch]/loading.tsx cannot cover the
 * [branch] layout itself — and that layout awaits the tenant. Without this file the nearest
 * boundary while it waited would be the root one: a diner opening a restaurant's link, or the
 * merchant's own domain (the middleware rewrites it into /r/), would watch the platform's logo
 * before the restaurant's menu. This sits above [restaurant]/[branch], so it is what they see
 * instead.
 *
 * Neutral on purpose: it renders outside the branch's ThemeProvider, so `primary` here would be the
 * platform's orange, not the restaurant's colour. The same two rules as [branch]/loading.tsx —
 * promise nothing about the page's shape, and stay invisible for the first 400 ms so a quick load
 * shows no interstitial at all.
 */
export default function StorefrontLoading() {
  const t = useTranslations('common');
  return (
    <div
      className="grid min-h-dynamic-screen animate-fade-in place-items-center"
      style={{ animationDelay: '400ms', animationFillMode: 'both' }}
    >
      <span
        role="status"
        aria-label={t('loading')}
        className="h-10 w-10 animate-spin rounded-full border-4 border-muted border-t-muted-foreground"
      />
    </div>
  );
}
