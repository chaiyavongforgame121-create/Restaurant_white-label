// Re-exported mapbox-gl surface so consuming apps never import 'mapbox-gl'
// directly (the dependency lives in this package only — pnpm strict mode).

export type { Map as MapboxMap, Marker as MapboxMarker } from 'mapbox-gl';

export async function loadMapboxGl() {
  return (await import('mapbox-gl')).default;
}
