# Packaging build spec — 2026-07-25

Companion to [PACKAGING-2026-07-25.md](PACKAGING-2026-07-25.md) (owner decisions + recon). This file is the build document.

---

## 1. Architecture

A **product catalog** (`billing_products`) describes what can be sold. A **subscription** (one row per restaurant, enforced by a unique index) plus its **line items** (`subscription_items`, one per product with a quantity) describes what a given restaurant bought — deliberately mirroring Stripe's own subscription/subscription-item shape so the webhook can never drift. Both are inputs to a single **resolved entitlement row** (`billing_entitlements`, one per restaurant) recomputed by `private.billing_compute()` on every write. Everything downstream reads only the resolved row, and `branches.entitled_through` is a denormalized mirror so branch-scoped checks cost zero joins.

Enforcement is **BEFORE INSERT triggers**, not RLS. Triggers fire for `service_role` too, so an edge function running with the service key is gated exactly like a browser client — which RLS can never achieve.

### Decision log

| # | Decision | Why |
|---|---|---|
| 1 | Normalized catalog + line items, with a **resolved** entitlement row on top | Line items map 1:1 to Stripe line items; the resolved row keeps read paths to a single indexed lookup. |
| 2 | Enforce with **BEFORE INSERT triggers**, not RLS | RLS does not apply to `service_role`; every edge function uses the service key. Triggers are the only gate that covers both. |
| 3 | `branches.entitled_through` mirror column, trigger-maintained, not client-writable | Branch-scoped gates (`orders`, `deliveries`, `payments`) resolve without joining `restaurants`. |
| 4 | **Drop** `subscriptions.tier` and the `subscription_tier` enum | Zero DB readers, but `upgrade_plan` and `create_restaurant_with_branch` cast to it — the cause of the production signup failure. Deleting removes the landmine rather than widening it. |
| 5 | Do **not** gate `branches_public_read` in RLS | The obvious move breaks order tracking and the driver app (both read branches through the same policy). Suspension is rendered server-side and enforced by triggers instead. |
| 6 | `entitled_through` is a **deadline**, not a flag | Suspension is `entitled_through is null or <= now()`. The cron is a bookkeeping convenience; if it stops, nobody is wrongly entitled, and restoring a tenant is instant with no cron wait. |
| 7 | Gates are **INSERT-only** | In-flight orders must still be settled, dispatched, tracked and delivered after a lapse. Only *new* orders/deliveries/card-payments are blocked. |
| 8 | Stripe dormancy is a pure env condition (`!STRIPE_SECRET_KEY` → 503) | No feature flag, no DB toggle, no code path that rots. The merchant UI is written once and falls back to the request queue automatically. |

### Feature keys (exactly six)

| Key | Granted by |
|---|---|
| `card_payment` | `base`, `trial` |
| `ai_menu_import` | `base`, `trial` |
| `delivery` | `delivery` add-on, `trial` |
| `ai_suite` | `ai_suite` add-on, `trial` |
| `digital_signage` | `ai_suite` add-on, `trial` |
| `ai_voice` | `ai_suite` add-on, `trial` |

---

## 2. Migrations (ordered, applied via Supabase MCP `apply_migration`)

| # | Name | Contents |
|---|---|---|
| M1 | `billing_catalog` | `billing_products` table + 5 seed rows + RLS + grant lockdown |
| M2 | `billing_subscription_items` | `subscription_items`, unique index on `subscriptions(restaurant_id)`, drop `subscriptions.tier` + `subscription_tier` enum |
| M3 | `billing_entitlements` | `billing_entitlements` table, `branches.entitled_through` mirror, `private.billing_compute()`, recompute triggers |
| M4 | `billing_read_api` | `private.has_feature` / `branch_has_feature` / `branch_entitled`, `public.get_entitlements`, `public.get_branch_entitlements`, `public.storefront_status` |
| M5 | `billing_gates` | `tg_billing_gate_order` / `_payment` / `_delivery`, rewritten `enforce_branch_limit`, item-limit trigger dropped, `check_plan_limit` + `get_my_plan_status` rewritten fail-closed |
| M6 | `billing_write_api` | `billing_requests` table, `billing_set_package`, `billing_start_trial`, `request_package_change`, `decide_billing_request`, `list_billing_requests`, `list_restaurant_subscriptions` |
| M7 | `billing_backfill` | Migrate the 2 live restaurants, deactivate legacy plans, **fix `create_restaurant_with_branch`**, seat-aware `create_branch`, retire `upgrade_plan` |
| M8 | `billing_stripe_sync` | `billing_events`, `stripe_event_seen`, `stripe_sync_subscription` |
| M9 | `billing_cron_and_reports` | `billing-expire-tick` cron job, rewritten `platform_financial_summary` |
| M10 | `billing_grants_lockdown` | Revoke anon/authenticated DML on all billing tables; `subscriptions` → SELECT-only for owners |

