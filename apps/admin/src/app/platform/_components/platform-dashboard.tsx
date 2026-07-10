'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Activity, Building2, ChefHat, Pause, Play, Users } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Button, Card } from '@favornoms/ui';
import { PlatformNav } from './platform-nav';

interface Restaurant {
  id: string;
  slug: string;
  name: string;
  created_at: string;
  franchise_group_id: string | null;
  loyalty_scope: 'branch' | 'brand';
}

interface BranchLite {
  id: string;
  restaurant_id: string;
  name: string;
  is_active: boolean;
}

export function PlatformDashboard({
  summary,
  restaurants,
  branches,
}: {
  summary: Record<string, number>;
  restaurants: Restaurant[];
  branches: BranchLite[];
}) {
  const router = useRouter();
  const [search, setSearch] = React.useState('');

  const byRestaurant = React.useMemo(() => {
    const m = new Map<string, BranchLite[]>();
    for (const b of branches) {
      const list = m.get(b.restaurant_id) ?? [];
      list.push(b);
      m.set(b.restaurant_id, list);
    }
    return m;
  }, [branches]);

  const filtered = restaurants.filter((r) =>
    !search ? true : r.name.toLowerCase().includes(search.toLowerCase()) || r.slug.includes(search.toLowerCase()),
  );

  const toggleSuspend = async (r: Restaurant) => {
    const branchList = byRestaurant.get(r.id) ?? [];
    const anyActive = branchList.some((b) => b.is_active);
    if (!confirm(`${anyActive ? 'Suspend' : 'Restore'} ${r.name}?`)) return;
    const supabase = getBrowserClient();
    await supabase.rpc('set_restaurant_suspended', {
      p_restaurant_id: r.id,
      p_suspended: anyActive,
    });
    router.refresh();
  };

  const impersonateBranch = (b: BranchLite) => {
    router.push(`/b/${b.id}/dashboard`);
  };

  return (
    <div className="container max-w-6xl py-8">
      <header className="mb-2">
        <h1 className="font-display text-3xl font-bold">Platform admin</h1>
        <p className="mt-1 text-muted-foreground">Cross-tenant operations dashboard.</p>
      </header>
      <PlatformNav />

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Restaurants" value={summary.restaurants ?? 0} icon={ChefHat} />
        <StatCard label="Active branches" value={summary.active_branches ?? 0} icon={Building2} />
        <StatCard label="Customers" value={summary.customers ?? 0} icon={Users} />
        <StatCard label="Drivers online" value={summary.drivers_online ?? 0} icon={Activity} />
        <StatCard label="Orders today" value={summary.orders_today ?? 0} icon={Activity} />
        <StatCard label="Revenue today" value={summary.revenue_today ?? 0} prefix="$" icon={Activity} />
      </div>

      <Card className="mb-6 p-4">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search restaurants…"
          className="h-10 w-full rounded-xl border border-border bg-background px-3 text-base focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-5 py-3">Restaurant</th>
              <th className="px-5 py-3">Slug</th>
              <th className="px-5 py-3">Branches</th>
              <th className="px-5 py-3">Loyalty</th>
              <th className="px-5 py-3">Created</th>
              <th className="px-5 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const branchList = byRestaurant.get(r.id) ?? [];
              const activeCount = branchList.filter((b) => b.is_active).length;
              return (
                <tr key={r.id} className="border-t border-border/40 hover:bg-muted/30">
                  <td className="px-5 py-3 font-semibold">{r.name}</td>
                  <td className="px-5 py-3 font-mono text-xs">{r.slug}</td>
                  <td className="px-5 py-3">
                    {activeCount} / {branchList.length}
                    {r.franchise_group_id && <Badge variant="muted" className="ml-2">Franchise</Badge>}
                  </td>
                  <td className="px-5 py-3 capitalize">{r.loyalty_scope}</td>
                  <td className="px-5 py-3 text-muted-foreground">
                    {new Date(r.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      {branchList.slice(0, 2).map((b) => (
                        <Button key={b.id} size="sm" variant="ghost" onClick={() => impersonateBranch(b)}>
                          Open {b.name.slice(0, 8)}
                        </Button>
                      ))}
                      <Button
                        size="sm"
                        variant={activeCount > 0 ? 'ghost' : 'soft'}
                        onClick={() => toggleSuspend(r)}
                        leftIcon={activeCount > 0 ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                      >
                        {activeCount > 0 ? 'Suspend' : 'Restore'}
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      </Card>
    </div>
  );
}

function StatCard({
  label,
  value,
  prefix,
  icon: Icon,
}: {
  label: string;
  value: number | string;
  prefix?: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
          <p className="mt-1 font-display text-2xl font-bold">
            {prefix}{typeof value === 'number' ? value.toLocaleString() : value}
          </p>
        </div>
        <Icon className="h-5 w-5 text-muted-foreground" />
      </div>
    </Card>
  );
}
