'use client';

// Delivery tracking map: branch + dropoff markers, optional live driver puck,
// optional route polyline. Pure presentational — callers feed coordinates
// (e.g. from the deliveries realtime row) and an optional route GeoJSON.

import * as React from 'react';
import type { Map as MapboxMap, Marker as MapboxMarker } from 'mapbox-gl';
import { MapView } from './map-view';
import { bearingDeg, isValidLatLng, type LatLng } from './geo';

export interface DeliveryMapProps {
  branch: LatLng;
  dropoff?: LatLng | null;
  driver?: (LatLng & { headingDeg?: number }) | null;
  /** GeoJSON LineString coordinates [[lng,lat],...] for the route polyline. */
  routeCoordinates?: [number, number][] | null;
  className?: string;
  fallback?: React.ReactNode;
}

function markerElement(emoji: string, bg: string): HTMLDivElement {
  const el = document.createElement('div');
  el.style.cssText = `width:34px;height:34px;border-radius:50%;background:${bg};display:grid;place-items:center;font-size:16px;box-shadow:0 2px 8px rgba(0,0,0,0.25);border:2px solid #fff;`;
  el.textContent = emoji;
  return el;
}

const ROUTE_SOURCE_ID = 'favornoms-route';

export function DeliveryMap({
  branch,
  dropoff,
  driver,
  routeCoordinates,
  className,
  fallback = null,
}: DeliveryMapProps) {
  const mapRef = React.useRef<MapboxMap | null>(null);
  const driverMarkerRef = React.useRef<MapboxMarker | null>(null);
  const staticMarkersRef = React.useRef<MapboxMarker[]>([]);
  const lastDriverRef = React.useRef<LatLng | null>(null);

  const applyRoute = React.useCallback((map: MapboxMap, coords: [number, number][] | null | undefined) => {
    const data = {
      type: 'Feature' as const,
      properties: {},
      geometry: { type: 'LineString' as const, coordinates: coords ?? [] },
    };
    const existing = map.getSource(ROUTE_SOURCE_ID) as { setData: (d: unknown) => void } | undefined;
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
  }, []);

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
        applyRoute(map, routeCoordinates);
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
      driverMarkerRef.current?.remove();
      driverMarkerRef.current = null;
      lastDriverRef.current = null;
      return;
    }
    void (async () => {
      const mapboxgl = (await import('mapbox-gl')).default;
      const heading =
        driver.headingDeg ??
        (lastDriverRef.current ? bearingDeg(lastDriverRef.current, driver) : 0);
      if (!driverMarkerRef.current) {
        driverMarkerRef.current = new mapboxgl.Marker({
          element: markerElement('🛵', '#1F6FEB'),
          rotationAlignment: 'map',
        })
          .setLngLat([driver.lng, driver.lat])
          .addTo(map);
      } else {
        driverMarkerRef.current.setLngLat([driver.lng, driver.lat]);
      }
      driverMarkerRef.current.setRotation(heading);
      lastDriverRef.current = { lat: driver.lat, lng: driver.lng };
    })();
  }, [driver]);

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