Full SQL is applied directly; each migration is idempotent-safe (`if not exists`, `create or replace`, `drop ... if exists`).

---

## 3. Shared TypeScript

### `packages/shared/src/utils/entitlements.ts` (new)
```ts
export const FEATURE_KEYS = ['card_payment','ai_menu_import','delivery','ai_suite','digital_signage','ai_voice'] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export interface Entitlements {
  restaurantId: string;
  planCode: string;            // 'trial' | 'base' | 'none'
  status: string;              // trialing | active | past_due | cancelled | expired | none
  entitled: boolean;           // entitledThrough != null && > now
  entitledThrough: string | null;
  trialEndsAt: string | null;
  branchSeats: number;
  branchesUsed: number;
  monthlyTotal: number;
  features: Record<FeatureKey, boolean>;
  addons: string[];
}

export const DENIED_ENTITLEMENTS: Entitlements;          // fail-closed default
export function parseEntitlements(raw: unknown): Entitlements;   // never throws; returns DENIED on garbage
export function hasFeature(e: Entitlements | null | undefined, k: FeatureKey): boolean;  // false unless explicitly true
export function isEntitled(e): boolean;
export function isTrialing(e): boolean;
export function trialDaysLeft(e): number | null;
export function canAddBranch(e): boolean;
export function packageLines(sel, catalog): { code; label; qty; unit; total }[];
export function packageMonthlyTotal(sel, catalog): number;
export function describeBillingError(err): { kind:'inactive'|'feature'|'seats'; ... } | null;
```

### `packages/database/src/queries/billing.ts` (new)
```ts
getEntitlements(supabase, restaurantId): Promise<Entitlements>          // DENIED on error, never null
getEntitlementsForBranch(supabase, branchId): Promise<Entitlements>
listBillingProducts(supabase): Promise<BillingProduct[]>
requestPackageChange(supabase, restaurantId, selection): Promise<...>
getPendingBillingRequest(supabase, restaurantId)
listBillingRequests(supabase, status)
decideBillingRequest(supabase, id, approve, note?)
setRestaurantPackage(supabase, restaurantId, selection, status?, periodEnd?)
listRestaurantSubscriptions(supabase)
upsertBillingProduct(supabase, product)
createBillingCheckoutSession(supabase, restaurantId, selection, urls)   // → {url} | {dormant:true}
openBillingPortal(supabase, restaurantId, returnUrl)                    // → {url} | {dormant:true}
```

### `packages/database/src/queries/guards.ts` (new)
`assertFeature(supabase, restaurantId, key)` / `assertEntitled(...)` / `assertPlatformAdmin(supabase)` — throw `EntitlementError` for server components.

### `supabase/functions/_shared/entitlements.ts` (new)
`loadEntitlements(admin, {restaurantId|branchId})` → fail-closed `{entitled:false, features:{}, planCode:'none'}` on any error; `edgeHasFeature(ent, key)`.

---

## 4. Server enforcement checklist

### 4.1 Edge functions (run as service role — RLS does NOT protect these; triggers do)

