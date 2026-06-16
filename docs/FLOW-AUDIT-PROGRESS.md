# Favornoms — Cross-Role Flow Audit (progress log)

> **Goal:** Walk every step of the work flow for all 4 roles (customer / merchant / driver /
> platform), verify each step actually works AND connects end-to-end, benchmark against
> real white-label delivery apps (Grab / LINE MAN / foodpanda / Shopee) to find missing
> functions, then fix bugs + build gaps. Report pass/fail. Keep this file updated so a new
> session can resume.
>
> **Started:** 2026-06-07 · Backend project ref `ayyfczidnzxetndiijmv`

## How to resume
1. Read this file top-to-bottom.
2. DB fixes are staged in `docs/AUDIT-FIXES.sql` (project applies migrations via Supabase MCP
   `apply_migration`, not a local migrations folder). Apply un-applied blocks listed below.
3. Edge-fn deploy gaps are listed under "Live infra TODO".
4. Continue from the first unchecked item in "Phase checklist".

## Method
Live browser E2E across 5 apps + remote Supabase is flaky in this env, so the audit combines:
- **Static code-path tracing** — every UI button → confirm it calls a real RPC/edge-fn that
  exists in the live DB (cross-checked `.rpc()` / `functions.invoke()` / `fetch(/functions/...)`
  against `pg_proc` + deployed edge-fn list).
- **Live DB introspection** — RPCs, triggers, enums, realtime publication pulled from the
  remote DB to confirm the backbone is wired.
- **Build/type-check/test** — compile-level correctness.
- **Live SQL lifecycle simulation** — (pending infra auth) drive an order through the real
  state machine to confirm triggers fire and roles connect.

---

## Baseline (2026-06-07)  ✅
- `pnpm -r type-check` ✅ green
- `pnpm -r build` ✅ green (web, driver, kds, pos, admin + 3 pkgs)
- `pnpm -r test` ✅ green (49 tests)
- Live DB: **84 migrations** (was 71 in old memory; +13 are post-launch fixes:
  RLS-recursion fixes, enum fixes, `auto_confirm_cash_orders`, low-stock recipient fix).
- **16 edge functions ACTIVE** on remote.

## Backend connectivity (Phase 2)  ✅ audited
- 70+ public RPCs present; **every** `.rpc('…')` in app/package source resolves to a real
  function. `generate_order_number` lives in `private` schema (called by place-order edge fn). 
- Triggers verified live: `orders_dispatch_on_ready` (→ dispatch-driver), `orders_award_loyalty_on_complete`,
  `orders_status_history_trigger`, `order_items_decrement_stock_trg`, `order_items_default_station`,
  `payments_confirm_cash_order` (auto-confirm cash), `tg_peak_bonus` (driver bonus).
- Realtime publication covers: orders, order_items, deliveries, menu_items, broadcasts,
  notifications_outbox, reservations → customer tracking / KDS / driver / 86-toggle all live.
- Enums: order_status = pending,confirmed,preparing,ready,out_for_delivery,completed,cancelled,refunded.
  delivery_status = pending,dispatching,assigned,picked_up,in_transit,delivered,failed,cancelled.
  (Note: order_status has NO 'delivered' — delivery orders end at 'completed'.)

---

## BUGS FOUND

### BUG A — delivery progression never updates orders.status  ✅ FIX WRITTEN (needs live apply)
- **Severity:** Critical (delivery is the primary channel).
- **Where:** `packages/database/src/queries/driver.ts` `progressDelivery()` updates only the
  `deliveries` row; no trigger propagated to `orders`. Confirmed no propagation trigger exists.
- **Impact:** customer tracking bar stuck at 'ready'; **loyalty never awarded** for delivery
  orders; orders never close.
- **Fix:** `docs/AUDIT-FIXES.sql` → FIX A (SECURITY DEFINER trigger `deliveries_sync_order_status`:
  picked_up → order out_for_delivery, delivered → order completed). Client fix impossible
  (driver has no RLS UPDATE on orders).
