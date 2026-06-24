// Reverse geocoding: turn a dropped pin / current-location coordinate into a
// readable address using the Mapbox Geocoding v6 reverse endpoint. Shape of the
// result matches ResolvedAddress so it drops straight into the same checkout
// state the forward AddressAutofillInput feeds. Degrades to a coordinate string
// when Mapbox is unconfigured or returns nothing — the lat/lng (what the driver
// actually needs) is always preserved.

import type { LatLng } from './geo';
import { getMapboxToken } from './token';
import type { ResolvedAddress } from './address-autofill';

interface V6Context {
  address?: { name?: string };
  street?: { name?: string };
  neighborhood?: { name?: string };
  postcode?: { name?: string };
  place?: { name?: string };
  locality?: { name?: string };
  region?: { name?: string; region_code?: string };
}
interface V6Feature {
  properties?: {
    name?: string;
    full_address?: string;
    context?: V6Context;
  };
}

function coordLabel({ lat, lng }: LatLng): string {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

export async function reverseGeocode(point: LatLng): Promise<ResolvedAddress | null> {
  const token = getMapboxToken();
  if (!token) return null;
  const url =
    `https://api.mapbox.com/search/geocode/v6/reverse` +
    `?longitude=${encodeURIComponent(point.lng)}&latitude=${encodeURIComponent(point.lat)}` +
    `&limit=1&access_token=${encodeURIComponent(token)}`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return { line1: coordLabel(point), lat: point.lat, lng: point.lng };
  }
  if (!res.ok) return { line1: coordLabel(point), lat: point.lat, lng: point.lng };

  const data = (await res.json().catch(() => null)) as { features?: V6Feature[] } | null;
  const f = data?.features?.[0];
  if (!f?.properties) return { line1: coordLabel(point), lat: point.lat, lng: point.lng };

  const p = f.properties;
  const ctx = p.context ?? {};
  const line1 =
    p.name ||
    ctx.address?.name ||
    ctx.street?.name ||
    (p.full_address ? p.full_address.split(',')[0] : undefined) ||
    coordLabel(point);

  return {
    line1,
    city: ctx.place?.name || ctx.locality?.name || undefined,
    state: ctx.region?.region_code || ctx.region?.name || undefined,
    postal_code: ctx.postcode?.name || undefined,
    lat: point.lat,
    lng: point.lng,
  };
}

// Forward geocoding / search suggestions for the map picker — type a place or
// address, get ranked suggestions to fly the map to. Biased toward `proximity`
// (the current map centre) so nearby results rank first.
export interface GeoSuggestion {
  name: string;
  placeFormatted?: string;
  lat: number;
  lng: number;
}

interface V6FwdFeature {
  properties?: {
    name?: string;
    full_address?: string;
    place_formatted?: string;
    coordinates?: { longitude?: number; latitude?: number };
  };
  geometry?: { coordinates?: [number, number] };
}

export async function forwardGeocode(
  query: string,
  opts?: { proximity?: LatLng; limit?: number },
): Promise<GeoSuggestion[]> {
  const token = getMapboxToken();
  const q = query.trim();
  if (!token || q.length < 3) return [];
  let url =
    `https://api.mapbox.com/search/geocode/v6/forward` +
    `?q=${encodeURIComponent(q)}&limit=${opts?.limit ?? 5}&autocomplete=true` +
    `&access_token=${encodeURIComponent(token)}`;
  if (opts?.proximity) {
    url += `&proximity=${encodeURIComponent(opts.proximity.lng)},${encodeURIComponent(opts.proximity.lat)}`;
  }
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json().catch(() => null)) as { features?: V6FwdFeature[] } | null;
    return (data?.features ?? [])
      .map((f): GeoSuggestion | null => {
        const p = f.properties ?? {};
        const c = p.coordinates ?? {};
        const g = f.geometry?.coordinates ?? [];
        const lng = typeof c.longitude === 'number' ? c.longitude : g[0];
        const lat = typeof c.latitude === 'number' ? c.latitude : g[1];
        if (typeof lat !== 'number' || typeof lng !== 'number') return null;
        return {
          name: p.name || p.full_address || q,
          placeFormatted: p.place_formatted || p.full_address || undefined,
          lat,
          lng,
        };
      })
      .filter((x): x is GeoSuggestion => x !== null);
  } catch {
    return [];
  }
}