1. **`supabase/functions/_shared/entitlements.ts`** — NEW. Fail-closed on any error.
2. **`place-order/index.ts`** — after the branch lookup at `:109-110`: `!ent.entitled` → `402 {error:'billing_inactive',scope:'orders'}`; `channel==='delivery' && !delivery` → `403 {error:'feature_not_entitled',feature:'delivery'}`; extend the payment matrix at `:249-262` so `payment_method==='card' && !card_payment` → 403. **The entitlement gate is NOT staff-exempt** — the `:256-260` staff carve-out applies only to the merchant's own on/off matrix. Handle the new `quote_delivery` reason at `:298`: `delivery_not_entitled` → 403, and it must NOT fall through to the legacy flat fee at `:301`.
3. **`dispatch-driver/index.ts:162-166`** (and before the batching gate at `:204`) — gate on the **feature**, not on `entitled`: orders created before suspension must still dispatch.
4. **`ai-menu-optimize/index.ts`** — add JWT auth (absent today), resolve `restaurant_id` from `staff_members`, then `ai_suite` gate.
5. **`ai-review-response/index.ts`** — same as 4.
6. **`ai-chat-support/index.ts`** — **has no auth at all today.** Add `Authorization: Bearer` → 401 `auth_required`, then the `ai_suite` gate. Highest severity of the three.
7. **`import-menu/index.ts`** — **no feature gate** (owner decision 2: AI menu import stays in Base). Add `!ent.entitled` → 402 only.
8. **`stripe-create-payment-intent/index.ts`** — resolve order → branch → restaurant, `card_payment` gate. The D2 Connect gap stays out of scope.
9. **`export-csv`, `integration-sync`, `issue-tax-invoice`** — `!ent.entitled` → 402. Back-office data egress stops at suspension.
10. **`notify-worker`** — **no gate**, comment saying so. In-flight order notifications must keep flowing.
11. **`driver-auth`** — **no gate**, comment. Drivers are platform-scoped.

### 4.2 SQL gates

12. `tg_billing_gate_order()` BEFORE INSERT on `orders` → `billing_inactive:orders` / `feature_not_entitled:delivery`, P0001.
13. `tg_billing_gate_payment()` BEFORE INSERT on `payments` → `feature_not_entitled:card_payment`, P0001. **INSERT only** — settlement of in-flight orders survives.
14. `tg_billing_gate_delivery()` BEFORE INSERT on `deliveries` → `feature_not_entitled:delivery`, P0001.
15. `enforce_branch_limit()` BEFORE INSERT on `branches` + new `BEFORE UPDATE OF restaurant_id` coverage → `plan_limit_exceeded:branches:<cur>/<lim>` (wire format preserved for `plan.ts:28`) and `billing_inactive:branches`.
16. `quote_delivery()` → returns `{"deliverable":false,"reason":"delivery_not_entitled"}` (does not raise — `place-order:290-301` already branches on `reason`).
17. `private.has_feature` / `branch_has_feature` / `branch_entitled` — fail closed on a missing row *and* a missing key (`coalesce(...,false)`).

### 4.3 Next.js server components

18. **`apps/web/src/lib/tenant.ts`** — `resolveTenantBySlug` selects `entitled_through`; comment recording that the gate is here, not in RLS (deliberate: RLS would break order tracking + driver).
19. **`apps/web/src/app/r/[restaurant]/[branch]/layout.tsx:13`** — suspended → `<SuspendedStorefront/>`; missing → `notFound()`.
20. **`apps/web/src/middleware.ts:32`** — **do not** gate here; it would black-hole order tracking.
21. **`apps/admin/src/app/b/[branchId]/layout.tsx:50-58`** — replace `getPlanStatus()` with `getEntitlementsForBranch()`. `!ent.entitled` → redirect every path except `/settings/plan` to `/settings/plan?suspended=1`. **Critical:** the new helper must return `DENIED`, not `null`, on error — `plan.ts:22` currently swallows errors, which would fail open.
22. **`apps/admin/.../signage/**` and `/ai-voice/**`** — new routes, `assertFeature(...,'digital_signage'|'ai_voice')` → locked surface.
23. **`apps/admin/src/app/platform/**/page.tsx`** — every route server-asserts `private.user_is_platform_admin()`. Today the only gate is the cosmetic sidebar ladder, which fails open on unknown tier — and every new plan code is an unknown tier.
24. **`apps/pos` / `apps/kds` layouts** — suspension screen, but the settlement path stays open (POS must close out pre-cutoff orders).
25. **`apps/driver/**`** — no gate.

### 4.4 Error-code contract

| Raised by | Message | Code | TS decode |
|---|---|---|---|
| SQL trigger | `billing_inactive:<scope>` | P0001 → 400 | `{kind:'inactive',scope}` |
| SQL trigger | `feature_not_entitled:<key>` | P0001 → 400 | `{kind:'feature',feature}` |
| SQL trigger | `plan_limit_exceeded:branches:<cur>/<lim>` | P0001 → 400 | `{kind:'seats',current,limit}` |
| Edge fn | `{"error":"billing_inactive",...}` | **402** | `{kind:'inactive'}` |
| Edge fn | `{"error":"feature_not_entitled",...}` | **403** | `{kind:'feature'}` |
| Edge fn | `{"error":"stripe_not_configured"}` | **503** | `{dormant:true}` |

