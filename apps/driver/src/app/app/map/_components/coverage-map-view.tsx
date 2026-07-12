'use client';

import * as React from 'react';
import Link from 'next/link';
import { LocateFixed, MapPin, Store } from 'lucide-react';
import {
  MapView,
  loadMapboxGl,
  getCurrentPosition,
  haversineKm,
  type LatLng,
  type MapboxMap,
  type MapboxMarker,
} from '@favornoms/maps';
import { kmToMi } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { getBranchLocations, type BranchLocation } from '@favornoms/database/queries';
import { Button, Card, EmptyState, cn } from '@favornoms/ui';
import { useDriverSession } from '@/components/driver-session';

// Shows the rider's live position against every restaurant they're approved for,
// each drawn with its dispatch radius (settings.driver_search_radius_km — the SAME
// circle find_dispatch_candidates uses). Green = in range (can receive that
// restaurant's orders), grey = out of range.

const IN = '#16a34a';
const OUT = '#9ca3af';

/** GeoJSON polygon approximating a circle of `radiusKm` around (lng,lat). */
function circleFeature(lng: number, lat: number, radiusKm: number, inRange: boolean): GeoJSON.Feature {
  const points = 64;
  const dx = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  const dy = radiusKm / 110.574;
  const ring: Array<[number, number]> = [];
  for (let i = 0; i < points; i++) {
    const theta = (i / points) * 2 * Math.PI;
    ring.push([lng + dx * Math.cos(theta), lat + dy * Math.sin(theta)]);
  }
  ring.push(ring[0]!);
  return { type: 'Feature', properties: { inRange }, geometry: { type: 'Polygon', coordinates: [ring] } };
}

// Minimal structural view of the mapbox map for the imperative calls we make,
// so we don't fight the full style-spec typings for sources/layers.
interface MapLike {
  getSource: (id: string) => { setData: (d: unknown) => void } | undefined;
  addSource: (id: string, src: unknown) => void;
  addLayer: (layer: unknown) => void;
  fitBounds: (bounds: [[number, number], [number, number]], opts?: unknown) => void;
  easeTo: (opts: unknown) => void;
}

