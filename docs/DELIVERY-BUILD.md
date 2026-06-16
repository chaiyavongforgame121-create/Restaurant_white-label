# Delivery-First Build-Out — 2026-06-11

> Executed per the approved plan (delivery feature parity with real delivery apps,
> payment-agnostic, per-branch white-label config). All 6 phases done in one session.
> Plan file: `C:\Users\B\.claude\plans\lexical-tinkering-boot.md`

## What shipped (all live on project `ayyfczidnzxetndiijmv`)

### Migrations applied (5)
| Migration | Contents |
|---|---|
| `delivery_quote_backbone` | `quote_delivery()` RPC (distance fee + heuristic ETA + radius check), `upsert_customer_address()`, generated lat/lng columns on `customer_addresses` + `branches` (geo mirrors), `deliveries.dropoff_lat/lng` |
| `live_tracking` | `deliveries.driver_lat/lng/driver_location_updated_at/current_eta_min/arriving_at/accepted_at`; `set_driver_location` v2 mirrors position+ETA+300m geofence onto the active delivery (customer realtime rides existing `deliveries` subscription); trigger → outbox `driver_assigned` (on accept) + `order_arriving` (geofence); `get_delivery_driver_contact()` |
| `dispatch_hardening` | `deliveries.offered_at/offer_expires_at/failed_reason/failed_photo_url`, `orders.held`; `find_dispatch_candidates` v2 (scoring + `p_exclude`); `private.expire_dispatch_offers()` + **pg_cron every 30s**; `driver_cancel_delivery()`, `fail_delivery()`, `requeue_failed_delivery()`; `private.release_scheduled_orders()` + cron 1min; `accept_dispatch` rejects expired offers |
| `delivery_chat` | `delivery_messages` + RLS (participants only, sends blocked outside in-flight), realtime publication, `mark_messages_read()`, outbox `new_message` trigger (throttled) |
| `opening_hours_ops` | `branch_hours` (weekly windows, overnight wrap) + `is_branch_open` v2 (hours + `orders_paused` + closures; **no rows = always open**); dropped legacy `proof_image_url`/`customer_signature_url` |

### Edge functions deployed
- **place-order** → v9.1 (remote v8): fixed v8 `modifiers: null` NOT-NULL crash (caught by smoke!), server-side `quote_delivery` (409 `delivery_out_of_range`), populates pickup/dropoff geo + trip `distance_km` + ETA on `deliveries`, `held` flag for far-future scheduled orders. No-coords → legacy flat fee.
- **dispatch-driver** → v2 (source now in repo): offer-based with TTL (`offer_ttl_seconds`, default 75s), scored candidates, excludes already-tried drivers, computes `driver_earnings` from trip distance, trims history to 10.
- **notify-worker** → v6: USD fix + templates `driver_assigned`, `order_arriving`, `new_message`, `delivery_failed_at_door`, `delivery_returned`, `order_released`, `dispatch_failed`.

### New packages / major client work
- **`packages/maps` (@favornoms/maps)**: Mapbox isolated here (token-optional — everything degrades gracefully without `NEXT_PUBLIC_MAPBOX_TOKEN`). `MapView` (SSR-safe), `DeliveryMap` (markers + route line), `AddressAutofillInput`, `fetchRoute` (Directions — once per tracking session only), geo math, `loadMapboxGl`.
- **`packages/shared` delivery-settings.ts**: typed per-branch config parser + `computeDeliveryFee`/`heuristicEtaMin` mirroring the SQL exactly (10 new unit tests, incl. the live-SQL-verified 2.21km→$5.25/21min case).
- **Web checkout**: address autocomplete → live quote (fee/distance/ETA), out-of-range block, saved addresses with coords, `upsert_customer_address`.
- **Web tracking**: live map (driver puck + route), dynamic ETA, "Arriving now", fixed dead Call-driver button (gated RPC), in-app chat.
- **Driver**: real offer countdown from `offer_expires_at`, accepted_at-based offer detection (localStorage heuristic removed), navigate with coords, cancel/can't-deliver flows (reason + photo), chat.
- **Merchant**: delivery settings card (fees/radius/prep/dispatch/driver-pay + pause/busy/surge), weekly hours editor, kitchen Scheduled lane + pause/busy header toggles, orders Delivery-issues queue (re-dispatch), **Live deliveries** ops map (`/b/[branchId]/deliveries`).

