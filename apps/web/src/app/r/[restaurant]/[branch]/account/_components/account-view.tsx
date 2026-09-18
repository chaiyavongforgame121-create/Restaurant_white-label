'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import {
  Award, Check, ChevronRight, LogOut, MapPin, Receipt, Settings,
  ShieldCheck, Sparkles,
} from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { getLoyaltyProgram, getMyLoyalty, signOut } from '@favornoms/database/queries';
import { DEFAULT_UI_LOCALE, intlLocaleFor, isUiLocale } from '@favornoms/shared';

type LoyaltyBalance = NonNullable<Awaited<ReturnType<typeof getMyLoyalty>>>;
import { Badge, Button, Card } from '@favornoms/ui';
import { useAuth } from '@/components/auth/use-auth';
import { InstallAppButton } from '@/components/install-app-button';

// Phone-only diners are backed by a synthetic auth email they never chose. It is an
// implementation detail of OTP-less sign-in and must never reach the screen.
const SYNTHETIC_EMAIL_SUFFIX = '@customer.favornoms.local';

/**
 * The restaurant's name for a tier, falling back to the enum key until the programme loads.
 * Deliberately not translated: once loaded, an untouched tier comes back from the server with the
 * same English name, and the two must not disagree.
 */
function tierName(key: string, names: Record<string, string>): string {
  return names[key] ?? key.replace(/^./, (c) => c.toUpperCase());
}

