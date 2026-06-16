// Mapbox public token plumbing. Every component in this package degrades
// gracefully when the token is absent (plain inputs / static fallbacks), so
// tenants can run without Mapbox until NEXT_PUBLIC_MAPBOX_TOKEN is set.

/** mapbox-gl version pinned for the CDN stylesheet (must match package.json). */
export const MAPBOX_GL_VERSION = '3.9.0';

export function getMapboxToken(): string | null {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  return token && token.trim().length > 0 ? token.trim() : null;
}

export function hasMapboxToken(): boolean {
  return getMapboxToken() !== null;
}

let cssInjected = false;

/** Inject the mapbox-gl stylesheet once (CDN link — avoids bundler CSS imports). */
export function ensureMapboxCss(): void {
  if (cssInjected || typeof document === 'undefined') return;
  if (document.querySelector('link[data-mapbox-gl-css]')) {
    cssInjected = true;
    return;
  }
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://api.mapbox.com/mapbox-gl-js/v${MAPBOX_GL_VERSION}/mapbox-gl.css`;
  link.setAttribute('data-mapbox-gl-css', 'true');
  document.head.appendChild(link);
  cssInjected = true;
}
