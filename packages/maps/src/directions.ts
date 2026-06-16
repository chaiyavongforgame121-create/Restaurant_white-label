import { getMapboxToken } from './token';
import type { LatLng } from './geo';

// Mapbox Directions — used ONCE per tracking session for the route polyline.
// Never call this on a location-ping path (cost control); live ETA comes from
// the server-side heuristic on deliveries.current_eta_min.

export async function fetchRoute(from: LatLng, to: LatLng): Promise<[number, number][] | null> {
  const token = getMapboxToken();
  if (!token) return null;
  try {
    const url =
      `https://api.mapbox.com/directions/v5/mapbox/driving/` +
      `${from.lng},${from.lat};${to.lng},${to.lat}` +
      `?geometries=geojson&overview=full&access_token=${token}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      routes?: Array<{ geometry?: { coordinates?: [number, number][] } }>;
    };
    return data.routes?.[0]?.geometry?.coordinates ?? null;
  } catch {
    return null;
  }
}
