/**
 * The address every "Get the FavorGO app" code in the back office points at.
 *
 * The rider app is a separate Vercel project, so admin only knows where it lives through
 * NEXT_PUBLIC_DRIVER_APP_URL. Unset or unusable, it falls back to the production
 * deployment — never to localhost, unlike storefrontBase(): the code is scanned by a phone,
 * and a phone cannot reach the laptop's localhost, so a dev fallback would print a code
 * that opens nothing.
 *
 * Only the origin is kept, on purpose:
 *  - The rider app lives at the root (manifest scope "/"). Its root redirects to /app/home,
 *    the manifest start_url, which sends a signed-out rider on to /login — so one short
 *    address serves a new rider, a returning one and an installed app alike, and survives
 *    the app moving its own screens around.
 *  - There is no branch-specific landing to add. The apply screen lists every active branch
 *    and reads no parameter, and the sign-in redirect drops any query string anyway, so a
 *    `?branch=` here would be a promise the rider app does not keep.
 *  - A path, query or `user:pass@` pasted into the variable never reaches a printed code.
 */
export const DRIVER_APP_FALLBACK_URL = 'https://restaurant-white-label-driver.vercel.app';

/**
 * Plain http is accepted only for a developer pointing admin at their own machine. The
 * `*.localhost` names are how the apps are run side by side locally (driver.localhost:3001),
 * because cookies are scoped by host and a shared `localhost` gives all three one identity.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const isLoopback = (hostname: string) =>
  LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost');

export function driverAppUrl(configured?: string | null): string {
  const raw = configured?.trim();
  if (!raw) return DRIVER_APP_FALLBACK_URL;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return DRIVER_APP_FALLBACK_URL;
  }

  const secure = parsed.protocol === 'https:';
  const localDev = parsed.protocol === 'http:' && isLoopback(parsed.hostname);
  if (!secure && !localDev) return DRIVER_APP_FALLBACK_URL;
  return parsed.origin;
}

/**
 * The configured rider-app address. Read here, in one place, as the literal
 * `process.env.NEXT_PUBLIC_…` expression Next.js inlines at build time.
 */
export function configuredDriverAppUrl(): string {
  return driverAppUrl(process.env.NEXT_PUBLIC_DRIVER_APP_URL);
}
