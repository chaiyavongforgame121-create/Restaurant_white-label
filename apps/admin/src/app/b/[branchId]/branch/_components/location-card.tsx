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
import { AlertTriangle, MapPin, Pencil } from 'lucide-react';
import { Button, Card } from '@favornoms/ui';
import dynamic from 'next/dynamic';
import { hasMapboxToken, type ResolvedAddress } from '@favornoms/maps';
import { getBrowserClient } from '@favornoms/database/client';

// The picker is behind a button most visits never press, and /branch is already the
// heaviest screen in the back office. Loading it on demand keeps the cost of adding this
// card off every page view.
const LocationPicker = dynamic(
  () => import('@favornoms/maps').then((m) => m.LocationPicker),
  {
    ssr: false,
    loading: () => (
      <div className="grid h-full place-items-center text-sm text-muted-foreground">
        Loading map…
      </div>
    ),
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
 *  hour early every single day — silently, because nothing else contradicts it. */
const US_TIMEZONES: Array<{ value: string; label: string }> = [
  { value: 'America/New_York', label: 'Eastern — New York, Miami, Atlanta' },
  { value: 'America/Chicago', label: 'Central — Chicago, Houston, Dallas' },
  { value: 'America/Denver', label: 'Mountain — Denver, Salt Lake City' },
  { value: 'America/Phoenix', label: 'Arizona — Phoenix (no daylight saving)' },
  { value: 'America/Los_Angeles', label: 'Pacific — Los Angeles, Seattle' },
  { value: 'America/Anchorage', label: 'Alaska — Anchorage' },
  { value: 'Pacific/Honolulu', label: 'Hawaii — Honolulu' },
];

function formatResolved(a: ResolvedAddress): string {
  const tail = [a.state, a.postal_code].filter(Boolean).join(' ');
  return [a.line1, a.line2, a.city, tail].filter(Boolean).join(', ');
}

export function LocationCard({ branch }: { branch: BranchLocation }) {
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
      // The RPC's own hints are written for a merchant to read, so pass them through rather
      // than replacing them with something vaguer.
      setError(rpcError.hint ?? rpcError.message);
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
      setError('Enter both latitude and longitude as numbers.');
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
      setError(updateError.message);
      return;
    }
    setSaved(true);
    router.refresh();
  };

  return (
    <Card className="p-5">
      <h2 className="font-display text-lg font-semibold">Location</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Where this branch actually is. Delivery fees, rider dispatch and order batching are
        all measured from this pin — not from the address text.
      </p>

      {!hasPin && (
        <div className="mt-4 flex items-start gap-3 rounded-xl border border-danger/40 bg-danger/10 p-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-danger" />
          <div className="text-sm">
            <p className="font-semibold text-danger">No pin set — delivery cannot dispatch</p>
            <p className="mt-0.5 text-muted-foreground">
              find_dispatch_candidates needs a location, so no rider will ever be offered an
              order from this branch until one is set.
            </p>
          </div>
        </div>
      )}

      <div className="mt-4 space-y-3">
        <div className="rounded-xl border border-border p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium text-muted-foreground">Address</p>
              <p className="mt-0.5 break-words text-sm font-semibold">
                {branch.address || <span className="text-muted-foreground">Not set</span>}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                <MapPin className="mr-1 inline h-3.5 w-3.5" />
                {hasPin
                  ? `${branch.geo_lat!.toFixed(5)}, ${branch.geo_lng!.toFixed(5)}`
                  : 'no coordinates'}
              </p>
            </div>
            {mapAvailable && (
              <Button variant="outline" size="sm" onClick={() => setPicking(true)}>
                <Pencil className="mr-1.5 h-4 w-4" />
                {hasPin ? 'Move' : 'Set'}
              </Button>
            )}
          </div>
        </div>

        {/* Mapbox is an env var away from being absent in any given deployment, and a
            branch that cannot be located cannot take a delivery order. The typed fallback
            keeps the feature reachable rather than rendering a dead card. */}
        {!mapAvailable && (
          <div className="rounded-xl border border-border p-3">
            <p className="text-sm font-medium">Enter the location manually</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              The map needs NEXT_PUBLIC_MAPBOX_TOKEN, which is not set here. Coordinates can
              be copied from Google Maps: right-click the store, and the first item is
              &ldquo;latitude, longitude&rdquo;.
            </p>
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
                placeholder="Latitude"
                className="focus-ring w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
              />
              <input
                value={manualLng}
                onChange={(e) => setManualLng(e.target.value)}
                inputMode="decimal"
                placeholder="Longitude"
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
              Save location
            </Button>
          </div>
        )}

        <div className="rounded-xl border border-border p-3">
          <label className="block">
            <span className="text-xs font-medium text-muted-foreground">Time zone</span>
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="focus-ring mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
            >
              {/* Keep whatever is stored selectable even when it is not in the US list, so
                  opening this card can never silently rewrite a branch's zone. */}
              {!US_TIMEZONES.some((t) => t.value === branch.timezone) && (
                <option value={branch.timezone}>{branch.timezone}</option>
              )}
              {US_TIMEZONES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <p className="mt-1.5 text-xs text-muted-foreground">
            Opening hours and delivery windows are read in this zone. Set it to the zone the
            store is physically in, not head office.
          </p>
          {timezone !== branch.timezone && (
            <Button variant="outline" size="sm" className="mt-3" loading={saving} onClick={saveTimezone}>
              Save time zone
            </Button>
          )}
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      {saved && !error && <p className="mt-3 text-sm text-success">Saved.</p>}

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
              <h3 className="font-display text-lg font-semibold">Set branch location</h3>
              <Button variant="ghost" size="sm" onClick={() => setPicking(false)}>
                Cancel
              </Button>
            </header>
            <div className="h-[60vh]">
              <LocationPicker
                initial={hasPin ? { lat: branch.geo_lat!, lng: branch.geo_lng! } : null}
                onConfirm={(addr: ResolvedAddress) =>
                  void commit(formatResolved(addr), addr.lat, addr.lng)
                }
                labels={{
                  confirm: 'Use this as the branch address',
                  dragHint: 'Search for the store, or drag the map so the pin sits on it',
                  searchPlaceholder: 'Search for the restaurant address',
                }}
              />
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
