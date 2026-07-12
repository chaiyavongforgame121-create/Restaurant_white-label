'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Palette, Plus, Save, Star } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import {
  MENU_CARD_STYLE_LABELS,
  MENU_LAYOUT_LABELS,
  parseStorefront,
  serializeStorefront,
  type StorefrontSettings,
} from '@favornoms/shared';
import { Badge, Button, Card, IconButton } from '@favornoms/ui';
import { ImageUpload } from '@/components/image-upload';

interface Brand {
  id: string;
  slug: string;
  name: string;
  theme: Record<string, unknown>;
  logo_url: string | null;
  is_default: boolean;
  created_at: string;
}

interface BranchRow {
  id: string;
  name: string;
  brand_id: string | null;
  is_active: boolean;
}

interface Props {
  restaurantId: string;
  restaurantName: string;
  loyaltyScope: 'branch' | 'brand';
  currentBranchId: string;
  brands: Brand[];
  branches: BranchRow[];
  storefront: Record<string, unknown>;
}

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);

export function BrandsManager({
  restaurantId,
  restaurantName,
  loyaltyScope: initialScope,
  brands: initialBrands,
  branches,
  storefront,
}: Props) {
  const router = useRouter();
  const [brands, setBrands] = React.useState(initialBrands);
  const [scope, setScope] = React.useState(initialScope);
  const [scopeSaving, setScopeSaving] = React.useState(false);
  const [editing, setEditing] = React.useState<Brand | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [store, setStore] = React.useState(() => parseStorefront(storefront));
  const [storeSaving, setStoreSaving] = React.useState(false);
  const [storeSaved, setStoreSaved] = React.useState(false);
  const [addingBranch, setAddingBranch] = React.useState(false);

  const refresh = async () => {
    const supabase = getBrowserClient();
    const { data } = await supabase
      .from('brands')
      .select('id, slug, name, theme, logo_url, is_default, created_at')
      .eq('restaurant_id', restaurantId)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: true });
    if (data) setBrands(data as Brand[]);
  };

  const saveScope = async (next: 'branch' | 'brand') => {
    setScopeSaving(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: upErr } = await supabase
      .from('restaurants')
      .update({ loyalty_scope: next })
      .eq('id', restaurantId);
    setScopeSaving(false);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setScope(next);
    router.refresh();
  };

  const saveStorefront = async (next: StorefrontSettings) => {
    setStore(next);
    setStoreSaving(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: upErr } = await supabase
      .from('restaurants')
      .update({ storefront: serializeStorefront(next) })
      .eq('id', restaurantId);
    setStoreSaving(false);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setStoreSaved(true);
    setTimeout(() => setStoreSaved(false), 2000);
    router.refresh();
  };

  const branchCountByBrand = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const b of branches) {
      const key = b.brand_id ?? '_unassigned';
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [branches]);

  return (
    <div className="container max-w-5xl py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3 px-2 pl-16 lg:px-0">
        <div>
          <h1 className="font-display text-3xl font-bold">Brands</h1>
          <p className="mt-1 text-muted-foreground">
            Run multiple concepts under {restaurantName}. Each brand has its own theme and can power one or many branches.
          </p>
        </div>
        <Button variant="gradient" leftIcon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
          New brand
        </Button>
      </header>

      <Card className="mb-6 p-5">
        <h2 className="font-display text-lg font-semibold">Loyalty pool</h2>
        <p className="text-sm text-muted-foreground">
          Choose whether loyalty points are scoped per branch (default) or shared across all branches.
        </p>
        <div className="mt-3 flex gap-2">
          {(['branch', 'brand'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              disabled={scopeSaving}
              onClick={() => saveScope(mode)}
              className={`flex-1 rounded-xl border px-4 py-3 text-left transition ${
                scope === mode ? 'border-primary bg-primary/5' : 'border-border bg-card'
              }`}
            >
              <p className="font-medium capitalize">{mode}</p>
              <p className="text-xs text-muted-foreground">
                {mode === 'branch'
                  ? 'Points are earned and redeemed within a single branch.'
                  : 'Points pool across all branches of this restaurant.'}
              </p>
            </button>
          ))}
        </div>
      </Card>

      <Card className="mb-6 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-display text-lg font-semibold">Storefront appearance</h2>
          {storeSaved && <span className="text-sm text-success">Saved ✓</span>}
        </div>
        <p className="text-sm text-muted-foreground">
          How the menu looks to customers. Applies to every branch of this restaurant.
        </p>
        <div className="mt-4 space-y-4">
          <div>
            <p className="mb-1.5 text-sm font-medium">Menu layout</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(['list', 'grid2', 'grid3', 'grid4'] as const).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  disabled={storeSaving}
                  onClick={() => saveStorefront({ ...store, menuLayout: opt })}
                  className={`rounded-xl border px-3 py-2 text-sm transition ${
                    store.menuLayout === opt ? 'border-primary bg-primary/5 font-medium' : 'border-border bg-card'
                  }`}
                >
                  {MENU_LAYOUT_LABELS[opt]}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-1.5 text-sm font-medium">Card style</p>
            <div className="grid grid-cols-2 gap-2">
              {(['standard', 'compact'] as const).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  disabled={storeSaving}
                  onClick={() => saveStorefront({ ...store, menuCardStyle: opt })}
                  className={`rounded-xl border px-3 py-2 text-sm transition ${
                    store.menuCardStyle === opt ? 'border-primary bg-primary/5 font-medium' : 'border-border bg-card'
                  }`}
                >
                  {MENU_CARD_STYLE_LABELS[opt]}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-1.5 text-sm font-medium">Hero headline</p>
            <input
              value={store.heroTitle}
              onChange={(e) => setStore({ ...store, heroTitle: e.target.value })}
              onBlur={(e) => saveStorefront({ ...store, heroTitle: e.target.value })}
              placeholder="Welcome — order something delicious"
              className="h-11 w-full rounded-xl border border-border bg-background px-3 text-base outline-none focus-visible:border-primary"
            />
            <p className="mt-1 text-xs text-muted-foreground">Leave empty to use the default headline.</p>
          </div>
          <div>
            <p className="mb-1.5 text-sm font-medium">Hero tagline</p>
            <input
              value={store.heroSubtitle}
              onChange={(e) => setStore({ ...store, heroSubtitle: e.target.value })}
              onBlur={(e) => saveStorefront({ ...store, heroSubtitle: e.target.value })}
              placeholder="Now serving from your city"
              className="h-11 w-full rounded-xl border border-border bg-background px-3 text-base outline-none focus-visible:border-primary"
            />
            <p className="mt-1 text-xs text-muted-foreground">Leave empty to show &ldquo;Now serving from {`{branch}`}&rdquo;.</p>
          </div>
          <div>
            <p className="mb-1.5 text-sm font-medium">Hero image</p>
            <ImageUpload
              restaurantId={restaurantId}
              folder="hero"
              value={store.heroUrl}
              onChange={(url) => saveStorefront({ ...store, heroUrl: url })}
              aspect="aspect-video"
              label="Upload hero image"
            />
          </div>
        </div>
      </Card>

      <Card className="mb-6 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-semibold">Branches</h2>
            <p className="text-sm text-muted-foreground">
              Locations under {restaurantName}. Each gets its own storefront URL + QR code.
            </p>
          </div>
          <Button variant="gradient" leftIcon={<Plus className="h-4 w-4" />} onClick={() => setAddingBranch(true)}>
            Add branch
          </Button>
        </div>
        <div className="mt-3 space-y-2">
          {branches.map((b) => (
            <div key={b.id} className="flex items-center justify-between rounded-xl border border-border px-3 py-2 text-sm">
              <span className="font-medium">{b.name}</span>
              {!b.is_active && <Badge variant="muted">Hidden</Badge>}
            </div>
          ))}
          {branches.length === 0 && <p className="text-sm text-muted-foreground">No branches yet.</p>}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          After creating a branch, set its delivery location, hours, and menu in that branch&apos;s settings.
        </p>
      </Card>

      {error && <p className="mb-3 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}

      <div className="space-y-3 px-2 lg:px-0">
        {brands.map((brand) => {
          const branchCount = branchCountByBrand.get(brand.id) ?? 0;
          const primaryColor = (brand.theme?.primaryColor as string) ?? '#FF6B35';
          const accentColor = (brand.theme?.accentColor as string) ?? '#F7B538';
          return (
            <Card key={brand.id} className="overflow-hidden">
              <div className="flex items-center gap-4 p-4">
                <div
                  className="h-14 w-14 shrink-0 rounded-2xl"
                  style={{ background: `linear-gradient(135deg, ${primaryColor}, ${accentColor})` }}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="font-display text-lg font-semibold">{brand.name}</h3>
                    {brand.is_default && (
                      <Badge variant="muted" className="gap-1">
                        <Star className="h-3 w-3" /> Default
                      </Badge>
                    )}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {brand.slug} · {branchCount} branch{branchCount === 1 ? '' : 'es'}
                  </p>
                </div>
                <IconButton label="Edit" onClick={() => setEditing(brand)}>
                  <Palette className="h-4 w-4" />
                </IconButton>
              </div>
            </Card>
          );
        })}
        {brands.length === 0 && (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            No brands yet. Create your first brand to unlock multi-brand theming.
          </Card>
        )}
      </div>

      {(editing || creating) && (
        <BrandEditor
          restaurantId={restaurantId}
          brand={editing}
          branches={branches}
          onClose={() => {
            setEditing(null);
            setCreating(false);
          }}
          onSaved={() => {
            setEditing(null);
            setCreating(false);
            void refresh();
            router.refresh();
          }}
        />
      )}

      {addingBranch && (
        <BranchCreator
          restaurantId={restaurantId}
          brands={brands}
          onClose={() => setAddingBranch(false)}
          onSaved={() => {
            setAddingBranch(false);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

const US_TIMEZONES: Array<{ tz: string; label: string }> = [
  { tz: 'America/New_York', label: 'Eastern (New York)' },
  { tz: 'America/Chicago', label: 'Central (Chicago)' },
  { tz: 'America/Denver', label: 'Mountain (Denver)' },
  { tz: 'America/Phoenix', label: 'Mountain — no DST (Phoenix)' },
  { tz: 'America/Los_Angeles', label: 'Pacific (Los Angeles)' },
  { tz: 'America/Anchorage', label: 'Alaska (Anchorage)' },
  { tz: 'Pacific/Honolulu', label: 'Hawaii (Honolulu)' },
];

function BranchCreator({
  restaurantId,
  brands,
  onClose,
  onSaved,
}: {
  restaurantId: string;
  brands: Brand[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = React.useState('');
  const [slug, setSlug] = React.useState('');
  const [address, setAddress] = React.useState('');
  const [timezone, setTimezone] = React.useState('America/New_York');
  const [brandId, setBrandId] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!slug && name) setSlug(slugify(name));
  }, [name, slug]);

  const create = async () => {
    setSaving(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: rpcErr } = await supabase.rpc('create_branch', {
      p_restaurant_id: restaurantId,
      p_name: name,
      p_slug: slug || slugify(name),
      p_address: address || undefined,
      p_timezone: timezone,
      p_brand_id: brandId || undefined,
    });
    setSaving(false);
    if (rpcErr) {
      const { describePlanError } = await import('@favornoms/database/queries');
      const planErr = describePlanError(rpcErr);
      setError(
        planErr
          ? `Your current plan only allows ${planErr.limit} ${planErr.key}. Please upgrade before adding more.`
          : rpcErr.message,
      );
      return;
    }
    onSaved();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6"
      onClick={onClose}
    >
      <Card className="w-full max-w-lg space-y-4 overflow-y-auto p-6 sm:max-h-[85vh]" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-display text-xl font-semibold">Add branch</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Branch name">
            <input value={name} onChange={(e) => setName(e.target.value)} className="input" placeholder="Downtown" autoFocus />
          </Field>
          <Field label="URL slug">
            <input value={slug} onChange={(e) => setSlug(slugify(e.target.value))} className="input" placeholder="downtown" />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Address (optional)">
              <input value={address} onChange={(e) => setAddress(e.target.value)} className="input" />
            </Field>
          </div>
          <Field label="Timezone">
            <select value={timezone} onChange={(e) => setTimezone(e.target.value)} className="input">
              {US_TIMEZONES.map((z) => (
                <option key={z.tz} value={z.tz}>{z.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Brand (optional)">
            <select value={brandId} onChange={(e) => setBrandId(e.target.value)} className="input">
              <option value="">— None —</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </Field>
        </div>

        {error && <p className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="gradient" onClick={create} loading={saving} disabled={!name} leftIcon={<Plus className="h-4 w-4" />}>
            Create branch
          </Button>
        </div>

        <style jsx>{`
          .input {
            width: 100%;
            height: 48px;
            padding: 0 1rem;
            font-size: 16px;
            border-radius: 0.875rem;
            border: 1px solid hsl(var(--border));
            background: hsl(var(--background));
          }
          .input:focus-visible {
            outline: none;
            border-color: hsl(var(--primary));
            box-shadow: 0 0 0 3px hsl(var(--primary) / 0.18);
          }
        `}</style>
      </Card>
    </div>
  );
}

function BrandEditor({
  restaurantId,
  brand,
  branches,
  onClose,
  onSaved,
}: {
  restaurantId: string;
  brand: Brand | null;
  branches: BranchRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = React.useState(brand?.name ?? '');
  const [slug, setSlug] = React.useState(brand?.slug ?? '');
  const [primaryColor, setPrimaryColor] = React.useState(
    (brand?.theme?.primaryColor as string) ?? '#FF6B35',
  );
  const [accentColor, setAccentColor] = React.useState(
    (brand?.theme?.accentColor as string) ?? '#F7B538',
  );
  const [logoUrl, setLogoUrl] = React.useState(brand?.logo_url ?? '');
  const [isDefault, setIsDefault] = React.useState(brand?.is_default ?? false);
  const [linkedBranchIds, setLinkedBranchIds] = React.useState<Set<string>>(() => {
    if (!brand) return new Set();
    return new Set(branches.filter((b) => b.brand_id === brand.id).map((b) => b.id));
  });
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!brand && !slug && name) setSlug(slugify(name));
  }, [name, brand, slug]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const supabase = getBrowserClient();
      const payload = {
        restaurant_id: restaurantId,
        name,
        slug: slug || slugify(name),
        theme: { ...(brand?.theme ?? {}), primaryColor, accentColor, brandName: name },
        logo_url: logoUrl || null,
        is_default: isDefault,
      };
      let brandId: string;
      if (brand) {
        const { error: upErr } = await supabase
          .from('brands')
          .update(payload)
          .eq('id', brand.id);
        if (upErr) throw new Error(upErr.message);
        brandId = brand.id;
      } else {
        const { data: created, error: insErr } = await supabase
          .from('brands')
          .insert(payload)
          .select('id')
          .single();
        if (insErr || !created) throw new Error(insErr?.message ?? 'failed_to_create');
        brandId = created.id;
      }

      // Reconcile branch linkage
      const want = new Set(linkedBranchIds);
      const linkUpdates: Array<PromiseLike<unknown>> = [];
      for (const b of branches) {
        const isLinked = b.brand_id === brandId;
        const shouldBeLinked = want.has(b.id);
        if (isLinked && !shouldBeLinked) {
          linkUpdates.push(
            supabase.from('branches').update({ brand_id: null }).eq('id', b.id) as unknown as PromiseLike<unknown>,
          );
        } else if (!isLinked && shouldBeLinked) {
          linkUpdates.push(
            supabase.from('branches').update({ brand_id: brandId }).eq('id', b.id) as unknown as PromiseLike<unknown>,
          );
        }
      }
      await Promise.all(linkUpdates);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6"
      onClick={onClose}
    >
      <Card
        className="w-full max-w-2xl space-y-4 overflow-y-auto p-6 sm:max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-display text-xl font-semibold">{brand ? 'Edit brand' : 'New brand'}</h2>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Brand name">
            <input value={name} onChange={(e) => setName(e.target.value)} className="input" />
          </Field>
          <Field label="Slug">
            <input
              value={slug}
              onChange={(e) => setSlug(slugify(e.target.value))}
              className="input"
              placeholder="my-brand"
            />
          </Field>
          <Field label="Primary color">
            <input
              type="color"
              value={primaryColor}
              onChange={(e) => setPrimaryColor(e.target.value)}
              className="h-12 w-full rounded-xl border border-border bg-background"
            />
          </Field>
          <Field label="Accent color">
            <input
              type="color"
              value={accentColor}
              onChange={(e) => setAccentColor(e.target.value)}
              className="h-12 w-full rounded-xl border border-border bg-background"
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Logo (optional)">
              <ImageUpload
                restaurantId={restaurantId}
                folder="logo"
                value={logoUrl || null}
                onChange={(url) => setLogoUrl(url ?? '')}
                aspect="aspect-[3/1]"
                label="Upload logo"
              />
            </Field>
          </div>
        </div>

        <div
          className="rounded-2xl p-6 text-white"
          style={{ background: `linear-gradient(135deg, ${primaryColor}, ${accentColor})` }}
        >
          <p className="text-xs uppercase tracking-wider text-white/80">Preview</p>
          <p className="mt-1 font-display text-2xl font-bold">{name || 'Brand name'}</p>
        </div>

        <Card className="bg-muted/30 p-4">
          <p className="text-sm font-medium">Linked branches</p>
          <p className="mb-2 text-xs text-muted-foreground">
            Choose which branches use this brand&apos;s theme.
          </p>
          <div className="space-y-1">
            {branches.map((b) => (
              <label key={b.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={linkedBranchIds.has(b.id)}
                  onChange={(e) => {
                    const next = new Set(linkedBranchIds);
                    if (e.target.checked) next.add(b.id);
                    else next.delete(b.id);
                    setLinkedBranchIds(next);
                  }}
                />
                {b.name}
                {!b.is_active && <Badge variant="muted">Hidden</Badge>}
              </label>
            ))}
          </div>
        </Card>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
          Set as default brand for this restaurant
        </label>

        {error && <p className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="gradient"
            onClick={save}
            loading={saving}
            disabled={!name}
            leftIcon={<Save className="h-4 w-4" />}
          >
            Save
          </Button>
        </div>

        <style jsx>{`
          .input {
            width: 100%;
            height: 48px;
            padding: 0 1rem;
            font-size: 16px;
            border-radius: 0.875rem;
            border: 1px solid hsl(var(--border));
            background: hsl(var(--background));
          }
          .input:focus-visible {
            outline: none;
            border-color: hsl(var(--primary));
            box-shadow: 0 0 0 3px hsl(var(--primary) / 0.18);
          }
        `}</style>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}
