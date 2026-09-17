'use client';

// Where the branch physically is.
//
// This card did not exist, and its absence was not cosmetic. `branches.geo_location` is the
// origin for quote_delivery (fee and distance), find_dispatch_candidates (which riders are
// even offered the job) and claim_batch_sibling (batching) — yet nothing in the back office
// could set or move it. A merchant could edit the Address text all day and the restaurant
// stayed, as far as delivery was concerned, wherever it was first seeded.
//
// Worse, the database already had the fix. set_branch_location() enforces the invariant
// "you may not change the address without also saying where that address is" and its own
// comment names the casualty: branch 44444444 ended up 1,408 mi from its own street. The
// Identity card bypassed it entirely with a plain UPDATE on branches.address, which the
// column guard permits — that guard only decides WHO may write, not whether the pin has to
// follow. Address editing now lives here, on the RPC, and nowhere else.

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { AlertTriangle, MapPin, Pencil } from 'lucide-react';
import { DEFAULT_UI_LOCALE, isUiLocale } from '@favornoms/shared';
import { Button, Card } from '@favornoms/ui';
import dynamic from 'next/dynamic';
import { hasMapboxToken, type ResolvedAddress } from '@favornoms/maps';
import { getBrowserClient } from '@favornoms/database/client';

function MapLoading() {
  const t = useTranslations('branch.location');
  return (
    <div className="grid h-full place-items-center text-sm text-muted-foreground">
      {t('loadingMap')}
    </div>
  );
}

// The picker is behind a button most visits never press, and /branch is already the
// heaviest screen in the back office. Loading it on demand keeps the cost of adding this
// card off every page view.
const LocationPicker = dynamic(
  () => import('@favornoms/maps').then((m) => m.LocationPicker),
  {
    ssr: false,
    loading: () => <MapLoading />,
  },
);

export interface BranchLocation {
  id: string;
  address: string | null;
  geo_lat: number | null;
  geo_lng: number | null;
  timezone: string;
}

/** The zones a US restaurant can be in. `timezone` decides when the branch counts as open
 *  and when a delivery window starts, so a Texas store left on America/New_York closes an
 *  hour early every single day — silently, because nothing else contradicts it.
 *  `key` names the label in branch.location.timezones; `value` is what is stored. */
const US_TIMEZONES = [
  { value: 'America/New_York', key: 'eastern' },
  { value: 'America/Chicago', key: 'central' },
  { value: 'America/Denver', key: 'mountain' },
  { value: 'America/Phoenix', key: 'arizona' },
  { value: 'America/Los_Angeles', key: 'pacific' },
  { value: 'America/Anchorage', key: 'alaska' },
  { value: 'Pacific/Honolulu', key: 'hawaii' },
] as const;

/** set_branch_location's hints for invalid_location, compared (never shown) to pick a message. */
const INVALID_LOCATION_HINTS: Record<string, 'bothRequired' | 'outOfRange' | 'dropPin'> = {
  'Latitude and longitude must be supplied together.': 'bothRequired',
  'Coordinates are out of range.': 'outOfRange',
  'Drop the pin on the store.': 'dropPin',
};

function formatResolved(a: ResolvedAddress): string {
  const tail = [a.state, a.postal_code].filter(Boolean).join(' ');
  return [a.line1, a.line2, a.city, tail].filter(Boolean).join(', ');
}

