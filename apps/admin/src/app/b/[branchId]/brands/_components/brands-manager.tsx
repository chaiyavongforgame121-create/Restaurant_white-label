'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ExternalLink, Palette, Plus, Save, Settings, Star } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import {
  MENU_CARD_STYLE_LABELS,
  MENU_LAYOUT_LABELS,
  canAddBranch,
  describeBillingError,
  parseStorefront,
  serializeStorefront,
  type Entitlements,
  type StorefrontSettings,
} from '@favornoms/shared';
import { Badge, Button, Card, IconButton } from '@favornoms/ui';
import { ImageUpload } from '@/components/image-upload';
import { IconUpload, type IconSet } from '@/components/icon-upload';
import { parseIconStyle, type IconStyle } from '@/components/icon-geometry';

interface Brand {
  id: string;
  slug: string;
  name: string;
  theme: Record<string, unknown>;
  logo_url: string | null;
  favicon_url: string | null;
  icon_192_url: string | null;
  icon_512_url: string | null;
  icon_maskable_512_url: string | null;
  is_default: boolean;
  created_at: string;
}

interface BranchRow {
  id: string;
  name: string;
  brand_id: string | null;
  is_active: boolean;
  timezone: string;
  /** The public menu address: the branch's custom domain when set, else
   *  /r/<restaurant>/<branch>. Null when a slug is missing. */
  storefront_url: string | null;
}

interface Props {
  restaurantId: string;
  restaurantName: string;
  loyaltyScope: 'branch' | 'brand';
  currentBranchId: string;
  brands: Brand[];
  branches: BranchRow[];
  storefront: Record<string, unknown>;
  entitlements: Entitlements;
}

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);

