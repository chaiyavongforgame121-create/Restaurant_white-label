'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, Store } from 'lucide-react';
import { Badge, Button, Card } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import { useDriverSession } from '@/components/driver-session';

interface BranchRow {
  id: string;
  name: string;
  restaurant: { name: string } | null;
}

export function ApplyView() {
  const router = useRouter();
  const { driver, refresh } = useDriverSession();
  const [branches, setBranches] = React.useState<BranchRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [applying, setApplying] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = getBrowserClient();
      const { data } = await supabase
        .from('branches')
        .select('id, name, restaurant:restaurants(name)')
        .eq('is_active', true)
        .order('name', { ascending: true });
      if (!cancelled) {
        setBranches((data ?? []) as unknown as BranchRow[]);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const statusFor = (branchId: string): string | null =>
    driver.approvals?.find((a) => a.branch_id === branchId)?.status ?? null;

  const apply = async (branchId: string) => {
    setApplying(branchId);
    const supabase = getBrowserClient();
    const { error } = await supabase.from('driver_approvals').insert({
      driver_id: driver.id,
      branch_id: branchId,
      status: 'pending',
      applied_at: new Date().toISOString(),
    });
    // A unique-violation just means we already applied — refresh shows the status.
    if (error && !/duplicate|unique/i.test(error.message)) {
      alert(error.message);
    }
    if ('vibrate' in navigator) navigator.vibrate(30);
    await refresh();
    setApplying(null);
  };

  return (
    <div className="pb-6">
      <header className="flex items-center gap-2 px-4 pt-safe pt-5">
        <button
          type="button"
          onClick={() => router.back()}
          aria-label="Back"
          className="focus-ring grid h-10 w-10 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold">Restaurants</h1>
          <p className="truncate text-sm text-muted-foreground">
            Apply to deliver — they review &amp; approve you
          </p>
        </div>
      </header>

      <div className="mt-5 space-y-3 px-4">
        {loading ? (
          <p className="px-1 text-sm text-muted-foreground">Loading…</p>
        ) : branches.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            No restaurants available right now.
          </Card>
        ) : (
          branches.map((b) => {
            const status = statusFor(b.id);
            return (
              <Card key={b.id} className="flex items-center gap-3 p-4">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                  <Store className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{b.restaurant?.name ?? 'Restaurant'}</p>
                  <p className="truncate text-sm text-muted-foreground">{b.name}</p>
                </div>
                {status === 'approved' ? (
                  <Badge variant="success">✓ Approved</Badge>
                ) : status === 'pending' ? (
                  <Badge variant="warning">Pending</Badge>
                ) : status === 'rejected' ? (
                  <Badge variant="danger">Rejected</Badge>
                ) : status === 'suspended' ? (
                  <Badge variant="warning">Suspended</Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="gradient"
                    loading={applying === b.id}
                    onClick={() => apply(b.id)}
                  >
                    Apply
                  </Button>
                )}
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