export function LocationCard({ branch }: { branch: BranchLocation }) {
  const t = useTranslations('branch');
  const rawLocale = useLocale();
  const locale = isUiLocale(rawLocale) ? rawLocale : DEFAULT_UI_LOCALE;
  const router = useRouter();
  const [picking, setPicking] = React.useState(false);
  const [timezone, setTimezone] = React.useState(branch.timezone);
  const [manualLat, setManualLat] = React.useState(branch.geo_lat?.toString() ?? '');
  const [manualLng, setManualLng] = React.useState(branch.geo_lng?.toString() ?? '');
  const [manualAddress, setManualAddress] = React.useState(branch.address ?? '');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  const hasPin = branch.geo_lat != null && branch.geo_lng != null;
  const mapAvailable = hasMapboxToken();

  const commit = async (address: string, lat: number, lng: number) => {
    setSaving(true);
    setError(null);
    setSaved(false);
    const supabase = getBrowserClient();
    const { error: rpcError } = await supabase.rpc('set_branch_location', {
      p_branch_id: branch.id,
      p_address: address,
      p_lat: lat,
      p_lng: lng,
    });
    setSaving(false);
    if (rpcError) {
      // The RPC raises stable codes with English hints for a merchant; each known one has its
      // own message here, so the merchant still learns what to do next in their language.
      console.error('Saving the branch location failed', rpcError);
      const code = rpcError.message;
      if (code.includes('invalid_location')) {
        const which = rpcError.hint ? INVALID_LOCATION_HINTS[rpcError.hint] : undefined;
        setError(t(`location.errors.${which ?? 'invalid'}`));
      } else if (code.includes('location_pin_required')) {
        setError(t('location.errors.pinRequired'));
      } else if (code.includes('not_authorized')) {
        setError(t('location.errors.notAuthorized'));
      } else if (code.includes('auth_required')) {
        setError(t('location.errors.signedOut'));
      } else if (code.includes('branch_not_found')) {
        setError(t('location.errors.branchNotFound'));
      } else {
        setError(t('errors.generic'));
      }
      return;
    }
    setPicking(false);
    setSaved(true);
    router.refresh();
  };

  const saveManual = async () => {
    const lat = Number(manualLat);
    const lng = Number(manualLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      setError(t('location.errors.notNumbers'));
      return;
    }
    await commit(manualAddress.trim(), lat, lng);
  };

  const saveTimezone = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    const supabase = getBrowserClient();
    const { error: updateError } = await supabase
      .from('branches')
      .update({ timezone })
      .eq('id', branch.id);
    setSaving(false);
    if (updateError) {
      console.error('Saving the branch time zone failed', updateError);
      setError(
        updateError.message.includes('branch_manager_required')
          ? t('errors.managerRequired')
          : updateError.code === '42501'
            ? t('errors.noPermission')
            : t('errors.generic'),
      );
      return;
    }
    setSaved(true);
    router.refresh();
  };

  return (
    <Card className="p-5">
      <h2 className="font-display text-lg font-semibold">{t('location.title')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('location.description')}</p>

      {!hasPin && (
        <div className="mt-4 flex items-start gap-3 rounded-xl border border-danger/40 bg-danger/10 p-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-danger" />
          <div className="text-sm">
            <p className="font-semibold text-danger">{t('location.noPinTitle')}</p>
            <p className="mt-0.5 text-muted-foreground">{t('location.noPinBody')}</p>
          </div>
        </div>
      )}

      <div className="mt-4 space-y-3">
        <div className="rounded-xl border border-border p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium text-muted-foreground">{t('location.address')}</p>
              <p className="mt-0.5 break-words text-sm font-semibold">
                {branch.address || <span className="text-muted-foreground">{t('location.notSet')}</span>}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                <MapPin className="mr-1 inline h-3.5 w-3.5" />
                {hasPin
                  ? `${branch.geo_lat!.toFixed(5)}, ${branch.geo_lng!.toFixed(5)}`
                  : t('location.noCoordinates')}
              </p>
            </div>
            {mapAvailable && (
              <Button variant="outline" size="sm" onClick={() => setPicking(true)}>
                <Pencil className="mr-1.5 h-4 w-4" />
                {hasPin ? t('location.move') : t('location.set')}
              </Button>
            )}
          </div>
        </div>

        {/* Mapbox is an env var away from being absent in any given deployment, and a
            branch that cannot be located cannot take a delivery order. The typed fallback
            keeps the feature reachable rather than rendering a dead card. */}
        {!mapAvailable && (
          <div className="rounded-xl border border-border p-3">
            <p className="text-sm font-medium">{t('location.manualTitle')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('location.manualHint')}</p>
            <input
              value={manualAddress}
              onChange={(e) => setManualAddress(e.target.value)}
              placeholder="9595 Six Pines Dr #1065, The Woodlands, TX 77380"
              className="focus-ring mt-3 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
            />
            <div className="mt-2 grid grid-cols-2 gap-2">
              <input
                value={manualLat}
                onChange={(e) => setManualLat(e.target.value)}
                inputMode="decimal"
                placeholder={t('location.latitude')}
                className="focus-ring w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
              />
              <input
                value={manualLng}
                onChange={(e) => setManualLng(e.target.value)}
                inputMode="decimal"
                placeholder={t('location.longitude')}
                className="focus-ring w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              loading={saving}
              onClick={saveManual}
            >
              {t('location.saveLocation')}
            </Button>
          </div>
        )}

        <div className="rounded-xl border border-border p-3">
          <label className="block">
            <span className="text-xs font-medium text-muted-foreground">{t('location.timezone')}</span>
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="focus-ring mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
            >
              {/* Keep whatever is stored selectable even when it is not in the US list, so
                  opening this card can never silently rewrite a branch's zone. */}
              {!US_TIMEZONES.some((z) => z.value === branch.timezone) && (
                <option value={branch.timezone}>{branch.timezone}</option>
              )}
              {US_TIMEZONES.map((z) => (
                <option key={z.value} value={z.value}>
                  {t(`location.timezones.${z.key}`)}
                </option>
              ))}
            </select>
          </label>
          <p className="mt-1.5 text-xs text-muted-foreground">{t('location.timezoneHint')}</p>
          {timezone !== branch.timezone && (
            <Button variant="outline" size="sm" className="mt-3" loading={saving} onClick={saveTimezone}>
              {t('location.saveTimezone')}
            </Button>
          )}
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      {saved && !error && <p className="mt-3 text-sm text-success">{t('location.saved')}</p>}

      {picking && mapAvailable && (
        <div
          className="fixed inset-0 z-[130] grid place-items-center bg-black/60 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          onClick={() => setPicking(false)}
        >
          <div
            className="w-full max-w-2xl overflow-hidden rounded-2xl bg-card shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center justify-between border-b border-border p-4">
              <h3 className="font-display text-lg font-semibold">{t('location.pickerTitle')}</h3>
              <Button variant="ghost" size="sm" onClick={() => setPicking(false)}>
                {t('location.cancel')}
              </Button>
            </header>
            <div className="h-[60vh]">
              <LocationPicker
                initial={hasPin ? { lat: branch.geo_lat!, lng: branch.geo_lng! } : null}
                onConfirm={(addr: ResolvedAddress) =>
                  void commit(formatResolved(addr), addr.lat, addr.lng)
                }
                locale={locale}
                labels={{
                  confirm: t('location.pickerConfirm'),
                  dragHint: t('location.pickerDragHint'),
                  searchPlaceholder: t('location.pickerSearch'),
                }}
              />
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
