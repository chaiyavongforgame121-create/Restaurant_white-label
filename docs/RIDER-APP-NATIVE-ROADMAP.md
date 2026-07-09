# Rider (Driver) App → Full Native Application — Roadmap

_Authored 2026-07-09. Owner decision pending: which shell (Capacitor vs React Native)._

## TL;DR

Turning the rider app into a "full app" is **not** about the Navigate button — it's about the
**native shell**. Recommendation: **Capacitor-first, phased**. ~90% of the value (background GPS,
native push, camera, store distribution) comes from wrapping the existing, already-polished
Next.js driver UI in a native shell — no rewrite. Keep the deep-link navigation we built.
Move to React Native **only if** true in-app turn-by-turn voice navigation becomes a hard
requirement.

---

## Current state (grounded in code, 2026-07-09)

`apps/driver` is a **Next.js web PWA**:

- **Location:** `navigator.geolocation.watchPosition` → `set_driver_location` RPC
  (`src/components/driver-location-ping.tsx`). Throttled to 5s.
- **Push:** Web Push (VAPID) + service worker (`src/components/push-subscriber.tsx`,
  `public/sw.js`).
- **Map:** Mapbox GL (web) via `@favornoms/maps`; route polyline only (no turn-by-turn).
- **Navigate:** platform-aware deep-link to Google Maps / Waze / Apple Maps
  (`NavigateMenu` in `active-view.tsx`) — **carries over to native unchanged**.
- **Offers:** Supabase realtime on `deliveries` + `notifications_outbox` (`new_dispatch`).
- **Shared/reusable:** `@favornoms/database` (queries + all dispatch/penalty/pickup RPCs),
  `@favornoms/shared`, types. Supabase JS runs in both Capacitor and React Native.

## The 3 gaps a real rider app must close

| Gap | Today (PWA) | Why it breaks |
|---|---|---|
| **Background location** ⭐ biggest | `watchPosition` | Stops when screen locks / app backgrounded → the customer's live-tracking map freezes while the phone is in the rider's pocket. |
| **Push for new offers** | Web Push | iOS Web Push is flaky/PWA-only and can't wake a closed app; a rider misses offers. |
| **In-app turn-by-turn** | none (deep-link) | Needs a native Mapbox/Google Navigation SDK. Optional — deep-link is industry-standard. |

Plus: native camera, keep-awake during a run, and App Store / Play Store presence.

---

## Recommended path: Capacitor, phased

### Phase 1 — Capacitor shell + store scaffolding _(≈3–5 days)_
- Add Capacitor to `apps/driver`. Start with a **hosted-URL shell** (`server.url` → the deployed
  driver web app) so SSR / middleware / cookie auth keep working as-is. (Migrate to a bundled
  static build later only if offline launch is needed.)
- `npx cap add ios` / `android`; app icons, splash, bundle IDs.
- Accounts: **Apple Developer $99/yr**, **Google Play $25 one-time**.
- **Deliverable:** installable native app showing the current driver UI on a device.

### Phase 2 — Background geolocation _(≈4–7 days; iOS is the fiddly part)_ ⭐
- Plugin: `@capacitor-community/background-geolocation` (free) or Transistorsoft
  `@transistorsoft/capacitor-background-geolocation` (paid ~$300, best-in-class).
- Swap `driver-location-ping.tsx`: when `online`/`on_delivery`, use the native BG plugin instead
  of `watchPosition`, feeding the same `updateDriverLocation` → `set_driver_location` RPC.
- Android: foreground service + persistent notification. iOS: background location mode + "Always"
  permission + Info.plist purpose strings.
- **Deliverable:** location keeps flowing with the screen off / app backgrounded during a delivery.

### Phase 3 — Native push (FCM / APNs) _(≈3–5 days)_
- Plugin: `@capacitor/push-notifications` + Firebase (FCM Android, APNs iOS).
- Register device token per driver (new `driver_push_tokens` table/column).
- Server: extend the `notifications_outbox` sender (edge function) to emit FCM/APNs alongside/
  instead of Web Push VAPID. The `new_dispatch` template already exists → wire it to native push.
- **Deliverable:** reliable dispatch-offer push even when the app is closed; tap opens the offer.

### Phase 4 — Native camera + polish + submit _(≈3–5 days + store review)_
- `@capacitor/camera` for pickup/POD photos (replace `<input type=file capture>`; same
  upload-to-`branch-assets` flow + the driver storage RLS policy we added today).
- `@capacitor-community/keep-awake` during an active run.
- Store listings, screenshots, privacy declarations; submit. Apple review ≈1–3 days.
- **Deliverable:** production native v1 on both stores.

### Phase 5 — In-app turn-by-turn _(OPTIONAL, only if mandated)_
- Capacitor: bridge Mapbox Navigation SDK via a custom native plugin (significant native work), **or**
- Migrate the driver UI to **React Native / Expo** + `@rnmapbox/maps` + Mapbox Navigation SDK
  (cleanest; UI rewrite of ~12 screens, but backend/queries/RPCs reused). _(+3–6 weeks)_
- Default: **stay on deep-link** unless there's a concrete business reason.

---

## What changes in the current code (Capacitor path)

- **New:** Capacitor config + `ios/` + `android/` native projects; `driver_push_tokens` store;
  a native-push sender in the notifications edge function.
- **Modified:** `driver-location-ping.tsx` (native BG geo), `push-subscriber.tsx` (native token
  registration), photo capture in `active-view.tsx` (native camera).
- **Unchanged:** every screen/UI, all `@favornoms/database` queries + today's RPCs
  (`staff_assign_driver`, reject penalty, `progress_delivery` pickup-photo guard), Supabase
  realtime, and the deep-link `NavigateMenu`.

## Auth note
The cookie-based Supabase SSR session works in the **hosted-URL shell**. A **bundled** app would
switch driver auth to token/localStorage (supabase-js default) — a small, planned adjustment.

## Costs / accounts
- Apple Developer $99/yr · Google Play $25 once · Firebase (FCM) free tier · Mapbox already in use
  (nav SDK usage-priced only if Phase 5) · optional Transistorsoft BG-geo license ~$300.

## Rough timeline (1 dev)
- Capacitor v1 (Phases 1–4): **≈3–4 weeks** to production on both stores (excludes in-app nav).
- Phase 5 (RN rewrite for in-app nav): **+3–6 weeks**.

## Risks
- iOS "Always" background-location permission is scrutinized by Apple review — needs clear
  justification + a good permission-priming UX.
- Next.js App Router + bundled Capacitor needs rework of server-only bits; the hosted-URL shell
  avoids this at first (driver app is single-tenant, so simpler than the customer web surface).

## Decision needed
Capacitor-first (recommended) vs React Native from the start (only if in-app turn-by-turn is a
launch requirement). Everything built in this session carries over either way.
