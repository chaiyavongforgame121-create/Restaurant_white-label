'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Award, ChevronRight, LogOut, MapPin, Receipt, Settings,
  Sparkles,
} from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { getMyLoyalty, signOut } from '@favornoms/database/queries';

type LoyaltyBalance = NonNullable<Awaited<ReturnType<typeof getMyLoyalty>>>;
import { Badge, Button, Card } from '@favornoms/ui';
import { useAuth } from '@/components/auth/use-auth';

export function AccountView({
  base,
  brandName,
  branchId,
}: {
  base: string;
  brandName: string;
  branchId: string;
}) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [loyalty, setLoyalty] = React.useState<LoyaltyBalance | null>(null);

  React.useEffect(() => {
    if (!user) return;
    const supabase = getBrowserClient();
    void getMyLoyalty(supabase, branchId).then(setLoyalty);
  }, [user, branchId]);

  const handleSignOut = async () => {
    const supabase = getBrowserClient();
    await signOut(supabase);
    router.refresh();
  };

  return (
    <div className="container max-w-2xl space-y-5 pt-4">
      <Card className="overflow-hidden p-0">
        <div className="bg-gradient-warm p-6 text-white">
          <div className="flex items-center gap-4">
            <div className="grid h-16 w-16 place-items-center rounded-full bg-white/25 font-display text-2xl font-bold backdrop-blur">
              {(user?.user_metadata?.full_name?.[0] ?? user?.phone?.slice(-2) ?? 'G').toUpperCase()}
            </div>
            <div>
              {loading ? (
                <p className="text-sm text-white/80">Loading…</p>
              ) : user ? (
                <>
                  <p className="text-sm text-white/80">{user.phone ?? user.email}</p>
                  <h1 className="font-display text-2xl font-bold">
                    {user.user_metadata?.full_name ?? 'Welcome back'}
                  </h1>
                  <Badge variant="solid" className="mt-1 bg-white/25 text-white">
                    <Sparkles className="h-3 w-3" /> Member at {brandName}
                  </Badge>
                </>
              ) : (
                <>
                  <p className="text-sm text-white/80">Welcome to {brandName}</p>
                  <h1 className="font-display text-2xl font-bold">Sign in to earn points</h1>
                  <Link
                    href={`${base}/sign-in?next=${encodeURIComponent(`${base}/account`)}`}
                    className="mt-2 inline-block"
                  >
                    <Button variant="glass" size="sm">
                      Sign in with phone
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
              { label: 'Points', value: (loyalty?.points_balance ?? 0).toLocaleString() },
              { label: 'Tier', value: (loyalty?.tier ?? 'bronze').replace(/^./, (c) => c.toUpperCase()) },
              { label: 'Lifetime', value: (loyalty?.lifetime_earned ?? 0).toLocaleString() },
            ].map((stat) => (
              <div key={stat.label} className="py-4">
                <p className="font-display text-xl font-bold text-primary">{stat.value}</p>
                <p className="text-xs text-muted-foreground">{stat.label}</p>
              </div>
            ))}
          </div>
        )}
      </Card>

      <ul className="space-y-2">
        <Row icon={Receipt} label="Order history" href={`${base}/orders`} />
        <Row icon={MapPin} label="Delivery addresses" meta="Manage saved addresses" href={`${base}/account/addresses`} />
        <Row
          icon={Award}
          label="Loyalty & rewards"
          meta={
            loyalty
              ? `${loyalty.tier.replace(/^./, (c) => c.toUpperCase())} · ${loyalty.points_balance.toLocaleString()} pts`
              : 'Bronze · 0 pts'
          }
          href={`${base}/account/loyalty`}
        />
        <Row icon={Settings} label="Settings & preferences" href={`${base}/account/settings`} />
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
            <p className="font-semibold">Sign out</p>
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