export function BrandsManager({
  restaurantId,
  restaurantName,
  loyaltyScope: initialScope,
  currentBranchId,
  brands: initialBrands,
  branches,
  storefront,
  entitlements,
}: Props) {
  const router = useRouter();
  const [brands, setBrands] = React.useState(initialBrands);
  const [scope, setScope] = React.useState(initialScope);
  const [scopeSaving, setScopeSaving] = React.useState(false);
  const [editing, setEditing] = React.useState<Brand | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [store, setStore] = React.useState(() => parseStorefront(storefront));
  const [storeSaving, setStoreSaving] = React.useState(false);
  const [storeSaved, setStoreSaved] = React.useState(false);
  const [addingBranch, setAddingBranch] = React.useState(false);

  const refresh = async () => {
    const supabase = getBrowserClient();
    const { data } = await supabase
      .from('brands')
      .select('id, slug, name, theme, logo_url, favicon_url, icon_192_url, icon_512_url, icon_maskable_512_url, is_default, created_at')
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
          <h1 className="font-display text-3xl font-bold">Brand &amp; branches</h1>
          <p className="mt-1 text-muted-foreground">
            Your look for {restaurantName} — logo, app icon and colors — plus the branches
            that use it.
          </p>
        </div>
      </header>

      <Card className="mb-6 p-5">
        <h2 className="font-display text-lg font-semibold">Loyalty pool</h2>
        <p className="text-sm text-muted-foreground">
          Choose whether loyalty points are shared across all branches (default) or scoped to one branch.
        </p>
        <div className="mt-3 flex gap-2">
          {(['brand', 'branch'] as const).map((mode) => (
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
          {/* Pay first, then create (owner decision 2026-07-25). The branches
              trigger enforces this regardless; sending the merchant to the plan
              page is friendlier than letting them fill a form that will be
              refused on submit. */}
          {canAddBranch(entitlements) ? (
            <Button variant="gradient" leftIcon={<Plus className="h-4 w-4" />} onClick={() => setAddingBranch(true)}>
              Add branch
            </Button>
          ) : (
            <Link href={`/b/${currentBranchId}/settings/plan`}>
              <Button variant="outline" leftIcon={<Plus className="h-4 w-4" />}>
                Add a branch seat +$99/mo
              </Button>
            </Link>
          )}
        </div>
        {!canAddBranch(entitlements) && (
          <p className="mt-3 rounded-xl bg-muted px-3 py-2 text-xs text-muted-foreground">
            You are using {entitlements.branchesUsed} of {entitlements.branchSeats} branch seat
            {entitlements.branchSeats === 1 ? '' : 's'}. Add a seat to open another location — it
            gets the full feature set of your main branch.
          </p>
        )}
        <div className="mt-3 space-y-2">
          {branches.map((b) => (
            <div
              key={b.id}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl border border-border px-3 py-2 text-sm"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="font-medium">{b.name}</span>
                {!b.is_active && <Badge variant="muted">Hidden</Badge>}
              </div>
              {/* The card promises every branch its own storefront URL, and a hidden branch
                  was otherwise reachable only through Head office — so each row links to
                  both the live menu and the branch's own settings. */}
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                {b.is_active && b.storefront_url ? (
                  <a
                    href={b.storefront_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-w-0 max-w-[18rem] items-center gap-1 font-medium text-primary hover:underline"
                  >
                    <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{b.storefront_url.replace(/^https?:\/\//, '')}</span>
                  </a>
                ) : (
                  <span className="text-muted-foreground">
                    {b.is_active ? 'No storefront address yet' : 'Storefront offline while hidden'}
                  </span>
                )}
                <Link
                  href={`/b/${b.id}/branch`}
                  className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                >
                  <Settings className="h-3.5 w-3.5" />
                  Settings
                </Link>
              </div>
            </div>
          ))}
          {branches.length === 0 && <p className="text-sm text-muted-foreground">No branches yet.</p>}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          A new branch can copy the menu, opening hours and payment settings of an existing one.
          Its map pin and table QR codes are never copied — set those in the new branch&apos;s
          settings.
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
        {/* A restaurant starts with no brands row at all — create_restaurant_with_branch
            writes restaurants.brand_settings and never a brand — so the first one is minted
            by the Branding card on Branch settings. Say where, or this reads as a dead end. */}
        {brands.length === 0 && (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            No brand yet. Upload your logo under{' '}
            <Link
              href={`/b/${currentBranchId}/branch`}
              className="font-medium text-primary hover:underline"
            >
              Branch settings → Branding
            </Link>{' '}
            and it is created for you.
          </Card>
        )}
      </div>

      {editing && (
        <BrandEditor
          restaurantId={restaurantId}
          brand={editing}
          branches={branches}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refresh();
            router.refresh();
          }}
        />
      )}

      {addingBranch && (
        <BranchCreator
          restaurantId={restaurantId}
          brands={brands}
          branches={branches}
          currentBranchId={currentBranchId}
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

/** What copy_branch_setup reports back. Read defensively: the RPC is untyped here. */
interface CopyResult {
  categories_copied: number;
  items_copied: number;
  modifier_groups_copied: number;
  hours_copied: number;
  settings_copied: boolean;
}

function readCopyResult(data: unknown): CopyResult {
  const row = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    categories_copied: count(row.categories_copied),
    items_copied: count(row.items_copied),
    modifier_groups_copied: count(row.modifier_groups_copied),
    hours_copied: count(row.hours_copied),
    settings_copied: row.settings_copied === true,
  };
}

function describeCopyError(message: string): string {
  // The RPC refuses to copy a menu into a branch that already has items rather than
  // duplicating every dish. Name the box to untick instead of the bare exception.
  if (message.includes('target_menu_not_empty')) {
    return 'the new branch already has menu items. Untick "Copy menu" and retry to copy the rest.';
  }
  return message;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function BranchCreator({
  restaurantId,
  brands,
  branches,
  currentBranchId,
  onClose,
  onSaved,
}: {
  restaurantId: string;
  brands: Brand[];
  branches: BranchRow[];
  currentBranchId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const activeBranches = React.useMemo(() => branches.filter((b) => b.is_active), [branches]);
  const [name, setName] = React.useState('');
  const [slug, setSlug] = React.useState('');
  const [address, setAddress] = React.useState('');
  // A new branch used to start from nothing: an empty menu, no hours (which counts as open
  // 24/7) and default payment settings, with the only copy tool hidden behind "Create a
  // franchise group". Default to copying the branch the owner is standing in.
  const [sourceId, setSourceId] = React.useState(
    () => (activeBranches.find((b) => b.id === currentBranchId) ?? activeBranches[0])?.id ?? '',
  );
  const source = activeBranches.find((b) => b.id === sourceId) ?? null;
  const [copyMenu, setCopyMenu] = React.useState(true);
  const [copyHours, setCopyHours] = React.useState(true);
  const [copySettings, setCopySettings] = React.useState(true);
  // Opening hours and "today" in reports are read in the branch's own zone, and every new
  // branch used to start on America/New_York: a second branch of a Los Angeles shop opened
  // three hours early. Follow the source branch until the owner picks a zone themselves.
  const [timezone, setTimezone] = React.useState(() => source?.timezone ?? 'America/New_York');
  const [timezoneTouched, setTimezoneTouched] = React.useState(false);
  const [brandId, setBrandId] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Set once create_branch has committed. From then on the dialog can only retry the copy:
  // pressing Create again would open a second branch and take a second seat.
  const [created, setCreated] = React.useState<{ id: string | null } | null>(null);
  const [copied, setCopied] = React.useState<CopyResult | null>(null);

  React.useEffect(() => {
    if (!slug && name) setSlug(slugify(name));
  }, [name, slug]);

  const pickSource = (id: string) => {
    setSourceId(id);
    const next = activeBranches.find((b) => b.id === id);
    // Once the branch exists its zone is fixed; picking another source for a retried copy
    // must not change the locked field to a zone the branch was never given.
    if (next && !timezoneTouched && !created) setTimezone(next.timezone);
  };

  const wantsCopy = !!source && (copyMenu || copyHours || copySettings);
  // Once the branch exists, dismissing the dialog must still refresh the list behind it.
  const close = created ? onSaved : onClose;

  // Runs after create_branch has committed, so a failure here leaves a real branch behind
  // with nothing in it. It is separate from create so the owner can retry only the copy.
  const runCopy = async (targetId: string) => {
    if (!source || !wantsCopy) {
      onSaved();
      return;
    }
    const supabase = getBrowserClient();
    // copy_branch_setup is not in the generated types yet — thin typed escape.
    const rpcAny = supabase.rpc.bind(supabase) as unknown as (
      fn: string,
      args?: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { message: string } | null }>;
    const { data, error: copyErr } = await rpcAny('copy_branch_setup', {
      p_source_branch_id: source.id,
      p_target_branch_id: targetId,
      p_copy_menu: copyMenu,
      p_copy_hours: copyHours,
      p_copy_settings: copySettings,
    });
    if (copyErr) {
      setError(
        `The branch was created, but copying from ${source.name} failed: ${describeCopyError(copyErr.message)} You can retry the copy, or close this and set the branch up in its own settings.`,
      );
      return;
    }
    setCopied(readCopyResult(data));
  };

  const create = async () => {
    setSaving(true);
    setError(null);
    const supabase = getBrowserClient();
    const { data, error: rpcErr } = await supabase.rpc('create_branch', {
      p_restaurant_id: restaurantId,
      p_name: name,
      p_slug: slug || slugify(name),
      p_address: address || undefined,
      p_timezone: timezone,
      p_brand_id: brandId || undefined,
    });
    if (rpcErr) {
      setSaving(false);
      // The BEFORE INSERT trigger on branches is the real gate; this arm only
      // ever runs if the UI let a stale seat count through (or two tabs raced).
      const billing = describeBillingError(rpcErr);
      if (billing?.kind === 'seats') {
        setError(
          `You are using all ${billing.limit} of your branch seats. Add a seat (+$99/mo) on the Plan page, then create the branch.`,
        );
      } else if (billing?.kind === 'inactive') {
        setError('Your subscription is not active. Choose a package on the Plan page to continue.');
      } else {
        setError(rpcErr.message);
      }
      return;
    }
    const newId = (data as { branch_id?: unknown } | null)?.branch_id;
    if (typeof newId !== 'string') {
      setSaving(false);
      if (!wantsCopy) {
        onSaved();
        return;
      }
      setCreated({ id: null });
      setError(
        'The branch was created, but the reply did not say which branch it was, so nothing was copied into it. Close this and set the branch up in its own settings.',
      );
      return;
    }
    setCreated({ id: newId });
    await runCopy(newId);
    setSaving(false);
  };

  const retryCopy = async () => {
    const targetId = created?.id;
    if (!targetId) return;
    setSaving(true);
    setError(null);
    await runCopy(targetId);
    setSaving(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6"
      onClick={close}
    >
      <Card className="w-full max-w-lg space-y-4 overflow-y-auto p-6 sm:max-h-[85vh]" onClick={(e) => e.stopPropagation()}>
        {created?.id && copied ? (
          <>
            <h2 className="font-display text-xl font-semibold">Branch created</h2>
            <div className="space-y-1 text-sm">
              <p>
                Copied into {name} from {source?.name ?? 'the source branch'}:
              </p>
              <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
                {copyMenu && (
                  <li>
                    {plural(copied.categories_copied, 'category', 'categories')},{' '}
                    {plural(copied.items_copied, 'menu item')} and{' '}
                    {plural(copied.modifier_groups_copied, 'option group')}
                  </li>
                )}
                {copyHours && <li>{plural(copied.hours_copied, 'opening-hours window')}</li>}
                {copySettings && (
                  <li>
                    {copied.settings_copied
                      ? 'Payment, delivery, tip and service fee settings'
                      : 'No payment or delivery settings: the source branch has none saved'}
                  </li>
                )}
              </ul>
            </div>
            <p className="rounded-xl bg-muted px-3 py-2 text-xs text-muted-foreground">
              Still to do at the new branch: drop its map pin and set up its table QR codes.
              Those are never copied.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onSaved}>Done</Button>
              <Link href={`/b/${created.id}/branch`}>
                <Button variant="gradient">Open its settings</Button>
              </Link>
            </div>
          </>
        ) : (
          <>
            <h2 className="font-display text-xl font-semibold">Add branch</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Branch name">
                <input value={name} onChange={(e) => setName(e.target.value)} disabled={!!created} className="input disabled:opacity-60" placeholder="Downtown" autoFocus />
              </Field>
              <Field label="URL slug">
                <input value={slug} onChange={(e) => setSlug(slugify(e.target.value))} disabled={!!created} className="input disabled:opacity-60" placeholder="downtown" />
              </Field>
              <div className="sm:col-span-2">
                <Field label="Address (optional)">
                  <input value={address} onChange={(e) => setAddress(e.target.value)} disabled={!!created} className="input disabled:opacity-60" />
                </Field>
              </div>
              <Field label="Timezone">
                <select
                  value={timezone}
                  onChange={(e) => {
                    setTimezone(e.target.value);
                    setTimezoneTouched(true);
                  }}
                  disabled={!!created}
                  className="input disabled:opacity-60"
                >
                  {/* A source branch outside the US list keeps its own zone selectable, so
                      defaulting to it never silently falls back to New York. */}
                  {!US_TIMEZONES.some((z) => z.tz === timezone) && (
                    <option value={timezone}>{timezone}</option>
                  )}
                  {US_TIMEZONES.map((z) => (
                    <option key={z.tz} value={z.tz}>{z.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Brand (optional)">
                <select value={brandId} onChange={(e) => setBrandId(e.target.value)} disabled={!!created} className="input disabled:opacity-60">
                  <option value="">— None —</option>
                  {brands.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </Field>
              <div className="space-y-2 sm:col-span-2">
                <Field label="Start from">
                  <select value={sourceId} onChange={(e) => pickSource(e.target.value)} disabled={saving} className="input disabled:opacity-60">
                    <option value="">Nothing (an empty branch)</option>
                    {activeBranches.map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                </Field>
                {source && (
                  <div className="space-y-2 rounded-xl bg-muted/40 p-3 text-sm">
                    <label className="flex items-start gap-2">
                      <input type="checkbox" checked={copyMenu} onChange={(e) => setCopyMenu(e.target.checked)} disabled={saving} className="mt-1" />
                      <span>
                        Copy menu
                        <span className="block text-xs text-muted-foreground">Categories, items and their option groups</span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2">
                      <input type="checkbox" checked={copyHours} onChange={(e) => setCopyHours(e.target.checked)} disabled={saving} className="mt-1" />
                      <span>
                        Copy opening hours
                        <span className="block text-xs text-muted-foreground">The weekly hours, not one-off closures</span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2">
                      <input type="checkbox" checked={copySettings} onChange={(e) => setCopySettings(e.target.checked)} disabled={saving} className="mt-1" />
                      <span>
                        Copy payment and delivery settings
                        <span className="block text-xs text-muted-foreground">Payment methods, delivery, tips and service fee</span>
                      </span>
                    </label>
                    <p className="text-xs text-muted-foreground">
                      Address, map pin, colours and table QR codes are not copied.
                    </p>
                  </div>
                )}
              </div>
            </div>

            {error && <p className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={close}>{created ? 'Close' : 'Cancel'}</Button>
              {created && !saving ? (
                created.id ? (
                  <Button variant="gradient" onClick={retryCopy} disabled={!wantsCopy}>
                    Retry copy
                  </Button>
                ) : null
              ) : (
                <Button
                  variant="gradient"
                  onClick={create}
                  loading={saving}
                  disabled={!name || !!created}
                  leftIcon={<Plus className="h-4 w-4" />}
                >
                  {created ? 'Copying…' : 'Create branch'}
                </Button>
              )}
            </div>
          </>
        )}

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
  brand: Brand;
  branches: BranchRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = React.useState(brand.name);
  const [slug, setSlug] = React.useState(brand.slug);
  const [primaryColor, setPrimaryColor] = React.useState(
    (brand.theme?.primaryColor as string) ?? '#FF6B35',
  );
  const [accentColor, setAccentColor] = React.useState(
    (brand.theme?.accentColor as string) ?? '#F7B538',
  );
  const [logoUrl, setLogoUrl] = React.useState(brand.logo_url ?? '');
  const [icons, setIcons] = React.useState<IconSet>({
    faviconUrl: brand.favicon_url,
    icon192Url: brand.icon_192_url,
    icon512Url: brand.icon_512_url,
    iconMaskable512Url: brand.icon_maskable_512_url,
  });
  // Same contract as the Branding card: the style the current icon files were rendered with,
  // null for an icon made before styles existed.
  const [iconStyle, setIconStyle] = React.useState<IconStyle | null>(() =>
    brand.theme && 'appIcon' in brand.theme ? parseIconStyle(brand.theme.appIcon) : null,
  );
  // A restyled icon not applied yet: saving would keep the old files and close the dialog.
  const [iconPending, setIconPending] = React.useState(false);
  const [isDefault, setIsDefault] = React.useState(brand.is_default);
  const [linkedBranchIds, setLinkedBranchIds] = React.useState<Set<string>>(
    () => new Set(branches.filter((b) => b.brand_id === brand.id).map((b) => b.id)),
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const supabase = getBrowserClient();
      const theme: Record<string, unknown> = { ...brand.theme, primaryColor, accentColor, brandName: name };
      // appIcon travels with the icon files it describes, and leaves with them.
      if (iconStyle && icons.icon512Url) theme.appIcon = iconStyle;
      else delete theme.appIcon;
      const payload = {
        restaurant_id: restaurantId,
        name,
        slug: slug || slugify(name),
        theme,
        logo_url: logoUrl || null,
        favicon_url: icons.faviconUrl,
        icon_192_url: icons.icon192Url,
        icon_512_url: icons.icon512Url,
        icon_maskable_512_url: icons.iconMaskable512Url,
        is_default: isDefault,
      };
      // `.select()` matters: brands writes are gated on the 'brand.edit' capability, and
      // RLS denies by filtering the row out rather than raising. A role without it used to
      // see "saved", the dialog close, and nothing change — while the image had already
      // reached the bucket.
      const { data: updated, error: upErr } = await supabase
        .from('brands')
        .update(payload)
        .eq('id', brand.id)
        .select('id');
      if (upErr) throw new Error(upErr.message);
      if (!updated || updated.length === 0) {
        throw new Error("That didn't save — your role may not be allowed to change branding.");
      }
      const brandId = brand.id;

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
        <h2 className="font-display text-xl font-semibold">Edit brand</h2>

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
                removeBackground
                value={logoUrl || null}
                onChange={(url) => setLogoUrl(url ?? '')}
                aspect="aspect-[3/1]"
                label="Upload logo"
              />
            </Field>
          </div>
          <div className="sm:col-span-2">
            {/* Kept separate from the logo rather than derived from it: the logo is
                a wide lockup that turns to mush at 32px, which reads as a broken
                site rather than an unbranded one. */}
            {/* A <div>, not Field's <label>: inside a label every click on the style panel's
                previews, captions and gaps was forwarded to the hidden file input and opened
                the file picker, and the Zoom label ended up nested inside another label. */}
            <div>
              <span className="mb-1.5 block text-sm font-medium">App icon (optional)</span>
              <IconUpload
                restaurantId={restaurantId}
                value={icons}
                onChange={setIcons}
                appliedStyle={iconStyle}
                onAppliedStyleChange={setIconStyle}
                onPendingChange={setIconPending}
              />
              <div className="mt-2 text-xs text-muted-foreground">
                <p>
                  Used for the browser tab, and for the icon people see after installing your
                  store to their phone&apos;s home screen. Leave empty to use the Favornoms icon.
                </p>
                {icons.faviconUrl && (
                  <div className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={icons.faviconUrl} alt="" className="h-4 w-4 rounded-sm object-cover" />
                    <span className="truncate text-foreground">{name || 'Your store'}</span>
                  </div>
                )}
              </div>
            </div>
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

        <div className="flex flex-wrap items-center justify-end gap-2">
          {iconPending && (
            <span className="mr-auto text-sm text-muted-foreground">
              Apply the new icon style first, or set it back.
            </span>
          )}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="gradient"
            onClick={save}
            loading={saving}
            disabled={!name || iconPending}
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
