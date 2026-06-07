// Next.js instrumentation hook — runs once per runtime (nodejs / edge).
// Sentry uses this to register its handlers. No-op if @sentry/nextjs DSN unset.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

export { onRequestError } from '@sentry/nextjs';
