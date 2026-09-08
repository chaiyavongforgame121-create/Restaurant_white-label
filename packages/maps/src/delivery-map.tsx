'use client';

// Delivery tracking map: branch + dropoff markers, optional live driver puck,
// optional route polyline. Pure presentational — callers feed coordinates
// (e.g. from the deliveries realtime row) and an optional route GeoJSON.

import * as React from 'react';
import type { Map as MapboxMap, Marker as MapboxMarker } from 'mapbox-gl';
import { MapView } from './map-view';
import { bearingDeg, haversineKm, isValidLatLng, type LatLng } from './geo';

export interface DeliveryMapProps {
  branch: LatLng;
  dropoff?: LatLng | null;
  driver?: (LatLng & { headingDeg?: number }) | null;
  /** GeoJSON LineString coordinates [[lng,lat],...] for the route polyline. */
  routeCoordinates?: [number, number][] | null;
  /** The last fix is too old to trust — the puck is dimmed rather than removed. */
  driverStale?: boolean;
  className?: string;
  fallback?: React.ReactNode;
}

function markerElement(emoji: string, bg: string): HTMLDivElement {
  const el = document.createElement('div');
  el.style.cssText = `width:34px;height:34px;border-radius:50%;background:${bg};display:grid;place-items:center;font-size:16px;box-shadow:0 2px 8px rgba(0,0,0,0.25);border:2px solid #fff;transition:opacity .3s ease;`;
  el.textContent = emoji;
  return el;
}

// Must stay in step with RIDER_EMOJI / RiderIcon in packages/ui — a car on the tracking
// stepper and a scooter on the pin above it reads as two different deliveries. It is
// copied rather than imported because this package deliberately depends on nothing in the
// workspace (mapbox-gl only), and pulling in @favornoms/ui for one string would drag React
// component code into every Mapbox bundle.
const DRIVER_EMOJI = '🚗';

const ROUTE_SOURCE_ID = 'favornoms-route';
// One fix every few seconds, drawn instantly, reads as a pin teleporting down the street.
// Gliding it over roughly one heartbeat looks like a rider riding.
const GLIDE_MS = 900;
// Further than this in one step is not movement we can animate honestly: the app was
// backgrounded, the job was reassigned, or the first fix arrived. Place it, don't fly it.
const MAX_GLIDE_KM = 0.5;
// The rider leaving the frame re-frames the map — but not on every fix, or a map the
// viewer just panned fights back under their thumb.
const REFIT_COOLDOWN_MS = 10_000;