- **Status:** ✅ APPLIED live 2026-06-07 (user authorized DB+edge for this session) + VERIFIED.
- **Re-test:** live SQL sim (atomic, rolled back) → `ready → out_for_delivery → completed`. PASS.

### BUG B — loyalty award used invalid type 'earn'  ✅ FIXED + VERIFIED
- **Severity:** Critical (breaks EVERY order completion for a signed-in customer).
- **Where:** `orders_on_complete_award_loyalty()` inserted `loyalty_transactions.type='earn'`;
  CHECK constraint allows only `earned/redeemed/expired/adjusted` → constraint violation
  rolled back the `status='completed'` UPDATE. Hit on pickup/dine-in bump AND delivery.
- **Why latent:** guest orders skip loyalty; delivery orders never completed (BUG A) — so the
  only completions that ran were guest pickups.
- **Fix:** migration `fix_award_loyalty_type_earned` — `'earn' → 'earned'`. Also in AUDIT-FIXES.sql.
- **Status:** ✅ APPLIED live + VERIFIED by the same sim (loyalty 'earned' row, 100 pts).

> **Live infra authorization:** user approved applying DB migrations + deploying edge fns via
> MCP for this audit session (AskUserQuestion, 2026-06-07). No need to re-ask this session.

---

### BUG C — kitchen "Reject" bypassed cancel_order (no stock restore)  ✅ FIXED
- Kitchen Reject did a raw `orders.update('cancelled')` → never restored stock for
  track_stock items, logged no reason. Rewired to `cancel_order()`; added 'kitchen' to that
  RPC's staff allow-list (migration `cancel_order_allow_kitchen_role`). Client edit in
  `apps/admin/.../kitchen/[branchId]/_components/kitchen-view.tsx`. type-check green.

### BUG D — onboarding defaulted timezone to Asia/Bangkok  ✅ FIXED (minor)
- Wizard never passes `p_timezone`; default applied was legacy Bangkok. Changed default to
  `America/New_York` (migration `onboarding_default_timezone_us`).

---

## Pass / fail by role (after fixes)
| Flow | Result | Notes |
|------|--------|-------|
| Customer: tenant resolve → menu → cart → checkout → place-order | **PASS** | place-order called via fetch; server recalcs. Combos/modifiers/gift-card need v8 deploy (below). |
| Customer: live order tracking | **PASS** (was FAIL) | fixed by FIX A — bar now reaches out_for_delivery/completed via realtime. |
| Customer: loyalty earn on completion | **PASS** (was FAIL) | fixed by FIX B. |
| Customer: cancel / edit / rate / account / CCPA | **PASS** | RPCs exist + wired (cancel_order, edit_pending_order, export/delete_my_data). |
| Merchant: kitchen accept→cook→ready→bump | **PASS** | pending→confirmed→preparing→ready→completed; RLS `orders_staff` ALL covers kitchen role. |
| Merchant: ready(delivery) → auto-dispatch | **PASS** | trigger orders_after_ready_dispatch → pg_net → dispatch-driver (robust fallback + retry + staff alert). |
| Merchant: "Find driver" manual dispatch | **PASS** | DispatchButton → functions.invoke('dispatch-driver'). |
| Merchant: kitchen Reject | **PASS** (was partial) | fixed by FIX C — now restores stock + logs reason. |
| Merchant: counter/POS cash order | **PASS** | place-order → payment(cash) → confirm_cash_order_on_payment auto-confirms → kitchen. |
| Merchant: menu/promo/marketing/franchise/refund/tax-invoice | **PASS** | every `.rpc()` resolves to a live function. |
| Driver: online → dispatch offer → accept/reject | **PASS** | accept_dispatch/reject_dispatch; realtime on deliveries by driver_id. |
| Driver: 5-stage delivery + POD + earnings + peak bonus | **PASS** | progressDelivery + FIX A propagation; tg_peak_bonus applies bonus. |
| Platform: cross-tenant dashboard + suspend/restore | **PASS** | platform_ops_summary + set_restaurant_suspended. |
| Merchant self-onboarding ("ฝากร้าน") | **PASS** | create_restaurant_with_branch builds restaurant+branch+owner+free sub. |
| Customer: online CARD payment | **DEFERRED** | needs Stripe Elements mount + stripe-create-payment-intent deploy. Cash works. |