export function AccountView({
  base,
  brandName,
  branchId,
}: {
  base: string;
  brandName: string;
  /** Scopes the profile read: the diner's record here is this branch's own row. */
  branchId: string;
}) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const t = useTranslations('account');
  const rawLocale = useLocale();
  const numberLocale = intlLocaleFor(isUiLocale(rawLocale) ? rawLocale : DEFAULT_UI_LOCALE);
  const [loyalty, setLoyalty] = React.useState<LoyaltyBalance | null>(null);
  // Tiers carry the merchant's own names now, so this card asks for them rather than
  // capitalising the enum key and showing a diner "Bronze" for a rung the restaurant
  // renamed — the loyalty page beside it would say something else.
  const [tierNames, setTierNames] = React.useState<Record<string, string>>({});
  // The `customers` row is the single source of truth for the diner's name and phone —
  // the same row settings writes and checkout prefills from. This card used to render
  // auth `user_metadata` instead, which is written once at signup and never updated
  // (nothing in the app calls auth.updateUser), so a diner who corrected their name in
  // settings saw the old one here forever. That is the "it cannot be changed" report.
  const [profile, setProfile] = React.useState<{ full_name: string | null; phone: string | null } | null>(null);
  const [profileLoaded, setProfileLoaded] = React.useState(false);
  const [googleEmail, setGoogleEmail] = React.useState<string | null>(null);
  const [identitiesLoaded, setIdentitiesLoaded] = React.useState(false);
  const [linking, setLinking] = React.useState(false);
  const [linkError, setLinkError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!user) return;
    const supabase = getBrowserClient();
    void getMyLoyalty(supabase, branchId).then(setLoyalty);
    void getLoyaltyProgram(supabase, branchId).then((p) => {
      // A failed read leaves the names empty, and tierName() shows the enum key instead.
      if (p) setTierNames(Object.fromEntries(p.tiers.map((t) => [t.key, t.label])));
    });
  }, [user, branchId]);

  // Deliberately a plain scoped SELECT and not resolveMyCustomerId(): that helper calls
  // get_or_create_my_customer, a SECURITY DEFINER routine whose adoption step matches on
  // an unverified phone. Fine as a deliberate act at checkout or settings; not something
  // to fire on a passive page view that also happens to be the post-sign-in landing page.
  // customers is UNIQUE on (branch_id, user_id): each branch keeps its own record of the diner,
  // so this resolves the same single row every other surface of THIS branch uses. No row yet
  // (first visit here) leaves the profile empty until settings or checkout creates it.
  React.useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const supabase = getBrowserClient();
    void (async () => {
      const { data } = await supabase
        .from('customers')
        .select('full_name, phone')
        .eq('user_id', user.id)
        .eq('branch_id', branchId)
        .maybeSingle();
      if (cancelled) return;
      if (data) setProfile({ full_name: data.full_name, phone: data.phone });
      setProfileLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, branchId]);

  React.useEffect(() => {
    if (!user) return;
    const supabase = getBrowserClient();
    // null = not linked; '' = linked but Google didn't hand back an address.
    void supabase.auth.getUserIdentities().then(({ data }) => {
      const google = data?.identities?.find((i) => i.provider === 'google');
      if (google) setGoogleEmail((google.identity_data?.email as string | undefined) ?? '');
      setIdentitiesLoaded(true);
    });
  }, [user]);

  // A real email only exists for magic-link and Google diners; phone-only ones get the
  // synthetic address above, which we treat as "no email".
  const realEmail = user?.email && !user.email.endsWith(SYNTHETIC_EMAIL_SUFFIX) ? user.email : null;
  // Never falls back to user_metadata.phone. With no OTP that value is free text the
  // diner asserted at signup, and a NULL phone on the row is often get_or_create_my_customer
  // deliberately REFUSING to hand over a number another account already claimed — rendering
  // the asserted one here would undo that at the display layer. user.phone is the real
  // verified auth column, so it is the only acceptable fallback.
  const displayPhone = profile?.phone?.trim() || user?.phone || null;
  // A display name is not an identity key, so the signup metadata is a fine last resort.
  const displayName =
    profile?.full_name?.trim() || (user?.user_metadata?.full_name as string | undefined)?.trim() || null;
  const avatarInitial = (
    displayName?.[0] ?? displayPhone?.slice(-2) ?? realEmail?.[0] ?? 'G'
  ).toUpperCase();

  const handleSignOut = async () => {
    const supabase = getBrowserClient();
    await signOut(supabase);
    router.refresh();
  };

  const linkGoogle = async () => {
    setLinkError(null);
    setLinking(true);
    const supabase = getBrowserClient();
    const { error } = await supabase.auth.linkIdentity({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(window.location.pathname)}`,
      },
    });
    // On success the browser is already navigating to Google — leave the spinner up.
    if (error) {
      setLinking(false);
      // The auth server's own message is English and technical: keep it for the console and
      // name the one case a diner can act on.
      console.error('[account] linking Google failed', error);
      setLinkError(
        error.code === 'identity_already_exists' ? t('home.googleAlreadyLinked') : t('home.linkGoogleFailed'),
      );
    }
  };

  return (
    <div className="container max-w-2xl space-y-5 pt-4">
      <Card className="overflow-hidden p-0">
        <div className="bg-gradient-warm p-6 text-white">
          <div className="flex items-center gap-4">
            <div className="grid h-16 w-16 place-items-center rounded-full bg-white/25 font-display text-2xl font-bold backdrop-blur">
              {avatarInitial}
            </div>
            <div>
              {/* Wait for the profile too, not just auth — otherwise the card paints the
                  stale signup metadata for a beat before correcting itself, which looks
                  exactly like the bug this is fixing. */}
              {loading || (user && !profileLoaded) ? (
                <p className="text-sm text-white/80">{t('loading')}</p>
              ) : user ? (
                <>
                  <p className="text-sm text-white/80">{displayPhone ?? realEmail}</p>
                  <h1 className="font-display text-2xl font-bold">
                    {displayName ?? t('home.welcomeBack')}
                  </h1>
                  <Badge variant="solid" className="mt-1 bg-white/25 text-white">
                    <Sparkles className="h-3 w-3" /> {t('home.memberAt', { brandName })}
                  </Badge>
                </>
              ) : (
                <>
                  <p className="text-sm text-white/80">{t('home.welcomeTo', { brandName })}</p>
                  <h1 className="font-display text-2xl font-bold">{t('home.signInToEarn')}</h1>
                  <Link
                    href={`${base}/sign-in?next=${encodeURIComponent(`${base}/account`)}`}
                    className="mt-2 inline-block"
                  >
                    <Button variant="glass" size="sm">
                      {t('signIn')}
                    </Button>
                  </Link>
                </>
              )}
            </div>
          </div>
        </div>
        {user && (
          <div className="grid grid-cols-3 divide-x divide-border text-center">
            {[
              {
                key: 'points',
                label: t('home.statPoints'),
                value: (loyalty?.points_balance ?? 0).toLocaleString(numberLocale),
              },
              { key: 'tier', label: t('home.statTier'), value: tierName(loyalty?.tier ?? 'bronze', tierNames) },
              {
                key: 'lifetime',
                label: t('home.statLifetime'),
                value: (loyalty?.lifetime_earned ?? 0).toLocaleString(numberLocale),
              },
            ].map((stat) => (
              <div key={stat.key} className="py-4">
                <p className="font-display text-xl font-bold text-primary">{stat.value}</p>
                <p className="text-xs text-muted-foreground">{stat.label}</p>
              </div>
            ))}
          </div>
        )}
      </Card>

      <ul className="space-y-2">
        <Row icon={Receipt} label={t('sections.orderHistory')} href={`${base}/orders`} />
        <Row
          icon={MapPin}
          label={t('sections.addresses')}
          meta={t('home.addressesMeta')}
          href={`${base}/account/addresses`}
        />
        <Row
          icon={Award}
          label={t('sections.loyalty')}
          meta={
            loyalty
              ? t('home.loyaltyMeta', { tier: tierName(loyalty.tier, tierNames), points: loyalty.points_balance })
              : t('home.loyaltyMeta', { tier: tierName('bronze', tierNames), points: 0 })
          }
          href={`${base}/account/loyalty`}
        />
        {user && identitiesLoaded && (
          <li>
            <div className="flex w-full items-center gap-3 rounded-2xl border border-border/60 bg-card p-4 text-left">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                <ShieldCheck className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{t('home.googleAccount')}</p>
                {googleEmail !== null ? (
                  <p className="flex items-center gap-1 truncate text-xs text-success">
                    <Check className="h-3 w-3 shrink-0" />
                    {googleEmail || t('home.googleLinked')}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">{t('home.googleLinkHint')}</p>
                )}
                {linkError && <p className="mt-1 text-xs text-danger">{linkError}</p>}
              </div>
              {googleEmail === null && (
                <Button variant="outline" size="sm" onClick={linkGoogle} loading={linking}>
                  {t('home.linkGoogle')}
                </Button>
              )}
            </div>
          </li>
        )}
        <Row icon={Settings} label={t('sections.settings')} href={`${base}/account/settings`} />
        {/* Renders its own <li>, or nothing when already installed / no install path. */}
        <InstallAppButton />
      </ul>

      {user && (
        <button
          onClick={handleSignOut}
          className="focus-ring flex w-full items-center gap-3 rounded-2xl border border-border/60 bg-card p-4 text-left text-danger transition-shadow hover:shadow-soft"
        >
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-danger/10 text-danger">
            <LogOut className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <p className="font-semibold">{t('home.signOut')}</p>
          </div>
        </button>
      )}
    </div>
  );
}

function Row({
  icon: Icon,
  label,
  meta,
  href,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  meta?: string;
  href?: string;
}) {
  const inner = (
    <div className="focus-ring flex w-full items-center gap-3 rounded-2xl border border-border/60 bg-card p-4 text-left transition-shadow hover:shadow-soft">
      <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">
        <Icon className="h-5 w-5" />
      </div>
      <div className="flex-1">
        <p className="font-semibold">{label}</p>
        {meta && <p className="text-xs text-muted-foreground">{meta}</p>}
      </div>
      <ChevronRight className="h-5 w-5 text-muted-foreground" />
    </div>
  );
  return <li>{href ? <Link href={href}>{inner}</Link> : <button className="w-full">{inner}</button>}</li>;
}
