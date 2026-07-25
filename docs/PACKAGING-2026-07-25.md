# Packaging rebuild — 2026-07-25

Owner-requested pricing model, replacing the legacy `free / starter / pro / enterprise` ladder.

## 1. The model

| Item | Code | Price / mo | Notes |
|---|---|---|---|
| **Base** (incl. Card Payment) | `base` | **$199** | 1 branch included. Unlimited menu items, unlimited orders. |
| Extra branch | `extra_branch` | **+$99** each | Quantity add-on. Each extra branch gets the full feature set of the main branch. |
| Delivery | `delivery` | **+$49** | Whole-account add-on. |
| AI Suite | `ai_suite` | **+$59** | Digital Signage + AI Voice Assistant. |
| **Pro Start-up** (trial) | `trial` | **$0 / 14 days** | Full features (card payment + delivery + AI suite), **1 branch**, **no credit card required**. |

## 2. Owner decisions (locked 2026-07-25)

1. **Payment rail** — build the full Stripe Billing path (Checkout with multi-line-item + quantity, webhook sync, billing portal) but keep it **dormant** until the owner supplies `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / Price IDs. Until then a **manual activation** rail is the live path: platform admin sets a restaurant's plan / add-ons / branch seats, and merchant selections land in a request queue.
2. **AI Suite** — packaging + entitlement gating **only**. Digital Signage and AI Voice Assistant are not built; the merchant sees locked / "coming soon" surfaces. AI *menu import* stays in Base (it is not part of the AI Suite as the owner defined it).
3. **Legacy plans** — `free`, `starter`, `pro`, `enterprise` are **replaced**. Existing restaurants are migrated onto Base or Trial. No grandfathering.
4. **Trial expiry** — at day 15 with no payment: **merchant back office locks** (read-only, redirected to billing) **and the public storefront goes dark**. No data is deleted; paying restores instantly.
5. **"Card Payment"** — means the storefront accepts cards **into the restaurant's own Stripe account**. The platform takes no cut (consistent with `docs/AUDIT-2026-06-24.md` D2 — not a marketplace).
6. **Extra branch** — **pay first, then create**. Adding a branch beyond the paid seat count is blocked until the seat is purchased (Stripe quantity bump, or manual grant while Stripe is dormant).
7. **Base limits** — no menu-item cap, no orders/month cap. Only the branch-seat count and the add-on entitlements are enforced.
8. **Trial scope** — all add-ons, **1 branch**.

## 3. Recon findings (state before this change)

### 3.1 Data model
- `subscription_plans` — `code, name, monthly_price, limits jsonb, is_active, stripe_price_id`. 4 legacy rows. `limits` = 3 int keys (`max_branches`, `max_items`, `max_orders_per_month`), `-1` = unlimited. **No feature/entitlement column.**
- `subscriptions` — `restaurant_id, tier (enum), status (enum), billing_cycle, current_period_start/end, branch_count, unit_price, payment_method_id, next_billing_at, trial_ends_at, cancel_at_period_end, cancelled_at, plan_code (FK), stripe_customer_id, stripe_subscription_id`. **1 row total and it is junk** (`plan_code` NULL, `unit_price` 1990 THB, period expired). `branch_count` / `trial_ends_at` / `payment_method_id` have **zero writers**. **No unique index on `restaurant_id`.**
- `invoices` — full table, **0 rows, 0 writers**.
- `platform_settings` (singleton) — `penalty/tips/defaults/features` jsonb. `features` holds global kill-switches read by **nothing**.
- Enums: `subscription_status = {trialing,active,past_due,cancelled,expired}`; `subscription_tier = {starter,pro,enterprise}`.

### 3.2 Entitlement engine today
- `check_plan_limit(restaurant, key)` — newest sub by `created_at`, **no status filter**, NULL `plan_code` → `free`. Only `branches`/`items`/`orders_per_month`; **unknown key returns `allowed:true`**. Zero TS call sites.
- `get_my_plan_status(restaurant)` — same but filters `status in ('trialing','active')`, requires owner/manager.
- Triggers `branches_enforce_plan_limit` → `enforce_branch_limit()`, `menu_items_enforce_plan_limit` → `enforce_item_limit()`. Raise `plan_limit_exceeded:<key>:<cur>/<lim>` (P0001), parsed by `packages/database/src/queries/plan.ts:26` `describePlanError()`.
- `apps/admin/src/components/sidebar.tsx:15-37` — cosmetic 3-rung tier ladder, **fails open** on unknown tier. No server-side route checks.

### 3.3 Hard blockers found
1. `subscription_tier` enum only has `starter|pro|enterprise`; `upgrade_plan` executes `p_plan_code::public.subscription_tier` → any new code raises 22P02. The column is read by **zero** DB functions.
2. **Merchant signup is already broken in production**: `create_restaurant_with_branch` inserts `tier='free'` → 22P02 → the *entire* function rolls back (restaurant + branch + staff_member). `coastal-grill` has 0 subscription rows.
3. Per-branch quantity pricing is unrepresentable: checkout hardcodes `line_items[0][quantity]='1'`; webhook reads `items.data[0]` only; `upgrade_plan` hardcodes `branch_count=1`; `create_branch` never bumps it.
4. Add-ons have **zero** representation. `upsert_subscription_plan` overwrites the whole `limits` jsonb, so hand-added keys are clobbered on the next platform-admin save.
5. **No entitlement check exists anywhere.** `featureEnabled|entitlement|hasFeature|plan_features|feature_flag` → zero hits repo-wide.
6. **Digital Signage does not exist** — zero files.
7. **AI Voice was deleted** in commit `89eabd9`; `parse-voice-order` is still deployed (v2, `verify_jwt:false`, publicly callable, Thai-era code) with **no repo source**.
8. Stripe not live: only `stripe-webhook` is deployed; `stripe-create-checkout-session`, `stripe-billing-portal`, `stripe-create-payment-intent` are repo-only. All `stripe_price_id` are NULL and no UI can set one. `CONFIG-CHECKLIST.md:176-185` documents only payment events — subscription events would never fire.
9. **Trials do not exist**: `trial_period_days` / `trial_end` appear nowhere. No cron advances a period or expires a trial (7 active jobs, none billing).
10. **Merchants can self-upgrade via RLS**: policy `subscriptions_owner` is `FOR ALL` to `authenticated`. `anon` + `authenticated` hold full DML grants on `subscription_plans`, `subscriptions`, `invoices`.
11. No merchant self-registration: `apps/admin/src/app/login/_components/login-view.tsx:35` uses `shouldCreateUser:false`; no `/signup`; `apps/web/src/app/page.tsx:35,137` CTAs point at `/onboarding` which lives in **apps/admin** → both 404.

### 3.4 Enforcement choke points

**Card payment**
- `supabase/functions/place-order/index.ts:249-262` payment-matrix gate (staff-placed orders exempt at `:256-260`); `:86` `invalid_payment_method`; `:436` payment row insert.
- `supabase/functions/stripe-create-payment-intent/index.ts` — no plan check, no Connect (`on_behalf_of`/`transfer_data` absent → funds land in the platform account, contradicting D2).
- `apps/admin/src/app/b/[branchId]/branch/_components/payment-methods-card.tsx:34-46,65-68` — merchant write path, ungated.
- `apps/web/.../checkout/_components/checkout-view.tsx:45-62,249-263,268-280,973-978`.
- `apps/pos/src/app/b/[branchId]/_components/pos-view.tsx:544-545`, `apps/admin/src/app/counter/[branchId]/_components/counter-view.tsx:206` — **hardcoded Cash/Card buttons, bypass the matrix**.
- `apps/web/.../orders/[orderNumber]/_components/order-tracking.tsx:404-409` — "Mock confirm (dev only)" does a **direct browser UPDATE** to `payments.status='completed'`, gated only on Stripe being unconfigured.

**Delivery** (note: **there is no `delivery_enabled` key anywhere** — delivery is unconditionally on)
- `supabase/functions/place-order/index.ts:84,91,285-299,437` — the single storefront choke point.
- `supabase/functions/dispatch-driver/index.ts:162-166`, batching gate `:204`.
- `public.quote_delivery` RPC.
- `apps/web/.../_components/menu-view.tsx:316-322` — hardcoded 3-option fulfilment `Segmented`; cart default channel `'delivery'` at `apps/web/src/store/cart.ts:60`.
- `apps/admin/.../branch/_components/delivery-settings-card.tsx` (mounted at `branch-settings.tsx:175`).
- Driver: `packages/database/src/queries/driver.ts:213,225,237,305`.

**AI**
- `supabase/functions/import-menu/index.ts` (wired to `apps/admin/.../menu/import/_components/menu-import-view.tsx:71`) — stays in Base.
- `ai-menu-optimize`, `ai-review-response`, `ai-chat-support` — deployed, no callers, `ai-chat-support` has **no auth at all**.
- Only gate today is `if (!ANTHROPIC_API_KEY) 503` — an env check, not a tenant check.

**Branch count**
- Trigger `enforce_branch_limit()` (authoritative), `public.create_branch(...)` (does not bump `branch_count`), `create_restaurant_with_branch(...)` (broken).
- No UPDATE coverage — moving a branch between restaurants bypasses the trigger.

**Global "is this tenant paid up?"**
- `packages/database/src/queries/tenant.ts:30-52` `resolveTenantBySlug()` — every storefront render passes through it (both `/r/` and custom domains, via `apps/web/src/app/r/[restaurant]/[branch]/layout.tsx:13` → `apps/web/src/lib/tenant.ts:13-20`). Highest leverage.
- `apps/web/src/middleware.ts:32`.
- `apps/admin/src/app/b/[branchId]/layout.tsx:50-58` — already calls `getPlanStatus()`; note `plan.ts:22` swallows errors to `null`.

### 3.5 Risks to respect
- `check_plan_limit` (no status filter) vs `get_my_plan_status` (status-filtered) **disagree** — a cancelled Enterprise keeps 50-branch enforcement forever.
- `upgrade_plan` is INSERT-only with no unique index → rows stack; webhook upserts on a *different* key (`stripe_subscription_id`). Two writers, two conflict keys, no reconciliation.
- Webhook reads `items.data[0]` only and coerces unknown codes to `'starter'` — breaks with multi-line subscriptions.
- Webhook reads `inv.subscription` top-level; on 2025-era API versions it is `invoice.parent.subscription_details.subscription` → renewals silently no-op. No `Stripe-Version` header anywhere.
- Webhook has no idempotency (`event.id` parsed, never stored) and no HMAC timestamp tolerance.
- Orphaned deployed functions with no repo source: `parse-voice-order`, `create-payment-source`, `omise-webhook` (all `verify_jwt:false`).
- Docs that become false: `docs/TEST-CASES.md:47,514-518,728,836,895`, `docs/SMOKE-TEST.md:174-177`, `implementation.md` §16 (THB spec), `apps/web/src/app/page.tsx:122-140`.
- 6 hand-written mirrors of the plan shape that will drift: `packages/database/src/queries/plan.ts:3-15`, `plan-view.tsx:9-21`, `plans-manager.tsx:10-26`, `apps/admin/src/app/platform/reports/page.tsx:7-21`, `apps/admin/src/app/b/[branchId]/dashboard/page.tsx:25-29`, `stripe-webhook/index.ts:146-160`.

## 4. Out of scope (explicitly deferred)

- Building Digital Signage and AI Voice Assistant themselves (decision 2).
- Per-restaurant Stripe Connect / restaurant-owned card processing keys. `stripe-create-payment-intent` still uses platform keys — pre-existing contradiction with D2, tracked separately.
- Annual billing (`subscriptions.billing_cycle` already allows `yearly`; nothing uses it).
- Deleting the orphaned `parse-voice-order` / `create-payment-source` / `omise-webhook` deployments.
