import * as Sentry from '@sentry/nextjs';

// Older invitation links arrive with #access_token=…&refresh_token=… in the URL, and emailed links
// now land on /auth/confirm?token_hash=… (a credential until Continue is pressed). Sentry records
// navigation breadcrumbs and the page URL, so without this a later error in the same tab would
// send a live session or token to the error tracker. Query and fragment are both dropped.
const TOKEN_IN_URL = /[?#&](access_token|refresh_token|provider_token|token_hash)=/;
function scrubUrl(url: unknown): unknown {
  return typeof url === 'string' && TOKEN_IN_URL.test(url) ? url.split(/[?#]/)[0] : url;
}

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.category === 'navigation' && breadcrumb.data) {
        breadcrumb.data.from = scrubUrl(breadcrumb.data.from);
        breadcrumb.data.to = scrubUrl(breadcrumb.data.to);
      }
      return breadcrumb;
    },
    beforeSend(event) {
      if (event.request?.url) event.request.url = scrubUrl(event.request.url) as string;
      return event;
    },
    beforeSendTransaction(event) {
      if (event.request?.url) event.request.url = scrubUrl(event.request.url) as string;
      return event;
    },
    environment: process.env.NODE_ENV,
    tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES ?? 0.1),
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1.0,
    initialScope: { tags: { app: 'admin' } },
  });
}