export function CoverageMapView() {
  const { driver } = useDriverSession();
  const approvedIds = React.useMemo(
    () => (driver.approvals ?? []).filter((a) => a.status === 'approved').map((a) => a.branch_id),
    [driver.approvals],
  );

  const [branches, setBranches] = React.useState<BranchLocation[] | null>(null);
  const [rider, setRider] = React.useState<LatLng | null>(null);
  const [geoErr, setGeoErr] = React.useState<string | null>(null);
  const [locating, setLocating] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const supabase = getBrowserClient();
      const rows = await getBranchLocations(supabase, approvedIds);
      if (!cancelled) setBranches(rows);
    })();
    return () => {
      cancelled = true;
    };
  }, [approvedIds]);

  const locate = React.useCallback(async () => {
    setLocating(true);
    setGeoErr(null);
    try {
      setRider(await getCurrentPosition());
    } catch {
      setGeoErr('Turn on location access to see whether you’re in range.');
    } finally {
      setLocating(false);
    }
  }, []);

  React.useEffect(() => {
    void locate();
  }, [locate]);

  const rows = React.useMemo(() => {
    return (branches ?? []).map((b) => {
      const hasCoords = b.lat != null && b.lng != null;
      const distanceKm =
        rider && hasCoords ? haversineKm(rider, { lat: b.lat as number, lng: b.lng as number }) : null;
      const inRange = distanceKm != null ? distanceKm <= b.dispatchRadiusKm : null;
      return { ...b, hasCoords, distanceKm, inRange };
    });
  }, [branches, rider]);

  const mapRef = React.useRef<MapboxMap | null>(null);
  const markersRef = React.useRef<MapboxMarker[]>([]);
  const [mapReady, setMapReady] = React.useState(false);

  const firstCoord = branches?.find((b) => b.lat != null && b.lng != null);
  const initialCenter: LatLng | null =
    rider ?? (firstCoord ? { lat: firstCoord.lat as number, lng: firstCoord.lng as number } : null);

  // Draw once the map is ready AND we have data; re-run when rider/branches change.
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    let cancelled = false;
    void (async () => {
      const mapboxgl = await loadMapboxGl();
      if (cancelled) return;
      const m = map as unknown as MapLike;

      markersRef.current.forEach((mk) => mk.remove());
      markersRef.current = [];

      const features: GeoJSON.Feature[] = [];
      const pts: Array<[number, number]> = [];

      for (const r of rows) {
        if (r.lat == null || r.lng == null) continue;
        const lng = r.lng;
        const lat = r.lat;
        pts.push([lng, lat]);
        features.push(circleFeature(lng, lat, r.dispatchRadiusKm, r.inRange === true));
        const marker = new mapboxgl.Marker({ color: r.inRange === false ? OUT : IN })
          .setLngLat([lng, lat])
          .setPopup(new mapboxgl.Popup({ offset: 24, closeButton: false }).setText(r.name))
          .addTo(map);
        markersRef.current.push(marker);
      }

      if (rider) {
        pts.push([rider.lng, rider.lat]);
        const el = document.createElement('div');
        el.style.cssText =
          'width:18px;height:18px;border-radius:9999px;background:#2563eb;border:3px solid #fff;box-shadow:0 0 0 3px rgba(37,99,235,0.35)';
        markersRef.current.push(new mapboxgl.Marker({ element: el }).setLngLat([rider.lng, rider.lat]).addTo(map));
      }

      const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features };
      const existing = m.getSource('coverage');
      if (existing) {
        existing.setData(fc);
      } else {
        m.addSource('coverage', { type: 'geojson', data: fc });
        m.addLayer({
          id: 'coverage-fill',
          type: 'fill',
          source: 'coverage',
          paint: { 'fill-color': ['case', ['get', 'inRange'], IN, OUT], 'fill-opacity': 0.12 },
        });
        m.addLayer({
          id: 'coverage-line',
          type: 'line',
          source: 'coverage',
          paint: { 'line-color': ['case', ['get', 'inRange'], IN, OUT], 'line-width': 2 },
        });
      }

      if (pts.length > 0) {
        const lngs = pts.map((p) => p[0]);
        const lats = pts.map((p) => p[1]);
        const sw: [number, number] = [Math.min(...lngs), Math.min(...lats)];
        const ne: [number, number] = [Math.max(...lngs), Math.max(...lats)];
        if (sw[0] === ne[0] && sw[1] === ne[1]) m.easeTo({ center: sw, zoom: 12 });
        else m.fitBounds([sw, ne], { padding: 56, maxZoom: 14, duration: 400 });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mapReady, rows, rider]);

  const inRangeCount = rows.filter((r) => r.inRange === true).length;

  return (
    <div className="container max-w-xl py-6">
      <header className="mb-4 flex items-start justify-between gap-3 px-1">
        <div>
          <h1 className="font-display text-2xl font-bold">Coverage</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            You only get a restaurant&apos;s orders while you&apos;re inside its circle.
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          loading={locating}
          leftIcon={<LocateFixed className="h-4 w-4" />}
          onClick={() => void locate()}
        >
          Locate
        </Button>
      </header>

      {approvedIds.length === 0 ? (
        <EmptyState
          icon={<Store className="h-7 w-7" />}
          title="No restaurants yet"
          description="Get approved to a restaurant to see your coverage."
          action={
            <Link href="/app/apply">
              <Button variant="gradient">Apply to restaurants</Button>
            </Link>
          }
        />
      ) : (
        <>
          <Card className="mb-4 overflow-hidden p-0">
            {initialCenter ? (
              <MapView
                center={initialCenter}
                zoom={12}
                className="h-72 w-full"
                onMapReady={(map) => {
                  mapRef.current = map;
                  setMapReady(true);
                }}
                fallback={
                  <div className="grid h-72 w-full place-items-center bg-muted/40 p-6 text-center text-sm text-muted-foreground">
                    Map unavailable — see the range list below.
                  </div>
                }
              />
            ) : (
              <div className="grid h-72 w-full place-items-center bg-muted/40 text-sm text-muted-foreground">
                Loading map…
              </div>
            )}
          </Card>

          {geoErr && (
            <p className="mb-3 rounded-xl bg-warning/10 px-4 py-3 text-sm text-warning">{geoErr}</p>
          )}
          {rider && branches && (
            <p className="mb-3 px-1 text-sm text-muted-foreground">
              In range of <span className="font-semibold text-foreground">{inRangeCount}</span> of{' '}
              {rows.filter((r) => r.hasCoords).length} restaurants.
            </p>
          )}

          <ul className="space-y-2">
            {rows.map((r) => (
              <li key={r.branch_id}>
                <Card className="flex items-center gap-3 p-4">
                  <span
                    className={cn(
                      'grid h-9 w-9 shrink-0 place-items-center rounded-lg',
                      r.inRange === true
                        ? 'bg-success/15 text-success'
                        : r.inRange === false
                          ? 'bg-muted text-muted-foreground'
                          : 'bg-primary/10 text-primary',
                    )}
                  >
                    <Store className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{r.name}</p>
                    <p className="flex items-center gap-1 text-xs text-muted-foreground">
                      <MapPin className="h-3 w-3" />
                      {!r.hasCoords
                        ? 'No location set'
                        : r.distanceKm == null
                          ? `within ${kmToMi(r.dispatchRadiusKm).toFixed(1)} mi to get orders`
                          : `${kmToMi(r.distanceKm).toFixed(1)} mi away · range ${kmToMi(r.dispatchRadiusKm).toFixed(1)} mi`}
                    </p>
                  </div>
                  {r.inRange != null && (
                    <span
                      className={cn(
                        'shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold',
                        r.inRange ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {r.inRange ? 'In range' : 'Out of range'}
                    </span>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