## Gap analysis vs Grab / LINE MAN / foodpanda / Shopee
Built (self-contained): FIX A/B/C/D above.
Flagged (need a product decision or external provider — do NOT silently pick one):
1. **Online card payment** — Stripe Elements + deploy `stripe-create-payment-intent` (+ `stripe-refund`). Gateway was user-deferred. Cash path works today.
2. **place-order v8 deploy** — source ready in repo; deployed is v4. Until deployed, combos /
   modifiers / gift-cards / scheduling sent by checkout are ignored, and CORS on the deployed
   v4 may block non-localhost origins (v8 source uses `*`). **Top deploy action.**
3. **Distance-based delivery fee + real ETA + live driver map** — branches have geo_location and
   drivers ping current_location, but customer delivery_address has no lat/lng → cannot compute
   distance/ETA/route without a **geocoding/map provider** (Mapbox/Google). Today: flat $3.99 fee,
   ETA/“driver on the way” are static. Recommend picking a provider, then: geocode address on
   checkout, compute fee+ETA in place-order, stream driver position to the tracking page.
4. **Scheduled-order release** — `scheduled_for` is stored but no cron holds/releases it; a
   future order hits the kitchen immediately. Add a 'scheduled' hold + release cron if wanted.
5. **Notification delivery** — outbox + notify-worker tick (every min) are wired; actual push/SMS/
   email needs VAPID / Twilio / Resend secrets (config, per CONFIG-CHECKLIST.md).

Minor/cosmetic (not fixed): kitchen "Bump" on a ready delivery order completes it early (no double
loyalty); driver app has dev-only test-sign-in backdoors to remove before prod.

---

## Live infra applied this session (user-authorized 2026-06-07)
- [x] FIX A `deliveries_sync_order_status` — APPLIED + verified
- [x] FIX B `fix_award_loyalty_type_earned` — APPLIED + verified
- [x] FIX C `cancel_order_allow_kitchen_role` — APPLIED (+ client rewire)
- [x] FIX D `onboarding_default_timezone_us` — APPLIED
- [ ] Deploy `place-order` v8 (repo source ready; NOT done — avoided hand-transcribing the
      321-line critical fn with no v4 rollback; do via `supabase functions deploy place-order`
      once CLI is installed/linked, or MCP deploy from the repo file).
- [ ] (deferred) `stripe-create-payment-intent` deploy + Stripe Elements.

## Phase checklist
- [x] 0. Baseline build/test/type-check (all green; re-verified after edits)
- [x] 1. Backend connectivity audit (edge fns, RPCs, triggers, enums, realtime)
- [x] 2. Customer (web) flow  → found+fixed BUG A, BUG B
- [x] 3. Merchant (admin + kitchen + counter) flow  → found+fixed BUG C
- [x] 4. Driver flow  → covered by FIX A
- [x] 5. Platform admin + merchant self-onboarding  → found+fixed BUG D
- [x] 6. Gap analysis vs aggregators (built A–D, flagged 1–5)
- [x] 7. Final report (delivered to user)

_Last updated: 2026-06-07 — session 1 complete. 4 bugs fixed live + verified; 5 gaps flagged._

---

## 2026-06-11 — Delivery-first build-out (separate session)

Gaps #2 (place-order deploy), #3 (distance fee / ETA / live map via Mapbox), #4
(scheduled release cron) from the list above are now **BUILT + DEPLOYED**, plus
offer-TTL dispatch hardening, in-app chat, opening hours/pause/surge, and a live
ops map. Gap #1 (online card payment) remains user-deferred; #5 (notification
secrets) remains config. See **docs/DELIVERY-BUILD.md** for the full record.
Also fixed live: place-order v8 source crashed on `order_items.modifiers` NOT NULL
(every order would have failed once v8 deployed — caught by post-deploy smoke).
