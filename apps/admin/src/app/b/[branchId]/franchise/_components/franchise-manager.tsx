'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Network, Send } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Button, Card } from '@favornoms/ui';

interface Group {
  id: string;
  name: string;
  slug: string;
}

interface Restaurant {
  id: string;
  name: string;
  slug: string;
  franchise_group_id: string | null;
}

interface BranchLite {
  id: string;
  name: string;
  restaurant_id: string;
}

interface Props {
  currentBranchId: string;
  restaurantId: string;
  restaurantName: string;
  currentGroupId: string | null;
}

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);

export function FranchiseManager({ currentBranchId, restaurantId, restaurantName, currentGroupId }: Props) {
  const router = useRouter();
  const [groups, setGroups] = React.useState<Group[]>([]);
  const [activeGroup, setActiveGroup] = React.useState<Group | null>(null);
  const [restaurants, setRestaurants] = React.useState<Restaurant[]>([]);
  const [branches, setBranches] = React.useState<BranchLite[]>([]);
  const [selectedTargets, setSelectedTargets] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const [creatingGroup, setCreatingGroup] = React.useState(false);
  const [newName, setNewName] = React.useState('');

  const refresh = React.useCallback(async () => {
    const supabase = getBrowserClient();
    const { data: g } = await supabase.from('franchise_groups').select('id, name, slug').order('created_at', { ascending: false });
    setGroups((g ?? []) as Group[]);
    if (currentGroupId) {
      const cg = (g ?? []).find((x) => x.id === currentGroupId);
      if (cg) setActiveGroup(cg as Group);
      const { data: rs } = await supabase.from('restaurants').select('id, name, slug, franchise_group_id').eq('franchise_group_id', currentGroupId);
      setRestaurants((rs ?? []) as Restaurant[]);
      const { data: bs } = await supabase
        .from('branches')
        .select('id, name, restaurant_id')
        .in('restaurant_id', (rs ?? []).map((r) => r.id))
        .eq('is_active', true);
      setBranches((bs ?? []) as BranchLite[]);
    }
  }, [currentGroupId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const createGroup = async () => {
    setBusy(true);
    const supabase = getBrowserClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setBusy(false); return; }
    const { data: g, error } = await supabase
      .from('franchise_groups')
      .insert({ owner_user_id: user.id, name: newName, slug: slugify(newName) })
      .select()
      .single();
    if (error) { setMsg(error.message); setBusy(false); return; }
    // Link current restaurant to this group
    await supabase.from('restaurants').update({ franchise_group_id: g.id }).eq('id', restaurantId);
    setBusy(false);
    setCreatingGroup(false);
    setNewName('');
    router.refresh();
  };

  const broadcast = async () => {
    setBusy(true);
    setMsg(null);
    const supabase = getBrowserClient();
    const targetIds = Array.from(selectedTargets);
    const { data, error } = await supabase.rpc('broadcast_franchise_menu', {
      p_source_branch_id: currentBranchId,
      p_target_branch_ids: targetIds,
    });
    setBusy(false);
    if (error) { setMsg(error.message); return; }
    const r = data as { inserted_items?: number; updated_items?: number };
    setMsg(`Broadcast complete. Inserted ${r?.inserted_items ?? 0}, updated ${r?.updated_items ?? 0} items.`);
  };

  return (
    <div className="container max-w-5xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0">
        <h1 className="font-display text-3xl font-bold">Franchise</h1>
        <p className="mt-1 text-muted-foreground">Manage HQ-to-branch menu broadcasts.</p>
      </header>

      {!currentGroupId && (
        <Card className="mb-6 p-5">
          <h2 className="font-display text-lg font-semibold">Create a franchise group</h2>
          <p className="text-sm text-muted-foreground">Group multiple restaurants together to broadcast menu changes from one source.</p>
          {!creatingGroup ? (
            <Button variant="gradient" onClick={() => setCreatingGroup(true)} className="mt-3" leftIcon={<Network className="h-4 w-4" />}>
              Create group
            </Button>
          ) : (
            <div className="mt-3 space-y-2">
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="My franchise" className="input" />
              <Button variant="gradient" onClick={createGroup} disabled={!newName} loading={busy}>Create</Button>
            </div>
          )}
        </Card>
      )}

      {activeGroup && (
        <>
          <Card className="mb-6 p-5">
            <h2 className="font-display text-lg font-semibold">{activeGroup.name}</h2>
            <p className="text-sm text-muted-foreground">
              {restaurants.length} restaurant{restaurants.length === 1 ? '' : 's'} · {branches.length} branch{branches.length === 1 ? '' : 'es'}
            </p>
          </Card>

          <Card className="mb-6 p-5">
            <h3 className="font-display text-lg font-semibold">Broadcast this branch&apos;s menu to:</h3>
            <p className="text-sm text-muted-foreground">Categories and items missing in target branches will be inserted.</p>
            <ul className="mt-3 space-y-2">
              {branches.filter((b) => b.id !== currentBranchId).map((b) => (
                <li key={b.id}>
                  <label className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selectedTargets.has(b.id)}
                      onChange={(e) => {
                        const n = new Set(selectedTargets);
                        if (e.target.checked) n.add(b.id); else n.delete(b.id);
                        setSelectedTargets(n);
                      }}
                    />
                    <span>{b.name}</span>
                  </label>
                </li>
              ))}
              {branches.filter((b) => b.id !== currentBranchId).length === 0 && (
                <li className="text-sm text-muted-foreground">No other branches in this group yet.</li>
              )}
            </ul>
            <div className="mt-4 flex items-center gap-3">
              <Button
                variant="gradient"
                onClick={broadcast}
                loading={busy}
                disabled={selectedTargets.size === 0}
                leftIcon={<Send className="h-4 w-4" />}
              >
                Broadcast menu
              </Button>
              {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
            </div>
          </Card>
        </>
      )}

      <style jsx>{`
        .input { width: 100%; min-height: 48px; padding: 0 1rem; font-size: 16px; border-radius: 0.875rem; border: 1px solid hsl(var(--border)); background: hsl(var(--background)); }
        .input:focus-visible { outline: none; border-color: hsl(var(--primary)); box-shadow: 0 0 0 3px hsl(var(--primary) / 0.18); }
      `}</style>
    </div>
  );
}
