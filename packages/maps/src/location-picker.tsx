'use client';

// Interactive "drop a pin" location picker. The pin is fixed to the centre of
// the viewport and the map pans underneath it (the robust mobile pattern used by
// Grab / Uber Eats — no fiddly draggable marker). Every time the map settles we
// reverse-geocode the centre so the resolved address stays in sync, and a
// "use my current location" button flies the map to the device position.
//
// Styling is inline + CSS custom properties (hsl(var(--primary)) …) so the
// component looks on-brand without depending on the host app's Tailwind build.

import * as React from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { ensureMapboxCss, getMapboxToken } from './token';
import type { LatLng } from './geo';
import type { ResolvedAddress } from './address-autofill';
import { reverseGeocode, forwardGeocode, type GeoSuggestion } from './reverse-geocode';
import {
  GeolocationError,
  getCurrentPosition,
  isGeolocationAvailable,
  type GeolocationFailure,
} from './geolocation';

export interface LocationPickerLabels {
  confirm: string;
  useCurrentLocation: string;
  locating: string;
  searching: string;
  dragHint: string;
  searchPlaceholder: string;
  unavailable: string;
  geoErrors: Record<GeolocationFailure, string>;
}

export interface LocationPickerProps {
  /** Where to centre initially (a previously-picked point). */
  initial?: LatLng | null;
  /** Fallback centre when there's no initial point (e.g. the restaurant). */
  fallbackCenter?: LatLng | null;
  onConfirm: (address: ResolvedAddress) => void;
  className?: string;
  labels?: Partial<LocationPickerLabels>;
}

const DEFAULT_CENTER: LatLng = { lat: 40.7128, lng: -74.006 };