## Verified (live SQL sims, atomic + cleaned up)
- quote_delivery in/out-of-radius/invalid; place-order 3 smoke cases incl. 409
- set_driver_location mirror + ETA + geofence stamp + both outbox notifications
- offer expiry sweep → re-dispatch + reject_streak; accept-vs-expire race → `offer_expired`
- scheduled hold → cron release + `order_released` outbox
- chat RLS: stranger 0 rows/insert blocked, post-delivery send blocked, mark-read, push throttle
- is_branch_open: weekday window, late-night closed, overnight both sides, paused, no-hours branch
- `pnpm -r type-check` / `test` (59) / `build` — all green

## Live browser smoke (2026-06-14) — full delivery loop PASSED end-to-end

Drove all 3 apps (customer/driver/merchant) via Claude-in-Chrome with a real Mapbox
token. Placed order **A-2606-979028** (Bacon Deluxe + Burger Combo Deal, delivery, cash):
checkout autocomplete → distance fee $3.53 (0.83 km) + ETA 18 min → kitchen accept→cook→ready
→ auto-dispatch → driver offer w/ live countdown + earnings $2.66 → accept → 5-stage delivery
→ live driver puck on customer Mapbox map → "Arriving now" geofence → 2-way realtime chat →
delivered → order **completed** + **loyalty 31 pts earned** + all delivery notifications queued
(driver_assigned, order_arriving, new_message×2). Live-ops map + kitchen Pause/Busy toggles verified.

**2 real bugs found & fixed during the smoke (both committed):**
1. **Combo orders crashed** — `order_items.menu_item_id` was NOT NULL, but combo lines insert it
   null (combo_id set instead). Every order containing a combo failed `order_items_insert_failed`.
   Fix: migration `order_items_allow_combo_lines` — drop NOT NULL + add CHECK (menu_item_id OR combo_id).
   This was latent since v8 was never deployed before Phase 0; surfaced the moment combos went live.
2. **Mapbox address pin got wiped** — AddressAutofill fires the input's `onChange` right after
   `onResolved`, and checkout's onChange cleared the coords that onResolved had just set → quote
   never ran (flat fee, no distance pricing). Fix: `resolvedAddressRef` guard in `checkout-view.tsx`
   — only invalidate the pin when the typed text actually diverges from the resolved address.

**Test-data setup done (not code bugs):** branch Brooklyn `geo_location` was null (set to a
Williamsburg point); test driver's `current_location` was stale in Thailand (~14,000 km away — moved
near the branch); an inactive "Cheese Burger" lingered in the persisted cart (place-order correctly
rejected it with `item_inactive`).

**Minor cosmetic (noted, not fixed):** cart-page summary shows a wrong delivery fee ($40) while the
checkout page + server compute it correctly; post-order redirect lands on /cart instead of the
tracking page (clear() races the "empty cart" effect); the "almost there" driver card lingers on the
tracking page after delivered.

## Outstanding
1. **User: Mapbox token** → `NEXT_PUBLIC_MAPBOX_TOKEN` in web/driver/admin `.env.local` (free tier OK; restrict URL in dashboard). Without it: plain address input + flat fee + no maps (everything still works).
2. **Browser smoke** (needs token + dev servers): full delivery loop — autocomplete → distance fee → kitchen → auto-dispatch offer countdown → accept → live map moves (devtools sensor override) → chat both ways → POD → delivered. Update `docs/TEST-CASES.md` when run.
3. **Secrets** (config only): VAPID/Twilio/Resend so push/SMS/email actually send — outbox already queues everything.
4. **Phase 6 (blocked on user decisions)**: payment gateway (Stripe scaffolding ready), money flow/Connect, driver payout rails.
5. Minor: staff in-app notification surfaces read `notifications_outbox` raw — new staff templates (`delivery_failed_at_door` etc.) render via worker dicts only if pushed/emailed.