Every call site checks `result.ok !== true`, never `!result.ok` — an absent field must read as failure.

---

## 5. Client / UX checklist

`[F]` = functional (changes what the system permits) · `[C]` = cosmetic.

### Merchant
1. `apps/admin/.../settings/plan/_components/plan-view.tsx` **[F] full rewrite** — delete the hand-written interface at `:9-21` and the 4-tile ladder. Trial banner (days left, warning palette at ≤3, red suspension banner when not entitled) · Base card $199 · Delivery/AI-Suite toggles · branch-seat stepper (min 1, and never below `branchesUsed`) · live total · submit → `requestPackageChange()` (auto-upgrades to Stripe Checkout when live).
2. `apps/admin/.../settings/plan/page.tsx` **[F]** — must NOT be caught by the layout's suspension redirect; this page is the escape hatch.
3. `apps/admin/.../dashboard/page.tsx:25-29` **[C]** — drop the plan shape mirror; the "10/30 items used" banner is meaningless now.
4. `apps/admin/src/components/sidebar.tsx:15-37` **[F]** — delete the fail-open tier ladder; use `hasFeature`.
5. `apps/admin/.../branch/_components/payment-methods-card.tsx:34-46,65-68` **[F]** — lock Card toggles without `card_payment`; the write path is ungated today.
6. `apps/admin/.../branch/_components/delivery-settings-card.tsx` **[F]** — upsell card without `delivery`.
7. Branch-create flow **[F]** — "Add branch" becomes "Add a branch seat +$99/mo" when `!canAddBranch`. Pay first, then create.
8. `apps/admin/.../signage/page.tsx`, `.../ai-voice/page.tsx` **[C] new** — locked / coming-soon.
9. `apps/admin/src/components/suspension-screen.tsx` **[F] new**.

### Platform admin
10. `apps/admin/.../platform/plans/_components/plans-manager.tsx` **[F] full rewrite** → catalog manager over `billing_products` incl. `stripe_price_id` (not editable anywhere today) and a feature-key checkbox grid. Fixes the jsonb-clobber bug.
11. `apps/admin/.../platform/subscriptions/**` **[F] new** — per-restaurant override: set package, start trial, extend period. **This is the live activation rail.**
12. `apps/admin/.../platform/subscriptions/requests/page.tsx` **[F] new** — merchant request queue, approve/reject.
13. `apps/admin/.../platform/reports/page.tsx:7-21` **[C]** — new summary keys + `by_addon` tile.
14. `platform-nav.tsx` **[C]** — add Subscriptions + Requests.

### Storefront
15. `apps/web/.../menu-view.tsx:316-322` **[F]** — filter `delivery` out of the fulfilment `Segmented`.
16. `apps/web/src/store/cart.ts:60` **[F]** — default channel is hardcoded `'delivery'`; make it entitlement-aware, falling back to `pickup`.
17. `apps/web/.../checkout-view.tsx:45-62,249-263,268-280,973-978` **[F]** — hide Card / delivery address / delivery fee accordingly; render the new 403 bodies humanely.
18. `apps/web/.../suspended-storefront.tsx` **[C] new** — brand-neutral, **no billing language** (customer-facing).
19. `apps/web/src/app/page.tsx:35,122-140` **[F+C]** — replace the dead Free/Starter/Pro/Enterprise tiles with Base $199 + add-ons + the free-14-day hero; fix the two CTAs that 404.
20. `apps/web/.../order-tracking.tsx:404-409` **[F] must fix** — the "Mock confirm (dev only)" browser UPDATE to `payments.status='completed'` is gated only on Stripe being unconfigured, which is now the permanent state. Hard-gate on `NODE_ENV !== 'production'` or delete.
21. `apps/admin/.../login-view.tsx:35` + new `/signup` **[F]** — `shouldCreateUser:false` and no signup route means nothing can ever reach the trial.