export function DeliveryMap({
  branch,
  dropoff,
  driver,
  routeCoordinates,
  driverStale = false,
  className,
  fallback = null,
}: DeliveryMapProps) {
  const mapRef = React.useRef<MapboxMap | null>(null);
  const driverMarkerRef = React.useRef<MapboxMarker | null>(null);
  const staticMarkersRef = React.useRef<MapboxMarker[]>([]);
  const lastDriverRef = React.useRef<LatLng | null>(null);
  const animRef = React.useRef<number | null>(null);
  const lastFitRef = React.useRef(0);

  // The map's 'load' event and the Directions response race, and the route usually wins:
  // handleMapReady is created once, so it used to apply the route it could see on the FIRST
  // render — null — and the effect below then bailed because the style was not loaded yet.
  // Nobody applied it after that, and the orange line simply never appeared. A ref means
  // whichever of the two finishes last is the one that draws.
  const routeRef = React.useRef(routeCoordinates);
  routeRef.current = routeCoordinates;

  const applyRoute = React.useCallback(
    (map: MapboxMap, coords: [number, number][] | null | undefined) => {
      const data = {
        type: 'Feature' as const,
        properties: {},
        geometry: { type: 'LineString' as const, coordinates: coords ?? [] },
      };
      const existing = map.getSource(ROUTE_SOURCE_ID) as
        | { setData: (d: unknown) => void }
        | undefined;
      if (existing) {
        existing.setData(data);
        return;
      }
      map.addSource(ROUTE_SOURCE_ID, { type: 'geojson', data });
      map.addLayer({
        id: ROUTE_SOURCE_ID,
        type: 'line',
        source: ROUTE_SOURCE_ID,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#FF6B35', 'line-width': 4, 'line-opacity': 0.85 },
      });
    },
    [],
  );

  const fitAll = React.useCallback(
    async (map: MapboxMap) => {
      const mapboxgl = (await import('mapbox-gl')).default;
      const bounds = new mapboxgl.LngLatBounds();
      bounds.extend([branch.lng, branch.lat]);
      if (isValidLatLng(dropoff)) bounds.extend([dropoff.lng, dropoff.lat]);
      if (isValidLatLng(driver)) bounds.extend([driver.lng, driver.lat]);
      map.fitBounds(bounds, { padding: 56, maxZoom: 15.5, duration: 600 });
    },
    [branch, dropoff, driver],
  );

  const handleMapReady = React.useCallback(
    (map: MapboxMap) => {
      mapRef.current = map;
      void (async () => {
        const mapboxgl = (await import('mapbox-gl')).default;
        staticMarkersRef.current.forEach((m) => m.remove());
        staticMarkersRef.current = [];
        const branchMarker = new mapboxgl.Marker({ element: markerElement('🏪', '#FF6B35') })
          .setLngLat([branch.lng, branch.lat])
          .addTo(map);
        staticMarkersRef.current.push(branchMarker);
        if (isValidLatLng(dropoff)) {
          const dropMarker = new mapboxgl.Marker({ element: markerElement('🏠', '#2D936C') })
            .setLngLat([dropoff.lng, dropoff.lat])
            .addTo(map);
          staticMarkersRef.current.push(dropMarker);
        }
        applyRoute(map, routeRef.current);
        await fitAll(map);
      })();
    },
    // Recreating the map on branch/dropoff identity change is acceptable —
    // they are stable for the lifetime of one order's tracking session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Live driver marker: create/move on every position update.
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!isValidLatLng(driver)) {
      if (animRef.current !== null) {
        cancelAnimationFrame(animRef.current);
        animRef.current = null;
      }
      driverMarkerRef.current?.remove();
      driverMarkerRef.current = null;
      lastDriverRef.current = null;
      return;
    }
    const target: LatLng = { lat: driver.lat, lng: driver.lng };
    const headingHint = driver.headingDeg;
    void (async () => {
      const mapboxgl = (await import('mapbox-gl')).default;
      const heading =
        headingHint ?? (lastDriverRef.current ? bearingDeg(lastDriverRef.current, target) : 0);

      let marker = driverMarkerRef.current;
      if (!marker) {
        marker = new mapboxgl.Marker({
          element: markerElement(DRIVER_EMOJI, '#1F6FEB'),
          rotationAlignment: 'map',
        })
          .setLngLat([target.lng, target.lat])
          .addTo(map);
        driverMarkerRef.current = marker;
      } else {
        const from = marker.getLngLat();
        if (animRef.current !== null) {
          cancelAnimationFrame(animRef.current);
          animRef.current = null;
        }
        const moved = haversineKm({ lat: from.lat, lng: from.lng }, target);
        if (moved > MAX_GLIDE_KM) {
          marker.setLngLat([target.lng, target.lat]);
        } else {
          const glider = marker;
          const start = performance.now();
          const step = (t: number) => {
            const k = Math.min(1, (t - start) / GLIDE_MS);
            const eased = 1 - Math.pow(1 - k, 3);
            glider.setLngLat([
              from.lng + (target.lng - from.lng) * eased,
              from.lat + (target.lat - from.lat) * eased,
            ]);
            animRef.current = k < 1 ? requestAnimationFrame(step) : null;
          };
          animRef.current = requestAnimationFrame(step);
        }
      }
      marker.setRotation(heading);
      marker.getElement().style.opacity = driverStale ? '0.45' : '1';
      lastDriverRef.current = target;

      // fitBounds ran once, at map-ready, when the driver was still null — so the frame was
      // branch + dropoff only and a rider approaching from outside it stayed off-screen for
      // the whole leg. Re-frame when the puck leaves the viewport, and only then.
      const bounds = map.getBounds();
      const now = Date.now();
      if (
        bounds &&
        !bounds.contains([target.lng, target.lat]) &&
        now - lastFitRef.current > REFIT_COOLDOWN_MS
      ) {
        lastFitRef.current = now;
        const next = new mapboxgl.LngLatBounds();
        next.extend([branch.lng, branch.lat]);
        if (isValidLatLng(dropoff)) next.extend([dropoff.lng, dropoff.lat]);
        next.extend([target.lng, target.lat]);
        map.fitBounds(next, { padding: 56, maxZoom: 15.5, duration: 600 });
      }
    })();
  }, [driver, driverStale, branch, dropoff]);

  // A frozen puck at full strength claims to be live. Dim it as soon as the caller says the
  // fix has gone quiet, without waiting for a position that may never come.
  React.useEffect(() => {
    const el = driverMarkerRef.current?.getElement();
    if (el) el.style.opacity = driverStale ? '0.45' : '1';
  }, [driverStale]);

  React.useEffect(
    () => () => {
      if (animRef.current !== null) cancelAnimationFrame(animRef.current);
      animRef.current = null;
    },
    [],
  );

  // Route updates (e.g. leg change pickup → dropoff).
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    applyRoute(map, routeCoordinates);
  }, [routeCoordinates, applyRoute]);

  return (
    <MapView
      center={branch}
      className={className}
      onMapReady={handleMapReady}
      fallback={fallback}
    />
  );
}