function coordLabel({ lat, lng }: LatLng): string {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

const DEFAULT_LABELS: LocationPickerLabels = {
  confirm: 'Confirm this location',
  useCurrentLocation: 'Use my current location',
  locating: 'Finding your location…',
  searching: 'Finding address…',
  dragHint: 'Search or drag the map to set the exact spot',
  searchPlaceholder: 'Search address or place',
  unavailable: 'The map is unavailable right now.',
  geoErrors: {
    unsupported: "Your browser doesn't support location.",
    insecure_context: 'Current location needs a secure (https) connection — drag the map instead.',
    denied: 'Location permission was denied — drag the map to set your spot.',
    unavailable: "Couldn't find your location — drag the map instead.",
    timeout: 'Locating timed out — try again or drag the map.',
  },
};

export function LocationPicker({
  initial,
  fallbackCenter,
  onConfirm,
  className,
  labels,
}: LocationPickerProps) {
  const L: LocationPickerLabels = {
    ...DEFAULT_LABELS,
    ...labels,
    geoErrors: { ...DEFAULT_LABELS.geoErrors, ...labels?.geoErrors },
  };
  const token = getMapboxToken();
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const mapRef = React.useRef<MapboxMap | null>(null);
  const seqRef = React.useRef(0); // discards stale reverse-geocode responses
  const [resolved, setResolved] = React.useState<ResolvedAddress | null>(null);
  const [searching, setSearching] = React.useState(false);
  const [locating, setLocating] = React.useState(false);
  const [geoError, setGeoError] = React.useState<string | null>(null);
  const [mapError, setMapError] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [suggestions, setSuggestions] = React.useState<GeoSuggestion[]>([]);
  const [searchingFwd, setSearchingFwd] = React.useState(false);
  const skipNextSearchRef = React.useRef(false);

  const startCenter = initial ?? fallbackCenter ?? DEFAULT_CENTER;
  // The branch centre (fallbackCenter) is fetched async and may arrive after the
  // map is created — keep a ref so we can recentre without re-running the
  // create-once effect.
  const fallbackRef = React.useRef(fallbackCenter);
  fallbackRef.current = fallbackCenter;
  // Once the user pans/zooms themselves, never yank the map back programmatically.
  const hasUserMovedRef = React.useRef(false);

  const resolveCenter = React.useCallback(async (center: LatLng) => {
    const seq = ++seqRef.current;
    setSearching(true);
    const r = await reverseGeocode(center);
    if (seq !== seqRef.current) return; // a newer move superseded this lookup
    setResolved(r ?? { line1: coordLabel(center), lat: center.lat, lng: center.lng });
    setSearching(false);
  }, []);

  // Pan to the branch centre when it lands after the map is up — but only when
  // the user hasn't taken over and no explicit initial point was given.
  const recenterToFallback = React.useCallback(() => {
    const map = mapRef.current;
    const fc = fallbackRef.current;
    if (!map || initial || hasUserMovedRef.current || !fc) return false;
    map.jumpTo({ center: [fc.lng, fc.lat], zoom: 14 }); // fires moveend → re-geocode
    return true;
  }, [initial]);

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
        center: [startCenter.lng, startCenter.lat],
        zoom: initial ? 16 : 12,
        attributionControl: false,
      });
      map.addControl(new mapboxgl.AttributionControl({ compact: true }));
      map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
      mapRef.current = map;
      // Seed a coordinate-only result up front so the Confirm button is never
      // wedged disabled — even if the style/token fails and 'load' never fires.
      // 'load'/'moveend' refine this into a real address moments later.
      setResolved({ line1: coordLabel(startCenter), lat: startCenter.lat, lng: startCenter.lng });
      // Surface a hard map failure (bad token, blocked CDN) instead of a blank canvas.
      map.on('error', () => {
        if (!cancelled) setMapError(true);
      });
      map.on('load', () => {
        if (cancelled) return;
        // The sheet may still be animating open when the map mounts; a resize
        // after load makes the canvas fill its (now-settled) container.
        map.resize();
        // Jump to the branch centre if it's known; otherwise geocode where we are.
        if (!recenterToFallback()) {
          const c = map.getCenter();
          void resolveCenter({ lat: c.lat, lng: c.lng });
        }
      });
      map.on('moveend', (ev) => {
        if (cancelled) return;
        // A user gesture carries an originalEvent; programmatic flyTo/jumpTo don't.
        if ((ev as { originalEvent?: unknown }).originalEvent) hasUserMovedRef.current = true;
        const c = map.getCenter();
        void resolveCenter({ lat: c.lat, lng: c.lng });
      });
    })();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // The map is created once; startCenter/initial are only read at creation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Branch centre arriving after the map mounted → recentre once.
  React.useEffect(() => {
    recenterToFallback();
  }, [fallbackCenter, recenterToFallback]);

  // Debounced forward-geocode for the search box, biased toward the map centre.
  React.useEffect(() => {
    if (skipNextSearchRef.current) {
      skipNextSearchRef.current = false; // a suggestion was just picked — don't re-search
      setSuggestions([]);
      setSearchingFwd(false);
      return;
    }
    const q = query.trim();
    if (q.length < 3) {
      setSuggestions([]);
      setSearchingFwd(false);
      return;
    }
    let cancelled = false;
    setSearchingFwd(true);
    const timer = setTimeout(async () => {
      const c = mapRef.current?.getCenter();
      const res = await forwardGeocode(q, {
        proximity: c ? { lat: c.lat, lng: c.lng } : undefined,
      });
      if (!cancelled) {
        setSuggestions(res);
        setSearchingFwd(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const handleSelectSuggestion = (s: GeoSuggestion) => {
    hasUserMovedRef.current = true; // searching means the user is taking control
    skipNextSearchRef.current = true;
    setQuery(s.name);
    setSuggestions([]);
    mapRef.current?.flyTo({ center: [s.lng, s.lat], zoom: 16, duration: 800 });
    // 'moveend' fires after flyTo and reverse-geocodes the precise pin.
  };

  const handleUseCurrent = async () => {
    setGeoError(null);
    setLocating(true);
    try {
      const pos = await getCurrentPosition();
      mapRef.current?.flyTo({ center: [pos.lng, pos.lat], zoom: 16, duration: 800 });
      // 'moveend' fires after flyTo and reverse-geocodes the new centre.
    } catch (e) {
      const reason: GeolocationFailure = e instanceof GeolocationError ? e.reason : 'unavailable';
      setGeoError(L.geoErrors[reason] ?? L.geoErrors.unavailable);
    } finally {
      setLocating(false);
    }
  };

  if (!token) {
    return (
      <div className={className} style={{ display: 'grid', placeItems: 'center', padding: '2rem' }}>
        <p style={{ color: 'hsl(var(--muted-foreground))', fontSize: 14, textAlign: 'center' }}>
          {L.unavailable}
        </p>
      </div>
    );
  }

  const geoAvailable = isGeolocationAvailable();

  return (
    <div className={className} style={{ display: 'flex', flexDirection: 'column', minHeight: '60vh' }}>
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />

        {/* Fixed centre pin (tip points at the map centre). */}
        <div
          aria-hidden
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -100%)',
            pointerEvents: 'none',
            filter: 'drop-shadow(0 4px 6px rgba(0,0,0,0.3))',
            zIndex: 2,
          }}
        >
          <CenterPin />
        </div>
        {/* Ground shadow under the pin tip. */}
        <div
          aria-hidden
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -1px)',
            width: 8,
            height: 4,
            borderRadius: '50%',
            background: 'rgba(0,0,0,0.35)',
            pointerEvents: 'none',
            zIndex: 1,
          }}
        />

        {/* Search box — type a place/address to fly the map there, then fine-tune. */}
        <div style={{ position: 'absolute', top: 10, left: 10, right: 10, zIndex: 3 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              height: 46,
              padding: '0 12px',
              borderRadius: 12,
              background: 'hsl(var(--card))',
              boxShadow: '0 2px 12px rgba(0,0,0,0.18)',
            }}
          >
            <SearchIcon />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={L.searchPlaceholder}
              aria-label={L.searchPlaceholder}
              style={{
                flex: 1,
                minWidth: 0,
                border: 'none',
                outline: 'none',
                background: 'transparent',
                fontSize: 15,
                color: 'hsl(var(--foreground))',
              }}
            />
            {searchingFwd && <SpinnerIcon />}
            {query && !searchingFwd && (
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  setSuggestions([]);
                }}
                aria-label="Clear"
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: 'hsl(var(--muted-foreground))',
                  cursor: 'pointer',
                  fontSize: 18,
                  lineHeight: 1,
                  padding: 4,
                }}
              >
                ×
              </button>
            )}
          </div>
          {suggestions.length > 0 && (
            <ul
              style={{
                listStyle: 'none',
                margin: '6px 0 0',
                padding: 6,
                borderRadius: 12,
                background: 'hsl(var(--card))',
                boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
                maxHeight: 230,
                overflowY: 'auto',
              }}
            >
              {suggestions.map((s, i) => (
                <li key={`${s.lat},${s.lng},${i}`}>
                  <button
                    type="button"
                    onClick={() => handleSelectSuggestion(s)}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 8,
                      textAlign: 'left',
                      padding: '9px 10px',
                      border: 'none',
                      borderRadius: 8,
                      background: 'transparent',
                      cursor: 'pointer',
                    }}
                  >
                    <span style={{ marginTop: 2 }}>
                      <PinDot />
                    </span>
                    <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                      <span
                        style={{
                          fontSize: 14,
                          fontWeight: 600,
                          color: 'hsl(var(--foreground))',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {s.name}
                      </span>
                      {s.placeFormatted && (
                        <span
                          style={{
                            fontSize: 12,
                            color: 'hsl(var(--muted-foreground))',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {s.placeFormatted}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <button
          type="button"
          onClick={handleUseCurrent}
          disabled={locating}
          style={{
            position: 'absolute',
            bottom: 16,
            right: 12,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 14px',
            borderRadius: 999,
            border: 'none',
            background: 'hsl(var(--card))',
            color: 'hsl(var(--primary))',
            fontSize: 14,
            fontWeight: 600,
            cursor: locating ? 'default' : 'pointer',
            boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
            opacity: geoAvailable ? 1 : 0.85,
            zIndex: 2,
          }}
        >
          <CrosshairIcon spinning={locating} />
          {locating ? L.locating : L.useCurrentLocation}
        </button>
      </div>

      <div
        style={{
          padding: '14px 16px calc(14px + env(safe-area-inset-bottom))',
          borderTop: '1px solid hsl(var(--border))',
          background: 'hsl(var(--card))',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        {mapError && (
          <p style={{ margin: 0, fontSize: 13, color: 'hsl(var(--warning, 38 92% 50%))' }}>{L.unavailable}</p>
        )}
        {geoError && (
          <p style={{ margin: 0, fontSize: 13, color: 'hsl(var(--warning, 38 92% 50%))' }}>{geoError}</p>
        )}
        <p style={{ margin: 0, fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>{L.dragHint}</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 24 }}>
          <PinDot />
          <span
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: searching ? 'hsl(var(--muted-foreground))' : 'hsl(var(--foreground))',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {searching ? L.searching : resolved?.line1 || '—'}
          </span>
        </div>
        <button
          type="button"
          onClick={() => resolved && onConfirm(resolved)}
          disabled={!resolved || searching}
          style={{
            width: '100%',
            height: 52,
            borderRadius: 14,
            border: 'none',
            background:
              !resolved || searching
                ? 'hsl(var(--muted))'
                : 'linear-gradient(135deg, hsl(var(--primary)), hsl(var(--primary) / 0.85))',
            color: !resolved || searching ? 'hsl(var(--muted-foreground))' : 'hsl(var(--primary-foreground))',
            fontSize: 16,
            fontWeight: 700,
            cursor: !resolved || searching ? 'default' : 'pointer',
          }}
        >
          {L.confirm}
        </button>
      </div>
    </div>
  );
}

function CenterPin() {
  return (
    <svg width="36" height="48" viewBox="0 0 36 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M18 0C8.06 0 0 8.06 0 18c0 12.5 18 30 18 30s18-17.5 18-30C36 8.06 27.94 0 18 0z"
        fill="hsl(var(--primary))"
      />
      <circle cx="18" cy="18" r="6.5" fill="hsl(var(--primary-foreground, 0 0% 100%))" />
    </svg>
  );
}

function PinDot() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
      <path
        d="M12 2C7.6 2 4 5.6 4 10c0 5.5 8 12 8 12s8-6.5 8-12c0-4.4-3.6-8-8-8z"
        fill="hsl(var(--primary))"
      />
      <circle cx="12" cy="10" r="3" fill="hsl(var(--primary-foreground, 0 0% 100%))" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="hsl(var(--muted-foreground))"
      strokeWidth="2"
      strokeLinecap="round"
      style={{ flexShrink: 0 }}
    >
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="hsl(var(--primary))"
      strokeWidth="2.5"
      strokeLinecap="round"
      style={{ flexShrink: 0, animation: 'fnms-spin 0.8s linear infinite' }}
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      <style>{`@keyframes fnms-spin { to { transform: rotate(360deg) } }`}</style>
    </svg>
  );
}

function CrosshairIcon({ spinning }: { spinning?: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      style={spinning ? { animation: 'fnms-spin 0.9s linear infinite' } : undefined}
    >
      <circle cx="12" cy="12" r="7" />
      <line x1="12" y1="1" x2="12" y2="4" />
      <line x1="12" y1="20" x2="12" y2="23" />
      <line x1="1" y1="12" x2="4" y2="12" />
      <line x1="20" y1="12" x2="23" y2="12" />
      <style>{`@keyframes fnms-spin { to { transform: rotate(360deg) } }`}</style>
    </svg>
  );
}