### POS / KDS
22. `apps/pos/.../pos-view.tsx:544-545`, `apps/admin/counter/.../counter-view.tsx:206` **[F]** — hardcoded Cash/Card buttons bypass the matrix; hide Card without `card_payment`.
23. Same files `:212` **[do-not-break]** — the browser `orders.update({status:'confirmed'})`. The gates are INSERT-only precisely so this survives suspension. Verify explicitly.
24. `apps/kds/.../kds-view.tsx:21-27` **[C]** — no gating; in-flight tickets keep rendering.

---

## 6. Stripe (built, deployed, dormant)

### `stripe-create-checkout-session`
- Body becomes `{restaurant_id, selection:{plan_code, addons[], branch_seats}, success_url, cancel_url}`.
- Resolve the catalog from `billing_products` (not `subscription_plans`); 400 `product_missing_stripe_price` naming the code — the switch-on tripwire.
- Replace the hardcoded `line_items[0][quantity]='1'` at `:101` with a loop: base ×1, `extra_branch` ×(seats−1) if >0, `delivery` ×1, `ai_suite` ×1.
- Trial: if currently `trialing`, pass `subscription_data[trial_end]=<unix trial_ends_at>` (**absolute**, so converting mid-trial doesn't restart the clock). `trial_period_days` only for a brand-new trial. Passing both is a Stripe 400.
- Drop `plan_code` from metadata — it is meaningless for a multi-line subscription and is exactly what makes the webhook coerce to `'starter'`.
- Pin `Stripe-Version: 2025-08-27.basil`; add an idempotency key to the session create.

### `stripe-webhook` — six defects fixed
1. **Idempotency** — `event.id` is parsed at `:57` and never stored → `stripe_event_seen()` short-circuit.
2. **HMAC timestamp tolerance** — `t` is extracted at `:228` and never checked; any captured payload replays forever. Reject `|now − t| > 300`.
3. **Multi-line** — `:166` reads `items.data[0]` only and `:44/:199` coerce unknown codes to `'starter'`. Map **every** item through `stripe_price_id → billing_products.code`; delete `TIERS` and the tier coercion.
4. **Invoice subscription path** — `:112/:126` read `inv.subscription`, which is `undefined` on 2025-era versions → renewals silently no-op. Dual-read `inv.subscription ?? inv.parent?.subscription_details?.subscription`.
5. Unresolved customers → `billing_events` row, not just `console.error` at `:195`.
6. Log a warning when `event.api_version` differs from the pinned constant.

New handlers: `checkout.session.completed`, `customer.subscription.trial_will_end`, `invoice.payment_action_required`, `invoice.marked_uncollectible`.

### Correct webhook event list (13 — the docs currently list only the 3 payment ones, so subscription sync would be dead on arrival)
```
checkout.session.completed          customer.subscription.created
customer.subscription.updated       customer.subscription.deleted
customer.subscription.trial_will_end
invoice.paid                        invoice.payment_failed
invoice.payment_action_required     invoice.marked_uncollectible
payment_intent.succeeded            payment_intent.payment_failed
charge.refunded                     charge.dispute.created
```
`invoice.paid` (not `payment_succeeded`) — it also fires for the $0 invoice a trial conversion produces.

### To switch on, the owner supplies
1. `STRIPE_SECRET_KEY` · 2. `STRIPE_WEBHOOK_SECRET` · 3. four monthly USD Prices (`base` $199, `extra_branch` $99 **with quantity pricing enabled**, `delivery` $49, `ai_suite` $59 — `trial` needs no Price) pasted into the catalog manager · 4. the endpoint URL with the 13 events · 5. deploy `stripe-create-checkout-session` + `stripe-billing-portal` (repo-only today; only `stripe-webhook` is live).

Until then the merchant UI receives `{dormant:true}` from the 503 and transparently falls back to `requestPackageChange()`. **No UI edit is needed at switch-on.**

---

## 7. Verification

### SQL assertions
- Catalog: 5 rows, prices `trial 0/1 seat`, `base 199/1`, `extra_branch 99`, `delivery 49`, `ai_suite 59`.
- Every restaurant has a live entitlement row (`count = 0` for null/expired).
- `branches.entitled_through` matches `billing_entitlements.entitled_through` everywhere.
- No `anon`/`authenticated` DML on any billing table; `branches.entitled_through` not client-writable for INSERT **or** UPDATE (separate privilege classes).
- Every new function pins `search_path` including `pg_temp`; only `storefront_status` is anon-executable.
- Fail-closed probes: unknown restaurant → false; unknown feature key → false; `check_plan_limit(...,'nonsense')` → `allowed:false` (today it returns **true**).
- Seat enforcement raises `plan_limit_exceeded:branches:1/1`.
- Manual rail round-trip: base + both add-ons + 3 seats → `199 + 2×99 + 49 + 59 = 505.00`; downgrading to base-only leaves **zero** orphan `subscription_items`.
- `create_restaurant_with_branch` succeeds and yields `plan_code='trial'`, 1 seat (this is the 22P02 that rolls back restaurant+branch+staff today).
- Advisors: no new ERROR/WARN.

### Browser smoke (per `project_local_login_testing`; terse pass/fail, fix inline, re-run)
1. Marketing page shows the new model, CTAs resolve.
2. `/signup` → restaurant + branch + owner → dashboard with "14 days left".
3. Trial storefront: all three fulfilment options, delivery order end-to-end, Card offered.
4. Plan page: toggle both add-ons + 3 seats → live total **$505/mo** → request sent → read-only pending state.
5. `/platform/subscriptions/requests` → approve → merchant sees Base + both add-ons, 1 of 3 seats.
6. Seats: add 2 branches OK, 3rd blocked; drop to 1 seat → immediately blocked.
7. Remove Delivery → storefront shows Pickup/Dine-in only, cart no longer defaults to delivery, checkout has no address block, direct `POST /place-order` with `channel:'delivery'` → **403**.
8. Remove AI Suite → sidebar hides Signage/AI Voice, direct-nav → locked surface not a crash, `ai-chat-support` → 403 with JWT / **401 without** (new; it had no auth at all).
9. **Suspension (the critical one)** — set `expired`, then in order: storefront dark within seconds (no cron wait) · `POST /place-order` → 402 · **order tracking for the pre-existing order STILL LOADS** · **driver can still progress the assigned delivery to delivered** · **POS can still mark a pre-cutoff order paid and confirmed** (`pos-view.tsx:212`) · KDS still renders · admin redirects to `/settings/plan?suspended=1` and that page loads.
10. Restore → storefront live immediately, no cron, no cache purge.
11. Self-upgrade attempts from the merchant's browser console all fail: `subscriptions.update({status:'active'})` → 0 rows · `branches.update({entitled_through:'2099-01-01'})` → denied *and* force-overwritten by the trigger · same for INSERT (separate privilege class) · `billing_entitlements.select('*')` → permission denied · `rpc('stripe_sync_subscription')` → permission denied.
12. Cron tick expires a lapsed trial; **stopping the cron does not un-suspend anyone** (the deadline is authoritative).
13. `pnpm -r typecheck` + `pnpm -r build` green across all five apps.

---

## 8. Docs to update

`docs/TEST-CASES.md:25,47,500,514-518,726-728,755,797,836,864,895` · `docs/SMOKE-TEST.md:174-177` · `implementation.md` §16 (THB spec) · `docs/AUDIT-2026-06-24.md` D2 cross-ref · `docs/US-LAUNCH-PLAN.md` pricing · `CONFIG-CHECKLIST.md` webhook events (§6's 13-event list) · new `docs/RUNBOOK.md` "Billing operations" section.

---

## 9. Non-goals

1. Digital Signage and AI Voice are **not built** — the add-on sells entitlement + locked surfaces (owner decision 2).
2. Per-restaurant Stripe Connect is **not built**; order funds still land in the platform account (pre-existing D2 contradiction, tracked separately). "Card Payment" here means *the entitlement to accept cards*, not where the money lands.
3. Annual billing not built (`billing_cycle` still accepts `yearly`; nothing reads it).
4. The orphaned `parse-voice-order` / `create-payment-source` / `omise-webhook` deployments are not deleted.
5. Stripe is not switched on.
6. No grandfathering — legacy plans deactivated, not honoured.
7. No menu-item cap and no orders/month cap anywhere.
8. `subscriptions.plan_code` / `unit_price` kept in sync for reporting rather than dropped.
9. No data deleted on suspension; paying restores instantly.
10. No caching layer added; the entitlement read is one indexed lookup on a column the tenant resolver already fetches.
