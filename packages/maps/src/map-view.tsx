'use client';

// SSR-safe mapbox-gl wrapper: the GL library is imported inside an effect so
// nothing touches `window` during server rendering. Without a token it renders
// the children-less fallback so callers can ship before Mapbox is configured.

import * as React from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { ensureMapboxCss, getMapboxToken } from './token';
import type { LatLng } from './geo';

export interface MapViewProps {
  center: LatLng;
  zoom?: number;
  className?: string;
  /** Called once the map instance is ready (style loaded). */
  onMapReady?: (map: MapboxMap) => void;
  /** Rendered when no Mapbox token is configured. */
  fallback?: React.ReactNode;
  /** Extra interactivity; defaults tuned for an order-tracking panel. */
  interactive?: boolean;
}

export function MapView({
  center,
  zoom = 13,
  className,
  onMapReady,
  fallback = null,
  interactive = true,
}: MapViewProps) {
  const token = getMapboxToken();
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const mapRef = React.useRef<MapboxMap | null>(null);
  const onReadyRef = React.useRef(onMapReady);
  onReadyRef.current = onMapReady;

  React.useEffect(() => {
    if (!token || !containerRef.current) return;
    let cancelled = false;

    void (async () => {
      ensureMapboxCss();
      const mapboxgl = (await import('mapbox-gl')).default;
      if (cancelled || !containerRef.current) return;
      mapboxgl.accessToken = token;
      const map = new mapboxgl.Map({
        container: containerRef.current,
        style: 'mapbox://styles/mapbox/streets-v12',
        center: [center.lng, center.lat],
        zoom,
        interactive,
        attributionControl: false,
      });
      map.addControl(new mapboxgl.AttributionControl({ compact: true }));
      mapRef.current = map;
      map.on('load', () => {
        if (!cancelled) onReadyRef.current?.(map);
      });
    })();

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // The map is created once; center/zoom updates after mount are the
    // caller's job via onMapReady (markers, fitBounds, easeTo).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (!token) return <>{fallback}</>;
  return <div ref={containerRef} className={className} />;
}
